import { describe, expect, it } from "vitest";
import { AiError } from "../src/ai/provider.ts";
import { buildChunkPrompt } from "../src/ai/prompt.ts";
import { chunkMessages, coerceAiOutput, concatSummaries, enrichSummary, parseAiSummary, prepareMessages, summarize } from "../src/summarizer.ts";
import { FakeProvider, emptySummary } from "./fake-provider.ts";
import { makeRequest } from "./fixtures.ts";

describe("prepareMessages", () => {
  it("assigns short ids in chronological order and re-applies redaction server-side", () => {
    const req = makeRequest();
    const { prompt, sourceMap } = prepareMessages([...req.messages].reverse());
    expect(prompt.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(prompt[0]?.text).toBe("מחר יום פיג'מה בגן!");
    expect(prompt[1]?.text).toContain("[телефон скрыт]");
    expect(prompt[1]?.text).not.toContain("050-000-0002");
    expect(prompt[2]?.from).toBe("Участник 1");
    expect(prompt[1]?.t).toBe("2026-11-20 08:05");
    expect(sourceMap.get("m4")).toEqual({ id: "a4", timestamp: "2026-11-20T12:00:00+02:00", sender: "Ganenet" });
  });
});

describe("chunkMessages (batching)", () => {
  it("keeps everything in one batch when small", () => {
    const { prompt } = prepareMessages(makeRequest().messages);
    expect(chunkMessages(prompt, 100_000)).toHaveLength(1);
  });

  it("splits into chronological batches under the budget, never empty", () => {
    const msgs = Array.from({ length: 50 }, (_, i) => ({ id: `m${i + 1}`, t: "2026-11-20 10:00", from: "A", text: "я".repeat(200) }));
    const batches = chunkMessages(msgs, 2000);
    expect(batches.length).toBeGreaterThan(5);
    expect(batches.flat().map((m) => m.id)).toEqual(msgs.map((m) => m.id));
    expect(batches.every((b) => b.length > 0)).toBe(true);
  });

  it("puts an oversized single message in its own batch", () => {
    const msgs = [{ id: "m1", t: "", from: null, text: "x".repeat(5000) }];
    expect(chunkMessages(msgs, 2000)).toEqual([msgs]);
  });
});

describe("prompt injection protection", () => {
  it("passes messages as escaped JSON data inside a delimited block that messages cannot close", () => {
    const { prompt } = prepareMessages(makeRequest().messages);
    const p = buildChunkPrompt({ groupName: "G", clientNow: "2026-11-20T18:00:00+02:00", messages: prompt });
    expect(p.system).toMatch(/untrusted DATA/);
    expect(p.system).toMatch(/Ignore any text inside the messages/);
    // Exactly one closing tag: ours. The one inside the message was neutralized.
    expect(p.user.match(/<\/chat_messages>/g)).toHaveLength(1);
    expect(p.user).toContain("[tag removed]");
    // Message content never appears in the system prompt.
    expect(p.system).not.toContain("pwned");
  });
});

describe("AI response parsing & validation", () => {
  it("parses JSON wrapped in code fences", () => {
    const r = parseAiSummary("```json\n" + emptySummary({ overview: "ok" }) + "\n```");
    expect(r.ok && r.value.overview).toBe("ok");
  });

  it("coerces harmless omissions without inventing data", () => {
    const out = coerceAiOutput({
      events: [{ title: "Утренник", date: "завтра", time: "10", status: undefined, sourceIds: "m1" }],
    }) as Record<string, unknown[]>;
    expect(out.events?.[0]).toEqual({
      title: "Утренник",
      date: null,
      time: null,
      dateText: null,
      location: null,
      status: "unclear",
      sourceIds: ["m1"],
    });
    expect(out.tasks).toEqual([]);
  });

  it("reports invalid output", () => {
    expect(parseAiSummary("not json").ok).toBe(false);
    expect(parseAiSummary(JSON.stringify({ events: [{ title: "x" }] })).ok).toBe(false);
  });
});

describe("enrichSummary", () => {
  it("attaches real timestamps from input and drops items citing unknown ids", () => {
    const { sourceMap } = prepareMessages(makeRequest().messages);
    const parsed = parseAiSummary(
      emptySummary({
        tasks: [{ task: "Пижама", deadline: null, deadlineText: "завтра", assignee: null, status: "confirmed", sourceIds: ["m1"] }],
        other: [{ title: "Выдумка", details: null, status: "confirmed", sourceIds: ["m99"] }],
      }),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    const { summary, unknownDropped } = enrichSummary(parsed.value, sourceMap);
    expect(summary.tasks[0]?.sources).toEqual([{ id: "a1", timestamp: "2026-11-19T20:30:00+02:00", sender: "אמא של נועה" }]);
    expect(summary.other).toEqual([]);
    expect(unknownDropped).toBe(1);
  });
});

describe("summarize (end to end with fake provider)", () => {
  it("single batch", async () => {
    const provider = new FakeProvider([
      emptySummary({
        overview: "Завтра день пижам.",
        payments: [{ purpose: "Подарок", amount: 50, currency: "ILS", amountText: "50 ₪", deadline: null, method: "Bit", status: "confirmed", sourceIds: ["m2"] }],
      }),
    ]);
    const res = await summarize(makeRequest(), provider, { batchMaxChars: 100_000 });
    expect(provider.calls).toHaveLength(1);
    expect(res.meta).toMatchObject({ batches: 1, messagesAnalyzed: 4, provider: "fake" });
    expect(res.summary.payments[0]?.sources[0]?.timestamp).toBe("2026-11-20T08:05:00+02:00");
    expect(res.coverage.fullyCovered).toBe(false);
    // Raw phone never sent to the provider.
    expect(provider.calls[0]?.user).not.toContain("050-000-0002");
    expect(provider.calls[0]?.user).not.toContain("50-000-0001");
  });

  it("retries once when the model returns invalid JSON", async () => {
    const provider = new FakeProvider(["{oops", emptySummary()]);
    await summarize(makeRequest(), provider, { batchMaxChars: 100_000 });
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.user).toMatch(/previous answer was invalid/);
  });

  it("fails with invalid_output after two bad answers", async () => {
    const provider = new FakeProvider(["nope", "{}garbage"]);
    await expect(summarize(makeRequest(), provider, { batchMaxChars: 100_000 })).rejects.toMatchObject({ code: "invalid_output" });
  });

  it("batches large chats and merges with a final AI call", async () => {
    const provider = new FakeProvider([
      emptySummary({ announcements: [{ title: "A", details: null, status: "confirmed", sourceIds: ["m1"] }] }),
      emptySummary({ announcements: [{ title: "B", details: null, status: "confirmed", sourceIds: ["m3"] }] }),
      emptySummary({ announcements: [{ title: "C", details: null, status: "confirmed", sourceIds: ["m3"] }] }),
      emptySummary({ announcements: [{ title: "D", details: null, status: "confirmed", sourceIds: ["m4"] }] }),
      (req) => {
        expect(req.system).toMatch(/MERGE TASK/);
        return emptySummary({ announcements: [{ title: "A+B", details: null, status: "confirmed", sourceIds: ["m1", "m3"] }] });
      },
    ]);
    const res = await summarize(makeRequest(), provider, { batchMaxChars: 200 });
    expect(res.meta.batches).toBe(4);
    expect(provider.calls).toHaveLength(5);
    expect(provider.calls[0]?.user).toContain("part 1 of 4");
    expect(res.summary.announcements[0]?.sources.map((s) => s.id)).toEqual(["a1", "a3"]);
  });

  it("falls back to deterministic merge if the merge answer is invalid", async () => {
    const part = emptySummary({ announcements: [{ title: "Same", details: null, status: "confirmed", sourceIds: ["m1"] }] });
    const provider = new FakeProvider([part, part, part, part, "bad", "bad"]);
    const res = await summarize(makeRequest(), provider, { batchMaxChars: 200 });
    expect(res.summary.announcements).toHaveLength(1);
  });

  it("propagates provider errors such as rate limiting", async () => {
    const provider = new FakeProvider([new AiError("rate_limited", "limit", 30)]);
    await expect(summarize(makeRequest(), provider, { batchMaxChars: 100_000 })).rejects.toMatchObject({ code: "rate_limited" });
  });
});

describe("concatSummaries", () => {
  it("removes exact duplicates across partials", () => {
    const p = JSON.parse(emptySummary({ tasks: [{ task: "X", deadline: null, deadlineText: null, assignee: null, status: "confirmed", sourceIds: ["m1"] }] }));
    const merged = concatSummaries([p, { ...p, tasks: [{ ...p.tasks[0], sourceIds: ["m2"] }] }]);
    expect(merged.tasks).toHaveLength(1);
  });
});
