// The DB/wire-shape -> CapacityInput adapter (D2), CLIENT-SAFE on purpose:
// the setup card imports this directly (design doc: "client-side import of
// the engine lib — no network"), and `capacity-guard.ts` (the server-only
// 422 authority) re-exports the very same function rather than holding a
// second copy — see that file's header for why a second implementation of
// "which days/courts/entrants" would be exactly the placer/verifier fork
// this codebase keeps naming as its recurring defect.
//
// Deliberately does NOT import `@seazn/engine/scheduling` (the barrel) or
// any of its non-leaf modules (`calendar.ts`, `repair-domain.ts`): that
// barrel is server-only (see scheduling/index.ts's header) and a `"use
// client"` file that reaches it ships z3-solver/@grpc into the browser
// bundle — `bracket-panel.tsx`/`slideshow.tsx` did exactly this and broke
// the production build until Task 11 found it. Only two engine imports are
// used here, both declared LEAVES in package.json: `./scheduling/capacity`
// (this feature's own pure lib) and `./scheduling/tz` (zero dependencies).
// `HardConstraint` is a TYPE-ONLY import from the barrel, erased at build
// time — it costs the bundle nothing regardless of source.
import { dayKeyInTz, ymdAddDays, zonedTimeToUtc } from "@seazn/engine/scheduling/tz";
import type {
  CapacityDay,
  CapacityEntrant,
  CapacityInput,
  CapacityWindow,
} from "@seazn/engine/scheduling/capacity";
import type { HardConstraint } from "@seazn/engine/scheduling";

/** Everything `capacityInputForFixtures` reads off a solved config. Plain
 *  epoch-ms/string fields — the same shape `SlotConfig & VerifyConfig`
 *  satisfies server-side (schedule.ts's plan), and the shape a client
 *  component builds from its own live form state (see capacity-card.tsx). */
export interface CapacityConfigInput {
  courts: string[];
  sessionWindows?: readonly { from: number; to: number }[];
  blackouts?: readonly { court?: string; from: number; to: number }[];
  matchMinutes: number;
  gapMinutes: number;
  perEntrantMinRest: number;
  window?: { from: number; to: number };
  tz?: string;
  constraints?: {
    restMin?: number;
    restByGroup?: Record<string, number>;
    noBackToBack?: boolean;
    /** Durable division rules (#398) — day caps this feature reads. Present
     *  on the server's `SlotConfig & VerifyConfig`; the setup card's
     *  `BoardConfig` carries no `hard` field at all (see capacity-card.tsx),
     *  so the CLIENT precheck never sees a day cap and can under-call
     *  "impossible" for a cap-only case. That's fine — "client hint, server
     *  authority" (design doc): the server guard always has this and is the
     *  422 gate that actually blocks Solve. */
    hard?: readonly HardConstraint[];
  };
  /** Compiled-instruction hard rules (`VerifyConfig.hard`) — merged with
   *  `constraints.hard` exactly as `effectiveHard` (calendar.ts) does,
   *  reimplemented inline rather than imported (see dayCapFor's comment). */
  hard?: readonly HardConstraint[];
}

export interface CapacityFixtureInput {
  home?: string | undefined;
  away?: string | undefined;
  poolId?: string | undefined;
}

/** The calendar days a window covers, in `tz`, UNPADDED (unlike the
 *  solver's own `calendarDaysCovering`, which widens by a day on each side
 *  for lattice purposes this precheck has no use for). Built directly off
 *  the `tz.ts` leaf rather than importing the solver's version, which lives
 *  in `repair-domain.ts` — not a leaf. */
function calendarDays(window: { from: number; to: number }, tz: string): { ymd: string; from: number; to: number }[] {
  const out: { ymd: string; from: number; to: number }[] = [];
  let cursor = zonedTimeToUtc(dayKeyInTz(window.from, tz), "00:00", tz);
  while (cursor < window.to && out.length < 4000) {
    const ymd = dayKeyInTz(cursor, tz);
    const next = zonedTimeToUtc(ymdAddDays(ymd, 1), "00:00", tz);
    if (next <= cursor) break;
    // CLIPPED to the window, not just filtered by it: a sub-day window (the
    // tournament runs 09:00-17:00 on its only day) is one real day with a
    // shorter usable span, not zero days. Excluding the whole day here is
    // exactly the bug a first version of this function had — it silently
    // reported ample supply because the day it should have clipped to 4
    // hours never appeared in `days` at all.
    const from = Math.max(cursor, window.from);
    const to = Math.min(next, window.to);
    if (to > from) out.push({ ymd, from, to });
    cursor = next;
  }
  return out;
}

/** Subtract every `cut` that overlaps a window from `base`, splitting a
 *  window into up to two pieces per cut. */
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
 *  the placer applies, calendar.ts:310) clipped to the day, minus every
 *  blackout that applies to this court (court-specific or global). */
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
 *  bounds a SUBSET of the day's demand, not the whole day's aggregate;
 *  modelling that precisely needs per-entrant demand splitting this
 *  precheck does not attempt (non-goal: "no soft-constraint prediction —
 *  that's the solver's job"). Multiple applicable rules take the MIN.
 *  `hard`/`constraints.hard` merged inline rather than importing
 *  `effectiveHard` (calendar.ts, not a leaf) — the merge itself is a
 *  two-array concat, not a rule worth a second implementation to avoid. */
function dayCapFor(config: CapacityConfigInput, divisionId: string): number | undefined {
  const hard = [...(config.hard ?? []), ...(config.constraints?.hard ?? [])];
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
  const buckets = calendarDays(window, tz);
  const cap = dayCapFor(config, divisionId);
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
 *  fixture's pool as `groupId` for a `restByGroup` lookup. A TBD side
 *  (home/away undefined) contributes nothing to any entrant's load. */
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
 * an unbounded window (no `endAt`) has no day span to check supply
 * against, and `tz` absent is the same "skip rather than guess UTC" rule
 * every day-shaped rule in the engine package already follows.
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
