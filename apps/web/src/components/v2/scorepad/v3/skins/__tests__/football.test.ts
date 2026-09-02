// R3/task B2 — football SkinDefV3. Pure-data assertions only (apps/web vitest
// is `environment: "node"`, no jsdom — the convention every v3 primitive
// follows): the skin is a spec BUILDER, so this file asserts the specs it
// returns and leaves the DOM to e2e.
//
// Two things are proved by driving the REAL chassis rather than a stand-in,
// because a re-implemented stand-in is exactly how a `when` predicate ships
// broken with a green suite:
//   - guided-sheet gating goes through `initialSheetState`/`currentStep`/
//     `answerStep` from ../../guided-sheet;
//   - every mirrored engine vocabulary (card colours, offence reasons,
//     penalty outcomes, period markers, and the per-event fidelity band) is
//     pinned against the ENGINE's own `padSpec(cfg)`, so a module change reds
//     here instead of drifting silently.
//
// There is no shared skin-test factory in this tree — cricket.test.ts defines
// its own local `t`/`squads()`/`state()`/`cfg()`/`view()`; this file follows
// that precedent deliberately rather than inventing a shared one for two
// callers.
import { describe, expect, it } from "vitest";
import uiEn from "@/dictionaries/en/ui.json";
import type { AnySportModule, PadAction, PadField } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import type { EventEnvelope, LineupPair, SquadState } from "@seazn/engine/core";
import { initSquads } from "@seazn/engine/core";
import { football } from "@seazn/engine/sports/football";
import { foldClient } from "../../../module-client";
import { dedicatedEventTypes, squadStateOf, stampFor } from "../../pad-host";
import { initClock, startClock } from "../../clock";
import { answerStep, currentStep, initialSheetState } from "../../guided-sheet";
import type { GuidedSheetSpec, PadHostView, TileSpec } from "../../types";
import { cricketSkinV3, buildScorebug as buildCricketScorebug } from "../cricket";
import { buildScorebug as buildTennisScorebug } from "../tennis";
// R3.5 — the wave's own lesson (`_INDEX.md`: "a mirror agrees with itself"):
// every shoot-out assertion below drives this REAL fold helper, never a
// hand-built `state()` literal, the same discipline `_cricket-fold.ts` and
// `football-dispatch-totality.test.ts` already hold football's phase rules
// to.
import { foldedPhases, foldFootball, footballCfg } from "../../__tests__/_football-fold";
import {
  CARD_COLORS,
  CARD_REASONS,
  EVENT_BAND,
  PENALTY_OFFENCES,
  PENALTY_OUTCOMES,
  buildDock,
  buildScorebug,
  buildSheets,
  buildSwap,
  buildTiles,
  footballDetail,
  footballSkinV3,
  kickerCue,
  legalPeriodMarkers,
  periodMarkersOf,
  phaseAllows,
  refusedEventTypes,
  readClock,
  resolvePhase,
} from "../football";
import type { TFn } from "../football";
import { SPORT_TONES } from "../../sport-theme";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const t: TFn = (key, vars) => (vars ? `${key}(${JSON.stringify(vars)})` : key);

const NAMES: Record<string, string> = {
  h1: "Home One", h2: "Home Two", h3: "Home Three", h4: "Home Sub", h5: "Home Sub Two",
  a1: "Away One", a2: "Away Two", a3: "Away Three", a4: "Away Sub", a5: "Away Sub Two",
};

function squads(): SquadState {
  return initSquads({
    home: {
      entrantId: "home-1",
      slots: [
        { personId: "h1", slot: "starting", orderNo: 1 },
        { personId: "h2", slot: "starting", orderNo: 2 },
        { personId: "h3", slot: "starting", orderNo: 3 },
        { personId: "h4", slot: "bench", orderNo: 4 },
        { personId: "h5", slot: "bench", orderNo: 5 },
      ],
    },
    away: {
      entrantId: "away-1",
      slots: [
        { personId: "a1", slot: "starting", orderNo: 1 },
        { personId: "a2", slot: "starting", orderNo: 2 },
        { personId: "a3", slot: "starting", orderNo: 3 },
        { personId: "a4", slot: "bench", orderNo: 4 },
        { personId: "a5", slot: "bench", orderNo: 5 },
      ],
    },
  });
}

/** Football's OWN squad projection (`FootballSquad`, football.ts) — NOT the
 *  kernel's `SquadState`. That divergence is the whole reason the skin reads
 *  this rather than `view.squads`, so the fixture must have this shape. */
function footballSquad(over: Record<string, unknown> = {}) {
  return { onPitch: ["h1", "h2", "h3"], bench: ["h4", "h5"], offUsed: [], sentOff: [], ...over };
}

function state(over: Record<string, unknown> = {}) {
  return {
    phase: "H1" as const,
    entrants: { home: "home-1", away: "away-1" },
    goals: { home: 1, away: 0 },
    periods: [{ phase: "H1", home: 1, away: 0 }],
    cards: [] as { side: string; person?: string; color: string }[],
    squads: {
      home: footballSquad(),
      away: footballSquad({ onPitch: ["a1", "a2", "a3"], bench: ["a4", "a5"] }),
    },
    shootout: null,
    ...over,
  };
}

function cfg(over: Record<string, unknown> = {}) {
  return {
    halfMinutes: 45,
    halves: 2 as 2 | 4,
    extraTime: { enabled: false, halfMinutes: 15 },
    shootout: false,
    maxSubs: 3,
    subWindows: 3,
    ...over,
  };
}

function view(over: Partial<PadHostView> = {}): PadHostView {
  return {
    cfg: cfg(),
    state: state(),
    summary: {},
    phase: "live",
    band: 3,
    entitlements: {},
    personNames: NAMES,
    squads: squads(),
    events: [],
    contextOverrides: {},
    ...over,
  };
}

const tileById = (tiles: readonly TileSpec[], id: string): TileSpec | undefined => tiles.find((tile) => tile.id === id);

/** Which lane a tile belongs to, read the way the SCREEN reads it — off the
 *  side sublabel, not the id, so a renamed tile cannot slip the lane guard. */
function sideOfTile(tile: TileSpec): "home" | "away" | null {
  if (tile.sublabel === "scorepad.attribution.home") return "home";
  if (tile.sublabel === "scorepad.attribution.away") return "away";
  return null;
}

/**
 * R3.5 (Tasks D, E, F, J) — a REAL `PadHostView` reaching `SHOOTOUT`, with
 * `kicks` recorded through the real fold (never a hand-built `state({
 * shootout: {...} })` literal — see this file's new header note and
 * `_football-fold.ts`'s own header for why: a fixture that agrees with
 * itself proves nothing about the engine).
 *
 * `preGoals` defaults to a 1-1 regulation draw — the ONLY way `resolveFullTime`
 * (football.ts) reaches `SHOOTOUT` at all is a LEVEL score at FT with
 * `extraTime.enabled: false` and `cfg.shootout: true`; a non-level score
 * decides in regulation and the phase never gets there.
 */
function shootoutView(
  kicks: readonly (readonly ["home" | "away", boolean])[],
  opts: { band?: PadHostView["band"]; personNames?: Readonly<Record<string, string>> } = {},
): PadHostView {
  const cfgObj = footballCfg({ shootout: true, extraTime: { enabled: false, halfMinutes: 15 } });
  const specs: [type: string, payload?: unknown][] = [
    ["core.start"],
    ["football.goal", { by: "H" }],
    ["football.goal", { by: "A" }],
    ["football.period", { phase: "HT" }],
    ["football.period", { phase: "FT" }],
    ...kicks.map(([side, scored]): [string, unknown] => [
      "football.shootout.kick",
      { by: side === "home" ? "H" : "A", scored },
    ]),
  ];
  const folded = foldFootball(cfgObj, specs);
  return view({ cfg: cfgObj, state: folded, band: opts.band ?? 3, personNames: opts.personNames ?? NAMES });
}

const BANDS = [0, 1, 2, 3] as const;

/** What the scorebug's period item actually SAYS — the strip carries resolved
 *  text, and the local `t` returns its own key, so this reads as the key. */
const periodOf = (v: PadHostView): string | undefined =>
  buildScorebug(v, t).strip.find((item) => item.id === "period")?.value;

/** Every value football's own `Phase` union can hold (football.ts:458). */
const ENGINE_PHASES = ["pre", "H1", "H2", "Q2", "Q3", "Q4", "ET_H1", "ET_H2", "SHOOTOUT", "done", "final", "abandoned"];

// The engine module itself — every mirrored vocabulary below is pinned
// against its own `padSpec(cfg)`, never a hand-copied list.
const footballModule = (builtinModules as readonly AnySportModule[]).find((m) => m.key === "football");
if (!footballModule?.padSpec || !footballModule.eventSchemas) {
  throw new Error("football module (with padSpec/eventSchemas) not found in builtinModules — engine export moved?");
}
const padSpecFor = footballModule.padSpec;
const ENGINE_EVENT_TYPES = new Set(Object.keys(footballModule.eventSchemas));

function engineCfg(over: Record<string, unknown> = {}): unknown {
  return footballModule!.configSchema.parse(over);
}

function engineAction(spec: ReturnType<typeof padSpecFor>, type: string): PadAction {
  for (const panel of spec.panels) {
    for (const action of panel.actions) if (action.type === type) return action;
  }
  throw new Error(`padSpec declares no action "${type}"`);
}

function enumValues(action: PadAction, path: string): readonly string[] {
  const field = action.fields.find((f: PadField) => f.path === path);
  if (!field || field.kind !== "enum") throw new Error(`action has no enum field "${path}"`);
  return field.values;
}

// ---------------------------------------------------------------------------
// Mirrored engine vocabularies — drift pins.
// ---------------------------------------------------------------------------

describe("engine mirrors (a module change must red HERE, not drift silently)", () => {
  const spec = padSpecFor(engineCfg());

  it("CARD_COLORS mirrors football.card's own colour enum, in order", () => {
    expect([...CARD_COLORS]).toEqual([...enumValues(engineAction(spec, "football.card"), "color")]);
    expect(CARD_COLORS).toHaveLength(3); // vacuity guard: an empty mirror would satisfy the line above
  });

  it("CARD_REASONS mirrors football.card's own offence enum, all 13 of them", () => {
    expect([...CARD_REASONS]).toEqual([...enumValues(engineAction(spec, "football.card"), "reason")]);
    expect(CARD_REASONS).toHaveLength(13);
  });

  it("PENALTY_OUTCOMES mirrors football.penalty's own outcome enum — the shared attempt vocabulary MINUS scored", () => {
    expect([...PENALTY_OUTCOMES]).toEqual([...enumValues(engineAction(spec, "football.penalty"), "outcome")]);
    expect(PENALTY_OUTCOMES).not.toContain("scored");
  });

  it("EVENT_BAND mirrors padSpec's own fidelity map exactly — every type, every band", () => {
    expect(EVENT_BAND).toEqual(spec.fidelity);
    expect(Object.keys(EVENT_BAND)).toHaveLength(9);
  });

  it("periodMarkersOf mirrors football.period's own marker enum for halves, quarters and extra time", () => {
    expect([...periodMarkersOf(cfg())]).toEqual([...enumValues(engineAction(padSpecFor(engineCfg()), "football.period"), "phase")]);
    expect([...periodMarkersOf(cfg({ halves: 4 }))]).toEqual([
      ...enumValues(engineAction(padSpecFor(engineCfg({ halves: 4 })), "football.period"), "phase"),
    ]);
    expect([...periodMarkersOf(cfg({ extraTime: { enabled: true, halfMinutes: 15 } }))]).toEqual([
      ...enumValues(engineAction(padSpecFor(engineCfg({ extraTime: { enabled: true, halfMinutes: 15 } })), "football.period"), "phase"),
    ]);
  });
});

// ---------------------------------------------------------------------------
// phase() — G3. OPT-IN: a skin that omits it silently keeps the tab-shaped
// default the host falls back to, so this is a real deliverable, not a detail.
// ---------------------------------------------------------------------------

describe("resolvePhase", () => {
  it("maps football's richer engine phases DOWN to the three PadPhase values", () => {
    expect(resolvePhase(view({ state: state({ phase: "pre" }) }))).toBe("pre");
    for (const phase of ["H1", "H2", "Q2", "Q3", "Q4", "ET_H1", "ET_H2", "SHOOTOUT"]) {
      expect(resolvePhase(view({ state: state({ phase }) })), phase).toBe("live");
    }
    for (const phase of ["done", "final", "abandoned"]) {
      expect(resolvePhase(view({ state: state({ phase }) })), phase).toBe("post");
    }
  });

  it("reads an unfolded/empty state as 'pre' — football's own documented starting value", () => {
    expect(resolvePhase(view({ state: {} }))).toBe("pre");
  });
});

// ---------------------------------------------------------------------------
// scorebug() — tapModel T: the halves are READOUTS, never tap targets.
// ---------------------------------------------------------------------------

describe("buildScorebug", () => {
  it("shows each side's goals as its own half, and neither half is tappable (tapModel T)", () => {
    const spec = buildScorebug(view(), t);
    expect(spec.halves[0].big).toBe("1");
    expect(spec.halves[1].big).toBe("0");
    expect(spec.halves[0].tappable).toBeFalsy();
    expect(spec.halves[1].tappable).toBeFalsy();
    expect(spec.halves[0].who[0]?.name).toBe("scorepad.attribution.home");
    expect(spec.halves[1].who[0]?.name).toBe("scorepad.attribution.away");
  });

  it("the strip is period · clock, each with a stable id", () => {
    const spec = buildScorebug(view({ state: state({ asOf: { period: "H1", elapsed: 754 } }) }), t);
    expect(spec.strip.map((item) => item.id)).toEqual(["period", "clock"]);
    expect(spec.strip[0]?.value).toBe("pad.football.phase.H1");
    expect(spec.strip[1]?.value).toBe("12:34");
  });

  // B3/fix 4. The clock is real — `state.asOf` is a `GameTime` the fold keeps
  // (`{...swept, asOf: at}`, football.ts) — but only a STAMPED event sets it,
  // and no v3 tile sends `at` except the swap, which copies an `asOf` that
  // already exists. So on a stream recorded entirely through this pad the
  // clock never has a value, and the strip rendered a labelled em-dash
  // forever. An empty labelled field is dead weight on the most
  // space-constrained surface in the product: omit the item instead.
  it("omits the clock item entirely when nothing stamps a clock, rather than labelling an em-dash", () => {
    expect(buildScorebug(view(), t).strip.map((item) => item.id)).toEqual(["period"]);
    const stale = view({ state: state({ phase: "H2", asOf: { period: "H1", elapsed: 100 } }) });
    expect(buildScorebug(stale, t).strip.map((item) => item.id)).toEqual(["period"]);
  });

  it("shows the clock the moment the fold IS as-of a stamp in the current phase (v2's own staleness guard)", () => {
    const stamped = view({ state: state({ asOf: { period: "H1", elapsed: 754 } }) });
    const clock = buildScorebug(stamped, t).strip.find((item) => item.id === "clock");
    expect(clock?.value).toBe("12:34");
    // B4: emphasis moved from `accent` (the plain strip's own bold/muted
    // switch) to `tone: "led"`, which replaces the rendering entirely — an
    // `accent` left beside it would be a field nothing reads. The LED
    // treatment is asserted for every item, together, below.
    expect(clock?.tone).toBe("led");
  });

  // B3/fix 3. The strip printed `Period H1` — "H1"/"ET_H2"/"SHOOTOUT" are the
  // fold's internal tokens, and the strip is the most space-constrained
  // surface in the product, not the place to teach a scorer the engine's
  // vocabulary.
  it("names the period in prose, never the engine's own phase token", () => {
    expect(periodOf(view())).toBe("pad.football.phase.H1");
    expect(periodOf(view({ state: state({ phase: "H2" }) }))).toBe("pad.football.phase.H2");
    expect(periodOf(view({ state: state({ phase: "SHOOTOUT" }) }))).toBe("pad.football.phase.SHOOTOUT");
    expect(periodOf(view({ state: state({ phase: "pre" }) }))).toBe("pad.football.phase.pre");
    expect(periodOf(view({ state: state({ phase: "done" }) }))).toBe("pad.football.phase.done");
    expect(periodOf(view({ state: state({ phase: "final" }) }))).toBe("pad.football.phase.final");
    expect(periodOf(view({ state: state({ phase: "abandoned" }) }))).toBe("pad.football.phase.abandoned");
  });

  it("reuses the SHARED matchPhase.* copy for extra time rather than minting a second wording", () => {
    expect(periodOf(view({ state: state({ phase: "ET_H1" }) }))).toBe("matchPhase.ET_H1");
    expect(periodOf(view({ state: state({ phase: "ET_H2" }) }))).toBe("matchPhase.ET_H2");
  });

  // football.ts:454 — quarter 1 is deliberately NOT "Q1": it reuses "H1", the
  // literal halves mode opens on, so `core.start` needed no cfg branch. The
  // token is therefore ambiguous and only cfg can read it.
  it("reads H1 as the FIRST QUARTER under a quarters cfg, and the quarter literals in both modes", () => {
    const quarters = (phase: string) => periodOf(view({ cfg: cfg({ halves: 4 }), state: state({ phase }) }));
    expect(quarters("H1")).toBe("pad.football.phase.Q1");
    expect(quarters("Q2")).toBe("pad.football.phase.Q2");
    expect(quarters("Q3")).toBe("pad.football.phase.Q3");
    expect(quarters("Q4")).toBe("pad.football.phase.Q4");
    expect(periodOf(view({ state: state({ phase: "H1" }) }))).toBe("pad.football.phase.H1");
  });

  it("prints a token it has no label for VERBATIM — missing copy has to stay visible, never a plausible guess", () => {
    expect(periodOf(view({ state: state({ phase: "MYSTERY" }) }))).toBe("MYSTERY");
  });

  it("carries Law 7 added time on the WHISTLE's own line, never on the board — R3/F (F2)", () => {
    // The board no longer has an added-time item at all (see the fold-driven
    // pair below for why). This is where the minutes surface instead: attached
    // to the `football.period` event that set them, so they cannot outlive the
    // stoppage the way a strip item did.
    const detail = footballDetail({ t, eventType: "football.period", payload: { phase: "HT", addedMinutes: 3 }, personNames: NAMES });
    expect(detail).toContain("+3");
    expect(buildScorebug(view(), t).strip.map((i) => i.id)).not.toContain("added");
  });

  // -------------------------------------------------------------------------
  // B4 (owner ruling R3-6): the strip IS the fourth official's added-time
  // board. Not a decoration test — the ruling names this as football's ONE
  // signature element, and every failure mode below has already shipped once
  // in this programme in some form.
  // -------------------------------------------------------------------------

  it("puts EVERY strip item on the LED board, so the strip reads as one panel and not a mixed row", () => {
    const full = view({
      state: state({
        asOf: { period: "H1", elapsed: 754 },
        periods: [{ phase: "H1", home: 1, away: 0 }],
      }),
    });
    const strip = buildScorebug(full, t).strip;
    expect(strip.map((item) => item.id)).toEqual(["period", "clock"]);
    for (const item of strip) expect(item.tone, `strip item "${item.id}" is off the board`).toBe("led");
  });

  it("is HONEST AND QUIET with no time to show — one period panel, no empty well, no placeholder", () => {
    // The NORMAL case, not an edge one: `state.asOf` is only ever set from an
    // event's own `at`, and no v3 tile sends one, so a pad-only stream never
    // gets a clock or an added-time figure at all. A board that lit an empty
    // well here would look broken on every fresh match — which is exactly
    // what the em-dash B3 removed used to do.
    const fresh = buildScorebug(view({ state: state({ phase: "H1", periods: [] }) }), t);
    expect(fresh.strip.map((item) => item.id)).toEqual(["period"]);
    expect(fresh.strip[0]?.tone).toBe("led");
    expect(fresh.strip[0]?.value).toBe("pad.football.phase.H1");
    for (const item of fresh.strip) {
      expect(item.value, "the board lit a placeholder rather than staying dark").not.toMatch(/^[-\u2014\u2013\s]*$/);
    }
  });

  // -------------------------------------------------------------------------
  // R3/F (F2): the board carries NO added-time item, and the two facts that
  // decide it are both proved against the ENGINE, never a fixture.
  //
  // The hand-written fixture this block used to assert against —
  // `periods: [{ phase: "H1", addedMinutes: 3 }]` while `state.phase` is still
  // "H1" — is a state the fold CANNOT produce: `applyPeriod` stamps
  // `addedMinutes` on the period a marker CLOSES and, for every marker except
  // the final whistle, pushes the next period in the same step
  // (`pushPeriod(close(), …)`, football.ts:1536-1550). So the open period never
  // carries added time, and the mirror agreed with itself.
  // -------------------------------------------------------------------------

  it("never lights an added-time well — a real fold puts the minutes on a period the board has already left", () => {
    // Halves, quarters, and the two finals that do NOT push a period after the
    // whistle (`resolveFullTime`) — the only states where `periods[last]`
    // carries `addedMinutes` at all, and where the strip therefore used to
    // print the closed period's minutes beside a DIFFERENT period's label
    // ("Shoot-out · Added +5" is the second half's added time).
    const cases: { label: string; events: EventEnvelope[]; cfgOver?: Record<string, unknown> }[] = [
      {
        label: "second half, after a half-time whistle carrying +3",
        events: [
          envelope(1, "core.start", {}),
          envelope(2, "football.period", { phase: "HT", addedMinutes: 3 }),
        ],
      },
      {
        label: "full time, decided",
        events: [
          envelope(1, "core.start", {}),
          envelope(2, "football.goal", { by: "H" }),
          envelope(3, "football.period", { phase: "HT", addedMinutes: 3 }),
          envelope(4, "football.period", { phase: "FT", addedMinutes: 5 }),
        ],
      },
      {
        label: "shoot-out, level after 90",
        cfgOver: { shootout: true },
        events: [
          envelope(1, "core.start", {}),
          envelope(2, "football.goal", { by: "H" }),
          envelope(3, "football.goal", { by: "A" }),
          envelope(4, "football.period", { phase: "HT", addedMinutes: 3 }),
          envelope(5, "football.period", { phase: "FT", addedMinutes: 5 }),
        ],
      },
      {
        label: "third quarter, after two quarter whistles",
        cfgOver: { halves: 4 },
        events: [
          envelope(1, "core.start", {}),
          envelope(2, "football.period", { phase: "QT", addedMinutes: 2 }),
          envelope(3, "football.period", { phase: "HT", addedMinutes: 4 }),
        ],
      },
    ];
    for (const { label, events, cfgOver } of cases) {
      const folded = foldedView(events, 3, cfgOver ?? {});
      const state = folded.state as { periods?: { addedMinutes?: number }[] };
      // The fold really did record the minutes — otherwise this whole
      // assertion would pass for the trivial reason that nothing was stamped.
      expect(
        state.periods?.some((period) => typeof period.addedMinutes === "number"),
        `${label}: the fold recorded no added time, so this case proves nothing`,
      ).toBe(true);
      expect(
        buildScorebug(folded, t).strip.map((item) => item.id),
        `${label}: the board lit an added-time well`,
      ).not.toContain("added");
    }
  });

  it("could not have recorded added time in the first place — the period sheet sends the marker alone", () => {
    // The origination half of the same finding, and the reason the item is
    // removed rather than re-attributed: `football.period` carries an optional
    // `addedMinutes` (football.ts:2230), but it is a DEDICATED type — a tile
    // and a sheet — so the generic More form that would render that field is
    // never offered for it, and the sheet's own payload omits it. No v3
    // football surface can put a number there.
    const payload = buildSheets(view(), t).period!.buildPayload({ marker: "HT" });
    expect(Object.keys(payload)).toEqual(["phase"]);
    // …and it IS dedicated, resolved by the host's own function rather than
    // re-asserted from this file's reading of the skin.
    const v = view();
    expect([...dedicatedEventTypes(buildTiles(v), buildSheets(v, t), buildSwap(v, t), buildScorebug(v, t))]).toContain("football.period");
  });

  it("the context line states the FORMAT, which is the one thing cfg shrinks for a small-sided variant", () => {
    expect(buildScorebug(view(), t).context).toContain("pad.football.context.smallSided");
    expect(buildScorebug(view(), t).context).toContain('"size":11');
    const mini = view({ cfg: cfg({ teamSize: 7, halves: 4 }) });
    expect(buildScorebug(mini, t).context).toContain('"size":7');
    expect(buildScorebug(mini, t).context).toContain("pad.football.context.quarters");
  });

  it("carries the skin's own phase() answer, never the host's tab state", () => {
    expect(buildScorebug(view({ state: state({ phase: "final" }), phase: "live" }), t).phase).toBe("post");
  });

  // -------------------------------------------------------------------------
  // R3.5/Task D — `ScorebugHalf.sub`, the pens tally riding the SAME halves as
  // the regulation score. Before this the board showed `1` and `1` while the
  // headline above it already read "1 — 1 (2-1 pens)": two disagreeing score
  // readouts on one screen, exactly what design note D-11 exists to prevent.
  // -------------------------------------------------------------------------

  it("F3: football's halves carry the pens tally during SHOOTOUT, against a REAL fold", () => {
    const v = shootoutView([
      ["home", true],
      ["away", false],
      ["home", true],
      ["away", true],
    ]);
    const bug = buildScorebug(v, t);
    expect(bug.halves.map((h) => [h.big, h.sub])).toEqual([
      ["1", "(2)"],
      ["1", "(1)"],
    ]);
  });

  it("F4: no `sub` in any non-SHOOTOUT phase, across every REAL folded phase", () => {
    let sawShootout = false;
    for (const { label, phase, cfg: foldedCfg, state: foldedState } of foldedPhases()) {
      const bug = buildScorebug(view({ cfg: foldedCfg, state: foldedState }), t);
      if (phase === "SHOOTOUT") {
        sawShootout = true;
        continue; // F3 above covers the positive case
      }
      expect(bug.halves[0].sub, label).toBeUndefined();
      expect(bug.halves[1].sub, label).toBeUndefined();
    }
    // Vacuity guard: this loop proves nothing about the phase it never sees.
    expect(sawShootout, "foldedPhases() must still include a SHOOTOUT case").toBe(true);
  });

  it("F5: cricket and tennis never set `sub` — the field is opt-in, not chassis-forced", () => {
    // The documented degrade every v3 builder honours (this file's own
    // `resolvePhase` test above already relies on the identical `state: {}`
    // shape) — proving the field absent under the REAL cricket/tennis
    // builders, not a hand-typed stand-in for them.
    const empty = view({ state: {}, cfg: {} });
    for (const half of buildCricketScorebug(empty, t).halves) expect(half.sub, "cricket").toBeUndefined();
    for (const half of buildTennisScorebug(empty, t).halves) expect(half.sub, "tennis").toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// kickerCue() / expectedKicker — R3.5/Task F. The engine's OWN alternation
// rule, surfaced as an LED strip item so the pad prevents the out-of-turn
// refusal rather than explaining it afterwards in English no matter the
// scorer's locale (server-side messages are not localised).
// ---------------------------------------------------------------------------

describe("kickerCue — the board says whose kick is next (R3.5/F)", () => {
  it("F9: no cue before the first kick — either side may start", () => {
    const v = shootoutView([]);
    expect(kickerCue(v.state, t)).toBeUndefined();
    // …and the strip carries no item for it either — a real answer (null)
    // renders NOTHING, not a guess.
    expect(buildScorebug(v, t).strip.find((item) => item.id === "nextKicker")).toBeUndefined();
  });

  it("F10: after home kicks, the cue names Away", () => {
    const v = shootoutView([["home", true]]);
    expect(kickerCue(v.state, t)).toBe("scorepad.attribution.away");
    const item = buildScorebug(v, t).strip.find((i) => i.id === "nextKicker");
    expect(item?.value).toBe("scorepad.attribution.away");
    expect(item?.tone).toBe("led");
  });

  it("the cue is absent outside SHOOTOUT even if a stray `shootout` object is present", () => {
    // Defensive: `expectedKicker` on its own cannot see phase, only kicks —
    // `kickerCue` must gate on the FOLD's phase itself, the same guard
    // `phaseAllows("football.shootout.kick", …)` already applies to the tile.
    const v = shootoutView([["home", true]]);
    const doneState = { ...(v.state as Record<string, unknown>), phase: "done" };
    expect(kickerCue(doneState, t)).toBeUndefined();
  });

  it("F11: the engine still refuses an out-of-turn kick, naming the ENTRANT (not a UUID) — regression guard", () => {
    const cfgObj = footballCfg({ shootout: true, extraTime: { enabled: false, halfMinutes: 15 } });
    const afterHomeKick = foldFootball(cfgObj, [
      ["core.start"],
      ["football.goal", { by: "H" }],
      ["football.goal", { by: "A" }],
      ["football.period", { phase: "HT" }],
      ["football.period", { phase: "FT" }],
      ["football.shootout.kick", { by: "H", scored: true }],
    ]);
    const outOfTurn = envelope(999, "football.shootout.kick", { by: "H", scored: true });
    expect(() => football.apply(afterHomeKick, outOfTurn as never, { strict: true })).toThrowError(
      new RegExp(`expected "${afterHomeKick.entrants.away}"`),
    );
  });

  it("F14: voiding a kick reverts the tally and the expected kicker — a voided event is simply never replayed", () => {
    // Football's own event schema carries no per-kick `void` flag (that
    // belongs to the shared shoot-out primitive's OTHER sports); a "voided"
    // kick here means the chassis's generic void/undo path re-derives state
    // with that ledger event excluded — so "reverts" is a property of
    // REPLAY, proved by comparing two real folds that differ by one kick.
    const withTwo = shootoutView([
      ["home", true],
      ["away", true],
    ]);
    const asIfVoided = shootoutView([["home", true]]);
    expect(kickerCue(withTwo.state, t)).toBe("scorepad.attribution.home"); // tied 1-1 taken -> kicks[0]
    expect(kickerCue(asIfVoided.state, t)).toBe("scorepad.attribution.away"); // reverts
    expect(buildScorebug(withTwo, t).halves.map((h) => h.sub)).toEqual(["(1)", "(1)"]);
    expect(buildScorebug(asIfVoided, t).halves.map((h) => h.sub)).not.toEqual(
      buildScorebug(withTwo, t).halves.map((h) => h.sub),
    );
  });

  // F15/F16 (Task D) — `shootoutDecision`'s exact early-decision and sudden-
  // death arithmetic is the ENGINE's own tested territory (football.test.ts's
  // "enforces kick alternation and early decision arithmetic"); this proves
  // only what the PAD does once a real fold reaches either outcome — the
  // SAME "decided means unmounted" rule every sport follows
  // (`reference_v3_pad_unmounts_on_decided_fixture` — `resolvePhase` maps
  // `state.phase === "done"` to `PadPhase` "post", which is what makes
  // fixture-console.tsx drop the whole scoring section).
  it("F15: an early decision inside the regulation five reaches 'done', and the pad's own phase() maps it to post", () => {
    const cfgObj = footballCfg({ shootout: true, extraTime: { enabled: false, halfMinutes: 15 } });
    // H scores three straight, A misses three straight — away's remaining
    // entitlement (2) can never close a 3-0 gap, so this decides at the
    // sixth kick, inside the five-per-side regulation allotment.
    const early = foldFootball(cfgObj, [
      ["core.start"],
      ["football.goal", { by: "H" }],
      ["football.goal", { by: "A" }],
      ["football.period", { phase: "HT" }],
      ["football.period", { phase: "FT" }],
      ["football.shootout.kick", { by: "H", scored: true }],
      ["football.shootout.kick", { by: "A", scored: false }],
      ["football.shootout.kick", { by: "H", scored: true }],
      ["football.shootout.kick", { by: "A", scored: false }],
      ["football.shootout.kick", { by: "H", scored: true }],
      ["football.shootout.kick", { by: "A", scored: false }],
    ]);
    expect(early.phase, "this sequence must actually decide, or the case proves nothing").toBe("done");
    expect(early.outcome).toMatchObject({ method: "shootout" });
    expect(resolvePhase({ state: early })).toBe("post");
  });

  it("F16: tied after all five regulation pairs stays undecided (sudden death); the first pair with a lead decides it", () => {
    const cfgObj = footballCfg({ shootout: true, extraTime: { enabled: false, halfMinutes: 15 } });
    const throughRegulation: [type: string, payload?: unknown][] = [
      ["core.start"],
      ["football.goal", { by: "H" }],
      ["football.goal", { by: "A" }],
      ["football.period", { phase: "HT" }],
      ["football.period", { phase: "FT" }],
      // Both sides score all five regulation kicks — 5-5, still tied.
      ["football.shootout.kick", { by: "H", scored: true }],
      ["football.shootout.kick", { by: "A", scored: true }],
      ["football.shootout.kick", { by: "H", scored: true }],
      ["football.shootout.kick", { by: "A", scored: true }],
      ["football.shootout.kick", { by: "H", scored: true }],
      ["football.shootout.kick", { by: "A", scored: true }],
      ["football.shootout.kick", { by: "H", scored: true }],
      ["football.shootout.kick", { by: "A", scored: true }],
      ["football.shootout.kick", { by: "H", scored: true }],
      ["football.shootout.kick", { by: "A", scored: true }],
    ];
    const tied = foldFootball(cfgObj, throughRegulation);
    expect(tied.phase, "5-5 after all five regulation pairs must still be undecided").toBe("SHOOTOUT");
    expect(resolvePhase({ state: tied })).toBe("live");

    // Sudden death: Home scores the sixth pair's kick, Away misses.
    const decided = foldFootball(cfgObj, [
      ...throughRegulation,
      ["football.shootout.kick", { by: "H", scored: true }],
      ["football.shootout.kick", { by: "A", scored: false }],
    ]);
    expect(decided.phase).toBe("done");
    expect(decided.outcome).toMatchObject({ method: "shootout" });
    expect(resolvePhase({ state: decided })).toBe("post");
  });
});

// ---------------------------------------------------------------------------
// tiles() — per-side Goal/Card/Sub columns, shared Period, minor Pen, More.
// ---------------------------------------------------------------------------

describe("buildTiles", () => {
  it("declares a Goal tile per side, each committing SIDE-LEVEL with that side's own entrant id", () => {
    const tiles = buildTiles(view());
    const home = tileById(tiles, "goal-home")!;
    const away = tileById(tiles, "goal-away")!;
    expect(home.action).toEqual({ event: { type: "football.goal", payload: { by: "home-1" } } });
    expect(away.action).toEqual({ event: { type: "football.goal", payload: { by: "away-1" } } });
    expect(home.kind).toBe("primary");
  });

  // B3/fix 1. Six card tiles (yellow 1 + red 1 + second yellow 2 = a FULL
  // 4-column row per side) put Home's second yellow in columns 3-4 — bodily
  // inside the AWAY lane, under "Goal · Away". One Card tile per side, colour
  // chosen INSIDE the sheet, is what keeps the two lanes readable.
  it("declares ONE Card tile per side, spanning its own lane — the colour choice lives in the SHEET (R3-1)", () => {
    const tiles = buildTiles(view());
    for (const side of ["home", "away"] as const) {
      const tile = tileById(tiles, `card-${side}`);
      expect(tile, `card-${side}`).toBeDefined();
      expect(tile!.label).toBe("pad.football.action.card");
      expect(tile!.kind).toBe("standard");
      expect(tile!.span).toBe(2);
      expect(tile!.sublabel).toBe(side === "home" ? "scorepad.attribution.home" : "scorepad.attribution.away");
      expect(tile!.action).toEqual({ sheet: `card-${side}` });
    }
    for (const colour of CARD_COLORS) {
      expect(tileById(tiles, `card-home-${colour}`), `card-home-${colour}`).toBeUndefined();
      expect(tileById(tiles, `card-away-${colour}`), `card-away-${colour}`).toBeUndefined();
    }
  });

  // The rows themselves, in the order the grid lays them out. The lane test
  // below pins WHICH column a side lands in; this pins WHICH ROW an action
  // gets, so Card cannot drift back below Sub and split the pairs apart.
  it("emits the board in ROW order — Goal, Card, Sub per side, then Period + Pen, then More", () => {
    expect(buildTiles(view()).map((tile) => tile.id)).toEqual([
      "goal-home",
      "goal-away",
      "card-home",
      "card-away",
      "sub-home",
      "sub-away",
      "period",
      "penalty",
      "more",
    ]);
  });

  // THE regression guard for the whole board idea: two vertical lanes, Home
  // left and Away right, so a scorer addresses a team by POSITION and never
  // has to select one. Every unit test in this file passed while the card
  // tiles broke it, which is why this pins the geometry itself.
  it("gives every SIDE tile exactly half the 4-column grid, in every band and phase", () => {
    for (const band of BANDS) {
      for (const phase of ["H1", "H2", "ET_H1", "SHOOTOUT"]) {
        for (const tile of buildTiles(view({ band, state: state({ phase }) }))) {
          if (sideOfTile(tile) === null) continue;
          expect(tile.span, `${tile.id} @band ${band} ${phase}`).toBe(2);
        }
      }
    }
  });

  it("lands every Home tile in the LEFT lane and every Away tile in the RIGHT one, row after row", () => {
    for (const band of BANDS) {
      for (const phase of ["H1", "SHOOTOUT"]) {
        let col = 0;
        for (const tile of buildTiles(view({ band, state: state({ phase }) }))) {
          const span = tile.span ?? 1;
          if (col + span > 4) col = 0; // what CSS grid auto-placement does
          const side = sideOfTile(tile);
          if (side !== null) expect(col, `${tile.id} @band ${band} ${phase}`).toBe(side === "home" ? 0 : 2);
          col = (col + span) % 4;
        }
      }
    }
  });

  it("declares a Sub tile per side, each addressing its OWN swap slot", () => {
    const tiles = buildTiles(view());
    expect(tileById(tiles, "sub-home")!.action).toEqual({ swap: "sub-home" });
    expect(tileById(tiles, "sub-away")!.action).toEqual({ swap: "sub-away" });
  });

  it("declares Period once (shared), Pen as a MINOR tile, and the generic More sheet", () => {
    const tiles = buildTiles(view());
    expect(tileById(tiles, "period")!.action).toEqual({ sheet: "period" });
    expect(tileById(tiles, "penalty")!.kind).toBe("minor");
    expect(tiles.filter((tile) => tile.id.startsWith("period"))).toHaveLength(1);
    expect(tileById(tiles, "more")).toBeDefined();
  });

  // B3/fix 2. `pad.football.action.period` is the ENGINE's own action label,
  // "Period marker" — system vocabulary. A scorer records the whistle that
  // ends a half, a quarter or an extra-time period; the skin owns that word.
  it("labels the Period tile in the SCORER's words, never the engine's `period marker`", () => {
    const tile = tileById(buildTiles(view()), "period")!;
    expect(tile.label).toBe("pad.football.action.periodEnd");
    expect(tile.label).not.toBe("pad.football.action.period");
  });

  it("every tile is declared for the LIVE phase only — padSpec declares no pre/post panel for this sport", () => {
    for (const tile of buildTiles(view())) expect(tile.phases, tile.id).toEqual(["live"]);
  });

  it("every {swap} tile names a slot this skin's own swap() declares, and every {sheet} tile a sheet it builds", () => {
    const v = view();
    const slotIds = new Set(buildSwap(v, t).map((slot) => slot.id));
    const sheetKeys = new Set(Object.keys(buildSheets(v, t)));
    for (const tile of buildTiles(v)) {
      if ("swap" in tile.action) expect(slotIds.has(tile.action.swap), tile.id).toBe(true);
      if ("sheet" in tile.action && tile.action.sheet !== "__pad-host/more__") {
        expect(sheetKeys.has(tile.action.sheet), tile.id).toBe(true);
      }
    }
  });

  // The host's own band filter runs on ENTITLED bands; the dispatch guard runs
  // on the ACTIVE one (`buildPadView` drops an action whose band exceeds
  // `ctx.band`). A tile above the active band is therefore visible and THROWS
  // on tap — the dead-end tap this programme keeps closing — so the skin
  // withholds it.
  it("withholds every tile whose event sits above the ACTIVE fidelity band, keeping the band-0 ones", () => {
    const ids = buildTiles(view({ band: 0 })).map((tile) => tile.id);
    expect(ids).toContain("goal-home");
    expect(ids).toContain("period");
    expect(ids).toContain("more");
    expect(ids).not.toContain("card-home");
    expect(ids).not.toContain("sub-home");
    expect(ids).not.toContain("penalty");
  });

  it("offers every band-2 tile once the active band reaches 2", () => {
    const ids = buildTiles(view({ band: 2 })).map((tile) => tile.id);
    expect(ids).toContain("card-home");
    expect(ids).toContain("sub-home");
    expect(ids).toContain("penalty");
  });

  it("withholds the play-phase-only tiles during a shoot-out, where the fold refuses them — cards stay, they are legal there", () => {
    const ids = buildTiles(view({ state: state({ phase: "SHOOTOUT" }) })).map((tile) => tile.id);
    expect(ids).not.toContain("goal-home");
    expect(ids).not.toContain("sub-home");
    expect(ids).not.toContain("penalty");
    expect(ids).not.toContain("period");
    expect(ids).toContain("card-home");
    expect(ids).toContain("more");
  });
});

// ---------------------------------------------------------------------------
// R3.5/Task J (ruling R3.5-5) — phase-gated kick tiles. R3-4 AMENDED for the
// SHOOTOUT phase ONLY: it put four RARE types in the generic More sheet and
// still stands everywhere else, but in this phase the rare type is the whole
// match, and the board otherwise holds two card tiles and nothing else while
// the only action of the phase sat two taps deep. Every case below drives a
// REAL fold (`shootoutView`) — see this file's header note.
// ---------------------------------------------------------------------------

describe("buildTiles — phase-gated kick tiles during SHOOTOUT (R3.5/J)", () => {
  it("F6: kick tiles present, goal tiles absent, during a REAL shoot-out", () => {
    const v = shootoutView([]);
    const ids = buildTiles(v).map((tile) => tile.id);
    expect(ids).toEqual(expect.arrayContaining(["kick-home", "kick-away"]));
    expect(ids).not.toEqual(expect.arrayContaining(["goal-home", "goal-away"]));
  });

  it("F7: no kick tiles in any phase but SHOOTOUT, across every REAL folded phase", () => {
    let sawShootout = false;
    for (const { label, phase, cfg: foldedCfg, state: foldedState } of foldedPhases()) {
      const ids = buildTiles(view({ cfg: foldedCfg, state: foldedState })).map((tile) => tile.id);
      if (phase === "SHOOTOUT") {
        sawShootout = true;
        expect(ids, label).toEqual(expect.arrayContaining(["kick-home", "kick-away"]));
        continue;
      }
      expect(ids, label).not.toContain("kick-home");
      expect(ids, label).not.toContain("kick-away");
    }
    expect(sawShootout, "foldedPhases() must still include a SHOOTOUT case").toBe(true);
  });

  it("kick tiles occupy the Goal tiles' own slot: primary, span 2, matching sublabels, opening a two-outcome sheet", () => {
    const v = shootoutView([]);
    const home = tileById(buildTiles(v), "kick-home")!;
    const away = tileById(buildTiles(v), "kick-away")!;
    expect(home.label).toBe("pad.football.action.shootoutKick");
    expect(home.sublabel).toBe("scorepad.attribution.home");
    expect(home.kind).toBe("primary");
    expect(home.span).toBe(2);
    expect(home.phases).toEqual(["live"]);
    expect(home.action).toEqual({ sheet: "kick-home" });
    expect(away.sublabel).toBe("scorepad.attribution.away");
    expect(away.action).toEqual({ sheet: "kick-away" });
  });

  it("F9/F10 (tiles): at zero kicks neither tile is disabled; once a side has kicked, the OTHER side's tile is", () => {
    const zero = shootoutView([]);
    expect(tileById(buildTiles(zero), "kick-home")!.disabled).toBeUndefined();
    expect(tileById(buildTiles(zero), "kick-away")!.disabled).toBeUndefined();

    const afterHome = shootoutView([["home", true]]);
    expect(tileById(buildTiles(afterHome), "kick-home")!.disabled).toBe(true);
    expect(tileById(buildTiles(afterHome), "kick-away")!.disabled).toBeUndefined();
  });

  it("F17: card tiles remain legal during a REAL shoot-out fold", () => {
    const ids = buildTiles(shootoutView([])).map((tile) => tile.id);
    expect(ids).toContain("card-home");
    expect(ids).toContain("card-away");
  });

  it("F8: the kick-home sheet records football.shootout.kick for HOME; kick-away for AWAY", () => {
    const v = shootoutView([]);
    const sheets = buildSheets(v, t);
    expect(drive(sheets["kick-home"]!, ["scored"])).toEqual({
      type: "football.shootout.kick",
      payload: { by: "H", scored: true },
    });
    expect(drive(sheets["kick-away"]!, ["missed"])).toEqual({
      type: "football.shootout.kick",
      payload: { by: "A", scored: false },
    });
  });

  it("the kick sheets are ALWAYS declared (same convention as period/penalty/card) so copy-truth sees them", () => {
    const keys = Object.keys(buildSheets(view(), t));
    expect(keys).toContain("kick-home");
    expect(keys).toContain("kick-away");
  });

  it("every {sheet} kick tile names a sheet buildSheets() actually builds — the same closed-loop check every other tile gets", () => {
    const v = shootoutView([]);
    const sheetKeys = new Set(Object.keys(buildSheets(v, t)));
    for (const tile of buildTiles(v)) {
      if ("sheet" in tile.action && tile.action.sheet !== "__pad-host/more__") {
        expect(sheetKeys.has(tile.action.sheet), tile.id).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// sheets() — driven through the REAL step machine.
// ---------------------------------------------------------------------------

function drive(spec: GuidedSheetSpec, answers: readonly string[]) {
  let state = initialSheetState();
  for (const answer of answers) {
    const outcome = answerStep(spec, state, answer);
    if (outcome.done) return outcome.event;
    state = outcome.state;
  }
  return null;
}

describe("buildSheets — the card flow (R3-1)", () => {
  it("asks the COLOUR first — all three, in the shared cardColor.* wording, never a second vocabulary", () => {
    const spec = buildSheets(view({ band: 2 }), t)["card-home"]!;
    const step = currentStep(spec, initialSheetState());
    expect(step?.id).toBe("color");
    expect(step?.kind === "choice" && step.options.map((o) => o.id)).toEqual([...CARD_COLORS]);
    expect(step?.kind === "choice" && step.options.map((o) => o.label)).toEqual([
      "cardColor.yellow",
      "cardColor.red",
      "cardColor.second_yellow",
    ]);
  });

  // -------------------------------------------------------------------------
  // B4 (owner ruling R3-6): the CARD CODE. This is the load-bearing argument
  // for the whole per-sport-identity ruling — yellow and red are the only
  // colours in football's visual language that carry MEANING, and before B4
  // this pad discarded both (a red rendered in the chassis's generic
  // `destructive` red, identical to Abandon; a yellow rendered neutral).
  // B3 collapsed cards to ONE neutral tile per side to keep the two lanes
  // intact, so this step is now the only place a card colour can appear.
  // -------------------------------------------------------------------------

  it("colours each option with the CARD CODE, and gives second yellow BOTH cards in offence order", () => {
    const spec = buildSheets(view({ band: 2 }), t)["card-home"]!;
    const step = currentStep(spec, initialSheetState());
    const tones = step?.kind === "choice" ? step.options.map((o) => [o.id, o.tone] as const) : [];
    expect(tones).toEqual([
      ["yellow", ["caution"]],
      ["red", ["dismissal"]],
      // Two, not one: a second yellow IS a yellow card and a red one, which is
      // also why the engine keeps it as its own colour rather than a red with
      // a note. Order matters — the chassis washes the option in the LAST
      // tone, i.e. the outcome.
      ["second_yellow", ["caution", "dismissal"]],
    ]);
  });

  it("names TONES, never colours — a skin that supplied a hex would have forked the token layer", () => {
    const spec = buildSheets(view({ band: 2 }), t)["card-home"]!;
    const step = currentStep(spec, initialSheetState());
    const declared = step?.kind === "choice" ? step.options.flatMap((o) => [...(o.tone ?? [])]) : [];
    expect(declared.length).toBeGreaterThan(0); // vacuity guard
    for (const tone of declared) expect(SPORT_TONES).toContain(tone);
  });

  it("leaves every OTHER choice step untoned — colour here is information, not decoration", () => {
    // The offence list, the period markers and the penalty outcomes carry no
    // colour at all. If a later wave starts tinting those, the card code stops
    // meaning anything, which is the failure this assertion exists to catch.
    for (const [key, spec] of Object.entries(buildSheets(view({ band: 3 }), t))) {
      for (const step of spec.steps) {
        if (step.kind !== "choice" || (key.startsWith("card-") && step.id === "color")) continue;
        for (const option of step.options) {
          expect(option.tone, `${key}/${step.id}/${option.id} is tinted`).toBeUndefined();
        }
      }
    }
  });

  it("then asks the offence at band 2+, offering all 13 CardReason values, and commits colour + side + reason", () => {
    const spec = buildSheets(view({ band: 2 }), t)["card-home"]!;
    const advanced = answerStep(spec, initialSheetState(), "yellow");
    expect(advanced.done).toBe(false);
    const second = advanced.done ? null : currentStep(spec, advanced.state);
    expect(second?.id).toBe("reason");
    expect(second?.kind === "choice" && second.options).toHaveLength(13);
    expect(drive(spec, ["yellow", "dissent"])).toEqual({
      type: "football.card",
      payload: { by: "home-1", color: "yellow", reason: "dissent" },
    });
  });

  // `second_yellow` is its OWN colour, never a red with a note: the engine
  // computes the suspension tariff from the reason, not the colour.
  it("carries second_yellow through as its own colour, from either side's sheet", () => {
    expect(drive(buildSheets(view(), t)["card-away"]!, ["second_yellow", "violent_conduct"])).toEqual({
      type: "football.card",
      payload: { by: "away-1", color: "second_yellow", reason: "violent_conduct" },
    });
  });

  it("HIDES the offence step below band 2 and commits on the colour alone — `reason` is optional in the engine", () => {
    const spec = buildSheets(view({ band: 1 }), t)["card-home"]!;
    expect(currentStep(spec, initialSheetState())?.id).toBe("color");
    expect(drive(spec, ["red"])).toEqual({
      type: "football.card",
      payload: { by: "home-1", color: "red" },
    });
  });

  // The card is a band-2 event, so its tile is withheld below that entirely
  // (`EVENT_BAND`) — a tile whose every sheet step is gated off would open a
  // sheet that renders `null`, a tap with no visible response at all.
  it("withholds the card TILE below band 2 and opens ONE sheet per side at band 2+", () => {
    expect(tileById(buildTiles(view({ band: 1 })), "card-home")).toBeUndefined();
    expect(tileById(buildTiles(view({ band: 2 })), "card-home")!.action).toEqual({ sheet: "card-home" });
    expect(Object.keys(buildSheets(view(), t)).filter((key) => key.startsWith("card-"))).toEqual([
      "card-home",
      "card-away",
    ]);
  });
});

describe("buildSheets — period and penalty", () => {
  it("offers exactly the markers this cfg's own fold accepts", () => {
    const halves = buildSheets(view(), t)["period"]!;
    expect((halves.steps[0] as { options: { id: string }[] }).options.map((o) => o.id)).toEqual(["HT", "FT"]);
    const quarters = buildSheets(view({ cfg: cfg({ halves: 4 }) }), t)["period"]!;
    expect((quarters.steps[0] as { options: { id: string }[] }).options.map((o) => o.id)).toEqual(["QT", "HT", "3QT", "FT"]);
  });

  it("commits a period marker with no side attribution — a whistle belongs to neither team", () => {
    expect(drive(buildSheets(view(), t)["period"]!, ["HT"])).toEqual({
      type: "football.period",
      payload: { phase: "HT" },
    });
  });

  it("asks which side was awarded the penalty, then what happened — outcome is REQUIRED in the engine", () => {
    const spec = buildSheets(view(), t)["penalty"]!;
    expect(spec.steps.map((s) => s.id)).toEqual(["by", "outcome"]);
    expect(drive(spec, ["away-1", "saved"])).toEqual({
      type: "football.penalty",
      payload: { by: "away-1", outcome: "saved" },
    });
  });
});

// ---------------------------------------------------------------------------
// swap() — R3-2 + R3-5. The wave's centrepiece.
// ---------------------------------------------------------------------------

describe("buildSwap", () => {
  it("declares one slot per side, addressed by the Sub tiles, both dispatching football.sub", () => {
    const slots = buildSwap(view(), t);
    expect(slots.map((slot) => slot.id)).toEqual(["sub-home", "sub-away"]);
    expect(slots[0]!.side).toBe("home");
    expect(slots[1]!.side).toBe("away");
  });

  // R3's chassis wave: `eventType` is declared STATICALLY (the band filter
  // runs before any pick exists) and NOTHING checks it against what
  // `buildEvent` returns — "a skin owes its own test that the pair agree".
  // This is that test. A skin that declared one type and built another would
  // be correctly band-filtered on a lie.
  it("declares the SAME event type it actually builds — the pin the chassis cannot make for itself", () => {
    for (const slot of buildSwap(view(), t)) {
      expect(slot.buildEvent("h1", "h4").type, slot.id).toBe(slot.eventType);
      expect(ENGINE_EVENT_TYPES.has(slot.eventType), slot.eventType).toBe(true);
    }
  });

  it("builds the substitution against the side's own entrant id, off and on both required", () => {
    const home = buildSwap(view(), t)[0]!;
    expect(home.buildEvent("h1", "h4")).toEqual({
      type: "football.sub",
      payload: { by: "home-1", off: "h1", on: "h4" },
    });
  });

  it("scopes the OFF list to who is on the pitch RIGHT NOW, not the kickoff sheet", () => {
    const live = state({
      squads: {
        home: footballSquad({ onPitch: ["h2", "h3", "h4"], bench: ["h5"], offUsed: ["h1"] }),
        away: footballSquad({ onPitch: ["a1", "a2", "a3"], bench: ["a4", "a5"] }),
      },
    });
    const home = buildSwap(view({ state: live }), t)[0]!;
    expect(home.offCandidates).toEqual(["h2", "h3", "h4"]);
  });

  it("scopes the ON list to everyone the kernel still knows and is not on the pitch — bench PLUS the already-substituted", () => {
    const live = state({
      squads: {
        home: footballSquad({ onPitch: ["h2", "h3", "h4"], bench: ["h5"], offUsed: ["h1"] }),
        away: footballSquad({ onPitch: ["a1", "a2", "a3"], bench: ["a4", "a5"] }),
      },
    });
    const home = buildSwap(view({ state: live }), t)[0]!;
    expect(home.candidates).toEqual(["h5", "h1"]);
  });

  it("keeps an already-substituted player VISIBLE with the reason rather than removing them (reentry: none)", () => {
    const live = state({
      squads: {
        home: footballSquad({ onPitch: ["h2", "h3", "h4"], bench: ["h5"], offUsed: ["h1"] }),
        away: footballSquad({ onPitch: ["a1", "a2", "a3"], bench: ["a4", "a5"] }),
      },
    });
    const home = buildSwap(view({ state: live }), t)[0]!;
    expect(home.blocked?.h1).toBe("pad.football.context.sub.blocked.reentry.short");
    expect(home.blocked?.h5).toBeUndefined();
  });

  it("blocks nobody under rolling substitutions — the variant that permits a return", () => {
    const live = state({
      squads: {
        home: footballSquad({ onPitch: ["h2", "h3"], bench: ["h5", "h1"], offUsed: [] }),
        away: footballSquad({ onPitch: ["a1"], bench: ["a4"] }),
      },
    });
    const slots = buildSwap(view({ cfg: cfg({ rollingSubs: true }), state: live }), t);
    expect(slots[0]!.blocked).toEqual({});
    expect(slots[0]!.policyOk).toBe(true);
  });

  it("keeps a sent-off SUBSTITUTE visible on the bench with its own reason — the only way that ground is reachable", () => {
    const live = state({
      squads: {
        home: footballSquad({ onPitch: ["h1", "h2", "h3"], bench: ["h4", "h5"], sentOff: ["h4"] }),
        away: footballSquad({ onPitch: ["a1"], bench: ["a4"] }),
      },
    });
    const home = buildSwap(view({ state: live }), t)[0]!;
    expect(home.candidates).toContain("h4");
    expect(home.blocked?.h4).toBe("pad.football.context.sub.blocked.sentOff.short");
    expect(home.blocked?.h5).toBeUndefined();
  });

  it("blocks a sent-off player from returning, and never offers them as a replacement for themselves", () => {
    const live = state({
      squads: {
        home: footballSquad({ onPitch: ["h2", "h3"], bench: ["h4", "h5"], sentOff: ["h1"] }),
        away: footballSquad({ onPitch: ["a1"], bench: ["a4"] }),
      },
    });
    const home = buildSwap(view({ state: live }), t)[0]!;
    expect(home.candidates).not.toContain("h1");
    expect(home.offCandidates).not.toContain("h1");
  });

  // TWO INDEPENDENT refusals, both owed: the PLAYER cap (lineupPolicy) and the
  // WINDOW cap (Law 3 stoppages). Neither implies the other.
  it("refuses with the PLAYER cap once maxSubs is spent, worded with the numbers", () => {
    const live = state({
      squads: {
        home: footballSquad({ onPitch: ["h2"], bench: ["h5"], offUsed: ["h1", "h3", "hx"] }),
        away: footballSquad({ onPitch: ["a1"], bench: ["a4"] }),
      },
    });
    const home = buildSwap(view({ state: live }), t)[0]!;
    expect(home.policyOk).toBe(false);
    expect(home.policyMessage).toContain("pad.football.context.sub.blocked.maxSubs");
    expect(home.policyMessage).toContain('"used":3');
    expect(home.policyMessage).toContain('"max":3');
  });

  it("refuses with the WINDOW cap once every stoppage is spent, even with substitutions still in hand", () => {
    const live = state({
      phase: "H2",
      asOf: { period: "H2", elapsed: 1000 },
      squads: {
        home: footballSquad({
          subWindows: [
            { period: "H1", elapsed: 100 },
            { period: "H1", elapsed: 200 },
            { period: "H2", elapsed: 300 },
          ],
        }),
        away: footballSquad({ onPitch: ["a1"], bench: ["a4"] }),
      },
    });
    const home = buildSwap(view({ state: live }), t)[0]!;
    expect(home.policyOk).toBe(false);
    expect(home.policyMessage).toContain("pad.football.context.sub.blocked.subWindows");
    expect(home.policyMessage).toContain('"windows":3');
  });

  it("does NOT refuse on the window cap when this stamp is a window the side has already opened — three subs at one stoppage are one window", () => {
    const live = state({
      phase: "H2",
      asOf: { period: "H2", elapsed: 300 },
      squads: {
        home: footballSquad({
          subWindows: [
            { period: "H1", elapsed: 100 },
            { period: "H1", elapsed: 200 },
            { period: "H2", elapsed: 300 },
          ],
        }),
        away: footballSquad({ onPitch: ["a1"], bench: ["a4"] }),
      },
    });
    expect(buildSwap(view({ state: live }), t)[0]!.policyOk).toBe(true);
  });

  it("does NOT refuse on the window cap when nothing can be stamped — an unstamped substitution consumes no window", () => {
    const live = state({
      squads: {
        home: footballSquad({
          subWindows: [
            { period: "H1", elapsed: 100 },
            { period: "H1", elapsed: 200 },
            { period: "H1", elapsed: 300 },
          ],
        }),
        away: footballSquad({ onPitch: ["a1"], bench: ["a4"] }),
      },
    });
    expect(buildSwap(view({ state: live }), t)[0]!.policyOk).toBe(true);
  });

  // R3-2 + the `at`-stamp note: stamp from the fold's own `asOf`, with v2's
  // staleness guard. A WRONG stamp mis-attributes a stoppage; no stamp merely
  // consumes no window.
  it("stamps `at` from the fold's asOf when it names the CURRENT phase", () => {
    const stamped = view({ state: state({ asOf: { period: "H1", elapsed: 754 } }) });
    expect(buildSwap(stamped, t)[0]!.buildEvent("h1", "h4").payload).toEqual({
      by: "home-1",
      off: "h1",
      on: "h4",
      at: { period: "H1", elapsed: 754 },
    });
  });

  // CORRECTED, R6 fix pass 2 gap 6. These two asserted the `at` key was ABSENT,
  // which is how the refusal was written — a spread of `{}` — and after R6/task
  // A that spelling no longer expresses it. `stampPayload` (../../clock.ts)
  // returns a payload that already carries an `at` KEY by reference, whatever
  // its value; a payload with NO key has expressed no opinion and gets the
  // host's live clock stamp. So spreading `{}` handed the chassis a blank this
  // skin had decided to leave empty, and the guard whose own comment ends "Do
  // not 'fix' this later by stamping unconditionally" was silently un-expressed.
  // The value is still absent. The key is now the statement.
  it("DECLARES `at: undefined` when the fold carries none — the key is the refusal", () => {
    const payload = buildSwap(view(), t)[0]!.buildEvent("h1", "h4").payload as Record<string, unknown>;
    expect("at" in payload, "no `at` key means the chassis will fill it in").toBe(true);
    expect(payload.at).toBeUndefined();
  });

  it("DECLARES `at: undefined` when asOf names a phase the match has already left", () => {
    const stale = view({ state: state({ phase: "H2", asOf: { period: "H1", elapsed: 754 } }) });
    const payload = buildSwap(stale, t)[0]!.buildEvent("h1", "h4").payload as Record<string, unknown>;
    expect("at" in payload).toBe(true);
    expect(payload.at).toBeUndefined();
  });

  it("and the chassis gateway LEAVES IT ALONE — a running clock cannot overwrite the refusal", () => {
    // The end-to-end proof, through the real `send` gateway rather than an
    // assertion about the payload alone: a clock that is running, known, and
    // reading a plausible time still stamps nothing onto a substitution this
    // skin refused. Without the key, `stampFor` would attach `{H2, 900}` —
    // `applySub`'s window arithmetic would then read a stoppage that never
    // happened.
    const stale = view({ state: state({ phase: "H2", asOf: { period: "H1", elapsed: 754 } }) });
    const slot = buildSwap(stale, t)[0]!;
    const event = slot.buildEvent("h1", "h4");
    const clock = startClock(initClock("H2", 0), 1_000);
    const sent = stampFor(football as AnySportModule, event.type, event.payload, clock, 1_000 + 900_000) as Record<
      string,
      unknown
    >;
    expect(sent.at, "the host's clock overwrote a deliberate omission").toBeUndefined();

    // …and the same gateway DOES stamp a payload that expresses no opinion, so
    // the assertion above is about the key and not about a dead gateway.
    const opinionless = { by: "home-1", off: "h1", on: "h4" };
    const stamped = stampFor(football as AnySportModule, event.type, opinionless, clock, 1_000 + 900_000) as Record<
      string,
      unknown
    >;
    expect(stamped.at).toEqual({ period: "H2", elapsed: 900 });
  });

  it("offers nothing outside a play phase — the fold refuses a substitution in a shoot-out", () => {
    expect(buildSwap(view({ state: state({ phase: "SHOOTOUT" }) }), t)).toEqual([]);
    expect(buildSwap(view({ state: state({ phase: "pre" }) }), t)).toEqual([]);
  });

  it("labels both pickers with this skin's own keys", () => {
    const home = buildSwap(view(), t)[0]!;
    expect(home.offLabel).toBe("scorepad.skin.football.swap.off");
    expect(home.onLabel).toBe("scorepad.skin.football.swap.on");
  });

  // WS-D (R8 sweep) — the R7 `CandidateMeta` mechanism (types.ts,
  // context-strip.tsx's `renderCandidateRow`) already renders a position
  // badge + role tag when a skin supplies one; volleyball's `liberoCandidateMeta`
  // was the first populator, football never wired it, so eleven near-identical
  // on-pitch names rendered with no distinguisher. Sourced from `view.squads`
  // (the kickoff team sheet — see `onCandidates`'s own doc above for why THAT
  // field is stale for the POOL but is exactly right for a squad number/role
  // that does not change when a player is substituted).
  describe("candidateMeta — distinguishing the OFF-step rows by position/number", () => {
    function squadsWithMeta(): SquadState {
      return initSquads({
        home: {
          entrantId: "home-1",
          slots: [
            { personId: "h1", slot: "starting", orderNo: 1, positionKey: "GK", squadNumber: 1 },
            { personId: "h2", slot: "starting", orderNo: 2, positionKey: "CB", squadNumber: 4, roles: ["captain"] },
            { personId: "h3", slot: "starting", orderNo: 3, positionKey: "ST", squadNumber: 9 },
            { personId: "h4", slot: "bench", orderNo: 4, squadNumber: 14 },
            { personId: "h5", slot: "bench", orderNo: 5, squadNumber: 15 },
          ],
        },
        away: {
          entrantId: "away-1",
          slots: [
            { personId: "a1", slot: "starting", orderNo: 1, positionKey: "GK", squadNumber: 1 },
            { personId: "a2", slot: "starting", orderNo: 2, positionKey: "CB", squadNumber: 5 },
            { personId: "a3", slot: "starting", orderNo: 3, positionKey: "ST", squadNumber: 10 },
            { personId: "a4", slot: "bench", orderNo: 4, squadNumber: 16 },
            { personId: "a5", slot: "bench", orderNo: 5, squadNumber: 17 },
          ],
        },
      });
    }

    it("gives every OFF candidate a real position distinguisher, and two on-pitch teammates DISTINCT meta — the mutation witness", () => {
      const home = buildSwap(view({ squads: squadsWithMeta() }), t)[0]!;
      // The OFF pool is the live on-pitch three (h1 GK, h2 CB, h3 ST).
      for (const id of home.offCandidates ?? []) {
        expect(home.candidateMeta?.[id]?.lead, id).not.toBeUndefined();
      }
      expect(home.candidateMeta?.h1?.lead).toBe("GK");
      expect(home.candidateMeta?.h2?.lead).toBe("CB");
      expect(home.candidateMeta?.h3?.lead).toBe("ST");
      // A builder that stamped the SAME meta on every row must fail this.
      expect(home.candidateMeta?.h1?.lead).not.toBe(home.candidateMeta?.h2?.lead);
      expect(home.candidateMeta?.h2?.lead).not.toBe(home.candidateMeta?.h3?.lead);
    });

    it("tags the captain with the role a position code cannot say, and leaves everyone else untagged", () => {
      const home = buildSwap(view({ squads: squadsWithMeta() }), t)[0]!;
      expect(home.candidateMeta?.h2?.tag).toBe("pad.football.swap.captainTag");
      expect(home.candidateMeta?.h1?.tag).toBeUndefined();
      expect(home.candidateMeta?.h3?.tag).toBeUndefined();
    });

    it("falls back to the squad number for a bench candidate — the ON step's own pool, whose declared position is a preference the fold never carries as occupancy", () => {
      const home = buildSwap(view({ squads: squadsWithMeta() }), t)[0]!;
      expect(home.candidates).toContain("h4");
      expect(home.candidateMeta?.h4?.lead).toBe("14");
      expect(home.candidateMeta?.h5?.lead).toBe("15");
    });

    it("renders NOTHING extra when the view carries no position/number data — every existing fixture keeps its exact current row", () => {
      const home = buildSwap(view(), t)[0]!;
      expect(home.candidateMeta).toEqual({});
    });
  });
});

// ---------------------------------------------------------------------------
// dock() — the goal's scorer/assist chips and the card's person chips.
// ---------------------------------------------------------------------------

describe("buildDock", () => {
  it("returns null for an event with nothing worth enriching", () => {
    expect(buildDock("football.period", view(), t, {})).toBeNull();
    expect(buildDock("football.shot", view(), t, {})).toBeNull();
  });

  // Owner ruling, review round 3: ONE QUESTION AT A TIME. The dock used to
  // offer every scorer chip and every assist chip together — 24 at 11-a-side,
  // inside a ~6s window `mutateHeld` never extends.
  it("asks only WHO SCORED first — no assist chip is on screen before a scorer exists", () => {
    const dock = buildDock("football.goal", view(), t, { by: "home-1" })!;
    const ids = dock.chips.map((chip) => chip.id);
    expect(ids.slice(0, 2)).toEqual(["ownGoal", "penalty"]);
    expect(ids).toContain("scorer:h1");
    expect(ids.filter((id) => id.startsWith("assist:")), "two questions were on screen at once").toEqual([]);
    expect(ids).not.toContain("scorer:a1"); // the other side never scored this one
    expect(ids).not.toContain("scorer:h4"); // on the bench: the fold refuses a scorer who is not on the pitch
    expect(dock.title).toBe("pad.football.dock.goal.title");
  });

  it("becomes the ASSIST step once a scorer is picked, and drops the scorer chips", () => {
    const dock = buildDock("football.goal", view(), t, { by: "home-1", scorer: "h2" })!;
    const ids = dock.chips.map((chip) => chip.id);
    expect(ids.filter((id) => id.startsWith("scorer:")), "the answered question is still being asked").toEqual([]);
    expect(ids).toContain("assist:h1");
    expect(ids).toContain("assist:h3");
    expect(dock.title, "the panel must say which question it is now asking").toBe(
      "pad.football.dock.goal.assist.title",
    );
  });

  // Both taken verbatim from the engine generator's own `assistPool`
  // (football.ts:3026-3034). `applyGoal` validates only the scorer, so neither
  // of these would be REFUSED — they would just be wrong, and silently.
  it("never offers the scorer as their own assist", () => {
    const dock = buildDock("football.goal", view(), t, { by: "home-1", scorer: "h2" })!;
    expect(dock.chips.map((chip) => chip.id)).not.toContain("assist:h2");
  });

  it("offers NO assist at all on an own goal — the fold credits it to the opponent", () => {
    const dock = buildDock("football.goal", view(), t, { by: "home-1", scorer: "h2", ownGoal: true })!;
    expect(dock.chips.filter((chip) => chip.id.startsWith("assist:"))).toEqual([]);
    expect(dock.title).toBe("pad.football.dock.goal.title");
  });

  it("halves what is on screen at 11-a-side — the panel the ruling was about", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `h${i + 1}`);
    const v = view({
      state: state({ squads: { home: footballSquad({ onPitch: eleven, bench: [] }), away: footballSquad({ onPitch: ["a1"] }) } }),
    });
    const step1 = buildDock("football.goal", v, t, { by: "home-1" })!.chips.length;
    const step2 = buildDock("football.goal", v, t, { by: "home-1", scorer: "h2" })!.chips.length;
    expect(step1, "2 toggles + 11 scorers").toBe(13);
    expect(step2, "2 toggles + 10 assists (everyone but the scorer)").toBe(12);
    expect(Math.max(step1, step2), "the old panel put 24 on screen at once").toBeLessThan(24);
  });

  it("labels a person chip with the NAME, pre-localised, never through a dictionary key", () => {
    const dock = buildDock("football.goal", view(), t, { by: "home-1" })!;
    expect(dock.chips.find((chip) => chip.id === "scorer:h1")!.labelText).toBe("Home One");
    const assistStep = buildDock("football.goal", view(), t, { by: "home-1", scorer: "h2" })!;
    expect(assistStep.chips.find((chip) => chip.id === "assist:h1")!.labelText).toContain("Home One");
  });

  it("chips mutate only their own field, leaving the rest of the payload alone", () => {
    const dock = buildDock("football.goal", view(), t, { by: "home-1" })!;
    const withScorer = dock.chips.find((chip) => chip.id === "scorer:h2")!.mutate({ by: "home-1" });
    expect(withScorer).toEqual({ by: "home-1", scorer: "h2" });
    // The assist chip now lives on the SECOND step's dock, which is exactly the
    // panel `resolveDockSpec` rebuilds from this mutated payload.
    const assistStep = buildDock("football.goal", view(), t, withScorer)!;
    expect(assistStep.chips.find((chip) => chip.id === "assist:h3")!.mutate(withScorer)).toEqual({
      by: "home-1",
      scorer: "h2",
      assist: "h3",
    });
    expect(dock.chips.find((chip) => chip.id === "ownGoal")!.mutate({ by: "home-1" })).toEqual({
      by: "home-1",
      ownGoal: true,
    });
  });

  it("withholds the attribution chips below band 2, keeping the two toggles — attribution is the band-2 timeline", () => {
    const dock = buildDock("football.goal", view({ band: 0 }), t, { by: "home-1" })!;
    expect(dock.chips.map((chip) => chip.id)).toEqual(["ownGoal", "penalty"]);
  });

  it("narrows the card's person chips by COLOUR — the engine refuses a second yellow to anyone without a first", () => {
    const carded = state({ cards: [{ side: "home", person: "h2", color: "yellow" }] });
    const v = view({ state: carded });
    const yellow = buildDock("football.card", v, t, { by: "home-1", color: "yellow" })!;
    expect(yellow.chips.map((c) => c.id)).toEqual(["person:h1", "person:h3"]);
    const second = buildDock("football.card", v, t, { by: "home-1", color: "second_yellow" })!;
    expect(second.chips.map((c) => c.id)).toEqual(["person:h2"]);
    const red = buildDock("football.card", v, t, { by: "home-1", color: "red" })!;
    expect(red.chips.map((c) => c.id)).toEqual(["person:h1", "person:h2", "person:h3"]);
  });

  // R3.5/Task J — the kick tile's own doc states the reason this exists:
  // "band-2+ taker attribution stays reachable". Before this task the
  // generic More form's `attribution` field carried `person`; a dedicated
  // sheet removes that route entirely, so this dock case is what keeps the
  // claim true rather than a regression this task quietly shipped.
  it("football.shootout.kick: offers on-pitch person chips for the KICKING side, at band >= 2", () => {
    const home = buildDock("football.shootout.kick", view({ band: 2 }), t, { by: "home-1" })!;
    expect(home.chips.map((c) => c.id)).toEqual(["person:h1", "person:h2", "person:h3"]);
    const away = buildDock("football.shootout.kick", view({ band: 3 }), t, { by: "away-1" })!;
    expect(away.chips.map((c) => c.id)).toEqual(["person:a1", "person:a2", "person:a3"]);
    expect(home.title).toBe("pad.football.dock.shootoutKick.title");
  });

  it("football.shootout.kick: no dock at all below band 2 — nothing else to enrich", () => {
    expect(buildDock("football.shootout.kick", view({ band: 1 }), t, { by: "home-1" })).toBeNull();
  });

  it("football.shootout.kick: no dock when the entrant is unresolvable", () => {
    expect(buildDock("football.shootout.kick", view({ band: 3 }), t, { by: "some-foreign-entrant" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// activityDetail() — the ribbon's varying half. The nine per-sport ribbon
// keys are VAR-FREE bases; every name reaches the line through
// `pad.ribbon.withDetail` with the SKIN supplying `detail`.
// ---------------------------------------------------------------------------

function detail(eventType: string, payload: Record<string, unknown>): string | undefined {
  // R3.5/Task E — `state` joins `cfg`/`personNames` as a THIRD verbatim
  // capture `ActivityDetailContext` now carries (types.ts, `ActivityDetailContext.state`):
  // `football.shootout.kick` is the first `footballDetail` case that needs an
  // entrant->side lookup (`sideOfEntrant`), which only the fold's own
  // `state.entrants` can answer. `state()`'s entrants (`home-1`/`away-1`) are
  // exactly the ids every OTHER test in this describe block already passes as
  // `by`, so this is additive: those tests' assertions never depended on the
  // side prefix this now also resolves.
  return footballDetail({ t, eventType, payload, personNames: NAMES, cfg: cfg(), state: state() });
}

describe("footballDetail", () => {
  it("names the scorer, the assist and the flags for a goal", () => {
    expect(detail("football.goal", { by: "home-1", scorer: "h1" })).toBe("Home One");
    expect(detail("football.goal", { by: "home-1", scorer: "h1", assist: "h2" })).toContain("Home One");
    expect(detail("football.goal", { by: "home-1", scorer: "h1", assist: "h2" })).toContain("Home Two");
    expect(detail("football.goal", { by: "home-1", ownGoal: true })).toContain("pad.football.ribbon.goal.ownGoal");
    expect(detail("football.goal", { by: "home-1", penalty: true })).toContain("pad.football.ribbon.goal.penalty");
  });

  it("returns undefined for a goal with nothing to add, leaving the static caption untouched", () => {
    expect(detail("football.goal", { by: "home-1" })).toBeUndefined();
  });

  it("names the colour and the player for a card — second_yellow's copy already exists, none was minted", () => {
    const text = detail("football.card", { by: "home-1", color: "second_yellow", person: "h2" })!;
    expect(text).toContain("cardColor.second_yellow");
    expect(text).toContain("Home Two");
  });

  it("names both players of a substitution", () => {
    const text = detail("football.sub", { by: "home-1", off: "h1", on: "h4" })!;
    expect(text).toContain("Home One");
    expect(text).toContain("Home Sub");
  });

  it("names the marker for a period, and the outcome for a penalty, a shot and a shoot-out kick", () => {
    expect(detail("football.period", { phase: "HT" })).toContain("matchPhase.HT");
    expect(detail("football.penalty", { by: "home-1", outcome: "saved", taker: "h1" })).toContain("outcome.saved");
    expect(detail("football.shot", { by: "home-1", outcome: "blocked" })).toContain("outcome.blocked");
    expect(detail("football.shootout.kick", { by: "home-1", scored: true, person: "h1" })).toContain("outcome.scored");
  });

  // ---------------------------------------------------------------------------
  // R3.5/Task E (cases F12, F13) — the kick log names the SIDE. For every
  // other football event the side is inferable because the score moves; for a
  // shoot-out kick it is the entire content of the event, and this is the
  // panel a scorer voids from, so a mis-tap was being corrected blind. The
  // review's original "the log cannot say which side kicked" framing was
  // WRONG (corrected in `_INDEX.md`): the read-only audit table already names
  // it — only the SCORER's Activity panel (the one carrying the Void
  // buttons) did not.
  // ---------------------------------------------------------------------------

  it("F12: a scored kick names the side and the outcome, with no person given", () => {
    expect(detail("football.shootout.kick", { by: "home-1", scored: true })).toBe(
      "scorepad.attribution.home · outcome.scored",
    );
  });

  it("F13: a missed kick names the side, the outcome, and the taker", () => {
    expect(detail("football.shootout.kick", { by: "away-1", scored: false, person: "a1" })).toBe(
      "scorepad.attribution.away · outcome.missed · Away One",
    );
  });

  it("an unresolvable entrant drops the side segment rather than printing a raw id — the S13 defect", () => {
    expect(detail("football.shootout.kick", { by: "some-foreign-entrant-uuid", scored: true })).toBe(
      "outcome.scored",
    );
  });

  it("names the player for both sin-bin events", () => {
    expect(detail("football.sinbin.start", { by: "home-1", person: "h3" })).toContain("Home Three");
    expect(detail("football.sinbin.end", { by: "home-1", person: "h3" })).toContain("Home Three");
  });

  it("never renders a raw person id when a name is unknown", () => {
    const text = detail("football.card", { by: "home-1", color: "red", person: "ghost" })!;
    expect(text).not.toContain("ghost");
    expect(text).toContain("eventCopy.unknownPerson");
  });
});

// ---------------------------------------------------------------------------
// readClock — v2's staleness guard, restated because the stamp depends on it.
// ---------------------------------------------------------------------------

describe("readClock", () => {
  it("formats MM:SS only for a stamp naming the current phase", () => {
    expect(readClock({ asOf: { period: "H1", elapsed: 0 } }, "H1")).toBe("0:00");
    expect(readClock({ asOf: { period: "H1", elapsed: 65 } }, "H1")).toBe("1:05");
    expect(readClock({ asOf: { period: "H1", elapsed: 65 } }, "H2")).toBeUndefined();
    expect(readClock({}, "H1")).toBeUndefined();
    expect(readClock({ asOf: { period: "H1", elapsed: -1 } }, "H1")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The factory.
// ---------------------------------------------------------------------------

describe("footballSkinV3", () => {
  it("is a FACTORY over t, declares tapModel T, and opts in to phase()", () => {
    const skin = footballSkinV3(t);
    expect(skin.key).toBe("football");
    expect(skin.tapModel).toBe("T");
    expect(typeof skin.phase).toBe("function");
    expect(skin.phase!(view({ state: state({ phase: "final" }) }))).toBe("post");
  });

  it("wires swap, sheets and activityDetail — a builder that exists but is not declared ships INERT", () => {
    const skin = footballSkinV3(t);
    expect(typeof skin.swap).toBe("function");
    expect(typeof skin.sheets).toBe("function");
    expect(typeof skin.activityDetail).toBe("function");
    expect(skin.swap!(view())).toHaveLength(2);
    expect(Object.keys(skin.sheets!(view())).length).toBeGreaterThan(0);
  });

  it("declares no context strip — football has no persistent per-person slot the fold can hold", () => {
    expect(footballSkinV3(t).context).toBeUndefined();
    expect(footballSkinV3(t).contextSelect).toBeUndefined();
  });

  it("leaves cricket alone: it still declares NO swap at all", () => {
    expect(cricketSkinV3(t).swap).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Copy truth — every key this skin puts on screen has to EXIST.
//
// Nothing else here can catch a missing one: `TileSpec.label`, a step title
// and an option label are plain strings the chassis resolves through `t()`,
// so a key with no dictionary entry renders as the key itself and every unit
// test above still passes (the local `t` returns its own argument). B3 minted
// this after the card sheet's new colour step shipped with no copy at all.
// Keys are COLLECTED from the built specs rather than listed by hand, so a
// later wave's new tile or step is covered the day it lands.
// ---------------------------------------------------------------------------

function labelKeys(): Set<string> {
  const keys = new Set<string>();
  for (const band of BANDS) {
    for (const phase of ["pre", "H1", "SHOOTOUT", "final"]) {
      const v = view({ band, state: state({ phase }) });
      for (const tile of buildTiles(v)) {
        keys.add(tile.label);
        if (tile.sublabel !== undefined) keys.add(tile.sublabel);
      }
      for (const spec of Object.values(buildSheets(v, t))) {
        for (const step of spec.steps) {
          keys.add(step.title);
          if (step.kind === "choice") for (const option of step.options) keys.add(option.label);
        }
      }
      for (const slot of buildSwap(v, t)) {
        keys.add(slot.offLabel);
        keys.add(slot.onLabel);
      }
      // B4: the LED board's own labels. The strip carries RESOLVED text and
      // the local `t` returns its key, so a label reads back as its key here —
      // the same trick `periodOf` above already relies on. Collected rather
      // than listed, so the next wave's new strip item is gated the day it
      // lands: R3/B2 shipped the card sheet's colour step with no copy at all
      // precisely because nothing collected it.
      for (const item of buildScorebug(v, t).strip) {
        if (item.label !== undefined) keys.add(item.label);
      }
    }
  }
  // The scorebug's period reads as prose, so its label is copy like any other
  // — in BOTH modes, because quarters mode renames the phase the fold reuses.
  for (const halves of [2, 4] as const) {
    for (const phase of ENGINE_PHASES) {
      const value = periodOf(view({ cfg: cfg({ halves }), state: state({ phase }) }));
      if (value !== undefined) keys.add(value);
    }
  }
  return keys;
}

describe("copy truth", () => {
  it("every tile, step, option and picker label this skin declares exists in the dictionary", () => {
    const dict = uiEn as Record<string, string>;
    const missing = [...labelKeys()].filter(
      (key) => key !== "__pad-host/more__" && !Object.prototype.hasOwnProperty.call(dict, key),
    );
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Against a REAL engine fold.
//
// Every test above drives hand-written fixtures, which is the right shape for
// asserting a builder — but it cannot catch the class of defect this wave
// actually found: `view.squads` is built by the HOST from the folded state
// (`squadStateOf`), and football's fold writes its own private squad
// projection at that field name. A fixture cannot disagree with itself about
// that; a real fold can. So this block runs the module's OWN fold, resolves
// the view exactly as `PadHostV3` does, and drives the skin against the
// result — the only place the skin and the engine meet at full size.
// ---------------------------------------------------------------------------

function eleven(prefix: string): LineupPair["home"]["slots"] {
  const starting = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => ({
    personId: `${prefix}${n}`,
    slot: "starting" as const,
    orderNo: n,
  }));
  return [...starting, { personId: `${prefix}12`, slot: "bench" as const, orderNo: 12 }];
}

function envelope(seq: number, type: string, payload: Record<string, unknown>): EventEnvelope {
  return {
    id: `e${seq}`,
    fixtureId: "fx-1",
    seq,
    type,
    payload,
    recordedAt: "2026-01-01T00:00:00.000Z",
    recordedBy: null,
  } as EventEnvelope;
}

/** The view `PadHostV3` itself would build for this event stream — same
 *  `squadStateOf(state, lineups)` call, same folded state, no shortcut. */
function foldedView(
  events: readonly EventEnvelope[],
  band: PadHostView["band"] = 3,
  cfgOver: Record<string, unknown> = {},
): PadHostView {
  const lineups: LineupPair = {
    home: { entrantId: "H", slots: eleven("h") },
    away: { entrantId: "A", slots: eleven("a") },
  };
  const engineCfgValue = footballModule!.configSchema.parse({ maxSubs: 3, subWindows: 3, ...cfgOver });
  const folded = foldClient(footballModule as never, engineCfgValue, lineups, events) as Record<string, unknown>;
  return {
    cfg: engineCfgValue,
    state: folded,
    summary: {},
    phase: "live",
    band,
    entitlements: {},
    personNames: { h7: "Seven", h9: "Nine", h12: "Twelve" },
    squads: squadStateOf(folded, lineups),
    events,
    contextOverrides: {},
  };
}

describe("against a real engine fold", () => {
  const kickoff = [envelope(1, "core.start", {})];
  const afterSub = [
    ...kickoff,
    envelope(2, "football.goal", { by: "H", scorer: "h9", at: { period: "H1", elapsed: 754 } }),
    envelope(3, "football.sub", { by: "H", off: "h7", on: "h12", at: { period: "H1", elapsed: 1200 } }),
  ];

  it("the host resolves a USABLE SquadState for football, whose own state.squads is a private projection", () => {
    const view = foldedView(kickoff);
    // The degrade is to the kickoff sheet, and the shape is the kernel's —
    // a blind read of football's own `state.squads` has no `.members` at all
    // and throws in every pool resolver downstream.
    expect(Array.isArray(view.squads.home.members)).toBe(true);
    expect(view.squads.home.members.length).toBe(12);
  });

  it("the OFF list follows the LIVE pitch after a substitution the fold accepted, where the host's own pool cannot", () => {
    const view = foldedView(afterSub);
    const home = buildSwap(view, t)[0]!;
    expect(home.offCandidates).toContain("h12"); // came on
    expect(home.offCandidates).not.toContain("h7"); // came off
    // The chassis pool this supersedes is frozen at kickoff and says the
    // opposite on both counts — which is exactly why offCandidates exists.
    const pool = view.squads.home.members.filter((m) => m.onField).map((m) => m.personId);
    expect(pool).toContain("h7");
    expect(pool).not.toContain("h12");
  });

  it("the substituted-off player stays VISIBLE in the ON list with the reentry reason", () => {
    const home = buildSwap(foldedView(afterSub), t)[0]!;
    expect(home.candidates).toContain("h7");
    expect(home.blocked?.h7).toBe("pad.football.context.sub.blocked.reentry.short");
  });

  it("stamps the next substitution from the stamp the fold itself is now as-of", () => {
    const home = buildSwap(foldedView(afterSub), t)[0]!;
    expect(home.buildEvent("h1", "h12").payload).toMatchObject({
      by: "H",
      at: { period: "H1", elapsed: 1200 },
    });
  });

  // Both branches of fix 4 against a REAL fold: the stream that carries a
  // stamped `at` has a clock, the one that carries none has no clock ITEM.
  it("shows a clock only once the fold itself is as-of a stamp", () => {
    expect(buildScorebug(foldedView(afterSub), t).strip.find((item) => item.id === "clock")?.value).toBe("20:00");
    expect(buildScorebug(foldedView(kickoff), t).strip.map((item) => item.id)).toEqual(["period"]);
  });

  it("every skin method runs clean against the folded state — no builder throws on a real fixture", () => {
    const view = foldedView(afterSub);
    const skin = footballSkinV3(t);
    expect(() => skin.scorebug(view)).not.toThrow();
    expect(() => skin.tiles(view)).not.toThrow();
    expect(() => skin.sheets!(view)).not.toThrow();
    expect(() => skin.swap!(view)).not.toThrow();
    expect(() => skin.dock("football.goal", view, { by: "H" })).not.toThrow();
    expect(skin.phase!(view)).toBe("live");
    expect(buildScorebug(view, t).halves[0].big).toBe("1");
  });

  // WS-D — the "mirror agrees with itself" trap this file's own header warns
  // about: a hand-built `view({ squads: ... })` literal cannot prove the real
  // `squadStateOf(folded, lineups)` degrade still carries a declared position/
  // squad number/role through. This drives the REAL fold and reads
  // `candidateMeta` off its result.
  it("carries the KICKOFF lineup's declared position, squad number and captain role through a REAL fold — not a fixture agreeing with itself", () => {
    const lineups: LineupPair = {
      home: {
        entrantId: "H",
        slots: [
          { personId: "h1", slot: "starting", orderNo: 1, positionKey: "GK", squadNumber: 1, roles: ["captain"] },
          ...[2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => ({ personId: `h${n}`, slot: "starting" as const, orderNo: n })),
          { personId: "h12", slot: "bench" as const, orderNo: 12, squadNumber: 20 },
        ],
      },
      away: { entrantId: "A", slots: eleven("a") },
    };
    const engineCfgValue = footballModule!.configSchema.parse({ maxSubs: 3, subWindows: 3 });
    const folded = foldClient(footballModule as never, engineCfgValue, lineups, kickoff) as Record<string, unknown>;
    const foldedV: PadHostView = {
      cfg: engineCfgValue,
      state: folded,
      summary: {},
      phase: "live",
      band: 3,
      entitlements: {},
      personNames: {},
      squads: squadStateOf(folded, lineups),
      events: kickoff,
      contextOverrides: {},
    };
    const home = buildSwap(foldedV, t)[0]!;
    expect(home.candidateMeta?.h1?.lead).toBe("GK");
    expect(home.candidateMeta?.h1?.tag).toBe("pad.football.swap.captainTag");
    expect(home.candidateMeta?.h2?.tag).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// R3 REVIEW ROUND — the four "never offer what the engine refuses" fixes, plus
// the one "never refuse what the engine allows" fix. Each is asserted against
// the ENGINE where the engine can answer, and against the SKIN's own contract
// (the reason copy, the band gate) where only the skin can.
//
// The sweep that drives the real fold across every phase and band lives in
// ../../__tests__/football-dispatch-totality.test.ts; these are the unit-level
// contracts that sweep cannot see — a reason string, a blocked flag, a chip.
// ---------------------------------------------------------------------------

describe("phaseAllows / legalPeriodMarkers — the fold's phase rules, stated once", () => {
  it("every play phase has exactly ONE legal period marker, and it is the mode's own", () => {
    expect(legalPeriodMarkers("H1", cfg())).toEqual(["HT"]);
    expect(legalPeriodMarkers("H2", cfg())).toEqual(["FT"]);
    expect(legalPeriodMarkers("H1", cfg({ halves: 4 }))).toEqual(["QT"]);
    expect(legalPeriodMarkers("Q2", cfg({ halves: 4 }))).toEqual(["HT"]);
    expect(legalPeriodMarkers("Q3", cfg({ halves: 4 }))).toEqual(["3QT"]);
    expect(legalPeriodMarkers("Q4", cfg({ halves: 4 }))).toEqual(["FT"]);
  });

  it("extra-time phases take the ET markers in BOTH modes, and only with extra time enabled", () => {
    const et = cfg({ extraTime: { enabled: true, halfMinutes: 15 } });
    expect(legalPeriodMarkers("ET_H1", et)).toEqual(["ET_HT"]);
    expect(legalPeriodMarkers("ET_H2", et)).toEqual(["ET_FT"]);
    expect(legalPeriodMarkers("ET_H1", { ...et, halves: 4 })).toEqual(["ET_HT"]);
    // The intersection with `periodMarkersOf` is what makes the two mirrors
    // unable to disagree: an ET marker no cfg declares is dropped, not offered.
    expect(legalPeriodMarkers("ET_H1", cfg())).toEqual([]);
  });

  it("there is no next whistle before kickoff, during the kicks, or once decided", () => {
    for (const phase of ["pre", "SHOOTOUT", "done", "final", "abandoned"]) {
      expect(legalPeriodMarkers(phase, cfg()), phase).toEqual([]);
    }
  });

  it("SHOOTOUT allows only the card and the kick — the phase that shipped four dead ends", () => {
    const allowed = Object.keys(EVENT_BAND).filter((type) => phaseAllows(type, "SHOOTOUT", cfg({ shootout: true })));
    expect(allowed.sort()).toEqual(["football.card", "football.shootout.kick"]);
  });

  it("a decided match allows nothing at all, a card included", () => {
    for (const phase of ["done", "final", "abandoned"]) {
      expect(Object.keys(EVENT_BAND).filter((type) => phaseAllows(type, phase, cfg())), phase).toEqual([]);
    }
  });

  it("fails OPEN for a type it does not know — a new engine event must not be silently hidden", () => {
    expect(phaseAllows("football.var.review", "SHOOTOUT", cfg())).toBe(true);
  });

  it("refusedEventTypes is the complement, derived from EVENT_BAND rather than a second hand-list", () => {
    const shootout = view({ state: state({ phase: "SHOOTOUT" }), cfg: cfg({ shootout: true }) });
    expect(refusedEventTypes(shootout).sort()).toEqual([
      "football.goal",
      "football.penalty",
      "football.period",
      "football.shot",
      "football.sinbin.end",
      "football.sinbin.start",
      "football.sub",
    ]);
    // In open play the only refusal is the kick, which needs the shoot-out.
    expect(refusedEventTypes(view())).toEqual(["football.shootout.kick"]);
  });
});

describe("the period sheet is narrowed by PHASE, and says why (R3 review, dead end 1)", () => {
  const markerStep = (v: PadHostView) => {
    const step = buildSheets(v, t)["period"]!.steps[0]!;
    if (step.kind !== "choice") throw new Error("the period sheet's first step is not a choice step");
    return step;
  };

  it("still OFFERS every marker this cfg declares — blocked, never removed (R2b's binding ruling)", () => {
    const step = markerStep(view());
    expect(step.options.map((o) => o.id)).toEqual([...periodMarkersOf(cfg())]);
  });

  it("blocks the ones applyPeriod would refuse in this phase, and only those", () => {
    expect(Object.keys(markerStep(view()).blocked!({}))).toEqual(["FT"]);
    expect(Object.keys(markerStep(view({ state: state({ phase: "H2" }) })).blocked!({}))).toEqual(["HT"]);
    const quarters = view({ cfg: cfg({ halves: 4 }), state: state({ phase: "Q3" }) });
    expect(Object.keys(markerStep(quarters).blocked!({})).sort()).toEqual(["FT", "HT", "QT"]);
  });

  it("the reason names the CURRENT period in the scorer's own words, never a bare 'not now'", () => {
    // R2b's other binding ruling: never a generic error where the exact one is
    // known. The local `t` echoes key+vars, so this reads the interpolation.
    expect(markerStep(view()).blocked!({}).FT).toBe(
      'pad.football.context.period.blocked.wrongPhase({"phase":"pad.football.phase.H1"})',
    );
  });

  it("its key and the card's exist in all four dictionaries", () => {
    for (const key of [
      "pad.football.context.period.blocked.wrongPhase",
      "pad.football.context.card.blocked.noPriorYellow",
      "pad.football.dock.penalty.title",
    ]) {
      expect(Object.keys(uiEn), key).toContain(key);
    }
  });
});

describe("second_yellow needs someone on a caution (R3 review, the unattributable card)", () => {
  const colourStep = (v: PadHostView, key = "card-home") => {
    const step = buildSheets(v, t)[key]!.steps[0]!;
    if (step.kind !== "choice") throw new Error("the card sheet's first step is not a choice step");
    return step;
  };
  const yellowFor = (person: string) => state({ cards: [{ side: "home", person, color: "yellow" }] });

  it("blocks it with a reason when nobody on that side is on a yellow", () => {
    expect(colourStep(view()).blocked!({})).toEqual({
      second_yellow: "pad.football.context.card.blocked.noPriorYellow",
    });
  });

  it("never blocks a first yellow or a straight red — a person-less card of either is legal and useful", () => {
    for (const colour of ["yellow", "red"]) {
      expect(Object.keys(colourStep(view()).blocked!({})), colour).not.toContain(colour);
    }
  });

  // R3 review round 2. The guard above was written for `second_yellow` alone,
  // but `cardCandidates` splits three ways and each arm empties for its own
  // reason. A side booked to a man is the REACHABLE one: every player on the
  // pitch already holds a yellow, so the first-yellow set is empty while the
  // second-yellow set is full — the sheet offered "Yellow", and the dock that
  // opens after it commits had zero chips to show. Same defect, other arm.
  const allBooked = () =>
    state({
      cards: ["h1", "h2", "h3"].map((person) => ({ side: "home", person, color: "yellow" })),
    });

  it("blocks a FIRST yellow when every player on that pitch is already booked", () => {
    expect(colourStep(view({ state: allBooked() })).blocked!({}).yellow).toBe(
      "pad.football.context.card.blocked.allBooked",
    );
  });

  it("leaves the other two open in that state — a second yellow and a red are both still attributable", () => {
    const blocked = colourStep(view({ state: allBooked() })).blocked!({});
    expect(Object.keys(blocked)).toEqual(["yellow"]);
  });

  it("is per SIDE the same way — booking out the home pitch does not block the away first yellow", () => {
    expect(colourStep(view({ state: allBooked() }), "card-away").blocked!({}).yellow).toBeUndefined();
  });

  // The empty-pitch state is not reachable through the pad today, but the
  // reason string is what a scorer READS, and "everyone is already booked" is
  // a false sentence about a side with nobody on the field. All three arms
  // collapse to one honest reason rather than three confident wrong ones.
  it("says nobody is on the pitch — not that everyone is booked — when the side has no eligible player", () => {
    const empty = state({
      squads: { home: footballSquad({ onPitch: [] }), away: footballSquad({ onPitch: ["a1"] }) },
    });
    expect(colourStep(view({ state: empty })).blocked!({})).toEqual({
      yellow: "pad.football.context.card.blocked.nobodyOnPitch",
      red: "pad.football.context.card.blocked.nobodyOnPitch",
      second_yellow: "pad.football.context.card.blocked.nobodyOnPitch",
    });
  });

  it("both new reasons exist in all four dictionaries", () => {
    for (const key of [
      "pad.football.context.card.blocked.allBooked",
      "pad.football.context.card.blocked.nobodyOnPitch",
    ]) {
      expect(Object.keys(uiEn), key).toContain(key);
    }
  });

  it("unblocks it the moment someone on that side is cautioned", () => {
    expect(colourStep(view({ state: yellowFor("h2") })).blocked!({})).toEqual({});
  });

  it("is per SIDE — a home caution does not unblock the away card sheet", () => {
    const v = view({ state: yellowFor("h2") });
    expect(colourStep(v, "card-away").blocked!({})).toEqual({
      second_yellow: "pad.football.context.card.blocked.noPriorYellow",
    });
  });

  // THE DEFECT ITSELF: the sheet and the dock disagreed, so a colour the sheet
  // offered produced a dock with zero chips and a card attributable to nobody.
  it("the sheet leaves it enabled EXACTLY when the dock can name somebody", () => {
    for (const fixture of [view(), view({ state: yellowFor("h2") })]) {
      const enabled = colourStep(fixture).blocked!({}).second_yellow === undefined;
      const chips = buildDock("football.card", fixture, t, { by: "home-1", color: "second_yellow" })!.chips;
      expect(chips.length > 0, `enabled=${enabled} chips=${chips.length}`).toBe(enabled);
    }
  });

  it("a sent-off player is not a second-yellow candidate, so their caution does not unblock it", () => {
    const v = view({
      state: state({
        cards: [{ side: "home", person: "h2", color: "yellow" }],
        squads: {
          home: { onPitch: ["h1", "h3"], bench: ["h4", "h5"], offUsed: [], sentOff: ["h2"] },
          away: { onPitch: ["a1", "a2", "a3"], bench: ["a4", "a5"], offUsed: [], sentOff: [] },
        },
      }),
    });
    expect(colourStep(v).blocked!({}).second_yellow).toBeDefined();
  });
});

describe("the penalty's offence is askable again (R3 review, the v2 regression)", () => {
  const dockFor = (band: 0 | 1 | 2 | 3) => buildDock("football.penalty", view({ band }), t, { by: "home-1" });

  it("PENALTY_OFFENCES mirrors football.penalty's own offence enum — the IFAB Law 12 taxonomy", () => {
    expect([...PENALTY_OFFENCES]).toEqual([
      ...enumValues(engineAction(padSpecFor(engineCfg()), "football.penalty"), "offence"),
    ]);
    expect(PENALTY_OFFENCES).toHaveLength(8); // vacuity guard
  });

  it("offers one chip per offence at band >= 2, each mutating the `offence` field", () => {
    const chips = dockFor(2)!.chips;
    expect(chips.map((chip) => chip.id)).toEqual(PENALTY_OFFENCES.map((offence) => `offence:${offence}`));
    expect(chips.map((chip) => chip.label)).toEqual(PENALTY_OFFENCES.map((offence) => `offence.${offence}`));
    expect(chips[0]!.mutate({ by: "home-1", outcome: "saved" })).toEqual({
      by: "home-1",
      outcome: "saved",
      offence: "kicking",
    });
  });

  it("is silent below band 2 — the same boundary the card's own offence step takes (R3-1)", () => {
    expect(dockFor(0)).toBeNull();
    expect(dockFor(1)).toBeNull();
  });

  it("the sheet still asks only `by` and `outcome` — a required event is never held hostage to an optional field", () => {
    const spec = buildSheets(view({ band: 3 }), t)["penalty"]!;
    expect(spec.steps.map((step) => step.id)).toEqual(["by", "outcome"]);
  });
});

// ---------------------------------------------------------------------------
// R3 review round — the "never REFUSE what the engine allows" half, against a
// real fold. This one cannot be asserted against a hand-written fixture at
// all: `exemptUsed` is written by the kernel's own `onLineup` hook when a
// `core.lineup.replacement` folds through, and the number the cap is measured
// against (`liftSide`'s `subsUsed = offUsed.length - exemptTotal`) exists only
// inside the engine.
// ---------------------------------------------------------------------------

describe("the substitution cap counts ORDINARY substitutions (R3 review, the pad refusing a legal swap)", () => {
  const bench = (n: number) => ({ personId: `h${n}`, slot: "bench" as const, orderNo: n });
  /** A side that has spent its whole `maxSubs: 3` allowance, one of the three
   *  as an IFAB concussion replacement — so `offUsed` is 3 and the kernel's own
   *  `subsUsed` is 2, with one substitution still legally left. */
  function concussionStream(): EventEnvelope[] {
    return [
      envelope(1, "core.start", {}),
      envelope(2, "football.sub", { by: "H", off: "h7", on: "h12" }),
      envelope(3, "football.sub", { by: "H", off: "h8", on: "h13" }),
      envelope(4, "core.lineup.replacement", {
        side: "H",
        off: "h9",
        on: { personId: "h14", slot: "bench", orderNo: 14 },
        exemption: "concussion",
      }),
    ];
  }
  function viewAfter(events: readonly EventEnvelope[]): PadHostView {
    const lineups: LineupPair = {
      home: { entrantId: "H", slots: [...eleven("h").slice(0, 11), bench(12), bench(13), bench(14), bench(15)] },
      away: { entrantId: "A", slots: eleven("a") },
    };
    const engineCfgValue = footballModule!.configSchema.parse({
      maxSubs: 3,
      subWindows: 3,
      concussionSubs: 1,
    });
    const folded = foldClient(footballModule as never, engineCfgValue, lineups, events) as Record<string, unknown>;
    return {
      cfg: engineCfgValue,
      state: folded,
      summary: {},
      phase: "live",
      band: 3,
      entitlements: {},
      personNames: {},
      squads: squadStateOf(folded, lineups),
      events,
      contextOverrides: {},
    };
  }

  it("the fold really does put three players in offUsed and record one as exempt", () => {
    const home = (viewAfter(concussionStream()).state as { squads: Record<string, Record<string, unknown>> }).squads.home;
    expect(home.offUsed).toHaveLength(3);
    expect(home.exemptUsed).toEqual({ concussion: 1 });
  });

  it("and the ENGINE accepts a fourth swap — the exempt replacement sits outside the cap", () => {
    const events = [...concussionStream(), envelope(5, "football.sub", { by: "H", off: "h10", on: "h15" })];
    expect(() => viewAfter(events)).not.toThrow();
  });

  it("so the swap slot must not refuse it: policyOk stays true with one ordinary substitution left", () => {
    const slot = buildSwap(viewAfter(concussionStream()), t).find((s) => s.side === "home")!;
    expect(slot.policyOk, "the pad refused a substitution reduceLineupEvent accepts").toBe(true);
    expect(slot.policyMessage).toBeUndefined();
  });

  it("and it still refuses the one AFTER that, counting the exempt replacement out of the total", () => {
    const events = [...concussionStream(), envelope(5, "football.sub", { by: "H", off: "h10", on: "h15" })];
    const slot = buildSwap(viewAfter(events), t).find((s) => s.side === "home")!;
    expect(slot.policyOk).toBe(false);
    // The refusal states the ORDINARY count (3 of 3), never the raw `offUsed`
    // length (4) — a scorer counting four names on the touchline still reads
    // the number the Law actually caps.
    expect(slot.policyMessage).toBe('pad.football.context.sub.blocked.maxSubs({"used":3,"max":3})');
  });
});
