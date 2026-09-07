// Task 6 smoke case (spec §"Task 6 — the band's producer"): the endpoint
// 200s and its body validates against S.CompetitionDesk — proves the wire
// contract end to end (the v1() envelope, requireResourceAuth, and the
// schema itself), not just the pure usecase (competition-desk.test.ts's own
// suite covers the aggregate's behaviour in depth). Same route-test pattern
// as the sibling `registrations/__tests__/route.test.ts`: import GET
// directly and call it with a real Request, session auth mocked the same
// way, real Postgres for everything else.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const HAS_DB = !!process.env.DATABASE_URL;

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
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { CompetitionDesk } from "@/server/api-v1/schemas";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { GET } from "../route";

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function makeUser(name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`${name}-${randomUUID().slice(0, 8)}@test.local`}, ${name}, true)
    returning id`;
  return id;
}

async function seedOrg(): Promise<{ auth: AuthCtx; ownerId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const ownerId = await makeUser("owner");
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Desk Api " + suffix}, ${"desk-api-" + suffix}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
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
  return { auth: { orgId, via: "session", userId: ownerId, role: "owner", keyId: null }, ownerId };
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const deskReq = (id: string) => new Request(`https://test.local/api/v1/competitions/${id}/desk`);

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end({ timeout: 1 });
});

describe.skipIf(!HAS_DB)("GET /api/v1/competitions/[id]/desk", () => {
  it("200s with the {ok, data} envelope, and data validates against S.CompetitionDesk carrying real in-play fixtures", async () => {
    const { auth, ownerId } = await seedOrg();
    authState.userId = ownerId;
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Desk Api Cup " + randomUUID().slice(0, 6),
      visibility: "private",
      branding: {},
    });
    const division = await createDivision(auth, comp.id, {
      name: "Open",
      slug: "open",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
    });
    await createEntrants(
      auth,
      division.id,
      Array.from({ length: 4 }, (_, i) => ({
        kind: "individual" as const,
        display_name: `E${i + 1}`,
        seed: i + 1,
        members: [],
      })),
    );
    const [stage] = await createStages(auth, division.id, {
      seq: 1,
      kind: "league",
      name: "League",
      config: {},
      progression: null,
    });
    await generateStageFixtures(auth, stage!.id);
    await sql`update divisions set status = 'active' where id = ${division.id}`;
    const [f] = await sql<{ id: string }[]>`select id from fixtures where division_id = ${division.id} order by fixture_no limit 1`;
    await sql`update fixtures set status = 'in_play', scheduled_at = now() - interval '10 minutes' where id = ${f!.id}`;

    const res = await GET(deskReq(comp.id), ctx(comp.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: unknown; requestId: string };
    // The envelope, not a bare body — v1() supplies it, never hand-rolled.
    expect(body.ok).toBe(true);
    expect(typeof body.requestId).toBe("string");
    const parsed = CompetitionDesk.parse(body.data);
    expect(parsed.in_play).toBe(1);
    expect(parsed.in_play_fixtures).toHaveLength(1);
    expect(parsed.in_play_fixtures[0]?.division_name).toBe("Open");
    // `divisions` is a `Map` on the usecase's own type — a bare Map
    // serialises to `{}` over JSON (no own enumerable properties), which
    // `z.record` accepts vacuously (an empty object satisfies any value
    // schema). This is the assertion that actually distinguishes "the route
    // converted it" from "the route returned a Map that quietly serialised
    // to nothing": confirmed by mutating the route to `return desk;` bare —
    // this line reddens, `in_play`/`in_play_fixtures` above do not.
    expect(Object.keys(parsed.divisions)).toEqual([division.id]);
  });

  it("a non-member of the org is refused (401)", async () => {
    const { auth } = await seedOrg();
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Desk Api Outsider " + randomUUID().slice(0, 6),
      visibility: "private",
      branding: {},
    });
    authState.userId = await makeUser("outsider");
    const res = await GET(deskReq(comp.id), ctx(comp.id));
    expect(res.status).toBe(401);
  });
});
