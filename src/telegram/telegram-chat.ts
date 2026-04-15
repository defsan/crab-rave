import type { Message } from "../agent/types.js";
import type { Logger } from "../logging/logger.js";
import type { LoopConfig } from "../config/types.js";
import type { AgentRouter } from "../agent/agent-router.js";
import { runAgentLoop } from "../agent/agent-loop.js";
import { getUpdates, sendMessage, startTypingIndicator, fetchPhotoAsBase64 } from "./telegram-client.js";
import type { TelegramMessage } from "./telegram-client.js";
import { buildHelp, handleCommonCommand, autoSaveSession, type CommandContext } from "../chat/common-commands.js";

// Per-agent conversation history per Telegram chat ID: Map<chatId, Map<agentName, messages>>
const chatHistories = new Map<number, Map<string, Message[]>>();

// Per-chat loop config overrides (survive until the process restarts)
const chatLoopOverrides = new Map<number, Partial<LoopConfig>>();

// Last activity timestamp per chat+agent for session auto-reset
const chatLastActivity = new Map<number, Map<string, number>>();

const SESSION_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function getHistory(chatId: number, agentName: string): Message[] {
  if (!chatHistories.has(chatId)) chatHistories.set(chatId, new Map());
  const agentMap = chatHistories.get(chatId)!;
  if (!agentMap.has(agentName)) agentMap.set(agentName, []);
  return agentMap.get(agentName)!;
}

const SUPER_ITERATIONS = 200;

/**
 * Handles Telegram slash commands.
 * Returns true if the message was a command and was handled (caller should skip agent routing).
 */
async function handleCommand(
  chatId: number,
  text: string,
  token: string,
  router: AgentRouter,
  defaultAgentName: string,
  logger: Logger,
): Promise<boolean> {
  if (!text.startsWith("/")) return false;

  // Strip bot username suffix Telegram appends in group chats: /cmd@botname
  const rawCommand = text.split("@")[0].split(" ")[0].toLowerCase();
  const command = rawCommand.slice(1); // strip leading /

  logger.info("Telegram: command received", { chatId, command });

  const ctx: CommandContext = {
    channel: "telegram",
    activeAgent: defaultAgentName,
    router,
    getHistory: (agentName) => chatHistories.get(chatId)?.get(agentName) ?? [],
    clearHistory: (agentName?) => {
      const agentMap = chatHistories.get(chatId);
      if (!agentMap) return;
      if (agentName) agentMap.delete(agentName);
      else agentMap.clear();
    },
    respond: (msg) => sendMessage(token, chatId, msg),
  };

  if (await handleCommonCommand(command, "", ctx)) return true;

  // Telegram-specific commands
  switch (command) {
    case "super":
      chatLoopOverrides.set(chatId, { maxAgentIterations: SUPER_ITERATIONS });
      await sendMessage(token, chatId, `Super mode on — max tool iterations raised to ${SUPER_ITERATIONS} for this session.`);
      break;

    default:
      await sendMessage(token, chatId, `Unknown command: /${command}\n\n${buildHelp("telegram")}`);
  }

  return true;
}

async function handleMessage(
  chatId: number,
  msg: TelegramMessage,
  token: string,
  router: AgentRouter,
  defaultAgentName: string,
  logger: Logger,
  loopConfig: LoopConfig,
): Promise<void> {
  const text = msg.text ?? msg.caption ?? "";
  logger.info("Telegram: incoming message", { chatId, textLength: text.length, hasPhoto: !!msg.photo });

  if (await handleCommand(chatId, text, token, router, defaultAgentName, logger)) return;

  const startedAt = Date.now();
  const stopTyping = startTypingIndicator(token, chatId);
  try {
    // Download photo if present (before routing, so it's ready to attach)
    let images: string[] | undefined;
    if (msg.photo) {
      const b64 = await fetchPhotoAsBase64(token, msg);
      if (b64) images = [b64];
    }

    const resolved = await router.resolve(text || "Please analyze this image.", defaultAgentName);

    // Auto-reset session if idle for more than SESSION_TIMEOUT_MS
    const agentLastActivity = chatLastActivity.get(chatId)?.get(resolved.agentDef.name);
    if (agentLastActivity !== undefined && Date.now() - agentLastActivity > SESSION_TIMEOUT_MS) {
      const expiredHistory = chatHistories.get(chatId)?.get(resolved.agentDef.name);
      if (expiredHistory) autoSaveSession(resolved.agentDef.workfolder, resolved.agentDef.name, expiredHistory);
      chatHistories.get(chatId)?.delete(resolved.agentDef.name);
      await sendMessage(token, chatId, "_Session expired — context reset._");
    }
    if (!chatLastActivity.has(chatId)) chatLastActivity.set(chatId, new Map());
    chatLastActivity.get(chatId)!.set(resolved.agentDef.name, Date.now());

    const history = getHistory(chatId, resolved.agentDef.name);

    const effectiveConfig = { ...loopConfig, ...chatLoopOverrides.get(chatId) };
    const result = await runAgentLoop(
      resolved.message,
      history,
      resolved.connection,
      resolved.toolRegistry,
      logger,
      effectiveConfig,
      undefined,
      resolved.context,
      undefined,
      images,
      resolved.agentDef.workfolder,
      resolved.agentDef.name,
    );

    stopTyping();
    chatHistories.get(chatId)!.set(resolved.agentDef.name, result.messages);
    const tot = (result.totalInputTokens / 1000).toFixed(1);
    const las = (result.stats.inputTokens / 1000).toFixed(1);
    const footer = `_tot ~${tot}k · las ${las}k · ${result.iterations} iter · ${formatDuration(Date.now() - startedAt)}_`;
    await sendMessage(token, chatId, `${result.response}\n\n${footer}`);

    if (result.exhausted) {
      await sendMessage(
        token,
        chatId,
        `[Stopped early: reached the limit of ${loopConfig.maxAgentIterations} tool iterations]`,
      );
    }

    logger.info("Telegram: response sent", {
      chatId,
      agent: resolved.agentDef.name,
      responseLength: result.response.length,
      exhausted: result.exhausted ?? false,
    });
  } catch (err) {
    stopTyping();
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Telegram: agent error", { chatId, error: msg });
    await sendMessage(token, chatId, `Error: ${msg}`);
  }
}

export async function startTelegramChat(
  token: string,
  allowedChatIds: number[] | undefined,
  router: AgentRouter,
  defaultAgentName: string,
  logger: Logger,
  loopConfig: LoopConfig,
): Promise<void> {
  let claimedChatId: number | null = null;

  const isAllowed = (chatId: number): boolean => {
    if (allowedChatIds && allowedChatIds.length > 0) {
      return allowedChatIds.includes(chatId);
    }
    if (claimedChatId === null) {
      claimedChatId = chatId;
      logger.info("Telegram: chat ID claimed", { chatId });
      console.log(`Telegram: chat ID ${chatId} has claimed this bot for the session.`);
      console.log(`Add "chat_ids": [${chatId}] to your config to make this permanent.`);
    }
    return chatId === claimedChatId;
  };

  if (allowedChatIds && allowedChatIds.length > 0) {
    logger.info("Telegram: starting in allowlist mode", { allowedChatIds });
    console.log(`Telegram bot started. Accepting messages from chat IDs: ${allowedChatIds.join(", ")}`);
  } else {
    logger.info("Telegram: starting in claim mode — waiting for first message");
    console.log("Telegram bot started. Waiting for first message to claim the bot...");
  }

  let offset = 0;

  while (true) {
    let updates;
    try {
      updates = await getUpdates(token, offset);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Telegram: getUpdates failed", { error: msg });
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }

    for (const update of updates) {
      offset = update.update_id + 1;

      const msg = update.message;
      if (!msg) continue;
      if (!msg.text && !msg.photo) continue;

      const chatId = msg.chat.id;

      if (!isAllowed(chatId)) {
        logger.info("Telegram: ignoring message from non-allowed chat", { chatId });
        continue;
      }

      void handleMessage(chatId, msg, token, router, defaultAgentName, logger, loopConfig);
    }
  }
}
