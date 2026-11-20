import type { DateOrder } from "@wad/shared";
import type { ExtractionError, ExtractionResult, ProbeResult } from "../content/extractor.ts";

export type ContentRequest = { type: "wad:probe" } | { type: "wad:extract"; dateOrderFallback: DateOrder };
export type ProbeResponse = ProbeResult;
export type ExtractResponse = ExtractionResult | ExtractionError;
export type { ExtractionResult, ExtractionError, ProbeResult };
