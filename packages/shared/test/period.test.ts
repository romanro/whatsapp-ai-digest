import { describe, expect, it } from "vitest";
import { detectCoverage, filterByPeriod, periodStart } from "../src/period.ts";
import { NOW, SYNTHETIC_MESSAGES } from "./fixtures/messages.ts";

const base = { untimedCount: 0, skippedNonText: 0, notScrolledToBottom: false, dateOrderAssumed: false };

describe("filterByPeriod", () => {
  it("keeps only messages within the last 24 hours, in original order", () => {
    const out = filterByPeriod(SYNTHETIC_MESSAGES, "24h", NOW);
    expect(out.map((m) => m.key)).toEqual(["k3", "k4", "k5", "k6"]);
  });

  it("3 days and 7 days widen the window", () => {
    expect(filterByPeriod(SYNTHETIC_MESSAGES, "3d", NOW).map((m) => m.key)).toEqual(["k3", "k4", "k5", "k6"]);
    expect(filterByPeriod(SYNTHETIC_MESSAGES, "7d", NOW).map((m) => m.key)).toEqual(["k2", "k3", "k4", "k5", "k6"]);
  });

  it("excludes messages without a timestamp instead of guessing", () => {
    expect(filterByPeriod(SYNTHETIC_MESSAGES, "7d", NOW).some((m) => m.key === "k7")).toBe(false);
  });

  it("excludes messages far in the future", () => {
    const future = [{ timestamp: new Date(NOW.getTime() + 3600_000).toISOString() }];
    expect(filterByPeriod(future, "24h", NOW)).toHaveLength(0);
  });

  it("computes the period start", () => {
    expect(NOW.getTime() - periodStart("3d", NOW).getTime()).toBe(72 * 3600_000);
  });
});

describe("detectCoverage (incomplete history detection)", () => {
  it("is complete when loaded history reaches before the period start", () => {
    const c = detectCoverage({ ...base, loaded: SYNTHETIC_MESSAGES, period: "24h", now: NOW });
    expect(c.fullyCovered).toBe(true);
    expect(c.warnings).toEqual([]);
  });

  it("is incomplete when the oldest loaded message is newer than the period start", () => {
    // Only the last few days are rendered (user didn't scroll up far enough).
    const c = detectCoverage({ ...base, loaded: SYNTHETIC_MESSAGES.slice(2), period: "7d", now: NOW });
    expect(c.fullyCovered).toBe(false);
    expect(c.warnings[0]).toMatch(/Загружены сообщения только начиная с 19\.11/);
  });

  it("is incomplete when nothing has a timestamp", () => {
    const c = detectCoverage({ ...base, loaded: [{ timestamp: null }], period: "24h", now: NOW });
    expect(c.fullyCovered).toBe(false);
    expect(c.oldestLoaded).toBeNull();
  });

  it("is incomplete when the chat is not scrolled to the newest message", () => {
    const c = detectCoverage({ ...base, notScrolledToBottom: true, loaded: SYNTHETIC_MESSAGES, period: "24h", now: NOW });
    expect(c.fullyCovered).toBe(false);
  });

  it("reports skipped and untimed messages without marking coverage incomplete", () => {
    const c = detectCoverage({ ...base, untimedCount: 2, skippedNonText: 3, loaded: SYNTHETIC_MESSAGES, period: "24h", now: NOW });
    expect(c.fullyCovered).toBe(true);
    expect(c.warnings).toHaveLength(2);
  });
});
