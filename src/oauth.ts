import { createHash, randomBytes } from "node:crypto"

export const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
export const OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize"
export const CONSOLE_OAUTH_AUTHORIZE_URL = "https://platform.claude.com/oauth/authorize"
export const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
export const OAUTH_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback"
export const OAUTH_SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
] as const

const TOKEN_RESPONSE_LIMIT = 64 * 1024
const API_KEY_URL = "https://api.anthropic.com/api/oauth/claude_cli/create_api_key"
const TOKEN_EXCHANGE_USER_AGENT = "axios/1.13.6"
const TOKEN_REFRESH_BETA = "oauth-2025-04-20"
const TOKEN_REFRESH_USER_AGENT = "anthropic-sdk-typescript/0.94.0 userOAuthProvider"

export type OAuthCredentials = {
  readonly type: "oauth"
  readonly refresh: string
  readonly access: string
  readonly expires: number
}

export type OAuthAuthorization = {
  readonly url: string
  readonly verifier: string
  readonly state: string
}

type TokenGrant =
  | {
      readonly grant_type: "authorization_code"
      readonly client_id: string
      readonly code: string
      readonly state: string
      readonly redirect_uri: string
      readonly code_verifier: string
    }
  | {
      readonly grant_type: "refresh_token"
      readonly client_id: string
      readonly refresh_token: string
    }

type OAuthFailureKind =
  | "api_key_http"
  | "api_key_response"
  | "api_key_transport"
  | "invalid_callback"
  | "state_mismatch"
  | "token_transport"
  | "token_http"
  | "token_response"

export class OAuthFlowError extends Error {
  constructor(
    readonly kind: OAuthFailureKind,
    readonly status?: number,
  ) {
    super(status === undefined ? `OAuth ${kind}` : `OAuth ${kind} (${status})`)
    this.name = "OAuthFlowError"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
}

function parseAuthorizationInput(value: string): { code: string; state: string } {
  const trimmed = value.trim()
  let code = ""
  let state = ""

  try {
    const url = new URL(trimmed)
    code = url.searchParams.get("code") ?? ""
    state = url.searchParams.get("state") ?? ""
  } catch {
    if (trimmed.includes("#")) {
      const separator = trimmed.lastIndexOf("#")
      code = trimmed.slice(0, separator)
      state = trimmed.slice(separator + 1)
    } else {
      const params = new URLSearchParams(trimmed)
      code = params.get("code") ?? ""
      state = params.get("state") ?? ""
    }
  }

  if (!code || !state) throw new OAuthFlowError("invalid_callback")
  return { code, state }
}

function createVerifier(): string {
  return randomBytes(64).toString("base64url")
}

export function createOAuthAuthorization(
  authorizeUrl: string = OAUTH_AUTHORIZE_URL,
): OAuthAuthorization {
  const verifier = createVerifier()
  const state = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const url = new URL(authorizeUrl)
  url.searchParams.set("code", "true")
  url.searchParams.set("client_id", OAUTH_CLIENT_ID)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI)
  url.searchParams.set("scope", OAUTH_SCOPES.join(" "))
  url.searchParams.set("code_challenge", challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", state)
  return { url: url.toString(), verifier, state }
}

async function readTokenResponse(response: Response): Promise<unknown> {
  if (!response.ok) throw new OAuthFlowError("token_http", response.status)
  const text = await response.text()
  if (text.length > TOKEN_RESPONSE_LIMIT) throw new OAuthFlowError("token_response")
  try {
    return JSON.parse(text)
  } catch {
    throw new OAuthFlowError("token_response")
  }
}

function parseCredentials(value: unknown, fallbackRefresh?: string): OAuthCredentials {
  if (!isRecord(value)) throw new OAuthFlowError("token_response")
  const access = typeof value.access_token === "string" ? value.access_token.trim() : ""
  const hasReturnedRefresh = Object.prototype.hasOwnProperty.call(value, "refresh_token")
  let refresh = fallbackRefresh ?? ""
  if (hasReturnedRefresh) {
    const returnedRefresh = value.refresh_token
    if (typeof returnedRefresh !== "string" || !returnedRefresh.trim()) {
      throw new OAuthFlowError("token_response")
    }
    refresh = returnedRefresh.trim()
  }
  const expiresIn = value.expires_in
  if (!access || !refresh || typeof expiresIn !== "number" || !Number.isSafeInteger(expiresIn) || expiresIn <= 0) {
    throw new OAuthFlowError("token_response")
  }

  const now = Date.now()
  const expires = now + expiresIn * 1000
  if (!Number.isFinite(expires) || expires <= now) throw new OAuthFlowError("token_response")
  return { type: "oauth", access, refresh, expires }
}

async function requestToken(grant: TokenGrant, fallbackRefresh?: string): Promise<OAuthCredentials> {
  try {
    const headers = new Headers({ "content-type": "application/json" })
    if (grant.grant_type === "refresh_token") {
      headers.set("anthropic-beta", TOKEN_REFRESH_BETA)
      headers.set("user-agent", TOKEN_REFRESH_USER_AGENT)
    } else {
      headers.set("accept", "application/json, text/plain, */*")
      headers.set("user-agent", TOKEN_EXCHANGE_USER_AGENT)
    }
    const response = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(grant),
    })
    return parseCredentials(await readTokenResponse(response), fallbackRefresh)
  } catch (error) {
    if (error instanceof OAuthFlowError) throw error
    throw new OAuthFlowError("token_transport")
  }
}

export async function exchangeOAuthCode(
  input: string,
  authorization: OAuthAuthorization,
): Promise<OAuthCredentials> {
  const callback = parseAuthorizationInput(input)
  if (callback.state !== authorization.state) throw new OAuthFlowError("state_mismatch")
  return requestToken({
    grant_type: "authorization_code",
    client_id: OAUTH_CLIENT_ID,
    code: callback.code,
    state: callback.state,
    redirect_uri: OAUTH_REDIRECT_URI,
    code_verifier: authorization.verifier,
  })
}

export async function createConsoleApiKey(access: string): Promise<string> {
  try {
    const response = await fetch(API_KEY_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${access}`,
      },
    })
    if (!response.ok) throw new OAuthFlowError("api_key_http", response.status)
    const text = await response.text()
    if (text.length > TOKEN_RESPONSE_LIMIT) throw new OAuthFlowError("api_key_response")

    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      throw new OAuthFlowError("api_key_response")
    }
    if (!isRecord(value) || typeof value.raw_key !== "string") {
      throw new OAuthFlowError("api_key_response")
    }
    const key = value.raw_key.trim()
    if (!key.startsWith("sk-ant-api03-")) throw new OAuthFlowError("api_key_response")
    return key
  } catch (error) {
    if (error instanceof OAuthFlowError) throw error
    throw new OAuthFlowError("api_key_transport")
  }
}

export function refreshOAuthToken(refresh: string): Promise<OAuthCredentials> {
  return requestToken(
    {
      grant_type: "refresh_token",
      client_id: OAUTH_CLIENT_ID,
      refresh_token: refresh,
    },
    refresh,
  )
}
