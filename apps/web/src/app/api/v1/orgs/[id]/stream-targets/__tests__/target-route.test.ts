// The Directory's per-destination door (spec §5.2): PATCH (rename / replace key) and DELETE (remove = an archive, D2)
// over the REAL handlers and the REAL session door. Only `requireUser` (who is signed in) is faked, exactly as
// stream-targets.test.ts does; `requireOrgAuth`'s role lookup runs against real org_members rows. What this file owns is
// the WIRING and the ENVELOPES — status, code, the extras, and that every extra on the wire is documented by the spec
// for that route × status. The use-case rules (every active state, the row lock, trimming) are stream-targets.test.ts's.
//
// Sport-agnostic on purpose (TEST-STRATEGY rule 6): a destination and its holder read no sport; the fixture is the
// rig's own generic one.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
import { buildOpenApiDocument } from "@/server/api-v1/openapi";
import { StreamTarget, StreamTargetRemoved } from "@/server/api-v1/schemas";
import { setRelayDriversForTest } from "@/server/relay/drivers";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import { sessionOnTarget } from "@/server/relay/__tests__/_session-rig";
import { createApiKey } from "@/server/usecases/api-keys";
import { startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";
import { seedOrg as seedSignedInOrg } from "@/server/usecases/__tests__/_seed";
import { createStreamTarget, listStreamTargets } from "@/server/usecases/stream-targets";
import { DELETE, PATCH } from "../[targetId]/route";

const HAS_DB = !!process.env.DATABASE_URL;

// A KEK of this file's own (stream-targets.test.ts precedent), put back afterwards; never printed. The relay drivers
// are the fakes: the route ticks each holder's lazy expiry before it reads "held", and a fresh passthrough session's
// expiry is `none`, so no provider is called — the fakes only stop a stray call from reaching a real one.
const savedKek = process.env.RELAY_KEK;
beforeAll(() => {
  process.env.RELAY_KEK = randomBytes(32).toString("hex");
  setRelayDriversForTest({ ingest: new FakeIngest(), runner: new FakeRunner() });
});
afterAll(async () => {
  setRelayDriversForTest(null);
  if (savedKek === undefined) delete process.env.RELAY_KEK;
  else process.env.RELAY_KEK = savedKek;
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

const key = (): string => "sk-" + randomBytes(24).toString("hex");
const ctx = (id: string, targetId: string) => ({ params: Promise.resolve({ id, targetId }) });
const url = (orgId: string, targetId: string) => `http://localhost/api/v1/orgs/${orgId}/stream-targets/${targetId}`;
const patch = (orgId: string, targetId: string, body: unknown, headers: HeadersInit = {}) =>
  PATCH(
    new Request(url(orgId, targetId), { method: "PATCH", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }),
    ctx(orgId, targetId),
  );
const del = (orgId: string, targetId: string, headers: HeadersInit = {}) =>
  DELETE(new Request(url(orgId, targetId), { method: "DELETE", headers }), ctx(orgId, targetId));

type Envelope = { ok: boolean; data?: unknown; error?: { code: string; message: string } & Record<string, unknown> };

/** A signed-in owner of a fresh org (real users + org_members rows) with one started fixture and one REAL sealed target. */
async function organiser() {
  const { auth } = await seedSignedInOrg("pro");
  authState.userId = auth.userId!;
  const { fixtureId } = await startedDivisionWithFixture(auth);
  const target = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "Court 1", streamKey: key() });
  return { auth, fixtureId, target };
}

type Op = { responses: Record<string, { content: { "application/json": { schema: { properties: { error: { properties?: Record<string, { properties?: Record<string, unknown> }> } } } } } }> };
const opOf = (method: "patch" | "delete"): Op =>
  (buildOpenApiDocument() as { paths: Record<string, Record<string, Op>> }).paths["/api/v1/orgs/{id}/stream-targets/{targetId}"]![method]!;

/** Every extra key a refusal carried on the wire — and one level down for an object extra — is a documented property of
 *  that route × status (routes.test.ts's wire ⊆ spec rule). Returns how many keys it checked. */
function documented(method: "patch" | "delete", status: number, error: Record<string, unknown>, label: string): number {
  const props = opOf(method).responses[String(status)]?.content["application/json"].schema.properties.error.properties ?? {};
  let checked = 0;
  for (const [k, v] of Object.entries(error)) {
    if (k === "code" || k === "message") continue;
    expect(props, `${label}: \`${k}\` is on the wire; the spec must document it`).toHaveProperty(k);
    checked++;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      for (const inner of Object.keys(v)) {
        expect(props[k]!.properties ?? {}, `${label}: \`${k}.${inner}\` is on the wire; the spec must document it`).toHaveProperty(inner);
        checked++;
      }
    }
  }
  return checked;
}

describe.skipIf(!HAS_DB)("/api/v1/orgs/{id}/stream-targets/{targetId} — the route", () => {
  it("PATCH {label} is 200 with the list's own row; PATCH {} and PATCH {label, streamKey} are 400 VALIDATION and change nothing", async () => {
    const o = await organiser();
    for (const body of [{}, { label: "x", streamKey: key() }]) {
      const bad = await patch(o.auth.orgId, o.target.id, body);
      expect(bad.status, JSON.stringify(Object.keys(body))).toBe(400);
      expect(((await bad.json()) as Envelope).error).toMatchObject({ code: "VALIDATION" });
    }
    expect((await listStreamTargets(o.auth, o.auth.orgId)).map((t) => t.label)).toEqual(["Court 1"]);
    const res = await patch(o.auth.orgId, o.target.id, { label: "Court 1 (main)" });
    expect(res.status).toBe(200);
    const row = StreamTarget.parse(((await res.json()) as Envelope).data);
    expect(row).toMatchObject({ id: o.target.id, label: "Court 1 (main)", keyHint: o.target.keyHint, inUse: null });
    expect((await listStreamTargets(o.auth, o.auth.orgId))).toEqual([row]);
  });

  it("DELETE is 200 {removed: true}, then 404 — and the removed destination is gone from the list (sequence)", async () => {
    const o = await organiser();
    const first = await del(o.auth.orgId, o.target.id);
    expect(first.status).toBe(200);
    expect(StreamTargetRemoved.parse(((await first.json()) as Envelope).data)).toEqual({ removed: true });
    expect(await listStreamTargets(o.auth, o.auth.orgId)).toEqual([]);
    const second = await del(o.auth.orgId, o.target.id);
    expect(second.status).toBe(404);
    expect(((await second.json()) as Envelope).error?.message).toBe("stream target not found");
  });

  it("a HELD destination: DELETE and a key replace are 409 TARGET_IN_USE naming the holding match (its fixture_no); a rename still lands; every extra is documented", async () => {
    const o = await organiser();
    await sessionOnTarget(o.auth.orgId, o.fixtureId, o.target.id, "live");
    const [{ fixture_no }] = await sql<{ fixture_no: number }[]>`select fixture_no from fixtures where id = ${o.fixtureId}`;
    let extras = 0;
    for (const [method, res] of [
      ["delete", await del(o.auth.orgId, o.target.id)],
      ["patch", await patch(o.auth.orgId, o.target.id, { streamKey: key() })],
    ] as const) {
      expect(res.status, method).toBe(409);
      const error = ((await res.json()) as Envelope).error!;
      expect(error.code, method).toBe("TARGET_IN_USE");
      expect(error.holder, method).toMatchObject({ fixtureId: o.fixtureId, matchNo: fixture_no, label: "Court 1", state: "live" });
      extras += documented(method, 409, error, `${method} TARGET_IN_USE`);
    }
    expect(extras, "anti-vacuity: the refusals carried extras").toBeGreaterThanOrEqual(2 * 7);
    expect((await listStreamTargets(o.auth, o.auth.orgId)).map((t) => t.id)).toEqual([o.target.id]);   // nothing archived
    const renamed = await patch(o.auth.orgId, o.target.id, { label: "Renamed while live" });
    expect(renamed.status).toBe(200);
  });

  it("PATCH a key ANOTHER destination holds is 409 DESTINATION_DUPLICATE naming it, and its `other` is documented", async () => {
    const o = await organiser();
    const taken = key();
    const other = await createStreamTarget(o.auth, o.auth.orgId, { kind: "youtube", label: "Court 2", streamKey: taken });
    const res = await patch(o.auth.orgId, o.target.id, { streamKey: taken });
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text, "the reply never echoes the key").not.toContain(taken);
    const error = (JSON.parse(text) as Envelope).error!;
    expect(error).toMatchObject({ code: "DESTINATION_DUPLICATE", other: { id: other.id, label: "Court 2" } });
    expect(documented("patch", 409, error, "patch DESTINATION_DUPLICATE")).toBe(3);   // other, other.id, other.label
  });

  it("an API key — even a manage-scoped one — is refused at BOTH doors (403, the route ban) and changes nothing", async () => {
    const o = await organiser();
    for (const feature of ["api.access", "api.write"]) {
      await sql`
        insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
        values (${o.auth.orgId}, ${feature}, true, 'test')
        on conflict (org_id, feature_key) do update set bool_value = true`;
    }
    const { secret } = await createApiKey(o.auth, { name: "integration", scopes: ["manage"] });
    const bearer = { authorization: `Bearer ${secret}` };
    let doors = 0;
    for (const [door, res] of [
      ["PATCH", await patch(o.auth.orgId, o.target.id, { label: "by key" }, bearer)],
      ["DELETE", await del(o.auth.orgId, o.target.id, bearer)],
    ] as const) {
      expect(res.status, door).toBe(403);
      const message = ((await res.json()) as Envelope).error?.message ?? "";
      expect(message, door).toMatch(/^API keys cannot access this endpoint/);
      expect(message, door).not.toMatch(/scope/);
      doors++;
    }
    expect(doors).toBe(2);
    expect((await listStreamTargets(o.auth, o.auth.orgId)).map((t) => t.label)).toEqual(["Court 1"]);
  });

  it("a malformed target id is 404 at both doors; another org's target is 404 (never a 409 that confirms it exists)", async () => {
    const o = await organiser();
    expect((await patch(o.auth.orgId, "not-a-uuid", { label: "x" })).status).toBe(404);
    expect((await del(o.auth.orgId, "not-a-uuid")).status).toBe(404);
    const foreign = await organiser();              // signs in as ANOTHER org's owner
    await sessionOnTarget(o.auth.orgId, o.fixtureId, o.target.id, "live");
    expect((await del(foreign.auth.orgId, o.target.id)).status).toBe(404);
    expect((await patch(foreign.auth.orgId, o.target.id, { streamKey: key() })).status).toBe(404);
  });
});
