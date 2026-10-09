// The W2b forfeit-credit scenarios' own checks (Task 2 Step 4), kept pure — what the scenario recorded and what the
// product shows in, a counted CheckResult out — so each is judged on synthetic data as well as on a run. Every check
// counts its items and zero checked is a failure (R25, assertions.ts `assertion`); an abstain carries its reason.
// Expected values are the Appendix A rows' (X-RS-1, X-WO-1, X-RT-1, X-DW-1..4, X-AB-1/2, X-WD-1..4, the per-sport
// rows), the cfg's own declarations (points, awardScore, best-of) and the engine bracket generator's feed edges —
// never the product's answer and never the engine's forfeitCredit.
import { EngineError } from "@seazn/engine/core";
import type { FixtureRow, StandingsRowWire } from "../driver/types.ts";
import { type ObservedFixture, type ObservedOutcome } from "../observed.ts";
import type { CheckResult } from "../results.ts";
import type { RequestedOutcome } from "../streams/types.ts";
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

/** X-DW-3: the fixture has no next match — no winner line and no loser line out of it (D19: the feed graph, never a
 *  round name). */
export const hasNoNextMatch = (g: FeedGraph, key: string): boolean => !g.winnerTo.has(key) && !g.loserTo.has(key);

/** X-DW-2, simulated on the feed graph: a double walkover at `dwKey` kills both seats it feeds; a fixture left with
 *  ONE dead seat is walked over (its winner line carries the live side, its loser line a dead seat); one left with TWO
 *  is itself a double walkover (both its lines dead). Answers each fixture's dead-seat count — the expectation the
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
      if (n >= 2) { items.push({ ok: f.status === "forfeited" && f.outcome?.kind === "double_walkover", note: `${key}: both seats dead — ${f.status} ${text(f.outcome)}, wanted forfeited double_walkover` }); continue; }
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
// each of its matches contributes — the rule's delta for the judged match, the sport's own standingsDelta of the
// posted stream for every other. Only the keys the rule names are compared.

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
