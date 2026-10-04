// The catalog templates the harness drives (W1-driving Task 13, ruling 47,
// D11). Expected values come from the product's catalog JSON read HERE as
// text, the product's templates.ts read as text (effectiveStageConfig), the
// brief's Step 0 anchors and the catalogue's own builder bodies
// (stagesForRow) — never from lib/templates.ts.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { API_ONLY_ROWS, SPORT_KEYS, stagesForRow } from "../lib/catalogue.ts";
import {
  TEMPLATE_ROW, TemplateDrifted, TemplateShapeUnsupported, UnknownTemplate, templateBodies, templateField, templateFor, templateRow,
} from "../lib/templates.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CATALOG = join(REPO, "apps/web/src/server/templates/catalog");
interface RawStage { kind: string; groups?: number; points?: unknown; config?: Record<string, unknown>; progression?: unknown }
interface RawTemplate { key: string; divisions: { sportKey: string; variantKey: string; entrantKind: string; entrantCount: number; stages: RawStage[] }[] }
/** A catalog file, parsed here — never through lib/templates.ts. */
const raw = (key: string): RawTemplate => JSON.parse(readFileSync(join(CATALOG, `${key}.json`), "utf8")) as RawTemplate;
const catalogKeys = (): string[] => readdirSync(CATALOG).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
const kindsOf = (xs: readonly { kind: string }[]) => xs.map((s) => s.kind);

const scratch: string[] = [];
afterEach(() => { for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true }); });
/** A catalog directory holding one template, as given. */
function dirWith(key: string, body: unknown): string {
  const d = mkdtempSync(join(tmpdir(), "fm-tmpl-"));
  scratch.push(d);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${key}.json`), JSON.stringify(body));
  return d;
}

describe("templateField — the product's catalog JSON, read as text (D11)", () => {
  it("empty case first: an unknown key, an empty key and a path-shaped key are refused by name, never read", () => {
    let refused = 0;
    for (const key of ["no-such-template", "", "../catalog/box-league", "box-league/../../x", "BOX LEAGUE"]) {
      expect(() => templateField(key), JSON.stringify(key)).toThrow(UnknownTemplate);
      refused++;
    }
    expect(refused).toBe(5);
  });

  it("templateField reads the product's catalog JSON as text: box-league and t20-super8", () => {
    expect(templateField("box-league")).toMatchObject({ sport: "badminton", variant: "short", entrantKind: "individual", entrantCount: 16, stageKinds: ["group"] });
    expect(templateField("t20-super8")).toMatchObject({ sport: "cricket", variant: "t20", entrantKind: "team", entrantCount: 16, stageKinds: ["group", "group", "knockout"] });
  });

  it("every catalog template answers its own file's one division, field for field (swept over the catalog)", () => {
    let checked = 0;
    for (const key of catalogKeys()) {
      const t = raw(key);
      expect(t.divisions.length, key).toBe(1);
      const d = t.divisions[0]!;
      expect(templateField(key), key).toMatchObject({ key, sport: d.sportKey, variant: d.variantKey, entrantKind: d.entrantKind, entrantCount: d.entrantCount, stageKinds: kindsOf(d.stages) });
      checked++;
    }
    expect(checked).toBe(catalogKeys().length);
    expect(checked).toBeGreaterThan(0);
  });

  it("a template whose shape the harness cannot read is refused by name: two divisions, no division, a non-numeric count", () => {
    const one = raw("box-league");
    const div = one.divisions[0]!;
    const shapes: Record<string, unknown> = {
      twoDivisions: { ...one, divisions: [div, div] },
      noDivision: { ...one, divisions: [] },
      countAsText: { ...one, divisions: [{ ...div, entrantCount: "16" }] },
      noStages: { ...one, divisions: [{ ...div, stages: [] }] },
    };
    let refused = 0;
    for (const [shape, body] of Object.entries(shapes)) {
      expect(() => templateField("box-league", dirWith("box-league", body)), shape).toThrow(TemplateShapeUnsupported);
      refused++;
    }
    expect(refused).toBe(4);
  });

  it("a second call answers the same", () => {
    expect(templateField("t20-super8")).toEqual(templateField("t20-super8"));
  });
});

describe("the API-only row each driven template builds", () => {
  it("TEMPLATE_ROW names exactly the two template-only cells' templates, and each builds its row's stage kinds (stagesForRow)", () => {
    expect(Object.keys(TEMPLATE_ROW).sort()).toEqual(["box-league", "t20-super8"]);
    let checked = 0;
    for (const key of Object.keys(TEMPLATE_ROW)) {
      const row = templateRow(key);
      expect(kindsOf(raw(key).divisions[0]!.stages), key).toEqual(kindsOf(stagesForRow(row)));
      checked++;
    }
    expect(checked).toBe(2);
    expect(templateRow("box-league")).toBe("group_only");
    expect(templateRow("t20-super8")).toBe("group_group_ko");
  });

  it("a template whose JSON changed (its stage kinds no longer its row's) is refused by name — the pin reds, the case never runs a different shape", () => {
    const one = raw("box-league");
    const drifted = { ...one, divisions: [{ ...one.divisions[0]!, stages: [{ kind: "league" }] }] };
    const e = (() => { try { templateRow("box-league", dirWith("box-league", drifted)); return null; } catch (x) { return x; } })();
    expect(e).toBeInstanceOf(TemplateDrifted);
    expect((e as Error).message).toMatch(/box-league.*group_only/);
    // A key no row is named for is refused too.
    expect(() => templateRow("slam128")).toThrow(UnknownTemplate);
  });

  it("templateFor: every API-only row × every sport — a template on exactly the two cells the catalog reaches, null elsewhere", () => {
    const found: Record<string, string> = {};
    let checked = 0;
    for (const row of API_ONLY_ROWS) {
      for (const sport of SPORT_KEYS) {
        const t = templateFor(row, sport);
        if (t !== null) found[`${row}|${sport}`] = t;
        checked++;
      }
    }
    expect(checked).toBe(API_ONLY_ROWS.length * SPORT_KEYS.length);
    expect(checked).toBeGreaterThan(0);
    // The two cells browser-driver.test.ts derives from the catalog JSON (templateOnlyCells).
    expect(found).toEqual({ "group_only|badminton": "box-league", "group_group_ko|cricket": "t20-super8" });
    expect(templateFor("league", "badminton")).toBeNull();
  });
});

describe("templateBodies — the stages the product inserts for a template (templates.ts)", () => {
  it("the product's effectiveStageConfig is still groups-sugar, then points, then config spread last", () => {
    const text = readFileSync(join(REPO, "apps/web/src/server/usecases/templates.ts"), "utf8");
    const body = text.slice(text.indexOf("export function effectiveStageConfig"), text.indexOf("export async function createFromTemplate"));
    expect(body).toContain('if (stage.kind === "group" && stage.groups !== undefined) {\n    cfg.pools = { count: stage.groups };');
    expect(body).toContain("if (stage.points !== undefined) cfg.points = stage.points;");
    expect(body).toContain("Object.assign(cfg, stage.config ?? {});");
    // And the insert writes seq si + 1, that config, and the progression verbatim (or null).
    expect(text).toContain("values (${divisionId}, ${si + 1}, ${templateStage.kind}, ${stageName},");
    expect(text).toContain("${tx.json(effectiveStageConfig(templateStage) as never)},");
    expect(text).toContain("${templateStage.progression ? tx.json(templateStage.progression as never) : null})");
  });

  it("box-league: one group stage of 4 pools; t20-super8: two groups and a knockout, each feed verbatim from the JSON", () => {
    const box = templateBodies("box-league");
    expect(box.map((b) => ({ seq: b.seq, kind: b.kind, config: b.config, progression: b.progression }))).toEqual([
      { seq: 1, kind: "group", config: { pools: { count: raw("box-league").divisions[0]!.stages[0]!.groups } }, progression: null },
    ]);
    const t20 = templateBodies("t20-super8");
    const s = raw("t20-super8").divisions[0]!.stages;
    expect(t20.map((b) => ({ seq: b.seq, kind: b.kind, config: b.config, progression: b.progression }))).toEqual([
      { seq: 1, kind: "group", config: { pools: { count: s[0]!.groups } }, progression: null },
      { seq: 2, kind: "group", config: { pools: { count: s[1]!.groups } }, progression: s[1]!.progression },
      { seq: 3, kind: "knockout", config: {}, progression: s[2]!.progression },
    ]);
    // The witnesses, read off the Step 0 anchors: 4 boxes; 4 then 2 pools.
    expect([box[0]!.config, t20[0]!.config, t20[1]!.config]).toEqual([{ pools: { count: 4 } }, { pools: { count: 4 } }, { pools: { count: 2 } }]);
  });

  it("points and a config escape hatch reach the body in the product's order (config last wins)", () => {
    const one = raw("box-league");
    const st = { kind: "group", groups: 4, points: { win: 3 }, config: { legs: 2, pools: { count: 5 } } };
    const d = dirWith("box-league", { ...one, divisions: [{ ...one.divisions[0]!, stages: [st] }] });
    expect(templateBodies("box-league", d)[0]!.config).toEqual({ pools: { count: 5 }, points: { win: 3 }, legs: 2 });
  });
});
