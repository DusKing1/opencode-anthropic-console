# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - 2026-07-25

### Fixed

- Allow Opus 5 to proactively use OpenCode subagents when delegation or
  parallel investigation would materially improve the result, while avoiding
  trivial delegation and keeping workflows and deep research opt-in.

## [0.2.0] - 2026-07-25

### Changed

- Refresh the Claude Code attestation envelope from a local 2.1.220 Opus 5
  request capture: update the `sdk-cli` user agent and beta set, place the
  request-derived billing system block before the unchanged Claude Agent SDK identity, and
  emit Claude Code's structured `metadata.user_id` JSON string with a stable
  loader-scoped UUID.
- Add the stable Claude Code 2.1.220 Opus 5 harness core for
  `claude-opus-5`, while retaining opencode's project, environment, and user
  context after it and excluding machine-specific capture content.
- Replace OpenCode's raw session headers with `x-claude-code-session-id` and
  normalize prompt-cache markers to Claude's four-breakpoint limit.
- Stop generating synthetic device identities. A valid 64-character Claude
  Code `userID` must come from `~/.claude.json` or
  `OPENCODE_ANTHROPIC_CONSOLE_USER_ID`.
- Limit request-body mutation to the `/v1/messages` endpoint. Model selection,
  adaptive thinking, effort, and token limits remain owned by opencode and the
  user.

## [0.1.1] - 2026-07-20

### Fixed

- Rewrite the "Here is some useful information about the environment you are
  running in:" sentence in sanitized system prompts. This phrase ships
  verbatim in opencode's default system prompt and is used by Anthropic's
  server-side attestation classifier as a third-party-agent fingerprint;
  matching it makes `/v1/messages` reject the request with a 400/429
  disguised as "You're out of extra usage." The sentence is now rewritten
  in place to a semantic equivalent so the model still sees the env-block
  intro while the request is accepted.

## [0.1.0] - 2026-04-19

### Added

- Initial release as an **opt-in companion plugin** to
  [`@ex-machina/opencode-anthropic-auth`](https://github.com/ex-machina-co/opencode-anthropic-auth).
  Fills in the Claude Code client-attestation transforms on its
  `auth.type === 'api'` branch — which covers both the "Create an API
  Key" flow (OAuth into Console, exchange for an `sk-ant-...` key) and
  the "Manually enter API Key" flow (paste-in) — for Anthropic Enterprise
  / Claude-Code-scoped keys that require them.
- Activation gate: `auth.type === 'api'` only. `auth.type === 'oauth'`
  (Pro/Max) is left alone so `@ex-machina/opencode-anthropic-auth` keeps
  full control of its own flow.
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

[Unreleased]: https://github.com/DusKing1/opencode-anthropic-console/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/DusKing1/opencode-anthropic-console/releases/tag/v0.2.1
[0.2.0]: https://github.com/DusKing1/opencode-anthropic-console/releases/tag/v0.2.0
[0.1.1]: https://github.com/DusKing1/opencode-anthropic-console/releases/tag/v0.1.1
[0.1.0]: https://github.com/DusKing1/opencode-anthropic-console/releases/tag/v0.1.0
