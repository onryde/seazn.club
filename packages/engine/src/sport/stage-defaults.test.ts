// X-SR-6 / FB-SO-1 / IH-KO-1 / CK-SO-1 — knockout presets. Expected values come
// from the signed rule rows and the modules' own declarations (variants,
// configSchema defaults, BRACKET_KINDS, DRAW_KINDS, StageKind), never from
// stageDefaults itself.
import { describe, expect, it } from "vitest";
import { BRACKET_KINDS, DRAW_KINDS, StageKind } from "../core/types.ts";
import { foldMatch, type EventEnvelope } from "../core/events.ts";
import { builtinModules } from "../sports/index.ts";
import { football } from "../sports/football/index.ts";
import { hockey } from "../sports/hockey/index.ts";
import { icehockey } from "../sports/icehockey/index.ts";
import { cricket } from "../sports/cricket/index.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/index.ts";
import { stageDefaultsFor } from "./rule-keys.ts";

const stream = (...specs: Array<[string, unknown?]>): EventEnvelope[] =>
  specs.map(([type, payload], i) => makeEnvelope(i, { type, payload: payload ?? {} }));

describe("X-SR-6 table kinds get no preset", () => {
  it("the two halves of StageKind are exhaustive, so the sweeps below visit every kind (counted)", () => {
    expect(BRACKET_KINDS.size).toBeGreaterThan(0);
    expect(DRAW_KINDS.size).toBeGreaterThan(0);
    expect(BRACKET_KINDS.size + DRAW_KINDS.size).toBe(StageKind.options.length);
  });

  it("every module returns {} for every table kind and every variant (counted)", () => {
    let checked = 0;
    for (const m of builtinModules)
      for (const kind of DRAW_KINDS)
        for (const variant of [null, ...Object.keys(m.variants)]) {
          expect(stageDefaultsFor(m, kind, variant), `${m.key}/${kind}/${variant}`).toEqual({});
          checked++;
        }
    expect(checked).toBe(builtinModules.reduce((n, m) => n + DRAW_KINDS.size * (Object.keys(m.variants).length + 1), 0));
    expect(checked).toBeGreaterThan(0);
  });
});

describe("X-SR-6 FB-SO-1 football knockout preset", () => {
  it("every bracket kind presets ET 2×15, penalties and 5 kicks; youth 3", () => {
    let checked = 0;
    for (const kind of BRACKET_KINDS) {
      expect(stageDefaultsFor(football, kind, null)).toEqual({ extraTime: { enabled: true, halfMinutes: 15 }, shootout: true, shootoutAttempts: 5 });
      expect(stageDefaultsFor(football, kind, "youth")).toEqual({ extraTime: { enabled: true, halfMinutes: 15 }, shootout: true, shootoutAttempts: 3 });
      checked++;
    }
    expect(checked).toBe(BRACKET_KINDS.size);
    expect(Object.keys(football.variants)).toContain("youth");
  });

  it("a variant with no preset of its own, and a name that is no variant at all, fall back to 5 (a Map lookup, never the prototype chain)", () => {
    let checked = 0;
    const others = Object.keys(football.variants).filter((v) => v !== "youth");
    const notVariants = ["no-such-variant", "constructor", "__proto__", "toString"];
    for (const variant of [...others, ...notVariants])
      for (const kind of BRACKET_KINDS) {
        expect(stageDefaultsFor(football, kind, variant), `${kind}/${variant}`).toMatchObject({ shootoutAttempts: 5 });
        checked++;
      }
    expect(others.length).toBeGreaterThan(0);
    expect(checked).toBe((others.length + notVariants.length) * BRACKET_KINDS.size);
  });

  it("FB-SO-1 the shoot-out is decided after the stage's attempts (3), and NOT after 2 rounds under 5", () => {
    const kick = (by: string, scored: boolean): [string, unknown] => ["football.shootout.kick", { by, scored }];
    const lineups = defaultLineupPair(football.positions);
    const H = lineups.home.entrantId, A = lineups.away.entrantId;
    const events = stream(
      ["core.start"], ["football.period", { phase: "HT" }], ["football.period", { phase: "FT" }],
      ["football.period", { phase: "ET_HT" }], ["football.period", { phase: "ET_FT" }],
      kick(H, true), kick(A, false), kick(H, true), kick(A, false),   // 2-0 after two rounds
    );
    const three = football.configSchema.parse({ ...stageDefaultsFor(football, "knockout", "youth") });
    const five = football.configSchema.parse({ ...stageDefaultsFor(football, "knockout", null) });
    expect(foldMatch(football, three, lineups, events).outcome).toMatchObject({ kind: "win", winner: H, method: "shootout" });
    expect(foldMatch(football, five, lineups, events).outcome ?? null).toBeNull();
  });

  it("FB-SO-1 the lower bound: one kick each decides a 1-0 round, the upper bound 10 does not decide 4-0", () => {
    const kick = (by: string, scored: boolean): [string, unknown] => ["football.shootout.kick", { by, scored }];
    const lineups = defaultLineupPair(football.positions);
    const H = lineups.home.entrantId, A = lineups.away.entrantId;
    const toShootout: Array<[string, unknown?]> = [
      ["core.start"], ["football.period", { phase: "HT" }], ["football.period", { phase: "FT" }],
      ["football.period", { phase: "ET_HT" }], ["football.period", { phase: "ET_FT" }],
    ];
    const cfgOf = (shootoutAttempts: number) => football.configSchema.parse({ extraTime: { enabled: true, halfMinutes: 15 }, shootout: true, shootoutAttempts });
    const oneRound = stream(...toShootout, kick(H, true), kick(A, false));
    expect(foldMatch(football, cfgOf(1), lineups, oneRound).outcome).toMatchObject({ kind: "win", winner: H, method: "shootout" });
    const fourRounds = stream(...toShootout, kick(H, true), kick(A, false), kick(H, true), kick(A, false), kick(H, true), kick(A, false), kick(H, true), kick(A, false));
    expect(foldMatch(football, cfgOf(10), lineups, fourRounds).outcome ?? null).toBeNull();
    expect(football.configSchema.safeParse({ shootoutAttempts: 0 }).success).toBe(false);
    expect(football.configSchema.safeParse({ shootoutAttempts: 11 }).success).toBe(false);
  });

  it("absent shootoutAttempts keeps today's 5 (a division cfg without the key)", () => {
    const cfg = football.configSchema.parse({ extraTime: { enabled: true, halfMinutes: 15 }, shootout: true });
    expect(cfg.shootoutAttempts).toBeUndefined();
    const kick = (by: string, scored: boolean): [string, unknown] => ["football.shootout.kick", { by, scored }];
    const lineups = defaultLineupPair(football.positions);
    const H = lineups.home.entrantId, A = lineups.away.entrantId;
    const events = stream(
      ["core.start"], ["football.period", { phase: "HT" }], ["football.period", { phase: "FT" }],
      ["football.period", { phase: "ET_HT" }], ["football.period", { phase: "ET_FT" }],
      kick(H, true), kick(A, false), kick(H, true), kick(A, false), kick(H, true), kick(A, false), // 3-0 after three rounds
    );
    // Decided at 3-0 only because 5 - 3 = 2 kicks remain for the trailing side: today's behaviour, unchanged.
    expect(foldMatch(football, cfg, lineups, events).outcome).toMatchObject({ kind: "win", winner: H, method: "shootout" });
    expect(foldMatch(football, cfg, lineups, events.slice(0, -2)).outcome ?? null).toBeNull(); // 2-0 after two rounds: not yet
  });
});

describe("hockey, ice hockey and cricket knockout presets", () => {
  it("hockey: the FIH preset's shoot-out, in every bracket kind", () => {
    let checked = 0;
    for (const kind of BRACKET_KINDS) {
      expect(stageDefaultsFor(hockey, kind, null)).toEqual({ shootout: hockey.variants["fih-shootout"]!.shootout });
      checked++;
    }
    expect(checked).toBe(BRACKET_KINDS.size);
    expect(hockey.variants["fih-shootout"]!.shootout).not.toBeNull(); // the preset the default is read from carries one
  });
  it("IH-KO-1 ice hockey: 10-minute sudden-death OT and the default GWS", () => {
    const base = icehockey.configSchema.parse({});
    let checked = 0;
    for (const kind of BRACKET_KINDS) {
      const d = stageDefaultsFor(icehockey, kind, null) as { overtime: { minutes: number; skaters: number; kind: string }; shootout: unknown };
      expect(d.overtime).toEqual({ kind: "sudden_death", minutes: 10, skaters: (base.overtime as { skaters: number }).skaters });
      expect(d.shootout).toEqual(base.shootout);
      checked++;
    }
    expect(checked).toBe(BRACKET_KINDS.size);
    expect((stageDefaultsFor(icehockey, "knockout", null) as { overtime: { minutes: number } }).overtime.minutes).not.toBe((base.overtime as { minutes: number }).minutes); // 10 ≠ the engine's 5: the preset is not a no-op
  });
  it("IH-KO-1 the recreational variant (no overtime, no shoot-out of its own) still gets the knockout decider", () => {
    const rec = icehockey.configSchema.parse(icehockey.variants.recreational);
    expect(rec.overtime).toBeNull(); // the precondition: this variant has none
    const parsed = icehockey.configSchema.parse({ ...rec, ...stageDefaultsFor(icehockey, "knockout", "recreational") });
    expect(parsed.overtime).toMatchObject({ kind: "sudden_death", minutes: 10 });
    expect(parsed.shootout).not.toBeNull();
  });
  it("CK-SO-1 cricket: super over on in knockouts, untouched in leagues (league-on is the organiser's choice)", () => {
    let checked = 0;
    for (const kind of BRACKET_KINDS) { expect(stageDefaultsFor(cricket, kind, "t20")).toEqual({ superOver: true }); checked++; }
    expect(checked).toBe(BRACKET_KINDS.size);
    expect(stageDefaultsFor(cricket, "league", "t20")).toEqual({});
  });
  it("CK-SO-1 cricket: every variant whose schema takes a super over gets it; a two-innings test match gets none", () => {
    let on = 0;
    let off = 0;
    for (const variant of Object.keys(cricket.variants)) {
      const takesIt = cricket.configSchema.safeParse({ ...cricket.variants[variant], superOver: true }).success;
      const d = stageDefaultsFor(cricket, "knockout", variant);
      expect(d, variant).toEqual(takesIt ? { superOver: true } : {});
      if (takesIt) on++; else off++;
    }
    expect(on).toBeGreaterThan(0);
    expect(off).toBeGreaterThan(0); // the variant axis refuses something (test)
    expect(on + off).toBe(Object.keys(cricket.variants).length);
  });
  it("a second call hands back a fresh object: mutating one result never reaches the next call or the module's own presets", () => {
    for (const m of [football, hockey, icehockey, cricket]) {
      const first = stageDefaultsFor(m, "knockout", null) as Record<string, any>;
      const frozen = JSON.stringify(first);
      for (const v of Object.values(first)) if (v !== null && typeof v === "object") for (const k of Object.keys(v)) (v as Record<string, unknown>)[k] = "poisoned";
      first.extra = "poisoned";
      expect(JSON.stringify(stageDefaultsFor(m, "knockout", null)), m.key).toBe(frozen);
    }
    expect(hockey.variants["fih-shootout"]!.shootout).toEqual({ attempts: 5, suddenDeath: true, clockSeconds: 8 });
  });
  it("another sport without a hook (the four sets sports): {} everywhere", () => {
    // Single-sport sweep by design: boardgame (Task 8), carrom and generic belong to other tasks, so only the sets sports,
    // which have no decider to preselect, are held to "no hook" here.
    const noHook = ["tennis", "volleyball", "badminton", "tabletennis"];
    let checked = 0;
    for (const key of noHook) {
      const m = builtinModules.find((x) => x.key === key)!;
      expect(m, key).toBeDefined();
      expect(m.stageDefaults, m.key).toBeUndefined();
      for (const kind of StageKind.options)
        for (const variant of [null, ...Object.keys(m.variants)]) { expect(stageDefaultsFor(m, kind, variant), `${m.key}/${kind}/${variant}`).toEqual({}); checked++; }
    }
    expect(checked).toBe(builtinModules.filter((m) => noHook.includes(m.key)).reduce((n, m) => n + StageKind.options.length * (Object.keys(m.variants).length + 1), 0));
    expect(checked).toBeGreaterThan(0);
  });
});
