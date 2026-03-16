import {
  existsSync,
  statSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { BaseTool, type ToolSchema } from "./base-tool.js";

const DEFAULT_READ_LIMIT = 200;
const DEFAULT_LIST_DEPTH = 2;
const ALWAYS_SKIP = new Set(["node_modules", ".git", "dist", ".next", "__pycache__", ".cache"]);

function expandPath(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function isBinary(filePath: string): boolean {
  try {
    const fd = readFileSync(filePath);
    const check = fd.slice(0, 8000);
    for (let i = 0; i < check.length; i++) {
      if (check[i] === 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function countLines(filePath: string): number {
  try {
    const content = readFileSync(filePath, "utf-8");
    return content.split("\n").length;
  } catch {
    return 0;
  }
}

export class FsTool extends BaseTool {
  private workfolder: string;

  constructor(workfolder?: string) {
    super();
    this.workfolder = workfolder ? path.resolve(expandPath(workfolder)) : path.resolve(".");
  }

  name(): string {
    return "fs";
  }

  private isAllowedPath(resolved: string): boolean {
    const tmp = path.resolve("/tmp");
    return resolved.startsWith(this.workfolder) || resolved === tmp || resolved.startsWith(tmp + "/");
  }

  private resolvePath(p: string): string {
    const expanded = expandPath(p);
    // Relative paths are resolved against workfolder
    return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(this.workfolder, expanded);
  }

  private guardPath(resolved: string): string | null {
    if (!this.isAllowedPath(resolved)) {
      return `Error: path "${resolved}" is outside allowed zones (workfolder, /tmp)`;
    }
    return null;
  }

  toolDescription(): string {
    return [
      "File system operations. Actions: list, read, write, append, read-chunk, get-size.",
      `Paths are relative to workfolder (${this.workfolder}) unless absolute. Restricted to workfolder and /tmp.`,
    ].join("\n");
  }

  toolSchema(): ToolSchema {
    return {
      type: "function",
      function: {
        name: this.name(),
        description: `File system operations within the workfolder (${this.workfolder}) and /tmp. Actions: list (directory listing), read (file with line numbers), write (create/overwrite), append (add to end), read-chunk (read at line offset), get-size (size + line count).`,
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              description: "list | read | write | append | read-chunk | get-size",
            },
            path: {
              type: "string",
              description: "File or directory path (relative to workfolder or absolute)",
            },
            content: {
              type: "string",
              description: "Content to write or append (write and append actions)",
            },
            offset: {
              type: "number",
              description: "1-based line number to start reading from (read, read-chunk)",
            },
            limit: {
              type: "number",
              description: `Max lines to return (read, read-chunk — default ${DEFAULT_READ_LIMIT})`,
            },
            depth: {
              type: "number",
              description: `Directory depth for list (default ${DEFAULT_LIST_DEPTH})`,
            },
          },
          required: ["action", "path"],
        },
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = args.action as string;
    const rawPath = args.path as string;

    if (!action || typeof action !== "string") return "Error: missing 'action'";
    if (!rawPath || typeof rawPath !== "string") return "Error: missing 'path'";

    const resolved = this.resolvePath(rawPath);
    const guard = this.guardPath(resolved);
    if (guard) return guard;

    switch (action) {
      case "list":
        return this.list(resolved, (args.depth as number | undefined) ?? DEFAULT_LIST_DEPTH);
      case "read":
        return this.read(resolved, args.offset as number | undefined, args.limit as number | undefined);
      case "read-chunk":
        return this.read(resolved, args.offset as number | undefined, args.limit as number | undefined);
      case "write":
        return this.write(resolved, args.content as string | undefined);
      case "append":
        return this.append(resolved, args.content as string | undefined);
      case "get-size":
        return this.getSize(resolved);
      default:
        return `Error: unknown action "${action}". Use: list, read, write, append, read-chunk, get-size`;
    }
  }

  private list(dirPath: string, depth: number): string {
    if (!existsSync(dirPath)) return `Error: path does not exist: ${dirPath}`;
    const stat = statSync(dirPath);
    if (!stat.isDirectory()) return `Error: not a directory: ${dirPath}`;

    const lines: string[] = [`${dirPath}`];

    const walk = (dir: string, indent: string, currentDepth: number): void => {
      if (currentDepth > depth) return;
      let entries: string[];
      try {
        entries = readdirSync(dir).sort();
      } catch {
        return;
      }
      for (const entry of entries) {
        if (ALWAYS_SKIP.has(entry)) continue;
        const fullPath = path.join(dir, entry);
        try {
          const st = statSync(fullPath);
          if (st.isDirectory()) {
            lines.push(`${indent}${entry}/`);
            walk(fullPath, indent + "  ", currentDepth + 1);
          } else {
            lines.push(`${indent}${entry}  (${formatSize(st.size)})`);
          }
        } catch {
          lines.push(`${indent}${entry}  (unreadable)`);
        }
      }
    };

    walk(dirPath, "  ", 1);
    return lines.join("\n");
  }

  private read(filePath: string, offset?: number, limit?: number): string {
    if (!existsSync(filePath)) return `Error: file does not exist: ${filePath}`;
    const stat = statSync(filePath);
    if (stat.isDirectory()) return `Error: path is a directory. Use action "list" instead.`;
    if (isBinary(filePath)) return `Error: binary file — cannot read as text.`;

    const content = readFileSync(filePath, "utf-8");
    const allLines = content.split("\n");
    const totalLines = allLines.length;

    const start = Math.max(1, offset ?? 1);
    const maxLines = limit ?? DEFAULT_READ_LIMIT;
    const end = Math.min(start + maxLines - 1, totalLines);

    const slice = allLines.slice(start - 1, end);
    const numbered = slice.map((line, i) => `${String(start + i).padStart(6)}  ${line}`).join("\n");

    const header =
      end < totalLines
        ? `Showing lines ${start}–${end} of ${totalLines} total (truncated — use offset=${end + 1} for more):`
        : start > 1
          ? `Showing lines ${start}–${end} of ${totalLines} total:`
          : `${filePath} (${totalLines} lines):`;

    return `${header}\n${numbered}`;
  }

  private write(filePath: string, content?: string): string {
    if (content === undefined || typeof content !== "string") return "Error: missing 'content'";
    try {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, "utf-8");
      return `Written ${content.length} bytes to ${filePath}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private append(filePath: string, content?: string): string {
    if (content === undefined || typeof content !== "string") return "Error: missing 'content'";
    try {
      mkdirSync(path.dirname(filePath), { recursive: true });
      appendFileSync(filePath, content, "utf-8");
      return `Appended ${content.length} bytes to ${filePath}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private getSize(filePath: string): string {
    if (!existsSync(filePath)) return `Error: path does not exist: ${filePath}`;
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      return `${filePath}: directory`;
    }
    if (isBinary(filePath)) {
      return `${filePath}: ${formatSize(stat.size)} (binary)`;
    }
    const lines = countLines(filePath);
    return `${filePath}: ${formatSize(stat.size)}, ${lines} lines`;
  }
}
