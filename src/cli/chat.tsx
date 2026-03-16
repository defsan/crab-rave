import { useState, useRef, useCallback } from "react";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Box, Text, Static, useApp, useInput, render } from "ink";
import TextInput from "ink-text-input";
import type { Message } from "../agent/types.js";
import type { Logger } from "../logging/logger.js";
import type { LoopConfig } from "../config/types.js";
import type { AgentRouter } from "../agent/agent-router.js";
import { runAgentLoop, estimateTokens, isAbortError } from "../agent/agent-loop.js";
import { loadDefaultContextMessages } from "../agent/context-loader.js";
import { offloadToolOutputs } from "../agent/context-compactor.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface DisplayMessage {
  id: number;
  role: "user" | "assistant" | "error" | "info";
  text: string;
  label?: string;
}

interface Stats {
  model: string;
  tokensPerSecond: number | null;
  contextTokens: number;
}

interface ChatProps {
  router: AgentRouter;
  defaultAgentName: string;
  logger: Logger;
  agentConfig: LoopConfig;
}

// ── Commands ─────────────────────────────────────────────────────────────────

const COMMANDS: Record<string, { usage: string; description: string }> = {
  help:   { usage: "/help",          description: "Show available commands" },
  agents: { usage: "/agents",        description: "List all configured agents" },
  agent:  { usage: "/agent <name>",  description: "Switch active agent" },
  new:    { usage: "/new",           description: "Reset current agent's conversation context" },
  clear:  { usage: "/clear",         description: "Reset all agents' conversation contexts" },
  store:  { usage: "/store",         description: "Save current context to memory/session-<date>-<n>.md" },
  abort:  { usage: "/abort",         description: "Abort the running agent (also: Esc key)" },
  exit:   { usage: "/exit",          description: "Exit the chat" },
};

function buildHelp(): string {
  const lines = ["Available commands:"];
  for (const { usage, description } of Object.values(COMMANDS)) {
    lines.push(`  ${usage.padEnd(20)} ${description}`);
  }
  return lines.join("\n");
}

// ── Session storage helpers ───────────────────────────────────────────────────

function expandWorkfolder(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function resolveSessionPath(workfolder: string): string {
  const dir = path.join(expandWorkfolder(workfolder), "memory");
  mkdirSync(dir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const prefix = `session-${today}-`;

  const existing = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".md"))
    : [];

  const numbers = existing
    .map((f) => parseInt(f.slice(prefix.length, -3), 10))
    .filter((n) => !isNaN(n));

  const next = numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
  return path.join(dir, `${prefix}${next}.md`);
}

function writeSessionFile(filePath: string, agentName: string, messages: Message[]): void {
  const date = new Date().toISOString().replace("T", " ").slice(0, 19);
  const lines: string[] = [
    `# Session — ${agentName}`,
    `_Saved: ${date}_`,
    "",
  ];

  for (const msg of messages) {
    if (msg.role === "user") {
      lines.push(`## You\n\n${msg.content}\n`);
    } else if (msg.role === "assistant") {
      lines.push(`## Assistant\n\n${msg.content}\n`);
    } else if (msg.role === "tool") {
      lines.push(`## Tool: ${msg.toolName ?? "unknown"}\n\n${msg.content}\n`);
    }
  }

  writeFileSync(filePath, lines.join("\n"), "utf-8");
}

// ── Sub-components ───────────────────────────────────────────────────────────

function MessageView({ msg }: { msg: DisplayMessage }) {
  if (msg.role === "info") {
    return (
      <Box>
        <Text dimColor>{msg.text}</Text>
      </Box>
    );
  }

  if (msg.role === "user") {
    return (
      <Box marginTop={1}>
        <Text color="cyan" bold>You: </Text>
        <Text>{msg.text}</Text>
      </Box>
    );
  }

  if (msg.role === "assistant") {
    const heading = msg.label ? `Assistant [${msg.label}]:` : "Assistant:";
    return (
      <Box marginTop={1} flexDirection="column">
        <Text color="green" bold>{heading}</Text>
        <Box marginLeft={2}>
          <Text>{msg.text}</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box marginTop={1}>
      <Text color="red" bold>Error: </Text>
      <Text color="red">{msg.text}</Text>
    </Box>
  );
}

function StatusBarView({
  stats,
  isThinking,
  activeAgent,
}: {
  stats: Stats;
  isThinking: boolean;
  activeAgent: string;
}) {
  const cols = process.stdout.columns ?? 80;

  const parts: string[] = [];
  parts.push(`agent: ${activeAgent}`);
  if (stats.model) parts.push(`model: ${stats.model}`);
  if (stats.tokensPerSecond !== null) parts.push(`${stats.tokensPerSecond} tok/s`);
  if (stats.contextTokens > 0) parts.push(`ctx: ~${stats.contextTokens} tok`);
  if (isThinking) parts.push("thinking...");

  const bar = ` ${parts.join("  ·  ")}`.padEnd(cols).slice(0, cols);

  return (
    <Box>
      <Text backgroundColor="gray" color="white" dimColor>{bar}</Text>
    </Box>
  );
}

// ── Main app ─────────────────────────────────────────────────────────────────

function ChatApp({ router, defaultAgentName, logger, agentConfig }: ChatProps) {
  const { exit } = useApp();

  const [messages, setMessages] = useState<DisplayMessage[]>([
    { id: 1, role: "info", text: "🦀  Crab Rave  —  type /help for available commands" },
  ]);
  const [input, setInput] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [activeAgent, setActiveAgent] = useState(defaultAgentName);
  const [stats, setStats] = useState<Stats>({ model: "", tokensPerSecond: null, contextTokens: 0 });

  const historiesRef = useRef(new Map<string, Message[]>());
  const nextId = useRef(10);
  const abortRef = useRef<AbortController | null>(null);

  useInput((_input, key) => {
    if (key.escape && isThinking) {
      abortRef.current?.abort();
    }
  });

  const addMessage = useCallback((msg: Omit<DisplayMessage, "id">) => {
    setMessages((prev) => [...prev, { ...msg, id: ++nextId.current }]);
  }, []);

  const handleCommand = useCallback(
    (raw: string): boolean => {
      if (!raw.startsWith("/")) return false;

      const [cmd, ...argParts] = raw.slice(1).trim().split(/\s+/);
      const arg = argParts.join(" ");

      switch (cmd.toLowerCase()) {
        case "help":
          addMessage({ role: "info", text: buildHelp() });
          break;

        case "agents": {
          const agents = router.getAgents();
          const lines = ["Configured agents:"];
          for (const a of agents) {
            const alias = a.alias ? `  alias: ${a.alias}` : "";
            const marker = a.name === activeAgent ? " ◀ active" : "";
            lines.push(`  ${a.name.padEnd(16)} model: ${a.model_name}${alias}${marker}`);
          }
          addMessage({ role: "info", text: lines.join("\n") });
          break;
        }

        case "agent": {
          if (!arg) {
            addMessage({ role: "error", text: "Usage: /agent <name>" });
            break;
          }
          const agents = router.getAgents();
          const found = agents.find((a) => a.name === arg || a.alias === arg);
          if (!found) {
            const names = agents.map((a) => a.name).join(", ");
            addMessage({ role: "error", text: `Agent "${arg}" not found. Available: ${names}` });
            break;
          }
          setActiveAgent(found.name);
          router.connectAgent(found.name).catch((err) => {
            addMessage({ role: "error", text: `Failed to connect agent: ${err instanceof Error ? err.message : String(err)}` });
          });
          addMessage({ role: "info", text: `Active agent set to: ${found.name}` });
          break;
        }

        case "new":
          historiesRef.current.delete(activeAgent);
          addMessage({ role: "info", text: `Context reset for agent: ${activeAgent}` });
          break;

        case "clear":
          historiesRef.current.clear();
          addMessage({ role: "info", text: "All agents' conversation contexts cleared." });
          break;

        case "store": {
          const history = historiesRef.current.get(activeAgent) ?? [];
          if (history.length === 0) {
            addMessage({ role: "error", text: "Nothing to store — conversation is empty." });
            break;
          }
          const agentDef = router.getAgents().find((a) => a.name === activeAgent);
          if (!agentDef) {
            addMessage({ role: "error", text: `Agent "${activeAgent}" not found.` });
            break;
          }
          try {
            const filePath = resolveSessionPath(agentDef.workfolder);
            writeSessionFile(filePath, activeAgent, history);
            addMessage({ role: "info", text: `Context saved to ${filePath}` });
          } catch (err) {
            addMessage({ role: "error", text: `Failed to save: ${err instanceof Error ? err.message : String(err)}` });
          }
          break;
        }

        case "abort":
          if (isThinking && abortRef.current) {
            abortRef.current.abort();
          } else {
            addMessage({ role: "info", text: "Nothing to abort." });
          }
          break;

        case "exit":
        case "quit":
          exit();
          setTimeout(() => process.exit(0), 50);
          break;

        default:
          addMessage({ role: "error", text: `Unknown command: /${cmd}\n${buildHelp()}` });
      }

      return true;
    },
    [router, activeAgent, addMessage, exit],
  );

  const handleSubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed || isThinking) return;

      setInput("");

      if (handleCommand(trimmed)) return;

      addMessage({ role: "user", text: trimmed });
      setIsThinking(true);
      const abort = new AbortController();
      abortRef.current = abort;

      router
        .resolve(trimmed, activeAgent)
        .then((resolved) => {
          const existing = historiesRef.current.get(resolved.agentDef.name);
          const history = existing ?? loadDefaultContextMessages(resolved.agentDef);
          return runAgentLoop(
            resolved.message,
            history,
            resolved.connection,
            resolved.toolRegistry,
            logger,
            agentConfig,
            undefined,
            resolved.context,
            abort.signal,
          ).then((result) => {
            const compactedMessages = offloadToolOutputs(
              result.messages,
              resolved.agentDef.workfolder,
            );
            historiesRef.current.set(resolved.agentDef.name, compactedMessages);

            const contextTokens = estimateTokens(
              result.messages.map((m) => m.content).join(""),
            );
            setStats({
              model: resolved.connection.modelId(),
              tokensPerSecond: result.stats.tokensPerSecond,
              contextTokens,
            });

            const label =
              resolved.agentDef.name !== activeAgent ? resolved.agentDef.name : undefined;

            addMessage({ role: "assistant", text: result.response, label });
          });
        })
        .catch((err) => {
          if (isAbortError(err)) {
            addMessage({ role: "info", text: "Aborted." });
            return;
          }
          const msg = err instanceof Error ? err.message : String(err);
          logger.error("Chat error", { error: msg });
          addMessage({ role: "error", text: msg });
        })
        .finally(() => {
          abortRef.current = null;
          setIsThinking(false);
        });
    },
    [isThinking, activeAgent, router, logger, agentConfig, handleCommand, addMessage],
  );

  return (
    <Box flexDirection="column">
      <Static items={messages}>
        {(msg) => <MessageView key={msg.id} msg={msg} />}
      </Static>

      <Box marginTop={1} paddingX={1}>
        {isThinking ? (
          <Text color="cyan" dimColor>⠏ Thinking...</Text>
        ) : (
          <Box>
            <Text color="cyan" bold>{"› "}</Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              placeholder="Type a message or /help..."
            />
          </Box>
        )}
      </Box>

      <StatusBarView stats={stats} isThinking={isThinking} activeAgent={activeAgent} />
    </Box>
  );
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function startChat(
  router: AgentRouter,
  defaultAgentName: string,
  logger: Logger,
  agentConfig: LoopConfig,
): Promise<void> {
  const { waitUntilExit } = render(
    <ChatApp
      router={router}
      defaultAgentName={defaultAgentName}
      logger={logger}
      agentConfig={agentConfig}
    />,
  );
  await waitUntilExit();
}
