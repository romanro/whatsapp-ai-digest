import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { HealthResponseSchema, SummarizeRequestSchema, type ErrorResponse, type HealthResponse } from "@wad/shared";
import type { AppConfig } from "./config.ts";
import { AiError, type AiProvider } from "./ai/provider.ts";
import { summarize } from "./summarizer.ts";

export const VERSION = "0.1.0";
// Text (LIMITS.maxTotalChars, 2 bytes/char for Hebrew/Cyrillic) + up to LIMITS.maxImages compressed photos.
const BODY_LIMIT = 16_000_000;

const AI_ERROR_STATUS: Record<AiError["code"], number> = {
  not_configured: 503,
  auth_failed: 502,
  rate_limited: 429,
  model_unavailable: 502,
  request_too_large: 413,
  provider_error: 502,
  timeout: 504,
  invalid_output: 502,
};

const errorBody = (code: string, message: string): ErrorResponse => ({ error: { code, message } });

export function buildApp(config: AppConfig, provider: AiProvider): FastifyInstance {
  const app = Fastify({
    bodyLimit: BODY_LIMIT,
    logger: {
      level: config.logLevel,
      // Never log headers or bodies: they may contain message text. Only method/url/status are logged.
      serializers: {
        req: (req) => ({ method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      redact: ["req.headers", "headers.authorization", "*.apiKey", "*.text"],
    },
  });

  const allowed = new Set(config.allowedOrigins);

  // DNS-rebinding protection: only accept loopback Host headers.
  app.addHook("onRequest", async (req, reply) => {
    const host = (req.headers.host ?? "").toLowerCase();
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
      return reply.code(403).send(errorBody("forbidden_host", "Invalid Host header"));
    }
    // The summarize API is only for the allow-listed extension (browsers always send Origin on POST).
    if (req.url.startsWith("/api/") && req.method !== "OPTIONS") {
      const origin = req.headers.origin;
      if (!origin || !allowed.has(origin)) {
        return reply.code(403).send(errorBody("forbidden_origin", "Origin is not allowed"));
      }
    }
  });

  app.register(cors, {
    origin: (origin, cb) => cb(null, origin !== undefined && allowed.has(origin)),
    methods: ["GET", "POST"],
    allowedHeaders: ["content-type"],
    maxAge: 600,
  });

  app.get("/health", async (): Promise<HealthResponse> => {
    const configured = provider.isConfigured();
    const status = configured ? await provider.checkModel() : { available: false, message: "API-ключ не настроен." };
    return HealthResponseSchema.parse({
      status: "ok",
      version: VERSION,
      ai: {
        provider: provider.name,
        model: provider.model,
        configured,
        modelAvailable: status.available,
        message: status.message,
        vision: {
          model: provider.visionModel,
          available: configured && provider.visionModel ? await provider.checkVisionModel() : null,
        },
      },
    });
  });

  let inFlight = false;

  app.post("/api/summarize", async (req, reply) => {
    const parsed = SummarizeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
        .join("; ");
      return reply.code(400).send(errorBody("invalid_request", msg));
    }
    if (inFlight) {
      return reply.code(409).send(errorBody("busy", "Предыдущая сводка ещё готовится. Подождите."));
    }
    inFlight = true;
    const started = Date.now();
    try {
      const result = await summarize(parsed.data, provider, {
        batchMaxChars: config.batchMaxChars,
        onImageError: (code) => req.log.warn({ code }, "photo not analysed"),
      });
      // Metadata only — never message contents.
      req.log.info(
        {
          messages: result.meta.messagesAnalyzed,
          batches: result.meta.batches,
          images: result.meta.imagesAnalyzed,
          imagesFailed: result.meta.imagesFailed,
          ms: Date.now() - started,
        },
        "summary generated",
      );
      return result;
    } catch (err) {
      if (err instanceof AiError) {
        req.log.warn({ code: err.code }, "AI error");
        if (err.retryAfterSeconds) reply.header("retry-after", String(err.retryAfterSeconds));
        return reply.code(AI_ERROR_STATUS[err.code]).send(errorBody(err.code, err.message));
      }
      req.log.error({ errName: err instanceof Error ? err.name : "unknown" }, "unexpected error");
      return reply.code(500).send(errorBody("internal", "Внутренняя ошибка сервера."));
    } finally {
      inFlight = false;
    }
  });

  app.setErrorHandler((err: { statusCode?: number; code?: string; message: string }, _req, reply) => {
    if (err.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply.code(413).send(errorBody("too_large", "Слишком большой объём сообщений. Выберите меньший период."));
    }
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    return reply.code(status).send(errorBody("error", status === 500 ? "Внутренняя ошибка сервера." : err.message));
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send(errorBody("not_found", "Not found")));

  return app;
}
