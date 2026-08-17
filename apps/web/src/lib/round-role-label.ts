// F1 Task 3 — maps the engine's typed RoundRole (packages/engine/src/
// competition/round-role.ts) to a localized display string. The engine
// returns roles, never English (see that module's own header comment); this
// is the ONE place a role becomes text, so every consumer (public bracket,
// console stages panel, console bracket panel, day-one preview, the export
// poster) renders the SAME word for the SAME position instead of drifting
// onto four different namers the way this session exists to fix (design
// 2026-08-17 §2.3).
//
// `@seazn/engine` has no bare root export (its package.json exports map is
// subpaths only) — import from `@seazn/engine/competition`.
import { roundRole, type RoundRole } from "@seazn/engine/competition";
import type { MessageKey } from "@/lib/messages";

// No shared `Msg` type exists in this codebase (verified — every consumer
// that needs one, e.g. components/v2/stages-panel.tsx, aliases it locally);
// match that convention rather than inventing a cross-cutting export.
type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** Role -> locale string. */
export function roundRoleLabel(msg: Msg, role: RoundRole): string {
  switch (role.kind) {
    case "round_of":
      return msg("bracket.round.roundOf", { n: role.entrants });
    case "quarter_final":
      return msg("bracket.round.quarter");
    case "semi_final":
      return msg("bracket.round.semi");
    case "final":
      return msg("bracket.round.final");
    case "winners_final":
      return msg("bracket.round.winnersFinal");
    case "losers_round":
      return msg("bracket.round.losersRound", { n: role.n });
    case "losers_final":
      return msg("bracket.round.losersFinal");
    case "grand_final":
      return msg("bracket.round.grandFinal");
    case "grand_final_reset":
      return msg("bracket.round.grandFinalReset");
    case "third_place":
      return msg("bracket.round.thirdPlace");
    case "qualifier1":
      return msg("bracket.round.qualifier1");
    case "eliminator":
      return msg("bracket.round.eliminator");
    case "qualifier2":
      return msg("bracket.round.qualifier2");
    case "rung":
      return msg("bracket.round.rung", { n: role.n });
    case "plain_round":
      return msg("bracket.round.plain", { n: role.n });
  }
}

/** Shape every bracket-fixture reader needs for `laneRoundRank` below —
 *  structural, so a `PublicFixture`/`FixtureRow`/`FixtureLike` row satisfies
 *  it without a cast. */
export interface LaneRoundFixture {
  round_no: number;
  lane: "WB" | "LB" | "GF" | null;
}

/** A fixture's 0-based rank within its OWN lane, plus that lane's last
 *  index — the two numbers `roundRole()` needs. Never rank across the whole
 *  stage: a double-elim's losers bracket has more rounds than its winners
 *  bracket, and a global rank silently reintroduces the count-based naming
 *  bug this whole module exists to kill (`_RULES.md` §2). `lane` is read
 *  per fixture (never assumed uniform across the list) because WB/LB/GF
 *  round_no ranges interleave in persistence order but never share a lane. */
export function laneRoundRank(
  fixtures: readonly LaneRoundFixture[],
  lane: "WB" | "LB" | "GF" | null,
  roundNo: number,
): { roundInLane: number; lastRoundInLane: number } {
  const laneRounds = [...new Set(fixtures.filter((f) => f.lane === lane).map((f) => f.round_no))].sort(
    (a, b) => a - b,
  );
  const roundInLane = laneRounds.indexOf(roundNo);
  return {
    roundInLane: roundInLane === -1 ? 0 : roundInLane,
    lastRoundInLane: Math.max(0, laneRounds.length - 1),
  };
}

/** Convenience composite: rank `target` within `all` by lane, then resolve
 *  its RoundRole. The role-affecting flags (`isFinal`/`thirdPlace`/
 *  `conditional`/`extKey`) come from `target` itself, never from the wider
 *  list — only the RANK is a group computation. */
export function roundRoleFor(
  all: readonly LaneRoundFixture[],
  target: {
    round_no: number;
    lane: "WB" | "LB" | "GF" | null;
    is_final: boolean;
    third_place: boolean;
    conditional: boolean;
  },
  stageKind: string,
  extKey: string | null = null,
): RoundRole {
  const { roundInLane, lastRoundInLane } = laneRoundRank(all, target.lane, target.round_no);
  return roundRole({
    stageKind,
    lane: target.lane,
    roundInLane,
    lastRoundInLane,
    isFinal: target.is_final,
    thirdPlace: target.third_place,
    conditional: target.conditional,
    extKey,
  });
}
