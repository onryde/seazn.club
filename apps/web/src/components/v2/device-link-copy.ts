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
