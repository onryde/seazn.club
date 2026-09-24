// Slot-label resolver (P6/D4b, task A1). `fixtures.home_slot_label` /
// `away_slot_label` (V360) carry `SlotLabel | null` — an i18n pattern ref
// (`{key, params}`, produced by `descriptorLabel()` in
// server/usecases/stage-seeding.ts) while the matching `*_entrant_id` is
// still null. This is the ONE place that turns that value into display
// text — every renderer (client island via useMsg(), server component via
// msgFor()) goes through it instead of hand-building a string, so the
// null → "TBD" fallback and the {key,params} → string substitution each
// exist exactly once.
//
// `lookup` is intentionally just a callback, not an import of useMsg()/
// msgFor() — msgFor pulls in `server-only`, so importing it directly here
// would break every client caller. `fallbackKey` is supplied by the call
// site (not defaulted) because several surfaces already had their own
// localized "TBD" key before this module existed (schedule.tbd,
// bracket.tbd, me.tbd, …) with slightly different translations per
// surface; the resolver reuses whichever one already fit rather than
// inventing a new canonical string.
import { msg } from "@/lib/messages";
import type { MessageKey } from "@/lib/messages";
import type { SlotLabel } from "@/server/usecases/stage-seeding";
import { composeMatchRef } from "@/lib/match-ref";

export type { SlotLabel };

export type SlotLabelLookup = (
  key: MessageKey,
  vars?: Record<string, string | number>,
) => string;

/** `{round, seq}` → the localized match-reference fragment ("R1·2" in
 *  English — P7/F1), via the `slot.match_ref` dictionary key. This is the
 *  ONE place that ref gets built: the board card's own short-code chip
 *  (schedule-board.tsx's consoleFixtures) calls it directly, and
 *  resolveSlotLabel() below calls it internally to fill slot.winner_match /
 *  slot.loser_match's `{ext}`. Two call sites, one composition — so a card
 *  labelled "R1·2" and a slot that says "Winner of R1·2" can't drift onto
 *  different formats the way a hand-built template on each side could.
 *  Defaults to the client-safe English `msg()`, same convention as
 *  board/types.ts's `cardTitle()`.
 *
 *  `code` (schedule-board knockout round codes, 2026-09-23): the round's
 *  SHORT code ("QF") to print in place of the round number — "QF·3" via
 *  `slot.match_ref_code`. Only the schedule board ever passes one
 *  (board/round-codes.ts); omitted, this is byte-for-byte the "R3·3" every
 *  other surface has always rendered. */
export function matchRef(
  round: number,
  seq: number,
  lookup: SlotLabelLookup = msg,
  code?: string,
): string {
  // The composition itself lives in the dictionary-free `match-ref.ts`, so the
  // refusal copy can name a match the same way without the dictionaries.
  return composeMatchRef(round, seq, lookup, code);
}

/** `SlotLabel | null` → display string. Never builds text itself — every
 *  character returned comes from `lookup`'s dictionary, so there is no
 *  concatenation path to audit.
 *
 *  `slot.winner_match` / `slot.loser_match` are special-cased: their
 *  persisted `params` are `{round, seq}` (numbers, never a rendered
 *  fragment — P7/F1), and `{ext}` is composed here via matchRef() rather
 *  than trusted from storage, so every renderer resolves the SAME ref text
 *  regardless of which surface reads the row.
 *
 *  A `code` param is the one exception, and it is never STORED: the schedule
 *  board stamps the feeder's round code onto its own in-memory copy of the
 *  label (board/round-codes.ts `withRoundCodeRefs`), so its cards read
 *  "Winner of QF·3". Nothing writes `code` to a row, so every other surface
 *  reading the same row still resolves "Winner of R3·3". */
export function resolveSlotLabel(
  label: SlotLabel | null,
  lookup: SlotLabelLookup,
  fallbackKey: MessageKey,
): string {
  if (!label) return lookup(fallbackKey);
  if (label.key === "slot.winner_match" || label.key === "slot.loser_match") {
    const round = Number(label.params.round);
    const seq = Number(label.params.seq);
    const code = typeof label.params.code === "string" ? label.params.code : undefined;
    return lookup(label.key as MessageKey, { ext: matchRef(round, seq, lookup, code) });
  }
  const vars: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(label.params)) {
    vars[k] = typeof v === "number" ? v : String(v);
  }
  return lookup(label.key as MessageKey, vars);
}
