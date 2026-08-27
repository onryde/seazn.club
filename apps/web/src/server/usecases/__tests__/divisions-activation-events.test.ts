// DIVISION_CREATED call-count pin for the MANUAL create path
// (divisions.ts) — same P4 review follow-up gap as
// competitions-activation-events.test.ts (see that file's header), for
// createDivision's fireDivisionCreated extraction. Real Postgres required.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";

vi.mock("@/lib/posthog-server", () => ({ captureServer: vi.fn().mockResolvedValue(undefined) }));

const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

// Mirrors competitions-delete-money.test.ts's local seeding (org/sports via
// SQL, competition via the usecase) — a real division needs a real sport +
// variant to pass createDivision's own config validation.
async function seedCompetition(): Promise<{ auth: AuthCtx; competitionId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"DivEvt " + suffix}, ${"divevt-" + suffix})
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
    name: `Cup ${suffix}`,
    ends_on: "2030-12-31",
    visibility: "private",
    branding: {},
  });
  return { auth, competitionId: comp.id };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("createDivision — activation funnel call count", () => {
  beforeEach(() => {
    vi.mocked(captureServer).mockClear();
  });

  it("fires DIVISION_CREATED exactly once", async () => {
    const { auth, competitionId } = await seedCompetition();
    vi.mocked(captureServer).mockClear(); // isolate from the competition's own COMPETITION_CREATED
    const division = await createDivision(auth, competitionId, {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: {},
    });
    const calls = vi.mocked(captureServer).mock.calls.map(([args]) => args);
    const divisionCalls = calls.filter((c) => c.event === EVENTS.DIVISION_CREATED);
    expect(divisionCalls).toHaveLength(1);
    expect(divisionCalls[0]).toMatchObject({
      properties: { sport_key: "generic", competition_id: competitionId },
    });
    expect(division.sport_key).toBe("generic");
  });

  it("two divisions in the same competition fire DIVISION_CREATED once EACH, not batched or shared", async () => {
    const { auth, competitionId } = await seedCompetition();
    vi.mocked(captureServer).mockClear();
    await createDivision(auth, competitionId, {
      name: "Open A",
      sport_key: "generic",
      variant_key: "score",
      config: {},
    });
    await createDivision(auth, competitionId, {
      name: "Open B",
      sport_key: "generic",
      variant_key: "score",
      config: {},
    });
    const calls = vi.mocked(captureServer).mock.calls.map(([args]) => args);
    expect(calls.filter((c) => c.event === EVENTS.DIVISION_CREATED)).toHaveLength(2);
  });
});
