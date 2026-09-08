// B05 T3 — stage advancement (design doc §3 D1/D7, §4).
//
// Folds a stage's own `propose -> assert -> confirm -> generate -> complete`
// flow through the LIVE routes (`B05-repins-2026-09-07.md`'s own "Verified
// pins — advancement" table): `POST /stages/{id}/seed-proposal`,
// `.../seed-proposal/confirm`, `.../generate`, `.../complete` — all four
// `/api/v1`-reachable, so no bench-as-organizer fallback is owed (the design
// doc's own F2 finding).
//
// ---------------------------------------------------------------------------
// D7 — assert BEFORE you write
// ---------------------------------------------------------------------------
// The expected qualifier list (the CALLER's own, derived from the pack's
// `expected.tables` for the source stage — this file never reads a pack) is
// compared against the computed proposal's qualifiers, ordered by rank,
// BEFORE `confirm` is ever called. A mismatch stops `advanceStageSeeding`
// cold: `confirmed`/`generated` are both left `undefined`, and neither the
// confirm nor the generate route is ever called for that stage. This is the
// exact "propose -> assert -> confirm -> generate" order design doc D7 names,
// with the assertion sitting in the middle rather than either end.
//
// ---------------------------------------------------------------------------
// D1 — capture, because you cannot re-read
// ---------------------------------------------------------------------------
// `POST /stages/{id}/complete`'s response is the ONLY place `finalRanks`
// crosses the wire (`competition.ts:487-499`'s `stage_completed` event,
// `events[0]` — every stage kind's own completion writes exactly one such
// event, table kinds via `completeTableStage`'s `crossPoolOrder`, bracket
// kinds via `completeBracketStage`'s `bracketRanks`). `GET
// /divisions/{id}/history` selects `seq, type, actor_id, created_at` and NOT
// `payload` (`usecases/history.ts:375-397`), so a caller that let this
// response go and tried to re-derive `finalRanks` from history later would
// find nothing — `completeStageCapture` reads `events[0]` off THIS response,
// once, and that is the only chance there ever is.
import { raw, type RawResult, type Session } from "./http.ts";

// ---------------------------------------------------------------------------
// Transport — same narrow, injected, defaulted-to-the-real-thing shape every
// other bench probe in this directory uses (see
// `reference_bench_transport_di_pattern.md`): this file's only primitive is
// `raw()`, for the same reason `simulate.ts`/`import.ts`/`schedule.ts`'s own
// division-start step need it — reading back a refusal's real status and body,
// which `request()` discards by throwing.
// ---------------------------------------------------------------------------
export interface AdvanceTransport {
  raw(base: string, s: Session, path: string, method?: string, body?: unknown): Promise<RawResult>;
}

export const defaultAdvanceTransport: AdvanceTransport = { raw };

// ---------------------------------------------------------------------------
// The wire shapes this file sends/reads — hand-declared, matching the
// product's `SeedProposal` / `ConfirmSeedProposal` / `GenerateOutcome` /
// `CompleteStageResult` (schemas.ts / usecases/stages.ts) field for field, for
// the same "cannot import apps/web" reason `import.ts`'s own `IMPORT_CAPS`
// header comment gives (most of that tree is `server-only`, and no PRODUCTION
// file under `scripts/bench/lib/` imports from `apps/web` — established
// convention, not a new exception).
// ---------------------------------------------------------------------------

interface SeedProposalQualifierWire {
  readonly rank: number;
  readonly entrantId: string;
}

interface SeedProposalWire {
  readonly id: string;
  readonly stageId: string;
  readonly status: "draft" | "confirmed" | "stale";
  readonly computed: {
    readonly qualifiers: readonly SeedProposalQualifierWire[];
    readonly standingsHash: string;
  };
}

interface ConfirmSeedProposalWire {
  readonly proposalId: string;
  readonly filled: number;
}

interface GenerateOutcomeWire {
  readonly created: number;
  readonly existing: number;
}

/** One `division_events` row as `POST /stages/{id}/complete`'s response
 *  carries it verbatim (`DivisionEvent`, engine-db/competition.ts) — every
 *  stage kind's own completion writes exactly one `stage_completed` entry
 *  (D1's own header note); this file reads only that variant and ignores
 *  every other `type` a caller might see on `division_events` generally
 *  (`rank_lock_required`, `rank_lock`, …), which never appear in THIS
 *  response (`completeStageIfReady`'s own `events` array is scoped to the
 *  one stage being completed). */
interface StageCompletedEventWire {
  readonly type: string;
  readonly stageId?: string;
  readonly finalRanks?: readonly string[];
}

interface CompleteStageResultWire {
  readonly completed: boolean;
  readonly events: readonly StageCompletedEventWire[];
  readonly division_completed?: boolean;
}

/** The v1 error envelope this file actually reads (`api-v1/http.ts`'s
 *  `errorResponse`: `{ ok: false, error: { code, message, ...extra } }`) —
 *  same local-type convention `simulate.ts`/`import.ts`/`schedule.ts` each
 *  declare independently rather than trusting `lib/http.ts`'s loosely-typed
 *  `RawJson`. */
interface V1ErrorEnvelope {
  readonly ok: false;
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
  };
}

function errorOf(result: RawResult): { code?: string; message?: string } {
  const body = result.json as unknown as V1ErrorEnvelope;
  const err = body?.ok === false ? body.error : undefined;
  return { code: err?.code, message: err?.message };
}

function dataOf<T>(result: RawResult, path: string, label: string): T {
  const data = (result.json as unknown as { data?: T })?.data;
  if (data === undefined) {
    throw new Error(`advance: ${label} response for ${path} carried no data`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// The qualifier assertion (D7) — pure, so the ordering/mismatch branches are
// unit-testable without any HTTP at all.
// ---------------------------------------------------------------------------

export interface QualifierComparison {
  /** True iff `actual` equals `expected`, element for element, in order. */
  readonly matched: boolean;
  /** The caller's own expectation, rank 1 first. */
  readonly expected: readonly string[];
  /** The proposal's own qualifiers, sorted by `rank` ascending, entrantId
   *  only. */
  readonly actual: readonly string[];
}

export function compareQualifiers(
  expected: readonly string[],
  computed: readonly SeedProposalQualifierWire[],
): QualifierComparison {
  const actual = [...computed].sort((a, b) => a.rank - b.rank).map((q) => q.entrantId);
  const matched =
    actual.length === expected.length && actual.every((id, i) => id === expected[i]);
  return { matched, expected, actual };
}

// ---------------------------------------------------------------------------
// propose -> assert -> confirm -> generate
// ---------------------------------------------------------------------------

export interface AdvanceStageSeedingInput {
  readonly base: string;
  readonly session: Session;
  /** The stage being seeded (the PROGRESSION TARGET — e.g. `s-playoff`, not
   *  the source its standings are read from). */
  readonly stageId: string;
  /** The caller's own expected qualifier order, entrant ids, rank 1 first —
   *  derived from the pack (e.g. the source stage's `expected.tables` rows,
   *  in rank order, resolved to real ids). This file never reads a pack. */
  readonly expectedQualifierEntrantIds: readonly string[];
  readonly transport?: AdvanceTransport;
}

export interface AdvanceStageSeedingResult {
  readonly stageId: string;
  readonly proposalId: string;
  readonly qualifierCheck: QualifierComparison;
  /** Undefined iff the assertion failed (D7) — confirm is never called. */
  readonly confirmed?: { readonly filled: number };
  /** Undefined iff the assertion failed — generate is never called. Present
   *  whenever confirm ran, even if generate found nothing new (idempotent —
   *  the stage's TBD fixture already exists from `seedSuite`'s own per-stage
   *  `/generate` loop at pack-setup time). */
  readonly generated?: { readonly created: number; readonly existing: number };
}

/**
 * `propose -> assert -> confirm -> generate` for ONE target stage (D7). Never
 * calls `complete` — that is `completeStageCapture`'s own job, and the
 * caller decides what happens between the two (folding the newly-seeded
 * stage's own fixtures, in `_tiny`'s case).
 *
 * Every refusal from `seed-proposal` or `confirm` throws — an unexpected
 * status here (`SEEDING_RULES_MISSING`, `SEEDING_ALREADY_CONFIRMED`,
 * `SEEDING_SOURCE_INCOMPLETE`, …) is a genuine finding this bench must catch,
 * not a silent skip (same "a refusal is a FINDING" discipline `simulate.ts`'s
 * D5 states, generalised: unlike a live score stream, a wrong advancement
 * call has no legitimate "stop this one and keep going" shape — the whole
 * stage's seeding either worked or it did not).
 */
export async function advanceStageSeeding(
  input: AdvanceStageSeedingInput,
): Promise<AdvanceStageSeedingResult> {
  const t = input.transport ?? defaultAdvanceTransport;
  const { base, session, stageId } = input;

  const proposePath = `/api/v1/stages/${stageId}/seed-proposal`;
  const proposeResult = await t.raw(base, session, proposePath, "POST", {});
  if (proposeResult.status !== 201) {
    const { code, message } = errorOf(proposeResult);
    throw new Error(
      `advance: seed-proposal refused — HTTP ${proposeResult.status} ${code ?? "(no code)"} — ${message ?? "(no message)"}`,
    );
  }
  const proposal = dataOf<SeedProposalWire>(proposeResult, proposePath, "seed-proposal");

  // D7 — THE ASSERTION, before any write. A mismatch stops here: neither
  // confirm nor generate is ever called for this stage.
  const qualifierCheck = compareQualifiers(
    input.expectedQualifierEntrantIds,
    proposal.computed.qualifiers,
  );
  if (!qualifierCheck.matched) {
    return { stageId, proposalId: proposal.id, qualifierCheck };
  }

  const confirmPath = `/api/v1/stages/${stageId}/seed-proposal/confirm`;
  const confirmResult = await t.raw(base, session, confirmPath, "POST", {
    proposalId: proposal.id,
  });
  if (confirmResult.status !== 200) {
    const { code, message } = errorOf(confirmResult);
    throw new Error(
      `advance: seed-proposal/confirm refused — HTTP ${confirmResult.status} ${code ?? "(no code)"} — ${message ?? "(no message)"}`,
    );
  }
  const confirmed = dataOf<ConfirmSeedProposalWire>(confirmResult, confirmPath, "confirm");

  const generatePath = `/api/v1/stages/${stageId}/generate`;
  const generateResult = await t.raw(base, session, generatePath, "POST", {});
  if (generateResult.status !== 200) {
    const { code, message } = errorOf(generateResult);
    throw new Error(
      `advance: generate refused — HTTP ${generateResult.status} ${code ?? "(no code)"} — ${message ?? "(no message)"}`,
    );
  }
  const generated = dataOf<GenerateOutcomeWire>(generateResult, generatePath, "generate");

  return {
    stageId,
    proposalId: proposal.id,
    qualifierCheck,
    confirmed: { filled: confirmed.filled },
    generated: { created: generated.created, existing: generated.existing },
  };
}

// ---------------------------------------------------------------------------
// complete — captured (D1)
// ---------------------------------------------------------------------------

export interface CompleteStageCapture {
  readonly stageId: string;
  readonly completed: boolean;
  /** Off `events[0]` — see this file's header comment on why index 0,
   *  specifically, and why this is the ONLY chance to read it. Undefined
   *  when the stage did not complete (`completed: false`, e.g. its own
   *  fixtures are not all decided yet) or completed with no
   *  `stage_completed` event for some other reason this bench has not seen. */
  readonly finalRanks?: readonly string[];
  readonly divisionCompleted?: boolean;
}

/**
 * `POST /stages/{id}/complete`, captured at the moment it returns (D1). Every
 * non-200 throws — same "a refusal is a genuine finding" reasoning
 * `advanceStageSeeding` states, and doubly so here: a completion refusal
 * (the stage's own fixtures not all decided, most likely) means whatever
 * folded its events did not actually finish the stage, which is exactly the
 * kind of silent gap this whole layer exists to catch rather than paper over.
 */
export async function completeStageCapture(
  base: string,
  session: Session,
  stageId: string,
  transport?: AdvanceTransport,
): Promise<CompleteStageCapture> {
  const t = transport ?? defaultAdvanceTransport;
  const path = `/api/v1/stages/${stageId}/complete`;
  const result = await t.raw(base, session, path, "POST", {});
  if (result.status !== 200) {
    const { code, message } = errorOf(result);
    throw new Error(
      `advance: complete refused — HTTP ${result.status} ${code ?? "(no code)"} — ${message ?? "(no message)"}`,
    );
  }
  const data = dataOf<CompleteStageResultWire>(result, path, "complete");
  const first = data.events[0];
  const finalRanks = first?.type === "stage_completed" ? first.finalRanks : undefined;
  return {
    stageId,
    completed: data.completed,
    ...(finalRanks === undefined ? {} : { finalRanks }),
    ...(data.division_completed === undefined ? {} : { divisionCompleted: data.division_completed }),
  };
}

// ---------------------------------------------------------------------------
// The finalRanks comparison (D1) — pure, exact array equality. A "compare
// lengths only" mutant (same count, different order) must fail this: order
// IS the assertion (`PackExpectedFinalRanks`'s own doc comment makes the
// identical point about the pack's own authored shape).
// ---------------------------------------------------------------------------

export interface FinalRanksComparison {
  readonly matched: boolean;
  readonly expected: readonly string[];
  readonly actual: readonly string[] | undefined;
  /** Set only on a false-by-EMPTINESS verdict (either side reporting zero
   *  entrants) — the same field, with the same meaning, as
   *  `RankCrossingComparison.reason` (oracle.ts). It distinguishes "there was
   *  nothing to agree on" from an ordinary order/length mismatch between two
   *  real rankings. Deliberately NOT set for `actual === undefined`, which is
   *  its own long-standing verdict (`actual` is right there in the result,
   *  saying so). */
  readonly reason?: string;
}

/**
 * B05 review round 1, MAJOR 3: this carried the exact vacuous-pass shape
 * `compareRankCrossings` was fixed for in 8376359cc. `[].every(…)` is
 * vacuously true and `0 === 0`, so empty/empty reported `matched: true` — a
 * comparator agreeing with nothing at all. It was unreachable in practice only
 * because `pack-schema.ts`'s `PackExpectedFinalRanks` declares `order.min(2)`,
 * and a schema constraint elsewhere is not the comparator's own discipline: a
 * later pack shape, or a second caller, silently re-opens it. So an empty side
 * reds here, with a `reason`, exactly as the crossings comparator does.
 */
export function compareFinalRanks(
  expected: readonly string[],
  actual: readonly string[] | undefined,
): FinalRanksComparison {
  if (actual === undefined) {
    return { matched: false, expected, actual };
  }
  if (expected.length === 0 || actual.length === 0) {
    return {
      matched: false,
      expected,
      actual,
      reason: "empty expected or empty actual finalRanks — nothing to agree on",
    };
  }
  const matched = actual.length === expected.length && actual.every((id, i) => id === expected[i]);
  return { matched, expected, actual };
}
