// The W2b forfeit-credit scenarios' own checks (Task 2 Step 4), kept pure — what the scenario recorded and what the
// product shows in, a counted CheckResult out — so each is judged on synthetic data as well as on a run. Every check
// counts its items and zero checked is a failure (R25, assertions.ts `assertion`); an abstain carries its reason.
// Expected values are the Appendix A rows' (X-RS-1, X-WO-1, X-RT-1, X-DW-1..4, X-AB-1/2, X-WD-1..4, the per-sport
// rows), the cfg's own declarations (points, awardScore, best-of) and the engine bracket generator's feed edges —
// never the product's answer and never the engine's forfeitCredit.
import { EngineError } from "@seazn/engine/core";
import { CreditRefused, walkoverCredit, type CreditAnswer, type CreditCase } from "@seazn/reference";
import { feedsNextMatch } from "../../../../apps/web/src/lib/bracket-next-match.ts";
import type { FixtureRow, StandingsRowWire } from "../driver/types.ts";
import { type ObservedFixture, type ObservedOutcome } from "../observed.ts";
import type { CheckResult } from "../results.ts";
import type { RequestedOutcome, StreamEvent } from "../streams/types.ts";
import { assertion, type Item } from "./assertions.ts";
import { BRACKET_OF } from "./terminal-finals.ts";

/** X-DW-3 (W2b D19): the refusal a double walkover gets where the bracket fixture has no next match. */
export const DW_NO_NEXT = Object.freeze({ status: 409, code: "DOUBLE_WALKOVER_NO_NEXT_MATCH" });
/** X-RS-1: the reason a withdrawal cascade records (D1's closed list). */
export const WITHDREW = "withdrew";

const text = (o: ObservedOutcome | null): string => (o === null ? "no outcome" : JSON.stringify(o));
const award = (o: ObservedOutcome | null): { winner: string; loser: string | null; reason: string } | null => (o !== null && o.kind === "award" ? o : null);

/** One forfeit the scenario asked for: the request, the sides at the time, and the product's refusal if any. */
export interface ForfeitDrive {
  readonly fixtureId: string;
  readonly home: string;
  readonly away: string;
  readonly asked: RequestedOutcome;
  readonly refusal: { readonly status: number; readonly code: string | null } | null;
  /** RT-PART: the ledger's tip after the post and the events the harness posted on the fixture. */
  readonly seq?: number;
  readonly posted?: number;
}

const sideId = (d: ForfeitDrive, side: "home" | "away"): string => (side === "home" ? d.home : d.away);
const refusedNote = (d: ForfeitDrive): string => `${d.fixtureId}: the product refused it ${d.refusal!.status} ${d.refusal!.code ?? "(no code)"}`;

/** X-RS-1 / X-WO-1 / X-RT-1 (D2): a one-side forfeit is recorded as an award to the OTHER side, with the forfeiting
 *  side as its loser and the asked reason, and the fixture is forfeited. One item per drive; a refused drive is a
 *  failing item that names the refusal. */
export function forfeitRecorded(id: string, drives: readonly ForfeitDrive[], fixtures: readonly ObservedFixture[]): CheckResult {
  const items: Item[] = drives.map((d): Item => {
    if (d.asked.kind !== "forfeit") return { ok: false, note: `${d.fixtureId}: asked ${d.asked.kind}, not a one-side forfeit` };
    if (d.refusal !== null) return { ok: false, note: refusedNote(d) };
    const f = fixtures.find((x) => x.id === d.fixtureId);
    if (f === undefined) return { ok: false, note: `${d.fixtureId}: not in the stage's fixtures after the run` };
    const loser = sideId(d, d.asked.by);
    const winner = sideId(d, d.asked.by === "home" ? "away" : "home");
    const a = award(f.outcome);
    const ok = f.status === "forfeited" && a !== null && a.winner === winner && a.loser === loser && a.reason === d.asked.reason;
    return { ok, note: `${d.fixtureId}: ${f.status} ${text(f.outcome)}, wanted forfeited award to ${winner}, loser ${loser}, reason ${d.asked.reason}` };
  });
  return assertion(id, items);
}

/** X-RT-1: a retirement keeps the play before it — the ledger holds every event the harness posted (START, the
 *  partial play, the forfeit), none dropped or rewritten. A sport with no scoring event short of its result (chess:
 *  result, pairing and tie-break only) posts START and the forfeit, so two is the floor. */
export function partialPlayStands(drives: readonly ForfeitDrive[]): CheckResult {
  return assertion("w2b-retirement-keeps-play", drives.map((d): Item => {
    if (d.refusal !== null) return { ok: false, note: refusedNote(d) };
    return { ok: d.seq !== undefined && d.posted !== undefined && d.posted >= 2 && d.seq === d.posted, note: `${d.fixtureId}: ledger tip ${d.seq ?? "(unread)"}, the harness posted ${d.posted ?? "(unread)"} event(s) (START, any play, the forfeit: at least 2)` };
  }));
}

/** X-DW-1: a double walkover is its own outcome, and the fixture is forfeited (D7 rule 4). */
export function doubleWalkoverRecorded(drives: readonly ForfeitDrive[], fixtures: readonly ObservedFixture[]): CheckResult {
  const items: Item[] = drives.map((d): Item => {
    if (d.refusal !== null) return { ok: false, note: refusedNote(d) };
    const f = fixtures.find((x) => x.id === d.fixtureId);
    if (f === undefined) return { ok: false, note: `${d.fixtureId}: not in the stage's fixtures after the run` };
    return { ok: f.status === "forfeited" && f.outcome?.kind === "double_walkover", note: `${d.fixtureId}: ${f.status} ${text(f.outcome)}, wanted forfeited double_walkover` };
  });
  return assertion("w2b-double-walkover-recorded", drives.length === 0 ? [{ ok: false, note: "no double walkover was posted" }] : items);
}

/** What a refused probe left behind (X-DW-3: the fixture stays open). */
export interface RefusalProbe {
  readonly fixtureId: string;
  readonly refusal: { readonly status: number; readonly code: string | null } | null;
  readonly before: { readonly status: string; readonly seq: number };
  readonly after: { readonly status: string; readonly seq: number };
}

/** X-DW-3: a double walkover where the bracket fixture has no next match is refused by name, writing nothing. */
export function doubleWalkoverRefusedAtTheEnd(probes: readonly RefusalProbe[], abstain: string | null): CheckResult {
  if (abstain !== null) return assertion("w2b-double-walkover-final-refused", [], abstain);
  if (probes.length === 0) return assertion("w2b-double-walkover-final-refused", [{ ok: false, note: "no fixture without a next match was reached open, so the refusal was never asked" }]);
  return assertion("w2b-double-walkover-final-refused", probes.flatMap((p): Item[] => [
    { ok: p.refusal !== null, note: `${p.fixtureId}: the product ACCEPTED a double walkover on a fixture with no next match` },
    { ok: p.refusal?.status === DW_NO_NEXT.status && p.refusal.code === DW_NO_NEXT.code, note: `${p.fixtureId}: refused ${p.refusal?.status ?? "(none)"} ${p.refusal?.code ?? "(none)"}, wanted ${DW_NO_NEXT.status} ${DW_NO_NEXT.code}` },
    { ok: p.after.seq === p.before.seq && p.after.status === p.before.status, note: `${p.fixtureId}: the refusal moved the fixture ${p.before.status}@${p.before.seq} → ${p.after.status}@${p.after.seq}` },
  ]));
}

// ---------------------------------------------------------------------------------------------------------------
// The feed graph: where the engine's bracket wires each fixture's winner and loser (homeFrom/awayFrom), keyed by the
// product's ext_key (stages.ts bracketToGen stores the generator's fixture id). Trusted only when the keys the
// generator lays out are exactly the keys the product stored — reference-bracket.ts loserSeatOf's rule.

export interface FeedEdge { readonly target: string; readonly slot: "home" | "away" }
export interface FeedGraph {
  readonly keys: readonly string[];
  readonly winnerTo: ReadonlyMap<string, FeedEdge>;
  readonly loserTo: ReadonlyMap<string, FeedEdge>;
  /** Generation order (rounds ascending within each lane): a fixture's feeders come before it. */
  readonly order: readonly string[];
}

export class FeedGraphUnresolved extends Error {
  constructor(why: string) {
    super(`scenario: the bracket's feed graph — ${why}`);
    this.name = "FeedGraphUnresolved";
  }
}

export function feedGraph(stageKind: string, config: Record<string, unknown>, field: readonly string[], rows: readonly FixtureRow[]): FeedGraph {
  const gen = BRACKET_OF[stageKind];
  if (gen === undefined) throw new FeedGraphUnresolved(`no bracket generator for '${stageKind}'`);
  let bracket: ReturnType<typeof gen>;
  try {
    bracket = gen(field, config);
  } catch (e) {
    if (EngineError.is(e)) throw new FeedGraphUnresolved(`the engine lays out no ${stageKind} for ${field.length} entrants (${e.code})`);
    throw e;
  }
  const stored = new Set(rows.flatMap((r) => (r.ext_key === undefined || r.ext_key === null ? [] : [r.ext_key])));
  const made = bracket.fixtures.map((g) => g.id);
  if (stored.size !== made.length || made.some((k) => !stored.has(k))) throw new FeedGraphUnresolved(`the engine's ${stageKind} for ${field.length} entrants (${made.length} fixtures) is not the stage the product stored (${stored.size} keyed rows)`);
  return wireGraph(bracket.fixtures);
}

/** A generated bracket's fixtures (generation order, with their homeFrom/awayFrom feeds) as a FeedGraph. */
export function wireGraph(fixtures: readonly { readonly id: string; readonly homeFrom?: { readonly fixtureId: string; readonly side: "winner" | "loser" }; readonly awayFrom?: { readonly fixtureId: string; readonly side: "winner" | "loser" } }[]): FeedGraph {
  const made = fixtures.map((g) => g.id);
  const winnerTo = new Map<string, FeedEdge>();
  const loserTo = new Map<string, FeedEdge>();
  for (const g of fixtures) {
    for (const [slot, ref] of [["home", g.homeFrom], ["away", g.awayFrom]] as const) {
      if (ref === undefined) continue;
      const into = ref.side === "winner" ? winnerTo : loserTo;
      if (into.has(ref.fixtureId)) throw new FeedGraphUnresolved(`the engine wires two ${ref.side} lines out of ${ref.fixtureId}`);
      into.set(ref.fixtureId, { target: g.id, slot });
    }
  }
  // deadSeats settles each count in one pass in generation order, which holds only if every feeder comes before the
  // fixture it feeds: an assumption, so a guard.
  const at = new Map(made.map((k, i) => [k, i]));
  for (const [from, edges] of [["winner", winnerTo], ["loser", loserTo]] as const) {
    for (const [src, e] of edges) if ((at.get(src) ?? -1) >= (at.get(e.target) ?? -1)) throw new FeedGraphUnresolved(`the engine generates ${e.target} before the fixture whose ${from} feeds it (${src})`);
  }
  return { keys: made, winnerTo, loserTo, order: made };
}

/** X-DW-3: the fixture has no next match (D19: the feed graph, never a round name) — the PRODUCT's own predicate
 *  (apps/web bracket-next-match.ts, shared by its every double-walkover writer), read over the engine's two edges: no
 *  winner line and no loser line, or (loop F I-5) both lines into ONE fixture, which only replays the same two
 *  entrants — a grand final with a bracket reset, a two-entrant double elimination's winners' match. */
export const hasNoNextMatch = (g: FeedGraph, key: string): boolean =>
  !feedsNextMatch({ winner_to_fixture: g.winnerTo.get(key)?.target ?? null, loser_to_fixture: g.loserTo.get(key)?.target ?? null });

/** X-DW-2, simulated on the feed graph: a double walkover at `dwKey` kills both seats it feeds; a fixture left with
 *  ONE dead seat is walked over (its winner line carries the live side, its loser line a dead seat); one left with TWO
 *  is a void (loop F, stages.ts resolveBracketSeats: no seat of a recorded double walkover's chain departed), and both
 *  its lines are dead. Answers each fixture's dead-seat count — the expectation the
 *  run is judged by, from the rule and the engine's wiring alone. */
export function deadSeats(g: FeedGraph, dwKey: string): ReadonlyMap<string, number> {
  const dead = new Map<string, number>();
  const kill = (from: ReadonlyMap<string, FeedEdge>, key: string) => {
    const e = from.get(key);
    if (e !== undefined) dead.set(e.target, (dead.get(e.target) ?? 0) + 1);
  };
  kill(g.winnerTo, dwKey);
  kill(g.loserTo, dwKey);
  // Feeders come first in generation order, so one pass in that order settles every count before it is read.
  for (const key of g.order) {
    if (key === dwKey) continue;
    const n = dead.get(key) ?? 0;
    if (n === 0) continue;
    if (n >= 2) kill(g.winnerTo, key);
    kill(g.loserTo, key);
  }
  return dead;
}

/** The double walkover's target: the first of `candidates` (in the order given) with a next match whose dead chain
 *  leaves EVERY fixture without a next match with both seats live, so X-DW-3's refusal can still be asked at each.
 *  None (a knockout with a third-place match: every early double walkover walks one of its two ends over) answers
 *  undefined — that bracket's case is the refusal alone, and the accepted double walkover is another row's. */
export function pickDoubleWalkover(g: FeedGraph, candidates: readonly FixtureRow[]): FixtureRow | undefined {
  const ends = g.keys.filter((k) => hasNoNextMatch(g, k));
  return candidates.find((f) => {
    if (f.ext_key == null || hasNoNextMatch(g, f.ext_key)) return false;
    const dead = deadSeats(g, f.ext_key);
    return ends.every((k) => (dead.get(k) ?? 0) === 0);
  });
}

/** Why a bracket took no accepted double walkover: pickDoubleWalkover found no placement (the abstain reason). */
export const NO_PLACEMENT = "every double walkover this bracket can take before its last round walks a fixture with no next match over, so its case is the refusal alone (X-DW-3)";

/** X-DW-1 / X-DW-2: nobody advances from the double walkover — neither of its entrants is seated anywhere else in the
 *  stage (no next match, no losers' bracket) — and every seat it feeds is dead: a fixture with one dead seat is
 *  walked over to the side seated there, one with two is a double walkover (`dead`, from deadSeats). */
export function doubleWalkoverAdvancesNobody(d: ForfeitDrive | null, fixtures: readonly ObservedFixture[], dead: ReadonlyMap<string, number> | null): CheckResult {
  const id = "w2b-double-walkover-advances-nobody";
  if (d === null || d.refusal !== null) return assertion(id, [{ ok: false, note: d === null ? "no double walkover was posted" : refusedNote(d) }]);
  const seatedElsewhere = fixtures.filter((f) => f.id !== d.fixtureId && [d.home, d.away].some((e) => f.home === e || f.away === e));
  const items: Item[] = [{ ok: seatedElsewhere.length === 0, note: `${d.home} / ${d.away} seated again after their double walkover, in ${seatedElsewhere.map((f) => f.id).join(", ")}` }];
  if (dead !== null) {
    for (const [key, n] of dead) {
      const f = fixtures.find((x) => x.extKey === key);
      if (f === undefined) { items.push({ ok: false, note: `${key}: a seat the double walkover feeds, not in the stage's fixtures` }); continue; }
      if (n >= 2) { items.push({ ok: f.status === "abandoned" && f.outcome == null, note: `${key}: both seats dead — ${f.status} ${text(f.outcome)}, wanted abandoned with no outcome (a void: neither seat departed)` }); continue; }
      const live = f.home ?? f.away;
      const a = award(f.outcome);
      items.push({ ok: f.status === "forfeited" && a !== null && live !== null && a.winner === live && ![d.home, d.away].includes(live), note: `${key}: one seat dead — ${f.status} ${text(f.outcome)}, seats ${f.home ?? "(dead)"} v ${f.away ?? "(dead)"}, wanted the live seat's walkover` });
    }
  }
  return assertion(id, items);
}

/** A ladder's double walkover leaves the order as it was (W2b D19: nobody climbs). */
export function ladderUnmoved(d: ForfeitDrive | null, before: readonly string[] | null, after: readonly string[] | null): CheckResult {
  // A refused double walkover leaves the order where it was by construction: judging it would be a pass on nothing.
  if (d === null || d.refusal !== null) return assertion("w2b-double-walkover-advances-nobody", [{ ok: false, note: d === null ? "no double walkover was posted" : refusedNote(d) }]);
  if (before === null || after === null) return assertion("w2b-double-walkover-advances-nobody", [{ ok: false, note: "the ladder order was not read around the double walkover" }]);
  return assertion("w2b-double-walkover-advances-nobody", [{ ok: before.join(",") === after.join(","), note: `ladder order ${before.join(" > ")} became ${after.join(" > ")} after a double walkover` }]);
}

// ---------------------------------------------------------------------------------------------------------------
// The table, isolated (X-WO-1, X-DW-4, X-AB-1): the product's standings row for an entrant, against the sum of what
// each of its matches contributes — the rule's delta for the judged match, the posted stream's table contribution for
// every other (fold.ts `tableContribution`: the sport's ledger paid under the stage's table rule, W2d T9). Only the keys
// the rule names are compared.

export interface ExpectedDelta {
  readonly scalars: Readonly<Partial<Record<"played" | "won" | "drawn" | "lost" | "points", number>>>;
  readonly metrics: Readonly<Record<string, number>>;
}
export interface LocalDelta { readonly played: number; readonly won: number; readonly drawn: number; readonly lost: number; readonly points: number; readonly metrics: Readonly<Record<string, number>> }

export interface TableInput {
  /** The stage's fixtures after the run. */
  readonly fixtures: readonly ObservedFixture[];
  /** The product's standings rows, by entrant (every pool's). */
  readonly rows: ReadonlyMap<string, StandingsRowWire>;
  /** fixture id → the rule's delta for that entrant, or null where the rule does not cover it (named in `uncovered`). */
  readonly judged: ReadonlyMap<string, (entrantId: string) => ExpectedDelta>;
  /** The sport's own [home, away] contribution of a fixture the harness posted; null when it has none to give. */
  readonly local: (f: ObservedFixture) => readonly [LocalDelta, LocalDelta] | null;
}

/** One item per entrant of a judged fixture. An entrant with a counted match the harness cannot fold (a result it
 *  never posted) is not isolable: skipped and named, never guessed — and a table with nothing isolable fails. */
export function isolatedTable(id: string, t: TableInput): CheckResult {
  const entrants = [...new Set(t.fixtures.filter((f) => t.judged.has(f.id)).flatMap((f) => [f.home, f.away]).filter((e): e is string => e !== null))];
  const items: Item[] = [];
  const skipped: string[] = [];
  for (const e of entrants) {
    const scalars: Record<string, number> = {};
    const metrics: Record<string, number> = {};
    const judgedKeys = { scalars: new Set<string>(), metrics: new Set<string>() };
    let local = { played: 0, won: 0, drawn: 0, lost: 0, points: 0 } as Record<string, number>;
    const localMetrics: Record<string, number> = {};
    let unfoldable: string | null = null;
    for (const f of t.fixtures.filter((x) => x.home === e || x.away === e)) {
      const j = t.judged.get(f.id);
      if (j !== undefined) {
        const want = j(e);
        for (const [k, v] of Object.entries(want.scalars)) { scalars[k] = (scalars[k] ?? 0) + (v ?? 0); judgedKeys.scalars.add(k); }
        for (const [k, v] of Object.entries(want.metrics)) { metrics[k] = (metrics[k] ?? 0) + v; judgedKeys.metrics.add(k); }
        continue;
      }
      if (f.outcome === null) continue; // a match with no result does not count in the table (X-AB-1)
      const pair = t.local(f);
      if (pair === null) { unfoldable = `${f.id} (${f.status} ${text(f.outcome)})`; break; }
      const mine = f.home === e ? pair[0] : pair[1];
      local = { played: local.played + mine.played, won: local.won + mine.won, drawn: local.drawn + mine.drawn, lost: local.lost + mine.lost, points: local.points + mine.points };
      for (const [k, v] of Object.entries(mine.metrics)) localMetrics[k] = (localMetrics[k] ?? 0) + v;
    }
    if (unfoldable !== null) { skipped.push(`${e}: ${unfoldable} is a result the harness did not post`); continue; }
    const row = t.rows.get(e);
    if (row === undefined) { items.push({ ok: false, note: `${e}: no standings row` }); continue; }
    const bad: string[] = [];
    for (const k of judgedKeys.scalars) {
      const want = (scalars[k] ?? 0) + (local[k] ?? 0);
      const got = (row as unknown as Record<string, unknown>)[k];
      if (got !== want) bad.push(`${k} ${String(got)}≠${want}`);
    }
    for (const k of judgedKeys.metrics) {
      const want = (metrics[k] ?? 0) + (localMetrics[k] ?? 0);
      const got = row.metrics?.[k];
      if (got !== want) bad.push(`metrics.${k} ${String(got)}≠${want}`);
    }
    items.push({ ok: bad.length === 0, note: `${e}: ${bad.join(", ")}` });
  }
  const verdict = assertion(id, items);
  if (skipped.length === 0 || (verdict.verdict === "fail" && verdict.checked > 0)) return verdict;
  return { ...verdict, reason: `${verdict.reason}; ${skipped.length} entrant(s) not isolable (${skipped.join("; ")})` };
}

/** A table check with the walkover-credit family's refusals folded in: each refused credit is a FAILING item, counted
 *  beside the table's own (a refusal is a judged failure, never a skip); none leaves the table's verdict as it was. */
export function withRefusals(table: CheckResult, refused: readonly string[]): CheckResult {
  if (refused.length === 0) return table;
  const judged = table.verdict === "abstain" ? 0 : table.checked;
  return { ...table, verdict: "fail", checked: judged + refused.length, reason: refused[0], evidence: [...refused, ...table.evidence].slice(0, 12) };
}

// ---------------------------------------------------------------------------------------------------------------
// The walkover-credit family (@seazn/reference), asked for one forfeited match: the stage's cfg (X-WO-1), the reason,
// the side at fault and — after play started — the scoresheet so far, read from the events the harness POSTED.

/** The harness's own stream before its forfeit could not be read unit by unit. */
export class ScoresheetUnread extends Error {
  constructor(sport: string, why: string) {
    super(`scenario: ${sport} scoresheet so far — ${why}`);
    this.name = "ScoresheetUnread";
  }
}

type Sheet = { home: number[]; away: number[] };

/** The scoresheet so far, per the family's unit (a period, a set, a game, an innings), from the live events the
 *  harness posted before its forfeit (START included or not). Read in the generators' own vocabulary
 *  (streams/*.ts `partial`) — never from the product. One unit holds the play: a reading that would have to place a
 *  finished unit (a set or a game that may have ended, a game at its target) refuses by name, as does an event outside
 *  the sport's vocabulary or a side that is neither of the two. With nothing recorded (no event, or a bare START) the
 *  sheet is EMPTY in every sport, as generic's always was (ruling 112, R112 review M-3): a 0-0 unit is a unit, and the
 *  oracle reads a unit as play. */
export function scoresheetOf(sport: string, cfg: Record<string, unknown>, events: readonly StreamEvent[], home: string, away: string): Sheet {
  const played = events.filter((e) => e.type !== "core.start");
  const unread = (why: string): never => { throw new ScoresheetUnread(sport, why); };
  const pay = (e: StreamEvent): Record<string, unknown> => (e.payload ?? {}) as Record<string, unknown>;
  const sideOf = (who: unknown, e: StreamEvent): "home" | "away" => (who === home ? "home" : who === away ? "away" : unread(`${e.type} names ${JSON.stringify(who)}, neither side`));
  const only = (type: string): void => { for (const e of played) if (e.type !== type) unread(`${e.type} is not in its vocabulary (${type})`); };
  const target = (key: string): number => (typeof cfg[key] === "number" ? cfg[key] : unread(`the cfg carries no numeric '${key}'`));
  const tally = (count: (e: StreamEvent) => [side: "home" | "away", n: number]): { home: number; away: number } => {
    const t = { home: 0, away: 0 };
    for (const e of played) { const [s, n] = count(e); t[s] += n; }
    return t;
  };
  // The sport's reading runs first, so a sport with no reading refuses even over nothing.
  const read = (): Sheet => {
    switch (sport) {
      case "football":
      case "hockey":
      case "icehockey": {
        // FB/HK/IH-RT-1 read the goals so far: one period holds them.
        only(`${sport}.goal`);
        const t = tally((e) => [sideOf(pay(e).by, e), 1]);
        return { home: [t.home], away: [t.away] };
      }
      case "volleyball":
      case "tabletennis":
      case "badminton": {
        // VB/TT/BD-RT-1: the unfinished set so far, rally by rally; a side at the set target may have ended it.
        only(`${sport}.rally`);
        const t = tally((e) => [sideOf(pay(e).wonBy, e), 1]);
        if (Math.max(t.home, t.away) >= target("setTo")) unread(`a side reached setTo (${t.home}-${t.away}): set 1 may have ended`);
        return { home: [t.home], away: [t.away] };
      }
      case "tennis": {
        // TN-RT-1 is TN-WO-1's credit (the sheet is read for its shape): set 1's games — none, while no game can have ended.
        only("tennis.point");
        const t = tally((e) => [sideOf(pay(e).by, e), 1]);
        if (Math.max(t.home, t.away) >= 4) unread(`${t.home}-${t.away} points: a game may have ended`);
        return { home: [0], away: [0] };
      }
      case "generic": {
        // GN-RT-1 (ruling 124): the points recorded so far — the reference keeps them only where worse for the offender.
        only("generic.score");
        const t = tally((e) => { const n = pay(e).points; return [sideOf(pay(e).by, e), typeof n === "number" ? n : unread(`generic.score carries no numeric points`)]; });
        return { home: [t.home], away: [t.away] };
      }
      case "carrom": {
        // CA-RT-1: the unfinished game so far — a board's winner scores the opponent's coins left × pointsPerCoin.
        only("carrom.board.summary");
        const per = target("pointsPerCoin");
        const t = tally((e) => {
          const p = pay(e);
          if (p.queenTo !== null && p.queenTo !== undefined) unread("a board with the queen covered is not a reading this harness makes");
          return [sideOf(p.winner, e), typeof p.opponentCoinsLeft === "number" ? p.opponentCoinsLeft * per : unread("carrom.board.summary carries no numeric opponentCoinsLeft")];
        });
        if (Math.max(t.home, t.away) >= target("gameTo")) unread(`a side reached gameTo (${t.home}-${t.away}): game 1 may have ended`);
        return { home: [t.home], away: [t.away] };
      }
      case "cricket": {
        // The innings so far, home batting first (the generators' order); CK-WO-1's credit does not read it.
        only("cricket.innings.summary");
        if (played.length > 2) unread(`${played.length} innings: only a first innings each is a reading this harness makes`);
        const runs = played.map((e) => (typeof pay(e).runs === "number" ? (pay(e).runs as number) : unread("cricket.innings.summary carries no numeric runs")));
        return { home: runs.slice(0, 1), away: [runs[1] ?? 0] };
      }
      case "boardgame":
        // BG: the game IS its result — nothing is played short of it.
        if (played.length > 0) unread(`${played[0].type} before the forfeit: a chess game has no scoring event short of its result`);
        return { home: [], away: [] };
      default:
        return unread("no scoresheet reading for this sport");
    }
  };
  const sheet = read();
  return played.length === 0 ? { home: [], away: [] } : sheet;
}

/** The table points the family's `points` answer means, read off the stage cfg's OWN points table (X-WO-1): "win" is
 *  a win and a loss — the winner the cfg's win points, the offender its loss points; "zero" is nothing for either side
 *  (X-DW-4). The table is the sport's declaration: `points {win, loss}` (the goal, period, cricket, carrom and tennis
 *  cfgs), chess's `scoring {win, loss}` (half-points), generic's `points {w, l}`, or the set sports' `pointsMap`, looked
 *  up by the CREDITED set score (exact "W-L", else "*" — FIVB's points-by-set-score table). A cfg none of those reads
 *  is refused by name. */
export function forfeitPoints(cfg: Record<string, unknown>, points: "win" | "zero", winner: Readonly<Record<string, number>>): { readonly winner: number; readonly loser: number } | { readonly unread: string } {
  if (points === "zero") return { winner: 0, loser: 0 };
  const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  for (const key of ["points", "scoring"] as const) {
    const table = cfg[key] as Record<string, unknown> | undefined;
    if (table !== undefined && num(table.win) && num(table.loss)) return { winner: table.win, loser: table.loss };
  }
  const generic = cfg.points as Record<string, unknown> | undefined;
  if (generic !== undefined && num(generic.w) && num(generic.l)) return { winner: generic.w, loser: generic.l };
  const map = cfg.pointsMap as Record<string, unknown> | undefined;
  if (map !== undefined && typeof map === "object") {
    const score = `${winner.sets_won ?? "?"}-${winner.sets_lost ?? "?"}`;
    const pair = map[score] ?? map["*"];
    if (!Array.isArray(pair) || pair.length !== 2 || !num(pair[0]) || !num(pair[1])) return { unread: `the cfg's pointsMap has no pair for the credited set score ${score} (nor "*")` };
    return { winner: pair[0], loser: pair[1] };
  }
  return { unread: "the cfg declares no points table this check reads (points or scoring {win, loss}, points {w, l}, or pointsMap)" };
}

/** One forfeited match's table expectation from the walkover-credit family — or the family's refusal, by name, for
 *  the caller to count as a FAILING item (never thrown past it, never skipped). */
export function creditExpectation(c: CreditCase, sides: ForfeitSides): { readonly expect: (entrantId: string) => ExpectedDelta } | { readonly refused: string } {
  let credit: CreditAnswer;
  try {
    credit = walkoverCredit(c);
  } catch (e) {
    if (e instanceof CreditRefused) return { refused: `walkover-credit refused (${e.reason}): ${e.message}` };
    throw e;
  }
  return expectationOf(credit, c.cfg, sides);
}

type ForfeitSides = { readonly home: string; readonly away: string; readonly offender: "home" | "away" | "both" };

/** The family's answer as the table's expected delta. A one-sided forfeit credits the side it went to the winner's
 *  metrics with W1 and its win points, the offender the loser's with L1 and its loss points (forfeitPoints); a double
 *  walkover (X-DW-4) is P1 L1, 0 points, and no score for either side — each side's credit asserted zero ON ITS OWN, so
 *  a non-zero key on one is never hidden by the other's zero. An answer the rule contradicts is refused by name. */
export function expectationOf(credit: CreditAnswer, cfg: Record<string, unknown>, sides: ForfeitSides): { readonly expect: (entrantId: string) => ExpectedDelta } | { readonly refused: string } {
  const pts = forfeitPoints(cfg, credit.points, credit.winner);
  if ("unread" in pts) return { refused: `the forfeit's table points (${credit.points}): ${pts.unread}` };
  if (sides.offender === "both") {
    for (const [side, m] of [["winner", credit.winner], ["loser", credit.loser]] as const) {
      const off = Object.entries(m).filter(([, v]) => v !== 0);
      if (off.length > 0) return { refused: `walkover-credit's double walkover credits its ${side} side ${off.map(([k, v]) => `${k} ${v}`).join(", ")}: X-DW-4 credits no score` };
    }
    if (pts.winner !== 0 || pts.loser !== 0) return { refused: `walkover-credit's double walkover answers points '${credit.points}': X-DW-4 is 0 points for both` };
    const zero = Object.fromEntries([...Object.keys(credit.winner), ...Object.keys(credit.loser)].map((k) => [k, 0]));
    return { expect: () => ({ scalars: { played: 1, won: 0, drawn: 0, lost: 1, points: 0 }, metrics: zero }) };
  }
  const loser = sides.offender === "home" ? sides.home : sides.away;
  return { expect: (e) => (e === loser ? { scalars: { played: 1, won: 0, lost: 1, points: pts.loser }, metrics: credit.loser } : { scalars: { played: 1, won: 1, lost: 0, points: pts.winner }, metrics: credit.winner }) };
}
