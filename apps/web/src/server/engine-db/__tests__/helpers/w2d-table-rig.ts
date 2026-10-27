// W2d Task 9 — the shared DB rig of the table-rules tests (`table-rules-pin.test.ts`, `stage-lots.test.ts`): a division
// seeded through the product's own writers, its stages created and NOT generated (a pending stage is half of what these
// tests compare), and a result written through `scoreEvent` the way the console writes it. Real Postgres; callers skip
// without DATABASE_URL.
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateStages } from "@/server/api-v1/schemas";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages } from "@/server/usecases/stages";
import { GENERIC_CONFIG, seedOrg } from "@/server/usecases/__tests__/_seed";
import { post } from "./w2b-rig";

export interface TableScene {
  auth: AuthCtx;
  divisionId: string;
  stageIds: string[];
  /** Entrant ids in seed order (E1 first). */
  entrants: string[];
}

/** An org, a division of `sport`/`variant` (the variant's declared cfg unless `config` is given), `entrants` entrants and
 *  the given stages — created, not generated. */
export async function tableScene(opts: {
  sport?: string;
  variant?: string;
  config?: Record<string, unknown>;
  entrants?: number;
  stages?: CreateStages;
}): Promise<TableScene> {
  const sport = opts.sport ?? "generic";
  const variant = opts.variant ?? "score";
  const module_ = builtinModules.find((m) => m.key === sport);
  if (module_ === undefined) throw new Error(`rig: no sport ${sport}`);
  const { auth } = await seedOrg("pro");
  const suffix = randomUUID().slice(0, 8);
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Tables " + suffix, visibility: "private", branding: {} });
  const config = opts.config ?? (sport === "generic" ? GENERIC_CONFIG : (module_.variants[variant] as Record<string, unknown>));
  const division = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + suffix, sport_key: sport, variant_key: variant, config });
  const kind = module_.entrantModel?.defaultKind ?? "individual";
  const created = await createEntrants(
    auth,
    division.id,
    Array.from({ length: opts.entrants ?? 4 }, (_, i) => ({ kind, display_name: `E${i + 1}`, seed: i + 1, members: [] })),
  );
  const stages = await createStages(auth, division.id, opts.stages ?? { seq: 1, kind: "league", name: "League", config: {} });
  return {
    auth,
    divisionId: division.id,
    stageIds: stages.map((s) => s.id),
    entrants: [...created].sort((a, b) => (a.seed ?? 0) - (b.seed ?? 0)).map((e) => e.id),
  };
}

export interface SeatedFixture {
  id: string;
  home: string;
  away: string;
  status: string;
}

export const seatedFixtures = (stageId: string) =>
  sql<SeatedFixture[]>`
    select id, home_entrant_id as home, away_entrant_id as away, status
      from fixtures where stage_id = ${stageId} and home_entrant_id is not null and away_entrant_id is not null
     order by round_no, seq_in_round`;

/** The fixture between two entrants (either seating). */
export async function between(stageId: string, x: string, y: string): Promise<SeatedFixture> {
  const f = (await seatedFixtures(stageId)).find((r) => (r.home === x && r.away === y) || (r.home === y && r.away === x));
  if (f === undefined) throw new Error(`rig: no fixture between ${x} and ${y} in ${stageId}`);
  return f;
}

/** A generic score result, `xScore` to `x` and `yScore` to `y` whichever way the fixture is seated. */
export async function genericResult(auth: AuthCtx, stageId: string, x: string, y: string, xScore: number, yScore: number): Promise<void> {
  const f = await between(stageId, x, y);
  const [p1Score, p2Score] = f.home === x ? [xScore, yScore] : [yScore, xScore];
  await post(auth, f.id, "core.start");
  await post(auth, f.id, "generic.result", { p1Score, p2Score });
  const [row] = await sql<{ status: string }[]>`select status from fixtures where id = ${f.id}`;
  if (row?.status !== "decided") throw new Error(`rig: ${x} v ${y} did not decide (${row?.status})`);
}

export interface StageRulesRow {
  status: string;
  pin: unknown;
  pinned_at: string | null;
}

export async function stageRules(stageId: string): Promise<StageRulesRow> {
  const [r] = await sql<StageRulesRow[]>`
    select status, table_rules_pinned as pin, to_json(table_rules_pinned_at) #>> '{}' as pinned_at from stages where id = ${stageId}`;
  if (!r) throw new Error(`rig: no stage ${stageId}`);
  return r;
}

/** The stage's rows `tableRulesOf` reads, as `loadTableRules` reads them. */
export async function tableRulesRowOf(stageId: string) {
  const [r] = await sql<
    {
      kind: string;
      status: string;
      config: Record<string, unknown> | null;
      pin: unknown;
      pinned_at: string | null;
      division_config: unknown;
      division_tiebreakers: string[] | null;
    }[]
  >`
    select s.kind, s.status, s.config, s.table_rules_pinned as pin, to_json(s.table_rules_pinned_at) #>> '{}' as pinned_at,
           d.config as division_config, d.tiebreakers as division_tiebreakers
      from stages s join divisions d on d.id = s.division_id where s.id = ${stageId}`;
  if (!r) throw new Error(`rig: no stage ${stageId}`);
  return {
    stageId,
    kind: r.kind,
    status: r.status,
    stageConfig: r.config,
    pin: r.pin,
    pinnedAt: r.pinned_at,
    divisionConfig: r.division_config,
    divisionTiebreakers: r.division_tiebreakers,
  };
}

/** Un-pin a stage as if it had never started (status pending, no pin): the counterfactual every "does not reach it" case
 *  is measured against. */
export async function unpin(stageId: string): Promise<void> {
  const n = await sql`update stages set status = 'pending', table_rules_pinned = null, table_rules_pinned_at = null where id = ${stageId}`;
  if (n.count !== 1) throw new Error("rig: the stage was not un-pinned");
  await sql`delete from standings_snapshots where stage_id = ${stageId}`;
}
