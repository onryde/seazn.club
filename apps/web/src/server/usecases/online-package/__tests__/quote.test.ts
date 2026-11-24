// The Online Chess quote (spec 2026-11-23-online-chess-credits-design.md §7.4 item 1, P9, P10, P13, P15, P17, P19, P21; plan
// Task 4). One answer for the select's price line, the amber line and the receipt. The database halves run against a REAL
// migrated database and are skipped without DATABASE_URL (the pure halves always run).
//
// Where the expected numbers come from — never from quote.ts:
//   * every price is the leaf's declared table (`packagePrice`) plus the Global Constraints' literals pinned beside it
//     (32 → 2/4, 64 → 4/8): the sweeps take the leaf as the oracle, the pins catch the leaf and the sweep drifting together;
//   * included rounds are the Global Constraints' own table typed here (16→6 … 256→10, `INCLUDED`), checked against the leaf
//     by a premise, so the rounds oracle is not the code that reads the leaf;
//   * the plan-cap rule is P17's sentence ("the smallest ladder size at or above a cap that is not a ladder value");
//   * the camera policy is P9's nearest-level-wins, written out in `oracleCameras` from the three columns, never by calling
//     `effectivePolicy`;
//   * the split a debit takes and a return gives back are P4 and P21; a quote's `take` is also compared with what the REAL
//     `debitForPackage` takes in a transaction that is rolled back, and a quote's `back` with what the REAL
//     `refundForPackage` accepts, so the quote and the writers cannot drift apart;
//   * the last day of the month is the calendar's.
//
// ONE clock, the database's: the month is the database's `now()`. "Last month" is the real ledger written now and moved back one
// UTC calendar month (`backdateOrgLedger`, the ledger suite's helper, copied: a test file imports no other).
//
// single-sport: the quote is sport-agnostic money over a package row; online play is boardgame only (online-play.ts).
//
// Mutant table (each run once by hand; every one killed — results in the commit message):
//   Q1   derivedCameras reads the division level only            -> "derivedCameras is nearest-level-wins per stage", the sweep
//   Q2   the frozen refusal removed                              -> "refusals: a frozen row", the precedence cases
//   Q3   below_held uses <= (a full division is refused)         -> "below_held sweep" (held = size), "held = size exactly"
//   Q4   below_held removed                                      -> "below_held sweep", the 257 case
//   Q5   the plan refusal removed                                -> "plan sweep"
//   Q6   rounds_above_max removed                                -> "rounds sweep"
//   Q7   the rounds refusal removed                              -> "rounds sweep"
//   Q8   precedence: plan before below_held                      -> "refusal precedence"
//   Q8b  precedence: below_held before frozen                    -> "refusal precedence"
//   Q8c  precedence: rounds before rounds_above_max              -> "refusal precedence", "rounds sweep"
//   Q8d  precedence: plan after the rounds refusals              -> "refusal precedence"
//   Q9   cameras drop `row.camerasPaid` (a paid camera lowered)  -> "paid sweep", "addCameras"
//   Q10  cameras drop `addCameras`                               -> "unpaid sweep", "addCameras"
//   Q11  owed ignores the price already paid                     -> "paid sweep", "sequence"
//   Q12  take/back not nulled on a refusal                       -> "a refusal carries no split"
//   Q13  the forfeits already on the row are not netted          -> "forfeits already recorded"
//   Q14  the forfeited-exceeds-expired guard removed             -> "forfeits already recorded"
//   Q15  the monthly rollover is not projected                   -> "an unrolled month"
//   Q16  the balance check removed (a short balance still takes) -> "a short balance", "shortBy sweep"
//   Q17  the non-ladder size guard removed                       -> "a size off the ladder"
//   Q18  the division-of-this-org guard removed                  -> "a division of another org"
//   Q19  the package-of-this-org guard removed                   -> "a division of another org"
//   Q20  countedRounds counts every stage kind                   -> "countedRounds counts a Swiss and nothing else"
//   Q21  countedRounds counts an absent round count as 1         -> "countedRounds: a Swiss stage with an ABSENT ..."
//   Q22  monthlyExpiresOn from the JS clock                      -> "monthlyExpiresOn is the DATABASE's month"
//   Q23  the quote takes an advisory lock                        -> "a quote writes and locks nothing"
//   Q24  onlinePackageQuote accepts a device link                -> "who may ask"
//   Q25  lastDayOfUtcMonth in the local zone                     -> "lastDayOfUtcMonth" (the suite runs in Europe/London)
//   Q26  the quote's transaction is not read-only                -> "a quote writes and locks nothing"
//   Q27  the facts-are-counts guard removed                      -> "a size off the ladder, and facts that are not counts"
//   Q28  `back` not read from the package's ledger rows          -> "a quote across the month boundary", "forfeits ..."
//   Q29  derivedCameras answers `false` for no division          -> "derivedCameras refuses a division that does not exist"
//   Q30  onlinePackageQuote's org check removed                  -> "who may ask"
//   Q31..Q34 readPackageFacts hard-codes held / rounds / cameras / planCap -> "derives every fact from the division itself"
//   Q35  livePackage reads a refunded row as live                -> "after a full refund the package is history"
//   M1   the roll projection drops the database's `now`          -> "the roll is judged at the DATABASE's month" (JS clock in 2020)
//   S1   shortBy = owed (the balance not subtracted)             -> "a short balance", "shortBy sweep"
//   S3   a balance exactly equal to owed is short (> for >=)     -> "a short balance" (exactly enough), "shortBy sweep"
//   S4   shortBy never set                                       -> "a short balance", "shortBy sweep", the split invariant
//   S5   a refusal still answers a take / shortBy                -> the split invariant on every quote
//   C1   covers ignores the held / rounds refusals               -> "covers sweep"
//   C2   covers lets the PLAN refusal break it                   -> "a plan downgrade does not break covers"
//   C3   covers judged at the size ASKED, not the row's own      -> "covers sweep" (asked at another size)
//   C4   covers ignores the camera price the policy needs        -> "covers sweep", "covers is a fact about the PACKAGE"
//   C5   covers true for an unpaid row                           -> "covers is false without a paid live package"
//   C6   covers ignores a frozen row                             -> "covers is false without a paid live package"
//   C7   covers takes the addCameras intent                      -> "covers is a fact about the PACKAGE"
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql, statementTexts, type Tx } from "@/lib/db";
import { getLimit } from "@/lib/entitlements";
import { ONLINE_SIZES, includedRounds, packagePrice, type OnlineSize } from "@/lib/online-chess-package";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  creditBalance, creditBreakdown, grantMonthlyStreamCredits, recordPurchase, streamMonthlyGrantKey, streamMonthlyPeriod,
} from "@/server/usecases/stream-credits";
import {
  countedRounds, debitForPackage, derivedCameras, lastDayOfUtcMonth, onlinePackageQuote, quoteLocked, refundForPackage,
  type PackageFacts, type PackageQuote,
} from "@/server/usecases/online-package";

const HAS_DB = !!process.env.DATABASE_URL;

/** Global Constraints: "Included rounds: 16→6, 32→7, 64→8, 128→9, 256→10". */
const INCLUDED: Record<OnlineSize, number> = { 16: 6, 32: 7, 64: 8, 128: 9, 256: 10 };
const MOST_ROUNDS = 10;

/** The database's clock at the start of the file, and the UTC months either side of it (set in beforeAll). */
let DB_NOW: Date;
let THIS_PERIOD: string;
let LAST_PERIOD: string;

/** The organiser on a paid row (paid_by has no foreign key: spec §7.1). */
const PAYER = "00000000-0000-4000-8000-00000000c0de";

const inTx = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => sql.begin(fn) as unknown as Promise<T>;
const suffix = (): string => randomUUID().replaceAll("-", "").slice(0, 12);

beforeAll(async () => {
  if (!HAS_DB) return;
  DB_NOW = (await sql<{ now: Date }[]>`select now() as now`)[0]!.now;
  THIS_PERIOD = streamMonthlyPeriod(DB_NOW);
  const lastMonth = new Date(Date.UTC(DB_NOW.getUTCFullYear(), DB_NOW.getUTCMonth() - 1, 15, 12));
  LAST_PERIOD = streamMonthlyPeriod(lastMonth);
  expect(LAST_PERIOD, "premise: two different months").not.toBe(THIS_PERIOD);
  for (const s of ONLINE_SIZES) expect(includedRounds(s), `premise: the leaf's rounds for ${s} are the Global Constraints'`).toBe(INCLUDED[s]);
});

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

// ─── The pure half ────────────────────────────────────────────────────────────────────────────────────────────────────

describe("lastDayOfUtcMonth: the last day of the UTC month, as an ISO date", () => {
  it("every month of a common year and of a leap year", () => {
    // The calendar: Jan 31, Feb 28 (29), Mar 31, Apr 30, May 31, Jun 30, Jul 31, Aug 31, Sep 30, Oct 31, Nov 30, Dec 31.
    const common = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let checked = 0;
    for (const [year, days] of [[2026, common], [2028, common.map((d, i) => (i === 1 ? 29 : d))]] as const) {
      for (let m = 0; m < 12; m += 1) {
        const first = new Date(Date.UTC(year, m, 1, 0, 0, 0));
        const mid = new Date(Date.UTC(year, m, 15, 12, 30, 0));
        const last = new Date(Date.UTC(year, m, days[m]!, 23, 59, 59, 999));
        const want = `${year}-${String(m + 1).padStart(2, "0")}-${String(days[m]).padStart(2, "0")}`;
        for (const d of [first, mid, last]) {
          expect(lastDayOfUtcMonth(d), d.toISOString()).toBe(want);
          checked += 1;
        }
      }
    }
    expect(checked, "instants judged").toBe(2 * 12 * 3);
  });

  it("is the UTC month, never the local one: the last BST hour of June is still June, and the first minute of July is July", () => {
    // 2026-06-30T23:30Z is 00:30 on 1 July in Europe/London (BST), where the database runs; the UTC month is June.
    expect(lastDayOfUtcMonth(new Date("2026-06-30T23:30:00Z"))).toBe("2026-06-30");
    expect(lastDayOfUtcMonth(new Date("2026-07-01T00:00:00Z"))).toBe("2026-07-31");
    expect(lastDayOfUtcMonth(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12-31");
    expect(lastDayOfUtcMonth(new Date("2027-01-01T00:00:00Z"))).toBe("2027-01-31");
  });
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────────────────────────────────────────────

type Policy = "off" | "optional" | "required";
const POLICIES: readonly Policy[] = ["off", "optional", "required"];

async function seedOrg(): Promise<string> {
  const s = suffix();
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, slug) values (${"OC Quote " + s}, ${"oc-quote-" + s}) returning id`;
  return o!.id;
}

interface Div { id: string; name: string; competitionId: string }

async function seedDivision(orgId: string, o: { competition?: Policy; division?: Policy | null } = {}): Promise<Div> {
  const s = suffix();
  const [c] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, camera_policy)
    values (${orgId}, ${"OC Cup " + s}, ${"oc-cup-" + s}, 'private', ${o.competition ?? "off"}) returning id`;
  const name = `Open ${s}`;
  const [d] = await sql<{ id: string }[]>`
    insert into divisions (competition_id, name, slug, sport_key, variant_key, config, module_version, camera_policy)
    values (${c!.id}, ${name}, ${"oc-div-" + s}, 'boardgame', 'classical', ${sql.json({ onlinePlay: "lichess" } as never)}, '1.0.0', ${o.division ?? null})
    returning id`;
  return { id: d!.id, name, competitionId: c!.id };
}

let stageSeq = 0;
async function seedStage(orgId: string, divisionId: string, kind: string, config: unknown, policy: Policy | null = null): Promise<string> {
  stageSeq += 1;
  const [s] = await sql<{ id: string }[]>`
    insert into stages (division_id, org_id, seq, kind, name, config, camera_policy)
    values (${divisionId}, ${orgId}, ${stageSeq}, ${kind}, ${`Stage ${stageSeq}`}, ${sql.json(config as never)}, ${policy})
    returning id`;
  return s!.id;
}

/** An UNPAID package row at `size`, as chooseOnlineSize (Task 6) will write it. */
async function seedPackage(orgId: string, division: { id: string; name: string }, size: number): Promise<string> {
  const [p] = await sql<{ id: string }[]>`
    insert into division_online_packages (org_id, division_id, division_name, size)
    values (${orgId}, ${division.id}, ${division.name}, ${size}) returning id`;
  return p!.id;
}

const buy = (orgId: string, n: number) => {
  const cs = `cs_oc_${suffix()}`;
  return recordPurchase({
    orgId, delta: n, stripeEventId: cs,
    link: { checkoutSessionId: cs, paymentIntentId: `pi_${cs}`, pack: `seazn_stream_pack_${n}`, amountMinor: 600, currency: "gbp" },
  });
};

/** Move every ledger row the org has so far back one calendar month: "this was written last month". Both halves of a row's
 *  month move: its date, on the UTC wall clock, and the monthly grant's idempotency key, which NAMES its month. */
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
     where org_id = ${orgId}
       and (to_char(created_at at time zone 'UTC', 'YYYY-MM') = ${THIS_PERIOD} or starts_with(idempotency_key, ${thisKey}::text))`;
  expect(left!.n, "premise: nothing of the org's ledger is left in this month").toBe(0);
}

interface Rig { orgId: string; divisionId: string; division: Div; packageId: string; rate: number }

/** An org holding `monthly` included credits (a month's grant through the real rollover, at `monthly` as the plan's rate) and
 *  `pack` bought ones (a real purchase), with one division and its unpaid package row at `size`. */
async function rig(o: { monthly?: number; pack?: number; size?: number; lastMonth?: boolean; division?: Parameters<typeof seedDivision>[1] } = {}): Promise<Rig> {
  const monthly = o.monthly ?? 0;
  const pack = o.pack ?? 0;
  const orgId = await seedOrg();
  if (monthly > 0) await grantMonthlyStreamCredits(orgId, monthly, DB_NOW);
  if (pack > 0) await buy(orgId, pack);
  if (o.lastMonth) await backdateOrgLedger(orgId);
  const bd = await creditBreakdown(sql, orgId);
  expect(bd.monthly + bd.pack, "premise: the org holds what the case says").toBe(monthly + pack);
  const division = await seedDivision(orgId, o.division);
  const packageId = await seedPackage(orgId, division, o.size ?? 64);
  return { orgId, divisionId: division.id, division, packageId, rate: monthly };
}

/** What Tasks 5 and 6 write on the package row after a step, in ONE statement (V549's CHECKs hold per statement). */
const settlePackage = (id: string, s: { size: number; cameras: boolean; paid: number; refunded: number; forfeited: number }) => sql`
  update division_online_packages
     set size = ${s.size}, cameras_paid = ${s.cameras}, credits_paid = ${s.paid}, credits_refunded = ${s.refunded},
         credits_forfeited = ${s.forfeited}, paid_at = coalesce(paid_at, now()), paid_by = coalesce(paid_by, ${PAYER}::uuid)
   where id = ${id}`;

const pay = (r: Rig, credits: number, rate = r.rate) =>
  inTx((tx) => debitForPackage(tx, { orgId: r.orgId, packageId: r.packageId, credits, rate, size: 16 }));

/** A paid package: the debit as Task 5 writes it (the real writer), then the row. */
async function paidRig(o: { size: OnlineSize; cameras: boolean; monthly?: number; pack?: number; lastMonth?: boolean }): Promise<Rig & { credits: number }> {
  const credits = packagePrice(o.size, o.cameras);
  const r = await rig({ monthly: o.monthly ?? 0, pack: o.pack ?? credits + 40, size: o.size });
  await pay(r, credits);
  await settlePackage(r.packageId, { size: o.size, cameras: o.cameras, paid: credits, refunded: 0, forfeited: 0 });
  if (o.lastMonth) await backdateOrgLedger(r.orgId);
  return { ...r, credits };
}

const FACTS0: PackageFacts = { cameras: false, rounds: 0, held: 0, planCap: null };
/** Exactly one of `take` and `shortBy` answers an owed > 0 with no refusal (the balance covers it, or it does not and by how much);
 *  neither answers anything else. Every quote this file asks is judged by it. */
function expectSplitInvariant(q: PackageQuote): void {
  const label = `size ${q.size} owed ${q.owed} balance ${q.balance} refusal ${q.refusal}`;
  const pays = q.owed > 0 && q.refusal === null;
  expect(q.take !== null || q.shortBy !== null, `${label}: a payable quote has a take or a shortfall`).toBe(pays);
  expect(q.take !== null && q.shortBy !== null, `${label}: never both`).toBe(false);
  if (q.take !== null) expect(q.take.monthly + q.take.pack, `${label}: the take is the owed credits`).toBe(q.owed);
  if (q.shortBy !== null) expect(q.balance + q.shortBy, `${label}: balance plus the shortfall is the owed credits`).toBe(q.owed);
}

const quote = async (
  r: Rig, size: OnlineSize, o: { addCameras?: boolean; facts?: Partial<PackageFacts>; rate?: number } = {},
): Promise<PackageQuote> => {
  const q = await inTx((tx) => quoteLocked(tx, { orgId: r.orgId, divisionId: r.divisionId, size, addCameras: o.addCameras, rate: o.rate ?? r.rate }, { ...FACTS0, ...o.facts }));
  expectSplitInvariant(q);
  return q;
};

class Rollback extends Error {
  constructor(readonly value: unknown) {
    super("rolled back on purpose");
  }
}
/** Run `fn` in a transaction and roll it back, answering what it answered: what a REAL writer would do, without doing it. */
async function rolledBack<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    await sql.begin(async (tx) => {
      throw new Rollback(await fn(tx));
    });
  } catch (e) {
    if (e instanceof Rollback) return e.value as T;
    throw e;
  }
  throw new Error("unreachable: the transaction callback always throws");
}

const ledgerCount = async (orgId: string) => (await sql<{ n: number }[]>`select count(*)::int as n from org_stream_credits where org_id = ${orgId}`)[0]!.n;

/** P9, written out from the three columns: the nearest level that is set wins; nothing set is off. */
function oracleCameras(stages: (Policy | null)[], division: Policy | null, competition: Policy): boolean {
  const levels = stages.length === 0 ? [null] : stages;
  return levels.some((stage) => (stage ?? division ?? competition) !== "off");
}

// ─── derivedCameras (P9) ──────────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("derivedCameras", () => {
  it("derivedCameras is nearest-level-wins per stage: competition required + division off → false; division off + one stage required → true", async () => {
    const orgId = await seedOrg();
    // competition required, division off, a stage that inherits: the division's off is nearer, so WITHOUT cameras.
    const a = await seedDivision(orgId, { competition: "required", division: "off" });
    await seedStage(orgId, a.id, "swiss", { rounds: 5 }, null);
    expect(await derivedCameras(sql, a.id), "competition required + division off").toBe(false);
    // the same division with ONE stage on required: the stage is nearer than the division, so WITH cameras.
    await seedStage(orgId, a.id, "knockout", {}, "required");
    expect(await derivedCameras(sql, a.id), "division off + one stage required").toBe(true);
    // A stage that sets off beats a division on required, for that stage; the other stage still inherits required.
    const b = await seedDivision(orgId, { competition: "off", division: "required" });
    await seedStage(orgId, b.id, "swiss", { rounds: 5 }, "off");
    expect(await derivedCameras(sql, b.id), "division required, its only stage off").toBe(false);
    await seedStage(orgId, b.id, "knockout", {}, null);
    expect(await derivedCameras(sql, b.id), "division required, one stage off and one inheriting").toBe(true);
  });

  it("derivedCameras with no stages uses the division's effective policy (Review Focus 2) — every division × competition pair", async () => {
    const orgId = await seedOrg();
    const d = await seedDivision(orgId);
    let checked = 0;
    for (const competition of POLICIES) {
      for (const division of [null, ...POLICIES] as (Policy | null)[]) {
        await sql`update competitions set camera_policy = ${competition} where id = ${d.competitionId}`;
        await sql`update divisions set camera_policy = ${division} where id = ${d.id}`;
        expect(await derivedCameras(sql, d.id), `no stage; division ${division}, competition ${competition}`).toBe(oracleCameras([], division, competition));
        checked += 1;
      }
    }
    expect(checked, "pairs judged").toBe(3 * 4);
  });

  it("derivedCameras: a sweep over stage × division × competition levels for a one-stage division", async () => {
    const orgId = await seedOrg();
    const d = await seedDivision(orgId);
    const stageId = await seedStage(orgId, d.id, "swiss", { rounds: 4 }, null);
    let checked = 0;
    let withCameras = 0;
    for (const competition of POLICIES) {
      for (const division of [null, ...POLICIES] as (Policy | null)[]) {
        for (const stage of [null, ...POLICIES] as (Policy | null)[]) {
          await sql`update competitions set camera_policy = ${competition} where id = ${d.competitionId}`;
          await sql`update divisions set camera_policy = ${division} where id = ${d.id}`;
          await sql`update stages set camera_policy = ${stage} where id = ${stageId}`;
          const want = oracleCameras([stage], division, competition);
          expect(await derivedCameras(sql, d.id), `stage ${stage}, division ${division}, competition ${competition}`).toBe(want);
          checked += 1;
          if (want) withCameras += 1;
        }
      }
    }
    expect(checked, "triples judged").toBe(3 * 4 * 4);
    // Anti-vacuity: the sweep reaches both answers (an all-false or all-true reader would fail one half).
    expect(withCameras, "triples with cameras").toBeGreaterThan(10);
    expect(checked - withCameras, "triples without").toBeGreaterThan(10);
  });

  it("derivedCameras refuses a division that does not exist (a quote for nothing is a bug upstream, never `false`)", async () => {
    await expect(derivedCameras(sql, randomUUID())).rejects.toMatchObject({ status: 404 });
  });
});

// ─── countedRounds (P15) ──────────────────────────────────────────────────────────────────────────────────────────────

/** Every stage kind V298's stages_kind_check allows. */
const ALL_KINDS = ["league", "group", "swiss", "knockout", "double_elim", "stepladder", "americano", "ladder", "page_playoff"] as const;

describe.skipIf(!HAS_DB)("countedRounds (P15)", () => {
  it("countedRounds sums Swiss config.rounds only: swiss 5 + knockout → 5; swiss 5 + swiss 3 → 8; knockout alone → 0", async () => {
    const orgId = await seedOrg();
    const cases: [string, [string, unknown][], number][] = [
      ["swiss 5 + knockout", [["swiss", { rounds: 5 }], ["knockout", {}]], 5],
      ["swiss 5 + swiss 3", [["swiss", { rounds: 5 }], ["swiss", { rounds: 3 }]], 8],
      ["knockout alone", [["knockout", {}]], 0],
      ["no stages yet (Review Focus 2)", [], 0],
    ];
    for (const [label, stages, want] of cases) {
      const d = await seedDivision(orgId);
      for (const [kind, config] of stages) await seedStage(orgId, d.id, kind, config);
      expect(await countedRounds(sql, d.id), label).toBe(want);
    }
    expect(cases.length, "cases judged").toBe(4);
  });

  it("countedRounds counts a Swiss and nothing else: every kind carrying a round count of 3 adds 3 only for swiss", async () => {
    const orgId = await seedOrg();
    let checked = 0;
    for (const kind of ALL_KINDS) {
      const d = await seedDivision(orgId);
      await seedStage(orgId, d.id, kind, { rounds: 3 });
      expect(await countedRounds(sql, d.id), kind).toBe(kind === "swiss" ? 3 : 0);
      checked += 1;
    }
    expect(checked, "kinds judged").toBe(ALL_KINDS.length);
  });

  it("countedRounds: a Swiss stage with an ABSENT or unusable round count counts 0 (it plays no round: Generate and Start refuse it by name), and its neighbours still count", async () => {
    // P15 sums `config.rounds`; a stage that has none contributes nothing. The stage-graph door refuses to WRITE one
    // (STAGE_SWISS_ROUNDS_REQUIRED), and swissGen / refuseSwissRoundsAboveMaxAtStart refuse to PLAY one (CONFIG_INVALID), so
    // what such a stage costs is nothing until a round count is declared; every door that declares one re-asks the size.
    const orgId = await seedOrg();
    const unusable: [string, unknown][] = [
      ["absent", {}],
      ["null", { rounds: null }],
      ["zero", { rounds: 0 }],
      ["negative", { rounds: -2 }],
      ["fractional", { rounds: 2.5 }],
      ["a string", { rounds: "5" }],
      ["a boolean", { rounds: true }],
    ];
    let checked = 0;
    for (const [label, config] of unusable) {
      const alone = await seedDivision(orgId);
      await seedStage(orgId, alone.id, "swiss", config);
      expect(await countedRounds(sql, alone.id), `${label}, alone`).toBe(0);
      const beside = await seedDivision(orgId);
      await seedStage(orgId, beside.id, "swiss", config);
      await seedStage(orgId, beside.id, "swiss", { rounds: 4 });
      expect(await countedRounds(sql, beside.id), `${label}, beside a Swiss of 4`).toBe(4);
      checked += 1;
    }
    expect(checked, "unusable shapes judged").toBe(unusable.length);
  });
});

// ─── quoteLocked: what is owed ────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("quoteLocked: price and what is owed", () => {
  it("unpaid 32 with cameras: owed 4, take split from the balance (the included credit first, then bought)", async () => {
    // Global Constraints: 32 → 2 without cameras, 4 with. The org holds 1 included + 5 bought: P4 draws the included credit first.
    const r = await rig({ monthly: 1, pack: 5, size: 32 });
    const q = await quote(r, 32, { facts: { cameras: true } });
    expect(q).toMatchObject({ size: 32, cameras: true, price: 4, owed: 4, take: { monthly: 1, pack: 3 }, back: null, balance: 6, held: 0, rounds: 0, refusal: null });
    // The same package without cameras costs half: 2.
    expect(await quote(r, 32)).toMatchObject({ cameras: false, price: 2, owed: 2, take: { monthly: 1, pack: 1 } });
    // The quote WROTE nothing: the balance is where it was.
    expect(await creditBalance(sql, r.orgId)).toBe(6);
  });

  it("unpaid sweep: every size × camera fact × addCameras, with a package row and without one — price, owed and take from the leaf and P4", async () => {
    const withRow = await rig({ pack: 100 });
    const orgId = await seedOrg();
    await buy(orgId, 100);
    const division = await seedDivision(orgId); // NO package row at all
    const noRow: Rig = { orgId, divisionId: division.id, division, packageId: "", rate: 0 };
    let checked = 0;
    for (const r of [withRow, noRow]) {
      for (const size of ONLINE_SIZES) {
        for (const cameras of [false, true]) {
          for (const addCameras of [undefined, false, true]) {
            const q = await quote(r, size, { facts: { cameras }, addCameras });
            const wantCameras = cameras || addCameras === true;
            const want = packagePrice(size, wantCameras);
            const label = `row ${r === withRow} size ${size} cameras ${cameras} addCameras ${addCameras}`;
            expect(q, label).toMatchObject({ size, cameras: wantCameras, price: want, owed: want, take: { monthly: 0, pack: want }, back: null, balance: 100, refusal: null });
            checked += 1;
          }
        }
      }
    }
    expect(checked, "unpaid cases judged").toBe(2 * 5 * 2 * 3);
    // The Global Constraints' own table, typed: the sweep's oracle is the leaf, these pin the leaf's numbers.
    expect([16, 32, 64, 128, 256].map((s) => packagePrice(s as OnlineSize, false))).toEqual([1, 2, 4, 8, 16]);
    expect([16, 32, 64, 128, 256].map((s) => packagePrice(s as OnlineSize, true))).toEqual([2, 4, 8, 16, 32]);
  });

  it("paid sweep: paid at every size × camera state, quoted at every size × camera fact × addCameras — owed = price − price already paid", async () => {
    let checked = 0;
    let down = 0;
    let up = 0;
    let same = 0;
    for (const paidSize of ONLINE_SIZES) {
      for (const paidCameras of [false, true]) {
        const r = await paidRig({ size: paidSize, cameras: paidCameras, pack: 100 });
        const balance = 100 - packagePrice(paidSize, paidCameras);
        for (const size of ONLINE_SIZES) {
          for (const cameras of [false, true]) {
            for (const addCameras of [false, true]) {
              const q = await quote(r, size, { facts: { cameras }, addCameras });
              // P19: a camera price that was paid is never lowered.
              const wantCameras = cameras || addCameras || paidCameras;
              const price = packagePrice(size, wantCameras);
              const owed = price - packagePrice(paidSize, paidCameras);
              const label = `paid ${paidSize}/${paidCameras} → ${size} cameras ${cameras} add ${addCameras}`;
              expect(q.cameras, label).toBe(wantCameras);
              expect(q.price, label).toBe(price);
              expect(q.owed, label).toBe(owed);
              expect(q.balance, label).toBe(balance);
              expect(q.refusal, label).toBeNull();
              expect(q.take, label).toEqual(owed > 0 ? { monthly: 0, pack: owed } : null);
              // Bought credits only: a move down returns them all (P21), nothing is forfeited.
              expect(q.back, label).toEqual(owed < 0 ? { pack: -owed, monthly: 0, forfeited: 0 } : null);
              checked += 1;
              if (owed < 0) down += 1;
              else if (owed > 0) up += 1;
              else same += 1;
            }
          }
        }
      }
    }
    expect(checked, "paid cases judged").toBe(5 * 2 * 5 * 2 * 2);
    // Anti-vacuity: the sweep reaches all three outcomes.
    expect(down, "move downs").toBeGreaterThan(20);
    expect(up, "pays").toBeGreaterThan(20);
    expect(same, "owed nothing").toBeGreaterThan(10);
  });

  it("paid 32 no cameras → quote 64: owed 2; → quote 16: owed −1 with back per P21", async () => {
    const r = await paidRig({ size: 32, cameras: false, pack: 6 }); // paid 2, balance 4 + 40... pack 6 → 4 left
    expect(await quote(r, 64)).toMatchObject({ price: 4, owed: 2, take: { monthly: 0, pack: 2 }, back: null });
    expect(await quote(r, 16)).toMatchObject({ price: 1, owed: -1, take: null, back: { pack: 1, monthly: 0, forfeited: 0 } });
    expect(await quote(r, 32)).toMatchObject({ price: 2, owed: 0, take: null, back: null });
  });

  it("addCameras raises the price and never lowers it; on a row with cameras_paid it owes 0", async () => {
    // Paid at 64 WITHOUT cameras (4 credits).
    const without = await paidRig({ size: 64, cameras: false, pack: 20 });
    const base = await quote(without, 64);
    const raised = await quote(without, 64, { addCameras: true });
    expect(base).toMatchObject({ cameras: false, price: 4, owed: 0 });
    expect(raised).toMatchObject({ cameras: true, price: 8, owed: 4, take: { monthly: 0, pack: 4 } });
    expect(raised.price, "addCameras raises the price").toBeGreaterThan(base.price);
    expect((await quote(without, 64, { addCameras: false })).price, "addCameras:false lowers nothing").toBe(base.price);
    // The camera policy turning on is the same raise, without the intent.
    expect(await quote(without, 64, { facts: { cameras: true } })).toMatchObject({ cameras: true, price: 8, owed: 4 });
    // Paid WITH cameras (8): the camera price was paid, so it stays, whatever the policy and the intent say, and nothing is owed.
    const withCams = await paidRig({ size: 64, cameras: true, pack: 20 });
    for (const [label, o] of [
      ["no intent, policy off", {}],
      ["addCameras false", { addCameras: false }],
      ["addCameras true", { addCameras: true }],
      ["policy on", { facts: { cameras: true } }],
    ] as const) {
      expect(await quote(withCams, 64, o), label).toMatchObject({ cameras: true, price: 8, owed: 0, take: null, back: null });
    }
  });

  it("a short balance answers take null and the true balance — no throw, nothing written; exactly enough takes", async () => {
    const short = await rig({ monthly: 0, pack: 1, size: 64 }); // 64 costs 4
    const q = await quote(short, 64);
    expect(q).toMatchObject({ owed: 4, take: null, shortBy: 3, balance: 1, refusal: null });
    expect(await ledgerCount(short.orgId), "one purchase row, nothing more").toBe(1);
    const exact = await rig({ monthly: 1, pack: 3, size: 64 });
    expect(await quote(exact, 64)).toMatchObject({ owed: 4, take: { monthly: 1, pack: 3 }, shortBy: null, balance: 4 });
    // The empty ledger: an org that never held a credit, at a rate of 0.
    const empty = await rig({ size: 16 });
    expect(await quote(empty, 16)).toMatchObject({ owed: 1, take: null, shortBy: 1, balance: 0 });
  });

  it("shortBy sweep: every balance 0..8 × the sizes 16, 32, 64 — the credits missing, null once the balance covers the owed", async () => {
    let checked = 0;
    let short = 0;
    let covered = 0;
    for (let held = 0; held <= 8; held += 1) {
      const r = await rig({ pack: held, size: 16 });
      for (const [size, owed] of [[16, 1], [32, 2], [64, 4]] as const) {
        const q = await quote(r, size);
        expect(q.owed, `size ${size}`).toBe(owed);
        expect(q.shortBy, `balance ${held}, owed ${owed}`).toBe(held < owed ? owed - held : null);
        expect(q.take === null, `balance ${held}, owed ${owed}: a take exactly when nothing is missing`).toBe(held < owed);
        checked += 1;
        if (q.shortBy === null) covered += 1;
        else short += 1;
      }
    }
    expect(checked, "cases judged").toBe(9 * 3);
    expect(short, "short cases").toBeGreaterThan(5);
    expect(covered, "covered cases").toBeGreaterThan(5);
  });

  it("shortBy is null whenever nothing is payable: a refusal, a move down, the row's own size", async () => {
    // A short org (balance 0) asked for what its plan refuses: no shortfall to show, the refusal is the answer.
    const empty = await rig({ size: 16 });
    expect(await quote(empty, 128, { facts: { planCap: 64 } })).toMatchObject({ owed: 8, refusal: "plan", take: null, shortBy: null });
    expect(await quote(empty, 16, { facts: { held: 20 } })).toMatchObject({ owed: 1, refusal: "below_held", take: null, shortBy: null });
    // A paid row owes nothing at its own size and returns on a move down: neither is short, whatever the balance.
    const paid = await paidRig({ size: 64, cameras: false, pack: 4 }); // balance 0 after paying
    expect(await quote(paid, 64)).toMatchObject({ owed: 0, balance: 0, shortBy: null, take: null });
    expect(await quote(paid, 32)).toMatchObject({ owed: -2, balance: 0, shortBy: null, take: null, back: { pack: 2, monthly: 0, forfeited: 0 } });
    // ...and a raise it cannot afford IS short.
    expect(await quote(paid, 128)).toMatchObject({ owed: 4, balance: 0, shortBy: 4, take: null });
  });
});

// ─── quoteLocked: the month, projected and never rolled ───────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("quoteLocked: an unrolled month", () => {
  /** A quote's `take` and `balance` against what the REAL debit does to the same org, in a transaction that is rolled back: the
   *  split it takes, and the total it leaves (the quote's balance less the owed credits, after the debit's own rollover). */
  async function expectTakeIsWhatTheDebitTakes(r: Rig, q: PackageQuote, rate: number): Promise<void> {
    expect(q.take, "premise: the quote has a take to compare").not.toBeNull();
    const real = await rolledBack(async (tx) => {
      const took = await debitForPackage(tx, { orgId: r.orgId, packageId: r.packageId, credits: q.owed, rate, size: 16 });
      return { took, left: (await creditBreakdown(tx, r.orgId)).total };
    });
    expect(real.took, "the real debit takes what the quote said").toEqual(q.take);
    expect(real.left, "the real debit leaves what the quote's balance less the owed predicts").toBe(q.balance - q.owed);
  }

  it("an unrolled month: an org that never touched the ledger, on a plan of 1 a month, can pay 1 — and the quote writes no grant", async () => {
    const r = await rig({ size: 16 });
    expect(await ledgerCount(r.orgId), "premise: the ledger is empty").toBe(0);
    const q = await quote(r, 16, { rate: 1 });
    // 16 without cameras costs 1; this month's 1 included credit is not granted yet, and the debit would grant it first.
    expect(q).toMatchObject({ owed: 1, take: { monthly: 1, pack: 0 }, balance: 1 });
    expect(await ledgerCount(r.orgId), "the quote rolled nothing").toBe(0);
    await expectTakeIsWhatTheDebitTakes(r, q, 1);
  });

  it("an unrolled month: last month's leftover is not this month's credit — it expires, this month's grant replaces it", async () => {
    // Last month: 3 included (unspent) + 2 bought. This month nothing has touched the org, and the plan grants 1.
    const r = await rig({ monthly: 3, pack: 2, size: 32, lastMonth: true });
    const q = await quote(r, 32, { rate: 1 });
    // Held after the rollover: 1 included + 2 bought = 3 (not 5). 32 costs 2: the included credit, then 1 bought.
    expect(q).toMatchObject({ owed: 2, take: { monthly: 1, pack: 1 }, balance: 3 });
    expect(q.take!.monthly + q.take!.pack).toBe(2);
    await expectTakeIsWhatTheDebitTakes(r, q, 1);
    expect((await creditBreakdown(sql, r.orgId)).total, "the quote rolled nothing: last month's 5 are still the ledger").toBe(5);
  });

  it("an unrolled month: a plan that grants more this month tops the included bucket up", async () => {
    const r = await rig({ monthly: 1, pack: 0, size: 64 });
    // This month's grant of 1 is in; the org's plan now grants 3, so the next debit tops the month up by 2.
    const q = await quote(r, 64, { rate: 3 });
    expect(q).toMatchObject({ owed: 4, take: null, balance: 3 }); // 3 held < 4 owed
    const q2 = await quote(r, 32, { rate: 3 });
    expect(q2).toMatchObject({ owed: 2, take: { monthly: 2, pack: 0 }, balance: 3 });
    await expectTakeIsWhatTheDebitTakes(r, q2, 3);
  });

  it("an unrolled month: a rolled month projects nothing (the rate equals what was granted)", async () => {
    const r = await rig({ monthly: 2, pack: 4, size: 64 });
    const q = await quote(r, 64, { rate: 2 });
    expect(q).toMatchObject({ owed: 4, take: { monthly: 2, pack: 2 }, balance: 6 });
    // The real debit rolls nothing here either, and takes the same.
    await expectTakeIsWhatTheDebitTakes(r, q, 2);
  });

  it("an unrolled month: a rate of 0 on last month's leftover expires it with no grant — the quote holds the bought credits only", async () => {
    // Last month: 3 included (unspent) + 2 bought. This month the plan grants nothing: the roll expires the 3 and writes no grant.
    const r = await rig({ monthly: 3, pack: 2, size: 32, lastMonth: true });
    const q = await quote(r, 32, { rate: 0 });
    expect(q).toMatchObject({ owed: 2, take: { monthly: 0, pack: 2 }, balance: 2 });
    await expectTakeIsWhatTheDebitTakes(r, q, 0);
    expect((await creditBreakdown(sql, r.orgId)).total, "the quote rolled nothing").toBe(5);
    // A rate of 0 on an org with bought credits and an untouched ledger changes nothing.
    const bought = await rig({ pack: 5, size: 16 });
    const q2 = await quote(bought, 16, { rate: 0 });
    expect(q2).toMatchObject({ owed: 1, take: { monthly: 0, pack: 1 }, balance: 5 });
    await expectTakeIsWhatTheDebitTakes(bought, q2, 0);
  });

  it("an unrolled month: the roll is judged at the DATABASE's month, never the JS clock — a month already spent stays spent whatever the JS clock says", async () => {
    // This month's 3 included credits were granted and all spent (on another division of the org): the month is rolled, its
    // bucket is empty, and the plan's rate of 3 is already granted. The database's roll adds nothing (delta 0).
    const r = await rig({ monthly: 3, pack: 0, size: 16 });
    const otherDivision = await seedDivision(r.orgId);
    const otherPackage = await seedPackage(r.orgId, otherDivision, 16);
    await inTx((tx) => debitForPackage(tx, { orgId: r.orgId, packageId: otherPackage, credits: 3, rate: 3, size: 16 }));
    expect(await creditBreakdown(sql, r.orgId), "premise: this month's credits are spent").toMatchObject({ monthly: 0, pack: 0, total: 0 });
    const real = await quote(r, 16, { rate: 3 });
    expect(real, "the database's month: nothing to grant, nothing to take, 1 short").toMatchObject({ owed: 1, take: null, shortBy: 1, balance: 0 });
    // A JS clock in ANOTHER month would read the same ledger as a new month and project this month's 3 as a grant to come.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2020-01-15T12:00:00Z"));
      expect(new Date().getUTCFullYear(), "premise: the JS clock is in another month").toBe(2020);
      const skewed = await quote(r, 16, { rate: 3 });
      expect(skewed, "a skewed JS clock changes nothing").toMatchObject({ owed: 1, take: null, shortBy: 1, balance: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("an unrolled month: a rate that is not a whole number is refused by name, as the writer refuses it", async () => {
    const r = await rig({ size: 16 });
    await expect(quote(r, 16, { rate: -1 })).rejects.toMatchObject({ status: 500, code: "monthly_rate_invalid" });
    await expect(quote(r, 16, { rate: 1.5 })).rejects.toMatchObject({ status: 500, code: "monthly_rate_invalid" });
  });
});

// ─── quoteLocked: refusals ────────────────────────────────────────────────────────────────────────────────────────────

/** P17's sentence: a cap that is a ladder value allows sizes up to it; one that is not allows the smallest size at or above it. */
function oraclePlanAllows(size: number, cap: number | null): boolean {
  if (cap === null || size <= cap) return true;
  return size === ONLINE_SIZES.find((s) => s >= cap);
}

describe.skipIf(!HAS_DB)("quoteLocked: refusals", () => {
  it("below_held sweep: every size × held (0, size−1, size, size+1) — refused only above the size, a full division is not refused; 256 with 257 held is refused", async () => {
    const r = await rig({ pack: 100 });
    let checked = 0;
    let refused = 0;
    for (const size of ONLINE_SIZES) {
      for (const held of [0, size - 1, size, size + 1]) {
        const q = await quote(r, size, { facts: { held } });
        expect(q.refusal, `size ${size} held ${held}`).toBe(held > size ? "below_held" : null);
        expect(q.held, "the quote says what it counted").toBe(held);
        checked += 1;
        if (q.refusal !== null) refused += 1;
      }
    }
    expect(checked, "cases judged").toBe(5 * 4);
    expect(refused, "one refused case per size").toBe(5);
    // The backfilled division (Task 2): it holds more than 256 (stored before the cap) and the migration gave it size 256.
    expect((await quote(r, 256, { facts: { held: 257 } })).refusal).toBe("below_held");
    expect((await quote(r, 256, { facts: { held: 256 } })).refusal).toBeNull();
  });

  it("plan sweep: every size × plan cap (none, ladder values, 48, 96, 192, 512) — P17", async () => {
    const r = await rig({ pack: 100 });
    const caps: (number | null)[] = [null, 16, 32, 48, 64, 96, 128, 192, 256, 512];
    let checked = 0;
    let refused = 0;
    for (const size of ONLINE_SIZES) {
      for (const planCap of caps) {
        const q = await quote(r, size, { facts: { planCap } });
        expect(q.refusal, `size ${size} plan cap ${planCap}`).toBe(oraclePlanAllows(size, planCap) ? null : "plan");
        checked += 1;
        if (q.refusal !== null) refused += 1;
      }
    }
    expect(checked, "cases judged").toBe(5 * caps.length);
    expect(refused, "refused cases").toBeGreaterThan(10);
    // P17's worked example, typed: a plan of 96 may buy 128 but not 256, and 64 as ever.
    expect((await quote(r, 128, { facts: { planCap: 96 } })).refusal).toBeNull();
    expect((await quote(r, 256, { facts: { planCap: 96 } })).refusal).toBe("plan");
    expect((await quote(r, 64, { facts: { planCap: 96 } })).refusal).toBeNull();
  });

  it("rounds sweep: every size × counted rounds 0..12 — over the size's included rounds is `rounds`, over 10 is `rounds_above_max` (P10)", async () => {
    const r = await rig({ pack: 100 });
    let checked = 0;
    const seen = new Set<string>();
    for (const size of ONLINE_SIZES) {
      for (let rounds = 0; rounds <= 12; rounds += 1) {
        const q = await quote(r, size, { facts: { rounds } });
        const want = rounds > MOST_ROUNDS ? "rounds_above_max" : rounds > INCLUDED[size] ? "rounds" : null;
        expect(q.refusal, `size ${size} rounds ${rounds}`).toBe(want);
        expect(q.rounds, "the quote says what it counted").toBe(rounds);
        seen.add(String(want));
        checked += 1;
      }
    }
    expect(checked, "cases judged").toBe(5 * 13);
    expect([...seen].sort(), "the sweep reaches all three answers").toEqual(["null", "rounds", "rounds_above_max"]);
    // The brief's own cases: 7 rounds on a 16 is refused for the size, 11 for every size.
    expect((await quote(r, 16, { facts: { rounds: 7 } })).refusal).toBe("rounds");
    expect((await quote(r, 256, { facts: { rounds: 11 } })).refusal).toBe("rounds_above_max");
    expect((await quote(r, 256, { facts: { rounds: 10 } })).refusal).toBeNull();
  });

  it("refusals: a frozen row — paid and grandfathered-unpaid alike — whatever else is true", async () => {
    // A paid row that opened a round.
    const paid = await paidRig({ size: 64, cameras: false, pack: 10 });
    await sql`update division_online_packages set frozen_at = now() where id = ${paid.packageId}`;
    const q = await quote(paid, 128);
    expect(q).toMatchObject({ refusal: "frozen", take: null, back: null });
    expect((await quote(paid, 16)).refusal, "a move down on a frozen row").toBe("frozen");
    expect((await quote(paid, 64)).refusal, "the row's own size on a frozen row").toBe("frozen");
    // The backfill's grandfathered row: frozen and unpaid, at 256 (frozen_at = created_at, V549's own CHECK).
    const old = await rig({ pack: 100, size: 256 });
    await sql`update division_online_packages set frozen_at = created_at where id = ${old.packageId}`;
    expect(await quote(old, 256)).toMatchObject({ refusal: "frozen", take: null, back: null });
    // An unfrozen row of the same shape is not refused (the premise that the refusal is the freeze's).
    const fresh = await rig({ pack: 100, size: 256 });
    expect((await quote(fresh, 256)).refusal).toBeNull();
  });

  it("refusal precedence: frozen, then below_held, then plan, then rounds_above_max, then rounds", async () => {
    const r = await rig({ pack: 100, size: 32 });
    const frozen = await rig({ pack: 100, size: 32 });
    await sql`update division_online_packages set frozen_at = created_at where id = ${frozen.packageId}`;
    const cases: [string, Rig, OnlineSize, Partial<PackageFacts>, PackageQuote["refusal"]][] = [
      ["frozen + below_held", frozen, 16, { held: 40 }, "frozen"],
      ["frozen + plan", frozen, 64, { planCap: 32 }, "frozen"],
      ["frozen + rounds", frozen, 16, { rounds: 11 }, "frozen"],
      ["below_held + plan", r, 32, { held: 40, planCap: 16 }, "below_held"],
      ["below_held + rounds", r, 16, { held: 20, rounds: 7 }, "below_held"],
      ["below_held + rounds_above_max", r, 16, { held: 20, rounds: 11 }, "below_held"],
      ["plan + rounds_above_max", r, 64, { planCap: 32, rounds: 11 }, "plan"],
      ["plan + rounds", r, 64, { planCap: 32, rounds: 9 }, "plan"],
      ["rounds_above_max + rounds (11 rounds also exceed a 16's 6)", r, 16, { rounds: 11 }, "rounds_above_max"],
    ];
    for (const [label, rg, size, facts, want] of cases) {
      expect((await quote(rg, size, { facts })).refusal, label).toBe(want);
    }
    expect(cases.length, "cases judged").toBe(9);
  });

  it("a refusal carries no split: owed still says the arithmetic, take and back are null", async () => {
    // Paid 64 (4): a move down to 16 owes −3 and would give 3 back, but the 40 held do not fit a 16.
    const paid = await paidRig({ size: 64, cameras: false, pack: 10 });
    const down = await quote(paid, 16, { facts: { held: 40 } });
    expect(down).toMatchObject({ owed: -3, refusal: "below_held", take: null, back: null });
    // Unpaid with money: 128 costs 8 but the plan refuses it.
    const unpaid = await rig({ pack: 100, size: 16 });
    expect(await quote(unpaid, 128, { facts: { planCap: 64 } })).toMatchObject({ owed: 8, refusal: "plan", take: null, back: null });
    expect(await quote(unpaid, 128)).toMatchObject({ owed: 8, refusal: null, take: { monthly: 0, pack: 8 } });
  });

  it("a size off the ladder, and facts that are not counts, are bugs upstream: refused by name, never priced", async () => {
    const r = await rig({ pack: 100 });
    for (const size of [0, 48, 512, 16.5, Number.NaN]) {
      await expect(quote(r, size as OnlineSize), `size ${size}`).rejects.toThrow(RangeError);
    }
    for (const facts of [{ held: -1 }, { held: 1.5 }, { held: Number.NaN }, { rounds: -1 }, { rounds: 2.5 }, { rounds: Number.NaN }]) {
      await expect(quote(r, 16, { facts }), JSON.stringify(facts)).rejects.toThrow(RangeError);
    }
  });

  it("a division of another org is a 404 (it answers nothing of the other org), a package of another org is refused by name", async () => {
    const mine = await rig({ pack: 10 });
    const theirs = await rig({ pack: 10 });
    await expect(
      inTx((tx) => quoteLocked(tx, { orgId: mine.orgId, divisionId: theirs.divisionId, size: 16, rate: 0 }, FACTS0)),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      inTx((tx) => quoteLocked(tx, { orgId: mine.orgId, divisionId: randomUUID(), size: 16, rate: 0 }, FACTS0)),
    ).rejects.toMatchObject({ status: 404 });
    // A package row naming the division of one org and the org of another ("cannot happen"; the row's own FKs do not tie them).
    await sql`update division_online_packages set org_id = ${theirs.orgId} where id = ${mine.packageId}`;
    await expect(quote(mine, 16)).rejects.toMatchObject({ status: 500, code: "online_package_not_of_org" });
  });
});

// ─── quoteLocked: moving down, and the month ──────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("quoteLocked: the return (P21) and the sequence", () => {
  it("sequence: quote → pay → quote → move down → quote again → move up", async () => {
    const r = await rig({ pack: 10, size: 64 });
    // 1. Unpaid at 64: owed 4, from the 10 bought.
    expect(await quote(r, 64)).toMatchObject({ owed: 4, take: { monthly: 0, pack: 4 }, balance: 10 });
    // 2. Pay (Task 5's shape: the debit, then the row).
    expect(await pay(r, 4)).toEqual({ monthly: 0, pack: 4 });
    await settlePackage(r.packageId, { size: 64, cameras: false, paid: 4, refunded: 0, forfeited: 0 });
    // 3. Quote the same size: nothing owed, nothing to return. A second pay has nothing to write (exactly once by state).
    expect(await quote(r, 64)).toMatchObject({ owed: 0, take: null, back: null, balance: 6 });
    // 4. Quote a move down to 32: 2 credits come back, all bought.
    const down = await quote(r, 32);
    expect(down).toMatchObject({ owed: -2, take: null, back: { pack: 2, monthly: 0, forfeited: 0 }, balance: 6 });
    // The quote's `back` is what the REAL refund accepts.
    await rolledBack((tx) => refundForPackage(tx, { orgId: r.orgId, packageId: r.packageId, pack: down.back!.pack, monthly: down.back!.monthly, size: 16 }));
    // 5. Move down for real (Task 5's shape: the refund rows and the row, together).
    await inTx(async (tx) => {
      await refundForPackage(tx, { orgId: r.orgId, packageId: r.packageId, pack: 2, monthly: 0, size: 16 });
      await tx`update division_online_packages set size = 32, credits_refunded = 2 where id = ${r.packageId}`;
    });
    expect(await creditBalance(sql, r.orgId), "8 held after the 2 came back").toBe(8);
    // 6. Quote again: the row now holds a 32, so 32 owes nothing and 16 returns 1 more, 64 owes the 2 back again.
    expect(await quote(r, 32)).toMatchObject({ owed: 0, take: null, back: null, balance: 8 });
    expect(await quote(r, 16)).toMatchObject({ owed: -1, back: { pack: 1, monthly: 0, forfeited: 0 } });
    expect(await quote(r, 64)).toMatchObject({ owed: 2, take: { monthly: 0, pack: 2 } });
    expect(await quote(r, 128)).toMatchObject({ owed: 6, take: { monthly: 0, pack: 6 } });
    // 7. Move down again, to 16: the second return reads what the first already returned (pack 4 consumed − 2 refunded = 2 left).
    const again = await quote(r, 16);
    await inTx(async (tx) => {
      await refundForPackage(tx, { orgId: r.orgId, packageId: r.packageId, pack: again.back!.pack, monthly: again.back!.monthly, size: 16 });
      await tx`update division_online_packages set size = 16, credits_refunded = 3 where id = ${r.packageId}`;
    });
    expect(await quote(r, 16)).toMatchObject({ owed: 0, balance: 9 });
    expect(await quote(r, 32)).toMatchObject({ owed: 1, take: { monthly: 0, pack: 1 } });
  });

  it("a quote across the month boundary: paid from last month's included credits, a move down forfeits what the month took with it", async () => {
    // 128 costs 8: this month's 3 included + 5 bought (P4 spends the included credits first). Then the month turns: the
    // 3 included credits are an earlier month's.
    const orgId = await seedOrg();
    await grantMonthlyStreamCredits(orgId, 3, DB_NOW);
    await buy(orgId, 5);
    const division = await seedDivision(orgId);
    const packageId = await seedPackage(orgId, division, 128);
    const rg: Rig = { orgId, divisionId: division.id, division, packageId, rate: 0 };
    expect(await pay(rg, 8, 3), "premise: paid from both buckets").toEqual({ monthly: 3, pack: 5 });
    await settlePackage(packageId, { size: 128, cameras: false, paid: 8, refunded: 0, forfeited: 0 });
    // Same month: every credit is returnable, the included ones from this month first after the bought ones.
    expect(await quote(rg, 64, { rate: 3 })).toMatchObject({ owed: -4, back: { pack: 4, monthly: 0, forfeited: 0 } });
    expect(await quote(rg, 16, { rate: 3 })).toMatchObject({ owed: -7, back: { pack: 5, monthly: 2, forfeited: 0 } });
    // The month turns.
    await backdateOrgLedger(orgId);
    // D = 4 (to 64): bought credits first, all 4 of them. D = 6 (to 32): 5 bought, then the included credit is from an
    // earlier month and is forfeited, counted and not returned. D = 7 (to 16): 5 bought, 2 forfeited.
    const cases: [OnlineSize, number, { pack: number; monthly: number; forfeited: number }][] = [
      [64, -4, { pack: 4, monthly: 0, forfeited: 0 }],
      [32, -6, { pack: 5, monthly: 0, forfeited: 1 }],
      [16, -7, { pack: 5, monthly: 0, forfeited: 2 }],
    ];
    for (const [size, owed, back] of cases) {
      const q = await quote(rg, size, { rate: 3 });
      expect(q, `to ${size}`).toMatchObject({ owed, back });
      // The quote's `back` is what the real refund writes: it accepts the returned parts (the forfeited part is never written).
      await rolledBack((tx) => refundForPackage(tx, { orgId, packageId, pack: q.back!.pack, monthly: q.back!.monthly, size: 16 }));
      // ...and refuses one included credit more than the quote returned (an earlier month's credit cannot come back through it).
      await expect(
        rolledBack((tx) => refundForPackage(tx, { orgId, packageId, pack: q.back!.pack, monthly: q.back!.monthly + 1, size: 16 })),
        `to ${size}: one included credit more`,
      ).rejects.toMatchObject({ status: 500, code: "online_package_return_exceeds_debit" });
    }
    // Applying the move down to 32 records its forfeit on the row; the NEXT move down does not forfeit it again.
    await inTx(async (tx) => {
      await refundForPackage(tx, { orgId, packageId, pack: 5, monthly: 0, size: 16 });
      await tx`update division_online_packages set size = 32, credits_refunded = 5, credits_forfeited = 1 where id = ${packageId}`;
    });
    expect(await quote(rg, 16, { rate: 3 })).toMatchObject({ owed: -1, back: { pack: 0, monthly: 0, forfeited: 1 } });
    expect(await quote(rg, 32, { rate: 3 })).toMatchObject({ owed: 0, back: null });
  });

  it("forfeits already recorded on the row are not forfeited twice: a move down the unforfeited credits cannot cover refuses by name", async () => {
    // Paid 64 (4 credits) wholly from last month's included credits; a move down to 16 needs 3 of them.
    const orgId = await seedOrg();
    await grantMonthlyStreamCredits(orgId, 4, DB_NOW);
    const division = await seedDivision(orgId);
    const packageId = await seedPackage(orgId, division, 64);
    const r: Rig = { orgId, divisionId: division.id, division, packageId, rate: 0 };
    await pay(r, 4, 4);
    await settlePackage(packageId, { size: 64, cameras: false, paid: 4, refunded: 0, forfeited: 0 });
    await backdateOrgLedger(orgId);
    // The row has forfeited f of the 4 already (the size is left at 64: the shape of a forfeit recorded twice). The ledger
    // still shows all 4 as an earlier month's consume, so only the NETTING tells how many are left to forfeit: 4 − f. A move
    // down to 16 forfeits 3: answered while 3 are left (f = 0, 1), refused by name when fewer are (f = 2, 3, 4) — without
    // the netting it would answer `forfeited: 3` again, and the package would have forfeited more than it was paid.
    let answered = 0;
    let refused = 0;
    for (const forfeited of [0, 1, 2, 3, 4]) {
      await sql`update division_online_packages set credits_forfeited = ${forfeited} where id = ${packageId}`;
      if (4 - forfeited >= 3) {
        expect(await quote(r, 16, { rate: 4 }), `forfeited ${forfeited}`).toMatchObject({ owed: -3, back: { pack: 0, monthly: 0, forfeited: 3 } });
        answered += 1;
      } else {
        await expect(quote(r, 16, { rate: 4 }), `forfeited ${forfeited}`).rejects.toMatchObject({ status: 500, code: "online_package_return_exceeds_debit" });
        refused += 1;
      }
    }
    expect([answered, refused], "both halves of the sweep ran").toEqual([2, 3]);
  });

  it("forfeits already recorded: more forfeited than the ledger has expired is refused by name", async () => {
    // Paid 64 from THIS month's included credits (none expired), yet the row says 2 were forfeited: nothing can have been.
    const orgId = await seedOrg();
    await grantMonthlyStreamCredits(orgId, 4, DB_NOW);
    const division = await seedDivision(orgId);
    const packageId = await seedPackage(orgId, division, 64);
    const r: Rig = { orgId, divisionId: division.id, division, packageId, rate: 0 };
    await pay(r, 4, 4);
    await settlePackage(packageId, { size: 64, cameras: false, paid: 4, refunded: 0, forfeited: 2 });
    await expect(quote(r, 16, { rate: 4 })).rejects.toMatchObject({ status: 500, code: "online_package_forfeited_exceeds_expired" });
    // The same row without the impossible forfeits quotes: 3 come back from this month's included credits.
    await sql`update division_online_packages set credits_forfeited = 0 where id = ${packageId}`;
    expect(await quote(r, 16, { rate: 4 })).toMatchObject({ owed: -3, back: { pack: 0, monthly: 3, forfeited: 0 } });
  });

  it("after a full refund the package is history: the division quotes as unpaid again, owing the whole price (a refunded row is never live)", async () => {
    const r = await paidRig({ size: 64, cameras: false, pack: 10 });
    expect(await quote(r, 64), "premise: paid, nothing owed").toMatchObject({ owed: 0, refusal: null });
    // Task 6's full refund: the rows come back and the row records it, together.
    await inTx(async (tx) => {
      await refundForPackage(tx, { orgId: r.orgId, packageId: r.packageId, pack: 4, monthly: 0, size: 16 });
      await tx`update division_online_packages set credits_refunded = 4, refunded_at = now() where id = ${r.packageId}`;
    });
    expect(await creditBalance(sql, r.orgId)).toBe(10);
    // No live row: 64 is a fresh purchase of 4, not "nothing owed"; 16 is a fresh purchase of 1, not a move down.
    expect(await quote(r, 64)).toMatchObject({ owed: 4, take: { monthly: 0, pack: 4 }, back: null, balance: 10, refusal: null });
    expect(await quote(r, 16)).toMatchObject({ owed: 1, take: { monthly: 0, pack: 1 }, back: null });
  });

  it("an empty division: no stages, nobody held, no row — the smallest size quotes cleanly", async () => {
    const orgId = await seedOrg();
    await buy(orgId, 3);
    const division = await seedDivision(orgId);
    const r: Rig = { orgId, divisionId: division.id, division, packageId: "", rate: 0 };
    // Facts of an empty division: sizeFor(0) is 16, so the smallest size holds it, and 0 rounds fit anything.
    expect(await quote(r, 16)).toMatchObject({ size: 16, cameras: false, price: 1, owed: 1, take: { monthly: 0, pack: 1 }, held: 0, rounds: 0, refusal: null });
  });

  it("held = size exactly is not refused, at every size", async () => {
    const r = await rig({ pack: 100 });
    for (const size of ONLINE_SIZES) expect((await quote(r, size, { facts: { held: size } })).refusal, `held ${size} on ${size}`).toBeNull();
  });
});

// ─── covers (spec §7.6: the gate's question) ──────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("quoteLocked: covers — the paid package covers the division as it stands (held, rounds and cameras ONLY)", () => {
  it("covers sweep: every paid size × cameras paid × held × rounds × camera policy, asked at the row's own size and at another size", async () => {
    let checked = 0;
    let covered = 0;
    let uncovered = 0;
    for (const size of ONLINE_SIZES) {
      for (const camerasPaid of [false, true]) {
        const r = await paidRig({ size, cameras: camerasPaid, pack: 100 });
        const other: OnlineSize = size === 16 ? 32 : 16;
        for (const held of [0, size, size + 1]) {
          for (const rounds of [0, INCLUDED[size], INCLUDED[size] + 1, MOST_ROUNDS + 1]) {
            for (const policy of [false, true]) {
              // Spec §7.6: "the row must be paid AND cover the places held, the counted rounds and the cameras".
              const want = held <= size && rounds <= INCLUDED[size] && (camerasPaid || !policy);
              for (const asked of [size, other]) {
                const q = await quote(r, asked, { facts: { held, rounds, cameras: policy } });
                expect(q.covers, `paid ${size}/${camerasPaid} asked ${asked}; held ${held}, rounds ${rounds}, policy cameras ${policy}`).toBe(want);
                checked += 1;
                if (q.covers) covered += 1;
                else uncovered += 1;
              }
            }
          }
        }
      }
    }
    expect(checked, "cases judged").toBe(5 * 2 * 3 * 4 * 2 * 2);
    expect(covered, "covered cases").toBeGreaterThan(50);
    expect(uncovered, "uncovered cases").toBeGreaterThan(50);
  });

  it("a plan downgrade does not break covers: a paid organiser can still open round 1 (the refusal says `plan`, covers stays true)", async () => {
    const r = await paidRig({ size: 64, cameras: false, pack: 10 });
    // The plan now caps at 32: asking for 64 is refused for the PLAN, and the package still covers 20 held and 8 rounds.
    const down = await quote(r, 64, { facts: { planCap: 32, held: 20, rounds: 8 } });
    expect(down).toMatchObject({ refusal: "plan", owed: 0, take: null, back: null, covers: true });
    // The refusal order puts `plan` before the rounds refusals, so the refusal alone would hide an uncovered package: 9 rounds
    // do not fit a 64's 8, and covers says so while the refusal still reads `plan`.
    const masked = await quote(r, 64, { facts: { planCap: 32, held: 20, rounds: 9 } });
    expect(masked).toMatchObject({ refusal: "plan", covers: false });
    const maskedHeld = await quote(r, 64, { facts: { planCap: 16, held: 65, rounds: 0 } });
    expect(maskedHeld).toMatchObject({ refusal: "below_held", covers: false });
    // The same package without the downgrade.
    expect(await quote(r, 64, { facts: { held: 20, rounds: 8 } })).toMatchObject({ refusal: null, covers: true });
  });

  it("covers is a fact about the PACKAGE, not about the size asked: the intent addCameras raises what is owed and never uncovers", async () => {
    const r = await paidRig({ size: 64, cameras: false, pack: 20 });
    // Asking to add cameras at its own size owes 4, and the package still covers a division whose policy needs none.
    expect(await quote(r, 64, { addCameras: true })).toMatchObject({ owed: 4, covers: true });
    // A policy that now needs cameras the package has not paid: not covered, and nothing but the cameras is missing.
    expect(await quote(r, 64, { facts: { cameras: true } })).toMatchObject({ owed: 4, refusal: null, covers: false });
    // Cameras paid: the policy on or off, the package covers.
    const withCams = await paidRig({ size: 64, cameras: true, pack: 20 });
    for (const policy of [false, true]) expect(await quote(withCams, 64, { facts: { cameras: policy } }), `policy ${policy}`).toMatchObject({ covers: true });
  });

  it("covers is false without a paid live package: unpaid, no row, refunded, grandfathered-frozen and frozen", async () => {
    // Unpaid, with the money to pay it.
    const unpaid = await rig({ pack: 100, size: 64 });
    expect(await quote(unpaid, 64)).toMatchObject({ owed: 4, refusal: null, covers: false });
    // No row at all.
    const orgId = await seedOrg();
    const division = await seedDivision(orgId);
    expect(await quote({ orgId, divisionId: division.id, division, packageId: "", rate: 0 }, 64)).toMatchObject({ covers: false });
    // A full refund leaves history, not a package.
    const refunded = await paidRig({ size: 64, cameras: false, pack: 10 });
    await inTx(async (tx) => {
      await refundForPackage(tx, { orgId: refunded.orgId, packageId: refunded.packageId, pack: 4, monthly: 0, size: 16 });
      await tx`update division_online_packages set credits_refunded = 4, refunded_at = now() where id = ${refunded.packageId}`;
    });
    expect(await quote(refunded, 64)).toMatchObject({ covers: false });
    // The backfill's grandfathered row (frozen, unpaid) and a paid row that has opened a round: frozen is not covered.
    const old = await rig({ pack: 100, size: 256 });
    await sql`update division_online_packages set frozen_at = created_at where id = ${old.packageId}`;
    expect(await quote(old, 256)).toMatchObject({ refusal: "frozen", covers: false });
    const frozen = await paidRig({ size: 64, cameras: false, pack: 10 });
    await sql`update division_online_packages set frozen_at = now() where id = ${frozen.packageId}`;
    expect(await quote(frozen, 64)).toMatchObject({ refusal: "frozen", covers: false });
    // The premise that the false answers above are the guards': the same paid package, unfrozen, covers.
    const live = await paidRig({ size: 64, cameras: false, pack: 10 });
    expect(await quote(live, 64)).toMatchObject({ refusal: null, covers: true });
  });
});

// ─── monthlyExpiresOn ─────────────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("monthlyExpiresOn", () => {
  it("monthlyExpiresOn is the DATABASE's month, not the JS clock's: the last day of the UTC month of the transaction's now()", async () => {
    const r = await rig({ pack: 5 });
    const dbMonthEnd = async () =>
      (await sql<{ d: string }[]>`
        select to_char((date_trunc('month', now() at time zone 'UTC') + interval '1 month' - interval '1 day'), 'YYYY-MM-DD') as d`)[0]!.d;
    const before = await dbMonthEnd();
    const real = await quote(r, 16);
    expect([before, await dbMonthEnd()], "the quote's date is the database month's last day").toContain(real.monthlyExpiresOn);
    // A JS clock years away says nothing: only Date is faked, the database's `now()` is untouched.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2020-01-15T12:00:00Z"));
      const skewed = await quote(r, 16);
      expect(new Date().getUTCFullYear(), "premise: the JS clock is skewed").toBe(2020);
      expect([before, await dbMonthEnd()], "a skewed JS clock changes nothing").toContain(skewed.monthlyExpiresOn);
      expect(skewed.monthlyExpiresOn).not.toBe("2020-01-31");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── onlinePackageQuote ───────────────────────────────────────────────────────────────────────────────────────────────

const authFor = (orgId: string, via: AuthCtx["via"] = "session"): AuthCtx => ({ orgId, via, userId: PAYER, role: "owner", keyId: null });

async function seedEntrant(orgId: string, divisionId: string, status = "registered"): Promise<void> {
  await sql`
    insert into entrants (division_id, org_id, kind, display_name, status)
    values (${divisionId}, ${orgId}, 'individual', ${"P " + suffix()}, ${status})`;
}

describe.skipIf(!HAS_DB)("onlinePackageQuote: the read the price line and the receipt make", () => {
  it("derives every fact from the division itself: cameras from the policy, rounds from the Swiss stages, held from the live entrants, the plan cap from the plan", async () => {
    const r = await rig({ pack: 50, size: 64, division: { competition: "required", division: null } });
    await seedStage(r.orgId, r.divisionId, "swiss", { rounds: 5 });
    await seedStage(r.orgId, r.divisionId, "swiss", { rounds: 3 });
    await seedStage(r.orgId, r.divisionId, "knockout", {});
    for (let i = 0; i < 3; i += 1) await seedEntrant(r.orgId, r.divisionId);
    await seedEntrant(r.orgId, r.divisionId, "withdrawn"); // a withdrawn entrant holds no place
    const rate = (await sql<{ v: number | null }[]>`
      select int_value as v from plan_entitlements where plan_key = 'community' and feature_key = 'streaming.credits.monthly'`)[0]!.v!;
    expect(rate, "premise: the community plan grants included credits").toBeGreaterThan(0);

    const q = await onlinePackageQuote(authFor(r.orgId), r.divisionId, 64);
    // Swiss 5 + Swiss 3 = 8 rounds, which a 64 includes exactly; 3 held; competition required → with cameras (8 credits at 64).
    expect(q).toMatchObject({ size: 64, cameras: true, price: 8, owed: 8, held: 3, rounds: 8, refusal: null });
    // The balance is the 50 bought plus this month's grant, which the debit would write first and the quote has only projected.
    expect(q.balance).toBe(50 + rate);
    expect(q.take).toEqual({ monthly: rate, pack: 8 - rate });
    expect(q.monthlyExpiresOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // A size whose included rounds are below the counted ones: refused for rounds, with the counts the screen needs.
    expect(await onlinePackageQuote(authFor(r.orgId), r.divisionId, 32)).toMatchObject({ refusal: "rounds", rounds: 8, held: 3 });
    // The plan: the size the community plan's cap does not allow (the entitlement table is the authority, read here directly).
    const cap = await getLimit(r.orgId, "entrants.per_division.max", r.division.competitionId);
    const blocked = ONLINE_SIZES.filter((s) => !oraclePlanAllows(s, cap));
    expect(blocked.length, `premise: the community plan's cap (${cap}) refuses some size, or the plan refusal is unreached`).toBeGreaterThan(0);
    for (const size of blocked) {
      expect((await onlinePackageQuote(authFor(r.orgId), r.divisionId, size)).refusal, `size ${size}, plan cap ${cap}`).toBe("plan");
    }
  });

  it("a quote writes and locks nothing: no row, no grant, no advisory lock, no lock on the package row", async () => {
    const r = await rig({ pack: 10, size: 32 });
    const ledgerBefore = await ledgerCount(r.orgId);
    const [pkgBefore] = await sql`select * from division_online_packages where id = ${r.packageId}`;
    const mark = statementTexts().length;
    const q = await onlinePackageQuote(authFor(r.orgId), r.divisionId, 32);
    const issued = statementTexts().slice(mark);
    expect(q.refusal).toBeNull();
    expect(issued.length, "anti-vacuity: the census saw the quote's statements").toBeGreaterThan(3);
    for (const text of issued) {
      expect(text, "a statement of a read-only quote").not.toMatch(/\b(insert|update|delete)\b|pg_advisory|\bfor\s+(update|share|no key update)\b/i);
    }
    // The read runs in a READ-ONLY transaction, so even a write that slipped in could not land (the database refuses it).
    expect(issued.filter((t) => /^begin read only$/i.test(t.trim())).length, "one read-only transaction").toBe(1);
    expect(await ledgerCount(r.orgId), "no grant was written for the unrolled month").toBe(ledgerBefore);
    const [pkgAfter] = await sql`select * from division_online_packages where id = ${r.packageId}`;
    expect(pkgAfter).toEqual(pkgBefore);
  });

  it("who may ask: a division of another org is a 404, an unknown division is a 404, a device link and a Match Day code are 403", async () => {
    const mine = await rig({ pack: 5 });
    const theirs = await rig({ pack: 5 });
    await expect(onlinePackageQuote(authFor(mine.orgId), theirs.divisionId, 16)).rejects.toMatchObject({ status: 404 });
    await expect(onlinePackageQuote(authFor(mine.orgId), randomUUID(), 16)).rejects.toMatchObject({ status: 404 });
    for (const via of ["device_link", "match_day_code"] as const) {
      await expect(onlinePackageQuote(authFor(mine.orgId, via), mine.divisionId, 16), via).rejects.toMatchObject({ status: 403 });
    }
    // The same person asking for their own division is answered (the premise that the refusals above are the guards').
    expect((await onlinePackageQuote(authFor(mine.orgId), mine.divisionId, 16)).size).toBe(16);
  });

  it("a paid, frozen package answers `frozen` on the read too, and addCameras rides through", async () => {
    const paid = await paidRig({ size: 32, cameras: false, pack: 10 });
    expect(await onlinePackageQuote(authFor(paid.orgId), paid.divisionId, 32, true)).toMatchObject({ cameras: true, price: 4, owed: 2 });
    await sql`update division_online_packages set frozen_at = now() where id = ${paid.packageId}`;
    expect((await onlinePackageQuote(authFor(paid.orgId), paid.divisionId, 64)).refusal).toBe("frozen");
  });
});
