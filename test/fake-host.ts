/**
 * Settings fakes for the declared-settings suite (settings rework, Task 8).
 *
 * The host slice the factory takes is built here over an IN-MEMORY settings
 * file and secrets section, with `settings.declare` implemented on core's
 * REAL machinery: `checkStoredSettings` for the defaults and the
 * malformed-value repair (logged with the same line core's seam host emits)
 * and `generateForm` for the `writeOnly` paths, which is where core takes the
 * secret store keys from.
 *
 * One piece is modelled rather than imported: core's `fillSecrets` is not
 * part of the `@sigrun/sigrun/settings-schema` authoring surface, and this
 * package has exactly one secret, at a TOP-LEVEL path — the case where core's
 * encoding is "the bare property name". The check ends by assigning each
 * top-level `writeOnly` property the value the secrets store resolves, which
 * is core's precedence: the store's value is written unconditionally, so it
 * wins over one the file still carries. A nested secret would need core's own
 * walk, so `secretNames` rejects one instead of guessing.
 *
 * `save` is what core's save does to that same shape: a non-empty submission
 * is written to the secrets store, `""` means unchanged, `null` deletes, and
 * the value never reaches the file.
 */

import type {
	DeclaredSettings,
	SettingsDeclaration,
} from "@sigrun/sigrun/extension";
import { checkStoredSettings, generateForm } from "@sigrun/sigrun/settings-schema";

import type { SigrunPluginHost } from "../src/index.js";

/** The slug core names in its repair warnings (this package's declared name). */
const SLUG = "provider-bifrost";

export interface FakeHost {
	/** The host slice the factory takes. */
	readonly host: SigrunPluginHost;
	/** The declaration the factory passed to `settings.declare`. */
	readonly declaration: SettingsDeclaration | undefined;
	/** Checked reads the factory performed through the declared handle. */
	readonly reads: number;
	/** The stored settings file (what `settings/<slug>.json` holds). */
	readonly file: Record<string, unknown>;
	/** This extension's section of `secrets.json`. */
	readonly secrets: Record<string, string>;
	/** The settings as the declared handle returns them (secrets filled). */
	read(): Promise<Record<string, unknown>>;
	/** Apply a settings-page submission the way core's save does. */
	save(values: Record<string, unknown>): Promise<void>;
}

/** Replace `target`'s contents in place, so captured references stay live. */
function replaceContents(target: Record<string, unknown>, next: Record<string, unknown>): void {
	for (const key of Object.keys(target)) delete target[key];
	Object.assign(target, next);
}

export function createFakeHost(
	initial: {
		settings?: Record<string, unknown>;
		secrets?: Record<string, string>;
	} = {},
): FakeHost {
	let declaration: SettingsDeclaration | undefined;
	let reads = 0;
	const file = structuredClone(initial.settings ?? {});
	const secrets: Record<string, string> = { ...(initial.secrets ?? {}) };
	const declared = (): SettingsDeclaration => {
		if (declaration === undefined) throw new Error("the factory declared no settings");
		return declaration;
	};
	/** The top-level `writeOnly` property names, from core's own generator. */
	const secretNames = (): string[] =>
		generateForm(declared().schema, { idPrefix: SLUG }).secrets.map((secret) => {
			const segments = secret.pattern.split("/").filter((segment) => segment !== "");
			if (segments.length !== 1 || segments[0] === "*") {
				throw new Error(`the fake cannot fill the nested secret path ${secret.pattern}`);
			}
			return segments[0]!;
		});
	const check = (): Record<string, unknown> => {
		const checked = checkStoredSettings(declared().schema, file);
		for (const repair of checked.repairs) {
			console.warn(`settings: ${SLUG}${repair.path}: ${repair.message}; ${repair.action}`);
		}
		const value = structuredClone(checked.value);
		// core: check first, then fill every secret slot the store resolves.
		// The store's value is written unconditionally — a stored value WINS
		// over one the file still carries, the precedence the legacy-key
		// migration relies on. An unresolved slot keeps whatever the check left:
		// "" for an absent secret (defaults.ts fills it), or the file's own
		// value on a pre-rework install.
		for (const name of secretNames()) {
			const stored = secrets[name];
			if (stored !== undefined) value[name] = stored;
		}
		return value;
	};
	const stores: SigrunPluginHost["stores"] = {
		settings: {
			get: async () => structuredClone(file),
			set: async (value) => replaceContents(file, structuredClone(value)),
		},
		secrets: {
			get: async (key) => secrets[key],
			set: async (key, value) => {
				secrets[key] = value;
			},
			delete: async (key) => {
				delete secrets[key];
			},
		},
	};
	const host: SigrunPluginHost = {
		settings: {
			declare<S, U = Record<string, unknown>>(decl: SettingsDeclaration) {
				if (declaration !== undefined) {
					throw new Error("settings.declare may only be called once per extension");
				}
				declaration = decl;
				return {
					get: async () => {
						reads += 1;
						return check() as S;
					},
					user: () => {
						throw new Error("provider-bifrost declares no user schema");
					},
				} as unknown as DeclaredSettings<S, U>;
			},
		},
		stores,
	};
	return {
		host,
		get declaration() {
			return declaration;
		},
		get reads() {
			return reads;
		},
		file,
		secrets,
		read: async () => check(),
		save: async (values) => {
			const names = new Set(secretNames());
			const plain = structuredClone(values);
			for (const name of names) {
				if (!Object.hasOwn(plain, name)) continue;
				const submitted = plain[name];
				delete plain[name];
				if (typeof submitted === "string" && submitted !== "") secrets[name] = submitted;
				else if (submitted === null) delete secrets[name];
			}
			replaceContents(file, plain);
		},
	};
}
