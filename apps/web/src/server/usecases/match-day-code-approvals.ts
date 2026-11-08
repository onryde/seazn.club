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
// are translated here (`mdRefusalOf`), and no other word ever leaves — a coded 4xx it has no md_ word for keeps its status
// and loses its word, and only a real fault is a 500. The other answers are the v1 envelope's own, by status (a codeless
// 404 or 422). A division whose schedule is locked is the desk's (the controller's ruling, Task 6 fix round 2): the day
// read lists none of its approvals, and both doors answer it MD_NO_APPROVE.
import { EngineError } from "@seazn/engine/core";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { DEFAULT_LOCALE, getDictionary } from "@/lib/i18n";
import { SCHEDULE_LOCKED_CODE } from "@/lib/schedule-lock";
import { assertUuid } from "@/server/api-v1/auth";
import { CaptureMatchdayRefusalCode, type CaptureMatchdayApprovalOk, type CaptureMatchdayApprovalReview } from "@/server/api-v1/capture-schemas";
import { ENGINE_HTTP } from "@/server/api-v1/http";
import { log } from "@/server/logger";
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
  // Minor M4: nobody left to seed (every qualifier gone): the draft is not approvable; review again once the field settles.
  SEEDING_NOTHING_TO_FILL: "MD_STALE",
};

const MD_MESSAGE: Record<MdWord, string> = {
  MD_STALE: "the draw changed, or is not ready yet; review it again",
  MD_ALREADY: "this draw was already approved",
  MD_TIES: "this draw has ties to decide on the web desk",
};

const MD_WORDS: ReadonlySet<string> = new Set(CaptureMatchdayRefusalCode.options);

/** Who asked, for a log line: ids only, never the token. */
export type Asked = { codeId: string; stageId: string; kind: ApprovalKind };

/** A locked schedule: the desk's to unlock, so the phone's tick does not reach it. */
const LOCKED = (): HttpError =>
  new HttpError(403, "this division's schedule is locked: approve on the web desk", "MD_NO_APPROVE");

/**
 * The error an approval answers for `e`, a refusal raised by a stage usecase, in md_ words (review fix I1, and the
 * controller's rulings of fix round 2):
 *  - an md_ word already (the Swiss pair's MD_ALREADY, MD_STALE), a codeless HttpError (404 not found, 422 a round that
 *    is not a whole number, 422 "only a Swiss stage …") and any error with no code are unchanged: the envelope answers
 *    them by status;
 *  - SCHEDULE_LOCKED is MD_NO_APPROVE, 403: a locked schedule is the desk's;
 *  - a word `MD_WORD_OF` names becomes that md_ word, 409;
 *  - any other 409 (an HttpError, or an engine code `ENGINE_HTTP` answers 409) is MD_STALE: the state moved under the
 *    review, so review again — SEEDING_FIXTURES_ALREADY_FILLED among them (a seat filled after the draft: a desk edit,
 *    or a stage already seeded when its source completed);
 *  - any other coded 4xx (a 422 SEEDING_RULES_MISSING: a draw asked of a Swiss stage) keeps its status with no word,
 *    logged at warn with ids only: a client's or an organiser's state, never a page;
 *  - the rest (a coded 5xx, an engine code with no status) is a fault: 500, with the upstream error as its `cause` (N2).
 */
export function mdRefusalOf(asked: Asked, e: unknown): unknown {
  const code = e instanceof HttpError ? e.code : EngineError.is(e) ? e.code : undefined;
  if (code === undefined || MD_WORDS.has(code)) return e;
  if (code === SCHEDULE_LOCKED_CODE) return LOCKED();
  const status = e instanceof HttpError ? e.status : ENGINE_HTTP[code as keyof typeof ENGINE_HTTP];
  const word = MD_WORD_OF[code] ?? (status === 409 ? "MD_STALE" : undefined);
  if (word !== undefined) return new HttpError(409, MD_MESSAGE[word], word);
  if (status !== undefined && status >= 400 && status < 500) {
    log.warn({ ...asked, upstream: code, status }, "match day approval: a refusal with no md_ word, answered by its status");
    return new HttpError(status, "this approval cannot be made with a Match Day code");
  }
  log.warn({ ...asked, upstream: code, status }, "match day approval: a fault, answered 500");
  const fault = new HttpError(500, "this approval could not be completed", "INTERNAL");
  fault.cause = e;
  return fault;
}

/** `run`, with every refusal it raises put in md_ words (`mdRefusalOf`). */
async function inMdWords<T>(asked: Asked, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw mdRefusalOf(asked, e);
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
 * stage on its courts on its day). Answers the division's name, and whether its schedule is locked.
 */
async function stageForCode(code: MatchDayCodeRow, stageId: string): Promise<{ divisionName: string; locked: boolean }> {
  assertUuid(stageId, "stage");
  return withTenant(code.orgId, async (tx) => {
    const [stage] = await tx<
      { competition_id: string; division_name: string; status: string; division_live: boolean; locked: boolean }[]
    >`
      select d.competition_id, d.name as division_name, s.status, (d.archived_at is null) as division_live,
             d.schedule_locked as locked
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
    return { divisionName: stage.division_name, locked: stage.locked };
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
  const preview = await inMdWords({ codeId: code.id, stageId, kind: "swiss" }, () => previewSwissNextRound(matchDayActor(code), stageId));
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
  return inMdWords({ codeId: code.id, stageId, kind: "draw" }, () => computeSeedProposal(actor, stageId));
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
  // Minor M4: a draft with nobody left to seed is no approval (its confirm refuses SEEDING_NOTHING_TO_FILL).
  if (rows.length === 0) throw new HttpError(409, MD_MESSAGE.MD_STALE, "MD_STALE");
  return { kind: "draw", stage_id: stageId, division_name: divisionName, round: null, rows, hash: draft.id, ties: draft.computed.ties.length > 0 };
}

// ---------------------------------------------------------------------------------------------------------------
// The two doors.
// ---------------------------------------------------------------------------------------------------------------

/** A draw of a locked division is MD_NO_APPROVE, asked here: the seed proposal's usecases read no lock. A Swiss round's
 *  lock is the Swiss usecases' own, checked inside their transaction (SCHEDULE_LOCKED, put in md_ words above). */
function requireUnlockedDraw(kind: ApprovalKind, locked: boolean): void {
  if (kind === "draw" && locked) throw LOCKED();
}

/**
 * Review an approval (§7 "Review opens the proposal read-only"): the rows exactly as the server computed them, the `hash`
 * the approve hands back (Swiss: the preview's input hash; draw: the proposal's id), `round` (Swiss: the round awaiting
 * pairing, the day read's; draw: null) and `ties` (a draw whose tie only the desk can resolve). Not read-only underneath:
 * a draw with no live draft computes one (the desk's Recompute), and a Swiss preview commits its round's lots draw.
 */
export async function reviewApprovalForCode(code: MatchDayCodeRow, kind: ApprovalKind, stageId: string): Promise<Review> {
  requireCanApprove(code);
  const { divisionName, locked } = await stageForCode(code, stageId);
  requireUnlockedDraw(kind, locked);
  return kind === "swiss" ? swissReview(code, stageId, divisionName) : drawReview(code, stageId, divisionName);
}

/**
 * Approve what the review showed (§7 "Approve"): Swiss — pair `round` if `hash` still describes its inputs; draw —
 * confirm the proposal `hash` with no edits and no tie picks. The first of two phones wins; the second is MD_ALREADY.
 * Refusals: MD_NO_APPROVE (no tick, or the division's schedule locked), MD_OUT_OF_SCOPE, MD_STALE, MD_ALREADY, MD_TIES;
 * 404 for an unknown stage or proposal; 422 for a Swiss approve without a whole `round`, or a kind the stage has not.
 * Each approve writes one `match_day_code_uses` row once it has committed (a refusal writes none).
 */
export async function approveForCode(
  code: MatchDayCodeRow,
  kind: ApprovalKind,
  stageId: string,
  input: { hash: string; round?: number | null },
): Promise<CaptureMatchdayApprovalOk> {
  requireCanApprove(code);
  requireUnlockedDraw(kind, (await stageForCode(code, stageId)).locked);
  const actor = matchDayActor(code);
  const asked: Asked = { codeId: code.id, stageId, kind };
  if (kind === "swiss") {
    await inMdWords(asked, () => pairSwissNextRound(actor, stageId, input.hash, input.round ?? Number.NaN));
  } else {
    if (!UUID.test(input.hash)) throw new HttpError(404, "seed proposal not found");
    await inMdWords(asked, () => confirmSeedProposal(actor, stageId, { proposalId: input.hash }));
  }
  await logApproval(asked);
  return { ok: true };
}

/**
 * The approval's use row (spec §3), after the approval committed, on the pooled client (the use log is sealed): the stage
 * usecases own their transactions, so the row cannot be in the approval's own one (the controller's ruling, Task 6 fix
 * round 1: keep it after the commit, never widen the privileged epilogue's allow-list). A pino line first (review M1), so a
 * crash before the insert still leaves a trace on the server; an insert that fails is a warning, never the approval's
 * answer — the approval has committed, and a 500 would send the phone to MD_ALREADY on its retry.
 */
async function logApproval(asked: Asked): Promise<void> {
  log.info(asked, "match_day_approve");
  try {
    await logMatchDayUse(asked.codeId, { kind: "approve", stageId: asked.stageId, approval: asked.kind });
  } catch (e) {
    const pg = (e as { code?: unknown }).code;
    log.warn({ ...asked, pg: typeof pg === "string" ? pg : undefined }, "match day approval: its use row was not written");
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
