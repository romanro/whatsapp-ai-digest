import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError } from "openai";
import { AiError, type AiProvider, type JsonCompletionRequest, type ModelStatus } from "./provider.ts";

export interface OpenAiCompatibleOptions {
  name: string;
  baseURL: string;
  apiKey: string | undefined;
  model: string;
  /** Network retries for 408/409/429/5xx (the SDK applies exponential backoff and honours Retry-After). */
  maxRetries?: number;
  timeoutMs?: number;
}

/** Works with Groq, OpenAI, Gemini and Ollama through their OpenAI-compatible APIs. */
export class OpenAiCompatibleProvider implements AiProvider {
  readonly name: string;
  readonly model: string;
  private readonly client: OpenAI | null;
  private modelStatusCache: { at: number; status: ModelStatus } | null = null;

  constructor(private readonly opts: OpenAiCompatibleOptions) {
    this.name = opts.name;
    this.model = opts.model;
    this.client = opts.apiKey
      ? new OpenAI({
          apiKey: opts.apiKey,
          baseURL: opts.baseURL,
          maxRetries: opts.maxRetries ?? 3,
          timeout: opts.timeoutMs ?? 90_000,
        })
      : null;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async checkModel(): Promise<ModelStatus> {
    if (!this.client) return { available: false, message: "API-ключ не настроен (GROQ_API_KEY в apps/server/.env)." };
    // Cache for 10 minutes to avoid spending rate limit on health checks.
    if (this.modelStatusCache && Date.now() - this.modelStatusCache.at < 600_000) return this.modelStatusCache.status;
    let status: ModelStatus;
    try {
      const ids: string[] = [];
      for await (const m of this.client.models.list()) ids.push(m.id);
      status = ids.includes(this.model)
        ? { available: true, message: null }
        : { available: false, message: `Модель «${this.model}» недоступна у провайдера. Укажите другую в GROQ_MODEL.` };
    } catch (err) {
      const mapped = mapError(err);
      status = { available: mapped.code === "auth_failed" ? false : null, message: mapped.message };
      // Don't cache transient failures.
      return status;
    }
    this.modelStatusCache = { at: Date.now(), status };
    return status;
  }

  async completeJson(req: JsonCompletionRequest): Promise<string> {
    if (!this.client) throw new AiError("not_configured", "AI-провайдер не настроен: добавьте API-ключ в apps/server/.env.");
    const isGptOss = this.model.startsWith("openai/gpt-oss");
    try {
      const res = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_completion_tokens: req.maxTokens,
        // gpt-oss models are reasoning models; low effort keeps token usage within free-tier limits.
        ...(isGptOss ? { reasoning_effort: "low" as const } : {}),
      });
      const choice = res.choices[0];
      const content = choice?.message.content;
      if (!content) {
        throw new AiError(
          "invalid_output",
          choice?.finish_reason === "length" ? "Модель не уложилась в лимит токенов ответа." : "Модель вернула пустой ответ.",
        );
      }
      return content;
    } catch (err) {
      throw mapError(err);
    }
  }
}

export function mapError(err: unknown): AiError {
  if (err instanceof AiError) return err;
  if (err instanceof APIConnectionTimeoutError) return new AiError("timeout", "AI-провайдер не ответил вовремя. Попробуйте ещё раз.");
  if (err instanceof APIConnectionError) {
    const code = causeCode(err);
    const tls = code !== null && /CERT|SSL|TLS/i.test(code);
    return new AiError(
      "provider_error",
      tls
        ? `Ошибка сертификата при подключении к AI-провайдеру (${code}). Вероятно, корпоративный прокси/антивирус проверяет HTTPS — запускайте сервер через «pnpm start» (использует системные сертификаты).`
        : `Нет соединения с AI-провайдером${code ? ` (${code})` : ""}. Проверьте интернет, прокси или VPN.`,
    );
  }
  if (err instanceof APIError) {
    const status = err.status;
    if (status === 401 || status === 403) return new AiError("auth_failed", "Неверный или отозванный API-ключ AI-провайдера.");
    if (status === 429) {
      const ra = Number(err.headers?.get?.("retry-after"));
      return new AiError(
        "rate_limited",
        "Превышен лимит запросов AI-провайдера (бесплатный тариф). Подождите минуту и повторите.",
        Number.isFinite(ra) ? ra : undefined,
      );
    }
    if (status === 404) return new AiError("model_unavailable", "Модель не найдена у провайдера. Проверьте GROQ_MODEL.");
    if (status === 413) return new AiError("request_too_large", "Запрос слишком большой для модели. Уменьшите BATCH_MAX_CHARS.");
    if (status === 400) return new AiError("provider_error", `Провайдер отклонил запрос (400): ${sanitize(err.message)}`);
    return new AiError("provider_error", `Ошибка AI-провайдера${status ? ` (${status})` : ""}. Попробуйте позже.`);
  }
  return new AiError("provider_error", "Не удалось связаться с AI-провайдером. Проверьте интернет-соединение.");
}

/** Finds a Node/undici error code (e.g. SELF_SIGNED_CERT_IN_CHAIN, ENOTFOUND) in the cause chain. */
function causeCode(err: unknown): string | null {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** Provider error messages could echo request content; keep them short. */
function sanitize(msg: string): string {
  return msg.slice(0, 200);
}
