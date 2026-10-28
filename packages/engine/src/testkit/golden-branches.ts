// Golden streams for a module's OPT-IN config branches (W2c Task 16c) - the other half of "the only real gap is coverage".
//
// WHY. `scripts/fold-epoch-guard.ts` compares corpora, so a config key no recorded stream sets is a branch the guard cannot
// see: W2c added football `shootoutAttempts`, hockey `abandonPolicy: "q4_stands"` and carrom and generic `abandonPolicy:
// "share"`, and their majors had to be raised BY HAND (GOLDEN-POLICY.md, "Unexercised branches"). The `"award"` abandon
// with its withdrawal expunge is not one of them: it is an existing fold (those streams replay identically under main), so
// its stories add coverage of a fold already there, not a bump. The generator never writes any of these keys,
// `extendCorpus` stops at the key being pinned (a config that merely names the key satisfies its `cfg:` token), and the
// golden floor derives its tokens from the KERNEL's events and outcomes, so none of the three append paths ever reaches the branch the key switches on.
//
// WHAT. A table of named stories. Each says which module and config key it exercises, how to BUILD a ledger that takes the
// branch (the module's own generator up to a point the fold confirms, then the kernel event that triggers it - nothing
// here is a hand-typed score line), and what it takes for a RECORDED stream to REACH the branch. `reached` is a verdict
// over the engine's own folds - never a value typed here. Where a ledger can name the key and still miss the branch, the
// verdict is a DIFFERENTIAL: the same ledger refolded under the config WITHOUT the key must decide differently (the
// shoot-out count, the shared abandon). The award and 4th-quarter verdicts carry none, because there the fold's own
// observables already say the abandon was applied (the expunge flag, an abandon that ends the ledger and holds a result)
// and a replay refold of an applied abandon is "abandoned" by construction; the test file reads that refold itself.
//
// HOW IT IS USED. `branchHoles` is the stories no recorded stream reaches (the check that a stream already there is a
// SKIP, not a duplicate); `extendBranches` appends one slim stream per hole. `EXTEND_GOLDEN=1` runs it after the floor.
// Streams carry `seed` in [BRANCH_SEED_BASE, FLOOR_SEED_STRIDE): clear of the generator's walks (below 3000) and of the
// floor's (at or above the stride), so neither the floor's reproduction nor the keep-rule counts them.
//
// This file reads no module's outcome through a method and no fold through `outcomeOf`: the decision is the `outcome`
// field every module keeps in its state (core/events.ts, `summaryOf`), and the expunge is the fold's own `expunged` flag.
// Both are the facts `outcomeOf` combines, and keeping the call out of a non-test file keeps the settle-aware reader
// list in apps/web/.../outcome-readers.test.ts what it is. The test beside this file asks `outcomeOf` itself.
import { foldMatchWithStoppage } from "../core/events.ts";
import { mulberry32, type Rng } from "../core/rng.ts";
import type { LineupPair } from "../core/types.ts";
import { resolvePositions } from "../sport/catalog.ts";
import type { AnySportModule } from "../sport/module.ts";
import { SHOOTOUT_ATTEMPTS_DEFAULT } from "../sports/football/football.ts";
import { periodLabels } from "../sports/period/kernel.ts";
import { corpusFormat, recomputeStream, slimStream, type GoldenCorpus, type GoldenEvent, type GoldenStream } from "./golden.ts";
import { buildWalk, defaultLineupPair, makeEnvelope } from "./helpers.ts";

const STRICT_ALL = { strictFromSeq: 0 } as const;

/** A branch stream's `seed` is `BRANCH_SEED_BASE + n`. Below the floor's stride (100000) on purpose: `isFloor` is `seed >=
 *  stride`, and a stream the floor did not derive must not be counted as one. Above every generator seed (the coverage
 *  scan stops at 3000), so a later `extendCorpus` can never collide with it. The epoch guard keys a stream `config#seed`. */
export const BRANCH_SEED_BASE = 90_000;
/** How many generator seeds a builder searches; the SHORTEST ledger that reaches the branch wins, ties to the lowest seed. */
const SEED_BUDGET = 150;
/** A shoot-out that goes to sudden death is rare among generator walks (about one seed in twenty reaches a shoot-out at all, and
 *  a tie after the configured kicks is a fraction of those): within this budget the shortest ledger that takes it is seed 572's. */
const SUDDEN_DEATH_SEED_BUDGET = 700;
/** The longest ledger a builder will walk. */
const WALK_MAX = 120;

const ev = (type: string, payload: unknown = {}): GoldenEvent => ({ type, payload });
const obj = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

/** A recorded stream as a verdict sees it: the module, the RAW config it was recorded under, its lineups (absent = the
 *  default pair) and its ledger. */
export interface Recorded {
  readonly module: AnySportModule;
  readonly raw: unknown;
  readonly lineups: LineupPair | undefined;
  readonly events: readonly GoldenEvent[];
}

/** One strict fold of a ledger under a raw config: the module state, the parsed config, and the kernel's `expunged`. */
export interface Replay {
  readonly state: Record<string, unknown>;
  readonly cfg: unknown;
  readonly expunged: boolean;
}

/** Folds `r`'s ledger under `raw` (the stream's own, or a counterfactual), or says why it cannot. */
export function replay(r: Recorded, raw: unknown): Replay | string {
  try {
    const cfg = r.module.configSchema.parse(raw) as unknown;
    const lineups = r.lineups ?? defaultLineupPair(resolvePositions(r.module, cfg));
    const folded = foldMatchWithStoppage(
      r.module as never,
      cfg as never,
      lineups,
      r.events.map((e, i) => makeEnvelope(i, e, e.voids)),
      STRICT_ALL,
    );
    return { state: obj(folded.state), cfg, expunged: folded.expunged };
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The result a module's state holds, or null while nothing is decided. */
const held = (state: Record<string, unknown>): Record<string, unknown> | null => (state.outcome === null || state.outcome === undefined ? null : obj(state.outcome));
/** The config without `key`: the counterfactual every differential refolds under. */
const without = (raw: unknown, key: string): Record<string, unknown> => Object.fromEntries(Object.entries(obj(raw)).filter(([k]) => k !== key));
const lastEvent = (r: Recorded): GoldenEvent | undefined => r.events[r.events.length - 1];

/** The differential for an abandon policy: refolded under `raw` (the replay default - the key gone), the same ledger is an
 *  ABANDONED match. A ledger that merely names the policy, or reaches its result some other way (carrom's drawn walk), is
 *  still "final" there, so the abandon was never what decided it. (An abandon the fold applies always closes a replay-policy
 *  match as abandoned with nothing decided, so that is the one check - the rest of what it holds is the engine's.) A
 *  counterfactual config the module refuses is reported, not thrown: exported so a test can hand it one. */
export function replaysOnAbandon(r: Recorded, raw: unknown): string | null {
  const replayed = replay(r, raw);
  if (typeof replayed === "string") return `the counterfactual config does not fold the ledger: ${replayed}`;
  if (replayed.state.phase !== "abandoned") return `under the replay default the ledger is "${String(replayed.state.phase)}", not an abandoned match, so the abandon never ran`;
  return null;
}

// ----------------------------------------------------------------------------------------------------------- verdicts

/** football `shootoutAttempts`: a shoot-out won inside a SHORTER count of kicks than the default plays. The differential:
 *  the same kicks under the default leave the match undecided, so the stream cannot be told from one that never set the key. */
function reachesShootoutAttempts(r: Recorded): string | null {
  const attempts = obj(r.raw).shootoutAttempts;
  if (typeof attempts !== "number") return "its config sets no shootoutAttempts";
  if (attempts >= SHOOTOUT_ATTEMPTS_DEFAULT) return `shootoutAttempts ${attempts} is not shorter than the default ${SHOOTOUT_ATTEMPTS_DEFAULT}`;
  const played = replay(r, r.raw);
  if (typeof played === "string") return played;
  const result = held(played.state);
  if (result?.kind !== "win" || result.method !== "shootout") return "the ledger does not end in a shoot-out win";
  const byDefault = replay(r, without(r.raw, "shootoutAttempts"));
  if (typeof byDefault === "string") return `under the default ${SHOOTOUT_ATTEMPTS_DEFAULT} kicks the ledger does not fold: ${byDefault}`;
  if (held(byDefault.state) !== null) return `the default ${SHOOTOUT_ATTEMPTS_DEFAULT} kicks decide the same ledger, so it proves nothing about the key`;
  return null;
}

/** carrom and generic `abandonPolicy: "share"`: an abandoned match that is a DRAW. The differential: without the policy the
 *  same ledger is a closed, undecided match - which also proves it contains an abandon, not a drawn walk (carrom's
 *  `sharedAbandon#200125` is a draw and shares nothing). */
function reachesSharedAbandon(r: Recorded): string | null {
  if (obj(r.raw).abandonPolicy !== "share") return "its config does not share the points of an abandoned match";
  const played = replay(r, r.raw);
  if (typeof played === "string") return played;
  if (held(played.state)?.kind !== "draw") return "the ledger does not end in a draw";
  return replaysOnAbandon(r, without(r.raw, "abandonPolicy"));
}

/** `abandonPolicy: "award"` with an EXPUNGE, ending on `kind`: the module holds the result the award gives (a leader's win
 *  by abandonment, or a draw) and the kernel's fold reports the withdrawal's expunge (which `outcomeOf` reads as no outcome
 *  at all). No replay differential here: the expunge flag exists only on an applied `core.abandon`, and the fold's one abandon
 *  under the replay default always holds nothing, so that refold could not tell any ledger that passes this from one that
 *  fails it. */
function reachesAwardExpunge(kind: "win" | "draw"): (r: Recorded) => string | null {
  return (r) => {
    if (obj(r.raw).abandonPolicy !== "award") return "its config does not award an abandoned match";
    const played = replay(r, r.raw);
    if (typeof played === "string") return played;
    if (!played.expunged) return "the fold reports no expunge: the active abandon does not carry expunge: true";
    const result = held(played.state);
    if (result?.kind !== kind) return `the module does not hold ${kind === "win" ? "the leader's win by abandonment" : "a draw"} under the expunge`;
    return null;
  };
}

/** hockey `abandonPolicy: "q4_stands"`: an abandon that ENDS the ledger and still holds a result - which under this policy
 *  only happens from the 4th quarter on (before it the same abandon replays and holds nothing; the builder aims at the
 *  4th quarter itself and the test reads the phase independently). No replay differential: the abandon is the last event
 *  and the fold applied it, so the replay refold is "abandoned" by construction. */
function reachesQ4Stands(r: Recorded): string | null {
  if (obj(r.raw).abandonPolicy !== "q4_stands") return "its config does not apply the 4th-quarter rule";
  const last = lastEvent(r);
  if (last?.type !== "core.abandon") return "the ledger does not end on an abandon";
  const played = replay(r, r.raw);
  if (typeof played === "string") return played;
  if (held(played.state) === null) return "the abandon holds no result: the score did not stand";
  return null;
}

/** icehockey `abandonPolicy: "award"` under a cfg that lets NO draw stand (the IIHF default plays an overtime and a
 *  shoot-out): a level abandon is not a draw, it is flagged for a replay exactly as the replay policy would (R16-3, ruling
 *  X-DR-1). `replayFlagged` under the award policy has no other route - a leader wins and a level score under a draw-standing
 *  cfg is a draw - so the flag IS the arm; the test reads the draw-standing refold itself. */
function reachesLevelAwardFlagged(r: Recorded): string | null {
  if (obj(r.raw).abandonPolicy !== "award") return "its config does not award an abandoned match";
  if (lastEvent(r)?.type !== "core.abandon") return "the ledger does not end on an abandon";
  const played = replay(r, r.raw);
  if (typeof played === "string") return played;
  if (played.state.replayFlagged !== true) return "the abandon is not flagged for a replay: under this config it decided a result instead";
  return null;
}

/** football `abandonPolicy: "award"`, the LEVEL arm: an abandon at a level score is a draw on the real score, with no
 *  expunge in play (the leader's win by abandonment, with the withdrawal's expunge, is `football.award_expunge`). */
function reachesAwardLevelDraw(r: Recorded): string | null {
  if (obj(r.raw).abandonPolicy !== "award") return "its config does not award an abandoned match";
  if (lastEvent(r)?.type !== "core.abandon") return "the ledger does not end on an abandon";
  const played = replay(r, r.raw);
  if (typeof played === "string") return played;
  if (held(played.state)?.kind !== "draw") return "the module does not hold a draw for the abandon";
  return null;
}

/** football `shootoutAttempts` taken past its count: a side kicked MORE than the configured attempts, so the shoot-out went
 *  to sudden death (shootout.ts: after `attempts` each, a side is entitled to match the opponent's kick count). It is the
 *  shoot-out win of `reachesShootoutAttempts` - with its differential, which is what makes the sudden death the KEY's and
 *  not the default's (a tied run to a sixth pair is sudden death under five as well) - plus the kicks past the count. */
function reachesShootoutSuddenDeath(r: Recorded): string | null {
  const decided = reachesShootoutAttempts(r);
  if (decided !== null) return decided;
  const attempts = obj(r.raw).shootoutAttempts as number;
  const played = replay(r, r.raw);
  if (typeof played === "string") return played;
  const kicks = obj(played.state.shootout).kicks as { side: string }[];
  const taken = (side: string): number => kicks.filter((k) => k.side === side).length;
  if (Math.max(taken("home"), taken("away")) <= attempts) return `no side kicked past its ${attempts} attempts, so the shoot-out was decided without sudden death`;
  return null;
}

/** Whether a closed set in `state` was won on its tie-break's deciding point: the target to one below it (5–4 to five). */
function closedOnDecidingPoint(state: Record<string, unknown>, to: number): boolean {
  const sets = Array.isArray(state.sets) ? (state.sets as unknown[]) : [];
  return sets.some((s) => {
    const tb = obj(obj(s).tb);
    const [h, a] = [Number(tb.home), Number(tb.away)];
    return Math.max(h, a) === to && Math.min(h, a) === to - 1;
  });
}

/** tennis `set.tiebreakWinBy` (W2e RB2A-12, TN-SS-2; ITF App VI §2, RBS:347): a short-set tie-break closed on its deciding
 *  point at four all, 5–4. Only a margin of one closes a tie-break one point clear of its target's runner-up, so the close
 *  is itself the differential: under the margin every set tie-break played before W2e (the match's two) the same ledger
 *  plays on from 5–4 or is refused there. A stream that only names the key (short sets with no tie-break) does not reach it. */
function reachesShortSetDecidingPoint(r: Recorded): string | null {
  if (obj(obj(r.raw).set).tiebreakWinBy !== 1) return "its config's set tie-break is not won by one point";
  const played = replay(r, r.raw);
  if (typeof played === "string") return played;
  const to = Number(obj(obj(played.cfg).set).tiebreakTo);
  if (!closedOnDecidingPoint(played.state, to)) return `no set closes on its tie-break's deciding point (${to}–${to - 1})`;
  return null;
}

/** `reachesShortSetDecidingPoint`, with the close PLAYED: the deciding point is a `tennis.point`, the ledger's last event. A
 *  summary only states a final score, so it reaches the summary check and never the point fold (`applyTbPoint`), which is
 *  where a margin of one ends a tie-break. */
function reachesShortSetDecidingPointPlayed(r: Recorded): string | null {
  const closed = reachesShortSetDecidingPoint(r);
  if (closed !== null) return closed;
  if (lastEvent(r)?.type !== "tennis.point") return "the deciding point is not closed by a played point";
  return null;
}

/** tennis `finalSet` beside a set's own margin (W2e TN-SS-2; RBS:349, App VI §5): short sets, whose tie-break is won by one,
 *  with a final-set tie-break to ten, which keeps the match's margin of two. The deciding set's tie-break is PLAYED past its
 *  target, ending two clear (11–9): it went through 10–9, which the set's margin of one would have closed. */
function reachesFinalSetTiebreakAtMatchMargin(r: Recorded): string | null {
  const raw = obj(r.raw);
  if (obj(raw.finalSet).tiebreakTo === undefined) return "its config plays no final-set tie-break";
  if (obj(raw.set).tiebreakWinBy !== 1) return "its config's set tie-break is not won by one point";
  const played = replay(r, r.raw);
  if (typeof played === "string") return played;
  const cfg = obj(played.cfg);
  const to = Number(obj(cfg.finalSet).tiebreakTo);
  const margin = Number(obj(cfg.tiebreak).winBy);
  const sets = Array.isArray(played.state.sets) ? (played.state.sets as unknown[]) : [];
  const pastTarget = sets.some((s) => {
    const tb = obj(obj(s).tb);
    const [h, a] = [Number(tb.home), Number(tb.away)];
    return Math.max(h, a) > to && Math.abs(h - a) === margin;
  });
  if (!pastTarget) return `no final-set tie-break closes past ${to} by the match's margin of ${margin}`;
  if (lastEvent(r)?.type !== "tennis.point") return "the final-set tie-break is not closed by a played point";
  return null;
}

// ----------------------------------------------------------------------------------------------------------- builders

interface BuildCtx {
  readonly module: AnySportModule;
  readonly raw: unknown;
  readonly cfg: unknown;
  readonly lineups: LineupPair;
  readonly recorded: (events: readonly GoldenEvent[]) => Recorded;
}

/** One draw of a module-owned (non-kernel) event from the generator; a forfeit or an abandon is not play. */
function drawSport(module: AnySportModule, state: unknown, rng: Rng): GoldenEvent | null {
  for (let i = 0; i < 25; i++) {
    const next = module.arbitraryEvent?.call(module, state as never, rng) ?? null;
    if (next === null) return null;
    if (!next.type.startsWith("core.")) return { type: next.type, payload: next.payload };
  }
  return null;
}

/** `[core.start, ...]` drawn from the module's own generator until `stop` holds on the state it reaches, or null when the
 *  match is decided first. Each step folds the WHOLE ledger so far through the kernel (`replay`, strict) rather than
 *  stepping `module.apply` by hand, so the state the generator draws from is the one the real fold holds, and an event the
 *  fold would refuse sends the search to the next seed. */
function playUntil(c: BuildCtx, seed: number, stop: (state: Record<string, unknown>, events: readonly GoldenEvent[]) => boolean): GoldenEvent[] | null {
  const rng = mulberry32(seed);
  const events: GoldenEvent[] = [ev("core.start")];
  for (let i = 0; i < WALK_MAX; i++) {
    const folded = replay({ module: c.module, raw: c.raw, lineups: c.lineups, events }, c.raw);
    if (typeof folded === "string") return null;
    if (held(folded.state) !== null) return null;
    if (stop(folded.state, events)) return events;
    const next = drawSport(c.module, folded.state, rng);
    if (next === null) return null;
    events.push(next);
  }
  return null;
}

/** The shortest ledger (ties: the lowest seed) a seed search offers that `reached` accepts. */
function shortest(c: BuildCtx, reached: (r: Recorded) => string | null, ledgerOf: (seed: number) => GoldenEvent[] | null, budget = SEED_BUDGET): GoldenEvent[] | null {
  let best: GoldenEvent[] | null = null;
  for (let seed = 1; seed <= budget; seed++) {
    const events = ledgerOf(seed);
    if (events === null || (best !== null && events.length >= best.length)) continue;
    if (reached(c.recorded(events)) === null) best = events;
  }
  return best;
}

/** A match played to `stop`, then ended by `last` (the kernel event the branch is about). */
function playThen(c: BuildCtx, reached: (r: Recorded) => string | null, stop: Parameters<typeof playUntil>[2], last: GoldenEvent): GoldenEvent[] | null {
  return shortest(c, reached, (seed) => {
    const played = playUntil(c, seed, stop);
    return played === null ? null : [...played, last];
  });
}

/** A ledger that steps the FOLD, not the generator: `next` names each event from the state the kernel holds (folded strictly,
 *  whole, every step, like `playUntil`), until `done` holds - or null if the fold refuses one or the match ends first. For
 *  a branch only a PLAYED tie-break reaches: a generator walk plays one point by point about never within `WALK_MAX`, so
 *  these ledgers name the winners themselves - level until the score the rule is about, then one side. */
function stepFold(c: BuildCtx, next: (state: Record<string, unknown>) => GoldenEvent, done: (state: Record<string, unknown>) => boolean): GoldenEvent[] | null {
  const events: GoldenEvent[] = [ev("core.start")];
  for (let i = 0; i < WALK_MAX; i++) {
    const folded = replay({ module: c.module, raw: c.raw, lineups: c.lineups, events }, c.raw);
    if (typeof folded === "string") return null;
    if (done(folded.state)) return events;
    if (held(folded.state) !== null) return null;
    events.push(next(folded.state));
  }
  return null;
}

/** The next tennis event that keeps a set level up to the score `to - 1` all of its tie-break and then gives the home side
 *  every point: games alternate (home first) until the tie-break opens, its points alternate until `to - 1` all, then home.
 *  `setWinner` names who takes every game of a set before the deciding one (null: play every set level). */
function levelToTiebreak(c: BuildCtx, to: (state: Record<string, unknown>) => number, setWinner: (setsPlayed: number) => "home" | "away" | null) {
  const H = c.lineups.home.entrantId;
  const A = c.lineups.away.entrantId;
  return (state: Record<string, unknown>): GoldenEvent => {
    const points = obj(state.points);
    if (points.kind === "tiebreak") {
      const [h, a] = [Number(points.home), Number(points.away)];
      const by = Math.min(h, a) < to(state) - 1 && h > a ? A : H;
      return ev("tennis.point", { by });
    }
    const won = obj(state.setsWon);
    const owner = setWinner(Number(won.home) + Number(won.away));
    const games = obj(state.games);
    const winner = owner === "home" ? H : owner === "away" ? A : Number(games.home) > Number(games.away) ? A : H;
    return ev("tennis.game.award", { winner });
  };
}

const goals = (state: Record<string, unknown>): { home: number; away: number } => {
  const g = obj(state.goals);
  return { home: Number(g.home), away: Number(g.away) };
};
const leading = (state: Record<string, unknown>): boolean => goals(state).home !== goals(state).away;
const levelWithGoals = (state: Record<string, unknown>): boolean => goals(state).home === goals(state).away && goals(state).home >= 1;
/** A withdrawal's abandon: the fixture left the table (W2b D5), written exactly as the cascade writes it. */
const EXPUNGE = ev("core.abandon", { reason: "withdrew", expunge: true });

// ------------------------------------------------------------------------------------------------------------ stories

export interface BranchStory {
  /** `<sport>.<what>`, unique: the token a hole is named by. */
  readonly id: string;
  /** The module key. */
  readonly sport: string;
  /** The config key the branch is switched by (the one every differential removes). */
  readonly key: string;
  /** The stream's `seed`, in [BRANCH_SEED_BASE, FLOOR_SEED_STRIDE); its identity is `config#seed`. */
  readonly seed: number;
  /** The config the stream is recorded under. A name the corpus already holds keeps its recorded raw (which must match). */
  readonly config: { readonly name: string; readonly raw: Record<string, unknown> };
  /** The branch this exists for, in the words of the ruling. */
  readonly what: string;
  /** null when a RECORDED stream reaches the branch, else why it does not. */
  reached(r: Recorded): string | null;
  /** The ledger of a stream that reaches it, or null when the seed budget finds none. */
  build(c: BuildCtx): GoldenEvent[] | null;
}

export const BRANCH_STORIES: readonly BranchStory[] = [
  {
    id: "football.shootoutAttempts",
    sport: "football",
    key: "shootoutAttempts",
    seed: BRANCH_SEED_BASE + 1,
    config: { name: "youthKnockout", raw: { extraTime: { enabled: true, halfMinutes: 15 }, shootout: true, shootoutAttempts: 3 } },
    what: "a youth knockout (3 kicks each) that is decided on penalties",
    reached: reachesShootoutAttempts,
    build: (c) => shortest(c, reachesShootoutAttempts, (seed) => {
      try {
        const walk = buildWalk(c.module, c.cfg, c.lineups, seed, WALK_MAX).events;
        return walk.map((e) => ({ type: e.type, payload: e.payload }));
      } catch {
        return null;
      }
    }),
  },
  {
    id: "hockey.q4_stands",
    sport: "hockey",
    key: "abandonPolicy",
    seed: BRANCH_SEED_BASE + 2,
    config: { name: "q4Stands", raw: { abandonPolicy: "q4_stands" } },
    what: "an abandon in the 4th quarter, the leader's score standing (HK-AB-2)",
    reached: reachesQ4Stands,
    build: (c) => {
      const final = periodLabels(c.cfg as never).at(-1);
      return playThen(c, reachesQ4Stands, (state) => state.phase === final && leading(state), ev("core.abandon", { reason: "conditions" }));
    },
  },
  {
    id: "carrom.share",
    sport: "carrom",
    key: "abandonPolicy",
    seed: BRANCH_SEED_BASE + 3,
    config: { name: "sharedAbandon", raw: { tieBoard: "draw", abandonPolicy: "share" } },
    what: "an abandoned match that shares the points as a draw (CA-AB-2)",
    reached: reachesSharedAbandon,
    build: (c) => playThen(c, reachesSharedAbandon, (_state, events) => events.length >= 3, ev("core.abandon", { reason: "rain" })),
  },
  {
    id: "generic.share",
    sport: "generic",
    key: "abandonPolicy",
    seed: BRANCH_SEED_BASE + 4,
    config: { name: "sharedAbandon", raw: { resultMode: "score", allowDraws: true, abandonPolicy: "share" } },
    what: "an abandoned match that shares the points as a draw, the running tally standing (GN-AB-2)",
    reached: reachesSharedAbandon,
    build: (c) => playThen(c, reachesSharedAbandon, (state) => {
      const running = obj(state.running);
      return state.running !== undefined && running.home !== running.away;
    }, ev("core.abandon", { reason: "rain" })),
  },
  {
    id: "football.award_expunge",
    sport: "football",
    key: "abandonPolicy",
    seed: BRANCH_SEED_BASE + 5,
    config: { name: "abandonAward", raw: { abandonPolicy: "award" } },
    what: "an award-policy abandon that is then expunged by a withdrawal, the leader holding the win (FB-AB-1)",
    reached: reachesAwardExpunge("win"),
    build: (c) => playThen(c, reachesAwardExpunge("win"), (state) => leading(state), EXPUNGE),
  },
  {
    id: "hockey.award_expunge",
    sport: "hockey",
    key: "abandonPolicy",
    seed: BRANCH_SEED_BASE + 6,
    config: { name: "abandonAward", raw: { abandonPolicy: "award" } },
    what: "an award-policy abandon at a level score (the period kernel answers a draw) that is then expunged (HK-AB-1)",
    reached: reachesAwardExpunge("draw"),
    build: (c) => playThen(c, reachesAwardExpunge("draw"), levelWithGoals, EXPUNGE),
  },
  {
    id: "icehockey.award_expunge",
    sport: "icehockey",
    key: "abandonPolicy",
    seed: BRANCH_SEED_BASE + 7,
    // A level abandon is a draw only where the cfg lets a draw stand (X-DR-1, R16-3): the IIHF default has an overtime
    // and a shoot-out, so this is the recreational shape (neither), which is the config a draw is reachable under.
    config: { name: "abandonAward", raw: { overtime: null, shootout: null, abandonPolicy: "award" } },
    what: "an award-policy abandon at a level score, in a cfg where a draw stands, that is then expunged (IH-AB-1)",
    reached: reachesAwardExpunge("draw"),
    build: (c) => playThen(c, reachesAwardExpunge("draw"), levelWithGoals, EXPUNGE),
  },
  {
    id: "icehockey.award_level_flagged",
    sport: "icehockey",
    key: "abandonPolicy",
    seed: BRANCH_SEED_BASE + 8,
    // the IIHF default plays an overtime and a shoot-out, so no draw can stand (R16-3): the config is the policy alone
    config: { name: "abandonAwardIihf", raw: { abandonPolicy: "award" } },
    what: "an award-policy abandon at a level score where the cfg lets no draw stand: flagged for a replay, not a draw (R16-3, IH-AB-1)",
    reached: reachesLevelAwardFlagged,
    build: (c) => playThen(c, reachesLevelAwardFlagged, levelWithGoals, ev("core.abandon", { reason: "conditions" })),
  },
  {
    id: "football.award_draw",
    sport: "football",
    key: "abandonPolicy",
    seed: BRANCH_SEED_BASE + 9,
    config: { name: "abandonAward", raw: { abandonPolicy: "award" } },
    what: "an award-policy abandon at a level score: a draw on the real score (FB-AB-1)",
    reached: reachesAwardLevelDraw,
    build: (c) => playThen(c, reachesAwardLevelDraw, levelWithGoals, ev("core.abandon", { reason: "conditions" })),
  },
  {
    id: "football.shootout_sudden_death",
    sport: "football",
    key: "shootoutAttempts",
    seed: BRANCH_SEED_BASE + 10,
    config: { name: "youthKnockout", raw: { extraTime: { enabled: true, halfMinutes: 15 }, shootout: true, shootoutAttempts: 3 } },
    what: "a youth knockout (3 kicks each) whose shoot-out is level after the three and goes to sudden death",
    reached: reachesShootoutSuddenDeath,
    build: (c) => shortest(c, reachesShootoutSuddenDeath, (seed) => {
      try {
        const walk = buildWalk(c.module, c.cfg, c.lineups, seed, WALK_MAX).events;
        return walk.map((e) => ({ type: e.type, payload: e.payload }));
      } catch {
        return null;
      }
    }, SUDDEN_DEATH_SEED_BUDGET),
  },
  {
    // W2e Task 13 (Task 5 review m2): the opt-in key Task 5 added. GOLDEN-POLICY.md: "A NEW opt-in key owes a story".
    id: "tennis.short_set_deciding_point",
    sport: "tennis",
    key: "set",
    seed: BRANCH_SEED_BASE + 11,
    config: { name: "short-sets", raw: { set: { gamesTo: 4, winBy: 2, tiebreakAt: 4, tiebreakTo: 5, tiebreakWinBy: 1 } } },
    what: "short sets (App VI §1-2) whose tie-break at four games all is won 5–4 on the deciding point (`set.tiebreakWinBy` 1)",
    reached: reachesShortSetDecidingPoint,
    build: (c) => {
      const to = Number(obj(obj(c.cfg).set).tiebreakTo);
      return shortest(c, reachesShortSetDecidingPoint, (seed) => playUntil(c, seed, (state) => closedOnDecidingPoint(state, to)));
    },
  },
  {
    // Fix round 1 (review I-1): the summary above never reaches the point fold, so a margin mutant in `applyTbPoint` was
    // green across the golden suite. This one plays the tie-break.
    id: "tennis.short_set_deciding_point_played",
    sport: "tennis",
    key: "set",
    seed: BRANCH_SEED_BASE + 12,
    config: { name: "short-sets", raw: { set: { gamesTo: 4, winBy: 2, tiebreakAt: 4, tiebreakTo: 5, tiebreakWinBy: 1 } } },
    what: "short sets whose tie-break at four games all is PLAYED to four points all and won 5–4 on the deciding point",
    reached: reachesShortSetDecidingPointPlayed,
    build: (c) => {
      const to = Number(obj(obj(c.cfg).set).tiebreakTo);
      return stepFold(c, levelToTiebreak(c, () => to, () => null), (state) => closedOnDecidingPoint(state, to));
    },
  },
  {
    // Fix round 1 (review I-1): a config that sets both margins, so the decider's (`rulesFor`) is in the corpus.
    id: "tennis.final_set_tiebreak_match_margin",
    sport: "tennis",
    key: "finalSet",
    seed: BRANCH_SEED_BASE + 13,
    config: {
      name: "short-sets-final-tiebreak-10",
      raw: { set: { gamesTo: 4, winBy: 2, tiebreakAt: 4, tiebreakTo: 5, tiebreakWinBy: 1 }, finalSet: { tiebreakTo: 10 } },
    },
    what: "short sets with a final-set tie-break to ten: one set each, then the decider's tie-break played through 10–9 to 11–9",
    reached: reachesFinalSetTiebreakAtMatchMargin,
    build: (c) => {
      const to = Number(obj(obj(c.cfg).finalSet).tiebreakTo);
      const setTo = Number(obj(obj(c.cfg).set).tiebreakTo);
      const deciding = (state: Record<string, unknown>): boolean => Number(obj(state.setsWon).home) + Number(obj(state.setsWon).away) === 2;
      return stepFold(
        c,
        levelToTiebreak(c, (state) => (deciding(state) ? to : setTo), (played) => (played === 0 ? "home" : played === 1 ? "away" : null)),
        (state) => held(state) !== null,
      );
    },
  },
];

// ------------------------------------------------------------------------------------------------------------- driver

const recordedOf = (module: AnySportModule, corpus: GoldenCorpus, stream: GoldenStream): Recorded => ({
  module,
  raw: corpus.configs[stream.config],
  lineups: stream.lineups,
  events: stream.events,
});

/** The stories of `module` that NO recorded stream reaches. A stream that already reaches one - whatever its config
 *  name or seed - makes that story a skip. */
export function branchHoles(module: AnySportModule, corpus: GoldenCorpus, stories: readonly BranchStory[] = BRANCH_STORIES): string[] {
  return stories
    .filter((story) => story.sport === module.key)
    .filter((story) => !corpus.streams.some((stream) => story.reached(recordedOf(module, corpus, stream)) === null))
    .map((story) => story.id);
}

export interface BranchExtension {
  readonly corpus: GoldenCorpus;
  /** `story-id config:seed` of every stream appended, in story order. */
  readonly appended: string[];
  /** The holes a builder could not close in its seed budget. */
  readonly stillMissing: string[];
}

/** Appends one slim stream per hole, after everything already there. Existing streams and configs are carried over
 *  untouched; a corpus with no holes comes back unchanged (a second call appends nothing). A name that is already taken
 *  by another stream, or a config name held with a different raw, is refused by name: the epoch guard keys a stream by
 *  `config#seed`, and a quiet overwrite would change an existing stream's input. */
export function extendBranches(module: AnySportModule, existing: GoldenCorpus, stories: readonly BranchStory[] = BRANCH_STORIES): BranchExtension {
  const corpus: GoldenCorpus = { ...existing, configs: { ...existing.configs }, streams: [...existing.streams] };
  const appended: string[] = [];
  const stillMissing: string[] = [];
  for (const story of stories.filter((s) => s.sport === module.key)) {
    if (corpus.streams.some((stream) => story.reached(recordedOf(module, corpus, stream)) === null)) continue;
    const { name, raw } = story.config;
    const recordedRaw = corpus.configs[name];
    if (recordedRaw !== undefined && JSON.stringify(recordedRaw) !== JSON.stringify(raw)) {
      throw new Error(`golden branches: ${module.key} already records a config "${name}" that is not the one ${story.id} needs; the epoch guard compares a stream's raw config`);
    }
    if (corpus.streams.some((s) => s.config === name && s.seed === story.seed)) {
      throw new Error(`golden branches: ${module.key} already has a stream ${name}#${story.seed}; the epoch guard keys streams by that identity`);
    }
    const cfg = module.configSchema.parse(raw) as unknown;
    const lineups = defaultLineupPair(resolvePositions(module, cfg));
    const events = story.build({
      module,
      raw,
      cfg,
      lineups,
      recorded: (ledger) => ({ module, raw, lineups: undefined, events: ledger }),
    });
    if (events === null) {
      stillMissing.push(story.id);
      continue;
    }
    corpus.configs[name] = raw;
    const stream: GoldenStream = { config: name, seed: story.seed, events, ...recomputeStream(module, raw, events, undefined, corpusFormat(corpus)) };
    const verdict = story.reached(recordedOf(module, corpus, stream));
    if (verdict !== null) throw new Error(`golden branches: the ledger built for ${story.id} does not reach its branch: ${verdict}`);
    corpus.streams.push(slimStream(module, corpus, stream));
    appended.push(`${story.id} ${name}:${story.seed}`);
  }
  return { corpus, appended, stillMissing };
}
