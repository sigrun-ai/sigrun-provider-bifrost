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
// Type re-exported by pi-ai (its own dependency); Compile/Validator come
// from typebox directly — typebox co-resolves with pi-ai everywhere pi-ai
// resolves (it is pi-ai's own dependency), so the build-time-only devDep
// posture is unchanged.
import { Type } from "@earendil-works/pi-ai";
import { Compile } from "typebox/compile";
import { fetchJson } from "./http.js";
/* ---------- gateway constants (pi port's src/bifrost.ts) ---------- */
/** The provider id models are registered (and stamped) under. */
export const PROVIDER_ID = "bifrost";
/** Sigrun-side chain display namespace; never sent to the gateway. */
export const CHAIN_ID_PREFIX = "chain/";
export const PROVIDER_DISPLAY_NAME = "Bifrost Gateway";
/** Different relative to the configured /v1 base URL. */
export const INFERENCE_PATH_MODELS = "models";
/** Management API paths (live-verified on Bifrost v2.2.x, 2026-10-08). */
export const MANAGEMENT_PATH_VIRTUAL_KEYS = "/api/governance/virtual-keys";
export const MANAGEMENT_PATH_ROUTING_RULES = "/api/routing/rules";
/**
 * Neutral createProvider-shape baseUrl used before a URL exists from any
 * source. NEVER requested: every published model carries its own
 * discovery-time baseUrl, and discovery refuses to run without a real URL
 * (unconfigured throws). An install in this state publishes zero models.
 */
export const UNRESOLVED_BASE_URL = "http://localhost:8080/v1";
/* ---------- thinking ladder ---------- */
/**
 * pi thinking levels, ladder order; `off` (the map's disable key) comes from
 * ModelThinkingLevel, not this ladder. Chain models are transport-only:
 * effort routing happens through the gateway, so every chain advertises the
 * full map and the client sends reasoning_effort untouched.
 */
const PI_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];
/**
 * Input modalities published for models this plugin serves.
 *
 * Bifrost's /v1/models wire carries no modality metadata, so per-model truth
 * is unknowable at catalog-refresh time. Declaring text-only is the worse
 * error: pi-ai gates TOOL-RESULT images on model.input and silently replaces
 * them with "(see attached image)" — a silent data-loss path (user-message
 * images are forwarded regardless). Declaring image lets tool-result images
 * through; a genuinely text-only upstream then 400s and Bifrost fails over
 * to the next chain member, which is visible instead of lossy. This is the
 * same trade-off as the reasoning:true invariant: false capability is
 * recoverable, hidden capability is not.
 */
const INPUT_MODALITIES = ["text", "image"];
const TEXT_ONLY_MODALITIES = ["text"];
/**
 * Model families with NO image input anywhere in the serving fleet
 * (user ruling 2026-10-16; evidence in llm-catalogue vision-provider-grid.md).
 * EXACT bare-name match after stripping the managed prefixes — substring
 * matching would wrongly sweep vision-capable siblings: glm-5.3-flash is
 * vision-capable first-party, deepseek-v4.1-flash likewise; only the bare
 * glm-5.3 / deepseek-v4-flash / deepseek-v4-pro are text-only. hyper's
 * glm-5.3 additionally SILENT-DROPS images (accepts HTTP 200, ignores the
 * pixels) — the worst mode, because no 400 means no failover.
 */
const TEXT_ONLY_MODELS = new Set([
    "glm-5.3",
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    // upstream snapshot ids price differently but share the text-only weights
    "deepseek-v4-flash-0731",
    "deepseek-v4-pro-0813",
]);
/** Chain ids publish WITHOUT the provider prefix; members publish "provider/model". */
function bareModelName(id) {
    const noPrefix = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
    // Strip legacy managed prefixes (gateway/, bifrost/) if a rule CEL ever
    // produces a prefixed bare name; MANAGED_PREFIXES itself is private to CEL
    // decoding, so this local strip keeps the denylist honest at both call sites.
    return noPrefix.replace(/^(gateway|bifrost|chain)\//, "");
}
function inputFor(id) {
    return TEXT_ONLY_MODELS.has(bareModelName(id)) ? [...TEXT_ONLY_MODALITIES] : [...INPUT_MODALITIES];
}
export function nativeFamily(id) {
    const name = (id.split("/").pop() ?? id).toLowerCase();
    if (name.includes("claude"))
        return "anthropic";
    if (/^(gpt(?!-oss)|o\d|codex)/.test(name))
        return "openai";
    return "other";
}
/** Bare (last-segment) name of a model id or chain name. */
function bareName(id) {
    return id.split("/").pop() ?? id;
}
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
export function surfaceFor(id, baseUrl, native) {
    if (native?.messages) {
        const name = bareName(id).toLowerCase();
        const match = native.messagesModels
            ? native.messagesModels.some((m) => m.toLowerCase() === name)
            : nativeFamily(id) === "anthropic";
        if (match)
            return { api: "anthropic-messages", baseUrl: `${managementBase(baseUrl)}/anthropic` };
    }
    if (native?.responses) {
        const name = bareName(id).toLowerCase();
        const match = native.responsesModels
            ? native.responsesModels.some((m) => m.toLowerCase() === name)
            : nativeFamily(id) === "openai";
        if (match)
            return { api: "openai-responses", baseUrl };
    }
    return { api: "openai-completions", baseUrl };
}
const CONTEXT_WINDOW_FALLBACK = 128_000;
const MAX_TOKENS_FALLBACK = 8_192;
/* ---------- wire schemas (typebox-validated) ---------- */
const PricingSchema = Type.Object({
    prompt: Type.String(),
    completion: Type.String(),
    input_cache_read: Type.Optional(Type.String()),
    input_cache_write: Type.Optional(Type.String()),
});
export const CatalogModelSchema = Type.Object({
    id: Type.String(),
    owned_by: Type.Optional(Type.String()),
    context_length: Type.Optional(Type.Number()),
    max_output_limit: Type.Optional(Type.Number()),
    pricing: Type.Optional(PricingSchema),
});
export const ModelsEnvelopeSchema = Type.Object({
    data: Type.Array(CatalogModelSchema),
});
export const RoutingTargetSchema = Type.Object({
    provider: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    model: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    weight: Type.Number(),
});
export const RoutingRuleSchema = Type.Object({
    id: Type.String(),
    name: Type.String(),
    enabled: Type.Optional(Type.Boolean()),
    cel_expression: Type.String(),
    targets: Type.Array(RoutingTargetSchema),
    fallbacks: Type.Optional(Type.Array(Type.String())),
    scope: Type.String(),
    scope_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    priority: Type.Optional(Type.Number()),
});
export const RulesEnvelopeSchema = Type.Object({
    rules: Type.Array(RoutingRuleSchema),
});
export const VirtualKeySchema = Type.Object({
    id: Type.String(),
    name: Type.Optional(Type.String()),
    value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
/**
 * Wire envelope as observed 2026-10-08: GET /api/governance/virtual-keys
 * returns `{virtual_keys: [...], count, ...}` with the full VK rows
 * INCLUDING their secret values. Unknown extra fields pass validation.
 */
export const VirtualKeysEnvelopeSchema = Type.Object({
    virtual_keys: Type.Array(VirtualKeySchema),
});
const ModelsEnvelopeValidator = Compile(ModelsEnvelopeSchema);
const RulesEnvelopeValidator = Compile(RulesEnvelopeSchema);
const VirtualKeysEnvelopeValidator = Compile(VirtualKeysEnvelopeSchema);
/* ---------- wire fetching ---------- */
/** Decode an OpenAI-shaped /v1/models wire envelope into member entries. */
export function wireCatalogToModels(envelope) {
    return envelope.data;
}
/** GET gateway /v1/models with the VK — the full member catalog with pricing. */
export async function wireCatalog(token, baseUrl, signal, opts) {
    const envelope = await fetchJson(`${baseUrl.replace(/\/$/, "")}/${INFERENCE_PATH_MODELS}`, token, ModelsEnvelopeValidator, signal, opts);
    return wireCatalogToModels(envelope);
}
/** Resolve the management-plane base URL from the inference /v1 base URL. */
export function managementBase(baseUrl) {
    return baseUrl.replace(/\/v1\/?$/, "");
}
/**
 * GET /api/governance/virtual-keys and match the INFERENCE credential value
 * (the VK) against VK values to discover this plugin's VK id (the scope_id
 * for routing-rule filtering). AUTH on the call is the MANAGEMENT token
 * (settings managementApiKey, falling back to the VK — the split matters on
 * deployments whose management plane expects a different credential than
 * inference). Returns undefined when no VK row's value matches vkValue.
 */
export async function wireScopeId(managementToken, vkValue, baseUrl, signal, opts) {
    const url = `${managementBase(baseUrl)}${MANAGEMENT_PATH_VIRTUAL_KEYS}`;
    const envelope = await fetchJson(url, managementToken, VirtualKeysEnvelopeValidator, signal, opts);
    const keys = envelope.virtual_keys;
    const match = keys.find((vk) => vk.value === vkValue);
    return match?.id;
}
/**
 * GET /api/routing/rules?scope=virtual_key&scope_id=<id> and decode the
 * chain rules. AUTH is the MANAGEMENT token (see wireScopeId). Throws when
 * Bifrost responds with an error envelope (schema mismatch or HTTP error
 * surfaced by fetchJson).
 */
export async function wireRules(managementToken, baseUrl, scopeId, signal, opts) {
    const url = `${managementBase(baseUrl)}${MANAGEMENT_PATH_ROUTING_RULES}?scope=virtual_key&scope_id=${encodeURIComponent(scopeId)}`;
    const envelope = await fetchJson(url, managementToken, RulesEnvelopeValidator, signal, opts);
    return envelope.rules;
}
/** Full discovery: catalog + rules for the VK, in parallel where possible.
 * AUTH: management plane (VK lookup + rules) uses managementToken; the
 * inference catalog uses the VK itself. */
export async function wireDiscovery(managementToken, vkValue, baseUrl, scopeId, signal, opts) {
    const [catalog, rules] = await Promise.all([
        wireCatalog(vkValue, baseUrl, signal, opts),
        wireRules(managementToken, baseUrl, scopeId, signal, opts),
    ]);
    return { catalog, rules };
}
/* ---------- chain decoding (pure) ---------- */
/** Managed model-id prefixes that strip to the bare chain name. */
const MANAGED_PREFIXES = ["bifrost", "gateway", "chain"];
/**
 * Extract a chain model name from a routing rule's CEL expression.
 * Recognizes `model == "x"` arms and strips managed prefixes (`bifrost/`,
 * legacy `gateway/`) from each name. Every arm must reduce to one canonical
 * bare name — the chains-first convention. Anything else is not a chain rule.
 */
export function chainNameFromCel(cel) {
    const names = [...cel.matchAll(/model\s*==\s*"([^"]+)"/g)].map((m) => m[1]);
    if (names.length < 2)
        return undefined;
    const canonical = new Set(names.map((n) => {
        const idx = n.indexOf("/");
        const prefix = idx > 0 ? n.slice(0, idx) : "";
        return MANAGED_PREFIXES.includes(prefix) ? n.slice(idx + 1) : n;
    }));
    return canonical.size === 1 ? [...canonical][0] : undefined;
}
/** Decode enabled, unambiguous chain rules. Order follows rule priority. */
export function wireRulesToChains(rules) {
    const usable = [];
    for (const rule of rules) {
        if (rule.enabled === false)
            continue;
        const name = chainNameFromCel(rule.cel_expression);
        if (!name)
            continue;
        const primaries = new Set(rule.targets.map((t) => {
            if (typeof t.model !== "string" || t.model.length === 0)
                return null;
            return typeof t.provider === "string" && t.provider.length > 0 ? `${t.provider}/${t.model}` : t.model;
        }).filter((m) => typeof m === "string"));
        if (primaries.size !== 1)
            continue; // zero or multiple pinned models = ambiguous
        const primary = [...primaries][0];
        usable.push({
            chain: { name, primary, fallbacks: rule.fallbacks ?? [] },
            priority: rule.priority ?? 0,
        });
    }
    usable.sort((a, b) => a.priority - b.priority);
    return usable.map((entry) => entry.chain);
}
/* ---------- model building (pure) ---------- */
/** Convert a $/token wire string to pi's $/Mtok rate. */
export function perMtok(dollarsPerToken) {
    const value = Number.parseFloat(dollarsPerToken);
    return Number.isFinite(value) && value > 0 ? value * 1_000_000 : undefined;
}
/**
 * The published map ships the full ladder for transport surfaces (chains are
 * transport-only: the gateway routes effort). A direct member with a
 * settings-declared subset gets exactly that subset — pi-ai disables levels
 * it sends for a model.
 *
 * Per-surface `off` values (pi-inferhub, live-verified 2026-10-18):
 * - openai-completions: "off" — gateway-normalized passthrough.
 * - openai-responses: "none" — [OI] reasoning-off is effort "none"; "off" is
 *   accepted but leaves the effort unset.
 * - anthropic-messages: null — these Claude models reject
 *   thinking:{type:"disabled"} (400); null makes pi-ai omit the field.
 *   Level keys stay absent so the client keeps every level selectable
 *   (optimistic by design) — the Anthropic effort ladder has no "minimal",
 *   so the completions ladder would advertise a level pi-ai cannot express
 *   on this surface.
 */
function thinkingLevelMap(api, levels) {
    if (api === "anthropic-messages")
        return { off: null };
    if (api === "openai-responses") {
        const map = { off: "none" };
        for (const level of levels ?? PI_THINKING_LEVELS)
            map[level] = level;
        return map;
    }
    const ladder = levels ?? PI_THINKING_LEVELS;
    const map = { off: "off" };
    for (const level of ladder)
        map[level] = level;
    return map;
}
/**
 * Build one chain/<name> display model per chain. Cost is 0 by design. The
 * wire follows the chain's model-family (native protocol end to end): the
 * chain name decides — fallback legs of a chain are same-model by
 * construction, and the gateway translates any client wire for legs that
 * differ.
 */
export function buildChainModels(chains, catalog, providerSlug, baseUrl, native) {
    const byId = new Map(catalog.map((m) => [m.id, m]));
    return chains.map((chain) => {
        const members = [chain.primary, ...chain.fallbacks];
        const contexts = members
            .map((id) => byId.get(id)?.context_length)
            .filter((v) => typeof v === "number");
        const contextWindow = contexts.length > 0 ? Math.min(...contexts) : CONTEXT_WINDOW_FALLBACK;
        return buildModel({
            id: `${CHAIN_ID_PREFIX}${chain.name}`,
            name: chain.name,
            familyId: chain.name,
            provider: providerSlug,
            baseUrl,
            native,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow,
            maxTokens: MAX_TOKENS_FALLBACK,
        });
    });
}
/** Shared field assembly for both builders; the surface (api/baseUrl/map/
 * compat) derives from the model NAME's native family. */
function buildModel(args) {
    const surface = surfaceFor(args.familyId, args.baseUrl, args.native);
    const common = {
        id: args.id,
        name: args.name,
        provider: args.provider,
        input: [...inputFor(args.familyId)],
        cost: args.cost,
        reasoning: true,
        contextWindow: args.contextWindow,
        maxTokens: args.maxTokens,
    };
    if (surface.api === "anthropic-messages") {
        const model = {
            ...common,
            api: surface.api,
            baseUrl: surface.baseUrl,
            thinkingLevelMap: thinkingLevelMap(surface.api),
            // These Claude models reject thinking:{type:"disabled"} (400,
            // live-verified in pi-inferhub 2026-10-18) — always adaptive.
            compat: { forceAdaptiveThinking: true },
        };
        return model;
    }
    if (surface.api === "openai-responses") {
        const model = {
            ...common,
            api: surface.api,
            baseUrl: surface.baseUrl,
            thinkingLevelMap: thinkingLevelMap(surface.api, args.thinkingLevels),
        };
        return model;
    }
    const model = {
        ...common,
        api: surface.api,
        baseUrl: surface.baseUrl,
        thinkingLevelMap: thinkingLevelMap(surface.api, args.thinkingLevels),
    };
    return model;
}
/** Catalog entries that collide with the reserved chain display namespace. */
export function collidingMemberIds(catalog) {
    return catalog.filter((entry) => entry.id.startsWith(CHAIN_ID_PREFIX)).map((entry) => entry.id);
}
/**
 * Build direct-selectable models for the /v1/models catalog with real
 * per-member pricing, ordered with chain members first.
 */
export function buildMemberModels(chains, catalog, providerSlug, baseUrl, thinkingOverrides, native) {
    const memberIds = [];
    const seen = new Set();
    for (const chain of chains) {
        for (const id of [chain.primary, ...chain.fallbacks]) {
            if (!seen.has(id)) {
                seen.add(id);
                memberIds.push(id);
            }
        }
    }
    const byId = new Map(catalog.map((m) => [m.id, m]));
    for (const entry of catalog) {
        if (!seen.has(entry.id)) {
            seen.add(entry.id);
            memberIds.push(entry.id);
        }
    }
    const models = [];
    for (const memberId of memberIds) {
        if (memberId.startsWith(CHAIN_ID_PREFIX))
            continue;
        const entry = byId.get(memberId);
        if (!entry)
            continue; // chain member absent from /v1/models — skip rather than guess
        const inputRate = entry.pricing ? perMtok(entry.pricing.prompt) : undefined;
        const outputRate = entry.pricing ? perMtok(entry.pricing.completion) : undefined;
        // The gateway reports cache rates when its upstream pricing carries
        // them; a missing or zero rate becomes cost 0 (HONEST-zero rule —
        // never fabricated), so member cache-read costs read free until
        // Bifrost's datasheet is populated.
        const cacheReadRate = entry.pricing?.input_cache_read ? perMtok(entry.pricing.input_cache_read) : undefined;
        const cacheWriteRate = entry.pricing?.input_cache_write ? perMtok(entry.pricing.input_cache_write) : undefined;
        models.push(buildModel({
            id: memberId,
            name: memberId,
            familyId: memberId,
            provider: providerSlug,
            baseUrl,
            native,
            cost: {
                input: inputRate ?? 0,
                output: outputRate ?? 0,
                cacheRead: cacheReadRate ?? 0,
                cacheWrite: cacheWriteRate ?? 0,
            },
            contextWindow: entry.context_length ?? CONTEXT_WINDOW_FALLBACK,
            maxTokens: entry.max_output_limit ?? MAX_TOKENS_FALLBACK,
            thinkingLevels: thinkingOverrides?.[memberId],
        }));
    }
    return models;
}
/** Chains first, then upstream models (deduped by id — chain ids are namespaced). */
export function buildAllModels(chains, catalog, providerSlug, baseUrl, publishChains, publishUpstream, thinkingOverrides, native) {
    const chainModels = publishChains ? buildChainModels(chains, catalog, providerSlug, baseUrl, native) : [];
    const upstreamModels = publishUpstream
        ? buildMemberModels(chains, catalog, providerSlug, baseUrl, thinkingOverrides, native)
        : [];
    return [...chainModels, ...upstreamModels];
}
