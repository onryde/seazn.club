// Shared fixtures for the Task 6 suites (settle, refund, size, delete doors): an org with its owner, competitions and online chess
// divisions made through the REAL doors (`createCompetition`, `createDivision` — the package row is the door's own), bought packs
// with a payment intent (the claw-back's match key), this month's included credits spent to 0 so a payment draws bought credits,
// and the readers every suite asserts with. Expected numbers never come from here: each suite types its own from the spec.
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { ONLINE_SIZES, packagePrice, type OnlineSize } from "@/lib/online-chess-package";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { seedOwner } from "@/server/usecases/__tests__/_external-play-seed";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import {
  creditBreakdown, grantMonthlyStreamCredits, recordPurchase, recordStreamPackRefund, streamMonthlyGrantKey, streamMonthlyPeriod,
  streamMonthlyRate,
} from "@/server/usecases/stream-credits";
import { onlinePackageQuote, payOnlinePackage, type PayResult } from "@/server/usecases/online-package";

/** Global Constraints: "16→1/2, 32→2/4, 64→4/8, 128→8/16, 256→16/32 credits (without / with cameras)". */
export const GC_PRICE: Record<OnlineSize, readonly [number, number]> = { 16: [1, 2], 32: [2, 4], 64: [4, 8], 128: [8, 16], 256: [16, 32] };
export const gcPrice = (size: OnlineSize, cameras = false): number => GC_PRICE[size][cameras ? 1 : 0];

/** Premise: the leaf charges the Global Constraints' table, every cell. Answers the cells checked. */
export function expectLeafPrices(): number {
  let cells = 0;
  for (const s of ONLINE_SIZES) {
    for (const cams of [false, true]) {
      expect(packagePrice(s, cams), `premise: the leaf's price for ${s}${cams ? " with cameras" : ""}`).toBe(gcPrice(s, cams));
      cells += 1;
    }
  }
  expect(cells).toBe(10);
  return cells;
}

/** 10+5, a curated Board API control: the online switch refuses one outside the catalogue. */
export const CLOCK = { base: 600, increment: 5 };

export const suffix = (): string => randomUUID().replaceAll("-", "").slice(0, 12);

export interface Org {
  orgId: string;
  auth: AuthCtx;
}

/** A pro org with its owner (a signed-in session: the payment names who paid); `plan` moves it to another plan. */
export async function ocOrg(plan?: "community" | "pro"): Promise<Org> {
  const auth = await seedOwner();
  if (plan !== undefined && plan !== "pro") {
    await setOrgPlan(auth.orgId, plan);
    await invalidateOrgEntitlements(auth.orgId);
  }
  return { orgId: auth.orgId, auth };
}

/** A plan's catalogue value (premises only: the expected numbers are the spec's, the catalogue says which plan reaches them). */
export async function catalogue(plan: string, feature: string): Promise<number | null> {
  const [r] = await sql<{ v: number | null }[]>`
    select int_value as v from plan_entitlements where plan_key = ${plan} and feature_key = ${feature}`;
  expect(r, `premise: the catalogue has ${plan}/${feature}`).toBeDefined();
  return r!.v;
}

export async function ocCompetition(o: Org): Promise<string> {
  const c = await createCompetition(o.auth, {
    name: `OC Cup ${suffix()}`, visibility: "private", branding: {}, starts_on: "2030-10-01", ends_on: "2030-10-02",
  });
  return c.id;
}

/** A chess division through the REAL create door: online (Lichess, a curated clock) unless `online: false`. */
export async function ocDivision(
  o: Org, competitionId: string, opts: { online?: boolean; size?: OnlineSize; name?: string } = {},
): Promise<{ id: string; name: string }> {
  const name = opts.name ?? `Open ${suffix()}`;
  const online = opts.online !== false;
  const d = await createDivision(o.auth, competitionId, {
    name,
    sport_key: "boardgame",
    variant_key: "classical",
    config: online ? { variant: "classical", onlinePlay: "lichess", clock: CLOCK } : { variant: "classical", clock: CLOCK },
    ...(opts.size !== undefined ? { online_size: opts.size } : {}),
  });
  return { id: d.id, name: d.name };
}

/** Buy a pack of `n` bought credits through the real purchase writer, with a payment intent (the claw-back's match). */
export async function buy(orgId: string, n: number): Promise<string> {
  const cs = `cs_oct6_${suffix()}`;
  const intent = `pi_${cs}`;
  await recordPurchase({
    orgId, delta: n, stripeEventId: cs,
    link: { checkoutSessionId: cs, paymentIntentId: intent, pack: `seazn_stream_pack_${n}`, amountMinor: 600, currency: "gbp" },
  });
  return intent;
}

/** This month's included credits granted by the real rollover and then spent down to `left` (one raw monthly consume: a
 *  stream's shape with no session — the precondition, not a seam under test). `left` 0 (the default): a payment draws BOUGHT
 *  credits only. Answers the rate. */
export async function spendTheMonth(orgId: string, left = 0): Promise<number> {
  const rate = await streamMonthlyRate(orgId);
  expect(rate, `premise: the plan includes at least ${Math.max(1, left)} credits a month`).toBeGreaterThanOrEqual(Math.max(1, left));
  await grantMonthlyStreamCredits(orgId, rate);
  const { monthly, total } = await creditBreakdown(sql, orgId);
  expect(monthly, "premise: the month was granted").toBe(rate);
  if (monthly > left) {
    await sql`
      insert into org_stream_credits (org_id, delta, reason, bucket, balance_after)
      values (${orgId}, ${left - monthly}, 'consume', 'monthly', ${total - (monthly - left)})`;
  }
  expect((await creditBreakdown(sql, orgId)).monthly, `premise: ${left} included credits left`).toBe(left);
  return rate;
}

/** Move every ledger row the org has so far back one UTC calendar month (the quote and pay suites' helper): "the month
 *  turned". The month's grant key moves with its row, so the rollover of this month is still owed. */
export async function backdateOrgLedger(orgId: string): Promise<void> {
  const [{ now }] = await sql<{ now: Date }[]>`select now() as now`;
  const thisPeriod = streamMonthlyPeriod(now!);
  const lastPeriod = streamMonthlyPeriod(new Date(Date.UTC(now!.getUTCFullYear(), now!.getUTCMonth() - 1, 15, 12)));
  expect(lastPeriod, "premise: two different months").not.toBe(thisPeriod);
  const thisKey = streamMonthlyGrantKey(orgId, thisPeriod);
  const lastKey = streamMonthlyGrantKey(orgId, lastPeriod);
  await sql`
    update org_stream_credits
       set created_at = (created_at at time zone 'UTC' - interval '1 month') at time zone 'UTC',
           idempotency_key = case when starts_with(idempotency_key, ${thisKey}::text)
                                  then ${lastKey}::text || substr(idempotency_key, ${thisKey.length + 1}::int)
                                  else idempotency_key end
     where org_id = ${orgId}`;
  const [left] = await sql<{ n: number }[]>`
    select count(*)::int as n from org_stream_credits
     where org_id = ${orgId} and to_char(created_at at time zone 'UTC', 'YYYY-MM') = ${thisPeriod}`;
  expect(left!.n, "premise: nothing of the org's ledger is left in this month").toBe(0);
}

/** `n` confirmed individual entrants in the division: places held. */
export async function seedEntrants(orgId: string, divisionId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await sql`
      insert into entrants (division_id, org_id, kind, display_name, status)
      values (${divisionId}, ${orgId}, 'individual', ${"P " + suffix()}, 'confirmed')`;
  }
}

/** A Swiss stage declaring `rounds` rounds (the stage door's own shape; P15 counts `config.rounds`). */
export async function seedSwiss(orgId: string, divisionId: string, rounds: number): Promise<void> {
  const [{ seq }] = await sql<{ seq: number }[]>`select coalesce(max(seq), 0)::int + 1 as seq from stages where division_id = ${divisionId}`;
  await sql`
    insert into stages (division_id, org_id, seq, kind, name, config)
    values (${divisionId}, ${orgId}, ${seq!}, 'swiss', ${`Swiss ${seq}`}, ${sql.json({ rounds } as never)})`;
}

/** `n` bought credits spent on streams (raw pack consumes with no session: the claw-back suite's own precondition). */
export async function streamSpend(orgId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    const { total } = await creditBreakdown(sql, orgId);
    await sql`insert into org_stream_credits (org_id, delta, reason, bucket, balance_after) values (${orgId}, -1, 'consume', 'pack', ${total - 1})`;
  }
}

/** The organiser opens the receipt for `size` and confirms the total it shows, and on a move down the credits it said would
 *  not come back (the route's usecase, no deps). */
export async function pay(o: Org, divisionId: string, size: OnlineSize): Promise<PayResult> {
  const shown = await onlinePackageQuote(o.auth, divisionId, size);
  const forfeited = shown.back?.forfeited ?? 0;
  return payOnlinePackage(o.auth, divisionId, { size, expectedOwed: shown.owed, ...(forfeited > 0 ? { expectedForfeited: forfeited } : {}) });
}

/** A card refund of the pack bought with `intent`, as the webhook's refund arm calls the writer. */
export const cardRefund = (intent: string) => recordStreamPackRefund({ paymentIntentId: intent, via: "refund", reference: `ch_${suffix()}` });

export async function balance(orgId: string): Promise<{ monthly: number; pack: number; total: number }> {
  return creditBreakdown(sql, orgId);
}

export interface PackageState {
  id: string; division_id: string | null; division_name: string; size: number; cameras_paid: boolean | null; credits_paid: number;
  credits_refunded: number; credits_forfeited: number; paid_at: Date | null; frozen_at: Date | null; refunded_at: Date | null;
  created_at: Date;
}
const PACKAGE_COLS = sql`id, division_id, division_name, size, cameras_paid, credits_paid, credits_refunded, credits_forfeited, paid_at,
  frozen_at, refunded_at, created_at`;

export async function packageById(id: string): Promise<PackageState | null> {
  const [p] = await sql<PackageState[]>`select ${PACKAGE_COLS} from division_online_packages where id = ${id}`;
  return p ?? null;
}

/** The package's own ledger rows (reason, bucket, delta), sorted as a multiset: rows of one transaction share `created_at`. */
export async function packageLedger(packageId: string): Promise<{ reason: string; bucket: string; delta: number }[]> {
  const rows = await sql<{ reason: string; bucket: string; delta: number }[]>`
    select reason, bucket, delta from org_stream_credits where online_package_id = ${packageId}`;
  return [...rows].sort((a, b) => `${a.reason}${a.bucket}${a.delta}`.localeCompare(`${b.reason}${b.bucket}${b.delta}`));
}

export async function orgLedgerCount(orgId: string): Promise<number> {
  return (await sql<{ n: number }[]>`select count(*)::int as n from org_stream_credits where org_id = ${orgId}`)[0]!.n;
}

/** Every package row a division ever had (live or refunded), oldest first. */
export async function packagesOf(divisionId: string): Promise<PackageState[]> {
  return sql<PackageState[]>`select ${PACKAGE_COLS} from division_online_packages where division_id = ${divisionId} order by created_at, id`;
}

/** The division's one live row (refunded_at null), asserted present. */
export async function liveOf(divisionId: string): Promise<PackageState> {
  const live = (await packagesOf(divisionId)).filter((p) => p.refunded_at === null);
  expect(live, `premise: division ${divisionId} has exactly one live package`).toHaveLength(1);
  return live[0]!;
}

/** The org's revoke rows (claw-back and settle), oldest first: delta, key and intent. */
export async function revokes(orgId: string): Promise<{ delta: number; idempotency_key: string | null; stripe_payment_intent_id: string | null }[]> {
  return sql`
    select delta, idempotency_key, stripe_payment_intent_id from org_stream_credits
     where org_id = ${orgId} and reason = 'revoke' order by created_at, id`;
}

export async function reversalsOf(orgId: string): Promise<{ intent: string; purchased: number }[]> {
  return sql`select stripe_payment_intent_id as intent, purchased from stream_pack_reversals where org_id = ${orgId} order by created_at`;
}

/** Both invariants of §7.1 on one package after a step: paid − refunded is its net ledger debit; on a live paid row the value is
 *  the table's price. Answers how many it checked. */
export async function expectBooks(packageId: string, label: string): Promise<number> {
  const p = (await packageById(packageId))!;
  const [l] = await sql<{ net: number }[]>`
    select coalesce(-sum(delta), 0)::int as net from org_stream_credits where online_package_id = ${packageId}`;
  expect(p.credits_paid - p.credits_refunded, `${label}: paid − refunded is the package's net ledger debit`).toBe(l!.net);
  if (p.paid_at === null || p.refunded_at !== null) return 1;
  expect(p.credits_paid - p.credits_refunded - p.credits_forfeited, `${label}: the value is the table's price`)
    .toBe(gcPrice(p.size as OnlineSize, p.cameras_paid === true));
  return 2;
}

/** A round opened: the package freezes (Task 9 owns the real stamp; this is the state it leaves, as the schema suite writes it). */
export async function freeze(packageId: string): Promise<void> {
  await sql`update division_online_packages set frozen_at = now() where id = ${packageId}`;
}

export async function refusal(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpError) return e;
    throw e;
  }
  throw new Error("expected a refusal, got an answer");
}

export async function divisionExists(id: string): Promise<boolean> {
  const [d] = await sql`select 1 from divisions where id = ${id}`;
  return d !== undefined;
}
