// R4 sponsors on stream, S5 — `replayDerived` also reports the WHOLE fixture's natural breaks (spec 2026-10-27 §3.1,
// §3.2): every break each applied event opens, asked of the sport's own `naturalBreaks.opensAt` with the REAL envelope
// and the states either side of `apply`, and sized by the sport's own declaration. The planner (S4) reads them as its
// `breaks` input, so a wrong seq, a wrong time, a swapped before/after or a missed event is a sponsor card at the wrong
// break, or none.
//
// Expectations come from the sport's laws as the engine declares them (FIH: an interval after Q1 and Q3, half-time after
// Q2, a break before a shoot-out; the restart after a goal) and from `naturalBreaks.kinds` for every size — never from
// this file's code under test.
//
// The transitions (TEST-STRATEGY rule 1): a break per whistle; a goal; a void (the struck event opens nothing); an empty
// ledger; a sport that declares no breaks; breaks before the `recent` window; a refusal part-way; an `opensAt` that throws
// (the replay's own annotations survive it). Two sports by name (hockey — the shoot-out break — and badminton), then a
// sweep over every builtin module.
import { describe, expect, it, vi } from "vitest";
import { foldMatch, type EventEnvelope } from "@seazn/engine/core";
import { buildStream, defaultLineupPair, makeEnvelope, SIM_CONFIGS } from "@seazn/engine/testkit";
import { builtinModules } from "@seazn/engine/sports";
import { log } from "@/server/logger";
import { sponsorMomentId } from "@/lib/sponsor-plan";
import { replayDerived } from "../recent";

const moduleFor = (key: string) => {
  const m = builtinModules.find((mod) => mod.key === key);
  if (!m) throw new Error(`no builtin module for "${key}"`);
  return m;
};
const HOCKEY_SHOOTOUT = "fih-shootout";
const cfgOf = (key: string, variant?: string) => {
  const mod = moduleFor(key);
  return mod.configSchema.parse(variant === undefined ? (SIM_CONFIGS[key] ?? {}) : mod.variants[variant]);
};
/** The size the SPORT declares for a kind — the authority every size below is checked against. */
const declaredSize = (key: string, kind: string) => {
  const decl = moduleFor(key).naturalBreaks?.kinds.find((k) => k.kind === kind);
  if (decl === undefined) throw new Error(`${key} declares no natural break "${kind}"`);
  return decl.size;
};

const T0 = Date.parse("2026-10-31T14:00:00.000Z");
/** One event per minute, so every break's time is its own event's and a mix-up shows. */
const atOf = (seq: number) => new Date(T0 + seq * 60_000).toISOString();

function ledger(key: string, cfg: unknown, stream: readonly (readonly [string, unknown, string?])[]): EventEnvelope[] {
  const mod = moduleFor(key);
  const events: EventEnvelope[] = stream.map(([type, payload, voids], i) => ({
    ...makeEnvelope(i + 1, { type, payload } as never, voids),
    recordedAt: atOf(i + 1),
  }));
  // Folding first is the assertion that every payload is one the engine accepts.
  foldMatch(mod as never, cfg as never, defaultLineupPair(mod.positions), events);
  return events;
}

function replay(key: string, cfg: unknown, events: readonly EventEnvelope[], window?: number) {
  const mod = moduleFor(key);
  return replayDerived({ sportKey: key, module: mod as never, cfg, lineups: defaultLineupPair(mod.positions), active: events, window });
}

const adv = (to: string) => ["hockey.period.advance", { to }] as const;
/** FIH's shoot-out variant, level after four quarters: the four whistles open Q1→Q2, Q2→Q3 (half-time), Q3→Q4 and the
 *  break before the shoot-out. */
const HOCKEY_TO_SHOOTOUT = [["core.start", {}], adv("Q2"), adv("Q3"), adv("Q4"), adv("FT")] as const;

describe("replayDerived — the fixture's natural breaks", () => {
  it("hockey (FIH shoot-out): a break per whistle, at its own event's seq and time, sized by the sport", () => {
    const cfg = cfgOf("hockey", HOCKEY_SHOOTOUT);
    const events = ledger("hockey", cfg, HOCKEY_TO_SHOOTOUT);
    const r = replay("hockey", cfg, events);
    expect(r.complete).toBe(true);
    expect(r.breaksComplete).toBe(true);
    const want = [
      { seq: 2, kind: "quarter_end" },
      { seq: 3, kind: "half_time" },
      { seq: 4, kind: "quarter_end" },
      { seq: 5, kind: "shootout_break" },
    ].map((b) => ({ ...b, at: atOf(b.seq), size: declaredSize("hockey", b.kind) }));
    expect(r.breaks).toEqual(want);
    // The shoot-out break is a MAJOR (PO ruling, S1/S2): read from the declaration, and checked not to be a minor.
    expect(r.breaks.at(-1)?.size).toBe("major");
  });

  it("a goal that leaves the match live opens the restart (after_goal): the states are handed over the right way round", () => {
    const cfg = cfgOf("hockey", HOCKEY_SHOOTOUT);
    const events = ledger("hockey", cfg, [["core.start", {}], ["hockey.goal", { by: "H" }], adv("Q2")]);
    const r = replay("hockey", cfg, events);
    expect(r.breaks.map((b) => [b.seq, b.kind, b.size])).toEqual([
      [2, "after_goal", declaredSize("hockey", "after_goal")],
      [3, "quarter_end", declaredSize("hockey", "quarter_end")],
    ]);
    expect(declaredSize("hockey", "after_goal"), "premise: the restart is a minor break").toBe("minor");
  });

  it("a voided whistle opens nothing, and neither does its void; the next whistle keeps its own seq", () => {
    const cfg = cfgOf("hockey", HOCKEY_SHOOTOUT);
    // The envelope's `voids` names the struck event's id (`makeEnvelope`'s `e-<seq>`): the goal at seq 2.
    const events = ledger("hockey", cfg, [["core.start", {}], ["hockey.goal", { by: "H" }], ["core.void", {}, "e-2"], adv("Q2")]);
    const r = replay("hockey", cfg, events);
    expect(r.breaks).toEqual([{ seq: 4, kind: "quarter_end", at: atOf(4), size: declaredSize("hockey", "quarter_end") }]);
    // The positive pair: the same goal, NOT voided, does open its restart.
    expect(replay("hockey", cfg, events.slice(0, 2)).breaks.map((b) => b.kind)).toEqual(["after_goal"]);
  });

  it("the empty ledger, and a sport that declares no breaks, report none — and a complete replay", () => {
    const cfg = cfgOf("hockey", HOCKEY_SHOOTOUT);
    const none = replay("hockey", cfg, []);
    expect(none).toMatchObject({ breaks: [], complete: true, breaksComplete: true });
    expect(moduleFor("generic").naturalBreaks, "premise: generic declares none (spec §3.1)").toBeUndefined();
    const g = replay("generic", cfgOf("generic"), ledger("generic", cfgOf("generic"), [["core.start", {}], ["generic.score", { by: "H", points: 1 }]]));
    expect(g).toMatchObject({ breaks: [], breaksComplete: true });
  });

  it("breaks BEFORE the recent window are reported too: the dial counts the whole fixture (plan P2)", () => {
    const cfg = cfgOf("hockey", HOCKEY_SHOOTOUT);
    const events = ledger("hockey", cfg, HOCKEY_TO_SHOOTOUT);
    const r = replay("hockey", cfg, events, 1);
    expect(r.breaks.map((b) => b.seq)).toEqual([2, 3, 4, 5]);
  });

  it("a module that refuses part-way: the breaks stop where it stopped, and the replay says they are incomplete (R3)", () => {
    const cfg = cfgOf("hockey", HOCKEY_SHOOTOUT);
    const mod = moduleFor("hockey");
    const events = ledger("hockey", cfg, HOCKEY_TO_SHOOTOUT);
    const refusing = { ...(mod as object), apply: (s: unknown, e: EventEnvelope, ctx: unknown) => {
      if (e.seq === 4) throw new Error("refused");
      return (mod.apply as (a: unknown, b: unknown, c: unknown) => unknown)(s, e, ctx);
    } };
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined as never);
    try {
      const r = replayDerived({ sportKey: "hockey", module: refusing as never, cfg, lineups: defaultLineupPair(mod.positions), active: events });
      expect(r.complete).toBe(false);
      expect(r.breaksComplete).toBe(false);
      expect(r.breaks.map((b) => b.seq)).toEqual([2, 3]);
    } finally {
      warn.mockRestore();
    }
  });

  it("an opensAt that THROWS costs the sponsor breaks only: the set-won annotation survives, the breaks say incomplete", () => {
    // Badminton's game end is the engine's own (no "21" typed here): rally until the replay itself reports a set won.
    const mod = moduleFor("badminton");
    const cfg = cfgOf("badminton");
    const rallies = Array.from({ length: 60 }, () => ["badminton.rally", { wonBy: "H" }] as const);
    const events = ledger("badminton", cfg, [["core.start", {}], ...rallies.slice(0, 40)]);
    const good = replay("badminton", cfg, events, 60);
    const wonAt = [...good.bySeq].find(([, d]) => d.setWon !== undefined)?.[0];
    expect(wonAt, "premise: a game closes inside 40 unanswered rallies").toBeDefined();
    expect(good.breaks.some((b) => b.seq === wonAt), "premise: the game's end is a break").toBe(true);

    const throwing = { ...(mod as object), naturalBreaks: { kinds: mod.naturalBreaks!.kinds, opensAt: () => { throw new Error("boom"); } } };
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined as never);
    try {
      const r = replayDerived({ sportKey: "badminton", module: throwing as never, cfg, lineups: defaultLineupPair(mod.positions), active: events, window: 60 });
      expect(r.complete, "the replay itself ran to the end").toBe(true);
      expect(r.bySeq.get(wonAt!)?.setWon).toEqual(good.bySeq.get(wonAt!)?.setWon);
      expect(r.breaks).toEqual([]);
      expect(r.breaksComplete).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * The ORACLE, independent of the engine's declarations and of `breakSizeOf`: spec 2026-10-27 §3.1's kind list, as
 * amended by S5 against engine 1.1.0 (football, hockey and ice hockey gained `shootout_break`, a major — PO ruling S1/S2).
 * Typed from the SPEC, so a module that re-sizes or renames a kind disagrees with it instead of moving it.
 */
const SPEC_3_1: Record<string, Record<string, "minor" | "major">> = {
  cricket: { over_end: "minor", innings_break: "major" },
  football: { half_time: "major", period_end: "major", shootout_break: "major", after_goal: "minor" },
  hockey: { quarter_end: "major", half_time: "major", shootout_break: "major", after_goal: "minor" },
  icehockey: { period_end: "major", shootout_break: "major", after_goal: "minor" },
  tennis: { changeover: "minor", set_end: "major" },
  badminton: { interval: "minor", game_end: "major" },
  tabletennis: { timeout: "minor", game_end: "major" },
  volleyball: { timeout: "minor", set_end: "major" },
};

describe("replayDerived — natural-break sweep over every builtin module", () => {
  it("the modules declare exactly spec §3.1's kinds at its sizes, and the three it names declare none", () => {
    let pairs = 0;
    for (const mod of builtinModules) {
      const spec = SPEC_3_1[mod.key];
      if (spec === undefined) {
        expect(mod.naturalBreaks, `${mod.key}: the spec names no breaks for it`).toBeUndefined();
        continue;
      }
      expect(Object.fromEntries((mod.naturalBreaks?.kinds ?? []).map((k) => [k.kind, k.size])), mod.key).toEqual(spec);
      pairs += Object.keys(spec).length;
    }
    expect(pairs, `${pairs} sport/kind pairs`).toBe(21);
    expect(builtinModules.filter((m) => SPEC_3_1[m.key] === undefined).map((m) => m.key).sort()).toEqual(["boardgame", "carrom", "generic"]);
  });

  it("every break is a spec kind at the SPEC's size, ascending, one moment id each, and every seed replays whole; 8 modules declare breaks", () => {
    let seedsReplayed = 0;
    let modulesWithBreaks = 0;
    let modulesWithout = 0;
    let breaksChecked = 0;
    const reached = new Set<string>();
    for (const mod of builtinModules) {
      const cfg = cfgOf(mod.key);
      const lineups = defaultLineupPair(mod.positions);
      const spec = SPEC_3_1[mod.key] ?? {};
      if (mod.naturalBreaks === undefined) modulesWithout++;
      else modulesWithBreaks++;
      for (let seed = 1; seed <= 6; seed++) {
        const events = buildStream(mod as never, cfg as never, lineups, seed, 400).map((e) => ({ ...e, recordedAt: atOf(e.seq) }));
        const r = replayDerived({ sportKey: mod.key, module: mod as never, cfg, lineups, active: events });
        // A truncated replay (a refusal, an `opensAt` that threw) would leave the checks below passing on what it DID see.
        expect(r.complete, `${mod.key} seed ${seed}: the replay ran to the end`).toBe(true);
        expect(r.breaksComplete, `${mod.key} seed ${seed}: every opensAt answered`).toBe(true);
        seedsReplayed++;
        const ids = new Set<string>();
        let last = Number.NEGATIVE_INFINITY;
        for (const b of r.breaks) {
          breaksChecked++;
          expect(b.size, `${mod.key} seed ${seed}: ${b.kind} at the spec's size`).toBe(spec[b.kind]);
          expect(b.seq, `${mod.key}: ascending`).toBeGreaterThanOrEqual(last);
          last = b.seq;
          const id = sponsorMomentId(b.seq, b.kind);
          expect(ids.has(id), `${mod.key}: ${id} once`).toBe(false);
          ids.add(id);
          const ev = events.find((e) => e.seq === b.seq);
          expect(b.at, `${mod.key}: the break's time is its event's`).toBe(ev?.recordedAt);
          reached.add(`${mod.key}:${b.kind}`);
        }
        if (mod.naturalBreaks === undefined) expect(r.breaks, `${mod.key} declares no breaks`).toEqual([]);
      }
    }
    expect(seedsReplayed, "every module × 6 seeds").toBe(builtinModules.length * 6);
    expect(modulesWithBreaks).toBe(8);
    expect(modulesWithout).toBe(builtinModules.length - 8);
    expect(breaksChecked, `${breaksChecked} breaks checked over ${modulesWithBreaks} modules, ${reached.size} kinds reached`).toBeGreaterThan(0);
    // Every declaring module reached at least one break: a sweep that never saw a sport's break checked nothing for it.
    const sportsReached = new Set([...reached].map((k) => k.split(":")[0]));
    expect([...sportsReached].sort()).toEqual(builtinModules.filter((m) => m.naturalBreaks !== undefined).map((m) => m.key).sort());
  });
});
