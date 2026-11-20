import { SECTION_TITLES_RU, type EnrichedSummary, type ItemStatus, type SourceRef } from "./schemas.ts";
import { formatWallTime } from "./timestamps.ts";

export const STATUS_LABELS_RU: Record<ItemStatus, string> = {
  confirmed: "подтверждено",
  proposed: "предложение, не подтверждено",
  unclear: "неясно",
};

export function formatIsoDateRu(date: string | null): string | null {
  if (!date) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : date;
}

const srcs = (sources: SourceRef[]) =>
  sources.length ? ` (${sources.map((s) => formatWallTime(s.timestamp)).join(", ")})` : "";
const st = (s: ItemStatus) => (s === "confirmed" ? "" : ` [${STATUS_LABELS_RU[s]}]`);
const more = (details: string | null) => (details && details.trim() ? `\n   ${details.trim()}` : "");
const join = (...parts: (string | null | undefined)[]) => parts.filter((p) => p && p.trim()).join(" — ");

/** Plain-text rendering suitable for pasting into WhatsApp (uses *bold*). */
export function summaryToPlainText(groupName: string, periodLabel: string, s: EnrichedSummary, warnings: string[] = []): string {
  const lines: string[] = [`*${groupName}* · ${periodLabel}`];
  if (s.overview.trim()) lines.push("", s.overview.trim());

  const section = (key: keyof typeof SECTION_TITLES_RU, items: string[]) => {
    if (!items.length) return;
    lines.push("", `*${SECTION_TITLES_RU[key]}*`, ...items.map((i) => `• ${i}`));
  };

  section("announcements", s.announcements.map((a) => join(a.title, a.details) + st(a.status) + srcs(a.sources)));
  // events/tasks/payments/changes: headline first, then details on the next line
  section(
    "events",
    s.events.map(
      (e) =>
        join(
          [formatIsoDateRu(e.date), e.time].filter(Boolean).join(" ") || e.dateText,
          e.title,
          e.location,
        ) +
        st(e.status) +
        srcs(e.sources) +
        more(e.details),
    ),
  );
  section(
    "tasks",
    s.tasks.map(
      (t) =>
        join(t.task, t.assignee, t.deadline ? `до ${formatIsoDateRu(t.deadline)}` : t.deadlineText) +
        st(t.status) +
        srcs(t.sources) +
        more(t.details),
    ),
  );
  section(
    "payments",
    s.payments.map(
      (p) =>
        join(
          p.purpose,
          p.amountText ?? (p.amount !== null ? `${p.amount} ${p.currency ?? ""}`.trim() : null),
          p.deadline ? `до ${formatIsoDateRu(p.deadline)}` : null,
          p.method,
        ) +
        st(p.status) +
        srcs(p.sources) +
        more(p.details),
    ),
  );
  section(
    "changes",
    s.changes.map((c) => join(c.what, c.before ? `было: ${c.before}` : null, `стало: ${c.after}`) + srcs(c.sources) + more(c.details)),
  );
  section("other", s.other.map((a) => join(a.title, a.details) + st(a.status) + srcs(a.sources)));

  if (warnings.length) lines.push("", "⚠️ Сводка может быть неполной:", ...warnings.map((w) => `– ${w}`));
  return lines.join("\n");
}

export function isSummaryEmpty(s: EnrichedSummary): boolean {
  return !s.announcements.length && !s.events.length && !s.tasks.length && !s.payments.length && !s.changes.length && !s.other.length;
}
