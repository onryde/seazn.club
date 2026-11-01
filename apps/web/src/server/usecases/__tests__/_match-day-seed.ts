// Match Day (A1) — the DB rig shared by match-day-call.test.ts and the call route's test.
//
// One org on Europe/Amsterdam, two venues and three courts, eight people, and a doubles round robin of four pairs. Everything a
// test needs to name it by is returned: the courts, the venues each court belongs to, the people and the pairs they make up.
// Fixtures are generated UNPLACED; each test places what it needs with `place`, and states the board it judges.
//
// Times are minutes after T0, a Saturday (weekday 6 in V367's 0 = Sunday) at 10:00 UTC = 11:00 in Amsterdam (UTC+1 in
// November), so a court's declared hours and the UTC instants differ by one hour.
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { putScheduleSettings } from "../schedule";
import { createStages, generateStageFixtures } from "../stages";
import { createCourt, createVenue } from "../venues";
import { seedOrg } from "./_seed";

export const T0 = "2026-11-07T10:00:00.000Z";
export const ORG_TZ = "Europe/Amsterdam";
const MIN = 60_000;
export const at = (m: number): Date => new Date(Date.parse(T0) + m * MIN);
export const iso = (m: number): string => at(m).toISOString();

export interface Person {
  id: string;
  name: string;
}
export interface Pair {
  id: string;
  name: string;
  people: Person[];
}
export interface Fx {
  id: string;
  home: string;
  away: string;
}
export interface Comp {
  id: string;
  name: string;
  divisionId: string;
  stageId: string;
  pairs: Pair[];
  fixtures: Fx[];
}
export interface Day {
  auth: AuthCtx;
  orgId: string;
  courts: { c1: string; c2: string; c3: string };
  courtName: Record<string, string>;
  venues: { hallA: string; hallB: string };
  venueOf: Record<string, string>;
  people: Person[];
  comp: Comp;
}

export async function person(orgId: string, fullName: string): Promise<Person> {
  const [r] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name) values (${orgId}, ${fullName}) returning id`;
  return { id: r!.id, name: fullName };
}

/** A competition with one generic doubles division: one pair per roster, a round robin between them, the given schedule
 *  settings. `matchMinutes` and `minRest` are the division's own (`schedule_settings.config`). With `teams`, a FOOTBALL
 *  division instead, of name-only teams with NO roster (members are optional): one per name, `rosters` ignored. With
 *  `competitionId`, the division is added to that competition instead of a new one (named `division`, default "Doubles"). */
export async function seedCompetition(
  auth: AuthCtx,
  label: string,
  rosters: Person[][],
  opts: {
    courts: string[];
    matchMinutes?: number;
    minRest?: number;
    teams?: string[];
    competitionId?: string;
    division?: string;
  },
): Promise<Comp> {
  const name = `${label} ${randomUUID().slice(0, 6)}`;
  const comp =
    opts.competitionId !== undefined
      ? { id: opts.competitionId }
      : await createCompetition(auth, { ends_on: "2030-12-31", name, visibility: "public", branding: {} });
  const division = await createDivision(
    auth,
    comp.id,
    opts.teams !== undefined
      ? { name: "Teams", sport_key: "football", variant_key: "11-a-side", config: {} }
      : {
          name: opts.division ?? "Doubles",
          sport_key: "generic",
          variant_key: "score",
          config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
        },
  );
  if (opts.teams !== undefined) rosters = opts.teams.map(() => []);
  await createEntrants(
    auth,
    division.id,
    opts.teams !== undefined
      ? opts.teams.map((team, i) => ({ kind: "team" as const, display_name: team, seed: i + 1, members: [] }))
      : rosters.map((people, i) => ({
          kind: "pair" as const,
          display_name: people.map((p) => p.name.split(" ")[0]).join(" & "),
          seed: i + 1,
          members: people.map((p) => ({ person_id: p.id, is_captain: false, roles: [] })),
        })),
  );
  const entrants = await sql<{ id: string; display_name: string; seed: number }[]>`
    select id, display_name, seed from entrants where division_id = ${division.id} order by seed`;
  if (entrants.length !== rosters.length) throw new Error(`seedCompetition: ${entrants.length} entrants for ${rosters.length} rosters`);
  const pairs = entrants.map((e, i) => ({ id: e.id, name: e.display_name, people: rosters[i]! }));
  await putScheduleSettings(auth, division.id, {
    config: {
      startAt: "2026-11-01T00:00:00.000Z",
      matchMinutes: opts.matchMinutes ?? 30,
      gapMinutes: 0,
      courts: opts.courts,
      perEntrantMinRest: opts.minRest ?? 0,
      blackouts: [],
      sessionWindows: [],
    },
  });
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {} });
  await generateStageFixtures(auth, stage!.id);
  const fixtures = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`
    select id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${stage!.id} order by round_no, seq_in_round`;
  const expected = (rosters.length * (rosters.length - 1)) / 2;
  if (fixtures.length !== expected) throw new Error(`seedCompetition: ${fixtures.length} fixtures, expected ${expected}`);
  return {
    id: comp.id,
    name,
    divisionId: division.id,
    stageId: stage!.id,
    pairs,
    fixtures: fixtures.map((f) => ({ id: f.id, home: f.home_entrant_id, away: f.away_entrant_id })),
  };
}

/** The fixture between two pairs, whichever side each was drawn on. */
export function between(comp: Comp, a: Pair, b: Pair): Fx {
  const found = comp.fixtures.find((f) => (f.home === a.id && f.away === b.id) || (f.home === b.id && f.away === a.id));
  if (!found) throw new Error(`no fixture between ${a.name} and ${b.name}`);
  return found;
}

/** "Home v Away", from the pairs' own names — the label a preview names a match by. */
export function labelOf(comp: Comp, f: Fx): string {
  const name = (id: string) => comp.pairs.find((p) => p.id === id)!.name;
  return `${name(f.home)} v ${name(f.away)}`;
}

export async function seedDay(opts: { minRest?: number } = {}): Promise<Day> {
  const { auth } = await seedOrg("pro");
  await sql`update organizations set timezone = ${ORG_TZ} where id = ${auth.orgId}`;
  const hallA = await createVenue(auth, { name: "Hall A", sort: 0 });
  const hallB = await createVenue(auth, { name: "Hall B", sort: 1 });
  const c1 = await createCourt(auth, hallA.id, { name: "Court 1", sort: 0, tags: [] });
  const c2 = await createCourt(auth, hallA.id, { name: "Court 2", sort: 1, tags: [] });
  const c3 = await createCourt(auth, hallB.id, { name: "Court 3", sort: 0, tags: [] });
  const people: Person[] = [];
  for (const n of ["Ann Archer", "Bob Bell", "Cat Cole", "Dan Dorn", "Eve Ellis", "Fay Fox", "Gus Gale", "Hal Hart"]) {
    people.push(await person(auth.orgId, n));
  }
  const rosters = [0, 2, 4, 6].map((i) => [people[i]!, people[i + 1]!]);
  const comp = await seedCompetition(auth, "Match Day Open", rosters, {
    courts: [c1.id, c2.id, c3.id],
    minRest: opts.minRest ?? 0,
  });
  return {
    auth,
    orgId: auth.orgId,
    courts: { c1: c1.id, c2: c2.id, c3: c3.id },
    courtName: { [c1.id]: "Court 1", [c2.id]: "Court 2", [c3.id]: "Court 3" },
    venues: { hallA: hallA.id, hallB: hallB.id },
    venueOf: { [c1.id]: hallA.id, [c2.id]: hallA.id, [c3.id]: hallB.id },
    people,
    comp,
  };
}

/** Put a fixture in a slot by hand (court + its venue + time), bypassing every gate: the board a test judges. `null` minutes
 *  or court leaves that part unset. */
export async function place(day: Day, fixtureId: string, minutes: number | null, court: string | null): Promise<void> {
  await sql`
    update fixtures
       set scheduled_at = ${minutes === null ? null : iso(minutes)},
           court_id = ${court},
           venue_id = ${court === null ? null : day.venueOf[court]!}
     where id = ${fixtureId}`;
}

export async function setStatus(fixtureId: string, status: string): Promise<void> {
  await sql`update fixtures set status = ${status} where id = ${fixtureId}`;
}

export interface Slot {
  court_id: string | null;
  venue_id: string | null;
  scheduled_at: string | null;
  status: string;
}

export async function slotOf(fixtureId: string): Promise<Slot> {
  const [r] = await sql<{ court_id: string | null; venue_id: string | null; scheduled_at: Date | null; status: string }[]>`
    select court_id, venue_id, scheduled_at, status from fixtures where id = ${fixtureId}`;
  if (!r) throw new Error(`slotOf: no fixture ${fixtureId}`);
  return { ...r, scheduled_at: r.scheduled_at === null ? null : r.scheduled_at.toISOString() };
}

export interface CallRow {
  fixture_id: string;
  org_id: string;
  court_id: string;
  called_at: string;
  called_by: string | null;
  prev_court_id: string | null;
  prev_venue_id: string | null;
  prev_scheduled_at: string | null;
}

export async function callRows(fixtureId: string): Promise<CallRow[]> {
  const rows = await sql<(Omit<CallRow, "called_at" | "prev_scheduled_at"> & { called_at: Date; prev_scheduled_at: Date | null })[]>`
    select fixture_id, org_id, court_id, called_at, called_by, prev_court_id, prev_venue_id, prev_scheduled_at
      from fixture_calls where fixture_id = ${fixtureId}`;
  return rows.map((r) => ({
    ...r,
    called_at: r.called_at.toISOString(),
    prev_scheduled_at: r.prev_scheduled_at === null ? null : r.prev_scheduled_at.toISOString(),
  }));
}

export interface ScheduleEdit {
  seq: number;
  from: { at: string | null; court: string | null; venue: string | null; locked: boolean };
  to: { at: string | null; court: string | null; venue: string | null; locked: boolean };
}

/** The division's ledger: its `seq` watermark, and every `schedule_edited` naming the fixture, in order. */
export async function ledgerOf(divisionId: string, fixtureId: string): Promise<{ seq: number; edits: ScheduleEdit[] }> {
  const [d] = await sql<{ seq: string | number }[]>`select seq from divisions where id = ${divisionId}`;
  const rows = await sql<{ seq: number; payload: { from: ScheduleEdit["from"]; to: ScheduleEdit["to"] } }[]>`
    select seq, payload from division_events
     where division_id = ${divisionId} and type = 'schedule_edited' and payload->>'fixture' = ${fixtureId}
     order by seq`;
  return { seq: Number(d!.seq), edits: rows.map((r) => ({ seq: Number(r.seq), from: r.payload.from, to: r.payload.to })) };
}
