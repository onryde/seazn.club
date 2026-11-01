// The score as levels (spec 2026-10-31-match-day-design.md §6.2, task B3): the sets or games a side has WON, the middle level
// (tennis's games in the set in play), and the live points of the level below. One reader, shared by Match Day's panel and rows
// and the public match page's large type, so the two surfaces cannot disagree about which number is which.
//
// Read from the engine's STRUCTURED summary fields, never from its headline: the headline is prose ("1 — 0 · 7–6(3) · 0–0"), and
// a tie-break's "(3)" in it is indistinguishable from a game's live points. The engine publishes no generic "levels" shape (and
// will not), so this is an apps/web adapter keyed on the summary's shape, as the public scoreboard (`setBreakdown`) already is:
//
//   - set-based kernel (badminton, table tennis, volleyball): `perSide[].line` is the sets/games won; `detail.sets` is
//     `{home, away, closed}[]`, and the entry with `closed: false` is the live set's points. No middle level.
//   - nested kernel (tennis): the same `detail.sets` shape, but the `closed: false` entry is the live set's GAMES (or, while a
//     match tie-break is under way, that tie-break's points); `detail.game` is the live game's point line ("40–30", "TB 3–2",
//     "MTB 5–3") and `detail.gameKind` says which of the three it is.
//
// Any other shape — cricket's innings, a football clock, a board game — answers null, and the caller keeps that sport's own
// headline and scorebug. Client-safe and DOM-free.
import { setBreakdown } from "@/lib/public-site";

export interface ScoreLevels {
  /** Sets (badminton and table tennis: games) won, home then away — each side's own `perSide` line, so a forfeit's credited
   *  sets read as the engine credits them. */
  won: readonly [number, number];
  /** Tennis: the games of the set in play, home then away. Null for a set-based sport (it has no games level), for a match
   *  tie-break (its points ARE the live level), and when no set is in progress. */
  mid: readonly [number, number] | null;
  /** The live level's score as the engine writes it: a set sport's open set ("12–10"), tennis's game ("40–30", "TB 3–2") or
   *  match tie-break ("MTB 5–3"). Null when nothing is in progress (between sets, before the first point).
   *
   *  It is the engine's open entry, so a match stopped mid-set by a forfeit or a retirement still carries it: a caller shows it
   *  only for a match that is in play. */
  live: { label: string } | null;
}

/** The three things a nested kernel's `detail.gameKind` can say; anything else is a shape this reader does not know. */
const GAME_KINDS: readonly string[] = ["standard", "tiebreak", "matchTiebreak"];

/** `perSide[i].line` as a count of sets or games won; null when it is not a plain count (then it is not a set score at all). */
function wonOf(line: unknown): number | null {
  return typeof line === "string" && /^\d+$/.test(line) ? Number(line) : null;
}

export function scoreLevels(summary: unknown): ScoreLevels | null {
  if (typeof summary !== "object" || summary === null) return null;
  const { perSide, detail } = summary as { perSide?: unknown; detail?: unknown };
  // A set table is what makes it a set sport. The unit (game or set) is the table's heading, not this reader's concern.
  const table = setBreakdown(summary, "");
  if (table === null || !Array.isArray(perSide) || perSide.length !== 2) return null;
  const home = wonOf((perSide[0] as { line?: unknown } | null)?.line);
  const away = wonOf((perSide[1] as { line?: unknown } | null)?.line);
  if (home === null || away === null) return null;
  const won: readonly [number, number] = [home, away];

  // The open set: the first entry the engine marks `closed: false`, never "the last one" (hubHeader's note).
  const open = table.sets.find((s) => !s.closed);
  const { game, gameKind } = (detail ?? {}) as { game?: unknown; gameKind?: unknown };
  if (typeof game !== "string") {
    // Set-based: no games level; the open set's points are the live level.
    return { won, mid: null, live: open === undefined ? null : { label: `${open.home}–${open.away}` } };
  }
  // Nested (tennis). An unknown game kind is a shape this does not know: the caller's headline is the safe answer.
  if (typeof gameKind !== "string" || !GAME_KINDS.includes(gameKind)) return null;
  if (open === undefined) return { won, mid: null, live: null };
  return {
    won,
    // The open entry holds the match tie-break's POINTS, not games: there is no middle level then.
    mid: gameKind === "matchTiebreak" ? null : [open.home, open.away],
    live: { label: game },
  };
}
