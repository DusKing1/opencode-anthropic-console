import {
  CLAUDE_CODE_IDENTITY,
  OPENCODE_IDENTITY_PREFIX,
  PARAGRAPH_REMOVAL_ANCHORS,
  REQUIRED_BETAS,
  TEXT_REPLACEMENTS,
  TOOL_PREFIX,
  USE_MCP_PREFIX,
  USER_AGENT,
} from "./constants.js"
import { getClaudeIdentity } from "./claude-identity.js"

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

export function mergeHeaders(
  input: RequestInfo | URL,
  init?: RequestInit,
): Headers {
  const headers = new Headers()
  if (input instanceof Request) {
    input.headers.forEach((value, key) => headers.set(key, value))
  }
  const initHeaders = init?.headers
  if (initHeaders) {
    if (initHeaders instanceof Headers) {
      initHeaders.forEach((value, key) => headers.set(key, value))
    } else if (Array.isArray(initHeaders)) {
      for (const [key, value] of initHeaders) {
        if (typeof value !== "undefined") headers.set(key, String(value))
      }
    } else {
      for (const [key, value] of Object.entries(initHeaders)) {
        if (typeof value !== "undefined") headers.set(key, String(value))
      }
    }
  }
  return headers
}

function mergeBetaHeaders(headers: Headers): string {
  const incoming = headers.get("anthropic-beta") ?? ""
  const incomingList = incoming
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean)
  return [...new Set([...REQUIRED_BETAS, ...incomingList])].join(",")
}

/**
 * API-key mode: we keep x-api-key untouched (SDK already populated it from
 * the `apiKey` option) and only *add* the identity headers Claude Code CLI
 * normally sends.
 */
export function setApiKeyHeaders(headers: Headers): Headers {
  headers.set("anthropic-beta", mergeBetaHeaders(headers))
  headers.set("user-agent", USER_AGENT)
  headers.set("x-app", "cli")
  // Claude Code advertises its dangerous-permission posture via this header.
  // Sending a conservative value makes us look like a default install.
  if (!headers.has("anthropic-dangerous-direct-browser-access")) {
    // No-op: this header is unrelated to ours — placeholder for future signals.
  }
  return headers
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function resolveBaseUrl(): URL | null {
  const raw = process.env.ANTHROPIC_BASE_URL?.trim()
  if (!raw) return null
  try {
    const u = new URL(raw)
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) {
      return null
    }
    return u
  } catch {
    return null
  }
}

export function isInsecure(): boolean {
  if (!process.env.ANTHROPIC_BASE_URL?.trim()) return false
  const raw = process.env.ANTHROPIC_INSECURE?.trim()
  return raw === "1" || raw === "true"
}

export function rewriteUrl(
  input: RequestInfo | URL,
): { input: RequestInfo | URL; url: URL | null } {
  let url: URL | null = null
  try {
    if (typeof input === "string" || input instanceof URL) {
      url = new URL(input.toString())
    } else if (input instanceof Request) {
      url = new URL(input.url)
    }
  } catch {
    url = null
  }
  if (!url) return { input, url: null }

  const original = url.href
  const base = resolveBaseUrl()
  if (base) {
    url.protocol = base.protocol
    url.host = base.host
  }
  if (url.pathname === "/v1/messages" && !url.searchParams.has("beta")) {
    url.searchParams.set("beta", "true")
  }
  if (url.href === original) return { input, url }

  const newInput = input instanceof Request ? new Request(url.toString(), input) : url
  return { input: newInput, url }
}

// ---------------------------------------------------------------------------
// Tool name prefixing
// ---------------------------------------------------------------------------

function prefixName(name: string): string {
  const pascal = name.charAt(0).toUpperCase() + name.slice(1)
  return USE_MCP_PREFIX ? `${TOOL_PREFIX}${pascal}` : pascal
}

function unprefixName(name: string): string {
  if (name === "StructuredOutput") return name
  return name.charAt(0).toLowerCase() + name.slice(1)
}

type AnyRecord = Record<string, unknown>

function isRecord(value: unknown): value is AnyRecord {
  return value != null && typeof value === "object" && !Array.isArray(value)
}

function prefixToolNamesInPlace(parsed: AnyRecord): void {
  const tools = parsed.tools
  if (Array.isArray(tools)) {
    parsed.tools = tools.map((tool) => {
      if (!isRecord(tool)) return tool
      const name = typeof tool.name === "string" ? tool.name : undefined
      return name ? { ...tool, name: prefixName(name) } : tool
    })
  }
  const messages = parsed.messages
  if (Array.isArray(messages)) {
    parsed.messages = messages.map((msg) => {
      if (!isRecord(msg)) return msg
      const content = msg.content
      if (!Array.isArray(content)) return msg
      const mapped = content.map((block) => {
        if (!isRecord(block)) return block
        if (block.type === "tool_use" && typeof block.name === "string") {
          return { ...block, name: prefixName(block.name) }
        }
        return block
      })
      return { ...msg, content: mapped }
    })
  }
}

/**
 * The Anthropic streaming response echoes tool names in SSE events. If we
 * prefixed outgoing names we must strip the prefix back out so opencode's
 * tool dispatcher can find the original tool definition.
 */
export function stripToolPrefix(text: string): string {
  if (!USE_MCP_PREFIX) return text
  return text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, (_m, name: string) => `"name": "${unprefixName(name)}"`)
}

// ---------------------------------------------------------------------------
// System prompt sanitization / identity injection
// ---------------------------------------------------------------------------

function sanitizeSystemText(text: string): string {
  const paragraphs = text.split(/\n\n+/)
  const kept = paragraphs.filter((p) => {
    if (p.includes(OPENCODE_IDENTITY_PREFIX)) return false
    for (const anchor of PARAGRAPH_REMOVAL_ANCHORS) {
      if (p.includes(anchor)) return false
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

type SystemBlock = { type: "text"; text: string } & Record<string, unknown>

function prependClaudeCodeIdentity(system: unknown): SystemBlock[] {
  const identityBlock: SystemBlock = { type: "text", text: CLAUDE_CODE_IDENTITY }

  if (system == null) return [identityBlock]

  if (typeof system === "string") {
    const sanitized = sanitizeSystemText(system)
    if (!sanitized || sanitized === CLAUDE_CODE_IDENTITY) return [identityBlock]
    return [identityBlock, { type: "text", text: sanitized }]
  }

  if (isRecord(system)) {
    const text = typeof system.text === "string" ? sanitizeSystemText(system.text) : ""
    return [identityBlock, { ...system, type: "text", text }]
  }

  if (!Array.isArray(system)) return [identityBlock]

  const sanitized: SystemBlock[] = system.map((item) => {
    if (typeof item === "string") return { type: "text", text: sanitizeSystemText(item) }
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
      return { ...item, type: "text", text: sanitizeSystemText(item.text) }
    }
    return { type: "text", text: String(item) }
  })

  if (sanitized[0]?.text === CLAUDE_CODE_IDENTITY) return sanitized
  return [identityBlock, ...sanitized]
}

// ---------------------------------------------------------------------------
// Body rewrite
// ---------------------------------------------------------------------------

function injectMetadata(parsed: AnyRecord): void {
  const identity = getClaudeIdentity()
  const existing = isRecord(parsed.metadata) ? parsed.metadata : {}
  parsed.metadata = {
    ...existing,
    user_id: typeof existing.user_id === "string" && existing.user_id ? existing.user_id : identity.userID,
  }
}

/**
 * Anthropic's Claude-Code-attested path rejects requests that carry a
 * `temperature` field — the official CLI does not send one. We unconditionally
 * drop it here.
 */
function stripForbiddenFields(parsed: AnyRecord): void {
  delete parsed.temperature
}

export function rewriteRequestBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as AnyRecord
    parsed.system = prependClaudeCodeIdentity(parsed.system)
    injectMetadata(parsed)
    stripForbiddenFields(parsed)
    prefixToolNamesInPlace(parsed)
    return JSON.stringify(parsed)
  } catch {
    return body
  }
}

// ---------------------------------------------------------------------------
// Streaming response body — strip the tool-name prefix back out so opencode's
// tool router can match names against its own registry.
// ---------------------------------------------------------------------------

export function createStrippedStream(response: Response): Response {
  if (!response.body) return response
  if (!USE_MCP_PREFIX) return response

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) {
        controller.close()
        return
      }
      const text = decoder.decode(value, { stream: true })
      controller.enqueue(encoder.encode(stripToolPrefix(text)))
    },
  })

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}
