import { describe, expect, it, vi } from "vitest";
import type { Model, ProviderStreams, TranscriptContext } from "@earendil-works/pi-ai";
import { chainWireName, withWireNames } from "../src/wire.js";

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
	it("rewrites a copy of the model for streamSimple without changing other fields or the input", () => {
		const inner = vi.fn();
		const wrapped = withWireNames(
			{ stream: vi.fn(), streamSimple: inner },
			new Map(),
		);
		const model = testModel("chain/acme-flash");
		const before = { ...model };
		wrapped.streamSimple(model, context);
		expect(inner).toHaveBeenCalledOnce();
		const received = inner.mock.calls[0]![0] as Model<"openai-completions">;
		expect(received.id).toBe("acme-flash");
		expect({ ...received, id: model.id }).toEqual(model);
		expect(received).not.toBe(model);
		expect(model).toEqual(before);
	});

	it("does not invent deferred methods, but wraps them when present", async () => {
		const plain = withWireNames(
			{ stream: vi.fn(), streamSimple: vi.fn() },
			new Map(),
		);
		expect("fetchDeferred" in plain).toBe(false);
		expect("cancelDeferred" in plain).toBe(false);

		const fetchDeferred = vi.fn();
		const cancelDeferred = vi.fn().mockResolvedValue(undefined);
		const streams: ProviderStreams = {
			stream: vi.fn(),
			streamSimple: vi.fn(),
			fetchDeferred,
			cancelDeferred,
		};
		const deferred = withWireNames(streams, new Map([["chain/x", "x-wire"]]));
		const handle = { provider: "bifrost", modelId: "chain/x", api: "openai-completions", id: "response-1" };
		deferred.fetchDeferred!(testModel("chain/x"), handle);
		await deferred.cancelDeferred!(testModel("chain/x"), handle);
		expect(fetchDeferred.mock.calls[0]![0].id).toBe("x-wire");
		expect(cancelDeferred.mock.calls[0]![0].id).toBe("x-wire");
	});
});
