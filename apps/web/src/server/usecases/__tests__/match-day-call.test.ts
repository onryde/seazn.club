// Match Day A1 — calling a match onto a free court, Undo call, and the knock-on preview (spec 2026-10-31-match-day-design.md
// §7, §7.1 with owner ruling B, §7.2).
//
// The rules under test, from the spec, not from the code:
//  - a call writes the called match's court, venue and time (now) and nothing else: planned times of every other match stay
//    (ruling B), so a planned, not-started match on the target court never blocks it, though the board's own move refuses it;
//  - hard stops: a PERSON of the match on court now (a doubles partner counts), the target court playing or called (from any
//    competition: courts are org-level), a match that is not unstarted or has a TBD side;
//  - Undo call restores the exact previous court, venue and time, nulls included;
//  - the preview lists the target court's queue pushed later (estimate = max(planned, end of the match before)), a rest gap below
//    the division's declared minimum, and a queue running past the court's hours.
//
// The call path reads no sport column, but sports differ in the one thing it judges: who plays. A doubles pair is two rostered
// persons; a football team may be a NAME with no roster at all (members are optional). So the person check is swept on the
// generic doubles rig, and a memberless football league has its own case (the entrant check). The court noun per sport is
// A2/A3's sweep.
//
// Review 1 (fix round 1): a call is a schedule edit on the division's ledger (one `schedule_edited`, seq bumped, so a stale
// board is refused), it holds only while the match is exactly where the call put it, and it does not honour the schedule
// freeze (controller ruling R-m3).
//
// Real Postgres required; skipped without DATABASE_URL (CI runs them).
import { afterAll, describe, expect, it } from "vitest";
import { EngineError } from "@seazn/engine/core";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { moveFixture } from "../schedule";
import { callFixtureToCourt, previewCall, undoCall } from "../match-day-call";
import {
  at,
  between,
  callRows,
  iso,
  labelOf,
  ledgerOf,
  person,
  place,
  seedCompetition,
  seedDay,
  setStatus,
  slotOf,
  type Day,
} from "./_match-day-seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

/** The refusal a promise ends in — failing the test if it resolved, or threw anything but an HttpError. */
async function refusal(p: Promise<unknown>): Promise<HttpError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof HttpError)) throw new Error(`expected an HttpError refusal, got ${err === null ? "success" : String(err)}`);
  return err;
}

/** The pairs of the day's round robin: P1 = Ann & Bob, P2 = Cat & Dan, P3 = Eve & Fay, P4 = Gus & Hal. */
const pairs = (day: Day) => {
  const [p1, p2, p3, p4] = day.comp.pairs;
  return { p1: p1!, p2: p2!, p3: p3!, p4: p4! };
};

describe.skipIf(!HAS_DB)("callFixtureToCourt", () => {
  it("calls a scheduled fixture onto a free court: court, venue and time written, the previous slot kept", async () => {
    const day = await seedDay();
    const { p1, p2 } = pairs(day);
    const f = between(day.comp, p1, p2);
    await place(day, f.id, 120, day.courts.c2);
    const now = at(31);

    // Court 3 is in Hall B, Court 2 in Hall A: the venue the call writes is the target court's, not the one it had.
    const out = await callFixtureToCourt(day.auth, f.id, day.courts.c3, now);

    expect(out).toEqual({ fixture_id: f.id, court_id: day.courts.c3, called_at: now.toISOString() });
    expect(await slotOf(f.id)).toEqual({
      court_id: day.courts.c3,
      venue_id: day.venues.hallB,
      scheduled_at: now.toISOString(),
      status: "scheduled",
    });
    expect(await callRows(f.id)).toEqual([
      {
        fixture_id: f.id,
        org_id: day.orgId,
        court_id: day.courts.c3,
        called_at: now.toISOString(),
        called_by: day.auth.userId,
        prev_court_id: day.courts.c2,
        prev_venue_id: day.venues.hallA,
        prev_scheduled_at: iso(120),
      },
    ]);
  });

  it("ruling B: a call onto a court where a planned, not-started match sits succeeds — the board's move refuses the same slot — and no other match moves", async () => {
    const day = await seedDay();
    const { p1, p2, p3, p4 } = pairs(day);
    const f = between(day.comp, p1, p2); // the match being called
    const x = between(day.comp, p3, p4); // its round's other match: no shared player, planned on Court 1 at +45
    await place(day, f.id, 120, day.courts.c2);
    await place(day, x.id, 45, day.courts.c1);
    await place(day, between(day.comp, p1, p3).id, 200, day.courts.c2);
    await place(day, between(day.comp, p2, p4).id, 200, day.courts.c3);
    await place(day, between(day.comp, p1, p4).id, 260, day.courts.c2);
    await place(day, between(day.comp, p2, p3).id, 260, day.courts.c3);
    const now = at(31); // f would run +31..+61 on Court 1, over x's planned +45

    // The bypass is real: the existing single-fixture move refuses exactly this slot, on a court double booking against x.
    const moveErr = await moveFixture(day.auth, f.id, { scheduled_at: now.toISOString(), court_id: day.courts.c1 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(EngineError.is(moveErr, "SCHEDULE_CONFLICT")).toBe(true);
    const conflicts = ((moveErr as EngineError).data as {
      conflicts: { blocking: boolean; details?: { kind?: string; other_fixture_id?: string } }[];
    }).conflicts;
    expect(
      conflicts.some((c) => c.blocking && c.details?.kind === "court_double_booking" && c.details.other_fixture_id === x.id),
    ).toBe(true);
    expect(await slotOf(f.id)).toMatchObject({ court_id: day.courts.c2, scheduled_at: iso(120) });

    const others = day.comp.fixtures.filter((o) => o.id !== f.id);
    const before = await Promise.all(others.map((o) => slotOf(o.id)));
    await callFixtureToCourt(day.auth, f.id, day.courts.c1, now);

    expect(await slotOf(f.id)).toMatchObject({ court_id: day.courts.c1, scheduled_at: now.toISOString() });
    const after = await Promise.all(others.map((o) => slotOf(o.id)));
    expect(after).toEqual(before);
    expect(others.length, "anti-vacuity: the other matches compared").toBe(5);
    expect(await slotOf(x.id)).toEqual({
      court_id: day.courts.c1,
      venue_id: day.venues.hallA,
      scheduled_at: iso(45),
      status: "scheduled",
    });
  });

  it("Review Focus 5: a schedule-board move of the bumped planned match, still overlapping the called one, does not 409", async () => {
    const day = await seedDay();
    const { p1, p2, p3, p4 } = pairs(day);
    const f = between(day.comp, p1, p2);
    const x = between(day.comp, p3, p4);
    await place(day, f.id, 120, day.courts.c2);
    await place(day, x.id, 45, day.courts.c1);
    await callFixtureToCourt(day.auth, f.id, day.courts.c1, at(31));

    // +50 on Court 1 still overlaps f (+31..+61): the overlap the call left behind is the board's, not this edit's.
    await moveFixture(day.auth, x.id, { scheduled_at: iso(50), court_id: day.courts.c1 });
    expect(await slotOf(x.id)).toMatchObject({ court_id: day.courts.c1, scheduled_at: iso(50) });
  });

  it("refuses PLAYER_BUSY when a doubles partner is in play on another court — by person, though the two matches share no entrant", async () => {
    const day = await seedDay();
    const { p1, p2 } = pairs(day);
    const f = between(day.comp, p1, p2);
    await place(day, f.id, 120, day.courts.c2);
    const bob = p1.people[1]!; // P1's SECOND player
    // Bob also plays mixed doubles in another competition, with a partner of his own: a different entrant from P1.
    const other = await seedCompetition(
      day.auth,
      "Mixed Cup",
      [
        [bob, await person(day.orgId, "Zed Zane")],
        [await person(day.orgId, "Yan Yates"), await person(day.orgId, "Xia Xu")],
      ],
      { courts: [day.courts.c1, day.courts.c2] },
    );
    const g = other.fixtures[0]!;
    expect([g.home, g.away]).not.toContain(p1.id);
    expect([g.home, g.away]).not.toContain(p2.id);
    await place(day, g.id, 0, day.courts.c2);
    await setStatus(g.id, "in_play");

    const err = await refusal(callFixtureToCourt(day.auth, f.id, day.courts.c1, at(31)));
    expect(err.status).toBe(409);
    expect(err.code).toBe("PLAYER_BUSY");
    expect(err.extra).toEqual({ person_name: "Bob Bell", court_name: "Court 2" });
    expect(await slotOf(f.id)).toMatchObject({ court_id: day.courts.c2, scheduled_at: iso(120) });
    expect(await callRows(f.id)).toEqual([]);

    // The hard stop lifts when Bob's match is over.
    await setStatus(g.id, "decided");
    await callFixtureToCourt(day.auth, f.id, day.courts.c1, at(40));
    expect(await slotOf(f.id)).toMatchObject({ court_id: day.courts.c1, scheduled_at: iso(40) });
  });

  it("refuses PLAYER_BUSY when a partner's other match is CALLED (sent to a court, not yet started) — one person, two courts", async () => {
    const day = await seedDay();
    const { p1, p2 } = pairs(day);
    const f = between(day.comp, p1, p2);
    const bob = p1.people[1]!;
    const other = await seedCompetition(
      day.auth,
      "Mixed Cup",
      [
        [bob, await person(day.orgId, "Zed Zane")],
        [await person(day.orgId, "Yan Yates"), await person(day.orgId, "Xia Xu")],
      ],
      { courts: [day.courts.c1, day.courts.c2] },
    );
    const g = other.fixtures[0]!;
    await place(day, g.id, 60, day.courts.c2);
    await callFixtureToCourt(day.auth, g.id, day.courts.c2, at(30));

    const err = await refusal(callFixtureToCourt(day.auth, f.id, day.courts.c1, at(31)));
    expect(err.status).toBe(409);
    expect(err.code).toBe("PLAYER_BUSY");
    expect(err.extra).toEqual({ person_name: "Bob Bell", court_name: "Court 2" });
    expect(await callRows(f.id)).toEqual([]);
  });

  it("refuses COURT_BUSY when another competition's match is in play on the court — preview too — while another court takes the call", async () => {
    const day = await seedDay();
    const { p1, p2 } = pairs(day);
    const f = between(day.comp, p1, p2);
    await place(day, f.id, 120, day.courts.c2);
    const other = await seedCompetition(
      day.auth,
      "Club Night",
      [
        [await person(day.orgId, "Zed Zane"), await person(day.orgId, "Yan Yates")],
        [await person(day.orgId, "Xia Xu"), await person(day.orgId, "Wes Wolfe")],
      ],
      { courts: [day.courts.c1] },
    );
    const h = other.fixtures[0]!;
    await place(day, h.id, 0, day.courts.c1);
    await setStatus(h.id, "in_play");

    const err = await refusal(callFixtureToCourt(day.auth, f.id, day.courts.c1, at(31)));
    expect(err.status).toBe(409);
    expect(err.code).toBe("COURT_BUSY");
    expect(err.extra).toEqual({ court_name: "Court 1", competition_name: other.name });
    expect(await slotOf(f.id)).toMatchObject({ court_id: day.courts.c2, scheduled_at: iso(120) });
    expect(await callRows(f.id)).toEqual([]);

    const previewErr = await refusal(previewCall(day.auth, f.id, day.courts.c1, at(31)));
    expect(previewErr.code).toBe("COURT_BUSY");

    await callFixtureToCourt(day.auth, f.id, day.courts.c3, at(31));
    expect(await slotOf(f.id)).toMatchObject({ court_id: day.courts.c3 });
  });

  it("a live call holds the court (call A then call B → COURT_BUSY) while its match is unstarted or playing; once it is over the court is free", async () => {
    const day = await seedDay();
    const { p1, p2, p3, p4 } = pairs(day);
    const a = between(day.comp, p1, p2);
    const b = between(day.comp, p3, p4);
    await callFixtureToCourt(day.auth, a.id, day.courts.c1, at(30));

    const called = await refusal(callFixtureToCourt(day.auth, b.id, day.courts.c1, at(31)));
    expect(called.status).toBe(409);
    expect(called.code).toBe("COURT_BUSY");
    expect(called.extra).toEqual({ court_name: "Court 1", competition_name: day.comp.name });

    await setStatus(a.id, "in_play"); // the scorer started it
    const playing = await refusal(callFixtureToCourt(day.auth, b.id, day.courts.c1, at(32)));
    expect(playing.code).toBe("COURT_BUSY");

    await setStatus(a.id, "decided"); // its row stays; the status, not the row, says the court is free
    expect(await callRows(a.id)).toHaveLength(1);
    await callFixtureToCourt(day.auth, b.id, day.courts.c1, at(70));
    expect(await slotOf(b.id)).toMatchObject({ court_id: day.courts.c1, scheduled_at: iso(70) });
  });

  it("a call the schedule board has since moved off its court holds neither that court nor its players", async () => {
    const day = await seedDay();
    const { p1, p2, p3, p4 } = pairs(day);
    const a = between(day.comp, p1, p2);
    await callFixtureToCourt(day.auth, a.id, day.courts.c1, at(30));
    await moveFixture(day.auth, a.id, { scheduled_at: iso(200), court_id: day.courts.c2 });
    expect(await callRows(a.id)).toHaveLength(1); // the board does not know about calls; the row stays behind

    // Ann (P1) is in `a`, which is no longer called anywhere: her other match can be called.
    const annsOther = between(day.comp, p1, p3);
    await callFixtureToCourt(day.auth, annsOther.id, day.courts.c3, at(31));
    expect(await slotOf(annsOther.id)).toMatchObject({ court_id: day.courts.c3 });
    // Court 1, where `a` was called, is free.
    const b = between(day.comp, p2, p4);
    await callFixtureToCourt(day.auth, b.id, day.courts.c1, at(32));
    expect(await slotOf(b.id)).toMatchObject({ court_id: day.courts.c1 });
  });

  it("a call the board has since moved to a LATER time on the same court holds neither that court nor its players", async () => {
    const day = await seedDay();
    const { p1, p2, p3, p4 } = pairs(day);
    const a = between(day.comp, p1, p2);
    await place(day, a.id, 45, day.courts.c1); // Court 1's own next match…
    await callFixtureToCourt(day.auth, a.id, day.courts.c1, at(31)); // …called early
    await moveFixture(day.auth, a.id, { scheduled_at: iso(120), court_id: day.courts.c1 }); // …and put back later by the board
    expect(await callRows(a.id)).toHaveLength(1);

    // Ann & Bob (P1) and Cat & Dan (P2) are in `a`, which is no longer called: their other matches can be.
    const p1Other = between(day.comp, p1, p3);
    await callFixtureToCourt(day.auth, p1Other.id, day.courts.c3, at(32));
    expect(await slotOf(p1Other.id)).toMatchObject({ court_id: day.courts.c3, scheduled_at: iso(32) });
    // And Court 1, where `a` now only waits its planned turn, takes a call.
    const p2Other = between(day.comp, p2, p4);
    await callFixtureToCourt(day.auth, p2Other.id, day.courts.c1, at(33));
    expect(await slotOf(p2Other.id)).toMatchObject({ court_id: day.courts.c1, scheduled_at: iso(33) });
  });

  it("another sport — football teams with no roster: a team playing, or called, on another court refuses PLAYER_BUSY by the team's name", async () => {
    const day = await seedDay();
    const league = await seedCompetition(day.auth, "Sunday League", [], {
      courts: [day.courts.c1, day.courts.c2, day.courts.c3],
      teams: ["Rovers", "United", "City", "Athletic"],
    });
    const team = (n: string) => league.pairs.find((p) => p.name === n)!;
    expect(league.pairs.map((p) => p.people.length)).toEqual([0, 0, 0, 0]); // no roster: the person check sees nobody
    const playing = between(league, team("Rovers"), team("United"));
    await place(day, playing.id, 0, day.courts.c2);
    await setStatus(playing.id, "in_play");

    const roversCity = between(league, team("Rovers"), team("City"));
    const inPlay = await refusal(callFixtureToCourt(day.auth, roversCity.id, day.courts.c3, at(31)));
    expect(inPlay.status).toBe(409);
    expect(inPlay.code).toBe("PLAYER_BUSY");
    expect(inPlay.extra).toEqual({ person_name: "Rovers", court_name: "Court 2" });
    expect(await callRows(roversCity.id)).toEqual([]);

    // Over. Rovers v City is called onto Court 3, and Rovers' other match cannot go on Court 1 while they are called there.
    await setStatus(playing.id, "decided");
    await callFixtureToCourt(day.auth, roversCity.id, day.courts.c3, at(32));
    const roversAthletic = between(league, team("Rovers"), team("Athletic"));
    const called = await refusal(callFixtureToCourt(day.auth, roversAthletic.id, day.courts.c1, at(33)));
    expect(called.code).toBe("PLAYER_BUSY");
    expect(called.extra).toEqual({ person_name: "Rovers", court_name: "Court 3" });
    // A match of two free teams goes on Court 1.
    const free = between(league, team("United"), team("Athletic"));
    await callFixtureToCourt(day.auth, free.id, day.courts.c1, at(34));
    expect(await slotOf(free.id)).toMatchObject({ court_id: day.courts.c1, scheduled_at: iso(34) });
  });

  it("refuses NOT_CALLABLE for every status but `scheduled` (the DB's own status domain), and for a TBD side", async () => {
    const day = await seedDay();
    const { p1, p2 } = pairs(day);
    // The status domain as the database declares it (V432's CHECK), not as any module lists it.
    const [check] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'fixtures_status_check'`;
    const domain = [...check!.def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!);
    const uncallable = domain.filter((s) => s !== "scheduled");
    expect(uncallable).toEqual(expect.arrayContaining(["in_play", "decided"]));

    const insert = async (round: number, home: string | null, away: string | null, status: string) => {
      const [r] = await sql<{ id: string }[]>`
        insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, home_entrant_id, away_entrant_id, status)
        values (${day.comp.stageId}, ${day.comp.divisionId}, ${day.orgId}, ${round}, 1, ${home}, ${away}, ${status})
        returning id`;
      return r!.id;
    };
    let checked = 0;
    for (const [i, status] of uncallable.entries()) {
      const id = await insert(100 + i, p1.id, p2.id, status);
      const err = await refusal(callFixtureToCourt(day.auth, id, day.courts.c1, at(31)));
      expect({ status: err.status, code: err.code, extra: err.extra }, status).toEqual({
        status: 409,
        code: "NOT_CALLABLE",
        extra: { status },
      });
      expect(await callRows(id), status).toEqual([]);
      checked += 1;
    }
    expect(checked, "anti-vacuity: uncallable statuses checked").toBe(domain.length - 1);
    expect(checked).toBeGreaterThanOrEqual(2);

    for (const [i, [home, away]] of (
      [
        [p1.id, null],
        [null, p2.id],
      ] as const
    ).entries()) {
      const id = await insert(200 + i, home, away, "scheduled");
      const err = await refusal(callFixtureToCourt(day.auth, id, day.courts.c1, at(31)));
      expect({ status: err.status, code: err.code, extra: err.extra }).toEqual({
        status: 409,
        code: "NOT_CALLABLE",
        extra: { status: "tbd_entrant" },
      });
      expect(await slotOf(id)).toMatchObject({ court_id: null, scheduled_at: null });
    }
  });

  it("refuses a court that is not the org's, or is archived (404), and writes nothing", async () => {
    const day = await seedDay();
    const { p1, p2 } = pairs(day);
    const f = between(day.comp, p1, p2);
    const elsewhere = await seedDay(); // another org's Court 1
    const foreign = await refusal(callFixtureToCourt(day.auth, f.id, elsewhere.courts.c1, at(31)));
    expect(foreign.status).toBe(404);

    await sql`update courts set archived_at = now() where id = ${day.courts.c3}`;
    const archived = await refusal(callFixtureToCourt(day.auth, f.id, day.courts.c3, at(31)));
    expect(archived.status).toBe(404);

    expect(await callRows(f.id)).toEqual([]);
    expect(await slotOf(f.id)).toMatchObject({ court_id: null, scheduled_at: null });
    await callFixtureToCourt(day.auth, f.id, day.courts.c2, at(31)); // the positive pair: a live court of the org
    expect(await slotOf(f.id)).toMatchObject({ court_id: day.courts.c2 });
  });
});

describe.skipIf(!HAS_DB)("undoCall", () => {
  it("restores the previous court, venue and time exactly — nulls included — and deletes the call", async () => {
    const day = await seedDay();
    const { p1, p2, p3, p4 } = pairs(day);
    const cases = [
      { label: "no court yet", f: between(day.comp, p1, p2), court: null, venue: null, minutes: null, to: day.courts.c1 },
      { label: "on Court 2", f: between(day.comp, p3, p4), court: day.courts.c2, venue: day.venues.hallA, minutes: 120, to: day.courts.c3 },
      { label: "venue only", f: between(day.comp, p1, p3), court: null, venue: day.venues.hallB, minutes: 200, to: day.courts.c1 },
    ];
    let checked = 0;
    for (const c of cases) {
      await sql`
        update fixtures set court_id = ${c.court}, venue_id = ${c.venue},
               scheduled_at = ${c.minutes === null ? null : iso(c.minutes)}
         where id = ${c.f.id}`;
      const before = await slotOf(c.f.id);
      await callFixtureToCourt(day.auth, c.f.id, c.to, at(31));
      expect((await slotOf(c.f.id)).court_id, c.label).toBe(c.to);

      const out = await undoCall(day.auth, c.f.id);

      expect(out, c.label).toEqual({
        fixture_id: c.f.id,
        court_id: c.court,
        scheduled_at: c.minutes === null ? null : iso(c.minutes),
      });
      expect(await slotOf(c.f.id), c.label).toEqual(before);
      expect(before, c.label).toEqual({
        court_id: c.court,
        venue_id: c.venue,
        scheduled_at: c.minutes === null ? null : iso(c.minutes),
        status: "scheduled",
      });
      expect(await callRows(c.f.id), c.label).toEqual([]);
      checked += 1;
    }
    expect(checked, "anti-vacuity: undo cases").toBe(3);
  });

  it("refuses NOT_CALLED on a fixture that was never called, and on a second Undo", async () => {
    const day = await seedDay();
    const { p1, p2 } = pairs(day);
    const f = between(day.comp, p1, p2);
    await place(day, f.id, 120, day.courts.c2);

    const never = await refusal(undoCall(day.auth, f.id));
    expect({ status: never.status, code: never.code }).toEqual({ status: 409, code: "NOT_CALLED" });

    await callFixtureToCourt(day.auth, f.id, day.courts.c1, at(31));
    await undoCall(day.auth, f.id);
    const again = await refusal(undoCall(day.auth, f.id));
    expect({ status: again.status, code: again.code }).toEqual({ status: 409, code: "NOT_CALLED" });
    expect(await slotOf(f.id)).toMatchObject({ court_id: day.courts.c2, scheduled_at: iso(120) });
  });

  it("re-call after Undo works; calling a called match to another court frees the first and keeps the ORIGINAL slot for Undo", async () => {
    const day = await seedDay();
    const { p1, p2, p3, p4 } = pairs(day);
    const f = between(day.comp, p1, p2);
    const x = between(day.comp, p3, p4);
    await place(day, f.id, 120, day.courts.c2);

    await callFixtureToCourt(day.auth, f.id, day.courts.c1, at(31));
    await undoCall(day.auth, f.id);
    await callFixtureToCourt(day.auth, f.id, day.courts.c3, at(35)); // re-call after Undo
    await callFixtureToCourt(day.auth, f.id, day.courts.c1, at(36)); // a no-show on Court 3: called to Court 1 instead

    expect(await slotOf(f.id)).toEqual({
      court_id: day.courts.c1,
      venue_id: day.venues.hallA,
      scheduled_at: iso(36),
      status: "scheduled",
    });
    expect(await callRows(f.id)).toMatchObject([
      { court_id: day.courts.c1, called_at: iso(36), prev_court_id: day.courts.c2, prev_venue_id: day.venues.hallA, prev_scheduled_at: iso(120) },
    ]);
    await callFixtureToCourt(day.auth, x.id, day.courts.c3, at(37)); // Court 3 is free again

    await undoCall(day.auth, f.id);
    expect(await slotOf(f.id)).toEqual({
      court_id: day.courts.c2,
      venue_id: day.venues.hallA,
      scheduled_at: iso(120),
      status: "scheduled",
    });
  });

  it("call → board move → re-call → Undo: the Undo goes back to where the BOARD left the match, not to the slot before the first call", async () => {
    const day = await seedDay();
    const { p1, p2 } = pairs(day);
    const f = between(day.comp, p1, p2);
    await place(day, f.id, 120, day.courts.c2);

    await callFixtureToCourt(day.auth, f.id, day.courts.c1, at(31));
    await moveFixture(day.auth, f.id, { scheduled_at: iso(200), court_id: day.courts.c3 }); // the board ends the call
    await callFixtureToCourt(day.auth, f.id, day.courts.c1, at(40));
    expect(await callRows(f.id)).toMatchObject([
      { court_id: day.courts.c1, called_at: iso(40), prev_court_id: day.courts.c3, prev_venue_id: day.venues.hallB, prev_scheduled_at: iso(200) },
    ]);

    await undoCall(day.auth, f.id);
    expect(await slotOf(f.id)).toEqual({
      court_id: day.courts.c3,
      venue_id: day.venues.hallB,
      scheduled_at: iso(200),
      status: "scheduled",
    });
    expect(await callRows(f.id)).toEqual([]);
  });

  it("refuses NOT_CALLED on a call the board has moved since — to another court, or later on the same one — and leaves the board's edit", async () => {
    const day = await seedDay();
    const { p1, p2, p3, p4 } = pairs(day);
    const cases = [
      { f: between(day.comp, p1, p2), move: { scheduled_at: iso(200), court_id: day.courts.c3 } },
      { f: between(day.comp, p3, p4), move: { scheduled_at: iso(150), court_id: day.courts.c2 } }, // called to Court 2, later there
    ];
    await place(day, cases[0]!.f.id, 120, day.courts.c2);
    await callFixtureToCourt(day.auth, cases[0]!.f.id, day.courts.c1, at(31));
    await callFixtureToCourt(day.auth, cases[1]!.f.id, day.courts.c2, at(32));
    let checked = 0;
    for (const { f, move } of cases) {
      await moveFixture(day.auth, f.id, move);
      const before = await ledgerOf(day.comp.divisionId, f.id);
      const err = await refusal(undoCall(day.auth, f.id));
      expect(err.status).toBe(409);
      expect(err.code).toBe("NOT_CALLED");
      expect(await slotOf(f.id)).toMatchObject({ court_id: move.court_id, scheduled_at: move.scheduled_at });
      expect(await ledgerOf(day.comp.divisionId, f.id)).toEqual(before); // a refusal writes nothing on the ledger
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("refuses NOT_CALLABLE once the called match has started, and leaves it where it is playing", async () => {
    const day = await seedDay();
    const { p1, p2 } = pairs(day);
    const f = between(day.comp, p1, p2);
    await place(day, f.id, 120, day.courts.c2);
    await callFixtureToCourt(day.auth, f.id, day.courts.c1, at(31));
    await setStatus(f.id, "in_play");

    const err = await refusal(undoCall(day.auth, f.id));
    expect({ status: err.status, code: err.code, extra: err.extra }).toEqual({
      status: 409,
      code: "NOT_CALLABLE",
      extra: { status: "in_play" },
    });
    expect(await slotOf(f.id)).toMatchObject({ court_id: day.courts.c1, scheduled_at: iso(31), status: "in_play" });
    expect(await callRows(f.id)).toHaveLength(1);
  });
});

describe.skipIf(!HAS_DB)("a call on the division's ledger", () => {
  it("a call and its Undo each append exactly one schedule_edited (from/to with the venue) and move the division's seq on by one", async () => {
    const day = await seedDay();
    const { p1, p2 } = pairs(day);
    const f = between(day.comp, p1, p2);
    await place(day, f.id, 120, day.courts.c2);
    const before = await ledgerOf(day.comp.divisionId, f.id);
    expect(before.edits).toEqual([]);

    await callFixtureToCourt(day.auth, f.id, day.courts.c3, at(31));
    const called = await ledgerOf(day.comp.divisionId, f.id);
    expect(called.seq).toBe(before.seq + 1);
    expect(called.edits).toEqual([
      {
        seq: before.seq + 1,
        from: { at: iso(120), court: day.courts.c2, venue: day.venues.hallA, locked: false },
        to: { at: iso(31), court: day.courts.c3, venue: day.venues.hallB, locked: false },
      },
    ]);

    await undoCall(day.auth, f.id);
    const undone = await ledgerOf(day.comp.divisionId, f.id);
    expect(undone.seq).toBe(before.seq + 2);
    expect(undone.edits).toEqual([
      called.edits[0],
      {
        seq: before.seq + 2,
        from: { at: iso(31), court: day.courts.c3, venue: day.venues.hallB, locked: false },
        to: { at: iso(120), court: day.courts.c2, venue: day.venues.hallA, locked: false },
      },
    ]);
  });

  it("a board loaded before a call, or before its Undo, is refused as stale (SEQ_CONFLICT) instead of writing over it; a refused call moves nothing", async () => {
    const day = await seedDay();
    const { p1, p2, p3, p4 } = pairs(day);
    const f = between(day.comp, p1, p2);
    const x = between(day.comp, p3, p4);
    await place(day, x.id, 120, day.courts.c2);

    const loaded = (await ledgerOf(day.comp.divisionId, f.id)).seq;
    await callFixtureToCourt(day.auth, f.id, day.courts.c1, at(31));
    await expect(
      moveFixture(day.auth, f.id, { scheduled_at: iso(200), court_id: day.courts.c3, expected_seq: loaded }),
    ).rejects.toMatchObject({ code: "SEQ_CONFLICT" });
    expect(await slotOf(f.id)).toMatchObject({ court_id: day.courts.c1, scheduled_at: iso(31) });

    // A refused call (Court 1 is called) leaves the seq where it was.
    const reloaded = (await ledgerOf(day.comp.divisionId, x.id)).seq;
    expect((await refusal(callFixtureToCourt(day.auth, x.id, day.courts.c1, at(32)))).code).toBe("COURT_BUSY");
    expect((await ledgerOf(day.comp.divisionId, x.id)).seq).toBe(reloaded);

    await undoCall(day.auth, f.id);
    await expect(
      moveFixture(day.auth, x.id, { scheduled_at: iso(150), court_id: day.courts.c2, expected_seq: reloaded }),
    ).rejects.toMatchObject({ code: "SEQ_CONFLICT" });
    const fresh = (await ledgerOf(day.comp.divisionId, x.id)).seq;
    expect(fresh).toBe(reloaded + 1);
    await moveFixture(day.auth, x.id, { scheduled_at: iso(150), court_id: day.courts.c2, expected_seq: fresh });
    expect(await slotOf(x.id)).toMatchObject({ court_id: day.courts.c2, scheduled_at: iso(150) });
  });

  it("is not refused on a frozen division (the freeze guards planning; the day must still run) — the board's own move is", async () => {
    const day = await seedDay();
    const { p1, p2 } = pairs(day);
    const f = between(day.comp, p1, p2);
    await place(day, f.id, 120, day.courts.c2);
    await sql`update divisions set schedule_locked = true where id = ${day.comp.divisionId}`;

    const frozen = await refusal(moveFixture(day.auth, f.id, { scheduled_at: iso(31), court_id: day.courts.c1 }));
    expect(frozen.status).toBe(422);
    expect(frozen.code).toBe("SCHEDULE_LOCKED");

    await callFixtureToCourt(day.auth, f.id, day.courts.c1, at(31));
    expect(await slotOf(f.id)).toMatchObject({ court_id: day.courts.c1, scheduled_at: iso(31) });
    await undoCall(day.auth, f.id);
    expect(await slotOf(f.id)).toMatchObject({ court_id: day.courts.c2, scheduled_at: iso(120) });
  });
});

describe.skipIf(!HAS_DB)("previewCall", () => {
  it("lists the target court's queue pushed later — another competition's planned match included, each at its own division's length — and writes nothing", async () => {
    const day = await seedDay(); // 30-minute matches
    const { p1, p2, p3, p4 } = pairs(day);
    const f = between(day.comp, p1, p2);
    const x1 = between(day.comp, p3, p4);
    const x3 = between(day.comp, p1, p3);
    const other = await seedCompetition(
      day.auth,
      "Club Night",
      [
        [await person(day.orgId, "Zed Zane"), await person(day.orgId, "Yan Yates")],
        [await person(day.orgId, "Xia Xu"), await person(day.orgId, "Wes Wolfe")],
      ],
      { courts: [day.courts.c1], matchMinutes: 45 },
    );
    const y = other.fixtures[0]!;
    await place(day, f.id, 300, day.courts.c2);
    await place(day, x1.id, 45, day.courts.c1);
    await place(day, y.id, 75, day.courts.c1);
    await place(day, x3.id, 125, day.courts.c1);

    const everything = [...day.comp.fixtures, ...other.fixtures];
    const before = await Promise.all(everything.map((o) => slotOf(o.id)));
    const out = await previewCall(day.auth, f.id, day.courts.c1, at(31));

    // §7.1: estimate = max(planned, end of the match before). f runs +31..+61 (30 min); x1 → +61, ends +91; y → +91, ends
    // +136 (ITS division plays 45); x3 planned +125 → +136. At 30 minutes for y, x3 would not move at all.
    expect(out.shifts).toEqual([
      { fixture_id: x1.id, label: labelOf(day.comp, x1), planned_at: iso(45), estimated_at: iso(61) },
      { fixture_id: y.id, label: labelOf(other, y), planned_at: iso(75), estimated_at: iso(91) },
      { fixture_id: x3.id, label: labelOf(day.comp, x3), planned_at: iso(125), estimated_at: iso(136) },
    ]);
    expect(out.warnings).toEqual([{ kind: "pushes_later", count: 3 }]);

    expect(await Promise.all(everything.map((o) => slotOf(o.id)))).toEqual(before);
    expect(everything.length, "anti-vacuity: fixtures compared").toBe(7);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_calls where org_id = ${day.orgId}`;
    expect(n).toBe(0);
  });

  it("gives rest_gap for each player below the division's declared minimum rest — before and after the called match — and none when it declares none", async () => {
    const day = await seedDay({ minRest: 20 });
    const { p1, p2, p3, p4 } = pairs(day);
    const f = between(day.comp, p1, p2); // called at +31, runs to +61
    await place(day, f.id, 300, day.courts.c3);
    await place(day, between(day.comp, p1, p3).id, 70, day.courts.c2); // P1 next: 9 minutes after f ends
    await place(day, between(day.comp, p2, p3).id, 120, day.courts.c2); // P2 next: 59 minutes after — enough
    const prev = between(day.comp, p2, p4); // P2 finished 6 minutes before the call
    await place(day, prev.id, -10, day.courts.c2);
    await setStatus(prev.id, "decided");
    await sql`update fixtures set finished_at = ${iso(25)} where id = ${prev.id}`;
    // P1's match against P4 was CANCELLED two minutes before the call: never played, so it gives P1 no rest to count from.
    const cancelled = between(day.comp, p1, p4);
    await place(day, cancelled.id, 0, day.courts.c3);
    await setStatus(cancelled.id, "cancelled");
    await sql`update fixtures set finished_at = ${iso(29)} where id = ${cancelled.id}`;

    const out = await previewCall(day.auth, f.id, day.courts.c1, at(31));

    const byName = (w: readonly object[]) => [...w].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    expect(byName(out.warnings)).toEqual(
      byName([
        { kind: "rest_gap", person_name: "Ann Archer", minutes: 9, min_rest: 20 },
        { kind: "rest_gap", person_name: "Bob Bell", minutes: 9, min_rest: 20 },
        { kind: "rest_gap", person_name: "Cat Cole", minutes: 6, min_rest: 20 },
        { kind: "rest_gap", person_name: "Dan Dorn", minutes: 6, min_rest: 20 },
      ]),
    );
    expect(out.shifts).toEqual([]);

    // The empty case: a division that declares no minimum rest warns about none.
    await sql`
      update schedule_settings set config = jsonb_set(config, '{perEntrantMinRest}', '0'::jsonb)
       where division_id = ${day.comp.divisionId}`;
    expect(await previewCall(day.auth, f.id, day.courts.c1, at(31))).toEqual({ shifts: [], warnings: [] });
  });

  it("gives past_day_end when the court's queue would run past its declared hours, read in the org's zone", async () => {
    const day = await seedDay();
    const { p1, p2, p3, p4 } = pairs(day);
    const f = between(day.comp, p1, p2);
    const x = between(day.comp, p3, p4);
    await place(day, f.id, 300, day.courts.c2);
    await place(day, x.id, 30, day.courts.c1); // 10:30Z: on its own it ends 11:00Z, exactly at close
    // Court 1 opens 09:00–12:00 on Saturdays, Amsterdam time = 08:00–11:00Z.
    await sql`
      insert into court_hours (court_id, org_id, weekday, open_min, close_min)
      values (${day.courts.c1}, ${day.orgId}, 6, ${9 * 60}, ${12 * 60})`;

    const out = await previewCall(day.auth, f.id, day.courts.c1, at(5)); // f 10:05–10:35Z, x then 10:35–11:05Z

    expect(out.shifts).toEqual([{ fixture_id: x.id, label: labelOf(day.comp, x), planned_at: iso(30), estimated_at: iso(35) }]);
    const sorted = [...out.warnings].sort((a, b) => a.kind.localeCompare(b.kind));
    expect(sorted).toEqual([
      { kind: "past_day_end", court_name: "Court 1", until: "2026-11-07T11:00:00.000Z" },
      { kind: "pushes_later", count: 1 },
    ]);
  });

  it("gives no shifts and no warnings for the court's own next match", async () => {
    const day = await seedDay();
    const { p1, p2, p3, p4 } = pairs(day);
    const f = between(day.comp, p1, p2);
    await place(day, f.id, 45, day.courts.c1); // Court 1's own next match, called early at +31
    await place(day, between(day.comp, p3, p4).id, 90, day.courts.c1); // f ends +61, before it
    // Not today's queue: a match left unstarted on Court 1 YESTERDAY (it would read as pushed to +61), and one planned there
    // TOMORROW at 23:30 Amsterdam (the queue would then run past the day's end).
    await place(day, between(day.comp, p1, p3).id, -24 * 60, day.courts.c1);
    await place(day, between(day.comp, p2, p4).id, 36 * 60 + 30, day.courts.c1);

    expect(await previewCall(day.auth, f.id, day.courts.c1, at(31))).toEqual({ shifts: [], warnings: [] });
  });
});
