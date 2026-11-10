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
import { Type } from "typebox";
/**
 * Widen a TypeBox schema to the host's structural JSON-Schema contract
 * (`SettingsJsonSchema = Readonly<Record<string, unknown>>`): TypeBox's
 * TObject carries no string index signature, but every schema it builds
 * IS a plain JSON object. The `Static` type stays on the original.
 */
function asJsonSchema(schema) {
    return schema;
}
/** Every key is consumed when the provider is built (`restart`). */
const APPLY = "restart";
/** Ambient env key for the gateway URL (read through the env seam). */
export const BIFROST_BASE_URL_ENV = "BIFROST_BASE_URL";
/**
 * Ambient env fallback for the management credential (read through the env
 * seam). A deployment can inject it as an env var instead of storing the
 * secret; the declared settings value outranks it.
 */
export const BIFROST_MANAGEMENT_API_KEY_ENV = "BIFROST_MANAGEMENT_API_KEY";
/**
 * pi's thinking-level names, in ladder order — the set a member's override
 * may name and the ladder `catalog.ts` publishes when it names none.
 */
export const THINKING_LEVELS = [
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
];
/**
 * One exact-name list: bare model names that REPLACE the built-in family
 * heuristic for its surface. `minItems: 1` matters as much as the type: a
 * list whose entries were all repaired away is removed rather than left
 * empty, because `surfaceFor` reads an EMPTY list as "no model matches"
 * (every model loses that native wire) while an ABSENT list means "use the
 * heuristic".
 */
function modelNameList(title, description) {
    return Type.Optional(Type.Array(
    // The deleted parser trimmed each name before its non-empty test;
    // JSON Schema cannot trim, so `\S` is that same "not blank" test.
    Type.String({ minLength: 1, pattern: "\\S" }), { title, description, minItems: 1, "x-sigrun-apply": APPLY }));
}
/**
 * Native-protocol surface gates (client-side wire choice per model family).
 * Both toggles default false — every model publishes as chat completions,
 * the only wire every Bifrost serves. A toggle turns its surface on (the
 * built-in family heuristic); the paired exact-name list replaces that
 * heuristic for the surface.
 */
const NATIVE_PROTOCOLS_SCHEMA = Type.Optional(Type.Object({
    responses: Type.Boolean({
        title: "Responses surface",
        description: "Publish gpt-family models on the openai-responses wire (the gateway must serve /v1/responses).",
        default: false,
        "x-sigrun-apply": APPLY,
    }),
    messages: Type.Boolean({
        title: "Messages surface",
        description: "Publish claude-family models on the anthropic-messages wire, at the gateway's /anthropic route.",
        default: false,
        "x-sigrun-apply": APPLY,
    }),
    responsesModels: modelNameList("Responses model names", "Exact bare model names for the responses surface; when set, this list REPLACES the built-in gpt heuristic."),
    messagesModels: modelNameList("Messages model names", "Exact bare model names for the messages surface; when set, this list REPLACES the built-in claude heuristic."),
}, {
    title: "Native protocol surfaces",
    description: "Both off (the default) publishes chat completions everywhere — the only wire every gateway serves.",
    "x-sigrun-apply": APPLY,
}));
/**
 * Per-member thinking ladders, keyed by the upstream member id
 * ("provider/model"): a table whose rows are level-name lists.
 *
 * Rows are drawn as a list of level CHOICES, so the form cannot submit an
 * unknown level — but a hand-edited file can, and the deleted parser's rule
 * for that case was all-or-nothing: ONE unknown level and the whole entry is
 * ignored, so the member keeps its default ladder ("a ladder the author
 * didn't fully know must not be half-applied"). Core's checked read does not
 * enforce it, because this table's keys contain `/` (`provider/model`) and its
 * repair addresses each failing value by JSON pointer: `/thinkingOverrides/
 * acme/acme-pro/1` resolves to no such path, so the bad level survives the
 * check untouched (verified). `usableThinkingOverrides` in `src/index.ts` is
 * therefore the enforcement point.
 */
const THINKING_OVERRIDES_SCHEMA = Type.Optional(Type.Object({}, {
    title: "Thinking ladders",
    description: "Per-member level lists keyed by upstream member id (e.g. `acme/acme-pro`). A member listed here publishes exactly these levels instead of the full ladder; an entry naming an unknown level is ignored as a whole.",
    // The enum builds the form's per-row CHOICES and rejects an unknown
    // level at save. It is NOT the enforcement point for a hand-edited
    // file: see this property's own comment (a member id's `/` puts the
    // value out of the checked read's pointer-repair reach).
    additionalProperties: Type.Array(Type.String({ enum: [...THINKING_LEVELS] }), {
        minItems: 1,
        uniqueItems: true,
    }),
    "x-sigrun-apply": APPLY,
}));
export const BIFROST_SETTINGS_SCHEMA = asJsonSchema(Type.Object({
    publishChains: Type.Boolean({
        title: "Publish chain models",
        description: "Emit one chain/<name> model per Bifrost routing rule for this virtual key. Needs the management plane; a rule set with no usable chain fails discovery loudly.",
        default: false,
        "x-sigrun-apply": APPLY,
    }),
    publishUpstream: Type.Boolean({
        title: "Publish upstream models",
        description: "Emit every model from /v1/models as a directly selectable entry. With chains on, both surfaces publish.",
        default: true,
        "x-sigrun-apply": APPLY,
    }),
    baseUrl: Type.Optional(Type.String({
        title: "Gateway base URL",
        description: "The gateway's /v1 base URL. When set it outranks the ambient BIFROST_BASE_URL.",
        minLength: 1,
        pattern: "\\S",
        format: "uri",
        "x-sigrun-apply": APPLY,
    })),
    nativeProtocols: NATIVE_PROTOCOLS_SCHEMA,
    thinkingOverrides: THINKING_OVERRIDES_SCHEMA,
    managementApiKey: Type.Optional(Type.String({
        title: "Management API key",
        description: "Bearer for the management plane (/api/governance/virtual-keys, /api/routing/rules). Unset means the virtual key serves the management plane too. Kept in the secrets store, never in settings/provider-bifrost.json.",
        // No minLength/pattern: core fills an ABSENT secret with ""
        // before validating, so any shape constraint would report a
        // repair (and log a boot-time warning) on EVERY boot of an
        // install that never set one. "" is this key's own "unset" —
        // exactly what an untouched secret field submits on save — and
        // the factory maps it to undefined.
        writeOnly: true,
        "x-sigrun-apply": APPLY,
    })),
}));
