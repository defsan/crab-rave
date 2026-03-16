import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AgentDef } from "../config/types.js";
import type { Message } from "../agent/types.js";

const CONTEXT_FILES = ["AGENT.md", "MEMORY.md"];

function expandPath(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Reads AGENT.md and MEMORY.md from workfolder if they exist.
 *  Returns a formatted string to inject into the system prompt, or undefined. */
export function loadAgentContext(workfolder: string): string | undefined {
  const dir = expandPath(workfolder);
  const parts: string[] = [];

  for (const filename of CONTEXT_FILES) {
    const filepath = path.join(dir, filename);
    if (existsSync(filepath)) {
      const content = readFileSync(filepath, "utf-8").trim();
      if (content) {
        parts.push(`## ${filename}\n\n${content}`);
      }
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** Builds initial history messages from agentDef.default_context files.
 *  Returns an empty array if no files are configured or none exist. */
export function loadDefaultContextMessages(agentDef: AgentDef): Message[] {
  if (!agentDef.default_context?.length) return [];

  const dir = expandPath(agentDef.workfolder);
  const parts: string[] = [];
  const loaded: string[] = [];

  for (const filename of agentDef.default_context) {
    const filepath = path.join(dir, filename);
    if (existsSync(filepath)) {
      const content = readFileSync(filepath, "utf-8").trim();
      if (content) {
        parts.push(`## ${filename}\n\n${content}`);
        loaded.push(filename);
      }
    }
  }

  if (parts.length === 0) return [];

  return [
    { role: "user", content: `Here is the initial context for this session:\n\n${parts.join("\n\n")}` },
    { role: "assistant", content: `Context loaded from: ${loaded.join(", ")}. Ready to assist.` },
  ];
}
