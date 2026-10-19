// T19 — POST /stages/{id}/open-round and POST /fixtures/{id}/external-play/resend
// over HTTP: who may open (and resend), and that a refused caller writes no
// stamp and mails nobody. The usecase's own behaviour is open-round.test.ts's.
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
// A door that hands the route a user-less context — what an API key would be
// if it ever got past NEVER_KEY_ROUTES. Only the one test below sets it.
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
const mail = vi.hoisted(() => ({ sent: [] as string[] }));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendExternalPlayInviteEmail: vi.fn(async (to: string) => {
      mail.sent.push(to);
      return true;
    }),
  };
});

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { createApiKey } from "@/server/usecases/api-keys";
import { POST as openRoute } from "@/app/api/v1/stages/[id]/open-round/route";
import { POST as resendRoute } from "@/app/api/v1/fixtures/[id]/external-play/resend/route";
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
async function stamps(stageId: string) {
  return sql`select 1 from stage_round_opens where stage_id = ${stageId}`;
}
async function member(orgId: string, role: "admin" | "viewer"): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, locale)
    values (${`${role}-${randomUUID().slice(0, 8)}@t.local`}, ${role}, true, 'en') returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${u!.id}, ${role})`;
  return u!.id;
}

beforeEach(() => {
  mail.sent.length = 0;
  authState.userId = "";
  door.userless = false;
});
afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

describe.skipIf(!HAS_DB)("POST /stages/{id}/open-round", () => {
  it("the organiser opens the round: 200 with the result, a stamp, and the invites", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    authState.userId = r.ownerUserId;
    const res = await read(await openRoute(post(`/stages/${r.stageId}/open-round`, { roundNo: 1 }), ctx(r.stageId)));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ opened: true, invited: 2, skipped: [] });
    expect(await stamps(r.stageId)).toHaveLength(1);
    expect(mail.sent).toHaveLength(2);
  });

  it("a player of the round, another org's organiser and a viewer are refused; none writes a stamp or mails", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const stranger = await seedOwner();
    const viewer = await member(r.orgId, "viewer");
    const callers: [string, string, number][] = [
      ["player", r.boards[0]!.home.userId, 401],
      ["other org's organiser", stranger.userId!, 401],
      ["viewer", viewer, 403],
    ];
    let checked = 0;
    for (const [who, userId, status] of callers) {
      authState.userId = userId;
      const res = await read(await openRoute(post(`/stages/${r.stageId}/open-round`, { roundNo: 1 }), ctx(r.stageId)));
      expect(res.status, who).toBe(status);
      expect(await stamps(r.stageId), who).toHaveLength(0);
      expect(mail.sent, who).toHaveLength(0);
      checked++;
    }
    expect(checked).toBe(3);
    // positive pair: an admin of the same org may open it
    authState.userId = await member(r.orgId, "admin");
    expect((await openRoute(post(`/stages/${r.stageId}/open-round`, { roundNo: 1 }), ctx(r.stageId))).status).toBe(200);
  });

  it("an API key with manage scope is refused at the door (NEVER_KEY_ROUTES)", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    for (const key of ["api.access", "api.write"]) {
      await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
                values (${r.orgId}, ${key}, true, 'open-round route') on conflict (org_id, feature_key) do update set bool_value = true`;
    }
    await invalidateOrgEntitlements(r.orgId);
    const { secret } = await createApiKey(r.owner, { name: `or-${randomUUID().slice(0, 6)}`, scopes: ["manage"] });
    const res = await read(
      await openRoute(
        post(`/stages/${r.stageId}/open-round`, { roundNo: 1 }, { authorization: `Bearer ${secret}` }),
        ctx(r.stageId),
      ),
    );
    expect(res.status).toBe(403);
    expect(res.body.error?.message).toMatch(/cannot access this endpoint/);
    expect(await stamps(r.stageId)).toHaveLength(0);
    // ...and the resend, the same invite to the same people, likewise.
    const resend = await read(
      await resendRoute(
        post(`/fixtures/${r.boards[0]!.fixtureId}/external-play/resend`, {}, { authorization: `Bearer ${secret}` }),
        ctx(r.boards[0]!.fixtureId),
      ),
    );
    expect(resend.status).toBe(403);
    expect(resend.body.error?.message).toMatch(/cannot access this endpoint/);
    expect(mail.sent).toHaveLength(0);
  });

  it("defence in depth: a user-less context past the door is refused by the ROUTE, before the usecase", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    authState.userId = r.ownerUserId;
    door.userless = true;
    const res = await read(await openRoute(post(`/stages/${r.stageId}/open-round`, { roundNo: 1 }), ctx(r.stageId)));
    expect(res.status).toBe(403);
    // The route's own sentence — the usecase refuses with the same status and
    // code, so only the sentence tells which guard answered.
    expect(res.body.error?.message).toBe("Opening a round needs a signed-in organiser");
    expect(await stamps(r.stageId)).toHaveLength(0);
  });

  it("a body without a positive whole roundNo is refused before anything is written", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    authState.userId = r.ownerUserId;
    let checked = 0;
    for (const body of [{}, { roundNo: 0 }, { roundNo: 1.5 }, { roundNo: "1" }, { roundNo: 1, extra: true }]) {
      const res = await openRoute(post(`/stages/${r.stageId}/open-round`, body), ctx(r.stageId));
      expect(res.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
      expect(res.status, JSON.stringify(body)).toBeLessThan(500);
      checked++;
    }
    expect(checked).toBe(5);
    expect(await stamps(r.stageId)).toHaveLength(0);
  });
});

describe.skipIf(!HAS_DB)("POST /fixtures/{id}/external-play/resend", () => {
  it("resolves: the organiser re-sends after the open; a viewer is refused", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const f = r.boards[0]!.fixtureId;
    authState.userId = r.ownerUserId;
    await openRoute(post(`/stages/${r.stageId}/open-round`, { roundNo: 1 }), ctx(r.stageId));
    mail.sent.length = 0;

    authState.userId = await member(r.orgId, "viewer");
    expect((await resendRoute(post(`/fixtures/${f}/external-play/resend`, {}), ctx(f))).status).toBe(403);
    expect(mail.sent).toHaveLength(0);

    authState.userId = r.ownerUserId;
    const res = await read(await resendRoute(post(`/fixtures/${f}/external-play/resend`, {}), ctx(f)));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ emailed: 2 });
    expect(mail.sent).toHaveLength(2);
  });
});
