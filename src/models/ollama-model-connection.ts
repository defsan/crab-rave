import { BaseModelConnection, type ConnectionStatus } from "./base-model-connection.js";
import type { Message, LLMResponse, ToolCall } from "../agent/types.js";
import type { Logger } from "../logging/logger.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { ToolSchema } from "../tools/base-tool.js";

function wrapFetchError(err: unknown, context: string): Error {
  const cause = (err as { cause?: unknown }).cause;
  const detail = cause instanceof Error ? cause.message : (err instanceof Error ? err.message : String(err));
  return new Error(`${context}: ${detail}`);
}

interface OllamaMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  images?: string[];
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaResponse {
  message: {
    role: string;
    content: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
}

export class OllamaModelConnection extends BaseModelConnection {
  private connectionStatus: ConnectionStatus = "disconnected";
  private toolRegistry: ToolRegistry | null = null;

  constructor(
    private model: string,
    private baseUrl: string,
    private logger: Logger,
  ) {
    super();
  }

  setToolRegistry(registry: ToolRegistry): void {
    this.toolRegistry = registry;
  }

  async connect(): Promise<void> {
    const url = `${this.baseUrl}/api/tags`;
    let response: Response;
    try {
      response = await fetch(url);
    } catch (err) {
      this.connectionStatus = "error";
      throw wrapFetchError(err, `Cannot reach Ollama at ${url}`);
    }
    if (!response.ok) {
      this.connectionStatus = "error";
      throw new Error(`Cannot reach Ollama at ${url}: HTTP ${response.status}`);
    }
    this.connectionStatus = "connected";
    this.logger.info("Ollama connection established", { model: this.model, url: this.baseUrl });
  }

  modelId(): string { return this.model; }

  status(): ConnectionStatus {
    return this.connectionStatus;
  }

  async test(): Promise<boolean> {
    try {
      const result = await this.callApi([{ role: "user", content: "ping" }], "Reply with: pong");
      return result.message.content.length > 0 || (result.message.tool_calls?.length ?? 0) > 0;
    } catch {
      return false;
    }
  }

  async prompt(messages: Message[], systemPrompt: string, signal?: AbortSignal): Promise<LLMResponse> {
    const apiMessages = this.toOllamaMessages(messages);

    this.logger.debug("Sending prompt to Ollama", {
      model: this.model,
      messageCount: apiMessages.length,
    });

    const response = await this.callApi(apiMessages, systemPrompt, signal);
    const text = response.message.content ?? "";
    const toolCalls = this.extractToolCalls(response);

    this.logger.debug("Received response from Ollama", {
      textLength: text.length,
      toolCallCount: toolCalls.length,
    });

    return { text, toolCalls, raw: JSON.stringify(response) };
  }

  private async callApi(messages: OllamaMessage[], system: string, signal?: AbortSignal): Promise<OllamaResponse> {
    const tools: ToolSchema[] = this.toolRegistry?.toOllamaTools() ?? [];
    const url = `${this.baseUrl}/api/chat`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          system,
          messages,
          stream: false,
          ...(tools.length > 0 ? { tools } : {}),
        }),
      });
    } catch (err) {
      throw wrapFetchError(err, `Ollama API (${url})`);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama API error ${response.status} (${url}): ${body}`);
    }

    return response.json() as Promise<OllamaResponse>;
  }

  private extractToolCalls(response: OllamaResponse): ToolCall[] {
    // Prefer native structured tool_calls (proper Ollama tool calling)
    if (response.message.tool_calls?.length) {
      return response.message.tool_calls.map((tc) => ({
        toolName: tc.function.name,
        arguments: tc.function.arguments,
      }));
    }

    // Fallback: parse Qwen's XML format from content
    //   <function=tool_name>
    //   <parameter=arg_name>value</parameter>
    //   </function>
    return this.extractQwenToolCalls(response.message.content ?? "");
  }

  private extractQwenToolCalls(text: string): ToolCall[] {
    const calls: ToolCall[] = [];
    const fnRegex = /<function=(\w+)>([\s\S]*?)<\/function>/g;
    let fnMatch: RegExpExecArray | null;

    while ((fnMatch = fnRegex.exec(text)) !== null) {
      const toolName = fnMatch[1].trim();
      const body = fnMatch[2];
      const args: Record<string, unknown> = {};

      const paramRegex = /<parameter=(\w+)>([\s\S]*?)<\/parameter>/g;
      let paramMatch: RegExpExecArray | null;
      while ((paramMatch = paramRegex.exec(body)) !== null) {
        const key = paramMatch[1].trim();
        const val = paramMatch[2].trim();
        // Try to parse as JSON, fall back to string
        try {
          args[key] = JSON.parse(val);
        } catch {
          args[key] = val;
        }
      }

      calls.push({ toolName, arguments: args });
    }

    return calls;
  }

  private toOllamaMessages(messages: Message[]): OllamaMessage[] {
    return messages.map((msg) => {
      if (msg.role === "tool") {
        return {
          role: "tool" as const,
          content: `Tool result (${msg.toolName ?? "unknown"}):\n${msg.content}`,
        };
      }
      const out: OllamaMessage = { role: msg.role, content: msg.content };
      if (msg.images?.length) out.images = msg.images;
      return out;
    });
  }
}
