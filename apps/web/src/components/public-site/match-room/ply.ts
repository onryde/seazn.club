// The ply of a board: plies played, from the FEN (fullmove number and side to move) — the one measure both a snapshot
// and a broadcast carry (a broadcast that jumped plies keeps the ledger short, so its length is not the ply). A module
// of its own so the clock arithmetic (clock-math) and the reducer (room-state) share it without importing each other.
import type { RoomGame } from "./room-snapshot";

export function plyOfFen(fen: string): number {
  const parts = fen.split(" ");
  const full = Number(parts[5]);
  if (!Number.isFinite(full) || full < 1) return 0;
  return (full - 1) * 2 + (parts[1] === "b" ? 1 : 0);
}

export function plyOf(game: RoomGame | null): number {
  return game === null ? -1 : plyOfFen(game.fen);
}
