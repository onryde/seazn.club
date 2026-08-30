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

  // Code-review fix (2026-08-30, item 5) — members[].name used to come off
  // public_entrants_v's own public_person_name() column, which fails CLOSED
  // (absent/{} consent reads as opted-out, masked to "Q.C." initials-only) —
  // the opposite of resolvePersonDisplayName's "absence never masks"
  // contract this endpoint's own display_name has followed since RS008
  // review fix #4. Re-derived through the SAME resolver now.
  it("members[].name follows resolvePersonDisplayName's polarity — absence never masks, an explicit opt-out still does", async () => {
    const { auth, orgId, orgSlug, compSlug, division } = await setup();
    const [{ id: quietId }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, consent)
      values (${orgId}, 'Quiet Consent', ${sql.json({})})
      returning id`;
    const [{ id: optedOutId }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, consent)
      values (${orgId}, 'Opted Out', ${sql.json({ public_name: false } as never)})
      returning id`;
    await createEntrants(auth, division.id, [
      {
        kind: "team",
        display_name: "Roster Team",
        seed: 1,
        members: [
          { person_id: quietId, squad_number: 1, is_captain: false, roles: [] },
          { person_id: optedOutId, squad_number: 2, is_captain: false, roles: [] },
        ],
      },
    ]);

    const out = (await publicEntrants(orgSlug, compSlug, division.slug)) as {
      entrants: { display_name: string; members: { name: string }[] }[];
    };
    const team = out.entrants.find((e) => e.display_name === "Roster Team")!;
    const names = team.members.map((m) => m.name);
    expect(names).toContain("Quiet Consent"); // {} consent never masks
    expect(names).toContain("Opted O."); // explicit opt-out still does
  });

  // Code-review fix (2026-08-30, item 5(b)) — publicEntrants used to
  // reimplement maskPublicEntrantNames's own query+masking inline; this pins
  // that it now genuinely calls the shared helper by exercising the ONE
  // behaviour only maskPublicEntrantNames's own opted_out field can prove —
  // if this reddens, publicEntrants stopped calling the shared function.
  it("exposes opted_out on each entrant — the field only maskPublicEntrantNames sets", async () => {
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
      entrants: { display_name: string; opted_out: boolean }[];
    };
    const arun = out.entrants.find((e) => e.display_name === "Arun K.")!;
    const dev = out.entrants.find((e) => e.display_name === "Dev Patel")!;
    expect(arun.opted_out).toBe(true);
    expect(dev.opted_out).toBe(false);
  });
});
