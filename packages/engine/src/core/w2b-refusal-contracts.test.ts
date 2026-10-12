// W2b (spec §5.1; plan D3–D6, PF-1) — the CONTRACT half of the kernel's forfeit refusals: the code AND the copy AND the
// data a caller reads (the web renders the refusal from `data`, never from the message). Written to kill the survivors
// the changed-lines Stryker run left in core/events.ts, core/types.ts, sport/forfeit-credit.ts and stats/stats.ts: each
// one an asserted field nobody asserted. Expected values are the rule table's (D3 R2–R5, X-AB-4, X-WD-1, D5) and the
// declared vocabulary (FORFEIT_REASONS), never read back from the guard.
import { describe, expect, it } from "vitest";
import { EngineError } from "./errors.ts";
import { foldMatchWithStoppage, resolveVoids, type EventEnvelope, type FoldableModule } from "./events.ts";
import { FORFEIT_REASONS, MatchOutcome, type LineupPair } from "./types.ts";
import { builtinModules } from "../sports/index.ts";
import { awardReasonOf, creditedMetrics } from "../sport/forfeit-credit.ts";
import { aggregatePlayerStats, forfeitStatsRole, playedInStats, type PlayerStatsFoldCtx, type PlayerStatsModel } from "../stats/stats.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/helpers.ts";
import { onePlayEvent } from "../testkit/play-event.ts";

const ev = (seq: number, type: string, payload: unknown = {}): EventEnvelope => makeEnvelope(seq, { type, payload });
const errOf = (f: () => unknown): EngineError => {
  try {
    f();
  } catch (e) {
    if (EngineError.is(e)) return e;
    throw e;
  }
  throw new Error("expected an EngineError, got none");
};
const mod = (key: string) => {
  const m = builtinModules.find((x) => x.key === key);
  if (!m) throw new Error(`no module ${key}`);
  return m;
};
const firstCfg = (key: string): unknown => {
  const first = declaredCfgs(mod(key) as never)[0];
  if (first === undefined) throw new Error(`${key}: no declared cfg`);
  return first.cfg;
};
const fold = (key: string, cfg: unknown, events: EventEnvelope[], strictFromSeq?: number) => {
  const m = mod(key);
  return foldMatchWithStoppage(m as never, cfg as never, defaultLineupPair(m.positions), events, strictFromSeq === undefined ? undefined : { strictFromSeq });
};
const A = "A";

/** D3 R2/R4/R5 per phase, in the vocabulary's own order: a walkover only before play (football declares no wider
 *  walkover phases), a retirement or disqualification only once play started, a withdrawal anywhere. */
const ALLOWED = {
  pre: FORFEIT_REASONS.filter((r) => r === "walkover" || r === "withdrew"),
  play: FORFEIT_REASONS.filter((r) => r !== "walkover"),
  // Ruling 113: after a bare Start (nothing played) everything but the retirement.
  bare: FORFEIT_REASONS.filter((r) => r !== "retired"),
};

describe("D3 refusal contract: FORFEIT_REASON_WRONG_PHASE names the phase, the reason, both sides and what is allowed", () => {
  it("D3 (rulings 112, 113): a walkover once something is played, a retirement before the start and after a bare start, and a double walkover once something is played — code, copy and data", () => {
    const cfg = firstCfg("football");
    // Ruling 112: a bare start is still before play for a walkover, so the refusal needs the sport's own play — the
    // module's generator draws it, never a typed event.
    const played = onePlayEvent(mod("football"), cfg, defaultLineupPair(mod("football").positions), [ev(1, "core.start")]);
    if (played === null) throw new Error("football: its generator draws no sport event after the start");
    const rows = [
      { label: "walkover in play", events: [ev(1, "core.start"), played, ev(3, "core.forfeit", { by: A, reason: "walkover" })], phase: "play", list: "play", reason: "walkover", both: false, bothAllowed: false, played: true },
      { label: "retired before play", events: [ev(1, "core.forfeit", { by: A, reason: "retired" })], phase: "pre", list: "pre", reason: "retired", both: false, bothAllowed: true, played: false },
      { label: "double walkover in play", events: [ev(1, "core.start"), played, ev(3, "core.forfeit", { by: "both", reason: "walkover" })], phase: "play", list: "play", reason: "walkover", both: true, bothAllowed: false, played: true },
      // Ruling 113: the phase reads "play" from the Start, but nothing is played — the data says so (`played`).
      { label: "retired after a bare start", events: [ev(1, "core.start"), ev(2, "core.forfeit", { by: A, reason: "retired" })], phase: "play", list: "bare", reason: "retired", both: false, bothAllowed: true, played: false },
    ] as const;
    let checked = 0;
    for (const row of rows) {
      const e = errOf(() => fold("football", cfg, [...row.events]));
      const allowed = ALLOWED[row.list];
      expect(e.code, row.label).toBe("FORFEIT_REASON_WRONG_PHASE");
      expect(e.message, row.label).toBe(`forfeit reason "${row.reason}" is not recordable in phase "${row.phase}" — allowed here: ${allowed.join(", ")}`);
      expect(e.data, row.label).toEqual({ eventId: row.events.at(-1)!.id, phase: row.phase, reason: row.reason, both: row.both, allowed, bothAllowed: row.bothAllowed, played: row.played });
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("D3 R3 (W2b-R14): a double walkover in a chess tie-break is refused with its own copy, though a walkover is allowed there", () => {
    const cfg = mod("boardgame").configSchema.parse({ tiebreak: true });
    const events = [ev(1, "core.start"), ev(2, "boardgame.result", { winner: null, method: "agreement" }), ev(3, "core.forfeit", { by: "both", reason: "walkover" })];
    const e = errOf(() => fold("boardgame", cfg, events));
    expect(e.code).toBe("FORFEIT_REASON_WRONG_PHASE");
    expect(e.message).toBe('a double walkover is not recordable in phase "tiebreak": the game was played — record one side\'s walkover or withdrawal');
    // BG-WO-1: chess admits a walkover in the tie-break phase too, so `allowed` holds it — and a double one is still not.
    expect(e.data).toEqual({ eventId: "e-3", phase: "tiebreak", reason: "walkover", both: true, allowed: [...FORFEIT_REASONS], bothAllowed: false, played: true });
  });

  it("C17 (ruling 112): a fold of a module that declares no forfeitPhase judges the phase from the stream — play after an active core.start, a walkover refused once its own event is played", () => {
    interface S { started: boolean }
    const fake: FoldableModule<unknown, S> = {
      init: () => ({ started: false }),
      apply: (s, e) => (e.type === "core.start" ? { started: true } : s),
      outcome: () => null,
    };
    const lineups: LineupPair = { home: { entrantId: "H", slots: [] }, away: { entrantId: A, slots: [] } };
    const play = errOf(() => foldMatchWithStoppage(fake, {}, lineups, [ev(1, "core.start"), ev(2, "fake.point"), ev(3, "core.forfeit", { by: A, reason: "walkover" })]));
    expect(play.data).toMatchObject({ phase: "play", allowed: ALLOWED.play });
    const pre = errOf(() => foldMatchWithStoppage(fake, {}, lineups, [ev(1, "core.forfeit", { by: A, reason: "retired" })]));
    expect(pre.data).toMatchObject({ phase: "pre", allowed: ALLOWED.pre });
    // MD-1: "pre until an active core.start" — the fake's own event before the start does not start it, so a
    // disqualification there (admitted from the start on, R4) is still refused in "pre".
    const beforeStart = errOf(() => foldMatchWithStoppage(fake, {}, lineups, [ev(1, "fake.point"), ev(2, "core.forfeit", { by: A, reason: "disqualified" })]));
    expect(beforeStart.data).toMatchObject({ eventId: "e-2", phase: "pre", reason: "disqualified", allowed: ALLOWED.pre });
  });
});

describe("X-AB-4, X-WD-1, D5 refusal contracts", () => {
  it("X-AB-4: a forfeit over an active abandon names the way out — settle, or void the abandon", () => {
    const events = [ev(1, "core.start"), ev(2, "core.abandon", { reason: "rain" }), ev(3, "core.forfeit", { by: A, reason: "retired" })];
    const e = errOf(() => fold("football", firstCfg("football"), events));
    expect(e.code).toBe("ABANDONED_SETTLE_OR_VOID");
    expect(e.message).toBe("this match was abandoned — settle it to decide it, or void the abandon first if it is being replayed");
    expect(e.data).toEqual({ eventId: "e-3" });
  });

  it("X-WD-1: a withdrawal over a held level result by an entrant who is neither side is INVALID_EVENT, never admitted", () => {
    const cfg = mod("generic").configSchema.parse({ resultMode: "score", allowDraws: true });
    const level = [ev(1, "core.start"), ev(2, "generic.result", { p1Score: 1, p2Score: 1 })];
    const e = errOf(() => fold("generic", cfg, [...level, ev(3, "core.forfeit", { by: "Q", reason: "withdrew" })]));
    expect(e.code).toBe("INVALID_EVENT");
    expect(e.message).toBe('core.forfeit by "Q" is neither side of this fixture');
    expect(e.data, "the refusal points at the offending row").toEqual({ eventId: "e-3" });
    // The positive pair: the same withdrawal by a side is admitted.
    expect(() => fold("generic", cfg, [...level, ev(3, "core.forfeit", { by: A, reason: "withdrew" })])).not.toThrow();
  });

  it("D5: a settle over an expunged match says so and flags `expunged`; over a plain abandon nothing carries the flag", () => {
    const cfg = firstCfg("generic");
    const settle = ev(3, "core.settle", { winner: "H", method: "lot" });
    const e = errOf(() => fold("generic", cfg, [ev(1, "core.start"), ev(2, "core.abandon", { reason: "withdrew", expunge: true }), settle], 3));
    expect(e.code).toBe("SETTLE_NOT_APPLICABLE");
    expect(e.message).toBe("this match was expunged by a withdrawal — void the abandon first");
    expect(e.data).toMatchObject({ eventId: "e-3", expunged: true });
    // A settle that is refused for another reason keeps the pre-W2b shape: no `expunged` key at all.
    const level = mod("generic").configSchema.parse({ resultMode: "score", allowDraws: true });
    const won = errOf(() => fold("generic", level, [ev(1, "core.start"), ev(2, "generic.result", { p1Score: 2, p2Score: 1 }), settle], 3));
    expect(won.code).toBe("SETTLE_NOT_APPLICABLE");
    expect(Object.hasOwn(won.data as object, "expunged")).toBe(false);
  });

  it("D2: an award whose loser and reason disagree is refused with the rule spelled out", () => {
    const rows = [
      { kind: "award", winner: "H", loser: null, reason: "walkover" },
      { kind: "award", winner: "H", loser: "A", reason: "bye" },
      { kind: "award", winner: "H", loser: "H", reason: "retired" },
    ];
    for (const row of rows) {
      const parsed = MatchOutcome.safeParse(row);
      expect(parsed.success, JSON.stringify(row)).toBe(false);
      expect(parsed.error?.issues.map((i) => i.message), JSON.stringify(row)).toEqual([
        "an award names its loser exactly when it is not a bye, and the loser is never the winner",
      ]);
    }
    expect(MatchOutcome.safeParse({ kind: "award", winner: "H", loser: "A", reason: "retired" }).success).toBe(true);
  });
});

describe("sport/forfeit-credit.ts helpers — the table, every row", () => {
  it("C-5: awardReasonOf reads an award with no reason OR no loser as the bye it was; a full W2b award reads its reason", () => {
    const rows: Array<[Record<string, unknown>, string]> = [
      [{ kind: "award", winner: "H", loser: "A", reason: "retired" }, "retired"],
      [{ kind: "award", winner: "H", loser: null, reason: "bye" }, "bye"],
      [{ kind: "award", winner: "H" }, "bye"], // the pre-W2b bye writers
      [{ kind: "award", winner: "H", loser: "A" }, "bye"], // a loser but no reason
      [{ kind: "award", winner: "H", reason: "walkover" }, "bye"], // a reason but no loser
    ];
    for (const [outcome, want] of rows) expect(awardReasonOf(outcome as never), JSON.stringify(outcome)).toBe(want);
    expect(rows).toHaveLength(5);
  });

  it("D9: creditedMetrics zeroes an excluded key the ledger carries and never invents one it does not", () => {
    const out = creditedMetrics({ games_won: 7, sets_won: 1 }, { perSide: [{ sets_won: 2 }, { sets_lost: 2 }], excluded: ["games_won", "games_lost"] }, "home");
    expect(out).toStrictEqual({ games_won: 0, sets_won: 2 });
    expect(creditedMetrics({}, { perSide: [{}, { sets_lost: 2 }], excluded: ["games_lost"] }, "away")).toStrictEqual({ sets_lost: 2 });
  });

  it("X-DW-4: a double walkover's credit excludes every metric the sport declares — every sport", () => {
    let keys = 0;
    forEachSport(({ module: m }) => {
      for (const { name, cfg } of declaredCfgs(m as never)) {
        const state = m.init(cfg, defaultLineupPair(m.positions));
        const credit = m.forfeitCredit(cfg, state, "walkover", "both");
        const declared = m.metrics.map((x: { key: string }) => x.key);
        for (const key of declared) {
          expect(credit.excluded, `${m.key}/${name}: ${key}`).toContain(key);
          keys++;
        }
        expect(credit.perSide.every((side) => Object.values(side).every((v) => v === 0)), `${m.key}/${name}: nothing credited`).toBe(true);
      }
    });
    expect(keys).toBeGreaterThan(builtinModules.length);
  });
});

describe("stats/stats.ts forfeitStatsRole + the aggregator's appearance skip (X-PS-1, X-PS-2)", () => {
  const forfeit = (seq: number, payload: unknown) => ev(seq, "core.forfeit", payload);

  it("X-PS-1/2 + ruling 115: the role table — unplayed for walkover, withdrawal, double walkover and a DQ with nothing played; played for retired and an in-match DQ; none without a forfeit", () => {
    expect(forfeitStatsRole([])).toBeNull();
    expect(forfeitStatsRole([forfeit(1, { by: A, reason: "walkover" })])).toBe("unplayed");
    expect(forfeitStatsRole([forfeit(1, { by: A, reason: "withdrew" })])).toBe("unplayed");
    expect(forfeitStatsRole([forfeit(1, { by: "both", reason: "walkover" })])).toBe("unplayed");
    expect(forfeitStatsRole([forfeit(1, { by: A, reason: "retired" })])).toBe("played");
    // Ruling 115: a disqualification is in-match only once something is played (`playRecorded`: an active sport event
    // after the Start, scoring or not) — before the Start, after a bare Start, after a pre-Start sport event, or after
    // its only play was voided, it reads as a walkover.
    const start = ev(1, "core.start");
    const play = ev(2, "x.warning");
    const dq = (seq: number) => forfeit(seq, { by: A, reason: "disqualified" });
    expect(forfeitStatsRole([dq(1)]), "before the Start").toBe("unplayed");
    expect(forfeitStatsRole([start, dq(2)]), "after a bare Start").toBe("unplayed");
    expect(forfeitStatsRole([ev(1, "x.card"), ev(2, "core.start"), dq(3)]), "after a sport event before the Start").toBe("unplayed");
    expect(forfeitStatsRole([start, play, dq(3)]), "after a sport event after the Start").toBe("played");
    // `events` is void-resolved (the contract): a voided play is absent, and nothing is played
    expect(forfeitStatsRole(resolveVoids([start, play, makeEnvelope(3, { type: "core.void", payload: {} }, play.id), dq(4)])), "after its only play was voided").toBe("unplayed");
    // judged at the forfeit, not at the ledger's end: an event after it played nothing before it
    expect(forfeitStatsRole([start, dq(2), ev(3, "x.warning")]), "a sport event only after it").toBe("unplayed");
    // the last forfeit is the effective one, each judged by what was played before IT
    expect(forfeitStatsRole([start, dq(2), ev(3, "x.warning"), dq(4)]), "a DQ after play, following one with nothing played").toBe("played");
  });

  it("rulings 115, 120 + X-PS-1/2: playedInStats, the one reader the web counts ask — empty is unplayed, no forfeit and no abandon is played, an abandon only after play; it resolves voids itself; the model's own unplayed wins on a forfeit or an abandon", () => {
    const start = ev(1, "core.start");
    const play = ev(2, "x.warning");
    const voidOf = (seq: number, target: EventEnvelope) => makeEnvelope(seq, { type: "core.void", payload: {} }, target.id);
    const abandon = (seq: number) => ev(seq, "core.abandon", { reason: "rain" });
    /** The reader's contract over a sport ("x") that declares neither a Start that is play nor its own `unplayed`. */
    const NO_DECLARATION = {};
    const rows: Array<[string, EventEnvelope[], boolean]> = [
      // X-PS-1: a walkover / double walkover / bye the product settled without writing an event
      ["no event", [], false],
      ["every event voided", [start, voidOf(2, start)], false],
      // neither a forfeit nor an abandon: played (step 2)
      ["a bare Start", [start], true],
      ["no forfeit, play", [start, play], true],
      ["a walkover", [forfeit(1, { by: A, reason: "walkover" })], false],
      ["a DQ after a bare Start", [start, forfeit(2, { by: A, reason: "disqualified" })], false],
      ["a DQ after play", [start, play, forfeit(3, { by: A, reason: "disqualified" })], true],
      // stored rows as they are, voids unresolved: the voided play leaves nothing played
      ["a DQ after a voided play", [start, play, voidOf(3, play), forfeit(4, { by: A, reason: "disqualified" })], false],
      // a voided walkover is no forfeit at all
      ["a voided walkover", [start, forfeit(2, { by: A, reason: "walkover" }), voidOf(3, forfeit(2, {}))], true],
      // ruling 120: an abandon is a match only if something was played before it — scoring or not (ruling 114)
      ["an abandon after a bare Start", [start, abandon(2)], false],
      ["an abandon after play", [start, play, abandon(3)], true],
      ["an abandon after a voided play", [start, play, voidOf(3, play), abandon(4)], false],
      // judged at the abandon, as a forfeit is (ruling 115): play recorded only after it played nothing before it
      ["play only after the abandon", [start, abandon(2), ev(3, "x.warning")], false],
      ["a voided abandon", [start, abandon(2), voidOf(3, abandon(2))], true],
    ];
    let checked = 0;
    for (const [label, events, want] of rows) {
      expect(playedInStats(events, NO_DECLARATION), label).toBe(want);
      checked++;
    }
    expect(checked).toBe(14);
    // On a forfeit or an abandon the model's own reading outranks the default (chess keeps a classical game played, and
    // reads its Start as play): both directions.
    const retired = forfeit(3, { by: A, reason: "retired" });
    expect(playedInStats([forfeit(1, { by: A, reason: "walkover" })], { playerStats: { unplayed: () => false } }), "model says played").toBe(true);
    expect(playedInStats([start, play, retired], { playerStats: { unplayed: () => true } }), "model says unplayed").toBe(false);
    expect(playedInStats([start, abandon(2)], { playerStats: { unplayed: () => false } }), "an abandon: model says played").toBe(true);
    expect(playedInStats([start, play, abandon(3)], { playerStats: { unplayed: () => true } }), "an abandon: model says unplayed").toBe(false);
    // Ruling 120 reads the module's own "played": where the Start is play, an abandon after a bare Start is a match.
    expect(playedInStats([start, abandon(2)], { startIsPlay: true }), "startIsPlay: an abandon after the Start").toBe(true);
    expect(playedInStats([abandon(1)], { startIsPlay: true }), "startIsPlay: an abandon with no Start").toBe(false);
    // Without an active forfeit or abandon the model is not asked: a ledger it would call unplayed is still played.
    let asked = 0;
    const model = { playerStats: { unplayed: () => (asked++, true) } };
    expect(playedInStats([start, play], model), "neither: played whatever the model says").toBe(true);
    expect(playedInStats([], model), "empty: unplayed whatever the model says").toBe(false);
    expect(asked, "the model is asked only about a ledger with a forfeit or an abandon").toBe(0);
    expect(playedInStats([start, play, abandon(3)], model), "an abandon: the model is asked").toBe(false);
    expect(asked).toBe(1);
  });

  it("an unparseable forfeit is no forfeit — it resets the role rather than reading a field off it", () => {
    expect(forfeitStatsRole([forfeit(1, { by: A, reason: "walkover" }), forfeit(2, { by: 5 })])).toBeNull();
    expect(forfeitStatsRole([forfeit(1, { by: A })])).toBeNull();
  });

  it("PF-1/PF-7: a forfeit after a decided result (decidedBefore) has no stats role — the game was played", () => {
    const result = ev(1, "x.result");
    const decidedBy = (e: EventEnvelope) => e.type === "x.result";
    expect(forfeitStatsRole([result, forfeit(2, { by: A, reason: "withdrew" })], decidedBy)).toBeNull();
    // The positive pair: without the predicate the same withdrawal reads unplayed, and a forfeit BEFORE the result is judged.
    expect(forfeitStatsRole([result, forfeit(2, { by: A, reason: "withdrew" })])).toBe("unplayed");
    expect(forfeitStatsRole([forfeit(1, { by: A, reason: "withdrew" }), ev(2, "x.result")], decidedBy)).toBe("unplayed");
  });

  it("PF-1 (X-WD-1) in chess: a withdrawal over a drawn game keeps the game in both players' `games`", () => {
    const m = mod("boardgame");
    const l = defaultLineupPair(m.positions);
    const persons: Record<string, string[]> = { H: l.home.slots.map((s) => s.personId), [A]: l.away.slots.map((s) => s.personId) };
    const ctx: PlayerStatsFoldCtx = { entrants: [{ id: "H", kind: "individual" }, { id: A, kind: "individual" }], personsOf: (id) => persons[id] ?? [], cfg: m.configSchema.parse({}) };
    const [hp, ap] = [persons.H![0]!, persons[A]![0]!];
    const base = [ev(1, "boardgame.pairing", { white: "H", homePerson: hp, awayPerson: ap }), ev(2, "core.start"), ev(3, "boardgame.result", { winner: null, method: "agreement" })];
    const games = (events: EventEnvelope[]) => {
      const rows = aggregatePlayerStats(events, m.playerStats!, l, ctx);
      return [hp, ap].map((p) => rows.find((r) => r.personId === p)?.stats.games ?? 0);
    };
    expect(games(base), "the drawn game").toEqual([1, 1]);
    expect(games([...base, ev(4, "core.forfeit", { by: A, reason: "withdrew" })]), "withdrawal over the draw").toEqual([1, 1]);
    // The positive pair: a withdrawal before the game is not a game played.
    expect(games([base[0]!, ev(2, "core.forfeit", { by: A, reason: "withdrew" })]), "withdrawal before the start").toEqual([0, 0]);
  });

  it("X-PS-1: a model with an appearance metric and no `unplayed` hook falls back to forfeitStatsRole; per-event credits stay", () => {
    const model: PlayerStatsModel = {
      metrics: [
        { key: "apps", label: "Apps", from: "x.appear", agg: "count", appearance: true },
        { key: "goals", label: "Goals", from: "x.goal", agg: "count" },
      ],
    };
    const played = [ev(1, "x.appear", { person: "p1" }), ev(2, "x.goal", { person: "p1" })];
    const stats = (events: EventEnvelope[]) => {
      const row = aggregatePlayerStats(events, model).find((r) => r.personId === "p1");
      return [row?.stats.apps ?? 0, row?.stats.goals ?? 0];
    };
    expect(stats(played), "no forfeit: [apps, goals]").toEqual([1, 1]);
    expect(stats([...played, ev(3, "core.forfeit", { by: A, reason: "withdrew" })]), "withdrew: no appearance").toEqual([0, 1]);
    expect(stats([...played, ev(3, "core.forfeit", { by: A, reason: "retired" })]), "retired: played").toEqual([1, 1]);
  });
});
