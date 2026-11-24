// Which divisions of a competition still owe their Online Chess package (spec 2026-11-23-online-chess-credits-design.md §8.8 "Step 1b"; plan
// Task 12): the competition page's "Not paid" flag is drawn from this ONE read. Runs against a REAL migrated database through the real create, pay
// and delete doors, and is skipped without DATABASE_URL. Expected membership comes from what the test DID to each division (it created it online,
// paid it, froze it, switched it off), never from the query.
//
// single-sport: Online Chess is boardgame only (online-play.ts); the other-sport case is the pair that proves a non-chess division is never listed.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posthog-server")>();
  return { ...actual, isServerFeatureEnabled: vi.fn(async () => false) };
});

import { sql } from "@/lib/db";
import { createDivision, patchDivision } from "@/server/usecases/divisions";
import { forgetOnlineChessFlagCache } from "@/server/usecases/external-play/online-chess-flag";
import { listUnpaidOnlineDivisions } from "../unpaid";
import { buy, expectLeafPrices, freeze, freezeGrandfathered, liveOf, ocCompetition, ocDivision, ocOrg, pay, spendTheMonth, suffix } from "./_oc-rig";

const HAS_DB = !!process.env.DATABASE_URL;
const ALWAYS = process.env.ONLINE_CHESS_ALWAYS;

beforeAll(() => {
  if (!HAS_DB) return;
  process.env.ONLINE_CHESS_ALWAYS = "1";
  forgetOnlineChessFlagCache();
  expectLeafPrices();
});
afterAll(async () => {
  if (ALWAYS === undefined) delete process.env.ONLINE_CHESS_ALWAYS;
  else process.env.ONLINE_CHESS_ALWAYS = ALWAYS;
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

describe.skipIf(!HAS_DB)("listUnpaidOnlineDivisions: the divisions that still owe their package", () => {
  it("the empty case first: a competition with no division, and one with only an offline division, lists nothing", async () => {
    const o = await ocOrg();
    const empty = await ocCompetition(o);
    expect([...(await listUnpaidOnlineDivisions({ orgId: o.orgId, competitionId: empty }))]).toEqual([]);
    const offline = await ocCompetition(o);
    await ocDivision(o, offline, { online: false });
    expect([...(await listUnpaidOnlineDivisions({ orgId: o.orgId, competitionId: offline }))]).toEqual([]);
  });

  it("lists exactly the unpaid online ones: paid, frozen and grandfathered are not owed (the sequence: pay it, and it leaves the list)", async () => {
    const o = await ocOrg();
    await spendTheMonth(o.orgId, 0);
    await buy(o.orgId, 20);
    const competition = await ocCompetition(o);
    const unpaidA = await ocDivision(o, competition);
    const unpaidB = await ocDivision(o, competition);
    const paid = await ocDivision(o, competition);
    const frozenPaid = await ocDivision(o, competition);
    const grandfathered = await ocDivision(o, competition);
    await pay(o, paid.id, 16);
    await pay(o, frozenPaid.id, 16);
    await freeze((await liveOf(frozenPaid.id)).id);
    await freezeGrandfathered((await liveOf(grandfathered.id)).id);

    const listed = await listUnpaidOnlineDivisions({ orgId: o.orgId, competitionId: competition });
    expect([...listed].sort()).toEqual([unpaidA.id, unpaidB.id].sort());
    expect(listed.size, "anti-vacuity: two owed out of five").toBe(2);

    await pay(o, unpaidA.id, 16);
    const after = await listUnpaidOnlineDivisions({ orgId: o.orgId, competitionId: competition });
    expect([...after]).toEqual([unpaidB.id]);
  });

  it("a division switched off online play leaves the list (its unpaid row is deleted); switched back on, it returns", async () => {
    const o = await ocOrg();
    const competition = await ocCompetition(o);
    const d = await ocDivision(o, competition);
    expect([...(await listUnpaidOnlineDivisions({ orgId: o.orgId, competitionId: competition }))]).toEqual([d.id]);
    await patchDivision(o.auth, d.id, { config: { variant: "classical", onlinePlay: "off", clock: { base: 600, increment: 5 } } });
    expect([...(await listUnpaidOnlineDivisions({ orgId: o.orgId, competitionId: competition }))]).toEqual([]);
    await patchDivision(o.auth, d.id, { config: { variant: "classical", onlinePlay: "lichess", clock: { base: 600, increment: 5 } } });
    expect([...(await listUnpaidOnlineDivisions({ orgId: o.orgId, competitionId: competition }))]).toEqual([d.id]);
  });

  it("is scoped to the ONE competition and the ONE organisation it is asked for", async () => {
    const a = await ocOrg();
    const b = await ocOrg();
    const compA1 = await ocCompetition(a);
    const compA2 = await ocCompetition(a);
    const compB = await ocCompetition(b);
    const dA1 = await ocDivision(a, compA1);
    const dA2 = await ocDivision(a, compA2);
    const dB = await ocDivision(b, compB);
    expect([...(await listUnpaidOnlineDivisions({ orgId: a.orgId, competitionId: compA1 }))]).toEqual([dA1.id]);
    expect([...(await listUnpaidOnlineDivisions({ orgId: a.orgId, competitionId: compA2 }))]).toEqual([dA2.id]);
    expect([...(await listUnpaidOnlineDivisions({ orgId: b.orgId, competitionId: compB }))]).toEqual([dB.id]);
    expect([...(await listUnpaidOnlineDivisions({ orgId: b.orgId, competitionId: compA1 }))], "another org's competition id names nothing of theirs").toEqual([]);
    expect([...(await listUnpaidOnlineDivisions({ orgId: a.orgId, competitionId: compB }))]).toEqual([]);
  });

  it("another sport (generic) is never listed, whatever its config says (the pair: the chess division beside it is)", async () => {
    const o = await ocOrg();
    const competition = await ocCompetition(o);
    const chess = await ocDivision(o, competition);
    await createDivision(o.auth, competition, { name: `Generic ${suffix()}`, sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false } });
    expect([...(await listUnpaidOnlineDivisions({ orgId: o.orgId, competitionId: competition }))]).toEqual([chess.id]);
  });

  // The three guards below the package row's own state are NOT redundant with the doors that write the row (a package row exists only for a chess
  // division that plays online), so each is reached by writing the stale state the doors refuse - a mutant that drops one is killed here.
  it("a stale unpaid row on a division that no longer plays online, or that is not a chess division, is not owed (each guard on its own)", async () => {
    const o = await ocOrg();
    const competition = await ocCompetition(o);
    const online = await ocDivision(o, competition);
    const stale = await ocDivision(o, competition);
    expect([...(await listUnpaidOnlineDivisions({ orgId: o.orgId, competitionId: competition }))].sort(), "premise: both owe").toEqual([online.id, stale.id].sort());
    // Online play off by hand, the row left: the package says "owes", the division says it does not play online.
    await sql`update divisions set config = config || '{"onlinePlay":"off"}'::jsonb where id = ${stale.id}`;
    expect([...(await listUnpaidOnlineDivisions({ orgId: o.orgId, competitionId: competition }))], "the division does not play online").toEqual([online.id]);
    // The same, with the sport changed instead: still online-configured, no longer chess.
    await sql`update divisions set config = config || '{"onlinePlay":"lichess"}'::jsonb where id = ${stale.id}`;
    expect([...(await listUnpaidOnlineDivisions({ orgId: o.orgId, competitionId: competition }))].sort(), "premise: it owes again").toEqual([online.id, stale.id].sort());
    await sql`update divisions set sport_key = 'generic' where id = ${stale.id}`;
    expect([...(await listUnpaidOnlineDivisions({ orgId: o.orgId, competitionId: competition }))], "it is not a chess division").toEqual([online.id]);
  });

  it("a refunded package is history, never owed (the schema refuses a refunded row that was not paid, so the pay-then-switch-off path is the one that reaches it)", async () => {
    const o = await ocOrg();
    await spendTheMonth(o.orgId, 0);
    await buy(o.orgId, 5);
    const competition = await ocCompetition(o);
    const d = await ocDivision(o, competition);
    await pay(o, d.id, 16);
    await patchDivision(o.auth, d.id, { config: { variant: "classical", onlinePlay: "off", clock: { base: 600, increment: 5 } } }); // the paid package is refunded
    const [refunded] = await sql<{ n: number }[]>`select count(*)::int as n from division_online_packages where division_id = ${d.id} and refunded_at is not null`;
    expect(refunded!.n, "premise: the refund left a history row").toBe(1);
    await patchDivision(o.auth, d.id, { config: { variant: "classical", onlinePlay: "lichess", clock: { base: 600, increment: 5 } } });
    expect([...(await listUnpaidOnlineDivisions({ orgId: o.orgId, competitionId: competition }))], "back on: one new unpaid row, listed once").toEqual([d.id]);
  });
});
