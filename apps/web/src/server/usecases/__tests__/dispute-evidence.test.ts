// Dispute evidence pack (buildDisputeEvidence): one HTML document carrying
// the registration record, the reconstructed confirmation email, the audit
// trail and the entrant's fixtures — fails without the usecase. Real
// Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { buildDisputeEvidence } from "../registrations";
import { createVenue } from "../venues";

const HAS_DB = !!process.env.DATABASE_URL;

const DIVISION_CONFIG = { points: { w: 3, d: 1, l: 0 }, progressScore: false };

async function seed(): Promise<{ owner: AuthCtx; orgId: string; divisionId: string; compId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name)
    values (${`owner-${suffix}@test.local`}, 'owner') returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Evidence Org " + suffix}, ${"ev-org-" + suffix}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json({ resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false })}, true)
    on conflict do nothing`;
  const owner: AuthCtx = { orgId, via: "session", userId: ownerId, role: "owner", keyId: null };
  const competition = await createCompetition(owner, {
    ends_on: "2030-12-31",
    name: `Evidence Cup ${suffix}`,
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(owner, competition.id, {
    name: "Open", sport_key: "generic", variant_key: "score",
    config: DIVISION_CONFIG, 
  });
  return { owner, orgId, divisionId: division.id, compId: competition.id };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("dispute evidence pack", () => {
  it("finds a placed solo sign-up's fixtures through the team that fielded them (RS009)", async () => {
    // A solo sign-up has NO entrant of its own — design section 6 has them
    // fielded through the team they were assigned to. Keying "service
    // provided" on reg.entrant_id therefore produced ZERO fixtures for
    // someone who actually played: the weakest possible answer in the one
    // document whose entire job is proving they did.
    const { owner, orgId, divisionId, compId } = await seed();
    const ref = `SZ-SA${randomUUID().slice(0, 6).toUpperCase()}`;

    // The team that will field them, with a real entrant and a real fixture.
    const [{ id: entrantId }] = await sql<{ id: string }[]>`
      insert into entrants (division_id, kind, display_name, status)
      values (${divisionId}, 'team', 'Riverside Rovers', 'confirmed') returning id`;
    const [{ id: teamGroupId }] = await sql<{ id: string }[]>`
      insert into registration_groups
        (competition_id, contact_name, contact_email, access_token_hash, currency)
      values (${compId}, 'Captain', ${`cap-${randomUUID().slice(0, 6)}@test.local`},
              ${randomUUID()}, 'gbp')
      returning id`;
    const [{ id: teamRegId }] = await sql<{ id: string }[]>`
      insert into registrations (division_id, group_id, status, display_name, entrant_id)
      values (${divisionId}, ${teamGroupId}, 'confirmed', 'Riverside Rovers', ${entrantId})
      returning id`;
    const [{ id: stageId }] = await sql<{ id: string }[]>`
      insert into stages (division_id, org_id, seq, kind, name)
      values (${divisionId}, ${orgId}, 1, 'league', 'League') returning id`;
    // A UNIQUE venue name is the assertion target. The first version of this
    // test asserted `toContain("7")` for the round number, which an HTML
    // document contains by accident many times over — it passed with the bug
    // restored, and the mutant survived. A name nothing else can produce is
    // the difference between a test and a decoration.
    const venueName = `Evidence Ground ${randomUUID().slice(0, 8)}`;
    const venue = await createVenue(owner, { name: venueName, sort: 0 });
    await sql`
      insert into fixtures
        (stage_id, division_id, org_id, round_no, seq_in_round, fixture_no,
         home_entrant_id, venue_id)
      values (${stageId}, ${divisionId}, ${orgId}, 7, 1, 1, ${entrantId}, ${venue.id})`;

    // The solo sign-up: disputed, paid, and NO entrant of their own.
    const [{ id: groupId }] = await sql<{ id: string }[]>`
      insert into registration_groups
        (competition_id, contact_name, contact_email, access_token_hash, ref_code,
         currency, payment_method, payment_intent_id, disputed_at, dispute_id)
      values (${compId}, 'Solo Player', 'solo@example.com', ${randomUUID()}, ${ref},
              'gbp', 'stripe', 'pi_solo_1', now(), 'dp_solo_1')
      returning id`;
    const [{ id: regId }] = await sql<{ id: string }[]>`
      insert into registrations
        (division_id, group_id, status, display_name, amount_cents, free_agent)
      values (${divisionId}, ${groupId}, 'confirmed', 'Solo Player', 1200, true)
      returning id`;
    // ...placed onto that team.
    await sql`
      insert into registration_players
        (registration_id, org_id, full_name, source, assigned_from_registration_id)
      values (${teamRegId}, ${orgId}, 'Solo Player', 'organiser_assigned', ${regId})`;

    const pack = await buildDisputeEvidence(owner, regId, "https://test.local");
    expect(pack.html, "the fixture they were fielded in must appear").toContain(venueName);
    expect(pack.html).toContain(ref);
  });

  it("bundles registration, receipt reconstruction and activity log", async () => {
    const { owner, orgId, divisionId, compId } = await seed();
    const ref = `SZ-EV${randomUUID().slice(0, 6).toUpperCase()}`;
    // Contact/payment/dispute envelope lives on the cart (registration_groups).
    const [{ id: groupId }] = await sql<{ id: string }[]>`
      insert into registration_groups
        (competition_id, contact_name, contact_email, access_token_hash, ref_code,
         currency, payment_method, payment_intent_id, disputed_at, dispute_id)
      values
        (${compId}, 'Alex Example', 'alex@example.com', ${randomUUID()}, ${ref},
         'gbp', 'stripe', 'pi_test_123', now(), 'dp_test_1')
      returning id`;
    const [{ id: regId }] = await sql<{ id: string }[]>`
      insert into registrations (division_id, group_id, status, display_name, amount_cents)
      values (${divisionId}, ${groupId}, 'confirmed', 'Alex Example', 2500)
      returning id`;
    await sql`
      insert into competition_events (competition_id, org_id, type, payload, actor_id)
      values (${compId}, ${orgId}, 'registration.paid',
              ${sql.json({ registration_id: regId })}, null)`;

    const pack = await buildDisputeEvidence(owner, regId, "https://test.local");
    expect(pack.ref).toBe(ref);
    expect(pack.html).toContain(ref);
    expect(pack.html).toContain("alex@example.com");
    expect(pack.html).toContain("pi_test_123");
    expect(pack.html).toContain("dp_test_1");
    // Receipt reconstruction carries the transactional email body.
    expect(pack.html).toContain("Registration received");
    // Activity log row made it in.
    expect(pack.html).toContain("registration.paid");
    // Export itself is audited.
    const [audit] = await sql`
      select 1 from competition_events
      where type = 'registration.evidence_exported'
        and payload->>'registration_id' = ${regId}`;
    expect(audit).toBeDefined();
  });

  // RS005 W4 — the sent confirmation is now cart-shaped (owner ruling
  // 2026-08-25), so the reconstruction must render the WHOLE cart, not just
  // the one entry a dispute happens to be filed against. Two entries in one
  // group, DELIBERATELY different statuses/fees, so a reconstruction that
  // silently collapsed back to one entry (or repeated one status for both)
  // would be caught the same way email-builders.test.ts's own multi-entry
  // test is.
  it("reconstructs the CART, not just the disputed entry — both entries, their own status/fee", async () => {
    const { owner, divisionId, compId } = await seed();
    const ref = `SZ-EV${randomUUID().slice(0, 6).toUpperCase()}`;
    const [{ id: groupId }] = await sql<{ id: string }[]>`
      insert into registration_groups
        (competition_id, contact_name, contact_email, access_token_hash, ref_code,
         amount_cents, currency, payment_method, payment_intent_id, disputed_at, dispute_id)
      values
        (${compId}, 'Cart Rep', 'cart-rep@example.com', ${randomUUID()}, ${ref},
         2500, 'gbp', 'stripe', 'pi_test_cart', now(), 'dp_test_cart')
      returning id`;
    const [{ id: disputedRegId }] = await sql<{ id: string }[]>`
      insert into registrations (division_id, group_id, status, display_name, amount_cents)
      values (${divisionId}, ${groupId}, 'confirmed', 'Disputed Entry', 2500)
      returning id`;
    await sql`
      insert into registrations (division_id, group_id, status, display_name, amount_cents)
      values (${divisionId}, ${groupId}, 'waitlisted', 'Sibling Entry', 0)`;

    // Called against the DISPUTED entry's id — proves the reconstruction
    // widens to the whole cart rather than staying scoped to it.
    const pack = await buildDisputeEvidence(owner, disputedRegId, "https://test.local");
    expect(pack.html).toContain("Disputed Entry");
    expect(pack.html).toContain("Sibling Entry");
    // The registration RECORD section still names the disputed entry alone
    // (its own row) — the CART widening is specifically in the confirmation
    // email reconstruction below it.
    expect(pack.html).toContain("Confirmed");
    expect(pack.html).toContain("Waitlisted");
    // paymentInstructions/payDeadline stay forced null in the reconstruction
    // (unchanged by this wave) — no stray "Pay now" button from a stale mint.
    expect(pack.html).not.toContain("Pay now");
  });

  // P9 sweep (pass 3c-4): the "fixtures for this entrant" section used to
  // SELECT fixtures.venue straight into the printed evidence document —
  // frozen since pass 3a, so a fixture played after the cutover printed a
  // blank venue line on a document organisers paste into an actual Stripe
  // dispute response.
  it("fixtures section shows the live venue name, not a disagreeing frozen venue", async () => {
    const { owner, orgId, divisionId, compId } = await seed();
    const [{ id: stageId }] = await sql<{ id: string }[]>`
      insert into stages (division_id, org_id, seq, kind, name)
      values (${divisionId}, ${orgId}, 1, 'league', 'League') returning id`;
    const [{ id: entrantId }] = await sql<{ id: string }[]>`
      insert into entrants (division_id, org_id, kind, display_name, seed)
      values (${divisionId}, ${orgId}, 'individual', 'Evidence Entrant', 1) returning id`;
    const venue = await createVenue(owner, { name: "Evidence Live Venue", sort: 0 });
    await sql`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round,
                            home_entrant_id, status, scheduled_at, venue_id, venue)
      values (${stageId}, ${divisionId}, ${orgId}, 1, 1,
              ${entrantId}, 'decided', now(), ${venue.id}, 'Stale Venue')`;

    const ref = `SZ-EV${randomUUID().slice(0, 6).toUpperCase()}`;
    const [{ id: groupId }] = await sql<{ id: string }[]>`
      insert into registration_groups
        (competition_id, contact_name, contact_email, access_token_hash, ref_code,
         currency, payment_method)
      values (${compId}, 'Evidence Entrant', 'evidence@example.com', ${randomUUID()}, ${ref},
              'gbp', 'offline')
      returning id`;
    const [{ id: regId }] = await sql<{ id: string }[]>`
      insert into registrations (division_id, group_id, status, display_name, entrant_id)
      values (${divisionId}, ${groupId}, 'confirmed', 'Evidence Entrant', ${entrantId})
      returning id`;

    const pack = await buildDisputeEvidence(owner, regId, "https://test.local");
    expect(pack.html).toContain("Evidence Live Venue");
    expect(pack.html).not.toContain("Stale Venue");
  });

  it("refuses another org's registration", async () => {
    const a = await seed();
    const b = await seed();
    const [{ id: groupId }] = await sql<{ id: string }[]>`
      insert into registration_groups
        (competition_id, contact_name, contact_email, amount_cents, currency,
         payment_method, access_token_hash, ref_code)
      values (${a.compId}, 'Alex', 'a@example.com', 0, 'gbp', 'offline',
              ${randomUUID()}, ${`SZ-XO${randomUUID().slice(0, 6).toUpperCase()}`})
      returning id`;
    const [{ id: regId }] = await sql<{ id: string }[]>`
      insert into registrations (division_id, group_id, status, display_name)
      values (${a.divisionId}, ${groupId}, 'confirmed', 'Alex')
      returning id`;
    await expect(buildDisputeEvidence(b.owner, regId, "https://test.local")).rejects.toThrow();
  });
});
