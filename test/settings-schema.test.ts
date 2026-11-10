/**
 * The plugin's declared settings (settings rework, Task 8): one JSON Schema
 * through `host.settings.declare`, so core draws the settings page, applies
 * the defaults and repairs a malformed stored value — the per-key contract
 * the deleted `parseBifrostSettings` parser had. Every default asserted here
 * is the deleted parser's (`git show HEAD~1:src/config.ts`), and the
 * management credential is the one SECRET: a value that used to live in the
 * settings file is moved to the secrets store and still reaches the client.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertDrawable, checkStoredSettings } from "@sigrun/sigrun/settings-schema";

import sigrunBifrost, {
	BIFROST_BASE_URL_ENV,
	BIFROST_MANAGEMENT_API_KEY_SECRET,
	PROVIDER_ID,
	usableNativeProtocols,
	usableThinkingOverrides,
	type ProviderPluginResult,
} from "../src/index.js";
import { BIFROST_SETTINGS_SCHEMA } from "../src/settings-schema.js";
import { createFakeHost, type FakeHost } from "./fake-host.js";

/** The deleted parser's defaults, key for key. */
const OLD_DEFAULTS = {
	publishChains: false,
	publishUpstream: true,
	// Materialised rather than absent: both toggles carry `default: false`, so
	// the checked read fills the group in. Behaviour is identical (an absent
	// group and a false/false group both mean "chat completions everywhere").
	nativeProtocols: { responses: false, messages: false },
};

/** A live install's file, before the rework: the secret is in it. */
const OLD_FILE = {
	publishChains: true,
	publishUpstream: false,
	baseUrl: "https://gateway.example/v1",
	nativeProtocols: {
		responses: true,
		messages: true,
		responsesModels: ["acme-flash"],
		messagesModels: ["acme-claude"],
	},
	thinkingOverrides: { "acme/acme-pro": ["low", "high"] },
	managementApiKey: "synthetic-management-key",
};

const fakes: FakeHost[] = [];
afterEach(() => {
	fakes.splice(0);
	vi.restoreAllMocks();
});

/** A fake host over `settings`, with ONE factory run (so it has declared). */
async function declared(
	settings?: Record<string, unknown>,
	secrets?: Record<string, string>,
): Promise<{ fake: FakeHost; result: ProviderPluginResult }> {
	const fake = createFakeHost({ settings, secrets });
	fakes.push(fake);
	return { fake, result: await sigrunBifrost(fake.host) };
}

describe("bifrost settings schema", () => {
	it("schema is drawable", () => {
		// No property may fall back to a JSON box: the page is a form, not an
		// editor, and `assertDrawable` also runs the load-time keyword checks.
		assertDrawable(BIFROST_SETTINGS_SCHEMA);
	});

	it("the factory declares the schema and reads it once", async () => {
		const { fake } = await declared();
		expect(fake.declaration).toEqual({ schema: BIFROST_SETTINGS_SCHEMA });
		expect(fake.reads).toBe(1);
	});

	it("defaults match the old parser", async () => {
		expect(checkStoredSettings(BIFROST_SETTINGS_SCHEMA, {}).value).toEqual({
			...OLD_DEFAULTS,
			// The declared secret arrives as "" (unset) and never as a value.
			managementApiKey: "",
		});
		expect(await (await declared()).fake.read()).toEqual({
			...OLD_DEFAULTS,
			managementApiKey: "",
		});
	});

	it("empty file equals old defaults", async () => {
		// No settings file at all: the store reads {} and the provider boots
		// exactly as before — member-only (publishChains false), the upstream
		// catalogue published, no base URL (the ambient env wins) and chat
		// completions everywhere.
		const { result } = await declared();
		const provider = result.providers[0]!.provider;
		expect(provider.id).toBe(PROVIDER_ID);
		expect(provider.getModels()).toEqual([]);
		expect(result.providers[0]!.readiness!()).toEqual({ status: "not_configured" });
		expect(result.health!()).toBe("ok");
	});

	it("an old settings file still loads", async () => {
		// Every documented key, as pre-rework installations have it. The only
		// repair is the one the rework intends: the secret leaves the file
		// (asserted in detail by "moved secret still reaches the client").
		const checked = checkStoredSettings(BIFROST_SETTINGS_SCHEMA, OLD_FILE);
		expect(checked.repairs).toEqual([]);
		expect(checked.value).toEqual(OLD_FILE);

		const { fake } = await declared(OLD_FILE);
		// The file is unchanged apart from the moved secret.
		const { managementApiKey: _moved, ...withoutSecret } = OLD_FILE;
		expect(fake.file).toEqual(withoutSecret);
		expect(fake.secrets).toEqual({ [BIFROST_MANAGEMENT_API_KEY_SECRET]: "synthetic-management-key" });
		// Everything the reader used to get out of the parser still arrives.
		expect(await fake.read()).toEqual(OLD_FILE);
	});

	it("the old file's secret is moved to the secrets store", async () => {
		// THE MOVE (the client-level half is `bifrost.test.ts`'s "moved secret
		// still reaches the client"): a pre-rework file carries
		// `managementApiKey` as a plain settings value.
		// Core's save path cannot move it (a `writeOnly` property is stripped
		// from what it writes, and an untouched field submits "" = unchanged,
		// so nothing would ever be stored) — so the factory moves it on the
		// boot that sees it, and the file loses it.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { fake } = await declared(OLD_FILE);
		expect(Object.hasOwn(fake.file, "managementApiKey")).toBe(false);
		expect(fake.secrets[BIFROST_MANAGEMENT_API_KEY_SECRET]).toBe("synthetic-management-key");
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("moved managementApiKey"));

		// The NEXT boot reads it from the secrets store alone (the file no
		// longer has it), and core's save of the page — an untouched secret
		// field submits "" — keeps it.
		const second = createFakeHost({ settings: fake.file, secrets: fake.secrets });
		fakes.push(second);
		const result = await sigrunBifrost(second.host);
		expect(result.providers[0]!.provider.id).toBe(PROVIDER_ID);
		await second.save({ ...(await second.read()), managementApiKey: "" });
		expect(second.secrets[BIFROST_MANAGEMENT_API_KEY_SECRET]).toBe("synthetic-management-key");
		expect(Object.hasOwn(second.file, "managementApiKey")).toBe(false);
		// A save that DOES submit a new value replaces it (the page's own
		// rotation path), and still never writes it to the file.
		await second.save({ ...(await second.read()), managementApiKey: "synthetic-rotated" });
		expect(second.secrets[BIFROST_MANAGEMENT_API_KEY_SECRET]).toBe("synthetic-rotated");
		expect(Object.hasOwn(second.file, "managementApiKey")).toBe(false);
	});

	it("a stored secret wins over a stale file copy", async () => {
		const { fake } = await declared(
			{ managementApiKey: "synthetic-old-file-key" },
			{ [BIFROST_MANAGEMENT_API_KEY_SECRET]: "synthetic-stored-key" },
		);
		expect(fake.secrets[BIFROST_MANAGEMENT_API_KEY_SECRET]).toBe("synthetic-stored-key");
		expect(Object.hasOwn(fake.file, "managementApiKey")).toBe(false);
		expect(await fake.read()).toMatchObject({ managementApiKey: "synthetic-stored-key" });
	});

	it("a malformed value falls back to its default", async () => {
		// The deleted parser warned per key and kept going; core repairs each
		// value it cannot accept, one at a time.
		expect(
			checkStoredSettings(BIFROST_SETTINGS_SCHEMA, {
				publishChains: "yes",
				publishUpstream: 1,
				baseUrl: "gateway.example/v1",
			}).value,
		).toEqual({ ...OLD_DEFAULTS, managementApiKey: "" });
		// A non-URL base URL is refused by the form and falls back to unset —
		// the posture change from the parser, which passed any non-empty string
		// through to the client.
		expect(
			checkStoredSettings(BIFROST_SETTINGS_SCHEMA, { baseUrl: "not a url" }).value.baseUrl,
		).toBeUndefined();
		// A non-object nativeProtocols group is removed, leaving both surfaces
		// off — what the parser produced when it saw no usable key.
		expect(
			checkStoredSettings(BIFROST_SETTINGS_SCHEMA, { nativeProtocols: "on" }).value.nativeProtocols,
		).toBeUndefined();
		// Names that are not non-blank strings are dropped from an exact-name
		// list; a list emptied that way is removed (an EMPTY list would mean
		// "no model matches", not "use the heuristic").
		const list = checkStoredSettings(BIFROST_SETTINGS_SCHEMA, {
			nativeProtocols: { responses: true, responsesModels: ["acme-flash", 5, "  "] },
		});
		expect(list.value.nativeProtocols).toEqual({
			responses: true,
			messages: false,
			responsesModels: ["acme-flash"],
		});
		expect(
			checkStoredSettings(BIFROST_SETTINGS_SCHEMA, {
				nativeProtocols: { responses: true, responsesModels: [""] },
			}).value.nativeProtocols,
		).toEqual({ responses: true, messages: false });
	});

	it("exact-name lists are trimmed, de-duplicated and never left empty", () => {
		// The deleted parser trimmed each name; JSON Schema cannot, and a name
		// with padding would silently match no model.
		expect(
			usableNativeProtocols({
				responses: true,
				messages: false,
				responsesModels: [" acme-flash ", "acme-flash", "acme-pro"],
			}),
		).toEqual({ responses: true, messages: false, responsesModels: ["acme-flash", "acme-pro"] });
		// A list the parser could not use leaves the surface on the built-in
		// heuristic; an EMPTY list would mean "no model matches" instead.
		expect(usableNativeProtocols({ responses: true, messages: false, responsesModels: [] })).toEqual({
			responses: true,
			messages: false,
		});
		expect(usableNativeProtocols(undefined)).toBeUndefined();
	});

	it("a thinking ladder with an unknown level is ignored, never half-applied", async () => {
		// The one rule the schema cannot state: an entry is all-or-nothing, so
		// the member keeps the full ladder when any level is unknown.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const ladders = { "acme/acme-pro": ["low", "turbo"], "acme/x": ["low"] };
		expect(usableThinkingOverrides(ladders, (m) => warn(m))).toEqual({ "acme/x": ["low"] });
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("acme/acme-pro"));
		expect(usableThinkingOverrides(undefined, () => {})).toBeUndefined();
		// An emptied ladder is no ladder, exactly as the parser dropped it.
		expect(usableThinkingOverrides({ "acme/x": [] }, () => {})).toBeUndefined();
		// A ladder that is not a list of level names is no ladder either.
		expect(
			usableThinkingOverrides({ "acme/x": "low" } as unknown as Record<string, string[]>, () => {}),
		).toBeUndefined();
	});

	it("the base URL outranks the ambient env value, as the parser had it", async () => {
		// The schema cannot reorder precedence; this pins that the declared
		// value still arrives at the client ahead of BIFROST_BASE_URL.
		const { fake } = await declared({ baseUrl: "https://gateway.example/v1" });
		expect(await fake.read()).toMatchObject({ baseUrl: "https://gateway.example/v1" });
		expect(BIFROST_BASE_URL_ENV).toBe("BIFROST_BASE_URL");
	});
});
