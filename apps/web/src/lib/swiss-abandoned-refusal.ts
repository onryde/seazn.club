// W2c P-7 / X-AB-5 (fix round 1, I2): the Swiss "generate the next round" refusal names the boards that hold the round.
// An abandoned board has no result, so the round stays open until the organiser settles it; the server refuses the next
// round with STAGE_NOT_READY and the boards in `EngineError.data`, `server/api-v1/http.ts` forwards them on the wire
// (`reason: "swiss_abandoned_boards"`), and the desk renders them in the reader's language
// (`generatePreconditionMessage`). The same validated shape on both sides: a refusal that does not parse keeps the
// code's own copy and never renders a guess. No `server-only`: the stages panel reads it too.

export const SWISS_ABANDONED_BOARDS_REASON = "swiss_abandoned_boards" as const;

export interface AbandonedBoard {
  fixtureId: string;
  /** The Swiss round the board was paired in (1-based). */
  round: number;
  /** The board's number within that round (1-based). */
  board: number;
}

/** The named boards, or null when `data` is not a refusal this codebase can read - not an object, no `abandoned` list,
 *  an empty list, or any entry that is not `{fixtureId: string, round: positive int, board: positive int}`. */
export function abandonedBoardsOf(data: unknown): AbandonedBoard[] | null {
  if (typeof data !== "object" || data === null) return null;
  const list = (data as { abandoned?: unknown }).abandoned;
  if (!Array.isArray(list) || list.length === 0) return null;
  const out: AbandonedBoard[] = [];
  for (const b of list) {
    if (typeof b !== "object" || b === null) return null;
    const { fixtureId, round, board } = b as { fixtureId?: unknown; round?: unknown; board?: unknown };
    if (typeof fixtureId !== "string" || fixtureId === "") return null;
    if (!Number.isInteger(round) || (round as number) < 1) return null;
    if (!Number.isInteger(board) || (board as number) < 1) return null;
    out.push({ fixtureId, round: round as number, board: board as number });
  }
  return out;
}
