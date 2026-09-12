// A spectator-surface SHOWCASE: one competition per sport whose public pages
// are rich enough to look at.
//
// ── WHY THIS EXISTS, AND WHY `seed:demo` IS NOT ENOUGH ─────────────────────
// `seed:demo` plays cricket with `cricket.innings.summary` events — over-by-over
// TOTALS. That gives a score and nothing else: no batter, no bowler, no fall of
// wickets, no partnerships, no over sequence. Every one of those is a block the
// match centre draws, so on demo data they are all correctly empty and the page
// cannot be judged. Measured before this script existed: the richest public
// cricket fixture in a freshly seeded database carried TWO score events.
//
// The other two sports are the same story with different nouns. Demo FOOTBALL
// is `football.goal` carrying `by` and a `minute` — no scorer, no assist, no
// card, no substitution, no half-time mark, and the minutes arrive out of order
// (78, 67, 80, 14 on the richest fixture in a fresh database). Demo TENNIS is
// `tennis.set_summary`, which is per-set totals: no point ever happened, so
// aces, double faults and points won are all correctly zero.
//
// It also gives entrants no `team_id`, so no entrant has a club, so no entrant
// has a colour — which is why `EntityLogo`'s painted-tile arm went two waves
// mutation-proven and never once rendered.
//
// Reviewing a design against data like that reports missing DATA as missing
// DESIGN, which is the failure this programme keeps paying for.
//
// ── EVERYTHING GOES THROUGH THE REAL WRITE PATHS ───────────────────────────
// `POST /api/v1/fixtures/:id/events` with `expected_seq` is the same route the
// scoring pad uses, so the ledger is one the engine actually accepts and every
// derived block is genuine. Inserting rows into `score_events` directly would
// produce a ledger nothing validated, and a page built from it would prove
// nothing about the product.
//
// Colours reach an entrant the way a real organiser's do: a CLUB carries
// `colors.home_primary`, a TEAM belongs to the club, and an entrant is enrolled
// as that team. There is no shortcut — `CreateTeam` takes no colours.
//
// TENNIS IS DELIBERATELY NOT GIVEN ONE. Its entrants are individuals, who have
// no club and therefore no colour at all — so its court card exercises the
// DERIVED name-hash tile (`autoColour`, `entity-logo.tsx`) rather than a painted
// one. Both arms of that chain are then reachable from seeded data.
//
// Usage:
//   npm run seed:showcase -- --base http://localhost:3319            # all three
//   npm run seed:showcase -- --base http://localhost:3319 --sport tennis
//
// Idempotent enough to re-run: the competition, clubs and teams are reused when
// they already exist, and the ledger is written to a fixture whose ledger is
// EMPTY — which is settled by attempting the write, not by reading an audit
// endpoint and guessing its envelope shape.
import { readFileSync } from "node:fs";

/** `seed:demo --phase=setup` mints its accounts with a RANDOM suffix and records
 *  the one it chose in this file. So the operator account cannot be hardcoded
 *  here: a literal copied out of one seeded database is wrong in every other
 *  one. Read what the demo seed actually wrote, and say so plainly when there
 *  is nothing to read.
 *
 *  This script only ever LOGS IN, so no address is minted and no mail path is
 *  involved — but `scripts/__tests__/test-email-domain.test.ts` scans source for
 *  minted addresses, and a hardcoded one here trips it for good reason. */
const DEMO_STATE = new URL("./.seed-demo-state.json", import.meta.url).pathname;

const demoAccount = (account: "pro" | "community"): string | null => {
  try {
    const state = JSON.parse(readFileSync(DEMO_STATE, "utf8")) as Record<
      string,
      { email?: string } | undefined
    >;
    return state[account]?.email ?? null;
  } catch {
    return null;
  }
};

const args = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const BASE = arg("base", process.env.SEED_BASE ?? "http://localhost:3000");
const EMAIL = arg("email", process.env.SEED_EMAIL ?? demoAccount("pro") ?? "");
if (!EMAIL) {
  console.error(
    `No operator account. Pass --email, set SEED_EMAIL, or run \`npm run seed:demo\`\n` +
      `first — it records the account it created in ${DEMO_STATE}.`,
  );
  process.exit(1);
}
const PASSWORD = process.env.SEED_PASSWORD ?? "smokepass123";
const ONLY = arg("sport", "all");

/** Only the fields this script reads. The API returns a great deal more; naming
 *  what is used keeps the reads honest — and `scripts/` is linted in CI
 *  (`ci.yml`'s `eslint (scripts/)` step), where an `any` is an error rather
 *  than a shortcut. */
interface Envelope {
  ok?: boolean;
  data?: unknown;
  error?: unknown;
}
interface Named {
  id: string;
  name?: string;
  slug?: string;
  club_id?: string;
}
interface Fixture {
  id: string;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
}
interface Stage {
  id: string;
  seq: number;
  status: string;
}
interface SeqResult {
  seq: number;
}
interface StateResult {
  status?: string;
  last_seq?: number;
  summary?: { headline?: string };
}

/** Both list shapes this API uses — a bare array, or `{ items }`. */
type Listed<T> = T[] | { items?: T[] };

const jar = new Map<string, string>();
const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(jar.size ? { cookie: cookieHeader() } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const [pair] = sc.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
  }
  const json = (await res.json().catch(() => ({}))) as Envelope;
  if (!res.ok || json.ok === false) {
    throw new Error(
      `${method} ${path} → ${res.status} ${JSON.stringify(json.error ?? json).slice(0, 300)}`,
    );
  }
  return (json.data ?? json) as T;
}

function list<T>(res: Listed<T>): T[] {
  return Array.isArray(res) ? res : (res.items ?? []);
}

/** Twelve clubs, each with a distinct hue, so two rows are told apart by colour
 *  before their names are read. Cricket enrols the first EIGHT (`t20-super8`
 *  splits eight into four groups of two); football enrols all twelve, because
 *  `euro24` has SIX groups and eight entrants would make four of them
 *  one-entrant groups — two fixtures, a competition too thin to look at. */
const CLUBS: { name: string; short: string; colour: string }[] = [
  { name: "Southend Blue Blazers", short: "SBB", colour: "#2563eb" },
  { name: "Southend Queens", short: "SQ", colour: "#d6336c" },
  { name: "Hadleigh Hawks", short: "HH", colour: "#2f855a" },
  { name: "Benfleet Town", short: "BT", colour: "#c05621" },
  { name: "Rochford Ramblers", short: "RR", colour: "#6b46c1" },
  { name: "Leigh Lions", short: "LL", colour: "#b7791f" },
  { name: "Canvey Crusaders", short: "CC", colour: "#0f766e" },
  { name: "Thorpe Bay Tigers", short: "TBT", colour: "#9b2c2c" },
  { name: "Shoebury Swifts", short: "SS", colour: "#1e40af" },
  { name: "Westcliff Wanderers", short: "WW", colour: "#a21caf" },
  { name: "Prittlewell Park", short: "PP", colour: "#0e7490" },
  { name: "Rayleigh Rovers", short: "RVR", colour: "#166534" },
];

const BATTERS = [
  "Arjun Mehta", "Priya Nair", "Chris Adebayo", "Danny Okafor",
  "Eshan Pillai", "Farhan Qureshi", "George Whitfield",
];
const FIELDERS = [
  "Yasmin Haddad", "Zara Okonkwo", "Vicky Thompson", "Wren Castellano",
  "Tanvi Deshmukh", "Uma Rajagopal", "Sofia Marchetti",
];

/** Outcome per ball: `.` a dot, `W` a wicket, a digit the runs off the bat. */
const INNINGS_1 = "410412W1114.20W41.26101W0114204";
const INNINGS_2 = "1141.4W11021.4W1141";

// ── the shared spine ───────────────────────────────────────────────────────
// Every sport needs the same steps in the same order and only the ledger
// differs, so what varies is NAMED in `Showcase` rather than branched inline.

interface Ctx {
  fixture: Fixture;
  /** Appends to the fixture's ledger, carrying `expected_seq` forward. */
  post: (type: string, payload: unknown) => Promise<void>;
  /** Creates persons, sets the entrant's roster AND the fixture lineup, and
   *  returns the person ids in the order given. Names past `starters` are
   *  benched — a substitution that brings on someone already in the starting
   *  lineup is refused ("<name> is already on the field"). */
  squad: (entrantId: string, names: string[], starters?: number) => Promise<string[]>;
}

interface Showcase {
  sport: string;
  competition: string;
  templateKey: string;
  /** Team entrants are enrolled from `CLUBS` and carry a club colour;
   *  individuals are persons, and have no colour by construction. */
  entrantKind: "team" | "individual";
  /** How many entrants to enrol. A template's own `entrantCount` is a MAXIMUM
   *  rather than a requirement — settled by enrolling fewer and watching the
   *  stage generate, not by reading the schema. */
  entrantCount: number;
  /** Individual sports name their entrants; team sports take `CLUBS`. */
  individuals?: string[];
  play: (ctx: Ctx) => Promise<void>;
}

async function ensureClubsAndTeams(): Promise<Map<string, string>> {
  const clubs = list(await call<Listed<Named>>("/api/v1/clubs?limit=200"));
  const teams = list(await call<Listed<Named>>("/api/v1/teams?limit=200"));
  const teamIdByName = new Map<string, string>();

  for (const c of CLUBS) {
    const club =
      clubs.find((x) => x.name === c.name) ??
      (await call<Named>("/api/v1/clubs", "POST", {
        name: c.name,
        short_name: c.short,
        // `home_primary` is the key the public surface reads (`primaryColour`,
        // competition-hub.ts). `.primary` is a key nothing writes — the
        // match-centre loader says so in as many words.
        colors: { home_primary: c.colour },
      }));
    // `/clubs/:id/teams` is POST-only; the LIST lives on `/teams`, so an
    // existing team is found there and a new one created under the club.
    const team =
      teams.find((t) => t.club_id === club.id || t.name === c.name) ??
      (await call<Named>(`/api/v1/clubs/${club.id}/teams`, "POST", {
        name: c.name,
        short_name: c.short,
      }));
    teamIdByName.set(c.name, team.id);
  }
  return teamIdByName;
}

async function run(show: Showcase): Promise<void> {
  console.log(`\n── ${show.sport} ──────────────────────────────────────────`);

  const teamIdByName =
    show.entrantKind === "team" ? await ensureClubsAndTeams() : new Map<string, string>();
  if (teamIdByName.size > 0) console.log(`clubs + teams: ${teamIdByName.size}`);

  const comps = list(await call<Listed<Named>>("/api/v1/competitions?limit=100"));
  let competitionId = comps.find((c) => c.name === show.competition)?.id;
  if (competitionId === undefined) {
    const created = await call<{ competitionId: string }>(
      "/api/v1/competitions/from-template",
      "POST",
      { template_key: show.templateKey, name: show.competition, ends_on: "2030-12-31" },
    );
    competitionId = created.competitionId;
  }

  const division = list(
    await call<Listed<Named>>(`/api/v1/competitions/${competitionId}/divisions`),
  )[0];
  if (!division) throw new Error("the template competition has no division");

  let entrants = list(await call<Listed<Named>>(`/api/v1/divisions/${division.id}/entrants`));
  if (entrants.length === 0) {
    if (show.entrantKind === "team") {
      // Entrants enrolled AS THEIR TEAM — `team_id` is what gives them a club,
      // and a club is what gives them a colour.
      await call<unknown>(
        `/api/v1/divisions/${division.id}/entrants`,
        "POST",
        CLUBS.slice(0, show.entrantCount).map((c, i) => ({
          kind: "team",
          display_name: c.name,
          team_id: teamIdByName.get(c.name),
          seed: i + 1,
        })),
      );
    } else {
      const rows: { kind: string; display_name: string; person_id: string; seed: number }[] = [];
      for (const full_name of (show.individuals ?? []).slice(0, show.entrantCount)) {
        const person = await call<Named>("/api/v1/persons", "POST", { full_name, consent: {} });
        rows.push({
          kind: "individual",
          display_name: full_name,
          person_id: person.id,
          seed: rows.length + 1,
        });
      }
      await call<unknown>(`/api/v1/divisions/${division.id}/entrants`, "POST", rows);
    }
    entrants = list(await call<Listed<Named>>(`/api/v1/divisions/${division.id}/entrants`));
  }
  console.log(`division ${division.name ?? division.id}: ${entrants.length} entrants`);

  const stage = list(await call<Listed<Stage>>(`/api/v1/divisions/${division.id}/stages`)).sort(
    (a, b) => a.seq - b.seq,
  )[0];
  if (!stage) throw new Error("the division has no stages");
  if (stage.status === "pending") {
    await call<unknown>(`/api/v1/stages/${stage.id}/generate`, "POST");
    await call<unknown>(`/api/v1/divisions/${division.id}/start`, "POST");
  }

  const fixtures = list(
    await call<Listed<Fixture>>(`/api/v1/divisions/${division.id}/fixtures`),
  ).filter((f) => f.status === "scheduled" && f.home_entrant_id && f.away_entrant_id);

  // An empty ledger is `last_seq === 0` on the fixture's own state — a READ,
  // deliberately, because the obvious alternative does not work for every sport.
  // Claiming a fixture by writing its first event is fine for cricket, whose
  // first event is the toss; for football and tennis the first event is
  // `core.start`, which moves the fixture to in_play and LOCKS ITS LINEUP, so
  // the squads the ledger then needs can no longer be set ("lineup is locked
  // once a fixture is in_play"). The race is still closed by the write itself:
  // the first `post` carries `expected_seq: 0` and conflicts if anyone got
  // there first.
  let fixture: Fixture | undefined;
  for (const candidate of fixtures) {
    const st = await call<StateResult>(`/api/v1/fixtures/${candidate.id}/state`);
    if ((st.last_seq ?? 0) === 0) {
      fixture = candidate;
      break;
    }
  }
  if (!fixture) throw new Error("every fixture already carries a ledger — nothing to seed");
  const fx = fixture;
  let seq = 0;

  const post = async (type: string, payload: unknown) => {
    const r = await call<SeqResult>(`/api/v1/fixtures/${fx.id}/events`, "POST", {
      expected_seq: seq,
      type,
      payload,
    });
    seq = r.seq;
  };

  const squad = async (
    entrantId: string,
    names: string[],
    starters = names.length,
  ): Promise<string[]> => {
    const members: { person_id: string; is_captain: boolean; roles: string[] }[] = [];
    for (const full_name of names) {
      const person = await call<Named>("/api/v1/persons", "POST", { full_name, consent: {} });
      members.push({ person_id: person.id, is_captain: members.length === 0, roles: [] });
    }
    await call<unknown>(`/api/v1/entrants/${entrantId}`, "PATCH", { members });
    const ids = members.map((m) => m.person_id);
    await call<unknown>(`/api/v1/fixtures/${fx.id}/lineups/${entrantId}`, "PUT", {
      slots: ids.map((person_id, i) => ({
        person_id,
        slot: i < starters ? "starting" : "bench",
        order_no: i + 1,
        roles: [],
      })),
    });
    return ids;
  };

  await show.play({ fixture: fx, post, squad });

  const state = await call<StateResult>(`/api/v1/fixtures/${fx.id}/state`);
  const org = list(await call<Listed<Named>>("/api/orgs"))[0];
  // `from-template` returns an id, not a slug, so the public URL needs the
  // competition read back — printing a placeholder is not a link.
  const full = await call<Named>(`/api/v1/competitions/${competitionId}`);
  console.log(`${state.summary?.headline ?? "(no headline)"}`);
  console.log(
    `  ${BASE}/shared/${org?.slug ?? "<org>"}/${full.slug ?? "<competition>"}` +
      `/${division.slug ?? "<division>"}/fixtures/${fx.id}`,
  );
}

// ── cricket ────────────────────────────────────────────────────────────────

const CRICKET: Showcase = {
  sport: "cricket",
  competition: arg("name", "Southend Premier League 2026"),
  templateKey: "t20-super8",
  entrantKind: "team",
  entrantCount: 8,
  async play({ fixture, post, squad }) {
    // The toss precedes `core.start`; a ball in phase "pre" is refused.
    await post("cricket.toss", { wonBy: fixture.home_entrant_id, elected: "bat" });

    // A squad per side, and a fixture LINEUP for each: `CricketBall` is a strict
    // object requiring striker, nonStriker and bowler as person ids, and the
    // engine derives the batting ORDER from the lineup — a ball against a side
    // with no lineup is refused ("batting order for X needs at least 2 players").
    const first = await squad(fixture.home_entrant_id!, BATTERS);
    const second = await squad(fixture.away_entrant_id!, FIELDERS);

    await post("core.start", {});

    /** One innings, ball by ball. The crease is modelled here because the engine
     *  validates it — odd runs cross the batters, the end of an over crosses
     *  them, and A WICKET DOES NOT EXEMPT AN OVER FROM ENDING (a wicket on the
     *  sixth ball still swaps). Getting that last one wrong is what produces
     *  "striker/non-striker do not match the ledger" several overs later. */
    const playInnings = async (script: string, batting: string[], bowling: string[]) => {
      let strikerIx = 0;
      let nonStrikerIx = 1;
      let nextIn = 2;
      const cross = () => {
        [strikerIx, nonStrikerIx] = [nonStrikerIx, strikerIx];
      };

      for (let i = 0; i < script.length; i++) {
        const over = Math.floor(i / 6);
        const ballInOver = (i % 6) + 1;
        const tok = script[i];
        const bowler = bowling[over % bowling.length];

        if (tok === "W" && nextIn < batting.length) {
          await post("cricket.ball", {
            over,
            ballInOver,
            striker: batting[strikerIx],
            nonStriker: batting[nonStrikerIx],
            bowler,
            runs: { bat: 0 },
            // `out` is REQUIRED — the batter dismissed.
            wicket: { kind: "bowled", bowlerCredited: true, out: batting[strikerIx] },
          });
          strikerIx = nextIn++;
          if (ballInOver === 6) cross();
          continue;
        }

        const runs = tok === "." ? 0 : Number(tok);
        await post("cricket.ball", {
          over,
          ballInOver,
          striker: batting[strikerIx],
          nonStriker: batting[nonStrikerIx],
          bowler,
          runs: { bat: runs },
        });
        if (runs % 2 === 1) cross();
        if (ballInOver === 6) cross();
      }
    };

    await playInnings(INNINGS_1, first, second);
    await post("cricket.innings.close", {});
    await playInnings(INNINGS_2, second, first);
  },
};

// ── football ───────────────────────────────────────────────────────────────
// The match the design board draws: 2–1, LIVE in the second half, with a goal
// carrying an assist, a penalty, a booking, a substitution and a half-time mark.
// Each of those is a row the Timeline tab renders and a column the Periods tab
// totals, and not one of them exists anywhere in demo data.

const HOME_XI = [
  "George Whitfield", "Danny Okafor", "Marcus Reilly", "Ade Balogun",
  "Callum Reid", "Dmitri Volkov", "Ethan Hargreaves", "Femi Adeyemi",
  "Gus Lindqvist", "Hamza Chaudhry", "Isaac Brennan", "Jonah Petersen",
];
/** Twelve names, and the TWELFTH is the substitute — `squad(..., 11)` benches
 *  whoever is past the eleventh, and the board's substitution brings Pearson
 *  ON, so Pearson has to be the one on the bench. */
const AWAY_XI = [
  "Sofia Marchetti", "Tom Fairweather", "Ravi Siddiqui", "Nate Kowalski",
  "Omar Farouk", "Pablo Serrano", "Quentin Dubois", "Rory MacLeod",
  "Stefan Novak", "Theo Anderssen", "Ulrich Mayer", "Lewis Pearson",
];

const FOOTBALL: Showcase = {
  sport: "football",
  competition: "Southend Sunday League 2026",
  templateKey: "euro24",
  entrantKind: "team",
  entrantCount: 12,
  async play({ fixture, post, squad }) {
    // Lineups FIRST: `core.start` moves the fixture to in_play and the lineup
    // is locked from that moment.
    const home = await squad(fixture.home_entrant_id!, HOME_XI, 11);
    const away = await squad(fixture.away_entrant_id!, AWAY_XI, 11);
    await post("core.start", {});
    const H = fixture.home_entrant_id!;
    const A = fixture.away_entrant_id!;

    // `scorer`/`assist`/`person`/`off`/`on` are PERSON ids; `by` is the ENTRANT.
    // Both matter and neither substitutes for the other: `by` is what the score
    // derives from, and the person is what every rendered row is NAMED after.
    await post("football.goal", { by: H, scorer: home[0], minute: 12 });
    await post("football.sub", { by: A, off: away[2], on: away[11], minute: 29 });
    await post("football.goal", { by: A, scorer: away[0], penalty: true, minute: 38 });
    // Half time is an EVENT, not a derived boundary — without it the Timeline
    // has no "Half time · 1 – 1" rung and the Periods tab has a single column.
    //
    // IT HAS TO BE POSTED IN THE RIGHT PLACE. The Timeline renders LEDGER ORDER,
    // not `minute` order, so posting half time after the 54' booking puts the
    // interval between the 61' goal and the 54' card on the page — a booking
    // that reads as first-half. The minute labels do not rescue it.
    await post("football.period", { phase: "HT", addedMinutes: 2 });
    await post("football.card", { by: A, person: away[1], color: "yellow", minute: 54 });
    await post("football.goal", { by: H, scorer: home[1], assist: home[0], minute: 61 });
    // Left LIVE in the second half, which is the state the board draws.
  },
};

// ── tennis ─────────────────────────────────────────────────────────────────
// Individuals, so no club and no colour: this is the fixture that exercises the
// DERIVED name-hash tile. Played POINT BY POINT because the board's Sets tab
// reads aces, double faults and points won out of the ledger's per-point meta —
// `tennis.set_summary` (what demo data uses) carries none of that, so a Sets tab
// built on it is correctly, uselessly empty.

const TENNIS_DRAW = ["Priya Nair", "Sofia Marchetti", "Zara Okonkwo", "Tanvi Deshmukh"];

/** Games as they finish, `H`/`A` for who took each, in order. Two completed sets
 *  and a third in progress — the board's 6–4, 3–6, 2–1.
 *
 *  EACH SET'S LAST GAME MUST BE ITS WINNER'S SIXTH. A set closes the moment one
 *  side reaches six (by two), so a string carrying a seventh win does not make a
 *  7–4 set — the engine closes the set on the sixth and the surplus games become
 *  the START OF THE NEXT ONE. The first version of this list had eleven games in
 *  set two and produced "6–4 4–6 · 2–2": a set that ended early and a third set
 *  polluted with the leftovers. */
const TENNIS_SETS = [
  "HAHAHAHAHH", // set 1 to home, 6–4
  "AHAHAHAAA", // set 2 to away, 3–6
  "HAH", // set 3 in progress, 2–1
];

const TENNIS: Showcase = {
  sport: "tennis",
  competition: "Southend Open 2026",
  templateKey: "slam128",
  entrantKind: "individual",
  // `slam128` declares 128; FOUR entrants generate two semi-finals and a final,
  // which is the board's "Semi-final · Court 2" exactly.
  entrantCount: 4,
  individuals: TENNIS_DRAW,
  async play({ fixture, post }) {
    const H = fixture.home_entrant_id!;
    const A = fixture.away_entrant_id!;
    await post("core.start", {});

    /** A game as four points to its winner, with the loser taking two FIRST so
     *  the score passes through 30–40 instead of jumping to game point. The
     *  point totals on the Sets tab are a count of these, so a 4–0 every game
     *  would make both totals a multiple of four and leave the tab nothing to
     *  tell apart. `meta.kind` is the enum the engine declares
     *  (`ace | double_fault | ue | winner`), and SERVING IS DERIVED by the
     *  engine from the game count, so no `server` is sent. */
    let played = 0;
    const KINDS = ["ace", "winner", "ue", "double_fault"] as const;
    const playGame = async (winner: string, loser: string) => {
      await post("tennis.point", { by: loser, meta: { kind: KINDS[played % 4] } });
      await post("tennis.point", { by: loser });
      for (let i = 0; i < 4; i++) {
        const payload =
          i === 0 ? { by: winner, meta: { kind: KINDS[(played + 1) % 4] } } : { by: winner };
        await post("tennis.point", payload);
      }
      played++;
    };

    for (const set of TENNIS_SETS) {
      for (const game of set) {
        if (game === "H") await playGame(H, A);
        else await playGame(A, H);
      }
    }
  },
};

const ALL: Showcase[] = [CRICKET, FOOTBALL, TENNIS];

async function main() {
  await call<unknown>("/api/auth/login", "POST", { email: EMAIL, password: PASSWORD });

  const chosen = ONLY === "all" ? ALL : ALL.filter((s) => s.sport === ONLY);
  if (chosen.length === 0) {
    throw new Error(
      `unknown --sport ${ONLY}; expected "all" or one of ${ALL.map((s) => s.sport).join(", ")}`,
    );
  }
  for (const show of chosen) await run(show);
}

main().catch((e: unknown) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
