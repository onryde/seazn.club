// W4 app PR B, Task 15 (T8-c, PR-B share): Q5, "plate", as two opt-in scripts on the `ko_plate` row - W4B_Q5A and W4B_Q5B, planned ONLY by
// `--set w1-driving --scenario <key>` (w1-driving-set.ts, w4b-cells.ts). The atoms are the catalogue's (scenario-catalogue.ts), not the rulebook's label:
//   Q5a  "plate entrant withdraws"            the plate is drawn, an entrant of its field withdraws, and THEIR plate line walks over (X-WD-2): the
//                                             opponent is awarded the line and goes on, nothing else in the plate moves.
//   Q5b  "a main-draw loser declines the plate"  modelled as that loser WITHDRAWING after their first loss and BEFORE the plate is proposed
//                                             (RB4-P3: after round 2, once every first loss is known). A departed entrant is never seated (ruling 116),
//                                             so the plate draws from the rest.
// The plate holds everyone's FIRST loss (RB4-P1), a first loss by walkover or withdrawal excluded (RB4-P2), every one of them, with no fixed count (RB4-P4).
// The oracle for who that is comes off the main bracket's own stored lines (advance.ts firstLossersOf: the rows alone, never the product's resolver), so the
// proposal the product makes is judged against the rule, not against itself. Each script's own check is a pure function of what it read (`plateWithdrawItems`,
// `plateDeclinesItems`) that counts every item it examined: an empty set is a failure (R25).
import { RefusedCall, type FixtureRow } from "../driver/types.ts";
import { DEPARTED_STATUSES, PENDING_STATUSES, crownOf, winnerOf, type CompleteObs } from "../observed.ts";
import { confirmAdvance, firstLossersOf, type AdvanceObs } from "./advance.ts";
import { assertion, builtAsPosted, foldParity, lineupsPut, loopBounded, resultsAsPosted, stageCompleted, type Item } from "./assertions.ts";
import { Recorder, finishStage, recordGenerate, setUpDivision, snapshot, type DivisionSetup, type StagePlay } from "./common.ts";
import { lineOf, type Line } from "./w4a-late-entry.ts";
import { Q5A_FIELD, Q5B_FIELD, playOut } from "./w4b-support.ts";
import type { Scenario, ScenarioContext, ScenarioOutput } from "./types.ts";

export type Q5Key = "W4B_Q5A" | "W4B_Q5B";

const holds = (l: Line, id: string): boolean => l.home === id || l.away === id;
const seatsOf = (l: Line): string => `${l.home ?? "-"}/${l.away ?? "-"}`;
const seatedIn = (lines: readonly Line[], id: string): number => lines.filter((l) => holds(l, id)).length;
const setOf = (ids: readonly string[]): string => [...new Set(ids)].sort().join(",");
/** The distinct entrants the lines seat. */
export const seatedOf = (lines: readonly Line[]): string[] => [...new Set(lines.flatMap((l) => [l.home, l.away]).filter((x): x is string => x !== null))];

/** The shared half of both scripts: the plate's field the product proposed and seated, judged against the oracle in BOTH directions. */
function fieldItems(expected: readonly string[], proposed: readonly string[] | null, advanceStatus: number | null, advanceCode: string | null, seated: readonly string[], why: string): Item[] {
  return [
    { ok: expected.length >= 2, note: `the oracle's plate field is ${expected.length} entrant(s) (${why}), a plate needs two to draw a match` },
    { ok: proposed !== null, note: "the plate's seed proposal was refused or never made" },
    { ok: proposed !== null && setOf(proposed) === setOf(expected) && proposed.length === expected.length, note: `the plate proposal seats {${proposed === null ? "" : setOf(proposed)}} (${proposed?.length ?? 0}), the rule's field is {${setOf(expected)}} (${expected.length}) - ${why}` },
    { ok: advanceStatus === 200, note: `confirming the plate's draw answered ${advanceStatus ?? "nothing"} ${advanceCode ?? ""}`.trim() },
    { ok: setOf(seated) === setOf(expected) && seated.length === expected.length, note: `the plate's lines seat {${setOf(seated)}} (${seated.length}), the rule's field is {${setOf(expected)}} (${expected.length})` },
  ];
}

// --- Q5a: a plate entrant withdraws, their plate line walks over ----------------------------------------------------------------------

export interface PlateWithdrawObs {
  /** RB4-P1/P2, off the main bracket's own lines: every entrant whose first match was a played loss. */
  readonly expectedField: readonly string[];
  readonly proposed: readonly string[] | null;
  readonly advanceStatus: number | null;
  readonly advanceCode: string | null;
  /** The plate's lines as the confirmation left them, and after the withdrawal. */
  readonly before: readonly Line[];
  readonly after: readonly Line[];
  readonly withdrawn: string;
  /** The entrant the withdrawn one was drawn against in the plate's first round. */
  readonly opponent: string;
  readonly lineId: string;
  readonly departed: ReadonlySet<string>;
  /** The plate's completion once its remaining lines were played. */
  readonly complete: CompleteObs | null;
}

/** The Q5a items, every one counted. */
export function plateWithdrawItems(o: PlateWithdrawObs): Item[] {
  const items = fieldItems(o.expectedField, o.proposed, o.advanceStatus, o.advanceCode, seatedOf(o.before), "RB4-P1/P2/P4: every first loss that was a played loss");
  const was = o.before.find((l) => l.id === o.lineId);
  items.push(
    { ok: was !== undefined && holds(was, o.withdrawn) && holds(was, o.opponent) && PENDING_STATUSES.includes(was.status), note: `the plate line ${o.lineId} reads ${was === undefined ? "absent" : `${seatsOf(was)} ${was.status}`} before the withdrawal, expected ${o.withdrawn} v ${o.opponent} still to play` },
    { ok: seatedIn(o.before, o.withdrawn) === 1, note: `${o.withdrawn} sits in ${seatedIn(o.before, o.withdrawn)} plate line(s) before withdrawing, expected exactly 1` },
    { ok: o.departed.has(o.withdrawn), note: `the product stores ${o.withdrawn} as still in after the withdrawal` },
  );
  const now = o.after.find((l) => l.id === o.lineId);
  const out = now?.outcome ?? null;
  items.push(
    { ok: now !== undefined && now.status === "forfeited", note: `the walked-over plate line reads ${now?.status ?? "absent"}, expected forfeited (X-WD-2)` },
    { ok: out !== null && out.kind === "award" && out.winner === o.opponent && out.loser === o.withdrawn, note: `the walked-over plate line is ${out === null ? "no outcome" : JSON.stringify(out)}, expected an award to ${o.opponent} against ${o.withdrawn}` },
    { ok: winnerOf(out) === o.opponent, note: `the line's winner is ${winnerOf(out) ?? "nobody"}, expected ${o.opponent}` },
  );
  // The withdrawn entrant plays nothing else; the opponent goes on, once.
  items.push({ ok: o.after.filter((l) => l.id !== o.lineId && holds(l, o.withdrawn)).length === 0, note: `${o.withdrawn} is still seated in another plate line after withdrawing` });
  const nextRound = o.after.filter((l) => (l.round ?? 0) > (now?.round ?? 0) && holds(l, o.opponent));
  const hasNext = o.after.some((l) => (l.round ?? 0) > (now?.round ?? 0));
  if (hasNext) items.push({ ok: nextRound.length === 1, note: `the opponent ${o.opponent} is seated in ${nextRound.length} later plate line(s), expected exactly 1 (the walkover advances them)` });
  // Nothing else in the plate moved, one item per line the walkover had no business with (the line the opponent advanced into gains their seat).
  for (const b of o.before) {
    if (b.id === o.lineId) continue;
    const x = o.after.find((l) => l.id === b.id);
    const advancedInto = x !== undefined && holds(x, o.opponent) && !holds(b, o.opponent);
    const want = advancedInto ? true : x !== undefined && x.home === b.home && x.away === b.away;
    items.push({ ok: x !== undefined && want && x.status === b.status, note: `${b.id}: ${seatsOf(b)} ${b.status} before the withdrawal, ${x === undefined ? "gone" : `${seatsOf(x)} ${x.status}`} after` });
  }
  items.push({ ok: o.complete?.completed === true, note: `the plate's completion answered completed=${o.complete?.completed ?? "never asked"}` });
  const crown = crownOf(o.complete);
  items.push({ ok: crown.kind === "unread" || !(crown.ids as readonly string[]).includes(o.withdrawn), note: `the plate crowned ${crown.ids.join(", ")} - the withdrawn ${o.withdrawn}` });
  return items;
}

// --- Q5b: a main-draw loser declines (withdraws) before the plate is proposed --------------------------------------------------------

export interface PlateDeclinesObs {
  /** The main bracket's first losers once round 1 was decided - the entrant that declines is one of them. */
  readonly firstLosersAtDecline: readonly string[];
  readonly declined: string;
  /** Whether the plate held NO seated line at the moment the loser declined (the premise: before the proposal, RB4-P3). */
  readonly plateOpenAtDecline: boolean;
  readonly departed: ReadonlySet<string>;
  /** The rule's field once every first match is decided: the main bracket's first losers, the departed one out (ruling 116). */
  readonly expectedField: readonly string[];
  readonly proposed: readonly string[] | null;
  readonly advanceStatus: number | null;
  readonly advanceCode: string | null;
  readonly plateLines: readonly Line[];
  readonly complete: CompleteObs | null;
}

/** The Q5b items, every one counted. */
export function plateDeclinesItems(o: PlateDeclinesObs): Item[] {
  const items: Item[] = [
    { ok: o.firstLosersAtDecline.includes(o.declined), note: `${o.declined} was no first loser of the main draw when it declined (first losers: ${o.firstLosersAtDecline.join(", ") || "none"}) - the script withdrew the wrong player` },
    { ok: o.plateOpenAtDecline, note: "the plate already had seated lines when the loser declined - the proposal came before the decline (RB4-P3 draws after round 2)" },
    { ok: o.departed.has(o.declined), note: `the product stores ${o.declined} as still in after the withdrawal` },
    { ok: !o.expectedField.includes(o.declined), note: `the oracle's plate field still names the departed ${o.declined} (ruling 116: a departed entrant is never seated)` },
    ...fieldItems(o.expectedField, o.proposed, o.advanceStatus, o.advanceCode, seatedOf(o.plateLines), "RB4-P1/P4 less the departed (ruling 116)"),
    { ok: o.proposed === null || !o.proposed.includes(o.declined), note: `the plate proposal seats the departed ${o.declined}` },
    { ok: seatedIn(o.plateLines, o.declined) === 0, note: `the departed ${o.declined} is seated in ${seatedIn(o.plateLines, o.declined)} plate line(s), expected none` },
  ];
  // The plate draws from the rest: every other first loser is seated exactly once.
  for (const e of o.expectedField) items.push({ ok: seatedIn(o.plateLines, e) >= 1, note: `first loser ${e} is not seated in the plate` });
  items.push({ ok: o.complete?.completed === true, note: `the plate's completion answered completed=${o.complete?.completed ?? "never asked"}` });
  return items;
}

// --- the scripts ----------------------------------------------------------------------------------------------------------------------

/** A scripted driver call the product may refuse: the refusal is the run's finding, so it is returned, never thrown. */
async function attempt<T>(rec: Recorder, what: string, call: () => Promise<T>): Promise<T | RefusedCall> {
  try {
    return await call();
  } catch (e) {
    if (!(e instanceof RefusedCall)) throw e;
    rec.notes.push(`${what} refused ${e.status} ${e.code ?? "(no code)"}`);
    return e;
  }
}

const stageLines = async (ctx: ScenarioContext, setup: DivisionSetup, stageId: string): Promise<Line[]> => (await ctx.driver.listFixtures(setup.division.id)).filter((f: FixtureRow) => f.stage_id === stageId).map(lineOf);

/** The stage's rows as the oracle reads them (advance.ts firstLossersOf: the stored rows alone, never the product's resolver). */
const firstLosersOfStage = async (ctx: ScenarioContext, setup: DivisionSetup, stageId: string): Promise<string[]> =>
  firstLossersOf((await ctx.driver.listFixtures(setup.division.id)).filter((f: FixtureRow) => f.stage_id === stageId).map((f) => ({ roundNo: f.round_no, home: f.home_entrant_id, away: f.away_entrant_id, outcome: f.outcome, thirdPlace: f.third_place })));

interface Drawn { readonly proposed: readonly string[] | null; readonly advance: AdvanceObs | null; readonly lines: readonly Line[] }

/** Propose the plate through the real flow (recompute the draft, then confirm it) over `fieldSize` first losers. The proposal's entrants and the
 *  confirmation's answer are what the items judge; a refusal at either door is returned as null, with the note it left. */
async function drawPlate(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, plate: DivisionSetup["stage"], fieldSize: number): Promise<Drawn> {
  await recordGenerate(ctx, rec, plate.id);
  const body = setup.built.posted.stages.find((b) => b.seq === plate.seq);
  if (body === undefined) throw new Error(`scenario: the plate (seq ${plate.seq}) has no posted body`);
  const fresh = await attempt(rec, "the plate's seed proposal", () => ctx.driver.recomputeSeedProposal(plate.id));
  if (fresh instanceof RefusedCall) return { proposed: null, advance: null, lines: await stageLines(ctx, setup, plate.id) };
  const proposed = fresh.qualifiers.map((q) => q.entrantId);
  const advance = await confirmAdvance(ctx, rec, plate, { id: fresh.id, status: fresh.status }, body, 1, fieldSize);
  return { proposed, advance, lines: await stageLines(ctx, setup, plate.id) };
}

/** Both scripts: the root bracket and the plate it feeds. */
function stagesOf(setup: DivisionSetup): { main: DivisionSetup["stage"]; plate: DivisionSetup["stage"] } {
  const [main, plate] = setup.stages;
  if (main === undefined || plate === undefined || setup.stages.length !== 2) throw new Error(`scenario: ko_plate built ${setup.stages.length} stage(s), expected the main bracket and the plate`);
  return { main, plate };
}

/** The tail both scripts share: finish the main bracket, play and finish the plate, then judge the run by the standard life checks. */
async function finish(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, drawn: Drawn, own: ReturnType<typeof assertion>, mainComplete: CompleteObs, plateComplete: CompleteObs | null): Promise<ScenarioOutput> {
  const { main, plate } = stagesOf(setup);
  const plays: StagePlay[] = [
    { stage: main, field: setup.entrants.map((e) => e.id), advance: null, complete: mainComplete },
    { stage: plate, field: drawn.advance?.seeded ?? null, advance: drawn.advance, complete: plateComplete },
  ];
  const observed = await snapshot(ctx, rec, setup, plays, { configEdit: null, withdrawal: null });
  return {
    observed,
    events: rec.events,
    notes: rec.notes,
    assertions: [builtAsPosted(setup.built, observed), foldParity(rec), resultsAsPosted(rec, observed), own, stageCompleted(observed), loopBounded(rec, observed), lineupsPut(rec, setup)],
  };
}

/** Mark both stages drained when nothing is left open in either: an honest exit, read off the lines. */
async function markDrained(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup): Promise<void> {
  const open = (await ctx.driver.listFixtures(setup.division.id)).filter((f) => !["decided", "finalized", "forfeited", "cancelled", "abandoned"].includes(f.status));
  if (open.length > 0) return;
  for (const s of setup.stages) rec.track(s.id).exit = "drained";
  rec.exit = "drained";
}

const withdrawEntrant = async (ctx: ScenarioContext, rec: Recorder, id: string, why: string): Promise<void> => {
  const w = await ctx.driver.withdraw(id);
  rec.facts.add("withdrawn");
  rec.withdrawn.add(id);
  rec.notes.push(`withdrawal of ${why}: policy ${w.policy}, ${w.walkovers} walkover(s)`);
};

/** The lowest-seeded (highest seed number) of `ids`: the script's pick, so the choice is never "whoever the product listed first". */
const lowestSeeded = (setup: DivisionSetup, ids: readonly string[]): string => [...ids].sort((a, b) => setup.seedOf(b) - setup.seedOf(a))[0];

const q5a: Scenario = {
  key: "W4B_Q5A",
  entrantCount: Q5A_FIELD,
  canaryCheck: null,
  async run(ctx) {
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, Q5A_FIELD);
    const { main, plate } = stagesOf(setup);
    // Round 1 decided: a bracket of eight has no bye, so every first match is played and the plate's field is complete.
    await playOut(ctx, rec, setup, main, (f) => f.round_no === 1);
    const expectedField = await firstLosersOfStage(ctx, setup, main.id);
    const drawn = await drawPlate(ctx, rec, setup, plate, expectedField.length);
    const withdrawn = expectedField.length === 0 ? null : lowestSeeded(setup, expectedField);
    const line = withdrawn === null ? undefined : drawn.lines.find((l) => holds(l, withdrawn) && l.home !== null && l.away !== null);
    const opponent = line === undefined || withdrawn === null ? null : line.home === withdrawn ? line.away : line.home;
    if (withdrawn === null || line === undefined || opponent === null) {
      // Nothing to withdraw from: the plate never drew a line for any first loser. Judged by name, and the run still finishes the main bracket.
      const own = assertion("w4b-q5a-plate-entrant-withdraws", [{ ok: false, note: `the plate drew no line for a first loser (field ${expectedField.length}, proposal ${drawn.proposed === null ? "refused" : drawn.proposed.length}, confirm ${drawn.advance?.status ?? "not asked"} ${drawn.advance?.code ?? ""}) - nobody could withdraw from it` }]);
      await playOut(ctx, rec, setup, main);
      const mc = await finishStage(ctx, rec, main.id);
      await markDrained(ctx, rec, setup);
      return finish(ctx, rec, setup, drawn, own, mc, null);
    }
    const before = drawn.lines;
    await withdrawEntrant(ctx, rec, withdrawn, `plate entrant ${withdrawn} (seed ${setup.seedOf(withdrawn)})`);
    const after = await stageLines(ctx, setup, plate.id);
    // The rest of the division is played out: the main bracket, then the plate.
    await playOut(ctx, rec, setup, main);
    const mc = await finishStage(ctx, rec, main.id);
    await playOut(ctx, rec, setup, plate);
    await markDrained(ctx, rec, setup);
    const pc = await finishStage(ctx, rec, plate.id);
    const departed = new Set((await ctx.driver.listEntrants(setup.division.id)).filter((e) => DEPARTED_STATUSES.includes(e.status)).map((e) => e.id));
    const own = assertion("w4b-q5a-plate-entrant-withdraws", plateWithdrawItems({
      expectedField, proposed: drawn.proposed, advanceStatus: drawn.advance?.status ?? null, advanceCode: drawn.advance?.code ?? null,
      before, after, withdrawn, opponent, lineId: line.id, departed, complete: pc,
    }));
    return finish(ctx, rec, setup, drawn, own, mc, pc);
  },
};

const q5b: Scenario = {
  key: "W4B_Q5B",
  entrantCount: Q5B_FIELD,
  canaryCheck: null,
  async run(ctx) {
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, Q5B_FIELD);
    const { main, plate } = stagesOf(setup);
    // Round 1 only: seed 1 holds the bye, so the plate's field is still open (the bye holder has not met anybody).
    await playOut(ctx, rec, setup, main, (f) => f.round_no === 1);
    const firstLosersAtDecline = await firstLosersOfStage(ctx, setup, main.id);
    const declined = firstLosersAtDecline.length === 0 ? null : lowestSeeded(setup, firstLosersAtDecline);
    const plateOpenAtDecline = (await stageLines(ctx, setup, plate.id)).every((l) => l.home === null && l.away === null);
    if (declined === null) {
      const own = assertion("w4b-q5b-loser-declines-the-plate", [{ ok: false, note: "round 1 produced no first loser, so nobody could decline the plate" }]);
      await playOut(ctx, rec, setup, main);
      const mc = await finishStage(ctx, rec, main.id);
      await markDrained(ctx, rec, setup);
      return finish(ctx, rec, setup, { proposed: null, advance: null, lines: [] }, own, mc, null);
    }
    await withdrawEntrant(ctx, rec, declined, `main-draw loser ${declined} (seed ${setup.seedOf(declined)}) declining the plate`);
    // Round 2 decides the bye holder's first match: now every first loss is known and the plate is proposed.
    await playOut(ctx, rec, setup, main);
    const mc = await finishStage(ctx, rec, main.id);
    // The first losers of the finished bracket, the departed one out: the rule's field (RB4-P1, ruling 116), read off the lines.
    const expectedField = (await firstLosersOfStage(ctx, setup, main.id)).filter((e) => e !== declined);
    const drawn = await drawPlate(ctx, rec, setup, plate, expectedField.length);
    await playOut(ctx, rec, setup, plate);
    await markDrained(ctx, rec, setup);
    const pc = await finishStage(ctx, rec, plate.id);
    const departed = new Set((await ctx.driver.listEntrants(setup.division.id)).filter((e) => DEPARTED_STATUSES.includes(e.status)).map((e) => e.id));
    const own = assertion("w4b-q5b-loser-declines-the-plate", plateDeclinesItems({
      firstLosersAtDecline, declined, plateOpenAtDecline, departed, expectedField, proposed: drawn.proposed,
      advanceStatus: drawn.advance?.status ?? null, advanceCode: drawn.advance?.code ?? null, plateLines: drawn.lines, complete: pc,
    }));
    return finish(ctx, rec, setup, drawn, own, mc, pc);
  },
};

export const q5Scenarios: Readonly<Record<Q5Key, Scenario>> = Object.freeze({ W4B_Q5A: q5a, W4B_Q5B: q5b });
