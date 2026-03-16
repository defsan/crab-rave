# OpenClaw Agent Loop — Internal Mechanics

This document describes the complete agentic execution loop used by OpenClaw's embedded Pi runner. It covers the three nested loop layers, all governing constants (verbatim), the built-in tool catalog, error classification, retry/fallback logic, context management, and tool result handling.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Layer 1 — Outer Loop: Fallback & Retry](#layer-1--outer-loop-fallback--retry)
3. [Layer 2 — Middle Loop: Compaction & Recovery](#layer-2--middle-loop-compaction--recovery)
4. [Layer 3 — Inner Loop: Single Turn Execution](#layer-3--inner-loop-single-turn-execution)
5. [Constants Reference](#constants-reference)
6. [Built-in Tool Catalog](#built-in-tool-catalog)
7. [Tool Profiles](#tool-profiles)
8. [Error Classification](#error-classification)
9. [Model Fallback Chain](#model-fallback-chain)
10. [Context Window Management](#context-window-management)
11. [Tool Result Truncation](#tool-result-truncation)
12. [Session Management](#session-management)
13. [Streaming & Event System](#streaming--event-system)
14. [Return Types](#return-types)

---

## Architecture Overview

The agent loop is a 3-layer nested structure. Each layer handles a different scope of concern:

```
User message
  -> runReplyAgent()                          [entry point]
    -> runAgentTurnWithFallback()             [Layer 1: retry/fallback]
      -> runEmbeddedPiAgent()                 [Layer 2: compaction/recovery]
        -> runEmbeddedAttempt()               [Layer 3: single LLM turn]
          -> session.prompt()                 [LLM call + tool execution]
```

### Key Source Files

| File | Role |
|------|------|
| `src/auto-reply/reply/agent-runner.ts` | Entry point: `runReplyAgent()` (line 63) |
| `src/auto-reply/reply/agent-runner-execution.ts` | Layer 1: `runAgentTurnWithFallback()` (line 77) |
| `src/agents/pi-embedded-runner/run.ts` | Layer 2: `runEmbeddedPiAgent()` (line ~809) |
| `src/agents/pi-embedded-runner/run/attempt.ts` | Layer 3: `runEmbeddedAttempt()` (line ~1204) |
| `src/agents/model-fallback.ts` | `runWithModelFallback()` (line 505) |
| `src/agents/failover-error.ts` | `FailoverError` class |
| `src/agents/pi-embedded-helpers/errors.ts` | Error classification functions |
| `src/agents/tool-catalog.ts` | Core tool definitions & profiles |
| `src/agents/defaults.ts` | Default provider/model/context tokens |
| `src/agents/context-window-guard.ts` | Context window guardrails |
| `src/agents/pi-embedded-runner/tool-result-truncation.ts` | Tool result size management |
| `src/agents/pi-embedded-runner/tool-result-context-guard.ts` | Pre-send context budget enforcement |
| `src/agents/pi-embedded-runner/tool-result-char-estimator.ts` | Token/char estimation |
| `src/agents/pi-embedded-runner/compaction-safety-timeout.ts` | Compaction timeout wrapper |
| `src/infra/backoff.ts` | `BackoffPolicy` type & `computeBackoff()` |

---

## Layer 1 — Outer Loop: Fallback & Retry

**File:** `src/auto-reply/reply/agent-runner-execution.ts`
**Function:** `runAgentTurnWithFallback()`

This is a `while (true)` loop (line 148) that wraps the entire agent run with error handling and model fallback.

### Pseudocode

```
while (true) {
  try {
    result = await runWithModelFallback({
      run: (provider, model, options) => {
        return isCliProvider(provider)
          ? runCliAgent(...)
          : runEmbeddedPiAgent(...)    // -> Layer 2
      }
    })

    // Post-run: check for embedded context overflow or role ordering errors
    if (embeddedError is contextOverflow && !alreadyResetAfterCompaction) {
      resetSession()
      return final error payload
    }
    if (embeddedError.kind === "role_ordering") {
      resetSession(cleanupTranscripts: true)
      return final error payload
    }

    break  // success
  } catch (err) {
    classify error:
      isBilling?
      isContextOverflow?
      isCompactionFailure?
      isSessionCorruption?
      isRoleOrderingError?
      isTransientHttp?

    if (isCompactionFailure && !alreadyReset) -> resetSession, return final
    if (isRoleOrderingError)                  -> resetSession(cleanupTranscripts), return final
    if (isSessionCorruption)                  -> delete transcript, clear store, return final
    if (isTransientHttp && !alreadyRetried)   -> sleep(TRANSIENT_HTTP_RETRY_DELAY_MS), continue
    if (isTransientHttp && alreadyRetried)    -> return final error
    else                                      -> return final error (billing msg or generic)
  }
}
```

### Key Constant

```typescript
const TRANSIENT_HTTP_RETRY_DELAY_MS = 2_500;  // 2.5 seconds, one retry only
```

### Error Detection Patterns (in the catch block)

```typescript
const isBilling         = isBillingErrorMessage(message);
const isContextOverflow = !isBilling && isLikelyContextOverflowError(message);
const isCompactionFailure = !isBilling && isCompactionFailureError(message);
const isSessionCorruption = /function call turn comes immediately after/i.test(message);
const isRoleOrderingError = /incorrect role information|roles must alternate/i.test(message);
const isTransientHttp   = isTransientHttpError(message);
```

---

## Layer 2 — Middle Loop: Compaction & Recovery

**File:** `src/agents/pi-embedded-runner/run.ts`
**Function:** `runEmbeddedPiAgent()`

This is the core agentic loop — a `while (true)` loop (line ~809) that runs attempts and handles context overflow via auto-compaction and tool result truncation.

### Pseudocode

```
MAX_RUN_LOOP_ITERATIONS = resolveMaxRunRetryIterations(profileCandidates.length)
runLoopIterations = 0

while (true) {
  if (runLoopIterations >= MAX_RUN_LOOP_ITERATIONS) {
    return error payload  // prevent infinite retries
  }
  runLoopIterations += 1

  attempt = await runEmbeddedAttempt({...})  // -> Layer 3

  // Check for context overflow -> try auto-compaction
  if (contextOverflowError && !alreadyCompacted) {
    compactResult = await contextEngine.compact({
      sessionFile,
      tokenBudget: contextInfo.tokens,
    })
    if (compactResult.compacted) {
      continue  // retry with compacted session
    }
  }

  // Check for oversized tool results -> try truncation
  if (hasOversizedToolResults) {
    truncResult = await truncateOversizedToolResultsInSession({
      sessionFile,
      contextWindowTokens,
    })
    if (truncResult.truncated) {
      continue  // retry with truncated results
    }
  }

  break  // no recovery needed
}
```

### Run Loop Iteration Constants

```typescript
// src/agents/pi-embedded-runner/run.ts
const BASE_RUN_RETRY_ITERATIONS      = 24;
const RUN_RETRY_ITERATIONS_PER_PROFILE = 8;
const MIN_RUN_RETRY_ITERATIONS       = 32;
const MAX_RUN_RETRY_ITERATIONS       = 160;

function resolveMaxRunRetryIterations(profileCandidateCount: number): number {
  const scaled =
    BASE_RUN_RETRY_ITERATIONS +
    Math.max(1, profileCandidateCount) * RUN_RETRY_ITERATIONS_PER_PROFILE;
  return Math.min(MAX_RUN_RETRY_ITERATIONS, Math.max(MIN_RUN_RETRY_ITERATIONS, scaled));
}
```

The actual `MAX_RUN_LOOP_ITERATIONS` is **dynamic** — computed from the number of auth profile candidates. Range: **32 to 160**.

### Overload Failover Backoff

```typescript
// src/agents/pi-embedded-runner/run.ts
const OVERLOAD_FAILOVER_BACKOFF_POLICY: BackoffPolicy = {
  initialMs: 250,
  maxMs: 1_500,
  factor: 2,
  jitter: 0.2,
};
```

### Copilot Token Refresh Timing

```typescript
const COPILOT_REFRESH_MARGIN_MS    = 5 * 60 * 1000;   // 300,000 ms = 5 minutes
const COPILOT_REFRESH_RETRY_MS     = 60 * 1000;        // 60,000 ms = 1 minute
const COPILOT_REFRESH_MIN_DELAY_MS = 5 * 1000;          // 5,000 ms = 5 seconds
```

### Anthropic Refusal Magic String Redaction

```typescript
const ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL = "ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL";
const ANTHROPIC_MAGIC_STRING_REPLACEMENT     = "ANTHROPIC MAGIC STRING TRIGGER REFUSAL (redacted)";
```

Prompts containing the magic string are scrubbed via `scrubAnthropicRefusalMagic()` before being sent to the model, to prevent refusal test tokens from poisoning session transcripts.

### Usage Accumulator

Tracks cumulative token usage across all attempts within a run:

```typescript
type UsageAccumulator = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  lastCacheRead: number;   // from most recent API call only
  lastCacheWrite: number;
  lastInput: number;
};
```

---

## Layer 3 — Inner Loop: Single Turn Execution

**File:** `src/agents/pi-embedded-runner/run/attempt.ts`
**Function:** `runEmbeddedAttempt()`

Executes a single agent turn: build context -> call LLM -> process tools -> return result.

### Step-by-Step Flow

#### 1. Session Initialization

```typescript
const sessionManager = SessionManager.open(params.sessionFile);
const { session } = await createAgentSession({
  cwd: resolvedWorkspace,
  agentDir,
  model: params.model,
  thinkingLevel: mapThinkingLevel(params.thinkLevel),
  tools: builtInTools,
  customTools: allCustomTools,
  sessionManager,
  settingsManager,
  resourceLoader,
});
```

Session files are stored as JSONL at `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`.

#### 2. Message Sanitization Pipeline

Messages go through a multi-step cleanup before being sent to the LLM:

```
activeSession.messages (from session file)
  -> sanitizeSessionHistory()         // Google cleanup, tool call ID repair
  -> validateGeminiTurns()            // if Gemini provider
  -> validateAnthropicTurns()         // if Anthropic provider
  -> limitHistoryTurns()              // DM history limit from session key
  -> sanitizeToolUseResultPairing()   // repair orphaned tool_use/tool_result
  -> contextEngine.assemble()         // context engine may further modify
```

#### 3. System Prompt Assembly

```typescript
const appendPrompt = buildEmbeddedSystemPrompt({
  workspaceDir,
  defaultThinkLevel,
  reasoningLevel,
  extraSystemPrompt,
  ownerNumbers,
  skillsPrompt,
  docsPath,
  workspaceNotes,
  reactionGuidance,
  runtimeInfo,
  tools,
  contextFiles,
  // ... many more params
});

applySystemPromptOverrideToSession(session, systemPromptText);
```

#### 4. StreamFn Resolution (LLM Call)

The `activeSession.agent.streamFn` is resolved per-provider with a wrapper chain:

**Base:**
- Default: `streamSimple` (from `@mariozechner/pi-ai`)
- Ollama: `createConfiguredOllamaStreamFn` (direct `/api/chat`)
- OpenAI WebSocket: `createOpenAIWebSocketStreamFn`

**Wrapper chain (applied in order):**

1. Cache trace wrapper (if enabled)
2. Drop thinking blocks wrapper
3. Sanitize tool call IDs wrapper
4. Downgrade OpenAI reasoning pairs
5. Yield abort override wrapper
6. Trim tool call names wrapper
7. Repair malformed tool arguments
8. Decode X.ai tool call arguments
9. Anthropic payload logger wrapper

#### 5. Prompt Invocation

```typescript
// Load images if present in prompt
const imageResult = await detectAndLoadPromptImages({
  prompt: effectivePrompt,
  workspaceDir,
  model: params.model,
  existingImages: params.images,
  maxBytes: MAX_IMAGE_BYTES,
  maxDimensionPx: resolveImageSanitizationLimits(params.config).maxDimensionPx,
});

// Invoke the prompt
if (imageResult.images.length > 0) {
  await abortable(activeSession.prompt(effectivePrompt, { images: imageResult.images }));
} else {
  await abortable(activeSession.prompt(effectivePrompt));
}
```

Inside `session.prompt()` (pi-agent-core SDK):
1. Appends user message to `activeSession.messages`
2. Calls `streamFn(model, { messages, system, tools }, options)` — the resolved stream function
3. Streams LLM response chunks
4. Appends assistant message to messages as chunks arrive
5. For each `tool_use` block in the response:
   - Executes tool locally
   - Appends `tool_result` message
   - If the model wants more tools, stays in the internal tool loop
6. Exits when the model produces a final text-only response (`stop_reason: "end_turn"`)

#### 6. Tool Execution Events

Event types dispatched during tool execution:

```
agent_start              -> Agent loop begins
message_start            -> Assistant message begins
message_update           -> Text delta chunk arrives
message_end              -> Assistant message complete
tool_execution_start     -> Tool call invocation begins
tool_execution_update    -> Tool execution streaming output
tool_execution_end       -> Tool execution complete
auto_compaction_start    -> Compaction triggered
auto_compaction_end      -> Compaction finished
agent_end                -> Agent loop ends
```

#### 7. Turn End Conditions

**A. Natural completion:** LLM emits `stop_reason: "end_turn"` with text-only output (no pending `tool_use` blocks).

**B. `sessions_yield` tool called:** The agent voluntarily ends its turn to receive sub-agent results.

```typescript
// Detection
let yieldDetected = false;
onYield: (message) => {
  yieldDetected = true;
  runAbortController.abort("sessions_yield");
}
// Cleanup: strip yield artifacts, persist yield context message
```

**C. Abort/timeout:**

```typescript
const abortTimer = setTimeout(() => abortRun(true), Math.max(1, params.timeoutMs));
```

#### 8. Compaction Wait (Post-Turn)

After the prompt completes, the attempt waits for any in-flight compaction to settle:

```typescript
const COMPACTION_RETRY_AGGREGATE_TIMEOUT_MS = 60_000;  // 60 seconds

const compactionRetryWait = await waitForCompactionRetryWithAggregateTimeout({
  waitForCompactionRetry,
  abortable,
  aggregateTimeoutMs: COMPACTION_RETRY_AGGREGATE_TIMEOUT_MS,
  isCompactionStillInFlight: isCompactionInFlight,
});
```

If compaction times out, the pre-compaction message snapshot is used instead.

### Attempt Constants

```typescript
// src/agents/pi-embedded-runner/run/attempt.ts
const MAX_TOOLCALL_REPAIR_BUFFER_CHARS   = 64_000;
const MAX_TOOLCALL_REPAIR_TRAILING_CHARS = 3;
const SESSIONS_YIELD_INTERRUPT_CUSTOM_TYPE = "openclaw.sessions_yield_interrupt";
const SESSIONS_YIELD_CONTEXT_CUSTOM_TYPE   = "openclaw.sessions_yield";
const COMPACTION_RETRY_AGGREGATE_TIMEOUT_MS = 60_000;  // local to runEmbeddedAttempt

// src/agents/pi-embedded-runner/compaction-safety-timeout.ts
export const EMBEDDED_COMPACTION_TIMEOUT_MS = 300_000;  // 5 minutes
```

---

## Constants Reference

All constants that govern the agent loop, organized by subsystem.

### Defaults (`src/agents/defaults.ts`)

```typescript
export const DEFAULT_PROVIDER       = "anthropic";
export const DEFAULT_MODEL           = "claude-opus-4-6";
export const DEFAULT_CONTEXT_TOKENS = 200_000;
```

### Context Window Guard (`src/agents/context-window-guard.ts`)

```typescript
export const CONTEXT_WINDOW_HARD_MIN_TOKENS  = 16_000;   // blocks execution below this
export const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 32_000;   // emits warning below this
```

### Run Loop Iterations (`src/agents/pi-embedded-runner/run.ts`)

```typescript
const BASE_RUN_RETRY_ITERATIONS        = 24;
const RUN_RETRY_ITERATIONS_PER_PROFILE = 8;
const MIN_RUN_RETRY_ITERATIONS         = 32;
const MAX_RUN_RETRY_ITERATIONS         = 160;
```

Dynamic formula: `BASE + max(1, profileCount) * PER_PROFILE`, clamped to `[32, 160]`.

### Overload Failover Backoff (`src/agents/pi-embedded-runner/run.ts`)

```typescript
const OVERLOAD_FAILOVER_BACKOFF_POLICY: BackoffPolicy = {
  initialMs: 250,
  maxMs: 1_500,
  factor: 2,
  jitter: 0.2,
};
```

### Backoff Engine (`src/infra/backoff.ts`)

```typescript
export type BackoffPolicy = {
  initialMs: number;
  maxMs: number;
  factor: number;
  jitter: number;
};

export function computeBackoff(policy: BackoffPolicy, attempt: number) {
  const base = policy.initialMs * policy.factor ** Math.max(attempt - 1, 0);
  const jitter = base * policy.jitter * Math.random();
  return Math.min(policy.maxMs, Math.round(base + jitter));
}
```

### Transient HTTP Retry (`src/auto-reply/reply/agent-runner-execution.ts`)

```typescript
const TRANSIENT_HTTP_RETRY_DELAY_MS = 2_500;  // fixed 2.5s, one retry only
```

### Copilot Token Refresh (`src/agents/pi-embedded-runner/run.ts`)

```typescript
const COPILOT_REFRESH_MARGIN_MS    = 5 * 60 * 1000;   // 5 minutes before expiry
const COPILOT_REFRESH_RETRY_MS     = 60 * 1000;        // 1 minute between retries
const COPILOT_REFRESH_MIN_DELAY_MS = 5 * 1000;          // 5 second minimum gap
```

### Anthropic Refusal Scrubbing (`src/agents/pi-embedded-runner/run.ts`)

```typescript
const ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL = "ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL";
const ANTHROPIC_MAGIC_STRING_REPLACEMENT     = "ANTHROPIC MAGIC STRING TRIGGER REFUSAL (redacted)";
```

### Compaction Timeouts

```typescript
// src/agents/pi-embedded-runner/compaction-safety-timeout.ts
export const EMBEDDED_COMPACTION_TIMEOUT_MS = 300_000;          // 5 minutes

// src/agents/pi-embedded-runner/run/attempt.ts (local)
const COMPACTION_RETRY_AGGREGATE_TIMEOUT_MS = 60_000;            // 60 seconds
```

### Tool Result Truncation (`src/agents/pi-embedded-runner/tool-result-truncation.ts`)

```typescript
const MAX_TOOL_RESULT_CONTEXT_SHARE = 0.3;      // 30% of context window
export const HARD_MAX_TOOL_RESULT_CHARS = 400_000;  // hard cap regardless of window
const MIN_KEEP_CHARS = 2_000;                     // minimum preserved on truncation
```

### Tool Result Context Guard (`src/agents/pi-embedded-runner/tool-result-context-guard.ts`)

```typescript
const CONTEXT_INPUT_HEADROOM_RATIO       = 0.75;   // 75% of context for input
const SINGLE_TOOL_RESULT_CONTEXT_SHARE   = 0.5;    // 50% of context per single result
export const CONTEXT_LIMIT_TRUNCATION_NOTICE = "[truncated: output exceeded context limit]";
export const PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER =
  "[compacted: tool output removed to free context]";
```

### Char-to-Token Estimates (`src/agents/pi-embedded-runner/tool-result-char-estimator.ts`)

```typescript
export const CHARS_PER_TOKEN_ESTIMATE              = 4;
export const TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE  = 2;
const IMAGE_CHAR_ESTIMATE                           = 8_000;
```

### Tool Call Repair (`src/agents/pi-embedded-runner/run/attempt.ts`)

```typescript
const MAX_TOOLCALL_REPAIR_BUFFER_CHARS   = 64_000;
const MAX_TOOLCALL_REPAIR_TRAILING_CHARS = 3;
```

### Session Yield Custom Types (`src/agents/pi-embedded-runner/run/attempt.ts`)

```typescript
const SESSIONS_YIELD_INTERRUPT_CUSTOM_TYPE = "openclaw.sessions_yield_interrupt";
const SESSIONS_YIELD_CONTEXT_CUSTOM_TYPE   = "openclaw.sessions_yield";
```

### Session Manager Cache (`src/agents/pi-embedded-runner/session-manager-cache.ts`)

```typescript
const DEFAULT_SESSION_MANAGER_TTL_MS = 45_000;  // 45 seconds
```

### Idle Wait Timeout (`src/agents/pi-embedded-runner/wait-for-idle-before-flush.ts`)

```typescript
const DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS = 30_000;  // 30 seconds
```

### Model Fallback Probe Throttle (`src/agents/model-fallback.ts`)

```typescript
const MIN_PROBE_INTERVAL_MS = 30_000;          // 30 seconds between probes per key
const PROBE_MARGIN_MS       = 2 * 60 * 1000;   // 2 minutes
const PROBE_STATE_TTL_MS    = 24 * 60 * 60 * 1000;  // 24 hours
const MAX_PROBE_KEYS        = 256;
```

### Transient HTTP Error Codes (`src/agents/pi-embedded-helpers/errors.ts`)

```typescript
const TRANSIENT_HTTP_ERROR_CODES = new Set([499, 500, 502, 503, 504, 521, 522, 523, 524, 529]);
const CLOUDFLARE_HTML_ERROR_CODES = new Set([521, 522, 523, 524, 525, 526, 530]);
```

---

## Built-in Tool Catalog

**File:** `src/agents/tool-catalog.ts`

Tools are organized into sections and associated with profiles that control which tools are available to which agent configurations.

### Tool Sections

| Section ID | Label |
|------------|-------|
| `fs` | Files |
| `runtime` | Runtime |
| `web` | Web |
| `memory` | Memory |
| `sessions` | Sessions |
| `ui` | UI |
| `messaging` | Messaging |
| `automation` | Automation |
| `nodes` | Nodes |
| `agents` | Agents |
| `media` | Media |

### Complete Tool List

| Tool ID | Description | Section | Profiles | In OpenClaw Group |
|---------|-------------|---------|----------|-------------------|
| `read` | Read file contents | fs | coding | no |
| `write` | Create or overwrite files | fs | coding | no |
| `edit` | Make precise edits | fs | coding | no |
| `apply_patch` | Patch files (OpenAI) | fs | coding | no |
| `exec` | Run shell commands | runtime | coding | no |
| `process` | Manage background processes | runtime | coding | no |
| `web_search` | Search the web | web | coding | yes |
| `web_fetch` | Fetch web content | web | coding | yes |
| `memory_search` | Semantic search | memory | coding | yes |
| `memory_get` | Read memory files | memory | coding | yes |
| `sessions_list` | List sessions | sessions | coding, messaging | yes |
| `sessions_history` | Session history | sessions | coding, messaging | yes |
| `sessions_send` | Send to session | sessions | coding, messaging | yes |
| `sessions_spawn` | Spawn sub-agent | sessions | coding | yes |
| `sessions_yield` | End turn to receive sub-agent results | sessions | coding | yes |
| `subagents` | Manage sub-agents | sessions | coding | yes |
| `session_status` | Session status | sessions | minimal, coding, messaging | yes |
| `browser` | Control web browser | ui | *(none)* | yes |
| `canvas` | Control canvases | ui | *(none)* | yes |
| `message` | Send messages | messaging | messaging | yes |
| `cron` | Schedule tasks | automation | coding | yes |
| `gateway` | Gateway control | automation | *(none)* | yes |
| `nodes` | Nodes + devices | nodes | *(none)* | yes |
| `agents_list` | List agents | agents | *(none)* | yes |
| `image` | Image understanding | media | coding | yes |
| `tts` | Text-to-speech conversion | media | *(none)* | yes |

Tools with empty `profiles: []` are available only via the `full` profile or explicit configuration.

### Additional Runtime Tools

Created in `src/agents/openclaw-tools.ts`:
- **pdf** — PDF understanding (optional, requires `agentDir`)
- Channel-specific tools aggregated from plugins via `src/agents/channel-tools.ts`

---

## Tool Profiles

**File:** `src/agents/tool-catalog.ts`

```typescript
export type ToolProfileId = "minimal" | "coding" | "messaging" | "full";
```

| Profile | Allowed Tools |
|---------|---------------|
| **minimal** | `session_status` |
| **coding** | `read`, `write`, `edit`, `apply_patch`, `exec`, `process`, `web_search`, `web_fetch`, `memory_search`, `memory_get`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `sessions_yield`, `subagents`, `session_status`, `cron`, `image` |
| **messaging** | `sessions_list`, `sessions_history`, `sessions_send`, `session_status`, `message` |
| **full** | All tools (no allowlist restrictions) |

Profile policy structure:

```typescript
type ToolProfilePolicy = {
  allow?: string[];   // whitelist (if set, only these tools are available)
  deny?: string[];    // blacklist (not currently used by built-in profiles)
};

// "full" profile has no allow/deny = unrestricted
```

---

## Error Classification

**File:** `src/agents/pi-embedded-helpers/errors.ts`

### FailoverReason Type

```typescript
// src/agents/pi-embedded-helpers/types.ts
export type FailoverReason =
  | "auth"
  | "auth_permanent"
  | "format"
  | "rate_limit"
  | "overloaded"
  | "billing"
  | "timeout"
  | "model_not_found"
  | "session_expired"
  | "unknown";
```

### FailoverError Class

```typescript
// src/agents/failover-error.ts
export class FailoverError extends Error {
  readonly reason: FailoverReason;
  readonly provider?: string;
  readonly model?: string;
  readonly profileId?: string;
  readonly status?: number;
  readonly code?: string;
}
```

### Reason-to-HTTP-Status Mapping

| Reason | HTTP Status |
|--------|-------------|
| `billing` | 402 |
| `rate_limit` | 429 |
| `overloaded` | 503 |
| `auth` | 401 |
| `auth_permanent` | 403 |
| `timeout` | 408 |
| `format` | 400 |
| `model_not_found` | 404 |
| `session_expired` | 410 |

### Key Detection Functions

| Function | What It Detects |
|----------|-----------------|
| `isBillingErrorMessage(msg)` | 402 codes, credit/quota exhaustion patterns |
| `isLikelyContextOverflowError(msg)` | Heuristic: context overflow keywords, excludes rate limits/auth/billing |
| `isContextOverflowError(msg)` | Strict: explicit context/window/length/token patterns |
| `isCompactionFailureError(msg)` | "summarization failed", "auto-compaction", "compaction" + overflow |
| `isTransientHttpError(msg)` | HTTP codes in `TRANSIENT_HTTP_ERROR_CODES` set |
| `isOverloadedErrorMessage(msg)` | Overload/capacity keywords |
| `isTimeoutErrorMessage(msg)` | Timeout patterns |

### Transient HTTP Error Codes

```typescript
const TRANSIENT_HTTP_ERROR_CODES = new Set([
  499,  // client closed request
  500,  // internal server error
  502,  // bad gateway
  503,  // service unavailable
  504,  // gateway timeout
  521,  // Cloudflare: web server is down
  522,  // Cloudflare: connection timed out
  523,  // Cloudflare: origin is unreachable
  524,  // Cloudflare: a timeout occurred
  529,  // overloaded
]);
```

### Error User Messages

```typescript
// Billing
export const BILLING_ERROR_USER_MESSAGE = formatBillingErrorMessage();
// => "⚠️ API provider returned a billing error — your API key has run out of credits
//     or has an insufficient balance. Check your provider's billing dashboard and
//     top up or switch to a different API key."

// Rate limit
const RATE_LIMIT_ERROR_USER_MESSAGE =
  "⚠️ API rate limit reached. Please try again later.";

// Overloaded
const OVERLOADED_ERROR_USER_MESSAGE =
  "The AI service is temporarily overloaded. Please try again in a moment.";
```

---

## Model Fallback Chain

**File:** `src/agents/model-fallback.ts`
**Function:** `runWithModelFallback<T>()`

### Candidate Resolution

1. **Primary:** the requested `(provider, model)` pair
2. **Fallbacks:** from `config.agents.defaults.model.fallbacks` or `fallbacksOverride`
3. Deduplication via `modelKey(provider, model)`

### Fallback Loop

```
for each candidate in [primary, ...fallbacks]:
  if all profiles for this provider are in cooldown:
    decision = resolveCooldownDecision()
    if decision.type === "skip":
      log skip, continue to next candidate
    if decision.type === "attempt" && decision.markProbe:
      mark probe usage

  try:
    result = await run(candidate.provider, candidate.model, options)
    return { result, provider, model, attempts }
  catch:
    if isLikelyContextOverflowError: rethrow immediately
    coerce to FailoverError
    track attempt
    continue to next candidate

// All failed:
throw summary error
```

### Cooldown Skip Conditions

- `auth` / `auth_permanent` errors -> always skip
- `billing` + non-primary or no fallback candidates -> skip
- Other transient (`rate_limit`, `overloaded`, `unknown`) -> skip if already probed this run

### Probe Conditions (attempt despite cooldown)

- Primary + requested model -> always attempt
- Primary + probe throttle open (30s interval) + within expiry margin (2min) -> attempt + mark probe
- Same-provider fallback + transient reason -> attempt
- Single-provider + billing -> allow probe on throttle

### Probe Throttle Constants

```typescript
const MIN_PROBE_INTERVAL_MS = 30_000;          // 30s between probes per key
const PROBE_MARGIN_MS       = 2 * 60 * 1000;   // 2 minutes
const PROBE_STATE_TTL_MS    = 24 * 60 * 60 * 1000;  // 24 hours
const MAX_PROBE_KEYS        = 256;
```

---

## Context Window Management

### Resolution Priority

`resolveContextWindowInfo()` in `src/agents/context-window-guard.ts`:

1. `config.models.providers[provider].models[id].contextWindow` (from `modelsConfig`)
2. `model.contextWindow` (from model metadata)
3. `DEFAULT_CONTEXT_TOKENS` = `200_000` (fallback)

Then optionally capped by `config.agents.defaults.contextTokens` if lower.

### Guard Evaluation

```typescript
evaluateContextWindowGuard(info) => {
  shouldWarn: tokens > 0 && tokens < CONTEXT_WINDOW_WARN_BELOW_TOKENS (32,000),
  shouldBlock: tokens > 0 && tokens < CONTEXT_WINDOW_HARD_MIN_TOKENS (16,000),
}
```

### Pre-Send Context Budget

`installToolResultContextGuard()` in `tool-result-context-guard.ts`:

```typescript
contextBudgetChars = max(1024, contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE * CONTEXT_INPUT_HEADROOM_RATIO)
                   = max(1024, tokens * 4 * 0.75)
                   = max(1024, tokens * 3)

maxSingleToolResultChars = max(1024, contextWindowTokens * TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE * SINGLE_TOOL_RESULT_CONTEXT_SHARE)
                         = max(1024, tokens * 2 * 0.5)
                         = max(1024, tokens * 1)
```

Applied as a `transformContext` hook on the agent — runs before every LLM call:
1. Truncate each individual tool result to `maxSingleToolResultChars`
2. If total context still exceeds `contextBudgetChars`, compact oldest tool results first (replace with `PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER`)

---

## Tool Result Truncation

**File:** `src/agents/pi-embedded-runner/tool-result-truncation.ts`

### Size Calculation

```typescript
function calculateMaxToolResultChars(contextWindowTokens: number): number {
  const maxTokens = Math.floor(contextWindowTokens * MAX_TOOL_RESULT_CONTEXT_SHARE);  // 0.3
  const maxChars = maxTokens * 4;  // ~4 chars per token
  return Math.min(maxChars, HARD_MAX_TOOL_RESULT_CHARS);  // cap at 400,000
}
```

For `DEFAULT_CONTEXT_TOKENS = 200,000`:
- `maxTokens = 60,000`
- `maxChars = 240,000`
- Result: `min(240,000, 400,000) = 240,000 chars`

### Truncation Strategy

`truncateToolResultText()` uses a **head+tail** strategy when the tail contains important content (errors, results, JSON structure), otherwise preserves the beginning only.

```
if hasImportantTail(text) and budget > MIN_KEEP_CHARS * 2:
  tailBudget = min(budget * 0.3, 4000)
  headBudget = budget - tailBudget - MIDDLE_OMISSION_MARKER.length
  return head + MIDDLE_OMISSION_MARKER + tail + TRUNCATION_SUFFIX
else:
  return head + TRUNCATION_SUFFIX
```

Important tail detection (`hasImportantTail`): checks last ~2000 chars for patterns like `error`, `exception`, `failed`, `traceback`, JSON closing `}`, `total`, `summary`, `result`.

### Truncation Markers

```typescript
const TRUNCATION_SUFFIX =
  "\n\n⚠️ [Content truncated — original was too large for the model's context window. " +
  "The content above is a partial view. If you need more, request specific sections or use " +
  "offset/limit parameters to read smaller chunks.]";

const MIDDLE_OMISSION_MARKER =
  "\n\n⚠️ [... middle content omitted — showing head and tail ...]\n\n";
```

### Session-Level Truncation

`truncateOversizedToolResultsInSession()`:
1. Opens session manager, walks current branch
2. Finds all `toolResult` messages exceeding `maxChars`
3. Branches from parent of first oversized entry
4. Re-appends all entries from that point with truncated tool results
5. Preserves all non-message entries (compaction, model_change, thinking_level_change, custom, session_info)
6. Skips `branch_summary` and `label` entries to avoid ID inconsistency

---

## Session Management

### Session File Format

JSONL file at `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`

Entry types in the session file:
- `message` — user, assistant, or toolResult message
- `compaction` — context compaction summary
- `thinking_level_change` — thinking level adjustment
- `model_change` — provider/model switch
- `custom` — custom entry (e.g., yield interrupt)
- `custom_message` — custom message with display flag
- `branch_summary` — branch summary referencing entry IDs
- `label` — label referencing entry IDs
- `session_info` — session metadata (name)

### SessionManager (from `@mariozechner/pi-coding-agent`)

Key methods:
- `SessionManager.open(sessionFile)` — open/create session
- `sessionManager.getBranch()` — get current branch entries
- `sessionManager.appendMessage(msg)` — append message
- `sessionManager.appendCompaction(...)` — append compaction entry
- `sessionManager.branch(parentId)` — branch from a specific entry
- `sessionManager.resetLeaf()` — reset to root

---

## Streaming & Event System

### Event Subscription

`subscribeEmbeddedPiSession()` in `src/agents/pi-embedded-runner/run/attempt.ts` subscribes to session events and routes them to callbacks:

```typescript
const subscription = subscribeEmbeddedPiSession({
  session: activeSession,
  onToolResult,
  onReasoningStream,
  onBlockReply,
  onPartialReply,
  onAssistantMessageStart,
  onAgentEvent,
  // ... more callbacks
});
```

### Subscription Return Values

```typescript
const {
  assistantTexts,                    // string[] — final text outputs
  toolMetas,                         // Array<{ toolName, meta? }> — executed tools
  unsubscribe,
  waitForCompactionRetry,
  isCompactionInFlight,
  getMessagingToolSentTexts,
  getMessagingToolSentMediaUrls,
  getMessagingToolSentTargets,
  getSuccessfulCronAdds,
  didSendViaMessagingTool,
  getLastToolError,
  getUsageTotals,
  getCompactionCount,
} = subscription;
```

---

## Return Types

### EmbeddedRunAttemptResult (Layer 3)

```typescript
export type EmbeddedRunAttemptResult = {
  // Abort/timeout state
  aborted: boolean;
  timedOut: boolean;
  timedOutDuringCompaction: boolean;
  promptError: unknown;                     // null if successful
  sessionIdUsed: string;

  // Bootstrap/system prompt state
  bootstrapPromptWarningSignaturesSeen?: string[];
  bootstrapPromptWarningSignature?: string;
  systemPromptReport?: SessionSystemPromptReport;

  // Conversation state
  messagesSnapshot: AgentMessage[];          // full message history after turn
  assistantTexts: string[];                  // final text outputs from this turn
  toolMetas: Array<{ toolName: string; meta?: string }>;
  lastAssistant: AssistantMessage | undefined;
  lastToolError?: {
    toolName: string;
    meta?: string;
    error?: string;
    mutatingAction?: boolean;
    actionFingerprint?: string;
  };

  // Messaging tool output
  didSendViaMessagingTool: boolean;
  messagingToolSentTexts: string[];
  messagingToolSentMediaUrls: string[];
  messagingToolSentTargets: MessagingToolSend[];
  successfulCronAdds?: number;

  // Format/usage tracking
  cloudCodeAssistFormatError: boolean;
  attemptUsage?: NormalizedUsage;             // { input, output, cacheRead, cacheWrite, total }
  compactionCount?: number;

  // Extension/plugin state
  clientToolCall?: { name: string; params: Record<string, unknown> };
  yieldDetected?: boolean;
};
```

### AgentRunLoopResult (Layer 1)

```typescript
export type AgentRunLoopResult =
  | {
      kind: "success";
      runId: string;
      runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
      fallbackProvider?: string;
      fallbackModel?: string;
      fallbackAttempts: RuntimeFallbackAttempt[];
      didLogHeartbeatStrip: boolean;
      autoCompactionCompleted: boolean;
      directlySentBlockKeys?: Set<string>;
    }
  | { kind: "final"; payload: ReplyPayload };

export type RuntimeFallbackAttempt = {
  provider: string;
  model: string;
  error: string;
  reason?: string;
  status?: number;
  code?: string;
};
```
