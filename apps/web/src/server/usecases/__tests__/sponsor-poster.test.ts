// Title sponsor poster, Task 2: `poster_path` rides the sponsor write path, the list read and the public resolver.
// Spec: docs/superpowers/specs/2026-11-11-title-sponsor-hero-poster-design.md §6.2-§6.3.
//
// Sport-agnostic: a sponsor's poster reads no sport, so there is no sport sweep here (one reason, stated once).
//
// Written and read through the REAL producers a client calls: the v1 create and patch ROUTES (parseBody -> usecase -> the
// table), then read back from the STORED row with the privileged `sql` client, never from the usecase's return value alone
// (a write that answers the new value and stores the old one passes the answer check). The resolver is read the way the public
// competition page reads it (`resolveSponsors(org, competition, { tiered })`).
//
// Expected values are this file's own declared posters and tiers (spec §6.3's PATCH table), never read from the code under
// test. Real Postgres required (skipped without DATABASE_URL like every DB suite under src/server).
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
import { POST as createRoute } from "@/app/api/v1/orgs/[id]/sponsors/route";
import { PATCH } from "@/app/api/v1/orgs/[id]/sponsors/[sponsorId]/route";
import { createCompetition } from "../competitions";
import { createSponsor, listSponsors, patchSponsor, resolveSponsors } from "../sponsors";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const POSTER_A = "https://cdn.example/storage/v1/object/public/assets/orgs/o/content/a.png";
const POSTER_B = "https://cdn.example/storage/v1/object/public/assets/orgs/o/content/b.webp";
const POSTER_C = "https://cdn.example/storage/v1/object/public/assets/orgs/o/content/c.jpg";
const POSTER_D = "https://cdn.example/storage/v1/object/public/assets/orgs/o/content/d.png";

/** Spec §6.3's refused bodies: a non-http(s) scheme, a bare storage path, a 501-character URL, and the three shapes `new URL()`
 *  repairs (a missing or wrong slash: zod's `.url()` lets them through and only the DB CHECK refused them, as a 500; review M1).
 *  Each must answer 400 through the real route. */
const REFUSED = [
  "javascript:alert(1)", "logos/x.png", "https://a.example/" + "x".repeat(483),
  "https:/a.example/p.png", "https:a.example/p.png", "https:\\\\a.example\\p.png",
];

type Envelope = { ok: boolean; data?: { id: string; poster_path: string | null }; error?: { code: string; message: string } };
const base = (orgId: string) => `http://localhost/api/v1/orgs/${orgId}/sponsors`;
const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const create = (orgId: string, body: unknown) => createRoute(new Request(base(orgId), json("POST", body)), { params: Promise.resolve({ id: orgId }) });
const patch = (orgId: string, sponsorId: string, body: unknown) =>
  PATCH(new Request(`${base(orgId)}/${sponsorId}`, json("PATCH", body)), { params: Promise.resolve({ id: orgId, sponsorId }) });

/** The stored value, straight from the table. */
const stored = async (id: string): Promise<string | null> =>
  (await sql<{ poster_path: string | null }[]>`select poster_path from sponsors where id = ${id}`)[0]!.poster_path;
const listed = async (auth: Parameters<typeof listSponsors>[0], id: string): Promise<string | null> =>
  (await listSponsors(auth)).find((s) => s.id === id)!.poster_path;
const resolvedPoster = async (orgId: string, id: string, competitionId?: string): Promise<string | null | "absent"> => {
  const hit = (await resolveSponsors(orgId, competitionId, { tiered: true })).find((s) => s.id === id);
  return hit ? hit.poster : "absent";
};

describe.skipIf(!HAS_DB)("sponsor poster_path: the write sequence, the list and the resolver", () => {
  it("empty first: a sponsor created without a poster stores null, lists null and resolves poster: null", async () => {
    const { auth } = await seedOrg("pro");
    authState.userId = auth.userId!;
    const made = await createSponsor(auth, { name: "No Poster Ltd", tier: "partner", status: "active" });

    expect(made.poster_path, "the create's answer").toBeNull();
    expect(await stored(made.id), "the row").toBeNull();
    expect(await listed(auth, made.id), "the list").toBeNull();
    expect(await resolvedPoster(auth.orgId, made.id), "the resolver").toBeNull();
  });

  it("a create may carry a poster: stored, listed and resolved", async () => {
    const { auth } = await seedOrg("pro");
    authState.userId = auth.userId!;
    const res = await create(auth.orgId, { name: "Poster Co", tier: "title", poster_path: POSTER_A });
    expect(res.status).toBe(201);
    const made = ((await res.json()) as Envelope).data!;

    expect(made.poster_path, "the answer").toBe(POSTER_A);
    expect(await stored(made.id), "the row").toBe(POSTER_A);
    expect(await listed(auth, made.id), "the list").toBe(POSTER_A);
    expect(await resolvedPoster(auth.orgId, made.id), "the resolver").toBe(POSTER_A);

    // A create that sends an explicit null stores null, as an absent key does.
    const nulled = ((await (await create(auth.orgId, { name: "Null Co", poster_path: null })).json()) as Envelope).data!;
    expect(await stored(nulled.id)).toBeNull();
  });

  it("set, replace, remove: each PATCH is read back from the row and the list - A, then B (second call), then null; a patch that omits it keeps it", async () => {
    const { auth } = await seedOrg("pro");
    authState.userId = auth.userId!;
    const made = ((await (await create(auth.orgId, { name: "Sequence Co", tier: "title" })).json()) as Envelope).data!;
    expect(await stored(made.id), "premise: starts with none").toBeNull();

    let checked = 0;
    for (const next of [POSTER_A, POSTER_B, null] as const) {
      const res = await patch(auth.orgId, made.id, { poster_path: next });
      expect(res.status, `PATCH ${String(next)}`).toBe(200);
      expect(((await res.json()) as Envelope).data!.poster_path, `the answer after ${String(next)}`).toBe(next);
      expect(await stored(made.id), `the row after ${String(next)}`).toBe(next);
      expect(await listed(auth, made.id), `the list after ${String(next)}`).toBe(next);
      expect(await resolvedPoster(auth.orgId, made.id), `the resolver after ${String(next)}`).toBe(next);
      checked++;
    }
    expect(checked).toBe(3);

    // A rename that does not name the poster must not touch it (the patch's keys are the columns written).
    expect((await patch(auth.orgId, made.id, { poster_path: POSTER_C })).status).toBe(200);
    expect((await patch(auth.orgId, made.id, { name: "Sequence Co Renamed" })).status).toBe(200);
    expect(await stored(made.id), "an omitted poster_path is left alone").toBe(POSTER_C);
  });

  it("a refused poster PATCH writes nothing: the row keeps B, after each refusal (count reported)", async () => {
    const { auth } = await seedOrg("pro");
    authState.userId = auth.userId!;
    const made = ((await (await create(auth.orgId, { name: "Refusal Co", tier: "title", poster_path: POSTER_B })).json()) as Envelope).data!;

    let checked = 0;
    for (const bad of REFUSED) {
      const res = await patch(auth.orgId, made.id, { poster_path: bad });
      expect(res.status, bad.slice(0, 30)).toBe(400);
      expect(await stored(made.id), `the row after ${bad.slice(0, 30)}`).toBe(POSTER_B);
      expect(await listed(auth, made.id), `the list after ${bad.slice(0, 30)}`).toBe(POSTER_B);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(REFUSED.length);

    // The positive twin: the same route still accepts a good value afterwards.
    expect((await patch(auth.orgId, made.id, { poster_path: POSTER_D })).status).toBe(200);
    expect(await stored(made.id)).toBe(POSTER_D);

    // A create is refused the same way and saves nothing.
    const before = (await sql<{ n: number }[]>`select count(*)::int as n from sponsors where org_id = ${auth.orgId}`)[0]!.n;
    expect((await create(auth.orgId, { name: "Bad Poster Co", poster_path: REFUSED[0] })).status).toBe(400);
    const after = (await sql<{ n: number }[]>`select count(*)::int as n from sponsors where org_id = ${auth.orgId}`)[0]!.n;
    expect(after, "a refused create saved no sponsor").toBe(before);
  });

  it("another org's sponsor: 404, and its poster is unchanged", async () => {
    const mine = await seedOrg("pro");
    const theirs = await seedOrg("pro");
    authState.userId = theirs.auth.userId!;
    const victim = ((await (await create(theirs.auth.orgId, { name: "Theirs Ltd", poster_path: POSTER_A })).json()) as Envelope).data!;

    authState.userId = mine.auth.userId!;
    const res = await patch(mine.auth.orgId, victim.id, { poster_path: POSTER_B });
    expect(res.status).toBe(404);
    expect(await stored(victim.id), "the other org's row").toBe(POSTER_A);

    // The usecase, with no route in front of it, refuses the same way.
    await expect(patchSponsor(mine.auth, victim.id, { poster_path: null })).rejects.toMatchObject({ status: 404 });
    expect(await stored(victim.id)).toBe(POSTER_A);
  });

  it("resolveSponsors carries the poster for a competition-scoped AND an org-wide title row, in resolver order (count reported)", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Poster Cup", visibility: "public", branding: {} });
    // Declared out of resolver order on purpose, so the order asserted below is the resolver's, not insertion order.
    const partner = await createSponsor(auth, { name: "Partner Only", tier: "partner", status: "active" });
    const orgGold = await createSponsor(auth, { name: "Org Gold", tier: "gold", status: "active", poster_path: POSTER_C });
    const orgTitle = await createSponsor(auth, { name: "Org Title", tier: "title", status: "active", poster_path: POSTER_B });
    const scopedTitle = await createSponsor(auth, {
      name: "Cup Title", tier: "title", status: "active", competition_id: comp.id, poster_path: POSTER_A,
    });
    // The same NAME at two scopes: the competition-scoped row wins the dedupe, and the poster is its own, not its twin's.
    await createSponsor(auth, { name: "Cup Title", tier: "partner", status: "active", poster_path: POSTER_D });

    const resolved = await resolveSponsors(auth.orgId, comp.id, { tiered: true });
    const got = resolved.map((s) => ({ id: s.id, poster: s.poster }));
    const want = [
      { id: scopedTitle.id, poster: POSTER_A }, // competition-scoped rows first
      { id: orgTitle.id, poster: POSTER_B }, // then org-wide, by tier rank
      { id: orgGold.id, poster: POSTER_C },
      { id: partner.id, poster: null },
    ];
    expect(got).toEqual(want);
    expect(got.length, "anti-vacuity: every row was checked").toBe(4);
    expect(got.filter((s) => s.poster !== null).length, "three carry a poster").toBe(3);

    // The org-wide title row is also what a competition with no scoped row shows.
    const other = await createCompetition(auth, { ends_on: "2030-12-31", name: "Other Cup", visibility: "public", branding: {} });
    const orgWide = (await resolveSponsors(auth.orgId, other.id, { tiered: true })).filter((s) => s.tier === "title");
    expect(orgWide.map((s) => s.poster), "another competition: the org-wide title row only").toEqual([POSTER_B]);
  });

  it("an inactive or pending title sponsor resolves to nothing - its poster with it - and comes back with it (the status is set by a hand PATCH; this does not drive the deal-void or dispute-park writers)", async () => {
    const { auth } = await seedOrg("pro");
    authState.userId = auth.userId!;
    const title = await createSponsor(auth, { name: "Parked Title", tier: "title", status: "active", poster_path: POSTER_A });
    expect(await resolvedPoster(auth.orgId, title.id), "premise: active shows its poster").toBe(POSTER_A);

    let checked = 0;
    for (const status of ["pending", "inactive"] as const) {
      expect((await patch(auth.orgId, title.id, { status })).status, status).toBe(200);
      expect(await resolvedPoster(auth.orgId, title.id), `${status}: nothing resolves`).toBe("absent");
      expect((await resolveSponsors(auth.orgId, undefined, { tiered: true })).length, `${status}: the board is empty`).toBe(0);
      expect(await stored(title.id), `${status}: the poster is kept on the row`).toBe(POSTER_A);
      expect((await patch(auth.orgId, title.id, { status: "active" })).status).toBe(200);
      expect(await resolvedPoster(auth.orgId, title.id), `${status} then active: the poster is back`).toBe(POSTER_A);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("tiered:false collapses the tier to partner and still carries the poster (the hero decides; Task 5 shows it draws nothing)", async () => {
    const { auth } = await seedOrg("pro");
    const title = await createSponsor(auth, { name: "Collapsed Title", tier: "title", status: "active", poster_path: POSTER_A });
    const bare = await createSponsor(auth, { name: "Collapsed Bare", tier: "title", status: "active" });

    const flat = await resolveSponsors(auth.orgId, undefined, { tiered: false });
    expect(flat.map((s) => s.tier), "every tier collapsed").toEqual(["partner", "partner"]);
    expect(Object.fromEntries(flat.map((s) => [s.id, s.poster]))).toEqual({ [title.id]: POSTER_A, [bare.id]: null });
    expect(flat.length, "anti-vacuity").toBe(2);
  });
});
