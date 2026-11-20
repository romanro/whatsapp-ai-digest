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
} as const;
