// W4 app-A Task 3 (gap K2; engine row X-SD-5): ONE predicate for "this fixture row is a bye line" — a line nobody plays,
// so it never takes a court or a time. Client-safe (no server import), so the server's placement writers, the board and
// Rebuild's slot carry can all read the same answer. Its SQL twin is `byeLineSql` (server/engine-db/system-bye-sql.ts);
// both are held to one table of shapes (lib/__tests__/bye-line-shapes.ts).
import { isSwissByeShellExtKey } from "@/lib/swiss-shell";

/** The slot label stamped on a bye's PHANTOM side — the seat the bracket pads out and nobody ever occupies (W4 ruling
 *  D7: one authority, in `lib/` so a client-safe reader can import it). Stamped by both generation paths
 *  (`generateStageFixtures`' own insert and the `timing: "setup"` progression path's label pass) and by a withdrawal's
 *  dead seat, and read back by `awardSeededByes` as the marker that says "this line is a walkover, not a match still
 *  waiting on an opponent". The public hub keys its bye detection on the same key (public-site/competition-hub.ts). */
export const BYE_SLOT_LABEL = { key: "bracket.slot.bye", params: {} } as const;

/** The columns `isByeLine` reads off a fixtures row. */
export interface ByeLineRow {
  ext_key: string | null;
  status: string;
  outcome: unknown;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  home_slot_label: unknown;
  away_slot_label: unknown;
}

const labelKey = (label: unknown): unknown =>
  label !== null && typeof label === "object" ? (label as { key?: unknown }).key : undefined;

/** `systemByeSql`'s TS twin: an `award` with reason `bye` over at most one seat, that seat (if any) the winner. The
 *  orphan — both seats empty, its holder deleted — is still one; a `withdrew` walkover (ruling 116) is not. */
function isSystemBye(f: ByeLineRow): boolean {
  if (f.outcome === null || typeof f.outcome !== "object") return false;
  const o = f.outcome as { kind?: unknown; reason?: unknown; winner?: unknown };
  if (o.kind !== "award" || o.reason !== "bye") return false;
  if (f.home_entrant_id !== null && f.away_entrant_id !== null) return false;
  const seat = f.home_entrant_id ?? f.away_entrant_id;
  return seat === null || o.winner === seat;
}

/** A bye line's PHANTOM side: the EMPTY side carrying the bye slot label (home first), or null when neither is. A seated
 *  side is no phantom, whatever its label. The other side is the one that sits out — the run sheet's bye row names it
 *  (B1a review N1). */
export function byePhantomSide(
  f: Pick<ByeLineRow, "home_entrant_id" | "away_entrant_id" | "home_slot_label" | "away_slot_label">,
): "home" | "away" | null {
  if (f.home_entrant_id === null && labelKey(f.home_slot_label) === BYE_SLOT_LABEL.key) return "home";
  if (f.away_entrant_id === null && labelKey(f.away_slot_label) === BYE_SLOT_LABEL.key) return "away";
  return null;
}

/** A bye line before its award: `scheduled`, no outcome, and a phantom side (`byePhantomSide`). Covers the
 *  `timing: "setup"` bracket's day-one line (no seat yet), the moment its seed is filled but not yet awarded, and a
 *  withdrawal's dead seat waiting on the side that walks over it. */
function isPreAwardByeLine(f: ByeLineRow): boolean {
  if (f.status !== "scheduled" || f.outcome != null) return false;
  return byePhantomSide(f) !== null;
}

/**
 * THE predicate for "this row is a bye line": a Swiss bye shell (`isSwissByeShellExtKey`, seated or not), a system bye
 * (`isSystemBye`, the TS twin of `systemByeSql`), or a pre-award bye line. A bye is not played, so it takes no court
 * and no time (W3 spec §4, X-SW-29; W4 X-SD-5): `isMovable`/`heldInPlace` keep every builder off it, and `moveFixture`
 * refuses to place it (BYE_LINE_NOT_PLACEABLE).
 */
export function isByeLine(f: ByeLineRow): boolean {
  return isSwissByeShellExtKey(f.ext_key) || isSystemBye(f) || isPreAwardByeLine(f);
}

/**
 * A bye line nobody has settled yet (`scheduled`): it waits, and no one can ever give it a court or a time
 * (BYE_LINE_NOT_PLACEABLE), so it is no scheduling work owed — the desk counts no "unscheduled" for it (B1a review #1;
 * W3 T3 did the same for the unseated Swiss shell). Once settled (its award written, `forfeited`) it is an ordinary
 * decided line, as every other settled match is. The board reads the same answer through its `bye_line` flag
 * (`byeLineSql`) beside its own `status === "scheduled"` gate (components/v2/board/types.ts); the division Fixtures
 * tab's `isBye` (lib/run-sheet-groups.ts) reads this predicate itself (B1a review N1).
 */
export function isWaitingByeLine(f: ByeLineRow): boolean {
  return f.status === "scheduled" && isByeLine(f);
}
