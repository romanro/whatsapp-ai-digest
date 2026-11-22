import { lstat, readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";

/** Same cap as the extension's MAX_DOCUMENT_BYTES. */
export const MAX_LOCAL_DOCUMENT_BYTES = 30 * 1024 * 1024;
const DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx"]);

export type LocalFileResult = { ok: true; bytes: Buffer } | { ok: false; status: number; code: string; message: string };

/**
 * Reads one document the user downloaded from WhatsApp; the extension finds its path in Chrome's download history.
 * Only PDF/DOCX regular files (after resolving links) are served, nothing is written or kept.
 */
export async function readLocalDocument(path: unknown): Promise<LocalFileResult> {
  if (typeof path !== "string" || !path || path.length > 4096 || !isAbsolute(path)) {
    return { ok: false, status: 400, code: "invalid_request", message: "Нужен полный путь к файлу." };
  }
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    return { ok: false, status: 404, code: "not_found", message: "Файл не найден — возможно, его удалили или переместили." };
  }
  if (!DOCUMENT_EXTENSIONS.has(extname(real).toLowerCase())) {
    return { ok: false, status: 403, code: "forbidden_file", message: "Можно читать только PDF и DOCX." };
  }
  const info = await lstat(real);
  if (!info.isFile()) return { ok: false, status: 403, code: "forbidden_file", message: "Это не файл." };
  if (info.size > MAX_LOCAL_DOCUMENT_BYTES) return { ok: false, status: 413, code: "too_large", message: "Файл больше 30 МБ." };
  return { ok: true, bytes: await readFile(real) };
}
