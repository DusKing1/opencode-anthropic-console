import type { Plugin } from "@opencode-ai/plugin"
import {
  createStrippedStream,
  isInsecure,
  mergeHeaders,
  rewriteRequestBody,
  rewriteUrl,
  setApiKeyHeaders,
} from "./transform.js"

/**
 * opencode plugin for Anthropic **Console API keys** (`sk-ant-api03-...`)
 * provisioned via https://console.anthropic.com/ for Claude Code use.
 *
 * These keys are server-side attested: requests that do not look like they
 * came from the official Claude Code CLI are rejected with a fake
 * `429 rate_limit_error: "Error"`. This plugin rewrites opencode's
 * outgoing Anthropic requests to pass that attestation while preserving
 * the `x-api-key` authentication scheme.
 *
 * Sibling plugin: `@ex-machina/opencode-anthropic-auth` handles the
 * OAuth / Max subscription path. Both can be installed together —
 * this plugin activates only for `auth.type === 'api'` and returns an
 * empty object for OAuth, so ex-machina's loader remains authoritative
 * for the OAuth branch.
 */
export const AnthropicConsoleAuthPlugin: Plugin = async () => {
  return {
    auth: {
      provider: "anthropic",
      // Minimal API-key login flow so this plugin is self-sufficient even
      // without ex-machina installed. When both plugins are present,
      // whichever registers last wins the CLI login menu; we recommend
      // installing ex-machina *after* this plugin so its richer methods
      // (OAuth + API key) drive `opencode auth login anthropic`.
      methods: [
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
            if (!key) return { type: "failed" as const }
            return { type: "success" as const, key }
          },
        },
      ],

      async loader(getAuth) {
        const auth = await getAuth()

        // Defer OAuth to ex-machina (or any other OAuth-handling plugin).
        if (auth.type !== "api") return {}

        return {
          // Let opencode's Anthropic SDK populate x-api-key from this value.
          apiKey: auth.key,

          async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
            const headers = mergeHeaders(input, init)
            setApiKeyHeaders(headers)

            let body = init?.body
            if (typeof body === "string") {
              body = rewriteRequestBody(body)
            }

            const rewritten = rewriteUrl(input)

            const fetchInit: RequestInit = {
              ...init,
              body,
              headers,
            }

            // TLS bypass is only honoured when ANTHROPIC_BASE_URL is also set,
            // so stock console.anthropic.com traffic remains fully verified.
            if (isInsecure()) {
              // Node's undici fetch does not honour `rejectUnauthorized` via RequestInit,
              // so we leave the option documented but rely on the user's NODE_TLS_REJECT_UNAUTHORIZED=0
              // for custom endpoints. See README for details.
            }

            const response = await fetch(rewritten.input, fetchInit)
            return createStrippedStream(response)
          },
        }
      },
    },
  }
}

export default AnthropicConsoleAuthPlugin
