import { useCallback, useEffect, useState } from "react";
import {
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
  attachImages,
  preparePayload,
  type PreparedPayload,
} from "../lib/pipeline.ts";
import type { CapturedImage } from "../lib/protocol.ts";
import { loadSettings, type Settings } from "../lib/settings.ts";
import { SummaryView } from "./SummaryView.tsx";
import { useStatus, type Check } from "./useStatus.ts";
import { NOT_GROUP_MESSAGE } from "../content/extractor.ts";

/** The popup page can also be opened in a full browser tab (⤢) to read a long summary and its photos. */
const IN_TAB = new URLSearchParams(location.search).has("tab");

interface Review {
  payload: PreparedPayload;
  /** Photos read from the page (only when photo analysis is on). */
  photos: CapturedImage[];
  selected: Set<string>;
}

type Phase =
  | { kind: "idle" }
  | { kind: "extracting"; step: string }
  | { kind: "review"; review: Review }
  | { kind: "empty"; coverage: Coverage }
  | { kind: "sending"; job: Job }
  | { kind: "done"; result: SummarizeResponse; photos: SummaryPhotos }
  | { kind: "error"; message: string };

const PERIOD_SHORT: Record<Period, string> = {
  "24h": "24 часа",
  "3d": "3 дня",
  "7d": "7 дней",
};

type SimpleCheck = { state: "ok" | "fail" | "checking"; message?: string };

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
      setPhase({ kind: "done", result, photos: await loadLastPhotos() });
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
        review: { payload: prepared, photos, selected },
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

  async function onSend(review: Review) {
    if (!settings) return;
    const { request } = attachImages(
      review.payload,
      review.photos,
      review.selected,
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
      if (res.job) setPhase({ kind: "sending", job: res.job });
      // Consent is per-run: reset after each upload.
      setConsentUpload(false);
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

  async function onClear() {
    await clearLastResult();
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
              onChange={(e) => setIncludeImages(e.target.checked)}
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
              onChange={(e) => setConsentPermission(e.target.checked)}
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
              onChange={(e) => setConsentUpload(e.target.checked)}
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
              Сообщения не сохраняются на диск и не попадают в журналы.
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
            {phase.job.photos > 0
              ? `Распознаю ${phase.job.photos} фото и анализирую`
              : "Анализирую"}{" "}
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
                {phase.result.meta.imagesAnalyzed > 0
                  ? ` · ${phase.result.meta.imagesAnalyzed} фото`
                  : ""}
              </div>
            </div>
            <div className="row tight">
              <button
                className="secondary"
                onClick={() => void onCopy(phase.result)}
              >
                {copied ? "Скопировано ✓" : "Копировать"}
              </button>
              <button className="ghost" onClick={() => void onClear()}>
                Очистить
              </button>
            </div>
          </div>
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
