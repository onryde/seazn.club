// W2b Task 11 (UI-1; spec §5.5, §7) — the console's forfeit dialog MODEL: who → why → the engine's credit preview → one
// specific Confirm. `apps/web` vitest is `environment: "node"`, so the wiring (clicks, the POST, the refusal line) is
// e2e/forfeit-dialog.spec.ts's job (AGENTS.md class 2); this file pins what the dialog OFFERS.
//
// Expected values come from the rules, never from the model: Appendix A X-RS-1 / plan D3 R2–R5 for the chips, PF-2 for
// the cascade-only reason (CASCADE_ONLY_FORFEIT_REASONS, read, never retyped), D19 / X-DW-3 for "Neither", and the
// per-sport walkover rows (FB-WO-1, HK-WO-1, BD-WO-1, BG-WO-1, CK-WO-1, GN-WO-1) for the preview.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { pointsRuleAwardReachesTable } from "@seazn/engine/competition";
import { foldMatch, FORFEIT_REASONS, type EventEnvelope, type ForfeitReason } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { defaultLineupPair, makeEnvelope, onePlayEvent } from "@seazn/engine/testkit";
import { CASCADE_ONLY_FORFEIT_REASONS } from "@/lib/forfeit-phase-refusal";
import {
  forfeitBaseState,
  forfeitConfirmBlocked,
  forfeitDialogModel,
  forfeitPayload,
  forfeitPlayRecorded,
  forfeitPreviewNow,
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
/** The ledger as the console holds it (fixture-console.tsx `EventIn`): a void names its target in `voids_event_id`. */
const rowsOf = (events: readonly EventEnvelope[]) => events.map((e) => ({ id: e.id, seq: e.seq, type: e.type, voids_event_id: e.voids ?? null }));
/** Ruling 112: the start, then ONE real sport event — the module's own generator draws it (never a typed event name),
 *  under the first cfg or, for chess (whose one event decides a plain game), the bracket deciders' held draw. */
function playedOf(key: string) {
  const m = mod(key);
  const l = defaultLineupPair(m.positions);
  const base = firstCfg(m);
  for (const cfg of [base, m.configSchema.parse({ ...(base as object), ...m.bracketDeciders(base as never) })]) {
    const played = onePlayEvent(m, cfg, l, STARTED());
    if (played !== null) return fixtureOf(key, () => [...STARTED(), played], cfg);
  }
  throw new Error(`${key}: its generator draws no sport event after the start`);
}
/** The dialog's model for a fixture, fed the console's own reading of its ledger (`forfeitPlayRecorded`). */
const model = (fx: { m: Module; cfg: unknown; state: unknown; events: readonly EventEnvelope[] }, noNextMatch = false) =>
  forfeitDialogModel(fx.m, fx.cfg, fx.state, { noNextMatch, playRecorded: forfeitPlayRecorded(rowsOf(fx.events), fx.m) });

describe("UI-1 forfeit dialog model (spec §5.5)", () => {
  it("empty case first: a decided fixture offers nothing — no side, no reason, no guidance", () => {
    // Ruling 113: after a bare start the forfeit that decides is a disqualification (a retirement needs play).
    const done = fixtureOf("generic", (l) => [ev(1, "core.start"), ev(2, "core.forfeit", { by: l.away.entrantId, reason: "disqualified" })]);
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

  it("X-RS-1 (rulings 112, 113): after Start with nothing played — Home, Away, Neither; a side walks over or is disqualified, never retires", () => {
    // Ruling 112: the walkover (and Neither) reads "pre" until something is played; a disqualification is recordable
    // from the Start (R4). Ruling 113: a retirement only once something is played — nobody retires from a match never
    // played. The organiser who pressed Start for a no-show records the walkover.
    const d = model(fixtureOf("generic", STARTED));
    expect(d.who).toEqual(["home", "away", "both"]);
    expect(d.why("away")).toEqual(["walkover", "disqualified"]);
    expect(d.why("both")).toEqual(["walkover"]);
  });

  it("X-RS-1 (ruling 112): once the sport's own event is played — no Neither; retired or disqualified", () => {
    const d = model(playedOf("generic"));
    expect(d.who).toEqual(["home", "away"]);
    expect(d.why("away")).toEqual(["retired", "disqualified"]);
    expect(d.why("both"), "Neither is not a choice once something is played").toEqual([]);
  });

  it("X-RS-1 (ruling 112): the console's reading of its ledger rows is the engine's — seq order, not array order; a void by `voids_event_id`; the empty ledger is nothing played", () => {
    // Expected values from the ruling's text: a sport event after an active start is play; a voided one is not.
    const played = playedOf("generic");
    const m = played.m;
    const rows = rowsOf(played.events);
    expect(forfeitPlayRecorded([], m), "empty ledger").toBe(false);
    expect(forfeitPlayRecorded(rowsOf(STARTED()), m), "a bare start").toBe(false);
    expect(forfeitPlayRecorded(rows, m), "start, then the sport's own event").toBe(true);
    expect(forfeitPlayRecorded([...rows].reverse(), m), "the same rows out of array order").toBe(true);
    const voided = rowsOf([...played.events, ev(3, "core.void", {}, played.events[1]!.id)]);
    expect(forfeitPlayRecorded(voided, m), "the event voided").toBe(false);
    expect(forfeitPlayRecorded([...voided].reverse(), m), "the void read before its target").toBe(false);
  });

  it("ruling 118: the console asks the fixture's own module — in chess a bare Start is play, until the Start is voided; out of array order too", () => {
    // Ruling 118 (owner "A", 2026-10-12): in chess Start means play has begun — Seazn records no moves. The module says
    // so (`startIsPlay`); the console passes it through, so the dialog reads what the fold guard reads.
    const chess = mod("boardgame");
    expect(chess.startIsPlay, "chess declares its Start play").toBe(true);
    const started = rowsOf(STARTED());
    expect(forfeitPlayRecorded([], chess), "chess: empty ledger").toBe(false);
    expect(forfeitPlayRecorded(started, chess), "chess: a bare start").toBe(true);
    const unstarted = rowsOf([...STARTED(), ev(2, "core.void", {}, "e-1")]);
    expect(forfeitPlayRecorded(unstarted, chess), "chess: the start voided").toBe(false);
    expect(forfeitPlayRecorded([...unstarted].reverse(), chess), "chess: the void read before the start").toBe(false);
    // The positive pair: the same bare start, asked of a module declaring nothing, is nothing played.
    expect(forfeitPlayRecorded(started, mod("generic")), "generic: a bare start").toBe(false);
  });

  it("BG-WO-3 + ruling 118: a chess fixture after a bare Start offers one side's walkover, retirement or disqualification, and Neither; the Start voided takes the retirement back", () => {
    // Single-sport: boardgame is the one module declaring its Start play. After the Start every reason is recordable for
    // one side (walkover: chess's wide phases, FIDE 6.7.1; retired and disqualified: ruling 118); Neither stays (a double
    // walkover in phase play, R1/R3). Withdrew stays the cascade's (PF-2). Before the Start: the walkover only.
    const started = model(fixtureOf("boardgame", STARTED));
    expect(started.who).toEqual(["home", "away", "both"]);
    expect(started.why("away")).toEqual(["walkover", "retired", "disqualified"]);
    expect(started.why("both")).toEqual(["walkover"]);
    expect(model(fixtureOf("boardgame", PRE)).why("away"), "before the Start").toEqual(["walkover"]);
    const voided = model(fixtureOf("boardgame", () => [...STARTED(), ev(2, "core.void", {}, "e-1")]));
    expect(voided.why("away"), "the Start voided").toEqual(["walkover"]);
  });

  it("X-RS-1 (rulings 112, 113) after a void: voiding the one played event, or the start, takes the match back to nothing played — Neither and the walkover return, the retirement goes", () => {
    // The take-back sequences (TEST-STRATEGY rule 1): start, play, void the play; and start, void the start.
    const played = playedOf("generic");
    const back = model(fixtureOf("generic", () => [...played.events, ev(3, "core.void", {}, played.events[1]!.id)]));
    expect(back.who).toEqual(["home", "away", "both"]);
    expect(back.why("away")).toEqual(["walkover", "disqualified"]);
    const unstarted = model(fixtureOf("generic", () => [ev(1, "core.start"), ev(2, "core.void", {}, "e-1")]));
    expect(unstarted.who).toEqual(["home", "away", "both"]);
    expect(unstarted.why("away")).toEqual(["walkover"]);
  });

  it("PF-2: no sport, in no phase, offers a cascade-only reason (withdrew) for any side", () => {
    expect(CASCADE_ONLY_FORFEIT_REASONS, "the list this sweep guards is the server's own").toContain("withdrew");
    let offered = 0;
    let sports = 0;
    for (const m of builtinModules) {
      sports++;
      const scenes = [fixtureOf(m.key, PRE), fixtureOf(m.key, STARTED), playedOf(m.key)];
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
    // The pairs: the same fixture with a next match offers Neither and no guidance; a final once something is played
    // has no Neither to replace, so no guidance either — but after a bare start it still has (ruling 112).
    expect(model(fixtureOf("generic", PRE), false).guidance).toBeNull();
    expect(model(playedOf("generic"), true).guidance).toBeNull();
    expect(model(fixtureOf("generic", STARTED), true).guidance).toBe("noNextMatch");
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

  // X-WO-1 part B (Task 16b): the console previews "the credit the table will carry". Under a stage points rule that awards
  // a walkover score, the table carries the RULE's number for a forfeit with nothing played, so the preview says that one.
  describe("X-WO-1 B: the preview reads the stage rule's award where the forfeit would be unplayed", () => {
    const reaching = () => builtinModules.filter((m) => pointsRuleAwardReachesTable(m));
    /** The rule's award for a sport: its own default walkover figure + 4, the offender a nonzero 1 (never the default). */
    const awardOf = (key: string): [number, number] => {
      const fx = fixtureOf(key, PRE);
      const keys = fx.m.awardScoreKeys!;
      return [fx.m.forfeitCredit(fx.cfg, fx.state, "walkover", "away").perSide[0][keys.for]! + 4, 1];
    };
    const offered = (fx: ReturnType<typeof fixtureOf>, forfeitAward?: [number, number]) =>
      forfeitDialogModel(fx.m, fx.cfg, fx.state, { noNextMatch: false, playRecorded: forfeitPlayRecorded(rowsOf(fx.events), fx.m), ...(forfeitAward === undefined ? {} : { forfeitAward }) });

    it("every sport the award reaches, before play and after a bare Start, both sides: the rule's number, the side that turned up first", () => {
      let checked = 0;
      for (const m of reaching()) {
        const [w, l] = awardOf(m.key);
        for (const [shape, ledger] of [["pre", PRE], ["started", STARTED]] as const) {
          const fx = fixtureOf(m.key, ledger);
          const d = offered(fx, [w, l]);
          const plain = offered(fx);
          expect(plain.preview("away", "walkover"), `${m.key}/${shape}: premise - without the rule the preview is not the rule's`).not.toEqual({ home: String(w), away: String(l) });
          expect(d.preview("away", "walkover"), `${m.key}/${shape}: home turned up`).toEqual({ home: String(w), away: String(l) });
          expect(d.preview("home", "walkover"), `${m.key}/${shape}: away turned up`).toEqual({ home: String(l), away: String(w) });
          expect(d.preview("both", "walkover"), `${m.key}/${shape}: a double walkover credits nothing`).toBeNull();
          checked++;
        }
      }
      expect(checked, "sport x shape cases").toBe(reaching().length * 2);
      expect(reaching().length).toBeGreaterThan(0);
    });

    it("P-3: a forfeit AFTER play keeps the sport's own credit - the preview is the same with or without the rule's award (disqualified from a bare start is unplayed and takes it)", () => {
      let checked = 0;
      for (const m of reaching()) {
        const [w, l] = awardOf(m.key);
        const fx = playedOf(m.key);
        const d = offered(fx, [w, l]);
        const plain = offered(fx);
        for (const who of ["home", "away"] as const) {
          expect(d.preview(who, "retired"), `${m.key}/${who}: retired after play`).toEqual(plain.preview(who, "retired"));
          expect(d.preview(who, "disqualified"), `${m.key}/${who}: disqualified after play`).toEqual(plain.preview(who, "disqualified"));
        }
        const started = offered(fixtureOf(m.key, STARTED), [w, l]);
        expect(started.preview("away", "disqualified"), `${m.key}: disqualified from a bare Start is unplayed`).toEqual({ home: String(w), away: String(l) });
        checked++;
      }
      expect(checked).toBe(reaching().length);
    });

    it("no award offered: nothing changes (the empty case) - and a sport the award never reaches is never offered one", () => {
      const fx = fixtureOf("football", PRE);
      expect(offered(fx).preview("away", "walkover")).toEqual({ home: "3", away: "0" });
      expect(pointsRuleAwardReachesTable(mod("badminton")), "premise").toBe(false);
      expect(offered(fixtureOf("badminton", PRE)).preview("away", "walkover")).toEqual({ home: "2", away: "0" });
    });
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

  // Design audit 1.3: chess's dock calls the in-game stop "Resignation" (`method.resign`, a board result the dock
  // records); the forfeit dialog then offered "Retired: stopped during the match" beside it — a different fact the
  // organiser had to tell apart. Chess's retirement radio reads in the board's terms; every other sport keeps the
  // house label. The premise is asserted: chess OFFERS the retirement once started (its Start is play, ruling 118).
  it("audit 1.3: chess words its retirement radio in the board's terms; every other sport keeps the house labels", () => {
    const chess = model(fixtureOf("boardgame", STARTED));
    expect(chess.why("home"), "premise: a started chess game offers the retirement").toContain("retired");
    let checked = 0;
    for (const m of builtinModules) {
      const d = model(fixtureOf(m.key, STARTED));
      for (const r of ["walkover", "retired", "disqualified"] as const) {
        const want = m.key === "boardgame" && r === "retired" ? "forfeitDialog.reason.retired.boardgame" : `forfeitDialog.reason.${r}`;
        expect(d.reasonKey(r), `${m.key} ${r}`).toBe(want);
        checked++;
      }
    }
    expect(checked, `sport × reason labels checked: ${checked}`).toBe(builtinModules.length * 3);
  });

  it("the scheduled shape: the page serves state null before kickoff, read as the module's own init — before play for every sport", () => {
    let checked = 0;
    for (const m of builtinModules) {
      const l = defaultLineupPair(m.positions);
      const base = forfeitBaseState(m, firstCfg(m), null, l);
      const d = forfeitDialogModel(m, firstCfg(m), base, { noNextMatch: false, playRecorded: forfeitPlayRecorded([], m) });
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
    const d = model(playedOf("generic"));
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

  // Design audit 1.1: a side that is offered ONE reason has it chosen with the side — "Both sides" then "Walkover:
  // didn't turn up" was a second tap that decided nothing. Swept over every sport and both sides of the start; the
  // expected reason is the model's own offer (the engine's phase guard), never a value typed here. The pair: a side
  // offered two reasons is chosen with none, so the organiser still picks.
  it("audit 1.1: a side offered one reason has it chosen with the side; two reasons leave the choice open", () => {
    let single = 0;
    let open = 0;
    for (const m of builtinModules) {
      for (const [scene, fx] of [["pre", fixtureOf(m.key, PRE)], ["started", fixtureOf(m.key, STARTED)], ["played", playedOf(m.key)]] as const) {
        const d = model(fx);
        for (const w of d.who) {
          const offered = d.why(w);
          const s = pickForfeit(d, NO_FORFEIT_PICK, { kind: "who", who: w });
          if (offered.length === 1) {
            expect(s, `${m.key} ${scene} ${w}: the one reason comes with the side`).toEqual({ who: w, reason: offered[0] });
            expect(forfeitConfirmBlocked(d, s, false), `${m.key} ${scene} ${w}: Confirm is ready`).toBe(false);
            single++;
          } else {
            expect(s, `${m.key} ${scene} ${w}: ${offered.length} reasons, none chosen for the organiser`).toEqual({ who: w, reason: null });
            open++;
          }
        }
      }
    }
    // Every sport offers "Both sides" before play (one reason), and a side two reasons after the Start.
    expect(single, `single-reason sides checked: ${single}`).toBeGreaterThanOrEqual(builtinModules.length);
    expect(open, `two-reason sides checked: ${open}`).toBeGreaterThanOrEqual(builtinModules.length);
  });

  it("rule 10: any sequence of taps keeps the selection offered, never picks withdrew, and every Confirmable choice is one the engine records", () => {
    const KEYS = builtinModules.map((m) => m.key);
    type Scene = "pre" | "started" | "played" | "tiebreak";
    const sceneArb = fc.constantFrom<Scene>("pre", "started", "played", "tiebreak");
    const pickArb = fc.oneof(
      fc.record({ kind: fc.constant("who" as const), who: fc.constantFrom<ForfeitWho>("home", "away", "both") }),
      fc.record({ kind: fc.constant("why" as const), reason: fc.constantFrom<ForfeitReason>(...FORFEIT_REASONS) }),
    );
    let steps = 0;
    let confirmable = 0;
    fc.assert(
      fc.property(fc.constantFrom(...KEYS), sceneArb, fc.boolean(), fc.array(pickArb, { minLength: 1, maxLength: 12 }), (key, scene, noNextMatch, picks) => {
        const chess = key === "boardgame";
        // Ruling 112's two sides of the start: nothing played (a bare start), and the sport's own event played.
        const fx = scene === "played" ? playedOf(key)
          : scene === "tiebreak" && chess ? fixtureOf(key, () => [ev(1, "core.start"), ev(2, DRAWN.type, DRAWN.payload)], chessKoCfg())
          : fixtureOf(key, scene === "pre" ? PRE : STARTED);
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

// Fix round 1 (review M-3): the two "still offered" guards, each driven ALONE. `pickForfeit` can only ever hold an
// offered pair, so through it each guard is covered for by the other; these hand the guard a pair the dialog does not
// offer — a selection carried over from a snapshot the match has since moved past.
describe("UI-1 forfeit dialog: a choice the dialog does not offer (review M-3)", () => {
  it("Confirm stays blocked on a side or reason the model no longer offers — Neither and the walkover once something is played", () => {
    const d = model(playedOf("generic"));
    expect(d.who, "X-RS-1 (ruling 112): no Neither once something is played").not.toContain("both");
    expect(forfeitConfirmBlocked(d, { who: "both", reason: "walkover" }, false), "Neither after play").toBe(true);
    expect(forfeitConfirmBlocked(d, { who: "home", reason: "walkover" }, false), "a walkover after play").toBe(true);
    // The positive pair: an offered choice is Confirmable.
    expect(forfeitConfirmBlocked(d, { who: "home", reason: "retired" }, false)).toBe(false);
  });

  it("the preview of a choice the dialog does not offer is none — a football walkover once play started, though the module could price one", () => {
    // FB-WO-1 prices a walkover at 3-0 whatever the state (the module's credit does not judge the phase); the dialog
    // after kickoff offers retired or disqualified only (X-RS-1), so a walkover there previews nothing.
    const fx = fixtureOf("football", (l) => [ev(1, "core.start"), ev(2, "football.goal", { by: l.home.entrantId })]);
    expect(fx.m.forfeitCredit(fx.cfg as never, fx.state as never, "walkover", "away").perSide[0].gf, "the module prices it").toBe(3);
    const d = model(fx);
    expect(d.why("away")).not.toContain("walkover");
    expect(d.preview("away", "walkover")).toBeNull();
    // The positive pair: the offered retirement previews the credit (FB-RT-1: 3-0, the awarded margin beats 1-0).
    expect(d.preview("away", "retired")).toEqual({ home: "3", away: "0" });
  });
});

// Fix round 1 (review M-1): the preview states what the server will RECORD, which it judges at the current tip — so it
// follows the console's current model while the chips stay the snapshot taken at open.
describe("UI-1 forfeit dialog: the preview follows the current ledger (review M-1)", () => {
  const goals = (n: number) => (l: ReturnType<typeof defaultLineupPair>) => [
    ev(1, "core.start"),
    ...Array.from({ length: n }, (_, i) => ev(i + 2, "football.goal", { by: l.home.entrantId })),
  ];

  it("a goal recorded on another device while the dialog is open moves the credited score — FB-RT-1, the real margin stands", () => {
    // FB-RT-1 (FDC Art. 28): a retirement credits the awarded 3-0 unless the real margin is worse for the side that
    // retired. At 1-0 the award stands (3-0); at 4-0 the real margin does (4-0).
    const snapshot = model(fixtureOf("football", goals(1)));
    const live = model(fixtureOf("football", goals(4)));
    expect(snapshot.preview("away", "retired"), "the snapshot taken at 1-0").toEqual({ home: "3", away: "0" });
    expect(forfeitPreviewNow(snapshot, live, "away", "retired"), "the consequence at the current tip").toEqual({ home: "4", away: "0" });
    // Unchanged ledger: the same answer either way.
    expect(forfeitPreviewNow(snapshot, model(fixtureOf("football", goals(1))), "away", "retired")).toEqual({ home: "3", away: "0" });
  });

  it("no current model, or one that no longer offers the choice: the snapshot's preview stands (the server judges that send)", () => {
    const snapshot = model(fixtureOf("football", goals(1)));
    expect(forfeitPreviewNow(snapshot, null, "away", "retired")).toEqual({ home: "3", away: "0" });
    // The match was decided under the open dialog: the current model offers nothing (empty case first).
    const decided = model(fixtureOf("football", (l) => [...goals(1)(l), ev(3, "core.forfeit", { by: l.away.entrantId, reason: "retired" })]));
    expect(decided.who).toEqual([]);
    expect(forfeitPreviewNow(snapshot, decided, "away", "retired")).toEqual({ home: "3", away: "0" });
  });
});
