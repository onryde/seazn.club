// RS003 W2 — the public join HTTP boundary over RS002's joinTeamEntry. Same
// mocking shape as register-route.test.ts beside this file: `rateLimit` is
// mocked outright (fails OPEN without Redis in vitest, so a real-limiter
// "proof" would pass unconditionally — see RS003 W2 dispatch), and
// joinTeamEntry is a spy wrapping the real implementation, so wiring
// assertions and DB-backed persistence coexist without diverging behaviour.
// joinTeamEntry itself needs no org/competition scoping (join_code is
// globally unique — see its own doc comment in registration-submit.ts), so
// this file does not test org/slug mismatches; nothing in the route claims
// to check them.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => {}) }));

vi.mock("@/server/usecases/registration-submit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/usecases/registration-submit")>();
  return {
    ...actual,
    joinTeamEntry: vi.fn(actual.joinTeamEntry),
    previewJoinEntry: vi.fn(actual.previewJoinEntry),
    // submitRegistrationGroup stays REAL and unwrapped — DB-backed tests use
    // it directly (unmocked) to mint a joinable team entry as test setup.
  };
});

const authState = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: async () => (authState.userId ? { id: authState.userId } : null) };
});

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  submitRegistrationGroup,
  joinTeamEntry,
  previewJoinEntry,
  type JoinTeamEntryResult,
  type JoinPreviewResult,
} from "@/server/usecases/registration-submit";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { GET as joinPreviewRoute, POST as joinRoute } from "../join/route";

const HAS_DB = !!process.env.DATABASE_URL;
const rl = vi.mocked(rateLimit);
const joinSpy = vi.mocked(joinTeamEntry);
const previewSpy = vi.mocked(previewJoinEntry);

interface Envelope {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; [k: string]: unknown };
}

function req(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://test.local/api/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function getReq(path: string, joinCode: string | null, headers: Record<string, string> = {}): Request {
  const url = new URL(`https://test.local/api/v1${path}`);
  if (joinCode !== null) url.searchParams.set("join_code", joinCode);
  return new Request(url, { headers });
}

async function read(res: Response): Promise<{ status: number; body: Envelope }> {
  return { status: res.status, body: (await res.json()) as Envelope };
}

const ctx = (orgSlug: string, slug: string) => ({ params: Promise.resolve({ orgSlug, slug }) });
const URL_ = (orgSlug: string, slug: string) => `/public/orgs/${orgSlug}/competitions/${slug}/register/join`;

function joinBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    join_code: "SZ-JOIN-0001",
    player: { full_name: "New Joiner" },
    // Required (consent-asymmetry follow-up, 2026-08-28) — every case below
    // that isn't specifically exercising the gate needs a schema-valid body
    // to ever reach joinTeamEntry at all.
    privacy_consent: true,
    ...over,
  };
}

function fakeResult(): JoinTeamEntryResult {
  return { registration_id: randomUUID(), player_id: randomUUID(), consent_status: "granted" };
}

function fakePreview(): JoinPreviewResult {
  return {
    registration_id: randomUUID(),
    display_name: "Joinable Team",
    division_name: "Open",
    competition_name: "Join Cup",
    competition_slug: "join-cup",
    org_slug: "acme",
    org_name: "Acme",
    unclaimed_slots: [],
    allow_new_player: true,
    // RS007 — the public join PAGE's WHO-equivalent fields/fill-meter.
    requires_dob: false,
    requires_gender: false,
    total_players: 0,
    // RS007/V380 — non-null on purpose: the "verbatim" test below would
    // pass just as easily with the null default even if the route silently
    // dropped this field.
    eligibility_note: "School-registered students only",
  };
}

beforeEach(() => {
  rl.mockClear();
  joinSpy.mockClear();
  previewSpy.mockClear();
  authState.userId = null;
});

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

// ---------------------------------------------------------------------------
// Routing / wiring — usecase mocked, no DB required.
// ---------------------------------------------------------------------------

describe("POST .../register/join — routing", () => {
  it("rate-limits on regjoin:<ip> {max:5, windowSeconds:300}", async () => {
    joinSpy.mockResolvedValueOnce(fakeResult());
    await joinRoute(
      req(URL_("acme", "cup"), joinBody(), { "x-forwarded-for": "8.8.8.1" }),
      ctx("acme", "cup"),
    );
    expect(rl.mock.calls).toEqual([["regjoin:8.8.8.1", { max: 5, windowSeconds: 300 }]]);
  });

  it("surfaces a rate-limit rejection instead of swallowing it", async () => {
    rl.mockImplementationOnce(async () => {
      throw new HttpError(429, "slow down");
    });
    const res = await joinRoute(
      req(URL_("acme", "cup"), joinBody(), { "x-forwarded-for": "8.8.8.2" }),
      ctx("acme", "cup"),
    );
    expect((await read(res)).status).toBe(429);
    expect(joinSpy).not.toHaveBeenCalled();
  });

  it("returns joinTeamEntry's result verbatim at 201", async () => {
    const fake = fakeResult();
    joinSpy.mockResolvedValueOnce(fake);
    const res = await joinRoute(
      req(URL_("acme", "cup"), joinBody(), { "x-forwarded-for": "8.8.8.3" }),
      ctx("acme", "cup"),
    );
    const { status, body } = await read(res);
    expect(status).toBe(201);
    expect(body.data).toEqual(fake);
  });

  it("a signed-in joiner's session id reaches the usecase as sessionUserId", async () => {
    authState.userId = "22222222-2222-2222-2222-222222222222";
    joinSpy.mockResolvedValueOnce(fakeResult());
    await joinRoute(
      req(URL_("acme", "cup"), joinBody(), { "x-forwarded-for": "8.8.8.4" }),
      ctx("acme", "cup"),
    );
    expect(joinSpy.mock.calls[0]![0]).toMatchObject({
      sessionUserId: "22222222-2222-2222-2222-222222222222",
    });
  });

  it("signed-out reaches the usecase as sessionUserId:null", async () => {
    joinSpy.mockResolvedValueOnce(fakeResult());
    await joinRoute(
      req(URL_("acme", "cup"), joinBody(), { "x-forwarded-for": "8.8.8.5" }),
      ctx("acme", "cup"),
    );
    expect(joinSpy.mock.calls[0]![0]).toMatchObject({ sessionUserId: null });
  });

  it("forwards the parsed request body (join_code, player, guardian fields) verbatim as input", async () => {
    joinSpy.mockResolvedValueOnce(fakeResult());
    await joinRoute(
      req(
        URL_("acme", "cup"),
        joinBody({
          join_code: "SZ-JOIN-9999",
          player: { full_name: "Minor Joiner", dob: "2015-01-01" },
          guardian_name: "A Guardian",
          guardian_consent: true,
        }),
        { "x-forwarded-for": "8.8.8.6" },
      ),
      ctx("acme", "cup"),
    );
    expect(joinSpy.mock.calls[0]![1]).toMatchObject({
      join_code: "SZ-JOIN-9999",
      player: { full_name: "Minor Joiner", dob: "2015-01-01" },
      guardian_name: "A Guardian",
      guardian_consent: true,
    });
  });

  it("forwards player_id — the per-slot claim link — to the usecase", async () => {
    joinSpy.mockResolvedValueOnce(fakeResult());
    const claimId = randomUUID();
    await joinRoute(
      req(URL_("acme", "cup"), joinBody({ player_id: claimId }), { "x-forwarded-for": "8.8.8.7" }),
      ctx("acme", "cup"),
    );
    expect(joinSpy.mock.calls[0]![1]).toMatchObject({ player_id: claimId });
  });

  // Consent-asymmetry follow-up (2026-08-28): privacy_consent is now
  // REQUIRED on PublicJoinRequest (schemas.ts), so a body omitting it fails
  // schema validation before ever reaching the usecase — the schema-level
  // half of the fix; joinTeamEntry's own 422 gate (registration-submit.
  // test.ts / join-consent.test.ts) is the other half, for a body that
  // passes the schema with an explicit `false`.
  it("400s when privacy_consent is missing from the body, without calling the usecase", async () => {
    const res = await joinRoute(
      req(URL_("acme", "cup"), joinBody({ privacy_consent: undefined }), { "x-forwarded-for": "8.8.8.8" }),
      ctx("acme", "cup"),
    );
    expect((await read(res)).status).toBe(400);
    expect(joinSpy).not.toHaveBeenCalled();
  });
});

describe("GET .../register/join — routing", () => {
  it("rate-limits on regjoinpreview:<ip> {max:5, windowSeconds:300}", async () => {
    previewSpy.mockResolvedValueOnce(fakePreview());
    await joinPreviewRoute(
      getReq(URL_("acme", "cup"), "SZ-JOIN-0001", { "x-forwarded-for": "8.8.9.1" }),
      ctx("acme", "cup"),
    );
    expect(rl.mock.calls).toEqual([["regjoinpreview:8.8.9.1", { max: 5, windowSeconds: 300 }]]);
  });

  it("returns previewJoinEntry's result verbatim at 200", async () => {
    const fake = fakePreview();
    previewSpy.mockResolvedValueOnce(fake);
    const res = await joinPreviewRoute(
      getReq(URL_("acme", "cup"), "SZ-JOIN-0001", { "x-forwarded-for": "8.8.9.2" }),
      ctx("acme", "cup"),
    );
    const { status, body } = await read(res);
    expect(status).toBe(200);
    expect(body.data).toEqual(fake);
  });

  it("forwards join_code from the query string to the usecase", async () => {
    previewSpy.mockResolvedValueOnce(fakePreview());
    await joinPreviewRoute(
      getReq(URL_("acme", "cup"), "SZ-JOIN-7777", { "x-forwarded-for": "8.8.9.3" }),
      ctx("acme", "cup"),
    );
    expect(previewSpy).toHaveBeenCalledWith("SZ-JOIN-7777");
  });

  it("surfaces a 404 from an unknown code without leaking anything extra", async () => {
    previewSpy.mockImplementationOnce(async () => {
      throw new HttpError(404, "This join link is not valid");
    });
    const res = await joinPreviewRoute(
      getReq(URL_("acme", "cup"), "SZ-DEAD-CODE", { "x-forwarded-for": "8.8.9.4" }),
      ctx("acme", "cup"),
    );
    expect((await read(res)).status).toBe(404);
  });

  it("400s when join_code is missing from the query string, without calling the usecase", async () => {
    const res = await joinPreviewRoute(
      getReq(URL_("acme", "cup"), null, { "x-forwarded-for": "8.8.9.5" }),
      ctx("acme", "cup"),
    );
    expect((await read(res)).status).toBe(400);
    expect(previewSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DB-backed — real Postgres, real usecase (the spy's default wraps it).
// Fixture shape copied from registration-submit.test.ts's own
// seedOrg/rig/seedSettings/teamRig (this repo has no shared fixtures module).
// ---------------------------------------------------------------------------

async function makeUser(name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`${name}-${randomUUID().slice(0, 8)}@test.local`}, ${name}, true)
    returning id`;
  return id;
}

async function seedOrg(): Promise<{ orgId: string; orgSlug: string; ownerId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const ownerId = await makeUser("owner");
  const orgSlug = "jt-org-" + suffix;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Join Org " + suffix}, ${orgSlug}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  const { setOrgPlan } = await import("@/lib/__tests__/_billing-group");
  await setOrgPlan(orgId, "pro");
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score',
            ${sql.json({ resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false })},
            true)
    on conflict do nothing`;
  return { orgId, orgSlug, ownerId };
}

const asOwner = (orgId: string, userId: string): AuthCtx => ({
  orgId,
  via: "session",
  userId,
  role: "owner",
  keyId: null,
});

async function rig(
  owner: AuthCtx,
): Promise<{ competition: { id: string; slug: string }; division: { id: string; slug: string } }> {
  const competition = await createCompetition(owner, {
    name: "Join Cup " + randomUUID().slice(0, 6),
    visibility: "public",
    branding: {},
    starts_on: "2026-09-15",
    ends_on: "2026-09-20",
  });
  const division = await createDivision(owner, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  return { competition, division };
}

async function seedTeamSettings(divisionId: string): Promise<void> {
  await sql`
    insert into registration_settings
      (division_id, enabled, entrant_kind, fee_cents, capacity, payment_method, approval, allow_free_agents)
    values (${divisionId}, true, 'team', 0, null, 'offline', 'auto', false)
    on conflict (division_id) do update set
      enabled = excluded.enabled, entrant_kind = excluded.entrant_kind, fee_cents = excluded.fee_cents`;
}

/** Real (unmocked) submitRegistrationGroup call — mints a genuine team entry
 *  with a join_code for the DB-backed join tests to join into. */
async function teamRig(): Promise<{
  orgSlug: string;
  competition: { id: string; slug: string };
  joinCode: string;
}> {
  const { orgId, orgSlug, ownerId } = await seedOrg();
  const owner = asOwner(orgId, ownerId);
  const { competition, division } = await rig(owner);
  await seedTeamSettings(division.id);
  const submitted = await submitRegistrationGroup(
    { orgSlug, compSlug: competition.slug },
    {
      contact: { name: "Captain", email: `cap-${randomUUID().slice(0, 8)}@test.local` },
      privacy_consent: true,
      entries: [
        { division_id: division.id, entrant_kind: "team", team_name: "Joinable Team", players: [], answers: {} },
      ],
    },
  );
  return { orgSlug, competition, joinCode: submitted.entries[0]!.join_code! };
}

describe.skipIf(!HAS_DB)("POST .../register/join — DB-backed", () => {
  it("an adult joiner persists a real registration_players row and links when signed in", async () => {
    const { orgSlug, competition, joinCode } = await teamRig();
    const sessionUserId = await makeUser("joiner");
    authState.userId = sessionUserId;

    const res = await joinRoute(
      req(
        URL_(orgSlug, competition.slug),
        {
          join_code: joinCode,
          player: { full_name: "New Joiner", dob: "1995-05-01" },
          privacy_consent: true,
        },
        { "x-forwarded-for": "8.8.8.20" },
      ),
      ctx(orgSlug, competition.slug),
    );
    const { status, body } = await read(res);
    expect(status).toBe(201);
    expect(body.data?.consent_status).toBe("granted");

    // `Envelope.data` is Record<string, unknown>, so the id has to be narrowed
    // before it can be interpolated: the sql tag rejects an `unknown`, and the
    // resulting error is a typecheck-only failure — vitest never typechecks
    // test files, so this passed its own suite while reddening `turbo typecheck`.
    const playerId = String(body.data!.player_id);
    const [row] = await sql<{ user_id: string | null; source: string }[]>`
      select user_id, source from registration_players where id = ${playerId}`;
    expect(row!.source).toBe("self_joined");
    expect(row!.user_id).toBe(sessionUserId);
  });

  it("claims a captain-entered row in place instead of duplicating it", async () => {
    const { orgSlug, competition, joinCode } = await teamRig();
    const [reg] = await sql<{ id: string }[]>`select id from registrations where join_code = ${joinCode}`;
    const [slot] = await sql<{ id: string }[]>`
      insert into registration_players (registration_id, full_name, source, consent_status)
      values (${reg!.id}, 'Pending Kid', 'captain_entered', 'pending') returning id`;

    const res = await joinRoute(
      req(
        URL_(orgSlug, competition.slug),
        {
          join_code: joinCode,
          player_id: slot!.id,
          player: { full_name: "Pending Kid", dob: "1996-02-02" },
          privacy_consent: true,
        },
        { "x-forwarded-for": "8.8.8.21" },
      ),
      ctx(orgSlug, competition.slug),
    );
    const { status, body } = await read(res);
    expect(status).toBe(201);
    expect(body.data?.consent_status).toBe("granted");
    expect(body.data?.player_id).toBe(slot!.id);

    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from registration_players where registration_id = ${reg!.id}`;
    expect(n).toBe(1); // claimed, not duplicated
  });
});

describe.skipIf(!HAS_DB)("GET .../register/join — DB-backed", () => {
  it("previews a real team's unclaimed slot by join_code and hides granted ones", async () => {
    const { orgSlug, competition, joinCode } = await teamRig();
    const [reg] = await sql<{ id: string }[]>`select id from registrations where join_code = ${joinCode}`;
    const [pending] = await sql<{ id: string }[]>`
      insert into registration_players (registration_id, full_name, source, consent_status)
      values (${reg!.id}, 'Pending Kid', 'captain_entered', 'pending') returning id`;
    await sql`
      insert into registration_players (registration_id, full_name, source, consent_status, consent_at)
      values (${reg!.id}, 'Already In', 'captain_entered', 'granted', now())`;

    const res = await joinPreviewRoute(
      getReq(URL_(orgSlug, competition.slug), joinCode, { "x-forwarded-for": "8.8.9.20" }),
      ctx(orgSlug, competition.slug),
    );
    const { status, body } = await read(res);
    expect(status).toBe(200);
    expect(body.data?.unclaimed_slots).toEqual([{ player_id: pending!.id, full_name: "Pending Kid" }]);
  });

  it("404-shapes an unknown code", async () => {
    const res = await joinPreviewRoute(
      getReq(URL_("acme", "cup"), "SZ-NEVER-EXISTED", { "x-forwarded-for": "8.8.9.21" }),
      ctx("acme", "cup"),
    );
    expect((await read(res)).status).toBe(404);
  });
});
