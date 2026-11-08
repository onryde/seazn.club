// Swiss auto-advance, plan Task 4 — the two doors over HTTP: `PUT /api/v1/stages/{id}/auto-advance` (the switches) and
// `GET /api/v1/divisions/{id}/auto-advance` (the division's auto actions). The rules are auto-advance-switches.test.ts's; this
// file is the DOOR: who may call each (the real `requireResourceAuth`, a session faked only at the cookie, and real API
// keys through the real key-scope map), the body (strict, at least one key, booleans), and the envelope's shape.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const authState = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  const { AuthError } = await import("@/lib/errors");
  return {
    ...actual,
    requireUser: async () => {
      if (authState.userId === "") throw new AuthError("Not authenticated");
      return { id: authState.userId };
    },
    getCurrentUser: async () => (authState.userId === "" ? null : { id: authState.userId }),
    getActiveOrgId: async () => null,
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { AutoActionView, DivisionAutoActions, StageAutoAdvanceOut } from "@/server/api-v1/schemas";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createApiKey } from "@/server/usecases/api-keys";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createStages } from "@/server/usecases/stages";
import { GENERIC_CONFIG, seedOrg } from "@/server/usecases/__tests__/_seed";
import { PUT } from "@/app/api/v1/stages/[id]/auto-advance/route";
import { GET } from "@/app/api/v1/divisions/[id]/auto-advance/route";

const HAS_DB = !!process.env.DATABASE_URL;

type Envelope = { ok: boolean; data?: unknown; error?: { code?: string; message: string } };

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const put = (stageId: string, body: string, headers: Record<string, string> = {}) =>
  new Request(`https://test.local/api/v1/stages/${stageId}/auto-advance`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
const get = (divisionId: string, headers: Record<string, string> = {}) =>
  new Request(`https://test.local/api/v1/divisions/${divisionId}/auto-advance`, { method: "GET", headers });
async function read(res: Response) {
  return { status: res.status, body: (await res.json()) as Envelope };
}

interface Rig {
  owner: AuthCtx;
  orgId: string;
  divisionId: string;
  swissId: string;
}

async function rig(): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const tag = randomUUID().slice(0, 6);
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: `Auto door ${tag}`, visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, { name: "Open", slug: `open-${tag}`, sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
  const [swiss] = await createStages(auth, division.id, [{ seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 3 }, progression: null }]);
  return { owner: auth, orgId: auth.orgId, divisionId: division.id, swissId: swiss!.id };
}

async function member(orgId: string, role: "admin" | "viewer"): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, locale)
    values (${`${role}-${randomUUID().slice(0, 8)}@t.local`}, ${role}, true, 'en') returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${u!.id}, ${role})`;
  return u!.id;
}

async function stored(stageId: string): Promise<unknown> {
  const [s] = await sql<{ config: Record<string, unknown> }[]>`select config from stages where id = ${stageId}`;
  return s!.config.autoPair;
}

async function switchEvents(divisionId: string) {
  return sql<{ actor_id: string | null }[]>`
    select actor_id from division_events where division_id = ${divisionId} and type = 'stage_auto_advance_switched' order by seq`;
}

/** An API key of the given scope (the org is granted api.access and api.write, as a Pro-plus plan would). */
async function keyOf(r: Rig, scope: "read" | "manage"): Promise<string> {
  for (const key of ["api.access", "api.write"]) {
    await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
              values (${r.orgId}, ${key}, true, 'auto-advance route') on conflict (org_id, feature_key) do update set bool_value = true`;
  }
  await invalidateOrgEntitlements(r.orgId);
  const { secret } = await createApiKey(r.owner, { name: `aa-${scope}-${randomUUID().slice(0, 6)}`, scopes: [scope] });
  return secret;
}

beforeEach(() => {
  authState.userId = "";
});
afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

describe.skipIf(!HAS_DB)("PUT /stages/{id}/auto-advance", () => {
  it("401 without a session or a key; nothing written", async () => {
    const r = await rig();
    expect((await PUT(put(r.swissId, JSON.stringify({ autoPair: true })), ctx(r.swissId))).status).toBe(401);
    expect(await stored(r.swissId)).toBeUndefined();
  });

  it("a viewer is refused 403 and an admin is let through (the positive pair); the event names the person", async () => {
    const r = await rig();
    authState.userId = await member(r.orgId, "viewer");
    expect((await PUT(put(r.swissId, JSON.stringify({ autoPair: true })), ctx(r.swissId))).status, "viewer").toBe(403);
    expect(await stored(r.swissId), "the viewer wrote nothing").toBeUndefined();
    const admin = await member(r.orgId, "admin");
    authState.userId = admin;
    const res = await read(await PUT(put(r.swissId, JSON.stringify({ autoPair: true })), ctx(r.swissId)));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, data: { autoPair: true, autoConfirmHandoff: false, actions: [] } });
    expect(StageAutoAdvanceOut.parse(res.body.data)).toEqual(res.body.data);
    expect(await stored(r.swissId)).toBe(true);
    expect((await switchEvents(r.divisionId)).map((e) => e.actor_id)).toEqual([admin]);
  });

  it("400 on {}, on an unknown key and on a value that is not a boolean; nothing written", async () => {
    const r = await rig();
    authState.userId = r.owner.userId!;
    let checked = 0;
    for (const body of ["{}", JSON.stringify({ autoPair: true, autoPairs: true }), JSON.stringify({ autoPair: "true" }), "not json"]) {
      const res = await read(await PUT(put(r.swissId, body), ctx(r.swissId)));
      expect(res.status, body).toBe(400);
      expect(res.body.error?.code, body).toBe("VALIDATION");
      checked++;
    }
    expect(checked).toBe(4);
    expect(await stored(r.swissId)).toBeUndefined();
    expect(await switchEvents(r.divisionId)).toEqual([]);
  });

  it("a refusal keeps its name through the envelope: autoPair on a stage that is not Swiss is 422 AUTO_PAIR_NOT_SWISS", async () => {
    const r = await rig();
    const [league] = await createStages(r.owner, r.divisionId, [{ seq: 2, kind: "league", name: "League", config: { legs: 1 }, progression: null }]);
    authState.userId = r.owner.userId!;
    const res = await read(await PUT(put(league!.id, JSON.stringify({ autoPair: true })), ctx(league!.id)));
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe("AUTO_PAIR_NOT_SWISS");
  });

  it("an API key: a read key is refused the write and a manage key makes it (no person: actor null)", async () => {
    const r = await rig();
    const readKey = await keyOf(r, "read");
    const manageKey = await keyOf(r, "manage");
    const refused = await PUT(put(r.swissId, JSON.stringify({ autoPair: true }), { authorization: `Bearer ${readKey}` }), ctx(r.swissId));
    expect(refused.status, "read key").toBe(403);
    expect(await stored(r.swissId)).toBeUndefined();
    const made = await read(await PUT(put(r.swissId, JSON.stringify({ autoPair: true }), { authorization: `Bearer ${manageKey}` }), ctx(r.swissId)));
    expect(made.status, "manage key").toBe(200);
    expect(await stored(r.swissId)).toBe(true);
    expect((await switchEvents(r.divisionId)).map((e) => e.actor_id)).toEqual([null]);
  });
});

describe.skipIf(!HAS_DB)("GET /divisions/{id}/auto-advance", () => {
  it("401 without a session; a viewer reads it; the shape is { actions }", async () => {
    const r = await rig();
    expect((await GET(get(r.divisionId), ctx(r.divisionId))).status).toBe(401);
    authState.userId = await member(r.orgId, "viewer");
    const empty = await read(await GET(get(r.divisionId), ctx(r.divisionId)));
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ ok: true, data: { actions: [] } });
    // One live row, written as V497 shapes it (no arming before Task 5): served whole, every key the schema declares.
    const [row] = await sql<{ id: string }[]>`
      insert into stage_auto_actions (org_id, division_id, stage_id, kind, target_round, state, detail)
      values (${r.orgId}, ${r.divisionId}, ${r.swissId}, 'pair_round', 2, 'waiting', ${sql.json({ openBoards: [] })}) returning id`;
    const one = await read(await GET(get(r.divisionId), ctx(r.divisionId)));
    expect(one.status).toBe(200);
    const parsed = DivisionAutoActions.parse(one.body.data);
    expect(parsed.actions.map((a) => [a.id, a.kind, a.state, a.targetRound])).toEqual([[row!.id, "pair_round", "waiting", 2]]);
    const served = (one.body.data as { actions: Record<string, unknown>[] }).actions[0]!;
    const declared = Object.keys(AutoActionView.shape);
    expect(Object.keys(served).sort(), "every key served is declared, and every declared key is served").toEqual([...declared].sort());
    expect(declared.length).toBeGreaterThan(0);
  });

  it("a read key reads it", async () => {
    const r = await rig();
    const readKey = await keyOf(r, "read");
    const res = await read(await GET(get(r.divisionId, { authorization: `Bearer ${readKey}` }), ctx(r.divisionId)));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, data: { actions: [] } });
  });
});
