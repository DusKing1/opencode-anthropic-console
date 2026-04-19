# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-04-19

### Added

- Initial release as an **opt-in companion plugin** to
  [`@ex-machina/opencode-anthropic-auth`](https://github.com/ex-machina-co/opencode-anthropic-auth).
  Fills in the Claude Code client-attestation transforms on its
  manual-API-key path for Anthropic Enterprise / Claude-Code-scoped
  keys that require them.
- Activation gate: `auth.type === 'api'` only. OAuth and other auth types
  return `{}` so `@ex-machina/opencode-anthropic-auth` keeps full control
  of its own flows.
- Transform pipeline applied to `/v1/messages` requests:
  - Sets `user-agent: claude-cli/<version> (external, cli)`, `x-app: cli`,
    and the required `anthropic-beta` flags.
  - Appends `?beta=true` to the request URL.
  - Prepends the Claude Code identity block to `system[]` and strips
    opencode-branded paragraphs.
  - Injects `metadata.user_id` from `~/.claude.json` (with env override
    and a deterministic synthetic fallback).
  - Removes the `temperature` field before sending.
  - Prefixes tool names with `mcp_` (PascalCased) and strips the prefix
    back out in streaming SSE responses.
- Ships a minimal stand-alone "Console API Key" login method so the
  plugin remains usable even without `@ex-machina/opencode-anthropic-auth`
  installed.
- Environment-variable knobs: `OPENCODE_ANTHROPIC_CONSOLE_USER_ID`,
  `OPENCODE_ANTHROPIC_CONSOLE_CLAUDE_JSON`,
  `OPENCODE_ANTHROPIC_CONSOLE_TOOL_PREFIX`.

[0.1.0]: https://github.com/DusKing1/opencode-anthropic-console/releases/tag/v0.1.0
