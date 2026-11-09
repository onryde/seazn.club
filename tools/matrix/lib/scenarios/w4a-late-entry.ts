// W4 app PR A, Task 24: the three opt-in scripts that were catalogue atoms with no driver - R2 (late entry after Start), R10
// (an automatic arrival waits for the organiser's tap) and R6 (a departed qualifier's seat goes to a lucky loser). Planned ONLY by
// `--set w1-driving --scenario <key>` (w1-driving-set.ts, w4a-cells.ts), as W2a's, W2b's and W2e's are, so no committed plan holds one.
//
// Each script is the organiser's acts through the OrganiserDriver, then the standard play-out (playDivision) so the run is also judged
// by the invariants and the shared life checks; its OWN check is a pure function of what the script read (`lateAddItems`,
// `reinstateItems`, `luckyLoserItems`), which counts every item it examined - an empty set is a failure (R25), never a pass.
//
// Expected values come from the rulebook, never from the product's answer:
//   R2   RB4-L4 / X-LE-3: a newcomer into a bracket with a free bye plays the LOWEST-seeded bye holder's bye, at once;
//   R10  X-LE-10 / K13: a Reinstate is an AUTOMATIC arrival - nothing in the bracket moves until the organiser's tap, and the tap
//        gives the player back their OWN walked-over seat (the walkover reversed, the opponent's advance undone);
//   R6   RB4-V2 / V5 / X-LL-1: a qualifier who has left before the main draw is seated is replaced by the best loser below the cut
//        - the latest round lost, then the better seed - a walkover loser never drawing, and nobody is walked over in her place.
// The seeds a rule names are looked up from the setup (idOfSeed), the field sizes are the scripts' own (entrantCount).
import { DriverMisuse, RefusedCall, type LateEntryWire, type ReinstateOut } from "../driver/types.ts";
import type { FixtureRow } from "../driver/types.ts";
import { PENDING_STATUSES, toObservedOutcome, winnerOf, type ObservedOutcome } from "../observed.ts";
import { advanceSeededAsDeclared } from "./advance.ts";
import { assertion, builtAsPosted, foldParity, lineupsPut, loopBounded, resultsAsPosted, stageCompleted, type Item } from "./assertions.ts";
import { Recorder, playDivision, setUpDivision, snapshot, type DivisionSetup } from "./common.ts";
import { entrantName, rosterMembers } from "./rosters.ts";
import { W4A_SCENARIO_KEYS, type Scenario, type ScenarioContext, type ScenarioOutput, type W4aScenarioKey } from "./types.ts";

export const W4A_SCENARIOS: readonly string[] = W4A_SCENARIO_KEYS;

/** R2's field: six seeds in a bracket of eight, so seeds 1 and 2 hold a bye (RB4-L4 names them) and a newcomer has one to take. */
export const R2_FIELD = 6;
/** R10 / R6's field: eight seeds, a full bracket - R10's withdrawal leaves a walked-over round-1 line and R6's cut (four) leaves
 *  four quarter-final losers to draw a lucky loser from. */
export const FULL_FIELD = 8;
/** The product's own events on a walked-over line the tap reopens: the withdrawal's forfeit, and the void that reverses it. */
export const R10_REVERSED_EVENTS = 2;
/** R6's cut: the builder's own `qualified` knob (catalogue.ts BUILDER_DEFAULT_KNOBS, read off the posted body below as a guard). */
export const R6_CUT = 4;

/** One fixture as the scripts read it: seats, status and result - no more. */
export interface Line {
  readonly id: string;
  readonly stageId: string;
  readonly round: number | null;
  readonly home: string | null;
  readonly away: string | null;
  readonly status: string;
  readonly outcome: ObservedOutcome | null;
  readonly thirdPlace: boolean;
}

export const lineOf = (f: FixtureRow): Line => ({
  id: f.id, stageId: f.stage_id, round: f.round_no, home: f.home_entrant_id, away: f.away_entrant_id,
  status: f.status, outcome: toObservedOutcome(f.outcome), thirdPlace: f.third_place === true,
});

const seatsOf = (l: Line): string => `${l.home ?? "-"}/${l.away ?? "-"}`;
const holds = (l: Line, id: string): boolean => l.home === id || l.away === id;
const other = (l: Line, id: string): string | null => (l.home === id ? l.away : l.away === id ? l.home : null);
/** How many lines seat `id`. */
const seatedIn = (lines: readonly Line[], id: string): number => lines.filter((l) => holds(l, id)).length;

// --- R2: late entry after Start ---------------------------------------------------------------------------------------------

export interface LateAddObs {
  /** The root stage's fixtures just before the add and just after it. */
  readonly before: readonly Line[];
  readonly after: readonly Line[];
  readonly lateId: string;
  /** The seed-2 entrant: RB4-L4's lowest-seeded bye holder in a bracket of eight with six seeded. */
  readonly expectedOpponent: string;
  /** `late_entry` as the add answered it, or undefined (the add carried none). */
  readonly answer: LateEntryWire | undefined;
}

/** The R2 items, every one counted. */
export function lateAddItems(o: LateAddObs): Item[] {
  const a = o.answer;
  const items: Item[] = [{ ok: a !== undefined && a.format === "knockout", note: a === undefined ? "the add answered no late_entry - a started knockout owes one" : `the add answered a ${a.format} late entry, expected a knockout one` }];
  if (a === undefined || a.format !== "knockout") return items;
  items.push(
    { ok: a.case === "bye", note: `case ${a.case}, expected bye (X-LE-3: a free bye is taken at once)` },
    { ok: a.entrant_id === o.lateId, note: `the answer names entrant ${a.entrant_id ?? "(none)"}, expected the newcomer ${o.lateId}` },
    { ok: a.opponent_id === o.expectedOpponent, note: `opponent ${a.opponent_id ?? "(none)"}, expected the seed-2 bye holder ${o.expectedOpponent} (RB4-L4: the lowest-seeded holder's bye first)` },
  );
  const named = a.fixture_id === undefined ? undefined : o.after.find((l) => l.id === a.fixture_id);
  items.push({ ok: named !== undefined, note: `the named fixture ${a.fixture_id ?? "(none)"} is not among the stage's ${o.after.length} fixtures` });
  if (named !== undefined) {
    const was = o.before.find((l) => l.id === named.id);
    items.push(
      { ok: holds(named, o.lateId) && holds(named, o.expectedOpponent), note: `the named fixture seats ${seatsOf(named)}, expected the newcomer and ${o.expectedOpponent}` },
      { ok: was !== undefined && (was.home === null) !== (was.away === null) && holds(was, o.expectedOpponent), note: `the named fixture was ${was === undefined ? "absent" : seatsOf(was)} before the add, expected a bye line of ${o.expectedOpponent}` },
    );
  }
  items.push(
    { ok: seatedIn(o.after, o.lateId) === 1, note: `the newcomer sits in ${seatedIn(o.after, o.lateId)} fixture(s), expected exactly 1` },
    { ok: o.after.length === o.before.length, note: `${o.after.length} fixtures after the add, ${o.before.length} before - a bye line is reopened, no fixture is added` },
  );
  // Nothing else moved, one item per fixture the add did not name - except the line the bye holder had ADVANCED into: reopening her
  // bye retracts that advance (she must win the match first), so that line loses her seat and keeps everything else.
  let retracted = 0;
  for (const b of o.before) {
    if (b.id === a.fixture_id) continue;
    const x = o.after.find((l) => l.id === b.id);
    const advanced = holds(b, o.expectedOpponent);
    if (advanced) retracted++;
    const want = advanced ? `${b.home === o.expectedOpponent ? "-" : (b.home ?? "-")}/${b.away === o.expectedOpponent ? "-" : (b.away ?? "-")}` : seatsOf(b);
    items.push({ ok: x !== undefined && seatsOf(x) === want && x.status === b.status, note: `${b.id}: ${seatsOf(b)} ${b.status} before, ${x === undefined ? "gone" : `${seatsOf(x)} ${x.status}`} after, expected ${want} ${b.status}${advanced ? " (the bye holder's advance retracted)" : ""} - the add moved a fixture it did not name` });
  }
  items.push({ ok: retracted === 1, note: `${retracted} line(s) held the bye holder ${o.expectedOpponent} besides the bye line, expected exactly the 1 she advanced into` });
  return items;
}

// --- R10: an automatic arrival waits, then the tap ---------------------------------------------------------------------------

export interface ReinstateObs {
  readonly target: string;
  readonly opponent: string;
  /** The round-1 line the target sat in before she withdrew. */
  readonly lineId: string;
  /** The stage's fixtures once the withdrawal answered, once the Reinstate answered, once the tap answered. */
  readonly afterWithdraw: readonly Line[];
  readonly afterReinstate: readonly Line[];
  readonly afterTap: readonly Line[];
  readonly reinstate: ReinstateOut | undefined;
  readonly tap: LateEntryWire | undefined;
  /** The reopened line's ledger length right after the tap: the withdrawal's forfeit and its reversal. */
  readonly ledgerAfterTap: number;
}

/** The R10 items, every one counted. */
export function reinstateItems(o: ReinstateObs): Item[] {
  const items: Item[] = [];
  // Guards (the premises the checks below stand on): the withdrawal walked the opponent over and she moved on.
  const walked = o.afterWithdraw.find((l) => l.id === o.lineId);
  items.push(
    { ok: walked !== undefined && winnerOf(walked.outcome) === o.opponent, note: `after the withdrawal the line ${o.lineId} reads ${walked === undefined ? "absent" : `${walked.status}/${winnerOf(walked.outcome) ?? "(none)"}`}, expected a walkover to ${o.opponent}` },
    { ok: seatedIn(o.afterWithdraw, o.opponent) >= 2, note: `the opponent sits in ${seatedIn(o.afterWithdraw, o.opponent)} fixture(s) after the walkover, expected her line and the next round's` },
  );
  const r = o.reinstate;
  items.push(
    { ok: r !== undefined && r.late_entry !== null && r.late_entry.format === "knockout", note: r === undefined ? "no Reinstate answer" : `the Reinstate answered ${r.late_entry === null ? "no late_entry" : `a ${r.late_entry.format} late entry`}, expected a knockout one` },
    { ok: r?.late_entry?.case === "waiting", note: `the Reinstate answered case ${r?.late_entry?.case ?? "(none)"}, expected waiting (K13: an automatic arrival is never placed by the app)` },
  );
  // Nothing in the bracket moved on the Reinstate: one item per fixture.
  for (const b of o.afterWithdraw) {
    const x = o.afterReinstate.find((l) => l.id === b.id);
    items.push({ ok: x !== undefined && seatsOf(x) === seatsOf(b) && x.status === b.status, note: `${b.id}: ${seatsOf(b)} ${b.status} before the Reinstate, ${x === undefined ? "gone" : `${seatsOf(x)} ${x.status}`} after - an automatic arrival was placed by the app` });
  }
  const t = o.tap;
  items.push(
    { ok: t?.case === "withdrawn_slot", note: `the tap answered case ${t?.case ?? "(none)"}, expected withdrawn_slot (their own walked-over seat back)` },
    { ok: t?.withdrawn_id === o.target && t?.entrant_id === o.target, note: `the tap names ${t?.entrant_id ?? "(none)"} taking ${t?.withdrawn_id ?? "(none)"}'s seat, expected ${o.target} taking her own` },
  );
  const back = o.afterTap.find((l) => l.id === o.lineId);
  items.push(
    { ok: back !== undefined && holds(back, o.target) && holds(back, o.opponent), note: `after the tap the line ${o.lineId} seats ${back === undefined ? "nobody (gone)" : seatsOf(back)}, expected ${o.target} and ${o.opponent}` },
    { ok: back !== undefined && PENDING_STATUSES.includes(back.status) && back.outcome === null, note: `after the tap the line reads ${back?.status ?? "absent"}/${JSON.stringify(back?.outcome ?? null)}, expected it playable again with no result (the walkover reversed)` },
    { ok: seatedIn(o.afterTap, o.opponent) === 1, note: `after the tap the opponent sits in ${seatedIn(o.afterTap, o.opponent)} fixture(s), expected only her round-1 line (the walkover's advance undone)` },
    { ok: seatedIn(o.afterTap, o.target) === 1, note: `after the tap the reinstated player sits in ${seatedIn(o.afterTap, o.target)} fixture(s), expected exactly her round-1 line` },
    { ok: o.ledgerAfterTap === R10_REVERSED_EVENTS, note: `the reopened line's ledger holds ${o.ledgerAfterTap} event(s), expected the walkover and its reversal (${R10_REVERSED_EVENTS})` },
  );
  // The lines the tap had no business with: every fixture that seated neither of the two, before and after.
  for (const b of o.afterReinstate) {
    if (holds(b, o.target) || holds(b, o.opponent) || b.id === o.lineId) continue;
    const x = o.afterTap.find((l) => l.id === b.id);
    items.push({ ok: x !== undefined && seatsOf(x) === seatsOf(b) && x.status === b.status, note: `${b.id}: ${seatsOf(b)} ${b.status} before the tap, ${x === undefined ? "gone" : `${seatsOf(x)} ${x.status}`} after - the tap moved a fixture of neither player` });
  }
  return items;
}

// --- R6: a lucky loser takes a departed qualifier's seat -----------------------------------------------------------------------

export interface LuckyObs {
  readonly departed: string;
  readonly cut: number;
  /** The qualifying (source) stage and the main draw (destination) as they stood at the end of the run. */
  readonly qualifying: readonly Line[];
  readonly main: readonly Line[];
  readonly seedOf: (id: string) => number;
}

/** The loser of a decided, non-third-place line that was PLAYED (an award is a walkover or a bye: RB4-V5 - it never draws), else null. */
function playedLoser(l: Line): string | null {
  const o = l.outcome;
  if (l.thirdPlace || o === null || o.kind !== "win") return null;
  return l.home === o.winner ? l.away : l.home;
}

/** The loser of a decided, non-third-place line however it ended (a win, or an award - a walkover), else null. */
function lineLoser(l: Line): string | null {
  const o = l.outcome;
  if (l.thirdPlace || o === null) return null;
  if (o.kind === "award") return o.loser;
  if (o.kind !== "win") return null;
  return l.home === o.winner ? l.away : l.home;
}

/** The semifinals of a bracket: its non-third-place lines of the round before the final (the final is the last round). */
export function semifinalsOf(lines: readonly Line[]): Line[] {
  const rounds = lines.filter((l) => !l.thirdPlace).map((l) => l.round ?? 0);
  const last = Math.max(...rounds);
  return lines.filter((l) => !l.thirdPlace && l.round === last - 1);
}

/** The qualifiers of a four-wide cut, read off the lines: the final's two sides and the two semifinal losers (a finishing band 3-4,
 *  whole - T15). Null while the final or a semifinal is undecided - the caller fails by name, never guesses. */
export function qualifiersOf(lines: readonly Line[]): ReadonlySet<string> | null {
  const rounds = lines.filter((l) => !l.thirdPlace).map((l) => l.round ?? 0);
  const last = Math.max(...rounds);
  const final = lines.find((l) => !l.thirdPlace && l.round === last);
  const semis = semifinalsOf(lines);
  if (final === undefined || final.home === null || final.away === null || final.outcome === null || semis.length !== 2) return null;
  const losers = semis.map(lineLoser);
  return losers.every((x): x is string => x !== null) ? new Set([final.home, final.away, ...(losers as string[])]) : null;
}

/** RB4-V2 / V4 / V5: the best loser below the cut - the latest round lost, then the better seed, never a walkover loser and never
 *  a qualifier or the one who left. Null when nobody qualifies for it. */
export function bestLoser(lines: readonly Line[], qualifiers: ReadonlySet<string>, departed: string, seedOf: (id: string) => number): string | null {
  const pool = lines.flatMap((l) => {
    const loser = playedLoser(l);
    return loser === null || qualifiers.has(loser) || loser === departed ? [] : [{ id: loser, round: l.round ?? 0 }];
  });
  pool.sort((a, b) => b.round - a.round || seedOf(a.id) - seedOf(b.id));
  return pool[0]?.id ?? null;
}

/** The R6 items, every one counted. */
export function luckyLoserItems(o: LuckyObs): Item[] {
  const qualifiers = qualifiersOf(o.qualifying);
  const items: Item[] = [
    { ok: o.cut === R6_CUT, note: `the main draw's cut is ${o.cut} wide, this script reads a ${R6_CUT}-wide one (the builder's default)` },
    { ok: qualifiers !== null && qualifiers.size === R6_CUT, note: "the qualifying stage's final and semifinals are not all decided, so the cut cannot be read off the lines" },
    { ok: qualifiers?.has(o.departed) === true, note: `the departed ${o.departed} was not one of the four qualifiers - the script withdrew the wrong player` },
  ];
  if (qualifiers === null) return items;
  const lucky = bestLoser(o.qualifying, qualifiers, o.departed, o.seedOf);
  const seated = new Set(o.main.filter((l) => l.round === 1).flatMap((l) => [l.home, l.away]).filter((s): s is string => s !== null));
  items.push(
    { ok: lucky !== null, note: "no loser below the cut is eligible, so the lucky loser the rulebook names cannot be derived" },
    { ok: !o.main.some((l) => holds(l, o.departed)), note: `the departed ${o.departed} is still seated in the main draw` },
    { ok: lucky !== null && seated.has(lucky), note: `the best loser below the cut (${lucky ?? "(none)"}) is not seated in the main draw's round 1` },
    { ok: seated.size === o.cut, note: `the main draw's round 1 seats ${seated.size} entrant(s), expected the cut's ${o.cut}` },
  );
  for (const q of qualifiers) {
    if (q === o.departed) continue;
    items.push({ ok: seated.has(q), note: `qualifier ${q} is not seated in the main draw's round 1` });
  }
  // Nobody was walked over in her place: every main-draw line is free of a withdrawal award.
  for (const l of o.main) {
    const w = l.outcome !== null && l.outcome.kind === "award" && l.outcome.reason === "withdrew";
    items.push({ ok: !w, note: `${l.id}: a withdrawal walkover in the main draw - the departed qualifier's opponent was walked over instead of a lucky loser taking the seat` });
  }
  return items;
}

// --- the scripts -----------------------------------------------------------------------------------------------------------------

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

const rootLines = async (ctx: ScenarioContext, setup: DivisionSetup, stageId: string): Promise<Line[]> => (await ctx.driver.listFixtures(setup.division.id)).filter((f) => f.stage_id === stageId).map(lineOf);

/** The shared tail: play the division out and judge the run by the standard life checks beside the script's own. */
async function finish(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, own: ReturnType<typeof assertion>, hooks: Parameters<typeof playDivision>[3] = {}): Promise<ScenarioOutput> {
  const plays = await playDivision(ctx, rec, setup, hooks);
  const observed = await snapshot(ctx, rec, setup, plays, { configEdit: null, withdrawal: null });
  return {
    observed,
    events: rec.events,
    notes: rec.notes,
    assertions: [builtAsPosted(setup.built, observed), foldParity(rec), resultsAsPosted(rec, observed), own, stageCompleted(observed), loopBounded(rec, observed), advanceSeededAsDeclared(plays, observed, rec.withdrawn), lineupsPut(rec, setup)],
  };
}

/** R2: six seeds start a bracket of eight; the organiser then adds a seventh player. */
const r2: Scenario = {
  key: "W4A_R2",
  entrantCount: R2_FIELD,
  canaryCheck: null,
  async run(ctx) {
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, R2_FIELD);
    const before = await rootLines(ctx, setup, setup.stage.id);
    const seed = R2_FIELD + 1;
    const members = setup.kind === "team" && !setup.rosterless ? rosterMembers(ctx.spec.sport, ctx.cfg, seed) : undefined;
    const input = { displayName: entrantName(setup.kind, seed), seed, kind: setup.kind, ...(members !== undefined ? { members } : {}) };
    const added = await attempt(rec, "the late add", () => ctx.driver.addEntrants(setup.division.id, [input]));
    if (added instanceof RefusedCall || added[0] === undefined) {
      // The product refused (or answered nothing): the run is judged on that. Nothing was added, so the field stays the six.
      const items: Item[] = [{ ok: false, note: added instanceof RefusedCall ? `the add into a started knockout with a free bye was refused ${added.status} ${added.code ?? "(no code)"}` : "the add answered no entrant" }];
      return finish(ctx, rec, setup, assertion("w4a-r2-late-entry-placed", items));
    }
    const late = added[0];
    const after = await rootLines(ctx, setup, setup.stage.id);
    const stored = await ctx.driver.listEntrants(setup.division.id);
    const seated = setup.kind === "team" && !setup.rosterless;
    const rosters = new Map(setup.rosters);
    if (seated) rosters.set(late.id, await ctx.driver.entrantMembers(late.id));
    const grown: DivisionSetup = {
      ...setup,
      entrants: [...setup.entrants, late],
      entrantIds: new Set([...setup.entrantIds, late.id]),
      rosters,
      built: { ...setup.built, posted: { ...setup.built.posted, entrants: [...setup.built.posted.entrants, { displayName: input.displayName, seed }] }, entrants: stored, echo: [...setup.built.echo, late] },
      seedOf: (id) => (id === late.id ? seed : setup.seedOf(id)),
      idOfSeed: (s) => (s === seed ? late.id : setup.idOfSeed(s)),
    };
    const own = assertion("w4a-r2-late-entry-placed", lateAddItems({ before, after, lateId: late.id, expectedOpponent: setup.idOfSeed(2), answer: late.late_entry }));
    return finish(ctx, rec, grown, own);
  },
};

/** R10: seed 3 withdraws from a full bracket, is reinstated (an automatic arrival), and the organiser taps her back in. */
const r10: Scenario = {
  key: "W4A_R10",
  entrantCount: FULL_FIELD,
  canaryCheck: null,
  async run(ctx) {
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, FULL_FIELD);
    const { reinstate, placeLateEntrant } = ctx.driver;
    if (reinstate === undefined || placeLateEntrant === undefined) throw new DriverMisuse("driver: W4A_R10 needs reinstate and placeLateEntrant - the HTTP driver has them, a layer that does not drive the path says so");
    const target = setup.idOfSeed(3);
    const first = (await rootLines(ctx, setup, setup.stage.id)).find((l) => l.round === 1 && holds(l, target));
    if (first === undefined) throw new Error(`scenario: seed 3 (${target}) holds no round-1 line of the started bracket`);
    const opponent = other(first, target);
    if (opponent === null) throw new Error(`scenario: seed 3's round-1 line ${first.id} has no opponent - a field of ${FULL_FIELD} owes none a bye`);
    const w = await ctx.driver.withdraw(target);
    rec.notes.push(`withdrawal of seed 3: policy ${w.policy}`);
    const afterWithdraw = await rootLines(ctx, setup, setup.stage.id);
    const back = await attempt(rec, "the Reinstate", () => reinstate.call(ctx.driver, target));
    const afterReinstate = await rootLines(ctx, setup, setup.stage.id);
    const tap = await attempt(rec, "the tap", () => placeLateEntrant.call(ctx.driver, setup.stage.id, target));
    const afterTap = await rootLines(ctx, setup, setup.stage.id);
    const ledgerAfterTap = (await ctx.driver.fixtureState(first.id)).last_seq;
    const own = assertion("w4a-r10-arrival-waits-then-taps", reinstateItems({
      target, opponent, lineId: first.id, afterWithdraw, afterReinstate, afterTap, ledgerAfterTap,
      reinstate: back instanceof RefusedCall ? undefined : back, tap: tap instanceof RefusedCall ? undefined : tap,
    }));
    // The two events on the reopened line are the product's (the walkover, its reversal), counted by the check above: tell the recorder, so
    // the harness's own play on the line is folded and compared as on any other (common.ts productWrote).
    if (ledgerAfterTap === R10_REVERSED_EVENTS) rec.productWrote.set(first.id, R10_REVERSED_EVENTS);
    return finish(ctx, rec, setup, own);
  },
};

/** R6: qualifying_main of eight at a cut of four; a semifinal loser (a qualifier, the 3-4 band) withdraws once the qualifying stage is played,
 *  before it completes - the moment the cut is still being drawn (lucky-loser.ts: `timing: "setup"` before the confirm). */
const r6: Scenario = {
  key: "W4A_R6",
  entrantCount: FULL_FIELD,
  canaryCheck: null,
  async run(ctx) {
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, FULL_FIELD);
    const [qualifying, main] = setup.stages;
    if (qualifying === undefined || main === undefined) throw new Error(`scenario: qualifying_main built ${setup.stages.length} stage(s), expected the qualifying stage and the main draw`);
    // The cut, read off the posted main-draw body (rankRange 1..q), and refused by name when it is not the one this script reads.
    const body = setup.built.posted.stages.find((b) => b.seq === main.seq);
    const take = (body?.progression?.sources[0]?.take[0] ?? null) as { kind?: string; to?: number } | null;
    if (take === null || take.kind !== "rankRange" || typeof take.to !== "number") throw new Error(`scenario: the main draw's progression is not a rank cut (${JSON.stringify(take)})`);
    const dep: { id: string | null } = { id: null };
    const plays = await playDivision(ctx, rec, setup, {
      beforeComplete: async () => {
        // A qualifier of the 3-4 band: the first semifinal's loser - read off the decided lines, never assumed.
        const semi = semifinalsOf(await rootLines(ctx, setup, qualifying.id))[0];
        const loser = semi === undefined ? null : lineLoser(semi);
        if (loser === null) { rec.notes.push("no semifinal is decided before Complete - no qualifier was withdrawn"); return; }
        dep.id = loser;
        const w = await ctx.driver.withdraw(loser);
        rec.notes.push(`withdrawal of the semifinal loser ${loser}: policy ${w.policy}`);
      },
    });
    const observed = await snapshot(ctx, rec, setup, plays, { configEdit: null, withdrawal: null });
    const lines = await ctx.driver.listFixtures(setup.division.id);
    const departed = dep.id;
    const items: Item[] = departed === null
      ? [{ ok: false, note: "no qualifier was withdrawn before Complete (no semifinal was decided), so nothing was asked of the lucky-loser seam" }]
      : luckyLoserItems({ departed, cut: take.to, qualifying: lines.filter((f) => f.stage_id === qualifying.id).map(lineOf), main: lines.filter((f) => f.stage_id === main.id).map(lineOf), seedOf: setup.seedOf });
    return {
      observed,
      events: rec.events,
      notes: rec.notes,
      assertions: [builtAsPosted(setup.built, observed), foldParity(rec), resultsAsPosted(rec, observed), assertion("w4a-r6-lucky-loser-takes-the-seat", items), stageCompleted(observed), loopBounded(rec, observed), lineupsPut(rec, setup)],
    };
  },
};

export const w4aScenarios: Readonly<Record<W4aScenarioKey, Scenario>> = Object.freeze({ W4A_R2: r2, W4A_R10: r10, W4A_R6: r6 });
