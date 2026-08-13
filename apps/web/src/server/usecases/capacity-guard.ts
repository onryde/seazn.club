import "server-only";
// The web-layer adapter for D2's capacity pre-check: converts DB-shaped
// schedule config + fixtures into the pure engine lib's CapacityInput, runs
// it, and is the SERVER's authority — a 422 CAPACITY_IMPOSSIBLE with the
// report attached, following the AI_PLAN_FAILED precedent exactly (a typed
// HttpError code, no widening of EngineErrorCode/ENGINE_HTTP: this throw
// lives in the web layer, the engine lib itself throws nothing).
//
// Deliberately NOT part of the pure engine package: resolving a
// `max_fixtures_per_day` HardConstraint into a flat per-day number, and
// splitting `ScheduleConfig`'s sessionWindows/blackouts into calendar-day,
// per-court usable windows, is DB-adjacent conversion glue — exactly what
// schedule.ts's own header comment describes as this directory's job
// ("the engine stays pure — this module converts DB rows ↔ engine inputs").
import {
  calendarDaysCovering,
  effectiveHard,
  type HardConstraint,
  type SlotConfig,
  type VerifyConfig,
} from "@seazn/engine/scheduling";
import {
  assessCapacity,
  type CapacityDay,
  type CapacityEntrant,
  type CapacityInput,
  type CapacityReport,
  type CapacityWindow,
} from "@seazn/engine/scheduling/capacity";
import { HttpError } from "@/lib/errors";
import { log } from "@/server/logger";

/** Everything `capacityInputForFixtures` reads off a solved config — a
 *  `Pick` so callers with a wider `SlotConfig & VerifyConfig` (schedule.ts's
 *  `AutoSchedulePlan.config`) or a narrower hand-built object (the
 *  competition-scope guard) both satisfy it without a cast. */
export type CapacityConfigInput = Pick<
  SlotConfig & VerifyConfig,
  "courts" | "sessionWindows" | "blackouts" | "matchMinutes" | "gapMinutes" | "perEntrantMinRest" | "window" | "tz" | "constraints" | "hard"
>;

/** The two fields `capacityInputForFixtures` reads off a fixture — matches
 *  both `SchedulableFixture` (the stage guard's plan) and a lighter row the
 *  competition-scope guard can build from a `select home_entrant_id,
 *  away_entrant_id, pool_id`. */
export interface CapacityFixtureInput {
  home?: string | undefined;
  away?: string | undefined;
  poolId?: string | undefined;
}

/** Subtract every `cut` that overlaps a window from `base`, splitting a
 *  window into up to two pieces per cut. Order of `cuts` does not matter —
 *  each is applied to whatever pieces the previous cuts left. */
function subtractIntervals(base: readonly CapacityWindow[], cuts: readonly CapacityWindow[]): CapacityWindow[] {
  let pieces = [...base];
  for (const cut of cuts) {
    const next: CapacityWindow[] = [];
    for (const p of pieces) {
      if (cut.to <= p.from || cut.from >= p.to) {
        next.push(p);
        continue;
      }
      if (cut.from > p.from) next.push({ from: p.from, to: Math.min(cut.from, p.to) });
      if (cut.to < p.to) next.push({ from: Math.max(cut.to, p.from), to: p.to });
    }
    pieces = next;
  }
  return pieces.filter((p) => p.to > p.from);
}

/** A day's usable windows for ONE court: sessionWindows (or, when none are
 *  declared, the whole calendar day — the same "empty = unrestricted" rule
 *  `usableWindows`/the placer already apply, see calendar.ts:310) clipped to
 *  the day, minus every blackout that applies to this court (court-specific
 *  or global). */
function usableWindowsFor(
  court: string,
  dayFrom: number,
  dayTo: number,
  sessionWindows: readonly { from: number; to: number }[],
  blackouts: readonly { court?: string; from: number; to: number }[],
): CapacityWindow[] {
  const base: CapacityWindow[] =
    sessionWindows.length > 0
      ? sessionWindows
          .map((w) => ({ from: Math.max(w.from, dayFrom), to: Math.min(w.to, dayTo) }))
          .filter((w) => w.to > w.from)
      : [{ from: dayFrom, to: dayTo }];
  const applicable = blackouts.filter((b) => b.court === undefined || b.court === court);
  return subtractIntervals(base, applicable);
}

/** The flat per-day fixture-count ceiling from `max_fixtures_per_day` hard
 *  rules — v1 scope: competition-scoped (binds everyone) and this
 *  DIVISION's own division-scoped rule. A pool/entrant/person-scoped cap
 *  bounds a SUBSET of the day's demand, not the whole day's aggregate, and
 *  modelling that precisely needs per-entrant demand splitting this
 *  precheck does not attempt (non-goal: "no soft-constraint prediction —
 *  that's the solver's job"). Multiple applicable rules take the MIN, since
 *  every one of them must hold at once. Undefined when none apply — the
 *  pure lib then defaults the day's ceiling to the total fixture count
 *  (unconstrained by rules, still bounded by the day's own court supply). */
function dayCapFor(hard: readonly HardConstraint[], divisionId: string): number | undefined {
  let cap: number | undefined;
  for (const h of hard) {
    if (h.type !== "max_fixtures_per_day") continue;
    const applies = h.scope.kind === "competition" || (h.scope.kind === "division" && h.scope.divisionId === divisionId);
    if (!applies) continue;
    cap = cap === undefined ? h.count : Math.min(cap, h.count);
  }
  return cap;
}

function capacityDays(config: CapacityConfigInput, divisionId: string): CapacityDay[] {
  const window = config.window!;
  const tz = config.tz!;
  // calendarDaysCovering pads one day on each side (repair-domain.ts) for
  // the solver's own use — trimmed here to exactly the days inside the
  // organiser's configured span, which `applyWindow` already day-aligns.
  const buckets = calendarDaysCovering(window, tz).filter((b) => b.from >= window.from && b.to <= window.to);
  const hard = effectiveHard(config);
  const cap = dayCapFor(hard, divisionId);
  const sessionWindows = config.sessionWindows ?? [];
  const blackouts = config.blackouts ?? [];
  return buckets.map((b) => ({
    date: b.ymd,
    courts: config.courts.map((court) => ({
      court,
      windows: usableWindowsFor(court, b.from, b.to, sessionWindows, blackouts),
    })),
    ...(cap !== undefined ? { demandCap: cap } : {}),
  }));
}

/** Per-entrant participation counts (k_e) off the fixture list, with the
 *  fixture's pool as `groupId` for a `restByGroup` lookup — the same field
 *  `SchedulableFixture`/`Assignment` stamp for the placer/verifier to
 *  resolve pool-scoped rest off (schedule.ts's `toAssignment`/`schedulable`
 *  builders, #446). A TBD side (home/away undefined) contributes nothing to
 *  any entrant's load, matching the placer's own "no rest/overlap checks on
 *  a TBD" rule. */
function capacityEntrants(fixtures: readonly CapacityFixtureInput[]): CapacityEntrant[] {
  const byId = new Map<string, CapacityEntrant>();
  const bump = (id: string | undefined, poolId: string | undefined): void => {
    if (id === undefined) return;
    const existing = byId.get(id);
    if (existing !== undefined) {
      existing.fixtures += 1;
      return;
    }
    byId.set(id, { entrantId: id, fixtures: 1, ...(poolId !== undefined ? { groupId: poolId } : {}) });
  };
  for (const f of fixtures) {
    bump(f.home, f.poolId);
    bump(f.away, f.poolId);
  }
  return [...byId.values()];
}

/**
 * Build the pure lib's input from a division's fixtures + resolved
 * schedule config. Returns `null` when there is nothing useful to assess:
 * an unbounded window (no `endAt`, or one that resolves to +Infinity) has
 * no day span to check supply against — a board that may run forever
 * cannot be arithmetically impossible on courts/days alone, and this
 * precheck does not attempt the solver's own reasoning. `tz` absent is the
 * same "skip rather than guess UTC" rule every day-shaped rule in this
 * package already follows (calendar.ts's `VerifyConfig.tz` doc comment).
 */
export function capacityInputForFixtures(
  fixtures: readonly CapacityFixtureInput[],
  config: CapacityConfigInput,
  divisionId: string,
): CapacityInput | null {
  if (config.window === undefined || !Number.isFinite(config.window.to) || config.tz === undefined) return null;
  return {
    matchMinutes: config.matchMinutes,
    gapMinutes: config.gapMinutes,
    perEntrantMinRest: config.perEntrantMinRest,
    ...(config.constraints !== undefined
      ? {
          constraints: {
            restMin: config.constraints.restMin,
            restByGroup: config.constraints.restByGroup,
            noBackToBack: config.constraints.noBackToBack,
          },
        }
      : {}),
    fixtureCount: fixtures.length,
    days: capacityDays(config, divisionId),
    entrants: capacityEntrants(fixtures),
  };
}

/**
 * The server's authority: re-run `assessCapacity` and refuse with a typed
 * 422 when the verdict is impossible. `input === null` means the caller's
 * config had nothing to assess (see `capacityInputForFixtures`) — passed
 * straight through, nothing logged, nothing thrown.
 *
 * Structured logging (design doc's "pino event capacity_assessed"): fired
 * HERE, the server-side consumer, never inside the pure lib.
 */
export function guardCapacity(
  input: CapacityInput | null,
  context: { scope: "stage" | "competition_division"; divisionId: string; [key: string]: unknown },
): CapacityReport | null {
  if (input === null) return null;
  const report = assessCapacity(input);
  log.info(
    {
      event: "capacity_assessed",
      verdict: report.verdict,
      slotSupply: report.slotSupply,
      slotDemand: report.slotDemand,
      ratio: report.slotDemand > 0 ? report.slotSupply / report.slotDemand : null,
      ...context,
    },
    "capacity_assessed",
  );
  if (report.verdict === "impossible") {
    throw new HttpError(
      422,
      "This schedule cannot fit the configured courts, dates and rest rules",
      "CAPACITY_IMPOSSIBLE",
      { report },
    );
  }
  return report;
}
