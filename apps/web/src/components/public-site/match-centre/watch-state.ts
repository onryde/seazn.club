// T16 — the watch island's state: one board from two sources.
//
// A PUSH (`board_state`, lib/realtime) is the server's own order — each
// accepted move, then reconcile's corrections — and always lands. A POLL
// (GET /public/fixtures/{id}/board) can be stale: the route keeps a short
// public edge window, and a request sent before a move can answer after its
// push. So a poll never takes the board BACK — an older ply, "not over" at the
// ply that ended, or no board at all — though it may still say which entrant
// plays White, which a push does not carry. Status (finished, held), the
// fixture's facts (decided, its result) and the move list are read by polls
// only.
//
// T16 fix round 1, I1: the FIXTURE decides first. A fixture decided another
// way (the pad, a settle, a withdrawal, a cancel) is finished for the
// spectators whatever its bridge row reads, never "needs the organiser", and
// nothing is polled for it any more.
//
// Known limit: a correction that SHORTENS the ledger reaches a poll-only
// spectator at the next move or a reload, not at once (a poll cannot tell it
// from a stale answer). A pushed spectator gets it at once.
import type {
  PublicBoardPush,
  PublicExternalPlay,
  PublicHold,
  PublicWatch,
  PublicWatchDoc,
} from "@/server/external-play/public-view";

export type WatchModel = { roundOpened: boolean; roundOpenedAt: string | null; play: PublicExternalPlay | null };
export type WatchEvent = { kind: "poll"; doc: PublicWatchDoc } | { kind: "push"; push: PublicBoardPush; at: string };
/** live: the game is being played. held: the organiser has the board (a knockout draw's winner, or a result to
 *  confirm). finished: the game is over — its board and its result, or the line that it has none yet. */
export type WatchView = "live" | "held" | "finished" | "not_opened" | "not_started";

export function initialWatch(doc: PublicWatchDoc): WatchModel {
  return { roundOpened: doc.roundOpened, roundOpenedAt: doc.roundOpenedAt, play: stopped(doc.externalPlay) };
}

/** A decided fixture's board is over and its clocks stopped, whatever the board on hand says (I1). One rule for
 *  the first paint, every poll and every push. */
function stopped(play: PublicExternalPlay | null): PublicExternalPlay | null {
  const w = play?.watch ?? null;
  if (play === null || !play.decided || w === null || (w.over && !w.clockRunning)) return play;
  return { ...play, watch: { ...w, over: true, clockRunning: false } };
}

/** The position before any move (FIDE Laws Art. 2), as FEN. */
export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** The board the spectators see from the round's open until the first move (owner ruling 2026-10-13, option B):
 *  the start position, White to move, both clocks stopped at the initial time, each player on their side. A game
 *  on file at ply 0 lends its own colours and any clock it has read; before it exists, the pairing's colours and
 *  the division's time control. A clock nobody can state is null (a dash), never 0. */
export function startBoard(
  watch: PublicWatch | null,
  pairedWhiteSide: "home" | "away" | null,
  initialMs: number | null,
): PublicWatch {
  return {
    fen: START_FEN,
    lastMove: null,
    turn: "white",
    ply: 0,
    whiteMs: watch?.whiteMs ?? initialMs,
    blackMs: watch?.blackMs ?? initialMs,
    asOf: null,
    clockRunning: false,
    over: false,
    whiteSide: watch?.whiteSide ?? pairedWhiteSide,
    moves: [],
  };
}

/** Is `next` older than the board on screen — would showing it take the board back? */
function goesBack(cur: PublicWatch, next: PublicWatch | null): boolean {
  if (next === null) return true;
  if (next.ply !== cur.ply) return next.ply < cur.ply;
  return cur.over && !next.over;
}

export function nextWatch(m: WatchModel, e: WatchEvent): WatchModel {
  if (e.kind === "push") {
    const prev = m.play;
    const p = e.push;
    const decided = prev?.decided === true;
    const watch: PublicWatch = {
      fen: p.fen,
      lastMove: p.lastMove,
      turn: p.turn,
      ply: p.ply,
      whiteMs: p.whiteMs,
      blackMs: p.blackMs,
      asOf: e.at,
      clockRunning: p.ply >= 2 && !p.over && !decided,
      over: p.over || decided,
      whiteSide: prev?.watch?.whiteSide ?? null,
      // A push carries the board, not the list: the list on screen stays until the next poll brings it level
      // (the panel asks for that poll at once — movesBehind).
      moves: prev?.watch?.moves ?? [],
    };
    const status = prev?.status === "finished" || prev?.status === "needs_organiser" ? prev.status : "live";
    // roundOpened is left as it was: once a board is on screen it is never read (watchView draws the board, or
    // the hold, before it asks), and a poll never takes the board away.
    return {
      ...m,
      play: { status, watch, decided, hold: prev?.hold ?? null, result: prev?.result ?? null },
    };
  }
  const roundOpened = m.roundOpened || e.doc.roundOpened;
  const roundOpenedAt = m.roundOpenedAt ?? e.doc.roundOpenedAt;
  const cur = m.play?.watch ?? null;
  const nextPlay = e.doc.externalPlay;
  const next = nextPlay?.watch ?? null;
  if (cur !== null && goesBack(cur, next)) {
    // Stale board: keep the one on screen (learning White's side if it lacks it). The fixture's own facts are
    // still the poll's — a result, a decision or a hold is never older than the board it is shown with.
    const side = cur.whiteSide ?? next?.whiteSide ?? null;
    const watch = side === cur.whiteSide ? cur : { ...cur, whiteSide: side };
    const play: PublicExternalPlay = nextPlay === null ? { ...m.play!, watch } : { ...nextPlay, watch };
    return { roundOpened, roundOpenedAt, play: stopped(play) };
  }
  return { roundOpened, roundOpenedAt, play: stopped(nextPlay) };
}

/** What the panel shows. The fixture decides first: decided ⇒ finished. Then a hold the public is told about —
 *  the bridge's, or the fixture's own while it awaits the organiser's decision (a knockout draw), which outlives
 *  the bridge's close. Then the bridge closed ⇒ finished. Then a board with a move on it. Otherwise the round's
 *  own line. */
export function watchView(m: WatchModel): WatchView {
  const p = m.play;
  if (p !== null) {
    if (p.decided) return "finished";
    if (p.hold !== null) return "held";
    if (p.status === "finished") return "finished";
    if (p.watch !== null && p.watch.ply > 0) return "live";
  }
  return m.roundOpened ? "not_started" : "not_opened";
}

/** The hold the panel names, or null. */
export function holdOf(m: WatchModel): PublicHold | null {
  return watchView(m) === "held" ? (m.play?.hold ?? null) : null;
}

/** Keep polling until the game is over for us: the fixture decided, or the bridge closed with nothing held. A
 *  push's "over" is not the end (the bridge may still hold the board for the organiser), and a held board — a
 *  bridge's hold, or a knockout draw awaiting its winner — is polled so its result arrives; a decided fixture is
 *  never polled again (I1). */
export function pollsAgain(m: WatchModel): boolean {
  const p = m.play;
  if (p === null) return true;
  return !(p.decided || (p.status === "finished" && p.hold === null));
}

/** The board on screen is ahead of its move list (a push moved it): the panel asks for a poll at once. */
export function movesBehind(m: WatchModel): boolean {
  const w = m.play?.watch ?? null;
  return w !== null && w.moves.length < w.ply;
}

const OPEN_FIXTURE: ReadonlySet<string> = new Set(["scheduled", "in_play", "needs_decision"]);

/** Does the page show the panel? Always while the fixture is open; once it is
 *  decided or cancelled, only when there is a game to show — a board settled
 *  without one would otherwise read "not started" under its result. */
export function showWatchPanel(fixtureStatus: string, doc: PublicWatchDoc): boolean {
  return OPEN_FIXTURE.has(fixtureStatus) || (doc.externalPlay?.watch ?? null) !== null;
}
