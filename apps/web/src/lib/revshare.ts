import "server-only";
import { cookies } from "next/headers";
import { log } from "@/server/logger";
import { REF_CODE_RE, REVSHARE_COOKIE, REVSHARE_PROGRAM_ID, revshareEnabled } from "@/lib/revshare-shared";

export { REVSHARE_PROGRAM_ID };

// Revshare affiliate tracking (https://www.revshare.so). On an affiliate landing
// (lib/revshare-script.ts) the tracking script sets window.revshare_metadata.ref_code;
// <RevshareCapture> copies it into the first-party `rs_ref` cookie; createOrgForUser consumes that
// cookie into subscriptions.revshare_ref_code for a user's FIRST org only; the
// Stripe invoice handler reports each subscription charge. The whole chain is off
// unless NEXT_PUBLIC_REVSHARE_ENABLED=1. REVSHARE_API_KEY must never reach the client.

const REFERRAL_URL = "https://www.revshare.so/api/referral";

/** The cookie is client-writable, so treat it as hostile: short, URL-safe only. */
export function sanitizeRefCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  return REF_CODE_RE.test(v) ? v : null;
}

/**
 * Read the rs_ref cookie, clear it, and return the validated code (or null).
 * Does nothing (and leaves the cookie alone) while the integration is disabled.
 */
export async function consumeRevshareCookie(): Promise<string | null> {
  if (!revshareEnabled()) return null;
  let jar: Awaited<ReturnType<typeof cookies>>;
  try {
    jar = await cookies();
  } catch {
    return null; // no request scope (script / unit test)
  }
  if (!jar.get(REVSHARE_COOKIE)) return null;
  const code = sanitizeRefCode(jar.get(REVSHARE_COOKIE)?.value);
  try {
    jar.delete(REVSHARE_COOKIE);
  } catch {
    // Server Component render (ensureActiveOrg): cookies are read-only, so the
    // cookie survives. Harmless: only a user's FIRST org is ever stamped, and a
    // second org creation finds the code unused.
  }
  return code;
}

export interface SaleInput {
  refCode: string;
  /** Must be unique per sale — Revshare ignores duplicate transaction ids. */
  transactionId: string;
  /** Minor units (cents), EXCLUDING tax. */
  amountCents: number;
  currency: string;
  /** Stable per customer so recurring revenue is attributed together. */
  customerId: string;
}

export function buildReferralBody(s: SaleInput) {
  return {
    ref_code: s.refCode,
    program_id: REVSHARE_PROGRAM_ID,
    spent_amount: s.amountCents,
    currency: s.currency.toUpperCase(),
    transaction_id: s.transactionId,
    customer_id: s.customerId,
  };
}

let warnedNoKey = false;

/**
 * Report a sale. Best-effort: never throws, because it runs inside the Stripe
 * webhook and an affiliate outage must not 500 a paid invoice. A no-op while
 * disabled (stg/local), without REVSHARE_API_KEY, or for a zero-value sale.
 */
export async function reportSale(s: SaleInput): Promise<void> {
  if (!revshareEnabled()) return;
  const key = process.env.REVSHARE_API_KEY;
  if (!key) {
    if (!warnedNoKey && process.env.NODE_ENV === "production") {
      warnedNoKey = true;
      log.warn("revshare: enabled but REVSHARE_API_KEY is unset — affiliate sales are NOT being reported");
    }
    return;
  }
  // `!(x > 0)` also refuses NaN/undefined, which `x <= 0` would let through.
  if (!(s.amountCents > 0)) return;
  try {
    const res = await fetch(REFERRAL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key },
      body: JSON.stringify(buildReferralBody(s)),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      log.error(
        { status: res.status, transactionId: s.transactionId },
        "revshare: referral report rejected",
      );
    }
  } catch (err) {
    log.error({ err, transactionId: s.transactionId }, "revshare: referral report failed");
  }
}
