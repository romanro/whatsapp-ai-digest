/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  WhatsApp Web DOM adapter — ALL selectors live here.
 * ─────────────────────────────────────────────────────────────────────────────
 * WhatsApp Web's markup is undocumented and changes without notice. Each entry is
 * an ordered list of fallbacks; the first selector that matches wins.
 *
 * STATUS: written against the publicly known structure of WhatsApp Web
 * (`data-id` message rows, `data-pre-plain-text` labels, `span.selectable-text`).
 * NOT verified against the live UI by the author — requires manual validation
 * (see README → "Manual testing"). If extraction breaks, update this file only.
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
  /** One element per rendered message bubble row; its data-id encodes chat & message ids. */
  messageRow: ["[data-id]"],
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

/** Substring of a row's data-id that marks a group chat (WhatsApp group JIDs end with @g.us). */
export const GROUP_ID_MARKER = "@g.us";

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
