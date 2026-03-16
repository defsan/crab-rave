import chalk from "chalk";
import ora from "ora";
import type { ParsedArgs } from "../../cli/parse-args.js";
import { isHelp } from "../../cli/parse-args.js";
import { loadConfigWithPath } from "../../config/loader.js";
import { saveConfig } from "../../config/writer.js";
import { createModelConnection } from "../../models/model-selector-service.js";
import { Logger } from "../../logging/logger.js";
import type { AgentDef } from "../../config/types.js";

function printHelp(): void {
  console.log(`
${chalk.bold("crab-rave config agents")} — Manage agents

${chalk.yellow("USAGE")}
  crab-rave config agents <command> [options]

${chalk.yellow("COMMANDS")}
  list                           List all configured agents
  add    --name <n> --model-name <m> --communication <c> --workfolder <f>
         [--alias <a>]           Add a new agent
  set    <agent> <key>=<value>   Set a specific key on an agent
  remove --name <n>              Remove an agent
  ping   --name <n> [--message <msg>]
                                 Send a message to an agent and print the reply

${chalk.yellow("SETTABLE KEYS")}
  alias, model_name, communication, workfolder, default_context
  Values are parsed as JSON when applicable, e.g. default_context=["AGENT.md","SOUL.md"]

${chalk.yellow("OPTIONS")}
  --config <path>   Config file to read/write
`);
}

export async function runAgentsCommand(args: ParsedArgs, configPath: string): Promise<void> {
  const sub = args.positionals[2];

  if (!sub || isHelp(args.flags)) {
    printHelp();
    return;
  }

  switch (sub) {
    case "list":
      return agentsList(configPath);
    case "add":
      return agentsAdd(args, configPath);
    case "set":
      return agentsSet(args, configPath);
    case "remove":
      return agentsRemove(args, configPath);
    case "ping":
      return agentsPing(args, configPath);
    default:
      console.error(chalk.red(`Unknown agents command: ${sub}`));
      printHelp();
      process.exit(1);
  }
}

function agentsList(configPath: string): void {
  const { config } = loadConfigWithPath(configPath);
  if (config.agents.length === 0) {
    console.log(chalk.dim("No agents configured."));
    return;
  }
  console.log(chalk.bold("\nAgents:"));
  for (const a of config.agents) {
    const tag = a.name === "default" ? chalk.green(" (default)") : "";
    const aliasTag = a.alias ? chalk.dim(` alias: ${a.alias}`) : "";
    console.log(`  ${chalk.cyan(a.name)}${tag}${aliasTag}`);
    console.log(`    model:         ${a.model_name}`);
    console.log(`    communication: ${a.communication}`);
    console.log(`    workfolder:    ${a.workfolder}`);
  }
  console.log();
}

function agentsAdd(args: ParsedArgs, configPath: string): void {
  const { flags } = args;
  const name = flags["name"] as string | undefined;
  const modelName = flags["model-name"] as string | undefined;
  const communication = flags["communication"] as string | undefined;
  const workfolder = flags["workfolder"] as string | undefined;

  const missing: string[] = [];
  if (!name) missing.push("--name");
  if (!modelName) missing.push("--model-name");
  if (!communication) missing.push("--communication");
  if (!workfolder) missing.push("--workfolder");
  if (missing.length) {
    console.error(chalk.red(`Missing required flags: ${missing.join(", ")}`));
    process.exit(1);
  }

  const { config } = loadConfigWithPath(configPath);

  if (config.agents.some((a) => a.name === name)) {
    console.error(chalk.red(`Agent "${name}" already exists. Remove it first.`));
    process.exit(1);
  }

  const alias = flags["alias"] as string | undefined;
  const newAgent: AgentDef = {
    name: name!,
    ...(alias ? { alias } : {}),
    model_name: modelName!,
    communication: communication!,
    workfolder: workfolder!,
  };

  config.agents.push(newAgent);
  saveConfig(config, configPath);
  console.log(chalk.green(`Agent "${name}" added.`));
}

const SETTABLE_KEYS = new Set(["alias", "model_name", "communication", "workfolder", "default_context"]);

function agentsSet(args: ParsedArgs, configPath: string): void {
  const agentName = args.positionals[3];
  const kvRaw = args.positionals[4];

  if (!agentName || !kvRaw) {
    console.error(chalk.red("Usage: crab-rave config agents set <agent> <key>=<value>"));
    process.exit(1);
  }

  const eqIdx = kvRaw.indexOf("=");
  if (eqIdx === -1) {
    console.error(chalk.red(`Invalid format "${kvRaw}" — expected key=value`));
    process.exit(1);
  }

  const key = kvRaw.slice(0, eqIdx).trim();
  const rawValue = kvRaw.slice(eqIdx + 1).trim();

  if (!SETTABLE_KEYS.has(key)) {
    console.error(chalk.red(`Unknown key "${key}". Settable keys: ${[...SETTABLE_KEYS].join(", ")}`));
    process.exit(1);
  }

  // Parse value: try JSON first, fall back to plain string
  let value: unknown;
  try {
    value = JSON.parse(rawValue);
  } catch {
    value = rawValue;
  }

  const { config } = loadConfigWithPath(configPath);
  const agent = config.agents.find((a) => a.name === agentName);
  if (!agent) {
    console.error(chalk.red(`Agent "${agentName}" not found.`));
    process.exit(1);
  }

  (agent as unknown as Record<string, unknown>)[key] = value;
  saveConfig(config, configPath);
  console.log(chalk.green(`Agent "${agentName}" updated: ${key} = ${JSON.stringify(value)}`));
}

function agentsRemove(args: ParsedArgs, configPath: string): void {
  const name = args.flags["name"] as string | undefined;
  if (!name) {
    console.error(chalk.red("Missing required flag: --name"));
    process.exit(1);
  }

  const { config } = loadConfigWithPath(configPath);
  const idx = config.agents.findIndex((a) => a.name === name);
  if (idx === -1) {
    console.error(chalk.red(`Agent "${name}" not found.`));
    process.exit(1);
  }
  if (config.agents.length === 1) {
    console.error(chalk.red("Cannot remove the only agent."));
    process.exit(1);
  }

  config.agents.splice(idx, 1);
  saveConfig(config, configPath);
  console.log(chalk.green(`Agent "${name}" removed. Backup saved to ${configPath}.bak`));
}

async function agentsPing(args: ParsedArgs, configPath: string): Promise<void> {
  const name = (args.flags["name"] as string | undefined) ?? "default";
  const message = (args.flags["message"] as string | undefined) ?? "ping";

  const { config } = loadConfigWithPath(configPath);
  const agentDef = config.agents.find((a) => a.name === name);
  if (!agentDef) {
    console.error(chalk.red(`Agent "${name}" not found.`));
    process.exit(1);
  }

  const modelDef = config.models.find((m) => m.name === agentDef.model_name);
  if (!modelDef) {
    console.error(chalk.red(`Model "${agentDef.model_name}" not found in config.`));
    process.exit(1);
  }

  const logger = new Logger(config.logFile);
  const connection = createModelConnection(modelDef, logger);

  const spinner = ora({ text: `Pinging agent "${name}"…`, color: "cyan" }).start();
  try {
    await connection.connect();
    const response = await connection.prompt(
      [{ role: "user", content: message }],
      "You are a helpful assistant.",
    );
    spinner.stop();
    console.log(chalk.bold(`\nAgent "${name}" replied:`));
    console.log(response.text);
    console.log();
  } catch (err) {
    spinner.stop();
    console.error(chalk.red(`Ping failed: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}
