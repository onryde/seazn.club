// Spectator surface W1, Task 9 — `GET /api/v1/public/fixtures/{id}` carries
// `match_centre` end to end through the real route handler (not just the
// usecase — `publicFixture` unit coverage lives in
// usecases/__tests__/public-fixture-match-centre.test.ts). Real Postgres
// required; skipped without DATABASE_URL, same convention as every other
// DB-backed route test in this repo (join-route.test.ts, etc.).
import { afterAll, describe, expect, it } from "vitest";
import { MatchCentreDoc } from "@/server/public-site/match-centre-schema";
import { seedOrg, GENERIC_CONFIG } from "@/server/usecases/__tests__/_seed";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { GET } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;

interface Envelope {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; [k: string]: unknown };
}

function req(id: string): Request {
  return new Request(`https://test.local/api/v1/public/fixtures/${id}`, {
    headers: { "x-forwarded-for": "9.9.9." + Math.floor(Math.random() * 250) },
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

async function read(res: Response): Promise<{ status: number; body: Envelope }> {
  return { status: res.status, body: (await res.json()) as Envelope };
}

async function publicGenericFixture(visibility: "public" | "private" = "public"): Promise<string> {
  const { auth } = await seedOrg("pro");
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Route Cup",
    visibility,
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await createEntrants(
    auth,
    division.id,
    ["A", "B"].map((name, i) => ({ kind: "individual" as const, display_name: name, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {} });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  return fixtures[0]!.id;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("GET /public/fixtures/{id} — match_centre (Task 9)", () => {
  it("200s with a schema-valid match_centre on the envelope's data", async () => {
    const fixtureId = await publicGenericFixture();
    const res = await GET(req(fixtureId), ctx(fixtureId));
    const { status, body } = await read(res);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data?.id).toBe(fixtureId);
    const parsed = MatchCentreDoc.safeParse(body.data?.match_centre);
    expect(parsed.success).toBe(true);
    expect((body.data?.match_centre as { fixtureId: string }).fixtureId).toBe(fixtureId);
  });

  it("404s for a private competition's fixture — unchanged by this task", async () => {
    const fixtureId = await publicGenericFixture("private");
    const res = await GET(req(fixtureId), ctx(fixtureId));
    expect((await read(res)).status).toBe(404);
  });

  it("404s for an unknown fixture id", async () => {
    const res = await GET(req("00000000-0000-0000-0000-000000000000"), ctx("00000000-0000-0000-0000-000000000000"));
    expect((await read(res)).status).toBe(404);
  });
});
