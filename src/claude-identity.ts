import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Claude Code stores its account snapshot in ~/.claude.json. The relevant
 * fields for request attestation are:
 *
 *   - userID:          64-char hex; sent as metadata.user_id.device_id
 *   - oauthAccount.*:  organizationUuid, accountUuid, emailAddress, etc.
 *
 * We read the file lazily and cache the result. Attested requests require a
 * real Claude Code device ID, so a missing or malformed identity is reported
 * before the request is sent instead of fabricating a machine fingerprint.
 */

export type ClaudeIdentity = {
  userID: string
  accountUuid?: string
  organizationUuid?: string
  emailAddress?: string
}

let cached: ClaudeIdentity | null = null

const CLAUDE_DEVICE_ID_PATTERN = /^[0-9a-f]{64}$/i

export class ClaudeIdentityError extends Error {
  constructor(path: string) {
    super(
      `Claude Code device identity is missing or invalid. Run Claude Code once, set OPENCODE_ANTHROPIC_CONSOLE_USER_ID, or fix ${path}.`,
    )
    this.name = "ClaudeIdentityError"
  }
}

function configPath(): string {
  const override = process.env.OPENCODE_ANTHROPIC_CONSOLE_CLAUDE_JSON
  if (override && override.trim()) return override.trim()
  return join(homedir(), ".claude.json")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
}

function readClaudeJson(): Partial<ClaudeIdentity> {
  try {
    const raw = readFileSync(configPath(), "utf8")
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return {}

    const out: Partial<ClaudeIdentity> = {}
    if (typeof parsed.userID === "string") out.userID = parsed.userID
    const oauth = parsed.oauthAccount
    if (isRecord(oauth)) {
      if (typeof oauth.accountUuid === "string") out.accountUuid = oauth.accountUuid
      if (typeof oauth.organizationUuid === "string") out.organizationUuid = oauth.organizationUuid
      if (typeof oauth.emailAddress === "string") out.emailAddress = oauth.emailAddress
    }
    return out
  } catch {
    return {}
  }
}

export function getClaudeIdentity(): ClaudeIdentity {
  if (cached) return cached

  const fromFile = readClaudeJson()
  const envUserID = process.env.OPENCODE_ANTHROPIC_CONSOLE_USER_ID?.trim()
  const userID = envUserID || fromFile.userID
  if (!userID || !CLAUDE_DEVICE_ID_PATTERN.test(userID)) {
    throw new ClaudeIdentityError(configPath())
  }

  const resolved: ClaudeIdentity = {
    userID,
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
