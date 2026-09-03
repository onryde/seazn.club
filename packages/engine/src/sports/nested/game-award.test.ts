// tennis.game.award — S5 (#431). The game-penalty scoring path, one level up
// from the point-penalty pattern DOMAIN.md already documents: a point penalty
// is TWO independently-entered facts — `tennis.sanction{level:"point_penalty"}`
// (pure discipline history, zero score effect) plus an ordinary `tennis.point`
// the chair enters for the opponent. A game penalty works the same way, one
// level up: `tennis.sanction{level:"game_penalty"}` stays completely unchanged
// (still a pure no-op on score — `applySanction` is untouched, and the
// existing frozen `tennis.golden.json` corpora already contain `game_penalty`
// sanction events from the conformance generator), and THIS event is the new,
// separate scoring fact the chair enters alongside it.
//
// `winner`, not `by`. `NestedSanction.by` names the OFFENDER — the same field
// name `NestedPoint.by` uses for the entrant CREDITED with the point, which is
// the opposite meaning one struct away. `winner: EntrantId` sidesteps the trap
// by naming the field for exactly what it holds, matching the engine-wide
// convention `NestedPoint`'s own doc comment already points at
// (`MatchOutcome.winner`).
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import { buildStream, defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import type { ModuleEvent } from "../../sport/module.ts";
import { tennis } from "../tennis/tennis.ts";
import {
  NestedEv,
  NestedGameAward,
  NestedInterruption,
  NestedPoint,
  NestedSanction,
  NestedSetSummary,
  type NestedCfg,
  type NestedState,
} from "./kernel.ts";

const lineups = defaultLineupPair(tennis.positions);
const H = lineups.home.entrantId;
const A = lineups.away.entrantId;

function cfgFor(variant?: string, extra?: Record<string, unknown>): NestedCfg {
  const preset = variant === undefined ? {} : tennis.variants[variant];
  return tennis.configSchema.parse({ ...preset, ...(extra ?? {}) });
}

function envelopes(events: ModuleEvent[]): EventEnvelope[] {
  return events.map((event, i) => makeEnvelope(i, event));
}

// Pad-shaped: every event in these streams is being entered now (§3.3 seam).
const STRICT_ALL = { strictFromSeq: 0 } as const;
function fold(cfg: unknown, events: ModuleEvent[]): NestedState {
  return foldMatch(tennis, cfg, lineups, envelopes(events), STRICT_ALL);
}

const start: ModuleEvent = { type: "core.start", payload: {} };
const point = (by: string): ModuleEvent => ({ type: "tennis.point", payload: { by } });
const summary = (home: number, away: number): ModuleEvent => ({
  type: "tennis.set_summary",
  payload: { home, away },
});
const sanction = (by: string, level: string): ModuleEvent => ({
  type: "tennis.sanction",
  payload: { by, level },
});
const gameAward = (winner: string, reason?: string): ModuleEvent => ({
  type: "tennis.game.award",
  payload: { winner, ...(reason === undefined ? {} : { reason }) },
});

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof EngineError) return error.code;
    return `not-an-EngineError: ${String(error)}`;
  }
  return "no-throw";
}

function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof EngineError) return `${error.code}: ${error.message}`;
    return `not-an-EngineError: ${String(error)}`;
  }
  return "no-throw";
}

// One game, no deuce: four straight points for the same side.
function playGame(side: string): ModuleEvent[] {
  return [point(side), point(side), point(side), point(side)];
}
function playGames(side: string, n: number): ModuleEvent[] {
  const events: ModuleEvent[] = [];
  for (let i = 0; i < n; i++) events.push(...playGame(side));
  return events;
}
// Alternating single games, home first — reaches N-N without ever crossing a
// hi>=gamesTo && hi-lo>=winBy bank threshold, which back-to-back blocks would.
function alternateGames(n: number): ModuleEvent[] {
  const events: ModuleEvent[] = [];
  for (let i = 0; i < n; i++) events.push(...playGame(i % 2 === 0 ? H : A));
  return events;
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("tennis.game.award — the game-penalty scoring path", () => {
  it("awards the game to the credited winner: increments games, resets points, rotates serve", () => {
    const state = fold(cfgFor(), [start, point(H), point(H), point(A), gameAward(H)]);
    expect(state.games).toEqual({ home: 1, away: 0 });
    expect(state.points).toEqual({ kind: "standard", home: 0, away: 0, advantage: null });
    // Home served game 1 (init convention); serve alternates after every game.
    expect(state.serving).toBe("away");
    expect(state.outcome).toBeNull();
  });

  it("credits the game to the WINNER, not the sanctioned offender (regression)", () => {
    // Home is already 4 games to 2 up (built via ordinary points — NOT via
    // gameAward, so the asymmetric baseline does not depend on the code under
    // test) when they draw a code violation. The chair enters BOTH the
    // (score-neutral) sanction against the OFFENDER, home, and the scoring
    // consequence — credited to the OPPONENT, away.
    const setup = [start, ...playGames(H, 4), ...playGames(A, 2)];
    const before = fold(cfgFor(), setup);
    expect(before.games).toEqual({ home: 4, away: 2 });

    const state = fold(cfgFor(), [...setup, sanction(H, "game_penalty"), gameAward(A)]);
    // AWAY's count moved; HOME's (the offender's) did not. Reading `winner` the
    // way `NestedSanction.by` is read (the offender) would award the game to
    // home instead — exactly the trap this schema's field name avoids.
    expect(state.games).toEqual({ home: 4, away: 3 });
  });

  it("banks the set without deciding the match, and opens the next set at 0-0", () => {
    const setup = [start, ...playGames(H, 5), ...playGames(A, 3)];
    const before = fold(cfgFor(), setup);
    expect(before.games).toEqual({ home: 5, away: 3 });
    expect(before.sets).toEqual([]);

    const state = fold(cfgFor(), [...setup, gameAward(H)]);
    expect(state.sets).toEqual([{ home: 6, away: 3 }]);
    expect(state.games).toEqual({ home: 0, away: 0 });
    expect(state.setsWon).toEqual({ home: 1, away: 0 });
    expect(state.phase).toBe("live");
    expect(state.outcome).toBeNull();
  });

  it("decides the match when the awarded game closes out the deciding set", () => {
    // Home already took set one (a tier-0/1 summary shortcut); awarding the
    // next game to home at 5-3 in set two reaches 6-3, banks the set, and —
    // bo3 — decides the match.
    const setup = [start, summary(6, 0), ...playGames(H, 5), ...playGames(A, 3)];
    const state = fold(cfgFor(), [...setup, gameAward(H)]);
    expect(state.sets).toEqual([
      { home: 6, away: 0 },
      { home: 6, away: 3 },
    ]);
    expect(state.setsWon).toEqual({ home: 2, away: 0 });
    expect(state.phase).toBe("done");
    expect(state.outcome).toEqual({ kind: "win", winner: H, loser: A, method: "regulation" });
  });

  it("carries an optional free-text reason with no fold effect", () => {
    const withReason = fold(cfgFor(), [start, gameAward(H, "persistent code violations")]);
    const withoutReason = fold(cfgFor(), [start, gameAward(H)]);
    expect(withReason.games).toEqual(withoutReason.games);
    expect(withReason.points).toEqual(withoutReason.points);
    expect(withReason.serving).toEqual(withoutReason.serving);
    // The fold never reads it, so nothing about the reason reaches state.
    expect(JSON.stringify(withReason)).not.toContain("persistent");
  });

  it("refuses a game award mid-tie-break with GAME_AWARD_DURING_TIEBREAK", () => {
    // 6-6 in games enters the tie-break (tiebreakAt: 6 under "tour").
    const setup = [start, ...alternateGames(12)];
    const live = fold(cfgFor(), setup);
    expect(live.points.kind).toBe("tiebreak");
    expect(codeOf(() => fold(cfgFor(), [...setup, gameAward(H)]))).toBe(
      "GAME_AWARD_DURING_TIEBREAK",
    );
    // The games count must not have moved — refused, not silently applied.
    expect(live.games).toEqual({ home: 6, away: 6 });
  });

  it("refuses a game award mid-match-tie-break too", () => {
    // doubles-noad-mtb10: one set apiece enters the MTB immediately, no games
    // played in the "set".
    const setup = [start, summary(6, 0), summary(0, 6)];
    const state = fold(cfgFor("doubles-noad-mtb10"), setup);
    expect(state.points.kind).toBe("matchTiebreak");
    expect(
      codeOf(() => fold(cfgFor("doubles-noad-mtb10"), [...setup, gameAward(H)])),
    ).toBe("GAME_AWARD_DURING_TIEBREAK");
  });

  // §3.3 review finding (cfg-replay.conformance.test.ts caught this in the
  // full suite, not the scoped nested+tennis run). `state.points.kind` is
  // CFG-DERIVED: whether a tie-break has been entered by the time the fold
  // reaches this event depends on `rules.tiebreakAt`, read live out of
  // `division.config`. A game award legal when it was WRITTEN (standard
  // play) must stay readable forever after, even once an organiser's config
  // edit makes the SAME event sequence enter a tie-break earlier on replay —
  // a refusal computed from cfg must never fire on the read path (same rule
  // `NestedInterruptionRules` and the period kernel's `periodSeconds` state).
  it("keeps an already-recorded game award readable after tiebreakAt is LOWERED (non-strict replay)", () => {
    // Two games played out (home then away) reaches 1-1 — nowhere near a
    // tie-break under the DEFAULT tiebreakAt (6), so the award below is a
    // legal write.
    const setup = [start, ...playGame(H), ...playGame(A)];
    const stream = envelopes([...setup, gameAward(H)]);
    const original = tennis.configSchema.parse({});
    const asRecorded = foldMatch(tennis, original, lineups, stream, { strictFromSeq: 0 });
    expect(asRecorded.games).toEqual({ home: 2, away: 1 });

    // The organiser lowers tiebreakAt to 1. REPLAYED FROM INIT (no strict
    // options — the read path every score page and standings computation
    // actually uses), games reach 1-1 and a tie-break starts BEFORE the
    // recorded award is reached — the same event, now arriving mid-breaker
    // under the edited cfg. This must not throw.
    const lowered = tennis.configSchema.parse({ set: { gamesTo: 6, winBy: 2, tiebreakAt: 1, tiebreakTo: 7 } });
    expect(() => foldMatch(tennis, lowered, lineups, stream)).not.toThrow();
    const replayed = foldMatch(tennis, lowered, lineups, stream);
    // Readable, and deterministic — not merely "did not crash".
    expect(replayed.phase).toBe("live");
    expect(replayed.outcome).toBeNull();
  });

  it("refuses a game award before start, and once the match is decided", () => {
    expect(codeOf(() => fold(cfgFor(), [gameAward(H)]))).toBe("WRONG_PHASE");
    const decided = [start, summary(6, 0), summary(6, 0)];
    expect(codeOf(() => fold(cfgFor(), [...decided, gameAward(H)]))).toBe("ALREADY_DECIDED");
  });

  it("rejects an unknown entrant on winner", () => {
    expect(messageOf(() => fold(cfgFor(), [start, gameAward("ZZ")]))).toBe(
      'INVALID_EVENT: unknown entrant "ZZ"',
    );
  });
});

// ---------------------------------------------------------------------------
// Union disambiguation — §8. The branches carry no discriminator.
// ---------------------------------------------------------------------------

describe("NestedEv union — tennis.game.award (§8 convention)", () => {
  const shapes: [string, Record<string, unknown>][] = [
    ["game award (minimal)", { winner: H }],
    ["game award (with reason)", { winner: H, reason: "persistent code violations" }],
  ];

  it.each(shapes)("%s parses against exactly ONE branch", (_name, payload) => {
    const accepting = NestedEv.options.filter((branch) => branch.safeParse(payload).success);
    expect(accepting).toHaveLength(1);
    expect(NestedEv.parse(payload)).toEqual(payload);
  });

  it("appends game.award LAST, after interruption — appended, never reordered", () => {
    expect(NestedEv.options).toHaveLength(5);
    expect(NestedEv.options[NestedEv.options.length - 1]).toBe(NestedGameAward);
    expect(NestedEv.options[NestedEv.options.length - 2]).toBe(NestedInterruption);
  });

  it("does not let the game-award branch accept a point, summary, sanction or interruption — and no sibling accepts a game award", () => {
    expect(NestedGameAward.safeParse({ by: H }).success).toBe(false);
    expect(NestedGameAward.safeParse({ home: 6, away: 4 }).success).toBe(false);
    expect(NestedGameAward.safeParse({ by: H, level: "warning" }).success).toBe(false);
    expect(NestedGameAward.safeParse({ kind: "medical" }).success).toBe(false);
    expect(NestedPoint.safeParse({ winner: H }).success).toBe(false);
    expect(NestedSetSummary.safeParse({ winner: H }).success).toBe(false);
    expect(NestedSanction.safeParse({ winner: H }).success).toBe(false);
    expect(NestedInterruption.safeParse({ winner: H }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The coordinated edits a new event type owes.
// ---------------------------------------------------------------------------

describe("tennis.game.award is wired everywhere a new type must be", () => {
  it("sits at the attributed-play band (3), not the bare-score or admin bands", () => {
    // W1: formerly asserted the type was named in both tier 2's AND tier 3's
    // arrays (the old cumulative-list model's duplicate) and absent from
    // 0/1. padSpec.fidelity keys the type once, at band 3 — the kernel's
    // max-detail level, matching a point.
    const spec = tennis.padSpec!(cfgFor());
    expect(spec.fidelity["tennis.game.award"]).toBe(3);
    expect(spec.fidelity["tennis.game.award"]).toBe(spec.fidelity["tennis.point"]);
  });

  it("is reachable from arbitraryEvent, so a generated stream exercises it", () => {
    const cfg = cfgFor();
    const seen: string[] = [];
    for (let seed = 1; seed <= 40; seed++) {
      for (const event of buildStream(tennis, cfg, lineups, seed, 400)) {
        if (event.type === "tennis.game.award") seen.push(event.id);
      }
    }
    expect(seen.length).toBeGreaterThan(0);
  });

  it("generates only awards valid for the state — every generated stream folds", () => {
    const cfg = cfgFor();
    for (let seed = 1; seed <= 40; seed++) {
      const events = buildStream(tennis, cfg, lineups, seed, 400);
      expect(() => foldMatch(tennis, cfg, lineups, events), `seed ${seed}`).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Additive safety — §8. `applySanction` for `game_penalty` is untouched.
// ---------------------------------------------------------------------------

describe("additive safety — the sanction half stays a pure no-op", () => {
  it("a game_penalty sanction alone still never moves the score", () => {
    const before = fold(cfgFor(), [start, point(H), point(H)]);
    const state = fold(cfgFor(), [start, point(H), point(H), sanction(A, "game_penalty")]);
    expect(state.points).toEqual(before.points);
    expect(state.games).toEqual(before.games);
    expect(state.sets).toEqual(before.sets);
    expect(state.setsWon).toEqual(before.setsWon);
    expect(state.serving).toEqual(before.serving);
  });

  it("folds a pre-S5 stream (no game.award anywhere) with no new keys in state", () => {
    const state = fold(cfgFor(), [start, point(H), point(A), sanction(H, "warning")]);
    expect(JSON.stringify(state)).not.toContain("game.award");
  });
});
