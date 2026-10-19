// POST /fixtures/{id}/external-play/extend-checkin over HTTP (spec 2026-10-09 §3.2.2): who may extend a board's check-in, and that a
// refused caller changes no deadline and writes no audit row. The rule's own behaviour (cap, the race, every reader) is
// external-play-checkin-extend.test.ts's; this file is the door.
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
// A door that hands the route an API-key context - what a key would be if it ever got past NEVER_KEY_ROUTES.
const door = vi.hoisted(() => ({ userless: false }));
vi.mock("@/server/api-v1/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/api-v1/auth")>();
  return {
    ...actual,
    requireResourceAuth: async (...args: Parameters<typeof actual.requireResourceAuth>) => {
      const auth = await actual.requireResourceAuth(...args);
      return door.userless ? { ...auth, via: "api_key" as const, userId: null, role: null, keyId: "k-test" } : auth;
    },
  };
});
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, sendExternalPlayInviteEmail: vi.fn(async () => true) };
});
vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { CHECKIN_EXTEND_MAX, CHECKIN_EXTEND_STEP_MINUTES } from "@/lib/checkin-extend";
import { createApiKey } from "@/server/usecases/api-keys";
import { openRound } from "@/server/usecases/external-play/open-round";
import { POST as extendRoute } from "@/app/api/v1/fixtures/[id]/external-play/extend-checkin/route";
import { seedOnlineChessRound, seedOwner } from "@/server/usecases/__tests__/_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (id: string, headers: Record<string, string> = {}) =>
  new Request(`https://test.local/api/v1/fixtures/${id}/external-play/extend-checkin`, { method: "POST", headers });
type Envelope = { ok: boolean; data?: unknown; error?: { code?: string; message: string } };
async function read(res: Response) {
  return { status: res.status, body: (await res.json()) as Envelope };
}
const extraOf = async (fixtureId: string) => {
  const [row] = await sql<{ ms: number; n: number }[]>`
    select checkin_extra_ms as ms, checkin_extensions as n from fixture_external_play where fixture_id = ${fixtureId}`;
  return row ?? null;
};
const auditCount = async (fixtureId: string) =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from online_chess_audit where fixture_id = ${fixtureId} and kind = 'checkin_extend'`)[0]!.n);
async function member(orgId: string, role: "admin" | "viewer"): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, locale)
    values (${`${role}-${randomUUID().slice(0, 8)}@t.local`}, ${role}, true, 'en') returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${u!.id}, ${role})`;
  return u!.id;
}
/** A round opened NOW through the product's own open (real clock: the route reads the real one), so board 1's check-in is open. */
async function openedNow() {
  const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
  await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId });
  return r;
}

beforeEach(() => {
  authState.userId = "";
  door.userless = false;
});
afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

describe.skipIf(!HAS_DB)("POST /fixtures/{id}/external-play/extend-checkin", () => {
  it("the organiser extends an open board: 200 with the new deadline, one press written, one audit row", async () => {
    const r = await openedNow();
    const f = r.boards[0]!.fixtureId;
    authState.userId = r.ownerUserId;
    const res = await read(await extendRoute(post(f), ctx(f)));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ fixtureId: f, extensions: 1, extensionsLeft: CHECKIN_EXTEND_MAX - 1, addedMinutes: CHECKIN_EXTEND_STEP_MINUTES });
    expect(Number.isNaN(Date.parse((res.body.data as { deadlineAt: string }).deadlineAt))).toBe(false);
    expect(await extraOf(f)).toEqual({ ms: CHECKIN_EXTEND_STEP_MINUTES * 60_000, n: 1 });
    expect(await auditCount(f)).toBe(1);
  });

  it("the sequence: the cap is a 409 with its own code over HTTP, and the refused press writes nothing", async () => {
    const r = await openedNow();
    const f = r.boards[0]!.fixtureId;
    authState.userId = r.ownerUserId;
    for (let i = 1; i <= CHECKIN_EXTEND_MAX; i++) expect((await extendRoute(post(f), ctx(f))).status, `press ${i}`).toBe(200);
    const over = await read(await extendRoute(post(f), ctx(f)));
    expect(over.status).toBe(409);
    expect(over.body.error?.code).toBe("CHECKIN_EXTEND_CAP");
    expect(await extraOf(f)).toEqual({ ms: CHECKIN_EXTEND_MAX * CHECKIN_EXTEND_STEP_MINUTES * 60_000, n: CHECKIN_EXTEND_MAX });
    expect(await auditCount(f)).toBe(CHECKIN_EXTEND_MAX);
  });

  it("a player of the board, another club's organiser and a viewer are refused; none changes a deadline or writes an audit row", async () => {
    const r = await openedNow();
    const f = r.boards[0]!.fixtureId;
    const stranger = await seedOwner();
    const viewer = await member(r.orgId, "viewer");
    const callers: [string, string, number][] = [
      ["player", r.boards[0]!.home.userId, 401],
      ["other club's organiser", stranger.userId!, 401],
      ["viewer", viewer, 403],
    ];
    let checked = 0;
    for (const [who, userId, status] of callers) {
      authState.userId = userId;
      expect((await extendRoute(post(f), ctx(f))).status, who).toBe(status);
      expect(await extraOf(f), who).toEqual({ ms: 0, n: 0 });
      expect(await auditCount(f), who).toBe(0);
      checked += 1;
    }
    expect(checked).toBe(3);
    // positive pair: an admin of the same club may extend it
    authState.userId = await member(r.orgId, "admin");
    expect((await extendRoute(post(f), ctx(f))).status).toBe(200);
    expect(await extraOf(f)).toEqual({ ms: CHECKIN_EXTEND_STEP_MINUTES * 60_000, n: 1 });
  });

  it("an API key with manage scope is refused at the door (NEVER_KEY_ROUTES) - the audit row names a user", async () => {
    const r = await openedNow();
    const f = r.boards[0]!.fixtureId;
    for (const key of ["api.access", "api.write"]) {
      await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
                values (${r.orgId}, ${key}, true, 'extend-checkin route') on conflict (org_id, feature_key) do update set bool_value = true`;
    }
    await invalidateOrgEntitlements(r.orgId);
    const { secret } = await createApiKey(r.owner, { name: `cx-${randomUUID().slice(0, 6)}`, scopes: ["manage"] });
    const res = await read(await extendRoute(post(f, { authorization: `Bearer ${secret}` }), ctx(f)));
    expect(res.status).toBe(403);
    expect(res.body.error?.message).toMatch(/cannot access this endpoint/);
    expect(await extraOf(f)).toEqual({ ms: 0, n: 0 });
    expect(await auditCount(f)).toBe(0);
  });

  it("defence in depth: an API-key context past the door is refused by the usecase, before anything is written", async () => {
    const r = await openedNow();
    const f = r.boards[0]!.fixtureId;
    authState.userId = r.ownerUserId;
    door.userless = true;
    const res = await read(await extendRoute(post(f), ctx(f)));
    expect(res.status).toBe(403);
    expect(await extraOf(f)).toEqual({ ms: 0, n: 0 });
    expect(await auditCount(f)).toBe(0);
  });

  it("a board whose round has not been opened is a 409 ROUND_NOT_OPEN; a board that does not exist is a 404", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const f = r.boards[0]!.fixtureId;
    authState.userId = r.ownerUserId;
    const notOpen = await read(await extendRoute(post(f), ctx(f)));
    expect(notOpen.status).toBe(409);
    expect(notOpen.body.error?.code).toBe("ROUND_NOT_OPEN");
    expect(await extraOf(f)).toBeNull();
    const ghost = randomUUID();
    expect((await extendRoute(post(ghost), ctx(ghost))).status).toBe(404);
  });
});
