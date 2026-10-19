// T16 — the organiser's two decision routes over HTTP:
//   POST /fixtures/{id}/external-play/resolve       settle the board
//   POST /fixtures/{id}/external-play/flags/close   "Let the game go on"
// Who may call each, that a refused caller writes nothing, and that the
// wire vocabulary is the usecase's. The usecases' own behaviour is
// external-play-resolve.test.ts's.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

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
// A door that hands the routes a user-less context — what an API key would be
// if it ever got past NEVER_KEY_ROUTES. Only one test sets it.
const door = vi.hoisted(() => ({ userless: false }));
vi.mock("@/server/api-v1/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/api-v1/auth")>();
  return {
    ...actual,
    requireResourceAuth: async (...args: Parameters<typeof actual.requireResourceAuth>) => {
      const auth = await actual.requireResourceAuth(...args);
      return door.userless ? { ...auth, via: "api_key" as const, userId: null, keyId: "k-test" } : auth;
    },
  };
});

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { createApiKey } from "@/server/usecases/api-keys";
import { POST as resolveRoute } from "@/app/api/v1/fixtures/[id]/external-play/resolve/route";
import { POST as closeRoute } from "@/app/api/v1/fixtures/[id]/external-play/flags/close/route";
import { CloseExternalPlayFlags, ResolveExternalPlay } from "@/server/api-v1/schemas";
import { RESOLVE_KINDS } from "@/server/usecases/external-play/resolve";
import { MAX_FLAGS_PER_CLOSE } from "@/server/usecases/external-play/flags";
import { holdForOrganiser } from "@/server/usecases/external-play/result";
import { seedOnlineChessRound, seedOwner } from "@/server/usecases/__tests__/_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://test.local/api/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
type Envelope = { ok: boolean; data?: unknown; error?: { code?: string; message: string } };
async function read(res: Response) {
  return { status: res.status, body: (await res.json()) as Envelope };
}
async function member(orgId: string, role: "admin" | "viewer"): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, locale)
    values (${`${role}-${randomUUID().slice(0, 8)}@t.local`}, ${role}, true, 'en') returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${u!.id}, ${role})`;
  return u!.id;
}

/** One opened round; each board held for a decision (not_started) with one
 *  open fair-play flag (a stand-in for reconcile's out_of_band_play). */
async function heldBoards(fixtures = 1) {
  const r = await seedOnlineChessRound({ fixtures });
  await sql`insert into stage_round_opens (stage_id, org_id, round_no, opened_at, opened_by)
            values (${r.stageId}, ${r.orgId}, 1, now(), ${r.ownerUserId})`;
  const flags = new Map<string, string>();
  for (const b of r.boards) {
    await sql`insert into fixture_external_play (fixture_id, org_id, status, scheduled_at_basis)
              values (${b.fixtureId}, ${r.orgId}, 'pending', now())`;
    await holdForOrganiser({ fixtureId: b.fixtureId, reason: "not_started" });
    const [f] = await sql<{ id: string }[]>`
      insert into fixture_play_flags (fixture_id, org_id, kind, note)
      values (${b.fixtureId}, ${r.orgId}, 'out_of_band_play', 'plies 3-4 (e7e5 g1f3); camera not required (policy off)')
      returning id`;
    flags.set(b.fixtureId, f!.id);
  }
  return { r, b: r.boards[0]!, flags };
}

const written = async (fixtureId: string) => ({
  events: (await sql`select 1 from score_events where fixture_id = ${fixtureId}`).length,
  closed: (await sql`select 1 from fixture_play_flags where fixture_id = ${fixtureId} and closed_at is not null`).length,
});

type Call = { name: string; send: (fixtureId: string, flagId: string, headers?: Record<string, string>) => Promise<Response> };
const CALLS: Call[] = [
  { name: "resolve", send: (f, _id, h) => resolveRoute(post(`/fixtures/${f}/external-play/resolve`, { kind: "home_wins" }, h), ctx(f)) },
  { name: "flags/close", send: (f, id, h) => closeRoute(post(`/fixtures/${f}/external-play/flags/close`, { ids: [id] }, h), ctx(f)) },
];

beforeEach(() => {
  authState.userId = "";
  door.userless = false;
});
afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

describe("the decision routes — the wire vocabulary is the usecase's", () => {
  it("resolve's kinds are RESOLVE_KINDS; a close names 1..MAX_FLAGS_PER_CLOSE flag ids", () => {
    expect([...ResolveExternalPlay.shape.kind.options]).toEqual([...RESOLVE_KINDS]);
    const id = randomUUID();
    expect(CloseExternalPlayFlags.safeParse({ ids: [] }).success, "the empty case").toBe(false);
    expect(CloseExternalPlayFlags.safeParse({ ids: [id] }).success).toBe(true);
    expect(CloseExternalPlayFlags.safeParse({ ids: Array.from({ length: MAX_FLAGS_PER_CLOSE }, () => randomUUID()) }).success).toBe(true);
    expect(CloseExternalPlayFlags.safeParse({ ids: Array.from({ length: MAX_FLAGS_PER_CLOSE + 1 }, () => randomUUID()) }).success).toBe(false);
    expect(CloseExternalPlayFlags.safeParse({ ids: ["not-a-uuid"] }).success).toBe(false);
  });
});

describe.skipIf(!HAS_DB)("the decision routes — who may call them", () => {
  it("another club's organiser and a viewer are refused by both routes; neither writes — an admin of the club may", async () => {
    const { r, b, flags } = await heldBoards();
    const stranger = await seedOwner();
    const viewer = await member(r.orgId, "viewer");
    const callers: [string, string, number][] = [
      ["other club's organiser", stranger.userId!, 401],
      ["viewer", viewer, 403],
    ];
    let checked = 0;
    for (const call of CALLS) {
      for (const [who, userId, status] of callers) {
        authState.userId = userId;
        expect((await call.send(b.fixtureId, flags.get(b.fixtureId)!)).status, `${call.name}, ${who}`).toBe(status);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: two routes × two callers").toBe(4);
    expect(await written(b.fixtureId)).toEqual({ events: 0, closed: 0 });
    authState.userId = await member(r.orgId, "admin");
    let allowed = 0;
    for (const call of [...CALLS].reverse()) {
      const res = await read(await call.send(b.fixtureId, flags.get(b.fixtureId)!));
      expect(res.status, call.name).toBe(200);
      allowed++;
    }
    expect(allowed).toBe(2);
    expect(await written(b.fixtureId)).toEqual({ events: 2, closed: 1 });
  });

  it("M3: auth comes before the body — a stranger with a MALFORMED body is 401, never a 400 that describes the schema", async () => {
    const { b } = await heldBoards();
    const stranger = await seedOwner();
    authState.userId = stranger.userId!;
    const routes: [string, (req: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>, string][] = [
      ["resolve", resolveRoute, `/fixtures/${b.fixtureId}/external-play/resolve`],
      ["flags/close", closeRoute, `/fixtures/${b.fixtureId}/external-play/flags/close`],
    ];
    const bodies: unknown[] = [{ kind: "teleport", extra: 1 }, { ids: [] }, "not json"];
    let checked = 0;
    for (const [name, route, path] of routes) {
      for (const body of bodies) {
        const res = await read(await route(post(path, body), ctx(b.fixtureId)));
        expect([res.status, res.body.error?.code], `${name} ${JSON.stringify(body)}`).toEqual([401, "UNAUTHENTICATED"]);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: two routes × three bodies").toBe(6);
    // The positive pair: the club's admin with the same malformed body IS told about the body.
    const { r: r2, b: b2 } = await heldBoards();
    authState.userId = await member(r2.orgId, "admin");
    const bad = await read(await resolveRoute(post(`/fixtures/${b2.fixtureId}/external-play/resolve`, { kind: "teleport" }), ctx(b2.fixtureId)));
    expect(bad.status, "an organiser's malformed body is a 400").toBe(400);
  });

  it("C: an org ADMIN who plays on the board is refused by both routes for THAT reason — and decides another board", async () => {
    const { r, b, flags } = await heldBoards(2);
    await sql`insert into org_members (org_id, user_id, role) values (${r.orgId}, ${b.home.userId}, 'admin')`;
    authState.userId = b.home.userId;
    const other = r.boards[1]!;
    let checked = 0;
    for (const call of CALLS) {
      const res = await read(await call.send(b.fixtureId, flags.get(b.fixtureId)!));
      expect([res.status, res.body.error?.code], call.name).toEqual([403, "ARBITER_PLAYS_THIS_BOARD"]);
      expect((await read(await call.send(other.fixtureId, flags.get(other.fixtureId)!))).status, `${call.name}: another board`).toBe(200);
      checked++;
    }
    expect(checked).toBe(2);
    expect(await written(b.fixtureId)).toEqual({ events: 0, closed: 0 });
  });

  it("an API key with manage scope is refused at the door by both routes (NEVER_KEY_ROUTES)", async () => {
    const { r, b, flags } = await heldBoards();
    for (const key of ["api.access", "api.write"]) {
      await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
                values (${r.orgId}, ${key}, true, 'decision routes') on conflict (org_id, feature_key) do update set bool_value = true`;
    }
    await invalidateOrgEntitlements(r.orgId);
    const { secret } = await createApiKey(r.owner, { name: `dec-${randomUUID().slice(0, 6)}`, scopes: ["manage"] });
    let checked = 0;
    for (const call of CALLS) {
      const res = await read(await call.send(b.fixtureId, flags.get(b.fixtureId)!, { authorization: `Bearer ${secret}` }));
      expect(res.status, call.name).toBe(403);
      expect(res.body.error?.message, call.name).toMatch(/cannot access this endpoint/);
      checked++;
    }
    expect(checked).toBe(2);
    expect(await written(b.fixtureId)).toEqual({ events: 0, closed: 0 });
  });

  it("defence in depth: a user-less context past the door is refused by each usecase, nothing written", async () => {
    const { r, b, flags } = await heldBoards();
    authState.userId = r.ownerUserId;
    door.userless = true;
    const codes: string[] = [];
    for (const call of CALLS) {
      const res = await read(await call.send(b.fixtureId, flags.get(b.fixtureId)!));
      expect(res.status, call.name).toBe(403);
      codes.push(res.body.error?.code ?? "");
    }
    expect(codes).toEqual(["ORGANISER_SESSION_REQUIRED", "ORGANISER_SESSION_REQUIRED"]);
    expect(await written(b.fixtureId)).toEqual({ events: 0, closed: 0 });
  });

  it("the organiser's answers over the wire: settled; the flags closed and how many remain", async () => {
    const { r, b, flags } = await heldBoards();
    authState.userId = r.ownerUserId;
    expect((await read(await CALLS[1]!.send(b.fixtureId, flags.get(b.fixtureId)!))).body.data).toEqual({ closed: 1, stillOpen: 0 });
    expect((await read(await CALLS[0]!.send(b.fixtureId, ""))).body.data).toEqual({ status: "finished" });
    const bad = await read(await resolveRoute(post(`/fixtures/${b.fixtureId}/external-play/resolve`, { kind: "home_forfeit" }), ctx(b.fixtureId)));
    expect([bad.status, bad.body.error?.code], "the retired vocabulary is refused").toEqual([400, "VALIDATION"]);
  });
});

