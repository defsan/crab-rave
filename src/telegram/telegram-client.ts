import { mdToTelegramHtml } from "./telegram-formatter.js";

const BASE = "https://api.telegram.org";

function wrapFetchError(err: unknown, context: string): Error {
  const cause = (err as { cause?: unknown }).cause;
  const detail = cause instanceof Error ? cause.message : (err instanceof Error ? err.message : String(err));
  return new Error(`${context}: ${detail}`);
}
const TELEGRAM_MESSAGE_LIMIT = 4096;

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: { id: number; username?: string; first_name?: string };
  chat: { id: number };
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

async function call<T>(token: string, method: string, body?: Record<string, unknown>): Promise<T> {
  const url = `${BASE}/bot${token}/${method}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw wrapFetchError(err, `Telegram ${method}`);
  }

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
  // Split on raw markdown first so chunk boundaries fall on natural line breaks,
  // then convert each chunk to Telegram HTML independently.
  const chunks = splitText(text, TELEGRAM_MESSAGE_LIMIT);
  for (const chunk of chunks) {
    await call(token, "sendMessage", {
      chat_id: chatId,
      text: mdToTelegramHtml(chunk),
      parse_mode: "HTML",
    });
  }
}

export async function getMe(
  token: string,
): Promise<{ id: number; username: string; first_name: string }> {
  return call<{ id: number; username: string; first_name: string }>(token, "getMe");
}

/**
 * Downloads the highest-resolution photo from a Telegram message and returns
 * it as a raw base64 string (no data-URI prefix — Ollama expects bare base64).
 * Returns undefined if the message has no photo.
 */
export async function fetchPhotoAsBase64(
  token: string,
  msg: TelegramMessage,
): Promise<string | undefined> {
  if (!msg.photo?.length) return undefined;

  // Telegram sends photos as an array of sizes; last entry is the largest.
  const largest = msg.photo[msg.photo.length - 1];
  const file = await call<{ file_path: string }>(token, "getFile", { file_id: largest.file_id });

  const url = `${BASE}/file/bot${token}/${file.file_path}`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw wrapFetchError(err, `Telegram file download (${file.file_path})`);
  }
  if (!response.ok) throw new Error(`Failed to download Telegram photo (${file.file_path}): HTTP ${response.status}`);

  const buffer = await response.arrayBuffer();
  return Buffer.from(buffer).toString("base64");
}

export async function sendTyping(token: string, chatId: number): Promise<void> {
  await call(token, "sendChatAction", { chat_id: chatId, action: "typing" });
}

/**
 * Sends a typing indicator immediately, then repeats every 4 seconds.
 * Returns a cancel function — call it once the work is done.
 */
export function startTypingIndicator(token: string, chatId: number): () => void {
  void sendTyping(token, chatId).catch(() => {});
  const interval = setInterval(() => void sendTyping(token, chatId).catch(() => {}), 4_000);
  return () => clearInterval(interval);
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
