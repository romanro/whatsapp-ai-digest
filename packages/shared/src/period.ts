import { PERIOD_HOURS, type Period } from "./constants.ts";
import type { Coverage } from "./schemas.ts";
import { toLocalIso } from "./timestamps.ts";

export function periodStart(period: Period, now: Date): Date {
  return new Date(now.getTime() - PERIOD_HOURS[period] * 3600_000);
}

export interface TimedMessage {
  timestamp: string | null;
}

/** Keeps messages whose timestamp is inside [start, now]. Messages without a timestamp are excluded (never guessed). */
export function filterByPeriod<T extends TimedMessage>(messages: readonly T[], period: Period, now: Date): T[] {
  const start = periodStart(period, now).getTime();
  // Allow 2 minutes of clock skew in the future (WhatsApp shows minute precision).
  const end = now.getTime() + 120_000;
  return messages.filter((m) => {
    if (m.timestamp === null) return false;
    const t = Date.parse(m.timestamp);
    return Number.isFinite(t) && t >= start && t <= end;
  });
}

export interface CoverageInput {
  /** All messages that were loaded in the DOM (before period filtering). */
  loaded: readonly TimedMessage[];
  period: Period;
  now: Date;
  /** Messages that were rendered but had no parseable timestamp. */
  untimedCount: number;
  /** Non-text messages (media without caption, stickers…) that were skipped. */
  skippedNonText: number;
  /** True if WhatsApp shows the "scroll to latest" button, i.e. the newest messages may not be rendered. */
  notScrolledToBottom: boolean;
  /** True if the date order of labels was ambiguous and the fallback setting was used. */
  dateOrderAssumed: boolean;
}

/**
 * Determines whether the loaded messages fully cover the requested period.
 * Coverage is complete only if the oldest loaded message is at or before the period start
 * (i.e. history was loaded far enough back) and the newest messages are rendered.
 */
export function detectCoverage(input: CoverageInput): Coverage {
  const start = periodStart(input.period, input.now);
  const times = input.loaded
    .map((m) => (m.timestamp ? Date.parse(m.timestamp) : NaN))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  const oldest = times.length ? new Date(times[0] as number) : null;
  const newest = times.length ? new Date(times[times.length - 1] as number) : null;

  const warnings: string[] = [];
  let fullyCovered = true;

  if (!oldest) {
    fullyCovered = false;
    warnings.push("Не найдено ни одного сообщения с распознанной датой в загруженной части чата.");
  } else if (oldest.getTime() > start.getTime()) {
    fullyCovered = false;
    warnings.push(
      `Загружены сообщения только начиная с ${fmt(oldest)}, а выбранный период начинается ${fmt(start)}. ` +
        "Более ранние сообщения периода могли не попасть в сводку — прокрутите чат вверх и повторите.",
    );
  }
  if (input.notScrolledToBottom) {
    fullyCovered = false;
    warnings.push("Чат прокручен не до конца — самые новые сообщения могут отсутствовать. Прокрутите чат вниз.");
  }
  if (input.untimedCount > 0) {
    warnings.push(`${input.untimedCount} сообщ. без распознанного времени пропущено.`);
  }
  if (input.skippedNonText > 0) {
    warnings.push(`${input.skippedNonText} медиа-сообщ. без текста пропущено (обрабатывается только текст).`);
  }
  if (input.dateOrderAssumed) {
    warnings.push("Формат даты (день/месяц) определён по настройкам, а не по данным — проверьте настройки при сомнениях.");
  }

  return {
    periodStart: toLocalIso(start),
    oldestLoaded: oldest ? toLocalIso(oldest) : null,
    newestLoaded: newest ? toLocalIso(newest) : null,
    fullyCovered,
    warnings,
  };
}

function fmt(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
