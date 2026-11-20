import { dedupeMessages, normalizeSender, normalizeText, opaqueKey, type RawMessage } from "@wad/shared";
import { inferDateOrder, labelToDate, parseLabel, toLocalIso, type DateOrder, type ParsedLabel } from "@wad/shared";
import {
  GROUP_ID_MARKER,
  GROUP_MIN_DISTINCT_SENDERS,
  GROUP_MIN_SUBTITLE_COMMAS,
  READ_MORE_TEXTS,
  SELECTORS,
  queryAll,
  queryFirst,
} from "./selectors.ts";

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
    /** Rows without a sender/time label (system notices, some media types). */
    noLabel: number;
    /** Messages with loaded photo(s) but no caption (kept with imageRefs, text ""). */
    photoOnly: number;
    /** Messages with neither text nor a loaded photo: video, voice, documents, stickers, not-yet-loaded photos. */
    otherMedia: number;
    /** Photos WhatsApp has rendered (blob) and that can be analysed on request. */
    imagesLoaded: number;
    /** Photos shown only as a blurred placeholder (not downloaded by WhatsApp). */
    imagesNotLoaded: number;
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

export const NOT_GROUP_MESSAGE =
  "Не удалось подтвердить, что это группа — личные чаты не обрабатываются. Если это группа, подождите, пока под названием появится список участников, и нажмите ↻.";

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

/**
 * true only on positive evidence of a group; false = possibly a private chat (refused);
 * null = nothing rendered yet to decide on.
 */
export function detectGroup(main: Element): boolean | null {
  const subtitle = queryFirst(main, SELECTORS.chatSubtitle)?.textContent ?? "";
  if ((subtitle.match(/,/g) ?? []).length >= GROUP_MIN_SUBTITLE_COMMAS) return true;

  const rows = queryAll(main, SELECTORS.messageRow);
  if (rows.some((r) => (r.getAttribute("data-id") ?? "").includes(GROUP_ID_MARKER))) return true;

  const senders = new Set<string>();
  for (const el of queryAll(main, SELECTORS.prePlainText)) {
    const sender = parseLabel(el.getAttribute("data-pre-plain-text") ?? "")?.sender;
    if (sender) senders.add(normalizeText(sender));
  }
  if (senders.size >= GROUP_MIN_DISTINCT_SENDERS) return true;

  return rows.length || subtitle ? false : null;
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
  return extractWithImages(doc, dateOrderFallback).result;
}

/** Loaded photos of a row (blob: URLs only — never triggers a download). */
function rowImages(row: Element): { loaded: HTMLImageElement[]; notLoaded: number } {
  const loaded: HTMLImageElement[] = [];
  let notLoaded = 0;
  for (const thumb of queryAll(row, SELECTORS.imageThumb)) {
    if (isInsideQuote(thumb, row)) continue;
    const img = Array.from(thumb.querySelectorAll("img")).find((i) => (i.getAttribute("src") ?? "").startsWith("blob:"));
    if (img) loaded.push(img);
    else notLoaded++;
  }
  return { loaded: loaded.slice(0, 4), notLoaded };
}

/**
 * Same as extractRenderedMessages, plus a map from image ref → <img> element so the content script can
 * later read the photos the user selects. The map never leaves the content script.
 */
export function extractWithImages(
  doc: Document,
  dateOrderFallback: DateOrder,
): { result: ExtractionResult | ExtractionError; images: Map<string, HTMLImageElement> } {
  const images = new Map<string, HTMLImageElement>();
  const fail = (result: ExtractionError) => ({ result, images });
  const p = probe(doc);
  if (!p.whatsappLoaded) return fail({ ok: false, code: "not_loaded", message: "WhatsApp Web не загружен или вы не вошли в аккаунт." });
  const main = queryFirst(doc, SELECTORS.mainPane);
  if (!p.chatOpen || !main) return fail({ ok: false, code: "no_chat", message: "Откройте группу в WhatsApp Web." });
  if (p.isGroup === null) {
    return fail({ ok: false, code: "unknown_chat_type", message: "Не удалось определить тип чата: в окне нет сообщений." });
  }
  if (!p.isGroup) {
    return fail({ ok: false, code: "not_group", message: NOT_GROUP_MESSAGE });
  }

  const rows = queryAll(main, SELECTORS.messageRow);
  type Pending = { key: string; label: ParsedLabel | null; text: string; imageRefs: string[] };
  const pending: Pending[] = [];
  let noLabel = 0;
  let photoOnly = 0;
  let otherMedia = 0;
  let imagesLoaded = 0;
  let imagesNotLoaded = 0;
  let truncated = 0;

  for (const row of rows) {
    const dataId = row.getAttribute("data-id") || row.getAttribute("data-testid") || "";
    if (!dataId) continue;
    // Nested message elements (e.g. inside quotes) — keep only the outermost row.
    if (row.parentElement?.closest('[data-id], [data-testid^="conv-msg-"]')) continue;

    const labelEl = queryAll(row, SELECTORS.prePlainText).find((el) => !isInsideQuote(el, row));
    if (!labelEl) {
      // System notices, some media types, deleted messages, etc.
      noLabel++;
      continue;
    }
    const textEl = queryAll(labelEl, SELECTORS.messageText).find((el) => !isInsideQuote(el, row));
    const text = textEl ? extractText(textEl) : "";
    const key = opaqueKey(dataId);
    const imgs = rowImages(row);
    imagesNotLoaded += imgs.notLoaded;
    const imageRefs = imgs.loaded.map((img, i) => {
      const ref = `${key}:${i}`;
      images.set(ref, img);
      return ref;
    });
    imagesLoaded += imageRefs.length;
    if (!text && !imageRefs.length) {
      otherMedia++;
      continue;
    }
    if (!text) photoOnly++;
    if (text && hasReadMore(row)) truncated++;
    pending.push({ key, label: parseLabel(labelEl.getAttribute("data-pre-plain-text") ?? ""), text, imageRefs });
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
      ...(x.imageRefs.length ? { imageRefs: x.imageRefs } : {}),
    };
  });

  const deduped = dedupeMessages(messages);
  if (!deduped.length) {
    return fail({ ok: false, code: "no_messages", message: "В открытом чате не найдено ни текстовых сообщений, ни фото." });
  }

  const scrollBtn = queryFirst(main, SELECTORS.scrollToBottom);
  const result: ExtractionResult = {
    ok: true,
    groupName: p.groupName ?? "Без названия",
    messages: deduped,
    stats: {
      rowsSeen: rows.length,
      untimed,
      noLabel,
      photoOnly,
      otherMedia,
      imagesLoaded,
      imagesNotLoaded,
      truncated,
      duplicatesRemoved: messages.length - deduped.length,
      dateOrder,
      dateOrderAssumed: inferred === null && labels.length > 0,
      notScrolledToBottom: !!scrollBtn && isVisible(scrollBtn),
    },
  };
  return { result, images };
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
