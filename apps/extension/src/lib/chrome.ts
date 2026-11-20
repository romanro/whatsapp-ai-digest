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
    return ((await chrome.storage.session.get("lastResult")).lastResult as T | undefined) ?? null;
  } catch {
    return null;
  }
}
export async function saveLastResult(value: unknown): Promise<void> {
  try {
    await chrome.storage.session.set({ lastResult: value });
  } catch {
    /* non-critical */
  }
}
export async function clearLastResult(): Promise<void> {
  try {
    await chrome.storage.session.remove("lastResult");
  } catch {
    /* non-critical */
  }
}
