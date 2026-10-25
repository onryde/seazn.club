// Golden branches (W2c Task 16c) - the opt-in config keys the epoch guard could not see, now exercised by a recorded stream.
//
// Three questions, in this order: does the committed corpus REACH every branch (and how many streams and sports did that
// read - zero is a failure); does each verdict have TEETH (the stream passes, and the same stream with the key removed, the
// deciding event dropped, or the branch's other half substituted does not); and does the append path reproduce the
// committed streams byte for byte from a corpus that lacks them, do nothing a second time, and refuse by name.
//
// The expected facts are the rulebook's and the engine's own declarations (the default of five kicks, the 4th quarter, a
// level abandon is a draw, an expunge is no outcome), read by folding the committed ledger HERE - not by calling the
// verdict under test.
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { foldMatchWithStoppage, outcomeOf } from "../core/events.ts";
import { resolvePositions } from "../sport/catalog.ts";
import type { AnySportModule } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";
import { SHOOTOUT_ATTEMPTS_DEFAULT } from "../sports/football/football.ts";
import { BRANCH_SEED_BASE, BRANCH_STORIES, branchHoles, extendBranches, replaysOnAbandon, type BranchStory, type Recorded } from "./golden-branches.ts";
import { FLOOR_SEED_STRIDE } from "./golden-floor-streams.ts";
import { forEachSport } from "./for-each-sport.ts";
import { readCorpus, type GoldenCorpus, type GoldenEvent, type GoldenStream } from "./golden.ts";
import { buildWalk, defaultLineupPair, makeEnvelope } from "./helpers.ts";

const moduleOf = (key: string): AnySportModule => {
  const found = builtinModules.find((m) => m.key === key);
  if (found === undefined) throw new Error(`no builtin module "${key}"`);
  return found;
};
const identity = (s: { config: string; seed: number }): string => `${s.config}#${s.seed}`;
const storyIdentity = (story: BranchStory): string => identity({ config: story.config.name, seed: story.seed });
const without = (raw: unknown, key: string): Record<string, unknown> => Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([k]) => k !== key));
const note = { type: "core.note", payload: { text: "a control" } } satisfies GoldenEvent;

/** An independent strict fold: the kernel's own, with the state as a plain record (this file's reads, not the verdict's). */
function fold(module: AnySportModule, raw: unknown, events: readonly GoldenEvent[]) {
  const cfg = module.configSchema.parse(raw) as unknown;
  const lineups = defaultLineupPair(resolvePositions(module, cfg));
  const folded = foldMatchWithStoppage(module as never, cfg as never, lineups, events.map((e, i) => makeEnvelope(i, e, e.voids)), { strictFromSeq: 0 });
  return { folded, cfg: cfg as Record<string, unknown>, state: folded.state as Record<string, unknown> };
}

interface Case {
  readonly story: BranchStory;
  readonly module: AnySportModule;
  readonly corpus: GoldenCorpus;
  readonly stream: GoldenStream;
  readonly raw: Record<string, unknown>;
  readonly recorded: Recorded;
}

/** The committed stream a story recorded, found by identity. Resolved inside each test, never at collection: a corpus that
 *  lacks one fails the tests that need it BY NAME instead of failing the whole file to collect. */
function caseOf(story: BranchStory): Case {
  const module = moduleOf(story.sport);
  const corpus = readCorpus(story.sport);
  const stream = corpus.streams.find((s) => identity(s) === storyIdentity(story));
  if (stream === undefined) throw new Error(`${story.id}: the committed ${story.sport} corpus holds no stream ${storyIdentity(story)}; run EXTEND_GOLDEN=1 npx vitest run src/testkit/golden.test.ts`);
  const raw = corpus.configs[stream.config] as Record<string, unknown>;
  return { story, module, corpus, stream, raw, recorded: { module, raw, lineups: stream.lineups, events: stream.events } };
}
const allCases = (): Case[] => BRANCH_STORIES.map(caseOf);
const storyById = (id: string): BranchStory => {
  const story = BRANCH_STORIES.find((s) => s.id === id);
  if (story === undefined) throw new Error(`no branch story "${id}"`);
  return story;
};
const byId = (id: string): Case => caseOf(storyById(id));

describe("the branch table", () => {
  it("names exactly the four opt-in branches W2c raised a major for by hand, then the six arms 16c recorded beside them (the award abandon's expunge and level arms, and the shoot-out's sudden death), once each, in this order", () => {
    expect(BRANCH_STORIES.map((s) => s.id)).toEqual([
      "football.shootoutAttempts",
      "hockey.q4_stands",
      "carrom.share",
      "generic.share",
      "football.award_expunge",
      "hockey.award_expunge",
      "icehockey.award_expunge",
      "icehockey.award_level_flagged",
      "football.award_draw",
      "football.shootout_sudden_death",
    ]);
  });

  it("gives every story a registry sport, a config its module accepts that carries the key, and an identity of its own clear of the floor and the generator", () => {
    const seen = new Set<string>();
    const sports = new Set<string>();
    for (const story of BRANCH_STORIES) {
      const module = moduleOf(story.sport);
      expect(() => module.configSchema.parse(story.config.raw), `${story.id}: the sport refuses its own config`).not.toThrow();
      expect(Object.keys(story.config.raw), story.id).toContain(story.key);
      expect(story.seed, story.id).toBeGreaterThanOrEqual(BRANCH_SEED_BASE);
      expect(story.seed, story.id).toBeLessThan(FLOOR_SEED_STRIDE);
      expect(seen.has(storyIdentity(story)), `${story.id}: ${storyIdentity(story)} is taken`).toBe(false);
      seen.add(storyIdentity(story));
      sports.add(story.sport);
    }
    expect(seen.size).toBe(BRANCH_STORIES.length);
    expect(sports.size, "the five sports W2c raised").toBe(5);
    // BRANCH_SEED_BASE sits above every seed a generator walk can take (the coverage scan stops at 3000) - read from the corpora.
    let walks = 0;
    forEachSport(({ key }) => {
      for (const s of readCorpus(key).streams) {
        if (s.seed < FLOOR_SEED_STRIDE && !seen.has(identity(s))) {
          expect(s.seed, `${key} ${identity(s)}`).toBeLessThan(BRANCH_SEED_BASE);
          walks++;
        }
      }
    });
    expect(walks).toBeGreaterThan(100);
  });
});

describe("the committed corpora reach every branch", () => {
  it("leaves no sport with a hole, reporting how many stories, streams and sports it read", () => {
    let sports = 0;
    let stories = 0;
    let examined = 0;
    forEachSport(({ module, key }) => {
      const corpus = readCorpus(key);
      expect(branchHoles(module, corpus), `${key} branch holes`).toEqual([]);
      stories += BRANCH_STORIES.filter((s) => s.sport === key).length;
      examined += corpus.streams.length;
      sports++;
    });
    expect(sports).toBe(builtinModules.length);
    expect(stories, "every story was checked against its own sport").toBe(BRANCH_STORIES.length);
    expect(examined).toBeGreaterThan(300);
  }, 30_000);

  it("reaches each branch with the stream recorded for it, appended after everything else", () => {
    const cases = allCases();
    for (const c of cases) {
      expect(c.story.reached(c.recorded), `${c.story.id} ${storyIdentity(c.story)}`).toBeNull();
    }
    expect(cases.length).toBe(BRANCH_STORIES.length);
    forEachSport(({ key }) => {
      const streams = readCorpus(key).streams;
      const mine = new Set(cases.filter((c) => c.story.sport === key).map((c) => storyIdentity(c.story)));
      const first = streams.findIndex((s) => mine.has(identity(s)));
      if (mine.size === 0) {
        expect(first, key).toBe(-1);
        return;
      }
      // append only: every stream after the first branch stream is a branch stream - or a fold-option stream, the fifth append path (GF-3 T2),
      // which runs after this one and is pinned in golden-fold-options.test.ts
      expect(streams.slice(first).filter((s) => s.foldOptions === undefined).map(identity), key).toEqual(streams.filter((s) => mine.has(identity(s))).map(identity));
    });
  });

  it("is not satisfied by a stream that only NAMES the key: the verdict rejects streams other than its own, among them the ones that carry the key", () => {
    let rejected = 0;
    let namers = 0;
    let rejectedNamers = 0;
    for (const c of allCases()) {
      const others = c.corpus.streams.filter((s) => identity(s) !== storyIdentity(c.story));
      expect(others.length, c.story.id).toBeGreaterThan(0);
      for (const s of others) {
        const raw = c.corpus.configs[s.config] as Record<string, unknown>;
        const refusal = c.story.reached({ module: c.module, raw, lineups: s.lineups, events: s.events });
        if (refusal !== null) rejected++;
        if (c.story.key in raw) {
          namers++;
          if (refusal !== null) rejectedNamers++;
        }
      }
      expect(rejected, c.story.id).toBeGreaterThan(0);
    }
    expect(rejected).toBeGreaterThan(BRANCH_STORIES.length * 10);
    expect(namers, "streams whose config carries the key exist (forfeits recorded under it)").toBeGreaterThan(0);
    expect(rejectedNamers, "and the verdict rejects them").toBeGreaterThan(0);
  }, 30_000);

  // The streams that look like they exercise a key and do not - the evidence behind adding a stream instead of skipping the
  // item. Read from the story and the corpus alone, so they hold (and say so) before the branch streams are appended.
  it.each([
    ["carrom.share", "sharedAbandon#200125", /abandon never ran/],
    ["carrom.share", "sharedAbandon#1", /does not end in a draw/],
    ["generic.share", "sharedAbandon#1", /does not end in a draw/],
    ["football.shootoutAttempts", "youthKnockout#1", /does not end in a shoot-out win/],
  ] as const)("%s is not already reached by %s, a stream recorded under the key's own config", (id, streamId, why) => {
    const story = storyById(id);
    const module = moduleOf(story.sport);
    const corpus = readCorpus(story.sport);
    const stream = corpus.streams.find((s) => identity(s) === streamId);
    expect(stream, `${story.sport} holds ${streamId}`).toBeDefined();
    expect(streamId.split("#")[0], "recorded under the config that carries the key").toBe(story.config.name);
    const raw = corpus.configs[stream!.config] as Record<string, unknown>;
    expect(story.key in raw).toBe(true);
    expect(story.reached({ module, raw, lineups: stream!.lineups, events: stream!.events })).toMatch(why);
  });

  it("carrom's sharedAbandon#200125 is a drawn walk with no abandon in its ledger, so its draw is not the share", () => {
    const floorDraw = readCorpus("carrom").streams.find((s) => identity(s) === "sharedAbandon#200125")!;
    expect(floorDraw.events.map((e) => e.type)).not.toContain("core.abandon");
    expect(JSON.parse(floorDraw.outcome)).toEqual({ kind: "draw" });
  });
});

describe("each branch stream takes the branch it is named for (the engine's own observable)", () => {
  it("football.shootoutAttempts: decided inside the configured kicks, which the default of five would not have decided", () => {
    const c = byId("football.shootoutAttempts");
    const attempts = c.raw.shootoutAttempts as number;
    expect(attempts, "a non-default count").not.toBe(SHOOTOUT_ATTEMPTS_DEFAULT);
    expect(attempts).toBeLessThan(SHOOTOUT_ATTEMPTS_DEFAULT);
    const played = fold(c.module, c.raw, c.stream.events).state;
    expect(played.outcome).toMatchObject({ kind: "win", method: "shootout" });
    const kicks = (played.shootout as { kicks: { side: string }[] }).kicks;
    const taken = (side: string) => kicks.filter((k) => k.side === side).length;
    expect(Math.max(taken("home"), taken("away")), "no sudden death: each side kicked at most the configured count").toBeLessThanOrEqual(attempts);
    expect(taken("home") + taken("away"), "kicks were played").toBeGreaterThan(0);
    const byDefault = fold(c.module, without(c.raw, "shootoutAttempts"), c.stream.events).state;
    expect(byDefault.phase, "under the default the same kicks leave the shoot-out running").toBe("SHOOTOUT");
    expect(byDefault.outcome).toBeNull();
  });

  it("hockey.q4_stands: abandoned in the 4th quarter, the leader's win by abandonment stands; before the 4th quarter the same policy replays", () => {
    const c = byId("hockey.q4_stands");
    const events = c.stream.events;
    const last = events[events.length - 1]!;
    expect(last.type).toBe("core.abandon");
    const before = fold(c.module, c.raw, events.slice(0, -1));
    expect((before.cfg.periods as { count: number }).count, "FIH hockey plays four quarters").toBe(4);
    expect(before.state.phase).toBe("Q4");
    const g = before.state.goals as { home: number; away: number };
    expect(g.home, "a leader, so the score standing is a win").not.toBe(g.away);
    const entrants = before.state.entrants as { home: string; away: string };
    const [winner, loser] = g.home > g.away ? [entrants.home, entrants.away] : [entrants.away, entrants.home];
    const after = fold(c.module, c.raw, events).state;
    expect(after.outcome).toEqual({ kind: "win", winner, loser, method: "abandoned" });
    // the differential: the replay default holds nothing for this ledger ...
    const replayed = fold(c.module, { ...c.raw, abandonPolicy: "replay" }, events).state;
    expect(replayed.phase).toBe("abandoned");
    expect(replayed.outcome).toBeNull();
    // ... and the rule's other half, an abandon before the 4th quarter, replays under q4_stands itself
    const early = fold(c.module, c.raw, [events[0]!, last]).state;
    expect(early.phase).toBe("abandoned");
    expect(early.outcome).toBeNull();
  });

  it.each(["carrom.share", "generic.share"])("%s: the abandoned match is a draw that keeps the play as it stood; without the policy it is only closed", (id) => {
    const c = byId(id);
    const events = c.stream.events;
    expect(events[events.length - 1]!.type).toBe("core.abandon");
    const before = fold(c.module, c.raw, events.slice(0, -1)).state;
    const after = fold(c.module, c.raw, events).state;
    expect(after.outcome).toEqual({ kind: "draw" });
    expect(after.phase).toBe("done");
    if (id === "generic.share") {
      // GN-AB-2: the running tally as it stood is the score, and it is not level (the draw is the policy's, not the tally's)
      const running = before.running as { home: number; away: number };
      expect(running.home).not.toBe(running.away);
      expect(after.score).toEqual(running);
    } else {
      // CA-AB-2: the games and boards played stay on the state; only the phase and the outcome move
      expect({ ...after, phase: before.phase, outcome: before.outcome }).toEqual(before);
    }
    const closed = fold(c.module, without(c.raw, "abandonPolicy"), events).state;
    expect(closed.phase).toBe("abandoned");
    expect(closed.outcome).toBeNull();
  });

  it.each([
    ["football.award_expunge", "win"],
    ["hockey.award_expunge", "draw"],
    ["icehockey.award_expunge", "draw"],
  ] as const)("%s: the module holds the award's %s and the kernel reads the expunge as no outcome; a void of the abandon reopens the match", (id, arm) => {
    const c = byId(id);
    const events = c.stream.events;
    const last = events[events.length - 1]!;
    expect(last).toEqual({ type: "core.abandon", payload: { reason: "withdrew", expunge: true } });
    const before = fold(c.module, c.raw, events.slice(0, -1));
    const g = before.state.goals as { home: number; away: number };
    const entrants = before.state.entrants as { home: string; away: string };
    const held = fold(c.module, c.raw, events);
    if (arm === "draw") {
      expect(g.home, "a level score").toBe(g.away);
      expect(g.home, "with goals on the board").toBeGreaterThan(0);
      expect(held.state.outcome).toEqual({ kind: "draw" });
    } else {
      expect(g.home).not.toBe(g.away);
      const [winner, loser] = g.home > g.away ? [entrants.home, entrants.away] : [entrants.away, entrants.home];
      expect(held.state.outcome).toEqual({ kind: "win", winner, loser, method: "abandoned" });
    }
    // the expunge is what makes it no outcome: the kernel's fold flags it and outcomeOf answers null ...
    expect(held.folded.expunged).toBe(true);
    expect(outcomeOf(c.module as never, held.folded as never)).toBeNull();
    // ... and the same abandon without the flag is the result the module holds
    const kept = fold(c.module, c.raw, [...events.slice(0, -1), { type: "core.abandon", payload: { reason: "withdrew" } }]);
    expect(kept.folded.expunged).toBe(false);
    expect(outcomeOf(c.module as never, kept.folded as never)).toEqual(held.state.outcome);
    // the policy is the award: the replay default holds nothing and flags a replay
    const replayed = fold(c.module, { ...c.raw, abandonPolicy: "replay" }, events).state;
    expect(replayed.outcome).toBeNull();
    expect(replayed.replayFlagged).toBe(true);
    // after a void: striking the abandon takes the expunge and the award with it
    const voided = fold(c.module, c.raw, [...events, { type: "core.void", payload: {}, voids: `e-${events.length - 1}` }]);
    expect(voided.folded.expunged).toBe(false);
    expect(voided.state).toEqual(before.state);
    expect(outcomeOf(c.module as never, voided.folded as never)).toBeNull();
  });

  it("icehockey.award_level_flagged: under the IIHF default a level abandon is flagged for a replay and decides nothing; where a draw can stand the same ledger is a draw", () => {
    const c = byId("icehockey.award_level_flagged");
    const events = c.stream.events;
    expect(events[events.length - 1]).toEqual({ type: "core.abandon", payload: { reason: "conditions" } });
    const before = fold(c.module, c.raw, events.slice(0, -1));
    expect(before.cfg.overtime, "the default plays an overtime").not.toBeNull();
    expect(before.cfg.shootout, "and a shoot-out, so no draw can stand").not.toBeNull();
    const goals = before.state.goals as { home: number; away: number };
    expect(goals.home, "a level score").toBe(goals.away);
    expect(goals.home, "with goals on the board").toBeGreaterThan(0);
    const held = fold(c.module, c.raw, events);
    expect(held.state.phase).toBe("abandoned");
    expect(held.state.outcome).toBeNull();
    expect(held.state.replayFlagged).toBe(true);
    expect(outcomeOf(c.module as never, held.folded as never)).toBeNull();
    // the cfg is the reason: with neither overtime nor shoot-out (the 90007 story's config) the same abandon is a draw
    const standing = fold(c.module, { ...c.raw, overtime: null, shootout: null }, events);
    expect(standing.state.outcome).toEqual({ kind: "draw" });
    expect(standing.state.replayFlagged).not.toBe(true);
  });

  it("football.award_draw: an abandon at a level score is a draw on the real score, with no expunge in play", () => {
    const c = byId("football.award_draw");
    const events = c.stream.events;
    const last = events[events.length - 1]!;
    expect(last).toEqual({ type: "core.abandon", payload: { reason: "conditions" } });
    const before = fold(c.module, c.raw, events.slice(0, -1));
    const goals = before.state.goals as { home: number; away: number };
    expect(goals.home, "a level score").toBe(goals.away);
    expect(goals.home, "with goals on the board").toBeGreaterThan(0);
    const held = fold(c.module, c.raw, events);
    expect(held.state.outcome).toEqual({ kind: "draw" });
    expect(held.state.phase).toBe("done");
    expect(held.folded.expunged, "no withdrawal: the draw is the module's and the kernel's").toBe(false);
    expect(outcomeOf(c.module as never, held.folded as never)).toEqual({ kind: "draw" });
    // the replay default would have held nothing and flagged the fixture
    const replayed = fold(c.module, { ...c.raw, abandonPolicy: "replay" }, events).state;
    expect(replayed.outcome).toBeNull();
    expect(replayed.replayFlagged).toBe(true);
  });

  it("football.shootout_sudden_death: level after the configured kicks, decided in sudden death, and still running under the default of five", () => {
    const c = byId("football.shootout_sudden_death");
    const events = c.stream.events;
    const attempts = c.raw.shootoutAttempts as number;
    expect(attempts, "a non-default count").toBeLessThan(SHOOTOUT_ATTEMPTS_DEFAULT);
    const first = events.findIndex((e) => e.type === "football.shootout.kick");
    expect(first, "the ledger holds a shoot-out").toBeGreaterThan(0);
    expect(events.slice(first).every((e) => e.type === "football.shootout.kick"), "and ends in its kicks").toBe(true);
    const played = fold(c.module, c.raw, events).state;
    expect(played.outcome).toMatchObject({ kind: "win", method: "shootout" });
    const kicks = (played.shootout as { kicks: { side: string; scored: boolean }[] }).kicks;
    const taken = (side: string) => kicks.filter((k) => k.side === side).length;
    expect(Math.max(taken("home"), taken("away")), "a side kicked past the configured count: sudden death").toBeGreaterThan(attempts);
    // after the configured kicks each the shoot-out was level and still open - sudden death is what decided it
    const regulation = fold(c.module, c.raw, events.slice(0, first + 2 * attempts)).state;
    expect(regulation.phase).toBe("SHOOTOUT");
    expect(regulation.outcome).toBeNull();
    const level = (side: string) => (regulation.shootout as { kicks: { side: string; scored: boolean }[] }).kicks.filter((k) => k.side === side && k.scored).length;
    expect(level("home"), "level after the configured kicks").toBe(level("away"));
    // the default of five is still in regulation for the same kicks
    const byDefault = fold(c.module, without(c.raw, "shootoutAttempts"), events).state;
    expect(byDefault.phase).toBe("SHOOTOUT");
    expect(byDefault.outcome).toBeNull();
  });
});

// The five verdicts that carry no replay differential (the two award expunge arms, the 4th quarter, the flagged level award and the football level draw) rest on one premise of the
// engine's: an abandon is applied only to a match still in play, so a ledger that holds a result AND ends on an abandon has
// the abandon's own effect. The premise is pinned here, per story, against the engine's own refusal.
describe("an abandon after a match decided by play is refused by the engine, and so by every award and 4th-quarter verdict", () => {
  const STORIES = [
    "hockey.q4_stands",
    "football.award_expunge",
    "hockey.award_expunge",
    "icehockey.award_expunge",
    "icehockey.award_level_flagged",
    "football.award_draw",
  ] as const;
  /** A generator walk under the story's own config that ends decided by play: no abandon, no forfeit, an outcome in the state. */
  function decidedByPlay(c: Case): GoldenEvent[] {
    const cfg = c.module.configSchema.parse(c.raw) as unknown;
    const lineups = defaultLineupPair(resolvePositions(c.module, cfg));
    for (let seed = 1; seed <= 200; seed++) {
      let walk;
      try {
        walk = buildWalk(c.module, cfg as never, lineups, seed, 400);
      } catch {
        continue;
      }
      const events: GoldenEvent[] = walk.events.map((e) => ({ type: e.type, payload: e.payload }));
      if (events.some((e) => e.type === "core.abandon" || e.type === "core.forfeit")) continue;
      const last = walk.states[walk.states.length - 1] as Record<string, unknown> | undefined;
      if (last?.outcome !== null && last?.outcome !== undefined) return events;
    }
    throw new Error(`${c.story.id}: no generator walk under its config is decided by play within 200 seeds`);
  }

  it.each(STORIES)("%s: the fold refuses the story's own abandon on a match decided by play, and the verdict reports that reason", (id) => {
    const c = byId(id);
    const decided = decidedByPlay(c);
    const abandon = c.stream.events[c.stream.events.length - 1]!;
    expect(abandon.type, "the story ends on its abandon").toBe("core.abandon");
    expect(() => fold(c.module, c.raw, decided), "the walk alone folds").not.toThrow();
    let refusal: unknown;
    try {
      fold(c.module, c.raw, [...decided, abandon]);
    } catch (error) {
      refusal = error;
    }
    expect(refusal, "the engine refuses an abandon on a decided match").toBeInstanceOf(EngineError);
    expect((refusal as EngineError).code).toBe("ALREADY_DECIDED");
    expect((refusal as EngineError).message).toMatch(/match outcome already decided/);
    expect(c.story.reached({ ...c.recorded, events: [...decided, abandon] }), `${id}: the verdict hands back the engine's refusal`).toMatch(/match outcome already decided/);
  });
});

describe("each verdict has teeth: the stream passes, its counterfactuals do not", () => {
  // Each counterfactual names the GUARD that must reject it, by the reason it gives. Rejection alone is not enough: two
  // guards that cover for each other are each untested (delete one and the other still rejects), so a counterfactual is only
  // evidence for the guard whose reason it matches.
  type Counterfactual = [name: string, recorded: Recorded, reason: RegExp];
  /** The reason a story's verdict gives when its config no longer carries the key, and when the deciding event is gone. */
  const KEY_GONE: Record<string, RegExp> = {
    "football.shootoutAttempts": /sets no shootoutAttempts/,
    "hockey.q4_stands": /does not apply the 4th-quarter rule/,
    "carrom.share": /does not share the points/,
    "generic.share": /does not share the points/,
    "football.award_expunge": /does not award an abandoned match/,
    "hockey.award_expunge": /does not award an abandoned match/,
    "icehockey.award_expunge": /does not award an abandoned match/,
    "icehockey.award_level_flagged": /does not award an abandoned match/,
    "football.award_draw": /does not award an abandoned match/,
    "football.shootout_sudden_death": /sets no shootoutAttempts/,
  };
  const DECIDER_GONE: Record<string, RegExp> = {
    "football.shootoutAttempts": /does not end in a shoot-out win/,
    "hockey.q4_stands": /does not end on an abandon/,
    "carrom.share": /does not end in a draw/,
    "generic.share": /does not end in a draw/,
    "football.award_expunge": /reports no expunge/,
    "hockey.award_expunge": /reports no expunge/,
    "icehockey.award_expunge": /reports no expunge/,
    "icehockey.award_level_flagged": /does not end on an abandon/,
    "football.award_draw": /does not end on an abandon/,
    "football.shootout_sudden_death": /does not end in a shoot-out win/,
  };
  /** Counterfactuals every story has: the key gone, and the deciding event (the last one in every story) dropped. */
  const common = (c: Case): Counterfactual[] => [
    ["the key removed from the recorded config", { ...c.recorded, raw: without(c.raw, c.story.key) }, KEY_GONE[c.story.id]!],
    ["the deciding event dropped", { ...c.recorded, events: c.stream.events.slice(0, -1) }, DECIDER_GONE[c.story.id]!],
    ["no events at all", { ...c.recorded, events: [] }, DECIDER_GONE[c.story.id]!],
    ["the deciding event replaced by a note", { ...c.recorded, events: [...c.stream.events.slice(0, -1), note] }, DECIDER_GONE[c.story.id]!],
  ];
  /** A shoot-out of `pairs` kick pairs, every pair scored by both sides until the last, which only A scores: the ledger a
   *  shorter count AND the default decide at the same final kick. */
  const longTiedShootout = (events: readonly GoldenEvent[], pairs: number): GoldenEvent[] => {
    const kicks: GoldenEvent[] = [];
    for (let pair = 1; pair <= pairs; pair++) {
      for (const [by, scored] of [["A", true], ["H", pair < pairs]] as const) {
        kicks.push({ type: "football.shootout.kick", payload: { by, scored, at: { period: "SHOOTOUT", elapsed: 60 * (kicks.length + 1) } } });
      }
    }
    return [...events.filter((e) => e.type !== "football.shootout.kick"), ...kicks];
  };
  /** The branch's own other half, per story. */
  const specific = (c: Case): Counterfactual[] => {
    const events = c.stream.events;
    const last = events[events.length - 1]!;
    switch (c.story.id) {
      case "football.shootoutAttempts":
        return [
          ["the count at the default", { ...c.recorded, raw: { ...c.raw, shootoutAttempts: SHOOTOUT_ATTEMPTS_DEFAULT } }, /not shorter than the default/],
          ["a count above the default", { ...c.recorded, raw: { ...c.raw, shootoutAttempts: SHOOTOUT_ATTEMPTS_DEFAULT + 2 } }, /not shorter than the default/],
          // a win, under the key's own config, that no shoot-out decided: the method is what makes it the branch
          ["a regulation win (no shoot-out)", { ...c.recorded, events: [events[0]!, { type: "football.goal", payload: { by: "H", at: { period: "H1", elapsed: 30 } } }, events[1]!, events[3]!] }, /does not end in a shoot-out win/],
          // 3 < 5, a shoot-out win, and it folds - but a tied run to a sixth pair is decided by the default of five as well
          ["a long tied shoot-out the default count decides too", { ...c.recorded, events: longTiedShootout(events, 6) }, /decide the same ledger/],
        ];
      case "hockey.q4_stands":
        return [
          ["an abandon before the 4th quarter", { ...c.recorded, events: [events[0]!, last] }, /holds no result/],
          ["the replay policy", { ...c.recorded, raw: { ...c.raw, abandonPolicy: "replay" } }, /does not apply the 4th-quarter rule/],
          ["the award policy", { ...c.recorded, raw: { ...c.raw, abandonPolicy: "award" } }, /does not apply the 4th-quarter rule/],
        ];
      case "carrom.share":
      case "generic.share":
        return [["the replay policy", { ...c.recorded, raw: { ...c.raw, abandonPolicy: "replay" } }, /does not share the points/]];
      case "football.award_expunge":
        return [
          ["no expunge", { ...c.recorded, events: [...events.slice(0, -1), { type: "core.abandon", payload: { reason: "withdrew" } }] }, /reports no expunge/],
          ["a level score (the draw arm)", { ...c.recorded, events: [events[0]!, last] }, /does not hold the leader's win/],
          ["the replay policy", { ...c.recorded, raw: { ...c.raw, abandonPolicy: "replay" } }, /does not award an abandoned match/],
        ];
      case "hockey.award_expunge":
      case "icehockey.award_expunge":
        return [
          ["no expunge", { ...c.recorded, events: [...events.slice(0, -1), { type: "core.abandon", payload: { reason: "withdrew" } }] }, /reports no expunge/],
          // one goal fewer: a leader, so the award is a win and the draw story must not accept it
          ["a leader instead of a level score", { ...c.recorded, events: events.filter((_, i) => i !== 2) }, /does not hold a draw/],
          ["the replay policy", { ...c.recorded, raw: { ...c.raw, abandonPolicy: "replay" } }, /does not award an abandoned match/],
        ];
      case "icehockey.award_level_flagged":
        return [
          // one goal fewer: a leader, so the award is the leader's win and nothing is flagged
          ["a leader instead of a level score", { ...c.recorded, events: events.filter((_, i) => i !== 2) }, /not flagged for a replay/],
          // neither overtime nor shoot-out: a draw can stand, so the level abandon IS a draw (the 90007 arm)
          ["a cfg where a draw stands", { ...c.recorded, raw: { ...c.raw, overtime: null, shootout: null } }, /not flagged for a replay/],
          // the replay policy flags the same abandon: the award policy is what the story is about
          ["the replay policy", { ...c.recorded, raw: { ...c.raw, abandonPolicy: "replay" } }, /does not award an abandoned match/],
        ];
      case "football.award_draw":
        return [
          ["a leader instead of a level score", { ...c.recorded, events: events.filter((_, i) => i !== 2) }, /does not hold a draw/],
          ["the replay policy", { ...c.recorded, raw: { ...c.raw, abandonPolicy: "replay" } }, /does not award an abandoned match/],
          // a draw that no abandon made: level at full time, so the abandon is what the story needs
          ["a level full-time draw with no abandon", { ...c.recorded, events: [events[0]!, events[1]!, events[2]!, { type: "football.period", payload: { phase: "HT", at: { period: "H1", elapsed: 3000 } } }, { type: "football.period", payload: { phase: "FT", at: { period: "H2", elapsed: 6000 } } }] }, /does not end on an abandon/],
        ];
      case "football.shootout_sudden_death":
        return [
          ["the count at the default", { ...c.recorded, raw: { ...c.raw, shootoutAttempts: SHOOTOUT_ATTEMPTS_DEFAULT } }, /not shorter than the default/],
          // decided inside the configured kicks: the shoot-out story's ledger, not a sudden death
          ["a shoot-out decided inside the configured kicks", { ...c.recorded, events: byId("football.shootoutAttempts").stream.events }, /no side kicked past/],
          // a tied run to a sixth pair is sudden death under the default of five as well, so the key proves nothing
          ["a long tied shoot-out the default count decides too", { ...c.recorded, events: longTiedShootout(events, 6) }, /decide the same ledger/],
        ];
      default:
        throw new Error(`${c.story.id}: no counterfactuals declared for this story`);
    }
  };

  it("passes the committed stream and fails every counterfactual of it, by the guard it is aimed at", () => {
    let counterfactuals = 0;
    for (const c of allCases()) {
      expect(c.story.reached(c.recorded), `${c.story.id} passes`).toBeNull();
      const all = [...common(c), ...specific(c)];
      expect(all.length, c.story.id).toBeGreaterThanOrEqual(5);
      for (const [name, recorded, reason] of all) {
        const refusal = c.story.reached(recorded);
        expect(refusal, `${c.story.id} must reject: ${name}`).not.toBeNull();
        expect(refusal, `${c.story.id} rejects "${name}" for the wrong reason - the guard aimed at it is not the one that fired`).toMatch(reason);
        counterfactuals++;
      }
    }
    expect(counterfactuals).toBeGreaterThan(BRANCH_STORIES.length * 4);
  }, 30_000);

  it("reports a counterfactual config the module refuses, rather than throwing - and accepts the real one", () => {
    const c = byId("carrom.share");
    const refusal = replaysOnAbandon(c.recorded, { abandonPolicy: "not-a-policy" });
    expect(typeof refusal).toBe("string");
    expect(refusal).toMatch(/counterfactual config does not fold the ledger/);
    expect(replaysOnAbandon(c.recorded, without(c.raw, "abandonPolicy"))).toBeNull();
  });

  it("rejects a ledger the config would not fold with a reason, rather than throwing", () => {
    for (const c of allCases()) {
      const refused = c.story.reached({ ...c.recorded, events: [{ type: "core.forfeit", payload: { by: "nobody", reason: "walkover" } }, ...c.stream.events] });
      expect(typeof refused, c.story.id).toBe("string");
    }
  });
});

describe("extendBranches - the append path", () => {
  /** The corpus as it stood before the branch streams: no branch stream, none of the fold-option streams the fifth append path adds after them
   *  (GF-3 T2), and only the configs the rest still reference. */
  const before = (key: string): GoldenCorpus => {
    const corpus = readCorpus(key);
    const mine = new Set(BRANCH_STORIES.filter((s) => s.sport === key).map(storyIdentity));
    const streams = corpus.streams.filter((s) => !mine.has(identity(s)) && s.foldOptions === undefined);
    const used = new Set(streams.map((s) => s.config));
    return { ...corpus, configs: Object.fromEntries(Object.entries(corpus.configs).filter(([name]) => used.has(name))), streams };
  };

  it("empty case first: a corpus with no holes gets nothing appended, and a second call is the same", () => {
    let sports = 0;
    forEachSport(({ module, key }) => {
      const corpus = readCorpus(key);
      const first = extendBranches(module, corpus);
      expect(first.appended, key).toEqual([]);
      expect(first.stillMissing, key).toEqual([]);
      expect(JSON.stringify(first.corpus), key).toBe(JSON.stringify(corpus));
      expect(extendBranches(module, first.corpus).appended, key).toEqual([]);
      sports++;
    });
    expect(sports).toBe(builtinModules.length);
  }, 30_000);

  it("reproduces the committed branch streams, and the configs only they use, byte for byte from a corpus that lacks them", () => {
    let appended = 0;
    forEachSport(({ module, key }) => {
      const fullCommitted = readCorpus(key);
      // what the branch pass alone produced: the committed corpus without the fold-option streams appended after it
      const committed = { ...fullCommitted, streams: fullCommitted.streams.filter((s) => s.foldOptions === undefined) };
      const base = before(key);
      const expected = BRANCH_STORIES.filter((s) => s.sport === key);
      expect(branchHoles(module, base), `${key}: without its branch streams the sport has holes`).toEqual(expected.map((s) => s.id));
      const result = extendBranches(module, base);
      expect(result.stillMissing, key).toEqual([]);
      expect(result.appended.length, key).toBe(expected.length);
      expect(JSON.stringify(result.corpus), key).toBe(JSON.stringify(committed));
      expect(extendBranches(module, result.corpus).appended, `${key}: a second call`).toEqual([]);
      appended += result.appended.length;
    });
    expect(appended).toBe(BRANCH_STORIES.length);
  }, 30_000);

  it("skips a branch some recorded stream already reaches, whatever its config name or seed, and still appends the others", () => {
    const football = moduleOf("football");
    const shootout = byId("football.shootoutAttempts");
    const base = before("football");
    const donor: GoldenStream = { ...shootout.stream, config: "youthKnockout", seed: 4242 };
    const result = extendBranches(football, { ...base, streams: [...base.streams, donor] });
    // the donor reaches the shoot-out count and nothing else: the sudden death, the awards and the draw are still holes
    expect(result.appended.map((a) => a.split(" ")[0])).toEqual(["football.award_expunge", "football.award_draw", "football.shootout_sudden_death"]);
    expect(result.corpus.streams.filter((s) => s.config === "youthKnockout").map((s) => s.seed)).not.toContain(BRANCH_SEED_BASE + 1);
    // a sudden-death donor reaches BOTH shoot-out stories (the sudden death is a shoot-out win inside the key's count too)
    const sudden = byId("football.shootout_sudden_death");
    const both = extendBranches(football, { ...base, streams: [...base.streams, { ...sudden.stream, config: "youthKnockout", seed: 4243 }] });
    expect(both.appended.map((a) => a.split(" ")[0])).toEqual(["football.award_expunge", "football.award_draw"]);
  });

  it("refuses by name an identity another stream holds, and a config name held with a different raw", () => {
    const football = moduleOf("football");
    const base = before("football");
    const decoy: GoldenStream = { ...base.streams[0]!, config: "youthKnockout", seed: BRANCH_SEED_BASE + 1 };
    expect(() => extendBranches(football, { ...base, streams: [...base.streams, decoy] })).toThrow(/already has a stream youthKnockout#90001/);
    const moved = { ...base, configs: { ...base.configs, youthKnockout: { ...(base.configs.youthKnockout as object), shootoutAttempts: 4 } } };
    expect(() => extendBranches(football, moved)).toThrow(/already records a config "youthKnockout"/);
  });

  it("reports a hole its builder cannot close instead of inventing a stream, and refuses a built ledger that misses the branch", () => {
    const football = moduleOf("football");
    const base = before("football");
    const story = BRANCH_STORIES.find((s) => s.id === "football.award_expunge")!;
    const dry = extendBranches(football, base, [{ ...story, build: () => null }]);
    expect(dry.appended).toEqual([]);
    expect(dry.stillMissing).toEqual(["football.award_expunge"]);
    expect(dry.corpus.streams.length).toBe(base.streams.length);
    expect(() => extendBranches(football, base, [{ ...story, build: () => [{ type: "core.start", payload: {} }] }])).toThrow(/does not reach its branch/);
  });
});
