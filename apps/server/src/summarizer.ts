import {
  AiSummarySchema,
  ImageReadingSchema,
  SECTION_KEYS,
  SenderPseudonymizer,
  detectScripts,
  promptTime,
  redactText,
  type AiSummary,
  type EnrichedSummary,
  type InputImage,
  type InputMessage,
  type SourceRef,
  type SummarizeRequest,
  type SummarizeResponse,
} from "@wad/shared";
import { AiError, type AiProvider } from "./ai/provider.ts";
import { VISION_SYSTEM, buildChunkPrompt, buildMergePrompt, buildVisionUser, type PromptMessage } from "./ai/prompt.ts";

export interface SummarizerOptions {
  batchMaxChars: number;
  maxOutputTokens?: number;
  /** Called with an error code (never content) when a photo can't be read — for server logs. */
  onImageError?: (code: string) => void;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Total time budget for waiting on photo rate limits. */
  visionWaitBudgetMs?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Splits messages into chronological batches whose serialized size stays under the budget. */
export function chunkMessages(messages: PromptMessage[], maxChars: number): PromptMessage[][] {
  const batches: PromptMessage[][] = [];
  let current: PromptMessage[] = [];
  let size = 0;
  for (const m of messages) {
    const cost = JSON.stringify(m).length + 2;
    if (current.length > 0 && size + cost > maxChars) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(m);
    size += cost;
  }
  if (current.length) batches.push(current);
  return batches;
}

/* ---------------- Photos → text ---------------- */

export interface ImageAnalysis {
  /** messageId → readings formatted as "[Фото: …]" blocks. */
  readings: Map<string, string[]>;
  analyzed: number;
  failed: number;
  /** Photos that came with a cached reading instead of the image. */
  cached: number;
  /** Fresh readings by index in the request's images (returned so the extension can cache them). */
  fresh: { index: number; text: string; description: string }[];
}

export function parseImageReading(text: string): { text: string; description: string } | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) return null;
    try {
      json = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  const r = ImageReadingSchema.safeParse(json);
  return r.success ? r.data : null;
}

export function formatReading(r: { text: string; description: string }): string {
  const parts = [r.description.trim(), r.text.trim() ? `Текст на фото:\n${r.text.trim()}` : ""].filter(Boolean);
  return `[Фото: ${parts.join("\n") || "без распознанного содержимого"}]`;
}

/**
 * Reads each user-selected photo with the vision model, one at a time. Groq's free tier allows only a few photos per
 * minute (~1 800 input tokens each vs 7 000/min), so on a rate limit we wait as long as the provider asks and retry,
 * within a total time budget. A failed photo never fails the whole summary; it's counted and reported.
 */
export async function analyzeImages(
  images: InputImage[],
  messages: Map<string, InputMessage>,
  provider: AiProvider,
  opts: Pick<SummarizerOptions, "onImageError" | "sleep" | "visionWaitBudgetMs"> = {},
): Promise<ImageAnalysis> {
  const sleep = opts.sleep ?? realSleep;
  let waitBudget = opts.visionWaitBudgetMs ?? 5 * 60_000;
  const readings = new Map<string, string[]>();
  const fresh: ImageAnalysis["fresh"] = [];
  let analyzed = 0;
  let failed = 0;
  let cached = 0;
  const add = (messageId: string, r: { text: string; description: string }) => {
    const list = readings.get(messageId) ?? [];
    list.push(formatReading(r));
    readings.set(messageId, list);
  };
  for (const img of images) {
    if (img.reading) {
      add(img.messageId, img.reading);
      cached++;
    }
  }
  const toAnalyze = [...images.entries()].filter(([, img]) => img.dataUrl !== undefined);
  if (!toAnalyze.length) return { readings, analyzed, failed, cached, fresh };
  if (!provider.visionModel) {
    opts.onImageError?.("vision_disabled");
    return { readings, analyzed, failed: toAnalyze.length, cached, fresh };
  }
  for (const [n, [index, img]] of toAnalyze.entries()) {
    const msg = messages.get(img.messageId);
    const request = {
      system: VISION_SYSTEM,
      user: buildVisionUser({ caption: msg?.text ?? "", sender: msg?.sender ?? null, time: msg ? promptTime(msg.timestamp) : "" }),
      imageDataUrl: img.dataUrl as string,
      maxTokens: 2000,
    };
    let reading: { text: string; description: string } | null = null;
    let fatal = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        reading = parseImageReading(await provider.completeVisionJson(request));
        if (!reading) opts.onImageError?.("invalid_output");
        break;
      } catch (err) {
        const code = err instanceof AiError ? err.code : "unknown";
        if (code === "rate_limited" && attempt < 3) {
          const waitMs = Math.min(65_000, Math.max(2_000, ((err as AiError).retryAfterSeconds ?? 20) * 1000 + 500));
          if (waitMs <= waitBudget) {
            waitBudget -= waitMs;
            await sleep(waitMs);
            continue;
          }
        }
        opts.onImageError?.(code);
        fatal = code === "rate_limited" || code === "auth_failed" || code === "not_configured";
        break;
      }
    }
    if (reading) {
      add(img.messageId, reading);
      fresh.push({ index, text: reading.text, description: reading.description });
      analyzed++;
    } else {
      failed++;
    }
    // Rate limit budget exhausted or auth problems would hit every remaining photo too.
    if (fatal) {
      failed += toAnalyze.length - n - 1;
      break;
    }
  }
  return { readings, analyzed, failed, cached, fresh };
}

/** Appends photo readings to their messages; drops captionless photo messages whose photo couldn't be read. */
export function mergeReadings(messages: InputMessage[], readings: Map<string, string[]>): InputMessage[] {
  return messages
    .map((m) => {
      const r = readings.get(m.id);
      return r ? { ...m, text: [m.text.trim(), ...r].filter(Boolean).join("\n") } : m;
    })
    .filter((m) => m.text.trim() !== "");
}

/* ---------------- AI output parsing & validation ---------------- */

const NULLABLE_DEFAULTS: Record<string, string[]> = {
  announcements: ["details"],
  other: ["details"],
  events: ["details", "date", "time", "dateText", "location"],
  tasks: ["details", "deadline", "deadlineText", "assignee"],
  payments: ["details", "amount", "currency", "amountText", "deadline", "method"],
  changes: ["details", "before"],
};

/**
 * Light, non-inventive coercion of common model slips before strict validation:
 * missing optional fields → null, missing arrays → [], single id string → [id], missing status → "unclear",
 * malformed dates/times → null (the original wording stays in *Text fields), malformed translations dropped.
 */
export function coerceAiOutput(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const obj: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  if (typeof obj.overview !== "string") obj.overview = "";
  for (const key of SECTION_KEYS) {
    const arr = obj[key];
    if (arr === undefined || arr === null) {
      obj[key] = [];
      continue;
    }
    if (!Array.isArray(arr)) continue;
    obj[key] = arr.map((item: unknown) => {
      if (typeof item !== "object" || item === null) return item;
      const it: Record<string, unknown> = { ...(item as Record<string, unknown>) };
      for (const f of NULLABLE_DEFAULTS[key] ?? []) {
        if (it[f] === undefined || it[f] === "") it[f] = null;
      }
      if (typeof it.sourceIds === "string") it.sourceIds = [it.sourceIds];
      if (key !== "changes" && it.status === undefined) it.status = "unclear";
      for (const f of ["date", "deadline"]) {
        if (typeof it[f] === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(it[f])) it[f] = null;
      }
      if (typeof it.time === "string" && !/^\d{2}:\d{2}$/.test(it.time)) it.time = null;
      if (typeof it.amount === "string") {
        const n = Number(it.amount.replace(",", "."));
        it.amount = Number.isFinite(n) ? n : null;
      }
      return it;
    });
  }
  obj.translations = Array.isArray(obj.translations)
    ? obj.translations.filter(
        (t: unknown): t is { id: string; ru: string } =>
          typeof t === "object" &&
          t !== null &&
          typeof (t as { id?: unknown }).id === "string" &&
          typeof (t as { ru?: unknown }).ru === "string" &&
          (t as { ru: string }).ru.trim() !== "",
      )
    : [];
  return obj;
}

export function parseAiSummary(text: string): { ok: true; value: AiSummary } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // Some models wrap JSON in ```fences``` despite json mode.
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) return { ok: false, error: "Response is not JSON" };
    try {
      json = JSON.parse(m[0]);
    } catch {
      return { ok: false, error: "Response is not valid JSON" };
    }
  }
  // An object with none of the expected keys is not a summary — don't coerce it into "nothing important".
  if (typeof json !== "object" || json === null || !["overview", ...SECTION_KEYS].some((k) => k in json)) {
    return { ok: false, error: "Response has none of the required keys" };
  }
  const parsed = AiSummarySchema.safeParse(coerceAiOutput(json));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 8)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return { ok: false, error: issues };
  }
  return { ok: true, value: parsed.data };
}

async function completeValidated(provider: AiProvider, prompt: { system: string; user: string }, maxTokens: number) {
  const first = await provider.completeJson({ ...prompt, maxTokens });
  const r1 = parseAiSummary(first);
  if (r1.ok) return r1.value;
  // One repair attempt with the validation error (no message content is echoed back beyond the original prompt).
  const second = await provider.completeJson({
    system: prompt.system,
    user: `${prompt.user}\n\nYour previous answer was invalid (${r1.error}). Return ONLY a valid JSON object with all required keys.`,
    maxTokens,
  });
  const r2 = parseAiSummary(second);
  if (r2.ok) return r2.value;
  throw new AiError("invalid_output", "Модель вернула ответ в неверном формате. Попробуйте ещё раз.");
}

/** Deterministic fallback merge (used if the AI merge step fails): concatenation with exact-duplicate removal. */
export function concatSummaries(parts: AiSummary[]): AiSummary {
  const out: AiSummary = { overview: "", announcements: [], events: [], tasks: [], payments: [], changes: [], other: [], translations: [] };
  out.overview = parts
    .map((p) => p.overview.trim())
    .filter(Boolean)
    .join(" ");
  for (const key of SECTION_KEYS) {
    const seen = new Set<string>();
    for (const p of parts) {
      for (const item of p[key]) {
        const { sourceIds: _ids, ...rest } = item;
        const sig = JSON.stringify(rest);
        if (seen.has(sig)) continue;
        seen.add(sig);
        (out[key] as unknown[]).push(item);
      }
    }
  }
  out.translations = parts.flatMap((p) => p.translations);
  return out;
}

/* ---------------- Enrichment: attach REAL timestamps & original text from input ---------------- */

/** True if a YYYY-MM-DD date is earlier than the (first|last) source message's wall date. */
function isBefore(date: string | null, sources: SourceRef[], which: "first" | "last"): boolean {
  if (!date || !sources.length) return false;
  const ref = (which === "first" ? sources[0] : sources[sources.length - 1]) as SourceRef;
  return date < ref.timestamp.slice(0, 10);
}

/** A translation is shown only for messages that aren't plain Russian. */
function needsTranslation(text: string): boolean {
  const s = detectScripts(text);
  return s.hebrew || !s.cyrillic;
}

export function enrichSummary(
  summary: AiSummary,
  sourceMap: Map<string, SourceRef>,
  translations: Map<string, string> = new Map(summary.translations.map((t) => [t.id.trim(), t.ru])),
): { summary: EnrichedSummary; unknownDropped: number } {
  let unknownDropped = 0;
  const resolve = (ids: string[]): SourceRef[] => {
    const refs: SourceRef[] = [];
    const seen = new Set<string>();
    for (const raw of ids) {
      const id = raw.trim();
      const ref = sourceMap.get(id);
      if (!ref) {
        unknownDropped++;
        continue;
      }
      if (seen.has(ref.id)) continue;
      seen.add(ref.id);
      const tr = translations.get(id);
      refs.push({ ...ref, translation: tr && needsTranslation(ref.text) ? tr : null });
    }
    return refs.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  };
  // Items whose sources can't be verified are dropped — the model must not introduce unsupported claims.
  const map = <T extends { sourceIds: string[] }>(items: T[]) =>
    items.map((i) => ({ ...i, sources: resolve(i.sourceIds) })).filter((i) => i.sources.length > 0);

  // Models sometimes repeat a dated/actionable item as an announcement too — keep only the specific one.
  const norm = (t: string) => t.toLocaleLowerCase("ru").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const specific = new Set(
    [
      ...summary.events.map((e) => e.title),
      ...summary.tasks.map((t) => t.task),
      ...summary.payments.map((p) => p.purpose),
      ...summary.changes.map((c) => c.what),
    ].map(norm),
  );
  const notDuplicate = <T extends { title: string }>(items: T[]) => items.filter((i) => !specific.has(norm(i.title)));

  return {
    summary: {
      overview: summary.overview,
      announcements: map(notDuplicate(summary.announcements)),
      // A resolved date before the announcing message is a mis-resolved relative date — drop it, keep the wording.
      events: map(summary.events).map((e) => (isBefore(e.date, e.sources, "first") ? { ...e, date: null, dateText: e.dateText } : e)),
      tasks: map(summary.tasks).map((t) => (isBefore(t.deadline, t.sources, "last") ? { ...t, deadline: null } : t)),
      payments: map(summary.payments).map((p) => (isBefore(p.deadline, p.sources, "last") ? { ...p, deadline: null } : p)),
      changes: map(summary.changes),
      other: map(notDuplicate(summary.other)),
    },
    unknownDropped,
  };
}

/* ---------------- Orchestration ---------------- */

/** Server-side defence in depth: re-apply redaction even though the extension already did. */
export function prepareMessages(messages: InputMessage[]): { prompt: PromptMessage[]; sourceMap: Map<string, SourceRef> } {
  const pseudo = new SenderPseudonymizer();
  const sourceMap = new Map<string, SourceRef>();
  const prompt = messages
    .slice()
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
    .map((m, i) => {
      const shortId = `m${i + 1}`;
      const sender = pseudo.pseudonymize(m.sender);
      const text = redactText(m.text).text;
      sourceMap.set(shortId, { id: m.id, timestamp: m.timestamp, sender, text, translation: null });
      return { id: shortId, t: promptTime(m.timestamp), from: sender, text };
    });
  return { prompt, sourceMap };
}

export async function summarize(
  req: SummarizeRequest,
  provider: AiProvider,
  opts: SummarizerOptions,
): Promise<SummarizeResponse> {
  // Details + full translations need more room than a terse summary.
  const maxTokens = opts.maxOutputTokens ?? 8192;

  const vision = await analyzeImages(req.images, new Map(req.messages.map((m) => [m.id, m])), provider, opts);
  const messages = mergeReadings(req.messages, vision.readings);
  if (!messages.length) {
    throw new AiError("invalid_output", "Не удалось распознать ни одного фото, а текстовых сообщений нет.");
  }

  const { prompt, sourceMap } = prepareMessages(messages);
  const batches = chunkMessages(prompt, opts.batchMaxChars);

  const partials: AiSummary[] = [];
  for (const [i, batch] of batches.entries()) {
    const p = buildChunkPrompt({
      groupName: req.groupName,
      clientNow: req.clientNow,
      messages: batch,
      part: batches.length > 1 ? { index: i + 1, total: batches.length } : undefined,
    });
    partials.push(await completeValidated(provider, p, maxTokens));
  }

  // Translations are collected from every partial; the merge step doesn't need to repeat them.
  const translations = new Map<string, string>();
  for (const p of partials) for (const t of p.translations) translations.set(t.id.trim(), t.ru);

  let merged: AiSummary;
  if (partials.length === 1) {
    merged = partials[0] as AiSummary;
  } else {
    try {
      merged = await completeValidated(
        provider,
        buildMergePrompt({
          groupName: req.groupName,
          clientNow: req.clientNow,
          partials: partials.map(({ translations: _t, ...rest }) => rest),
        }),
        maxTokens,
      );
    } catch (err) {
      if (err instanceof AiError && err.code !== "invalid_output") throw err;
      merged = concatSummaries(partials);
    }
  }

  const { summary, unknownDropped } = enrichSummary(merged, sourceMap, translations);
  const coverage = { ...req.coverage, warnings: [...req.coverage.warnings] };
  if (vision.failed > 0) {
    coverage.warnings.push(`${vision.failed} фото не удалось распознать — их содержимое не попало в сводку.`);
  }
  return {
    summary,
    meta: {
      provider: provider.name,
      model: provider.model,
      messagesAnalyzed: messages.length,
      batches: batches.length,
      unknownSourceIdsDropped: unknownDropped,
      imagesAnalyzed: vision.analyzed,
      imagesFailed: vision.failed,
      imagesCached: vision.cached,
      imageReadings: vision.fresh,
      visionModel: req.images.length ? provider.visionModel : null,
      generatedAt: new Date().toISOString(),
    },
    coverage,
    groupName: req.groupName,
    period: req.period,
  };
}
