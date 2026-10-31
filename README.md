# @sigrun/provider-bifrost

A [sigrun](https://github.com/sigrun-ai) provider plugin: a
[Bifrost](https://github.com/maximhq/bifrost) LLM gateway as one dynamic
chat provider. Ported from
[pi-bifrost-gateway](https://github.com/MacLeodMike/pi-bifrost-gateway)
0.3.0 (`5d15a28`). All failover, key selection, and routing happens in
Bifrost — this plugin never routes anything itself.

## What it contributes

A **provider-only contributor** — the default export is a factory
returning `{ name: "provider-bifrost", providers: [{ provider, readiness }],
health }` with no pi-durable extension surface. Sigrun's loader merges
the provider into its `Models` store at boot.

- **Provider** `bifrost` — dynamic catalog over `openai-completions`
  (plus optional per-family native surfaces, below). Two discovery
  modes, picked by the settings `publishChains` flag:
  - **member-only mode (default, `publishChains: false`)** — a single
    `GET <base>/models` with the virtual key, publishing every upstream
    as a direct-selectable `provider/model` entry with real per-member
    rates. **Zero management-plane calls** — works against a stock
    gateway with governance disabled entirely.
  - **chains mode (`publishChains: true`)** — the management plane is
    queried too: the VK self-identifies against
    `/api/governance/virtual-keys` (the credential value matched to VK
    rows), then `/api/routing/rules?scope=virtual_key&scope_id=<vk>`
    yields the chain rules; every usable chain publishes with plugin id
    `chain/<name>` (displayed by sigrun as `bifrost/chain/<name>`, with
    min-member context window and cost 0 by design). Requests to the
    gateway carry the bare `<name>`, never the `chain/` display prefix.
    The gateway's own `/api/logs` is the billing system of record,
    optionally followed by the upstream catalog (`publishUpstream`,
    default true). Upstream `/v1/models` entries under the reserved
    `chain/` namespace are skipped as direct members.
- **Readiness** (`not_configured` / `degraded` / `ready`, surfaced on
  sigrun's `/v1/auth/check`) — seeded from credential resolution and
  updated per refresh outcome; state transitions log via `console.warn`
  (transitions only, never per failure).
- **Health** — `degraded` only when the provider is configured and its
  last refresh failed; an unconfigured optional plugin reports `ok`.

## Settings

Read **once at factory time** from the plugin's scoped settings —
`settings/provider-bifrost.json` in the sigrun config dir — and **baked
into the provider**; applying a change requires a restart (sigrun's
loader pre-keys the factory host on the provisional slug, so the
factory-time read resolves this file). Absent file = defaults.
Wrong-typed values and unknown keys warn and fall back — never fatal.

```jsonc
// settings/provider-bifrost.json
{
	"baseUrl": "https://your-bifrost.example/v1", // settings wins, then BIFROST_BASE_URL
	"publishChains": false,   // chains mode when true (needs management plane)
	"publishUpstream": true,  // upstream catalog entries (both modes)
	"managementApiKey": "…",  // /api/* bearer; falls back to the VK
	"thinkingOverrides": {    // per-member ladders keyed "provider/model";
		"acme/model-x": ["low", "high"] // replaces the full default ladder
	},
	"nativeProtocols": {      // both default false = chat completions everywhere
		"responses": true,   // gpt-family → openai-responses
		"messages": true,    // claude-family → anthropic-messages at <root>/anthropic
		"responsesModels": ["gpt-6-luna"], // exact-name lists REPLACE the heuristic
		"messagesModels": ["claude-sonnet-5-5"]
	}
}
```

**Plaintext caveat:** this settings file is plain JSON — it has none of
`auth.json`'s `0600` discipline. That is consistent with sigrun's
operator-provisioned-plaintext posture: `managementApiKey` is
provisioned by the operator into the config dir exactly like
`settings.json` itself, and anything needing secret-handling semantics
belongs in the VK (`auth.json` / `BIFROST_API_KEY`) instead — the
management plane deliberately falls back to the VK when no separate key
is set.

### Native protocol surfaces

With both `nativeProtocols` toggles off (the default), every model
publishes chat completions — the only wire every Bifrost serves. With a
toggle on, the model **NAME** (never the serving prefix) picks the
wire: `claude-*` → `anthropic-messages` at `<gateway-root>/anthropic`
(the Anthropic SDK appends `/v1/messages` itself), `gpt(?!-oss)`/`o\d`/
`codex` → `openai-responses` on the `/v1` base, everything else —
including `gpt-oss`, an open-weight model — stays completions. Setting
the paired exact-name list replaces the built-in heuristic for that
surface. Per-surface thinking-compat pins ship as in the pi port
(`off: null` + `forceAdaptiveThinking` on anthropic, `off: "none"` on
responses, `off: "off"` on completions).

## Credentials

Resolved per request through sigrun's auth.json bridge, falling back to
the ambient environment:

1. the bridged auth.json credential (`"default"` entry, then the
   `"bifrost"` entry), then
2. `BIFROST_API_KEY`.

The base URL resolves settings-`baseUrl` first, then the ambient
`BIFROST_BASE_URL`. Both env reads go through sigrun's env seam — the
plugin never reads auth.json or `process.env` itself. There is **no
/login flow** (the pi port's interactive login has no sigrun analog);
rotating the key or the env URL applies on the next resolution — no
restart. Settings changes DO need a restart (baked at factory time).

`managementApiKey` comes from scoped settings only and is used as the
bearer on `/api/*` (VK lookup + routing rules); the inference catalog
always uses the VK itself. When unset, the VK serves the management
plane too — the right shape for dashboard-auth-disabled deployments.

## Failure semantics

`fetchModels` **throws** — it never returns an empty array, which pi-ai
would publish and persist, wiping the catalog — on: unconfigured (no
key or no base URL), a credential matching no VK (chains mode), zero
usable chain rules (chains mode), both publish flags off, and any
discovery failure (unreachable gateway, schema mismatch). A failed
refresh retains the previous catalog and records a per-provider error;
the provider still boots unconfigured with an empty baseline catalog
and `not_configured` readiness.

## Install

```jsonc
// settings.json (sigrun config dir) — the UNIFIED extensions list:
// install + load in one place; npm and git specifiers are the same list
// npm ("@sigrun/provider-bifrost@^0.2.0"), git
// ("git:github.com/sigrun-ai/sigrun-provider-bifrost", or any
// https git URL with an optional @ref), or the file: form below.
{
	"extensions": ["file:/path/to/sigrun-bifrost"]
}
```

The committed `dist/` is the load target for git installs; pi-ai and
pi-durable are peerDependencies (sigrun supplies them at runtime);
they are mirrored in devDependencies for this repo's own build and tests.

## Development

```sh
npm install        # also builds dist/ via prepare
npm test           # vitest — hermetic fixture gateway server, no network
npm run typecheck
npm run build
```

## License

MIT
