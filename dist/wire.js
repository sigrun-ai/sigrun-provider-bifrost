import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { CHAIN_ID_PREFIX, PROVIDER_ID } from "./catalog.js";
/** Resolve the gateway's model name from a sigrun-side display id. */
export function chainWireName(id, known) {
    const discovered = known.get(id);
    if (discovered !== undefined)
        return discovered;
    return id.startsWith(CHAIN_ID_PREFIX) ? id.slice(CHAIN_ID_PREFIX.length) : id;
}
function wireModel(model, known) {
    return { ...model, id: chainWireName(model.id, known) };
}
/**
 * Fold this model's display id back to the wire name on outgoing history.
 *
 * pi-ai replays an assistant turn as "the same model" only when its provider,
 * api and model all match the request (`transformMessages`), and that gate is
 * what keeps thinking blocks with their signatures, tool-call thought
 * signatures, and tool-call ids. The inner implementation replays against the
 * WIRE model, so a persisted `chain/` reply would otherwise read as a foreign
 * model's turn and lose every one of those. Only this provider's own turns for
 * this exact model are renamed: another model's (or another provider's)
 * history keeps its cross-model semantics.
 */
function replayContext(context, model, wireName) {
    let changed = false;
    const messages = context.messages.map((message) => {
        if (message.role !== "assistant")
            return message;
        if (message.provider !== model.provider || message.model !== model.id)
            return message;
        changed = true;
        return { ...message, model: wireName };
    });
    // Untouched histories cross by reference, so a member request costs nothing.
    return changed ? { ...context, messages } : context;
}
/** The message an event carries, whichever field its variant uses. */
function eventMessage(event) {
    switch (event.type) {
        case "done":
            return event.message;
        case "error":
            return event.error;
        default:
            return event.partial;
    }
}
/**
 * The message a stream that broke outright reports.
 *
 * Mirrors pi-ai's own setup-error message (`api/lazy.js`): an empty assistant
 * reply whose `stopReason` is `"error"` and whose text names the cause. pi-ai
 * never replays an errored assistant turn, so this message only carries the
 * failure to the consumer — but it MUST exist, because `EventStream.end()`
 * without a result leaves `result()` unresolved forever.
 */
function failureMessage(cause, displayId, model) {
    return {
        role: "assistant",
        content: [],
        api: model?.api ?? "unknown",
        provider: model?.provider ?? PROVIDER_ID,
        model: displayId,
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: cause instanceof Error ? cause.message : String(cause),
        timestamp: Date.now(),
    };
}
/**
 * Restore the sigrun-side display id on a reply.
 *
 * The gateway names its reply after the model it was asked for — the bare
 * wire name (`acme-flash`) — and pi-ai copies that name onto the reply's
 * messages, so a persisted message from a chain model would forget where it
 * came from. Every event is forwarded, the terminal `done`/`error` included,
 * because pi-ai derives `result()` (and `durationMs`) from that event.
 *
 * `model` is the request's model; it is optional only because the display id
 * and wire name already describe the reply. Supply it so a stream that breaks
 * outright can report an accurate `api`/`provider`.
 */
export function withDisplayId(stream, displayId, wireName, model) {
    const restored = createAssistantMessageEventStream();
    void (async () => {
        try {
            let result;
            for await (const event of stream) {
                const message = eventMessage(event);
                if (message.model === wireName)
                    message.model = displayId;
                // pi-ai resolves result() from the terminal event, so forward it
                // untouched (the id is already restored) and end() after it.
                if (event.type === "done")
                    result = event.message;
                else if (event.type === "error")
                    result = event.error;
                restored.push(event);
            }
            // A stream can settle through end(result) without any event; pi-ai's
            // own forwarder reads that result so result() never hangs.
            if (result === undefined)
                result = await stream.result();
            if (result !== undefined && result.model === wireName)
                result.model = displayId;
            restored.end(result);
        }
        catch (cause) {
            // pi-ai streams terminate with an error event and their iterator does
            // not throw, so this is an upstream contract violation. Report it the
            // way pi-ai reports a failed setup — a terminal error event — and
            // settle with that message: ending without a result would leave every
            // `await stream.result()` waiting forever, and the cause would be lost.
            const failure = failureMessage(cause, displayId, model);
            restored.push({ type: "error", reason: "error", error: failure });
            restored.end(failure);
        }
    })();
    return restored;
}
/** Keep display ids at the provider boundary and bare names on the gateway wire. */
export function withWireNames(streams, known) {
    /** Replies are named after the request; a stripped id must come back whole. */
    const restoreReply = (model, wireName, stream) => (wireName === model.id ? stream : withDisplayId(stream, model.id, wireName, model));
    /**
     * Cross the boundary once: the request names the wire model, the history
     * replays under that same name, and the reply keeps the display id.
     */
    const delegate = (model, context, call) => {
        const wireName = chainWireName(model.id, known);
        const history = wireName === model.id ? context : replayContext(context, model, wireName);
        return restoreReply(model, wireName, call(wireModel(model, known), history));
    };
    const wrapped = {
        stream: (model, context, options) => delegate(model, context, (wire, history) => streams.stream(wire, history, options)),
        streamSimple: (model, context, options) => delegate(model, context, (wire, history) => streams.streamSimple(wire, history, options)),
    };
    if (streams.fetchDeferred !== undefined) {
        const fetchDeferred = streams.fetchDeferred;
        // A deferred fetch replays no history: only the request and reply cross.
        wrapped.fetchDeferred = (model, handle, options) => {
            const wireName = chainWireName(model.id, known);
            return restoreReply(model, wireName, fetchDeferred.call(streams, wireModel(model, known), handle, options));
        };
    }
    if (streams.cancelDeferred !== undefined) {
        const cancelDeferred = streams.cancelDeferred;
        wrapped.cancelDeferred = (model, handle, options) => cancelDeferred.call(streams, wireModel(model, known), handle, options);
    }
    return wrapped;
}
