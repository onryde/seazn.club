// RS009 — HTTP wiring for registration-assign.ts's assignSoloSignUp /
// unassignSoloSignUp / listAssignTargets. Every business rule (same-division,
// roster cap, mixed-division composition, idempotent re-assign/unassign, the
// started-division refusal) is registration-assign.ts's own — already
// covered in registration-assign.test.ts — and is NOT re-tested here. This
// suite is about the HTTP layer: routing, request parsing (including the
// body-less POST class of bug .../promote/route.ts documents), authz, and
// the assign-targets listing shape.
import { afterAll, describe, expect, it, vi } from "vitest";

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

import { randomUUID } from "node:crypto";
import { football } from "@seazn/engine/sports/football";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { putRegistrationSettings } from "@/server/usecases/registrations";
import { asOwner, makeUser, seedOrg } from "@/server/usecases/__tests__/_registration-fixtures";
import { POST as assignRoute } from "@/app/api/v1/registrations/[id]/assign/route";
import { POST as unassignRoute } from "@/app/api/v1/registrations/[id]/unassign/route";
import { GET as assignTargetsRoute } from "@/app/api/v1/registrations/[id]/assign-targets/route";

// --- fixtures -----------------------------------------------------------
// Football, deliberately, not `generic`: generic's position_catalog declares
// a lineup of { size: 1, benchMax: 0 }, so a team would already be "full" at
// one player and the happy-path (roster grows 1 -> 2) test could never pass.
// Copied (not imported) from registration-assign.test.ts's own local
// fixtures — that file is off-limits to edit, and these are its exact,
// already-proven shapes.

async function seedFootballCatalog(): Promise<void> {
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('football', 'Football', ${football.version}, ${sql.json(football.positions as never)})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('football', 'default', 'Default', ${sql.json({})}, true)
    on conflict do nothing`;
}

async function seedTeamDivision(auth: AuthCtx): Promise<{ divisionId: string }> {
  await seedFootballCatalog();
  const competition = await createCompetition(auth, {
    name: "Assign Route Cup " + randomUUID().slice(0, 6),
    visibility: "public",
    branding: {},
    starts_on: "2026-09-15",
    ends_on: "2026-09-20",
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open " + randomUUID().slice(0, 6),
    sport_key: "football",
    variant_key: "default",
    config: {},
  });
  await putRegistrationSettings(auth, division.id, {
    enabled: true,
    entrant_kind: "team",
    fee_cents: 0,
    form_fields: [],
    opens_at: null,
    closes_at: null,
    capacity: null,
    refund_lock_at: null,
    allow_free_agents: true,
  });
  return { divisionId: division.id };
}

async function seedEntry(
  divisionId: string,
  opts: {
    displayName: string;
    freeAgent?: boolean;
    status?: "pending" | "paid" | "confirmed";
    players?: { name: string; gender?: string | null }[];
  },
): Promise<{ id: string }> {
  const [{ competition_id: competitionId }] = await sql<{ competition_id: string }[]>`
    select competition_id from divisions where id = ${divisionId}`;
  const [group] = await sql<{ id: string }[]>`
    insert into registration_groups
      (competition_id, contact_name, contact_email, access_token_hash, currency)
    values (
      ${competitionId}, 'Contact', ${`c-${randomUUID().slice(0, 8)}@test.local`},
      ${`tok-${randomUUID()}`}, 'gbp'
    )
    returning id`;
  const [reg] = await sql<{ id: string }[]>`
    insert into registrations (group_id, division_id, display_name, free_agent, status)
    values (${group.id}, ${divisionId}, ${opts.displayName}, ${opts.freeAgent ?? false}, ${opts.status ?? "confirmed"})
    returning id`;
  for (const p of opts.players ?? []) {
    await sql`
      insert into registration_players (registration_id, full_name, gender, source)
      values (${reg.id}, ${p.name}, ${p.gender ?? null}, 'captain_entered')`;
  }
  return reg;
}

/** Live roster cap for a division, read the same way `rosterCapExpr` derives
 *  it — dynamic rather than hardcoding football's current 11+12, so this
 *  test does not silently drift if the catalog ever changes. */
async function rosterCapOf(divisionId: string): Promise<number> {
  const [row] = await sql<{ cap: number }[]>`
    select ((sp.position_catalog -> 'lineup' ->> 'size')::int
            + coalesce((sp.position_catalog -> 'lineup' ->> 'benchMax')::int, 0)) as cap
    from divisions d join sports sp on sp.key = d.sport_key
    where d.id = ${divisionId}`;
  return row!.cap;
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function postReq(path: string, body?: unknown): Request {
  return new Request(`https://test.local/api/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

function getReq(path: string): Request {
  return new Request(`https://test.local/api/v1${path}`, { method: "GET" });
}

interface AssignTargetWire {
  registration_id: string;
  display_name: string;
  roster_count: number;
  roster_cap: number | null;
  is_full: boolean;
  genders: (string | null)[];
}

interface Envelope {
  ok: boolean;
  data?: Record<string, unknown> | null;
  error?: { code: string; message: string };
}

async function read(res: Response): Promise<{ status: number; body: Envelope }> {
  return { status: res.status, body: (await res.json()) as Envelope };
}

async function signedInOwner() {
  const { orgId, ownerId } = await seedOrg();
  authState.userId = ownerId;
  return { orgId, owner: asOwner(orgId, ownerId) };
}

async function memberWithRole(orgId: string, role: "admin" | "viewer"): Promise<string> {
  const userId = await makeUser(role);
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, ${role})`;
  return userId;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

// --- POST /registrations/:id/assign --------------------------------------

describe.skipIf(!HAS_DB)("POST /registrations/:id/assign", () => {
  it("happy path: 200, and the target roster grows", async () => {
    const { owner } = await signedInOwner();
    const { divisionId } = await seedTeamDivision(owner);
    const team = await seedEntry(divisionId, { displayName: "Team A", players: [{ name: "Captain One" }] });
    const solo = await seedEntry(divisionId, {
      displayName: "Priya Raman",
      freeAgent: true,
      players: [{ name: "Priya Raman" }],
    });

    const { status, body } = await read(
      await assignRoute(
        postReq(`/registrations/${solo.id}/assign`, { target_registration_id: team.id }),
        ctx(solo.id),
      ),
    );
    expect(status).toBe(200);
    expect(body.data!.target_registration_id).toBe(team.id);
    expect(body.data!.roster_count).toBe(2);

    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from registration_players where registration_id = ${team.id}`;
    expect(Number(n)).toBe(2);
  });

  it("refuses a target in a different division: 422, message mentions same division", async () => {
    const { owner } = await signedInOwner();
    const a = await seedTeamDivision(owner);
    const b = await seedTeamDivision(owner);
    const team = await seedEntry(b.divisionId, { displayName: "Other Division Team" });
    const solo = await seedEntry(a.divisionId, {
      displayName: "Priya Raman",
      freeAgent: true,
      players: [{ name: "Priya Raman" }],
    });

    const { status, body } = await read(
      await assignRoute(
        postReq(`/registrations/${solo.id}/assign`, { target_registration_id: team.id }),
        ctx(solo.id),
      ),
    );
    expect(status).toBe(422);
    expect(body.error?.message).toMatch(/same division/i);
  });

  it("refuses when the URL id is not itself a solo sign-up: 422", async () => {
    const { owner } = await signedInOwner();
    const { divisionId } = await seedTeamDivision(owner);
    const teamA = await seedEntry(divisionId, { displayName: "Team A" });
    const teamB = await seedEntry(divisionId, { displayName: "Team B", players: [{ name: "Someone" }] });

    const { status, body } = await read(
      await assignRoute(
        postReq(`/registrations/${teamB.id}/assign`, { target_registration_id: teamA.id }),
        ctx(teamB.id),
      ),
    );
    expect(status).toBe(422);
    expect(body.error?.message).toMatch(/solo sign-up/i);
  });
});

// --- POST /registrations/:id/unassign ------------------------------------

describe.skipIf(!HAS_DB)("POST /registrations/:id/unassign", () => {
  it("accepts a genuinely body-less POST: 200 (the promote-route bug class — {} does not cover this)", async () => {
    const { owner } = await signedInOwner();
    const { divisionId } = await seedTeamDivision(owner);
    const team = await seedEntry(divisionId, { displayName: "Team A" });
    const solo = await seedEntry(divisionId, {
      displayName: "Priya Raman",
      freeAgent: true,
      players: [{ name: "Priya Raman" }],
    });
    await assignRoute(
      postReq(`/registrations/${solo.id}/assign`, { target_registration_id: team.id }),
      ctx(solo.id),
    );

    // No body property at all — NOT postReq's "{}". `await req.json()` on
    // this throws; the route must use req.text() instead.
    const bodyless = new Request(`https://test.local/api/v1/registrations/${solo.id}/unassign`, {
      method: "POST",
    });
    const { status, body } = await read(await unassignRoute(bodyless, ctx(solo.id)));
    expect(status).toBe(200);
    expect(body.data!.registration_id).toBe(solo.id);
    expect(body.data!.target_registration_id).toBe(team.id);

    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from registration_players
      where registration_id = ${team.id} and assigned_from_registration_id = ${solo.id}`;
    expect(Number(n)).toBe(0);
  });

  it("is idempotent: unassigning an entry already in the pool is 200", async () => {
    const { owner } = await signedInOwner();
    const { divisionId } = await seedTeamDivision(owner);
    const solo = await seedEntry(divisionId, {
      displayName: "Priya Raman",
      freeAgent: true,
      players: [{ name: "Priya Raman" }],
    });

    const bodyless = new Request(`https://test.local/api/v1/registrations/${solo.id}/unassign`, {
      method: "POST",
    });
    const { status, body } = await read(await unassignRoute(bodyless, ctx(solo.id)));
    expect(status).toBe(200);
    expect(body.data!.registration_id).toBe(solo.id);
    expect(body.data!.target_registration_id).toBeNull();
  });

  it("still refuses MALFORMED json with the same 400, not a raw parser crash", async () => {
    const { owner } = await signedInOwner();
    const { divisionId } = await seedTeamDivision(owner);
    const solo = await seedEntry(divisionId, {
      displayName: "Priya Raman",
      freeAgent: true,
      players: [{ name: "Priya Raman" }],
    });

    const broken = new Request(`https://test.local/api/v1/registrations/${solo.id}/unassign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const { status, body } = await read(await unassignRoute(broken, ctx(solo.id)));
    expect(status).toBe(400);
    expect(body.error?.message).toMatch(/valid JSON/i);
  });
});

// --- GET /registrations/:id/assign-targets -------------------------------

describe.skipIf(!HAS_DB)("GET /registrations/:id/assign-targets", () => {
  it("lists only same-division non-free-agent, non-terminal entries; correct roster_count/roster_cap; marks a full team is_full", async () => {
    const { owner } = await signedInOwner();
    const { divisionId } = await seedTeamDivision(owner);
    const cap = await rosterCapOf(divisionId);

    const fullTeam = await seedEntry(divisionId, {
      displayName: "Full Team",
      players: Array.from({ length: cap }, (_, i) => ({ name: `Player ${i + 1}` })),
    });
    const openTeam = await seedEntry(divisionId, {
      displayName: "Open Team",
      players: [{ name: "Captain Two" }],
    });
    // Same-division free agent — must never appear as a target.
    await seedEntry(divisionId, {
      displayName: "Other Solo",
      freeAgent: true,
      players: [{ name: "Other Solo" }],
    });
    // Same-division but terminal — must never appear either.
    const withdrawnTeam = await seedEntry(divisionId, { displayName: "Gone Team" });
    await sql`update registrations set status = 'withdrawn' where id = ${withdrawnTeam.id}`;
    // A team in ANOTHER division — must never appear.
    const other = await seedTeamDivision(owner);
    await seedEntry(other.divisionId, { displayName: "Other Division Team" });

    const solo = await seedEntry(divisionId, {
      displayName: "Priya Raman",
      freeAgent: true,
      players: [{ name: "Priya Raman", gender: "f" }],
    });

    const { status, body } = await read(
      await assignTargetsRoute(getReq(`/registrations/${solo.id}/assign-targets`), ctx(solo.id)),
    );
    expect(status).toBe(200);
    expect(body.data!.division_id).toBe(divisionId);
    const targets = body.data!.targets as AssignTargetWire[];
    expect(targets.map((t) => t.display_name).sort()).toEqual(["Full Team", "Open Team"]);

    const full = targets.find((t) => t.registration_id === fullTeam.id)!;
    expect(full.roster_count).toBe(cap);
    expect(full.roster_cap).toBe(cap);
    expect(full.is_full).toBe(true);

    const open = targets.find((t) => t.registration_id === openTeam.id)!;
    expect(open.roster_count).toBe(1);
    expect(open.roster_cap).toBe(cap);
    expect(open.is_full).toBe(false);
    expect(open.genders).toEqual([null]); // Captain Two seeded with no gender
  });

  it("404s when the URL id is not itself a solo sign-up", async () => {
    const { owner } = await signedInOwner();
    const { divisionId } = await seedTeamDivision(owner);
    const team = await seedEntry(divisionId, { displayName: "Team A" });

    const { status } = await read(
      await assignTargetsRoute(getReq(`/registrations/${team.id}/assign-targets`), ctx(team.id)),
    );
    expect(status).toBe(404);
  });

  it("authz: refused for a viewer (403); allowed for owner and admin (200)", async () => {
    const { orgId, owner } = await signedInOwner();
    const viewerId = await memberWithRole(orgId, "viewer");
    const adminId = await memberWithRole(orgId, "admin");
    const { divisionId } = await seedTeamDivision(owner);
    const solo = await seedEntry(divisionId, {
      displayName: "Priya Raman",
      freeAgent: true,
      players: [{ name: "Priya Raman" }],
    });

    authState.userId = viewerId;
    expect(
      (await assignTargetsRoute(getReq(`/registrations/${solo.id}/assign-targets`), ctx(solo.id))).status,
    ).toBe(403);

    authState.userId = owner.userId!;
    expect(
      (await assignTargetsRoute(getReq(`/registrations/${solo.id}/assign-targets`), ctx(solo.id))).status,
    ).toBe(200);

    authState.userId = adminId;
    expect(
      (await assignTargetsRoute(getReq(`/registrations/${solo.id}/assign-targets`), ctx(solo.id))).status,
    ).toBe(200);
  });
});
