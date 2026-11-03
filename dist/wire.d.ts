import type { Api, AssistantMessageEventStream, Model, ProviderStreams } from "@earendil-works/pi-ai";
/** Resolve the gateway's model name from a sigrun-side display id. */
export declare function chainWireName(id: string, known: ReadonlyMap<string, string>): string;
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
export declare function withDisplayId(stream: AssistantMessageEventStream, displayId: string, wireName: string, model?: Model<Api>): AssistantMessageEventStream;
/** Keep display ids at the provider boundary and bare names on the gateway wire. */
export declare function withWireNames(streams: ProviderStreams, known: ReadonlyMap<string, string>): ProviderStreams;
