import { ApiV1Error } from "@/lib/client-v1";
import type { MessageKey } from "@/lib/messages";

export interface CopyRef {
  key: MessageKey;
  vars?: Record<string, string>;
}

/**
 * The "a link is live" line when no QR is on screen (scorer sheets §4.2).
 *
 * A sealed link has `expires_at: null` — it lives until the fixture is over —
 * and `new Date(null)` is the epoch, so formatting it would tell the organiser
 * the link died in 1970. A dated row keeps the existing dated line (no new
 * legacy copy, owner ruling Q3).
 */
export function liveCopy(expiresAt: string | null, format: (iso: string) => string): CopyRef {
  return expiresAt === null
    ? { key: "dlink.liveUntilOver" }
    : { key: "dlink.live", vars: { date: format(expiresAt) } };
}

/**
 * What the device-link routes (ensure, reissue, revoke) refuse with, by wire
 * STATUS. `api-v1/http.ts` sends `code ?? statusCode(status)`, and these
 * routes' refusals carry no specific code except the missing key — a
 * finalized/cancelled fixture arrives as 422 "ERROR" — so status is the only
 * thing that tells them apart.
 */
const FAILURE_BY_STATUS: Partial<Record<number, MessageKey>> = {
  // An expired session: "try again" cannot work until they sign in again.
  401: "dlink.error.signedOut",
  403: "dlink.error.forbidden",
  404: "dlink.error.notFound",
  422: "dlink.error.matchOver",
  429: "dlink.error.rateLimited",
};

/**
 * A device-link refusal as the organiser reads it: a localised key chosen by
 * code, then status, with a generic localised line for anything else (a 500, a
 * dropped connection). Never the server's English (T3 review finding 3). A 402
 * never reaches here — the panel routes it to the upgrade gate first.
 */
export function failureKey(err: unknown): MessageKey {
  if (err instanceof ApiV1Error) {
    if (err.code === "DEVICE_LINK_KEK_MISSING") return "dlink.kekMissing";
    const byStatus = FAILURE_BY_STATUS[err.status];
    if (byStatus !== undefined) return byStatus;
  }
  return "dlink.failed";
}
