// W5 app PR A, B4 fix wave (m3): a rank override re-ranks the stored table, so it clears the public division and competition tags a
// result write clears (`fireDivisionRevalidate`) - before, a pin on a COMPLETED Groups only stage left the pool-winners banner and the
// table stale for up to the cache's 30 s. differential: today (c959c9d428) `overrideStandings` fires no public revalidation at all.
//
// Both an open stage and a completed one (the case the review drove). Single-sport (badminton): the write is sport-blind, and the
// per-pool checks are swept over two sports in rank-override-pool.test.ts.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const fired = vi.hoisted(() => [] as { divisionId: string; competitionId: string | undefined }[]);
vi.mock("@/server/public-site/revalidate", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/public-site/revalidate")>();
  return {
    ...real,
    fireDivisionRevalidate: (divisionId: string, competitionId?: string) => {
      fired.push({ divisionId, competitionId });
      real.fireDivisionRevalidate(divisionId, competitionId);
    },
  };
});

import { sql } from "@/lib/db";
import { post } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { completeStage, createStages, overrideStandings } from "../stages";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.runIf(HAS_DB)("m3: a rank override clears the public division's tags", () => {
  for (const finished of [false, true]) {
    it(`${finished ? "a completed" : "an open"} league: the pin fires the division + competition revalidation once the table is recomputed`, async () => {
      const { auth } = await seedOrg("pro");
      const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "B4 m3 " + randomUUID().slice(0, 6), visibility: "public", branding: {} });
      const d = await createDivision(auth, comp.id, { name: "Open", slug: "o-" + randomUUID().slice(0, 6), sport_key: "badminton", variant_key: "bwf", config: {} });
      const es = await createEntrants(auth, d.id, Array.from({ length: 4 }, (_, i) => ({ kind: "individual" as const, display_name: `P${i + 1}`, seed: i + 1, members: [] })));
      const [stage] = await createStages(auth, d.id, { seq: 1, kind: "league", name: "League", config: { legs: 1 }, progression: null });
      await startDivision(auth, d.id);
      if (finished) {
        const lines = await sql<{ id: string; away_entrant_id: string }[]>`select id, away_entrant_id from fixtures where stage_id = ${stage!.id}`;
        for (const l of lines) await post(auth, l.id, "core.forfeit", { by: l.away_entrant_id, reason: "walkover" });
        await completeStage(auth, stage!.id, { publish: false });
      }
      fired.length = 0;
      await overrideStandings(auth, stage!.id, { rows: [{ entrant_id: es[3]!.id, rank: 1, reason: "placement game" }] });
      expect(fired.filter((f) => f.divisionId === d.id), "the division's public tags, with its competition").toContainEqual({ divisionId: d.id, competitionId: comp.id });
    }, 120_000);
  }
});
