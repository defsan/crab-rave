import { appendFileSync } from "fs";
import type { Message } from "../agent/types.js";

const SEPARATOR = "-".repeat(50);

export function logPrompt(filePath: string, systemPrompt: string, messages: Message[]): void {
  const lines: string[] = [];

  lines.push(`[${new Date().toISOString()}]`);
  lines.push(systemPrompt);
  lines.push("");

  for (const msg of messages) {
    const label = msg.role === "tool" ? `tool(${msg.toolName ?? "unknown"})` : msg.role;
    lines.push(`[${label}]`);
    lines.push(msg.content);
    lines.push("");
  }

  lines.push(SEPARATOR);
  lines.push("");

  appendFileSync(filePath, lines.join("\n"), "utf-8");
}
