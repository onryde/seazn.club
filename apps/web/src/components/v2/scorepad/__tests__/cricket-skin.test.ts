// Cricket skin tests (S11/#420 W9). This file is the per-sport complement to
// the shared `skin-coverage.test.ts` gate: that gate sweeps EVERY skin across
// its sport's whole cfg space and proves reach/no-invention structurally; this
// file proves cricket's specific, measured facts using REAL PadSpecs built
// from the actual engine module (never hand-typed fixtures) — the same
// "measure, don't assume" discipline the dispatch brief was written under.
//
// `layout()` is pure (types.ts's own contract), so every assertion here is a
// data comparison — no React, no jsdom (apps/web's vitest is `environment:
// "node"`, vitest.config.ts:71). The few facts that live in the React
// Component (name resolution, tap sequencing) are not testable here at all;
// see cricket-skin.tsx's own header comment for why, and the dispatch
// report for the tap-count reasoning.
//
// Independent-oracle discipline (reference_wrapper_delegate_parity_is_a_tautology):
// every "did the layout place the right things" assertion below compares
// `cricketSkin.layout(...)`'s output against the action set read directly off
// the REAL `view` it was given — never against a number this file invents —
// so a bug that empties both sides at once cannot read as a pass.
import { describe, expect, it } from "vitest";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { buildPadView } from "../view-model";
import { cricketSkin, buildBallPayload } from "../skins/cricket-skin";
import { createSkinDispatch, layoutActionTypes, layoutActionTypesAt, type SkinHeader } from "../skins/types";
import { cfgSpace, grantAllEntitlements } from "./_cfg-space";

const FULL_BAND = 3 as const;
type Json = Record<string, unknown>;

const cricketModule = (builtinModules as readonly AnySportModule[]).find((m) => m.key === "cricket");
if (!cricketModule || !cricketModule.padSpec) {
  throw new Error("cricket module (with padSpec) not found in builtinModules — engine export moved?");
}
const cricket = cricketModule;
const padSpecFor = cricketModule.padSpec;

type VariantName = "t20" | "odi" | "hundred" | "test";
const VARIANTS: readonly VariantName[] = ["t20", "odi", "hundred", "test"];
const PHASES = ["pre", "live", "post"] as const;

function variantPreset(name: VariantName): Json {
  const variants = cricket.variants as Record<string, Json> | undefined;
  const preset = variants?.[name];
  if (!preset) throw new Error(`cricket module has no "${name}" variant preset`);
  return preset;
}

/** Parses a real cfg: named variant preset, optionally overridden. Mirrors
 *  `_cfg-space.ts`'s own base-then-override shape so tests read the same way
 *  the shared gate's sweep does. */
function cfgFor(variant: VariantName, overrides: Json = {}): unknown {
  return cricket.configSchema.parse({ ...variantPreset(variant), ...overrides });
}

function viewFor(cfg: unknown, phase: (typeof PHASES)[number], state: unknown = {}, entitlements?: Json) {
  const spec = padSpecFor(cfg);
  const ents = (entitlements ?? grantAllEntitlements(spec)) as Record<string, boolean>;
  return buildPadView(spec, { state, summary: {}, phase, band: FULL_BAND, entitlements: ents });
}

function headerFieldMap(header: SkinHeader | null): Record<string, string> {
  expect(header).not.toBeNull();
  return Object.fromEntries((header as SkinHeader).fields.map((f) => [f.id, f.value]));
}

describe("cricketSkin definition", () => {
  it("claims exactly the cricket sport", () => {
    expect(cricketSkin.key).toBe("cricket");
    expect(cricketSkin.sports).toEqual(["cricket"]);
  });
});

// ---------------------------------------------------------------------------
// Criterion 1 + 6: every variant x every phase the spec declares. The
// independent oracle is the view's OWN action set, read straight off
// `view.panels` — not anything cricketLayout computed.
// ---------------------------------------------------------------------------
describe("layout places exactly the view's declared action types, exactly once, with a header", () => {
  const cases = VARIANTS.flatMap((variant) => PHASES.map((phase) => [variant, phase] as const));

  it.each(cases)("%s / %s phase", (variant, phase) => {
    const cfg = cfgFor(variant);
    const view = viewFor(cfg, phase);
    const expected = new Set(view.panels.flatMap((p) => p.actions.map((a) => a.type)));

    const layout = cricketSkin.layout(view, { cfg, state: {}, summary: {}, band: FULL_BAND });
    const placed = layoutActionTypes(layout);

    expect(new Set(placed)).toEqual(expected);
    expect(placed.length).toBe(new Set(placed).size); // never duplicated
    expect(layout.header).not.toBeNull();
    expect((layout.header as SkinHeader).fields.length).toBeGreaterThan(0);
  });

  // Same property, but swept across the WHOLE cfg-leaf space per variant
  // (not just the four named presets) — the exact walk skin-coverage.test.ts
  // uses, imported rather than re-implemented (module header, "one walk").
  it("holds across cricket's whole cfg-leaf space, live phase", () => {
    const problems: string[] = [];
    for (const cfg of cfgSpace(cricket)) {
      const view = viewFor(cfg, "live");
      const expected = new Set(view.panels.flatMap((p) => p.actions.map((a) => a.type)));
      const layout = cricketSkin.layout(view, { cfg, state: {}, summary: {}, band: FULL_BAND });
      const placed = layoutActionTypes(layout);
      const placedSet = new Set(placed);
      if (placed.length !== placedSet.size) problems.push(`duplicate in ${JSON.stringify(cfg).slice(0, 80)}`);
      for (const type of expected) if (!placedSet.has(type)) problems.push(`missing ${type} in ${JSON.stringify(cfg).slice(0, 80)}`);
      for (const type of placedSet) if (!expected.has(type)) problems.push(`invented ${type} in ${JSON.stringify(cfg).slice(0, 80)}`);
    }
    expect(problems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Criterion 2: cricket.ball (and its super-over sibling, once live) is
// primary, not buried.
// ---------------------------------------------------------------------------
describe("cricket.ball sits at primary prominence", () => {
  it("places cricket.ball in a primary group during live phase", () => {
    const cfg = cfgFor("t20");
    const view = viewFor(cfg, "live");
    const layout = cricketSkin.layout(view, { cfg, state: {}, summary: {}, band: FULL_BAND });
    expect(layoutActionTypesAt(layout, "primary")).toContain("cricket.ball");
  });

  it("also places cricket.superover.ball at primary prominence once a super over is actually live", () => {
    const cfg = cfgFor("t20", { superOver: true });
    const state = { phase: "super_over" };
    const view = viewFor(cfg, "live", state);
    // Sanity on the oracle itself: the gated super-over panel must actually
    // be present in the view before we can assert anything about it.
    expect(view.panels.flatMap((p) => p.actions.map((a) => a.type))).toContain("cricket.superover.ball");

    const layout = cricketSkin.layout(view, { cfg, state, summary: {}, band: FULL_BAND });
    expect(layoutActionTypesAt(layout, "primary")).toContain("cricket.superover.ball");
    expect(layoutActionTypesAt(layout, "primary")).toContain("cricket.ball");
  });
});

// ---------------------------------------------------------------------------
// Criterion 4: declare/follow-on/match-close are gated on what the VIEW
// declares (i.e. on cfg, through the spec), never on sport or variant name.
// ---------------------------------------------------------------------------
describe("declare / follow-on / match-close are absent unless the view actually declares them", () => {
  it.each(["t20", "odi", "hundred"] as const)("%s carries none of the three test-only actions", (variant) => {
    const cfg = cfgFor(variant);
    const view = viewFor(cfg, "live");
    const layout = cricketSkin.layout(view, { cfg, state: {}, summary: {}, band: FULL_BAND });
    const placed = layoutActionTypes(layout);
    expect(placed).not.toContain("cricket.innings.declare");
    expect(placed).not.toContain("cricket.followon");
    expect(placed).not.toContain("cricket.match.close");
  });

  it("test surfaces declare, follow-on and match.close (all three, since its preset enables follow-on)", () => {
    const cfg = cfgFor("test");
    const view = viewFor(cfg, "live");
    const layout = cricketSkin.layout(view, { cfg, state: {}, summary: {}, band: FULL_BAND });
    const placed = layoutActionTypes(layout);
    expect(placed).toEqual(
      expect.arrayContaining(["cricket.innings.declare", "cricket.followon", "cricket.match.close"]),
    );
  });
});

// ---------------------------------------------------------------------------
// Criterion 4 (the specifically measured trap): the hundred's 5-ball over is
// CFG-ONLY and never surfaces in PadSpec. A skin reading only the spec draws
// it wrong; this test fails on a bpo=6-hardcoded implementation and passes
// only once ctx.cfg.ballsPerOver is actually read.
// ---------------------------------------------------------------------------
describe("the hundred's over is 5 balls, read from ctx.cfg, not hardcoded", () => {
  it("formats over-progress using the cfg's own ballsPerOver", () => {
    const state = {
      innings: [{ battingSide: "home", runs: 40, wickets: 1, legalBalls: 7, closed: false, fine: null }],
    };
    const hundredCfg = cfgFor("hundred");
    const t20Cfg = cfgFor("t20");

    const hundredLayout = cricketSkin.layout(viewFor(hundredCfg, "live", state), {
      cfg: hundredCfg,
      state,
      summary: {},
      band: FULL_BAND,
    });
    const t20Layout = cricketSkin.layout(viewFor(t20Cfg, "live", state), {
      cfg: t20Cfg,
      state,
      summary: {},
      band: FULL_BAND,
    });

    // Same legalBalls (7), different ballsPerOver (5 vs 6) -> different over
    // notation: 7 balls is over 1 ball 2 at a 5-ball over, over 1 ball 1 at six.
    expect(headerFieldMap(hundredLayout.header).overs).toBe("1.2");
    expect(headerFieldMap(t20Layout.header).overs).toBe("1.1");
  });
});

// ---------------------------------------------------------------------------
// Criterion 3: header non-null for every cfg, with score/wickets/overs
// always, plus target (in a chase) and DLS par (cfg-gated) when applicable.
// ---------------------------------------------------------------------------
describe("header: score/wickets/overs always, target/dlsPar when applicable", () => {
  it("defaults to 0/0/0.0 and omits target/dlsPar when state carries no innings data", () => {
    const cfg = cfgFor("t20");
    const layout = cricketSkin.layout(viewFor(cfg, "live"), { cfg, state: {}, summary: {}, band: FULL_BAND });
    const byId = headerFieldMap(layout.header);
    expect(byId.score).toBe("0");
    expect(byId.wickets).toBe("0");
    expect(byId.overs).toBe("0.0");
    expect(byId.target).toBeUndefined();
    expect(byId.dlsPar).toBeUndefined();
  });

  it("shows the live open innings' own score/wickets/overs", () => {
    const cfg = cfgFor("odi");
    const state = {
      innings: [{ battingSide: "home", runs: 132, wickets: 4, legalBalls: 91, closed: false, fine: null }],
    };
    const layout = cricketSkin.layout(viewFor(cfg, "live", state), { cfg, state, summary: {}, band: FULL_BAND });
    const byId = headerFieldMap(layout.header);
    expect(byId.score).toBe("132");
    expect(byId.wickets).toBe("4");
    expect(byId.overs).toBe("15.1");
  });

  it("computes a plain chase target (first innings + 1) for a single-innings match with no revision", () => {
    const cfg = cfgFor("t20");
    const state = {
      innings: [
        { battingSide: "home", runs: 165, wickets: 6, legalBalls: 120, closed: true, fine: null },
        { battingSide: "away", runs: 40, wickets: 1, legalBalls: 30, closed: false, fine: null },
      ],
      revisedTarget: null,
      targetSource: null,
    };
    const layout = cricketSkin.layout(viewFor(cfg, "live", state), { cfg, state, summary: {}, band: FULL_BAND });
    const byId = headerFieldMap(layout.header);
    expect(byId.target).toBe("166");
    expect(byId.dlsPar).toBeUndefined();
  });

  it("shows a DLS-sourced number under dlsPar, not target, when cfg.dls.enabled and targetSource is dls", () => {
    const cfg = cfgFor("odi", { dls: { enabled: true, edition: "standard" } });
    const state = {
      innings: [
        { battingSide: "home", runs: 210, wickets: 8, legalBalls: 300, closed: true, fine: null },
        { battingSide: "away", runs: 40, wickets: 1, legalBalls: 60, closed: false, fine: null },
      ],
      revisedTarget: 180,
      targetSource: "dls",
    };
    const layout = cricketSkin.layout(viewFor(cfg, "live", state), { cfg, state, summary: {}, band: FULL_BAND });
    const byId = headerFieldMap(layout.header);
    expect(byId.dlsPar).toBe("180");
    expect(byId.target).toBeUndefined();
  });

  it("shows a manually-revised target under target, not dlsPar, even with cfg.dls.enabled", () => {
    const cfg = cfgFor("odi", { dls: { enabled: true, edition: "standard" } });
    const state = {
      innings: [
        { battingSide: "home", runs: 210, wickets: 8, legalBalls: 300, closed: true, fine: null },
        { battingSide: "away", runs: 40, wickets: 1, legalBalls: 60, closed: false, fine: null },
      ],
      revisedTarget: 200,
      targetSource: "manual",
    };
    const layout = cricketSkin.layout(viewFor(cfg, "live", state), { cfg, state, summary: {}, band: FULL_BAND });
    const byId = headerFieldMap(layout.header);
    expect(byId.target).toBe("200");
    expect(byId.dlsPar).toBeUndefined();
  });

  it("does not fabricate a fallback target for a two-innings (test) chase without an explicit revision", () => {
    const cfg = cfgFor("test");
    const state = {
      innings: [
        { battingSide: "home", runs: 300, wickets: 10, legalBalls: 400, closed: true, fine: null },
        { battingSide: "away", runs: 250, wickets: 10, legalBalls: 380, closed: true, fine: null },
        { battingSide: "home", runs: 150, wickets: 10, legalBalls: 300, closed: true, fine: null },
        { battingSide: "away", runs: 40, wickets: 2, legalBalls: 100, closed: false, fine: null },
      ],
      revisedTarget: null,
      targetSource: null,
    };
    const layout = cricketSkin.layout(viewFor(cfg, "live", state), { cfg, state, summary: {}, band: FULL_BAND });
    const byId = headerFieldMap(layout.header);
    expect(byId.target).toBeUndefined();
    expect(byId.dlsPar).toBeUndefined();
  });

  it("header is non-null for every point in the whole cfg-leaf space (the coverage gate's own check, restated per-field)", () => {
    for (const cfg of cfgSpace(cricket)) {
      const layout = cricketSkin.layout(viewFor(cfg, "live"), { cfg, state: {}, summary: {}, band: FULL_BAND });
      expect(layout.header).not.toBeNull();
      const ids = (layout.header as SkinHeader).fields.map((f) => f.id);
      expect(ids).toEqual(expect.arrayContaining(["score", "wickets", "overs"]));
    }
  });
});

// ---------------------------------------------------------------------------
// Criterion 6: the dismissal-with-fielder path. layout() places actions, not
// payloads, so the payload shape lives in a separate pure builder
// (buildBallPayload, exported specifically so this is testable without DOM).
// ---------------------------------------------------------------------------
describe("buildBallPayload: the dismissal-with-fielder path", () => {
  const base = { over: 4, ballInOver: 3, striker: "p_striker", nonStriker: "p_nonstriker", bowler: "p_bowler" };

  it("builds a plain scoring ball with no wicket or extra", () => {
    const payload = buildBallPayload(4, base);
    expect(payload).toMatchObject({
      over: 4,
      ballInOver: 3,
      striker: "p_striker",
      nonStriker: "p_nonstriker",
      bowler: "p_bowler",
      runs: { bat: 4 },
      boundary: 4,
    });
    expect(payload).not.toHaveProperty("wicket");
  });

  it("a non-boundary run carries no boundary field", () => {
    const payload = buildBallPayload(2, base);
    expect(payload).not.toHaveProperty("boundary");
  });

  it("builds an extra with zero bat runs and the extra's own kind/runs", () => {
    const payload = buildBallPayload(0, { ...base, extra: { kind: "wide", runs: 1 } });
    expect(payload).toMatchObject({ runs: { bat: 0, extras: { kind: "wide", runs: 1 } } });
  });

  it("credits the named fielder on a caught dismissal and sets bowlerCredited true", () => {
    const payload = buildBallPayload(0, {
      ...base,
      wicket: { kind: "caught", out: "p_striker", fielder: "p_fielder" },
    });
    expect(payload).toMatchObject({
      wicket: { kind: "caught", out: "p_striker", fielder: "p_fielder", bowlerCredited: true },
    });
  });

  it("does not credit the bowler on a run-out, even though a fielder is attributed", () => {
    const payload = buildBallPayload(1, {
      ...base,
      wicket: { kind: "runout", out: "p_nonstriker", fielder: "p_fielder" },
    });
    expect(payload).toMatchObject({
      wicket: { kind: "runout", out: "p_nonstriker", fielder: "p_fielder", bowlerCredited: false },
    });
  });

  it("omits an unnamed fielder rather than sending an empty string", () => {
    const payload = buildBallPayload(0, { ...base, wicket: { kind: "bowled", out: "p_striker" } });
    expect(payload).toMatchObject({ wicket: { kind: "bowled", out: "p_striker", bowlerCredited: true } });
    expect((payload.wicket as Record<string, unknown>)).not.toHaveProperty("fielder");
  });
});

// ---------------------------------------------------------------------------
// Criterion 6: one test proving dispatch refuses an invented type. Paired
// with a positive case so the assertion direction is provably meaningful
// (types.ts is shared/owned elsewhere, so a hand mutation there is out of
// scope — this is the audit-shaped substitute the implementer brief allows).
// ---------------------------------------------------------------------------
describe("dispatch: refuses any action cricket's own current view does not declare", () => {
  it("passes a declared action straight through (pre phase: toss)", async () => {
    const cfg = cfgFor("t20");
    const view = viewFor(cfg, "pre");
    const sent: string[] = [];
    const dispatch = createSkinDispatch(view, async (type) => void sent.push(type));
    await dispatch("cricket.toss", { wonBy: "home", elected: "bat" });
    expect(sent).toEqual(["cricket.toss"]);
  });

  it("refuses cricket.player.line while scoped to the pre-phase view (it only exists post-match)", async () => {
    const cfg = cfgFor("t20");
    const view = viewFor(cfg, "pre");
    const dispatch = createSkinDispatch(view, async () => {});
    await expect(dispatch("cricket.player.line", {})).rejects.toThrow(/does not declare/);
  });

  it("refuses an outright invented type", async () => {
    const cfg = cfgFor("t20");
    const view = viewFor(cfg, "live");
    const dispatch = createSkinDispatch(view, async () => {});
    await expect(dispatch("cricket.doesnotexist", {})).rejects.toThrow(/does not declare/);
  });
});
