import { randomUUID } from "node:crypto"
import { Plugin } from "@opencode/plugin"
import type { AuthOAuthResult, Plugin as V1Plugin } from "@opencode-ai/plugin"
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
const SUBSCRIPTION_METHOD_ID = "oauth"
const CONSOLE_KEY_METHOD_ID = "console-api-key"
/** Far-future expiry for minted keys: they do not rotate on their own. */
const KEY_NEVER_EXPIRES = Number.MAX_SAFE_INTEGER

type GetAuth = () => Promise<Auth>
type ApiAuth = Extract<Auth, { type: "api" }>
type OAuthAuth = Extract<Auth, { type: "oauth" }>
type PluginClient = Parameters<V1Plugin>[0]["client"]

type RuntimeFailureKind =
  | "auth_changed"
  | "refresh_poisoned"
  | "unexpected_origin"
  | "token_expired"
  | "no_credential"

class AnthropicAuthRuntimeError extends Error {
  constructor(readonly kind: RuntimeFailureKind) {
    super(`Anthropic authentication runtime error: ${kind}`)
    this.name = "AnthropicAuthRuntimeError"
  }
}

// ───────────────────────────────────────────────────────────────────────────
// V2 helpers (OpenCode >= 2.x): reuse the exact same transforms, but the
// request/response dance runs through session.hook instead of a private fetch.
// ───────────────────────────────────────────────────────────────────────────

type V2Credential =
  | { type: "oauth"; methodID?: string; access: string; refresh: string; expires: number; metadata?: Record<string, unknown> }
  | { type: "key"; key: string; metadata?: Record<string, unknown> }

/** "api" = Console key path (attested), "oauth" = Claude.ai subscription path. */
function modeOf(credential: V2Credential | undefined): "oauth" | "api" | "none" {
  if (!credential) return "none"
  if (credential.type === "key") return "api"
  if (credential.type !== "oauth") return "none"
  return (credential as V2Credential & { methodID?: string }).methodID === CONSOLE_KEY_METHOD_ID ? "api" : "oauth"
}

/** Access token used as `x-api-key` for a minted Console key. */
function apiKeyOf(credential: V2Credential): string {
  if (credential.type === "key") return credential.key
  return (credential as { access: string }).access
}

async function activeCredential(ctx: any): Promise<V2Credential | undefined> {
  const connection = await ctx.integration.connection.active(PROVIDER_ID)
  if (!connection) return undefined
  return ctx.integration.connection.resolve(connection) as Promise<V2Credential | undefined>
}

function subscriptionMethod() {
  return {
    method: { id: SUBSCRIPTION_METHOD_ID, type: "oauth" as const, label: "Claude Pro/Max" },
    async authorize() {
      const authorization = createOAuthAuthorization()
      return {
        url: authorization.url,
        instructions: "Paste the authorization code here:",
        mode: "code" as const,
        async callback(code: string) {
          const credentials = await exchangeOAuthCode(code, authorization)
          return {
            type: "oauth" as const,
            methodID: SUBSCRIPTION_METHOD_ID,
            access: credentials.access,
            refresh: credentials.refresh,
            expires: credentials.expires,
          }
        },
      }
    },
    async refresh(credential: any) {
      const next = await refreshOAuthToken(credential.refresh)
      return { ...credential, access: next.access, refresh: next.refresh, expires: next.expires }
    },
  }
}

function consoleKeyMethod() {
  return {
    method: { id: CONSOLE_KEY_METHOD_ID, type: "oauth" as const, label: "Create an API Key (Console OAuth)" },
    async authorize() {
      const authorization = createOAuthAuthorization(CONSOLE_OAUTH_AUTHORIZE_URL)
      return {
        url: authorization.url,
        instructions: "Paste the authorization code here:",
        mode: "code" as const,
        async callback(code: string) {
          const credentials = await exchangeOAuthCode(code, authorization)
          const key = await createConsoleApiKey(credentials.access)
          // The minted key rides on an oauth credential; `metadata` keeps the
          // OAuth tokens needed to re-mint it once the grant ages out.
          return {
            type: "oauth" as const,
            methodID: CONSOLE_KEY_METHOD_ID,
            access: key,
            refresh: credentials.refresh,
            expires: KEY_NEVER_EXPIRES,
            metadata: { oauth_access: credentials.access, oauth_refresh: credentials.refresh },
          }
        },
      }
    },
    async refresh(credential: any) {
      const metadata = (credential.metadata ?? {}) as Record<string, unknown>
      let oauthAccess = typeof metadata.oauth_access === "string" ? metadata.oauth_access : undefined
      let refresh = credential.refresh as string
      const stale = !oauthAccess || (credential.expires > 0 && credential.expires <= Date.now())
      if (stale) {
        const next = await refreshOAuthToken(refresh)
        oauthAccess = next.access
        refresh = next.refresh
      }
      return {
        type: "oauth" as const,
        methodID: CONSOLE_KEY_METHOD_ID,
        access: await createConsoleApiKey(oauthAccess!),
        refresh,
        expires: KEY_NEVER_EXPIRES,
        metadata: { ...metadata, oauth_access: oauthAccess },
      }
    },
  }
}

function rebuild(request: Request, url: string, body: string | undefined): Request {
  return new Request(url, {
    method: request.method,
    headers: request.headers,
    body,
    signal: request.signal,
    redirect: request.redirect,
    credentials: request.credentials,
    cache: request.cache,
    keepalive: request.keepalive,
    referrer: request.referrer,
  } as RequestInit)
}

async function applyIdentity(credential: V2Credential, sessionID: string, event: { request: Request }): Promise<void> {
  const rewritten = rewriteUrl(event.request as any)
  const url = rewritten.url
  if (!url) return
  const request = (rewritten.input instanceof Request ? rewritten.input : event.request) as Request
  const headers = request.headers
  headers.delete("x-session-affinity")
  headers.delete("x-session-id")
  headers.delete("x-parent-session-id")

  const mode = modeOf(credential)
  if (mode === "oauth") {
    if (!isAllowedOAuthUrl(url)) return
    setOAuthHeaders(headers, credential.type === "oauth" ? (credential as { access: string }).access : "")
  } else if (mode === "api") {
    setApiKeyHeaders(headers)
    headers.set("x-api-key", apiKeyOf(credential))
    headers.set("x-claude-code-session-id", sessionID)
  } else return

  // Only /v1/messages bodies are rewritten; everything else keeps its own body.
  if (url.pathname !== "/v1/messages" || request.method === "GET") {
    event.request = request
    return
  }

  // The body is one-shot: read it, then hand back a rebuilt request.
  headers.delete("content-length")
  const body = await request.text()
  const next = mode === "oauth" ? rewriteOAuthRequestBody(body) : rewriteRequestBody(body, sessionID)
  event.request = rebuild(request, url.href, next)
}

// ───────────────────────────────────────────────────────────────────────────
// V2 default export
// ───────────────────────────────────────────────────────────────────────────

const definition = {
  id: "opencode-anthropic-console",
  async setup(ctx: any) {
    // 1. Own Anthropic authentication methods.
    await ctx.integration.transform((editor: any) => {
      for (const registration of [subscriptionMethod(), consoleKeyMethod()]) {
        editor.method.update({ integrationID: PROVIDER_ID, ...registration })
      }
      const owned = new Set([SUBSCRIPTION_METHOD_ID, CONSOLE_KEY_METHOD_ID])
      for (const method of editor.method.list(PROVIDER_ID)) {
        if (method.type === "oauth" && !owned.has(method.id)) editor.method.remove(PROVIDER_ID, method)
      }
    })

    // 2. Subscription usage must not be priced. Transforms are synchronous and
    //    replayable, so the flag lives outside and reload() replays it.
    const initial = await activeCredential(ctx).catch(() => undefined)
    let subscription = modeOf(initial) === "oauth"
    await ctx.provider.transform((editor: any) => {
      if (!subscription) return
      const record = editor.get(PROVIDER_ID)
      if (!record) return
      for (const modelID of record.models.keys()) {
        editor.models.update(PROVIDER_ID, modelID, (model: any) => {
          // Schema v2: `cost` is an ARRAY of tiered prices. Zero every tier in
          // place, keeping each tier's size marker intact.
          const tiers = Array.isArray(model.cost) ? model.cost : []
          model.cost = tiers.map((tier: any) => ({
            ...(tier && typeof tier === "object" ? tier : {}),
            input: 0,
            output: 0,
            cache: { read: 0, write: 0 },
          }))
          if (model.cost.length === 0) {
            model.cost = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]
          }
        })
      }
    })
    /** Replays the cost transform when connect/switch/renew flips the mode. */
    function syncPricing(mode: "oauth" | "api" | "none") {
      const next = mode === "oauth"
      if (next === subscription) return
      subscription = next
      void ctx.provider.reload().catch(() => {})
    }

    // 3. Claude Code identity on every Anthropic request; prefix stripped back
    //    out of the streamed reply. Scoped to the provider, all request kinds.
    const sessionID = randomUUID()
    await ctx.session.hook(
      "http.request",
      async (event: any) => {
        const credential = await activeCredential(ctx)
        if (!credential) return
        const mode = modeOf(credential)
        if (mode === "oauth" && credential.type === "oauth" && credential.expires <= Date.now()) {
          throw new AnthropicAuthRuntimeError("token_expired")
        }
        syncPricing(mode)
        await applyIdentity(credential, sessionID, event)
      },
      { providerID: PROVIDER_ID },
    )
    await ctx.session.hook(
      "http.response",
      (event: any) => {
        event.response = createStrippedStream(event.response)
      },
      { providerID: PROVIDER_ID },
    )

    console.log("[anthropic-console] v2 plugin loaded (Claude Pro/Max OAuth + Console API key)")
  },
}

// ── V1 (OpenCode 1.x) compatibility ─────────────────────────────────────────

function zeroProviderCosts(provider: Provider): void {
  for (const model of Object.values(provider.models)) {
    model.cost = {
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    } as unknown as typeof model.cost
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
    if (current.access && current.expires > Date.now() + 5 * 60 * 1000) return current
    if (poisonedRefresh === current.refresh) {
      throw new AnthropicAuthRuntimeError("refresh_poisoned")
    }

    if (!refreshPromise) {
      refreshPromise = (async () => {
        const fresh = await getAuth()
        if (fresh.type !== "oauth") throw new AnthropicAuthRuntimeError("auth_changed")
        if (poisonedRefresh && fresh.refresh !== poisonedRefresh) poisonedRefresh = undefined
        if (fresh.access && fresh.expires > Date.now() + 5 * 60 * 1000) return fresh
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
export const AnthropicConsoleAuthPlugin: V1Plugin = async ({ client }) => ({
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

export default {
  ...Plugin.define(definition),
  async server(input: Parameters<V1Plugin>[0]) {
    return AnthropicConsoleAuthPlugin(input)
  },
}
