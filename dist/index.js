/**
 * @sigrun/provider-bifrost — the big port (provider plugins Task 10):
 * [Bifrost](https://github.com/maximhq/bifrost) LLM gateway as one dynamic
 * provider, ported from pi-bifrost-gateway 0.3.0 @ 5d15a28. All failover,
 * key selection, and routing happens in Bifrost — this plugin never routes
 * anything itself.
 *
 * The default export is the sigrun extension-package factory returning a
 * PROVIDER-ONLY contributor — `{ name, providers, health }` with no
 * `extension` field — consumed structurally by sigrun's loader (Task 1
 * pathway). The port's two deliberate adaptations:
 *
 * - CONFIG: pi's config file becomes the plugin's SCOPED SETTINGS
 *   (`settings/provider-bifrost.json`), DECLARED as JSON Schema
 *   (`src/settings-schema.ts`) and read ONCE at factory time —
 *   restart-required. Core owns the generated settings page, the defaults
 *   and the malformed-value repair; the declared name and the package name
 *   are the same string, so the loader's provisional slug IS the final slug
 *   (`provider-bifrost`) and the factory-body read resolves the file the
 *   settings page writes. No /login flow; no pi config file.
 * - CREDENTIALS: the VK comes from sigrun's auth.json bridge (the stored
 *   credential arrives as `credential` on the auth resolver) with
 *   `BIFROST_API_KEY` as the ambient fallback; the ambient base URL
 *   (`BIFROST_BASE_URL`) and management key (`BIFROST_MANAGEMENT_API_KEY`)
 *   resolve through the same env seam. The plugin never reads auth.json or
 *   `process.env` itself. The management key itself is a SETTINGS SECRET
 *   (`managementApiKey`, `writeOnly`): core keeps it in the secrets store,
 *   never in `settings/provider-bifrost.json`.
 *
 * Two discovery modes (settings `publishChains`, default false):
 * - chains mode: the management plane is queried — VK self-identification
 *   (`/api/governance/virtual-keys`) + routing rules
 *   (`/api/routing/rules`) — and a rules set with no usable chains fails
 *   discovery loud.
 * - member-only mode (default): the inference plane alone (`GET /v1/models`);
 *   ZERO management calls, so it works against a stock gateway with
 *   governance disabled entirely.
 *
 * `fetchModels` THROWS on unconfigured (no key or no base URL), on a bad
 * credential/VK mismatch, and on zero chains — it NEVER returns `[]`,
 * which pi-ai would publish and persist, wiping the catalog.
 *
 * Runtime imports from pi-ai are deliberate (`createProvider` + the three
 * api surfaces); the package declares pi-ai/pi-durable as devDependencies
 * only, because sigrun (the host) ships them and `syncPackages` installs
 * without dev dependencies — the provider-plugins spec's dependency
 * posture.
 */
import { createProvider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { BIFROST_BASE_URL_ENV, BIFROST_MANAGEMENT_API_KEY_ENV, BIFROST_SETTINGS_SCHEMA, THINKING_LEVELS, } from "./settings-schema.js";
import { PROVIDER_DISPLAY_NAME, PROVIDER_ID, UNRESOLVED_BASE_URL, CHAIN_ID_PREFIX, buildAllModels, collidingMemberIds, wireCatalog, wireDiscovery, wireRulesToChains, wireScopeId, } from "./catalog.js";
import { withWireNames } from "./wire.js";
// Re-exported gateway constants (the pi port's src/bifrost.ts surface):
// the provider id is part of this plugin's public contract — sigrun's
// auth-check names providers by id and tests pin the model stamp to it.
export { PROVIDER_ID, PROVIDER_DISPLAY_NAME, UNRESOLVED_BASE_URL, CHAIN_ID_PREFIX };
// Re-exported settings types so consumers (and tests) need no deep
// imports: the schema itself, the `Static` settings type, and the
// native-surface selection the catalog builders consume.
export { BIFROST_BASE_URL_ENV, BIFROST_MANAGEMENT_API_KEY_ENV, BIFROST_SETTINGS_SCHEMA, THINKING_LEVELS, } from "./settings-schema.js";
export { chainWireName, withWireNames } from "./wire.js";
/**
 * The secrets-store key this plugin's management credential lives under —
 * the bare property name, which is what core's encoding uses for a
 * TOP-LEVEL `writeOnly` setting (`src/settings/schema/secrets.ts`: "a
 * top-level secret keeps its bare name"). This is also the key the legacy
 * migration writes, so the value it moves is the one the checked read
 * fills back in.
 */
export const BIFROST_MANAGEMENT_API_KEY_SECRET = "managementApiKey";
/** Ambient fallback for the virtual key when auth.json holds no credential. */
export const BIFROST_API_KEY_ENV = "BIFROST_API_KEY";
let chainNamespaceWarned = false;
function warnOnChainNamespaceCollision(catalog) {
    if (chainNamespaceWarned || collidingMemberIds(catalog).length === 0)
        return;
    console.warn('bifrost: upstream provider "chain" collides with the chain display namespace; its models are skipped');
    chainNamespaceWarned = true;
}
/**
 * Compose the gateway model list from live Bifrost state (the ported
 * `discoverModels` with sigrun's failure semantics — throws instead of
 * returning `[]` on unconfigured, so a misconfigured deployment surfaces
 * instead of silently wiping the catalog):
 *
 * - chains mode (`publishChains`): VK self-identification + routing rules
 *   via the MANAGEMENT token (`managementApiKey` ?? the VK), then catalog +
 *   rules in parallel (catalog with the VK itself). Zero usable chains
 *   throws — is chains-first routing configured for this VK?
 * - member-only mode: inference plane alone; both publish flags off throws
 *   (a configured provider publishing nothing is a settings error, and
 *   `fetchModels` never returns `[]`).
 *
 * Throws when the credential is not a recognized VK (chains mode) or when
 * discovery itself fails (unreachable gateway, schema mismatch).
 */
export async function discoverModels(token, baseUrl, options, signal) {
    if (!token || !baseUrl) {
        throw new Error("provider-bifrost: the gateway is not configured " +
            `(need a virtual key (auth.json or ${BIFROST_API_KEY_ENV}) and a base URL ` +
            `(settings baseUrl or ${BIFROST_BASE_URL_ENV})); refusing to publish an empty catalog`);
    }
    if (options.publishChains) {
        const managementToken = options.managementApiKey ?? token;
        const scopeId = await wireScopeId(managementToken, token, baseUrl, signal);
        if (!scopeId) {
            throw new Error("provider-bifrost: credential does not match any virtual key in /api/governance/virtual-keys");
        }
        const { catalog, rules } = await wireDiscovery(managementToken, token, baseUrl, scopeId, signal);
        warnOnChainNamespaceCollision(catalog);
        const chains = wireRulesToChains(rules);
        if (chains.length === 0) {
            throw new Error(`provider-bifrost: no chain routing rules found for ${scopeId} — is chains-first routing configured for this VK?`);
        }
        const models = buildAllModels(chains, catalog, PROVIDER_ID, baseUrl, true, options.publishUpstream, options.thinkingOverrides, options.nativeProtocols);
        if (models.length === 0) {
            throw new Error("provider-bifrost: chains discovery produced no models; refusing to publish an empty catalog");
        }
        return models;
    }
    // Member-only mode: inference plane only, ZERO management calls.
    if (!options.publishUpstream) {
        throw new Error("provider-bifrost: publishChains and publishUpstream are both false — nothing to publish");
    }
    const catalog = await wireCatalog(token, baseUrl, signal);
    warnOnChainNamespaceCollision(catalog);
    const models = buildAllModels([], catalog, PROVIDER_ID, baseUrl, false, true, options.thinkingOverrides, options.nativeProtocols);
    if (models.length === 0) {
        throw new Error("provider-bifrost: /v1/models returned no usable entries; refusing to publish an empty catalog");
    }
    return models;
}
/**
 * Build the Bifrost provider plus its readiness/health trackers.
 * `options` are the FACTORY-BAKED settings (restart-required); the ambient
 * `BIFROST_BASE_URL` and `BIFROST_MANAGEMENT_API_KEY` resolve at
 * credential-resolution time through the env seam and fall below the baked
 * settings in precedence (a settings `managementApiKey` — secret store or a
 * legacy file value — outranks the ambient management key).
 */
export function createBifrostPlugin(options) {
    // Tracker state: seeded from credential resolution (pi-ai never
    // refreshes an unconfigured provider, so refresh outcomes alone cannot
    // express not_configured), updated per refresh outcome. Readiness and
    // health are synchronous derivations over this state.
    let credentialResolved = false;
    let lastRefreshFailed = false;
    let lastRefreshDetail;
    let lastAnnounced;
    // The ambient base URL and management key, captured at credential
    // resolution (the only place the env seam is available); the baked
    // settings values outrank both.
    let ambientBaseUrl;
    let ambientManagementApiKey;
    const wireNames = new Map();
    function status() {
        if (!credentialResolved)
            return "not_configured";
        return lastRefreshFailed ? "degraded" : "ready";
    }
    /** Apply a state change; `console.warn` on transitions only. */
    function announce() {
        const next = status();
        if (next === lastAnnounced)
            return;
        console.warn(`provider-bifrost: bifrost ${lastAnnounced ?? "startup"} → ${next}` +
            (lastRefreshDetail !== undefined && next === "degraded"
                ? ` (${lastRefreshDetail})`
                : ""));
        lastAnnounced = next;
    }
    function noteCredential(resolved) {
        credentialResolved = resolved;
        announce();
    }
    function noteRefresh(ok, detail) {
        lastRefreshFailed = !ok;
        lastRefreshDetail = ok ? undefined : detail;
        announce();
    }
    const provider = createProvider({
        id: PROVIDER_ID,
        name: PROVIDER_DISPLAY_NAME,
        // UNRESOLVED_BASE_URL satisfies createProvider's shape before any
        // URL exists; it is never requested — discovery refuses to run
        // without a real URL, and every published model carries its own
        // discovery-time baseUrl.
        baseUrl: options.baseUrl ?? UNRESOLVED_BASE_URL,
        // REQUIRED baseline: createProvider iterates it (omitting throws
        // "baselineModels is not iterable"); empty = purely dynamic. An
        // unconfigured provider boots with zero models.
        models: [],
        auth: {
            apiKey: {
                name: `Bifrost virtual key (auth.json or ${BIFROST_API_KEY_ENV})`,
                resolve: async ({ credential, ctx }) => {
                    // Ambient base-URL capture happens on every resolution —
                    // the env seam is only available here, and like the key
                    // itself, rotating it applies on the next resolution.
                    const envUrl = (await ctx.env(BIFROST_BASE_URL_ENV))?.trim() || undefined;
                    if (envUrl !== undefined)
                        ambientBaseUrl = envUrl;
                    // The management credential rides the same seam: a
                    // deployment can inject it as an env var instead of
                    // setting the stored secret, and rotating it applies on
                    // the next resolution like every other ambient value.
                    const envManagementApiKey = (await ctx.env(BIFROST_MANAGEMENT_API_KEY_ENV))?.trim() || undefined;
                    if (envManagementApiKey !== undefined) {
                        ambientManagementApiKey = envManagementApiKey;
                    }
                    // Bridged auth.json credential (sigrun's bridge: the
                    // "default" entry first, then the provider's own) wins;
                    // the env var is the ambient fallback.
                    const stored = credential?.key?.trim() || undefined;
                    if (stored !== undefined) {
                        noteCredential(true);
                        return { auth: { apiKey: stored }, source: "auth.json" };
                    }
                    const envKey = (await ctx.env(BIFROST_API_KEY_ENV))?.trim() || undefined;
                    if (envKey !== undefined) {
                        noteCredential(true);
                        return { auth: { apiKey: envKey }, source: BIFROST_API_KEY_ENV };
                    }
                    // Unconfigured: undefined makes pi-ai skip the refresh
                    // phase entirely and requests fail loud.
                    noteCredential(false);
                    return undefined;
                },
            },
        },
        // Native-protocol surfaces: createProvider dispatches on model.api —
        // anthropic-messages for claude-family models (wired to the gateway's
        // /anthropic integration route), openai-responses for gpt-family
        // models, chat completions for everything else. Which models get a
        // native wire is settings-gated (nativeProtocols; both off by
        // default). The map always registers all three: the registry entry
        // is inert for models that never publish that api.
        api: {
            "openai-completions": withWireNames(openAICompletionsApi(), wireNames),
            "openai-responses": withWireNames(openAIResponsesApi(), wireNames),
            "anthropic-messages": withWireNames(anthropicMessagesApi(), wireNames),
        },
        fetchModels: async (context) => {
            const key = context.credential?.type === "api_key"
                ? context.credential.key?.trim() || undefined
                : undefined;
            // URL precedence: the factory-baked settings URL wins, then the
            // ambient BIFROST_BASE_URL captured at credential resolution.
            // context.baseUrl is IGNORED — it echoes this provider's
            // registration URL, which may be the never-requested placeholder.
            const url = options.baseUrl ?? ambientBaseUrl;
            // The settings secret (store, else a legacy file value) outranks
            // the ambient env key; the virtual key is the last resort inside
            // discovery.
            const effective = {
                ...options,
                managementApiKey: options.managementApiKey ?? ambientManagementApiKey,
            };
            try {
                const models = await discoverModels(key, url, effective, context.signal);
                wireNames.clear();
                for (const model of models) {
                    if (model.id.startsWith(CHAIN_ID_PREFIX))
                        wireNames.set(model.id, model.name);
                }
                noteRefresh(true);
                return models;
            }
            catch (cause) {
                // An aborted refresh is not a failed one: pi-ai discards
                // the outcome anyway, so the tracker must not move.
                if (context.signal.aborted)
                    throw cause;
                if (key === undefined)
                    noteCredential(false);
                const message = cause instanceof Error ? cause.message : String(cause);
                noteRefresh(false, message);
                throw cause;
            }
        },
    });
    return {
        provider,
        readiness: () => ({
            status: status(),
            ...(lastRefreshDetail !== undefined && status() === "degraded"
                ? { detail: lastRefreshDetail }
                : {}),
        }),
        // not_configured → ok (an unconfigured optional plugin is not a
        // degraded process); configured-and-failing → degraded; else ok.
        health: () => (status() === "degraded" ? "degraded" : "ok"),
    };
}
/**
 * Move a PRE-REWORK management key out of `settings/provider-bifrost.json`
 * into the secrets store, then strip it from the file.
 *
 * Core's save path strips a `writeOnly` property from what it writes and
 * takes a new value from the submitted form — it cannot know that a value
 * already sitting IN the file was a secret, so the first save of the page
 * would drop it. Core's checked read keeps handing that file value back
 * (that is what makes it work on the boot that still has it), which leaves
 * exactly this housekeeping to the extension: store it under the declared
 * key, then delete it from the file.
 *
 * Precedence is core's ("stored wins"): a value already in the secrets store
 * is never overwritten, and the stale file copy is still removed. The store
 * write happens BEFORE the file rewrite, and a failure leaves the file
 * untouched (warned, never fatal) — the value is then still read from the
 * file and the next boot retries. A file value that is not a usable string
 * is left alone: core's checked read repairs it (with a notice) and there is
 * nothing to move.
 */
export async function migrateLegacyManagementApiKey(stores, stored) {
    if (!Object.hasOwn(stored, "managementApiKey"))
        return;
    const value = typeof stored.managementApiKey === "string" ? stored.managementApiKey.trim() : "";
    // Nothing usable to move (a wrong-typed value, or blank): leave the file
    // alone — core's checked read repairs it with its own notice, and there is
    // no secret to lose.
    if (value === "")
        return;
    try {
        // The file is rewritten wholesale, so everything else it holds
        // (declared and unknown keys alike) is preserved.
        const { managementApiKey: _moved, ...rest } = stored;
        const existing = await stores.secrets.get(BIFROST_MANAGEMENT_API_KEY_SECRET);
        if (existing === undefined || existing === "") {
            await stores.secrets.set(BIFROST_MANAGEMENT_API_KEY_SECRET, value);
        }
        await stores.settings.set(rest);
        console.warn(`provider-bifrost: moved managementApiKey out of settings/provider-bifrost.json ` +
            "into the secrets store (key managementApiKey)");
    }
    catch (error) {
        console.warn(`provider-bifrost: could not move managementApiKey into the secrets store ` +
            `(${error instanceof Error ? error.message : String(error)}); ` +
            "settings/provider-bifrost.json is unchanged");
    }
}
/**
 * Normalise the exact-name lists the deleted parser trimmed: each name loses
 * its surrounding whitespace and duplicates collapse, preserving order.
 *
 * JSON Schema cannot trim, and the names are matched against bare model ids,
 * so an untrimmed name would silently match nothing. An emptied list is
 * dropped rather than left empty: `surfaceFor` reads an EMPTY list as "no
 * model matches" (the surface goes dark even with its toggle on), while an
 * ABSENT list means "use the built-in family heuristic" — the parser's own
 * reading for a list it could not use.
 */
export function usableNativeProtocols(native) {
    if (native === undefined)
        return undefined;
    const names = (list) => {
        if (list === undefined)
            return undefined;
        const trimmed = [...new Set(list.map((name) => name.trim()))].filter((name) => name !== "");
        return trimmed.length > 0 ? trimmed : undefined;
    };
    return {
        responses: native.responses,
        messages: native.messages,
        ...(names(native.responsesModels) !== undefined
            ? { responsesModels: names(native.responsesModels) }
            : {}),
        ...(names(native.messagesModels) !== undefined
            ? { messagesModels: names(native.messagesModels) }
            : {}),
    };
}
/**
 * Apply the deleted parser's all-or-nothing thinking-ladder rule.
 *
 * One unknown level makes that member's WHOLE entry be ignored, so the member
 * keeps its default ladder — the deleted parser's own comment: "a ladder the
 * author didn't fully know must not be half-applied". Core cannot enforce it:
 * its repair addresses each failing value by JSON pointer, and a member id
 * contains "/" (every real id is `provider/model`), so for such a key the
 * repair resolves no target and leaves the bad level in place (verified) —
 * where it would reach `catalog.ts` as a level pi-ai cannot map.
 *
 * The rest of the key's leniency is core's: a group that is not an object, an
 * entry that is not a list, and an emptied ladder are all removed — the same
 * outcome the parser produced.
 */
export function usableThinkingOverrides(ladders, warn) {
    if (ladders === undefined)
        return undefined;
    const known = new Set(THINKING_LEVELS);
    const overrides = {};
    // Core leaves these values untouched (see above), so a row is not
    // necessarily a list of level names by the time it arrives.
    for (const [memberId, ladder] of Object.entries(ladders)) {
        const usable = Array.isArray(ladder) &&
            ladder.length > 0 &&
            ladder.every((level) => typeof level === "string" && known.has(level));
        if (!usable) {
            warn(`provider-bifrost: thinkingOverrides["${memberId}"] names an unknown level; ` +
                "the entry is ignored and the member keeps the full ladder");
            continue;
        }
        overrides[memberId] = ladder;
    }
    return Object.keys(overrides).length > 0 ? overrides : undefined;
}
/**
 * The sigrun extension-package factory (provider-only contributor).
 * Arity 1 declares the host-taking signature — sigrun's loader passes the
 * seam host only to factories that declare one (`factory.length > 0`) —
 * and the factory is ASYNC because the declared-settings read is
 * async-only; sigrun's loader awaits factory results.
 *
 * Settings are DECLARED first (`src/settings-schema.ts` — core owns the
 * page, the defaults and the malformed-value repair) and read ONCE, then
 * baked into the provider: every key is factory-time, so every property is
 * `restart`. The declared name and this package's name are the same string
 * (`provider-bifrost`), so the loader's provisional slug IS the final slug
 * and the factory-time read resolves `settings/provider-bifrost.json`.
 *
 * Two rules the declared schema cannot state live here: a pre-rework
 * `managementApiKey` is moved into the secrets store
 * (`migrateLegacyManagementApiKey`), and the thinking ladders keep the
 * parser's all-or-nothing levels (`usableThinkingOverrides`).
 */
export default async function sigrunBifrost(host) {
    const declared = host.settings.declare({
        schema: BIFROST_SETTINGS_SCHEMA,
    });
    // The stored file, for the one rule that must read the DOCUMENT rather
    // than the checked read: the pre-rework management key's move (core cannot
    // know that an in-file value was a secret). Everything else comes through
    // the handle.
    await migrateLegacyManagementApiKey(host.stores, await host.stores.settings.get());
    const settings = await declared.get();
    // The checked read fills "" for an unset secret: "" means unset here,
    // exactly as an untouched secret field submits it on save.
    const plugin = createBifrostPlugin({
        publishChains: settings.publishChains,
        publishUpstream: settings.publishUpstream,
        baseUrl: settings.baseUrl?.trim() || undefined,
        managementApiKey: settings.managementApiKey?.trim() || undefined,
        nativeProtocols: usableNativeProtocols(settings.nativeProtocols),
        thinkingOverrides: usableThinkingOverrides(settings.thinkingOverrides, (message) => console.warn(message)),
    });
    return {
        name: "provider-bifrost",
        title: "Bifrost",
        providers: [{ provider: plugin.provider, readiness: plugin.readiness }],
        health: plugin.health,
    };
}
