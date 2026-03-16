import { BaseModelConnection, type ConnectionStatus } from "./base-model-connection.js";
import type { Message, LLMResponse, ToolCall } from "../agent/types.js";
import type { Logger } from "../logging/logger.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// Required for OAuth tokens on non-streaming requests — not needed for regular API keys
const BETA_OAUTH = ["claude-code-20250219", "oauth-2025-04-20"];

function isOAuthToken(token: string): boolean {
  return token.includes("sk-ant-oat");
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
  stop_reason: string;
}

export class AnthropicDirectModelConnection extends BaseModelConnection {
  private token: string | null = null;
  private connectionStatus: ConnectionStatus = "disconnected";

  constructor(
    private model: string,
    private explicitKey: string | undefined,
    private logger: Logger,
  ) {
    super();
  }

  async connect(): Promise<void> {
    let source: string | undefined;
    let token: string | undefined;

    if (this.explicitKey) {
      token = this.explicitKey;
      source = "config key";
    } else if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      source = "CLAUDE_CODE_OAUTH_TOKEN";
    } else if (process.env.ANTHROPIC_API_KEY) {
      token = process.env.ANTHROPIC_API_KEY;
      source = "ANTHROPIC_API_KEY";
    }

    if (!token) {
      this.connectionStatus = "error";
      throw new Error("No token found. Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY.");
    }

    const masked = `${token.slice(0, 16)}...${token.slice(-4)}`;
    this.token = token;
    this.connectionStatus = "connected";
    this.logger.info("Anthropic direct connection established", {
      model: this.model,
      source: source,
      token: masked,
      authType: isOAuthToken(token) ? "oauth" : "api_key",
    });
  }

  modelId(): string { return this.model; }

  status(): ConnectionStatus {
    return this.connectionStatus;
  }

  async test(): Promise<boolean> {
    try {
      const result = await this.callApi([{ role: "user", content: "ping" }], "Reply with: pong", 16);
      return result.content.some((b) => b.type === "text");
    } catch {
      return false;
    }
  }

  async prompt(messages: Message[], systemPrompt: string, signal?: AbortSignal): Promise<LLMResponse> {
    if (!this.token) throw new Error("Not connected. Call connect() first.");

    const apiMessages = this.toAnthropicMessages(messages);

    this.logger.debug("Sending prompt to Anthropic API", {
      model: this.model,
      messageCount: apiMessages.length,
    });

    const response = await this.callApi(apiMessages, systemPrompt, 8192, signal);

    const textBlocks = response.content.filter((b) => b.type === "text");
    const text = textBlocks.map((b) => b.text ?? "").join("");
    const toolCalls = this.extractToolCalls(text);

    this.logger.debug("Received response from Anthropic API", {
      textLength: text.length,
      toolCallCount: toolCalls.length,
      stopReason: response.stop_reason,
    });

    return { text, toolCalls, raw: JSON.stringify(response) };
  }

  private buildBetaHeaders(): string | undefined {
    return isOAuthToken(this.token!) ? BETA_OAUTH.join(",") : undefined;
  }

  private async callApi(
    messages: AnthropicMessage[],
    system: string,
    maxTokens: number,
    signal?: AbortSignal,
  ): Promise<AnthropicResponse> {
    const betaHeader = this.buildBetaHeaders();
    const response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        ...(isOAuthToken(this.token!)
          ? { authorization: `Bearer ${this.token!}` }
          : { "x-api-key": this.token! }),
        "anthropic-version": ANTHROPIC_VERSION,
        ...(betaHeader ? { "anthropic-beta": betaHeader } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        system,
        messages,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${body}`);
    }

    return response.json() as Promise<AnthropicResponse>;
  }

  private toAnthropicMessages(messages: Message[]): AnthropicMessage[] {
    const result: AnthropicMessage[] = [];

    for (const msg of messages) {
      if (msg.role === "tool") {
        // Append tool results as a user turn
        const prev = result[result.length - 1];
        const content = `Tool result (${msg.toolName ?? "unknown"}):\n${msg.content}`;
        if (prev?.role === "user") {
          prev.content += `\n\n${content}`;
        } else {
          result.push({ role: "user", content });
        }
      } else {
        result.push({ role: msg.role, content: msg.content });
      }
    }

    return result;
  }

  private extractToolCalls(text: string): ToolCall[] {
    const calls: ToolCall[] = [];
    const regex =
      /<tool_call>\s*<name>(.*?)<\/name>\s*<arguments>([\s\S]*?)<\/arguments>\s*<\/tool_call>/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
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
