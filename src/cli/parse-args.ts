export interface ParsedArgs {
  /** Non-flag arguments in order, e.g. ["config", "agents", "list"] */
  positionals: string[];
  /** --key value  →  flags.key = "value"
   *  --flag       →  flags.flag = true
   *  -h           →  flags.h = true */
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i++;
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      flags[arg.slice(1)] = true;
      i++;
    } else {
      positionals.push(arg);
      i++;
    }
  }

  return { positionals, flags };
}

export function isHelp(flags: Record<string, string | boolean>): boolean {
  return flags["h"] === true || flags["help"] === true;
}
