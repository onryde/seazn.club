// Golden streams for a module's OPT-IN config branches (W2c Task 16c) - the other half of "the only real gap is coverage".
//
// WHY. `scripts/fold-epoch-guard.ts` compares corpora, so a config key no recorded stream sets is a branch the guard cannot
// see: W2c added football `shootoutAttempts`, hockey `abandonPolicy: "q4_stands"`, carrom and generic `abandonPolicy:
// "share"` and the `"award"` abandon with its expunge, and their majors had to be raised BY HAND (GOLDEN-POLICY.md,
// "Unexercised branches"). The generator never writes any of them, `extendCorpus` stops at the key being pinned (a
// config that merely names the key satisfies its `cfg:` token), and the golden floor derives its tokens from the KERNEL's
// events and outcomes, so none of the three append paths ever reaches the branch the key switches on.
//
// WHAT. A table of named stories. Each says which module and config key it exercises, how to BUILD a ledger that takes the
// branch (the module's own generator up to a point the fold confirms, then the kernel event that triggers it - nothing
// here is a hand-typed score line), and what it takes for a RECORDED stream to REACH the branch. `reached` is a verdict
// over the engine's own folds - never a value typed here - and each branch is proven by a DIFFERENTIAL: the same ledger
// refolded under the config WITHOUT the key must decide differently, or the stream proves nothing about the key.
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
import { recomputeStream, slimStream, type GoldenCorpus, type GoldenEvent, type GoldenStream } from "./golden.ts";
import { buildWalk, defaultLineupPair, makeEnvelope } from "./helpers.ts";

const STRICT_ALL = { strictFromSeq: 0 } as const;

/** A branch stream's `seed` is `BRANCH_SEED_BASE + n`. Below the floor's stride (100000) on purpose: `isFloor` is `seed >=
 *  stride`, and a stream the floor did not derive must not be counted as one. Above every generator seed (the coverage
 *  scan stops at 3000), so a later `extendCorpus` can never collide with it. The epoch guard keys a stream `config#seed`. */
export const BRANCH_SEED_BASE = 90_000;
/** How many generator seeds a builder searches; the SHORTEST ledger that reaches the branch wins, ties to the lowest seed. */
const SEED_BUDGET = 150;
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

/** What an abandon replays to: a closed match with nothing decided and the fixture flagged (football, the period kernel) -
 *  or, for carrom and generic, just closed with nothing decided. */
function replaysOnAbandon(r: Recorded, raw: unknown, flagged: boolean): string | null {
  const replayed = replay(r, raw);
  if (typeof replayed === "string") return `the counterfactual config does not fold the ledger: ${replayed}`;
  if (replayed.state.phase !== "abandoned") return `under the replay default the ledger is "${String(replayed.state.phase)}", not an abandoned match, so the abandon never ran`;
  if (held(replayed.state) !== null) return "under the replay default the abandon still decides a result";
  if (flagged && replayed.state.replayFlagged !== true) return "under the replay default the fixture is not flagged for a replay";
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
  return replaysOnAbandon(r, without(r.raw, "abandonPolicy"), false);
}

/** `abandonPolicy: "award"` with an EXPUNGE, ending on `kind`: the module holds the result the award gives (a leader's win
 *  by abandonment, or a draw), the kernel's fold reports the withdrawal's expunge (which `outcomeOf` reads as no outcome at
 *  all), and the replay default would have held nothing. */
function reachesAwardExpunge(kind: "win" | "draw"): (r: Recorded) => string | null {
  return (r) => {
    if (obj(r.raw).abandonPolicy !== "award") return "its config does not award an abandoned match";
    const played = replay(r, r.raw);
    if (typeof played === "string") return played;
    if (!played.expunged) return "the fold reports no expunge: the active abandon does not carry expunge: true";
    const result = held(played.state);
    if (result?.kind !== kind || (kind === "win" && result.method !== "abandoned")) return `the module does not hold ${kind === "win" ? "the leader's win by abandonment" : "a draw"} under the expunge`;
    return replaysOnAbandon(r, without(r.raw, "abandonPolicy"), true);
  };
}

/** hockey `abandonPolicy: "q4_stands"`: an abandon DURING the last regulation period, and the score stands. The
 *  differential: the replay default holds nothing for the same ledger. */
function reachesQ4Stands(r: Recorded): string | null {
  if (obj(r.raw).abandonPolicy !== "q4_stands") return "its config does not apply the 4th-quarter rule";
  const last = lastEvent(r);
  if (last?.type !== "core.abandon") return "the ledger does not end on an abandon";
  const played = replay(r, r.raw);
  if (typeof played === "string") return played;
  if (held(played.state) === null) return "the abandon holds no result: the score did not stand";
  const before = replay({ ...r, events: r.events.slice(0, -1) }, r.raw);
  if (typeof before === "string") return before;
  const final = periodLabels(before.cfg as never).at(-1);
  if (before.state.phase !== final) return `the abandon came in "${String(before.state.phase)}", not in the last regulation period "${String(final)}"`;
  return replaysOnAbandon(r, without(r.raw, "abandonPolicy"), true);
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
function shortest(c: BuildCtx, reached: (r: Recorded) => string | null, ledgerOf: (seed: number) => GoldenEvent[] | null): GoldenEvent[] | null {
  let best: GoldenEvent[] | null = null;
  for (let seed = 1; seed <= SEED_BUDGET; seed++) {
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
    const stream: GoldenStream = { config: name, seed: story.seed, events, ...recomputeStream(module, raw, events) };
    const verdict = story.reached(recordedOf(module, corpus, stream));
    if (verdict !== null) throw new Error(`golden branches: the ledger built for ${story.id} does not reach its branch: ${verdict}`);
    corpus.streams.push(slimStream(module, corpus, stream));
    appended.push(`${story.id} ${name}:${story.seed}`);
  }
  return { corpus, appended, stillMissing };
}
