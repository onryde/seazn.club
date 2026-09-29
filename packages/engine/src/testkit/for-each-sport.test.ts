// R26: the shared sport sweep. What it owes a caller, in the order a reviewer
// asks: the empty case (a refusal, never a zero-iteration pass), registry order
// (WAVE order — never sorted; AGENTS.md class 18), an honest count, a second
// call that sees the same registry, and a failure that names its sport. Fix
// round 1 (review I-5, M-3): an async body is refused by name (it would run
// nothing before the count came back), forEachSportAsync awaits each sport in
// turn, and a wrapped assertion keeps vitest's diff fields.
import { describe, expect, it } from "vitest";
import type { AnySportModule } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";
import { AsyncBody, EmptySportRegistry, forEachSport, forEachSportAsync, sportCases, type SportCase } from "./for-each-sport.ts";
import * as testkit from "./index.ts";

// The registry's order as `sports/index.ts` declares it at W1b: the order the
// sports shipped in (wave order), NOT alphabetical. That file's own comment
// says "Order is not significant" — false (plan false premise 6), and not ours
// to edit — so this pin is what reds a well-meant alphabetising. A new sport
// APPENDS: the prefix stays pinned, and the tail is checked against the
// registry itself below.
const WAVE_ORDER = [
  "football",
  "cricket",
  "boardgame",
  "carrom",
  "generic",
  "volleyball",
  "badminton",
  "tabletennis",
  "tennis",
  "icehockey",
  "hockey",
] as const;

describe("forEachSport (R26)", () => {
  it("empty case first: an empty registry is refused by name, never a silent zero-iteration pass", () => {
    let calls = 0;
    expect(() => sportCases([])).toThrow(EmptySportRegistry);
    expect(() => forEachSport(() => { calls++; }, [])).toThrow(EmptySportRegistry);
    expect(calls).toBe(0);
    try {
      sportCases([]);
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).name).toBe("EmptySportRegistry");
      expect((e as Error).message).toMatch(/empty/);
    }
  });

  it("walks the registry in wave order: the pinned prefix, then the registry's own tail — never sorted", () => {
    const keys = sportCases().map((c) => c.key);
    expect(keys.slice(0, WAVE_ORDER.length)).toEqual([...WAVE_ORDER]);
    expect(keys).toEqual(builtinModules.map((m) => m.key));
    // The witness can see a sort: the right answer differs from the sorted one.
    expect(keys).not.toEqual([...keys].sort());
  });

  it("a caller's own list keeps ITS order and positions (reversed in, reversed out)", () => {
    const reversed: readonly AnySportModule[] = [...builtinModules].reverse();
    const cases = sportCases(reversed);
    expect(cases.map((c) => c.key)).toEqual(reversed.map((m) => m.key));
    expect(cases.map((c) => c.index)).toEqual(reversed.map((_, i) => i));
    cases.forEach((c, i) => expect(c.module).toBe(reversed[i]));
    const seen: string[] = [];
    expect(forEachSport((c) => { seen.push(c.key); }, reversed)).toBe(reversed.length);
    expect(seen).toEqual(reversed.map((m) => m.key));
  });

  it("returns the count it visited; each case is the registry entry at its index", () => {
    const seen: SportCase[] = [];
    const n = forEachSport((c) => { seen.push(c); });
    expect(n).toBeGreaterThan(0);
    expect(n).toBe(builtinModules.length);
    expect(seen.length).toBe(n);
    seen.forEach((c, i) => {
      expect(c.index).toBe(i);
      expect(c.module).toBe(builtinModules[i]);
      expect(c.key).toBe(builtinModules[i]!.key);
    });
    expect(new Set(seen.map((c) => c.key)).size).toBe(n);
  });

  it("a second call sees the same registry: a caller mutating the first result leaks nothing", () => {
    const first = sportCases();
    const keys = first.map((c) => c.key);
    first.reverse();
    first.pop();
    const second = sportCases();
    expect(second).not.toBe(first);
    expect(second.map((c) => c.key)).toEqual(keys);
    expect(builtinModules.map((m) => m.key)).toEqual(keys);
    expect(forEachSport(() => {})).toBe(keys.length);
  });

  it("a throwing body names the sport it failed on, keeps the cause, and stops there", () => {
    const at = 1;
    const failKey = builtinModules[at]!.key;
    const boom = new Error("boom");
    const visited: string[] = [];
    let caught: unknown;
    try {
      forEachSport((c) => { visited.push(c.key); if (c.index === at) throw boom; });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(`sport ${failKey}: boom`);
    expect((caught as Error).cause).toBe(boom);
    expect(visited).toEqual(builtinModules.slice(0, at + 1).map((m) => m.key));
    // A non-Error throw is named too.
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- the non-Error throw IS the case under test
    expect(() => forEachSport((c) => { if (c.index === 0) throw "plain"; })).toThrow(`sport ${builtinModules[0]!.key}: plain`);
  });

  it("a failing expect inside the sweep keeps vitest's diff fields (actual / expected / showDiff) on the wrapper (M-3)", () => {
    let caught: unknown;
    try {
      forEachSport((c) => { expect(c.index).toBe(-1); });
    } catch (e) {
      caught = e;
    }
    const w = caught as Record<string, unknown> & Error;
    expect(w.message).toMatch(new RegExp(`^sport ${builtinModules[0]!.key}: `));
    expect(w.actual).toBe(0);
    expect(w.expected).toBe(-1);
    expect(w.showDiff).toBe(true);
    expect((w.cause as Error).name).toBe("AssertionError");
  });

  it("an async body is refused by name at the first sport — never a count for bodies nobody awaited (I-5)", async () => {
    let started = 0;
    let finished = 0;
    let caught: unknown;
    try {
      // eslint-disable-next-line @typescript-eslint/no-misused-promises -- the misuse IS the case under test
      forEachSport(async () => { started++; await Promise.resolve(); finished++; });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AsyncBody);
    expect((caught as AsyncBody).sport).toBe(builtinModules[0]!.key);
    expect((caught as Error).message).toMatch(/forEachSportAsync/);
    expect(started).toBe(1);
    // A bare thenable is refused the same way.
    expect(() => forEachSport(() => ({ then() {} }) as unknown as void)).toThrow(AsyncBody);
    // The refused body's own rejection is handled, not left to surface as an
    // unattributed unhandledRejection.
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => { unhandled.push(r); };
    process.on("unhandledRejection", onUnhandled);
    try {
      // eslint-disable-next-line @typescript-eslint/no-misused-promises -- the misuse IS the case under test
      expect(() => forEachSport(async () => { throw new Error("late"); })).toThrow(AsyncBody);
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
    expect(finished).toBe(1);
  });

  it("forEachSportAsync: awaits each sport in turn, in registry order, and resolves the count only after every body settled", async () => {
    const log: string[] = [];
    const n = await forEachSportAsync(async (c) => {
      log.push(`start ${c.key}`);
      await new Promise((r) => setTimeout(r, 1));
      log.push(`end ${c.key}`);
    });
    expect(n).toBe(builtinModules.length);
    expect(n).toBeGreaterThan(0);
    expect(log).toEqual(builtinModules.flatMap((m) => [`start ${m.key}`, `end ${m.key}`]));
    // sync bodies are fine too
    expect(await forEachSportAsync(() => undefined)).toBe(builtinModules.length);
  });

  it("forEachSportAsync: the empty registry is refused; a rejection names its sport, keeps the cause and the diff, and stops there", async () => {
    await expect(forEachSportAsync(async () => {}, [])).rejects.toBeInstanceOf(EmptySportRegistry);
    const at = 2;
    const visited: string[] = [];
    let caught: unknown;
    try {
      await forEachSportAsync(async (c) => {
        visited.push(c.key);
        await Promise.resolve();
        if (c.index === at) expect(c.key).toBe("not-a-sport");
      });
    } catch (e) {
      caught = e;
    }
    const w = caught as Record<string, unknown> & Error;
    expect(w.message).toMatch(new RegExp(`^sport ${builtinModules[at]!.key}: `));
    expect((w.cause as Error).name).toBe("AssertionError");
    expect(w.actual).toBe(builtinModules[at]!.key);
    expect(w.expected).toBe("not-a-sport");
    expect(visited).toEqual(builtinModules.slice(0, at + 1).map((m) => m.key));
  });

  it("is published through the testkit barrel (@seazn/engine/testkit)", () => {
    expect(testkit.forEachSport).toBe(forEachSport);
    expect(testkit.forEachSportAsync).toBe(forEachSportAsync);
    expect(testkit.sportCases).toBe(sportCases);
    expect(testkit.EmptySportRegistry).toBe(EmptySportRegistry);
    expect(testkit.AsyncBody).toBe(AsyncBody);
  });
});
