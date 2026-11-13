import "server-only";
// Quick match plan 5, Task 4 (plan docs/superpowers/plans/2026-11-13-quick-match-5-league-knockout.md D2, D3, D5, P5, P6,
// P9, Review Focus 1-2; spec docs/superpowers/specs/2026-11-12-quick-match-league-knockout-design.md §5, §11, §12): a
// League + Knockout quick match moves itself on, and the guests answer a tie at the cut once.
//
// A League + Knockout is ONE division with TWO stages (T3): the league (seq 1) and a knockout (seq 2) whose seats wait on the
// league's ranks 1..q (`progression.sources[0].take[0]`, q = 2 or 4, the engine's own authority: D1). Nothing here computes
// a result: the league's table is the stored one (`standings_snapshots`, what the write path's recompute left), the cut is
// `cutTies` over it (T2), and who went through is the confirmed seed proposal's (the filled seats): one authority per fact.
//
// The interface, three doors and one read:
//   - `loadLeagueCut(row)`: one read as the system org under the division's advisory lock (the key completion, the seed
//     proposal's compute and its confirm take, so the read never sees half of one of them). The advance, the decision and
//     the home (T5) ask it the same question.
//   - `advanceQuickMatch(row)`: QM-owned and idempotent (P5: the organiser's auto-advance is post-commit, swallows every
//     failure and confirms no tie, so it is never used; `divisions.auto_progress` stays false). Each call takes the next
//     step, D2: not a League + Knockout → plain; the knockout filled → filled; the league not done → league; a tie that
//     straddles the cut with no stored answer → tie (asked on the home); otherwise complete the league stage (D3: only
//     now, so while a question is open the league stays editable), then confirm the knockout's seed proposal as the system
//     user with a tie pick for every tie the proposal flags (P9). Not in the scoring transaction (P6: completion, compute and
//     confirm each own a `withTenant`, which never nests): it runs in the same request, after the commit, and again on every
//     home load (the retry). Two phones racing it fill the knockout once (Review Focus 2): the confirm's own refusals
//     (SEEDING_ALREADY_CONFIRMED, SEEDING_PROPOSAL_STALE) are the loser's, read as "look again", never as a failure.
//   - `decideQuickMatchCut(row, input)`: Pick who goes through, or Toss a coin (D5). The first decision wins: written only
//     over the value the read saw (compare-and-set), so a second phone's answer is refused ALREADY_DECIDED.
//   - `afterQuickMatchScore(divisionId)`: the one call `scoring.ts`'s `onDecided` makes for a quick match's score.
//
// A stored decision answers the question only while it names the same tie (§11): an edit that changes the table, or a
// league that is no longer done, drops it (compare-and-clear, so a decision written meanwhile is never cleared by a stale
// read). A malformed one (C3) reads as no decision and is dropped the same way.
//
// Toss reveals the stored lot (D5, §11): the class's first `seats` in the live table's order, the engine's deterministic
// draw, which completion stores unchanged (T2's DB premise). A class the engine left in SEED order (nothing counted, so no
// lot was drawn: `CutTie.byLot` false) has no coin: Toss is refused there (TIE_NOT_OPEN), Pick only (ledger carry T1/T2).
import { withTenant, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { systemAuth } from "@/lib/quick-match-auth";
import { QUICK_MATCH_ERRORS, QUICK_MATCH_SYSTEM_ORG_ID } from "@/lib/quick-match-constants";
import { MUTATION_LIMIT, rateLimit } from "@/lib/rate-limit";
import type { MatchLineRow } from "@/lib/run-sheet-groups";
import type { StandingsRow } from "@seazn/engine/competition";
import { cutRowOf, cutTies, openTie, tossThrough, type CutTie } from "./quick-match-cut";
import { findQuickMatchByCompetition, isQuickMatchFinished, playedOf, type QuickMatchRow } from "./quick-match-home";
import {
  completeStage,
  computeSeedProposal,
  confirmSeedProposal,
  getSeedProposal,
  getStandings,
  type SeedProposalOut,
} from "./stages";

const SYSTEM_ORG = QUICK_MATCH_SYSTEM_ORG_ID;

/** The guests' answer to a tie at the cut, as `quick_matches.cut_decision` holds it (V517's check: this exact shape). */
export interface CutDecision {
  how: "pick" | "toss";
  /** The entrants sent through: exactly the tie's `seats`, in the live table's order. */
  through: string[];
  /** The tie's class, sorted (`CutTie.entrantIds`): the question this answers. */
  tie: string[];
  /** When it was answered (ISO). */
  at: string;
}

export type AdvanceState = { state: "plain" } | { state: "league" } | { state: "tie"; tie: CutTie } | { state: "filled" };

/** A League + Knockout's cut, as one read sees it (`loadLeagueCut`). */
export interface LeagueCut {
  divisionId: string;
  leagueStageId: string;
  koStageId: string;
  qualifiers: 2 | 4;
  /** Every league match played or Not played (`isQuickMatchFinished` over the league stage's lines only, D8). */
  leagueDone: boolean;
  /** The league stage's own status is `complete`: the advance completed it (D3), which it does only to fill. */
  leagueComplete: boolean;
  /** `cutTies` over the league's stored table: every tie class that reaches the cut, best place first. */
  ties: CutTie[];
  /** The stored decision, when it answers the tie that straddles the cut (`openTie(ties)`); null otherwise. */
  decision: CutDecision | null;
  /** `quick_matches.cut_decision` exactly as read (null, a decision, a stale one or a malformed one): the value the
   *  compare-and-set and compare-and-clear writes compare against. */
  storedDecision: unknown;
  /** The knockout's seed proposal is confirmed: its seats are filled from the league. Never read from the knockout stage's
   *  status, which is `active` from the create (T3). */
  filled: boolean;
}

/** `cut_decision` read strictly (C3): anything but V517's shape with string ids is no decision. */
function parseDecision(raw: unknown): CutDecision | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const ids = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
  if ((r.how !== "pick" && r.how !== "toss") || !ids(r.through) || !ids(r.tie) || typeof r.at !== "string") return null;
  return { how: r.how, through: [...r.through], tie: [...r.tie], at: r.at };
}

/** Does `d` answer `tie`? The same class, exactly `seats` distinct members of it, and a toss only on a class the lot ordered. */
function answers(d: CutDecision, tie: CutTie): boolean {
  const cls = new Set(tie.entrantIds);
  return (
    [...d.tie].sort().join(",") === tie.entrantIds.join(",") &&
    d.through.length === tie.seats &&
    new Set(d.through).size === d.through.length &&
    d.through.every((id) => cls.has(id)) &&
    (d.how === "pick" || tie.byLot)
  );
}

/** The knockout's qualifier count, from its own progression (D1): `sources[0].take[0]` = rankRange 1..q. Anything else is
 *  no League + Knockout this code knows, refused loudly. */
function qualifiersOf(quickMatchId: string, progression: unknown): 2 | 4 {
  const take = (progression as { sources?: { take?: { kind?: string; from?: number; to?: number }[] }[] } | null)?.sources?.[0]
    ?.take?.[0];
  if (take?.kind !== "rankRange" || take.from !== 1 || (take.to !== 2 && take.to !== 4)) {
    throw new Error(`quick match ${quickMatchId}: the knockout's progression takes ${JSON.stringify(take)}, not ranks 1..2 or 1..4`);
  }
  return take.to;
}

type LeagueLine = MatchLineRow;

/**
 * The cut of a League + Knockout quick match, or null for any other format (no read at all) and for a match whose
 * competition or row is gone. One transaction as the system org, under the division's advisory lock: the division by the
 * row's own competition first (the per-match check, §7.1 point 3 of the quick match spec), then its two stages (exactly a
 * league at seq 1 and a knockout at seq 2, else refused loudly), the league's lines, its stored table, whether the
 * knockout's proposal is confirmed, and the stored decision. A league stage with no stored table yet (none is expected: the
 * generate writes a level one) is folded on the read after the transaction (`getStandings`).
 */
export async function loadLeagueCut(row: QuickMatchRow): Promise<LeagueCut | null> {
  if (row.format !== "league_knockout") return null;
  const read = await withTenant(SYSTEM_ORG, async (tx) => {
    const divisions = await tx<{ id: string }[]>`select id from divisions where competition_id = ${row.competitionId}`;
    if (divisions.length === 0) return null;
    if (divisions.length > 1) {
      throw new Error(`quick match ${row.id}: competition ${row.competitionId} holds ${divisions.length} divisions, not one`);
    }
    const divisionId = divisions[0]!.id;
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
    const stages = await tx<{ id: string; kind: string; seq: number; status: string; progression: unknown }[]>`
      select id, kind, seq, status, progression from stages where division_id = ${divisionId} order by seq`;
    const [league, ko] = stages;
    if (stages.length !== 2 || league!.kind !== "league" || ko!.kind !== "knockout") {
      throw new Error(
        `quick match ${row.id}: a League + Knockout is a league then a knockout, division ${divisionId} holds [${stages.map((s) => s.kind).join(", ")}]`,
      );
    }
    const lines = await tx<LeagueLine[]>`
      select status, outcome, home_entrant_id, away_entrant_id, home_slot_label, away_slot_label, ext_key
      from fixtures where stage_id = ${league!.id}`;
    const [snapshot] = await tx<{ rows: unknown[] }[]>`
      select rows from standings_snapshots where stage_id = ${league!.id} and pool_id is null`;
    const [confirmed] = await tx<{ id: string }[]>`
      select id from stage_seed_proposals where stage_id = ${ko!.id} and status = 'confirmed' limit 1`;
    const [qm] = await tx<{ cut_decision: unknown }[]>`select cut_decision from quick_matches where id = ${row.id}`;
    if (!qm) return null;
    return { divisionId, league: league!, ko: ko!, lines, snapshot: snapshot?.rows ?? null, filled: confirmed !== undefined, raw: qm.cut_decision };
  });
  if (read === null) return null;
  const qualifiers = qualifiersOf(row.id, read.ko.progression);
  const rows = (read.snapshot ?? (await getStandings(systemAuth(), read.league.id)).rows) as StandingsRow[];
  const ties = cutTies(rows.map(cutRowOf), qualifiers);
  const open = openTie(ties);
  const parsed = parseDecision(read.raw);
  return {
    divisionId: read.divisionId,
    leagueStageId: read.league.id,
    koStageId: read.ko.id,
    qualifiers,
    leagueDone: isQuickMatchFinished(playedOf(read.lines)),
    leagueComplete: read.league.status === "complete",
    ties,
    decision: parsed !== null && open !== null && answers(parsed, open) ? parsed : null,
    storedDecision: read.raw ?? null,
    filled: read.filled,
  };
}

/** Compare-and-clear (§11): drop the decision only if it is still the value the read saw, so a decision written since (a
 *  phone answering the fresh question) is never cleared by a stale read. */
async function clearDecision(quickMatchId: string, seen: unknown): Promise<void> {
  await withTenant(SYSTEM_ORG, (tx) => tx`
    update quick_matches set cut_decision = null where id = ${quickMatchId} and cut_decision = ${tx.json(seen as never)}`);
}

/** A racing advance's refusals (Review Focus 2): another call completed, proposed or confirmed in between. Read as "look
 *  again", never as a failure. STAGE_COMPLETED_SEEDING_FAILED is completion's wrapper of a compute refused that way (a
 *  confirm already landed); a genuine compute fault behind it reappears, unwrapped, on the next pass and is thrown. */
const RACE_CODES: ReadonlySet<string> = new Set([
  "SEEDING_ALREADY_CONFIRMED",
  "SEEDING_PROPOSAL_STALE",
  "STAGE_COMPLETED_SEEDING_FAILED",
]);
const isRaceLoss = (err: unknown): boolean => err instanceof HttpError && err.code !== undefined && RACE_CODES.has(err.code);

/** How many times the advance looks again (a completion, then a race loss or two) before a fault is a fault. */
const MAX_PASSES = 4;

/**
 * The tie picks the confirm needs (P9): one per tie the proposal flags, its slots in seed order. A tie that straddles the
 * cut takes the decision's entrants, in the live table's (the lot's) order (§11: the order among them follows the lot); a
 * tie whose members all go through (case 2) takes its default occupants, the stored lot's order. Every flagged tie must be
 * one the league table shows, and the straddling one must be flagged, or the guests' answer would be ignored: refused
 * loudly, as faults.
 */
function tiePicksFor(quickMatchId: string, proposal: SeedProposalOut, cut: LeagueCut): { slots: string[]; order: string[] }[] {
  const seedOf = new Map(proposal.computed.qualifiers.map((q) => [q.destinationSlot, q.rank] as const));
  const occupantOf = new Map(proposal.computed.qualifiers.map((q) => [q.destinationSlot, q.entrantId] as const));
  const byClass = new Map(cut.ties.map((t) => [t.entrantIds.join(","), t] as const));
  const open = openTie(cut.ties);
  let openFlagged = false;
  const picks = proposal.computed.ties.map((flagged) => {
    const key = [...flagged.entrantIds].sort().join(",");
    const tie = byClass.get(key);
    if (tie === undefined) throw new Error(`quick match ${quickMatchId}: the seed proposal flags a tie [${key}] the league's table does not`);
    const seed = (slot: string): number => {
      const s = seedOf.get(slot);
      if (s === undefined) throw new Error(`quick match ${quickMatchId}: tied slot ${slot} holds no seed in the proposal`);
      return s;
    };
    const slots = [...flagged.slots].sort((a, b) => seed(a) - seed(b));
    if (slots.length !== tie.seats) {
      throw new Error(`quick match ${quickMatchId}: the tie [${key}] has ${tie.seats} seats in the table, ${slots.length} in the proposal`);
    }
    let order: string[];
    if (tie.straddles) {
      openFlagged = true;
      const through = cut.decision?.through ?? [];
      order = tie.ranked.filter((id) => through.includes(id));
    } else {
      order = slots.map((slot) => occupantOf.get(slot) ?? "");
    }
    if (order.length !== slots.length || order.some((id) => !tie.entrantIds.includes(id))) {
      throw new Error(`quick match ${quickMatchId}: no full answer for the tie [${key}]: [${order.join(", ")}] into ${slots.length} seats`);
    }
    return { slots, order };
  });
  if (open !== null && !openFlagged) {
    throw new Error(`quick match ${quickMatchId}: the tie [${open.entrantIds.join(",")}] straddles the cut, but the seed proposal does not flag it`);
  }
  return picks;
}

/**
 * Move a quick match on as far as it can go now (D2), idempotently. Never throws for a race with another call; throws for a
 * fault (the caller logs it and carries on: every caller is best-effort, and the home retries on its next load).
 */
export async function advanceQuickMatch(row: QuickMatchRow): Promise<AdvanceState> {
  if (row.format !== "league_knockout") return { state: "plain" };
  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    const cut = await loadLeagueCut(row);
    if (cut === null) return { state: "plain" };
    if (cut.filled) return { state: "filled" };
    const open = openTie(cut.ties);
    // §11: a decision answers only the question it was given. A league that is no longer done has no question, and a table
    // that moved may have another one.
    if (cut.storedDecision !== null && (!cut.leagueDone || cut.decision === null)) {
      await clearDecision(row.id, cut.storedDecision);
    }
    if (!cut.leagueDone) return { state: "league" };
    if (open !== null && cut.decision === null) return { state: "tie", tie: open };
    try {
      if (!cut.leagueComplete) {
        // D3: the league completes only now, on its way to fill. A result reopened since the read keeps it open (completed
        // false), and the next pass reads that.
        await completeStage(systemAuth(), cut.leagueStageId, { publish: true });
        continue;
      }
      const latest = await getSeedProposal(systemAuth(), cut.koStageId);
      // A confirm that landed after this pass's read: the next pass reads it filled.
      if (latest?.status === "confirmed") continue;
      const proposal = latest?.status === "draft" ? latest : await computeSeedProposal(systemAuth(), cut.koStageId);
      await confirmSeedProposal(systemAuth(), cut.koStageId, {
        proposalId: proposal.id,
        tiePicks: tiePicksFor(row.id, proposal, cut),
      });
      return { state: "filled" };
    } catch (err) {
      if (!isRaceLoss(err) || pass === MAX_PASSES) throw err;
    }
  }
  throw new Error(`quick match ${row.id}: the knockout did not fill after ${MAX_PASSES} passes`);
}

const alreadyDecided = (): HttpError =>
  new HttpError(422, "the tie at the cut has already been decided", QUICK_MATCH_ERRORS.ALREADY_DECIDED);
const tieNotOpen = (why: string): HttpError =>
  new HttpError(422, `no tie at the cut is open: ${why}`, QUICK_MATCH_ERRORS.TIE_NOT_OPEN);

/**
 * Answer the tie at the cut (D5), once. The checks, in this order, each answering before the next runs:
 *   1. the post limit, per quick match (`qm-cut:<id>`, MUTATION_LIMIT): its 429 carries no code;
 *   2. not a League + Knockout: TIE_NOT_OPEN (no question is ever asked of one);
 *   3. the read (`loadLeagueCut`): null when the competition is gone since the token resolved, answered as EXPIRED (404) so
 *      the caller lands on the dead link;
 *   4. the knockout filled, or a stored decision already answers the open tie: ALREADY_DECIDED;
 *   5. no tie straddles the cut of a finished league: TIE_NOT_OPEN;
 *   6. Toss on a class the engine left in seed order (no lot was drawn): TIE_NOT_OPEN. Pick naming anything but exactly the
 *      open places' number of distinct members of the class: PICK_INVALID;
 *   7. the write, over exactly the value step 3 read (compare-and-set): zero rows means someone answered in between:
 *      ALREADY_DECIDED.
 * The caller then runs `advanceQuickMatch`, which fills the knockout from the answer.
 */
export async function decideQuickMatchCut(
  row: QuickMatchRow,
  input: { how: "toss" } | { how: "pick"; entrantIds: readonly string[] },
): Promise<{ through: string[] }> {
  await rateLimit(`qm-cut:${row.id}`, MUTATION_LIMIT);
  if (row.format !== "league_knockout") throw tieNotOpen("this quick match has no knockout");
  const cut = await loadLeagueCut(row);
  if (cut === null) throw new HttpError(404, "quick match not found or expired", QUICK_MATCH_ERRORS.EXPIRED);
  if (cut.filled || cut.decision !== null) throw alreadyDecided();
  const tie = cut.leagueDone ? openTie(cut.ties) : null;
  if (tie === null) throw tieNotOpen(cut.leagueDone ? "nobody is level at the cut" : "the league is not finished");
  let through: string[];
  if (input.how === "toss") {
    if (!tie.byLot) throw tieNotOpen("no lot was drawn for this tie, so there is no coin to toss");
    through = tossThrough(tie);
  } else {
    const picked = new Set(input.entrantIds);
    if (picked.size !== input.entrantIds.length || picked.size !== tie.seats || ![...picked].every((id) => tie.entrantIds.includes(id))) {
      throw new HttpError(422, `pick exactly ${tie.seats} of the tied sides`, QUICK_MATCH_ERRORS.PICK_INVALID);
    }
    through = tie.ranked.filter((id) => picked.has(id));
  }
  const decision: CutDecision = { how: input.how, through, tie: tie.entrantIds, at: new Date().toISOString() };
  const seen = cut.storedDecision;
  const written = await withTenant(SYSTEM_ORG, (tx: Tx) => tx<{ id: string }[]>`
    update quick_matches set cut_decision = ${tx.json(decision as never)}
    where id = ${row.id}
      and ${seen === null ? tx`cut_decision is null` : tx`cut_decision = ${tx.json(seen as never)}`}
    returning id`);
  if (written.length === 0) throw alreadyDecided();
  return { through };
}

/**
 * `scoring.ts`'s `onDecided` hook for a quick match's score (D2 caller a): the quick match whose division this is, advanced.
 * Any other division (none reaches here: the hook is gated on the system org) is no quick match and does nothing.
 */
export async function afterQuickMatchScore(divisionId: string): Promise<AdvanceState> {
  const [division] = await withTenant(SYSTEM_ORG, (tx) => tx<{ competition_id: string }[]>`
    select competition_id from divisions where id = ${divisionId}`);
  if (!division) return { state: "plain" };
  const row = await findQuickMatchByCompetition(division.competition_id);
  if (row === null) return { state: "plain" };
  return advanceQuickMatch(row);
}
