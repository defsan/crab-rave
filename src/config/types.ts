export interface ModelDef {
  name: string;
  type: "claude-cli" | "claude-api" | "ollama" | "openrouter";
  /** Model ID used verbatim in API calls */
  model?: string;
  /** API key or token. Falls back to env vars when omitted. */
  key?: string;
  /** Base URL for Ollama (ollama type only), e.g. "http://localhost:11434" */
  url?: string;
}

export interface CommunicationDef {
  name: string;
  type: "cli" | "telegram";
  /** Auth token / bot key for non-CLI channels */
  key?: string;
  /**
   * Telegram only. Allowlist of chat IDs that may interact with this bot.
   * If omitted, the first message received claims the bot for that session.
   */
  chat_ids?: number[];
}

export interface AgentDef {
  name: string;
  /** Short alias for prompt routing, e.g. "fe" for "frontend-agent" */
  alias?: string;
  /** Must match a ModelDef.name */
  model_name: string;
  workfolder: string;
  /** Must match a CommunicationDef.name */
  communication: string;
  /** Files loaded from workfolder to seed conversation history on a fresh context */
  default_context?: string[];
}

export interface LoopConfig {
  maxRetries: number;
  maxAgentIterations: number;
  defaultModelTimeout?: number; // seconds to wait for a model reply
  verbose?: boolean;
  /** Path to prompt log file. When set, each model call is appended in human-readable form. */
  promptLog?: string;
}

export interface CrabRaveConfig {
  agents: AgentDef[];
  models: ModelDef[];
  communications: CommunicationDef[];
  logFile: string;
  loop: LoopConfig;
}
