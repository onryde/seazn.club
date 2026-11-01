import "server-only";
// server/sponsors/on-stream.ts - R4 sponsors on stream, S12: what the Sponsors hub's On stream tab reads that is not a sponsor row
// (spec 2026-10-27 §5.1). Three things, each from the authority that already owns it:
//   - the dial IN FORCE for the scope the tab is on: S5's `resolveStreamSettings` (a competition's row, else the org's - the ONE
//     statement), plus whether the scope has a row of its own (so the tab can say "uses the organisation's setting");
//   - the sports the scope plays (its divisions' `sport_key`), and for each the sport's declared break kinds
//     (`naturalBreaks.kinds`, the engine's declaration) - the static line the tab shows when there is no match to count over;
//   - for each sport that declares breaks, the breaks of the org's most recent FINISHED fixture of that sport (ruling R11): the
//     REAL ledger, folded through the REAL engine (`loadFoldInputs` / `foldFrom` / `replayDerived` - the overlay's own replay,
//     so `naturalBreaks.opensAt` and `breakSizeOf` decide what a break is). No sample table, no testkit.
//
// The preview NUMBERS are not computed here: the tab runs the pure planner over these breaks (`previewForSport`) on every tick
// and every dial move. This module only reads facts.
import { builtinModules } from "@seazn/engine/sports";
import { withTenant, type Tx } from "@/lib/db";
import { EngineError } from "@seazn/engine/core";
import { log } from "@/server/logger";
import { foldFrom, loadFoldInputs } from "@/server/engine-db/fold";
import { replayDerived } from "@/server/overlay/recent";
import type { BreakDecl, BreakOpened } from "@/lib/sponsor-plan";
import type { SportPreviewSource } from "@/lib/sponsor-preview";
import { resolveStreamSettings, type StreamSettings } from "./stream-settings";

export type { SportPreviewSource };

/** How many of a sport's most recent finished fixtures are tried before giving up on a sample (a fold that refuses one, or a
 *  ledger with no breaks, moves on to the next). */
export const PREVIEW_CANDIDATES = 5;

export interface OnStreamScopeData {
  /** The settings in force for the scope (S5's resolver), or null: no row for the scope or its org - the rotation is off. */
  settings: StreamSettings | null;
  /** The scope has a row of its own (always the case when `settings` is set on the org scope). */
  ownRow: boolean;
  /** Every sport the scope plays, by key. */
  sports: SportPreviewSource[];
}

const kindsOf = (sportKey: string): readonly BreakDecl[] | null =>
  builtinModules.find((m) => m.key === sportKey)?.naturalBreaks?.kinds.map((k) => ({ kind: k.kind, size: k.size })) ?? null;

/**
 * The breaks of the scope's most recent finished fixture of `sportKey`. "Finished" here is a match played to a result
 * (`decided` or `finalized`) with a ledger: an abandoned match is cut short, and a forfeit or a cancellation has no play to
 * count, so none of them says how many breaks a match of this sport has. A candidate whose fold refuses, whose replay stops
 * part-way (`breaksComplete` false - a missing break would be unproven, not absent) or that opened no break is skipped for the
 * next most recent, up to `PREVIEW_CANDIDATES`.
 */
export async function latestFinishedBreaks(
  tx: Tx,
  orgId: string,
  sportKey: string,
  competitionId: string | null,
): Promise<BreakOpened[] | null> {
  const candidates = await tx<{ id: string }[]>`
    select f.id from fixtures f
      join divisions d on d.id = f.division_id
     where d.org_id = ${orgId} and d.sport_key = ${sportKey}
       and (${competitionId}::uuid is null or d.competition_id = ${competitionId})
       and f.status in ('decided', 'finalized')
       and exists (select 1 from score_events e where e.fixture_id = f.id)
     order by f.finished_at desc nulls last, f.id desc
     limit ${PREVIEW_CANDIDATES}`;
  for (const { id } of candidates) {
    try {
      const inputs = await loadFoldInputs(tx, id);
      if (inputs === null) continue;
      const folded = foldFrom(id, inputs);
      const replay = replayDerived({
        sportKey: inputs.sportKey,
        module: inputs.module,
        cfg: inputs.cfg,
        lineups: inputs.lineups,
        active: folded.active,
      });
      if (replay.breaksComplete && replay.breaks.length > 0) return replay.breaks;
    } catch (err) {
      // A fold that refuses (an entrant deleted after scoring, a module version this build no longer ships) costs the preview
      // that one candidate, never the page. Anything that is not the engine's own refusal is a bug and is logged as one.
      if (EngineError.is(err)) log.warn({ fixtureId: id, code: err.code }, "sponsors on stream: preview fixture skipped");
      else log.error({ err, fixtureId: id }, "sponsors on stream: preview fixture failed");
    }
  }
  return null;
}

/**
 * The On stream tab's per-scope facts. `competitionId` is the picker's choice, ALREADY validated against the org's
 * competitions by the caller (`resolveOnStreamScope`): null is the organisation-wide scope. A competition scope previews over its
 * own sports and its own finished fixtures; the organisation scope over all of them.
 */
export async function loadOnStreamScope(orgId: string, competitionId: string | null): Promise<OnStreamScopeData> {
  return withTenant(orgId, async (tx) => {
    const settings = await resolveStreamSettings(tx, orgId, competitionId);
    const [own] = await tx<{ n: number }[]>`
      select count(*)::int as n from sponsor_stream_settings
       where org_id = ${orgId} and competition_id is not distinct from ${competitionId}`;
    const sportRows = await tx<{ sport_key: string }[]>`
      select distinct sport_key from divisions
       where org_id = ${orgId} and (${competitionId}::uuid is null or competition_id = ${competitionId})
       order by sport_key`;
    const sports: SportPreviewSource[] = [];
    for (const { sport_key: sportKey } of sportRows) {
      const kinds = kindsOf(sportKey);
      sports.push({
        sportKey,
        kinds,
        sample: kinds === null ? null : await latestFinishedBreaks(tx, orgId, sportKey, competitionId),
      });
    }
    return { settings, ownRow: (own?.n ?? 0) > 0, sports };
  });
}
