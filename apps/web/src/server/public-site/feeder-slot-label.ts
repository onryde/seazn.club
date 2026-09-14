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
// When the feeder's round holds ONE match the number says nothing, so the
// sentence names the round alone: "Winner of Grand final" (N1 fix round 1, M2).
//
// Every public caller — the hub, the match centre — builds its names through
// `publicRoundNamer` below, so the ranking, the round name and the one-match
// count are computed one way.
//
// Pure: no `server-only`, no database. The callers own the reads.
import { resolveSlotLabel, type SlotLabelLookup } from "@/lib/slot-label";
import { roundRoleFor, roundRoleLabel, type LaneRoundFixture } from "@/lib/round-role-label";
import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
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

export type FeederPhraseKey =
  | "knockout.feederWinner"
  | "knockout.feederLoser"
  | "knockout.feederWinnerOnly"
  | "knockout.feederLoserOnly";

/** The feeder match's round, as a waiting side names it: the rail's round name,
 *  and how many matches that round holds. */
export interface FeederRound {
  name: string;
  matches: number;
}

/**
 * An unfilled side's public text.
 *
 * A feeder label whose `{round, seq}` names a match of the side's stage reads
 * that match's round name plus its place in the round — "Winner of
 * Quarter-finals, match 2" — or, when the round holds ONE match, the round name
 * alone: "Winner of Grand final". Anything else keeps exactly today's text
 * (`resolveSlotLabel`, "TBD" fallback): a group-finish label, a bye, no label at
 * all — and a feeder label that maps to no match, so a stale reference never
 * renders a sentence with a hole in it.
 *
 * `roundOf` returns the round of the stage's match at `(round, seq)`, or null
 * when there is none.
 */
export function publicSlotLabel(
  label: SlotLabel | null,
  ui: SlotLabelLookup,
  phrase: (key: FeederPhraseKey, vars: Record<string, string | number>) => string,
  roundOf: (round: number, seq: number) => FeederRound | null,
): string {
  const winner = label?.key === "slot.winner_match";
  if (label !== null && (winner || label.key === "slot.loser_match")) {
    const seq = Number(label.params.seq);
    const round = roundOf(Number(label.params.round), seq);
    if (round !== null) {
      return round.matches === 1
        ? phrase(winner ? "knockout.feederWinnerOnly" : "knockout.feederLoserOnly", { round: round.name })
        : phrase(winner ? "knockout.feederWinner" : "knockout.feederLoser", { round: round.name, seq });
    }
  }
  return resolveSlotLabel(label, ui, "schedule.tbd");
}

/** A fixture as `publicRoundNamer` reads it: its stage, its place in its round,
 *  and the flags its round's role is read from. */
export interface NamedFixture extends RoundRoleFixture {
  id: string;
  stage_id: string;
  seq_in_round: number;
}

export interface PublicRoundNamer {
  /** The fixture's round name, the text the Knockout rail shows for its round;
   *  null when the fixture's stage is unknown. */
  roundLabel(fixtureId: string): string | null;
  /** An unfilled side's text, its feeder looked up in `stageId`: the side's OWN
   *  stage, because a league's round 1 match 2 and a knockout's share a
   *  `{round, seq}`. */
  slot(stageId: string, label: SlotLabel | null): string;
}

/**
 * The one public namer for a set of fixtures — a division's, or one stage's.
 *
 * Each fixture is ranked within its OWN stage. `laneRoundRank` filters by lane
 * only, and `lane` is null for a league AND for a single-elimination bracket,
 * so a list pooled across stages puts a league's rounds and a knockout's in one
 * sorted sequence: a knockout final in a division whose league ran more rounds
 * printed "Semi-finals" (measured, on the ordinary league-then-knockout shape).
 * `fixtureRoundLabel` answers for every stage kind (a non-bracket stage's rounds
 * come back as `plain_round`), so there is no bracket-kind guard here.
 *
 * A feeder's round holds the fixtures of its stage at its `round_no` that carry
 * its round name — the rail's own round — counted from these fixtures, never a
 * table.
 */
export function publicRoundNamer(a: {
  ui: SlotLabelLookup;
  /** The PUBLIC dictionary, in the same locale as `ui`. */
  dict: Dict;
  fixtures: readonly NamedFixture[];
  /** The stage's kind, or undefined for a stage the caller does not know. */
  stageKind: (stageId: string) => string | undefined;
}): PublicRoundNamer {
  const byStage = new Map<string, NamedFixture[]>();
  for (const f of a.fixtures) {
    const rows = byStage.get(f.stage_id) ?? [];
    rows.push(f);
    byStage.set(f.stage_id, rows);
  }

  const nameById = new Map<string, string | null>();
  const matchesInRound = new Map<string, number>();
  const roundKey = (stageId: string, roundNo: number, name: string) => JSON.stringify([stageId, roundNo, name]);
  for (const [stageId, rows] of byStage) {
    const kind = a.stageKind(stageId);
    const laneRows = rows.map((f) => ({ round_no: f.round_no, lane: f.lane ?? null }));
    for (const f of rows) {
      const name = kind === undefined ? null : fixtureRoundLabel(a.ui, laneRows, f, kind);
      nameById.set(f.id, name);
      if (name === null) continue;
      const key = roundKey(stageId, f.round_no, name);
      matchesInRound.set(key, (matchesInRound.get(key) ?? 0) + 1);
    }
  }
  const fixtureAt = new Map([...byStage].map(([stageId, rows]) => [stageId, stageFixtureAt(rows)]));

  return {
    roundLabel: (fixtureId) => nameById.get(fixtureId) ?? null,
    slot: (stageId, label) =>
      publicSlotLabel(
        label,
        a.ui,
        (key, vars) => t(a.dict, key, vars),
        (round, seq) => {
          const feeder = fixtureAt.get(stageId)?.(round, seq);
          const name = feeder === undefined ? null : (nameById.get(feeder.id) ?? null);
          if (feeder === undefined || name === null) return null;
          // The feeder is one of the fixtures counted under its own key.
          return { name, matches: matchesInRound.get(roundKey(stageId, feeder.round_no, name)) ?? 1 };
        },
      ),
  };
}
