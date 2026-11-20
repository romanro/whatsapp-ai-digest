import {
  LIMITS,
  SenderPseudonymizer,
  detectCoverage,
  emptyCounts,
  filterByPeriod,
  redactText,
  toLocalIso,
  type Coverage,
  type Period,
  type RawMessage,
  type RedactionCounts,
  type SummarizeRequest,
} from "@wad/shared";
import type { ExtractionResult } from "./protocol.ts";

export interface PreparedPayload {
  request: SummarizeRequest;
  coverage: Coverage;
  redactions: RedactionCounts;
  pseudonymizedSenders: number;
  truncatedMessages: number;
  /** Messages excluded because they exceed limits (oldest first are dropped). */
  droppedForSize: number;
  inPeriod: number;
}

/**
 * Turns raw extracted messages into a validated, redacted API request.
 * Runs entirely in the browser BEFORE anything is uploaded; the user reviews the result and confirms.
 */
export function preparePayload(extraction: ExtractionResult, period: Period, now: Date): PreparedPayload | { empty: true; coverage: Coverage } {
  const { stats } = extraction;
  const coverage = detectCoverage({
    loaded: extraction.messages,
    period,
    now,
    untimedCount: stats.untimed,
    skippedNonText: stats.skippedNonText,
    notScrolledToBottom: stats.notScrolledToBottom,
    dateOrderAssumed: stats.dateOrderAssumed,
  });
  if (stats.truncated > 0) {
    coverage.warnings.push(`${stats.truncated} длинных сообщ. показаны WhatsApp не полностью («Читать далее») — в сводку попал только видимый текст.`);
  }

  const inPeriod = filterByPeriod(extraction.messages, period, now) as (RawMessage & { timestamp: string })[];
  if (!inPeriod.length) return { empty: true, coverage };

  const counts = emptyCounts();
  const pseudo = new SenderPseudonymizer();
  let messages = inPeriod.map((m) => ({
    id: m.key,
    sender: pseudo.pseudonymize(m.sender)?.slice(0, LIMITS.maxSenderChars) ?? null,
    timestamp: m.timestamp,
    text: redactText(m.text, counts).text.slice(0, LIMITS.maxMessageChars),
  }));

  // Enforce size limits by keeping the most recent messages.
  let droppedForSize = 0;
  if (messages.length > LIMITS.maxMessages) {
    droppedForSize = messages.length - LIMITS.maxMessages;
    messages = messages.slice(-LIMITS.maxMessages);
  }
  let total = messages.reduce((n, m) => n + m.text.length, 0);
  while (total > LIMITS.maxTotalChars && messages.length > 1) {
    total -= messages[0]?.text.length ?? 0;
    messages = messages.slice(1);
    droppedForSize++;
  }
  if (droppedForSize > 0) {
    coverage.fullyCovered = false;
    coverage.warnings.push(`${droppedForSize} самых старых сообщ. не отправлено из-за ограничения объёма.`);
  }

  return {
    request: {
      groupName: extraction.groupName.slice(0, LIMITS.maxGroupNameChars),
      period,
      clientNow: toLocalIso(now),
      consentConfirmed: true,
      coverage,
      messages,
    },
    coverage,
    redactions: counts,
    pseudonymizedSenders: pseudo.pseudonymizedCount,
    truncatedMessages: stats.truncated,
    droppedForSize,
    inPeriod: inPeriod.length,
  };
}
