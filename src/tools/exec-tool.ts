import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { BaseTool, type ToolSchema } from "./base-tool.js";

function expandPath(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Unconditionally blocked regardless of paths
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /:\(\)\s*\{[^}]*\}\s*;?\s*:/, reason: "fork bomb" },
  { pattern: /\bdd\b[^|&;\n]*\bof\s*=\s*\/dev\/[a-z]/, reason: "direct disk write via dd" },
  { pattern: /\bmkfs\b/, reason: "filesystem formatting" },
  { pattern: /\b(shred|wipe|scrub)\b[^|&;\n]*\/dev\//, reason: "disk wiping command targeting a device" },
];

// Absolute path prefixes that are safe system read/execute locations.
// Paths under these are the *tools being invoked*, not file targets — they bypass
// the home/tmp zone check.
const EXEC_ONLY_PREFIXES = [
  "/usr/",
  "/bin/",
  "/sbin/",
  "/lib/",
  "/lib64/",
  "/opt/",
  "/dev/null",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/proc/",
];

function isInExecOnlyZone(resolved: string): boolean {
  return EXEC_ONLY_PREFIXES.some(
    (prefix) => resolved === prefix.replace(/\/$/, "") || resolved.startsWith(prefix),
  );
}

function isPathAllowed(raw: string): boolean {
  // Expand ~ to home
  const expanded = raw.startsWith("~/")
    ? path.join(os.homedir(), raw.slice(2))
    : raw === "~"
      ? os.homedir()
      : raw;

  const resolved = path.resolve(expanded);
  const home = os.homedir();

  if (resolved === "/tmp" || resolved.startsWith("/tmp/")) return true;
  if (resolved === home || resolved.startsWith(home + "/")) return true;
  if (isInExecOnlyZone(resolved)) return true;

  return false;
}

function extractAbsolutePaths(command: string): string[] {
  const found = new Set<string>();

  // Quoted absolute paths: "/some/path" or '/some/path'
  for (const m of command.matchAll(/["'](\/[^"']+)["']/g)) {
    found.add(m[1]);
  }

  // Unquoted absolute paths and ~ paths — stop at shell metacharacters
  for (const m of command.matchAll(/(?<![a-zA-Z0-9_])(~\/[^\s"'|&;<>()\\,]+|\/[^\s"'|&;<>()\\,]+)/g)) {
    const p = m[1].replace(/[;,)]+$/, ""); // strip trailing punctuation artifacts
    if (p.length > 1) found.add(p);
  }

  return [...found];
}

function validateCommand(command: string): string | null {
  // Layer 1: pattern blocklist
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return `Blocked: ${reason}`;
    }
  }

  // Layer 2: path zone check
  const paths = extractAbsolutePaths(command);
  for (const p of paths) {
    if (!isPathAllowed(p)) {
      return `Blocked: path "${p}" resolves outside allowed zones (/tmp, $HOME)`;
    }
  }

  return null;
}

export class ExecTool extends BaseTool {
  private cwd: string | undefined;

  constructor(workfolder?: string) {
    super();
    this.cwd = workfolder ? expandPath(workfolder) : undefined;
  }

  name(): string {
    return "exec";
  }

  toolDescription(): string {
    return [
      "Execute a shell command and return the output.",
      'Expects a JSON argument: {"command": "your shell command here"}',
      "Returns stdout, stderr, and exit code.",
      `File operations are restricted to /tmp and the user's home directory.`,
      ...(this.cwd ? [`Working directory: ${this.cwd}`] : []),
    ].join("\n");
  }

  toolSchema(): ToolSchema {
    const description = [
      "Execute a shell command and return stdout, stderr, and exit code.",
      "File operations are restricted to /tmp and the user's home directory.",
      ...(this.cwd ? [`Working directory: ${this.cwd}`] : []),
    ].join(" ");

    return {
      type: "function",
      function: {
        name: this.name(),
        description,
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "The shell command to execute",
            },
          },
          required: ["command"],
        },
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const command = args.command as string;
    if (!command || typeof command !== "string") {
      return "Error: missing or invalid 'command' argument";
    }

    const blocked = validateCommand(command);
    if (blocked) {
      return `Error: ${blocked}`;
    }

    try {
      const stdout = execSync(command, {
        encoding: "utf-8",
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
        ...(this.cwd ? { cwd: this.cwd } : {}),
      });
      return `Exit code: 0\nStdout:\n${stdout}`;
    } catch (err: unknown) {
      const execErr = err as {
        status?: number;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      const exitCode = execErr.status ?? 1;
      const stdout = execErr.stdout ?? "";
      const stderr = execErr.stderr ?? "";
      return `Exit code: ${exitCode}\nStdout:\n${stdout}\nStderr:\n${stderr}`;
    }
  }
}
