import { describe, expect, it } from "vitest";
import { dedupeMessages, detectScripts, normalizeSender, normalizeText, opaqueKey } from "../src/normalize.ts";
import type { RawMessage } from "../src/normalize.ts";

describe("normalizeText", () => {
  it("removes bidi control marks around Hebrew while keeping the text", () => {
    expect(normalizeText("\u200Fשלום\u200E  עולם\u202B!\u202C")).toBe("שלום עולם!");
  });

  it("applies NFC so composed and decomposed Cyrillic compare equal", () => {
    const decomposed = "й"; // и + combining breve
    expect(normalizeText(decomposed)).toBe("й");
  });

  it("keeps Russian, Hebrew, English and emoji intact", () => {
    const s = "Завтра מחר tomorrow 🎉";
    expect(normalizeText(s)).toBe(s);
    expect(detectScripts(s)).toEqual({ hebrew: true, cyrillic: true, latin: true });
  });

  it("collapses spaces, converts NBSP, keeps single line breaks and trims", () => {
    expect(normalizeText("  a\u00A0\u00A0b \r\n\r\n\r\n c\t\td  ")).toBe("a b\n\nc d");
  });

  it("normalizes sender labels to one line or null", () => {
    expect(normalizeSender("  Анна\nК.  ")).toBe("Анна К.");
    expect(normalizeSender("\u200E")).toBeNull();
    expect(normalizeSender(null)).toBeNull();
  });
});

describe("dedupeMessages", () => {
  const base: RawMessage = { key: "a", sender: "Анна", timestamp: "2026-11-20T10:00:00+02:00", text: "Привет" };

  it("drops repeated DOM keys and preserves order", () => {
    const out = dedupeMessages([base, { ...base, key: "b", text: "Второе" }, { ...base }]);
    expect(out.map((m) => m.key)).toEqual(["a", "b"]);
  });

  it("drops re-rendered bubbles with same sender/time/text under a new key", () => {
    const out = dedupeMessages([base, { ...base, key: "zz", text: " Привет " }]);
    expect(out).toHaveLength(1);
  });

  it("keeps identical text sent at different times (e.g. two '+1' replies)", () => {
    const out = dedupeMessages([base, { ...base, key: "c", timestamp: "2026-11-20T10:01:00+02:00" }]);
    expect(out).toHaveLength(2);
  });

  it("does not merge untimed messages by content", () => {
    const u = { ...base, timestamp: null };
    expect(dedupeMessages([u, { ...u, key: "d" }])).toHaveLength(2);
  });
});

describe("opaqueKey", () => {
  it("is deterministic and does not leak phone digits from WhatsApp data-ids", () => {
    const id = "false_120363000000000000@g.us_3EB0AAAA_972500000001@c.us";
    expect(opaqueKey(id)).toBe(opaqueKey(id));
    expect(opaqueKey(id)).not.toContain("972500000001");
    expect(opaqueKey(id)).toMatch(/^[a-z0-9]+$/);
  });
});
