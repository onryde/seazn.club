// Spectator surface W2, Task 14 — the per-match lines on the public player page.
//
// Two halves, the same split `public-leaders.test.ts` uses:
//
//  * The DB half needs real Postgres (views, lineups, the score ledger) and
//    skips without DATABASE_URL. It seeds ONE scene in `beforeAll` and asks
//    `readPlayerMatchLines` about several people in it, because the questions
//    that matter are relational: which fixtures count as a person's
//    appearance, which divisions a spectator may see, which side is "theirs".
//    The cricket figures are checked against the test's OWN
//    `deriveCricketScorecard` fold of the scripted ledger — the same engine
//    fold the match centre renders, run over the script rather than over what
//    the reader loaded, so a reader that loaded the wrong lineups or config
//    disagrees with it.
//  * The pure half runs everywhere: the result mapping (every outcome kind)
//    and the cricket line composer over real engine folds, with LITERAL
//    expected strings, so the dictionary templates and the super-over rule
//    are pinned without a database.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

// `unstable_cache` is a Next server-runtime API with no incrementalCache under
// vitest. A bare passthrough (the double most tests here use) would make the
// per-fixture figures cache unobservable, so this double models the two things
// the reader depends on, and nothing else:
//
//  * STORAGE, for the key families in `storedPrefixes` (the figures family by
//    default; a test may add the page's own entry): a hit returns
//    `JSON.parse` of what was stored, as Next's incremental cache does — so a
//    value that does not survive serialisation (a Map) reads back wrong here too.
//  * NESTING. Next BYPASSES the cache read for an `unstable_cache` called inside
//    another one's callback (`next/dist/server/web/spec-extension/
//    unstable-cache.js`, `isNestedUnstableCache`). `getPublicPlayer` wraps its
//    read in one, so a figures cache called from inside it would never hit. An
//    AsyncLocalStorage scope reproduces that, the way Next tracks it.
//
// Every other key (the shell, and the page entry unless a test adds it) stays a
// passthrough.
const nextCache = vi.hoisted(() => {
  const { AsyncLocalStorage } = process.getBuiltinModule("node:async_hooks");
  const scope = new AsyncLocalStorage<true>();
  const store = new Map<string, string>();
  const storedPrefixes = new Set<string>();
  const stored = (keyParts: readonly string[] | undefined) =>
    [...storedPrefixes].some((prefix) => keyParts?.[0]?.startsWith(prefix) === true);
  return {
    store,
    storedPrefixes,
    unstable_cache:
      (fn: (...args: unknown[]) => Promise<unknown>, keyParts?: string[]) =>
      async (...args: unknown[]): Promise<unknown> => {
        const key = JSON.stringify([keyParts ?? [], args]);
        if (stored(keyParts) && scope.getStore() !== true && store.has(key)) return JSON.parse(store.get(key)!);
        const value = await scope.run(true, () => fn(...args));
        if (stored(keyParts)) store.set(key, JSON.stringify(value));
        return value;
      },
  };
});
vi.mock("next/cache", () => ({ unstable_cache: nextCache.unstable_cache, revalidateTag: vi.fn() }));

// Every fold the reader starts goes through `loadFoldInputs`; counting calls per
// fixture is how the cache tests see a re-fold. `poison` makes one fixture's
// load raise a REAL Postgres error inside the caller's transaction first — the
// failure that would abort a transaction shared with the next fixture.
const foldSpy = vi.hoisted(() => ({ calls: [] as string[], poison: new Set<string>() }));
vi.mock("@/server/engine-db/fold", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/engine-db/fold")>();
  return {
    ...real,
    loadFoldInputs: async (tx: Parameters<typeof real.loadFoldInputs>[0], fixtureId: string) => {
      foldSpy.calls.push(fixtureId);
      if (foldSpy.poison.has(fixtureId)) await tx`select 1/0`;
      return real.loadFoldInputs(tx, fixtureId);
    },
  };
});
const foldsOf = (fixtureId: string) => foldSpy.calls.filter((id) => id === fixtureId).length;

import { foldMatch, type EventEnvelope, type LineupPair, type ScoreSummary } from "@seazn/engine/core";
import { resolvePositions, type AnySportModule, type ModuleEvent } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { boardgame } from "@seazn/engine/sports/boardgame";
import { carrom } from "@seazn/engine/sports/carrom";
import { cricket, deriveCricketScorecard, type CricketScorecard } from "@seazn/engine/sports/cricket";
import { football } from "@seazn/engine/sports/football";
import { generic } from "@seazn/engine/sports/generic";
import { icehockey } from "@seazn/engine/sports/icehockey";
import { badminton } from "@seazn/engine/sports/setbased";
import { tennis } from "@seazn/engine/sports/tennis";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { getDictionary } from "@/lib/i18n";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent } from "@/server/engine-db/append-event";
import { loadFoldInputs } from "@/server/engine-db/fold";
import { log } from "@/server/logger";
import { resnapshotFixtureConfig } from "@/server/usecases/admin-fixture-config";
import { mergePersons } from "@/server/usecases/person-merge";
import { countMatchesByDivision } from "@/server/usecases/player-stats";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { startDivision } from "@/server/usecases/schedule";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { venueTzForDivision } from "@/server/venue-tz";
import { getPublicPlayer, publicPlayerGate } from "../data";
import {
  benchRowIsAppearance,
  composePlayerMatchLines,
  cricketLineFor,
  playerMatchResult,
  readPlayerMatchLines,
  readPlayerMatchSeeds,
  scoreLineFor,
  type FixtureFigures,
  type PlayerMatchLine,
  type PlayerMatchSeed,
} from "../public-player-matches";
import { AWAY, HOME, SUPER_OVER_SCRIPT, scriptLedger, type Delivery, type Script } from "./cricket-ledger";

const HAS_DB = !!process.env.DATABASE_URL;

// ---------------------------------------------------------------------------
// DB half — the scene
// ---------------------------------------------------------------------------

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

/** Six balls a side, three players a side: small enough to script by hand,
 *  and the SAME partial feeds both the division row and `scriptLedger`, so the
 *  config the write path freezes is the config the test's own fold reads.
 *  One ordinary substitution per side, so a bench player can come on and bowl
 *  (the write path refuses it at cricket's default of zero). */
const CRICKET_PARTIAL = {
  ballsPerInnings: 6,
  ballsPerOver: 6,
  playersPerSide: 3,
  minOversForResult: 1,
  lineupChanges: { maxSubs: 1 },
};

const bats = (...runs: (0 | 1 | 2 | 3 | 4 | 6)[]): Delivery[] => runs.map((bat) => ({ bat }));

interface CricketPlay {
  fixtureId: string;
  /** The test's own fold of the scripted ledger — the expected figures. */
  card: CricketScorecard;
}

interface Scene {
  orgId: string;
  orgSlug: string;
  compSlug: string;
  competitionId: string;
  privateCompetitionId: string;
  privateCompSlug: string;
  cricketDivisionId: string;
  cricketSlug: string;
  genericSlug: string;
  singlesDivisionId: string;
  /** A second public generic division — team entrants (a bench, a forfeit, a
   *  two-roster member), and the second division snapshot rows need to reach
   *  getPublicPlayer's career-rollup return. Hari plays nothing in it. */
  extraDivisionId: string;
  persons: {
    h1: string;
    h3: string;
    h4: string;
    xavier: string;
    r1: string;
    /** Dingoes' bench, Comets v Dingoes: came on and bowled / never came on. */
    bea: string;
    ula: string;
    /** Dingoes' coach, Comets v Dingoes: a `starting` row with role `coach`. */
    cora: string;
    /** Extra division: Eagles' starter and Eagles' bench in Eagles v Foxes. */
    ivy: string;
    ben: string;
    /** On BOTH the Eagles and Gulls rosters; neither declared a lineup for their fixture. */
    dual: string;
    /** A lineup row in Eagles v Foxes on the Gulls entrant — not a side of it. */
    stray: string;
    /** Foxes' starter in Eagles v Foxes (Foxes HOME, Eagles won away). */
    jon: string;
    /** Comets' first player: bowled in the LOST fixture. */
    c1: string;
    /** Opted out of a public name. */
    chandra: string;
    /** Badminton singles, in play: Bo is HOME, Al is away. */
    bo: string;
    al: string;
    /** Merge XI: Sol and Sid both opened for Stags; Sid is merged into Sol by the
     *  merge tests. T1 bowled Stags' over. */
    sol: string;
    sid: string;
    t1: string;
  };
  /** Bo v Al: a game won, the next one open. */
  badmintonFixtureId: string;
  alEntrantId: string;
  /** Stags v Tigers, decided: two Stags batters later merged into one person. */
  mergeXI: CricketPlay;
  won: CricketPlay;
  lost: CricketPlay;
  /** Comets v Dingoes, decided; Bea came off the bench and bowled. */
  bench: CricketPlay;
  /** Rovers v Dingoes: Dingoes forfeited before a ball. Unscheduled. */
  forfeitFixtureId: string;
  roversId: string;
  eaglesFoxesFixtureId: string;
  eaglesGullsFixtureId: string;
  liveFixtureId: string;
  dingoesId: string;
  genericFixtureId: string;
  archivedFixtureId: string;
  privateFixtureId: string;
  /** Rovers v Comets: one real ball, then a config snapshot the schema refuses. */
  unfoldableFixtureId: string;
}

let scene: Scene;

async function seedPerson(orgId: string, fullName: string, consent: Record<string, boolean>): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, dob, gender, photo_path, consent)
    values (${orgId}, ${fullName}, '2000-04-03', 'f', ${"photos/" + fullName}, ${sql.json(consent)})
    returning id`;
  return id;
}

const member = (personId: string) => ({
  person_id: personId,
  squad_number: null,
  default_position_key: null,
  is_captain: false,
  roles: [] as string[],
});

async function fixturesOf(divisionId: string) {
  return sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`
    select id, home_entrant_id, away_entrant_id from fixtures where division_id = ${divisionId}`;
}

function between<T extends { home_entrant_id: string; away_entrant_id: string }>(rows: T[], a: string, b: string): T {
  const row = rows.find(
    (r) => (r.home_entrant_id === a && r.away_entrant_id === b) || (r.home_entrant_id === b && r.away_entrant_id === a),
  );
  if (!row) throw new Error(`seed: no fixture between ${a} and ${b}`);
  return row;
}

async function insertLineup(fixtureId: string, entrantId: string, personIds: string[]): Promise<void> {
  for (const [i, personId] of personIds.entries()) {
    await insertLineupRow(fixtureId, entrantId, personId, { orderNo: i + 1 });
  }
}

async function insertLineupRow(
  fixtureId: string,
  entrantId: string,
  personId: string,
  row: { orderNo: number; slot?: "starting" | "bench"; role?: "player" | "coach" | "staff" },
): Promise<void> {
  await sql`
    insert into lineups (fixture_id, entrant_id, person_id, slot, position_key, order_no, roles, role)
    values (${fixtureId}, ${entrantId}, ${personId}, ${row.slot ?? "starting"}, null, ${row.orderNo},
            ${sql.json([])}, ${row.role ?? "player"})`;
}

/** Point a generated fixture's home side at `homeId`, before anything is
 *  recorded on it — so a test that depends on which side is home does not
 *  depend on the generator's orientation. */
async function makeHome<T extends { id: string; home_entrant_id: string; away_entrant_id: string }>(
  fixture: T,
  homeId: string,
): Promise<T> {
  if (fixture.home_entrant_id === homeId) return fixture;
  await sql`update fixtures set home_entrant_id = ${homeId}, away_entrant_id = ${fixture.home_entrant_id}
            where id = ${fixture.id}`;
  return { ...fixture, home_entrant_id: homeId, away_entrant_id: fixture.home_entrant_id };
}

async function append(
  orgId: string,
  fixtureId: string,
  events: { type: string; payload: unknown }[],
  fromSeq = 0,
): Promise<void> {
  for (const [i, ev] of events.entries()) {
    await appendEvent(orgId, fixtureId, fromSeq + i, { type: ev.type, payload: ev.payload, recordedBy: null });
  }
}

/**
 * Score a scripted cricket ledger onto a real fixture through the ONE append
 * path, and fold the same script ourselves.
 *
 * `scriptLedger` names the sides "home"/"away"; the real reducer names them by
 * entrant id — `cricket.toss`'s `wonBy` is an `EntrantId`, and `sideOf` refuses
 * anything else. So the toss payload and the lineup pair are re-pointed at the
 * fixture's real entrants for BOTH the append and the test's own fold. Nothing
 * a batting or bowling line reads is touched: those key on person ids.
 *
 * `strayVoidedBall` records an extra SIX as the first ball and then voids it,
 * before the scripted first ball goes down. The ledger the reader loads then
 * carries both; the test's own fold never sees either — so a reader that forgot
 * `resolveVoids` (the scorecard fold has none of its own) reads a six nobody
 * scored.
 *
 * `afterStart` events are recorded right after `core.start` on the REAL ledger
 * only — a lineup change the database's team sheet needs and the script's own
 * lineup (which names the arriving player as a starter) does not.
 */
async function playCricket(
  orgId: string,
  fixture: { id: string; home_entrant_id: string; away_entrant_id: string },
  home: string[],
  away: string[],
  innings: Script["innings"],
  opts: { strayVoidedBall?: boolean; afterStart?: { type: string; payload: unknown }[] } = {},
): Promise<CricketScorecard> {
  const ledger = scriptLedger({ cfg: CRICKET_PARTIAL, home, away, tossWonBy: "home", elected: "bat", innings });
  const entrantOf = { home: fixture.home_entrant_id, away: fixture.away_entrant_id } as const;
  const events: EventEnvelope[] = ledger.events.map((ev) =>
    ev.type === "cricket.toss"
      ? { ...ev, payload: { ...(ev.payload as object), wonBy: entrantOf[(ev.payload as { wonBy: "home" | "away" }).wonBy] } }
      : ev,
  );
  const lineups: LineupPair = {
    home: { ...ledger.lineups.home, entrantId: fixture.home_entrant_id },
    away: { ...ledger.lineups.away, entrantId: fixture.away_entrant_id },
  };
  const firstBall = events.findIndex((ev) => ev.type === "cricket.ball");
  if (opts.strayVoidedBall && firstBall >= 0) {
    await append(orgId, fixture.id, events.slice(0, firstBall));
    const stray = await appendEvent(orgId, fixture.id, firstBall, {
      type: "cricket.ball",
      payload: { ...(events[firstBall]!.payload as object), runs: { bat: 6 }, boundary: 6 },
      recordedBy: null,
    });
    await appendEvent(orgId, fixture.id, firstBall + 1, {
      type: "core.void",
      payload: {},
      voids: stray.event.id,
      recordedBy: null,
    });
    await append(orgId, fixture.id, events.slice(firstBall), firstBall + 2);
  } else if (opts.afterStart) {
    const afterStart = events.findIndex((ev) => ev.type === "core.start") + 1;
    await append(orgId, fixture.id, [...events.slice(0, afterStart), ...opts.afterStart, ...events.slice(afterStart)]);
  } else {
    await append(orgId, fixture.id, events);
  }
  return deriveCricketScorecard({ events, cfg: ledger.cfg, lineups });
}

async function seed(): Promise<Scene> {
  const suffix = randomUUID().slice(0, 8);
  const orgSlug = `ppm-${suffix}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"PPM " + suffix}, ${orgSlug}) returning id`;
  // Pro, for `dashboard.player_profiles` (the getPublicPlayer wiring test), and
  // no active-competition cap: a community cap silently downgrades an over-cap
  // public competition to private, which would make the visibility tests pass
  // for the wrong reason.
  await setOrgPlan(orgId);
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
    values (${orgId}, 'competitions.max_active', null, 'test')`;
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('cricket', 'Cricket', ${cricket.version}, ${sql.json(cricket.positions as never)})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('cricket', 't20', 'T20', ${sql.json(cricket.variants.t20 as never)}, true)
    on conflict do nothing`;

  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };

  const open = { public_name: true };
  const h1 = await seedPerson(orgId, "Hari Nair", open);
  const h2 = await seedPerson(orgId, "Hugo Park", open);
  const h3 = await seedPerson(orgId, "Hana Lee", open);
  const h4 = await seedPerson(orgId, "Hal Moss", open);
  const squad = async (initial: string) =>
    Promise.all([1, 2, 3].map((n) => seedPerson(orgId, `${initial}${n} Player`, open)));
  const rovers = await squad("R");
  const comets = await squad("C");
  const dingoes = await squad("D");
  const chandra = await seedPerson(orgId, "Chandra Bose", { public_name: false });
  const xavier = await seedPerson(orgId, "Xavier Cole", open);
  const olga = await seedPerson(orgId, "Olga Ray", open);
  // Lineup-only people: on a team sheet, on NO roster — so nothing but a
  // lineup row can ever make a fixture theirs.
  const bea = await seedPerson(orgId, "Bea Bench", open);
  const ula = await seedPerson(orgId, "Ula Unused", open);
  const cora = await seedPerson(orgId, "Cora Coach", open);
  const stray = await seedPerson(orgId, "Sam Stray", open);
  const ivy = await seedPerson(orgId, "Ivy Eagle", open);
  const ben = await seedPerson(orgId, "Ben Eagle", open);
  const dual = await seedPerson(orgId, "Dee Dual", open);
  const jon = await seedPerson(orgId, "Jon Fox", open);
  const gil = await seedPerson(orgId, "Gil Gull", open);

  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Player Cup " + suffix,
    visibility: "public",
    branding: {},
  });
  const hidden = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Hidden Cup " + suffix,
    visibility: "private",
    branding: {},
  });

  // ---- cricket: four teams, Blazers play three times -------------------------
  const cricketDivision = await createDivision(auth, competition.id, {
    name: "T20 Open",
    slug: "t20-open",
    sport_key: "cricket",
    variant_key: "t20",
    config: {},
  } as never);
  await sql`update divisions set config = ${sql.json(cricket.configSchema.parse(CRICKET_PARTIAL) as never)}
            where id = ${cricketDivision.id}`;
  const [blazers, roversE, cometsE, dingoesE] = await createEntrants(auth, cricketDivision.id, [
    { kind: "team", display_name: "Blazers", seed: 1, members: [h1, h2, h3, h4].map(member) },
    { kind: "team", display_name: "Rovers", seed: 2, members: rovers.map(member) },
    { kind: "team", display_name: "Comets", seed: 3, members: comets.map(member) },
    { kind: "team", display_name: "Dingoes", seed: 4, members: [...dingoes, h4].map(member) },
  ] as never);
  const [cricketStage] = await createStages(auth, cricketDivision.id, { seq: 1, kind: "league", name: "League", config: {} });
  await generateStageFixtures(auth, cricketStage!.id);
  await startDivision(auth, cricketDivision.id);
  const cricketFixtures = await fixturesOf(cricketDivision.id);

  const B = blazers!.id;
  const blazersXI = [h1, h2, h3];
  /** Blazers v `opponent`, decided the way `blazersWin` says. Home bats first
   *  (toss won by home, elected bat), so which innings is the big one follows
   *  from which side Blazers are on. No wickets fall: the third batter never
   *  reaches the crease, and Blazers' first player opens AND bowls. */
  const decide = async (
    opponentId: string,
    opponentXI: string[],
    blazersWin: boolean,
    opts: { strayVoidedBall?: boolean } = {},
  ): Promise<CricketPlay> => {
    const f = between(cricketFixtures, B, opponentId);
    await insertLineup(f.id, B, blazersXI);
    await insertLineup(f.id, opponentId, opponentXI);
    const blazersHome = f.home_entrant_id === B;
    const home = blazersHome ? blazersXI : opponentXI;
    const away = blazersHome ? opponentXI : blazersXI;
    const firstWins = blazersHome === blazersWin;
    const card = await playCricket(orgId, f, home, away, [
      { batting: "home", bowlers: [away[0]!], deliveries: firstWins ? bats(4, 1, 6, 0, 2, 1) : bats(1, 0, 0, 0, 0, 0) },
      { batting: "away", bowlers: [home[0]!], deliveries: firstWins ? bats(0, 1, 0, 0, 0, 0) : bats(4) },
    ], opts);
    return { fixtureId: f.id, card };
  };
  const won = await decide(roversE!.id, rovers, true);
  const lost = await decide(cometsE!.id, comets, false, { strayVoidedBall: true });
  // The WON fixture's frozen config becomes the PARTIAL it was written from —
  // the shape of a snapshot taken under an older schema, with none of today's
  // defaults. The scorecard fold throws on it raw; parsed, it folds exactly as
  // the full config did. So the WON line is also the witness that the reader
  // parses the snapshot rather than folding it raw.
  await sql`update fixtures set config_snapshot = ${sql.json(CRICKET_PARTIAL)} where id = ${won.fixtureId}`;

  // Blazers v Dingoes, IN PLAY, with a declared XI that leaves Hari out and
  // brings Hal in: toss and start only. Hal is ALSO still on the Dingoes roster
  // (a transfer nobody cleaned up) and Dingoes have not declared their XI yet —
  // so the roster fallback would name Dingoes as Hal's side too. The declared
  // XI is the stronger fact and must win. Dingoes are made HOME: a tie-break
  // that preferred the home side would then pick the roster row, so only the
  // lineup-first precedence places Hal with Blazers.
  const live = await makeHome(between(cricketFixtures, B, dingoesE!.id), dingoesE!.id);
  await insertLineup(live.id, B, [h2, h3, h4]);
  await playCricket(orgId, live, dingoes, [h2, h3, h4], []);

  // Rovers v Comets, IN PLAY after one ball — then its frozen config is
  // replaced with one the cricket schema refuses, the shape of a snapshot taken
  // under an older module. Its figures cannot be folded; the page must still
  // render every other line.
  const unfoldable = between(cricketFixtures, roversE!.id, cometsE!.id);
  await insertLineup(unfoldable.id, roversE!.id, rovers);
  await insertLineup(unfoldable.id, cometsE!.id, comets);
  const roversHome = unfoldable.home_entrant_id === roversE!.id;
  const [ufHome, ufAway] = roversHome ? [rovers, comets] : [comets, rovers];
  await playCricket(orgId, unfoldable, ufHome, ufAway, [
    { batting: "home", bowlers: [ufAway[0]!], deliveries: bats(1), leaveOpen: true },
  ]);
  await sql`update fixtures set config_snapshot = ${sql.json({ ballsPerOver: "six" })} where id = ${unfoldable.id}`;
  // Never scheduled, and the NEWEST thing Rovers played: its last recorded
  // moment is after every scheduled date in the scene. So Rovers' list opens
  // with the one fixture that cannot fold — a fold loop that gave up at its
  // first failure would take every later line down with it.
  await sql`update match_states set updated_at = '2030-12-01T10:00:00Z' where fixture_id = ${unfoldable.id}`;

  // Rovers v Dingoes: Dingoes FORFEIT before a ball is bowled. Both sides had
  // declared their XI (so Hal, still on the Dingoes roster, is not dragged in).
  // Never scheduled; recorded now, i.e. before every 2030 date in the scene.
  const forfeit = between(cricketFixtures, roversE!.id, dingoesE!.id);
  await insertLineup(forfeit.id, roversE!.id, rovers);
  await insertLineup(forfeit.id, dingoesE!.id, dingoes);
  await append(orgId, forfeit.id, [{ type: "core.forfeit", payload: { by: dingoesE!.id, reason: "walkover" } }]);

  // Comets v Dingoes, decided. Dingoes' team sheet: three starters, a COACH on
  // a starting row, and two on the bench. Bea comes on for D3 straight after the
  // start and bowls Dingoes' over; Ula never comes on. The script's own lineup
  // names Bea in D3's place, which is what the match actually was.
  const cd = between(cricketFixtures, cometsE!.id, dingoesE!.id);
  await insertLineup(cd.id, cometsE!.id, comets);
  await insertLineup(cd.id, dingoesE!.id, dingoes);
  await insertLineupRow(cd.id, dingoesE!.id, cora, { orderNo: 4, role: "coach" });
  await insertLineupRow(cd.id, dingoesE!.id, ula, { orderNo: 5, slot: "bench" });
  await insertLineupRow(cd.id, dingoesE!.id, bea, { orderNo: 6, slot: "bench" });
  const dingoesHome = cd.home_entrant_id === dingoesE!.id;
  const dingoesPlayed = [dingoes[0]!, dingoes[1]!, bea];
  const [cdHome, cdAway] = dingoesHome ? [dingoesPlayed, comets] : [comets, dingoesPlayed];
  const benchCard = await playCricket(
    orgId,
    cd,
    cdHome,
    cdAway,
    [
      { batting: "home", bowlers: [dingoesHome ? comets[0]! : bea], deliveries: bats(4, 1, 6, 0, 2, 1) },
      { batting: "away", bowlers: [dingoesHome ? bea : comets[0]!], deliveries: bats(0, 1, 0, 0, 0, 0) },
    ],
    {
      afterStart: [
        {
          type: "core.lineup.substitution",
          payload: { side: dingoesE!.id, off: dingoes[2]!, on: { personId: bea, slot: "starting", orderNo: 3 } },
        },
      ],
    },
  );
  await sql`update fixtures set scheduled_at = '2030-05-01T10:00:00Z' where id = ${cd.id}`;

  // Venue lane: the division's own zone differs from the org's, so a line that
  // read the org zone alone would disagree.
  await sql`update organizations set timezone = 'Europe/Madrid' where id = ${orgId}`;
  await sql`
    insert into schedule_settings (division_id, org_id, tz) values (${cricketDivision.id}, ${orgId}, 'Asia/Kolkata')
    on conflict (division_id) do update set tz = excluded.tz`;

  await sql`update fixtures set scheduled_at = '2030-06-01T10:00:00Z' where id = ${won.fixtureId}`;
  await sql`update fixtures set scheduled_at = '2030-06-08T10:00:00Z' where id = ${lost.fixtureId}`;
  await sql`update fixtures set scheduled_at = '2030-06-10T10:00:00Z' where id = ${live.id}`;

  // ---- generic singles: individual entrants, NO lineups ever declared --------
  const singles = await createDivision(auth, competition.id, {
    name: "Singles",
    slug: "singles",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  const [hariE, chandraE, xavierE] = await createEntrants(auth, singles.id, [
    { kind: "individual", display_name: "Hari Nair", seed: 1, members: [member(h1)] },
    { kind: "individual", display_name: "Chandra Bose", seed: 2, members: [member(chandra)] },
    { kind: "individual", display_name: "Xavier Cole", seed: 3, members: [member(xavier)] },
  ] as never);
  const [singlesStage] = await createStages(auth, singles.id, { seq: 1, kind: "league", name: "Singles", config: {} });
  await generateStageFixtures(auth, singlesStage!.id);
  await startDivision(auth, singles.id);
  const singlesFixtures = await fixturesOf(singles.id);
  const hariVsChandra = between(singlesFixtures, hariE!.id, chandraE!.id);
  const hariHome = hariVsChandra.home_entrant_id === hariE!.id;
  await append(orgId, hariVsChandra.id, [
    { type: "core.start", payload: {} },
    { type: "generic.result", payload: hariHome ? { p1Score: 2, p2Score: 1 } : { p1Score: 1, p2Score: 2 } },
  ]);
  await sql`update fixtures set scheduled_at = '2030-06-15T10:00:00Z' where id = ${hariVsChandra.id}`;
  // Hari v Xavier and Chandra v Xavier stay SCHEDULED: never played.
  void xavierE;
  const extra = await createDivision(auth, competition.id, {
    name: "Extra",
    slug: "extra",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  // ---- generic TEAMS: a bench outside cricket, a forfeit, a two-roster member --
  const [eaglesE, foxesE, gullsE] = await createEntrants(auth, extra.id, [
    { kind: "team", display_name: "Eagles", seed: 1, members: [ivy, ben, dual].map(member) },
    { kind: "team", display_name: "Foxes", seed: 2, members: [jon].map(member) },
    { kind: "team", display_name: "Gulls", seed: 3, members: [gil, dual].map(member) },
  ] as never);
  const [extraStage] = await createStages(auth, extra.id, { seq: 1, kind: "league", name: "Extra", config: {} });
  await generateStageFixtures(auth, extraStage!.id);
  await startDivision(auth, extra.id);
  const extraFixtures = await fixturesOf(extra.id);
  // Foxes (made HOME) v Eagles, decided 0-2 — an AWAY win, so a home-first
  // headline ("0 — 2") reads backwards for the winners. Both sheets declared:
  // Ivy starts, Ben sits on the bench. Then a row nobody cleaned up: Sam, on a
  // sheet for the GULLS entrant, who are not a side of this fixture.
  const eaglesFoxes = await makeHome(between(extraFixtures, eaglesE!.id, foxesE!.id), foxesE!.id);
  await insertLineupRow(eaglesFoxes.id, eaglesE!.id, ivy, { orderNo: 1 });
  await insertLineupRow(eaglesFoxes.id, eaglesE!.id, ben, { orderNo: 2, slot: "bench" });
  await insertLineupRow(eaglesFoxes.id, foxesE!.id, jon, { orderNo: 1 });
  await append(orgId, eaglesFoxes.id, [
    { type: "core.start", payload: {} },
    { type: "generic.result", payload: { p1Score: 0, p2Score: 2 } },
  ]);
  await insertLineupRow(eaglesFoxes.id, gullsE!.id, stray, { orderNo: 1 });
  await sql`update fixtures set scheduled_at = '2030-08-01T10:00:00Z' where id = ${eaglesFoxes.id}`;
  // Eagles (made HOME) v Gulls: Gulls forfeit, nobody declared a sheet. Dee is
  // on BOTH rosters, so both sides are "hers" by roster alone.
  const eaglesGulls = await makeHome(between(extraFixtures, eaglesE!.id, gullsE!.id), eaglesE!.id);
  await append(orgId, eaglesGulls.id, [{ type: "core.forfeit", payload: { by: gullsE!.id, reason: "walkover" } }]);
  await sql`update fixtures set scheduled_at = '2030-08-02T10:00:00Z' where id = ${eaglesGulls.id}`;

  // ---- an ARCHIVED division of the same public competition --------------------
  const archive = await createDivision(auth, competition.id, {
    name: "Archive",
    slug: "archive",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await createEntrants(auth, archive.id, [
    { kind: "individual", display_name: "Hari Nair", seed: 1, members: [member(h1)] },
    { kind: "individual", display_name: "Olga Ray", seed: 2, members: [member(olga)] },
  ] as never);
  const [archiveStage] = await createStages(auth, archive.id, { seq: 1, kind: "league", name: "Archive", config: {} });
  await generateStageFixtures(auth, archiveStage!.id);
  await startDivision(auth, archive.id);
  const [archived] = await fixturesOf(archive.id);
  await append(orgId, archived!.id, [
    { type: "core.start", payload: {} },
    { type: "generic.result", payload: { p1Score: 3, p2Score: 0 } },
  ]);
  await sql`update fixtures set scheduled_at = '2030-07-01T10:00:00Z' where id = ${archived!.id}`;
  await sql`update divisions set archived_at = now() where id = ${archive.id}`;

  // ---- a PRIVATE competition --------------------------------------------------
  const privateDivision = await createDivision(auth, hidden.id, {
    name: "Private",
    slug: "private",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await createEntrants(auth, privateDivision.id, [
    { kind: "individual", display_name: "Hari Nair", seed: 1, members: [member(h1)] },
    { kind: "individual", display_name: "Olga Ray", seed: 2, members: [member(olga)] },
  ] as never);
  const [privateStage] = await createStages(auth, privateDivision.id, { seq: 1, kind: "league", name: "Private", config: {} });
  await generateStageFixtures(auth, privateStage!.id);
  await startDivision(auth, privateDivision.id);
  const [privateFixture] = await fixturesOf(privateDivision.id);
  await append(orgId, privateFixture!.id, [{ type: "core.start", payload: {} }]);

  // ---- badminton singles, IN PLAY: a game won, the next one open ------------
  // Through the one append path, so the summary the reader gets is the one the
  // write path stored. Bo is made HOME.
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('badminton', 'Badminton', ${badminton.version}, ${sql.json(badminton.positions as never)})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('badminton', 'bwf', 'BWF', ${sql.json(badminton.variants.bwf as never)}, true)
    on conflict do nothing`;
  const bo = await seedPerson(orgId, "Bo Home", open);
  const al = await seedPerson(orgId, "Al Away", open);
  const shuttle = await createDivision(auth, competition.id, {
    name: "Badminton",
    slug: "badminton",
    sport_key: "badminton",
    variant_key: "bwf",
    config: {},
  } as never);
  const [boE, alE] = await createEntrants(auth, shuttle.id, [
    { kind: "individual", display_name: "Bo Home", seed: 1, members: [member(bo)] },
    { kind: "individual", display_name: "Al Away", seed: 2, members: [member(al)] },
  ] as never);
  const [shuttleStage] = await createStages(auth, shuttle.id, { seq: 1, kind: "league", name: "Badminton", config: {} });
  await generateStageFixtures(auth, shuttleStage!.id);
  await startDivision(auth, shuttle.id);
  const [shuttleRow] = await fixturesOf(shuttle.id);
  const badmintonMatch = await makeHome(shuttleRow!, boE!.id);
  const rally = (wonBy: string) => ({ type: "badminton.rally", payload: { wonBy } });
  await append(orgId, badmintonMatch.id, [
    { type: "core.start", payload: {} },
    ...[...Array<string>(15).fill(alE!.id), ...Array<string>(21).fill(boE!.id)].map(rally),
    ...[boE!.id, boE!.id, alE!.id, alE!.id, alE!.id].map(rally),
  ]);

  // ---- Merge XI: two people who BOTH batted for one side ----------------------
  // The duplicate-record case a merge exists for, played before anyone noticed:
  // Sol and Sid open for Stags and both face balls (the single on the second
  // ball rotates the strike); Sol also bowls Tigers' over. The merge itself is
  // done by the tests, so the fixture is folded under the sheet a merge leaves.
  const mergeDivision = await createDivision(auth, competition.id, {
    name: "Merge XI",
    slug: "merge-xi",
    sport_key: "cricket",
    variant_key: "t20",
    config: {},
  } as never);
  await sql`update divisions set config = ${sql.json(cricket.configSchema.parse(CRICKET_PARTIAL) as never)}
            where id = ${mergeDivision.id}`;
  const stags = [
    await seedPerson(orgId, "Sol Stag", open),
    await seedPerson(orgId, "Sid Stag", open),
    await seedPerson(orgId, "Stu Stag", open),
  ];
  const tigers = await squad("T");
  const [stagsE, tigersE] = await createEntrants(auth, mergeDivision.id, [
    { kind: "team", display_name: "Stags", seed: 1, members: stags.map(member) },
    { kind: "team", display_name: "Tigers", seed: 2, members: tigers.map(member) },
  ] as never);
  const [mergeStage] = await createStages(auth, mergeDivision.id, { seq: 1, kind: "league", name: "Merge", config: {} });
  await generateStageFixtures(auth, mergeStage!.id);
  await startDivision(auth, mergeDivision.id);
  const [mergeRow] = await fixturesOf(mergeDivision.id);
  const mergeFixture = await makeHome(mergeRow!, stagsE!.id);
  await insertLineup(mergeFixture.id, stagsE!.id, stags);
  await insertLineup(mergeFixture.id, tigersE!.id, tigers);
  const mergeCard = await playCricket(orgId, mergeFixture, stags, tigers, [
    { batting: "home", bowlers: [tigers[0]!], deliveries: bats(4, 1, 6, 0, 2, 1) },
    { batting: "away", bowlers: [stags[0]!], deliveries: bats(0, 1, 0, 0, 0, 0) },
  ]);

  return {
    orgId,
    orgSlug,
    compSlug: competition.slug,
    competitionId: competition.id,
    privateCompetitionId: hidden.id,
    privateCompSlug: hidden.slug,
    cricketDivisionId: cricketDivision.id,
    cricketSlug: cricketDivision.slug,
    genericSlug: singles.slug,
    singlesDivisionId: singles.id,
    extraDivisionId: extra.id,
    persons: {
      ...{ h1, h3, h4, xavier, r1: rovers[0]!, bea, ula, cora, ivy, ben, dual, stray, jon, c1: comets[0]!, chandra },
      ...{ bo, al, sol: stags[0]!, sid: stags[1]!, t1: tigers[0]! },
    },
    badmintonFixtureId: badmintonMatch.id,
    alEntrantId: alE!.id,
    mergeXI: { fixtureId: mergeFixture.id, card: mergeCard },
    won,
    lost,
    bench: { fixtureId: cd.id, card: benchCard },
    forfeitFixtureId: forfeit.id,
    roversId: roversE!.id,
    eaglesFoxesFixtureId: eaglesFoxes.id,
    eaglesGullsFixtureId: eaglesGulls.id,
    liveFixtureId: live.id,
    dingoesId: dingoesE!.id,
    genericFixtureId: hariVsChandra.id,
    archivedFixtureId: archived!.id,
    privateFixtureId: privateFixture!.id,
    unfoldableFixtureId: unfoldable.id,
  };
}

const linesFor = (personId: string, over: { competitionId?: string } = {}): Promise<PlayerMatchLine[]> =>
  readPlayerMatchLines(sql, {
    personId,
    competitionId: over.competitionId ?? scene.competitionId,
    orgSlug: scene.orgSlug,
    compSlug: scene.compSlug,
    locale: "en",
  });

/** The expected cricket line, off the test's own fold, in the literal English
 *  template the plan specifies. A single appearance per person here, so `find`
 *  is the whole story (the multi-innings sum is pinned in the pure half). */
function expectedCricketLine(card: CricketScorecard, personId: string): string {
  const bat = card.innings.flatMap((i) => i.batting).find((b) => b.person === personId);
  const bowl = card.innings.flatMap((i) => i.bowling).find((b) => b.person === personId);
  if (bat && bowl) return `${bat.runs} (${bat.balls}) & ${bowl.wickets}/${bowl.runs}`;
  if (bat) return `${bat.runs} (${bat.balls})`;
  if (bowl) return `${bowl.wickets}/${bowl.runs}`;
  return "—";
}

/** The expected line for one person recorded under several ids (a merge): each
 *  id's batting and bowling off the test's own fold, summed by hand. */
function expectedSummedCricketLine(card: CricketScorecard, personIds: string[]): string {
  const bat = card.innings.flatMap((i) => i.batting).filter((b) => personIds.includes(b.person));
  const bowl = card.innings.flatMap((i) => i.bowling).filter((b) => personIds.includes(b.person));
  const sum = <T,>(rows: T[], pick: (row: T) => number) => rows.reduce((n, row) => n + pick(row), 0);
  const batting = bat.length === 0 ? null : `${sum(bat, (b) => b.runs)} (${sum(bat, (b) => b.balls)})`;
  const bowling = bowl.length === 0 ? null : `${sum(bowl, (b) => b.wickets)}/${sum(bowl, (b) => b.runs)}`;
  return [batting, bowling].filter((part) => part !== null).join(" & ") || "—";
}

beforeAll(async () => {
  if (!HAS_DB) return;
  scene = await seed();
}, 120_000);

// Every test starts with an empty figures cache and a zeroed fold count, so a
// test's folds are its own and no test passes on a figure an earlier one cached.
beforeEach(() => {
  nextCache.store.clear();
  nextCache.storedPrefixes.clear();
  nextCache.storedPrefixes.add("pub-player-figures");
  foldSpy.calls.length = 0;
  foldSpy.poison.clear();
});

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("readPlayerMatchLines against real Postgres", () => {
  it("EMPTY: a rostered person whose fixtures were never played has no lines", async () => {
    // The positive pair first: Xavier IS a side of two real fixtures, so an
    // empty answer is about status, not about a person the query cannot see.
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from fixtures f
      join entrant_members em on em.entrant_id in (f.home_entrant_id, f.away_entrant_id)
      where em.person_id = ${scene.persons.xavier}
        and f.home_entrant_id is not null and f.away_entrant_id is not null`;
    expect(n).toBe(2);
    // #850: the three-player singles league also rests Xavier for one round on
    // a persisted bye row — SETTLED (`forfeited`, one of the played statuses)
    // from generation. It is not an appearance either, so it adds no line.
    const [{ b }] = await sql<{ b: number }[]>`
      select count(*)::int as b from fixtures f
      join entrant_members em on em.entrant_id in (f.home_entrant_id, f.away_entrant_id)
      where em.person_id = ${scene.persons.xavier}
        and (f.home_entrant_id is null) <> (f.away_entrant_id is null) and f.status = 'forfeited'`;
    expect(b).toBe(1);
    expect(await linesFor(scene.persons.xavier)).toEqual([]);
  });

  it("EMPTY: a person with no fixtures at all has no lines", async () => {
    expect(await linesFor(randomUUID())).toEqual([]);
  });

  it("lists the person's PLAYED fixtures in this competition, newest first, and nothing else", async () => {
    const lines = await linesFor(scene.persons.h1);
    expect(lines.map((l) => l.fixtureId)).toEqual([scene.genericFixtureId, scene.lost.fixtureId, scene.won.fixtureId]);
    expect(lines.map((l) => l.scheduledAt)).toEqual([
      "2030-06-15T10:00:00.000Z",
      "2030-06-08T10:00:00.000Z",
      "2030-06-01T10:00:00.000Z",
    ]);
  });

  it("cricket WON: the line is the engine fold's own figures, and the result names the person's side", async () => {
    const line = (await linesFor(scene.persons.h1)).find((l) => l.fixtureId === scene.won.fixtureId)!;
    const bat = scene.won.card.innings.flatMap((i) => i.batting).find((b) => b.person === scene.persons.h1);
    const bowl = scene.won.card.innings.flatMap((i) => i.bowling).find((b) => b.person === scene.persons.h1);
    // Premise: Hari opened AND bowled, and scored — so a "—" or a zero line
    // cannot pass by coincidence.
    expect(bat).toBeDefined();
    expect(bowl).toBeDefined();
    expect(bat!.runs).toBeGreaterThan(0);
    expect(line.line).toBe(`${bat!.runs} (${bat!.balls}) & ${bowl!.wickets}/${bowl!.runs}`);
    expect(line.result).toBe("won");
    expect(line).toMatchObject({
      href: `/shared/${scene.orgSlug}/${scene.compSlug}/${scene.cricketSlug}/fixtures/${scene.won.fixtureId}`,
      divisionName: "T20 Open",
      divisionSlug: scene.cricketSlug,
      opponentName: "Rovers",
      tz: await venueTzForDivision(scene.cricketDivisionId),
    });
    expect(line.tz).toBe("Asia/Kolkata"); // the division's zone, not the org's Europe/Madrid
  });

  it("cricket LOST: the other side won — 'lost', with that fixture's own figures and its VOIDED six left out", async () => {
    // Premise: this ledger really carries a voided ball, so the figure match
    // below is a claim about void resolution and not about a clean ledger.
    const [{ voids }] = await sql<{ voids: number }[]>`
      select count(*)::int as voids from score_events
      where fixture_id = ${scene.lost.fixtureId} and type = 'core.void'`;
    expect(voids).toBe(1);
    const line = (await linesFor(scene.persons.h1)).find((l) => l.fixtureId === scene.lost.fixtureId)!;
    expect(line.result).toBe("lost");
    expect(line.line).toBe(expectedCricketLine(scene.lost.card, scene.persons.h1));
    expect(line.line).not.toBe("—");
    // The two fixtures' figures differ, so a line read off the wrong fixture's
    // fold cannot pass both this test and the WON one.
    expect(line.line).not.toBe(expectedCricketLine(scene.won.card, scene.persons.h1));
    expect(line.opponentName).toBe("Comets");
  });

  it("a player who neither batted nor bowled keeps the row, reading '—'", async () => {
    // Premise off the test's own fold: Hana was in the XI and did neither.
    expect(expectedCricketLine(scene.won.card, scene.persons.h3)).toBe("—");
    const line = (await linesFor(scene.persons.h3)).find((l) => l.fixtureId === scene.won.fixtureId);
    expect(line).toBeDefined();
    expect(line!.line).toBe("—");
    expect(line!.result).toBe("won");
  });

  it("a declared XI that leaves a member out is not that member's appearance; the member brought in is LIVE", async () => {
    const hari = await linesFor(scene.persons.h1);
    expect(hari.map((l) => l.fixtureId)).not.toContain(scene.liveFixtureId);
    const hal = await linesFor(scene.persons.h4);
    expect(hal.map((l) => l.fixtureId)).toEqual([scene.liveFixtureId]);
    expect(hal[0]).toMatchObject({ result: "live", line: "—" });
  });

  it("a member on BOTH rosters is placed on the side whose declared XI names them, not the undeclared side", async () => {
    // Premise: Hal is on the Dingoes roster, and Dingoes declared no XI for
    // this fixture — so the roster fallback alone WOULD place Hal with Dingoes.
    const [premise] = await sql<{ on_dingoes_roster: boolean; dingoes_lineup_rows: number }[]>`
      select exists (select 1 from entrant_members em join entrants e on e.id = em.entrant_id
                     where em.person_id = ${scene.persons.h4} and e.display_name = 'Dingoes') as on_dingoes_roster,
             (select count(*)::int from lineups l join entrants e on e.id = l.entrant_id
              where l.fixture_id = ${scene.liveFixtureId} and e.display_name = 'Dingoes') as dingoes_lineup_rows`;
    expect(premise).toEqual({ on_dingoes_roster: true, dingoes_lineup_rows: 0 });
    // And Dingoes are the HOME side, so a "prefer home" tie-break alone would
    // pick the roster row: only lineup-first precedence places Hal with Blazers.
    const [{ home }] = await sql<{ home: string }[]>`
      select home_entrant_id as home from fixtures where id = ${scene.liveFixtureId}`;
    expect(home).toBe(scene.dingoesId);
    const [line] = await linesFor(scene.persons.h4);
    expect(line!.opponentName).toBe("Dingoes");
  });

  it("TIE-BREAK: a member on both rosters of a fixture neither side declared a sheet for is placed on the HOME side", async () => {
    const [premise] = await sql<{ home: string; rosters: number; sheets: number }[]>`
      select e.display_name as home,
             (select count(*)::int from entrant_members em
               where em.person_id = ${scene.persons.dual}
                 and em.entrant_id in (f.home_entrant_id, f.away_entrant_id)) as rosters,
             (select count(*)::int from lineups l where l.fixture_id = f.id) as sheets
      from fixtures f join entrants e on e.id = f.home_entrant_id
      where f.id = ${scene.eaglesGullsFixtureId}`;
    expect(premise).toEqual({ home: "Eagles", rosters: 2, sheets: 0 });
    const lines = await linesFor(scene.persons.dual);
    expect(lines.map((l) => l.fixtureId)).toEqual([scene.eaglesGullsFixtureId]);
    expect(lines[0]).toMatchObject({ opponentName: "Gulls", result: "won" });
  });

  it("ROLE: a coach's row on a team sheet — even a STARTING one — is not an appearance", async () => {
    // Positive pair: Cora's row is real, starting, in a decided fixture.
    const [row] = await sql<{ slot: string; role: string; status: string }[]>`
      select l.slot, l.role, f.status from lineups l join fixtures f on f.id = l.fixture_id
      where l.person_id = ${scene.persons.cora}`;
    expect(row).toEqual({ slot: "starting", role: "coach", status: "decided" });
    expect(await linesFor(scene.persons.cora)).toEqual([]);
  });

  it("BENCH (cricket): a bench row whose player never batted or bowled is not an appearance", async () => {
    const [row] = await sql<{ slot: string; role: string }[]>`
      select slot, role from lineups where person_id = ${scene.persons.ula}`;
    expect(row).toEqual({ slot: "bench", role: "player" });
    expect(expectedCricketLine(scene.bench.card, scene.persons.ula)).toBe("—");
    expect(await linesFor(scene.persons.ula)).toEqual([]);
  });

  it("BENCH (cricket): a bench player who came on and bowled is listed, with the figures the real ledger folds to", async () => {
    // Premise: Bea's row still says bench, the write path accepted her arrival,
    // and she really bowled (the test's own fold, over the effective sheet).
    const [row] = await sql<{ slot: string; subs: number }[]>`
      select l.slot,
             (select count(*)::int from score_events s
               where s.fixture_id = l.fixture_id and s.type = 'core.lineup.substitution') as subs
      from lineups l where l.person_id = ${scene.persons.bea}`;
    expect(row).toEqual({ slot: "bench", subs: 1 });
    const figures = expectedCricketLine(scene.bench.card, scene.persons.bea);
    expect(figures).toMatch(/^\d+\/\d+$/);
    // The reader's SQL half carries the bench row; the bench policy decides.
    const seeds = await readPlayerMatchSeeds(sql, {
      personId: scene.persons.bea,
      competitionId: scene.competitionId,
      orgSlug: scene.orgSlug,
      compSlug: scene.compSlug,
      locale: "en",
    });
    expect(seeds.map((x) => [x.fixtureId, x.slot])).toEqual([[scene.bench.fixtureId, "bench"]]);
    // Was the KNOWN ENGINE GAP: the scorecard fold refused the kernel's lineup
    // events, so this ledger could not be folded and no bench row was ever
    // listed. The fold now reads them (fix/cricket-scorecard-core-events): the
    // REAL ledger folds, gives Bea the same figures as the test's own fold, and
    // the policy's positive branch admits her row.
    const inputs = await sql.begin((tx) => loadFoldInputs(tx, scene.bench.fixtureId));
    const card = deriveCricketScorecard({
      events: inputs!.envelopes,
      cfg: cricket.configSchema.parse(inputs!.cfg),
      lineups: inputs!.lineups,
    });
    expect(expectedCricketLine(card, scene.persons.bea)).toBe(figures);
    const lines = await linesFor(scene.persons.bea);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ fixtureId: scene.bench.fixtureId, line: figures });
  });

  it("BENCH (other sports): a bench row is not an appearance; the same player's roster-only fixture still is", async () => {
    const ivy = await linesFor(scene.persons.ivy);
    expect(ivy.map((l) => l.fixtureId)).toContain(scene.eaglesFoxesFixtureId); // the starter's positive pair
    const ben = await linesFor(scene.persons.ben);
    expect(ben.map((l) => l.fixtureId)).toEqual([scene.eaglesGullsFixtureId]);
  });

  it("A lineup row on an entrant that is not a side of the fixture places nobody", async () => {
    const [row] = await sql<{ is_side: boolean; status: string }[]>`
      select l.entrant_id in (f.home_entrant_id, f.away_entrant_id) as is_side, f.status
      from lineups l join fixtures f on f.id = l.fixture_id where l.person_id = ${scene.persons.stray}`;
    expect(row).toEqual({ is_side: false, status: "decided" });
    expect(await linesFor(scene.persons.stray)).toEqual([]);
  });

  it("FORFEITED: listed, the result read off the award's winner, and '—' with no figures", async () => {
    const [{ status }] = await sql<{ status: string }[]>`
      select status from fixtures where id = ${scene.forfeitFixtureId}`;
    expect(status).toBe("forfeited");
    const line = (await linesFor(scene.persons.r1)).find((l) => l.fixtureId === scene.forfeitFixtureId);
    expect(line).toMatchObject({ result: "won", line: "—", opponentName: "Dingoes" });
  });

  it("the settled lines agree with the career rollup's own match count, forfeits included", async () => {
    for (const [personId, divisionId] of [
      [scene.persons.r1, scene.cricketDivisionId],
      [scene.persons.ivy, scene.extraDivisionId],
    ] as const) {
      const counted = (await countMatchesByDivision(sql, { by: "person", personId }, [divisionId])).get(divisionId);
      const settled = (await linesFor(personId)).filter((l) => l.result !== "live").length;
      expect(counted).toBe(2);
      expect(settled).toBe(counted);
    }
  });

  it("ORDER: an unscheduled fixture sorts by when it was last recorded, not to either end", async () => {
    const rows = await sql<{ id: string; scheduled_at: Date | null; updated_at: Date }[]>`
      select f.id, f.scheduled_at, m.updated_at from fixtures f join match_states m on m.fixture_id = f.id
      where f.id in ${sql([scene.unfoldableFixtureId, scene.forfeitFixtureId, scene.won.fixtureId])}`;
    const at = (id: string) => rows.find((r) => r.id === id)!;
    // Premise: two unscheduled fixtures, one recorded after the scheduled one
    // and one before it.
    expect(at(scene.unfoldableFixtureId).scheduled_at).toBeNull();
    expect(at(scene.forfeitFixtureId).scheduled_at).toBeNull();
    expect(at(scene.unfoldableFixtureId).updated_at.getTime()).toBeGreaterThan(at(scene.won.fixtureId).scheduled_at!.getTime());
    expect(at(scene.forfeitFixtureId).updated_at.getTime()).toBeLessThan(at(scene.won.fixtureId).scheduled_at!.getTime());
    const lines = await linesFor(scene.persons.r1);
    expect(lines.map((l) => l.fixtureId)).toEqual([scene.unfoldableFixtureId, scene.won.fixtureId, scene.forfeitFixtureId]);
  });

  it("a side with NO declared lineup (individual entrants): the rostered member appears, with the score THEIR side first", async () => {
    const line = (await linesFor(scene.persons.h1)).find((l) => l.fixtureId === scene.genericFixtureId)!;
    // Hari won 2-1; Chandra, on the other side, reads the same match 1 — 2.
    expect(line.line).toBe("2 — 1");
    expect(line.result).toBe("won");
    const chandra = (await linesFor(scene.persons.chandra)).find((l) => l.fixtureId === scene.genericFixtureId)!;
    expect(chandra).toMatchObject({ line: "1 — 2", result: "lost" });
    expect(line.href).toBe(
      `/shared/${scene.orgSlug}/${scene.compSlug}/${scene.genericSlug}/fixtures/${scene.genericFixtureId}`,
    );
  });

  it("DEGRADE: a cricket fixture whose config cannot be folded reads '—' — and costs no other line", async () => {
    // Premise: the fixture really was played (one ball is in the ledger), so
    // "—" here is the refused fold, not an empty match.
    const [premise] = await sql<{ balls: number; status: string }[]>`
      select (select count(*)::int from score_events where fixture_id = f.id and type = 'cricket.ball') as balls,
             f.status
      from fixtures f where f.id = ${scene.unfoldableFixtureId}`;
    expect(premise).toEqual({ balls: 1, status: "in_play" });
    const lines = await linesFor(scene.persons.r1);
    // The broken fixture is the NEWEST line — the first one folded — so a fold
    // that stopped at its first failure would cost every line after it.
    expect(lines[0]).toMatchObject({ fixtureId: scene.unfoldableFixtureId, line: "—" });
    // Rovers' first player bowled against Blazers: that line folds as normal.
    const won = lines.find((l) => l.fixtureId === scene.won.fixtureId)!;
    expect(won.line).toBe(expectedCricketLine(scene.won.card, scene.persons.r1));
    expect(won.line).not.toBe("—");
  });

  it("DEGRADE: a DATABASE error folding one fixture costs that fixture only — it poisons no later fold", async () => {
    // `select 1/0` inside the newest fixture's fold. Were the folds sharing a
    // transaction, Postgres would refuse every later statement in it
    // ("current transaction is aborted") and the WON line below would be "—".
    foldSpy.poison.add(scene.unfoldableFixtureId);
    const lines = await linesFor(scene.persons.r1);
    expect(foldsOf(scene.unfoldableFixtureId)).toBe(1);
    expect(lines[0]).toMatchObject({ fixtureId: scene.unfoldableFixtureId, line: "—" });
    const won = lines.find((l) => l.fixtureId === scene.won.fixtureId)!;
    expect(won.line).toBe(expectedCricketLine(scene.won.card, scene.persons.r1));
    expect(won.line).not.toBe("—");
  });

  it("CACHE: one fold per (fixture, last recorded event) serves every later read and every person", async () => {
    const first = await linesFor(scene.persons.h1);
    expect([foldsOf(scene.won.fixtureId), foldsOf(scene.lost.fixtureId)]).toEqual([1, 1]);
    // Same person again, and another player of the WON fixture: nothing re-folds,
    // and the figures read back from the cache are the same figures.
    expect(await linesFor(scene.persons.h1)).toEqual(first);
    const rover = (await linesFor(scene.persons.r1)).find((l) => l.fixtureId === scene.won.fixtureId)!;
    expect(rover.line).toBe(expectedCricketLine(scene.won.card, scene.persons.r1));
    expect([foldsOf(scene.won.fixtureId), foldsOf(scene.lost.fixtureId)]).toEqual([1, 1]);
  });

  it("CACHE: a new event on a fixture moves its last_seq and re-folds that fixture — only that one", async () => {
    await linesFor(scene.persons.h1);
    expect([foldsOf(scene.won.fixtureId), foldsOf(scene.lost.fixtureId)]).toEqual([1, 1]);
    // A note on the LOST fixture: it moves the ledger and changes nothing a line
    // reads. (Not the WON one: its snapshot is the raw partial config, and the
    // write path's own fold of that would re-derive the fixture's status.)
    const [before] = await sql<{ n: number; last_seq: number }[]>`
      select (select count(*)::int from score_events where fixture_id = m.fixture_id) as n, m.last_seq
      from match_states m where m.fixture_id = ${scene.lost.fixtureId}`;
    await appendEvent(scene.orgId, scene.lost.fixtureId, before!.n, {
      type: "core.note",
      payload: { text: "bad light stopped play for ten minutes" },
      recordedBy: null,
    });
    const [after] = await sql<{ status: string; last_seq: number }[]>`
      select f.status, m.last_seq from fixtures f join match_states m on m.fixture_id = f.id
      where f.id = ${scene.lost.fixtureId}`;
    expect(after).toEqual({ status: "decided", last_seq: before!.last_seq + 1 });
    const line = (await linesFor(scene.persons.h1)).find((l) => l.fixtureId === scene.lost.fixtureId)!;
    expect([foldsOf(scene.won.fixtureId), foldsOf(scene.lost.fixtureId)]).toEqual([1, 2]);
    expect(line).toMatchObject({ line: expectedCricketLine(scene.lost.card, scene.persons.h1), result: "lost" });
  });

  it("the org's zone stands in for a division that set none", async () => {
    const [{ tz }] = await sql<{ tz: string | null }[]>`
      select (select ss.tz from schedule_settings ss where ss.division_id = ${scene.singlesDivisionId}) as tz`;
    expect(tz).toBeNull();
    const line = (await linesFor(scene.persons.h1)).find((l) => l.fixtureId === scene.genericFixtureId)!;
    expect(line.tz).toBe("Europe/Madrid");
  });

  it("SCORE LINE: an AWAY winner reads their own score first — never the home-first headline", async () => {
    // Premise: Foxes are home, Eagles won away, and the stored headline is home-first.
    const [premise] = await sql<{ home: string; headline: string }[]>`
      select e.display_name as home, m.summary->>'headline' as headline
      from fixtures f join entrants e on e.id = f.home_entrant_id join match_states m on m.fixture_id = f.id
      where f.id = ${scene.eaglesFoxesFixtureId}`;
    expect(premise).toEqual({ home: "Foxes", headline: "0 — 2" });
    const ivy = (await linesFor(scene.persons.ivy)).find((l) => l.fixtureId === scene.eaglesFoxesFixtureId)!;
    expect(ivy).toMatchObject({ line: "2 — 0", result: "won", opponentName: "Foxes" });
    const jon = (await linesFor(scene.persons.jon)).find((l) => l.fixtureId === scene.eaglesFoxesFixtureId)!;
    expect(jon).toMatchObject({ line: "0 — 2", result: "lost", opponentName: "Eagles" });
  });

  it("DEGRADE: a stored state the engine cannot render from the away side costs THAT line its score — the read and every other line survive, and it is logged", async () => {
    // Positive pair first: Ivy (Eagles, AWAY at Foxes) has this line and one more.
    const before = await linesFor(scene.persons.ivy);
    expect(before.find((l) => l.fixtureId === scene.eaglesFoxesFixtureId)?.line).toBe("2 — 0");
    expect(before.length).toBeGreaterThanOrEqual(2);
    const [saved] = await sql<{ state: string }[]>`
      select state::text as state from match_states where fixture_id = ${scene.eaglesFoxesFixtureId}`;
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined as never);
    try {
      await sql`update match_states set state = '{}'::jsonb where fixture_id = ${scene.eaglesFoxesFixtureId}`;
      const after = await linesFor(scene.persons.ivy);
      expect(after).toEqual(
        before.map((l) => (l.fixtureId === scene.eaglesFoxesFixtureId ? { ...l, line: "—" } : l)),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ fixtureId: scene.eaglesFoxesFixtureId }),
        expect.stringContaining("could not render this fixture's score from the away side"),
      );
      // The HOME side never reads the state, so Jon's line is untouched.
      const jon = (await linesFor(scene.persons.jon)).find((l) => l.fixtureId === scene.eaglesFoxesFixtureId)!;
      expect(jon.line).toBe("0 — 2");
    } finally {
      warn.mockRestore();
      // As TEXT: a parameter Postgres infers as jsonb is JSON-encoded again, storing a string.
      await sql`update match_states set state = (${saved!.state}::text)::jsonb where fixture_id = ${scene.eaglesFoxesFixtureId}`;
    }
    expect((await linesFor(scene.persons.ivy)).find((l) => l.fixtureId === scene.eaglesFoxesFixtureId)?.line).toBe("2 — 0");
  });

  it("CONSENT: the opponent's name is the masked entrant name — an opted-out individual never shows in full", async () => {
    const line = (await linesFor(scene.persons.h1)).find((l) => l.fixtureId === scene.genericFixtureId)!;
    expect(line.opponentName).not.toBe("Chandra Bose");
    expect(line.opponentName).toBe("Chandra B.");
  });

  it("VISIBILITY: a played fixture in an ARCHIVED division of the same competition is not listed", async () => {
    // Positive pair: the fixture is real, decided, and Hari is a side of it.
    const [row] = await sql<{ status: string; archived: boolean; mine: boolean }[]>`
      select f.status, d.archived_at is not null as archived,
             exists (select 1 from entrant_members em
                     where em.person_id = ${scene.persons.h1}
                       and em.entrant_id in (f.home_entrant_id, f.away_entrant_id)) as mine
      from fixtures f join divisions d on d.id = f.division_id
      where f.id = ${scene.archivedFixtureId}`;
    expect(row).toEqual({ status: "decided", archived: true, mine: true });
    const lines = await linesFor(scene.persons.h1);
    expect(lines.map((l) => l.fixtureId)).not.toContain(scene.archivedFixtureId);
  });

  it("VISIBILITY: a private competition yields nothing, even for a fixture in play", async () => {
    const [row] = await sql<{ status: string }[]>`select status from fixtures where id = ${scene.privateFixtureId}`;
    expect(row!.status).toBe("in_play");
    expect(await linesFor(scene.persons.h1, { competitionId: scene.privateCompetitionId })).toEqual([]);
  });

  it("CACHE: a fixture the engine REFUSES is folded once — the refusal is cached as no figures", async () => {
    // Rovers v Comets: its snapshot fails the config schema. Comets v Dingoes:
    // the scorecard fold refuses its substitution. Neither changes until its
    // ledger or snapshot does, so neither should be re-folded on every read.
    for (let read = 0; read < 2; read += 1) {
      expect((await linesFor(scene.persons.r1))[0]).toMatchObject({ fixtureId: scene.unfoldableFixtureId, line: "—" });
      await linesFor(scene.persons.bea);
    }
    expect([foldsOf(scene.unfoldableFixtureId), foldsOf(scene.bench.fixtureId)]).toEqual([1, 1]);
  });

  it("CACHE: a DATABASE error is not cached — the next read tries the fold again", async () => {
    foldSpy.poison.add(scene.unfoldableFixtureId);
    await linesFor(scene.persons.r1);
    await linesFor(scene.persons.r1);
    expect(foldsOf(scene.unfoldableFixtureId)).toBe(2);
  });

  it("CACHE: a config RE-SNAPSHOT (no new event) re-folds that fixture", async () => {
    // The WON fixture: re-snapshotting it also retires the raw partial snapshot
    // the parse test above planted, which a standings recompute cannot read.
    await linesFor(scene.persons.h1);
    expect([foldsOf(scene.won.fixtureId), foldsOf(scene.lost.fixtureId)]).toEqual([1, 1]);
    const [{ id: staffId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, is_staff, staff_role)
      values (${`staff-${randomUUID().slice(0, 8)}@example.test`}, 'Staff', true, 'superadmin') returning id`;
    const snapshotOf = async () =>
      (
        await sql<{ at: string; last_seq: number; status: string }[]>`
          select f.config_snapshot_at::text as at, m.last_seq, f.status
          from fixtures f join match_states m on m.fixture_id = f.id where f.id = ${scene.won.fixtureId}`
      )[0]!;
    const before = await snapshotOf();
    await resnapshotFixtureConfig(staffId, scene.won.fixtureId, "organiser corrected the over length");
    const after = await snapshotOf();
    // Premise: the snapshot moved and the ledger did not.
    expect(after.at).not.toBe(before.at);
    expect({ last_seq: after.last_seq, status: after.status }).toEqual({ last_seq: before.last_seq, status: "decided" });
    const line = (await linesFor(scene.persons.h1)).find((l) => l.fixtureId === scene.won.fixtureId)!;
    expect([foldsOf(scene.won.fixtureId), foldsOf(scene.lost.fixtureId)]).toEqual([2, 1]);
    expect(line.line).toBe(expectedCricketLine(scene.won.card, scene.persons.h1));
  });

  it("MERGE: a survivor keeps the figures the ledger recorded under the person merged into them", async () => {
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name) values (${`merge-${randomUUID().slice(0, 8)}@example.test`}, 'Merger')
      returning id`;
    const auth: AuthCtx = { orgId: scene.orgId, via: "session", userId, role: "owner", keyId: null };
    const survivor = await seedPerson(scene.orgId, "Cy Survivor", { public_name: true });
    const expected = expectedCricketLine(scene.lost.card, scene.persons.c1);
    expect(expected).not.toBe("—"); // C1 bowled in the LOST fixture
    await mergePersons(auth, survivor, scene.persons.c1, { confirmedBy: userId });
    // Premise: the ledger still names the absorbed id, and the sheet now names the survivor.
    const [premise] = await sql<{ merged_into: string; ledger_mentions: number; survivor_rows: number }[]>`
      select p.merged_into,
             (select count(*)::int from score_events s
               where s.fixture_id = ${scene.lost.fixtureId} and s.payload::text like ${"%" + scene.persons.c1 + "%"}) as ledger_mentions,
             (select count(*)::int from lineups l
               where l.fixture_id = ${scene.lost.fixtureId} and l.person_id = ${survivor}) as survivor_rows
      from persons p where p.id = ${scene.persons.c1}`;
    expect(premise!.merged_into).toBe(survivor);
    expect(premise!.ledger_mentions).toBeGreaterThan(0);
    expect(premise!.survivor_rows).toBe(1);
    // A COLD read (the cache is empty): the fixture is folded after the merge,
    // under a sheet that now names the survivor.
    const line = (await linesFor(survivor)).find((l) => l.fixtureId === scene.lost.fixtureId);
    expect(foldsOf(scene.lost.fixtureId)).toBe(1);
    expect(line?.line).toBe(expected);
    // And a teammate in the same fixture is not collateral: Hari's line still folds.
    const hari = (await linesFor(scene.persons.h1)).find((l) => l.fixtureId === scene.lost.fixtureId);
    expect(hari?.line).toBe(expectedCricketLine(scene.lost.card, scene.persons.h1));
  });

  it("SCORE LINE (live badminton, through the write path): home reads the stored headline; AWAY reads their own games first — and the next rally moves it", async () => {
    const fixtureId = scene.badmintonFixtureId;
    const lineOf = async (personId: string) => (await linesFor(personId)).find((l) => l.fixtureId === fixtureId)?.line;
    // The engine's own answer for each side: the stored ledger folded as
    // recorded, and folded again with the two lineups swapped — the away
    // entrant at home, whose headline is the line that entrant should read.
    const headlines = async () => {
      const inputs = (await sql.begin((tx) => loadFoldInputs(tx, fixtureId)))!;
      const cfg = inputs.module.configSchema.parse(inputs.cfg);
      const headlineOf = (lineups: LineupPair): string =>
        (inputs.module.summary(foldMatch(inputs.module, cfg, lineups, inputs.envelopes)) as ScoreSummary).headline;
      return { home: headlineOf(inputs.lineups), away: headlineOf({ home: inputs.lineups.away, away: inputs.lineups.home }) };
    };
    const before = await headlines();
    const [stored] = await sql<{ status: string; headline: string }[]>`
      select f.status, m.summary->>'headline' as headline
      from fixtures f join match_states m on m.fixture_id = f.id where f.id = ${fixtureId}`;
    expect(stored).toEqual({ status: "in_play", headline: before.home });
    expect(before).toEqual({ home: "1 — 0 · 21–15 (2–3)", away: "0 — 1 · 15–21 (3–2)" });
    expect(await lineOf(scene.persons.bo)).toBe(before.home);
    expect(await lineOf(scene.persons.al)).toBe(before.away);

    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;
    await appendEvent(scene.orgId, fixtureId, n, {
      type: "badminton.rally",
      payload: { wonBy: scene.alEntrantId },
      recordedBy: null,
    });
    const after = await headlines();
    expect(after.away).not.toBe(before.away);
    expect(await lineOf(scene.persons.al)).toBe(after.away);
    expect(await lineOf(scene.persons.bo)).toBe(after.home);
  });

  /** Sid merged into Sol, once — both merge tests need it, in either order. */
  async function mergeSidIntoSol(): Promise<void> {
    const [row] = await sql<{ merged_into: string | null }[]>`select merged_into from persons where id = ${scene.persons.sid}`;
    if (row!.merged_into !== null) return;
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name) values (${`merge-${randomUUID().slice(0, 8)}@example.test`}, 'Merger')
      returning id`;
    const auth: AuthCtx = { orgId: scene.orgId, via: "session", userId, role: "owner", keyId: null };
    await mergePersons(auth, scene.persons.sol, scene.persons.sid, { confirmedBy: userId });
  }

  it("MERGE: a ledger naming BOTH the survivor and the person merged into them folds — their figures summed, the other side's untouched", async () => {
    const { fixtureId, card } = scene.mergeXI;
    const { sol, sid, t1 } = scene.persons;
    // Premise: both opened and both faced balls, so the ledger names both ids.
    expect(expectedCricketLine(card, sol)).not.toBe("—");
    expect(expectedCricketLine(card, sid)).not.toBe("—");
    await mergeSidIntoSol();
    const [premise] = await sql<{ sol_rows: number; sid_rows: number; sol_mentions: number; sid_mentions: number }[]>`
      select (select count(*)::int from lineups where fixture_id = ${fixtureId} and person_id = ${sol}) as sol_rows,
             (select count(*)::int from lineups where fixture_id = ${fixtureId} and person_id = ${sid}) as sid_rows,
             (select count(*)::int from score_events where fixture_id = ${fixtureId}
                and payload::text like ${"%" + sol + "%"}) as sol_mentions,
             (select count(*)::int from score_events where fixture_id = ${fixtureId}
                and payload::text like ${"%" + sid + "%"}) as sid_mentions`;
    expect(premise).toMatchObject({ sol_rows: 1, sid_rows: 0 });
    expect(premise!.sol_mentions).toBeGreaterThan(0);
    expect(premise!.sid_mentions).toBeGreaterThan(0);

    const solLine = (await linesFor(sol)).find((l) => l.fixtureId === fixtureId);
    expect(solLine?.line).toBe(expectedSummedCricketLine(card, [sol, sid]));
    expect(solLine?.line).not.toBe(expectedCricketLine(card, sol));
    const tiger = (await linesFor(t1)).find((l) => l.fixtureId === fixtureId);
    expect(tiger?.line).toBe(expectedCricketLine(card, t1));
    expect(foldsOf(fixtureId)).toBe(1);
  });

  it("MERGE: a refusal is cached while every merged id the ledger names has a seat — and NOT while one has none", async () => {
    const { fixtureId } = scene.mergeXI;
    await mergeSidIntoSol();
    const tigerLine = async () => (await linesFor(scene.persons.t1)).find((l) => l.fixtureId === fixtureId)?.line;
    // The fixture's OWN refusal first: its frozen config replaced with one the
    // schema refuses. Sid sits beside Sol, so this verdict is the fixture's —
    // cached like any other, for as long as the key holds.
    const [{ snapshot }] = await sql<{ snapshot: unknown }[]>`select config_snapshot as snapshot from fixtures where id = ${fixtureId}`;
    await sql`update fixtures set config_snapshot = ${sql.json({ ballsPerOver: "six" })} where id = ${fixtureId}`;
    try {
      expect(await tigerLine()).toBe("—");
      expect(await tigerLine()).toBe("—");
      expect(foldsOf(fixtureId)).toBe(1);
    } finally {
      await sql`update fixtures set config_snapshot = ${sql.json(snapshot as never)} where id = ${fixtureId}`;
    }
    // Then Sol's row comes off Stags' sheet: the ledger still names Sid (merged
    // into Sol) and Sol, and neither has a slot to fold under. That refusal is
    // this reader's gap, not the fixture's, so every read tries again.
    nextCache.store.clear();
    foldSpy.calls.length = 0;
    await sql`delete from lineups where fixture_id = ${fixtureId} and person_id = ${scene.persons.sol}`;
    expect(await tigerLine()).toBe("—");
    expect(await tigerLine()).toBe("—");
    expect(foldsOf(fixtureId)).toBe(2);
  });

  it("GATE: publicPlayerGate refuses exactly when getPublicPlayer does — and folds nothing", async () => {
    const other = await sql<{ id: string }[]>`
      insert into organizations (name, slug) values ('Other', ${"other-" + randomUUID().slice(0, 8)}) returning id`;
    const foreigner = await seedPerson(other[0]!.id, "Fay Foreign", { public_name: true });
    const cases: { name: string; comp: string; person: string; refused: boolean }[] = [
      { name: "a player who consented", comp: scene.compSlug, person: scene.persons.h1, refused: false },
      { name: "a malformed id", comp: scene.compSlug, person: "not-a-uuid", refused: true },
      { name: "nobody", comp: scene.compSlug, person: randomUUID(), refused: true },
      { name: "a player who opted out", comp: scene.compSlug, person: scene.persons.chandra, refused: true },
      { name: "another org's person", comp: scene.compSlug, person: foreigner, refused: true },
      { name: "an unknown competition", comp: "no-such-cup", person: scene.persons.h1, refused: true },
      { name: "a private competition", comp: scene.privateCompSlug, person: scene.persons.h1, refused: true },
    ];
    const verdicts = async () => {
      const out: Record<string, { gate: boolean; page: boolean }> = {};
      for (const c of cases) {
        const gate = await publicPlayerGate(scene.orgSlug, c.comp, c.person);
        const page = await getPublicPlayer(scene.orgSlug, c.comp, c.person);
        out[c.name] = { gate: gate === null, page: page === null };
      }
      return out;
    };
    expect(await verdicts()).toEqual(Object.fromEntries(cases.map((c) => [c.name, { gate: c.refused, page: c.refused }])));
    const open = await publicPlayerGate(scene.orgSlug, scene.compSlug, scene.persons.h1);
    expect(open).toMatchObject({
      org: { id: scene.orgId, slug: scene.orgSlug },
      competition: { id: scene.competitionId, slug: scene.compSlug },
      player: { id: scene.persons.h1, name: "Hari Nair" },
    });
    // The entitlement, the one refusal a live org can acquire: both go dark together.
    try {
      await sql`
        insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
        values (${scene.orgId}, 'dashboard.player_profiles', false, 'test')
        on conflict (org_id, feature_key) do update set bool_value = false`;
      await invalidateOrgEntitlements(scene.orgId);
      expect(await publicPlayerGate(scene.orgSlug, scene.compSlug, scene.persons.h1)).toBeNull();
      expect(await getPublicPlayer(scene.orgSlug, scene.compSlug, scene.persons.h1)).toBeNull();
    } finally {
      await sql`delete from org_entitlement_overrides where org_id = ${scene.orgId} and feature_key = 'dashboard.player_profiles'`;
      await invalidateOrgEntitlements(scene.orgId);
    }
    foldSpy.calls.length = 0;
    await publicPlayerGate(scene.orgSlug, scene.compSlug, scene.persons.h1);
    expect(foldSpy.calls).toEqual([]);
  });

  it("getPublicPlayer's generatedAt is the time of its CACHED read — a render inside the entry repeats it", async () => {
    nextCache.storedPrefixes.add("pub-player-v");
    const before = Date.now();
    const first = await getPublicPlayer(scene.orgSlug, scene.compSlug, scene.persons.h1);
    const after = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 15));
    const second = await getPublicPlayer(scene.orgSlug, scene.compSlug, scene.persons.h1);
    expect(first!.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(first!.generatedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(first!.generatedAt)).toBeLessThanOrEqual(after);
    expect(second!.generatedAt).toBe(first!.generatedAt);
  });

  it("getPublicPlayer folds OUTSIDE its own cached read, so its figures cache is really read", async () => {
    // Next skips the cache read of an `unstable_cache` nested in another's
    // callback (the double above models it). A second page render with nothing
    // new recorded must therefore fold nothing again.
    await getPublicPlayer(scene.orgSlug, scene.compSlug, scene.persons.h1);
    await getPublicPlayer(scene.orgSlug, scene.compSlug, scene.persons.h1);
    expect([foldsOf(scene.won.fixtureId), foldsOf(scene.lost.fixtureId)]).toEqual([1, 1]);
  });

  it("getPublicPlayer carries these lines as `matches` — on BOTH of its return paths", async () => {
    const expected = await linesFor(scene.persons.h1);
    expect(expected).toHaveLength(3);

    // Path 1: no sport spans two divisions' snapshots → the early return.
    const early = await getPublicPlayer(scene.orgSlug, scene.compSlug, scene.persons.h1);
    expect(early).not.toBeNull();
    expect(early!.career).toEqual([]);
    expect(early!.matches).toEqual(expected);

    // Path 2: generic snapshots in two public divisions → the career rollup
    // return. Last in this file: nothing above reads snapshots.
    for (const divisionId of [scene.singlesDivisionId, scene.extraDivisionId]) {
      await sql`
        insert into player_stat_snapshots (division_id, person_id, sport_key, stats, computed_through_seq)
        values (${divisionId}, ${scene.persons.h1}, 'generic', ${sql.json({ points: 3 })}, 1)`;
    }
    const full = await getPublicPlayer(scene.orgSlug, scene.compSlug, scene.persons.h1);
    expect(full!.career.length).toBeGreaterThan(0);
    expect(full!.matches).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// Pure half — no database
// ---------------------------------------------------------------------------

describe("playerMatchResult — every outcome kind", () => {
  it("EMPTY: no outcome on a settled fixture → null, never a guessed verdict", () => {
    expect(playerMatchResult("decided", null, "e1")).toBeNull();
  });
  it("in play → live", () => {
    expect(playerMatchResult("in_play", null, "e1")).toBe("live");
  });
  it("a win for the person's entrant → won; for the other side → lost", () => {
    expect(playerMatchResult("decided", { kind: "win", winner: "e1", loser: "e2" }, "e1")).toBe("won");
    expect(playerMatchResult("decided", { kind: "win", winner: "e2", loser: "e1" }, "e1")).toBe("lost");
  });
  it("an award (forfeit/walkover) carries a winner too", () => {
    expect(playerMatchResult("finalized", { kind: "award", winner: "e1" }, "e1")).toBe("won");
    expect(playerMatchResult("finalized", { kind: "award", winner: "e2" }, "e1")).toBe("lost");
  });
  it("a draw and a tie read drawn", () => {
    expect(playerMatchResult("decided", { kind: "draw" }, "e1")).toBe("drawn");
    expect(playerMatchResult("finalized", { kind: "tie" }, "e1")).toBe("drawn");
  });
  it("no_result is not a draw → null", () => {
    expect(playerMatchResult("decided", { kind: "no_result" }, "e1")).toBeNull();
  });
});

const DECIDED_SCRIPT: Script = {
  cfg: { ballsPerInnings: 6, ballsPerOver: 6, playersPerSide: 8, minOversForResult: 1 },
  home: HOME,
  away: AWAY,
  tossWonBy: "home",
  elected: "bat",
  innings: [
    { batting: "home", bowlers: ["a7"], deliveries: bats(4, 4, 4, 4, 4, 4) },
    {
      batting: "away",
      bowlers: ["h1"],
      deliveries: [{ bat: 1 }, { out: "caught", fielder: "h2", bat: 0 }, ...bats(0, 0, 0, 0)],
    },
  ],
};

const TWO_INNINGS_SCRIPT: Script = {
  cfg: { inningsPerSide: 2, ballsPerInnings: 6, ballsPerOver: 6, playersPerSide: 8, minOversForResult: 1 },
  home: HOME,
  away: AWAY,
  tossWonBy: "home",
  elected: "bat",
  innings: [
    { batting: "home", bowlers: ["a7"], deliveries: bats(4, 0, 0, 0, 0, 0) },
    { batting: "away", bowlers: ["h1"], deliveries: bats(1, 0, 0, 0, 0, 0) },
    { batting: "home", bowlers: ["a7"], deliveries: bats(6, 0, 0, 0, 0, 0) },
    { batting: "away", bowlers: ["h1"], deliveries: bats(2, 0, 0, 0, 0, 0) },
  ],
};

function cardOf(script: Script): CricketScorecard {
  const ledger = scriptLedger(script);
  return deriveCricketScorecard({ events: ledger.events, cfg: ledger.cfg, lineups: ledger.lineups });
}

describe("benchRowIsAppearance — the one bench policy (owner ruling 2026-09-16)", () => {
  const figures = { batting: null, bowling: { wickets: 1, runs: 9 } };
  it("cricket: a bench player with figures played; one without sat it out", () => {
    expect(benchRowIsAppearance("cricket", figures)).toBe(true);
    expect(benchRowIsAppearance("cricket", undefined)).toBe(false);
  });
  it("any other sport: a bench row is never an appearance, whatever it carries", () => {
    expect(benchRowIsAppearance("football", figures)).toBe(false);
    expect(benchRowIsAppearance("generic", undefined)).toBe(false);
  });
});

describe("composePlayerMatchLines — seeds to lines, with the figures loader injected", () => {
  const seed = (over: Partial<PlayerMatchSeed>): PlayerMatchSeed => ({
    fixtureId: "f",
    href: "/h",
    divisionName: "D",
    divisionSlug: "d",
    scheduledAt: null,
    tz: "UTC",
    opponentName: "O",
    result: "won",
    sportKey: "cricket",
    status: "decided",
    lastSeq: 7,
    slot: "starting",
    scoreLine: null,
    snapshotAt: null,
    ...over,
  });

  it("EMPTY: no seeds → no lines, and nothing is folded", async () => {
    const dict = await getDictionary("en", "public");
    const figuresOf = vi.fn();
    expect(await composePlayerMatchLines([], ["p"], dict, figuresOf)).toEqual([]);
    expect(figuresOf).not.toHaveBeenCalled();
  });

  it("a cricket BENCH row with figures is listed with them; one without, and any other sport's bench row, are not", async () => {
    const dict = await getDictionary("en", "public");
    const byFixture: Record<string, FixtureFigures | null> = {
      played: { p: { batting: null, bowling: { wickets: 2, runs: 14 } } },
      satOut: { someoneElse: { batting: { runs: 4, balls: 3 }, bowling: null } },
    };
    const figuresOf = vi.fn(async (s: PlayerMatchSeed) => byFixture[s.fixtureId] ?? null);
    const lines = await composePlayerMatchLines(
      [
        seed({ fixtureId: "played", slot: "bench" }),
        seed({ fixtureId: "satOut", slot: "bench" }),
        seed({ fixtureId: "footy", slot: "bench", sportKey: "football", scoreLine: "2 — 1" }),
        seed({ fixtureId: "unfoldable", slot: "bench" }),
      ],
      ["p"],
      dict,
      figuresOf,
    );
    expect(lines).toEqual([
      {
        fixtureId: "played",
        href: "/h",
        divisionName: "D",
        divisionSlug: "d",
        scheduledAt: null,
        tz: "UTC",
        opponentName: "O",
        result: "won",
        line: "2/14",
      },
    ]);
    // Figures are asked for cricket only.
    expect(figuresOf.mock.calls.map(([s]) => s.fixtureId)).toEqual(["played", "satOut", "unfoldable"]);
  });

  it("figures recorded under every id of one person (a merge) are SUMMED into their line", async () => {
    const dict = await getDictionary("en", "public");
    const lines = await composePlayerMatchLines([seed({ fixtureId: "merged" })], ["survivor", "absorbed"], dict, async () => ({
      survivor: { batting: { runs: 3, balls: 4 }, bowling: null },
      absorbed: { batting: { runs: 10, balls: 6 }, bowling: { wickets: 1, runs: 8 } },
      someoneElse: { batting: { runs: 99, balls: 60 }, bowling: null },
    }));
    expect(lines.map((l) => l.line)).toEqual(["13 (10) & 1/8"]);
  });

  it("starting rows and roster stand-ins are listed whatever the figures say", async () => {
    const dict = await getDictionary("en", "public");
    const lines = await composePlayerMatchLines(
      [
        seed({ fixtureId: "noFigures", slot: "starting" }),
        seed({ fixtureId: "roster", slot: null, sportKey: "generic", scoreLine: "3 — 0" }),
        seed({ fixtureId: "rosterNoHeadline", slot: null, sportKey: "generic", scoreLine: null }),
      ],
      ["p"],
      dict,
      async () => null,
    );
    expect(lines.map((l) => [l.fixtureId, l.line])).toEqual([
      ["noFigures", "—"],
      ["roster", "3 — 0"],
      ["rosterNoHeadline", "—"],
    ]);
  });
});

describe("cricketLineFor — the line composer over real engine folds", () => {
  it("EMPTY: a person in neither the batting nor the bowling of any innings reads '—'", async () => {
    const dict = await getDictionary("en", "public");
    expect(cricketLineFor(cardOf(DECIDED_SCRIPT), "h8", dict)).toBe("—");
  });

  it("batted and bowled → '{runs} ({balls}) & {wickets}/{runs}'", async () => {
    const dict = await getDictionary("en", "public");
    expect(cricketLineFor(cardOf(DECIDED_SCRIPT), "h1", dict)).toBe("24 (6) & 1/1");
  });

  it("batted only → the batting half alone", async () => {
    const dict = await getDictionary("en", "public");
    expect(cricketLineFor(cardOf(DECIDED_SCRIPT), "a1", dict)).toBe("1 (1)");
  });

  it("bowled only → the bowling half alone", async () => {
    const dict = await getDictionary("en", "public");
    expect(cricketLineFor(cardOf(DECIDED_SCRIPT), "a7", dict)).toBe("0/24");
  });

  it("two innings each: the match figures are the SUM of the person's lines, not the first one", async () => {
    // h1 opens both home innings (4 off 6, then 6 off 6) and bowls both away
    // innings (1 conceded, then 2). A composer that stopped at the first line
    // it found would read "4 (6) & 0/1".
    const dict = await getDictionary("en", "public");
    const card = cardOf(TWO_INNINGS_SCRIPT);
    expect(card.innings.filter((i) => !i.isSuperOver)).toHaveLength(4);
    expect(cricketLineFor(card, "h1", dict)).toBe("10 (12) & 0/3");
  });

  it("a super over is not part of the match figures — batting and bowling both exclude it", async () => {
    // Regulation: h1 faces one ball for 1; h7 concedes 2. In the super over h1
    // faces three more singles and h7 concedes 7 — so a composer that counted
    // the super over would read "4 (4)" and "0/9".
    const dict = await getDictionary("en", "public");
    const card = cardOf(SUPER_OVER_SCRIPT);
    expect(card.innings.some((i) => i.isSuperOver)).toBe(true);
    expect(cricketLineFor(card, "h1", dict)).toBe("1 (1)");
    expect(cricketLineFor(card, "h7", dict)).toBe("0/2");
  });
});

// ---------------------------------------------------------------------------
// scoreLineFor over REAL module summaries. The oracle is the engine: the same
// ledger folded with the two lineups swapped puts the away entrant at home, and
// that fold's headline is exactly what the away entrant should read. A ledger
// with POSITIONAL payloads (`{home, away}` set summaries, generic's
// `{p1Score, p2Score}`) is the one place the swap alone would re-attribute the
// score, so its oracle ledger has those payloads turned too — by hand, per case.
// ---------------------------------------------------------------------------

type Stored = { summary: ScoreSummary; state: unknown };

/** What `match_states` hands the reader: the summary, and the state as jsonb
 *  gives it back (a JSON round trip). */
function storedOf(module: AnySportModule, state: unknown): Stored {
  return { summary: module.summary(state), state: JSON.parse(JSON.stringify(state)) };
}

function swapped(pair: LineupPair): LineupPair {
  return { home: pair.away, away: pair.home };
}

/** Both sides' lines, and the oracle's, for one ledger. */
function linesBothWays(
  module: AnySportModule,
  events: ModuleEvent[],
  opts: { cfg?: unknown; oracleEvents?: ModuleEvent[] } = {},
) {
  const cfg = module.configSchema.parse(opts.cfg ?? {});
  const pair = defaultLineupPair(resolvePositions(module, cfg));
  const envelopes = (list: ModuleEvent[]) => list.map((event, i) => makeEnvelope(i, event));
  const state = foldMatch(module, cfg, pair, envelopes(events));
  const stored = storedOf(module, state);
  const oracle = module.summary(foldMatch(module, cfg, swapped(pair), envelopes(opts.oracleEvents ?? events))) as ScoreSummary;
  return {
    decided: module.outcome(state) !== null,
    headline: stored.summary.headline,
    home: scoreLineFor(stored, pair.home.entrantId, pair.home.entrantId, module),
    away: scoreLineFor(stored, pair.away.entrantId, pair.home.entrantId, module),
    oracle: oracle.headline,
  };
}

const H = "H";
const A = "A";
const start: ModuleEvent = { type: "core.start", payload: {} };
const repeat = (n: number, event: ModuleEvent): ModuleEvent[] => Array.from({ length: n }, () => event);

describe("scoreLineFor — the named shapes: home reads the headline, AWAY reads the engine's headline for its own side", () => {
  // Each case pins its SHAPE with a literal premise on the home headline, so a
  // ledger that quietly stopped producing (say) a tiebreak cannot pass vacuously.
  const point = (by: string): ModuleEvent => ({ type: "tennis.point", payload: { by } });
  const game = (by: string) => repeat(4, point(by));
  const games = (...winners: string[]) => winners.flatMap(game);
  // Set 1: 6–4 home. Set 2: 6–6, then away takes the tiebreak 7–5.
  const tennisTwoSets = [
    start,
    ...games(H, A, H, A, H, A, H, A, H, H),
    ...games(H, A, H, A, H, A, H, A, H, A, H, A),
    ...[H, A, H, A, H, A, H, A, H, A, A, A].map(point),
  ];
  const rally = (sport: string, wonBy: string): ModuleEvent => ({ type: `${sport}.rally`, payload: { wonBy } });
  // Game 1: 21–15 home. Game 2: 19–21 away.
  const badmintonTwoGames = [
    start,
    ...repeat(15, rally("badminton", A)),
    ...repeat(21, rally("badminton", H)),
    ...repeat(19, rally("badminton", H)),
    ...repeat(21, rally("badminton", A)),
  ];
  const ice = {
    goal: (by: string): ModuleEvent => ({ type: "icehockey.goal", payload: { by } }),
    advance: (to: string): ModuleEvent => ({ type: "icehockey.period.advance", payload: { to } }),
    attempt: (by: string, scored: boolean): ModuleEvent => ({ type: "icehockey.shootout.attempt", payload: { by, scored } }),
  };
  const board = (winner: string, opponentCoinsLeft: number, queenTo: string | null): ModuleEvent => ({
    type: "carrom.board.summary",
    payload: { winner, opponentCoinsLeft, queenTo },
  });
  const kick = (by: string, scored: boolean): ModuleEvent => ({ type: "football.shootout.kick", payload: { by, scored } });
  const goal = (by: string): ModuleEvent => ({ type: "football.goal", payload: { by } });
  const phase = (to: string): ModuleEvent => ({ type: "football.period", payload: { phase: to } });

  const cases: {
    name: string;
    module: AnySportModule;
    events: ModuleEvent[];
    cfg?: unknown;
    oracleEvents?: ModuleEvent[];
    headline: string | RegExp;
    decided: boolean;
  }[] = [
    {
      name: "tennis in play: a tiebreak set, and an open game at 30–15",
      module: tennis,
      events: [...tennisTwoSets, ...games(H, A, H), ...[H, H, A].map(point)],
      headline: "1 — 1 · 6–4 6–7(5) · 2–1 (30–15)",
      decided: false,
    },
    {
      name: "tennis in play: advantage to the AWAY side",
      module: tennis,
      events: [...tennisTwoSets, ...games(H), ...[H, A, H, A, H, A, A].map(point)],
      headline: "1 — 1 · 6–4 6–7(5) · 1–0 (40–Ad)",
      decided: false,
    },
    {
      name: "tennis finished, the tiebreak set carried",
      module: tennis,
      events: [...tennisTwoSets, ...games(H, A, H, A, H, H, H, H)],
      headline: "2 — 1 · 6–4 6–7(5) 6–2",
      decided: true,
    },
    {
      name: "tennis in play: a match tiebreak for the deciding set",
      module: tennis,
      cfg: tennis.variants["doubles-noad-mtb10"],
      events: [
        start,
        ...games(H, A, H, A, H, A, H, A, H, H),
        ...games(A, H, A, H, A, H, A, H, A, A),
        ...[H, A, A, H, A].map(point),
      ],
      headline: /^1 — 1 · 6–4 4–6 · MTB 2–3$/,
      decided: false,
    },
    {
      name: "tennis finished on a match tiebreak",
      module: tennis,
      cfg: tennis.variants["doubles-noad-mtb10"],
      events: [
        start,
        ...games(H, A, H, A, H, A, H, A, H, H),
        ...games(A, H, A, H, A, H, A, H, A, A),
        ...[...repeat(8, point(H)), ...repeat(10, point(A))],
      ],
      headline: "1 — 2 · 6–4 4–6 [8–10]",
      decided: true,
    },
    {
      name: "badminton in play: TWO closed games and an open one",
      module: badminton,
      events: [...badmintonTwoGames, ...repeat(5, rally("badminton", H)), ...repeat(3, rally("badminton", A))],
      headline: "1 — 1 · 21–15, 19–21 (5–3)",
      decided: false,
    },
    {
      name: "badminton finished",
      module: badminton,
      events: [...badmintonTwoGames, ...repeat(10, rally("badminton", A)), ...repeat(21, rally("badminton", H))],
      headline: "2 — 1 · 21–15, 19–21, 21–10",
      decided: true,
    },
    {
      name: "badminton from POSITIONAL game summaries",
      module: badminton,
      events: [
        start,
        { type: "badminton.game.summary", payload: { home: 21, away: 15 } },
        { type: "badminton.game.summary", payload: { home: 19, away: 21 } },
      ],
      oracleEvents: [
        start,
        { type: "badminton.game.summary", payload: { home: 15, away: 21 } },
        { type: "badminton.game.summary", payload: { home: 21, away: 19 } },
      ],
      headline: "1 — 1 · 21–15, 19–21",
      decided: false,
    },
    {
      name: "carrom in play: the board score rides the per-side lines, not the headline",
      module: carrom,
      events: [start, board(H, 3, null), board(A, 5, null)],
      headline: "0 — 0",
      decided: false,
    },
    {
      name: "carrom finished",
      module: carrom,
      events: [start, ...repeat(3, board(A, 9, A)), ...repeat(3, board(H, 9, H)), ...repeat(3, board(A, 9, A))],
      headline: /^1 — 2$/,
      decided: true,
    },
    {
      name: "ice hockey in play: the period",
      module: icehockey,
      events: [start, ice.goal(H), ice.advance("P2")],
      headline: "1 — 0 · P2",
      decided: false,
    },
    {
      name: "ice hockey: an AWAY overtime winner",
      module: icehockey,
      events: [start, ice.goal(H), ice.goal(A), ice.advance("P2"), ice.advance("P3"), ice.advance("FT"), ice.goal(A)],
      headline: "1 — 2 (OT)",
      decided: true,
    },
    {
      name: "ice hockey: a shoot-out won AWAY",
      module: icehockey,
      events: [
        start,
        ...["P2", "P3", "FT", "FT"].map(ice.advance),
        ...[H, A, H, A, H, A].map((by) => ice.attempt(by, by === A)),
      ],
      headline: "0 — 1 (GWS 0–3)",
      decided: true,
    },
    {
      name: "football in play",
      module: football,
      events: [start, goal(A), phase("HT"), goal(A), goal(H)],
      headline: /^1 — 2/,
      decided: false,
    },
    {
      name: "football: a knockout decided on penalties",
      module: football,
      cfg: { extraTime: { enabled: true, halfMinutes: 15 }, shootout: true },
      events: [
        start,
        goal(H),
        goal(A),
        ...["HT", "FT", "ET_HT", "ET_FT"].map(phase),
        ...[H, A, H, A, H, A, H, A].map((by) => kick(by, true)),
        kick(H, true),
        kick(A, false),
      ],
      headline: "1 — 1 (5–4 pens)",
      decided: true,
    },
    {
      name: "board game in play: no per-side score yet",
      module: boardgame,
      events: [start],
      headline: "vs",
      decided: false,
    },
    {
      name: "board game won AWAY",
      module: boardgame,
      events: [start, { type: "boardgame.result", payload: { winner: A, method: "resign" } }],
      headline: "0 — 1",
      decided: true,
    },
    {
      name: "generic in play: a running tally",
      module: generic,
      cfg: GENERIC_CONFIG,
      events: [start, { type: "generic.score", payload: { by: A, points: 2 } }, { type: "generic.score", payload: { by: H, points: 1 } }],
      headline: "1 — 2",
      decided: false,
    },
    {
      name: "generic from a POSITIONAL result",
      module: generic,
      cfg: GENERIC_CONFIG,
      events: [start, { type: "generic.result", payload: { p1Score: 0, p2Score: 2 } }],
      oracleEvents: [start, { type: "generic.result", payload: { p1Score: 2, p2Score: 0 } }],
      headline: "0 — 2",
      decided: true,
    },
  ];

  it.each(cases)("$name", ({ module, events, cfg, oracleEvents, headline, decided }) => {
    const lines = linesBothWays(module, events, { cfg, oracleEvents });
    if (typeof headline === "string") expect(lines.headline).toBe(headline);
    else expect(lines.headline).toMatch(headline);
    expect(lines.decided).toBe(decided);
    expect(lines.home).toBe(lines.headline);
    expect(lines.away).toBe(lines.oracle);
  });

  it("the away line MOVES with the next point of an open tennis game", () => {
    const before = linesBothWays(tennis, [...tennisTwoSets, ...games(H, A, H), ...[H, H, A].map(point)]);
    const after = linesBothWays(tennis, [...tennisTwoSets, ...games(H, A, H), ...[H, H, A, A].map(point)]);
    expect(after.away).toBe(after.oracle);
    expect(after.away).not.toBe(before.away);
  });
});

describe("scoreLineFor — every registered sport, over its recorded golden ledgers", () => {
  // Class 7: not one lucky sample. Every module the engine ships, every golden
  // stream it recorded, at an in-play prefix and at the full ledger.
  const sportsDir = new URL("../../../../../../packages/engine/src/sports/", import.meta.url);
  const corpora = (readdirSync(sportsDir, { recursive: true }) as string[])
    .filter((file) => file.endsWith(".golden.json"))
    .map((file) => JSON.parse(readFileSync(new URL(file, sportsDir), "utf8")) as GoldenCorpus);
  interface GoldenCorpus {
    key: string;
    configs: Record<string, unknown>;
    streams: { config: string; events: ModuleEvent[]; lineups?: LineupPair }[];
  }
  // The payloads that name a side by POSITION, listed by type. The swapped fold
  // is only the oracle once these are turned, so each is turned here by hand;
  // a positional payload of any OTHER type fails the sweep instead of passing
  // under a wrong oracle.
  const TURN_POSITIONAL: Record<string, (payload: Record<string, unknown>) => Record<string, unknown>> = {
    "badminton.game.summary": ({ home, away, ...rest }) => ({ ...rest, home: away, away: home }),
    "tabletennis.game.summary": ({ home, away, ...rest }) => ({ ...rest, home: away, away: home }),
    "volleyball.set.summary": ({ home, away, ...rest }) => ({ ...rest, home: away, away: home }),
    "tennis.set_summary": ({ home, away, tb, ...rest }) => ({
      ...rest,
      home: away,
      away: home,
      ...(tb === undefined ? {} : { tb: { home: (tb as { away: number }).away, away: (tb as { home: number }).home } }),
    }),
    "generic.result": ({ p1Score, p2Score, ...rest }) =>
      p1Score === undefined ? rest : { ...rest, p1Score: p2Score, p2Score: p1Score },
  };
  const isPositional = (event: ModuleEvent) => {
    const payload = event.payload;
    return typeof payload === "object" && payload !== null && ["home", "away", "p1Score"].some((key) => key in payload);
  };
  // And the one IMPLICIT positional fact: with no toss recorded, cricket's home
  // side bats first. The oracle's ledger records the toss that says so for the
  // entrant who was home, or the swap would send the other side in first.
  const oracleLedgerOf = (module: AnySportModule, events: ModuleEvent[], pair: LineupPair) => {
    const noToss = module.key === "cricket" && !events.some((event) => event.type === "cricket.toss");
    const toss: ModuleEvent = { type: "cricket.toss", payload: { wonBy: pair.home.entrantId, elected: "bat" } };
    return { events: [...(noToss ? [toss] : []), ...events.map(turned)], offset: noToss ? 1 : 0 };
  };
  const turned = (event: ModuleEvent): ModuleEvent => {
    if (!isPositional(event)) return event;
    const turn = TURN_POSITIONAL[event.type];
    if (turn === undefined) throw new Error(`no hand turn for the positional payload of "${event.type}"`);
    return { ...event, payload: turn(event.payload as Record<string, unknown>) };
  };

  it("every shipped module has a golden corpus", () => {
    expect(builtinModules.map((module) => module.key).sort()).toEqual(corpora.map((corpus) => corpus.key).sort());
  });

  it.each(builtinModules.map((module) => [module.key, module] as const))("%s", (_key, module) => {
    const corpus = corpora.find((c) => c.key === module.key)!;
    const mismatches: string[] = [];
    let inPlay = 0;
    let decided = 0;
    for (const [streamNo, stream] of corpus.streams.entries()) {
      const cfg = module.configSchema.parse(corpus.configs[stream.config]);
      const pair = stream.lineups ?? defaultLineupPair(resolvePositions(module, cfg));
      const envelopes = stream.events.map((event, i) => makeEnvelope(i, event));
      const oracleLedger = oracleLedgerOf(module, stream.events, pair);
      const oracleEnvelopes = oracleLedger.events.map((event, i) => makeEnvelope(i, event));
      for (const length of new Set([Math.ceil(envelopes.length / 2), envelopes.length])) {
        const ledger = envelopes.slice(0, length);
        let state: unknown;
        let oracle: string;
        try {
          state = foldMatch(module, cfg, pair, ledger);
        } catch {
          continue; // a prefix the engine refuses has no line to compare
        }
        try {
          oracle = (module.summary(foldMatch(module, cfg, swapped(pair), oracleEnvelopes.slice(0, length + oracleLedger.offset))) as ScoreSummary)
            .headline;
        } catch (err) {
          mismatches.push(`stream ${streamNo} @${length}: the oracle fold refused — ${String(err)}`);
          continue;
        }
        const stored = storedOf(module, state);
        const away = scoreLineFor(stored, pair.away.entrantId, pair.home.entrantId, module);
        const home = scoreLineFor(stored, pair.home.entrantId, pair.home.entrantId, module);
        if (away !== oracle || home !== stored.summary.headline) {
          mismatches.push(`stream ${streamNo} @${length}: home ${home} | away ${away} | oracle ${oracle}`);
        }
        if (module.outcome(state) === null) inPlay += 1;
        else decided += 1;
      }
    }
    expect(mismatches).toEqual([]);
    expect(inPlay).toBeGreaterThan(0);
    expect(decided).toBeGreaterThan(0);
  });
});
