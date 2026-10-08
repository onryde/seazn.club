// W2a (controller ruling T15-R3): the harness judges every bracket match it drives against the reference family
// `bracket-finish` (@seazn/reference — written from the signed rule rows by another agent, R8). The oracle never sees
// the product: it is given the ACTIONS the harness drove, in the rulebook's terms, and answers the status the fixture
// must have, who advances by which method, and which writes the rules refuse. This module turns one drive into the
// oracle's case, calls it, and compares the answer with what the product returned for the drive.
//
// What is compared, per drive: (1) the oracle refuses none of the actions the harness drove (the harness drives only
// legal sequences, so an oracle refusal is a disagreement about legality); (2) the fixture status; (3) who advanced
// and by which method. The oracle labels a play win "play"; the product's play wins carry whatever method the sport
// gave them (checkmate, a points win, none), so every method that is not `settled_*` or `tiebreak_*` is mapped to
// "play". The loser's seat is NOT compared: the product's bracket feeds are the existing bracket invariants' ground.
//
// A drive the oracle does not cover is not judged, and says why: `OutOfScope` and `RuledOut` are the oracle's own
// named exclusions, and a walkover (a forfeit) is not one of its actions. Not judged is COUNTED and named, never
// silent, and a run that judged nothing fails (zero is a failure, R25).
import { OutOfScope, RuledOut, expectBracketFinish, requireFamily, type Action, type BracketCase, type BracketExpect } from "@seazn/reference";
import type { StageKind } from "@seazn/engine/core";
import type { ObservedOutcome } from "./observed.ts";
import type { RequestedOutcome } from "./streams/types.ts";

/** One bracket fixture the harness drove: what it asked for, and what the product answered to the last event posted. */
export interface BracketDrive {
  readonly fixtureId: string;
  readonly stageKind: string;
  readonly sport: string;
  readonly home: string;
  readonly away: string;
  readonly asked: RequestedOutcome;
  /** The fixture status the product's last answer carried; null when the driver answered nothing. */
  readonly status: string | null;
  /** The outcome the product's last answer carried. */
  readonly outcome: ObservedOutcome | null;
}

export type Judgement =
  | { readonly judged: true; readonly ok: boolean; readonly note: string }
  | { readonly judged: false; readonly why: string };

/** The oracle's case for one drive, or the reason the oracle has no vocabulary for it. The mapping is by REQUEST kind:
 *  a win is a play win; `level` (and a draw or tie, which a bracket holds the same way) is a level play; a settle is
 *  the organiser's, after a level play or after an abandon; a tie-break is a drawn chess game's; an abandon is the
 *  organiser's with no play result. */
export function bracketCaseOf(d: BracketDrive): BracketCase | { readonly notJudged: string } {
  const a = d.asked;
  const base = { stageKind: d.stageKind as StageKind, sport: d.sport, hasLoserLine: false } as const;
  switch (a.kind) {
    case "win":
      return { ...base, play: { kind: "win", winner: a.winner }, actions: [] };
    case "level":
    case "draw":
    case "tie":
      return { ...base, play: { kind: "level" }, actions: [] };
    case "settle": {
      const settle: Action = { kind: "settle", winner: a.then, method: a.method, by: "organiser" };
      return a.after === "level"
        ? { ...base, play: { kind: "level" }, actions: [settle] }
        : { ...base, play: { kind: "none" }, actions: [{ kind: "abandon" }, settle] };
    }
    case "tiebreak":
      return { ...base, play: { kind: "level" }, actions: [{ kind: "tiebreak", rung: a.rung, winner: a.winner }] };
    case "abandon":
      return { ...base, play: { kind: "none" }, actions: [{ kind: "abandon" }] };
    case "forfeit":
      return { notJudged: "forfeit: a walkover is not one of the oracle's actions" };
  }
}

/** The product's method as the oracle names it: a settle and a tie-break keep theirs, every play win is "play". */
export function oracleMethod(method: string | undefined): string {
  return method !== undefined && (method.startsWith("settled_") || method.startsWith("tiebreak_")) ? method : "play";
}

const sideOf = (d: BracketDrive, winner: string): "home" | "away" | null => (winner === d.home ? "home" : winner === d.away ? "away" : null);

function show(expect: BracketExpect): string {
  const adv = expect.advances === null ? "nobody advances" : `${expect.advances.winner} advances by ${expect.advances.method}`;
  return `status ${expect.status}, ${adv}`;
}

/** Judge one drive against the oracle. The oracle is asked through `requireFamily` first, so a bracket kind with no
 *  family is the loud NoReferenceFamily, never a quiet skip. */
export function judgeDrive(d: BracketDrive): Judgement {
  const c = bracketCaseOf(d);
  if ("notJudged" in c) return { judged: false, why: c.notJudged };
  if (d.status === null) return { judged: false, why: "the driver answered no status for the last event" };
  requireFamily(c.stageKind, c.sport);
  let expect: BracketExpect;
  try {
    expect = expectBracketFinish(c);
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
  return bad.length === 0
    ? { judged: true, ok: true, note: `${where}: ${show(expect)}` }
    : { judged: true, ok: false, note: `${where}: ${bad.join("; ")} (oracle: ${show(expect)})` };
}
