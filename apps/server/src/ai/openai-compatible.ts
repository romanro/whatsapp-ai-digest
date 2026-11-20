import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError } from "openai";
import { AiError, type AiProvider, type JsonCompletionRequest, type ModelStatus, type VisionRequest } from "./provider.ts";

export interface OpenAiCompatibleOptions {
  name: string;
  baseURL: string;
  apiKey: string | undefined;
  model: string;
  visionModel?: string | null;
  /** Network retries for 408/409/429/5xx (the SDK applies exponential backoff and honours Retry-After). */
  maxRetries?: number;
  timeoutMs?: number;
}

/** Works with Groq, OpenAI, Gemini and Ollama through their OpenAI-compatible APIs. */
export class OpenAiCompatibleProvider implements AiProvider {
  readonly name: string;
  readonly model: string;
  readonly visionModel: string | null;
  private readonly client: OpenAI | null;
  private modelListCache: { at: number; ids: Set<string> } | null = null;

  constructor(private readonly opts: OpenAiCompatibleOptions) {
    this.name = opts.name;
    this.model = opts.model;
    this.visionModel = opts.visionModel ?? null;
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

  /** Model ids offered by the provider, cached for 10 minutes to avoid spending rate limit on health checks. */
  private async listModels(): Promise<Set<string>> {
    if (!this.client) throw new AiError("not_configured", "API-ключ не настроен.");
    if (this.modelListCache && Date.now() - this.modelListCache.at < 600_000) return this.modelListCache.ids;
    const ids = new Set<string>();
    for await (const m of this.client.models.list()) ids.add(m.id);
    this.modelListCache = { at: Date.now(), ids };
    return ids;
  }

  async checkModel(): Promise<ModelStatus> {
    if (!this.client) return { available: false, message: "API-ключ не настроен (GROQ_API_KEY в apps/server/.env)." };
    try {
      return (await this.listModels()).has(this.model)
        ? { available: true, message: null }
        : { available: false, message: `Модель «${this.model}» недоступна у провайдера. Укажите другую в GROQ_MODEL.` };
    } catch (err) {
      const mapped = mapError(err);
      return { available: mapped.code === "auth_failed" ? false : null, message: mapped.message };
    }
  }

  async checkVisionModel(): Promise<boolean | null> {
    if (!this.client || !this.visionModel) return null;
    try {
      return (await this.listModels()).has(this.visionModel);
    } catch {
      return null;
    }
  }

  async completeVisionJson(req: VisionRequest): Promise<string> {
    if (!this.client) throw new AiError("not_configured", "AI-провайдер не настроен: добавьте API-ключ в apps/server/.env.");
    if (!this.visionModel) throw new AiError("model_unavailable", "Анализ фото отключён (VISION_MODEL=off).");
    try {
      const res = await this.client.chat.completions.create({
        model: this.visionModel,
        messages: [
          { role: "system", content: req.system },
          {
            role: "user",
            content: [
              { type: "text", text: req.user },
              { type: "image_url", image_url: { url: req.imageDataUrl } },
            ],
          },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_completion_tokens: req.maxTokens,
      });
      const content = res.choices[0]?.message.content;
      if (!content) throw new AiError("invalid_output", "Модель не вернула описание фото.");
      return content;
    } catch (err) {
      throw mapError(err);
    }
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
      return new AiError(
        "rate_limited",
        "Превышен лимит запросов AI-провайдера (бесплатный тариф). Подождите минуту и повторите.",
        retryAfterSeconds(err),
      );
    }
    if (status === 404) return new AiError("model_unavailable", "Модель не найдена у провайдера. Проверьте GROQ_MODEL.");
    if (status === 413) return new AiError("request_too_large", "Запрос слишком большой для модели. Уменьшите BATCH_MAX_CHARS.");
    if (status === 400) return new AiError("provider_error", `Провайдер отклонил запрос (400): ${sanitize(err.message)}`);
    return new AiError("provider_error", `Ошибка AI-провайдера${status ? ` (${status})` : ""}. Попробуйте позже.`);
  }
  return new AiError("provider_error", "Не удалось связаться с AI-провайдером. Проверьте интернет-соединение.");
}

/** Seconds to wait from the Retry-After header or Groq's "Please try again in 1m2.5s" message. */
export function retryAfterSeconds(err: { headers?: { get?: (k: string) => string | null } | undefined; message?: string }): number | undefined {
  const header = Number(err.headers?.get?.("retry-after"));
  if (Number.isFinite(header) && header > 0) return header;
  const m = /try again in (?:(\d+)m)?([\d.]+)(ms|s)/i.exec(err.message ?? "");
  if (!m) return undefined;
  const value = Number(m[2]) / (m[3] === "ms" ? 1000 : 1) + Number(m[1] ?? 0) * 60;
  return Number.isFinite(value) ? value : undefined;
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
