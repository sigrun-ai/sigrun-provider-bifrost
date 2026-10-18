/**
 * Plugin configuration (ported from pi-bifrost-gateway 0.3.0 @ 5d15a28,
 * `src/config.ts`): the SAME key surface, but sourced from the plugin's
 * SCOPED SETTINGS (`settings/sigrun-bifrost.json` in the sigrun config
 * dir, read ONCE at factory time — restart-required) instead of pi's
 * config file. Parsing is pure — `parseBifrostSettings(raw, issues)`
 * takes the settings object the store returns; wrong-typed values and
 * unknown keys collect issues the factory logs, never fatal (identical
 * posture to the pi port).
 *
 * DEFAULTS ARE REVERSED FROM PI (user ruling, provider-plugins spec):
 * `publishChains` defaults FALSE — the conservative stock-gateway shape —
 * but `publishUpstream` defaults TRUE, because sigrun (unlike pi) has no
 * interactive /login and a member-only install is the no-management-plane
 * deployment shape. pi 0.3.0 ships the same publishChains default and the
 * same publishUpstream default; the "reversal" is vs pi 0.2.x's
 * publishChains:true.
 */
/**
 * Native-protocol surface selection (client-side wire choice per model
 * family). Both toggles default false — every model publishes as chat
 * completions, the only wire every Bifrost serves. When a toggle is on,
 * models matching the BUILT-IN family heuristic publish that native wire;
 * when the matching exact-name list is ALSO set, the list REPLACES the
 * built-in heuristic for that surface (list membership is the only path to
 * the native wire).
 */
export interface NativeProtocols {
    /** gpt-family models publish openai-responses (gateway must serve /v1/responses). */
    responses: boolean;
    /** claude-family models publish anthropic-messages (gateway must serve the /anthropic integration route). */
    messages: boolean;
    /** Exact bare model names ("gpt-6-luna") for the responses surface; replaces the built-in gpt heuristic. */
    responsesModels?: string[];
    /** Exact bare model names ("claude-sonnet-5-5") for the messages surface; replaces the built-in claude heuristic. */
    messagesModels?: string[];
}
export interface BifrostSettings {
    /** Emit chain models (bifrost/<chain>) from the VK's routing rules. */
    publishChains: boolean;
    /** Emit all upstream models from /v1/models as direct-selectable entries. */
    publishUpstream: boolean;
    /** Explicit gateway /v1 base URL; when set it wins over the env fallback. */
    baseUrl?: string;
    /**
     * Per-member thinking-level overrides, keyed by upstream member id
     * ("provider/model"). Each list is the member's real supported ladder;
     * when present it REPLACES the full-ladder default on direct-selectable
     * member models of that id.
     */
    thinkingOverrides?: Record<string, string[]>;
    /**
     * Bearer for the management plane (/api/governance/virtual-keys,
     * /api/routing/rules). Falls back to the inference credential (the VK)
     * when unset — the right shape for dashboard-auth-disabled deployments
     * where the VK itself is accepted on /api/*. Set it on deployments whose
     * management plane expects a different credential than inference.
     */
    managementApiKey?: string;
    /** Native-protocol surface gates (both default false — chat completions everywhere). */
    nativeProtocols?: NativeProtocols;
}
/** Ambient env key for the gateway URL — resolved at credential-resolution time
 * through the env seam (see `src/index.ts`); the settings `baseUrl` outranks it. */
export declare const BIFROST_BASE_URL_ENV = "BIFROST_BASE_URL";
declare const THINKING_LEVELS: readonly ["minimal", "low", "medium", "high", "xhigh", "max"];
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];
/**
 * Parse the plugin's scoped-settings object. Missing settings = defaults;
 * unknown keys and wrong-typed values collect issues the caller logs but
 * that are never fatal.
 *
 * Defaults: publishChains FALSE, publishUpstream TRUE (see the module
 * comment — pi 0.3.0 parity on both).
 */
export declare function parseBifrostSettings(raw: unknown, issues: string[]): BifrostSettings;
export {};
