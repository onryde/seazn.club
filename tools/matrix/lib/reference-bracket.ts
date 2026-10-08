// W2a (controller ruling T15-R3): the harness judges every bracket match it drives against the reference family
// `bracket-finish` (@seazn/reference — written from the signed rule rows by another agent, R8). The oracle never sees
// the product: it is given the ACTIONS the harness drove, in the rulebook's terms, and answers the status the fixture
// must have, who advances by which method, and which writes the rules refuse. This module turns one drive into the
// oracle's case, calls it, and compares the answer with what the product returned for the drive.
//
// What is compared, per drive: (1) the oracle refuses none of the actions the harness drove (the harness drives only
// legal sequences, so an oracle refusal is a disagreement about legality); (2) the fixture status; (3) who advanced
// and by which method; (4) where the bracket wires a loser, who sits in that slot. The oracle labels a play win
// "play"; the product's play wins carry whatever method the sport gave them (checkmate, a points win, none), so every
// method that is not `settled_*` or `tiebreak_*` is mapped to "play".
//
// A level result keeps its OWN kind (X-BR-1: draw, tie, no_result are different rows — GN-KO-1 refuses a generic
// draw and holds a generic tie): a draw or tie request is that kind, and a `level` request is whatever the engine's
// fold of the stream the harness itself posted says it is — never the product's answer, never a default.
//
// The loser's seat is judged where the ENGINE's own bracket wires one (`homeFrom`/`awayFrom` with side "loser", read
// from the generator the product starts from, as terminal-finals.ts reads the finals): the product's fixture with that
// ext_key must hold the loser in that slot, and a held match seats nobody. A stage whose shape cannot be laid out from
// its rows is not judged on the loser seat, said by name.
//
// A drive the oracle does not cover is not judged, and says why: `OutOfScope` and `RuledOut` are the oracle's own
// named exclusions, and a walkover (a forfeit) is not one of its actions. Not judged is COUNTED and named, never
// silent, and a run that judged nothing fails (zero is a failure, R25).
import { EngineError, type StageKind } from "@seazn/engine/core";
import { LEVEL_KINDS, OutOfScope, RuledOut, requireFamily, type Action, type BracketCase, type BracketExpect, type LevelKind, type WinMethod } from "@seazn/reference";
import { foldStream } from "./fold.ts";
import type { ObservedOutcome } from "./observed.ts";
import { BRACKET_OF } from "./scenarios/terminal-finals.ts";
import { sportModule } from "./sport-cfg.ts";
import type { FixtureRow } from "./driver/types.ts";
import type { RequestedOutcome, StreamEvent } from "./streams/types.ts";

/** Where the engine's bracket wires THIS match's loser, and who the product seated there. */
export type LoserSeat =
  /** The engine's bracket wires no loser out of this match (a knockout's early rounds, a stepladder). */
  | { readonly line: "none" }
  /** The wiring could not be read for this stage; `why` names it. The loser seat is not judged for the drive. */
  | { readonly line: "unresolved"; readonly why: string }
  /** `target`: the ext_key of the fixture the loser is wired into; `seated`: the entrant in the wired slot after the
   *  match was driven, or null when it is empty. */
  | { readonly line: "seat"; readonly target: string; readonly slot: "home" | "away"; readonly seated: string | null };

/** One bracket fixture the harness drove: what it asked for, and what the product answered to the last event posted. */
export interface BracketDrive {
  readonly fixtureId: string;
  readonly stageKind: string;
  readonly sport: string;
  readonly home: string;
  readonly away: string;
  readonly asked: RequestedOutcome;
  /** The X-BR-1 kind of the LEVEL result the drive played (a draw, a tie or a no_result), read from the engine's fold
   *  of the stream the harness itself posted (levelKindOf); null for a drive that played no level result. */
  readonly levelAs: LevelKind | null;
  /** The fixture status the product's last answer carried; null when the driver answered nothing. */
  readonly status: string | null;
  /** The outcome the product's last answer carried. */
  readonly outcome: ObservedOutcome | null;
  /** The engine-wired loser line of this match and who the product seated on it. */
  readonly loser: LoserSeat;
}

export type Judgement =
  | { readonly judged: true; readonly ok: boolean; readonly note: string; readonly loserNotJudged: string | null }
  | { readonly judged: false; readonly why: string };

/** The harness's own stream could not be read as the level result it asked for. */
export class LevelKindUnread extends Error {
  constructor(sport: string, asked: string, why: string) {
    super(`reference-bracket: ${sport} '${asked}' — ${why}`);
    this.name = "LevelKindUnread";
  }
}

const isLevelKind = (k: string | undefined): k is LevelKind => k !== undefined && (LEVEL_KINDS as readonly string[]).includes(k);

/** The X-BR-1 kind of the level result a request plays, or null when it plays none. A `draw` or `tie` request IS
 *  that kind; a `level` request (and a settle after a level result) is what the ENGINE's fold of the stream the
 *  harness posted says — the product's answer is never consulted; a chess tie-break follows a DRAWN game, which the
 *  stream's first result carries as `winner: null` (under the bracket cfg the fold holds it in phase tiebreak, with no
 *  outcome to read). A request that plays no level result is null. */
export function levelKindOf(sport: string, cfg: unknown, home: string, away: string, asked: RequestedOutcome, events: readonly StreamEvent[]): LevelKind | null {
  switch (asked.kind) {
    case "win":
    case "forfeit":
    case "abandon":
      return null;
    case "draw":
    case "tie":
      return asked.kind;
    case "tiebreak": {
      const result = events.find((e) => e.type === "boardgame.result");
      if ((result?.payload as { winner?: unknown } | undefined)?.winner !== null) throw new LevelKindUnread(sport, asked.kind, "the tie-break follows no drawn game in the stream posted");
      return "draw";
    }
    case "level":
    case "settle": {
      if (asked.kind === "settle" && asked.after !== "level") return null;
      const played = events.filter((e) => e.type !== "core.settle");
      const kind = foldStream(sportModule(sport), cfg, home, away, played).outcome?.kind;
      if (!isLevelKind(kind)) throw new LevelKindUnread(sport, asked.kind, `the stream posted folds to '${String(kind)}', not a level result`);
      return kind;
    }
  }
}

/** The oracle's case for one drive, or the reason the oracle has no vocabulary for it. The mapping is by REQUEST kind:
 *  a win is a play win; a draw, a tie or `level` is a level play of its OWN kind (d.levelAs); a settle is the
 *  organiser's, after a level play or after an abandon; a tie-break is a drawn chess game's; an abandon is the
 *  organiser's with no play result. `hasLoserLine` is whether the engine's bracket wires a loser out of this match. */
export function bracketCaseOf(d: BracketDrive): BracketCase | { readonly notJudged: string } {
  const a = d.asked;
  const base = { stageKind: d.stageKind as StageKind, sport: d.sport, hasLoserLine: d.loser.line === "seat" } as const;
  const level = (): { kind: "level"; as: LevelKind } => {
    if (d.levelAs === null) throw new LevelKindUnread(d.sport, a.kind, "the drive recorded no level kind");
    return { kind: "level", as: d.levelAs };
  };
  switch (a.kind) {
    case "win":
      return { ...base, play: { kind: "win", winner: a.winner }, actions: [] };
    case "level":
    case "draw":
    case "tie":
      return { ...base, play: level(), actions: [] };
    case "settle": {
      const settle: Action = { kind: "settle", winner: a.then, method: a.method, by: "organiser" };
      return a.after === "level"
        ? { ...base, play: level(), actions: [settle] }
        : { ...base, play: { kind: "none" }, actions: [{ kind: "abandon" }, settle] };
    }
    case "tiebreak":
      return { ...base, play: level(), actions: [{ kind: "tiebreak", rung: a.rung, winner: a.winner }] };
    case "abandon":
      return { ...base, play: { kind: "none" }, actions: [{ kind: "abandon" }] };
    case "forfeit":
      return { notJudged: "forfeit: a walkover is not one of the oracle's actions" };
  }
}

/** The product's method as the oracle names it: a settle and a tie-break keep theirs, every play win is "play". */
export function oracleMethod(method: string | undefined): WinMethod {
  return method !== undefined && (method.startsWith("settled_") || method.startsWith("tiebreak_")) ? (method as WinMethod) : "play";
}

const sideOf = (d: BracketDrive, winner: string): "home" | "away" | null => (winner === d.home ? "home" : winner === d.away ? "away" : null);

function show(expect: BracketExpect): string {
  const adv = expect.advances === null ? "nobody advances" : `${expect.advances.winner} advances by ${expect.advances.method}`;
  return `status ${expect.status}, ${adv}`;
}

/** Where the engine's bracket wires the loser of the match `row` (a row of `rows`, its whole stage), and who the
 *  product seated there. The bracket is laid out as the product's Start lays it (BRACKET_OF, the table terminal-finals
 *  reads) over the entrants the stage's rows seat; it is trusted only when the keys it generates are exactly the keys
 *  the product stored (ext_key = the generator's fixture id, stages.ts bracketToGen), so a stage the harness cannot
 *  reconstruct is "unresolved", named, and never guessed. */
export function loserSeatOf(stageKind: string, config: Record<string, unknown>, row: FixtureRow, rows: readonly FixtureRow[], generators: typeof BRACKET_OF = BRACKET_OF): LoserSeat {
  const gen = generators[stageKind];
  if (gen === undefined) return { line: "unresolved", why: `no bracket generator for '${stageKind}'` };
  if (row.ext_key === undefined || row.ext_key === null) return { line: "unresolved", why: `fixture ${row.id} carries no ext_key` };
  const field = [...new Set(rows.flatMap((r) => [r.home_entrant_id, r.away_entrant_id]).filter((e): e is string => e !== null))];
  let bracket: ReturnType<typeof gen>;
  try {
    bracket = gen(field, config);
  } catch (e) {
    if (EngineError.is(e)) return { line: "unresolved", why: `the engine lays out no ${stageKind} for ${field.length} entrants (${e.code})` };
    throw e;
  }
  const stored = new Set(rows.flatMap((r) => (r.ext_key === undefined || r.ext_key === null ? [] : [r.ext_key])));
  const made = new Set(bracket.fixtures.map((g) => g.id));
  if (stored.size !== made.size || [...made].some((k) => !stored.has(k))) return { line: "unresolved", why: `the engine's ${stageKind} for ${field.length} entrants (${made.size} fixtures) is not the stage the product stored (${stored.size} keyed rows)` };
  const wired = bracket.fixtures.flatMap((g) => ([["home", g.homeFrom], ["away", g.awayFrom]] as const)
    .filter(([, ref]) => ref !== undefined && ref.side === "loser" && ref.fixtureId === row.ext_key)
    .map(([slot]) => ({ target: g.id, slot })));
  if (wired.length === 0) return { line: "none" };
  if (wired.length > 1) return { line: "unresolved", why: `the engine wires ${wired.length} loser lines out of ${row.ext_key}` };
  const { target, slot } = wired[0]!;
  const into = rows.find((r) => r.ext_key === target);
  if (into === undefined) return { line: "unresolved", why: `the loser line of ${row.ext_key} points at ${target}, which the product did not store` };
  return { line: "seat", target, slot, seated: slot === "home" ? into.home_entrant_id : into.away_entrant_id };
}

/** Judge one drive against the oracle. The oracle is asked through `requireFamily` first, so a bracket kind with no
 *  family is the loud NoReferenceFamily, never a quiet skip, and an ambiguous match is AmbiguousReferenceFamily. */
export function judgeDrive(d: BracketDrive): Judgement {
  const c = bracketCaseOf(d);
  if ("notJudged" in c) return { judged: false, why: c.notJudged };
  if (d.status === null) return { judged: false, why: "the driver answered no status for the last event" };
  let expect: BracketExpect;
  try {
    expect = requireFamily(c.stageKind, c.sport).expect(c);
  } catch (e) {
    if (e instanceof OutOfScope) return { judged: false, why: `oracle out of scope (${e.reason})` };
    if (e instanceof RuledOut) return { judged: false, why: `oracle rules it out (${e.reason})` };
    throw e;
  }
  const where = `${d.fixtureId} (${d.stageKind} x ${d.sport}, asked ${d.asked.kind})`;
  const bad: string[] = [];
  for (const r of expect.refused) bad.push(`the oracle refuses action ${r.index} with ${r.code}, which the harness drove as legal`);
  if (d.status !== expect.status) bad.push(`status: oracle ${expect.status}, product ${d.status}`);
  const won = d.outcome !== null && (d.outcome.kind === "win" || d.outcome.kind === "award") ? d.outcome : null;
  if (expect.advances === null) {
    if (won !== null) bad.push(`advance: oracle says nobody advances, product advanced ${won.winner}`);
  } else if (won === null) {
    bad.push(`advance: oracle says ${expect.advances.winner} advances by ${expect.advances.method}, product advanced nobody`);
  } else {
    const side = sideOf(d, won.winner);
    if (side !== expect.advances.winner) bad.push(`advance: oracle says ${expect.advances.winner} advances, product advanced ${side ?? `a stranger (${won.winner})`}`);
    const method = oracleMethod(won.method);
    if (method !== expect.advances.method) bad.push(`method: oracle ${expect.advances.method}, product ${method}`);
  }
  // The loser line (X-ST-1: a win seats the winner AND the loser where the bracket has a line; X-BR-2: a held match
  // seats nobody). Judged only where the engine's bracket wires one.
  if (d.loser.line === "seat") {
    const into = `${d.loser.target} ${d.loser.slot}`;
    if (expect.advances === null) {
      if (d.loser.seated === d.home || d.loser.seated === d.away) bad.push(`loser: oracle says nobody advances, yet the product seated ${d.loser.seated} in ${into}`);
    } else if (expect.advances.loser !== null) {
      const want = expect.advances.loser === "home" ? d.home : d.away;
      if (d.loser.seated !== want) bad.push(`loser: oracle seats ${expect.advances.loser} (${want}) in ${into}, product seated ${d.loser.seated ?? "nobody"}`);
    }
  }
  const loserNotJudged = d.loser.line === "unresolved" ? d.loser.why : null;
  return bad.length === 0
    ? { judged: true, ok: true, note: `${where}: ${show(expect)}`, loserNotJudged }
    : { judged: true, ok: false, note: `${where}: ${bad.join("; ")} (oracle: ${show(expect)})`, loserNotJudged };
}
