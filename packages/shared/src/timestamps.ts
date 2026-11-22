/**
 * Parsing of WhatsApp Web "pre-plain-text" labels, e.g.
 *   "[14:32, 20/11/2026] Anna: "
 *   "[2:32 PM, 11/20/2026] Anna: "
 *   "[14:32, 20.11.2026] Анна: "
 * The date order depends on the user's WhatsApp/OS locale, so it is inferred from the data,
 * with an explicit fallback. Nothing is guessed: unparseable labels yield null.
 */

export type DateOrder = "DMY" | "MDY" | "YMD";

export interface ParsedLabel {
  /** Raw numeric date parts in label order. */
  parts: [number, number, number];
  hour: number;
  minute: number;
  sender: string | null;
}

const LABEL_RE =
  /^\s*\[\s*(\d{1,2})[:.](\d{2})(?:\s*([AaPp])\.?\s*[Mm]\.?)?\s*,\s*(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})\s*\]\s*(.*)$/s;

export function parseLabel(label: string): ParsedLabel | null {
  const m = LABEL_RE.exec(label.replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, ""));
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const ampm = m[3]?.toLowerCase();
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    if (ampm === "p" && hour !== 12) hour += 12;
    if (ampm === "a" && hour === 12) hour = 0;
  }
  if (hour > 23 || minute > 59) return null;
  const rest = (m[7] ?? "").trim();
  // Label ends with "Sender:" — strip the trailing colon only.
  const sender = rest.endsWith(":") ? rest.slice(0, -1).trim() : rest;
  return {
    parts: [Number(m[4]), Number(m[5]), Number(m[6])],
    hour,
    minute,
    sender: sender.length > 0 ? sender : null,
  };
}

/** Parses a bubble clock like "18:07", "6:07 PM" or "18:07 edited" (msg-meta). */
export function parseClock(text: string): { hour: number; minute: number } | null {
  const m = /(\d{1,2})[:.](\d{2})(?:\s*([AaPp])\.?\s*[Mm]\.?)?/.exec(text.replace(/[‎‏‪-‮⁦-⁩]/g, ""));
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const ampm = m[3]?.toLowerCase();
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    if (ampm === "p" && hour !== 12) hour += 12;
    if (ampm === "a" && hour === 12) hour = 0;
  }
  return hour > 23 || minute > 59 ? null : { hour, minute };
}

/**
 * Dates a message that only shows a clock (captionless photo) from the nearest labelled messages before/after it
 * in the chat. Returns null when the neighbours don't pin down a single day. `certain` is false when only one
 * neighbour exists and the day could also be a later/earlier one (e.g. the photo is the newest message and the
 * previous labelled message is from an earlier day than `now`).
 */
export function dateFromNeighbours(
  clock: { hour: number; minute: number },
  prev: Date | null,
  next: Date | null,
  now: Date,
): { date: Date; certain: boolean } | null {
  const at = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), clock.hour, clock.minute, 0, 0);
  const fits = (c: Date) => (!prev || c >= prev) && (!next || c <= next);
  const candidates = [prev, next].flatMap((d) => (d ? [at(d)] : [])).filter(fits);
  const unique = [...new Map(candidates.map((c) => [c.getTime(), c])).values()];
  if (unique.length !== 1) return null;
  const date = unique[0] as Date;
  // Only the neighbours' own days are candidates, so the answer is certain when no other day lies between
  // the bounds (the photo is between prev and `now` for the newest message).
  const day = (d: Date) => Math.round(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86_400_000);
  const upper = next ?? (prev ? now : null);
  const certain = !!prev && !!upper && day(upper) - day(prev) <= 1 && (next !== null || day(date) === day(now));
  return { date, certain };
}

/**
 * Infers date order from a set of labels. Returns null if the data is ambiguous
 * (every day ≤ 12), in which case the caller must use the configured fallback.
 */
export function inferDateOrder(labels: readonly ParsedLabel[]): DateOrder | null {
  let dmy = false;
  let mdy = false;
  for (const { parts } of labels) {
    if (parts[0] > 31) return "YMD";
    if (parts[0] > 12) dmy = true;
    if (parts[1] > 12) mdy = true;
  }
  if (dmy && !mdy) return "DMY";
  if (mdy && !dmy) return "MDY";
  return null;
}

/** Builds a local Date from a parsed label. Returns null on impossible dates (no rollover). */
export function labelToDate(label: ParsedLabel, order: DateOrder): Date | null {
  const [a, b, c] = label.parts;
  let y: number, mo: number, d: number;
  if (order === "YMD") [y, mo, d] = [a, b, c];
  else if (order === "DMY") [d, mo, y] = [a, b, c];
  else [mo, d, y] = [a, b, c];
  if (y < 100) y += 2000;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(y, mo - 1, d, label.hour, label.minute, 0, 0);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, "0");

/** Local ISO string with offset, e.g. 2026-11-20T14:32:00+02:00 — preserves the wall time shown in WhatsApp. */
export function toLocalIso(date: Date): string {
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(off / 60)}:${pad(off % 60)}`
  );
}

/** Formats a local ISO string as "20.11 14:32" without timezone conversion (wall time as shown in WhatsApp). */
export function formatWallTime(iso: string, withYear = false): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[3]}.${m[2]}${withYear ? `.${m[1]}` : ""} ${m[4]}:${m[5]}`;
}

const WEEKDAYS_RU = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"] as const;

/** Short Russian weekday of the wall date in a local ISO string ("2026-11-20T…" → "пт"). */
export function weekdayRu(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return WEEKDAYS_RU[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()] ?? null;
}

/** "2026-11-20 (пт) 14:32" — the wall time as shown in WhatsApp, with weekday for resolving "до пятницы". */
export function promptTime(iso: string): string {
  const wd = weekdayRu(iso);
  return `${iso.slice(0, 10)}${wd ? ` (${wd})` : ""} ${iso.slice(11, 16)}`;
}
