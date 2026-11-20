import { useEffect, useRef, useState } from "react";
import {
  PERIODS,
  PERIOD_LABELS_RU,
  formatWallTime,
  summaryToPlainText,
  type Coverage,
  type Period,
  type SummarizeResponse,
} from "@wad/shared";
import { ApiError, requestSummary } from "../lib/api.ts";
import { clearLastResult, extractFromTab, loadLastResult, saveLastResult } from "../lib/chrome.ts";
import { preparePayload, type PreparedPayload } from "../lib/pipeline.ts";
import { loadSettings, type Settings } from "../lib/settings.ts";
import { SummaryView } from "./SummaryView.tsx";
import { useStatus, type Check } from "./useStatus.ts";

type Phase =
  | { kind: "idle" }
  | { kind: "extracting" }
  | { kind: "review"; payload: PreparedPayload }
  | { kind: "empty"; coverage: Coverage }
  | { kind: "sending"; payload: PreparedPayload }
  | { kind: "done"; result: SummarizeResponse }
  | { kind: "error"; message: string };

const PERIOD_SHORT: Record<Period, string> = { "24h": "24 часа", "3d": "3 дня", "7d": "7 дней" };

function StatusRow({ label, check, okText }: { label: string; check: Check<unknown> | { state: "ok" | "fail" | "checking"; message?: string }; okText?: string }) {
  const icon = check.state === "ok" ? "●" : check.state === "checking" ? "○" : "●";
  return (
    <div className={`status-row status-${check.state}`}>
      <span className="dot" aria-hidden>{icon}</span>
      <span className="status-label">{label}</span>
      <span className="status-text">
        {check.state === "checking" ? "проверка…" : check.state === "ok" ? (okText ?? "OK") : "нет"}
      </span>
      {check.state === "fail" && "message" in check && check.message && <div className="status-hint">{check.message}</div>}
    </div>
  );
}

function CoverageWarning({ coverage }: { coverage: Coverage }) {
  if (coverage.fullyCovered && coverage.warnings.length === 0) return null;
  return (
    <div className={coverage.fullyCovered ? "notice" : "warning"} role="status">
      <strong>{coverage.fullyCovered ? "Примечания" : "⚠️ Период покрыт не полностью"}</strong>
      <ul>
        {coverage.warnings.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
    </div>
  );
}

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [period, setPeriod] = useState<Period>("24h");
  const [consentPermission, setConsentPermission] = useState(false);
  const [consentUpload, setConsentUpload] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const { status, refresh } = useStatus(settings?.backendUrl ?? null);

  useEffect(() => {
    void loadSettings().then((s) => {
      setSettings(s);
      setPeriod(s.defaultPeriod);
    });
    void loadLastResult<SummarizeResponse>().then((r) => {
      if (r) setPhase({ kind: "done", result: r });
    });
  }, []);

  const probe = status.whatsapp.state === "ok" ? status.whatsapp.data : null;
  const health = status.backend.state === "ok" ? status.backend.data : null;
  const aiReady = !!health?.ai.configured && health.ai.modelAvailable !== false;
  const isGroup = probe?.chatOpen && probe.isGroup === true;
  const busy = phase.kind === "extracting" || phase.kind === "sending";
  const canGenerate = !!isGroup && !!health && aiReady && consentPermission && consentUpload && !busy && status.tabId !== null;

  async function onGenerate() {
    if (!settings || status.tabId === null) return;
    setPhase({ kind: "extracting" });
    try {
      const res = await extractFromTab(status.tabId, settings.dateOrderFallback);
      if (!res.ok) return setPhase({ kind: "error", message: res.message });
      const prepared = preparePayload(res, period, new Date());
      if ("empty" in prepared) return setPhase({ kind: "empty", coverage: prepared.coverage });
      setPhase({ kind: "review", payload: prepared });
    } catch {
      setPhase({ kind: "error", message: "Не удалось прочитать сообщения. Обновите вкладку WhatsApp и попробуйте снова." });
    }
  }

  async function onSend(payload: PreparedPayload) {
    if (!settings) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setPhase({ kind: "sending", payload });
    try {
      const result = await requestSummary(settings.backendUrl, payload.request, ac.signal);
      await saveLastResult(result);
      setPhase({ kind: "done", result });
      // Consent is per-run: reset after each upload.
      setConsentUpload(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === "aborted") return setPhase({ kind: "idle" });
      setPhase({ kind: "error", message: err instanceof Error ? err.message : "Неизвестная ошибка." });
    } finally {
      abortRef.current = null;
    }
  }

  async function onCopy(result: SummarizeResponse) {
    await navigator.clipboard.writeText(
      summaryToPlainText(result.groupName, PERIOD_LABELS_RU[result.period], result.summary, result.coverage.fullyCovered ? [] : result.coverage.warnings),
    );
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function onClear() {
    await clearLastResult();
    setPhase({ kind: "idle" });
  }

  const groupCheck: { state: "ok" | "fail" | "checking"; message?: string } =
    status.whatsapp.state !== "ok"
      ? { state: status.whatsapp.state === "checking" ? "checking" : "fail" }
      : !probe?.chatOpen
        ? { state: "fail", message: "Откройте нужную группу в WhatsApp Web." }
        : probe.isGroup === false
          ? { state: "fail", message: "Открыт личный чат — личные чаты не обрабатываются." }
          : probe.isGroup === null
            ? { state: "fail", message: "Тип чата не определён (нет сообщений на экране)." }
            : { state: "ok" };

  return (
    <div className="popup">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>✦</span>
          <div>
            <h1>AI-дайджест чата</h1>
            <p className="sub">Сводка важного из группы</p>
          </div>
        </div>
        <div className="topbar-actions">
          <button className="icon-btn" onClick={() => void refresh()} title="Обновить статус" aria-label="Обновить статус" disabled={busy}>
            ↻
          </button>
          <button className="icon-btn" onClick={() => void chrome.runtime.openOptionsPage()} title="Настройки" aria-label="Настройки">
            ⚙
          </button>
        </div>
      </header>

      <section className="card status">
        <StatusRow label="WhatsApp Web" check={status.whatsapp} okText="найден" />
        <StatusRow label="Локальный сервер" check={status.backend} okText="подключён" />
        <StatusRow
          label="AI (Groq)"
          check={
            status.backend.state !== "ok"
              ? { state: status.backend.state === "checking" ? "checking" : "fail" }
              : aiReady
                ? { state: "ok" }
                : { state: "fail", message: health?.ai.message ?? "API-ключ не настроен." }
          }
          okText={health ? health.ai.model : "OK"}
        />
      </section>

      <section className="card">
        <div className="label">Текущая группа</div>
        <div className={`group-name ${groupCheck.state}`}>
          {probe?.groupName && probe.chatOpen ? probe.groupName : "—"}
        </div>
        {groupCheck.state === "fail" && groupCheck.message && <div className="hint">{groupCheck.message}</div>}

        <div className="label mt">Период</div>
        <div className="segmented" role="radiogroup" aria-label="Период">
          {PERIODS.map((p) => (
            <button key={p} role="radio" aria-checked={period === p} className={period === p ? "active" : ""} onClick={() => setPeriod(p)} disabled={busy}>
              {PERIOD_SHORT[p]}
            </button>
          ))}
        </div>

        <div className="consent">
          <label>
            <input type="checkbox" checked={consentPermission} onChange={(e) => setConsentPermission(e.target.checked)} disabled={busy} />
            <span>Я подтверждаю, что имею право обрабатывать сообщения этой группы.</span>
          </label>
          <label>
            <input type="checkbox" checked={consentUpload} onChange={(e) => setConsentUpload(e.target.checked)} disabled={busy} />
            <span>
              Я согласен(на), что текст выбранных сообщений будет отправлен в Groq для анализа. Автоматическое чтение может
              противоречить условиям использования WhatsApp.
            </span>
          </label>
          <details className="privacy">
            <summary>Конфиденциальность</summary>
            <p>
              Расширение только читает уже показанные на экране сообщения открытой группы — ничего не отправляет в WhatsApp и не
              меняет. Перед отправкой номера телефонов, email и номера карт скрываются, а номера вместо имён заменяются на
              «Участник N». Имена, детали и свободный текст всё равно могут содержать личные данные — они будут переданы
              в Groq (облачный AI-сервис) через ваш локальный сервер. Сообщения не сохраняются на диск и не попадают в журналы.
            </p>
          </details>
        </div>

        <button className="primary" disabled={!canGenerate} onClick={() => void onGenerate()}>
          {phase.kind === "extracting" ? <span className="spinner" /> : null}
          {phase.kind === "extracting" ? "Читаю сообщения…" : "Сформировать сводку"}
        </button>
      </section>

      {phase.kind === "review" && (
        <section className="card review">
          <h2>Проверьте перед отправкой</h2>
          <ul className="facts">
            <li>
              Сообщений за период: <b>{phase.payload.request.messages.length}</b>
            </li>
            <li>
              Первое: <b>{formatWallTime(phase.payload.request.messages[0]?.timestamp ?? "")}</b>, последнее:{" "}
              <b>{formatWallTime(phase.payload.request.messages.at(-1)?.timestamp ?? "")}</b>
            </li>
            <li>
              Скрыто: телефонов {phase.payload.redactions.phones}, email {phase.payload.redactions.emails}, карт{" "}
              {phase.payload.redactions.cards + phase.payload.redactions.ibans}; псевдонимов участников{" "}
              {phase.payload.pseudonymizedSenders}
            </li>
          </ul>
          <CoverageWarning coverage={phase.payload.coverage} />
          <div className="row">
            <button className="secondary" onClick={() => setPhase({ kind: "idle" })}>
              Отмена
            </button>
            <button className="primary" onClick={() => void onSend(phase.payload)}>
              Отправить в Groq
            </button>
          </div>
        </section>
      )}

      {phase.kind === "sending" && (
        <section className="card center">
          <span className="spinner big" />
          <p>Анализирую {phase.payload.request.messages.length} сообщ.… Это может занять до минуты.</p>
          <button className="secondary" onClick={() => abortRef.current?.abort()}>
            Отменить
          </button>
        </section>
      )}

      {phase.kind === "empty" && (
        <section className="card">
          <p>За выбранный период в загруженной части чата нет текстовых сообщений.</p>
          <CoverageWarning coverage={phase.coverage} />
        </section>
      )}

      {phase.kind === "error" && (
        <section className="card error" role="alert">
          <strong>Ошибка</strong>
          <p>{phase.message}</p>
          <button className="secondary" onClick={() => setPhase({ kind: "idle" })}>
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
                {PERIOD_LABELS_RU[phase.result.period]} · {phase.result.meta.messagesAnalyzed} сообщ.
              </div>
            </div>
            <div className="row tight">
              <button className="secondary" onClick={() => void onCopy(phase.result)}>
                {copied ? "Скопировано ✓" : "Копировать"}
              </button>
              <button className="ghost" onClick={() => void onClear()}>
                Очистить
              </button>
            </div>
          </div>
          <CoverageWarning coverage={phase.result.coverage} />
          <SummaryView summary={phase.result.summary} />
          <div className="footnote">
            Сформировано AI ({phase.result.meta.model}). Проверяйте важные детали по исходным сообщениям — время указано под каждым пунктом.
          </div>
        </section>
      )}
    </div>
  );
}
