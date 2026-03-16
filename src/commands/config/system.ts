import chalk from "chalk";
import type { ParsedArgs } from "../../cli/parse-args.js";
import { isHelp } from "../../cli/parse-args.js";
import { loadConfigWithPath } from "../../config/loader.js";
import { saveConfig } from "../../config/writer.js";

const ALLOWED_KEYS = ["maxRetries", "maxAgentIterations", "defaultModelTimeout"] as const;
type SystemKey = (typeof ALLOWED_KEYS)[number];

function printHelp(): void {
  console.log(`
${chalk.bold("crab-rave config system")} — Manage system settings

${chalk.yellow("USAGE")}
  crab-rave config system set <key> <value>

${chalk.yellow("KEYS")}
  maxRetries             Number of retry attempts on transient errors  (min: 1)
  maxAgentIterations     Max tool-use iterations per agent turn        (min: 1)
  defaultModelTimeout    Seconds to wait for a model reply             (min: 1)

${chalk.yellow("EXAMPLES")}
  crab-rave config system set maxRetries 5
  crab-rave config system set maxAgentIterations 30
  crab-rave config system set defaultModelTimeout 120

${chalk.yellow("OPTIONS")}
  --config <path>   Config file to read/write
`);
}

function printCurrentValues(configPath: string): void {
  const { config } = loadConfigWithPath(configPath);
  console.log(chalk.bold("\nCurrent system settings:"));
  console.log(`  maxRetries:           ${config.loop.maxRetries}`);
  console.log(`  maxAgentIterations:   ${config.loop.maxAgentIterations}`);
  console.log(`  defaultModelTimeout:  ${config.loop.defaultModelTimeout ?? chalk.dim("not set")}`);
  console.log();
}

export async function runSystemCommand(args: ParsedArgs, configPath: string): Promise<void> {
  const sub = args.positionals[2];

  if (!sub || isHelp(args.flags)) {
    printHelp();
    printCurrentValues(configPath);
    return;
  }

  if (sub !== "set") {
    console.error(chalk.red(`Unknown system command: "${sub}". Only "set" is supported.`));
    printHelp();
    process.exit(1);
  }

  const key = args.positionals[3] as SystemKey | undefined;
  const valueStr = args.positionals[4];

  if (!key) {
    console.error(chalk.red(`Missing key. Valid keys: ${ALLOWED_KEYS.join(", ")}`));
    process.exit(1);
  }

  if (!ALLOWED_KEYS.includes(key)) {
    console.error(chalk.red(`Unknown key "${key}". Valid keys: ${ALLOWED_KEYS.join(", ")}`));
    process.exit(1);
  }

  if (valueStr === undefined) {
    console.error(chalk.red(`Missing value for "${key}"`));
    process.exit(1);
  }

  const value = parseInt(valueStr, 10);
  if (isNaN(value) || value < 1) {
    console.error(chalk.red(`Value must be a positive integer, got: "${valueStr}"`));
    process.exit(1);
  }

  const { config } = loadConfigWithPath(configPath);
  config.loop[key] = value;
  saveConfig(config, configPath);
  console.log(chalk.green(`${key} set to ${value}. Backup saved to ${configPath}.bak`));
}
