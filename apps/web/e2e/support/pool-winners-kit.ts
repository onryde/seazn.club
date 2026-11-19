// W5 T14b (owner 2026-11-18) - seed a FINISHED multi-pool Groups only division through the real API, for the desktop spec and the
// width-project spec both. Every line is a walkover for the better seed, so a pool's winner is its lowest seed, derived here from the
// lines' own pool ids and never from the product's table.
import { expect, type APIRequestContext } from "@playwright/test";
import { TAG, apiJson } from "../helpers";
import { activeOrgSlug, division, publicCompetition } from "../spectator-w2-kit";

export interface FinishedGroupsOnly {
  orgSlug: string;
  compSlug: string;
  divSlug: string;
  divisionId: string;
  /** Each pool's winner (its lowest seed), in seed order, with the name the public pages show. */
  winners: { entrantId: string; name: string }[];
  names: string[];
}

export const LONG_NAME_SUFFIX = "Featherstonehaugh-Montgomery Wanderers Reserve";

export async function seedFinishedGroupsOnly(
  request: APIRequestContext,
  opts: { label: string; pools: number; perPool: number; decide?: boolean; longNames?: boolean },
): Promise<FinishedGroupsOnly> {
  const org = await activeOrgSlug(request);
  const comp = await publicCompetition(request, { name: `${opts.label} ${TAG}`, orgId: org.id });
  const div = await division(request, comp.id, {
    name: "Groups",
    sport_key: "generic",
    variant_key: "score",
    config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const n = opts.pools * opts.perPool;
  const names = Array.from({ length: n }, (_, i) => `${opts.longNames && i < 2 ? `${LONG_NAME_SUFFIX} ` : ""}PW${i + 1} ${TAG}`);
  const added = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${div.id}/entrants`, "POST",
    names.map((display_name, i) => ({ kind: "individual", display_name, seed: i + 1 })));
  expect(added.status, JSON.stringify(added.error)).toBe(201);
  const ids = added.data!.map((e) => e.id);
  const seedOf = new Map(ids.map((id, i) => [id, i + 1]));
  const stages = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${div.id}/stages`, "PUT", [
    { seq: 1, kind: "group", name: "Group stage", config: { legs: 1, pools: { count: opts.pools } }, progression: null },
  ]);
  expect(stages.status, JSON.stringify(stages.error)).toBe(200);
  const stageId = stages.data![0]!.id;
  expect((await apiJson(request, `/api/v1/stages/${stageId}/generate`, "POST")).status).toBe(200);
  expect((await apiJson(request, `/api/v1/divisions/${div.id}/start`, "POST")).status).toBe(200);
  const fx = await apiJson<{ id: string; stage_id: string; pool_id: string | null; home_entrant_id: string; away_entrant_id: string }[]>(request, `/api/v1/divisions/${div.id}/fixtures`);
  const lines = (fx.data ?? []).filter((f) => f.stage_id === stageId);
  expect(lines.length, "every pool's round robin was drawn").toBe(opts.pools * ((opts.perPool * (opts.perPool - 1)) / 2));
  const best = new Map<string, number>();
  for (const f of lines) for (const id of [f.home_entrant_id, f.away_entrant_id]) best.set(f.pool_id ?? "", Math.min(best.get(f.pool_id ?? "") ?? Infinity, seedOf.get(id)!));
  const toPlay = opts.decide === false ? lines.slice(0, Math.max(0, lines.length - 1)) : lines;
  for (const f of toPlay) {
    const loser = seedOf.get(f.home_entrant_id)! < seedOf.get(f.away_entrant_id)! ? f.away_entrant_id : f.home_entrant_id;
    const r = await apiJson(request, `/api/v1/fixtures/${f.id}/events`, "POST", { expected_seq: 0, type: "core.forfeit", payload: { by: loser, reason: "walkover" } });
    expect(r.status, JSON.stringify(r.error)).toBe(201);
  }
  // the lowest seed of each pool - which pool is A is the product's draw, so the winners are a SET, read in seed order
  const winners = [...best.values()]
    .sort((x, y) => x - y)
    .map((seed) => ({ entrantId: ids[seed - 1]!, name: names[seed - 1]! }));
  expect(winners.length, "one winner per pool").toBe(opts.pools);
  return { orgSlug: org.slug, compSlug: comp.slug, divSlug: div.slug, divisionId: div.id, winners, names };
}
