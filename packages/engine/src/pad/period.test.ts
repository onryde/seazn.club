// P1.1 (pad wave) - the period sports' pad records, `hockeyPadRules` and `icehockeyPadRules`.
//
// The record reads padSpec(cfg) and the kernel's own declarations, so a test that only compared it with padSpec would prove the
// facade calls padSpec and nothing else. Every fact below therefore has at least one oracle that does not share the record's code
// path: a strict apply through the real module (the fold is the referee), the event schemas, the declared variant cfgs and the
// suspension catalogues they name, or the rulebook rows cited inline. Every sweep counts what it compared, and zero compared fails.
//
// single-sport: the period kernel's two presets (hockey, icehockey) are the only sports these two records describe; football is read
// once, as the engine's own declaration of a substitution event's band.
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { foldMatch } from "../core/events.ts";
import { resolvePositions } from "../sport/catalog.ts";
import { buildPathObject, FIDELITY, type ModuleEvent, type PadSpec, type SportModule } from "../sport/module.ts";
import { football } from "../sports/football/football.ts";
import { hockey, HOCKEY_SUSPENSION_REASONS } from "../sports/hockey/hockey.ts";
import { icehockey, ICEHOCKEY_SUSPENSION_REASONS } from "../sports/icehockey/icehockey.ts";
import {
  EVENT_PHASES,
  expectedAdvance,
  PeriodGoal,
  PeriodSuspensionStart,
  playPhases,
  type PeriodCfg,
  type PeriodEv,
  type PeriodState,
} from "../sports/period/kernel.ts";
import {
  HOCKEY_SUSPENSIONS,
  HOCKEY_YOUTH_SUSPENSIONS,
  ICEHOCKEY_RECREATIONAL_SUSPENSIONS,
  ICEHOCKEY_SUSPENSIONS,
} from "../sports/period/suspensions.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/helpers.ts";
import { hockeyPadRules, icehockeyPadRules, padEnumValues, padFieldOf, padNumberBound, type PeriodPadRules } from "./index.ts";

type PeriodModule = SportModule<PeriodCfg, PeriodEv, PeriodState>;

interface Sport {
  readonly key: "hockey" | "icehockey";
  readonly module: PeriodModule;
  readonly rules: PeriodPadRules;
  /** The preset's own declared offence list (hockey.ts / icehockey.ts). */
  readonly reasons: readonly string[];
  /** The full ladder catalogue every variant of the sport draws its classes from (period/suspensions.ts). */
  readonly catalogue: Readonly<Record<string, unknown>>;
}

const SPORTS: readonly Sport[] = [
  { key: "hockey", module: hockey, rules: hockeyPadRules, reasons: HOCKEY_SUSPENSION_REASONS, catalogue: HOCKEY_SUSPENSIONS },
  { key: "icehockey", module: icehockey, rules: icehockeyPadRules, reasons: ICEHOCKEY_SUSPENSION_REASONS, catalogue: ICEHOCKEY_SUSPENSIONS },
];

const cfgsOf = (sport: Sport): { name: string; cfg: PeriodCfg }[] => declaredCfgs<PeriodCfg>(sport.module);

function specOf(sport: Sport, cfg: PeriodCfg): PadSpec {
  const padSpec = sport.module.padSpec;
  if (padSpec === undefined) throw new Error(`${sport.key} declares no padSpec`);
  return padSpec(cfg);
}

const START: ModuleEvent = { type: "core.start", payload: {} };

function lineupsOf(sport: Sport, cfg: PeriodCfg) {
  return defaultLineupPair(resolvePositions(sport.module, cfg));
}

function fold(sport: Sport, cfg: PeriodCfg, events: readonly ModuleEvent[]): PeriodState {
  return foldMatch(sport.module, cfg, lineupsOf(sport, cfg), events.map((e, i) => makeEnvelope(i, e)));
}

/** One strict apply through the real module: "accepted", or the EngineError code it refused with. Anything else rethrows. */
function verdictOf(sport: Sport, state: PeriodState, type: string, payload: Record<string, unknown>): string {
  try {
    sport.module.apply(state, makeEnvelope(999, { type, payload }) as never, { strict: true });
    return "accepted";
  } catch (err) {
    if (err instanceof EngineError) return err.code;
    throw err;
  }
}

/** A minimal payload for `type`, built from the action's OWN padSpec declaration: an enum's first value, a number field's minimum,
 *  a toggle off, and the home entrant for the side it names. Validated against the module's event schema, so a refusal below is
 *  never a parse refusal standing in for a phase one. When this cfg's padSpec declares no such action (a cfg with no shoot-out has
 *  no attempt panel), the action is read off another declared cfg of the same sport: the write is still one a scorer can send. */
function probeOf(sport: Sport, spec: PadSpec, type: string, state: PeriodState): Record<string, unknown> | null {
  const actionIn = (s: PadSpec) => s.panels.flatMap((panel) => panel.actions).find((a) => a.type === type);
  const action = actionIn(spec) ?? cfgsOf(sport).map(({ cfg }) => actionIn(specOf(sport, cfg))).find((a) => a !== undefined);
  if (action === undefined) return null;
  const entries: [string, unknown][] = [];
  for (const field of action.fields) {
    if (field.kind === "enum") entries.push([field.path, field.values[0]]);
    else if (field.kind === "number") entries.push([field.path, field.min]);
    else entries.push([field.path, false]);
  }
  for (const item of action.attribution) if (item.kind === "side") entries.push([item.path, state.entrants.home]);
  const payload = buildPathObject(entries);
  const parsed = sport.module.eventSchemas?.[type]?.safeParse(payload);
  if (parsed?.success !== true) throw new Error(`${sport.key}: the probe for ${type} does not parse: ${JSON.stringify(payload)}`);
  return payload;
}

interface PhaseState {
  readonly label: string;
  readonly state: PeriodState;
}

/** Every phase a real fold of this cfg reaches, read back off the folded state: pre, the start, each period the kernel expects next
 *  on a level score (into overtime and the shoot-out where the cfg has them), a decided match, a finalized one and an abandoned one. */
function reachedStates(sport: Sport, cfg: PeriodCfg): PhaseState[] {
  const advance = (to: string): ModuleEvent => ({ type: `${sport.key}.period.advance`, payload: { to } });
  const out: PhaseState[] = [];
  const at = (label: string, events: readonly ModuleEvent[]): PeriodState => {
    const state = fold(sport, cfg, events);
    out.push({ label: `${label} (${state.phase})`, state });
    return state;
  };
  at("pre", []);
  const level: ModuleEvent[] = [START];
  let state = at("start", level);
  for (let step = 1; step <= 16; step++) {
    const next = expectedAdvance(state);
    if (next === null) break;
    level.push(advance(next));
    state = at(`level+${step}`, level);
  }
  const home = state.entrants.home;
  const decided: ModuleEvent[] = [START, { type: `${sport.key}.goal`, payload: { by: home, kind: "fg" } }];
  state = fold(sport, cfg, decided);
  for (let step = 0; step < 16; step++) {
    const next = expectedAdvance(state);
    if (next === null) break;
    decided.push(advance(next));
    state = fold(sport, cfg, decided);
  }
  at("decided", decided);
  at("finalized", [...decided, { type: "core.finalize", payload: {} }]);
  at("abandoned", [START, { type: "core.abandon", payload: { reason: "floodlight failure" } }]);
  return out;
}

const suffixOf = (sport: Sport, type: string): string => type.slice(sport.key.length + 1);

// ---------------------------------------------------------------------------------------------------------------------------------
// The rulebook rows the phase table must state: which phases each of this kernel's events is legal in. Typed from the rules, never
// from EVENT_PHASES, so dropping or adding a phase there reds here even though the fold and the pad (which both read the table)
// would still agree with each other. "play" is a running period or overtime (the cfg's own labels); a decided match is in none.
// ---------------------------------------------------------------------------------------------------------------------------------
const RULE_PHASES: Readonly<Record<string, readonly string[]>> = {
  // A goal is scored in play. The shoot-out credits none (icehockey/DOMAIN.md, "the shoot-out itself scores no player goals").
  goal: ["play"],
  // A whistle closes the running period or overtime; its targets are the next period and "FT" (padSpec's advance enum).
  "period.advance": ["play"],
  // The match clock runs in play only: none before the opening whistle, and "SHOOTOUT — where there is no match clock at all"
  // (hockey/DOMAIN.md, the card-time row).
  clock: ["play"],
  // Cards and penalties before the opening whistle, in play and during the shoot-out (hockey/DOMAIN.md and icehockey/DOMAIN.md, the
  // card-time rows: "a card stamped in `pre` is SERVED from the opening whistle", "one stamped in `SHOOTOUT`"); never once decided.
  "suspension.start": ["pre", "play", "SHOOTOUT"],
  // An explicit release is legal wherever the card it ends can be running: the same window.
  "suspension.end": ["pre", "play", "SHOOTOUT"],
  // The attempts ARE the shoot-out (FIH GTR App. 12, IIHF Rule 87).
  "shootout.attempt": ["SHOOTOUT"],
  // A set piece is awarded in play; a stroke during the shoot-out is unmodelled (hockey/DOMAIN.md, the shoot-out foul row).
  set_piece: ["play"],
  // A shot on goal is open play; a shoot-out attempt is its own event (hockey/DOMAIN.md, the shots row).
  shot: ["play"],
};

describe("eventBands is padSpec's own fidelity object", () => {
  it("is the very object padSpec(cfg).fidelity returns, for every declared cfg, and names every event type the module declares", () => {
    let checked = 0;
    for (const sport of SPORTS) {
      const cfgs = cfgsOf(sport);
      expect(cfgs.length, `${sport.key} declared cfgs`).toBeGreaterThanOrEqual(2);
      for (const { name, cfg } of cfgs) {
        // toBe, not toEqual: the facade holds the kernel's object, it does not copy it, and one object for every cfg means the bands
        // cannot be a cfg-dependent fact read once at load.
        expect(sport.rules.eventBands, `${sport.key}/${name}`).toBe(specOf(sport, cfg).fidelity);
        checked++;
      }
      expect(Object.keys(sport.rules.eventBands).sort(), `${sport.key}: a band per declared event type`).toEqual(
        Object.keys(sport.module.eventSchemas ?? {}).sort(),
      );
      for (const band of Object.values(sport.rules.eventBands)) expect(Object.keys(FIDELITY)).toContain(String(band));
    }
    // eslint-disable-next-line no-console -- TEST-STRATEGY anti-vacuity: the sweep reports what it checked
    console.info(`[pad/period] eventBands: ${checked} cfgs compared`);
    expect(checked).toBeGreaterThanOrEqual(4);
  });
});

describe("suspensionReasons is the preset's own offence list", () => {
  it("is the sport's declared list itself, and padSpec's reason enum at every declared cfg", () => {
    let checked = 0;
    for (const sport of SPORTS) {
      expect(sport.rules.suspensionReasons, sport.key).toBe(sport.reasons);
      for (const { name, cfg } of cfgsOf(sport)) {
        expect(sport.rules.suspensionReasons, `${sport.key}/${name}`).toEqual(padEnumValues(specOf(sport, cfg), `${sport.key}.suspension.start`, "reason"));
        checked++;
      }
    }
    expect(hockeyPadRules.suspensionReasons, "the two federations offer different lists").not.toEqual(icehockeyPadRules.suspensionReasons);
    expect(checked).toBeGreaterThanOrEqual(4);
  });
});

describe("suspension classes: the static catalogue, and what one cfg offers", () => {
  it("suspensionClassKeys is the sport's full ladder catalogue, in its declared order, and covers every declared cfg's classes", () => {
    let covered = 0;
    for (const sport of SPORTS) {
      expect(sport.rules.suspensionClassKeys, sport.key).toEqual(Object.keys(sport.catalogue));
      for (const { name, cfg } of cfgsOf(sport)) {
        for (const key of Object.keys(cfg.suspensions?.classes ?? {})) {
          expect(sport.rules.suspensionClassKeys, `${sport.key}/${name}: ${key}`).toContain(key);
          covered++;
        }
      }
    }
    expect(covered).toBeGreaterThan(0);
  });

  it("suspensionClasses(cfg) is the cfg's own classes: icehockey recreational offers two, iihf seven, hockey youth the adult names", () => {
    let checked = 0;
    for (const sport of SPORTS) {
      for (const { name, cfg } of cfgsOf(sport)) {
        expect(sport.rules.suspensionClasses(cfg), `${sport.key}/${name}`).toEqual(Object.keys(cfg.suspensions?.classes ?? {}));
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(4);
    // Named from the variant declarations (icehockey.ts / hockey.ts) and the catalogues they name, never from the record.
    const ice = new Map(cfgsOf(SPORTS[1]!).map(({ name, cfg }) => [name, cfg]));
    const rec = icehockeyPadRules.suspensionClasses(ice.get("recreational"));
    const iihf = icehockeyPadRules.suspensionClasses(ice.get("iihf"));
    expect(rec).toEqual(Object.keys(ICEHOCKEY_RECREATIONAL_SUSPENSIONS));
    expect(iihf).toEqual(Object.keys(ICEHOCKEY_SUSPENSIONS));
    // The case a constant cannot pass: one sport, two cfgs, two answers - and the recreational one is NOT the static catalogue.
    expect(rec).not.toEqual(iihf);
    expect(rec).not.toEqual(icehockeyPadRules.suspensionClassKeys);
    const youth = cfgsOf(SPORTS[0]!).find((c) => c.name === "youth");
    expect(youth, "hockey declares a youth variant").toBeDefined();
    expect(hockeyPadRules.suspensionClasses(youth!.cfg)).toEqual(Object.keys(HOCKEY_YOUTH_SUSPENSIONS));
  });

  it("the empty case: a cfg with no suspension track offers no class; a stored {} reads the schema default; a second call agrees", () => {
    for (const sport of SPORTS) {
      expect(sport.rules.suspensionClasses({ suspensions: null }), sport.key).toEqual([]);
      const parsedDefault = sport.module.configSchema.parse({});
      const stored = {};
      expect(sport.rules.suspensionClasses(stored), sport.key).toEqual(Object.keys(parsedDefault.suspensions?.classes ?? {}));
      expect(sport.rules.suspensionClasses(stored), `${sport.key}: second call`).toEqual(sport.rules.suspensionClasses(stored));
    }
  });

  it("an unreadable cfg throws rather than offering a guess", () => {
    for (const sport of SPORTS) {
      expect(() => sport.rules.suspensionClasses({ periods: { count: 9, minutes: 15 } }), sport.key).toThrow();
      expect(() => sport.rules.suspensionClasses(undefined), sport.key).toThrow();
    }
  });
});

describe("suspensionMinutes: padSpec's bound, the schema's floor, and the (c) fallback", () => {
  it("min/max are padSpec's minutes field bound at every declared cfg", () => {
    let checked = 0;
    for (const sport of SPORTS) {
      let perSport = 0;
      for (const { name, cfg } of cfgsOf(sport)) {
        const { min, max } = sport.rules.suspensionMinutes(cfg);
        expect({ min, max }, `${sport.key}/${name}`).toEqual(padNumberBound(specOf(sport, cfg), `${sport.key}.suspension.start`, "minutes"));
        perSport++;
      }
      expect(perSport, `${sport.key} cfgs`).toBeGreaterThanOrEqual(2);
      checked += perSport;
    }
    // eslint-disable-next-line no-console -- TEST-STRATEGY anti-vacuity: the sweep reports what it checked
    console.info(`[pad/period] suspensionMinutes: ${checked} cfgs compared`);
  });

  it("max follows the cfg: double the longest finite class nominal the cfg declares (an FIH yellow is a minimum of 5, 10 is common)", () => {
    const maxima = new Set<number>();
    let checked = 0;
    for (const sport of SPORTS) {
      for (const { name, cfg } of cfgsOf(sport)) {
        const finite = Object.values(cfg.suspensions?.classes ?? {})
          .map((cls) => cls.minutes)
          .filter((m): m is number => m !== null);
        expect(finite.length, `${sport.key}/${name} declares a timed class`).toBeGreaterThan(0);
        const max = sport.rules.suspensionMinutes(cfg).max;
        expect(max, `${sport.key}/${name}`).toBe(2 * Math.max(...finite));
        maxima.add(max);
        checked++;
      }
    }
    // Hockey adult 10, youth 6, ice hockey iihf 20, recreational 4: no single constant passes this.
    expect(maxima.size, `maxima seen: ${[...maxima].join(", ")}`).toBeGreaterThanOrEqual(3);
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  it("min and the fallback are the least whole minute the event schema accepts", () => {
    for (const sport of SPORTS) {
      const cfg = sport.module.configSchema.parse({});
      const { min, max, fallback } = sport.rules.suspensionMinutes(cfg);
      const accepts = (minutes: number) => PeriodSuspensionStart.safeParse({ by: "H", class: "x", minutes }).success;
      expect(accepts(min), `${sport.key}: min ${min}`).toBe(true);
      expect(accepts(min - 1), `${sport.key}: below min`).toBe(false);
      expect(accepts(fallback), `${sport.key}: fallback ${fallback}`).toBe(true);
      expect(accepts(fallback - 1), `${sport.key}: below the fallback`).toBe(false);
      expect(fallback, sport.key).toBeGreaterThanOrEqual(min);
      expect(fallback, sport.key).toBeLessThanOrEqual(max);
    }
  });

  it("the empty case: a cfg with no suspension track, or only permanent classes, still answers (padSpec's generic 20), and agrees with padSpec where padSpec declares the field", () => {
    for (const sport of SPORTS) {
      const none = sport.module.configSchema.parse({ suspensions: null });
      expect(padFieldOf(specOf(sport, none), `${sport.key}.suspension.start`, "minutes"), `${sport.key}: no track, no field`).toBeUndefined();
      expect(sport.rules.suspensionMinutes(none), sport.key).toMatchObject({ min: 1, max: 20 });
      const permanent = sport.module.configSchema.parse({ suspensions: { classes: { out: { minutes: null, teamShort: true, permanent: true } } } });
      expect(sport.rules.suspensionMinutes(permanent), sport.key).toMatchObject(padNumberBound(specOf(sport, permanent), `${sport.key}.suspension.start`, "minutes"));
      expect(sport.rules.suspensionMinutes(permanent).max, sport.key).toBe(20);
    }
  });
});

describe("assistsMax is the cap the goal schema enforces", () => {
  it("PeriodGoal takes assistsMax assists and refuses one more; the fold that records assists takes the cap, the one that does not refuses any", () => {
    const people = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
    for (const sport of SPORTS) {
      const max = sport.rules.assistsMax;
      expect(max, sport.key).toBeGreaterThan(0);
      expect(PeriodGoal.safeParse({ by: "H", assists: people(max) }).success, `${sport.key}: ${max}`).toBe(true);
      expect(PeriodGoal.safeParse({ by: "H", assists: people(max + 1) }).success, `${sport.key}: ${max + 1}`).toBe(false);
    }
    // Through the real module: ice hockey records assists (`assists: true`), field hockey does not - the cap is the schema's, the
    // switch is the cfg's.
    const ice = SPORTS[1]!;
    const iceCfg = ice.module.configSchema.parse({});
    const iceState = fold(ice, iceCfg, [START]);
    expect(verdictOf(ice, iceState, "icehockey.goal", { by: iceState.entrants.home, assists: people(ice.rules.assistsMax) })).toBe("accepted");
    expect(verdictOf(ice, iceState, "icehockey.goal", { by: iceState.entrants.home, assists: people(ice.rules.assistsMax + 1) })).toBe("INVALID_EVENT");
    const field = SPORTS[0]!;
    const fieldCfg = field.module.configSchema.parse({});
    const fieldState = fold(field, fieldCfg, [START]);
    expect(verdictOf(field, fieldState, "hockey.goal", { by: fieldState.entrants.home, kind: "fg", assists: people(1) })).toBe("INVALID_EVENT");
    expect(hockeyPadRules.assistsMax).toBe(icehockeyPadRules.assistsMax);
  });
});

describe("goalKinds(cfg) is exactly the kinds the fold accepts", () => {
  it("a strict goal of each kind is accepted exactly when goalKinds(cfg) lists it, at every declared cfg of both sports", () => {
    // Every kind either sport's cfgs name, plus the two the kernel always takes and one nobody declares.
    const tried = new Set<string>(["fg", "og", "not_a_goal_kind"]);
    for (const sport of SPORTS) for (const { cfg } of cfgsOf(sport)) for (const kind of cfg.goalKinds) tried.add(kind);
    let checked = 0;
    let refused = 0;
    for (const sport of SPORTS) {
      for (const { name, cfg } of cfgsOf(sport)) {
        const kinds = sport.rules.goalKinds(cfg);
        expect(kinds, `${sport.key}/${name}`).toEqual(padEnumValues(specOf(sport, cfg), `${sport.key}.goal`, "kind"));
        const state = fold(sport, cfg, [START]);
        for (const kind of tried) {
          const verdict = verdictOf(sport, state, `${sport.key}.goal`, { by: state.entrants.home, kind });
          expect(verdict === "accepted", `${sport.key}/${name}: kind ${kind} -> ${verdict}`).toBe(kinds.includes(kind));
          if (verdict !== "accepted") refused++;
          checked++;
        }
      }
    }
    // eslint-disable-next-line no-console -- TEST-STRATEGY anti-vacuity: the sweep reports what it checked
    console.info(`[pad/period] goalKinds: ${checked} (cfg, kind) pairs, ${refused} refused`);
    expect(checked).toBeGreaterThan(0);
    expect(refused, "some kind was refused somewhere, so the sweep is not all-accept").toBeGreaterThan(0);
    // The two federations' lists differ: hockey's penalty corner is no ice-hockey kind, and the power play no field-hockey one.
    expect(hockeyPadRules.goalKinds({})).toContain("pc");
    expect(icehockeyPadRules.goalKinds({})).not.toContain("pc");
  });
});

describe("goalKindRequired is the preset flag the fold refuses an untyped goal by", () => {
  it("a strict untyped goal is refused GOAL_KIND_REQUIRED exactly where the record says so, at every declared cfg", () => {
    let checked = 0;
    for (const sport of SPORTS) {
      for (const { name, cfg } of cfgsOf(sport)) {
        const state = fold(sport, cfg, [START]);
        const verdict = verdictOf(sport, state, `${sport.key}.goal`, { by: state.entrants.home });
        expect(verdict === "GOAL_KIND_REQUIRED", `${sport.key}/${name}: ${verdict}`).toBe(sport.rules.goalKindRequired);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(4);
    // FIH ranks level teams on field goals (GTR App. 3, HK-TB-2); the IIHF ranks on no goal type.
    expect(hockeyPadRules.goalKindRequired).toBe(true);
    expect(icehockeyPadRules.goalKindRequired).toBe(false);
  });
});

describe("swapBand (c) is the band the engine gives a substitution", () => {
  it("equals football's own football.sub band at every declared football cfg, the one sport whose module declares a substitution event", () => {
    let checked = 0;
    for (const { name, cfg } of declaredCfgs(football)) {
      const fidelity = football.padSpec?.(cfg).fidelity;
      expect(fidelity?.["football.sub"], `football/${name}`).toBe(hockeyPadRules.swapBand);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    expect(FIDELITY[hockeyPadRules.swapBand], "who was on the field is timeline detail").toBe("timeline");
    expect(icehockeyPadRules.swapBand).toBe(hockeyPadRules.swapBand);
  });
});

describe("eventAllowedInPhase: the phase table the fold's WRONG_PHASE guards read", () => {
  it("EVENT_PHASES states the rulebook rows, one per event type of each module", () => {
    let rows = 0;
    for (const sport of SPORTS) {
      const suffixes = Object.keys(sport.module.eventSchemas ?? {}).map((type) => suffixOf(sport, type)).sort();
      expect(Object.keys(EVENT_PHASES).sort(), `${sport.key}: a row per event type`).toEqual(suffixes);
    }
    expect(Object.keys(RULE_PHASES).sort()).toEqual(Object.keys(EVENT_PHASES).sort());
    for (const [suffix, phases] of Object.entries(RULE_PHASES)) {
      const table: Readonly<Record<string, readonly string[] | undefined>> = EVENT_PHASES;
      expect([...(table[suffix] ?? [])].sort(), suffix).toEqual([...phases].sort());
      rows++;
    }
    expect(rows).toBe(8);
  });

  it("over every phase a real fold of every declared cfg reaches, the fold refuses WRONG_PHASE exactly when the record says no", () => {
    let pairs = 0;
    let refusals = 0;
    for (const sport of SPORTS) {
      const seen = new Set<string>();
      for (const { name, cfg } of cfgsOf(sport)) {
        const spec = specOf(sport, cfg);
        for (const { label, state } of reachedStates(sport, cfg)) {
          seen.add(state.phase);
          for (const type of Object.keys(sport.module.eventSchemas ?? {})) {
            const payload = probeOf(sport, spec, type, state);
            if (payload === null) continue;
            const allowed = sport.rules.eventAllowedInPhase(type, state.phase, cfg);
            const verdict = verdictOf(sport, state, type, payload);
            expect(verdict === "WRONG_PHASE", `${sport.key}/${name} ${label}: ${type} -> ${verdict}, record says ${allowed}`).toBe(!allowed);
            if (!allowed) refusals++;
            pairs++;
          }
        }
      }
      // The sweep is worth something only if it reached the phases the table distinguishes.
      for (const phase of ["pre", "SHOOTOUT", "done", "final", "abandoned"]) expect([...seen], `${sport.key} reached ${phase}`).toContain(phase);
      expect([...seen].filter((p) => playPhases(sport.module.configSchema.parse({})).includes(p) && p !== "pre" && p !== "SHOOTOUT").length, `${sport.key}: a play phase`).toBeGreaterThan(0);
    }
    // eslint-disable-next-line no-console -- TEST-STRATEGY anti-vacuity: the sweep reports what it checked
    console.info(`[pad/period] eventAllowedInPhase vs the fold: ${pairs} (cfg, phase, type) triples, ${refusals} refused`);
    expect(pairs).toBeGreaterThan(0);
    expect(refusals).toBeGreaterThan(0);
  });

  it("a phase token one cfg has and another lacks: the record answers per cfg, and the fold agrees in the state that token names", () => {
    // Every token any declared cfg of either sport can stamp. Where a real fold of THIS cfg reaches the token, the state is that fold's
    // (a shoot-out phase holds its own record); where it cannot, the state is the cfg's started state with its phase overwritten:
    // unreachable through a fold, and exactly where a cfg-blind answer would be wrong.
    const tokens = new Set<string>();
    for (const sport of SPORTS) for (const { cfg } of cfgsOf(sport)) for (const p of playPhases(cfg)) tokens.add(p);
    let pairs = 0;
    let synthesized = 0;
    const answers = new Map<string, Set<boolean>>();
    for (const sport of SPORTS) {
      for (const { name, cfg } of cfgsOf(sport)) {
        const spec = specOf(sport, cfg);
        const started = fold(sport, cfg, [START]);
        const reached = new Map<string, PeriodState>();
        for (const { state } of reachedStates(sport, cfg)) if (!reached.has(state.phase)) reached.set(state.phase, state);
        for (const phase of tokens) {
          const real = reached.get(phase);
          if (real === undefined) synthesized++;
          const state: PeriodState = real ?? { ...started, phase };
          for (const type of Object.keys(sport.module.eventSchemas ?? {})) {
            const payload = probeOf(sport, spec, type, state);
            if (payload === null) continue;
            const allowed = sport.rules.eventAllowedInPhase(type, phase, cfg);
            const verdict = verdictOf(sport, state, type, payload);
            expect(verdict === "WRONG_PHASE", `${sport.key}/${name} in ${phase}: ${type} -> ${verdict}, record says ${allowed}`).toBe(!allowed);
            const key = `${sport.key} ${type} ${phase}`;
            answers.set(key, (answers.get(key) ?? new Set()).add(allowed));
            pairs++;
          }
        }
      }
    }
    const cfgDependent = [...answers].filter(([, seen]) => seen.size === 2).map(([key]) => key);
    // eslint-disable-next-line no-console -- TEST-STRATEGY anti-vacuity: the sweep reports what it checked
    console.info(`[pad/period] foreign phase tokens: ${pairs} triples, ${synthesized} synthesized states, ${cfgDependent.length} answers that differ by cfg`);
    expect(pairs).toBeGreaterThan(0);
    expect(synthesized, "some cfg lacks some token, so a cfg-blind table would be tested").toBeGreaterThan(0);
    // Overtime exists for ice hockey's iihf and not its recreational cfg; the FIH shoot-out for hockey's fih-shootout and not its
    // default. A table read without the cfg could not answer both.
    expect(cfgDependent).toEqual(expect.arrayContaining(["icehockey icehockey.goal OT", "hockey hockey.shootout.attempt SHOOTOUT"]));
  });

  it("a type that is not one of this module's own event types throws, naming it; a stored cfg reads like its parsed default, twice", () => {
    for (const sport of SPORTS) {
      const other = sport.key === "hockey" ? "icehockey" : "hockey";
      for (const type of ["football.goal", "core.start", `${other}.goal`, `${sport.key}.not_an_event`, "goal", ""]) {
        expect(() => sport.rules.eventAllowedInPhase(type, "pre", {}), `${sport.key}: ${type}`).toThrow(new RegExp(`"${type.replace(/\./g, "\\.")}"`));
      }
      const parsed = sport.module.configSchema.parse({});
      const stored = {};
      for (const type of Object.keys(sport.module.eventSchemas ?? {})) {
        for (const phase of [...playPhases(parsed), "done"]) {
          const first = sport.rules.eventAllowedInPhase(type, phase, stored);
          expect(first, `${sport.key} ${type} ${phase}`).toBe(sport.rules.eventAllowedInPhase(type, phase, parsed));
          expect(sport.rules.eventAllowedInPhase(type, phase, stored), `${sport.key} ${type} ${phase}: second call`).toBe(first);
        }
      }
    }
  });
});
