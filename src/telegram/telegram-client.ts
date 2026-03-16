const BASE = "https://api.telegram.org";
const TELEGRAM_MESSAGE_LIMIT = 4096;

export interface TelegramMessage {
  message_id: number;
  from?: { id: number; username?: string; first_name?: string };
  chat: { id: number };
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

async function call<T>(token: string, method: string, body?: Record<string, unknown>): Promise<T> {
  const url = `${BASE}/bot${token}/${method}`;
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = (await response.json()) as { ok: boolean; result: T; description?: string };
  if (!json.ok) {
    throw new Error(`Telegram API error on ${method}: ${json.description ?? "unknown"}`);
  }
  return json.result;
}

export async function getUpdates(
  token: string,
  offset: number,
  timeoutSecs = 30,
): Promise<TelegramUpdate[]> {
  return call<TelegramUpdate[]>(token, "getUpdates", {
    offset,
    timeout: timeoutSecs,
    allowed_updates: ["message"],
  });
}

export async function sendMessage(token: string, chatId: number, text: string): Promise<void> {
  // Telegram has a 4096-character limit per message — split if needed
  const chunks = splitText(text, TELEGRAM_MESSAGE_LIMIT);
  for (const chunk of chunks) {
    await call(token, "sendMessage", { chat_id: chatId, text: chunk });
  }
}

export async function getMe(
  token: string,
): Promise<{ id: number; username: string; first_name: string }> {
  return call<{ id: number; username: string; first_name: string }>(token, "getMe");
}

export async function sendTyping(token: string, chatId: number): Promise<void> {
  await call(token, "sendChatAction", { chat_id: chatId, action: "typing" });
}

function splitText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    // Prefer splitting at a newline within the limit
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt <= 0) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}
