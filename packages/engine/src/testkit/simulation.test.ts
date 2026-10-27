// Tournament simulation harness — PROMPT-14. Every registered sport module ×
// every stage-graph template runs SIM_RUNS seeded full divisions; each division
// is checked against the global invariants and (on a slice) exact replay
// determinism. Failures dump a reproduction artifact: `npm run sim:replay --
// <seedToken>` re-runs that exact division.
//
// Budget: SIM_RUNS env — CI defaults to 200 per sport×format, local runs to 25,
// the nightly workflow_dispatch/cron job passes 10000.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { builtinModules } from "../sports/index.ts";
import type { AnySportModule } from "../sport/module.ts";
import {
  assertDivisionInvariants,
  canVoidFixtureEvent,
  FORMAT_TEMPLATES,
  SIM_CONFIGS,
  simOptionsFor,
  simulateDivision,
  SimInvariantError,
  type FormatTemplate,
  type SimulationResult,
} from "./simulation.ts";

const SIM_RUNS = Number(process.env.SIM_RUNS ?? (process.env.CI ? 200 : 25));

const FAILURE_DIR = new URL("../../sim-failures", import.meta.url).pathname;

// Dump the failing division (seed token + full event streams) for exact
// offline reproduction, then rethrow (PROMPT-14 §3).
function dumpFailure(token: string, error: unknown, sim?: SimulationResult): void {
  mkdirSync(FAILURE_DIR, { recursive: true });
  const file = join(FAILURE_DIR, `${token.replaceAll(":", "_")}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        seedToken: token,
        replay: `npm run sim:replay -- ${token}`,
        error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
        detail: error instanceof SimInvariantError ? error.detail : undefined,
        simulation: sim,
      },
      null,
      2,
    ),
  );
  // eslint-disable-next-line no-console
  console.error(`simulation failure artifact written: ${file}`);
}

function runOne(module: AnySportModule, format: FormatTemplate, seed: number): SimulationResult {
  const opts = simOptionsFor(module, format, seed);
  const token = `${module.key}:${format}:${seed}`;
  let sim: SimulationResult | undefined;
  try {
    sim = simulateDivision(opts);
    assertDivisionInvariants(sim, module, opts.cfg);
    if (seed % 10 === 1) {
      // Deterministic replay: same seed ⇒ identical fixture ids, event ids and
      // final standings (PROMPT-14 §1).
      const replay = simulateDivision(opts);
      expect(JSON.stringify(replay)).toBe(JSON.stringify(sim));
    }
    if (sim.injection !== undefined && !sim.injection.applied) {
      expect(sim.injection.rejectedCode).toBeTruthy();
    }
    return sim;
  } catch (error) {
    dumpFailure(token, error, sim);
    throw error;
  }
}

for (const module of builtinModules) {
  describe(`simulation — ${module.key}@${module.version}`, () => {
    for (const format of FORMAT_TEMPLATES) {
      it(
        `${format}: ${SIM_RUNS} seeded divisions hold the global invariants`,
        // Nightly runs pass SIM_RUNS=10000 — budget the timeout accordingly.
        { timeout: Math.max(60_000, SIM_RUNS * 300) },
        () => {
          for (let seed = 1; seed <= SIM_RUNS; seed++) {
            runOne(module, format, seed);
          }
        },
      );
    }
  });
}

describe("rank_locked guard (PROMPT-14 §1)", () => {
  const generic = builtinModules.find((m) => m.key === "generic") as AnySportModule;

  it("blocks a void once the fixture's stage has completed", () => {
    const sim = simulateDivision({
      module: generic,
      cfg: SIM_CONFIGS["generic"],
      format: "group_knockout",
      seed: 7,
      entrantCount: 8,
    });
    // Every stage in a finished division has completed — any further void
    // attempt must be refused with the rank_locked code.
    for (const stage of sim.stages) {
      expect(canVoidFixtureEvent(sim.divisionEvents, stage.id)).toEqual({
        ok: false,
        code: "rank_locked",
      });
    }
    // While a stage is still open (its stage_completed not yet emitted), the
    // same fixture may be voided.
    const beforeCompletion = sim.divisionEvents.filter((e) => e.type === "stage_opened");
    expect(beforeCompletion.length).toBeGreaterThan(0);
    expect(canVoidFixtureEvent([{ type: "stage_opened", stageId: "groups" }], "groups")).toEqual({
      ok: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Mutation canaries — PROMPT-14 acceptance: a deliberately seeded engine bug
// must be caught. Each canary corrupts one aspect of an otherwise-valid
// division the way a source mutation would, and the invariant checker fires.
// ---------------------------------------------------------------------------
describe("mutation canaries — the harness catches seeded engine bugs", () => {
  const generic = builtinModules.find((m) => m.key === "generic") as AnySportModule;
  const cfg = SIM_CONFIGS["generic"];
  const valid = () =>
    JSON.parse(
      JSON.stringify(
        simulateDivision({
          module: generic,
          cfg,
          format: "league",
          seed: 11,
          entrantCount: 6,
        }),
      ),
    ) as SimulationResult;

  it("accepts the unmutated division (canary baseline)", () => {
    expect(() => assertDivisionInvariants(valid(), generic, cfg)).not.toThrow();
  });

  it("catches a flipped ranking comparator (points order inverted)", () => {
    const sim = valid();
    const stage = sim.stages[0];
    const pool = stage?.tables?.pools[0];
    if (!stage || !pool) throw new Error("league simulation lost its pool table");
    // A flipped `points` comparator ranks the table bottom-up: same rows, same
    // rank numbers 1..n, reversed order — exactly what a mutated cascade emits.
    const reversed = [...pool.rows].reverse().map((row, i) => ({ ...row, rank: i + 1 }));
    (pool as unknown as { rows: typeof reversed }).rows = reversed;
    expect(() => assertDivisionInvariants(sim, generic, cfg)).toThrow(SimInvariantError);
    expect(() => assertDivisionInvariants(sim, generic, cfg)).toThrow(/contradicts points/);
  });

  it("catches a standingsDelta that stops conserving points", () => {
    const sim = valid();
    const fixture = sim.stages[0]?.fixtures.find((f) => f.result !== undefined);
    if (!fixture?.result) throw new Error("league simulation lost its results");
    (fixture.result[0] as { points: number }).points += 1;
    expect(() => assertDivisionInvariants(sim, generic, cfg)).toThrow(/points/);
  });

  it("catches a fold that miscounts played fixtures", () => {
    const sim = valid();
    const fixture = sim.stages[0]?.fixtures.find((f) => f.result !== undefined);
    if (!fixture?.result) throw new Error("league simulation lost its results");
    // Keep the fixture total inside the declared set but corrupt the played
    // tally — the ledger-sum invariant must notice the divergence.
    (fixture.result[0] as { played: number }).played = 0;
    expect(() => assertDivisionInvariants(sim, generic, cfg)).toThrow(/played counts/);
  });

  it("catches a champion outside the entrant set", () => {
    const sim = valid();
    (sim as { champion: string }).champion = "ghost";
    expect(() => assertDivisionInvariants(sim, generic, cfg)).toThrow(/not an entrant/);
  });
});

// W2d T11 (carry 2): the comparator-flip catcher keys on the order's FIRST step — `points`, or the sport's own primary
// (D11: matches won rank first in volleyball, badminton and tennis) — and never on `points` alone, which would skip
// every wins-first default without a word. Counted per sport: a league division must run the check on the sport's
// primary, a Swiss one on `points` (OC1 keeps every Swiss order points-first), and a table reversed bottom-up must trip it.
describe("W2d T11 — the table-measure check reads each sport's primary (every sport, counted)", () => {
  it("each sport's league runs the check on its primaryTableKey, its Swiss stage on points, and a reversed table trips it", () => {
    let sports = 0;
    for (const module of builtinModules) {
      const primary = module.primaryTableKey;
      const league = simOptionsFor(module, "league", 3);
      const sim = simulateDivision({ ...league, entrantCount: 6 });
      const report = assertDivisionInvariants(sim, module, league.cfg);
      // The sim ranks by the order the product ships, unstripped: chess's round robin keeps its direct encounter and
      // Sonneborn-Berger (BG-TB-1) — only the Buchholz pair is Swiss-only.
      expect(sim.stages[0]?.kind, `${module.key}: premise — a league stage`).toBe("league");
      expect(sim.stages[0]?.cascade, `${module.key}: the shipped league default`).toEqual(
        module.defaultTiebreakers("league", module.configSchema.parse(league.cfg ?? {})),
      );
      expect(report.tableMeasureChecks[primary], `${module.key}: league pools checked on ${primary}`).toBeGreaterThan(0);
      const swiss = simOptionsFor(module, "swiss_knockout", 3);
      const swissSim = simulateDivision({ ...swiss, entrantCount: 8 });
      expect(assertDivisionInvariants(swissSim, module, swiss.cfg).tableMeasureChecks.points, `${module.key}: Swiss pools checked on points`).toBeGreaterThan(0);
      // The canary: the same rows, ranks 1..n, bottom-up — what a flipped comparator on the first step emits.
      const broken = JSON.parse(JSON.stringify(sim)) as SimulationResult;
      const pool = broken.stages[0]?.tables?.pools[0];
      if (pool === undefined) throw new Error(`${module.key}: league simulation lost its pool table`);
      const reversed = [...pool.rows].reverse().map((row, i) => ({ ...row, rank: i + 1 }));
      (pool as unknown as { rows: typeof reversed }).rows = reversed;
      expect(() => assertDivisionInvariants(broken, module, league.cfg), module.key).toThrow(new RegExp(`contradicts ${primary}`));
      sports++;
    }
    expect(sports, "every registered sport").toBe(builtinModules.length);
    expect(sports).toBeGreaterThan(0);
  }, 120_000);

  // The two assumptions the check makes are guards, each reached here: an order opening on anything but a table measure,
  // and a wins-first order under winsCount "regulation" (whose W column the check does not discount).
  it("refuses an order that opens on neither points nor the primary, and a wins-first order under regulation wins", () => {
    let refused = 0;
    for (const module of builtinModules) {
      const league = simOptionsFor(module, "league", 3);
      const sim = JSON.parse(JSON.stringify(simulateDivision({ ...league, entrantCount: 6 }))) as SimulationResult;
      const stage = sim.stages[0];
      if (stage?.cascade === undefined) throw new Error(`${module.key}: league simulation lost its order`);
      stage.cascade = ["lots", ...stage.cascade];
      expect(() => assertDivisionInvariants(sim, module, league.cfg), module.key).toThrow(/neither points nor the sport's primary/);
      refused++;
    }
    expect(refused, "every registered sport").toBe(builtinModules.length);
    // The regulation-wins sports (the registry's own declaration — hockey today, HK-TB-1), each made wins-primary.
    const regulation = builtinModules.filter((m) => m.winsCount === "regulation");
    expect(regulation.length, "a sport that counts regulation wins only").toBeGreaterThan(0);
    for (const real of regulation) {
      const module: AnySportModule = { ...real, primaryTableKey: "wins" };
      const league = simOptionsFor(real, "league", 3);
      const sim = JSON.parse(JSON.stringify(simulateDivision({ ...league, entrantCount: 6 }))) as SimulationResult;
      const stage = sim.stages[0];
      if (stage?.cascade === undefined) throw new Error(`${real.key}: league simulation lost its order`);
      stage.cascade = ["wins", ...stage.cascade.filter((k) => k !== "wins")];
      expect(() => assertDivisionInvariants(sim, module, league.cfg), real.key).toThrow(/winsCount "regulation"/);
    }
  }, 120_000);

  // review m7: the sim used to STRIP a Swiss-ledger key from a non-Swiss default, a branch no signed default reaches. It
  // now refuses by name (validateCascade rule 3: the Buchholz pair needs the assembled Swiss ledger), reached here by
  // planting `buchholz` in every sport's round-robin default; the same plant in a Swiss-only position is not refused.
  it("refuses a round-robin default that ranks on the Swiss ledger (every sport), and leaves a Swiss stage's Buchholz alone", () => {
    const plant = (real: AnySportModule): AnySportModule => ({
      ...real,
      defaultTiebreakers: (kind, cfg) => {
        const order = real.defaultTiebreakers(kind, cfg);
        return kind === "swiss" ? order : [...order.slice(0, -1), "buchholz", ...order.slice(-1)];
      },
    });
    let refused = 0;
    for (const real of builtinModules) {
      const league = simOptionsFor(real, "league", 3);
      expect(() => simulateDivision({ ...league, module: plant(real), entrantCount: 6 }), real.key).toThrow(
        new RegExp(`${real.key}'s league default ranks on the Swiss ledger \\(buchholz\\)`),
      );
      refused++;
    }
    expect(refused, "every registered sport").toBe(builtinModules.length);
    // The positive pair: a sport whose own Swiss default ranks on Buchholz still simulates its Swiss stage (the plant
    // leaves the Swiss order alone), so the refusal reads the stage kind and not the key alone.
    let swissRuns = 0;
    for (const real of builtinModules) {
      const swissOrder = real.defaultTiebreakers("swiss", real.configSchema.parse(SIM_CONFIGS[real.key] ?? {}));
      if (!swissOrder.some((key) => key === "buchholz" || key === "buchholz_cut1")) continue;
      const swiss = simOptionsFor(real, "swiss_knockout", 3);
      const sim = simulateDivision({ ...swiss, module: plant(real), entrantCount: 8 });
      expect(sim.stages[0]?.kind, `${real.key}: premise — a swiss stage`).toBe("swiss");
      expect(sim.stages[0]?.cascade, `${real.key}: the Swiss default, unstripped`).toEqual(swissOrder);
      swissRuns++;
    }
    expect(swissRuns, "sports whose Swiss default ranks on Buchholz").toBeGreaterThan(0);
  }, 120_000);
});
