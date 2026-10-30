// Pad wave P3.1 - the set-based pad records (badminton, table tennis, volleyball), each field the same object the fold reads
// or a pure derivation of it (spec 2026-10-29-pad-wave-and-2b-design.md section 3.1).
//
// Single-sport reason: these three records are the set-based kernel's own, one per preset of that kernel; the other eight
// sports have their own records and their own files (P1, P2, P3.2, P4). Every sweep here walks every DECLARED cfg of each
// of the three sports (`declaredCfgs`), never one.
//
// Where a value comes from: the module's own declarations (`padSpec(cfg)`, the preset arrays) by identity, the REAL fold
// (`foldMatch`) as the witness for every rule the kernel enforces, and the rulebook (BWF, ITTF, FIVB) for the facts the
// fold does not enforce (the interval mark, the service court, the expedite floor). Never the record under test.
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "../core/events.ts";
import { resolvePositions } from "../sport/catalog.ts";
import type { ModuleEvent } from "../sport/module.ts";
import { BADMINTON_SANCTION_LEVELS, badminton } from "../sports/setbased/badminton.ts";
import { EXPEDITE_RETURNS, LIBERO_BAND, type SetBasedCfg, type SetBasedModule, type SetBasedState } from "../sports/setbased/kernel.ts";
import { TABLETENNIS_SANCTION_LEVELS, tabletennis } from "../sports/setbased/tabletennis.ts";
import { VOLLEYBALL_SANCTION_LEVELS, VOLLEYBALL_SERVE, volleyball } from "../sports/setbased/volleyball.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/helpers.ts";
import { badmintonPadRules, padEnumValues, padNumberBound, tabletennisPadRules, volleyballPadRules } from "./index.ts";
import type { SetBasedPadRules } from "./index.ts";

interface Case {
  readonly key: "badminton" | "tabletennis" | "volleyball";
  readonly module: SetBasedModule;
  readonly rules: SetBasedPadRules;
  readonly sanctionLevels: readonly string[];
}

const CASES: readonly Case[] = [
  { key: "badminton", module: badminton, rules: badmintonPadRules, sanctionLevels: BADMINTON_SANCTION_LEVELS },
  { key: "tabletennis", module: tabletennis, rules: tabletennisPadRules, sanctionLevels: TABLETENNIS_SANCTION_LEVELS },
  { key: "volleyball", module: volleyball, rules: volleyballPadRules, sanctionLevels: VOLLEYBALL_SANCTION_LEVELS },
];

const cfgsOf = (module: SetBasedModule): { name: string; cfg: SetBasedCfg }[] => declaredCfgs<SetBasedCfg>(module);

function padSpecOf(module: SetBasedModule, cfg: SetBasedCfg) {
  if (module.padSpec === undefined) throw new Error(`${module.key} declares no padSpec`);
  return module.padSpec(cfg);
}

const summaryType = (module: SetBasedModule) => `${module.key}.${module.coarseEventType}`;

/** The REAL fold of `events` after a `core.start`, strict (the write path) unless told otherwise. */
function fold(module: SetBasedModule, cfg: SetBasedCfg, events: readonly ModuleEvent[], strict = true): SetBasedState {
  const all: ModuleEvent[] = [{ type: "core.start", payload: {} }, ...events];
  const envelopes: EventEnvelope[] = all.map((event, i) => makeEnvelope(i, event));
  return foldMatch(
    module,
    cfg,
    defaultLineupPair(resolvePositions(module, cfg)),
    envelopes,
    strict ? { strictFromSeq: 0 } : undefined,
  );
}

const rally = (module: SetBasedModule, wonBy: "H" | "A", extra: Record<string, unknown> = {}): ModuleEvent => ({
  type: `${module.key}.rally`,
  payload: { wonBy, ...extra },
});

/** `n` points each, alternating H then A, from 0-0: the open set at n-all. */
const levelAt = (module: SetBasedModule, n: number): ModuleEvent[] =>
  Array.from({ length: 2 * n }, (_, i) => rally(module, i % 2 === 0 ? "H" : "A"));

/** Closed sets, alternating winners from H, each target-0 by summary: what it takes to reach set `index`. */
function setsBefore(module: SetBasedModule, cfg: SetBasedCfg, index: number): ModuleEvent[] {
  return Array.from({ length: index }, (_, i) => {
    const to = i === cfg.bestOf - 1 ? cfg.finalSetTo : cfg.setTo;
    return {
      type: summaryType(module),
      payload: i % 2 === 0 ? { home: to, away: 0 } : { home: 0, away: to },
    };
  });
}

describe("the declarations each record is (toBe)", () => {
  it("BD-SN-1 VB-SN-1 sanctionLevels is the sport file's own exported ladder, and the very array padSpec offers, for every declared cfg", () => {
    let checked = 0;
    for (const c of CASES) {
      expect(c.rules.sanctionLevels, c.key).toBe(c.sanctionLevels);
      for (const { name, cfg } of cfgsOf(c.module)) {
        expect(padEnumValues(padSpecOf(c.module, cfg), `${c.key}.sanction`, "level"), `${c.key} ${name}`).toBe(c.sanctionLevels);
        checked++;
      }
    }
    // eslint-disable-next-line no-console -- the sweep reports what it checked; the count is asserted non-zero below
    console.info(`[pad setbased] sanction ladders checked: ${checked}`);
    expect(checked).toBeGreaterThanOrEqual(2 * CASES.length);
  });

  it("eventBands is the module's padSpec fidelity map: one object, the same for every declared cfg", () => {
    let checked = 0;
    for (const c of CASES) {
      for (const { name, cfg } of cfgsOf(c.module)) {
        expect(c.rules.eventBands, `${c.key} ${name}`).toBe(padSpecOf(c.module, cfg).fidelity);
        checked++;
      }
      // Every registered event type has a band (the fidelity map's own contract), so the record hides nothing the fold takes.
      expect(Object.keys(c.rules.eventBands).sort(), c.key).toEqual(Object.keys(c.module.eventSchemas ?? {}).sort());
      expect(Object.keys(c.rules.eventBands), c.key).toHaveLength(6);
      // One object shared by every cfg and the record, so it is frozen: a write by one reader cannot reach the others.
      expect(Object.isFrozen(c.rules.eventBands), `${c.key} frozen`).toBe(true);
      expect(() => {
        (c.rules.eventBands as Record<string, number>)[`${c.key}.rally`] = 0;
      }, `${c.key} write refused`).toThrow(TypeError);
    }
    // eslint-disable-next-line no-console -- the sweep reports what it checked; the count is asserted non-zero below
    console.info(`[pad setbased] fidelity maps checked: ${checked}`);
    expect(checked).toBeGreaterThanOrEqual(2 * CASES.length);
  });

  it("VB-RC-1 volleyball's serve rotation is the exported declaration, and rotationCycle reads it for every declared cfg (FIVB 7.6.2: six)", () => {
    expect(volleyball.serveRotation).toBe(VOLLEYBALL_SERVE);
    let checked = 0;
    for (const { name, cfg } of cfgsOf(volleyball)) {
      expect(volleyballPadRules.rotationCycle(cfg), name).toBe(volleyball.serveRotation.rotationCycle);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(2);
    // FIVB 7.6.2: six positions on court, rotated one place on each side-out.
    expect(volleyballPadRules.rotationCycle({})).toBe(6);
  });

  it("TT-EX-1 table tennis's expediteReturns is the kernel's EXPEDITE_RETURNS, the threshold the fold enforces at the exact boundary", () => {
    expect(tabletennisPadRules.expediteReturns).toBe(EXPEDITE_RETURNS);
    const cfg = tabletennis.configSchema.parse({});
    const expedite: ModuleEvent = { type: "tabletennis.expedite.start", payload: {} };
    const at = (returns: number): ModuleEvent[] => [expedite, rally(tabletennis, "H", { serving: "H", returns })];
    // ITTF 2.15.2: the receiver's thirteenth good return wins the point, so a rally that reached it cannot credit the server.
    expect(() => fold(tabletennis, cfg, at(tabletennisPadRules.expediteReturns))).toThrow(
      expect.objectContaining({ code: "EXPEDITE_WRONG_WINNER" }),
    );
    expect(fold(tabletennis, cfg, at(tabletennisPadRules.expediteReturns - 1)).sets[0]).toEqual({ home: 1, away: 0, closed: false });
  });

  it("VB-LB-1 volleyball's liberoBand is the kernel's LIBERO_BAND, the administrative tier padSpec gives the scoresheet sub tally", () => {
    expect(volleyballPadRules.liberoBand).toBe(LIBERO_BAND);
    let checked = 0;
    for (const { name, cfg } of cfgsOf(volleyball)) {
      expect(volleyballPadRules.liberoBand, name).toBe(padSpecOf(volleyball, cfg).fidelity["volleyball.sub"]);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(2);
  });
});

describe("cfg readers: read through the module's configSchema, never a fallback typed here", () => {
  it("BD-SC-2 TT-SC-2 VB-SC-2 scoreBound(cfg) is the padSpec set-score bound, both fields, over every declared cfg", () => {
    let checked = 0;
    for (const c of CASES) {
      for (const { name, cfg } of cfgsOf(c.module)) {
        const spec = padSpecOf(c.module, cfg);
        expect(c.rules.scoreBound(cfg), `${c.key} ${name} home`).toBe(padNumberBound(spec, summaryType(c.module), "home").max);
        expect(c.rules.scoreBound(cfg), `${c.key} ${name} away`).toBe(padNumberBound(spec, summaryType(c.module), "away").max);
        // A capped game ends AT the cap (BWF 7.4: 30-29 wins), so the cap is also the most a game can show.
        if (cfg.cap !== null) expect(c.rules.scoreBound(cfg), `${c.key} ${name} capped`).toBe(cfg.cap);
        checked++;
      }
    }
    // eslint-disable-next-line no-console -- the sweep reports what it checked; the count is asserted non-zero below
    console.info(`[pad setbased] score bounds checked: ${checked}`);
    expect(checked).toBeGreaterThanOrEqual(2 * CASES.length);
  });

  it("bestOf and setTo are the declared cfg's own, and an absent key is the schema default (the empty cfg)", () => {
    let checked = 0;
    for (const c of CASES) {
      const fallback = cfgsOf(c.module).find((entry) => entry.name === "(schema default)");
      expect(fallback, `${c.key} accepts {}`).toBeDefined();
      for (const { name, cfg } of cfgsOf(c.module)) {
        expect(c.rules.bestOf(cfg), `${c.key} ${name}`).toBe(cfg.bestOf);
        expect(c.rules.setTo(cfg), `${c.key} ${name}`).toBe(cfg.setTo);
        checked++;
      }
      expect(c.rules.bestOf({}), c.key).toBe(fallback!.cfg.bestOf);
      expect(c.rules.setTo({ bestOf: 1 }), c.key).toBe(fallback!.cfg.setTo);
      // Second call, same answer.
      expect(c.rules.bestOf({}), c.key).toBe(fallback!.cfg.bestOf);
    }
    expect(checked).toBeGreaterThanOrEqual(2 * CASES.length);
  });

  it("refuses a cfg the schema refuses rather than inventing a value (bestOf must be odd)", () => {
    for (const c of CASES) {
      expect(() => c.rules.bestOf({ bestOf: 4 }), c.key).toThrow(/odd/);
      expect(() => c.rules.scoreBound({ bestOf: 4 }), c.key).toThrow(/odd/);
    }
  });

  it("setTarget(cfg, i) is the score at which the REAL fold closes set i won to love, deciding set included", () => {
    let checked = 0;
    for (const c of CASES) {
      for (const { name, cfg } of cfgsOf(c.module)) {
        for (let index = 0; index < cfg.bestOf; index++) {
          const target = c.rules.setTarget(cfg, index);
          // From 2-2 in a best of five (alternating set winners), set `index` is open and undecided.
          const before = setsBefore(c.module, cfg, index);
          const short = fold(c.module, cfg, [...before, ...Array.from({ length: target - 1 }, () => rally(c.module, "H"))], false);
          const won = fold(c.module, cfg, [...before, ...Array.from({ length: target }, () => rally(c.module, "H"))], false);
          expect(short.sets[index]?.closed, `${c.key} ${name} set ${index + 1} open at ${target - 1}-0`).toBe(false);
          expect(won.sets[index]?.closed, `${c.key} ${name} set ${index + 1} closed at ${target}-0`).toBe(true);
          checked++;
        }
      }
    }
    // eslint-disable-next-line no-console -- the sweep reports what it checked; the count is asserted non-zero below
    console.info(`[pad setbased] set targets witnessed by the fold: ${checked}`);
    expect(checked).toBeGreaterThan(0);
  });

  it("VB-FM-1 setTarget reads the deciding set's own target: FIVB indoor 25 then 15, beach 21 then 15", () => {
    // FIVB 6.1.2 and 6.3.2 (indoor: sets to 25, the deciding fifth to 15, two clear); the beach rules' set clause (21, the
    // deciding third to 15), not re-read in P3.1. DOMAIN.volleyball.md's format rows say the same.
    const indoor = volleyball.configSchema.parse(volleyball.variants.indoor);
    const beach = volleyball.configSchema.parse(volleyball.variants.beach);
    expect(volleyballPadRules.bestOf(indoor)).toBe(5);
    expect(volleyballPadRules.bestOf(beach)).toBe(3);
    expect([0, 1, 2, 3, 4].map((i) => volleyballPadRules.setTarget(indoor, i))).toEqual([25, 25, 25, 25, 15]);
    expect([0, 1, 2].map((i) => volleyballPadRules.setTarget(beach, i))).toEqual([21, 21, 15]);
    // Two clear and no cap, witnessed by the real fold: 25-24 is still open, 26-24 closes it, and so does 31-29.
    expect(indoor.cap).toBeNull();
    const at = (events: readonly ModuleEvent[]) => fold(volleyball, indoor, events, false).sets[0];
    expect(at([...levelAt(volleyball, 24), rally(volleyball, "H")])).toMatchObject({ home: 25, away: 24, closed: false });
    expect(at([...levelAt(volleyball, 24), rally(volleyball, "H"), rally(volleyball, "H")])).toMatchObject({ home: 26, away: 24, closed: true });
    expect(at([...levelAt(volleyball, 29), rally(volleyball, "H"), rally(volleyball, "H")])).toMatchObject({ home: 31, away: 29, closed: true });
  });

  it("TT-FM-1 a table tennis game is to 11 with two clear and no cap; a match is best of 5, bo7 best of 7, hardbat-21 games to 21", () => {
    // ITTF 2.11.1 (a game) and 2.12.1 (a match is the best of an odd number of games), not re-read in P3.1; DOMAIN.tabletennis.md's
    // format rows say the same.
    const at = (variant: string) => tabletennis.configSchema.parse(tabletennis.variants[variant]!);
    expect([tabletennisPadRules.bestOf(at("bo5")), tabletennisPadRules.setTo(at("bo5"))]).toEqual([5, 11]);
    expect([tabletennisPadRules.bestOf(at("bo7")), tabletennisPadRules.setTo(at("bo7"))]).toEqual([7, 11]);
    expect(tabletennisPadRules.setTo(at("hardbat-21"))).toBe(21);
    // The schema default is the bo5 format.
    expect([tabletennisPadRules.bestOf({}), tabletennisPadRules.setTo({})]).toEqual([5, 11]);
    const cfg = at("bo5");
    expect(cfg.cap).toBeNull();
    const game = (events: readonly ModuleEvent[]) => fold(tabletennis, cfg, events, false).sets[0];
    expect(game([...levelAt(tabletennis, 10), rally(tabletennis, "H")])).toMatchObject({ home: 11, away: 10, closed: false });
    expect(game([...levelAt(tabletennis, 10), rally(tabletennis, "H"), rally(tabletennis, "H")])).toMatchObject({ home: 12, away: 10, closed: true });
    expect(game([...levelAt(tabletennis, 20), rally(tabletennis, "H"), rally(tabletennis, "H")])).toMatchObject({ home: 22, away: 20, closed: true });
  });
});

describe("BD-SC-1 TT-SC-1 VB-SC-1 deuceNote: what the next point means at a level score, read off the fold's own set-winner rule", () => {
  /**
   * The rule as the rulebooks state it, for a level score of n-all in a set to `target`, `winBy` clear, capped at `cap`:
   *  - BWF 7.4 (and any cap): at cap-1 all the next point wins the game, a golden point;
   *  - a winBy of 1: at target-1 all the next point wins too;
   *  - BWF 7.3, ITTF 2.11.1, FIVB 6.1.2: from target-1 all onward a side needs a two-point lead ("setting" / deuce), at every
   *    level score that follows, not only the first;
   *  - below target-1 all nothing is in play.
   */
  function ruled(cfg: SetBasedCfg, target: number, n: number): "goldenPoint" | "setting" | null {
    if ((cfg.cap !== null && n === cfg.cap - 1) || (n + 1 >= target && cfg.winBy <= 1)) return "goldenPoint";
    if (n >= target - 1) return "setting";
    return null;
  }

  interface Sweep {
    readonly label: string;
    readonly module: SetBasedModule;
    readonly cfg: SetBasedCfg;
    readonly index: number;
    readonly through: number;
  }

  // A capped game (badminton's three formats), an uncapped one (table tennis to 11 and to 21), the deciding set (volleyball's
  // 15) and a set before it (25), and a win-by-one cfg where the old skin constant ("setting" at target-1 all) is wrong.
  const SWEEPS: readonly Sweep[] = [
    { label: "badminton bwf (21, cap 30)", module: badminton, cfg: badminton.configSchema.parse(badminton.variants.bwf), index: 0, through: 29 },
    { label: "badminton bwf-3x15 (15, cap 21)", module: badminton, cfg: badminton.configSchema.parse(badminton.variants["bwf-3x15"]), index: 0, through: 20 },
    { label: "badminton short (11, cap 15)", module: badminton, cfg: badminton.configSchema.parse(badminton.variants.short), index: 0, through: 14 },
    { label: "badminton win-by-one (21, cap 30)", module: badminton, cfg: badminton.configSchema.parse({ winBy: 1 }), index: 0, through: 20 },
    { label: "tabletennis default (11, uncapped)", module: tabletennis, cfg: tabletennis.configSchema.parse({}), index: 0, through: 16 },
    { label: "tabletennis hardbat-21 (21, uncapped)", module: tabletennis, cfg: tabletennis.configSchema.parse(tabletennis.variants["hardbat-21"]), index: 0, through: 24 },
    { label: "volleyball indoor set 1 (25, uncapped)", module: volleyball, cfg: volleyball.configSchema.parse(volleyball.variants.indoor), index: 0, through: 27 },
    { label: "volleyball indoor deciding set (15, uncapped)", module: volleyball, cfg: volleyball.configSchema.parse(volleyball.variants.indoor), index: 4, through: 17 },
  ];

  const rulesOf = (module: SetBasedModule): SetBasedPadRules =>
    CASES.find((c) => c.module === module)!.rules;

  it("is golden exactly where one more point closes the set, setting at every other level score from target-1 all, null below", () => {
    let visited = 0;
    const seen = { goldenPoint: 0, setting: 0, null: 0 };
    for (const sweep of SWEEPS) {
      const rules = rulesOf(sweep.module);
      const target = sweep.index === sweep.cfg.bestOf - 1 ? sweep.cfg.finalSetTo : sweep.cfg.setTo;
      const before = setsBefore(sweep.module, sweep.cfg, sweep.index);
      for (let n = 0; n <= sweep.through; n++) {
        const events = [...before, ...levelAt(sweep.module, n)];
        const state = fold(sweep.module, sweep.cfg, events, false);
        const open = state.sets[sweep.index];
        // The sweep never walks past a level score the set can reach. At 0-all the set is not materialised yet (the fold
        // opens it on its first point), which is the no-open-set case: null, whatever the rule says.
        if (n === 0) expect(open, `${sweep.label} 0-all`).toBeUndefined();
        else expect(open, `${sweep.label} ${n}-all is reachable`).toEqual({ home: n, away: n, closed: false });
        const note = rules.deuceNote(state, sweep.cfg);
        expect(note, `${sweep.label} at ${n}-all`).toBe(ruled(sweep.cfg, target, n));
        // The fold's own witness: a golden point is exactly the level score one more point decides.
        const next = fold(sweep.module, sweep.cfg, [...events, rally(sweep.module, "H")], false);
        expect(note === "goldenPoint", `${sweep.label} at ${n}-all: next point closes the set`).toBe(next.sets[sweep.index]?.closed === true);
        seen[note ?? "null"]++;
        visited++;
      }
    }
    // eslint-disable-next-line no-console -- the sweep reports what it checked; the count is asserted non-zero below
    console.info(`[pad setbased] level scores visited: ${visited} (golden ${seen.goldenPoint}, setting ${seen.setting}, none ${seen.null})`);
    expect(visited).toBeGreaterThan(0);
    // Every answer is reached, so the sweep cannot pass by never meeting one.
    expect(seen.goldenPoint).toBeGreaterThan(0);
    expect(seen.setting).toBeGreaterThan(0);
    expect(seen.null).toBeGreaterThan(0);
  });

  it("differs from the old skin constants where the rule does: 21-all in a BWF game is still setting, and win-by-one makes target-1 all golden", () => {
    const bwf = badminton.configSchema.parse(badminton.variants.bwf);
    expect(badmintonPadRules.deuceNote(fold(badminton, bwf, levelAt(badminton, 21), false), bwf)).toBe("setting");
    expect(badmintonPadRules.deuceNote(fold(badminton, bwf, levelAt(badminton, 29), false), bwf)).toBe("goldenPoint");
    const byOne = badminton.configSchema.parse({ winBy: 1 });
    expect(badmintonPadRules.deuceNote(fold(badminton, byOne, levelAt(badminton, 20), false), byOne)).toBe("goldenPoint");
    // A 21-point table tennis game is not at deuce at 10-all: the target, not a typed 10.
    const hardbat = tabletennis.configSchema.parse(tabletennis.variants["hardbat-21"]);
    expect(tabletennisPadRules.deuceNote(fold(tabletennis, hardbat, levelAt(tabletennis, 10), false), hardbat)).toBeNull();
    // A volleyball first set is not at deuce at 14-all; the deciding set is.
    const indoor = volleyball.configSchema.parse(volleyball.variants.indoor);
    expect(volleyballPadRules.deuceNote(fold(volleyball, indoor, levelAt(volleyball, 14), false), indoor)).toBeNull();
    const decider = fold(volleyball, indoor, [...setsBefore(volleyball, indoor, 4), ...levelAt(volleyball, 14)], false);
    expect(volleyballPadRules.deuceNote(decider, indoor)).toBe("setting");
  });

  it("is null with no open set: a pre-fold {}, a match not started, between sets, and an uneven score; and the same on a second call", () => {
    for (const c of CASES) {
      const cfg = c.module.configSchema.parse({});
      expect(c.rules.deuceNote({}, cfg), `${c.key} {}`).toBeNull();
      expect(c.rules.deuceNote(undefined, cfg), `${c.key} undefined`).toBeNull();
      expect(c.rules.deuceNote(fold(c.module, cfg, []), cfg), `${c.key} 0 sets`).toBeNull();
      const between = fold(c.module, cfg, setsBefore(c.module, cfg, 1));
      expect(between.sets).toHaveLength(1);
      expect(c.rules.deuceNote(between, cfg), `${c.key} between sets`).toBeNull();
      const target = c.rules.setTarget(cfg, 0);
      const uneven = fold(c.module, cfg, [...levelAt(c.module, target - 1), rally(c.module, "H")], false);
      expect(c.rules.deuceNote(uneven, cfg), `${c.key} uneven`).toBeNull();
      const level = fold(c.module, cfg, levelAt(c.module, target - 1), false);
      expect(c.rules.deuceNote(level, cfg)).toBe(c.rules.deuceNote(level, cfg));
    }
  });
});

describe("BD-SC-1 TT-SC-1 VB-SC-1 deuceNote once the match is decided at a tie (the after-a-withdrawal transition)", () => {
  // A forfeit (retired, a disqualification) or an abandon ends the match with the open set still unclosed, so the set
  // alone still reads a level score past target-1. A decided board has no next point: the note is null there, every sport.
  const ENDINGS: readonly { label: string; event: ModuleEvent }[] = [
    { label: "retired", event: { type: "core.forfeit", payload: { by: "A", reason: "retired" } } },
    { label: "disqualified", event: { type: "core.forfeit", payload: { by: "A", reason: "disqualified" } } },
    { label: "abandoned", event: { type: "core.abandon", payload: { reason: "weather" } } },
  ];

  it("is null after core.forfeit (retired, disqualified) and core.abandon at target-1 all and target+1 all, and live just before", () => {
    let checked = 0;
    for (const c of CASES) {
      const cfg = c.module.configSchema.parse({});
      const target = c.rules.setTarget(cfg, 0);
      for (const n of [target - 1, target + 1]) {
        const live = fold(c.module, cfg, levelAt(c.module, n), false);
        // The positive pair: the same tie, still live, carries the note (so null below is the decision, not the score).
        expect(live.phase, `${c.key} ${n}-all live`).toBe("live");
        expect(c.rules.deuceNote(live, cfg), `${c.key} ${n}-all live`).toBe("setting");
        for (const { label, event } of ENDINGS) {
          const decided = fold(c.module, cfg, [...levelAt(c.module, n), event], false);
          expect(decided.phase, `${c.key} ${n}-all ${label}`).not.toBe("live");
          const open = decided.sets[decided.sets.length - 1];
          expect(open !== undefined && !open.closed && open.home === n && open.away === n, `${c.key} ${n}-all ${label}: the set stays open and level`).toBe(true);
          expect(c.rules.deuceNote(decided, cfg), `${c.key} ${n}-all ${label}`).toBeNull();
          checked++;
        }
      }
    }
    // eslint-disable-next-line no-console -- the sweep reports what it checked; the count is asserted below
    console.info(`[pad setbased] decided-at-a-tie boards checked: ${checked}`);
    expect(checked).toBe(CASES.length * 2 * ENDINGS.length);
  });
});

describe("badminton: the interval mark and the service court (BWF rules the fold does not hold)", () => {
  it("BD-IN-1 intervalMark is half the game's target rounded up: 11 at 21 (BWF 16.2), 8 at 15 (the 3x15 law), 6 at 11; the deciding game's own", () => {
    const at = (variant: Partial<SetBasedCfg>, index = 0) => badmintonPadRules.intervalMark(badminton.configSchema.parse(variant), index);
    expect(at(badminton.variants.bwf!)).toBe(11);
    // The case the old constant 11 gets wrong.
    expect(at(badminton.variants["bwf-3x15"]!)).toBe(8);
    expect(at(badminton.variants.short!)).toBe(6);
    expect(at({})).toBe(11);
    // A deciding game to a different target has its own mark.
    const decider = { setTo: 21, finalSetTo: 15, cap: 30 };
    expect([0, 1, 2].map((i) => at(decider, i))).toEqual([11, 11, 8]);
  });

  it("BD-CT-1 serviceCourt is the right court on an even score (0 included) and the left on an odd one (BWF 10.1, 11.1)", () => {
    let checked = 0;
    for (let score = 0; score <= 30; score++) {
      expect(badmintonPadRules.serviceCourt(score), `server on ${score}`).toBe(score % 2 === 0 ? "right" : "left");
      checked++;
    }
    expect(checked).toBe(31);
    expect(badmintonPadRules.serviceCourt(0)).toBe("right");
  });

  it("BD-CT-1 serviceCourt refuses a score no game holds rather than naming a court for it", () => {
    for (const bad of [-1, 1.5, Number.NaN]) expect(() => badmintonPadRules.serviceCourt(bad), String(bad)).toThrow(RangeError);
  });
});

describe("table tennis: expedite (ITTF 2.15)", () => {
  const cfg = tabletennis.configSchema.parse({});
  const EXPEDITE: ModuleEvent = { type: "tabletennis.expedite.start", payload: {} };

  it("TT-EX-2 expediteScoreFloor is ADVISORY: the pad's guard (ITTF 2.15.1, DOMAIN.tabletennis.md), the fold takes expedite at 8-all and at 9-all", () => {
    // DOMAIN.tabletennis.md: the "unless both have reached 9" guard lives in the pad; the engine owns no clock and no floor.
    expect(tabletennisPadRules.expediteScoreFloor).toBe(9);
    const floor = tabletennisPadRules.expediteScoreFloor;
    for (const n of [floor - 1, floor]) {
      const state = fold(tabletennis, cfg, [...levelAt(tabletennis, n), EXPEDITE]);
      expect(state.expedite, `expedite.start at ${n}-all`).toBe(true);
    }
  });

  it("TT-EX-1 expediteReturnsCreditable agrees with the fold for every serving side and winner: only the receiver takes a 13-return rally", () => {
    let checked = 0;
    for (const serving of ["home", "away"] as const) {
      for (const winner of ["home", "away"] as const) {
        const ids = { home: "H", away: "A" } as const;
        const events = [EXPEDITE, rally(tabletennis, ids[winner], { serving: ids[serving], returns: EXPEDITE_RETURNS })];
        let accepted = true;
        try {
          fold(tabletennis, cfg, events);
        } catch {
          accepted = false;
        }
        expect(tabletennisPadRules.expediteReturnsCreditable(serving, winner), `${serving} served, ${winner} won`).toBe(accepted);
        checked++;
      }
    }
    expect(checked).toBe(4);
  });
});
