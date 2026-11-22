import { z } from "zod";
import { LIMITS, PERIODS } from "./constants.ts";

/** ISO 8601 date-time with an explicit offset, e.g. 2026-11-20T14:32:00+02:00 (local wall time preserved). */
export const LocalIsoDateTime = z.iso.datetime({ offset: true, local: false });

export const PeriodSchema = z.enum(PERIODS);

/** A single message as sent from the extension to the backend (already redacted). */
export const InputMessageSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  sender: z.string().max(LIMITS.maxSenderChars).nullable(),
  timestamp: LocalIsoDateTime,
  /** May be empty only for photo messages without a caption (an image must then reference this message). */
  text: z.string().max(LIMITS.maxMessageChars),
});

/** What the vision model must return for one photo. */
export const ImageReadingSchema = z.object({
  /** Readable text on the photo, verbatim, original language(s). Empty if none. */
  text: z.string().max(6000),
  /** One short Russian sentence: what the photo shows. */
  description: z.string().max(500),
});
export type ImageReading = z.infer<typeof ImageReadingSchema>;

/**
 * A photo the user explicitly selected for analysis, attached to an existing message. Either the photo itself, or —
 * when the extension already has it from an earlier summary — the cached reading, so it isn't sent to the AI again.
 */
export const InputImageSchema = z
  .object({
    messageId: z.string().min(1).max(64),
    dataUrl: z
      .string()
      .max(LIMITS.maxImageDataUrlChars)
      .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/)
      .optional(),
    reading: ImageReadingSchema.optional(),
  })
  .refine((i) => (i.dataUrl === undefined) !== (i.reading === undefined), {
    message: "An image needs exactly one of dataUrl or reading",
  });
export type InputImage = z.infer<typeof InputImageSchema>;

/** What the AI makes of one document (in Russian). */
export const DocumentDigestSchema = z.object({
  /** 2–5 sentences: what the document is and what matters in it. */
  summary: z.string().max(3000),
  /** Dates, amounts, things to do or bring, deadlines — one per line. */
  keyPoints: z.array(z.string().max(500)).max(20),
  /** Full translation for short documents, otherwise null. */
  translation: z.string().max(30_000).nullable(),
});
export type DocumentDigest = z.infer<typeof DocumentDigestSchema>;

const DataUrlImage = z
  .string()
  .max(LIMITS.maxImageDataUrlChars)
  .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/);

/**
 * A document (PDF/DOCX) the user downloaded from WhatsApp and added in the popup, attached to its message.
 * The extension extracts the text itself; a scanned PDF comes as page images instead. When the extension already has
 * the digest from an earlier summary, it sends only that.
 */
export const InputDocumentSchema = z
  .object({
    messageId: z.string().min(1).max(64),
    name: z.string().min(1).max(LIMITS.maxDocumentNameChars),
    kind: z.enum(["pdf", "docx"]),
    pages: z.number().int().min(1).max(10_000).nullable().default(null),
    text: z.string().max(LIMITS.maxDocumentChars).optional(),
    pageImages: z.array(DataUrlImage).min(1).max(LIMITS.maxDocumentPageImages).optional(),
    digest: DocumentDigestSchema.optional(),
  })
  .refine((d) => [d.text, d.pageImages, d.digest].filter((x) => x !== undefined).length === 1, {
    message: "A document needs exactly one of text, pageImages or digest",
  });
export type InputDocument = z.infer<typeof InputDocumentSchema>;
export type InputMessage = z.infer<typeof InputMessageSchema>;

export const CoverageSchema = z.object({
  periodStart: LocalIsoDateTime,
  oldestLoaded: LocalIsoDateTime.nullable(),
  newestLoaded: LocalIsoDateTime.nullable(),
  fullyCovered: z.boolean(),
  /** Russian, human-readable reasons why coverage may be incomplete. */
  warnings: z.array(z.string().max(500)).max(20),
});
export type Coverage = z.infer<typeof CoverageSchema>;

export const SummarizeRequestSchema = z
  .object({
    groupName: z.string().min(1).max(LIMITS.maxGroupNameChars),
    period: PeriodSchema,
    /** Client "now" in local time; used so the model can resolve "tomorrow", "on Sunday", etc. */
    clientNow: LocalIsoDateTime,
    consentConfirmed: z.literal(true),
    coverage: CoverageSchema,
    messages: z.array(InputMessageSchema).min(1).max(LIMITS.maxMessages),
    /** Optional, opt-in photo analysis. */
    images: z.array(InputImageSchema).max(LIMITS.maxImages).default([]),
    /** Documents the user added (downloaded from WhatsApp themselves). */
    documents: z.array(InputDocumentSchema).max(LIMITS.maxDocuments).default([]),
  })
  .superRefine((req, ctx) => {
    const ids = new Set(req.messages.map((m) => m.id));
    const withImage = new Set([...req.images, ...req.documents].map((i) => i.messageId));
    for (const img of [...req.images, ...req.documents]) {
      if (!ids.has(img.messageId)) {
        ctx.addIssue({ code: "custom", message: `Attachment references unknown message ${img.messageId}` });
        return;
      }
    }
    for (const m of req.messages) {
      if (m.text.trim() === "" && !withImage.has(m.id)) {
        ctx.addIssue({ code: "custom", message: `Message ${m.id} has neither text nor an attachment` });
        return;
      }
    }
    const total = req.messages.reduce((n, m) => n + m.text.length, 0);
    if (total > LIMITS.maxTotalChars) {
      ctx.addIssue({ code: "custom", message: `Total text too large (${total} > ${LIMITS.maxTotalChars} chars)` });
    }
    const seen = new Set<string>();
    for (const m of req.messages) {
      if (seen.has(m.id)) {
        ctx.addIssue({ code: "custom", message: `Duplicate message id ${m.id}` });
        return;
      }
      seen.add(m.id);
    }
  });
export type SummarizeRequest = z.infer<typeof SummarizeRequestSchema>;
export type SummarizeRequestInput = z.input<typeof SummarizeRequestSchema>;

/* ------------------------------------------------------------------ */
/* AI output schema — what the model must return (validated strictly). */
/* ------------------------------------------------------------------ */

export const ItemStatusSchema = z.enum(["confirmed", "proposed", "unclear"]);
export type ItemStatus = z.infer<typeof ItemStatusSchema>;

const sourceIds = z.array(z.string().max(64)).min(1).max(50);
const shortText = z.string().min(1).max(600);
const optText = z.string().max(300).nullable();
/** 1–3 sentences with every useful specific from the source messages. */
const details = z.string().max(1200).nullable();
/** YYYY-MM-DD, only when the date is unambiguous. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable();
/** HH:MM 24h. */
const hhmm = z
  .string()
  .regex(/^\d{2}:\d{2}$/)
  .nullable();

export const AnnouncementSchema = z.object({
  title: shortText,
  details,
  status: ItemStatusSchema,
  sourceIds,
});

export const EventSchema = z.object({
  title: shortText,
  details,
  date: isoDate,
  time: hhmm,
  /** The date/time exactly as phrased in the message(s), translated to Russian. */
  dateText: optText,
  location: optText,
  status: ItemStatusSchema,
  sourceIds,
});

export const TaskSchema = z.object({
  task: shortText,
  details,
  deadline: isoDate,
  deadlineText: optText,
  /** Who is expected to act (e.g. "все родители"), null if not stated. */
  assignee: optText,
  status: ItemStatusSchema,
  sourceIds,
});

export const PaymentSchema = z.object({
  purpose: shortText,
  details,
  amount: z.number().nonnegative().nullable(),
  currency: z.string().max(10).nullable(),
  /** Amount exactly as written, e.g. "50 ש״ח с ребёнка". */
  amountText: optText,
  deadline: isoDate,
  method: optText,
  status: ItemStatusSchema,
  sourceIds,
});

export const ChangeSchema = z.object({
  what: shortText,
  details,
  before: optText,
  after: shortText,
  sourceIds,
});

export const AiSummarySchema = z.object({
  overview: z.string().max(1500),
  announcements: z.array(AnnouncementSchema).max(50),
  events: z.array(EventSchema).max(50),
  tasks: z.array(TaskSchema).max(50),
  payments: z.array(PaymentSchema).max(50),
  changes: z.array(ChangeSchema).max(50),
  other: z.array(AnnouncementSchema).max(50),
  /** Full Russian translations of cited messages that are not in Russian. */
  translations: z
    .array(z.object({ id: z.string().max(64), ru: z.string().min(1).max(6000) }))
    .max(300)
    .default([]),
});
export type AiSummary = z.infer<typeof AiSummarySchema>;

export const SECTION_KEYS = ["announcements", "events", "tasks", "payments", "changes", "other"] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export const SECTION_TITLES_RU: Record<SectionKey, string> = {
  announcements: "Важные объявления",
  events: "Даты и события",
  tasks: "Что нужно сделать",
  payments: "Оплаты и финансы",
  changes: "Изменения планов",
  other: "Другое важное",
};

/* ------------------------------------------------------------------ */
/* Server response — AI summary enriched with *real* source metadata. */
/* ------------------------------------------------------------------ */

export const SourceRefSchema = z.object({
  id: z.string(),
  timestamp: LocalIsoDateTime,
  sender: z.string().nullable(),
  /** Original message text as sent for analysis (redacted; photo readings appended as "[Фото: …]"). */
  text: z.string().default(""),
  /** Full Russian translation, or null if the original is already Russian / not translated. */
  translation: z.string().nullable().default(null),
  /** Documents attached to this message, with their digest (shown under the source). */
  documents: z
    .array(DocumentDigestSchema.extend({ name: z.string(), kind: z.enum(["pdf", "docx"]), pages: z.number().int().nullable() }))
    .default([]),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

const withSources = <T extends z.ZodRawShape>(s: z.ZodObject<T>) => s.extend({ sources: z.array(SourceRefSchema) });

export const EnrichedSummarySchema = z.object({
  overview: z.string(),
  /* translations are folded into each item's sources */
  announcements: z.array(withSources(AnnouncementSchema)),
  events: z.array(withSources(EventSchema)),
  tasks: z.array(withSources(TaskSchema)),
  payments: z.array(withSources(PaymentSchema)),
  changes: z.array(withSources(ChangeSchema)),
  other: z.array(withSources(AnnouncementSchema)),
});
export type EnrichedSummary = z.infer<typeof EnrichedSummarySchema>;

export const SummarizeResponseSchema = z.object({
  summary: EnrichedSummarySchema,
  meta: z.object({
    provider: z.string(),
    model: z.string(),
    messagesAnalyzed: z.number().int(),
    batches: z.number().int(),
    /** Source ids returned by the model that did not match any input message (dropped). */
    unknownSourceIdsDropped: z.number().int(),
    imagesAnalyzed: z.number().int().default(0),
    imagesFailed: z.number().int().default(0),
    /** Photos whose cached reading was reused (not sent to the AI again). */
    imagesCached: z.number().int().default(0),
    /** Fresh readings, by index in request.images — the extension caches them for later summaries. */
    imageReadings: z.array(ImageReadingSchema.extend({ index: z.number().int().min(0) })).default([]),
    documentsAnalyzed: z.number().int().default(0),
    documentsCached: z.number().int().default(0),
    documentsFailed: z.number().int().default(0),
    /** Fresh digests, by index in request.documents — cached by the extension like photo readings. */
    documentDigests: z.array(DocumentDigestSchema.extend({ index: z.number().int().min(0) })).default([]),
    visionModel: z.string().nullable().default(null),
    generatedAt: z.string(),
  }),
  coverage: CoverageSchema,
  groupName: z.string(),
  period: PeriodSchema,
});
export type SummarizeResponse = z.infer<typeof SummarizeResponseSchema>;

export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  version: z.string(),
  ai: z.object({
    provider: z.string(),
    model: z.string(),
    configured: z.boolean(),
    /** null = not checked yet / could not check. */
    modelAvailable: z.boolean().nullable(),
    message: z.string().nullable(),
    /** Photo analysis: null model = not configured for this provider. */
    vision: z
      .object({ model: z.string().nullable(), available: z.boolean().nullable() })
      .default({ model: null, available: null }),
  }),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ErrorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
