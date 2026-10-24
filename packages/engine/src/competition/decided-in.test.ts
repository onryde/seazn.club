// W2d Task 1 — `decidedIn` and the outcome vocabulary per sport (SPEC §5.2, D4, B2, D6, D10(c); §13.4).
// X-PT-2. Expected values come from SPEC §5.2's mapping text and from each module's own declarations (its variants, its
// configSchema, `supportsDraws`, `stageDefaults`, `bracketDeciders`, the boardgame result schema, `TIEBREAK_RUNGS`,
// the kernel's `SETTLE_METHODS`) and from the golden corpora's recorded folds — never from `decidedInFor` or from the
// declaration under test.
import { describe, expect, it } from "vitest";
import { SETTLE_METHODS, settledMethod } from "../core/events.ts";
import { BRACKET_KINDS, DRAW_KINDS, MatchOutcome, OUTCOME_KINDS, StageKind } from "../core/types.ts";
import { FOLD_EPOCH } from "../sport/fold-epoch.ts";
import type { AnySportModule } from "../sport/module.ts";
import { BoardgameMethod, BoardgameResult, TIEBREAK_RUNGS, boardgame } from "../sports/boardgame/boardgame.ts";
import { carrom } from "../sports/carrom/carrom.ts";
import { cricket } from "../sports/cricket/cricket.ts";
import { football } from "../sports/football/football.ts";
import { hockey } from "../sports/hockey/hockey.ts";
import { icehockey } from "../sports/icehockey/icehockey.ts";
import { tabletennis } from "../sports/setbased/tabletennis.ts";
import { volleyball } from "../sports/setbased/volleyball.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { readCorpus } from "../testkit/golden.ts";
// The barrel, not the file: Tasks 2-6 import these names from `@seazn/engine/competition`.
import { DECIDED_IN, decidedInFor, type DecidedIn } from "./index.ts";

type C = Record<string, unknown>;
const SPORTS = Object.keys(FOLD_EPOCH).length; // the independent count of registered sports (PS-9g)
const sorted = (s: ReadonlySet<string>): string[] => [...s].sort();
const win = (method?: string): MatchOutcome =>
  MatchOutcome.parse({ kind: "win", winner: "H", loser: "A", ...(method === undefined ? {} : { method }) });
const cfgOf = (m: AnySportModule, variant: string): C => {
  const raw = m.variants[variant];
  if (raw === undefined) throw new Error(`${m.key} declares no variant "${variant}"`);
  return m.configSchema.parse(raw) as C;
};

// Every outcome kind except `win`, parsed through the engine's own schema so each is a shape a ledger can hold.
const NON_WINS: readonly MatchOutcome[] = [
  { kind: "draw" },
  { kind: "tie" },
  { kind: "no_result" },
  { kind: "award", winner: "H", loser: "A", reason: "walkover" },
  { kind: "award", winner: "H", loser: null, reason: "bye" },
  { kind: "double_walkover" },
].map((o) => MatchOutcome.parse(o));

// Decider switches the stage editor offers (each a `decider: true` rule key, or the bracket overlay's own key) that no
// declared variant turns: every football variant plays without extra time or penalties, no carrom variant plays the
// 'draw' tie board, no period variant has an overtime without a shoot-out (or the reverse), no cricket variant a super
// over, no chess variant the tie-break switch. Without them the sweeps below could not see either side of those terms.
const OT = { kind: "sudden_death", minutes: 5 };
const SO = { attempts: 5, suddenDeath: true };
const DECIDER_FLIPS: Readonly<Record<string, readonly C[]>> = {
  football: [{ shootout: true }, { extraTime: { enabled: true, halfMinutes: 15 } }],
  hockey: [{ overtime: OT, shootout: null }, { overtime: OT, shootout: SO }],
  icehockey: [{ overtime: OT, shootout: null }, { overtime: null, shootout: SO }, { overtime: null, shootout: null }],
  cricket: [{ superOver: true }],
  boardgame: [{ tiebreak: true }, { tiebreak: true, tiebreakRungs: [] }, { tiebreak: true, tiebreakRungs: ["armageddon"] }],
  carrom: [{ tieBoard: "draw" }],
};

/** The cfg a stage of `kind` plays: the declared variant (or decider flip), then the sport's own `stageDefaults` for that
 *  kind (W2c §4.2), then in a bracket its `bracketDeciders` overlay (W2a ruling 76) — the engine's declarations only. */
function stageCfgs(m: AnySportModule): { name: string; kind: StageKind; cfg: C }[] {
  const raws: { name: string; variant: string | null; raw: C }[] = Object.entries(m.variants).map(([v, raw]) => ({ name: v, variant: v, raw: raw as C }));
  if (m.configSchema.safeParse({}).success) raws.unshift({ name: "(schema default)", variant: null, raw: {} });
  const first = raws[0]!;
  for (const flip of DECIDER_FLIPS[m.key] ?? []) raws.push({ name: `${first.name} + ${JSON.stringify(flip)}`, variant: first.variant, raw: { ...first.raw, ...flip } });
  const out: { name: string; kind: StageKind; cfg: C }[] = [];
  for (const { name, variant, raw } of raws) {
    for (const kind of StageKind.options) {
      const staged = { ...raw, ...(m.stageDefaults?.(kind, variant) ?? {}) };
      const base = m.configSchema.parse(staged) as C;
      const cfg = BRACKET_KINDS.has(kind) ? (m.configSchema.parse({ ...staged, ...m.bracketDeciders(base) }) as C) : base;
      out.push({ name, kind, cfg });
    }
  }
  return out;
}

describe("W2d Task 1: decidedInOf — the per-sport win-method vocabulary", () => {
  it("X-PT-2 decidedInOf is total over every declared outcome method (forEachSport, counted)", () => {
    const visited = new Set<string>();
    let methods = 0;
    const n = forEachSport(({ module }) => {
      visited.add(module.key);
      expect(module.outcomeMethods.length, `${module.key} declares no win method`).toBeGreaterThan(0);
      for (const m of module.outcomeMethods) {
        expect(DECIDED_IN).toContain(module.decidedInOf(m));
        methods++;
      }
    });
    expect(n).toBeGreaterThan(0);
    // PS-9g: the bound comes from an independent declaration (the epoch table), never from the list being iterated.
    expect([...visited].sort()).toEqual(Object.keys(FOLD_EPOCH).sort());
    expect(methods).toBeGreaterThan(n);
    expect([...DECIDED_IN]).toEqual(["regulation", "ot", "so"]);
  });

  it("X-PT-2 the mapping: extra_time→ot; shootout, super_over, boundary_count, tiebreak_<rung>→so; abandoned→regulation", () => {
    // SPEC §5.2 "Mapping", word for word. The goals family: football's FT/ET whistle and its kicks; the period kernel's
    // overtime and GWS / FIH shoot-out (hockey and ice hockey share it).
    for (const m of [football, hockey, icehockey]) {
      expect(m.decidedInOf("regulation"), m.key).toBe("regulation");
      expect(m.decidedInOf("extra_time"), m.key).toBe("ot");
      expect(m.decidedInOf("shootout"), m.key).toBe("so");
      // W2b D8: an award-policy abandon is a win on the real score, decided in regulation.
      expect(m.decidedInOf("abandoned"), m.key).toBe("regulation");
    }
    // Cricket (author's call, D4): the super over and its boundary count are the shoot-out; innings, DLS and the plain
    // result are regulation.
    expect(cricket.decidedInOf("super_over")).toBe("so");
    expect(cricket.decidedInOf("boundary_count")).toBe("so");
    for (const m of ["innings", "dls", "regulation"]) expect(cricket.decidedInOf(m), m).toBe("regulation");
    // Chess (author's call, D4): every tie-break rung is the shoot-out.
    let rungs = 0;
    for (const r of TIEBREAK_RUNGS) {
      expect(boardgame.decidedInOf(`tiebreak_${r}`), r).toBe("so");
      rungs++;
    }
    expect(rungs).toBe(TIEBREAK_RUNGS.length);
    expect(rungs).toBeGreaterThan(0);
  });

  it("X-PT-2 every sport declares the kernel's settle (settled_<method>) and the legacy walkover/forfeit wins, each in regulation (counted)", () => {
    // `outcomeOf` writes `settled_<method>` for EVERY sport (core/events.ts settledMethod; every golden corpus records a
    // settled_lot); a win stored before W2b can carry `walkover`/`forfeit` (points.ts forfeitShaped reads both).
    const shared = [...SETTLE_METHODS.map(settledMethod), "walkover", "forfeit"];
    expect(shared.length).toBe(SETTLE_METHODS.length + 2);
    let checked = 0;
    const n = forEachSport(({ module }) => {
      for (const m of shared) {
        expect(module.outcomeMethods, `${module.key} ${m}`).toContain(m);
        expect(module.decidedInOf(m), `${module.key} ${m}`).toBe("regulation");
        checked++;
      }
    });
    expect(n).toBe(SPORTS);
    expect(checked).toBe(SPORTS * shared.length);
  });

  it("X-PT-2 boardgame declares every result method a winner may carry, every tie-break rung and nothing else", () => {
    // From the event schema itself: a `boardgame.result` naming a winner parses for exactly these methods (its refine
    // refuses a double forfeit with a winner), plus `regulation` for a result recorded with no method (decideResult).
    const withWinner = BoardgameMethod.options.filter((method) => BoardgameResult.safeParse({ winner: "H", method }).success);
    expect(withWinner.length).toBeGreaterThan(0);
    expect(withWinner.length).toBeLessThan(BoardgameMethod.options.length); // the refine is aimed at something
    const expected = [
      "regulation",
      ...withWinner,
      ...TIEBREAK_RUNGS.map((r) => `tiebreak_${r}`),
      ...SETTLE_METHODS.map(settledMethod),
      "walkover",
      "forfeit",
    ];
    expect([...boardgame.outcomeMethods].sort()).toEqual([...new Set(expected)].sort());
  });

  it("an unknown method throws CONFIG_INVALID, never maps to regulation", () => {
    // The refusal names the sport and the method, in its data and its message, so a caller can say which.
    expect(() => football.decidedInOf("bogus")).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID", data: { sport: "football", method: "bogus" }, message: expect.stringContaining('"bogus"') }),
    );
    // Swept: an undeclared string, a prototype key (a plain-object lookup would answer `constructor` with a function)
    // and the empty string are refused by every sport.
    const probes = ["bogus", "constructor", "toString", "__proto__", "hasOwnProperty", ""];
    let checked = 0;
    const n = forEachSport(({ module }) => {
      for (const p of probes) {
        expect(module.outcomeMethods).not.toContain(p);
        expect(() => module.decidedInOf(p), `${module.key} "${p}"`).toThrowError(
          expect.objectContaining({ code: "CONFIG_INVALID", data: { sport: module.key, method: p } }),
        );
        checked++;
      }
    });
    expect(n).toBe(SPORTS);
    expect(checked).toBe(SPORTS * probes.length);
    // A method one sport declares is not another's: cricket's super over is no football method.
    expect(() => football.decidedInOf("super_over")).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });
});

describe("W2d Task 1: decidedInFor — a pure function of the stored outcome", () => {
  it("decidedInFor is null for draw, tie, no_result, award, double_walkover (empty case first: an undecided fixture → null)", () => {
    // Every non-win kind of the engine's own outcome set is covered here, so a seventh kind fails this test.
    expect(new Set(NON_WINS.map((o) => o.kind))).toEqual(new Set(OUTCOME_KINDS.filter((k) => k !== "win")));
    let checked = 0;
    const n = forEachSport(({ module }) => {
      expect(decidedInFor(module, null), `${module.key} undecided`).toBeNull();
      expect(decidedInFor(module, undefined), `${module.key} undecided`).toBeNull();
      for (const o of NON_WINS) {
        expect(decidedInFor(module, o), `${module.key} ${o.kind}`).toBeNull();
        checked++;
      }
      // The positive pair: a win decides, so the nulls above are not a function that answers null to everything.
      expect(decidedInFor(module, win("regulation")), module.key).toBe("regulation");
    });
    expect(n).toBe(SPORTS);
    expect(checked).toBe(SPORTS * NON_WINS.length);
    // The sequence: undecided → decided by penalties → voided (the outcome back to null) → decided again in extra time.
    expect(decidedInFor(football, null)).toBeNull();
    expect(decidedInFor(football, win("shootout"))).toBe("so");
    expect(decidedInFor(football, null)).toBeNull();
    expect(decidedInFor(football, win("extra_time"))).toBe("ot");
    // A second call reads the same outcome the same way.
    expect(decidedInFor(football, win("extra_time"))).toBe("ot");
  });

  it("decidedInFor reads a win that names no method as regulation, and refuses one whose method its sport does not declare", () => {
    // Every module's standingsDelta pays a method-less win as a regulation win (period winPoints, football's SO branch).
    const refusing = { decidedInOf: (): DecidedIn => { throw new Error("must not be consulted"); } };
    expect(decidedInFor(refusing, win())).toBe("regulation");
    expect(decidedInFor(refusing, { kind: "draw" })).toBeNull();
    expect(() => decidedInFor(football, win("bogus"))).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(() => decidedInFor(hockey, win("super_over"))).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it("X-PT-2 every win the golden corpora recorded decides through its own module (the real fold's output, every sport, counted)", () => {
    // Class 1 (the inert seam): the outcomes here are what each module's fold actually wrote, replay-verified by the
    // golden suite; a method the fold writes and the module does not declare throws here.
    const winsBySport: Record<string, number> = {};
    const reached = new Set<DecidedIn>();
    let decided = 0;
    let undecided = 0;
    const n = forEachSport(({ key, module }) => {
      winsBySport[key] = 0;
      for (const stream of readCorpus(key).streams) {
        const raw: unknown = JSON.parse(stream.outcome);
        const outcome = raw === null ? null : MatchOutcome.parse(raw);
        const d = decidedInFor(module, outcome);
        if (outcome?.kind === "win") {
          expect(DECIDED_IN, `${key} ${outcome.method}`).toContain(d);
          reached.add(d!);
          winsBySport[key]++;
          decided++;
        } else {
          expect(d).toBeNull();
          undecided++;
        }
      }
    });
    expect(n).toBe(SPORTS);
    for (const [key, wins] of Object.entries(winsBySport)) expect(wins, `${key} recorded no win`).toBeGreaterThan(0);
    expect(decided).toBeGreaterThan(SPORTS);
    expect(undecided).toBeGreaterThan(0);
    // The corpora hold football/period shoot-outs, a super over and chess rungs: the shoot-out arm is reached for real.
    expect(reached.has("so")).toBe(true);
    expect(reached.has("regulation")).toBe(true);
  });
});

describe("W2d Task 1: what a stage's format can reach", () => {
  it("X-PT-2 ice hockey IIHF reaches {regulation, ot, so}; recreational reaches {regulation} (icehockey.ts variants)", () => {
    const iihf = icehockey.configSchema.parse(cfgOf(icehockey, "iihf"));
    const recreational = icehockey.configSchema.parse(cfgOf(icehockey, "recreational"));
    // Expected sets from each cfg's own declaration: an overtime ⇒ ot, a shoot-out ⇒ so (IIHF Rule Book: preliminary-
    // round sudden-death OT then the GWS; the recreational variant plays neither).
    const expectedOf = (cfg: { overtime: unknown; shootout: unknown }): string[] => ["regulation", ...(cfg.overtime !== null ? ["ot"] : []), ...(cfg.shootout !== null ? ["so"] : [])].sort();
    expect(expectedOf(iihf)).toEqual(["ot", "regulation", "so"]);
    expect(expectedOf(recreational)).toEqual(["regulation"]);
    for (const kind of ["league", "group"] as const) {
      expect(sorted(icehockey.reachableDecidedIn(iihf, kind)), kind).toEqual(expectedOf(iihf));
      expect(sorted(icehockey.reachableDecidedIn(recreational, kind)), kind).toEqual(expectedOf(recreational));
    }
    // FIH hockey on the same kernel: the outdoor default plays no decider; the fih-shootout preset adds the shoot-out.
    expect(sorted(hockey.reachableDecidedIn(hockey.configSchema.parse(cfgOf(hockey, "fih-outdoor")), "league"))).toEqual(["regulation"]);
    expect(sorted(hockey.reachableDecidedIn(hockey.configSchema.parse(cfgOf(hockey, "fih-shootout")), "group"))).toEqual(["regulation", "so"]);
  });

  it("X-PT-2 football league reaches {regulation}; a group stage with shootout on reaches {regulation, so}; extraTime.enabled adds ot", () => {
    const league = football.configSchema.parse({});
    expect(sorted(football.reachableDecidedIn(league, "league"))).toEqual(["regulation"]);
    const groupSo = football.configSchema.parse({ shootout: true });
    expect(sorted(football.reachableDecidedIn(groupSo, "group"))).toEqual(["regulation", "so"]);
    const withEt = football.configSchema.parse({ extraTime: { enabled: true, halfMinutes: 15 } });
    expect(sorted(football.reachableDecidedIn(withEt, "group"))).toEqual(["ot", "regulation"]);
    // The engine's own knockout preset (stageDefaults: ET 2×15 and penalties) reaches all three.
    const knockout = football.configSchema.parse(football.stageDefaults!("knockout", null));
    expect(sorted(football.reachableDecidedIn(knockout, "knockout"))).toEqual(["ot", "regulation", "so"]);
  });

  it("X-PT-2 every reachable decidedIn holds regulation and is written by a declared method (every sport × cfg × stage kind, counted)", () => {
    let checked = 0;
    let beyondRegulation = 0;
    const n = forEachSport(({ module }) => {
      const produced = new Set(module.outcomeMethods.map((m) => module.decidedInOf(m)));
      for (const { name, kind, cfg } of stageCfgs(module)) {
        const reach = module.reachableDecidedIn(cfg, kind);
        expect(reach.has("regulation"), `${module.key}/${name} ${kind}`).toBe(true);
        for (const d of reach) {
          expect(DECIDED_IN, `${module.key}/${name} ${kind}`).toContain(d);
          expect(produced.has(d), `${module.key}/${name} ${kind}: ${d} is reachable but no declared method decides in it`).toBe(true);
        }
        if (reach.size > 1) beyondRegulation++;
        checked++;
      }
    });
    expect(n).toBe(SPORTS);
    expect(checked).toBeGreaterThanOrEqual(SPORTS * StageKind.options.length);
    expect(beyondRegulation).toBeGreaterThan(0);
  });

  it("X-PT-4 shootoutAs: football and hockey draw_plus_bonus; ice hockey, cricket, boardgame result", () => {
    // B2: FIFA and FIH book a shoot-out-decided table match as a draw plus a bonus; IIHF's GWS, cricket's super over and
    // chess's rungs are a win and a loss.
    expect(football.shootoutAs).toBe("draw_plus_bonus");
    expect(hockey.shootoutAs).toBe("draw_plus_bonus");
    for (const m of [icehockey, cricket, boardgame]) expect(m.shootoutAs, m.key).toBe("result");
    const plusBonus: string[] = [];
    const n = forEachSport(({ key, module }) => {
      expect(["draw_plus_bonus", "result"], key).toContain(module.shootoutAs);
      if (module.shootoutAs === "draw_plus_bonus") plusBonus.push(key);
    });
    expect(n).toBe(SPORTS);
    expect(plusBonus.sort()).toEqual(["football", "hockey"]);
  });

  it("boardgame reaches so exactly where a drawn game cannot end level (its own canEndLevel: tie-break on, a rung listed; counted)", () => {
    // Expected from the fold's own declaration, `canEndLevel`: a drawn game that may not stand goes to the tie-break rungs
    // (`tiebreak_<rung>` ⇒ so); one that may stand is a draw, so nothing but regulation decides a win.
    let so = 0;
    let regulationOnly = 0;
    const emptyRungs: string[] = [];
    for (const { name, kind, cfg } of stageCfgs(boardgame)) {
      const parsed = boardgame.configSchema.parse(cfg);
      const reach = sorted(boardgame.reachableDecidedIn(parsed, kind));
      const tiebreaks = !boardgame.canEndLevel!(parsed);
      expect(reach, `${name} ${kind}`).toEqual(tiebreaks ? ["regulation", "so"] : ["regulation"]);
      if (tiebreaks) so++;
      else regulationOnly++;
      if (name.includes('"tiebreakRungs":[]') && !BRACKET_KINDS.has(kind)) emptyRungs.push(`${kind}:${reach.join(",")}`);
    }
    expect(so).toBeGreaterThan(0);
    expect(regulationOnly).toBeGreaterThan(0);
    // The empty case: tie-break games on with no rung listed reach regulation only in every table stage.
    expect(emptyRungs.length).toBeGreaterThan(0);
    for (const row of emptyRungs) expect(row).toMatch(/:regulation$/);
  });

  it("HK-TB-1 hockey declares winsCount 'regulation'; no other sport does (counted)", () => {
    // FIH "matches won" counts regulation wins only (B2, RBG:236).
    expect(hockey.winsCount).toBe("regulation");
    const regulationOnly: string[] = [];
    const n = forEachSport(({ key, module }) => {
      if (module.winsCount === "regulation") regulationOnly.push(key);
      else expect([undefined, "all"], key).toContain(module.winsCount);
    });
    expect(n).toBe(SPORTS);
    expect(regulationOnly).toEqual(["hockey"]);
  });

  it("cricket reaches tie and noResult; draw only when inningsPerSide === 2 (D10(c))", () => {
    const cfgs = declaredCfgs<C>(cricket);
    const twoInnings = cfgs.filter(({ cfg }) => cfg.inningsPerSide === 2);
    const oneInnings = cfgs.filter(({ cfg }) => cfg.inningsPerSide === 1);
    expect(twoInnings.length).toBeGreaterThan(0); // the test variant
    expect(oneInnings.length).toBeGreaterThan(0); // t20, odi, the hundred
    for (const { name, cfg } of cfgs) {
      const expected = ["noResult", "tie", ...(cfg.inningsPerSide === 2 ? ["draw"] : [])].sort();
      for (const kind of ["league", "group"] as const) expect(sorted(cricket.reachableResultKinds(cfg as never, kind)), `${name} ${kind}`).toEqual(expected);
    }
  });

  it("X-PT-2 a draw is reachable exactly where the sport's supportsDraws stands one, or where a table shoot-out is booked as a draw (B2) — every sport × cfg × stage kind, counted", () => {
    let checked = 0;
    let drawable = 0;
    let refused = 0;
    let bookedDrawOnly = 0;
    const n = forEachSport(({ module }) => {
      for (const { name, kind, cfg } of stageCfgs(module)) {
        const bookedDraw = module.shootoutAs === "draw_plus_bonus" && DRAW_KINDS.has(kind) && module.reachableDecidedIn(cfg, kind).has("so");
        const stands = module.supportsDraws(cfg, kind);
        const expected = stands || bookedDraw;
        expect(module.reachableResultKinds(cfg as never, kind).has("draw"), `${module.key}/${name} ${kind}`).toBe(expected);
        if (expected) drawable++;
        else refused++;
        if (bookedDraw && !stands) bookedDrawOnly++;
        checked++;
      }
    });
    expect(n).toBe(SPORTS);
    expect(checked).toBeGreaterThanOrEqual(SPORTS * StageKind.options.length);
    expect(drawable).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
    expect(bookedDrawOnly).toBeGreaterThan(0); // the FIH Pro League shoot-out: no draw stands, yet one is booked (B2)
  });

  it("a bracket stage reaches no level result: no draw, tie or noResult in any bracket kind (ruling 79 holds them for a settle; counted)", () => {
    let checked = 0;
    const n = forEachSport(({ module }) => {
      for (const { name, kind, cfg } of stageCfgs(module)) {
        if (!BRACKET_KINDS.has(kind)) continue;
        expect(sorted(module.reachableResultKinds(cfg as never, kind)), `${module.key}/${name} ${kind}`).toEqual([]);
        checked++;
      }
    });
    expect(n).toBe(SPORTS);
    expect(checked).toBeGreaterThanOrEqual(SPORTS * BRACKET_KINDS.size);
    // The positive pair, in a table stage: cricket's tie and no result are reachable there (above).
    expect(cricket.reachableResultKinds(cricket.configSchema.parse({}), "league").has("tie")).toBe(true);
  });

  it("volleyball bestOf 5 reaches set scores 3-0, 3-1, 3-2; bestOf 3 reaches 2-0, 2-1 (from cfg.bestOf, not typed lists)", () => {
    const indoor = cfgOf(volleyball, "indoor");
    const beach = cfgOf(volleyball, "beach");
    expect(indoor.bestOf).toBe(5); // FIVB indoor: best of five sets
    expect(beach.bestOf).toBe(3); // FIVB beach: best of three sets
    expect(volleyball.reachableSetScores!(indoor as never)).toEqual(["3-0", "3-1", "3-2"]);
    expect(volleyball.reachableSetScores!(beach as never)).toEqual(["2-0", "2-1"]);
    // Another sport and length: table tennis best of seven (ITTF) reaches 4-0 to 4-3.
    expect(tabletennis.reachableSetScores!(cfgOf(tabletennis, "bo7") as never)).toEqual(["4-0", "4-1", "4-2", "4-3"]);
    // Swept: a set score is declared exactly by the sports whose table pays by set score (cfg.pointsMap); each lists the
    // winner's majority of `bestOf` against every losing count below it.
    let setSports = 0;
    let cfgs = 0;
    const n = forEachSport(({ module }) => {
      const declared = declaredCfgs<C>(module as never);
      const paysBySetScore = declared.every(({ cfg }) => cfg.pointsMap !== undefined);
      expect(declared.some(({ cfg }) => cfg.pointsMap !== undefined), module.key).toBe(paysBySetScore);
      expect(module.reachableSetScores !== undefined, module.key).toBe(paysBySetScore);
      if (!paysBySetScore) return;
      setSports++;
      for (const { name, cfg } of declared) {
        const bestOf = cfg.bestOf as number;
        const majority = Math.ceil(bestOf / 2); // best of N is won by the first to take ⌈N/2⌉ sets
        const scores = module.reachableSetScores!(cfg);
        expect(scores.length, `${module.key}/${name}`).toBe(majority);
        expect(new Set(scores).size).toBe(scores.length);
        for (const s of scores) {
          const [w, l] = s.split("-").map(Number);
          expect(w, `${module.key}/${name} ${s}`).toBe(majority);
          expect(l! >= 0 && l! < majority, `${module.key}/${name} ${s}`).toBe(true);
        }
        cfgs++;
      }
    });
    expect(n).toBe(SPORTS);
    expect(setSports).toBe(3); // volleyball, badminton, table tennis
    expect(cfgs).toBeGreaterThanOrEqual(setSports);
  });

  it("X-WO-1 (amended, D6) only table tennis declares an unplayed loss; no other module does (counted)", () => {
    // SPEC §5.10 (D6): table tennis pays "W 2, played L 1, unplayed L 0"; no other sport has a separate unplayed loss.
    const declaring: string[] = [];
    const n = forEachSport(({ key, module }) => {
      if (module.declaresUnplayedLoss === true) declaring.push(key);
      else expect(module.declaresUnplayedLoss, key).toBeUndefined();
    });
    expect(n).toBe(SPORTS);
    expect(declaring).toEqual(["tabletennis"]);
    expect(carrom.declaresUnplayedLoss).toBeUndefined();
  });
});
