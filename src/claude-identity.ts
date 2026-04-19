import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Claude Code stores its account snapshot in ~/.claude.json. The relevant
 * fields for request attestation are:
 *
 *   - userID:          64-char hex; sent as metadata.user_id
 *   - oauthAccount.*:  organizationUuid, accountUuid, emailAddress, etc.
 *
 * We read the file lazily and cache the result. If the file is missing
 * or malformed we fall back to environment variables and finally to
 * synthesised values so the plugin never hard-crashes on a fresh box.
 */

export type ClaudeIdentity = {
  userID: string
  accountUuid?: string
  organizationUuid?: string
  emailAddress?: string
}

let cached: ClaudeIdentity | null = null

function configPath(): string {
  const override = process.env.OPENCODE_ANTHROPIC_CONSOLE_CLAUDE_JSON
  if (override && override.trim()) return override.trim()
  return join(homedir(), ".claude.json")
}

function readClaudeJson(): Partial<ClaudeIdentity> {
  try {
    const raw = readFileSync(configPath(), "utf8")
    const parsed = JSON.parse(raw) as {
      userID?: unknown
      oauthAccount?: {
        accountUuid?: unknown
        organizationUuid?: unknown
        emailAddress?: unknown
      }
    }
    const out: Partial<ClaudeIdentity> = {}
    if (typeof parsed.userID === "string") out.userID = parsed.userID
    const oauth = parsed.oauthAccount
    if (oauth && typeof oauth === "object") {
      if (typeof oauth.accountUuid === "string") out.accountUuid = oauth.accountUuid
      if (typeof oauth.organizationUuid === "string") out.organizationUuid = oauth.organizationUuid
      if (typeof oauth.emailAddress === "string") out.emailAddress = oauth.emailAddress
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Deterministic fallback user_id so requests from the same machine/user
 * are stable across restarts even when ~/.claude.json is absent.
 * Format matches Claude Code (64 hex chars).
 */
function fallbackUserID(): string {
  const seed = `${process.env.USERNAME ?? process.env.USER ?? "unknown"}@${process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "host"}`
  // Lightweight hex digest (not cryptographically strong — just stable).
  // We avoid requiring node:crypto at module load to keep the plugin
  // startup surface small; collisions here are irrelevant since
  // Anthropic only checks that user_id exists and has the right shape.
  let h1 = 0x811c9dc5
  let h2 = 0xcbf29ce4
  for (let i = 0; i < seed.length; i++) {
    h1 = Math.imul(h1 ^ seed.charCodeAt(i), 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ seed.charCodeAt(i), 0x100000001b3) >>> 0
  }
  const hex = (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).repeat(4)
  return hex.slice(0, 64)
}

export function getClaudeIdentity(): ClaudeIdentity {
  if (cached) return cached

  const fromFile = readClaudeJson()
  const envUserID = process.env.OPENCODE_ANTHROPIC_CONSOLE_USER_ID?.trim()

  const resolved: ClaudeIdentity = {
    userID: envUserID || fromFile.userID || fallbackUserID(),
    accountUuid: fromFile.accountUuid,
    organizationUuid: fromFile.organizationUuid,
    emailAddress: fromFile.emailAddress,
  }
  cached = resolved
  return resolved
}

/**
 * Reset the cache — primarily useful for tests and for users who change
 * their ~/.claude.json at runtime.
 */
export function resetClaudeIdentityCache(): void {
  cached = null
}
