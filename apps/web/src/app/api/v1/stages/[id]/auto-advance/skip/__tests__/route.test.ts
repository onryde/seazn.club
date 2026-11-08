// Swiss auto-advance, plan Task 6 — the Skip door over HTTP: `POST /api/v1/stages/{id}/auto-advance/skip`
// `{ kind, round }` (D33: the skip names its target). The rules are auto-advance-manual.test.ts's (armed by real results
// there); this file is the DOOR: who may call it (the real `requireResourceAuth`, a session faked only at the cookie, real
// API keys through the real key-scope map), the body (strict, one known kind, the round pair_round skips), the refusals'
// names through the envelope, and the answer's shape. The live row each case skips is written as V497 shapes it (SQL), since
// what armed it is not this door's business; so is the lease, which stands in for Task 8's claim.
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
import { AutoActionView } from "@/server/api-v1/schemas";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createApiKey } from "@/server/usecases/api-keys";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createStages } from "@/server/usecases/stages";
import { GENERIC_CONFIG, seedOrg } from "@/server/usecases/__tests__/_seed";
import { POST } from "@/app/api/v1/stages/[id]/auto-advance/skip/route";

const HAS_DB = !!process.env.DATABASE_URL;

type Envelope = { ok: boolean; data?: unknown; error?: { code?: string; message: string } };

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const skip = (stageId: string, body: string, headers: Record<string, string> = {}) =>
  new Request(`https://test.local/api/v1/stages/${stageId}/auto-advance/skip`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
/** The banner's Skip on the row it shows: pair_round 2 (`armed`). */
const PAIR = JSON.stringify({ kind: "pair_round", round: 2 });
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
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: `Skip door ${tag}`, visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, { name: "Open", slug: `open-${tag}`, sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
  const [swiss] = await createStages(auth, division.id, [{ seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 3, autoPair: true }, progression: null }]);
  return { owner: auth, orgId: auth.orgId, divisionId: division.id, swissId: swiss!.id };
}

/** A live pending pair_round 2, as the arming writes it. */
async function armed(r: Rig): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into stage_auto_actions (org_id, division_id, stage_id, kind, target_round, state, due_at)
    values (${r.orgId}, ${r.divisionId}, ${r.swissId}, 'pair_round', 2, 'pending', now() + interval '60 seconds') returning id`;
  return row!.id;
}

async function stateOf(id: string): Promise<{ state: string; result: unknown }> {
  const [row] = await sql<{ state: string; result: unknown }[]>`select state, result from stage_auto_actions where id = ${id}`;
  return row!;
}

async function member(orgId: string, role: "admin" | "viewer"): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, locale)
    values (${`${role}-${randomUUID().slice(0, 8)}@t.local`}, ${role}, true, 'en') returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${u!.id}, ${role})`;
  return u!.id;
}

/** An API key of the given scope (the org is granted api.access and api.write, as a Pro-plus plan would). */
async function keyOf(r: Rig, scope: "read" | "manage"): Promise<string> {
  for (const key of ["api.access", "api.write"]) {
    await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
              values (${r.orgId}, ${key}, true, 'auto-advance skip route') on conflict (org_id, feature_key) do update set bool_value = true`;
  }
  await invalidateOrgEntitlements(r.orgId);
  const { secret } = await createApiKey(r.owner, { name: `aa-skip-${scope}-${randomUUID().slice(0, 6)}`, scopes: [scope] });
  return secret;
}

const PENDING = { state: "pending", result: null };
const SKIPPED_BY_PERSON = { state: "cancelled", result: { reason: "skip", by: "person" } };

beforeEach(() => {
  authState.userId = "";
});
afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

describe.skipIf(!HAS_DB)("POST /stages/{id}/auto-advance/skip", () => {
  it("401 without a session or a key; nothing written", async () => {
    const r = await rig();
    const id = await armed(r);
    expect((await POST(skip(r.swissId, PAIR), ctx(r.swissId))).status).toBe(401);
    expect(await stateOf(id)).toEqual(PENDING);
  });

  it("a viewer is refused 403 and an admin is let through (the positive pair): the row comes back skipped", async () => {
    const r = await rig();
    const id = await armed(r);
    authState.userId = await member(r.orgId, "viewer");
    expect((await POST(skip(r.swissId, PAIR), ctx(r.swissId))).status, "viewer").toBe(403);
    expect(await stateOf(id), "the viewer wrote nothing").toEqual(PENDING);
    authState.userId = await member(r.orgId, "admin");
    const res = await read(await POST(skip(r.swissId, PAIR), ctx(r.swissId)));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, data: { id, stageId: r.swissId, kind: "pair_round", state: "cancelled", targetRound: 2 } });
    const served = res.body.data as Record<string, unknown>;
    expect(AutoActionView.parse(served)).toEqual(served);
    expect(Object.keys(served).sort(), "every key declared is served").toEqual(Object.keys(AutoActionView.shape).sort());
    expect(await stateOf(id)).toEqual(SKIPPED_BY_PERSON);
  });

  it("400 on {}, on an unknown kind, on a pair_round with no round or a round that is no round, on an extra key and on a body that is not JSON; nothing written", async () => {
    const r = await rig();
    const id = await armed(r);
    authState.userId = r.owner.userId!;
    const bodies = [
      "{}",
      JSON.stringify({ kind: "pair" }),
      JSON.stringify({ kind: "pair_round" }),
      JSON.stringify({ kind: "pair_round", round: 0 }),
      JSON.stringify({ kind: "pair_round", round: 2.5 }),
      JSON.stringify({ kind: "pair_round", round: 2, stage: "x" }),
      "not json",
    ];
    let checked = 0;
    for (const body of bodies) {
      const res = await read(await POST(skip(r.swissId, body), ctx(r.swissId)));
      expect(res.status, body).toBe(400);
      expect(res.body.error?.code, body).toBe("VALIDATION");
      checked++;
    }
    expect(checked).toBe(bodies.length);
    expect(checked).toBe(7);
    expect(await stateOf(id)).toEqual(PENDING);
  });

  it("a stale target is 409 AUTO_ADVANCE_TARGET_MOVED and a row being fired is 409 AUTO_ADVANCE_FIRING, through the envelope; the right round on a free row skips", async () => {
    const r = await rig();
    const id = await armed(r);
    authState.userId = r.owner.userId!;
    const moved = await read(await POST(skip(r.swissId, JSON.stringify({ kind: "pair_round", round: 1 })), ctx(r.swissId)));
    expect([moved.status, moved.body.error?.code], "a Skip of round 1 when round 2 counts down").toEqual([409, "AUTO_ADVANCE_TARGET_MOVED"]);
    expect(await stateOf(id)).toEqual(PENDING);
    await sql`update stage_auto_actions set lease_until = now() + interval '2 minutes' where id = ${id}`;
    const firing = await read(await POST(skip(r.swissId, PAIR), ctx(r.swissId)));
    expect([firing.status, firing.body.error?.code], "the clock holds the row").toEqual([409, "AUTO_ADVANCE_FIRING"]);
    expect(await stateOf(id)).toEqual(PENDING);
    // The positive pair: the lease lapsed, the same body skips.
    await sql`update stage_auto_actions set lease_until = now() - interval '1 second' where id = ${id}`;
    expect((await POST(skip(r.swissId, PAIR), ctx(r.swissId))).status).toBe(200);
    expect(await stateOf(id)).toEqual(SKIPPED_BY_PERSON);
  });

  it("refusals keep their names through the envelope: confirm 422 AUTO_ADVANCE_CONFIRM_NOT_SKIPPABLE; nothing live 409 AUTO_ADVANCE_NOTHING_TO_SKIP", async () => {
    const r = await rig();
    authState.userId = r.owner.userId!;
    // The empty case first: nothing armed, nothing to skip.
    const none = await read(await POST(skip(r.swissId, PAIR), ctx(r.swissId)));
    expect([none.status, none.body.error?.code]).toEqual([409, "AUTO_ADVANCE_NOTHING_TO_SKIP"]);
    const id = await armed(r);
    const confirm = await read(await POST(skip(r.swissId, JSON.stringify({ kind: "confirm_handoff" })), ctx(r.swissId)));
    expect([confirm.status, confirm.body.error?.code]).toEqual([422, "AUTO_ADVANCE_CONFIRM_NOT_SKIPPABLE"]);
    expect(await stateOf(id)).toEqual(PENDING);
    expect((await POST(skip(r.swissId, PAIR), ctx(r.swissId))).status, "the first skip").toBe(200);
    const twice = await read(await POST(skip(r.swissId, PAIR), ctx(r.swissId)));
    expect([twice.status, twice.body.error?.code], "the second skip").toEqual([409, "AUTO_ADVANCE_NOTHING_TO_SKIP"]);
  });

  it("an API key: a read key is refused and a manage key skips", async () => {
    const r = await rig();
    const id = await armed(r);
    const readKey = await keyOf(r, "read");
    const manageKey = await keyOf(r, "manage");
    expect((await POST(skip(r.swissId, PAIR, { authorization: `Bearer ${readKey}` }), ctx(r.swissId))).status, "read key").toBe(403);
    expect(await stateOf(id)).toEqual(PENDING);
    expect((await POST(skip(r.swissId, PAIR, { authorization: `Bearer ${manageKey}` }), ctx(r.swissId))).status, "manage key").toBe(200);
    expect(await stateOf(id)).toEqual(SKIPPED_BY_PERSON);
  });

  it("another organisation's organiser and its manage key are refused 401 and skip nothing (this org's owner is let through)", async () => {
    const r = await rig();
    const other = await rig();
    const id = await armed(r);
    const otherKey = await keyOf(other, "manage");
    const callers: [string, () => Promise<Response>][] = [
      ["another org's organiser", async () => {
        authState.userId = other.owner.userId!;
        return POST(skip(r.swissId, PAIR), ctx(r.swissId));
      }],
      ["another org's manage key", async () => {
        authState.userId = "";
        return POST(skip(r.swissId, PAIR, { authorization: `Bearer ${otherKey}` }), ctx(r.swissId));
      }],
    ];
    let checked = 0;
    for (const [who, call] of callers) {
      expect((await call()).status, who).toBe(401);
      expect(await stateOf(id), who).toEqual(PENDING);
      checked++;
    }
    expect(checked).toBe(callers.length);
    // The positive pair: the same body from this org's own owner goes through.
    authState.userId = r.owner.userId!;
    expect((await POST(skip(r.swissId, PAIR), ctx(r.swissId))).status).toBe(200);
    expect(await stateOf(id)).toEqual(SKIPPED_BY_PERSON);
  });
});
