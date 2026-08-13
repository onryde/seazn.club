// Cricket skin tests (S11/#420 W9). This file is the per-sport complement to
// the shared `skin-coverage.test.ts` gate: that gate sweeps EVERY skin across
// its sport's whole cfg space and proves reach/no-invention structurally; this
// file proves cricket's specific, measured facts using REAL PadSpecs built
// from the actual engine module (never hand-typed fixtures) — the same
// "measure, don't assume" discipline the dispatch brief was written under.
//
// `layout()` is pure (types.ts's own contract), so most assertions here are a
// data comparison — no React, no jsdom (apps/web's vitest is `environment:
// "node"`, vitest.config.ts:71). Most facts that live in the React Component
// (name resolution, tap sequencing) are not testable here at all; see
// cricket-skin.tsx's own header comment for why, and the dispatch report for
// the tap-count reasoning.
//
// ONE exception, at the bottom of this file (S11 review-caught defect): the
// batter/bowler picker's own resync-to-the-fold behaviour is real hook state
// inside `ThisOverGroup`, not a `layout()` fact, so it is driven directly
// through this repo's node-only `_hook-harness` (`renderIsland`) — the same
// technique pad-renderer.test.tsx and period-skin.test.ts already use for a
// component with its own hooks. Fixtures there are REAL folds off the real
// `cricket` module (foldMatch + real EventEnvelopes) for the same reason the
// rest of this file uses real PadSpecs: a hand-typed CricketState is exactly
// how a test silently drifts from the real fold's shape.
//
// Independent-oracle discipline (reference_wrapper_delegate_parity_is_a_tautology):
// every "did the layout place the right things" assertion below compares
// `cricketSkin.layout(...)`'s output against the action set read directly off
// the REAL `view` it was given — never against a number this file invents —
// so a bug that empties both sides at once cannot read as a pass.
import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { foldMatch, type EventEnvelope } from "@seazn/engine/core";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import {
  cricket as cricketEngine,
  type CricketBallEv,
  type CricketCfg,
  type CricketState,
} from "@seazn/engine/sports/cricket";
import { messages, type MessageKey } from "@/lib/messages";
import { t as tRuntime } from "@/lib/i18n-runtime";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { buildPadView } from "../view-model";
import { cricketSkin, buildBallPayload, ThisOverGroup } from "../skins/cricket-skin";
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

// ---------------------------------------------------------------------------
// Review finding (S11/#420): the batter/bowler pickers never resynced to the
// engine's folded state after mount. `useState(fine?.striker ?? ...)` seeds
// ONCE, so after the very first ball the picker's idea of who is on strike
// silently drifts from the fold's, and every subsequent ball is attributed
// to the wrong batter — a well-formed payload the server accepts, so nothing
// downstream ever sees the mistake. Proven here with a REAL fold, driven
// through `ThisOverGroup` directly (exported from cricket-skin.tsx for
// exactly this).
// ---------------------------------------------------------------------------
describe("ThisOverGroup: the picker resyncs to the fold (S11 review finding)", () => {
  // The exact fallback `useMsg()` resolves to outside a `<DictProvider>`
  // (mirrors period-skin.test.ts's own established pattern) — real English
  // lookup, not a stub.
  type MsgFn = (key: MessageKey, vars?: Record<string, string | number>) => string;
  const msg: MsgFn = (key, vars) => tRuntime(messages, key, vars);

  const RESYNC_LINEUPS = defaultLineupPair(cricketEngine.positions);
  const RESYNC_CFG: CricketCfg = cricketEngine.configSchema.parse(cricketEngine.variants.t20);
  const bpo = RESYNC_CFG.ballsPerOver;

  // Openers by orderNo — defaultLineupPair's own scheme (testkit/helpers.ts):
  // personId `${entrantId}-p${orderNo}`.
  const S0 = RESYNC_LINEUPS.home.slots[0]!.personId;
  const N0 = RESYNC_LINEUPS.home.slots[1]!.personId;
  // Deliberately NOT bowlingOrder[0] — the component's own null-bowler
  // fallback IS bowlingOrder[0], so bowling the over with anyone else makes
  // the over-end resync (bowler -> null -> fallback) a REAL, visible change
  // rather than a coincidence a broken fix could still pass.
  const OVER_BOWLER = RESYNC_LINEUPS.away.slots[2]!.personId;
  const BOWLER_FALLBACK = RESYNC_LINEUPS.away.slots[0]!.personId;

  interface Ball {
    striker: string;
    nonStriker: string;
    bowler: string;
    bat: number;
  }
  // One legal run (rotates strike), then five balls that touch nothing, so
  // the only strike swap left standing by the end of the over is the
  // mandatory over-end one — see the "sanity" test below for the hand trace,
  // checked against the real fold rather than trusted blind.
  const OVER: readonly Ball[] = [
    { striker: S0, nonStriker: N0, bowler: OVER_BOWLER, bat: 1 }, // odd -> rotates strike
    { striker: N0, nonStriker: S0, bowler: OVER_BOWLER, bat: 0 },
    { striker: N0, nonStriker: S0, bowler: OVER_BOWLER, bat: 2 },
    { striker: N0, nonStriker: S0, bowler: OVER_BOWLER, bat: 0 },
    { striker: N0, nonStriker: S0, bowler: OVER_BOWLER, bat: 0 },
    { striker: N0, nonStriker: S0, bowler: OVER_BOWLER, bat: 0 }, // 6th legal ball -> over ends
  ];

  function envelopesThrough(n: number): EventEnvelope[] {
    const events: EventEnvelope[] = [makeEnvelope(0, { type: "core.start", payload: {} })];
    OVER.slice(0, n).forEach((spec, i) => {
      const payload: CricketBallEv = {
        over: Math.floor(i / bpo),
        ballInOver: (i % bpo) + 1,
        striker: spec.striker,
        nonStriker: spec.nonStriker,
        bowler: spec.bowler,
        runs: { bat: spec.bat },
      };
      events.push(makeEnvelope(i + 1, { type: "cricket.ball", payload }));
    });
    return events;
  }

  // A FRESH fold every call (never memoised across calls in this suite) —
  // deliberate: it means two snapshots with identical VALUES are never the
  // same object reference, so a resync implementation that (wrongly)
  // compares fold objects by identity instead of by value cannot pass the
  // override test below by accident.
  function foldThrough(n: number): CricketState {
    return foldMatch(cricketEngine, RESYNC_CFG, RESYNC_LINEUPS, envelopesThrough(n), { strictFromSeq: 0 });
  }

  function propsFor(state: CricketState) {
    const view = viewFor(RESYNC_CFG, "live", state);
    return { msg, view, state, bpo, submittingType: null, dispatch: async () => {} };
  }

  // find/findAll/isType: local, mirroring pad-renderer.test.tsx and
  // period-skin.test.ts — `_hook-harness.tsx` exports `propsOf`/`walk`/
  // `textOf`/`renderIsland` only, and every consumer defines its own
  // tree-search sugar on top.
  function find(tree: ReactElement[], pred: (el: ReactElement) => boolean): ReactElement {
    const el = tree.find(pred);
    if (!el) throw new Error("element not found in rendered tree");
    return el;
  }
  function findAll(tree: ReactElement[], pred: (el: ReactElement) => boolean): ReactElement[] {
    return tree.filter(pred);
  }
  const isType = (type: unknown) => (el: ReactElement) => el.type === type;

  // The three pickers are drawn by `(["striker","nonStriker","bowler"] as
  // const).map(...)`, in that literal order (cricket-skin.tsx) — the length
  // assertion means a future reordering fails loudly here instead of
  // silently misindexing every assertion that follows.
  function selectValues(tree: ReactElement[]): { striker: unknown; nonStriker: unknown; bowler: unknown } {
    const selects = findAll(tree, isType("select"));
    expect(selects.length).toBe(3);
    const [strikerEl, nonStrikerEl, bowlerEl] = selects;
    return {
      striker: propsOf(strikerEl!).value,
      nonStriker: propsOf(nonStrikerEl!).value,
      bowler: propsOf(bowlerEl!).value,
    };
  }

  it("sanity: the real fold behaves the way this suite's hand trace says it does", () => {
    const afterBall1 = foldThrough(1);
    const fine1 = afterBall1.innings[0]!.fine!;
    expect(fine1.striker).toBe(N0);
    expect(fine1.nonStriker).toBe(S0);
    expect(fine1.currentBowler).toBe(OVER_BOWLER);

    const afterOver = foldThrough(6);
    const fineOver = afterOver.innings[0]!.fine!;
    expect(fineOver.striker).toBe(S0);
    expect(fineOver.nonStriker).toBe(N0);
    expect(fineOver.currentBowler).toBeNull();
  });

  it("resyncs striker/nonStriker/bowler after a single run, then again when the over ends", () => {
    const island = renderIsland(ThisOverGroup, propsFor(foldThrough(0)));
    // Mount-time fallback (no fine yet — no ball has been folded) is
    // unaffected by this fix; asserted as a baseline so the rerenders below
    // are provably a CHANGE, not the component having shown the right thing
    // by luck all along.
    expect(selectValues(island.tree())).toEqual({ striker: S0, nonStriker: N0, bowler: BOWLER_FALLBACK });

    island.rerender(propsFor(foldThrough(1)));
    expect(selectValues(island.tree()), "a single run must rotate strike in the PICKER, not just the fold").toEqual({
      striker: N0,
      nonStriker: S0,
      bowler: OVER_BOWLER,
    });

    island.rerender(propsFor(foldThrough(6)));
    expect(
      selectValues(island.tree()),
      "six legal balls must end the over in the picker too: ends swap, bowler clears to the fallback",
    ).toEqual({
      striker: S0,
      nonStriker: N0,
      bowler: BOWLER_FALLBACK,
    });
  });

  it("a manual override survives a re-render the fold did not cause, and yields once the fold itself moves", () => {
    const island = renderIsland(ThisOverGroup, propsFor(foldThrough(1)));
    expect(selectValues(island.tree()).striker).toBe(N0);

    // Deliberate correction: the scorer taps a THIRD batter, not the fold's
    // own striker — e.g. spotting a mistake before this ball is submitted.
    const OVERRIDE = RESYNC_LINEUPS.home.slots[2]!.personId;
    const strikerSelect = find(island.tree(), isType("select"));
    (propsOf(strikerSelect).onChange as (e: unknown) => void)({ target: { value: OVERRIDE } });
    expect(selectValues(island.tree()).striker).toBe(OVERRIDE);

    // A re-render carrying the SAME fold VALUES but a freshly-recomputed
    // (referentially different) CricketState — exactly how the real fold
    // reaches this component on every render, never reference-memoised by
    // this file. Must NOT fight the override: the fold's own value has not
    // moved.
    island.rerender(propsFor(foldThrough(1)));
    expect(selectValues(island.tree()).striker, "an unrelated re-render must not discard a manual override").toBe(
      OVERRIDE,
    );

    // Now the fold genuinely advances — the override must yield to it.
    island.rerender(propsFor(foldThrough(6)));
    expect(selectValues(island.tree()).striker, "a real fold change must win over a stale manual override").toBe(S0);
  });
});

// ---------------------------------------------------------------------------
// S12/#421 pass B (owner-approved widening into skins/**, review pass + a real
// browser): the striker/non-striker/bowler pickers rendered the raw person id
// as their OPTION TEXT. `ctx.personNames` (S11's SkinLayoutCtx) has existed
// since S11 but no skin consumed it -- fixed here for cricket. Driven through
// the same real-fold + `ThisOverGroup` + hook-harness technique as the resync
// tests above, reading the rendered <option> TEXT this time, not the
// <select>'s value.
// ---------------------------------------------------------------------------
describe("ThisOverGroup: person picker options show ctx.personNames, not a raw id (S12/#421 pass B)", () => {
  type MsgFn = (key: MessageKey, vars?: Record<string, string | number>) => string;
  const msg: MsgFn = (key, vars) => tRuntime(messages, key, vars);

  const NAME_LINEUPS = defaultLineupPair(cricketEngine.positions);
  const NAME_CFG: CricketCfg = cricketEngine.configSchema.parse(cricketEngine.variants.t20);
  const NAME_STRIKER = NAME_LINEUPS.home.slots[0]!.personId;

  function foldFresh(): CricketState {
    const events: EventEnvelope[] = [makeEnvelope(0, { type: "core.start", payload: {} })];
    return foldMatch(cricketEngine, NAME_CFG, NAME_LINEUPS, events, { strictFromSeq: 0 });
  }

  function findOption(tree: ReactElement[], value: string): ReactElement {
    const el = tree.find((e) => e.type === "option" && propsOf(e).value === value);
    if (!el) throw new Error(`no <option value="${value}"> found in rendered tree`);
    return el;
  }

  function renderWithNames(personNames: Readonly<Record<string, string>> | undefined) {
    const state = foldFresh();
    const view = viewFor(NAME_CFG, "live", state);
    return renderIsland(ThisOverGroup, {
      msg,
      view,
      state,
      bpo: NAME_CFG.ballsPerOver,
      submittingType: null,
      dispatch: async () => {},
      personNames,
    });
  }

  it("renders the resolved name from ctx.personNames as the option text, not the raw id", () => {
    const island = renderWithNames({ [NAME_STRIKER]: "Priya Opener" });
    const option = findOption(island.tree(), NAME_STRIKER);
    expect(propsOf(option).children).toBe("Priya Opener");
  });

  it("still renders (falls back to the raw id) when ctx carries no personNames -- total without a roster", () => {
    const island = renderWithNames(undefined);
    const option = findOption(island.tree(), NAME_STRIKER);
    expect(propsOf(option).children).toBe(NAME_STRIKER);
  });
});
