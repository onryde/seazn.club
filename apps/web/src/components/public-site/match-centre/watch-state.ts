// T16 — the watch island's state: one board from two sources.
//
// A PUSH (`board_state`, lib/realtime) is the server's own order — each
// accepted move, then reconcile's corrections — and always lands. A POLL
// (GET /public/fixtures/{id}/board) can be stale: the route keeps a short
// public edge window, and a request sent before a move can answer after its
// push. So a poll never takes the board BACK — an older ply, "not over" at the
// ply that ended, or no board at all — though it may still say which entrant
// plays White, which a push does not carry. Status (finished, held) is the
// bridge's, and only polls read the bridge.
//
// Known limit: a correction that SHORTENS the ledger reaches a poll-only
// spectator at the next move or a reload, not at once (a poll cannot tell it
// from a stale answer). A pushed spectator gets it at once.
import {
  isWatchable,
  type PublicBoardPush,
  type PublicExternalPlay,
  type PublicWatch,
  type PublicWatchDoc,
} from "@/server/external-play/public-view";

export type WatchModel = { roundOpened: boolean; play: PublicExternalPlay | null };
export type WatchEvent = { kind: "poll"; doc: PublicWatchDoc } | { kind: "push"; push: PublicBoardPush; at: string };
export type WatchView = "board" | "held" | "not_opened" | "not_started";

export function initialWatch(doc: PublicWatchDoc): WatchModel {
  return { roundOpened: doc.roundOpened, play: doc.externalPlay };
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
    const watch: PublicWatch = {
      fen: p.fen,
      lastMove: p.lastMove,
      turn: p.turn,
      ply: p.ply,
      whiteMs: p.whiteMs,
      blackMs: p.blackMs,
      asOf: e.at,
      clockRunning: p.ply >= 2 && !p.over,
      over: p.over,
      whiteSide: prev?.watch?.whiteSide ?? null,
    };
    const status = prev?.status === "finished" || prev?.status === "needs_organiser" ? prev.status : "live";
    // roundOpened is left as it was: once a board is on screen it is never read (watchView draws the board, or
    // the hold, before it asks), and a poll never takes the board away.
    return { ...m, play: { status, watch } };
  }
  const roundOpened = m.roundOpened || e.doc.roundOpened;
  const cur = m.play?.watch ?? null;
  const next = e.doc.externalPlay?.watch ?? null;
  if (cur !== null && goesBack(cur, next)) {
    // Stale: keep the board, but learn White's side if this board lacks it.
    const side = cur.whiteSide ?? next?.whiteSide ?? null;
    const play = side === cur.whiteSide ? m.play : { ...m.play!, watch: { ...cur, whiteSide: side } };
    return { roundOpened, play };
  }
  return { roundOpened, play: e.doc.externalPlay };
}

/** What the panel shows. A board only when there is one to draw (isWatchable). */
export function watchView(m: WatchModel): WatchView {
  if (m.play !== null && isWatchable(m.play)) return "board";
  if (m.play?.status === "needs_organiser") return "held";
  return m.roundOpened ? "not_started" : "not_opened";
}

/** Keep polling until a poll says the game is finished. A push's "over" is not
 *  the end: the bridge may still hold the board for the organiser. */
export function pollsAgain(m: WatchModel): boolean {
  return m.play?.status !== "finished";
}

const OPEN_FIXTURE: ReadonlySet<string> = new Set(["scheduled", "in_play", "needs_decision"]);

/** Does the page show the panel? Always while the fixture is open; once it is
 *  decided or cancelled, only when there is a game to show — a board settled
 *  without one would otherwise read "not started" under its result. */
export function showWatchPanel(fixtureStatus: string, doc: PublicWatchDoc): boolean {
  return OPEN_FIXTURE.has(fixtureStatus) || (doc.externalPlay?.watch ?? null) !== null;
}
