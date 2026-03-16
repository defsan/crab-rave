import chalk from "chalk";
import type { ParsedArgs } from "../../cli/parse-args.js";
import { isHelp } from "../../cli/parse-args.js";
import { findConfigPath } from "../../config/loader.js";
import { runAgentsCommand } from "./agents.js";
import { runModelsCommand } from "./models.js";
import { runCommunicationsCommand } from "./communications.js";
import { runSystemCommand } from "./system.js";

function printHelp(): void {
  console.log(`
${chalk.bold("crab-rave config")} — Manage configuration

${chalk.yellow("USAGE")}
  crab-rave config <subcommand> [options]

${chalk.yellow("SUBCOMMANDS")}
  agents          Manage agents              (crab-rave config agents -h)
  models          Manage model connections   (crab-rave config models -h)
  communications  Manage channels            (crab-rave config communications -h)
  system          Manage system settings     (crab-rave config system -h)

${chalk.yellow("OPTIONS")}
  --config <path>   Config file to read/write (default: ./crab-rave.config.json)
`);
}

export async function runConfigCommand(args: ParsedArgs): Promise<void> {
  const sub = args.positionals[1]; // positionals[0] === "config"
  const configPath = findConfigPath(args.flags["config"] as string | undefined);

  if (!sub) {
    printHelp();
    return;
  }

  switch (sub) {
    case "agents":
      return runAgentsCommand(args, configPath);
    case "models":
      return runModelsCommand(args, configPath);
    case "communications":
      return runCommunicationsCommand(args, configPath);
    case "system":
      return runSystemCommand(args, configPath);
    default:
      console.error(chalk.red(`Unknown config subcommand: "${sub}"`));
      printHelp();
      process.exit(1);
  }
}
