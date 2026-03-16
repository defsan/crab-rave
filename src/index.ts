import { parseArgs } from "./cli/parse-args.js";
import { printTopLevelHelp } from "./commands/help.js";
import { runConfigCommand } from "./commands/config/index.js";
import { runInstanceCommand } from "./commands/instance.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Subcommands (each handles its own -h)
  if (args.positionals[0] === "config") {
    await runConfigCommand(args);
    return;
  }

  if (args.positionals[0] === "instance") {
    await runInstanceCommand(args);
    return;
  }

  // Default: help
  printTopLevelHelp();
}

main().catch((err) => {
  console.error("Fatal error:", err.message ?? err);
  process.exit(1);
});
