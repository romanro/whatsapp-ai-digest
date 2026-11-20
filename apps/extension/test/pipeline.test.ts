import { describe, expect, it } from "vitest";
import { SummarizeRequestSchema, type RawMessage } from "@wad/shared";
import { preparePayload } from "../src/lib/pipeline.ts";
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
    skippedNonText: 0,
    truncated: 0,
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
