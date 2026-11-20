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

export interface ModelStatus {
  available: boolean | null;
  message: string | null;
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  isConfigured(): boolean;
  /** Checks that the configured model is listed by the provider. */
  checkModel(): Promise<ModelStatus>;
  /** Returns the raw JSON string produced by the model. */
  completeJson(req: JsonCompletionRequest): Promise<string>;
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
