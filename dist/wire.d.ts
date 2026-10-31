import type { ProviderStreams } from "@earendil-works/pi-ai";
/** Resolve the gateway's model name from a sigrun-side display id. */
export declare function chainWireName(id: string, known: ReadonlyMap<string, string>): string;
/** Keep display ids at the provider boundary and bare names on the gateway wire. */
export declare function withWireNames(streams: ProviderStreams, known: ReadonlyMap<string, string>): ProviderStreams;
