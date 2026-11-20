/**
 * Synthetic DOM modelled on the publicly known WhatsApp Web structure (data-id rows,
 * data-pre-plain-text labels, span.selectable-text). Not copied from a real session; contains no real data.
 */
export interface FixtureMsg {
  id: string;
  label?: string;
  text?: string;
  html?: string;
  outgoing?: boolean;
  quote?: { label: string; text: string };
  readMore?: boolean;
  /** A photo in the bubble: loaded (blob:) or still a blurred placeholder (data:). */
  photo?: "loaded" | "notLoaded";
}

const LEGACY_GROUP = "120363000000000001@g.us";

/** Current WhatsApp Web markup (checked 2026-11-20): hex data-id, conv-msg-* testid, msg-container. */
export function row(m: FixtureMsg, opts: { legacyJid?: string } = {}): string {
  const hexId = `3EB0${m.id}`.padEnd(20, "0");
  const dataId = opts.legacyJid ? `${m.outgoing ? "true" : "false"}_${opts.legacyJid}_${m.id}_972500000000@c.us` : hexId;
  const quote = m.quote
    ? `<div aria-label="Quoted message"><div class="copyable-text" data-pre-plain-text="${m.quote.label}"><span class="selectable-text">${m.quote.text}</span></div></div>`
    : "";
  const photo = m.photo
    ? `<div data-testid="image-thumb" role="button"><img src="${
        m.photo === "loaded" ? `blob:https://web.whatsapp.com/${m.id}` : "data:image/jpeg;base64,/9j/AA=="
      }" /></div>`
    : "";
  const textSpan = m.html ?? m.text ? `<span dir="auto" class="selectable-text copyable-text">${m.html ?? m.text}</span>` : "";
  const body =
    m.label === undefined
      ? `<div class="system-notice">—</div>`
      : `<div class="copyable-text" data-pre-plain-text="${m.label}">${quote}${photo}${textSpan}${
          m.readMore ? '<div role="button">Read more</div>' : ""
        }</div>`;
  return `<div role="row"><div data-testid="conv-msg-${hexId}" data-id="${dataId}"><div class="focusable-list-item"><div data-testid="msg-container">${body}</div></div></div></div>`;
}

export { LEGACY_GROUP };

export function buildDoc(
  doc: Document,
  opts: { title?: string; subtitle?: string; rows?: string[]; loggedIn?: boolean; chatOpen?: boolean; scrollButton?: boolean },
): Document {
  const {
    title = "Родители 3А · גן שושנה",
    subtitle = "Анна, Борис, Ганенет, Вы",
    rows = [],
    loggedIn = true,
    chatOpen = true,
    scrollButton = false,
  } = opts;
  doc.body.innerHTML = `
    <div id="app">
      ${loggedIn ? '<div id="side"><div id="pane-side"></div></div>' : ""}
      ${
        chatOpen
          ? `<div id="main">
              <header><div data-testid="conversation-info-header">
                <span data-testid="conversation-info-header-chat-title" dir="auto">${title}</span>
                <div data-testid="chat-subtitle"><span>${subtitle}</span></div>
              </div></header>
              <div class="messages">${rows.join("")}</div>
              ${scrollButton ? '<button data-testid="scroll-to-bottom">↓</button>' : ""}
            </div>`
          : ""
      }
    </div>`;
  return doc;
}
