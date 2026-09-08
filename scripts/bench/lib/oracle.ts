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
// `scripts/bench/lib/` imports from `apps/web`. Types below match
// `usecases/stages.ts#getStandings` (`StandingsOut`),
// `packages/engine/src/competition/standings.ts#StandingsRow`,
// `usecases/player-stats.ts#divisionPlayerStats/personStats/
// personCareerStats`, field for field (`B05-repins-2026-09-07.md`'s
// "Verified pins — oracles" table).
import { raw, type RawResult, type Session } from "./http.ts";

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

function dataOf<T>(result: RawResult, path: string, label: string): T {
  const data = (result.json as unknown as { data?: T })?.data;
  if (data === undefined) {
    throw new Error(`oracle: ${label} response for ${path} carried no data`);
  }
  return data;
}

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
}

export interface StandingsComparison {
  readonly matched: boolean;
  readonly rows: readonly StandingsRowComparison[];
}

function metricsEqual(a: Record<string, number> | undefined, b: Record<string, number> | undefined): boolean {
  const ae = Object.entries(a ?? {});
  const be = Object.entries(b ?? {});
  if (ae.length !== be.length) return false;
  const bMap = new Map(be);
  return ae.every(([k, v]) => bMap.get(k) === v);
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
      return { entrantId: exp.entrantId, matched: false, expected: exp, actual: undefined, mismatchFields: [] };
    }
    const mismatchFields: string[] = [];
    if (act.entrantId !== exp.entrantId) mismatchFields.push("entrantId");
    if (act.played !== exp.played) mismatchFields.push("played");
    if (act.won !== exp.won) mismatchFields.push("won");
    if (act.drawn !== exp.drawn) mismatchFields.push("drawn");
    if (act.lost !== exp.lost) mismatchFields.push("lost");
    if (act.points !== exp.points) mismatchFields.push("points");
    if (!metricsEqual(exp.metrics, act.metrics)) mismatchFields.push("metrics");
    return { entrantId: exp.entrantId, matched: mismatchFields.length === 0, expected: exp, actual: act, mismatchFields };
  });
  const matched = rows.every((r) => r.matched) && actual.length === expected.length;
  return { matched, rows };
}

function renderRow(r: ExpectedStandingsRow | StandingsRowWire | undefined): string {
  if (r === undefined) return "(absent)";
  return `${r.entrantId} P${r.played} W${r.won} D${r.drawn} L${r.lost} Pts${r.points}${r.metrics ? ` ${JSON.stringify(r.metrics)}` : ""}`;
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
}

/**
 * The two-crossing check itself: does the `complete` response's own
 * `finalRanks` (CAPTURED — cannot be re-read, `advance.ts`'s own header
 * comment) agree with what `GET /stages/{id}/standings` reports back,
 * independently, right now? `captured: undefined` (the stage never reported
 * a `stage_completed` event) never MATCHES — an absent capture is not
 * evidence of agreement, it is evidence there was nothing to agree with.
 */
export function compareRankCrossings(
  captured: readonly string[] | undefined,
  standings: readonly string[],
): RankCrossingComparison {
  const matched =
    captured !== undefined && captured.length === standings.length && captured.every((id, i) => id === standings[i]);
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
// the only pack block shaped for this. `_tiny.json` carries ZERO rows in it
// today (verified against the committed pack, `_tiny.json`'s own `expected`
// object has no `careers` key at all) — this comparator has NO real subject
// on `_tiny` and is unit-tested only; see this task's final report for the
// explicit vacuity accounting the brief requires.

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
    const matched = actualValue !== undefined && actualValue === exp.count;
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
