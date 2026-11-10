import "server-only";
// The organiser panels' readers: the credits card, the run sheet's open-stream states (see ./index.ts).
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { ACTIVE_STATES, holdStateOf, type HoldState, type SessionState } from "@/server/relay/domain/session";
import { log } from "@/server/logger";
import { captureError } from "@/lib/sentry";
import {
  creditBreakdown,
  ensureMonthlyStreamGrantWithRate,
  streamMonthlyRate,
  type StreamCreditBreakdown,
} from "../stream-credits";

/** What the Phone tab's credits card shows (Task 14b, R2/R4): the balance split by bucket, plus the plan's monthly
 *  allowance for the "Your plan includes {n} free match credits" note. The division page's reader — it GRANTS this
 *  month's free credits first (R3b, `ensureMonthlyStreamGrant`, idempotent), so the idle tab of an org that has never
 *  started a stream already shows them. `total` is creditBalance's number (creditBreakdown sums the same rows), so the
 *  chip and the split cannot disagree.
 *
 *  C1 lives here now (Task 14b review M9 retired `relayBalance`, which nothing but its own test called): the balance is
 *  readable with NO session row. `currentSession` returns `null` until a session exists and `balance` rides inside that
 *  projection, so the idle Phone tab had no other source and read 0 for every credited org. Tenancy is checked the way
 *  the projection checks it: a mismatch is 404, never 403 (404 ≡ missing). */
export interface RelayCredits extends StreamCreditBreakdown {
  /** The plan's `streaming.credits.monthly` (V426), on the org's RESOLVED plan. */
  monthlyAllowance: number;
}

export async function relayCredits(auth: AuthCtx, orgId: string): Promise<RelayCredits> {
  if (orgId !== auth.orgId) throw new HttpError(404, "organisation not found");
  // I3: the ensure resolves the plan's rate to decide a mid-month top-up, and hands it back — the allowance printed on
  // the card is the same number the grant was topped up to, read once.
  let monthlyAllowance: number;
  try {
    ({ rate: monthlyAllowance } = await ensureMonthlyStreamGrantWithRate(orgId));
  } catch (err) {
    // I1: this is a WRITE made during the division page's GET, for every editable org. It can refuse by design (a
    // corrupt ledger's `ledger_negative`) or fail on the lock or the plan read, and a failed grant writes no key, so it
    // fails again on every render. Thrown from here it took down the org's whole fixtures tab (no error boundary under
    // d/[divSlug]/). Log it, report it, and answer the UNGRANTED balance. The next start (createSession) runs the
    // same ensure under the same guard (m4): it logs and reports there too, and admits on the ungranted balance.
    log.error({ err, orgId }, "relayCredits: monthly grant failed; answering the ungranted balance");
    captureError(err, { orgId, route: "relay.credits.monthly_grant" });
    monthlyAllowance = await streamMonthlyRate(orgId).catch(() => 0);
  }
  return { ...(await creditBreakdown(sql, orgId)), monthlyAllowance };
}

/** Spec 2026-09-30 §2 — each listed fixture with a session still up, as a person reads it (live | waiting), THIS org's
 *  only. Feeds the run sheet's chip (the division's path to Stop, frozen or not) and the fixture page's Stop-only mount.
 *  At most one ACTIVE session per fixture (V410 `fixture_stream_sessions_one_active`); `distinct on … created_at desc`
 *  still names the newest should that ever not hold. */
export async function openStreamStates(auth: AuthCtx, fixtureIds: readonly string[]): Promise<Record<string, HoldState>> {
  if (fixtureIds.length === 0) return {};
  const rows = await sql<OpenSessionRow[]>`
    select distinct on (fixture_id) id, fixture_id, state from fixture_stream_sessions
     where org_id = ${auth.orgId} and fixture_id in ${sql([...fixtureIds])} and state in ${sql([...ACTIVE_STATES])}
     order by fixture_id, created_at desc`;
  return holdStatesOf(rows);
}

/** One row of `openStreamStates`' read. */
export type OpenSessionRow = { id: string; fixture_id: string; state: SessionState };

/** The fold after `openStreamStates`' SQL filter, DB-free. ONE guard decides "active": that filter. A row the domain does
 *  not read as live/waiting (a terminal state, or a state this build does not know) means the filter and the domain
 *  disagree — an assumption that broke. B3 fix round 1, I-1 (controller ruling): that must NEVER block the organiser's
 *  page or its Stop, so the row is REPORTED to Sentry (session id and state only — no key, URL or secret) and skipped. */
export function holdStatesOf(rows: readonly OpenSessionRow[]): Record<string, HoldState> {
  const out: Record<string, HoldState> = {};
  for (const r of rows) {
    const s = holdStateOf(r.state);
    // `undefined` too: a state added to the DB but not to `holdStateOf`'s switch falls through it.
    if (s === null || s === undefined) {
      captureError(new Error("openStreamStates: a session the domain does not read as up passed the ACTIVE_STATES filter"), {
        route: "relay.open_stream_states",
        extra: { sessionId: r.id, state: r.state },
      });
      continue;
    }
    out[r.fixture_id] = s;
  }
  return out;
}
