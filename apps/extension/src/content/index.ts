/**
 * Content script — injected on demand (chrome.scripting.executeScript) only when the user opens the popup on
 * web.whatsapp.com. It does NOT observe the page continuously and is strictly read-only: it never sends,
 * deletes or edits messages, never clicks or scrolls, and never touches cookies, storage or session data.
 */
import type { ContentRequest, ExtractResponse, ImagesResponse, ProbeResponse } from "../lib/protocol.ts";
import { extractWithImages, probe, waitForStableDom } from "./extractor.ts";
import { captureImage } from "./images.ts";

declare global {
  interface Window {
    __wadContentInstalled?: boolean;
  }
}

if (!window.__wadContentInstalled) {
  window.__wadContentInstalled = true;
  /** Photos found by the last extraction; read only when the user asks for photo analysis. */
  let lastImages = new Map<string, HTMLImageElement>();

  chrome.runtime.onMessage.addListener((msg: ContentRequest, sender, sendResponse) => {
    // Accept messages from this extension only.
    if (sender.id !== chrome.runtime.id) return false;
    if (msg.type === "wad:probe") {
      sendResponse(probe(document) satisfies ProbeResponse);
      return false;
    }
    if (msg.type === "wad:extract") {
      waitForStableDom(document)
        .then(() => {
          const { result, images } = extractWithImages(document, msg.dateOrderFallback);
          lastImages = images;
          sendResponse(result satisfies ExtractResponse);
        })
        .catch(() => sendResponse({ ok: false, code: "no_messages", message: "Ошибка чтения страницы." } satisfies ExtractResponse));
      return true; // async response
    }
    if (msg.type === "wad:images") {
      const refs = msg.refs.slice(0, 20);
      Promise.all(refs.map((ref) => captureImage(ref, lastImages.get(ref))))
        .then((captured) => sendResponse(captured satisfies ImagesResponse))
        .catch(() => sendResponse([] satisfies ImagesResponse));
      return true;
    }
    return false;
  });
}
