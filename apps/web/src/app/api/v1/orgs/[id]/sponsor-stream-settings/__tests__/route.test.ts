// R4 sponsors on stream, S12 - PUT /api/v1/orgs/{id}/sponsor-stream-settings (spec 2026-10-27 §5.1; ruling R19), over the REAL
// handler, the REAL session door and the REAL tables. Only `requireUser` (who is signed in) is faked, exactly as the destination
// routes' suite does; `requireOrgAuth`'s role lookup runs against real `org_members` rows.
//
// What this file owns is the WIRING and the ENVELOPES: who may write (the granted AND the denied pair), the 400 for a body the
// enum refuses, the 404 for another org's competition, the key ban, and that what the route writes is what S5's
// `resolveStreamSettings` reads back - org row, competition row, and a competition with no row falling through to the org's.
// The settings writer's own rules (one row per scope, the usecase's frequency check) are assign.test.ts's.
//
// Sport-agnostic on purpose (TEST-STRATEGY rule 6): a settings row reads no sport; the rotation's sport behaviour is
// sponsor-stream-seam.test.ts's.
import { afterAll, describe, expect, it, vi } from "vitest";

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
import { SPONSOR_FREQUENCIES } from "@/lib/sponsor-plan";
import { buildOpenApiDocument } from "@/server/api-v1/openapi";
import { createApiKey } from "@/server/usecases/api-keys";
import { createCompetition } from "@/server/usecases/competitions";
import { makeUser, seedOrg } from "@/server/usecases/__tests__/_seed";
import { resolveStreamSettings } from "@/server/sponsors/stream-settings";
import { PUT } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const put = (orgId: string, body: unknown, headers: HeadersInit = {}) =>
  PUT(
    new Request(`http://localhost/api/v1/orgs/${orgId}/sponsor-stream-settings`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    ctx(orgId),
  );

type Envelope = { ok: boolean; data?: unknown; error?: { code: string; message: string } };

/** A signed-in OWNER of a fresh org (real users + org_members rows) with one competition. */
async function organiser() {
  const { auth } = await seedOrg("pro");
  authState.userId = auth.userId!;
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Spring Cup", visibility: "public", branding: {} });
  return { auth, orgId: auth.orgId, competitionId: comp.id, ownerId: auth.userId! };
}
async function memberOf(orgId: string, role: "admin" | "viewer"): Promise<string> {
  const u = await makeUser(role);
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${u.id}, ${role})`;
  return u.id;
}
const rowsOf = (orgId: string) => sql<{ competition_id: string | null; enabled: boolean; frequency: string }[]>`
  select competition_id, enabled, frequency from sponsor_stream_settings where org_id = ${orgId} order by competition_id nulls first`;

describe.skipIf(!HAS_DB)("PUT /orgs/{id}/sponsor-stream-settings - the route", () => {
  it("org scope: 200 echoes the settings, S5's reader reads them back, and a second PUT updates the SAME row (sequence)", async () => {
    const o = await organiser();
    expect(await resolveStreamSettings(sql, o.orgId, null), "premise: a fresh org has no row").toBeNull();

    const first = await put(o.orgId, { competitionId: null, enabled: true, frequency: "light" });
    expect(first.status).toBe(200);
    expect(((await first.json()) as Envelope).data).toEqual({ competitionId: null, enabled: true, frequency: "light" });
    expect(await resolveStreamSettings(sql, o.orgId, null)).toEqual({ enabled: true, frequency: "light" });

    const second = await put(o.orgId, { competitionId: null, enabled: false, frequency: "busy" });
    expect(second.status).toBe(200);
    expect(await resolveStreamSettings(sql, o.orgId, null)).toEqual({ enabled: false, frequency: "busy" });
    expect(await rowsOf(o.orgId), "one row per scope: the second save updated it").toHaveLength(1);
  });

  it("the competition picker writes a COMPETITION row (the org row untouched); a competition with no row falls through to the org row; clearing the picker writes the org row", async () => {
    const o = await organiser();
    const other = await createCompetition(o.auth, { ends_on: "2030-12-31", name: "Autumn Cup", visibility: "public", branding: {} });
    expect((await put(o.orgId, { competitionId: null, enabled: true, frequency: "normal" })).status).toBe(200);

    // 1. the picker names a competition: that competition gets a row of its own, and ONLY it.
    const res = await put(o.orgId, { competitionId: o.competitionId, enabled: false, frequency: "busy" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Envelope).data).toEqual({ competitionId: o.competitionId, enabled: false, frequency: "busy" });
    expect(await rowsOf(o.orgId)).toEqual([
      { competition_id: null, enabled: true, frequency: "normal" },
      { competition_id: o.competitionId, enabled: false, frequency: "busy" },
    ]);

    // 2. S5's reader: the competition's row wins WHOLE (enabled included); another competition with no row falls through.
    expect(await resolveStreamSettings(sql, o.orgId, o.competitionId)).toEqual({ enabled: false, frequency: "busy" });
    expect(await resolveStreamSettings(sql, o.orgId, other.id), "no row of its own: the org's").toEqual({ enabled: true, frequency: "normal" });

    // 3. the picker cleared (null): the write goes to the org row, and the competition's row is not touched.
    expect((await put(o.orgId, { competitionId: null, enabled: true, frequency: "light" })).status).toBe(200);
    expect(await rowsOf(o.orgId)).toEqual([
      { competition_id: null, enabled: true, frequency: "light" },
      { competition_id: o.competitionId, enabled: false, frequency: "busy" },
    ]);
  });

  it("an unknown frequency is 400 VALIDATION (the route's enum) and writes nothing; so is every other malformed body (counted)", async () => {
    const o = await organiser();
    const bad: unknown[] = [
      { competitionId: null, enabled: true, frequency: "loud" },
      { competitionId: null, enabled: true, frequency: "" },
      { competitionId: null, enabled: true, frequency: "Normal" },
      { competitionId: null, enabled: true },
      { competitionId: null, frequency: "normal" },
      { competitionId: null, enabled: "yes", frequency: "normal" },
      { enabled: true, frequency: "normal" },
      { competitionId: "not-a-uuid", enabled: true, frequency: "normal" },
      "not json at all",
    ];
    let checked = 0;
    for (const body of bad) {
      const res = await put(o.orgId, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      const error = ((await res.json()) as Envelope).error;
      expect(error?.code, JSON.stringify(body)).toBe("VALIDATION");
      // The ROUTE's own refusal (zod: "Invalid input" + the issues), not the writer's second line of defence, whose message
      // would read "frequency must be one of ..." - so deleting the route's enum cannot hide behind the writer's check.
      expect(error?.message, JSON.stringify(body)).toBe(typeof body === "string" ? "Request body must be valid JSON" : "Invalid input");
      checked++;
    }
    const loud = await put(o.orgId, bad[0]);
    const issues = ((await loud.json()) as { error: { issues: { path: unknown[] }[] } }).error.issues;
    expect(issues.map((i) => i.path), "the issue names the field").toEqual([["frequency"]]);
    expect(checked).toBe(bad.length);
    expect(await rowsOf(o.orgId), "nothing was written").toEqual([]);

    // The positive pair: every declared position is accepted (the dial's own list, not retyped).
    let accepted = 0;
    for (const f of SPONSOR_FREQUENCIES) {
      expect((await put(o.orgId, { competitionId: null, enabled: true, frequency: f })).status, f).toBe(200);
      accepted++;
    }
    expect(accepted).toBe(3);
  });

  it("R19, the granted AND the denied pair: an owner and an admin write; a viewer is 403 and nothing is written", async () => {
    const o = await organiser();
    const body = { competitionId: null, enabled: true, frequency: "busy" };

    const adminId = await memberOf(o.orgId, "admin");
    const viewerId = await memberOf(o.orgId, "viewer");

    authState.userId = viewerId;
    const denied = await put(o.orgId, body);
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as Envelope).error?.message).toBe("Insufficient permissions");
    expect(await rowsOf(o.orgId), "the viewer wrote nothing").toEqual([]);

    let granted = 0;
    for (const [who, userId] of [["admin", adminId], ["owner", o.ownerId]] as const) {
      authState.userId = userId;
      const res = await put(o.orgId, { ...body, frequency: who === "admin" ? "light" : "busy" });
      expect(res.status, who).toBe(200);
      granted++;
    }
    expect(granted).toBe(2);
    expect(await rowsOf(o.orgId)).toHaveLength(1);
  });

  // Final review D2: the door runs BEFORE the body is read, so a caller who may not write learns nothing about the body's
  // shape (a 400 would tell a viewer, or a stranger, what the route accepts).
  it("the door before the body: a viewer's MALFORMED body is 403, a non-member's 401 - never the 400 an editor gets for it (count reported)", async () => {
    const o = await organiser();
    const viewerId = await memberOf(o.orgId, "viewer");
    const bad: unknown[] = [{ competitionId: null, enabled: true, frequency: "constant" }, "{not json", {}];
    let checked = 0;
    for (const body of bad) {
      authState.userId = viewerId;
      const viewer = await put(o.orgId, body);
      expect(viewer.status, `viewer ${JSON.stringify(body)}`).toBe(403);
      expect(((await viewer.json()) as Envelope).error?.message).toBe("Insufficient permissions");
      authState.userId = (await makeUser("stranger")).id;
      expect((await put(o.orgId, body)).status, `non-member ${JSON.stringify(body)}`).toBe(401);
      authState.userId = o.ownerId;
      expect((await put(o.orgId, body)).status, `the owner's own 400 for ${JSON.stringify(body)} (the positive pair)`).toBe(400);
      checked++;
    }
    expect(checked).toBe(bad.length);
    expect(await rowsOf(o.orgId), "nobody wrote").toEqual([]);
  });

  it("another org: a non-member is refused at the door (401, like every org route) and writes nothing; another org's COMPETITION is 404 and writes nothing; a malformed org id is 404", async () => {
    const o = await organiser();
    const foreign = await organiser();             // signs in as ANOTHER org's owner
    expect(foreign.orgId).not.toBe(o.orgId);

    const nonMember = await put(o.orgId, { competitionId: null, enabled: true, frequency: "busy" });
    expect(nonMember.status).toBe(401);
    expect(await rowsOf(o.orgId)).toEqual([]);

    // The foreign owner, in their OWN org, naming the first org's competition: the writer's tenant check, not the door's.
    const crossCompetition = await put(foreign.orgId, { competitionId: o.competitionId, enabled: true, frequency: "busy" });
    expect(crossCompetition.status).toBe(404);
    expect(((await crossCompetition.json()) as Envelope).error?.message).toBe("competition not found");
    expect(await rowsOf(foreign.orgId)).toEqual([]);
    expect(await rowsOf(o.orgId)).toEqual([]);

    expect((await put("not-a-uuid", { competitionId: null, enabled: true, frequency: "busy" })).status).toBe(404);
  });

  it("an API key - even a manage-scoped one - is refused (403, the route ban) and writes nothing", async () => {
    const o = await organiser();
    for (const feature of ["api.access", "api.write"]) {
      await sql`
        insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
        values (${o.orgId}, ${feature}, true, 'test')
        on conflict (org_id, feature_key) do update set bool_value = true`;
    }
    const { secret } = await createApiKey(o.auth, { name: "integration", scopes: ["manage"] });
    const res = await put(o.orgId, { competitionId: null, enabled: true, frequency: "busy" }, { authorization: `Bearer ${secret}` });
    expect(res.status).toBe(403);
    expect(((await res.json()) as Envelope).error?.message).toMatch(/^API keys cannot access this endpoint/);
    expect(await rowsOf(o.orgId)).toEqual([]);
  });
});

describe("the route is in the OpenAPI document (no DB)", () => {
  it("PUT /orgs/{id}/sponsor-stream-settings is documented with the dial's own enum", () => {
    const doc = buildOpenApiDocument() as unknown as {
      paths: Record<string, Record<string, { requestBody?: { content: { "application/json": { schema: { properties: Record<string, { enum?: string[] }> } } } } }>>;
    };
    const op = doc.paths["/api/v1/orgs/{id}/sponsor-stream-settings"]?.put;
    expect(op, "the operation exists").toBeDefined();
    const props = op!.requestBody!.content["application/json"].schema.properties;
    expect(Object.keys(props).sort()).toEqual(["competitionId", "enabled", "frequency"]);
    expect(props.frequency!.enum, "the enum is the planner's list").toEqual([...SPONSOR_FREQUENCIES]);
  });
});
