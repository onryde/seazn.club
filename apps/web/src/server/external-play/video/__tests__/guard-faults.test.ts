// D16 (design §5.6.6) - a guard fault is a PLAYER's, in THEIR meeting. Each player has a meeting of their own, so the key of a
// fault is `(fixture_id, side, person_id)` and the four operations - open, close, "is one open", the spans on file - act on
// exactly that seat. The shared-meeting shape keyed a fault by `(fixture_id, person_id)`; a board has two meetings now, and a
// statement that forgot the side would count, close or report the other player's gap.
//
// Every check below is a PAIR: the seat that owns the fault sees it, and the same person on the board's OTHER side does not.
// (A person plays one side of a board in production; the pair is what proves the SIDE is in the key and not only the person.)
// The source guard (video-per-player-source-guard.test.ts) keeps the statements side-keyed; this test shows what the key does.
// Anti-vacuity: the cap sweep reports how many stamps it wrote and the checks report how many seats they judged.
// Single-sport reason: no sport is involved - these are camera rows on a fixture.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { seedOnlineChessFixture } from "../../../usecases/__tests__/_external-play-seed";
import {
  closeGuardFault,
  GUARD_FAULT_MAX_STAMPS,
  guardFaultSpans,
  hasOpenGuardFault,
  openGuardFault,
} from "../guard-faults";

const DB = !!process.env.DATABASE_URL;

type Side = "home" | "away";
const AT = new Date("2026-10-15T10:00:00.000Z");
const at = (secs: number) => new Date(AT.getTime() + secs * 1000);

describe.skipIf(!DB)("guard faults are per seat: (fixture, side, person) (D16)", () => {
  let fixtureId = "";
  let home = "";
  let away = "";

  /** A person on the board's other side than `side`'s - the same person is never on both in production, so this is the seat
   *  that differs from `side`'s ONLY in the side when the person is held fixed (see `seat`). */
  const seat = (side: Side, personId: string) => ({ fixtureId, side, personId });

  beforeAll(async () => {
    const s = await seedOnlineChessFixture({ onlinePlay: "lichess", divisionStarted: true, linked: true, scheduledAt: new Date(Date.now() + 3_600_000) });
    fixtureId = s.fixtureId;
    home = s.home.personId;
    away = s.away.personId;
    // A meeting row for each side (a fault references `(fixture_id, side)`), by SQL - no vendor is involved.
    for (const side of ["home", "away"] as const) {
      await sql`
        insert into fixture_video_meetings (fixture_id, side, org_id, meeting_id, home_entrant_id, away_entrant_id)
        select id, ${side}, org_id, ${`gf-${side}-${fixtureId}`}, home_entrant_id, away_entrant_id from fixtures where id = ${fixtureId}`;
    }
  });
  afterAll(async () => {
    if (DB) await sql.end({ timeout: 2 }).catch(() => undefined);
  });

  it("a fault opened for one seat is open for THAT seat only - the same person asked on the other side's meeting sees none", async () => {
    expect((await openGuardFault(sql, { ...seat("home", home), at: at(0) })).outcome).toBe("opened");
    let judged = 0;
    expect(await hasOpenGuardFault(sql, seat("home", home)), "the owner sees it").toBe(true);
    judged += 1;
    expect(await hasOpenGuardFault(sql, seat("away", home)), "the same person, the other side's meeting: nothing").toBe(false);
    judged += 1;
    expect(await hasOpenGuardFault(sql, seat("away", away)), "the opponent: nothing").toBe(false);
    judged += 1;
    expect(judged, "anti-vacuity: three seats judged").toBe(3);
    expect((await guardFaultSpans(sql, seat("home", home))).length, "the owner's spans").toBe(1);
    expect((await guardFaultSpans(sql, seat("away", home))).length, "the other side's spans for the same person").toBe(0);
    // Close the other side's: nothing was open there, so nothing closes, and ours stays open.
    expect(await closeGuardFault(sql, { ...seat("away", home), at: at(5) }), "closing the other side's seat closes nothing").toBe(false);
    expect(await hasOpenGuardFault(sql, seat("home", home)), "and ours is still open").toBe(true);
    expect(await closeGuardFault(sql, { ...seat("home", home), at: at(10) }), "the owner closes it").toBe(true);
    expect(await hasOpenGuardFault(sql, seat("home", home))).toBe(false);
  });

  it("one open fault per SEAT: a second open on the same seat is open_already, and the other side's seat opens its own", async () => {
    const f = await seedOnlineChessFixture({ onlinePlay: "lichess", divisionStarted: true, linked: true, scheduledAt: new Date(Date.now() + 3_600_000) });
    for (const side of ["home", "away"] as const) {
      await sql`
        insert into fixture_video_meetings (fixture_id, side, org_id, meeting_id, home_entrant_id, away_entrant_id)
        select id, ${side}, org_id, ${`gf2-${side}-${f.fixtureId}`}, home_entrant_id, away_entrant_id from fixtures where id = ${f.fixtureId}`;
    }
    const mine = { fixtureId: f.fixtureId, side: "home" as const, personId: f.home.personId };
    const theirs = { fixtureId: f.fixtureId, side: "away" as const, personId: f.away.personId };
    expect((await openGuardFault(sql, { ...mine, at: at(0) })).outcome).toBe("opened");
    expect((await openGuardFault(sql, { ...mine, at: at(1) })).outcome, "the same seat again").toBe("open_already");
    expect((await openGuardFault(sql, { ...theirs, at: at(2) })).outcome, "the other seat is its own fault").toBe("opened");
    const open = await sql<{ side: string; person_id: string }[]>`
      select side, person_id from fixture_video_guard_faults where fixture_id = ${f.fixtureId} and ended_at is null order by side`;
    expect(open.map((r) => [r.side, r.person_id]), "two open faults, one per seat").toEqual([["away", f.away.personId], ["home", f.home.personId]]);
  });

  it("the cap counts a seat's OWN stamps: a seat that filled it is capped, and the same person on the other side's meeting is not", async () => {
    const f = await seedOnlineChessFixture({ onlinePlay: "lichess", divisionStarted: true, linked: true, scheduledAt: new Date(Date.now() + 3_600_000) });
    for (const side of ["home", "away"] as const) {
      await sql`
        insert into fixture_video_meetings (fixture_id, side, org_id, meeting_id, home_entrant_id, away_entrant_id)
        select id, ${side}, org_id, ${`gf3-${side}-${f.fixtureId}`}, home_entrant_id, away_entrant_id from fixtures where id = ${f.fixtureId}`;
    }
    const full = { fixtureId: f.fixtureId, side: "home" as const, personId: f.home.personId };
    let stamped = 0;
    for (let i = 0; i < GUARD_FAULT_MAX_STAMPS; i += 1) {
      expect((await openGuardFault(sql, { ...full, at: at(i * 10) })).outcome, `stamp ${i + 1}`).toBe("opened");
      expect(await closeGuardFault(sql, { ...full, at: at(i * 10 + 5) })).toBe(true);
      stamped += 1;
    }
    expect(stamped, "anti-vacuity: the cap's worth of stamps was written").toBe(GUARD_FAULT_MAX_STAMPS);
    const capped = await openGuardFault(sql, { ...full, at: at(10_000) });
    expect(capped, "the seat that filled the cap is capped").toEqual({ outcome: "capped", stamps: GUARD_FAULT_MAX_STAMPS });
    // The same person, the other side's meeting: its stamps are its own - none yet, so the first one opens.
    const other = await openGuardFault(sql, { fixtureId: f.fixtureId, side: "away", personId: f.home.personId, at: at(10_001) });
    expect(other, "the other side's seat has no stamps on file").toEqual({ outcome: "opened", stamps: 1 });
    expect((await guardFaultSpans(sql, full)).length, "the capped seat's spans are exactly its own").toBe(GUARD_FAULT_MAX_STAMPS);
  });
});
