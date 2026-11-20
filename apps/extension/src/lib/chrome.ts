import type { SummarizeRequest } from "@wad/shared";
import { JOB_KEY, RESULT_KEY, type BackgroundRequest, type BackgroundResponse, type Job } from "./jobs.ts";
import type { ContentRequest, ExtractResponse, ImagesResponse, ProbeResponse } from "./protocol.ts";

export const WHATSAPP_ORIGIN = "https://web.whatsapp.com";

export async function getWhatsAppTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith(`${WHATSAPP_ORIGIN}/`)) return null;
  return tab;
}

/** Injects the read-only content script on demand (idempotent). */
async function ensureContentScript(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: false }, files: ["content.js"] });
}

async function send<T>(tabId: number, msg: ContentRequest): Promise<T> {
  await ensureContentScript(tabId);
  return (await chrome.tabs.sendMessage(tabId, msg)) as T;
}

export const probeTab = (tabId: number) => send<ProbeResponse>(tabId, { type: "wad:probe" });
export const extractFromTab = (tabId: number, dateOrderFallback: "DMY" | "MDY" | "YMD") =>
  send<ExtractResponse>(tabId, { type: "wad:extract", dateOrderFallback });
export const captureImagesFromTab = (tabId: number, refs: string[]) => send<ImagesResponse>(tabId, { type: "wad:images", refs });

/** Last summary is kept only in chrome.storage.session (memory, cleared when the browser closes). */
export async function loadLastResult<T>(): Promise<T | null> {
  try {
    return ((await chrome.storage.session.get(RESULT_KEY))[RESULT_KEY] as T | undefined) ?? null;
  } catch {
    return null;
  }
}
export async function clearLastResult(): Promise<void> {
  try {
    await chrome.storage.session.remove([RESULT_KEY, JOB_KEY]);
    await chrome.action.setBadgeText({ text: "" });
  } catch {
    /* non-critical */
  }
}

/* ---------------- background jobs ---------------- */

const toBackground = (msg: BackgroundRequest) => chrome.runtime.sendMessage(msg) as Promise<BackgroundResponse>;

export const startBackgroundJob = (request: SummarizeRequest) => toBackground({ type: "wad:bg:start", request });
export const cancelBackgroundJob = () => toBackground({ type: "wad:bg:cancel" });
export const pingBackground = () => toBackground({ type: "wad:bg:ping" });

export async function loadJob(): Promise<Job | null> {
  try {
    return ((await chrome.storage.session.get(JOB_KEY))[JOB_KEY] as Job | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Forget a finished/failed job and reset the toolbar badge (the result itself is kept). */
export async function dismissJob(): Promise<void> {
  try {
    await chrome.storage.session.remove(JOB_KEY);
    await chrome.action.setBadgeText({ text: "" });
  } catch {
    /* non-critical */
  }
}
