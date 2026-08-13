// THE S11/#420 GATE. A skin is a hand-crafted layout; the thing that makes it
// safe to hand-craft is that it can never quietly render LESS than the sport
// declares. Every skin, every sport it claims, every cfg in that sport's whole
// cfg space: the skin must place exactly the action set the universal renderer
// would reach — no drops, no inventions, no duplicates.
//
// Why the sweep feeds the skin a gate-free view rather than a live one: panel
// gates are a "what to show right now" concern (tennis's gameAward is gated on
// not being in a tiebreak; hockey's shootout on state.phase === SHOOTOUT), so
// measuring reach against a live view would measure the fabricated state, not
// the skin. `fullView` therefore keeps allActionViews as the single authority
// for band/entitlement filtering — this file never re-implements that rule,
// because two copies of it would drift exactly the way this repo's two
// vocabulary lookup paths did.
//
// Collection safety, S10's recorded trap: the sweep collects problems as DATA
// and throws nothing; every expect() lives inside an it(). A mutant that breaks
// collection scores as "no tests ran", not as a red — so the numbers stay
// comparable to baseline.
import { describe, expect, it } from "vitest";
import type { AnySportModule, PadSpec } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { allActionViews, type PadView } from "../view-model";
import { SKINS, skinFor } from "../skins/registry";
import { createSkinDispatch, layoutActionTypes, layoutActionTypesAt, type SkinDef } from "../skins/types";
import { cfgSpace, grantAllEntitlements } from "./_cfg-space";

const FULL_BAND = 3 as const;

/** The action set a skin is held to, panel structure preserved, gates and
 *  phase ignored. Band/entitlement filtering comes from allActionViews alone. */
function fullView(spec: PadSpec, ctx: { band: typeof FULL_BAND; entitlements: Record<string, boolean> }): PadView {
  const resolved = allActionViews(spec, ctx);
  const byType = new Map(resolved.map((action) => [action.type, action]));
  const panels = spec.panels
    .map((panel) => ({
      labelKey: panel.labelKey,
      phase: panel.phase,
      layout: panel.layout,
      actions: panel.actions.map((action) => byType.get(action.type)).filter((a) => a !== undefined),
    }))
    .filter((panel) => panel.actions.length > 0);
  return { phase: "live", phases: ["pre", "live", "post"], panels };
}

interface Problem {
  skin: string;
  sport: string;
  cfg: string;
  kind: "missing" | "invented" | "duplicated" | "no-header";
  detail: string;
}

function moduleFor(sport: string): AnySportModule | undefined {
  return (builtinModules as readonly AnySportModule[]).find((m) => m.key === sport);
}

/** One sweep, reused by every it() below — walked once at module scope would
 *  risk collection-time throws, so it is a plain function called inside tests. */
function sweep(): { problems: Problem[]; sportsSwept: number; cfgsSwept: number; actionsChecked: number } {
  const problems: Problem[] = [];
  let sportsSwept = 0;
  let cfgsSwept = 0;
  let actionsChecked = 0;

  for (const skin of SKINS) {
    for (const sport of skin.sports) {
      const module = moduleFor(sport);
      if (!module) continue; // registry integrity is its own it()
      sportsSwept += 1;
      for (const cfg of cfgSpace(module)) {
        const spec = module.padSpec?.(cfg);
        if (!spec) continue;
        cfgsSwept += 1;
        const entitlements = grantAllEntitlements(spec);
        const ctx = { band: FULL_BAND, entitlements };
        const view = fullView(spec, ctx);
        const expected = new Set(allActionViews(spec, ctx).map((action) => action.type));
        actionsChecked += expected.size;

        const layout = skin.layout(view, { cfg, state: {}, summary: {}, band: FULL_BAND });
        const placed = layoutActionTypes(layout);
        const placedSet = new Set(placed);
        const cfgId = JSON.stringify(cfg).slice(0, 120);

        for (const type of expected) {
          if (!placedSet.has(type)) {
            problems.push({ skin: skin.key, sport, cfg: cfgId, kind: "missing", detail: type });
          }
        }
        for (const type of placedSet) {
          if (!expected.has(type)) {
            problems.push({ skin: skin.key, sport, cfg: cfgId, kind: "invented", detail: type });
          }
        }
        if (placed.length !== placedSet.size) {
          const seen = new Set<string>();
          const dupes = placed.filter((type) => (seen.has(type) ? true : (seen.add(type), false)));
          problems.push({ skin: skin.key, sport, cfg: cfgId, kind: "duplicated", detail: [...new Set(dupes)].join(", ") });
        }
        if (layout.header === null || layout.header.fields.length === 0) {
          problems.push({ skin: skin.key, sport, cfg: cfgId, kind: "no-header", detail: "score header absent" });
        }
      }
    }
  }
  return { problems, sportsSwept, cfgsSwept, actionsChecked };
}

function format(problems: readonly Problem[], kind: Problem["kind"]): string[] {
  return problems.filter((p) => p.kind === kind).map((p) => `${p.skin}/${p.sport} [${p.cfg}] ${p.detail}`);
}

describe("skin coverage", () => {
  it("sweeps every skin's sports across the whole cfg space", () => {
    const { sportsSwept, cfgsSwept, actionsChecked } = sweep();
    // Guards the sweep itself: a walk that silently stops finding sports or
    // cfgs would make every assertion below vacuously green.
    expect(sportsSwept).toBe(8);
    expect(cfgsSwept).toBeGreaterThan(50);
    expect(actionsChecked).toBeGreaterThan(200);
  });

  it("no skin hides an action its sport declares", () => {
    expect(format(sweep().problems, "missing")).toEqual([]);
  });

  it("no skin renders an action its sport does not declare", () => {
    expect(format(sweep().problems, "invented")).toEqual([]);
  });

  it("no skin places the same action twice", () => {
    expect(format(sweep().problems, "duplicated")).toEqual([]);
  });

  it("every skin draws a score header for every variant", () => {
    // S10 shipped the universal pad with no score header of its own — "a
    // scorer sees actions but not the state they are scoring". Owner ruled
    // 2026-08-13 that each skin answers this natively.
    expect(format(sweep().problems, "no-header")).toEqual([]);
  });
});

describe("skin registry", () => {
  it("claims only sports that exist, and claims each at most once", () => {
    const claimed = SKINS.flatMap((skin) => skin.sports);
    const unknown = claimed.filter((sport) => !moduleFor(sport));
    const duplicated = claimed.filter((sport, i) => claimed.indexOf(sport) !== i);
    expect({ unknown, duplicated }).toEqual({ unknown: [], duplicated: [] });
  });

  it("leaves sports without a hand-crafted layout on the universal renderer", () => {
    // Deliberate, not an omission: the universal renderer guarantees coverage,
    // and these sports do not carry the match volume that earns a skin.
    expect(skinFor("generic")).toBeNull();
    expect(skinFor("carrom")).toBeNull();
  });

  it("routes each claimed sport to the skin that owns it", () => {
    const routed = Object.fromEntries(
      SKINS.flatMap((skin) => skin.sports.map((sport) => [sport, skinFor(sport)?.key])),
    );
    expect(routed).toEqual({
      cricket: "cricket",
      volleyball: "racquet",
      badminton: "racquet",
      tabletennis: "racquet",
      tennis: "tennis",
      football: "football",
      hockey: "period",
      icehockey: "period",
    });
  });
});

describe("skin dispatch", () => {
  const view: PadView = {
    phase: "live",
    phases: ["live"],
    panels: [
      {
        labelKey: { key: "x", fallback: "X" } as never,
        phase: "live",
        layout: "primary" as never,
        actions: [{ type: "cricket.ball", labelKey: {} as never, fields: [], attribution: [], availability: { kind: "available" } }],
      },
    ],
  };

  it("passes an action the view declares straight through to the chassis", async () => {
    const sent: string[] = [];
    const dispatch = createSkinDispatch(view, async (type) => void sent.push(type));
    await dispatch("cricket.ball", { runs: 1 });
    expect(sent).toEqual(["cricket.ball"]);
  });

  it("refuses an action the spec does not declare", async () => {
    const sent: string[] = [];
    const dispatch = createSkinDispatch(view, async (type) => void sent.push(type));
    await expect(dispatch("cricket.invented", {})).rejects.toThrow(/does not declare/);
    expect(sent).toEqual([]);
  });
});

describe("skin headline actions reach the primary surface", () => {
  // Presence is not ergonomics: a cricket skin that reaches `cricket.ball`
  // only from a drawer passes "renders every action" while failing the brief.
  const HEADLINE: Record<string, string> = {
    cricket: "cricket.ball",
    volleyball: "volleyball.rally",
    badminton: "badminton.rally",
    tabletennis: "tabletennis.rally",
    tennis: "tennis.point",
    football: "football.goal",
    hockey: "hockey.goal",
    icehockey: "icehockey.goal",
  };

  it("draws each sport's headline action at primary prominence", () => {
    const misplaced: string[] = [];
    for (const [sport, headline] of Object.entries(HEADLINE)) {
      const skin = skinFor(sport) as SkinDef | null;
      const module = moduleFor(sport);
      if (!skin || !module) {
        misplaced.push(`${sport}: no skin or module`);
        continue;
      }
      const cfg = cfgSpace(module)[0];
      const spec = module.padSpec?.(cfg);
      if (!spec) {
        misplaced.push(`${sport}: no padSpec`);
        continue;
      }
      const ctx = { band: FULL_BAND, entitlements: grantAllEntitlements(spec) };
      const layout = skin.layout(fullView(spec, ctx), { cfg, state: {}, summary: {}, band: FULL_BAND });
      if (!layoutActionTypesAt(layout, "primary").includes(headline)) {
        misplaced.push(`${sport}: ${headline} not primary`);
      }
    }
    expect(misplaced).toEqual([]);
  });
});
