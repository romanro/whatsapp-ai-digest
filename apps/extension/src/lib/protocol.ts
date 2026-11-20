import type { DateOrder } from "@wad/shared";
import type { ExtractionError, ExtractionResult, ProbeResult } from "../content/extractor.ts";
import type { CapturedImage } from "../content/images.ts";

export type ContentRequest =
  | { type: "wad:probe" }
  | { type: "wad:extract"; dateOrderFallback: DateOrder }
  /** Read the given photos from the last extraction (only photos the user chose to analyse). */
  | { type: "wad:images"; refs: string[] };
export type ProbeResponse = ProbeResult;
export type ExtractResponse = ExtractionResult | ExtractionError;
export type ImagesResponse = CapturedImage[];
export type { ExtractionResult, ExtractionError, ProbeResult, CapturedImage };
