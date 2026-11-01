// A PATCH leaves the columns it did not name alone (fix/patch-schema-partial-defaults, 2026-11-01), over the REAL
// route handlers, the REAL session door and the REAL tables. Before the fix each of these patch bodies was its create
// schema's `.partial()`, and zod 4 FILLS an omitted `.default()` field, so the usecase (which writes the body's keys
// as columns) rewrote the defaulted columns on every PATCH that did not name them:
//   - PATCH a court  → `tags` wiped (and with them every stage's required_court_tags match) and `sort` reset to 0;
//     the Directory tab sends `{ name }` on a rename, `{ sort }` on a reorder and `{ tags }` on a tag edit;
//   - PATCH a venue  → `sort` reset to 0: the tab's Save sends `{ name, address }`, so the venue jumped to the top;
//   - PATCH an official → `role_keys` rewritten to ["referee"] by any edit that did not send them.
// The non-DB sweep over every patch schema is server/api-v1/__tests__/patch-omitted-fields.test.ts; this file is the
// seam it cannot see: what the stored row looks like after the route parsed the body.
//
// Sequence (TEST-STRATEGY rule 1): each entity is patched several times in a row, one field each, and every other
// column is read back after every step; an EMPTY patch is refused and changes nothing; an explicit value (an empty tag
// list, sort 0) is still written, so the fix did not make a field unwritable; and create still applies its defaults.
// Sport-agnostic on purpose (rule 6): venues, courts and officials carry no sport.
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
import { CreateCourt, CreateOfficial, CreateVenue } from "@/server/api-v1/schemas";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { GET as listVenuesRoute, POST as createVenueRoute } from "../orgs/[id]/venues/route";
import { PATCH as patchVenueRoute } from "../orgs/[id]/venues/[venueId]/route";
import { POST as createCourtRoute } from "../orgs/[id]/venues/[venueId]/courts/route";
import { PATCH as patchCourtRoute } from "../orgs/[id]/courts/[courtId]/route";
import { POST as createOfficialRoute } from "../officials/route";
import { PATCH as patchOfficialRoute } from "../officials/[id]/route";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

type Envelope<T> = { ok: boolean; data?: T; error?: { code?: string; message: string } };
const req = (url: string, method: string, body?: unknown) =>
  new Request(`http://localhost/api/v1${url}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
async function read<T>(res: Response): Promise<{ status: number; body: Envelope<T> }> {
  return { status: res.status, body: (await res.json()) as Envelope<T> };
}

/** A fresh organisation whose owner is the session user. */
async function organiser(): Promise<string> {
  const { auth } = await seedOrg("pro");
  authState.userId = auth.userId!;
  return auth.orgId;
}

interface VenueRow { id: string; name: string; address: string | null; sort: number }
interface CourtRow { id: string; name: string; sort: number; tags: string[] }
interface OfficialRow { id: string; display_name: string; email: string | null; role_keys: string[]; max_per_day: number | null }

const venueOf = async (id: string) =>
  (await sql<VenueRow[]>`select id, name, address, sort from venues where id = ${id}`)[0]!;
const courtOf = async (id: string) =>
  (await sql<CourtRow[]>`select id, name, sort, tags from courts where id = ${id}`)[0]!;
const officialOf = async (id: string) =>
  (await sql<OfficialRow[]>`select id, display_name, email, role_keys, max_per_day from officials where id = ${id}`)[0]!;

async function createVenue(orgId: string, body: unknown): Promise<string> {
  const res = await read<VenueRow>(await createVenueRoute(req(`/orgs/${orgId}/venues`, "POST", body), { params: Promise.resolve({ id: orgId }) }));
  expect(res.status).toBe(201);
  return res.body.data!.id;
}
const patchVenue = async (orgId: string, venueId: string, body: unknown) =>
  read<VenueRow>(await patchVenueRoute(req(`/orgs/${orgId}/venues/${venueId}`, "PATCH", body), { params: Promise.resolve({ id: orgId, venueId }) }));

async function createCourt(orgId: string, venueId: string, body: unknown): Promise<string> {
  const res = await read<CourtRow>(
    await createCourtRoute(req(`/orgs/${orgId}/venues/${venueId}/courts`, "POST", body), { params: Promise.resolve({ id: orgId, venueId }) }),
  );
  expect(res.status).toBe(201);
  return res.body.data!.id;
}
const patchCourt = async (orgId: string, courtId: string, body: unknown) =>
  read<CourtRow>(await patchCourtRoute(req(`/orgs/${orgId}/courts/${courtId}`, "PATCH", body), { params: Promise.resolve({ id: orgId, courtId }) }));

async function createOfficial(body: unknown): Promise<string> {
  const res = await read<OfficialRow>(await createOfficialRoute(req(`/officials`, "POST", body)));
  expect(res.status).toBe(201);
  return res.body.data!.id;
}
const patchOfficial = async (id: string, body: unknown) =>
  read<OfficialRow>(await patchOfficialRoute(req(`/officials/${id}`, "PATCH", body), { params: Promise.resolve({ id }) }));

describe.skipIf(!HAS_DB)("PATCH a court: the columns it did not name survive", () => {
  // The defaults the create schema declares, so the "wrong" value each case must avoid is read, never typed. The
  // stored values below differ from both of them, or a filled default could not be told from a kept value.
  const declared = CreateCourt.parse({ name: "probe" });

  it("rename, reorder, re-tag, one field each: every other column is the one stored before", async () => {
    const orgId = await organiser();
    const venueId = await createVenue(orgId, { name: "Riverside" });
    const courtId = await createCourt(orgId, venueId, { name: "Court 1", sort: 3, tags: ["Clay", "indoor"] });
    expect(await courtOf(courtId)).toMatchObject({ name: "Court 1", sort: 3, tags: ["clay", "indoor"] });
    expect(declared.sort).not.toBe(3);
    expect(declared.tags).not.toEqual(["clay", "indoor"]);

    // The Directory tab's rename body.
    const renamed = await patchCourt(orgId, courtId, { name: "Centre Court" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data).toMatchObject({ name: "Centre Court", sort: 3, tags: ["clay", "indoor"] });
    expect(await courtOf(courtId)).toMatchObject({ name: "Centre Court", sort: 3, tags: ["clay", "indoor"] });

    // The reorder body (venues-panel swaps two courts' sort with one PATCH each).
    expect((await patchCourt(orgId, courtId, { sort: 7 })).status).toBe(200);
    expect(await courtOf(courtId)).toMatchObject({ name: "Centre Court", sort: 7, tags: ["clay", "indoor"] });

    // The tag editor's body.
    expect((await patchCourt(orgId, courtId, { tags: ["Grass"] })).status).toBe(200);
    expect(await courtOf(courtId)).toMatchObject({ name: "Centre Court", sort: 7, tags: ["grass"] });
  });

  it("an empty patch is refused and changes nothing; an explicit empty tag list and sort 0 are still written", async () => {
    const orgId = await organiser();
    const venueId = await createVenue(orgId, { name: "Riverside" });
    const courtId = await createCourt(orgId, venueId, { name: "Court 2", sort: 4, tags: ["hard"] });

    const empty = await patchCourt(orgId, courtId, {});
    expect(empty.status).toBe(400);
    expect(await courtOf(courtId)).toMatchObject({ name: "Court 2", sort: 4, tags: ["hard"] });

    // Positive pair: the fix keeps an omitted field omitted, it does not make the field unwritable.
    expect((await patchCourt(orgId, courtId, { tags: [] })).status).toBe(200);
    expect(await courtOf(courtId)).toMatchObject({ name: "Court 2", sort: 4, tags: [] });
    expect((await patchCourt(orgId, courtId, { sort: 0 })).status).toBe(200);
    expect(await courtOf(courtId)).toMatchObject({ name: "Court 2", sort: 0, tags: [] });
  });

  it("create still applies the declared defaults", async () => {
    const orgId = await organiser();
    const venueId = await createVenue(orgId, { name: "Riverside" });
    const courtId = await createCourt(orgId, venueId, { name: "Court 3" });
    expect(await courtOf(courtId)).toMatchObject({ name: "Court 3", sort: declared.sort, tags: declared.tags });
  });
});

describe.skipIf(!HAS_DB)("PATCH a venue: its sort survives, so it keeps its place in the list", () => {
  const declared = CreateVenue.parse({ name: "probe" });

  it("the tab's Save body ({ name, address }) twice in a row: sort kept, list order kept", async () => {
    const orgId = await organiser();
    const alpha = await createVenue(orgId, { name: "Alpha", sort: 1 });
    const bravo = await createVenue(orgId, { name: "Bravo", address: "1 Mill Lane", sort: 2 });
    expect(declared.sort).toBeLessThan(1); // a filled default would sort Bravo above Alpha

    const saved = await patchVenue(orgId, bravo, { name: "Bravo Park", address: null });
    expect(saved.status).toBe(200);
    expect(await venueOf(bravo)).toMatchObject({ name: "Bravo Park", address: null, sort: 2 });
    expect((await patchVenue(orgId, bravo, { name: "Bravo Park", address: "2 Mill Lane" })).status).toBe(200);
    expect(await venueOf(bravo)).toMatchObject({ name: "Bravo Park", address: "2 Mill Lane", sort: 2 });

    const list = await read<{ id: string }[]>(await listVenuesRoute(req(`/orgs/${orgId}/venues`, "GET"), { params: Promise.resolve({ id: orgId }) }));
    expect(list.status).toBe(200);
    expect(list.body.data!.map((v) => v.id)).toEqual([alpha, bravo]);
  });

  it("an empty patch is refused and changes nothing; an explicit sort is still written", async () => {
    const orgId = await organiser();
    const venueId = await createVenue(orgId, { name: "Charlie", sort: 5 });
    expect((await patchVenue(orgId, venueId, {})).status).toBe(400);
    expect(await venueOf(venueId)).toMatchObject({ name: "Charlie", sort: 5 });
    expect((await patchVenue(orgId, venueId, { sort: 0 })).status).toBe(200);
    expect(await venueOf(venueId)).toMatchObject({ name: "Charlie", sort: 0 });
  });

  it("create still applies the declared default", async () => {
    const orgId = await organiser();
    const venueId = await createVenue(orgId, { name: "Delta" });
    expect((await venueOf(venueId)).sort).toBe(declared.sort);
  });
});

describe.skipIf(!HAS_DB)("PATCH an official: its role_keys survive an edit that does not send them", () => {
  const declared = CreateOfficial.parse({ display_name: "probe" });
  const ROLES = ["umpire", "scorer"];

  it("rename, then a daily cap, then an email: role_keys are the stored ones after every step", async () => {
    await organiser();
    const id = await createOfficial({ display_name: "Sam Reid", role_keys: ROLES });
    expect(declared.role_keys).not.toEqual(ROLES);
    expect((await officialOf(id)).role_keys).toEqual(ROLES);

    const renamed = await patchOfficial(id, { display_name: "Samantha Reid" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data).toMatchObject({ display_name: "Samantha Reid", role_keys: ROLES });
    expect(await officialOf(id)).toMatchObject({ display_name: "Samantha Reid", role_keys: ROLES });

    expect((await patchOfficial(id, { max_per_day: 3 })).status).toBe(200);
    expect(await officialOf(id)).toMatchObject({ display_name: "Samantha Reid", role_keys: ROLES, max_per_day: 3 });

    expect((await patchOfficial(id, { email: "sam@example.test" })).status).toBe(200);
    expect(await officialOf(id)).toMatchObject({ role_keys: ROLES, max_per_day: 3, email: "sam@example.test" });
  });

  it("an empty patch is refused and changes nothing; explicit role_keys are still written", async () => {
    await organiser();
    const id = await createOfficial({ display_name: "Alex Moss", role_keys: ROLES });
    expect((await patchOfficial(id, {})).status).toBe(400);
    expect(await officialOf(id)).toMatchObject({ display_name: "Alex Moss", role_keys: ROLES });
    expect((await patchOfficial(id, { role_keys: ["line_judge"] })).status).toBe(200);
    expect((await officialOf(id)).role_keys).toEqual(["line_judge"]);
  });

  it("create still applies the declared default", async () => {
    await organiser();
    const id = await createOfficial({ display_name: "Jo Park" });
    expect((await officialOf(id)).role_keys).toEqual(declared.role_keys);
  });
});
