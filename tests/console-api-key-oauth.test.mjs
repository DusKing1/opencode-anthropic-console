import assert from "node:assert/strict"
import test from "node:test"

import { AnthropicConsoleAuthPlugin } from "../dist/index.js"

test("Create an API Key exchanges Console OAuth credentials for an API key", async () => {
  const plugin = await AnthropicConsoleAuthPlugin({ client: {} })
  const method = plugin.auth.methods.find(({ label }) => label === "Create an API Key")

  assert.ok(method, "Create an API Key must remain available after auth unification")
  assert.equal(method.type, "oauth")

  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (input, init) => {
    requests.push({ input: String(input), init })
    if (requests.length === 1) {
      return new Response(
        JSON.stringify({
          access_token: "console-access",
          refresh_token: "console-refresh",
          expires_in: 3600,
        }),
        { status: 200 },
      )
    }
    return new Response(JSON.stringify({ raw_key: "sk-ant-api03-created" }), {
      status: 200,
    })
  }

  try {
    const authorization = await method.authorize()
    const authorizationUrl = new URL(authorization.url)
    assert.equal(authorizationUrl.origin, "https://platform.claude.com")
    assert.equal(authorizationUrl.pathname, "/oauth/authorize")

    const state = authorizationUrl.searchParams.get("state")
    assert.ok(state)
    const result = await authorization.callback(`authorization-code#${state}`)

    assert.deepEqual(result, { type: "success", key: "sk-ant-api03-created" })
    assert.equal(requests[0]?.input, "https://platform.claude.com/v1/oauth/token")
    assert.equal(
      requests[1]?.input,
      "https://api.anthropic.com/api/oauth/claude_cli/create_api_key",
    )
    assert.equal(
      new Headers(requests[1]?.init?.headers).get("authorization"),
      "Bearer console-access",
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("Create an API Key fails closed when Anthropic does not return an API key", async () => {
  const plugin = await AnthropicConsoleAuthPlugin({ client: {} })
  const method = plugin.auth.methods.find(({ label }) => label === "Create an API Key")
  assert.ok(method)

  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_input, init) => {
    const authorization = new Headers(init?.headers).get("authorization")
    return authorization
      ? new Response(JSON.stringify({ raw_key: "unexpected-key-format" }), { status: 200 })
      : new Response(
          JSON.stringify({
            access_token: "console-access",
            refresh_token: "console-refresh",
            expires_in: 3600,
          }),
          { status: 200 },
        )
  }

  try {
    const authorization = await method.authorize()
    const state = new URL(authorization.url).searchParams.get("state")
    assert.ok(state)
    assert.deepEqual(await authorization.callback(`authorization-code#${state}`), {
      type: "failed",
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})
