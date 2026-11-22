import { DOCUMENT_TRANSLATE_MAX_CHARS, DocumentDigestSchema, redactText, type DocumentDigest, type InputDocument } from "@wad/shared";
import { AiError, type AiProvider } from "./ai/provider.ts";
import { DOCUMENT_SYSTEM, VISION_SYSTEM, buildDocumentMergeUser, buildDocumentUser, buildVisionUser } from "./ai/prompt.ts";
import { parseImageReading } from "./summarizer.ts";

/** Characters of document text per AI request — keeps each request well under the free Groq tier's tokens/minute. */
export const DOCUMENT_CHUNK_CHARS = 6000;

export interface DocumentOptions {
  onError?: (code: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Shared budget (ms) for waiting on rate limits across all documents. */
  waitBudget?: { ms: number };
}

export interface DocumentAnalysis {
  /** messageId → digests of that message's documents (with name, kind, pages). */
  digests: Map<string, (DocumentDigest & { name: string; kind: "pdf" | "docx"; pages: number | null })[]>;
  analyzed: number;
  cached: number;
  failed: number;
  /** Fresh digests by index in request.documents (cached by the extension). */
  fresh: (DocumentDigest & { index: number })[];
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retries a call that hit the provider's rate limit, waiting as long as it asks (within the shared budget). */
async function withRateLimitRetry<T>(fn: () => Promise<T>, opts: DocumentOptions): Promise<T> {
  const sleep = opts.sleep ?? realSleep;
  const budget = opts.waitBudget ?? { ms: 5 * 60_000 };
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof AiError) || err.code !== "rate_limited" || attempt >= 3) throw err;
      const waitMs = Math.min(65_000, Math.max(2_000, (err.retryAfterSeconds ?? 20) * 1000 + 500));
      if (waitMs > budget.ms) throw err;
      budget.ms -= waitMs;
      await sleep(waitMs);
    }
  }
}

/** Splits text into chunks of at most `max` chars, preferring paragraph and line breaks. */
export function chunkText(text: string, max = DOCUMENT_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(". "));
    const at = cut > max / 2 ? cut + 1 : max;
    chunks.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function parseDigest(raw: string, translate: boolean): DocumentDigest | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    const m = /\{[\s\S]*\}/.exec(raw);
    if (!m) return null;
    try {
      json = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    if (!Array.isArray(o.keyPoints)) o.keyPoints = [];
    if (!translate || typeof o.translation !== "string" || !o.translation.trim()) o.translation = null;
  }
  const r = DocumentDigestSchema.safeParse(json);
  return r.success ? r.data : null;
}

async function completeDigest(provider: AiProvider, user: string, translate: boolean, opts: DocumentOptions): Promise<DocumentDigest> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await withRateLimitRetry(
      () => provider.completeJson({ system: DOCUMENT_SYSTEM, user, maxTokens: translate ? 8192 : 3000 }),
      opts,
    );
    const digest = parseDigest(raw, translate);
    if (digest) return digest;
  }
  throw new AiError("invalid_output", "Модель вернула описание документа в неверном формате.");
}

/** Text of a scanned PDF: its first pages read by the vision model. */
async function readScannedPages(doc: InputDocument, provider: AiProvider, opts: DocumentOptions): Promise<string> {
  if (!provider.visionModel) throw new AiError("model_unavailable", "Модель для распознавания страниц недоступна.");
  const pages: string[] = [];
  for (const [i, imageDataUrl] of (doc.pageImages ?? []).entries()) {
    const raw = await withRateLimitRetry(
      () =>
        provider.completeVisionJson({
          system: VISION_SYSTEM,
          user: `${buildVisionUser({ caption: "", sender: null, time: "" })} This is page ${i + 1} of the document ${JSON.stringify(doc.name)}.`,
          imageDataUrl,
          maxTokens: 3000,
        }),
      opts,
    );
    const reading = parseImageReading(raw);
    if (reading?.text.trim()) pages.push(reading.text.trim());
  }
  return pages.join("\n\n");
}

/** Turns one document into a Russian digest: per-chunk digests, merged when the document is long. */
export async function digestDocument(doc: InputDocument, provider: AiProvider, opts: DocumentOptions = {}): Promise<DocumentDigest> {
  const raw = doc.text ?? (await readScannedPages(doc, provider, opts));
  // Defence in depth: the extension redacts too.
  const text = redactText(raw).text.trim();
  if (!text) throw new AiError("invalid_output", "В документе не найден текст.");
  const chunks = chunkText(text);
  const translate = chunks.length === 1 && text.length <= DOCUMENT_TRANSLATE_MAX_CHARS;
  const parts: DocumentDigest[] = [];
  for (const [i, chunk] of chunks.entries()) {
    const user = buildDocumentUser({
      name: doc.name,
      kind: doc.kind,
      pages: doc.pages,
      text: chunk,
      part: chunks.length > 1 ? { index: i + 1, total: chunks.length } : undefined,
      translate,
    });
    parts.push(await completeDigest(provider, user, translate, opts));
  }
  if (parts.length === 1) return parts[0] as DocumentDigest;
  const merged = await completeDigest(
    provider,
    buildDocumentMergeUser({ name: doc.name, parts: parts.map(({ summary, keyPoints }) => ({ summary, keyPoints })) }),
    false,
    opts,
  ).catch((err: unknown) => {
    if (err instanceof AiError && err.code === "invalid_output") {
      // Deterministic fallback: concatenate the part digests.
      return {
        summary: parts.map((p) => p.summary).join(" "),
        keyPoints: [...new Set(parts.flatMap((p) => p.keyPoints))].slice(0, 20),
        translation: null,
      };
    }
    throw err;
  });
  return merged;
}

export async function analyzeDocuments(docs: InputDocument[], provider: AiProvider, opts: DocumentOptions = {}): Promise<DocumentAnalysis> {
  const result: DocumentAnalysis = { digests: new Map(), analyzed: 0, cached: 0, failed: 0, fresh: [] };
  const shared = { ...opts, waitBudget: opts.waitBudget ?? { ms: 5 * 60_000 } };
  for (const [index, doc] of docs.entries()) {
    let digest: DocumentDigest | null = doc.digest ?? null;
    if (digest) {
      result.cached++;
    } else {
      try {
        digest = await digestDocument(doc, provider, shared);
        result.analyzed++;
        result.fresh.push({ index, ...digest });
      } catch (err) {
        const code = err instanceof AiError ? err.code : "unknown";
        opts.onError?.(code);
        result.failed++;
        // Auth/config problems would fail every remaining document too.
        if (code === "auth_failed" || code === "not_configured") {
          result.failed += docs.length - index - 1;
          break;
        }
        continue;
      }
    }
    const list = result.digests.get(doc.messageId) ?? [];
    list.push({ ...digest, name: doc.name, kind: doc.kind, pages: doc.pages });
    result.digests.set(doc.messageId, list);
  }
  return result;
}

/** What the summary model sees for a document (no full translation — it isn't needed there). */
export function formatDigestForPrompt(d: { name: string; kind: string; pages: number | null; summary: string; keyPoints: string[] }): string {
  const head = `[Документ «${d.name}» (${d.kind.toUpperCase()}${d.pages ? `, ${d.pages} стр.` : ""}): ${d.summary.trim()}`;
  const points = d.keyPoints.length ? `\nГлавное:\n${d.keyPoints.map((p) => `- ${p}`).join("\n")}` : "";
  return `${head}${points}]`;
}
