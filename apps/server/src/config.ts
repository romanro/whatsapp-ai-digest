import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import { BACKEND_PORT } from "@wad/shared";

const here = path.dirname(fileURLToPath(import.meta.url));
// Load apps/server/.env regardless of the current working directory (works from repo root on Windows too).
// The Windows installer keeps settings outside the program folder and passes their path in WAD_ENV_FILE.
loadDotenv({ path: process.env.WAD_ENV_FILE || path.resolve(here, "../.env"), quiet: true });

const PROVIDER_PRESETS = {
  // qwen/qwen3.8-27b is Groq's only image-capable model as of 2026-11-20 (a *preview* model — may change).
  groq: { baseURL: "https://api.groq.com/openai/v1", defaultModel: "openai/gpt-oss-120b", defaultVisionModel: "qwen/qwen3.8-27b" },
  openai: { baseURL: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini", defaultVisionModel: "gpt-4o-mini" },
  gemini: { baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", defaultModel: "gemini-2.0-flash", defaultVisionModel: "gemini-2.0-flash" },
  ollama: { baseURL: "http://127.0.0.1:11434/v1", defaultModel: "llama3.1", defaultVisionModel: null },
} as const;
export type ProviderName = keyof typeof PROVIDER_PRESETS;

const emptyToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const EnvSchema = z.object({
  AI_PROVIDER: z.preprocess(emptyToUndef, z.enum(["groq", "openai", "gemini", "ollama"]).default("groq")),
  GROQ_API_KEY: z.preprocess(emptyToUndef, z.string().optional()),
  GROQ_MODEL: z.preprocess(emptyToUndef, z.string().optional()),
  AI_API_KEY: z.preprocess(emptyToUndef, z.string().optional()),
  AI_BASE_URL: z.preprocess(emptyToUndef, z.url().optional()),
  AI_MODEL: z.preprocess(emptyToUndef, z.string().optional()),
  /** Image-capable model for photo analysis; "off" disables photo analysis. */
  VISION_MODEL: z.preprocess(emptyToUndef, z.string().optional()),
  PORT: z.preprocess(emptyToUndef, z.coerce.number().int().min(1).max(65535).default(BACKEND_PORT)),
  ALLOWED_EXTENSION_IDS: z.preprocess(emptyToUndef, z.string().default("fjldfeefkijllcoohbgfdodnkoeoedkg")),
  BATCH_MAX_CHARS: z.preprocess(emptyToUndef, z.coerce.number().int().min(2000).max(200_000).default(12_000)),
  LOG_LEVEL: z.preprocess(emptyToUndef, z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info")),
});

export interface AppConfig {
  host: "127.0.0.1";
  port: number;
  logLevel: string;
  allowedOrigins: string[];
  batchMaxChars: number;
  ai: {
    provider: ProviderName;
    baseURL: string;
    model: string;
    /** null = photo analysis disabled. */
    visionModel: string | null;
    apiKey: string | undefined;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const e = EnvSchema.parse(env);
  const preset = PROVIDER_PRESETS[e.AI_PROVIDER];
  const isGroq = e.AI_PROVIDER === "groq";
  const ids = e.ALLOWED_EXTENSION_IDS.split(",")
    .map((s) => s.trim())
    .filter((s) => /^[a-p]{32}$/.test(s));
  return {
    // Hard-coded loopback binding: this API must never be reachable from the network.
    host: "127.0.0.1",
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    allowedOrigins: ids.map((id) => `chrome-extension://${id}`),
    batchMaxChars: e.BATCH_MAX_CHARS,
    ai: {
      provider: e.AI_PROVIDER,
      baseURL: e.AI_BASE_URL ?? preset.baseURL,
      model: (isGroq ? e.GROQ_MODEL : e.AI_MODEL) ?? preset.defaultModel,
      visionModel: e.VISION_MODEL === "off" ? null : (e.VISION_MODEL ?? preset.defaultVisionModel),
      apiKey: isGroq ? e.GROQ_API_KEY : (e.AI_API_KEY ?? (e.AI_PROVIDER === "ollama" ? "ollama" : undefined)),
    },
  };
}
