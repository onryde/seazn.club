// Final batch FB-6 (task 10 review (c), task 11 review M-4): a spawned CLI's
// cap and its test's budget come from ONE constant (spawn-budget.ts), so the
// budget moves when the cap does (AGENTS.md class 20). The empty case first:
// a budget for no spawn at all is refused, not 0 ms.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SLACK_MS, SPAWN_MS, SpawnBudgetExceeded, SpawnMeter, spawnBudget } from "./spawn-budget.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("spawn budget (final batch FB-6)", () => {
  it("empty case first: zero, negative and fractional spawn counts, and a zero cap, are refused — never a 0 ms budget", () => {
    let checked = 0;
    for (const bad of [0, -1, 1.5, Number.NaN]) { expect(() => spawnBudget(bad), String(bad)).toThrow(/not a spawn count/); checked++; }
    expect(() => spawnBudget(1, 0)).toThrow(/not a cap/);
    expect(() => new SpawnMeter(0)).toThrow(/not a spawn count/);
    expect(checked).toBe(4);
  });

  it("a budget covers every spawn at its own cap, plus slack — above the cap for one spawn, and growing with the count", () => {
    expect(spawnBudget(1)).toBe(SPAWN_MS + SLACK_MS);
    expect(spawnBudget(12)).toBe(12 * SPAWN_MS + SLACK_MS);
    expect(spawnBudget(2, 60_000)).toBe(2 * 60_000 + SLACK_MS);
    expect(SLACK_MS).toBeGreaterThan(0);
    expect(new SpawnMeter(3).budget).toBe(spawnBudget(3));
  });

  it("SpawnMeter: up to max spawns pass, the next is refused by name, and reset starts the next test afresh", () => {
    const m = new SpawnMeter(2);
    m.tick();
    m.tick();
    expect(() => m.tick()).toThrow(SpawnBudgetExceeded);
    m.reset();
    m.tick();
    m.tick();
    expect(() => m.tick()).toThrow(/more than 2 CLI spawn/);
  });

  it("every covered spawning test file takes its caps and budgets from one constant — no numeric literal after `timeout:`", () => {
    // The four files the final batch names: the main-module CLIs, the
    // gen-catalogue CLI, the single-sport CLI, and the reference package's
    // spawned eslint (its own package, so its own constant pair). Then W1b
    // carry (d): the CI-step and single-sport spawns in ci-wiring, and
    // workspace-wiring's turbo dry run. Each with the fewest named timeouts
    // it holds — its spawn sites. CL-R4 (review m-3) split main-module's test:
    // the harness keeps its CLI spawns (cli-main-module), and the module's own
    // test moved beside it to scripts/__tests__ with crash-exit's — scripts/
    // may not import spawn-budget.ts, so each holds its own constant pair.
    const covered: readonly [string, string, number][] = [
      ["tools/matrix/__tests__/cli-main-module.test.ts", "./spawn-budget.ts", 2],
      ["scripts/__tests__/main-module.test.ts", "SPAWN_MS", 1],
      ["scripts/__tests__/crash-exit.test.ts", "SPAWN_MS", 1],
      ["tools/matrix/__tests__/committed-catalogue.test.ts", "./spawn-budget.ts", 2],
      ["tools/matrix/__tests__/single-sport.test.ts", "./spawn-budget.ts", 2],
      ["packages/reference/test/eslint-inline-type.test.ts", "LINT_MS", 2],
      ["tools/matrix/__tests__/ci-wiring.test.ts", "./spawn-budget.ts", 2],
      ["tools/matrix/__tests__/workspace-wiring.test.ts", "./spawn-budget.ts", 1],
    ];
    let checked = 0;
    for (const [path, source, sites] of covered) {
      const text = readFileSync(resolve(REPO, path), "utf8");
      expect(text.match(/\btimeout: \d/g) ?? [], `${path}: a literal timeout`).toEqual([]);
      expect(text, `${path}: its constant`).toContain(source);
      expect(text.match(/\btimeout: [A-Za-z]/g)?.length ?? 0, `${path}: no timeout at all`).toBeGreaterThanOrEqual(sites);
      checked++;
    }
    expect(checked).toBe(covered.length);
  });
});
