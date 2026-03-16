import type { Message, LLMResponse } from "../agent/types.js";
import type { ToolRegistry } from "../tools/tool-registry.js";

export type ConnectionStatus = "connected" | "disconnected" | "error";

export abstract class BaseModelConnection {
  abstract connect(): Promise<void>;
  abstract status(): ConnectionStatus;
  abstract test(): Promise<boolean>;
  abstract prompt(messages: Message[], systemPrompt: string, signal?: AbortSignal): Promise<LLMResponse>;
  abstract modelId(): string;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setToolRegistry(_registry: ToolRegistry): void {}
}
