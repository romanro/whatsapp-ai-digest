import {
  SECTION_KEYS,
  type SectionKey,
  type SummarizeRequest,
  type SummarizeResponse,
} from "@wad/shared";
import {
  documentHashes,
  fingerprint,
  imageHashes,
  loadSavedSummary,
  saveSummary,
  storeDigests,
  storeReadings,
  withCachedDigests,
  withCachedReadings,
  type KV,
} from "./cache.ts";

/**
 * A summary job runs in the extension's service worker so the popup can be closed while the server works
 * (photo analysis can take minutes). State lives in chrome.storage.session (memory only, cleared with the browser).
 */
export interface Job {
  id: string;
  status: "running" | "done" | "error";
  startedAt: number;
  finishedAt?: number;
  groupName: string;
  messages: number;
  photos: number;
  /** Photos whose earlier reading was reused instead of sending them to the AI again. */
  photosCached?: number;
  documents?: number;
  /** Documents whose earlier digest was reused. */
  documentsCached?: number;
  /** Nothing changed since the saved summary of this group — it was shown without calling the AI. */
  reused?: boolean;
  error?: string;
}

export type BadgeState = "running" | "done" | "error" | null;

export interface JobDeps {
  get<T>(key: string): Promise<T | undefined>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
  summarize(
    request: SummarizeRequest,
    signal: AbortSignal,
  ): Promise<SummarizeResponse>;
  badge(state: BadgeState): void;
  /** Keeps the service worker alive while a job runs; returns a stop function. */
  keepAlive(): () => void;
  now(): number;
  newId(): string;
  /** Persistent store for saved summaries and photo readings (chrome.storage.local); omitted = no caching. */
  cache?: KV;
}

export const JOB_KEY = "job";
export const RESULT_KEY = "lastResult";
/** Photos of cited messages, shown next to the summary: { [messageId]: dataUrl[] }. */
export const PHOTOS_KEY = "lastPhotos";
export type SummaryPhotos = Record<string, string[]>;

/** chrome.storage.session holds 10 MB in total; leave room for the summary itself. */
export const PHOTOS_BUDGET_CHARS = 6_000_000;

/** Tasks first: that's where homework photos end up. */
const PHOTO_PRIORITY: SectionKey[] = [
  "tasks",
  ...SECTION_KEYS.filter((k) => k !== "tasks"),
];

/**
 * Keeps the photos the user sent whose messages the summary cites, so the user can see the photo itself
 * (e.g. the homework on the board) — the vision model's reading can be incomplete.
 */
export function citedPhotos(
  result: SummarizeResponse,
  images: SummarizeRequest["images"],
  budget = PHOTOS_BUDGET_CHARS,
): SummaryPhotos {
  const summary = (result as Partial<SummarizeResponse>).summary;
  if (!summary || !images.length) return {};
  const cited: string[] = [];
  for (const key of PHOTO_PRIORITY) {
    for (const item of summary[key] ?? [])
      for (const s of item.sources) if (!cited.includes(s.id)) cited.push(s.id);
  }
  const photos: SummaryPhotos = {};
  let used = 0;
  for (const id of cited) {
    for (const img of images.filter((i) => i.messageId === id)) {
      if (!img.dataUrl || used + img.dataUrl.length > budget) continue;
      used += img.dataUrl.length;
      (photos[id] ??= []).push(img.dataUrl);
    }
  }
  return photos;
}
export const INTERRUPTED_MESSAGE =
  "Фоновая обработка была прервана (Chrome остановил фоновый процесс расширения). Сформируйте сводку ещё раз.";

export class JobRunner {
  private controller: AbortController | null = null;

  constructor(private readonly deps: JobDeps) {}

  /** A job still marked "running" when the service worker (re)starts was killed with it. */
  async recoverOnStartup(): Promise<void> {
    const job = await this.deps.get<Job>(JOB_KEY);
    if (job?.status === "running" && !this.controller) {
      await this.deps.set({
        [JOB_KEY]: {
          ...job,
          status: "error",
          error: INTERRUPTED_MESSAGE,
          finishedAt: this.deps.now(),
        },
      });
      this.deps.badge("error");
    }
  }

  get running(): boolean {
    return this.controller !== null;
  }

  /** Starts a job and returns immediately; `done` resolves when it has finished (used by tests). */
  async start(
    request: SummarizeRequest,
  ): Promise<
    { ok: true; job: Job; done: Promise<void> } | { ok: false; error: string }
  > {
    if (this.controller)
      return {
        ok: false,
        error: "Сводка уже готовится — дождитесь её или отмените.",
      };
    const job: Job = {
      id: this.deps.newId(),
      status: "running",
      startedAt: this.deps.now(),
      groupName: request.groupName,
      messages: request.messages.length,
      photos: request.images.length,
    };
    const controller = new AbortController();
    this.controller = controller;
    const { cache } = this.deps;
    const hashes = await imageHashes(request);
    const docHashes = await documentHashes(request);
    const print = await fingerprint(request, hashes, docHashes);

    // Same messages and photos as the saved summary of this group → show it, nothing is sent.
    const saved = cache ? await loadSavedSummary(cache, request.groupName).catch(() => null) : null;
    if (saved?.fingerprint === print) {
      const reusedJob: Job = { ...job, status: "done", reused: true, finishedAt: this.deps.now() };
      await this.deps.set({ [RESULT_KEY]: saved.result, [PHOTOS_KEY]: saved.photos, [JOB_KEY]: reusedJob });
      this.deps.badge("done");
      this.controller = null;
      return { ok: true, job: reusedJob, done: Promise.resolve() };
    }

    const withPhotos = cache
      ? await withCachedReadings(cache, request, hashes).catch(() => ({ request, reused: 0 }))
      : { request, reused: 0 };
    const withDocs = cache
      ? await withCachedDigests(cache, withPhotos.request, docHashes).catch(() => ({ request: withPhotos.request, reused: 0 }))
      : { request: withPhotos.request, reused: 0 };
    const toSend = withDocs.request;
    job.photosCached = withPhotos.reused;
    job.documents = request.documents.length;
    job.documentsCached = withDocs.reused;
    await this.deps.remove(PHOTOS_KEY);
    await this.deps.set({ [JOB_KEY]: job });
    this.deps.badge("running");
    const stopKeepAlive = this.deps.keepAlive();

    const done = (async () => {
      try {
        const result = await this.deps.summarize(toSend, controller.signal);
        const photos = citedPhotos(result, request.images);
        await this.deps.set({
          [RESULT_KEY]: result,
          [PHOTOS_KEY]: photos,
          [JOB_KEY]: { ...job, status: "done", finishedAt: this.deps.now() },
        });
        this.deps.badge("done");
        if (cache) {
          // Caching is best-effort: a full or failing store must not turn a finished summary into an error.
          await storeReadings(cache, result, hashes, this.deps.now()).catch(() => undefined);
          await storeDigests(cache, result, docHashes, this.deps.now()).catch(() => undefined);
          await saveSummary(cache, { result, photos, fingerprint: print, savedAt: this.deps.now() }).catch(() => undefined);
        }
      } catch (err) {
        if (controller.signal.aborted) {
          await this.deps.remove(JOB_KEY);
          this.deps.badge(null);
        } else {
          const error =
            err instanceof Error ? err.message : "Неизвестная ошибка.";
          await this.deps.set({
            [JOB_KEY]: {
              ...job,
              status: "error",
              error,
              finishedAt: this.deps.now(),
            },
          });
          this.deps.badge("error");
        }
      } finally {
        stopKeepAlive();
        this.controller = null;
      }
    })();
    return { ok: true, job, done };
  }

  cancel(): boolean {
    if (!this.controller) return false;
    this.controller.abort();
    return true;
  }
}

export type BackgroundRequest =
  | { type: "wad:bg:start"; request: SummarizeRequest }
  | { type: "wad:bg:cancel" }
  /** Wakes the service worker (which recovers interrupted jobs) and reports whether a job is really running. */
  | { type: "wad:bg:ping" };

export type BackgroundResponse =
  { ok: true; job?: Job; running?: boolean } | { ok: false; error: string };
