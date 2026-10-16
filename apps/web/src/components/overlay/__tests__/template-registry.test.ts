// The template registry (owner answer 18 / Q7; spec 2026-10-15 §4.4 and §4.7, R2007).
//
// THE TRAP THIS FILE IS WRITTEN AROUND. Both shipped templates are `sports: "all"` and neither is retired, so a test
// written against `OVERLAY_TEMPLATES` alone cannot reach the suitability filter, the retired chain, or its cycle guard —
// each would survive deletion. The injected registries below are what make those branches reachable; the FUNCTIONS
// under test are the shipped ones, and only their input tables are local.
//
// Every expected value here is typed from the spec (§3's default rule, §4.4's resolution rules, the step 9b card rule
// and its constants), never read back from a call.
import { describe, expect, it } from "vitest";
import { OVERLAY_SPORT_KEYS } from "../overlay-tokens";
import {
  CARD_CLEARANCE_PX,
  CARD_INSET,
  CARD_MIN_H,
  CARD_MIN_W,
  OVERLAY_TEMPLATES,
  cardRegionFor,
  defaultTemplateFor,
  resolveTemplate,
  resolveTemplateFrom,
  templateParam,
  templatesForSport,
  templatesForSportFrom,
  type CanvasBox,
  type OverlayTemplateDef,
  type TemplateRegistry,
} from "../template-registry";

const CANVAS = { width: 1920, height: 1080 } as const;
// A stand-in component; the registry never renders here.
const Noop = () => null;

const entry = (id: string, over: Partial<OverlayTemplateDef<string>> = {}): OverlayTemplateDef<string> => ({
  ...(OVERLAY_TEMPLATES.bug as OverlayTemplateDef<string>),
  id,
  component: Noop,
  ...over,
});

describe("defaultTemplateFor — spec §3: cricket opens on the bar, every other sport on the bug", () => {
  it("over every OVERLAY_SPORT_KEYS entry", () => {
    let checked = 0;
    for (const sport of OVERLAY_SPORT_KEYS) {
      expect(defaultTemplateFor(sport), sport).toBe(sport === "cricket" ? "bar" : "bug");
      checked++;
    }
    console.log(`sports checked: ${checked}`);
    expect(checked, "anti-vacuity: no sport checked").toBeGreaterThan(0);
    expect(checked).toBe(11);
  });
});

describe("resolveTemplate — the one resolver, never throws", () => {
  const ROWS: [requested: string | undefined, sport: string, want: string, why: string][] = [
    ["bar", "football", "bar", "a valid id that is NOT the sport's default still resolves to itself"],
    ["bug", "cricket", "bug", "the other direction: cricket asked for the bug gets the bug"],
    [undefined, "cricket", "bar", "nothing asked: the sport default (cricket's is the bar)"],
    ["", "football", "bug", "an empty id is unknown: the sport default"],
    ["nope", "football", "bug", "an unknown id: the sport default, never a constant"],
    ["slate", "cricket", "bar", "decision 4: the retired ?style=slate is not a key, so it is unknown → default"],
    ["toString", "football", "bug", "Object.hasOwn: a prototype member is not a registry key"],
  ];
  for (const [requested, sport, want, why] of ROWS) {
    it(`${JSON.stringify(requested)} on ${sport} → ${want} (${why})`, () => {
      expect(() => resolveTemplate(requested, sport)).not.toThrow();
      expect(resolveTemplate(requested, sport).id).toBe(want);
    });
  }
});

describe("resolveTemplateFrom — retired chains and sport restriction, through an injected registry", () => {
  const BASE = OVERLAY_TEMPLATES as unknown as TemplateRegistry<string>;

  it("a retired entry resolves to its replacement (a stored choice keeps working)", () => {
    const reg: TemplateRegistry<string> = { ...BASE, old: entry("old", { retired: { replacedBy: "bug" } }) };
    expect(resolveTemplateFrom(reg, "old", "football", "bar").id).toBe("bug");
  });

  it("a chain a → b → bug walks to the end", () => {
    const reg: TemplateRegistry<string> = {
      ...BASE,
      a: entry("a", { retired: { replacedBy: "b" } }),
      b: entry("b", { retired: { replacedBy: "bug" } }),
    };
    expect(resolveTemplateFrom(reg, "a", "football", "bar").id).toBe("bug");
  });

  it("a cycle a ↔ b resolves to the fallback, and does not hang", () => {
    const reg: TemplateRegistry<string> = {
      ...BASE,
      a: entry("a", { retired: { replacedBy: "b" } }),
      b: entry("b", { retired: { replacedBy: "a" } }),
    };
    expect(resolveTemplateFrom(reg, "a", "football", "bar").id).toBe("bar");
  });

  it("a replacement that does not exist resolves to the fallback", () => {
    const reg: TemplateRegistry<string> = { ...BASE, old: entry("old", { retired: { replacedBy: "missing" } }) };
    expect(resolveTemplateFrom(reg, "old", "football", "bar").id).toBe("bar");
  });

  it("a sport-restricted entry: the fallback for another sport, itself for its own", () => {
    const reg: TemplateRegistry<string> = { ...BASE, only: entry("only", { sports: ["badminton"] }) };
    expect(resolveTemplateFrom(reg, "only", "cricket", "bar").id).toBe("bar");
    expect(resolveTemplateFrom(reg, "only", "badminton", "bug").id).toBe("only");
  });

  it("the fallback is the CALLER's (the sport default), not a constant", () => {
    // The differential case: same bad input, two fallbacks, two answers.
    expect(resolveTemplateFrom(BASE, "nonsense", "cricket", "bar").id).toBe("bar");
    expect(resolveTemplateFrom(BASE, "nonsense", "football", "bug").id).toBe("bug");
  });
});

describe("templatesForSportFrom — what a picker offers", () => {
  const reg: TemplateRegistry<string> = {
    bar: entry("bar", { sports: "all" }),
    old: entry("old", { retired: { replacedBy: "bar" } }),
    only: entry("only", { sports: ["badminton"] }),
    bug: entry("bug", { sports: "all" }),
  };

  it("hides the retired entry", () => {
    for (const sport of ["badminton", "cricket"]) {
      expect(templatesForSportFrom(reg, sport).map((t) => t.id), sport).not.toContain("old");
    }
  });

  it("offers a restricted entry to its sport only", () => {
    expect(templatesForSportFrom(reg, "badminton").map((t) => t.id)).toContain("only");
    expect(templatesForSportFrom(reg, "cricket").map((t) => t.id)).not.toContain("only");
  });

  it("keeps registry order", () => {
    expect(templatesForSportFrom(reg, "badminton").map((t) => t.id)).toEqual(["bar", "only", "bug"]);
    expect(templatesForSportFrom(reg, "cricket").map((t) => t.id)).toEqual(["bar", "bug"]);
  });
});

describe("every sport's default is pickable", () => {
  it("templatesForSport(sport) contains defaultTemplateFor(sport), and it is not retired", () => {
    let checked = 0;
    for (const sport of OVERLAY_SPORT_KEYS) {
      const offered = templatesForSport(sport);
      const def = offered.find((t) => t.id === defaultTemplateFor(sport));
      expect(def, `${sport}: its default is not offered`).toBeDefined();
      expect(def?.retired, `${sport}: its default is retired`).toBeUndefined();
      checked++;
    }
    console.log(`sports checked: ${checked}`);
    expect(checked, "anti-vacuity").toBeGreaterThan(0);
    expect(checked).toBe(11);
  });
});

describe("templateParam — decision 2: `template` wins when present, `style` is the alias", () => {
  const ROWS: [q: Parameters<typeof templateParam>[0], want: string | undefined][] = [
    [{ template: "bug", style: "bar" }, "bug"],
    [{ style: "bar" }, "bar"],
    [{ template: "", style: "bar" }, "bar"],
    [{ template: ["bug", "bar"] }, "bug"],
    [{ style: ["bar", "bug"] }, "bar"],
    [{}, undefined],
  ];
  for (const [q, want] of ROWS) {
    it(`${JSON.stringify(q)} → ${JSON.stringify(want)}`, () => {
      expect(templateParam(q)).toBe(want);
    });
  }
});

describe("cardRegionFor — step 9b: the largest inset strip beside the box, kept clear of it", () => {
  it("a top-left box → the strip to its RIGHT", () => {
    const box: CanvasBox = { x: 60, y: 54, width: 480, height: 600 };
    const x = 60 + 480 + CARD_CLEARANCE_PX;
    expect(cardRegionFor(box)).toEqual({
      x,
      y: CARD_INSET.top,
      width: CANVAS.width - CARD_INSET.right - x,
      height: CANVAS.height - CARD_INSET.top - CARD_INSET.bottom,
    });
  });

  it("a bottom strip → the strip ABOVE it", () => {
    const box: CanvasBox = { x: 72, y: 741, width: 1776, height: 177 };
    expect(cardRegionFor(box)).toEqual({
      x: CARD_INSET.left,
      y: CARD_INSET.top,
      width: CANVAS.width - CARD_INSET.left - CARD_INSET.right,
      height: 741 - CARD_CLEARANCE_PX - CARD_INSET.top,
    });
  });

  it("a top-right box → the strip to its LEFT; a top strip → the strip BELOW", () => {
    const right: CanvasBox = { x: 1380, y: 54, width: 480, height: 600 };
    expect(cardRegionFor(right)).toEqual({
      x: CARD_INSET.left,
      y: CARD_INSET.top,
      width: 1380 - CARD_CLEARANCE_PX - CARD_INSET.left,
      height: CANVAS.height - CARD_INSET.top - CARD_INSET.bottom,
    });
    const top: CanvasBox = { x: 72, y: 40, width: 1776, height: 177 };
    const y = 40 + 177 + CARD_CLEARANCE_PX;
    expect(cardRegionFor(top)).toEqual({
      x: CARD_INSET.left,
      y,
      width: CANVAS.width - CARD_INSET.left - CARD_INSET.right,
      height: CANVAS.height - CARD_INSET.bottom - y,
    });
  });

  it("the full canvas → null: no strip is big enough, so no card renders", () => {
    expect(cardRegionFor({ x: 0, y: 0, width: 1920, height: 1080 })).toBeNull();
  });

  it("a strip just under the minimum is refused; one at the minimum is kept", () => {
    // A box that leaves exactly one strip, to its right, CARD_MIN_W wide (then one px less).
    const fullHeight = { y: 0, height: 1080 };
    const atMin = 1920 - CARD_INSET.right - CARD_MIN_W - CARD_CLEARANCE_PX;
    expect(cardRegionFor({ x: 0, width: atMin, ...fullHeight })?.width).toBe(CARD_MIN_W);
    expect(cardRegionFor({ x: 0, width: atMin + 1, ...fullHeight })).toBeNull();
    // And a strip above, CARD_MIN_H tall (then one px less).
    const fullWidth = { x: 0, width: 1920 };
    const yAtMin = CARD_INSET.top + CARD_MIN_H + CARD_CLEARANCE_PX;
    expect(cardRegionFor({ y: yAtMin, height: 1080 - yAtMin, ...fullWidth })?.height).toBe(CARD_MIN_H);
    expect(cardRegionFor({ y: yAtMin - 1, height: 1080 - yAtMin + 1, ...fullWidth })).toBeNull();
  });

  it("for every shipped template the region exists and never intersects its box", () => {
    let checked = 0;
    for (const def of Object.values(OVERLAY_TEMPLATES)) {
      const box = def.sceneCardSafeArea;
      const region = cardRegionFor(box);
      expect(region, `${def.id}: no card region`).not.toBeNull();
      const r = region!;
      const apart =
        r.x >= box.x + box.width || r.x + r.width <= box.x || r.y >= box.y + box.height || r.y + r.height <= box.y;
      expect(apart, `${def.id}: region ${JSON.stringify(r)} intersects box ${JSON.stringify(box)}`).toBe(true);
      expect(r.width, def.id).toBeGreaterThanOrEqual(CARD_MIN_W);
      expect(r.height, def.id).toBeGreaterThanOrEqual(CARD_MIN_H);
      checked++;
    }
    console.log(`templates checked: ${checked}`);
    expect(checked, "anti-vacuity").toBeGreaterThan(0);
    // The registry's own size (review, PR #974): a third template is swept here with no edit; ≥ 2 is the floor the
    // spec's bar and bug set, so an emptied registry still fails.
    expect(checked).toBe(Object.keys(OVERLAY_TEMPLATES).length);
    expect(checked).toBeGreaterThanOrEqual(2);
  });
});

describe("the shipped registry", () => {
  it("bar and bug, each with a ui label key, a component, and the spec's slab placement", () => {
    // The spec's two are present; the registry may grow (§4.7), so the set is not pinned — each key names its own def.
    expect(Object.keys(OVERLAY_TEMPLATES)).toEqual(expect.arrayContaining(["bar", "bug"]));
    expect(Object.keys(OVERLAY_TEMPLATES).length).toBeGreaterThanOrEqual(2);
    for (const [id, def] of Object.entries(OVERLAY_TEMPLATES)) expect(def.id, id).toBe(id);
    // Spec §4.7: the slab attaches to the scorebug it belongs to — typed, so a registry edit that swaps them goes red.
    expect(OVERLAY_TEMPLATES.bar.slabPlacement).toBe("bar");
    expect(OVERLAY_TEMPLATES.bug.slabPlacement).toBe("bug");
    for (const def of Object.values(OVERLAY_TEMPLATES)) {
      expect(def.labelKey, def.id).toMatch(/^stream\.tab\./);
      expect(typeof def.component, def.id).toBe("function");
      expect(def.retired, def.id).toBeUndefined();
    }
  });
});
