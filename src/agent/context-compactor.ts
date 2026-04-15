import { writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Message } from "./types.js";
import type { BaseModelConnection } from "../models/base-model-connection.js";
import type { Logger } from "../logging/logger.js";
import { estimateTokens } from "./agent-loop.js";
import { autoSaveSession } from "../chat/common-commands.js";

const COMPACTION_THRESHOLD = 10_000; // tokens — triggers summarization
const RECOMPRESS_THRESHOLD = 5_000;  // tokens — summary itself is too large
const KEEP_RECENT = 6;               // messages always preserved verbatim

function expandPath(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function messagesToText(messages: Message[]): string {
  return messages
    .map((m) => {
      const label = m.role === "tool" ? `tool(${m.toolName ?? "unknown"})` : m.role;
      return `[${label}]\n${m.content}`;
    })
    .join("\n\n");
}

/**
 * Compacts the messages array IN-PLACE if total tokens exceed the threshold.
 * Preserves the last KEEP_RECENT messages verbatim; summarizes the rest via the model.
 * If the resulting summary is still too large, runs a second focused compression pass.
 *
 * @param systemPromptTokens - estimated token count of the system prompt, so the threshold
 *   check matches the actual context size sent to the model (messages + system prompt).
 */
export async function compactContext(
  messages: Message[],
  modelConnection: BaseModelConnection,
  logger: Logger,
  signal?: AbortSignal,
  systemPromptTokens = 0,
  workfolder?: string,
  agentName?: string,
): Promise<void> {
  if (messages.length <= KEEP_RECENT) return;

  const messageTokens = estimateTokens(messages.map((m) => m.content).join(""));
  const totalTokens = messageTokens + systemPromptTokens;
  if (totalTokens <= COMPACTION_THRESHOLD) return;

  logger.info("Context compaction triggered", { totalTokens, messageTokens, systemPromptTokens, messageCount: messages.length });

  const toSummarize = messages.slice(0, messages.length - KEEP_RECENT);

  // Persist full conversation before it gets compressed
  if (workfolder && agentName) autoSaveSession(workfolder, agentName, messages);

  // First pass — general summary
  const summaryResponse = await modelConnection.prompt(
    [
      {
        role: "user",
        content:
          "Summarize this conversation history. Preserve all key decisions, findings, goals, code details, and technical context:\n\n" +
          messagesToText(toSummarize),
      },
    ],
    "You are a conversation summarizer. Create a dense, accurate summary that preserves all important information needed to continue the conversation.",
    signal,
  );

  let summary = summaryResponse.text;

  // Second pass — if summary is still too large, focus on current topic
  if (estimateTokens(summary) > RECOMPRESS_THRESHOLD) {
    logger.info("Summary too large, running focused recompression", {
      summaryTokens: estimateTokens(summary),
    });

    const focusResponse = await modelConnection.prompt(
      [
        {
          role: "user",
          content:
            "This context summary is still too long. Compress it further, keeping only what is directly relevant to the current task being worked on:\n\n" +
            summary,
        },
      ],
      "You are compressing a context summary. Be extremely concise. Eliminate anything not directly relevant to the ongoing task.",
      signal,
    );

    summary = focusResponse.text;
  }

  const replacement: Message[] = [
    {
      role: "user",
      content: `[Context summary — older conversation compressed]\n\n${summary}`,
    },
    { role: "assistant", content: "Understood, I have the context summary." },
  ];

  // Mutate in-place so the caller's reference reflects the change
  messages.splice(0, toSummarize.length, ...replacement);

  logger.info("Context compaction complete", {
    removedMessages: toSummarize.length,
    newCount: messages.length,
    summaryTokens: estimateTokens(summary),
  });
}

/**
 * Writes tool output messages (except the last 2) to {workfolder}/tool_calls/ files
 * and replaces their content with a file reference.
 * Returns a new messages array — does not mutate the input.
 */
export function offloadToolOutputs(messages: Message[], workfolder: string): Message[] {
  const toolIndices = messages.reduce<number[]>((acc, m, i) => {
    if (m.role === "tool") acc.push(i);
    return acc;
  }, []);

  // Always keep the last 2 tool messages verbatim
  const toOffload = toolIndices.slice(0, -2);
  if (toOffload.length === 0) return messages;

  const dir = path.join(expandPath(workfolder), "tool_calls");
  mkdirSync(dir, { recursive: true });

  const updated = [...messages];
  const ts = Date.now();

  for (let n = 0; n < toOffload.length; n++) {
    const idx = toOffload[n];
    const msg = updated[idx];
    const safeName = (msg.toolName ?? "unknown").replace(/[^a-z0-9_-]/gi, "_");
    const filename = `${ts}-${safeName}-${n}.log`;

    writeFileSync(path.join(dir, filename), msg.content, "utf-8");

    updated[idx] = {
      ...msg,
      content: `[Tool output written to tool_calls/${filename}]`,
    };
  }

  return updated;
}
