import { describe, expect, it } from "vitest";
import type { SummarizeRequest, SummarizeResponse } from "@wad/shared";
import {
  MAX_SAVED_SUMMARIES,
  clearAllSaved,
  deleteSavedSummary,
  documentHashes,
  fingerprint,
  imageHashes,
  storeDigests,
  withCachedDigests,
  loadGroupPrefs,
  loadSavedSummary,
  saveGroupPrefs,
  saveSummary,
  type KV,
} from "../src/lib/cache.ts";
import { JOB_KEY, JobRunner, RESULT_KEY, type Job } from "../src/lib/jobs.ts";

function memoryKV(): KV & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async <T>(k: string) => structuredClone(data.get(k)) as T | undefined,
    set: async (items) => void Object.entries(items).forEach(([k, v]) => data.set(k, structuredClone(v))),
    remove: async (keys) => void keys.forEach((k) => data.delete(k)),
  };
}

const PHOTO = "data:image/jpeg;base64,/9j/AAAA";

function makeRequest(text = "Что принести на урок"): SummarizeRequest {
  return {
    groupName: "Группа",
    period: "3d",
    clientNow: "2026-11-21T20:00:00+02:00",
    consentConfirmed: true,
    coverage: { periodStart: "2026-11-18T20:00:00+02:00", oldestLoaded: null, newestLoaded: null, fullyCovered: true, warnings: [] },
    messages: [
      { id: "t1", sender: "Мама Ани", timestamp: "2026-11-21T18:07:00+02:00", text },
      { id: "p1", sender: "Мама Ани", timestamp: "2026-11-21T18:07:00+02:00", text: "" },
    ],
    images: [{ messageId: "p1", dataUrl: PHOTO }],
    documents: [],
  };
}

function makeResult(request: SummarizeRequest, readings: { index: number; text: string; description: string }[]): SummarizeResponse {
  return {
    summary: { overview: "", announcements: [], events: [], tasks: [], payments: [], changes: [], other: [] },
    meta: {
      provider: "groq",
      model: "m",
      messagesAnalyzed: request.messages.length,
      batches: 1,
      unknownSourceIdsDropped: 0,
      imagesAnalyzed: readings.length,
      imagesFailed: 0,
      imagesCached: 0,
      imageReadings: readings,
      documentsAnalyzed: 0,
      documentsCached: 0,
      documentsFailed: 0,
      documentDigests: [],
      visionModel: "v",
      generatedAt: "2026-11-21T18:10:00.000Z",
    },
    coverage: request.coverage,
    groupName: request.groupName,
    period: request.period,
  };
}

function setup() {
  const session = new Map<string, unknown>();
  const cache = memoryKV();
  const sent: SummarizeRequest[] = [];
  const runner = new JobRunner({
    get: async <T>(k: string) => session.get(k) as T | undefined,
    set: async (items) => void Object.entries(items).forEach(([k, v]) => session.set(k, v)),
    remove: async (k) => void session.delete(k),
    summarize: async (req) => {
      sent.push(req);
      const fresh = req.images.flatMap((img, index) => (img.dataUrl ? [{ index, text: "כף ממתכת", description: "Список для урока" }] : []));
      return makeResult(req, fresh);
    },
    badge: () => undefined,
    keepAlive: () => () => undefined,
    now: () => 5000,
    newId: () => "job",
    cache,
  });
  const run = async (req: SummarizeRequest) => {
    const started = await runner.start(req);
    if (!started.ok) throw new Error(started.error);
    await started.done;
    return session.get(JOB_KEY) as Job;
  };
  return { runner, run, sent, session, cache };
}

describe("per-group photo switch", () => {
  it("are remembered for the group they were set in only", async () => {
    const kv = memoryKV();
    await saveGroupPrefs(kv, "Группа А", { images: true });
    expect(await loadGroupPrefs(kv, "Группа А")).toEqual({ images: true });
    expect(await loadGroupPrefs(kv, "Группа Б")).toBeNull();
    // Group names are not used as storage keys.
    expect(JSON.stringify([...kv.data.entries()])).not.toContain("Группа");
  });
});

describe("summary jobs with the cache", () => {
  it("saves the summary, then shows it again without sending when nothing changed", async () => {
    const { run, sent, session, cache } = setup();
    const first = await run(makeRequest());
    expect(sent).toHaveLength(1);
    expect(first).toMatchObject({ status: "done", photosCached: 0 });
    expect((await loadSavedSummary(cache, "Группа"))?.result.groupName).toBe("Группа");

    // "now" and coverage differ, content is the same → reused.
    const again = await run({ ...makeRequest(), clientNow: "2026-11-21T21:00:00+02:00" });
    expect(sent).toHaveLength(1);
    expect(again).toMatchObject({ status: "done", reused: true });
    expect((session.get(RESULT_KEY) as SummarizeResponse).groupName).toBe("Группа");
  });

  it("sends a photo it has read before as its reading, not as the image", async () => {
    const { run, sent } = setup();
    await run(makeRequest());
    const job = await run(makeRequest("Что принести на урок — и фартук"));
    expect(sent).toHaveLength(2);
    expect(sent[1]?.images).toEqual([{ messageId: "p1", reading: { text: "כף ממתכת", description: "Список для урока" } }]);
    expect(job).toMatchObject({ status: "done", photosCached: 1 });
  });

  it("keeps only the newest saved summaries and can delete them", async () => {
    const kv = memoryKV();
    for (let i = 0; i <= MAX_SAVED_SUMMARIES; i++) {
      const req = { ...makeRequest(), groupName: `Группа ${i}` };
      await saveSummary(kv, { result: makeResult(req, []), photos: {}, fingerprint: "f", savedAt: i });
    }
    expect(await loadSavedSummary(kv, "Группа 0")).toBeNull();
    expect(await loadSavedSummary(kv, `Группа ${MAX_SAVED_SUMMARIES}`)).not.toBeNull();
    await deleteSavedSummary(kv, `Группа ${MAX_SAVED_SUMMARIES}`);
    expect(await loadSavedSummary(kv, `Группа ${MAX_SAVED_SUMMARIES}`)).toBeNull();
    await saveGroupPrefs(kv, "Группа 1", { images: false });
    await clearAllSaved(kv);
    expect(kv.data.size).toBe(0);
  });
});

describe("document digests cache", () => {
  it("sends a document digested before as its digest, and the fingerprint changes with the document", async () => {
    const kv = memoryKV();
    const req = { ...makeRequest(), documents: [{ messageId: "t1", name: "a.pdf", kind: "pdf" as const, pages: 1, text: "מה עליי להביא" }] };
    const hashes = await documentHashes(req);
    const result = makeResult(req, []);
    result.meta.documentDigests = [{ index: 0, summary: "Список вещей.", keyPoints: ["Ложка"], translation: null }];
    await storeDigests(kv, result, hashes, 1);
    const { request, reused } = await withCachedDigests(kv, req, hashes);
    expect(reused).toBe(1);
    expect(request.documents[0]).toEqual({
      messageId: "t1",
      name: "a.pdf",
      kind: "pdf",
      pages: 1,
      digest: { summary: "Список вещей.", keyPoints: ["Ложка"], translation: null },
    });
    const other = { ...req, documents: [{ ...req.documents[0]!, text: "другой текст" }] };
    const img = await imageHashes(req);
    expect(await fingerprint(req, img, hashes)).not.toBe(await fingerprint(other, img, await documentHashes(other)));
  });
});
