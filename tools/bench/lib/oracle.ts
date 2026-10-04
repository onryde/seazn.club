// B05 T4 — the oracles (design doc §3 D1/D2/D6, §4; bench spec §8).
//
// This is the layer the whole simulation wave exists for: T1/T2 fold a
// pack's own historical events through the LIVE write paths, T2.5 starts the
// division, T3 advances a stage and CAPTURES its `complete` response — none
// of that means anything until something compares what the engine actually
// derived against what the pack says history did. This file is that
// comparison, for every subject the design doc names: standings + exact tie
// order, ranks (both crossings, D1), champion (D2), leaderboards (name AND
// count), and person/career stats.
//
// ---------------------------------------------------------------------------
// D6 — a RUNTIME oracle, not a restatement of stage 0
// ---------------------------------------------------------------------------
// `pack-schema.ts` and `validate-pack.ts` already fold `pack.expected`
// OFFLINE at stage 0 — pure self-consistency (do the rows' points reconcile
// with wins/draws/losses, does `finalRanks`' order agree with `champions`,
// …). Every comparator in this file takes its "actual" side from a LIVE
// fetch (or, in a test, an independently-faked response standing in for
// one) — never from re-reading `pack.expected` a second time. See
// `oracle.test.ts`'s own D6 regression: a pack that passes stage 0, then has
// ONE event mutated AFTER that pass, still passes stage 0 (it never looks at
// events) — only a comparator here, fed the DIFFERENT value the mutation
// would actually produce, catches it.
//
// ---------------------------------------------------------------------------
// This file never reads a pack directly
// ---------------------------------------------------------------------------
// Same convention `advance.ts`/`simulate.ts` already establish: every
// comparator takes its "expected" side pre-resolved (pack refs already
// mapped to the real ids `seedSuite` minted) by its caller. Keeps every
// function here pure and independent of `pack-schema.ts`'s types, so a unit
// test can hand-build a fixture without touching a pack at all.
//
// ---------------------------------------------------------------------------
// Wire shapes are hand-mirrored, not imported
// ---------------------------------------------------------------------------
// Same "cannot import apps/web" reason `advance.ts`'s own header gives —
// most of that tree is `server-only`, and no production file under
// `tools/bench/lib/` imports from `apps/web`. Types below match
// `usecases/stages.ts#getStandings` (`StandingsOut`),
// `packages/engine/src/competition/standings.ts#StandingsRow`,
// `usecases/player-stats.ts#divisionPlayerStats/personStats/
// personCareerStats`, field for field (`B05-repins-2026-09-07.md`'s
// "Verified pins — oracles" table).
// The engine's own outcome union, as a RUNTIME value: `compareMatches`
// parses the wire's jsonb through it rather than reading fields off an
// `unknown` (see that comparator's own note).
import { MatchOutcome, ScoreSummary } from "@seazn/engine/core";
import { raw, type RawResult, type Session } from "./http.ts";
// The dotted-path reader stage 0 already uses for the same claims — it
// indexes ARRAYS as well as objects, which a second copy of it here did
// not, and one authority per fact is the point.
import { resolveStatePath } from "./validate-pack.ts";

// ---------------------------------------------------------------------------
// Transport — same narrow, injected, defaulted-to-the-real-thing shape every
// other B05 file in this directory uses (`reference_bench_transport_di_
// pattern.md`): `raw()` only, so a refusal is read back as a real status +
// body rather than thrown away by `request()`.
// ---------------------------------------------------------------------------
export interface OracleTransport {
  raw(base: string, s: Session, path: string, method?: string, body?: unknown): Promise<RawResult>;
}

export const defaultOracleTransport: OracleTransport = { raw };

/** The v1 error envelope this file actually reads — same local-type
 *  convention `advance.ts`/`simulate.ts`/`import.ts` each declare
 *  independently rather than trusting `lib/http.ts`'s loosely-typed
 *  `RawJson`. */
interface V1ErrorEnvelope {
  readonly ok: false;
  readonly error?: { readonly code?: string; readonly message?: string };
}

function errorOf(result: RawResult): { code?: string; message?: string } {
  const body = result.json as unknown as V1ErrorEnvelope;
  const err = body?.ok === false ? body.error : undefined;
  return { code: err?.code, message: err?.message };
}

// Minors row 7 (task-1-review.md §Minor M4 / task-1-re-review.md §4): this
// exact shape used to be hand-copied into `advance.ts` too, differing only
// in the literal module prefix ("oracle" vs "advance") — genuinely the same
// function, so `advanceStageSeeding`'s own `dataOf` now binds this factory
// to "advance" instead of re-declaring it. `ledger.ts`'s `dataOrThrow` and
// `import.ts`'s inline check were read too and deliberately NOT folded in
// here: `dataOrThrow` also performs the refusal check (`status !== 200`) in
// the same function and treats `null` as absent alongside `undefined`, and
// `import.ts`'s throw has no `label` at all (hardcodes "200") and appends
// its own "— cannot read its report" clause — real behavioural differences
// a shared helper would either erase or have to grow conditionals to keep,
// which defeats the point of sharing. Only the two byte-identical copies
// were merged.
export function makeDataOf(modulePrefix: string) {
  return function dataOf<T>(result: RawResult, path: string, label: string): T {
    const data = (result.json as unknown as { data?: T })?.data;
    if (data === undefined) {
      throw new Error(`${modulePrefix}: ${label} response for ${path} carried no data`);
    }
    return data;
  };
}

const dataOf = makeDataOf("oracle");

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/** `packages/engine/src/competition/standings.ts#StandingsRow`, verbatim. */
export interface StandingsRowWire {
  readonly entrantId: string;
  readonly played: number;
  readonly won: number;
  readonly drawn: number;
  readonly lost: number;
  readonly points: number;
  readonly metrics?: Record<string, number>;
  readonly rank?: number;
  readonly rankLocked?: boolean;
  readonly tieUnbroken?: boolean;
  readonly tieBreak?: { readonly key: string; readonly with: readonly string[] };
}

/** `usecases/stages.ts#StandingsOut`. */
export interface StandingsWire {
  readonly stage_id: string;
  readonly pool_id: string | null;
  readonly rows: readonly StandingsRowWire[];
  readonly computed_through_seq: number;
  readonly updated_at: string | null;
}

export interface LeaderboardMetricWire {
  readonly key: string;
  readonly label: string;
}

export interface LeaderboardRowWire {
  readonly person_id: string;
  readonly full_name: string;
  readonly squad_number?: number | null;
  readonly entrant?: string | null;
  readonly stats: Record<string, number>;
  readonly public_profile?: boolean;
}

/** `usecases/player-stats.ts#divisionPlayerStats`'s return shape. */
export interface DivisionPlayerStatsWire {
  readonly metrics: readonly LeaderboardMetricWire[];
  readonly rows: readonly LeaderboardRowWire[];
  readonly requires_detailed_scoring: boolean;
}

export interface PersonDivisionStatsWire {
  readonly division_id: string;
  readonly division_name: string;
  readonly stats: Record<string, number>;
}

/** `usecases/player-stats.ts#personStats`'s return shape. */
export interface PersonStatsWire {
  readonly divisions: readonly PersonDivisionStatsWire[];
}

export interface PersonCareerMetricWire {
  readonly key: string;
  readonly label: string;
  readonly value: number;
}

/** `usecases/player-stats.ts#CareerSportStats`. `divisions`/`variants` are
 *  COUNTS (distinct division_id / variant_key), never arrays — a plausible
 *  first read of the repin's "divisions, variants, matches" list. */
export interface PersonCareerSportWire {
  readonly sport_key: string;
  readonly sport_label: string;
  readonly metrics: readonly PersonCareerMetricWire[];
  readonly divisions: number;
  readonly variants: number;
  readonly matches: number;
}

/** `usecases/player-stats.ts#personCareerStats`'s return shape. */
export interface PersonCareerStatsWire {
  readonly sports: readonly PersonCareerSportWire[];
}

// ---------------------------------------------------------------------------
// Fetch wrappers — thin, one per route. Every one throws on a non-200 (a
// read-side refusal here is always a genuine bug or a wiring mistake — never
// a legitimate "stop and record a finding" outcome the way a write-side
// refusal is in `simulate.ts`/`import.ts`).
// ---------------------------------------------------------------------------

export async function fetchStandings(
  base: string,
  session: Session,
  stageId: string,
  poolId?: string,
  transport?: OracleTransport,
): Promise<StandingsWire> {
  const t = transport ?? defaultOracleTransport;
  const path = `/api/v1/stages/${stageId}/standings${poolId === undefined ? "" : `?pool_id=${encodeURIComponent(poolId)}`}`;
  const result = await t.raw(base, session, path, "GET");
  if (result.status !== 200) {
    const { code, message } = errorOf(result);
    throw new Error(`oracle: standings refused — HTTP ${result.status} ${code ?? "(no code)"} — ${message ?? "(no message)"}`);
  }
  return dataOf<StandingsWire>(result, path, "standings");
}

export async function fetchDivisionPlayerStats(
  base: string,
  session: Session,
  divisionId: string,
  transport?: OracleTransport,
): Promise<DivisionPlayerStatsWire> {
  const t = transport ?? defaultOracleTransport;
  const path = `/api/v1/divisions/${divisionId}/stats/players`;
  const result = await t.raw(base, session, path, "GET");
  if (result.status !== 200) {
    const { code, message } = errorOf(result);
    throw new Error(`oracle: division player stats refused — HTTP ${result.status} ${code ?? "(no code)"} — ${message ?? "(no message)"}`);
  }
  return dataOf<DivisionPlayerStatsWire>(result, path, "division player stats");
}

export async function fetchPersonStats(
  base: string,
  session: Session,
  personId: string,
  divisionId?: string,
  transport?: OracleTransport,
): Promise<PersonStatsWire> {
  const t = transport ?? defaultOracleTransport;
  const path = `/api/v1/persons/${personId}/stats${divisionId === undefined ? "" : `?division_id=${encodeURIComponent(divisionId)}`}`;
  const result = await t.raw(base, session, path, "GET");
  if (result.status !== 200) {
    const { code, message } = errorOf(result);
    throw new Error(`oracle: person stats refused — HTTP ${result.status} ${code ?? "(no code)"} — ${message ?? "(no message)"}`);
  }
  return dataOf<PersonStatsWire>(result, path, "person stats");
}

export async function fetchPersonCareerStats(
  base: string,
  session: Session,
  personId: string,
  transport?: OracleTransport,
): Promise<PersonCareerStatsWire> {
  const t = transport ?? defaultOracleTransport;
  const path = `/api/v1/persons/${personId}/stats?group=sport`;
  const result = await t.raw(base, session, path, "GET");
  if (result.status !== 200) {
    const { code, message } = errorOf(result);
    throw new Error(`oracle: person career stats refused — HTTP ${result.status} ${code ?? "(no code)"} — ${message ?? "(no message)"}`);
  }
  return dataOf<PersonCareerStatsWire>(result, path, "person career stats");
}

// ---------------------------------------------------------------------------
// Rendering — a mismatch nobody can read is a finding nobody acts on. One
// generic side-by-side text table, reused by every comparator's own
// `detail` string.
// ---------------------------------------------------------------------------

/** Renders `label: line` pairs, expected above actual, for every row a
 *  caller flags as mismatched. Kept as a plain multi-line string (not a
 *  structured value) because every existing `OracleResult.detail` in this
 *  codebase is one (`report.ts:409`) — this file matches that contract
 *  rather than inventing a second one. */
export function renderSideBySide(
  rows: readonly { readonly label: string; readonly expected: string; readonly actual: string }[],
): string {
  if (rows.length === 0) return "(no mismatches)";
  return rows
    .map((r) => `${r.label}:\n    expected: ${r.expected}\n    actual:   ${r.actual}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// 1/2 — Standings + exact tie order
// ---------------------------------------------------------------------------

/** The caller's own resolved expectation for one row — `PackExpectedTableRow`
 *  with `entrant` already resolved to a real id, `rank` dropped (array
 *  position IS the rank, `pack-schema.ts`'s own `PackExpectedTableRow`
 *  comment: a refinement there already forces the two to agree, so this file
 *  only ever needs to trust ARRAY ORDER, rank-1 first). */
export interface ExpectedStandingsRow {
  readonly entrantId: string;
  readonly played: number;
  readonly won: number;
  readonly drawn: number;
  readonly lost: number;
  readonly points: number;
  readonly metrics?: Record<string, number>;
}

export interface StandingsRowComparison {
  readonly entrantId: string;
  readonly matched: boolean;
  readonly expected: ExpectedStandingsRow;
  readonly actual: StandingsRowWire | undefined;
  /** Which fields disagreed — empty when `actual` is undefined (the whole
   *  row is the mismatch then) or when `matched`. */
  readonly mismatchFields: readonly string[];
  /** B05 T6 — the DECLARED metric keys behind a `"metrics"` entry in
   *  `mismatchFields`, so a reader is told WHICH metric moved rather than
   *  "the maps differ". Empty whenever `mismatchFields` carries no
   *  `"metrics"`. */
  readonly mismatchedMetrics: readonly string[];
  /** B05 T6 — metrics the LIVE row carries that this pack row never
   *  declared. Never a failure (see `compareMetrics`), but carried through
   *  to the report so an undeclared metric is visible rather than dropped. */
  readonly undeclaredMetrics: Readonly<Record<string, number>>;
}

export interface StandingsComparison {
  readonly matched: boolean;
  readonly rows: readonly StandingsRowComparison[];
}

/** B05 T6 fix 1 — the outcome of comparing ONE row's metrics map. Split into
 *  two halves because they answer two different questions and the first live
 *  run proved conflating them is a defect. */
export interface MetricsComparison {
  /** Keys the PACK declares whose live value differs — or which the live row
   *  does not carry at all. These, and only these, are failures. */
  readonly mismatched: readonly string[];
  /** Keys the live row carries that the pack never declared, with their live
   *  values. Informational: reported so a reader SEES them (silently
   *  discarding them is how a genuinely wrong metric would hide), never
   *  gated. */
  readonly undeclared: Readonly<Record<string, number>>;
}

/**
 * Compares a live metrics map against the pack's own DECLARED one, as a
 * SUBSET rather than an equality.
 *
 * The first live run (`bench-report/4b739e59…/report.md:34-39`) failed
 * `d-tiny/s-league` and `d-badminton/s-badminton-league` on nothing else:
 * every field those tables declare matched exactly, and the rows still red
 * because the live standings carry a sport-shaped metrics map
 * (`for`/`diff`/`against` for football, `sets_won`/`sets_lost`/`points_won`/
 * `points_lost` for badminton) that the pack's `expected.tables` row does
 * not mention. Under the old key-count equality, a pack that omits the
 * OPTIONAL metrics map could never pass — which is a comparator defect, not
 * a pack defect, and is why the repair belongs here and not in `_tiny.json`.
 *
 * A declared key is still checked strictly, in BOTH directions: a live value
 * that differs reds, and so does a declared key the live row omits entirely
 * (absence is not agreement).
 */
export function compareMetrics(
  expected: Record<string, number> | undefined,
  actual: Record<string, number> | undefined,
): MetricsComparison {
  const exp = expected ?? {};
  const act = actual ?? {};
  // A DECLARED key the live row omits entirely is covered by this SAME
  // comparison (`act[k]` is then `undefined`, never equal to a declared
  // number) — deliberately not a second `Object.hasOwn(act, k)` conjunct
  // beside it, which measured as an unkillable mutant: two guards covering
  // for each other are each untested. `Object.hasOwn` IS load-bearing on the
  // `undeclared` side below, where a live key could otherwise be swallowed
  // by a prototype member of `exp`.
  const mismatched = Object.keys(exp).filter((k) => act[k] !== exp[k]);
  const undeclared: Record<string, number> = {};
  for (const [k, v] of Object.entries(act)) {
    if (!Object.hasOwn(exp, k)) undeclared[k] = v;
  }
  return { mismatched, undeclared };
}

/**
 * Compares a stage's LIVE standings against the pack's own expected order —
 * ORDER-SENSITIVE (array position, not just membership: a same-length,
 * reordered `actual` must NOT match) and LENGTH-SENSITIVE (an empty expected
 * table is itself a case this asserts on, never silently vacuous — a caller
 * handing this function `expected: []` gets `matched: actual.length === 0`
 * back, not a free pass).
 */
export function compareStandings(
  expected: readonly ExpectedStandingsRow[],
  actual: readonly StandingsRowWire[],
): StandingsComparison {
  const rows: StandingsRowComparison[] = expected.map((exp, i) => {
    const act = actual[i];
    if (act === undefined) {
      return {
        entrantId: exp.entrantId,
        matched: false,
        expected: exp,
        actual: undefined,
        mismatchFields: [],
        mismatchedMetrics: [],
        undeclaredMetrics: {},
      };
    }
    const mismatchFields: string[] = [];
    if (act.entrantId !== exp.entrantId) mismatchFields.push("entrantId");
    if (act.played !== exp.played) mismatchFields.push("played");
    if (act.won !== exp.won) mismatchFields.push("won");
    if (act.drawn !== exp.drawn) mismatchFields.push("drawn");
    if (act.lost !== exp.lost) mismatchFields.push("lost");
    if (act.points !== exp.points) mismatchFields.push("points");
    const metrics = compareMetrics(exp.metrics, act.metrics);
    if (metrics.mismatched.length > 0) mismatchFields.push("metrics");
    return {
      entrantId: exp.entrantId,
      matched: mismatchFields.length === 0,
      expected: exp,
      actual: act,
      mismatchFields,
      mismatchedMetrics: metrics.mismatched,
      undeclaredMetrics: metrics.undeclared,
    };
  });
  const matched = rows.every((r) => r.matched) && actual.length === expected.length;
  return { matched, rows };
}

function renderRow(r: ExpectedStandingsRow | StandingsRowWire | undefined): string {
  if (r === undefined) return "(absent)";
  return `${r.entrantId} P${r.played} W${r.won} D${r.drawn} L${r.lost} Pts${r.points}${r.metrics ? ` ${JSON.stringify(r.metrics)}` : ""}`;
}

/**
 * B05 T6 — the INFORMATIONAL half of the metrics rule: every live metric no
 * pack row declared, named with the row that carried it. Returns `""` when
 * there are none, so a caller can append it unconditionally and a clean
 * table stays byte-identical.
 *
 * This exists because "not a failure" must not become "not reported": an
 * undeclared metric that is silently dropped is exactly where a genuinely
 * wrong metric would hide.
 */
export function renderUndeclaredMetrics(cmp: StandingsComparison): string {
  return cmp.rows
    .filter((r) => Object.keys(r.undeclaredMetrics).length > 0)
    .map((r) => `${r.entrantId}: ${JSON.stringify(r.undeclaredMetrics)}`)
    .join("; ");
}

export function renderStandingsMismatch(cmp: StandingsComparison): string {
  const mismatched = cmp.rows.filter((r) => !r.matched);
  return renderSideBySide(
    mismatched.map((r) => ({
      label: `rank ${cmp.rows.indexOf(r) + 1} (${r.entrantId})`,
      expected: renderRow(r.expected),
      actual: renderRow(r.actual),
    })),
  );
}

// ---- tie order (the cascade the DIVISION configured, not a hardcoded one) ----

/** Reads one cascade key's value off a row — `points`/`won` (aliased as
 *  `wins`, the cascade's own vocabulary name, `TIEBREAKER_KEYS`) live as top-
 *  level `StandingsRow` fields; everything else lives in `metrics`.
 *  `undefined` when the row carries no such value at all — e.g. every
 *  `h2h_*` key, which needs head-to-head fixture data no single row exposes,
 *  and is therefore UNRESOLVABLE from this function by design (see
 *  `compareTieOrderCascade`'s own comment on what it does with that). */
function cascadeValue(row: StandingsRowWire, key: string): number | undefined {
  if (key === "points") return row.points;
  if (key === "wins") return row.won;
  return row.metrics?.[key];
}

export type TieWinner = "a" | "b" | "tie" | "unresolvable";

/** Walks `cascade` in order; the FIRST key where `a` and `b` differ decides
 *  ("higher wins" — true of every metric-shaped key in `TIEBREAKER_KEYS`
 *  this function can read: points, wins, diff, for, nrr/ratios, buchholz,
 *  fair_play is the one real exception in the live vocabulary but is not
 *  exercised by any pack today). A key neither row can supply a value for
 *  (an `h2h_*` key, absent `metrics`) makes the whole comparison
 *  `"unresolvable"` rather than silently skipping to the next key — skipping
 *  would let this function CLAIM a cascade it never actually evaluated. */
export function resolveTieWinner(cascade: readonly string[], a: StandingsRowWire, b: StandingsRowWire): TieWinner {
  for (const key of cascade) {
    const av = cascadeValue(a, key);
    const bv = cascadeValue(b, key);
    if (av === undefined || bv === undefined) return "unresolvable";
    if (av === bv) continue;
    return av > bv ? "a" : "b";
  }
  return "tie";
}

export interface TieOrderIssue {
  readonly entrantA: string;
  readonly entrantB: string;
  readonly detail: string;
}

export interface TieOrderComparison {
  readonly matched: boolean;
  /** How many adjacent pairs were actually decided by the cascade (both
   *  values resolvable) — 0 is a legitimate, honestly-reported outcome (no
   *  points-tie anywhere in this table), never rendered as a pass over
   *  something checked. */
  readonly checkedPairs: number;
  readonly skippedPairs: number;
  readonly issues: readonly TieOrderIssue[];
}

/**
 * Asserts that wherever two ADJACENT rows (by the live standings' own
 * array/rank order) are tied on points, the division's OWN configured
 * `cascade` — never a hardcoded field order — explains which one the
 * product ranked ahead. Per the re-pin's own instruction, this does not
 * impose an order the product never claimed: a pair the cascade cannot
 * resolve from a single row (an `h2h_*` decider) is counted as SKIPPED, not
 * failed.
 */
export function compareTieOrderCascade(
  cascade: readonly string[],
  rowsInRankOrder: readonly StandingsRowWire[],
): TieOrderComparison {
  const issues: TieOrderIssue[] = [];
  let checkedPairs = 0;
  let skippedPairs = 0;
  for (let i = 0; i < rowsInRankOrder.length - 1; i += 1) {
    const higher = rowsInRankOrder[i];
    const lower = rowsInRankOrder[i + 1];
    if (higher.points !== lower.points) continue; // not a tie at all — nothing to check
    const winner = resolveTieWinner(cascade, higher, lower);
    if (winner === "unresolvable") {
      skippedPairs += 1;
      continue;
    }
    checkedPairs += 1;
    if (winner === "b") {
      issues.push({
        entrantA: higher.entrantId,
        entrantB: lower.entrantId,
        detail: `cascade [${cascade.join(",")}] favours ${lower.entrantId} over ${higher.entrantId}, but the live order ranks ${higher.entrantId} ahead`,
      });
    }
    // "tie" (tieUnbroken territory) is not itself an issue — the product's
    // own array order is the only tiebreak left once the cascade is
    // exhausted, and this function does not second-guess that.
  }
  return { matched: issues.length === 0, checkedPairs, skippedPairs, issues };
}

// ---------------------------------------------------------------------------
// 3 — Ranks (D1): BOTH crossings, and the two compared against EACH OTHER
// ---------------------------------------------------------------------------
// `finalRanks` crosses the wire exactly once, captured by `advance.ts`'s
// `completeStageCapture` off the `complete` response — that is the engine's
// own intent, and this file never re-derives it. `standingsRankOrder` reads
// the SEPARATE, re-readable customer-visible crossing: `GET
// /stages/{id}/standings`'s own `rank` field. Comparing the two against each
// other is the genuinely new check this task owes — a caller must feed this
// function two INDEPENDENTLY SOURCED values, never the same fetched object
// twice, or the comparison can never disagree and proves nothing.

/** Sorts standings rows by `rank` ascending (undefined ranks sort last,
 *  stable on ties) and returns just the entrant ids — the same
 *  "array order is the assertion" shape `advance.ts#compareFinalRanks`
 *  already uses for the captured crossing. */
export function standingsRankOrder(rows: readonly StandingsRowWire[]): readonly string[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const ar = a.row.rank ?? Number.POSITIVE_INFINITY;
      const br = b.row.rank ?? Number.POSITIVE_INFINITY;
      if (ar !== br) return ar - br;
      return a.i - b.i; // stable
    })
    .map(({ row }) => row.entrantId);
}

export interface RankCrossingComparison {
  readonly matched: boolean;
  readonly captured: readonly string[] | undefined;
  readonly standings: readonly string[];
  /** Set only on a false-by-EMPTINESS verdict (an absent capture, or either
   *  side reporting zero entrants) — distinguishes "there was nothing to
   *  agree on" from an ordinary order/length mismatch between two real
   *  crossings, so a reader is never tempted to read an empty/empty pair as
   *  a vacuous pass (review MAJOR: `[].every(...)` is vacuously true and
   *  0===0, so the naive check alone reported `matched: true` for two
   *  genuinely empty arrays). */
  readonly reason?: string;
}

/**
 * The two-crossing check itself: does the `complete` response's own
 * `finalRanks` (CAPTURED — cannot be re-read, `advance.ts`'s own header
 * comment) agree with what `GET /stages/{id}/standings` reports back,
 * independently, right now? `captured: undefined` (the stage never reported
 * a `stage_completed` event) never MATCHES — an absent capture is not
 * evidence of agreement, it is evidence there was nothing to agree with.
 * Same discipline for an EMPTY (but present) crossing on either side: an
 * empty captured or an empty standings means there is nothing to agree ON,
 * never a free pass just because the lengths happen to agree at zero.
 *
 * ZERO-SUBJECT RULE (report.ts, beside `OracleVerdict`): that emptiness REDS
 * rather than reporting `no_subject`, deliberately — the pack asked for a
 * final order and a completed stage owes one, so an empty crossing is a
 * missing answer from the PRODUCT, not an absent subject in the pack.
 */
export function compareRankCrossings(
  captured: readonly string[] | undefined,
  standings: readonly string[],
): RankCrossingComparison {
  if (captured === undefined) {
    return { matched: false, captured, standings };
  }
  if (captured.length === 0 || standings.length === 0) {
    return {
      matched: false,
      captured,
      standings,
      reason: "empty captured or empty standings — nothing to agree on",
    };
  }
  const matched = captured.length === standings.length && captured.every((id, i) => id === standings[i]);
  return { matched, captured, standings };
}

export function renderRankCrossingMismatch(cmp: RankCrossingComparison): string {
  return renderSideBySide([
    {
      label: "finalRanks vs standings",
      expected: `captured (complete response): [${cmp.captured === undefined ? "(absent)" : cmp.captured.join(", ")}]`,
      actual: `standings (GET .../standings): [${cmp.standings.join(", ")}]`,
    },
  ]);
}

// ---------------------------------------------------------------------------
// 4 — Champion (D2)
// ---------------------------------------------------------------------------
// No champion field exists anywhere on the wire (F1b) — "champion" is
// DEFINED as rank 1 of the final stage's standings, cross-checked against
// `finalRanks[0]` from the captured response, both compared against the
// pack's `expected.champions`.

export interface ChampionComparison {
  readonly matched: boolean;
  readonly expected: string;
  /** `standingsRankOrder(rows)[0]` — undefined for an empty table. */
  readonly fromStandings: string | undefined;
  /** `captured?.[0]` — undefined when nothing was captured. */
  readonly fromCaptured: string | undefined;
  /** Whether the two crossings agree with EACH OTHER, independent of
   *  whether either matches `expected` — `true` whenever `fromCaptured` is
   *  undefined (nothing to disagree with), same convention
   *  `compareRankCrossings` uses for its own undefined case, but inverted:
   *  here an absent capture must not manufacture a false disagreement on
   *  its own, since `matched` below already carries the real verdict. */
  readonly crossingsAgree: boolean;
}

export function compareChampion(
  expected: string,
  standingsRanked: readonly string[],
  captured: readonly string[] | undefined,
): ChampionComparison {
  const fromStandings = standingsRanked[0];
  const fromCaptured = captured?.[0];
  const crossingsAgree = fromCaptured === undefined || fromCaptured === fromStandings;
  const matched = fromStandings === expected && crossingsAgree;
  return { matched, expected, fromStandings, fromCaptured, crossingsAgree };
}

export function renderChampionMismatch(cmp: ChampionComparison): string {
  return renderSideBySide([
    {
      label: "champion",
      expected: cmp.expected,
      actual: `standings: ${cmp.fromStandings ?? "(none)"}; captured: ${cmp.fromCaptured ?? "(none)"}`,
    },
  ]);
}

// ---------------------------------------------------------------------------
// 5 — Leaderboards: name AND count (design §8)
// ---------------------------------------------------------------------------
// Asserting a count alone passes for the wrong player; asserting a name
// alone passes for the wrong tally. Every entry checks both, independently,
// so a "name matches, count doesn't" fixture reds on the COUNT specifically
// (and vice versa) rather than folding the two into one opaque boolean.

export interface ExpectedLeaderboardEntry {
  readonly personId: string;
  readonly name: string;
  readonly count: number;
}

export interface LeaderboardEntryComparison {
  readonly personId: string;
  readonly expectedName: string;
  readonly expectedCount: number;
  readonly actualName: string | undefined;
  readonly actualCount: number | undefined;
  readonly nameMatched: boolean;
  readonly countMatched: boolean;
  readonly matched: boolean;
}

export interface LeaderboardComparison {
  readonly matched: boolean;
  readonly metricKey: string;
  readonly entries: readonly LeaderboardEntryComparison[];
}

/**
 * `expected` already resolved to real person ids by the caller (same
 * convention every comparator in this file uses). An expected entry with no
 * matching row in `actual.rows` compares as `actualName`/`actualCount`
 * undefined — never silently dropped, and never a vacuous pass: an EMPTY
 * `actual.rows` against a non-empty `expected` produces every entry
 * mismatched, not a clean `matched: true` (the vacuity trap this whole task
 * exists to close).
 */
export function compareLeaderboard(
  metricKey: string,
  expected: readonly ExpectedLeaderboardEntry[],
  actual: DivisionPlayerStatsWire,
): LeaderboardComparison {
  const byPersonId = new Map(actual.rows.map((r) => [r.person_id, r]));
  const entries: LeaderboardEntryComparison[] = expected.map((exp) => {
    const row = byPersonId.get(exp.personId);
    const actualName = row?.full_name;
    const actualCount = row?.stats[metricKey];
    const nameMatched = actualName === exp.name;
    const countMatched = actualCount === exp.count;
    return {
      personId: exp.personId,
      expectedName: exp.name,
      expectedCount: exp.count,
      actualName,
      actualCount,
      nameMatched,
      countMatched,
      matched: nameMatched && countMatched,
    };
  });
  // `entries.length === expected.length` would be a TAUTOLOGY here — `entries`
  // is always `expected.map(...)`, so the two counts can never disagree. The
  // real "did we check something" question for the empty-set case is
  // answered by `expected.length` itself, which every caller of this
  // function already has.
  return { matched: entries.every((e) => e.matched), metricKey, entries };
}

export function renderLeaderboardMismatch(cmp: LeaderboardComparison): string {
  const mismatched = cmp.entries.filter((e) => !e.matched);
  return renderSideBySide(
    mismatched.map((e) => ({
      label: `${cmp.metricKey}: ${e.personId}`,
      expected: `${e.expectedName} = ${e.expectedCount}`,
      actual: `${e.actualName ?? "(absent)"} = ${e.actualCount ?? "(absent)"}`,
    })),
  );
}

// ---------------------------------------------------------------------------
// 6 — Person + career stats
// ---------------------------------------------------------------------------
// `expected.careers` (`PackExpectedCareer` — `{person, name, metricKey,
// count}`, no `divisionRef`: a career rollup is cross-division by design) is
// the only pack block shaped for this.

export interface ExpectedCareerStat {
  readonly personId: string;
  readonly name: string;
  readonly metricKey: string;
  readonly count: number;
}

export interface CareerStatComparison {
  readonly personId: string;
  readonly metricKey: string;
  readonly expectedCount: number;
  readonly actualValue: number | undefined;
  /** >1 means the metric key was ambiguous — found under more than one
   *  sport in the person's own career rollup. Reported rather than silently
   *  picking the first match, since `PackExpectedCareer` carries no sport
   *  designation to disambiguate with. */
  readonly foundInSports: number;
  readonly matched: boolean;
}

export function compareCareerStats(
  expected: readonly ExpectedCareerStat[],
  actual: PersonCareerStatsWire,
): { readonly matched: boolean; readonly entries: readonly CareerStatComparison[] } {
  const entries = expected.map((exp) => {
    const hits = actual.sports.flatMap((sport) => sport.metrics.filter((m) => m.key === exp.metricKey));
    // `hits.length === 1` is the ONLY ambiguity guard, checked once here —
    // `matched` below reads `actualValue` rather than re-checking the length
    // itself, so there is exactly one place a metric key's ambiguity can be
    // silently dropped, not two independent copies that could drift apart.
    const actualValue = hits.length === 1 ? hits[0].value : undefined;
    // `exp.count` is a `number` (`ExpectedCareerStat`), so `undefined ===
    // exp.count` is already false — the `actualValue !== undefined` conjunct
    // this used to carry could not change any answer (B05 review round 1).
    const matched = actualValue === exp.count;
    return {
      personId: exp.personId,
      metricKey: exp.metricKey,
      expectedCount: exp.count,
      actualValue,
      foundInSports: hits.length,
      matched,
    };
  });
  // Same tautology `compareLeaderboard` avoids: `entries` is always
  // `expected.map(...)`, so comparing the two lengths can never fail.
  return { matched: entries.every((e) => e.matched), entries };
}

/** Cross-checks a SINGLE division's leaderboard-authored count against the
 *  SAME person's own `/persons/{id}/stats` card for that division — a
 *  second wire crossing of the exact same historical fact `expected.
 *  leaderboards` already pins (a customer can view either the division
 *  leaderboard or a player's own card, and both must agree with history),
 *  reusing the leaderboard's OWN expected data rather than inventing a
 *  second historical source. */
export function comparePersonDivisionStat(
  metricKey: string,
  expectedCount: number,
  divisionId: string,
  actual: PersonStatsWire,
): { readonly matched: boolean; readonly expectedCount: number; readonly actualCount: number | undefined } {
  const row = actual.divisions.find((d) => d.division_id === divisionId);
  const actualCount = row?.stats[metricKey];
  return { matched: actualCount === expectedCount, expectedCount, actualCount };
}

// ---------------------------------------------------------------------------
// 7 — Discipline carry (B05 T5b-3)
// ---------------------------------------------------------------------------
// `expected.suspensions` (`PackExpectedSuspension` — `{divisionRef, person,
// missesFixtureExtKeys, reason?}`) is the pack block this comparator reads.
// It carried ZERO rows until T5b-3, so its oracle was a silence: nothing
// compared, nothing able to fail.
//
// HOW A SUSPENSION ACTUALLY COMES ABOUT (pinned against the tree, not
// assumed — `apps/web/src/server/usecases/discipline.ts`):
//
//   (a) AUTO. `detectSuspensions` re-folds the division's `score_events`
//       through the sport module's `discipline` model on EVERY read of the
//       discipline surfaces — recompute-on-read, idempotent. It needs a
//       `discipline_rules` row with `enabled = true` (PUT
//       `/divisions/{id}/discipline-rules`) AND a module that declares a card
//       model. Rows land as `source: "auto_accumulation" | "auto_dismissal"`.
//   (b) REPORT BRIDGE. `usecases/match-reports.ts:279-310` raises a row off a
//       named incident in a submitted match report.
//   (c) MANUAL. `POST /divisions/{id}/suspensions` -> `createManualSuspension`,
//       `source: "manual"`.
//
// All three insert `status: 'pending'`. **None of them is a ban yet.** Only
// `decideSuspension` (`PATCH /suspensions/{id}` `{kind:"confirm"}`) flips the
// row to `active`, and only THERE are `entrant_id` and `decided_at` stamped —
// which is what `updateServing` then counts fixtures against. A bench that
// POSTed and stopped would be asserting against a row the product does not
// treat as a ban at all. Every one of these paths is additionally gated on
// the `discipline.enforced` entitlement (`requireFeature`).
//
// WHAT THIS COMPARATOR DOES **NOT** ASSERT, and where that moved to.
// T5b-3's brief expected a black-box pair here: "PUT
// `/fixtures/{id}/lineups/{entrantId}` naming the suspended person 422s". At
// the time it did not — `putLineup` called `gateRosterEligibility` and nothing
// on that path read the `suspensions` table, so discipline was ADVISORY and
// this file recorded that as a finding instead of building an assertion on it.
//
// B05 closed that gap in the product: `putLineup` now runs
// `gateLineupSuspensions` (`usecases/discipline.ts`) and answers 422
// SUSPENDED_PLAYER for an `active` ban unless the organiser supplies
// `eligibility_override.reason`. The assertion that follows from it lives in
// the SUITE (`suites/tiny.ts`, the "discipline enforced at the team sheet"
// oracle), not in this comparator, because it is a live HTTP verdict rather
// than a comparison of two states — this function still compares only what it
// can be handed as data.
//
// The two directions this comparator asserts are about the STORED sheets, and
// it asserts both, because a one-sided check passes against a product that
// refuses everybody:
//   NEGATIVE — the banned person holds an ACTIVE suspension in this division,
//     for a ban length equal to the number of fixtures the pack says she
//     misses, stamped against her own entrant; and she is off the team sheet
//     of every fixture the pack names.
//   POSITIVE — the eligible team-mate holds NO active suspension, and IS on
//     the team sheet of every one of that entrant's fixtures, the missed one
//     INCLUDED. Same fixture, same route, opposite verdict.
//
// FIXTURE IDENTITY is `playedFixturesChecked`. "Banned from rr-r3-c1" and
// "banned from everything" both satisfy "absent from rr-r3-c1", so the banned
// player must ALSO be present on at least one fixture of the same entrant
// that the pack does NOT name. A subject with no such fixture cannot pin the
// identity, and this comparator reports that as unmatched rather than
// counting the missing discriminator as a pass.

/** `usecases/discipline.ts#Suspension`, the fields this file reads. */
export interface SuspensionWire {
  readonly id: string;
  readonly divisionId: string;
  readonly personId: string;
  readonly personName: string;
  readonly entrantId: string | null;
  readonly status: string;
  readonly source: string;
  readonly reason: string;
  readonly matchesTotal: number;
  readonly matchesServed: number;
}

/** `usecases/fixtures.ts#readLineup`'s stored slot — snake_case on the wire,
 *  unlike the discipline reads above, which is the product's own split. */
export interface LineupSlotWire {
  readonly person_id: string;
  readonly full_name: string;
}

export interface LineupWire {
  readonly fixture_id: string;
  readonly entrant_id: string;
  readonly slots: readonly LineupSlotWire[];
}

/** One fixture of the banned player's entrant, with the team sheet the
 *  product actually stored for it. `missed` is the PACK's verdict — whether
 *  `expected.suspensions[].missesFixtureExtKeys` names this fixture. */
export interface SuspensionFixtureSheet {
  readonly fixtureExtKey: string;
  readonly fixtureId: string;
  readonly missed: boolean;
  readonly lineup: LineupWire;
}

/** Already resolved from pack refs to real ids by the caller — the same
 *  convention every comparator in this file uses. */
export interface ExpectedSuspension {
  readonly personId: string;
  readonly personName: string;
  readonly divisionId: string;
  readonly entrantId: string;
  /** DERIVED — `missesFixtureExtKeys.length`. The pack does not declare a ban
   *  length, deliberately: a hand-typed one could drift away from the list of
   *  fixtures it is supposed to be the length of and still pass. */
  readonly matchesTotal: number;
  /** The eligible team-mate on the SAME entrant — the positive half. */
  readonly controlPersonId: string;
  readonly controlPersonName: string;
}

export interface SuspensionComparison {
  readonly personId: string;
  readonly personName: string;
  /** An `active` suspension for this person, in this division, was found. */
  readonly banFound: boolean;
  readonly actualStatus: string | undefined;
  readonly actualMatchesTotal: number | undefined;
  readonly actualEntrantId: string | null | undefined;
  readonly matchesTotalMatched: boolean;
  readonly entrantMatched: boolean;
  /** MISSED fixtures whose team sheet still names the banned player. */
  readonly presentOnMissed: readonly string[];
  /** PLAYED fixtures whose team sheet does NOT name the banned player — a ban
   *  that reached too far. */
  readonly absentOnPlayed: readonly string[];
  /** The fixture-identity discriminator: how many of the entrant's fixtures
   *  the pack does NOT name were available to check. Zero means the subject
   *  cannot tell "banned from this fixture" from "banned from all of them". */
  readonly playedFixturesChecked: number;
  readonly missedFixturesChecked: number;
  /** The eligible team-mate holds an active ban too — a product refusing
   *  everybody. */
  readonly controlBanned: boolean;
  /** Fixtures (missed or played) whose team sheet omits the eligible
   *  team-mate — the positive half failing. */
  readonly controlMissingFrom: readonly string[];
  readonly matched: boolean;
}

/**
 * `actual` is the division's `?status=active` suspension list plus the team
 * sheets of every fixture the banned player's entrant is a side of. An EMPTY
 * `actual.active` against a non-empty `expected` produces `banFound: false`,
 * never a vacuous pass — and `expected.length === 0` is NOT this function's
 * problem to report: callers check the length themselves, exactly as
 * `compareLeaderboard` and `compareCareerStats` document.
 */
export function compareSuspensions(
  expected: readonly ExpectedSuspension[],
  actual: {
    readonly active: readonly SuspensionWire[];
    readonly sheets: readonly SuspensionFixtureSheet[];
  },
): { readonly matched: boolean; readonly entries: readonly SuspensionComparison[] } {
  const entries = expected.map((exp) => {
    const row = actual.active.find(
      (s) => s.personId === exp.personId && s.divisionId === exp.divisionId && s.status === "active",
    );
    const banFound = row !== undefined;
    // Read off `row`, never re-derived from `banFound`: one place decides
    // whether the ban was found, so the two cannot drift apart.
    const matchesTotalMatched = row?.matchesTotal === exp.matchesTotal;
    const entrantMatched = row?.entrantId === exp.entrantId;

    const missed = actual.sheets.filter((f) => f.missed);
    const played = actual.sheets.filter((f) => !f.missed);
    const names = (sheet: SuspensionFixtureSheet, personId: string): boolean =>
      sheet.lineup.slots.some((slot) => slot.person_id === personId);

    const presentOnMissed = missed.filter((f) => names(f, exp.personId)).map((f) => f.fixtureExtKey);
    const absentOnPlayed = played.filter((f) => !names(f, exp.personId)).map((f) => f.fixtureExtKey);
    const controlMissingFrom = actual.sheets
      .filter((f) => !names(f, exp.controlPersonId))
      .map((f) => f.fixtureExtKey);
    const controlBanned = actual.active.some(
      (s) =>
        s.personId === exp.controlPersonId &&
        s.divisionId === exp.divisionId &&
        s.status === "active",
    );

    return {
      personId: exp.personId,
      personName: exp.personName,
      banFound,
      actualStatus: row?.status,
      actualMatchesTotal: row?.matchesTotal,
      actualEntrantId: row?.entrantId,
      matchesTotalMatched,
      entrantMatched,
      presentOnMissed,
      absentOnPlayed,
      playedFixturesChecked: played.length,
      missedFixturesChecked: missed.length,
      controlBanned,
      controlMissingFrom,
      matched:
        banFound &&
        matchesTotalMatched &&
        entrantMatched &&
        // Both counts guard a vacuous `every`/`filter`: no missed sheet means
        // the ban was never actually witnessed, and no played sheet means the
        // fixture identity is unpinned.
        missed.length > 0 &&
        played.length > 0 &&
        presentOnMissed.length === 0 &&
        absentOnPlayed.length === 0 &&
        !controlBanned &&
        controlMissingFrom.length === 0,
    };
  });
  return { matched: entries.every((e) => e.matched), entries };
}

/** Why one subject failed, in the pack's own vocabulary. Returns `[]` for a
 *  matched entry, so a caller can concatenate over every entry. */
export function suspensionMismatchReasons(cmp: SuspensionComparison): string[] {
  const out: string[] = [];
  if (!cmp.banFound) {
    out.push(
      `no ACTIVE suspension for "${cmp.personName}" in this division` +
        (cmp.actualStatus === undefined ? "" : ` (found status "${cmp.actualStatus}")`),
    );
    return out;
  }
  if (!cmp.matchesTotalMatched) {
    out.push(
      `ban length is ${cmp.actualMatchesTotal ?? "(absent)"}, but the pack names ` +
        `a different number of missed fixtures`,
    );
  }
  if (!cmp.entrantMatched) {
    out.push(
      `the confirmed ban is stamped against entrant ${cmp.actualEntrantId ?? "(none)"}, ` +
        `not the entrant this person is rostered on`,
    );
  }
  if (cmp.missedFixturesChecked === 0) {
    out.push("no MISSED fixture sheet was read — the ban itself was never witnessed");
  }
  if (cmp.playedFixturesChecked === 0) {
    out.push(
      "no PLAYED fixture sheet was read — a ban from this fixture cannot be told apart " +
        "from a ban from every fixture",
    );
  }
  if (cmp.presentOnMissed.length > 0) {
    out.push(`still named on the team sheet of ${cmp.presentOnMissed.join(", ")}`);
  }
  if (cmp.absentOnPlayed.length > 0) {
    out.push(`missing from ${cmp.absentOnPlayed.join(", ")}, which the pack does NOT name`);
  }
  if (cmp.controlBanned) {
    out.push("the ELIGIBLE team-mate holds an active ban too — the product refused everybody");
  }
  if (cmp.controlMissingFrom.length > 0) {
    out.push(
      `the ELIGIBLE team-mate is off the team sheet of ${cmp.controlMissingFrom.join(", ")}`,
    );
  }
  return out;
}

// --- the discipline driver -------------------------------------------------
// The only WRITE calls in this file. They are here rather than in a suite
// because they are the suspension oracle's own PRODUCER: `expected.
// suspensions` cannot be compared against anything until a ban exists, and a
// ban that the bench fabricated in SQL would prove the fixture, not the
// product (AGENTS.md failure class 1). Two calls, not one — see this
// section's header on why a POSTed row is not yet a ban.

export async function createManualSuspension(
  base: string,
  session: Session,
  divisionId: string,
  input: { readonly personId: string; readonly matchesTotal: number; readonly reason: string },
  transport?: OracleTransport,
): Promise<SuspensionWire> {
  const t = transport ?? defaultOracleTransport;
  const path = `/api/v1/divisions/${divisionId}/suspensions`;
  const result = await t.raw(base, session, path, "POST", {
    person_id: input.personId,
    matches_total: input.matchesTotal,
    reason: input.reason,
  });
  if (result.status !== 201) {
    const { code, message } = errorOf(result);
    throw new Error(
      `oracle: manual suspension refused — HTTP ${result.status} ${code ?? "(no code)"} — ` +
        `${message ?? "(no message)"}${code === "PAYMENT_REQUIRED" ? " (the provisioned plan does not grant discipline.enforced)" : ""}`,
    );
  }
  return dataOf<SuspensionWire>(result, path, "manual suspension");
}

/** `PATCH /suspensions/{id}` `{kind:"confirm"}` — the ONLY thing that turns a
 *  pending row into a ban, and the only place `entrant_id`/`decided_at` are
 *  stamped (`usecases/discipline.ts#decideSuspension`). */
export async function confirmSuspension(
  base: string,
  session: Session,
  suspensionId: string,
  transport?: OracleTransport,
): Promise<SuspensionWire> {
  const t = transport ?? defaultOracleTransport;
  const path = `/api/v1/suspensions/${suspensionId}`;
  const result = await t.raw(base, session, path, "PATCH", { kind: "confirm" });
  if (result.status !== 200) {
    const { code, message } = errorOf(result);
    throw new Error(
      `oracle: suspension confirm refused — HTTP ${result.status} ${code ?? "(no code)"} — ${message ?? "(no message)"}`,
    );
  }
  return dataOf<SuspensionWire>(result, path, "suspension confirm");
}

export async function fetchActiveSuspensions(
  base: string,
  session: Session,
  divisionId: string,
  transport?: OracleTransport,
): Promise<SuspensionWire[]> {
  const t = transport ?? defaultOracleTransport;
  const path = `/api/v1/divisions/${divisionId}/suspensions?status=active`;
  const result = await t.raw(base, session, path, "GET");
  if (result.status !== 200) {
    const { code, message } = errorOf(result);
    throw new Error(
      `oracle: active suspension list refused — HTTP ${result.status} ${code ?? "(no code)"} — ${message ?? "(no message)"}`,
    );
  }
  return dataOf<SuspensionWire[]>(result, path, "active suspensions");
}

/** Writes a team sheet. `status` is returned rather than thrown on, because
 *  whether the product ACCEPTS a banned player is itself the finding this
 *  wave records — see this section's header. */
export async function putFixtureLineup(
  base: string,
  session: Session,
  fixtureId: string,
  entrantId: string,
  personIds: readonly string[],
  transport?: OracleTransport,
): Promise<{ readonly status: number; readonly code: string | undefined }> {
  const t = transport ?? defaultOracleTransport;
  const path = `/api/v1/fixtures/${fixtureId}/lineups/${entrantId}`;
  const result = await t.raw(base, session, path, "PUT", {
    slots: personIds.map((person_id, i) => ({ person_id, slot: "starting", order_no: i + 1 })),
  });
  return { status: result.status, code: errorOf(result).code };
}

/** Reads the team sheet BACK, never the PUT's own echo — the stored state is
 *  what the oracle compares, so a write that silently dropped a slot is
 *  visible. */
export async function fetchFixtureLineup(
  base: string,
  session: Session,
  fixtureId: string,
  entrantId: string,
  transport?: OracleTransport,
): Promise<LineupWire> {
  const t = transport ?? defaultOracleTransport;
  const path = `/api/v1/fixtures/${fixtureId}/lineups/${entrantId}`;
  const result = await t.raw(base, session, path, "GET");
  if (result.status !== 200) {
    const { code, message } = errorOf(result);
    throw new Error(
      `oracle: lineup read refused — HTTP ${result.status} ${code ?? "(no code)"} — ${message ?? "(no message)"}`,
    );
  }
  return dataOf<LineupWire>(result, path, "lineup");
}

// ---------------------------------------------------------------------------
// 9 — Per-match results (design §8; B06a task 3)
// ---------------------------------------------------------------------------
// `expected.matches` has been in `PackSchema` since B02 and was read by
// NOTHING at run time: stage 0 folds each stream offline and compares the fold
// to it, but the seeded HTTP run never asked the product what it decided. A
// pack author would reasonably assume the most basic oracle of all — "did the
// real result come out?" — was covered. It was not.
//
// The comparison is on the OUTCOME, because there is no scoreline to compare:
// `GET /api/v1/divisions/{id}/fixtures` returns `outcome` (jsonb),`status` and
// `round_no`, and no score field of any kind. Scorelines exist only where a
// pack declares `perSide`, and are read from the fixture STATE route.

export interface MatchSideLine {
  readonly entrant: string;
  readonly line: string;
}

export interface ExpectedMatchRow {
  readonly fixtureExtKey: string;
  /** Pack refs ALREADY resolved to entrant ids by the caller — the convention
   *  every comparator in this file follows. */
  readonly outcome: MatchOutcome;
  readonly perSide?: readonly MatchSideLine[];
}

export interface ActualMatchRow {
  readonly extKey: string;
  readonly status: string;
  readonly roundNo: number | null;
  /** Raw off the wire: the route types this `z.unknown().nullable()`, so it is
   *  parsed through the engine's own union below rather than read field-wise.
   *  A jsonb column written as a JSON *string* parses to a scalar, and every
   *  field read off that scalar yields `undefined` — which would compare equal
   *  to an expected `undefined` and pass in silence. */
  readonly outcome: unknown;
  readonly perSide?: readonly MatchSideLine[];
}

export type MatchMismatchField = "status" | "outcome" | "winner" | "loser" | "method" | "line";

export interface MatchMismatch {
  readonly fixtureExtKey: string;
  readonly field: MatchMismatchField;
  readonly expected: string;
  readonly actual: string;
}

export interface MatchRoundTally {
  readonly roundNo: number | null;
  readonly checked: number;
  readonly mismatched: number;
}

export interface MatchComparison {
  readonly checked: number;
  readonly byRound: readonly MatchRoundTally[];
  readonly mismatches: readonly MatchMismatch[];
}

/** A fixture the product considers settled. Anything else — `scheduled`,
 *  `in_play`, `cancelled` — is reported as a STATUS mismatch rather than
 *  compared: an outcome read off an unfinished fixture is not a wrong result,
 *  it is a run that did not get there, and the two need different fixes. */
const SETTLED_STATUSES = new Set(["decided", "finalized", "forfeited", "abandoned"]);

function outcomeWinnerOf(o: MatchOutcome): string | undefined {
  return o.kind === "win" || o.kind === "award" ? o.winner : undefined;
}

/** The engine declares `loser` on the `win` variant ALONE (`types.ts:115`) —
 *  an award has a winner and no named loser, and a draw/tie/no_result has
 *  neither. Every other kind therefore answers `undefined`, which the
 *  comparator reads as "this shape asserts no losing side" rather than as a
 *  value that went missing.
 *
 *  Exported for `oracle-matches.test.ts` (Minors row 10 / task-2-review.md
 *  Minor 2): through `compareMatches` alone, no test can ever tell this
 *  kind-narrowing ternary apart from a naive `return o.loser` — the four
 *  non-"win" kinds are `z.object({kind: literal})` shapes with no `loser`
 *  property at all, and `MatchOutcome.safeParse` strips anything extra
 *  before it would reach here, so reading `.loser` off a REAL parsed
 *  no-loser outcome is `undefined` either way. Calling this directly with a
 *  hand-built (zod-bypassing) object that carries a stray `loser` is the
 *  only way to make the kind check observable at all. */
export function outcomeLoserOf(o: MatchOutcome): string | undefined {
  return o.kind === "win" ? o.loser : undefined;
}

/** `method` is declared by BOTH variants that can carry one — `win` and
 *  `award`. The award's arrived when `core.forfeit`'s required `reason`
 *  started being carried verbatim through the fold, which is what lets a pack
 *  assert WHY an award happened rather than only that it did. */
function outcomeMethodOf(o: MatchOutcome): string | undefined {
  return o.kind === "win" || o.kind === "award" ? o.method : undefined;
}

/**
 * Walks the DECLARED list, never the live one: a fixture the pack does not
 * declare is not this oracle's business, while a declared fixture the board
 * never returned IS (it reports as `(absent)` rather than being skipped).
 *
 * At most one mismatch per fixture — the FIRST differing field — so one wrong
 * result is one row rather than a cascade of four.
 */
export function compareMatches(
  expected: readonly ExpectedMatchRow[],
  actual: readonly ActualMatchRow[],
): MatchComparison {
  const byKey = new Map(actual.map((a) => [a.extKey, a] as const));
  const mismatches: MatchMismatch[] = [];
  const rounds = new Map<number | null, { checked: number; mismatched: number }>();

  for (const row of expected) {
    const live = byKey.get(row.fixtureExtKey);
    const roundNo = live?.roundNo ?? null;
    const tally = rounds.get(roundNo) ?? { checked: 0, mismatched: 0 };
    tally.checked += 1;

    const miss = firstMismatch(row, live);
    if (miss !== undefined) {
      mismatches.push(miss);
      tally.mismatched += 1;
    }
    rounds.set(roundNo, tally);
  }

  const byRound = [...rounds.entries()]
    .map(([roundNo, t]) => ({ roundNo, checked: t.checked, mismatched: t.mismatched }))
    // Nulls last: an unrounded fixture (a league) sorts after the rounds of a
    // knockout rather than ahead of round 1.
    .sort((a, b) => (a.roundNo ?? Number.MAX_SAFE_INTEGER) - (b.roundNo ?? Number.MAX_SAFE_INTEGER));

  return { checked: expected.length, byRound, mismatches };
}

function firstMismatch(row: ExpectedMatchRow, live: ActualMatchRow | undefined): MatchMismatch | undefined {
  const at = (field: MatchMismatchField, expected: string, actual: string): MatchMismatch => ({
    fixtureExtKey: row.fixtureExtKey,
    field,
    expected,
    actual,
  });

  if (live === undefined) return at("status", "decided", "(absent)");
  if (!SETTLED_STATUSES.has(live.status)) return at("status", "decided", live.status);

  const parsed = MatchOutcome.safeParse(live.outcome);
  if (!parsed.success) return at("outcome", row.outcome.kind, "(unparseable)");
  const got = parsed.data;

  if (got.kind !== row.outcome.kind) return at("outcome", row.outcome.kind, got.kind);

  const expectedWinner = outcomeWinnerOf(row.outcome);
  const actualWinner = outcomeWinnerOf(got);
  if (expectedWinner !== undefined && expectedWinner !== actualWinner) {
    return at("winner", expectedWinner, actualWinner ?? "(none)");
  }

  // The winner alone cannot see a wrong pairing: swap an opponent and the
  // same player still wins. This is the cheapest true check on the draw —
  // nothing else in the bench reads round-0 pairings back.
  //
  // The `!== undefined` guard is belt-and-braces rather than a live branch:
  // the kind equality above already forces both sides to the same variant, so
  // an expected `loser` is absent only when the actual one is too. It stands
  // so that a future reordering cannot make a draw report `(none)`.
  const expectedLoser = outcomeLoserOf(row.outcome);
  const actualLoser = outcomeLoserOf(got);
  if (expectedLoser !== undefined && expectedLoser !== actualLoser) {
    return at("loser", expectedLoser, actualLoser ?? "(none)");
  }

  // Only where the pack declares one: a pack that states no method is not
  // asserting one, so any live value satisfies it. Read through a helper that
  // covers BOTH kinds declaring `method`; while this compared `win` alone, an
  // award's reason was never checked and a walkover recorded as a
  // disqualification passed.
  const expectedMethod = outcomeMethodOf(row.outcome);
  if (expectedMethod !== undefined) {
    const actualMethod = outcomeMethodOf(got);
    if (expectedMethod !== actualMethod) {
      return at("method", expectedMethod, actualMethod ?? "(absent)");
    }
  }

  for (const side of row.perSide ?? []) {
    const liveLine = live.perSide?.find((s) => s.entrant === side.entrant)?.line;
    if (liveLine !== side.line) {
      return at("line", `${side.entrant}:${side.line}`, `${side.entrant}:${liveLine ?? "(absent)"}`);
    }
  }

  return undefined;
}

/** One division's fixtures, for `compareMatches`.
 *
 *  `GET /api/v1/divisions/{id}/fixtures` takes NO query parameters — the whole
 *  division comes back in one call, which is why the per-match oracle costs
 *  one request per division rather than one per fixture. */
export async function fetchDivisionFixtures(
  base: string,
  session: Session,
  divisionId: string,
  transport?: OracleTransport,
): Promise<readonly FixtureWire[]> {
  const t = transport ?? defaultOracleTransport;
  const path = `/api/v1/divisions/${divisionId}/fixtures`;
  const result = await t.raw(base, session, path, "GET");
  if (result.status !== 200) {
    const { code, message } = errorOf(result);
    throw new Error(
      `oracle: division fixtures refused — HTTP ${result.status} ${code ?? "(no code)"} — ${message ?? "(no message)"}`,
    );
  }
  return dataOf<readonly FixtureWire[]>(result, path, "fixtures");
}

/** Only the fields `compareMatches` reads. The route returns a great deal
 *  more; naming the four here keeps the comparator's contract legible and
 *  stops an unrelated wire change from looking like an oracle change. */
export interface FixtureWire {
  readonly id: string;
  readonly ext_key: string | null;
  readonly status: string;
  readonly round_no: number | null;
  readonly outcome: unknown;
}

/** The per-side scorelines for ONE fixture, from the state route's summary.
 *
 *  Fetched only for fixtures whose expected row declares `perSide`: the
 *  division fixtures route carries no scoreline at all, and a 95-match suite
 *  must not pay 95 extra round trips to compare lines no pack declared.
 *
 *  `undefined` when the fixture has no summary yet (nothing folded into it) —
 *  which the comparator then reports as `(absent)` against every declared
 *  line, never as a pass. */
export async function fetchFixtureSideLines(
  base: string,
  session: Session,
  fixtureId: string,
  transport?: OracleTransport,
): Promise<readonly MatchSideLine[] | undefined> {
  const t = transport ?? defaultOracleTransport;
  const path = `/api/v1/fixtures/${fixtureId}/state`;
  const result = await t.raw(base, session, path, "GET");
  if (result.status !== 200) {
    const { code, message } = errorOf(result);
    throw new Error(
      `oracle: fixture state refused — HTTP ${result.status} ${code ?? "(no code)"} — ${message ?? "(no message)"}`,
    );
  }
  const state = dataOf<{ readonly summary: unknown }>(result, path, "fixture state");
  const parsed = ScoreSummary.safeParse(state.summary);
  if (!parsed.success) return undefined;
  return parsed.data.perSide.map((side) => ({ entrant: side.entrantId, line: side.line }));
}

// ---------------------------------------------------------------------------
// 10 — Specials (design §8; B06a task 4)
// ---------------------------------------------------------------------------
// The second `expected` field PackSchema declared and nothing compared at run
// time. A special is a fixture plus a list of typed CLAIMS — the folded
// outcome, a dotted path into the module's own state, or a standings cell —
// and every mechanic the bench exists to witness rides this one shape: a super
// over, a shootout, a DLS revision, a retirement, an expedite.
//
// A claim this runner cannot evaluate is UNSUPPORTED, never satisfied. Failing
// closed is the whole point: a pack author who writes an assertion nothing
// makes must not get a green run for it.

/** Entrant refs already resolved to ids by the caller. */
export type ResolvedSpecialClaim =
  | { readonly on: "outcome"; readonly kind?: string; readonly method?: string; readonly winner?: string; readonly loser?: string }
  | { readonly on: "state"; readonly path: string; readonly equals: unknown }
  | { readonly on: "standings"; readonly entrant: string; readonly field: string; readonly equals: number }
  | { readonly on: "squads"; readonly entrant: string; readonly field: string; readonly exemption?: string; readonly equals: number };

export interface ResolvedSpecial {
  readonly kind: string;
  readonly divisionRef: string;
  readonly fixtureExtKey: string;
  readonly claims: readonly ResolvedSpecialClaim[];
}

/** Everything one special's claims can be checked against, gathered by the
 *  caller: the fixture's folded outcome and state, and its stage's standings
 *  rows keyed by entrant id. */
export interface SpecialSubject {
  readonly outcome: unknown;
  readonly state: unknown;
  readonly standings: ReadonlyMap<string, Record<string, number>>;
}

export interface SpecialFailure {
  readonly fixtureExtKey: string;
  /** `outcome.winner`, `state.sets.0.tiebreak`, `standings.<id>.won`, or
   *  `(subject)` when the fixture itself was never found. */
  readonly claim: string;
  readonly expected: string;
  readonly actual: string;
}

export interface SpecialsComparison {
  /** How many SPECIALS were declared. */
  readonly specials: number;
  /** How many CLAIMS were actually evaluated — the number that shrinks if a
   *  future change quietly stops checking. */
  readonly checked: number;
  readonly failures: readonly SpecialFailure[];
  readonly unsupported: readonly { readonly fixtureExtKey: string; readonly on: string }[];
}

function show(value: unknown): string {
  if (value === undefined) return "(absent)";
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function compareSpecials(
  expected: readonly ResolvedSpecial[],
  subjects: ReadonlyMap<string, SpecialSubject>,
): SpecialsComparison {
  const failures: SpecialFailure[] = [];
  const unsupported: { fixtureExtKey: string; on: string }[] = [];
  let checked = 0;

  for (const s of expected) {
    const subject = subjects.get(`${s.divisionRef}/${s.fixtureExtKey}`);
    if (subject === undefined) {
      // Never "absent, therefore skipped": a declared special whose fixture the
      // run never produced is precisely the defect this oracle exists for.
      failures.push({
        fixtureExtKey: s.fixtureExtKey,
        claim: "(subject)",
        expected: `${s.kind} on ${s.divisionRef}/${s.fixtureExtKey}`,
        actual: "(absent)",
      });
      continue;
    }

    for (const claim of s.claims) {
      if (claim.on === "outcome") {
        const parsed = MatchOutcome.safeParse(subject.outcome);
        const got = parsed.success ? (parsed.data as Record<string, unknown>) : undefined;
        for (const field of ["kind", "method", "winner", "loser"] as const) {
          const want = claim[field];
          if (want === undefined) continue;
          checked += 1;
          const actual = got?.[field];
          if (actual !== want) {
            failures.push({
              fixtureExtKey: s.fixtureExtKey,
              claim: `outcome.${field}`,
              expected: show(want),
              actual: show(actual),
            });
          }
        }
        continue;
      }

      if (claim.on === "state") {
        checked += 1;
        const { found, value } = resolveStatePath(subject.state, claim.path);
        const matched = found && JSON.stringify(value) === JSON.stringify(claim.equals);
        if (!matched) {
          failures.push({
            fixtureExtKey: s.fixtureExtKey,
            claim: `state.${claim.path}`,
            expected: show(claim.equals),
            actual: found ? show(value) : "(absent)",
          });
        }
        continue;
      }

      if (claim.on === "standings") {
        checked += 1;
        const row = subject.standings.get(claim.entrant);
        const actual = row?.[claim.field];
        if (actual !== claim.equals) {
          failures.push({
            fixtureExtKey: s.fixtureExtKey,
            claim: `standings.${claim.entrant}.${claim.field}`,
            expected: show(claim.equals),
            actual: show(actual),
          });
        }
        continue;
      }

      // `squads` — no live source is wired. Recorded, never satisfied.
      unsupported.push({ fixtureExtKey: s.fixtureExtKey, on: claim.on });
    }
  }

  return { specials: expected.length, checked, failures, unsupported };
}

/** The folded module state for one fixture, for a special's `state` claims.
 *
 *  `GET /api/v1/fixtures/{id}/state` returns `{status, last_seq, summary,
 *  state}` — `state` is the module's own folded State, which is what a dotted
 *  claim path indexes into. `null` when nothing has been folded yet, which the
 *  comparator then reports as `(absent)` against every claim rather than as a
 *  pass. */
export async function fetchFixtureModuleState(
  base: string,
  session: Session,
  fixtureId: string,
  transport?: OracleTransport,
): Promise<unknown> {
  const t = transport ?? defaultOracleTransport;
  const path = `/api/v1/fixtures/${fixtureId}/state`;
  const result = await t.raw(base, session, path, "GET");
  if (result.status !== 200) {
    const { code, message } = errorOf(result);
    throw new Error(
      `oracle: fixture state refused — HTTP ${result.status} ${code ?? "(no code)"} — ${message ?? "(no message)"}`,
    );
  }
  return dataOf<{ readonly state: unknown }>(result, path, "fixture state").state;
}
