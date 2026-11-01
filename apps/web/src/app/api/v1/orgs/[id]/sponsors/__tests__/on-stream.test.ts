// R4 sponsors on stream, S12 - ticking a sponsor onto the stream: `PATCH /orgs/{id}/sponsors/{sponsorId}` with `on_stream`
// (controller row 30: snake_case, because `patchSponsor` writes the body's keys as columns) over the REAL handlers, the REAL
// session door and the REAL tables, and the first-tick rule (ruling R12 / spec D12): ticking the FIRST sponsor of an organisation
// that has no settings row creates its org row, enabled, at Normal.
//
// The sequence this file pins (R12), each step reading the settings back through S5's `resolveStreamSettings`:
//   1. tick the first sponsor            -> the org row exists: enabled, Normal
//   2. untick it                         -> the row stays
//   3. tick it again                     -> still ONE row
//   4. a competition with no row         -> falls through to the org row
// plus the cases around it: an existing row is never overwritten by a tick; a patch that is not a tick creates nothing; two
// first ticks racing leave one row; `on_stream` is PATCH-ONLY (a created sponsor starts false whatever the body says); and who
// may tick (R19: editors; the granted AND the denied pair), another org's sponsor (404 and no settings row for the caller).
//
// Sport-agnostic on purpose (TEST-STRATEGY rule 6): a tick reads no sport. What the rotation then does with the tick, in two
// sports, is sponsor-stream-seam.test.ts's.
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
import { CreateSponsor, PatchSponsor, Sponsor } from "@/server/api-v1/schemas";
import { CreateSponsorInput, PatchSponsorInput } from "@/server/usecases/sponsors";
import { createCompetition } from "@/server/usecases/competitions";
import { makeUser, seedOrg } from "@/server/usecases/__tests__/_seed";
import { resolveStreamSettings } from "@/server/sponsors/stream-settings";
import { PUT as putSettings } from "../../sponsor-stream-settings/route";
import { GET as listRoute, POST as createRoute } from "../route";
import { PATCH } from "../[sponsorId]/route";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

type Envelope = { ok: boolean; data?: unknown; error?: { code: string; message: string } };
const base = (orgId: string) => `http://localhost/api/v1/orgs/${orgId}/sponsors`;
const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const patch = (orgId: string, sponsorId: string, body: unknown) =>
  PATCH(new Request(`${base(orgId)}/${sponsorId}`, json("PATCH", body)), { params: Promise.resolve({ id: orgId, sponsorId }) });
const create = (orgId: string, body: unknown) => createRoute(new Request(base(orgId), json("POST", body)), { params: Promise.resolve({ id: orgId }) });
const list = (orgId: string) => listRoute(new Request(base(orgId)), { params: Promise.resolve({ id: orgId }) });
const putDial = (orgId: string, body: unknown) =>
  putSettings(new Request(`http://localhost/api/v1/orgs/${orgId}/sponsor-stream-settings`, json("PUT", body)), { params: Promise.resolve({ id: orgId }) });

async function organiser() {
  const { auth } = await seedOrg("pro");
  authState.userId = auth.userId!;
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Spring Cup", visibility: "public", branding: {} });
  return { auth, orgId: auth.orgId, competitionId: comp.id, ownerId: auth.userId! };
}
/** A sponsor made through the REAL create route (so its `on_stream` is whatever the default is, not a seed's). */
async function sponsorOf(orgId: string, name: string): Promise<string> {
  const res = await create(orgId, { name });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}
async function memberOf(orgId: string, role: "admin" | "viewer"): Promise<string> {
  const u = await makeUser(role);
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${u.id}, ${role})`;
  return u.id;
}
const settingsRows = (orgId: string) => sql<{ competition_id: string | null; enabled: boolean; frequency: string; updated_by: string | null }[]>`
  select competition_id, enabled, frequency, updated_by from sponsor_stream_settings where org_id = ${orgId} order by competition_id nulls first`;
const tickOf = async (sponsorId: string): Promise<boolean> =>
  (await sql<{ on_stream: boolean }[]>`select on_stream from sponsors where id = ${sponsorId}`)[0]!.on_stream;

describe("on_stream is PATCH-only: the schemas (no DB)", () => {
  it("the patch schemas carry it; the create schemas do not (the usecase's and the OpenAPI document's, both)", () => {
    expect(Object.keys(PatchSponsorInput.shape)).toContain("on_stream");
    expect(Object.keys(PatchSponsor.shape)).toContain("on_stream");
    expect(Object.keys(CreateSponsorInput.shape)).not.toContain("on_stream");
    expect(Object.keys(CreateSponsor.shape)).not.toContain("on_stream");
    // The response schema documents it as always present.
    expect(Object.keys(Sponsor.shape)).toContain("on_stream");
  });

  it("a patch carries ONLY what it names: no create default (tier 'partner', status 'active') fills an omitted field - and create still defaults them", () => {
    // zod 4's `.partial()` over a `.default()` field FILLS it when omitted: a patch derived from the create schema rewrote the
    // sponsor's tier and status on every PATCH that did not name them. Found on the first tick (R4 S12).
    for (const [name, schema] of [["usecase PatchSponsorInput", PatchSponsorInput], ["api-v1 PatchSponsor", PatchSponsor]] as const) {
      expect(schema.parse({ on_stream: true }), name).toEqual({ on_stream: true });
      expect(schema.parse({ name: "Harbour" }), name).toEqual({ name: "Harbour" });
      expect(schema.parse({}), `${name}: an empty body stays empty (so patchSponsor can refuse it)`).toEqual({});
    }
    for (const [name, schema] of [["usecase CreateSponsorInput", CreateSponsorInput], ["api-v1 CreateSponsor", CreateSponsor]] as const) {
      expect(schema.parse({ name: "Harbour" }), name).toEqual({ name: "Harbour", tier: "partner", status: "active" });
    }
  });

  it("a patch of a non-boolean tick is refused at parse, and an empty patch still is", () => {
    expect(PatchSponsorInput.safeParse({ on_stream: "yes" }).success).toBe(false);
    expect(PatchSponsorInput.safeParse({ on_stream: 1 }).success).toBe(false);
    expect(PatchSponsorInput.safeParse({ on_stream: true }).success).toBe(true);
    expect(PatchSponsorInput.safeParse({ on_stream: false }).success).toBe(true);
  });
});

describe.skipIf(!HAS_DB)("PATCH {on_stream} - the tick, over the real routes", () => {
  it("a created sponsor starts OFF the stream whatever the create body says (PATCH-only), and the list and the patch answer carry the tick", async () => {
    const o = await organiser();
    const res = await create(o.orgId, { name: "Harbour Physio", on_stream: true });
    expect(res.status).toBe(201);
    const made = ((await res.json()) as { data: { id: string; on_stream: boolean } }).data;
    expect(made.on_stream, "the create answer").toBe(false);
    expect(await tickOf(made.id), "the row").toBe(false);
    expect(await settingsRows(o.orgId), "creating a sponsor never starts the rotation").toEqual([]);

    const ticked = await patch(o.orgId, made.id, { on_stream: true });
    expect(ticked.status).toBe(200);
    expect(Sponsor.parse(((await ticked.json()) as Envelope).data)).toMatchObject({ id: made.id, on_stream: true });
    expect(await tickOf(made.id)).toBe(true);

    const rows = ((await (await list(o.orgId)).json()) as { data: { id: string; on_stream: boolean }[] }).data;
    expect(rows.map((r) => [r.id, r.on_stream])).toEqual([[made.id, true]]);
  });

  it("regression (found by the first tick): ticking and unticking leave a sponsor's tier, status, scope and name exactly as they were; a rename does not tick", async () => {
    const o = await organiser();
    const [row] = await sql<{ id: string }[]>`
      insert into sponsors (org_id, competition_id, name, tier, status)
      values (${o.orgId}, ${o.competitionId}, 'Harbour Physio', 'title', 'inactive') returning id`;
    const id = row!.id;
    const snapshot = async () => (await sql`select name, tier, status, competition_id, display_order from sponsors where id = ${id}`)[0];
    const before = await snapshot();
    expect(before).toMatchObject({ tier: "title", status: "inactive", competition_id: o.competitionId });

    expect((await patch(o.orgId, id, { on_stream: true })).status).toBe(200);
    expect(await snapshot(), "a tick moved nothing but the tick").toEqual(before);
    expect((await patch(o.orgId, id, { on_stream: false })).status).toBe(200);
    expect(await snapshot()).toEqual(before);
    expect((await patch(o.orgId, id, { name: "Harbour Physio Ltd" })).status).toBe(200);
    expect(await snapshot(), "a rename changed the name only").toEqual({ ...before, name: "Harbour Physio Ltd" });
    expect(await tickOf(id), "and ticked nothing").toBe(false);
  });

  it("R12, the first-tick sequence: tick -> the org row exists, enabled, Normal; untick -> it stays; tick again -> still one row; a competition with no row reads the org's", async () => {
    const o = await organiser();
    const a = await sponsorOf(o.orgId, "Harbour Physio");
    const b = await sponsorOf(o.orgId, "Ridge Garage");
    expect(await settingsRows(o.orgId), "premise: a fresh org has no settings row").toEqual([]);
    expect(await resolveStreamSettings(sql, o.orgId, null)).toBeNull();

    // 1. the FIRST tick creates the org row at Normal, enabled (D12), made by the ticker.
    expect((await patch(o.orgId, a, { on_stream: true })).status).toBe(200);
    expect(await settingsRows(o.orgId)).toEqual([{ competition_id: null, enabled: true, frequency: "normal", updated_by: o.ownerId }]);
    expect(await resolveStreamSettings(sql, o.orgId, null)).toEqual({ enabled: true, frequency: "normal" });

    // 2. unticking leaves the row exactly as it is.
    expect((await patch(o.orgId, a, { on_stream: false })).status).toBe(200);
    expect(await tickOf(a)).toBe(false);
    expect(await settingsRows(o.orgId)).toEqual([{ competition_id: null, enabled: true, frequency: "normal", updated_by: o.ownerId }]);

    // 3. ticking again (the same sponsor, then another) adds no second row.
    expect((await patch(o.orgId, a, { on_stream: true })).status).toBe(200);
    expect((await patch(o.orgId, b, { on_stream: true })).status).toBe(200);
    expect(await settingsRows(o.orgId)).toHaveLength(1);

    // 4. a competition with no row of its own falls through to the org row.
    expect(await resolveStreamSettings(sql, o.orgId, o.competitionId)).toEqual({ enabled: true, frequency: "normal" });
  });

  it("a tick never overwrites a row that exists: the organiser's Busy / switched-off choice survives the next tick", async () => {
    const o = await organiser();
    const a = await sponsorOf(o.orgId, "Harbour Physio");
    expect((await putDial(o.orgId, { competitionId: null, enabled: false, frequency: "busy" })).status).toBe(200);
    expect((await patch(o.orgId, a, { on_stream: true })).status).toBe(200);
    expect(await tickOf(a)).toBe(true);
    expect(await resolveStreamSettings(sql, o.orgId, null), "the existing row is not re-enabled or reset").toEqual({ enabled: false, frequency: "busy" });
    expect(await settingsRows(o.orgId)).toHaveLength(1);
  });

  it("a competition row alone does not count as 'the org has a row': the first tick still creates the ORG row", async () => {
    const o = await organiser();
    const a = await sponsorOf(o.orgId, "Harbour Physio");
    expect((await putDial(o.orgId, { competitionId: o.competitionId, enabled: true, frequency: "light" })).status).toBe(200);
    expect((await patch(o.orgId, a, { on_stream: true })).status).toBe(200);
    expect(await settingsRows(o.orgId)).toEqual([
      { competition_id: null, enabled: true, frequency: "normal", updated_by: o.ownerId },
      { competition_id: o.competitionId, enabled: true, frequency: "light", updated_by: o.ownerId },
    ]);
  });

  it("only a TICK creates the row: unticking first, renaming, or ticking nothing leaves an org with no settings row", async () => {
    const o = await organiser();
    const a = await sponsorOf(o.orgId, "Harbour Physio");
    expect((await patch(o.orgId, a, { on_stream: false })).status).toBe(200);
    expect((await patch(o.orgId, a, { name: "Harbour Physio Ltd" })).status).toBe(200);
    expect((await patch(o.orgId, a, { name: "Harbour Physio", on_stream: false })).status).toBe(200);
    expect(await settingsRows(o.orgId)).toEqual([]);
  });

  it("two first ticks racing leave ONE org row (the scope key arbitrates), and both ticks land", async () => {
    const o = await organiser();
    const a = await sponsorOf(o.orgId, "Harbour Physio");
    const b = await sponsorOf(o.orgId, "Ridge Garage");
    const [ra, rb] = await Promise.all([patch(o.orgId, a, { on_stream: true }), patch(o.orgId, b, { on_stream: true })]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    expect(await settingsRows(o.orgId)).toHaveLength(1);
    expect([await tickOf(a), await tickOf(b)]).toEqual([true, true]);
  });

  it("a non-boolean tick is 400 VALIDATION and changes nothing", async () => {
    const o = await organiser();
    const a = await sponsorOf(o.orgId, "Harbour Physio");
    for (const bad of ["yes", 1, null]) {
      const res = await patch(o.orgId, a, { on_stream: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(await tickOf(a)).toBe(false);
    expect(await settingsRows(o.orgId)).toEqual([]);
  });

  it("R19, the granted AND the denied pair: owner and admin tick; a viewer is 403 and neither the tick nor a settings row appears", async () => {
    const o = await organiser();
    const a = await sponsorOf(o.orgId, "Harbour Physio");
    const adminId = await memberOf(o.orgId, "admin");
    const viewerId = await memberOf(o.orgId, "viewer");

    authState.userId = viewerId;
    const denied = await patch(o.orgId, a, { on_stream: true });
    expect(denied.status).toBe(403);
    expect(await tickOf(a)).toBe(false);
    expect(await settingsRows(o.orgId)).toEqual([]);

    authState.userId = adminId;
    expect((await patch(o.orgId, a, { on_stream: true })).status).toBe(200);
    expect(await tickOf(a)).toBe(true);
    authState.userId = o.ownerId;
    expect((await patch(o.orgId, a, { on_stream: false })).status).toBe(200);
    expect(await tickOf(a)).toBe(false);
    expect(await settingsRows(o.orgId)).toHaveLength(1);
  });

  it("another org's sponsor is 404 and the caller's own org gets NO settings row out of it (the tick and the row are one transaction)", async () => {
    const o = await organiser();
    const theirs = await sponsorOf(o.orgId, "Harbour Physio");
    const foreign = await organiser();               // signs in as ANOTHER org's owner
    const res = await patch(foreign.orgId, theirs, { on_stream: true });
    expect(res.status).toBe(404);
    expect(await tickOf(theirs), "the other org's sponsor is untouched").toBe(false);
    expect(await settingsRows(foreign.orgId)).toEqual([]);
    expect(await settingsRows(o.orgId)).toEqual([]);
  });
});
