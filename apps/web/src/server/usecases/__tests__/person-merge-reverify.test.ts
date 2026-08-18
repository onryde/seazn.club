// #404 Task 5 — a merge can CREATE person-overlap in a board that was legal
// when it was published: two entrants holding the two duplicates, scheduled at
// the same time on different courts, become one human on two courts. The
// organiser has to be told.
//
// It must NOT be blocked by what it reveals (spec §5, the W4 delta rule):
// refusing would leave the duplicate in place AND the board still wrong. So the
// re-verify is a REPORT that runs after the merge transaction has committed —
// which is what the second test here pins.
//
// Real Postgres required: the board, its entrants and the repointed
// entrant_members rows are all database state.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { mergePersons } from "../person-merge";
import { publishSchedule } from "../schedule";
import { createStages, generateStageFixtures } from "../stages";
import { createCourt, createVenue } from "../venues";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

const rnd = () => randomUUID().slice(0, 8);
const MS_PER_MIN = 60_000;
/** Fixed instant so a run is never near a DST edge or a day boundary. */
const T0 = new Date("2026-09-05T10:00:00.000Z");

async function person(orgId: string, fullName: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name) values (${orgId}, ${fullName}) returning id`;
  return row!.id;
}

interface BoardRow {
  id: string;
  home_entrant_id: string;
  away_entrant_id: string;
}

/** Two real, distinct courts (P9: `fixtures.court_id` is a real FK into
 *  `courts`, so "different courts" can no longer be faked with two
 *  `court_label` strings — `reverifyBoards` reads `court_id`, per
 *  person-merge.ts's own comment on the filter this file exercises). */
async function twoCourts(auth: AuthCtx): Promise<{ a: string; b: string }> {
  const venue = await createVenue(auth, { name: "Reverify Venue " + rnd(), sort: 0 });
  const a = await createCourt(auth, venue.id, { name: "Court 1 " + rnd(), sort: 0, tags: [] });
  const b = await createCourt(auth, venue.id, { name: "Court 2 " + rnd(), sort: 1, tags: [] });
  return { a: a.id, b: b.id };
}

/**
 * A four-entrant league with two fixtures on the timetable that share no
 * entrant — the board is legal before the merge whatever the gap is, because
 * rest defaults to 0 and the two cards sit on different courts.
 *
 * `minutesApart` 0 puts them on top of each other, which is what a merge turns
 * into one human on two courts.
 */
async function seedBoard(
  auth: AuthCtx,
  opts: { minutesApart: number; publish: boolean },
): Promise<{ divisionId: string; first: BoardRow; second: BoardRow }> {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Reverify Cup " + rnd(),
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open " + rnd(),
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
  await createEntrants(
    auth,
    division.id,
    ["A", "B", "C", "D"].map((name, i) => ({
      kind: "individual" as const,
      display_name: name,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "L",
    config: {},
  });
  await generateStageFixtures(auth, stage!.id);

  const rows = await sql<BoardRow[]>`
    select id, home_entrant_id, away_entrant_id from fixtures
    where division_id = ${division.id} order by round_no, seq_in_round, id`;
  const first = rows[0]!;
  // The other card must share NO entrant with the first, or the pair is already
  // an overlap before anything is merged and the test proves nothing.
  const second = rows.find(
    (r) =>
      r.home_entrant_id !== first.home_entrant_id &&
      r.home_entrant_id !== first.away_entrant_id &&
      r.away_entrant_id !== first.home_entrant_id &&
      r.away_entrant_id !== first.away_entrant_id,
  )!;
  expect(second, "no disjoint second fixture in the generated league").toBeTruthy();

  const second_at = new Date(T0.getTime() + opts.minutesApart * MS_PER_MIN);
  // P9: `court_label` is frozen (never written post-cutover) — `court_id` is
  // what `reverifyBoards`/`toAssignment` read, so the "different courts" half
  // of this scenario has to be real court rows now, not two label strings.
  const courts = await twoCourts(auth);
  await sql`update fixtures set scheduled_at = ${T0}, court_id = ${courts.a} where id = ${first.id}`;
  await sql`update fixtures set scheduled_at = ${second_at}, court_id = ${courts.b} where id = ${second.id}`;

  if (opts.publish) await publishSchedule(auth, division.id);
  return { divisionId: division.id, first, second };
}

async function joinEntrant(entrantId: string, personId: string): Promise<void> {
  await sql`insert into entrant_members (entrant_id, person_id) values (${entrantId}, ${personId})`;
}

// P9 sweep (pass 3c-4): `reverifyBoards`'s assignment filter (person-merge.ts)
// used to gate on `court_label`, which nothing has written since pass 3a — a
// fixture scheduled with a real `court_id` but a NULL `court_label` (the only
// state a post-cutover fixture can be in; the column is frozen, never a stale
// non-null value) was silently dropped from `assignments`, so the whole board
// skipped re-verification. `court_label` is a presence check there, not a
// value comparison, so a *disagreeing* non-null label cannot distinguish old
// code from new — a non-null stale label still satisfies the old
// `court_label !== null`. NULL is the only input that discriminates, which is
// exactly what `seedBoard` below now seeds (real `court_id` via `twoCourts`,
// `court_label` never written). The first test below and the round-order one
// further down both go red if person-merge.ts's filter is reverted to
// `court_label !== null` — that is this scenario's regression coverage.
describe.skipIf(!HAS_DB)("#404 re-verify published boards after a merge", () => {
  it("reports the person overlap the merge created on a published board", async () => {
    const { auth } = await seedOrg("pro");
    const { divisionId, first, second } = await seedBoard(auth, { minutesApart: 0, publish: true });
    const survivor = await person(auth.orgId, "Sam Doe");
    const absorbed = await person(auth.orgId, "Sam Doe");
    await joinEntrant(first.home_entrant_id, survivor);
    await joinEntrant(second.home_entrant_id, absorbed);

    const res = await mergePersons(auth, survivor, absorbed, { confirmedBy: auth.userId! });

    const board = res.revealed.find((r) => r.division_id === divisionId);
    expect(board, "the published board was not re-verified").toBeTruthy();
    const overlap = board!.conflicts.filter(
      (c) => c.reason === "person_overlap" && c.details?.personIds?.includes(survivor),
    );
    expect(overlap.length, `no person_overlap naming ${survivor}`).toBeGreaterThan(0);
    // The two cards are the pair the organiser has to move, each naming the
    // OTHER as its counterparty — never `kind` alone, which would pass with
    // the counterparty dropped.
    expect(new Set(overlap.map((c) => c.fixtureId))).toEqual(new Set([first.id, second.id]));
    expect(
      overlap.every((c) => c.details?.otherFixtureId === (c.fixtureId === first.id ? second.id : first.id)),
    ).toBe(true);
  });

  it("still commits the merge that revealed it", async () => {
    const { auth } = await seedOrg("pro");
    const { first, second } = await seedBoard(auth, { minutesApart: 0, publish: true });
    const survivor = await person(auth.orgId, "Ida Cross");
    const absorbed = await person(auth.orgId, "Ida Cross");
    await joinEntrant(first.home_entrant_id, survivor);
    await joinEntrant(second.home_entrant_id, absorbed);

    // No throw: a merge is never refused by what re-verifying reveals (§5) —
    // refusing would leave the duplicate in place and the board still wrong.
    const res = await mergePersons(auth, survivor, absorbed, { confirmedBy: auth.userId! });

    const [tomb] = await sql<{ merged_into: string | null }[]>`
      select merged_into from persons where id = ${absorbed}`;
    expect(tomb!.merged_into, "the merge rolled back").toBe(survivor);
    const [ledger] = await sql<{ id: string }[]>`
      select id from person_merges where id = ${res.merge_id}`;
    expect(ledger, "no ledger row — the merge rolled back").toBeTruthy();
  });

  it("reveals nothing when the two cards do not overlap", async () => {
    const { auth } = await seedOrg("pro");
    const { first, second } = await seedBoard(auth, { minutesApart: 240, publish: true });
    const survivor = await person(auth.orgId, "Nell Fair");
    const absorbed = await person(auth.orgId, "Nell Fair");
    await joinEntrant(first.home_entrant_id, survivor);
    await joinEntrant(second.home_entrant_id, absorbed);

    const res = await mergePersons(auth, survivor, absorbed, { confirmedBy: auth.userId! });

    expect(res.revealed).toEqual([]);
  });

  it("does not report a board that was never published", async () => {
    const { auth } = await seedOrg("pro");
    const { first, second } = await seedBoard(auth, { minutesApart: 0, publish: false });
    const survivor = await person(auth.orgId, "Ola Draft");
    const absorbed = await person(auth.orgId, "Ola Draft");
    await joinEntrant(first.home_entrant_id, survivor);
    await joinEntrant(second.home_entrant_id, absorbed);

    const res = await mergePersons(auth, survivor, absorbed, { confirmedBy: auth.userId! });

    // Same overlapping cards as the first test — the only difference is that
    // the division is still in setup, so no organiser has published it.
    expect(res.revealed).toEqual([]);
  });

  // C1 follow-up (2026-08-12, task 2 item 1): `reverifyBoards`'s own
  // `toAssignment` call used to run with no `roundRobinStageIds` 4th
  // argument, so `roundNo` NEVER reached the `Assignment`s it validates —
  // round order was structurally invisible to this report regardless of
  // what the board actually looked like. Unlike the person-overlap tests
  // above, the merge itself is incidental here: round order is a property
  // of a fixture's TIME and ROUND alone, entirely independent of which
  // entrant plays in it, so merging two persons cannot CREATE a round-order
  // violation — it can only reveal one that was already on a board the
  // survivor happens to appear on, exactly the "reported, never enforced"
  // framing `reverifyBoards`'s own doc comment already carries for every
  // other family.
  it("reveals a pre-existing round-order violation on a published board the survivor appears on", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Reverify Order Cup " + rnd(),
      visibility: "public",
      branding: {},
    });
    const division = await createDivision(auth, comp.id, {
      name: "Open " + rnd(),
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
      eligibility: [],
    });
    await createEntrants(
      auth,
      division.id,
      ["A", "B", "C", "D"].map((name, i) => ({
        kind: "individual" as const,
        display_name: name,
        seed: i + 1,
        members: [],
      })),
    );
    const [stage] = await createStages(auth, division.id, {
      seq: 1,
      kind: "league",
      name: "L",
      config: {},
    });
    await generateStageFixtures(auth, stage!.id);

    const rows = await sql<(BoardRow & { round_no: number })[]>`
      select id, home_entrant_id, away_entrant_id, round_no from fixtures
      where division_id = ${division.id} order by round_no, seq_in_round, id`;
    const round1 = rows.find((r) => r.round_no === 1)!;
    const round2 = rows.find((r) => r.round_no === 2)!;
    expect(round1, "no round 1 fixture in the generated league").toBeTruthy();
    expect(round2, "no round 2 fixture in the generated league").toBeTruthy();

    // Scheduled IN ORDER and published while legal. Task 3 (G1) wired
    // `roundRobinStageIds` into `validateScheduleIn`, so `publishSchedule`'s
    // own gate now sees round order too — the disordered board this test
    // used to smuggle straight past a blind gate would now be REFUSED at
    // this very call (`schedule-publish-gate.test.ts` pins that half: a
    // round-robin board with an out-of-order round is refused at publish).
    // So: publish while legal, then corrupt the board AFTER — standing in
    // for whatever might do that to a live board later (a direct edit, an
    // incident), the same "was legal when published, wrong now" shape
    // `seedBoard`'s person-overlap scenario above already relies on, just
    // reached with a straight SQL edit instead of a merge, since merging
    // people cannot change a fixture's time or round (only reveal what
    // time/round already made true — see this test's own header comment).
    const courts = await twoCourts(auth);
    await sql`update fixtures set scheduled_at = ${T0}, court_id = ${courts.a} where id = ${round1.id}`;
    await sql`
      update fixtures set scheduled_at = ${new Date(T0.getTime() + 60 * MS_PER_MIN)}, court_id = ${courts.b}
      where id = ${round2.id}`;
    await publishSchedule(auth, division.id);

    // NOW corrupt it — straight to the table, not through `applySchedule` or
    // `moveFixture`: the round-order-aware write gate (this same fix) would
    // refuse either path (same technique
    // schedule-reflow-verifier-widening.test.ts's own court-clash test
    // uses, for the identical reason). Round 2 now starts an hour before
    // round 1: round order requires round 1 <= round 2, so this is a
    // direct, unambiguous H6 breach, on two DIFFERENT courts (court_id
    // is untouched by this second write) so no incidental court clash
    // rides along.
    await sql`
      update fixtures set scheduled_at = ${new Date(T0.getTime() - 60 * MS_PER_MIN)}
      where id = ${round2.id}`;

    // The survivor only needs to APPEAR on this board — `reverifyBoards`
    // reports the board's WHOLE conflict set, not merely conflicts naming
    // the merged person, so joining an entrant not otherwise involved in
    // the violating pair is deliberate: it proves the round-order
    // conflict surfaces because the report re-verifies the board's
    // fixtures with `roundNo` correctly attached, not because it happens
    // to name the survivor.
    const bystander = rows.find((r) => r.id !== round1.id && r.id !== round2.id)!;
    const survivor = await person(auth.orgId, "Uma Round");
    const absorbed = await person(auth.orgId, "Uma Round");
    await joinEntrant(bystander.home_entrant_id, survivor);
    await joinEntrant(bystander.home_entrant_id, absorbed);

    const res = await mergePersons(auth, survivor, absorbed, { confirmedBy: auth.userId! });

    const board = res.revealed.find((r) => r.division_id === division.id);
    expect(board, "the published board was not re-verified").toBeTruthy();
    const order = board!.conflicts.filter((c) => c.reason === "order");
    expect(order.length, "no round-order conflict reported — roundNo did not reach validateAssignments").toBeGreaterThan(0);
    expect(order.some((c) => c.fixtureId === round2.id)).toBe(true);
  });

  it("commits the merge even when re-verifying the board throws", async () => {
    const { auth } = await seedOrg("pro");
    const { divisionId, first, second } = await seedBoard(auth, { minutesApart: 0, publish: true });
    const survivor = await person(auth.orgId, "Rex Broke");
    const absorbed = await person(auth.orgId, "Rex Broke");
    await joinEntrant(first.home_entrant_id, survivor);
    await joinEntrant(second.home_entrant_id, absorbed);
    // A settings row `loadSettings` cannot parse: the report path throws before
    // it reaches the verifier. The merge has already committed by then, and a
    // failed REPORT may never undo a completed write.
    await sql`
      insert into schedule_settings (division_id, org_id, config)
      values (${divisionId}, ${auth.orgId}, ${sql.json({ matchMinutes: "banana" } as never)})
      on conflict (division_id) do update set config = excluded.config`;

    const res = await mergePersons(auth, survivor, absorbed, { confirmedBy: auth.userId! });

    expect(res.revealed).toEqual([]);
    const [tomb] = await sql<{ merged_into: string | null }[]>`
      select merged_into from persons where id = ${absorbed}`;
    expect(tomb!.merged_into, "a failed report rolled the merge back").toBe(survivor);
  });

  // #14 sibling fix: `RevealedConflicts.conflicts` carries the engine
  // `Conflict` verbatim, and `withLegacyDetail` derives its prose from
  // `details.courtName ?? details.court` — `courtName` is only ever
  // caller-attached, never set by the engine (conflict-detail.ts). Before
  // the fix, `reverifyBoards` never attached it, so a revealed
  // `court_double_booking` showed the organiser a raw court uuid. Two
  // venues share a bare court name here — legal, the unique index is
  // scoped per venue — specifically so the resolved name proves it went
  // through the SAME venue-qualifying rule as every other #14 surface, not
  // a coincidental bare match.
  it("#14: a revealed court_double_booking names the venue-qualified court, never a raw uuid", async () => {
    const { auth } = await seedOrg("pro");
    const venueA = await createVenue(auth, { name: "Riverside", sort: 0 });
    const venueB = await createVenue(auth, { name: "Lakeside", sort: 1 });
    const courtA = await createCourt(auth, venueA.id, { name: "Court 1", sort: 0, tags: [] });
    const courtOther = await createCourt(auth, venueA.id, { name: "Court 2", sort: 1, tags: [] });
    await createCourt(auth, venueB.id, { name: "Court 1", sort: 0, tags: [] });

    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Reverify Court Cup " + rnd(),
      visibility: "public",
      branding: {},
    });
    const division = await createDivision(auth, comp.id, {
      name: "Open " + rnd(),
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
      eligibility: [],
    });
    await createEntrants(
      auth,
      division.id,
      ["A", "B", "C", "D"].map((name, i) => ({
        kind: "individual" as const,
        display_name: name,
        seed: i + 1,
        members: [],
      })),
    );
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "L", config: {} });
    await generateStageFixtures(auth, stage!.id);
    const rows = await sql<BoardRow[]>`
      select id, home_entrant_id, away_entrant_id from fixtures
      where division_id = ${division.id} order by round_no, seq_in_round, id`;
    const first = rows[0]!;
    const second = rows.find(
      (r) =>
        r.home_entrant_id !== first.home_entrant_id &&
        r.home_entrant_id !== first.away_entrant_id &&
        r.away_entrant_id !== first.home_entrant_id &&
        r.away_entrant_id !== first.away_entrant_id,
    )!;
    expect(second, "no disjoint second fixture in the generated league").toBeTruthy();

    // Legal at publish time — different courts, same instant (mirrors
    // seedBoard's own minutesApart:0 pattern): assertPublishable would
    // refuse a board that ALREADY has a conflict, so the double-booking
    // must not exist yet here.
    await sql`update fixtures set scheduled_at = ${T0}, court_id = ${courtA.id} where id = ${first.id}`;
    await sql`update fixtures set scheduled_at = ${T0}, court_id = ${courtOther.id} where id = ${second.id}`;
    await publishSchedule(auth, division.id);

    // NOW move `second` onto the SAME court as `first` — direct SQL,
    // bypassing moveFixture's own conflict checks, the same way this
    // file's "commits the merge even when re-verifying the board throws"
    // test pokes schedule_settings directly: a published board can still
    // develop a real problem some other way, and reverifyBoards — not the
    // publish gate — is what has to catch it on the next merge.
    await sql`update fixtures set court_id = ${courtA.id} where id = ${second.id}`;

    const survivor = await person(auth.orgId, "Merge Court " + rnd());
    const absorbed = await person(auth.orgId, "Merge Court " + rnd());
    // The survivor just needs SOME entrant membership in this division so
    // reverifyBoards picks it up — validateAssignments checks the WHOLE
    // board, so the pre-existing double-booking surfaces regardless of
    // whether the merge itself touched these two fixtures.
    await joinEntrant(first.home_entrant_id, survivor);
    await joinEntrant(second.home_entrant_id, absorbed);

    const res = await mergePersons(auth, survivor, absorbed, { confirmedBy: auth.userId! });
    const board = res.revealed.find((r) => r.division_id === division.id);
    expect(board, "the published board was not re-verified").toBeTruthy();
    const dbl = board!.conflicts.filter((c) => c.details?.kind === "court_double_booking");
    expect(dbl.length, "no court_double_booking conflict").toBeGreaterThan(0);
    for (const c of dbl) {
      expect(c.details?.courtName).toBe("Court 1 (Riverside)");
      expect(c.detail).toContain("Court 1 (Riverside)");
      // `otherFixtureId` legitimately rides in the SAME legacy sentence
      // ("... double-booked with <fixture uuid>") — only the courtName
      // field itself is under test for "never a bare uuid".
      expect(c.details?.courtName ?? "").not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    }
  });
});
