/**
 * Plugin configuration (ported from pi-bifrost-gateway 0.3.0 @ 5d15a28,
 * `src/config.ts`): the SAME key surface, but sourced from the plugin's
 * SCOPED SETTINGS (`settings/provider-bifrost.json` in the sigrun config
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
	/** Emit chain models (chain/<name>) from the VK's routing rules. */
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
export const BIFROST_BASE_URL_ENV = "BIFROST_BASE_URL";

const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

const VALID_LEVELS: ReadonlySet<string> = new Set<string>(THINKING_LEVELS);

function parseThinkingOverrides(
	raw: unknown,
	issues: string[],
): Record<string, string[]> | undefined {
	if (raw === undefined) return undefined;
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		issues.push("thinkingOverrides must be an object of member-id → allowed levels; ignoring");
		return undefined;
	}
	const overrides: Record<string, string[]> = {};
	for (const [memberId, levels] of Object.entries(raw as Record<string, unknown>)) {
		if (!Array.isArray(levels)) {
			issues.push(`thinkingOverrides["${memberId}"] must be an array of level strings; ignoring`);
			continue;
		}
		const valid = levels.filter((l): l is string => typeof l === "string" && VALID_LEVELS.has(l));
		if (valid.length !== levels.length) {
			// A ladder the author didn't fully know must not be half-applied:
			// the member keeps the full-map default until the override is
			// corrected.
			issues.push(`thinkingOverrides["${memberId}"] contains unknown level names; entry ignored`);
			continue;
		}
		if (valid.length > 0) overrides[memberId] = valid;
	}
	return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function parseNativeProtocols(raw: unknown, issues: string[]): NativeProtocols | undefined {
	if (raw === undefined) return undefined;
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		issues.push("nativeProtocols must be an object; ignoring");
		return undefined;
	}
	const obj = raw as Record<string, unknown>;
	const out: NativeProtocols = { responses: false, messages: false };
	let seen = false;
	for (const [key, value] of Object.entries(obj)) {
		switch (key) {
			case "responses":
			case "messages":
				if (typeof value === "boolean") {
					out[key] = value;
					seen = true;
				} else {
					issues.push(`nativeProtocols.${key} must be a boolean (got ${typeof value}); ignoring`);
				}
				break;
			case "responsesModels":
			case "messagesModels": {
				if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.trim().length > 0)) {
					issues.push(`nativeProtocols.${key} must be an array of non-empty model names; ignoring`);
					break;
				}
				const names = (value as string[]).map((v) => v.trim());
				if (new Set(names).size !== names.length) {
					issues.push(`nativeProtocols.${key} contains duplicates; ignoring the list`);
					break;
				}
				out[key] = names;
				seen = true;
				break;
			}
			default:
				issues.push(`unknown nativeProtocols key "${key}"`);
				break;
		}
	}
	return seen ? out : undefined;
}

/**
 * Parse the plugin's scoped-settings object. Missing settings = defaults;
 * unknown keys and wrong-typed values collect issues the caller logs but
 * that are never fatal.
 *
 * Defaults: publishChains FALSE, publishUpstream TRUE (see the module
 * comment — pi 0.3.0 parity on both).
 */
export function parseBifrostSettings(
	raw: unknown,
	issues: string[],
): BifrostSettings {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		// An absent settings file reads as {} (the store's contract), so a
		// non-object here means a malformed file — defaults + issue.
		issues.push("settings must be a JSON object; using defaults");
		return { publishChains: false, publishUpstream: true };
	}

	const obj = raw as Record<string, unknown>;
	let publishChains = false;
	let publishUpstream: boolean | undefined;
	let baseUrl: string | undefined;
	let thinkingOverrides: Record<string, string[]> | undefined;
	let managementApiKey: string | undefined;
	let nativeProtocols: NativeProtocols | undefined;

	for (const [key, value] of Object.entries(obj)) {
		switch (key) {
			case "publishChains":
				if (typeof value === "boolean") publishChains = value;
				else issues.push(`publishChains must be a boolean (got ${typeof value}); using false`);
				break;
			case "publishUpstream":
				if (typeof value === "boolean") publishUpstream = value;
				else issues.push(`publishUpstream must be a boolean (got ${typeof value}); ignoring`);
				break;
			case "baseUrl":
				if (typeof value === "string" && value.trim().length > 0) baseUrl = value.trim();
				else issues.push(`baseUrl must be a non-empty string (got ${typeof value}); ignoring`);
				break;
			case "thinkingOverrides":
				thinkingOverrides = parseThinkingOverrides(value, issues);
				break;
			case "managementApiKey":
				if (typeof value === "string" && value.trim().length > 0) managementApiKey = value.trim();
				else issues.push(`managementApiKey must be a non-empty string (got ${typeof value}); ignoring`);
				break;
			case "nativeProtocols":
				nativeProtocols = parseNativeProtocols(value, issues);
				break;
			default:
				issues.push(`unknown settings key "${key}"`);
				break;
		}
	}

	return {
		publishChains,
		publishUpstream: publishUpstream ?? true,
		baseUrl,
		thinkingOverrides,
		managementApiKey,
		nativeProtocols,
	};
}
