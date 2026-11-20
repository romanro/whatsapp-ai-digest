import { beforeEach, describe, expect, it } from "vitest";
import { extractRenderedMessages, probe } from "../src/content/extractor.ts";
import { buildDoc, row } from "./dom-fixture.ts";

beforeEach(() => {
  document.body.innerHTML = "";
});

const standard = [
  row({ id: "A1", label: "[09:15, 19/11/2026] Мама Ани: ", text: "Доброе утро!" }),
  row({ id: "A2", label: "[20:30, 19/11/2026] \u200Fאמא של נועה: ", html: "מחר יום פיג'מה <img alt=\"🧸\" src=\"x\"> בגן" }),
  row({ id: "A3", label: "[08:05, 20/11/2026] Ваад: ", html: "Сдаём по 50 ₪<br>до пятницы" }),
  row({ id: "A4" }), // media without caption
  row({
    id: "A5",
    label: "[12:00, 20/11/2026] Ganenet: ",
    text: "Moved to Monday",
    quote: { label: "[10:00, 14/11/2026] Ganenet: ", text: "Zoo trip on Sunday" },
  }),
];

describe("probe", () => {
  it("detects a loaded WhatsApp Web with an open group chat", () => {
    buildDoc(document, { rows: standard });
    expect(probe(document)).toEqual({ whatsappLoaded: true, chatOpen: true, groupName: "Родители 3А · גן שושנה", isGroup: true });
  });

  it("reports not loaded / no chat", () => {
    buildDoc(document, { loggedIn: false });
    expect(probe(document).whatsappLoaded).toBe(false);
    buildDoc(document, { chatOpen: false });
    expect(probe(document)).toMatchObject({ whatsappLoaded: true, chatOpen: false });
  });

  it("identifies private chats as not groups", () => {
    buildDoc(document, { rows: [row({ id: "P1", label: "[09:00, 20/11/2026] Friend: ", text: "hi" }, "972500000009@c.us")] });
    expect(probe(document).isGroup).toBe(false);
  });
});

describe("extractRenderedMessages", () => {
  it("extracts sender, local timestamp and text in original order (Hebrew, Russian, English)", () => {
    buildDoc(document, { rows: standard });
    const r = extractRenderedMessages(document, "DMY");
    if (!r.ok) throw new Error(r.message);
    expect(r.groupName).toBe("Родители 3А · גן שושנה");
    expect(r.messages.map((m) => [m.sender, m.text])).toEqual([
      ["Мама Ани", "Доброе утро!"],
      ["אמא של נועה", "מחר יום פיג'מה 🧸 בגן"],
      ["Ваад", "Сдаём по 50 ₪\nдо пятницы"],
      ["Ganenet", "Moved to Monday"],
    ]);
    expect(Date.parse(r.messages[2]!.timestamp!)).toBe(new Date(2026, 10, 20, 8, 5).getTime());
    expect(r.stats).toMatchObject({ skippedNonText: 1, untimed: 0, dateOrder: "DMY", dateOrderAssumed: false, notScrolledToBottom: false });
  });

  it("excludes quoted text from the reply", () => {
    buildDoc(document, { rows: standard });
    const r = extractRenderedMessages(document, "DMY");
    expect(r.ok && r.messages.some((m) => m.text.includes("Zoo trip on Sunday"))).toBe(false);
  });

  it("uses opaque keys that never contain phone numbers", () => {
    buildDoc(document, { rows: standard });
    const r = extractRenderedMessages(document, "DMY");
    expect(r.ok && r.messages.every((m) => !/\d{6,}/.test(m.key) && !m.key.includes("@"))).toBe(true);
  });

  it("removes duplicate rows rendered twice", () => {
    buildDoc(document, { rows: [...standard, standard[2]!] });
    const r = extractRenderedMessages(document, "DMY");
    expect(r.ok && r.messages.length).toBe(4);
    expect(r.ok && r.stats.duplicatesRemoved).toBe(1);
  });

  it("infers MDY from US-style labels and parses AM/PM", () => {
    buildDoc(document, { rows: [row({ id: "U1", label: "[2:05 PM, 11/20/2026] John: ", text: "Bake sale tomorrow" })] });
    const r = extractRenderedMessages(document, "DMY");
    if (!r.ok) throw new Error(r.message);
    expect(r.stats.dateOrder).toBe("MDY");
    expect(Date.parse(r.messages[0]!.timestamp!)).toBe(new Date(2026, 10, 20, 14, 5).getTime());
  });

  it("uses the fallback order and flags it when dates are ambiguous", () => {
    buildDoc(document, { rows: [row({ id: "Z1", label: "[10:00, 05/11/2026] A: ", text: "x" })] });
    const r = extractRenderedMessages(document, "DMY");
    expect(r.ok && r.stats.dateOrderAssumed).toBe(true);
    expect(r.ok && new Date(r.messages[0]!.timestamp!).getMonth()).toBe(10); // November
  });

  it("keeps messages with unparseable labels but never invents a timestamp", () => {
    buildDoc(document, { rows: [row({ id: "B1", label: "[weird] A: ", text: "hello" })] });
    const r = extractRenderedMessages(document, "DMY");
    expect(r.ok && r.messages[0]!.timestamp).toBeNull();
    expect(r.ok && r.stats.untimed).toBe(1);
  });

  it("flags truncated messages and an unscrolled chat", () => {
    buildDoc(document, { scrollButton: true, rows: [row({ id: "R1", label: "[10:00, 20/11/2026] A: ", text: "Long…", readMore: true })] });
    const r = extractRenderedMessages(document, "DMY");
    expect(r.ok && r.stats.truncated).toBe(1);
    expect(r.ok && r.stats.notScrolledToBottom).toBe(true);
  });

  it("refuses private chats, missing chats and not-loaded pages", () => {
    buildDoc(document, { rows: [row({ id: "P1", label: "[09:00, 20/11/2026] Friend: ", text: "hi" }, "972500000009@c.us")] });
    expect(extractRenderedMessages(document, "DMY")).toMatchObject({ ok: false, code: "not_group" });
    buildDoc(document, { chatOpen: false });
    expect(extractRenderedMessages(document, "DMY")).toMatchObject({ ok: false, code: "no_chat" });
    buildDoc(document, { loggedIn: false });
    expect(extractRenderedMessages(document, "DMY")).toMatchObject({ ok: false, code: "not_loaded" });
  });

  it("does not modify the page (read-only)", () => {
    buildDoc(document, { rows: standard });
    const before = document.body.innerHTML;
    extractRenderedMessages(document, "DMY");
    expect(document.body.innerHTML).toBe(before);
  });
});
