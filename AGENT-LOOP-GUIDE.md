# Crab Rave — Agent Loop Guide

## What the agent loop is

The agent loop is the engine that turns a single user message into a final response. Its job
is to let the model call tools repeatedly — running shell commands, reading files, etc. — and
keep feeding the results back until the model decides it is done and returns a plain text answer.

Without a loop, the model answers in one shot. With it, the model can take dozens of actions
before replying, much like a human who looks things up before writing an answer.

---

## The three layers

The loop is structured as three nested layers, each with a different concern.

```
runAgentLoop()           — Layer 1: retry wrapper (transient errors)
  runAgentTurn()         — Layer 2: tool loop (execute tools, keep going)
    runSingleAttempt()   — Layer 3: one LLM call
      modelConnection.prompt()
```

### Layer 1 — Retry wrapper (`runAgentLoop`)

`src/agent/agent-loop.ts:118`

Prepends the new user message to the conversation history and calls Layer 2. If Layer 2
throws a *transient* error (overload, timeout, rate limit, 5xx), it waits and retries up to
`config.maxRetries` times (default: 3) with a linearly increasing delay (`2500ms × attempt`).
Non-transient errors (auth failures, bad requests) are re-thrown immediately.

On success it appends the final assistant message to the message list and returns both the
response text and the updated message array.

```
attempt 1  ──▶  Layer 2
  transient error ──▶ wait 2.5s
attempt 2  ──▶  Layer 2
  transient error ──▶ wait 5s
attempt 3  ──▶  Layer 2
  failure  ──▶  throw
```

### Layer 2 — Tool loop (`runAgentTurn`)

`src/agent/agent-loop.ts:44`

The actual agentic loop. Calls Layer 3 repeatedly until one of two things happens:

- The model returns a response with **no tool calls** → the text is the final answer, return it.
- The iteration counter reaches `config.maxAgentIterations` (default: 20) → return a
  fallback message.

For each iteration with tool calls:
1. Appends the assistant message (including the raw tool call XML) to the message list.
2. Executes each tool by looking it up in the `ToolRegistry` by name.
3. Appends each result as a `role: "tool"` message.
4. Goes back to the top of the loop — the model now sees its tool calls and their results.

Unknown tool names return an error string rather than throwing, so the model can recover.

### Layer 3 — Single LLM call (`runSingleAttempt`)

`src/agent/agent-loop.ts:23`

Builds the system prompt (base instructions + tool descriptions) and calls
`modelConnection.prompt(messages, systemPrompt)`. Returns the raw `LLMResponse` containing
the text and any parsed tool calls.

---

## How tool calling works

crab-rave does **not** use the Anthropic native tool-use API (`tools: [...]` in the request
body). Instead it uses a prompt-engineered protocol: tool definitions are serialized into the
system prompt as plain text, and the model is instructed to emit tool calls as XML tags:

```xml
<tool_call>
  <name>exec</name>
  <arguments>{"command": "ls ~/project"}</arguments>
</tool_call>
```

The model connection regex-parses this out of the response text. This means tool calling
works identically across every auth type (OAuth, API key, CLI) and does not depend on any
provider-specific feature.

The tradeoff: the model can hallucinate tool XML, partial tags can appear in otherwise normal
responses, and the model cannot call multiple tools in a structured parallel way.

---

## How context is built and reused

### Within a single turn (Layer 2 loop)

Each iteration adds messages to a local `messages` array:

```
[...conversationHistory, userMessage]
  + assistantMessage (with tool call XML)
  + toolResult (exec output)
  + assistantMessage (with next tool call)
  + toolResult
  + ...
  + assistantMessage (final text, no tool calls)
```

The entire array is sent on every LLM call. The model always sees the full history of what
it did this turn — its own previous tool calls and their results — so it can reason about
what happened before deciding what to do next.

### Across conversation turns (the chat loop)

`src/cli/chat.ts` maintains a `conversationHistory: Message[]` that persists across user
turns. After each `runAgentLoop` call it replaces `conversationHistory` with
`result.messages`, which is the full message array from that turn (user + all
tool-call/result pairs + final assistant message).

The next user turn starts with:
```
[...all previous turns, newUserMessage]
```

So the model has full memory of everything that happened in prior turns — what the user said,
what tools were called, what they returned, and what was replied.

---

## The context window problem

Every message ever exchanged accumulates in the array that gets sent to the API on every call.
This is the "overgrowing context" problem.

### Why it matters

Claude models have a fixed context window (e.g. 200k tokens for Sonnet). Each API call sends
the *entire* accumulated history. As a session grows:

- **Latency increases** — more tokens to process on every call.
- **Cost increases** — input tokens are billed on every request, so old messages are paid for
  repeatedly.
- **Eventually it fails** — once the history exceeds the context window, the API returns a
  context overflow error and the agent cannot continue.

### What happens in crab-rave today

There is no mitigation. The full `conversationHistory` is sent on every call. A long session
with many tool-heavy turns will eventually hit the context limit and crash with an API error.
Layer 1 will not retry it (context overflow is not a transient error) — the error propagates
to the chat UI as a plain error message.

### What grows fastest

Tool results are the biggest driver. A single `exec` tool call that returns the output of
`find /` or a large log file can add tens of thousands of tokens in one shot. After a few
such calls the context fills up even within a single task.

### How production agents solve this

Production systems (like OpenClaw) handle this with several strategies, roughly in order of
how aggressive they are:

**1. Tool result truncation (pre-send)**
Before each API call, scan tool result messages and trim any that exceed a per-result budget
(e.g. 50% of the context window). A head+tail strategy preserves the beginning and end of the
output since errors often appear at the end. A notice is injected so the model knows content
was removed.

**2. Tool result compaction (replace with placeholder)**
Older tool results that are no longer needed for the current reasoning step are replaced with
`[compacted: removed to free context]`. This is more aggressive than truncation but lets the
session continue far longer.

**3. Context summarization (auto-compaction)**
When the context is nearly full, run a separate LLM call that reads the entire history and
produces a compact prose summary. Replace all prior messages with a single synthetic message
containing that summary. The agent continues from a fresh context with the summary as its
"memory". This is the most powerful technique but requires a second LLM call and can lose
detail.

**4. Sliding window / turn limit**
Drop the oldest N turns when the history exceeds a threshold. Simple and cheap, but the model
loses access to earlier parts of the conversation entirely.

---

## Practical limits with the current crab-rave implementation

With `claude-sonnet-4-6` (200k token context) and typical tool outputs:

| Scenario | Approximate turn budget |
|---|---|
| Pure conversation, no tools | ~400–600 turns |
| Light tool use (short outputs) | ~50–100 turns |
| Heavy tool use (file reads, exec) | ~10–20 turns |
| Single large exec output (logs, find) | Can exhaust context in 1 turn |

The `maxAgentIterations: 20` cap limits how many tool calls can happen per user message, which
provides some protection within a single turn. But it does not help with accumulation across
turns.

---

## Summary of key invariants

- **Messages are append-only.** Nothing is ever removed or edited once added to the history.
- **The full history is sent on every call.** No windowing, summarization, or truncation is
  applied today.
- **Tool results live in the message array as plain strings.** Large outputs accumulate
  directly in context.
- **`conversationHistory` is the single source of truth** for the session. It lives in
  `startChat`'s closure and is replaced wholesale after each turn.
- **Context overflow is fatal.** The current retry logic does not handle overflow — the
  session must be restarted.
