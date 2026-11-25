// Pay, upgrade, add cameras and move down (spec 2026-11-23-online-chess-credits-design.md §7.1, §7.3, §7.4 item 3; P6, P13, P19,
// P21; decisions 7, 14, 16; plan Task 5). The money-moving door: it turns the quote (Task 4) into ledger debits or returns and
// package-row state, under the `division:` lock, the org money lock and the package row's lock, exactly once. Every case runs
// against a REAL migrated database through the REAL usecase (`payOnlinePackage`), and is skipped without DATABASE_URL.
//
// Where the expected numbers come from — never from pay.ts or quote.ts:
//   * every price is the Global Constraints' table, typed here (`GC_PRICE`: 16→1/2, 32→2/4, 64→4/8, 128→8/16, 256→16/32) and
//     held against the leaf by a premise, so a drift in either reds;
//   * a debit's split is P4 (this month's included credits first, then bought ones) over a bucket the rig PUT there: the month's
//     included credits are granted by the real rollover at the plan's catalogue rate, then spent down to the case's `monthly` by a
//     warm-up debit on another package of the org — so each case states its buckets and the arithmetic is the rule's;
//   * a return's split is P21 (bought first, then included credits of this month; an earlier month's are forfeited), from the
//     buckets the case paid from;
//   * the plan's monthly rate and caps are read from the catalogue table (`plan_entitlements`), as premises only.
//
// The client's `expectedOwed` comes from the read door the receipt calls (`onlinePackageQuote`), as a browser would get it; the
// assertions never compare against it, only against the table.
//
// single-sport: Online Chess is boardgame only (online-play.ts `supportsOnlinePlay`); the online check below sends a division
// whose online play is off, which is what every other sport is.
//
// Mutant table (each run once by hand; results in the commit message):
//   P1  the expectedOwed comparison dropped                     -> "two tabs, 32 then 64", "the camera policy changed"
//   P2  an upgrade charges the full price, not the difference    -> "upgrade charges the difference", "SEQUENCE"
//   P3  a move down returns an expired included credit           -> "move down: ... earlier month", "the month turns"
//   P4  a move up credits the forfeited credits toward its price -> "move down then up"
//   P5  the at-target state check dropped                        -> "the same payment twice"
//   P6  the expectedForfeited comparison dropped                 -> "the month turns between the receipt and the confirm"
//   P7  the role gate dropped                                    -> "who may pay"
//   P8  the online check dropped                                 -> "a division that does not play online"
//   P9  the billing-freeze guard dropped                         -> "pay is refused on a billing-frozen competition"
//   P10 the flag gate dropped                                    -> "with the flag off"
//   P11 the capacity clamp dropped                               -> "a size change lowers a stored registration capacity"
//   P12 the settle step not run on a move down                   -> "a move down runs the settle step inside its transaction"
//   P13 the value guard dropped                                  -> "a package whose counters disagree with its price"
//   P14 the ledger guard dropped                                 -> "a package whose counters disagree with its ledger"
//   P15 a refusal in the fresh quote ignored (paid anyway)       -> "409 when the rounds were raised", "move down refused ..."
//   (lock order and the locks themselves: pay-concurrency.test.ts)
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The flag (`online-chess`) asks PostHog unless ONLINE_CHESS_ALWAYS=1 forces it on; here PostHog always answers OFF, so the
// override alone decides, and "the flag off" is the override removed.
vi.mock("@/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posthog-server")>();
  return { ...actual, isServerFeatureEnabled: vi.fn(async () => false) };
});

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { sql, type Tx } from "@/lib/db";
import { getLimit, invalidateOrgEntitlements } from "@/lib/entitlements";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { ONLINE_SIZES, packagePrice, type OnlineSize } from "@/lib/online-chess-package";
import type { AuthCtx } from "@/server/api-v1/auth";
import { frozenCompetitionIds } from "@/server/usecases/entitlement-freeze";
import { forgetOnlineChessFlagCache } from "@/server/usecases/external-play/online-chess-flag";
import {
  creditBreakdown, grantMonthlyStreamCredits, recordPurchase, revokeCredits, streamMonthlyGrantKey, streamMonthlyPeriod,
  streamMonthlyRate,
} from "@/server/usecases/stream-credits";
import {
  debitForPackage, onlinePackageQuote, payOnlinePackage, payOnlinePackageInTx, readPackageFacts,
  type PackageQuote, type PayDeps, type PayInput, type PayResult,
} from "@/server/usecases/online-package";
import { patchDivision } from "@/server/usecases/divisions";
import { seedBoardgameSport } from "@/server/usecases/__tests__/_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;

/** Global Constraints: "16→1/2, 32→2/4, 64→4/8, 128→8/16, 256→16/32 credits (without / with cameras)". */
const GC_PRICE: Record<OnlineSize, readonly [number, number]> = { 16: [1, 2], 32: [2, 4], 64: [4, 8], 128: [8, 16], 256: [16, 32] };
const price = (size: number, cameras: boolean | null): number => GC_PRICE[size as OnlineSize][cameras === true ? 1 : 0];
/** The 409's message when the confirmed total (or forfeit) moved and the size is still allowed. */
const TOTAL_CHANGED = "The Online Chess total changed since it was shown; check the new total and confirm again";

type Plan = "pro" | "community";
/** The catalogue's monthly rate and per-division cap of each plan the rigs use (set in beforeAll, premises only). */
const RATE: Record<Plan, number> = { pro: 0, community: 0 };
let DB_NOW: Date;
let THIS_PERIOD: string;
let LAST_PERIOD: string;
const ALWAYS = process.env.ONLINE_CHESS_ALWAYS;

const suffix = (): string => randomUUID().replaceAll("-", "").slice(0, 12);
const inTx = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => sql.begin(fn) as unknown as Promise<T>;

async function catalogue(plan: Plan, feature: string): Promise<number | null> {
  const [r] = await sql<{ v: number | null }[]>`
    select int_value as v from plan_entitlements where plan_key = ${plan} and feature_key = ${feature}`;
  expect(r, `premise: the catalogue has ${plan}/${feature}`).toBeDefined();
  return r!.v;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.ONLINE_CHESS_ALWAYS = "1";
  forgetOnlineChessFlagCache();
  let cells = 0;
  for (const s of ONLINE_SIZES) {
    for (const cams of [false, true]) {
      expect(packagePrice(s, cams), `premise: the leaf's price for ${s}${cams ? " with cameras" : ""} is the Global Constraints'`).toBe(price(s, cams));
      cells += 1;
    }
  }
  expect(cells, "premise: every cell of the price table").toBe(10);
  DB_NOW = (await sql<{ now: Date }[]>`select now() as now`)[0]!.now;
  THIS_PERIOD = streamMonthlyPeriod(DB_NOW);
  LAST_PERIOD = streamMonthlyPeriod(new Date(Date.UTC(DB_NOW.getUTCFullYear(), DB_NOW.getUTCMonth() - 1, 15, 12)));
  expect(LAST_PERIOD, "premise: two different months").not.toBe(THIS_PERIOD);
  for (const plan of ["pro", "community"] as const) {
    RATE[plan] = (await catalogue(plan, "streaming.credits.monthly")) ?? 0;
    expect(RATE[plan], `premise: ${plan} includes at least one Seazn credit a month`).toBeGreaterThanOrEqual(1);
  }
  // The rigs need pro to allow every size (the 256 sweep) and to include at least 4 credits a month (the included-credit cases).
  const proCap = await catalogue("pro", "entrants.per_division.max");
  expect(proCap === null || proCap >= 256, "premise: pro allows a 256 package").toBe(true);
  expect(RATE.pro, "premise: pro includes at least 4 credits a month (the included-credit rigs spend down to 4)").toBeGreaterThanOrEqual(4);
});

afterAll(async () => {
  if (ALWAYS === undefined) delete process.env.ONLINE_CHESS_ALWAYS;
  else process.env.ONLINE_CHESS_ALWAYS = ALWAYS;
  if (!HAS_DB) return;
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────────────────────────────────────────────

type Policy = "off" | "optional" | "required";

interface Rig {
  orgId: string;
  userId: string;
  auth: AuthCtx;
  competitionId: string;
  divisionId: string;
  divisionName: string;
  packageId: string;
}

const buy = (orgId: string, n: number) => {
  const cs = `cs_ocpay_${suffix()}`;
  return recordPurchase({
    orgId, delta: n, stripeEventId: cs,
    link: { checkoutSessionId: cs, paymentIntentId: `pi_${cs}`, pack: `seazn_stream_pack_${n}`, amountMinor: 600, currency: "gbp" },
  });
};

async function seedDivision(orgId: string, competitionId: string, o: { camera?: Policy | null; online?: boolean } = {}): Promise<{ id: string; name: string }> {
  const s = suffix();
  const name = `Open ${s}`;
  const [d] = await sql<{ id: string }[]>`
    insert into divisions (competition_id, name, slug, sport_key, variant_key, config, module_version, camera_policy)
    values (${competitionId}, ${name}, ${"oc-pay-" + s}, 'boardgame', 'classical',
            ${sql.json({ onlinePlay: o.online === false ? "off" : "lichess" } as never)}, '1.0.0', ${o.camera ?? null})
    returning id`;
  return { id: d!.id, name };
}

async function seedPackage(orgId: string, division: { id: string; name: string }, size: number): Promise<string> {
  const [p] = await sql<{ id: string }[]>`
    insert into division_online_packages (org_id, division_id, division_name, size)
    values (${orgId}, ${division.id}, ${division.name}, ${size}) returning id`;
  return p!.id;
}

/** This month's included credits left at exactly `n`: the real rollover grants the plan's month (through a warm-up debit on
 *  another package of the org, the writer that rolls), and that debit spends the rest. */
async function setIncluded(orgId: string, competitionId: string, plan: Plan, n: number): Promise<void> {
  const rate = RATE[plan];
  expect(rate, `premise: ${plan} includes at least ${n} credits a month`).toBeGreaterThanOrEqual(n);
  if (rate === n) {
    await grantMonthlyStreamCredits(orgId, rate, DB_NOW);
    return;
  }
  const warm = await seedDivision(orgId, competitionId);
  const warmPackage = await seedPackage(orgId, warm, 16);
  await inTx((tx) => debitForPackage(tx, { orgId, packageId: warmPackage, credits: rate - n, rate, size: 16 }));
}

/** An org on `plan` with its owner, one competition, one online chess division and its UNPAID package at `size`. Credits: when
 *  `monthly` is given, this month is rolled and `monthly` included credits are left; `pack` bought credits. With neither, the
 *  org has never touched the ledger. */
async function rig(o: { plan?: Plan; size?: OnlineSize; pack?: number; monthly?: number; camera?: Policy; online?: boolean } = {}): Promise<Rig> {
  const plan = o.plan ?? "pro";
  const s = suffix();
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, slug) values (${"OC Pay " + s}, ${"oc-pay-" + s}) returning id`;
  const orgId = org!.id;
  const [user] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, locale) values (${`owner-${s}@t.local`}, 'Owner', true, 'en') returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${user!.id}, 'owner')`;
  await setOrgPlan(orgId, plan);
  await invalidateOrgEntitlements(orgId);
  expect(await streamMonthlyRate(orgId), `premise: the org resolves to ${plan}'s catalogue rate`).toBe(RATE[plan]);
  const [c] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, camera_policy)
    values (${orgId}, ${"OC Cup " + s}, ${"oc-cup-" + s}, 'private', 'off') returning id`;
  const division = await seedDivision(orgId, c!.id, { camera: o.camera ?? null, online: o.online });
  const packageId = await seedPackage(orgId, division, o.size ?? 16);
  if (o.monthly !== undefined) await setIncluded(orgId, c!.id, plan, o.monthly);
  if ((o.pack ?? 0) > 0) await buy(orgId, o.pack!);
  const bd = await creditBreakdown(sql, orgId);
  expect({ monthly: bd.monthly, pack: bd.pack }, "premise: the org holds what the case says").toEqual({ monthly: o.monthly ?? 0, pack: o.pack ?? 0 });
  return {
    orgId,
    userId: user!.id,
    auth: { orgId, via: "session", userId: user!.id, role: "owner", keyId: null },
    competitionId: c!.id,
    divisionId: division.id,
    divisionName: division.name,
    packageId,
  };
}

/** The receipt's quote, as the browser reads it (the GET door's usecase). */
const quote = (r: Rig, size: OnlineSize, addCameras?: boolean): Promise<PackageQuote> => onlinePackageQuote(r.auth, r.divisionId, size, addCameras);

/** What the organiser does: open the receipt for `size`, confirm the total it shows. */
async function confirm(r: Rig, size: OnlineSize, o: { addCameras?: boolean; forfeited?: boolean; deps?: PayDeps } = {}): Promise<{ shown: PackageQuote; result: PayResult }> {
  const shown = await quote(r, size, o.addCameras);
  const input: PayInput = { size, expectedOwed: shown.owed, ...(o.addCameras ? { addCameras: true } : {}) };
  if (o.forfeited) input.expectedForfeited = shown.back?.forfeited ?? 0;
  return { shown, result: await payOnlinePackage(r.auth, r.divisionId, input, o.deps) };
}

async function refusal(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpError) return e;
    throw e;
  }
  throw new Error("expected a refusal, got an answer");
}

interface PackageState {
  size: number; cameras_paid: boolean | null; credits_paid: number; credits_refunded: number; credits_forfeited: number;
  paid_at: Date | null; paid_by: string | null; frozen_at: Date | null; refunded_at: Date | null;
}
async function packageRow(id: string): Promise<PackageState> {
  const [p] = await sql<PackageState[]>`
    select size, cameras_paid, credits_paid, credits_refunded, credits_forfeited, paid_at, paid_by, frozen_at, refunded_at
      from division_online_packages where id = ${id}`;
  expect(p, `premise: package ${id} exists`).toBeDefined();
  return p!;
}

type LedgerRow = { delta: number; reason: string; bucket: string };
/** The package's own ledger rows, as a sorted multiset (rows of one transaction share `created_at`, so no order is read). */
async function packageLedger(packageId: string): Promise<LedgerRow[]> {
  const rows = await sql<LedgerRow[]>`
    select delta, reason, bucket from org_stream_credits where online_package_id = ${packageId}`;
  return [...rows].sort((a, b) => `${a.reason}${a.bucket}${a.delta}`.localeCompare(`${b.reason}${b.bucket}${b.delta}`));
}
const orgLedgerCount = async (orgId: string): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from org_stream_credits where org_id = ${orgId}`)[0]!.n;
const consumed = (rows: LedgerRow[]): number => -rows.filter((x) => x.reason === "consume").reduce((s, x) => s + x.delta, 0);

/** Both invariants of §7.1, after a step: paid − refunded is the package's net ledger debit; and on a live paid row, the VALUE
 *  (paid − refunded − forfeited) is the table's price for its size and camera state. Answers how many it checked. */
async function expectBooks(packageId: string, label: string): Promise<number> {
  const p = await packageRow(packageId);
  const [l] = await sql<{ net: number }[]>`
    select coalesce(-sum(delta), 0)::int as net from org_stream_credits where online_package_id = ${packageId}`;
  expect(p.credits_paid - p.credits_refunded, `${label}: paid − refunded is the package's net ledger debit`).toBe(l!.net);
  if (p.paid_at === null || p.refunded_at !== null) return 1;
  expect(p.credits_paid - p.credits_refunded - p.credits_forfeited, `${label}: the value is price(${p.size}, cameras ${p.cameras_paid})`).toBe(price(p.size, p.cameras_paid));
  return 2;
}

/** Move every ledger row the org has so far back one UTC calendar month (the quote suite's helper, copied). */
async function backdateOrgLedger(orgId: string): Promise<void> {
  const thisKey = streamMonthlyGrantKey(orgId, THIS_PERIOD);
  const lastKey = streamMonthlyGrantKey(orgId, LAST_PERIOD);
  await sql`
    update org_stream_credits
       set created_at = (created_at at time zone 'UTC' - interval '1 month') at time zone 'UTC',
           idempotency_key = case when starts_with(idempotency_key, ${thisKey}::text)
                                  then ${lastKey}::text || substr(idempotency_key, ${thisKey.length + 1}::int)
                                  else idempotency_key end
     where org_id = ${orgId}`;
  const [left] = await sql<{ n: number }[]>`
    select count(*)::int as n from org_stream_credits
     where org_id = ${orgId} and to_char(created_at at time zone 'UTC', 'YYYY-MM') = ${THIS_PERIOD}`;
  expect(left!.n, "premise: nothing of the org's ledger is left in this month").toBe(0);
}

async function seedEntrants(r: Rig, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await sql`
      insert into entrants (division_id, org_id, kind, display_name, status)
      values (${r.divisionId}, ${r.orgId}, 'individual', ${"P " + suffix()}, 'confirmed')`;
  }
}

let stageSeq = 0;
async function seedStage(r: Rig, kind: string, config: unknown): Promise<string> {
  stageSeq += 1;
  const [s] = await sql<{ id: string }[]>`
    insert into stages (division_id, org_id, seq, kind, name, config)
    values (${r.divisionId}, ${r.orgId}, ${stageSeq}, ${kind}, ${`Stage ${stageSeq}`}, ${sql.json(config as never)}) returning id`;
  return s!.id;
}

/** Online play switched OFF and back ON through the REAL save door (`patchDivision`, Task 6): the off refunds the paid package in
 *  full in the save's privileged epilogue, and the on writes a fresh unpaid row at P14's default (the smallest size that holds
 *  the places held). What "pay after a refund" meets. The raw-seeded division is first given a curated clock and the catalogue's
 *  boardgame rows, so the save door can parse it (the online switch demands a curated clock). */
async function fullRefundAndReopen(r: Rig, size: OnlineSize): Promise<string> {
  const before = await packageRow(r.packageId);
  await seedBoardgameSport();
  const clock = { base: 600, increment: 5 };
  await sql`update divisions set config = ${sql.json({ variant: "classical", onlinePlay: "lichess", clock } as never)} where id = ${r.divisionId}`;
  await patchDivision(r.auth, r.divisionId, { config: { variant: "classical", onlinePlay: "off", clock } });
  const refunded = await packageRow(r.packageId);
  expect(refunded.refunded_at, "premise: switching off refunded the package").not.toBeNull();
  expect(refunded.credits_refunded + refunded.credits_forfeited, "premise: the refund returned what was paid").toBe(before.credits_paid);
  await patchDivision(r.auth, r.divisionId, { config: { variant: "classical", onlinePlay: "lichess", clock } });
  const [fresh] = await sql<{ id: string; size: number }[]>`
    select id, size from division_online_packages where division_id = ${r.divisionId} and refunded_at is null`;
  expect(fresh, "premise: switching on again wrote one unpaid row").toBeDefined();
  expect(fresh!.size, `premise: the default size is the case's ${size}`).toBe(size);
  return fresh!.id;
}

// ─── First payment ────────────────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("payOnlinePackage: the first payment", () => {
  it("first payment: debit equals the price, row paid, cameras_paid set, paid_by set — every size, without and with cameras", async () => {
    let checked = 0;
    for (const size of ONLINE_SIZES) {
      for (const cams of [false, true]) {
        const label = `${size}${cams ? " with cameras" : ""}`;
        const want = price(size, cams);
        const r = await rig({ size, pack: 40, monthly: 0, camera: cams ? "required" : "off" });
        const { shown, result } = await confirm(r, size);
        expect(shown.owed, `${label}: the receipt asks the table's price`).toBe(want);
        expect(result.applied, label).toBe(true);
        expect(await packageLedger(r.packageId), `${label}: one consume of the price, from the bought credits`).toEqual([
          { delta: -want, reason: "consume", bucket: "pack" },
        ]);
        const row = await packageRow(r.packageId);
        expect(row, label).toMatchObject({
          size, cameras_paid: cams, credits_paid: want, credits_refunded: 0, credits_forfeited: 0, paid_by: r.userId, frozen_at: null, refunded_at: null,
        });
        expect(row.paid_at, `${label}: paid_at set`).not.toBeNull();
        expect(result.package).toMatchObject({ size, camerasPaid: cams, creditsPaid: want, paidBy: r.userId });
        expect((await creditBreakdown(sql, r.orgId)).total, `${label}: the balance fell by the price`).toBe(40 - want);
        expect(await expectBooks(r.packageId, label)).toBe(2);
        checked += 1;
      }
    }
    expect(checked, "cells paid").toBe(10);
  });

  it("first-ever ledger write: the month is granted under the lock, then drawn", async () => {
    const r = await rig({ size: 16 });
    expect(await orgLedgerCount(r.orgId), "premise: the org has never touched the ledger").toBe(0);
    await confirm(r, 16);
    const rows = await sql<{ delta: number; reason: string; bucket: string; online_package_id: string | null; idempotency_key: string | null; balance_after: number }[]>`
      select delta, reason, bucket, online_package_id, idempotency_key, balance_after from org_stream_credits where org_id = ${r.orgId}`;
    const grant = rows.find((x) => x.reason === "grant");
    const consume = rows.find((x) => x.reason === "consume");
    expect(rows, "the month's grant and the package's consume, nothing else").toHaveLength(2);
    expect(grant).toMatchObject({ delta: RATE.pro, bucket: "monthly", online_package_id: null, idempotency_key: streamMonthlyGrantKey(r.orgId, THIS_PERIOD) });
    // balance_after is the running org total, row by row: the grant came first (0 → rate), the consume drew on it (rate → rate − 1).
    expect(grant!.balance_after, "the grant was written first").toBe(RATE.pro);
    expect(consume).toMatchObject({ delta: -1, bucket: "monthly", online_package_id: r.packageId, balance_after: RATE.pro - 1 });
  });

  it("402 ONLINE_CHESS_NO_CREDITS carries owed and balance; nothing written — not even the month's grant", async () => {
    // The smallest cell of the table the plan's month cannot cover on its own.
    const cell = ONLINE_SIZES.flatMap((s) => [[s, false], [s, true]] as const).find(([s, c]) => price(s, c) > RATE.pro);
    expect(cell, "premise: some size costs more than a month's included credits").toBeDefined();
    const [size, cams] = cell!;
    const r = await rig({ size, camera: cams ? "required" : "off" });
    const shown = await quote(r, size);
    expect(shown.owed).toBe(price(size, cams));
    const err = await refusal(payOnlinePackage(r.auth, r.divisionId, { size, expectedOwed: shown.owed }));
    expect(err.status).toBe(402);
    expect(err.code).toBe("ONLINE_CHESS_NO_CREDITS");
    expect(err.extra).toEqual({ owed: price(size, cams), balance: RATE.pro });
    expect(await orgLedgerCount(r.orgId), "no consume, and the month's grant rolled back with it").toBe(0);
    expect((await packageRow(r.packageId)).paid_at, "the row stays unpaid").toBeNull();
  });
});

// ─── Exactly once, and the quote that changed ─────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("payOnlinePackage: exactly once, by state, and the 409", () => {
  it("the same payment twice writes one debit; the second answers applied:false", async () => {
    const r = await rig({ size: 32, pack: 10, monthly: 0 });
    const first = await confirm(r, 32);
    expect(first.result.applied).toBe(true);
    // The second tab confirmed the SAME receipt (owed 2): the row is already at the target, so nothing is written — not a 409.
    const again = await payOnlinePackage(r.auth, r.divisionId, { size: 32, expectedOwed: first.shown.owed });
    expect(again.applied).toBe(false);
    expect(again.quote.owed, "the fresh quote owes nothing").toBe(0);
    expect(again.capacityLoweredTo).toBeNull();
    expect(await packageLedger(r.packageId), "one debit").toEqual([{ delta: -2, reason: "consume", bucket: "pack" }]);
    expect((await packageRow(r.packageId)).credits_paid).toBe(2);
    // A third press with the fresh figure is the same: nothing.
    expect((await payOnlinePackage(r.auth, r.divisionId, { size: 32, expectedOwed: 0 })).applied).toBe(false);
    expect(consumed(await packageLedger(r.packageId))).toBe(2);
    expect(await expectBooks(r.packageId, "after three presses")).toBe(2);
  });

  it("two tabs, 32 then 64: the second pays 2, and its stale expectedOwed 4 answers 409 with no row", async () => {
    const r = await rig({ size: 32, pack: 10, monthly: 0 });
    const tabA = await quote(r, 32);
    const tabB = await quote(r, 64);
    expect([tabA.owed, tabB.owed], "both receipts opened on the unpaid row").toEqual([2, 4]);
    await payOnlinePackage(r.auth, r.divisionId, { size: 32, expectedOwed: tabA.owed });
    const ledgerBefore = await orgLedgerCount(r.orgId);
    const err = await refusal(payOnlinePackage(r.auth, r.divisionId, { size: 64, expectedOwed: tabB.owed }));
    expect(err.status).toBe(409);
    expect(err.code).toBe("ONLINE_QUOTE_CHANGED");
    expect(err.message, "a changed total says so").toBe(TOTAL_CHANGED);
    const fresh = (err.extra as { quote: PackageQuote }).quote;
    expect(fresh, "the fresh quote: the difference from the state the first tab left").toMatchObject({ size: 64, owed: 4 - 2, refusal: null });
    expect(await orgLedgerCount(r.orgId), "no row").toBe(ledgerBefore);
    expect((await packageRow(r.packageId)).size).toBe(32);
    // Tab B redraws and confirms the new total.
    const paid = await payOnlinePackage(r.auth, r.divisionId, { size: 64, expectedOwed: fresh.owed });
    expect(paid.applied).toBe(true);
    expect(consumed(await packageLedger(r.packageId)), "2 + 2").toBe(4);
    expect(await packageRow(r.packageId)).toMatchObject({ size: 64, credits_paid: 4 });
    expect(await expectBooks(r.packageId, "after the second tab")).toBe(2);
  });

  it("409 ONLINE_QUOTE_CHANGED when the camera policy changed after the quote; ledger unchanged", async () => {
    const r = await rig({ size: 32, pack: 10, monthly: 0, camera: "off" });
    const shown = await quote(r, 32);
    expect(shown).toMatchObject({ owed: 2, cameras: false });
    await sql`update divisions set camera_policy = 'required' where id = ${r.divisionId}`;
    const before = await orgLedgerCount(r.orgId);
    const err = await refusal(payOnlinePackage(r.auth, r.divisionId, { size: 32, expectedOwed: shown.owed }));
    expect(err.code).toBe("ONLINE_QUOTE_CHANGED");
    expect(err.message).toBe(TOTAL_CHANGED);
    expect((err.extra as { quote: PackageQuote }).quote).toMatchObject({ owed: 4, cameras: true });
    expect(await orgLedgerCount(r.orgId)).toBe(before);
    expect((await packageRow(r.packageId)).paid_at).toBeNull();
    // Confirmed again at the camera price: paid, cameras paid.
    await payOnlinePackage(r.auth, r.divisionId, { size: 32, expectedOwed: 4 });
    expect(await packageRow(r.packageId)).toMatchObject({ cameras_paid: true, credits_paid: 4 });
  });

  it("409 when the rounds were raised after the quote: the size no longer includes them", async () => {
    const r = await rig({ size: 32, pack: 10, monthly: 0 });
    // Global Constraints: 16 includes 6 Swiss rounds, 32 includes 7.
    const stage = await seedStage(r, "swiss", { rounds: 6 });
    const shown = await quote(r, 16);
    expect(shown).toMatchObject({ owed: 1, refusal: null });
    await sql`update stages set config = ${sql.json({ rounds: 7 } as never)} where id = ${stage}`;
    const before = await orgLedgerCount(r.orgId);
    const err = await refusal(payOnlinePackage(r.auth, r.divisionId, { size: 16, expectedOwed: shown.owed }));
    expect(err.status).toBe(409);
    expect(err.code).toBe("ONLINE_QUOTE_CHANGED");
    expect((err.extra as { quote: PackageQuote }).quote, "same total, but the size is refused now").toMatchObject({ owed: 1, refusal: "rounds", rounds: 7 });
    expect(err.message, "the total did not change: the message names the refusal instead").toBe("Online Chess cannot be bought at size 16: rounds");
    expect(await orgLedgerCount(r.orgId)).toBe(before);
    expect((await packageRow(r.packageId)).paid_at).toBeNull();
    // The positive pair: 32 includes 7.
    expect((await confirm(r, 32)).result.applied).toBe(true);
  });

  it("the month turns between the receipt and the confirm: same owed, a different forfeit → 409 with the fresh split; then it applies", async () => {
    const r = await rig({ size: 64, monthly: 4 });
    await confirm(r, 64);
    expect(await packageLedger(r.packageId), "premise: paid from this month's included credits").toEqual([{ delta: -4, reason: "consume", bucket: "monthly" }]);
    const shown = await quote(r, 16);
    expect(shown, "the receipt: 3 included credits of this month come back").toMatchObject({ owed: -3, back: { pack: 0, monthly: 3, forfeited: 0 } });
    await backdateOrgLedger(r.orgId);
    const before = await orgLedgerCount(r.orgId);
    const err = await refusal(payOnlinePackage(r.auth, r.divisionId, { size: 16, expectedOwed: shown.owed, expectedForfeited: shown.back!.forfeited }));
    expect(err.status).toBe(409);
    expect(err.code).toBe("ONLINE_QUOTE_CHANGED");
    expect((err.extra as { quote: PackageQuote }).quote, "the owed figure did not move; the split did").toMatchObject({
      owed: -3, back: { pack: 0, monthly: 0, forfeited: 3 },
    });
    expect(err.message, "not refused: the confirmed figures moved").toBe(TOTAL_CHANGED);
    expect(await orgLedgerCount(r.orgId), "nothing written").toBe(before);
    expect(await packageRow(r.packageId)).toMatchObject({ size: 64, credits_forfeited: 0 });
    // Confirmed with the receipt that says 3 will not come back.
    const done = await payOnlinePackage(r.auth, r.divisionId, { size: 16, expectedOwed: -3, expectedForfeited: 3 });
    expect(done.applied).toBe(true);
    expect(await packageRow(r.packageId)).toMatchObject({ size: 16, credits_refunded: 0, credits_forfeited: 3 });
    expect(await orgLedgerCount(r.orgId), "a forfeit writes nothing").toBe(before);
    expect(await expectBooks(r.packageId, "after the forfeit")).toBe(2);
  });
});

// ─── What changed between the receipt and the confirm ────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("payOnlinePackage: the receipt went stale in the other direction", () => {
  it("the receipt was payable, then a staff revoke drained the balance: the confirm is 402 with the TRUE balance and writes nothing", async () => {
    const r = await rig({ size: 32, pack: 3, monthly: 0 });
    const shown = await quote(r, 32);
    expect(shown, "premise: payable from the bought credits").toMatchObject({ owed: 2, take: { monthly: 0, pack: 2 }, shortBy: null, balance: 3 });
    // The real staff writer, between the receipt and the confirm.
    await revokeCredits({ orgId: r.orgId, delta: 2, createdBy: r.userId, note: "online chess pay test", idempotencyKey: `idem-${suffix()}` });
    expect((await creditBreakdown(sql, r.orgId)).total, "premise: the revoke left 1").toBe(1);
    const before = await orgLedgerCount(r.orgId);
    // The confirmed total is still the server's (owed 2): no 409; the money is what is missing.
    const err = await refusal(payOnlinePackage(r.auth, r.divisionId, { size: 32, expectedOwed: shown.owed }));
    expect(err.status).toBe(402);
    expect(err.code).toBe("ONLINE_CHESS_NO_CREDITS");
    expect(err.extra, "the balance as it is now, not as the receipt showed it").toEqual({ owed: 2, balance: 1 });
    expect(await orgLedgerCount(r.orgId), "nothing written").toBe(before);
    expect((await packageRow(r.packageId)).paid_at).toBeNull();
    // The positive pair: one more bought credit and the same confirm pays.
    await buy(r.orgId, 1);
    expect((await payOnlinePackage(r.auth, r.divisionId, { size: 32, expectedOwed: shown.owed })).applied).toBe(true);
    expect(await packageRow(r.packageId)).toMatchObject({ size: 32, credits_paid: 2 });
  });

  it("a move down refused below the places held is allowed once an entrant withdraws", async () => {
    const r = await rig({ size: 32, pack: 10, monthly: 0 });
    await confirm(r, 32);
    await seedEntrants(r, 17);
    const refused = await quote(r, 16);
    expect(refused, "premise: 17 held do not fit in 16").toMatchObject({ held: 17, refusal: "below_held" });
    const err = await refusal(payOnlinePackage(r.auth, r.divisionId, { size: 16, expectedOwed: refused.owed }));
    expect(err.code).toBe("ONLINE_QUOTE_CHANGED");
    expect(err.message).toBe("Online Chess cannot be bought at size 16: below_held");
    expect(await packageRow(r.packageId)).toMatchObject({ size: 32, credits_refunded: 0 });
    // One entrant withdraws (a departed status leaves the held count): 16 places hold the 16 left.
    await sql`
      update entrants set status = 'withdrawn'
       where id = (select id from entrants where division_id = ${r.divisionId} order by id limit 1)`;
    const allowed = await quote(r, 16);
    expect(allowed).toMatchObject({ held: 16, refusal: null, owed: 1 - 2, back: { pack: 1, monthly: 0, forfeited: 0 } });
    const down = await payOnlinePackage(r.auth, r.divisionId, { size: 16, expectedOwed: allowed.owed });
    expect(down.applied).toBe(true);
    expect(await packageRow(r.packageId)).toMatchObject({ size: 16, credits_paid: 2, credits_refunded: 1 });
    expect(await expectBooks(r.packageId, "after the move down")).toBe(2);
  });
});

// ─── Upgrade, cameras, move down ──────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("payOnlinePackage: upgrade, add cameras, move down", () => {
  it("upgrade charges the difference; addCameras charges the camera difference; a second addCameras owes nothing", async () => {
    const r = await rig({ size: 16, pack: 20, monthly: 0 });
    await confirm(r, 16);
    const first = await packageRow(r.packageId);
    // The upgrade is confirmed by ANOTHER organiser of the org: paid_at and paid_by keep the first payment (V560 sets them together).
    const admin: Rig = { ...r, auth: { ...r.auth, userId: randomUUID(), role: "admin" } };
    const up = await confirm(admin, 64);
    expect(up.shown.owed, "64 − 16 without cameras").toBe(4 - 1);
    expect(consumed(await packageLedger(r.packageId))).toBe(4);
    expect(await packageRow(r.packageId), "the first payer and the first payment's time stay").toMatchObject({ paid_by: r.userId, paid_at: first.paid_at });
    expect(await expectBooks(r.packageId, "after the upgrade")).toBe(2);
    const cams = await confirm(r, 64, { addCameras: true });
    expect(cams.shown).toMatchObject({ owed: 8 - 4, cameras: true });
    expect(await packageRow(r.packageId)).toMatchObject({ size: 64, cameras_paid: true, credits_paid: 8 });
    expect(await expectBooks(r.packageId, "after the cameras")).toBe(2);
    // P19: paid cameras stay paid. Asked again, or asked without the intent while the policy is still off: nothing owed, nothing written.
    for (const addCameras of [true, false]) {
      const again = await confirm(r, 64, { addCameras });
      expect(again.result.applied, `addCameras ${addCameras}`).toBe(false);
      expect(again.shown.owed, `addCameras ${addCameras}`).toBe(0);
    }
    expect(consumed(await packageLedger(r.packageId))).toBe(8);
  });

  it("move down: all bought → all return; this month's included → return; mixed → bought first; earlier month → forfeited, counted, no row", async () => {
    let checked = 0;
    // (a) Paid from bought credits only: 64 → 32 returns 2 bought credits.
    {
      const r = await rig({ size: 64, pack: 10, monthly: 0 });
      await confirm(r, 64);
      const down = await confirm(r, 32);
      expect(down.shown).toMatchObject({ owed: -2, back: { pack: 2, monthly: 0, forfeited: 0 } });
      expect(await packageLedger(r.packageId)).toEqual([
        { delta: -4, reason: "consume", bucket: "pack" },
        { delta: 2, reason: "refund", bucket: "pack" },
      ]);
      expect(await packageRow(r.packageId)).toMatchObject({ size: 32, cameras_paid: false, credits_paid: 4, credits_refunded: 2, credits_forfeited: 0, refunded_at: null });
      expect((await creditBreakdown(sql, r.orgId)).pack, "10 − 4 + 2").toBe(8);
      expect(await expectBooks(r.packageId, "(a)")).toBe(2);
      checked += 1;
    }
    // (b) Paid from this month's included credits only: 64 → 16 returns 3 to the included bucket.
    {
      const r = await rig({ size: 64, monthly: 4 });
      await confirm(r, 64);
      await confirm(r, 16);
      expect(await packageLedger(r.packageId)).toEqual([
        { delta: -4, reason: "consume", bucket: "monthly" },
        { delta: 3, reason: "refund", bucket: "monthly" },
      ]);
      expect(await packageRow(r.packageId)).toMatchObject({ size: 16, credits_refunded: 3, credits_forfeited: 0 });
      expect((await creditBreakdown(sql, r.orgId)).monthly).toBe(3);
      expect(await expectBooks(r.packageId, "(b)")).toBe(2);
      checked += 1;
    }
    // (c) Mixed: 128 (8) paid with 4 included + 4 bought; 128 → 32 returns 6: the 4 bought FIRST, then 2 included (P21).
    //     The other order would give back 4 included and 2 bought.
    {
      const r = await rig({ size: 128, pack: 10, monthly: 4 });
      await confirm(r, 128);
      expect(await packageLedger(r.packageId), "premise: P4's split").toEqual([
        { delta: -4, reason: "consume", bucket: "monthly" },
        { delta: -4, reason: "consume", bucket: "pack" },
      ]);
      const down = await confirm(r, 32);
      expect(down.shown.back).toEqual({ pack: 4, monthly: 2, forfeited: 0 });
      expect((await packageLedger(r.packageId)).filter((x) => x.reason === "refund")).toEqual([
        { delta: 2, reason: "refund", bucket: "monthly" },
        { delta: 4, reason: "refund", bucket: "pack" },
      ]);
      expect(await packageRow(r.packageId)).toMatchObject({ size: 32, credits_refunded: 6, credits_forfeited: 0 });
      expect(await expectBooks(r.packageId, "(c)")).toBe(2);
      checked += 1;
    }
    // (d) Paid from included credits in a month that has ended: 64 → 16 forfeits 3, counted on the row, and writes no row.
    //     No expectedForfeited is sent: it is optional.
    {
      const r = await rig({ size: 64, monthly: 4 });
      await confirm(r, 64);
      await backdateOrgLedger(r.orgId);
      const before = await orgLedgerCount(r.orgId);
      const down = await confirm(r, 16);
      expect(down.shown.back).toEqual({ pack: 0, monthly: 0, forfeited: 3 });
      expect(down.result.applied).toBe(true);
      expect(await orgLedgerCount(r.orgId), "a forfeit writes nothing").toBe(before);
      expect(await packageRow(r.packageId)).toMatchObject({ size: 16, credits_paid: 4, credits_refunded: 0, credits_forfeited: 3 });
      expect(await expectBooks(r.packageId, "(d)")).toBe(2);
      checked += 1;
    }
    expect(checked, "move-down cases").toBe(4);
  });

  it("move down then up: the forfeited credit is not credited back", async () => {
    const r = await rig({ size: 64, monthly: 4 });
    await confirm(r, 64);
    await backdateOrgLedger(r.orgId);
    await confirm(r, 16);
    expect(await packageRow(r.packageId), "premise: 3 forfeited, the value is 16's price").toMatchObject({ credits_forfeited: 3 });
    const up = await confirm(r, 64);
    expect(up.shown.owed, "64 − 16 = 3: the 3 forfeited credits buy nothing back").toBe(4 - 1);
    expect(up.result.applied).toBe(true);
    const ledger = await packageLedger(r.packageId);
    expect(consumed(ledger), "4 then 3").toBe(7);
    expect(await packageRow(r.packageId)).toMatchObject({ size: 64, credits_paid: 7, credits_refunded: 0, credits_forfeited: 3 });
    expect(await expectBooks(r.packageId, "after the move up")).toBe(2);
  });

  it("an owed-0 change: 32 without cameras → 16 with cameras moves the row and writes no ledger row", async () => {
    const r = await rig({ size: 32, pack: 10, monthly: 0, camera: "off" });
    await confirm(r, 32);
    await sql`update divisions set camera_policy = 'required' where id = ${r.divisionId}`;
    const before = await orgLedgerCount(r.orgId);
    const { shown, result } = await confirm(r, 16);
    expect(shown, "16 with cameras costs what 32 without did").toMatchObject({ owed: 0, cameras: true });
    expect(result.applied, "not at the target: the size and the camera state change").toBe(true);
    expect(await orgLedgerCount(r.orgId)).toBe(before);
    expect(await packageRow(r.packageId)).toMatchObject({ size: 16, cameras_paid: true, credits_paid: 2, credits_refunded: 0 });
    expect(await expectBooks(r.packageId, "after the owed-0 change")).toBe(2);
  });

  it("move down refused below held, below the rounds' size, and when frozen — nothing written, the fresh quote says why", async () => {
    let checked = 0;
    const refusedDown = async (r: Rig, size: OnlineSize, why: PackageQuote["refusal"], label: string) => {
      const shown = await quote(r, size);
      const before = { ledger: await orgLedgerCount(r.orgId), row: await packageRow(r.packageId) };
      const err = await refusal(payOnlinePackage(r.auth, r.divisionId, { size, expectedOwed: shown.owed }));
      expect(err.code, label).toBe("ONLINE_QUOTE_CHANGED");
      expect(err.message, label).toBe(`Online Chess cannot be bought at size ${size}: ${why}`);
      expect((err.extra as { quote: PackageQuote }).quote.refusal, label).toBe(why);
      expect(await orgLedgerCount(r.orgId), label).toBe(before.ledger);
      expect(await packageRow(r.packageId), label).toEqual(before.row);
      checked += 1;
    };
    {
      const r = await rig({ size: 32, pack: 10, monthly: 0 });
      await confirm(r, 32);
      await seedEntrants(r, 17);
      await refusedDown(r, 16, "below_held", "17 held, down to 16");
    }
    {
      const r = await rig({ size: 64, pack: 10, monthly: 0 });
      const stage = await seedStage(r, "swiss", { rounds: 8 });
      await confirm(r, 64);
      await refusedDown(r, 32, "rounds", "8 rounds, down to 32 (includes 7)");
      // The positive pair: 7 rounds fit 32.
      await sql`update stages set config = ${sql.json({ rounds: 7 } as never)} where id = ${stage}`;
      expect((await confirm(r, 32)).result.applied).toBe(true);
    }
    {
      const r = await rig({ size: 32, pack: 10, monthly: 0 });
      await confirm(r, 32);
      await sql`update division_online_packages set frozen_at = now() where id = ${r.packageId}`;
      await refusedDown(r, 16, "frozen", "frozen, down to 16");
      await refusedDown(r, 64, "frozen", "frozen, up to 64");
    }
    expect(checked, "refusals").toBe(4);
  });

  it("both invariants of §7.1 hold after every step of pay → up → down → up", async () => {
    const r = await rig({ size: 16, pack: 20, monthly: 1 });
    let checks = 0;
    const steps: [OnlineSize, number][] = [[16, 1], [64, 3], [32, -2], [128, 6]];
    for (const [size, owed] of steps) {
      const { shown, result } = await confirm(r, size);
      expect(shown.owed, `to ${size}: the table's difference`).toBe(owed);
      expect(result.applied).toBe(true);
      checks += await expectBooks(r.packageId, `after ${size}`);
    }
    expect(checks, "two invariants after each of four steps").toBe(8);
    expect(await packageRow(r.packageId)).toMatchObject({ size: 128, credits_paid: 1 + 3 + 6, credits_refunded: 2, credits_forfeited: 0 });
  });

  it("a size change lowers a stored registration capacity above it and reports it; one at or below it, or none, is left", async () => {
    const r = await rig({ size: 64, pack: 20, monthly: 0 });
    await sql`insert into registration_settings (division_id, org_id, enabled, capacity) values (${r.divisionId}, ${r.orgId}, true, 50)`;
    const capacity = async () => (await sql<{ c: number | null }[]>`select capacity as c from registration_settings where division_id = ${r.divisionId}`)[0]!.c;
    expect((await confirm(r, 64)).result.capacityLoweredTo, "50 fits in 64").toBeNull();
    expect(await capacity()).toBe(50);
    expect((await confirm(r, 32)).result.capacityLoweredTo, "50 > 32").toBe(32);
    expect(await capacity()).toBe(32);
    expect((await confirm(r, 16)).result.capacityLoweredTo, "32 > 16").toBe(16);
    expect(await capacity()).toBe(16);
    // The first payment changes the size too.
    const first = await rig({ size: 32, pack: 10, monthly: 0 });
    await sql`insert into registration_settings (division_id, org_id, enabled, capacity) values (${first.divisionId}, ${first.orgId}, true, 20)`;
    expect((await confirm(first, 16)).result.capacityLoweredTo, "a first payment at 16 lowers 20").toBe(16);
    // A capacity exactly at the size is not above it: nothing lowered, nothing reported.
    const equal = await rig({ size: 32, pack: 10, monthly: 0 });
    await sql`insert into registration_settings (division_id, org_id, enabled, capacity) values (${equal.divisionId}, ${equal.orgId}, true, 32)`;
    expect((await confirm(equal, 32)).result.capacityLoweredTo, "32 at 32").toBeNull();
    // No capacity stored: nothing to lower, and none is written.
    const none = await rig({ size: 64, pack: 10, monthly: 0 });
    await sql`insert into registration_settings (division_id, org_id, enabled, capacity) values (${none.divisionId}, ${none.orgId}, true, null)`;
    await confirm(none, 64);
    expect((await confirm(none, 16)).result.capacityLoweredTo).toBeNull();
    expect((await sql<{ c: number | null }[]>`select capacity as c from registration_settings where division_id = ${none.divisionId}`)[0]!.c).toBeNull();
  });

  it("SEQUENCE: pay → pay again → upgrade → add cameras → move down → move down below held (refused) → pay after a refund", async () => {
    const r = await rig({ size: 16, pack: 40, monthly: 0 });
    let steps = 0;
    const step = async (label: string, size: OnlineSize, want: { owed: number; applied: boolean }, addCameras?: boolean) => {
      const { shown, result } = await confirm(r, size, { addCameras });
      expect(shown.owed, `${label}: owed`).toBe(want.owed);
      expect(result.applied, `${label}: applied`).toBe(want.applied);
      expect(await expectBooks(r.packageId, label)).toBe(2);
      steps += 1;
    };
    await step("pay 16", 16, { owed: 1, applied: true });
    await step("pay 16 again", 16, { owed: 0, applied: false });
    await step("upgrade to 64", 64, { owed: 3, applied: true });
    await step("add cameras at 64", 64, { owed: 4, applied: true }, true);
    await step("move down to 32 (cameras stay paid, P19)", 32, { owed: 4 - 8, applied: true });
    expect(await packageRow(r.packageId)).toMatchObject({ size: 32, cameras_paid: true, credits_paid: 8, credits_refunded: 4 });
    await seedEntrants(r, 20);
    const shown = await quote(r, 16);
    const err = await refusal(payOnlinePackage(r.auth, r.divisionId, { size: 16, expectedOwed: shown.owed }));
    expect((err.extra as { quote: PackageQuote }).quote.refusal, "20 held, down to 16").toBe("below_held");
    expect(await packageRow(r.packageId)).toMatchObject({ size: 32, credits_refunded: 4 });
    steps += 1;
    // Online play off (Task 6's full refund, through the real save door), then on again: a new unpaid row at the default for
    // the 20 places held (32), paid at the full price; the refunded row is history.
    const old = r.packageId;
    const fresh = await fullRefundAndReopen(r, 32);
    const again = await payOnlinePackage(r.auth, r.divisionId, { size: 32, expectedOwed: (await quote(r, 32)).owed });
    expect(again.applied).toBe(true);
    // The policy is off and the new row has paid no cameras: nothing carries over from a refunded package (P19 is per package).
    expect(again.quote.owed, "the full price of 32 without cameras").toBe(2);
    expect(again.package.id).toBe(fresh);
    expect(await packageRow(fresh)).toMatchObject({ size: 32, cameras_paid: false, credits_paid: 2, credits_refunded: 0 });
    expect(await expectBooks(fresh, "the new package")).toBe(2);
    expect(await expectBooks(old, "the refunded package")).toBe(1);
    expect((await packageRow(old)).refunded_at).not.toBeNull();
    steps += 1;
    expect(steps, "steps").toBe(7);
  });
});

// ─── The doors around the money ───────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("payOnlinePackage: who may pay, where, and when", () => {
  it("who may pay: a viewer, a device link, a Match Day code and an API key are 403 and write nothing; an admin pays", async () => {
    const r = await rig({ size: 32, pack: 10, monthly: 0 });
    const shown = await quote(r, 32);
    const input = { size: 32 as const, expectedOwed: shown.owed };
    // Each gate is witnessed ALONE: the hostile contexts below keep the owner's role, so only the door kind (or the missing
    // user) refuses them, and the role cases keep a signed-in session, so only the role refuses them.
    const refused: [string, AuthCtx][] = [
      ["viewer", { ...r.auth, role: "viewer" }],
      ["no role", { ...r.auth, role: null }],
      ["device link", { ...r.auth, via: "device_link", deviceLinkId: randomUUID() }],
      ["match day code", { ...r.auth, via: "match_day_code" }],
      ["api key", { ...r.auth, via: "api_key", userId: null, keyId: randomUUID() }],
      ["a session with no user", { ...r.auth, userId: null }],
    ];
    for (const [label, auth] of refused) {
      const err = await refusal(payOnlinePackage(auth, r.divisionId, input));
      expect(err.status, label).toBe(403);
    }
    expect(await packageLedger(r.packageId), "nothing written").toEqual([]);
    expect(refused.length, "callers refused").toBe(6);
    const admin = await payOnlinePackage({ ...r.auth, role: "admin" }, r.divisionId, input);
    expect(admin.applied, "the positive pair: an admin is an organiser").toBe(true);
  });

  it("a division of another organisation is 404, and nothing is written", async () => {
    const r = await rig({ size: 32, pack: 10, monthly: 0 });
    const other = await rig({ size: 32, pack: 10, monthly: 0 });
    const err = await refusal(payOnlinePackage(other.auth, r.divisionId, { size: 32, expectedOwed: 2 }));
    expect(err.status).toBe(404);
    expect(await packageLedger(r.packageId)).toEqual([]);
  });

  it("a division that does not play online is 422 ONLINE_FORMAT_NOT_SUPPORTED; an online one holding a refused stage kind is too, naming it", async () => {
    const off = await rig({ size: 32, pack: 10, monthly: 0, online: false });
    const err = await refusal(payOnlinePackage(off.auth, off.divisionId, { size: 32, expectedOwed: 2 }));
    expect(err.status).toBe(422);
    expect(err.code).toBe("ONLINE_FORMAT_NOT_SUPPORTED");
    expect(err.extra).toEqual({ kind: null });
    expect(await packageLedger(off.packageId)).toEqual([]);
    const league = await rig({ size: 32, pack: 10, monthly: 0 });
    await seedStage(league, "league", {});
    const err2 = await refusal(payOnlinePackage(league.auth, league.divisionId, { size: 32, expectedOwed: (await quote(league, 32)).owed }));
    expect(err2.status).toBe(422);
    expect(err2.code).toBe("ONLINE_FORMAT_NOT_SUPPORTED");
    expect(err2.extra).toEqual({ kind: "league" });
    expect(await packageLedger(league.packageId)).toEqual([]);
    // The positive pair: a Swiss into a knockout is a format online play allows.
    const ok = await rig({ size: 32, pack: 10, monthly: 0 });
    await seedStage(ok, "swiss", { rounds: 5 });
    await seedStage(ok, "knockout", {});
    expect((await confirm(ok, 32)).result.applied).toBe(true);
  });

  it("pay is refused on a billing-frozen competition; move down still works", async () => {
    const r = await rig({ plan: "community", size: 32, pack: 10, monthly: 0 });
    await confirm(r, 32);
    const limit = await getLimit(r.orgId, "competitions.max_active");
    expect(limit, "premise: community has an active-competition limit").not.toBeNull();
    for (let i = 0; i < (limit as number); i += 1) {
      const s = suffix();
      await sql`insert into competitions (org_id, name, slug, status) values (${r.orgId}, ${"Filler " + s}, ${"filler-" + s}, 'draft')`;
    }
    expect([...(await frozenCompetitionIds(r.orgId))], "premise: exactly the package's competition is frozen").toEqual([r.competitionId]);
    const before = await orgLedgerCount(r.orgId);
    const up = await quote(r, 64);
    const err = await refusal(payOnlinePackage(r.auth, r.divisionId, { size: 64, expectedOwed: up.owed }));
    expect(err).toBeInstanceOf(PaymentRequiredError);
    expect(err.status).toBe(402);
    expect((err as PaymentRequiredError).featureKey).toBe("competitions.max_active");
    expect(await orgLedgerCount(r.orgId), "nothing charged").toBe(before);
    // A move down returns credits: never refused by the freeze.
    const down = await confirm(r, 16);
    expect(down.result.applied).toBe(true);
    expect(await packageRow(r.packageId)).toMatchObject({ size: 16, credits_refunded: 1 });
  });

  it("with the flag off: paying is 403 ONLINE_CHESS_DISABLED and writes nothing; a move down still returns credits", async () => {
    const r = await rig({ size: 32, pack: 10, monthly: 0 });
    await confirm(r, 32);
    delete process.env.ONLINE_CHESS_ALWAYS;
    forgetOnlineChessFlagCache();
    try {
      const before = await orgLedgerCount(r.orgId);
      const err = await refusal(payOnlinePackage(r.auth, r.divisionId, { size: 64, expectedOwed: 2 }));
      expect(err.status).toBe(403);
      expect(err.code).toBe("ONLINE_CHESS_DISABLED");
      expect(await orgLedgerCount(r.orgId)).toBe(before);
      const down = await payOnlinePackage(r.auth, r.divisionId, { size: 16, expectedOwed: -1 });
      expect(down.applied, "refunds are never flag-gated").toBe(true);
    } finally {
      process.env.ONLINE_CHESS_ALWAYS = "1";
      forgetOnlineChessFlagCache();
    }
  });

  it("a move down runs the settle step inside its transaction; a payment does not run it; a failing settle rolls the move down back", async () => {
    const r = await rig({ size: 64, pack: 10, monthly: 0 });
    const calls: { orgId: string; wrote: boolean }[] = [];
    const deps: PayDeps = {
      settle: async (tx, orgId) => {
        // The move down's refund row is already written on THIS transaction: settle runs after it, inside it.
        const [w] = await tx<{ n: number }[]>`select count(*)::int as n from org_stream_credits where online_package_id = ${r.packageId} and reason = 'refund'`;
        calls.push({ orgId, wrote: w!.n > 0 });
        return 0;
      },
    };
    await confirm(r, 64, { deps });
    expect(calls, "a payment settles nothing").toEqual([]);
    await confirm(r, 32, { deps });
    expect(calls).toEqual([{ orgId: r.orgId, wrote: true }]);
    const failing: PayDeps = { settle: async () => { throw new Error("settle failed"); } };
    const before = { ledger: await packageLedger(r.packageId), row: await packageRow(r.packageId) };
    await expect(confirm(r, 16, { deps: failing })).rejects.toThrow("settle failed");
    expect(await packageLedger(r.packageId), "the refund rolled back with the settle").toEqual(before.ledger);
    expect(await packageRow(r.packageId)).toEqual(before.row);
  });
});

// ─── Guards: "cannot happen", named ───────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("payOnlinePackage: the books guards", () => {
  it("an online division with no live package is a named 500, and nothing is written", async () => {
    const r = await rig({ size: 32, pack: 10, monthly: 0 });
    await sql`delete from division_online_packages where id = ${r.packageId}`;
    const before = await orgLedgerCount(r.orgId);
    const err = await refusal(payOnlinePackage(r.auth, r.divisionId, { size: 32, expectedOwed: 2 }));
    expect(err.status).toBe(500);
    expect(err.code).toBe("online_package_missing");
    expect(await orgLedgerCount(r.orgId)).toBe(before);
  });

  it("a package whose counters disagree with its price is refused by name after the write, which rolls back", async () => {
    const r = await rig({ size: 32, pack: 10, monthly: 0 });
    // A real debit of 3 for a row that says 32 without cameras (price 2): the ledger agrees with the counters, the price does not.
    await inTx((tx) => debitForPackage(tx, { orgId: r.orgId, packageId: r.packageId, credits: 3, rate: RATE.pro, size: 16 }));
    await sql`update division_online_packages set cameras_paid = false, credits_paid = 3, paid_at = now(), paid_by = ${r.userId} where id = ${r.packageId}`;
    const before = { ledger: await orgLedgerCount(r.orgId), row: await packageRow(r.packageId) };
    const err = await refusal(payOnlinePackage(r.auth, r.divisionId, { size: 64, expectedOwed: (await quote(r, 64)).owed }));
    expect(err.status).toBe(500);
    expect(err.code).toBe("online_package_value_mismatch");
    expect(await orgLedgerCount(r.orgId)).toBe(before.ledger);
    expect(await packageRow(r.packageId)).toEqual(before.row);
  });

  it("a package whose counters disagree with its ledger is refused by name after the write, which rolls back", async () => {
    const r = await rig({ size: 32, pack: 10, monthly: 0 });
    // Marked paid at 32 (2) with no debit behind it.
    await sql`update division_online_packages set cameras_paid = false, credits_paid = 2, paid_at = now(), paid_by = ${r.userId} where id = ${r.packageId}`;
    const before = { ledger: await orgLedgerCount(r.orgId), row: await packageRow(r.packageId) };
    const err = await refusal(payOnlinePackage(r.auth, r.divisionId, { size: 64, expectedOwed: (await quote(r, 64)).owed }));
    expect(err.status).toBe(500);
    expect(err.code).toBe("online_package_ledger_mismatch");
    expect(await orgLedgerCount(r.orgId)).toBe(before.ledger);
    expect(await packageRow(r.packageId)).toEqual(before.row);
  });

  it("a row frozen or refunded under the payment, on its own transaction, is a named 500: the write lands only on a writable row", async () => {
    // The row is locked and the quote refuses a frozen one, so the only way it stops being writable is a writer on THIS
    // transaction between the money and the row's write. The seam: the transaction handed to the door runs that writer just
    // before the door's own UPDATE of the package (a Proxy over the real tx; every other statement passes through).
    const changes: Record<string, (tx: Tx, id: string) => Promise<unknown>> = {
      frozen: (tx, id) => tx`update division_online_packages set frozen_at = now() where id = ${id}`,
      refunded: (tx, id) => tx`
        update division_online_packages set refunded_at = now(), credits_refunded = credits_paid - credits_forfeited where id = ${id}`,
    };
    let checked = 0;
    for (const [label, change] of Object.entries(changes)) {
      const r = await rig({ size: 32, pack: 10, monthly: 0 });
      await confirm(r, 32);
      const before = { ledger: await orgLedgerCount(r.orgId), row: await packageRow(r.packageId) };
      let injected = 0;
      const err = await refusal(inTx(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${"division:" + r.divisionId}))`;
        const facts = await readPackageFacts(tx, r.divisionId, null);
        const seam = new Proxy(tx, {
          apply(target, self, args) {
            const strings = args[0] as unknown;
            if (Array.isArray(strings) && strings.join("?").includes("update division_online_packages")) {
              injected += 1;
              return change(target, r.packageId).then(() => Reflect.apply(target, self, args));
            }
            return Reflect.apply(target, self, args);
          },
        });
        return payOnlinePackageInTx(seam, { orgId: r.orgId, divisionId: r.divisionId, userId: r.userId, size: 64, expectedOwed: 2 }, facts, { rate: RATE.pro });
      }));
      expect(injected, `${label}: the writer ran once, before the door's own write`).toBe(1);
      expect(err.status, label).toBe(500);
      expect(err.code, label).toBe("online_package_not_writable");
      expect(await orgLedgerCount(r.orgId), `${label}: the debit rolled back`).toBe(before.ledger);
      expect(await packageRow(r.packageId), label).toEqual(before.row);
      checked += 1;
    }
    expect(checked, "states").toBe(2);
  });

  it("payOnlinePackageInTx: a first payment with no payer is a named 500 before anything is written", async () => {
    const r = await rig({ size: 32, pack: 10, monthly: 0 });
    const before = await orgLedgerCount(r.orgId);
    const err = await refusal(inTx(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${"division:" + r.divisionId}))`;
      const facts = await readPackageFacts(tx, r.divisionId, null);
      return payOnlinePackageInTx(tx, { orgId: r.orgId, divisionId: r.divisionId, userId: null, size: 32, expectedOwed: 2 }, facts, { rate: RATE.pro });
    }));
    expect(err.status).toBe(500);
    expect(err.code).toBe("online_package_payer_missing");
    expect(await orgLedgerCount(r.orgId)).toBe(before);
    expect((await packageRow(r.packageId)).paid_at).toBeNull();
  });
});
