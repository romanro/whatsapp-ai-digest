/**
 * Reads documents the user downloaded from WhatsApp themselves and added in the popup (file picker / drag & drop).
 * Runs in the popup, before anything is sent: PDF text via pdf.js, DOCX text via mammoth; a scanned PDF (no text
 * layer) is rendered to page images for the vision model. Nothing is uploaded here.
 */
import { LIMITS } from "@wad/shared";

export const MAX_DOCUMENT_BYTES = 30 * 1024 * 1024;
/** Longest side of a rendered page of a scanned PDF. */
const PAGE_MAX_SIDE = 1600;
/** Fewer non-space characters than this means the PDF has no usable text layer (a scan). */
const MIN_TEXT_CHARS = 30;

export interface ParsedDocument {
  name: string;
  kind: "pdf" | "docx";
  pages: number | null;
  /** SHA-256 of the file bytes (cache key). */
  hash: string;
  text?: string;
  pageImages?: string[];
  /** The text was cut to LIMITS.maxDocumentChars. */
  truncated: boolean;
}

export type ParseResult = { ok: true; doc: ParsedDocument } | { ok: false; name: string; error: string };

export function documentKind(name: string): "pdf" | "docx" | "doc" | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name.trim())?.[1]?.toLowerCase();
  return ext === "pdf" || ext === "docx" || ext === "doc" ? ext : null;
}

async function sha256Bytes(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Joins pdf.js text items, keeping line breaks where the PDF has them. */
export function joinPdfText(items: readonly { str?: string; hasEOL?: boolean }[]): string {
  let out = "";
  for (const it of items) {
    if (typeof it.str !== "string") continue;
    out += it.str;
    if (it.hasEOL) out += "\n";
    else if (it.str && !out.endsWith(" ")) out += " ";
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function cut(text: string): { text: string; truncated: boolean } {
  return text.length > LIMITS.maxDocumentChars
    ? { text: text.slice(0, LIMITS.maxDocumentChars), truncated: true }
    : { text, truncated: false };
}

/** pdf.js 6 uses Uint8Array#toHex (Chrome 140+); older browsers get this polyfill. */
function polyfillToHex(): void {
  const proto = Uint8Array.prototype as Uint8Array & { toHex?: () => string };
  if (typeof proto.toHex === "function") return;
  Object.defineProperty(Uint8Array.prototype, "toHex", {
    configurable: true,
    writable: true,
    value(this: Uint8Array) {
      return Array.from(this, (b) => b.toString(16).padStart(2, "0")).join("");
    },
  });
}

async function loadPdfJs() {
  polyfillToHex();
  const pdfjs = await import("pdfjs-dist");
  const { default: workerUrl } = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  return pdfjs;
}

async function renderPage(page: { getViewport(o: { scale: number }): { width: number; height: number }; render(o: object): { promise: Promise<void> } }): Promise<string | null> {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(3, PAGE_MAX_SIDE / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  for (const quality of [0.82, 0.7, 0.55]) {
    const url = canvas.toDataURL("image/jpeg", quality);
    if (url.length <= LIMITS.maxImageDataUrlChars) return url;
  }
  return null;
}

async function parsePdf(name: string, bytes: ArrayBuffer, hash: string): Promise<ParsedDocument> {
  const pdfjs = await loadPdfJs();
  // pdf.js takes ownership of (detaches) the buffer it gets — give it a copy.
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) });
  const pdf = await task.promise;
  try {
    const texts: string[] = [];
    let total = 0;
    for (let i = 1; i <= pdf.numPages && total <= LIMITS.maxDocumentChars; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const t = joinPdfText(content.items as { str?: string; hasEOL?: boolean }[]);
      texts.push(t);
      total += t.length + 2;
    }
    const text = texts.filter(Boolean).join("\n\n");
    if (text.replace(/\s/g, "").length >= MIN_TEXT_CHARS) {
      return { name, kind: "pdf", pages: pdf.numPages, hash, ...cut(text) };
    }
    const pageImages: string[] = [];
    for (let i = 1; i <= Math.min(pdf.numPages, LIMITS.maxDocumentPageImages); i++) {
      const url = await renderPage(await pdf.getPage(i));
      if (url) pageImages.push(url);
    }
    if (!pageImages.length) throw new Error("Не удалось прочитать страницы PDF.");
    return { name, kind: "pdf", pages: pdf.numPages, hash, pageImages, truncated: pdf.numPages > pageImages.length };
  } finally {
    void task.destroy();
  }
}

async function parseDocx(name: string, bytes: ArrayBuffer, hash: string): Promise<ParsedDocument> {
  const mammoth = await import("mammoth");
  const { value } = await mammoth.extractRawText({ arrayBuffer: bytes });
  const text = value.replace(/\n{3,}/g, "\n\n").trim();
  if (!text) throw new Error("В документе нет текста.");
  return { name, kind: "docx", pages: null, hash, ...cut(text) };
}

export async function parseDocument(file: File): Promise<ParseResult> {
  const name = file.name.slice(0, LIMITS.maxDocumentNameChars);
  const kind = documentKind(name);
  if (kind === "doc") return { ok: false, name, error: "Старый формат .doc не поддерживается — откройте файл и сохраните как PDF или DOCX." };
  if (!kind) return { ok: false, name, error: "Поддерживаются только PDF и DOCX." };
  if (file.size > MAX_DOCUMENT_BYTES) return { ok: false, name, error: "Файл больше 30 МБ." };
  try {
    const bytes = await file.arrayBuffer();
    const hash = await sha256Bytes(bytes);
    const doc = kind === "pdf" ? await parsePdf(name, bytes, hash) : await parseDocx(name, bytes, hash);
    return { ok: true, doc };
  } catch (err) {
    const message = err instanceof Error && /password/i.test(err.name + err.message) ? "PDF защищён паролем." : err instanceof Error ? err.message : "";
    return { ok: false, name, error: message || "Не удалось прочитать файл." };
  }
}

/** Matches an added file to a document message by name (WhatsApp shows the original file name). */
export function normalizeDocName(name: string): string {
  return name
    .normalize("NFC")
    .replace(/[‎‏‪-‮⁦-⁩]/g, "")
    .replace(/\s*\(\d+\)(?=\.[a-z0-9]+$)/i, "") // "file (1).pdf" — browser's duplicate-download suffix
    .trim()
    .toLowerCase();
}
