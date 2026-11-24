// Swiss rounds are priced before round 1 (spec 2026-11-23-online-chess-credits-design.md §3 decision 2, §7.6 "Swiss Generate and
// rounds save", P1, P10, P11, P15; plan Task 8): while the division's live package is unfrozen, the Swiss rounds its stages declare
// must fit the size's included rounds — at every door that DECLARES a count (the stage save and the Format dialog's replace, the
// rounds edit, Add a round) and at Generate, which mints the rounds. Once the package freezes (a round opened) nothing asks: a round
// added mid-event is free (owner ruling). REAL doors against a REAL database (skipped without DATABASE_URL).
//
// Where the expected numbers come from — never from the leaf's helpers or the gate:
//   * P1 / Global Constraints type the rounds each size includes: 16 → 6, 32 → 7, 64 → 8, 128 → 9, 256 → 10, and the next size
//     that covers one round more (7 → 32, 8 → 64, 9 → 128, 10 → 256, 11 → none: ONLINE_ROUNDS_ABOVE_MAX);
//   * P15: the counted rounds are the SUM over the division's Swiss stages (4 + 3 = 7), never the edited stage alone.
//
// single-sport: Online Chess is boardgame only; the other-sport case is a division that is not online (no package, no gate).
//
// Mutant table (each run once by hand; results in the commit message):
//   R1 the rounds gate removed from the rounds edit (patchSwissStage)        -> the edit sweep
//   R2 the gate removed from the stage batch (insertStageBatch)              -> the batch refusals
//   R3 the gate removed from Add a round                                      -> "Add a round"
//   R4 the gate removed from Generate (swissGen's mint)                       -> "Generate mints the rounds a stage declares"
//   R5 the frozen skip dropped from assertRoundsFit (the one authority)        -> every "not gated once frozen" cell, "called directly"
//   R6 the limit read as `>=` (the included rounds themselves refused)        -> the boundary of every size
//   R7 only the edited stage counted (the others' rounds dropped)             -> "two Swiss stages sum"
//   R8 a re-send of the stored count is asked                                 -> "a legacy division over budget"
//   R9 a batch without a Swiss stage is asked                                 -> "a legacy division over budget" (the knockout add)
//   R10 the ABOVE_MAX arm dropped (11 on any size reads as NEED_SIZE)         -> the top size, the brief's pair
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posthog-server")>();
  return { ...actual, isServerFeatureEnabled: vi.fn(async () => false) };
});

import { sql } from "@/lib/db";
import { ONLINE_PACKAGE_CODES, ONLINE_SIZES, type OnlineSize } from "@/lib/online-chess-package";
import { patchDivision } from "@/server/usecases/divisions";
import { forgetOnlineChessFlagCache } from "@/server/usecases/external-play/online-chess-flag";
import { createStages, generateStageFixtures, replaceStages } from "@/server/usecases/stages";
import { addSwissRound, patchSwissStage } from "@/server/usecases/swiss-rounds-admin";
import { assertOnlineFormat, assertRoundsFit } from "@/server/usecases/online-package/format";
import { livePackage } from "@/server/usecases/online-package/read";
import {
  buy, freeze, freezeGrandfathered, liveOf, ocCompetition, ocDivision, ocOrg, pay, refusal, seedEntrants, seedStageKind, spendTheMonth, type Org,
} from "./_oc-rig";

const HAS_DB = !!process.env.DATABASE_URL;
const ALWAYS = process.env.ONLINE_CHESS_ALWAYS;

/** P1, typed from the spec: the Swiss rounds each size includes. */
const INCLUDED: Record<OnlineSize, number> = { 16: 6, 32: 7, 64: 8, 128: 9, 256: 10 };
/** The smallest size that covers one round more than `INCLUDED[size]` — null above the top size (P10). */
const NEXT_FOR_ONE_MORE: Record<OnlineSize, OnlineSize | null> = { 16: 32, 32: 64, 64: 128, 128: 256, 256: null };

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.ONLINE_CHESS_ALWAYS = "1";
  forgetOnlineChessFlagCache();
});
afterAll(async () => {
  if (ALWAYS === undefined) delete process.env.ONLINE_CHESS_ALWAYS;
  else process.env.ONLINE_CHESS_ALWAYS = ALWAYS;
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

const swissAt = (seq: number, rounds: number) => ({ seq, kind: "swiss", name: `Swiss ${seq}`, config: { rounds } });
const roundsOf = async (stageId: string) => (await sql<{ r: number }[]>`select (config->>'rounds')::int as r from stages where id = ${stageId}`)[0]!.r;
const fixtureCount = async (stageId: string) => (await sql<{ n: number }[]>`select count(*)::int as n from fixtures where stage_id = ${stageId}`)[0]!.n;
const shape = (e: { status: number; code?: string; extra?: Record<string, unknown> }) => ({ status: e.status, code: e.code, extra: e.extra });

const needSize = (nextSize: OnlineSize) => ({ status: 422, code: ONLINE_PACKAGE_CODES.roundsNeedSize, extra: { nextSize } });

/** An online division at `size` holding one Swiss stage of `rounds`, made through the real doors. */
async function onlineWithSwiss(o: Org, size: OnlineSize, rounds: number): Promise<{ divisionId: string; stageId: string; packageId: string }> {
  const d = await ocDivision(o, await ocCompetition(o), { size });
  const [stage] = await createStages(o.auth, d.id, [swissAt(1, rounds)] as never);
  return { divisionId: d.id, stageId: stage!.id, packageId: (await liveOf(d.id)).id };
}

describe.skipIf(!HAS_DB)("the rounds edit (PATCH /stages/{id}) against every size", () => {
  it("each size takes the rounds it includes and refuses one more with the next size that covers it; the top size refuses 11 outright", async () => {
    const o = await ocOrg();
    expect(Object.keys(INCLUDED).map(Number).sort((a, b) => a - b), "premise: the spec's table covers the ladder").toEqual([...ONLINE_SIZES]);
    let checked = 0;
    for (const size of ONLINE_SIZES) {
      const { stageId, divisionId } = await onlineWithSwiss(o, size, 1);
      await patchSwissStage(o.auth, stageId, { rounds: INCLUDED[size] });
      expect(await roundsOf(stageId), `${size}: ${INCLUDED[size]} rounds fit`).toBe(INCLUDED[size]);
      const err = await refusal(patchSwissStage(o.auth, stageId, { rounds: INCLUDED[size] + 1 }));
      const next = NEXT_FOR_ONE_MORE[size];
      if (next === null) {
        expect(shape(err), `${size}: more than any size includes`).toEqual({ status: 422, code: ONLINE_PACKAGE_CODES.roundsAboveMax, extra: { rounds: 11 } });
      } else {
        expect(shape(err), `${size}: one more needs ${next}`).toEqual(needSize(next));
      }
      expect(await roundsOf(stageId), `${size}: the refused save moved nothing`).toBe(INCLUDED[size]);
      expect((await liveOf(divisionId)).size, `${size}: and the row is as it was`).toBe(size);
      checked += 2;
    }
    expect(checked, "cells judged: five sizes, two sides each").toBe(10);
  });

  it("the brief's pair: 16 unpaid with 7 rounds answers ONLINE_ROUNDS_NEED_SIZE {32}; 11 rounds answers ONLINE_ROUNDS_ABOVE_MAX", async () => {
    const o = await ocOrg();
    const { stageId } = await onlineWithSwiss(o, 16, 4);
    expect(shape(await refusal(patchSwissStage(o.auth, stageId, { rounds: 7 })))).toEqual(needSize(32));
    expect(shape(await refusal(patchSwissStage(o.auth, stageId, { rounds: 11 })))).toMatchObject({ status: 422, code: ONLINE_PACKAGE_CODES.roundsAboveMax });
    expect(await roundsOf(stageId), "nothing moved").toBe(4);
  });

  it("the sequence: refused, the size moves up (the strip's select), the same save goes through, and the next round past it is refused again", async () => {
    const o = await ocOrg();
    const { divisionId, stageId } = await onlineWithSwiss(o, 16, 4);
    await refusal(patchSwissStage(o.auth, stageId, { rounds: 7 }));
    await patchDivision(o.auth, divisionId, { online_size: 32 });
    await patchSwissStage(o.auth, stageId, { rounds: 7 });
    expect(await roundsOf(stageId)).toBe(7);
    expect(shape(await refusal(patchSwissStage(o.auth, stageId, { rounds: 8 })))).toEqual(needSize(64));
    // A re-send of the same count writes nothing and is never refused.
    await patchSwissStage(o.auth, stageId, { rounds: 7 });
    // Lowering is allowed and fits.
    await patchSwissStage(o.auth, stageId, { rounds: 5 });
    expect(await roundsOf(stageId)).toBe(5);
  });

  it("a PAID size is gated the same way (a paid 32 includes 7)", async () => {
    const o = await ocOrg();
    await spendTheMonth(o.orgId);
    await buy(o.orgId, 10);
    const { divisionId, stageId } = await onlineWithSwiss(o, 16, 4);
    await pay(o, divisionId, 32);
    expect((await liveOf(divisionId)).paid_at, "premise: paid").not.toBeNull();
    await patchSwissStage(o.auth, stageId, { rounds: 7 });
    expect(shape(await refusal(patchSwissStage(o.auth, stageId, { rounds: 8 })))).toEqual(needSize(64));
    expect(await roundsOf(stageId)).toBe(7);
  });

  it("two Swiss stages sum (P15): 4 + 2 fits 16's 6, and a third round on the second stage (4 + 3) does not", async () => {
    const o = await ocOrg();
    const d = await ocDivision(o, await ocCompetition(o), { size: 16 });
    const [a, b] = await createStages(o.auth, d.id, [swissAt(1, 4), swissAt(2, 2)] as never);
    expect(shape(await refusal(patchSwissStage(o.auth, b!.id, { rounds: 3 })))).toEqual(needSize(32));
    expect(await roundsOf(b!.id)).toBe(2);
    await patchSwissStage(o.auth, a!.id, { rounds: 4 }); // a re-send beside another stage: nothing
    // The same sum at the stage batch: a third stage of one round makes 4 + 2 + 1 = 7.
    const batch = await refusal(createStages(o.auth, d.id, [swissAt(3, 1)] as never));
    expect(shape(batch)).toEqual(needSize(32));
    const stages = await sql<{ n: number }[]>`select count(*)::int as n from stages where division_id = ${d.id}`;
    expect(stages[0]!.n, "the refused batch wrote nothing").toBe(2);
  });

  it("a division that is not online has no package and no gate: any count is saved", async () => {
    const o = await ocOrg();
    const d = await ocDivision(o, await ocCompetition(o), { online: false });
    const stageId = await seedStageKind(o.orgId, d.id, "swiss", { rounds: 3 });
    await patchSwissStage(o.auth, stageId, { rounds: 12 });
    expect(await roundsOf(stageId)).toBe(12);
  });
});

describe.skipIf(!HAS_DB)("a stage batch that declares Swiss rounds (createStages and the Format dialog's replaceStages)", () => {
  it("7 rounds on 16 are refused and write nothing; 6 are written; the replace refuses the same and keeps the stages it had", async () => {
    const o = await ocOrg();
    const d = await ocDivision(o, await ocCompetition(o), { size: 16 });
    expect(shape(await refusal(createStages(o.auth, d.id, [swissAt(1, 7)] as never)))).toEqual(needSize(32));
    expect(shape(await refusal(createStages(o.auth, d.id, [swissAt(1, 11)] as never)))).toMatchObject({ code: ONLINE_PACKAGE_CODES.roundsAboveMax });
    expect((await sql`select 1 from stages where division_id = ${d.id}`).length, "nothing written").toBe(0);
    const [ok] = await createStages(o.auth, d.id, [swissAt(1, 6)] as never);
    expect(await roundsOf(ok!.id)).toBe(6);

    const replaced = await refusal(replaceStages(o.auth, d.id, [swissAt(1, 7)] as never));
    expect(shape(replaced)).toEqual(needSize(32));
    expect(await roundsOf(ok!.id), "the replace rolled back: the six-round stage stands").toBe(6);
    await replaceStages(o.auth, d.id, [swissAt(1, 5)] as never);
    const after = await sql<{ r: number }[]>`select (config->>'rounds')::int as r from stages where division_id = ${d.id}`;
    expect(after.map((r) => r.r)).toEqual([5]);
  });

  it("a legacy division over budget (9 stored rounds on 16): a stage write that declares no Swiss rounds, and a colour-only edit, are unrelated and go through", async () => {
    const o = await ocOrg();
    const d = await ocDivision(o, await ocCompetition(o), { size: 16 });
    const stageId = await seedStageKind(o.orgId, d.id, "swiss", { rounds: 9 }); // written before the gate existed
    await createStages(o.auth, d.id, [{ seq: 2, kind: "knockout", name: "Finals", config: {} }] as never);
    await patchSwissStage(o.auth, stageId, { chess: true });
    expect(await roundsOf(stageId), "premise: still 9").toBe(9);
    await patchSwissStage(o.auth, stageId, { rounds: 9 }); // a re-send of the stored count writes nothing and is never asked
    expect(await roundsOf(stageId)).toBe(9);
    // A CHANGE of the count is judged on the count that results: 9 → 8 still does not fit 16.
    expect(shape(await refusal(patchSwissStage(o.auth, stageId, { rounds: 8 })))).toEqual(needSize(64));
    await patchSwissStage(o.auth, stageId, { rounds: 6 });
    expect(await roundsOf(stageId)).toBe(6);
  });
});

describe.skipIf(!HAS_DB)("Add a round", () => {
  it("unfrozen, the round past the size's included is refused; the size moves up and the same press works; frozen, it is free (P11)", async () => {
    const o = await ocOrg();
    const { divisionId, stageId, packageId } = await onlineWithSwiss(o, 16, 6);
    await seedEntrants(o.orgId, divisionId, 16);
    expect(shape(await refusal(addSwissRound(o.auth, stageId)))).toEqual(needSize(32));
    expect(await roundsOf(stageId), "the refused press moved nothing").toBe(6);

    await patchDivision(o.auth, divisionId, { online_size: 32 });
    expect((await addSwissRound(o.auth, stageId)).rounds, "32 includes 7").toBe(7);
    expect(shape(await refusal(addSwissRound(o.auth, stageId)))).toEqual(needSize(64));
    expect(await roundsOf(stageId)).toBe(7);

    await freezeGrandfathered(packageId); // the backfill's shape: frozen, never paid (a frozen unpaid row is otherwise refused by the schema)
    expect((await addSwissRound(o.auth, stageId)).rounds, "frozen: rounds added mid-event are free").toBe(8);
    expect((await addSwissRound(o.auth, stageId)).rounds, "and again").toBe(9);
    expect((await liveOf(divisionId)).size, "the size never moved").toBe(32);
  });
});

describe.skipIf(!HAS_DB)("Generate mints the rounds a stage declares", () => {
  it("a legacy stage of 7 rounds on an unpaid 16 is refused at Generate and writes no board; at 32 it mints; the first refusal left the stage as it was", async () => {
    const o = await ocOrg();
    const d = await ocDivision(o, await ocCompetition(o), { size: 16 });
    await seedEntrants(o.orgId, d.id, 16);
    const stageId = await seedStageKind(o.orgId, d.id, "swiss", { rounds: 7 }); // as a division written before the gate holds it
    expect(shape(await refusal(generateStageFixtures(o.auth, stageId)))).toEqual(needSize(32));
    expect(await fixtureCount(stageId), "the refused Generate wrote no board").toBe(0);

    await patchDivision(o.auth, d.id, { online_size: 32 });
    await generateStageFixtures(o.auth, stageId);
    expect(await fixtureCount(stageId), "at 32 the rounds are minted").toBeGreaterThan(0);
  });

  it("frozen, Generate is not asked: 9 rounds on a frozen 16 mint", async () => {
    const o = await ocOrg();
    const d = await ocDivision(o, await ocCompetition(o), { size: 16 });
    await seedEntrants(o.orgId, d.id, 16);
    const stageId = await seedStageKind(o.orgId, d.id, "swiss", { rounds: 9 });
    await freezeGrandfathered((await liveOf(d.id)).id);
    await generateStageFixtures(o.auth, stageId);
    expect(await fixtureCount(stageId)).toBeGreaterThan(0);
  });

  it("a division that is not online is never asked: 9 rounds mint", async () => {
    const o = await ocOrg();
    const d = await ocDivision(o, await ocCompetition(o), { online: false });
    await seedEntrants(o.orgId, d.id, 16);
    const stageId = await seedStageKind(o.orgId, d.id, "swiss", { rounds: 9 });
    await generateStageFixtures(o.auth, stageId);
    expect(await fixtureCount(stageId)).toBeGreaterThan(0);
  });
});

describe.skipIf(!HAS_DB)("rounds are not gated once frozen (P11, owner ruling)", () => {
  it("a frozen 16 (grandfathered, unpaid) takes any count at the rounds edit and at a stage batch", async () => {
    const o = await ocOrg();
    const { divisionId, stageId, packageId } = await onlineWithSwiss(o, 16, 4);
    expect(shape(await refusal(patchSwissStage(o.auth, stageId, { rounds: 9 }))), "premise: refused while unfrozen").toEqual(needSize(128));
    await freezeGrandfathered(packageId);
    await patchSwissStage(o.auth, stageId, { rounds: 9 });
    expect(await roundsOf(stageId)).toBe(9);
    await createStages(o.auth, divisionId, [swissAt(2, 12)] as never);
    expect((await liveOf(divisionId)).size, "and the size is as it was").toBe(16);
  });

  it("a PAID 16 frozen by an opened round takes any count too (the round is open: Start is Task 9's stamp)", async () => {
    const o = await ocOrg();
    await spendTheMonth(o.orgId);
    await buy(o.orgId, 5);
    const { divisionId, stageId } = await onlineWithSwiss(o, 16, 4);
    await pay(o, divisionId, 16);
    expect((await liveOf(divisionId)).paid_at, "premise: paid").not.toBeNull();
    expect(shape(await refusal(patchSwissStage(o.auth, stageId, { rounds: 9 }))), "premise: refused while unfrozen").toEqual(needSize(128));
    await freeze((await liveOf(divisionId)).id);
    await patchSwissStage(o.auth, stageId, { rounds: 9 });
    expect(await roundsOf(stageId)).toBe(9);
  });
});

describe.skipIf(!HAS_DB)("the leaf judgements, called directly on real rows", () => {
  it("assertRoundsFit: no row and a frozen row are never asked; an unfrozen row is judged at its own size; 0 rounds fits", async () => {
    const o = await ocOrg();
    const { divisionId, packageId } = await onlineWithSwiss(o, 16, 1);
    const row = (await livePackage(sql, divisionId))!;
    expect(row.id, "premise: the row read is the live one").toBe(packageId);
    expect(() => assertRoundsFit(7, null), "no row: not online").not.toThrow();
    expect(() => assertRoundsFit(0, row), "no Swiss stage yet").not.toThrow();
    expect(() => assertRoundsFit(6, row), "the included rounds").not.toThrow();
    let err = await refusal((async () => assertRoundsFit(7, row))());
    expect(shape(err)).toEqual(needSize(32));
    err = await refusal((async () => assertRoundsFit(11, row))());
    expect(err.code).toBe(ONLINE_PACKAGE_CODES.roundsAboveMax);
    await freezeGrandfathered(packageId);
    const frozen = (await livePackage(sql, divisionId))!;
    expect(frozen.frozenAt, "premise: frozen").not.toBeNull();
    expect(() => assertRoundsFit(7, frozen), "frozen: a round added mid-event is free").not.toThrow();
    expect(() => assertRoundsFit(11, frozen), "frozen: even above any size").not.toThrow();
  });

  it("assertOnlineFormat: an empty batch has no format to judge; the first refused kind in the order given is named", () => {
    expect(() => assertOnlineFormat([])).not.toThrow();
    let thrown: unknown;
    try {
      assertOnlineFormat(["swiss", "ladder", "league"]);
    } catch (e) {
      thrown = e;
    }
    expect(shape(thrown as never)).toEqual({ status: 422, code: ONLINE_PACKAGE_CODES.formatNotSupported, extra: { kind: "ladder" } });
  });
});
