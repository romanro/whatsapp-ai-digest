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
    throw new ApiError("Локальный сервер не запущен. Выполните «pnpm start» в папке проекта.", "offline");
  }
  if (!res.ok) throw new ApiError(`Сервер ответил ошибкой ${res.status}.`, "http");
  return HealthResponseSchema.parse(await res.json());
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
