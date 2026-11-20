/**
 * Service worker: runs summary jobs so the popup can be closed. It only talks to the local backend
 * (chrome.storage + fetch); it never touches WhatsApp.
 */
import { SummarizeRequestSchema } from "@wad/shared";
import { requestSummary } from "./lib/api.ts";
import { JOB_KEY, JobRunner, type BackgroundRequest, type BackgroundResponse, type BadgeState, type Job } from "./lib/jobs.ts";
import { loadSettings } from "./lib/settings.ts";

const BADGE: Record<Exclude<BadgeState, null>, { text: string; color: string }> = {
  running: { text: "…", color: "#0f766e" },
  done: { text: "✓", color: "#15803d" },
  error: { text: "!", color: "#b91c1c" },
};

function setBadge(state: BadgeState): void {
  void chrome.action.setBadgeText({ text: state ? BADGE[state].text : "" });
  if (state) void chrome.action.setBadgeBackgroundColor({ color: BADGE[state].color });
}

const runner = new JobRunner({
  get: async <T,>(key: string) => (await chrome.storage.session.get(key))[key] as T | undefined,
  set: (items) => chrome.storage.session.set(items),
  remove: (key) => chrome.storage.session.remove(key),
  summarize: async (request, signal) => requestSummary((await loadSettings()).backendUrl, request, signal),
  badge: setBadge,
  // An extension API call every 20 s resets the service worker's 30 s idle timer while a job runs.
  keepAlive: () => {
    const t = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000);
    return () => clearInterval(t);
  },
  now: () => Date.now(),
  newId: () => crypto.randomUUID(),
});

const ready = runner.recoverOnStartup();

chrome.runtime.onMessage.addListener((msg: BackgroundRequest, sender, sendResponse: (r: BackgroundResponse) => void) => {
  // Only this extension's own pages (popup/options) — not content scripts or other extensions.
  if (sender.id !== chrome.runtime.id || sender.tab) return false;
  void (async (): Promise<BackgroundResponse> => {
    await ready;
    switch (msg.type) {
      case "wad:bg:start": {
        const parsed = SummarizeRequestSchema.safeParse(msg.request);
        if (!parsed.success) return { ok: false, error: "Некорректный запрос." };
        const started = await runner.start(parsed.data);
        return started.ok ? { ok: true, job: started.job } : started;
      }
      case "wad:bg:cancel":
        return { ok: true, running: runner.cancel() };
      case "wad:bg:ping": {
        const job = (await chrome.storage.session.get(JOB_KEY))[JOB_KEY] as Job | undefined;
        return { ok: true, job, running: runner.running };
      }
      default:
        return { ok: false, error: "unknown request" };
    }
  })().then(sendResponse, () => sendResponse({ ok: false, error: "Ошибка фоновой обработки." }));
  return true;
});
