import "server-only";
import { withTenant, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { type DivisionRow, type VariantOption, COLS } from "./types";

/** Variant choices for the Settings tab's format editor (v8) — system
 *  presets plus this org's own, deduped per key (org's wins). */
export async function listVariantOptions(
  auth: AuthCtx,
  sportKey: string,
): Promise<VariantOption[]> {
  return withTenant(auth.orgId, (tx) =>
    tx<VariantOption[]>`
      select distinct on (key) key, name, (org_id is null) as system, config from sport_variants
      where sport_key = ${sportKey}
      order by key, org_id nulls last`,
  );
}

export async function listDivisions(
  auth: AuthCtx,
  competitionId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<DivisionRow[]> {
  return withTenant(auth.orgId, async (tx) => {
    const [comp] = await tx`select 1 from competitions where id = ${competitionId}`;
    if (!comp) throw new HttpError(404, "competition not found");
    // Archived divisions are hidden from the console (v3/09 §4) — only the
    // competition-settings "Archived divisions" list asks for them.
    return tx<DivisionRow[]>`
      select ${tx(COLS)} from divisions
      where competition_id = ${competitionId}
      ${opts.includeArchived ? tx`` : tx`and archived_at is null`}
      order by created_at, id`;
  });
}

export async function getDivision(auth: AuthCtx, id: string): Promise<DivisionRow> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<DivisionRow[]>`select ${tx(COLS)} from divisions where id = ${id}`;
    if (!row) throw new HttpError(404, "division not found");
    return row;
  });
}

/** The sports this organisation has run divisions in, most recent first (C9 R2: the builder's Sport picker leads with
 *  them, and opens on the first). Archived divisions count - they were run. Divisions written in one transaction share
 *  `now()`, so ties break on the sport key (C9 review 3, m1): the order, and with it the builder's default sport, never
 *  flips between loads. Run inside the caller's tenant transaction. */
export async function recentDivisionSports(tx: Tx, orgId: string): Promise<string[]> {
  const rows = await tx<{ sport_key: string }[]>`
    select sport_key from divisions where org_id = ${orgId}
    group by sport_key order by max(created_at) desc, sport_key`;
  return rows.map((r) => r.sport_key);
}
