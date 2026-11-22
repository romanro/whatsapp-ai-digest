import { describe, expect, it } from "vitest";
import { matchDownloads } from "../src/lib/downloads.ts";

describe("matchDownloads", () => {
  const items = [
    { filename: "/Users/a/Downloads/Расписание.pdf", state: "complete", exists: true, startTime: "2026-11-20T10:00:00Z" },
    { filename: "/Users/a/Downloads/Расписание (1).pdf", state: "complete", exists: true, startTime: "2026-11-21T10:00:00Z" },
    { filename: "C:\\Users\\a\\Downloads\\שיעור בישול.docx", state: "complete", exists: true, startTime: "2026-11-21T09:00:00Z" },
    { filename: "/Users/a/Downloads/deleted.pdf", state: "complete", exists: false, startTime: "2026-11-21T09:00:00Z" },
    { filename: "/Users/a/Downloads/partial.pdf", state: "in_progress", startTime: "2026-11-21T09:00:00Z" },
  ];

  it("finds the newest download with the document's name (ignoring the browser's (1) suffix and path style)", () => {
    expect(matchDownloads(["Расписание.pdf", "שיעור בישול.docx"], items)).toEqual([
      { path: "/Users/a/Downloads/Расписание (1).pdf", name: "Расписание (1).pdf" },
      { path: "C:\\Users\\a\\Downloads\\שיעור בישול.docx", name: "שיעור בישול.docx" },
    ]);
  });

  it("skips deleted, unfinished and unknown files", () => {
    expect(matchDownloads(["deleted.pdf", "partial.pdf", "other.pdf"], items)).toEqual([null, null, null]);
  });
});
