// A spectator-surface SHOWCASE: one competition whose public pages are rich
// enough to look at.
//
// ── WHY THIS EXISTS, AND WHY `seed:demo` IS NOT ENOUGH ─────────────────────
// `seed:demo` plays cricket with `cricket.innings.summary` events — over-by-over
// TOTALS. That gives a score and nothing else: no batter, no bowler, no fall of
// wickets, no partnerships, no over sequence. Every one of those is a block the
// match centre draws, so on demo data they are all correctly empty and the page
// cannot be judged. Measured before this script existed: the richest public
// cricket fixture in a freshly seeded database carried TWO score events.
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
// Usage:
//   npm run seed:showcase -- --base http://localhost:3319
//
// Idempotent enough to re-run: the competition, clubs and teams are reused when
// they already exist, and the ledger is written to a fixture whose ledger is
// EMPTY — which is settled by attempting the write, not by reading an audit
// endpoint and guessing its envelope shape.
import { readFileSync } from "node:fs";

/** `seed:demo --phase=setup` mints its accounts with a RANDOM suffix
 *  (`delivered+smoke-pro-<1000..9999>@resend.dev`) and records the one it chose
 *  in this file. So the operator account cannot be hardcoded here: a literal
 *  copied out of one seeded database is wrong in every other one. Read what the
 *  demo seed actually wrote, and say so plainly when there is nothing to read.
 *
 *  The domain matters too. Every address this repo MINTS goes to Resend, which
 *  refuses `@example.com` with a 422 — `scripts/__tests__/test-email-domain.test.ts`
 *  is the guard, and it is a repo-root suite the `apps/web` gate does not run. */
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
const COMPETITION = arg("name", "Southend Premier League 2026");

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

/** Eight clubs, each with a distinct hue, so two rows are told apart by colour
 *  before their names are read. */
const CLUBS: { name: string; short: string; colour: string }[] = [
  { name: "Southend Blue Blazers", short: "SBB", colour: "#2563eb" },
  { name: "Southend Queens", short: "SQ", colour: "#d6336c" },
  { name: "Hadleigh Hawks", short: "HH", colour: "#2f855a" },
  { name: "Benfleet Town", short: "BT", colour: "#c05621" },
  { name: "Rochford Ramblers", short: "RR", colour: "#6b46c1" },
  { name: "Leigh Lions", short: "LL", colour: "#b7791f" },
  { name: "Canvey Crusaders", short: "CC", colour: "#0f766e" },
  { name: "Thorpe Bay Tigers", short: "TBT", colour: "#9b2c2c" },
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

async function main() {
  await call<unknown>("/api/auth/login", "POST", { email: EMAIL, password: PASSWORD });

  // ── clubs and teams, so entrants can have colours ────────────────────────
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
  console.log(`clubs + teams: ${teamIdByName.size}`);

  // ── the competition ──────────────────────────────────────────────────────
  const comps = list(await call<Listed<Named>>("/api/v1/competitions?limit=100"));
  let competitionId = comps.find((c) => c.name === COMPETITION)?.id;
  if (competitionId === undefined) {
    const created = await call<{ competitionId: string }>(
      "/api/v1/competitions/from-template",
      "POST",
      { template_key: "t20-super8", name: COMPETITION, ends_on: "2030-12-31" },
    );
    competitionId = created.competitionId;
  }

  const division = list(
    await call<Listed<Named>>(`/api/v1/competitions/${competitionId}/divisions`),
  )[0];
  if (!division) throw new Error("the template competition has no division");

  // Entrants enrolled AS THEIR TEAM — `team_id` is what gives them a club, and
  // a club is what gives them a colour.
  let entrants = list(await call<Listed<Named>>(`/api/v1/divisions/${division.id}/entrants`));
  if (entrants.length === 0) {
    await call<unknown>(
      `/api/v1/divisions/${division.id}/entrants`,
      "POST",
      CLUBS.map((c, i) => ({
        kind: "team",
        display_name: c.name,
        team_id: teamIdByName.get(c.name),
        seed: i + 1,
      })),
    );
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

  // ── the fixture, and its ledger ──────────────────────────────────────────
  const fixtures = list(
    await call<Listed<Fixture>>(`/api/v1/divisions/${division.id}/fixtures`),
  ).filter((f) => f.status === "scheduled" && f.home_entrant_id && f.away_entrant_id);

  // "Has an empty ledger" is settled by the WRITE. `expected_seq: 0` succeeds on
  // an untouched fixture and conflicts otherwise — reading an audit endpoint and
  // guessing its envelope got this wrong once.
  let fixture: Fixture | undefined;
  let seq = 0;
  for (const candidate of fixtures) {
    try {
      const r = await call<SeqResult>(`/api/v1/fixtures/${candidate.id}/events`, "POST", {
        expected_seq: 0,
        type: "cricket.toss",
        payload: { wonBy: candidate.home_entrant_id, elected: "bat" },
      });
      fixture = candidate;
      seq = r.seq;
      break;
    } catch (e) {
      if (/SEQ_CONFLICT/.test(String(e))) continue;
      throw e;
    }
  }
  if (!fixture) throw new Error("every fixture already carries a ledger — nothing to seed");
  const fx = fixture;

  const post = async (type: string, payload: unknown) => {
    const r = await call<SeqResult>(`/api/v1/fixtures/${fx.id}/events`, "POST", {
      expected_seq: seq,
      type,
      payload,
    });
    seq = r.seq;
  };

  // A squad per side, and a fixture LINEUP for each: `CricketBall` is a strict
  // object requiring striker, nonStriker and bowler as person ids, and the
  // engine derives the batting ORDER from the lineup — a ball against a side
  // with no lineup is refused ("batting order for X needs at least 2 players").
  const squad = async (entrantId: string, names: string[]): Promise<string[]> => {
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
        slot: "starting",
        order_no: i + 1,
        roles: [],
      })),
    });
    return ids;
  };

  const first = await squad(fx.home_entrant_id!, BATTERS);
  const second = await squad(fx.away_entrant_id!, FIELDERS);

  // The toss is already on the ledger; `core.start` comes after it, and a ball
  // before it is refused ("ball in phase pre").
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

  const state = await call<StateResult>(`/api/v1/fixtures/${fx.id}/state`);
  const org = list(await call<Listed<Named>>("/api/orgs"))[0];
  // `from-template` returns an id, not a slug, so the public URL needs the
  // competition read back — printing a placeholder is not a link.
  const full = await call<Named>(`/api/v1/competitions/${competitionId}`);
  console.log(`\n${state.summary?.headline ?? "(no headline)"}`);
  console.log(
    `\n  ${BASE}/shared/${org?.slug ?? "<org>"}/${full.slug ?? "<competition>"}` +
      `/${division.slug ?? "<division>"}/fixtures/${fx.id}`,
  );
}

main().catch((e: unknown) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
