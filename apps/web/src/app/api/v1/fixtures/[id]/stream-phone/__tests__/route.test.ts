// Capture QR v2 §9 (T9) over HTTP: `GET /api/v1/fixtures/{id}/stream-phone`, the panel's phone read model, driven through
// its REAL handler over a real session (`requireResourceAuth` unmocked; only the cookie door is faked one layer down, the
// stream-code routes test's pattern). stream-phone.test.ts proves the usecase; this file proves the ROUTE carries it:
//   - 200 {ok, data: StreamPhone} for the owner, parsed through the strict schema, with no secret on the wire;
//   - EVERY answer is `private, no-store` and varies on both credentials the door reads (the read names a phone and a
//     destination; it is per-organiser and live);
//   - editors only (§9): an API key is refused at the DOOR (NEVER_KEY_ROUTES), a VIEWER of the same org by the door's
//     write scope, a member of ANOTHER club by the door — and an admin is admitted (the positive pair);
//   - every refusal status is a documented response of the route in the OpenAPI spec.
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): nothing on this route reads the sport.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";

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
import { buildOpenApiDocument } from "@/server/api-v1/openapi";
import { StreamPhone } from "@/server/api-v1/schemas";
import { createApiKey } from "@/server/usecases/api-keys";
import { ensureStreamCode, saveStreamSettings } from "@/server/usecases/stream-codes";
import { createStreamTarget } from "@/server/usecases/stream-targets";
import { pairPresentPhone } from "@/server/relay/__tests__/_session-rig";
import { makeUser, seedOrg } from "@/server/usecases/__tests__/_seed";
import { startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";
import { GET as phoneRoute } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;

const savedKek = process.env.RELAY_KEK;
beforeAll(() => { process.env.RELAY_KEK = randomBytes(32).toString("hex"); });
afterAll(() => {
  if (savedKek === undefined) delete process.env.RELAY_KEK;
  else process.env.RELAY_KEK = savedKek;
});
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

const BASE = "https://test.local/api/v1";

interface Envelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code?: string; message: string; [k: string]: unknown };
}

async function override(orgId: string, key: string, value: boolean) {
  await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason) values (${orgId}, ${key}, ${value}, 'stream phone route')
            on conflict (org_id, feature_key) do update set bool_value = ${value}`;
  await invalidateOrgEntitlements(orgId);
}

/** A signed-in owner of a fresh org with one started fixture, the relay entitlement, its stream code, a paired phone and
 *  a destination pre-pick whose stream key is known here (so the wire can be searched for it). */
async function organiser() {
  const { auth } = await seedOrg("pro");
  authState.userId = auth.userId!;
  const { fixtureId } = await startedDivisionWithFixture(auth);
  await override(auth.orgId, "streaming.relay", true);
  const shown = await ensureStreamCode(auth, fixtureId);
  const streamKey = `yt-route-${randomUUID()}`;
  const target = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "Court", streamKey });
  await saveStreamSettings(auth, fixtureId, { targetId: target.id });
  const paired = await pairPresentPhone(fixtureId, { phone: `route-phone-${randomUUID()}` });
  return { auth, fixtureId, tok: shown.qr.tok, streamKey, target, paired };
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (fixtureId: string, headers: Record<string, string> = {}) =>
  phoneRoute(new Request(`${BASE}/fixtures/${fixtureId}/stream-phone`, { method: "GET", headers }), params(fixtureId));
async function read<T>(res: Response): Promise<{ status: number; body: Envelope<T> }> {
  return { status: res.status, body: (await res.json()) as Envelope<T> };
}
const documented = (): string[] =>
  Object.keys((buildOpenApiDocument() as { paths: Record<string, Record<string, { responses: Record<string, unknown> }>> })
    .paths["/api/v1/fixtures/{id}/stream-phone"]!.get!.responses);

async function member(orgId: string, role: "admin" | "viewer"): Promise<string> {
  const u = await makeUser(role);
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${u.id}, ${role})`;
  return u.id;
}

describe.skipIf(!HAS_DB)("GET …/stream-phone over HTTP", () => {
  it("the owner → 200 {ok, data}: the strict StreamPhone, the paired phone present, the pick named — and NO secret on the wire", async () => {
    const o = await organiser();
    const res = await get(o.fixtureId);
    const raw = await res.clone().text();
    const r = await read<StreamPhone>(res);
    expect(r.status).toBe(200);
    const data = StreamPhone.parse(r.body.data);
    expect(data).toEqual(r.body.data);
    expect(data.phone?.present).toBe(true);
    expect(data.code?.state).toBe("active");
    expect(data.destination, "the saved pick, and why (B8 review I-1)").toEqual({ id: o.target.id, label: "Court", source: "saved" });
    expect(data.session, "no session open (B8 review I-2)").toBeNull();
    let checked = 0;
    for (const secret of [o.tok, createHash("sha256").update(o.tok, "utf8").digest("hex"), o.streamKey]) {
      expect(raw.includes(secret), "a secret on the wire").toBe(false);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("every answer — the 200 and each refusal — is `private, no-store` and varies on Cookie and Authorization", async () => {
    const o = await organiser();
    await override(o.auth.orgId, "api.access", true);
    await override(o.auth.orgId, "api.write", true);
    const { secret } = await createApiKey(o.auth, { name: `phone-${randomUUID().slice(0, 6)}`, scopes: ["manage"] });
    const stranger = await seedOrg("pro");
    authState.userId = o.auth.userId!;
    const answers: [string, Response][] = [["200", await get(o.fixtureId)], ["key 403", await get(o.fixtureId, { authorization: `Bearer ${secret}` })]];
    authState.userId = stranger.auth.userId!;
    answers.push(["other club", await get(o.fixtureId)]);
    expect(answers.map(([, r]) => r.status)[0]).toBe(200);
    let checked = 0;
    for (const [label, r] of answers) {
      expect(r.headers.get("cache-control"), label).toMatch(/(^|,\s*)no-store(\s*,|$)/);
      expect(r.headers.get("cache-control"), label).toMatch(/(^|,\s*)private(\s*,|$)/);
      const vary = (r.headers.get("vary") ?? "").toLowerCase().split(/\s*,\s*/);
      expect(vary, label).toEqual(expect.arrayContaining(["cookie", "authorization"]));
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("an API key with every scope is refused at the DOOR (NEVER_KEY_ROUTES) — never the usecase's own session-only 403 — and the owner's session reaches the same door", async () => {
    const o = await organiser();
    await override(o.auth.orgId, "api.access", true);
    await override(o.auth.orgId, "api.write", true);
    const { secret } = await createApiKey(o.auth, { name: `phone-${randomUUID().slice(0, 6)}`, scopes: ["manage"] });
    const r = await read(await get(o.fixtureId, { authorization: `Bearer ${secret}` }));
    expect(r.status).toBe(403);
    expect(r.body.error?.message).toMatch(/cannot access this endpoint/);
    expect(documented()).toContain("403");
    authState.userId = o.auth.userId!;
    expect((await get(o.fixtureId)).status).toBe(200);
  });

  it("editors only: a VIEWER of the fixture's own org is refused 403 by the door; an ADMIN of the same org reads it (the positive pair)", async () => {
    const o = await organiser();
    authState.userId = await member(o.auth.orgId, "viewer");
    const refused = await read(await get(o.fixtureId));
    expect(refused.status).toBe(403);
    expect(refused.body.error?.message, "the door's sentence, never a usecase refusal sharing the status").toBe("Insufficient permissions");
    authState.userId = await member(o.auth.orgId, "admin");
    const admitted = await read<StreamPhone>(await get(o.fixtureId));
    expect(admitted.status).toBe(200);
    expect(StreamPhone.parse(admitted.body.data).phone?.present).toBe(true);
  });

  it("org scope: club B's owner cannot read club A's fixture — refused, with no phone or destination in the body; club A's owner can", async () => {
    const a = await organiser();
    const b = await organiser();
    authState.userId = b.auth.userId!;
    const res = await get(a.fixtureId);
    const raw = await res.clone().text();
    expect([401, 403, 404]).toContain(res.status);
    expect(raw.includes(a.paired.phone), "club A's phone id").toBe(false);
    expect(raw.includes(a.target.id), "club A's destination").toBe(false);
    for (const status of [String(res.status), "404"]) expect(documented(), `documents ${status}`).toContain(status);
    authState.userId = a.auth.userId!;
    expect((await get(a.fixtureId)).status).toBe(200);
  });
});
