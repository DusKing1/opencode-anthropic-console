# opencode-anthropic-console

[![npm](https://img.shields.io/npm/v/opencode-anthropic-console.svg)](https://www.npmjs.com/package/opencode-anthropic-console)
[![license](https://img.shields.io/github/license/DusKing1/opencode-anthropic-console)](./LICENSE)

An **opt-in companion plugin** for [`@ex-machina/opencode-anthropic-auth`](https://github.com/ex-machina-co/opencode-anthropic-auth). It fills in the Claude Code client-attestation transforms for the subset of `sk-ant-api03-...` keys that require them — typically Anthropic Enterprise / Claude-Code-scoped keys.

Both of `@ex-machina/opencode-anthropic-auth`'s API-key-oriented login flows — **"Create an API Key"** (which OAuths into Console and exchanges for an `sk-ant-...` key) and **"Manually enter API Key"** (paste-in) — end up with the credential stored as `auth.type === 'api'`, and `@ex-machina/opencode-anthropic-auth`'s request-time loader is a no-op on that branch. For regular Console keys that's fine; for attestation-strict keys every request silently fails with `429 rate_limit_error: "Error"`.

This plugin is **not a replacement** for `@ex-machina/opencode-anthropic-auth`. Install it alongside only if you need it.

## Do I need this?

You need this plugin **only if all of the following are true**:

1. Your opencode Anthropic credential is an API key — either via `@ex-machina/opencode-anthropic-auth`'s **"Create an API Key"** flow (OAuth into Console, exchange for an `sk-ant-...` key) or its **"Manually enter API Key"** option (paste-in). Both end up stored as `auth.type === 'api'`. (Pro/Max OAuth is unaffected — `@ex-machina/opencode-anthropic-auth` handles that itself.)
2. Your requests come back with `429 rate_limit_error: "Error"` (the literal word `"Error"`, not a real rate-limit message).

That error is Anthropic's server-side attestation rejection. It's the signal that your key is Claude-Code-scoped / Enterprise-scoped and enforces strict client fingerprinting. In that case, **install this plugin alongside `@ex-machina/opencode-anthropic-auth`**.

If your API key already works without this plugin (most regular Console keys do), **you don't need it. Skip it.**

## Why `@ex-machina/opencode-anthropic-auth` alone isn't enough for attested keys

`@ex-machina/opencode-anthropic-auth`'s `loader` gates every transform on `auth.type === 'oauth'`. That's true only for **Claude Pro/Max** — the one flow where opencode stores an OAuth access/refresh token pair as the credential.

Its two API-key flows are different:

- **"Create an API Key"** runs an OAuth handshake against Console and then immediately exchanges the access token for a long-lived `sk-ant-api03-...` key. The exchanged key is what gets stored. At request time, `auth.type === 'api'`.
- **"Manually enter API Key"** stores the pasted key directly. At request time, `auth.type === 'api'`.

In both cases the loader falls through to `return {}` — no transforms, no header spoofing, no system-prompt rewrite, no `?beta=true`, no tool-name prefixing. **This is by design**: for regular Console keys there's no attestation to satisfy. For Enterprise / Claude-Code-scoped keys, though, it leaves every request un-fingerprinted, and Anthropic's server rejects them.

This plugin activates only on `auth.type === 'api'` and applies the missing pipeline, leaving Pro/Max OAuth completely untouched.

## Scope / matrix

| Login flow | Stored `auth.type` | `@ex-machina/opencode-anthropic-auth` | This plugin |
|---|---|---|---|
| Claude Pro/Max | `oauth` | full transforms | skipped (`return {}`) |
| **Create an API Key** | `api` | **passthrough, no transforms** | **full transforms** |
| **Manually enter API Key** | `api` | **passthrough, no transforms** | **full transforms** |

Because each plugin activates on a distinct `auth.type`, they never collide at the request level.

## Why not just open a PR to `@ex-machina/opencode-anthropic-auth`?

Fair question. The short answer is that this plugin's behavior is **incompatible with the upstream's design contract** for its `auth.type === 'api'` branch (which covers both the "Create an API Key" and "Manually enter API Key" flows), so merging upstream would regress every existing user of those flows.

The concrete incompatibilities:

1. **Upstream's passthrough is intentional, not missing.** For `auth.type === "api"`, `@ex-machina/opencode-anthropic-auth` returns `{}` on purpose. Regular Console keys (`sk-ant-api03-...`) work fine without any transforms — so the plugin deliberately stays out of the way. Turning attestation transforms on for everyone upstream would silently change behavior for people whose keys currently work, for zero benefit to them and non-zero risk of breakage.

2. **Body mutation of user-facing fields.** This plugin strips `temperature` from every request (Claude Code never sends one, and strict-attestation servers reject requests that do). The upstream doesn't touch `temperature`. Doing this upstream would silently drop a field users might legitimately be setting.

3. **Home-directory file I/O.** This plugin reads `~/.claude.json` on every request to resolve `metadata.user_id`. The upstream has no such dependency. Adopting it upstream would add a new side channel ("plugin reads files outside the project") that a general-purpose auth plugin probably shouldn't have by default.

4. **Extra headers.** This plugin sends `x-app: cli`; the upstream doesn't. Anthropic's server behavior can differ based on header presence, so adding it upstream risks regressing the OAuth flow that currently works.

5. **Experimental A/B knobs.** `OPENCODE_ANTHROPIC_CONSOLE_TOOL_PREFIX=0` exists to probe Anthropic's attestation rules (exact tool-name matching vs `mcp_` prefixing). That kind of experimental churn doesn't belong in a stable, widely-depended-on auth plugin.

6. **Release cadence.** Strict-attestation rules change on Anthropic's side with no notice. A side-car plugin can iterate on `CLAUDE_CODE_VERSION`, tool-name maps, and system-prompt anchors at its own pace without coordinating every tweak through the upstream's review cycle.

So the split isn't a fork or a disagreement — it's the right shape for the problem. Each plugin owns a distinct `auth.type` branch, they cooperate by construction, and the user opts into the extra behavior by installing an extra package. If `@ex-machina/opencode-anthropic-auth` ever decides to cover attested API keys natively (e.g. behind an explicit opt-in flag), this plugin can simply be deprecated — publishing it as a separate package doesn't block that merge.

## Requirements

- opencode with the v1 plugin API (`@opencode-ai/plugin`)
- Node `>= 20`
- `@ex-machina/opencode-anthropic-auth` installed alongside (so its "Manually enter API Key" menu entry exists and so its OAuth flows keep working)
- A working Claude Code install is optional but recommended — see [Identity source](#identity-source)

## Install

This plugin is designed to be installed **together with `@ex-machina/opencode-anthropic-auth`**.

### From npm (once published)

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugin": [
    "opencode-anthropic-console",
    "@ex-machina/opencode-anthropic-auth"
  ]
}
```

### From a local checkout

```bash
git clone https://github.com/DusKing1/opencode-anthropic-console.git
cd opencode-anthropic-console
npm install
npm run build
```

```jsonc
{
  "plugin": [
    "file:///absolute/path/to/opencode-anthropic-console",
    "@ex-machina/opencode-anthropic-auth"
  ]
}
```

On Windows, use forward slashes or escape the backslashes:

```jsonc
{
  "plugin": [
    "file:///D:/GitHub/opencode-anthropic-console",
    "@ex-machina/opencode-anthropic-auth"
  ]
}
```

### About plugin order

opencode deduplicates each plugin's `auth.methods` array by provider ID, so **the last plugin to register for `anthropic` wins the `opencode auth login anthropic` menu**. Listing `@ex-machina/opencode-anthropic-auth` **after** this plugin (as shown above) lets its richer menu (Claude Pro/Max, Create an API Key, Manually enter API Key) drive the login flow. Both plugins' loaders still run regardless of order, so the attestation transforms still apply on the `auth.type === 'api'` branch.

This plugin also ships a minimal stand-alone "Console API Key" login method so it remains usable without `@ex-machina/opencode-anthropic-auth` installed — but the recommended deployment is both plugins together.

## Usage

1. Get your API key from <https://console.anthropic.com/> (including Enterprise / Claude-Code-scoped keys).
2. Authenticate opencode:

   ```bash
   opencode auth login anthropic
   # pick "Create an API Key" or "Manually enter API Key" (both via @ex-machina/opencode-anthropic-auth)
   # or "Console API Key" (this plugin's fallback)
   # paste your sk-ant-api03-... key
   ```

   Or set it via environment:

   ```bash
   export ANTHROPIC_API_KEY=sk-ant-api03-...
   ```

3. Start opencode and pick an `anthropic/claude-*` model. Outgoing requests now carry the Claude Code attestation signature.

## Identity source

Anthropic's attestation requires a `metadata.user_id` on every request. This plugin resolves one in the following order (first hit wins, result is cached):

1. `OPENCODE_ANTHROPIC_CONSOLE_USER_ID` env var
2. `userID` field in `~/.claude.json` (written automatically by the Claude Code CLI on first login)
3. A deterministic synthetic value derived from `$USERNAME`/`$HOSTNAME` (fallback — prefer the real Claude Code value)

If you don't run Claude Code on this machine, run it once (`claude -p hi`) to create the file, or set the env var manually:

```bash
export OPENCODE_ANTHROPIC_CONSOLE_USER_ID=$(jq -r .userID ~/.claude.json)
```

You can also override the config path:

```bash
export OPENCODE_ANTHROPIC_CONSOLE_CLAUDE_JSON=/custom/path/.claude.json
```

## What this plugin actually does

Activation gate: **only** when `auth.type === "api"`. All other auth types pass through untouched, so `@ex-machina/opencode-anthropic-auth` keeps full control of its OAuth flows.

On every outgoing request to `/v1/messages`:

| Transform | Reason |
|-----------|--------|
| Set `user-agent: claude-cli/<version> (external, cli)` | Claude Code CLI identity |
| Set `x-app: cli` | Distinguishes CLI traffic from web Claude (not sent by `@ex-machina/opencode-anthropic-auth`) |
| Merge `anthropic-beta` with Claude Code's required beta flags | Matches Claude Code's feature surface |
| Append `?beta=true` to the URL | Claude Code always sends this |
| Prepend the Claude Code identity block to `system[]` | The first paragraph of `system` must be Claude Code's identity |
| Strip opencode-branded paragraphs from `system[]` | Otherwise two agents appear to speak |
| Inject `metadata.user_id` | Required by attestation (not injected by `@ex-machina/opencode-anthropic-auth`) |
| Remove `temperature` from the body | Claude Code never sends one; strict-attestation servers reject it |
| Prefix tool names with `mcp_` + PascalCase (e.g. `mcp_Bash`) | Matches Claude Code's tool naming convention |
| Strip the `mcp_` prefix from streaming SSE responses | So opencode's tool router recognises the names |

Keeps `x-api-key` as-is (standard Console key auth).

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPENCODE_ANTHROPIC_CONSOLE_USER_ID` | — | Override `metadata.user_id` |
| `OPENCODE_ANTHROPIC_CONSOLE_CLAUDE_JSON` | `~/.claude.json` | Override Claude Code config path |
| `OPENCODE_ANTHROPIC_CONSOLE_TOOL_PREFIX` | `1` | Set to `0` to send tool names **without** the `mcp_` prefix (for A/B testing attestation) |
| `ANTHROPIC_BASE_URL` | — | Route requests to a proxy or custom gateway |
| `ANTHROPIC_INSECURE` | — | `1`/`true` to skip TLS verification when `ANTHROPIC_BASE_URL` is set |

## Troubleshooting

**Request still fails with `429 rate_limit_error: "Error"`** — Attestation is rejecting some part of the request. Confirm:
- The plugin is installed and loaded (check `opencode` logs for plugin init).
- `metadata.user_id` is a 64-character hex string (copy from `~/.claude.json`).
- Your `CLAUDE_CODE_VERSION` isn't too stale — see [Roadmap](#roadmap).
- Capture the outgoing request with mitmproxy and diff against a real `claude -p hi` invocation.

**`401 invalid x-api-key`** — The key is wrong or was issued as an OAuth-tied key. Re-issue a Console API key.

**`400 metadata.user_id` error** — The synthetic fallback produced an invalid shape. Set `OPENCODE_ANTHROPIC_CONSOLE_USER_ID` explicitly.

**`400 tools does not match`** — Attestation may now require the literal Claude Code tool names instead of opencode's names prefixed with `mcp_`. Try `OPENCODE_ANTHROPIC_CONSOLE_TOOL_PREFIX=0`; if still failing, Claude Code's tool set and opencode's have diverged and deeper name remapping is needed (see Roadmap).

## Verifying against real Claude Code traffic

The quickest way to audit this plugin's output is to sit both opencode and `claude` behind mitmproxy:

```bash
# Terminal 1
mitmproxy

# Terminal 2 — reference capture
HTTPS_PROXY=http://127.0.0.1:8080 claude -p "say hi"

# Terminal 3 — same via opencode
HTTPS_PROXY=http://127.0.0.1:8080 opencode
```

Any field present in the Claude Code capture but missing or different in the opencode capture is a bug here.

## Roadmap

- [ ] Generate `x-anthropic-billing-header` (`cc_version` / `cc_entrypoint` / `cch`) — `@ex-machina/opencode-anthropic-auth` emits this on OAuth; attestation-strict keys may require it too
- [ ] Exact Claude Code tool-name matching (not just `mcp_` prefixing)
- [ ] Periodic self-test that diffs against a recorded Claude Code reference capture
- [ ] Auto-refresh `CLAUDE_CODE_VERSION` from the installed Claude Code CLI

## Acknowledgements

Transform logic is a clean-room re-implementation informed by [`@ex-machina/opencode-anthropic-auth`](https://github.com/ex-machina-co/opencode-anthropic-auth) and by public HackerNews discussion of Anthropic's Claude Code attestation.

## License

MIT — see [LICENSE](./LICENSE).
