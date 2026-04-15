import type { CrabRaveConfig, AgentDef } from "../config/types.js";
import type { BaseModelConnection } from "../models/base-model-connection.js";
import type { Logger } from "../logging/logger.js";
import { createModelConnection } from "../models/model-selector-service.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { ExecTool } from "../tools/exec-tool.js";
import { FsTool } from "../tools/fs-tool.js";
import { WebTool } from "../tools/web-tool.js";
import { MemoryDb } from "../tools/memory-db.js";
import { RecallTool } from "../tools/recall-tool.js";
import { RememberTool } from "../tools/remember-tool.js";
import { loadAgentContext } from "./context-loader.js";

export interface ResolvedAgent {
  agentDef: AgentDef;
  connection: BaseModelConnection;
  toolRegistry: ToolRegistry;
  /** Context loaded from default_context config or auto-discovered AGENTS.md/AGENT.md, if present */
  context: string | undefined;
  /** The message with the agent prefix stripped, if one was present */
  message: string;
}

export class AgentRouter {
  private connections = new Map<string, BaseModelConnection>();
  private toolRegistries = new Map<string, ToolRegistry>();
  private memoryDbs = new Map<string, MemoryDb>();

  constructor(
    private config: CrabRaveConfig,
    private logger: Logger,
  ) {}

  /** Parse prefix and return the matching agent + cleaned message.
   *  Falls back to the "default" agent if no prefix matches. */
  async resolve(text: string, fallbackAgentName = "default"): Promise<ResolvedAgent> {
    const parsed = this.parsePrefix(text);
    const agentDef = parsed?.agentDef ?? this.requireAgent(fallbackAgentName);
    const message = parsed?.message ?? text;
    return this.buildResolved(agentDef, message);
  }

  getAgents(): AgentDef[] {
    return this.config.agents;
  }

  /** Connect the given agent (or default) upfront to catch config errors early. */
  async connectAgent(agentName = "default"): Promise<void> {
    const agentDef = this.requireAgent(agentName);
    const conn = this.getConnection(agentDef);
    if (conn.status() === "disconnected") {
      await conn.connect();
    }
  }

  private parsePrefix(text: string): { agentDef: AgentDef; message: string } | null {
    const colonIdx = text.indexOf(":");
    if (colonIdx === -1) return null;

    const prefix = text.slice(0, colonIdx).trim();
    const message = text.slice(colonIdx + 1).trimStart();
    if (!prefix || !message) return null;

    const agentDef = this.config.agents.find(
      (a) => a.name === prefix || (a.alias && a.alias === prefix),
    );
    if (!agentDef) return null;

    return { agentDef, message };
  }

  private requireAgent(name: string): AgentDef {
    const agentDef = this.config.agents.find((a) => a.name === name);
    if (!agentDef) throw new Error(`Agent "${name}" not found in config`);
    return agentDef;
  }

  private getConnection(agentDef: AgentDef): BaseModelConnection {
    if (!this.connections.has(agentDef.name)) {
      const modelDef = this.config.models.find((m) => m.name === agentDef.model_name);
      if (!modelDef) throw new Error(`Model "${agentDef.model_name}" not found in config`);
      this.connections.set(agentDef.name, createModelConnection(modelDef, this.logger));
    }
    return this.connections.get(agentDef.name)!;
  }

  private getToolRegistry(agentDef: AgentDef): ToolRegistry {
    if (!this.toolRegistries.has(agentDef.name)) {
      const registry = new ToolRegistry();
      registry.register(new ExecTool(agentDef.workfolder));
      registry.register(new FsTool(agentDef.workfolder));
      const webTool = new WebTool();
      registry.register(webTool);
      const memoryDb = new MemoryDb(agentDef.workfolder);
      this.memoryDbs.set(agentDef.name, memoryDb);
      registry.register(new RecallTool(memoryDb, webTool));
      registry.register(new RememberTool(memoryDb, agentDef.workfolder));
      this.toolRegistries.set(agentDef.name, registry);
    }
    return this.toolRegistries.get(agentDef.name)!;
  }

  private async buildResolved(agentDef: AgentDef, message: string): Promise<ResolvedAgent> {
    const connection = this.getConnection(agentDef);
    if (connection.status() === "disconnected") {
      await connection.connect();
    }
    return {
      agentDef,
      connection,
      toolRegistry: this.getToolRegistry(agentDef),
      context: loadAgentContext(agentDef),
      message,
    };
  }
}
