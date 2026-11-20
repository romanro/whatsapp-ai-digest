import type { AiProvider, JsonCompletionRequest, ModelStatus } from "../src/ai/provider.ts";

/** Scripted provider for tests — records prompts, returns queued responses. Never calls the network. */
export class FakeProvider implements AiProvider {
  readonly name = "fake";
  readonly model = "fake-model";
  readonly calls: JsonCompletionRequest[] = [];
  constructor(
    private readonly responses: (string | Error | ((req: JsonCompletionRequest) => string))[],
    private readonly configured = true,
  ) {}
  isConfigured() {
    return this.configured;
  }
  async checkModel(): Promise<ModelStatus> {
    return { available: this.configured, message: this.configured ? null : "no key" };
  }
  async completeJson(req: JsonCompletionRequest): Promise<string> {
    this.calls.push(req);
    const next = this.responses.shift();
    if (next === undefined) throw new Error("FakeProvider: no more responses");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(req) : next;
  }
}

export const emptySummary = (overrides: object = {}) =>
  JSON.stringify({ overview: "", announcements: [], events: [], tasks: [], payments: [], changes: [], other: [], ...overrides });
