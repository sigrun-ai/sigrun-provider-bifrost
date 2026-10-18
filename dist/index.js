/**
 * sigrun-bifrost — the big port (provider plugins Task 10):
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
 *   (`settings/sigrun-bifrost.json`), read ONCE at factory time —
 *   restart-required (sigrun's loader pre-keys the factory host on the
 *   provisional slug so the factory-time read resolves this package's
 *   file). No /login flow; no pi config file.
 * - CREDENTIALS: the VK comes from sigrun's auth.json bridge (the stored
 *   credential arrives as `credential` on the auth resolver) with
 *   `BIFROST_API_KEY` as the ambient fallback; the ambient base URL
 *   (`BIFROST_BASE_URL`) resolves through the same env seam. The plugin
 *   never reads auth.json or `process.env` itself.
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
import { BIFROST_BASE_URL_ENV, parseBifrostSettings, } from "./config.js";
import { PROVIDER_DISPLAY_NAME, PROVIDER_ID, UNRESOLVED_BASE_URL, buildAllModels, wireCatalog, wireDiscovery, wireRulesToChains, wireScopeId, } from "./catalog.js";
// Re-exported gateway constants (the pi port's src/bifrost.ts surface):
// the provider id is part of this plugin's public contract — sigrun's
// auth-check names providers by id and tests pin the model stamp to it.
export { PROVIDER_ID, PROVIDER_DISPLAY_NAME, UNRESOLVED_BASE_URL };
// Re-exported discovery/config types so consumers (and tests) need no
// deep imports.
export { parseBifrostSettings, BIFROST_BASE_URL_ENV } from "./config.js";
/** Ambient fallback for the virtual key when auth.json holds no credential. */
export const BIFROST_API_KEY_ENV = "BIFROST_API_KEY";
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
        throw new Error("sigrun-bifrost: the gateway is not configured " +
            `(need a virtual key (auth.json or ${BIFROST_API_KEY_ENV}) and a base URL ` +
            `(settings baseUrl or ${BIFROST_BASE_URL_ENV})); refusing to publish an empty catalog`);
    }
    if (options.publishChains) {
        const managementToken = options.managementApiKey ?? token;
        const scopeId = await wireScopeId(managementToken, token, baseUrl, signal);
        if (!scopeId) {
            throw new Error("sigrun-bifrost: credential does not match any virtual key in /api/governance/virtual-keys");
        }
        const { catalog, rules } = await wireDiscovery(managementToken, token, baseUrl, scopeId, signal);
        const chains = wireRulesToChains(rules);
        if (chains.length === 0) {
            throw new Error(`sigrun-bifrost: no chain routing rules found for ${scopeId} — is chains-first routing configured for this VK?`);
        }
        const models = buildAllModels(chains, catalog, PROVIDER_ID, baseUrl, true, options.publishUpstream, options.thinkingOverrides, options.nativeProtocols);
        if (models.length === 0) {
            throw new Error("sigrun-bifrost: chains discovery produced no models; refusing to publish an empty catalog");
        }
        return models;
    }
    // Member-only mode: inference plane only, ZERO management calls.
    if (!options.publishUpstream) {
        throw new Error("sigrun-bifrost: publishChains and publishUpstream are both false — nothing to publish");
    }
    const catalog = await wireCatalog(token, baseUrl, signal);
    const models = buildAllModels([], catalog, PROVIDER_ID, baseUrl, false, true, options.thinkingOverrides, options.nativeProtocols);
    if (models.length === 0) {
        throw new Error("sigrun-bifrost: /v1/models returned no usable entries; refusing to publish an empty catalog");
    }
    return models;
}
/**
 * Build the Bifrost provider plus its readiness/health trackers.
 * `options` are the FACTORY-BAKED settings (restart-required); the ambient
 * `BIFROST_BASE_URL` resolves at credential-resolution time through the
 * env seam and falls below the baked `baseUrl` in precedence.
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
    // The ambient base URL, captured at credential resolution (the only
    // place the env seam is available); the baked settings URL outranks it.
    let ambientBaseUrl;
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
        console.warn(`sigrun-bifrost: bifrost ${lastAnnounced ?? "startup"} → ${next}` +
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
            "openai-completions": openAICompletionsApi(),
            "openai-responses": openAIResponsesApi(),
            "anthropic-messages": anthropicMessagesApi(),
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
            try {
                const models = await discoverModels(key, url, options, context.signal);
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
 * The sigrun extension-package factory (provider-only contributor).
 * Arity 1 declares the host-taking signature — sigrun's loader passes the
 * seam host only to factories that declare one (`factory.length > 0`) —
 * and the factory is ASYNC because the scoped settings store is
 * async-only; sigrun's loader awaits factory results.
 *
 * Settings are read ONCE here and BAKED into the provider (the
 * restart-required semantics: the loader pre-keys the host on the
 * provisional slug — this package's manifest name — so the factory-time
 * read resolves `settings/sigrun-bifrost.json`). Parse issues log via
 * `console.warn` and never quarantine (a wrong-typed key falls back to
 * its default, exactly like the pi port's issue list).
 */
export default async function sigrunBifrost(host) {
    const raw = await host.stores.settings.get();
    const issues = [];
    const settings = parseBifrostSettings(raw, issues);
    for (const issue of issues) {
        console.warn(`sigrun-bifrost: settings/sigrun-bifrost.json: ${issue}`);
    }
    const plugin = createBifrostPlugin({
        publishChains: settings.publishChains,
        publishUpstream: settings.publishUpstream,
        baseUrl: settings.baseUrl,
        managementApiKey: settings.managementApiKey,
        nativeProtocols: settings.nativeProtocols,
        thinkingOverrides: settings.thinkingOverrides,
    });
    return {
        name: "sigrun-bifrost",
        providers: [{ provider: plugin.provider, readiness: plugin.readiness }],
        health: plugin.health,
    };
}
