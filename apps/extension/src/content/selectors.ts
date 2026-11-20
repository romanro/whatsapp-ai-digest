/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  WhatsApp Web DOM adapter — ALL selectors live here.
 * ─────────────────────────────────────────────────────────────────────────────
 * WhatsApp Web's markup is undocumented and changes without notice. Each entry is
 * an ordered list of fallbacks; the first selector that matches wins.
 *
 * STATUS (checked against live WhatsApp Web on 2026-11-20, structure only — no message content was read):
 *  - message rows: div[data-testid="conv-msg-<HEX>"][data-id="<HEX>"] inside role="row";
 *    data-id NO LONGER contains the chat JID (no "@g.us"), so group detection uses the header subtitle
 *    (participant list) and the number of distinct senders instead;
 *  - "[HH:MM, D/M/YYYY] Sender: " labels on div.copyable-text[data-pre-plain-text] inside [data-testid="msg-container"];
 *  - header: [data-testid="conversation-info-header-chat-title"], [data-testid="chat-subtitle"].
 * Text extraction, quotes, "read more" and the scroll button are still NOT verified live.
 * If extraction breaks, update this file only.
 */
export const SELECTORS = {
  /** App shell — present once WhatsApp Web has loaded. */
  appRoot: ["#app"],
  /** Chat list side pane — present when logged in. */
  sidePane: ["#pane-side", "#side", '[data-testid="chat-list"]', '[aria-label="Chat list"]'],
  /** Main conversation pane — present when a chat is open. */
  mainPane: ["#main"],
  /** Title of the open conversation (inside mainPane). */
  chatTitle: [
    'header [data-testid="conversation-info-header-chat-title"]',
    "header span[dir='auto'][title]",
    "header span[title]",
    "header [dir='auto']",
  ],
  /** Subtitle under the chat title: participant list in groups, "online"/"last seen" in private chats. */
  chatSubtitle: ['header [data-testid="chat-subtitle"]'],
  /** One element per rendered message (newest UI first, legacy fallback). */
  messageRow: ['[data-testid^="conv-msg-"]', "[data-id]"],
  /** Element carrying "[HH:MM, DD/MM/YYYY] Sender: " — present on text messages. */
  prePlainText: ["[data-pre-plain-text]"],
  /** Message body text inside the pre-plain-text element. */
  messageText: ["span.selectable-text", '[data-testid="selectable-text"]', "span[dir='auto']"],
  /** Quoted (replied-to) message block — its text must not be attributed to the reply. */
  quotedMessage: ['[data-testid="quoted-message"]', '[aria-label="Quoted message"]', '[aria-label*="uoted"]'],
  /** "Read more" button on truncated long messages. */
  readMore: ['[role="button"].read-more-button', '[data-testid="read-more-button"]'],
  /** "Scroll to latest messages" button — visible when the newest messages may not be rendered. */
  scrollToBottom: ['[data-testid="scroll-to-bottom"]', '[aria-label="Scroll to bottom"]', '[data-icon="down"]'],
} as const;

/** Legacy UI: substring of a row's data-id that marks a group chat (group JIDs end with @g.us). */
export const GROUP_ID_MARKER = "@g.us";

/**
 * A chat is treated as a group only on positive evidence; otherwise it is refused as a possible private chat.
 * - subtitle lists participants ("Anna, Boris, You") → at least this many commas;
 * - a private chat can't have more than 2 distinct senders.
 */
export const GROUP_MIN_SUBTITLE_COMMAS = 2;
export const GROUP_MIN_DISTINCT_SENDERS = 3;

/** Text of "read more" buttons in supported UI languages (fallback when no selector matches). */
export const READ_MORE_TEXTS = ["read more", "читать далее", "ещё", "קרא עוד", "קרא/י עוד"];

export function queryFirst(root: ParentNode, selectors: readonly string[]): Element | null {
  for (const s of selectors) {
    try {
      const el = root.querySelector(s);
      if (el) return el;
    } catch {
      // Invalid selector in this DOM implementation — try the next fallback.
    }
  }
  return null;
}

export function queryAll(root: ParentNode, selectors: readonly string[]): Element[] {
  for (const s of selectors) {
    try {
      const els = root.querySelectorAll(s);
      if (els.length) return Array.from(els);
    } catch {
      /* next fallback */
    }
  }
  return [];
}
