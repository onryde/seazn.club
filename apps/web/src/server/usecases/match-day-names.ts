import "server-only";
// What the phone's Match Day list calls a match and its empty seats (F-T8-3, F-T8-4; owner, 13 Nov 2026): the tag "SF·1" and the
// seat text "Winner of Group A", exactly as the desk and the schedule board print them. No naming rule lives here: the board's own
// `boardRoundCodes` (the code and the match's `refSeq`), `withRoundCodeRefs` over `feedLabels` (a seat's feeder, in the board's
// order: the feed edge first, the stored label when there is none), `matchRef` and `resolveSlotLabel` do it, the way
// `boardMatchNamer` (scan-match-names.ts) does for the scorer's screens. This module differs from it in two answers the phone
// needs: a seat the web has no label for is null (not "To be decided"), and a round with one match is its bare code ("F").
import type { Tx } from "@/lib/db";
import { boardRoundCodes, withRoundCodeRefs } from "@/components/v2/board/round-codes";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { unseatedForfeitLoserName, unseatedWithdrew } from "@/lib/forfeit-tag";
import { feedLabels } from "@/lib/schedule-board";
import { matchRef, resolveSlotLabel } from "@/lib/slot-label";
import { MATCH_NAME_COLS, type MatchNameRow } from "./scan-match-names";

export type MatchDayNames = {
  /** "SF·1", "F", or the round's `R{n}` where the board codes no round. */
  tag: string;
  /** A seat's text while it has no entrant and the web has a label for it; null otherwise. */
  homeSlot: string | null;
  awaySlot: string | null;
};

/** Each of `shown` (fixture id, with its division) named by the board, in the reader's language (`dict`: load it before the
 *  transaction). Reads whole divisions: a seat's feeder can be anywhere in its division (cross feeds never leave one). */
export async function readMatchDayNames(
  tx: Tx,
  shown: readonly { id: string; division_id: string; round_no: number; home_entrant_id: string | null; away_entrant_id: string | null }[],
  dict: Dict,
): Promise<Map<string, MatchDayNames>> {
  const divisions = [...new Set(shown.map((r) => r.division_id))];
  if (divisions.length === 0) return new Map();
  const rows = await tx<MatchNameRow[]>`
    select ${tx(MATCH_NAME_COLS)} from fixtures where division_id in ${tx(divisions)}`;
  const stages = await tx<{ id: string; kind: string }[]>`select id, kind from stages where division_id in ${tx(divisions)}`;
  const lookup = (key: Parameters<typeof t>[1], vars?: Record<string, string | number>) => t(dict, key, vars);
  const codes = boardRoundCodes(rows, stages, lookup);
  const seatMap = withRoundCodeRefs(rows, feedLabels(rows), codes);
  const perCode = new Map<string, number>();
  for (const r of rows) {
    const rc = codes.get(r.id);
    if (rc !== undefined) perCode.set(`${r.stage_id}|${rc.code}`, (perCode.get(`${r.stage_id}|${rc.code}`) ?? 0) + 1);
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  // R116-4 (owner ruling 116): a seat a walkover was won over keeps the bye label it was stamped with; it names her instead.
  const awards = await tx<{ id: string; outcome: unknown; home_entrant_id: string | null; away_entrant_id: string | null; forfeit_loser_name: string | null }[]>`
    select f.id, f.outcome, f.home_entrant_id, f.away_entrant_id, le.display_name as forfeit_loser_name
    from fixtures f
    left join entrants le on le.division_id = f.division_id and le.id::text = f.outcome->>'loser'
    where f.id in ${tx(shown.map((r) => r.id))}`;
  const awardOf = new Map(awards.map((a) => [a.id, a]));
  const out = new Map<string, MatchDayNames>();
  for (const s of shown) {
    const self = byId.get(s.id);
    if (self === undefined) continue;
    const rc = codes.get(s.id);
    const alone = rc !== undefined && perCode.get(`${self.stage_id}|${rc.code}`) === 1;
    const seat = (side: "home" | "away"): string | null => {
      if ((side === "home" ? s.home_entrant_id : s.away_entrant_id) !== null) return null;
      const award = awardOf.get(s.id);
      const her = award === undefined ? null : unseatedForfeitLoserName(award, side);
      if (her !== null) return award !== undefined && unseatedWithdrew(award, side) ? lookup("schedule.withdrawnSide", { name: her }) : her;
      const label = seatMap[s.id]?.[side] ?? (side === "home" ? self.home_slot_label : self.away_slot_label) ?? null;
      return label === null ? null : resolveSlotLabel(label, lookup, "schedule.tbd");
    };
    out.set(s.id, {
      tag: rc === undefined ? `R${s.round_no}` : alone ? rc.code : matchRef(s.round_no, rc.refSeq, lookup, rc.code),
      homeSlot: seat("home"),
      awaySlot: seat("away"),
    });
  }
  return out;
}
