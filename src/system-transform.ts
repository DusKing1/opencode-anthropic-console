import {
  CLAUDE_CODE_IDENTITY,
  OPENCODE_IDENTITY_PREFIX,
  PARAGRAPH_REMOVAL_ANCHORS,
  TEXT_REPLACEMENTS,
} from "./constants.js"
import {
  buildClaudeCodeBillingHeader,
  CLAUDE_CODE_OPUS_5_HARNESS,
  CLAUDE_CODE_OPUS_5_MODEL,
} from "./claude-code-profile.js"

type SystemBlock = { type: "text"; text: string } & Record<string, unknown>

export type ClaudeCodeSystemInput = {
  readonly system: unknown
  readonly model: unknown
  readonly messages: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
}

function sanitizeSystemText(text: string): string {
  if (text === CLAUDE_CODE_OPUS_5_HARNESS) return ""

  const paragraphs = text.split(/\n\n+/)
  const kept = paragraphs.filter((paragraph) => {
    const trimmed = paragraph.trim()
    if (trimmed === CLAUDE_CODE_IDENTITY) return false
    if (trimmed.startsWith("x-anthropic-billing-header:")) return false
    if (paragraph.includes(OPENCODE_IDENTITY_PREFIX)) return false
    for (const anchor of PARAGRAPH_REMOVAL_ANCHORS) {
      if (paragraph.includes(anchor)) return false
    }
    return true
  })
  let result = kept.join("\n\n")
  for (const rule of TEXT_REPLACEMENTS) {
    if (typeof rule.match === "string") {
      result = result.split(rule.match).join(rule.replacement)
    } else {
      result = result.replace(rule.match, rule.replacement)
    }
  }
  return result.trim()
}

function extractFirstUserText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined

  for (const message of messages) {
    if (!isRecord(message) || message.role !== "user") continue
    if (typeof message.content === "string") return message.content
    if (!Array.isArray(message.content)) return undefined

    for (const block of message.content) {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        return block.text
      }
    }
    return undefined
  }

  return undefined
}

function buildSystemPrefix(
  model: unknown,
  billingHeader: string,
  includeHarness: boolean,
): SystemBlock[] {
  const prefix: SystemBlock[] = [{ type: "text", text: billingHeader }]
  prefix.push({
    type: "text",
    text: CLAUDE_CODE_IDENTITY,
    cache_control: { type: "ephemeral" },
  })
  if (includeHarness && model === CLAUDE_CODE_OPUS_5_MODEL) {
    prefix.push({
      type: "text",
      text: CLAUDE_CODE_OPUS_5_HARNESS,
      cache_control: { type: "ephemeral" },
    })
  }
  return prefix
}

function composeSystem(
  input: ClaudeCodeSystemInput,
  includeHarness: boolean,
): SystemBlock[] {
  const billingHeader = buildClaudeCodeBillingHeader(
    extractFirstUserText(input.messages) ?? "",
  )
  const prefix = buildSystemPrefix(input.model, billingHeader, includeHarness)
  if (input.system == null) return prefix

  if (typeof input.system === "string") {
    const sanitized = sanitizeSystemText(input.system)
    return sanitized ? [...prefix, { type: "text", text: sanitized }] : prefix
  }

  if (isRecord(input.system)) {
    const text =
      typeof input.system.text === "string"
        ? sanitizeSystemText(input.system.text)
        : ""
    if (!text) return prefix
    const retained: SystemBlock = { ...input.system, type: "text", text }
    delete retained.cache_control
    return [...prefix, retained]
  }

  if (!Array.isArray(input.system)) return prefix

  const sanitized: SystemBlock[] = []
  for (const item of input.system) {
    if (typeof item === "string") {
      const text = sanitizeSystemText(item)
      if (text) sanitized.push({ type: "text", text })
      continue
    }
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
      const text = sanitizeSystemText(item.text)
      if (text) {
        const retained: SystemBlock = { ...item, type: "text", text }
        delete retained.cache_control
        sanitized.push(retained)
      }
    }
  }
  return [...prefix, ...sanitized]
}

export function composeClaudeCodeSystem(input: ClaudeCodeSystemInput): SystemBlock[] {
  return composeSystem(input, true)
}

export function composeClaudeCodeOAuthSystem(input: ClaudeCodeSystemInput): SystemBlock[] {
  return composeSystem(input, false)
}
