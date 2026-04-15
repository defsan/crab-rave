import type { Message, LLMResponse, AgentResult, PromptStats } from "./types.js";
import type { BaseModelConnection } from "../models/base-model-connection.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { Logger } from "../logging/logger.js";
import type { LoopConfig as AgentConfig } from "../config/types.js";
import { buildSystemPrompt } from "./message-builder.js";
import { logPromptRoundTrip } from "../logging/prompt-logger.js";
import { compactContext } from "./context-compactor.js";
import chalk from "chalk";

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const TRANSIENT_ERROR_PATTERNS = [
  /overloaded/i,
  /timeout/i,
  /rate.?limit/i,
  /5\d\d/,
  /ECONNRESET/,
  /ETIMEDOUT/,
];

function isTransientError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return TRANSIENT_ERROR_PATTERNS.some((p) => p.test(msg));
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message === "This operation was aborted");
}

interface TimedLLMResponse extends LLMResponse {
  stats: PromptStats;
}

/** Layer 3 — Single LLM call */
async function runSingleAttempt(
  messages: Message[],
  modelConnection: BaseModelConnection,
  toolRegistry: ToolRegistry,
  logger: Logger,
  config: AgentConfig,
  signal?: AbortSignal,
  customSystemPrompt?: string,
  agentContext?: string,
  workfolder?: string,
  agentName?: string,
): Promise<TimedLLMResponse> {
  signal?.throwIfAborted();

  const systemPrompt = buildSystemPrompt(toolRegistry, customSystemPrompt, agentContext);

  await compactContext(messages, modelConnection, logger, signal, estimateTokens(systemPrompt), workfolder, agentName);

  modelConnection.setToolRegistry(toolRegistry);

  const inputTokens = estimateTokens(
    systemPrompt + messages.map((m) => m.content).join(""),
  );

  logger.debug("Layer 3: running single attempt", { messageCount: messages.length });

  const t0 = Date.now();
  let response: LLMResponse;
  try {
    response = await modelConnection.prompt(messages, systemPrompt, signal);
  } catch (err) {
    if (config.promptLog) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logPromptRoundTrip(config.promptLog, {
        systemPrompt,
        messages,
        modelId: modelConnection.modelId(),
        errorMessage,
        toolCalls: [],
      });
    }
    throw err;
  }
  const durationMs = Date.now() - t0;

  if (config.promptLog) {
    logPromptRoundTrip(config.promptLog, {
      systemPrompt,
      messages,
      modelId: modelConnection.modelId(),
      responseText: response.text,
      toolCalls: response.toolCalls,
    });
  }

  const outputTokens = estimateTokens(response.text);
  const tokensPerSecond = durationMs > 0 ? Math.round((outputTokens / durationMs) * 1000) : 0;

  logger.info("Layer 3: attempt complete", {
    textLength: response.text.length,
    toolCalls: response.toolCalls.length,
    durationMs,
    tokensPerSecond,
  });

  return {
    ...response,
    stats: { inputTokens, outputTokens, durationMs, tokensPerSecond },
  };
}

/** Layer 2 — Tool loop */
async function runAgentTurn(
  messages: Message[],
  modelConnection: BaseModelConnection,
  toolRegistry: ToolRegistry,
  logger: Logger,
  config: AgentConfig,
  signal?: AbortSignal,
  customSystemPrompt?: string,
  agentContext?: string,
  workfolder?: string,
  agentName?: string,
): Promise<{ text: string; stats: PromptStats; totalInputTokens: number; iterations: number; exhausted?: boolean }> {
  let iterations = 0;
  let lastStats: PromptStats = { inputTokens: 0, outputTokens: 0, durationMs: 0, tokensPerSecond: 0 };
  let totalInputTokens = 0;

  while (iterations < config.maxAgentIterations) {
    signal?.throwIfAborted();
    iterations++;
    logger.info("Layer 2: iteration", { iteration: iterations });

    const response = await runSingleAttempt(
      messages,
      modelConnection,
      toolRegistry,
      logger,
      config,
      signal,
      customSystemPrompt,
      agentContext,
      workfolder,
      agentName,
    );
    lastStats = response.stats;
    totalInputTokens += response.stats.inputTokens;

    if (config.verbose) {
      console.log(
        chalk.dim(`[Loop ${iterations}]`) +
          chalk.cyan(` input: ~${response.stats.inputTokens} tok`) +
          chalk.dim(" |") +
          chalk.green(` output: ~${response.stats.outputTokens} tok`) +
          chalk.dim(" |") +
          chalk.yellow(` ${response.stats.tokensPerSecond} tok/s`) +
          chalk.dim(` | model: ${modelConnection.modelId()}`),
      );
    }

    if (response.toolCalls.length === 0) {
      return { text: response.text, stats: lastStats, totalInputTokens, iterations };
    }

    // Append assistant message (with tool calls still in text)
    messages.push({ role: "assistant", content: response.text });

    // Execute each tool call
    for (const toolCall of response.toolCalls) {
      logger.info("Layer 2: executing tool", {
        tool: toolCall.toolName,
        args: toolCall.arguments,
      });

      const tool = toolRegistry.getByName(toolCall.toolName);
      if (!tool) {
        const result = `Error: unknown tool "${toolCall.toolName}"`;
        messages.push({ role: "tool", content: result, toolName: toolCall.toolName });
        logger.error("Layer 2: unknown tool", { tool: toolCall.toolName });
        continue;
      }

      try {
        const result = await tool.execute(toolCall.arguments);
        messages.push({ role: "tool", content: result, toolName: toolCall.toolName });
        logger.info("Layer 2: tool result", {
          tool: toolCall.toolName,
          resultLength: result.length,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        messages.push({
          role: "tool",
          content: `Error executing tool: ${errorMsg}`,
          toolName: toolCall.toolName,
        });
        logger.error("Layer 2: tool execution error", {
          tool: toolCall.toolName,
          error: errorMsg,
        });
      }
    }
  }

  logger.error("Layer 2: max iterations reached", { maxIterations: config.maxAgentIterations });
  return {
    text: "I've reached the maximum number of tool iterations. Here's what I have so far based on my work above.",
    stats: lastStats,
    totalInputTokens,
    iterations,
    exhausted: true,
  };
}

/** Layer 1 — Retry wrapper */
export async function runAgentLoop(
  userMessage: string,
  conversationHistory: Message[],
  modelConnection: BaseModelConnection,
  toolRegistry: ToolRegistry,
  logger: Logger,
  config: AgentConfig,
  customSystemPrompt?: string,
  agentContext?: string,
  signal?: AbortSignal,
  images?: string[],
  workfolder?: string,
  agentName?: string,
): Promise<AgentResult> {
  const userMsg: Message = { role: "user", content: userMessage };
  if (images?.length) userMsg.images = images;
  const messages = [...conversationHistory, userMsg];

  let lastError: unknown;

  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    try {
      logger.info("Layer 1: attempt", { attempt, maxRetries: config.maxRetries });

      const { text, stats, totalInputTokens, iterations, exhausted } = await runAgentTurn(
        messages,
        modelConnection,
        toolRegistry,
        logger,
        config,
        signal,
        customSystemPrompt,
        agentContext,
        workfolder,
        agentName,
      );

      messages.push({ role: "assistant", content: text });

      return { response: text, messages, stats, totalInputTokens, iterations, exhausted };
    } catch (err) {
      lastError = err;
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error("Layer 1: attempt failed", { attempt, error: errorMsg });

      if (isAbortError(err) || !isTransientError(err)) {
        throw err;
      }

      if (attempt < config.maxRetries) {
        const delay = 2500 * attempt;
        logger.info("Layer 1: retrying after transient error", { delay });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError ?? new Error("Agent loop failed after all retries");
  // unreachable — satisfies TypeScript's return type
  return { response: "", messages, stats: { inputTokens: 0, outputTokens: 0, durationMs: 0, tokensPerSecond: 0 }, totalInputTokens: 0, iterations: 0 };
}
