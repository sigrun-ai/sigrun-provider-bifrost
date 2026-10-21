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
 *   (`settings/provider-bifrost.json`), read ONCE at factory time —
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
import { type Provider } from "@earendil-works/pi-ai/models";
import { type NativeProtocols } from "./config.js";
import { PROVIDER_DISPLAY_NAME, PROVIDER_ID, UNRESOLVED_BASE_URL, type GatewayModel } from "./catalog.js";
export { PROVIDER_ID, PROVIDER_DISPLAY_NAME, UNRESOLVED_BASE_URL };
export { parseBifrostSettings, BIFROST_BASE_URL_ENV } from "./config.js";
export type { BifrostSettings, NativeProtocols } from "./config.js";
export type { GatewayModel, SurfaceApi, CatalogModel, Chain, RoutingRule } from "./catalog.js";
/** Ambient fallback for the virtual key when auth.json holds no credential. */
export declare const BIFROST_API_KEY_ENV = "BIFROST_API_KEY";
/**
 * Structural slice of sigrun's seam host (src/harness/seam-host.ts) a
 * provider plugin may consume. Declared here — structurally, like the
 * bridge's pi-ai re-declarations — because the plugin cannot import
 * sigrun core. The scoped settings store is async-only, which is why the
 * loader awaits factory results (and why this plugin's factory is async).
 */
export interface SigrunPluginHost {
    readonly stores: {
        /** This plugin's own `settings/<slug>.json`; absent file → `{}`. */
        readonly settings: {
            get(): Promise<Record<string, unknown>>;
            set(value: Record<string, unknown>): Promise<void>;
        };
    };
}
/** Sigrun's three-state per-provider readiness vocabulary (Task 6). */
export type ProviderReadinessStatus = "not_configured" | "degraded" | "ready";
/** One tracker report: the status plus optional operator-facing detail. */
export interface ProviderReadiness {
    readonly status: ProviderReadinessStatus;
    readonly detail?: string;
}
/** Sigrun's §3 health vocabulary. */
export type HealthStatus = "ok" | "degraded";
/**
 * The provider-plugin factory result (the loader's Task 1 contract):
 * a provider-only contributor — `{ name, providers, health? }`, no
 * `extension`. Structural, like the host slice above.
 */
export interface ProviderPluginResult {
    readonly name: string;
    readonly providers: readonly {
        readonly provider: Provider;
        readonly readiness?: () => ProviderReadiness;
    }[];
    readonly health?: () => HealthStatus;
}
/** The options `createBifrostPlugin` bakes from factory-time settings. */
export interface BifrostPluginOptions {
    publishChains: boolean;
    publishUpstream: boolean;
    /** Settings-pinned base URL; ambient env fallback applies when absent. */
    baseUrl?: string;
    managementApiKey?: string;
    nativeProtocols?: NativeProtocols;
    thinkingOverrides?: Record<string, string[]>;
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
export declare function discoverModels(token: string | undefined, baseUrl: string | undefined, options: BifrostPluginOptions, signal?: AbortSignal): Promise<GatewayModel[]>;
/** One built plugin: the contribution's parts, sharing the tracker closure. */
export interface BifrostPlugin {
    readonly provider: Provider;
    /** Synchronous read over plugin-owned state (never network/storage). */
    readonly readiness: () => ProviderReadiness;
    readonly health: () => HealthStatus;
}
/**
 * Build the Bifrost provider plus its readiness/health trackers.
 * `options` are the FACTORY-BAKED settings (restart-required); the ambient
 * `BIFROST_BASE_URL` resolves at credential-resolution time through the
 * env seam and falls below the baked `baseUrl` in precedence.
 */
export declare function createBifrostPlugin(options: BifrostPluginOptions): BifrostPlugin;
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
 * read resolves `settings/provider-bifrost.json`). Parse issues log via
 * `console.warn` and never quarantine (a wrong-typed key falls back to
 * its default, exactly like the pi port's issue list).
 */
export default function sigrunBifrost(host: SigrunPluginHost): Promise<ProviderPluginResult>;
