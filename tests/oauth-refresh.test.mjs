import assert from "node:assert/strict"
import test from "node:test"

import { refreshOAuthToken } from "../dist/oauth.js"

test("refresh uses the Claude Code user OAuth request profile", async () => {
  const originalFetch = globalThis.fetch
  let requestHeaders

  globalThis.fetch = async (_input, init) => {
    requestHeaders = new Headers(init?.headers)
    return new Response(
      JSON.stringify({
        access_token: "next-access",
        refresh_token: "next-refresh",
        expires_in: 3600,
      }),
      { status: 200 },
    )
  }

  try {
    await refreshOAuthToken("current-refresh")
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(requestHeaders?.get("anthropic-beta"), "oauth-2025-04-20")
  assert.equal(requestHeaders?.get("accept"), null)
  assert.equal(
    requestHeaders?.get("user-agent"),
    "anthropic-sdk-typescript/0.94.0 userOAuthProvider",
  )
})
