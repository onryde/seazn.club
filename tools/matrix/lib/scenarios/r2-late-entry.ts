// W5 app PR A, Task 24 (T5-b): R2 - a late player added to a RUNNING league or group, in each case the rulebook tries in order (RB5-L15):
// nothing started -> Rebuild offered (L7); a result in -> the catch-up (L3); the stage complete -> refused by name (L8). Planned ONLY by
// `--set w1-driving --scenario W5A_R2` (w5a-cells.ts), as W4A_R2 is.
//
// One division, four acts, every one through the real doors (the HTTP driver's add, tap and Complete):
//   1. a newcomer is added before any line is played        -> case rebuild_offered (RB5-L7), and the catch-up the notice offers as the
//      alternative IS the add's write (RB5-L15; roundrobin-late-entry.ts: "the catch-up set is written unless the add asked to rebuild");
//   2. the organiser taps the same newcomer again            -> refused by name (RR_LATE_ENTRY_ALREADY_PLACED), nothing moves (X-CU-8);
//   3. one line is decided, a second newcomer is added      -> case catch_up, and they owe the first newcomer too (RB5-L16);
//   4. the stage is played out and completed; a third newcomer -> refused by name, nothing seated (RB5-L8).
//
// Expected values are the rulebook's, read off the lines the product listed BEFORE each act, never off its answer:
//   RB5-L3  one fixture per leg against every member of the pool (or the league); an opponent holding the bye in a future, unstarted round
//           of the DRAWN rounds takes the fixture in that round, every other owed fixture is appended as a catch-up round after the last round,
//           one fixture per round, in the order of the rounds the opponents already played (then the seed order);
//   RB5-L4  nothing already drawn changes (seats and status); RB5-L9 a group newcomer joins the smallest pool (ties: the pool the seed snake
//           gives the (n+1)th seed); RB5-L13 the new lines are unscheduled; RB5-L16 two late entrants in one pool owe each other.
// The rows play `legs: 1` (catalogue.ts), so a pair owes ONE fixture (a guard below names a posted body that says otherwise).
import { DriverMisuse, RefusedCall, type EntrantRow, type LateEntryWire, type OrganiserDriver } from "../driver/types.ts";
import { assertion, type Item } from "./assertions.ts";
import { Recorder, decideFixture, defaultPolicy, setUpDivision, stageDrawsOk, type DivisionSetup } from "./common.ts";
import { entrantName, rosterMembers } from "./rosters.ts";
import { W5A_SCENARIO_KEYS, type Scenario, type ScenarioContext, type W5aScenarioKey } from "./types.ts";
import { w5aField } from "../w5a-cells.ts";
import { attempt, byPool, finishRun, poolsOf, seatsOf, stageLines, type TLine } from "./w5a-table.ts";

export const W5A_SCENARIOS: readonly string[] = W5A_SCENARIO_KEYS;

/** The code a late add answers (or is refused with) once the table stage is complete (RB5-L8; api-v1 TableLateEntryResult `reason`). */
export const STAGE_COMPLETE_CODE = "RR_LATE_ENTRY_STAGE_COMPLETE";
/** The code a second tap on a placed player is refused with (X-CU-8). */
export const ALREADY_PLACED_CODE = "RR_LATE_ENTRY_ALREADY_PLACED";

const holds = (l: TLine, id: string): boolean => l.home === id || l.away === id;
const other = (l: TLine, id: string): string | null => (l.home === id ? l.away : l.away === id ? l.home : null);

/** The key of the pool the (n+1)th seed lands in on a snake draw over `pools` pools (seed s -> row floor((s-1)/P), left to right on even
 *  rows, right to left on odd ones). RB5-L9's tie rule; the keys are the product's own order (A, B, ...), as the pools route lists them. */
export function snakePoolIndex(seed: number, pools: number): number {
  const i = seed - 1;
  const row = Math.floor(i / pools);
  const col = i % pools;
  return row % 2 === 0 ? col : pools - 1 - col;
}

export interface LateAddObs {
  /** What the act is called in the evidence. */
  readonly label: string;
  readonly stageKind: "league" | "group";
  /** The stage's lines just before the act and just after it; `drawn`: the lines as the DRAW first made them (the byes are the drawn rounds'). */
  readonly before: readonly TLine[];
  readonly after: readonly TLine[];
  readonly drawn: readonly TLine[];
  readonly lateId: string;
  readonly newcomerSeed: number;
  /** Who was in the field when the draw was made: only they hold a drawn bye. */
  readonly originals: ReadonlySet<string>;
  readonly answer: LateEntryWire | undefined;
  /** pool id -> key (empty for a league), the pools route's own answer. */
  readonly poolKeyOf: ReadonlyMap<string, string>;
  readonly seedOf: (id: string) => number;
}

const poolLines = (lines: readonly TLine[], poolId: string | null): TLine[] => lines.filter((l) => l.poolId === poolId);
const lastRound = (lines: readonly TLine[]): number => Math.max(0, ...lines.map((l) => l.round ?? 0));
const earliestRound = (lines: readonly TLine[], id: string): number => Math.min(...lines.filter((l) => holds(l, id)).map((l) => l.round ?? 0));

/** The catch-up items (RB5-L3, L4, L9, L13, L16), every one counted. `wantCase`: the case the add answers - `catch_up`, or `rebuild_offered` while
 *  nothing has started (RB5-L7 / L15: the lines are the same set, written beside the offer). */
export function catchUpItems(o: LateAddObs, wantCase: "catch_up" | "rebuild_offered" = "catch_up"): Item[] {
  const a = o.answer;
  const items: Item[] = [
    { ok: a !== undefined && a.format === o.stageKind, note: a === undefined ? `${o.label}: the add answered no late_entry - a running ${o.stageKind} owes one` : `${o.label}: the add answered a ${a.format} late entry, expected a ${o.stageKind} one` },
  ];
  if (a === undefined || a.format !== o.stageKind) return items;
  items.push(
    { ok: a.case === wantCase, note: `${o.label}: case ${a.case}, expected ${wantCase} (${wantCase === "catch_up" ? "RB5-L3: a result is in, so the newcomer is seated against the pool" : "RB5-L7: nothing in the stage has started, so Rebuild is offered beside the catch-up"})` },
    { ok: a.source === "organiser", note: `${o.label}: source ${a.source ?? "(none)"}, expected organiser (the organiser's own add or tap)` },
    { ok: a.entrant_id === o.lateId, note: `${o.label}: the answer names entrant ${a.entrant_id ?? "(none)"}, expected the newcomer ${o.lateId}` },
  );
  // --- the pool the newcomer joined (RB5-L9) ---
  const pools = byPool(o.before);
  let poolId: string | null = null;
  if (o.stageKind === "group") {
    const keyed = [...o.poolKeyOf.entries()];
    const hit = keyed.find(([, key]) => key === a.pool_key);
    items.push({ ok: hit !== undefined, note: `${o.label}: pool_key ${a.pool_key ?? "(none)"} names none of the stage's pools (${keyed.map(([, k]) => k).join(", ")})` });
    if (hit === undefined) return items;
    poolId = hit[0];
    const sizes = new Map([...pools.entries()].map(([id, ls]) => [id, seatsOf(ls).size]));
    const smallest = Math.min(...sizes.values());
    items.push({ ok: sizes.get(poolId) === smallest, note: `${o.label}: the newcomer joined pool ${a.pool_key} of ${sizes.get(poolId)}, expected a smallest pool (${smallest}, RB5-L9)` });
    const ordered = [...keyed].sort((x, y) => x[1].localeCompare(y[1]));
    const snake = ordered[snakePoolIndex(o.newcomerSeed, ordered.length)];
    const snakeIsSmallest = snake !== undefined && sizes.get(snake[0]) === smallest;
    items.push({ ok: !snakeIsSmallest || snake[0] === poolId, note: `${o.label}: the seed snake gives seed ${o.newcomerSeed} pool ${snake?.[1] ?? "(none)"}, which is among the smallest, but the newcomer joined ${a.pool_key} (RB5-L9's tie rule)` });
  } else {
    items.push({ ok: a.pool_key === undefined, note: `${o.label}: a league newcomer names pool ${a.pool_key ?? ""}, expected none` });
  }
  // --- who they owe ---
  const here = poolLines(o.before, poolId);
  const members = seatsOf(here);
  const mine = o.after.filter((l) => holds(l, o.lateId));
  const opponents = mine.map((l) => other(l, o.lateId));
  items.push(
    { ok: members.size > 0, note: `${o.label}: the pool held no member before the add - the script read the wrong pool` },
    { ok: mine.length === members.size, note: `${o.label}: the newcomer sits in ${mine.length} line(s), expected one per member of the pool (${members.size}, RB5-L3)` },
    { ok: opponents.every((e) => e !== null && members.has(e)) && new Set(opponents).size === opponents.length && new Set(opponents).size === members.size, note: `${o.label}: the newcomer's opponents (${opponents.map((e) => e ?? "-").join(",")}) are not the pool's members exactly once each` },
    { ok: mine.every((l) => l.poolId === poolId), note: `${o.label}: a newcomer line sits outside pool ${poolId ?? "(league)"}` },
    { ok: mine.every((l) => l.status === "scheduled" && l.outcome === null), note: `${o.label}: a newcomer line is not an open, unplayed line` },
    { ok: o.after.length === o.before.length + members.size, note: `${o.label}: ${o.after.length} lines after the add, ${o.before.length} before, expected ${members.size} more` },
  );
  // --- RB5-L4: nothing already drawn changed ---
  for (const b of o.before) {
    const x = o.after.find((l) => l.id === b.id);
    items.push({ ok: x !== undefined && x.home === b.home && x.away === b.away && x.status === b.status && x.round === b.round && x.poolId === b.poolId, note: `${o.label}: ${b.id}: ${b.home}/${b.away} round ${b.round} ${b.status} before, ${x === undefined ? "gone" : `${x.home}/${x.away} round ${x.round} ${x.status}`} after - the add changed a line it did not name (RB5-L4)` });
  }
  // --- where each fixture landed (RB5-L3): a bye in a future, unstarted DRAWN round, else a catch-up round ---
  const drawnLast = lastRound(poolLines(o.drawn, poolId));
  const rounds = Array.from({ length: drawnLast }, (_, i) => i + 1);
  const started = (r: number): boolean => here.some((l) => l.round === r && l.status !== "scheduled");
  // RB5-L3: "after the last drawn round" - the STAGE's last, not the pool's (a smaller pool's round count is shorter, the stage's rounds are shared).
  const poolLast = lastRound(o.before);
  const named = a.fixtures ?? [];
  items.push(
    { ok: named.length === mine.length && named.every((f) => mine.some((l) => l.id === f.fixture_id)) && mine.every((l) => named.some((f) => f.fixture_id === l.id)), note: `${o.label}: the answer names ${named.length} fixture(s), not the newcomer's ${mine.length} lines exactly` },
    { ok: named.every((f) => f.scheduled === false), note: `${o.label}: a catch-up line was written scheduled - RB5-L13: new lines are unscheduled and flagged to the desk` },
  );
  let appended = 0;
  const catchUp: { line: TLine; opponent: string }[] = [];
  for (const m of members) {
    const line = mine.find((l) => holds(l, m));
    const f = line === undefined ? undefined : named.find((x) => x.fixture_id === line.id);
    if (line === undefined || f === undefined) continue;
    const absent = rounds.filter((r) => !here.some((l) => l.round === r && holds(l, m)));
    const byeRound = o.originals.has(m) && absent.length === 1 ? absent[0] : null;
    const takesBye = byeRound !== null && !started(byeRound);
    if (takesBye) {
      items.push({ ok: f.placement === "bye_slot" && line.round === byeRound, note: `${o.label}: vs ${m}: placed ${f.placement} in round ${line.round}, expected the bye slot of round ${byeRound} (RB5-L3: ${m} sits out that future, unstarted round)` });
    } else {
      appended++;
      catchUp.push({ line, opponent: m });
      items.push({ ok: f.placement === "catch_up_round" && (line.round ?? 0) > poolLast, note: `${o.label}: vs ${m}: placed ${f.placement} in round ${line.round}, expected a catch-up round after the stage's round ${poolLast}${byeRound !== null ? ` (${m}'s bye is in round ${byeRound}, which has started)` : ""}` });
    }
  }
  items.push({ ok: a.appended_rounds === appended, note: `${o.label}: appended_rounds ${a.appended_rounds ?? "(none)"}, expected ${appended} (one per fixture not taking a bye slot)` });
  // one per round, consecutive after the last round, in the order of the rounds the opponents already played, then the seed order
  const byRound = [...catchUp].sort((x, y) => (x.line.round ?? 0) - (y.line.round ?? 0));
  items.push({ ok: byRound.every((c, i) => c.line.round === poolLast + 1 + i), note: `${o.label}: the catch-up rounds are ${byRound.map((c) => c.line.round).join(",")}, expected ${byRound.map((_, i) => poolLast + 1 + i).join(",")} (one fixture per round, after round ${poolLast})` });
  const want = [...catchUp].sort((x, y) => earliestRound(here, x.opponent) - earliestRound(here, y.opponent) || o.seedOf(x.opponent) - o.seedOf(y.opponent)).map((c) => c.opponent);
  items.push({ ok: byRound.map((c) => c.opponent).join() === want.join(), note: `${o.label}: the catch-up order is ${byRound.map((c) => c.opponent).join(",")}, expected ${want.join(",")} (the opponents' earliest played round, then the seed order, RB5-L6)` });
  return items;
}

/** Act 2 (X-CU-8): the tap on a player the add already placed is refused by name and moves nothing. */
export function alreadyPlacedItems(o: { label: string; refusal: RefusedCall | undefined; before: readonly TLine[]; after: readonly TLine[] }): Item[] {
  return [
    { ok: o.refusal !== undefined, note: `${o.label}: the tap on an already placed newcomer was accepted - a second tap must refuse (RR_LATE_ENTRY_ALREADY_PLACED)` },
    { ok: o.refusal?.code === ALREADY_PLACED_CODE, note: `${o.label}: refused with ${o.refusal?.code ?? "(no code)"}, expected ${ALREADY_PLACED_CODE}` },
    { ok: o.after.length === o.before.length, note: `${o.label}: ${o.after.length} lines after the refused tap, ${o.before.length} before - one catch-up set per player` },
    ...o.before.map((b): Item => {
      const x = o.after.find((l) => l.id === b.id);
      return { ok: x !== undefined && x.home === b.home && x.away === b.away && x.status === b.status && x.round === b.round, note: `${o.label}: ${b.id} changed on a refused tap` };
    }),
  ];
}

/** Act 4 (RB5-L8): the stage is complete - a late add is refused by name and seats nobody. */
export function refusedLateItems(o: { label: string; refusal: RefusedCall | undefined; answer: LateEntryWire | undefined; before: readonly TLine[]; after: readonly TLine[] }): Item[] {
  // The product may refuse the add (a throw, the entrant rolled back) or answer it `refused` (the entrant kept, listed): both name the code.
  const code = o.refusal !== undefined ? o.refusal.code : o.answer?.case === "refused" ? o.answer.reason : null;
  return [
    { ok: o.refusal !== undefined || o.answer?.case === "refused", note: `${o.label}: a late add to a COMPLETE table was accepted (case ${o.answer?.case ?? "none"}) - RB5-L8 refuses it` },
    { ok: code === STAGE_COMPLETE_CODE, note: `${o.label}: refused with ${code ?? "(no code)"}, expected ${STAGE_COMPLETE_CODE}` },
    { ok: o.after.length === o.before.length, note: `${o.label}: ${o.after.length} lines after the refused add, ${o.before.length} before` },
    ...o.before.map((b): Item => {
      const x = o.after.find((l) => l.id === b.id);
      return { ok: x !== undefined && x.home === b.home && x.away === b.away && x.status === b.status, note: `${o.label}: ${b.id} changed on a refused add` };
    }),
  ];
}

// --- the script ---------------------------------------------------------------------------------------------------------------

/** The two optional acts the script needs: the HTTP driver has them, a layer that does not drive the path does not. */
function drivesTableLateEntry(d: OrganiserDriver): d is OrganiserDriver & Required<Pick<OrganiserDriver, "placeLateEntrant" | "stagePools">> {
  return d.placeLateEntrant !== undefined && d.stagePools !== undefined;
}

/** The setup grown by one entrant the script added: the field, the seed maps, the posted-readback and (a team) the roster, as W4A_R2 grows it. */
export async function withLate(ctx: ScenarioContext, setup: DivisionSetup, late: EntrantRow, seed: number, displayName: string): Promise<DivisionSetup> {
  const stored = await ctx.driver.listEntrants(setup.division.id);
  const seated = setup.kind === "team" && !setup.rosterless;
  const rosters = new Map(setup.rosters);
  if (seated) rosters.set(late.id, await ctx.driver.entrantMembers(late.id));
  return {
    ...setup,
    entrants: [...setup.entrants, late],
    entrantIds: new Set([...setup.entrantIds, late.id]),
    rosters,
    built: { ...setup.built, posted: { ...setup.built.posted, entrants: [...setup.built.posted.entrants, { displayName, seed }] }, entrants: stored, echo: [...setup.built.echo, late] },
    seedOf: (id) => (id === late.id ? seed : setup.seedOf(id)),
    idOfSeed: (s) => (s === seed ? late.id : setup.idOfSeed(s)),
  };
}

const r2: Scenario = {
  key: "W5A_R2",
  entrantCount: 5,
  canaryCheck: null,
  async run(ctx) {
    const rec = new Recorder();
    const field = w5aField("W5A_R2", ctx.spec.row);
    let setup = await setUpDivision(ctx, rec, field);
    const d = ctx.driver;
    if (!drivesTableLateEntry(d)) throw new DriverMisuse("driver: W5A_R2 needs placeLateEntrant and stagePools - the HTTP driver has them, a layer that does not drive the path says so");
    const stage = setup.stage;
    if (stage.kind !== "league" && stage.kind !== "group") throw new Error(`scenario: W5A_R2's entry stage is a ${stage.kind}, not a table`);
    const stageKind = stage.kind;
    if (stage.config.legs !== undefined && Number(stage.config.legs) !== 1) throw new Error(`scenario: W5A_R2 reads a one-leg stage, the posted body says legs ${JSON.stringify(stage.config.legs)}`);
    const originals = new Set(setup.entrants.map((e) => e.id));
    const drawn = await stageLines(ctx, setup, stage.id);
    const poolKeyOf = new Map<string, string>(stageKind === "group" ? (await poolsOf(ctx, stage.id)).pools.map((p) => [p.id, p.key] as const) : []);
    const seedBase = field;
    const inputFor = (seed: number) => {
      const members = setup.kind === "team" && !setup.rosterless ? rosterMembers(ctx.spec.sport, ctx.cfg, seed) : undefined;
      return { displayName: entrantName(setup.kind, seed), seed, kind: setup.kind, ...(members !== undefined ? { members } : {}) };
    };
    const items: Item[] = [];
    const add = async (seed: number, what: string): Promise<{ late: EntrantRow | null; refusal: RefusedCall | undefined }> => {
      const input = inputFor(seed);
      const added = await attempt(rec, what, () => d.addEntrants(setup.division.id, [input]));
      if (added instanceof RefusedCall) return { late: null, refusal: added };
      return { late: added[0] ?? null, refusal: undefined };
    };
    const grow = async (late: EntrantRow, seed: number): Promise<void> => { setup = await withLate(ctx, setup, late, seed, entrantName(setup.kind, seed)); };

    // 1. nothing started -> Rebuild offered, the catch-up written beside it
    const e1Seed = seedBase + 1;
    const before1 = await stageLines(ctx, setup, stage.id);
    const first = await add(e1Seed, "the first late add");
    if (first.late === null) items.push({ ok: false, note: `the first late add (nothing started) was refused ${first.refusal?.status} ${first.refusal?.code ?? "(no code)"}, expected an offer of Rebuild (RB5-L7)` });
    else {
      const after1 = await stageLines(ctx, setup, stage.id);
      items.push(...catchUpItems({ label: "act 1 (nothing started)", stageKind, before: before1, after: after1, drawn, lateId: first.late.id, newcomerSeed: e1Seed, originals, answer: first.late.late_entry, poolKeyOf, seedOf: (id) => (id === first.late!.id ? e1Seed : setup.seedOf(id)) }, "rebuild_offered"));
      await grow(first.late, e1Seed);
      // 2. the tap on a player the add already placed
      const tap = await attempt(rec, "the tap on the first newcomer", () => d.placeLateEntrant(stage.id, first.late!.id));
      const after2 = await stageLines(ctx, setup, stage.id);
      items.push(...alreadyPlacedItems({ label: "act 2 (the second tap)", refusal: tap instanceof RefusedCall ? tap : undefined, before: after1, after: after2 }));
    }
    // 3. one line decided, a second newcomer: catch-up, owing the first as well
    const open = (await stageLines(ctx, setup, stage.id)).filter((l) => l.home !== null && l.away !== null && l.status === "scheduled" && l.outcome === null && (first.late === null || (!holds(l, first.late.id))));
    const fixtures = await d.listFixtures(setup.division.id);
    const target = [...open].sort((x, y) => (x.round ?? 0) - (y.round ?? 0))[0];
    const row = target === undefined ? undefined : fixtures.find((f) => f.id === target.id);
    if (row === undefined) items.push({ ok: false, note: "act 3: no original line was open to decide, so the stage cannot be started" });
    else {
      await decideFixture(ctx, rec, setup, row, defaultPolicy(setup, row, stageDrawsOk(ctx, stage), rec.decided), stage);
      const e2Seed = seedBase + 2;
      const before3 = await stageLines(ctx, setup, stage.id);
      const second = await add(e2Seed, "the second late add");
      if (second.late === null) items.push({ ok: false, note: `act 3: the second late add (a result is in) was refused ${second.refusal?.status} ${second.refusal?.code ?? "(no code)"}, expected the catch-up (RB5-L3)` });
      else {
        const after3 = await stageLines(ctx, setup, stage.id);
        items.push(...catchUpItems({ label: "act 3 (a result is in)", stageKind, before: before3, after: after3, drawn, lateId: second.late.id, newcomerSeed: e2Seed, originals, answer: second.late.late_entry, poolKeyOf, seedOf: setup.seedOf }));
        // RB5-L16: the two late entrants, when they share a pool, owe each other a fixture
        if (first.late !== null) {
          const together = after3.filter((l) => holds(l, first.late!.id) && holds(l, second.late!.id));
          const samePool = new Set(after3.filter((l) => holds(l, first.late!.id) || holds(l, second.late!.id)).map((l) => l.poolId));
          const pools = (id: string): Set<string | null> => new Set(after3.filter((l) => holds(l, id)).map((l) => l.poolId));
          const shared = [...pools(first.late.id)].some((p) => pools(second.late!.id).has(p));
          items.push({ ok: shared ? together.length === 1 : together.length === 0, note: `act 3: the two newcomers ${shared ? "share a pool and meet" + ` ${together.length} time(s), expected once (RB5-L16)` : `sit in different pools (${[...samePool].join(",")}) and meet ${together.length} time(s), expected never`}` });
        }
        await grow(second.late, e2Seed);
      }
    }
    // 4. play out and complete; then a third newcomer is refused by name
    const own = (): ReturnType<typeof assertion>[] => [assertion("w5a-r2-late-entry-cases", items)];
    const out = await finishRun(ctx, rec, setup, async () => {
      const e3Seed = seedBase + 3;
      const before4 = await stageLines(ctx, setup, stage.id);
      const third = await add(e3Seed, "the third late add");
      const after4 = await stageLines(ctx, setup, stage.id);
      items.push(...refusedLateItems({ label: "act 4 (the stage complete)", refusal: third.refusal, answer: third.late?.late_entry, before: before4, after: after4 }));
      return own();
    });
    return out;
  },
};

export const w5aR2Scenarios: Readonly<Partial<Record<W5aScenarioKey, Scenario>>> = Object.freeze({ W5A_R2: r2 });
