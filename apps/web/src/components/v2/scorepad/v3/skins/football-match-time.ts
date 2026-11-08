// Football's MATCH TIME (S2-5 ruling 108, design §7.4).
//
// The engine and the wire count `at.elapsed` in seconds WITHIN a period, and
// every other sport's clock shows exactly that (`formatClock`). Football reads
// time from kick-off instead: the second half starts at 45:00, extra time at
// 90:00, each quarter at the sum of the ones before. Only the DISPLAY adds the
// earlier periods' lengths; nothing here touches a stamp.
//
// Past a period's nominal end the clock reads the time PASSED in added time —
// `90+2:30` at 92:30 (ruling 109, owner, 2026-11-08: "A"). An event's minute
// LABEL is a different thing (the minute being played, `90+3'` for the same
// moment) and is not built here.
//
// THE PERIOD TABLE MIRRORS THE ENGINE, because the engine does not export it:
// `phaseLengths` and `clockPhases` in `@seazn/engine/sports/football` are
// module-private (F8's rule). Period order is `H1, H2`, or `H1, Q2, Q3, Q4` at
// `halves: 4`, then `ET_H1, ET_H2` with extra time. A period's nominal length
// is `halfMinutes` (or `extraTime.halfMinutes`), overridden per period by
// `periodSeconds` ONLY when the group's values are unequal — a uniform map
// says nothing the scalar does not, and the engine ignores it. The vectors in
// `__tests__/football-match-time.test.ts` pin every arm, and the phone mirrors
// the same vectors.
//
// THIS FILE IMPORTS NO ENGINE MODULE (S2-5 final review I1). The OBS overlay's
// clock (`components/overlay/use-overlay-clock.ts`) imports `matchClock` from
// here, so anything imported here ships in every sport's overlay bundle. The
// cfg parse, which needs the engine's `FootballCfg`, lives in
// `football-match-time-cfg.ts`, read by the pad's skin and the server's
// projection only; the overlay gets the parsed numbers on the wire.
// `components/overlay/__tests__/overlay-client-engine-imports.test.ts` holds it.
import { formatClock, type GameTimeStamp } from "../clock";

/** The cfg fields match time reads — a structural subset of `FootballCfg`. */
export interface MatchTimeCfg {
  readonly halves: 2 | 4;
  readonly halfMinutes: number;
  readonly extraTime: { readonly enabled: boolean; readonly halfMinutes: number };
  readonly periodSeconds?: Readonly<Record<string, number>>;
}

interface PeriodSpan {
  readonly label: string;
  readonly start: number;
  readonly length: number;
}

/** Every clock period this cfg can reach, in order, with its start (seconds
 *  from kick-off) and nominal length. */
function periodTable(cfg: MatchTimeCfg): PeriodSpan[] {
  const regulation = cfg.halves === 4 ? ["H1", "Q2", "Q3", "Q4"] : ["H1", "H2"];
  const groups: [labels: string[], seconds: number][] = [[regulation, cfg.halfMinutes * 60]];
  if (cfg.extraTime.enabled) groups.push([["ET_H1", "ET_H2"], cfg.extraTime.halfMinutes * 60]);
  const table: PeriodSpan[] = [];
  let start = 0;
  for (const [labels, seconds] of groups) {
    for (const [label, length] of groupLengths(labels, seconds, cfg.periodSeconds)) {
      table.push({ label, start, length });
      start += length;
    }
  }
  return table;
}

/** The clock periods this cfg can reach, in match order (S2-5 ruling 110: the viewers' overlay shows a football clock
 *  only in one of them, and reads a new one as starting from its own start). */
export function clockPeriodsOf(cfg: MatchTimeCfg): string[] {
  return periodTable(cfg).map((period) => period.label);
}

/** One group's lengths: the scalar, unless `periodSeconds` gives the group
 *  UNEQUAL values — then each period it names takes its own. */
function groupLengths(
  labels: readonly string[],
  seconds: number,
  overrides: Readonly<Record<string, number>> | undefined,
): [string, number][] {
  const supplied = labels.map((label) => overrides?.[label]);
  const uniform = supplied.every((value) => value !== undefined && value === supplied[0]);
  return labels.map((label, i) => [label, uniform ? seconds : (supplied[i] ?? seconds)]);
}

/**
 * The clock face for `at`: `M:SS` from kick-off while the period is within
 * its nominal length, `<end minute>+M:SS` past it. A period this cfg does not
 * know reads as `formatClock` would. A negative or non-finite `elapsed` reads
 * as the period's own start.
 */
export function matchClock(at: GameTimeStamp, cfg: MatchTimeCfg): string {
  const elapsed = Number.isFinite(at.elapsed) && at.elapsed > 0 ? Math.floor(at.elapsed) : 0;
  const span = periodTable(cfg).find((period) => period.label === at.period);
  if (span === undefined) return formatClock(elapsed);
  if (elapsed <= span.length) return formatClock(span.start + elapsed);
  return `${Math.floor((span.start + span.length) / 60)}+${formatClock(elapsed - span.length)}`;
}
