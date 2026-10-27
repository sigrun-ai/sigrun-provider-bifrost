# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-10-27
### Changed
- Re-released through CI trusted publishing; this version carries SLSA
  provenance. No functional change from 0.1.0.

## [Unreleased]

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
