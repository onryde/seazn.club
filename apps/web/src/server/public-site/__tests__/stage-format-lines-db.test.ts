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

import { PointsRule } from "@seazn/engine/competition";
import { stageDefaultsFor } from "@seazn/engine/sport";
import { sql } from "@/lib/db";
import { resolveLatestModule } from "@/server/engine-db";
import { CompetitionHubDoc } from "../competition-hub-schema";
import { loadCompetitionHub } from "../competition-hub";
import { getPublicDivision } from "../data";
import { SWISS_RULES, dropScene, sceneRowCounts, sceneSubscriptionId, seedDecidersScene, seedStageRulesScene } from "./_stage-rules-scene";

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
        line: [{ key: "format.rules.oneGamePointsCap", params: { points: SWISS_RULES.setTo, cap: SWISS_RULES.cap } }],
      },
    ]);
  }, 60_000);
});

// W2c Task 16 - the same DB half for the two things the line gained: how a tied match ENDS (needs each stage's KIND
// from the division read) and a stage's OWN points (needs `points_rule` from the view). A double of `getPublicDivision`
// cannot say the real SELECT carries either.
describe.skipIf(!HAS_DB)("a stage's deciders and own points reach the hub and the division page (W2c Task 16)", () => {
  it("hockey: the division read carries each stage's KIND, and the hub's line for the Cup is its period line and shoot-out (the Pool, playing the division's format, has none)", async () => {
    const m = resolveLatestModule("hockey");
    const cfg = m.configSchema.parse(m.variants["fih-outdoor"]) as { periods: { minutes: number } };
    const preset = stageDefaultsFor(m, "knockout", "fih-outdoor") as { shootout: { attempts: number } };
    const s = await seedDecidersScene({ sportKey: "hockey", variantKey: "fih-outdoor" });
    const data = await getPublicDivision(s.orgSlug, s.compSlug, s.divSlug);
    expect(data, "the seeded division must be public").not.toBeNull();
    const kinds = new Map(data!.stages.map((st) => [st.id, st.kind]));
    expect(kinds.get(s.leagueStageId)).toBe("league");
    expect(kinds.get(s.cupStageId)).toBe("knockout");

    const doc = await loadCompetitionHub(s.orgSlug, s.compSlug);
    expect(CompetitionHubDoc.safeParse(doc).success).toBe(true);
    expect(doc!.divisions.find((d) => d.slug === s.divSlug)?.stageFormatLines).toEqual([
      {
        stageName: "Cup",
        line: [
          { key: "format.rules.period.quarters", params: { minutes: cfg.periods.minutes } },
          { key: "format.rules.decider.shootout", params: { n: preset.shootout.attempts } },
        ],
      },
    ]);
  }, 90_000);

  it("W2d PF-3: a started stage PINNED to its table rules, with no points of its own, still prints no points line — the pin reaches the table's rule (the loader's `table_rules`), never the stage's own (points_rule)", async () => {
    // The migration pins every started stage (V474 B1); a stage that plays the division's format must still read exactly
    // as before (division page, hub, embed: "a stage that plays the division's format gets nothing"). The pin is written
    // as the migration writes one; its points are a rule today's reader takes.
    const m = resolveLatestModule("hockey");
    const cfg = m.configSchema.parse(m.variants["fih-outdoor"]) as { periods: { minutes: number } };
    const preset = stageDefaultsFor(m, "knockout", "fih-outdoor") as { shootout: { attempts: number } };
    const s = await seedDecidersScene({ sportKey: "hockey", variantKey: "fih-outdoor" });
    // The scene is COMMITTED (the readers below use the module's own connection), so it is deleted afterwards — every row
    // of it, counted while it stands and after it is gone: no started, pinned stage is left for a later global sweep.
    const subscriptionId = await sceneSubscriptionId(s.auth);
    let standing: Record<string, number> = {};
    try {
      const pinPoints = {
        win: { regulation: 3, so: 2 }, loss: { regulation: 0, so: 1 }, draw: 1, tie: 1, noResult: 1,
        shootoutAs: "result", unit: "whole", bonuses: [],
      };
      const pin = {
        points: pinPoints,
        tiebreakers: ["points", "wins", "diff", "for", "h2h_points"],
        crossGroup: ["points", "diff", "for", "wins"],
        sources: { points: "migrated", tiebreakers: "migrated", crossGroup: "migrated" },
      };
      await sql`update stages set status = 'active', table_rules_pinned = ${sql.json(pin)}, table_rules_pinned_at = now()
                where id = ${s.leagueStageId}`;

      const [row] = await sql<Record<string, unknown>[]>`select * from public_stages_v where id = ${s.leagueStageId}`;
      expect(row, "the Pool is on the public view").toBeDefined();
      expect(row!.points_rule, "the stage's own rule: none").toBeNull();
      expect(Object.hasOwn(row!, "table_points_rule"), "the view publishes no table rule (T9 review m3)").toBe(false);

      const data = await getPublicDivision(s.orgSlug, s.compSlug, s.divSlug);
      const pool = data!.stages.find((st) => st.id === s.leagueStageId);
      expect(pool?.points_rule ?? null).toBeNull();
      expect(pool?.table_rules?.points, "the rule its table is paid by: the pin's, from the loader").toEqual(PointsRule.parse(pinPoints));

      const doc = await loadCompetitionHub(s.orgSlug, s.compSlug);
      expect(CompetitionHubDoc.safeParse(doc).success).toBe(true);
      expect(doc!.divisions.find((d) => d.slug === s.divSlug)?.stageFormatLines).toEqual([
        {
          stageName: "Cup",
          line: [
            { key: "format.rules.period.quarters", params: { minutes: cfg.periods.minutes } },
            { key: "format.rules.decider.shootout", params: { n: preset.shootout.attempts } },
          ],
        },
      ]);
      standing = await sceneRowCounts(s.auth, subscriptionId);
    } finally {
      await dropScene(s.auth);
    }
    expect(standing, "premise: the scene stood (its org, competition, division, two stages, fixtures, entrants, group, owner)").toMatchObject({
      organizations: 1, competitions: 1, divisions: 1, stages: 2, subscriptions: 1, users: 1,
    });
    expect(standing.fixtures).toBeGreaterThan(0);
    expect(standing.entrants).toBe(4);
    expect(await sceneRowCounts(s.auth, subscriptionId), "nothing of the scene is left behind").toEqual({
      organizations: 0, competitions: 0, divisions: 0, stages: 0, fixtures: 0, entrants: 0, subscriptions: 0, users: 0,
    });
  }, 90_000);

  it("football: a stage with its own points says them (view's points_rule), ahead of the Cup in stage order, and the Cup says its extra time and penalties", async () => {
    const m = resolveLatestModule("football");
    const cfg = m.configSchema.parse(m.variants["11-a-side"]) as { halfMinutes: number; points: { win: number } };
    const preset = stageDefaultsFor(m, "knockout", "11-a-side") as { extraTime: { halfMinutes: number }; shootoutAttempts: number };
    // 4/2 points and a stored 5-0 award: the points are the stage's own, not the division's win of 3; the award score is
    // the stage's too (X-WO-1 B, Task 16b: the headline reads it, so the line says it) - the clauses below are the whole
    // sentence.
    const points = { win: { regulation: 4 }, draw: 2, loss: { regulation: 0 }, shootoutAs: "result" as const, unit: "whole" as const, bonuses: [], forfeit: { winnerPoints: 1, loserPoints: 0, awardScore: [5, 0] as [number, number] } };
    expect(cfg.points.win, "premise: the division's win is not the stage's").not.toBe(points.win.regulation);
    const s = await seedDecidersScene({ sportKey: "football", variantKey: "11-a-side", leaguePoints: points });
    const doc = await loadCompetitionHub(s.orgSlug, s.compSlug);
    expect(doc!.divisions.find((d) => d.slug === s.divSlug)?.stageFormatLines).toEqual([
      {
        stageName: "Pool",
        line: [
          { key: "format.points.base", params: { win: 4, draw: 2, loss: 0 } },
          { key: "format.points.forfeit", params: { winner: 1, loser: 0 } },
          { key: "format.points.forfeitScore", params: { winner: 5, loser: 0 } },
        ],
      },
      {
        stageName: "Cup",
        line: [
          { key: "format.rules.period.halves", params: { minutes: cfg.halfMinutes } },
          { key: "format.rules.decider.extraTime", params: { n: preset.extraTime.halfMinutes } },
          { key: "format.rules.decider.penalties", params: { n: preset.shootoutAttempts } },
        ],
      },
    ]);
  }, 90_000);
});
