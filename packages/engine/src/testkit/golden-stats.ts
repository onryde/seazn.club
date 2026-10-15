// GF-2 T4 — the final player-stats rows of a stream, recorded beside what a phone computes (corpus FORMAT 3).
// Design: docs/superpowers/specs/engine-split/gf2-kernel-overlay-design.md (§6 Q2, §7 T4).
//
// `aggregatePlayerStats` (src/stats/stats.ts) is the fold behind every leaderboard: goals, assists, cards, an award's credit,
// the keeper and set/match rows of the sports that fold them. Only the SERVER runs it (the S2 contract: a phone must not compute
// or render player stats), so a change to it moves what the server stores and shows and nothing a scorer's phone plays by. That
// is why the field it fills is a MINOR of the epoch pair (owner ruling Q2, 2026-10-15): the guard asks for a FOLD_MINOR bump and
// never forces a FOLD_EPOCH on its own.
//
// What is recorded is the fixture's FINAL rows, once per stream, in the shape the server hands the fold for one fixture
// (`foldDivision`, apps/web `usecases/player-stats.ts`): the void-resolved ledger, the team sheets, and a ctx naming the fixture's
// own two entrants. The text is CANONICAL — rows by personId, stat keys by name, both in code-unit order — so a refactor that only
// reorders what the fold emits moves no byte, and a change that moves a number, a key or a row does.
//
// This file is PURE (no node:fs, no node:crypto); golden.ts imports it, never the other way round.
import type { EventEnvelope } from "../core/events.ts";
import type { LineupPair } from "../core/types.ts";
import { effectiveEntrantModel } from "../sport/entrant-model.ts";
import type { AnySportModule } from "../sport/module.ts";
import { aggregatePlayerStats, type PlayerStatRow, type PlayerStatsFoldCtx } from "../stats/stats.ts";

/** What the server's `entrantFoldCtx` builds for one fixture, from what the corpus knows: the fixture's two entrants (the team
 *  sheets' own ids), of the kind the sport DECLARES (`entrantModel`, read through the engine's own `effectiveEntrantModel`), whose
 *  persons are the sheet's, and the parsed config (the set/game replay of the folded rows reads it). */
export function statsCtxOf(module: AnySportModule, cfg: unknown, lineups: LineupPair): PlayerStatsFoldCtx {
  const kind = effectiveEntrantModel(module.entrantModel).defaultKind;
  const sheets = [lineups.home, lineups.away];
  return {
    entrants: sheets.map((sheet) => ({ id: sheet.entrantId, kind })),
    personsOf: (entrantId) => sheets.find((sheet) => sheet.entrantId === entrantId)?.slots.map((slot) => slot.personId) ?? [],
    cfg,
  };
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The rows as the text a stream stores: `[{"personId":…,"stats":{…}},…]`, rows by personId and keys by name (code-unit order,
 *  never locale: the fold sorts with `localeCompare`, which is an environment's opinion). A value that is not a finite number is
 *  refused rather than written, because `JSON.stringify` would record `null` for it and a stat that silently became `null` is a
 *  pin on nothing; so is a person who appears twice, which the fold cannot produce and a reordering would hide. */
export function canonicalStatRows(rows: readonly PlayerStatRow[]): string {
  const seen = new Set<string>();
  const canonical = [...rows]
    .sort((a, b) => byCodeUnit(a.personId, b.personId))
    .map((row) => {
      if (seen.has(row.personId)) throw new Error(`player stats: person "${row.personId}" has two rows, so the record cannot be canonical`);
      seen.add(row.personId);
      const stats = Object.fromEntries(
        Object.entries(row.stats)
          .sort(([a], [b]) => byCodeUnit(a, b))
          .map(([key, value]) => {
            if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`player stats: ${row.personId}.${key} is ${String(value)}, not a finite number`);
            return [key, value] as const;
          }),
      );
      return { personId: row.personId, stats };
    });
  return JSON.stringify(canonical);
}

/** The final player-stats rows of a ledger, as recorded. A sport that declares no stat model records `[]` (no rows to fold); every
 *  builtin declares one, which a test counts. `envelopes` is the whole ledger, voids included: the fold resolves them itself. */
export function recordPlayerStats(module: AnySportModule, cfg: unknown, lineups: LineupPair, envelopes: readonly EventEnvelope[]): string {
  const model = module.playerStats;
  if (model === undefined) return "[]";
  return canonicalStatRows(aggregatePlayerStats(envelopes, model, lineups, statsCtxOf(module, cfg, lineups)));
}

/** A recorded `playerStats` text read back as rows, or null when it is not the canonical form's shape. */
export function readStatRows(text: string): PlayerStatRow[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const rows: PlayerStatRow[] = [];
  for (const row of parsed as unknown[]) {
    if (typeof row !== "object" || row === null) return null;
    const { personId, stats } = row as { personId?: unknown; stats?: unknown };
    if (typeof personId !== "string" || typeof stats !== "object" || stats === null || Array.isArray(stats)) return null;
    rows.push({ personId, stats: stats as Record<string, number> });
  }
  return rows;
}

/** The stat keys whose value differs between two recorded texts for ANY person, sorted. A row that exists on one side only moves
 *  every key it holds. Text that is not rows reads as one moved "key", and equal values in another order as `(key order)`: a diff
 *  never says "nothing moved" about two texts that differ. */
export function movedStatKeys(recorded: string, replayed: string): string[] {
  if (recorded === replayed) return [];
  const a = readStatRows(recorded);
  const b = readStatRows(replayed);
  if (a === null || b === null) return ["(playerStats is not a list of rows)"];
  const left = new Map(a.map((row) => [row.personId, row.stats]));
  const right = new Map(b.map((row) => [row.personId, row.stats]));
  const moved = new Set<string>();
  for (const person of new Set([...left.keys(), ...right.keys()])) {
    const x = left.get(person) ?? {};
    const y = right.get(person) ?? {};
    for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) if (x[key] !== y[key]) moved.add(key);
  }
  return moved.size === 0 ? ["(key order)"] : [...moved].sort(byCodeUnit);
}

/** Names what moved between two recorded `playerStats` texts: each person whose row differs, with the stat and its two values. */
export function statsMismatch(recorded: string, replayed: string): string {
  const a = readStatRows(recorded);
  const b = readStatRows(replayed);
  if (a === null || b === null) return `recorded ${recorded}, replayed ${replayed}`;
  const left = new Map(a.map((row) => [row.personId, row.stats]));
  const right = new Map(b.map((row) => [row.personId, row.stats]));
  const parts: string[] = [];
  for (const person of [...new Set([...left.keys(), ...right.keys()])].sort(byCodeUnit)) {
    const x = left.get(person);
    const y = right.get(person);
    if (x === undefined) parts.push(`${person} is a new row in the replay (${JSON.stringify(y)})`);
    else if (y === undefined) parts.push(`${person} has no row in the replay (recorded ${JSON.stringify(x)})`);
    else {
      for (const key of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort(byCodeUnit)) {
        if (x[key] !== y[key]) parts.push(`${person} ${key}: recorded ${x[key] === undefined ? "none" : x[key]}, replayed ${y[key] === undefined ? "none" : y[key]}`);
      }
    }
  }
  return parts.length === 0 ? `the text moved but no value did (a key-order change): recorded ${recorded}, replayed ${replayed}` : `the player stats moved: ${parts.join("; ")}`;
}
