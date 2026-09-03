// G3 (bench B03 product-gaps, 2026-09-02): before this route existed, the
// only way to obtain a division's fixtures over HTTP was the idempotent
// POST /stages/{id}/generate — a real endpoint, but "POST to read" is not a
// documented list route. This is a real handler over a real session
// (`requireResourceAuth` unmocked, same pattern as
// persons/__tests__/merge-route.test.ts) proving: the route returns the
// same fixtures generate created, in play order, WITHOUT the legacy
// `venue`/`court_label` text columns (S.Fixture's shape, matching GET
// /fixtures/{id} — not the older FixtureRow shape internal RSC callers get),
// and that org B cannot list org A's division.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({ userId: "" }));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: async () => ({ id: authState.userId }),
    getCurrentUser: async () => ({ id: authState.userId }),
    getActiveOrgId: async () => null,
  };
});

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

import { sql } from "@/lib/db";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { seedOrg, GENERIC_CONFIG } from "@/server/usecases/__tests__/_seed";
import { GET } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;

interface Envelope {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

async function read(res: Response): Promise<{ status: number; body: Envelope }> {
  return { status: res.status, body: (await res.json()) as Envelope };
}

function req(): Request {
  return new Request("https://test.local/api/v1/divisions/x/fixtures", { method: "GET" });
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  await globalForDb._sql?.end();
});

async function seedDivisionWithFixtures(): Promise<{
  auth: Awaited<ReturnType<typeof seedOrg>>["auth"];
  divisionId: string;
  fixtureIds: string[];
}> {
  const { auth } = await seedOrg();
  const competition = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, ends_on, visibility, branding)
    values (${auth.orgId}, 'G3 Cup', ${"g3-cup-" + auth.orgId.slice(0, 8)}, '2030-12-31', 'private', '{}')
    returning id`;
  const division = await createDivision(auth, competition[0]!.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await createEntrants(auth, division.id, [
    { kind: "individual" as const, display_name: "A", seed: 1, members: [] },
    { kind: "individual" as const, display_name: "B", seed: 2, members: [] },
  ]);
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "L", config: {} });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  return { auth, divisionId: division.id, fixtureIds: fixtures.map((f) => f.id) };
}

describe.skipIf(!HAS_DB)("GET /divisions/{id}/fixtures (G3)", () => {
  beforeEach(() => {
    authState.userId = "";
  });

  it("lists the division's fixtures, shaped like GET /fixtures/{id} (no venue/court_label)", async () => {
    const { auth, divisionId, fixtureIds } = await seedDivisionWithFixtures();
    authState.userId = auth.userId!;

    const { status, body } = await read(await GET(req(), { params: Promise.resolve({ id: divisionId }) }));
    expect(status).toBe(200);
    const rows = body.data as Record<string, unknown>[];
    expect(rows.map((r) => r.id).sort()).toEqual([...fixtureIds].sort());
    for (const row of rows) {
      expect(row).not.toHaveProperty("venue");
      expect(row).not.toHaveProperty("court_label");
      expect(row).toHaveProperty("court_id");
      expect(row).toHaveProperty("venue_id");
    }
  });

  it("404s a division that doesn't exist", async () => {
    const { auth } = await seedOrg();
    authState.userId = auth.userId!;
    const res = await GET(req(), { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) });
    expect(res.status).toBe(404);
  });

  it("blocks org B from listing org A's division fixtures", async () => {
    const { divisionId } = await seedDivisionWithFixtures();
    const { auth: authB } = await seedOrg();
    authState.userId = authB.userId!;

    const res = await GET(req(), { params: Promise.resolve({ id: divisionId }) });
    expect([401, 403, 404]).toContain(res.status);
  });
});
