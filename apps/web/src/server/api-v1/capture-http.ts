// server/api-v1/capture-http.ts — the phone-facing refusal (capture QR v2 §6.3, the `capture-refusal` contract). T5
// creates it for `resolveStreamCode`; T8a–T8c extend this module with the wire mapping. The `code` is the contract's
// closed `CaptureRefusalCode` list, so a refusal the phone cannot key its copy on does not compile.
import type { CaptureRefusalCode } from "./capture-schemas";

export class CaptureRefusalError extends Error {
  constructor(
    readonly status: number,
    readonly code: CaptureRefusalCode,
    message: string,
    /** Only `already_live` carries extras on the wire (`{sid, startedBy}`, contract R5). */
    readonly extras?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CaptureRefusalError";
  }
}
