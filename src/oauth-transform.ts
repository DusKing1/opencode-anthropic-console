import { OAUTH_REQUIRED_BETAS, USER_AGENT } from "./constants.js"
import { composeClaudeCodeOAuthSystem } from "./system-transform.js"
import {
  isRecord,
  prefixToolNamesInPlace,
  resolveBaseUrl,
} from "./transform.js"

function mergeOAuthBetas(headers: Headers): string {
  const incoming = (headers.get("anthropic-beta") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
  return [...new Set([...OAUTH_REQUIRED_BETAS, ...incoming])].join(",")
}

export function setOAuthHeaders(headers: Headers, access: string): Headers {
  headers.set("anthropic-beta", mergeOAuthBetas(headers))
  headers.set("authorization", `Bearer ${access}`)
  headers.set("user-agent", USER_AGENT)
  headers.delete("x-api-key")
  headers.delete("x-app")
  headers.delete("x-claude-code-session-id")
  return headers
}

export function isAllowedOAuthUrl(url: URL | null): boolean {
  if (!url) return false
  const base = resolveBaseUrl()
  return url.origin === (base?.origin ?? "https://api.anthropic.com")
}

export function rewriteOAuthRequestBody(body: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return body
  }

  if (!isRecord(parsed)) return body
  parsed.system = composeClaudeCodeOAuthSystem({
    system: parsed.system,
    model: parsed.model,
    messages: parsed.messages,
  })
  prefixToolNamesInPlace(parsed)
  return JSON.stringify(parsed)
}
