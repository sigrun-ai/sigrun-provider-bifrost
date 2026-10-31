/**
 * Provider + factory contract tests (the ported `src/index.ts` against a
 * node:http FIXTURE GATEWAY on 127.0.0.1 — hermetic: no network, no
 * process.env; ambient env arrives through the injected AuthContext, the
 * same seam sigrun's bridge uses).
 *
 * Covers the Task 10 brief's test list: member-only mode makes ZERO
 * management-plane calls; chains mode resolves VK + routing rules;
 * unconfigured throws (never []); every published model carries
 * provider: "bifrost"; managementApiKey overrides the VK on /api/*;
 * settings values are baked at factory time (restart-required).
 */

import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createModels,
	type MutableModels,
} from "@earendil-works/pi-ai/models";
import type {
	AuthContext,
	CredentialStore,
	RefreshModelsContext,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import sigrunBifrost, {
	BIFROST_API_KEY_ENV,
	createBifrostPlugin,
	discoverModels,
	PROVIDER_ID,
	type BifrostPluginOptions,
	type SigrunPluginHost,
} from "../src/index.js";
import { BIFROST_BASE_URL_ENV } from "../src/config.js";

/* ---------- fixture gateway ---------- */

const VK_VALUE = "vk-test-secret";
const MGMT_KEY = "admin-test-secret";

/** The /v1/models member catalog (synthetic acme ids; per-token $ strings). */
const CATALOG_BODY = {
	object: "list",
	data: [
		{
			id: "acme/acme-flash",
			context_length: 1_048_576,
			pricing: { prompt: "0.0000001633", completion: "0.0000005444" },
		},
		{
			id: "acme2/acme-flash",
			context_length: 500_000,
			pricing: { prompt: "0.0000001", completion: "0.0000005" },
		},
	],
};

/** One vk-pi-style chain routing rule for the acme-flash chain. */
const RULES_BODY = {
	count: 1,
	limit: 10,
	offset: 0,
	rules: [
		{
			id: "vk-test-chain-acme-flash",
			name: "Chain: acme-flash",
			enabled: true,
			cel_expression: 'model == "acme-flash" || model == "bifrost/acme-flash"',
			targets: [{ provider: "acme", model: "acme-flash", weight: 1 }],
			fallbacks: ["acme2/acme-flash"],
			scope: "virtual_key",
			scope_id: "vk-test",
			priority: 0,
		},
	],
};

const VIRTUAL_KEYS_BODY = {
	count: 1,
	virtual_keys: [{ id: "vk-test", name: "test", value: VK_VALUE }],
};

interface RecordedRequest {
	readonly method: string;
	readonly path: string;
	readonly authorization?: string;
	readonly body?: unknown;
}

let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
let server: http.Server | undefined;
let baseUrl = "";
const requests: RecordedRequest[] = [];

beforeEach(async () => {
	requests.length = 0;
	server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const rawBody = Buffer.concat(chunks).toString("utf8");
			requests.push({
				method: req.method ?? "",
				path: (req.url ?? "").split("?")[0],
				authorization: req.headers.authorization,
				...(rawBody.length > 0 ? { body: JSON.parse(rawBody) as unknown } : {}),
			});
			handler(req, res);
		});
	});
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("fixture server did not report a port");
	}
	baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterEach(async () => {
	await new Promise<void>((resolve) => server?.close(() => resolve()));
	server = undefined;
});

/** The full fixture gateway: inference + management planes, token-checked. */
function serveGateway(): void {
	handler = (req, res) => {
		const url = req.url ?? "";
		if (url.startsWith("/api/governance/virtual-keys")) {
			if (req.headers.authorization !== `Bearer ${MGMT_KEY}`) {
				res.writeHead(401).end(JSON.stringify({ error: { code: "auth", message: "management auth failed" } }));
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(VIRTUAL_KEYS_BODY));
			return;
		}
		if (url.startsWith("/api/routing/rules")) {
			if (req.headers.authorization !== `Bearer ${MGMT_KEY}`) {
				res.writeHead(401).end(JSON.stringify({ error: { code: "auth", message: "management auth failed" } }));
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(RULES_BODY));
			return;
		}
		if (url === "/v1/models") {
			if (req.headers.authorization !== `Bearer ${VK_VALUE}`) {
				res.writeHead(401).end(JSON.stringify({ error: { code: "auth", message: "bad token" } }));
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(CATALOG_BODY));
			return;
		}
		res.writeHead(404).end("{}");
	};
}

/* ---------- pi-ai seams (the same shapes sigrun's bridge injects) ---------- */

function credentialStore(key: string | undefined): CredentialStore {
	return {
		read: async () =>
			key === undefined ? undefined : { type: "api_key", key },
		list: async () => [],
		modify: async () => {
			throw new Error("unexpected credential write in tests");
		},
		delete: async () => {
			throw new Error("unexpected credential delete in tests");
		},
	};
}

function authContext(env: Record<string, string> = {}): AuthContext {
	return {
		env: async (name) => env[name],
		fileExists: async () => false,
	};
}

function models(
	key: string | undefined,
	options: BifrostPluginOptions,
	env: Record<string, string> = {},
): MutableModels {
	const store = createModels({
		credentials: credentialStore(key),
		authContext: authContext(env),
	});
	store.setProvider(createBifrostPlugin(options).provider);
	return store;
}

function directContext(): RefreshModelsContext {
	return {
		allowNetwork: true,
		signal: new AbortController().signal,
		publish: async () => true,
	};
}

/* ---------- the factory contract ---------- */

describe("the factory contract", () => {
	it("returns a provider-only contributor with an empty baseline catalog", async () => {
		const host: SigrunPluginHost = {
			stores: { settings: { get: async () => ({}), set: async () => {} } },
		};
		const result = await sigrunBifrost(host);
		expect(result.name).toBe("provider-bifrost");
		// Provider-only: no extension field (the loader's Task 1 pathway).
		expect("extension" in result).toBe(false);
		expect(result.providers).toHaveLength(1);
		const contribution = result.providers[0]!;
		expect(contribution.provider.id).toBe(PROVIDER_ID);
		expect(typeof contribution.readiness).toBe("function");
		expect(typeof result.health).toBe("function");
		// createProvider REQUIRES a baseline `models` array — and the empty
		// baseline means the provider boots with no models (unconfigured
		// still boots; readiness not_configured).
		expect(contribution.provider.getModels()).toEqual([]);
		expect(contribution.readiness!()).toEqual({ status: "not_configured" });
		expect(result.health!()).toBe("ok");
		// Arity 1: the host-taking signature (the loader's factory.length
		// gate passes the seam host only to factories that declare it).
		expect(sigrunBifrost.length).toBe(1);
	});

	it("defaults: publishChains false, publishUpstream true (no settings file)", async () => {
		// An absent settings file reads as {} (the store's contract) — the
		// provider is member-only by default; observed through the request
		// pattern of a refresh (catalog only, no /api/* calls).
		serveGateway();
		const host: SigrunPluginHost = {
			stores: { settings: { get: async () => ({}), set: async () => {} } },
		};
		const result = await sigrunBifrost(host);
		const store = createModels({
			credentials: credentialStore(VK_VALUE),
			authContext: authContext({ [BIFROST_BASE_URL_ENV]: baseUrl }),
		});
		store.setProvider(result.providers[0]!.provider);
		const refresh = await store.refresh({ force: true });
		expect(refresh.errors.size).toBe(0);
		expect(requests.map((r) => r.path)).toEqual(["/v1/models"]);
	});
});

/* ---------- member-only mode (the default) ---------- */

describe("member-only mode (publishChains false)", () => {
	it("publishes the catalog with ZERO management-plane calls, provider stamped", async () => {
		serveGateway();
		const store = models(VK_VALUE, {
			publishChains: false,
			publishUpstream: true,
			baseUrl,
		});
		const refresh = await store.refresh({ force: true });
		expect(refresh.errors.size).toBe(0);
		// ZERO management calls — the stock-gateway guarantee.
		expect(requests.map((r) => r.path)).toEqual(["/v1/models"]);
		expect(requests[0]!.authorization).toBe(`Bearer ${VK_VALUE}`);

		const catalog = store.getModels(PROVIDER_ID);
		expect(catalog.map((m) => m.id)).toEqual(["acme/acme-flash", "acme2/acme-flash"]);
		const acme = catalog[0]!;
		expect(acme.contextWindow).toBe(1_048_576);
		expect(acme.cost.input).toBeCloseTo(0.1633, 4);
		// THE stamp on every published model.
		for (const model of catalog) {
			expect(model.provider).toBe(PROVIDER_ID);
		}
	});

	it("honors nativeProtocols in member-only mode", async () => {
		serveGateway();
		const store = models(VK_VALUE, {
			publishChains: false,
			publishUpstream: true,
			baseUrl,
			nativeProtocols: { responses: true, messages: true, responsesModels: ["acme-flash"] },
		});
		await store.refresh({ force: true });
		expect(store.getModels(PROVIDER_ID)[0]!.api).toBe("openai-responses");
	});

	it("applies thinkingOverrides to member models end to end", async () => {
		serveGateway();
		const store = models(VK_VALUE, {
			publishChains: false,
			publishUpstream: true,
			baseUrl,
			thinkingOverrides: { "acme/acme-flash": ["low", "high"] },
		});
		await store.refresh({ force: true });
		expect(store.getModels(PROVIDER_ID)[0]!.thinkingLevelMap).toEqual({
			off: "off",
			low: "low",
			high: "high",
		});
	});

	it("both publish flags off THROWS — never returns []", async () => {
		serveGateway();
		await expect(
			discoverModels(VK_VALUE, baseUrl, {
				publishChains: false,
				publishUpstream: false,
				baseUrl,
			}),
		).rejects.toThrow(/both false|nothing to publish/);
	});
});

/* ---------- chains mode ---------- */

describe("chains mode (publishChains true)", () => {
	it("resolves the VK, fetches routing rules, publishes the chain first", async () => {
		serveGateway();
		const store = models(VK_VALUE, {
			publishChains: true,
			publishUpstream: true,
			baseUrl,
			managementApiKey: MGMT_KEY,
		});
		const refresh = await store.refresh({ force: true });
		expect(refresh.errors.size).toBe(0);

		const paths = requests.map((r) => r.path);
		expect(paths).toContain("/api/governance/virtual-keys");
		expect(paths).toContain("/api/routing/rules");
		expect(paths).toContain("/v1/models");

		const ids = store.getModels(PROVIDER_ID).map((m) => m.id);
		expect(ids[0]).toBe("chain/acme-flash");
		expect(ids).toContain("acme/acme-flash");
		const chain = store.getModels(PROVIDER_ID)[0]!;
		// min member context window; zero cost by design.
		expect(chain.contextWindow).toBe(500_000);
		expect(chain.cost.input).toBe(0);
		for (const model of store.getModels(PROVIDER_ID)) {
			expect(model.provider).toBe(PROVIDER_ID);
		}
	});

	it("chains-only publishing (publishUpstream false)", async () => {
		serveGateway();
		const store = models(VK_VALUE, {
			publishChains: true,
			publishUpstream: false,
			baseUrl,
			managementApiKey: MGMT_KEY,
		});
		await store.refresh({ force: true });
		expect(store.getModels(PROVIDER_ID).map((m) => m.id)).toEqual(["chain/acme-flash"]);
	});

	it("managementApiKey overrides the VK on /api/* (the VK stays on /v1/*)", async () => {
		serveGateway();
		const store = models(VK_VALUE, {
			publishChains: true,
			publishUpstream: true,
			baseUrl,
			managementApiKey: MGMT_KEY,
		});
		await store.refresh({ force: true });
		const byPath = new Map(requests.map((r) => [r.path, r.authorization]));
		expect(byPath.get("/api/governance/virtual-keys")).toBe(`Bearer ${MGMT_KEY}`);
		expect(byPath.get("/api/routing/rules")).toBe(`Bearer ${MGMT_KEY}`);
		expect(byPath.get("/v1/models")).toBe(`Bearer ${VK_VALUE}`);
	});

	it("falls back to the VK on /api/* when managementApiKey is unset", async () => {
		// A variant gateway whose management plane accepts the VK itself
		// (dashboard-auth-disabled deployments).
		handler = (req, res) => {
			const url = req.url ?? "";
			if (url.startsWith("/api/governance/virtual-keys")) {
				if (req.headers.authorization !== `Bearer ${VK_VALUE}`) {
					res.writeHead(401).end("{}");
					return;
				}
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(VIRTUAL_KEYS_BODY));
				return;
			}
			if (url.startsWith("/api/routing/rules")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(RULES_BODY));
				return;
			}
			if (url === "/v1/models") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(CATALOG_BODY));
				return;
			}
			res.writeHead(404).end("{}");
		};
		const store = models(VK_VALUE, {
			publishChains: true,
			publishUpstream: true,
			baseUrl,
		});
		const refresh = await store.refresh({ force: true });
		expect(refresh.errors.size).toBe(0);
		expect(requests.find((r) => r.path === "/api/governance/virtual-keys")?.authorization).toBe(`Bearer ${VK_VALUE}`);
	});

	it("round trip: plugin dispatch sees chain/<name>, the gateway receives the bare name", async () => {
		let innerModelId: string | undefined;
		serveGateway();
		const plugin = createBifrostPlugin({
			publishChains: true,
			publishUpstream: false,
			baseUrl,
			managementApiKey: MGMT_KEY,
		});
		const store = createModels({
			credentials: credentialStore(VK_VALUE),
			authContext: authContext({}),
		});
		store.setProvider(plugin.provider);
		const refresh = await store.refresh({ force: true });
		expect(refresh.errors.size).toBe(0);

		const model = plugin.provider.getModels().find((entry) => entry.id === "chain/acme-flash");
		expect(model).toBeDefined();
		const pluginStreamSimple = plugin.provider.streamSimple;
		const observed = {
			...plugin.provider,
			streamSimple: (...args: Parameters<typeof pluginStreamSimple>) => {
				expect(args[0].id).toBe("chain/acme-flash");
				return pluginStreamSimple(...args);
			},
		};
		store.setProvider(observed);

		handler = (req, res) => {
			if (req.url !== "/v1/chat/completions") {
				res.writeHead(404).end("{}");
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(
				'data: {"id":"response-1","model":"acme/acme-flash","choices":[{"delta":{"content":"served"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n' +
					"data: [DONE]\n\n",
			);
		};
		const result = await observed.streamSimple(
			model!,
			{ messages: [{ role: "user", content: "hello", timestamp: 0 }] } as unknown as TranscriptContext,
			{
				apiKey: VK_VALUE,
				maxRetries: 0,
				onPayload: (_payload, innerModel) => {
					innerModelId = innerModel.id;
				},
			},
		).result();
		expect(innerModelId).toBe("acme-flash");
		const request = requests.find((entry) => entry.path === "/v1/chat/completions");
		expect(request?.body).toMatchObject({ model: "acme-flash" });
		expect(result.responseModel).toBe("acme/acme-flash");
		expect(result.stopReason).not.toBe("error");
	});

	it("skips chain/ member ids and warns once per process for the namespace collision", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			serveGateway();
			const collidingCatalog = {
				...CATALOG_BODY,
				data: [...CATALOG_BODY.data, { id: "chain/foo", context_length: 128_000 }],
			};
			handler = (req, res) => {
				if (req.url !== "/v1/models") {
					res.writeHead(404).end("{}");
					return;
				}
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(collidingCatalog));
			};
			const options = { publishChains: false, publishUpstream: true, baseUrl };
			const first = await discoverModels(VK_VALUE, baseUrl, options);
			const second = await discoverModels(VK_VALUE, baseUrl, options);
			for (const catalog of [first, second]) {
				expect(catalog.some((model) => model.id === "chain/foo")).toBe(false);
			}
			const collisionWarnings = warn.mock.calls.filter((call) =>
				String(call[0]).includes("upstream provider \"chain\" collides"),
			);
			expect(collisionWarnings).toHaveLength(1);
		} finally {
			warn.mockRestore();
		}
	});

	it("a credential matching no VK throws (VK mismatch), never returns []", async () => {
		serveGateway();
		await expect(
			discoverModels("vk-wrong", baseUrl, {
				publishChains: true,
				publishUpstream: true,
				baseUrl,
				managementApiKey: MGMT_KEY,
			}),
		).rejects.toThrow(/does not match any virtual key/);
	});

	it("zero usable chain rules throws", async () => {
		handler = (req, res) => {
			const url = req.url ?? "";
			if (url.startsWith("/api/governance/virtual-keys")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(VIRTUAL_KEYS_BODY));
				return;
			}
			if (url.startsWith("/api/routing/rules")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ rules: [] }));
				return;
			}
			if (url === "/v1/models") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(CATALOG_BODY));
				return;
			}
			res.writeHead(404).end("{}");
		};
		await expect(
			discoverModels(VK_VALUE, baseUrl, {
				publishChains: true,
				publishUpstream: true,
				baseUrl,
				managementApiKey: MGMT_KEY,
			}),
		).rejects.toThrow(/no chain routing rules/);
	});
});

/* ---------- credentials + base URL precedence ---------- */

describe("credentials", () => {
	it("the bridged credential wins over the env fallback", async () => {
		serveGateway();
		const store = models(VK_VALUE, { publishChains: false, publishUpstream: true, baseUrl }, {
			[BIFROST_API_KEY_ENV]: "env-key",
		});
		const refresh = await store.refresh({ force: true });
		expect(refresh.errors.size).toBe(0);
		expect(requests[0]!.authorization).toBe(`Bearer ${VK_VALUE}`);
	});

	it("falls back to the ambient BIFROST_API_KEY when nothing is stored", async () => {
		serveGateway();
		handler = (req, res) => {
			if (req.headers.authorization !== "Bearer env-key") {
				res.writeHead(401).end("{}");
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(CATALOG_BODY));
		};
		const store = models(undefined, { publishChains: false, publishUpstream: true, baseUrl }, {
			[BIFROST_API_KEY_ENV]: "env-key",
		});
		const refresh = await store.refresh({ force: true });
		expect(refresh.errors.size).toBe(0);
		expect(requests[0]!.authorization).toBe("Bearer env-key");
		expect(store.getModels(PROVIDER_ID).length).toBe(2);
	});
});

describe("base URL precedence", () => {
	it("the settings baseUrl wins over the ambient BIFROST_BASE_URL", async () => {
		serveGateway();
		// The env points at a dead port; the baked settings URL must win.
		const store = models(VK_VALUE, { publishChains: false, publishUpstream: true, baseUrl }, {
			[BIFROST_BASE_URL_ENV]: "http://127.0.0.1:9/v1",
		});
		const refresh = await store.refresh({ force: true });
		expect(refresh.errors.size).toBe(0);
		expect(requests[0]!.path).toBe("/v1/models");
	});

	it("the ambient BIFROST_BASE_URL applies when no settings URL exists", async () => {
		serveGateway();
		const store = models(VK_VALUE, { publishChains: false, publishUpstream: true }, {
			[BIFROST_BASE_URL_ENV]: baseUrl,
		});
		const refresh = await store.refresh({ force: true });
		expect(refresh.errors.size).toBe(0);
		expect(requests[0]!.path).toBe("/v1/models");
		expect(store.getModels(PROVIDER_ID).every((m) => m.baseUrl === baseUrl)).toBe(true);
	});
});

/* ---------- the unconfigured provider ---------- */

describe("the unconfigured provider", () => {
	it("never fetches, reports not_configured/ok, and fetchModels throws — never []", async () => {
		serveGateway();
		const plugin = createBifrostPlugin({ publishChains: false, publishUpstream: true });
		const store = createModels({
			credentials: credentialStore(undefined),
			authContext: authContext({}),
		});
		store.setProvider(plugin.provider);
		const refresh = await store.refresh({ force: true });
		// pi-ai never refreshes an unconfigured provider: no error, no
		// request, baseline catalog untouched.
		expect(refresh.errors.size).toBe(0);
		expect(requests).toHaveLength(0);
		expect(store.getModels(PROVIDER_ID)).toEqual([]);
		expect(plugin.readiness()).toEqual({ status: "not_configured" });
		expect(plugin.health()).toBe("ok");
		// The never-[] invariant, pinned by direct invocation.
		await expect(plugin.provider.refreshModels?.(directContext())).rejects.toThrow(
			/not configured/,
		);
	});

	it("a credential with no base URL anywhere also throws (never [])", async () => {
		const plugin = createBifrostPlugin({ publishChains: false, publishUpstream: true });
		const context: RefreshModelsContext = {
			...directContext(),
			credential: { type: "api_key", key: VK_VALUE },
		};
		await expect(plugin.provider.refreshModels?.(context)).rejects.toThrow(/not configured/);
	});

	it("discoverModels throws on missing token or missing URL", async () => {
		const options: BifrostPluginOptions = { publishChains: false, publishUpstream: true };
		await expect(discoverModels(undefined, baseUrl, options)).rejects.toThrow(/not configured/);
		await expect(discoverModels(VK_VALUE, undefined, options)).rejects.toThrow(/not configured/);
	});
});

/* ---------- readiness tracking ---------- */

describe("readiness tracking", () => {
	it("transitions not_configured → ready → degraded, warning on transitions only", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			let failing = false;
			handler = (_req, res) => {
				if (failing) {
					res.writeHead(500);
					res.end("upstream exploded");
					return;
				}
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(CATALOG_BODY));
			};
			const plugin = createBifrostPlugin({ publishChains: false, publishUpstream: true, baseUrl });
			const store = createModels({
				credentials: credentialStore(VK_VALUE),
				authContext: authContext({}),
			});
			store.setProvider(plugin.provider);

			// Seeded from credential resolution: not_configured until the
			// first auth resolution succeeds.
			expect(plugin.readiness()).toEqual({ status: "not_configured" });

			await store.refresh({ force: true });
			expect(plugin.readiness()).toEqual({ status: "ready" });
			const warnedAfterFirst = warn.mock.calls.length;
			expect(warnedAfterFirst).toBeGreaterThan(0);

			// A second successful refresh: same state, NO new warnings.
			await store.refresh({ force: true });
			expect(plugin.readiness().status).toBe("ready");
			expect(warn.mock.calls.length).toBe(warnedAfterFirst);

			// A failed refresh: degraded, previous catalog retained, the
			// failure recorded per-provider, one transition warning.
			failing = true;
			const failed = await store.refresh({ force: true });
			expect(failed.errors.get(PROVIDER_ID)).toBeInstanceOf(Error);
			expect(plugin.readiness().status).toBe("degraded");
			expect(typeof plugin.readiness().detail).toBe("string");
			expect(plugin.health()).toBe("degraded");
			expect(store.getModels(PROVIDER_ID).length).toBe(2);
			expect(warn.mock.calls.length).toBe(warnedAfterFirst + 1);
			expect(String(warn.mock.calls.at(-1))).toMatch(/→ degraded/);
		} finally {
			warn.mockRestore();
		}
	});

	it("maps not_configured to health ok", () => {
		const plugin = createBifrostPlugin({ publishChains: false, publishUpstream: true });
		expect(plugin.health()).toBe("ok");
	});
});

/* ---------- settings are baked at factory time (restart-required) ---------- */

describe("factory-time settings baking", () => {
	it("the factory bakes the settings; later settings changes do not affect the built provider", async () => {
		serveGateway();
		let currentSettings: Record<string, unknown> = {
			baseUrl,
			publishChains: false,
			publishUpstream: true,
		};
		const host: SigrunPluginHost = {
			stores: { settings: { get: async () => currentSettings, set: async () => {} } },
		};
		const result = await sigrunBifrost(host);
		const store = createModels({
			credentials: credentialStore(VK_VALUE),
			authContext: authContext({}),
		});
		store.setProvider(result.providers[0]!.provider);
		const first = await store.refresh({ force: true });
		expect(first.errors.size).toBe(0);
		expect(requests.map((r) => r.path)).toEqual(["/v1/models"]);

		// The operator flips the settings to chains mode AFTER the factory
		// ran. The built provider keeps the member-only shape — settings are
		// read ONCE at factory time; applying the change needs a restart.
		currentSettings = {
			baseUrl,
			publishChains: true,
			publishUpstream: true,
			managementApiKey: MGMT_KEY,
		};
		requests.length = 0;
		const second = await store.refresh({ force: true });
		expect(second.errors.size).toBe(0);
		expect(requests.map((r) => r.path)).toEqual(["/v1/models"]);
	});

	it("parse issues warn and fall back to defaults, never quarantine", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const host: SigrunPluginHost = {
				stores: {
					settings: {
						get: async () => ({ publishChains: "yes", unknownKey: 1 }),
						set: async () => {},
					},
				},
			};
			const result = await sigrunBifrost(host);
			expect(result.providers).toHaveLength(1);
			const warned = warn.mock.calls.map(String).join(" ");
			expect(warned).toContain("publishChains");
			expect(warned).toContain("unknown settings key");
		} finally {
			warn.mockRestore();
		}
	});

	it("resolves the real slug's settings file through the loader's two-phase host (file-backed)", async () => {
		serveGateway();
		// Mirrors sigrun-pareto's Task 9 P1 regression test: the loader
		// pre-keys the factory host on the slug derived from the LOAD
		// SPECIFIER (this package's manifest name), so the factory-time
		// settings read resolves settings/provider-bifrost.json. The store
		// here is FILE-BACKED exactly like sigrun's scopedExtensionStores
		// (absent file → {}).
		const pkg = JSON.parse(
			await readFile(join(import.meta.dirname, "..", "package.json"), "utf8"),
		) as { name: string };
		const slug = pkg.name
			.split("/")
			.pop()!
			.replace(/@[^@]*$/, "")
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, "-")
			.replace(/^[-_]+|[-_]+$/g, "");
		expect(slug).toBe("provider-bifrost");

		const dir = await mkdtemp(join(tmpdir(), "sigrun-bifrost-host-"));
		try {
			const settingsFile = join(dir, "settings", `${slug}.json`);
			await mkdir(dirname(settingsFile), { recursive: true });
			await writeFile(settingsFile, JSON.stringify({ baseUrl }));
			const host: SigrunPluginHost = {
				stores: {
					settings: {
						get: async () => {
							try {
								return JSON.parse(await readFile(settingsFile, "utf8")) as Record<string, unknown>;
							} catch {
								return {}; // absent file → {} (the store's contract)
							}
						},
						set: async () => {
							throw new Error("unexpected settings write in tests");
						},
					},
				},
			};
			const result = await sigrunBifrost(host);
			const store = createModels({
				credentials: credentialStore(VK_VALUE),
				authContext: authContext({}),
			});
			store.setProvider(result.providers[0]!.provider);
			const refresh = await store.refresh({ force: true });
			expect(refresh.errors.size).toBe(0);
			// The settings-file override (this run's fixture server) won: the
			// default member-only catalog GET hit it and every model carries it.
			expect(requests.map((r) => r.path)).toEqual(["/v1/models"]);
			expect(store.getModels(PROVIDER_ID).every((m) => m.baseUrl === baseUrl)).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
