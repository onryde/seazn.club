// D4a (P5) blast-radius fix: card-stats.ts's "next fixture" widget LEFT JOINs
// home/away entrant names, so a fully-TBD fixture (both null — a seeded
// stage's not-yet-filled slot) with an earlier scheduled_at silently surfaced
// as the card's "next" match, blank home/away, no error. The fix: "next"
// requires BOTH sides assigned — the same precondition scoring already
// enforces (append-event.ts's WRONG_PHASE guard).
import { describe, expect, it, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { listCompetitionCardStats, listDivisionCardStats } from "../card-stats";
import { createCourt, createVenue } from "../venues";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("card-stats: TBD fixtures never surface as 'next' (D4a/P5)", () => {
  it("a fully-TBD fixture scheduled earlier is skipped in favour of the real upcoming match", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Card Stats TBD " + randomUUID().slice(0, 6),
      visibility: "private",
      branding: {},
    });
    const division = await createDivision(auth, comp.id, {
      name: "Open",
      slug: "open",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
    });
    const entrants = await createEntrants(auth, division.id, [
      { kind: "individual", display_name: "Real A", seed: 1, members: [] },
      { kind: "individual", display_name: "Real B", seed: 2, members: [] },
    ]);
    void entrants;
    const [stage] = await createStages(auth, division.id, {
      seq: 1,
      kind: "league",
      name: "League",
      config: {},
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    expect(fixtures).toHaveLength(1);
    const realFixtureId = fixtures[0]!.id;

    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    const today = new Date(Date.now() + 3_600_000).toISOString(); // an hour from now — earlier than tomorrow
    // P9: court_label is frozen (pass 3a) — the 'next' widget's court_label
    // JSON key is now DERIVED from court_id (card-stats.ts). Poisoning
    // court_label with a disagreeing value proves the read no longer falls
    // back to it.
    const venue = await createVenue(auth, { name: "Card Stats Venue", sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "Real Court", sort: 0, tags: [] });
    await sql`
      update fixtures set scheduled_at = ${tomorrow}, court_id = ${court.id}, court_label = 'Stale Court'
      where id = ${realFixtureId}`;

    // A fully-TBD placeholder fixture (both entrants null), scheduled EARLIER
    // than the real match — exactly the "final pinned on day one" scenario
    // the design calls for. Inserted directly: this test targets the READER,
    // not the seeded-stage generator (covered elsewhere).
    await sql`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round,
                            home_entrant_id, away_entrant_id, scheduled_at, court_label, status)
      values (${stage!.id}, ${division.id}, ${auth.orgId}, 2, 1,
              null, null, ${today}, 'TBD Court', 'scheduled')`;

    const divisionStats = await listDivisionCardStats(auth, comp.id);
    const divNext = divisionStats.get(division.id)?.next;
    expect(divNext, JSON.stringify(divNext)).not.toBeNull();
    expect(divNext!.court_label).toBe("Real Court");
    expect(divNext!.court_label).not.toBe("Stale Court");
    expect(divNext!.home).not.toBeNull();
    expect(divNext!.away).not.toBeNull();

    const competitionStats = await listCompetitionCardStats(auth);
    const compNext = competitionStats.get(comp.id)?.next;
    expect(compNext, JSON.stringify(compNext)).not.toBeNull();
    expect(compNext!.court_label).toBe("Real Court");
    expect(compNext!.court_label).not.toBe("Stale Court");
  });

  it("with ONLY a TBD fixture, next is null rather than a blank 'TBD vs TBD' row", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Card Stats TBD Only " + randomUUID().slice(0, 6),
      visibility: "private",
      branding: {},
    });
    const division = await createDivision(auth, comp.id, {
      name: "Open",
      slug: "open",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
    });
    const [stage] = await createStages(auth, division.id, {
      seq: 1,
      kind: "knockout",
      name: "Knockout",
      config: {},
    });
    await sql`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round,
                            home_entrant_id, away_entrant_id, scheduled_at, status)
      values (${stage!.id}, ${division.id}, ${auth.orgId}, 1, 1,
              null, null, ${new Date().toISOString()}, 'scheduled')`;

    const divisionStats = await listDivisionCardStats(auth, comp.id);
    expect(divisionStats.get(division.id)?.next).toBeNull();
  });

  // #14: a court name is unique only WITHIN its venue
  // (courts_venue_name_active_idx) — two DIFFERENT venues may legally share
  // one bare name. The card's "next" widget must disambiguate through the
  // SAME venue-qualifying rule the board/AI pack use, not show a bare
  // "Court 1" that could be either physical court — and never a bare uuid.
  it("#14: 'next' disambiguates a court name shared by two venues; never a bare uuid", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Card Stats Court " + randomUUID().slice(0, 6),
      visibility: "private",
      branding: {},
    });
    const division = await createDivision(auth, comp.id, {
      name: "Open",
      slug: "open",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
    });
    await createEntrants(auth, division.id, [
      { kind: "individual", display_name: "Real A", seed: 1, members: [] },
      { kind: "individual", display_name: "Real B", seed: 2, members: [] },
    ]);
    const [stage] = await createStages(auth, division.id, {
      seq: 1,
      kind: "league",
      name: "League",
      config: {},
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    expect(fixtures).toHaveLength(1);

    // Two venues, each with a court bare-named "Court 1" — legal per the
    // partial unique index, which is scoped per venue.
    const venueA = await createVenue(auth, { name: "Riverside", sort: 0 });
    const venueB = await createVenue(auth, { name: "Lakeside", sort: 1 });
    const courtA = await createCourt(auth, venueA.id, { name: "Court 1", sort: 0, tags: [] });
    await createCourt(auth, venueB.id, { name: "Court 1", sort: 0, tags: [] });
    await sql`
      update fixtures set scheduled_at = ${new Date(Date.now() + 3_600_000).toISOString()},
        court_id = ${courtA.id}
      where id = ${fixtures[0]!.id}`;

    const divisionStats = await listDivisionCardStats(auth, comp.id);
    const divNext = divisionStats.get(division.id)?.next;
    expect(divNext, JSON.stringify(divNext)).not.toBeNull();
    expect(divNext!.court_label).toBe("Court 1 (Riverside)");

    const competitionStats = await listCompetitionCardStats(auth);
    const compNext = competitionStats.get(comp.id)?.next;
    expect(compNext, JSON.stringify(compNext)).not.toBeNull();
    expect(compNext!.court_label).toBe("Court 1 (Riverside)");

    expect(divNext!.court_label ?? "").not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });
});
