// W2b Task 11 (UI-1; spec §5.5, §7) — the console's forfeit dialog MODEL: who → why → the engine's credit preview → one
// specific Confirm. `apps/web` vitest is `environment: "node"`, so the wiring (clicks, the POST, the refusal line) is
// e2e/forfeit-dialog.spec.ts's job (AGENTS.md class 2); this file pins what the dialog OFFERS.
//
// Expected values come from the rules, never from the model: Appendix A X-RS-1 / plan D3 R2–R5 for the chips, PF-2 for
// the cascade-only reason (CASCADE_ONLY_FORFEIT_REASONS, read, never retyped), D19 / X-DW-3 for "Neither", and the
// per-sport walkover rows (FB-WO-1, HK-WO-1, BD-WO-1, BG-WO-1, CK-WO-1, GN-WO-1) for the preview.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { foldMatch, FORFEIT_REASONS, type EventEnvelope, type ForfeitReason } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import { CASCADE_ONLY_FORFEIT_REASONS } from "@/lib/forfeit-phase-refusal";
import {
  forfeitBaseState,
  forfeitConfirmBlocked,
  forfeitDialogModel,
  forfeitPayload,
  pickForfeit,
  NO_FORFEIT_PICK,
  type ForfeitSelection,
  type ForfeitWho,
} from "../forfeit-dialog";

type Module = (typeof builtinModules)[number];
const mod = (k: string): Module => {
  const m = builtinModules.find((x) => x.key === k);
  if (!m) throw new Error(`no module ${k}`);
  return m;
};
const firstCfg = (m: Module) => m.configSchema.parse(Object.values(m.variants)[0] ?? {});
const ev = (seq: number, type: string, payload: unknown = {}, voids?: string): EventEnvelope => makeEnvelope(seq, { type, payload }, voids);
const DRAWN = { type: "boardgame.result", payload: { winner: null, method: "agreement" } } as const;
const chessKoCfg = () => {
  const m = mod("boardgame");
  return m.configSchema.parse({ ...m.bracketDeciders!(m.configSchema.parse({})) });
};

/** A fixture as the console holds it: the module, its cfg, the folded state and the ledger it was folded from. */
function fixtureOf(key: string, ledger: (l: ReturnType<typeof defaultLineupPair>) => EventEnvelope[], cfg?: unknown) {
  const m = mod(key);
  const l = defaultLineupPair(m.positions);
  const c = cfg ?? firstCfg(m);
  const events = ledger(l);
  return { m, cfg: c, l, events, state: foldMatch(m, c as never, l, events) };
}
const PRE = () => [];
const STARTED = () => [ev(1, "core.start")];
const model = (fx: { m: Module; cfg: unknown; state: unknown }, noNextMatch = false) => forfeitDialogModel(fx.m, fx.cfg, fx.state, { noNextMatch });

describe("UI-1 forfeit dialog model (spec §5.5)", () => {
  it("empty case first: a decided fixture offers nothing — no side, no reason, no guidance", () => {
    const done = fixtureOf("generic", (l) => [ev(1, "core.start"), ev(2, "core.forfeit", { by: l.away.entrantId, reason: "retired" })]);
    const d = model(done);
    expect(d.who).toEqual([]);
    for (const who of ["home", "away", "both"] as const) expect(d.why(who), who).toEqual([]);
    expect(d.guidance).toBeNull();
  });

  it("X-RS-1: before play — Home, Away, Neither; a side walks over (withdrew is the cascade's, never offered); Neither only walks over", () => {
    const d = model(fixtureOf("generic", PRE));
    expect(d.who).toEqual(["home", "away", "both"]);
    expect(d.why("home")).toEqual(["walkover"]);
    expect(d.why("away")).toEqual(["walkover"]);
    expect(d.why("both")).toEqual(["walkover"]);
    expect(d.guidance).toBeNull();
  });

  it("X-RS-1: after play started — no Neither; retired or disqualified", () => {
    const d = model(fixtureOf("generic", STARTED));
    expect(d.who).toEqual(["home", "away"]);
    expect(d.why("away")).toEqual(["retired", "disqualified"]);
    expect(d.why("both"), "Neither is not a choice once play started").toEqual([]);
  });

  it("X-RS-1 after a void: voiding the start takes the match back before play — Neither and the walkover return", () => {
    // The take-back sequence (TEST-STRATEGY rule 1): start, then void the start.
    const d = model(fixtureOf("generic", () => [ev(1, "core.start"), ev(2, "core.void", {}, "e-1")]));
    expect(d.who).toEqual(["home", "away", "both"]);
    expect(d.why("away")).toEqual(["walkover"]);
  });

  it("PF-2: no sport, in no phase, offers a cascade-only reason (withdrew) for any side", () => {
    expect(CASCADE_ONLY_FORFEIT_REASONS, "the list this sweep guards is the server's own").toContain("withdrew");
    let offered = 0;
    let sports = 0;
    for (const m of builtinModules) {
      sports++;
      const scenes = [fixtureOf(m.key, PRE), fixtureOf(m.key, STARTED)];
      if (m.key === "boardgame") scenes.push(fixtureOf(m.key, () => [ev(1, "core.start"), ev(2, DRAWN.type, DRAWN.payload)], chessKoCfg()));
      for (const fx of scenes) {
        for (const noNextMatch of [false, true]) {
          const d = model(fx, noNextMatch);
          for (const who of d.who) {
            const why = d.why(who);
            offered += why.length;
            for (const r of CASCADE_ONLY_FORFEIT_REASONS) expect(why, `${m.key} ${who}`).not.toContain(r);
          }
        }
      }
    }
    expect(sports).toBe(builtinModules.length);
    expect(offered, `reasons offered and checked: ${offered}`).toBeGreaterThan(0);
  });

  it("X-DW-3: a final shows the guidance instead of Neither", () => {
    const d = model(fixtureOf("generic", PRE), true);
    expect(d.who).toEqual(["home", "away"]);
    expect(d.why("both")).toEqual([]);
    expect(d.guidance).toBe("noNextMatch");
    // The pairs: the same fixture with a next match offers Neither and no guidance; a final after the start has no
    // Neither to replace, so no guidance either.
    expect(model(fixtureOf("generic", PRE), false).guidance).toBeNull();
    expect(model(fixtureOf("generic", STARTED), true).guidance).toBeNull();
  });

  it("X-WO-1: the preview is the engine's credit — hockey walkover reads 5–0 against the away side", () => {
    // HK-WO-1 (FIH GTR Reg 13.1): 5-0. The played score before play is 0-0, so a preview of the played score fails.
    const d = model(fixtureOf("hockey", PRE));
    expect(d.preview("away", "walkover")).toEqual({ home: "5", away: "0" });
    expect(d.preview("home", "walkover"), "the mirror: the home side walked over").toEqual({ home: "0", away: "5" });
    expect(d.preview("both", "walkover"), "a double walkover credits nothing (X-DW-4)").toBeNull();
  });

  it("X-WO-1: the preview reads each family's headline metric — goals, games, the board point; nothing credited reads as none", () => {
    // One sport per family, each expectation its Appendix A walkover row.
    const ROWS: [key: string, row: string, want: { home: string; away: string } | null][] = [
      ["football", "FB-WO-1 (FDC Art. 28.1) 3-0", { home: "3", away: "0" }],
      ["badminton", "BD-WO-1 2-0 games", { home: "2", away: "0" }],
      ["boardgame", "BG-WO-1 (FIDE C.07) 1-0", { home: "1", away: "0" }],
      ["cricket", "CK-WO-1 full points, no runs credited", null],
      ["generic", "GN-WO-1 win points, 0-0", null],
    ];
    let checked = 0;
    for (const [key, row, want] of ROWS) {
      expect(model(fixtureOf(key, PRE)).preview("away", "walkover"), `${key}: ${row}`).toEqual(want);
      checked++;
    }
    expect(checked).toBe(ROWS.length);
  });

  it("X-WO-1: the headline metric is each module's FIRST declared metric (its table's own order)", () => {
    // Typed from each sport's table (doc 09 §2): goals for goal sports, sets/games won for set sports, the board point
    // for chess, runs for cricket, the generic for/against.
    const HEADLINE: Record<string, string> = {
      football: "gf", hockey: "gf", icehockey: "gf",
      volleyball: "sets_won", badminton: "sets_won", tabletennis: "sets_won", tennis: "sets_won", carrom: "sets_won",
      boardgame: "wins", cricket: "runs_for", generic: "for",
    };
    let checked = 0;
    for (const m of builtinModules) {
      expect(m.metrics[0]?.key, m.key).toBe(HEADLINE[m.key]);
      checked++;
    }
    expect(Object.keys(HEADLINE).sort()).toEqual(builtinModules.map((m) => m.key).sort());
    expect(checked).toBe(builtinModules.length);
  });

  it("X-RS-1: after play the preview is the engine's credit at the played score, never the played score itself", () => {
    // FB-RT-1 (FDC Art. 28): a retirement at 1-0 for the home side credits the awarded 3-0 (the real margin is not worse).
    const fx = fixtureOf("football", (l) => [ev(1, "core.start"), ev(2, "football.goal", { by: l.home.entrantId })]);
    expect(fx.m.summary(fx.state as never).headline, "the rig scored the goal: the played score is 1-0").toBe("1 — 0");
    expect(model(fx).preview("away", "retired")).toEqual({ home: "3", away: "0" });
  });

  it("BG-WO-3: a chess fixture whose tie-break is pending offers one side's walkover, retirement or disqualification, never Neither", () => {
    // R14 (W2b-R14 / BG-WO-3): a walkover in the tie-break; R4: retired / disqualified once play started; R3: never
    // both in a tie-break — the classical game was played. Withdrew stays the cascade's (PF-2).
    const fx = fixtureOf("boardgame", () => [ev(1, "core.start"), ev(2, DRAWN.type, DRAWN.payload)], chessKoCfg());
    const d = model(fx);
    expect(d.who).toEqual(["home", "away"]);
    expect(d.why("home")).toEqual(["walkover", "retired", "disqualified"]);
    expect(d.guidance, "no Neither is replaced: the tie-break never offers one").toBeNull();
    expect(model(fx, true).guidance).toBeNull();
  });

  it("X-RS-1: one specific Confirm per reason", () => {
    const d = model(fixtureOf("generic", STARTED));
    expect(d.confirmKey("away", "retired")).toBe("forfeitDialog.confirm.retired");
    expect(d.confirmKey("away", "disqualified")).toBe("forfeitDialog.confirm.disqualified");
    expect(d.confirmKey("home", "walkover")).toBe("forfeitDialog.confirm.walkover");
    expect(d.confirmKey("both", "walkover")).toBe("forfeitDialog.confirm.doubleWalkover");
    // The union keeps withdrew's key (spec), unreachable from this dialog: no phase offers the reason (PF-2 above).
    expect(d.confirmKey("home", "withdrew")).toBe("forfeitDialog.confirm.withdrew");
    const keys = new Set(FORFEIT_REASONS.map((r) => d.confirmKey("home", r)));
    expect(keys.size, "four reasons, four different Confirms").toBe(FORFEIT_REASONS.length);
  });

  it("the scheduled shape: the page serves state null before kickoff, read as the module's own init — before play for every sport", () => {
    let checked = 0;
    for (const m of builtinModules) {
      const l = defaultLineupPair(m.positions);
      const base = forfeitBaseState(m, firstCfg(m), null, l);
      const d = forfeitDialogModel(m, firstCfg(m), base, { noNextMatch: false });
      expect(d.who, m.key).toEqual(["home", "away", "both"]);
      expect(d.why("away"), m.key).toEqual(["walkover"]);
      checked++;
    }
    expect(checked).toBe(builtinModules.length);
    // A served state is used as it is — never replaced by the init.
    const started = fixtureOf("generic", STARTED);
    expect(forfeitBaseState(started.m, started.cfg, started.state, started.l)).toBe(started.state);
  });
});

describe("UI-1 forfeit dialog selection (Confirm gating, the payload)", () => {
  it("Confirm stays blocked until who AND why are chosen, and while sending", () => {
    const d = model(fixtureOf("generic", STARTED));
    let s: ForfeitSelection = NO_FORFEIT_PICK;
    expect(forfeitConfirmBlocked(d, s, false), "nothing chosen").toBe(true);
    s = pickForfeit(d, s, { kind: "who", who: "away" });
    expect(forfeitConfirmBlocked(d, s, false), "who only").toBe(true);
    s = pickForfeit(d, s, { kind: "why", reason: "retired" });
    expect(forfeitConfirmBlocked(d, s, false)).toBe(false);
    expect(forfeitConfirmBlocked(d, s, true), "while sending").toBe(true);
    expect(forfeitPayload(s, { home: "H", away: "A" })).toEqual({ by: "A", reason: "retired" });
    // A reason the phase does not offer is not taken, and a side the dialog does not offer is not taken either.
    expect(pickForfeit(d, s, { kind: "why", reason: "walkover" })).toBe(s);
    expect(pickForfeit(d, s, { kind: "who", who: "both" })).toBe(s);
    // Changing the side keeps a reason the new side is offered; Neither names nobody.
    const pre = model(fixtureOf("generic", PRE));
    const both = pickForfeit(pre, pickForfeit(pre, pickForfeit(pre, NO_FORFEIT_PICK, { kind: "who", who: "home" }), { kind: "why", reason: "walkover" }), { kind: "who", who: "both" });
    expect(both).toEqual({ who: "both", reason: "walkover" });
    expect(forfeitPayload(both, { home: "H", away: "A" })).toEqual({ by: "both", reason: "walkover" });
  });

  it("rule 10: any sequence of taps keeps the selection offered, never picks withdrew, and every Confirmable choice is one the engine records", () => {
    const KEYS = builtinModules.map((m) => m.key);
    type Scene = "pre" | "play" | "tiebreak";
    const sceneArb = fc.constantFrom<Scene>("pre", "play", "tiebreak");
    const pickArb = fc.oneof(
      fc.record({ kind: fc.constant("who" as const), who: fc.constantFrom<ForfeitWho>("home", "away", "both") }),
      fc.record({ kind: fc.constant("why" as const), reason: fc.constantFrom<ForfeitReason>(...FORFEIT_REASONS) }),
    );
    let steps = 0;
    let confirmable = 0;
    fc.assert(
      fc.property(fc.constantFrom(...KEYS), sceneArb, fc.boolean(), fc.array(pickArb, { minLength: 1, maxLength: 12 }), (key, scene, noNextMatch, picks) => {
        const chess = key === "boardgame";
        const ledger = scene === "pre" ? PRE : scene === "play" || !chess ? STARTED : () => [ev(1, "core.start"), ev(2, DRAWN.type, DRAWN.payload)];
        const fx = fixtureOf(key, ledger, chess && scene === "tiebreak" ? chessKoCfg() : undefined);
        const d = model(fx, noNextMatch);
        let s: ForfeitSelection = NO_FORFEIT_PICK;
        for (const p of picks) {
          // The picks are any taps a screen could carry, including a withdrew no chip offers (the type forbids it; a
          // stale or synthetic tap could still arrive).
          s = pickForfeit(d, s, p as never);
          steps++;
          if (s.who !== null) expect(d.who).toContain(s.who);
          if (s.reason !== null) {
            expect(s.who).not.toBeNull();
            expect(d.why(s.who!)).toContain(s.reason);
            expect(CASCADE_ONLY_FORFEIT_REASONS as readonly string[]).not.toContain(s.reason);
          }
          if (!forfeitConfirmBlocked(d, s, false)) {
            confirmable++;
            const payload = forfeitPayload(s, { home: fx.l.home.entrantId, away: fx.l.away.entrantId });
            // The engine's own guard records what Confirm would send (D19 lives on the server; Neither is not offered
            // on a final, so it never reaches here with noNextMatch).
            expect(() => foldMatch(fx.m, fx.cfg as never, fx.l, [...fx.events, ev(fx.events.length + 1, "core.forfeit", payload)])).not.toThrow();
            if (noNextMatch) expect(payload.by).not.toBe("both");
          }
        }
      }),
      { numRuns: 200, seed: 1_011_011 },
    );
    expect(steps, `taps checked: ${steps}`).toBeGreaterThan(0);
    expect(confirmable, `confirmable choices folded through the engine: ${confirmable}`).toBeGreaterThan(0);
  });
});
