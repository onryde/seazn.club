// POST /stages/{id}/extend-checkin over HTTP (spec 2026-10-09 §3.2.2): who may add time to a whole round's open check-ins, the
// body's shape, and that a refused caller changes no deadline. The rule and the mixed-round counts are
// external-play-checkin-extend.test.ts's; this file is the door.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliverMessage } from "@/server/email-outbox/transport";
import { stubOutboxEnv, type SentInvite } from "@/server/usecases/__tests__/_invite-mail";
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
const mail = vi.hoisted(() => ({ sent: [] as SentInvite[], fail: new Set<string>() }));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  const h = await import("@/server/usecases/__tests__/_invite-mail");
  return { ...actual, externalPlayInviteEmail: h.renderInviteForTest };
});
// The invite is queued on the email outbox and sent after commit through its one network seam; the provider's answer is ours.
vi.mock("@/server/email-outbox/transport", async () => {
  const h = await import("@/server/usecases/__tests__/_invite-mail");
  return { deliver: (msg: DeliverMessage) => h.deliverForTest(mail, msg) };
});
beforeEach(() => stubOutboxEnv());
vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { CHECKIN_EXTEND_STEP_MINUTES } from "@/lib/checkin-extend";
import { createApiKey } from "@/server/usecases/api-keys";
import { openRound } from "@/server/usecases/external-play/open-round";
import { POST as extendRoundRoute } from "@/app/api/v1/stages/[id]/extend-checkin/route";
import { seedOnlineChessRound, seedOwner } from "@/server/usecases/__tests__/_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (stageId: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://test.local/api/v1/stages/${stageId}/extend-checkin`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
type Envelope = { ok: boolean; data?: unknown; error?: { code?: string; message: string } };
async function read(res: Response) {
  return { status: res.status, body: (await res.json()) as Envelope };
}
/** Total ms added across the round's boards, and the audit rows written. */
async function added(stageId: string) {
  const [row] = await sql<{ ms: string; audit: string }[]>`
    select coalesce(sum(ep.checkin_extra_ms), 0)::text as ms,
           (select count(*) from online_chess_audit a join fixtures f2 on f2.id = a.fixture_id
             where f2.stage_id = ${stageId} and a.kind = 'checkin_extend')::text as audit
      from fixture_external_play ep join fixtures f on f.id = ep.fixture_id where f.stage_id = ${stageId}`;
  return { ms: Number(row!.ms), audit: Number(row!.audit) };
}
async function member(orgId: string, role: "admin" | "viewer"): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, locale)
    values (${`${role}-${randomUUID().slice(0, 8)}@t.local`}, ${role}, true, 'en') returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${u!.id}, ${role})`;
  return u!.id;
}
async function openedNow(fixtures = 2) {
  const r = await seedOnlineChessRound({ roundNo: 1, fixtures });
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

describe.skipIf(!HAS_DB)("POST /stages/{id}/extend-checkin", () => {
  it("the organiser extends the round: 200 with the counts, every open board moved by one step, one audit row each", async () => {
    const r = await openedNow(2);
    authState.userId = r.ownerUserId;
    const res = await read(await extendRoundRoute(post(r.stageId, { roundNo: 1 }), ctx(r.stageId)));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      extended: 2,
      skipped: { closed: 0, gameStarted: 0, capReached: 0 },
      notOpenYet: 0,
      ownBoards: 0,
      failed: 0,
      addedMinutes: CHECKIN_EXTEND_STEP_MINUTES,
    });
    expect(await added(r.stageId)).toEqual({ ms: 2 * CHECKIN_EXTEND_STEP_MINUTES * 60_000, audit: 2 });
  });

  it("a player of the round, another club's organiser and a viewer are refused; none moves a deadline", async () => {
    const r = await openedNow(1);
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
      expect((await extendRoundRoute(post(r.stageId, { roundNo: 1 }), ctx(r.stageId))).status, who).toBe(status);
      expect(await added(r.stageId), who).toEqual({ ms: 0, audit: 0 });
      checked += 1;
    }
    expect(checked).toBe(3);
    authState.userId = await member(r.orgId, "admin");
    expect((await extendRoundRoute(post(r.stageId, { roundNo: 1 }), ctx(r.stageId))).status, "positive pair: an admin").toBe(200);
  });

  it("an API key with manage scope is refused at the door (NEVER_KEY_ROUTES)", async () => {
    const r = await openedNow(1);
    for (const key of ["api.access", "api.write"]) {
      await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
                values (${r.orgId}, ${key}, true, 'extend-checkin stage route') on conflict (org_id, feature_key) do update set bool_value = true`;
    }
    await invalidateOrgEntitlements(r.orgId);
    const { secret } = await createApiKey(r.owner, { name: `cxr-${randomUUID().slice(0, 6)}`, scopes: ["manage"] });
    const res = await read(await extendRoundRoute(post(r.stageId, { roundNo: 1 }, { authorization: `Bearer ${secret}` }), ctx(r.stageId)));
    expect(res.status).toBe(403);
    expect(res.body.error?.message).toMatch(/cannot access this endpoint/);
    expect(await added(r.stageId)).toEqual({ ms: 0, audit: 0 });
  });

  it("defence in depth: an API-key context past the door is refused before anything is written", async () => {
    const r = await openedNow(1);
    authState.userId = r.ownerUserId;
    door.userless = true;
    expect((await extendRoundRoute(post(r.stageId, { roundNo: 1 }), ctx(r.stageId))).status).toBe(403);
    expect(await added(r.stageId)).toEqual({ ms: 0, audit: 0 });
  });

  it("a body without a positive whole roundNo is refused before anything is written", async () => {
    const r = await openedNow(1);
    authState.userId = r.ownerUserId;
    let checked = 0;
    for (const body of [{}, { roundNo: 0 }, { roundNo: 1.5 }, { roundNo: "1" }, { roundNo: 1, extra: true }]) {
      const res = await extendRoundRoute(post(r.stageId, body), ctx(r.stageId));
      expect(res.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
      expect(res.status, JSON.stringify(body)).toBeLessThan(500);
      checked += 1;
    }
    expect(checked).toBe(5);
    expect(await added(r.stageId)).toEqual({ ms: 0, audit: 0 });
  });

  it("a round that has not been opened is a 409 ROUND_NOT_OPEN; a stage that does not exist is a 404", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    authState.userId = r.ownerUserId;
    const res = await read(await extendRoundRoute(post(r.stageId, { roundNo: 1 }), ctx(r.stageId)));
    expect([res.status, res.body.error?.code]).toEqual([409, "ROUND_NOT_OPEN"]);
    const ghost = randomUUID();
    expect((await extendRoundRoute(post(ghost, { roundNo: 1 }), ctx(ghost))).status).toBe(404);
  });
});
