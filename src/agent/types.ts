export interface Message {
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
  /** Base64-encoded images attached to this message (vision models only). */
  images?: string[];
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
  /** Sum of inputTokens across every LLM call made during this turn. */
  totalInputTokens: number;
  /** Number of tool-call iterations executed during this turn. */
  iterations: number;
  /** True when the loop was cut short by a configured limit rather than completing normally. */
  exhausted?: boolean;
}
