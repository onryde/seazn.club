// Capture QR v2 PR-2 (spec §7.4 the phone-health line; W8, W9; FP14, FP21). Pure. ONE derivation: the panel's amber reason
// and the beat history's `flags` (§6.10) read the same four predicates, so the two cannot disagree. The thresholds are
// config.ts's `LOW_BATTERY_PERCENT` and `HOT_THERMAL_STATUS` (W9; not tunable).
//
// A null `battery`, `thermal` or `delivery` contributes nothing (FP14): the app sends battery and thermal only from Armed,
// and a delivery reading only once it has one — absence is "no reading", never zero and never a problem.
import { HOT_THERMAL_STATUS, LOW_BATTERY_PERCENT } from "../config";

/** §7.4's amber reasons in PRIORITY order: not responding, stalled, hot, battery low. W8: silence only warns. */
export const HEALTH_REASONS = ["not_responding", "stalled", "hot", "battery_low"] as const;
export type HealthReason = (typeof HEALTH_REASONS)[number];

export type HealthInput = {
  /** §6.9 (W8): held, with no beat for NOT_RESPONDING_BEATS answered cadences. */
  notResponding: boolean;
  delivery: "ok" | "stalled" | "unknown" | null;
  thermal: number | null;
  battery: { percent: number; charging: boolean } | null;
};

/** Each reason's own condition. `Record<HealthReason, …>` makes a new reason a tsc error until it has one. */
const APPLIES: Record<HealthReason, (i: HealthInput) => boolean> = {
  not_responding: (i) => i.notResponding,
  stalled: (i) => i.delivery === "stalled",
  hot: (i) => i.thermal !== null && i.thermal >= HOT_THERMAL_STATUS,
  battery_low: (i) => i.battery !== null && i.battery.percent < LOW_BATTERY_PERCENT && !i.battery.charging,
};

/** The amber reason the panel shows: the FIRST reason in priority order that applies, else null. */
export function phoneHealthOf(i: HealthInput): HealthReason | null {
  return HEALTH_REASONS.find((r) => APPLIES[r](i)) ?? null;
}

/** §6.10's history flags, in the order `capture-phone.ts` has always written them (battery_low, hot, stalled, not_ready,
 *  not_responding). `not_ready` is a flag only: it is never an amber reason (it has its own line, with a debounce, FP16). */
const FLAG_ORDER = ["battery_low", "hot", "stalled", "not_ready", "not_responding"] as const;

export function phoneFlagsOf(i: HealthInput & { notReady: boolean }): string[] {
  return FLAG_ORDER.filter((flag) => (flag === "not_ready" ? i.notReady : APPLIES[flag](i)));
}
