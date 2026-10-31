// Match Day A2 — the read model (`getMatchDay`), today's count (`countFixturesToday`) and a free court's candidates
// (`matchDayCandidates`). Spec 2026-10-31-match-day-design.md §6.2, §7 ("Which courts", candidate order), §7.1.
//
// The rules under test, from the spec, not from the code:
//  - the court list is the union of every division's candidate courts and every court holding one of THIS competition's
//    matches that day;
//  - a court's state comes from its matches' STATUS, from any competition (courts are org-level): one of this competition's
//    matches in play → playing; called, with the call still holding → called; another competition's match playing or called →
//    in use elsewhere, by that competition's name; else free. A call row whose match has since started is playing; one whose
//    match has ended (any finished status the database declares) is free (task brief, Review Focus 4);
//  - a court's queue is this competition's unstarted, uncalled matches planned on it today, in planned order, estimated at
//    max(planned, end of the match before) — the match before counting every competition's planned matches on a shared court
//    (§7 "Which courts", §7.1);
//  - needs_you is the competition desk's own Needs-you list; results_owed its `result_missing` count;
//  - "today" is the organisation's day (the governing clock);
//  - candidates (§7): this court's own next match, other courts' next matches (and a called, unstarted match, which "can also be
//    called to a different free court"), ready no-court matches in active stages; never a TBD side; a player busy elsewhere —
//    a doubles partner counts, and for a side with no roster the side itself — blocks, with the person and the court named.
//
// Every expected time is worked by hand from the rule, in minutes after T0 (11:00 in Amsterdam). The sport sweep here is the
// court noun of a football and a chess division (the brief's pair); the call path's own sports are A1's.
//
// Real Postgres required; skipped without DATABASE_URL (CI runs them).
import { afterAll, describe, expect, it } from "vitest";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import uiEn from "@/dictionaries/en/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import { venueNoun } from "@/lib/venue";
import { needsYouItems } from "@/components/v2/desk/needs-you";
import type { MatchDayCandidate, MatchDayCourt, MatchDayView } from "@/lib/match-day/types";
import { rigTarget, sessionOnTarget } from "@/server/relay/__tests__/_session-rig";
import { createCompetition } from "../competitions";
import { getCompetitionDesk } from "../competition-desk";
import { createDivision, listDivisions } from "../divisions";
import { callFixtureToCourt, undoCall } from "../match-day-call";
import { countFixturesToday, getMatchDay, matchDayCandidates } from "../match-day";
import { putScheduleSettings } from "../schedule";
import { createCourt } from "../venues";
import {
  ORG_TZ,
  at,
  between,
  iso,
  person,
  place,
  seedCompetition,
  seedDay,
  setStatus,
  type Comp,
  type Day,
  type Person,
} from "./_match-day-seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

/** The pairs of the day's round robin: P1 = Ann & Bob, P2 = Cat & Dan, P3 = Eve & Fay, P4 = Gus & Hal. */
const pairs = (day: Day) => {
  const [p1, p2, p3, p4] = day.comp.pairs;
  return { p1: p1!, p2: p2!, p3: p3!, p4: p4! };
};

async function addCourt(day: Day, venue: "hallA" | "hallB", name: string, sort: number): Promise<string> {
  const c = await createCourt(day.auth, day.venues[venue], { name, sort, tags: [] });
  day.venueOf[c.id] = day.venues[venue];
  day.courtName[c.id] = name;
  return c.id;
}

/** Started for real: a `core.start` score event at `minute` (the kick-off the read model reads) and the status it puts. */
async function start(day: Day, fixtureId: string, minute: number): Promise<void> {
  await sql`
    insert into score_events (fixture_id, org_id, seq, type, payload, recorded_at)
    values (${fixtureId}, ${day.orgId}, 1, 'core.start', '{}', ${at(minute)})`;
  await setStatus(fixtureId, "in_play");
}

/** Ended in `status`, finishing at `minute`. The status trigger stamps the wall clock; the stamp is then set apart. */
async function finish(fixtureId: string, status: string, minute: number): Promise<void> {
  await setStatus(fixtureId, status);
  await sql`update fixtures set finished_at = ${at(minute)} where id = ${fixtureId}`;
}

/** Another competition of the same org: four pairs of fresh people, the given courts and match length. */
async function otherCompetition(day: Day, label: string, opts: { courts: string[]; matchMinutes?: number }): Promise<Comp> {
  const people: Person[] = [];
  for (const n of ["Ivo Ince", "Jo Judd", "Kai Kerr", "Lia Lowe", "Max Moss", "Nia Nash", "Oli Orr", "Pia Pratt"]) {
    people.push(await person(day.orgId, n));
  }
  return seedCompetition(day.auth, label, [0, 2, 4, 6].map((i) => [people[i]!, people[i + 1]!]), opts);
}

function courtOf(view: MatchDayView, courtId: string): MatchDayCourt {
  const c = view.courts.find((x) => x.court_id === courtId);
  if (!c) throw new Error(`court ${courtId} is not on the board`);
  return c;
}

/** A queue as [fixture id, planned minute, estimated minute]. */
const queueOf = (c: MatchDayCourt): [string, number, number][] =>
  c.queue.map((q) => [q.id, (Date.parse(q.planned_at) - at(0).getTime()) / 60_000, (Date.parse(q.estimated_at) - at(0).getTime()) / 60_000]);

describe.skipIf(!HAS_DB)("getMatchDay", () => {
  it("the court list: every division's candidate courts, and every court holding one of this competition's matches today — not tomorrow's, not another competition's", async () => {
    const day = await seedDay();
    const { p1, p2, p3, p4 } = pairs(day);
    const c4 = await addCourt(day, "hallB", "Court 4", 1);
    const c5 = await addCourt(day, "hallB", "Court 5", 2);
    const f12 = between(day.comp, p1, p2);
    await place(day, f12.id, 120, c4); // this competition, today, on a court its division does not list
    await place(day, between(day.comp, p3, p4).id, 24 * 60 + 60, c5); // this competition, tomorrow
    const other = await otherCompetition(day, "Other Cup", { courts: [c5] });
    await place(day, other.fixtures[0]!.id, 60, c5); // another competition, today

    const view = await getMatchDay(day.auth, day.comp.id, at(0));

    expect(view).toMatchObject({
      competition_id: day.comp.id,
      date: "2026-11-07",
      tz: ORG_TZ,
      now: iso(0),
      fixtures_today: 1,
    });
    // Venue order, then court order: Hall A (sort 0) before Hall B (sort 1).
    expect(view.courts.map((c) => [c.court_id, c.court_name, c.venue_name])).toEqual([
      [day.courts.c1, "Court 1", "Hall A"],
      [day.courts.c2, "Court 2", "Hall A"],
      [day.courts.c3, "Court 3", "Hall B"],
      [c4, "Court 4", "Hall B"],
    ]);
    expect(courtOf(view, c4)).toMatchObject({ state: "free", current: null, in_use_by: null, free_since: null, sport_noun: "court" });
    expect(queueOf(courtOf(view, c4))).toEqual([[f12.id, 120, 120]]);
    // Asked again, the same answer: a read.
    expect(await getMatchDay(day.auth, day.comp.id, at(0))).toEqual(view);
  });

  it("Review Focus 4: a called court's state follows the match's STATUS — called, then playing once started, then free for every finished status the database declares", async () => {
    const day = await seedDay();
    const [check] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'fixtures_status_check'`;
    const domain = [...check!.def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!);
    // One literal per line: the status-set sweep reads a list of status literals as a set it must classify.
    const unstarted = "scheduled";
    const playing = "in_play";
    const finished = domain.filter((s) => s !== unstarted && s !== playing);
    expect(finished).toContain("decided");
    expect(finished).toContain("abandoned");
    expect(finished).toContain("forfeited");
    expect(finished.length).toBeLessThanOrEqual(day.comp.fixtures.length);

    let checked = 0;
    let lastPlayedFinish: number | null = null; // a cancelled match never used the court, so it frees nothing
    for (const [i, status] of finished.entries()) {
      const f = day.comp.fixtures[i]!;
      const t = 10 * i;
      await callFixtureToCourt(day.auth, f.id, day.courts.c1, at(t));
      const called = courtOf(await getMatchDay(day.auth, day.comp.id, at(t + 1)), day.courts.c1);
      expect(called, status).toMatchObject({
        state: "called",
        current: { id: f.id, called_at: iso(t), started_at: null },
        free_since: null, // only a free court says since when
      });
      expect(called.queue, status).toEqual([]);

      if (i === 0) {
        await start(day, f.id, t + 2);
        const playing = courtOf(await getMatchDay(day.auth, day.comp.id, at(t + 3)), day.courts.c1);
        // The call row is still there; the status says playing, and the call no longer holds.
        expect(await sql`select 1 from fixture_calls where fixture_id = ${f.id}`).toHaveLength(1);
        expect(playing).toMatchObject({ state: "playing", current: { id: f.id, started_at: iso(t + 2), called_at: null } });
      }

      await finish(f.id, status, t + 5);
      if (status !== "cancelled") lastPlayedFinish = t + 5;
      const after = courtOf(await getMatchDay(day.auth, day.comp.id, at(t + 6)), day.courts.c1);
      expect(after, status).toMatchObject({
        state: "free",
        current: null,
        free_since: lastPlayedFinish === null ? null : iso(lastPlayedFinish),
      });
      checked++;
    }
    expect(checked).toBe(finished.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("another competition's match playing, or called, makes the court in use elsewhere by its name; this competition's queue there is estimated behind it and behind that competition's planned match", async () => {
    const day = await seedDay();
    const { p1, p2, p3, p4 } = pairs(day);
    const other = await otherCompetition(day, "Other Cup", { courts: [day.courts.c2, day.courts.c3], matchMinutes: 90 });
    const [x, y, z, w] = other.pairs;
    const xy = between(other, x!, y!);
    const zw = between(other, z!, w!);
    const xz = between(other, x!, z!);
    await place(day, xy.id, 0, day.courts.c2);
    await setStatus(xy.id, "in_play"); // no core.start: its kick-off is unknown, so it is taken as starting now
    await place(day, zw.id, 200, day.courts.c1);
    await callFixtureToCourt(day.auth, zw.id, day.courts.c3, at(5));
    await place(day, xz.id, 70, day.courts.c2); // the other competition's planned match on the shared court
    const f12 = between(day.comp, p1, p2);
    const f34 = between(day.comp, p3, p4);
    await place(day, f12.id, 60, day.courts.c2);
    await place(day, f34.id, 80, day.courts.c2);

    const view = await getMatchDay(day.auth, day.comp.id, at(10));

    expect(courtOf(view, day.courts.c2)).toMatchObject({ state: "in_use_elsewhere", in_use_by: other.name, current: null, free_since: null });
    expect(courtOf(view, day.courts.c3)).toMatchObject({ state: "in_use_elsewhere", in_use_by: other.name, current: null });
    expect(courtOf(view, day.courts.c1)).toMatchObject({ state: "free", in_use_by: null, current: null });
    // Court 2 is held until 10 + 90 = 100 (the other division's length). f12: max(60, 100) = 100, ends 130; the other
    // competition's xz: max(70, 130) = 130, ends 220; f34: max(80, 220) = 220. xz is not listed: never controllable here.
    expect(queueOf(courtOf(view, day.courts.c2))).toEqual([
      [f12.id, 60, 100],
      [f34.id, 80, 220],
    ]);
  });

  it("a court's current match and its queue: the queue excludes the current and the called match, is in planned order, and moves back when a call is undone", async () => {
    const day = await seedDay();
    const { p1, p2, p3, p4 } = pairs(day);
    const f12 = between(day.comp, p1, p2);
    const f13 = between(day.comp, p1, p3);
    const f24 = between(day.comp, p2, p4);
    const f34 = between(day.comp, p3, p4);
    const f14 = between(day.comp, p1, p4);
    const f23 = between(day.comp, p2, p3);
    await place(day, f12.id, 0, day.courts.c1);
    await start(day, f12.id, 5);
    await place(day, f24.id, 90, day.courts.c1); // placed before f13, planned after it
    await place(day, f13.id, 30, day.courts.c1);
    await place(day, f23.id, 10, day.courts.c1);
    await finish(f23.id, "decided", 25); // ended: in no queue
    await place(day, f34.id, 45, day.courts.c1);
    await callFixtureToCourt(day.auth, f34.id, day.courts.c2, at(20)); // leaves Court 1's queue, Court 2's current
    await place(day, f14.id, 100, day.courts.c2);
    const live = await sessionOnTarget(day.orgId, f12.id, await rigTarget(day.orgId, "Cam 1"), "live");
    const warming = await sessionOnTarget(day.orgId, f14.id, await rigTarget(day.orgId, "Cam 2"), "warming");
    expect([live, warming].every((s) => typeof s === "string")).toBe(true);

    const view = await getMatchDay(day.auth, day.comp.id, at(20));

    const c1 = courtOf(view, day.courts.c1);
    expect(c1.state).toBe("playing");
    expect(c1.current).toEqual({
      id: f12.id,
      division_id: day.comp.divisionId,
      division_name: "Doubles",
      sport_key: "generic",
      stage_label: "League",
      home: day.comp.pairs.find((p) => p.id === f12.home)!.name,
      away: day.comp.pairs.find((p) => p.id === f12.away)!.name,
      headline: null,
      started_at: iso(5),
      called_at: null,
      stream: "live",
    });
    // Held until max(now 20, kick-off 5 + 30) = 35. f13: max(30, 35) = 35, ends 65; f24: max(90, 65) = 90.
    expect(queueOf(c1)).toEqual([
      [f13.id, 30, 35],
      [f24.id, 90, 90],
    ]);
    const c2 = courtOf(view, day.courts.c2);
    expect(c2).toMatchObject({ state: "called", current: { id: f34.id, called_at: iso(20), started_at: null, stream: null } });
    // A called match holds the court for a match length from now: 20 + 30 = 50. f14: max(100, 50) = 100.
    expect(queueOf(c2)).toEqual([[f14.id, 100, 100]]);
    expect(c2.queue[0]!.stream).toBe("waiting");
    expect(courtOf(view, day.courts.c3)).toMatchObject({ state: "free", current: null, queue: [], free_since: null });

    // Undo call: Court 2 is free again, and f34 is back in Court 1's queue at its planned 45, estimated behind f13.
    await undoCall(day.auth, f34.id);
    const after = await getMatchDay(day.auth, day.comp.id, at(21));
    expect(courtOf(after, day.courts.c2)).toMatchObject({ state: "free", current: null });
    expect(queueOf(courtOf(after, day.courts.c2))).toEqual([[f14.id, 100, 100]]);
    // Held until 35. f13: 35, ends 65; f34: max(45, 65) = 65, ends 95; f24: max(90, 95) = 95.
    expect(queueOf(courtOf(after, day.courts.c1))).toEqual([
      [f13.id, 30, 35],
      [f34.id, 45, 65],
      [f24.id, 90, 95],
    ]);
  });

  it("what holds a court ends no earlier than now: an overrunning match holds it until now; a called match for a match length from now", async () => {
    const day = await seedDay();
    const { p1, p2, p3, p4 } = pairs(day);
    const f12 = between(day.comp, p1, p2);
    const f13 = between(day.comp, p1, p3);
    const f34 = between(day.comp, p3, p4);
    const f14 = between(day.comp, p1, p4);
    await place(day, f12.id, -40, day.courts.c1);
    await start(day, f12.id, -40); // 30 minutes long, so due off at -10: overrunning at 20
    await place(day, f13.id, 10, day.courts.c1);
    await callFixtureToCourt(day.auth, f34.id, day.courts.c2, at(20));
    await place(day, f14.id, 30, day.courts.c2);

    const view = await getMatchDay(day.auth, day.comp.id, at(20));

    // Court 1 held until max(now 20, -40 + 30) = 20: f13 max(10, 20) = 20. Court 2 held until 20 + 30 = 50: f14 max(30, 50) = 50.
    expect(queueOf(courtOf(view, day.courts.c1))).toEqual([[f13.id, 10, 20]]);
    expect(queueOf(courtOf(view, day.courts.c2))).toEqual([[f14.id, 30, 50]]);
  });

  it("needs_you is the desk's own Needs-you list, in the reader's language; results_owed counts the matches past their time with no result", async () => {
    const day = await seedDay();
    const { p1, p2, p3, p4 } = pairs(day);
    await sql`update divisions set status = 'active' where id = ${day.comp.divisionId}`;
    // Two 30-minute matches planned at 11:00 and nothing recorded: at 12:00 both owe a result. The other four have no time.
    await place(day, between(day.comp, p1, p2).id, 0, day.courts.c1);
    await place(day, between(day.comp, p3, p4).id, 0, day.courts.c2);
    const now = at(60);

    const [slugs] = await sql<{ org: string; comp: string }[]>`
      select o.slug as org, c.slug as comp from competitions c join organizations o on o.id = c.org_id where c.id = ${day.comp.id}`;
    const desk = await getCompetitionDesk(day.auth, day.comp.id, now);
    const divisions = (await listDivisions(day.auth, day.comp.id)).map((d) => ({ id: d.id, name: d.name, slug: d.slug }));
    const en = needsYouItems(uiEn as unknown as Dict, desk, divisions, slugs!.org, slugs!.comp, "en");
    const fr = needsYouItems({ ...uiEn, ...uiFr } as unknown as Dict, desk, divisions, slugs!.org, slugs!.comp, "fr");
    expect(en.map((i) => i.kind)).toEqual(expect.arrayContaining(["result_missing", "unscheduled"]));
    expect(fr.map((i) => i.title)).not.toEqual(en.map((i) => i.title));

    const view = await getMatchDay(day.auth, day.comp.id, now);
    expect(view.needs_you).toEqual(en);
    expect(view.results_owed).toBe(2);
    expect((await getMatchDay(day.auth, day.comp.id, now, { locale: "fr" })).needs_you).toEqual(fr);
  });

  it("the court noun follows the sport: a football division's court is a pitch, a chess division's a board", async () => {
    const day = await seedDay();
    const comp = await createCompetition(day.auth, { ends_on: "2030-12-31", name: "Two sports", visibility: "public", branding: {} });
    const sports: [string, string, string, string][] = [
      // sport, variant, court, the noun the spec names for it (§6.2: court, pitch, table, board)
      ["football", "11-a-side", day.courts.c1, "pitch"],
      ["boardgame", "classical", day.courts.c2, "board"],
    ];
    for (const [sport, variant, courtId] of sports) {
      const d = await createDivision(day.auth, comp.id, { name: sport, sport_key: sport, variant_key: variant, config: {} });
      await putScheduleSettings(day.auth, d.id, {
        config: { startAt: "2026-11-01T00:00:00.000Z", matchMinutes: 30, gapMinutes: 0, courts: [courtId], perEntrantMinRest: 0, blackouts: [], sessionWindows: [] },
      });
    }

    const view = await getMatchDay(day.auth, comp.id, at(0));

    expect(view.courts.map((c) => c.court_id)).toEqual([day.courts.c1, day.courts.c2]);
    let checked = 0;
    for (const [sport, , courtId, noun] of sports) {
      expect(courtOf(view, courtId).sport_noun, sport).toBe(noun);
      expect(courtOf(view, courtId).sport_noun, sport).toBe(venueNoun(sport));
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a competition with no divisions: no courts, nothing owed, no matches today", async () => {
    const day = await seedDay();
    const comp = await createCompetition(day.auth, { ends_on: "2030-12-31", name: "Empty", visibility: "public", branding: {} });
    expect(await getMatchDay(day.auth, comp.id, at(0))).toEqual({
      competition_id: comp.id,
      date: "2026-11-07",
      tz: ORG_TZ,
      now: iso(0),
      courts: [],
      needs_you: [],
      results_owed: 0,
      fixtures_today: 0,
    });
  });

  it("refuses a competition that is not the org's (404)", async () => {
    const day = await seedDay();
    const stranger = await seedDay();
    const err = await getMatchDay(day.auth, stranger.comp.id, at(0)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
  });
});

describe.skipIf(!HAS_DB)("countFixturesToday", () => {
  it("counts this competition's matches on the given zone's day: not the day before or after, not a middle day with none, not a cancelled one; a match in play counts today", async () => {
    const day = await seedDay();
    const { p1, p2, p3, p4 } = pairs(day);
    const MIN = 60_000;
    const minutesTo = (isoAt: string) => (Date.parse(isoAt) - at(0).getTime()) / MIN;
    await place(day, between(day.comp, p1, p2).id, 0, day.courts.c1); // Sat 7 Nov, 11:00 Amsterdam
    // 23:30Z on the 7th is 00:30 on Sun 8 Nov in Amsterdam: the zone decides which day it is.
    await place(day, between(day.comp, p3, p4).id, minutesTo("2026-11-07T23:30:00.000Z"), day.courts.c1);
    await place(day, between(day.comp, p1, p3).id, minutesTo("2026-11-10T10:00:00.000Z"), day.courts.c1); // Tue 10 Nov
    const cancelled = between(day.comp, p2, p4).id;
    await place(day, cancelled, 60, day.courts.c2);
    await setStatus(cancelled, "cancelled"); // Sat 7 Nov, cancelled

    const count = (tz: string, isoAt: string) =>
      withTenant(day.orgId, (tx) => countFixturesToday(tx, day.comp.id, tz, new Date(isoAt)));
    const days: [string, number][] = [
      ["2026-11-06T12:00:00.000Z", 0], // the day before
      ["2026-11-07T12:00:00.000Z", 1], // the day of: 11:00, not the cancelled 12:00, not 00:30 tomorrow
      ["2026-11-08T12:00:00.000Z", 1], // the 00:30
      ["2026-11-09T12:00:00.000Z", 0], // a middle day with none
      ["2026-11-10T12:00:00.000Z", 1],
      ["2026-11-11T12:00:00.000Z", 0], // the day after
    ];
    let checked = 0;
    for (const [isoAt, n] of days) {
      expect(await count(ORG_TZ, isoAt), isoAt).toBe(n);
      checked++;
    }
    expect(checked).toBe(6);
    // In UTC the 23:30Z match is on the 7th: the zone is the caller's, not a constant.
    expect(await count("UTC", "2026-11-07T12:00:00.000Z")).toBe(2);
    // A match in play is a match today, whatever its planned day (here: none).
    const playing = between(day.comp, p1, p4).id;
    await setStatus(playing, "in_play");
    expect(await count(ORG_TZ, "2026-11-09T12:00:00.000Z")).toBe(1);
    expect((await getMatchDay(day.auth, day.comp.id, new Date("2026-11-07T12:00:00.000Z"))).fixtures_today).toBe(2);
  });
});

/** A candidate as the fields a person reads. */
const seen = (c: MatchDayCandidate) => ({
  id: c.fixture.id,
  source: c.source,
  from: c.from_court_name,
  waiting: c.waiting_minutes,
  behind: c.behind_minutes,
  blocked: c.blocked,
});

describe.skipIf(!HAS_DB)("matchDayCandidates", () => {
  it("ranks this court's next match, other courts' next READY matches and ready no-court matches; leaves out a TBD side and a court's later matches; blocks on a busy doubles PARTNER by person", async () => {
    const day = await seedDay();
    const { p1, p2, p3, p4 } = pairs(day);
    const [ann, bob] = day.people;
    const f12 = between(day.comp, p1, p2);
    const f13 = between(day.comp, p1, p3);
    const f14 = between(day.comp, p1, p4);
    const f23 = between(day.comp, p2, p3);
    const f24 = between(day.comp, p2, p4);
    const f34 = between(day.comp, p3, p4);
    await place(day, f14.id, 30, day.courts.c3); // the target court's own next match
    await place(day, f12.id, 5, day.courts.c1); // first in Court 1's queue, but a side is still to be decided
    await sql`update fixtures set away_entrant_id = null where id = ${f12.id}`;
    await place(day, f23.id, 10, day.courts.c1); // Court 1's next READY match
    await place(day, f24.id, 70, day.courts.c1); // Court 1's later match: not a candidate
    // Bob — Ann's partner in P1 — plays in another competition, with someone else, on Court 2. P1 itself plays nowhere.
    const xan = await person(day.orgId, "Xan Xu");
    const yul = await person(day.orgId, "Yul Yates");
    const zed = await person(day.orgId, "Zed Zane");
    const mixed = await seedCompetition(day.auth, "Mixed", [[bob!, xan], [yul, zed]], { courts: [day.courts.c2] });
    await place(day, mixed.fixtures[0]!.id, 0, day.courts.c2);
    await setStatus(mixed.fixtures[0]!.id, "in_play");
    expect(ann!.name).toBe("Ann Archer");

    const ranked = await matchDayCandidates(day.auth, day.comp.id, day.courts.c3, at(20));

    const bobOnCourt2 = { kind: "player_busy", person_name: "Bob Bell", court_name: "Court 2" };
    // Court 1 is free from 20: the TBD f12 max(5, 20) = 20, ends 50; f23 max(10, 50) = 50: 30 to wait, 40 behind.
    // f14 on Court 3: max(30, 20) = 30, 10 to wait.
    expect(ranked.map(seen)).toEqual([
      { id: f23.id, source: "other_court", from: "Court 1", waiting: 30, behind: 40, blocked: null },
      { id: f34.id, source: "no_court", from: null, waiting: 0, behind: 0, blocked: null },
      { id: f14.id, source: "this_court", from: null, waiting: 10, behind: 0, blocked: bobOnCourt2 },
      { id: f13.id, source: "no_court", from: null, waiting: 0, behind: 0, blocked: bobOnCourt2 },
    ]);
    expect(ranked[0]!.fixture).toMatchObject({ division_name: "Doubles", sport_key: "generic", stage_label: "League", stream: null });
  });

  it("another sport — football teams with no roster: a team playing elsewhere blocks its other matches by the TEAM's name", async () => {
    const day = await seedDay();
    const football = await seedCompetition(day.auth, "Cup", [], {
      courts: [day.courts.c1, day.courts.c2, day.courts.c3],
      teams: ["Ajax", "Benfica", "Celtic"],
    });
    const [ajax, benfica, celtic] = football.pairs;
    const ab = between(football, ajax!, benfica!);
    await place(day, ab.id, 0, day.courts.c1);
    await setStatus(ab.id, "in_play");

    const ranked = await matchDayCandidates(day.auth, football.id, day.courts.c3, at(20));

    expect(ranked.map((c) => c.source)).toEqual(["no_court", "no_court"]);
    expect(Object.fromEntries(ranked.map((c) => [c.fixture.id, c.blocked]))).toEqual({
      [between(football, ajax!, celtic!).id]: { kind: "player_busy", person_name: "Ajax", court_name: "Court 1" },
      [between(football, benfica!, celtic!).id]: { kind: "player_busy", person_name: "Benfica", court_name: "Court 1" },
    });
  });

  it("a called, unstarted match is a candidate on another free court, not blocked by its own call; its players block their other matches", async () => {
    const day = await seedDay();
    const { p1, p3, p4 } = pairs(day);
    const f34 = between(day.comp, p3, p4);
    await callFixtureToCourt(day.auth, f34.id, day.courts.c1, at(10));

    const ranked = await matchDayCandidates(day.auth, day.comp.id, day.courts.c2, at(12));

    const mine = ranked.find((c) => c.fixture.id === f34.id);
    expect(mine && seen(mine)).toEqual({ id: f34.id, source: "other_court", from: "Court 1", waiting: 0, behind: 0, blocked: null });
    expect(mine!.fixture.called_at).toBe(iso(10));
    // Eve (P3) is called onto Court 1: first by name of the busy P3 and P4 people in f13.
    const f13 = ranked.find((c) => c.fixture.id === between(day.comp, p1, p3).id);
    expect(f13?.blocked).toEqual({ kind: "player_busy", person_name: "Eve Ellis", court_name: "Court 1" });
  });

  it("no-court matches only from active stages, none planned for a later day, none with a TBD side; nothing ready → an empty list", async () => {
    const day = await seedDay();
    const { p1, p2, p3, p4 } = pairs(day);
    const tomorrow = between(day.comp, p1, p2);
    await place(day, tomorrow.id, 24 * 60, null); // a time tomorrow, no court
    const tbd = between(day.comp, p3, p4);
    await sql`update fixtures set home_entrant_id = null where id = ${tbd.id}`; // a side still to be decided
    const before = await matchDayCandidates(day.auth, day.comp.id, day.courts.c1, at(0));
    expect(before.map((c) => c.source)).toEqual(Array(4).fill("no_court"));
    expect(before.map((c) => c.fixture.id)).not.toContain(tomorrow.id);
    expect(before.map((c) => c.fixture.id)).not.toContain(tbd.id);

    await sql`update stages set status = 'pending' where id = ${day.comp.stageId}`;
    expect(await matchDayCandidates(day.auth, day.comp.id, day.courts.c1, at(0))).toEqual([]);
  });

  it("refuses a court that is not the org's, or is archived (404)", async () => {
    const day = await seedDay();
    const stranger = await seedDay();
    await sql`update courts set archived_at = now() where id = ${day.courts.c3}`;
    let checked = 0;
    for (const courtId of [stranger.courts.c1, day.courts.c3]) {
      const err = await matchDayCandidates(day.auth, day.comp.id, courtId, at(0)).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(404);
      checked++;
    }
    expect(checked).toBe(2);
  });
});
