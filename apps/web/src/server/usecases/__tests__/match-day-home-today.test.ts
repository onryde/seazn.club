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
import { sql, withTenant } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { competitionsFixturesToday, countFixturesToday } from "../match-day";
import { person, seedCompetition, setStatus, type Comp } from "./_match-day-seed";
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
    const page = await withTenant(auth.orgId, (tx) => countFixturesToday(tx, id, now));
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

    // Everything today played or cancelled: still counted where Match Day counts it, but nothing left to headline.
    await setStatus(overdue!, "finalized");
    await setStatus(later!, "cancelled");
    await setStatus(earlier!, "cancelled");
    read = await competitionsFixturesToday(auth, [comp.id], SUN_EARLY);
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
