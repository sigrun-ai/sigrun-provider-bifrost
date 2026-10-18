/**
 * Transport only (ported from pi-bifrost-gateway 0.3.0 @ 5d15a28, module
 * unchanged except the User-Agent name): GET with Bearer auth + typebox
 * validation, a hard 15 s deadline so a silent peer can never hang the
 * refresh.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
function packageVersion() {
    const payload = require("../package.json");
    if (typeof payload === "object" && payload !== null) {
        const version = payload.version;
        if (typeof version === "string" && version.length > 0)
            return version;
    }
    return "0.0.0";
}
const USER_AGENT = `sigrun-bifrost/${packageVersion()}`;
export class HttpError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
        this.name = HttpError.name;
    }
}
/**
 * GET `url` with Bearer auth and validate the JSON body with `validator`.
 * Non-2xx responses throw HttpError carrying the upstream
 * `error.code`/`error.message` when present. Abort errors propagate untouched.
 *
 * Each GET also carries a default 15 s deadline (AbortSignal.timeout,
 * combined with any caller signal — the caller's abort still wins). Without
 * it a peer that accepts the connection and then goes silent hangs the
 * refresh until the process dies; refresh MUST terminate.
 */
const DEFAULT_TIMEOUT_MS = 15_000;
export async function fetchJson(url, token, validator, signal, opts) {
    const doFetch = opts?.fetchImpl ?? globalThis.fetch;
    const deadline = AbortSignal.any([AbortSignal.timeout(DEFAULT_TIMEOUT_MS), ...(signal ? [signal] : [])]);
    const response = await doFetch(url, {
        method: "GET",
        headers: {
            Authorization: `Bearer ${token}`,
            "User-Agent": USER_AGENT,
            Accept: "application/json",
        },
        signal: deadline,
    });
    const body = await response.text();
    if (!response.ok) {
        const { code, message } = parseErrorBody(body);
        throw new HttpError(response.status, code === "http_error" ? `http_${response.status}` : code, message.length > 0 ? message : `${response.status} from ${url}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(body);
    }
    catch (error) {
        throw new HttpError(response.status, "schema_mismatch", `invalid JSON from ${url}: ${String(error)}`);
    }
    if (!validator.Check(parsed)) {
        const detail = validator
            .Errors(parsed)
            .map((e) => `${e.instancePath}: ${e.message}`)
            .join("; ");
        throw new HttpError(response.status, "schema_mismatch", `schema mismatch from ${url}: ${detail}`);
    }
    return validator.Decode(parsed);
}
function parseErrorBody(body) {
    try {
        const payload = JSON.parse(body);
        const error = payload?.error;
        if (typeof error === "object" && error !== null && typeof error.message === "string") {
            const code = typeof error.code === "string" && error.code.length > 0 ? error.code : "http_error";
            return { code, message: error.message };
        }
    }
    catch {
        // non-JSON error body — fall through
    }
    return { code: "http_error", message: body.slice(0, 300) };
}
