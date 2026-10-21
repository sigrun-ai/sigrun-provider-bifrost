/**
 * Transport tests (ported from pi-bifrost-gateway 0.3.0 @ 5d15a28,
 * `test/http.test.ts`): fetchJson auth/deadline/UA shape and the error
 * envelope decoding. All fetches are vi.fn mocks — zero network.
 */

import { describe, expect, it, vi } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { Compile } from "typebox/compile";
import { fetchJson, HttpError } from "../src/http.js";

const Payload = Type.Object({ ok: Type.Boolean() });
const Validator = Compile(Payload);

function respond(status: number, body: string): Response {
	return new Response(body, { status, headers: { "content-type": "application/json" } });
}

describe("fetchJson", () => {
	it("gets a url with Bearer auth and decodes validated JSON", async () => {
		const fetchMock = vi.fn(async () => respond(200, JSON.stringify({ ok: true })));
		const result = await fetchJson("https://x.test/api/thing", "vk-secret", Validator, undefined, {
			fetchImpl: fetchMock as typeof fetch,
		});
		expect(result).toEqual({ ok: true });
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://x.test/api/thing");
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer vk-secret");
	});

	it("attaches a deadline AbortSignal so a silent peer cannot hang the refresh", async () => {
		const fetchMock = vi.fn(async () => respond(200, JSON.stringify({ ok: true })));
		await fetchJson("https://x.test/", "k", Validator, undefined, { fetchImpl: fetchMock as typeof fetch });
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		// A raw caller signal would be passed through untouched; an abortable
		// deadline signal (AbortSignal.any of timeout + caller) must be present.
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("sends a User-Agent identifying sigrun-bifrost", async () => {
		const fetchMock = vi.fn(async () => respond(200, JSON.stringify({ ok: true })));
		await fetchJson("https://x.test/", "k", Validator, undefined, { fetchImpl: fetchMock as typeof fetch });
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect((init.headers as Record<string, string>)["User-Agent"]).toMatch(/^sigrun-provider-bifrost\//);
	});

	it("throws HttpError with parsed code/message on error JSON", async () => {
		const fetchMock = vi.fn(async () =>
			respond(401, JSON.stringify({ error: { code: "auth", message: "nope" } })),
		);
		const caught = await fetchJson(
			"https://x.test/",
			"k",
			Validator,
			undefined,
			{ fetchImpl: fetchMock as typeof fetch },
		).then(
			() => null,
			(catchArg: unknown) => catchArg,
		);
		expect(caught).toBeInstanceOf(HttpError);
		const err = caught as HttpError;
		expect(err.status).toBe(401);
		expect(err.code).toBe("auth");
		expect(err.message).toContain("nope");
	});

	it("throws schema_mismatch on non-JSON and type-invalid bodies", async () => {
		const html = vi.fn(async () => respond(200, "<html>"));
		await expect(
			fetchJson("https://x.test/", "k", Validator, undefined, { fetchImpl: html as typeof fetch }),
		).rejects.toMatchObject({ code: "schema_mismatch" });

		const wrongType = vi.fn(async () => respond(200, JSON.stringify({ ok: "wrong-type" })));
		await expect(
			fetchJson("https://x.test/", "k", Validator, undefined, { fetchImpl: wrongType as typeof fetch }),
		).rejects.toMatchObject({ code: "schema_mismatch" });
	});

	it("propagates an untouched AbortError", async () => {
		const abortErr = new Error("The operation was aborted");
		abortErr.name = "AbortError";
		const fetchMock = vi.fn(async () => {
			throw abortErr;
		});
		await expect(
			fetchJson("https://x.test/", "k", Validator, undefined, { fetchImpl: fetchMock as typeof fetch }),
		).rejects.toBe(abortErr);
	});
});
