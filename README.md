# crab-rave

A modular multi-agent LLM CLI built in TypeScript. Run AI agents with different models, tools, and communication channels from your terminal.

## Features

- **Multiple model backends** — Anthropic API, Ollama (local), or Claude CLI
- **Multi-agent routing** — define multiple agents, switch between them mid-conversation
- **Built-in tools** — shell execution, filesystem access, web fetch
- **Context management** — automatic LLM summarization when context grows large, tool output offloading to files
- **Telegram integration** — run agents as Telegram bots
- **React Ink TUI** — sticky status bar, static chat history, slash commands

## Installation

```bash
npm install
npm run build
npm link          # makes `crab-rave` available globally
```

For development (no build step):

```bash
npm run dev -- <args>
```

## Configuration

`crab-rave` looks for `crab-rave.config.json` in the current directory. Create one:

```json
{
  "agents": [
    {
      "name": "default",
      "model_name": "claude-sonnet",
      "workfolder": "~/crabs/default",
      "communication": "default"
    }
  ],
  "models": [
    { "name": "claude-sonnet", "type": "claude-api", "model": "claude-sonnet-4-6" }
  ],
  "communications": [
    { "name": "default", "type": "cli" }
  ],
  "logFile": "./crab-rave.log",
  "loop": {
    "maxRetries": 3,
    "maxAgentIterations": 20
  }
}
```

### Model types

| Type | Description | Required fields |
|------|-------------|-----------------|
| `claude-api` | Anthropic REST API | `model`; `key` or env var |
| `claude-cli` | Delegates to the `claude` CLI binary | `model` |
| `ollama` | Local Ollama instance | `model`, `url` |

**`claude-api` auth** — set `key` in config, or use environment variables:
- `ANTHROPIC_API_KEY` — standard API key
- `CLAUDE_CODE_OAUTH_TOKEN` — OAuth token

**Ollama** — point `url` at your running instance (e.g. `http://localhost:11434`). Native tool calling is used when supported; falls back to Qwen3-coder XML format automatically.

### Agent fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Unique agent identifier |
| `model_name` | yes | References a `models[].name` |
| `workfolder` | yes | Working directory; auto-created on startup. Supports `~` expansion |
| `communication` | yes | References a `communications[].name` |
| `alias` | no | Short name for `/agent` switching |
| `default_context` | no | Files (relative to workfolder) loaded to seed fresh conversation context |

### Loop config

| Field | Default | Description |
|-------|---------|-------------|
| `maxRetries` | — | Retry attempts on transient errors (overload, timeout, rate limit) |
| `maxAgentIterations` | — | Maximum tool-use iterations per turn |
| `verbose` | false | Print token/timing info per loop iteration |
| `promptLog` | — | Path to append full prompt logs (human-readable) |

## CLI commands

### Run an agent

```bash
crab-rave <instance-name>
crab-rave <instance-name> --verbose     # print loop stats
crab-rave <instance-name> --verbose2    # also write prompts.log
```

Opens the interactive chat TUI for the named agent (must match an `agents[].name` in config).

### Config management

```bash
# Agents
crab-rave config agents list
crab-rave config agents add <name> --model <model_name> --workfolder <path> --communication <comm>
crab-rave config agents set <name> <key>=<value>   # e.g. alias=fe or model_name=claude-opus
crab-rave config agents remove <name>

# Models
crab-rave config models list
crab-rave config models add <name> --type <type> --model <id> [--url <url>] [--key <key>]
crab-rave config models remove <name>

# Communications
crab-rave config communications list
crab-rave config communications add <name> --type <type> [--key <token>]
crab-rave config communications remove <name>

# System
crab-rave config system show
crab-rave config system set logFile=<path>
```

`config agents set` settable keys: `alias`, `model_name`, `communication`, `workfolder`, `default_context` (JSON array).

## Chat commands

Inside the TUI:

| Command | Description |
|---------|-------------|
| `/help` | List all commands |
| `/agents` | List configured agents |
| `/agent <name>` | Switch active agent |
| `/new` | Reset current agent's conversation context |
| `/clear` | Reset all agents' conversation contexts |
| `/store` | Save current context to `memory/session-YYYY-MM-DD-N.md` in workfolder |
| `/abort` | Abort running agent (also: `Esc`) |
| `/exit` | Exit |

## Tools

Every agent has access to three tools:

### `exec`
Run shell commands. Output is truncated at 4 000 characters; `stderr` is included.

### `fs`
Filesystem operations scoped to the agent's workfolder (plus `/tmp`):
- `list` — directory listing (skips `node_modules`, `.git`, `dist`)
- `read` — line-numbered file contents
- `read-chunk` — read a range of lines
- `write` — create or overwrite a file
- `append` — append to a file
- `get-size` — character count

### `web`
Fetch a URL and return cleaned markdown:
- Strips scripts, styles, nav, footer
- Converts links to `[text](url)` with relative→absolute resolution
- 15 s timeout, 20 000 character output cap

## Context management

Context is managed automatically:

1. **Summarization** — when estimated token count exceeds 10 000, the older portion of the conversation is summarized by the model and replaced with a compact summary. If the summary itself exceeds 5 000 tokens a second compression pass runs.

2. **Tool output offloading** — after each agent turn, tool outputs (except the last two) are written to `{workfolder}/tool_calls/` and replaced with a file reference in the conversation history.

3. **`/store`** — manually snapshot the full current context to a dated markdown file.

## Telegram

Add a `telegram` communication entry with a bot token and optional `chat_ids` allowlist:

```json
{
  "name": "my-bot",
  "type": "telegram",
  "key": "<bot-token>",
  "chat_ids": [123456789]
}
```

Assign this communication to an agent and start the instance — the bot will listen for messages.

## Project structure

```
src/
  agent/          Agent loop, routing, context management
  cli/            Ink TUI (chat.tsx), argument parsing
  commands/       CLI command handlers (instance, config/*)
  config/         Config types, loader, validator, writer
  logging/        JSON logger, prompt logger
  models/         Model connection classes
  tools/          Tool base class, exec/fs/web tools
  telegram/       Telegram bot client
```
