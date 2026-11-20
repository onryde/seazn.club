// Match Day C7 — the org Competitions home's today deck reads `competitionsFixturesToday`: how many of each listed
// competition's matches are today, for the whole list in ONE bounded read (never a query per card).
//
// The rules under test, from the Match Day spec and the owner's C7 rulings, not from the code:
//  - "today" is Match Day's own: decided per match, on its division's day — the venue zone, else the organisation's, else UTC
//    (spec §6.2; controller ruling I2). So the home and the Match Day board it opens agree about which matches are today;
//  - a match in play is a match today whatever its planned day; a cancelled match is no match; a match of an archived
//    division is gone from the competition (the same exclusions `countFixturesToday` makes, because it IS that count);
//  - the deck's date label is the organisation's day;
//  - a competition of another organisation is never counted, even if its id is asked for (tenant isolation).
//
// The clock is fixed, and each case is built so the right answer DIFFERS from the UTC-based wrong one. The organisation is on
// Europe/Amsterdam (UTC+1 in November): midnight there is 23:00Z. Two matches straddle it by a minute:
//   EVE  at 22:59Z Sat 7 Nov = 23:59 Sat in Amsterdam (just before midnight)
//   MORN at 23:01Z Sat 7 Nov = 00:01 Sun in Amsterdam (just after midnight)
// In UTC both are on Saturday, so a UTC "today" would put both competitions on the deck at either clock below. In Amsterdam
// exactly one is today, and which one flips across midnight.
//
// Real Postgres required; skipped without DATABASE_URL (CI runs them).
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { needsYouHome } from "@/components/v2/desk/needs-you";
import { CHECKIN_EXTEND_MAX, CHECKIN_EXTEND_STEP_MS, DEADLINE_AFTER_MS, LINE_DEADLINE_GRACE_MS } from "@/server/external-play/window";
import { getCompetitionDesk } from "../competition-desk";
import { competitionFixturesToday, competitionsFixturesToday } from "../match-day";
import { putScheduleSettings } from "../schedule";
import { seedOnlineChessRound, type SeedOnlineChessRoundResult } from "./_external-play-seed";
import { person, seedCompetition, setStatus, type Comp } from "./_match-day-seed";
import { at, bridgeRow, openStamp, setFixtureStatus } from "./_match-day-online-seed";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;
const ORG_TZ = "Europe/Amsterdam";

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

const EVE = "2026-11-07T22:59:00.000Z"; // 23:59 Sat in Amsterdam
const MORN = "2026-11-07T23:01:00.000Z"; // 00:01 Sun in Amsterdam
const SAT_LATE = new Date("2026-11-07T22:30:00.000Z"); // 23:30 Sat in Amsterdam; Sat in UTC
const SUN_EARLY = new Date("2026-11-07T23:30:00.000Z"); // 00:30 Sun in Amsterdam; still Sat in UTC

/** A competition of one generic division with two pairs: exactly one fixture, planned at `at` (null: unplanned). */
async function compWithOne(auth: AuthCtx, label: string, at: string | null): Promise<Comp & { fixture: string }> {
  const a = await person(auth.orgId, `${label} Ann`);
  const b = await person(auth.orgId, `${label} Bob`);
  const comp = await seedCompetition(auth, label, [[a], [b]], { courts: [] });
  const fixture = comp.fixtures[0]!.id;
  if (at !== null) await sql`update fixtures set scheduled_at = ${at} where id = ${fixture}`;
  return { ...comp, fixture };
}

async function amsterdamOrg(): Promise<AuthCtx> {
  const { auth } = await seedOrg("pro");
  await sql`update organizations set timezone = ${ORG_TZ} where id = ${auth.orgId}`;
  return auth;
}

/** The deck's members at `now`: the ids with a count, each count checked against `countFixturesToday` (the competition page's
 *  own count) so the two surfaces are held to one answer. Returns how many it compared (anti-vacuity: the caller asserts it). */
async function deckAt(auth: AuthCtx, ids: string[], now: Date): Promise<{ members: string[]; compared: number; day: string; tz: string }> {
  const read = await competitionsFixturesToday(auth, ids, now);
  let compared = 0;
  for (const id of ids) {
    const page = await competitionFixturesToday(auth, id, now);
    expect(read.counts.get(id) ?? 0, `competition ${id}: home and competition page agree`).toBe(page);
    compared++;
  }
  return { members: ids.filter((id) => (read.counts.get(id) ?? 0) > 0), compared, day: read.day, tz: read.tz };
}

describe.skipIf(!HAS_DB)("competitionsFixturesToday — the org home's today deck", () => {
  it("the empty case first: no competitions asked for is an empty deck, and the label is still the organisation's day", async () => {
    const auth = await amsterdamOrg();
    const read = await competitionsFixturesToday(auth, [], SUN_EARLY);
    expect(read.counts.size).toBe(0);
    expect(read).toMatchObject({ day: "2026-11-08", tz: ORG_TZ }); // 00:30 Sun in Amsterdam; UTC would say 2026-11-07
  });

  it("decides 'today' in the competition's zone: a match a minute either side of Amsterdam's midnight swaps the deck, where UTC would list both", async () => {
    const auth = await amsterdamOrg();
    const late = await compWithOne(auth, "Late Cup", EVE);
    // A Draft competition (every seeded one is a draft until published): owner ruling, a draft with a match today is on the deck.
    const early = await compWithOne(auth, "Early Cup", MORN);
    const quiet = await compWithOne(auth, "Quiet Cup", null);
    await sql`update competitions set status = 'published' where id = ${late.id}`;
    const ids = [late.id, early.id, quiet.id];

    const sat = await deckAt(auth, ids, SAT_LATE);
    expect(sat.compared).toBe(3);
    expect(sat.day).toBe("2026-11-07");
    expect(sat.members).toEqual([late.id]); // UTC: [late, early]

    const sun = await deckAt(auth, ids, SUN_EARLY);
    expect(sun.compared).toBe(3);
    expect(sun.day).toBe("2026-11-08"); // UTC: 2026-11-07
    expect(sun.members).toEqual([early.id]); // UTC: [late, early]
    const [{ status }] = await sql<{ status: string }[]>`select status from competitions where id = ${early.id}`;
    expect(status, "premise: the one on Sunday's deck is a Draft").toBe("draft");

    // A second read at the same clock is the same answer (no state is kept between calls).
    expect((await deckAt(auth, ids, SUN_EARLY)).members).toEqual([early.id]);
  });

  it("each match is on its OWN division's day: a division declaring UTC reads 22:59Z as today on Sunday's clock in Amsterdam", async () => {
    const auth = await amsterdamOrg();
    const comp = await compWithOne(auth, "Venue Cup", EVE);
    expect((await deckAt(auth, [comp.id], SUN_EARLY)).members).toEqual([]); // Amsterdam: that was yesterday
    await sql`update schedule_settings set tz = 'UTC' where division_id = ${comp.divisionId}`;
    const sun = await deckAt(auth, [comp.id], SUN_EARLY);
    expect(sun.members).toEqual([comp.id]); // the venue's zone: still Saturday there
    expect(sun.day, "the label stays the organisation's day").toBe("2026-11-08");
  });

  it("the sequence: a cancel takes a competition off the deck, a match in play puts one on whatever its day, an archived division leaves", async () => {
    const auth = await amsterdamOrg();
    const comp = await compWithOne(auth, "Seq Cup", MORN);
    const other = await compWithOne(auth, "Other Cup", "2026-11-03T10:00:00.000Z"); // Tuesday: not today
    const ids = [comp.id, other.id];
    expect((await deckAt(auth, ids, SUN_EARLY)).members).toEqual([comp.id]);

    await setStatus(comp.fixture, "cancelled");
    expect((await deckAt(auth, ids, SUN_EARLY)).members, "a cancelled match is no match").toEqual([]);

    await setStatus(other.fixture, "in_play");
    expect((await deckAt(auth, ids, SUN_EARLY)).members, "a match being played is a match today").toEqual([other.id]);

    await sql`update divisions set archived_at = now() where id = ${other.divisionId}`;
    expect((await deckAt(auth, ids, SUN_EARLY)).members, "an archived division is gone from the competition").toEqual([]);
  });

  it("counts every division of a competition, of any sport: a football division's match today puts the competition on the deck", async () => {
    // Another sport, one sample: the rule reads `fixtures` and `schedule_settings` only, never the sport — the sample proves no
    // sport filter crept in, and the count sums across divisions.
    const auth = await amsterdamOrg();
    const comp = await compWithOne(auth, "Two Sport Cup", MORN);
    const teams = await seedCompetition(auth, "Football", [], {
      courts: [],
      teams: ["Riverside FC", "Valley FC"],
      competitionId: comp.id,
    });
    expect(teams.id).toBe(comp.id);
    await sql`update fixtures set scheduled_at = ${MORN} where id = ${teams.fixtures[0]!.id}`;
    const read = await competitionsFixturesToday(auth, [comp.id], SUN_EARLY);
    expect(read.counts.get(comp.id)).toBe(2);
    const [{ sports }] = await sql<{ sports: string[] }[]>`
      select array_agg(distinct sport_key order by sport_key) as sports from divisions where competition_id = ${comp.id}`;
    expect(sports, "premise: two sports").toEqual(["football", "generic"]);
  });

  it("the deck's headline is TODAY's match: in play first (whatever its day), then the earliest planned today — never an overdue one, never one with a side to be decided", async () => {
    // M2 (C7 review): the card's "next" is the earliest upcoming match of ANY date, so a league with an unplayed match from
    // last week would headline that one on today's deck. The deck's own pick rides the today read.
    const auth = await amsterdamOrg();
    const [a, b, c] = [await person(auth.orgId, "Hd Ann"), await person(auth.orgId, "Hd Bob"), await person(auth.orgId, "Hd Cat")];
    const comp = await seedCompetition(auth, "Headline Cup", [[a], [b], [c]], { courts: [] });
    const [overdue, later, earlier] = comp.fixtures.map((f) => f.id);
    expect([overdue, later, earlier].every(Boolean), "premise: three matches").toBe(true);
    await sql`update fixtures set scheduled_at = '2026-11-03T10:00:00Z' where id = ${overdue!}`; // last Tuesday, unplayed
    await sql`update fixtures set scheduled_at = '2026-11-08T10:00:00Z' where id = ${later!}`; // 11:00 Sun in Amsterdam
    await sql`update fixtures set scheduled_at = '2026-11-08T09:00:00Z' where id = ${earlier!}`; // 10:00 Sun in Amsterdam
    const names = async (id: string) =>
      (await sql<{ home: string; away: string }[]>`
        select he.display_name as home, ae.display_name as away from fixtures f
          join entrants he on he.id = f.home_entrant_id join entrants ae on ae.id = f.away_entrant_id where f.id = ${id}`)[0]!;

    let read = await competitionsFixturesToday(auth, [comp.id], SUN_EARLY);
    expect(read.counts.get(comp.id)).toBe(2);
    expect(read.next.get(comp.id)).toMatchObject({ fixture_id: earlier, in_play: false, ...(await names(earlier!)) });
    expect(Date.parse(read.next.get(comp.id)!.scheduled_at!)).toBe(Date.parse("2026-11-08T09:00:00Z"));

    // A side still to be decided is counted (it is a match today) but is no headline: the next one with both sides is.
    const [{ home_entrant_id: earlierHome }] = await sql<{ home_entrant_id: string }[]>`
      select home_entrant_id from fixtures where id = ${earlier!}`;
    await sql`update fixtures set home_entrant_id = null where id = ${earlier!}`;
    read = await competitionsFixturesToday(auth, [comp.id], SUN_EARLY);
    expect(read.counts.get(comp.id)).toBe(2);
    expect(read.next.get(comp.id)?.fixture_id).toBe(later);
    await sql`update fixtures set home_entrant_id = ${earlierHome} where id = ${earlier!}`;

    // In play leads: the 11:00 match goes into play and heads the deck over the 10:00 one still to start (planned order alone
    // would pick the 10:00 one).
    await setStatus(later!, "in_play");
    read = await competitionsFixturesToday(auth, [comp.id], SUN_EARLY);
    expect(read.counts.get(comp.id)).toBe(2);
    expect(read.next.get(comp.id)).toMatchObject({ fixture_id: later, in_play: true });

    // The overdue one goes into play too: it is counted today whatever its planned day, and of the two in play the earlier
    // planned leads.
    await setStatus(overdue!, "in_play");
    read = await competitionsFixturesToday(auth, [comp.id], SUN_EARLY);
    expect(read.counts.get(comp.id)).toBe(3);
    expect(read.next.get(comp.id)).toMatchObject({ fixture_id: overdue, in_play: true, ...(await names(overdue!)) });

    // A played match never headlines (C7 re-review I1). Back to the two planned for today, the overdue one off the day again.
    await setStatus(overdue!, "scheduled");
    await setStatus(later!, "scheduled");
    read = await competitionsFixturesToday(auth, [comp.id], SUN_EARLY);
    expect(read.counts.get(comp.id), "premise: today's two, the overdue one not counted").toBe(2);
    expect(read.next.get(comp.id)?.fixture_id, "premise: the 10:00 one leads").toBe(earlier);
    // The 10:00 match is decided while the 11:00 is still to start: it stays counted (Match Day still shows it), but the
    // headline moves on to the 11:00, the match the competition actually plays next.
    await setStatus(earlier!, "decided");
    read = await competitionsFixturesToday(auth, [comp.id], SUN_EARLY);
    expect(read.counts.get(comp.id)).toBe(2);
    expect(read.next.get(comp.id)).toMatchObject({ fixture_id: later, in_play: false, ...(await names(later!)) });
    // Both of today's matches played: the competition still has a row (count 2), and nothing on it to headline.
    await setStatus(later!, "decided");
    read = await competitionsFixturesToday(auth, [comp.id], SUN_EARLY);
    expect(read.counts.get(comp.id), "the row exists: a played match is still a match today").toBe(2);
    expect(read.next.has(comp.id)).toBe(false);

    // No row at all: today's two cancelled and the overdue one finalized leave nothing counted, so no headline either.
    await setStatus(overdue!, "finalized");
    await setStatus(later!, "cancelled");
    await setStatus(earlier!, "cancelled");
    read = await competitionsFixturesToday(auth, [comp.id], SUN_EARLY);
    expect(read.counts.has(comp.id)).toBe(false);
    expect(read.next.has(comp.id)).toBe(false);
  });

  it("never counts another organisation's competition, even when its id is asked for", async () => {
    const mine = await amsterdamOrg();
    const theirs = await amsterdamOrg();
    const foreign = await compWithOne(theirs, "Foreign Cup", MORN);
    const own = await compWithOne(mine, "Own Cup", MORN);
    const read = await competitionsFixturesToday(mine, [own.id, foreign.id], SUN_EARLY);
    expect(read.counts.get(own.id)).toBe(1); // the positive pair: the read works for this organisation
    expect(read.counts.has(foreign.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Match Day online, Task 5: what makes an ONLINE night a match day (spec 2026-11-05 section 4; brief md-t5). An online board has no
// planned time, so the day's own rule (a match planned within its division's day, or in play) never counts it. A round that has a
// `stage_round_opens` row makes its boards today's when ANY of three things holds, each tested ALONE below:
//   (a) it was opened in the division's day;
//   (b) its window bound (`roundWindowBoundSql`: the round's last batch start plus the declared tail) has not passed at `now`;
//   (c) the board has a game on file - a challenge and a bridge status that is not `finished`.
// A board counts only as a board (both sides seated, not cancelled), so a bye is no match. Three surfaces read the number (the org
// home's deck, the competition page's gate, the desk), and every case below holds them to ONE answer.
//
// The sport is chess: online play exists only for `boardgame` (`openRound` refuses any other sport), so a `stage_round_opens` row,
// and with it every arm below, exists for no other sport. The day's own rule is covered for generic and football above, unchanged.
// The expectations are seed values and the window's own declarations (the tail is summed here from the four constants it is made of).
// ---------------------------------------------------------------------------------------------------------------------------
const TAIL_MS = DEADLINE_AFTER_MS + LINE_DEADLINE_GRACE_MS + CHECKIN_EXTEND_MAX * CHECKIN_EXTEND_STEP_MS;
const iso = (d: Date): string => d.toISOString();

/** The competition's count at `now` as each surface reads it; they must agree, and the one number is returned. */
async function nightCount(r: SeedOnlineChessRoundResult, now: Date): Promise<number> {
  const home = (await competitionsFixturesToday(r.owner, [r.competitionId], now)).counts.get(r.competitionId) ?? 0;
  const page = await competitionFixturesToday(r.owner, r.competitionId, now);
  const desk = (await getCompetitionDesk(r.owner, r.competitionId, now)).fixtures_today;
  expect({ home, page, desk }, `at ${iso(now)}: the org home, the competition page and the desk read one number`).toEqual({ home: page, page, desk: page });
  return page;
}

/** One online round of `n` boards with no planned time: only the three arms can count them. */
const unplanned = (n: number, extra: { bye?: boolean } = {}) => seedOnlineChessRound({ fixtures: n, scheduledAt: null, ...extra });

describe.skipIf(!HAS_DB)("an online night: what makes an opened round a match day", () => {
  it("the empty case first: a paired round nobody opened is no match day, though it is full of boards; opening it is the day", async () => {
    const r = await unplanned(3);
    expect(await nightCount(r, at(0))).toBe(0);
    expect(needsYouHome(0)).toBe("competition");
    await openStamp(r, 1, at(-5)); // the positive pair: the SAME round, once opened
    const n = await nightCount(r, at(0));
    expect(n).toBe(3);
    expect(needsYouHome(n)).toBe("match_day");
  });

  it("(a) alone: opened today, every window long closed, no game on file - still the day's", async () => {
    const r = await unplanned(3);
    const opened = at(-180);
    expect(180 * 60_000, "premise: the open is further back than the whole window tail").toBeGreaterThan(TAIL_MS);
    expect(iso(opened).slice(0, 10), "premise: the open is on the read's UTC day").toBe(iso(at(0)).slice(0, 10));
    await openStamp(r, 1, opened);
    expect(await nightCount(r, at(0))).toBe(3);
  });

  it("(a)'s edge: an open at the very start of the division's day is the day's, one millisecond earlier is yesterday's", async () => {
    const r = await unplanned(2);
    const start = new Date("2026-11-19T00:00:00.000Z"); // the UTC organisation's midnight: the day [00:00Z, 24:00Z)
    const now = at(0); // 12:00Z: twelve hours on, every window long over
    await openStamp(r, 1, new Date(start.getTime() - 1));
    expect(await nightCount(r, now), "23:59:59.999 the day before").toBe(0);
    await sql`update stage_round_opens set opened_at = ${start} where stage_id = ${r.stageId} and round_no = 1`;
    expect(await nightCount(r, now), "00:00:00.000, the day's first instant").toBe(2);
  });

  it("(b) alone: opened at 23:50, read at 00:10 the next day - the window is live, so the night goes on; at the bound it stops", async () => {
    const r = await unplanned(3);
    const opened = new Date("2026-11-18T23:50:00.000Z");
    await openStamp(r, 1, opened);
    const bound = opened.getTime() + TAIL_MS; // an unstaggered round: the open IS the last batch start
    const midnightPast = new Date("2026-11-19T00:10:00.000Z");
    expect(midnightPast.getTime(), "premise: 00:10 is inside the bound").toBeLessThan(bound);
    expect(iso(opened).slice(0, 10), "premise: the open was yesterday, so arm (a) cannot be what counts").not.toBe(iso(midnightPast).slice(0, 10));
    expect(await nightCount(r, midnightPast)).toBe(3);
    expect(await nightCount(r, new Date(bound - 1_000))).toBe(3); // one second before the bound
    expect(await nightCount(r, new Date(bound))).toBe(0); // at the bound the window is over: not counted
    expect(await nightCount(r, new Date(bound + 1_000))).toBe(0);
  });

  it("the same round with every window closed and no game: not counted, and a second read says the same", async () => {
    const r = await unplanned(3);
    await openStamp(r, 1, new Date("2026-11-18T23:50:00.000Z"));
    const late = new Date("2026-11-19T02:00:00.000Z");
    expect(await nightCount(r, late)).toBe(0);
    expect(await nightCount(r, late)).toBe(0);
  });

  it("(c) alone: a game on file keeps the night; a finished game, a hold and a board with no game do not - and each finish takes its board off", async () => {
    const r = await unplanned(5);
    const [live, ready, finished, hold, plain] = r.boards.map((b) => b.fixtureId) as [string, string, string, string, string];
    await openStamp(r, 1, new Date("2026-11-18T09:00:00.000Z")); // yesterday, bound 09:30Z yesterday: closed by now
    await bridgeRow(live, r.orgId, { status: "live", moves: 4 });
    await bridgeRow(ready, r.orgId, { status: "ready" });
    await bridgeRow(finished, r.orgId, { status: "finished", moves: 30 });
    await setFixtureStatus(finished, "decided");
    await bridgeRow(hold, r.orgId, { status: "needs_organiser", reason: "lichess_unlinked", hold: true }); // no challenge: no game on file
    await bridgeRow(plain, r.orgId, { status: "pending" }); // invited, no game yet
    const now = new Date("2026-11-19T10:00:00.000Z");
    expect(now.getTime() - new Date("2026-11-18T09:00:00.000Z").getTime(), "premise: far past the bound").toBeGreaterThan(TAIL_MS);
    expect(await nightCount(r, now)).toBe(2); // live and ready

    await sql`update fixture_external_play set status = 'finished' where fixture_id = ${live}`;
    await setFixtureStatus(live, "decided");
    expect(await nightCount(r, now)).toBe(1);
    await sql`update fixture_external_play set status = 'finished' where fixture_id = ${ready}`;
    await setFixtureStatus(ready, "decided");
    expect(await nightCount(r, now)).toBe(0);
  });

  it("a round paired after the opened one is no part of the day until it is opened itself", async () => {
    const r = await unplanned(2);
    await openStamp(r, 1, at(-5));
    const second = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status, home_entrant_id, away_entrant_id, scheduled_at)
      select stage_id, division_id, org_id, 2, seq_in_round, 'md5-r2-' || id::text, 'scheduled', away_entrant_id, home_entrant_id, null
        from fixtures where stage_id = ${r.stageId} and round_no = 1
      returning id`;
    expect(second, "premise: round 2 has its two boards").toHaveLength(2);
    expect(await nightCount(r, at(0))).toBe(2); // round 1's boards, not round 2's
    await openStamp(r, 2, at(-1));
    expect(await nightCount(r, at(0))).toBe(4);
  });

  it("only boards count: a bye is no match and a cancelled board never was one", async () => {
    const r = await unplanned(3, { bye: true });
    expect(r.bye, "premise: the seed made a bye row").not.toBeNull();
    await openStamp(r, 1, at(-5));
    expect(await nightCount(r, at(0))).toBe(3); // three boards; the bye row is the fourth fixture of the round
    await setFixtureStatus(r.boards[2]!.fixtureId, "cancelled");
    expect(await nightCount(r, at(0))).toBe(2);
  });

  it("a board both planned today and in an opened round is counted once", async () => {
    const r = await seedOnlineChessRound({ fixtures: 2, scheduledAt: at(-30) });
    expect(await nightCount(r, at(0)), "premise: planned today, counted by the day's own rule before any open").toBe(2);
    await openStamp(r, 1, at(-5));
    expect(await nightCount(r, at(0))).toBe(2);
  });

  it("the day is the division's own: opened 00:30 Sunday in Amsterdam, read at 09:00 there - today in the club's zone, yesterday in UTC, today again in Auckland", async () => {
    const r = await unplanned(2);
    await sql`update organizations set timezone = ${ORG_TZ} where id = ${r.orgId}`;
    const opened = new Date("2026-11-07T23:30:00.000Z"); // Sat 23:30 UTC; Sun 00:30 Amsterdam (UTC+1); Sun 12:30 Auckland (UTC+13)
    const now = new Date("2026-11-08T08:00:00.000Z"); // Sun 08:00 UTC; 09:00 Amsterdam; 21:00 Auckland
    await openStamp(r, 1, opened);
    expect(now.getTime() - opened.getTime(), "premise: the window tail is long over, only the day can count it").toBeGreaterThan(TAIL_MS);
    expect(await nightCount(r, now)).toBe(2); // the club's zone: the open is on Sunday's calendar
    const settings = { startAt: "2026-11-01T00:00:00.000Z", matchMinutes: 30, gapMinutes: 0, courts: [], perEntrantMinRest: 0, blackouts: [], sessionWindows: [] };
    await putScheduleSettings(r.owner, r.divisionId, { config: settings, tz: "UTC" });
    expect(await nightCount(r, now)).toBe(0); // the venue declares UTC: the open was Saturday there
    await putScheduleSettings(r.owner, r.divisionId, { config: settings, tz: "Pacific/Auckland" });
    expect(await nightCount(r, now)).toBe(2); // Auckland: opened Sunday 12:30, read Sunday 21:00
  });

  it("an archived division's opened round is gone from the day, as every other count of it is", async () => {
    const r = await unplanned(2);
    await openStamp(r, 1, at(-5));
    expect(await nightCount(r, at(0))).toBe(2);
    await sql`update divisions set archived_at = now() where id = ${r.divisionId}`;
    expect(await nightCount(r, at(0))).toBe(0);
  });

  it("the org home's headline for an online night is one of its boards, an upcoming one with both sides, as its row already qualifies", async () => {
    const a = await unplanned(2);
    await openStamp(a, 1, at(-5));
    const read = await competitionsFixturesToday(a.owner, [a.competitionId], at(0));
    expect(read.counts.get(a.competitionId)).toBe(2);
    const headline = read.next.get(a.competitionId);
    expect(headline, "an upcoming board with both sides qualifies, as its row already would").toBeDefined();
    expect(a.boards.map((b) => b.fixtureId)).toContain(headline!.fixture_id);
    expect(headline!.in_play).toBe(false);
  });
});
