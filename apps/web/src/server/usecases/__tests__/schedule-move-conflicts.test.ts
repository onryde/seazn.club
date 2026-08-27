// #461 — a move returns the conflicts it already computed.
//
// `moveFixture` builds a full conflict report for the destination slot, uses it
// for `assertNoNewBlocking`, and then throws it away: the function was
// `Promise<void>`. Blocking conflicts 409, so an organiser hears about those.
// WARN-level ones — rest shortfalls, a stored typed rule, a session-window
// breach — were computed and dropped on the floor, so an API client dragging a
// card was told nothing at all about the board it had just created.
//
// THE BOARD BELOW ALSO COVERS #462's FOURTH CALL SITE. `moveFixture` is one of
// the four places sibling assignments reach the verifier, and it was the one
// site whose fix could not be asserted while the function returned nothing. The
// cap here is competition-scoped and breaks ONLY once the sibling division's
// card is counted, so a regression in either fix reds this file.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import type { HardConstraint } from "@seazn/engine/scheduling";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { PatchedFixture } from "@/server/api-v1/schemas";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages } from "../stages";
import { applySchedule, moveFixture } from "../schedule";
import { patchFixture } from "../fixtures";
import { createVenue, createCourt } from "../venues";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

const TZ = "Europe/London";
const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

const DAY = "2026-08-10";
/** A second day, well clear of the cap, for the "clean move" case. */
const OTHER_DAY = "2026-08-12";
const at = (ymd: string, hhmm: string): string => `${ymd}T${hhmm}:00.000Z`;

/** Competition-wide, count 2. This division holds one card on `DAY` and the
 *  sibling division holds one; a third lands the day over the cap. Warn-only —
 *  an instruction conflict is deliberately absent from `isBlockingConflict`, so
 *  the move is ACCEPTED and the conflicts are the only thing that can report it. */
const DAY_CAP: HardConstraint[] = [
  { type: "max_fixtures_per_day", count: 2, scope: { kind: "competition" } },
];

const SIBLING_COURT = "Far Court";

// P9 pass 3a: `courts`/`slot.court` below are real courts.id values now —
// ScheduleConfig.courts is CourtId[] since pass 1, fixtures.court_id
// carries a composite FK since V367/368. `makeDivision`/`addFixture` keep
// their generic `string`/`string[]` signatures; `seedBoard` resolves the
// readable "Court 1"/"Court 2"/SIBLING_COURT labels to real ids once.
function settingsConfig(courts: string[], hard: HardConstraint[]) {
  return {
    startAt: at(DAY, "08:00"),
    matchMinutes: 30,
    gapMinutes: 0,
    courts,
    perEntrantMinRest: 20,
    blackouts: [],
    sessionWindows: [],
    constraints: {
      restMin: 20,
      noBackToBack: false,
      startWindows: [],
      fieldFairness: "off",
      parallelism: "mixed",
      crossPersonClash: "warn",
      hard,
    },
  };
}

interface Div {
  id: string;
  stageId: string;
  entrantByName: Map<string, string>;
}

async function makeDivision(
  auth: AuthCtx,
  competitionId: string,
  slug: string,
  courts: string[],
  entrantNames: string[],
  hard: HardConstraint[],
): Promise<Div> {
  const division = await createDivision(auth, competitionId, {
    name: `Div ${slug}`,
    slug,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await sql`
    insert into schedule_settings (division_id, config, tz, updated_at)
    values (${division.id}, ${sql.json(settingsConfig(courts, hard))}, ${TZ}, now())
    on conflict (division_id) do update set config = excluded.config, tz = excluded.tz`;
  await createEntrants(
    auth,
    division.id,
    entrantNames.map((n, i) => ({
      kind: "individual" as const,
      display_name: n,
      seed: i + 1,
      members: [],
    })),
  );
  const rows = await sql<{ id: string; display_name: string }[]>`
    select id, display_name from entrants where division_id = ${division.id}`;
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "RR",
    config: {},
  });
  return {
    id: division.id,
    stageId: stage!.id,
    entrantByName: new Map(rows.map((r) => [r.display_name, r.id])),
  };
}

async function addFixture(
  auth: AuthCtx,
  d: Div,
  seq: number,
  extKey: string,
  home: string,
  away: string,
  slot: { at: string; court: string } | null,
  status = "scheduled",
): Promise<string> {
  const [f] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status,
                          home_entrant_id, away_entrant_id, scheduled_at, court_id)
    values (${d.stageId}, ${d.id}, ${auth.orgId}, 1, ${seq}, ${extKey}, ${status},
            ${d.entrantByName.get(home)!}, ${d.entrantByName.get(away)!},
            ${slot?.at ?? null}, ${slot?.court ?? null})
    returning id`;
  return f!.id;
}

/** Planned division: one card already on `DAY`, one card with no slot yet.
 *  Sibling division: one fixed card on `DAY`, on a court this division does not
 *  even have — so nothing physical stands in for the rule firing. */
async function seedBoard(): Promise<{ auth: AuthCtx; planned: Div; mover: string; court2: string }> {
  const { auth } = await seedOrg("pro");
  const tag = randomUUID().slice(0, 6);
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `Move Conflicts ${tag}`,
    visibility: "public",
    branding: {},
  });
  const venue = await createVenue(auth, { name: "Main", sort: 0 });
  const court1 = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
  const court2 = await createCourt(auth, venue.id, { name: "Court 2", sort: 1, tags: [] });
  const sibCourt = await createCourt(auth, venue.id, { name: SIBLING_COURT, sort: 2, tags: [] });
  const planned = await makeDivision(
    auth, comp.id, `planned-${tag}`, [court1.id, court2.id],
    ["A-1", "A-2", "A-3", "A-4"], DAY_CAP,
  );
  const sibling = await makeDivision(
    auth, comp.id, `sibling-${tag}`, [sibCourt.id], ["B-1", "B-2"], [],
  );
  await addFixture(auth, planned, 0, "a-f1", "A-1", "A-2", { at: at(DAY, "09:00"), court: court1.id });
  const mover = await addFixture(auth, planned, 1, "a-f2", "A-3", "A-4", null);
  await addFixture(
    auth, sibling, 0, "b-f1", "B-1", "B-2",
    { at: at(DAY, "14:00"), court: sibCourt.id }, "finalized",
  );
  return { auth, planned, mover, court2: court2.id };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("a move returns the conflicts it computes (#461)", () => {
  it("hands back the WARN-level conflicts a drag creates, and still writes", async () => {
    const { auth, mover, court2 } = await seedBoard();
    const conflicts = await moveFixture(auth, mover, {
      scheduled_at: at(DAY, "11:00"),
      court_id: court2,
    });

    // Non-empty and non-blocking — the two halves that make this reportable
    // rather than refusable. A blocking conflict would have thrown 409 and this
    // test would never reach here.
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.blocking).toBe(false);
    expect(conflicts[0]!.code).toBe("warn.instruction");
    expect(conflicts[0]!.fixture_id).toBe(mover);
    // THREE, not two: this division's own two cards plus the SIBLING division's
    // (#462, call site four). Two would mean the sibling's card was on the board
    // as court occupancy and invisible to the rule.
    expect(conflicts[0]!.details?.kind).toBe("instruction_day_cap");
    expect(conflicts[0]!.details?.count).toBe(3);
    expect(conflicts[0]!.details?.day).toBe(DAY);

    // The write happened anyway — a warn never refuses.
    const [row] = await sql<{ court_id: string }[]>`
      select court_id from fixtures where id = ${mover}`;
    expect(row!.court_id).toBe(court2);
  }, 120_000);

  it("returns an empty list for a move that breaks nothing", async () => {
    // The falsifier for the test above: if `moveFixture` returned a non-empty
    // list unconditionally, or the whole board's conflicts rather than this
    // move's, the assertion above would pass while meaning nothing.
    const { auth, mover, court2 } = await seedBoard();
    const conflicts = await moveFixture(auth, mover, {
      scheduled_at: at(OTHER_DAY, "09:00"),
      court_id: court2,
    });
    expect(conflicts).toEqual([]);
  }, 120_000);

  it("the PATCH payload carries them, exactly as the response schema declares", async () => {
    // `openapi:gen` regenerates the spec FROM the zod schema, and nothing applies
    // that schema at runtime — so a spec and a served body can disagree with both
    // gates green. The only thing that catches it is running the schema over the
    // real payload, which is what this does. `JSON.parse(JSON.stringify(...))` is
    // deliberate: postgres hands back `timestamptz` as a Date, and the WIRE is
    // what the schema describes.
    const { auth, mover, court2 } = await seedBoard();
    const out = await patchFixture(auth, mover, {
      scheduled_at: at(DAY, "11:00"),
      court_id: court2,
    });
    const wire = JSON.parse(JSON.stringify(out));

    expect(Object.keys(wire)).toContain("conflicts");
    expect(wire.conflicts).toHaveLength(1);
    expect(wire.conflicts[0].code).toBe("warn.instruction");
    // zod STRIPS unknown keys, so an equality against the parse result fails on
    // an undocumented extra field as well as on a missing declared one.
    expect(PatchedFixture.parse(wire)).toEqual(wire);
  }, 120_000);

  // C1 fix-loop (G2/3rd instance). `applySchedule`'s partial-apply path now
  // widens `mover`'s round-robin siblings (here, `a-f1` — same `planned`
  // stage, `kind: "league"`, already placed) into the delta gate's checked
  // set too, so it can detect a round-order violation the old code could
  // not. That widening must NOT leak `a-f1`'s own (now newly-visible) day-cap
  // conflict into the RETURNED list — `applySchedule`'s conflicts stay
  // "this apply's own listed fixtures" only, the same contract `moveFixture`
  // keeps above. The falsifier is the SAME shape as the first test in this
  // file: THREE on the tally (mover + a-f1 + the sibling division's card),
  // but ONE row back, named `mover` — not `a-f1`, and not two rows.
  it("applySchedule's partial-apply path keeps the same scoping: a widened sibling's own conflict is not returned", async () => {
    const { auth, planned, mover, court2 } = await seedBoard();
    const out = await applySchedule(auth, planned.stageId, {
      assignments: [{ fixture_id: mover, scheduled_at: at(DAY, "11:00"), court_id: court2 }],
      source: "manual",
    });
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0]!.blocking).toBe(false);
    expect(out.conflicts[0]!.code).toBe("warn.instruction");
    expect(out.conflicts[0]!.fixture_id).toBe(mover);
    expect(out.conflicts[0]!.details?.kind).toBe("instruction_day_cap");
    expect(out.conflicts[0]!.details?.count).toBe(3);
    expect(out.conflicts[0]!.details?.day).toBe(DAY);
  }, 120_000);
});

// P9 review #5 — venue_id must be DERIVED from the assigned court, server
// side, never trusted from the caller. Before this fix, applySchedule wrote
// `venue_id = coalesce(a.venue_id ?? null, venue_id)` — since no real client
// (use-board-actions.ts/ai-apply.ts/move-panel.tsx) ever sends venue_id, a
// freshly-scheduled fixture kept venue_id NULL forever, and a move to a court
// in a DIFFERENT venue left venue_id stuck on the OLD one. Every player-facing
// venue string (ICS LOCATION, /me, /my-matches, the public fixture page + its
// JSON-LD) derives from fixtures.venue_id, so this is user-visible, not
// cosmetic. `moveFixture` had the identical hole via `patch.venue_id`.
describe.skipIf(!HAS_DB)("venue_id is derived from the court, never trusted from the caller (#5)", () => {
  async function seedTwoVenues(slug: string) {
    const { auth } = await seedOrg("pro");
    const tag = randomUUID().slice(0, 6);
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: `Venue Derive ${slug} ${tag}`,
      visibility: "public",
      branding: {},
    });
    const venueA = await createVenue(auth, { name: "Hall A", sort: 0 });
    const venueB = await createVenue(auth, { name: "Hall B", sort: 1 });
    const courtA = await createCourt(auth, venueA.id, { name: "Court 1", sort: 0, tags: [] });
    const courtB = await createCourt(auth, venueB.id, { name: "Court 1", sort: 0, tags: [] });
    const d = await makeDivision(
      auth, comp.id, `${slug}-${tag}`, [courtA.id, courtB.id], ["X-1", "X-2"], [],
    );
    return { auth, d, venueA, venueB, courtA, courtB };
  }

  it("applySchedule stamps the assigned court's own venue_id, ignoring a disagreeing client-supplied one", async () => {
    const { auth, d, venueA, venueB, courtA, courtB } = await seedTwoVenues("apply");
    const f = await addFixture(auth, d, 0, "v-f1", "X-1", "X-2", null);

    // A client-supplied venue_id that DISAGREES with the court must be
    // ignored — this is the crux of the bug: the schema still accepts the
    // field (ApplyScheduleRequest's Assignment.venue_id is nullish), so a
    // caller CAN send a wrong one, and the server must win regardless.
    await applySchedule(auth, d.stageId, {
      assignments: [
        { fixture_id: f, scheduled_at: at(DAY, "09:00"), court_id: courtA.id, venue_id: venueB.id },
      ],
      source: "manual",
    });
    const [afterA] = await sql<{ court_id: string; venue_id: string | null }[]>`
      select court_id, venue_id from fixtures where id = ${f}`;
    expect(afterA!.court_id).toBe(courtA.id);
    expect(afterA!.venue_id).toBe(venueA.id);

    // Re-applying onto a court in a DIFFERENT venue must UPDATE venue_id —
    // the other half of the bug: the old `coalesce(a.venue_id, venue_id)`
    // left a fixture stuck on its stale venue after a cross-venue move.
    await applySchedule(auth, d.stageId, {
      assignments: [{ fixture_id: f, scheduled_at: at(DAY, "10:00"), court_id: courtB.id }],
      source: "manual",
    });
    const [afterB] = await sql<{ court_id: string; venue_id: string | null }[]>`
      select court_id, venue_id from fixtures where id = ${f}`;
    expect(afterB!.court_id).toBe(courtB.id);
    expect(afterB!.venue_id).toBe(venueB.id);
  }, 120_000);

  it("moveFixture stamps the target court's own venue_id, updates it on a cross-venue move, leaves it alone when the court is untouched, and clears it with the court", async () => {
    const { auth, d, venueA, venueB, courtA, courtB } = await seedTwoVenues("move");
    const f = await addFixture(
      auth, d, 0, "v-f2", "X-1", "X-2", { at: at(DAY, "09:00"), court: courtA.id },
    );
    // Seeded via a raw INSERT (like every other fixture in this file) —
    // venue_id starts NULL, untouched by moveFixture/applySchedule so far.
    const [before] = await sql<{ venue_id: string | null }[]>`select venue_id from fixtures where id = ${f}`;
    expect(before!.venue_id).toBeNull();

    await moveFixture(auth, f, { court_id: courtA.id });
    const [afterA] = await sql<{ venue_id: string | null }[]>`select venue_id from fixtures where id = ${f}`;
    expect(afterA!.venue_id).toBe(venueA.id);

    await moveFixture(auth, f, { court_id: courtB.id });
    const [afterB] = await sql<{ venue_id: string | null }[]>`select venue_id from fixtures where id = ${f}`;
    expect(afterB!.venue_id).toBe(venueB.id);

    // A move that never touches court_id (time-only) must not disturb venue_id.
    await moveFixture(auth, f, { scheduled_at: at(DAY, "12:00") });
    const [afterTimeOnly] = await sql<{ venue_id: string | null }[]>`
      select venue_id from fixtures where id = ${f}`;
    expect(afterTimeOnly!.venue_id).toBe(venueB.id);

    // Clearing the court must clear the derived venue too — never a stale
    // leftover once there is no court to derive it from.
    await moveFixture(auth, f, { court_id: null });
    const [afterClear] = await sql<{ court_id: string | null; venue_id: string | null }[]>`
      select court_id, venue_id from fixtures where id = ${f}`;
    expect(afterClear!.court_id).toBeNull();
    expect(afterClear!.venue_id).toBeNull();
  }, 120_000);
});
