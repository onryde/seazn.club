// W3 Task 8 — a Swiss round 1's draw and colour lot, as pure functions (spec 2026-10-31-format-matrix-w3-swiss-design.md
// §12; rulebook RB3-10, RB3-16):
//   X-SW-22 — an unseeded round 1 is a SEEDED random draw, never registration order. The seed is the stage's own id
//             (`swissDrawSeed`), so a draw replays: an Undo then Redo of the Pair, or an Unpair then Pair, seats the
//             same round, and the `fixtures_generated` row records the seed (`draw_seed`).
//   BG-SW-1 — chess colours are on by default for a NEW boardgame Swiss (`defaultSwissChess`, read only at stage
//             creation: a stage stored before W3 with `chess` unset keeps its colours off), and round 1's colours are
//             by lot (`swissColourLot`, FIDE C.04.3 A3 5.1): board 1's upper player takes the lot's colour and the
//             boards alternate (`applyRoundOneColourLot`). Home is White.
//
// Client-safe and import-free but for the chess predicate (itself import-free): the desk's pairing menu and the smoke
// runner (`node --experimental-strip-types`) load this file, so it may import nothing from the server or through `@/`.
import { isChessSport } from "./chess-individual-only-rule.ts";

/** The published mulberry32 PRNG: a 32-bit seed to a stream of floats in [0, 1). Moved here from
 *  `lib/marketing/club-names.ts` (which imports it back), so the product has one copy of the app's own. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** X-SW-22 — a stage's draw seed: the 32-bit FNV-1a hash of its id. Stable for the stage's life, so its round-1 draw
 *  and colour lot replay exactly; recorded on the Pair's `fixtures_generated` row as `draw_seed`. */
export function swissDrawSeed(stageId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < stageId.length; i++) {
    h ^= stageId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * X-SW-22 — round 1's pairing order: the seeded entrants first, by seed (a tie keeps the order given), then the
 * unseeded ones, Fisher–Yates shuffled with `mulberry32(seed)`. The FIDE initial order (rating, title, name) needs
 * ratings the product does not hold (RB3-16), so the draw stands in for it. A wholly seeded field is not drawn at all.
 * Same seed and same field (same order in) ⇒ the same order out.
 */
export function swissRoundOneOrder(seed: number, entrants: readonly { id: string; seed: number | null }[]): string[] {
  const seeded = entrants.filter((e) => e.seed !== null).sort((a, b) => a.seed! - b.seed!);
  const drawn = entrants.filter((e) => e.seed === null).map((e) => e.id);
  const rand = mulberry32(seed);
  for (let i = drawn.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [drawn[i], drawn[j]] = [drawn[j]!, drawn[i]!];
  }
  return [...seeded.map((e) => e.id), ...drawn];
}

/** Salt for the colour lot's own stream, so the lot is not the draw's first number. */
const LOT_SALT = 0x9e3779b9;

/** BG-SW-1 — the round-1 colour lot (FIDE C.04.3 A3 5.1): the colour board 1's upper player takes. Recorded on the
 *  Pair's `fixtures_generated` row as `colour_lot`. */
export function swissColourLot(seed: number): "white" | "black" {
  return mulberry32((seed ^ LOT_SALT) >>> 0)() < 0.5 ? "white" : "black";
}

/** BG-SW-1 / RB3-10 — whether a NEW Swiss stage on this sport is stored with `chess: true`. Read ONLY where a stage is
 *  created (`validatedStageConfig`); Pair reads the stored `cfg.chess === true` (orchestrator ruling m5). */
export function defaultSwissChess(sportKey: string): boolean {
  return isChessSport(sportKey);
}

/**
 * BG-SW-1 — round 1's colours by lot. Takes `pairRound`'s round-1 pairings, which seat the upper player at home (the
 * engine's non-chess rule, and its chess rule when every colour is neutral), in board order, and returns them with board
 * i (0-based) keeping upper-at-home iff `(i % 2 === 0) === (lot === "white")`: home is White, so board 1's upper player
 * takes the lot's colour and every board after alternates. A new list; the input is not changed.
 */
export function applyRoundOneColourLot<P extends { home: string; away: string }>(
  pairings: readonly P[],
  lot: "white" | "black",
): P[] {
  return pairings.map((p, i) => ((i % 2 === 0) === (lot === "white") ? { ...p } : { ...p, home: p.away, away: p.home }));
}
