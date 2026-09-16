import { createHmac, timingSafeEqual } from "node:crypto";

/** Replay window for `x-lichess-signature`. Matches Stripe's default. */
export const LICHESS_WEBHOOK_TOLERANCE_SEC = 300;

/**
 * Sign key contract for POST /api/webhooks/lichess.
 *
 * Lichess does not sign this URL. The caller (onryde/seazn.club.workflow) signs
 * the raw body with `LICHESS_WEBHOOK_SECRET` as an HMAC-SHA256 key:
 *
 *   header: `x-lichess-signature: t=<unix seconds>,v1=<hex>`
 *   mac:    HMAC-SHA256(secret, `${t}.${rawBody}`) → lowercase hex
 *
 * A shared-secret equality check is not enough: it does not bind the body, so
 * a captured header can be replayed with a different payload.
 */
export function signLichessWebhook(opts: {
  secret: string;
  timestamp: number;
  rawBody: string;
}): string {
  const mac = createHmac("sha256", opts.secret)
    .update(`${opts.timestamp}.${opts.rawBody}`)
    .digest("hex");
  return `t=${opts.timestamp},v1=${mac}`;
}

export function verifyLichessWebhookSignature(opts: {
  secret: string;
  header: string | null;
  rawBody: string;
  nowSec?: number;
}): { ok: true } | { ok: false; reason: "missing" | "malformed" | "stale" | "mismatch" } {
  if (!opts.header) return { ok: false, reason: "missing" };
  const parts = new Map<string, string>();
  for (const piece of opts.header.split(",")) {
    const i = piece.indexOf("=");
    if (i <= 0) continue;
    parts.set(piece.slice(0, i).trim(), piece.slice(i + 1).trim());
  }
  const tRaw = parts.get("t");
  const v1 = parts.get("v1");
  if (!tRaw || !v1 || !/^\d+$/.test(tRaw)) return { ok: false, reason: "malformed" };
  const t = Number(tRaw);
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > LICHESS_WEBHOOK_TOLERANCE_SEC) return { ok: false, reason: "stale" };

  const expected = createHmac("sha256", opts.secret).update(`${t}.${opts.rawBody}`).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(v1, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "mismatch" };
  return { ok: true };
}
