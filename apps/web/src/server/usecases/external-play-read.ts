import "server-only";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import {
  PUBLIC_HOLD,
  type PublicExternalPlay,
  type PublicGameResult,
  type PublicWatch,
  type PublicWatchDoc,
  type PublicWatchLink,
} from "@/server/external-play/public-view";
import { roundOpenFor } from "@/server/external-play/round-open";
import { whiteSideOfFold } from "@/server/external-play/colours";
import { NEEDS_REASONS, type NeedsReason } from "@/server/external-play/types";
import { isPlayableFixtureStatus } from "./external-play/preflight";
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

/** The fixture's own facts the board reads (T16 fix round 1, I1/I4): whether it is still playable, its recorded
 *  result, and the hold's reason (read here, never published — only its public reading is). */
export type PublicFixtureRow = PublicBridgeRow & {
  needs_reason: string | null;
  fixture_status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: { kind?: string; winner?: string; method?: string } | null;
  summary: { perSide?: { entrantId?: string; line?: string }[]; detail?: { method?: string } } | null;
  finished_at: Date | null;
};

/** The view-only board from the move ledger (T10 writes it, V436), or null
 *  when no game exists at Lichess yet. The position is the ledger replayed
 *  from the start; a ledger chess.js cannot replay in full shows the plies it
 *  could (the room's reconcile repairs the ledger — a spectator never sees a
 *  last move the board does not show). */
export function watchFromLedger(row: PublicBridgeRow, fixtureClosed = false): PublicWatch | null {
  if (row.challenge_id === null) return null;
  const { fen, replayed, san } = fenAfter(row.moves_uci);
  // Over when the bridge closed, or when the fixture left play another way (I1) — its clocks stop either way.
  const over = row.status === "finished" || fixtureClosed;
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
    moves: san,
  };
}

/** A hold's public reading. The column is CHECKed to the vocabulary (V433); a drift is refused loudly rather than
 *  shown as some other hold. */
export function publicHoldOf(reason: string | null): PublicExternalPlay["hold"] {
  if (reason === null) return null;
  if (!(NEEDS_REASONS as readonly string[]).includes(reason)) throw new Error(`publicHoldOf: unknown hold reason ${JSON.stringify(reason)}`);
  return PUBLIC_HOLD[reason as NeedsReason];
}

/** The fixture's result as the finished board's header states it — from the fixture's engine outcome and its
 *  public summary, White's score first. Null while the fixture has none (or one this header cannot word). */
export function publicResultOf(row: Pick<PublicFixtureRow, "outcome" | "summary" | "home_entrant_id" | "away_entrant_id" | "white_side" | "finished_at">): PublicGameResult | null {
  const o = row.outcome;
  if (o === null || typeof o.kind !== "string") return null;
  const sideOf = (entrant: string | undefined): "home" | "away" | null =>
    entrant === undefined ? null : entrant === row.home_entrant_id ? "home" : entrant === row.away_entrant_id ? "away" : null;
  let kind: PublicGameResult["kind"];
  let winner: PublicGameResult["winner"] = null;
  if (o.kind === "win" || o.kind === "award") {
    winner = sideOf(o.winner);
    // A winner who is neither entrant is no result this header can state.
    if (winner === null) return null;
    kind = "win";
  } else if (o.kind === "draw" || o.kind === "tie") kind = "draw";
  else if (o.kind === "no_result") kind = "no_result";
  else return null;
  const lineOf = (entrant: string | null) => row.summary?.perSide?.find((p) => p.entrantId === entrant)?.line ?? null;
  const whiteFirst = row.white_side === "away" ? [row.away_entrant_id, row.home_entrant_id] : [row.home_entrant_id, row.away_entrant_id];
  const [a, b] = whiteFirst.map(lineOf);
  return {
    kind,
    winner,
    method: row.summary?.detail?.method ?? o.method ?? null,
    score: a !== null && b !== null && a !== undefined && b !== undefined ? `${a}–${b}` : "",
    recordedAt: row.finished_at?.toISOString() ?? null,
  };
}

/** Privileged read of the public-safe bridge snapshot for a fixture (or null):
 *  the status and the view-only board. Never `last_error` (operator text),
 *  the players' Lichess ids, the draw offer or the challenge id. Runs for
 *  every public fixture page, so a column named here that the table lacks
 *  errors every one of them. */
export async function loadPublicExternalPlay(fixtureId: string): Promise<PublicExternalPlay | null> {
  const [row] = await sql<PublicFixtureRow[]>`
    select ep.status, ep.challenge_id, ep.white_side, ep.moves_uci, ep.move_count, ep.white_ms, ep.black_ms,
           ep.last_move_at, ep.needs_reason, f.status as fixture_status, f.home_entrant_id, f.away_entrant_id,
           f.outcome, v.summary, f.finished_at
      from fixture_external_play ep
      join fixtures f on f.id = ep.fixture_id
      left join public_fixtures_v v on v.id = ep.fixture_id
     where ep.fixture_id = ${fixtureId}`;
  return row ? publicPlayOf(row) : null;
}

/** The public reading of a bridge row under its fixture. The FIXTURE decides first (I1):
 *  - settled (decided, finalized, abandoned, forfeited, cancelled — the pad, a settle, a withdrawal, a cancel):
 *    over for the spectators even before the sweep closes its bridge, with no hold shown under it;
 *  - awaiting the organiser's decision (`needs_decision`, W2a: a level result in a bracket — played, not
 *    finished): the game is over and the board kept, and the hold is the fixture's — a draw's winner to be
 *    decided, any other level result to be confirmed — whatever the bridge reads;
 *  - open (scheduled, in_play): the bridge's own hold, if any. */
export function publicPlayOf(row: PublicFixtureRow): PublicExternalPlay {
  const open = isPlayableFixtureStatus(row.fixture_status);
  const awaitingDecision = row.fixture_status === "needs_decision";
  const decided = !open && !awaitingDecision;
  const level = row.outcome?.kind === "draw" || row.outcome?.kind === "tie";
  const hold: PublicExternalPlay["hold"] = decided
    ? null
    : awaitingDecision
      ? level
        ? "tiebreak"
        : "confirm"
      : row.status === "needs_organiser"
        ? publicHoldOf(row.needs_reason)
        : null;
  return {
    status: row.status,
    watch: watchFromLedger(row, !open),
    decided,
    hold,
    result: publicResultOf(row),
  };
}

/** A fixture row as the division Fixtures list reads it: the bridge's columns are null with no bridge row. */
export type WatchLinkRow = Omit<PublicFixtureRow, "status" | "moves_uci" | "white_ms" | "black_ms" | "last_move_at"> & {
  status: PublicExternalPlay["status"] | null;
  round_opened: boolean;
};

/** The Fixtures list's link for one online board (I4), or null when there is nothing to watch — a bye, a no-show,
 *  a game not begun; the row says the rest. Before the round opens: "Round not opened yet" (D12). A game being
 *  played — a held seat whose game goes on (a revoked token) included — is "Watch live". A game over — the fixture
 *  out of play, the bridge closed, or a knockout draw held for its winner — is its final position, with the score.
 *  A board held for the organiser mid-question offers nothing: the fixture page says why. */
export function watchLinkOf(row: WatchLinkRow): PublicWatchLink | null {
  const open = isPlayableFixtureStatus(row.fixture_status);
  if (open && !row.round_opened) return { kind: "not_opened" };
  const hasGame = row.status !== null && row.challenge_id !== null && row.move_count > 0;
  if (!hasGame) return null;
  const hold = row.status === "needs_organiser" ? publicHoldOf(row.needs_reason) : null;
  if (!open || row.status === "finished" || hold === "tiebreak") {
    return { kind: "final", score: publicResultOf(row)?.score ?? "" };
  }
  if ((row.status === "live" || row.status === "needs_organiser") && hold === null) return { kind: "live" };
  return null;
}

/** Every online board's link on the division Fixtures list, in ONE read (a public read: `public_fixtures_v` decides
 *  which fixtures exist). Keyed by fixture id; a board with nothing to offer is absent. The caller asks only for a
 *  division that plays online. Never a challenge id, a Lichess id or a hold reason — only the link's kind and score. */
export async function loadDivisionWatchLinks(divisionId: string): Promise<Record<string, PublicWatchLink>> {
  const rows = await watchLinkRows({ divisionId });
  const out: Record<string, PublicWatchLink> = {};
  for (const r of rows) {
    const l = watchLinkOf(r);
    if (l !== null) out[r.fixture_id] = l;
  }
  return out;
}

/** R3 (T16 fix round 1): is an online game being played on this board? Exactly when the Fixtures list offers "Watch
 *  live" for it (`watchLinkOf`), so the list and the match centre's header never disagree. Nothing marks a fixture in
 *  play for a Lichess game (its result is written when the game ends), so the header asks this instead. A fixture with
 *  no bridge row is not. */
export async function loadOnlineGameInPlay(fixtureId: string): Promise<boolean> {
  const [row] = await watchLinkRows({ fixtureId });
  return row !== undefined && watchLinkOf(row)?.kind === "live";
}

/** The rows `watchLinkOf` reads — a public read: `public_fixtures_v` decides which fixtures exist. ONE query for the
 *  Fixtures list (a division) and the match centre (a fixture), so the two read the same columns the same way. */
function watchLinkRows(of: { divisionId: string } | { fixtureId: string }) {
  return sql<(WatchLinkRow & { fixture_id: string })[]>`
    select v.id as fixture_id, f.status as fixture_status, f.home_entrant_id, f.away_entrant_id, f.outcome, v.summary,
           f.finished_at, ep.status, ep.challenge_id, ep.white_side, coalesce(ep.move_count, 0)::int as move_count,
           ep.needs_reason,
           exists(select 1 from stage_round_opens o where o.stage_id = f.stage_id and o.round_no = f.round_no) as round_opened
      from public_fixtures_v v
      join fixtures f on f.id = v.id
      left join fixture_external_play ep on ep.fixture_id = v.id
     where ${"divisionId" in of ? sql`v.division_id = ${of.divisionId}` : sql`v.id = ${of.fixtureId}`}`;
}

/** Has this fixture's round been opened (D12)? Opening (T19's openRound)
 *  stamps `stage_round_opens` with the moment it happened. */
export async function loadPublicRoundOpened(fixtureId: string): Promise<boolean> {
  return (await loadPublicRoundOpenedAt(fixtureId)) !== null;
}

/** When this fixture's round was opened (D12), as the stamp says, or null. */
export async function loadPublicRoundOpenedAt(fixtureId: string): Promise<string | null> {
  return (await roundOpenFor(sql, fixtureId))?.roundOpenedAt.toISOString() ?? null;
}

/** Option B (owner ruling 2026-10-13): which entrant plays White as the pairing stands, for the start position the
 *  public page draws from the round's open — before a game, and its own `white_side`, exist. The same fold the game's
 *  creation reads (`whiteSideOf`); no fold yet reads home, as it does there. */
export async function loadPublicPairedWhiteSide(fixtureId: string): Promise<"home" | "away"> {
  const [row] = await sql<{ state: unknown }[]>`select state from match_states where fixture_id = ${fixtureId}`;
  return whiteSideOfFold(row?.state ?? null);
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
  const [externalPlay, roundOpenedAt] = await Promise.all([loadPublicExternalPlay(fixtureId), loadPublicRoundOpenedAt(fixtureId)]);
  return { roundOpened: roundOpenedAt !== null, roundOpenedAt, externalPlay };
}
