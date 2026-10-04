// Browser budgets (AGENTS class 20): every wait in the browser layer is derived
// from the product's own constants, never a flat literal. Expected values come
// from the product — its source text, and its own resolveHoldMs as the oracle
// for holdMsFromEnv — never from budget.ts.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HOLD_MS_DEFAULT as PRODUCT_HOLD_MS_DEFAULT, HOLD_MS_ENV_VAR, resolveHoldMs } from "../../../apps/web/src/components/v2/scorepad/queue.ts";
import { TAP_PACING_MS } from "../../bench/lib/drivers/scorer.ts";
import { BadBudget, FLOOR_MS, HOLD_ENV, HOLD_MS_DEFAULT, MIN_HOLD_MS, SLACK_MS, TAP_PACE_MS, budgetMs, holdMsFromEnv } from "../lib/browser/budget.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const src = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");

/** `10_000`-style or plain digits: the product may write either. */
function fmt(n: number): string {
  const plain = String(n);
  return `(?:${plain.replace(/\B(?=(\d{3})+(?!\d))/g, "_")}|${plain})`;
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Every browser-layer source that exists: the scan grows as later tasks add files. */
function browserSources(): string[] {
  const m = resolve(REPO, "tools/matrix/lib");
  const files = [...walk(join(m, "browser")), ...walk(join(m, "pads"))];
  const driver = join(m, "driver/browser-driver.ts");
  if (existsSync(driver)) files.push(driver);
  return files.map((f) => relative(REPO, f)).sort();
}

/** A flat wait: a numeric `timeout:` option, or a numeric waitForTimeout. */
const FLAT = /\btimeout:\s*\d[\d_]*|\bwaitForTimeout\(\s*\d[\d_]*/g;

describe("browser budgets are the product's constants (class 20)", () => {
  it("the constants are the product's, read from its source (a text pin, never an import)", () => {
    expect(src("apps/web/src/components/v2/scorepad/queue.ts")).toMatch(new RegExp(`HOLD_MS_DEFAULT\\s*=\\s*${fmt(HOLD_MS_DEFAULT)}\\b`));
    expect(src("apps/web/src/components/v2/scorepad/queue.ts")).toMatch(new RegExp(`MIN_HOLD_MS\\s*=\\s*${fmt(MIN_HOLD_MS)}\\b`));
    expect(src("apps/web/src/components/v2/scorepad/use-pad-pipeline.ts")).toMatch(new RegExp(`HUMAN_FASTEST_REPEAT_MS\\s*=\\s*${fmt(TAP_PACE_MS)}\\b`));
  });

  it("the env name is the product's, the default its exported one, and the tap pace the bench's own (ruling 38)", () => {
    expect(HOLD_ENV).toBe(HOLD_MS_ENV_VAR);
    expect(HOLD_MS_DEFAULT).toBe(PRODUCT_HOLD_MS_DEFAULT);
    expect(TAP_PACE_MS).toBe(TAP_PACING_MS);
  });

  it("holdMsFromEnv mirrors resolveHoldMs: unset, blank, non-numeric and below-floor all fall back to the DEFAULT", () => {
    for (const v of [undefined, "", "abc", String(MIN_HOLD_MS - 1)]) expect(holdMsFromEnv({ NEXT_PUBLIC_SCOREPAD_HOLD_MS: v })).toBe(HOLD_MS_DEFAULT);
    expect(holdMsFromEnv({ NEXT_PUBLIC_SCOREPAD_HOLD_MS: "3000" })).toBe(3000);
    // The empty case: no env at all.
    expect(holdMsFromEnv({})).toBe(HOLD_MS_DEFAULT);
  });

  it("holdMsFromEnv answers exactly what the product's own resolveHoldMs answers, input by input", () => {
    // 3000.5 is the witness that a rounding mirror would diverge from the
    // product (resolveHoldMs returns the parsed number as is); " 3000 " and
    // "0x1F4" (500, the floor) that the product's Number() parse is kept.
    const inputs = [undefined, "", "   ", "abc", "NaN", "Infinity", "-1", "0", String(MIN_HOLD_MS - 1), String(MIN_HOLD_MS), "0x1F4", "3000", " 3000 ", "3000.5", "1e4", "60000"];
    const diffs = inputs.filter((v) => !Object.is(holdMsFromEnv({ [HOLD_MS_ENV_VAR]: v }), resolveHoldMs(v))).map((v) => `${JSON.stringify(v)}: ${holdMsFromEnv({ [HOLD_MS_ENV_VAR]: v })} vs product ${resolveHoldMs(v)}`);
    expect(inputs.length).toBe(16);
    expect(diffs).toEqual([]);
    expect(resolveHoldMs("3000.5")).toBe(3000.5);
  });

  it("budgetMs grows with taps and holds, in the constants, never below the floor", () => {
    expect(budgetMs({ holdMs: 3000 })).toBe(FLOOR_MS);
    const a = budgetMs({ taps: 42, holdMs: 3000 });
    expect(a).toBe(Math.max(FLOOR_MS, 42 * (TAP_PACE_MS + SLACK_MS)));
    expect(budgetMs({ taps: 42, holds: 42, holdMs: 10_000 }) - budgetMs({ taps: 42, holds: 42, holdMs: 3000 })).toBe(42 * 7000);
    // A base adds on top; a second call with the same input answers the same.
    expect(budgetMs({ base: FLOOR_MS, taps: 1, holdMs: 3000 })).toBe(FLOOR_MS + TAP_PACE_MS + SLACK_MS);
    expect(budgetMs({ base: FLOOR_MS, taps: 1, holdMs: 3000 })).toBe(budgetMs({ base: FLOOR_MS, taps: 1, holdMs: 3000 }));
  });

  it("budgetMs refuses a count or a duration that is negative, fractional-count or not finite (a NaN budget is no bound at all)", () => {
    const bad: Parameters<typeof budgetMs>[0][] = [
      { holdMs: Number.NaN }, { holdMs: -1 }, { holdMs: Number.POSITIVE_INFINITY },
      { taps: -1, holdMs: 3000 }, { taps: 1.5, holdMs: 3000 }, { holds: Number.NaN, holdMs: 3000 }, { base: -5, holdMs: 3000 },
    ];
    for (const p of bad) expect(() => budgetMs(p), JSON.stringify(p)).toThrow(BadBudget);
    expect(bad.length).toBe(7);
  });

  it("no flat timeout literal in the browser layer: every wait is a budgetMs", () => {
    const flat = browserSources().flatMap((f) => [...src(f).matchAll(FLAT)].map((m) => `${f}: ${m[0]}`));
    expect(browserSources().length).toBeGreaterThan(0);
    expect(flat).toEqual([]);
  });

  it("the flat-wait scan has teeth: it sees a numeric timeout in either spelling, and passes a derived one", () => {
    const hits = (s: string) => [...s.matchAll(FLAT)].length;
    expect(hits("await x.waitFor({ timeout: 5000 });")).toBe(1);
    expect(hits("await x.waitFor({ timeout: 5_000 });")).toBe(1);
    expect(hits("await page.waitForTimeout(250);")).toBe(1);
    expect(hits("await x.waitFor({ timeout: waitMs });")).toBe(0);
    expect(hits("page.waitForResponse(m, { timeout: budget })")).toBe(0);
  });
});
