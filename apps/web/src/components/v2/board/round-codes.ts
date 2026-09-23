// Knockout round codes on the schedule board (2026-09-23, owner-approved
// design). The card chip used to read `R{round_no}` for every stage, so an
// organiser could not tell a quarter-final from a semi-final on the board. A
// knockout or double-elimination card now reads its round's short code — QF,
// SF, F, 3rd, R16, WB2, LB3, GF — a "Winner of …" placeholder names its feeder
// the same way ("Winner of QF·3"), and a legend row explains the codes in view.
//
// Every code comes from the engine's `roundRole()` (via `roundRoleFor`) and
// `roundRoleShort` — the SAME position rules every other bracket surface names
// rounds by — so the board cannot invent its own reading of a bracket. Only
// `knockout` and `double_elim` are coded: a round-robin/Swiss round keeps its
// plain `R{n}`, and a page playoff waits for a follow-up (the board payload
// carries no `ext_key`, the only thing that tells Qualifier 1 from the
// Eliminator — without it the engine would call them quarter-finals).
//
// Pure and client-safe: the board computes this ONCE per fixture list
// (schedule-board.tsx, memoised), never per card per render.
import { laneRoundRank, roundRoleBoardLabel, roundRoleFor, roundRoleShort } from "@/lib/round-role-label";
import type { MessageKey } from "@/lib/messages";
import type { FeedLabelPair } from "@/lib/schedule-board";
import type { SlotLabel } from "@/server/usecases/stage-seeding";
import type { BoardFixture, BoardStage } from "./types";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;
type Lane = "WB" | "LB" | "GF" | null;

export interface BoardRoundCode {
  /** The chip text — "QF", "WB2". */
  code: string;
  /** The round's full name — "Quarter-finals", "Winners' round 2" — for the
   *  card's accessible name, its tooltip and the legend.
   *  `roundRoleBoardLabel`'s: lane-aware wherever the code is. */
  label: string;
  /** Legend order, compared left to right: lane (single bracket, WB, LB, GF);
   *  then position — distance from the final for a single bracket (so a
   *  bigger bracket's R32 precedes another's R16), round within the lane
   *  otherwise; then the third-place match or bracket reset after the round
   *  it shares. */
  order: readonly [number, number, number];
}

/** The stage kinds whose rounds get a code. See the header for why these two. */
const CODED_STAGE_KINDS: ReadonlySet<string> = new Set(["knockout", "double_elim"]);

const LANE_ORDER: Record<string, number> = { null: 0, WB: 1, LB: 2, GF: 3 };

/**
 * Fixture id -> its round code, for every fixture of a coded stage. A fixture
 * absent from the map keeps its `R{round_no}` chip.
 *
 * Ranked per STAGE, never across the list: `laneRoundRank` filters by lane
 * only and `lane` is null for a league and a single-elimination bracket alike,
 * so a pooled rank puts a league's rounds in front of a knockout's and prints
 * its final as a semi-final (the defect `feeder-slot-label.ts` records).
 *
 * A stage generated before V368 (2026-08-17) is left uncoded — every one of its
 * fixtures keeps `R{n}` (review M2). V368 added lane / is_final / third_place /
 * conditional with no backfill, so such a stage reads as the column defaults
 * throughout: its bronze match is indistinguishable from its final (a second
 * "F") and a double elimination's three lanes collapse into one (its opening
 * round an "R512"). A guessed code is worse than the plain one (AGENTS.md
 * class 19). The discriminator is `is_final`: NOT NULL DEFAULT FALSE, and set
 * by every bracket writer since (stages.ts) on the single-elimination final and
 * the grand-final games — so a coded stage with no `is_final` row is legacy.
 */
export function boardRoundCodes(
  fixtures: readonly BoardFixture[],
  stages: readonly Pick<BoardStage, "id" | "kind">[],
  msg: Msg,
): ReadonlyMap<string, BoardRoundCode> {
  const kindOf = new Map(stages.map((s) => [s.id, s.kind]));
  const byStage = new Map<string, BoardFixture[]>();
  for (const f of fixtures) {
    const kind = kindOf.get(f.stage_id);
    if (kind === undefined || !CODED_STAGE_KINDS.has(kind)) continue;
    const rows = byStage.get(f.stage_id);
    if (rows) rows.push(f);
    else byStage.set(f.stage_id, [f]);
  }

  const out = new Map<string, BoardRoundCode>();
  for (const [stageId, rows] of byStage) {
    // Pre-V368: no role metadata to name its rounds by — see above.
    if (!rows.some((f) => f.is_final === true)) continue;
    const kind = kindOf.get(stageId)!;
    const laneRows = rows.map((f) => ({ round_no: f.round_no, lane: f.lane ?? null }));
    // One role per distinct (lane, round, flags) — a round's matches share it.
    const perRound = new Map<string, BoardRoundCode | null>();
    for (const f of rows) {
      const lane: Lane = f.lane ?? null;
      const thirdPlace = f.third_place === true;
      const conditional = f.conditional === true;
      const key = `${lane}|${f.round_no}|${thirdPlace}|${conditional}`;
      let rc = perRound.get(key);
      if (rc === undefined) {
        const { roundInLane, lastRoundInLane } = laneRoundRank(laneRows, lane, f.round_no);
        const role = roundRoleFor(
          laneRows,
          // `roundRole()` never reads `is_final` (round-role.ts destructures
          // everything BUT `isFinal`); it is only the legacy test above.
          { round_no: f.round_no, lane, is_final: f.is_final === true, third_place: thirdPlace, conditional },
          kind,
        );
        const code = roundRoleShort(msg, role, { lane, roundInLane });
        rc =
          code === null
            ? null
            : {
                code,
                label: roundRoleBoardLabel(msg, role, { lane, roundInLane }),
                order: [
                  LANE_ORDER[String(lane)] ?? 0,
                  lane === null ? roundInLane - lastRoundInLane : roundInLane,
                  thirdPlace || conditional ? 1 : 0,
                ],
              };
        perRound.set(key, rc);
      }
      if (rc !== null) out.set(f.id, rc);
    }
  }
  return out;
}

const MATCH_REF_KEYS: ReadonlySet<string> = new Set(["slot.winner_match", "slot.loser_match"]);

/**
 * The board's feed-label map with each knockout feeder's round code stamped on
 * — `params.code`, which `resolveSlotLabel` prints as "Winner of QF·3" in
 * place of "Winner of R1·3".
 *
 * Covers BOTH label sources a card title reads, in `cardTitle`'s own order:
 * the feed edge first, the stored `*_slot_label` when there is none. A stored
 * label is copied into the returned map (as that seat's entry) only when it
 * gains a code, so precedence is unchanged. A seat that already has its
 * entrant is skipped: `cardTitle` prints the name there.
 *
 * `{round, seq}` is resolved inside ONE stage — the label's own `params.stage`
 * when a cross-stage edge carries one (`feedLabels`), the seat's stage
 * otherwise. A ref that names no coded fixture keeps its plain text.
 *
 * Returns the input object itself when nothing changes, so a league-only board
 * keeps a stable reference through its memo.
 */
export function withRoundCodeRefs(
  fixtures: readonly BoardFixture[],
  feeds: Record<string, FeedLabelPair>,
  codes: ReadonlyMap<string, BoardRoundCode>,
): Record<string, FeedLabelPair> {
  if (codes.size === 0) return feeds;
  const at = new Map<string, string>();
  for (const f of fixtures) {
    if (codes.has(f.id)) at.set(`${f.stage_id}:${f.round_no}:${f.seq_in_round}`, f.id);
  }

  let out: Record<string, FeedLabelPair> | null = null;
  for (const f of fixtures) {
    for (const side of ["home", "away"] as const) {
      if (side === "home" ? f.home_entrant_id : f.away_entrant_id) continue;
      const stored = side === "home" ? f.home_slot_label : f.away_slot_label;
      const label: SlotLabel | null = feeds[f.id]?.[side] ?? stored ?? null;
      if (label === null || !MATCH_REF_KEYS.has(label.key)) continue;
      const stage = typeof label.params.stage === "string" ? label.params.stage : f.stage_id;
      const ref = at.get(`${stage}:${Number(label.params.round)}:${Number(label.params.seq)}`);
      const code = ref === undefined ? undefined : codes.get(ref)?.code;
      if (code === undefined) continue;
      out ??= { ...feeds };
      out[f.id] = { ...out[f.id], [side]: { key: label.key, params: { ...label.params, code } } };
    }
  }
  return out ?? feeds;
}

/** One legend entry: a code and the round it stands for. */
export interface RoundLegendEntry {
  code: string;
  label: string;
}

/**
 * The legend row's entries: each code carried by `fixtures` (the cards in
 * view), once, in bracket order. Empty when no card is coded — the legend then
 * renders nothing.
 *
 * Ordered by `BoardRoundCode.order`: lane, then distance from the final for a
 * single bracket (so a 16-knockout's R16 precedes an 8-knockout's QF on one
 * competition board), then the third-place match / bracket reset after the
 * round it shares — and only then by name, so a locale whose "third place"
 * sorts before its "final" (nl) still lists F first.
 *
 * Deduplicated on code AND name together: two knockouts' QF list once, but a
 * locale that ever abbreviated two different rounds alike would list both
 * rather than explain one of them with the other's name.
 */
export function roundLegendEntries(
  fixtures: readonly Pick<BoardFixture, "id">[],
  codes: ReadonlyMap<string, BoardRoundCode>,
): RoundLegendEntry[] {
  const seen = new Map<string, BoardRoundCode>();
  for (const f of fixtures) {
    const rc = codes.get(f.id);
    if (rc) seen.set(JSON.stringify([rc.code, rc.label]), rc);
  }
  return [...seen.values()]
    .sort(
      (a, b) =>
        a.order[0] - b.order[0] ||
        a.order[1] - b.order[1] ||
        a.order[2] - b.order[2] ||
        a.label.localeCompare(b.label),
    )
    .map(({ code, label }) => ({ code, label }));
}
