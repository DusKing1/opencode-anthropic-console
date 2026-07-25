import {
  REQUIRED_BETAS,
  TOOL_PREFIX,
  USE_MCP_PREFIX,
  USER_AGENT,
} from "./constants.js"
import { getClaudeIdentity } from "./claude-identity.js"
import { composeClaudeCodeSystem } from "./system-transform.js"

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
  if (url.pathname === "/v1/messages") {
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
// Body rewrite
// ---------------------------------------------------------------------------

function injectMetadata(parsed: AnyRecord, sessionID: string): void {
  const identity = getClaudeIdentity()
  const existing = isRecord(parsed.metadata) ? parsed.metadata : {}
  parsed.metadata = {
    ...existing,
    user_id: JSON.stringify({
      device_id: identity.userID,
      account_uuid: "",
      session_id: sessionID,
    }),
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

function normalizeCacheBreakpoints(parsed: AnyRecord): void {
  delete parsed.cache_control

  if (Array.isArray(parsed.tools)) {
    for (const tool of parsed.tools) {
      if (isRecord(tool)) delete tool.cache_control
    }
  }

  const messageBreakpoints: AnyRecord[] = []
  if (Array.isArray(parsed.messages)) {
    for (const message of parsed.messages) {
      if (!isRecord(message)) continue
      if (message.cache_control != null) messageBreakpoints.push(message)
      if (!Array.isArray(message.content)) continue
      for (const block of message.content) {
        if (isRecord(block) && block.cache_control != null) {
          messageBreakpoints.push(block)
        }
      }
    }
  }

  const removeCount = Math.max(0, messageBreakpoints.length - 2)
  for (let index = 0; index < removeCount; index++) {
    delete messageBreakpoints[index]?.cache_control
  }
}

export function rewriteRequestBody(
  body: string,
  sessionID: string,
): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return body
  }

  if (!isRecord(parsed)) return body
  parsed.system = composeClaudeCodeSystem({
    system: parsed.system,
    model: parsed.model,
    messages: parsed.messages,
  })
  injectMetadata(parsed, sessionID)
  stripForbiddenFields(parsed)
  prefixToolNamesInPlace(parsed)
  normalizeCacheBreakpoints(parsed)
  return JSON.stringify(parsed)
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
