import { DEFAULT_BACKEND_URL, type DateOrder, type Period } from "@wad/shared";

export interface Settings {
  backendUrl: string;
  /** Used only when the date order can't be inferred from the chat (all days ≤ 12). */
  dateOrderFallback: DateOrder;
  defaultPeriod: Period;
}

export const DEFAULT_SETTINGS: Settings = {
  backendUrl: DEFAULT_BACKEND_URL,
  dateOrderFallback: "DMY",
  defaultPeriod: "24h",
};

/** The backend must be local: the extension only has host permission for 127.0.0.1 / localhost. */
export function isLocalBackendUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.pathname === "/";
  } catch {
    return false;
  }
}

export async function loadSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get("settings")).settings as Partial<Settings> | undefined;
  const s = { ...DEFAULT_SETTINGS, ...stored };
  if (!isLocalBackendUrl(s.backendUrl.endsWith("/") ? s.backendUrl : `${s.backendUrl}/`)) s.backendUrl = DEFAULT_BACKEND_URL;
  return s;
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ settings: s });
}
