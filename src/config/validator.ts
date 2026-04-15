import type { CrabRaveConfig } from "./types.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateConfig(config: unknown): ValidationResult {
  const errors: string[] = [];

  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return { valid: false, errors: ["Config must be a JSON object"] };
  }

  const c = config as Record<string, unknown>;

  // logFile
  if (typeof c.logFile !== "string" || !c.logFile) {
    errors.push("logFile must be a non-empty string");
  }

  // loop
  if (typeof c.loop !== "object" || c.loop === null || Array.isArray(c.loop)) {
    errors.push("loop must be an object");
  } else {
    const loop = c.loop as Record<string, unknown>;
    if (!Number.isInteger(loop.maxRetries) || (loop.maxRetries as number) < 1) {
      errors.push("loop.maxRetries must be a positive integer");
    }
    if (!Number.isInteger(loop.maxAgentIterations) || (loop.maxAgentIterations as number) < 1) {
      errors.push("loop.maxAgentIterations must be a positive integer");
    }
    if (loop.defaultModelTimeout !== undefined) {
      if (!Number.isInteger(loop.defaultModelTimeout) || (loop.defaultModelTimeout as number) < 1) {
        errors.push("loop.defaultModelTimeout must be a positive integer (seconds)");
      }
    }
  }

  // models
  const modelNames = new Set<string>();
  if (!Array.isArray(c.models) || c.models.length === 0) {
    errors.push("models must be a non-empty array");
  } else {
    for (let i = 0; i < c.models.length; i++) {
      const m = c.models[i] as Record<string, unknown>;
      if (typeof m.name !== "string" || !m.name) {
        errors.push(`models[${i}].name must be a non-empty string`);
      } else {
        if (modelNames.has(m.name)) errors.push(`models[${i}]: duplicate name "${m.name}"`);
        modelNames.add(m.name);
      }
      if (m.type !== "claude-cli" && m.type !== "claude-api" && m.type !== "ollama" && m.type !== "openrouter") {
        errors.push(`models[${i}].type must be "claude-cli", "claude-api", "ollama", or "openrouter"`);
      }
      if (m.model !== undefined && typeof m.model !== "string") {
        errors.push(`models[${i}].model must be a string if provided`);
      }
      if (m.key !== undefined && typeof m.key !== "string") {
        errors.push(`models[${i}].key must be a string if provided`);
      }
    }
  }

  // communications
  const commNames = new Set<string>();
  if (!Array.isArray(c.communications) || c.communications.length === 0) {
    errors.push("communications must be a non-empty array");
  } else {
    for (let i = 0; i < c.communications.length; i++) {
      const cm = c.communications[i] as Record<string, unknown>;
      if (typeof cm.name !== "string" || !cm.name) {
        errors.push(`communications[${i}].name must be a non-empty string`);
      } else {
        if (commNames.has(cm.name)) errors.push(`communications[${i}]: duplicate name "${cm.name}"`);
        commNames.add(cm.name);
      }
      if (cm.type !== "cli" && cm.type !== "telegram") {
        errors.push(`communications[${i}].type must be "cli" or "telegram"`);
      }
      if (cm.type === "telegram" && (typeof cm.key !== "string" || !cm.key)) {
        errors.push(`communications[${i}]: telegram requires a non-empty key`);
      }
      if (cm.chat_ids !== undefined) {
        if (
          !Array.isArray(cm.chat_ids) ||
          (cm.chat_ids as unknown[]).some((id) => typeof id !== "number")
        ) {
          errors.push(`communications[${i}].chat_ids must be an array of numbers`);
        }
      }
    }
  }

  // agents
  if (!Array.isArray(c.agents) || c.agents.length === 0) {
    errors.push("agents must be a non-empty array");
  } else {
    const agentNames = new Set<string>();
    const agentAliases = new Set<string>();
    let hasDefault = false;
    for (let i = 0; i < c.agents.length; i++) {
      const a = c.agents[i] as Record<string, unknown>;
      if (typeof a.name !== "string" || !a.name) {
        errors.push(`agents[${i}].name must be a non-empty string`);
      } else {
        if (agentNames.has(a.name)) errors.push(`agents[${i}]: duplicate name "${a.name}"`);
        agentNames.add(a.name);
        if (a.name === "default") hasDefault = true;
      }
      if (a.alias !== undefined) {
        if (typeof a.alias !== "string" || !a.alias) {
          errors.push(`agents[${i}].alias must be a non-empty string if provided`);
        } else {
          if (agentAliases.has(a.alias)) errors.push(`agents[${i}]: duplicate alias "${a.alias}"`);
          agentAliases.add(a.alias);
        }
      }
      if (typeof a.model_name !== "string" || !modelNames.has(a.model_name as string)) {
        errors.push(`agents[${i}].model_name "${a.model_name}" references unknown model`);
      }
      if (typeof a.communication !== "string" || !commNames.has(a.communication as string)) {
        errors.push(`agents[${i}].communication "${a.communication}" references unknown communication`);
      }
      if (typeof a.workfolder !== "string" || !a.workfolder) {
        errors.push(`agents[${i}].workfolder must be a non-empty string`);
      }
      if (a.default_context !== undefined) {
        if (!Array.isArray(a.default_context) || a.default_context.some((f) => typeof f !== "string")) {
          errors.push(`agents[${i}].default_context must be an array of strings`);
        }
      }
    }
    if (!hasDefault) errors.push('agents must include an entry named "default"');
  }

  return { valid: errors.length === 0, errors };
}

export function assertValidConfig(config: unknown, source: string): asserts config is CrabRaveConfig {
  const result = validateConfig(config);
  if (!result.valid) {
    throw new Error(
      `Invalid config (${source}):\n${result.errors.map((e) => `  • ${e}`).join("\n")}`,
    );
  }
}
