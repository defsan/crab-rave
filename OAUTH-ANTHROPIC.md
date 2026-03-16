# Anthropic OAuth Token Detection & Connection Flow

## 1. OAuth Detection Function

`src/agents/pi-embedded-runner/anthropic-stream-wrappers.ts:52-54`:

```typescript
function isAnthropicOAuthApiKey(apiKey: unknown): boolean {
  return typeof apiKey === "string" && apiKey.includes("sk-ant-oat");
}
```

Simple string-inclusion check. Anthropic OAuth tokens contain `sk-ant-oat` in their prefix (vs regular API keys which use `sk-ant-api...`). The function is not exported -- only used internally within the wrappers file.

The only call site is inside `createAnthropicBetaHeadersWrapper()` (line 249):

```typescript
const isOauth = isAnthropicOAuthApiKey(options?.apiKey);
```

It reads `apiKey` from the stream options that pi-ai passes on every API call. OAuth detection happens **per-request**, not at setup time.

## 2. Behavior Differences: OAuth vs API Key

### Beta header sets

Defined at `src/agents/pi-embedded-runner/anthropic-stream-wrappers.ts:12-20`:

| Auth Type   | Beta Headers Sent                                                                                |
|-------------|--------------------------------------------------------------------------------------------------|
| **API Key** | `fine-grained-tool-streaming-2025-05-14`, `interleaved-thinking-2025-05-14`                      |
| **OAuth**   | All of the above **plus** `claude-code-20250219`, `oauth-2025-04-20`                             |

### Context-1M beta stripped for OAuth

Lines 250-258: If `context-1m-2025-08-07` was requested (via model config), it is silently removed for OAuth tokens because Anthropic's API rejects that beta with OAuth auth. A warning is logged:

```typescript
if (isOauth && requestedContext1m) {
  log.warn(
    `ignoring context1m for OAuth token auth on ${model.provider}/${model.id}; Anthropic rejects context-1m beta with OAuth auth`,
  );
}
```

## 3. Libraries

| Library                          | Role                                                                 | Import Location                        |
|----------------------------------|----------------------------------------------------------------------|----------------------------------------|
| `@mariozechner/pi-ai`           | Provides `streamSimple` -- the base function that makes HTTP calls to `POST /v1/messages` | `anthropic-stream-wrappers.ts:2`       |
| `@mariozechner/pi-agent-core`   | Provides the `StreamFn` type: `(model, context, options) => stream`  | `anthropic-stream-wrappers.ts:1`       |
| `@mariozechner/pi-coding-agent` | Provides `AuthStorage` and `ModelRegistry` classes for credential management | `src/agents/pi-model-discovery.ts:3-7` |

All from the same author's ecosystem ("pi" = the agent framework OpenClaw builds on).

## 4. Full Credential-to-Request Pipeline

### Step 1: Credential Storage

Location: `src/agents/auth-profiles/`

Credentials live in `~/.openclaw/agents/<agentId>/auth-profiles.json`. Each profile has a `type`: `"api_key"`, `"oauth"`, or `"token"`. OAuth profiles store `{ access, refresh, expires }` where the access token is the `sk-ant-oat...` string.

### Step 2: Credential Conversion

Location: `src/agents/pi-auth-credentials.ts:15-54`

`convertAuthProfileCredentialToPi()` maps OpenClaw's credential format to pi-ai's:

- `api_key` -> `{ type: "api_key", key: "<key>" }`
- `token` -> `{ type: "api_key", key: "<token>" }` (tokens treated as API keys)
- `oauth` -> `{ type: "oauth", access, refresh, expires }` (preserves OAuth metadata)

### Step 3: Credential Map

Location: `src/agents/pi-auth-credentials.ts:56-69`

`resolvePiCredentialMapFromStore()` builds a `Record<provider, credential>` map. One credential per provider (first match wins).

### Step 4: AuthStorage Construction

Location: `src/agents/pi-model-discovery.ts:92-148`

`discoverAuthStorage()` creates a pi-coding-agent `AuthStorage` instance. Tries in order:

1. `inMemory()` factory
2. `fromStorage()` with backend
3. `create()` / constructor

The AuthStorage is what pi-ai calls `.getApiKey(provider)` on when making requests.

### Step 5: StreamFn Assignment

Location: `src/agents/pi-embedded-runner/run/attempt.ts:1732-1734`

The agent session gets `streamSimple` from pi-ai as its base stream function. Then wrappers are layered on via `applyExtraParamsToAgent()`.

### Step 6: Wrapper Chain

Applied in order from `src/agents/pi-embedded-runner/extra-params.ts:325-468`:

1. **`createStreamFnWithExtraParams()`** -- injects temperature, maxTokens, cacheRetention, transport
2. **`createAnthropicBetaHeadersWrapper()`** -- where `isAnthropicOAuthApiKey()` runs; injects/filters beta headers per auth type
3. **`createAnthropicToolPayloadCompatibilityWrapper()`** -- normalizes tool schemas for non-native providers
4. **`createBedrockNoCacheWrapper()`** -- disables caching for non-Anthropic Bedrock models

Then back in `attempt.ts`, more wrappers are added:

5. **`cacheTrace.wrapStreamFn()`** -- logs cache hit/miss stats
6. **Thinking block sanitizer** -- strips thinking blocks for providers that reject them
7. **Tool call ID sanitizer** -- rewrites IDs for Mistral-like strict formats
8. **`wrapStreamFnTrimToolCallNames()`** -- trims whitespace from tool names
9. **`wrapStreamFnRepairMalformedToolCallArguments()`** -- fixes broken JSON in tool args
10. **`anthropicPayloadLogger.wrapStreamFn()`** -- logs full request/response payloads

### Step 7: The Actual HTTP Call

pi-ai's `streamSimple()` receives the final `options` (with merged headers, apiKey, etc.) and calls:

```
POST https://api.anthropic.com/v1/messages
Headers:
  x-api-key: sk-ant-oat-...  (or sk-ant-api-...)
  anthropic-version: 2023-06-01
  anthropic-beta: claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14
  content-type: application/json
```

## 5. Environment Variable Fallbacks

If no auth profile exists, `resolveApiKeyForProvider()` (`src/agents/model-auth.ts:279-286`) falls back to env vars defined in `src/agents/model-auth-env-vars.ts:3`:

```typescript
anthropic: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]
```

`ANTHROPIC_OAUTH_TOKEN` is checked first. If the resolved key source contains `"OAUTH_TOKEN"`, the auth mode is set to `"oauth"`. However, the OAuth detection for beta headers still relies on the `sk-ant-oat` prefix check at request time, not on the mode label.

## 6. Beta Header Merging

Location: `src/agents/pi-embedded-runner/anthropic-stream-wrappers.ts:39-50`

```typescript
function mergeAnthropicBetaHeader(
  headers: Record<string, string> | undefined,
  betas: string[],
): Record<string, string> {
  const merged = { ...headers };
  const existingKey = Object.keys(merged).find((key) => key.toLowerCase() === "anthropic-beta");
  const existing = existingKey ? parseHeaderList(merged[existingKey]) : [];
  const values = Array.from(new Set([...existing, ...betas]));
  const key = existingKey ?? "anthropic-beta";
  merged[key] = values.join(",");
  return merged;
}
```

Existing `anthropic-beta` headers are preserved and deduplicated with new betas. The header key casing is preserved from whatever already exists, or defaults to lowercase `anthropic-beta`.

## 7. Additional Beta Resolution

Location: `src/agents/pi-embedded-runner/anthropic-stream-wrappers.ts:211-241`

`resolveAnthropicBetas()` handles user-configured betas from model extra params:

- `extraParams.anthropicBeta` -- string or array of custom beta flags
- `extraParams.context1m` -- boolean to opt into `context-1m-2025-08-07` (only for `claude-opus-4` and `claude-sonnet-4` model prefixes)

These are resolved in `extra-params.ts:361-367` before being passed to `createAnthropicBetaHeadersWrapper()`.

## 8. Provider Capabilities

Location: `src/agents/provider-capabilities.ts`

The `anthropic` provider is classified with:

```typescript
anthropic: { providerFamily: "anthropic" }
```

This means native Anthropic tool schema mode and native tool choice mode. Other providers (OpenRouter, Kilocode, etc.) may need tool payload compatibility wrappers that convert Anthropic-native tool definitions to OpenAI function format.

## 9. Replication Checklist

To replicate this setup:

1. **Credential store** -- distinguish OAuth (`sk-ant-oat...`) from API key (`sk-ant-api...`) tokens
2. **Streaming HTTP client** -- calls `POST /v1/messages` with `x-api-key` header
3. **Beta header logic**:
   - For OAuth tokens: include `claude-code-20250219` and `oauth-2025-04-20`
   - For all Anthropic calls: include `fine-grained-tool-streaming-2025-05-14` and `interleaved-thinking-2025-05-14`
   - Exclude `context-1m-2025-08-07` when using OAuth
4. **Wrapper/middleware pattern** -- composable functions with signature `(model, context, options) => stream` that intercept and modify requests before they reach the HTTP layer
5. **Environment variable fallback** -- check `ANTHROPIC_OAUTH_TOKEN` before `ANTHROPIC_API_KEY`
