/**
 * Catalog composition (ported from pi-bifrost-gateway 0.3.0 @ 5d15a28,
 * `src/catalog.ts` + the constants of its `src/bifrost.ts`): wire schemas
 * and fetching, chain decoding from routing-rule CELs, native-family
 * surface selection, TEXT_ONLY denylist scoping, and the pure model
 * builders. Every published model is stamped `provider: "bifrost"` —
 * pi-ai's restore path drops stored models whose `provider` differs from
 * the registered id, so an unstamped catalog silently vanishes on cold
 * boot (restore-filter spike, Review Focus #3).
 */
import type { Model } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { type FetchJsonOptions } from "./http.js";
import type { NativeProtocols } from "./config.js";
/** The provider id models are registered (and stamped) under. */
export declare const PROVIDER_ID = "bifrost";
export declare const PROVIDER_DISPLAY_NAME = "Bifrost Gateway";
/** Different relative to the configured /v1 base URL. */
export declare const INFERENCE_PATH_MODELS = "models";
/** Management API paths (live-verified on Bifrost v2.2.x, 2026-10-08). */
export declare const MANAGEMENT_PATH_VIRTUAL_KEYS = "/api/governance/virtual-keys";
export declare const MANAGEMENT_PATH_ROUTING_RULES = "/api/routing/rules";
/**
 * Neutral createProvider-shape baseUrl used before a URL exists from any
 * source. NEVER requested: every published model carries its own
 * discovery-time baseUrl, and discovery refuses to run without a real URL
 * (unconfigured throws). An install in this state publishes zero models.
 */
export declare const UNRESOLVED_BASE_URL = "http://localhost:8080/v1";
/** Model apis this plugin publishes, keyed to pi-ai's registered implementations. */
export type SurfaceApi = "openai-completions" | "openai-responses" | "anthropic-messages";
export type GatewayModel = Model<"openai-completions"> | Model<"openai-responses"> | Model<"anthropic-messages">;
/**
 * Which native wire a model NAME speaks (pi-inferhub nativeFamily, ported).
 * BUILT-IN heuristic — the user-facing gates live in settings
 * (nativeProtocols.responses/messages toggles, plus exact-name lists that
 * replace this heuristic when set). Family of the model NAME (last path
 * segment), never the serving prefix: the live catalog has `kiro/` serving
 * both claude-* and gpt-* rows. `gpt-oss` is an open-weight model, not an
 * [OI] native one, so it stays other; `o\d` catches o3/o4-style rows,
 * `codex` the codex family.
 */
export type NativeFamily = "anthropic" | "openai" | "other";
export declare function nativeFamily(id: string): NativeFamily;
/**
 * Client wire + base URL for one model id, per settings:
 * - nativeProtocols.messages on + (name in messagesModels list, or built-in
 *   claude heuristic when no list) → anthropic-messages at the gateway's
 *   /anthropic integration prefix (pi-ai's Anthropic SDK appends /v1/messages
 *   itself; x-api-key VK auth verified live).
 * - nativeProtocols.responses on + (responsesModels list, or built-in gpt
 *   heuristic) → openai-responses on the /v1 base.
 * - otherwise openai-completions — the only wire every Bifrost serves, and
 *   the gateway translates at the boundary anyway.
 */
export declare function surfaceFor(id: string, baseUrl: string, native?: NativeProtocols): {
    api: SurfaceApi;
    baseUrl: string;
};
export declare const CatalogModelSchema: Type.TObject<{
    id: Type.TString;
    owned_by: Type.TOptional<Type.TString>;
    context_length: Type.TOptional<Type.TNumber>;
    max_output_limit: Type.TOptional<Type.TNumber>;
    pricing: Type.TOptional<Type.TObject<{
        prompt: Type.TString;
        completion: Type.TString;
        input_cache_read: Type.TOptional<Type.TString>;
        input_cache_write: Type.TOptional<Type.TString>;
    }>>;
}>;
export declare const ModelsEnvelopeSchema: Type.TObject<{
    data: Type.TArray<Type.TObject<{
        id: Type.TString;
        owned_by: Type.TOptional<Type.TString>;
        context_length: Type.TOptional<Type.TNumber>;
        max_output_limit: Type.TOptional<Type.TNumber>;
        pricing: Type.TOptional<Type.TObject<{
            prompt: Type.TString;
            completion: Type.TString;
            input_cache_read: Type.TOptional<Type.TString>;
            input_cache_write: Type.TOptional<Type.TString>;
        }>>;
    }>>;
}>;
export declare const RoutingTargetSchema: Type.TObject<{
    provider: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    model: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    weight: Type.TNumber;
}>;
export declare const RoutingRuleSchema: Type.TObject<{
    id: Type.TString;
    name: Type.TString;
    enabled: Type.TOptional<Type.TBoolean>;
    cel_expression: Type.TString;
    targets: Type.TArray<Type.TObject<{
        provider: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
        model: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
        weight: Type.TNumber;
    }>>;
    fallbacks: Type.TOptional<Type.TArray<Type.TString>>;
    scope: Type.TString;
    scope_id: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    priority: Type.TOptional<Type.TNumber>;
}>;
export declare const RulesEnvelopeSchema: Type.TObject<{
    rules: Type.TArray<Type.TObject<{
        id: Type.TString;
        name: Type.TString;
        enabled: Type.TOptional<Type.TBoolean>;
        cel_expression: Type.TString;
        targets: Type.TArray<Type.TObject<{
            provider: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
            model: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
            weight: Type.TNumber;
        }>>;
        fallbacks: Type.TOptional<Type.TArray<Type.TString>>;
        scope: Type.TString;
        scope_id: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
        priority: Type.TOptional<Type.TNumber>;
    }>>;
}>;
export declare const VirtualKeySchema: Type.TObject<{
    id: Type.TString;
    name: Type.TOptional<Type.TString>;
    value: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
}>;
/**
 * Wire envelope as observed 2026-10-08: GET /api/governance/virtual-keys
 * returns `{virtual_keys: [...], count, ...}` with the full VK rows
 * INCLUDING their secret values. Unknown extra fields pass validation.
 */
export declare const VirtualKeysEnvelopeSchema: Type.TObject<{
    virtual_keys: Type.TArray<Type.TObject<{
        id: Type.TString;
        name: Type.TOptional<Type.TString>;
        value: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    }>>;
}>;
export type CatalogModel = {
    id: string;
    owned_by?: string;
    context_length?: number;
    max_output_limit?: number;
    pricing?: {
        prompt: string;
        completion: string;
        input_cache_read?: string;
        input_cache_write?: string;
    };
};
export type RoutingRule = {
    id: string;
    name: string;
    enabled?: boolean;
    cel_expression: string;
    targets: Array<{
        provider?: string | null;
        model?: string | null;
        weight: number;
    }>;
    fallbacks?: string[];
    scope: string;
    scope_id?: string | null;
    priority?: number;
};
export type VirtualKey = {
    id: string;
    name?: string;
    value?: string | null;
};
export type Chain = {
    /** Chain model name extracted from the routing rule (e.g. "glm-5.3-flash"). */
    name: string;
    /** Primary member id, "provider/model". */
    primary: string;
    /** Fallback member ids, in order. */
    fallbacks: string[];
};
/** Decode an OpenAI-shaped /v1/models wire envelope into member entries. */
export declare function wireCatalogToModels(envelope: {
    data: CatalogModel[];
}): CatalogModel[];
/** GET gateway /v1/models with the VK — the full member catalog with pricing. */
export declare function wireCatalog(token: string, baseUrl: string, signal?: AbortSignal, opts?: FetchJsonOptions): Promise<CatalogModel[]>;
/** Resolve the management-plane base URL from the inference /v1 base URL. */
export declare function managementBase(baseUrl: string): string;
/**
 * GET /api/governance/virtual-keys and match the INFERENCE credential value
 * (the VK) against VK values to discover this plugin's VK id (the scope_id
 * for routing-rule filtering). AUTH on the call is the MANAGEMENT token
 * (settings managementApiKey, falling back to the VK — the split matters on
 * deployments whose management plane expects a different credential than
 * inference). Returns undefined when no VK row's value matches vkValue.
 */
export declare function wireScopeId(managementToken: string, vkValue: string, baseUrl: string, signal?: AbortSignal, opts?: FetchJsonOptions): Promise<string | undefined>;
/**
 * GET /api/routing/rules?scope=virtual_key&scope_id=<id> and decode the
 * chain rules. AUTH is the MANAGEMENT token (see wireScopeId). Throws when
 * Bifrost responds with an error envelope (schema mismatch or HTTP error
 * surfaced by fetchJson).
 */
export declare function wireRules(managementToken: string, baseUrl: string, scopeId: string, signal?: AbortSignal, opts?: FetchJsonOptions): Promise<RoutingRule[]>;
/** Full discovery: catalog + rules for the VK, in parallel where possible.
 * AUTH: management plane (VK lookup + rules) uses managementToken; the
 * inference catalog uses the VK itself. */
export declare function wireDiscovery(managementToken: string, vkValue: string, baseUrl: string, scopeId: string, signal?: AbortSignal, opts?: FetchJsonOptions): Promise<{
    catalog: CatalogModel[];
    rules: RoutingRule[];
}>;
/**
 * Extract a chain model name from a routing rule's CEL expression.
 * Recognizes `model == "x"` arms and strips managed prefixes (`bifrost/`,
 * legacy `gateway/`) from each name. Every arm must reduce to one canonical
 * bare name — the chains-first convention. Anything else is not a chain rule.
 */
export declare function chainNameFromCel(cel: string): string | undefined;
/** Decode enabled, unambiguous chain rules. Order follows rule priority. */
export declare function wireRulesToChains(rules: RoutingRule[]): Chain[];
/** Convert a $/token wire string to pi's $/Mtok rate. */
export declare function perMtok(dollarsPerToken: string): number | undefined;
/**
 * Build one bifrost/<chain> chat model per chain. Cost is 0 by design. The
 * wire follows the chain's model-family (native protocol end to end): the
 * chain name decides — fallback legs of a chain are same-model by
 * construction, and the gateway translates any client wire for legs that
 * differ.
 */
export declare function buildChainModels(chains: Chain[], catalog: CatalogModel[], providerSlug: string, baseUrl: string, native?: NativeProtocols): GatewayModel[];
/**
 * Build direct-selectable models for the /v1/models catalog with real
 * per-member pricing, ordered with chain members first.
 */
export declare function buildMemberModels(chains: Chain[], catalog: CatalogModel[], providerSlug: string, baseUrl: string, thinkingOverrides?: Record<string, string[]>, native?: NativeProtocols): GatewayModel[];
/** Chains first, then upstream models (deduped by id — chain ids are namespaced). */
export declare function buildAllModels(chains: Chain[], catalog: CatalogModel[], providerSlug: string, baseUrl: string, publishChains: boolean, publishUpstream: boolean, thinkingOverrides?: Record<string, string[]>, native?: NativeProtocols): GatewayModel[];
