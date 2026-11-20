import { useCallback, useEffect, useState } from "react";
import type { HealthResponse } from "@wad/shared";
import { fetchHealth } from "../lib/api.ts";
import { getWhatsAppTab, probeTab } from "../lib/chrome.ts";
import type { ProbeResult } from "../lib/protocol.ts";

export type Check<T = undefined> =
  | { state: "checking" }
  | { state: "ok"; data: T }
  | { state: "fail"; message: string };

export interface Status {
  tabId: number | null;
  whatsapp: Check<ProbeResult>;
  backend: Check<HealthResponse>;
}

export function useStatus(backendUrl: string | null) {
  const [status, setStatus] = useState<Status>({
    tabId: null,
    whatsapp: { state: "checking" },
    backend: { state: "checking" },
  });

  const refresh = useCallback(async () => {
    if (!backendUrl) return;
    setStatus({ tabId: null, whatsapp: { state: "checking" }, backend: { state: "checking" } });

    const waPromise = (async (): Promise<[number | null, Check<ProbeResult>]> => {
      const tab = await getWhatsAppTab();
      if (!tab?.id) return [null, { state: "fail", message: "Откройте вкладку web.whatsapp.com и нажмите на значок расширения там." }];
      try {
        const probe = await probeTab(tab.id);
        if (!probe.whatsappLoaded) return [tab.id, { state: "fail", message: "WhatsApp Web ещё загружается или вы не вошли в аккаунт." }];
        return [tab.id, { state: "ok", data: probe }];
      } catch {
        return [tab.id, { state: "fail", message: "Не удалось подключиться к странице. Обновите вкладку WhatsApp (F5)." }];
      }
    })();

    const bePromise = fetchHealth(backendUrl).then(
      (data): Check<HealthResponse> => ({ state: "ok", data }),
      (err: Error): Check<HealthResponse> => ({ state: "fail", message: err.message }),
    );

    const [[tabId, whatsapp], backend] = await Promise.all([waPromise, bePromise]);
    setStatus({ tabId, whatsapp, backend });
  }, [backendUrl]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial async status check on popup open
    void refresh();
  }, [refresh]);

  return { status, refresh };
}
