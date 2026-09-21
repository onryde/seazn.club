// F10 (2026-09-21) — V412 and its six callers, against real Postgres.
//
// The defect: the public standings table printed a raw UUID where a withdrawn
// entrant's name belongs. `public_entrants_v` filtered
// `status in ('registered','confirmed')`, so the division page's `entrants`
// load never saw her and `entrantNames` had no entry — while the standings
// snapshot, keyed by entrant id and built from RESULTS, still carried the row
// she earned before she left.
//
// The fix moves that predicate OUT of the view and INTO the callers that
// actually mean "the current field". Which makes this file's job the whole
// seam, in both directions:
//
//   - the VIEW must publish the departed (or the name is still unresolvable);
//   - every caller that means "who is competing" must filter for itself (or a
//     withdrawal silently inflates the public entrant list and the headline
//     entrant count).
//
// One assertion without the other is half a fix, so every test below is a
// positive/negative pair over the SAME seeded division: four entrants, one per
// status the `entrants.status` check constraint allows.
//
// Real Postgres required; skipped without DATABASE_URL, the same convention as
// `competition-hub-db.test.ts`, whose seeding shape this reuses.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// `unstable_cache` is a Next server-runtime API with no incrementalCache
// outside a real request — passthrough, never a memoising double:
// `getPublicCompetition` and `getPublicPlayer` are both wrapped in it, and a
// memoised entry would serve one arm's answer to the other.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { sql } from "@/lib/db";
import { FIELD_ENTRANT_STATUSES } from "@/lib/entrant-field";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { publicEntrants } from "@/server/usecases/public";
import { GENERIC_CONFIG, seedOrg } from "@/server/usecases/__tests__/_seed";
import { getPublicCompetition, getPublicPlayer } from "../data";

const HAS_DB = !!process.env.DATABASE_URL;

/** One entrant per status the live check constraint allows. Each is an
 *  INDIVIDUAL with a consenting person behind it, so the same scene proves the
 *  entrant-list callers and the player card. */
const SEATS = [
  { status: "registered", display: "Ada Registered" },
  { status: "confirmed", display: "Bo Confirmed" },
  { status: "withdrawn", display: "Cyd Withdrawn" },
  { status: "disqualified", display: "Dee Disqualified" },
] as const;

type SeatStatus = (typeof SEATS)[number]["status"];

/** Both ways OUT of a field, derived from the product's own field vocabulary
 *  rather than typed, so a fifth status arrives here instead of being missed.
 *
 *  Every query below that filters for "the field" is driven over BOTH of them.
 *  The scene already held all four statuses, but the `getPublicPlayer` case
 *  only ever asked about the withdrawn seat — so narrowing that query to
 *  `and e.status <> 'withdrawn'` put a DISQUALIFIED entrant's division back on
 *  her public player card ("Dee Disqualified — still playing in Open") and
 *  survived 169 tests (independent mutation campaign B9, 2026-09-21). */
const DEPARTED_STATUSES = SEATS.filter((s) => !FIELD_ENTRANT_STATUSES.includes(s.status)).map(
  (s) => s.status,
);

interface Scene {
  auth: AuthCtx;
  orgId: string;
  orgSlug: string;
  compSlug: string;
  divisionId: string;
  divisionSlug: string;
  divisionName: string;
  /** A SECOND division of the same competition, where the entrant who
   *  withdrew from the first is still registered. Without it her player card
   *  does not exist at all to be asked the question: `public_players_v` (a
   *  different view, untouched by V412) admits a person only while some
   *  entrant row of theirs is `registered`/`confirmed`, so a person who left
   *  her only division is 404 at the gate, before any membership read. */
  secondDivisionSlug: string;
  entrantId: Record<SeatStatus, string>;
  personId: Record<SeatStatus, string>;
}

let scene: Scene;

async function seed(): Promise<Scene> {
  const { auth } = await seedOrg("pro"); // player cards need dashboard.player_profiles
  const orgId = auth.orgId;
  const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`
    select slug from organizations where id = ${orgId}`;
  const suffix = randomUUID().slice(0, 8);

  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Departed Cup " + suffix,
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open",
    slug: "open-" + suffix,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });

  const entrantId = {} as Record<SeatStatus, string>;
  const personId = {} as Record<SeatStatus, string>;
  for (const [i, seat] of SEATS.entries()) {
    const [{ id: pid }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, consent)
      values (${orgId}, ${seat.display}, ${sql.json({ public_name: true })})
      returning id`;
    const [{ id: eid }] = await createEntrants(auth, division.id, [
      {
        kind: "individual",
        display_name: seat.display,
        seed: i + 1,
        members: [
          { person_id: pid, squad_number: i + 1, default_position_key: null, is_captain: true, roles: [] },
        ],
      },
    ]);
    // Written straight onto the row. `withdrawEntrantCascade` is the product
    // path to 'withdrawn', but it needs a stage graph and settles fixtures,
    // and 'disqualified' has no product path from here at all — while every
    // query under test reads nothing but this column. Same reasoning, and the
    // same idiom, as the fixtures.status sweep in
    // `usecases/__tests__/stage-roster-drift.test.ts`.
    await sql`update entrants set status = ${seat.status} where id = ${eid}`;
    entrantId[seat.status] = eid;
    personId[seat.status] = pid;
  }

  // BOTH players who left `Open` are still registered in `Masters`, so each
  // card exists and the question "which divisions is she playing in?" can
  // actually be put to it (see `secondDivisionSlug`). Both, not just the
  // withdrawal: a scene that seats only one departure here can only ever ask
  // the player-card query about that one status.
  const second = await createDivision(auth, competition.id, {
    name: "Masters",
    slug: "masters-" + suffix,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  for (const [i, status] of DEPARTED_STATUSES.entries()) {
    await createEntrants(auth, second.id, [
      {
        kind: "individual",
        display_name: SEATS.find((s) => s.status === status)!.display,
        seed: i + 1,
        members: [
          {
            person_id: personId[status],
            squad_number: 9 + i,
            default_position_key: null,
            is_captain: true,
            roles: [],
          },
        ],
      },
    ]);
  }

  return {
    auth,
    orgId,
    orgSlug,
    compSlug: competition.slug,
    divisionId: division.id,
    divisionSlug: division.slug,
    divisionName: division.name,
    secondDivisionSlug: second.slug,
    entrantId,
    personId,
  };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  scene = await seed();
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  // Best effort: this suite's rows are its own org, and leaving them behind
  // inflates a shared local test database until unrelated suites time out.
  // Never fatal — a restricting FK must not red a green run.
  if (scene?.orgId) {
    await sql`delete from organizations where id = ${scene.orgId}`.catch(() => undefined);
  }
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("V412 — public_entrants_v publishes the departed", () => {
  it("the view carries ALL FOUR statuses for a public competition, not just the field", async () => {
    // This is the widening itself. Before V412 this read returned two rows,
    // which is exactly why the standings table had no name to print.
    const rows = await sql<{ id: string; status: string }[]>`
      select id, status from public_entrants_v where division_id = ${scene.divisionId}`;
    expect(rows.map((r) => r.status).toSorted()).toEqual(SEATS.map((s) => s.status).toSorted());
    expect(rows.map((r) => r.id).toSorted()).toEqual(
      SEATS.map((s) => scene.entrantId[s.status]).toSorted(),
    );
  });

  it("the visibility gate is untouched: a PRIVATE competition still publishes nobody", async () => {
    // The negative pair for the widening — "publish the departed" must not
    // have become "publish everybody".
    const hidden = await createCompetition(scene.auth, {
      ends_on: "2030-12-31",
      name: "Hidden Cup " + randomUUID().slice(0, 8),
      visibility: "private",
      branding: {},
    });
    const hiddenDivision = await createDivision(scene.auth, hidden.id, {
      name: "Open",
      slug: "hidden-" + randomUUID().slice(0, 8),
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
    });
    await createEntrants(scene.auth, hiddenDivision.id, [
      { kind: "individual", display_name: "Secret Sam", seed: 1, members: [] },
    ]);
    const rows = await sql<{ id: string }[]>`
      select id from public_entrants_v where division_id = ${hiddenDivision.id}`;
    expect(rows).toEqual([]);
  });
});

describe.skipIf(!HAS_DB)("the callers that mean THE FIELD filter for themselves", () => {
  it("publicEntrants() lists the two in the field and neither departed entrant", async () => {
    const payload = (await publicEntrants(scene.orgSlug, scene.compSlug, scene.divisionSlug)) as {
      division_id: string;
      entrants: { id: string; status: string }[];
    };
    expect(payload.division_id).toBe(scene.divisionId);
    expect(payload.entrants.map((e) => e.id).toSorted()).toEqual(
      [scene.entrantId.registered, scene.entrantId.confirmed].toSorted(),
    );
    // Said the other way round, so a rename or a reordering cannot make the
    // line above pass while a departed entrant is still in the payload.
    expect(payload.entrants.map((e) => e.status).toSorted()).toEqual(["confirmed", "registered"]);
    // Derived from the field vocabulary rather than typed, for the same reason
    // as everywhere else in this file: a fifth way out must arrive here.
    for (const gone of DEPARTED_STATUSES) {
      expect(
        payload.entrants.some((e) => e.id === scene.entrantId[gone]),
        `the ${gone} entrant is still in the public entrant list`,
      ).toBe(false);
    }
  });

  it("getPublicCompetition()'s entrant_count is the FIELD (2), not everyone the view publishes (4)", async () => {
    const shell = (await getPublicCompetition(scene.orgSlug, scene.compSlug))!;
    const division = shell.divisions.find((d) => d.id === scene.divisionId);
    expect(division).toBeTruthy();
    // Derived from the seed, not typed: the count must be the number of seats
    // whose status is in the field, and the view's own total is the other
    // number it must NOT be.
    const inField = SEATS.filter((s) => s.status === "registered" || s.status === "confirmed").length;
    const [{ published }] = await sql<{ published: number }[]>`
      select count(*)::int as published from public_entrants_v
      where division_id = ${scene.divisionId}`;
    expect(published).toBe(SEATS.length);
    expect(inField).toBeLessThan(published); // or this test cannot witness the regression
    expect(division!.entrant_count).toBe(inField);
  });

  it("getPublicPlayer(): the division she LEFT leaves her card — either way out — and the one she still plays stays", async () => {
    // Both departures, put to the query one at a time. Asking only about the
    // withdrawn seat is what let `and e.status <> 'withdrawn'` survive here:
    // the disqualified seat was seeded and never queried, so her division kept
    // its place on her public card.
    expect(DEPARTED_STATUSES.length, "the scene no longer holds two ways out").toBe(2);
    for (const status of DEPARTED_STATUSES) {
      const departed = (await getPublicPlayer(
        scene.orgSlug,
        scene.compSlug,
        scene.personId[status],
      ))!;
      expect(departed, `${status}: no public player card at all`).toBeTruthy();
      expect(departed.player.id).toBe(scene.personId[status]);
      // The negative and its positive in ONE person, so the refusal cannot be
      // "this card lists nothing at all": she has a roster row in each division
      // of this competition, and exactly one of them is the one she left.
      expect(
        departed.memberships.map((m) => m.division_slug),
        `${status}: her card no longer lists the division she still plays in`,
      ).toEqual([scene.secondDivisionSlug]);
      expect(
        departed.memberships.map((m) => m.division_slug),
        `${status}: the division she left is still on her card`,
      ).not.toContain(scene.divisionSlug);
      // …and the view really does still publish the row that was dropped, so
      // the line above is this query's filter rather than the view hiding her
      // again.
      const [{ n }] = await sql<{ n: number }[]>`
        select count(*)::int as n from public_entrants_v e
        cross join lateral jsonb_array_elements(e.members) m
        where e.division_id = ${scene.divisionId} and m->>'person_id' = ${scene.personId[status]}`;
      expect(n, `${status}: the view is hiding her row, so this proves nothing`).toBe(1);
    }

    // A second person, entirely in the field, for the plain positive.
    const playing = (await getPublicPlayer(
      scene.orgSlug,
      scene.compSlug,
      scene.personId.registered,
    ))!;
    expect(playing.memberships.map((m) => m.division_slug)).toEqual([scene.divisionSlug]);
    expect(playing.memberships[0]!.division_name).toBe(scene.divisionName);
  });
});
