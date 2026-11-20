/**
 * Text normalization for multilingual (Hebrew / Russian / English) WhatsApp messages.
 * Pure functions — safe to use in the content script, popup and server.
 */

/** Bidi control / zero-width characters WhatsApp and phones inject around RTL text and mentions. */
// LRM, RLM, ALM, LRE..RLO, LRI..PDI, ZWSP, ZWNJ is meaningful in some scripts (kept), ZWJ kept (emoji), BOM.
const INVISIBLE_RE = /[​‎‏؜‪-‮⁦-⁩﻿]/g;

export function normalizeText(input: string): string {
  return (
    input
      .normalize("NFC")
      .replace(INVISIBLE_RE, "")
      // non-breaking & other unicode spaces → regular space
      .replace(/[  -   　]/g, " ")
      .replace(/\r\n?/g, "\n")
      // collapse runs of spaces/tabs but keep line breaks
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

export function normalizeSender(input: string | null | undefined): string | null {
  if (input == null) return null;
  const s = normalizeText(input).replace(/\n/g, " ");
  return s.length > 0 ? s : null;
}

export interface RawMessage {
  /** Stable key for the DOM element (already hashed — never contains phone numbers). */
  key: string;
  sender: string | null;
  /** Local ISO timestamp, or null when it could not be determined (never guessed). */
  timestamp: string | null;
  text: string;
}

/**
 * Removes duplicates while preserving original order.
 * Two messages are duplicates if they share a DOM key, or if sender + timestamp + normalized text match
 * (WhatsApp sometimes re-renders the same bubble under a new node during virtualization).
 */
export function dedupeMessages<T extends RawMessage>(messages: readonly T[]): T[] {
  const seenKeys = new Set<string>();
  const seenContent = new Set<string>();
  const out: T[] = [];
  for (const m of messages) {
    const contentKey = `${m.sender ?? ""}\u0000${m.timestamp ?? ""}\u0000${normalizeText(m.text)}`;
    if (seenKeys.has(m.key)) continue;
    if (m.timestamp !== null && seenContent.has(contentKey)) continue;
    seenKeys.add(m.key);
    if (m.timestamp !== null) seenContent.add(contentKey);
    out.push(m);
  }
  return out;
}

/** FNV-1a 32-bit hash → base36. Used to turn WhatsApp DOM ids (which embed phone numbers) into opaque keys. */
export function opaqueKey(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Script detection — used for diagnostics and tests of mixed-language handling. */
export function detectScripts(text: string): { hebrew: boolean; cyrillic: boolean; latin: boolean } {
  return {
    hebrew: /[֐-׿]/.test(text),
    cyrillic: /[Ѐ-ӿ]/.test(text),
    latin: /[A-Za-z]/.test(text),
  };
}
