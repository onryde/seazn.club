// W2c Task 16 (spec item 15; X-SR-1 public half, items 12, 13, 14) - the public format line says the rules for EVERY
// sport: five new families beside the set kernel and tennis's nested one, the stage's deciders, its abandon policy.
//
// WHERE THE EXPECTED VALUES COME FROM (TEST-STRATEGY: never from the code under test). Numbers are read off the
// engine's own declarations: the module's variants through its `configSchema`, its `stageDefaults` (what a fresh knockout
// stage starts with), its `ruleKeys` bounds (`matchBound`/`whenAbsent`, the very numbers a match may shorten) and
// `abandonOptions`. The only typed-in table is the sport -> family map, which is the plan's own statement of the
// rulebook (11 sports, 7 families) and is held to the registry by count, so a twelfth sport fails here until it is placed.
import { describe, expect, it } from "vitest";
import type { AnySportModule } from "@seazn/engine/sport";
import { deciderKeysFor, stageDefaultsFor, stageKeysFor } from "@seazn/engine/sport";
import { BRACKET_KINDS, DRAW_KINDS, type StageKind } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { TIEBREAK_RUNGS } from "@seazn/engine/sports/boardgame";
import { postedStageCfg } from "@/lib/stage-decider-off";
import { resolveLatestModule } from "@/server/engine-db";
import enPublic from "@/dictionaries/en/public.json";
import esPublic from "@/dictionaries/es/public.json";
import frPublic from "@/dictionaries/fr/public.json";
import nlPublic from "@/dictionaries/nl/public.json";
import { rulesLineText } from "@/lib/rules-line";
import {
  DECIDER_DESCRIBED_KEYS,
  describeAbandon,
  describeDeciders,
  describeMatchRules,
  effectiveRulesLine,
  rulesDifferFromDivision,
  ruleFamilyOf,
  type RuleFamily,
  type RulesLineT,
} from "../describe-rules";

const mod = (key: string): AnySportModule => resolveLatestModule(key);
const modules = builtinModules as readonly AnySportModule[];
/** A variant's config the way a division row carries it. */
const divisionCfg = (m: AnySportModule, v: string): Record<string, unknown> => m.configSchema.parse(m.variants[v]) as Record<string, unknown>;
const text = (l: RulesLineT | null): string => rulesLineText(enPublic as never, l ?? []);
const wordNumber = (n: number): RegExp => new RegExp(`(?<![\\w.])${String(n).replace(".", "\\.")}(?![\\w.])`);
const DICTS = { en: enPublic, es: esPublic, fr: frPublic, nl: nlPublic } as const;
const BRACKETS = [...BRACKET_KINDS] as StageKind[];
const TABLES = [...DRAW_KINDS] as StageKind[];
const valueAt = (o: unknown, path: string): unknown => path.split(".").reduce<unknown>((a, k) => (a !== null && typeof a === "object" ? (a as Record<string, unknown>)[k] : undefined), o);

describe("ruleFamilyOf - the family comes from the module's rule-key DECLARATIONS, never from its sport key", () => {
  // The plan's table (Task 16 Step 3): 11 sports, 7 families. Held to the registry by count below.
  const FAMILY: Record<string, RuleFamily> = {
    badminton: "setbased", tabletennis: "setbased", volleyball: "setbased",
    tennis: "nested",
    football: "period", icehockey: "period", hockey: "period",
    cricket: "innings",
    carrom: "boards",
    boardgame: "board",
    generic: "score",
  };

  it("every builtin sport has the plan's family, and the table covers the registry exactly (counted)", () => {
    expect(modules.map((m) => m.key).sort()).toEqual(Object.keys(FAMILY).sort());
    let checked = 0;
    for (const m of modules) {
      expect(ruleFamilyOf(m), m.key).toBe(FAMILY[m.key]);
      checked++;
    }
    expect(checked).toBe(modules.length);
    expect(new Set(Object.values(FAMILY)).size, "seven distinct families").toBe(7);
  });

  it("it reads declarations: a renamed sport with football's rule keys is still a period sport; one with none is no family", () => {
    const renamed = { ...mod("football"), key: "five-a-side-demo" } as AnySportModule;
    expect(ruleFamilyOf(renamed)).toBe("period");
    expect(ruleFamilyOf({ ...mod("football"), ruleKeys: {} } as AnySportModule)).toBeNull();
    // A module that declares no ruleKeys at all (a hand-built fake) answers null; it never throws.
    expect(ruleFamilyOf({} as AnySportModule)).toBeNull();
  });

  it("the family is picked by the key the family reads (each detection arm, alone)", () => {
    const only = (key: string) => ruleFamilyOf({ ruleKeys: { [key]: { scope: "match" } } } as unknown as AnySportModule);
    expect(only("set")).toBe("nested");
    expect(only("setTo")).toBe("setbased");
    expect(only("halfMinutes")).toBe("period");
    expect(only("periods.minutes")).toBe("period");
    expect(only("ballsPerInnings")).toBe("innings");
    expect(only("maxBoards")).toBe("boards");
    expect(only("clock")).toBe("board");
    expect(only("resultMode")).toBe("score");
    expect(only("sparkle")).toBeNull();
  });
});

describe("the new families print the numbers the sport's own config carries", () => {
  it("period sports: minutes and the period word come from the declared count (2 halves, 4 quarters, 3 periods)", () => {
    let checked = 0;
    const words = new Set<string>();
    for (const m of modules.filter((x) => ruleFamilyOf(x) === "period"))
      for (const v of Object.keys(m.variants)) {
        const c = divisionCfg(m, v);
        const periods = valueAt(c, "periods") as { count: number; minutes: number } | undefined;
        const count = periods?.count ?? (c.halves as number);
        const minutes = periods?.minutes ?? (c.halfMinutes as number);
        const line = text(describeMatchRules(m.key, m, c));
        expect(line, `${m.key}/${v}`).toMatch(wordNumber(minutes));
        const word = ({ 2: /halves/, 3: /periods/, 4: /quarters/ } as Record<number, RegExp>)[count]!;
        expect(line, `${m.key}/${v} count ${count}`).toMatch(word);
        words.add(String(count));
        checked++;
      }
    expect(checked).toBe(modules.filter((x) => ruleFamilyOf(x) === "period").reduce((n, m) => n + Object.keys(m.variants).length, 0));
    expect([...words].sort(), "the variants exercise 2, 3 and 4 periods").toEqual(["2", "3", "4"]);
  });

  it("a period count nobody names a word for still prints (one period)", () => {
    const hockey = mod("hockey");
    const c = { ...divisionCfg(hockey, "fih-outdoor"), periods: { count: 1, minutes: 60 } };
    expect(text(describeMatchRules("hockey", hockey, c))).toBe("1 × 60 min");
  });

  it("cricket: overs a side (balls / balls per over); a Test has no overs and says its innings", () => {
    const cricket = mod("cricket");
    let overs = 0;
    for (const v of Object.keys(cricket.variants)) {
      const c = divisionCfg(cricket, v) as { ballsPerInnings: number | null; ballsPerOver: number; inningsPerSide: number; maxOversPerBowler?: number };
      const line = text(describeMatchRules("cricket", cricket, c));
      if (c.ballsPerInnings === null) {
        expect(line, v).not.toMatch(/overs a side|balls a side/);
        expect(line, v).toMatch(wordNumber(c.inningsPerSide));
        expect(line, v).toMatch(/innings a side/);
      } else {
        expect(line, v).toMatch(new RegExp(`${c.ballsPerInnings / c.ballsPerOver} overs a side`));
        expect(line, v).not.toMatch(/innings a side/);
        overs++;
      }
      if (c.maxOversPerBowler !== undefined) expect(line, v).toMatch(new RegExp(`max ${c.maxOversPerBowler} overs a bowler`));
      else expect(line, v).not.toMatch(/a bowler/);
    }
    expect(overs, "three limited-overs variants").toBe(3);
    // Overs that do not divide evenly are balls, never "16.6666 overs".
    expect(text(describeMatchRules("cricket", cricket, { ...divisionCfg(cricket, "t20"), ballsPerInnings: 100 }))).toMatch(/100 balls a side/);
  });

  it("carrom: best of games, points per game, boards per game - the three match-scoped keys, all from cfg", () => {
    const carrom = mod("carrom");
    const lines = new Set<string>();
    for (const v of Object.keys(carrom.variants)) {
      const c = divisionCfg(carrom, v) as { bestOf: number; gameTo: number; maxBoards: number };
      const line = text(describeMatchRules("carrom", carrom, c));
      expect(line, v).toMatch(new RegExp(`Best of ${c.bestOf} games`));
      expect(line, v).toMatch(new RegExp(`to ${c.gameTo} points`));
      expect(line, v).toMatch(new RegExp(`up to ${c.maxBoards} boards`));
      lines.add(line);
    }
    expect(lines.size, "icf (25) and club-29 (29) print differently").toBe(Object.keys(carrom.variants).length);
  });

  it("chess: the time-control family, and the clock only when the stage sets one", () => {
    const chess = mod("boardgame");
    const seen = new Set<string>();
    for (const v of Object.keys(chess.variants)) {
      const line = text(describeMatchRules("boardgame", chess, divisionCfg(chess, v)));
      expect(line, v).toMatch(new RegExp(`${v} time control`, "i"));
      expect(line, v).not.toMatch(/\bmin\b/); // no clock set -> no clock claimed
      seen.add(line);
    }
    expect(seen.size).toBe(3);
    const base = divisionCfg(chess, "classical");
    const clockLine = (clock: Record<string, number>) => text(describeMatchRules("boardgame", chess, { ...base, clock }));
    // Seconds on the wire (the editor writes minutes x 60): 90 minutes + 30 s, never "5400 min".
    expect(clockLine({ base: 5400, increment: 30 })).toBe("Classical time control, 90 min + 30 s");
    expect(clockLine({ base: 600 })).toBe("Classical time control, 10 min each");
    expect(clockLine({ base: 900, delay: 5 })).toBe("Classical time control, 15 min each, 5 s delay");
    expect(clockLine({ base: 300, increment: 3, delay: 2 })).toBe("Classical time control, 5 min + 3 s, 2 s delay");
    expect(clockLine({ base: 90 })).toBe("Classical time control, 1.5 min each");
    // A zero increment is sudden death, not "+ 0 s".
    expect(clockLine({ base: 600, increment: 0 })).toBe("Classical time control, 10 min each");
  });

  it("generic: the result mode, and draws only where they are allowed", () => {
    const generic = mod("generic");
    expect(text(describeMatchRules("generic", generic, divisionCfg(generic, "win_loss")))).toBe("Winner entered at the end");
    expect(text(describeMatchRules("generic", generic, divisionCfg(generic, "score")))).toBe("Score entered at the end, draws allowed");
    expect(text(describeMatchRules("generic", generic, { ...divisionCfg(generic, "win_loss"), allowDraws: true }))).toBe("Winner entered at the end, draws allowed");
  });
});

describe("describeDeciders - how a tied match ends, from the engine's own declarations", () => {
  /** Whether a decider is ON in a cfg, by its VALUE SHAPE (the engine's schemas): a flag, an `{enabled}` object, a
   *  non-null object, chess's rung list (BG-KO-1: absent = every rung, [] = none), carrom's tie board ('extra' / 'draw'). */
  function isOn(key: string, value: unknown): boolean {
    if (key === "tiebreakRungs") return value === undefined ? true : Array.isArray(value) && value.length > 0;
    if (key === "tieBoard") return value === "extra";
    if (value === null || value === undefined || value === false) return false;
    if (typeof value === "object" && "enabled" in (value as object)) return (value as { enabled: unknown }).enabled === true;
    return true;
  }
  /** The numbers a spectator reads: every key the engine bounds for a match (`matchBound`), at the cfg's value, or the
   *  engine's own `whenAbsent` where the stage carries none. An `{enabled, halfMinutes}` decider reads its half. */
  function boundedNumbers(m: AnySportModule, cfg: unknown): number[] {
    const out: number[] = [];
    for (const [path, fact] of Object.entries(m.ruleKeys ?? {})) {
      if (fact.matchBound === undefined) continue;
      const v = valueAt(cfg, path) ?? fact.whenAbsent;
      const n = typeof v === "object" && v !== null ? (v as { halfMinutes?: unknown }).halfMinutes : v;
      if (typeof n === "number") out.push(n);
    }
    return out;
  }

  it("every bracket kind of every sport, over every variant: the ON deciders are said, with the engine's numbers; all off says so; none declared says nothing (counted)", () => {
    let checked = 0;
    const branch = { said: 0, none: 0, nothing: 0 };
    for (const m of modules)
      for (const v of Object.keys(m.variants))
        for (const kind of BRACKETS) {
          const cfg = postedStageCfg(m, divisionCfg(m, v), kind, v);
          const c = cfg as Record<string, unknown>;
          const declared = deciderKeysFor(m, null, null);
          const on = declared.filter((k) => isOn(k, c[k]));
          const line = describeDeciders(m, kind, cfg);
          const label = `${m.key}/${v}/${kind}`;
          if (on.length > 0) {
            expect(line.length, label).toBeGreaterThanOrEqual(on.length);
            expect(line.map((x) => x.key), label).not.toContain("format.rules.decider.none");
            // The numbers: only where the deciders that own them are on (the bound keys are the decider's own).
            const words = text(line);
            for (const n of boundedNumbers(m, cfg)) expect(words, `${label} ${n}`).toMatch(wordNumber(n));
            branch.said++;
          } else if (deciderKeysFor(m, kind, null).length > 0) {
            expect(line, label).toEqual([{ key: "format.rules.decider.none" }]);
            branch.none++;
          } else {
            expect(line, label).toEqual([]);
            branch.nothing++;
          }
          checked++;
        }
    expect(checked).toBe(modules.reduce((n, m) => n + Object.keys(m.variants).length, 0) * BRACKETS.length);
    expect(checked).toBeGreaterThan(0);
    // Anti-vacuity: each of the three branches is reached by the registry (none: a cricket Test knockout).
    expect(branch.said).toBeGreaterThan(0);
    expect(branch.none).toBeGreaterThan(0);
    expect(branch.nothing).toBeGreaterThan(0);
  });

  it("every decider key any sport declares has a describer (a twelfth sport's decider cannot be silently left out)", () => {
    const declared = [...new Set(modules.flatMap((m) => deciderKeysFor(m, null, null)))].sort();
    expect(declared.length).toBeGreaterThan(0);
    expect([...DECIDER_DESCRIBED_KEYS].sort()).toEqual(declared);
  });

  it("football: a knockout's extra time is 2 halves of the stage's length, its penalties the stage's count - youth takes 3, the Laws 5", () => {
    const football = mod("football");
    const says: Record<string, { et: number; kicks: number }> = {};
    for (const v of ["11-a-side", "youth"]) {
      const preset = stageDefaultsFor(football, "knockout", v) as { extraTime: { halfMinutes: number }; shootoutAttempts: number };
      const line = describeDeciders(football, "knockout", postedStageCfg(football, divisionCfg(football, v), "knockout", v));
      expect(line, v).toEqual([
        { key: "format.rules.decider.extraTime", params: { n: preset.extraTime.halfMinutes } },
        { key: "format.rules.decider.penalties", params: { n: preset.shootoutAttempts } },
      ]);
      says[v] = { et: preset.extraTime.halfMinutes, kicks: preset.shootoutAttempts };
    }
    expect(says.youth!.kicks, "the witness needs the two counts apart").not.toBe(says["11-a-side"]!.kicks);
    expect(text(describeDeciders(football, "knockout", postedStageCfg(football, divisionCfg(football, "11-a-side"), "knockout", "11-a-side"))))
      .toBe(`Extra time (2 × ${says["11-a-side"]!.et} min), penalties (${says["11-a-side"]!.kicks} each)`);
  });

  it("football with no stored kick count plays the engine's declared default (whenAbsent), and says it", () => {
    const football = mod("football");
    const declared = football.ruleKeys!.shootoutAttempts!.whenAbsent!;
    const cfg = { ...divisionCfg(football, "11-a-side"), shootout: true };
    expect(describeDeciders(football, "knockout", cfg)).toEqual([{ key: "format.rules.decider.penalties", params: { n: declared } }]);
  });

  it("ice hockey: overtime minutes and shoot-out attempts from the stage's preset - not the division's 5-minute overtime", () => {
    const ice = mod("icehockey");
    const preset = stageDefaultsFor(ice, "knockout", "iihf") as { overtime: { minutes: number }; shootout: { attempts: number } };
    const division = divisionCfg(ice, "iihf") as { overtime: { minutes: number } };
    expect(preset.overtime.minutes, "the witness needs the two overtimes apart").not.toBe(division.overtime.minutes);
    expect(describeDeciders(ice, "knockout", postedStageCfg(ice, division, "knockout", "iihf"))).toEqual([
      { key: "format.rules.decider.overtime", params: { n: preset.overtime.minutes } },
      { key: "format.rules.decider.shootout", params: { n: preset.shootout.attempts } },
    ]);
    // Recreational plays neither at the division level; its knockout stage still gets the preset's.
    expect(describeDeciders(ice, "knockout", divisionCfg(ice, "recreational")), "off at the division: said as none in a knockout").toEqual([{ key: "format.rules.decider.none" }]);
  });

  it("hockey: only the shoot-out, with the preset's attempts (FIH has no sudden-death overtime here)", () => {
    const hockey = mod("hockey");
    const preset = stageDefaultsFor(hockey, "knockout", "fih-outdoor") as { shootout: { attempts: number } };
    expect(describeDeciders(hockey, "knockout", postedStageCfg(hockey, divisionCfg(hockey, "fih-outdoor"), "knockout", "fih-outdoor")))
      .toEqual([{ key: "format.rules.decider.shootout", params: { n: preset.shootout.attempts } }]);
  });

  it("cricket: a limited-overs knockout names its super over; a Test knockout (no super over) waits for the organiser", () => {
    const cricket = mod("cricket");
    expect(describeDeciders(cricket, "knockout", postedStageCfg(cricket, divisionCfg(cricket, "t20"), "knockout", "t20"))).toEqual([{ key: "format.rules.decider.superOver" }]);
    expect(describeDeciders(cricket, "knockout", postedStageCfg(cricket, divisionCfg(cricket, "test"), "knockout", "test"))).toEqual([{ key: "format.rules.decider.none" }]);
  });

  it("chess: the rung list in the stage's ORDER; absent = every rung in the engine's order; [] = held for the organiser", () => {
    const chess = mod("boardgame");
    const base = divisionCfg(chess, "classical");
    const rung = (r: string) => ({ key: `format.rules.decider.${r}` });
    const reversed = [...TIEBREAK_RUNGS].reverse();
    expect(describeDeciders(chess, "knockout", { ...base, tiebreakRungs: reversed })).toEqual(reversed.map(rung));
    expect(reversed.join(), "the witness needs the stage's order apart from the engine's").not.toBe([...TIEBREAK_RUNGS].join());
    expect(describeDeciders(chess, "knockout", base), "absent = every rung").toEqual([...TIEBREAK_RUNGS].map(rung));
    expect(describeDeciders(chess, "knockout", { ...base, tiebreakRungs: [] })).toEqual([{ key: "format.rules.decider.none" }]);
    expect(describeDeciders(chess, "knockout", { ...base, tiebreakRungs: [TIEBREAK_RUNGS[1]] })).toEqual([rung(TIEBREAK_RUNGS[1]!)]);
    // Every rung the engine names has its words in every locale.
    for (const [locale, dict] of Object.entries(DICTS))
      for (const r of TIEBREAK_RUNGS) expect(Object.hasOwn(dict, `format.rules.decider.${r}`), `${locale} ${r}`).toBe(true);
  });

  it("chess in a TABLE stage has no tie-break rungs to name", () => {
    const chess = mod("boardgame");
    for (const kind of TABLES) expect(describeDeciders(chess, kind, divisionCfg(chess, "classical")), kind).toEqual([]);
  });

  it("carrom: a bracket always plays the extra board (CA-KO-1); a table plays it only under tieBoard 'extra' (the 'draw' house rule says nothing)", () => {
    const carrom = mod("carrom");
    const base = divisionCfg(carrom, "icf");
    expect(base.tieBoard, "premise: ICF plays the extra board").toBe("extra");
    for (const kind of BRACKETS) expect(describeDeciders(carrom, kind, postedStageCfg(carrom, base, kind, "icf")), kind).toEqual([{ key: "format.rules.decider.extraBoard" }]);
    for (const kind of TABLES) {
      expect(describeDeciders(carrom, kind, base), kind).toEqual([{ key: "format.rules.decider.extraBoard" }]);
      expect(describeDeciders(carrom, kind, { ...base, tieBoard: "draw" }), kind).toEqual([]);
    }
  });

  it("a table kind says NOTHING for a decider that is off (a drawn league match is a result, not a pending decision) - never 'none'", () => {
    let checked = 0;
    for (const m of modules)
      for (const v of Object.keys(m.variants))
        for (const kind of TABLES) {
          const line = describeDeciders(m, kind, divisionCfg(m, v));
          expect(line.map((x) => x.key), `${m.key}/${v}/${kind}`).not.toContain("format.rules.decider.none");
          checked++;
        }
    expect(checked).toBe(modules.reduce((n, m) => n + Object.keys(m.variants).length, 0) * TABLES.length);
  });

  it("a table stage whose organiser turned a decider ON says it (football league with extra time)", () => {
    const football = mod("football");
    const cfg = { ...divisionCfg(football, "11-a-side"), extraTime: { enabled: true, halfMinutes: 10 } };
    expect(describeDeciders(football, "league", cfg)).toEqual([{ key: "format.rules.decider.extraTime", params: { n: 10 } }]);
  });

  it("all deciders off in a knockout says so (the spectator is told a level match waits for the organiser)", () => {
    const football = mod("football");
    const line = describeDeciders(football, "knockout", { ...divisionCfg(football, "11-a-side"), extraTime: { enabled: false, halfMinutes: 15 }, shootout: false });
    expect(line).toEqual([{ key: "format.rules.decider.none" }]);
    expect(text(line)).toBe("Level matches wait for the organiser");
  });

  it("a sport with no decider declared says nothing in any kind (badminton knockout)", () => {
    const badminton = mod("badminton");
    for (const kind of [...BRACKETS, ...TABLES]) expect(describeDeciders(badminton, kind, divisionCfg(badminton, "bwf")), kind).toEqual([]);
  });

  it("a refused config, or no kind at all, never throws: nothing honest to say", () => {
    const football = mod("football");
    expect(describeDeciders(football, "knockout", { halfMinutes: -1 })).toEqual([]);
    expect(describeDeciders(football, null, { ...divisionCfg(football, "11-a-side"), shootout: true }))
      .toEqual([{ key: "format.rules.decider.penalties", params: { n: football.ruleKeys!.shootoutAttempts!.whenAbsent! } }]);
  });
});

describe("describeAbandon - the policy the stage plays, in the sport's own vocabulary", () => {
  /** A config the schema accepts for this policy (carrom/generic only SHARE under a drawn game - the engine's own refusal). */
  function cfgFor(m: AnySportModule, policy: string): Record<string, unknown> {
    const base = divisionCfg(m, Object.keys(m.variants)[0]!);
    for (const extra of [{}, { allowDraws: true }, { tieBoard: "draw" }]) {
      const candidate = { ...base, ...extra, abandonPolicy: policy };
      if (m.configSchema.safeParse(candidate).success) return candidate;
    }
    throw new Error(`${m.key}: no config the schema accepts for ${policy}`);
  }

  it("every option every sport offers names itself, distinctly, in all four locales; a sport offering none says nothing (counted)", () => {
    let withOptions = 0;
    let options = 0;
    for (const m of modules) {
      const offered = m.abandonOptions ?? [];
      if (offered.length === 0) {
        expect(describeAbandon(m, divisionCfg(m, Object.keys(m.variants)[0]!)), m.key).toEqual([]);
        continue;
      }
      withOptions++;
      const words = new Set<string>();
      for (const policy of offered) {
        const line = describeAbandon(m, cfgFor(m, policy));
        expect(line, `${m.key}/${policy}`).toEqual([{ key: `format.rules.abandon.${policy}` }]);
        for (const [locale, dict] of Object.entries(DICTS)) expect(Object.hasOwn(dict, `format.rules.abandon.${policy}`), `${locale} ${policy}`).toBe(true);
        words.add(text(line));
        options++;
      }
      expect(words.size, `${m.key}: each option reads differently`).toBe(offered.length);
    }
    expect(withOptions).toBeGreaterThan(0);
    // The sports that offer options are exactly those whose stages can set the policy (a league stage's keys).
    expect(modules.filter((m) => (m.abandonOptions ?? []).length > 0).map((m) => m.key).sort())
      .toEqual(modules.filter((m) => stageKeysFor(m, "league", null).includes("abandonPolicy")).map((m) => m.key).sort());
    expect(options).toBe(modules.reduce((n, m) => n + (m.abandonOptions ?? []).length, 0));
  });

  it("an absent policy is a replay (CA-AB-1 / GN-AB-1); a policy the sport does not offer says nothing", () => {
    const carrom = mod("carrom");
    const noPolicy = divisionCfg(carrom, "icf");
    expect(noPolicy.abandonPolicy, "premise: carrom's policy is optional").toBeUndefined();
    expect(describeAbandon(carrom, noPolicy)).toEqual([{ key: "format.rules.abandon.replay" }]);
    const football = mod("football");
    expect(football.abandonOptions).not.toContain("share");
    expect(describeAbandon(football, { ...divisionCfg(football, "11-a-side"), abandonPolicy: "share" } as never)).toEqual([]);
  });

  it("hockey's fourth-quarter rule has its own sentence", () => {
    const hockey = mod("hockey");
    expect(text(describeAbandon(hockey, cfgFor(hockey, "q4_stands")))).toMatch(/4th quarter/);
  });
});

describe("rulesDifferFromDivision - over the engine's declared stage and match keys, by dotted path", () => {
  /** A different value of the same shape (the engine's schema may refuse it - then the RAW comparison still sees it). */
  function bump(v: unknown): unknown {
    if (typeof v === "number") return v + 1;
    if (typeof v === "boolean") return !v;
    if (typeof v === "string") return `${v}-x`;
    if (Array.isArray(v)) return [...v, "x"];
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bump(x)]));
    return 1;
  }
  function withValue(cfg: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
    const [head, ...rest] = path.split(".");
    const out = { ...cfg };
    out[head!] = rest.length === 0 ? value : withValue((cfg[head!] ?? {}) as Record<string, unknown>, rest.join("."), value);
    return out;
  }

  it("each declared stage/match key, moved on its own, is a difference - for every sport (counted)", () => {
    let checked = 0;
    for (const m of modules) {
      const division = divisionCfg(m, Object.keys(m.variants)[0]!);
      const keys = stageKeysFor(m, null, null);
      expect(keys.length, `${m.key} declares stage/match keys`).toBeGreaterThan(0);
      for (const key of keys) {
        const moved = withValue(division, key, bump(valueAt(division, key)));
        expect(rulesDifferFromDivision(m.key, m, moved, division), `${m.key} ${key}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBe(modules.reduce((n, m) => n + stageKeysFor(m, null, null).length, 0));
  });

  it("a key the sport does NOT declare as a stage or match rule is no difference (points, and a sibling leaf like periods.count)", () => {
    const hockey = mod("hockey");
    const division = divisionCfg(hockey, "fih-outdoor") as { periods: { count: number; minutes: number }; points: Record<string, number> };
    expect(stageKeysFor(hockey, null, null)).toContain("periods.minutes");
    expect(stageKeysFor(hockey, null, null)).not.toContain("periods.count");
    expect(rulesDifferFromDivision("hockey", hockey, { ...division, periods: { ...division.periods, count: division.periods.count - 1 } }, division)).toBe(false);
    expect(rulesDifferFromDivision("hockey", hockey, { ...division, periods: { ...division.periods, minutes: division.periods.minutes + 1 } }, division)).toBe(true);
    expect(rulesDifferFromDivision("hockey", hockey, { ...division, points: { ...division.points, win: 9 } }, division)).toBe(false);
  });

  it("the kinds union: a bracket-only key and a table-only key both count (chess rungs, carrom tie board)", () => {
    const chess = mod("boardgame");
    const base = divisionCfg(chess, "classical");
    expect(rulesDifferFromDivision("boardgame", chess, { ...base, tiebreakRungs: ["blitz"] }, base)).toBe(true);
    const carrom = mod("carrom");
    const c = divisionCfg(carrom, "icf");
    expect(rulesDifferFromDivision("carrom", carrom, { ...c, tieBoard: "draw" }, c)).toBe(true);
  });
});

describe("effectiveRulesLine - format, then how a tie ends, then an abandon policy the stage changed", () => {
  it("a football knockout over an 11-a-side division: its period line, its extra time, its penalties - in that order", () => {
    const football = mod("football");
    const division = divisionCfg(football, "11-a-side");
    const line = effectiveRulesLine("football", football, postedStageCfg(football, division, "knockout", "11-a-side"), division, "knockout");
    expect(line!.map((c) => c.key)).toEqual([
      "format.rules.period.halves",
      "format.rules.decider.extraTime",
      "format.rules.decider.penalties",
    ]);
    expect(text(line)).toMatch(/^2 halves of 45 min, extra time \(2 × 15 min\), penalties \(5 each\)$/);
  });

  it("identical rules stay null (the preset name), whatever the sport", () => {
    let checked = 0;
    for (const m of modules)
      for (const v of Object.keys(m.variants)) {
        const c = divisionCfg(m, v);
        expect(effectiveRulesLine(m.key, m, c, c, "league"), `${m.key}/${v}`).toBeNull();
        checked++;
      }
    expect(checked).toBeGreaterThan(modules.length);
  });

  it("the abandon policy is said only when the stage CHANGES it (not on every line)", () => {
    const football = mod("football");
    const division = divisionCfg(football, "11-a-side");
    expect(division.abandonPolicy).toBe("replay");
    const award = effectiveRulesLine("football", football, { ...division, halfMinutes: 40, abandonPolicy: "award" }, division, "league")!;
    expect(award.at(-1)).toEqual({ key: "format.rules.abandon.award" });
    const sameAbandon = effectiveRulesLine("football", football, { ...division, halfMinutes: 40 }, division, "league")!;
    expect(sameAbandon.map((c) => c.key)).toEqual(["format.rules.period.halves"]);
    // Only the policy moved: the line is the format plus the policy (never the preset name).
    expect(effectiveRulesLine("football", football, { ...division, abandonPolicy: "award" }, division, "league")!.map((c) => c.key))
      .toEqual(["format.rules.period.halves", "format.rules.abandon.award"]);
  });

  it("with no kind given the line still says an ON decider, and never claims 'none'", () => {
    const football = mod("football");
    const division = divisionCfg(football, "11-a-side");
    const stage = postedStageCfg(football, division, "knockout", "11-a-side");
    expect(effectiveRulesLine("football", football, stage, division)!.map((c) => c.key)).toContain("format.rules.decider.extraTime");
    const off = { ...division, halfMinutes: 40 };
    expect(effectiveRulesLine("football", football, off, division)!.map((c) => c.key)).not.toContain("format.rules.decider.none");
  });

  it("a knockout over the same format whose deciders are all off still differs only by what it says: format, then 'none'", () => {
    const football = mod("football");
    const division = divisionCfg(football, "11-a-side");
    const line = effectiveRulesLine("football", football, { ...division, halfMinutes: 40 }, division, "knockout")!;
    expect(line.map((c) => c.key)).toEqual(["format.rules.period.halves", "format.rules.decider.none"]);
  });
});

describe("guards - what the describers refuse to say, and the doubles they must survive", () => {
  const football = mod("football");
  const cricket = mod("cricket");
  const chess = mod("boardgame");
  /** A module whose parse is the identity over `data`, keeping the real module's declarations - the only way to reach a
   *  config the real schema refuses or defaults away. */
  const parsing = (m: AnySportModule, data: Record<string, unknown>): AnySportModule =>
    ({ ...m, configSchema: { safeParse: () => ({ success: true, data }) } }) as unknown as AnySportModule;

  it("a decider no describer knows is never read as OFF: with every known decider off, a bracket line claims neither a clause nor 'none'", () => {
    const sparkle = { ...football, ruleKeys: { ...football.ruleKeys, sparkle: { scope: "stage", decider: true } } } as unknown as AnySportModule;
    const allOff = divisionCfg(football, "11-a-side");
    expect(describeDeciders(football, "knockout", allOff), "premise: without the unknown key it IS 'none'").toEqual([{ key: "format.rules.decider.none" }]);
    expect(describeDeciders(sparkle, "knockout", allOff)).toEqual([]);
  });

  it("an ON shoot-out whose kick count is neither stored nor declared says no number - and is still ON, so the line never claims 'none'", () => {
    const noDefault = Object.fromEntries(Object.entries(football.ruleKeys!.shootoutAttempts!).filter(([k]) => k !== "whenAbsent"));
    expect(football.ruleKeys!.shootoutAttempts!.whenAbsent, "premise: the engine declares a default kick count").toBeGreaterThan(0);
    const bare = { ...football, ruleKeys: { ...football.ruleKeys, shootoutAttempts: noDefault } } as unknown as AnySportModule;
    expect(describeDeciders(bare, "knockout", { ...divisionCfg(football, "11-a-side"), shootout: true })).toEqual([]);
    // The same cfg with the engine's declaration intact says its count (the declared number, not an invented one).
    expect(describeDeciders(football, "knockout", { ...divisionCfg(football, "11-a-side"), shootout: true }).length).toBe(1);
  });

  it("a module with no bracketDeciders (a hand-built double) is not asked for them", () => {
    const noOverlay = { ...football, bracketDeciders: undefined } as unknown as AnySportModule;
    const cfg = { ...divisionCfg(football, "11-a-side"), shootout: true };
    expect(describeDeciders(noOverlay, "knockout", cfg)).toEqual(describeDeciders(football, "knockout", cfg));
  });

  it("a refused config says no abandon policy (the absent default is not the policy of a config nobody parsed)", () => {
    expect(describeAbandon(football, { halfMinutes: -1 })).toEqual([]);
    expect(describeAbandon(football, divisionCfg(football, "11-a-side")).length, "premise: the parsed one says it").toBe(1);
  });

  it("a bracket plays the sport's own bracketDeciders even where the caller handed the raw division cfg (carrom: the extra board, whatever the tie board)", () => {
    const carrom = mod("carrom");
    const drawn = { ...divisionCfg(carrom, "icf"), tieBoard: "draw" as const, abandonPolicy: "share" as const };
    expect(carrom.configSchema.safeParse(drawn).success, "premise: the schema accepts the drawn-game house rule").toBe(true);
    for (const kind of BRACKETS) expect(describeDeciders(carrom, kind, drawn), kind).toEqual([{ key: "format.rules.decider.extraBoard" }]);
    for (const kind of TABLES) expect(describeDeciders(carrom, kind, drawn), kind).toEqual([]);
  });

  it("a bracket stage where NO declared decider can apply says nothing - 'level matches wait' is claimed only over deciders the stage could have played", () => {
    const tableOnly = Object.fromEntries(
      Object.entries(football.ruleKeys!).map(([k, f]) => [k, f.decider === true ? { ...f, appliesTo: { stageKinds: ["league"] } } : f]),
    );
    const fake = { ...football, ruleKeys: tableOnly } as unknown as AnySportModule;
    expect(deciderKeysFor(fake, "knockout", null), "premise: nothing applies to a knockout").toEqual([]);
    expect(deciderKeysFor(fake, null, null).length, "premise: but deciders are declared").toBeGreaterThan(0);
    expect(describeDeciders(fake, "knockout", divisionCfg(football, "11-a-side"))).toEqual([]);
  });

  it("an abandon policy the sport does not offer is not said, even where the schema let it through", () => {
    expect(football.abandonOptions).not.toContain("share");
    expect(describeAbandon(parsing(football, { abandonPolicy: "share" }), {})).toEqual([]);
    expect(describeAbandon(parsing(football, { abandonPolicy: 7 }), {})).toEqual([]);
    expect(describeAbandon(parsing(football, { abandonPolicy: "award" }), {})).toEqual([{ key: "format.rules.abandon.award" }]);
  });

  it("a knockout line is the format, then how a tie ends, THEN the abandon policy it changed", () => {
    const division = divisionCfg(football, "11-a-side");
    const line = effectiveRulesLine("football", football, { ...postedStageCfg(football, division, "knockout", "11-a-side") as object, abandonPolicy: "award" }, division, "knockout");
    expect(line!.map((c) => c.key)).toEqual([
      "format.rules.period.halves",
      "format.rules.decider.extraTime",
      "format.rules.decider.penalties",
      "format.rules.abandon.award",
    ]);
  });

  it("cricket: a limited-overs format of more than one innings says both the overs and the innings", () => {
    const c = { ...divisionCfg(cricket, "t20"), inningsPerSide: 2 };
    expect(text(describeMatchRules("cricket", cricket, c))).toBe("20 overs a side, 2 innings a side, max 4 overs a bowler");
  });

  it("chess: the clock is minutes to two places, and a time-control family the module does not declare is not claimed", () => {
    const base = divisionCfg(chess, "classical");
    expect(text(describeMatchRules("boardgame", chess, { ...base, clock: { base: 100 } }))).toBe("Classical time control, 1.67 min each");
    expect(text(describeMatchRules("boardgame", parsing(chess, { variant: "bullet", clock: { base: 600 } }), {}))).toBe("10 min each");
    expect(describeMatchRules("boardgame", parsing(chess, { variant: "bullet" }), {}), "no variant claimed, no clock set: nothing to say").toBeNull();
  });

  it("carrom: a best-of-1 is one game, and a number the config lacks is simply not said", () => {
    const carrom = mod("carrom");
    expect(text(describeMatchRules("carrom", carrom, { ...divisionCfg(carrom, "icf"), bestOf: 1 }))).toBe("1 game, to 25 points, up to 8 boards");
    expect(text(describeMatchRules("carrom", parsing(carrom, { gameTo: 25 }), {}))).toBe("To 25 points");
    expect(describeMatchRules("carrom", parsing(carrom, {}), {})).toBeNull();
  });

  it("a result mode nobody names says nothing; a period sport with no length says nothing; a cricket with no innings says nothing", () => {
    expect(describeMatchRules("generic", parsing(mod("generic"), { resultMode: "mystery", allowDraws: true }), {})).toBeNull();
    expect(describeMatchRules("football", parsing(football, { halves: 2 }), {})).toBeNull();
    expect(describeMatchRules("football", parsing(football, { halfMinutes: 45 }), {})).toBeNull();
    expect(describeMatchRules("cricket", parsing(cricket, { ballsPerOver: 6 }), {})).toBeNull();
  });

  it("a legacy module (no ruleKeys at all) still falls back to the config's shape; one that declares keys no family reads does not", () => {
    const legacy = (data: Record<string, unknown>) => ({ configSchema: { safeParse: () => ({ success: true, data }) } }) as unknown as AnySportModule;
    expect(describeMatchRules("badminton", legacy({ bestOf: 1, setTo: 15 }), {})).toEqual([{ key: "format.rules.oneGamePoints", params: { points: 15 } }]);
    expect(describeMatchRules("tennis", legacy({ bestOf: 3, set: { gamesTo: 6, tiebreakAt: 6 } }), {})![0]!.key).toBe("format.rules.tennis.bestOfSets");
    expect(describeMatchRules("badminton", { ...legacy({ bestOf: 1, setTo: 15 }), ruleKeys: { sparkle: { scope: "match" } } } as unknown as AnySportModule, {})).toBeNull();
  });

  it("rulesDifferFromDivision: a module without declarations compares the web's own rule-key list; no module compares them raw", () => {
    const legacy = { configSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) } } as unknown as AnySportModule;
    expect(rulesDifferFromDivision("badminton", legacy, { bestOf: 1, setTo: 15 }, { bestOf: 3, setTo: 15 })).toBe(true);
    expect(rulesDifferFromDivision("badminton", legacy, { bestOf: 3, setTo: 15, points: 1 }, { bestOf: 3, setTo: 15, points: 2 })).toBe(false);
    expect(rulesDifferFromDivision("badminton", null, { bestOf: 1 }, { bestOf: 3 })).toBe(true);
    expect(rulesDifferFromDivision("badminton", null, { bestOf: 3 }, { bestOf: 3 })).toBe(false);
  });

  it("effectiveRulesLine: the abandon policy of a stage over a division whose own config was refused is still said (it differs from nothing)", () => {
    const division = divisionCfg(football, "11-a-side");
    const line = effectiveRulesLine("football", football, { ...division, halfMinutes: 40, abandonPolicy: "award" }, { halfMinutes: -1 }, "league");
    expect(line!.map((c) => c.key)).toEqual(["format.rules.period.halves", "format.rules.abandon.award"]);
  });
});
