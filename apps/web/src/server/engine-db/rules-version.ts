import "server-only";
// W2c Task 15 (X-SR-7, D14, owner P-1 "A") — the rules version an open scoring pad compares.
//
// `fixtures.rules_version` counts the corrections of a match's format, whoever made them: a started match's live
// correction or staff re-freeze (`refreeze.ts`), and — fix round 1 (review I-1) — any write that moves what a match with
// no frozen cfg resolves to (`bumpMovedRules` below, the per-match override's `bumpRulesVersion`). A pad loads it with
// the cfg it folds under and sends it with every tap; the append path refuses a version that is not the match's
// (`append-event.ts`), and the pad reloads the rules through `GET /api/v1/fixtures/{id}/rules` and says what they now
// are — this module's rules line (the public line's composer), in the reader's language.
import type postgres from "postgres";
import type { AnySportModule } from "@seazn/engine/sport";
import { canonicalJson } from "@/lib/canonical-json";
import type { Tx } from "@/lib/db";
import type { Dict } from "@/lib/i18n-constants";
import { rulesLineText } from "@/lib/rules-line";
import { matchRulesLine } from "@/server/public-site/describe-rules";
import { hasFrozenCfg, resolveFixtureCfg, stageForfeitAward } from "./fixture-cfg";
import { resolveModule } from "./registry";

/**
 * A match's rules as the public line says them (`matchRulesLine`, the one composer every surface uses): the format, then
 * how a tied match ends in a stage of `stageKind`, then the abandon policy the stage changed from `divisionCfg`'s - in
 * `dict`'s language. Null when the describer has nothing honest to say of this sport or cfg; the caller then says "the
 * format changed" without naming it.
 *
 * Review I-1: this used to be the FORMAT alone, so a correction that moved only a decider (football's extra time
 * switched off, a shorter shoot-out) showed the scorer a banner over a line that had not changed.
 */
export function formatLineOf(
  sportKey: string,
  module: AnySportModule,
  cfg: unknown,
  stageKind: string | null | undefined,
  divisionCfg: unknown,
  dict: Dict,
): string | null {
  const line = matchRulesLine(sportKey, module, cfg, divisionCfg, stageKind);
  return line === null ? null : rulesLineText(dict, line);
}

/** One match's own version moved by one: the per-match override's bump (`fixture-rules.ts`), under the fixture lock
 *  every append takes before it reads the version. Returns the version the match now carries. */
export async function bumpRulesVersion(tx: Tx, fixtureId: string): Promise<number> {
  const [row] = await tx<{ rules_version: number }[]>`
    update fixtures set rules_version = rules_version + 1 where id = ${fixtureId} returning rules_version`;
  if (!row) throw new Error(`bumpRulesVersion: no fixture ${fixtureId}`);
  return row.rules_version;
}

/** Which matches a format save may move: a division's (`patchDivision`) or one stage's (`putStageRules`). */
export type RulesScope = { readonly divisionId: string } | { readonly stageId: string };

/** What each match a format save may move resolves to BEFORE it writes (`unfrozenRules`), canonical, by fixture id. */
export type UnfrozenRules = ReadonlyMap<string, string>;

/**
 * W2c Task 15 fix round 1 (review I-1) — a format save moves what every match with no frozen cfg will freeze at its first
 * event, so a pad opened on such a match before the save must be refused on its first tap, not let it freeze a format
 * the pad is not folding. Read BEFORE the save's first write, under its `division-config:` EXCLUSIVE lock (no first
 * event can freeze in between): every such match in `scope` and what it resolves to now, through the fold's own
 * resolver (`resolveFixtureCfg` over the row — division, stage, deciders, the match's own override).
 *
 * "Such a match": no frozen cfg (a started match keeps its snapshot, and a save never moves it — the stage lock refuses
 * what it inherits) and not a SEEDED BYE: the system's award with no feeder, which no take-back can ever reopen, so no pad
 * is ever opened on it (and its format is locked against the per-match writer — `fixture-rules.ts` (7a)). Every other
 * shape with no frozen cfg is read, an event-less award included (batch-5 re-review, Q5): a take-back can reopen one that
 * HAS feeders (`fed-seats.ts`: the walkover revive, the reset release) — and the award a dead seat leaves in a later round
 * is written with `reason: "bye"` too (`awardSeededByes`' cascade, stages.ts), so the reason alone cannot tell a seeded bye
 * from it; a feeder can. A table (points-scope) key is not refused on a played knockout (`rule-locks.ts` "a knockout has no
 * table to protect"), so a division save can move what that award resolves to after a pad loaded it and before the
 * reopen. A bump at the save is the only place that can see the move; nothing bumps at the reopen. A match decided by
 * recorded play with no frozen cfg (the legacy shape before V347) folds under the live format, so it is one too.
 */
export async function unfrozenRules(tx: Tx, scope: RulesScope): Promise<UnfrozenRules> {
  return resolvedNow(tx, "stageId" in scope ? tx`f.stage_id = ${scope.stageId}` : tx`f.division_id = ${scope.divisionId}`);
}

/**
 * After the save's writes, in its transaction: every match `before` read whose resolved format moved has its version
 * bumped by one, and its id returned. A save that moved nothing a match plays — a re-send of what is stored, a key the
 * match's own override already fixes — bumps nothing.
 */
export async function bumpMovedRules(tx: Tx, before: UnfrozenRules): Promise<string[]> {
  if (before.size === 0) return [];
  const now = await resolvedNow(tx, tx`f.id in ${tx([...before.keys()])}`);
  const moved = [...before].filter(([id, cfg]) => now.get(id) !== cfg).map(([id]) => id);
  if (moved.length === 0) return [];
  await tx`update fixtures set rules_version = rules_version + 1 where id in ${tx(moved)}`;
  return moved;
}

async function resolvedNow(tx: Tx, where: postgres.PendingQuery<postgres.Row[]>): Promise<Map<string, string>> {
  const rows = await tx<
    {
      id: string;
      config_snapshot: unknown;
      rules_override: unknown;
      division_config: unknown;
      sport_key: string;
      module_version: string;
      stage_kind: string | null;
      stage_config: Record<string, unknown> | null;
    }[]
  >`
    select f.id, f.config_snapshot, f.rules_override, d.config as division_config, d.sport_key, d.module_version,
           s.kind as stage_kind, s.config as stage_config
      from fixtures f join divisions d on d.id = f.division_id left join stages s on s.id = f.stage_id
     where ${where}
       and not (coalesce(f.outcome->>'reason', '') = 'bye'
                and not exists (select 1 from fixtures g where g.winner_to_fixture = f.id or g.loser_to_fixture = f.id))`;
  const out = new Map<string, string>();
  for (const r of rows) {
    if (hasFrozenCfg(r.config_snapshot)) continue;
    const m = resolveModule(r.sport_key, r.module_version);
    const stage = { kind: r.stage_kind, config: r.stage_config };
    // W2c Task 16b: what a walkover of this match credits is part of what it resolves to - the stage rule's award is not in
    // the cfg (`stageForfeitAward`), so a save that moves only the award moves this too.
    out.set(r.id, canonicalJson({ cfg: resolveFixtureCfg(r, r.division_config, stage, m), forfeitAward: stageForfeitAward(stage, m) ?? null }));
  }
  return out;
}
