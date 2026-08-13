// Tennis skin (S11/#420 W9) — layout() unit tests. apps/web's vitest is
// `environment: "node"` (vitest.config.ts:71): no DOM, no jsdom, so every
// assertion here is against `tennisSkin.layout()`'s pure OUTPUT, never a
// rendered `TennisSkin` — exactly the split types.ts documents its contract
// around. `dispatch` correctness is proven directly too (types.ts's own
// `createSkinDispatch`), never guessed at.
//
// Fixtures are REAL folds off the real `tennis` module (foldMatch + real
// EventEnvelopes), not hand-typed NestedState literals — this file has no
// access to nested/kernel.ts's own State/Cfg types (not part of the
// package's public export surface: `@seazn/engine/sports/tennis` re-exports
// only the `tennis` VALUE), and a hand-typed stand-in is exactly how a test
// silently drifts from the real fold shape (see
// reference_harness_synthetic_lineups_vs_real_entrants.md). The event
// vocabulary below (`point`/`game`/`setSummary`) mirrors
// nested/nested.test.ts's own tiny local helpers — that file is an
// engine-internal test, not importable from here, so these are small
// deliberate re-statements, not a copy of production logic.
import { describe, expect, it } from "vitest";
import { tennis } from "@seazn/engine/sports/tennis";
import { foldMatch, type EventEnvelope } from "@seazn/engine/core";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import type { ModuleEvent, PadSpec } from "@seazn/engine/sport";
import { buildPadView, type PadView } from "../view-model";
import { createSkinDispatch, layoutActionTypes, layoutActionTypesAt, type SkinLayout } from "../skins/types";
import { tennisSkin } from "../skins/tennis-skin";
import { cfgSpace, grantAllEntitlements } from "./_cfg-space";

const FULL_BAND = 3 as const;
const lineups = defaultLineupPair(tennis.positions);
const H = lineups.home.entrantId;
const A = lineups.away.entrantId;

type TCfg = ReturnType<typeof tennis.configSchema.parse>;
type TState = ReturnType<typeof tennis.init>;

// ---------------------------------------------------------------------------
// Fixture vocabulary
// ---------------------------------------------------------------------------

const start: ModuleEvent = { type: "core.start", payload: {} };
const point = (by: string): ModuleEvent => ({ type: "tennis.point", payload: { by } });
const straight = (by: string, n: number): ModuleEvent[] => Array(n).fill(point(by));
const game = (by: string): ModuleEvent[] => straight(by, 4); // 4 straight points = a clean game
const setSummary = (home: number, away: number): ModuleEvent => ({ type: "tennis.set_summary", payload: { home, away } });

function envelopes(events: readonly ModuleEvent[]): EventEnvelope[] {
  return events.map((e, i) => makeEnvelope(i, e));
}

function fold(cfg: TCfg, events: readonly ModuleEvent[]): TState {
  return foldMatch(tennis, cfg, lineups, envelopes(events), { strictFromSeq: 0 });
}

function cfgsToSweep(): TCfg[] {
  return cfgSpace(tennis).map((raw) => tennis.configSchema.parse(raw));
}

function viewFor(spec: PadSpec, state: TState): PadView {
  return buildPadView(spec, {
    state,
    summary: tennis.summary(state),
    phase: "live",
    band: FULL_BAND,
    entitlements: grantAllEntitlements(spec),
  });
}

/** Alternating single games (H,A,H,A,...) until `set.tiebreakAt` games are
 *  played on both sides — the exact recipe padspec.test.ts's own
 *  "hidden mid-tie-break" integration test uses (12 games at tour's
 *  tiebreakAt:6; 6 at fast4's tiebreakAt:3). Returns [] for an advantage set
 *  (tiebreakAt: null) — tennis's own cfgSpace() never actually produces one
 *  (tiebreakAt is a nullable NUMBER, and _cfg-space.ts's leaf walk only ever
 *  perturbs booleans/strings, never numbers/null), so the guard below is
 *  defensive, not a real gap this sweep is skipping. */
function reachTiebreakEvents(cfg: TCfg): ModuleEvent[] {
  const target = cfg.set.tiebreakAt;
  if (target === null) return [];
  const events: ModuleEvent[] = [start];
  for (let g = 0; g < target; g++) events.push(...game(H), ...game(A));
  return events;
}

/** True when this cfg's decider is a match tie-break replacing the final
 *  set (only doubles-noad-mtb10-derived cfgs — the only variant that sets
 *  `finalSet.matchTiebreakTo`). */
function hasMatchTiebreakDecider(cfg: TCfg): boolean {
  return cfg.finalSet !== "same" && "matchTiebreakTo" in cfg.finalSet;
}

/** One set each via `tennis.set_summary` (the same shortcut
 *  nested.test.ts's own "doubles-noad-mtb10" deciding-set test uses) —
 *  bestOf is 3 for every cfg `hasMatchTiebreakDecider` accepts (that variant
 *  never overrides `bestOf`), so "one set each" always lands ON the
 *  decider. */
function reachDeciderEvents(): ModuleEvent[] {
  return [start, setSummary(6, 4), setSummary(4, 6)];
}

/** The coverage-shaped proof: every type the (already gated/filtered) VIEW
 *  declares is placed exactly once, and nothing else is. Mirrors
 *  skin-coverage.test.ts's own sweep, but against a REAL `buildPadView`
 *  result (gate evaluated for real) rather than that file's gate-free
 *  `fullView` — precise enough to prove the gated gameAward panel
 *  specifically, not just "the spec's whole action set". */
function assertExactCoverage(view: PadView, layout: SkinLayout, label: string): void {
  const viewTypes = new Set(view.panels.flatMap((p) => p.actions.map((a) => a.type)));
  const placed = layoutActionTypes(layout);
  expect(placed.length, `${label}: layout places a duplicate (${placed.join(",")})`).toBe(new Set(placed).size);
  for (const t of viewTypes) {
    expect(placed.includes(t), `${label}: missing ${t}`).toBe(true);
  }
  for (const t of placed) {
    expect(viewTypes.has(t), `${label}: invented ${t}`).toBe(true);
  }
}

// ---------------------------------------------------------------------------
// 1. Coverage across the whole cfg space x tiebreak/non-tiebreak/decider state
// ---------------------------------------------------------------------------

describe("tennis skin — layout places exactly what the (real, gated) view declares, across the whole cfg space", () => {
  const cfgs = cfgsToSweep();

  it("sweeps more than one cfg (guards the sweep itself — a walk that silently stopped finding cfgs would make every case below vacuous)", () => {
    expect(cfgs.length).toBeGreaterThan(1);
  });

  for (const cfg of cfgs) {
    const spec = tennis.padSpec!(cfg);
    const label = JSON.stringify(cfg).slice(0, 90);

    it(`${label} — pre-tiebreak (init) state`, () => {
      const state = tennis.init(cfg, lineups);
      const view = viewFor(spec, state);
      const layout = tennisSkin.layout(view, { cfg, state, summary: tennis.summary(state), band: FULL_BAND });
      assertExactCoverage(view, layout, "pre");
    });

    const tbEvents = reachTiebreakEvents(cfg);
    if (tbEvents.length > 0) {
      it(`${label} — tie-break state`, () => {
        const state = fold(cfg, tbEvents);
        expect(state.points.kind, "fixture sanity: must really be a tie-break").toBe("tiebreak");
        const view = viewFor(spec, state);
        const layout = tennisSkin.layout(view, { cfg, state, summary: tennis.summary(state), band: FULL_BAND });
        assertExactCoverage(view, layout, "tiebreak");
      });
    }

    if (hasMatchTiebreakDecider(cfg)) {
      it(`${label} — match-tiebreak decider state`, () => {
        const state = fold(cfg, reachDeciderEvents());
        expect(state.points.kind, "fixture sanity: must really be a match tie-break").toBe("matchTiebreak");
        const view = viewFor(spec, state);
        const layout = tennisSkin.layout(view, { cfg, state, summary: tennis.summary(state), band: FULL_BAND });
        assertExactCoverage(view, layout, "matchTiebreak");
      });
    }
  }
});

// ---------------------------------------------------------------------------
// 2. tennis.point at primary prominence
// ---------------------------------------------------------------------------

describe("tennis skin — tennis.point sits at primary prominence", () => {
  it("across every cfg in the sweep", () => {
    const misplaced: string[] = [];
    for (const cfg of cfgsToSweep()) {
      const spec = tennis.padSpec!(cfg);
      const state = tennis.init(cfg, lineups);
      const view = viewFor(spec, state);
      const layout = tennisSkin.layout(view, { cfg, state, summary: tennis.summary(state), band: FULL_BAND });
      if (!layoutActionTypesAt(layout, "primary").includes("tennis.point")) {
        misplaced.push(JSON.stringify(cfg).slice(0, 60));
      }
    }
    expect(misplaced).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Header — sets/games/points/serving always, tiebreak only when live
// ---------------------------------------------------------------------------

describe("tennis skin — header reports sets/games/points/serving always, tiebreak only when in one", () => {
  const cfg = tennis.configSchema.parse({});
  const spec = tennis.padSpec!(cfg);

  function headerFieldIds(state: TState): readonly string[] {
    const view = viewFor(spec, state);
    const layout = tennisSkin.layout(view, { cfg, state, summary: tennis.summary(state), band: FULL_BAND });
    return (layout.header?.fields ?? []).map((f) => f.id);
  }

  it("is non-null with sets/games/points/serving, and no tiebreak field, before any tie-break", () => {
    const state = tennis.init(cfg, lineups);
    const ids = headerFieldIds(state);
    expect(ids).toEqual(expect.arrayContaining(["sets", "games", "points", "serving"]));
    expect(ids).not.toContain("tiebreak");
  });

  it("gains a tiebreak field, value 'TB', once the score reaches 6-6 (tour's tiebreakAt:6)", () => {
    const state = fold(cfg, reachTiebreakEvents(cfg));
    expect(state.points.kind).toBe("tiebreak");
    const view = viewFor(spec, state);
    const layout = tennisSkin.layout(view, { cfg, state, summary: tennis.summary(state), band: FULL_BAND });
    const tb = layout.header?.fields.find((f) => f.id === "tiebreak");
    expect(tb).toBeDefined();
    expect(tb?.value).toBe("TB");
  });

  it("reports 'MTB', not 'TB', once a match tie-break decider is under way", () => {
    const mtbCfg = tennis.configSchema.parse(tennis.variants["doubles-noad-mtb10"]);
    const mtbSpec = tennis.padSpec!(mtbCfg);
    const state = fold(mtbCfg, reachDeciderEvents());
    expect(state.points.kind).toBe("matchTiebreak");
    const view = viewFor(mtbSpec, state);
    const layout = tennisSkin.layout(view, { cfg: mtbCfg, state, summary: tennis.summary(state), band: FULL_BAND });
    expect(layout.header?.fields.find((f) => f.id === "tiebreak")?.value).toBe("MTB");
  });

  it("loses the tiebreak field again once the tie-break banks a set and the next set starts standard play", () => {
    const state = fold(cfg, [...reachTiebreakEvents(cfg), ...straight(H, 7)]); // H takes the TB 7-0
    expect(state.points.kind).toBe("standard");
    const ids = headerFieldIds(state);
    // Asserted together, not just the absence alone: a null/empty header
    // (e.g. the pre-implementation stub) would ALSO satisfy "no tiebreak
    // field" — vacuously, for the wrong reason. Requiring the base fields
    // too means this can only go green because the field genuinely came
    // and went, not because nothing was ever there.
    expect(ids).toEqual(expect.arrayContaining(["sets", "games", "points", "serving"]));
    expect(ids).not.toContain("tiebreak");
  });

  it("never returns null or an empty field list, even against a stand-in ctx.state (skin-coverage.test.ts's own sweep shape)", () => {
    const realState = tennis.init(cfg, lineups); // a real, validly-gated VIEW …
    const view = viewFor(spec, realState);
    // … but a stand-in CTX, exactly what skin-coverage.test.ts's sweep hands
    // every skin (`state: {}`) — layout() must degrade, never throw or omit.
    const layout = tennisSkin.layout(view, { cfg, state: {}, summary: {}, band: FULL_BAND });
    expect(layout.header).not.toBeNull();
    expect(layout.header?.fields.length ?? 0).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 4. The gated gameAward panel, both directions
// ---------------------------------------------------------------------------

describe("tennis skin — the gated gameAward panel: both directions", () => {
  const cfg = tennis.configSchema.parse({});
  const spec = tennis.padSpec!(cfg);

  it("is placed when the gate is open (ordinary standard-play state)", () => {
    const state = tennis.init(cfg, lineups);
    const view = viewFor(spec, state);
    expect(
      view.panels.some((p) => p.actions.some((a) => a.type === "tennis.game.award")),
      "fixture sanity: the gate must really be open here",
    ).toBe(true);
    const layout = tennisSkin.layout(view, { cfg, state, summary: tennis.summary(state), band: FULL_BAND });
    expect(layoutActionTypes(layout)).toContain("tennis.game.award");
  });

  it("is NOT placed once the gate closes (mid tie-break) — absent, not invented, not a crash", () => {
    const state = fold(cfg, reachTiebreakEvents(cfg));
    const view = viewFor(spec, state);
    expect(
      view.panels.some((p) => p.actions.some((a) => a.type === "tennis.game.award")),
      "fixture sanity: the gate must really have closed here",
    ).toBe(false);
    const layout = tennisSkin.layout(view, { cfg, state, summary: tennis.summary(state), band: FULL_BAND });
    expect(layoutActionTypes(layout)).not.toContain("tennis.game.award");
    // The gate closing one panel must not leave the skin inventing or
    // dropping anything ELSE — full coverage still holds.
    assertExactCoverage(view, layout, "tiebreak, gameAward gated off");
  });
});

// ---------------------------------------------------------------------------
// 5. Flipping best-of visibly changes the scoreboard
// ---------------------------------------------------------------------------

describe("tennis skin — flipping best-of visibly changes the header", () => {
  it("the sets field's value differs between bo3 (tour) and bo5 (grand-slam) at an identical 0-0 state", () => {
    const cfgBo3 = tennis.configSchema.parse({});
    const cfgBo5 = tennis.configSchema.parse(tennis.variants["grand-slam"]);
    expect(cfgBo3.bestOf).toBe(3);
    expect(cfgBo5.bestOf).toBe(5);
    const specBo3 = tennis.padSpec!(cfgBo3);
    const specBo5 = tennis.padSpec!(cfgBo5);
    // Same fresh 0-0 state shape either way (cfg-independent) — isolates the
    // change to bestOf alone, not a state difference riding along with it.
    const state = tennis.init(cfgBo3, lineups);
    const layout3 = tennisSkin.layout(viewFor(specBo3, state), {
      cfg: cfgBo3,
      state,
      summary: tennis.summary(state),
      band: FULL_BAND,
    });
    const layout5 = tennisSkin.layout(viewFor(specBo5, state), {
      cfg: cfgBo5,
      state,
      summary: tennis.summary(state),
      band: FULL_BAND,
    });
    const sets3 = layout3.header?.fields.find((f) => f.id === "sets")?.value;
    const sets5 = layout5.header?.fields.find((f) => f.id === "sets")?.value;
    expect(sets3).toBeDefined();
    expect(sets3).not.toBe(sets5);
  });
});

// ---------------------------------------------------------------------------
// 6. Attributed vs plain point / set-summary shapes
// ---------------------------------------------------------------------------

describe("tennis skin — attributed vs plain point/set-summary shapes both resolve; layout places the shared type once", () => {
  const cfg = tennis.configSchema.parse({});
  const spec = tennis.padSpec!(cfg);

  it("the spec really does carry two DISTINCT tennis.point actions (fixture sanity — a test that can't fail proves nothing)", () => {
    const pointActions = spec.panels.flatMap((p) => p.actions).filter((a) => a.type === "tennis.point");
    expect(pointActions.length).toBe(2);
    expect(pointActions.some((a) => a.fields.length === 0)).toBe(true); // plain
    expect(pointActions.some((a) => a.fields.some((f) => f.path === "meta.kind"))).toBe(true); // attributed
  });

  it("the spec really does carry two DISTINCT tennis.set_summary actions", () => {
    const summaryActions = spec.panels.flatMap((p) => p.actions).filter((a) => a.type === "tennis.set_summary");
    expect(summaryActions.length).toBe(2);
    expect(summaryActions.some((a) => a.fields.length === 2)).toBe(true); // plain
    expect(summaryActions.some((a) => a.fields.some((f) => f.path === "tb.home"))).toBe(true); // tiebreak
  });

  it("layout places tennis.point and tennis.set_summary exactly ONCE despite both having two variants", () => {
    const state = tennis.init(cfg, lineups);
    const view = viewFor(spec, state);
    const layout = tennisSkin.layout(view, { cfg, state, summary: tennis.summary(state), band: FULL_BAND });
    const placed = layoutActionTypes(layout);
    expect(placed.filter((t) => t === "tennis.point").length).toBe(1);
    expect(placed.filter((t) => t === "tennis.set_summary").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 7. Dispatch — the non-negotiable rule
// ---------------------------------------------------------------------------

describe("tennis skin — dispatch refuses an action the (real) view does not declare", () => {
  const cfg = tennis.configSchema.parse({});
  const spec = tennis.padSpec!(cfg);
  const state = tennis.init(cfg, lineups);
  const view = viewFor(spec, state);

  it("passes a real declared type straight through to the chassis", async () => {
    const sent: string[] = [];
    const dispatch = createSkinDispatch(view, async (type) => void sent.push(type));
    await dispatch("tennis.point", { by: H });
    expect(sent).toEqual(["tennis.point"]);
  });

  it("refuses an invented type", async () => {
    const sent: string[] = [];
    const dispatch = createSkinDispatch(view, async (type) => void sent.push(type));
    await expect(dispatch("tennis.invented", {})).rejects.toThrow(/does not declare/);
    expect(sent).toEqual([]);
  });

  it("refuses tennis.game.award once the (real) view no longer declares it (mid tie-break)", async () => {
    const tbState = fold(cfg, reachTiebreakEvents(cfg));
    const tbView = viewFor(spec, tbState);
    const dispatch = createSkinDispatch(tbView, async () => {});
    await expect(dispatch("tennis.game.award", { winner: H })).rejects.toThrow(/does not declare/);
  });
});
