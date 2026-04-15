import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { Message } from "../agent/types.js";
import type { AgentRouter } from "../agent/agent-router.js";

// ── Channel type ──────────────────────────────────────────────────────────────

export type Channel = "cli" | "telegram";

// ── Command context ───────────────────────────────────────────────────────────

export interface CommandContext {
  channel: Channel;
  activeAgent: string;
  router: AgentRouter;
  getHistory(agentName: string): Message[];
  /** Clear history for a specific agent, or all agents if agentName is omitted. */
  clearHistory(agentName?: string): void;
  respond(text: string, isError?: boolean): void | Promise<void>;
}

// ── Command definitions ───────────────────────────────────────────────────────

interface CommandDef {
  usage: string;
  description: string;
  channels: Channel[];
}

const ALL_COMMAND_DEFS: Record<string, CommandDef> = {
  // Common
  help:   { usage: "/help",          description: "Show available commands",                              channels: ["cli", "telegram"] },
  start:  { usage: "/start",         description: "Greet the bot",                                        channels: ["cli", "telegram"] },
  agents: { usage: "/agents",        description: "List all configured agents",                            channels: ["cli", "telegram"] },
  new:    { usage: "/new",           description: "Reset current agent's conversation context",            channels: ["cli", "telegram"] },
  clear:  { usage: "/clear",         description: "Reset all agents' conversation contexts",               channels: ["cli", "telegram"] },
  store:  { usage: "/store",         description: "Save current context to memory/session-<date>-<n>.md", channels: ["cli", "telegram"] },
  // CLI-specific
  agent:  { usage: "/agent <name>",  description: "Switch active agent",                                  channels: ["cli"] },
  abort:  { usage: "/abort",         description: "Abort the running agent (also: Esc key)",               channels: ["cli"] },
  exit:   { usage: "/exit",          description: "Exit the chat",                                        channels: ["cli"] },
  // Telegram-specific
  super:  { usage: "/super",         description: "Raise max tool iterations to 200 for this session",    channels: ["telegram"] },
};

export function buildHelp(channel: Channel): string {
  const lines = ["Available commands:"];
  for (const def of Object.values(ALL_COMMAND_DEFS)) {
    if (def.channels.includes(channel)) {
      lines.push(`  ${def.usage.padEnd(20)} ${def.description}`);
    }
  }
  return lines.join("\n");
}

/** Filtered command defs for a specific channel — useful for building local COMMANDS records. */
export function getCommandDefs(channel: Channel): Record<string, { usage: string; description: string }> {
  return Object.fromEntries(
    Object.entries(ALL_COMMAND_DEFS)
      .filter(([, d]) => d.channels.includes(channel))
      .map(([k, { usage, description }]) => [k, { usage, description }]),
  );
}

// ── Session storage helpers ───────────────────────────────────────────────────

// ── Auto session save ─────────────────────────────────────────────────────────

export function autoSaveSession(workfolder: string, agentName: string, messages: Message[]): void {
  if (messages.length === 0) return;
  try {
    const date = new Date().toISOString().slice(0, 10);
    const uuid = randomUUID();
    const dir = path.join(expandWorkfolder(workfolder), "memories", "sessions", date);
    mkdirSync(dir, { recursive: true });
    const lines: string[] = [`# ${agentName} — ${date}\n`];
    for (const msg of messages) {
      const label = msg.role === "tool" ? `tool(${msg.toolName ?? "unknown"})` : msg.role;
      lines.push(`[${label}]\n${msg.content}\n`);
    }
    writeFileSync(path.join(dir, `${uuid}.md`), lines.join("\n"), "utf-8");
  } catch {
    // never crash the app over a save failure
  }
}

export function expandWorkfolder(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function resolveSessionPath(workfolder: string): string {
  const dir = path.join(expandWorkfolder(workfolder), "memory");
  mkdirSync(dir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const prefix = `session-${today}-`;

  const existing = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".md"))
    : [];

  const numbers = existing
    .map((f) => parseInt(f.slice(prefix.length, -3), 10))
    .filter((n) => !isNaN(n));

  const next = numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
  return path.join(dir, `${prefix}${next}.md`);
}

export function writeSessionFile(filePath: string, agentName: string, messages: Message[]): void {
  const date = new Date().toISOString().replace("T", " ").slice(0, 19);
  const lines: string[] = [
    `# Session — ${agentName}`,
    `_Saved: ${date}_`,
    "",
  ];

  for (const msg of messages) {
    if (msg.role === "user") {
      lines.push(`## You\n\n${msg.content}\n`);
    } else if (msg.role === "assistant") {
      lines.push(`## Assistant\n\n${msg.content}\n`);
    } else if (msg.role === "tool") {
      lines.push(`## Tool: ${msg.toolName ?? "unknown"}\n\n${msg.content}\n`);
    }
  }

  writeFileSync(filePath, lines.join("\n"), "utf-8");
}

// ── Common command handler ────────────────────────────────────────────────────

/**
 * Handles commands that are common to all channels (CLI + Telegram).
 * Returns true if the command was handled; false if it is channel-specific or unknown.
 */
export async function handleCommonCommand(
  cmd: string,
  _args: string,
  ctx: CommandContext,
): Promise<boolean> {
  switch (cmd) {
    case "start":
      await ctx.respond("Ready. Send me a message.");
      return true;

    case "help":
      await ctx.respond(buildHelp(ctx.channel));
      return true;

    case "agents": {
      const agents = ctx.router.getAgents();
      const lines = ["Configured agents:"];
      for (const a of agents) {
        const alias = a.alias ? `  alias: ${a.alias}` : "";
        const marker = a.name === ctx.activeAgent ? " ◀ active" : "";
        lines.push(`  ${a.name.padEnd(16)} model: ${a.model_name}${alias}${marker}`);
      }
      await ctx.respond(lines.join("\n"));
      return true;
    }

    case "new": {
      const agentDef = ctx.router.getAgents().find((a) => a.name === ctx.activeAgent);
      if (agentDef) autoSaveSession(agentDef.workfolder, ctx.activeAgent, ctx.getHistory(ctx.activeAgent));
      ctx.clearHistory(ctx.activeAgent);
      await ctx.respond(`Context reset for agent: ${ctx.activeAgent}`);
      return true;
    }

    case "clear": {
      for (const agentDef of ctx.router.getAgents()) {
        autoSaveSession(agentDef.workfolder, agentDef.name, ctx.getHistory(agentDef.name));
      }
      ctx.clearHistory();
      await ctx.respond("All agents' conversation contexts cleared.");
      return true;
    }

    case "store": {
      const history = ctx.getHistory(ctx.activeAgent);
      if (history.length === 0) {
        await ctx.respond("Nothing to store — conversation is empty.", true);
        return true;
      }
      const agentDef = ctx.router.getAgents().find((a) => a.name === ctx.activeAgent);
      if (!agentDef) {
        await ctx.respond(`Agent "${ctx.activeAgent}" not found.`, true);
        return true;
      }
      try {
        const filePath = resolveSessionPath(agentDef.workfolder);
        writeSessionFile(filePath, ctx.activeAgent, history);
        await ctx.respond(`Context saved to ${filePath}`);
      } catch (err) {
        await ctx.respond(
          `Failed to save: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
      return true;
    }

    default:
      return false;
  }
}
