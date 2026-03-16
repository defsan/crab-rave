import chalk from "chalk";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
import type { ParsedArgs } from "../cli/parse-args.js";
import { isHelp } from "../cli/parse-args.js";
import { loadConfig } from "../config/loader.js";
import { resolveAgent, resolveCommunication } from "../config/loader.js";
import { Logger } from "../logging/logger.js";
import { AgentRouter } from "../agent/agent-router.js";
import { startChat } from "../cli/chat.js";
import { startTelegramChat } from "../telegram/telegram-chat.js";

function printHelp(): void {
  console.log(`
${chalk.bold("crab-rave instance")} — Run an agent instance

${chalk.yellow("USAGE")}
  crab-rave instance run [options]

${chalk.yellow("COMMANDS")}
  run   Start the agent loop for the configured communication channel

${chalk.yellow("OPTIONS")}
  --config <path>   Config file path  (default: ./crab-rave.config.json)
  --agent  <name>   Primary agent to run (default: "default")
  --verbose         Print per-loop token stats
  --verbose2        Append each model prompt to prompts.log

${chalk.yellow("AGENT ROUTING")}
  Prefix any message with an agent name or alias to route it to that agent:
    myagent: do something
    fe: fix the button styles
  Without a prefix, messages go to the primary agent (--agent flag or "default").
`);
}

export async function runInstanceCommand(args: ParsedArgs): Promise<void> {
  const sub = args.positionals[1];

  if (!sub || isHelp(args.flags)) {
    printHelp();
    return;
  }

  if (sub !== "run") {
    console.error(chalk.red(`Unknown instance command: "${sub}"`));
    printHelp();
    process.exit(1);
  }

  const configPath = args.flags["config"] as string | undefined;
  const config = loadConfig(configPath);

  if (args.flags["verbose"] === true) config.loop.verbose = true;
  if (args.flags["verbose2"] === true) config.loop.promptLog = "./prompts.log";

  const logger = new Logger(config.logFile);

  const agentName = (args.flags["agent"] as string | undefined) ?? "default";
  const agentDef = resolveAgent(config, agentName);
  const commDef = resolveCommunication(config, agentDef.communication);

  const workfolderPath = resolve(agentDef.workfolder.replace(/^~/, homedir()));
  try {
    mkdirSync(workfolderPath, { recursive: true });
  } catch (err) {
    throw new Error(`Cannot create workfolder "${workfolderPath}": ${err instanceof Error ? err.message : String(err)}`);
  }

  logger.info("Starting Crab Rave", {
    agent: agentDef.name,
    communication: commDef.type,
    workfolder: agentDef.workfolder,
  });

  const router = new AgentRouter(config, logger);
  // Connect the primary agent upfront to catch config/auth errors early
  await router.connectAgent(agentName);

  if (commDef.type === "cli") {
    await startChat(router, agentName, logger, config.loop);
  } else if (commDef.type === "telegram") {
    if (!commDef.key) throw new Error(`Communication "${commDef.name}" requires a key (bot token)`);
    await startTelegramChat(commDef.key, commDef.chat_ids, router, agentName, logger, config.loop);
  } else {
    throw new Error(`Communication type "${(commDef as { type: string }).type}" is not implemented`);
  }
}
