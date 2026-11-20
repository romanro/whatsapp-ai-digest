/**
 * AI provider abstraction. The summarizer only depends on this interface, so Groq can be swapped
 * for OpenAI, Gemini or Ollama (all expose OpenAI-compatible chat completion endpoints) or for a fake in tests.
 */

export interface JsonCompletionRequest {
  system: string;
  user: string;
  /** Upper bound for generated tokens (including reasoning tokens on reasoning models). */
  maxTokens: number;
}

export interface VisionRequest {
  system: string;
  /** Short instruction/context placed next to the image. */
  user: string;
  imageDataUrl: string;
  maxTokens: number;
}

export interface ModelStatus {
  available: boolean | null;
  message: string | null;
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  /** Image-capable model, or null when photo analysis is disabled. */
  readonly visionModel: string | null;
  isConfigured(): boolean;
  /** Checks that the configured model is listed by the provider. */
  checkModel(): Promise<ModelStatus>;
  /** Checks that the vision model is listed (null = unknown / not configured). */
  checkVisionModel(): Promise<boolean | null>;
  /** Returns the raw JSON string produced by the model. */
  completeJson(req: JsonCompletionRequest): Promise<string>;
  /** Returns the raw JSON string produced by the vision model for one image. */
  completeVisionJson(req: VisionRequest): Promise<string>;
}

export type AiErrorCode =
  | "not_configured"
  | "auth_failed"
  | "rate_limited"
  | "model_unavailable"
  | "request_too_large"
  | "provider_error"
  | "timeout"
  | "invalid_output";

export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "AiError";
  }
}
