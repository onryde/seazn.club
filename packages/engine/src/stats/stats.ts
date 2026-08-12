// Player statistics fold (Jul3/07 §3) — another disposable projection of the
// score-event ledger, like match_states and standings_snapshots. Pure and
// deterministic; voided events (and their assists) never count.
//
// S8/#417 added two additive attribution paths, both opt-in and both a
// no-op for every caller that does not supply them: an explicit-field walk
// can fall back to an entrant's roster (`PlayerStatsFoldCtx`) for sports
// whose payload names only an EntrantId (setbased `wonBy`, nested `by`),
// and a whole-model `folded` escape hatch for attribution a metric+field
// walk cannot express at all. See each new type's own docstring.
//
// The same session also added a diagnostics return value —
// `aggregatePlayerStatsWithDiagnostics` — so this pure fold can report what
// it silently dropped as DATA, for the apps/web caller to log. This file
// stays outside the engine's logging carve-out (only
// `packages/engine/src/scheduling/**` may log), so the counters are the
// closest this fold may come to logging itself. See `PlayerStatsDiagnostics`.
import { resolveVoids, type EventEnvelope } from "../core/events.ts";
import type { LineupPair } from "../core/types.ts";

/**
 * Resolve a payload path — a plain dotted walk through objects, so a metric can
 * name a nested credit (`"runs.bat"` for the striker, `"wicket.fielder"` for
 * the catcher). Deliberately NOT a query language: no array indexing, no
 * wildcards, no predicates.
 *
 * Three rules make it safe against real scoring payloads:
 *
 * 1. **A path that does not resolve returns `undefined`, never a throw.**
 *    Payloads are heterogeneous by design — `wicket` is absent on every ball
 *    that is not a dismissal — so a missing path is the normal case, not an
 *    error. Walking through `undefined`, `null` or a scalar all land here.
 * 2. **A literal key wins over the walk**, at every step. That is what keeps
 *    every pre-existing single-segment lookup (`"scorer"`, `"person"`) byte-for
 *    -byte identical, and it also makes a payload key that genuinely contains a
 *    dot reachable rather than shadowed.
 * 3. **Arrays are a leaf, not a step.** A resolved array still credits every
 *    person in it (ice hockey's two assists — see below), but a path may not
 *    index into one. An empty segment resolves to nothing rather than to the
 *    object it was written on, so a typo can never credit a whole record.
 */
export function resolvePayloadPath(source: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = source;
  let rest = path;
  for (;;) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return undefined;
    const obj = cursor as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(obj, rest)) return obj[rest];
    const dot = rest.indexOf(".");
    if (dot <= 0) return undefined; // no separator left, or an empty leading segment
    cursor = obj[rest.slice(0, dot)];
    rest = rest.slice(dot + 1);
  }
}

// Sport-declared stat model — the plugin mirror of the position catalog.
export interface PlayerStatMetric {
  key: string; // 'goals'
  label: string; // 'Goals'
  from: string; // event type: 'football.goal'
  /** Payload path carrying the person id (default 'person'). Dotted paths walk
   *  into nested objects: `'wicket.fielder'`. */
  field?: string;
  agg: "count" | "sum";
  /** For agg:'sum' — the payload path holding the numeric value, dotted like
   *  `field` (`'runs.bat'`). Ignored when `value` is also declared. */
  sumField?: string;
  /** Extra payload predicate (e.g. skip own goals, filter card colour). */
  when?: (payload: Record<string, unknown>) => boolean;
  /**
   * Dotted path to an EntrantId on the payload (`"wonBy"`, `"by"`,
   * `"winner"`) — the fallback attribution source when no explicit person
   * field resolves. Only ever consulted when `fromEntrant` is true and a
   * `PlayerStatsFoldCtx` was supplied to `aggregatePlayerStats`; see
   * `resolveMetricPersons` for the exact resolution order (S8/#417).
   */
  entrantField?: string;
  /**
   * Opt-in gate for the entrant-fallback attribution (S8/#417). Absent or
   * false ⇒ behaviour is byte-identical to before this field existed — the
   * explicit `field`/`"person"` walk is the only source, exactly as today.
   */
  fromEntrant?: boolean;
  /**
   * Computed sum value for `agg:"sum"`, in place of a plain `sumField`
   * walk — takes precedence over `sumField` when both are declared.
   * Returning `undefined` means "no data for this event" and contributes
   * NOTHING, not a recorded zero, so a metric can tell "never happened"
   * apart from "happened, value 0" (the silent-0 defect this programme has
   * shipped three times already). Returning `0` records a real zero.
   */
  value?: (payload: Record<string, unknown>) => number | undefined;
}

export interface PlayerStatDerive {
  key: string;
  label: string;
  derive: (stats: Record<string, number>) => number; // points = goals + assists
}

export interface PlayerAwardSpec {
  key: string; // 'motm'
  label: string; // 'Man of the Match'
}

export interface PlayerStatsModel {
  metrics: PlayerStatMetric[];
  derived?: PlayerStatDerive[];
  awards?: PlayerAwardSpec[];
  /**
   * An escape hatch for attribution a metric+field walk cannot express
   * (S8/#417) — runs over the SAME void-resolved event list as the metric
   * loop, only when `ctx` OR `lineups` is supplied (both omitted ⇒ inert,
   * exactly as before this field could read either), and its rows merge
   * into the metric rows by per-key addition (same discipline as
   * `sumPlayerStats`). `keys` is a static declaration of what `fold` may
   * produce, checked for collisions against `metrics[].key` by
   * `playerStatsKeyCollisions` — the runtime merge never throws on a
   * collision (a data-derived throw inside a fold permanently bricks a
   * recorded fixture), so that checker is the only place a collision is
   * ever surfaced.
   *
   * `lineups` (S8/#417, second addition) is the team sheet `aggregatePlayerStats`
   * already threaded through for the non-player exclusion but never forwarded
   * any further — added for attribution a `ctx`-only fold cannot express
   * either: a goalkeeper's identity is a `LineupSlot` plus the fold of
   * `core.lineup.*` events, not a payload field. `ctx` stays a REQUIRED,
   * non-nullable parameter here (never `| undefined`) so an existing fold
   * that reads `ctx.entrants` with no null check keeps typechecking unchanged;
   * the caller below substitutes a real, empty `PlayerStatsFoldCtx` on the
   * caller's behalf when the caller only supplied `lineups`.
   */
  folded?: {
    /**
     * Every key `fold` may write, EACH WITH ITS OWN DECLARED ENGLISH LABEL
     * (S8/#417 W6 review) — the same `{key, label}` shape `PlayerStatMetric`/
     * `PlayerStatDerive`/`PlayerAwardSpec` already use, so a folded row ships
     * the same "every displayable row carries an engine label" guarantee the
     * rest of this file rests on. Before this, a `folded`-only row (no
     * `metrics[]`/`derived[]`/`awards[]` entry sharing its key — the
     * football/hockey/icehockey goalkeeper metrics, the setbased/nested
     * match/set outcomes, …) had no label ANYWHERE, engine or app, and
     * degraded silently to nothing on screen. `apps/web`'s `labelPlayerStats`
     * reads this label as its own fallback, exactly like it already falls
     * back to a metric's/derived's/award's own `label`.
     */
    keys: readonly { key: string; label: string }[];
    /**
     * Subset of `keys[].key` that INTENTIONALLY lands in the same stat
     * column as an entry in `metrics[]` — a declared, tested overlap
     * (S8/#417 W6 fix 1), e.g. cricket's coarse `cricket.player.line`
     * rescue, gated so the fine metric and the coarse fold never both fire
     * for one person's aspect. `playerStatsKeyCollisions` treats a `keys`
     * entry that also appears in `metrics[].key` as a real, UNDECLARED
     * clash unless it is also listed here — so a model must declare every
     * key `fold` actually writes in `keys` (never dodge the checker with an
     * empty list to hide an intentional overlap) and name the intentional
     * ones here, which keeps the checker able to catch a genuinely
     * accidental new collision. Absent ⇒ no overlap is declared
     * intentional, byte-identical to before this field existed. Stays a
     * plain `string[]` (key names only) — the label of record for a shared
     * key is always the `metrics[]` entry's own, per `labelPlayerStats`'s
     * first-declaration-wins precedence, so a second label here would be
     * dead data.
     */
    sharesMetricKeys?: readonly string[];
    fold: (
      events: readonly EventEnvelope[],
      ctx: PlayerStatsFoldCtx,
      lineups?: LineupPair,
    ) => PlayerStatRow[];
  };
}

export interface PlayerStatRow {
  personId: string;
  stats: Record<string, number>;
}

/** The three entrant shapes the engine's entrant model recognises (spec
 *  2026-07-18, `sport/entrant-model.ts`). Duplicated here rather than
 *  imported so this file stays decoupled from cfg/module machinery — its
 *  purity must never become accidentally coupled to a type that could grow
 *  cfg-derived fields later. */
export type PlayerStatsEntrantKind = "team" | "individual" | "pair";

/** One fixture's entrant, as the caller (apps/web, which owns the roster
 *  data) presents it — just enough for the entrant-fallback attribution
 *  below: an id to match against a payload's `entrantField`, and the KIND
 *  that gates whether that entrant may ever be credited a person at all. */
export interface PlayerStatsEntrant {
  id: string;
  kind: PlayerStatsEntrantKind;
}

/**
 * Optional 4th input to `aggregatePlayerStats` (S8/#417). Supplies what the
 * fold itself cannot derive: which entrants exist this fixture, their kind,
 * and the person ids that make up an individual/pair entrant. Without it, a
 * payload that names only an EntrantId (`wonBy`, `by` — see
 * `PlayerStatMetric.entrantField`) folds to zero rows, which is exactly the
 * v1-era-payload defect this type exists to close.
 *
 * Data + callbacks only — no classes, no I/O. `personsOf` must be pure and
 * deterministic for a given entrantId across one fold, or replay breaks.
 */
export interface PlayerStatsFoldCtx {
  entrants: readonly PlayerStatsEntrant[];
  /** Person ids that make up an entrant — meaningful only for "individual"
   *  (one id) and "pair" (two) kinds. A "team" entrant's answer here is
   *  never trusted: the fold enforces its own kind guard rather than
   *  relying on every caller to already return `[]` for a team (see
   *  `resolveMetricPersons`) — one wrong caller would otherwise credit an
   *  entire squad for a single event. */
  personsOf: (entrantId: string) => readonly string[];
  /** Reserved for a future metric that needs division config; unread by
   *  this file today. */
  cfg?: unknown;
}

/**
 * Person ids the team sheet marks as something other than a player (S3/#426
 * ruling 3: `LineupSlot.role`, default `"player"`). A NEGATIVE set — ids
 * explicitly declared `"coach"`/`"staff"` — rather than a positive allow-list,
 * so a person the passed lineups happen not to name (an incomplete test
 * fixture, say) still counts exactly as it always has; only an EXPLICIT
 * non-player role ever excludes.
 */
/**
 * S8/#417 (CHANGE 1) — a real, empty `PlayerStatsFoldCtx` for the call site
 * below to hand a `folded.fold` when the caller supplied `lineups` but no
 * `ctx` at all — every caller in production today (`aggregatePlayerStats
 * (ledger, model, lineupsByFixture.get(fixtureId))` has no 4th argument).
 * Keeps `fold`'s own `ctx` parameter non-nullable (see `PlayerStatsModel.
 * folded`'s docstring) rather than pushing an `| undefined` onto every
 * existing fold implementation that already dereferences `ctx.entrants`
 * without a null check.
 */
const EMPTY_FOLD_CTX: PlayerStatsFoldCtx = { entrants: [], personsOf: () => [] };

/**
 * The person ids ONE entrant credits, applying `PlayerStatsFoldCtx`'s
 * mandatory kind guard (S8/#417 W6 fix 5) — an id absent from `ctx.entrants`,
 * or present with kind `"team"`, credits nobody, even when `personsOf` hands
 * back a full roster. This is the SAME rule `resolveMetricPersons` below
 * enforces for the metric+field/entrant-fallback path; before this export
 * existed, five sport-local `folded.fold` implementations that do their own
 * entrant resolution (setbased/nested's match/set replay, boardgame's,
 * carrom's and generic's own credit loops) each hand-copied it byte-
 * identically — the placer/verifier fork shape this repo keeps hitting.
 * Never throws; an unresolvable or non-"individual"/"pair" entrant is simply
 * nobody, matching every other unresolved-attribution path in this file.
 */
export function personsForEntrant(ctx: PlayerStatsFoldCtx, entrantId: string): readonly string[] {
  const entrant = ctx.entrants.find((e) => e.id === entrantId);
  if (entrant === undefined || entrant.kind === "team") return [];
  return ctx.personsOf(entrantId).filter((p) => p !== "");
}

function nonPlayerPersonIds(lineups: LineupPair): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const side of [lineups.home, lineups.away]) {
    for (const slot of side.slots) {
      if (slot.role !== undefined && slot.role !== "player") ids.add(slot.personId);
    }
  }
  return ids;
}

/**
 * What `resolveMetricPersons` learned about ONE (event, metric) pair,
 * beyond the plain person list — enough for the fold's diagnostics pass
 * (S8/#417, see `PlayerStatsDiagnostics`) to update its counters without a
 * second, parallel re-derivation of this same decision tree. `source` is
 * "none" whenever `persons` is empty, regardless of which branch produced
 * the empty result — the two id fields below are the only way to tell
 * those empty branches apart, and each is set on exactly the one branch it
 * diagnoses.
 */
interface MetricPersonsResolution {
  persons: readonly string[];
  source: "field" | "entrant" | "none";
  /** Set when `entrantField` resolved to an id `ctx.entrants` does not
   *  contain — a caller-side `entrants`/`personsOf` disagreement. */
  unknownEntrantId?: string;
  /** Set when `entrantField` resolved to a KNOWN entrant whose kind is
   *  "team" — the mandatory kind guard below fired. */
  teamEntrantId?: string;
}

/**
 * Resolve the persons a metric credits for one event, in the mandated
 * order (owner ruling, S8/#417): an explicit person field always wins and
 * STOPS the search — the entrant fallback is a v1-era-payload rescue, not
 * a second vote, so it never even runs once the explicit field has
 * answered. Only when the explicit field yields NOBODY does the entrant
 * path get a look: `fromEntrant` must be opted in, a `ctx` must have been
 * supplied, `entrantField` must resolve to a real id, that id must be a
 * KNOWN entrant (`ctx.entrants`), and its kind must be "individual" or
 * "pair" — a "team" kind, or an id `ctx` never declared, credits nobody
 * even if `personsOf` hands back a full roster.
 *
 * The kind check happens HERE, inside the engine, rather than trusting the
 * caller's `personsOf` to already return `[]` for a team: one caller that
 * gets that wrong would otherwise credit an entire squad for a single
 * event, and that failure mode is worse than a redundant check.
 *
 * Returns a `MetricPersonsResolution` rather than a bare list (S8/#417
 * diagnostics) — `persons` is byte-identical to what this function has
 * always returned; the extra fields are purely observational.
 */
function resolveMetricPersons(
  payload: Record<string, unknown>,
  metric: PlayerStatMetric,
  ctx: PlayerStatsFoldCtx | undefined,
): MetricPersonsResolution {
  const explicit = resolvePayloadPath(payload, metric.field ?? "person");
  // Same array-or-single-or-none normalisation the explicit path has always
  // used (ice hockey's two assists credit every listed person once).
  const persons = Array.isArray(explicit)
    ? explicit.filter((p): p is string => typeof p === "string" && p !== "")
    : typeof explicit === "string" && explicit !== ""
      ? [explicit]
      : [];
  if (persons.length > 0) return { persons, source: "field" }; // explicit field wins — never fall through

  if (ctx === undefined || metric.fromEntrant !== true || metric.entrantField === undefined) {
    return { persons: [], source: "none" };
  }
  const entrantId = resolvePayloadPath(payload, metric.entrantField);
  if (typeof entrantId !== "string" || entrantId === "") return { persons: [], source: "none" };
  const entrant = ctx.entrants.find((e) => e.id === entrantId);
  if (entrant === undefined) return { persons: [], source: "none", unknownEntrantId: entrantId };
  if (entrant.kind === "team") return { persons: [], source: "none", teamEntrantId: entrantId }; // mandatory kind guard
  const fallback = ctx.personsOf(entrantId).filter((p) => p !== "");
  return fallback.length > 0 ? { persons: fallback, source: "entrant" } : { persons: [], source: "none" };
}

/**
 * Everything `aggregatePlayerStatsWithDiagnostics` learned about its own
 * attribution while it folded — not state, not I/O, a second return value
 * (S8/#417). This file is pure and stays outside the engine's logging
 * carve-out (`packages/engine/src/scheduling/**` is the only package
 * directory allowed to log) precisely because replay determinism and the
 * `src/core/**` 100%-lines coverage gate depend on it, so it cannot log
 * itself — this is what lets the apps/web CALLER turn these numbers into a
 * log line instead.
 *
 * What made this necessary: S8 gave the fold two silent-drop paths that
 * `PlayerStatRow[]` alone cannot show. An event can match a metric's
 * `from`/`when` and resolve NO person at all — `unattributed` below. And a
 * caller's own `ctx.entrants` can disagree with what its `personsOf` would
 * have answered — `unknownEntrants` below. A dropped credit and a credit
 * that was never attempted are indistinguishable in the output rows alone;
 * this is the data that tells them apart.
 *
 * Counters are per-CREDIT, not per-event: one event crediting two persons
 * on one metric (ice hockey's two assists, a pair entrant's both members)
 * moves a counter by 2, matching how `rows[].stats` itself accumulates.
 *
 * `fromPersonField` and `fromEntrantFallback` count the moment
 * `resolveMetricPersons` NAMES a person — before the `lineups` non-player
 * filter and before an `agg:"sum"` metric's value is computed. A coach's
 * card is a resolved credit that never becomes a row (`bump`'s `excluded`
 * check drops it silently, same as before this type existed); a `value()`
 * returning `undefined` is a resolved credit that contributes no number
 * (see `PlayerStatMetric.value`'s docstring — that is deliberate elsewhere
 * too). Both are counted here on purpose: these two counters answer "did
 * attribution find someone", not "did a stat point land" — `rows` and the
 * sibling `PlayerStatRow[]` already answer the second question, and
 * conflating the two would make a perfectly ordinary lineup exclusion look
 * like the S8 defect this type exists to surface.
 */
export interface PlayerStatsDiagnostics {
  /** Events considered, after `resolveVoids` — a voided event and the
   *  `core.void` that voided it are both already gone by this count. */
  events: number;
  /** Metric credits resolved from an explicit person field. Includes a
   *  credit later dropped by the `lineups` non-player filter, or by an
   *  `agg:"sum"` metric whose value came back `undefined` — see this
   *  type's own docstring for why those still count here. */
  fromPersonField: number;
  /** Metric credits resolved via `personsOf(entrantId)` — the v1-era-
   *  payload rescue path. Same inclusion rule as `fromPersonField`. */
  fromEntrantFallback: number;
  /** `(event, metric)` pairs that matched `from`/`when` but resolved to NO
   *  person: an empty explicit field AND — no `fromEntrant` fallback
   *  declared, no `ctx` supplied, an entrant id that did not resolve, an
   *  unknown entrant, a team entrant, or a known individual/pair entrant
   *  whose `personsOf` came back empty. Before S8/#417 every metric+event
   *  match credited someone or did not match at all; this is the new
   *  silent-drop state that session made possible. */
  unattributed: number;
  /** Entrant ids a `fromEntrant` metric's `entrantField` named that are
   *  absent from `ctx.entrants` — sorted, deduped. Non-empty means the
   *  caller's own `ctx.entrants` disagrees with the payloads it is
   *  folding — the exact thinner-stats failure mode this type exists to
   *  surface. */
  unknownEntrants: readonly string[];
  /** Entrant ids a `fromEntrant` metric's `entrantField` named that ARE
   *  declared in `ctx.entrants`, with kind `"team"` — sorted, deduped.
   *  The engine-side kind guard in `resolveMetricPersons` is why these
   *  credit nobody regardless of what `personsOf` would have answered. */
  teamEntrantsSkipped: readonly string[];
  /** Rows returned — `rows.length` on the sibling return value. */
  rows: number;
  /**
   * S8/#417 W6 fix 2 — the counters above observe only the metric+field
   * loop, yet most modules now carry stats through `model.folded` too (the
   * escape hatch for attribution a metric+field walk cannot express —
   * setbased/nested's match/set replay, a keeper's clean-sheet fold, …),
   * which is the path most likely to drop silently: its own attribution is
   * opaque from here, so unlike the loop above there is no per-credit
   * breakdown, only whether it ran and what it produced in aggregate.
   *
   * `true` iff `model.folded !== undefined` AND the gate that runs it fired
   * (`ctx !== undefined || lineups !== undefined`) — the SAME condition the
   * fold loop itself uses. `false` whenever the model has no `folded` at
   * all, or has one but neither `ctx` nor `lineups` was supplied (both
   * omitted ⇒ folded stays a no-op, byte-identical to before it existed) —
   * that is the ORDINARY inert case, not evidence of a problem.
   */
  foldedRan: boolean;
  /** Rows `model.folded.fold` returned, before they merge into the metric
   *  rows above. `0` whenever `foldedRan` is `false`. */
  foldedRows: number;
  /** Per-(person,key) stat entries `folded.fold`'s rows contributed to the
   *  merge — the folded-path analogue of `fromPersonField` +
   *  `fromEntrantFallback` above, at the same granularity `rows[].stats`
   *  itself accumulates (one row with two keys counts 2, not 1). `0`
   *  whenever `foldedRan` is `false` or `foldedRows` is `0`. */
  foldedCredits: number;
  /**
   * `foldedRan` is `true` but `foldedRows` is `0` — the folded path
   * actually executed and produced NOTHING, as distinct from never running
   * at all. On its own this is often correct (an empty or fully-voided
   * stream, a fold whose gate genuinely found nothing to credit this
   * fixture) — cross-reference `foldedEntrantsOutOfScope` before reading it
   * as a defect.
   */
  foldedEmpty: boolean;
  /**
   * `ctx` was supplied (not omitted) on a model that HAS `folded`, but
   * `ctx.entrants.length > 2` — the specific, silent hazard the
   * replay-based match/set folds (setbased/nested's own default
   * `playerStats.folded`) carry: they require `ctx.entrants` to be exactly
   * ONE fixture's two-sided [home, away] pair and bail to `[]` for any
   * other count, with no error (see `PlayerStatsFoldCtx.entrants`'s own
   * docstring — "which entrants exist THIS fixture" is load-bearing, not
   * loose phrasing). A caller that built `ctx.entrants` from a whole
   * division's roster (>2) — the natural-looking but wrong wiring this
   * field exists to catch — gets a table that looks exactly like a fixture
   * nobody scored.
   *
   * Deliberately does NOT fire for `ctx.entrants.length < 2` (S8/#417 W6
   * review round 2, fix 3 — the field used to read `!== 2` and over-fired
   * here). A dropped null side (bye/TBD) is a CORRECT, designed degradation
   * — the caller drops it rather than padding it (see apps/web's
   * `entrantFoldCtx` docstring) — not the division-wide-roster mistake this
   * field exists to diagnose; reporting it under the same flag would be the
   * wrong diagnosis for a right-shaped ctx. `false` whenever `ctx` was never
   * supplied at all (the ordinary lineups-only call every production caller
   * makes today), the model has no `folded` to hazard in the first place, or
   * `ctx.entrants.length` is 2 or fewer.
   */
  foldedEntrantsOutOfScope: boolean;
}

/**
 * Fold one fixture's event ledger into per-person stat contributions
 * (Jul3/07 §3), plus the `PlayerStatsDiagnostics` described above.
 * `core.void` drops the voided event entirely — a voided goal takes its
 * assist with it (§8). Deterministic: rows come back sorted by personId,
 * and so does every diagnostics field.
 *
 * `lineups` (S4/#428) is the role-discriminator boundary: a coach or team
 * official can be shown a card (S3 ruling 3 keeps him IN the squad so that is
 * possible) but must never earn a playing-stat row. Enforced HERE, inside the
 * shared fold, rather than trusting every sport's `PlayerStatMetric.when` to
 * add its own role check — a check that lives in eleven separate places is a
 * check that is eleven times as easy to forget once. Optional and additive:
 * omitted, this is byte-identical to the fold before this field existed.
 *
 * `ctx` (S8/#417) is the same discipline applied to entrant-only payloads:
 * omitted, `PlayerStatMetric.fromEntrant`/`entrantField` and
 * `PlayerStatsModel.folded` are both complete no-ops and behaviour is
 * byte-identical to before either field existed.
 *
 * `aggregatePlayerStats` below is a thin wrapper over this function's
 * `.rows` — change the fold HERE only. Two loops computing the same rows
 * is exactly the placer/verifier fork this repo has shipped repeatedly
 * (three times in one session, twice more since); this file has one fold,
 * and the diagnostics pass is inline in it rather than a second walk over
 * `active` so the two can never drift apart.
 */
export function aggregatePlayerStatsWithDiagnostics(
  events: readonly EventEnvelope[],
  model: PlayerStatsModel,
  lineups?: LineupPair,
  ctx?: PlayerStatsFoldCtx,
): { rows: PlayerStatRow[]; diagnostics: PlayerStatsDiagnostics } {
  const active = resolveVoids([...events]);
  const rows = new Map<string, Record<string, number>>();
  const excluded = lineups === undefined ? undefined : nonPlayerPersonIds(lineups);
  const bump = (personId: string, key: string, by: number) => {
    if (excluded?.has(personId) === true) return;
    const stats = rows.get(personId) ?? {};
    stats[key] = (stats[key] ?? 0) + by;
    rows.set(personId, stats);
  };

  // S8/#417 diagnostics accumulators — see `PlayerStatsDiagnostics` for
  // what each counts and why "unattributed" is not the same question as
  // "excluded". `unknownEntrants`/`teamEntrantsSkipped` are Sets because
  // the same entrant id routinely repeats across a fixture's events and
  // the output must be deduped.
  let fromPersonField = 0;
  let fromEntrantFallback = 0;
  let unattributed = 0;
  const unknownEntrants = new Set<string>();
  const teamEntrantsSkipped = new Set<string>();

  for (const event of active) {
    const payload = event.payload as Record<string, unknown>;
    for (const metric of model.metrics) {
      if (event.type !== metric.from) continue;
      if (metric.when !== undefined && !metric.when(payload)) continue;
      const resolution = resolveMetricPersons(payload, metric, ctx);
      const persons = resolution.persons;
      if (resolution.source === "field") fromPersonField += persons.length;
      else if (resolution.source === "entrant") fromEntrantFallback += persons.length;
      if (resolution.unknownEntrantId !== undefined) unknownEntrants.add(resolution.unknownEntrantId);
      if (resolution.teamEntrantId !== undefined) teamEntrantsSkipped.add(resolution.teamEntrantId);
      if (persons.length === 0) {
        unattributed += 1; // matched from/when, resolved nobody — S8's new silent-drop state
        continue;
      }
      if (metric.agg === "count") {
        for (const p of persons) bump(p, metric.key, 1);
      } else {
        // `value` (S8/#417) takes precedence over a plain `sumField` walk.
        // Returning `undefined` must contribute NOTHING — not a bump of
        // zero — so `typeof value === "number"` below is the only gate;
        // `bump` is never called for an `undefined` value, which is what
        // keeps "never happened" distinguishable from "happened, value 0".
        const value =
          metric.value !== undefined
            ? metric.value(payload)
            : resolvePayloadPath(payload, metric.sumField ?? "value");
        // `Number.isFinite` excludes NaN/±Infinity on top of the pre-existing
        // `typeof` gate (S8/#417 W6 fix 6) — a zero-denominator ratio metric
        // (e.g. `made / attempts`) must contribute NOTHING, not a value that
        // poisons every running total it is ever added to (`sumPlayerStats`
        // adds blindly). `typeof value === "number"` stays first: it is what
        // narrows `value` from `number | undefined` to `number` for the
        // `bump` call below, and it is what keeps `undefined` (never
        // happened) distinguishable from a real, finite `0` (happened,
        // scored zero) — `Number.isFinite` alone would lose that narrowing.
        if (typeof value === "number" && Number.isFinite(value)) {
          for (const p of persons) bump(p, metric.key, value);
        }
      }
    }
    if (event.type === "core.award") {
      const person = payload.person;
      const key = payload.key;
      if (typeof person === "string" && typeof key === "string") {
        const spec = (model.awards ?? []).find((a) => a.key === key);
        if (spec !== undefined) bump(person, `${key}_awards`, 1);
      }
    }
  }

  // S8/#417 — the folded path is an alternative attribution mechanism for
  // sports whose events cannot be expressed as a metric+field walk at all
  // (see `PlayerStatsModel.folded`'s docstring). It reads the SAME
  // void-resolved list so a voided event un-counts identically in both
  // paths, and merges into the metric rows through the same `bump` — which
  // is also how the `lineups` exclusion ends up applying uniformly to both.
  // Its own attribution is opaque from here — `fold` may resolve persons
  // however it likes — so it contributes to none of the counters above;
  // only the metric+field/entrant loop can see enough to say WHY a pair
  // resolved nobody.
  //
  // Gated on EITHER `ctx` or `lineups` (previously `ctx` alone) — a keeper
  // fold needs only `lineups`, never `ctx`, and every production caller today
  // supplies `lineups` and no `ctx` at all; gating on `ctx` alone would leave
  // that fold permanently unreachable outside a test that manufactures one.
  // Both omitted still short-circuits here exactly as before this change.
  //
  // S8/#417 W6 fix 2 — the four `folded*` accumulators below are computed
  // regardless of whether the gate fires, from the SAME condition the gate
  // itself reads, so they can never drift from what actually ran.
  let foldedRan = false;
  let foldedRows = 0;
  let foldedCredits = 0;
  if (model.folded !== undefined && (ctx !== undefined || lineups !== undefined)) {
    foldedRan = true;
    const foldedOut = model.folded.fold(active, ctx ?? EMPTY_FOLD_CTX, lineups);
    foldedRows = foldedOut.length;
    for (const row of foldedOut) {
      for (const [key, value] of Object.entries(row.stats)) {
        bump(row.personId, key, value);
        foldedCredits += 1;
      }
    }
  }
  const foldedEmpty = foldedRan && foldedRows === 0;
  // The live hazard (see `foldedEntrantsOutOfScope`'s own docstring): only
  // meaningful when a folded fold exists AND the caller actually supplied a
  // `ctx` — an omitted `ctx` (the lineups-only production call shape) is the
  // ordinary, documented no-op path, not a caller mistake to flag. `> 2`,
  // not `!== 2` (S8/#417 W6 review round 2, fix 3): fewer than 2 is a
  // dropped bye/TBD side, a different and correct degradation, not this
  // hazard — see the field's own docstring.
  const foldedEntrantsOutOfScope =
    model.folded !== undefined && ctx !== undefined && ctx.entrants.length > 2;

  for (const [, stats] of rows) {
    for (const d of model.derived ?? []) {
      stats[d.key] = d.derive(stats);
    }
  }
  const rowsOut = [...rows.entries()]
    .map(([personId, stats]) => ({ personId, stats }))
    .sort((a, b) => a.personId.localeCompare(b.personId));

  return {
    rows: rowsOut,
    diagnostics: {
      events: active.length,
      fromPersonField,
      fromEntrantFallback,
      unattributed,
      unknownEntrants: [...unknownEntrants].sort(),
      teamEntrantsSkipped: [...teamEntrantsSkipped].sort(),
      rows: rowsOut.length,
      foldedRan,
      foldedRows,
      foldedCredits,
      foldedEmpty,
      foldedEntrantsOutOfScope,
    },
  };
}

/**
 * `aggregatePlayerStatsWithDiagnostics(...).rows` alone, for every existing
 * caller that does not want the second return value — see that function
 * for the actual fold. Kept byte-identical in signature and return type
 * (S8/#417): this is a one-line wrapper, not a second implementation, so
 * it can never drift from what the diagnostics-returning fold computes.
 */
export function aggregatePlayerStats(
  events: readonly EventEnvelope[],
  model: PlayerStatsModel,
  lineups?: LineupPair,
  ctx?: PlayerStatsFoldCtx,
): PlayerStatRow[] {
  return aggregatePlayerStatsWithDiagnostics(events, model, lineups, ctx).rows;
}

/**
 * Static collision check between a model's declared `folded.keys` and its
 * `metrics[].key` (S8/#417) — for tests and conformance to call, never the
 * fold itself: a data-derived throw inside a fold permanently bricks a
 * recorded fixture (this repo has hit that six times in one wave), so the
 * runtime merge always stays a plain addition regardless of a collision.
 * A `folded.keys` entry also listed in `folded.sharesMetricKeys` (S8/#417 W6
 * fix 1) is a DECLARED, intentional overlap and is excluded from the
 * result; every other overlap is a real, undeclared clash — including one
 * on a model that also happens to declare OTHER, unrelated intentional
 * shares. Empty result = clean model.
 */
export function playerStatsKeyCollisions(model: PlayerStatsModel): string[] {
  if (model.folded === undefined) return [];
  const metricKeys = new Set(model.metrics.map((m) => m.key));
  const shared = new Set(model.folded.sharesMetricKeys ?? []);
  return model.folded.keys.map((k) => k.key).filter((k) => metricKeys.has(k) && !shared.has(k));
}

/** Sum per-fixture rows into a division table (addition is commutative — the
 *  fold is order-independent, same discipline as standings). */
export function sumPlayerStats(
  perFixture: readonly PlayerStatRow[][],
  model: PlayerStatsModel,
): PlayerStatRow[] {
  const rows = new Map<string, Record<string, number>>();
  for (const fixture of perFixture) {
    for (const row of fixture) {
      const stats = rows.get(row.personId) ?? {};
      for (const [key, value] of Object.entries(row.stats)) {
        if ((model.derived ?? []).some((d) => d.key === key)) continue; // re-derived below
        stats[key] = (stats[key] ?? 0) + value;
      }
      rows.set(row.personId, stats);
    }
  }
  for (const [, stats] of rows) {
    for (const d of model.derived ?? []) stats[d.key] = d.derive(stats);
  }
  return [...rows.entries()]
    .map(([personId, stats]) => ({ personId, stats }))
    .sort((a, b) => a.personId.localeCompare(b.personId));
}
