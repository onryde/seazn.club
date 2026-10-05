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

/** A flat wait: a numeric `timeout:` option, a numeric waitForTimeout, a numeric page-wide default
 *  (setDefaultTimeout / setDefaultNavigationTimeout, W1d item 11), or a hand-rolled sleep with a numeric delay
 *  (`new Promise(r => setTimeout(r, 250))`; the generic and the braced body are optional, as in the layer's own clock). */
const FLAT = /\btimeout:\s*\d[\d_]*|\bwaitForTimeout\(\s*\d[\d_]*|\bsetDefault(?:Navigation)?Timeout\(\s*\d[\d_]*|\bnew Promise(?:<[^>]*>)?\(\s*\(?\w+\)?\s*=>\s*\{?\s*setTimeout\(\s*\w+,\s*\d[\d_]*/g;

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
    const sources = browserSources();
    const flat = sources.flatMap((f) => [...src(f).matchAll(FLAT)].map((m) => `${f}: ${m[0]}`));
    // Anti-vacuity (W1d item 11): the scan read the layer (38 sources at 2026-10-05: browser/, pads/ and the driver), and zero hits is over those.
    console.info(`browser-budget: ${sources.length} browser-layer sources scanned for a flat wait, ${flat.length} hit(s)`);
    expect(sources.length).toBeGreaterThanOrEqual(30);
    expect(sources).toContain("tools/matrix/lib/driver/browser-driver.ts");
    expect(flat).toEqual([]);
  });

  it("the scan reads the layer's own spelling: its real sleep (a derived delay) is no hit, and the same line with a literal delay is one", () => {
    const real = src("tools/matrix/lib/driver/browser-driver.ts");
    const sleep = /new Promise<void>\(\(resolve\) => \{ setTimeout\(resolve, ms\); \}\)/.exec(real)?.[0];
    expect(sleep, "the layer's own clock (REAL_CLOCK) no longer sleeps this way: re-pin the spelling").toBeDefined();
    expect([...sleep!.matchAll(FLAT)]).toHaveLength(0);
    expect([...sleep!.replace("resolve, ms", "resolve, 250").matchAll(FLAT)]).toHaveLength(1);
    // And the layer's one page-wide default (ctx.ts boundActions) is derived, so it is no hit either.
    const bound = /page\.setDefaultTimeout\([^)]*\)/.exec(src("tools/matrix/lib/browser/pages/ctx.ts"))?.[0];
    expect(bound, "boundActions no longer calls page.setDefaultTimeout: re-pin").toBeDefined();
    expect([...bound!.matchAll(FLAT)]).toHaveLength(0);
    expect([...bound!.replace(/\([^)]*\)/, "(30000)").matchAll(FLAT)]).toHaveLength(1);
  });

  it("the flat-wait scan has teeth: it sees a numeric timeout in either spelling, and passes a derived one", () => {
    const hits = (s: string) => [...s.matchAll(FLAT)].length;
    expect(hits("await x.waitFor({ timeout: 5000 });")).toBe(1);
    expect(hits("await x.waitFor({ timeout: 5_000 });")).toBe(1);
    expect(hits("await page.waitForTimeout(250);")).toBe(1);
    expect(hits("await x.waitFor({ timeout: waitMs });")).toBe(0);
    expect(hits("page.waitForResponse(m, { timeout: budget })")).toBe(0);
  });

  // W1d item 11 (Task 13): the scan above saw `timeout:` and waitForTimeout only. A page-wide default and a
  // hand-rolled sleep are flat waits too. Each spelling has a positive the scan must catch and a negative it must not.
  it("the flat-wait scan sees a literal page default and a literal sleep, in each spelling the layer could write, and passes every derived one", () => {
    const hits = (s: string) => [...s.matchAll(FLAT)].length;
    const positive = [
      "page.setDefaultTimeout(30000);",
      "page.setDefaultTimeout( 30_000 );",
      "context.setDefaultTimeout(\n  5000);",
      "page.setDefaultNavigationTimeout(15000);",
      "page.setDefaultNavigationTimeout(1_5000)",
      // The sleep, as the plan wrote it and as the layer's own clock writes it (driver/browser-driver.ts REAL_CLOCK:
      // an explicit generic and a braced body, with a derived delay there).
      "await new Promise(r => setTimeout(r, 250));",
      "await new Promise((resolve) => setTimeout(resolve, 1_000));",
      "await new Promise(res=>setTimeout(res,50));",
      "await new Promise((done) => setTimeout(done, 250));",
      "await new Promise<void>((resolve) => { setTimeout(resolve, 250); });",
      "await new Promise<void>((resolve) => setTimeout(resolve, 250));",
    ];
    const negative = [
      "page.setDefaultTimeout(ms);",
      "page.setDefaultTimeout(budgetMs({ holdMs }));",
      "context.setDefaultTimeout(c.holdMs * 2);",
      "page.setDefaultNavigationTimeout(navBudget(c));",
      "page.setDefaultNavigationTimeout( waitMs )",
      "await new Promise(r => setTimeout(r, waitMs));",
      "await new Promise<void>((resolve) => { setTimeout(resolve, ms); });",
      "await new Promise((resolve) => setTimeout(resolve, budget + 1));",
      "const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });",
      // Not a wait: a name that merely contains one.
      "const mySetDefaultTimeoutLabel = 30000;",
      "unsetDefaultTimeout(30000);",
    ];
    let checked = 0;
    for (const s of positive) { expect(hits(s), `positive: ${s}`).toBe(1); checked++; }
    for (const s of negative) { expect(hits(s), `negative: ${s}`).toBe(0); checked++; }
    expect(checked).toBe(positive.length + negative.length);
  });
});
