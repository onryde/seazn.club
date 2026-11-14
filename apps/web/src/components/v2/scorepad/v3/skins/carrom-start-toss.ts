// Quick match carrom (whole review m6, controller PO rec 2026-11-14): the carrom toss asked as part of starting the match,
// the way cricket's is on a quick match pad (`cricket-start-toss.ts`) and tennis's everywhere (`tennis.tsx`'s
// `startTossQuestion`).
//
// Why at Start: the engine takes `carrom.toss` only before `core.start` (the fold's WRONG_PHASE "toss must precede
// core.start"), and the remote pad (`device-score-pad.tsx`) mounts the live pad only once the match has started, so the
// skin's Toss tile (phase "pre") is never on screen there. Without this a quick match's guest could never say who breaks
// first, and the fold's default (home breaks, "Absent a toss, home breaks first") decided every game one. Asked only on a
// quick match pad (`useStartWithToss`'s `quickMatchToss`): the console mounts its pad before the Start and keeps the Toss
// tile, and an organiser's remote pad is unchanged.
//
// One required question, the skin's own Toss sheet's ("Who breaks first?", `pad.carrom.sheet.toss.firstBreak.title`):
// the two sides, named as typed, each setting the toss's one field (`CarromToss = { firstBreak }`).
import type { TossSide } from "./tennis";
import type { DockChip, DockSpec } from "../types";

export const CARROM_TOSS_TYPE = "carrom.toss";

type TFn = (key: string, vars?: Record<string, string | number>) => string;

/** Whether Start still owes the toss, read off the stored fold (`/state`'s `state`: null until the ledger holds an event):
 *  only before the Start, and only while no toss is held (a voided one is not). */
export function carromTossOpen(state: unknown): boolean {
  if (state === null || state === undefined) return true;
  const s = state as { phase?: unknown; tossTaken?: unknown };
  return s.phase === "pre" && s.tossTaken !== true;
}

/** "Who breaks first?": one chip per side, home first, each named as typed and setting the toss's `firstBreak`. */
export function carromTossQuestion(home: TossSide, away: TossSide, t: TFn): DockSpec {
  const chip = (side: "home" | "away", entrant: TossSide): DockChip => ({
    id: side,
    label: side === "home" ? "scorepad.attribution.home" : "scorepad.attribution.away",
    labelText: entrant.name,
    mutate: (payload: Record<string, unknown>) => ({ ...payload, firstBreak: entrant.id }),
  });
  return { title: t("pad.carrom.sheet.toss.firstBreak.title"), chips: [chip("home", home), chip("away", away)], requires: "firstBreak" };
}

/** The `carrom.toss` event a chip of that question makes. */
export function carromTossEvent(chip: DockChip): { type: string; payload: Record<string, unknown> } {
  return { type: CARROM_TOSS_TYPE, payload: { firstBreak: String(chip.mutate({}).firstBreak) } };
}
