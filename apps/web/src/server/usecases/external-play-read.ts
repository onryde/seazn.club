import "server-only";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { PublicExternalPlay, PublicWatch, PublicWatchDoc } from "@/server/external-play/public-view";
import { roundOpenFor } from "@/server/external-play/round-open";
import { fenAfter } from "./external-play/play";

type PublicBridgeRow = {
  status: PublicExternalPlay["status"];
  challenge_id: string | null;
  white_side: "home" | "away" | null;
  moves_uci: string[];
  move_count: number;
  white_ms: number | null;
  black_ms: number | null;
  last_move_at: Date | null;
};

/** The view-only board from the move ledger (T10 writes it, V436), or null
 *  when no game exists at Lichess yet. The position is the ledger replayed
 *  from the start; a ledger chess.js cannot replay in full shows the plies it
 *  could (the room's reconcile repairs the ledger — a spectator never sees a
 *  last move the board does not show). */
export function watchFromLedger(row: PublicBridgeRow): PublicWatch | null {
  if (row.challenge_id === null) return null;
  const { fen, replayed } = fenAfter(row.moves_uci);
  const over = row.status === "finished";
  return {
    fen,
    lastMove: replayed > 0 ? row.moves_uci[replayed - 1]! : null,
    turn: replayed % 2 === 0 ? "white" : "black",
    ply: replayed,
    whiteMs: row.white_ms,
    blackMs: row.black_ms,
    asOf: row.last_move_at?.toISOString() ?? null,
    clockRunning: replayed >= 2 && !over && row.white_ms !== null && row.black_ms !== null,
    over,
    whiteSide: row.white_side,
  };
}

/** Privileged read of the public-safe bridge snapshot for a fixture (or null):
 *  the status and the view-only board. Never `last_error` (operator text),
 *  the players' Lichess ids, the draw offer or the challenge id. Runs for
 *  every public fixture page, so a column named here that the table lacks
 *  errors every one of them. */
export async function loadPublicExternalPlay(fixtureId: string): Promise<PublicExternalPlay | null> {
  const [row] = await sql<PublicBridgeRow[]>`
    select status, challenge_id, white_side, moves_uci, move_count, white_ms, black_ms, last_move_at
      from fixture_external_play
     where fixture_id = ${fixtureId}`;
  if (!row) return null;
  return { status: row.status, watch: watchFromLedger(row) };
}

/** Has this fixture's round been opened (D12)? Opening (T19's openRound)
 *  stamps `stage_round_opens` with the moment it happened. */
export async function loadPublicRoundOpened(fixtureId: string): Promise<boolean> {
  return (await roundOpenFor(sql, fixtureId)) !== null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The watch island's poll: the public page's own board facts for a fixture
 *  the public can see (`public_fixtures_v` — a public or unlisted
 *  competition), 404 for any other. Uncached here: one keyed read per call,
 *  and the route's short public window collapses a crowd at the edge. */
export async function publicFixtureBoard(fixtureId: string): Promise<PublicWatchDoc> {
  if (!UUID.test(fixtureId)) throw new HttpError(404, "fixture not found");
  const [visible] = await sql<{ id: string }[]>`select id from public_fixtures_v where id = ${fixtureId}`;
  if (!visible) throw new HttpError(404, "fixture not found");
  const [externalPlay, roundOpened] = await Promise.all([loadPublicExternalPlay(fixtureId), loadPublicRoundOpened(fixtureId)]);
  return { roundOpened, externalPlay };
}
