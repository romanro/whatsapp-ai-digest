/**
 * Content script — injected on demand (chrome.scripting.executeScript) only when the user opens the popup on
 * web.whatsapp.com. It does NOT observe the page continuously and is strictly read-only: it never sends,
 * deletes or edits messages, never clicks or scrolls, and never touches cookies, storage or session data.
 */
import type { ContentRequest, ExtractResponse, ProbeResponse } from "../lib/protocol.ts";
import { extractRenderedMessages, probe, waitForStableDom } from "./extractor.ts";

declare global {
  interface Window {
    __wadContentInstalled?: boolean;
  }
}

if (!window.__wadContentInstalled) {
  window.__wadContentInstalled = true;

  chrome.runtime.onMessage.addListener((msg: ContentRequest, sender, sendResponse) => {
    // Accept messages from this extension only.
    if (sender.id !== chrome.runtime.id) return false;
    if (msg.type === "wad:probe") {
      sendResponse(probe(document) satisfies ProbeResponse);
      return false;
    }
    if (msg.type === "wad:extract") {
      waitForStableDom(document)
        .then(() => sendResponse(extractRenderedMessages(document, msg.dateOrderFallback) satisfies ExtractResponse))
        .catch(() => sendResponse({ ok: false, code: "no_messages", message: "Ошибка чтения страницы." } satisfies ExtractResponse));
      return true; // async response
    }
    return false;
  });
}
