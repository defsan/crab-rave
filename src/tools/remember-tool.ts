import { appendFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BaseTool, type ToolSchema } from "./base-tool.js";
import type { MemoryDb } from "./memory-db.js";

function expandPath(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export class RememberTool extends BaseTool {
  private workfolder: string;

  constructor(
    private memoryDb: MemoryDb,
    workfolder: string,
  ) {
    super();
    this.workfolder = path.resolve(expandPath(workfolder));
  }

  name(): string {
    return "remember";
  }

  toolDescription(): string {
    return "Save important information to long-term memory. Use for decisions, key facts, user preferences, and lessons learned — anything that should persist across sessions.";
  }

  toolSchema(): ToolSchema {
    return {
      type: "function",
      function: {
        name: this.name(),
        description:
          "Save a piece of information to long-term memory. Use when you learn something important that should persist across sessions — decisions, facts, preferences, lessons learned.",
        parameters: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "The information to save. Be concise and specific.",
            },
            tags: {
              type: "string",
              description: "Space-separated keywords for later retrieval. Example: 'postgres migration database'",
            },
          },
          required: ["content"],
        },
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const content = args.content as string;
    const tags = typeof args.tags === "string" ? args.tags.trim() : "";

    if (!content || typeof content !== "string") return "Error: missing 'content'";

    const memoryDir = path.join(this.workfolder, "memory");
    try {
      mkdirSync(memoryDir, { recursive: true });
    } catch (err) {
      return `Error creating memory directory: ${err instanceof Error ? err.message : String(err)}`;
    }

    const today = todayIso();
    const logFile = path.join(memoryDir, `${today}.md`);
    const timestamp = new Date().toISOString();
    const tagLine = tags ? `\nTags: ${tags}` : "";
    const entry = `\n<!-- ${timestamp} -->\n${content}${tagLine}\n`;

    try {
      appendFileSync(logFile, entry, "utf-8");
    } catch (err) {
      return `Error writing memory: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Also insert directly into the index so recall works immediately
    const source = `memory/${today}.md`;
    this.memoryDb.insert(source, content, tags);

    return `Saved to memory (${source})${tags ? ` [tags: ${tags}]` : ""}`;
  }
}
