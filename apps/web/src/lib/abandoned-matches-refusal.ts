// W2c X-AB-5 (fix round 2, N2): the explicit "Complete stage" of a TABLE stage is refused while a match is held for the
// organiser's settle - an abandon that decided nobody (a withdrawal's expunge is not one: the match left the table). The
// refusal is STAGE_NOT_READY with `reason: "abandoned_matches"` and the held matches in `EngineError.data`,
// `server/api-v1/http.ts` forwards them on the wire, and the desk names them in the reader's language
// (`generatePreconditionMessage`). The entry shape is the Swiss board's (`AbandonedBoard`: fixture id, round, number in
// the round) and so is its validation: a refusal that does not parse keeps the code's own copy and never renders a guess.
// No `server-only`: the stages panel reads it too.
import { type AbandonedBoard, abandonedBoardsOf } from "./swiss-abandoned-refusal";

export const ABANDONED_MATCHES_REASON = "abandoned_matches" as const;

/** One match held for settle: the fixture, the round it is in and its number within that round (both 1-based). */
export type HeldMatch = AbandonedBoard;

/** The named matches, or null when `data` is not a refusal this codebase can read (same rules as the Swiss boards). */
export const heldMatchesOf: (data: unknown) => HeldMatch[] | null = abandonedBoardsOf;
