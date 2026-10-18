/**
 * Transport only (ported from pi-bifrost-gateway 0.3.0 @ 5d15a28, module
 * unchanged except the User-Agent name): GET with Bearer auth + typebox
 * validation, a hard 15 s deadline so a silent peer can never hang the
 * refresh.
 */
import type { TProperties, TSchema } from "typebox";
import type { Validator } from "typebox/compile";
export declare class HttpError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string);
}
export interface FetchJsonOptions {
    fetchImpl?: typeof fetch;
}
export declare function fetchJson<T>(url: string, token: string, validator: Validator<TProperties, TSchema>, signal?: AbortSignal, opts?: FetchJsonOptions): Promise<T>;
