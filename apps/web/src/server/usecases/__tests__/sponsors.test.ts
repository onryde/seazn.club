// Sponsor CRM (v10 PROMPT-56): CRUD + entitlement gates + resolver order.
// Tiers above partner and per-competition scoping are Pro `sponsors.tiers`;
// the flat partner strip stays free. Real Postgres required.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
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

  it("resolveSponsors: table rows win over blob, scope + dedupe + rank", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Resolve Cup",
      visibility: "public",
      branding: {},
    });
    // Blob sponsors exist but must be ignored once table rows exist.
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

  it("resolveSponsors: blob shim only when the org has no rows", async () => {
    const { auth } = await seedOrg("community");
    await sql`
      update organizations
      set branding = ${sql.json({ sponsors: [{ name: "Old Faithful", url: "https://of.example" }] } as never)}
      where id = ${auth.orgId}`;
    const shim = await resolveSponsors(auth.orgId);
    expect(shim).toEqual([
      {
        id: null,
        name: "Old Faithful",
        url: "https://of.example",
        logo: null,
        tier: "partner",
      },
    ]);

    await createSponsor(auth, {
      name: "New Row",
      tier: "partner",
      status: "active",
    });
    const rows = await resolveSponsors(auth.orgId);
    expect(rows.map((s) => s.name)).toEqual(["New Row"]);
  });

  // R4 S10 fix round 1, m6: "no rows AT ALL", as the doc says — never "no ACTIVE rows". V283 backfilled the blobs into
  // rows but never cleared them, so falling back on zero active rows brought every withdrawn sponsor back, untracked.
  it("m6: withdrawn sponsors never resurrect from the blob — rows that exist but none active resolve to NOTHING", async () => {
    const { auth } = await seedOrg("community");
    await sql`
      update organizations
      set branding = ${sql.json({ sponsors: [{ name: "Old Faithful", url: "https://of.example" }] } as never)}
      where id = ${auth.orgId}`;
    // The positive pair first: an org with no rows at all reads its blob.
    expect((await resolveSponsors(auth.orgId)).map((s) => [s.id, s.name])).toEqual([[null, "Old Faithful"]]);

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
    // Deleted — the org has no rows at all again, so the blob is all it has.
    await deleteSponsor(auth, row.id);
    expect((await resolveSponsors(auth.orgId)).map((s) => s.name)).toEqual(["Old Faithful"]);
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
    // Positive pair first: with no rows at all, both blobs read — the competition's first.
    expect((await resolveSponsors(auth.orgId, mine!.id)).map((s) => s.name)).toEqual(["Comp Blob Relic", "Blob Relic"]);
    await createSponsor(auth, { name: "Their Gold", tier: "gold", status: "active", competition_id: theirs!.id });
    expect(await resolveSponsors(auth.orgId, mine!.id)).toEqual([]);
    expect((await resolveSponsors(auth.orgId, theirs!.id)).map((s) => s.name)).toEqual(["Their Gold"]);
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end();
});
