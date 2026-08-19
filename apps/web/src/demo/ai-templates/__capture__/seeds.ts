// #364 — the three marketing-demo templates, as deterministic seed builders.
//
// The demo on the marketing site is not a simulation: each template is captured
// ONCE from a real `aiPlanForDivision` / `aiPlanForCompetition` run (Task 3) and
// the response is committed as a fixture. The issue's acceptance is that the
// capture "re-runs and reproduces", so the BOARD the model saw has to be
// reproducible from nothing but this file — which is why every date, court,
// name and instruction below is a literal, and nothing reads the clock or a
// random source. The only non-determinism left is the per-seed UUIDs, and
// {@link normalizeIds} is the equivalence that absorbs exactly those.
//
// These builders live outside `__tests__` on purpose: the capture harness and
// its drift guard both import them, and one of the two is not a test. They ARE
// test-shaped though — they use the same usecases a real organiser's clicks
// would, so a board that could not exist in production cannot exist here.
//
// Each template carries exactly ONE biting constraint, because a demo that
// shows the architect satisfying everything shows nothing:
//   club-night     — 20 minutes rest, on two courts, in three and a half hours
//   northside-open — Court 5 is juniors only, and the juniors stop at 18:00
//   finals-day     — rain closes every court 13:00–15:30, mid-tournament
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { ScheduleConfig } from "@/server/api-v1/schemas";
import { GENERIC_CONFIG } from "@/server/usecases/__tests__/_seed";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { createCourt, createVenue } from "@/server/usecases/venues";

/** What Task 3's capture harness needs to drive one real architect run. */
export interface SeededTemplate {
  slug: string;
  competitionId: string;
  /** Draw order — for the joint template this is the order the pack lists. */
  divisionIds: string[];
  instruction: string;
  mode: "generate" | "repair";
  joint: boolean;
}

/** Every template is anchored in Europe/London; the org zone is the ONE clock
 *  a pack reads (#448), so it is set explicitly rather than inherited. */
const TZ = "Europe/London";

/** Far enough out that `assertCompetitionNotEnded` never turns a seed into a
 *  time bomb. Never appears in a pack. */
const ENDS_ON = "2030-12-31";

type DemoScheduleConfig = ScheduleConfig;

/** The constraint fields every board carries, so a template's own settings read
 *  as the ONE thing it changes. Mirrors the shipped defaults. */
const BASE_CONSTRAINTS: NonNullable<DemoScheduleConfig["constraints"]> = {
  noBackToBack: false,
  startWindows: [],
  fieldFairness: "balance",
  parallelism: "mixed",
  crossPersonClash: "hard",
};

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

interface SportChoice {
  sport_key: string;
  variant_key: string;
  config: Record<string, unknown>;
}

/**
 * The real sport when the catalog carries it, else the generic pair `seedOrg`
 * guarantees.
 *
 * `sync:sports` fills badminton and tennis in a provisioned environment, but a
 * builder that ASSUMES that is order-dependent against a fresh database — the
 * exact shape that shipped #404 green locally and red on CI. The fallback keeps
 * the boards seedable anywhere; the demo capture runs against a synced schema
 * and gets the real sport.
 *
 * The system preset is taken as-is (`config: {}`): the division config is merged
 * over the preset and validated by the pinned module's own schema, so pushing
 * generic's score config onto badminton would 422.
 */
async function resolveSport(sportKey: string, variantKey: string): Promise<SportChoice> {
  const [row] = await sql<{ ok: boolean }[]>`
    select true as ok from sport_variants v
    join sports s on s.key = v.sport_key
    where v.sport_key = ${sportKey} and v.key = ${variantKey} and v.org_id is null`;
  return row
    ? { sport_key: sportKey, variant_key: variantKey, config: {} }
    : { sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG };
}

/** Name the club and pin the org zone — the pack renders every instant in it. */
async function brandOrg(auth: AuthCtx, clubName: string): Promise<void> {
  await sql`
    update organizations set name = ${clubName}, timezone = ${TZ} where id = ${auth.orgId}`;
}

async function setScheduleSettings(
  divisionId: string,
  config: DemoScheduleConfig,
): Promise<void> {
  await sql`
    insert into schedule_settings (division_id, config, tz, updated_at)
    values (${divisionId}, ${sql.json(config as Parameters<typeof sql.json>[0])}, ${TZ}, now())
    on conflict (division_id) do update set config = excluded.config, tz = excluded.tz`;
}

/**
 * Create one venue with N named courts via the real usecases and return
 * label -> id. V374 cutover: `ScheduleConfig.courts` is `CourtId[]` (real
 * court UUIDs) now, not display labels — these seeds predate that and wrote
 * the label directly into both `schedule_settings.config.courts` and
 * `fixtures.court_label`. Every caller below keeps its own label array as
 * the readable, deterministic source and maps through this at the call
 * site, so the template bodies still read "Court 1", "Court 2", …
 */
async function seedCourts(
  auth: AuthCtx,
  venueName: string,
  labels: readonly string[],
): Promise<Record<string, string>> {
  const venue = await createVenue(auth, { name: venueName, sort: 0 });
  const byLabel: Record<string, string> = {};
  for (let i = 0; i < labels.length; i++) {
    const court = await createCourt(auth, venue.id, { name: labels[i]!, sort: i, tags: [] });
    byLabel[labels[i]!] = court.id;
  }
  return byLabel;
}

/** Individual entrants in list order, seeded 1..n — the order IS the draw. */
function entrantInputs(names: readonly string[]) {
  return names.map((display_name, i) => ({
    kind: "individual" as const,
    display_name,
    seed: i + 1,
    members: [],
  }));
}

/**
 * Map every UUID to a first-seen placeholder — `«u1»`, `«u2»`, … — so two seeds
 * of the same template compare equal while ORDER stays asserted: a pack whose
 * rows reordered renumbers and stops matching.
 *
 * Walks the SERIALISED form rather than the object graph, which is what makes
 * an id embedded in a sentence ("fixture <uuid> clashes …") normalise too — the
 * pack's explanation strings quote fixture ids.
 *
 * RESIDUAL, deliberately: first-seen numbering cannot see a permutation of rows
 * whose ONLY content is a distinct id — `[a, b]` and `[b, a]` both normalise to
 * `["«u1»","«u2»"]`. Every ordered surface a pack carries also carries a time, a
 * court or a name, so the reorderings that matter still separate; the two cases
 * are pinned in seeds.test.ts rather than left to be rediscovered.
 *
 * Adapted from `redact()` in schedule-ai-pack.test.ts (that one is private to
 * its suite); the placeholder shape differs deliberately so a normalised pack
 * is never mistaken for a redacted golden.
 */
export function normalizeIds(json: unknown): unknown {
  const serialised = JSON.stringify(json);
  if (serialised === undefined) return json;
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const seen = new Map<string, string>();
  return JSON.parse(
    serialised.replace(uuid, (u) => {
      const key = u.toLowerCase();
      if (!seen.has(key)) seen.set(key, `«u${seen.size + 1}»`);
      return seen.get(key)!;
    }),
  );
}

// ---------------------------------------------------------------------------
// 1. club-night — Tuesday Club Night, Riverside Badminton Club
// ---------------------------------------------------------------------------

const CLUB_NIGHT_ENTRANTS = [
  "Priya N.",
  "Marcus T.",
  "Elena V.",
  "Sam R.",
  "Jordan K.",
  "Aiko M.",
  "Dev P.",
  "Rosa L.",
] as const;

const CLUB_NIGHT_INSTRUCTION =
  "Schedule the club night. Nobody plays twice in a row — every player gets at least 20 minutes rest between matches.";

/**
 * Eight players, two pools of four, twelve matches — on TWO courts between
 * 18:30 and 22:00. Fourteen 25-minute slots exist and twelve matches need one,
 * so the board is nearly full before the rest rule is read at all: every player
 * has three matches and 20 minutes of rest between them.
 */
export async function seedClubNight(auth: AuthCtx): Promise<SeededTemplate> {
  await brandOrg(auth, "Riverside Badminton Club");
  const sport = await resolveSport("badminton", "bwf");
  const courts = await seedCourts(auth, "Riverside Badminton Club", ["Court 1", "Court 2"]);

  const comp = await createCompetition(auth, {
    ends_on: ENDS_ON,
    name: "Tuesday Club Night",
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Club Night",
    slug: "club-night",
    sport_key: sport.sport_key,
    variant_key: sport.variant_key,
    config: sport.config,
    eligibility: [],
  });
  await createEntrants(auth, division.id, entrantInputs(CLUB_NIGHT_ENTRANTS));
  await setScheduleSettings(division.id, {
    startAt: "2026-09-15T18:30:00+01:00",
    matchMinutes: 20,
    gapMinutes: 5,
    courts: [courts["Court 1"]!, courts["Court 2"]!],
    perEntrantMinRest: 20,
    blackouts: [],
    sessionWindows: [
      { from: "2026-09-15T18:30:00+01:00", to: "2026-09-15T22:00:00+01:00" },
    ],
    constraints: { ...BASE_CONSTRAINTS, restMin: 20 },
  });
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "group",
    name: "Pools",
    config: { pools: { count: 2 } },
  });
  await generateStageFixtures(auth, stage!.id);

  return {
    slug: "club-night",
    competitionId: comp.id,
    divisionIds: [division.id],
    instruction: CLUB_NIGHT_INSTRUCTION,
    mode: "generate",
    joint: false,
  };
}

// ---------------------------------------------------------------------------
// 2. northside-open — three divisions over one weekend
// ---------------------------------------------------------------------------

const NORTHSIDE_MENS_ENTRANTS = [
  "Tomas B.", "Idris A.", "Callum W.", "Nikhil S.",
  "Ravi D.", "Lars E.", "Mateo F.", "Otto G.",
  "Hugo J.", "Ilya K.", "Kofi L.", "Milo N.",
  "Nuno O.", "Oskar P.", "Pavel R.", "Quentin M.",
  "Rasmus S.", "Selim T.", "Teodor U.", "Ugo V.",
  "Viggo W.", "Wiktor Z.", "Xavi B.", "Yusuf D.",
  "Andrei C.", "Bruno H.", "Cyrus I.", "Dario M.",
  "Emil V.", "Fabio B.", "Gustav A.", "Hamza D.",
] as const;

const NORTHSIDE_WOMENS_ENTRANTS = [
  "Nadia P.", "Ines M.", "Sofia R.", "Lena K.",
  "Amara O.", "Bea T.", "Clara V.", "Dora S.",
  "Eve H.", "Farah J.", "Greta L.", "Hana W.",
  "Iris C.", "Juno A.", "Kaya B.", "Lila F.",
  "Mina G.", "Noor D.", "Ola E.", "Petra N.",
  "Rania Z.", "Sena U.", "Tessa I.", "Vera Y.",
] as const;

const NORTHSIDE_U15_ENTRANTS = [
  "Alfie R.", "Bella S.", "Caleb T.", "Daisy U.",
  "Ewan V.", "Freya W.", "Gabe A.", "Hattie B.",
  "Ismail C.", "Jia D.", "Kian E.", "Luca F.",
  "Maya G.", "Nate H.", "Orla I.", "Pip J.",
  "Quinn K.", "Rhys L.", "Suki M.", "Theo N.",
  "Uma O.", "Vik P.", "Wren C.", "Xander R.",
  "Yara S.", "Zane T.", "Ada W.", "Bo V.",
  "Cleo M.", "Dev N.", "Esme B.", "Finn G.",
] as const;

/** The retirement (issue: "one retirement"). Applied AFTER the draw, so the
 *  36 fixtures already exist — a scratch before the draw would have produced a
 *  smaller one, which is a different story than the demo tells. */
const NORTHSIDE_RETIREMENT = "Vera Y.";

/**
 * The organiser's sentence — LOAD-BEARING, and pinned verbatim by the tests.
 *
 * It said "Schedule all three divisions across the weekend" until the first
 * capture (#364 Task 3) showed what that costs. Stage 1 compiles the
 * instruction into rules the referee then enforces, and a DAY-SPREAD phrase
 * compiles into per-fixture day targets — "this one on SAT, that one on SUN".
 * The architect placed all 115 fixtures cleanly and the board had no blocking
 * conflict, but 85 of them landed on the other day from the wish, so the run
 * came back carrying 85 warn-only H8 rows. On the joint console that is a flat
 * conflict list longer than the board, and at 375px it is the whole screen.
 *
 * Dropping the phrase is not softening the demo — the two constraints that
 * actually BITE are still here, still verified, and the days were never in
 * doubt: the session windows already pin Saturday and Sunday
 * ({@link NORTHSIDE_ADULT_WINDOWS}), so the model was being asked to satisfy a
 * wish the settings had already decided. Keep the compiled set to the rules
 * that bite, and a warning means something again.
 */
const NORTHSIDE_INSTRUCTION =
  "Schedule all three divisions. Courts 1-4 are shared by the adult draws; Court 5 is juniors only. All U15 matches must finish by 18:00 each day.";

const NORTHSIDE_ADULT_WINDOWS: DemoScheduleConfig["sessionWindows"] = [
  { from: "2026-09-19T09:00:00+01:00", to: "2026-09-19T21:00:00+01:00" },
  { from: "2026-09-20T09:00:00+01:00", to: "2026-09-20T21:00:00+01:00" },
];

const NORTHSIDE_JUNIOR_WINDOWS: DemoScheduleConfig["sessionWindows"] = [
  { from: "2026-09-19T09:00:00+01:00", to: "2026-09-19T18:00:00+01:00" },
  { from: "2026-09-20T09:00:00+01:00", to: "2026-09-20T18:00:00+01:00" },
];

interface NorthsideDivision {
  name: string;
  slug: string;
  entrants: readonly string[];
  stage: { kind: "knockout" | "group"; name: string; config: Record<string, unknown> };
  /** Labels, resolved to real court ids in `seedNorthsideOpen` — see
   *  `seedCourts`'s doc comment. */
  courtLabels: readonly string[];
  config: Omit<DemoScheduleConfig, "courts">;
}

const NORTHSIDE_DIVISIONS: readonly NorthsideDivision[] = [
  {
    name: "Men's Singles",
    slug: "mens-singles",
    entrants: NORTHSIDE_MENS_ENTRANTS,
    stage: { kind: "knockout", name: "Main Draw", config: {} },
    courtLabels: ["Court 1", "Court 2", "Court 3", "Court 4"],
    config: {
      startAt: "2026-09-19T09:00:00+01:00",
      matchMinutes: 45,
      gapMinutes: 0,
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: NORTHSIDE_ADULT_WINDOWS,
      constraints: BASE_CONSTRAINTS,
    },
  },
  {
    name: "Women's Singles",
    slug: "womens-singles",
    entrants: NORTHSIDE_WOMENS_ENTRANTS,
    stage: { kind: "group", name: "Pools", config: { pools: { count: 6 } } },
    courtLabels: ["Court 1", "Court 2", "Court 3", "Court 4"],
    config: {
      startAt: "2026-09-19T09:00:00+01:00",
      matchMinutes: 45,
      gapMinutes: 0,
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: NORTHSIDE_ADULT_WINDOWS,
      constraints: BASE_CONSTRAINTS,
    },
  },
  {
    name: "U15 Mixed",
    slug: "u15-mixed",
    entrants: NORTHSIDE_U15_ENTRANTS,
    stage: { kind: "group", name: "Pools", config: { pools: { count: 8 } } },
    courtLabels: ["Court 3", "Court 4", "Court 5"],
    config: {
      startAt: "2026-09-19T09:00:00+01:00",
      matchMinutes: 30,
      gapMinutes: 0,
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: NORTHSIDE_JUNIOR_WINDOWS,
      constraints: BASE_CONSTRAINTS,
    },
  },
];

/**
 * Three divisions of one competition, over a Saturday and a Sunday: a 32-draw
 * knockout (31 fixtures), six pools of four (36) and eight junior pools of four
 * (48) — 115 fixtures whose court sets OVERLAP but do not match, and whose match
 * lengths differ. That divergence is the point: a per-division run cannot see
 * it, so the joint pack is the only surface that can place the juniors on Court
 * 5 without double-booking Courts 3 and 4 against the adults.
 */
export async function seedNorthsideOpen(auth: AuthCtx): Promise<SeededTemplate> {
  await brandOrg(auth, "Northside Sports Centre");
  const sport = await resolveSport("badminton", "bwf");
  const courts = await seedCourts(auth, "Northside Sports Centre", [
    "Court 1",
    "Court 2",
    "Court 3",
    "Court 4",
    "Court 5",
  ]);

  const comp = await createCompetition(auth, {
    ends_on: ENDS_ON,
    name: "Northside Open",
    visibility: "public",
    branding: {},
  });

  const divisionIds: string[] = [];
  for (const spec of NORTHSIDE_DIVISIONS) {
    const division = await createDivision(auth, comp.id, {
      name: spec.name,
      slug: spec.slug,
      sport_key: sport.sport_key,
      variant_key: sport.variant_key,
      config: sport.config,
      eligibility: [],
    });
    await createEntrants(auth, division.id, entrantInputs(spec.entrants));
    await setScheduleSettings(division.id, {
      ...spec.config,
      courts: spec.courtLabels.map((label) => courts[label]!),
    });
    const [stage] = await createStages(auth, division.id, {
      seq: 1,
      kind: spec.stage.kind,
      name: spec.stage.name,
      config: spec.stage.config,
    });
    await generateStageFixtures(auth, stage!.id);
    divisionIds.push(division.id);
  }

  // The retirement, once every draw exists.
  await sql`
    update entrants set status = 'withdrawn'
    where division_id = ${divisionIds[1]!} and display_name = ${NORTHSIDE_RETIREMENT}`;

  return {
    slug: "northside-open",
    competitionId: comp.id,
    divisionIds,
    instruction: NORTHSIDE_INSTRUCTION,
    mode: "generate",
    joint: true,
  };
}

// ---------------------------------------------------------------------------
// 3. finals-day — County League Finals Day, Eastvale Tennis Club
// ---------------------------------------------------------------------------

const FINALS_DAY_ENTRANTS = [
  "Harriet M.", "Owen B.", "Sian D.", "Rory F.",
  "Tamsin G.", "Callum H.", "Niamh J.", "Elliot K.",
  "Bryn L.", "Ffion N.", "Gareth P.", "Imogen R.",
  "Josef S.", "Katya T.", "Lowri V.", "Mervyn W.",
] as const;

const FINALS_DAY_INSTRUCTION =
  "Rain has closed all six courts from 13:00 to 15:30. Repair the schedule moving as few matches as possible; matches already played stay exactly where they are.";

const FINALS_DAY_COURTS = [
  "Court 1",
  "Court 2",
  "Court 3",
  "Court 4",
  "Court 5",
  "Court 6",
] as const;

/** The programme that was published before the rain: 40 matches, 09:00 onward,
 *  six courts, one 60-minute match plus a 10-minute turnaround per slot. */
const FINALS_DAY_START = Date.parse("2026-09-26T09:00:00+01:00");
const FINALS_DAY_SLOT_MS = (60 + 10) * 60_000;

/** How many of the 40 were already played when the rain came.
 *
 *  Chosen, not derived: the six-court grid places matches in blocks of six, so
 *  no cutoff instant yields eleven. Eleven is the FIRST eleven in programme
 *  order — the 09:00 block and five of the 10:10 block — which is what a
 *  half-finished morning looks like, and every one of them starts long before
 *  the 13:00 blackout. `movable` is `status = 'scheduled'` only, so marking
 *  them `decided` is what makes them immovable to the repair. */
const FINALS_DAY_PLAYED = 11;

/**
 * A 16-entrant round robin trimmed to a 40-match Finals Day, fully placed, with
 * the morning already played — and then rain closes every court for two and a
 * half hours in the middle of it.
 *
 * This is the hero template, and the honest one: the surviving window cannot
 * hold every displaced match, so the run is expected to report some as
 * unplaceable rather than pretend. The trim is by `fixture_no` (keep the first
 * 40) so the same 40 matches survive on every reseed.
 *
 * THE INFEASIBILITY IS THE DESIGN, NOT A BUG TO TUNE OUT. The closure leaves
 * roughly three and a half playable hours for work that needed five and a half,
 * so a non-empty `unschedulable` is this template's ACCEPTANCE CRITERION — the
 * issue asks the demo to show repair mode reporting what it cannot place. The
 * 19:00 window end stays. Do not widen it, do not shorten the closure, and do
 * NOT make the frozen morning movable to buy back capacity.
 */
export async function seedFinalsDay(auth: AuthCtx): Promise<SeededTemplate> {
  await brandOrg(auth, "Eastvale Tennis Club");
  const sport = await resolveSport("tennis", "tour");
  const courts = await seedCourts(auth, "Eastvale Tennis Club", FINALS_DAY_COURTS);

  const comp = await createCompetition(auth, {
    ends_on: ENDS_ON,
    name: "County League Finals Day",
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Finals Day",
    slug: "finals-day",
    sport_key: sport.sport_key,
    variant_key: sport.variant_key,
    config: sport.config,
    eligibility: [],
  });
  await createEntrants(auth, division.id, entrantInputs(FINALS_DAY_ENTRANTS));
  await setScheduleSettings(division.id, {
    startAt: "2026-09-26T09:00:00+01:00",
    matchMinutes: 60,
    gapMinutes: 10,
    courts: FINALS_DAY_COURTS.map((label) => courts[label]!),
    perEntrantMinRest: 0,
    blackouts: [{ from: "2026-09-26T13:00:00+01:00", to: "2026-09-26T15:30:00+01:00" }],
    sessionWindows: [
      { from: "2026-09-26T09:00:00+01:00", to: "2026-09-26T19:00:00+01:00" },
    ],
    constraints: BASE_CONSTRAINTS,
  });
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "League",
    config: {},
  });
  await generateStageFixtures(auth, stage!.id);

  // A full 16-entrant round robin is 120 matches; Finals Day runs 40 of them.
  // Deleted by `fixture_no` so the surviving 40 are the same matches every time.
  await sql`
    delete from fixtures where id in (
      select id from fixtures where division_id = ${division.id}
      order by fixture_no offset 40)`;

  // Publish the programme. Raw UPDATE rather than the scheduling usecases: this
  // is a board that ALREADY EXISTED when the rain started, not one the demo is
  // asking anything to produce.
  const placed = await sql<{ id: string }[]>`
    select id from fixtures where division_id = ${division.id} order by fixture_no`;
  for (const [i, row] of placed.entries()) {
    const at = new Date(
      FINALS_DAY_START + Math.floor(i / FINALS_DAY_COURTS.length) * FINALS_DAY_SLOT_MS,
    );
    await sql`
      update fixtures
      set scheduled_at = ${at.toISOString()},
          court_id = ${courts[FINALS_DAY_COURTS[i % FINALS_DAY_COURTS.length]!]!}
      where id = ${row.id}`;
  }

  // The morning that was already played.
  await sql`
    update fixtures set status = 'decided' where id in (
      select id from fixtures where division_id = ${division.id}
      order by fixture_no limit ${FINALS_DAY_PLAYED})`;

  return {
    slug: "finals-day",
    competitionId: comp.id,
    divisionIds: [division.id],
    instruction: FINALS_DAY_INSTRUCTION,
    mode: "repair",
    joint: false,
  };
}
