import assert from "node:assert/strict"
import test from "node:test"

// The V2 entrypoint registers through the plugin context instead of returning
// the V1 hooks object. These tests drive `setup` with a stub context so the
// exported shape and the request/response shaping stay covered without a
// running OpenCode server.

process.env.OPENCODE_ANTHROPIC_CONSOLE_USER_ID = "a".repeat(64)

const { default: plugin } = await import("../dist/index.js")

function stubContext(credential) {
  const hooks = {}
  const updated = []
  const removed = []
  let providerTransform
  let reloads = 0
  let integrationEditor

  const ctx = {
    integration: {
      transform: async (callback) => {
        integrationEditor = { method: { list: () => [], update: (r) => updated.push(r.method.id), remove: (_id, m) => removed.push(m.id) } }
        callback(integrationEditor)
        return { dispose: async () => {} }
      },
      connection: {
        active: async () => (credential.current ? { type: "credential", id: "c1", label: "l", method: credential.current.type } : undefined),
        resolve: async () => credential.current,
      },
    },
    provider: {
      transform: async (callback) => {
        providerTransform = callback
      },
      reload: async () => {
        reloads++
      },
    },
    session: {
      hook: async (name, callback) => {
        hooks[name] = callback
        return { dispose: async () => {} }
      },
    },
  }

  return {
    ctx,
    hooks,
    updated,
    removed,
    providerTransform: () => providerTransform,
    reloads: () => reloads,
  }
}

test("default export is a V2 definition with a stable id and a V1-compatible server()", () => {
  assert.equal(typeof plugin, "object")
  assert.equal(plugin.id, "opencode-anthropic-console")
  assert.equal(typeof plugin.setup, "function")
  assert.equal(typeof plugin.server, "function")
})

test("setup registers the Anthropic oauth methods and both request hooks", async () => {
  const credential = { current: undefined }
  const stub = stubContext(credential)
  await plugin.setup(stub.ctx)

  assert.deepEqual(stub.updated, ["oauth", "console-api-key"])
  assert.equal(typeof stub.hooks["http.request"], "function")
  assert.equal(typeof stub.hooks["http.response"], "function")
})

test("oauth credential: bearer auth, beta flags, Claude Code system prefix, tool prefixing", async () => {
  const credential = {
    current: { type: "oauth", methodID: "oauth", access: "tok-1", refresh: "r1", expires: Date.now() + 3_600_000 },
  }
  const stub = stubContext(credential)
  await plugin.setup(stub.ctx)

  const payload = {
    model: "claude-opus-5",
    system: [{ type: "text", text: "You are OpenCode, see github.com/anomalyco/opencode docs" }],
    messages: [{ role: "user", content: "hello" }],
    tools: [{ name: "bash", description: "d", input_schema: {} }],
  }
  const event = {
    sessionID: "s1",
    agent: "build",
    kind: "primary",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    request: new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": "stale", "x-api-key": "stale", "anthropic-beta": "custom-2026" },
      body: JSON.stringify(payload),
    }),
  }

  await stub.hooks["http.request"](event)

  const url = new URL(event.request.url)
  const headers = event.request.headers
  const body = JSON.parse(await event.request.text())

  assert.equal(url.searchParams.get("beta"), "true")
  assert.equal(headers.get("authorization"), "Bearer tok-1")
  assert.equal(headers.get("x-api-key"), null)
  assert.equal(headers.get("x-session-id"), null)
  assert.match(String(headers.get("user-agent")), /^claude-cli\//)
  assert.ok(String(headers.get("anthropic-beta")).includes("oauth-2025-04-20"))
  assert.ok(String(headers.get("anthropic-beta")).includes("custom-2026"))
  assert.ok(String(body.system?.[0]?.text ?? "").startsWith("x-anthropic-billing-header:"))
  assert.ok(JSON.stringify(body.system).includes("Claude agent, built on Anthropic"))
  assert.ok(!JSON.stringify(body.system).includes("You are OpenCode"))
  assert.equal(body.tools?.[0]?.name, "mcp_Bash")
})

test("api credential: x-api-key, x-app, attestation metadata and stripped stream", async () => {
  const credential = { current: { type: "key", key: "sk-ant-api03-test" } }
  const stub = stubContext(credential)
  await plugin.setup(stub.ctx)

  const payload = {
    model: "claude-opus-5",
    temperature: 0.7,
    messages: [{ role: "user", content: "hello" }],
    tools: [{ name: "bash", description: "d", input_schema: {} }],
  }
  const event = {
    sessionID: "s1",
    agent: "build",
    kind: "title",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    request: new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  }

  await stub.hooks["http.request"](event)

  const headers = event.request.headers
  const body = JSON.parse(await event.request.text())
  assert.equal(headers.get("x-api-key"), "sk-ant-api03-test")
  assert.equal(headers.get("x-app"), "cli")
  assert.equal(Object.hasOwn(body, "temperature"), false)
  assert.ok(String(body.metadata?.user_id ?? "").includes("a".repeat(64)))
  assert.match(String(headers.get("x-claude-code-session-id")), /^[0-9a-f-]{36}$/)

  const responseEvent = {
    sessionID: "s1",
    agent: "build",
    kind: "title",
    model: {},
    request: event.request,
    response: new Response('data: {"name":"mcp_Bash"}\n', { headers: { "content-type": "text/event-stream" } }),
  }
  await stub.hooks["http.response"](responseEvent)
  const streamed = await responseEvent.response.text()
  assert.ok(streamed.includes('"name": "bash"'))
  assert.ok(!streamed.includes("mcp_Bash"))
})

test("expired subscription credential fails with an explicit token_expired error", async () => {
  const credential = {
    current: { type: "oauth", methodID: "oauth", access: "tok", refresh: "r", expires: Date.now() - 1_000 },
  }
  const stub = stubContext(credential)
  await plugin.setup(stub.ctx)

  const event = {
    sessionID: "s1",
    agent: "build",
    kind: "primary",
    model: {},
    request: new Request("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }),
  }

  await assert.rejects(() => stub.hooks["http.request"](event), /token_expired/)
})

test("no credential leaves the request untouched", async () => {
  const credential = { current: undefined }
  const stub = stubContext(credential)
  await plugin.setup(stub.ctx)

  const request = new Request("https://api.anthropic.com/v1/messages", { method: "POST", body: '{"model":"x"}' })
  const event = { sessionID: "s1", agent: "build", kind: "primary", model: {}, request }

  await stub.hooks["http.request"](event)
  assert.equal(event.request, request)
})

test("subscription mode zeroes every cost tier and keeps tier markers", async () => {
  // Connected as a subscription before setup: the initial transform already
  // sees the credential, so no reload flip is expected here.
  const credential = {
    current: { type: "oauth", methodID: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3_600_000 },
  }
  const stub = stubContext(credential)
  await plugin.setup(stub.ctx)

  const model = {
    cost: [
      { tier: { type: "context", size: 200_000 }, input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
      { input: 9, output: 9, cache: { read: 0.9, write: 0.9 } },
    ],
  }
  const editor = {
    get: () => ({ models: new Map([["claude-opus-5", model]]) }),
    models: {
      update: (_providerID, _modelID, callback) => callback(model),
    },
  }

  // Pricing flips when the first request observes the subscription credential.
  const event = {
    sessionID: "s1",
    agent: "build",
    kind: "primary",
    model: {},
    request: new Request("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }),
  }
  await stub.hooks["http.request"](event)
  await new Promise((resolve) => setTimeout(resolve, 10))
  stub.providerTransform()(editor)
  // No mode flip: the credential was already a subscription when setup ran.
  assert.equal(stub.reloads(), 0)

  assert.deepEqual(
    model.cost.map((tier) => [tier.input, tier.output, tier.cache.read, tier.cache.write]),
    [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
  )
  assert.equal(model.cost[0].tier?.type, "context")
  assert.equal(model.cost[0].tier?.size, 200_000)
})

test("an empty cost array gets a single zeroed default tier", async () => {
  const credential = {
    current: { type: "oauth", methodID: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3_600_000 },
  }
  const stub = stubContext(credential)
  await plugin.setup(stub.ctx)

  const model = { cost: [] }
  const editor = {
    get: () => ({ models: new Map([["claude-opus-5", model]]) }),
    models: { update: (_providerID, _modelID, callback) => callback(model) },
  }
  stub.providerTransform()(editor)

  assert.deepEqual(model.cost, [{ input: 0, output: 0, cache: { read: 0, write: 0 } }])
})
