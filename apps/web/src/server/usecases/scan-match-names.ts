import "server-only";
// Scorer sheets §4.5 — how the scan screens name the match (Confirm's "Match"
// line) and each seat still waiting for its feeder (Waiting's "Winner of …").
// OWNER RULING 2026-09-24: exactly as the schedule board names them (#851/#854)
// — "QF·1", "Winner of QF·2", "Q2·1", "3rd·1" — never "R2·1", except where the
// board itself prints that (a round it does not code, e.g. a league).
//
// The board's own functions over the board's own columns, the same path the
// next-match refusal takes (engine-db/fed-seats.ts `boardRef`): `boardRoundCodes`
// over the rows, `matchRef` (→ `composeMatchRef`) with the board's `refSeq`,
// and for the seats `withRoundCodeRefs` over the board's own feed map
// (`feedLabels`) — the feed edge first, the stored label when there is none,
// in `cardTitle`'s order. Unlike that refusal, this page knows its reader, so
// the codes render in the viewer's language here (`lookup`) instead of
// travelling as dictionary keys.
//
// The WHOLE DIVISION's rows, not the stage's (review round 2): a seat fed from
// another stage has no stored label naming its feeder — `wireCrossFeeds`
// (stages.ts) writes only the source row's link — so its name comes from the
// feed edge, whose source row lives in the other stage. Cross feeds never
// leave their division (`wireCrossFeeds` reads one division's stages), which
// is what makes the division enough; the board reads the whole competition.
import type { Tx } from "@/lib/db";
import {
  boardRoundCodes,
  withRoundCodeRefs,
  type RoundCodeFixture,
  type SeatLabelFixture,
} from "@/components/v2/board/round-codes";
import { feedLabels, type FeedRow } from "@/lib/schedule-board";
import { matchRef, resolveSlotLabel, type SlotLabelLookup } from "@/lib/slot-label";

export interface ScanMatchNames {
  /** The match, as the board's card names it. */
  ref: string;
  /** What each seat is called while it has no entrant. Read only for an
   *  empty seat: a seated one prints its entrant's name. */
  home: string;
  away: string;
  /** The round, as the board's legend names it ("Final", "Semi-finals");
   *  "Round n" where the board codes no round and prints its number. */
  roundLabel: string;
}

/** The `fixtures` columns the board's naming reads: its round codes, its feed
 *  map and each seat's stored label. Select exactly these (`tx(MATCH_NAME_COLS)`)
 *  so every reader that names a match reads the same row. */
export const MATCH_NAME_COLS = [
  "id",
  "stage_id",
  "round_no",
  "seq_in_round",
  "ext_key",
  "lane",
  "is_final",
  "third_place",
  "conditional",
  "home_entrant_id",
  "away_entrant_id",
  "home_slot_label",
  "away_slot_label",
  "winner_to_fixture",
  "winner_to_slot",
  "loser_to_fixture",
  "loser_to_slot",
] as const;

export type MatchNameRow = RoundCodeFixture & SeatLabelFixture & FeedRow & { stage_id: string };

/**
 * Names fixtures the way the board does, computing the round codes and the
 * seat map ONCE over `rows` — the scan page names one fixture, a printed
 * scorer sheet (usecases/scorer-sheets.ts) names a whole day's. `rows` must
 * hold every fixture a seat's feeder can be: a whole division at least (cross
 * feeds never leave one), and `stages` their stages. Returns undefined for an
 * id `rows` does not hold.
 */
export function boardMatchNamer(
  rows: readonly MatchNameRow[],
  stages: readonly { id: string; kind: string }[],
  lookup: SlotLabelLookup,
): (fixtureId: string) => ScanMatchNames | undefined {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const codes = boardRoundCodes(rows, stages, lookup);
  const seatMap = withRoundCodeRefs(rows, feedLabels(rows), codes);
  return (fixtureId) => {
    const self = byId.get(fixtureId);
    if (self === undefined) return undefined;
    const rc = codes.get(fixtureId);
    const seats = seatMap[fixtureId];
    const seat = (side: "home" | "away") =>
      resolveSlotLabel(
        seats?.[side] ?? (side === "home" ? self.home_slot_label : self.away_slot_label) ?? null,
        lookup,
        "schedule.tbd",
      );
    return {
      ref: matchRef(self.round_no, rc?.refSeq ?? self.seq_in_round, lookup, rc?.code),
      home: seat("home"),
      away: seat("away"),
      roundLabel: rc?.label ?? lookup("schedule.round", { n: self.round_no }),
    };
  };
}

export async function scanMatchNames(tx: Tx, fixtureId: string, lookup: SlotLabelLookup): Promise<ScanMatchNames> {
  const rows = await tx<MatchNameRow[]>`
    select ${tx(MATCH_NAME_COLS)}
    from fixtures
    where division_id = (select division_id from fixtures where id = ${fixtureId})`;
  const stages = await tx<{ id: string; kind: string }[]>`
    select id, kind from stages where division_id = (select division_id from fixtures where id = ${fixtureId})`;
  const names = boardMatchNamer(rows, stages, lookup)(fixtureId);
  if (names === undefined) throw new Error(`scanMatchNames: fixture ${fixtureId} not found`);
  return names;
}
