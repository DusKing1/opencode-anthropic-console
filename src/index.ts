import { randomUUID } from "node:crypto"
import type { AuthOAuthResult, Plugin } from "@opencode-ai/plugin"
import type { Auth, Provider } from "@opencode-ai/sdk"
import {
  CONSOLE_OAUTH_AUTHORIZE_URL,
  createConsoleApiKey,
  createOAuthAuthorization,
  exchangeOAuthCode,
  OAuthFlowError,
  type OAuthCredentials,
  refreshOAuthToken,
} from "./oauth.js"
import {
  isAllowedOAuthUrl,
  rewriteOAuthRequestBody,
  setOAuthHeaders,
} from "./oauth-transform.js"
import {
  createStrippedStream,
  mergeHeaders,
  rewriteRequestBody,
  rewriteUrl,
  setApiKeyHeaders,
} from "./transform.js"

const PROVIDER_ID = "anthropic"
const REFRESH_SKEW_MS = 5 * 60 * 1000

type GetAuth = () => Promise<Auth>
type ApiAuth = Extract<Auth, { type: "api" }>
type OAuthAuth = Extract<Auth, { type: "oauth" }>
type PluginClient = Parameters<Plugin>[0]["client"]

type RuntimeFailureKind = "auth_changed" | "refresh_poisoned" | "unexpected_origin"

class AnthropicAuthRuntimeError extends Error {
  constructor(readonly kind: RuntimeFailureKind) {
    super(`Anthropic authentication runtime error: ${kind}`)
    this.name = "AnthropicAuthRuntimeError"
  }
}

function zeroProviderCosts(provider: Provider): void {
  for (const model of Object.values(provider.models)) {
    model.cost = {
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    }
  }
}

async function authorizeOAuth(): Promise<AuthOAuthResult> {
  const authorization = createOAuthAuthorization()
  let exchangePromise:
    | Promise<
        | { type: "success"; refresh: string; access: string; expires: number }
        | { type: "failed" }
      >
    | undefined

  const complete = async (input: string) => {
    try {
      const credentials = await exchangeOAuthCode(input, authorization)
      return {
        type: "success" as const,
        refresh: credentials.refresh,
        access: credentials.access,
        expires: credentials.expires,
      }
    } catch (error) {
      if (error instanceof OAuthFlowError) return { type: "failed" as const }
      throw error
    }
  }

  return {
    url: authorization.url,
    instructions: "Paste the authorization code here:",
    method: "code",
    callback(input: string) {
      exchangePromise ??= complete(input)
      return exchangePromise
    },
  }
}

async function authorizeConsoleApiKey(): Promise<AuthOAuthResult> {
  const authorization = createOAuthAuthorization(CONSOLE_OAUTH_AUTHORIZE_URL)
  let exchangePromise: ReturnType<AuthOAuthResult["callback"]> | undefined

  const complete = async (input: string) => {
    try {
      const credentials = await exchangeOAuthCode(input, authorization)
      return { type: "success" as const, key: await createConsoleApiKey(credentials.access) }
    } catch (error) {
      if (error instanceof OAuthFlowError) return { type: "failed" as const }
      throw error
    }
  }

  return {
    url: authorization.url,
    instructions: "Paste the authorization code here:",
    method: "code",
    callback(input: string) {
      exchangePromise ??= complete(input)
      return exchangePromise
    },
  }
}

function createApiOptions(getAuth: GetAuth, initial: ApiAuth) {
  const sessionID = randomUUID()
  return {
    apiKey: initial.key,
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const current = await getAuth()
      if (current.type !== "api" || current.key !== initial.key) {
        throw new AnthropicAuthRuntimeError("auth_changed")
      }

      const headers = mergeHeaders(input, init)
      headers.delete("x-session-affinity")
      headers.delete("x-session-id")
      headers.delete("x-parent-session-id")
      setApiKeyHeaders(headers)
      headers.set("x-claude-code-session-id", sessionID)

      const rewritten = rewriteUrl(input)
      let body = init?.body
      if (rewritten.url?.pathname === "/v1/messages" && typeof body === "string") {
        body = rewriteRequestBody(body, sessionID)
      }

      const response = await fetch(rewritten.input, { ...init, body, headers })
      return createStrippedStream(response)
    },
  }
}

function createOAuthOptions(getAuth: GetAuth, client: PluginClient) {
  let refreshPromise: Promise<OAuthAuth | OAuthCredentials> | undefined
  let poisonedRefresh: string | undefined

  async function currentCredentials(): Promise<OAuthAuth | OAuthCredentials> {
    const current = await getAuth()
    if (current.type !== "oauth") throw new AnthropicAuthRuntimeError("auth_changed")
    if (poisonedRefresh && current.refresh !== poisonedRefresh) poisonedRefresh = undefined
    if (current.access && current.expires > Date.now() + REFRESH_SKEW_MS) return current
    if (poisonedRefresh === current.refresh) {
      throw new AnthropicAuthRuntimeError("refresh_poisoned")
    }

    if (!refreshPromise) {
      refreshPromise = (async () => {
        const fresh = await getAuth()
        if (fresh.type !== "oauth") throw new AnthropicAuthRuntimeError("auth_changed")
        if (poisonedRefresh && fresh.refresh !== poisonedRefresh) poisonedRefresh = undefined
        if (fresh.access && fresh.expires > Date.now() + REFRESH_SKEW_MS) return fresh
        if (poisonedRefresh === fresh.refresh) {
          throw new AnthropicAuthRuntimeError("refresh_poisoned")
        }

        const refresh = fresh.refresh
        try {
          const next = await refreshOAuthToken(refresh)
          const persisted: OAuthAuth = { ...fresh, ...next }
          await client.auth.set({
            path: { id: PROVIDER_ID },
            body: persisted,
            throwOnError: true,
          })
          return persisted
        } catch (error) {
          poisonedRefresh = refresh
          throw error
        }
      })().finally(() => {
        refreshPromise = undefined
      })
    }

    return refreshPromise
  }

  return {
    apiKey: "",
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const credentials = await currentCredentials()
      const rewritten = rewriteUrl(input)
      if (!isAllowedOAuthUrl(rewritten.url)) {
        throw new AnthropicAuthRuntimeError("unexpected_origin")
      }

      const headers = mergeHeaders(input, init)
      headers.delete("x-session-affinity")
      headers.delete("x-session-id")
      headers.delete("x-parent-session-id")
      setOAuthHeaders(headers, credentials.access)

      let body = init?.body
      if (rewritten.url?.pathname === "/v1/messages" && typeof body === "string") {
        body = rewriteOAuthRequestBody(body)
      }

      const response = await fetch(rewritten.input, { ...init, body, headers })
      return createStrippedStream(response)
    },
  }
}

/** Complete Anthropic authentication for Claude.ai OAuth and Console API keys. */
export const AnthropicConsoleAuthPlugin: Plugin = async ({ client }) => ({
  auth: {
    provider: PROVIDER_ID,
    methods: [
      {
        type: "oauth",
        label: "Claude Pro/Max",
        authorize: authorizeOAuth,
      },
      {
        type: "oauth",
        label: "Create an API Key",
        authorize: authorizeConsoleApiKey,
      },
      {
        type: "api",
        label: "Console API Key",
        prompts: [
          {
            type: "text",
            key: "key",
            message: "Paste your sk-ant-api03-... key from console.anthropic.com",
            placeholder: "sk-ant-api03-...",
            validate: (value: string) =>
              value.startsWith("sk-ant-api03-") ? undefined : "Key must start with sk-ant-api03-",
          },
        ],
        authorize: async (inputs?: Record<string, string>) => {
          const key = inputs?.key?.trim()
          return key ? { type: "success" as const, key } : { type: "failed" as const }
        },
      },
    ],
    async loader(getAuth, provider) {
      const auth = await getAuth()
      if (auth.type === "api") return createApiOptions(getAuth, auth)
      if (auth.type === "oauth") {
        zeroProviderCosts(provider)
        return createOAuthOptions(getAuth, client)
      }
      return {}
    },
  },
})

export default AnthropicConsoleAuthPlugin
