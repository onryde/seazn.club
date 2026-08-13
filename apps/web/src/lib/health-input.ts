// The DB/wire-shape -> HealthFixture[] adapter (D3), CLIENT-SAFE on purpose:
// the health panel imports this directly for its own display shaping, and
// the server-only usecase (schedule-health.ts) re-exports the very same
// function rather than holding a second copy — same split capacity-input.ts
// / capacity-guard.ts use, for the same reason (see that file's header: a
// second implementation of "how a DB row becomes an engine input" is
// exactly the placer/verifier fork this codebase keeps naming as its
// recurring defect).
//
// Deliberately does NOT import `@seazn/engine/scheduling` (the barrel) or
// any non-leaf module: that barrel is server-only (scheduling/index.ts's
// header) and a `"use client"` file that reaches it ships z3-solver/@grpc
// into the browser bundle. Only two engine imports are used here, both
// declared LEAVES in package.json: `./scheduling/health` (this feature's
// own pure lib — imports NOTHING itself) and `./scheduling/tz` (zero
// dependencies), for the exact same reason capacity-input.ts uses them.
import { dayKeyInTz } from "@seazn/engine/scheduling/tz";
import type { HealthFixture } from "@seazn/engine/scheduling/health";

/** One fixture as loaded from the DB (or from a client component's own
 *  local board state) — plain epoch-ms, no engine types leaked in. */
export interface HealthFixtureInput {
  fixtureId: string;
  scheduledAtMs: number;
  court: string;
  home?: string;
  away?: string;
  roundNo?: number;
  poolId?: string;
  divisionId?: string;
}

/**
 * Build the pure lib's fixture list from DB-shaped rows + the resolved
 * schedule config's matchMinutes and the ORG's governing clock (never
 * `settings.tz`, the display lane — #448's trap, same rule capacity-input.ts
 * follows). `dayKey` is computed HERE, once, in the caller-facing adapter —
 * health.ts itself takes no tz import at all (leafer even than
 * capacity.ts), so this is the one place that math happens.
 */
export function healthFixturesFor(
  fixtures: readonly HealthFixtureInput[],
  matchMinutes: number,
  orgTz: string,
): HealthFixture[] {
  return fixtures.map((f) => ({
    fixtureId: f.fixtureId,
    court: f.court,
    start: f.scheduledAtMs,
    end: f.scheduledAtMs + matchMinutes * 60_000,
    dayKey: dayKeyInTz(f.scheduledAtMs, orgTz),
    ...(f.home !== undefined ? { home: f.home } : {}),
    ...(f.away !== undefined ? { away: f.away } : {}),
    ...(f.roundNo !== undefined ? { roundNo: f.roundNo } : {}),
    ...(f.poolId !== undefined ? { poolId: f.poolId } : {}),
    ...(f.divisionId !== undefined ? { divisionId: f.divisionId } : {}),
  }));
}
