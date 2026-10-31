import { CHAIN_ID_PREFIX } from "./catalog.js";
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
/** Keep display ids at the provider boundary and bare names on the gateway wire. */
export function withWireNames(streams, known) {
    const wrapped = {
        stream: (model, context, options) => streams.stream(wireModel(model, known), context, options),
        streamSimple: (model, context, options) => streams.streamSimple(wireModel(model, known), context, options),
    };
    if (streams.fetchDeferred !== undefined) {
        const fetchDeferred = streams.fetchDeferred;
        wrapped.fetchDeferred = (model, handle, options) => fetchDeferred.call(streams, wireModel(model, known), handle, options);
    }
    if (streams.cancelDeferred !== undefined) {
        const cancelDeferred = streams.cancelDeferred;
        wrapped.cancelDeferred = (model, handle, options) => cancelDeferred.call(streams, wireModel(model, known), handle, options);
    }
    return wrapped;
}
