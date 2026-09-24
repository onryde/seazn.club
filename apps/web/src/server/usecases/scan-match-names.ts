import "server-only";
// Scorer sheets §4.5 — how the scan screens name the match (Confirm's "Match"
// line) and each seat still waiting for its feeder (Waiting's "Winner of …").
// OWNER RULING 2026-09-24: exactly as the schedule board names them (#851/#854)
// — "QF·1", "Winner of QF·2", "Q2·1", "3rd·1" — never "R2·1", except where the
// board itself prints that (a round it does not code, e.g. a league).
//
// The board's own functions over the board's own columns, the same path the
// next-match refusal takes (engine-db/fed-seats.ts `boardRef`): `boardRoundCodes`
// over every row of the fixture's stage, `matchRef` (→ `composeMatchRef`) with
// the board's `refSeq`, and `withRoundCodeRefs` for the seats. Unlike that
// refusal, this page knows its reader, so the codes render in the viewer's
// language here (`lookup`) instead of travelling as dictionary keys. Stored
// seat labels name a feeder in the SAME stage (`{round, seq}`, stages.ts), so
// that stage's rows are all the lookup needs.
import type { Tx } from "@/lib/db";
import {
  boardRoundCodes,
  withRoundCodeRefs,
  type RoundCodeFixture,
  type SeatLabelFixture,
} from "@/components/v2/board/round-codes";
import { matchRef, resolveSlotLabel, type SlotLabelLookup } from "@/lib/slot-label";

export interface ScanMatchNames {
  /** The match, as the board's card names it. */
  ref: string;
  /** What each seat is called while it has no entrant. Read only for an
   *  empty seat: a seated one prints its entrant's name. */
  home: string;
  away: string;
}

type Row = RoundCodeFixture & SeatLabelFixture;

export async function scanMatchNames(tx: Tx, fixtureId: string, lookup: SlotLabelLookup): Promise<ScanMatchNames> {
  const rows = await tx<Row[]>`
    select id, stage_id, round_no, seq_in_round, ext_key, lane, is_final, third_place, conditional,
           home_entrant_id, away_entrant_id, home_slot_label, away_slot_label
    from fixtures
    where stage_id = (select stage_id from fixtures where id = ${fixtureId})`;
  const self = rows.find((r) => r.id === fixtureId);
  if (self === undefined) throw new Error(`scanMatchNames: fixture ${fixtureId} not found`);
  const stages = await tx<{ id: string; kind: string }[]>`select id, kind from stages where id = ${self.stage_id}`;
  const codes = boardRoundCodes(rows, stages, lookup);
  const rc = codes.get(fixtureId);
  const seats = withRoundCodeRefs(rows, {}, codes)[fixtureId];
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
  };
}
