// The DocModel schema's declared shapes (engine mutation debt, exports/types.ts; Stryker leg modules-2).
//
// DocModel is parsed at run time, not only used for its inferred type: apps/web's scoresheet export
// (src/server/usecases/exports.ts, `DocModel.parse({ kind: "scoresheet", ..., pageBreaks })`) pushes every sport's declared
// scoresheet sections through it. Its producers are the engine's own builders (build.ts) and the sports' exportTemplates.
// So these tests drive the REAL producers through the schema and require the model back unchanged — a schema object
// emptied to `z.object({})` silently strips every field — and then refuse each shape the schema exists to refuse.
// Expected values come from the producers' input and the shapes' own documentation, never from a run of the schema.
import { describe, expect, it } from "vitest";
import { buildAdmitTickets, buildBracket, buildBracketDe, buildLadderPoster, buildPagePoster, buildTimetable } from "./build.ts";
import { DocModel, DocSection, PageBreaks } from "./types.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { builtinModules } from "../sports/index.ts";

const PRINTED_AT = "2026-07-20T09:00:00.000Z";
/** meta's two optional fields set, so the meta object is seen carrying all three of its declared fields. */
const OPTS = { printedAt: PRINTED_AT, footerNote: "Printed for the desk", liveUrl: "https://x/live" };

type BracketFx = { id: string; round_no: number; seq_in_round: number; home: string | null; away: string | null; headline: string | null; decided: boolean };
const bfx = (id: string, round_no: number, seq_in_round: number, home: string | null = null, away: string | null = null, headline: string | null = null): BracketFx =>
  ({ id, round_no, seq_in_round, home, away, headline, decided: headline !== null });
/** 4-entrant single elimination whose last round also holds the 3rd-place playoff (bracket-layout's twoSidedBracket: the
 *  lowest seq of the last round is the final, a second fixture there is the 3rd-place match). One semi is decided, so a
 *  node carries a non-null headline and decided: true. */
const FOUR_WITH_THIRD = [bfx("sf1", 0, 1, "A", "B", "A 2–0"), bfx("sf2", 0, 2, "C", "D"), bfx("final", 1, 1), bfx("third", 1, 2)];
/** k=2 double elimination with its grand-final reset: doubleElimBracket's rounds are WB 0..k-1, LB 2k..4k-3, GF 5k-2 and
 *  the reset 5k-1 (relative to the first round), here offset by 1. */
const DE_WITH_RESET = [bfx("wb1a", 1, 1, "A", "B", "A 2–1"), bfx("wb1b", 1, 2), bfx("wb2", 2, 1), bfx("lb1", 5, 1), bfx("lb2", 6, 1), bfx("gf", 9, 1), bfx("reset", 10, 1)];
/** IPL page playoffs: Q1 and the Eliminator, then Q2, then the Final (pagePlayoffBracket's one accepted shape). */
const PAGE_FOUR = [bfx("q1", 0, 1, "A", "B", "A by 5 runs"), bfx("elim", 0, 2), bfx("q2", 1, 1), bfx("fin", 2, 1)];
const LANES = { winners: "Winners", losers: "Losers", grandFinal: "Grand final", reset: "Reset" };
const SLOTS = { q1: "Qualifier 1", eliminator: "Eliminator", q2: "Qualifier 2", final: "Final" };

/** One model per bracket-family payload plus the admit-ticket sheet, each straight from its real builder. */
function producedModels(): { name: string; model: DocModel }[] {
  return [
    { name: "buildBracket", model: buildBracket("Cup", FOUR_WITH_THIRD, (fromEnd) => `Round -${fromEnd}`, OPTS) },
    { name: "buildBracketDe", model: buildBracketDe("Cup", DE_WITH_RESET, LANES, OPTS) },
    { name: "buildLadderPoster", model: buildLadderPoster("Cup", [bfx("r1", 0, 1, "A", "B", "A won"), bfx("r2", 1, 1)], (i) => `Rung ${i + 1}`, OPTS) },
    { name: "buildPagePoster", model: buildPagePoster("Cup", PAGE_FOUR, SLOTS, OPTS) },
    { name: "buildAdmitTickets", model: buildAdmitTickets("Tickets", [
      { maskedName: "A. B.", competition: "Cup", dates: "1 Aug", ref: "R1", status: "PAID", qrUrl: "https://x/r/R1", seq: 1 },
    ], OPTS) },
  ];
}

/** A minimal model with the declared required fields only (types.ts: kind, title, meta.printedAt, sections). */
function minimal(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: "timetable", title: "T", meta: { printedAt: PRINTED_AT }, sections: [], ...extra };
}

function at(root: unknown, path: readonly (string | number)[]): Record<string, unknown> {
  let node = root;
  for (const step of path) node = (node as Record<string | number, unknown>)[step];
  expect(node, `path ${path.join(".")} reaches an object`).toBeTypeOf("object");
  return node as Record<string, unknown>;
}

describe("DocModel keeps every field a builder writes (a real producer through the schema, mutation-debt modules-2)", () => {
  it("each bracket-family payload and the admit-ticket sheet parse back unchanged, and a second parse changes nothing", () => {
    let checked = 0;
    for (const { name, model } of producedModels()) {
      expect(DocModel.parse(model), name).toStrictEqual(model);
      expect(DocModel.parse(DocModel.parse(model)), `${name} (second parse)`).toStrictEqual(model);
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("the produced payloads are not vacuous: every list the round-trip relies on is non-empty, both DE lanes have connectors", () => {
    // A `z.object({})` mutant on a connector or node only shows on a list that HAS an element; pin that they do.
    const [single, de, ladder, page, tickets] = producedModels().map((p) => p.model);
    expect(single!.bracket!.nodes.length).toBeGreaterThan(0);
    expect(single!.bracket!.connectors.length).toBeGreaterThan(0);
    expect(single!.bracket!.thirdPlaceId).toBe("third");
    expect(de!.bracketDe!.nodes.length).toBeGreaterThan(0);
    expect(new Set(de!.bracketDe!.connectors.map((c) => c.lane))).toEqual(new Set(["WB", "LB"]));
    expect(de!.bracketDe!.resetId).toBe("reset");
    expect(ladder!.ladder!.rungs.length).toBe(2);
    expect(page!.pagePlayoff!.nodes.length).toBe(4);
    expect(tickets!.sections[0]!.ticket).toBeDefined();
    for (const m of [single, de, ladder, page, tickets]) {
      expect(m!.meta).toStrictEqual({ printedAt: PRINTED_AT, footerNote: OPTS.footerNote, liveUrl: OPTS.liveUrl });
    }
  });

  it("refuses each produced object with any one of its required fields dropped (only the documented optionals may go)", () => {
    // [model index, path to the object, keys the shape documents as optional]. thirdPlaceId / resetId: "set only when the
    // layout has one" (build.ts conditional spreads); footerNote / liveUrl: optional meta (BuildOpts). Every other key the
    // builder writes is required, and dropping it must be refused.
    const objects: [number, (string | number)[], string[]][] = [
      [0, ["bracket"], ["thirdPlaceId"]],
      [0, ["bracket", "nodes", 0], []],
      [0, ["bracket", "connectors", 0], []],
      [1, ["bracketDe"], ["resetId"]],
      [1, ["bracketDe", "nodes", 0], []],
      [1, ["bracketDe", "connectors", 0], []],
      [1, ["bracketDe", "laneLabels"], []],
      [2, ["ladder"], []],
      [2, ["ladder", "rungs", 0], []],
      [3, ["pagePlayoff"], []],
      [3, ["pagePlayoff", "nodes", 0], []],
      [3, ["pagePlayoff", "slotLabels"], []],
      [4, ["sections", 0, "ticket"], []],
      [4, ["meta"], ["footerNote", "liveUrl"]],
    ];
    let refused = 0;
    for (const [index, path, optional] of objects) {
      const model = producedModels()[index]!.model;
      const keys = Object.keys(at(model, path)).filter((k) => !optional.includes(k));
      expect(keys.length, `${path.join(".")} has required keys to drop`).toBeGreaterThan(0);
      for (const key of keys) {
        const broken = structuredClone(model);
        delete at(broken, path)[key];
        expect(DocModel.safeParse(broken).success, `${path.join(".")} without ${key}`).toBe(false);
        refused++;
      }
      // the positive pair: dropping a documented optional is accepted
      for (const key of optional) {
        const trimmed = structuredClone(model);
        delete at(trimmed, path)[key];
        expect(DocModel.safeParse(trimmed).success, `${path.join(".")} without optional ${key}`).toBe(true);
      }
    }
    expect(refused).toBeGreaterThanOrEqual(objects.length);
  });

  it("an empty input is refused: no model, an empty object, and a meta with no printedAt", () => {
    expect(DocModel.safeParse(undefined).success).toBe(false);
    expect(DocModel.safeParse({}).success).toBe(false);
    expect(DocModel.safeParse(minimal({ meta: {} })).success).toBe(false);
    expect(DocModel.parse(minimal())).toStrictEqual({ ...minimal(), pageBreaks: "auto" });
  });
});

describe("every sport's declared scoresheet through DocModel, as the app's scoresheet export parses it", () => {
  it("each sport that declares a scoresheet template yields sections the schema keeps unchanged, for every declared cfg", () => {
    let sheets = 0;
    const visited = forEachSport(({ module }) => {
      const scoresheet = module.exportTemplates?.scoresheet;
      if (scoresheet === undefined) return; // a sport with no bespoke sheet gets apps/web's generic result form instead
      for (const { name, cfg } of declaredCfgs(module)) {
        for (const blank of [false, true]) {
          const sections = scoresheet(
            { home: "Falcons", away: "Hawks", homeColor: "#ff0000", awayColor: "#0000ff", at: "09:00", court: "Court 1", stageName: "Pool A", blank },
            cfg as never,
          );
          expect(sections.length, `${module.key}/${name}`).toBeGreaterThan(0);
          const model = { kind: "scoresheet" as const, title: "Cup", meta: { printedAt: PRINTED_AT }, sections, pageBreaks: "per_pitch" as const };
          expect(DocModel.parse(model), `${module.key}/${name}`).toStrictEqual(model);
          sheets++;
        }
      }
    });
    expect(visited).toBe(builtinModules.length);
    expect(sheets, "at least one shipped sport declares a scoresheet template").toBeGreaterThan(0);
  });
});

describe("PageBreaks — the page-break modes", () => {
  // The four modes the v1 export route offers (apps/web openapi.ts `pageBreaks` enum and the export route's own Breaks
  // enum) and build.ts reads: per_pitch / per_division group a timetable, per_team splits a roster and a rota.
  const DOCUMENTED = ["auto", "per_pitch", "per_team", "per_division"] as const;

  it("accepts each documented mode and keeps it, on its own and on a model", () => {
    for (const mode of DOCUMENTED) {
      expect(PageBreaks.parse(mode)).toBe(mode);
      expect(DocModel.parse(minimal({ pageBreaks: mode })).pageBreaks).toBe(mode);
    }
    expect(new Set(PageBreaks.options)).toEqual(new Set(DOCUMENTED));
  });

  it("refuses an empty, an unknown and a wrongly cased mode", () => {
    for (const bad of ["", "per_court", "AUTO", "per-team"]) {
      expect(PageBreaks.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
      expect(DocModel.safeParse(minimal({ pageBreaks: bad })).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("a model with no mode gets the builders' own default, and an explicit mode is not overwritten by it", () => {
    // The builders write `opts.pageBreaks ?? "auto"` (build.ts base()); the schema's default must agree with them.
    const builderDefault = buildTimetable("T", [], { printedAt: PRINTED_AT }).pageBreaks;
    expect(builderDefault).toBe("auto");
    expect(DocModel.parse(minimal()).pageBreaks).toBe(builderDefault);
    expect(DocModel.parse(minimal({ pageBreaks: "per_team" })).pageBreaks).toBe("per_team");
  });
});

describe("DocSection.columnsHint — sections per page", () => {
  it("accepts 1 (one per page) and 2 (two per A4, the 12 Jun scoresheet and the admit ticket) and keeps them", () => {
    expect(DocSection.parse({ columnsHint: 1 })).toStrictEqual({ columnsHint: 1 });
    expect(DocSection.parse({ columnsHint: 2 })).toStrictEqual({ columnsHint: 2 });
    expect(DocSection.parse({})).toStrictEqual({});
  });

  it("refuses 0, 3 (a page holds at most two), a fraction and a negative", () => {
    for (const bad of [0, 3, 1.5, -1]) {
      expect(DocSection.safeParse({ columnsHint: bad }).success, String(bad)).toBe(false);
    }
  });
});
