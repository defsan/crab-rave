import { useState, useRef, useCallback } from "react";
import { Box, Text, Static, useApp, useInput, render } from "ink";
import TextInput from "ink-text-input";
import type { Message } from "../agent/types.js";
import type { Logger } from "../logging/logger.js";
import type { LoopConfig } from "../config/types.js";
import type { AgentRouter } from "../agent/agent-router.js";
import { runAgentLoop, estimateTokens, isAbortError } from "../agent/agent-loop.js";
import { loadDefaultContextMessages } from "../agent/context-loader.js";
import { offloadToolOutputs } from "../agent/context-compactor.js";
import {
  buildHelp,
  handleCommonCommand,
  autoSaveSession,
  type CommandContext,
} from "../chat/common-commands.js";

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
  iterations: number | null;
  durationMs: number | null;
}

interface ChatProps {
  router: AgentRouter;
  defaultAgentName: string;
  logger: Logger;
  agentConfig: LoopConfig;
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
  if (stats.iterations !== null) parts.push(`${stats.iterations} iter`);
  if (stats.durationMs !== null) {
    const d = stats.durationMs;
    parts.push(d < 60_000 ? `${(d / 1000).toFixed(1)}s` : `${Math.floor(d / 60_000)}m ${Math.round((d % 60_000) / 1000)}s`);
  }
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
  const [stats, setStats] = useState<Stats>({ model: "", tokensPerSecond: null, contextTokens: 0, iterations: null, durationMs: null });

  const historiesRef = useRef(new Map<string, Message[]>());
  const lastActivityRef = useRef(new Map<string, number>());
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
    async (raw: string): Promise<boolean> => {
      if (!raw.startsWith("/")) return false;

      const [cmd, ...argParts] = raw.slice(1).trim().split(/\s+/);
      const arg = argParts.join(" ");
      const cmdLower = cmd.toLowerCase();

      const ctx: CommandContext = {
        channel: "cli",
        activeAgent,
        router,
        getHistory: (agentName) => historiesRef.current.get(agentName) ?? [],
        clearHistory: (agentName?) => {
          if (agentName) historiesRef.current.delete(agentName);
          else historiesRef.current.clear();
        },
        respond: (text, isError) => addMessage({ role: isError ? "error" : "info", text }),
      };

      if (await handleCommonCommand(cmdLower, arg, ctx)) return true;

      // CLI-specific commands
      switch (cmdLower) {
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
          addMessage({ role: "error", text: `Unknown command: /${cmd}\n${buildHelp("cli")}` });
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

      void handleCommand(trimmed).then((handled) => {
        if (handled) return;

      addMessage({ role: "user", text: trimmed });
      setIsThinking(true);
      const abort = new AbortController();
      abortRef.current = abort;
      const startedAt = Date.now();

      router
        .resolve(trimmed, activeAgent)
        .then((resolved) => {
          const lastActivity = lastActivityRef.current.get(resolved.agentDef.name);
          if (lastActivity !== undefined && Date.now() - lastActivity > 60 * 60 * 1000) {
            const expiredHistory = historiesRef.current.get(resolved.agentDef.name);
            if (expiredHistory) autoSaveSession(resolved.agentDef.workfolder, resolved.agentDef.name, expiredHistory);
            historiesRef.current.delete(resolved.agentDef.name);
            addMessage({ role: "info", text: "Session expired — context reset." });
          }
          lastActivityRef.current.set(resolved.agentDef.name, Date.now());

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
            undefined,
            resolved.agentDef.workfolder,
            resolved.agentDef.name,
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
              iterations: result.iterations,
              durationMs: Date.now() - startedAt,
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
      }); // end handleCommand().then()
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
