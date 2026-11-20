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
  text: z.string().min(1).max(LIMITS.maxMessageChars),
});
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
  })
  .superRefine((req, ctx) => {
    const total = req.messages.reduce((n, m) => n + m.text.length, 0);
    if (total > LIMITS.maxTotalChars) {
      ctx.addIssue({ code: "custom", message: `Total text too large (${total} > ${LIMITS.maxTotalChars} chars)` });
    }
    const ids = new Set<string>();
    for (const m of req.messages) {
      if (ids.has(m.id)) {
        ctx.addIssue({ code: "custom", message: `Duplicate message id ${m.id}` });
        return;
      }
      ids.add(m.id);
    }
  });
export type SummarizeRequest = z.infer<typeof SummarizeRequestSchema>;

/* ------------------------------------------------------------------ */
/* AI output schema — what the model must return (validated strictly). */
/* ------------------------------------------------------------------ */

export const ItemStatusSchema = z.enum(["confirmed", "proposed", "unclear"]);
export type ItemStatus = z.infer<typeof ItemStatusSchema>;

const sourceIds = z.array(z.string().max(64)).min(1).max(50);
const shortText = z.string().min(1).max(600);
const optText = z.string().max(300).nullable();
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
  details: optText,
  status: ItemStatusSchema,
  sourceIds,
});

export const EventSchema = z.object({
  title: shortText,
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
  deadline: isoDate,
  deadlineText: optText,
  /** Who is expected to act (e.g. "все родители"), null if not stated. */
  assignee: optText,
  status: ItemStatusSchema,
  sourceIds,
});

export const PaymentSchema = z.object({
  purpose: shortText,
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
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

const withSources = <T extends z.ZodRawShape>(s: z.ZodObject<T>) => s.extend({ sources: z.array(SourceRefSchema) });

export const EnrichedSummarySchema = z.object({
  overview: z.string(),
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
  }),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ErrorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
