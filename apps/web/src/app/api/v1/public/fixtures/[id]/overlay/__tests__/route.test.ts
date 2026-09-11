// Stream overlay W1, Task 0 — `GET /api/v1/public/fixtures/{id}/overlay`
// driven through the REAL route handler, against a REAL seeded fixture.
//
// Why this file exists beyond the brief's named acceptance: `load.test.ts`
// mocks `publicFixture`, `foldFixture`, `unstable_cache` AND `sql` — every seam
// the loader has. Green there proves the projection and the cache key and
// NOTHING about whether the route, the usecase, the venue query and the row's
// real column names fit together (recurring failure class 1, the inert seam).
//
// `unstable_cache` has no incremental cache outside the Next server runtime, so
// a bare vitest process gets `Invariant: incrementalCache missing` from it.
// That is a TEST-environment fact, not a production one: `calendar.ics/route.ts`
// is a shipping Route Handler that calls `getPublicDivision`, wrapped in
// `unstable_cache` the same way. So we stub it passthrough here — the same
// double `data-court-venue-names.test.ts` and `public-fixture-venue-tz.test.ts`
// use — which leaves the fold, `sql.begin`, `foldFixture` and the projection
// all really executing against real Postgres. The cache KEY's correctness is
// proven separately by `load.test.ts`'s memo double.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { sql } from "@/lib/db";
import { seedOrg, GENERIC_CONFIG } from "@/server/usecases/__tests__/_seed";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { appendEvent } from "@/server/engine-db/append-event";
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

interface Seeded {
  orgId: string;
  divisionId: string;
  fixtureId: string;
  homeEntrantId: string | null;
}

async function seedFixture(opts: {
  visibility?: "public" | "private";
  orgTz?: string | null;
  sportKey?: "generic" | "football" | "badminton";
} = {}): Promise<Seeded> {
  const { visibility = "public", orgTz = null, sportKey = "generic" } = opts;
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
    sport_key: sportKey,
    // `11-a-side` is football's own declared variant (spec 04 §1.1,
    // `football.ts:2407`). This read `"std"`, which no sport declares — it
    // only ever resolved against a local database polluted by earlier test
    // runs, and 422'd on CI's clean one. `generic.score` IS declared.
    variant_key:
      sportKey === "football"
        ? "11-a-side"
        : sportKey === "badminton"
          ? // Badminton's own declared short format — to 11, so a set point is
            // ten rallies away rather than twenty (`badminton.ts:39-43`).
            "short"
          : "score",
    config: sportKey === "generic" ? GENERIC_CONFIG : {},
  });
  // Football is a team sport — `createEntrants` refuses 'individual' there.
  const kind = sportKey === "football" ? ("team" as const) : ("individual" as const);
  await createEntrants(
    auth,
    division.id,
    ["A", "B"].map((name, i) => ({ kind, display_name: name, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "League",
    config: {},
  });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  const fx = fixtures[0]! as { id: string; home_entrant_id: string | null };
  return {
    orgId: auth.orgId,
    divisionId: division.id,
    fixtureId: fx.id,
    homeEntrantId: fx.home_entrant_id,
  };
}

/** A football fixture whose ledger really holds a stamped goal, so `last_seq`
 *  is non-null and the fold has something to say. Uses the REAL append path so
 *  `match_states.last_seq` (what `public_fixtures_v` publishes) advances. */
async function footballFixtureWithStampedGoal(elapsed = 761): Promise<Seeded> {
  const s = await seedFixture({ sportKey: "football", orgTz: "Europe/Amsterdam" });
  await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
  await appendEvent(s.orgId, s.fixtureId, 1, {
    type: "football.goal",
    payload: { by: s.homeEntrantId, at: { period: "H1", elapsed } },
  });
  return s;
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
    const { fixtureId } = await seedFixture({ orgTz: "Asia/Kolkata" });
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
    expect(overlay.body.data?.venueTz, "the org's own zone via the VENUE lane").toBe("Asia/Kolkata");
    expect(overlay.body.data).toHaveProperty("lastSeq");
    // A fixture with no events folds to nothing, so neither optional field is
    // present — the negative pair for the positive cases below.
    expect(overlay.body.data?.lastSeq).toBeNull();
    expect(overlay.body.data?.clock).toBeUndefined();
    expect(overlay.body.data?.cricket).toBeUndefined();
  });

  it("falls back to UTC when the organisation has no zone", async () => {
    const { fixtureId } = await seedFixture();
    const { status, body } = await read(await GET(req(fixtureId, "/overlay"), ctx(fixtureId)));
    expect(status).toBe(200);
    expect(body.data?.venueTz).toBe("UTC");
  });

  it("the division's schedule_settings override beats the organisation's zone", async () => {
    // Review 2026-09-09 (I4): nothing exercised `ss.tz` through the loader, so
    // blanking that column in load.ts's read stayed green everywhere — the
    // exact sibling of the `org_tz` defect mutant 6 found. `tz` is
    // `not null default 'UTC'` (V114:48), so the row must carry a REAL zone:
    // inserting the default would assert the org-fallback branch by accident.
    const { fixtureId, divisionId, orgId } = await seedFixture({ orgTz: "Asia/Kolkata" });
    await sql`
      insert into schedule_settings (division_id, org_id, tz)
      values (${divisionId}, ${orgId}, 'Europe/Amsterdam')
      on conflict (division_id) do update set tz = excluded.tz`;
    const { status, body } = await read(await GET(req(fixtureId, "/overlay"), ctx(fixtureId)));
    expect(status).toBe(200);
    expect(
      body.data?.venueTz,
      "a London organiser running an event in Malaga — the venue lane's reason to exist",
    ).toBe("Europe/Amsterdam");
    expect(body.data?.venueTz).not.toBe("Asia/Kolkata");
  });

  it("a fixture with REAL events runs the cached fold and materialises the clock the engine derived", async () => {
    // Review 2026-09-09 (I1): every earlier case had `last_seq === null`, so
    // `loadOverlayLiveData` short-circuited past `cachedFold` entirely and the
    // endpoint's whole reason to exist had never executed anywhere.
    const elapsed = 761;
    const { fixtureId } = await footballFixtureWithStampedGoal(elapsed);
    const { status, body } = await read(await GET(req(fixtureId, "/overlay"), ctx(fixtureId)));
    expect(status).toBe(200);
    expect(body.data?.lastSeq, "the ledger advanced, so the fold had input").toBe(2);
    const clock = body.data?.clock as
      | { phase: string; anchorSeconds: number; anchorAtWallMs: number }
      | undefined;
    expect(clock, "the fold ran and the projection found the stamp").toBeDefined();
    expect(clock!.phase).toBe("H1");
    // The value the scorer actually recorded, not merely "a number".
    expect(clock!.anchorSeconds).toBe(elapsed);
    expect(clock!.anchorAtWallMs).toBeGreaterThan(0);
    expect(body.data?.venueTz).toBe("Europe/Amsterdam");
    // The row's own fields still ride alongside the folded ones.
    expect(body.data?.status).toBeDefined();

    // W2 — `recent` over the REAL route, from the REAL ledger. `load.test.ts`
    // doubles `loadFoldInputs` and `sql`; this is where the window, the
    // projection and the actual column names have to fit together.
    const recent = body.data?.recent as { seq: number; type: string; payload: { side?: number } }[];
    expect(Array.isArray(recent)).toBe(true);
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({ seq: 2, type: "football.goal", payload: { side: 0 } });
    // The kernel's own events are not moments.
    expect(recent.some((e) => e.type.startsWith("core."))).toBe(false);
    // A goal that named no scorer names no person — never an empty one.
    expect(recent[0]!.payload).not.toHaveProperty("person");
  });

  it("W2 Step 7 — a real badminton ledger arrives with the ENGINE'S set point on it", async () => {
    // The whole Step 7 chain in production shape: real appends, real fold,
    // real replay, real cache boundary, real route. Badminton `short` plays to
    // 11, so ten unanswered rallies leaves home one point from the set — and
    // the assertion is that the MODULE said so, not that this test counted.
    const s = await seedFixture({ sportKey: "badminton" });
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    for (let i = 0; i < 10; i++) {
      await appendEvent(s.orgId, s.fixtureId, i + 1, {
        type: "badminton.rally",
        payload: { wonBy: s.homeEntrantId },
      });
    }
    const { status, body } = await read(await GET(req(s.fixtureId, "/overlay"), ctx(s.fixtureId)));
    expect(status).toBe(200);
    const recent = body.data?.recent as {
      seq: number;
      type: string;
      derived?: { pointState?: { kind: string; side: number; fresh: boolean } };
    }[];
    // Ten rallies, a window of eight.
    expect(recent).toHaveLength(8);
    expect(new Set(recent.map((e) => e.type))).toEqual(new Set(["badminton.rally"]));
    expect(recent.at(-1)?.derived?.pointState).toMatchObject({ kind: "set", side: 0, fresh: true });
    // And it is FRESH exactly once — the rallies before it were not set points.
    expect(recent.filter((e) => e.derived?.pointState).length).toBe(1);
  });

  it("still 200s with the row's fields when the fold THROWS (the sibling endpoint would too)", async () => {
    // Review 2026-09-09 (I5). `foldFixture` throws EngineError WRONG_PHASE for
    // a fixture with an unassigned entrant — reachable in production because
    // the entrant FK is `on delete set null`. `v1()` maps EngineError through
    // ENGINE_HTTP, so without the catch in `foldOrNull` the overlay goes DARK
    // mid-broadcast on a fixture whose `/public/fixtures/{id}` sibling still
    // answers 200, because that endpoint does not fold at all.
    const { fixtureId } = await footballFixtureWithStampedGoal();
    await sql`update fixtures set home_entrant_id = null where id = ${fixtureId}`;
    // `publicFixture` memoises 30 s per fixture id; this id has not been read
    // yet, so the row below is fetched fresh after the update.
    const { status, body } = await read(await GET(req(fixtureId, "/overlay"), ctx(fixtureId)));
    expect(status, "a broken fold must not take the scorebug off air").toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data?.status).toBeDefined();
    expect(body.data?.venueTz).toBe("Europe/Amsterdam");
    expect(body.data?.lastSeq).toBe(2);
    // The fold contributed nothing, and said so by omission rather than by 422.
    expect(body.data?.clock).toBeUndefined();
    expect(body.data?.cricket).toBeUndefined();
  });

  it("404s for a private competition's fixture, and for an unknown id (visibility is the public view's, not this route's)", async () => {
    const { fixtureId: privateId } = await seedFixture({ visibility: "private" });
    expect((await read(await GET(req(privateId, "/overlay"), ctx(privateId)))).status).toBe(404);
    const unknown = "00000000-0000-0000-0000-000000000000";
    expect((await read(await GET(req(unknown, "/overlay"), ctx(unknown)))).status).toBe(404);
  });
});
