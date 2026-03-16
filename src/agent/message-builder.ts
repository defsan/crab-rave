import type { ToolRegistry } from "../tools/tool-registry.js";

const BASE_SYSTEM_PROMPT = `You are a helpful assistant with access to tools. When you need to perform actions like running shell commands, use the provided tools. Always explain what you're doing before and after using tools. Be concise and helpful.`;

export function buildSystemPrompt(
  toolRegistry: ToolRegistry,
  customPrompt?: string,
  agentContext?: string,
): string {
  const parts = [customPrompt ?? BASE_SYSTEM_PROMPT];

  if (agentContext) {
    parts.push(agentContext);
  }

  const toolDescriptions = toolRegistry.generateToolDescriptions();
  if (toolDescriptions) {
    parts.push(toolDescriptions);
  }

  return parts.join("\n\n");
}
