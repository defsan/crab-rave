import chalk from "chalk";
import ora from "ora";
import type { ParsedArgs } from "../../cli/parse-args.js";
import { isHelp } from "../../cli/parse-args.js";
import { loadConfigWithPath } from "../../config/loader.js";
import { saveConfig } from "../../config/writer.js";
import { getMe } from "../../telegram/telegram-client.js";
import type { CommunicationDef } from "../../config/types.js";

function printHelp(): void {
  console.log(`
${chalk.bold("crab-rave config communications")} — Manage communication channels

${chalk.yellow("USAGE")}
  crab-rave config communications <command> [options]

${chalk.yellow("COMMANDS")}
  list                              List all configured communications
  add  --name <n> --type <t>       Add a communication channel
       [--key <k>] [--chat-ids <id1,id2>]
  remove --name <n>                Remove a communication channel
  test   --name <n>                Verify the communication channel works

${chalk.yellow("COMMUNICATION TYPES")}
  cli       Standard input/output (always available, no key required)
  telegram  Telegram bot (requires --key with a bot token)

${chalk.yellow("OPTIONS")}
  --config <path>   Config file to read/write
`);
}

export async function runCommunicationsCommand(args: ParsedArgs, configPath: string): Promise<void> {
  const sub = args.positionals[2];

  if (!sub || isHelp(args.flags)) {
    printHelp();
    return;
  }

  switch (sub) {
    case "list":
      return commsList(configPath);
    case "add":
      return commsAdd(args, configPath);
    case "remove":
      return commsRemove(args, configPath);
    case "test":
      return commsTest(args, configPath);
    default:
      console.error(chalk.red(`Unknown communications command: ${sub}`));
      printHelp();
      process.exit(1);
  }
}

function commsList(configPath: string): void {
  const { config } = loadConfigWithPath(configPath);
  if (config.communications.length === 0) {
    console.log(chalk.dim("No communications configured."));
    return;
  }
  console.log(chalk.bold("\nCommunications:"));
  for (const c of config.communications) {
    console.log(`  ${chalk.cyan(c.name)}`);
    console.log(`    type: ${c.type}`);
    if (c.key) console.log(`    key:  ${c.key.slice(0, 6)}...`);
    if (c.chat_ids?.length) console.log(`    chat_ids: ${c.chat_ids.join(", ")}`);
  }
  console.log();
}

function commsAdd(args: ParsedArgs, configPath: string): void {
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

  if (type !== "cli" && type !== "telegram") {
    console.error(chalk.red('--type must be "cli" or "telegram"'));
    process.exit(1);
  }

  if (type === "telegram" && !flags["key"]) {
    console.error(chalk.red("Telegram communication requires --key <bot_token>"));
    process.exit(1);
  }

  const { config } = loadConfigWithPath(configPath);

  if (config.communications.some((c) => c.name === name)) {
    console.error(chalk.red(`Communication "${name}" already exists. Remove it first.`));
    process.exit(1);
  }

  const chatIdsRaw = flags["chat-ids"] as string | undefined;
  const chatIds = chatIdsRaw
    ? chatIdsRaw.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n))
    : undefined;

  const newComm: CommunicationDef = {
    name: name!,
    type: type as CommunicationDef["type"],
    ...(flags["key"] ? { key: flags["key"] as string } : {}),
    ...(chatIds?.length ? { chat_ids: chatIds } : {}),
  };

  config.communications.push(newComm);
  saveConfig(config, configPath);
  console.log(chalk.green(`Communication "${name}" added.`));
}

function commsRemove(args: ParsedArgs, configPath: string): void {
  const name = args.flags["name"] as string | undefined;
  if (!name) {
    console.error(chalk.red("Missing required flag: --name"));
    process.exit(1);
  }

  const { config } = loadConfigWithPath(configPath);
  const idx = config.communications.findIndex((c) => c.name === name);
  if (idx === -1) {
    console.error(chalk.red(`Communication "${name}" not found.`));
    process.exit(1);
  }

  const referencedBy = config.agents.filter((a) => a.communication === name).map((a) => a.name);
  if (referencedBy.length) {
    console.error(
      chalk.red(
        `Cannot remove communication "${name}" — referenced by agents: ${referencedBy.join(", ")}`,
      ),
    );
    process.exit(1);
  }

  if (config.communications.length === 1) {
    console.error(chalk.red("Cannot remove the only communication channel."));
    process.exit(1);
  }

  config.communications.splice(idx, 1);
  saveConfig(config, configPath);
  console.log(chalk.green(`Communication "${name}" removed. Backup saved to ${configPath}.bak`));
}

async function commsTest(args: ParsedArgs, configPath: string): Promise<void> {
  const name = args.flags["name"] as string | undefined;
  if (!name) {
    console.error(chalk.red("Missing required flag: --name"));
    process.exit(1);
  }

  const { config } = loadConfigWithPath(configPath);
  const commDef = config.communications.find((c) => c.name === name);
  if (!commDef) {
    console.error(chalk.red(`Communication "${name}" not found.`));
    process.exit(1);
  }

  if (commDef.type === "cli") {
    console.log(chalk.green(`Communication "${name}" (cli) — OK (always available)`));
    return;
  }

  if (commDef.type === "telegram") {
    if (!commDef.key) {
      console.error(chalk.red(`Communication "${name}" has no bot token key.`));
      process.exit(1);
    }
    const spinner = ora({ text: `Testing Telegram bot "${name}"…`, color: "cyan" }).start();
    try {
      const bot = await getMe(commDef.key);
      spinner.stop();
      console.log(
        chalk.green(`Communication "${name}" (telegram) — OK`),
        chalk.dim(`→ @${bot.username} (id: ${bot.id})`),
      );
    } catch (err) {
      spinner.stop();
      console.error(
        chalk.red(`Communication "${name}" — error: ${err instanceof Error ? err.message : String(err)}`),
      );
      process.exit(1);
    }
  }
}
