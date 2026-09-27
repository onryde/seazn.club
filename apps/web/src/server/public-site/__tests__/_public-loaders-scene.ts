// A realistic public competition for the public loaders' output-identity
// suites (`public-division-loaders-identity.test.ts`,
// `public-fixture-loaders-identity.test.ts`). Built through the real usecases
// — the generator, the start, the scoring write path — so every row the
// loaders read is one production writes, not a hand-typed guess at it.
//
// What it holds, and why each piece is here: the loaders read feed edges
// (`winner_to_*` / `loser_to_*`) and `ext_key` off `fixtures` for every row of
// `public_fixtures_v`, so the scene has
//   - `cup`: a 5-team league (odd ⇒ a bye every round) feeding a 4-team
//     knockout with a third-place match at `timing: "setup"` — semis carry
//     WINNER and LOSER edges, the final and the bronze have no next fixture,
//     and round 1 of the knockout ties round 1 of the league on
//     (round_no, seq_in_round). One league match decided, one in play, courts
//     on the league, and a team WITHDRAWN after the start (its fixtures stay;
//     the view still publishes its name). Team rosters with every consent
//     shape, a squad-number tie and a null number.
//   - `bracket`: a 6-player knockout in an 8-draw — two byes, played as
//     forfeits — with one of the two real first-round matches decided, so one
//     second-round match is full and the other holds one entrant and waits on
//     the other. One player refused public-name consent.
//   - `draft`: a youth league still in setup (the view redacts time, venue and
//     court; `withCourtVenueNames` nulls the names) with courts assigned anyway.
//   - `empty`: a division with nothing in it.
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { startDivision } from "@/server/usecases/schedule";
import { scoreEvent } from "@/server/usecases/scoring";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { GENERIC_CONFIG, seedCourts, seedOrg } from "@/server/usecases/__tests__/_seed";
import { decidingStream } from "@/server/usecases/__tests__/_rig";

export interface SceneDivision {
  id: string;
  slug: string;
}

export interface LoadersScene {
  auth: AuthCtx;
  orgId: string;
  orgSlug: string;
  competitionId: string;
  compSlug: string;
  cup: SceneDivision;
  bracket: SceneDivision;
  draft: SceneDivision;
  empty: SceneDivision;
}

type Consent = { public_name?: boolean; public_photo?: boolean };

async function person(orgId: string, fullName: string, consent: Consent, photo: string | null = null): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, consent, photo_path)
    values (${orgId}, ${fullName}, ${sql.json(consent)}, ${photo})
    returning id`;
  return row!.id;
}

const member = (personId: string, squadNumber: number | null) => ({
  person_id: personId,
  squad_number: squadNumber,
  default_position_key: null,
  is_captain: false,
  roles: [],
});

/** Every event of `stream`, in order, through the real scoring write path. */
async function score(auth: AuthCtx, fixtureId: string, stream: { type: string; payload: Record<string, unknown> }[]) {
  let seq = 0;
  for (const event of stream) {
    await scoreEvent(auth, fixtureId, { expected_seq: seq, type: event.type, payload: event.payload } as never);
    seq += 1;
  }
}

async function fixturesOf(divisionId: string) {
  return sql<
    { id: string; stage_id: string; round_no: number; seq_in_round: number; home_entrant_id: string | null; away_entrant_id: string | null }[]
  >`
    select id, stage_id, round_no, seq_in_round, home_entrant_id, away_entrant_id
    from fixtures where division_id = ${divisionId}
    order by round_no, seq_in_round, id`;
}

export async function seedLoadersScene(): Promise<LoadersScene> {
  const { auth } = await seedOrg("pro");
  const orgId = auth.orgId;
  await sql`update organizations set default_locale = 'en', timezone = 'Europe/London' where id = ${orgId}`;
  const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`select slug from organizations where id = ${orgId}`;

  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Loaders Cup " + randomUUID().slice(0, 6),
    visibility: "public", // every public_*_v view filters on this
    branding: {},
  });

  // ── cup: league (5 teams) → knockout with a bronze, at setup timing ──────
  const cupDivision = await createDivision(auth, competition.id, {
    name: "Cup",
    slug: "cup",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  const ana = await person(orgId, "Ana Silva", { public_name: true, public_photo: true }, "persons/ana.png");
  const ben = await person(orgId, "Ben Okafor", { public_name: false });
  const cara = await person(orgId, "Cara Diaz", {});
  const dev = await person(orgId, "Dev Patel", { public_name: true });
  const eli = await person(orgId, "Eli Moss", { public_name: true, public_photo: false }, "persons/eli.png");
  const cupEntrants = await createEntrants(auth, cupDivision.id, [
    // Ana and Ben share squad number 7 (the view breaks the tie on full name);
    // Cara has none (nulls last).
    { kind: "team", display_name: "Harbour FC", seed: 1, members: [member(cara, null), member(ben, 7), member(ana, 7)] },
    { kind: "team", display_name: "Rovers", seed: 2, members: [member(dev, 10)] },
    { kind: "team", display_name: "Northside", seed: 3, members: [member(eli, 4)] },
    { kind: "team", display_name: "Eastfield", seed: 4, members: [] },
    { kind: "team", display_name: "Westgate", seed: 5, members: [] },
  ] as never);
  const cupStages = await createStages(auth, cupDivision.id, [
    { seq: 1, kind: "league", name: "League", config: { legs: 1 } },
    {
      seq: 2,
      kind: "knockout",
      name: "Finals",
      config: { thirdPlace: true },
      progression: {
        sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
        placement: "rank_order",
        timing: "setup",
      },
    },
  ] as never);
  for (const stage of [...cupStages].sort((a, b) => a.seq - b.seq)) await generateStageFixtures(auth, stage.id);
  await startDivision(auth, cupDivision.id);

  const [venueCourtA, venueCourtB] = await seedCourts(orgId, 2);
  const leagueStage = cupStages.find((s) => s.kind === "league")!;
  const league = (await fixturesOf(cupDivision.id)).filter((f) => f.stage_id === leagueStage.id);
  // Courts and times on the league: the view publishes them for a started
  // division, and `withCourtVenueNames` names them.
  for (const [i, f] of league.entries()) {
    const court = i % 3 === 2 ? null : i % 3 === 0 ? venueCourtA! : venueCourtB!;
    await sql`
      update fixtures
         set court_id = ${court},
             venue_id = (select venue_id from courts where id = ${court}),
             scheduled_at = ${new Date(Date.UTC(2030, 5, 1 + f.round_no, 9 + f.seq_in_round))}
       where id = ${f.id}`;
  }
  const playable = league.filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null);
  await score(auth, playable[0]!.id, decidingStream()); // decided
  await score(auth, playable[1]!.id, [{ type: "core.start", payload: {} }]); // in play
  // Withdrawn after the start: its fixtures stay, its name still publishes.
  const westgate = cupEntrants.find((e) => e.display_name === "Westgate")!;
  await sql`update entrants set status = 'withdrawn' where id = ${westgate.id}`;

  // ── bracket: 6 players in an 8-draw (byes), one first-round match decided ──
  const bracketDivision = await createDivision(auth, competition.id, {
    name: "Bracket",
    slug: "bracket",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  const players = [
    await person(orgId, "Fay Lund", { public_name: true }),
    await person(orgId, "Gus Hale", { public_name: false }),
    await person(orgId, "Hana Ito", {}),
    await person(orgId, "Ivo Reyes", { public_name: true, public_photo: true }, "persons/ivo.png"),
    await person(orgId, "Jo Kerr", { public_name: true }),
    await person(orgId, "Kit Ames", { public_name: true }),
  ];
  const playerNames = ["Fay Lund", "Gus Hale", "Hana Ito", "Ivo Reyes", "Jo Kerr", "Kit Ames"];
  await createEntrants(
    auth,
    bracketDivision.id,
    players.map((p, i) => ({ kind: "individual", display_name: playerNames[i]!, seed: i + 1, members: [member(p, null)] })) as never,
  );
  const [bracketStage] = await createStages(auth, bracketDivision.id, { seq: 1, kind: "knockout", name: "Draw", config: {} } as never);
  await generateStageFixtures(auth, bracketStage!.id);
  await startDivision(auth, bracketDivision.id);
  const firstRound = (await fixturesOf(bracketDivision.id)).filter(
    (f) => f.round_no === 1 && f.home_entrant_id !== null && f.away_entrant_id !== null,
  );
  await score(auth, firstRound[0]!.id, decidingStream());

  // ── draft: a youth league still in setup, courts assigned anyway ─────────
  const draftDivision = await createDivision(auth, competition.id, {
    name: "Draft",
    slug: "draft",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await sql`update divisions set youth = true where id = ${draftDivision.id}`;
  const kids = [
    await person(orgId, "Kai Lowe", { public_name: true }),
    await person(orgId, "Lia Marsh", {}),
    await person(orgId, "Max Nolan", { public_name: true }),
  ];
  await createEntrants(
    auth,
    draftDivision.id,
    kids.map((p, i) => ({ kind: "individual", display_name: ["Kai Lowe", "Lia Marsh", "Max Nolan"][i]!, seed: i + 1, members: [member(p, null)] })) as never,
  );
  const [draftStage] = await createStages(auth, draftDivision.id, { seq: 1, kind: "league", name: "Pool", config: {} } as never);
  await generateStageFixtures(auth, draftStage!.id);
  for (const f of await fixturesOf(draftDivision.id)) {
    await sql`
      update fixtures
         set court_id = ${venueCourtA!},
             venue_id = (select venue_id from courts where id = ${venueCourtA!}),
             scheduled_at = ${new Date(Date.UTC(2030, 6, 1, 10))}
       where id = ${f.id}`;
  }

  // ── empty ────────────────────────────────────────────────────────────────
  const emptyDivision = await createDivision(auth, competition.id, {
    name: "Empty",
    slug: "empty",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });

  return {
    auth,
    orgId,
    orgSlug,
    competitionId: competition.id,
    compSlug: competition.slug,
    cup: { id: cupDivision.id, slug: cupDivision.slug },
    bracket: { id: bracketDivision.id, slug: bracketDivision.slug },
    draft: { id: draftDivision.id, slug: draftDivision.slug },
    empty: { id: emptyDivision.id, slug: emptyDivision.slug },
  };
}

/** Every fixture id of a division, draw order, for per-fixture sweeps. */
export async function sceneFixtureIds(divisionId: string): Promise<string[]> {
  return (await fixturesOf(divisionId)).map((f) => f.id);
}
