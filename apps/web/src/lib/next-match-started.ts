// The "next match has already started" refusal, said ONCE.
//
// Voiding a decided knockout result takes back the name it advanced into the
// next fixture (owner ruling 2026-09-23, `server/engine-db/fed-seats.ts`) — but
// only while that next fixture has not started. Once it has, the void is
// refused before anything is written, and the organiser unwinds from the
// latest match backwards: void the next match first, then this one.
//
// WHY THIS FILE AND NOT THE SERVER MODULE: it imports NOTHING, so the server
// that throws the refusal, the console and the device chrome that translate it,
// the pad transport that must classify it as terminal, vitest and the e2e specs
// can all share one code and one reader of its detail. Keep it import-free —
// `server-only`, or anything that reaches it, would silently un-share it (the
// same reasoning as `schedule-lock.ts`).

/** `HttpError.code` on the refusal. A 409 the server gives no matter which
 *  `expected_seq` is sent, so a pad must NOT renegotiate it
 *  (`components/v2/scorepad/transport.ts`'s `TERMINAL_CONFLICT_CODES`). */
export const NEXT_MATCH_STARTED_CODE = "NEXT_MATCH_STARTED";

/** The machine-readable half, carried in the error body as `next_match` so a
 *  client can name the match in its OWN language. `round`/`seq` are the next
 *  fixture's `round_no`/`seq_in_round` — the pair every match ref ("R2·1",
 *  `slot.match_ref`) is composed from. */
export interface NextMatchRef {
  fixture_id: string;
  round: number;
  seq: number;
}

/** The server's English sentence. Clients translate from the CODE and
 *  `next_match`, never from this string. The "R2·1" shape mirrors the English
 *  `slot.match_ref`. */
export function nextMatchStartedMessage(ref: { round: number; seq: number }): string {
  return `The next match (R${ref.round}·${ref.seq}) has already started. Void that one first.`;
}

/** Read `next_match` back off an error body's extra fields; null when absent
 *  or malformed, so a caller falls back to its generic copy instead of
 *  rendering a sentence with a hole in it. */
export function nextMatchRefOf(extra: Record<string, unknown> | null | undefined): NextMatchRef | null {
  const raw = extra?.next_match as Partial<NextMatchRef> | undefined;
  if (!raw || typeof raw !== "object") return null;
  const { fixture_id, round, seq } = raw;
  if (typeof fixture_id !== "string" || !Number.isInteger(round) || !Number.isInteger(seq)) return null;
  return { fixture_id, round: round as number, seq: seq as number };
}
