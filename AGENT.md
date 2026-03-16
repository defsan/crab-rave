# AGENT.md — crab-rave codebase guide

This file is for AI agents working inside this repository. It describes the architecture, key patterns, and how to extend the system.

## What this project is

`crab-rave` is a TypeScript/Node.js multi-agent LLM framework. It lets you define named agents, each backed by a model (Anthropic API, Ollama, or Claude CLI), a communication channel (CLI or Telegram), and a working directory. Agents have access to tools (exec, fs, web) and maintain conversation history across turns.

The CLI entry point is `src/index.ts`. The main interactive mode is `crab-rave <instance>`, which launches a React Ink TUI.

## Repository layout

```
src/
  index.ts                   CLI entry point, routes to commands
  agent/
    agent-loop.ts            Three-layer loop: retry → tool loop → single LLM call
    agent-router.ts          Resolves messages to agent+connection+tools
    context-compactor.ts     LLM summarization + tool output file offloading
    context-loader.ts        Loads default_context files to seed fresh histories
    message-builder.ts       Builds the system prompt from tool descriptions
    types.ts                 Core types: Message, LLMResponse, AgentResult, PromptStats
  cli/
    chat.tsx                 React Ink TUI — full chat interface
    parse-args.ts            Minimal argv parser
  commands/
    instance.ts              `crab-rave <name>` — start agent, init workfolder
    help.ts                  `crab-rave help`
    config/
      index.ts               Config command dispatcher
      agents.ts              agents list/add/set/remove
      models.ts              models list/add/remove
      communications.ts      communications list/add/remove
      system.ts              system show/set
  config/
    types.ts                 TypeScript interfaces for config schema
    loader.ts                Reads and parses crab-rave.config.json
    validator.ts             Validates config shape at load time
    writer.ts                Writes updated config back to disk
  logging/
    logger.ts                JSON-lines logger (debug/info/error)
    prompt-logger.ts         Appends full prompts to a log file (--verbose2)
  models/
    base-model-connection.ts Abstract base: connect/prompt/status/modelId/setToolRegistry
    anthropic-direct-model-connection.ts  Anthropic REST API
    claude-token-model-connection.ts      Delegates to `claude` CLI binary
    ollama-model-connection.ts            Ollama /api/chat
    model-selector-service.ts            Factory: ModelDef → BaseModelConnection
  tools/
    base-tool.ts             Abstract BaseTool; ToolSchema (OpenAI JSON Schema)
    tool-registry.ts         Holds tools, builds system prompt snippet, toOllamaTools()
    exec-tool.ts             Shell execution
    fs-tool.ts               Filesystem (list/read/write/append/read-chunk/get-size)
    web-tool.ts              HTTP fetch → cleaned markdown
  telegram/
    telegram-client.ts       Telegram bot polling
    telegram-chat.ts         Wraps agent loop for Telegram
```

## Core data flow

```
User input
  └─ AgentRouter.resolve(message, agentName)
       ├─ connects model if needed
       ├─ builds ToolRegistry (exec + fs + web)
       └─ returns { agentDef, connection, toolRegistry, message, context }
           └─ runAgentLoop(message, history, connection, toolRegistry, ...)
                └─ runAgentTurn (tool loop, up to maxAgentIterations)
                     └─ runSingleAttempt
                          ├─ compactContext (if >10k tokens)
                          ├─ buildSystemPrompt
                          └─ connection.prompt(messages, systemPrompt, signal)
```

After the loop, `offloadToolOutputs` writes older tool results to files to keep history small.

## Key types (`src/agent/types.ts`)

```typescript
interface Message {
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;   // set when role === "tool"
}

interface LLMResponse {
  text: string;
  toolCalls: ToolCall[];
  raw: string;
}

interface ToolCall {
  toolName: string;
  arguments: Record<string, unknown>;
}
```

## How to add a new tool

1. Create `src/tools/my-tool.ts`:

```typescript
import { BaseTool, type ToolSchema } from "./base-tool.js";

export class MyTool extends BaseTool {
  name = "my_tool";
  description = "Does something useful";

  toolSchema(): ToolSchema {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: "object",
          properties: {
            param1: { type: "string", description: "..." },
          },
          required: ["param1"],
        },
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const param1 = args.param1 as string;
    // ... do work
    return result;
  }
}
```

2. Register it in `src/agent/agent-router.ts` alongside ExecTool, FsTool, WebTool:

```typescript
registry.register(new MyTool(agentDef.workfolder));
```

The tool is automatically included in the system prompt and (for Ollama) the native `tools` array.

## How to add a new model backend

1. Create `src/models/my-model-connection.ts` extending `BaseModelConnection`:
   - Implement `connect()`, `prompt()`, `status()`, `modelId()`
   - Override `setToolRegistry()` if your API supports native tool calling
   - Pass `signal` to `fetch()` for abort support

2. Add the new type to `ModelDef` in `src/config/types.ts`.

3. Add a branch in `src/models/model-selector-service.ts`.

4. Update the type validation in `src/config/validator.ts`.

## How to add a new CLI command

Commands live in `src/commands/`. The dispatcher is `src/index.ts`.

For a top-level command `crab-rave foo`:
1. Create `src/commands/foo.ts` exporting `async function runFoo(args: string[]): Promise<void>`
2. Add a branch in `src/index.ts`

For a config sub-command:
1. Add the handler in the appropriate `src/commands/config/*.ts` file
2. Register it in `src/commands/config/index.ts`

## How to add a chat slash command

All slash commands are handled in `handleCommand()` in `src/cli/chat.tsx`. Add a `case` to the switch:

```typescript
case "mycommand": {
  // use addMessage(), router, historiesRef, etc.
  break;
}
```

Register its description in the `COMMANDS` record at the top of the file.

## Config schema (`crab-rave.config.json`)

Validated at startup by `src/config/validator.ts`. All fields:

```typescript
interface CrabRaveConfig {
  agents: AgentDef[];
  models: ModelDef[];
  communications: CommunicationDef[];
  logFile: string;
  loop: {
    maxRetries: number;
    maxAgentIterations: number;
    verbose?: boolean;
    promptLog?: string;
  };
}
```

`AgentDef.workfolder` supports `~` expansion. The folder is auto-created on startup; failure throws.

## Context compaction

`src/agent/context-compactor.ts` manages two strategies:

- **`compactContext()`** — called before every LLM request. If total estimated tokens > 10 000, the older messages are summarized by the model and replaced in-place with a summary pair. If the summary itself is > 5 000 tokens, a second compression pass runs.
- **`offloadToolOutputs()`** — called after each agent turn in `chat.tsx`. Tool messages (except the last 2) are written to `{workfolder}/tool_calls/<timestamp>-<tool>-<n>.log` and replaced with file references.

Token estimation is `Math.ceil(text.length / 4)` — a fast approximation.

## Abort / cancellation

`AbortController` is created per user turn in `chat.tsx`. The signal is passed through the entire call chain to all `fetch()` calls and checked at loop iteration boundaries with `signal?.throwIfAborted()`. The Escape key and `/abort` command call `abortRef.current?.abort()`.

`isAbortError()` in `agent-loop.ts` detects both `AbortError` name and the node fetch message; abort errors skip the retry logic.

## Conventions

- ESM throughout — all imports use `.js` extensions even for `.ts` source files
- No default exports — named exports only
- Model names are used verbatim in API calls — no alias mapping
- `workfolder` paths: always expand `~` with `os.homedir()` before use
- Logging: use the injected `Logger` instance, not `console.log` (except verbose loop stats which intentionally use chalk+console)
- Tool output size: tools should cap output and return human-readable truncation notices
- New tools must implement `toolSchema()` returning a valid OpenAI-compatible JSON Schema function descriptor
