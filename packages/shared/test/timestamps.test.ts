import { describe, expect, it } from "vitest";
import { formatWallTime, inferDateOrder, labelToDate, parseLabel, toLocalIso } from "../src/timestamps.ts";

describe("parseLabel", () => {
  it("parses 24h DMY labels with Russian sender", () => {
    expect(parseLabel("[14:32, 20/11/2026] Анна Петрова: ")).toEqual({ parts: [20, 11, 2026], hour: 14, minute: 32, sender: "Анна Петрова" });
  });

  it("parses 12h US labels", () => {
    const l = parseLabel("[2:05 PM, 11/20/2026] John: ");
    expect(l).toMatchObject({ parts: [11, 20, 2026], hour: 14, minute: 5, sender: "John" });
    expect(parseLabel("[12:10 AM, 11/20/2026] John: ")?.hour).toBe(0);
    expect(parseLabel("[12:10 PM, 11/20/2026] John: ")?.hour).toBe(12);
  });

  it("parses dotted dates and Hebrew senders wrapped in bidi marks", () => {
    expect(parseLabel("‏[09:00, 20.11.2026] ‏אמא של נועה: ")).toMatchObject({
      parts: [20, 11, 2026],
      hour: 9,
      sender: "אמא של נועה",
    });
  });

  it("keeps colons inside sender names", () => {
    expect(parseLabel("[09:00, 20.11.2026] Класс 3: родители: ")?.sender).toBe("Класс 3: родители");
  });

  it("returns null for garbage or impossible times — never guesses", () => {
    expect(parseLabel("hello")).toBeNull();
    expect(parseLabel("[25:00, 20/11/2026] X: ")).toBeNull();
    expect(parseLabel("[13:00 PM, 11/20/2026] X: ")).toBeNull();
  });
});

describe("inferDateOrder", () => {
  const L = (a: number, b: number, c: number) => ({ parts: [a, b, c] as [number, number, number], hour: 0, minute: 0, sender: null });
  it("detects DMY when a first part > 12", () => expect(inferDateOrder([L(5, 11, 2026), L(20, 11, 2026)])).toBe("DMY"));
  it("detects MDY when a second part > 12", () => expect(inferDateOrder([L(11, 20, 2026)])).toBe("MDY"));
  it("detects YMD", () => expect(inferDateOrder([L(2026, 11, 20)])).toBe("YMD"));
  it("returns null when ambiguous", () => expect(inferDateOrder([L(5, 11, 2026), L(6, 11, 2026)])).toBeNull());
});

describe("labelToDate / toLocalIso", () => {
  it("builds local dates and rejects impossible ones", () => {
    const l = parseLabel("[14:32, 20/11/2026] A: ");
    expect(l).not.toBeNull();
    const d = labelToDate(l!, "DMY");
    expect(d?.getTime()).toBe(new Date(2026, 10, 20, 14, 32).getTime());
    expect(labelToDate(l!, "MDY")).toBeNull(); // month 20 is impossible
    expect(labelToDate(parseLabel("[10:00, 31/02/2026] A: ")!, "DMY")).toBeNull(); // no rollover to March
  });

  it("expands two-digit years", () => {
    expect(labelToDate(parseLabel("[10:00, 20/11/26] A: ")!, "DMY")?.getFullYear()).toBe(2026);
  });

  it("produces ISO with offset that preserves wall time", () => {
    const iso = toLocalIso(new Date(2026, 10, 20, 7, 5));
    expect(iso).toMatch(/^2026-11-20T07:05:00[+-]\d{2}:\d{2}$/);
    expect(Date.parse(iso)).toBe(new Date(2026, 10, 20, 7, 5).getTime());
    expect(formatWallTime(iso)).toBe("20.11 07:05");
  });
});
