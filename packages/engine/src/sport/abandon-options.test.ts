// W2c Task 7 (spec item 12, Q10, D9; rulings 117, 129; owner P-5) — the per-stage "If a match is abandoned" options.
// Expected outcomes come from the signed rows (HK-AB-2, CA-AB-2, GN-AB-2, FB-AB-1) and ruling 117, written out below;
// never from applyAbandon. Stage kinds come from the engine's own BRACKET_KINDS / DRAW_KINDS / StageKind.
//
// What an abandoned level match folds to is ruling 117's shape, as `abandon-result.test.ts` pins it: no outcome, phase
// "abandoned", flagged for replay - identical to a replay. (It is not a `{kind: "no_result"}` outcome.)
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "../core/events.ts";
import { BRACKET_KINDS, DRAW_KINDS, StageKind } from "../core/types.ts";
import { builtinModules } from "../sports/index.ts";
import { carrom } from "../sports/carrom/index.ts";
import { football } from "../sports/football/index.ts";
import { generic } from "../sports/generic/index.ts";
import { hockey } from "../sports/hockey/index.ts";
import { icehockey } from "../sports/icehockey/index.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/index.ts";
import { stageKeysFor } from "./rule-keys.ts";

type Spec = Array<[type: string, payload?: unknown, voids?: string]>;
const evs = (spec: Spec): EventEnvelope[] => spec.map(([type, payload, voids], i) => makeEnvelope(i + 1, { type, payload: payload ?? {} }, voids));
const ABANDON: [string, unknown] = ["core.abandon", { reason: "weather" }];
/** The owner's wording (P-5), verbatim: the refusal a save of `share` without draws gets. */
const SHARE_NEEDS_DRAWS = "Sharing the points needs draws to be allowed.";
/** Carrom's refusal (fix round 1, ruling): the same rule, but it names the setting that decides it. */
const SHARE_NEEDS_DRAWN_GAME = "Sharing the points needs a drawn game to be possible — set 'Game tied at max boards' to 'Drawn game' first.";

const hk = defaultLineupPair(hockey.positions);
const H = hk.home.entrantId;
const A = hk.away.entrantId;
const fih = (extra: Record<string, unknown> = {}) => hockey.configSchema.parse({ ...hockey.variants["fih-shootout"], ...extra });
const outdoor = (extra: Record<string, unknown> = {}) => hockey.configSchema.parse({ ...hockey.variants["fih-outdoor"], ...extra });
const goal = (by: string): [string, unknown] => ["hockey.goal", { by }];
const adv = (to: string): [string, unknown] => ["hockey.period.advance", { to }];
/** A started match, advanced to the start of the 4th quarter (the first period that is the last). */
const toQ4: Spec = [["core.start"], adv("Q2"), adv("Q3"), adv("Q4")];
const hockeyFold = (cfg: ReturnType<typeof fih>, spec: Spec) => foldMatch(hockey, cfg, hk, evs(spec));
/** `[outcome, phase, replayFlagged]` - what a replay looks like (and what ruling 117's level abandon looks like). */
const shape = (s: { outcome: unknown; phase: string; replayFlagged?: boolean }) => [s.outcome ?? null, s.phase, s.replayFlagged ?? false];

describe("HK-AB-2 hockey q4_stands: replay until the 4th quarter has started, then the result stands", () => {
  it("empty case first: the preset carries q4_stands, and a variant that does not set it keeps today's replay", () => {
    expect(fih().abandonPolicy).toBe("q4_stands");
    expect(hockey.configSchema.parse(hockey.variants["fih-outdoor"]).abandonPolicy).toBe("replay");
  });

  it("before the start (pre): a replay - on a cfg where a level score would otherwise stand as a draw", () => {
    const s = hockeyFold(outdoor({ abandonPolicy: "q4_stands" }), [ABANDON]);
    expect(shape(s)).toEqual([null, "abandoned", true]);
  });

  it("in Q3, leading: a replay (no outcome), where a Q4 abandon of the same score is a win", () => {
    const q3 = hockeyFold(fih(), [["core.start"], goal(H), adv("Q2"), adv("Q3"), ABANDON]);
    expect(shape(q3)).toEqual([null, "abandoned", true]);
    const q4 = hockeyFold(fih(), [["core.start"], goal(H), adv("Q2"), adv("Q3"), adv("Q4"), ABANDON]);
    expect(q4.outcome).toEqual({ kind: "win", winner: H, loser: A, method: "abandoned" });
  });

  it("level, where a draw stands: Q3 replays, Q4 is a draw on the real score (the gate that tells the two apart)", () => {
    const cfg = outdoor({ abandonPolicy: "q4_stands" });
    expect(hockey.supportsDraws(cfg, "league"), "rig: this cfg must take a draw").toBe(true);
    const q3 = hockeyFold(cfg, [["core.start"], goal(H), goal(A), adv("Q2"), adv("Q3"), ABANDON]);
    expect(shape(q3)).toEqual([null, "abandoned", true]);
    const q4 = hockeyFold(cfg, [["core.start"], goal(H), goal(A), adv("Q2"), adv("Q3"), adv("Q4"), ABANDON]);
    expect(q4.outcome).toEqual({ kind: "draw" });
  });

  it("ruling 117: level in Q4 where the cfg refuses a draw is no result - flagged for replay or settle, never a draw", () => {
    const cfg = fih();
    expect(hockey.supportsDraws(cfg, "league"), "rig: this cfg must refuse a draw").toBe(false);
    expect(shape(hockeyFold(cfg, [...toQ4, ABANDON]))).toEqual([null, "abandoned", true]);
  });

  it("I4: in the SHOOT-OUT the result stands (never a replay on a technicality): it is level, so no result", () => {
    // Level at the Q4 whistle with a shoot-out configured: "FT" opens the shoot-out. A shoot-out is always level, so the
    // award path answers what ruling 117 says - and what a replay would: the two cannot be told apart by the outcome here,
    // which is why the overtime case below is the one that proves the phase is not read as "before Q4".
    const s = hockeyFold(fih(), [...toQ4, adv("FT"), ABANDON]);
    expect(s.phase).toBe("abandoned");
    expect(shape(s)).toEqual([null, "abandoned", true]);
  });

  it("I4: in overtime, leading, the result stands as a win (a custom cfg: no hockey variant has overtime)", () => {
    const cfg = fih({ overtime: { kind: "periods", count: 2, minutes: 5 } });
    // Q4 level, "FT" opens OT1; the goal in OT1 leads; OT2 is the last extra period.
    const s = hockeyFold(cfg, [...toQ4, adv("FT"), goal(H), adv("OT2"), ABANDON]);
    expect(s.phase).toBe("done");
    expect(s.outcome).toEqual({ kind: "win", winner: H, loser: A, method: "abandoned" });
    // The negative pair: the same stream under a plain replay policy leaves nobody decided.
    const replay = hockeyFold(fih({ overtime: { kind: "periods", count: 2, minutes: 5 }, abandonPolicy: "replay" }), [...toQ4, adv("FT"), goal(H), adv("OT2"), ABANDON]);
    expect(shape(replay)).toEqual([null, "abandoned", true]);
  });

  it("an abandon that stood is takeable back: voiding it resumes the 4th quarter; a second abandon then stands again", () => {
    const stands: Spec = [["core.start"], goal(H), adv("Q2"), adv("Q3"), adv("Q4"), ABANDON];
    const voided = hockeyFold(fih(), [...stands, ["core.void", {}, "e-6"]]);
    expect(voided.outcome ?? null).toBeNull();
    expect(voided.phase).toBe("Q4");
    const again = hockeyFold(fih(), [...stands, ["core.void", {}, "e-6"], ABANDON]);
    expect(again.outcome).toEqual({ kind: "win", winner: H, loser: A, method: "abandoned" });
  });

  it("the option exists only for four-quarter formats: any other period count refuses it, four accepts it (counted)", () => {
    let refused = 0;
    for (const count of [1, 2, 3]) {
      const r = hockey.configSchema.safeParse({ ...hockey.variants["fih-shootout"], periods: { count, minutes: 35 }, abandonPolicy: "q4_stands" });
      expect(r.success, `${count} periods`).toBe(false);
      refused++;
    }
    expect(refused).toBe(3);
    expect(hockey.configSchema.safeParse({ ...hockey.variants["fih-shootout"], periods: { count: 4, minutes: 12 }, abandonPolicy: "q4_stands" }).success).toBe(true);
    // The refusal does not reject the other policies on the same period counts.
    expect(hockey.configSchema.safeParse({ ...hockey.variants["fih-shootout"], periods: { count: 2, minutes: 35 }, abandonPolicy: "award" }).success).toBe(true);
  });
});

describe("I5 q4_stands is a hockey option only", () => {
  it("hockey offers it; ice hockey neither offers it nor parses it on any variant (counted)", () => {
    expect(hockey.abandonOptions).toEqual(["replay", "award", "q4_stands"]);
    expect(icehockey.abandonOptions).toEqual(["replay", "award"]);
    let checked = 0;
    for (const preset of Object.values(icehockey.variants)) {
      expect(icehockey.configSchema.safeParse({ ...preset, abandonPolicy: "q4_stands" }).success).toBe(false);
      expect(icehockey.configSchema.safeParse({ ...preset, abandonPolicy: "award" }).success, "the negative pair").toBe(true);
      checked++;
    }
    expect(checked).toBe(Object.keys(icehockey.variants).length);
    expect(checked).toBeGreaterThan(0);
  });

  it("an ice hockey cfg with four periods still refuses it: the sport's own list decides, not the period count", () => {
    const preset = Object.values(icehockey.variants)[0] as Record<string, unknown>;
    expect(icehockey.configSchema.safeParse({ ...preset, periods: { count: 4, minutes: 12 }, abandonPolicy: "q4_stands" }).success).toBe(false);
  });

  it("each refusal names the abandonPolicy field and says why (MD-1: the issue's code, path and wording are the contract, not just 'it failed')", () => {
    // The wording is the sport's own text, written out here; a refusal that flagged no field, or the wrong one, would leave
    // the organiser's editor with nothing to point at.
    const issuesOf = (r: { success: boolean; error?: { issues: { code: string; message: string; path: PropertyKey[] }[] } }) =>
      r.success ? null : r.error!.issues.map((i) => [i.code, i.message, i.path]);
    // I5: a policy outside the sport's own list, whatever the period count.
    const ice = Object.values(icehockey.variants)[0] as Record<string, unknown>;
    expect(issuesOf(icehockey.configSchema.safeParse({ ...ice, periods: { count: 4, minutes: 12 }, abandonPolicy: "q4_stands" }))).toEqual([
      ["custom", 'This sport does not offer "q4_stands" for an abandoned match.', ["abandonPolicy"]],
    ]);
    // HK-AB-2: the 4th-quarter rule needs a four-period format; hockey offers the policy, so only the period count refuses it.
    const hkPreset = hockey.variants["fih-shootout"] as Record<string, unknown>;
    expect(hkPreset["abandonPolicy"], "premise: the preset is the q4_stands one").toBe("q4_stands");
    expect(hockey.configSchema.safeParse(hkPreset).success, "the positive pair: the four-period default accepts it").toBe(true);
    expect(issuesOf(hockey.configSchema.safeParse({ ...hkPreset, periods: { count: 2, minutes: 35 } }))).toEqual([
      ["custom", "The 4th-quarter rule needs four periods.", ["abandonPolicy"]],
    ]);
    // P-5 (generic): the same shape, so one assertion more than the message and path above.
    expect(issuesOf(generic.configSchema.safeParse({ ...generic.variants["score"], allowDraws: false, abandonPolicy: "share" }))).toEqual([
      ["custom", SHARE_NEEDS_DRAWS, ["abandonPolicy"]],
    ]);
  });

  it("football's enum is unchanged: it parses replay and award, and refuses q4_stands and share", () => {
    expect(football.abandonOptions).toEqual(["replay", "award"]);
    const parses = (policy: string) => football.configSchema.safeParse({ abandonPolicy: policy }).success;
    expect([parses("replay"), parses("award"), parses("q4_stands"), parses("share")]).toEqual([true, true, false, false]);
  });
});

describe("GN-AB-2 CA-AB-2 opt-in shared points on an abandon; the default is today's replay", () => {
  const gl = defaultLineupPair(generic.positions);
  const GH = gl.home.entrantId;
  const GA = gl.away.entrantId;
  const gcfg = (extra: Record<string, unknown>) => generic.configSchema.parse({ ...generic.variants["score"], ...extra });
  const tally: Spec = [["core.start"], ["generic.score", { by: GH, points: 2 }], ["generic.score", { by: GA, points: 1 }]];

  const cl = defaultLineupPair(carrom.positions);
  const CH = cl.home.entrantId;
  const CA = cl.away.entrantId;
  const ccfg = (extra: Record<string, unknown> = {}) => carrom.configSchema.parse(extra);
  const board = (winner: string, opponentCoinsLeft: number): [string, unknown] => ["carrom.board.summary", { winner, opponentCoinsLeft, queenTo: null }];
  /** Game 1 to home (three boards of 9 coins left reach gameTo 25), then one board to away. */
  const played: Spec = [["core.start"], board(CH, 9), board(CH, 9), board(CH, 9), board(CA, 4)];

  it("empty case first: no policy is no key at all, and an abandon is a replay with the score kept (GN-AB-1, CA-AB-1)", () => {
    const g = gcfg({});
    const c = ccfg();
    expect(Object.hasOwn(g, "abandonPolicy"), "generic").toBe(false);
    expect(Object.hasOwn(c, "abandonPolicy"), "carrom").toBe(false);
    const gs = foldMatch(generic, g, gl, evs([...tally, ABANDON]));
    expect([gs.outcome, gs.phase, gs.score]).toEqual([null, "abandoned", null]);
    const cs = foldMatch(carrom, c, cl, evs([...played, ABANDON]));
    expect([cs.outcome, cs.phase]).toEqual([null, "abandoned"]);
  });

  it("an explicit replay is the same as the absent policy", () => {
    expect(foldMatch(generic, gcfg({ abandonPolicy: "replay" }), gl, evs([...tally, ABANDON])).outcome).toBeNull();
    expect(foldMatch(carrom, ccfg({ abandonPolicy: "replay" }), cl, evs([...played, ABANDON])).outcome).toBeNull();
  });

  it("GN-AB-2 generic share: an abandon is a draw, and the running tally as it stood is kept (2-1, not rewritten to level)", () => {
    const s = foldMatch(generic, gcfg({ allowDraws: true, abandonPolicy: "share" }), gl, evs([...tally, ABANDON]));
    expect(s.outcome).toEqual({ kind: "draw" });
    expect(s.phase).toBe("done");
    expect(s.running).toEqual({ home: 2, away: 1 });
    // The score as it stood is the match's score: the headline and the table's for/against read it.
    expect(s.score).toEqual({ home: 2, away: 1 });
    expect(generic.summary(s).headline).toBe("2 — 1");
    // The table pays each side the draw points, and counts a drawn match.
    const [home, away] = generic.standingsDelta({ kind: "draw" }, gcfg({}), { kind: "league" } as never, s);
    expect([home.drawn, away.drawn, home.points, away.points]).toEqual([1, 1, gcfg({}).points.d, gcfg({}).points.d]);
    expect([home.metrics.for, home.metrics.against, away.metrics.for, away.metrics.against]).toEqual([2, 1, 1, 2]);
  });

  it("GN-AB-2 share before any score: still a draw (the abandon was recorded, the points are shared), with no score to keep", () => {
    const s = foldMatch(generic, gcfg({ allowDraws: true, abandonPolicy: "share" }), gl, evs([["core.start"], ABANDON]));
    expect(s.outcome).toEqual({ kind: "draw" });
    expect(s.score).toBeNull();
  });

  it("an abandon under share can be voided: play resumes with no outcome, and a second abandon shares again", () => {
    const cfg = gcfg({ allowDraws: true, abandonPolicy: "share" });
    const voided = foldMatch(generic, cfg, gl, evs([...tally, ABANDON, ["core.void", {}, "e-4"]]));
    expect([voided.outcome, voided.phase]).toEqual([null, "live"]);
    const again = foldMatch(generic, cfg, gl, evs([...tally, ABANDON, ["core.void", {}, "e-4"], ABANDON]));
    expect(again.outcome).toEqual({ kind: "draw" });
  });

  it("CA-AB-2 carrom share (on a cfg where draws are allowed): a draw, with the completed game and boards kept", () => {
    const cfg = ccfg({ tieBoard: "draw", abandonPolicy: "share" });
    expect(carrom.supportsDraws(cfg, "league"), "rig: this cfg must take a draw").toBe(true);
    const s = foldMatch(carrom, cfg, cl, evs([...played, ABANDON]));
    expect(s.outcome).toEqual({ kind: "draw" });
    expect(s.phase).toBe("done");
    expect(s.gamesWon).toEqual({ home: 1, away: 0 });
    const [home, away] = carrom.standingsDelta({ kind: "draw" }, cfg, { kind: "league" } as never, s);
    expect([home.points, away.points]).toEqual([cfg.points.draw, cfg.points.draw]);
    expect(home.metrics).toMatchObject({ sets_won: 1, boards_won: 3, boards_lost: 1 });
  });

  it("P-5: generic refuses share when draws are not allowed, with the owner's wording, on the abandonPolicy field", () => {
    for (const base of [generic.variants["win_loss"], generic.variants["score"]]) {
      const r = generic.configSchema.safeParse({ ...base, allowDraws: false, abandonPolicy: "share" });
      expect(r.success).toBe(false);
      if (r.success) continue;
      expect(r.error.issues.map((i) => [i.message, i.path])).toEqual([[SHARE_NEEDS_DRAWS, ["abandonPolicy"]]]);
    }
    // positive pair: the same two presets with draws allowed accept it; and replay never needs draws
    for (const base of [generic.variants["win_loss"], generic.variants["score"]]) {
      expect(generic.configSchema.safeParse({ ...base, allowDraws: true, abandonPolicy: "share" }).success).toBe(true);
      expect(generic.configSchema.safeParse({ ...base, allowDraws: false, abandonPolicy: "replay" }).success).toBe(true);
    }
  });

  it("carrom refuses share the same way where its cfg takes no draw (tieBoard extra is ICF play: a winner always exists)", () => {
    const r = carrom.configSchema.safeParse({ tieBoard: "extra", abandonPolicy: "share" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => [i.message, i.path])).toEqual([[SHARE_NEEDS_DRAWN_GAME, ["abandonPolicy"]]]);
    expect(carrom.configSchema.safeParse({ tieBoard: "draw", abandonPolicy: "share" }).success).toBe(true);
    expect(carrom.configSchema.safeParse({ tieBoard: "extra", abandonPolicy: "replay" }).success).toBe(true);
  });

  it("neither accepts the hockey option or an unknown one", () => {
    for (const bad of ["q4_stands", "award", "nonsense"]) {
      expect(generic.configSchema.safeParse({ ...generic.variants["score"], abandonPolicy: bad }).success, `generic ${bad}`).toBe(false);
      expect(carrom.configSchema.safeParse({ abandonPolicy: bad }).success, `carrom ${bad}`).toBe(false);
    }
  });

  it("share is offered in table stages only: the key is in the stage's form for every draw kind and no bracket kind (counted)", () => {
    for (const m of [carrom, generic]) {
      let offered = 0;
      let withheld = 0;
      for (const kind of StageKind.options) {
        for (const variant of [null, ...Object.keys(m.variants)]) {
          const has = stageKeysFor(m, kind, variant).includes("abandonPolicy");
          expect(has, `${m.key} ${kind} ${variant}`).toBe(DRAW_KINDS.has(kind));
          if (has) offered++;
          else withheld++;
        }
      }
      const variants = Object.keys(m.variants).length + 1;
      expect(offered, m.key).toBe(DRAW_KINDS.size * variants);
      expect(withheld, m.key).toBe(BRACKET_KINDS.size * variants);
    }
  });
});

describe("I3 (ruling) share applies in table stages only: in a bracket the policy is ignored and the abandon is held", () => {
  const gl = defaultLineupPair(generic.positions);
  const cl = defaultLineupPair(carrom.positions);
  const tally: Spec = [["core.start"], ["generic.score", { by: gl.home.entrantId, points: 2 }], ["generic.score", { by: gl.away.entrantId, points: 1 }]];
  const cfgOf = (m: typeof generic | typeof carrom, extra: Record<string, unknown>) =>
    m === generic ? generic.configSchema.parse({ ...generic.variants["score"], allowDraws: true, ...extra }) : carrom.configSchema.parse({ tieBoard: "draw", ...extra });
  /** What resolveFixtureCfg lays over the stage's cfg for a fixture in a bracket stage: `division ⊕ bracketDeciders`. */
  /** The fold, read for the two fields these tests compare (the generic fold's state is not one shared type). */
  const folded = (m: unknown, cfg: unknown, lineups: unknown, spec: Spec): { outcome?: unknown; phase?: unknown } =>
    ((): { outcome?: unknown; phase?: unknown } => {
      const state: unknown = foldMatch(m as never, cfg as never, lineups as never, evs(spec));
      return state as { outcome?: unknown; phase?: unknown };
    })();
  const inBracket = <C extends object>(m: { bracketDeciders(c: never): object }, cfg: C): C => ({ ...cfg, ...m.bracketDeciders(cfg as never) });

  it("a bracket abandon under share folds like a replay (held, nobody decided) - never a draw; the same cfg in a table stage is the draw", () => {
    let bracket = 0;
    let table = 0;
    for (const [m, lineups, spec] of [[generic, gl, tally], [carrom, cl, [["core.start"]] as Spec]] as const) {
      const cfg = cfgOf(m, { abandonPolicy: "share" });
      expect(cfg.abandonPolicy, `${m.key}: rig`).toBe("share");
      // The table stage folds the cfg as it is: the draw.
      expect(folded(m, cfg, lineups, [...spec, ABANDON]).outcome, `${m.key} table`).toEqual({ kind: "draw" });
      table++;
      // Every bracket kind folds the overlay: bracketDeciders takes no kind, so one overlay serves all five - counted per kind.
      for (const kind of BRACKET_KINDS) {
        const s = folded(m, inBracket(m as never, cfg), lineups, [...spec, ABANDON]);
        expect([s.outcome ?? null, s.phase], `${m.key} ${kind}`).toEqual([null, "abandoned"]);
        bracket++;
      }
    }
    expect(table).toBe(2);
    expect(bracket).toBe(2 * BRACKET_KINDS.size);
  });

  it("the overlay touches nothing else: with no policy, or an explicit replay, a bracket fixture's cfg is exactly what it was", () => {
    let checked = 0;
    for (const m of [generic, carrom]) {
      for (const extra of [{}, { abandonPolicy: "replay" }]) {
        const overlay = m.bracketDeciders(cfgOf(m, extra) as never) as Record<string, unknown>;
        expect(Object.keys(overlay).sort(), `${m.key} ${JSON.stringify(extra)}`).toEqual(m === carrom ? ["tieBoard"] : []);
        checked++;
      }
    }
    expect(checked).toBe(4);
  });

  it("carrom keeps CA-KO-1 beside it: the overlay under share is the extra board AND replay", () => {
    expect(carrom.bracketDeciders(cfgOf(carrom, { abandonPolicy: "share" }) as never)).toEqual({ tieBoard: "extra", abandonPolicy: "replay" });
    expect(generic.bracketDeciders(cfgOf(generic, { abandonPolicy: "share" }) as never)).toEqual({ abandonPolicy: "replay" });
  });
});

describe("the abandon key is a stage key for the sports that offer options, and for no other sport", () => {
  /** From the rows: football FB-AB-1 (replay, award), hockey HK-AB-2 (+ q4_stands), ice hockey IH-AB-1 (replay, award),
   *  carrom CA-AB-2 and generic GN-AB-2 (replay, share). Every other sport has one rule (a replay, or its own scheme). */
  const OFFERED: Record<string, readonly string[]> = {
    football: ["replay", "award"],
    hockey: ["replay", "award", "q4_stands"],
    icehockey: ["replay", "award"],
    carrom: ["replay", "share"],
    generic: ["replay", "share"],
  };

  it("each module's declared list is the rows' list, and every other module declares none (counted)", () => {
    let offered = 0;
    let none = 0;
    for (const m of builtinModules) {
      if (Object.hasOwn(OFFERED, m.key)) {
        expect(m.abandonOptions, m.key).toEqual(OFFERED[m.key]);
        offered++;
      } else {
        expect(m.abandonOptions, `${m.key} declares abandon options the rows do not give it`).toBeUndefined();
        expect(stageKeysFor(m, null, null).includes("abandonPolicy"), `${m.key} offers the key without options`).toBe(false);
        none++;
      }
    }
    expect(offered).toBe(Object.keys(OFFERED).length);
    expect(none).toBe(builtinModules.length - offered);
    expect(none).toBeGreaterThan(0);
  });

  it("football, hockey and ice hockey offer the key in every stage kind and variant (counted)", () => {
    let checked = 0;
    for (const m of [football, hockey, icehockey])
      for (const kind of [null, ...StageKind.options])
        for (const variant of [null, ...Object.keys(m.variants)]) {
          expect(stageKeysFor(m, kind, variant).includes("abandonPolicy"), `${m.key} ${kind} ${variant}`).toBe(true);
          checked++;
        }
    expect(checked).toBe([football, hockey, icehockey].reduce((n, m) => n + (StageKind.options.length + 1) * (Object.keys(m.variants).length + 1), 0));
  });
});

describe("P9 sweep: every offered option folds an abandon, with the result its row gives", () => {
  /** A leading score for each sport: a goal for the home side, a tally of 2-0, a game and board to home. */
  const LEAD: Record<string, Spec> = {
    football: [["core.start"], ["football.goal", { by: "H" }]],
    hockey: [["core.start"], ["hockey.goal", { by: "H" }]],
    icehockey: [["core.start"], ["icehockey.goal", { by: "H" }]],
    generic: [["core.start"], ["generic.score", { by: "H", points: 2 }]],
    carrom: [["core.start"], ["carrom.board.summary", { winner: "H", opponentCoinsLeft: 9, queenTo: null }]],
  };

  it("each sport x each of ITS options (counted against the declared lists): replay is undecided; the rest decide as their rows say", () => {
    let offered = 0;
    let checked = 0;
    for (const m of builtinModules) {
      for (const policy of m.abandonOptions ?? []) {
        offered++;
        // A variant whose cfg takes the policy: generic's share needs draws (P-5), carrom's needs tieBoard draw, hockey's
        // q4_stands four periods. The cfg is the sport's own declared preset plus the one knob.
        const knobs: Record<string, unknown> = policy === "share" && m.key === "carrom" ? { tieBoard: "draw" } : policy === "share" ? { allowDraws: true } : {};
        const accepting = [{}, ...Object.values(m.variants)].filter((p) => m.configSchema.safeParse({ ...(p as object), ...knobs, abandonPolicy: policy }).success);
        expect(accepting.length, `${m.key}: no variant accepts its own option ${policy}`).toBeGreaterThan(0);
        const cfg = m.configSchema.parse({ ...(accepting[0] as object), ...knobs, abandonPolicy: policy });
        const lineups = defaultLineupPair(m.positions);
        const s: { outcome: { kind: string } | null; phase: string } = foldMatch(m as never, cfg as never, lineups, evs([...LEAD[m.key]!, ABANDON]));
        // The rows: replay and a q4_stands abandon before the 4th quarter leave nobody decided; award is the leader's win
        // (FB-AB-1); share is a draw (CA-AB-2, GN-AB-2).
        const decided = policy === "award" ? "win" : policy === "share" ? "draw" : null;
        expect(s.outcome?.kind ?? null, `${m.key} ${policy}`).toBe(decided);
        expect(s.phase, `${m.key} ${policy}`).toBe(decided === null ? "abandoned" : "done");
        checked++;
      }
    }
    expect(offered).toBe(3 + 2 + 2 + 2 + 2); // hockey, football, icehockey, carrom, generic: the rows above
    expect(checked).toBe(offered);
  });
});
