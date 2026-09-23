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
import type { SportModule } from "../sport/module.ts";
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
      // W1 (scoring free): fidelity is the single model, read off PadSpec.
      // `cfg` above is already parsed, so no second `configSchema.parse` is
      // needed here.
      const spec = module.padSpec?.(cfg);
      expect(spec, "every module declares a padSpec").toBeDefined();
      expect(Object.keys(spec!.fidelity).length).toBeGreaterThan(0);
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

    // §9.3b — each SIDE's points sit inside matchPointsBounds; a win pays at
    // least winFloor, a loss at most lossCeil (standings qualification, spec
    // 2026-09-22 §3.1). This is what makes "Win and in" never wrong. Where the
    // bounds claim `winsOnly`, every side pays exactly winFloor × won.
    it("§9.3b standingsDelta stays inside matchPointsBounds", () => {
      const b = module.matchPointsBounds(cfg);
      expect(b.min).toBeLessThanOrEqual(b.max);
      // Counts decided pairs actually CHECKED, not decided streams: a draw
      // skipped in every ctx proves nothing. This `it` draws its own streams
      // (no shared fc seed with §9.3), so §9.3's guard does not cover it.
      let decidedSeen = 0;
      fc.assert(
        fc.property(streamArb, (events) => {
          const decided = decidedOnly(events);
          if (!decided) return;
          for (const ctx of stageCtxs) {
            if (decided.outcome.kind === "draw" && !module.supportsDraws(cfg, ctx.kind)) continue;
            const pair = module.standingsDelta(decided.outcome, cfg, ctx, decided.state);
            decidedSeen++;
            for (const d of pair) {
              expect(d.points).toBeGreaterThanOrEqual(b.min);
              expect(d.points).toBeLessThanOrEqual(b.max);
              if (d.won === 1) expect(d.points).toBeGreaterThanOrEqual(b.winFloor);
              if (d.lost === 1) expect(d.points).toBeLessThanOrEqual(b.lossCeil);
              // `winsOnly` claims points = winFloor × won on EVERY outcome —
              // the fact that lets the standings what-if skip `wins` (spec
              // 2026-09-22 §3.4, OQ1). A paying draw, OT or bonus breaks it.
              if (b.winsOnly) expect(d.points).toBe(d.won * b.winFloor);
            }
          }
        }),
        { numRuns },
      );
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
      // between `folded.keys` and `metrics[].key` (S8/#417 W6 fix 1).
      // Cricket's fold writes into `runs`/`balls_faced`/`balls_bowled`/
      // `runs_conceded`/`wickets`/`dismissals` — keys its OWN `metrics[]`
      // already own — and declares BOTH `folded.keys` (honestly, all six)
      // AND `folded.sharesMetricKeys` (the same six) to mark the overlap as
      // intentional: a gated, tested coarse/fine merge (fine ball-by-ball
      // data wins; the coarse `cricket.player.line` path only fills a
      // (person, aspect) pair the fine stream never mentions), not an
      // accidental clash. Asserting the checker's own output is still the
      // right check for every module, cricket included — do NOT strengthen
      // this into "every key a fold emits must appear in folded.keys with no
      // exemption", which would red cricket for a decision this programme
      // already made on purpose; see cricket.playerstats.test.ts's
      // "playerStatsKeyCollisions" block for the test proving the checker
      // still catches a genuinely UNDECLARED collision on cricket's own
      // shape (a metric added without a matching `sharesMetricKeys` entry).
      it("playerStats: declared folded keys never collide with metric keys", () => {
        expect(playerStatsKeyCollisions(playerStats)).toEqual([]);
      });

      // S8/#417 W6 review round 3 — playerStatsKeyCollisions (above) can only
      // ever compare two DECLARATIONS (`folded.keys` vs `metrics[].key`); it
      // never observes what `folded.fold` actually writes. That leaves two
      // ways a model can defeat it without the checker ever seeing it:
      //  1. UNDER-declare `keys` — write a column at runtime that is absent
      //     from `keys`, exactly how a real accidental collision would
      //     escape both this test AND playerStatsKeyCollisions (an
      //     undeclared key is invisible to that checker, not caught by it).
      //  2. OVER-declare `sharesMetricKeys` — name a key as an intentional
      //     overlap the fold never actually writes, or that no `metrics[]`
      //     entry actually owns — a stale entry that permanently silences a
      //     genuine future collision on that key.
      // Closed HERE, against the SAME generated streams/ctx the rest of this
      // block already builds (never a second, parallel harness): real fold
      // output only exists inside conformance, which is why this could not
      // be closed inside stats.ts's static checker itself.
      if (playerStats.folded) {
        const folded = playerStats.folded;
        const declaredFoldedKeys = new Set(folded.keys.map((k) => k.key));
        const metricKeys = new Set(playerStats.metrics.map((m) => m.key));
        const sharesMetricKeys = folded.sharesMetricKeys ?? [];

        // Modules whose `folded.fold` is STRUCTURALLY unable to emit
        // anything against this suite's generated `streamArb`/ctx — named
        // and reasoned so a future silently-empty fold can never hide
        // behind an unstated default (the exact vacuous-gate failure mode
        // this repo has shipped more than once: a check that holds only
        // because what it observes was never populated — see
        // reference_declared_stat_model_can_be_inert). Confirmed
        // empirically with a throwaway probe run over every real
        // conformanceSuite call-site variant of every module that declares
        // `folded` (80 seeds each): both modules below emitted zero keys on
        // EVERY run of EVERY variant; every other module emitted on the
        // large majority of runs of every variant.
        const FOLD_MAY_EMIT_NOTHING = new Set<string>([
          // cricket's coarse rescue only bumps a key when a
          // `cricket.player.line` names a (person, innings, aspect) NOT
          // already covered by fine `cricket.ball` data (see `folded`'s own
          // comment above `CRICKET_PLAYER_STATS`, cricket.ts). This suite's
          // `arbitraryEvent` generator only ever emits a player-line
          // DERIVED FROM an already-recorded fine innings
          // (`generatePlayerLine` requires `innings.fine !== null` and
          // reads the person straight out of that fine ledger), so the
          // coarse branch is structurally unreachable from a generated
          // stream — `hasFineCoverage` is always true for the exact
          // (person, innings) pair the generator can produce. Not a gap in
          // cricket's declaration: `cricket.playerstats.test.ts`'s "a
          // v1-era cricket.player.line-only stream produces the SAME stat
          // keys the fine ball ledger would" hand-builds the coarse-only
          // stream this property generator structurally cannot, and proves
          // all six `sharesMetricKeys` entries really are emitted there.
          // Reusing that setup here would be exactly the parallel harness
          // this check must not invent.
          "cricket",
          // volleyball's default (and only conformance-tested) entrant kind
          // is "team" (`entrantModel.defaultKind`). `setBasedMatchOutcomes-
          // Fold`'s person-level credit (`matches`/`sets_won`/`sets_lost`)
          // goes exclusively through `personsForEntrant`, which returns
          // `[]` for every "team"-kind entrant BY DESIGN — the identical
          // guard `resolveMetricPersons` applies everywhere else in this
          // file (see `personsForEntrant`'s own doc comment, stats.ts). Not
          // a bug to route around: badminton and table tennis, the
          // kernel's other two presets, default to "individual" and are
          // correctly NOT exempt.
          "volleyball",
        ]);
        const foldMayEmitNothing = FOLD_MAY_EMIT_NOTHING.has(module.key);

        it("playerStats: folded.fold never writes a key absent from folded.keys, and sharesMetricKeys stays honest", () => {
          const emitted = new Set<string>();
          fc.assert(
            fc.property(streamArb, (events) => {
              const active = resolveVoids([...events]);
              const foldedOut = folded.fold(active, playerStatsCtx, lineups);
              for (const row of foldedOut) {
                for (const key of Object.keys(row.stats)) {
                  emitted.add(key);
                  // (a) emitted ⊆ declared — the check that makes
                  // playerStatsKeyCollisions trustworthy: a key the fold
                  // writes at runtime but that `folded.keys` never declares
                  // is invisible to that checker, not caught by it.
                  expect(
                    declaredFoldedKeys.has(key),
                    `${module.key}: folded.fold wrote key "${key}" that folded.keys does not declare`,
                  ).toBe(true);
                }
              }
            }),
            { numRuns: statsRuns },
          );

          // Vacuity guard (see FOLD_MAY_EMIT_NOTHING above) — without this,
          // a module whose fold emits nothing for every generated stream
          // would make the assertion above, and both sharesMetricKeys
          // assertions below, pass having proved nothing at all.
          if (!foldMayEmitNothing) {
            expect(
              emitted.size,
              `${module.key}: folded.fold emitted NO keys across ${statsRuns} generated streams — the emitted-keys-subset-of-declared check above is vacuous for this module`,
            ).toBeGreaterThan(0);
          }

          // (b) sharesMetricKeys is honest: every entry must be BOTH (i)
          // actually emitted by the fold on a real stream and (ii) actually
          // owned by a metrics[] entry — an entry failing either is a stale
          // declaration that permanently silences a real future collision
          // on that key (see playerStatsKeyCollisions's own doc comment).
          // (ii) is a static check that always runs; (i) is skipped only
          // for the named exemptions above, whose own dedicated test file
          // supplies the real proof this harness structurally cannot.
          for (const key of sharesMetricKeys) {
            expect(
              metricKeys.has(key),
              `${module.key}: sharesMetricKeys names "${key}" but no metrics[] entry owns that key`,
            ).toBe(true);
            if (!foldMayEmitNothing) {
              expect(
                emitted.has(key),
                `${module.key}: sharesMetricKeys names "${key}" but folded.fold never emitted it across ${statsRuns} generated streams — a stale declaration silencing a real collision`,
              ).toBe(true);
            }
          }
        });
      }

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
