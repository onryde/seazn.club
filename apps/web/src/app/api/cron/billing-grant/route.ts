import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { checkEarnGrantVolumeAlert, grantMonthlyForAllWallets } from "@/lib/credits";
import { log } from "@/server/logger";

/** POST /api/cron/billing-grant — daily: grant every billing wallet its
 *  `ai.credits.monthly(plan) * quantity_paid` allowance for this period
 *  (SPEC-2 §5.4/§11.2, v17 Task 6) — Community wallets included, flat 10.
 *  A TRIALING paid wallet multiplies by `max(quantity_paid, live_org_count)`
 *  instead (#291; see `grantMonthlyForAllWallets`'s docstring for why).
 *  Each grant first EXPIRES any unspent `grant`-bucket balance left over
 *  from the prior period (D1, use-or-lose) before adding the new period's
 *  allowance; the `pack` bucket (purchased packs, D2) is never touched here
 *  (see `grantMonthly`'s own docstring).
 *  Schedule: apps/cron-worker/src/schedule.ts (the Cloudflare cron Worker,
 *  live while ACTIVE is "true" in apps/cron-worker/wrangler.json). The
 *  onryde/seazn.club.workflow leg also fires it until that schedule is
 *  switched off, so both may fire it meanwhile.
 *  Same daily cadence as billing-quantity.
 *
 *  **Anchor (README §7 item 7; Cadence fix, SPEC-2 §5.4):** every wallet —
 *  paid or Community — resets on the plain calendar month, never on
 *  `subscriptions.current_period_end`. Keying paid wallets off the Stripe
 *  billing-cycle boundary was tried and reverted: an annual-interval
 *  subscription's `current_period_end` only advances once a year, so that
 *  anchor collapsed 12 monthly grants into a single lump — a cadence
 *  regression, not the "regardless of billing cadence" behavior SPEC-2 §5.4
 *  requires (see `grantMonthlyForAllWallets`'s docstring).
 *
 *  Cron-shaped like /api/cron/billing-quantity: x-cron-secret header
 *  (CRON_SECRET env). Also runs the earn_grant daily-volume farm-watch
 *  (v17 gap #296) — same daily poll, no separate schedule.
 *
 *  NOT the stream match credits (Task 14b review M4, controller ruling
 *  2026-09-29, amending R3). A cron sweep would write two ledger rows per live
 *  org per month forever, for orgs that never stream. The month is rolled over
 *  lazily, under the money lock, by the readers that act on it — the division
 *  page's credits card (`relayCredits`), createSession's balance check and the
 *  go-live consume (stream-credits.ts `ensureMonthlyStreamGrant`). Two readers
 *  do NOT run it: the session projection's `balance` (stream-sessions.ts
 *  `currentSession`) and the /admin credits panel (admin-stream-credits.ts),
 *  which read the ledger as it stands. Across a month turn, until one of the
 *  rolling readers runs, a Phone tab already open and staff both see last
 *  month's unexpired free credits. The one path that spends, the go-live
 *  consume, rolls the month first (a roll that fails is reported and the
 *  consume runs on the ledger as it stands). */
export async function POST() {
  return handler(async () => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new HttpError(503, "CRON_SECRET is not configured");
    const given = (await headers()).get("x-cron-secret");
    if (given !== secret) throw new HttpError(401, "Bad cron secret");
    const result = await grantMonthlyForAllWallets();
    // Growth-loop farm-watch (v17 gap #296): the SAME daily poll also checks
    // today's earn_grant volume — no new cron/workflow, this one already
    // runs once a day (apps/cron-worker/src/schedule.ts). checkEarnGrantVolumeAlert never
    // throws on its own, but the failure is caught here too so a check bug
    // can never turn into a failed grant response.
    try {
      await checkEarnGrantVolumeAlert();
    } catch (err) {
      log.error({ err }, "cron/billing-grant: earn_grant volume check failed");
    }
    return result;
  });
}
