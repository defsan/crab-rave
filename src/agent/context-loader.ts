import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AgentDef } from "../config/types.js";
import type { Message } from "../agent/types.js";

/** Checked in order during auto-discovery; first match wins, nothing else is loaded. */
const AUTO_DISCOVER_FILES = ["AGENTS.md", "AGENT.md"];

function expandPath(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Returns context to inject into the system prompt.
 *
 * If `agentDef.default_context` is set those files are used exclusively —
 * every file must exist or a configuration error is thrown.
 *
 * Otherwise auto-discovery kicks in: the first of AGENTS.md / AGENT.md found
 * in the workfolder is used and nothing else is loaded.
 */
export function loadAgentContext(agentDef: AgentDef): string | undefined {
  const dir = expandPath(agentDef.workfolder);

  if (agentDef.default_context?.length) {
    const parts: string[] = [];
    for (const filename of agentDef.default_context) {
      const filepath = path.join(dir, filename);
      if (!existsSync(filepath)) {
        throw new Error(
          `Configuration error: default_context file "${filename}" not found in ${dir}`,
        );
      }
      const content = readFileSync(filepath, "utf-8").trim();
      if (content) {
        parts.push(`## ${filename}\n\n${content}`);
      }
    }
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }

  // Auto-discovery: first of AGENTS.md / AGENT.md wins; skip everything else.
  for (const filename of AUTO_DISCOVER_FILES) {
    const filepath = path.join(dir, filename);
    if (existsSync(filepath)) {
      const content = readFileSync(filepath, "utf-8").trim();
      if (content) {
        return `## ${filename}\n\n${content}`;
      }
    }
  }

  return undefined;
}

/**
 * Builds initial history messages from agentDef.default_context files.
 * Returns an empty array if no files are configured.
 * Throws a configuration error if a configured file does not exist.
 */
export function loadDefaultContextMessages(agentDef: AgentDef): Message[] {
  if (!agentDef.default_context?.length) return [];

  const dir = expandPath(agentDef.workfolder);
  const parts: string[] = [];
  const loaded: string[] = [];

  for (const filename of agentDef.default_context) {
    const filepath = path.join(dir, filename);
    if (!existsSync(filepath)) {
      throw new Error(
        `Configuration error: default_context file "${filename}" not found in ${dir}`,
      );
    }
    const content = readFileSync(filepath, "utf-8").trim();
    if (content) {
      parts.push(`## ${filename}\n\n${content}`);
      loaded.push(filename);
    }
  }

  if (parts.length === 0) return [];

  return [
    { role: "user", content: `Here is the initial context for this session:\n\n${parts.join("\n\n")}` },
    { role: "assistant", content: `Context loaded from: ${loaded.join(", ")}. Ready to assist.` },
  ];
}
