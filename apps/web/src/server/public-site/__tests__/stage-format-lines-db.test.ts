// Per-stage match rules, T7 (design 2026-09-17 §D3) — the DB half.
//
// `competition-hub.test.ts` doubles `getPublicDivision` and proves the
// document ASSEMBLY; only a real database proves what that double stands in
// for: that the division read actually SELECTS each stage's `rules` (the view
// does not expose `stages.config`, so it is a subselect by the view row's id),
// and that the rules fragment an organiser stored through the endpoint's own
// usecase becomes a hub line — and only for the stage that plays a different
// format. Same scene as the fixture-label regression beside it.
//
// unstable_cache is a Next server-runtime API — passthrough under vitest.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { CompetitionHubDoc } from "../competition-hub-schema";
import { loadCompetitionHub } from "../competition-hub";
import { getPublicDivision } from "../data";
import { SWISS_RULES, seedStageRulesScene } from "./_stage-rules-scene";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("stage rules reach the hub and the division page through getPublicDivision", () => {
  it("the division read carries each stage's stored rules FRAGMENT — and nothing for a stage without", async () => {
    const s = await seedStageRulesScene();
    const data = await getPublicDivision(s.orgSlug, s.compSlug, s.divSlug);
    expect(data, "the seeded division must be public").not.toBeNull();
    const byId = new Map(data!.stages.map((st) => [st.id, st]));
    // Exactly what was stored — a fragment, never a materialised config.
    expect(byId.get(s.swissStageId)?.rules).toEqual(SWISS_RULES);
    expect(byId.get(s.leagueStageId)?.rules ?? null).toBeNull();
    // Only `rules` — the rest of config (progression, cross-feeds) stays off
    // the public read, as the view intends.
    expect(Object.keys(byId.get(s.swissStageId)!)).not.toContain("config");
  }, 60_000);

  it("the hub names the Swiss stage's effective rules and says nothing of the League beside it", async () => {
    const s = await seedStageRulesScene();
    const doc = await loadCompetitionHub(s.orgSlug, s.compSlug);
    expect(doc, "the seeded competition must be public").not.toBeNull();
    expect(CompetitionHubDoc.safeParse(doc).success).toBe(true);
    const division = doc!.divisions.find((d) => d.slug === s.divSlug);
    // The right answer's numbers are the stage's (15/21), not the division's.
    expect(s.divisionConfig.setTo).not.toBe(SWISS_RULES.setTo);
    expect(division?.stageFormatLines).toEqual([
      {
        stageName: "Swiss",
        line: { key: "format.rules.oneGamePointsCap", params: { points: SWISS_RULES.setTo, cap: SWISS_RULES.cap } },
      },
    ]);
  }, 60_000);
});
