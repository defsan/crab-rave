import type { ModelDef } from "../config/types.js";
import type { Logger } from "../logging/logger.js";
import type { BaseModelConnection } from "./base-model-connection.js";
import { ClaudeTokenModelConnection } from "./claude-token-model-connection.js";
import { AnthropicDirectModelConnection } from "./anthropic-direct-model-connection.js";
import { OllamaModelConnection } from "./ollama-model-connection.js";

export function createModelConnection(modelDef: ModelDef, logger: Logger): BaseModelConnection {
  const model = modelDef.model ?? "";

  if (modelDef.type === "claude-cli") {
    return new ClaudeTokenModelConnection(model, logger);
  }

  if (modelDef.type === "claude-api") {
    return new AnthropicDirectModelConnection(model, modelDef.key, logger);
  }

  if (modelDef.type === "ollama") {
    if (!modelDef.url) throw new Error(`Model "${modelDef.name}" is missing required "url" for ollama type`);
    return new OllamaModelConnection(model, modelDef.url, logger);
  }

  throw new Error(`Unsupported model type: ${(modelDef as ModelDef).type}`);
}
