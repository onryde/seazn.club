// F1 follow-up (2026-08-17, payload-budget regression — PR #606 CI,
// board-v3.spec.ts:228 "gap 15" reds: expect flightBytes-dictBytes <
// 250000, got 279043/279419 across a retry). FIXTURE_COLS (stages.ts)
// grew five columns for the bracket round-role work — ext_key, lane,
// is_final, third_place, conditional — and listDivisionFixtures, shared by
// the schedule board pages AND the division page's bracket/stages panel,
// started shipping all five to a board that renders none of them: ~88
// escaped bytes/fixture on the RSC flight, invisible on one division,
// ~29KB over budget at a 5-division x 66-fixture board.
//
// listDivisionFixturesForBoard (fixtures.ts) is the board-only projection
// that drops them via BOARD_FIXTURE_COLS (stages.ts); listDivisionFixtures
// keeps the full set for the bracket panel, which genuinely reads all
// four round-role fields (stages-panel.tsx, bracket-panel.tsx). ext_key is
// excluded from the board on independent grounds too: board/settings-
// panel.tsx already documented (pre-F1) "the page's fetched fixture list
// never carries ext_key" as a design invariant for its capacity precheck —
// F1's SELECT widening silently broke that invariant as a side effect.
//
// This test proves both halves with a real row: the full read still
// carries all five fields (so the bracket panel keeps working) and the
// board read carries NONE of them (the bytes are actually gone, not just
// unused by the component tree).
//
// Real Postgres required; skipped without DATABASE_URL (same convention as
// the sibling *-precondition test files in this directory).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { listDivisionFixtures, listDivisionFixturesForBoard } from "../fixtures";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

const ROUND_ROLE_COLS = ["ext_key", "lane", "is_final", "third_place", "conditional"] as const;

/** A league division with one generated fixture, hand-updated to carry
 *  every round-role/ext_key value a real bracket fixture would (a league
 *  fixture never sets these itself, but the SELECT list doesn't care what
 *  generated them — this proves the projection, not the generator). */
async function seedFixtureWithRoundRole(): Promise<{
  auth: AuthCtx;
  divisionId: string;
  fixtureId: string;
}> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"BoardCols " + suffix}, ${"boardcols-" + suffix})
    returning id`;
  await setOrgPlan(orgId);
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };

  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Board Cols Cup " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await createEntrants(auth, division.id, [
    { kind: "individual", display_name: "A", seed: 1, members: [] },
    { kind: "individual", display_name: "B", seed: 2, members: [] },
  ]);
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "L",
    config: {},
    progression: null,
  });
  await generateStageFixtures(auth, stage!.id);
  const [{ id: fixtureId }] = await sql<{ id: string }[]>`
    select id from fixtures where stage_id = ${stage!.id} limit 1`;
  await sql`
    update fixtures
    set ext_key = 'test-ext-key', lane = 'WB', is_final = true, third_place = true, conditional = true
    where id = ${fixtureId}`;
  return { auth, divisionId: division.id, fixtureId };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("F1 follow-up — board fixture read drops the five round-role/ext_key columns", () => {
  it("listDivisionFixtures (bracket/stages panel) still carries all five columns", async () => {
    const { auth, divisionId, fixtureId } = await seedFixtureWithRoundRole();
    const rows = await listDivisionFixtures(auth, divisionId);
    const row = rows.find((f) => f.id === fixtureId);
    expect(row).toBeDefined();
    expect(row!.ext_key).toBe("test-ext-key");
    expect(row!.lane).toBe("WB");
    expect(row!.is_final).toBe(true);
    expect(row!.third_place).toBe(true);
    expect(row!.conditional).toBe(true);
  });

  it("listDivisionFixturesForBoard (schedule board) omits all five columns, not just leaves them unused", async () => {
    const { auth, divisionId, fixtureId } = await seedFixtureWithRoundRole();
    const rows = await listDivisionFixturesForBoard(auth, divisionId);
    const row = rows.find((f) => f.id === fixtureId);
    expect(row).toBeDefined();
    // Not `.toBeFalsy()` — the columns must be ABSENT from the row (never
    // selected), not merely null/false, or the RSC flight still pays for
    // the key name and a JSON `null`/`false` value per fixture.
    for (const col of ROUND_ROLE_COLS) {
      expect(Object.prototype.hasOwnProperty.call(row, col), `row should not have "${col}"`).toBe(false);
    }
    // Everything the board actually renders is still there.
    expect(row!.home_entrant_id).toBeDefined();
    expect(row!.status).toBeDefined();
    expect(row!.round_no).toBeDefined();
  });
});
