// W5 app PR A, Task 24 (T5-b): R4c - a withdrawal UNDER half played where one of the entrant's results is already FINALIZED (RB5-W2: "every
// result they played is removed, finalized ones included"). Before W5 a finalized line was a locked line the cascade skipped (ST-G15), and
// the stage could not complete behind it; since Task 8 the expunge takes it through the expunge-abandon path like any other result.
// Planned ONLY by `--set w1-driving --scenario W5A_R4C` (w5a-cells.ts).
//
// The script: seed 1 plays its first line (a win), the organiser FINALIZES it, then seed 1 withdraws with nothing else played. Expected
// values are the rulebook's, never the product's answer:
//   RB5-W4  "scheduled matches" counts the entrant's lines in the stage across every leg, decided or finalized as played: here 1 of T;
//   RB5-W2  under half -> every result they played is removed (the finalized one too) and every unplayed line voided, never a walkover;
//   RB5-W1  the entrant STAYS in the table, marked, ranked last; nothing they played counts for anyone, so every row of the pool reads 0 played;
//   RB5-W9  other lines are untouched.
// Then the standard loop plays the division out: the stage must still COMPLETE and advance (stageCompleted, advanceSeededAsDeclared), which is
// the Review Focus 4 of the plan (ruling 105 / M-10: the expunge's abandon must not re-open the auto-advance stall).
import { DriverMisuse, type OrganiserDriver, type StandingsOut, type WithdrawOut } from "../driver/types.ts";
import { assertion, type Item } from "./assertions.ts";
import { Recorder, decideFixture, defaultPolicy, setUpDivision, stageDrawsOk } from "./common.ts";
import { type Scenario } from "./types.ts";
import { w5aField } from "../w5a-cells.ts";
import { finishRun, stageLines, withdrawEntrant, type TLine } from "./w5a-table.ts";

const holds = (l: TLine, id: string): boolean => l.home === id || l.away === id;

export interface FinalizedExpungeObs {
  readonly target: string;
  /** The stage's lines just before the withdrawal and just after it. */
  readonly before: readonly TLine[];
  readonly after: readonly TLine[];
  readonly answer: WithdrawOut;
  /** The target's pool table after the withdrawal (the league's one table for a league). */
  readonly table: StandingsOut;
  /** The pool the target sits in (null: a league). */
  readonly poolId: string | null;
  readonly stageKind: "league" | "group";
}

/** The R4c items, every one counted. */
export function finalizedExpungeItems(o: FinalizedExpungeObs): Item[] {
  const mine = o.before.filter((l) => holds(l, o.target));
  const played = mine.filter((l) => l.status === "decided" || l.status === "finalized");
  const finalized = mine.filter((l) => l.status === "finalized");
  const items: Item[] = [
    // the premises the checks below stand on
    { ok: mine.length >= 3, note: `the target holds ${mine.length} line(s), expected at least 3 so one played is under half (RB5-Wd4)` },
    { ok: finalized.length >= 1, note: "no line of the target was FINALIZED before the withdrawal - the script proves nothing about RB5-Wd2's 'finalized ones included'" },
    { ok: played.length * 2 < mine.length, note: `${played.length} of ${mine.length} played is not under half (RB5-Wd2 applies under half)` },
    // the answer (RB5-W2: the expunge, never a walkover)
    { ok: o.answer.policy === "expunge", note: `policy ${o.answer.policy}, expected expunge (${played.length} of ${mine.length} played is under half, RB5-Wd2)` },
    { ok: o.answer.walkovers === 0, note: `${o.answer.walkovers} walkover(s) reported, expected none under the expunge (RB5-Wd2: unplayed lines are voided)` },
    { ok: o.answer.skipped_cancelled === 0, note: `${o.answer.skipped_cancelled} line(s) reported skipped, expected none - a finalized line is expunged like any result, not skipped (ST-G15)` },
    { ok: o.answer.voided === mine.length, note: `${o.answer.voided} line(s) reported voided, expected all ${mine.length} of the target's (the unplayed voided, the played ones' results removed)` },
  ];
  // every line of the target ends with no result and no live status
  for (const b of mine) {
    const a = o.after.find((l) => l.id === b.id);
    items.push({ ok: a !== undefined && a.outcome === null && a.status === "abandoned", note: `${b.id}: ${b.status} before, ${a === undefined ? "gone" : `${a.status}/${JSON.stringify(a.outcome)}`} after - expected abandoned with no result (the expunge-abandon path, RB5-Wd2)` });
  }
  // every other line is untouched (RB5-W9: the withdrawal is the target's alone)
  for (const b of o.before) {
    if (holds(b, o.target)) continue;
    const a = o.after.find((l) => l.id === b.id);
    items.push({ ok: a !== undefined && a.status === b.status && a.home === b.home && a.away === b.away && JSON.stringify(a.outcome) === JSON.stringify(b.outcome), note: `${b.id}: a line the target did not hold changed (${b.status} -> ${a?.status ?? "gone"})` });
  }
  // The table. A LEAGUE lists every entrant (the withdrawn one stays, marked and last: RB5-W1). A GROUP pool's table, on engine 9.x, lists only the
  // entrants holding a counted result (`entrantsOfPool`, the engine's membership-from-results): once the expunge removed the target's every result the
  // target has no row - the engine-10 bump (app PR B, `TableStage.pools` seats by membership) closes it (progress.md, Task 21 ruling). So the
  // EXPECTED member set is derived from the lines, never the product's rows: a league's whole pool, or a pool's entrants with a counted line; the
  // withdrawn entrant's row, when listed, is marked and last either way.
  const rows = o.table.rows;
  const row = rows.find((r) => r.entrantId === o.target);
  const peers = new Set(o.before.filter((l) => l.poolId === o.poolId).flatMap((l) => [l.home, l.away]).filter((e): e is string => e !== null));
  const counted = (id: string): boolean => o.after.some((l) => holds(l, id) && l.outcome !== null && l.status !== "abandoned");
  const expected = new Set([...peers].filter((e) => o.stageKind === "league" || counted(e)));
  items.push(
    { ok: o.stageKind === "group" || row !== undefined, note: "the withdrawn entrant is no longer in the league table (RB5-Wd1: they stay in the table)" },
    { ok: rows.length === expected.size && rows.every((r) => expected.has(r.entrantId)), note: `the table lists ${rows.length} row(s) (${rows.map((r) => r.entrantId.slice(0, 4)).join(",")}), expected ${expected.size}: ${o.stageKind === "league" ? "every entrant of the league" : "the pool's entrants with a counted result"} (RB5-P1)` },
    { ok: row === undefined || row.status === "withdrawn", note: `the withdrawn entrant's row reads status ${row?.status ?? "(none)"}, expected withdrawn (RB5-Wd1: marked)` },
    { ok: row === undefined || row.rank === Math.max(...rows.map((r) => r.rank ?? 0)), note: `the withdrawn entrant ranks ${row?.rank ?? "(none)"} of ${rows.length}, expected last (RB5-Wd1)` },
  );
  // Each row counts the decided lines the entrant still holds: the target's are all removed (RB5-W2), so a peer's played is its decided lines against
  // the OTHER peers - the target's own row reads 0.
  const decided = (id: string): number => o.after.filter((l) => holds(l, id) && l.outcome !== null && l.status !== "abandoned").length;
  const countedLines = o.after.filter((l) => l.outcome !== null && l.status !== "abandoned").length;
  items.push({ ok: countedLines >= 1, note: "no line outside the target's was decided - the table is level and cannot show where the withdrawn entrant ranks" });
  for (const r of rows) items.push({ ok: r.played === decided(r.entrantId), note: `row ${r.entrantId}: ${r.played ?? "?"} played, expected ${decided(r.entrantId)} - the expunged results count for nobody (RB5-Wd2)` });
  return items;
}

/** The optional act the script needs: the HTTP driver has it. */
function drivesFinalize(d: OrganiserDriver): d is OrganiserDriver & Required<Pick<OrganiserDriver, "finalize">> {
  return d.finalize !== undefined;
}

const r4c: Scenario = {
  key: "W5A_R4C",
  entrantCount: 6,
  canaryCheck: null,
  async run(ctx) {
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, w5aField("W5A_R4C", ctx.spec.row));
    const d = ctx.driver;
    if (!drivesFinalize(d)) throw new DriverMisuse("driver: W5A_R4C needs finalize - the HTTP driver has it, a layer that does not drive the path says so");
    const stage = setup.stage;
    if (stage.kind !== "league" && stage.kind !== "group") throw new Error(`scenario: W5A_R4C's entry stage is a ${stage.kind}, not a table`);
    const target = setup.idOfSeed(1);
    const lines = await stageLines(ctx, setup, stage.id);
    const first = lines.filter((l) => holds(l, target) && l.status === "scheduled").sort((a, b) => (a.round ?? 0) - (b.round ?? 0))[0];
    const row = first === undefined ? undefined : (await d.listFixtures(setup.division.id)).find((f) => f.id === first.id);
    if (first === undefined || row === undefined) throw new Error(`scenario: seed 1 (${target}) holds no open line of the started stage`);
    await decideFixture(ctx, rec, setup, row, defaultPolicy(setup, row, stageDrawsOk(ctx, stage), rec.decided), stage);
    const fin = await d.finalize(first.id);
    rec.notes.push(`finalized ${first.id}: ${fin.status}`);
    // A second, counted result between two pool-mates: a table with NO counted result is level and ranks nobody (W2e D11 b), so "ranked last"
    // (RB5-W1) is only observable beside one.
    const mate = lines.find((l) => l.poolId === first.poolId && !holds(l, target) && l.status === "scheduled");
    const mateRow = mate === undefined ? undefined : (await d.listFixtures(setup.division.id)).find((f) => f.id === mate.id);
    if (mateRow === undefined) throw new Error(`scenario: seed 1's pool holds no other open line to count beside the expunged one`);
    await decideFixture(ctx, rec, setup, mateRow, defaultPolicy(setup, mateRow, stageDrawsOk(ctx, stage), rec.decided), stage);
    const before = await stageLines(ctx, setup, stage.id);
    const { answer: w, obs } = await withdrawEntrant(ctx, rec, setup, target, 1);
    rec.notes.push(`withdrawal of seed 1: policy ${w.policy}, ${w.walkovers} walkover(s), ${w.voided} voided, ${w.skipped_cancelled} skipped`);
    const after = await stageLines(ctx, setup, stage.id);
    const poolId = first.poolId;
    const table = await d.standings(stage.id, poolId);

    const own = assertion("w5a-r4c-finalized-expunge", finalizedExpungeItems({ target, before, after, answer: w, table, poolId, stageKind: stage.kind }));
    return finishRun(ctx, rec, setup, () => [own], {}, obs);
  },
};

export const w5aR4cScenarios: Readonly<Partial<Record<"W5A_R4C", Scenario>>> = Object.freeze({ W5A_R4C: r4c });
