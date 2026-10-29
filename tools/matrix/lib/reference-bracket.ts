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
// W2b (I-3, Task 15 review): a forfeit is the oracle's `forfeit` action — the offender (`both` for a double walkover,
// X-DW-1), the X-RS-1 reason and the writer (the harness posts every forfeit as the organiser) — recorded on the play
// the stream the harness posted says it was (forfeitPlayOf: bare before START, or a match under way). Whether the
// fixture feeds a next match (X-DW-3, plan D19) is read from the engine's own wiring (nextLineOf), as the loser line
// is. A forfeit's method is its reason, verbatim: oracleMethod passes the reasons through, and an award's reason is
// its method.
//
// A drive the oracle does not cover is not judged, and says why: `OutOfScope` and `RuledOut` are the oracle's own
// named exclusions, and a double walkover whose next-match line cannot be read is the harness's. Not judged is
// COUNTED and named, never silent, and a run that judged nothing fails (zero is a failure, R25).
import { EngineError, type StageKind } from "@seazn/engine/core";
import { FORFEIT_REASONS, LEVEL_KINDS, OutOfScope, RuledOut, requireFamily, type Action, type BracketCase, type BracketExpect, type LevelKind, type PlayResult, type WinMethod } from "@seazn/reference";
import { feedsNextMatch } from "../../../apps/web/src/lib/bracket-next-match.ts";
import { foldStream } from "./fold.ts";
import type { ObservedOutcome } from "./observed.ts";
import { BRACKET_OF } from "./scenarios/terminal-finals.ts";
import { sportModule } from "./sport-cfg.ts";
import type { FixtureRow } from "./driver/types.ts";
import type { ProductFold, RequestedOutcome, StreamEvent } from "./streams/types.ts";

/** Where the engine's bracket wires THIS match's loser, and who the product seated there. */
export type LoserSeat =
  /** The engine's bracket wires no loser out of this match (a knockout's early rounds, a stepladder). */
  | { readonly line: "none" }
  /** The wiring could not be read for this stage; `why` names it. The loser seat is not judged for the drive. */
  | { readonly line: "unresolved"; readonly why: string }
  /** `target`: the ext_key of the fixture the loser is wired into; `seated`: the entrant in the wired slot after the
   *  match was driven, or null when it is empty. */
  | { readonly line: "seat"; readonly target: string; readonly slot: "home" | "away"; readonly seated: string | null };

/** W2b (X-DW-3, plan D19): whether the engine's bracket feeds THIS match into a next match (nextLineOf). */
export type NextLine =
  | { readonly line: "next"; readonly target: string }
  /** No next match: no line out (a final, a last rung, a third-place match, a ladder challenge — D19), or both lines into
   *  one fixture (loop F I-5: a bracket reset's grand final, a two-entrant double elim's winners' match). */
  | { readonly line: "none" }
  /** The wiring could not be read for this stage; `why` names it. A double walkover here is not judged. */
  | { readonly line: "unresolved"; readonly why: string };

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
  /** W2b: whether the engine's bracket feeds this match's winner into a next match (nextLineOf). */
  readonly next: NextLine;
  /** W2b: the play a forfeit (or a double walkover) was recorded on, read from the stream the harness posted
   *  (forfeitPlayOf); null for a drive that posted no forfeit. */
  readonly forfeitPlay: PlayResult | null;
  /** W2b (review I-1): the product's refusal of the drive's one bare write (a forfeit before START, which writes
   *  nothing when refused) — judged against the oracle's `refused`, never dropped; null when the product accepted it.
   *  `status` and `outcome` are then the fixture as the refusal left it. */
  readonly refusal: { readonly status: number; readonly code: string | null } | null;
  /** W2e (Task 21): the product's own /state for the fixture, read after the last event was posted — the engine's summary and
   *  the fold's state as match_states holds them. Recorded ONLY for a drive that asked a win down a deciding path (the
   *  W2e scenarios' witness reads it; every other drive's call log is unchanged); null when the product held no row, absent
   *  on a drive that asked no path. */
  readonly product?: ProductFold | null;
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

/** W2e G12 reached the bracket oracle before Task 24 wrote its row. */
export class SanctionEndUnjudged extends Error {
  constructor(sport: string, why: string) {
    super(`reference-bracket: ${sport} sanctionEnd — ${why}`);
    this.name = "SanctionEndUnjudged";
  }
}

/** The harness's own stream before its forfeit could not be read as a play the oracle has a row for. */
export class ForfeitPlayUnread extends Error {
  constructor(sport: string, why: string) {
    super(`reference-bracket: ${sport} forfeit — ${why}`);
    this.name = "ForfeitPlayUnread";
  }
}

/** Who writes every forfeit the harness drives: the organiser (http-driver.ts and the console's Forfeit, both under
 *  the organiser's session; X-RS-3 refuses a scorer or a device, PF-2 keeps `withdrew` for the cascade). */
export const HARNESS_FORFEIT_WRITER = "organiser" as const;

const isLevelKind = (k: string | undefined): k is LevelKind => k !== undefined && (LEVEL_KINDS as readonly string[]).includes(k);

/** The X-BR-1 kind of the level result a request plays, or null when it plays none. A `draw` or `tie` request IS
 *  that kind; a `level` request (and a settle after a level result) is what the ENGINE's fold of the stream the
 *  harness posted says — the product's answer is never consulted; a chess tie-break follows a DRAWN game, which the
 *  stream's first result carries as `winner: null` (under the bracket cfg the fold holds it in phase tiebreak, with no
 *  outcome to read). A request that plays no level result is null. */
export function levelKindOf(sport: string, cfg: unknown, home: string, away: string, asked: RequestedOutcome, events: readonly StreamEvent[]): LevelKind | null {
  // W2e G12: a sanction that ends the match (sanctionEnd) ends it in an award, never level (Task 24 drives it).
  switch (asked.kind) {
    case "win":
    case "forfeit":
    case "double_walkover":
    case "abandon":
    case "sanctionEnd":
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

/** W2b: the play a forfeit was recorded on, from the LIVE stream the harness posted, ending in its core.forfeit: no
 *  START before it is a bare forfeit (before play, X-RS-1); START with no sport event after it is a match started with
 *  nothing played (ruling 112), and START then sport events with nothing decided is a match under way. The
 *  harness forfeits nothing that has a result, and no drawn chess game (BG-KO-1's tie-break phase, which the oracle
 *  reads as a level play, D3 R3): either is refused by name rather than read as under way. */
export function forfeitPlayOf(sport: string, cfg: unknown, home: string, away: string, live: readonly StreamEvent[]): PlayResult {
  if (live.at(-1)?.type !== "core.forfeit") throw new ForfeitPlayUnread(sport, `the stream ends with ${live.at(-1)?.type ?? "nothing"}, not its core.forfeit`);
  const before = live.slice(0, -1);
  if (!before.some((e) => e.type === "core.start")) return { kind: "none" };
  if (before.some((e) => e.type === "boardgame.result")) throw new ForfeitPlayUnread(sport, "it follows a drawn chess game's result (BG-KO-1): a tie-break-phase forfeit is not a request the harness makes");
  const decided = foldStream(sportModule(sport), cfg, home, away, before).outcome;
  if (decided !== null) throw new ForfeitPlayUnread(sport, `the play before it already folds to '${decided.kind}'`);
  // Ruling 112: something is played once a sport (non-`core.`) event follows the START.
  const startAt = before.findIndex((e) => e.type === "core.start");
  return before.slice(startAt + 1).some((e) => !e.type.startsWith("core.")) ? { kind: "in_progress" } : { kind: "started" };
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
    case "double_walkover": {
      if (d.forfeitPlay === null) throw new ForfeitPlayUnread(d.sport, `${d.fixtureId}: the ${a.kind} drive recorded no play before its forfeit`);
      const forfeit: Action = a.kind === "forfeit"
        ? { kind: "forfeit", offender: a.by, reason: a.reason, by: HARNESS_FORFEIT_WRITER }
        : { kind: "forfeit", offender: "both", reason: "walkover", by: HARNESS_FORFEIT_WRITER }; // X-DW-1
      // X-DW-3 asks whether the fixture feeds a next match of a double walkover alone: unread, it is not judged.
      if (a.kind === "double_walkover" && d.next.line === "unresolved") return { notJudged: `double_walkover: whether ${d.fixtureId} feeds a next match could not be read (${d.next.why})` };
      return { ...base, play: d.forfeitPlay, actions: [forfeit], ...(d.next.line === "unresolved" ? {} : { hasNextMatch: d.next.line === "next" }) };
    }
    // W2e G12: the oracle's row for a sanction ending is Task 24's to write; until then a drive asking one is refused by
    // name, never judged as some other case.
    case "sanctionEnd":
      throw new SanctionEndUnjudged(d.sport, `${d.fixtureId}: a sanction ending (W2e G12) has no bracket-finish row until Task 24`);
  }
}

/** The product's method as the oracle names it: a settle and a tie-break keep theirs, and so does a forfeit — its
 *  X-RS-1 reason, verbatim (an award's reason is its method); every play win is "play". */
export function oracleMethod(method: string | undefined): WinMethod {
  if (method === undefined) return "play";
  if (method.startsWith("settled_") || method.startsWith("tiebreak_") || (FORFEIT_REASONS as readonly string[]).includes(method)) return method as WinMethod;
  return "play";
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
type Layout = { readonly key: string; readonly fixtures: ReturnType<(typeof BRACKET_OF)[string]>["fixtures"] } | { readonly why: string };

/** The engine's layout of the stage `row` belongs to, trusted only when its keys are exactly the keys the product
 *  stored (loserSeatOf's rule, shared with nextLineOf); otherwise why not. */
function layoutOf(stageKind: string, config: Record<string, unknown>, row: FixtureRow, rows: readonly FixtureRow[], generators: typeof BRACKET_OF): Layout {
  const gen = generators[stageKind];
  if (gen === undefined) return { why: `no bracket generator for '${stageKind}'` };
  if (row.ext_key === undefined || row.ext_key === null) return { why: `fixture ${row.id} carries no ext_key` };
  const field = [...new Set(rows.flatMap((r) => [r.home_entrant_id, r.away_entrant_id]).filter((e): e is string => e !== null))];
  let bracket: ReturnType<typeof gen>;
  try {
    bracket = gen(field, config);
  } catch (e) {
    if (EngineError.is(e)) return { why: `the engine lays out no ${stageKind} for ${field.length} entrants (${e.code})` };
    throw e;
  }
  const stored = new Set(rows.flatMap((r) => (r.ext_key === undefined || r.ext_key === null ? [] : [r.ext_key])));
  const made = new Set(bracket.fixtures.map((g) => g.id));
  if (stored.size !== made.size || [...made].some((k) => !stored.has(k))) return { why: `the engine's ${stageKind} for ${field.length} entrants (${made.size} fixtures) is not the stage the product stored (${stored.size} keyed rows)` };
  return { key: row.ext_key, fixtures: bracket.fixtures };
}

export function loserSeatOf(stageKind: string, config: Record<string, unknown>, row: FixtureRow, rows: readonly FixtureRow[], generators: typeof BRACKET_OF = BRACKET_OF): LoserSeat {
  const layout = layoutOf(stageKind, config, row, rows, generators);
  if ("why" in layout) return { line: "unresolved", why: layout.why };
  const bracket = layout;
  const wired = bracket.fixtures.flatMap((g) => ([["home", g.homeFrom], ["away", g.awayFrom]] as const)
    .filter(([, ref]) => ref !== undefined && ref.side === "loser" && ref.fixtureId === row.ext_key)
    .map(([slot]) => ({ target: g.id, slot })));
  if (wired.length === 0) return { line: "none" };
  if (wired.length > 1) return { line: "unresolved", why: `the engine wires ${wired.length} loser lines out of ${row.ext_key}` };
  const { target, slot } = wired[0];
  const into = rows.find((r) => r.ext_key === target);
  if (into === undefined) return { line: "unresolved", why: `the loser line of ${row.ext_key} points at ${target}, which the product did not store` };
  return { line: "seat", target, slot, seated: slot === "home" ? into.home_entrant_id : into.away_entrant_id };
}

/** W2b (X-DW-3): whether the match `row` feeds a next match, by the PRODUCT's own predicate (apps/web
 *  bracket-next-match.ts feedsNextMatch, the one its double-walkover writers share) over the engine's two lines out of
 *  it — none, or (loop F I-5) both lines into ONE fixture, which only replays the same two entrants; else the next match
 *  (its winner line's target) — or why the layout could not be read (loserSeatOf's rule). A ladder wires no feed edge
 *  (plan D19): none. */
export function nextLineOf(stageKind: string, config: Record<string, unknown>, row: FixtureRow, rows: readonly FixtureRow[], generators: typeof BRACKET_OF = BRACKET_OF): NextLine {
  if (stageKind === "ladder") return { line: "none" }; // D19
  const layout = layoutOf(stageKind, config, row, rows, generators);
  if ("why" in layout) return { line: "unresolved", why: layout.why };
  const out = (side: "winner" | "loser") => layout.fixtures.filter((g) => [g.homeFrom, g.awayFrom].some((ref) => ref !== undefined && ref.side === side && ref.fixtureId === layout.key));
  const won = out("winner");
  const lost = out("loser");
  for (const [side, fed] of [["winner", won], ["loser", lost]] as const) {
    if (fed.length > 1) return { line: "unresolved", why: `the engine wires ${fed.length} ${side} lines out of ${layout.key}` };
  }
  const winner = won[0]?.id ?? null;
  const loser = lost[0]?.id ?? null;
  if (!feedsNextMatch({ winner_to_fixture: winner, loser_to_fixture: loser })) return { line: "none" };
  // feedsNextMatch holds with a line out, so one of the two is set; the winner's is the next match the drive names.
  return { line: "next", target: winner ?? loser };
}

/** Judge one drive against the oracle. The oracle is asked through `requireFamily` first, so a bracket kind with no
 *  family is the loud NoReferenceFamily, never a quiet skip, and an ambiguous match is AmbiguousReferenceFamily. */
export function judgeDrive(d: BracketDrive): Judgement {
  // First: a driver that answered nothing recorded no play to map (a forfeit drive then holds no forfeitPlay).
  if (d.status === null) return { judged: false, why: "the driver answered no status for the last event" };
  const c = bracketCaseOf(d);
  if ("notJudged" in c) return { judged: false, why: c.notJudged };
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
  // A refusal the product answered is judged against the oracle's: the same write refused with the same code (the drive
  // posts ONE bare write, so the oracle refuses exactly one), and one the oracle accepts is the product's defect.
  const refused = d.refusal;
  if (refused === null) {
    for (const r of expect.refused) bad.push(`the oracle refuses action ${r.index} with ${r.code}, which the harness drove as legal`);
  } else {
    const said = `${refused.status} ${refused.code ?? "(no code)"}`;
    if (expect.refused.length === 0) bad.push(`refusal: the product refused it ${said}, the oracle accepts it`);
    else if (expect.refused.length > 1 || expect.refused[0].code !== refused.code) bad.push(`refusal: the oracle refuses ${expect.refused.map((r) => `action ${r.index} with ${r.code}`).join(", ")}, the product ${said}`);
  }
  if (d.status !== expect.status) bad.push(`status: oracle ${expect.status}, product ${d.status}`);
  const won = d.outcome !== null && (d.outcome.kind === "win" || d.outcome.kind === "award") ? d.outcome : null;
  if (expect.advances === null) {
    if (won !== null) bad.push(`advance: oracle says nobody advances, product advanced ${won.winner}`);
  } else if (won === null) {
    bad.push(`advance: oracle says ${expect.advances.winner} advances by ${expect.advances.method}, product advanced nobody`);
  } else {
    const side = sideOf(d, won.winner);
    if (side !== expect.advances.winner) bad.push(`advance: oracle says ${expect.advances.winner} advances, product advanced ${side ?? `a stranger (${won.winner})`}`);
    const method = oracleMethod(won.kind === "win" ? won.method : won.reason);
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
    } else {
      // A loser line the oracle seats nobody on: a forfeit's loser is never seated on one (spec §5.3, X-DE-1, X-WD-5).
      const beaten = expect.advances.winner === "home" ? d.away : d.home;
      if (d.loser.seated === beaten) bad.push(`loser: oracle seats nobody on ${into} (a forfeit's loser), product seated ${beaten}`);
    }
  }
  const loserNotJudged = d.loser.line === "unresolved" ? d.loser.why : null;
  return bad.length === 0
    ? { judged: true, ok: true, note: `${where}: ${show(expect)}`, loserNotJudged }
    : { judged: true, ok: false, note: `${where}: ${bad.join("; ")} (oracle: ${show(expect)})`, loserNotJudged };
}
