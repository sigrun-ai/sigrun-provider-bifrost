/**
 * Settings parsing tests (the scoped-settings adapter for pi-bifrost-gateway
 * 0.3.0 @ 5d15a28's `src/config.ts`): same key surface, same tolerant-parse
 * posture — wrong-typed values and unknown keys collect issues, never throw.
 */

import { describe, expect, it } from "vitest";
import {
	parseBifrostSettings,
	BIFROST_BASE_URL_ENV,
	type BifrostSettings,
} from "../src/config.js";

function parse(raw: unknown): { settings: BifrostSettings; issues: string[] } {
	const issues: string[] = [];
	return { settings: parseBifrostSettings(raw, issues), issues };
}

describe("parseBifrostSettings defaults", () => {
	it("empty/absent settings: publishChains false, publishUpstream true (pi 0.3.0 parity)", () => {
		const { settings, issues } = parse({});
		expect(settings.publishChains).toBe(false);
		expect(settings.publishUpstream).toBe(true);
		expect(settings.baseUrl).toBeUndefined();
		expect(settings.nativeProtocols).toBeUndefined();
		expect(settings.managementApiKey).toBeUndefined();
		expect(settings.thinkingOverrides).toBeUndefined();
		expect(issues).toEqual([]);
	});

	it("a non-object body: defaults + issue", () => {
		for (const bad of [null, [], "x", 42]) {
			const { settings, issues } = parse(bad);
			expect(settings.publishChains).toBe(false);
			expect(settings.publishUpstream).toBe(true);
			expect(issues.length).toBe(1);
			expect(issues[0]).toContain("object");
		}
	});
});

describe("parseBifrostSettings keys", () => {
	it("reads the publish flags, baseUrl, managementApiKey", () => {
		const { settings, issues } = parse({
			publishChains: true,
			publishUpstream: false,
			baseUrl: " https://gw.example.com/v1 ",
			managementApiKey: " admin-key ",
		});
		expect(settings.publishChains).toBe(true);
		expect(settings.publishUpstream).toBe(false);
		expect(settings.baseUrl).toBe("https://gw.example.com/v1");
		expect(settings.managementApiKey).toBe("admin-key");
		expect(issues).toEqual([]);
	});

	it("flags wrong-typed values as issues and keeps defaults", () => {
		const { settings, issues } = parse({
			publishChains: "yes",
			publishUpstream: 1,
			baseUrl: "",
			managementApiKey: 5,
		});
		expect(settings.publishChains).toBe(false);
		expect(settings.publishUpstream).toBe(true);
		expect(settings.baseUrl).toBeUndefined();
		expect(settings.managementApiKey).toBeUndefined();
		expect(issues.length).toBe(4);
	});

	it("reports unknown keys", () => {
		const { issues } = parse({ legacyPiConfigFile: true });
		expect(issues.join(" ")).toContain("unknown settings key");
	});
});

describe("thinkingOverrides parsing", () => {
	it("parses valid per-member ladders", () => {
		const { settings, issues } = parse({
			thinkingOverrides: { "acme/acme-pro": ["low", "high"] },
		});
		expect(settings.thinkingOverrides).toEqual({ "acme/acme-pro": ["low", "high"] });
		expect(issues).toEqual([]);
	});

	it("ignores entries containing unknown levels entirely", () => {
		const { settings, issues } = parse({
			thinkingOverrides: { "acme/acme-pro": ["low", "turbo"] },
		});
		// A half-known ladder is a guess; the member keeps the full-map
		// default rather than shipping a partial override.
		expect(settings.thinkingOverrides).toBeUndefined();
		expect(issues[0]).toContain("unknown level");
	});

	it("ignores a non-array ladder and a non-object container", () => {
		const arr = parse({ thinkingOverrides: { "acme/acme-pro": "low" } });
		expect(arr.settings.thinkingOverrides).toBeUndefined();
		expect(arr.issues[0]).toContain("array");

		const container = parse({ thinkingOverrides: [] });
		expect(container.settings.thinkingOverrides).toBeUndefined();
		expect(container.issues[0]).toContain("thinkingOverrides");
	});
});

describe("nativeProtocols parsing", () => {
	it("parses the toggles; an explicitly-seen object carries both booleans", () => {
		const { settings, issues } = parse({
			nativeProtocols: { responses: true, messages: true },
		});
		expect(settings.nativeProtocols).toEqual({ responses: true, messages: true });
		expect(issues).toEqual([]);
	});

	it("wrong-typed toggles are issues; the pair stays false", () => {
		const { settings, issues } = parse({
			nativeProtocols: { responses: "on", messages: 1 },
		});
		expect(settings.nativeProtocols).toBeUndefined();
		expect(issues.join(" ")).toContain("boolean");
	});

	it("exact-name lists parse (trimmed) and duplicates are rejected", () => {
		const ok = parse({
			nativeProtocols: {
				responses: true,
				responsesModels: [" gpt-6-luna "],
				messagesModels: ["claude-sonnet-5-5"],
			},
		});
		expect(ok.settings.nativeProtocols?.responsesModels).toEqual(["gpt-6-luna"]);
		expect(ok.settings.nativeProtocols?.messagesModels).toEqual(["claude-sonnet-5-5"]);

		const dup = parse({
			nativeProtocols: { responses: true, responsesModels: ["a", "a"] },
		});
		expect(dup.settings.nativeProtocols?.responsesModels).toBeUndefined();
		expect(dup.issues.join(" ")).toContain("duplicates");
	});

	it("unknown nativeProtocols keys are issues", () => {
		const { issues } = parse({ nativeProtocols: { telegram: true } });
		expect(issues.join(" ")).toContain("unknown nativeProtocols key");
	});
});

describe("env keys", () => {
	it("documents the ambient base-URL env key", () => {
		expect(BIFROST_BASE_URL_ENV).toBe("BIFROST_BASE_URL");
	});
});
