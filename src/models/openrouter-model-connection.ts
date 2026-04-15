import { BaseModelConnection, type ConnectionStatus } from "./base-model-connection.js";
import type { Message, LLMResponse, ToolCall } from "../agent/types.js";
import type { Logger } from "../logging/logger.js";
import type { ToolRegistry } from "../tools/tool-registry.js";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const XML_TOOL_CALL_REGEX =
  /<tool_call>\s*<name>(.*?)<\/name>\s*<arguments>([\s\S]*?)<\/arguments>\s*<\/tool_call>/g;

function wrapFetchError(err: unknown, context: string): Error {
  const cause = (err as { cause?: unknown }).cause;
  const detail = cause instanceof Error ? cause.message : err instanceof Error ? err.message : String(err);
  return new Error(`${context}: ${detail}`);
}

// OpenAI-compatible message types for the API request
interface OAITextContent {
  type: "text";
  text: string;
}

interface OAIImageContent {
  type: "image_url";
  image_url: { url: string };
}

type OAIContentPart = OAITextContent | OAIImageContent;

interface OAIUserMessage {
  role: "user";
  content: string | OAIContentPart[];
}

interface OAISystemMessage {
  role: "system";
  content: string;
}

interface OAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OAIAssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: OAIToolCall[];
}

interface OAIToolResultMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

type OAIMessage = OAISystemMessage | OAIUserMessage | OAIAssistantMessage | OAIToolResultMessage;

interface OAIResponse {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: OAIToolCall[];
    };
    finish_reason: string;
  }>;
  model: string;
}

export class OpenRouterModelConnection extends BaseModelConnection {
  private token: string | null = null;
  private connectionStatus: ConnectionStatus = "disconnected";
  private toolRegistry: ToolRegistry | null = null;
  private readonly baseUrl: string;

  constructor(
    private model: string,
    private explicitKey: string | undefined,
    private logger: Logger,
    baseUrl?: string,
  ) {
    super();
    this.baseUrl = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  setToolRegistry(registry: ToolRegistry): void {
    this.toolRegistry = registry;
  }

  modelId(): string {
    return this.model;
  }

  status(): ConnectionStatus {
    return this.connectionStatus;
  }

  async connect(): Promise<void> {
    let token: string | undefined;
    let source: string | undefined;

    if (this.explicitKey) {
      token = this.explicitKey;
      source = "config key";
    } else if (process.env.OPENROUTER_API_KEY) {
      token = process.env.OPENROUTER_API_KEY;
      source = "OPENROUTER_API_KEY";
    }

    if (!token) {
      this.connectionStatus = "error";
      throw new Error('No OpenRouter key found. Set "key" in config or OPENROUTER_API_KEY env var.');
    }

    this.token = token;
    this.connectionStatus = "connected";
    this.logger.info("OpenRouter connection established", {
      model: this.model,
      baseUrl: this.baseUrl,
      source,
      token: `${token.slice(0, 10)}...${token.slice(-4)}`,
    });
  }

  async test(): Promise<boolean> {
    try {
      const response = await this.callApi(
        [{ role: "user", content: "ping" }],
        "Reply with: pong",
        16,
      );
      const text = response.choices[0]?.message.content ?? "";
      return text.length > 0;
    } catch {
      return false;
    }
  }

  async prompt(messages: Message[], systemPrompt: string, signal?: AbortSignal): Promise<LLMResponse> {
    if (!this.token) throw new Error("Not connected. Call connect() first.");

    const apiMessages = this.buildMessages(messages, systemPrompt);
    const tools = this.toolRegistry?.toOllamaTools() ?? [];

    this.logger.debug("Sending prompt to OpenRouter", {
      model: this.model,
      messageCount: apiMessages.length,
      toolCount: tools.length,
    });

    const response = await this.callApi(apiMessages, "", 8192, signal, tools.length ? tools : undefined);
    const choice = response.choices[0];
    const rawContent = choice?.message.content ?? "";
    const nativeToolCalls = choice?.message.tool_calls ?? [];

    let toolCalls: ToolCall[];
    let text: string;

    if (nativeToolCalls.length > 0) {
      // Native tool calls — convert to ToolCall[] and build XML text for history
      toolCalls = nativeToolCalls.map((tc) => {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = { raw: tc.function.arguments };
        }
        return { toolName: tc.function.name, arguments: args };
      });

      // Embed XML in text so history round-trips correctly through buildMessages()
      const xmlParts = toolCalls.map(
        (tc) =>
          `<tool_call>\n<name>${tc.toolName}</name>\n<arguments>${JSON.stringify(tc.arguments)}</arguments>\n</tool_call>`,
      );
      text = [rawContent, ...xmlParts].filter(Boolean).join("\n");
    } else {
      // No native tool calls — try XML fallback (for models that output XML)
      text = rawContent;
      toolCalls = this.extractXmlToolCalls(text);
    }

    this.logger.debug("Received response from OpenRouter", {
      model: response.model,
      textLength: text.length,
      toolCallCount: toolCalls.length,
      finishReason: choice?.finish_reason,
    });

    return { text, toolCalls, raw: JSON.stringify(response) };
  }

  private async callApi(
    messages: OAIMessage[],
    _system: string,
    maxTokens: number,
    signal?: AbortSignal,
    tools?: unknown[],
  ): Promise<OAIResponse> {
    const url = `${this.baseUrl}/chat/completions`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token!}`,
          "http-referer": "https://github.com/crab-rave",
          "x-title": "crab-rave",
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          max_tokens: maxTokens,
          ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
        }),
      });
    } catch (err) {
      throw wrapFetchError(err, `OpenRouter API (${url})`);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenRouter API error ${response.status} (${url}): ${body}`);
    }

    return response.json() as Promise<OAIResponse>;
  }

  /**
   * Convert the internal Message[] + system prompt into an OpenAI-compatible message array.
   *
   * Assistant messages that were followed by tool results in the history contain XML
   * tool_call blocks. We parse those to reconstruct the native tool_calls structure
   * and assign sequential call IDs so the tool result messages get matching IDs.
   */
  private buildMessages(messages: Message[], systemPrompt: string): OAIMessage[] {
    const result: OAIMessage[] = [{ role: "system", content: systemPrompt }];
    let callCounter = 0;
    let i = 0;

    while (i < messages.length) {
      const msg = messages[i];

      if (msg.role === "user") {
        if (msg.images?.length) {
          const parts: OAIContentPart[] = [{ type: "text", text: msg.content }];
          for (const b64 of msg.images) {
            parts.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } });
          }
          result.push({ role: "user", content: parts });
        } else {
          result.push({ role: "user", content: msg.content });
        }
        i++;
        continue;
      }

      if (msg.role === "assistant") {
        // Collect any immediately following tool-result messages
        const toolMsgs: Message[] = [];
        let j = i + 1;
        while (j < messages.length && messages[j].role === "tool") {
          toolMsgs.push(messages[j]);
          j++;
        }

        if (toolMsgs.length > 0) {
          // Parse XML tool calls embedded in the assistant text
          const parsedCalls = this.extractXmlToolCalls(msg.content);
          const n = toolMsgs.length;
          const ids = Array.from({ length: n }, () => `call_${callCounter++}`);

          // Strip XML from content; use null if nothing remains
          const stripped = msg.content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim();

          result.push({
            role: "assistant",
            content: stripped || null,
            tool_calls: ids.map((id, k) => ({
              id,
              type: "function" as const,
              function: {
                name: parsedCalls[k]?.toolName ?? toolMsgs[k]?.toolName ?? "unknown",
                arguments: JSON.stringify(parsedCalls[k]?.arguments ?? {}),
              },
            })),
          });

          for (let k = 0; k < toolMsgs.length; k++) {
            result.push({
              role: "tool",
              tool_call_id: ids[k],
              content: toolMsgs[k].content,
            });
          }

          i = j; // consumed all tool messages
          continue;
        }

        // Plain assistant message (no tool calls)
        const stripped = msg.content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim();
        result.push({ role: "assistant", content: stripped || "" });
        i++;
        continue;
      }

      if (msg.role === "tool") {
        // Orphaned tool message — shouldn't normally occur; treat as user content
        result.push({
          role: "user",
          content: `Tool result (${msg.toolName ?? "unknown"}):\n${msg.content}`,
        });
        i++;
        continue;
      }

      i++;
    }

    return result;
  }

  private extractXmlToolCalls(text: string): ToolCall[] {
    const calls: ToolCall[] = [];
    XML_TOOL_CALL_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = XML_TOOL_CALL_REGEX.exec(text)) !== null) {
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
