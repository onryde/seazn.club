// Fix round N1 — the PUBLIC text for a side still waiting on a match.
//
// A slot fed by an earlier match stores `{ key: "slot.winner_match" |
// "slot.loser_match", params: { round, seq } }`: the FEEDER's `round_no` and
// `seq_in_round` (`usecases/stages.ts`, `matchSlotLabel`). `resolveSlotLabel`
// (`lib/slot-label.ts`) renders that as "Winner of R3·2" — `matchRef`, the
// organiser schedule board's short code, which the board depends on and which
// means nothing on a public page. A spectator reading a Semi-finals card under
// a rail that says "Quarter-finals" saw "Winner of R3·2".
//
// So the public surfaces (the hub's cards and Draw nodes, the match centre)
// name the feeder's ROUND the way the Knockout rail names it, plus the match's
// place in that round: "Winner of Quarter-finals, match 2". Both come from here
// so the two builders cannot word it differently, and the round name comes from
// `fixtureRoundLabel` — the one namer the hub also labels every round with, so
// a slot's round and the rail chip above it are the same string.
//
// Pure: no `server-only`, no database. The callers own the lookups.
import { resolveSlotLabel, type SlotLabelLookup } from "@/lib/slot-label";
import { roundRoleFor, roundRoleLabel, type LaneRoundFixture } from "@/lib/round-role-label";
import type { SlotLabel } from "@/server/usecases/stage-seeding";

/** The fields a fixture's round ROLE is read from. `PublicFixture` declares the
 *  flags optional, so they are coerced here rather than at every caller. */
export interface RoundRoleFixture {
  round_no: number;
  lane?: "WB" | "LB" | "GF" | null;
  is_final?: boolean | null;
  third_place?: boolean | null;
  conditional?: boolean | null;
}

/**
 * A fixture's round name — "Quarter-finals", "Losers' round 2", "Round 3" —
 * ranked within `laneRows`, which MUST be the fixture's own stage.
 *
 * `roundRoleFor` answers for EVERY stage kind (a non-bracket stage's rounds
 * come back as `plain_round`), so there is no bracket-kind guard. But its rank
 * filters by LANE only, and `lane` is null for a league AND for a
 * single-elimination bracket: pool two stages and a knockout final in a
 * division whose league ran more rounds reads "Semi-finals". Stage scoping is
 * the caller's job, and both callers do it.
 */
export function fixtureRoundLabel(
  ui: SlotLabelLookup,
  laneRows: readonly LaneRoundFixture[],
  fixture: RoundRoleFixture,
  stageKind: string,
): string {
  return roundRoleLabel(
    ui,
    roundRoleFor(
      laneRows,
      {
        round_no: fixture.round_no,
        lane: fixture.lane ?? null,
        is_final: fixture.is_final === true,
        third_place: fixture.third_place === true,
        conditional: fixture.conditional === true,
      },
      stageKind,
      null,
    ),
  );
}

/**
 * `(round, seq)` → the fixture at that place in ONE stage's rows. The pair
 * names exactly one fixture of a stage: `bracketToGen` offsets `round_no` per
 * lane (losers' past winners', grand final past both) and counts
 * `seq_in_round` per (lane, round) — which is also why the bronze match, sharing
 * the final's round, is its seq 2.
 */
export function stageFixtureAt<T extends { round_no: number; seq_in_round: number }>(
  stageRows: readonly T[],
): (round: number, seq: number) => T | undefined {
  const at = new Map(stageRows.map((f) => [`${f.round_no}:${f.seq_in_round}`, f]));
  return (round, seq) => at.get(`${round}:${seq}`);
}

export type FeederPhraseKey = "knockout.feederWinner" | "knockout.feederLoser";

/**
 * An unfilled side's public text.
 *
 * A feeder label whose `{round, seq}` names a match of the side's stage reads
 * `phrase(key, { round: <that match's round name>, seq })`. Anything else keeps
 * exactly today's text (`resolveSlotLabel`, "TBD" fallback): a group-finish
 * label, a bye, no label at all — and a feeder label that maps to no match, so
 * a stale reference never renders a sentence with a hole in it.
 *
 * `roundOf` returns the round name of the stage's match at `(round, seq)`, or
 * null when there is none.
 */
export function publicSlotLabel(
  label: SlotLabel | null,
  ui: SlotLabelLookup,
  phrase: (key: FeederPhraseKey, vars: { round: string; seq: number }) => string,
  roundOf: (round: number, seq: number) => string | null,
): string {
  const key: FeederPhraseKey | null =
    label?.key === "slot.winner_match"
      ? "knockout.feederWinner"
      : label?.key === "slot.loser_match"
        ? "knockout.feederLoser"
        : null;
  if (label !== null && key !== null) {
    const seq = Number(label.params.seq);
    const round = roundOf(Number(label.params.round), seq);
    if (round !== null) return phrase(key, { round, seq });
  }
  return resolveSlotLabel(label, ui, "schedule.tbd");
}
