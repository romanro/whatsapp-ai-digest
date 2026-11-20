import { beforeEach, describe, expect, it } from "vitest";
import { extractRenderedMessages, extractWithImages, probe } from "../src/content/extractor.ts";
import { LEGACY_GROUP, buildDoc, row } from "./dom-fixture.ts";

beforeEach(() => {
  document.body.innerHTML = "";
});

const standard = [
  row({ id: "A1", label: "[09:15, 19/11/2026] Мама Ани: ", text: "Доброе утро!" }),
  row({ id: "A2", label: "[20:30, 19/11/2026] \u200Fאמא של נועה: ", html: "מחר יום פיג'מה <img alt=\"🧸\" src=\"x\"> בגן" }),
  row({ id: "A3", label: "[08:05, 20/11/2026] Ваад: ", html: "Сдаём по 50 ₪<br>до пятницы" }),
  row({ id: "A4" }), // system notice / unlabeled row
  row({
    id: "A5",
    label: "[12:00, 20/11/2026] Ganenet: ",
    text: "Moved to Monday",
    quote: { label: "[10:00, 14/11/2026] Ganenet: ", text: "Zoo trip on Sunday" },
  }),
];

const privateRows = [
  row({ id: "P1", label: "[09:00, 20/11/2026] Friend: ", text: "hi" }),
  row({ id: "P2", label: "[09:01, 20/11/2026] Я: ", text: "hello" }),
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

  it("does not treat a private chat as a group (subtitle 'last seen', ≤2 senders)", () => {
    buildDoc(document, { subtitle: "last seen today at 10:00", rows: privateRows });
    expect(probe(document).isGroup).toBe(false);
    buildDoc(document, { subtitle: "был(а) 20 нояб., 2026 в 10:00", rows: privateRows });
    expect(probe(document).isGroup).toBe(false);
  });

  it("recognises a group by the participant list in the subtitle", () => {
    buildDoc(document, { subtitle: "Анна, Борис, Вы", rows: privateRows });
    expect(probe(document).isGroup).toBe(true);
  });

  it("recognises a group by ≥3 distinct senders when the subtitle shows no list yet", () => {
    buildDoc(document, { subtitle: "нажмите здесь, чтобы открыть данные группы", rows: standard });
    expect(probe(document).isGroup).toBe(true);
  });

  it("refuses a group it can't confirm (2 senders, no participant list) — fails safe", () => {
    buildDoc(document, { subtitle: "", rows: privateRows });
    expect(probe(document).isGroup).toBe(false);
  });

  it("still supports the legacy @g.us data-id format", () => {
    buildDoc(document, { subtitle: "", rows: [row({ id: "L1", label: "[09:00, 20/11/2026] A: ", text: "x" }, { legacyJid: LEGACY_GROUP })] });
    expect(probe(document).isGroup).toBe(true);
  });

  it("returns null when nothing is rendered to decide on", () => {
    buildDoc(document, { subtitle: "", rows: [] });
    expect(probe(document).isGroup).toBeNull();
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
    expect(r.stats).toMatchObject({ noLabel: 1, photoOnly: 0, otherMedia: 0, untimed: 0, dateOrder: "DMY", dateOrderAssumed: false, notScrolledToBottom: false });
  });

  it("finds loaded photos (captionless and captioned) without touching placeholders", () => {
    buildDoc(document, {
      rows: [
        row({ id: "F1", label: "[10:00, 20/11/2026] Ganenet: ", photo: "loaded" }),
        row({ id: "F2", label: "[10:01, 20/11/2026] Ganenet: ", photo: "loaded", text: "ДЗ на завтра" }),
        row({ id: "F3", label: "[10:02, 20/11/2026] Ganenet: ", photo: "notLoaded" }),
        row({ id: "F4", label: "[10:03, 20/11/2026] Ganenet: ", text: "Спасибо" }),
      ],
    });
    const { result: r, images } = extractWithImages(document, "DMY");
    if (!r.ok) throw new Error(r.message);
    expect(r.messages.map((m) => [m.text, m.imageRefs?.length ?? 0])).toEqual([
      ["", 1],
      ["ДЗ на завтра", 1],
      ["Спасибо", 0],
    ]);
    expect(r.stats).toMatchObject({ photoOnly: 1, otherMedia: 1, imagesLoaded: 2, imagesNotLoaded: 1 });
    const ref = r.messages[0]!.imageRefs![0]!;
    expect(images.get(ref)?.getAttribute("src")).toBe("blob:https://web.whatsapp.com/F1");
    // The refs never expose WhatsApp ids or blob URLs.
    expect(ref).not.toMatch(/blob:|3EB0/);
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
    buildDoc(document, { subtitle: "online", rows: privateRows });
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
