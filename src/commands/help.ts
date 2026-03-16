import chalk from "chalk";

export function printTopLevelHelp(): void {
  console.log(`
${chalk.bold("crab-rave")} — LLM agent loop CLI

${chalk.yellow("USAGE")}
  crab-rave <command> [options]

${chalk.yellow("COMMANDS")}
  ${chalk.cyan("instance run")}   Start the agent loop
  ${chalk.cyan("config")}         Manage agents, models, communications, system settings
  ${chalk.cyan("-h | --help")}    Show this help

${chalk.yellow("INSTANCE OPTIONS")}
  --config <path>     Config file path  (default: ./crab-rave.config.json)
  --agent  <name>     Agent to run      (default: "default")
  --verbose           Print per-loop token stats

${chalk.yellow("EXAMPLES")}
  crab-rave instance run
  crab-rave instance run --verbose --agent myagent
  crab-rave instance -h
  crab-rave config agents list
  crab-rave config models test --name mymodel
  crab-rave config system set maxRetries 5
`);
}
