export interface Message {
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
}

export interface ToolCall {
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface LLMResponse {
  text: string;
  toolCalls: ToolCall[];
  raw: string;
}

export interface PromptStats {
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  tokensPerSecond: number;
}

export interface AgentResult {
  response: string;
  messages: Message[];
  stats: PromptStats;
}
