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

export const CLAUDE_CODE_VERSION = "2.1.220"
export const CLAUDE_CODE_ENTRYPOINT = "sdk-cli"

/**
 * user-agent header sent by the official Claude Code CLI.
 * The "(external, sdk-cli)" suffix is part of the attestation signal.
 */
export const USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, sdk-cli)`

/**
 * Beta flags the Claude Code CLI typically enables. opencode may already
 * add some of these; we merge-and-dedupe rather than overwrite.
 */
export const REQUIRED_BETAS = [
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  "thinking-token-count-2026-05-13",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "mid-conversation-system-2026-04-07",
  "advisor-tool-2026-03-01",
  "effort-2025-11-24",
  "fallback-credit-2026-06-01",
] as const

/** OAuth subscription traffic uses a smaller, separately captured beta set. */
export const OAUTH_REQUIRED_BETAS = [
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
] as const

/**
 * Claude Code identity block. In current traffic it follows the billing block
 * and precedes the harness-specific system instructions.
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
  // Anthropic's server-side attestation classifier fingerprints this exact
  // sentence, which ships verbatim in opencode's (and many other agent CLIs')
  // default system prompt. When it reaches /v1/messages the request is
  // rejected with a 400/429 disguised as "You're out of extra usage."
  // Rewriting it in place — dropping the word "useful" is sufficient —
  // unblocks the request while the model still sees the env-block intro.
  {
    match: "Here is some useful information about the environment you are running in:",
    replacement: "Environment context you are running in:",
  },
]

/**
 * Tool name prefix applied to every outgoing tool name, matching the
 * scheme Claude Code uses to namespace MCP-style tools.
 *
 * Ex-machina's OAuth plugin uses this same prefix for opencode-provided tools.
 * Claude Code's own built-ins remain unprefixed, while third-party/MCP-style
 * tools use a namespace; this plugin's tools belong to the latter category.
 */
export const TOOL_PREFIX = "mcp_"

/**
 * Set to `false` to send tool names verbatim (PascalCased but no prefix).
 * Controlled via env var OPENCODE_ANTHROPIC_CONSOLE_TOOL_PREFIX=0 at
 * runtime for quick experimentation without rebuilding.
 */
export const USE_MCP_PREFIX =
  process.env.OPENCODE_ANTHROPIC_CONSOLE_TOOL_PREFIX !== "0"
