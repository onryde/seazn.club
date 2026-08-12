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
   * loop, only when a `PlayerStatsFoldCtx` is supplied, and its rows merge
   * into the metric rows by per-key addition (same discipline as
   * `sumPlayerStats`). `keys` is a static declaration of what `fold` may
   * produce, checked for collisions against `metrics[].key` by
   * `playerStatsKeyCollisions` — the runtime merge never throws on a
   * collision (a data-derived throw inside a fold permanently bricks a
   * recorded fixture), so that checker is the only place a collision is
   * ever surfaced.
   */
  folded?: {
    keys: readonly string[];
    fold: (events: readonly EventEnvelope[], ctx: PlayerStatsFoldCtx) => PlayerStatRow[];
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
 */
function resolveMetricPersons(
  payload: Record<string, unknown>,
  metric: PlayerStatMetric,
  ctx: PlayerStatsFoldCtx | undefined,
): readonly string[] {
  const explicit = resolvePayloadPath(payload, metric.field ?? "person");
  // Same array-or-single-or-none normalisation the explicit path has always
  // used (ice hockey's two assists credit every listed person once).
  const persons = Array.isArray(explicit)
    ? explicit.filter((p): p is string => typeof p === "string" && p !== "")
    : typeof explicit === "string" && explicit !== ""
      ? [explicit]
      : [];
  if (persons.length > 0) return persons; // explicit field wins — never fall through

  if (ctx === undefined || metric.fromEntrant !== true || metric.entrantField === undefined) return [];
  const entrantId = resolvePayloadPath(payload, metric.entrantField);
  if (typeof entrantId !== "string" || entrantId === "") return [];
  const entrant = ctx.entrants.find((e) => e.id === entrantId);
  if (entrant === undefined || entrant.kind === "team") return []; // mandatory kind guard
  return ctx.personsOf(entrantId).filter((p) => p !== "");
}

/**
 * Fold one fixture's event ledger into per-person stat contributions
 * (Jul3/07 §3). `core.void` drops the voided event entirely — a voided goal
 * takes its assist with it (§8). Deterministic: rows come back sorted by
 * personId.
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
 */
export function aggregatePlayerStats(
  events: readonly EventEnvelope[],
  model: PlayerStatsModel,
  lineups?: LineupPair,
  ctx?: PlayerStatsFoldCtx,
): PlayerStatRow[] {
  const active = resolveVoids([...events]);
  const rows = new Map<string, Record<string, number>>();
  const excluded = lineups === undefined ? undefined : nonPlayerPersonIds(lineups);
  const bump = (personId: string, key: string, by: number) => {
    if (excluded?.has(personId) === true) return;
    const stats = rows.get(personId) ?? {};
    stats[key] = (stats[key] ?? 0) + by;
    rows.set(personId, stats);
  };

  for (const event of active) {
    const payload = event.payload as Record<string, unknown>;
    for (const metric of model.metrics) {
      if (event.type !== metric.from) continue;
      if (metric.when !== undefined && !metric.when(payload)) continue;
      const persons = resolveMetricPersons(payload, metric, ctx);
      if (persons.length === 0) continue;
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
        if (typeof value === "number") for (const p of persons) bump(p, metric.key, value);
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
  if (model.folded !== undefined && ctx !== undefined) {
    for (const row of model.folded.fold(active, ctx)) {
      for (const [key, value] of Object.entries(row.stats)) bump(row.personId, key, value);
    }
  }

  for (const [, stats] of rows) {
    for (const d of model.derived ?? []) {
      stats[d.key] = d.derive(stats);
    }
  }
  return [...rows.entries()]
    .map(([personId, stats]) => ({ personId, stats }))
    .sort((a, b) => a.personId.localeCompare(b.personId));
}

/**
 * Static collision check between a model's declared `folded.keys` and its
 * `metrics[].key` (S8/#417) — for tests and conformance to call, never the
 * fold itself: a data-derived throw inside a fold permanently bricks a
 * recorded fixture (this repo has hit that six times in one wave), so the
 * runtime merge always stays a plain addition regardless of a collision.
 * Empty result = clean model.
 */
export function playerStatsKeyCollisions(model: PlayerStatsModel): string[] {
  if (model.folded === undefined) return [];
  const metricKeys = new Set(model.metrics.map((m) => m.key));
  return model.folded.keys.filter((k) => metricKeys.has(k));
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
