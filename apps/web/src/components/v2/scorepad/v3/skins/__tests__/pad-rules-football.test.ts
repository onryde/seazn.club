// P1.2 (pad wave) - the football skin's DRIFT GUARD. It drives the skin's BUILDERS (the card, penalty and period sheets, the dock's chips,
// the sub slot, the tiles, the More sheet's refusal list) in REAL folded states and compares what they offer with `footballPadRules` and
// with the REAL fold. It never compares the skin's re-exported constant with the record: after P1.2 the skin declares none (the literal
// guard, no-rule-literals.test.ts, holds that), and a constant compared with its own source is always green.
//
// Where an expected value could come from the engine's declaration, it does (rules.*, the zod enums behind them). Where the declaration
// is what a mutation would change, the Laws are typed in this file as well (IFAB Law 12 offences, Law 3 colours), so that dropping a
// value from the engine's enum reds here even though the skin and the record would agree with each other.
//
// Every sweep counts what it compared; the test ends by requiring the total.
import { describe, expect, it } from "vitest";
import { footballPadRules as rules } from "@seazn/engine/pad";
import { initSquads } from "@seazn/engine/core";
import { football, type FootballCfg, type FootballState } from "@seazn/engine/sports/football";
import { makeEnvelope } from "@seazn/engine/testkit";
import type { GuidedSheetSpec, GuidedSheetStep, PadHostView, TileSpec } from "../../types";
import { foldedPhases, foldFootball, footballCfg, lineupsFor, phaseVerdict, probePayload, shippedVariantCfgs } from "../../__tests__/_football-fold";
import {
  CARD_TONES,
  buildDock,
  buildScorebug,
  buildSheets,
  buildSwap,
  buildTiles,
  refusedEventTypes,
  type TFn,
} from "../football";

const t: TFn = (key, vars) => (vars ? `${key}(${JSON.stringify(vars)})` : key);

let compared = 0;
const count = (n = 1) => {
  compared += n;
};

function viewFor(cfg: FootballCfg, state: FootballState, over: Partial<PadHostView> = {}): PadHostView {
  return {
    cfg,
    state,
    summary: {},
    phase: "live",
    band: 3,
    entitlements: {},
    personNames: {},
    squads: initSquads(lineupsFor(cfg)),
    events: [],
    contextOverrides: {},
    stageKind: null,
    canOrganise: true,
    entrantNames: {},
    ...over,
  };
}

const live = (cfg: FootballCfg = footballCfg(), extra: [type: string, payload?: unknown][] = []) => foldFootball(cfg, [["core.start"], ...extra]);

function choiceStep(sheet: GuidedSheetSpec, id: string): Extract<GuidedSheetStep, { kind: "choice" }> {
  const step = sheet.steps.find((s) => s.id === id);
  if (!step || step.kind !== "choice") throw new Error(`sheet ${sheet.event} has no choice step "${id}"`);
  return step;
}
const optionIds = (sheet: GuidedSheetSpec, id: string) => choiceStep(sheet, id).options.map((o) => o.id);

/** `_football-fold`'s probe, except for the clock: its `at: { period: <the state's phase> }` is itself refused (INVALID_EVENT, before the
 *  phase check) in the phases `playPhases(cfg)` does not list (done, final, abandoned), which would read as "not refused by phase". The
 *  stamp is optional on a clock publish, so the probe carries none. */
const probeOf = (type: string, state: FootballState): Record<string, unknown> => (type === "football.clock" ? { running: false } : probePayload(type, state));

/** Does the REAL fold (the scorer's path) accept this event? */
function engineAccepts(state: FootballState, type: string, payload: unknown): boolean {
  try {
    football.apply(state, makeEnvelope(900, { type, payload }) as never, { strict: true });
    return true;
  } catch {
    return false;
  }
}

// The Laws, typed here from the rulebook (IFAB Law 12.3 cautionable and 12.4 sending-off offences; Law 12 section 3 for the direct free
// kick that concedes a penalty; Law 14 for a penalty kick that does not score). A set each: the ORDER is the engine's, pinned below.
const LAW_12_REASONS = [
  "unsporting_behaviour", "dissent", "persistent_offences", "delaying_restart", "failure_to_respect_distance",
  "entering_or_leaving_without_permission", "serious_foul_play", "violent_conduct", "spitting",
  "denying_goal_by_handball", "denying_obvious_goalscoring_opportunity", "offensive_language", "second_caution",
];
const LAW_12_PENALTY_OFFENCES = ["kicking", "tripping", "jumping_at", "charging", "pushing", "striking", "tackling", "handball"];
const LAW_12_COLOURS = ["yellow", "red", "second_yellow"];
const LAW_14_UNCONVERTED = ["saved", "missed", "post"];

describe("the engine's vocabularies are the Laws' (what a mutation of the enum would break)", () => {
  it("cards, offences and unconverted-penalty outcomes are Law 12 / Law 14's sets", () => {
    expect([...rules.cardColors].sort()).toEqual([...LAW_12_COLOURS].sort());
    expect([...rules.cardReasons].sort()).toEqual([...LAW_12_REASONS].sort());
    expect([...rules.penaltyOffences].sort()).toEqual([...LAW_12_PENALTY_OFFENCES].sort());
    expect([...rules.penaltyOutcomes].sort()).toEqual([...LAW_14_UNCONVERTED].sort());
    count(4);
  });
});

describe("the sheets offer exactly the engine's vocabularies, in the engine's order, for more than one cfg", () => {
  const cfgs = [
    { name: "11-a-side", cfg: footballCfg() },
    { name: "mini-soccer (quarters)", cfg: footballCfg({ halves: 4, teamSize: 7, rollingSubs: true }) },
  ];

  it("card sheet: colour step is cardColors and reason step is cardReasons (asked at band >= 2 only)", () => {
    for (const { name, cfg } of cfgs) {
      const v = viewFor(cfg, live(cfg), { band: 2 });
      for (const side of ["home", "away"] as const) {
        const sheet = buildSheets(v, t)[`card-${side}`]!;
        expect(optionIds(sheet, "color"), `${name} ${side}`).toEqual(rules.cardColors);
        expect(optionIds(sheet, "reason"), `${name} ${side}`).toEqual(rules.cardReasons);
        count(2);
      }
      // band 1: the reason is not asked (the engine's `reason` is optional), band 2 asks it - the gate reads the view's band
      const reasonAt = (band: PadHostView["band"]) => {
        const sheet = buildSheets(viewFor(cfg, live(cfg), { band }), t)["card-home"]!;
        return choiceStep(sheet, "reason").when?.({}) ?? true;
      };
      expect([reasonAt(1), reasonAt(2)], name).toEqual([false, true]);
      count();
    }
  });

  it("the card tones key exactly the card colours (a colour without a tone, or a tone for no colour, is drift)", () => {
    expect(Object.keys(CARD_TONES).sort()).toEqual([...rules.cardColors].sort());
    for (const colour of rules.cardColors) expect(CARD_TONES[colour as keyof typeof CARD_TONES], colour).not.toHaveLength(0);
    count(rules.cardColors.length + 1);
  });

  it("penalty sheet: outcome step is penaltyOutcomes; the dock's offence chips are penaltyOffences (band >= 2 only)", () => {
    for (const { name, cfg } of cfgs) {
      const v = viewFor(cfg, live(cfg), { band: 2 });
      expect(optionIds(buildSheets(v, t).penalty!, "outcome"), name).toEqual(rules.penaltyOutcomes);
      const dock = buildDock("football.penalty", v, t, { by: "H", outcome: "saved" });
      expect(dock?.chips.map((chip) => chip.id), name).toEqual(rules.penaltyOffences.map((offence) => `offence:${offence}`));
      expect(buildDock("football.penalty", viewFor(cfg, live(cfg), { band: 1 }), t, { by: "H", outcome: "saved" }), `${name} band 1`).toBeNull();
      count(3);
    }
  });
});

describe("the tiles follow the engine's bands", () => {
  // tile ids per event type that has a dedicated tile at a play phase; the other types ride the More sheet (never band-filtered).
  const TILE_IDS: Readonly<Record<string, readonly string[]>> = {
    "football.goal": ["goal-home", "goal-away"],
    "football.card": ["card-home", "card-away"],
    "football.sub": ["sub-home", "sub-away"],
    "football.period": ["period"],
    "football.penalty": ["penalty"],
  };

  it("a tile is drawn exactly when the event's declared band is within the active band, at every band and for two cfgs", () => {
    const hidden: TileSpec["id"][] = [];
    for (const cfg of [footballCfg(), footballCfg({ halves: 4, rollingSubs: true })]) {
      const state = live(cfg);
      for (const band of [0, 1, 2, 3] as const) {
        const drawn = new Set(buildTiles(viewFor(cfg, state, { band })).map((tile) => tile.id));
        for (const [type, ids] of Object.entries(TILE_IDS)) {
          const declared = rules.eventBands[type];
          expect(declared, `the engine bands ${type}`).not.toBeUndefined();
          for (const id of ids) {
            expect(drawn.has(id), `band ${band}: ${id} (${type} is band ${declared})`).toBe(declared! <= band);
            if (declared! > band) hidden.push(id);
            count();
          }
        }
      }
    }
    // both directions occurred: some tile was withheld by a band, and some was drawn
    expect(hidden.length).toBeGreaterThan(10);
  });
});

/** Every football.period marker the fold has an arm for (Law 7 half-time/full-time, mini-soccer quarters, extra time), typed here, not read from the record. */
const ALL_PERIOD_MARKERS = ["QT", "HT", "3QT", "FT", "ET_HT", "ET_FT"];

describe("FB-PH-1: the phase gate: what the More sheet is told to hide is exactly what the fold refuses", () => {
  it("refusedEventTypes equals the fold's WRONG_PHASE set, in every folded phase, for every cfg shape", () => {
    const phases = foldedPhases();
    expect(phases.length).toBeGreaterThanOrEqual(12);
    const seen = new Set<string>();
    let refusedTotal = 0;
    for (const fp of phases) {
      const v = viewFor(fp.cfg, fp.state);
      const types = Object.keys(rules.eventBands);
      const refusedByFold = types.filter((type) => {
        if (type === "football.period") {
          // every marker is put to the fold, not just the ones the record offers: a marker the fold would take but the record never offers
          // (an extra-time phase reached without the flag) must show up here as a difference, not be filtered out by the subject under test
          const accepted = ALL_PERIOD_MARKERS.some((marker) => phaseVerdict(fp.cfg, fp.state, type, { phase: marker }) !== "wrong-phase");
          return !accepted;
        }
        return phaseVerdict(fp.cfg, fp.state, type, probeOf(type, fp.state)) === "wrong-phase";
      });
      expect([...refusedEventTypes(v)].sort(), fp.label).toEqual(refusedByFold.sort());
      seen.add(fp.phase);
      refusedTotal += refusedByFold.length;
      count(types.length);
    }
    // the sweep met the phases that matter (pre, play, extra time, the shoot-out, a decided match) and refused plenty
    for (const phase of ["pre", "H1", "H2", "ET_H1", "SHOOTOUT", "done"]) expect(seen.has(phase), `a folded ${phase} state`).toBe(true);
    expect(refusedTotal).toBeGreaterThan(30);
  });
});

describe("FB-PH-2: the period sheet: options are the cfg's markers, blocked is exactly what the fold refuses in this phase", () => {
  it("in every folded phase", () => {
    let blockedTotal = 0;
    let openTotal = 0;
    for (const fp of foldedPhases()) {
      const sheet = buildSheets(viewFor(fp.cfg, fp.state), t).period!;
      const step = choiceStep(sheet, "marker");
      expect(step.options.map((o) => o.id), fp.label).toEqual(rules.periodMarkers(fp.cfg));
      const blocked = new Set(Object.keys(step.blocked?.({}) ?? {}));
      for (const option of step.options) {
        const refused = phaseVerdict(fp.cfg, fp.state, "football.period", { phase: option.id }) === "wrong-phase";
        expect(blocked.has(option.id), `${fp.label}: ${option.id} is ${refused ? "refused" : "accepted"} by the fold`).toBe(refused);
        if (refused) blockedTotal++;
        else openTotal++;
        count();
      }
    }
    expect(blockedTotal).toBeGreaterThan(20);
    expect(openTotal).toBeGreaterThanOrEqual(8);
  });
});

describe("FB-SU-2: the substitution window cap the sub slot refuses on is the one the fold enforces", () => {
  // Rolling subs, so the same two players swap back and forth. After `used` stamped windows a clock publish moves `asOf` to a LATER
  // stamp, which is the stamp the skin would send: a new window, so the cap decides.
  function afterWindows(cfg: FootballCfg, used: number): FootballState {
    let state = live(cfg);
    for (let k = 1; k <= used; k++) {
      const off = state.squads.home.onPitch.at(-1)!;
      const on = state.squads.home.bench.at(-1)!;
      state = football.apply(state, makeEnvelope(100 + k, { type: "football.sub", payload: { by: "H", off, on, at: { period: "H1", elapsed: 60 * k } } }) as never, { strict: true });
    }
    return football.apply(state, makeEnvelope(200, { type: "football.clock", payload: { running: true, at: { period: "H1", elapsed: 3000 } } }) as never, { strict: true });
  }

  it("refuses the next window exactly when the fold would, for two caps and for no cap", () => {
    const cases: { cap: number | undefined; used: number }[] = [
      { cap: 2, used: 1 }, { cap: 2, used: 2 }, { cap: 3, used: 2 }, { cap: 3, used: 3 }, { cap: undefined, used: 4 },
    ];
    let refusedSeen = 0;
    let allowedSeen = 0;
    for (const { cap, used } of cases) {
      const cfg = footballCfg({ rollingSubs: true, ...(cap === undefined ? {} : { subWindows: cap }) });
      expect(rules.subWindowsCap(cfg)).toBe(cap);
      const state = afterWindows(cfg, used);
      const slot = buildSwap(viewFor(cfg, state), t)[0]!;
      const off = state.squads.home.onPitch.at(-1)!;
      const on = state.squads.home.bench.at(-1)!;
      const event = slot.buildEvent(off, on);
      const accepted = engineAccepts(state, event.type, event.payload);
      expect(slot.policyOk, `cap ${cap}, ${used} windows used: the slot must agree with the fold (fold ${accepted ? "accepts" : "refuses"})`).toBe(accepted);
      if (!accepted) {
        expect(slot.policyMessage).toContain("pad.football.context.sub.blocked.subWindows");
        expect(slot.policyMessage).toContain(`"windows":${rules.subWindowsCap(cfg)}`);
        refusedSeen++;
      } else allowedSeen++;
      count(2);
    }
    expect(refusedSeen).toBe(2);
    expect(allowedSeen).toBe(3);
  });
});

describe("FB-SU-1: the re-entry block: a substituted-off player is blocked exactly when the fold would refuse his return", () => {
  it("for 11-a-side, rolling subs and every shipped variant", () => {
    const cfgs = [{ variant: "11-a-side (default)", cfg: footballCfg() }, { variant: "rollingSubs", cfg: footballCfg({ rollingSubs: true }) }, ...shippedVariantCfgs()];
    const verdicts = new Set<boolean>();
    for (const { variant, cfg } of cfgs) {
      const start = live(cfg);
      const off = start.squads.home.onPitch[0]!;
      const on = start.squads.home.bench[0]!;
      const state = football.apply(start, makeEnvelope(10, { type: "football.sub", payload: { by: "H", off, on } }) as never, { strict: true });
      const slot = buildSwap(viewFor(cfg, state), t)[0]!;
      const comesBack = engineAccepts(state, "football.sub", { by: "H", off: state.squads.home.onPitch.at(-1)!, on: off });
      expect(slot.candidates, `${variant}: the player who left is still a candidate`).toContain(off);
      expect(Object.hasOwn(slot.blocked ?? {}, off), `${variant}: blocked iff the fold refuses his return (fold ${comesBack ? "accepts" : "refuses"})`).toBe(!comesBack);
      expect(rules.reentryAllowed(cfg), variant).toBe(comesBack);
      verdicts.add(comesBack);
      count(3);
    }
    // both answers were met, so neither a constant nor an ignored cfg passes
    expect([...verdicts].sort()).toEqual([false, true]);
  });
});

describe("FB-CD-1: second-yellow eligibility: the card colours the skin offers, and its dock's person chips, are the ones the fold accepts", () => {
  it("before any card, after a yellow, and after a red", () => {
    const cfg = footballCfg();
    const start = live(cfg);
    const [x, y] = start.squads.home.onPitch;
    const states: { label: string; state: FootballState }[] = [
      { label: "no card yet", state: start },
      { label: "after a yellow to X", state: foldFootball(cfg, [["core.start"], ["football.card", { by: "H", person: x, color: "yellow" }]]) },
      { label: "after a yellow to X and a red to Y", state: foldFootball(cfg, [["core.start"], ["football.card", { by: "H", person: x, color: "yellow" }], ["football.card", { by: "H", person: y, color: "red" }]]) },
    ];
    let offered = 0;
    let withheld = 0;
    for (const { label, state } of states) {
      const v = viewFor(cfg, state, { band: 2 });
      const blocked = choiceStep(buildSheets(v, t)["card-home"]!, "color").blocked?.({}) ?? {};
      for (const colour of rules.cardColors) {
        // the people the REAL fold would accept this card for, among those on the pitch (the pad's scope, which is narrower than the fold's)
        const accepted = state.squads.home.onPitch.filter((person) => engineAccepts(state, "football.card", { by: "H", person, color: colour }));
        const chips = (buildDock("football.card", v, t, { by: "H", color: colour })?.chips ?? []).map((chip) => chip.id).sort();
        expect(chips, `${label}: dock chips for a ${colour}`).toEqual(accepted.map((person) => `person:${person}`).sort());
        expect(Object.hasOwn(blocked, colour), `${label}: ${colour} is blocked iff nobody can be shown it`).toBe(accepted.length === 0);
        if (accepted.length === 0) withheld++;
        else offered++;
        count(2);
      }
    }
    // second_yellow is withheld before a yellow and offered after one: both outcomes occurred
    expect(withheld).toBeGreaterThanOrEqual(1);
    expect(offered).toBeGreaterThanOrEqual(6);
  });
});

describe("FB-TS-1: the team size the context line states", () => {
  it("an absent teamSize states the engine's default; a declared one states its own", () => {
    const stated = (cfg: FootballCfg) => buildScorebug(viewFor(cfg, live(cfg)), t).context;
    expect(stated(footballCfg())).toContain(`"size":${rules.teamSizeDefault}`);
    expect(stated(footballCfg({ teamSize: 7 }))).toContain('"size":7');
    expect(stated(footballCfg({ teamSize: 7 }))).not.toContain(`"size":${rules.teamSizeDefault}`);
    count(3);
  });
});

describe("the sweeps above compared something", () => {
  it("compared at least the plan's 12 facts", () => {
    // Runs last (file order). A skipped or filtered-out sweep leaves this at zero and fails, rather than reading as green.
    expect(compared, "facts compared by the drift guard").toBeGreaterThanOrEqual(12);
    expect(compared, "facts compared by the drift guard").toBeGreaterThan(150);
  });
});
