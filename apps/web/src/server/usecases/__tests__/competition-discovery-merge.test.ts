// Settings C8 (owner 2026-11-11): competition settings no longer asks for a city or a country, but the Discover card still
// shows them and filters on the country. `patchCompetition` used to write `discovery` as a WHOLE column, so the form's
// next save - which now sends only the keys it still edits - would have erased the stored pair. `discovery` now merges
// key by key: a key the patch leaves out keeps its value, and only an explicit null clears one.
//
// Real Postgres; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition, patchCompetition } from "../competitions";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedOwner(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`loc-${suffix}@test.local`}, 'Owner', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Location Org " + suffix}, ${"location-org-" + suffix}, ${userId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
  return { orgId, via: "session", userId, role: "owner", keyId: null };
}

/** A competition whose stored discovery already holds a city and a country, as rows saved before 2026-11-11 do. */
async function located(owner: AuthCtx, discovery: Record<string, unknown> = { city: "Harbour Vale", country: "United Kingdom" }) {
  const c = await createCompetition(owner, {
    name: "Winter Open " + randomUUID().slice(0, 6),
    ends_on: "2030-12-31",
    visibility: "public",
    branding: {},
  });
  await sql`update competitions set discovery = ${sql.json(discovery as never)} where id = ${c.id}`;
  return c.id;
}

const storedDiscovery = async (id: string) =>
  (await sql<{ discovery: Record<string, unknown> | null }[]>`select discovery from competitions where id = ${id}`)[0]!
    .discovery;

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end();
});

describe.skipIf(!HAS_DB)("patchCompetition — discovery merges, so a save that no longer sends city/country keeps them", () => {
  it("a patch carrying only the branding keys keeps the stored city and country", async () => {
    const owner = await seedOwner();
    const id = await located(owner);
    await patchCompetition(owner, id, { discovery: { tagline: null, hero_image_path: null } });
    expect(await storedDiscovery(id)).toEqual({
      city: "Harbour Vale",
      country: "United Kingdom",
      tagline: null,
      hero_image_path: null,
    });
  });

  it("a second save keeps them too (the sequence, not just one call)", async () => {
    const owner = await seedOwner();
    const id = await located(owner);
    await patchCompetition(owner, id, { name: "Renamed once", discovery: { tagline: null } });
    await patchCompetition(owner, id, { name: "Renamed twice", discovery: { hero_image_path: null } });
    const d = await storedDiscovery(id);
    expect(d?.city).toBe("Harbour Vale");
    expect(d?.country).toBe("United Kingdom");
  });

  it("a patch with no discovery at all leaves the column exactly as stored", async () => {
    const owner = await seedOwner();
    const id = await located(owner);
    const before = await storedDiscovery(id);
    await patchCompetition(owner, id, { name: "Only the name" });
    expect(await storedDiscovery(id)).toEqual(before);
  });

  it("positive pair: an explicit null still clears ONE key, and only that key", async () => {
    const owner = await seedOwner();
    const id = await located(owner);
    await patchCompetition(owner, id, { discovery: { city: null } });
    expect(await storedDiscovery(id)).toEqual({ city: null, country: "United Kingdom" });
  });

  it("empty case: a competition with nothing stored (the column's '{}' default) takes the patch as its whole blob", async () => {
    const owner = await seedOwner();
    const id = await located(owner, {});
    expect(await storedDiscovery(id), "premise: nothing stored").toEqual({});
    await patchCompetition(owner, id, { discovery: { tagline: null } });
    expect(await storedDiscovery(id)).toEqual({ tagline: null });
  });
});
