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
import { CoreForfeit, playRecorded, resolveVoids, type EventEnvelope } from "../core/events.ts";
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
  /**
   * W2b (X-PS-1) — this metric counts an APPEARANCE (chess's "games", one per pairing card). It is not credited in a
   * fixture whose ledger is a forfeit nobody played — a walkover, a withdrawal with nothing played (ruling 127), a
   * double walkover — even when the card it counts was recorded before the no-show. See `PlayerStatsModel.unplayed`.
   */
  appearance?: true;
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
  /**
   * W2b (X-PS-1; ruling 120) — whether a fixture's (void-resolved) ledger holding a `core.forfeit` or a `core.abandon`
   * is not a match played, which skips every `appearance` metric. Absent ⇒ `statsUnplayed(events, module)`. A sport
   * whose result can stand BEFORE a forfeit supplies its own (chess: the classical game before a tie-break walkover
   * stays played, ruling D-C6), built on `statsUnplayed` with its own module so the abandon rule keeps one copy.
   */
  unplayed?: (events: readonly EventEnvelope[]) => boolean;
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
 * W2b (spec §5.2 W2b-R9; Appendix A X-PS-1, X-PS-2) — how a fixture's ACTIVE `core.forfeit` reads for player stats.
 *
 * - `"unplayed"`: a walkover or a double walkover over a match nothing had decided — not a match anybody played: no
 *   appearance, no personal win or loss (X-PS-1). Ruling 115: so is a disqualification with nothing played before it
 *   (before the Start, or after a Start with no sport event after it) — `playRecorded`, the one "played" fact the
 *   kernel's forfeit phase guard reads (rulings 112, 113, 114), of the ledger before that forfeit. Ruling 127: and so is
 *   a withdrawal with nothing played before it.
 * - `"appeared"` (ruling 127, amending X-PS-1): a withdrawal AFTER play was recorded — a match for both sides' players
 *   (appearances, the events already played, a keeper's clean sheet), but no personal win or loss: nobody won or lost
 *   it on the field.
 * - `"played"`: a retirement or an in-match disqualification (something played before it) — a match for both sides'
 *   players, the W/L as decided, the events already played still credited (X-PS-2).
 * - `null`: no active forfeit; a payload that is not a W2b forfeit (a pre-W2b free-text reason, read as before); or a
 *   forfeit after `decidedBefore` saw a result stand (chess: the classical game, D-C6 / BG-WO-3) — that result keeps
 *   its credit and the forfeit adds none.
 *
 * `events` must already be void-resolved (`aggregatePlayerStats` hands every fold that list), so the last forfeit in
 * it is the effective one. `module` is the sport's own declaration for `playRecorded` (ruling 118): a module declaring
 * `startIsPlay` passes itself (boardgame), so a disqualification after its bare Start is in-match; every other sport
 * reads as no declaration.
 */
export function forfeitStatsRole(
  events: readonly EventEnvelope[],
  decidedBefore?: (event: EventEnvelope) => boolean,
  module: { readonly startIsPlay?: boolean } = {},
): ForfeitStatsRole | null {
  let decided = false;
  let role: ForfeitStatsRole | null = null;
  for (const [index, event] of events.entries()) {
    if (decidedBefore?.(event) === true) decided = true;
    if (event.type !== "core.forfeit") continue;
    const forfeit = CoreForfeit.safeParse(event.payload);
    if (!forfeit.success) {
      role = null;
      continue;
    }
    const { by, reason } = forfeit.data;
    // Rulings 115 and 127: a disqualification or a withdrawal with nothing played before it is treated like a walkover.
    const afterPlay = (reason === "disqualified" || reason === "withdrew") && playRecorded(events.slice(0, index), module);
    if (decided) role = null;
    else if (by === "both" || reason === "walkover" || ((reason === "disqualified" || reason === "withdrew") && !afterPlay)) role = "unplayed";
    else role = reason === "withdrew" ? "appeared" : "played";
  }
  return role;
}

/** `forfeitStatsRole`'s answers: no match / a match with no personal result (ruling 127) / a match, W/L as decided. */
export type ForfeitStatsRole = "unplayed" | "appeared" | "played";

/** What the players'-stats reader reads of a sport (ruling 120): the module's OWN declarations, never a copy — so any
 *  `SportModule` is one. `startIsPlay` says what "something played" means (ruling 118: in chess the Start is play);
 *  `playerStats.unplayed` is a model's own reading where a result can stand before a forfeit (chess, ruling D-C6). */
export interface StatsPlayDeclaration {
  readonly startIsPlay?: boolean;
  readonly playerStats?: Pick<PlayerStatsModel, "unplayed">;
}

/**
 * W2b (X-PS-1, X-PS-2; rulings 115, 120) — the default reading of a void-resolved ledger that holds a `core.forfeit` or
 * a `core.abandon`: is it NOT a match played? A forfeit reads by `forfeitStatsRole` (a walkover, a double walkover, and
 * a disqualification or a withdrawal with nothing played are not a match; a retirement, an in-match disqualification
 * and a withdrawal after play are — rulings 115, 127). An abandon is a match only if something was played before it (ruling 120): `playRecorded` of the ledger before
 * the active abandon — any active sport event after the Start, scoring or not (ruling 114), and in chess the Start
 * itself (ruling 118). With nothing played it is no match for anybody, whatever its result or a settle after it. A
 * ledger holding neither is not unplayed here.
 *
 * A recorded ledger never holds both: the kernel refuses a forfeit once a match is abandoned (ABANDONED_SETTLE_OR_VOID)
 * and an abandon once it is decided (ALREADY_DECIDED). Were both active, the forfeit decides, as it did before ruling
 * 120. `decidedBefore` is `forfeitStatsRole`'s (chess: the classical game's result). A model's own `unplayed` calls this
 * with its module, so the abandon rule has one copy.
 */
export function statsUnplayed(
  active: readonly EventEnvelope[],
  module: { readonly startIsPlay?: boolean },
  decidedBefore?: (event: EventEnvelope) => boolean,
): boolean {
  if (active.some((event) => event.type === "core.forfeit")) return forfeitStatsRole(active, decidedBefore, module) === "unplayed";
  let abandonAt = -1;
  for (const [index, event] of active.entries()) if (event.type === "core.abandon") abandonAt = index;
  return abandonAt >= 0 && !playRecorded(active.slice(0, abandonAt), module);
}

/**
 * W2b (X-PS-1, X-PS-2; rulings 115, 120) — is this fixture a match played in players' stats? THE one reader, in this
 * order:
 * 1. an empty ledger (after voids) is not: nothing was recorded, so nothing was played — the walkovers, byes and double
 *    walkovers a product settles without writing an event (X-PS-1);
 * 2. a ledger with no active `core.forfeit` and no active `core.abandon` is: X-PS-1 takes a match away only through a
 *    forfeit, and ruling 120 only through an abandon with nothing played before it, so the model is not asked;
 * 3. otherwise the module's model's own `unplayed` where it declares one (chess: the classical game before a tie-break
 *    walkover stays played), else `statsUnplayed` with the module — a walkover, a double walkover, and a
 *    disqualification, a withdrawal (ruling 127) or an abandon (ruling 120) with nothing played are not; a retirement,
 *    an in-match disqualification, a withdrawal after play and an abandon after play are.
 * `events` is one fixture's ledger; voids are resolved here, so a caller may hand it the stored rows as they are. Steps 1
 * and 2 answer without reading the module, so a caller holding many ledgers needs to read in full only those holding a
 * `core.forfeit`, a `core.abandon` or a `core.void` row: any other non-empty ledger is played.
 *
 * `module` is REQUIRED (ruling 120): what counts as "played" before an abandon is the sport's own (`startIsPlay`), so no
 * caller can leave it out. Any `SportModule` is a `StatsPlayDeclaration`; pass the module itself, never a hand-made one.
 * The one exception is the shared fold below, which holds only the model: a module whose Start is play declares its own
 * `unplayed` (boardgame), which answers for it — sport/player-stats-ruling-120.test.ts holds every sport to that.
 *
 * The shared fold below asks it before crediting an appearance; the set-based, nested and carrom folds ask it before
 * crediting `matches`; and apps/web asks it before counting a person's matches (the career count, the public player's
 * match lines) — so no surface carries a second copy of the rule.
 */
export function playedInStats(events: readonly EventEnvelope[], module: StatsPlayDeclaration): boolean {
  const active = resolveVoids([...events]);
  if (active.length === 0) return false;
  if (!active.some((event) => event.type === "core.forfeit" || event.type === "core.abandon")) return true;
  return !(module.playerStats?.unplayed?.(active) ?? statsUnplayed(active, module));
}

/**
 * W2b ruling 127 (amending X-PS-1) — does this fixture credit a PERSONAL result (a win, a draw, a loss)? Only a match
 * played (`playedInStats`), and never one a withdrawal ended: a withdrawal after play is a match both sides' players
 * appeared in, but nobody won or lost it on the field (`forfeitStatsRole` "appeared"). The folds that credit a personal
 * result (generic's W/D/L, carrom's wins) ask this; chess reads `forfeitStatsRole` itself (its classical game decides,
 * BG-WO-3). `events` is one fixture's ledger; voids are resolved here.
 */
export function resultInStats(events: readonly EventEnvelope[], module: StatsPlayDeclaration): boolean {
  if (!playedInStats(events, module)) return false;
  return forfeitStatsRole(resolveVoids([...events]), undefined, module) !== "appeared";
}

/**
 * The players'-stats fold version (W2b ruling R115-2). BUMP THIS WHEN THE FOLD'S OUTPUT CHANGES for the same ledger and
 * the same inputs: this file's fold (`aggregatePlayerStatsWithDiagnostics`, `playedInStats`, `forfeitStatsRole`), any
 * sport's `playerStats` model, or apps/web's `foldDivision` around it.
 *
 * apps/web stores each division's folded rows (`player_stat_snapshots`) with an md5 of the fold's inputs, and serves
 * them for as long as that md5 and the ledger still match (`playerStatsCoverage`). The md5 carries this number, so a
 * bump makes every stored snapshot read as owed once: the first read that folds (or the read-side check behind the
 * public stats reads) refolds it under the new rules. No migration, no production write. Forgetting the bump leaves
 * every snapshot folded by the old rules served as it is until its division changes.
 *
 * History: 1 — every fold before the version existed (its md5 carried none); 2 — W2b's X-PS-1/X-PS-2 and ruling 115
 * (an unplayed forfeit is no match; a disqualification with nothing played is unplayed; a bye is no match, R115-3);
 * 3 — ruling 118 (chess: a disqualification after a bare Start is a game both players played).
 * 4 — R115 review M3 (the set-based, nested and carrom folds count `matches` through `playedInStats`);
 * 5 — ruling 120 (an abandon is a match only if something was played before it; carrom's wins follow the reader);
 * 6 — ruling 127 (a withdrawal after play is a match for both sides' players, with no personal result).
 * 7 — W2e T32 fix round 2 (football's keeper stats judge a `core.lineup.*` event on the pitch a `football.sub` moved, as
 *     the match fold does: a keeper named in goal after a legacy substitution is charged, not the man who left).
 */
export const STATS_FOLD_VERSION = 7;

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

  // W2b (X-PS-1): an appearance metric is not credited in a fixture nobody played. Asked once, and only of a model
  // that declares one.
  // The shared fold holds only the model: a module whose Start is play answers through its own `unplayed` (boardgame),
  // as `playedInStats` documents — sport/player-stats-ruling-120.test.ts holds every sport to it.
  const unplayed = model.metrics.some((metric) => metric.appearance === true) && !playedInStats(active, { playerStats: model });

  for (const event of active) {
    const payload = event.payload as Record<string, unknown>;
    for (const metric of model.metrics) {
      if (event.type !== metric.from) continue;
      if (unplayed && metric.appearance === true) continue;
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
