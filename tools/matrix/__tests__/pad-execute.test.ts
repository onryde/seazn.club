// lib/pads/execute.ts is a COPY of the bench's private executeStep (ruling 38:
// it is not exported there, and the bench is never edited). A copy drifts
// silently, so this file pins it three ways: the tap kinds it handles are the
// bench's TapStep kinds, its body IS the bench's body (the one intended
// change, TAP_WAIT_TIMEOUT_MS -> the caller's waitMs, normalised away), and its
// behaviour on a recording fake PadPage.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { selectorForTapStep, type PadLocator, type PadPage, type TapStep } from "../../bench/lib/drivers/scorer.ts";
import { BadBudget } from "../lib/browser/budget.ts";
import { HANDLED_KINDS, executeStep, executeSteps } from "../lib/pads/execute.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const src = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");

type Call = readonly unknown[];
interface FakePage extends PadPage { calls: Call[] }
/** counts: per selector, the answers count() gives in turn (default 1).
 *  clickThrows: selectors whose click() throws. */
function fakePage(o: { counts?: Record<string, number[]>; clickThrows?: string[] }): FakePage {
  const calls: Call[] = [];
  const counts = Object.fromEntries(Object.entries(o.counts ?? {}).map(([k, v]) => [k, [...v]]));
  const locator = (sel: string): PadLocator => ({
    async click() {
      calls.push(["click", sel]);
      if (o.clickThrows?.includes(sel)) throw new Error(`locator.click: ${sel} detached`);
    },
    async fill(value: string) { calls.push(["fill", sel, value]); },
    async waitFor(w?: { readonly state?: string; readonly timeout?: number }) { calls.push(w?.state === undefined ? ["waitFor", sel, w?.timeout] : ["waitFor", sel, w.timeout, w.state]); },
    async count() { calls.push(["count", sel]); return counts[sel]?.shift() ?? 1; },
  });
  return {
    calls,
    locator,
    goto: async () => { throw new Error("fake: executeStep never navigates"); },
    setViewportSize: async () => { throw new Error("fake: executeStep never resizes"); },
  };
}

const SEND = '[data-testid="pad-send-now"]';

/** The bench TapStep union's own kinds, read from its declaration only
 *  (scorer.ts has a second `{ readonly kind: … }` union further down). */
function benchKinds(): string[] {
  const union = /export type TapStep =([\s\S]*?)\};\s*\n/.exec(src("tools/bench/lib/drivers/scorer.ts"))?.[1] ?? "";
  return [...union.matchAll(/\|\s*\{\s*readonly kind: "(\w+)"/g)].map((m) => m[1]).sort();
}

/** A function's body from its `const locator` line to its closing brace,
 *  with comments dropped and whitespace collapsed. */
function executeBody(file: string, signature: RegExp): string {
  const text = src(file);
  const start = text.search(signature);
  if (start < 0) return "";
  const end = text.indexOf("\n}\n", start);
  const fn = text.slice(start, end + 2);
  return fn.slice(fn.indexOf("const locator"))
    .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")
    .replace(/\s+/g, " ").trim();
}

describe("the pad executor copy (ruling 38)", () => {
  it("releaseHold with nothing held is a no-op (count 0 → no click, no wait)", async () => {
    const page = fakePage({ counts: { '[data-testid="pad-send-now"]': [0] } });
    await executeStep(page, { kind: "releaseHold" }, 1000);
    expect(page.calls).toEqual([["count", '[data-testid="pad-send-now"]']]);
  });

  it("releaseHold tolerates the hold releasing itself between count and click", async () => {
    const page = fakePage({ counts: { '[data-testid="pad-send-now"]': [1, 0] }, clickThrows: ['[data-testid="pad-send-now"]'] });
    await expect(executeStep(page, { kind: "releaseHold" }, 1000)).resolves.toBeUndefined();
    // It still waits the dock out, on the caller's budget.
    expect(page.calls.at(-1)).toEqual(["waitFor", SEND, 1000, "detached"]);
  });

  it("releaseHold rethrows when the click failed and the dock is still there", async () => {
    const page = fakePage({ counts: { '[data-testid="pad-send-now"]': [1, 1] }, clickThrows: ['[data-testid="pad-send-now"]'] });
    await expect(executeStep(page, { kind: "releaseHold" }, 1000)).rejects.toThrow();
  });

  it("number fills, never clicks; every wait uses the caller's budget, not a literal", async () => {
    const page = fakePage({});
    await executeStep(page, { kind: "number", value: 21 }, 4321);
    expect(page.calls).toEqual([["waitFor", '[data-testid="pad-sheet-number"]', 4321], ["fill", '[data-testid="pad-sheet-number"]', "21"]]);
  });

  it("text fills its own testid; offeredChip waits for the open dock and taps the chip only when it is offered", async () => {
    const text = fakePage({});
    await executeStep(text, { kind: "text", testid: "score-prompt-reason", value: "retired hurt" }, 777);
    expect(text.calls).toEqual([["waitFor", '[data-testid="score-prompt-reason"]', 777], ["fill", '[data-testid="score-prompt-reason"]', "retired hurt"]]);
    const chip = '[data-testid="pad-dock-chip-p1"]';
    const offered = fakePage({ counts: { [chip]: [1] } });
    await executeStep(offered, { kind: "offeredChip", chipId: "p1" }, 900);
    expect(offered.calls).toEqual([["waitFor", SEND, 900], ["count", chip], ["click", chip]]);
    const absent = fakePage({ counts: { [chip]: [0] } });
    await executeStep(absent, { kind: "offeredChip", chipId: "p1" }, 900);
    expect(absent.calls).toEqual([["waitFor", SEND, 900], ["count", chip]]);
  });

  it("every click kind waits on the caller's budget, then clicks the bench's own selector for it", async () => {
    const steps: TapStep[] = [
      { kind: "tile", tileId: "point-home" }, { kind: "choice", optionId: "o1" }, { kind: "confirm" },
      { kind: "testid", testid: "score-start-match" }, { kind: "half", side: "away" }, { kind: "chip", chipId: "p2" },
    ];
    for (const step of steps) {
      const page = fakePage({});
      await executeStep(page, step, 1234);
      const sel = selectorForTapStep(step);
      expect(page.calls, step.kind).toEqual([["waitFor", sel, 1234], ["click", sel]]);
    }
    expect(steps.length).toBe(6);
  });

  it("executeSteps runs the steps in order on one budget; an empty list touches nothing", async () => {
    const page = fakePage({});
    await executeSteps(page, [{ kind: "tile", tileId: "a" }, { kind: "number", value: 3 }], 500);
    expect(page.calls.map((c) => c[0])).toEqual(["waitFor", "click", "waitFor", "fill"]);
    expect(page.calls.filter((c) => c[0] === "waitFor").map((c) => c[2])).toEqual([500, 500]);
    const idle = fakePage({});
    await executeSteps(idle, [], 500);
    expect(idle.calls).toEqual([]);
  });

  it("refuses a wait budget that is not a finite number of ms above 0, before touching the page", async () => {
    let refused = 0;
    for (const ms of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const page = fakePage({});
      await expect(executeStep(page, { kind: "confirm" }, ms), String(ms)).rejects.toThrow(BadBudget);
      expect(page.calls).toEqual([]);
      refused++;
    }
    expect(refused).toBe(4);
  });

  it("the copy's case list equals the bench TapStep kinds (a new bench kind reds here, not mid-run)", () => {
    const kinds = benchKinds();
    expect(kinds.length).toBe(10);
    expect(HANDLED_KINDS.slice().sort()).toEqual(kinds);
  });

  it("the copy's body IS the bench's executeStep body, with TAP_WAIT_TIMEOUT_MS read as the caller's waitMs", () => {
    const bench = executeBody("tools/bench/lib/drivers/scorer.ts", /\nasync function executeStep\(page: PadPage, step: TapStep\): Promise<void> \{/)
      .replaceAll("TAP_WAIT_TIMEOUT_MS", "waitMs");
    const copy = executeBody("tools/matrix/lib/pads/execute.ts", /\nexport async function executeStep\(page: PadPage, step: TapStep, waitMs: number\): Promise<void> \{/);
    // Both found, and long enough to be the whole switch (an empty read would compare equal).
    expect(bench.length).toBeGreaterThan(500);
    expect(copy).toBe(bench);
  });
});
