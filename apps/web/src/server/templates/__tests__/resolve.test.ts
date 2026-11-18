// X-BD-3: a template that names no sport of its own ("any") is resolved against what the organiser chose before it is
// instantiated. Pure: the sheet (client) and createFromTemplate (server) run the very same function, so what the sheet
// shows for a count is what the create builds.
import { describe, expect, it } from "vitest";
import { getTemplate } from "../catalog";
import { isAnyDivision, resolveTemplate, stageShapes, type TemplateChoice } from "../resolve";

const FULL: TemplateChoice = { sportKey: "badminton", variantKey: "short", entrantKind: "pair", entrantCount: 12 };

describe("resolveTemplate — an any-sport template meets the organiser's choice", () => {
  it("empty case first: no choice, and a choice with a field missing, are each refused by name (never a default sport)", () => {
    const t = getTemplate("super-groups")!;
    const cases: [string, TemplateChoice | undefined][] = [
      ["undefined", undefined],
      ["empty", {}],
      ["no sport", { ...FULL, sportKey: undefined }],
      ["no variant", { ...FULL, variantKey: undefined }],
      ["no kind", { ...FULL, entrantKind: undefined }],
    ];
    let refused = 0;
    for (const [label, choice] of cases) {
      expect(resolveTemplate(t, choice), label).toMatchObject({ ok: false, code: "TEMPLATE_CHOICE_REQUIRED" });
      refused++;
    }
    expect(refused).toBe(cases.length);
  });

  it("a full choice writes the sport, variant, kind and count into the division and narrows the division to that kind", () => {
    const t = getTemplate("super-groups")!;
    const r = resolveTemplate(t, FULL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.template.divisions[0]!;
    expect([d.sportKey, d.variantKey, d.entrantKind, d.entrantCount]).toEqual(["badminton", "short", "pair", 12]);
    // The builder narrows a division to the kind it showed (C9 Q3, n3); the template does the same.
    expect(d.cfgOverrides).toEqual({ entrants: { kinds: ["pair"], defaultKind: "pair" } });
    expect(isAnyDivision(d)).toBe(false);
    // 12 entrants: 3 pools of 4 (the rule), then the stage declares its own 2 groups.
    expect(d.stages.map((s) => s.groups)).toEqual([3, 2, undefined]);
    expect(d.stages.every((s) => s.poolSize === undefined)).toBe(true);
  });

  it("a second call answers the same and the catalog's own object is untouched", () => {
    const t = getTemplate("super-groups")!;
    const before = JSON.stringify(t);
    const a = resolveTemplate(t, FULL);
    const b = resolveTemplate(t, { ...FULL, entrantCount: 32 });
    const c = resolveTemplate(t, FULL);
    expect(JSON.stringify(t)).toBe(before);
    expect(a).toEqual(c);
    expect(b.ok && b.template.divisions[0]!.stages[0]!.groups).toBe(8);
    expect(isAnyDivision(t.divisions[0]!)).toBe(true);
  });

  it("an omitted count is the template's own default", () => {
    const r = resolveTemplate(getTemplate("super-groups")!, { ...FULL, entrantCount: undefined });
    expect(r.ok && r.template.divisions[0]!.entrantCount).toBe(16);
    expect(r.ok && r.template.divisions[0]!.stages[0]!.groups).toBe(4);
  });

  it("a fixed template takes no sport, variant or kind (refused by name), and no count either when it offers none", () => {
    const t20 = getTemplate("t20-super8")!;
    let refused = 0;
    for (const choice of [{ sportKey: "football" }, { variantKey: "t20" }, { entrantKind: "team" as const }, { entrantCount: 16 }, FULL]) {
      expect(resolveTemplate(t20, choice), JSON.stringify(choice)).toMatchObject({ ok: false, code: "TEMPLATE_CHOICE_NOT_OFFERED" });
      refused++;
    }
    expect(refused).toBe(5);
    // And every fixed catalog template resolves, with no choice, to itself.
    let checked = 0;
    for (const key of ["slam128", "swiss11", "wc32", "americano-night", "box-league", "euro24", "t20-super8", "league-playoff"]) {
      const t = getTemplate(key)!;
      const r = resolveTemplate(t, undefined);
      expect(r.ok && r.template === t, key).toBe(true);
      checked++;
    }
    expect(checked).toBe(8);
  });
});

describe("stageShapes — what the sheet says each stage is, for the chosen count", () => {
  // Rule: pools of 4 (X-BD-3); the top 2 of every pool go on to two super groups (the template's own take); the top 2 of
  // each super group make the knockout of 4. Expected values typed from that rule, not read off the resolver.
  const EXPECTED: [count: number, pools: number, superPerGroup: number][] = [
    [8, 2, 2],
    [12, 3, 3],
    [16, 4, 4],
    [24, 6, 6],
    [32, 8, 8],
  ];

  it("every offered count: pools of 4, two super groups of count/4, a knockout of 4", () => {
    let checked = 0;
    for (const [count, pools, superPerGroup] of EXPECTED) {
      const r = resolveTemplate(getTemplate("super-groups")!, { ...FULL, entrantCount: count });
      expect(r.ok, String(count)).toBe(true);
      if (!r.ok) continue;
      expect(stageShapes(r.template.divisions[0]!), `${count} entrants`).toEqual([
        { pools, perPool: 4 },
        { pools: 2, perPool: superPerGroup },
        { entrants: 4 },
      ]);
      checked++;
    }
    expect(checked).toBe(EXPECTED.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("a fixed template's shape comes from its own declaration: t20-super8 is 4 pools of 4, 2 groups of 4, a knockout of 4", () => {
    expect(stageShapes(getTemplate("t20-super8")!.divisions[0]!)).toEqual([
      { pools: 4, perPool: 4 },
      { pools: 2, perPool: 4 },
      { entrants: 4 },
    ]);
    // euro24's R16 takes 12 group qualifiers AND 4 best thirds, a take the arithmetic does not add: it is not described by
    // pools, only by its declared bracket size (no invented number).
    expect(stageShapes(getTemplate("euro24")!.divisions[0]!)).toEqual([{ pools: 6, perPool: 4 }, { entrants: 16 }]);
  });
});
