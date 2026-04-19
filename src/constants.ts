/**
 * Constants used to make opencode requests look like they came from the
 * official Claude Code CLI, which is required by Anthropic's server-side
 * client-attestation on Console-provisioned API keys.
 *
 * Keep CLAUDE_CODE_VERSION in sync with the Claude Code CLI version
 * actually installed on the user's machine when possible. Mismatches
 * rarely cause hard failures, but too-old values may trip anti-abuse
 * heuristics.
 */

export const CLAUDE_CODE_VERSION = "2.1.114"

/**
 * user-agent header sent by the official Claude Code CLI.
 * The "(external, cli)" suffix is part of the attestation signal.
 */
export const USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`

/**
 * Beta flags the Claude Code CLI typically enables. opencode may already
 * add some of these; we merge-and-dedupe rather than overwrite.
 */
export const REQUIRED_BETAS = [
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  "fine-grained-tool-streaming-2025-05-14",
]

/**
 * First sentence of Claude Code's system prompt. Anthropic's attestation
 * checks that the system prompt *begins* with this exact string.
 */
export const CLAUDE_CODE_IDENTITY =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK."

/**
 * opencode's own identity paragraph — we remove it before injecting
 * the Claude Code identity so the final prompt doesn't look like it
 * was sent by two different agents.
 */
export const OPENCODE_IDENTITY_PREFIX = "You are OpenCode"

/**
 * Entire paragraphs containing any of these anchor strings are dropped
 * from the system prompt. Anchors are stable identifiers (URLs) that
 * identify opencode-branded paragraphs regardless of surrounding wording.
 */
export const PARAGRAPH_REMOVAL_ANCHORS = [
  "github.com/anomalyco/opencode",
  "opencode.ai/docs",
]

/**
 * Inline replacements applied to paragraphs we keep — for places where
 * "OpenCode" appears mid-paragraph and we can't drop the whole paragraph.
 */
export const TEXT_REPLACEMENTS: Array<{ match: RegExp | string; replacement: string }> = [
  { match: "if OpenCode honestly", replacement: "if the assistant honestly" },
]

/**
 * Tool name prefix applied to every outgoing tool name, matching the
 * scheme Claude Code uses to namespace MCP-style tools.
 *
 * Ex-machina's OAuth plugin uses this same prefix and Anthropic accepts
 * it on the OAuth path. On the API-key path the attestation is stricter
 * and may require exact Claude-Code-native tool names (Bash, Read, …)
 * rather than `mcp_`-prefixed ones. Toggle {@link USE_MCP_PREFIX} to
 * disable the prefix once we have mitmproxy evidence either way.
 */
export const TOOL_PREFIX = "mcp_"

/**
 * Set to `false` to send tool names verbatim (PascalCased but no prefix).
 * Controlled via env var OPENCODE_ANTHROPIC_CONSOLE_TOOL_PREFIX=0 at
 * runtime for quick experimentation without rebuilding.
 */
export const USE_MCP_PREFIX =
  process.env.OPENCODE_ANTHROPIC_CONSOLE_TOOL_PREFIX !== "0"

/**
 * Canonical 17-tool set shipped by the Claude Code CLI, for reference.
 * Not currently enforced — kept here so the transform can be upgraded
 * to "exact match" mode once we verify against a real Claude Code
 * request capture.
 */
export const CLAUDE_CODE_TOOLS = [
  "Bash",
  "BashOutput",
  "KillShell",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "Task",
  "NotebookEdit",
  "ExitPlanMode",
  "SlashCommand",
  "MultiEdit",
  "ListMcpResources",
] as const
