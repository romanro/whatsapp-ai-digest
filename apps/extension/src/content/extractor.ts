import { dedupeMessages, normalizeSender, normalizeText, opaqueKey, type RawMessage } from "@wad/shared";
import { inferDateOrder, labelToDate, parseLabel, toLocalIso, type DateOrder, type ParsedLabel } from "@wad/shared";
import { GROUP_ID_MARKER, READ_MORE_TEXTS, SELECTORS, queryAll, queryFirst } from "./selectors.ts";

export interface ProbeResult {
  whatsappLoaded: boolean;
  chatOpen: boolean;
  groupName: string | null;
  /** null = could not determine (no message rows rendered). */
  isGroup: boolean | null;
}

export interface ExtractionResult {
  ok: true;
  groupName: string;
  messages: RawMessage[];
  stats: {
    rowsSeen: number;
    untimed: number;
    skippedNonText: number;
    truncated: number;
    duplicatesRemoved: number;
    dateOrder: DateOrder;
    dateOrderAssumed: boolean;
    notScrolledToBottom: boolean;
  };
}

export interface ExtractionError {
  ok: false;
  code: "not_loaded" | "no_chat" | "not_group" | "unknown_chat_type" | "no_messages";
  message: string;
}

export function probe(doc: Document): ProbeResult {
  const whatsappLoaded = !!queryFirst(doc, SELECTORS.appRoot) && !!queryFirst(doc, SELECTORS.sidePane);
  const main = queryFirst(doc, SELECTORS.mainPane);
  if (!whatsappLoaded || !main) return { whatsappLoaded, chatOpen: false, groupName: null, isGroup: null };
  return { whatsappLoaded, chatOpen: true, groupName: readTitle(main), isGroup: detectGroup(main) };
}

function readTitle(main: Element): string | null {
  const el = queryFirst(main, SELECTORS.chatTitle);
  const raw = el?.getAttribute("title") || el?.textContent || "";
  const name = normalizeText(raw);
  return name || null;
}

function detectGroup(main: Element): boolean | null {
  const rows = queryAll(main, SELECTORS.messageRow);
  if (!rows.length) return null;
  return rows.some((r) => (r.getAttribute("data-id") ?? "").includes(GROUP_ID_MARKER));
}

/** Text content with emoji <img alt> preserved, excluding nested quoted messages. */
function extractText(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  for (const q of queryAll(clone, SELECTORS.quotedMessage)) q.remove();
  for (const img of Array.from(clone.querySelectorAll("img[alt]"))) {
    img.replaceWith(clone.ownerDocument.createTextNode(img.getAttribute("alt") ?? ""));
  }
  for (const br of Array.from(clone.querySelectorAll("br"))) br.replaceWith(clone.ownerDocument.createTextNode("\n"));
  return normalizeText(clone.textContent ?? "");
}

function isInsideQuote(el: Element, row: Element): boolean {
  for (let n: Element | null = el.parentElement; n && n !== row; n = n.parentElement) {
    for (const s of SELECTORS.quotedMessage) {
      try {
        if (n.matches(s)) return true;
      } catch {
        /* ignore */
      }
    }
  }
  return false;
}

function hasReadMore(row: Element): boolean {
  if (queryFirst(row, SELECTORS.readMore)) return true;
  return Array.from(row.querySelectorAll('[role="button"]')).some((b) =>
    READ_MORE_TEXTS.includes(normalizeText(b.textContent ?? "").toLowerCase()),
  );
}

function isVisible(el: Element): boolean {
  const h = el as HTMLElement;
  if (h.hidden || h.getAttribute("aria-hidden") === "true") return false;
  const style = h.ownerDocument.defaultView?.getComputedStyle(h);
  return !style || (style.display !== "none" && style.visibility !== "hidden");
}

/**
 * Reads the messages that are CURRENTLY RENDERED in the open group chat. Read-only: it never clicks,
 * scrolls, types or modifies the page. Older history that WhatsApp has not rendered is not accessed.
 */
export function extractRenderedMessages(doc: Document, dateOrderFallback: DateOrder): ExtractionResult | ExtractionError {
  const p = probe(doc);
  if (!p.whatsappLoaded) return { ok: false, code: "not_loaded", message: "WhatsApp Web не загружен или вы не вошли в аккаунт." };
  const main = queryFirst(doc, SELECTORS.mainPane);
  if (!p.chatOpen || !main) return { ok: false, code: "no_chat", message: "Откройте группу в WhatsApp Web." };
  if (p.isGroup === null) {
    return { ok: false, code: "unknown_chat_type", message: "Не удалось определить тип чата: в окне нет сообщений." };
  }
  if (!p.isGroup) {
    return { ok: false, code: "not_group", message: "Открыт личный чат. Расширение работает только с группами." };
  }

  const rows = queryAll(main, SELECTORS.messageRow);
  type Pending = { key: string; label: ParsedLabel | null; text: string };
  const pending: Pending[] = [];
  let skippedNonText = 0;
  let truncated = 0;

  for (const row of rows) {
    const dataId = row.getAttribute("data-id") ?? "";
    // Only rows that belong to this group chat (skips nested/unrelated data-id nodes).
    if (!dataId.includes(GROUP_ID_MARKER)) continue;
    // Nested data-id elements (e.g. inside quotes) — keep only the outermost row.
    if (row.parentElement?.closest("[data-id]")) continue;

    const labelEl = queryAll(row, SELECTORS.prePlainText).find((el) => !isInsideQuote(el, row));
    if (!labelEl) {
      // System notices, media without caption, stickers, deleted messages, etc.
      skippedNonText++;
      continue;
    }
    const textEl = queryAll(labelEl, SELECTORS.messageText).find((el) => !isInsideQuote(el, row));
    const text = textEl ? extractText(textEl) : "";
    if (!text) {
      skippedNonText++;
      continue;
    }
    if (hasReadMore(row)) truncated++;
    pending.push({ key: opaqueKey(dataId), label: parseLabel(labelEl.getAttribute("data-pre-plain-text") ?? ""), text });
  }

  const labels = pending.flatMap((x) => (x.label ? [x.label] : []));
  const inferred = inferDateOrder(labels);
  const dateOrder = inferred ?? dateOrderFallback;

  let untimed = 0;
  const messages: RawMessage[] = pending.map((x) => {
    const date = x.label ? labelToDate(x.label, dateOrder) : null;
    if (!date) untimed++;
    return {
      key: x.key,
      sender: normalizeSender(x.label?.sender),
      timestamp: date ? toLocalIso(date) : null,
      text: x.text,
    };
  });

  const deduped = dedupeMessages(messages);
  if (!deduped.length) {
    return { ok: false, code: "no_messages", message: "В открытом чате не найдено текстовых сообщений." };
  }

  const scrollBtn = queryFirst(main, SELECTORS.scrollToBottom);
  return {
    ok: true,
    groupName: p.groupName ?? "Без названия",
    messages: deduped,
    stats: {
      rowsSeen: rows.length,
      untimed,
      skippedNonText,
      truncated,
      duplicatesRemoved: messages.length - deduped.length,
      dateOrder,
      dateOrderAssumed: inferred === null && labels.length > 0,
      notScrolledToBottom: !!scrollBtn && isVisible(scrollBtn),
    },
  };
}

/** Waits until the number of rendered rows stops changing (WhatsApp renders lazily), max ~2 s. Read-only. */
export async function waitForStableDom(doc: Document, timeoutMs = 2000, intervalMs = 250): Promise<void> {
  const main = queryFirst(doc, SELECTORS.mainPane);
  if (!main) return;
  let last = -1;
  let stableTicks = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const n = queryAll(main, SELECTORS.messageRow).length;
    stableTicks = n === last ? stableTicks + 1 : 0;
    if (stableTicks >= 2) return;
    last = n;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
