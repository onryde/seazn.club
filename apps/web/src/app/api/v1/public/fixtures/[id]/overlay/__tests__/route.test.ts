// Stream overlay W1, Task 0 — `GET /api/v1/public/fixtures/{id}/overlay`
// driven through the REAL route handler, against a REAL seeded fixture.
//
// Why this file exists beyond the brief's named acceptance (deviation,
// recorded in the task report): `load.test.ts` mocks `publicFixture`,
// `foldFixture`, `unstable_cache` AND `sql` — every seam the loader has. A
// green suite there proves the projection and the cache key and nothing about
// whether the route, the usecase, the venue-zone query and the row's real
// column names actually fit together. That is recurring failure class 1 (the
// inert seam) exactly, and the brief routes the only end-to-end proof to Task
// 8's Playwright spec, which does not exist yet and which CI does not run on a
// feature branch at all. This is the cheapest thing that makes the seam real.
//
// Shaped after the sibling `../../__tests__/route.test.ts` (Spectator W1 Task
// 9), including its `afterAll` connection close. Real Postgres required;
// skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { seedOrg, GENERIC_CONFIG } from "@/server/usecases/__tests__/_seed";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { GET } from "../route";
import { GET as GET_PUBLIC_FIXTURE } from "../../route";

const HAS_DB = !!process.env.DATABASE_URL;

interface Envelope {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; [k: string]: unknown };
}

function req(id: string, suffix = ""): Request {
  return new Request(`https://test.local/api/v1/public/fixtures/${id}${suffix}`, {
    headers: { "x-forwarded-for": "9.9.9." + Math.floor(Math.random() * 250) },
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

async function read(res: Response): Promise<{ status: number; body: Envelope }> {
  return { status: res.status, body: (await res.json()) as Envelope };
}

async function publicGenericFixture(
  visibility: "public" | "private" = "public",
  orgTz: string | null = null,
): Promise<string> {
  const { auth } = await seedOrg("pro");
  if (orgTz !== null) {
    await sql`update organizations set timezone = ${orgTz} where id = ${auth.orgId}`;
  }
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Overlay Cup",
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
    ["A", "B"].map((name, i) => ({
      kind: "individual" as const,
      display_name: name,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "League",
    config: {},
  });
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

describe.skipIf(!HAS_DB)("GET /public/fixtures/{id}/overlay", () => {
  it("200s carrying the ROW's own snapshot fields, byte-equal to /public/fixtures/{id}'s", async () => {
    const fixtureId = await publicGenericFixture("public", "Asia/Kolkata");
    const overlay = await read(await GET(req(fixtureId, "/overlay"), ctx(fixtureId)));
    const plain = await read(await GET_PUBLIC_FIXTURE(req(fixtureId), ctx(fixtureId)));
    expect(overlay.status).toBe(200);
    expect(plain.status).toBe(200);
    expect(overlay.body.ok).toBe(true);
    // One authority (match_states): the overlay must not re-derive what the
    // existing endpoint already publishes, or the scorebug and the match page
    // can disagree on air.
    expect(overlay.body.data?.status).toEqual(plain.body.data?.status);
    expect(overlay.body.data?.summary).toEqual(plain.body.data?.summary);
    expect(overlay.body.data?.outcome).toEqual(plain.body.data?.outcome);
    // …and it carries the two fields that are the point of the endpoint.
    expect(
      overlay.body.data?.venueTz,
      "the org's own zone, resolved through the VENUE lane — not UTC, not a browser zone",
    ).toBe("Asia/Kolkata");
    expect(overlay.body.data).toHaveProperty("lastSeq");
    // A fixture with no events folds to nothing, so neither optional field is
    // present — the negative pair for the projection's positive cases.
    expect(overlay.body.data?.lastSeq).toBeNull();
    expect(overlay.body.data?.clock).toBeUndefined();
    expect(overlay.body.data?.cricket).toBeUndefined();
  });

  it("falls back to UTC when the organisation has no zone", async () => {
    const fixtureId = await publicGenericFixture();
    const { status, body } = await read(await GET(req(fixtureId, "/overlay"), ctx(fixtureId)));
    expect(status).toBe(200);
    expect(body.data?.venueTz).toBe("UTC");
  });

  it("404s for a private competition's fixture, and for an unknown id (visibility is the public view's, not this route's)", async () => {
    const privateId = await publicGenericFixture("private");
    expect((await read(await GET(req(privateId, "/overlay"), ctx(privateId)))).status).toBe(404);
    const unknown = "00000000-0000-0000-0000-000000000000";
    expect((await read(await GET(req(unknown, "/overlay"), ctx(unknown)))).status).toBe(404);
  });
});
