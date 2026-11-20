import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { AiError } from "../src/ai/provider.ts";
import { FakeProvider, emptySummary } from "./fake-provider.ts";
import { makeRequest } from "./fixtures.ts";

const EXT_ID = "fjldfeefkijllcoohbgfdodnkoeoedkg";
const ORIGIN = `chrome-extension://${EXT_ID}`;
const config = loadConfig({ GROQ_API_KEY: "gsk_test_secret_value", ALLOWED_EXTENSION_IDS: EXT_ID, LOG_LEVEL: "silent" });

let app: FastifyInstance;
afterEach(async () => app?.close());

const post = (body: unknown, headers: Record<string, string> = { origin: ORIGIN }) =>
  app.inject({ method: "POST", url: "/api/summarize", headers: { host: "127.0.0.1:3741", "content-type": "application/json", ...headers }, payload: body as object });

describe("config", () => {
  it("binds to loopback only and defaults to the Groq gpt-oss-20b model", () => {
    const c = loadConfig({});
    expect(c.host).toBe("127.0.0.1");
    expect(c.ai).toMatchObject({ provider: "groq", model: "openai/gpt-oss-20b", baseURL: "https://api.groq.com/openai/v1", apiKey: undefined });
  });

  it("supports alternative OpenAI-compatible providers", () => {
    expect(loadConfig({ AI_PROVIDER: "ollama", AI_MODEL: "llama3.2" }).ai).toMatchObject({ baseURL: "http://127.0.0.1:11434/v1", model: "llama3.2" });
  });
});

describe("GET /health", () => {
  it("reports configuration without exposing secrets", async () => {
    app = buildApp(config, new FakeProvider([]));
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: "127.0.0.1:3741" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", ai: { configured: true, modelAvailable: true, model: "fake-model" } });
    expect(res.body).not.toContain("gsk_test_secret_value");
  });

  it("rejects foreign Host headers (DNS rebinding)", async () => {
    app = buildApp(config, new FakeProvider([]));
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: "evil.example.com" } });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/summarize", () => {
  it("rejects requests without an allow-listed origin", async () => {
    app = buildApp(config, new FakeProvider([emptySummary()]));
    expect((await post(makeRequest(), {})).statusCode).toBe(403);
    expect((await post(makeRequest(), { origin: "https://evil.example.com" })).statusCode).toBe(403);
    expect((await post(makeRequest(), { origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).statusCode).toBe(403);
  });

  it("returns CORS headers only for the allowed extension", async () => {
    app = buildApp(config, new FakeProvider([]));
    const ok = await app.inject({
      method: "OPTIONS",
      url: "/api/summarize",
      headers: { host: "127.0.0.1:3741", origin: ORIGIN, "access-control-request-method": "POST" },
    });
    expect(ok.headers["access-control-allow-origin"]).toBe(ORIGIN);
    const bad = await app.inject({
      method: "OPTIONS",
      url: "/api/summarize",
      headers: { host: "127.0.0.1:3741", origin: "https://evil.example.com", "access-control-request-method": "POST" },
    });
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("validates the body with Zod", async () => {
    app = buildApp(config, new FakeProvider([]));
    const res = await post({ ...makeRequest(), consentConfirmed: false });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });

  it("rejects oversized bodies", async () => {
    app = buildApp(config, new FakeProvider([]));
    const res = await post({ ...makeRequest(), groupName: "x".repeat(1_100_000) });
    expect(res.statusCode).toBe(413);
  });

  it("returns an enriched summary", async () => {
    app = buildApp(
      config,
      new FakeProvider([
        emptySummary({ changes: [{ what: "Поездка в зоопарк", before: null, after: "понедельник 24.11", sourceIds: ["m4"] }] }),
      ]),
    );
    const res = await post(makeRequest());
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary.changes[0].sources[0]).toEqual({ id: "a4", timestamp: "2026-11-20T12:00:00+02:00", sender: "Ganenet" });
    expect(body.groupName).toBe("Родители · גן שושנה");
  });

  it("maps provider rate limits to 429 with Retry-After", async () => {
    app = buildApp(config, new FakeProvider([new AiError("rate_limited", "Превышен лимит", 20)]));
    const res = await post(makeRequest());
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBe("20");
    expect(res.json().error.code).toBe("rate_limited");
  });

  it("returns 503 when no API key is configured", async () => {
    app = buildApp(config, new FakeProvider([new AiError("not_configured", "no key")], false));
    expect((await post(makeRequest())).statusCode).toBe(503);
  });
});
