// Knockout round codes on the schedule board (2026-09-23, owner-approved
// design). The card chip used to read `R{round_no}` for every stage, so an
// organiser could not tell a quarter-final from a semi-final on the board. A
// knockout or double-elimination card now reads its round's short code — QF,
// SF, F, 3rd, R16, WB2, LB3, GF — a "Winner of …" placeholder names its feeder
// the same way ("Winner of QF·3"), and a legend row explains the codes in view.
//
// Every code comes from the engine's `roundRole()` (via `roundRoleFor`) and
// `roundRoleShort` — the SAME position rules every other bracket surface names
// rounds by — so the board cannot invent its own reading of a bracket. The
// bracket kinds are coded; a round-robin/Swiss round keeps its plain `R{n}`.
//
// Board playoff codes (2026-09-23, owner-approved follow-up): a page playoff
// reads Q1 / E / Q2 / F and a stepladder E1 … E{n} / F. The page playoff is
// named by its fixtures' `ext_key` ("pp-q1", "pp-elim", …), which the board
// read now carries for page-playoff rows only — Qualifier 1 and the Eliminator
// share a round, a match count and every flag, so without the key the engine
// can only call them quarter-finals.
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
  /** The chip text — "QF", "WB2", "Q1", "E2". */
  code: string;
  /** The round's full name — "Quarter-finals", "Winners' round 2",
   *  "Eliminator 2" — for the card's accessible name, its tooltip and the
   *  legend. `roundRoleBoardLabel`'s: lane-aware wherever the code is. */
  label: string;
  /** The number after the code when a match is referred to — "QF·3",
   *  "Winner of E·1": this fixture's place, in seq_in_round order, among its
   *  stage's fixtures with the same round role — the same (lane, round_no,
   *  third-place flag, reset flag, page-playoff ext_key), the key the role is
   *  cached by, which is one code per stage in every generator's output. For
   *  an ordinary knockout or double-elimination round that is its
   *  seq_in_round, as before. It differs where two roles share a round: the
   *  page playoff's Eliminator is the SECOND match of round 1 (beside
   *  Qualifier 1) and the only Eliminator, so E·1, not E·2; and a bronze
   *  match, second in its final's round, is 3rd·1 where #851 read 3rd·2 (only
   *  the AI console's own code for it — nothing is fed from a bronze match). */
  refSeq: number;
  /** Legend order, compared left to right:
   *   1. group — each single-lane format's rounds before its final, one
   *      format at a time (knockout, page playoff, stepladder: so "Q1 E Q2"
   *      and "E1 E2" each read as one run); then the finals they share (F,
   *      and the bronze match beside it); then a double elimination's lanes,
   *      WB, LB, GF;
   *   2. position — a stepladder rung's own n (its code's number, counted
   *      from the ladder's start, so a 4-ladder's and a 6-ladder's E1 are one
   *      place); otherwise distance from the final in a single lane (so a
   *      bigger bracket's R32 precedes another's R16), round within the lane
   *      in a double elimination;
   *   3. the third-place match or bracket reset after the round it shares;
   *   4. the round's first seq_in_round — the generator's own emission order,
   *      which is what puts Qualifier 1 before the Eliminator in their shared
   *      round. */
  order: readonly [number, number, number, number];
}

/** The columns `boardRoundCodes` reads — a board row carries them, and so
 *  does a plain `fixtures` row, which is how the next-match refusal
 *  (server/engine-db/fed-seats.ts) names a match exactly as the board does. */
export type RoundCodeFixture = Pick<
  BoardFixture,
  "id" | "stage_id" | "round_no" | "seq_in_round" | "ext_key" | "lane" | "is_final" | "third_place" | "conditional"
>;

/** The columns `withRoundCodeRefs` reads — likewise a board row or a plain
 *  `fixtures` row, so the scan page names a waiting seat "Winner of QF·2"
 *  exactly as the board does (scorer sheets §4.5, owner ruling 2026-09-24). */
export type SeatLabelFixture = Pick<
  BoardFixture,
  "id" | "stage_id" | "round_no" | "seq_in_round" | "home_entrant_id" | "away_entrant_id" | "home_slot_label" | "away_slot_label"
>;

/** The stage kinds whose rounds get a code: every bracket kind. */
const CODED_STAGE_KINDS: ReadonlySet<string> = new Set(["knockout", "double_elim", "page_playoff", "stepladder"]);

/** Legend group of a single-lane format's rounds BEFORE its final. */
const PRE_FINAL_GROUP: Record<string, number> = { knockout: 0, page_playoff: 1, stepladder: 2 };
/** Every single-lane final — F, shared by all three — and the bronze match. */
const FINAL_GROUP = 3;
const LANE_GROUP: Record<"WB" | "LB" | "GF", number> = { WB: 4, LB: 5, GF: 6 };

/** The page-playoff generator's fixture ids (`generatePagePlayoff`) — the
 *  keys `roundRole()` names Qualifier 1 / Eliminator / Qualifier 2 / Final
 *  by. A hand copy (the engine keeps its table private); round-codes.test.ts
 *  pins it against the real generator's output. */
const PAGE_PLAYOFF_KEYS: ReadonlySet<string> = new Set(["pp-q1", "pp-elim", "pp-q2", "pp-final"]);

/**
 * Whether a coded stage's rows carry what its round names are read from — or
 * would be named by a guess. A guessed code is worse than the plain `R{n}`
 * (AGENTS.md class 19), so a stage that fails keeps `R{n}` on EVERY fixture.
 *
 * A page playoff is named by its keys and nothing else: every row must carry a
 * recognised `pp-*` ext_key. A row without one — a board read that lost the
 * key, or a stage history.ts re-inserted (it restores neither ext_key nor
 * is_final) — would be named by position: Qualifier 1 and the Eliminator both
 * "QF". `is_final` is NOT required: the keys predate V368, so a page playoff
 * generated before it is still named exactly.
 *
 * Every other bracket needs V368's columns (review M2). V368 added lane /
 * is_final / third_place / conditional with no backfill, so a stage generated
 * before it reads as the column defaults throughout: a knockout's bronze match
 * is indistinguishable from its final (a second "F") and a double
 * elimination's three lanes collapse into one (its opening round an "R512").
 * The discriminator is `is_final`: NOT NULL DEFAULT FALSE, and set by every
 * bracket writer since (stages.ts `bracketToGen`) on the single-elimination
 * final, the grand-final games and a stepladder's last game — so a stage with
 * no `is_final` row is legacy or history-restored. For a stepladder that flag
 * is the only evidence on its rows that its final is among them at all.
 */
function hasRoleMetadata(kind: string, rows: readonly RoundCodeFixture[]): boolean {
  if (kind === "page_playoff") {
    return rows.every((f) => typeof f.ext_key === "string" && PAGE_PLAYOFF_KEYS.has(f.ext_key));
  }
  return rows.some((f) => f.is_final === true);
}

/**
 * Fixture id -> its round code, for every fixture of a coded stage. A fixture
 * absent from the map keeps its `R{round_no}` chip.
 *
 * Ranked per STAGE, never across the list: `laneRoundRank` filters by lane
 * only and `lane` is null for a league and a single-elimination bracket alike,
 * so a pooled rank puts a league's rounds in front of a knockout's and prints
 * its final as a semi-final (the defect `feeder-slot-label.ts` records).
 *
 * A stage without the metadata its names are read from is left uncoded — see
 * `hasRoleMetadata`.
 */
export function boardRoundCodes(
  fixtures: readonly RoundCodeFixture[],
  stages: readonly Pick<BoardStage, "id" | "kind">[],
  msg: Msg,
): ReadonlyMap<string, BoardRoundCode> {
  const kindOf = new Map(stages.map((s) => [s.id, s.kind]));
  const byStage = new Map<string, RoundCodeFixture[]>();
  for (const f of fixtures) {
    const kind = kindOf.get(f.stage_id);
    if (kind === undefined || !CODED_STAGE_KINDS.has(kind)) continue;
    const rows = byStage.get(f.stage_id);
    if (rows) rows.push(f);
    else byStage.set(f.stage_id, [f]);
  }

  const out = new Map<string, BoardRoundCode>();
  for (const [stageId, unordered] of byStage) {
    const kind = kindOf.get(stageId)!;
    if (!hasRoleMetadata(kind, unordered)) continue;
    // Round/seq order, so each round's FIRST fixture (its `order` tiebreak)
    // and each fixture's `refSeq` are the same whatever order the list came in.
    const rows = [...unordered].sort((a, b) => a.round_no - b.round_no || a.seq_in_round - b.seq_in_round);
    const laneRows = rows.map((f) => ({ round_no: f.round_no, lane: f.lane ?? null }));
    // One role per distinct (lane, round, flags, page-playoff key) — a round's
    // matches share it, except a page playoff's round 1, where Qualifier 1 and
    // the Eliminator differ by their key alone.
    const perRound = new Map<string, { rc: Omit<BoardRoundCode, "refSeq">; count: number } | null>();
    for (const f of rows) {
      const lane: Lane = f.lane ?? null;
      const thirdPlace = f.third_place === true;
      const conditional = f.conditional === true;
      const extKey = kind === "page_playoff" ? (f.ext_key ?? null) : null;
      const key = `${lane}|${f.round_no}|${thirdPlace}|${conditional}|${extKey}`;
      let entry = perRound.get(key);
      if (entry === undefined) {
        const { roundInLane, lastRoundInLane } = laneRoundRank(laneRows, lane, f.round_no);
        const role = roundRoleFor(
          laneRows,
          // `roundRole()` never reads `is_final` (round-role.ts destructures
          // everything BUT `isFinal`); it is only the legacy test above.
          { round_no: f.round_no, lane, is_final: f.is_final === true, third_place: thirdPlace, conditional },
          kind,
          extKey,
        );
        const code = roundRoleShort(msg, role, { lane, roundInLane });
        const group =
          lane !== null
            ? LANE_GROUP[lane]
            : roundInLane === lastRoundInLane
              ? FINAL_GROUP
              : (PRE_FINAL_GROUP[kind] ?? 0);
        entry =
          code === null
            ? null
            : {
                rc: {
                  code,
                  label: roundRoleBoardLabel(msg, role, { lane, roundInLane }),
                  order: [
                    group,
                    // A rung is placed by the n its code prints (E{n} counts
                    // from the ladder's start): by distance from the final, a
                    // 6-ladder's E3 would tie a 4-ladder's E1.
                    role.kind === "rung" ? role.n : lane === null ? roundInLane - lastRoundInLane : roundInLane,
                    thirdPlace || conditional ? 1 : 0,
                    f.seq_in_round,
                  ],
                },
                count: 0,
              };
        perRound.set(key, entry);
      }
      if (entry !== null) out.set(f.id, { ...entry.rc, refSeq: ++entry.count });
    }
  }
  return out;
}

const MATCH_REF_KEYS: ReadonlySet<string> = new Set(["slot.winner_match", "slot.loser_match"]);

/**
 * The board's feed-label map with each bracket feeder's round code stamped on
 * — `params.code`, which `resolveSlotLabel` prints as "Winner of QF·3" in
 * place of "Winner of R1·3". `params.seq` is restamped too, with the feeder's
 * `refSeq`: the same number for every knockout feeder, but "Winner of E·1" —
 * not E·2 — for a page playoff's Eliminator, the second match of its round.
 * This copy is display-only (card titles); nothing reads `{round, seq}` back
 * off it to find a fixture.
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
 * keeps a stable reference through its memo. Idempotent: a label that already
 * carries a `code` is skipped, so a second pass returns its input unchanged.
 */
export function withRoundCodeRefs(
  fixtures: readonly SeatLabelFixture[],
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
      // Already stamped (only this function writes `code`): its `seq` is a
      // refSeq now, and looking that up as a seq_in_round would rename the
      // Eliminator's feeder "Q1·1".
      if (typeof label.params.code === "string") continue;
      const stage = typeof label.params.stage === "string" ? label.params.stage : f.stage_id;
      const ref = at.get(`${stage}:${Number(label.params.round)}:${Number(label.params.seq)}`);
      const rc = ref === undefined ? undefined : codes.get(ref);
      if (rc === undefined) continue;
      out ??= { ...feeds };
      out[f.id] = {
        ...out[f.id],
        [side]: { key: label.key, params: { ...label.params, code: rc.code, seq: rc.refSeq } },
      };
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
 * Ordered by `BoardRoundCode.order`: group (each single-lane format's early
 * rounds, one format at a time — so a knockout's, a page playoff's "Q1 E Q2"
 * and a stepladder's "E1 E2" each read as a run — then the shared F, then the
 * double-elimination lanes), then a stepladder rung's own n (so a 4-ladder and
 * a 6-ladder read E1 … E4 together) or distance from the final in a single lane
 * (so a 16-knockout's R16 precedes an 8-knockout's QF on one competition board),
 * then the third-place match / bracket reset after the round it shares, then
 * the round's place in its generator's order (Qualifier 1 before the
 * Eliminator, which share round 1) — and only then by name, so a locale whose
 * "third place" sorts before its "final" (nl) still lists F first.
 *
 * Deduplicated on code AND name together: two knockouts' QF list once, and the
 * F that a knockout, a page playoff and a stepladder all end on lists once
 * (every single-lane final has the same `order`, so which one is kept does not
 * move it); but a locale that ever abbreviated two different rounds alike
 * would list both rather than explain one of them with the other's name —
 * which is also why a page playoff's "E Eliminator" and a stepladder's "E1
 * Eliminator 1" are two entries.
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
        a.order[3] - b.order[3] ||
        a.label.localeCompare(b.label),
    )
    .map(({ code, label }) => ({ code, label }));
}
