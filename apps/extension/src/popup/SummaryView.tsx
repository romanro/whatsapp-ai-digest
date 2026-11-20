import {
  SECTION_KEYS,
  SECTION_TITLES_RU,
  STATUS_LABELS_RU,
  formatIsoDateRu,
  formatWallTime,
  isSummaryEmpty,
  type EnrichedSummary,
  type ItemStatus,
  type SectionKey,
  type SourceRef,
} from "@wad/shared";
import type { ReactNode } from "react";

const SECTION_ICONS: Record<SectionKey, string> = {
  announcements: "📢",
  events: "📅",
  tasks: "✅",
  payments: "💳",
  changes: "🔄",
  other: "📌",
};

function Sources({ sources }: { sources: SourceRef[] }) {
  return (
    <div className="sources" title="Время исходных сообщений в WhatsApp">
      {sources.map((s) => (
        <span key={s.id} className="source">
          {formatWallTime(s.timestamp)}
          {s.sender ? ` · ${s.sender}` : ""}
        </span>
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: ItemStatus }) {
  if (status === "confirmed") return null;
  return <span className={`badge badge-${status}`}>{STATUS_LABELS_RU[status]}</span>;
}

function Item({ title, details, chips, status, sources }: {
  title: string;
  details?: string | null;
  chips?: (string | null | undefined)[];
  status?: ItemStatus;
  sources: SourceRef[];
}) {
  const visibleChips = (chips ?? []).filter((c): c is string => !!c && c.trim().length > 0);
  return (
    <li className="item">
      <div className="item-title">
        {title} {status && <StatusBadge status={status} />}
      </div>
      {details && <div className="item-details">{details}</div>}
      {visibleChips.length > 0 && (
        <div className="chips">
          {visibleChips.map((c, i) => (
            <span key={i} className="chip">
              {c}
            </span>
          ))}
        </div>
      )}
      <Sources sources={sources} />
    </li>
  );
}

const dateTime = (date: string | null, time: string | null, fallback: string | null) =>
  [formatIsoDateRu(date), time].filter(Boolean).join(" ") || fallback;

function renderSection(key: SectionKey, s: EnrichedSummary): ReactNode[] {
  switch (key) {
    case "announcements":
    case "other":
      return s[key].map((a, i) => <Item key={i} title={a.title} details={a.details} status={a.status} sources={a.sources} />);
    case "events":
      return s.events.map((e, i) => (
        <Item
          key={i}
          title={e.title}
          chips={[dateTime(e.date, e.time, e.dateText), e.location && `📍 ${e.location}`]}
          status={e.status}
          sources={e.sources}
        />
      ));
    case "tasks":
      return s.tasks.map((t, i) => (
        <Item
          key={i}
          title={t.task}
          chips={[t.deadline ? `до ${formatIsoDateRu(t.deadline)}` : t.deadlineText, t.assignee && `👤 ${t.assignee}`]}
          status={t.status}
          sources={t.sources}
        />
      ));
    case "payments":
      return s.payments.map((p, i) => (
        <Item
          key={i}
          title={p.purpose}
          chips={[
            p.amountText ?? (p.amount !== null ? `${p.amount} ${p.currency ?? ""}` : null),
            p.deadline ? `до ${formatIsoDateRu(p.deadline)}` : null,
            p.method,
          ]}
          status={p.status}
          sources={p.sources}
        />
      ));
    case "changes":
      return s.changes.map((c, i) => (
        <Item key={i} title={c.what} details={c.before ? `Было: ${c.before} → Стало: ${c.after}` : `Теперь: ${c.after}`} sources={c.sources} />
      ));
  }
}

export function SummaryView({ summary }: { summary: EnrichedSummary }) {
  if (isSummaryEmpty(summary)) {
    return (
      <div className="empty">
        {summary.overview || "За выбранный период важной информации не найдено."}
      </div>
    );
  }
  return (
    <div className="summary">
      {summary.overview && <p className="overview">{summary.overview}</p>}
      {SECTION_KEYS.map((key) => {
        const items = renderSection(key, summary);
        if (!items.length) return null;
        return (
          <section key={key} className="section">
            <h3>
              <span aria-hidden>{SECTION_ICONS[key]}</span> {SECTION_TITLES_RU[key]}
              <span className="count">{items.length}</span>
            </h3>
            <ul>{items}</ul>
          </section>
        );
      })}
    </div>
  );
}
