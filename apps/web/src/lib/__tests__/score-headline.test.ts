// The device page's LED headline (device-score-pad.tsx's header) is laid out in unbreakable runs: a " · " group that fits a
// line on a 320px phone is one run, as it always was; a longer one is one run per side (the side's dash kept on its left), so
// a line may break between the two sides but never inside a number. Sign-off qmc14a (quick match cricket, 2026-11-14): a
// decided cricket match's headline, "10/0 (1) — 9/0 (1)", was ONE unbreakable group and at the LED size ran off the header
// card at 320 and 390 (the walkthrough's (H) leg scans it in a browser).
//
// The headlines are the ENGINE's own (`summaryOf` over real folds, every built-in sport's default rules), never typed here,
// plus the device page's own documented example. The runs are checked against the headline's grammar: put back together
// they are the headline exactly, no run carries a group separator, a group that fits is never split, and a longer one
// splits only at its " — " side dash.
import { describe, expect, it } from "vitest";
import { foldMatch, summaryOf, type LineupPair } from "@seazn/engine/core";
import { makeEnvelope } from "@seazn/engine/testkit";
import { builtinModules } from "@seazn/engine/sports";
import { PREFERRED_VARIANT } from "@/lib/preferred-variant";
import { headlineRuns, LED_ONE_LINE_CHARS } from "../score-headline";

const LINEUPS: LineupPair = { home: { entrantId: "H", slots: [] }, away: { entrantId: "A", slots: [] } };

/** The headline the fold of `events` reads under the variant a setup opens `sport` on (its preferred one, else its first). */
function headlineOf(sport: string, events: { type: string; payload: Record<string, unknown> }[]): string {
  const mod = builtinModules.find((m) => m.key === sport)!;
  expect(mod, `premise: ${sport} is a built-in module`).toBeDefined();
  const variants = mod.variants as Record<string, unknown>;
  const cfg = mod.configSchema.parse(variants[PREFERRED_VARIANT[sport] ?? Object.keys(variants)[0]!] ?? {});
  const state = foldMatch(mod as never, cfg as never, LINEUPS, events.map((e, seq) => makeEnvelope(seq, e as never)));
  return summaryOf(mod as never, { state, settlement: null } as never).headline;
}

/** Put the runs back the way the page draws them: runs joined by a space, groups by " · ". */
const rejoin = (runs: string[][]) => runs.map((group) => group.join(" ")).join(" · ");

describe("headlineRuns: the device headline's unbreakable runs", () => {
  it("the empty case first: no headline is one empty run, which draws nothing", () => {
    expect(headlineRuns("")).toEqual([[""]]);
  });

  it("the line: a group of LED_ONE_LINE_CHARS stays whole, one character more splits at its side dash", () => {
    const fits = `${"1".repeat(LED_ONE_LINE_CHARS - 4)} — 2`;
    expect(fits).toHaveLength(LED_ONE_LINE_CHARS);
    expect(headlineRuns(fits)).toEqual([[fits]]);
    const over = `1${fits}`;
    expect(headlineRuns(over)).toEqual([[`1${"1".repeat(LED_ONE_LINE_CHARS - 4)} —`, "2"]]);
  });

  it("a decided cricket match (the engine's own headline) breaks between its two innings, each innings whole", () => {
    const toss = { type: "cricket.toss", payload: { wonBy: "A", elected: "bat" } };
    const headline = headlineOf("cricket", [
      toss,
      { type: "core.start", payload: {} },
      { type: "cricket.innings.summary", payload: { runs: 9, wickets: 0, legalBalls: 6, partial: true } },
      { type: "cricket.innings.close", payload: { reason: "other" } },
      { type: "cricket.innings.summary", payload: { runs: 10, wickets: 0, legalBalls: 6, partial: true } },
    ]);
    // Premise: the headline that clipped on the sign-off page has one group and two sides.
    expect(headline.split(" · "), `premise: ${headline} is one group`).toHaveLength(1);
    expect(headline.split(" — "), `premise: ${headline} names two sides`).toHaveLength(2);
    const runs = headlineRuns(headline);
    expect(runs).toHaveLength(1);
    expect(runs[0], "two runs, the first keeping the side dash").toHaveLength(2);
    expect(runs[0]![0]!.endsWith(" —")).toBe(true);
    expect(rejoin(runs)).toBe(headline);
  });

  it("the device page's own example, every group short, is drawn exactly as before: one run per group", () => {
    // device-score-pad.tsx: set-score headlines like "1 — 0 · 21-18 (16-12)" never wrap mid-number.
    expect(headlineRuns("1 — 0 · 21-18 (16-12)")).toEqual([["1 — 0"], ["21-18 (16-12)"]]);
  });

  it("every built-in sport's opening headline and its headline after a Start come back whole, a short group never split", () => {
    let checked = 0;
    for (const mod of builtinModules) {
      for (const events of [[], [{ type: "core.start", payload: {} }]]) {
        let headline: string;
        try {
          headline = headlineOf(mod.key, events);
        } catch {
          continue; // a sport whose Start needs more (a toss, a lineup) has no headline from these events
        }
        const runs = headlineRuns(headline);
        expect(rejoin(runs), `${mod.key}: ${headline}`).toBe(headline);
        for (const group of runs) {
          const whole = group.join(" ");
          if (whole.length <= LED_ONE_LINE_CHARS) expect(group, `${mod.key}: ${JSON.stringify(whole)} fits, one run`).toHaveLength(1);
          for (const [i, run] of group.entries()) {
            expect(run.includes(" · "), `${mod.key}: no group separator inside a run`).toBe(false);
            // A split group's run may end on its side's dash; no other " — " sits inside one.
            if (group.length === 1) continue;
            const inner = i < group.length - 1 ? run.slice(0, -2) : run;
            expect(inner.includes(" — "), `${mod.key}: ${JSON.stringify(run)} holds no inner side dash`).toBe(false);
          }
        }
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: headlines checked across the built-in sports").toBeGreaterThan(builtinModules.length);
  });
});
