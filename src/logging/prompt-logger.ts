import { appendFileSync } from "fs";
import type { Message, ToolCall } from "../agent/types.js";

const ROUND_SEPARATOR = "=".repeat(80);

export interface PromptLogPayload {
  systemPrompt: string;
  messages: Message[];
  /** Model id for this call (e.g. from the active connection). */
  modelId: string;
  /** Assistant text when the request succeeds. */
  responseText?: string;
  /** Set when the request fails; logged under ERROR instead of RESPONSE. */
  errorMessage?: string;
  /** Tool calls the model emitted in this response, if any. */
  toolCalls?: ToolCall[];
}

/** Tracks the last logged prompt body per log file path. */
const previousPromptBody = new Map<string, string>();

function formatToolCalls(toolCalls: ToolCall[]): string {
  return toolCalls
    .map((tc) => `[${tc.toolName}]\n${JSON.stringify(tc.arguments, null, 2)}`)
    .join("\n\n");
}

function formatMessages(messages: Message[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const label = msg.role === "tool" ? `tool(${msg.toolName ?? "unknown"})` : msg.role;
    lines.push(`[${label}]`);
    lines.push(msg.content);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/**
 * Appends one LLM round-trip: timestamp, PROMPT (system + messages), then RESPONSE or ERROR.
 * Each record is wrapped in ROUND_SEPARATOR lines.
 *
 * The prompt body is diffed against the previous call: the repeated prefix is replaced
 * with a <PREVIOUS> marker so only new additions are visible in the log.
 */
export function logPromptRoundTrip(filePath: string, payload: PromptLogPayload): void {
  const ts = new Date().toISOString();
  const lines: string[] = [];

  const fullBody = `${payload.systemPrompt}\n\n${formatMessages(payload.messages)}`;
  const prev = previousPromptBody.get(filePath);
  const promptBody = prev && fullBody.includes(prev)
    ? `<PREVIOUS>${fullBody.slice(prev.length)}`
    : fullBody;
  previousPromptBody.set(filePath, fullBody);

  lines.push(ROUND_SEPARATOR);
  lines.push(`[${ts}]  model: ${payload.modelId}`);
  lines.push("");
  lines.push("PROMPT");
  lines.push("");
  lines.push(promptBody);
  lines.push("");
  lines.push(payload.errorMessage !== undefined ? "ERROR" : "RESPONSE");
  lines.push("");
  if (payload.errorMessage !== undefined) {
    lines.push(payload.errorMessage);
  } else {
    lines.push(payload.responseText ?? "");
  }
  if (payload.toolCalls?.length) {
    lines.push("");
    lines.push("TOOL CALLS");
    lines.push("");
    lines.push(formatToolCalls(payload.toolCalls));
  }
  lines.push("");
  lines.push(ROUND_SEPARATOR);
  lines.push("");

  appendFileSync(filePath, lines.join("\n"), "utf-8");
}
