import { describe, expect, it } from "vitest";
import type { SummarizeRequest, SummarizeResponse } from "@wad/shared";
import {
  INTERRUPTED_MESSAGE,
  JOB_KEY,
  JobRunner,
  RESULT_KEY,
  citedPhotos,
  type BadgeState,
  type Job,
  type JobDeps,
} from "../src/lib/jobs.ts";

const request = {
  groupName: "Группа",
  period: "24h",
  clientNow: "2026-11-20T18:00:00+02:00",
  consentConfirmed: true,
  coverage: {
    periodStart: "2026-11-19T18:00:00+02:00",
    oldestLoaded: null,
    newestLoaded: null,
    fullyCovered: true,
    warnings: [],
  },
  messages: [
    {
      id: "a",
      sender: null,
      timestamp: "2026-11-20T10:00:00+02:00",
      text: "x",
    },
  ],
  images: [{ messageId: "a", dataUrl: "data:image/jpeg;base64,AA==" }],
  documents: [],
} satisfies SummarizeRequest;

const result = { groupName: "Группа" } as unknown as SummarizeResponse;

function setup(summarize: JobDeps["summarize"]) {
  const store = new Map<string, unknown>();
  const badges: BadgeState[] = [];
  let alive = 0;
  const runner = new JobRunner({
    get: async <T>(k: string) => store.get(k) as T | undefined,
    set: async (items) =>
      void Object.entries(items).forEach(([k, v]) => store.set(k, v)),
    remove: async (k) => void store.delete(k),
    summarize,
    badge: (b) => badges.push(b),
    keepAlive: () => {
      alive++;
      return () => alive--;
    },
    now: () => 1000,
    newId: () => "job-1",
  });
  return { runner, store, badges, alive: () => alive };
}

describe("JobRunner (background processing)", () => {
  it("runs a job in the background, stores the result and shows ✓", async () => {
    let release: () => void = () => undefined;
    const t = setup(() => new Promise((r) => (release = () => r(result))));
    const started = await t.runner.start(request);
    if (!started.ok) throw new Error(started.error);
    expect(started.job).toMatchObject({
      status: "running",
      messages: 1,
      photos: 1,
      groupName: "Группа",
    });
    expect((t.store.get(JOB_KEY) as Job).status).toBe("running");
    expect(t.alive()).toBe(1);
    release();
    await started.done;
    expect(t.store.get(RESULT_KEY)).toBe(result);
    expect((t.store.get(JOB_KEY) as Job).status).toBe("done");
    expect(t.badges).toEqual(["running", "done"]);
    expect(t.alive()).toBe(0);
  });

  it("refuses a second job while one is running", async () => {
    let release: () => void = () => undefined;
    const t = setup(() => new Promise((r) => (release = () => r(result))));
    const first = await t.runner.start(request);
    expect(await t.runner.start(request)).toMatchObject({ ok: false });
    release();
    if (first.ok) await first.done;
  });

  it("records errors for the popup and shows !", async () => {
    const t = setup(async () => {
      throw new Error("Превышен лимит запросов");
    });
    const started = await t.runner.start(request);
    if (started.ok) await started.done;
    expect(t.store.get(JOB_KEY)).toMatchObject({
      status: "error",
      error: "Превышен лимит запросов",
    });
    expect(t.badges.at(-1)).toBe("error");
  });

  it("cancels: aborts the request, forgets the job and clears the badge", async () => {
    const t = setup(
      (_req, signal) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          ),
        ),
    );
    const started = await t.runner.start(request);
    expect(t.runner.cancel()).toBe(true);
    if (started.ok) await started.done;
    expect(t.store.has(JOB_KEY)).toBe(false);
    expect(t.badges.at(-1)).toBeNull();
    expect(t.runner.running).toBe(false);
  });

  it("marks a job left 'running' by a killed service worker as interrupted", async () => {
    const t = setup(async () => result);
    t.store.set(JOB_KEY, {
      id: "old",
      status: "running",
      startedAt: 1,
      groupName: "G",
      messages: 3,
      photos: 0,
    } satisfies Job);
    await t.runner.recoverOnStartup();
    expect(t.store.get(JOB_KEY)).toMatchObject({
      status: "error",
      error: INTERRUPTED_MESSAGE,
    });
    expect(t.badges).toEqual(["error"]);
  });
});

describe("citedPhotos", () => {
  const src = (id: string) => ({
    id,
    timestamp: "2026-11-20T10:00:00+02:00",
    sender: null,
    text: "",
    translation: null,
  });
  const empty = {
    overview: "",
    announcements: [],
    events: [],
    tasks: [],
    payments: [],
    changes: [],
    other: [],
  };
  const img = (messageId: string, n: number) => ({
    messageId,
    dataUrl: `data:image/jpeg;base64,${"A".repeat(n)}`,
  });

  it("keeps only photos of messages the summary cites, tasks first within the budget", () => {
    const res = {
      summary: {
        ...empty,
        other: [
          {
            title: "x",
            details: null,
            status: "confirmed",
            sources: [src("b")],
          },
        ],
        tasks: [
          {
            task: "ДЗ",
            details: null,
            deadline: null,
            deadlineText: null,
            assignee: null,
            status: "confirmed",
            sources: [src("a")],
          },
        ],
      },
    } as unknown as SummarizeResponse;
    const images = [img("a", 100), img("b", 100), img("c", 10)];
    expect(Object.keys(citedPhotos(res, images))).toEqual(["a", "b"]);
    // Budget fits one photo → the homework (task) one wins.
    expect(Object.keys(citedPhotos(res, images, 150))).toEqual(["a"]);
  });

  it("returns nothing without a summary or photos", () => {
    expect(citedPhotos(result, [img("a", 10)])).toEqual({});
  });
});
