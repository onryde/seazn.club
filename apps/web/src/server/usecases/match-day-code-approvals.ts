import "server-only";
// Approvals through a Match Day code (capture S4 design §7, §9.5; MD-1 Task 6): review and approve the next Swiss round
// (`previewSwissNextRound` / `pairSwissNextRound`, Task 5) or a knockout's draw (the seed proposal: `getSeedProposal`,
// `computeSeedProposal`, `confirmSeedProposal`), exactly as the server computed it. The phone changes nothing: a tie or a
// slot to change is the web desk's.
//
// The gate is the code, never membership. `matchDayActor` vouches with the code's ISSUER as `userId`, and the stage
// usecases gate nothing themselves (their routes do), so an approval is allowed here on the code's own two facts:
//  - its "can approve draws" tick — without it, 403 MD_NO_APPROVE on the review AND the approve: both may write (the
//    review computes a draft proposal, or commits a Swiss round's lots draw), so a code without the tick writes nothing;
//  - its scope — a stage outside it is 403 MD_OUT_OF_SCOPE (`stageInScope`, the predicate the day read lists by).
// Only an md_ bearer resolved by `matchDayCodeOf` reaches these functions: they take the code's row, never an AuthCtx.
//
// Every refusal is one of the md_ words (capture-schemas.ts `CaptureMatchdayRefusalCode`): the stage usecases' own codes
// are translated here (`MD_WORD_OF`), and anything else is the v1 envelope's own answer (404, 422), outside the md_ shape.
import { EngineError } from "@seazn/engine/core";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { DEFAULT_LOCALE, getDictionary } from "@/lib/i18n";
import { assertUuid } from "@/server/api-v1/auth";
import type { CaptureMatchdayApprovalOk, CaptureMatchdayApprovalReview } from "@/server/api-v1/capture-schemas";
import { stageInScope, type ScopeFixture } from "./match-day-code-view";
import { logMatchDayUse, matchDayActor, type MatchDayCodeRow } from "./match-day-codes";
import { readRounds, roundOf } from "./match-day-rounds";
import {
  computeSeedProposal,
  confirmSeedProposal,
  getSeedProposal,
  pairSwissNextRound,
  previewSwissNextRound,
  type SeedProposalOut,
} from "./stages";

export type ApprovalKind = "swiss" | "draw";
export const APPROVAL_KINDS: readonly ApprovalKind[] = ["swiss", "draw"];

type MdWord = "MD_STALE" | "MD_ALREADY" | "MD_TIES";

/**
 * The stage usecases' refusals an approval answers with an md_ word (409 each, the plan's Global Constraints):
 *  - a seed proposal confirmed already → MD_ALREADY; stale (recomputed since, or the standings moved) → MD_STALE;
 *  - a flagged tie → MD_TIES (the phone cannot pick ties: the desk resolves them);
 *  - a qualifier who left after the draft → MD_STALE: the field change stales the draft, and the review then computes
 *    a fresh one without her (`liveDraft`);
 *  - not ready — a Swiss round still in play, or a draw whose source stage is not complete — → MD_STALE: the plan has no
 *    "not ready" word (the controller's dispatch), and reviewing again once the round is played is the phone's way on.
 * MD_ALREADY (every Swiss round seated, or the round already paired) and MD_STALE from the Swiss pair are already md_ words.
 */
const MD_WORD_OF: Record<string, MdWord> = {
  SEEDING_ALREADY_CONFIRMED: "MD_ALREADY",
  SEEDING_PROPOSAL_STALE: "MD_STALE",
  SEEDING_TIE_UNRESOLVED: "MD_TIES",
  SEEDING_ENTRANT_WITHDRAWN: "MD_STALE",
  SEEDING_SOURCE_INCOMPLETE: "MD_STALE",
  STAGE_NOT_READY: "MD_STALE",
};

const MD_MESSAGE: Record<MdWord, string> = {
  MD_STALE: "the draw changed, or is not ready yet; review it again",
  MD_ALREADY: "this draw was already approved",
  MD_TIES: "this draw has ties to decide on the web desk",
};

/** `run`, its stage-usecase refusals translated to md_ words (409); every other error as it was. */
async function inMdWords<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const code = e instanceof HttpError ? e.code : EngineError.is(e) ? e.code : undefined;
    const word = code === undefined ? undefined : MD_WORD_OF[code];
    if (word === undefined) throw e;
    throw new HttpError(409, MD_MESSAGE[word], word);
  }
}

/** The code's "can approve draws" tick, asked before anything is read or written. */
function requireCanApprove(code: MatchDayCodeRow): void {
  if (!code.canApprove) throw new HttpError(403, "this Match Day code cannot approve draws", "MD_NO_APPROVE");
}

/** A stage fixture as `inScope` judges it, before the stage's own facts are added. */
type FixtureScope = Omit<ScopeFixture, "competition_id" | "stage_status" | "division_live">;

/**
 * The stage as the code's org sees it: 404 when it cannot, 403 MD_OUT_OF_SCOPE when the code does not cover it (another
 * competition, an archived division — the day read lists live divisions only — or, for a narrowed code, no match of the
 * stage on its courts on its day). Answers the division's name.
 */
async function stageForCode(code: MatchDayCodeRow, stageId: string): Promise<{ divisionName: string }> {
  assertUuid(stageId, "stage");
  return withTenant(code.orgId, async (tx) => {
    const [stage] = await tx<{ competition_id: string; division_name: string; status: string; division_live: boolean }[]>`
      select d.competition_id, d.name as division_name, s.status, (d.archived_at is null) as division_live
        from stages s join divisions d on d.id = s.division_id
       where s.id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    const fixtures = await tx<FixtureScope[]>`
      select f.court_id, c.venue_id, f.status, f.scheduled_at, f.finished_at, f.home_entrant_id, f.away_entrant_id
        from fixtures f left join courts c on c.id = f.court_id
       where f.stage_id = ${stageId}`;
    const judged = fixtures.map((f) => ({
      ...f,
      competition_id: stage.competition_id,
      stage_status: stage.status,
      division_live: stage.division_live,
    }));
    if (!stage.division_live || !stageInScope(code, stage.competition_id, judged)) {
      throw new HttpError(403, "this stage is not in this Match Day code's scope", "MD_OUT_OF_SCOPE");
    }
    return { divisionName: stage.division_name };
  });
}

/** Entrant display names by id (`entrants.display_name` is NOT NULL). */
async function namesOf(code: MatchDayCodeRow, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await withTenant(code.orgId, (tx) =>
    tx<{ id: string; display_name: string }[]>`select id, display_name from entrants where id in ${tx([...new Set(ids)])}`,
  );
  return new Map(rows.map((r) => [r.id, r.display_name]));
}

function nameIn(names: ReadonlyMap<string, string>, id: string): string {
  const name = names.get(id);
  // An assumption made a guard: every seated or proposed entrant is a row of the stage's division.
  if (name === undefined) throw new Error("match day approval: a proposed entrant has no entrant row");
  return name;
}

type Review = CaptureMatchdayApprovalReview;
type Row = Review["rows"][number];

/** A row's label: the round's code, then the match's number in its round when the round holds more than one. */
const labelOf = (code: string, n: number, inRound: number): string => (inRound > 1 ? `${code} ${n}` : code);

// ---------------------------------------------------------------------------------------------------------------
// Swiss: the next round.
// ---------------------------------------------------------------------------------------------------------------

/** The next Swiss round as the desk's Pair next would seat it (`previewSwissNextRound`: it commits the round's lots draw,
 *  if it needs one, and rolls the pairing back). Rows in board order, the bye with `away: null`; `round` is the round the
 *  day read lists as awaiting pairing, and the approve must hand it back with `hash` (Task 5). */
async function swissReview(code: MatchDayCodeRow, stageId: string, divisionName: string): Promise<Review> {
  const preview = await inMdWords(() => previewSwissNextRound(matchDayActor(code), stageId));
  const names = await namesOf(code, preview.pairings.flatMap((p) => (p.away === null ? [p.home] : [p.home, p.away])));
  const rows: Row[] = preview.pairings.map((p) => ({
    label: labelOf(`R${preview.round}`, p.board, preview.pairings.length),
    home: nameIn(names, p.home),
    away: p.away === null ? null : nameIn(names, p.away),
  }));
  return { kind: "swiss", stage_id: stageId, division_name: divisionName, round: preview.round, rows, hash: preview.inputHash, ties: false };
}

// ---------------------------------------------------------------------------------------------------------------
// Draw: the seed proposal into a knockout.
// ---------------------------------------------------------------------------------------------------------------

/** The live draft, or a fresh one when there is none to review: the latest proposal is not a draft (none yet, stale, or
 *  — refused MD_ALREADY by the compute — confirmed). A field change marks a draft stale itself (entrants.ts,
 *  `markFieldChangeSeedProposalsStale`), so a draft naming a qualifier who has left is not live for long; an approve that
 *  races it is MD_STALE (SEEDING_ENTRANT_WITHDRAWN). */
async function liveDraft(code: MatchDayCodeRow, stageId: string): Promise<SeedProposalOut> {
  const actor = matchDayActor(code);
  const latest = await getSeedProposal(actor, stageId);
  if (latest !== null && latest.status === "draft") return latest;
  return inMdWords(() => computeSeedProposal(actor, stageId));
}

/** One row per knockout match a qualifier is drawn into, from each qualifier's `destinationSlot` (`{fixture}:{side}`),
 *  in round then match order, labelled by the schedule board's round codes. A match with one qualifier (the other seat
 *  fed from elsewhere) names her as `home` and `away: null`. */
async function drawRows(code: MatchDayCodeRow, stageId: string, proposal: SeedProposalOut): Promise<Row[]> {
  const dict = await getDictionary(DEFAULT_LOCALE, "ui");
  const names = await namesOf(code, proposal.computed.qualifiers.map((q) => q.entrantId));
  const sides = new Map<string, { home?: string; away?: string }>();
  for (const q of proposal.computed.qualifiers) {
    const [fixtureId, side] = q.destinationSlot.split(":") as [string, string];
    const seat = sides.get(fixtureId) ?? {};
    seat[side === "home" ? "home" : "away"] = nameIn(names, q.entrantId);
    sides.set(fixtureId, seat);
  }
  return withTenant(code.orgId, async (tx) => {
    const all = await tx<{ id: string; stage_id: string; stage_kind: string; round_no: number; seq_in_round: number }[]>`
      select f.id, f.stage_id, s.kind as stage_kind, f.round_no, f.seq_in_round
        from fixtures f join stages s on s.id = f.stage_id
       where f.stage_id = ${stageId}
       order by f.round_no, f.seq_in_round, f.id`;
    const drawn = all.filter((f) => sides.has(f.id));
    const rounds = await readRounds(tx, drawn, dict);
    return drawn.map((f) => {
      const inRound = all.filter((x) => x.round_no === f.round_no);
      const seat = sides.get(f.id)!;
      return {
        label: labelOf(roundOf(rounds, f.id).code, inRound.indexOf(f) + 1, inRound.length),
        home: (seat.home ?? seat.away)!,
        away: seat.home === undefined ? null : (seat.away ?? null),
      };
    });
  });
}

async function drawReview(code: MatchDayCodeRow, stageId: string, divisionName: string): Promise<Review> {
  const draft = await liveDraft(code, stageId);
  const rows = await drawRows(code, stageId, draft);
  return { kind: "draw", stage_id: stageId, division_name: divisionName, round: null, rows, hash: draft.id, ties: draft.computed.ties.length > 0 };
}

// ---------------------------------------------------------------------------------------------------------------
// The two doors.
// ---------------------------------------------------------------------------------------------------------------

/**
 * Review an approval (§7 "Review opens the proposal read-only"): the rows exactly as the server computed them, the `hash`
 * the approve hands back (Swiss: the preview's input hash; draw: the proposal's id), `round` (Swiss: the round awaiting
 * pairing, the day read's; draw: null) and `ties` (a draw whose tie only the desk can resolve). Not read-only underneath:
 * a draw with no live draft computes one (the desk's Recompute), and a Swiss preview commits its round's lots draw.
 */
export async function reviewApprovalForCode(code: MatchDayCodeRow, kind: ApprovalKind, stageId: string): Promise<Review> {
  requireCanApprove(code);
  const { divisionName } = await stageForCode(code, stageId);
  return kind === "swiss" ? swissReview(code, stageId, divisionName) : drawReview(code, stageId, divisionName);
}

/**
 * Approve what the review showed (§7 "Approve"): Swiss — pair `round` if `hash` still describes its inputs; draw —
 * confirm the proposal `hash` with no edits and no tie picks. The first of two phones wins; the second is MD_ALREADY.
 * Refusals: MD_NO_APPROVE, MD_OUT_OF_SCOPE, MD_STALE, MD_ALREADY, MD_TIES; 404 for an unknown stage or proposal; 422 for
 * a Swiss approve without a whole `round`. Each approve writes one `match_day_code_uses` row once it has committed
 * (a refusal writes none).
 */
export async function approveForCode(
  code: MatchDayCodeRow,
  kind: ApprovalKind,
  stageId: string,
  input: { hash: string; round?: number | null },
): Promise<CaptureMatchdayApprovalOk> {
  requireCanApprove(code);
  await stageForCode(code, stageId);
  const actor = matchDayActor(code);
  if (kind === "swiss") {
    await inMdWords(() => pairSwissNextRound(actor, stageId, input.hash, input.round ?? Number.NaN));
  } else {
    if (!UUID.test(input.hash)) throw new HttpError(404, "seed proposal not found");
    await inMdWords(() => confirmSeedProposal(actor, stageId, { proposalId: input.hash }));
  }
  // After the approval committed, on the pooled client (the use log is sealed): the stage usecases own their transactions,
  // so the row is not in the approval's own one (the open's is; MD-1 Task 6 report, deviation).
  await logMatchDayUse(code.id, { kind: "approve", stageId, approval: kind });
  return { ok: true };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
