import chalk from "chalk";
import ora from "ora";
import type { ParsedArgs } from "../../cli/parse-args.js";
import { isHelp } from "../../cli/parse-args.js";
import { loadConfigWithPath } from "../../config/loader.js";
import { saveConfig } from "../../config/writer.js";
import { createModelConnection } from "../../models/model-selector-service.js";
import { Logger } from "../../logging/logger.js";
import type { ModelDef } from "../../config/types.js";

function printHelp(): void {
  console.log(`
${chalk.bold("crab-rave config models")} — Manage model connections

${chalk.yellow("USAGE")}
  crab-rave config models <command> [options]

${chalk.yellow("COMMANDS")}
  list                                List all configured models
  add  --name <n> --type <t>         Add a model
       [--model <id>] [--key <k>]
       [--url <url>]
  remove --name <n>                  Remove a model
  test   --name <n>                  Send a test message to verify connectivity

${chalk.yellow("MODEL TYPES")}
  claude-cli    Uses the local claude CLI
  claude-api    Calls the Anthropic API directly (requires --key or ANTHROPIC_API_KEY)
  ollama        Calls a local Ollama instance (requires --url, e.g. http://localhost:11434)
  openrouter    Routes through OpenRouter (requires --key or OPENROUTER_API_KEY)

${chalk.yellow("OPTIONS")}
  --config <path>   Config file to read/write
`);
}

function maskKey(key: string): string {
  if (key.length <= 14) return "***";
  return `${key.slice(0, 10)}...${key.slice(-4)}`;
}

export async function runModelsCommand(args: ParsedArgs, configPath: string): Promise<void> {
  const sub = args.positionals[2];

  if (!sub || isHelp(args.flags)) {
    printHelp();
    return;
  }

  switch (sub) {
    case "list":
      return modelsList(configPath);
    case "add":
      return modelsAdd(args, configPath);
    case "remove":
      return modelsRemove(args, configPath);
    case "test":
      return modelsTest(args, configPath);
    default:
      console.error(chalk.red(`Unknown models command: ${sub}`));
      printHelp();
      process.exit(1);
  }
}

function modelsList(configPath: string): void {
  const { config } = loadConfigWithPath(configPath);
  if (config.models.length === 0) {
    console.log(chalk.dim("No models configured."));
    return;
  }
  console.log(chalk.bold("\nModels:"));
  for (const m of config.models) {
    console.log(`  ${chalk.cyan(m.name)}`);
    console.log(`    type:  ${m.type}`);
    if (m.model) console.log(`    model: ${m.model}`);
    if (m.key) console.log(`    key:   ${maskKey(m.key)}`);
    if (m.url) console.log(`    url:   ${m.url}`);
  }
  console.log();
}

function modelsAdd(args: ParsedArgs, configPath: string): void {
  const { flags } = args;
  const name = flags["name"] as string | undefined;
  const type = flags["type"] as string | undefined;

  const missing: string[] = [];
  if (!name) missing.push("--name");
  if (!type) missing.push("--type");
  if (missing.length) {
    console.error(chalk.red(`Missing required flags: ${missing.join(", ")}`));
    process.exit(1);
  }

  if (type !== "claude-cli" && type !== "claude-api" && type !== "ollama" && type !== "openrouter") {
    console.error(chalk.red('--type must be "claude-cli", "claude-api", "ollama", or "openrouter"'));
    process.exit(1);
  }

  if (type === "ollama" && !flags["url"]) {
    console.error(chalk.red('--url is required for ollama type (e.g. http://localhost:11434)'));
    process.exit(1);
  }

  const { config } = loadConfigWithPath(configPath);

  if (config.models.some((m) => m.name === name)) {
    console.error(chalk.red(`Model "${name}" already exists. Remove it first.`));
    process.exit(1);
  }

  const newModel: ModelDef = {
    name: name!,
    type: type as ModelDef["type"],
    ...(flags["model"] ? { model: flags["model"] as string } : {}),
    ...(flags["key"] ? { key: flags["key"] as string } : {}),
    ...(flags["url"] ? { url: flags["url"] as string } : {}),
  };

  config.models.push(newModel);
  saveConfig(config, configPath);
  console.log(chalk.green(`Model "${name}" added.`));
}

function modelsRemove(args: ParsedArgs, configPath: string): void {
  const name = args.flags["name"] as string | undefined;
  if (!name) {
    console.error(chalk.red("Missing required flag: --name"));
    process.exit(1);
  }

  const { config } = loadConfigWithPath(configPath);
  const idx = config.models.findIndex((m) => m.name === name);
  if (idx === -1) {
    console.error(chalk.red(`Model "${name}" not found.`));
    process.exit(1);
  }

  const referencedBy = config.agents.filter((a) => a.model_name === name).map((a) => a.name);
  if (referencedBy.length) {
    console.error(
      chalk.red(`Cannot remove model "${name}" — referenced by agents: ${referencedBy.join(", ")}`),
    );
    process.exit(1);
  }

  if (config.models.length === 1) {
    console.error(chalk.red("Cannot remove the only model."));
    process.exit(1);
  }

  config.models.splice(idx, 1);
  saveConfig(config, configPath);
  console.log(chalk.green(`Model "${name}" removed. Backup saved to ${configPath}.bak`));
}

async function modelsTest(args: ParsedArgs, configPath: string): Promise<void> {
  const name = args.flags["name"] as string | undefined;
  if (!name) {
    console.error(chalk.red("Missing required flag: --name"));
    process.exit(1);
  }

  const { config } = loadConfigWithPath(configPath);
  const modelDef = config.models.find((m) => m.name === name);
  if (!modelDef) {
    console.error(chalk.red(`Model "${name}" not found.`));
    process.exit(1);
  }

  const logger = new Logger(config.logFile);
  const connection = createModelConnection(modelDef, logger);

  const spinner = ora({ text: `Testing model "${name}"…`, color: "cyan" }).start();
  try {
    await connection.connect();
    const ok = await connection.test();
    spinner.stop();
    if (ok) {
      console.log(chalk.green(`Model "${name}" — OK`));
    } else {
      console.log(chalk.red(`Model "${name}" — test failed (connection established but no valid response)`));
      process.exit(1);
    }
  } catch (err) {
    spinner.stop();
    console.error(chalk.red(`Model "${name}" — error: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}
