import {
  AiSummarySchema,
  SECTION_KEYS,
  SenderPseudonymizer,
  redactText,
  type AiSummary,
  type EnrichedSummary,
  type InputMessage,
  type SourceRef,
  type SummarizeRequest,
  type SummarizeResponse,
} from "@wad/shared";
import { AiError, type AiProvider } from "./ai/provider.ts";
import { buildChunkPrompt, buildMergePrompt, type PromptMessage } from "./ai/prompt.ts";

export interface SummarizerOptions {
  batchMaxChars: number;
  maxOutputTokens?: number;
}

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

/* ---------------- AI output parsing & validation ---------------- */

const NULLABLE_DEFAULTS: Record<string, string[]> = {
  announcements: ["details"],
  other: ["details"],
  events: ["date", "time", "dateText", "location"],
  tasks: ["deadline", "deadlineText", "assignee"],
  payments: ["amount", "currency", "amountText", "deadline", "method"],
  changes: ["before"],
};

/**
 * Light, non-inventive coercion of common model slips before strict validation:
 * missing optional fields → null, missing arrays → [], single id string → [id], missing status → "unclear",
 * malformed dates/times → null (the original wording stays in *Text fields).
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
  const out: AiSummary = { overview: "", announcements: [], events: [], tasks: [], payments: [], changes: [], other: [] };
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
  return out;
}

/* ---------------- Enrichment: attach REAL timestamps from input ---------------- */

export function enrichSummary(
  summary: AiSummary,
  sourceMap: Map<string, SourceRef>,
): { summary: EnrichedSummary; unknownDropped: number } {
  let unknownDropped = 0;
  const resolve = (ids: string[]): SourceRef[] => {
    const refs: SourceRef[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      const ref = sourceMap.get(id.trim());
      if (!ref) {
        unknownDropped++;
        continue;
      }
      if (!seen.has(ref.id)) {
        seen.add(ref.id);
        refs.push(ref);
      }
    }
    return refs.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  };
  // Items whose sources can't be verified are dropped — the model must not introduce unsupported claims.
  const map = <T extends { sourceIds: string[] }>(items: T[]) =>
    items.map((i) => ({ ...i, sources: resolve(i.sourceIds) })).filter((i) => i.sources.length > 0);

  return {
    summary: {
      overview: summary.overview,
      announcements: map(summary.announcements),
      events: map(summary.events),
      tasks: map(summary.tasks),
      payments: map(summary.payments),
      changes: map(summary.changes),
      other: map(summary.other),
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
      sourceMap.set(shortId, { id: m.id, timestamp: m.timestamp, sender });
      return {
        id: shortId,
        t: m.timestamp.slice(0, 16).replace("T", " "),
        from: sender,
        text: redactText(m.text).text,
      };
    });
  return { prompt, sourceMap };
}

export async function summarize(
  req: SummarizeRequest,
  provider: AiProvider,
  opts: SummarizerOptions,
): Promise<SummarizeResponse> {
  const maxTokens = opts.maxOutputTokens ?? 4096;
  const { prompt, sourceMap } = prepareMessages(req.messages);
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

  let merged: AiSummary;
  if (partials.length === 1) {
    merged = partials[0] as AiSummary;
  } else {
    try {
      merged = await completeValidated(
        provider,
        buildMergePrompt({ groupName: req.groupName, clientNow: req.clientNow, partials }),
        maxTokens,
      );
    } catch (err) {
      if (err instanceof AiError && err.code !== "invalid_output") throw err;
      merged = concatSummaries(partials);
    }
  }

  const { summary, unknownDropped } = enrichSummary(merged, sourceMap);
  return {
    summary,
    meta: {
      provider: provider.name,
      model: provider.model,
      messagesAnalyzed: req.messages.length,
      batches: batches.length,
      unknownSourceIdsDropped: unknownDropped,
      generatedAt: new Date().toISOString(),
    },
    coverage: req.coverage,
    groupName: req.groupName,
    period: req.period,
  };
}
