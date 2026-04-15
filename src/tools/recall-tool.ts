import { BaseTool, type ToolSchema } from "./base-tool.js";
import type { MemoryDb } from "./memory-db.js";
import type { WebTool } from "./web-tool.js";

// BM25 scores are negative — lower (more negative) = stronger match.
// Results above this threshold are considered too weak to show alone.
const SCORE_THRESHOLD = -0.3;

export class RecallTool extends BaseTool {
  constructor(
    private memoryDb: MemoryDb,
    private webTool: WebTool,
  ) {
    super();
  }

  name(): string {
    return "recall";
  }

  toolDescription(): string {
    return [
      "Search indexed memory and workfolder files for relevant information.",
      "Use keywords, not full sentences — e.g. 'postgres migration' not 'how do I run migrations'.",
      "Falls back to DuckDuckGo web search automatically if nothing is found locally.",
    ].join(" ");
  }

  toolSchema(): ToolSchema {
    return {
      type: "function",
      function: {
        name: this.name(),
        description:
          "Search memory and workfolder files. Use keywords not sentences — e.g. 'postgres migration schema'. Falls back to web search if nothing found locally.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Keywords to search. Example: 'api auth token refresh'",
            },
            limit: {
              type: "integer",
              description: "Max results to return (default: 5)",
            },
          },
          required: ["query"],
        },
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = args.query as string;
    const limit = typeof args.limit === "number" ? Math.max(1, Math.min(args.limit, 20)) : 5;

    if (!query || typeof query !== "string") return "Error: missing 'query'";

    // Lazy-index the workfolder on first call (hash-checked, fast on repeat)
    this.memoryDb.ensureIndexed();

    const results = this.memoryDb.search(query, limit);
    const strong = results.filter((r) => r.score < SCORE_THRESHOLD);

    if (strong.length > 0) {
      const lines = strong.map((r, i) => {
        const label = r.source ? `[${r.source}]` : "[memory]";
        return `## Result ${i + 1} ${label}\n${r.content}`;
      });
      return lines.join("\n\n---\n\n");
    }

    // Weak or zero local results — fall back to DuckDuckGo
    const prefix =
      results.length > 0
        ? `Local search found ${results.length} weak match(es) for "${query}". Fetching web results...\n\n`
        : `No local memory found for "${query}". Fetching web results...\n\n`;

    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const webResult = await this.webTool.execute({ url: ddgUrl });

    return prefix + webResult;
  }
}
