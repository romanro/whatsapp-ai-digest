import { IMAGE_MAX_SIDE, LIMITS } from "@wad/shared";

export interface CapturedImage {
  ref: string;
  /** JPEG data URL, or null if the photo is gone from the page or couldn't be read. */
  dataUrl: string | null;
  width: number;
  height: number;
}

/**
 * Re-encodes an already-rendered WhatsApp photo (a same-origin blob: image) as a downscaled JPEG.
 * Read-only: draws the <img> onto an off-DOM canvas; nothing is clicked or downloaded.
 */
export async function captureImage(ref: string, img: HTMLImageElement | undefined, maxSide = IMAGE_MAX_SIDE): Promise<CapturedImage> {
  const empty = { ref, dataUrl: null, width: 0, height: 0 };
  if (!img || !img.isConnected) return empty;
  try {
    if (!img.complete || !img.naturalWidth) await img.decode();
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if (!nw || !nh) return empty;
    const scale = Math.min(1, maxSide / Math.max(nw, nh));
    const width = Math.max(1, Math.round(nw * scale));
    const height = Math.max(1, Math.round(nh * scale));
    const canvas = img.ownerDocument.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return empty;
    ctx.drawImage(img, 0, 0, width, height);
    for (const quality of [0.82, 0.7, 0.55]) {
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      if (dataUrl.startsWith("data:image/jpeg") && dataUrl.length <= LIMITS.maxImageDataUrlChars) {
        return { ref, dataUrl, width, height };
      }
    }
    return empty;
  } catch {
    // Tainted canvas, decode error, element recycled by WhatsApp's virtual list, …
    return empty;
  }
}
