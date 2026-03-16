export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description?: string }>;
      required: string[];
    };
  };
}

export abstract class BaseTool {
  abstract name(): string;
  abstract toolDescription(): string;
  abstract toolSchema(): ToolSchema;
  abstract execute(args: Record<string, unknown>): Promise<string>;
}
