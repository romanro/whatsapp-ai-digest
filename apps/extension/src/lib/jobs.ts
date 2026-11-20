import type { SummarizeRequest, SummarizeResponse } from "@wad/shared";

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
  error?: string;
}

export type BadgeState = "running" | "done" | "error" | null;

export interface JobDeps {
  get<T>(key: string): Promise<T | undefined>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
  summarize(request: SummarizeRequest, signal: AbortSignal): Promise<SummarizeResponse>;
  badge(state: BadgeState): void;
  /** Keeps the service worker alive while a job runs; returns a stop function. */
  keepAlive(): () => void;
  now(): number;
  newId(): string;
}

export const JOB_KEY = "job";
export const RESULT_KEY = "lastResult";
export const INTERRUPTED_MESSAGE =
  "Фоновая обработка была прервана (Chrome остановил фоновый процесс расширения). Сформируйте сводку ещё раз.";

export class JobRunner {
  private controller: AbortController | null = null;

  constructor(private readonly deps: JobDeps) {}

  /** A job still marked "running" when the service worker (re)starts was killed with it. */
  async recoverOnStartup(): Promise<void> {
    const job = await this.deps.get<Job>(JOB_KEY);
    if (job?.status === "running" && !this.controller) {
      await this.deps.set({ [JOB_KEY]: { ...job, status: "error", error: INTERRUPTED_MESSAGE, finishedAt: this.deps.now() } });
      this.deps.badge("error");
    }
  }

  get running(): boolean {
    return this.controller !== null;
  }

  /** Starts a job and returns immediately; `done` resolves when it has finished (used by tests). */
  async start(request: SummarizeRequest): Promise<{ ok: true; job: Job; done: Promise<void> } | { ok: false; error: string }> {
    if (this.controller) return { ok: false, error: "Сводка уже готовится — дождитесь её или отмените." };
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
    await this.deps.set({ [JOB_KEY]: job });
    this.deps.badge("running");
    const stopKeepAlive = this.deps.keepAlive();

    const done = (async () => {
      try {
        const result = await this.deps.summarize(request, controller.signal);
        await this.deps.set({ [RESULT_KEY]: result, [JOB_KEY]: { ...job, status: "done", finishedAt: this.deps.now() } });
        this.deps.badge("done");
      } catch (err) {
        if (controller.signal.aborted) {
          await this.deps.remove(JOB_KEY);
          this.deps.badge(null);
        } else {
          const error = err instanceof Error ? err.message : "Неизвестная ошибка.";
          await this.deps.set({ [JOB_KEY]: { ...job, status: "error", error, finishedAt: this.deps.now() } });
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

export type BackgroundResponse = { ok: true; job?: Job; running?: boolean } | { ok: false; error: string };
