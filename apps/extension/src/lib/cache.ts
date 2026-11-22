import { LIMITS, type ImageReading, type SummarizeRequest, type SummarizeResponse } from "@wad/shared";
import type { SummaryPhotos } from "./jobs.ts";

/**
 * What the extension remembers between runs (chrome.storage.local, i.e. on disk in the Chrome profile):
 * - per-group checkbox state (consents, photo analysis);
 * - the last summary of each group (with the photos it cites) and a fingerprint of what was sent for it;
 * - photo readings by photo hash, so a photo is sent to the AI only once.
 * "Удалить сохранённые данные" in the settings removes all of it.
 */
export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export const chromeLocal: KV = {
  get: async <T>(key: string) => (await chrome.storage.local.get(key))[key] as T | undefined,
  set: (items) => chrome.storage.local.set(items),
  remove: (keys) => chrome.storage.local.remove(keys),
};

const PREFS_KEY = "groupPrefs";
const READINGS_KEY = "photoReadings";
const SUMMARY_INDEX_KEY = "summaryIndex";
const summaryKey = (group: string) => `summary:${group}`;

export const MAX_READINGS = 300;
export const MAX_SAVED_SUMMARIES = 20;

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Storage key of a group (by its name as sent in requests); the name itself isn't used as a key. */
export const groupKey = async (groupName: string) => (await sha256(`group:${groupName.slice(0, LIMITS.maxGroupNameChars)}`)).slice(0, 24);

/* ---------------- checkboxes ---------------- */

export interface GroupPrefs {
  permission: boolean;
  upload: boolean;
  images: boolean;
}

export async function loadGroupPrefs(kv: KV, groupName: string): Promise<GroupPrefs | null> {
  const all = (await kv.get<Record<string, GroupPrefs>>(PREFS_KEY)) ?? {};
  return all[await groupKey(groupName)] ?? null;
}

export async function saveGroupPrefs(kv: KV, groupName: string, prefs: GroupPrefs): Promise<void> {
  const all = (await kv.get<Record<string, GroupPrefs>>(PREFS_KEY)) ?? {};
  all[await groupKey(groupName)] = prefs;
  await kv.set({ [PREFS_KEY]: all });
}

/* ---------------- photo readings ---------------- */

type StoredReading = ImageReading & { at: number };

/** Hash of each photo in the request (null for an image that is already a reading). */
export function imageHashes(request: SummarizeRequest): Promise<(string | null)[]> {
  return Promise.all(request.images.map((i) => (i.dataUrl ? sha256(i.dataUrl) : null)));
}

/** Replaces photos read before with their cached reading, so they aren't sent to the AI again. */
export async function withCachedReadings(
  kv: KV,
  request: SummarizeRequest,
  hashes: (string | null)[],
): Promise<{ request: SummarizeRequest; reused: number }> {
  const cache = (await kv.get<Record<string, StoredReading>>(READINGS_KEY)) ?? {};
  let reused = 0;
  const images = request.images.map((img, i) => {
    const hit = hashes[i] ? cache[hashes[i] as string] : undefined;
    if (!hit) return img;
    reused++;
    return { messageId: img.messageId, reading: { text: hit.text, description: hit.description } };
  });
  return { request: { ...request, images }, reused };
}

export async function storeReadings(kv: KV, result: SummarizeResponse, hashes: (string | null)[], now: number): Promise<void> {
  if (!result.meta.imageReadings.length) return;
  const cache = (await kv.get<Record<string, StoredReading>>(READINGS_KEY)) ?? {};
  for (const r of result.meta.imageReadings) {
    const hash = hashes[r.index];
    if (hash) cache[hash] = { text: r.text, description: r.description, at: now };
  }
  const kept = Object.entries(cache)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_READINGS);
  await kv.set({ [READINGS_KEY]: Object.fromEntries(kept) });
}

/* ---------------- summaries ---------------- */

export interface SavedSummary {
  result: SummarizeResponse;
  photos: SummaryPhotos;
  /** Fingerprint of what was sent; an identical request reuses this summary instead of calling the AI. */
  fingerprint: string;
  savedAt: number;
}

/** Same messages, photos and period → same fingerprint ("now" and coverage wording don't matter). */
export async function fingerprint(request: SummarizeRequest, hashes: (string | null)[]): Promise<string> {
  return sha256(
    JSON.stringify({
      groupName: request.groupName,
      period: request.period,
      messages: request.messages.map((m) => [m.id, m.sender, m.timestamp, m.text]),
      images: request.images.map((img, i) => [img.messageId, hashes[i] ?? img.reading ?? null]),
    }),
  );
}

export async function loadSavedSummary(kv: KV, groupName: string): Promise<SavedSummary | null> {
  return (await kv.get<SavedSummary>(summaryKey(await groupKey(groupName)))) ?? null;
}

export async function saveSummary(kv: KV, saved: SavedSummary): Promise<void> {
  const key = await groupKey(saved.result.groupName);
  const index = (await kv.get<Record<string, number>>(SUMMARY_INDEX_KEY)) ?? {};
  index[key] = saved.savedAt;
  const ordered = Object.entries(index).sort(([, a], [, b]) => b - a);
  const evicted = ordered.slice(MAX_SAVED_SUMMARIES).map(([k]) => k);
  await kv.set({ [summaryKey(key)]: saved, [SUMMARY_INDEX_KEY]: Object.fromEntries(ordered.slice(0, MAX_SAVED_SUMMARIES)) });
  if (evicted.length) await kv.remove(evicted.map(summaryKey));
}

export async function deleteSavedSummary(kv: KV, groupName: string): Promise<void> {
  const key = await groupKey(groupName);
  const index = (await kv.get<Record<string, number>>(SUMMARY_INDEX_KEY)) ?? {};
  await kv.set({ [SUMMARY_INDEX_KEY]: Object.fromEntries(Object.entries(index).filter(([k]) => k !== key)) });
  await kv.remove([summaryKey(key)]);
}

/** Removes everything above (settings are kept). */
export async function clearAllSaved(kv: KV): Promise<void> {
  const index = (await kv.get<Record<string, number>>(SUMMARY_INDEX_KEY)) ?? {};
  await kv.remove([PREFS_KEY, READINGS_KEY, SUMMARY_INDEX_KEY, ...Object.keys(index).map(summaryKey)]);
}
