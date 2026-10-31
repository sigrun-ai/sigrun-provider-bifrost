/**
 * Pure catalog tests (ported from pi-bifrost-gateway 0.3.0 @ 5d15a28,
 * `test/catalog.test.ts`): chain decoding, native-family surfaces, the
 * TEXT_ONLY denylist, thinking ladders, and the builder composition. No
 * HTTP here — the wire-fetching halves live in bifrost.test.ts; model ids
 * are synthetic (the repo convention: tests own their literals).
 */

import { describe, expect, it } from "vitest";
import {
	wireCatalogToModels,
	wireRulesToChains,
	buildChainModels,
	buildMemberModels,
	buildAllModels,
	nativeFamily,
	surfaceFor,
	managementBase,
	perMtok,
	chainNameFromCel,
	CHAIN_ID_PREFIX,
	collidingMemberIds,
} from "../src/catalog.js";
import type { CatalogModel, RoutingRule } from "../src/catalog.js";

const GATEWAY_ID = "bifrost";

/* ---------- fixtures ---------- */

function memberModel(
	id: string,
	overrides: Partial<CatalogModel> = {},
): CatalogModel {
	return {
		id,
		owned_by: id.split("/")[0] ?? "",
		context_length: 1_000_000,
		pricing: { prompt: "0.0000001000", completion: "0.0000005000" },
		...overrides,
	};
}

function chainRule(name: string, target: string, fallbacks: string[], cel?: string): RoutingRule {
	return {
		id: `vk-test-chain-${name}`,
		name: `Chain: ${name}`,
		enabled: true,
		cel_expression: cel ?? `model == "${name}" || model == "bifrost/${name}"`,
		targets: [(() => {
			const [first, rest] = [target.split("/")[0] ?? "", target.split("/").slice(1).join("/")];
			return rest.length > 0
				? { provider: first, model: rest, weight: 1 }
				: { provider: "", model: target, weight: 1 };
		})()],
		fallbacks,
		scope: "virtual_key",
		scope_id: "vk-test",
		priority: 0,
	};
}

const BASE_URL = "https://gw.example.com/v1";

describe("wireCatalogToModels", () => {
	it("parses an OpenAI-shaped /v1/models envelope", () => {
		const envelope = {
			object: "list",
			data: [memberModel("acme/acme-mini"), memberModel("acme/acme-large")],
		};
		const models = wireCatalogToModels(envelope);
		expect(models).toHaveLength(2);
		expect(models[0]?.id).toBe("acme/acme-mini");
	});

	it("tolerates missing pricing and empty fallback data", () => {
		const envelope = { data: [{ id: "x/y", context_length: 8192 }] };
		expect(wireCatalogToModels(envelope)).toHaveLength(1);
	});
});

describe("wireRulesToChains", () => {
	it("extracts chain name from cel model == expression and skips non-chain rules", () => {
		const rules: RoutingRule[] = [
			chainRule("acme-flash", "acme/acme-flash", ["acme2/acme-flash"]),
			{
				...chainRule("other", "acme/x", []),
				cel_expression: 'model.startsWith("x")',
			},
		];
		const chains = wireRulesToChains(rules);
		expect(chains).toHaveLength(1);
		expect(chains[0]?.name).toBe("acme-flash");
		expect(chains[0]?.primary).toBe("acme/acme-flash");
		expect(chains[0]?.fallbacks).toEqual(["acme2/acme-flash"]);
	});

	it("skips disabled rules and multi-model targets (ambiguous)", () => {
		const rules: RoutingRule[] = [
			{ ...chainRule("a", "p/m1", []), enabled: false },
			{
				...chainRule("b", "p/m", []),
				targets: [
					{ provider: "p", model: "m1", weight: 0.5 },
					{ provider: "p", model: "m2", weight: 0.5 },
				],
			},
		];
		expect(wireRulesToChains(rules)).toHaveLength(0);
	});

	it("skips rules whose cel has no model == form (expression rules are not chains)", () => {
		const rules = [chainRule("acme-pro", "acme/acme-pro", [], 'provider == "other"*')];
		expect(wireRulesToChains(rules)).toHaveLength(0);
	});

	it("orders chains by rule priority", () => {
		const rules = [
			{ ...chainRule("low-prio", "p/a", []), priority: 20 },
			{ ...chainRule("high-prio", "p/b", []), priority: 1 },
		];
		const chains = wireRulesToChains(rules);
		expect(chains.map((c) => c.name)).toEqual(["high-prio", "low-prio"]);
	});
});

describe("chain id prefixes", () => {
	it("accepts a 3-arm cel (bare, gateway/, bifrost/) and strips managed prefixes", () => {
		const rules = [
			chainRule("acme-flash", "acme/acme-flash", [], 'model == "acme-flash" || model == "gateway/acme-flash" || model == "bifrost/acme-flash"'),
		];
		const chains = wireRulesToChains(rules);
		expect(chains).toHaveLength(1);
		expect(chains[0]?.name).toBe("acme-flash");
	});

	it("canonicalizes the sigrun display prefix to the gateway's bare chain name", () => {
		const rules = [chainRule("x", "acme/x", [], 'model == "chain/x" || model == "x"')];
		expect(wireRulesToChains(rules).map((chain) => chain.name)).toEqual(["x"]);
	});

	it("rejects cels with 2 model == arms that do not share one bare name", () => {
		const rules = [
			chainRule("weird", "acme/x", [], 'model == "acme-flash" || model == "acme-pro"'),
		];
		expect(wireRulesToChains(rules)).toHaveLength(0);
	});

	it("chainNameFromCel requires at least two model == arms", () => {
		expect(chainNameFromCel('model == "only-one"')).toBeUndefined();
		expect(chainNameFromCel("anything else")).toBeUndefined();
	});
});

describe("buildChainModels", () => {
	it("uses the chain/ display id while retaining the bare wire name", () => {
		const [model] = buildChainModels(
			[{ name: "glm-5.3-flash", primary: "acme/glm-5.3-flash", fallbacks: [] }],
			[],
			GATEWAY_ID,
			BASE_URL,
		);
		expect(model?.id).toBe("chain/glm-5.3-flash");
		expect(model?.name).toBe("glm-5.3-flash");
	});

	it("builds chain/<chain> display ids stamped provider bifrost, min context window, zero cost", () => {
		const catalog = [
			memberModel("acme/acme-flash", { context_length: 1_000_000 }),
			memberModel("acme2/acme-flash", { context_length: 500_000 }),
		];
		const chains = [{ name: "acme-flash", primary: "acme/acme-flash", fallbacks: ["acme2/acme-flash"] }];
		const models = buildChainModels(chains, catalog, GATEWAY_ID, BASE_URL);
		expect(models).toHaveLength(1);
		const m = models[0]!;
		expect(m.id).toBe(`${CHAIN_ID_PREFIX}acme-flash`);
		expect(m.name).toBe("acme-flash");
		// THE stamp — pi-ai's restore path drops stored models whose
		// provider field differs from the registered id.
		expect(m.provider).toBe(GATEWAY_ID);
		expect(m.baseUrl).toBe(BASE_URL);
		expect(m.contextWindow).toBe(500_000);
		expect(m.cost.input).toBe(0);
		expect(m.cost.output).toBe(0);
		expect(m.reasoning).toBe(true);
		// Input modalities: image is declared so pi-ai forwards tool-result
		// images instead of silently replacing them (the worse-error rule).
		expect(m.input).toEqual(["text", "image"]);
	});

	it("uses a fallback context window when no member has one", () => {
		const models = buildChainModels(
			[{ name: "chain-x", primary: "p/mx", fallbacks: [] }],
			[],
			GATEWAY_ID,
			BASE_URL,
		);
		expect(models[0]?.contextWindow).toBe(128_000);
	});

	it("a member missing from the catalog keeps the chain viable with defaults", () => {
		const models = buildChainModels(
			[{ name: "acme-flash", primary: "acme/acme-flash", fallbacks: [] }],
			[],
			GATEWAY_ID,
			BASE_URL,
		);
		expect(models[0]?.id).toBe("chain/acme-flash");
		expect(models[0]?.contextWindow).toBe(128_000);
	});
});

describe("the TEXT_ONLY denylist", () => {
	it("publishes text-only for the glm-5.3 chain; vision-capable flash sibling does not inherit", () => {
		const models = buildChainModels(
			[{ name: "glm-5.3", primary: "acme/glm-5.3", fallbacks: [] }],
			[],
			GATEWAY_ID,
			BASE_URL,
		);
		expect(models[0]?.input).toEqual(["text"]);
		// Sibling sweep guard: glm-5.3-flash is vision-capable first-party and
		// must NOT inherit the bare glm-5.3 denial (exact-name matching).
		const flash = buildChainModels(
			[{ name: "glm-5.3-flash", primary: "acme/glm-5.3-flash", fallbacks: [] }],
			[],
			GATEWAY_ID,
			BASE_URL,
		);
		expect(flash[0]?.input).toEqual(["text", "image"]);
	});

	it("publishes text-only for deepseek-v4-flash and deepseek-v4-pro (with snapshot ids), image for v4.1", () => {
		for (const name of ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-0731", "deepseek-v4-pro-0813"]) {
			const models = buildChainModels([{ name, primary: `acme/${name}`, fallbacks: [] }], [], GATEWAY_ID, BASE_URL);
			expect(models[0]?.input, name).toEqual(["text"]);
		}
		// deepseek-v4.1-flash is vision-capable — the version-suffix denial
		// must not bleed into the .1 generation.
		const v41 = buildChainModels(
			[{ name: "deepseek-v4.1-flash", primary: "acme/deepseek-v4.1-flash", fallbacks: [] }],
			[],
			GATEWAY_ID,
			BASE_URL,
		);
		expect(v41[0]?.input).toEqual(["text", "image"]);
	});

	it("applies the denylist to member models by bare name after managed-prefix strip", () => {
		const catalog = [
			memberModel("acme/glm-5.3"),
			memberModel("acme/glm-5.3-flash"),
			memberModel("acme2/deepseek-v4-pro-0813"),
		];
		const chains = [{ name: "glm-5.3-flash", primary: "acme/glm-5.3-flash", fallbacks: [] }];
		const models = buildMemberModels(chains, catalog, GATEWAY_ID, BASE_URL);
		const byId = new Map(models.map((m) => [m.id, m] as const));
		expect(byId.get("acme/glm-5.3")?.input).toEqual(["text"]);
		expect(byId.get("acme/glm-5.3-flash")?.input).toEqual(["text", "image"]);
		expect(byId.get("acme2/deepseek-v4-pro-0813")?.input).toEqual(["text"]);
	});

	it("fresh modality arrays per model — no shared-mutable aliasing", () => {
		const catalog = [memberModel("acme/acme-flash", { context_length: 200_000 })];
		const models = buildMemberModels([], catalog, GATEWAY_ID, BASE_URL);
		const more = buildChainModels(
			[{ name: "other", primary: "p/other", fallbacks: [] }],
			catalog,
			GATEWAY_ID,
			BASE_URL,
		);
		expect(models[0]?.input).toEqual(["text", "image"]);
		expect(more[0]?.input).toEqual(["text", "image"]);
		expect(more[0]!.input).not.toBe(models[0]!.input);
	});
});

describe("buildMemberModels", () => {
	it("skips /v1/models entries in the reserved chain/ display namespace", () => {
		const catalog = [memberModel("chain/foo"), memberModel("acme/acme-flash")];
		expect(collidingMemberIds(catalog)).toEqual(["chain/foo"]);
		expect(buildMemberModels([], catalog, GATEWAY_ID, BASE_URL).map((model) => model.id)).toEqual([
			"acme/acme-flash",
		]);
	});

	it("publishes one entry per unique member with real rates from the catalog", () => {
		const catalog = [
			memberModel("acme/acme-flash", { pricing: { prompt: "0.0000001633", completion: "0.0000005444" } }),
			memberModel("acme2/acme-flash"),
		];
		const chains = [
			{ name: "acme-flash", primary: "acme/acme-flash", fallbacks: ["acme2/acme-flash"] },
		];
		const models = buildMemberModels(chains, catalog, GATEWAY_ID, BASE_URL);
		expect(models).toHaveLength(2);
		const acme = models.find((m) => m.id === "acme/acme-flash");
		expect(acme?.cost.input).toBeCloseTo(0.1633, 4);
		expect(acme?.cost.output).toBeCloseTo(0.5444, 4);
	});

	it("carries wire cache rates when the gateway reports them; honest-zero otherwise", () => {
		const withCache = buildMemberModels(
			[],
			[
				memberModel("acme/acme-flash", {
					pricing: {
						prompt: "0.0000001000",
						completion: "0.0000005000",
						input_cache_read: "0.0000000100",
						input_cache_write: "0.0000001250",
					},
				}),
			],
			GATEWAY_ID,
			BASE_URL,
		);
		expect(withCache[0]?.cost.cacheRead).toBeCloseTo(0.01, 4);
		expect(withCache[0]?.cost.cacheWrite).toBeCloseTo(0.125, 4);
		const without = buildMemberModels([], [memberModel("acme/acme-flash")], GATEWAY_ID, BASE_URL);
		expect(without[0]?.cost.cacheRead).toBe(0);
		expect(without[0]?.cost.cacheWrite).toBe(0);
	});

	it("is empty with no chains and no catalog", () => {
		expect(buildMemberModels([], [], GATEWAY_ID, BASE_URL)).toEqual([]);
	});

	it("ships the override ladder when settings declare one for a member", () => {
		const catalog = [memberModel("acme/acme-pro")];
		const models = buildMemberModels([], catalog, GATEWAY_ID, BASE_URL, { "acme/acme-pro": ["low", "high"] });
		expect(models[0]?.thinkingLevelMap).toEqual({ off: "off", low: "low", high: "high" });
	});

	it("ships the full ladder when no override is declared", () => {
		const catalog = [memberModel("acme/acme-pro")];
		const models = buildMemberModels([], catalog, GATEWAY_ID, BASE_URL);
		expect(Object.keys(models[0]?.thinkingLevelMap ?? {})).toContain("xhigh");
	});

	it("chains always carry the full ladder even when overrides exist for members", () => {
		const catalog = [memberModel("acme/acme-pro")];
		const chains = [{ name: "acme-pro", primary: "acme/acme-pro", fallbacks: [] }];
		const models = buildChainModels(chains, catalog, GATEWAY_ID, BASE_URL);
		expect(Object.keys(models[0]?.thinkingLevelMap ?? {})).toContain("xhigh");
	});
});

describe("buildAllModels", () => {
	it("chains first, then members, deduped, every entry stamped provider bifrost", () => {
		const catalog = [memberModel("acme/acme-flash")];
		const chains = [{ name: "acme-flash", primary: "acme/acme-flash", fallbacks: [] }];
		const all = buildAllModels(chains, catalog, GATEWAY_ID, BASE_URL, true, false);
		expect(all.map((m) => m.id)).toEqual(["chain/acme-flash"]);

		const allWithMembers = buildAllModels(chains, catalog, GATEWAY_ID, BASE_URL, true, true);
		expect(allWithMembers.map((m) => m.id)).toEqual(["chain/acme-flash", "acme/acme-flash"]);
		for (const model of allWithMembers) {
			expect(model.provider).toBe(GATEWAY_ID);
		}
	});
});

describe("nativeFamily (model NAME decides, never the serving prefix)", () => {
	it("classifies by NAME not prefix", () => {
		expect(nativeFamily("kiro/claude-sonnet-5-5")).toBe("anthropic");
		expect(nativeFamily("kiro/gpt-5.6-luna")).toBe("openai");
		expect(nativeFamily("cc/claude-opus-5-5")).toBe("anthropic");
		expect(nativeFamily("glm-5.3-flash")).toBe("other");
		expect(nativeFamily("gpt-oss-120b")).toBe("other");
		expect(nativeFamily("o3-mini")).toBe("openai");
		expect(nativeFamily("codex-max")).toBe("openai");
	});
});

describe("surfaceFor (the nativeFamily mapping table)", () => {
	it("claude → anthropic-messages at <gateway-root>/anthropic", () => {
		const surface = surfaceFor("claude-sonnet-5-5", BASE_URL, { responses: true, messages: true });
		expect(surface.api).toBe("anthropic-messages");
		// The Anthropic SDK appends /v1/messages itself — baseUrl must be the
		// gateway root + the integration prefix, never the /v1 base.
		expect(surface.baseUrl).toBe("https://gw.example.com/anthropic");
	});

	it("gpt → openai-responses on the /v1 base; gpt-oss stays completions; else completions", () => {
		const on = { responses: true, messages: true };
		expect(surfaceFor("gpt-6-luna", BASE_URL, on)).toEqual({ api: "openai-responses", baseUrl: BASE_URL });
		expect(surfaceFor("gpt-oss-120b", BASE_URL, on).api).toBe("openai-completions");
		expect(surfaceFor("glm-5.3-flash", BASE_URL, on)).toEqual({ api: "openai-completions", baseUrl: BASE_URL });
	});

	it("both toggles off (default): chat completions everywhere", () => {
		expect(surfaceFor("claude-sonnet-5-5", BASE_URL).api).toBe("openai-completions");
		expect(surfaceFor("gpt-6-luna", BASE_URL).api).toBe("openai-completions");
		expect(surfaceFor("claude-sonnet-5-5", BASE_URL, { responses: false, messages: false }).api).toBe("openai-completions");
	});

	it("one toggle on does not leak the other surface", () => {
		expect(surfaceFor("claude-sonnet-5-5", BASE_URL, { responses: true, messages: false }).api).toBe("openai-completions");
		expect(surfaceFor("gpt-6-luna", BASE_URL, { responses: false, messages: true }).api).toBe("openai-completions");
	});

	it("exact-name lists REPLACE the built-in heuristic for that surface", () => {
		const native = {
			responses: true,
			messages: true,
			// only this exact name gets the native wire — the claude-* heuristic is disabled
			messagesModels: ["my-custom-claude-host"],
			responsesModels: ["gpt-6-luna"],
		};
		expect(surfaceFor("my-custom-claude-host", BASE_URL, native).api).toBe("anthropic-messages");
		// heuristic-only names no longer match
		expect(surfaceFor("claude-sonnet-5-5", BASE_URL, native).api).toBe("openai-completions");
		// gpt-6-luna matches the list; gpt-6-astra (heuristic-only) does not
		expect(surfaceFor("gpt-6-luna", BASE_URL, native).api).toBe("openai-responses");
		expect(surfaceFor("gpt-6-astra", BASE_URL, native).api).toBe("openai-completions");
	});

	it("strips /v1 from the gateway root for the anthropic surface", () => {
		expect(managementBase("https://gw.example.com/v1")).toBe("https://gw.example.com");
		expect(managementBase("https://gw.example.com/v1/")).toBe("https://gw.example.com");
		expect(managementBase("https://gw.example.com/other")).toBe("https://gw.example.com/other");
	});
});

describe("compat pins + thinking maps per surface (toggles on)", () => {
	it("claude-family models: forceAdaptiveThinking pin and the null off ladder", () => {
		const chains = [{ name: "claude-sonnet-5-5", primary: "agw/claude-sonnet-5-5", fallbacks: [] }];
		const models = buildChainModels(chains, [], GATEWAY_ID, BASE_URL, { responses: true, messages: true });
		expect(models[0]?.api).toBe("anthropic-messages");
		expect(models[0]?.thinkingLevelMap).toEqual({ off: null });
		expect(models[0]?.compat).toEqual({ forceAdaptiveThinking: true });
	});

	it("gpt-family models: off maps to none, full level ladder, no compat pin", () => {
		const chains = [{ name: "gpt-6-luna", primary: "agw/gpt-6-luna", fallbacks: [] }];
		const models = buildChainModels(chains, [], GATEWAY_ID, BASE_URL, { responses: true, messages: true });
		expect(models[0]?.api).toBe("openai-responses");
		expect(models[0]?.thinkingLevelMap).toEqual({
			off: "none",
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
		expect(models[0]?.compat).toBeUndefined();
	});

	it("open-weight models: off maps to off, full ladder, no compat pin", () => {
		const chains = [{ name: "acme-flash", primary: "acme/acme-flash", fallbacks: [] }];
		const models = buildChainModels(chains, [], GATEWAY_ID, BASE_URL, { responses: true, messages: true });
		expect(models[0]?.api).toBe("openai-completions");
		expect(models[0]?.thinkingLevelMap).toEqual({
			off: "off",
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
		expect(models[0]?.compat).toBeUndefined();
	});

	it("member models honor the surfaces too (family from NAME, compat pin only on anthropic)", () => {
		const catalog = [
			memberModel("kiro/claude-sonnet-5-5"),
			memberModel("kiro/gpt-5.6-luna"),
			memberModel("acme/glm-5.3"),
		];
		const models = buildMemberModels([], catalog, GATEWAY_ID, BASE_URL, undefined, { responses: true, messages: true });
		const byId = new Map(models.map((m) => [m.id, m] as const));
		expect(byId.get("kiro/claude-sonnet-5-5")?.api).toBe("anthropic-messages");
		expect(byId.get("kiro/claude-sonnet-5-5")?.compat).toEqual({ forceAdaptiveThinking: true });
		expect(byId.get("kiro/gpt-5.6-luna")?.api).toBe("openai-responses");
		expect(byId.get("acme/glm-5.3")?.api).toBe("openai-completions");
		expect(byId.get("acme/glm-5.3")?.compat).toBeUndefined();
	});

	it("member models stay on completions with both toggles off", () => {
		const catalog = [memberModel("agw/claude-sonnet-5-5"), memberModel("agw/gpt-6-luna")];
		const off = buildMemberModels([], catalog, GATEWAY_ID, BASE_URL);
		expect(off.every((m) => m.api === "openai-completions")).toBe(true);
	});
});

describe("perMtok", () => {
	it("converts $/token strings to $/Mtok; rejects junk", () => {
		expect(perMtok("0.0000001633")).toBeCloseTo(0.1633, 6);
		expect(perMtok("0")).toBeUndefined();
		expect(perMtok("not-a-number")).toBeUndefined();
	});
});
