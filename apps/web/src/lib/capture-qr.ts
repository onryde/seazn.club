// lib/capture-qr.ts — the v1 QR contract's ONE schema (design §7.6, ruling
// R-A). Client-safe: the panel encodes it and the phone app vendors the JSON
// contract this schema is checksummed against (docs/contracts/capture-qr.v1.json).
// BOTH credential shapes are REQUIRED — a payload carrying SRT alone is
// refused (a one-shape payload blocks the fallback outright, §7.6). Every
// credential field is opaque to the phone.
import { z } from "zod";

export const CaptureQrV1 = z
  .object({
    v: z.literal(1),
    sid: z.string().uuid(),
    slot: z.number().int().min(0),
    cred: z
      .object({
        srt: z.object({ url: z.string().min(1), streamId: z.string().min(1), passphrase: z.string().min(1), latencyMs: z.number().int().positive() }).strict(),
        rtmps: z.object({ url: z.string().min(1), streamKey: z.string().min(1) }).strict(),
      })
      .strict(),
    preferred: z.enum(["srt", "rtmps"]),
    /** Unix seconds: provision + max_duration + 30 min. */
    exp: z.number().int().positive(),
  })
  .strict();
export type CaptureQrV1 = z.infer<typeof CaptureQrV1>;

export function parseCaptureQr(
  json: unknown,
  now: Date,
): { ok: true; payload: CaptureQrV1 } | { ok: false; reason: "wrong_version" | "expired" | "invalid" } {
  if (typeof json === "object" && json !== null && "v" in json && (json as { v: unknown }).v !== 1) {
    return { ok: false, reason: "wrong_version" };
  }
  const parsed = CaptureQrV1.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  if (parsed.data.exp * 1000 <= now.getTime()) return { ok: false, reason: "expired" };
  return { ok: true, payload: parsed.data };
}
