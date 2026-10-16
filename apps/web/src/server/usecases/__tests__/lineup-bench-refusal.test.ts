// The PUT-lineups bench refusal — the PREDICATE, with no database.
//
// A catalog that declares `benchMax: 0` (boardgame, carrom, generic) says the
// sport has no bench. `validateLineup` only ever WARNED about a bench row for
// it (`bench_size`), and `putLineup` saved the row anyway, though the engine
// never uses it. `benchRefusal` is the decision `putLineup` now makes before it
// writes anything. Swept over every module the engine ships
// (`builtinModules`), with the limit read off each module's OWN resolved catalog
// — never off a sport-name list.
//
// Owner scope (2026-10-16): ONLY `benchMax: 0` is refused. A catalog with
// `benchMax > 0` keeps its soft `bench_size` warning when the bench runs over,
// and the sweep below pins that: widening the refusal to every `benchMax`
// is a separate decision that would turn the over-limit case here red.
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { validateLineup } from "@seazn/engine/sport";
import type { AnySportModule, PositionCatalog } from "@seazn/engine/sport";
import { benchRefusal, lineupCatalogFor } from "../lineup-catalog";

/** Every sport once (the latest module of each key), with its RESOLVED catalog. */
const SPORTS: readonly { module: AnySportModule; catalog: PositionCatalog }[] = [
  ...new Map(builtinModules.map((m) => [m.key, m])).values(),
].map((module) => ({ module, catalog: lineupCatalogFor(module, {}) }));

const starting = (n: number) => Array.from({ length: n }, () => ({ slot: "starting" }));
const bench = (n: number) => Array.from({ length: n }, () => ({ slot: "bench" }));

describe("benchRefusal — the bench a catalog does not have", () => {
  it("premise: the registry has sports on both sides of the line, and the known no-bench trio is among them", () => {
    const noBench = SPORTS.filter((s) => s.catalog.lineup.benchMax === 0).map((s) => s.module.key);
    const withBench = SPORTS.filter((s) => (s.catalog.lineup.benchMax ?? 0) > 0);
    // Anti-vacuity: a registry where nothing is refused would pass every sweep below.
    expect(SPORTS.length).toBeGreaterThanOrEqual(11);
    expect(withBench.length).toBeGreaterThan(0);
    // The owner's named premise for this fix (boardgame, carrom, generic). If a catalog
    // starts declaring a bench, this says so instead of the sweep quietly shrinking.
    expect(noBench.sort()).toEqual(expect.arrayContaining(["boardgame", "carrom", "generic"]));
  });

  it("sweep: one bench row is refused exactly where the catalog declares benchMax 0 — and the refusal counts the rows", () => {
    let checked = 0;
    let refused = 0;
    for (const { module, catalog } of SPORTS) {
      const declared = catalog.lineup.benchMax;
      const one = benchRefusal(catalog, [...starting(catalog.lineup.size), ...bench(1)]);
      const three = benchRefusal(catalog, [...starting(catalog.lineup.size), ...bench(3)]);
      if (declared === 0) {
        expect(one, `${module.key}: one bench row`).toEqual({ benchRows: 1 });
        expect(three, `${module.key}: three bench rows`).toEqual({ benchRows: 3 });
        refused++;
      } else {
        // benchMax > 0, or undeclared: a single bench row is the catalog's own business.
        expect(one, `${module.key}: one bench row`).toBeNull();
      }
      checked++;
    }
    expect(checked).toBe(SPORTS.length);
    expect(refused).toBeGreaterThanOrEqual(3);
  });

  it("the empty case: no rows, and a sheet with no bench rows, are never refused — in any sport", () => {
    let checked = 0;
    for (const { module, catalog } of SPORTS) {
      expect(benchRefusal(catalog, []), `${module.key}: an empty lineup`).toBeNull();
      expect(benchRefusal(catalog, starting(catalog.lineup.size)), `${module.key}: starters only`).toBeNull();
      expect(benchRefusal(catalog, starting(catalog.lineup.size + 2)), `${module.key}: too many starters is not a bench matter`).toBeNull();
      checked++;
    }
    expect(checked).toBe(SPORTS.length);
  });

  it("scope pin: a bench over a POSITIVE benchMax is still only the soft bench_size warning, never this refusal", () => {
    let checked = 0;
    for (const { module, catalog } of SPORTS) {
      const declared = catalog.lineup.benchMax;
      if (declared === undefined || declared === 0) continue;
      const over = [...starting(catalog.lineup.size), ...bench(declared + 1)];
      expect(benchRefusal(catalog, over), `${module.key}: ${declared + 1} on a bench of ${declared}`).toBeNull();
      // ...and the engine's validator is what still says so, as a warning.
      const lineup = {
        entrantId: "e",
        slots: over.map((s, i) => ({ personId: `p${i}`, slot: s.slot as "starting" | "bench", orderNo: i + 1 })),
      };
      expect(
        validateLineup(catalog, lineup).some((i) => i.kind === "bench_size"),
        `${module.key}: validateLineup still warns`,
      ).toBe(true);
      // At the limit it is neither refused nor warned about.
      const atLimit = [...starting(catalog.lineup.size), ...bench(declared)];
      expect(benchRefusal(catalog, atLimit), `${module.key}: a full bench of ${declared}`).toBeNull();
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("an undeclared benchMax is not zero: a catalog with no benchMax takes any bench", () => {
    const open: PositionCatalog = { groups: [], lineup: { size: 1 } };
    expect(open.lineup.benchMax).toBeUndefined();
    expect(benchRefusal(open, [...starting(1), ...bench(2)])).toBeNull();
  });

  it("counts every bench row, whatever else is on the row (a coach is as much a bench row as a player)", () => {
    const none: PositionCatalog = { groups: [], lineup: { size: 1, benchMax: 0 } };
    const rows = [{ slot: "starting" }, { slot: "bench", role: "coach" }, { slot: "bench", role: "player" }, { slot: "bench", role: "staff" }];
    expect(benchRefusal(none, rows)).toEqual({ benchRows: 3 });
  });
});
