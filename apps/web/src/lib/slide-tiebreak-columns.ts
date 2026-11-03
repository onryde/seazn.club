// W3 app-B T9 (ST-G21; rulebook-W3 §8 T9, X-SW-9) - which tie-break columns the TV board prints beside Pts.
//
// A Swiss table is decided by its ladders (Buchholz Cut-1, Buchholz, Opp diff), and a score board that left them off could
// not settle a cut or a seeding dispute standing in front of it (the disputes the owner wants gone). The board has room for
// two, and it prints the stage's OWN first two - the first two keys of ITS order that the engine declares Swiss-only and
// whose column the table shows - so a stage pinned to an older chain (no Buchholz) shows none, exactly as its public table.
import { validateCascade } from "@seazn/engine/competition";
import type { AnySportModule, TiebreakerKey } from "@seazn/engine/sport";
import type { StandingsColumn } from "@/lib/public-site";

/** Owner option A (controller ruling 2026-11-03): up to two tie-break columns after Pts. */
export const SLIDE_TIEBREAK_MAX = 2;

/**
 * The keys of `keys` the engine declares Swiss-only (`KEY_RULES[key].swissOnly`, cascade-rules.ts). The engine keeps that
 * table private and exports its verdicts through `validateCascade`: outside a Swiss stage, a Swiss-only key is refused with
 * `stage_format` (rule 3), whatever else the one-key order is refused for - so the declaration is read from the engine each
 * time and no list of keys is kept here. `module` is the division's pinned module (the validator needs a sport to run; the
 * answer does not depend on it). A module this build cannot resolve answers the empty set, and a key outside the engine's
 * vocabulary (a stored order is data; the validator throws CONFIG_INVALID on one) is not Swiss-only: the board degrades to "no
 * tie-break column", it never takes the TV down.
 */
export function swissOnlyKeysOf(module: AnySportModule | null, keys: readonly string[]): ReadonlySet<string> {
  const out = new Set<string>();
  if (module === null) return out;
  for (const key of keys) {
    try {
      const refusals = validateCascade([key as TiebreakerKey], { module, cfg: undefined, stageKind: "league", crossGroup: false });
      if (refusals.some((r) => r.key === key && r.reason === "stage_format")) out.add(key);
    } catch {
      // not a key of the engine's vocabulary
    }
  }
  return out;
}

/**
 * The slide's tie-break columns: walking the stage's `cascade` in order, the keys in `swissOnly` whose column `shown` holds
 * (the public table's own selection, `tableColumns`), at most `SLIDE_TIEBREAK_MAX`. In the cascade's order, not the column
 * list's: the order is the ranking's, and the first of two ladders is the one that decides first.
 */
export function slideTiebreakColumns(
  shown: readonly StandingsColumn[],
  cascade: readonly string[],
  swissOnly: ReadonlySet<string>,
): StandingsColumn[] {
  const out: StandingsColumn[] = [];
  for (const key of cascade) {
    if (out.length >= SLIDE_TIEBREAK_MAX) break;
    if (!swissOnly.has(key) || out.some((c) => c.key === key)) continue;
    const column = shown.find((c) => c.key === key);
    if (column !== undefined) out.push(column);
  }
  return out;
}
