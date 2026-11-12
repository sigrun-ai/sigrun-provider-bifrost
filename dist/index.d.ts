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
import { type Provider } from "@earendil-works/pi-ai/models";
import { type BifrostSettings, type NativeProtocols } from "./settings-schema.js";
import type { DeclaredSettings, SettingsDeclaration } from "@sigrun/sigrun/extension";
import { PROVIDER_DISPLAY_NAME, PROVIDER_ID, UNRESOLVED_BASE_URL, CHAIN_ID_PREFIX, type GatewayModel } from "./catalog.js";
export { PROVIDER_ID, PROVIDER_DISPLAY_NAME, UNRESOLVED_BASE_URL, CHAIN_ID_PREFIX };
export { BIFROST_BASE_URL_ENV, BIFROST_MANAGEMENT_API_KEY_ENV, BIFROST_SETTINGS_SCHEMA, THINKING_LEVELS, } from "./settings-schema.js";
export type { BifrostSettings, NativeProtocols, ThinkingLevelName } from "./settings-schema.js";
export type { GatewayModel, SurfaceApi, CatalogModel, Chain, RoutingRule } from "./catalog.js";
export { chainWireName, withWireNames } from "./wire.js";
/**
 * The secrets-store key this plugin's management credential lives under —
 * the bare property name, which is what core's encoding uses for a
 * TOP-LEVEL `writeOnly` setting (`src/settings/schema/secrets.ts`: "a
 * top-level secret keeps its bare name"). This is also the key the legacy
 * migration writes, so the value it moves is the one the checked read
 * fills back in.
 */
export declare const BIFROST_MANAGEMENT_API_KEY_SECRET = "managementApiKey";
/** Ambient fallback for the virtual key when auth.json holds no credential. */
export declare const BIFROST_API_KEY_ENV = "BIFROST_API_KEY";
/**
 * Structural slice of sigrun's seam host (src/harness/seam-host.ts) a
 * provider plugin may consume: the declared-settings handle (settings
 * rework) plus the scoped stores — the settings file `declare` reads and the
 * secrets section the legacy-key migration writes. `settings.declare`
 * returns the checked read (defaults applied, `writeOnly` values filled from
 * the secrets store) and is what makes this plugin's page a generated form.
 *
 * The slice is declared structurally (the factory cannot import sigrun's
 * runtime), while the two FUNCTION SHAPES it references are the host's own
 * published declaration types — `@sigrun/sigrun/extension` is type-only, so
 * nothing of core is bundled or loaded at runtime.
 */
export interface SigrunPluginHost {
    readonly settings: {
        declare<S = Record<string, unknown>, U = Record<string, unknown>>(declaration: SettingsDeclaration): DeclaredSettings<S, U>;
    };
    readonly stores: {
        /** This plugin's own `settings/<slug>.json`; absent file → `{}`. */
        readonly settings: {
            get(): Promise<Record<string, unknown>>;
            set(value: Record<string, unknown>): Promise<void>;
        };
        /** This plugin's section of `secrets.json`. */
        readonly secrets: {
            get(key: string): Promise<string | undefined>;
            set(key: string, value: string): Promise<void>;
            delete(key: string): Promise<void>;
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
    /** Display title (core 0.15.0's `SigrunExtensionResult.title`): trimmed
     * to 1..60 characters by the loader; never changes the slug. */
    readonly title: "Bifrost";
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
 * `BIFROST_BASE_URL` and `BIFROST_MANAGEMENT_API_KEY` resolve at
 * credential-resolution time through the env seam and fall below the baked
 * settings in precedence (a settings `managementApiKey` — secret store or a
 * legacy file value — outranks the ambient management key).
 */
export declare function createBifrostPlugin(options: BifrostPluginOptions): BifrostPlugin;
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
export declare function migrateLegacyManagementApiKey(stores: Pick<SigrunPluginHost, "stores">["stores"], stored: Record<string, unknown>): Promise<void>;
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
export declare function usableNativeProtocols(native: BifrostSettings["nativeProtocols"]): BifrostSettings["nativeProtocols"];
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
export declare function usableThinkingOverrides(ladders: BifrostSettings["thinkingOverrides"], warn: (message: string) => void): BifrostSettings["thinkingOverrides"];
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
export default function sigrunBifrost(host: SigrunPluginHost): Promise<ProviderPluginResult>;
