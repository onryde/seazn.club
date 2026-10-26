// Mutation-debt kills for the three thin set-based wrappers (volleyball.ts,
// badminton.ts, tabletennis.ts): the declarations each sport states over the
// shared kernel — lineup policy, labels, tiebreakers, stat metrics, positions,
// entrant model, variants — and volleyball's scoresheet template. Expected
// values come from the federation rules and spec 04 §3-§5, never from the
// module under test.
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import type { Lineup, LineupPair, LineupSlot } from "../../core/types.ts";
import { effectiveEntrantModel } from "../../sport/entrant-model.ts";
import { aggregatePlayerStats } from "../../stats/stats.ts";
import { makeEnvelope } from "../../testkit/helpers.ts";
import { badminton } from "./badminton.ts";
import { tabletennis } from "./tabletennis.ts";
import { volleyball } from "./volleyball.ts";

const STRICT_ALL = { strictFromSeq: 0 } as const;
const MODS = [volleyball, badminton, tabletennis] as const;
type ModKey = "volleyball" | "badminton" | "tabletennis";

const ev = (seq: number, type: string, payload: unknown): EventEnvelope =>
  makeEnvelope(seq, { type, payload });

describe("set-based wrappers — declared labels and cascade", () => {
  it("states each sport's own unit in the standings and player-profile labels", () => {
    // spec 04 §3.4/§4/§5 — volleyball counts Sets, badminton and table tennis Games.
    const unit = { volleyball: "Sets", badminton: "Games", tabletennis: "Games" } as const;
    let checked = 0;
    for (const mod of MODS) {
      const many = unit[mod.key as ModKey];
      const labels = Object.fromEntries(mod.metrics.map((m) => [m.key, m.label]));
      expect(labels["sets_won"]).toBe(`${many} won`);
      expect(labels["sets_lost"]).toBe(`${many} lost`);
      const folded = mod.playerStats?.folded?.keys ?? [];
      expect(folded.find((k) => k.key === "sets_won")?.label).toBe(`${many} won`);
      expect(folded.find((k) => k.key === "sets_lost")?.label).toBe(`${many} lost`);
      checked += 1;
    }
    expect(checked).toBe(3);
  });

  it("declares the points → wins → set ratio → point ratio → h2h cascade", () => {
    // spec 04 §3.4 (volleyball), §4 (badminton), §5 (table tennis) — the same five keys, in order.
    for (const mod of MODS) {
      expect(mod.defaultTiebreakers).toEqual([
        "points",
        "wins",
        "set_ratio",
        "point_ratio",
        "h2h_points",
      ]);
    }
  });

  it("names the scoring official per doc 13 §1 and the set-based entrant shapes", () => {
    expect(volleyball.officialLabel).toEqual({ scorer: "Referee" });
    expect(badminton.officialLabel).toEqual({ scorer: "Umpire" });
    expect(tabletennis.officialLabel).toEqual({ scorer: "Umpire" });
    // Volleyball: teams (with squad numbers and a captain) or beach pairs.
    expect(volleyball.entrantModel?.kinds).toEqual(["team", "pair"]);
    expect(effectiveEntrantModel(volleyball.entrantModel)).toMatchObject({
      defaultKind: "team",
      squadNumbers: true,
      captain: true,
    });
  });
});

describe("set-based wrappers — player stat metrics", () => {
  // Jul3/07 §3 — points credit the rally's scorer, serves its server, sanctions the carded person.
  const expected = {
    volleyball: { card: "Sanctions" },
    badminton: { card: "Cards" },
    tabletennis: { card: "Cards" },
  } as const;

  it("declares exactly the points / serves / sanctions metrics, per sport", () => {
    for (const mod of MODS) {
      const own = mod.playerStats!.metrics.filter((m) => m.key !== "points_won");
      expect(own.map(({ when: _when, ...m }) => m)).toEqual([
        { key: "points", label: "Points", from: `${mod.key}.rally`, field: "scorer", agg: "count" },
        { key: "serves", label: "Serves", from: `${mod.key}.rally`, field: "server", agg: "count" },
        {
          key: "sanctions",
          label: expected[mod.key as ModKey].card,
          from: `${mod.key}.sanction`,
          field: "person",
          agg: "count",
        },
      ]);
    }
  });

  it("credits the scorer, the server and the carded person from the real events", () => {
    let checked = 0;
    for (const mod of MODS) {
      const events = [
        ev(1, `${mod.key}.rally`, { wonBy: "H", scorer: "p-scorer", server: "p-server" }),
        ev(2, `${mod.key}.rally`, { wonBy: "H", scorer: "p-scorer", server: "p-server" }),
        ev(3, `${mod.key}.sanction`, { level: "warning", person: "p-carded" }),
      ];
      const rows = aggregatePlayerStats(events, mod.playerStats!);
      const stat = (id: string, key: string) =>
        rows.find((r) => r.personId === id)?.stats[key];
      expect(stat("p-scorer", "points")).toBe(2);
      expect(stat("p-server", "serves")).toBe(2);
      expect(stat("p-carded", "sanctions")).toBe(1);
      // The scorer is not credited a serve and the server no point.
      expect(stat("p-scorer", "serves") ?? 0).toBe(0);
      expect(stat("p-server", "points") ?? 0).toBe(0);
      checked += 1;
    }
    expect(checked).toBe(3);
  });
});

describe("set-based wrappers — lineup policy", () => {
  it("declares each sport's re-entry rule (FIVB 15.6 once + position lock; BWF/ITTF none)", () => {
    const vb = volleyball.lineupPolicy!(volleyball.configSchema.parse({}));
    expect(vb).toEqual({
      reentry: "once",
      reentryPositionLock: true,
      allowSquadGrowth: false,
      exemptions: { libero: { requiresRole: "libero" } },
    });
    for (const mod of [badminton, tabletennis]) {
      expect(mod.lineupPolicy!(mod.configSchema.parse({}))).toEqual({
        reentry: "none",
        reentryPositionLock: false,
        allowSquadGrowth: false,
      });
    }
  });

  it("badminton and table tennis admit nobody off the team sheet (BWF Law 16 / ITTF: no substitute)", () => {
    let checked = 0;
    for (const mod of [badminton, tabletennis]) {
      const cfg = mod.configSchema.parse({});
      const lineups: LineupPair = {
        home: { entrantId: "H", slots: [{ personId: "H-a", slot: "starting", orderNo: 1 }] },
        away: { entrantId: "A", slots: [{ personId: "A-a", slot: "starting", orderNo: 1 }] },
      };
      const events = [
        ev(1, "core.start", {}),
        ev(2, "core.lineup.entry", {
          side: "H",
          on: { personId: "H-ghost", slot: "starting", orderNo: 2 },
        }),
      ];
      expect(() => foldMatch(mod, cfg, lineups, events, STRICT_ALL)).toThrow(EngineError);
      expect(() => foldMatch(mod, cfg, lineups, events, STRICT_ALL)).toThrow(/not on the team sheet/);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  describe("volleyball — an ordinary substitute may return once, and once only (FIVB 15.6)", () => {
    const side = (entrantId: string): Lineup => {
      const court = ["S", "OH", "MB", "OPP", "OH", "MB"];
      const slots: LineupSlot[] = court.map((positionKey, i) => ({
        personId: `${entrantId}-p${i + 1}`,
        positionKey,
        slot: "starting",
        orderNo: i + 1,
      }));
      slots.push({ personId: `${entrantId}-b1`, slot: "bench", orderNo: 7 });
      return { entrantId, slots };
    };
    const lineups: LineupPair = { home: side("H"), away: side("A") };
    const cfg = volleyball.configSchema.parse({});
    const swap = (seq: number, off: string, on: string, orderNo: number) =>
      ev(seq, "core.lineup.substitution", {
        side: "H",
        off,
        on: { personId: on, positionKey: "S", slot: "starting", orderNo },
      });
    const start = ev(1, "core.start", {});
    const out = swap(2, "H-p1", "H-b1", 7); // b1 replaces p1 at S
    const back = swap(3, "H-b1", "H-p1", 1); // p1's first return, to S
    const again = swap(4, "H-p1", "H-b1", 7); // b1's first return, to S
    const second = swap(5, "H-b1", "H-p1", 1); // p1's SECOND return

    it("permits the first return to the position left", () => {
      const state = foldMatch(volleyball, cfg, lineups, [start, out, back], STRICT_ALL);
      expect(state.squads!.home.subsUsed).toBe(2);
    });

    it("refuses the second return", () => {
      expect(() =>
        foldMatch(volleyball, cfg, lineups, [start, out, back, again], STRICT_ALL),
      ).not.toThrow();
      expect(() =>
        foldMatch(volleyball, cfg, lineups, [start, out, back, again, second], STRICT_ALL),
      ).toThrow(/already returned once/);
    });
  });
});

describe("volleyball — positions", () => {
  it("states the FIVB S/OH/MB/OPP/L catalog, the libero role and a six-on-court lineup", () => {
    // volleyball.md §5 — five position groups, one libero role (up to 2 per team), 6 on court + 8 bench.
    expect(volleyball.positions.groups).toEqual([
      { key: "S", name: "Setter" },
      { key: "OH", name: "Outside hitter" },
      { key: "MB", name: "Middle blocker" },
      { key: "OPP", name: "Opposite" },
      { key: "L", name: "Libero" },
    ]);
    expect(volleyball.positions.roles).toEqual([{ key: "libero", name: "Libero" }]);
    expect(volleyball.positions.lineup).toEqual({ size: 6, benchMax: 8 });
  });
});

describe("table tennis — declared variants", () => {
  it("serves bo5 (default), bo7 for finals and hardbat-21", () => {
    // ITTF: best of 5 or 7 games; hardbat/social play to 21 (variant comment, spec 04 §5).
    expect(Object.keys(tabletennis.variants)).toEqual(["bo5", "bo7", "hardbat-21"]);
    const cfgOf = (v: keyof typeof tabletennis.variants) =>
      tabletennis.configSchema.parse(tabletennis.variants[v]);
    expect(cfgOf("bo5").bestOf).toBe(5);
    expect(cfgOf("bo7").bestOf).toBe(7);
    expect(cfgOf("bo7").setTo).toBe(11);
    expect(cfgOf("hardbat-21")).toMatchObject({ bestOf: 5, setTo: 21, finalSetTo: 21 });
  });
});

describe("volleyball — scoresheet template (Jul3/06 §3)", () => {
  const scoresheet = volleyball.exportTemplates!.scoresheet!;
  const NO_PARAMS = {} as Parameters<typeof scoresheet>[1];
  const tally = (to: number) => Array.from({ length: to }, (_u, i) => i + 1).join(" ");
  const FORM = ["Final result: ________________", "Winner: ________________"];
  const SIGNATURES = ["1st referee", "Scorer", "Captain — Aces", "Captain — Blazers"];

  it("lays out indoor best-of-5 to 25 with a deciding set to 15 when cfg states nothing", () => {
    const [section] = scoresheet({ home: "Aces", away: "Blazers" }, NO_PARAMS);
    const rows: (string | number)[][] = [];
    for (let set = 1; set <= 5; set++) {
      const to = set === 5 ? 15 : 25;
      rows.push([`Set ${set}`, "Aces", tally(to)], ["", "Blazers", tally(to)]);
    }
    expect(section).toStrictEqual({
      heading: "Aces vs Blazers",
      subheading: "",
      table: { columns: ["Set", "Team", "Points"], rows },
      formLines: FORM,
      signatures: SIGNATURES,
      columnsHint: 2,
    });
  });

  it("follows the cfg: beach is best-of-3 to 21 with a deciding set to 15", () => {
    const beach = volleyball.configSchema.parse(volleyball.variants.beach);
    const [section] = scoresheet({ home: "Aces", away: "Blazers" }, beach);
    const rows: (string | number)[][] = [];
    for (let set = 1; set <= 3; set++) {
      const to = set === 3 ? 15 : 21;
      rows.push([`Set ${set}`, "Aces", tally(to)], ["", "Blazers", tally(to)]);
    }
    expect(section!.table).toStrictEqual({ columns: ["Set", "Team", "Points"], rows });
  });

  it("joins the fixture details and shows both colour swatches", () => {
    const [section] = scoresheet(
      {
        home: "Aces",
        away: "Blazers",
        at: "10:00",
        court: "Court 1",
        stageName: "Final",
        homeColor: "#ff0000",
        awayColor: "#0000ff",
      },
      NO_PARAMS,
    );
    expect(section!.subheading).toBe("10:00 · Court 1 · Final");
    expect(section!.swatches).toStrictEqual([
      { label: "Aces", color: "#ff0000" },
      { label: "Blazers", color: "#0000ff" },
    ]);
  });

  it("skips the details that are absent and each colour that is absent", () => {
    const base = { home: "Aces", away: "Blazers" };
    const [homeOnly] = scoresheet({ ...base, court: "Court 1", homeColor: "#ff0000" }, NO_PARAMS);
    expect(homeOnly!.subheading).toBe("Court 1");
    expect(homeOnly!.swatches).toStrictEqual([{ label: "Aces", color: "#ff0000" }]);
    const [awayOnly] = scoresheet({ ...base, at: "10:00", stageName: "Final", awayColor: "#0000ff" }, NO_PARAMS);
    expect(awayOnly!.subheading).toBe("10:00 · Final");
    expect(awayOnly!.swatches).toStrictEqual([{ label: "Blazers", color: "#0000ff" }]);
    const [neither] = scoresheet(base, NO_PARAMS);
    expect(neither!.subheading).toBe("");
    expect("swatches" in neither!).toBe(false);
  });
});
