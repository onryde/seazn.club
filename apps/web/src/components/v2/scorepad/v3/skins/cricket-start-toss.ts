// Quick match cricket (decision log 2026-11-13: QM cricket = bands 0–1, and the toss is band 1): the cricket toss asked
// as part of starting the match, the way tennis asks "Who serves first?" (S2-7, `tennis.tsx`'s `startTossQuestion`).
//
// Why at Start: the engine takes `cricket.toss` only before `core.start` (the fold's WRONG_PHASE "toss must precede
// core.start"), and the remote pad (`device-score-pad.tsx`) mounts the live pad only once the match has started, so the
// skin's Toss tile (phase "pre") is never on screen there. Without this a quick match's guest could never say who batted
// first, and the fold's default (home bats) would decide it. Asked only on a quick match pad (`useStartWithToss`'s
// `quickMatchToss`): the console mounts its pad before the Start and keeps the Toss tile, and an organiser's remote pad is
// unchanged.
//
// Two required questions, each a `ChoiceDock` of its own: who won the toss (the two sides, named as typed), then what they
// chose (the engine's own elections, `cricketPadRules.tossElections`, labelled through the shared vocabulary the skin's
// Toss sheet uses, so both read the same words). Their answers build the one `cricket.toss` payload `CricketToss` takes.
import { cricketPadRules } from "@seazn/engine/pad";
import type { MessageKey } from "@/lib/messages";
import { ENUM_VOCAB } from "@/lib/scoring-vocab";
import type { TossSide } from "./tennis";
import type { DockSpec } from "../types";

export const CRICKET_TOSS_TYPE = "cricket.toss";

type TFn = (key: string, vars?: Record<string, string | number>) => string;

/** Whether Start still owes the toss, read off the stored fold (`/state`'s `state`: null until the ledger holds an event,
 *  and an empty ledger holds no toss): only before the Start, and only while no toss is held (a voided one is not). */
export function cricketTossOpen(state: unknown): boolean {
  if (state === null || state === undefined) return true;
  const s = state as { phase?: unknown; tossTaken?: unknown };
  return s.phase === "pre" && s.tossTaken !== true;
}

/** "Who won the toss?": one chip per side, home first, each named as typed and setting the toss's `wonBy`. */
export function cricketTossWonQuestion(home: TossSide, away: TossSide, t: TFn): DockSpec {
  const chip = (side: "home" | "away", entrant: TossSide) => ({
    id: side,
    label: side === "home" ? "scorepad.attribution.home" : "scorepad.attribution.away",
    labelText: entrant.name,
    mutate: (payload: Record<string, unknown>) => ({ ...payload, wonBy: entrant.id }),
  });
  return { title: t("pad.cricket.sheet.toss.wonBy.title"), chips: [chip("home", home), chip("away", away)], requires: "wonBy" };
}

/** The shared vocabulary's key for an election (the skin's Toss sheet reads the same). Throws for one it has no key for:
 *  unreachable through the engine's closed list, never a raw word on screen. */
function electedKey(value: string): MessageKey {
  for (const map of ENUM_VOCAB.elected ?? []) if (value in map) return map[value]!;
  throw new Error(`cricket toss: no vocabulary key for elected="${value}"`);
}

/** "Bat or bowl?": the engine's own elections, in its order, each setting the toss's `elected`. */
export function cricketTossElectedQuestion(t: TFn): DockSpec {
  return {
    title: t("pad.cricket.sheet.toss.elected.title"),
    chips: cricketPadRules.tossElections.map((id) => ({
      id,
      label: electedKey(id),
      mutate: (payload: Record<string, unknown>) => ({ ...payload, elected: id }),
    })),
    requires: "elected",
  };
}

/** The `cricket.toss` event the two answers make. */
export function cricketTossEvent(wonBy: string, elected: string): { type: string; payload: Record<string, unknown> } {
  return { type: CRICKET_TOSS_TYPE, payload: { wonBy, elected } };
}
