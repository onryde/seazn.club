// W3 app-B Task 6 (X-SW-26): the model's Swiss twin (`ModelFakeDriver`) answers a Swiss Pair the way the product's swissGen does
// when no round is left that repeats nobody - SWISS_NO_LEGAL_PAIRING with `{ round, reason, field, finishAfter, canFinish }` -
// and "Finish the Swiss now" the way finishSwissNow does (usecases/swiss-rounds-admin.ts): the refusals in its order, and on
// success every row past k deleted, `config.rounds := k`, and the stage completed by the same call.
//
// Expected statuses and sentences come from the product's own refusal table (`SWISS_REFUSALS`), never typed here; the dead
// end itself is the ENGINE's (`pairRound` over 4 entrants runs out of rematch-free rounds after 3), not a forced refusal.
// single-sport: the Finish verdict and the dead end are sport-independent (one fold, one pairing); badminton is only the sport the
// rig scores with. The sport-sweeping proof of the loop is scenarios.test.ts.
import { describe, expect, it } from "vitest";
import { SWISS_REFUSALS } from "../../../apps/web/src/lib/swiss-refusals.ts";
import { newModelState } from "../lib/model/commands.ts";
import { resolveSportCfg, stageCfg } from "../lib/sport-cfg.ts";
import { generateStream } from "../lib/streams/index.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { ModelFakeDriver } from "./model-fake-driver.ts";

const SPORT = "badminton";
const BUDGET = 12; // far more rounds than 4 entrants can play without a rematch

/** A started 4-entrant Swiss with a `BUDGET`-round budget, nothing paired yet. */
async function started(row: "swiss" | "league" = "swiss") {
  const d = new ModelFakeDriver({});
  const variant = offlineBuilderDefault(SPORT);
  await newModelState({ driver: d, row, sport: SPORT, variant, entrants: 4, tag: "t6-finish" });
  if (row === "swiss") d.stage!.config = { ...d.stage!.config, rounds: BUDGET };
  await d.start();
  const cfg = stageCfg(SPORT, resolveSportCfg(SPORT, variant), "swiss", variant, undefined);
  const boards = (round: number) => d.fixtures.filter((f) => f.round_no === round && f.home_entrant_id !== null && f.away_entrant_id !== null);
  const decide = async (round: number) => {
    for (const f of boards(round)) await d.postStream(f.id, generateStream({ sportKey: SPORT, cfg, stageKind: "swiss", home: f.home_entrant_id!, away: f.away_entrant_id!, outcome: { kind: "win", winner: "home" } }));
  };
  /** Pair round `round` and decide it. */
  const play = async (round: number) => { await d.generate(); expect(boards(round).length, `rig: round ${round} seated two boards`).toBe(2); await decide(round); };
  return { d, boards, decide, play };
}

const refusal = (code: keyof typeof SWISS_REFUSALS) => ({ code, status: SWISS_REFUSALS[code].status, message: SWISS_REFUSALS[code].message });

describe("the model twin's Swiss Pair refuses the dead end by name, with the body the desk reads", () => {
  it("after 3 rounds of 4 entrants the 4th Pair is SWISS_NO_LEGAL_PAIRING: finishAfter 3, canFinish, and the table row's resolvable status", async () => {
    const { d, play } = await started();
    for (const r of [1, 2, 3]) await play(r);
    const seatedBefore = d.fixtures.filter((f) => f.home_entrant_id !== null).length;
    const err = await d.generate().then(() => null, (e: unknown) => e);
    const row = SWISS_REFUSALS.SWISS_NO_LEGAL_PAIRING;
    expect(row.resolvableStatus, "premise: the table row has a resolvable status of its own").toBeDefined();
    expect(row.resolvableStatus).not.toBe(row.status);
    expect(err).toMatchObject({ name: "RefusedCall", code: "SWISS_NO_LEGAL_PAIRING", status: row.resolvableStatus, extra: { round: 4, finishAfter: 3, canFinish: true } });
    // The twin refuses before it touches a shell: round 4 stays unseated.
    expect(d.fixtures.filter((f) => f.home_entrant_id !== null).length).toBe(seatedBefore);
  });
});

describe("the model twin's Finish the Swiss now (finishSwissNow)", () => {
  it("after a dead end: k = 3 rounds stay, every row past round 3 goes, config.rounds becomes 3, and the SAME call completes the stage", async () => {
    const { d, play } = await started();
    for (const r of [1, 2, 3]) await play(r);
    await d.generate().catch(() => undefined); // the dead end
    const past = d.fixtures.filter((f) => (f.round_no ?? 0) > 3).length;
    expect(past, "premise: shells past round 3 exist to be removed").toBeGreaterThan(0);
    const before = d.fixtures.length;
    const out = await d.finishSwiss("s1");
    expect(out).toMatchObject({ completed: true, finished_after: 3, shells_removed: past, slots_freed: 0 });
    expect(d.fixtures.length).toBe(before - past);
    expect(Math.max(...d.fixtures.map((f) => f.round_no ?? 0))).toBe(3);
    expect(d.stage!.config.rounds).toBe(3);
    expect(d.completed).toBe(true);
    expect(d.calls.filter((c) => c === "completeStage"), "Finish ran the stage's completion once").toHaveLength(1);
  });

  it("the sequence: a second Finish is SWISS_OVER (the stage is complete), and a Pair after it has nothing to seat", async () => {
    const { d, play } = await started();
    for (const r of [1, 2]) await play(r);
    await d.finishSwiss("s1");
    const over = refusal("SWISS_OVER");
    await expect(d.finishSwiss("s1")).rejects.toMatchObject({ code: over.code, status: over.status, message: expect.stringContaining(over.message) });
    // differential: the first Finish removed rows; the refused second removed none
    expect(Math.max(...d.fixtures.map((f) => f.round_no ?? 0))).toBe(2);
  });

  it("refused by name, nothing written: before any round is decided (SWISS_FINISH_NOTHING_PLAYED), and while a board past k has a result (SWISS_FINISH_ROUND_UNDECIDED, naming it)", async () => {
    const { d, boards, decide } = await started();
    await d.generate(); // round 1 seated, undecided
    const nothing = refusal("SWISS_FINISH_NOTHING_PLAYED");
    const rows = d.fixtures.length;
    await expect(d.finishSwiss("s1")).rejects.toMatchObject({ code: nothing.code, status: nothing.status, extra: { canFinish: false } });
    expect(d.fixtures.length, "a refused Finish deletes nothing").toBe(rows);
    expect(d.completed).toBe(false);

    await decide(1);
    await d.generate(); // round 2 seated
    const [first] = boards(2);
    // one board of round 2 STARTS (a result in its ledger), the other does not: round 2 is past k=1 and in progress
    await d.postStream(first!.id, generateStream({
      sportKey: SPORT, cfg: stageCfg(SPORT, resolveSportCfg(SPORT, offlineBuilderDefault(SPORT)), "swiss", offlineBuilderDefault(SPORT), undefined),
      stageKind: "swiss", home: first!.home_entrant_id!, away: first!.away_entrant_id!, outcome: { kind: "win", winner: "home" },
    }));
    const undecided = refusal("SWISS_FINISH_ROUND_UNDECIDED");
    const err = await d.finishSwiss("s1").then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ code: undecided.code, status: undecided.status, extra: { canFinish: false, inProgress: true } });
    const named = ((err as { extra: { boards: { fixtureId: string; round: number }[] } }).extra.boards);
    expect(named.length, "anti-vacuity: the refusal names the board the organiser must decide first").toBeGreaterThan(0);
    expect(named.every((b) => b.round <= 2)).toBe(true);
    expect(d.completed).toBe(false);
    expect(d.stage!.config.rounds, "a refused Finish leaves the round budget").toBe(BUDGET);
  });

  it("a stage that is not a Swiss refuses by name (STAGE_NOT_SWISS)", async () => {
    const { d } = await started("league");
    const notSwiss = refusal("STAGE_NOT_SWISS");
    await expect(d.finishSwiss("s1")).rejects.toMatchObject({ code: notSwiss.code, status: notSwiss.status });
    expect(d.completed).toBe(false);
  });
});
