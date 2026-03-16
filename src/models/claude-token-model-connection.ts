import { execSync, spawnSync } from "node:child_process";
import { BaseModelConnection, type ConnectionStatus } from "./base-model-connection.js";
import type { Message, LLMResponse, ToolCall } from "../agent/types.js";
import type { Logger } from "../logging/logger.js";

const TOOL_CALL_REGEX =
  /<tool_call>\s*<name>(.*?)<\/name>\s*<arguments>([\s\S]*?)<\/arguments>\s*<\/tool_call>/g;

export class ClaudeTokenModelConnection extends BaseModelConnection {
  private connectionStatus: ConnectionStatus = "disconnected";

  constructor(
    private model: string,
    private logger: Logger,
  ) {
    super();
  }

  async connect(): Promise<void> {
    try {
      execSync("which claude", { stdio: "pipe" });
      this.connectionStatus = "connected";
      this.logger.info("Claude CLI connection established", { model: this.model });
    } catch {
      this.connectionStatus = "error";
      throw new Error("claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code");
    }
  }

  modelId(): string { return this.model || "claude-cli"; }

  status(): ConnectionStatus {
    return this.connectionStatus;
  }

  async test(): Promise<boolean> {
    try {
      const result = spawnSync("claude", ["-p", "ping", "--output-format", "json"], {
        encoding: "utf-8",
        timeout: 30_000,
      });
      if (result.status !== 0) return false;
      JSON.parse(result.stdout);
      return true;
    } catch {
      return false;
    }
  }

  async prompt(messages: Message[], systemPrompt: string, signal?: AbortSignal): Promise<LLMResponse> {
    signal?.throwIfAborted();
    const serialized = this.serializeMessages(messages);

    this.logger.debug("Sending prompt to Claude CLI", {
      model: this.model,
      messageCount: messages.length,
      promptLength: serialized.length,
    });

    const args = ["-p", "--output-format", "json", "--verbose"];
    if (this.model) {
      args.push("--model", this.model);
    }
    args.push("--system-prompt", systemPrompt);

    this.logger.debug("Spawning claude CLI", { args: args.filter((a) => a !== systemPrompt) });

    const result = spawnSync("claude", args, {
      input: serialized,
      encoding: "utf-8",
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    if (result.error) {
      throw new Error(`Claude CLI error: ${result.error.message}`);
    }

    const raw = result.stdout ?? "";
    const parsed = this.parseCliOutput(raw);

    this.logger.debug("Parsed CLI output", {
      status: result.status,
      isError: parsed.isError,
      error: parsed.error,
      resultLength: parsed.text.length,
    });

    if (parsed.isError) {
      throw new Error(parsed.error ?? parsed.text ?? "Unknown Claude CLI error");
    }

    if (result.status !== 0 && !parsed.text) {
      const errorDetail = result.stderr || raw || "unknown error";
      throw new Error(`Claude CLI exited with code ${result.status}: ${errorDetail}`);
    }

    const text = parsed.text;

    const toolCalls = this.extractToolCalls(text);

    this.logger.debug("Received response from Claude CLI", {
      textLength: text.length,
      toolCallCount: toolCalls.length,
    });

    return { text, toolCalls, raw };
  }

  private parseCliOutput(raw: string): { text: string; isError: boolean; error?: string } {
    // The CLI with --output-format json outputs a JSON array of event objects
    // Try parsing as a JSON array first (the full output)
    try {
      const events = JSON.parse(raw) as unknown[];
      if (Array.isArray(events)) {
        // Look for the result event
        const resultEvent = events.find(
          (e): e is Record<string, unknown> =>
            typeof e === "object" && e !== null && (e as Record<string, unknown>).type === "result",
        );
        if (resultEvent) {
          if (resultEvent.is_error) {
            return {
              text: String(resultEvent.result ?? ""),
              isError: true,
              error: String(resultEvent.result ?? "Unknown error"),
            };
          }
          return { text: String(resultEvent.result ?? ""), isError: false };
        }

        // Fallback: look for assistant message
        const assistantEvent = events.find(
          (e): e is Record<string, unknown> =>
            typeof e === "object" && e !== null && (e as Record<string, unknown>).type === "assistant",
        );
        if (assistantEvent) {
          const msg = assistantEvent.message as Record<string, unknown> | undefined;
          if (msg?.content) {
            const content = msg.content as Array<Record<string, unknown>>;
            const textBlock = content.find((b) => b.type === "text");
            if (textBlock) {
              return { text: String(textBlock.text ?? ""), isError: false };
            }
          }
        }
      }
    } catch {
      // Not a JSON array — try single JSON object
    }

    // Try parsing as a single JSON object (simpler output format)
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "string") return { text: parsed, isError: false };
      if (parsed.result !== undefined) return { text: String(parsed.result), isError: !!parsed.is_error };
      if (parsed.text !== undefined) return { text: String(parsed.text), isError: false };
    } catch {
      // Not JSON at all
    }

    // Plain text output
    return { text: raw, isError: false };
  }

  private serializeMessages(messages: Message[]): string {
    return messages
      .map((msg) => {
        if (msg.role === "tool") {
          return `Tool result (${msg.toolName ?? "unknown"}):\n${msg.content}`;
        }
        const role = msg.role === "user" ? "User" : "Assistant";
        return `${role}: ${msg.content}`;
      })
      .join("\n\n");
  }

  private extractToolCalls(text: string): ToolCall[] {
    const calls: ToolCall[] = [];
    let match: RegExpExecArray | null;

    // Reset regex state
    TOOL_CALL_REGEX.lastIndex = 0;

    while ((match = TOOL_CALL_REGEX.exec(text)) !== null) {
      const toolName = match[1].trim();
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(match[2].trim());
      } catch {
        args = { raw: match[2].trim() };
      }
      calls.push({ toolName, arguments: args });
    }

    return calls;
  }
}
