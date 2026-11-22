/**
 * Finds documents the user downloaded from WhatsApp in Chrome's download history, so they don't have to be picked by
 * hand. Only the path is taken from Chrome; the local server reads that one file (`/api/local-document`).
 */
import { normalizeDocName } from "./documents.ts";

export interface DownloadedFile {
  path: string;
  /** File name as saved (may carry the browser's " (1)" suffix). */
  name: string;
}

export interface DownloadLike {
  filename: string;
  state?: string;
  exists?: boolean;
  startTime?: string;
}

export const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/**
 * For each wanted document name, the newest completed, still existing download with the same name.
 * WhatsApp saves documents under their original name, so names match after normalization.
 */
export function matchDownloads(names: readonly string[], items: readonly DownloadLike[]): (DownloadedFile | null)[] {
  const newestFirst = items
    .filter((d) => d.state === "complete" && d.exists !== false && d.filename)
    .slice()
    .sort((a, b) => (b.startTime ?? "").localeCompare(a.startTime ?? ""));
  return names.map((wanted) => {
    const key = normalizeDocName(wanted);
    const hit = newestFirst.find((d) => normalizeDocName(baseName(d.filename)) === key);
    return hit ? { path: hit.filename, name: baseName(hit.filename) } : null;
  });
}

export async function findDownloads(names: readonly string[]): Promise<(DownloadedFile | null)[]> {
  if (!names.length || !chrome.downloads?.search) return names.map(() => null);
  const items = await chrome.downloads.search({ state: "complete", exists: true, orderBy: ["-startTime"], limit: 1000 });
  return matchDownloads(names, items);
}
