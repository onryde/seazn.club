// P1.1 (pad wave) - the period skins read the engine's pad records (`hockeyPadRules`, `icehockeyPadRules`) instead of copying
// them, and this file is the drift test that keeps it so. Every fact is read off what the REAL skin builds - its tiles, sheets and
// docks over a view folded by the real module - and compared to the record. The record itself is pinned to the fold in
// packages/engine/src/pad/period.test.ts; period-pair.test.ts referees the skin against the fold directly. Each sweep counts what it
// compared, and zero compared fails.
//
// Both period sports, every shipped variant (plus the schema default): a pad rule that holds for one cfg only breaks in the
// divisions running the other.

import { describe, expect, it } from "vitest";
import { initSquads } from "@seazn/engine/core";
import { hockeyPadRules, icehockeyPadRules, padNumberBound, type PeriodPadRules } from "@seazn/engine/pad";
import type { AnySportModule, PadSpec } from "@seazn/engine/sport";
import { resolveInitial } from "../../guided-sheet";
import type { GuidedSheetSpec, PadHostView, SheetChoiceStep, SheetNumberStep, TileSpec } from "../../types";
import { HOCKEY_CLASSES, hockeySkinV3, hockeySpec } from "../hockey";
import { ICEHOCKEY_CLASSES, icehockeySkinV3, icehockeySpec } from "../icehockey";
import { bandsOf, buildSwap, eventTypesOf, SWAP_TYPE, type PeriodSkinSpec } from "../period-shared";
import {
  foldedPhases,
  foldPeriod,
  hockey,
  icehockey,
  lineupsFor,
  phaseVerdict,
  shippedVariantCfgs,
  summaryOf,
  type PeriodStateLike,
} from "../../__tests__/_period-fold";

const T = (key: string, vars?: Record<string, string | number>): string =>
  vars === undefined ? key : `${key}(${Object.keys(vars).sort().join(",")})`;

interface Sport {
  readonly key: "hockey" | "icehockey";
  readonly module: AnySportModule;
  readonly skin: ReturnType<typeof hockeySkinV3>;
  readonly spec: PeriodSkinSpec;
  readonly rules: PeriodPadRules;
  readonly tones: Readonly<Record<string, unknown>>;
}

const SPORTS: readonly Sport[] = [
  { key: "hockey", module: hockey as AnySportModule, skin: hockeySkinV3(T), spec: hockeySpec, rules: hockeyPadRules, tones: HOCKEY_CLASSES },
  {
    key: "icehockey",
    module: icehockey as AnySportModule,
    skin: icehockeySkinV3(T),
    spec: icehockeySpec,
    rules: icehockeyPadRules,
    tones: ICEHOCKEY_CLASSES,
  },
];

/** The schema default and every shipped variant, parsed through the module's own schema. */
function cfgsOf(sport: Sport): { variant: string; cfg: unknown }[] {
  return [{ variant: "(schema default)", cfg: sport.module.configSchema.parse({}) }, ...shippedVariantCfgs(sport.module)];
}

function padSpecOf(sport: Sport, cfg: unknown): PadSpec {
  return (sport.module.padSpec as (c: unknown) => PadSpec)(cfg);
}

/** A view as `pad-host.tsx` builds it: the fold's own state and summary, the host's squad fallback. */
function viewFor(sport: Sport, cfg: unknown, state: PeriodStateLike, band: 0 | 1 | 2 | 3 = 3): PadHostView {
  const lineups = lineupsFor(sport.module, cfg);
  const squads = (state.squads ?? initSquads(lineups)) as PadHostView["squads"];
  const names: Record<string, string> = {};
  for (const side of ["home", "away"] as const) for (const member of squads[side].members) names[member.personId] = `Name ${member.personId}`;
  return {
    cfg,
    state,
    summary: summaryOf(sport.module, state),
    phase: state.phase === "pre" ? "pre" : "live",
    band,
    entitlements: {},
    personNames: names,
    squads,
    events: [],
    contextOverrides: {},
    stageKind: null,
    canOrganise: true,
    entrantNames: {},
  };
}

const live = (sport: Sport, cfg: unknown): PeriodStateLike => foldPeriod(sport.module, cfg, [["core.start"]]);

/** The event types the tiles of this view would record: a direct tile's own event, a sheet tile's sheet event, a swap tile's swap. */
function offeredTypes(sport: Sport, view: PadHostView): Set<string> {
  const sheets = sport.skin.sheets?.(view) ?? {};
  const out = new Set<string>();
  for (const tile of sport.skin.tiles(view) as TileSpec[]) {
    const action = tile.action as { event?: { type: string }; sheet?: string; swap?: string };
    if (action.event !== undefined) out.add(action.event.type);
    else if (action.swap !== undefined) out.add(SWAP_TYPE);
    else if (action.sheet !== undefined) {
      const sheet = sheets[action.sheet] as GuidedSheetSpec | undefined;
      if (sheet?.event !== undefined) out.add(sheet.event);
    }
  }
  return out;
}

function suspensionSheet(sport: Sport, view: PadHostView): GuidedSheetSpec {
  const sheet = sport.skin.sheets?.(view)["suspension-home"] as GuidedSheetSpec | undefined;
  if (sheet === undefined) throw new Error(`${sport.key}: no suspension sheet`);
  return sheet;
}

const stepOf = <S>(sheet: GuidedSheetSpec, id: string): S => {
  const step = sheet.steps.find((s) => s.id === id);
  if (step === undefined) throw new Error(`no "${id}" step`);
  return step as S;
};

describe("the skins hold the engine's records, not copies", () => {
  it("each spec's rules IS the sport's record, and its bands are the record's own eventBands object", () => {
    let facts = 0;
    for (const sport of SPORTS) {
      expect(sport.spec.rules, sport.key).toBe(sport.rules);
      expect(bandsOf(sport.spec), sport.key).toBe(sport.rules.eventBands);
      for (const { variant, cfg } of cfgsOf(sport)) {
        expect(bandsOf(sport.spec), `${sport.key}/${variant}`).toBe(padSpecOf(sport, cfg).fidelity);
        facts++;
      }
    }
    expect(facts).toBeGreaterThanOrEqual(4);
  });

  it("P1.1 m5: eventTypesOf's eight names are exactly the module's own event types: a naming template, pinned to eventSchemas", () => {
    // eventTypesOf types `${key}.<suffix>` rather than reading the engine, so this is its pin: a kernel event added, dropped or
    // renamed reds here, not only in a sweep that happens to tile it.
    let checked = 0;
    for (const sport of SPORTS) {
      const named = Object.values(eventTypesOf(sport.spec));
      expect(new Set(named).size, `${sport.key}: eight distinct names`).toBe(named.length);
      expect([...named].sort(), sport.key).toEqual(Object.keys(sport.module.eventSchemas ?? {}).sort());
      checked += named.length;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("the tone maps are keyed by the engine's class catalogue, key for key and in its order", () => {
    for (const sport of SPORTS) {
      expect(Object.keys(sport.tones), sport.key).toEqual([...sport.rules.suspensionClassKeys]);
      expect(sport.spec.classes, sport.key).toBe(sport.tones);
    }
  });
});

describe("what a tile offers, by band, is the record's eventBands", () => {
  it("in play, each event's tile is present exactly from its band up, and the swap tile from swapBand up", () => {
    let facts = 0;
    for (const sport of SPORTS) {
      const e = eventTypesOf(sport.spec);
      // The four events this kernel offers as a TILE in a running period (shot and clock live in More and on the clock bar).
      const tiled = [e.goal, e.advance, e.suspStart, e.setPiece];
      for (const { variant, cfg } of cfgsOf(sport)) {
        const state = live(sport, cfg);
        for (const band of [0, 1, 2, 3] as const) {
          const offered = offeredTypes(sport, viewFor(sport, cfg, state, band));
          for (const type of tiled) {
            const declared = sport.rules.eventBands[type];
            expect(declared, `${sport.key}: ${type} has a band`).toBeDefined();
            expect(offered.has(type), `${sport.key}/${variant} band ${band}: ${type} (band ${declared})`).toBe(band >= declared!);
            facts++;
          }
          expect(offered.has(SWAP_TYPE), `${sport.key}/${variant} band ${band}: swap`).toBe(band >= sport.rules.swapBand);
          expect(buildSwap(sport.spec, viewFor(sport, cfg, state, band), T).length > 0, `${sport.key}/${variant} band ${band}: swap slots`).toBe(
            band >= sport.rules.swapBand,
          );
          facts += 2;
        }
      }
    }
    console.info(`[pad-rules-period] band facts compared: ${facts}`);
    expect(facts).toBeGreaterThan(10);
  });
});

describe("what the skin refuses, phase by phase, is the record's eventAllowedInPhase", () => {
  it("over every phase both kernels reach, refusedEventTypes is exactly the types the record does not allow there", () => {
    let facts = 0;
    let refusals = 0;
    for (const sport of SPORTS) {
      for (const row of foldedPhases(sport.module)) {
        const refused = new Set(sport.skin.refusedEventTypes!(viewFor(sport, row.cfg, row.state)));
        for (const type of Object.keys(sport.rules.eventBands)) {
          const allowed = sport.rules.eventAllowedInPhase(type, row.phase, row.cfg);
          expect(refused.has(type), `${row.label}: ${type}, record allows=${allowed}`).toBe(!allowed);
          if (!allowed) refusals++;
          facts++;
        }
      }
    }
    console.info(`[pad-rules-period] phase facts compared: ${facts}, ${refusals} refused`);
    expect(facts).toBeGreaterThan(10);
    expect(refusals).toBeGreaterThan(0);
  });
});

describe("the empty case: a cfg with no suspension track", () => {
  it("offers no class, so the skin refuses both suspension events in play though the phase allows them, and the fold refuses the write", () => {
    let checked = 0;
    for (const sport of SPORTS) {
      const e = eventTypesOf(sport.spec);
      const cfg = sport.module.configSchema.parse({ suspensions: null });
      const state = live(sport, cfg);
      const view = viewFor(sport, cfg, state);
      expect(sport.rules.suspensionClasses(cfg), sport.key).toEqual([]);
      const refused = new Set(sport.skin.refusedEventTypes!(view));
      const offered = offeredTypes(sport, view);
      for (const type of [e.suspStart, e.suspEnd]) {
        expect(sport.rules.eventAllowedInPhase(type, String(state.phase), cfg), `${sport.key}: the phase allows ${type}`).toBe(true);
        expect(refused.has(type), `${sport.key}: ${type} refused`).toBe(true);
        expect(offered.has(type), `${sport.key}: ${type} tile`).toBe(false);
        checked++;
      }
      expect(phaseVerdict(sport.module, state, e.suspStart, { by: (state.entrants as { home: string }).home, class: "minor" }), sport.key).toBe("other");
    }
    expect(checked).toBe(2 * SPORTS.length);
  });
});

describe("the suspension sheet is built from the record", () => {
  it("class options are the cfg's offered classes, reasons the record's list, minutes the record's bound: every shipped cfg", () => {
    let facts = 0;
    const maxima = new Set<number>();
    for (const sport of SPORTS) {
      for (const { variant, cfg } of cfgsOf(sport)) {
        const sheet = suspensionSheet(sport, viewFor(sport, cfg, live(sport, cfg)));
        const classes = stepOf<SheetChoiceStep>(sheet, "class").options.map((o) => o.id);
        expect([...classes].sort(), `${sport.key}/${variant}: classes`).toEqual([...sport.rules.suspensionClasses(cfg)].sort());
        const reasons = stepOf<SheetChoiceStep>(sheet, "reason").options.map((o) => o.id);
        expect(reasons, `${sport.key}/${variant}: reasons`).toEqual([...sport.rules.suspensionReasons]);
        const minutes = stepOf<SheetNumberStep>(sheet, "minutes");
        const bound = sport.rules.suspensionMinutes(cfg);
        expect({ min: minutes.min, max: minutes.max }, `${sport.key}/${variant}: minutes`).toEqual({ min: bound.min, max: bound.max });
        // ...and the record's bound is the field padSpec declares.
        expect({ min: minutes.min, max: minutes.max }, `${sport.key}/${variant}: padSpec`).toEqual(
          padNumberBound(padSpecOf(sport, cfg), `${sport.key}.suspension.start`, "minutes"),
        );
        maxima.add(minutes.max!);
        facts += 4;
      }
    }
    console.info(`[pad-rules-period] suspension sheet facts compared: ${facts}; maxima ${[...maxima].join(", ")}`);
    expect(facts).toBeGreaterThan(10);
    // Hockey adult and youth, ice hockey iihf and recreational: the bound follows the cfg, so one constant cannot pass.
    expect(maxima.size).toBeGreaterThanOrEqual(3);
  });

  it("ice hockey's recreational cfg offers two classes where iihf offers seven, and the sheet follows the cfg, not the catalogue", () => {
    const sport = SPORTS[1]!;
    const byVariant = new Map(shippedVariantCfgs(sport.module).map(({ variant, cfg }) => [variant, cfg]));
    const optionsAt = (variant: string) => {
      const cfg = byVariant.get(variant);
      expect(cfg, `icehockey ships "${variant}"`).toBeDefined();
      return stepOf<SheetChoiceStep>(suspensionSheet(sport, viewFor(sport, cfg, live(sport, cfg))), "class").options.map((o) => o.id);
    };
    const rec = optionsAt("recreational");
    const iihf = optionsAt("iihf");
    expect(rec.length).toBeLessThan(iihf.length);
    expect(rec.length).toBeLessThan(sport.rules.suspensionClassKeys.length);
  });

  it("the empty case: with no class answered and no finite class declared, the minutes step opens at the record's fallback", () => {
    for (const sport of SPORTS) {
      const cfg = sport.module.configSchema.parse({ suspensions: { classes: { out: { minutes: null, teamShort: true, permanent: true } } } });
      const minutes = stepOf<SheetNumberStep>(suspensionSheet(sport, viewFor(sport, cfg, live(sport, cfg))), "minutes");
      expect(resolveInitial(minutes, {}), sport.key).toBe(sport.rules.suspensionMinutes(cfg).fallback);
      expect(minutes.max, sport.key).toBe(sport.rules.suspensionMinutes(cfg).max);
    }
  });
});

describe("the goal dock offers the record's kinds", () => {
  it("every shipped cfg, and an organiser list naming neither fg nor og: the kind chips are the record's goalKinds less the two the dock words itself, and the choice exactly where goalKindRequired", () => {
    let facts = 0;
    let overrides = 0;
    for (const sport of SPORTS) {
      // The fold takes `fg` and `og` whatever the cfg lists (padSpec's goal enum always carries both), so a list that omits them
      // still gets them offered: the one cfg where the record's kinds and the cfg's own list differ.
      const listed = (sport.module.configSchema.parse({}) as { goalKinds: string[] }).goalKinds.filter((k) => k !== "fg" && k !== "og");
      const override = sport.module.configSchema.parse({ goalKinds: listed });
      expect(sport.rules.goalKinds(override), `${sport.key}: the record adds fg and og back`).toEqual(expect.arrayContaining(["fg", "og"]));
      for (const { variant, cfg } of [...cfgsOf(sport), { variant: `goalKinds ${listed.join(",")}`, cfg: override }]) {
        if (cfg === override) overrides++;
        const state = live(sport, cfg);
        const view = viewFor(sport, cfg, state);
        const tap = { by: (state.entrants as { home: string }).home };
        const dock = sport.skin.dock(`${sport.key}.goal`, view, tap)!;
        const kinds = sport.rules.goalKinds(cfg);
        const required = sport.rules.goalKindRequired;
        expect(dock.requires, `${sport.key}/${variant}: requires`).toBe(required ? "kind" : undefined);
        // `og` is the Own goal flag in both; `fg` needs no chip unless the type is required (then it is the first answer).
        const expected = kinds.filter((k) => k !== "og" && (required || k !== "fg"));
        expect(dock.chips.filter((c) => c.id.startsWith("kind:")).map((c) => c.id.slice(5)), `${sport.key}/${variant}: kinds`).toEqual(expected);
        expect(dock.chips.some((c) => c.id === "ownGoal"), `${sport.key}/${variant}: own goal`).toBe(kinds.includes("og"));
        // Every kind the dock offers is one the fold accepts.
        for (const chip of dock.chips.filter((c) => c.id.startsWith("kind:") || c.id === "ownGoal")) {
          expect(phaseVerdict(sport.module, state, `${sport.key}.goal`, chip.mutate(tap)), `${sport.key}/${variant}: ${chip.id}`).toBe("accepted");
          facts++;
        }
        facts += 3;
      }
    }
    console.info(`[pad-rules-period] goal dock facts compared: ${facts} (${overrides} organiser lists)`);
    expect(facts).toBeGreaterThan(10);
    expect(overrides).toBe(SPORTS.length);
  });
});

describe("the assist chips stop at the record's assistsMax", () => {
  it("ice hockey (the sport that records assists): tapping every assist chip leaves exactly assistsMax, and the fold takes it", () => {
    // single-sport: field hockey's cfg records no assists (`assists: false`), so its dock offers no assist chip to tap.
    const sport = SPORTS[1]!;
    let checked = 0;
    for (const { variant, cfg } of cfgsOf(sport)) {
      const state = live(sport, cfg);
      const view = viewFor(sport, cfg, state);
      const home = (state.entrants as { home: string }).home;
      const scorer = view.squads.home.members.find((m) => m.onField !== false)?.personId;
      expect(scorer, `${variant}: a home skater`).toBeDefined();
      const tap = { by: home, person: scorer! };
      const chips = sport.skin.dock(`${sport.key}.goal`, view, tap)!.chips.filter((c) => c.id.startsWith("assist:"));
      expect(chips.length, `${variant}: more assist chips than the cap, so the cap is what stops them`).toBeGreaterThan(sport.rules.assistsMax);
      const sent = chips.reduce((payload, chip) => chip.mutate(payload), tap as Record<string, unknown>);
      expect((sent.assists as string[]).length, variant).toBe(sport.rules.assistsMax);
      expect(phaseVerdict(sport.module, state, `${sport.key}.goal`, sent), variant).toBe("accepted");
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    // The other sport shares the cap.
    expect(SPORTS[0]!.rules.assistsMax).toBe(sport.rules.assistsMax);
  });
});
