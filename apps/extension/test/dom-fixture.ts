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
}

const GROUP = "120363000000000001@g.us";

export function row(m: FixtureMsg, chatJid = GROUP): string {
  const dataId = `${m.outgoing ? "true" : "false"}_${chatJid}_${m.id}_972500000000@c.us`;
  const quote = m.quote
    ? `<div aria-label="Quoted message"><div class="copyable-text" data-pre-plain-text="${m.quote.label}"><span class="selectable-text">${m.quote.text}</span></div></div>`
    : "";
  const body =
    m.label === undefined
      ? `<div class="media"><img src="blob:x" /></div>`
      : `<div class="copyable-text" data-pre-plain-text="${m.label}">${quote}<span dir="auto" class="selectable-text copyable-text">${m.html ?? m.text ?? ""}</span>${
          m.readMore ? '<div role="button">Read more</div>' : ""
        }</div>`;
  return `<div role="row"><div data-id="${dataId}">${body}</div></div>`;
}

export function buildDoc(
  doc: Document,
  opts: { title?: string; rows?: string[]; loggedIn?: boolean; chatOpen?: boolean; scrollButton?: boolean },
): Document {
  const { title = "Родители 3А · גן שושנה", rows = [], loggedIn = true, chatOpen = true, scrollButton = false } = opts;
  doc.body.innerHTML = `
    <div id="app">
      ${loggedIn ? '<div id="side"><div id="pane-side"></div></div>' : ""}
      ${
        chatOpen
          ? `<div id="main">
              <header><span dir="auto" title="${title}">${title}</span></header>
              <div class="messages">${rows.join("")}</div>
              ${scrollButton ? '<button data-testid="scroll-to-bottom">↓</button>' : ""}
            </div>`
          : ""
      }
    </div>`;
  return doc;
}
