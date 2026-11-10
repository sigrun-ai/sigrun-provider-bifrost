/**
 * @sigrun/provider-bifrost's declared settings (settings rework, Task 8):
 * the whole scoped surface — the two publish flags, the gateway URL, the
 * native-protocol gates, the per-member thinking ladders and the
 * management credential — as one JSON Schema, declared through
 * `host.settings.declare`. Core draws the settings page's form from it,
 * applies the defaults and repairs a malformed stored value back to its
 * default; the per-key issues the deleted `parseBifrostSettings` collected
 * are now core's load-time warning.
 *
 * Every key is `restart` (`x-sigrun-apply`): the factory reads this surface
 * ONCE and bakes it into the provider (both publish modes, the base URL,
 * the native surfaces, the thinking ladders and the management credential
 * all reach the model builders at discovery time), so an edited value lands
 * at the next boot — the contract the port already documents.
 *
 * THE MANAGEMENT KEY IS A SECRET (`writeOnly`). Core keeps its value in
 * this extension's section of `secrets.json` under the bare property name
 * (`src/settings/schema/secrets.ts`: "a top-level secret keeps its bare
 * name") and never writes it back to `settings/provider-bifrost.json`; the
 * checked read hands the value to the factory and the settings page shows
 * it as a credential. A settings file that still carries one from before
 * the rework is handed to the factory too (a legacy fallback), and the
 * factory moves it into the secrets store and strips it from the file — see
 * `migrateLegacyManagementApiKey` in `src/index.ts` for why that move
 * cannot be left to the save path.
 */
import { Type, type Static } from "typebox";
/** Ambient env key for the gateway URL (read through the env seam). */
export declare const BIFROST_BASE_URL_ENV = "BIFROST_BASE_URL";
/**
 * Ambient env fallback for the management credential (read through the env
 * seam). A deployment can inject it as an env var instead of storing the
 * secret; the declared settings value outranks it.
 */
export declare const BIFROST_MANAGEMENT_API_KEY_ENV = "BIFROST_MANAGEMENT_API_KEY";
/**
 * pi's thinking-level names, in ladder order — the set a member's override
 * may name and the ladder `catalog.ts` publishes when it names none.
 */
export declare const THINKING_LEVELS: readonly ["minimal", "low", "medium", "high", "xhigh", "max"];
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];
export declare const BIFROST_SETTINGS_SCHEMA: Type.TObject<{
    publishChains: Type.TBoolean;
    publishUpstream: Type.TBoolean;
    baseUrl: Type.TOptional<Type.TString>;
    nativeProtocols: Type.TOptional<Type.TObject<{
        responses: Type.TBoolean;
        messages: Type.TBoolean;
        responsesModels: Type.TOptional<Type.TArray<Type.TString>>;
        messagesModels: Type.TOptional<Type.TArray<Type.TString>>;
    }>>;
    thinkingOverrides: Type.TOptional<Type.TObject<{}>>;
    managementApiKey: Type.TOptional<Type.TString>;
}> & Readonly<Record<string, unknown>>;
/** The schema's static type, with the one place it needs help. */
export type BifrostSettings = Omit<Static<typeof BIFROST_SETTINGS_SCHEMA>, "thinkingOverrides"> & {
    /**
     * TypeBox's `Static` gives `{}` for an object whose only value schema is
     * `additionalProperties` (no index signature), while the stored shape is
     * a name → ladder map. This restates it; the JSON Schema above is the
     * authority on validity.
     */
    thinkingOverrides?: Record<string, string[]>;
};
/** The native-surface selection as the catalog builders consume it. */
export type NativeProtocols = NonNullable<BifrostSettings["nativeProtocols"]>;
