// T17B fix 2, D19 (owner, 2026-10-14): which sound the room plays, and when it stays silent. Pure: the hook
// (use-room-sounds.ts) feeds it one observation of the room's state per render, and the player (room-audio.ts) makes
// the sound. Three rules from the brief:
//
//   - only NEW plies arriving live: the first observation (a load) is silent, and so is any jump of more than one ply
//     (a reconnect, a dropped broadcast) and any re-read of the same ply;
//   - one sound per ply, by SOUND_PRIORITY: check beats capture, capture beats a move;
//   - the player's own move sounds at the DROP (the moment the room sends it), not a round trip later, and the
//     server's confirmation of that same ply is then silent. A refusal puts the board back (the reducer's syncKey),
//     and the drop no longer covers the ply.
//
// A ply's kind is read from the two positions (before and after), so the board's move string never has to be parsed:
// a capture is a piece fewer, a castle is the mover's king two files along its rank, a check is the side to move in
// check (chess.js, the rules the board already uses).
import { Chess } from "chess.js";
import { plyOf, type RoomState } from "./room-state";

type Colour = "white" | "black";

export const SOUNDS = ["move", "opponentMove", "capture", "castle", "check", "start", "end", "offer", "lowTime"] as const;
export type Sound = (typeof SOUNDS)[number];

/** Highest first: of the sounds one observation calls for, the first in this list is the one played. The game's end
 *  outranks the ply that ended it; a draw offer outranks the move it came with (it asks for an answer); then the brief's
 *  order for a ply — check, capture, castle, a move. */
export const SOUND_PRIORITY: readonly Sound[] = ["end", "start", "offer", "check", "capture", "castle", "opponentMove", "move", "lowTime"];

export function pickSound(candidates: readonly Sound[]): Sound | null {
  for (const s of SOUND_PRIORITY) if (candidates.includes(s)) return s;
  return null;
}

/** What one render of the room says, for sounds. `move` is a move the player has just sent (the reducer's pending
 *  act); `sync` is the reducer's syncKey, which moves when a refused act puts the board back. */
export type Observation = {
  gameId: string | null;
  ply: number;
  fen: string | null;
  ended: boolean;
  offerBy: Colour | null;
  me: Colour;
  move: string | null;
  sync: number;
};

export function observe(state: RoomState): Observation {
  const g = state.snap.game;
  const p = state.pending;
  return {
    gameId: g?.gameId ?? null,
    ply: plyOf(g),
    fen: g?.fen ?? null,
    ended: (g?.over ?? false) || state.snap.result !== null,
    offerBy: g?.drawOfferBy ?? null,
    me: state.snap.you.colour,
    move: p?.kind === "act" && p.action.kind === "move" ? p.action.uci : null,
    sync: state.syncKey,
  };
}

/** The position the player's dropped move leads to, and its ply, while that drop stands. */
export type Drop = { gameId: string; ply: number; fen: string };
export type SoundMemory = { last: Observation; drop: Drop | null };

const SQUARES = "abcdefgh";

/** The pieces of a FEN's placement, square → piece letter; null when it cannot be read. */
function pieces(fen: string): Map<string, string> | null {
  const rows = fen.split(" ")[0]?.split("/");
  if (rows === undefined || rows.length !== 8) return null;
  const out = new Map<string, string>();
  for (let r = 0; r < 8; r += 1) {
    let file = 0;
    for (const ch of rows[r]!) {
      if (/[1-8]/.test(ch)) file += Number(ch);
      else if (/[pnbrqkPNBRQK]/.test(ch)) {
        if (file > 7) return null;
        out.set(`${SQUARES[file]}${8 - r}`, ch);
        file += 1;
      } else return null;
    }
    if (file !== 8) return null;
  }
  return out;
}

function moverOf(fen: string): Colour | null {
  const side = fen.split(" ")[1];
  return side === "w" ? "white" : side === "b" ? "black" : null;
}

function inCheck(fen: string): boolean | null {
  try {
    return new Chess(fen).inCheck();
  } catch {
    return null;
  }
}

/** The sound of the ply from `before` to `after`, heard by `me`; null when either position cannot be read. */
function plySound(before: string, after: string, me: Colour): Sound | null {
  const a = pieces(before);
  const b = pieces(after);
  const mover = moverOf(before);
  const check = inCheck(after);
  if (a === null || b === null || mover === null || check === null) return null;
  const candidates: Sound[] = [mover === me ? "move" : "opponentMove"];
  if (b.size < a.size) candidates.push("capture");
  const king = mover === "white" ? "K" : "k";
  const from = [...a].find(([, p]) => p === king)?.[0];
  const to = [...b].find(([, p]) => p === king)?.[0];
  if (from && to && from[1] === to[1] && Math.abs(SQUARES.indexOf(from[0]!) - SQUARES.indexOf(to[0]!)) === 2) candidates.push("castle");
  if (check) candidates.push("check");
  return pickSound(candidates);
}

/** The position after the player's move, by the rules; null when the rules refuse it. Castling arrives either as the
 *  king's two-square step (e1g1) or, the way lila writes it, as the king onto its own rook (e1h1). */
export function afterMove(fen: string, uci: string): string | null {
  try {
    const c = new Chess(fen);
    let to = uci.slice(2, 4);
    const from = uci.slice(0, 2);
    const piece = c.get(from as never);
    const target = c.get(to as never);
    if (piece?.type === "k" && target?.type === "r" && target.color === piece.color && from[1] === to[1]) {
      to = `${to[0] === "h" ? "g" : "c"}${to[1]}`;
    }
    c.move({ from, to, ...(uci.length > 4 ? { promotion: uci[4] } : {}) });
    return c.fen();
  } catch {
    return null;
  }
}

/**
 * One observation on: the sound to play now (or none), and what to remember. `mem` null is the room's first render —
 * a load — and is silent by rule.
 */
export function soundStep(mem: SoundMemory | null, next: Observation): { mem: SoundMemory; sound: Sound | null } {
  if (mem === null) return { mem: { last: next, drop: null }, sound: null };
  const last = mem.last;
  let drop = mem.drop;
  // A refusal put the board back: the dropped move did not happen.
  if (next.sync !== last.sync) drop = null;
  const candidates: Sound[] = [];

  const newGame = next.gameId !== null && next.gameId !== last.gameId;
  if (newGame) {
    drop = null;
    if (!next.ended) candidates.push("start");
  }
  if (next.ended && !last.ended) candidates.push("end");

  const sameGame = !newGame && next.gameId !== null && next.gameId === last.gameId;
  if (sameGame && next.gameId !== null && next.fen !== null) {
    // The player's own drop: sounded now, from the position it makes.
    if (next.move !== null && next.move !== last.move && next.ply === last.ply) {
      const after = afterMove(next.fen, next.move);
      if (after !== null) {
        const s = plySound(next.fen, after, next.me);
        if (s !== null) candidates.push(s);
        drop = { gameId: next.gameId, ply: next.ply + 1, fen: after };
      }
    }
    const coveredByDrop = (ply: number) => drop !== null && drop.gameId === next.gameId && drop.ply === ply;
    if (next.ply === last.ply + 1 && last.fen !== null) {
      // One ply on: heard now, unless it is the move the player dropped (already heard).
      if (!coveredByDrop(next.ply)) {
        const s = plySound(last.fen, next.fen, next.me);
        if (s !== null) candidates.push(s);
      }
    } else if (next.ply === last.ply + 2 && drop !== null && coveredByDrop(last.ply + 1)) {
      // The player's dropped move AND the reply arrived in one read: the reply is the one new ply.
      const s = plySound(drop.fen, next.fen, next.me);
      if (s !== null) candidates.push(s);
    }
    if (next.offerBy !== null && next.offerBy !== next.me && last.offerBy !== next.offerBy) candidates.push("offer");
  }
  return { mem: { last: next, drop }, sound: pickSound(candidates) };
}

/** Low time — ONE rule (the brief's choice to make): a single cue when the player's own clock crosses 10 s. It re-arms
 *  only when the clock is back above 15 s (an increment can lift it to 12 s and drop it again every move; that is one
 *  low-time spell, not many). A clock already under 10 s when first seen is no crossing, and is silent. */
export const LOW_TIME_MS = 10_000;
export const LOW_TIME_REARM_MS = 15_000;
export type LowTimeMemory = { gameId: string; armed: boolean };

export function lowTimeStep(mem: LowTimeMemory | null, gameId: string, ms: number): { mem: LowTimeMemory; fire: boolean } {
  if (mem === null || mem.gameId !== gameId) return { mem: { gameId, armed: ms > LOW_TIME_MS }, fire: false };
  if (mem.armed && ms <= LOW_TIME_MS) return { mem: { gameId, armed: false }, fire: true };
  if (!mem.armed && ms > LOW_TIME_REARM_MS) return { mem: { gameId, armed: true }, fire: false };
  return { mem, fire: false };
}
