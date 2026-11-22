export const DEFAULT_BACKEND_URL = "http://127.0.0.1:3741";
export const BACKEND_PORT = 3741;

export const PERIODS = ["24h", "3d", "7d"] as const;
export type Period = (typeof PERIODS)[number];

export const PERIOD_HOURS: Record<Period, number> = {
  "24h": 24,
  "3d": 72,
  "7d": 168,
};

export const PERIOD_LABELS_RU: Record<Period, string> = {
  "24h": "Последние 24 часа",
  "3d": "Последние 3 дня",
  "7d": "Последние 7 дней",
};

/** Hard limits shared by the extension (pre-check) and the server (enforcement). */
export const LIMITS = {
  maxMessages: 2000,
  maxMessageChars: 4000,
  maxSenderChars: 120,
  maxGroupNameChars: 200,
  maxTotalChars: 400_000,
  /** Hard cap of photos per request (the user-facing default is lower, see DEFAULT_MAX_IMAGES). */
  maxImages: 20,
  /** One compressed JPEG as a data URL (~500 KB of image). */
  maxImageDataUrlChars: 700_000,
  /** Documents (PDF/DOCX) the user added, per request. */
  maxDocuments: 5,
  /** Text of one document; longer documents are cut (≈ 25–30 pages) — the free Groq tier can't digest more anyway. */
  maxDocumentChars: 60_000,
  maxDocumentNameChars: 200,
  /** Scanned PDFs (no text layer): first pages sent as images. */
  maxDocumentPageImages: 3,
} as const;

/** Documents up to this length also get a full Russian translation (longer ones: summary and key points only). */
export const DOCUMENT_TRANSLATE_MAX_CHARS = 8_000;

export const DEFAULT_MAX_IMAGES = 10;
/** Longest side of a photo sent for analysis; enough to read a textbook page, small enough for rate limits. */
export const IMAGE_MAX_SIDE = 1280;
