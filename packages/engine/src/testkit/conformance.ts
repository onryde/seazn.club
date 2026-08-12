// Conformance suite — PROMPT-03 §4. Any module's test file invokes
// conformanceSuite(module) and gets every spec 04 §9 cross-sport invariant
// asserted over property-generated event streams (spec 03 §6).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { foldMatch, resolveVoids, type CoreEv, type EventEnvelope } from "../core/events.ts";
import {
  MatchOutcome,
  MetricSpec,
  ScoreSummary,
  StandingsDelta,
  type LineupPair,
  type StageCtx,
} from "../core/types.ts";
import { PositionCatalog, resolvePositions, validateLineup } from "../sport/catalog.ts";
import { FidelityTier, type SportModule } from "../sport/module.ts";
import { parseSemver } from "../sport/registry.ts";
import {
  aggregatePlayerStats,
  aggregatePlayerStatsWithDiagnostics,
  playerStatsKeyCollisions,
  type PlayerStatMetric,
  type PlayerStatsFoldCtx,
} from "../stats/stats.ts";
import { buildStream, defaultLineupPair, makeEnvelope } from "./helpers.ts";

// W4a (#425) §3.3 — every fold below is PAD-SHAPED: it is building a stream
// event by event, which is the write path. `strictFromSeq: 0` marks the whole
// stream new and is therefore exactly the pre-seam behaviour. Only a real READ
// path (apps/web fold.ts) and the cfg-replay property pass no options.
const STRICT_ALL = { strictFromSeq: 0 } as const;

export interface ConformanceOpts {
  cfg?: unknown; // raw config, parsed through module.configSchema (default {})
  lineups?: LineupPair; // default: minimal lineups from the position catalog
  stageCtxs?: StageCtx[]; // contexts for standingsDelta (default league + knockout)
  numRuns?: number; // fast-check runs per invariant (default 300)
  maxEvents?: number; // stream length cap (default 40)
  label?: string; // disambiguates multiple suites for one module
}

// Test-only setter for a (possibly dotted) PlayerStatMetric field path — the
// inverse of stats.ts's own `resolvePayloadPath` walk, used ONLY to build a
// synthetic single-event payload for the playerStats double-count proof
// below. Never reimplements `resolvePayloadPath`'s resolution/precedence
// rules (literal-key-wins, array-as-leaf) — it just writes one value so that
// walk reads it back.
function setAtPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  let cursor = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]!;
    const existing = cursor[segment];
    const next =
      typeof existing === "object" && existing !== null && !Array.isArray(existing)
        ? (existing as Record<string, unknown>)
        : {};
    cursor[segment] = next;
    cursor = next;
  }
  cursor[segments[segments.length - 1]!] = value;
}

export function conformanceSuite<Cfg, Ev, State>(
  module: SportModule<Cfg, Ev, State>,
  opts: ConformanceOpts = {},
): void {
  const cfg = module.configSchema.parse(opts.cfg ?? {});
  // W4 (#407) — the catalog that governs THIS config, not the module-wide
  // one: a variant with its own lineup rules must be conformance-tested
  // against the lineup it actually fields.
  const catalog = resolvePositions(module, cfg);
  const lineups = opts.lineups ?? defaultLineupPair(catalog);
  const stageCtxs = opts.stageCtxs ?? [{ kind: "league" as const }, { kind: "knockout" as const }];
  const numRuns = opts.numRuns ?? 300;
  const maxEvents = opts.maxEvents ?? 40;

  const fold = (events: readonly EventEnvelope[]) =>
    foldMatch(module, cfg, lineups, events, STRICT_ALL);
  // Envelopes from generators carry `unknown` payloads; the module's own
  // generator only emits its Ev | CoreEv union.
  const asModuleEvent = (event: EventEnvelope) => event as EventEnvelope<Ev | CoreEv>;
  const streamArb = fc
    .tuple(fc.nat(), fc.integer({ min: 1, max: maxEvents }))
    .map(([seed, length]) => buildStream(module, cfg, lineups, seed, length));

  // Streams that reached a decision — §9.2/9.3/9.4 need decided outcomes.
  function decidedOnly(events: EventEnvelope[]): { state: State; outcome: MatchOutcome } | null {
    const state = fold(events);
    const outcome = module.outcome(state);
    return outcome === null ? null : { state, outcome };
  }

  const suiteName = `conformance — ${module.key}@${module.version}${opts.label ? ` (${opts.label})` : ""}`;

  describe(suiteName, () => {
    it("declares a well-formed identity (spec 03 §3, doc 14 §2, doc 13 §1)", () => {
      expect(module.key.length).toBeGreaterThan(0);
      parseSemver(module.version); // throws on non-semver
      PositionCatalog.parse(module.positions);
      PositionCatalog.parse(catalog);
      expect(module.fidelityTiers.length).toBeGreaterThan(0);
      for (const tier of module.fidelityTiers) FidelityTier.parse(tier);
      expect(module.officialLabel.scorer.length).toBeGreaterThan(0);
      for (const metric of module.metrics) MetricSpec.parse(metric);
      expect(module.defaultTiebreakers.length).toBeGreaterThan(0);
      const pointsSets = module.declaredPointsSets(cfg);
      expect(pointsSets.length).toBeGreaterThan(0);
      for (const total of pointsSets) expect(Number.isFinite(total)).toBe(true);
    });

    it("accepts the conformance lineups against its own catalog (spec 02 §3)", () => {
      expect(validateLineup(catalog, lineups.home)).toEqual([]);
      expect(validateLineup(catalog, lineups.away)).toEqual([]);
    });

    // §9.1 — apply is pure & total on valid input.
    it("§9.1 init/apply are pure and deterministic", () => {
      expect(module.init(cfg, lineups)).toEqual(module.init(cfg, lineups));
      fc.assert(
        fc.property(streamArb, (events) => {
          expect(fold(events)).toEqual(fold(events));
          // apply must not mutate its input state or the event payload.
          let state = module.init(cfg, lineups);
          for (const event of resolveVoids(events)) {
            const stateBefore = JSON.stringify(state);
            const payloadBefore = JSON.stringify(event.payload ?? null);
            const next = module.apply(state, asModuleEvent(event));
            expect(JSON.stringify(state)).toBe(stateBefore);
            expect(JSON.stringify(event.payload ?? null)).toBe(payloadBefore);
            state = next;
          }
        }),
        { numRuns },
      );
    });

    // §9.2 — outcome never returns to null, never changes identity after
    // decision; post-decision annotations leave it untouched.
    it("§9.2 outcome is monotone and stable after decision", () => {
      fc.assert(
        fc.property(streamArb, (events) => {
          let state = module.init(cfg, lineups);
          let decided: MatchOutcome | null = null;
          for (const event of events) {
            state = module.apply(state, asModuleEvent(event));
            const outcome = module.outcome(state);
            if (decided !== null) {
              expect(outcome).toEqual(decided);
            } else if (outcome !== null) {
              MatchOutcome.parse(outcome);
              decided = outcome;
            }
          }
          if (decided !== null) {
            const annotated = fold([
              ...events,
              makeEnvelope(events.length, { type: "core.note", payload: { text: "conformance" } }),
            ]);
            expect(module.outcome(annotated)).toEqual(decided);
          }
        }),
        { numRuns },
      );
    });

    // §9.3 — Σ points awarded per fixture ∈ the sport's declared set.
    it("§9.3 standingsDelta conserves the declared points sets", () => {
      const allowed = module.declaredPointsSets(cfg);
      let decidedSeen = 0;
      fc.assert(
        fc.property(streamArb, (events) => {
          const decided = decidedOnly(events);
          if (!decided) return;
          decidedSeen++;
          for (const ctx of stageCtxs) {
            if (decided.outcome.kind === "draw" && !module.supportsDraws(cfg, ctx.kind)) continue;
            const [home, away] = module.standingsDelta(decided.outcome, cfg, ctx, decided.state);
            StandingsDelta.parse(home);
            StandingsDelta.parse(away);
            expect(allowed).toContain(home.points + away.points);
          }
        }),
        { numRuns },
      );
      // The generator must actually reach decisions, or §9.2–9.4 prove nothing.
      expect(decidedSeen).toBeGreaterThan(0);
    });

    // §9.4 — integers or exact rationals, never floats: rational metrics are
    // stored as separate integer numerator/denominator keys (NRR: runs_for +
    // balls_faced_eff, spec 04 §2.4) and computed at comparison time.
    it("§9.4 standings deltas carry an integer ledger", () => {
      fc.assert(
        fc.property(streamArb, (events) => {
          const decided = decidedOnly(events);
          if (!decided) return;
          for (const ctx of stageCtxs) {
            if (decided.outcome.kind === "draw" && !module.supportsDraws(cfg, ctx.kind)) continue;
            for (const delta of module.standingsDelta(decided.outcome, cfg, ctx, decided.state)) {
              for (const [key, value] of Object.entries(delta.metrics)) {
                expect(Number.isInteger(value), `metric "${key}" must be an integer`).toBe(true);
              }
              // Points allow exact halves (boardgame draws, spec 04 §6.1).
              expect(Number.isInteger(delta.points * 2)).toBe(true);
            }
          }
        }),
        { numRuns },
      );
    });

    // §9.5 — live UI safety: summary defined at every prefix.
    it("§9.5 summary is well-formed on every prefix", () => {
      fc.assert(
        fc.property(streamArb, (events) => {
          let state = module.init(cfg, lineups);
          ScoreSummary.parse(module.summary(state));
          for (const event of events) {
            state = module.apply(state, asModuleEvent(event));
            ScoreSummary.parse(module.summary(state));
          }
        }),
        { numRuns },
      );
    });

    // spec 02 §4 — bad configs can never reach play; parsing is idempotent.
    it("config schema round-trips every named variant", () => {
      const base = (opts.cfg ?? {}) as Record<string, unknown>;
      for (const [name, preset] of Object.entries(module.variants)) {
        const merged = module.configSchema.parse({ ...base, ...preset });
        expect(module.configSchema.parse(merged), `variant "${name}"`).toEqual(merged);
      }
    });

    // §9.6 — opt-in dual-fidelity: coarse and fine streams describing the
    // same match fold to identical outcomes and summaries.
    if (module.coarsen) {
      it("§9.6 dual-fidelity: coarse fold ≡ fine fold", () => {
        // Extracted only to carry the null-check out of the property body.
        // The receiver is never lost: the call below is `.call(module, …)`,
        // which supplies `this` explicitly.
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const coarsen = module.coarsen as NonNullable<typeof module.coarsen>;
        fc.assert(
          fc.property(streamArb, (events) => {
            const active = resolveVoids(events).map(asModuleEvent);
            const coarse = coarsen
              .call(module, active)
              .map((event, i) => makeEnvelope(i, event));
            const fine = fold(events);
            const folded = fold(coarse);
            expect(module.outcome(folded)).toEqual(module.outcome(fine));
            expect(module.summary(folded)).toEqual(module.summary(fine));
          }),
          { numRuns },
        );
      });
    }

    // S8/#417 — playerStats: every sport module's stat model, proved against
    // the SAME generated streams the invariants above already build. Gated
    // like §9.6: a module with no playerStats model has nothing to prove
    // here and is skipped outright. Every builtin module declares
    // `playerStats`; `generic` is the one builtin with no `entrantModel` at
    // all, handled by the `?? "individual"` fallback below.
    if (module.playerStats) {
      const playerStats = module.playerStats;
      // `module.entrantModel` (sport/entrant-model.ts) declares which
      // entrant kinds this sport fields — build ctx from THAT, never a
      // hardcoded kind. "individual" is the same fallback
      // `effectiveEntrantModel` uses when nothing was declared.
      const entrantKind = module.entrantModel?.defaultKind ?? "individual";
      const playerStatsCtx: PlayerStatsFoldCtx = {
        entrants: [
          { id: lineups.home.entrantId, kind: entrantKind },
          { id: lineups.away.entrantId, kind: entrantKind },
        ],
        personsOf: (entrantId) => {
          if (entrantId === lineups.home.entrantId) {
            return lineups.home.slots.map((s) => s.personId);
          }
          if (entrantId === lineups.away.entrantId) {
            return lineups.away.slots.map((s) => s.personId);
          }
          return [];
        },
        // Several `folded.fold` implementations (setbased/nested's match/set
        // replay) parse THIS as the module's own cfg to detect set/game
        // boundaries — carrying the already-parsed cfg is what makes that
        // replay reachable instead of degrading quietly.
        cfg,
      };
      // Cheap, pure, synchronous folds — but a couple of the invariants
      // below call aggregatePlayerStats 2-3× per property run, so cap runs
      // modestly rather than multiply every call site's already-tuned
      // `numRuns` outright.
      const statsRuns = Math.min(numRuns, 60);

      it("playerStats: aggregating a generated stream never throws and is deterministic", () => {
        fc.assert(
          fc.property(streamArb, (events) => {
            const first = aggregatePlayerStats(events, playerStats, lineups, playerStatsCtx);
            const second = aggregatePlayerStats(events, playerStats, lineups, playerStatsCtx);
            expect(second).toEqual(first);
          }),
          { numRuns: statsRuns },
        );
      });

      // playerStatsKeyCollisions only ever catches an UNDECLARED clash
      // between `folded.keys` and `metrics[].key`. Cricket's fold writes
      // into `runs`/`balls_faced`/`balls_bowled`/`runs_conceded`/`wickets`/
      // `dismissals` — keys its OWN `metrics[]` already own — while
      // declaring `folded.keys: []` on purpose: a gated, tested coarse/fine
      // merge (fine ball-by-ball data wins; the coarse `cricket.player.line`
      // path only fills a (person, aspect) pair the fine stream never
      // mentions), not an accidental clash. Asserting the checker's own
      // output is still the right check for every module, cricket included
      // — do NOT strengthen this into "every key a fold emits must appear
      // in folded.keys", which would red cricket for a decision this
      // programme already made on purpose.
      it("playerStats: declared folded keys never collide with metric keys", () => {
        expect(playerStatsKeyCollisions(playerStats)).toEqual([]);
      });

      it("playerStats: voiding a counted event never raises count-shaped totals; a fully-voided stream matches the empty-stream baseline", () => {
        // Restricted to count-shaped metric keys: agg:"count" metrics and
        // core.award both bump by a fixed +1 for a MATCHING, PRESENT event,
        // so removing one event can only lower or hold them — structurally,
        // not just empirically. Two things are excluded on purpose, both
        // found by running this property, not guessed up front:
        //  - A signed agg:"sum" key: generic's "points" can legally record a
        //    NEGATIVE correction (`generic.score` "correct (subtract)"), so
        //    voiding a deduction legitimately RAISES the total.
        //  - Every `folded.keys` entry: a fold MAY recompute its fact from
        //    the CURRENT event list rather than accumulate it (generic's
        //    "wins" replays the score tally and compares — voiding a
        //    scoring event for the trailing side can flip a draw into a
        //    win; football/hockey/icehockey's "clean_sheets" is the
        //    ABSENCE of a goal-against within a keeper spell, so voiding
        //    the goal that broke it creates a clean sheet that was not
        //    there before). Both are correct, documented behaviour of those
        //    folds, not defects — see this suite's other playerStats
        //    invariants for what folded.fold IS held to.
        const monotoneOnVoidKeys = new Set<string>([
          ...playerStats.metrics.filter((m) => m.agg === "count").map((m) => m.key),
          ...(playerStats.awards ?? []).map((a) => `${a.key}_awards`),
        ]);
        // Several folds emit an explicit zero-baseline row for the fixture's
        // own roster even on ZERO events (setbased/nested's "sets_won: 0,
        // sets_lost: 0" for the two entrants currently on court) — a real,
        // deliberate design, not the silent-0 defect `PlayerStatMetric.
        // value`'s docstring warns about elsewhere. "Fully voided" is
        // therefore proved against THIS baseline, not a hardcoded `[]`.
        const emptyBaseline = aggregatePlayerStats([], playerStats, lineups, playerStatsCtx);
        fc.assert(
          fc.property(streamArb, fc.nat(), (events, pick) => {
            if (events.length === 0) return;
            const before = aggregatePlayerStats(events, playerStats, lineups, playerStatsCtx);
            const beforeByPerson = new Map(before.map((r) => [r.personId, r.stats]));
            const target = events[pick % events.length]!;
            const partialVoid = makeEnvelope(events.length, { type: "core.void", payload: {} }, target.id);
            const partial = aggregatePlayerStats(
              [...events, partialVoid],
              playerStats,
              lineups,
              playerStatsCtx,
            );
            for (const row of partial) {
              const prior = beforeByPerson.get(row.personId) ?? {};
              for (const [key, value] of Object.entries(row.stats)) {
                if (!monotoneOnVoidKeys.has(key)) continue;
                expect(
                  value,
                  `person ${row.personId} key "${key}" rose after voiding one event`,
                ).toBeLessThanOrEqual(prior[key] ?? 0);
              }
            }

            const allVoided = [
              ...events,
              ...events.map((e, i) =>
                makeEnvelope(events.length + i, { type: "core.void", payload: {} }, e.id),
              ),
            ];
            expect(aggregatePlayerStats(allVoided, playerStats, lineups, playerStatsCtx)).toEqual(
              emptyBaseline,
            );
          }),
          { numRuns: statsRuns },
        );
      });

      it("playerStats: entrant-fallback attribution requires ctx and only ever adds coverage (mixed v1/v2 streams)", () => {
        fc.assert(
          fc.property(streamArb, (events) => {
            if (events.length === 0) return;
            const withCtx = aggregatePlayerStatsWithDiagnostics(events, playerStats, lineups, playerStatsCtx);
            const withoutCtx = aggregatePlayerStatsWithDiagnostics(events, playerStats, lineups, undefined);
            // Structurally unreachable without ctx (resolveMetricPersons
            // returns early whenever ctx is undefined).
            expect(withoutCtx.diagnostics.fromEntrantFallback).toBe(0);
            const priorByPerson = new Map(withoutCtx.rows.map((r) => [r.personId, r.stats]));
            for (const row of withCtx.rows) {
              const prior = priorByPerson.get(row.personId) ?? {};
              for (const [key, value] of Object.entries(row.stats)) {
                expect(
                  value,
                  `person ${row.personId} key "${key}" dropped when ctx was supplied`,
                ).toBeGreaterThanOrEqual(prior[key] ?? 0);
              }
            }
          }),
          { numRuns: statsRuns },
        );
      });

      // The sharpest half of "mixed streams don't double-count": one
      // synthetic event naming BOTH the explicit field AND the entrant
      // field must credit the metric's key exactly ONCE — the explicit
      // person — never a second time via the fallback. Built directly off
      // the module's own metric declarations, never a re-derivation of
      // resolveMetricPersons, so it only runs for metrics that actually
      // declare this shape (setbased/nested's `points_won`, boardgame's
      // `wins`); carrom's `boards_won` has no explicit `field` at all by
      // design and is correctly excluded.
      const entrantFallbackMetrics = playerStats.metrics.filter(
        (m): m is PlayerStatMetric & { field: string; entrantField: string } =>
          m.fromEntrant === true &&
          m.agg === "count" &&
          m.when === undefined &&
          m.field !== undefined &&
          m.entrantField !== undefined,
      );
      if (entrantFallbackMetrics.length > 0) {
        it("playerStats: an explicit field beats the entrant fallback — one event, one credit, not two", () => {
          const entrantId = lineups.home.entrantId;
          const roster = lineups.home.slots.map((s) => s.personId);
          const explicitPerson = roster[0];
          if (explicitPerson === undefined) return; // no roster to attribute to
          for (const metric of entrantFallbackMetrics) {
            const payload: Record<string, unknown> = {};
            setAtPath(payload, metric.field, explicitPerson);
            setAtPath(payload, metric.entrantField, entrantId);
            const event = makeEnvelope(0, { type: metric.from, payload });
            const rows = aggregatePlayerStats([event], playerStats, lineups, playerStatsCtx);
            const explicitRow = rows.find((r) => r.personId === explicitPerson);
            expect(explicitRow?.stats[metric.key], `metric "${metric.key}"`).toBe(1);
            for (const other of roster.slice(1)) {
              const otherRow = rows.find((r) => r.personId === other);
              expect(
                otherRow?.stats[metric.key],
                `metric "${metric.key}" leaked credit to ${other}`,
              ).toBeUndefined();
            }
          }
        });
      }

      it("playerStats: rows are well-formed — non-empty personId, finite stat values", () => {
        fc.assert(
          fc.property(streamArb, (events) => {
            for (const row of aggregatePlayerStats(events, playerStats, lineups, playerStatsCtx)) {
              expect(row.personId.length).toBeGreaterThan(0);
              for (const [key, value] of Object.entries(row.stats)) {
                expect(
                  Number.isFinite(value),
                  `person ${row.personId} key "${key}" = ${value}`,
                ).toBe(true);
              }
            }
          }),
          { numRuns: statsRuns },
        );
      });
    }
  });
}
