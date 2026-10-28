// W2e X-SE-1 and X-SE-2 (spec 2026-10-28 §5.2, §5.3; D3 (1), D12, D13): the ending-sanction declaration, the write path's
// pending-ending refusal (ENDING_SANCTION_PENDING), the scorer's narrow forfeit exception, and anti-goal 4 (a sanction alone
// moves no score).
//
// X-SE-1 is proved here against a STUB sport (preflight F1): no shipped module declares an ending until Tasks 3 (badminton,
// volleyball) and 4 (tennis), and those tasks add the real-module sweep with its own count. X-SE-2 sweeps every shipped
// module that records a sanction, at every level its payload schema accepts.
//
// Every expected value comes from the stub's declaration (`DECL`), from the stub's own rule (first to `TARGET` points), or
// from the rule rows' text (X-SE-1: forfeit and abandon stay admitted; voiding the ending re-opens the refusal, voiding the
// sanction lifts it; D13: `disqualified` follows an end level, `retired` a prompt level, against the same side). Never from
// the code under test.
import { describe, expect, it } from "vitest";
import { EngineError } from "./errors.ts";
import { foldMatchWithStoppage, forfeitOf, outcomeOf, type EventEnvelope, type FoldableModule } from "./events.ts";
import {
  lastLiveEvent,
  matchEndFacts,
  pendingEndingSanction,
  sanctionEndingIssues,
  scorerMayForfeit,
  type SanctionEndingDecl,
  type SanctionLedgerRow,
} from "./sanction-ending.ts";
import { FORFEIT_REASONS, type ForfeitReason, type LineupPair, type MatchOutcome } from "./types.ts";
import { resolvePositions } from "../sport/catalog.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { buildStream, defaultLineupPair, makeEnvelope } from "../testkit/helpers.ts";
import { expectSanctionMovesNoScore, sanctionEventTypeOf, sanctionLevelsOf } from "../testkit/sanction-score.ts";

// ---------------------------------------------------------------------------
// The stub sport. First side to TARGET points wins. `stub.sanction` is a record only (it moves no score, like every
// shipped sanction); its ladder is LEVELS, of which the declaration names one end level and one prompt level, and
// leaves "warn" as neither.
// ---------------------------------------------------------------------------

const H = "H";
const A = "A";
const TARGET = 3;
const LEVELS = ["warn", "exp", "dq"] as const;
const DECL: SanctionEndingDecl = { eventType: "stub.sanction", endLevels: ["dq"], promptLevels: ["exp"] };

interface StubState {
  phase: "pre" | "live" | "done";
  score: { home: number; away: number };
  outcome: MatchOutcome | null;
  sanctions: number;
}

const lineups: LineupPair = {
  home: { entrantId: H, slots: [{ personId: "h1", slot: "starting", orderNo: 1 }] },
  away: { entrantId: A, slots: [{ personId: "a1", slot: "starting", orderNo: 1 }] },
};

const wrongPhase = (what: string): never => {
  throw new EngineError("WRONG_PHASE", what);
};

function stubSport(sanctionEnding?: SanctionEndingDecl): FoldableModule<null, StubState> {
  return {
    ...(sanctionEnding === undefined ? {} : { sanctionEnding }),
    init: () => ({ phase: "pre", score: { home: 0, away: 0 }, outcome: null, sanctions: 0 }),
    apply(state, event) {
      switch (event.type) {
        case "core.start":
          return state.phase === "pre" ? { ...state, phase: "live" } : wrongPhase("already started");
        case "stub.point": {
          if (state.phase !== "live") return wrongPhase("not live");
          const to = (event.payload as { to: "home" | "away" }).to;
          const score = { ...state.score, [to]: state.score[to] + 1 };
          if (score[to] < TARGET) return { ...state, score };
          const winner = to === "home" ? H : A;
          return { ...state, score, phase: "done", outcome: { kind: "win", winner, loser: winner === H ? A : H, method: "regulation" } };
        }
        case "stub.sanction": {
          if (state.phase !== "live") return wrongPhase("not live");
          const p = event.payload as { by: string; level: string };
          if ((p.by !== H && p.by !== A) || !(LEVELS as readonly string[]).includes(p.level)) {
            throw new EngineError("INVALID_EVENT", "bad sanction");
          }
          return { ...state, sanctions: state.sanctions + 1 };
        }
        case "core.forfeit": {
          if (state.phase === "done") return wrongPhase("over");
          const { by, reason } = forfeitOf(event.payload);
          const winner = by === H ? A : H;
          return { ...state, phase: "done", outcome: { kind: "award", winner, loser: by, reason } };
        }
        // Like every set-based and nested kernel (review I-2): an abandon stops play and decides NOTHING — the outcome stays
        // null until the organiser settles it (or voids the abandon).
        case "core.abandon":
          return state.phase === "live" ? { ...state, phase: "done" } : wrongPhase("not live");
        case "core.note":
        case "core.award":
          return state;
        case "core.finalize":
          return state.phase === "done" ? state : wrongPhase("not decided");
        default:
          throw new EngineError("INVALID_EVENT", `unknown ${event.type}`);
      }
    },
    outcome: (state) => state.outcome,
  };
}

const DECLARING = stubSport(DECL);
const UNDECLARED = stubSport();

const ev = (seq: number, type: string, payload: unknown = {}, voids?: string): EventEnvelope =>
  makeEnvelope(seq, { type, payload }, voids);
const point = (seq: number, to: "home" | "away") => ev(seq, "stub.point", { to });
const sanction = (seq: number, by: string, level: string) => ev(seq, "stub.sanction", { by, level });

/** The write path: `history` is the ledger, `candidate` the one event not yet in it (append-event.ts's shape). */
const write = (m: FoldableModule<null, StubState>, history: readonly EventEnvelope[], candidate: EventEnvelope) =>
  foldMatchWithStoppage(m, null, lineups, [...history, candidate], { strictFromSeq: candidate.seq });
/** A read path: the whole ledger is history (no `strictFromSeq`). */
const replay = (m: FoldableModule<null, StubState>, events: readonly EventEnvelope[]) => foldMatchWithStoppage(m, null, lineups, events);

/** The pad's and the route's reading of a ledger: the one predicate, fed the facts of the ledger's own replay. */
const pendingOf = (m: FoldableModule<null, StubState>, events: readonly EventEnvelope[]) =>
  pendingEndingSanction(m, events, matchEndFacts(m, replay(m, events), events));
const LIVE_FACTS = { decided: false, abandonActive: false } as const;

function refusal(fn: () => unknown): EngineError {
  try {
    fn();
  } catch (e) {
    if (e instanceof EngineError) return e;
    throw e;
  }
  throw new Error("expected the fold to refuse the event; it admitted it");
}

/** start, a point, then a sanction at `level` against `by` (seq 0..2). */
const sanctioned = (by: string, level: string): EventEnvelope[] => [ev(0, "core.start"), point(1, "home"), sanction(2, by, level)];

/** Every event the stub can be offered next that is neither the ending nor an abandon, with a schema-valid payload. */
const NOT_AN_ENDING = (seq: number, other: string): EventEnvelope[] => [
  point(seq, "home"),
  point(seq, "away"),
  sanction(seq, other, "warn"),
  ev(seq, "core.note", { text: "umpire's note" }),
  ev(seq, "core.award", { person: "h1", key: "mvp" }),
  ev(seq, "core.suspend", { reason: "rain" }),
];

describe("X-SE-1 the pending-ending refusal (stub sport, preflight F1)", () => {
  it("X-SE-1 a strict scoring event after an end-level sanction is refused ENDING_SANCTION_PENDING", () => {
    let refused = 0;
    for (const level of DECL.endLevels) {
      for (const [by, other] of [[H, A], [A, H]] as const) {
        const history = sanctioned(by, level);
        for (const candidate of NOT_AN_ENDING(3, other)) {
          const error = refusal(() => write(DECLARING, history, candidate));
          expect(error.code, candidate.type).toBe("ENDING_SANCTION_PENDING");
          expect(error.data, candidate.type).toEqual({ by, level });
          // The differential: the same append on a sport that declares nothing is admitted, so the refusal is the
          // declaration's and not the stub's own phase rules.
          expect(() => write(UNDECLARED, history, candidate), candidate.type).not.toThrow();
          refused++;
        }
      }
    }
    expect(refused).toBe(DECL.endLevels.length * 2 * NOT_AN_ENDING(3, A).length);
    expect(refused).toBeGreaterThan(0);
  });

  it("X-SE-1 core.forfeit and core.abandon are still admitted while an ending is pending", () => {
    const history = sanctioned(H, "dq");
    // The ending itself: the sanctioned side loses, disqualified (X-RT-1's credit).
    const ended = write(DECLARING, history, ev(3, "core.forfeit", { by: H, reason: "disqualified" }));
    expect(outcomeOf(DECLARING, ended)).toEqual({ kind: "award", winner: A, loser: H, reason: "disqualified" });
    // Any other forfeit is still the fold's to admit (who may SEND it is the route's question, D13).
    const other = write(DECLARING, history, ev(3, "core.forfeit", { by: A, reason: "retired" }));
    expect(outcomeOf(DECLARING, other)).toEqual({ kind: "award", winner: H, loser: A, reason: "retired" });
    const abandoned = write(DECLARING, history, ev(3, "core.abandon", { reason: "floodlights" }));
    expect(abandoned.state.phase).toBe("done");
    expect(outcomeOf(DECLARING, abandoned)).toBeNull();
    // After the ending nothing is pending any more.
    expect(pendingOf(DECLARING, [...history, ev(3, "core.forfeit", { by: H, reason: "disqualified" })])).toBeNull();
  });

  it("X-SE-1 replay (no strictFromSeq) folds a pre-W2e ledger with rallies after a black card to its recorded outcome", () => {
    // Recorded before W2e: a disqualification, and play carried on to a result. The stub's rule (first to TARGET = 3)
    // gave this ledger to A, and so it still must.
    const recorded: EventEnvelope[] = [
      ev(0, "core.start"),
      point(1, "home"),
      sanction(2, H, "dq"),
      point(3, "away"),
      point(4, "away"),
      point(5, "away"),
    ];
    const folded = replay(DECLARING, recorded);
    expect(outcomeOf(DECLARING, folded)).toEqual({ kind: "win", winner: A, loser: H, method: "regulation" });
    expect(folded.state.score).toEqual({ home: 1, away: 3 });

    // The same match caught in progress at deploy (Review Focus 1): its history still folds, the pad can read the
    // pending ending from it, and its next rally is refused.
    const inProgress = recorded.slice(0, 4);
    expect(replay(DECLARING, inProgress).state.score).toEqual({ home: 1, away: 1 });
    expect(pendingOf(DECLARING, inProgress)).toEqual({ by: H, level: "dq" });
    expect(refusal(() => write(DECLARING, inProgress, point(4, "away"))).code).toBe("ENDING_SANCTION_PENDING");
  });

  it("X-SE-1 a decided match whose ledger holds an unended end-level sanction still takes its post-decision events", () => {
    // A finished pre-W2e match: the refusal is about scoring a LIVE match, so nothing is pending once it is decided (the
    // one predicate, review I-1) — a note or a finalize after the result is admitted, and a further point answers
    // ALREADY_DECIDED (guarantee 4), never ENDING_SANCTION_PENDING.
    const finished = [ev(0, "core.start"), point(1, "home"), sanction(2, H, "dq"), point(3, "away"), point(4, "away"), point(5, "away")];
    expect(outcomeOf(DECLARING, replay(DECLARING, finished))).not.toBeNull();
    expect(pendingOf(DECLARING, finished)).toBeNull();
    expect(() => write(DECLARING, finished, ev(6, "core.note", { text: "signed" }))).not.toThrow();
    expect(() => write(DECLARING, finished, ev(6, "core.finalize"))).not.toThrow();
    expect(refusal(() => write(DECLARING, finished, point(6, "home"))).code).toBe("ALREADY_DECIDED");
  });

  describe("X-SE-1 void sequences", () => {
    const base = sanctioned(H, "dq"); // e-2 is the sanction
    const ending = ev(3, "core.forfeit", { by: H, reason: "disqualified" }); // e-3 is its ending

    it("X-SE-1 void sequences: void the forfeit and the ending is pending again; the next rally is refused", () => {
      const history = [...base, ending];
      const voidEnding = ev(4, "core.void", {}, "e-3");
      expect(() => write(DECLARING, history, voidEnding)).not.toThrow();
      const after = [...history, voidEnding];
      expect(pendingOf(DECLARING, after)).toEqual({ by: H, level: "dq" });
      expect(outcomeOf(DECLARING, replay(DECLARING, after))).toBeNull();
      expect(refusal(() => write(DECLARING, after, point(5, "away"))).code).toBe("ENDING_SANCTION_PENDING");
    });

    it("X-SE-1 void sequences: void the sanction while its forfeit stands and the match stays ended", () => {
      const history = [...base, ending];
      const voidSanction = ev(4, "core.void", {}, "e-2");
      const folded = write(DECLARING, history, voidSanction);
      expect(folded.state.phase).toBe("done");
      expect(outcomeOf(DECLARING, folded)).toEqual({ kind: "award", winner: A, loser: H, reason: "disqualified" });
      const after = [...history, voidSanction];
      expect(pendingOf(DECLARING, after)).toBeNull();
      expect(refusal(() => write(DECLARING, after, point(5, "away"))).code).toBe("ALREADY_DECIDED");
    });

    it("X-SE-1 void sequences: void the forfeit, then the sanction, and the rally is admitted", () => {
      const after = [...base, ending, ev(4, "core.void", {}, "e-3"), ev(5, "core.void", {}, "e-2")];
      expect(() => replay(DECLARING, after)).not.toThrow();
      expect(pendingOf(DECLARING, after)).toBeNull();
      const played = write(DECLARING, after, point(6, "away"));
      expect(outcomeOf(DECLARING, played)).toBeNull();
      expect(played.state.score).toEqual({ home: 1, away: 1 });
    });
  });

  it("X-SE-1 a prompt-level sanction never makes an ending pending", () => {
    // D12: a prompt level asks a question and never ends the match by itself; a level the declaration names in neither
    // list is an ordinary record.
    const notEnding = LEVELS.filter((l) => !DECL.endLevels.includes(l));
    expect(notEnding).toEqual(expect.arrayContaining([...DECL.promptLevels]));
    let checked = 0;
    for (const level of notEnding) {
      const history = sanctioned(H, level);
      expect(pendingOf(DECLARING, history), level).toBeNull();
      expect(write(DECLARING, history, point(3, "away")).state.score, level).toEqual({ home: 1, away: 1 });
      checked++;
    }
    expect(checked).toBe(notEnding.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("X-SE-1 after an abandon that decides nothing, settle, note and forfeit never answer ENDING_SANCTION_PENDING (review I-2)", () => {
    const history = [...sanctioned(H, "dq"), ev(3, "core.abandon", { reason: "floodlights" })];
    // The real kernels' shape (set-based and nested): the abandon decided nothing, so nothing but the abandon itself can
    // lift the ending here.
    expect(outcomeOf(DECLARING, replay(DECLARING, history))).toBeNull();
    expect(pendingOf(DECLARING, history)).toBeNull();
    // The organiser's settle decides the abandoned match (it was refused here before: the circle review I-2 names).
    const settle = ev(4, "core.settle", { winner: A, method: "organiser" });
    expect(write(DECLARING, history, settle).settlement).toEqual({ winner: A, loser: H, method: "organiser", eventId: "e-4" });
    expect(() => write(DECLARING, history, ev(4, "core.note", { text: "abandoned at 1-0" }))).not.toThrow();
    // A forfeit over an abandon is X-AB-4's to answer (settle it, or void the abandon), never the pending ending's.
    expect(refusal(() => write(DECLARING, history, ev(4, "core.forfeit", { by: H, reason: "disqualified" }))).code).toBe(
      "ABANDONED_SETTLE_OR_VOID",
    );
    // The differential: without the abandon the same settle and note ARE the pending refusal ...
    const live = sanctioned(H, "dq");
    expect(refusal(() => write(DECLARING, live, ev(3, "core.settle", { winner: A, method: "organiser" }))).code).toBe("ENDING_SANCTION_PENDING");
    expect(refusal(() => write(DECLARING, live, ev(3, "core.note", { text: "x" }))).code).toBe("ENDING_SANCTION_PENDING");
    // ... and voiding the abandon re-opens it.
    const unabandoned = [...history, ev(4, "core.void", {}, "e-3")];
    expect(pendingOf(DECLARING, unabandoned)).toEqual({ by: H, level: "dq" });
    expect(refusal(() => write(DECLARING, unabandoned, ev(5, "core.note", { text: "x" }))).code).toBe("ENDING_SANCTION_PENDING");
  });

  it("X-SE-1 an abandon during a legacy stoppage after an end-level sanction can still be settled, closing the stoppage", () => {
    // Recorded before W2e: a black card, then play suspended. The abandon leaves the stoppage open (it decided nothing),
    // and the settle is the only event that closes it (W2a finding 4) — so a refused settle here left the match open for
    // ever.
    const history = [...sanctioned(H, "dq"), ev(3, "core.suspend", { reason: "rain" })];
    const abandoned = [...history, ev(4, "core.abandon", { reason: "rain" })];
    expect(write(DECLARING, history, ev(4, "core.abandon", { reason: "rain" })).stoppage).not.toBeNull();
    const settled = write(DECLARING, abandoned, ev(5, "core.settle", { winner: A, method: "organiser" }));
    expect(settled.stoppage).toBeNull();
    expect(settled.settlement?.winner).toBe(A);
  });

  it("X-SE-1 a second end-level sanction while one is pending is refused, naming the FIRST (review M-6)", () => {
    let refused = 0;
    for (const level of DECL.endLevels) {
      for (const [by, other] of [[H, A], [A, H]] as const) {
        const history = sanctioned(by, level);
        for (const second of [sanction(3, other, level), sanction(3, by, level)]) {
          const error = refusal(() => write(DECLARING, history, second));
          expect(error.code).toBe("ENDING_SANCTION_PENDING");
          expect(error.data).toEqual({ by, level });
          refused++;
        }
      }
    }
    expect(refused).toBe(DECL.endLevels.length * 2 * 2);
  });

  it("X-SE-1 core.resume while a stoppage is open is refused until the ending is recorded (review M-6)", () => {
    // A stoppage cannot open after the sanction on the write path (core.suspend is refused), so this is a pre-W2e ledger:
    // the black card, then the suspension. Resuming is not the ending; the ending itself is admitted mid-stoppage, and
    // closes it (a decided match is not awaiting resumption).
    const history = [...sanctioned(H, "dq"), ev(3, "core.suspend", { reason: "rain" })];
    expect(replay(DECLARING, history).stoppage).not.toBeNull();
    expect(refusal(() => write(DECLARING, sanctioned(H, "dq"), ev(3, "core.suspend", { reason: "rain" }))).code).toBe("ENDING_SANCTION_PENDING");
    const resume = refusal(() => write(DECLARING, history, ev(4, "core.resume")));
    expect(resume.code).toBe("ENDING_SANCTION_PENDING");
    expect(resume.data).toEqual({ by: H, level: "dq" });
    // The differential: the same resume on a sport that declares nothing closes the stoppage.
    expect(write(UNDECLARED, history, ev(4, "core.resume")).stoppage).toBeNull();
    const ended = write(DECLARING, history, ev(4, "core.forfeit", { by: H, reason: "disqualified" }));
    expect(ended.stoppage).toBeNull();
    expect(outcomeOf(DECLARING, ended)).toEqual({ kind: "award", winner: A, loser: H, reason: "disqualified" });
  });

  it("X-SE-1 the fold refuses exactly when the reader says an ending is pending (one predicate, review I-1)", () => {
    // Every prefix of five ledgers that move the predicate both ways: the ending and its void, an abandon then a settle,
    // an abandon then its void, a finished pre-W2e match, and the levels that end nothing. The probe is a note, which the
    // stub admits in every phase and the kernel in every state, so only the pending ending can refuse it.
    const flows: EventEnvelope[][] = [
      [...sanctioned(H, "dq"), ev(3, "core.forfeit", { by: H, reason: "disqualified" }), ev(4, "core.void", {}, "e-3"), ev(5, "core.void", {}, "e-2"), point(6, "away")],
      [...sanctioned(A, "dq"), ev(3, "core.abandon", { reason: "rain" }), ev(4, "core.settle", { winner: H, method: "organiser" })],
      [...sanctioned(H, "dq"), ev(3, "core.abandon", { reason: "rain" }), ev(4, "core.void", {}, "e-3")],
      [ev(0, "core.start"), point(1, "home"), sanction(2, H, "dq"), point(3, "away"), point(4, "away"), point(5, "away")],
      [...sanctioned(H, "exp"), point(3, "away"), sanction(4, A, "warn")],
    ];
    let pending = 0;
    let clear = 0;
    for (const flow of flows) {
      for (let n = 0; n <= flow.length; n++) {
        const ledger = flow.slice(0, n);
        const probe = ev(100, "core.note", { text: "probe" });
        const expected = pendingOf(DECLARING, ledger);
        if (expected === null) {
          expect(() => write(DECLARING, ledger, probe), `${n} of ${flow.map((e) => e.type).join(",")}`).not.toThrow();
          clear++;
        } else {
          const error = refusal(() => write(DECLARING, ledger, probe));
          expect(error.code).toBe("ENDING_SANCTION_PENDING");
          expect(error.data).toEqual(expected);
          pending++;
        }
      }
    }
    expect(pending + clear).toBe(flows.reduce((sum, flow) => sum + flow.length + 1, 0));
    expect(pending).toBeGreaterThan(0);
    expect(clear).toBeGreaterThan(0);
  });
});

describe("pendingEndingSanction", () => {
  it("is null for a sport that declares no ending, whatever its ledger holds", () => {
    expect(pendingOf(UNDECLARED, sanctioned(H, "dq"))).toBeNull();
  });

  it("names the LATEST live end-level sanction", () => {
    const ledger = [...sanctioned(H, "dq"), sanction(3, A, "dq")];
    expect(pendingOf(DECLARING, ledger)).toEqual({ by: A, level: "dq" });
    // Void the later one and the earlier one is pending again.
    expect(pendingOf(DECLARING, [...ledger, ev(4, "core.void", {}, "e-3")])).toEqual({ by: H, level: "dq" });
  });

  it("reads a stored ledger row, whose `voids` is null when it voids nothing", () => {
    const rows: SanctionLedgerRow[] = sanctioned(H, "dq").map((e) => ({ id: e.id, type: e.type, payload: e.payload, voids: null }));
    expect(pendingEndingSanction(DECLARING, rows, LIVE_FACTS)).toEqual({ by: H, level: "dq" });
    expect(pendingEndingSanction(DECLARING, [...rows, { id: "e-3", type: "core.void", payload: {}, voids: "e-2" }], LIVE_FACTS)).toBeNull();
    // An abandon read from stored rows lifts it like the fold's own abandon does.
    const abandon: SanctionLedgerRow = { id: "e-3", type: "core.abandon", payload: { reason: "rain" }, voids: null };
    const folded = replay(DECLARING, [...sanctioned(H, "dq"), ev(3, "core.abandon", { reason: "rain" })]);
    expect(matchEndFacts(DECLARING, folded, [...rows, abandon])).toEqual({ decided: false, abandonActive: true });
    expect(pendingEndingSanction(DECLARING, [...rows, abandon], matchEndFacts(DECLARING, folded, [...rows, abandon]))).toBeNull();
  });

  it("is null when the facts say decided or abandoned, whatever the ledger holds (the one predicate, review I-1)", () => {
    const ledger = sanctioned(H, "dq");
    const cases = [
      [LIVE_FACTS, { by: H, level: "dq" }],
      [{ decided: true, abandonActive: false }, null],
      [{ decided: false, abandonActive: true }, null],
      [{ decided: true, abandonActive: true }, null],
    ] as const;
    for (const [facts, expected] of cases) expect(pendingEndingSanction(DECLARING, ledger, facts), JSON.stringify(facts)).toEqual(expected);
    expect(cases.length).toBe(4);
  });

  it("matchEndFacts reads decided as the fold does — the module's outcome, or a settle — and an abandon only while live", () => {
    const ledger = sanctioned(H, "dq");
    const live = replay(DECLARING, ledger);
    expect(matchEndFacts(DECLARING, live, ledger)).toEqual({ decided: false, abandonActive: false });
    // X-ST-1: the fold sets `decided` on an accepted core.settle, whatever the module's own state still says.
    const settlement = { winner: A, loser: H, method: "organiser" as const, eventId: "e-9" };
    expect(matchEndFacts(DECLARING, { state: live.state, settlement }, ledger)).toEqual({ decided: true, abandonActive: false });
    const ended = [...ledger, ev(3, "core.forfeit", { by: H, reason: "disqualified" })];
    expect(matchEndFacts(DECLARING, replay(DECLARING, ended), ended).decided).toBe(true);
  });

  it("refuses a declaration whose event carries no string `by` and `level` (a module bug, not a scorer's mistake)", () => {
    const misdeclared = stubSport({ eventType: "stub.point", endLevels: ["dq"], promptLevels: [] });
    expect(() => pendingEndingSanction(misdeclared, [ev(0, "core.start"), point(1, "home")], LIVE_FACTS)).toThrow(/carries no string `by` and `level`/);
    expect(() => replay(misdeclared, [ev(0, "core.start"), point(1, "home")])).toThrow(/carries no string `by` and `level`/);
    // The same refusal for a payload that is not an object at all.
    expect(() => scorerMayForfeit(DECLARING, { type: DECL.eventType, payload: null }, { by: H, reason: "disqualified" })).toThrow(
      /carries no string `by` and `level`/,
    );
  });
});

describe("scorerMayForfeit (D13)", () => {
  it("scorerMayForfeit truth table", () => {
    // D13, verbatim: a scorer may send forfeit{disqualified} only as the event right after an ending-level sanction against
    // the same side, and forfeit{retired} only right after a prompt-level one against the same side. Every other row is
    // false. The level of each row comes from the declaration.
    const levelsByKind = { end: DECL.endLevels[0]!, prompt: DECL.promptLevels[0]!, other: LEVELS.find((l) => !DECL.endLevels.includes(l) && !DECL.promptLevels.includes(l))! };
    const allowed = new Set(["sanction|same|end|disqualified", "sanction|same|prompt|retired"]);
    let rows = 0;
    let trues = 0;
    for (const last of ["sanction", "not-sanction"] as const) {
      for (const side of ["same", "other"] as const) {
        for (const kind of ["end", "prompt", "other"] as const) {
          for (const reason of ["disqualified", "retired", "walkover"] as const satisfies readonly ForfeitReason[]) {
            const level = levelsByKind[kind];
            const by = side === "same" ? H : A;
            // "not the sanction": the stub's other event carrying the same fields, so only the TYPE differs.
            const lastLive = { type: last === "sanction" ? DECL.eventType : "stub.point", payload: { by: H, level } };
            const expected = allowed.has(`${last}|${side}|${kind}|${reason}`);
            expect(scorerMayForfeit(DECLARING, lastLive, { by, reason }), `${last} ${side} ${kind} ${reason}`).toBe(expected);
            rows++;
            if (expected) trues++;
          }
        }
      }
    }
    expect(rows).toBe(2 * 2 * 3 * 3);
    expect(trues).toBe(allowed.size);
  });

  it("is false with no live event before it, for a sport that declares no ending, and for withdrew", () => {
    expect(scorerMayForfeit(DECLARING, null, { by: H, reason: "disqualified" })).toBe(false);
    const lastLive = { type: DECL.eventType, payload: { by: H, level: "dq" } };
    expect(scorerMayForfeit(UNDECLARED, lastLive, { by: H, reason: "disqualified" })).toBe(false);
    const others = FORFEIT_REASONS.filter((r) => r !== "disqualified" && r !== "retired");
    expect(others.length).toBeGreaterThan(0);
    for (const reason of others) expect(scorerMayForfeit(DECLARING, lastLive, { by: H, reason }), reason).toBe(false);
  });
});

describe("lastLiveEvent (review M-2)", () => {
  it("is the sanction again after [S, F, void(F)], so the scorer may re-confirm the ending", () => {
    const S = sanction(2, H, "dq");
    const F = ev(3, "core.forfeit", { by: H, reason: "disqualified" });
    const ledger = [ev(0, "core.start"), point(1, "home"), S, F, ev(4, "core.void", {}, "e-3")];
    expect(lastLiveEvent(ledger)).toBe(S);
    expect(scorerMayForfeit(DECLARING, lastLiveEvent(ledger), { by: H, reason: "disqualified" })).toBe(true);
    // Before the void the last live event is the forfeit itself, and a second forfeit is not the scorer's to send.
    expect(lastLiveEvent(ledger.slice(0, 4))).toBe(F);
    expect(scorerMayForfeit(DECLARING, lastLiveEvent(ledger.slice(0, 4)), { by: H, reason: "disqualified" })).toBe(false);
    // The write path agrees: the re-confirming forfeit is the ending again.
    const reconfirmed = write(DECLARING, ledger, ev(5, "core.forfeit", { by: H, reason: "disqualified" }));
    expect(outcomeOf(DECLARING, reconfirmed)).toEqual({ kind: "award", winner: A, loser: H, reason: "disqualified" });
  });

  it("skips voided events and every void, reads stored rows, and is null for a ledger with nothing live", () => {
    expect(lastLiveEvent([])).toBeNull();
    expect(lastLiveEvent([ev(0, "core.start"), ev(1, "core.void", {}, "e-0")])).toBeNull();
    const P = point(1, "home");
    expect(lastLiveEvent([ev(0, "core.start"), P, point(2, "away"), ev(3, "core.void", {}, "e-2")])).toBe(P);
    const rows: SanctionLedgerRow[] = [
      { id: "e-0", type: "core.start", payload: {}, voids: null },
      { id: "e-1", type: "stub.sanction", payload: { by: H, level: "dq" }, voids: null },
    ];
    expect(lastLiveEvent(rows)).toBe(rows[1]);
  });
});

describe("sanctionEndingIssues (review M-1)", () => {
  it("passes the stub's declaration and a declaration that fills one list only", () => {
    expect(sanctionEndingIssues(DECL)).toEqual([]);
    expect(sanctionEndingIssues({ eventType: "x.sanction", endLevels: ["dq"], promptLevels: [] })).toEqual([]);
    expect(sanctionEndingIssues({ eventType: "x.sanction", endLevels: [], promptLevels: ["exp"] })).toEqual([]);
  });

  it("names each fault once", () => {
    const cases: [SanctionEndingDecl, RegExp][] = [
      [{ ...DECL, eventType: "" }, /names no sanction event/],
      [{ ...DECL, endLevels: [], promptLevels: [] }, /names no level/],
      [{ ...DECL, endLevels: ["dq", "dq"] }, /^endLevels names a level twice$/],
      [{ ...DECL, promptLevels: ["exp", "exp"] }, /^promptLevels names a level twice$/],
      [{ ...DECL, endLevels: [""] }, /^endLevels names an empty level$/],
      [{ ...DECL, promptLevels: ["exp", ""] }, /^promptLevels names an empty level$/],
      [{ ...DECL, promptLevels: ["exp", "dq"] }, /^dq is both an end level and a prompt level$/],
    ];
    for (const [decl, fault] of cases) {
      const issues = sanctionEndingIssues(decl);
      expect(issues, JSON.stringify(decl)).toHaveLength(1);
      expect(issues[0]).toMatch(fault);
    }
    expect(cases.length).toBe(7);
  });
});

describe("X-SE-2 a sanction alone moves no score (anti-goal 4)", () => {
  it("X-SE-2 a sanction at every declared level of every module moves no score", () => {
    const swept: string[] = [];
    let states = 0;
    const visited = forEachSport(({ module }) => {
      for (const level of sanctionLevelsOf(module)) {
        const checked = expectSanctionMovesNoScore(module, level);
        expect(checked, `${module.key} ${level}`).toBeGreaterThan(0);
        states += checked;
        swept.push(`${module.key}:${level}`);
      }
    });
    expect(visited).toBeGreaterThan(0);
    // Anti-vacuity: zero (module, level) pairs, or zero live states, is a failure.
    expect(swept.length).toBeGreaterThan(0);
    expect(states).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// X-SE-1 on the shipped modules (preflight F1, moved to Task 3): every module that declares an ending.
// ---------------------------------------------------------------------------

/** Spec 2026-10-28 §5.2's table, with D12: the levels that end a match and the levels after which the pad asks whether
 *  the team can still field six. A sport named `null` declares nothing; a sport not named here must declare nothing
 *  either (tennis's `default` row is added by Task 4, which declares it). */
const SPEC_5_2: Readonly<Record<string, { endLevels: string[]; promptLevels: string[] } | null>> = {
  badminton: { endLevels: ["disqualification"], promptLevels: [] },
  volleyball: { endLevels: [], promptLevels: ["expulsion", "disqualification"] },
  tabletennis: null,
};

/** Seeds of each declared cfg's generator walk (plan: 200 per declaring module), and the longest walk. */
const ENDING_SWEEP_SEEDS = 200;
const ENDING_SWEEP_EVENTS = 400;

describe("X-SE-1 the shipped modules' ending declarations (preflight F1)", () => {
  it("X-SE-1 every declaring module's declaration holds, names its own sanction event and levels, and is spec §5.2's row", () => {
    const declaring: string[] = [];
    const visited = forEachSport(({ key, module }) => {
      const decl = module.sanctionEnding;
      const row = Object.hasOwn(SPEC_5_2, key) ? SPEC_5_2[key]! : null;
      if (decl === undefined) {
        expect(row, `${key} declares no ending, but spec §5.2 gives it one`).toBeNull();
        return;
      }
      expect(sanctionEndingIssues(decl), key).toEqual([]);
      expect(decl.eventType, key).toBe(sanctionEventTypeOf(module));
      const recorded = sanctionLevelsOf(module);
      for (const level of [...decl.endLevels, ...decl.promptLevels]) expect(recorded, `${key} ${level}`).toContain(level);
      expect({ endLevels: [...decl.endLevels], promptLevels: [...decl.promptLevels] }, key).toEqual(row);
      declaring.push(key);
    });
    expect(visited).toBeGreaterThan(0);
    // Both directions: every row of the table is declared by its module, and nothing else declares.
    expect(declaring.length, "anti-vacuity: no module declares an ending").toBeGreaterThan(0);
    expect(declaring.sort()).toEqual(Object.keys(SPEC_5_2).filter((k) => SPEC_5_2[k] !== null).sort());
  });

  it("X-SE-1 seeded arbitrary streams of every declaring module never build a ledger the write path refuses (counted)", () => {
    const streams: Record<string, number> = {};
    const endings: Record<string, number> = {};
    const prompts: Record<string, number> = {};
    forEachSport(({ key, module }) => {
      const decl = module.sanctionEnding;
      if (decl === undefined) return;
      streams[key] = endings[key] = prompts[key] = 0;
      for (const { name, cfg } of declaredCfgs(module)) {
        const lineups = defaultLineupPair(resolvePositions(module, cfg));
        for (let seed = 1; seed <= ENDING_SWEEP_SEEDS; seed++) {
          const events = buildStream(module, cfg, lineups, seed, ENDING_SWEEP_EVENTS);
          const where = `${key} cfg ${name} seed ${seed}`;
          // The whole walk is new: the strict write path takes every event of it.
          expect(() => foldMatchWithStoppage(module, cfg, lineups, events, { strictFromSeq: 0 }), where).not.toThrow();
          streams[key]++;
          for (const [i, e] of events.entries()) {
            if (e.type !== decl.eventType) continue;
            const { by, level } = e.payload as { by: string; level: string };
            if (decl.promptLevels.includes(level)) prompts[key]++;
            if (!decl.endLevels.includes(level)) continue;
            // The generator follows an end-level sanction with its ending at once (spec §5.2).
            expect(events[i + 1], `${where}: event ${i} (${level} against ${by}) is not followed by its ending`).toMatchObject({
              type: "core.forfeit",
              payload: { by, reason: "disqualified" },
            });
            endings[key]++;
          }
        }
      }
      // Anti-vacuity, per module: the walks exist, and they reach each kind of level the module declares.
      expect(streams[key], key).toBeGreaterThan(0);
      if (decl.endLevels.length > 0) expect(endings[key], `${key}: no walk drew an end-level sanction`).toBeGreaterThan(0);
      if (decl.promptLevels.length > 0) expect(prompts[key], `${key}: no walk drew a prompt-level sanction`).toBeGreaterThan(0);
    });
    expect(Object.keys(streams).length, "anti-vacuity: no declaring module was swept").toBeGreaterThan(0);
  });
});
