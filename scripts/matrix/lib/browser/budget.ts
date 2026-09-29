// Every browser wait in the matrix is derived from the product's own constants
// (AGENTS class 20): a flat timeout beside a derived cost is a latent red.
// browser-budget.test.ts pins each constant to the product's source text, and
// holdMsFromEnv to the product's own resolveHoldMs input by input; it also
// refuses a numeric `timeout:` anywhere in lib/browser, lib/pads and
// browser-driver.ts.
import { TAP_PACING_MS } from "../../../bench/lib/drivers/scorer.ts";

export const HOLD_MS_DEFAULT = 10_000;   // queue.ts HOLD_MS_DEFAULT (text-pinned)
export const MIN_HOLD_MS = 500;         // queue.ts MIN_HOLD_MS (text-pinned; not exported there)
/** Ruling 38: the bench's pacing floor, pinned there to use-pad-pipeline.ts
 *  HUMAN_FASTEST_REPEAT_MS (scorer-driver.test.ts:696-698); a faster same-side
 *  repeat is dropped. Re-exported under one name so every budget reads it. */
export const TAP_PACE_MS: number = TAP_PACING_MS;
export const SLACK_MS = 2_000;          // one round trip plus a render, per step
export const FLOOR_MS = 15_000;         // navigation + first paint on a prod build
/** queue.ts HOLD_MS_ENV_VAR — the build bakes it into the bundle, and the
 *  harness shell must export the same value (global constraints, live runs). */
export const HOLD_ENV = "NEXT_PUBLIC_SCOREPAD_HOLD_MS";

/** A budget input that would make no bound at all (NaN, Infinity) or a
 *  negative one. Playwright reads a timeout of 0 as "wait forever", so a
 *  broken budget must stop here, by name, rather than reach it. */
export class BadBudget extends Error {
  constructor(field: string, value: number) {
    super(`budget: ${field} must be a finite, non-negative number${field === "taps" || field === "holds" ? " (a whole count)" : ""}, got ${value}`);
    this.name = "BadBudget";
  }
}

/** The hold window the build under test was baked with. Mirrors the product's
 *  resolveHoldMs (queue.ts:172-177) rule for rule, in its order: absent or
 *  blank, then non-finite, then below MIN_HOLD_MS, each fall back to the
 *  default; anything else is the parsed number as is (no rounding — the
 *  product does not round). */
export function holdMsFromEnv(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env[HOLD_ENV];
  if (raw === undefined || raw.trim() === "") return HOLD_MS_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < MIN_HOLD_MS) return HOLD_MS_DEFAULT;
  return parsed;
}

/** One wait's budget: a base (a page load), plus each tap at the human pace
 *  plus slack, plus each hold window waited out plus slack — never below
 *  FLOOR_MS. Move a constant and every budget moves with it. */
export function budgetMs(p: { base?: number; taps?: number; holds?: number; holdMs: number }): number {
  const base = p.base ?? 0;
  const taps = p.taps ?? 0;
  const holds = p.holds ?? 0;
  for (const [field, v] of [["base", base], ["holdMs", p.holdMs]] as const) if (!(Number.isFinite(v) && v >= 0)) throw new BadBudget(field, v);
  for (const [field, v] of [["taps", taps], ["holds", holds]] as const) if (!(Number.isInteger(v) && v >= 0)) throw new BadBudget(field, v);
  return Math.max(FLOOR_MS, base + taps * (TAP_PACE_MS + SLACK_MS) + holds * (p.holdMs + SLACK_MS));
}
