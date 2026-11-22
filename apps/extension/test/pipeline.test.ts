import { describe, expect, it } from "vitest";
import { SummarizeRequestSchema, type RawMessage } from "@wad/shared";
import { attachImages, preparePayload } from "../src/lib/pipeline.ts";
import type { ExtractionResult } from "../src/lib/protocol.ts";

const NOW = new Date(2026, 10, 20, 18, 0);
const iso = (d: number, h: number) => {
  const dt = new Date(2026, 10, d, h, 0);
  const off = -dt.getTimezoneOffset();
  const p = (n: number) => String(Math.abs(n)).padStart(2, "0");
  return `2026-11-${p(d)}T${p(h)}:00:00${off >= 0 ? "+" : "-"}${p(Math.trunc(off / 60))}:${p(off % 60)}`;
};

const extraction = (messages: RawMessage[], stats: Partial<ExtractionResult["stats"]> = {}): ExtractionResult => ({
  ok: true,
  groupName: "Тестовая группа",
  messages,
  stats: {
    rowsSeen: messages.length,
    untimed: 0,
    noLabel: 0,
    photoOnly: 0,
    otherMedia: 0,
    imagesLoaded: 0,
    imagesNotLoaded: 0,
    truncated: 0,
    photoDateUncertain: 0,
    duplicatesRemoved: 0,
    dateOrder: "DMY",
    dateOrderAssumed: false,
    notScrolledToBottom: false,
    ...stats,
  },
});

describe("preparePayload", () => {
  const msgs: RawMessage[] = [
    { key: "k1", sender: "Анна", timestamp: iso(15, 9), text: "старое" },
    { key: "k2", sender: "+972 50-000-0001", timestamp: iso(20, 9), text: "Мой номер 050-000-0002, почта a.test@example.com" },
    { key: "k3", sender: "אמא של נועה", timestamp: iso(20, 10), text: "מחר יום פיג'מה" },
  ];

  it("filters to the period, redacts and builds a schema-valid request with consent", () => {
    const r = preparePayload(extraction(msgs), "24h", NOW);
    if ("empty" in r) throw new Error("unexpected empty");
    expect(SummarizeRequestSchema.safeParse(r.request).success).toBe(true);
    expect(r.request.consentConfirmed).toBe(true);
    expect(r.request.messages.map((m) => m.id)).toEqual(["k2", "k3"]);
    const json = JSON.stringify(r.request);
    expect(json).not.toMatch(/050-000-0002|50-000-0001|a\.test@example\.com/);
    expect(r.request.messages[0]?.sender).toBe("Участник 1");
    expect(r.redactions).toMatchObject({ phones: 1, emails: 1 });
    expect(r.coverage.fullyCovered).toBe(true);
  });

  it("marks coverage incomplete and explains why", () => {
    const r = preparePayload(extraction(msgs.slice(1), { truncated: 2 }), "3d", NOW);
    if ("empty" in r) throw new Error("unexpected empty");
    expect(r.coverage.fullyCovered).toBe(false);
    expect(r.coverage.warnings.join(" ")).toMatch(/Читать далее/);
  });

  it("returns empty when nothing is in the period", () => {
    expect("empty" in preparePayload(extraction(msgs.slice(0, 1)), "24h", NOW)).toBe(true);
  });
});

describe("photos", () => {
  const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";
  const msgs: RawMessage[] = [
    { key: "t1", sender: "Ваад", timestamp: iso(20, 8), text: "Сдаём по 50 ₪" },
    { key: "p1", sender: "Ganenet", timestamp: iso(20, 9), text: "", imageRefs: ["p1:0"] },
    { key: "p2", sender: "Ganenet", timestamp: iso(20, 10), text: "ДЗ", imageRefs: ["p2:0", "p2:1"] },
    { key: "p3", sender: "Ganenet", timestamp: iso(20, 11), text: "", imageRefs: ["p3:0"] },
  ];
  const ex = () => extraction(msgs, { photoOnly: 2, imagesLoaded: 4, imagesNotLoaded: 1, otherMedia: 3 });

  it("text-only mode drops captionless photos and says how many were photos", () => {
    const r = preparePayload(ex(), "24h", NOW);
    if ("empty" in r) throw new Error("unexpected empty");
    expect(r.request.messages.map((m) => m.id)).toEqual(["t1", "p2"]);
    expect(r.imageCandidates).toEqual([]);
    expect(r.coverage.warnings.join(" ")).toMatch(/5 медиа-сообщ\. без текста пропущено \(из них фото: 2\)/);
  });

  it("photo mode picks the newest photos up to the limit and keeps their messages", () => {
    const r = preparePayload(ex(), "24h", NOW, { includeImages: true, maxImages: 3 });
    if ("empty" in r) throw new Error("unexpected empty");
    expect(r.imageCandidates.map((c) => c.ref)).toEqual(["p3:0", "p2:0", "p2:1"]);
    expect(r.imagesOverLimit).toBe(1);
    // p1's only photo is over the limit and it has no text → not sent.
    expect(r.request.messages.map((m) => m.id)).toEqual(["t1", "p2", "p3"]);
    expect(r.coverage.warnings.join(" ")).toMatch(/1 фото WhatsApp ещё не загрузил/);
    expect(r.coverage.warnings.join(" ")).toMatch(/только 3 самых новых фото из 4/);
  });

  it("attaches only selected, successfully read photos and drops empty photo messages", () => {
    const r = preparePayload(ex(), "24h", NOW, { includeImages: true, maxImages: 10 });
    if ("empty" in r) throw new Error("unexpected empty");
    const captured = [
      { ref: "p3:0", dataUrl: JPEG, width: 800, height: 600 },
      { ref: "p2:0", dataUrl: JPEG, width: 800, height: 600 },
      { ref: "p2:1", dataUrl: null, width: 0, height: 0 },
      { ref: "p1:0", dataUrl: JPEG, width: 800, height: 600 },
    ];
    const { request, photosSent } = attachImages(r, captured, new Set(["p2:0", "p2:1", "p1:0"]));
    expect(photosSent).toBe(2);
    expect(request.images.map((i) => i.messageId)).toEqual(["p2", "p1"]);
    expect(request.messages.map((m) => m.id)).toEqual(["t1", "p1", "p2"]); // p3 deselected and captionless
    expect(SummarizeRequestSchema.safeParse(request).success).toBe(true);
  });
});
