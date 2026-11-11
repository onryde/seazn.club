// Sponsor CRM (v10 PROMPT-56): CRUD + entitlement gates + resolver order.
// Tiers above partner and per-competition scoping are Pro `sponsors.tiers`;
// the flat partner strip stays free. Real Postgres required.
// R4 fix batch 3 (m9): sponsors come from the `sponsors` table ONLY. The legacy `branding.sponsors` blob is never read
// (V492 strips it, the org PATCH no longer writes it); the cases below that still plant one prove it stays unread.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { embedDivisionData } from "@/server/embed-data";
import { createCompetition } from "../competitions";
import { orgBranding } from "../exports";
import {
  createSponsor,
  deleteSponsor,
  listSponsors,
  patchSponsor,
  reorderSponsors,
  resolveSponsors,
} from "../sponsors";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(plan: "community" | "pro" = "pro"): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Spo " + suffix}, ${"spo-" + suffix})
    returning id`;
  if (plan !== "community") {
    await setOrgPlan(orgId, plan);
  }
  await invalidateOrgEntitlements(orgId);
  return {
    auth: { orgId, via: "session", userId: null, role: "owner", keyId: null },
  };
}

describe.skipIf(!HAS_DB)("sponsors usecase", () => {
  it("community: partner org-wide is free; tiers and competition scoping 402", async () => {
    const { auth } = await seedOrg("community");
    const partner = await createSponsor(auth, {
      name: "Corner Shop",
      tier: "partner",
      status: "active",
    });
    expect(partner.tier).toBe("partner");

    await expect(
      createSponsor(auth, { name: "Big Bank", tier: "gold", status: "active" }),
    ).rejects.toMatchObject({ status: 402 });
    await expect(
      createSponsor(auth, {
        name: "Scoped",
        tier: "partner",
        status: "active",
        competition_id: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 402 });
    // Promoting an existing partner sponsor is gated the same way.
    await expect(patchSponsor(auth, partner.id, { tier: "title" })).rejects.toMatchObject({
      status: 402,
    });
  });

  it("pro: tiered + competition-scoped CRUD, reorder, tier-ranked list", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Sponsor Cup",
      visibility: "public",
      branding: {},
    });

    const p1 = await createSponsor(auth, {
      name: "Partner One",
      tier: "partner",
      status: "active",
    });
    const p2 = await createSponsor(auth, {
      name: "Partner Two",
      tier: "partner",
      status: "active",
    });
    const gold = await createSponsor(auth, {
      name: "Goldco",
      tier: "gold",
      status: "active",
    });
    const scoped = await createSponsor(auth, {
      name: "Cup Only",
      tier: "title",
      status: "active",
      competition_id: comp.id,
    });
    expect(scoped.competition_id).toBe(comp.id);

    // List is tier-ranked: title → gold → partner (insertion order inside).
    const listed = await listSponsors(auth);
    expect(listed.map((s) => s.name)).toEqual(["Cup Only", "Goldco", "Partner One", "Partner Two"]);

    // Reorder: swap the partners.
    await reorderSponsors(auth, { ids: [scoped.id, gold.id, p2.id, p1.id] });
    const after = await listSponsors(auth);
    expect(after.map((s) => s.name)).toEqual(["Cup Only", "Goldco", "Partner Two", "Partner One"]);

    await expect(reorderSponsors(auth, { ids: [randomUUID()] })).rejects.toMatchObject({
      status: 422,
    });

    await deleteSponsor(auth, gold.id);
    expect((await listSponsors(auth)).map((s) => s.name)).not.toContain("Goldco");
    await expect(deleteSponsor(auth, gold.id)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("resolveSponsors: table rows only (a stray blob is never read), scope + dedupe + rank", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Resolve Cup",
      visibility: "public",
      branding: {},
    });
    // A stray blob (a value planted directly) is never read: rows are the only source.
    await sql`
      update organizations
      set branding = ${sql.json({ sponsors: [{ name: "Blob Relic" }] } as never)}
      where id = ${auth.orgId}`;

    await createSponsor(auth, {
      name: "Acme",
      tier: "partner",
      status: "active",
    });
    await createSponsor(auth, {
      name: "Acme",
      tier: "gold",
      status: "active",
      competition_id: comp.id,
    });
    await createSponsor(auth, {
      name: "Cup Title",
      tier: "title",
      status: "active",
      competition_id: comp.id,
    });
    await createSponsor(auth, {
      name: "Hidden",
      tier: "gold",
      status: "inactive",
    });

    const resolved = await resolveSponsors(auth.orgId, comp.id);
    // competition rows first (title, then that comp's gold Acme), org-wide
    // Acme deduped away, inactive + blob entries absent.
    expect(resolved.map((s) => `${s.name}:${s.tier}`)).toEqual(["Cup Title:title", "Acme:gold"]);

    // Un-tiered collapse for free public strips.
    const flat = await resolveSponsors(auth.orgId, comp.id, { tiered: false });
    expect(flat.every((s) => s.tier === "partner")).toBe(true);
  });

  // R4 fix batch 3 (m9): the EMPTY case, which used to fall back to the blob shim. An org with no rows shows nothing,
  // however much a stray blob holds; its first row is all it shows.
  it("resolveSponsors: an org with NO rows and a stray blob resolves to nothing - the blob is never read - and its first row is all it shows", async () => {
    const { auth } = await seedOrg("community");
    await sql`
      update organizations
      set branding = ${sql.json({ sponsors: [{ name: "Old Faithful", url: "https://of.example" }] } as never)}
      where id = ${auth.orgId}`;
    expect(await resolveSponsors(auth.orgId)).toEqual([]);
    expect(await resolveSponsors(auth.orgId, undefined, { tiered: false }), "the free strip too").toEqual([]);

    const row = await createSponsor(auth, {
      name: "New Row",
      tier: "partner",
      status: "active",
    });
    expect(await resolveSponsors(auth.orgId)).toEqual([
      { id: row.id, name: "New Row", url: null, logo: null, poster: null, tier: "partner" },
    ]);
  });

  // R4 S10 fix round 1, m6: V283 backfilled the blobs into rows but never cleared them, so falling back on zero active
  // rows brought every withdrawn sponsor back, untracked. Since fix batch 3 the blob is never read at all.
  it("m6: withdrawn sponsors never resurrect from the blob — rows that exist but none active resolve to NOTHING", async () => {
    const { auth } = await seedOrg("community");
    await sql`
      update organizations
      set branding = ${sql.json({ sponsors: [{ name: "Old Faithful", url: "https://of.example" }] } as never)}
      where id = ${auth.orgId}`;
    // No rows at all (fix batch 3: flipped by design): the blob is not read either.
    expect(await resolveSponsors(auth.orgId)).toEqual([]);

    const row = await createSponsor(auth, { name: "Backfilled", tier: "partner", status: "active" });
    expect((await resolveSponsors(auth.orgId)).map((s) => s.name)).toEqual(["Backfilled"]);
    // Withdrawn (both ways a row stops showing): the board is EMPTY, not the blob.
    let checked = 0;
    for (const status of ["inactive", "pending"] as const) {
      await patchSponsor(auth, row.id, { status });
      expect(await resolveSponsors(auth.orgId), status).toEqual([]);
      checked++;
    }
    expect(checked).toBe(2);
    // Reactivated: the row again, still no blob.
    await patchSponsor(auth, row.id, { status: "active" });
    expect((await resolveSponsors(auth.orgId)).map((s) => s.name)).toEqual(["Backfilled"]);
    // Deleted (final review 2, m9): no rows left, and the blob stays unread - a deleted sponsor never comes back from it.
    await deleteSponsor(auth, row.id);
    expect(await resolveSponsors(auth.orgId)).toEqual([]);
  });

  // Fix batch 3, m9 (a customer bug: deleted sponsors came back from V283's never-cleared blob). Sponsors come from the
  // `sponsors` table only, so an org that deletes its last sponsor shows NONE on every surface that rendered the blob:
  // the competition page's board and hero and the match page (resolveSponsors(org, competition, { tiered })), the free
  // strip (tiered: false), both slideshows (resolveSponsors(org, competition)), the org-wide read, the embed
  // (embedDivisionData) and the branded exports (orgBranding). A stray blob is planted on the org AND the competition
  // (a competition's branding is a free-form record, so a client can still write one there) and is never read.
  // Single sport on purpose: a sponsor belongs to an org and a competition, never a sport.
  it("m9: an org deletes its last sponsor and every surface that rendered the blob shows none - a stray blob on the org or the competition included (counts reported)", async () => {
    const { auth } = await seedOrg("pro");
    const s = randomUUID().slice(0, 8);
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: `Board Cup ${s}`, visibility: "public", branding: {} });
    await sql`
      insert into sports (key, name, module_version, position_catalog)
      values ('generic', 'Generic', '1.0.0', '{}') on conflict (key) do nothing`;
    const [{ id: divisionId }] = await sql<{ id: string }[]>`
      insert into divisions (org_id, competition_id, name, slug, sport_key, variant_key, status, config, module_version)
      values (${auth.orgId}, ${comp.id}, 'Open', ${`open-${s}`}, 'generic', 'score', 'active', '{}', '1.0.0')
      returning id`;
    const [{ name: orgName }] = await sql<{ name: string }[]>`select name from organizations where id = ${auth.orgId}`;
    await sql`
      update organizations set branding = ${sql.json({ sponsors: [{ name: "Old Faithful", url: "https://of.example" }] } as never)}
       where id = ${auth.orgId}`;
    await sql`update competitions set branding = ${sql.json({ sponsors: [{ name: "Cup Relic" }] } as never)} where id = ${comp.id}`;

    const names = (list: readonly { name: string }[] | undefined) => (list ?? []).map((x) => x.name);
    const SURFACES: readonly [string, () => Promise<string[]>][] = [
      ["competition page board + hero, match page (tiered)", async () => names(await resolveSponsors(auth.orgId, comp.id, { tiered: true }))],
      ["free strip (tiered: false)", async () => names(await resolveSponsors(auth.orgId, comp.id, { tiered: false }))],
      ["slideshows (competition, division)", async () => names(await resolveSponsors(auth.orgId, comp.id))],
      ["org-wide", async () => names(await resolveSponsors(auth.orgId))],
      ["embed", async () => {
        const res = await embedDivisionData(divisionId);
        if (!res.ok) throw new Error(`premise: the embed resolves (${res.reason})`);
        return names(res.data.sponsors);
      }],
      ["branded exports", async () => {
        const branding = await orgBranding(auth.orgId, orgName, comp.id);
        if (!branding) throw new Error("premise: a Pro org's exports are branded");
        return names(branding.sponsors);
      }],
    ];
    const board = async (label: string, expected: (surface: string) => string[]) => {
      let checked = 0;
      for (const [surface, read] of SURFACES) {
        expect(await read(), `${label}: ${surface}`).toEqual(expected(surface));
        checked++;
      }
      expect(checked, `${label}: anti-vacuity, every surface read`).toBe(6);
    };

    // The empty case first: no rows, so nothing - neither blob is read.
    await board("no rows", () => []);
    // The positive pair: rows show on every surface (the competition's first; the org-wide read sees only the org's).
    const first = await createSponsor(auth, { name: "Harbour Bank", tier: "gold", status: "active" });
    const second = await createSponsor(auth, { name: "Quay Cafe", tier: "partner", status: "active", competition_id: comp.id });
    await board("rows", (surface) => (surface === "org-wide" ? ["Harbour Bank"] : ["Quay Cafe", "Harbour Bank"]));

    // The org deletes every sponsor: every surface is empty, and a second read the same.
    await deleteSponsor(auth, second.id);
    await deleteSponsor(auth, first.id);
    expect((await sql<{ n: number }[]>`select count(*)::int as n from sponsors where org_id = ${auth.orgId}`)[0]!.n, "premise: no rows left").toBe(0);
    await board("after the last delete", () => []);
    await board("a second read", () => []);
  });

  it("m6: an org whose rows all belong to ANOTHER competition shows nothing on this one — not the blob", async () => {
    const { auth } = await seedOrg("pro");
    const [mine, theirs] = await Promise.all(
      ["Mine Cup", "Theirs Cup"].map((name) =>
        createCompetition(auth, { ends_on: "2030-12-31", name: `${name} ${randomUUID().slice(0, 6)}`, visibility: "public", branding: {} }),
      ),
    );
    await sql`
      update organizations
      set branding = ${sql.json({ sponsors: [{ name: "Blob Relic" }] } as never)}
      where id = ${auth.orgId}`;
    // The competition's OWN blob is under the same rule as the org's.
    await sql`
      update competitions
      set branding = ${sql.json({ sponsors: [{ name: "Comp Blob Relic" }] } as never)}
      where id = ${mine!.id}`;
    // No rows at all (fix batch 3: flipped by design): neither blob is read.
    expect(await resolveSponsors(auth.orgId, mine!.id)).toEqual([]);
    await createSponsor(auth, { name: "Their Gold", tier: "gold", status: "active", competition_id: theirs!.id });
    expect(await resolveSponsors(auth.orgId, mine!.id)).toEqual([]);
    expect((await resolveSponsors(auth.orgId, theirs!.id)).map((s) => s.name)).toEqual(["Their Gold"]);
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end();
});
