// W5 app PR A, Task 3: the real-producer rig the Add match and single-pool tests share — a division of seeded entrants and ONE root
// league or group stage, made through the usecases a organiser's request reaches (`createCompetition` → `createDivision` →
// `createEntrants` → `createStages` → `generateStageFixtures`), never a hand-written row. The same shape Task 2's test builds
// inline (roundrobin-reconcile.test.ts), here so two files can read it.
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { entrantKindCap } from "@seazn/engine/sport";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { seedOrg } from "./_seed";

export interface SportPick {
  key: string;
  variant: string;
  kind: "individual" | "pair" | "team";
}
export const BADMINTON: SportPick = { key: "badminton", variant: "bwf", kind: "individual" };
/** The second sport, from the engine's own declarations: its default entrant kind and first variant. */
export const FOOTBALL: SportPick = (() => {
  const m = builtinModules.find((x) => x.key === "football");
  const variant = m === undefined ? undefined : Object.keys(m.variants)[0];
  if (m === undefined || variant === undefined) throw new Error("the engine declares no football module");
  return { key: m.key, variant, kind: (m.entrantModel?.defaultKind ?? "team") as SportPick["kind"] };
})();

function entrantInput(kind: SportPick["kind"], name: string, seed: number | null) {
  const seats = Math.min(2, entrantKindCap(kind));
  return {
    kind,
    display_name: name,
    seed,
    members: Array.from({ length: seats }, (_, i) => ({
      new_person: { full_name: `${name} m${i + 1} ${randomUUID().slice(0, 4)}` },
      is_captain: false,
      roles: [],
    })),
  };
}

export interface Rig {
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  sport: SportPick;
  /** Entrant ids in creation order (`P1`, `P2`, ...). */
  ids: string[];
}

/** A division of `n` seeded entrants (seed = position) and one root league or group stage, generated unless told not to. */
export async function rig(opts: { n: number; kind?: "league" | "group"; pools?: number; legs?: number; sport?: SportPick; generate?: boolean }): Promise<Rig> {
  const sport = opts.sport ?? BADMINTON;
  const legs = opts.legs ?? 1;
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 T3 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: sport.key,
    variant_key: sport.variant,
    config: {},
  });
  const made = await createEntrants(
    auth,
    division.id,
    Array.from({ length: opts.n }, (_, i) => entrantInput(sport.kind, `P${i + 1}`, i + 1)),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: opts.kind ?? "league",
    name: "Table",
    config: { ...(legs > 1 ? { legs } : {}), ...(opts.pools ? { pools: { count: opts.pools } } : {}) },
    progression: null,
  });
  if (opts.generate !== false) await generateStageFixtures(auth, stage!.id);
  return { auth, divisionId: division.id, stageId: stage!.id, sport, ids: made.map((e) => e.id) };
}

export interface Row {
  id: string;
  ext_key: string | null;
  pool_id: string | null;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
}

export async function rowsOf(stageId: string): Promise<Row[]> {
  return sql<Row[]>`
    select id, ext_key, pool_id, round_no, seq_in_round, home_entrant_id, away_entrant_id, status
    from fixtures where stage_id = ${stageId}
    order by pool_id nulls first, round_no, seq_in_round`;
}

/** The stored line between two entrants (either side home), or a failure: a premise, never a silent undefined. */
export function lineBetween(rows: readonly Row[], a: string, b: string): Row {
  const hit = rows.filter((r) => (r.home_entrant_id === a && r.away_entrant_id === b) || (r.home_entrant_id === b && r.away_entrant_id === a));
  if (hit.length !== 1) throw new Error(`premise: expected one line between ${a} and ${b}, found ${hit.length}`);
  return hit[0]!;
}

/** The error a promise rejects with, or a failure when it resolves. */
export async function refusal(p: Promise<unknown>): Promise<HttpError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof HttpError)) throw new Error(`expected an HttpError refusal, got ${String(err)}`);
  return err;
}
