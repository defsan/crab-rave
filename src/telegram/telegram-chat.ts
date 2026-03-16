import type { Message } from "../agent/types.js";
import type { Logger } from "../logging/logger.js";
import type { LoopConfig } from "../config/types.js";
import type { AgentRouter } from "../agent/agent-router.js";
import { runAgentLoop } from "../agent/agent-loop.js";
import { getUpdates, sendMessage, sendTyping } from "./telegram-client.js";

// Per-agent conversation history per Telegram chat ID: Map<chatId, Map<agentName, messages>>
const chatHistories = new Map<number, Map<string, Message[]>>();

function getHistory(chatId: number, agentName: string): Message[] {
  if (!chatHistories.has(chatId)) chatHistories.set(chatId, new Map());
  const agentMap = chatHistories.get(chatId)!;
  if (!agentMap.has(agentName)) agentMap.set(agentName, []);
  return agentMap.get(agentName)!;
}

async function handleMessage(
  chatId: number,
  text: string,
  token: string,
  router: AgentRouter,
  defaultAgentName: string,
  logger: Logger,
  loopConfig: LoopConfig,
): Promise<void> {
  logger.info("Telegram: incoming message", { chatId, textLength: text.length });

  try {
    await sendTyping(token, chatId);

    const resolved = await router.resolve(text, defaultAgentName);
    const history = getHistory(chatId, resolved.agentDef.name);

    const result = await runAgentLoop(
      resolved.message,
      history,
      resolved.connection,
      resolved.toolRegistry,
      logger,
      loopConfig,
      undefined,
      resolved.context,
    );

    chatHistories.get(chatId)!.set(resolved.agentDef.name, result.messages);
    await sendMessage(token, chatId, result.response);

    logger.info("Telegram: response sent", {
      chatId,
      agent: resolved.agentDef.name,
      responseLength: result.response.length,
    });
  } catch (err) {
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
      if (!msg?.text) continue;

      const chatId = msg.chat.id;

      if (!isAllowed(chatId)) {
        logger.info("Telegram: ignoring message from non-allowed chat", { chatId });
        continue;
      }

      void handleMessage(chatId, msg.text, token, router, defaultAgentName, logger, loopConfig);
    }
  }
}
