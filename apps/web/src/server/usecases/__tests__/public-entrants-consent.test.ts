// publicEntrants (API v1, GET /api/v1/public/orgs/.../entrants — fully
// anonymous) — RS008 review fix #4 (Important): display_name (a non-team
// entrant's own name) was masked by division youth policy ONLY. A person's
// explicit /me opt-out (consent.public_name === false) never reached this
// endpoint, unlike every other public display_name site this session has
// already swept (entry-card.tsx, publicRegistrationStatus/ByRef,
// buildAdmitTicketsDoc, buildDivisionSlides).
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { GENERIC_CONFIG, seedOrg } from "./_seed";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { publicEntrants } from "../public";

const HAS_DB = !!process.env.DATABASE_URL;

async function setup() {
  const { auth } = await seedOrg("pro");
  const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`
    select slug from organizations where id = ${auth.orgId}`;
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Public Entrants Consent",
    visibility: "public", // required: public_entrants_v filters on this
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  return { auth, orgId: auth.orgId, orgSlug, compSlug: comp.slug, division };
}

describe.skipIf(!HAS_DB)("publicEntrants — consent masking (RS008 review fix #4)", () => {
  it("masks a non-team entrant's display_name when its linked person opted out — even on a non-youth division", async () => {
    const { auth, orgId, orgSlug, compSlug, division } = await setup();
    const [{ id: personId }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, consent)
      values (${orgId}, 'Arun Kumar', ${sql.json({ public_name: false } as never)})
      returning id`;
    await createEntrants(auth, division.id, [
      {
        kind: "individual",
        display_name: "Arun Kumar",
        seed: 1,
        members: [{ person_id: personId, is_captain: false, roles: [] }],
      },
      { kind: "individual", display_name: "Dev Patel", seed: 2, members: [] },
    ]);

    const out = (await publicEntrants(orgSlug, compSlug, division.slug)) as {
      entrants: { display_name: string }[];
    };
    const names = out.entrants.map((e) => e.display_name);
    expect(names).not.toContain("Arun Kumar");
    expect(names).toContain("Arun K.");
    // Per-entrant, not blanket: the non-opted-out entrant stays full.
    expect(names).toContain("Dev Patel");
  });

  it("never masks a TEAM's own display_name by a roster member's opt-out", async () => {
    const { auth, orgId, orgSlug, compSlug, division } = await setup();
    const [{ id: personId }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, consent)
      values (${orgId}, 'Cap Tain', ${sql.json({ public_name: false } as never)})
      returning id`;
    await createEntrants(auth, division.id, [
      {
        kind: "team",
        display_name: "Thunder Strikers",
        seed: 1,
        members: [{ person_id: personId, is_captain: true, roles: [] }],
      },
    ]);

    const out = (await publicEntrants(orgSlug, compSlug, division.slug)) as {
      entrants: { display_name: string }[];
    };
    expect(out.entrants.map((e) => e.display_name)).toContain("Thunder Strikers");
  });
});
