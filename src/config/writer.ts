import { writeFileSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import type { CrabRaveConfig } from "./types.js";
import { assertValidConfig } from "./validator.js";

export function saveConfig(config: CrabRaveConfig, configPath: string): void {
  assertValidConfig(config, "pending save");

  // Backup existing file
  if (existsSync(configPath)) {
    const existing = readFileSync(configPath, "utf-8");
    writeFileSync(configPath + ".bak", existing);
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}
