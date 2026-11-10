# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Settings are declared as JSON Schema** (`src/settings-schema.ts`) through
  `host.settings.declare`, so sigrun's extension page draws the form and core
  applies the defaults and repairs a malformed stored value (load-time warning).
  The hand-written parser (`src/config.ts`) and its
  suite are gone; the TypeScript settings type is the schema's `Static`.
  Every key is `restart`: the factory still reads the surface once and bakes
  it into the provider. Defaults are unchanged — `publishChains` false,
  `publishUpstream` true, no `baseUrl`, both native surfaces off.
- Posture: a malformed `baseUrl` no longer reaches the client — it is repaired
  away and the ambient `BIFROST_BASE_URL` applies. A value padded with
  whitespace counts as malformed (the old parser trimmed it); strictness is
  now the schema's `format: "uri"`. Exact-name lists are
  trimmed, de-duplicated, and dropped when nothing usable is left (an empty
  list would mean "no model matches", not "use the heuristic"). A
  `thinkingOverrides` entry keeps the parser's all-or-nothing rule: one
  unknown level and that member keeps its full ladder.
- Peers: `@sigrun/sigrun >=0.13.0` (the release carrying
  `host.settings.declare`), `typebox` `1.3.27` promoted to a peer as well as
  the dev pin. The core dev dependency is the REGISTRY release rather than a
  sibling link, because this repo's CI runs without a core checkout.

### Security

- **`managementApiKey` moved out of the settings file.** It is now a
  `writeOnly` property: the value lives in this extension's section of
  sigrun's `secrets.json` (key `managementApiKey`) and is never written back
  to `settings/provider-bifrost.json`. A pre-rework file that still carries
  the key keeps working — the factory moves the value into the secrets store
  on the first boot that sees it and strips it from the file (a value already
  stored wins), so the plaintext copy disappears without a manual edit.

### Added

- `BIFROST_MANAGEMENT_API_KEY` — ambient management-plane credential, read
  through sigrun's env seam at credential resolution. Precedence is the
  settings secret, then this variable, then the virtual key.

## [0.2.3] - 2026-11-08

- CI: grant actions: read to the release workflow (the release-test skip lookup). No code change.

## [0.2.2] - 2026-11-07

## [Unreleased]

### Changed

- peer pi-durable/pi-ai/chord ~1.5.0 (requires sigrun 0.11.0).

## [0.1.1] - 2026-10-27
### Changed
- Re-released through CI trusted publishing; this version carries SLSA
  provenance. No functional change from 0.1.0.

## [Unreleased]

## [0.2.1] - 2026-11-03
### Fixed
- Replies from chain models persist the `chain/` display id, so clients can
  show where a message came from. Outgoing history is replayed under the
  wire name, so chain models keep their thinking blocks and signatures.
  Usage is now keyed `bifrost/chain/<name>`; earlier usage stays under
  `bifrost/<name>`.

## [0.2.0] - 2026-10-30
### Changed
- **Breaking:** chain model references change from `bifrost/bifrost/<chain>`
  to `bifrost/chain/<chain>` (plugin id `chain/<chain>`). The gateway
  receives the bare chain name.
- Member ids are unchanged; upstream catalog entries in the reserved
  `chain/` display namespace are skipped with one warning per process.
- Forward-compatible with pi-durable 1.4.0 (widened peer range).

## [0.1.0] - 2026-10-18
### Changed
- Renamed to `@sigrun/provider-bifrost` for the 0.1.0 release (GitHub
  repo `sigrun-ai/sigrun-provider-bifrost`): published package metadata
  (`publishConfig` access/provenance), host modules
  (`@earendil-works/pi-ai`, `@earendil-works/pi-durable`, `typebox`)
  moved to `peerDependencies` mirrored in `devDependencies` at exact
  pins, CHANGELOG.md joined the files whitelist, and a manifest hygiene
  check wired into `npm test`. The contributor identity follows the
  package slug: the factory result's `name` becomes `provider-bifrost`
  and the scoped settings file `settings/provider-bifrost.json` (the
  loader pre-keys the two-phase host from the package name; a stale
  declared name would split the factory-time settings scope).
### Added
- Sigrun provider plugin for a Bifrost LLM gateway, ported from
  pi-bifrost-gateway 0.3.0 (`5d15a28`): provider-only contributor
  (`{ name: "provider-bifrost", providers: [{ provider, readiness }],
  health }`), `provider: "bifrost"` stamped on every published model so
  persisted catalogs survive cold-boot restore.
- Two discovery modes: member-only (default, `publishChains: false` —
  single `/v1/models` fetch, ZERO management-plane calls, stock-gateway
  compatible) and chains (`publishChains: true` — VK self-identification
  via `/api/governance/virtual-keys` + chain rules via
  `/api/routing/rules`, chains published as `bifrost/<chain>` with
  min-member context windows and cost 0).
- Scoped-settings configuration (`settings/provider-bifrost.json`), read
  once at factory time (restart-required): `baseUrl`, `publishChains`
  (default false), `publishUpstream` (default true),
  `managementApiKey`, `thinkingOverrides`, `nativeProtocols`
  (`responses`/`messages` toggles + exact-name lists replacing the
  built-in family heuristic; both default false — chat completions
  everywhere). No /login flow.
- Native protocol surfaces ported exactly: model NAME decides the family
  (never the serving prefix); claude → `anthropic-messages` at
  `<gateway-root>/anthropic` with the `forceAdaptiveThinking` pin and
  `off: null` ladder; gpt(?!-oss)/o\d/codex → `openai-responses` with
  `off: "none"`; everything else chat completions with `off: "off"`.
- TEXT_ONLY denylist ported (glm-5.3, deepseek-v4-flash/pro + snapshot
  ids; exact bare-name matching so vision-capable siblings keep image
  input).
- Credentials through sigrun's auth.json bridge with `BIFROST_API_KEY`
  as the ambient fallback; base URL settings-first with
  `BIFROST_BASE_URL` ambient fallback (env reads via the injected seam,
  never `process.env`).
- `fetchModels` throws on unconfigured / VK mismatch / zero chains /
  both-flags-off / discovery failure — never returns `[]` (an empty
  array would publish and wipe the persisted catalog).
- Three-state readiness tracker (`not_configured` / `degraded` /
  `ready`) seeded from credential resolution and updated per refresh
  outcome; `console.warn` on state transitions only. `health()` maps
  `not_configured` to `"ok"` and configured-and-failing to `"degraded"`.
