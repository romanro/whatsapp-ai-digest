import {
  ErrorResponseSchema,
  HealthResponseSchema,
  SummarizeResponseSchema,
  type HealthResponse,
  type SummarizeRequest,
  type SummarizeResponse,
} from "@wad/shared";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

const base = (url: string) => url.replace(/\/+$/, "");

export async function fetchHealth(backendUrl: string, signal?: AbortSignal): Promise<HealthResponse> {
  let res: Response;
  try {
    res = await fetch(`${base(backendUrl)}/health`, { signal });
  } catch {
    throw new ApiError("Локальный сервер не запущен. Запустите WhatsApp AI Digest (значок в трее) или выполните «pnpm start».", "offline");
  }
  if (!res.ok) throw new ApiError(`Сервер ответил ошибкой ${res.status}.`, "http");
  return HealthResponseSchema.parse(await res.json());
}

/** Asks the local server for a file found in Chrome's download history. */
export async function fetchLocalDocument(backendUrl: string, path: string, name: string): Promise<File> {
  let res: Response;
  try {
    res = await fetch(`${base(backendUrl)}/api/local-document`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
  } catch {
    throw new ApiError("Нет связи с локальным сервером.", "offline");
  }
  if (!res.ok) {
    const parsed = ErrorResponseSchema.safeParse(await res.json().catch(() => null));
    throw new ApiError(parsed.success ? parsed.data.error.message : `Ошибка сервера (${res.status}).`, parsed.success ? parsed.data.error.code : "http");
  }
  return new File([await res.arrayBuffer()], name);
}

export async function requestSummary(backendUrl: string, body: SummarizeRequest, signal?: AbortSignal): Promise<SummarizeResponse> {
  let res: Response;
  try {
    res = await fetch(`${base(backendUrl)}/api/summarize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw new ApiError("Отменено.", "aborted");
    throw new ApiError("Нет связи с локальным сервером.", "offline");
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const parsed = ErrorResponseSchema.safeParse(json);
    throw new ApiError(parsed.success ? parsed.data.error.message : `Ошибка сервера (${res.status}).`, parsed.success ? parsed.data.error.code : "http");
  }
  const parsed = SummarizeResponseSchema.safeParse(json);
  if (!parsed.success) throw new ApiError("Сервер вернул ответ в неожиданном формате.", "bad_response");
  return parsed.data;
}
