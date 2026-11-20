// Match Day online (Task 2): the SETUP of the tests that read an online chess round into Match Day. Each helper writes the rows the
// product's own writer would leave, and says which writer it stands for; the assertions of a test never read these back.
//
//   - `openStamp`      the `stage_round_opens` row `openRound` stamps (the invites are not sent: the tests that need the real
//                      open - a link hold at the first open - call `openRound` itself);
//   - `bridgeRow`      the `fixture_external_play` row create (T9) and the moves (T10) leave, or the hold row `openRound` writes;
//   - `addRound`       more boards of a seeded round, between the SAME entrants (a league's players meet again each round);
//   - `addStage`       a second stage of the division with its own paired round;
//   - `arrived`        one side's player came: its room, its player participant, its counted check-in (what the player's first
//                      claim writes);
//   - `presenceRow`    a webhook presence row of that player;
//   - `openFlag`       an open `fixture_play_flags` row, as the sweep's job 5 or the reconcile leaves it;
//   - `seedOnlineDivisionIn`  a started online chess division INSIDE an existing competition (the in-hall competition of
//                      `_match-day-seed.ts`'s `seedDay`), so one competition holds both kinds of division;
//   - `setFixtureStatus`      the fixture row's own status, as the engine's fold leaves it.
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { stampFixtureCheckIn } from "../me";
import { startDivision } from "../schedule";
import { createStages } from "../stages";
import {
  putVideoMeeting,
  putVideoParticipant,
  seedBoardgameSport,
  seedPlayer,
  type SeedOnlineChessRoundResult,
  type SeedRoundBoard,
  type SeedSide,
  type VideoSide,
} from "./_external-play-seed";

/** The day every Match Day online test reads at: a Thursday, noon UTC (the seeded organisation has no zone, so its day is UTC). */
export const NOW = new Date("2026-11-19T12:00:00.000Z");
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
/** `n` minutes after NOW (negative: before). */
export const at = (minutes: number): Date => new Date(NOW.getTime() + minutes * MIN);

export async function openStamp(r: Pick<SeedOnlineChessRoundResult, "stageId" | "orgId" | "ownerUserId">, roundNo: number, openedAt: Date, stageId = r.stageId): Promise<void> {
  await sql`
    insert into stage_round_opens (stage_id, org_id, round_no, opened_at, opened_by)
    values (${stageId}, ${r.orgId}, ${roundNo}, ${openedAt}, ${r.ownerUserId})`;
}

type Bridge = { status: "pending" | "ready" | "live" | "needs_organiser" | "finished"; moves?: number; reason?: string | null };

/** A bridge row. `pending` has no game; any other status has one (a challenge, the colours' accounts), as create leaves it. A
 *  `needs_organiser` row with no moves and a null challenge is the HOLD row `openRound` writes for a link hold (open-round.ts), so
 *  `held` passes `{ status: "needs_organiser", reason, hold: true }`. */
export async function bridgeRow(fixtureId: string, orgId: string, b: Bridge & { hold?: boolean }, basis: Date = NOW): Promise<void> {
  const moves = Array.from({ length: b.moves ?? 0 }, (_, i) => (i % 2 === 0 ? "g1f3" : "g8f6"));
  const game = b.status !== "pending" && b.hold !== true;
  await sql`
    insert into fixture_external_play (
      fixture_id, org_id, status, needs_reason, scheduled_at_basis, challenge_id, white_side, white_lichess_id,
      black_lichess_id, moves_uci, move_count, started_at, last_move_at, white_ms, black_ms, clock_increment_s)
    values (
      ${fixtureId}, ${orgId}, ${b.status}, ${b.reason ?? null}, ${basis},
      ${game ? `g${randomUUID().slice(0, 7)}` : null}, ${game ? "home" : null},
      ${game ? "w-acc" : null}, ${game ? "b-acc" : null},
      ${sql.json(moves)}, ${moves.length},
      ${moves.length > 0 ? basis : null}, ${moves.length > 0 ? basis : null},
      ${moves.length > 0 ? 185_000 : null}, ${moves.length > 0 ? 257_000 : null},
      ${moves.length > 0 ? 10 : null})`;
}

/** More boards of round `roundNo` between the entrants of `pairs` (an entrant may sit in every round of a league). */
export async function addRound(
  r: Pick<SeedOnlineChessRoundResult, "stageId" | "divisionId" | "orgId">,
  roundNo: number,
  pairs: readonly { home: SeedSide; away: SeedSide }[],
  stageId = r.stageId,
): Promise<string[]> {
  const ids: string[] = [];
  let seq = 0;
  for (const p of pairs) {
    seq += 1;
    const [row] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status, home_entrant_id, away_entrant_id, scheduled_at)
      values (${stageId}, ${r.divisionId}, ${r.orgId}, ${roundNo}, ${seq}, ${`md2-${randomUUID().slice(0, 8)}`}, 'scheduled',
              ${p.home.entrantId}, ${p.away.entrantId}, ${at(-30)})
      returning id`;
    ids.push(row!.id);
  }
  return ids;
}

/** A second stage (`seq` 2) of the seeded division with one paired board in round 1 (new entrants), never opened. Call BEFORE the
 *  division starts: `createStages` is the product's own door and refuses a started division. */
export async function addStage(
  r: Pick<SeedOnlineChessRoundResult, "owner" | "divisionId" | "orgId">,
  name: string,
  pair: { home: SeedSide; away: SeedSide },
): Promise<{ stageId: string; fixtureId: string }> {
  const [stage] = await createStages(r.owner, r.divisionId, { seq: 2, kind: "league", name, config: {} });
  const [row] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status, home_entrant_id, away_entrant_id, scheduled_at)
    values (${stage!.id}, ${r.divisionId}, ${r.orgId}, 1, 1, ${`md2-s2-${randomUUID().slice(0, 8)}`}, 'scheduled',
            ${pair.home.entrantId}, ${pair.away.entrantId}, ${at(-30)})
    returning id`;
  return { stageId: stage!.id, fixtureId: row!.id };
}

/** One side's player has come to the board: the room (made for the board's current pairing), the player participant and a check-in
 *  stamped inside the round's window (`checkedInAt`, default: a minute after the open). The side is then OPEN to an arbiter with
 *  the presence-proof flag off: a player participant on file and a counted check-in. `camera` is the player's last browser-reported
 *  camera state (what the room's report writes). */
export async function arrived(
  b: SeedRoundBoard,
  orgId: string,
  side: VideoSide,
  checkedInAt: Date,
  camera?: { state: "live" | "off"; at: Date },
): Promise<string> {
  const player = side === "home" ? b.home : b.away;
  await putVideoMeeting({ fixtureId: b.fixtureId, orgId, side });
  const participantId = await putVideoParticipant({ fixtureId: b.fixtureId, side, personId: player.personId }, { report: camera ?? null });
  await stampFixtureCheckIn(player.personId, b.fixtureId, orgId, { at: checkedInAt });
  return participantId;
}

/** A webhook presence row of the side's player, open unless `leftAt`. */
export async function presenceRow(
  b: SeedRoundBoard,
  side: VideoSide,
  participantId: string,
  o: { joinedAt: Date; leftAt?: Date | null },
): Promise<void> {
  const player = side === "home" ? b.home : b.away;
  const [m] = await sql<{ meetingId: string }[]>`select meeting_id as "meetingId" from fixture_video_meetings where fixture_id = ${b.fixtureId} and side = ${side}`;
  await sql`
    insert into fixture_video_presence (meeting_id, peer_id, fixture_id, side, participant_id, custom_participant_id, joined_at, left_at, left_by, source, received_at)
    values (${m!.meetingId}, ${`peer-${randomUUID().slice(0, 8)}`}, ${b.fixtureId}, ${side}, ${participantId}, ${player.personId}, ${o.joinedAt},
            ${o.leftAt ?? null}, ${o.leftAt ? "left" : null}, 'webhook', ${o.joinedAt})`;
}

/** An OPEN flag on the fixture (`opened_at` at `openedAt`); returns its id. `out_of_band_play` unless said otherwise (its note is the
 *  reconcile's JSON of plies); a `camera_connection_problems` flag names a player and is judged over the board's window. */
export async function openFlag(
  orgId: string,
  fixtureId: string,
  o: { kind?: "out_of_band_play" | "camera_lost" | "camera_connection_problems" | "multiple_devices"; personId?: string; openedAt?: Date; note?: string } = {},
): Promise<string> {
  const kind = o.kind ?? "out_of_band_play";
  const note = o.note ?? (kind === "out_of_band_play" ? JSON.stringify({ plies: [3] }) : "x");
  const [row] = await sql<{ id: string }[]>`
    insert into fixture_play_flags (org_id, fixture_id, kind, person_id, opened_at, note)
    values (${orgId}, ${fixtureId}, ${kind}, ${o.personId ?? null}, ${o.openedAt ?? NOW}, ${note})
    returning id`;
  return row!.id;
}

export async function setFixtureStatus(fixtureId: string, status: string): Promise<void> {
  await sql`update fixtures set status = ${status} where id = ${fixtureId}`;
}

/** A started online chess division inside the competition `competitionId` (the same building blocks as `seedOnlineChessRound`, which
 *  makes a competition of its own): `fixtures` boards of round 1 of one league stage with no planned time, every player linked to Lichess. */
export async function seedOnlineDivisionIn(
  owner: AuthCtx,
  competitionId: string,
  o: { name: string; fixtures: number },
): Promise<{ divisionId: string; stageId: string; boards: SeedRoundBoard[] }> {
  await seedBoardgameSport();
  const division = await createDivision(owner, competitionId, {
    name: o.name,
    sport_key: "boardgame",
    variant_key: "classical",
    config: { variant: "classical", onlinePlay: "lichess", clock: { base: 900, increment: 10 } },
  });
  const [stage] = await createStages(owner, division.id, { seq: 1, kind: "league", name: "RR", config: {} });
  const side = async (name: string): Promise<SeedSide> => {
    const lichessId = `md-${randomUUID().slice(0, 10)}`;
    const p = await seedPlayer(owner.orgId, name, lichessId, true);
    const [e] = await createEntrants(owner, division.id, [
      { display_name: name, kind: "individual", members: [{ person_id: p.personId, is_captain: false, roles: [] }] },
    ]);
    const [u] = await sql<{ email: string }[]>`select email from users where id = ${p.userId}`;
    return { ...p, entrantId: e!.id, email: u!.email };
  };
  const boards: SeedRoundBoard[] = [];
  for (let i = 0; i < o.fixtures; i++) {
    const home = await side(`${o.name} ${i + 1}W`);
    const away = await side(`${o.name} ${i + 1}B`);
    const [row] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status, home_entrant_id, away_entrant_id, scheduled_at)
      values (${stage!.id}, ${division.id}, ${owner.orgId}, 1, ${i + 1}, ${`md2-${randomUUID().slice(0, 8)}`}, 'scheduled',
              ${home.entrantId}, ${away.entrantId}, null)
      returning id`;
    boards.push({ fixtureId: row!.id, home, away });
  }
  await startDivision(owner, division.id);
  // The boards are SQL rows, so nothing generated the stage's fixtures and activated it the way `generateStageFixtures` does: a started
  // division's stage is active, and the no-court list (an active stage, both seats filled) reads it.
  await sql`update stages set status = 'active' where id = ${stage!.id}`;
  return { divisionId: division.id, stageId: stage!.id, boards };
}
