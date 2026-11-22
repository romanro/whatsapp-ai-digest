import {
  DEFAULT_MAX_IMAGES,
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
import type { CapturedImage, ExtractionResult } from "./protocol.ts";
import type { ParsedDocument } from "./documents.ts";

export interface PrepareOptions {
  /** Opt-in photo analysis. Off = text only (default). */
  includeImages: boolean;
  maxImages: number;
}

export const TEXT_ONLY: PrepareOptions = { includeImages: false, maxImages: DEFAULT_MAX_IMAGES };

export interface ImageCandidate {
  ref: string;
  messageId: string;
  timestamp: string;
  sender: string | null;
}

/** A document card seen in the chat; its file is only used if the user adds it. */
export interface DocumentCandidate {
  messageId: string;
  name: string;
  timestamp: string;
  sender: string | null;
}

export interface PreparedPayload {
  /** Request without photos; photos are attached with attachImages() after the user picks them. */
  request: SummarizeRequest;
  coverage: Coverage;
  redactions: RedactionCounts;
  pseudonymizedSenders: number;
  truncatedMessages: number;
  /** Messages excluded because they exceed limits (oldest first are dropped). */
  droppedForSize: number;
  inPeriod: number;
  /** Photos in the period that may be analysed (newest first, at most maxImages). */
  imageCandidates: ImageCandidate[];
  /** Photos in the period beyond maxImages. */
  imagesOverLimit: number;
  /** Documents in the period (newest first, at most LIMITS.maxDocuments). */
  documentCandidates: DocumentCandidate[];
}

type TimedMessage = RawMessage & { timestamp: string };

/**
 * Turns raw extracted messages into a validated, redacted API request.
 * Runs entirely in the browser BEFORE anything is uploaded; the user reviews the result and confirms.
 */
export function preparePayload(
  extraction: ExtractionResult,
  period: Period,
  now: Date,
  opts: PrepareOptions = TEXT_ONLY,
): PreparedPayload | { empty: true; coverage: Coverage } {
  const { stats } = extraction;
  const coverage = detectCoverage({
    loaded: extraction.messages,
    period,
    now,
    untimedCount: stats.untimed,
    skippedNonText: 0, // reported below with a breakdown
    notScrolledToBottom: stats.notScrolledToBottom,
    dateOrderAssumed: stats.dateOrderAssumed,
  });
  if (stats.truncated > 0) {
    coverage.warnings.push(`${stats.truncated} длинных сообщ. показаны WhatsApp не полностью («Читать далее») — в сводку попал только видимый текст.`);
  }
  if (opts.includeImages && stats.photoDateUncertain > 0) {
    coverage.warnings.push(
      `У ${stats.photoDateUncertain} фото без подписи дата определена по соседним сообщениям и может быть неточной.`,
    );
  }
  const skippedMedia = stats.otherMedia + (opts.includeImages ? 0 : stats.photoOnly);
  if (skippedMedia > 0) {
    coverage.warnings.push(
      opts.includeImages
        ? `${skippedMedia} медиа-сообщ. без текста (видео, голосовые, файлы, стикеры) пропущено.`
        : `${skippedMedia} медиа-сообщ. без текста пропущено (из них фото: ${stats.photoOnly}). Включите «Анализировать фото», чтобы учесть фото.`,
    );
  }
  if (opts.includeImages && stats.imagesNotLoaded > 0) {
    coverage.warnings.push(
      `${stats.imagesNotLoaded} фото WhatsApp ещё не загрузил (размытые) — откройте их в чате, чтобы они загрузились, и повторите.`,
    );
  }

  let inPeriod = filterByPeriod(extraction.messages, period, now) as TimedMessage[];
  if (!opts.includeImages) inPeriod = inPeriod.filter((m) => m.text.trim() !== "" || m.documents?.length);

  // Photos: newest first, capped.
  const allCandidates: ImageCandidate[] = [];
  if (opts.includeImages) {
    for (const m of [...inPeriod].reverse()) {
      for (const ref of m.imageRefs ?? []) allCandidates.push({ ref, messageId: m.key, timestamp: m.timestamp, sender: m.sender });
    }
  }
  const imageCandidates = allCandidates.slice(0, Math.max(0, Math.min(opts.maxImages, LIMITS.maxImages)));
  const imagesOverLimit = allCandidates.length - imageCandidates.length;
  if (imagesOverLimit > 0) {
    coverage.warnings.push(`Будут проанализированы только ${imageCandidates.length} самых новых фото из ${allCandidates.length} (лимит в настройках).`);
  }
  const documentCandidates: DocumentCandidate[] = [...inPeriod]
    .reverse()
    .flatMap((m) => (m.documents ?? []).map((name) => ({ messageId: m.key, name, timestamp: m.timestamp, sender: m.sender })))
    .slice(0, LIMITS.maxDocuments);
  const withCandidate = new Set([...imageCandidates, ...documentCandidates].map((c) => c.messageId));
  // A captionless photo/document message is only useful if its attachment can be sent (decided in attachments()).
  inPeriod = inPeriod.filter((m) => m.text.trim() !== "" || withCandidate.has(m.key));
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
  const kept = new Set(messages.map((m) => m.id));

  return {
    request: {
      groupName: extraction.groupName.slice(0, LIMITS.maxGroupNameChars),
      period,
      clientNow: toLocalIso(now),
      consentConfirmed: true,
      coverage,
      messages,
      images: [],
      documents: [],
    },
    coverage,
    redactions: counts,
    pseudonymizedSenders: pseudo.pseudonymizedCount,
    truncatedMessages: stats.truncated,
    droppedForSize,
    inPeriod: inPeriod.length,
    imageCandidates: imageCandidates.filter((c) => kept.has(c.messageId)),
    imagesOverLimit,
    documentCandidates: documentCandidates.filter((c) => kept.has(c.messageId)),
  };
}

/**
 * Attaches the photos the user kept selected. Captionless photo messages whose photo isn't sent are removed,
 * so nothing without content is uploaded.
 */
export function attachImages(
  prepared: PreparedPayload,
  captured: CapturedImage[],
  selectedRefs: ReadonlySet<string>,
  documents: readonly { messageId: string; doc: ParsedDocument }[] = [],
): { request: SummarizeRequest; photosSent: number; documentsSent: number; documentRedactions: RedactionCounts } {
  const byRef = new Map(prepared.imageCandidates.map((c) => [c.ref, c]));
  const images = captured
    .filter((c) => c.dataUrl && selectedRefs.has(c.ref) && byRef.has(c.ref))
    .slice(0, LIMITS.maxImages)
    .map((c) => ({ messageId: (byRef.get(c.ref) as ImageCandidate).messageId, dataUrl: c.dataUrl as string }));
  // Document text is redacted here, in the browser, like message text (scanned pages go as images, like photos).
  const documentRedactions = emptyCounts();
  const docMessages = new Set(prepared.documentCandidates.map((c) => c.messageId));
  const docs = documents
    .filter((d) => docMessages.has(d.messageId))
    .slice(0, LIMITS.maxDocuments)
    .map(({ messageId, doc }) => ({
      messageId,
      name: doc.name,
      kind: doc.kind,
      pages: doc.pages,
      ...(doc.text !== undefined
        ? { text: redactText(doc.text, documentRedactions).text.slice(0, LIMITS.maxDocumentChars) }
        : { pageImages: doc.pageImages }),
    }));
  const withAttachment = new Set([...images, ...docs].map((i) => i.messageId));
  const messages = prepared.request.messages.filter((m) => m.text.trim() !== "" || withAttachment.has(m.id));
  return {
    request: { ...prepared.request, messages, images, documents: docs },
    photosSent: images.length,
    documentsSent: docs.length,
    documentRedactions,
  };
}
