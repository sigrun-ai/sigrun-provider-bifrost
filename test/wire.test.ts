import { describe, expect, it, vi } from "vitest";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Message,
	Model,
	ProviderStreams,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { chainWireName, withDisplayId, withWireNames } from "../src/wire.js";

const context = { messages: [] } as unknown as TranscriptContext;

function testModel(id: string): Model<"openai-completions"> {
	return {
		id,
		name: "acme-flash",
		api: "openai-completions",
		provider: "bifrost",
		baseUrl: "https://gw.example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

function assistantMessage(model: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hello" }],
		api: "openai-completions",
		provider: "bifrost",
		model,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** The message a stream event carries, whichever field the variant uses. */
function messageOf(event: AssistantMessageEvent): AssistantMessage {
	switch (event.type) {
		case "done":
			return event.message;
		case "error":
			return event.error;
		default:
			return event.partial;
	}
}

interface FakeOutcome {
	/** Terminate with an error event of this reason instead of `done`. */
	failWith?: "error" | "aborted";
	/** Duration the INNER stream stamps on its terminal message. */
	durationMs?: number;
	/** Settle through `end(result)` and emit no events at all. */
	endWithResult?: boolean;
}

/**
 * A fake ProviderStreams whose API implementations answer with the model id
 * they were handed — the gateway's bare wire name, exactly as pi-ai's own
 * implementations do (the reply echoes the request's model).
 *
 * Every event carries its OWN message object: the real api implementations
 * share one live `partial`, which would let a wrapper that rewrites only the
 * first event pass — distinct objects pin the "every event" contract.
 */
function fakeStreams(outcome: FakeOutcome = {}) {
	const requestedModelIds: string[] = [];
	const contexts: TranscriptContext[] = [];
	const builtStreams: AssistantMessageEventStream[] = [];
	const build = (model: Model<Api>, history: TranscriptContext): AssistantMessageEventStream => {
		requestedModelIds.push(model.id);
		contexts.push(history);
		const stream = createAssistantMessageEventStream();
		builtStreams.push(stream);
		const reply = (text: string): AssistantMessage => ({
			...assistantMessage(model.id),
			...(text === "" ? { content: [] } : { content: [{ type: "text", text }] }),
		});
		if (outcome.endWithResult === true) {
			stream.end(reply("hello"));
			return stream;
		}
		stream.push({ type: "start", partial: reply("") });
		stream.push({ type: "text_start", contentIndex: 0, partial: reply("") });
		stream.push({ type: "text_delta", contentIndex: 0, delta: "hello", partial: reply("hello") });
		stream.push({ type: "text_end", contentIndex: 0, content: "hello", partial: reply("hello") });
		if (outcome.failWith !== undefined) {
			const failure: AssistantMessage = {
				...assistantMessage(model.id),
				stopReason: outcome.failWith,
				errorMessage: "gateway refused",
			};
			stream.push({ type: "error", reason: outcome.failWith, error: failure });
		} else {
			stream.push({
				type: "done",
				reason: "stop",
				message: { ...reply("hello"), durationMs: outcome.durationMs },
			});
		}
		stream.end();
		return stream;
	};
	const streams: ProviderStreams = {
		stream: (model, history) => build(model, history),
		streamSimple: (model, history) => build(model, history),
		fetchDeferred: (model) => build(model, context),
		cancelDeferred: async () => undefined,
	};
	return { streams, requestedModelIds, contexts, builtStreams };
}

/** A stream that already answered under `model` — what a real api returns. */
function replyStream(model: string): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const message = assistantMessage(model);
	stream.push({ type: "start", partial: message });
	stream.push({ type: "done", reason: "stop", message });
	stream.end();
	return stream;
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("chainWireName", () => {
	it("strips the display prefix even before a catalog refresh fills the map", () => {
		expect(chainWireName("chain/acme-flash", new Map())).toBe("acme-flash");
	});

	it("prefers the discovered wire name", () => {
		expect(chainWireName("chain/x", new Map([["chain/x", "x-wire"]]))).toBe("x-wire");
	});

	it("leaves member ids unchanged", () => {
		expect(chainWireName("hyper/acme-flash", new Map())).toBe("hyper/acme-flash");
	});
});

describe("withWireNames", () => {
	it("rewrites a copy of the model for streamSimple without changing other fields or the input", async () => {
		// A real stream (rather than vi.fn()'s undefined): the wrapper always
		// forwards a live stream, so a mock must answer with one.
		const inner = vi.fn((model: Model<Api>) => replyStream(model.id));
		const wrapped = withWireNames(
			{ stream: (model) => replyStream(model.id), streamSimple: inner },
			new Map(),
		);
		const model = testModel("chain/acme-flash");
		const before = { ...model };
		const stream = wrapped.streamSimple(model, context);
		expect(inner).toHaveBeenCalledOnce();
		const received = inner.mock.calls[0]![0] as Model<"openai-completions">;
		expect(received.id).toBe("acme-flash");
		expect({ ...received, id: model.id }).toEqual(model);
		expect(received).not.toBe(model);
		expect(model).toEqual(before);
		// The mock's real reply crosses as a normal completion — not as the
		// synthesized failure a wrapper produces for an unusable stream.
		const result = await stream.result();
		expect(result.model).toBe("chain/acme-flash");
		expect(result.stopReason).toBe("stop");
	});

	it("does not invent deferred methods, but wraps them when present", async () => {
		const plain = withWireNames(
			{ stream: (model) => replyStream(model.id), streamSimple: (model) => replyStream(model.id) },
			new Map(),
		);
		expect("fetchDeferred" in plain).toBe(false);
		expect("cancelDeferred" in plain).toBe(false);

		const fetchDeferred = vi.fn((model: Model<Api>) => replyStream(model.id));
		const cancelDeferred = vi.fn().mockResolvedValue(undefined);
		const streams: ProviderStreams = {
			stream: (model) => replyStream(model.id),
			streamSimple: (model) => replyStream(model.id),
			fetchDeferred,
			cancelDeferred,
		};
		const deferred = withWireNames(streams, new Map([["chain/x", "x-wire"]]));
		const handle = { provider: "bifrost", modelId: "chain/x", api: "openai-completions", id: "response-1" };
		const stream = deferred.fetchDeferred!(testModel("chain/x"), handle);
		await deferred.cancelDeferred!(testModel("chain/x"), handle);
		expect(fetchDeferred.mock.calls[0]![0].id).toBe("x-wire");
		expect(cancelDeferred.mock.calls[0]![0].id).toBe("x-wire");
		const result = await stream.result();
		expect(result.model).toBe("chain/x");
		expect(result.stopReason).toBe("stop");
	});
});

describe("withWireNames replies", () => {
	const known = new Map([["chain/acme-flash", "acme-flash"]]);

	it("stream events carry the display id", async () => {
		const fake = fakeStreams();
		const wrapped = withWireNames(fake.streams, known);
		const stream = wrapped.stream(testModel("chain/acme-flash"), context);
		const events = await collect(stream);

		expect(events.length).toBeGreaterThan(1);
		for (const event of events) {
			expect(messageOf(event).model).toBe("chain/acme-flash");
		}
		// Only the name changes: the events themselves cross unchanged.
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		]);
		const delta = events[2];
		if (delta?.type !== "text_delta") throw new Error("expected a text_delta event");
		expect(delta.delta).toBe("hello");
		expect((await stream.result()).model).toBe("chain/acme-flash");
	});

	it("streamSimple and fetchDeferred are restored too", async () => {
		const fake = fakeStreams();
		const wrapped = withWireNames(fake.streams, known);
		const model = testModel("chain/acme-flash");

		const simple = wrapped.streamSimple(model, context);
		expect((await simple.result()).model).toBe("chain/acme-flash");

		const handle = {
			provider: "bifrost",
			modelId: "chain/acme-flash",
			api: "openai-completions" as const,
			id: "response-1",
		};
		const deferred = wrapped.fetchDeferred!(model, handle);
		expect((await deferred.result()).model).toBe("chain/acme-flash");
		// The gateway still saw the bare wire name on both calls.
		expect(fake.requestedModelIds).toEqual(["acme-flash", "acme-flash"]);
	});

	it("aborted or errored stream keeps the display id", async () => {
		for (const reason of ["aborted", "error"] as const) {
			const fake = fakeStreams({ failWith: reason });
			const wrapped = withWireNames(fake.streams, known);
			const stream = wrapped.stream(testModel("chain/acme-flash"), context);
			const events = await collect(stream);

			const terminal = events.at(-1);
			expect(terminal?.type).toBe("error");
			if (terminal?.type === "error") {
				expect(terminal.reason).toBe(reason);
				expect(terminal.error.model).toBe("chain/acme-flash");
			}
			const result = await stream.result();
			expect(result.stopReason).toBe(reason);
			expect(result.model).toBe("chain/acme-flash");
			// Every partial on the way there carries the display id too.
			for (const event of events) {
				expect(messageOf(event).model).toBe("chain/acme-flash");
			}
		}
	});

	it("non-chain ids pass through unchanged", async () => {
		const fake = fakeStreams();
		const wrapped = withWireNames(fake.streams, new Map());
		const stream = wrapped.stream(testModel("acme/model-1"), context);
		const events = await collect(stream);

		// No display id to restore: the reply is the provider's own stream.
		expect(stream).toBe(fake.builtStreams[0]);
		expect(events.length).toBeGreaterThan(1);
		for (const event of events) {
			expect(messageOf(event).model).toBe("acme/model-1");
		}
		expect((await stream.result()).model).toBe("acme/model-1");
		expect(fake.requestedModelIds).toEqual(["acme/model-1"]);
	});

	it("the terminal event is forwarded", async () => {
		const fake = fakeStreams({ durationMs: 42 });
		const wrapped = withWireNames(fake.streams, known);
		const stream = wrapped.stream(testModel("chain/acme-flash"), context);
		const events = await collect(stream);

		expect(events.at(-1)?.type).toBe("done");
		const result = await stream.result();
		expect(result.durationMs).toBe(42);
		expect(result.model).toBe("chain/acme-flash");
	});
});

describe("withDisplayId", () => {
	it("only rewrites a message that still carries the wire name", async () => {
		const inner = createAssistantMessageEventStream();
		const foreign = assistantMessage("other/flash");
		const wire = assistantMessage("acme-flash");
		inner.push({ type: "start", partial: foreign });
		inner.push({ type: "done", reason: "stop", message: wire });
		inner.end();

		const restored = withDisplayId(inner, "chain/acme-flash", "acme-flash");
		const events = await collect(restored);
		expect(messageOf(events[0]!).model).toBe("other/flash");
		expect(messageOf(events[1]!).model).toBe("chain/acme-flash");
		expect((await restored.result()).model).toBe("chain/acme-flash");
	});
});

describe("withWireNames replay", () => {
	const known = new Map([["chain/acme-flash", "acme-flash"]]);

	/** The `model` of each assistant message the inner api implementation saw. */
	function replayedModels(history: TranscriptContext | undefined): string[] {
		return (history?.messages ?? []).flatMap((message) =>
			message.role === "assistant" ? [message.model] : [],
		);
	}

	/** A transcript as the harness hands it over (the brand is compile-time only). */
	function transcript(messages: Message[]): TranscriptContext {
		return { messages } as unknown as TranscriptContext;
	}

	function userTurn(text: string, timestamp: number) {
		return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp };
	}

	it("rewrites this model's own replayed turns back to the wire name", async () => {
		const fake = fakeStreams();
		const wrapped = withWireNames(fake.streams, known);
		const model = testModel("chain/acme-flash");
		const stored = {
			...assistantMessage("chain/acme-flash"),
			content: [{ type: "thinking" as const, thinking: "pondering", thinkingSignature: "sig-abc" }],
		};

		const result = await wrapped
			.stream(model, transcript([userTurn("hi", 1), stored, userTurn("again", 3)]))
			.result();

		// The reply still carries the display id …
		expect(result.model).toBe("chain/acme-flash");
		// … while the replayed history the inner api sees names the wire model,
		// so pi-ai's same-model replay keeps thinking blocks and signatures.
		expect(replayedModels(fake.contexts[0])).toEqual(["acme-flash"]);
		// Only the name changes: the replayed turn is otherwise the stored one.
		const replayed = fake.contexts[0]?.messages[1];
		expect({ ...replayed, model: stored.model }).toEqual(stored);
	});

	it("rewrites the history on streamSimple too", async () => {
		const fake = fakeStreams();
		const wrapped = withWireNames(fake.streams, known);
		const model = testModel("chain/acme-flash");
		const prior = assistantMessage("chain/acme-flash");

		wrapped.streamSimple(model, transcript([userTurn("hi", 1), prior]));
		expect(replayedModels(fake.contexts[0])).toEqual(["acme-flash"]);
		// The caller's own transcript is untouched.
		expect(prior.model).toBe("chain/acme-flash");
	});

	it("leaves another model's or another provider's history alone", async () => {
		const fake = fakeStreams();
		const wrapped = withWireNames(fake.streams, known);
		const otherModel = assistantMessage("chain/acme-other");
		const otherProvider = { ...assistantMessage("chain/acme-flash"), provider: "acme" as const };
		const foreign = assistantMessage("acme/model-1");

		wrapped.stream(
			testModel("chain/acme-flash"),
			transcript([userTurn("hi", 1), otherModel, otherProvider, foreign]),
		);
		expect(replayedModels(fake.contexts[0])).toEqual([
			"chain/acme-other",
			"chain/acme-flash",
			"acme/model-1",
		]);
	});

	it("leaves history untouched when the id needs no wire name", async () => {
		const fake = fakeStreams();
		const wrapped = withWireNames(fake.streams, new Map());
		const history = transcript([userTurn("hi", 1), assistantMessage("acme/model-1")]);

		wrapped.stream(testModel("acme/model-1"), history);
		// Same context object: no display id to fold back.
		expect(fake.contexts[0]).toBe(history);
	});
});

describe("withDisplayId terminal handling", () => {
	it("settles result() when the inner stream ends without events", async () => {
		const inner = createAssistantMessageEventStream();
		const message = assistantMessage("acme-flash");
		inner.end(message);

		const restored = withDisplayId(inner, "chain/acme-flash", "acme-flash");
		const events = await collect(restored);
		expect(events).toEqual([]);
		const result = await restored.result();
		expect(result.model).toBe("chain/acme-flash");
	});

	it("terminates with an error event when the inner stream throws", async () => {
		// A provider stream whose iterator rejects instead of terminating with an
		// event. Every consumer awaiting a settlement must still be released.
		const broken = {
			[Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("gateway stream broke")) }),
		} as unknown as AssistantMessageEventStream;

		const restored = withDisplayId(broken, "chain/acme-flash", "acme-flash");
		const events = await collect(restored);

		expect(events.map((event) => event.type)).toEqual(["error"]);
		const terminal = events[0];
		if (terminal?.type !== "error") throw new Error("expected an error event");
		expect(terminal.reason).toBe("error");
		expect(terminal.error.model).toBe("chain/acme-flash");
		expect(terminal.error.provider).toBe("bifrost");
		expect(terminal.error.stopReason).toBe("error");
		expect(terminal.error.errorMessage).toContain("gateway stream broke");

		const result = await restored.result();
		expect(result.model).toBe("chain/acme-flash");
		expect(result.stopReason).toBe("error");
	});
});
