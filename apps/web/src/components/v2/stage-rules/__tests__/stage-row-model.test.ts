// W2c Task 17 (review I9) - the decisions the stage format row makes live in a pure helper with a unit killer, never in a
// browser. Expected values come from the engine's own declarations (`ruleKeys`, `bracketDeciders`, `canEndLevel`,
// `abandonOptions`, `configSchema`), never from a table typed here; every sweep reports how many items it checked.
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { BRACKET_KINDS, DRAW_KINDS, StageKind } from "@seazn/engine/core";
import { bracketMayEndLevel, deciderKeysFor, stageDefaultsFor, stageKeysFor, type AnySportModule } from "@seazn/engine/sport";
import { declaredCfgs } from "@seazn/engine/testkit";
import { SPORT_RULES } from "@/lib/match-rules";
import { DECIDER_DESCRIBED_KEYS, deciderIsOn, describeAbandon, describeDeciders, matchRulesLine } from "@/server/public-site/describe-rules";
import enPublic from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { rulesChipText } from "@/lib/rules-line";
import { decidersOffRules } from "@/lib/stage-decider-off";
import {
  abandonOptionStates,
  decidersAllOff,
  decidersMayEndLevel,
  deciderNotice,
  deciderOfDetail,
  detailIsInert,
  resolvedStageCfg,
  stageFieldsShown,
  stageSections,
  stageSummaryClauses,
} from "../stage-row-model";

const sport = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (!m) throw new Error(`no builtin module ${key}`);
  return m;
};
const football = sport("football");
const chess = sport("boardgame");
const BRACKETS = [...BRACKET_KINDS] as StageKind[];
const NOT_BRACKET = StageKind.options.filter((k) => !BRACKET_KINDS.has(k));

describe("stage row model (I9 killers for t17)", () => {
  it("football KO with both deciders off holds; one on does not; a league never shows the notice (empty case)", () => {
    expect(decidersAllOff(football, "knockout", { extraTime: { enabled: false, halfMinutes: 15 }, shootout: false })).toBe(true);
    expect(decidersAllOff(football, "knockout", { extraTime: { enabled: true, halfMinutes: 15 }, shootout: false })).toBe(false);
    expect(decidersAllOff(football, "league", { extraTime: { enabled: false, halfMinutes: 15 }, shootout: false })).toBe(false);
  });

  it("P-5: generic share is unavailable, with the reason, while draws are off; available when on; carrom only under the drawn-game house rule", () => {
    const generic = sport("generic");
    const carrom = sport("carrom");
    const share = (m: AnySportModule, v: Record<string, unknown>) => abandonOptionStates(m, v).find((o) => o.value === "share")!;
    expect(share(generic, { allowDraws: false })).toEqual({ value: "share", disabled: true, reasonKey: "stageRules.abandon.shareNeedsDraws" });
    expect(share(generic, { allowDraws: true }).disabled).toBe(false);
    // Carrom takes a draw only under tieBoard "draw"; every shipped variant defaults to "extra", so the bare cfg refuses
    // (the plan's `false` for `share(carrom, {})` was wrong: the engine refuses it, naming the tie-board setting).
    expect(share(carrom, {})).toEqual({ value: "share", disabled: true, reasonKey: "rules.err.shareNeedsDrawnGame" });
    expect(share(carrom, { tieBoard: "draw" })).toEqual({ value: "share", disabled: false, reasonKey: null });
  });

  // The brief's version of this case asserted that EVERY declared stage key is edited by a shown field. That is a false
  // premise: five stage keys have no curated field at all (below), so the case is split into what is true. First, each
  // sport's shown fields are exactly the curated fields whose every key the engine declares for the stage - recomputed
  // here from `ruleKeys` and the field table, not read back from `stageFieldsShown` - and then the keys no field edits are
  // pinned as a ratchet: the day one gains a field, this list shrinks on purpose.
  it("every sport shows its stage fields: exactly the curated fields the engine's stage keys allow (counted)", () => {
    let cells = 0;
    let fields = 0;
    for (const m of builtinModules)
      for (const kind of ["league", ...BRACKET_KINDS] as const) {
        const allowed = new Set(stageKeysFor(m, kind, null));
        const expected = (SPORT_RULES[m.key] ?? []).filter((f) => f.edits.length > 0 && f.edits.every((e) => allowed.has(e))).map((f) => f.key);
        const shown = stageFieldsShown(m, kind, null).map((f) => f.key);
        expect(shown, `${m.key}/${kind}`).toEqual(expected);
        cells++;
        fields += shown.length;
      }
    expect(cells).toBe(builtinModules.length * (1 + BRACKET_KINDS.size));
    expect(fields).toBeGreaterThan(builtinModules.length * 2);
    // Every sport offers at least one stage field in at least one stage kind, so no sport is a silent blank row.
    for (const m of builtinModules)
      expect(["league", ...BRACKET_KINDS].some((k) => stageFieldsShown(m, k as StageKind, null).length > 0), m.key).toBe(true);
  });

  it("the stage keys no curated field edits are exactly the five known gaps (a ratchet: it shrinks when a field is added)", () => {
    const uncurated = new Set<string>();
    let keys = 0;
    for (const m of builtinModules)
      for (const kind of ["league", ...BRACKET_KINDS] as const)
        for (const key of stageKeysFor(m, kind, null)) {
          keys++;
          const top = key.split(".")[0];
          if (!stageFieldsShown(m, kind, null).some((f) => f.edits.some((e) => e.split(".")[0] === top))) uncurated.add(`${m.key}:${key}`);
        }
    expect(keys).toBeGreaterThan(300);
    expect([...uncurated].sort()).toEqual([
      "carrom:pointsPerCoin", "cricket:minOversForResult", "cricket:superOverStillTied", "football:concussionSubs", "football:rollingSubs",
    ]);
  });
});

describe("the deciders notice reads the RESOLVED cfg (carry G1) and treats chess's list as off ONLY when it is empty (carry 13b)", () => {
  const chessDivision = chess.configSchema.parse(chess.variants.classical ?? Object.values(chess.variants)[0]) as Record<string, unknown>;
  const resolved = (rules: Record<string, unknown>) => resolvedStageCfg(chess, chessDivision, "knockout", rules)!;

  it("a chess knockout stage with its list empty is held; absent, one rung or all three is not", () => {
    expect(resolved({ tiebreakRungs: [] })).not.toBeNull();
    expect(decidersAllOff(chess, "knockout", resolved({ tiebreakRungs: [] })), "[] is off").toBe(true);
    expect(decidersAllOff(chess, "knockout", resolved({})), "absent plays every rung").toBe(false);
    expect(decidersAllOff(chess, "knockout", resolved({ tiebreakRungs: ["rapid"] })), "one rung").toBe(false);
    expect(decidersAllOff(chess, "knockout", resolved({ tiebreakRungs: ["rapid", "blitz", "armageddon"] })), "every rung").toBe(false);
    // Not by truthiness: `[]` is truthy and absent is falsy, and both answers above are the opposite of a `!v` read.
    expect(Boolean([])).toBe(true);
    expect(decidersAllOff(chess, "league", resolved({ tiebreakRungs: [] })), "a table stage never shows it").toBe(false);
  });

  it("the RAW division cfg is not the resolved one: chess's bracket overlay turns its tie-break on (G1)", () => {
    // The unresolved read: the division has tie-breaks off, and a notice reading `stage.rules` + division alone would say
    // so. The resolved cfg (after `bracketDeciders`) plays them, so a stage with the DEFAULT list is not held.
    const raw = { ...chessDivision, tiebreak: false } as Record<string, unknown>;
    expect(decidersAllOff(chess, "knockout", resolvedStageCfg(chess, raw, "knockout", {})!)).toBe(false);
    expect(chess.bracketDeciders(raw as never)).toMatchObject({ tiebreak: true });
  });

  it("resolvedStageCfg refuses a cfg the schema refuses, so a half-typed edit shows no notice", () => {
    expect(resolvedStageCfg(chess, chessDivision, "knockout", { tiebreakRungs: ["no-such-rung"] })).toBeNull();
  });
});

describe("the bracket overlay reaches the notice by BOTH routes, each alone (carry G1)", () => {
  const carrom = sport("carrom");
  const drawnDivision = (): Record<string, unknown> =>
    carrom.configSchema.parse({ ...Object.values(carrom.variants)[0], tieBoard: "draw", abandonPolicy: "share" }) as Record<string, unknown>;

  it("the resolved cfg IS the cfg the bracket plays: the sport's overlay is laid over the division's (every sport that has one, counted)", () => {
    let checked = 0;
    let differs = 0;
    for (const m of builtinModules) {
      if (typeof m.bracketDeciders !== "function") continue;
      for (const { cfg } of declaredCfgs(m)) {
        const parsed = m.configSchema.parse(cfg) as Record<string, unknown>;
        const resolved = resolvedStageCfg(m, parsed, "knockout", null)!;
        const overlay = m.bracketDeciders(parsed as never) as Record<string, unknown>;
        expect(resolved, `${m.key}`).toMatchObject(overlay);
        if (Object.entries(overlay).some(([k, v]) => JSON.stringify(parsed[k]) !== JSON.stringify(v))) differs++;
        checked++;
      }
    }
    expect(checked, "sports with an overlay were walked").toBeGreaterThan(0);
    expect(differs, "and at least one cfg where the overlay CHANGES the division's value (else the sweep proves nothing)").toBeGreaterThan(0);
    // The witness: a drawn-game carrom division plays the extra board in a bracket.
    expect(resolvedStageCfg(carrom, drawnDivision(), "knockout", null)!.tieBoard).toBe("extra");
    expect(resolvedStageCfg(carrom, drawnDivision(), "league", null)!.tieBoard, "a table stage keeps the division's").toBe("draw");
  });

  it("the notice's own read lays the overlay too: the RAW drawn-game carrom cfg answers as the resolved one, in every bracket kind", () => {
    let checked = 0;
    for (const kind of BRACKETS) {
      const raw = drawnDivision();
      const resolved = resolvedStageCfg(carrom, raw, kind, null)!;
      expect(decidersAllOff(carrom, kind, raw), `${kind} raw`).toBe(false);
      expect(decidersAllOff(carrom, kind, raw), `${kind}: raw = resolved`).toBe(decidersAllOff(carrom, kind, resolved));
      expect(deciderNotice(carrom, kind, raw), `${kind}`).toBe(deciderNotice(carrom, kind, resolved));
      checked++;
    }
    expect(checked).toBe(BRACKETS.length);
  });

  it("a decider the overlay forces ON counts even where its key is not declared for the kind: another applicable decider being off does not hold the match (a double)", () => {
    // football with `shootout` declared for table stages only, and an overlay that forces it on: in a knockout the only
    // DECLARED decider is extra time, which is off - but the overlay plays a shoot-out, so nothing is held.
    const ruleKeys = { ...football.ruleKeys, extraTime: { ...football.ruleKeys!.extraTime!, appliesTo: { stageKinds: ["knockout"] } }, shootout: { ...football.ruleKeys!.shootout!, appliesTo: { stageKinds: ["league"] } } };
    const forcing = { ...football, ruleKeys, bracketDeciders: () => ({ shootout: true }) } as unknown as AnySportModule;
    const quiet = { ...forcing, bracketDeciders: () => ({}) } as unknown as AnySportModule;
    expect(deciderKeysFor(forcing, "knockout", null), "premise: only extra time is declared for a knockout").toEqual(["extraTime"]);
    expect(deciderKeysFor(forcing, null, null), "premise: the shoot-out is declared, for tables").toContain("shootout");
    const allOff = { ...(football.configSchema.parse(football.variants["11-a-side"]) as Record<string, unknown>), shootout: false, extraTime: { enabled: false, halfMinutes: 15 } };
    expect(decidersAllOff(quiet, "knockout", allOff), "control: with no overlay the one declared decider is off, so the match is held").toBe(true);
    expect(decidersAllOff(forcing, "knockout", allOff), "the forced shoot-out is a decider the stage plays").toBe(false);
  });
});

describe("deciderNotice names its mode (football knockout, from the engine's declarations)", () => {
  const division = football.configSchema.parse(football.variants["11-a-side"]) as Record<string, unknown>;
  const withRules = (rules: Record<string, unknown>) => resolvedStageCfg(football, division, "knockout", rules)!;
  const OFF = { enabled: false, halfMinutes: 15 };
  const ON = { enabled: true, halfMinutes: 15 };

  it("every decider off -> 'off'; extra time alone -> 'level'; a shoot-out -> none; a league -> none (each mode and the empty case)", () => {
    expect(deciderNotice(football, "knockout", withRules({ shootout: false, extraTime: OFF }))).toBe("off");
    expect(deciderNotice(football, "knockout", withRules({ shootout: false, extraTime: ON }))).toBe("level");
    expect(deciderNotice(football, "knockout", withRules({ shootout: true, extraTime: OFF }))).toBeNull();
    expect(deciderNotice(football, "knockout", withRules({ shootout: true, extraTime: ON }))).toBeNull();
    expect(deciderNotice(football, "league", resolvedStageCfg(football, division, "league", { shootout: false, extraTime: OFF })!)).toBeNull();
  });
});

describe("which knockout setups leave a level match behind a decider - the RULEBOOKS' answer, not the declaration's (M-6)", () => {
  // Each row is a setup and the notice the rulebook gives it: a decider that cannot end level (a shoot-out is sudden death,
  // every chess tie-break game names a winner, carrom's extra board is played to a result) leaves nothing to hold; extra time, an
  // overtime and a super over whose tie stands can all end level (their own proof is the engine folds in `can-end-level.test.ts`); no decider
  // at all holds every level match. The setups are built from the engine's own stage defaults and `decidersOffRules`.
  const rows: { sport: string; name: string; rules: (m: AnySportModule) => Record<string, unknown>; expected: "off" | "level" | null }[] = [
    { sport: "football", name: "extra time alone", rules: (m) => ({ ...stageDefaultsFor(m, "knockout", "11-a-side"), shootout: false }), expected: "level" },
    { sport: "football", name: "penalties alone", rules: (m) => ({ ...stageDefaultsFor(m, "knockout", "11-a-side"), extraTime: { enabled: false, halfMinutes: 15 } }), expected: null },
    { sport: "football", name: "extra time then penalties", rules: (m) => stageDefaultsFor(m, "knockout", "11-a-side"), expected: null },
    { sport: "football", name: "no decider", rules: (m) => decidersOffRules(m, "11-a-side", "knockout"), expected: "off" },
    { sport: "icehockey", name: "overtime alone", rules: (m) => ({ ...stageDefaultsFor(m, "knockout", "iihf"), shootout: false }), expected: "level" },
    { sport: "icehockey", name: "overtime then shoot-out", rules: (m) => stageDefaultsFor(m, "knockout", "iihf"), expected: null },
    { sport: "icehockey", name: "shoot-out alone", rules: (m) => ({ ...stageDefaultsFor(m, "knockout", "iihf"), overtime: false }), expected: null },
    { sport: "icehockey", name: "no decider", rules: (m) => decidersOffRules(m, "iihf", "knockout"), expected: "off" },
    { sport: "hockey", name: "shoot-out", rules: (m) => stageDefaultsFor(m, "knockout", "fih-outdoor"), expected: null },
    { sport: "hockey", name: "no decider", rules: (m) => decidersOffRules(m, "fih-outdoor", "knockout"), expected: "off" },
    { sport: "cricket", name: "a super over repeated until decided (the default)", rules: (m) => stageDefaultsFor(m, "knockout", "t20"), expected: null },
    { sport: "cricket", name: "a super over whose tie stands (shared)", rules: (m) => ({ ...stageDefaultsFor(m, "knockout", "t20"), superOverStillTied: "shared" }), expected: "level" },
    { sport: "cricket", name: "a super over decided on boundaries, equal boundaries tie", rules: (m) => ({ ...stageDefaultsFor(m, "knockout", "t20"), superOverStillTied: "boundary_count" }), expected: "level" },
    { sport: "cricket", name: "no super over", rules: (m) => decidersOffRules(m, "t20", "knockout"), expected: "off" },
    { sport: "carrom", name: "the extra board its bracket forces", rules: () => ({}), expected: null },
    { sport: "boardgame", name: "an empty rung list", rules: () => ({ tiebreakRungs: [] }), expected: "off" },
    { sport: "boardgame", name: "armageddon last (always a winner)", rules: () => ({ tiebreakRungs: ["rapid", "armageddon"] }), expected: null },
    // BG-KO-3: every tie-break event names a winner, so a list of ONE game of any kind settles the match.
    { sport: "boardgame", name: "a rapid game alone (its result names a winner)", rules: () => ({ tiebreakRungs: ["rapid"] }), expected: null },
  ];

  it("each setup gets the notice the rulebook gives it (counted; every mode appears)", () => {
    const seen = new Set<string>();
    for (const row of rows) {
      const m = sport(row.sport);
      const variant = Object.keys(m.variants)[0]!;
      const division = m.configSchema.parse(m.variants[variant]) as Record<string, unknown>;
      const cfg = resolvedStageCfg(m, division, "knockout", row.rules(m));
      expect(cfg, `${row.sport}: ${row.name} resolves`).not.toBeNull();
      expect(deciderNotice(m, "knockout", cfg!), `${row.sport}: ${row.name}`).toBe(row.expected);
      seen.add(String(row.expected));
    }
    expect(seen, "off, level and none each occur").toEqual(new Set(["off", "level", "null"]));
    expect(rows.length).toBe(18);
  });
});

describe("a detail of a decider is held while its decider is off - the pairing is the engine's `detailOf` (M-4)", () => {
  // The rulebook's pairs (the same table the engine's sweep pins): field key -> the decider it only means something under.
  const PAIRS: Record<string, Record<string, string>> = {
    football: { shootoutAttempts: "shootout" },
    hockey: { shootoutAttempts: "shootout" },
    icehockey: { overtimeMinutes: "overtime", shootoutAttempts: "shootout" },
  };

  it("exactly the rulebook's fields are details, every other field of every sport is not (counted)", () => {
    let details = 0;
    let others = 0;
    for (const m of builtinModules)
      for (const f of SPORT_RULES[m.key] ?? []) {
        const expected = PAIRS[m.key]?.[f.key] ?? null;
        expect(deciderOfDetail(m, f), `${m.key}.${f.key}`).toBe(expected);
        if (expected === null) others++;
        else details++;
      }
    expect(details).toBe(Object.values(PAIRS).reduce((n, p) => n + Object.keys(p).length, 0));
    expect(others, "the rest of the field tables were walked").toBeGreaterThan(details);
  });

  it("football: the kicks are held while the shoot-out is off, and free while it is on (positive pair)", () => {
    const kicks = SPORT_RULES.football!.find((f) => f.key === "shootoutAttempts")!;
    const division = football.configSchema.parse(football.variants["11-a-side"]) as Record<string, unknown>;
    const at = (rules: Record<string, unknown>) => resolvedStageCfg(football, division, "knockout", rules);
    expect(detailIsInert(football, kicks, at({ shootout: false }))).toBe(true);
    expect(detailIsInert(football, kicks, at({ shootout: true }))).toBe(false);
  });

  it("the period sports: switching the shoot-out (or the overtime) off holds its length; a switch itself is never held (positive pairs)", () => {
    for (const [key, variant, detail, decider] of [
      ["hockey", "fih-outdoor", "shootoutAttempts", "shootout"],
      ["icehockey", "iihf", "shootoutAttempts", "shootout"],
      ["icehockey", "iihf", "overtimeMinutes", "overtime"],
    ] as const) {
      const m = sport(key);
      const division = m.configSchema.parse(m.variants[variant]) as Record<string, unknown>;
      const field = SPORT_RULES[key]!.find((f) => f.key === detail)!;
      const preset = stageDefaultsFor(m, "knockout", variant);
      const on = resolvedStageCfg(m, division, "knockout", preset);
      const off = resolvedStageCfg(m, division, "knockout", { ...preset, [decider]: false });
      expect(detailIsInert(m, field, off), `${key}.${detail} with ${decider} off`).toBe(true);
      expect(detailIsInert(m, field, on), `${key}.${detail} with ${decider} on`).toBe(false);
      const switchField = SPORT_RULES[key]!.find((f) => f.key === decider)!;
      expect(detailIsInert(m, switchField, off), `${key}.${decider} is the switch, not a detail`).toBe(false);
    }
  });

  it("a field editing several keys is a detail only when EVERY key names the same decider (the guards are reached)", () => {
    // No shipped field edits two paired keys, so the rule is pinned on a module built to declare them: a, b -> the shoot-out,
    // c -> extra time, plain -> no pairing.
    const fact = (detailOf?: string) => ({ scope: "match", matchBound: "shorter", ...(detailOf === undefined ? {} : { detailOf }) });
    const mod = { ...football, ruleKeys: { ...football.ruleKeys, a: fact("shootout"), b: fact("shootout"), c: fact("extraTime"), plain: fact() } } as unknown as AnySportModule;
    const field = (edits: string[]) => ({ key: "x", edits, label: "x", help: "", kind: "number", build: () => ({}), read: () => undefined }) as unknown as (typeof SPORT_RULES)[string][number];
    expect(deciderOfDetail(mod, field(["a", "b"])), "both name the shoot-out").toBe("shootout");
    expect(deciderOfDetail(mod, field(["a", "c"])), "two different deciders").toBeNull();
    expect(deciderOfDetail(mod, field(["c", "a"])), "...whichever comes first").toBeNull();
    expect(deciderOfDetail(mod, field(["a", "plain"])), "one key with no pairing").toBeNull();
    expect(deciderOfDetail(mod, field(["plain", "a"])), "...in either order").toBeNull();
    expect(deciderOfDetail(mod, field(["notDeclaredAtAll"])), "a key the module does not declare").toBeNull();
    expect(deciderOfDetail(mod, field([])), "a field that edits nothing").toBeNull();
  });

  it("a cfg the schema refuses holds nothing, and a module that declares no pairing holds nothing", () => {
    const kicks = SPORT_RULES.football!.find((f) => f.key === "shootoutAttempts")!;
    expect(detailIsInert(football, kicks, null)).toBe(false);
    const bare = { ...football, ruleKeys: { ...football.ruleKeys, shootoutAttempts: { scope: "match", matchBound: "shorter" } } } as unknown as AnySportModule;
    expect(deciderOfDetail(bare, kicks), "premise: no detailOf, no pairing").toBeNull();
    expect(detailIsInert(bare, kicks, { shootout: false })).toBe(false);
  });
});

describe("the collapsed row's chips: the stage's EFFECTIVE format in the public line's own words (I-1)", () => {
  const dict = enPublic as Dict;
  const division = football.configSchema.parse(football.variants["11-a-side"]) as Record<string, unknown>;
  const chipsFor = (rules: Record<string, unknown>, kind: StageKind = "knockout") =>
    stageSummaryClauses("football", football, kind, resolvedStageCfg(football, division, kind, rules));

  it("a stage override that differs from the division shows the override, and the inherited stage shows the division's", () => {
    const divisionMinutes = (division.extraTime as { halfMinutes: number }).halfMinutes;
    const stageMinutes = divisionMinutes + 5;
    expect(chipsFor({ extraTime: { enabled: true, halfMinutes: stageMinutes } }), "override").toContainEqual({ key: "format.rules.decider.extraTime", params: { n: stageMinutes } });
    expect(chipsFor({ extraTime: { enabled: true, halfMinutes: stageMinutes } }), "the division's number is not said").not.toContainEqual({ key: "format.rules.decider.extraTime", params: { n: divisionMinutes } });
    expect(chipsFor({ extraTime: { enabled: true, halfMinutes: divisionMinutes } }), "inherited").toContainEqual({ key: "format.rules.decider.extraTime", params: { n: divisionMinutes } });
    // A half length override reaches the format chip; kicks reach the penalties chip.
    expect(chipsFor({ halfMinutes: 30 })).toContainEqual({ key: "format.rules.period.halves", params: { minutes: 30 } });
    expect(chipsFor({ shootout: true, shootoutAttempts: 3 })).toContainEqual({ key: "format.rules.decider.penalties", params: { n: 3 } });
  });

  it("the abandon policy is always said, in the stage's own value", () => {
    expect(chipsFor({})).toContainEqual({ key: "format.rules.abandon.replay" });
    expect(chipsFor({ abandonPolicy: "award" })).toContainEqual({ key: "format.rules.abandon.award" });
    expect(chipsFor({ abandonPolicy: "award" })).not.toContainEqual({ key: "format.rules.abandon.replay" });
  });

  it("a decider that is off is not a chip, and a refused cfg says nothing (empty case)", () => {
    const off = chipsFor({ extraTime: { enabled: false, halfMinutes: 15 }, shootout: false });
    expect(off.some((c) => c.key === "format.rules.decider.extraTime" || c.key === "format.rules.decider.penalties")).toBe(false);
    expect(off, "a bracket stage with no decider says so, as the public line does").toContainEqual({ key: "format.rules.decider.none" });
    expect(stageSummaryClauses("football", football, "knockout", null)).toEqual([]);
  });

  it("over every sport, declared cfg and stage kind: it is the public line plus the abandon clause, and every clause has words (counted)", () => {
    let checked = 0;
    let withChips = 0;
    const sportsWithChips = new Set<string>();
    for (const m of builtinModules)
      for (const { cfg } of declaredCfgs(m))
        for (const kind of ["league", "knockout"] as StageKind[]) {
          const resolved = resolvedStageCfg(m, cfg as Record<string, unknown>, kind, {});
          expect(resolved, `${m.key}/${kind}`).not.toBeNull();
          const chips = stageSummaryClauses(m.key, m, kind, resolved);
          // The public composer, given a division that plays the same abandon policy, says everything but the abandon clause.
          const expected = [...(matchRulesLine(m.key, m, resolved, resolved, kind) ?? []), ...describeAbandon(m, resolved)];
          expect(chips, `${m.key}/${kind}`).toEqual(expected);
          for (const c of chips) {
            expect(c.key.startsWith("format.rules."), `${m.key}: ${c.key}`).toBe(true);
            const text = rulesChipText(dict, c);
            expect(text, `${m.key}: ${c.key} has words in the public dictionary`).not.toBe(c.key);
            expect(text.charAt(0), `${m.key}: a chip is capitalised`).toBe(text.charAt(0).toUpperCase());
          }
          if (chips.length > 0) {
            withChips++;
            sportsWithChips.add(m.key);
          }
          checked++;
        }
    expect(checked).toBe(builtinModules.reduce((n, m) => n + declaredCfgs(m).length * 2, 0));
    expect(withChips).toBeGreaterThan(0);
    expect([...sportsWithChips].sort(), "every sport has a stage kind that says something").toEqual(builtinModules.map((m) => m.key).sort());
  });
});

describe("the notice and the public line agree, and the engine's declaration says when a level match can remain (M-3)", () => {
  it("over every declared cfg, bracket kind and the every-decider-off setup: allOff <=> the public line says none; level <=> the engine says so (counted)", () => {
    let checked = 0;
    let allOff = 0;
    let level = 0;
    for (const m of builtinModules) {
      if (deciderKeysFor(m, null, null).length === 0) continue;
      const setups: { name: string; division: Record<string, unknown>; rules: Record<string, unknown> }[] = [];
      for (const { name, cfg } of declaredCfgs(m)) {
        setups.push({ name: `${name}`, division: cfg as Record<string, unknown>, rules: {} });
        const variant = Object.hasOwn(m.variants, name) ? name : Object.keys(m.variants)[0]!;
        for (const kind of BRACKETS) {
          setups.push({ name: `${name} / all off (${kind})`, division: cfg as Record<string, unknown>, rules: decidersOffRules(m, variant, kind) });
          // The knockout preset (every decider on, the engine's own `stageDefaults`), and the preset with ONE decider
          // switched off at a time, each off value the engine's (`decidersOffRules`): the setups where one decider is
          // left and a level match may or may not remain behind it.
          const preset = stageDefaultsFor(m, kind, variant);
          setups.push({ name: `${name} / preset (${kind})`, division: cfg as Record<string, unknown>, rules: preset });
          const off = decidersOffRules(m, variant, kind);
          for (const key of deciderKeysFor(m, kind, variant))
            setups.push({ name: `${name} / preset without ${key} (${kind})`, division: cfg as Record<string, unknown>, rules: { ...preset, [key]: off[key] } });
        }
      }
      for (const { name, division, rules } of setups) {
        for (const kind of BRACKETS) {
          const cfg = resolvedStageCfg(m, division, kind, rules);
          if (cfg === null) continue;
          const off = decidersAllOff(m, kind, cfg);
          const says = describeDeciders(m, kind, cfg).some((c) => c.key === "format.rules.decider.none");
          expect(off, `${m.key} ${name} ${kind}: the notice and the public line disagree on "no decider"`).toBe(says);
          const may = decidersMayEndLevel(m, kind, cfg);
          // The engine's own declaration is the oracle, read DIRECTLY (not through `bracketMayEndLevel`, which is what the
          // notice calls): the sport's `canEndLevel` over the cfg with its bracket overlay laid on. A level match remains
          // exactly when a decider is on and the declaration says one can.
          const forced = typeof m.bracketDeciders === "function" ? (m.bracketDeciders(cfg as never) as Record<string, unknown>) : {};
          const declared = m.canEndLevel === undefined ? false : m.canEndLevel({ ...cfg, ...forced } as never);
          expect(may, `${m.key} ${name} ${kind}`).toBe(!off && declared);
          // Whatever the notice calls "off", the engine must agree a level match can then stand.
          if (off) expect(bracketMayEndLevel(m, kind, cfg), `${m.key} ${name} ${kind}: held, but the engine says it cannot end level`).toBe(true);
          expect(deciderNotice(m, kind, cfg)).toBe(off ? "off" : may ? "level" : null);
          if (off) allOff++;
          if (may) level++;
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(builtinModules.length);
    expect(allOff, "some setup is held").toBeGreaterThan(0);
    expect(level, "some setup leaves a level match behind a decider").toBeGreaterThan(0);
  });

  it("football: extra time alone can still end level; penalties cannot; extra time then penalties cannot", () => {
    const base = football.configSchema.parse(football.variants["11-a-side"] ?? Object.values(football.variants)[0]) as Record<string, unknown>;
    const notice = (rules: Record<string, unknown>) => deciderNotice(football, "knockout", resolvedStageCfg(football, base, "knockout", rules)!);
    expect(notice({ extraTime: { enabled: true, halfMinutes: 15 }, shootout: false })).toBe("level");
    expect(notice({ extraTime: { enabled: false, halfMinutes: 15 }, shootout: true })).toBeNull();
    expect(notice({ extraTime: { enabled: true, halfMinutes: 15 }, shootout: true })).toBeNull();
    expect(notice({ extraTime: { enabled: false, halfMinutes: 15 }, shootout: false })).toBe("off");
  });

  it("a table stage and a sport with no decider say nothing, whatever the cfg (empty case)", () => {
    let checked = 0;
    for (const m of builtinModules)
      for (const { cfg } of declaredCfgs(m))
        for (const kind of [...NOT_BRACKET, ...DRAW_KINDS]) {
          expect(deciderNotice(m, kind as StageKind, cfg as Record<string, unknown>), `${m.key}/${kind}`).toBeNull();
          checked++;
        }
    expect(checked).toBeGreaterThan(builtinModules.length);
    const badminton = sport("badminton");
    expect(deciderNotice(badminton, "knockout", badminton.configSchema.parse(Object.values(badminton.variants)[0]) as Record<string, unknown>)).toBeNull();
  });
});

describe("deciderIsOn - the one on/off table the notice and the public line share", () => {
  it("an undeclared decider is never read as off, and a known one follows its own cfg (positive pair, counted)", () => {
    // The guard under test: a decider no describer knows may be what settles a match, so it is never "off".
    expect(DECIDER_DESCRIBED_KEYS, "premise: the describer table knows some deciders").not.toContain("someFutureDecider");
    expect(deciderIsOn(football, "someFutureDecider", {})).toBe(true);
    // The positive pair: the keys it DOES know are on or off by their cfg.
    const parsed = (m: AnySportModule, over: Record<string, unknown>) => m.configSchema.parse({ ...Object.values(m.variants)[0], ...over }) as Record<string, unknown>;
    expect(deciderIsOn(football, "shootout", parsed(football, { shootout: false }))).toBe(false);
    expect(deciderIsOn(football, "shootout", parsed(football, { shootout: true }))).toBe(true);
    expect(deciderIsOn(chess, "tiebreakRungs", parsed(chess, { tiebreakRungs: [] }))).toBe(false);
    expect(deciderIsOn(chess, "tiebreakRungs", parsed(chess, { tiebreakRungs: ["blitz"] }))).toBe(true);
    expect(DECIDER_DESCRIBED_KEYS.length, "the table has entries to be asked about").toBeGreaterThan(0);
  });
});

describe("abandonOptionStates (owner P-5)", () => {
  it("lists exactly the module's own abandon options, in its order, for every sport (counted)", () => {
    let checked = 0;
    for (const m of builtinModules) {
      const base = (declaredCfgs(m)[0]!.cfg ?? {}) as Record<string, unknown>;
      expect(abandonOptionStates(m, base).map((o) => o.value), m.key).toEqual(m.abandonOptions ?? []);
      checked++;
    }
    expect(checked).toBe(builtinModules.length);
  });

  it("only `share` is ever unavailable, and only with a reason; every other option is offered with none", () => {
    let unavailable = 0;
    for (const m of builtinModules)
      for (const { cfg } of declaredCfgs(m))
        for (const o of abandonOptionStates(m, cfg as Record<string, unknown>)) {
          if (o.disabled) {
            expect(o.value, m.key).toBe("share");
            expect(o.reasonKey, m.key).not.toBeNull();
            unavailable++;
          } else expect(o.reasonKey, `${m.key}/${o.value}`).toBeNull();
        }
    expect(unavailable, "carrom's shipped variants refuse share").toBeGreaterThan(0);
  });
});

describe("the stage sections: every shown field is in exactly one section (counted)", () => {
  it("format, deciders and abandon partition the shown fields, and the abandon field is the abandon section's", () => {
    let fields = 0;
    let withDeciders = 0;
    let withAbandon = 0;
    for (const m of builtinModules)
      for (const kind of ["league", ...BRACKET_KINDS] as StageKind[]) {
        const shown = stageFieldsShown(m, kind, null);
        const sections = stageSections(m, kind, null);
        const placed = sections.flatMap((s) => s.fields.map((f) => f.key));
        expect(placed.sort(), `${m.key}/${kind}`).toEqual(shown.map((f) => f.key).sort());
        for (const s of sections) expect(s.fields.length, `${m.key}/${kind}/${s.id} is empty`).toBeGreaterThan(0);
        for (const f of sections.find((s) => s.id === "abandon")?.fields ?? []) expect(f.edits[0]!.split(".")[0]).toBe("abandonPolicy");
        // The other direction, from the engine's declaration: a shown field that edits `abandonPolicy` IS in the abandon
        // section (the loop above is empty if the section is missing, so it cannot say that on its own).
        for (const f of shown.filter((x) => x.edits.some((e) => e.split(".")[0] === "abandonPolicy"))) {
          expect(sections.find((s) => s.fields.includes(f))?.id, `${m.key}/${kind}: ${f.key}`).toBe("abandon");
          withAbandon++;
        }
        const decidersTop = new Set(deciderKeysFor(m, kind, null));
        for (const f of sections.find((s) => s.id === "deciders")?.fields ?? []) {
          // A deciders field edits a decider key, or a bounded detail of one (`matchBound`: the kicks of a shoot-out).
          const tops = f.edits.map((e) => e.split(".")[0]!);
          expect(tops.every((t) => decidersTop.has(t) || m.ruleKeys?.[t]?.matchBound !== undefined), `${m.key}/${kind}: ${f.key}`).toBe(true);
          withDeciders++;
        }
        fields += shown.length;
      }
    expect(fields).toBeGreaterThan(builtinModules.length);
    expect(withDeciders, "some bracket stage has deciders to show").toBeGreaterThan(0);
    expect(withAbandon, "some stage has an abandon field to place").toBeGreaterThan(0);
  });

  it("football knockout: the kicks of a shoot-out sit WITH the deciders, the half length with the match format, the abandon policy by itself (the placement ruling)", () => {
    const sections = stageSections(football, "knockout", null);
    const tops = (id: string) => (sections.find((s) => s.id === id)?.fields ?? []).flatMap((f) => f.edits.map((e) => e.split(".")[0]!));
    expect(sections.map((s) => s.id), "the order the row shows them in").toEqual(["format", "deciders", "abandon"]);
    expect(tops("deciders").sort()).toEqual(["extraTime", "shootout", "shootoutAttempts"]);
    expect(tops("abandon")).toEqual(["abandonPolicy"]);
    expect(tops("format")).toContain("halfMinutes");
    expect(tops("format")).not.toContain("shootoutAttempts");
  });
});
