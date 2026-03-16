import { appendFileSync } from "node:fs";

export type LogLevel = "info" | "error" | "debug";

interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  data?: unknown;
}

export class Logger {
  constructor(private logFile: string) {}

  private write(level: LogLevel, msg: string, data?: unknown): void {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      msg,
    };
    if (data !== undefined) {
      entry.data = data;
    }
    appendFileSync(this.logFile, JSON.stringify(entry) + "\n");
  }

  info(msg: string, data?: unknown): void {
    this.write("info", msg, data);
  }

  error(msg: string, data?: unknown): void {
    this.write("error", msg, data);
  }

  debug(msg: string, data?: unknown): void {
    this.write("debug", msg, data);
  }
}
