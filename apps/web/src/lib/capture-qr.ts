// lib/capture-qr.ts — the capture QR payload's schemas. Client-safe (zod only): the panel encodes the payload, so this
// module never imports the server's capture-schemas.ts.
//
// v2 (capture QR v2 spec 2026-10-01 §6.2, W3): `{v:2, code, slot, tok, exp?}` and nothing else — the QR never carries
// credentials. `exp` is capture's optional field (A1, §1.2): epoch SECONDS, an integer ≥ 0, and absent means the server
// decides. This server never sends it: captureQrV2Text writes the four keys only. Its JSON contract is docs/contracts/capture-qr.v2.json, checksum- and parity-pinned by
// server/api-v1/__tests__/capture-contract.test.ts.
//
// v1 (design 2026-09-07 §7.6) is gone (§6.13, W4): PR-1 T1 removed its JSON contract and fixtures, and T11 its schema,
// its parser and the organiser projection's `qr`. The organiser never sees ingest credentials any more.
import { z } from "zod";

export const CaptureQrV2 = z.strictObject({
  v: z.literal(2),
  code: z.string().regex(/^[0-9a-hjkmnp-tv-z]{12}$/),
  slot: z.number().int().min(0),
  tok: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  exp: z.number().int().min(0).optional(),
});
export type CaptureQrV2 = z.infer<typeof CaptureQrV2>;
export function parseCaptureQrV2(json: unknown): { ok: true; payload: CaptureQrV2 } | { ok: false; reason: "wrong_version" | "invalid" } {
  if (typeof json === "object" && json !== null && "v" in json && (json as { v: unknown }).v !== 2) return { ok: false, reason: "wrong_version" };
  const p = CaptureQrV2.safeParse(json);
  return p.success ? { ok: true, payload: p.data } : { ok: false, reason: "invalid" };
}
/** The QR and paste-code text: exactly these four keys, in this order (W3; T11's regression pins it). Never `exp`, even
 *  when the payload carries one (A1: we never send it). */
export const captureQrV2Text = (p: CaptureQrV2): string => JSON.stringify({ v: 2, code: p.code, slot: p.slot, tok: p.tok });
