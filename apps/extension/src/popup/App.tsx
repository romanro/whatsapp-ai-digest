import { useCallback, useEffect, useState } from "react";
import {
  LIMITS,
  PERIODS,
  PERIOD_LABELS_RU,
  formatWallTime,
  summaryToPlainText,
  type Coverage,
  type Period,
  type SummarizeResponse,
} from "@wad/shared";
import {
  cancelBackgroundJob,
  captureImagesFromTab,
  clearLastResult,
  dismissJob,
  extractFromTab,
  loadJob,
  loadLastPhotos,
  loadLastResult,
  pingBackground,
  startBackgroundJob,
} from "../lib/chrome.ts";
import { JOB_KEY, type Job, type SummaryPhotos } from "../lib/jobs.ts";
import {
  chromeLocal,
  deleteSavedSummary,
  loadGroupPrefs,
  loadSavedSummary,
  saveGroupPrefs,
} from "../lib/cache.ts";
import {
  attachImages,
  preparePayload,
  type DocumentCandidate,
  type PreparedPayload,
} from "../lib/pipeline.ts";
import { normalizeDocName, parseDocument, type ParsedDocument } from "../lib/documents.ts";
import type { CapturedImage } from "../lib/protocol.ts";
import { loadSettings, type Settings } from "../lib/settings.ts";
import { SummaryView } from "./SummaryView.tsx";
import { useStatus, type Check } from "./useStatus.ts";
import { NOT_GROUP_MESSAGE } from "../content/extractor.ts";

/** The popup page can also be opened in a full browser tab (⤢) to read a long summary and its photos. */
const IN_TAB = new URLSearchParams(location.search).has("tab");

interface DocSlot {
  candidate: DocumentCandidate;
  state: "none" | "reading" | "ok" | "error";
  doc?: ParsedDocument;
  error?: string;
}

interface Review {
  payload: PreparedPayload;
  /** Photos read from the page (only when photo analysis is on). */
  photos: CapturedImage[];
  selected: Set<string>;
  /** Document cards in the period; the user adds the downloaded files. */
  docs: DocSlot[];
  /** Files that matched no document in the chat. */
  unmatched: string[];
}

function docState(slot: DocSlot): string {
  if (slot.state === "reading") return "читаю…";
  if (slot.state === "error") return slot.error ?? "ошибка";
  if (slot.state === "none" || !slot.doc) return "не добавлен";
  const d = slot.doc;
  const size = d.text !== undefined ? `${d.text.length.toLocaleString("ru-RU")} симв.` : `скан, ${d.pageImages?.length ?? 0} стр. как фото`;
  return `✓ ${d.pages ? `${d.pages} стр., ` : ""}${size}${d.truncated ? " (обрезан)" : ""}`;
}

function DocumentPicker({
  review,
  onFiles,
}: {
  review: Review;
  onFiles: (files: File[]) => void;
}) {
  const [over, setOver] = useState(false);
  if (!review.docs.length) return null;
  const added = review.docs.filter((d) => d.state === "ok").length;
  return (
    <div className="docs">
      <strong>
        Документы: добавлено {added} из {review.docs.length}
      </strong>
      {review.docs.map((slot, i) => (
        <div key={i} className={`doc-row ${slot.state}`}>
          <span className="doc-name" dir="auto">
            📄 {slot.candidate.name}
          </span>
          <span className="doc-state">{docState(slot)}</span>
        </div>
      ))}
      {review.unmatched.length > 0 && (
        <div className="warning" role="status">
          Не нашёл в чате документ с таким именем: {review.unmatched.join(", ")}
        </div>
      )}
      {IN_TAB ? (
        <div
          className={over ? "dropzone over" : "dropzone"}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            onFiles(Array.from(e.dataTransfer.files));
          }}
        >
          Скачайте документ в WhatsApp (нажмите на него → «Скачать») и перетащите файл сюда или выберите его:
          <input
            type="file"
            multiple
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={(e) => {
              onFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <span className="sub block">
            Файл читается здесь, на компьютере. В Groq уйдёт его текст (телефоны, email и номера карт скрываются) или, если это
            скан, первые {3} страницы как картинки.
          </span>
        </div>
      ) : (
        <button
          className="secondary"
          onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?tab=1") })}
        >
          Добавить документы — откроется во вкладке
        </button>
      )}
      {!IN_TAB && (
        <span className="sub">
          Выбор файла закрывает это маленькое окно, поэтому документы добавляются во вкладке. Там нажмите «Сформировать
          сводку» ещё раз — отметки сохранятся.
        </span>
      )}
    </div>
  );
}

type Phase =
  | { kind: "idle" }
  | { kind: "extracting"; step: string }
  | { kind: "review"; review: Review }
  | { kind: "empty"; coverage: Coverage }
  | { kind: "sending"; job: Job }
  | {
      kind: "done";
      result: SummarizeResponse;
      photos: SummaryPhotos;
      /** Shown above the summary, e.g. "nothing new since the saved summary". */
      note?: string;
    }
  | { kind: "error"; message: string };

const PERIOD_SHORT: Record<Period, string> = {
  "24h": "24 часа",
  "3d": "3 дня",
  "7d": "7 дней",
};

type SimpleCheck = { state: "ok" | "fail" | "checking"; message?: string };

const savedAt = (iso: string) =>
  new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

function jobNote(job: Job | null): string | undefined {
  if (job?.reused)
    return "Новых сообщений и фото с прошлой сводки нет — показана сохранённая, в Groq ничего не отправлялось.";
  const parts = [
    job?.photosCached ? `${job.photosCached} фото` : null,
    job?.documentsCached ? `${job.documentsCached} документ(а)` : null,
  ].filter(Boolean);
  if (parts.length)
    return `${parts.join(" и ")} уже были разобраны раньше — повторно в Groq не отправлялись.`;
  return undefined;
}

function StatusRow({
  label,
  check,
  okText,
}: {
  label: string;
  check: Check<unknown> | SimpleCheck;
  okText?: string;
}) {
  return (
    <div className={`status-row status-${check.state}`}>
      <span className="dot" aria-hidden>
        {check.state === "checking" ? "○" : "●"}
      </span>
      <span className="status-label">{label}</span>
      <span className="status-text">
        {check.state === "checking"
          ? "проверка…"
          : check.state === "ok"
            ? (okText ?? "OK")
            : "нет"}
      </span>
      {check.state === "fail" && "message" in check && check.message && (
        <div className="status-hint">{check.message}</div>
      )}
    </div>
  );
}

function CoverageWarning({ coverage }: { coverage: Coverage }) {
  if (coverage.fullyCovered && coverage.warnings.length === 0) return null;
  return (
    <div className={coverage.fullyCovered ? "notice" : "warning"} role="status">
      <strong>
        {coverage.fullyCovered ? "Примечания" : "⚠️ Период покрыт не полностью"}
      </strong>
      <ul>
        {coverage.warnings.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
    </div>
  );
}

function PhotoPicker({
  review,
  onToggle,
}: {
  review: Review;
  onToggle: (ref: string) => void;
}) {
  const usable = review.photos.filter((p) => p.dataUrl);
  const failed = review.photos.length - usable.length;
  const byRef = new Map(review.payload.imageCandidates.map((c) => [c.ref, c]));
  if (!review.photos.length) return null;
  return (
    <div className="photos">
      <div className="photos-head">
        <strong>
          Фото: выбрано{" "}
          {usable.filter((p) => review.selected.has(p.ref)).length} из{" "}
          {usable.length}
        </strong>
        <span className="sub">
          Снимите отметку с фото, где видны дети или личные данные.
        </span>
      </div>
      <div className="photo-grid">
        {usable.map((p) => {
          const c = byRef.get(p.ref);
          const on = review.selected.has(p.ref);
          return (
            <label
              key={p.ref}
              className={`photo ${on ? "on" : "off"}`}
              title={
                c ? `${formatWallTime(c.timestamp)} · ${c.sender ?? ""}` : ""
              }
            >
              <img src={p.dataUrl ?? ""} alt="" />
              <input
                type="checkbox"
                checked={on}
                onChange={() => onToggle(p.ref)}
              />
              <span className="photo-meta">
                {c ? formatWallTime(c.timestamp) : ""}
                {Math.max(p.width, p.height) < 700
                  ? " · низкое разрешение"
                  : ""}
              </span>
            </label>
          );
        })}
      </div>
      {failed > 0 && (
        <div className="sub">
          {failed} фото не удалось прочитать со страницы (прокрутите к ним и
          повторите).
        </div>
      )}
    </div>
  );
}

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [period, setPeriod] = useState<Period>("24h");
  const [includeImages, setIncludeImages] = useState(false);
  const [consentPermission, setConsentPermission] = useState(false);
  const [consentUpload, setConsentUpload] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const { status, refresh } = useStatus(settings?.backendUrl ?? null);

  /** Maps the background job (if any) + last result to what the popup shows. */
  const applyJob = useCallback(async (job: Job | null) => {
    if (job?.status === "running") return setPhase({ kind: "sending", job });
    if (job?.status === "error")
      return setPhase({ kind: "error", message: job.error ?? "Ошибка." });
    const result = await loadLastResult<SummarizeResponse>();
    if (result) {
      setPhase({
        kind: "done",
        result,
        photos: await loadLastPhotos(),
        note: job?.status === "done" ? jobNote(job) : undefined,
      });
      if (job?.status === "done") void dismissJob(); // seen → clear the ✓ badge
    } else {
      setPhase((ph) => (ph.kind === "sending" ? { kind: "idle" } : ph));
    }
  }, []);

  useEffect(() => {
    void loadSettings().then((s) => {
      setSettings(s);
      setPeriod(s.defaultPeriod);
      setIncludeImages(s.includeImagesDefault);
    });
    void (async () => {
      let job = await loadJob();
      // Wake the service worker: if it was stopped mid-job it marks the job as interrupted.
      if (job?.status === "running")
        job = (await pingBackground().catch(() => null))?.ok
          ? await loadJob()
          : job;
      await applyJob(job);
    })();
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area === "session" && JOB_KEY in changes)
        void applyJob((changes[JOB_KEY]?.newValue as Job | undefined) ?? null);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [applyJob]);

  const sending = phase.kind === "sending";
  useEffect(() => {
    if (!sending) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [sending]);

  const probe = status.whatsapp.state === "ok" ? status.whatsapp.data : null;
  const groupName = probe?.chatOpen && probe.isGroup ? probe.groupName : null;

  // Checkboxes are remembered per group; the group's saved summary is shown when nothing else is.
  useEffect(() => {
    if (!groupName) return;
    let cancelled = false;
    void (async () => {
      const prefs = await loadGroupPrefs(chromeLocal, groupName).catch(() => null);
      if (cancelled) return;
      setConsentPermission(prefs?.permission ?? false);
      setConsentUpload(prefs?.upload ?? false);
      if (prefs) setIncludeImages(prefs.images);
      const saved = await loadSavedSummary(chromeLocal, groupName).catch(() => null);
      if (cancelled) return;
      setPhase((ph) => {
        const showsOtherGroup =
          ph.kind === "done" && ph.result.groupName !== groupName.slice(0, LIMITS.maxGroupNameChars);
        if (ph.kind !== "idle" && !showsOtherGroup) return ph;
        return saved ? { kind: "done", result: saved.result, photos: saved.photos } : { kind: "idle" };
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [groupName]);

  function updatePrefs(change: Partial<{ permission: boolean; upload: boolean; images: boolean }>) {
    const next = {
      permission: change.permission ?? consentPermission,
      upload: change.upload ?? consentUpload,
      images: change.images ?? includeImages,
    };
    setConsentPermission(next.permission);
    setConsentUpload(next.upload);
    setIncludeImages(next.images);
    if (groupName) void saveGroupPrefs(chromeLocal, groupName, next).catch(() => undefined);
  }
  const health = status.backend.state === "ok" ? status.backend.data : null;
  const aiReady = !!health?.ai.configured && health.ai.modelAvailable !== false;
  const visionModel = health?.ai.vision.model ?? null;
  const visionReady = !!visionModel && health?.ai.vision.available !== false;
  const photosOn = includeImages && visionReady;
  const isGroup = probe?.chatOpen && probe.isGroup === true;
  const busy = phase.kind === "extracting" || phase.kind === "sending";
  const elapsed =
    phase.kind === "sending"
      ? Math.max(0, Math.round((now - phase.job.startedAt) / 1000))
      : 0;
  const canGenerate =
    !!isGroup &&
    !!health &&
    aiReady &&
    consentPermission &&
    consentUpload &&
    !busy &&
    status.tabId !== null;

  async function onGenerate() {
    if (!settings || status.tabId === null) return;
    setPhase({ kind: "extracting", step: "Читаю сообщения…" });
    try {
      const res = await extractFromTab(
        status.tabId,
        settings.dateOrderFallback,
      );
      if (!res.ok) return setPhase({ kind: "error", message: res.message });
      const prepared = preparePayload(res, period, new Date(), {
        includeImages: photosOn,
        maxImages: settings.maxImages,
      });
      if ("empty" in prepared)
        return setPhase({ kind: "empty", coverage: prepared.coverage });
      let photos: CapturedImage[] = [];
      if (photosOn && prepared.imageCandidates.length) {
        setPhase({
          kind: "extracting",
          step: `Читаю ${prepared.imageCandidates.length} фото со страницы…`,
        });
        photos = await captureImagesFromTab(
          status.tabId,
          prepared.imageCandidates.map((c) => c.ref),
        );
      }
      const selected = new Set(
        photos.filter((p) => p.dataUrl).map((p) => p.ref),
      );
      setPhase({
        kind: "review",
        review: {
          payload: prepared,
          photos,
          selected,
          docs: prepared.documentCandidates.map((candidate) => ({ candidate, state: "none" })),
          unmatched: [],
        },
      });
    } catch {
      setPhase({
        kind: "error",
        message:
          "Не удалось прочитать сообщения. Обновите вкладку WhatsApp и попробуйте снова.",
      });
    }
  }

  function togglePhoto(ref: string) {
    setPhase((ph) => {
      if (ph.kind !== "review") return ph;
      const selected = new Set(ph.review.selected);
      if (selected.has(ref)) selected.delete(ref);
      else selected.add(ref);
      return { kind: "review", review: { ...ph.review, selected } };
    });
  }

  /** Matches added files to the document cards by name, then reads them (in this page — nothing is uploaded yet). */
  function onFiles(files: File[]) {
    const updateSlot = (index: number, patch: Partial<DocSlot>) =>
      setPhase((ph) => {
        if (ph.kind !== "review") return ph;
        const docs = ph.review.docs.map((d, i) => (i === index ? { ...d, ...patch } : d));
        return { kind: "review", review: { ...ph.review, docs } };
      });
    if (phase.kind !== "review") return;
    const slots = phase.review.docs;
    const unmatched: string[] = [];
    const taken = new Set<number>();
    for (const file of files) {
      const name = normalizeDocName(file.name);
      let index = slots.findIndex((d, i) => !taken.has(i) && normalizeDocName(d.candidate.name) === name);
      // A single document in the chat: accept the file even if the browser renamed it on download.
      if (index === -1 && slots.length === 1 && !taken.has(0)) index = 0;
      if (index === -1) {
        unmatched.push(file.name);
        continue;
      }
      taken.add(index);
      updateSlot(index, { state: "reading", doc: undefined, error: undefined });
      void parseDocument(file).then((r) =>
        updateSlot(index, r.ok ? { state: "ok", doc: r.doc } : { state: "error", error: r.error }),
      );
    }
    setPhase((ph) => (ph.kind === "review" ? { kind: "review", review: { ...ph.review, unmatched } } : ph));
  }

  async function onSend(review: Review) {
    if (!settings) return;
    const { request } = attachImages(
      review.payload,
      review.photos,
      review.selected,
      review.docs.flatMap((d) => (d.state === "ok" && d.doc ? [{ messageId: d.candidate.messageId, doc: d.doc }] : [])),
    );
    if (!request.messages.length) {
      return setPhase({
        kind: "error",
        message:
          "Нечего отправлять: все фото сняты, а текстовых сообщений нет.",
      });
    }
    try {
      const res = await startBackgroundJob(request);
      if (!res.ok) return setPhase({ kind: "error", message: res.error });
      if (res.job?.status === "done") await applyJob(res.job);
      else if (res.job) setPhase({ kind: "sending", job: res.job });
    } catch {
      setPhase({
        kind: "error",
        message:
          "Не удалось запустить фоновую обработку. Перезагрузите расширение.",
      });
    }
  }

  async function onCopy(result: SummarizeResponse) {
    await navigator.clipboard.writeText(
      summaryToPlainText(
        result.groupName,
        PERIOD_LABELS_RU[result.period],
        result.summary,
        result.coverage.fullyCovered ? [] : result.coverage.warnings,
      ),
    );
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function onClear(result: SummarizeResponse) {
    await clearLastResult();
    await deleteSavedSummary(chromeLocal, result.groupName).catch(() => undefined);
    setPhase({ kind: "idle" });
  }

  const groupCheck: SimpleCheck =
    status.whatsapp.state !== "ok"
      ? { state: status.whatsapp.state === "checking" ? "checking" : "fail" }
      : !probe?.chatOpen
        ? { state: "fail", message: "Откройте нужную группу в WhatsApp Web." }
        : probe.isGroup === false
          ? { state: "fail", message: NOT_GROUP_MESSAGE }
          : probe.isGroup === null
            ? {
                state: "fail",
                message: "Тип чата не определён (нет сообщений на экране).",
              }
            : { state: "ok" };

  return (
    <div className={IN_TAB ? "popup in-tab" : "popup"}>
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            ✦
          </span>
          <div>
            <h1>AI-дайджест чата</h1>
            <p className="sub">Сводка важного из группы</p>
          </div>
        </div>
        <div className="topbar-actions">
          <button
            className="icon-btn"
            onClick={() => void refresh()}
            title="Обновить статус"
            aria-label="Обновить статус"
            disabled={busy}
          >
            ↻
          </button>
          {!IN_TAB && (
            <button
              className="icon-btn"
              onClick={() =>
                void chrome.tabs.create({
                  url: chrome.runtime.getURL("popup.html?tab=1"),
                })
              }
              title="Открыть во вкладке (на весь экран)"
              aria-label="Открыть во вкладке"
            >
              ⤢
            </button>
          )}
          <button
            className="icon-btn"
            onClick={() => void chrome.runtime.openOptionsPage()}
            title="Настройки"
            aria-label="Настройки"
          >
            ⚙
          </button>
        </div>
      </header>

      <section className="card status">
        <StatusRow
          label="WhatsApp Web"
          check={status.whatsapp}
          okText="найден"
        />
        <StatusRow
          label="Локальный сервер"
          check={status.backend}
          okText="подключён"
        />
        <StatusRow
          label="AI (Groq)"
          check={
            status.backend.state !== "ok"
              ? {
                  state:
                    status.backend.state === "checking" ? "checking" : "fail",
                }
              : aiReady
                ? { state: "ok" }
                : {
                    state: "fail",
                    message: health?.ai.message ?? "API-ключ не настроен.",
                  }
          }
          okText={health ? health.ai.model : "OK"}
        />
      </section>

      <section className="card">
        <div className="label">Текущая группа</div>
        <div className={`group-name ${groupCheck.state}`}>
          {probe?.groupName && probe.chatOpen ? probe.groupName : "—"}
        </div>
        {groupCheck.state === "fail" && groupCheck.message && (
          <div className="hint">{groupCheck.message}</div>
        )}

        <div className="label mt">Период</div>
        <div className="segmented" role="radiogroup" aria-label="Период">
          {PERIODS.map((p) => (
            <button
              key={p}
              role="radio"
              aria-checked={period === p}
              className={period === p ? "active" : ""}
              onClick={() => setPeriod(p)}
              disabled={busy}
            >
              {PERIOD_SHORT[p]}
            </button>
          ))}
        </div>

        {visionModel && (
          <label
            className="toggle mt"
            title={
              visionReady
                ? `Модель: ${visionModel}`
                : "Модель для фото недоступна"
            }
          >
            <input
              type="checkbox"
              checked={photosOn}
              disabled={busy || !visionReady}
              onChange={(e) => updatePrefs({ images: e.target.checked })}
            />
            <span>
              Анализировать фото <span className="beta">бета</span>
              <span className="sub block">
                {visionReady
                  ? `Доска, страницы учебника, объявления — до ${settings?.maxImages ?? 10} самых новых, вы выберете перед отправкой.`
                  : `Модель ${visionModel} сейчас недоступна у провайдера.`}
              </span>
            </span>
          </label>
        )}

        <div className="consent">
          <label>
            <input
              type="checkbox"
              checked={consentPermission}
              onChange={(e) => updatePrefs({ permission: e.target.checked })}
              disabled={busy}
            />
            <span>
              Я подтверждаю, что имею право обрабатывать сообщения этой группы.
            </span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={consentUpload}
              onChange={(e) => updatePrefs({ upload: e.target.checked })}
              disabled={busy}
            />
            <span>
              Я согласен(на), что текст выбранных сообщений
              {photosOn ? " и выбранные фото" : ""} будут отправлены в Groq для
              анализа. Автоматическое чтение может противоречить условиям
              использования WhatsApp.
            </span>
          </label>
          <details className="privacy">
            <summary>Конфиденциальность</summary>
            <p>
              Расширение только читает уже показанные на экране сообщения
              открытой группы — ничего не отправляет в WhatsApp и не меняет.
              Перед отправкой номера телефонов, email и номера карт скрываются,
              а номера вместо имён заменяются на «Участник N». Имена, детали и
              свободный текст всё равно могут содержать личные данные — они
              будут переданы в Groq (облачный AI-сервис) через ваш локальный
              сервер.
              {photosOn &&
                " Фото отправляются как есть (без размытия лиц и скрытия данных) — отправляйте только те, что не содержат лишнего."}{" "}
              Сервер ничего не сохраняет и не пишет сообщения в журналы.
              Расширение хранит в Chrome последнюю сводку каждой группы и
              распознанный текст фото, чтобы не отправлять их повторно —
              удалить: ⚙ → «Удалить сохранённые данные».
            </p>
          </details>
        </div>

        <button
          className="primary"
          disabled={!canGenerate}
          onClick={() => void onGenerate()}
        >
          {phase.kind === "extracting" ? <span className="spinner" /> : null}
          {phase.kind === "extracting" ? phase.step : "Сформировать сводку"}
        </button>
      </section>

      {phase.kind === "review" && (
        <section className="card review">
          <h2>Проверьте перед отправкой</h2>
          <ul className="facts">
            <li>
              Сообщений за период:{" "}
              <b>{phase.review.payload.request.messages.length}</b>
            </li>
            <li>
              Первое:{" "}
              <b>
                {formatWallTime(
                  phase.review.payload.request.messages[0]?.timestamp ?? "",
                )}
              </b>
              , последнее:{" "}
              <b>
                {formatWallTime(
                  phase.review.payload.request.messages.at(-1)?.timestamp ?? "",
                )}
              </b>
            </li>
            <li>
              Скрыто: телефонов {phase.review.payload.redactions.phones}, email{" "}
              {phase.review.payload.redactions.emails}, карт{" "}
              {phase.review.payload.redactions.cards +
                phase.review.payload.redactions.ibans}
              ; псевдонимов участников{" "}
              {phase.review.payload.pseudonymizedSenders}
            </li>
          </ul>
          <PhotoPicker review={phase.review} onToggle={togglePhoto} />
          <DocumentPicker review={phase.review} onFiles={onFiles} />
          <CoverageWarning coverage={phase.review.payload.coverage} />
          <div className="row">
            <button
              className="secondary"
              onClick={() => setPhase({ kind: "idle" })}
            >
              Отмена
            </button>
            <button
              className="primary"
              disabled={phase.review.docs.some((d) => d.state === "reading")}
              onClick={() => void onSend(phase.review)}
            >
              Отправить в Groq
            </button>
          </div>
        </section>
      )}

      {phase.kind === "sending" && (
        <section className="card center">
          <span className="spinner big" />
          <p>
            {[
              phase.job.photos > 0 ? `распознаю ${phase.job.photos} фото` : null,
              phase.job.documents ? `разбираю ${phase.job.documents} документ(а)` : null,
            ]
              .filter(Boolean)
              .join(", ")
              .replace(/^./, (c) => c.toUpperCase()) || "Анализирую"}
            {phase.job.photos > 0 || phase.job.documents ? " и анализирую" : ""}{" "}
            {phase.job.messages} сообщ. из «{phase.job.groupName}»…{" "}
            {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
          </p>
          <p className="sub">
            Окно можно закрыть — обработка идёт в фоне. Когда сводка будет
            готова, на значке расширения появится ✓.
            {phase.job.photos > 0
              ? " С фото это может занять несколько минут (лимиты бесплатного тарифа)."
              : ""}
          </p>
          <button
            className="secondary"
            onClick={() => void cancelBackgroundJob()}
          >
            Отменить
          </button>
        </section>
      )}

      {phase.kind === "empty" && (
        <section className="card">
          <p>
            За выбранный период в загруженной части чата нет сообщений для
            анализа.
          </p>
          <CoverageWarning coverage={phase.coverage} />
        </section>
      )}

      {phase.kind === "error" && (
        <section className="card error" role="alert">
          <strong>Ошибка</strong>
          <p>{phase.message}</p>
          <button
            className="secondary"
            onClick={() => {
              void dismissJob();
              setPhase({ kind: "idle" });
            }}
          >
            Понятно
          </button>
        </section>
      )}

      {phase.kind === "done" && (
        <section className="card result">
          <div className="result-head">
            <div>
              <h2>{phase.result.groupName}</h2>
              <div className="sub">
                {PERIOD_LABELS_RU[phase.result.period]} ·{" "}
                {phase.result.meta.messagesAnalyzed} сообщ.
                {phase.result.meta.imagesAnalyzed + phase.result.meta.imagesCached > 0
                  ? ` · ${phase.result.meta.imagesAnalyzed + phase.result.meta.imagesCached} фото`
                  : ""}
                {` · ${savedAt(phase.result.meta.generatedAt)}`}
              </div>
            </div>
            <div className="row tight">
              <button
                className="secondary"
                onClick={() => void onCopy(phase.result)}
              >
                {copied ? "Скопировано ✓" : "Копировать"}
              </button>
              <button className="ghost" onClick={() => void onClear(phase.result)}>
                Очистить
              </button>
            </div>
          </div>
          {phase.note && <p className="sub">{phase.note}</p>}
          <CoverageWarning coverage={phase.result.coverage} />
          <SummaryView summary={phase.result.summary} photos={phase.photos} />
          <div className="footnote">
            Сформировано AI ({phase.result.meta.model}
            {phase.result.meta.visionModel
              ? `, фото: ${phase.result.meta.visionModel}`
              : ""}
            ). Нажмите на время под пунктом, чтобы увидеть исходное сообщение и
            перевод.
          </div>
        </section>
      )}
    </div>
  );
}
