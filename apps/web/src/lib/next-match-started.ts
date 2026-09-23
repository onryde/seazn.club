// The "next match has already started" refusal, said ONCE.
//
// Voiding a decided knockout result takes back the name it advanced into the
// next fixture (owner ruling 2026-09-23, `server/engine-db/fed-seats.ts`) — but
// only while that next fixture has not started. Once it has, the void is
// refused before anything is written, and the organiser unwinds from the
// latest match backwards: void the next match first, then this one.
//
// WHY THIS FILE AND NOT THE SERVER MODULE: it imports nothing but
// `match-ref.ts`, which imports nothing at runtime, so the server that throws
// the refusal, the console and the device chrome that translate it, the pad
// transport that must classify it as terminal, vitest and the e2e specs can all
// share one code and one reader of its detail. Keep it that way — `server-only`,
// the dictionaries, or anything that reaches them would silently un-share it
// (the same reasoning as `schedule-lock.ts`).
//
// THE LABEL (fix round 2, controller ruling 2026-09-23): the refusal names the
// next match with the SAME label the schedule board shows it by. The board
// names a knockout or double-elimination match by its round's code — "F·1",
// "QF·3", "WB2·1" (`boardRoundCodes` + `matchRef`, board/round-codes.ts and
// schedule-board.tsx) — and every other match "R2·1". The server runs the
// board's own `boardRoundCodes` and sends the code it chose as the DICTIONARY
// KEY behind it (`code`), never as text: the codes are localized (a
// quarter-final is QF, CF or KF), and only the reader knows their language.

import { composeMatchRef, type MatchRefLookup } from "./match-ref";

/** `HttpError.code` on the refusal. A 409 the server gives no matter which
 *  `expected_seq` is sent, so a pad must NOT renegotiate it
 *  (`components/v2/scorepad/transport.ts`'s `TERMINAL_CONFLICT_CODES`). */
export const NEXT_MATCH_STARTED_CODE = "NEXT_MATCH_STARTED";

/** Every key `roundRoleShort` (lib/round-role-label.ts) can name a round's
 *  code with — the only keys a `code` may carry. Any other key would print
 *  whatever sentence it holds in the middle of this one, so a ref carrying one
 *  is refused whole (`nextMatchRefOf`). Pinned against `roundRoleShort`'s
 *  output by `__tests__/next-match-started.test.ts`. */
export const ROUND_CODE_KEYS = [
  "bracket.roundShort.roundOf",
  "bracket.roundShort.quarter",
  "bracket.roundShort.semi",
  "bracket.roundShort.final",
  "bracket.roundShort.thirdPlace",
  "bracket.roundShort.winnersRound",
  "bracket.roundShort.losersRound",
  "bracket.roundShort.grandFinal",
  "bracket.roundShort.grandFinalReset",
] as const;

/** A round code as the dictionary key (and its `{n}`) the board rendered it
 *  from, so each reader renders it in their own language. `roundRoleShort`
 *  only ever passes numbers. */
export interface RoundCodeRef {
  key: (typeof ROUND_CODE_KEYS)[number];
  params: Record<string, number>;
}

/** The machine-readable half, carried in the error body as `next_match` so a
 *  client can name the match in its OWN language. `round`/`seq` are the next
 *  fixture's `round_no`/`seq_in_round` — the pair every match ref ("R2·1",
 *  `slot.match_ref`) is composed from — and `code`, present exactly when the
 *  board codes that match's round, is the code the board prints in place of
 *  the round number. */
export interface NextMatchRef {
  fixture_id: string;
  round: number;
  seq: number;
  code?: RoundCodeRef;
}

/** The label the schedule board shows the next match by, in `lookup`'s
 *  language: `matchRef`'s own composition (`match-ref.ts`) over the code the
 *  board chose. The server's English sentence, the console and the pad all
 *  name the match through this. */
export function nextMatchLabel(ref: Pick<NextMatchRef, "round" | "seq" | "code">, lookup: MatchRefLookup): string {
  const code = ref.code === undefined ? undefined : lookup(ref.code.key, ref.code.params);
  return composeMatchRef(ref.round, ref.seq, lookup, code);
}

/** The server's English sentence, naming the match by `label` — its
 *  `nextMatchLabel` in English ("F·1"). Clients translate from the CODE and
 *  `next_match`, never from this string. */
export function nextMatchStartedMessage(label: string): string {
  return `The next match (${label}) has already started. Void that one first.`;
}

/** Read `next_match` back off an error body's extra fields; null when absent
 *  or malformed, so a caller falls back to its generic copy instead of
 *  rendering a sentence with a hole in it. */
export function nextMatchRefOf(extra: Record<string, unknown> | null | undefined): NextMatchRef | null {
  const raw = extra?.next_match as Partial<NextMatchRef> | undefined;
  if (!raw || typeof raw !== "object") return null;
  const { fixture_id, round, seq, code } = raw;
  if (typeof fixture_id !== "string" || !Number.isInteger(round) || !Number.isInteger(seq)) return null;
  const ref: NextMatchRef = { fixture_id, round: round as number, seq: seq as number };
  if (code === undefined) return ref;
  const roundCode = roundCodeOf(code);
  return roundCode === null ? null : { ...ref, code: roundCode };
}

/** A `code` exactly as `RoundCodeRef` says, or null. */
function roundCodeOf(raw: unknown): RoundCodeRef | null {
  if (!raw || typeof raw !== "object") return null;
  const { key, params } = raw as { key?: unknown; params?: unknown };
  if (!(ROUND_CODE_KEYS as readonly unknown[]).includes(key)) return null;
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const entries = Object.entries(params);
  if (!entries.every(([, v]) => typeof v === "number" && Number.isFinite(v))) return null;
  return { key: key as RoundCodeRef["key"], params: Object.fromEntries(entries) as RoundCodeRef["params"] };
}
