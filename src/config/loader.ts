import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import type { CrabRaveConfig, AgentDef, ModelDef, CommunicationDef, LoopConfig } from "./types.js";

export const DEFAULT_LOOP: LoopConfig = { maxRetries: 3, maxAgentIterations: 20 };

const DEFAULT_MODEL: ModelDef = { name: "claude-sonnet", type: "claude-cli", model: "sonnet" };
const DEFAULT_COMM: CommunicationDef = { name: "default", type: "cli" };
const DEFAULT_AGENT: AgentDef = {
  name: "default",
  model_name: "claude-sonnet",
  workfolder: "~/crabs/default",
  communication: "default",
};

export const BUILTIN_DEFAULT: CrabRaveConfig = {
  agents: [DEFAULT_AGENT],
  models: [DEFAULT_MODEL],
  communications: [DEFAULT_COMM],
  logFile: "./crab-rave.log",
  loop: DEFAULT_LOOP,
};

function validateConfig(config: CrabRaveConfig, source: string): void {
  // Must have a "default" agent
  const hasDefault = config.agents.some((a) => a.name === "default");
  if (!hasDefault) {
    throw new Error(`Invalid config (${source}): missing required "default" agent`);
  }

  // Every agent must reference a known model and communication
  const modelNames = new Set(config.models.map((m) => m.name));
  const commNames = new Set(config.communications.map((c) => c.name));

  for (const agent of config.agents) {
    if (!modelNames.has(agent.model_name)) {
      throw new Error(
        `Invalid config (${source}): agent "${agent.name}" references unknown model "${agent.model_name}"`,
      );
    }
    if (!commNames.has(agent.communication)) {
      throw new Error(
        `Invalid config (${source}): agent "${agent.name}" references unknown communication "${agent.communication}"`,
      );
    }
  }
}

function mergeConfig(base: CrabRaveConfig, override: Partial<CrabRaveConfig>): CrabRaveConfig {
  return {
    agents: override.agents ?? base.agents,
    models: override.models ?? base.models,
    communications: override.communications ?? base.communications,
    logFile: override.logFile ?? base.logFile,
    loop: { ...base.loop, ...override.loop },
  };
}

export function loadConfig(configPath?: string): CrabRaveConfig {
  const candidates = [
    configPath,
    resolve("./crab-rave.config.json"),
    join(homedir(), ".config", "crab-rave", "config.json"),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const raw = readFileSync(candidate, "utf-8");
      const parsed = JSON.parse(raw) as Partial<CrabRaveConfig>;
      const merged = mergeConfig(BUILTIN_DEFAULT, parsed);
      validateConfig(merged, candidate);
      return merged;
    }
  }

  return BUILTIN_DEFAULT;
}

export function resolveAgent(config: CrabRaveConfig, agentName: string): AgentDef {
  const agent = config.agents.find((a) => a.name === agentName);
  if (!agent) {
    const names = config.agents.map((a) => a.name).join(", ");
    throw new Error(`Unknown agent "${agentName}". Available: ${names}`);
  }
  return agent;
}

export function resolveModel(config: CrabRaveConfig, modelName: string): ModelDef {
  const model = config.models.find((m) => m.name === modelName);
  if (!model) {
    const names = config.models.map((m) => m.name).join(", ");
    throw new Error(`Unknown model "${modelName}". Available: ${names}`);
  }
  return model;
}

export function resolveCommunication(config: CrabRaveConfig, commName: string): CommunicationDef {
  const comm = config.communications.find((c) => c.name === commName);
  if (!comm) {
    const names = config.communications.map((c) => c.name).join(", ");
    throw new Error(`Unknown communication "${commName}". Available: ${names}`);
  }
  return comm;
}

/** Returns the config file path that would be read/written for the given explicit path.
 *  Falls back to ./crab-rave.config.json as the default write target. */
export function findConfigPath(explicitPath?: string): string {
  if (explicitPath) return resolve(explicitPath);
  const local = resolve("./crab-rave.config.json");
  if (existsSync(local)) return local;
  const home = join(homedir(), ".config", "crab-rave", "config.json");
  if (existsSync(home)) return home;
  return local; // default write target when nothing exists yet
}

/** Load config from a specific path (or defaults). Also returns the resolved path. */
export function loadConfigWithPath(explicitPath?: string): { config: CrabRaveConfig; path: string } {
  const path = findConfigPath(explicitPath);
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CrabRaveConfig>;
    const config = mergeConfig(BUILTIN_DEFAULT, parsed);
    validateConfig(config, path);
    return { config, path };
  }
  return { config: { ...BUILTIN_DEFAULT, loop: { ...DEFAULT_LOOP } }, path };
}
