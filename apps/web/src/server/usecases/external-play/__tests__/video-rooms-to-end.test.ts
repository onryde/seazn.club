// D16 fix-2, review residual 2: a meeting row is the only thing that tracks an ACTIVE vendor room, and it cascades away with its
// fixture. Four writes delete fixtures (a stage delete, Rebuild fixtures, a Swiss round reshaped to a smaller field, an undo of a
// generation) and each used to leave up to two rooms per board ACTIVE, with live player tokens, that nothing could find.
// V460's trigger parks an un-ended room in `video_rooms_to_end` in the deleting transaction; the sweep ends each parked room and
// deletes its row only after the end succeeded. Every test below drives the REAL usecase, then the REAL sweep.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { RealtimeKitDeferred, RealtimeKitError } from "@/server/external-play/video/realtimekit";
import { sweepExternalPlay, type SweepDeps } from "../sweep";
import { withdrawEntrantCascade } from "../../withdrawal";
import { undoDivision } from "../../history";
import { deleteStage, generateStageFixtures, rebuildStageFixtures, unpairSwissRound } from "../../stages";
import { deleteCompetition } from "../../competitions";
import { deleteDivision } from "../../divisions";
import {
  putVideoMeeting,
  putVideoParticipant,
  seedOnlineChessRound,
  seedOnlineSwiss,
  type SeedOnlineChessRoundResult,
  type VideoSide,
} from "../../__tests__/_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;
const SIDES: readonly VideoSide[] = ["home", "away"];

afterAll(async () => {
  await sql.end({ timeout: 5 }).catch(() => undefined);
});

type Parked = { meeting_id: string; fixture_id: string; side: string };
const parkedFor = (orgId: string) =>
  sql<Parked[]>`select meeting_id, fixture_id, side from video_rooms_to_end where org_id = ${orgId} order by meeting_id`;
const rowsLeft = async (fixtureIds: readonly string[]) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from fixture_video_meetings where fixture_id in ${sql(fixtureIds as string[])}`)[0]!.n;

/** Both players' rooms on a board: a meeting each, and a player in it (mid check-in: the seat waits on the camera). */
async function seatedBoard(orgId: string, fixtureId: string, personIds: readonly [string, string]) {
  const rooms: string[] = [];
  for (const [i, side] of SIDES.entries()) {
    rooms.push(await putVideoMeeting({ fixtureId, orgId, side }));
    await putVideoParticipant({ fixtureId, side, personId: personIds[i]! });
  }
  return rooms;
}

/** The REAL sweep, scoped to the org; `endMeeting` records what it was asked to end (the vendor is not the subject here). */
async function sweepOrg(orgId: string, over: Partial<SweepDeps> = {}) {
  const ended: string[] = [];
  const report = await sweepExternalPlay({
    orgIds: [orgId],
    serialise: false,
    // What the real endMeeting leaves behind besides the vendor calls: the row stamped ended (so a later delete of it parks nothing).
    endMeeting: async (id) => {
      ended.push(id);
      await sql`update fixture_video_meetings set ended_at = now() where meeting_id = ${id} and ended_at is null`;
    },
    ...over,
  });
  return { ended, report };
}

describe.skipIf(!HAS_DB)("a room whose meeting row cascades away with its fixture is parked, then ended by the sweep", () => {
  describe("the trigger itself (V460)", () => {
    it("parks an un-ended room when its row is deleted - both players' rooms, with the board and the side - and an ENDED room parks nothing", async () => {
      const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 2 });
      const [a, b] = r.boards;
      const live = await seatedBoard(r.orgId, a!.fixtureId, [a!.home.personId, a!.away.personId]);
      const closedHome = await putVideoMeeting({ fixtureId: b!.fixtureId, orgId: r.orgId, side: "home" }, { endedAt: new Date() });
      const liveAway = await putVideoMeeting({ fixtureId: b!.fixtureId, orgId: r.orgId, side: "away" });
      expect(await parkedFor(r.orgId), "premise: nothing parked while the rows stand").toEqual([]);
      await sql`delete from fixture_video_meetings where fixture_id in ${sql([a!.fixtureId, b!.fixtureId])}`;
      const parked = await parkedFor(r.orgId);
      expect(parked.map((p) => p.meeting_id).sort(), "the three un-ended rooms, never the ended one").toEqual([...live, liveAway].sort());
      expect(parked.map((p) => p.meeting_id)).not.toContain(closedHome);
      expect(parked.map((p) => [p.fixture_id, p.side]).sort()).toEqual(
        [[a!.fixtureId, "home"], [a!.fixtureId, "away"], [b!.fixtureId, "away"]].sort(),
      );
      await sql`delete from video_rooms_to_end where org_id = ${r.orgId}`; // the rows were never ended: leave none for another file's pass
    });

    it("carries no foreign key: an organisation delete cascades to the very rows that fire it, and must not be refused by the parked row", async () => {
      const [fks] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_constraint where conrelid = 'video_rooms_to_end'::regclass and contype = 'f'`;
      expect(fks!.n).toBe(0);
    });
  });

  describe("each path that deletes fixtures, through its real usecase", () => {
    it("deleteStage: the stage's boards go, and both players' rooms of every board are parked - then the sweep ends each once and clears the parking", async () => {
      const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 2 });
      const rooms = (await Promise.all(r.boards.map((b) => seatedBoard(r.orgId, b.fixtureId, [b.home.personId, b.away.personId])))).flat();
      expect(rooms, "premise: two boards, a room per player").toHaveLength(4);
      await deleteStage(r.owner, r.stageId);
      expect(await rowsLeft(r.boards.map((b) => b.fixtureId)), "the rows went with their fixtures").toBe(0);
      expect((await parkedFor(r.orgId)).map((p) => p.meeting_id).sort(), "every room is parked").toEqual([...rooms].sort());
      const { ended, report } = await sweepOrg(r.orgId);
      expect([...ended].sort(), "each room ended, once").toEqual([...rooms].sort());
      expect(report.meetingsEnded).toBe(4);
      expect(await parkedFor(r.orgId), "and the parking is cleared").toEqual([]);
      expect((await sweepOrg(r.orgId)).ended, "a second pass ends nothing again").toEqual([]);
    });

    it("Rebuild fixtures mid-check-in: players in their rooms, the stage rebuilt - the old boards' rooms are parked and ended, the rebuilt boards keep none", async () => {
      const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 2 });
      const rooms = (await Promise.all(r.boards.map((b) => seatedBoard(r.orgId, b.fixtureId, [b.home.personId, b.away.personId])))).flat();
      const out = await rebuildStageFixtures(r.owner, r.stageId);
      expect(out.removed, "premise: the rebuild deleted the boards").toBeGreaterThan(0);
      expect(await rowsLeft(r.boards.map((b) => b.fixtureId))).toBe(0);
      expect((await parkedFor(r.orgId)).map((p) => p.meeting_id).sort()).toEqual([...rooms].sort());
      const { ended } = await sweepOrg(r.orgId);
      expect([...ended].sort()).toEqual([...rooms].sort());
      expect(await parkedFor(r.orgId)).toEqual([]);
    });

    it("a Swiss round reshaped to a smaller field (an unpaired, game-less round after a withdrawal): the surplus board's rooms are parked and ended; the surviving board's are not", async () => {
      const s = await seedOnlineSwiss({ players: 4, pairing: "fold", cameraPolicy: "optional" });
      const round = await sql<{ id: string; seq_in_round: number; home_entrant_id: string | null; away_entrant_id: string | null }[]>`
        select id, seq_in_round, home_entrant_id, away_entrant_id from fixtures
         where stage_id = ${s.stageId} and round_no = 1 and ext_key not like '%-bye' order by seq_in_round`;
      expect(round, "premise: two boards in round 1").toHaveLength(2);
      const personOf = new Map(s.players.map((p) => [p.entrantId, p.personId]));
      const [keep, surplus] = round;
      const surplusRooms = await seatedBoard(s.orgId, surplus!.id, [personOf.get(surplus!.home_entrant_id!)!, personOf.get(surplus!.away_entrant_id!)!]);
      const keepRooms = await seatedBoard(s.orgId, keep!.id, [personOf.get(keep!.home_entrant_id!)!, personOf.get(keep!.away_entrant_id!)!]);
      await unpairSwissRound(s.owner, s.stageId);
      // A player leaves, so the field is three: one board and a bye. The re-Pair reshapes round 1 and deletes the surplus board.
      await withdrawEntrantCascade(s.owner, surplus!.away_entrant_id!);
      await generateStageFixtures(s.owner, s.stageId, { pairing: "fold" });
      const left = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${s.stageId} and round_no = 1 and id in ${sql([keep!.id, surplus!.id])}`;
      expect(left.map((f) => f.id), "premise: the surplus board was deleted and the first survived").toEqual([keep!.id]);
      expect((await parkedFor(s.orgId)).map((p) => p.meeting_id).sort(), "the deleted board's two rooms, and only those").toEqual([...surplusRooms].sort());
      const parkedIds = (await parkedFor(s.orgId)).map((p) => p.meeting_id);
      expect(keepRooms.filter((id) => parkedIds.includes(id)), "none of the surviving board's rooms is parked").toEqual([]);
      const { ended } = await sweepOrg(s.orgId);
      // The pass's other jobs may end the surviving board's rooms for their own reasons (its pairing changed with the field): what
      // is asserted is that each parked room was ended exactly once, and the parking is cleared.
      expect(surplusRooms.map((id) => ended.filter((e) => e === id).length)).toEqual([1, 1]);
      expect(await parkedFor(s.orgId)).toEqual([]);
    });

    it("Undo of a generation: the generated boards go, and both players' rooms of each are parked and ended", async () => {
      const r: SeedOnlineChessRoundResult = await seedOnlineChessRound({ roundNo: 1, fixtures: 2 });
      await generateStageFixtures(r.owner, r.stageId);
      const generated = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`
        select id, home_entrant_id, away_entrant_id from fixtures
         where stage_id = ${r.stageId} and ext_key not like 't19-%' and home_entrant_id is not null and away_entrant_id is not null`;
      expect(generated.length, "premise: the generation made boards of its own").toBeGreaterThan(0);
      const personOf = new Map(r.boards.flatMap((b) => [[b.home.entrantId, b.home.personId], [b.away.entrantId, b.away.personId]] as const));
      const rooms = (
        await Promise.all(generated.slice(0, 2).map((f) => seatedBoard(r.orgId, f.id, [personOf.get(f.home_entrant_id)!, personOf.get(f.away_entrant_id)!])))
      ).flat();
      await undoDivision(r.owner, r.divisionId);
      expect(await rowsLeft(generated.map((f) => f.id)), "the undo deleted the generated boards").toBe(0);
      expect((await parkedFor(r.orgId)).map((p) => p.meeting_id).sort()).toEqual([...rooms].sort());
      const { ended } = await sweepOrg(r.orgId);
      expect([...ended].sort()).toEqual([...rooms].sort());
      expect(await parkedFor(r.orgId)).toEqual([]);
    });
  });

  describe("wider cascades park the same rooms, with no call-site change", () => {
    it("deleteDivision and deleteCompetition: the boards below go, and every un-ended room of them is parked", async () => {
      for (const del of [
        (r: SeedOnlineChessRoundResult) => deleteDivision(r.owner, r.divisionId),
        (r: SeedOnlineChessRoundResult) => deleteCompetition(r.owner, r.competitionId),
      ]) {
        // Not started: a started division is archived, never deleted (divisions.ts), so only this one reaches the delete.
        const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1, divisionStarted: false });
        const [b] = r.boards;
        const rooms = await seatedBoard(r.orgId, b!.fixtureId, [b!.home.personId, b!.away.personId]);
        await del(r);
        expect(await rowsLeft([b!.fixtureId]), "premise: the board's rows went with it").toBe(0);
        expect((await parkedFor(r.orgId)).map((p) => p.meeting_id).sort()).toEqual([...rooms].sort());
      }
    });

    it("deleting the ORGANISATION is not refused by the parked row (no foreign key to it), and the parked rooms outlive it for the sweep", async () => {
      const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
      const [b] = r.boards;
      const rooms = await seatedBoard(r.orgId, b!.fixtureId, [b!.home.personId, b!.away.personId]);
      await sql`delete from organizations where id = ${r.orgId}`;
      expect((await parkedFor(r.orgId)).map((p) => p.meeting_id).sort()).toEqual([...rooms].sort());
      const { ended } = await sweepOrg(r.orgId);
      expect([...ended].sort()).toEqual([...rooms].sort());
      expect(await parkedFor(r.orgId)).toEqual([]);
    });
  });

  describe("the sweep ends a parked room, and keeps it until the end succeeded", () => {
    async function parkedBoard() {
      const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
      const [b] = r.boards;
      const rooms = await seatedBoard(r.orgId, b!.fixtureId, [b!.home.personId, b!.away.personId]);
      await deleteStage(r.owner, r.stageId);
      return { r, rooms };
    }

    it("a FAILED end keeps the parked row and is reported; the room that could be ended is cleared; the next pass finishes it", async () => {
      const { r, rooms } = await parkedBoard();
      const [first, second] = [...rooms].sort();
      const flaky: NonNullable<SweepDeps["endMeeting"]> = async (id) => {
        if (id === first) throw new RealtimeKitError(503, "unavailable", "vendor down");
      };
      const pass1 = await sweepOrg(r.orgId, { endMeeting: flaky });
      expect(pass1.report.failures.filter((f) => f.job === "teardown").map((f) => f.code)).toEqual(["unavailable"]);
      expect((await parkedFor(r.orgId)).map((p) => p.meeting_id), "only the refused room stays parked").toEqual([first]);
      expect(pass1.report.meetingsEnded, `the other room (${second}) was ended`).toBe(1);
      const pass2 = await sweepOrg(r.orgId);
      expect(pass2.ended).toEqual([first]);
      expect(await parkedFor(r.orgId)).toEqual([]);
    });

    it("a DEFERRED end (the platform's call budget) keeps every parked room and counts a deferral, never a failure; with the budget back they go", async () => {
      const { r, rooms } = await parkedBoard();
      const refused = await sweepOrg(r.orgId, {
        endMeeting: async () => {
          throw new RealtimeKitDeferred("budget spent");
        },
      });
      expect([refused.report.deferred, refused.report.failures.length, refused.report.meetingsEnded]).toEqual([rooms.length, 0, 0]);
      expect((await parkedFor(r.orgId)).map((p) => p.meeting_id).sort()).toEqual([...rooms].sort());
      const back = await sweepOrg(r.orgId);
      expect([...back.ended].sort()).toEqual([...rooms].sort());
      expect(await parkedFor(r.orgId)).toEqual([]);
    });

    it("a room RealtimeKit itself says is not there (its documented not-found) is already gone: the parking is cleared without a count", async () => {
      const { r, rooms } = await parkedBoard();
      const report = (
        await sweepOrg(r.orgId, {
          endMeeting: async () => {
            throw new RealtimeKitError(404, "not_found", "no such meeting");
          },
        })
      ).report;
      expect([report.meetingsEnded, report.failures.length]).toEqual([0, 0]);
      expect(rooms.length).toBeGreaterThan(0);
      expect(await parkedFor(r.orgId)).toEqual([]);
    });

    it("the sweep's org scope holds: another organisation's parked rooms are not touched by this one's pass", async () => {
      const mine = await parkedBoard();
      const theirs = await parkedBoard();
      const { ended } = await sweepOrg(mine.r.orgId);
      expect([...ended].sort()).toEqual([...mine.rooms].sort());
      expect((await parkedFor(theirs.r.orgId)).map((p) => p.meeting_id).sort(), "theirs still parked").toEqual([...theirs.rooms].sort());
      await sweepOrg(theirs.r.orgId);
      expect(await parkedFor(theirs.r.orgId)).toEqual([]);
    });
  });
});
