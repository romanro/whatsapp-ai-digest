import type { AppConfig } from "../config.ts";
import { OpenAiCompatibleProvider } from "./openai-compatible.ts";
import type { AiProvider } from "./provider.ts";

export * from "./provider.ts";

export function createProvider(cfg: AppConfig["ai"]): AiProvider {
  return new OpenAiCompatibleProvider({
    name: cfg.provider,
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey,
    model: cfg.model,
    visionModel: cfg.visionModel,
  });
}
