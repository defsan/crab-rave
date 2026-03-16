import type { BaseTool, ToolSchema } from "./base-tool.js";

export class ToolRegistry {
  private tools = new Map<string, BaseTool>();

  register(tool: BaseTool): void {
    this.tools.set(tool.name(), tool);
  }

  getAll(): BaseTool[] {
    return [...this.tools.values()];
  }

  getByName(name: string): BaseTool | undefined {
    return this.tools.get(name);
  }

  toOllamaTools(): ToolSchema[] {
    return [...this.tools.values()].map((t) => t.toolSchema());
  }

  generateToolDescriptions(): string {
    if (this.tools.size === 0) return "";

    const lines = [
      "You have access to the following tools. To use a tool, respond with a tool_call block in this exact format:",
      "",
      "<tool_call>",
      "<name>tool_name</name>",
      "<arguments>{\"arg\": \"value\"}</arguments>",
      "</tool_call>",
      "",
      "Available tools:",
      "",
    ];

    for (const tool of this.tools.values()) {
      lines.push(`### ${tool.name()}`);
      lines.push(tool.toolDescription());
      lines.push("");
    }

    return lines.join("\n");
  }
}
