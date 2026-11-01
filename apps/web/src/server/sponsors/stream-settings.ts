import "server-only";
// server/sponsors/stream-settings.ts — R4 sponsors on stream, S5: the rotation's dial (spec 2026-10-27 §3.2, §4), read
// on every overlay poll and written by the On stream tab (S12's PUT route). One row per scope in
// sponsor_stream_settings (V483): the org row (competition_id null) and any competition rows. A competition's own row
// OVERRIDES the org row — whole, `enabled` included, so a competition can be switched off under an org that is on.
import type postgres from "postgres";
import type { Tx } from "@/lib/db";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { SPONSOR_FREQUENCIES, type SponsorFrequency } from "@/lib/sponsor-frequencies";

/** V483's `sponsor_stream_settings_frequency_check`, in the planner's vocabulary: declared once in the dependency-free
 *  `lib/sponsor-frequencies.ts` (R4 S12 moved it there so the tab's dial and the PUT's zod enum can read it), re-exported
 *  for its importers. */
export { SPONSOR_FREQUENCIES };

export interface StreamSettings {
  enabled: boolean;
  frequency: SponsorFrequency;
}

type Exec = Tx | typeof sql;

/**
 * THE one statement that picks the settings row in force: the competition's row, else the org's. `org` and
 * `competition` are values, or column fragments (`exec\`f.org_id\``) when it runs as a lateral subquery — the overlay's
 * per-poll context read (`sponsorContextOf`, assign.ts) folds it into its fixture read, and must not restate the rule.
 * Returned un-awaited: a fragment to interpolate, or a query to await.
 */
export function streamSettingsQuery(
  exec: Exec,
  org: string | postgres.Fragment,
  competition: string | null | postgres.Fragment,
) {
  return exec<{ enabled: boolean; frequency: SponsorFrequency }[]>`
    select enabled, frequency from sponsor_stream_settings
     where org_id = ${org}
       and (competition_id is null or competition_id = ${competition})
     order by competition_id nulls last
     limit 1`;
}

/**
 * The settings in force for a fixture of `competitionId` (null: a fixture outside any competition, or the org-wide
 * question): the competition's row, else the org's row, else none (null — the rotation is off and the overlay answer
 * carries no plan). One indexed read on the scope key.
 */
export async function resolveStreamSettings(
  exec: Exec,
  orgId: string,
  competitionId: string | null,
): Promise<StreamSettings | null> {
  const [row] = await streamSettingsQuery(exec, orgId, competitionId);
  return row === undefined ? null : { enabled: row.enabled, frequency: row.frequency };
}

/**
 * Writes one scope's settings (S12's PUT). Upserts on the scope key (`unique nulls not distinct`), so a second save of
 * the same scope updates its row and never adds one. The route owns the role check (editor only, ruling R19); this owns
 * the org: the caller's org must be the path's, and a competition must be that org's. The database checks neither
 * (V483 has no composite foreign keys).
 */
export async function putStreamSettings(
  auth: AuthCtx,
  orgId: string,
  b: { competitionId: string | null; enabled: boolean; frequency: SponsorFrequency },
): Promise<void> {
  if (auth.orgId !== orgId) throw new HttpError(404, "organization not found");
  if (!(SPONSOR_FREQUENCIES as readonly string[]).includes(b.frequency)) {
    throw new HttpError(400, `frequency must be one of ${SPONSOR_FREQUENCIES.join(", ")}`);
  }
  await withTenant(orgId, async (tx) => {
    if (b.competitionId !== null) {
      const [comp] = await tx`select 1 from competitions where id = ${b.competitionId} and org_id = ${orgId}`;
      if (!comp) throw new HttpError(404, "competition not found");
    }
    await tx`
      insert into sponsor_stream_settings (org_id, competition_id, enabled, frequency, updated_by, updated_at)
      values (${orgId}, ${b.competitionId}, ${b.enabled}, ${b.frequency}, ${auth.userId}, now())
      on conflict on constraint sponsor_stream_settings_scope_key
      do update set enabled = excluded.enabled, frequency = excluded.frequency,
                    updated_by = excluded.updated_by, updated_at = excluded.updated_at`;
  });
}

/**
 * Ruling R12 / spec D12 (S12): the first sponsor ticked onto the stream turns the organisation's rotation on. Inserts the org
 * row (`competition_id` null) ENABLED at Normal when the org has none, and does nothing when it has - a tick never overwrites a
 * row the organiser has set (a switched-off or Busy org stays so), and a competition's row alone does not count as the org's.
 * `on conflict do nothing` on the scope key is the arbiter: two first ticks racing leave one row.
 *
 * Runs in the TICK's transaction (`patchSponsor`), so a tick that is refused (another org's sponsor, a failed update) leaves no
 * row behind. The caller owns "this was a tick to ON"; unticking, renaming and ticking nothing never come here.
 */
export async function ensureOrgStreamSettings(tx: Tx, orgId: string, userId: string | null): Promise<void> {
  await tx`
    insert into sponsor_stream_settings (org_id, competition_id, enabled, frequency, updated_by)
    values (${orgId}, ${null}, true, ${"normal" satisfies SponsorFrequency}, ${userId})
    on conflict on constraint sponsor_stream_settings_scope_key do nothing`;
}
