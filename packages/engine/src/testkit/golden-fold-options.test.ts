// GF-3 T2 - a corpus stream's `foldOptions`: the server-only fold input (`FoldOptions.forfeitAward`) the recorder offers the fold.
//
// WHY. The server folds with `{ strictFromSeq, forfeitAward }` (apps/web `append-event.ts`, `fold.ts`): the stage points rule's award for a
// forfeit with nothing played, which football, generic, hockey and ice hockey keep in module state (`state.forfeitAward`) and read for their
// forfeit credit and their headline. No stream offered one, so a change to how they credit it moved no golden. A stream now records the award
// it was folded with (`foldOptions: { forfeitAward: [winner, loser] }`, part of its INPUT, see fold-epoch-guard), the recorder offers it to
// EVERY prefix fold exactly as the write path does, and `golden-fold-options.ts` appends the streams that reach the award.
//
// This file: the recorder (below), the stories and the append path, the committed corpora, and the policy text.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { foldOptionsProblem as guardProblem } from "../../scripts/fold-epoch-guard.ts";
import { PointsRule, forfeitAwardOffer } from "../competition/points.ts";
import { foldMatchWithStoppage, playRecorded, unplayedForfeitEvent } from "../core/events.ts";
import type { AwardReason } from "../core/types.ts";
import { resolvePositions } from "../sport/catalog.ts";
import type { AnySportModule } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";
import { forEachSport } from "./for-each-sport.ts";
import {
  corpusFormat,
  corpusStateDiff,
  isSlimStream,
  foldOptionsProblem,
  formatCorpusStateDiff,
  readCorpus,
  recomputeKernel,
  recomputeStats,
  rebaselineCorpus,
  recomputeStream,
  slimCorpus,
  slimStream,
  strictFold,
  verifyStream,
  type CorpusFormat,
  type GoldenCorpus,
  type GoldenEvent,
  type GoldenFoldOptions,
  type GoldenStream,
  type StreamStateDiff,
} from "./golden.ts";
import { BRANCH_SEED_BASE } from "./golden-branches.ts";
import { asFormatOne, reformatCorpus } from "./golden-reformat.ts";
import { sweepBudget } from "./golden-budget.ts";
import {
  FOLD_OPTION_SEED_BASE,
  FOLD_OPTION_STORIES,
  FORFEIT_AWARD_CASES,
  extendFoldOptions,
  foldOptionConfigName,
  foldOptionHoles,
  reachesAward,
  type AwardBuilt,
  type AwardRecorded,
  type FoldOptionExtension,
  type ForfeitAwardCase,
  type FoldOptionStory,
} from "./golden-fold-options.ts";
import { FLOOR_SEED_STRIDE } from "./golden-floor-streams.ts";
import { kernelRecorder, moduleRecorder, overlayVerdicts, statsRecorder, type Recorder } from "./golden-floor.ts";
import { mutationContext } from "./golden-mutations.ts";
import { buildStream, defaultLineupPair, makeEnvelope } from "./helpers.ts";

const sport = (key: string): AnySportModule => {
  const found = builtinModules.find((m) => m.key === key);
  if (found === undefined) throw new Error(`no builtin module "${key}"`);
  return found;
};
const ev = (type: string, payload: unknown = {}): GoldenEvent => ({ type, payload });

/** The sports that read the award: the engine's own declaration (`awardScoreKeys`), never a list typed here. */
const readers = (): AnySportModule[] => builtinModules.filter((m) => m.awardScoreKeys !== undefined);

/** A real stage points rule whose forfeit row awards `awardScore`, and what it offers a fold of `module` (`forfeitAwardOffer`: undefined
 *  where the award never reaches the sport's table). */
const offerOf = (module: AnySportModule, awardScore: [number, number]): GoldenFoldOptions | undefined => {
  const rule = PointsRule.parse({ base: { win: 3, draw: 1, loss: 0 }, forfeit: { winnerPoints: 3, loserPoints: 0, awardScore } });
  const forfeitAward = forfeitAwardOffer(rule, module);
  return forfeitAward === undefined ? undefined : { forfeitAward };
};

/** A config of the committed corpus the sport records a ledger under (the corpus's own raw object, which the sport parses). */
const rawOf = (module: AnySportModule): unknown => {
  const configs = readCorpus(module.key).configs;
  return configs.default ?? configs.score ?? Object.values(configs)[0];
};

/** `[core.start, core.forfeit{withdrew}]`: a forfeit with nothing played after the Start, which every reading sport admits. */
const startThenWithdrew = (module: AnySportModule): GoldenEvent[] => {
  const lineups = defaultLineupPair(resolvePositions(module, module.configSchema.parse(rawOf(module))));
  return [ev("core.start"), ev("core.forfeit", { by: lineups.home.entrantId, reason: "withdrew" })];
};

const FORMATS: readonly CorpusFormat[] = [1, 2, 3];

describe("the recorder offers a stream's foldOptions to every prefix fold, as the write path does (GF-3 T2)", () => {
  it("the reading sports are the ones that declare awardScoreKeys, and a rule's award is offered to those and no others", () => {
    const reading = readers();
    expect(reading.length, "at least one sport reads the award").toBeGreaterThan(0);
    let silent = 0;
    forEachSport(({ module }) => {
      const offer = offerOf(module, [7, 2]);
      if (module.awardScoreKeys === undefined) {
        expect(offer, `${module.key}: the award never reaches this table, so no fold is offered one`).toBeUndefined();
        silent++;
      } else {
        expect(offer, `${module.key}`).toEqual({ forfeitAward: [7, 2] });
      }
    });
    expect(silent + reading.length).toBe(builtinModules.length);
    expect(silent, "sports that ignore the award exist").toBeGreaterThan(0);
  });

  it("with the award, every format records a different final state, summary and deltas than without it (counted over the reading sports)", () => {
    let checked = 0;
    for (const module of readers()) {
      const raw = rawOf(module);
      const events = startThenWithdrew(module);
      const foldOptions = offerOf(module, [7, 2])!;
      for (const format of FORMATS) {
        const without = recomputeStream(module, raw, events, undefined, format);
        const withAward = recomputeStream(module, raw, events, undefined, format, foldOptions);
        const where = `${module.key} format ${format}`;
        expect(withAward.states.length, where).toBe(events.length);
        expect(JSON.parse(withAward.states.at(-1)!).forfeitAward, `${where}: the module holds the offered award`).toEqual([7, 2]);
        expect(Object.hasOwn(JSON.parse(without.states.at(-1)!) as object, "forfeitAward"), `${where}: and holds none without it`).toBe(false);
        expect(withAward.summary, `${where}: the headline reads the award`).not.toBe(without.summary);
        expect(withAward.deltas, `${where}: so does the table's credit`).not.toBe(without.deltas);
        checked++;
      }
    }
    expect(checked, "every (reading sport, format) pair was folded").toBe(readers().length * FORMATS.length);
  });

  it("EVERY prefix is offered it (format 1, 2 and 3 alike): the step before the forfeit holds no award, the forfeit's own step does, and the summary digest of that step moves", () => {
    let prefixes = 0;
    for (const module of readers()) {
      const raw = rawOf(module);
      const events = startThenWithdrew(module);
      const foldOptions = offerOf(module, [7, 2])!;
      for (const format of FORMATS) {
        const withAward = recomputeStream(module, raw, events, undefined, format, foldOptions);
        const without = recomputeStream(module, raw, events, undefined, format);
        const where = `${module.key} format ${format}`;
        expect(Object.hasOwn(JSON.parse(withAward.states[0]!) as object, "forfeitAward"), `${where}: the Start is not a forfeit`).toBe(false);
        expect(withAward.states[0], `${where}: step 0 is the same with or without`).toBe(without.states[0]);
        expect(JSON.parse(withAward.states[1]!).forfeitAward, `${where}: step 1 (the forfeit) holds it, not only the final fold`).toEqual([7, 2]);
        if (format >= 2) {
          expect(withAward.summaries![0], `${where}: step 0 digest`).toBe(without.summaries![0]);
          expect(withAward.summaries![1], `${where}: the digest after the forfeit moves with the award`).not.toBe(without.summaries![1]);
        }
        prefixes += events.length;
      }
    }
    expect(prefixes).toBe(readers().length * FORMATS.length * 2);
  });

  it("recomputeKernel and recomputeStats take the options too (the probe calls them directly), and agree with recomputeStream's stored fields", () => {
    let checked = 0;
    for (const module of readers()) {
      const raw = rawOf(module);
      const events = startThenWithdrew(module);
      const foldOptions = offerOf(module, [7, 2])!;
      const kernel = recomputeKernel(module, raw, events, undefined, foldOptions);
      const stats = recomputeStats(module, raw, events, undefined, foldOptions);
      expect(JSON.parse(kernel.states.at(-1)!).forfeitAward, module.key).toEqual([7, 2]);
      expect(JSON.parse(stats.states.at(-1)!).forfeitAward, module.key).toEqual([7, 2]);
      expect(kernel.dense, `${module.key}: the probe's dense overlay is still handed out`).toBeDefined();
      expect(recomputeStream(module, raw, events, undefined, 2, foldOptions).summaries, module.key).toEqual(kernel.summaries);
      expect(recomputeStream(module, raw, events, undefined, 3, foldOptions).playerStats, module.key).toBe(stats.playerStats);
      checked++;
    }
    expect(checked).toBe(readers().length);
  });

  it("the floor's three recorders hand the options to the fold they wrap: each answers as the wrapped recompute does WITH them and not as it does without (counted)", () => {
    let checked = 0;
    for (const story of FOLD_OPTION_STORIES.filter((s) => s.case.lands)) {
      const { module, corpus, stream } = committedOf(story);
      const raw = corpus.configs[stream.config];
      const options = stream.foldOptions!;
      const wrapped: ReadonlyArray<readonly [string, Recorder, unknown, unknown]> = [
        ["kernelRecorder", kernelRecorder, recomputeKernel(module, raw, stream.events, stream.lineups, options), recomputeKernel(module, raw, stream.events, stream.lineups)],
        ["statsRecorder", statsRecorder, recomputeStats(module, raw, stream.events, stream.lineups, options), recomputeStats(module, raw, stream.events, stream.lineups)],
        ["moduleRecorder", moduleRecorder, recomputeStream(module, raw, stream.events, stream.lineups, 1, options), recomputeStream(module, raw, stream.events, stream.lineups, 1)],
      ];
      for (const [name, record, offered, plain] of wrapped) {
        expect(JSON.stringify(record(module, raw, stream.events, stream.lineups, options)), `${story.id} ${name} with the options`).toBe(JSON.stringify(offered));
        expect(JSON.stringify(record(module, raw, stream.events, stream.lineups)), `${story.id} ${name} without them`).toBe(JSON.stringify(plain));
        expect(JSON.stringify(offered), `${story.id} ${name}: the award moves the recording (the premise this test rests on)`).not.toBe(JSON.stringify(plain));
        checked++;
      }
    }
    expect(checked).toBe(3 * readers().length * FORFEIT_AWARD_CASES.filter((c) => c.lands).length);
  });

  it("the ablation probe records BOTH of its ledgers under the stream's own options, so an award stream is probed as the server folds it (counted)", () => {
    let calls = 0;
    let streams = 0;
    for (const module of readers()) {
      const corpus = readCorpus(module.key);
      const mine = corpus.streams.filter((s) => s.foldOptions !== undefined);
      expect(mine.length, `${module.key}: premise, the sport records award streams`).toBe(FORFEIT_AWARD_CASES.length);
      const offers = new Set(mine.map((s) => JSON.stringify(s.foldOptions)));
      const seen: Array<string | undefined> = [];
      const spy: Recorder = (m, raw, events, lineups, foldOptions) => {
        seen.push(JSON.stringify(foldOptions));
        return statsRecorder(m, raw, events, lineups, foldOptions);
      };
      overlayVerdicts(module, { ...corpus, streams: mine }, spy, [], "all");
      // every award stream holds a Start or a Forfeit, so each is ablated at least once and recorded twice (near, far)
      expect(seen.length, `${module.key}: the probe recorded each award stream's two ledgers`).toBeGreaterThanOrEqual(mine.length * 2);
      for (const offered of seen) expect(offers.has(offered as string), `${module.key}: a probe recording was folded under ${String(offered)}, not under a stream's options`).toBe(true);
      calls += seen.length;
      streams += mine.length;
    }
    expect(streams).toBe(FOLD_OPTION_STORIES.length);
    expect(calls).toBeGreaterThanOrEqual(streams * 2);
  });

  it("no foldOptions is today's recording, byte for byte: omitting the argument and passing undefined are the same (the empty case)", () => {
    let checked = 0;
    for (const module of readers()) {
      const events = startThenWithdrew(module);
      for (const format of FORMATS) {
        const omitted = recomputeStream(module, rawOf(module), events, undefined, format);
        expect(recomputeStream(module, rawOf(module), events, undefined, format, undefined), `${module.key} ${format}`).toEqual(omitted);
        checked++;
      }
    }
    expect(checked).toBe(readers().length * FORMATS.length);
    // the format is still required: no silent default (GF-2 T1), the new parameter is the optional one after it
    expect(recomputeStream.length, "five required parameters; foldOptions is the optional sixth").toBe(5);
  });

  it("a forfeit AFTER play is not offered the award (the kernel withholds it), so offering one changes nothing in a stream the award never reaches", () => {
    // the other direction of the pair above: the kernel decides per forfeit (`unplayedForfeitEvent`), the recorder offers it to every fold
    let checked = 0;
    for (const module of readers()) {
      const raw = rawOf(module);
      const cfg = module.configSchema.parse(raw);
      const lineups = defaultLineupPair(resolvePositions(module, cfg));
      const foldOptions = offerOf(module, [7, 2])!;
      // a Start, one sport event the module's own generator draws, then a retirement: play was recorded, so a retirement is not an unplayed forfeit
      const play = drawPlay(module, cfg, lineups);
      const events = [ev("core.start"), play, ev("core.forfeit", { by: lineups.home.entrantId, reason: "retired" })];
      const withAward = recomputeStream(module, raw, events, undefined, 3, foldOptions);
      const without = recomputeStream(module, raw, events, undefined, 3);
      expect(withAward, `${module.key}: the award is withheld from a forfeit after play, so the recording is the one without it`).toEqual(without);
      checked++;
    }
    expect(checked).toBe(readers().length);
  });
});

/** A Start and the first sport event the module's own generator draws after it: play has been recorded and the match is undecided. */
function drawPlay(module: AnySportModule, cfg: unknown, lineups: ReturnType<typeof defaultLineupPair>): GoldenEvent {
  for (let seed = 1; seed <= 40; seed++) {
    const walk = buildStream(module, cfg as never, lineups, seed, 40);
    const at = walk.findIndex((e) => !e.type.startsWith("core."));
    const first = walk[at];
    if (first !== undefined && walk.slice(0, at).every((e) => e.type === "core.start")) return { type: first.type, payload: first.payload };
  }
  throw new Error(`${module.key}: no generator walk opens with a Start and then a sport event`);
}

describe("foldOptions are checked where the recorder takes them: one rule, two implementations held to one set of inputs", () => {
  const INPUTS: readonly unknown[] = [
    { forfeitAward: [5, 1] },
    { forfeitAward: [0, 0] },
    { forfeitAward: [20, 0] },
    null,
    [],
    "forfeitAward",
    3,
    {},
    { forfeitAward: undefined },
    { forfeitAward: [5, 1], strictFromSeq: 0 },
    { strictFromSeq: 0 },
    { forfeitAward: "5-1" },
    { forfeitAward: { 0: 5, 1: 1, length: 2 } },
    { forfeitAward: [5] },
    { forfeitAward: [5, 1, 0] },
    { forfeitAward: [-1, 2] },
    { forfeitAward: [1.5, 2] },
    JSON.parse('{"forfeitAward":[1e999,0]}') as unknown,
    { forfeitAward: ["5", 1] },
    { forfeitAward: [null, 1] },
    { forfeitAward: [Number.NaN, 1] },
  ];
  it("the guard's foldOptionsProblem and the recorder's answer alike for every input (the same message, not only the same verdict)", () => {
    let refused = 0;
    let accepted = 0;
    for (const input of INPUTS) {
      expect(foldOptionsProblem(input), JSON.stringify(input)).toBe(guardProblem(input));
      if (guardProblem(input) === null) accepted++;
      else refused++;
    }
    expect(accepted, "valid inputs exist").toBeGreaterThanOrEqual(3);
    expect(refused, "invalid inputs exist").toBeGreaterThanOrEqual(15);
  });

  it("strictFold refuses a malformed foldOptions by name and otherwise writes the write path's shape: strictFromSeq 0 and the award, no other key", () => {
    expect(strictFold(undefined)).toEqual({ strictFromSeq: 0 });
    expect(Object.keys(strictFold(undefined))).toEqual(["strictFromSeq"]);
    expect(strictFold({ forfeitAward: [5, 1] })).toEqual({ strictFromSeq: 0, forfeitAward: [5, 1] });
    expect(Object.keys(strictFold({ forfeitAward: [5, 1] })).sort()).toEqual(["forfeitAward", "strictFromSeq"]);
    let thrown = 0;
    for (const input of INPUTS) {
      if (guardProblem(input) === null) continue;
      expect(() => strictFold(input as never), JSON.stringify(input)).toThrow(/malformed foldOptions/);
      thrown++;
    }
    expect(thrown).toBeGreaterThanOrEqual(15);
  });

  it("strictFold hands the fold a COPY of the award, so a fold cannot reach back into the corpus object", () => {
    const recorded = { forfeitAward: [5, 1] as [number, number] };
    const opts = strictFold(recorded);
    expect(opts.forfeitAward).toEqual([5, 1]);
    expect(opts.forfeitAward).not.toBe(recorded.forfeitAward);
  });
});

// ---------------------------------------------------------------------------------------------------------------------- the stories

const identity = (s: { config: string; seed: number }): string => `${s.config}#${s.seed}`;
const without = (corpus: GoldenCorpus, mine: ReadonlySet<string>): GoldenCorpus => {
  const streams = corpus.streams.filter((s) => !mine.has(identity(s)));
  const used = new Set(streams.map((s) => s.config));
  return { ...corpus, configs: Object.fromEntries(Object.entries(corpus.configs).filter(([name]) => used.has(name))), streams };
};
/** The config a sport's stories are recorded under (the rule `extendFoldOptions` states: `default`, else `score`, else the first). */
const storyConfig = (corpus: GoldenCorpus): string => foldOptionConfigName(sport("football"), corpus);

interface Committed {
  readonly story: FoldOptionStory;
  readonly module: AnySportModule;
  readonly corpus: GoldenCorpus;
  readonly stream: GoldenStream;
  readonly recorded: AwardRecorded;
}
/** The committed stream a story recorded, by identity. Resolved inside each test, never at collection: a corpus that lacks one fails
 *  the tests that need it BY NAME instead of failing the whole file to collect. */
function committedOf(story: FoldOptionStory): Committed {
  const module = sport(story.sport);
  const corpus = readCorpus(story.sport);
  const stream = corpus.streams.find((s) => s.seed === story.seed && s.foldOptions !== undefined);
  if (stream === undefined) throw new Error(`${story.id}: the committed ${story.sport} corpus holds no award stream with seed ${story.seed}; run EXTEND_GOLDEN=1 npx vitest run src/testkit/golden.test.ts`);
  return { story, module, corpus, stream, recorded: { module, raw: corpus.configs[stream.config], lineups: stream.lineups, events: stream.events, foldOptions: stream.foldOptions } };
}
const allCommitted = (): Committed[] => FOLD_OPTION_STORIES.map(committedOf);
const storyById = (id: string): FoldOptionStory => {
  const found = FOLD_OPTION_STORIES.find((s) => s.id === id);
  if (found === undefined) throw new Error(`no fold-option story "${id}"`);
  return found;
};

/** The folded final state of a recording, parsed. */
const finalState = (r: { states: string[] }): Record<string, unknown> => JSON.parse(r.states.at(-1)!) as Record<string, unknown>;

describe("the fold-option stories: one per (reading sport, forfeit case), derived from the engine's declarations", () => {
  it("there is one story per sport that declares awardScoreKeys and per case, in registry order then case order, each with an identity of its own", () => {
    const expected = readers().flatMap((m) => FORFEIT_AWARD_CASES.map((c) => `${m.key}.${c.id}`));
    expect(FOLD_OPTION_STORIES.map((s) => s.id)).toEqual(expected);
    expect(expected.length, "readers x cases").toBe(readers().length * FORFEIT_AWARD_CASES.length);
    expect(new Set(expected).size, "ids are unique").toBe(expected.length);
    for (const story of FOLD_OPTION_STORIES) {
      const index = FORFEIT_AWARD_CASES.findIndex((c) => c.id === story.case.id);
      expect(story.seed, story.id).toBe(FOLD_OPTION_SEED_BASE + 1 + index);
      expect(story.seed, `${story.id}: above every generator seed (the coverage scan stops at 3000)`).toBeGreaterThan(3_000);
      expect(story.seed, `${story.id}: below the branch streams`).toBeLessThan(BRANCH_SEED_BASE);
      expect(story.seed, `${story.id}: and clear of the floor's`).toBeLessThan(FLOOR_SEED_STRIDE);
    }
  });

  it("the cases cover both arms of the kernel's rule: an award that lands, and one the kernel withholds", () => {
    expect(FORFEIT_AWARD_CASES.filter((c) => c.lands).length).toBeGreaterThanOrEqual(2);
    expect(FORFEIT_AWARD_CASES.filter((c) => !c.lands).length).toBeGreaterThanOrEqual(1);
    // and between them they reach the three things the rule reads: a walkover, a non-walkover with nothing played, and play recorded
    expect(FORFEIT_AWARD_CASES.some((c) => c.reason === "walkover" && c.lands)).toBe(true);
    expect(FORFEIT_AWARD_CASES.some((c) => c.reason !== "walkover" && c.lands)).toBe(true);
    expect(FORFEIT_AWARD_CASES.some((c) => c.played && !c.lands)).toBe(true);
    // and the void x award corner: play was drawn and then struck, so it is not play any more and the award lands
    expect(FORFEIT_AWARD_CASES.some((c) => c.voidedPlay && c.lands && !c.played)).toBe(true);
    expect(FORFEIT_AWARD_CASES.filter((c) => c.voidedPlay && c.played), "a struck play is not recorded play: the two cannot both hold").toEqual([]);
  });

  it("a case's `lands` is the KERNEL's reading of its own ledger (unplayedForfeitEvent over playRecorded), for every committed story - not a value typed in the table", () => {
    let checked = 0;
    let landed = 0;
    for (const c of allCommitted()) {
      const events = c.stream.events;
      const forfeit = events.at(-1)!;
      expect(forfeit.type, c.story.id).toBe("core.forfeit");
      const prefix = events.slice(0, -1).map((e, i) => makeEnvelope(i, e, e.voids));
      const kernel = unplayedForfeitEvent(forfeit.payload, playRecorded(prefix, c.module));
      expect(kernel, `${c.story.id}: the kernel and the table agree on whether the award lands`).toBe(c.story.case.lands);
      expect(playRecorded(prefix, c.module), `${c.story.id}: and on whether play was recorded`).toBe(c.story.case.played);
      // a case that says a void struck its play: the ledger holds a void, and WITHOUT that void the same ledger has play recorded
      expect(events.some((e) => e.type === "core.void"), `${c.story.id}: a void in the ledger exactly when the case strikes its play`).toBe(c.story.case.voidedPlay);
      expect(playRecorded(prefix.filter((e) => e.type !== "core.void"), c.module), `${c.story.id}: the struck play WAS play before its void`).toBe(c.story.case.played || c.story.case.voidedPlay);
      if (kernel) landed++;
      checked++;
    }
    expect(checked).toBe(FOLD_OPTION_STORIES.length);
    expect(landed, "some stories land the award").toBeGreaterThan(0);
    expect(landed, "and some are withheld").toBeLessThan(checked);
  });
});

describe("the committed corpora reach every fold-option story, and the award is visible in what they record", () => {
  it("leaves no sport with a hole, reporting how many stories, streams and sports it read", () => {
    let sports = 0;
    let stories = 0;
    let examined = 0;
    forEachSport(({ module, key }) => {
      const corpus = readCorpus(key);
      expect(foldOptionHoles(module, corpus), `${key} fold-option holes`).toEqual([]);
      stories += FOLD_OPTION_STORIES.filter((s) => s.sport === key).length;
      examined += corpus.streams.length;
      sports++;
    });
    expect(sports).toBe(builtinModules.length);
    expect(stories, "every story was checked against its own sport").toBe(FOLD_OPTION_STORIES.length);
    expect(examined).toBeGreaterThan(300);
  }, sweepBudget("read"));

  it("every story is reached by the stream recorded for it, and ONLY the reading sports record any foldOptions", () => {
    const all = allCommitted();
    for (const c of all) expect(c.story.reached(c.recorded), `${c.story.id} ${identity(c.stream)}`).toBeNull();
    expect(all.length).toBe(FOLD_OPTION_STORIES.length);
    let withOptions = 0;
    forEachSport(({ module, key }) => {
      const carrying = readCorpus(key).streams.filter((s) => s.foldOptions !== undefined);
      if (module.awardScoreKeys === undefined) expect(carrying, `${key} reads no award, so no stream offers it one`).toEqual([]);
      else expect(carrying.length, `${key} records an award stream per case`).toBe(FORFEIT_AWARD_CASES.length);
      withOptions += carrying.length;
    });
    expect(withOptions).toBe(FOLD_OPTION_STORIES.length);
  }, sweepBudget("read"));

  it("each stream is in the corpus's format (3: summaries, overlay and playerStats beside the options), slim, and appended after everything else", () => {
    const all = allCommitted();
    for (const c of all) {
      expect(c.corpus.format, c.story.id).toBe(3);
      expect(c.stream.summaries?.length, `${c.story.id}: one digest per event`).toBe(c.stream.events.length);
      expect(typeof c.stream.overlay, c.story.id).toBe("string");
      expect(typeof c.stream.playerStats, c.story.id).toBe("string");
      expect(Object.keys(c.stream).slice(0, 4), `${c.story.id}: the input keys lead, the options beside the events`).toEqual(["config", "seed", "foldOptions", "events"]);
    }
    forEachSport(({ key }) => {
      const streams = readCorpus(key).streams;
      const mine = streams.filter((s) => s.foldOptions !== undefined);
      if (mine.length === 0) return;
      const first = streams.findIndex((s) => s.foldOptions !== undefined);
      expect(streams.slice(first).map(identity), `${key}: append only - every stream after the first award stream is an award stream`).toEqual(mine.map(identity));
    });
  }, sweepBudget("read"));

  it("a landed award is in the recorded final state, the headline and the table's credit; a withheld one changes none of them (the with/without differential, counted)", () => {
    let landed = 0;
    let withheld = 0;
    for (const c of allCommitted()) {
      const award = c.stream.foldOptions!.forfeitAward;
      const base = recomputeStream(c.module, c.recorded.raw, c.stream.events, c.stream.lineups, 3);
      const offered = recomputeStream(c.module, c.recorded.raw, c.stream.events, c.stream.lineups, 3, c.stream.foldOptions);
      // what is COMMITTED is what the recorder gives with the options, and differs from the recording without them exactly when the award lands
      expect(c.stream.states.at(-1), `${c.story.id}: committed final state is the offered fold (the last step is always stored whole)`).toBe(offered.states.at(-1));
      expect(c.stream.summary, `${c.story.id}: committed summary`).toBe(offered.summary);
      expect(c.stream.deltas, `${c.story.id}: committed deltas`).toBe(offered.deltas);
      expect(c.stream.summaries, `${c.story.id}: committed digests`).toEqual(offered.summaries);
      expect(c.stream.overlay, `${c.story.id}: committed overlay`).toBe(offered.overlay);
      if (c.story.case.lands) {
        expect(finalState(offered).forfeitAward, `${c.story.id}: the module holds the offered award`).toEqual([...award]);
        expect(offered.summary, `${c.story.id}: the headline reads it`).not.toBe(base.summary);
        expect(offered.deltas, `${c.story.id}: and so does the table's credit`).not.toBe(base.deltas);
        expect(offered.summaries!.at(-1), `${c.story.id}: the forfeit's own digest moves`).not.toBe(base.summaries!.at(-1));
        expect(c.stream.summary, `${c.story.id}: the committed headline is the awarded one, not the sport's own credit`).not.toBe(base.summary);
        landed++;
      } else {
        expect(Object.hasOwn(finalState(offered), "forfeitAward"), `${c.story.id}: the kernel withholds it from a forfeit after play`).toBe(false);
        expect(offered, `${c.story.id}: so the recording is the one without it, every stored field`).toEqual(base);
        withheld++;
      }
    }
    expect(landed).toBe(readers().length * FORFEIT_AWARD_CASES.filter((c) => c.lands).length);
    expect(withheld).toBe(readers().length * FORFEIT_AWARD_CASES.filter((c) => !c.lands).length);
    expect(landed + withheld).toBe(FOLD_OPTION_STORIES.length);
  }, sweepBudget("probe"));

  it("the award differs from the sport's own credit in BOTH numbers (derived from forfeitCredit and awardScoreKeys, not typed), so a dropped, swapped or ignored award shows", () => {
    let checked = 0;
    for (const c of allCommitted()) {
      const keys = c.module.awardScoreKeys!;
      const cfg = c.module.configSchema.parse(c.recorded.raw);
      const lineups = c.stream.lineups ?? defaultLineupPair(resolvePositions(c.module, cfg));
      const folded = foldMatchWithStoppage(c.module as never, cfg as never, lineups, c.stream.events.map((e, i) => makeEnvelope(i, e, e.voids)), { strictFromSeq: 0 });
      const forfeit = c.stream.events.at(-1)!.payload as { by: string; reason: AwardReason };
      const offender = forfeit.by === lineups.home.entrantId ? "home" : "away";
      const credit = c.module.forfeitCredit(cfg as never, folded.state, forfeit.reason, offender);
      const winner = credit.perSide[offender === "home" ? 1 : 0];
      const [w, l] = c.stream.foldOptions!.forfeitAward;
      expect(w, `${c.story.id}: winner's number vs the sport's own ${keys.for}`).not.toBe(winner[keys.for]);
      expect(l, `${c.story.id}: loser's number vs the sport's own ${keys.against}`).not.toBe(winner[keys.against]);
      expect(w, `${c.story.id}: winner first, so the pair is not symmetric`).not.toBe(l);
      checked++;
    }
    expect(checked).toBe(FOLD_OPTION_STORIES.length);
  });

  it("the offer is what forfeitAwardOffer gives a real PointsRule: a sport whose table the award never reaches records none", () => {
    let reached = 0;
    forEachSport(({ module, key }) => {
      const streams = readCorpus(key).streams.filter((s) => s.foldOptions !== undefined);
      const rule = PointsRule.parse({ base: { win: 3, draw: 1, loss: 0 }, forfeit: { winnerPoints: 3, loserPoints: 0, awardScore: [9, 4] } });
      const offer = forfeitAwardOffer(rule, module);
      if (offer === undefined) expect(streams, `${key}: no offer, no stream`).toEqual([]);
      else {
        expect(streams.length, key).toBeGreaterThan(0);
        reached++;
      }
    });
    expect(reached).toBe(readers().length);
  });
});

describe("the verdict `reached` rejects what is not its own: each guard has a counterfactual that only it rejects, and the reason is asserted", () => {
  const walkover = (sportKey: string) => committedOf(storyById(`${sportKey}.walkover`));
  /** The verdict's reason, or "accepted"; a verdict that THROWS reads as "threw ...", so an exception is an assertion failure and not a crash. */
  const refusal = (c: Committed, over: Partial<AwardRecorded>): string => {
    try {
      return c.story.reached({ ...c.recorded, ...over }) ?? "accepted";
    } catch (error) {
      return `threw ${String(error)}`;
    }
  };
  const verdictOf = (run: () => string | null): string => {
    try {
      return run() ?? "accepted";
    } catch (error) {
      return `threw ${String(error)}`;
    }
  };
  const sideTwo = (m: AnySportModule) => defaultLineupPair(resolvePositions(m, m.configSchema.parse(rawOf(m))));
  /** A builder's answer; a builder that THROWS is an assertion failure here, not a crash (null means "cannot build", which is a verdict). */
  const buildQuietly = (story: FoldOptionStory, ctx: Parameters<FoldOptionStory["build"]>[0]): AwardBuilt | null => {
    const held: { value: AwardBuilt | null } = { value: null };
    expect(() => {
      held.value = story.build(ctx);
    }, `${story.id} builds without throwing`).not.toThrow();
    return held.value;
  };

  it("a stream with no foldOptions is not a stream that offers the award, however its ledger ends", () => {
    let checked = 0;
    for (const m of readers()) {
      const c = walkover(m.key);
      expect(refusal(c, { foldOptions: undefined }), m.key).toMatch(/offers no award/);
      checked++;
    }
    expect(checked).toBe(readers().length);
  });
  it("a ledger that does not end in the case's forfeit is rejected (a Start alone, another reason, the other side forfeiting)", () => {
    let checked = 0;
    for (const m of readers()) {
      const c = walkover(m.key);
      const payload = c.stream.events.at(-1)!.payload as object;
      expect(refusal(c, { events: [{ type: "core.start", payload: {} }] }), `${m.key}: no forfeit`).toMatch(/does not end in a walkover forfeit by the away side/);
      const other = { type: "core.forfeit", payload: { ...payload, reason: "withdrew" } };
      expect(refusal(c, { events: [other] }), `${m.key}: another reason`).toMatch(/does not end in a walkover forfeit by the away side/);
      const wrongSide = { type: "core.forfeit", payload: { ...payload, by: sideTwo(m).home.entrantId } };
      expect(refusal(c, { events: [wrongSide] }), `${m.key}: the home side forfeiting a case the away side forfeits`).toMatch(/does not end in a walkover forfeit by the away side/);
      // the payload of the right forfeit under another event type is not a forfeit: only the type rejects it
      const wrongType = { type: "core.note", payload };
      expect(refusal(c, { events: [wrongType] }), `${m.key}: the forfeit's payload on an event that is not a forfeit`).toMatch(/does not end in a walkover forfeit by the away side/);
      expect(refusal(c, {}), `${m.key}: the control, the stream as recorded`).toBe("accepted");
      checked++;
    }
    expect(checked).toBe(readers().length);
  });
  it("the void x award corner is told apart from its neighbours: a play struck by a void is what the voided story needs and the unplayed one must not have", () => {
    let checked = 0;
    for (const m of readers()) {
      const voided = committedOf(storyById(`${m.key}.withdrew_after_voided_play`));
      const unplayed = committedOf(storyById(`${m.key}.withdrew_unplayed`));
      expect(refusal(voided, {}), `${m.key}: the control, the voided story's own stream`).toBe("accepted");
      expect(refusal(unplayed, {}), `${m.key}: the control, the unplayed story's own stream`).toBe("accepted");
      // the same withdrawal with no play ever drawn is not the voided story ...
      expect(refusal(voided, { events: unplayed.stream.events }), `${m.key}: no struck play`).toMatch(/holds no play struck by a void/);
      // ... and the voided ledger is not the unplayed story's, whatever else it shares with it
      expect(unplayed.story.reached({ ...unplayed.recorded, events: voided.stream.events }), `${m.key}: a struck play where the case has none`).toMatch(/holds a play struck by a void/);
      // a void that strikes the Start, names nothing, or names an event the ledger does not have is not a struck PLAY
      const [start, , , forfeit] = voided.stream.events;
      const strikes = (voids: string | undefined) => [start!, { type: "core.void", payload: {}, ...(voids === undefined ? {} : { voids }) }, forfeit!];
      expect(refusal(voided, { events: strikes("e-0") }), `${m.key}: a void of the Start`).toMatch(/holds no play struck by a void/);
      expect(refusal(voided, { events: strikes(undefined) }), `${m.key}: a void that names nothing`).toMatch(/holds no play struck by a void/);
      expect(refusal(voided, { events: strikes("e-9") }), `${m.key}: a void of an event the ledger does not hold`).toMatch(/holds no play struck by a void/);
      checked++;
    }
    expect(checked).toBe(readers().length);
  });
  it("a sport that declares no awardScoreKeys never reads an award, whatever the stream offers it", () => {
    const c = walkover("football");
    const cricket = sport("cricket");
    expect(cricket.awardScoreKeys, "premise: cricket reads no award").toBeUndefined();
    expect(refusal(c, { module: cricket }), "the stream offers an award, the sport cannot read it").toMatch(/cricket declares no awardScoreKeys, so it never reads an award/);
  });
  it("a module whose forfeit credit lacks the metric keys it declared is reported, not read as a zero", () => {
    let checked = 0;
    for (const m of readers()) {
      const c = walkover(m.key);
      const keyless = Object.assign(Object.create(m) as object, {
        forfeitCredit: (cfg: unknown, state: unknown, reason: unknown, by: unknown) => ({
          ...m.forfeitCredit(cfg as never, state as never, reason as never, by as never),
          perSide: [{}, {}] as const,
        }),
      }) as unknown as AnySportModule;
      expect(refusal(c, { module: keyless }), m.key).toMatch(/cannot be read/);
      checked++;
    }
    expect(checked).toBe(readers().length);
  });
  it("a retirement after play needs a sport event: a generator that never draws one leaves the story unbuildable (null), the unplayed cases still build", () => {
    const football = sport("football");
    const cfg = football.configSchema.parse(rawOf(football)) as unknown;
    const ctxFor = (module: AnySportModule) => ({ module, raw: rawOf(football), cfg, lineups: defaultLineupPair(resolvePositions(football, cfg)) });
    // the same football whose generator only ever draws a note: no walk opens with a Start and then a sport event
    const noPlay = Object.assign(Object.create(football) as object, { arbitraryEvent: () => ({ type: "core.note", payload: {} }) }) as unknown as AnySportModule;
    expect(buildQuietly(storyById("football.retired_after_play"), ctxFor(noPlay)), "no play to retire after").toBeNull();
    expect(buildQuietly(storyById("football.retired_after_play"), ctxFor(football)), "control: the real generator draws one").not.toBeNull();
    expect(buildQuietly(storyById("football.walkover"), ctxFor(noPlay)), "a walkover needs no play").not.toBeNull();
    expect(buildQuietly(storyById("football.withdrew_unplayed"), ctxFor(noPlay)), "nor does a withdrawal before it").not.toBeNull();
  });
  it("every story's builder yields a ledger its own verdict accepts, with an award that differs from the sport's own credit in both numbers (counted)", () => {
    let built = 0;
    for (const story of FOLD_OPTION_STORIES) {
      const module = sport(story.sport);
      const raw = readCorpus(story.sport).configs[foldOptionConfigName(module, readCorpus(story.sport))];
      const cfg = module.configSchema.parse(raw) as unknown;
      const lineups = defaultLineupPair(resolvePositions(module, cfg));
      const result = buildQuietly(story, { module, raw, cfg, lineups });
      expect(result, `${story.id}: the builder closes its own story`).not.toBeNull();
      const recorded: AwardRecorded = { module, raw, lineups: undefined, events: result!.events, foldOptions: result!.foldOptions };
      expect(story.reached(recorded), `${story.id}: the verdict accepts what the builder built`).toBeNull();
      // the sport's own credit for that ledger, folded here without the award (independent of the builder's own derivation)
      const keys = module.awardScoreKeys!;
      const folded = foldMatchWithStoppage(module as never, cfg as never, lineups, result!.events.map((e, i) => makeEnvelope(i, e, e.voids)), { strictFromSeq: 0 });
      const last = result!.events.at(-1)!.payload as { by: string; reason: AwardReason };
      const offender = last.by === lineups.home.entrantId ? "home" : "away";
      const own = module.forfeitCredit(cfg, folded.state, last.reason, offender).perSide[offender === "home" ? 1 : 0];
      const [winner, loser] = result!.foldOptions.forfeitAward;
      expect(winner, `${story.id}: the winner's number is not the sport's own credit`).not.toBe(own[keys.for]);
      expect(loser, `${story.id}: the loser's number is not the sport's own credit`).not.toBe(own[keys.against]);
      built++;
    }
    expect(built).toBe(FOLD_OPTION_STORIES.length);
  });
  it("a build for a sport that never reads the award is null: there is no stream to record", () => {
    const cricket = sport("cricket");
    const cfg = cricket.configSchema.parse(rawOf(cricket)) as unknown;
    const story = storyById("football.walkover");
    let built: unknown;
    expect(() => {
      built = story.build({ module: cricket, raw: rawOf(cricket), cfg, lineups: defaultLineupPair(resolvePositions(cricket, cfg)) });
    }).not.toThrow();
    expect(built).toBeNull();
  });
  it("an award equal to the sport's own credit is rejected: it would prove nothing about a dropped award", () => {
    let checked = 0;
    for (const m of readers()) {
      const c = walkover(m.key);
      const keys = m.awardScoreKeys!;
      // the sport's own credit for this ledger, read off the recording WITHOUT the award (the credit the table gets)
      const cfg = m.configSchema.parse(c.recorded.raw);
      const lineups = c.stream.lineups ?? defaultLineupPair(resolvePositions(m, cfg));
      const state = foldMatchWithStoppage(m as never, cfg as never, lineups, c.stream.events.map((e, i) => makeEnvelope(i, e)), { strictFromSeq: 0 }).state;
      const credit = m.forfeitCredit(cfg as never, state, "walkover", "away").perSide[0];
      const same: GoldenFoldOptions = { forfeitAward: [credit[keys.for]!, credit[keys.against]!] };
      expect(refusal(c, { foldOptions: same }), m.key).toMatch(/equals the sport's own credit/);
      // one number the same is rejected too: the other would still show, but the pair must differ in BOTH - each number by its own guard
      const winnerShared: GoldenFoldOptions = { forfeitAward: [credit[keys.for]!, credit[keys.against]! + 1] };
      expect(refusal(c, { foldOptions: winnerShared }), `${m.key}: the winner's number shared`).toMatch(/winner number \d+ equals the sport's own credit/);
      const loserShared: GoldenFoldOptions = { forfeitAward: [credit[keys.for]! + 1, credit[keys.against]!] };
      expect(refusal(c, { foldOptions: loserShared }), `${m.key}: the loser's number shared`).toMatch(/loser number \d+ equals the sport's own credit/);
      expect(refusal(c, { foldOptions: { forfeitAward: [credit[keys.for]! + 1, credit[keys.against]! + 1] } }), `${m.key}: the control, neither shared`).toBe("accepted");
      checked++;
    }
    expect(checked).toBe(readers().length);
  });
  it("a case that says the award lands is rejected for a ledger the kernel withholds it from, and one that says it is withheld for a ledger it lands in", () => {
    let checked = 0;
    for (const m of readers()) {
      const unplayed = committedOf(storyById(`${m.key}.withdrew_unplayed`));
      const retired = committedOf(storyById(`${m.key}.retired_after_play`));
      // the kernel lands the withdrawal's award, so a case that calls it withheld is wrong, and the recording differs with the offer
      const callsWithheld: ForfeitAwardCase = { ...unplayed.story.case, lands: false };
      expect(verdictOf(() => reachesAward(callsWithheld)(unplayed.recorded)), `${m.key}: withheld by the case, landed by the kernel`).toMatch(/changed the recording of a forfeit the case says the kernel withholds it from/);
      // the kernel withholds the retirement's award, so a case that calls it landing is wrong: the module state holds none
      const callsLanding: ForfeitAwardCase = { ...retired.story.case, lands: true };
      expect(verdictOf(() => reachesAward(callsLanding)(retired.recorded)), `${m.key}: landing by the case, withheld by the kernel`).toMatch(/holds null, not the offered award, so the award never reached it/);
      // and the true cases accept their own streams (the control: the verdicts above are about the case, not the stream)
      expect(verdictOf(() => reachesAward(unplayed.story.case)(unplayed.recorded)), m.key).toBe("accepted");
      expect(verdictOf(() => reachesAward(retired.story.case)(retired.recorded)), m.key).toBe("accepted");
      checked++;
    }
    expect(checked).toBe(readers().length);
  });

  /** `module` with one answer made blind to the award it was offered: the same module, its `method` reading the state without `forfeitAward`. */
  const blind = (module: AnySportModule, method: "summary" | "standingsDelta"): AnySportModule => {
    const strip = (state: unknown): unknown => Object.fromEntries(Object.entries(state as object).filter(([k]) => k !== "forfeitAward"));
    const wrapped: Record<string, unknown> =
      method === "summary"
        ? { summary: (state: unknown) => module.summary(strip(state)) }
        : { standingsDelta: (outcome: unknown, cfg: unknown, ctx: unknown, state: unknown) => module.standingsDelta(outcome as never, cfg, ctx as never, strip(state)) };
    return Object.assign(Object.create(module) as object, wrapped) as unknown as AnySportModule;
  };
  it("a module whose headline ignores the offered award, or whose table credit does, is rejected for that and only that (the module is the variable)", () => {
    let checked = 0;
    for (const m of readers()) {
      const c = walkover(m.key);
      expect(refusal(c, { module: blind(m, "summary") }), `${m.key}: headline blind`).toBe("the headline reads the same with and without the award");
      expect(refusal(c, { module: blind(m, "standingsDelta") }), `${m.key}: credit blind`).toBe("the table's credit is the same with and without the award");
      expect(refusal(c, {}), `${m.key}: the control, the module as it is`).toBe("accepted");
      checked++;
    }
    expect(checked).toBe(readers().length);
  });
  it("a module whose state never holds the offered award is rejected for the state, before the headline or the credit are asked", () => {
    let checked = 0;
    for (const m of readers()) {
      const c = walkover(m.key);
      const deaf = Object.assign(Object.create(m) as object, {
        apply: (state: unknown, event: unknown, ctx: unknown) =>
          m.apply(state as never, event as never, ctx === undefined ? undefined : ({ ...(ctx as object), forfeitAward: undefined } as never)),
      }) as unknown as AnySportModule;
      expect(refusal(c, { module: deaf }), m.key).toMatch(/the award never reached it/);
      checked++;
    }
    expect(checked).toBe(readers().length);
  });
  it("an award the recorder refuses, or a ledger the module cannot fold, is a reason and not a throw", () => {
    const c = walkover("football");
    // the forfeit twice: it ends in the right forfeit, but the second is refused by the fold (the match is decided), so the sport's own credit cannot be read
    const forfeit = c.stream.events.at(-1)!;
    expect(refusal(c, { events: [forfeit, forfeit] })).toMatch(/does not fold without the award/);
    // only the fold's own refusal (an EngineError) is a reason; any other throw in the module's credit is a defect the verdict must not turn into one
    const football = sport("football");
    const broken = Object.assign(Object.create(football) as object, { forfeitCredit: () => { throw new TypeError("credit exploded"); } }) as unknown as AnySportModule;
    expect(refusal(c, { module: broken }), "a TypeError from the module's own credit is not read as 'does not fold'").toMatch(/^threw TypeError: credit exploded/);
    // a malformed award: the recorder refuses it by name, and the verdict reports that
    expect(refusal(c, { foldOptions: { forfeitAward: [-1, 2] } as never })).toMatch(/does not record under its options: golden: malformed foldOptions/);
  });
});

describe("foldOptionConfigName - which recorded config the stories use", () => {
  const football = sport("football");
  const named = (...names: string[]): GoldenCorpus => ({ ...readCorpus("football"), configs: Object.fromEntries(names.map((n) => [n, {}])), streams: [] });
  it("prefers `default`, then `score`, then the first config the corpus holds", () => {
    expect(foldOptionConfigName(football, named("a", "score", "default"))).toBe("default");
    expect(foldOptionConfigName(football, named("a", "default", "score"))).toBe("default");
    expect(foldOptionConfigName(football, named("a", "score"))).toBe("score");
    expect(foldOptionConfigName(football, named("first", "second"))).toBe("first");
  });
  it("refuses a corpus with no config, by sport name (the empty case)", () => {
    expect(() => foldOptionConfigName(football, named())).toThrow(/football records no config/);
  });
  it("names `default` for the sports that have one and `score` for generic in the committed corpora (counted)", () => {
    let checked = 0;
    for (const m of readers()) {
      const names = Object.keys(readCorpus(m.key).configs);
      expect(foldOptionConfigName(m, readCorpus(m.key)), m.key).toBe(names.includes("default") ? "default" : "score");
      checked++;
    }
    expect(checked).toBe(readers().length);
  });
});

describe("extendFoldOptions - the append path", () => {
  const committedBefore = (key: string): GoldenCorpus => {
    const mine = new Set(readCorpus(key).streams.filter((s) => s.foldOptions !== undefined).map(identity));
    return without(readCorpus(key), mine);
  };
  /** `extendFoldOptions` where it is expected to succeed: a refusal by name (a ledger that misses its story, an identity taken) is a failed
   *  ASSERTION here, so a defect in a builder cannot pass for "it threw, so the test errored". */
  const extendOk = (module: AnySportModule, corpus: GoldenCorpus, stories?: readonly FoldOptionStory[]): FoldOptionExtension => {
    const held: { value: FoldOptionExtension | null } = { value: null };
    expect(() => {
      held.value = extendFoldOptions(module, corpus, stories);
    }, `${module.key}: extendFoldOptions does not refuse`).not.toThrow();
    return held.value ?? { corpus, appended: [], stillMissing: [] };
  };

  it("empty case first: a corpus with no holes gets nothing appended, and a second call is the same", () => {
    let sports = 0;
    forEachSport(({ module, key }) => {
      const corpus = readCorpus(key);
      const first = extendOk(module, corpus);
      expect(first.appended, key).toEqual([]);
      expect(first.stillMissing, key).toEqual([]);
      expect(JSON.stringify(first.corpus), key).toBe(JSON.stringify(corpus));
      sports++;
    });
    expect(sports).toBe(builtinModules.length);
  }, sweepBudget("read"));

  it("reproduces the committed award streams byte for byte from a corpus that lacks them, adds no config, and a second call appends nothing", () => {
    let appended = 0;
    forEachSport(({ module, key }) => {
      const committed = readCorpus(key);
      const base = committedBefore(key);
      const expected = FOLD_OPTION_STORIES.filter((s) => s.sport === key).map((s) => s.id);
      expect(foldOptionHoles(module, base), `${key}: without its award streams the sport has holes`).toEqual(expected);
      const result = extendOk(module, base);
      expect(result.stillMissing, key).toEqual([]);
      expect(result.appended.length, key).toBe(expected.length);
      expect(JSON.stringify(result.corpus), key).toBe(JSON.stringify(committed));
      expect(Object.keys(result.corpus.configs), `${key}: the stories use a config already there`).toEqual(Object.keys(base.configs));
      expect(extendOk(module, result.corpus).appended, `${key}: a second call`).toEqual([]);
      appended += result.appended.length;
    });
    expect(appended).toBe(FOLD_OPTION_STORIES.length);
  }, sweepBudget("build"));

  it("skips a story some recorded stream already reaches, whatever its config name or seed, and still appends the others", () => {
    const football = sport("football");
    const base = committedBefore("football");
    const donorOf = committedOf(storyById("football.walkover")).stream;
    const donor: GoldenStream = { ...donorOf, seed: 4242 };
    const result = extendOk(football, { ...base, streams: [...base.streams, donor] });
    expect(result.appended.map((a) => a.split(" ")[0])).toEqual(FORFEIT_AWARD_CASES.filter((c) => c.id !== "walkover").map((c) => `football.${c.id}`));
  });

  it("refuses by name an identity another stream holds", () => {
    const football = sport("football");
    const base = committedBefore("football");
    const decoy: GoldenStream = { ...base.streams[0]!, config: storyConfig(base), seed: FOLD_OPTION_SEED_BASE + 1 };
    expect(() => extendFoldOptions(football, { ...base, streams: [...base.streams, decoy] })).toThrow(new RegExp(`already has a stream ${storyConfig(base)}#${FOLD_OPTION_SEED_BASE + 1}`));
  });

  it("the identity another stream holds is config AND seed: the same seed under ANOTHER config is no clash", () => {
    const football = sport("football");
    const base = committedBefore("football");
    const decoy = base.streams.find((s) => s.config !== storyConfig(base));
    expect(decoy, "premise: the corpus records streams under a config other than the stories'").toBeDefined();
    const same: GoldenStream = { ...decoy!, seed: FOLD_OPTION_SEED_BASE + 1 };
    expect(same.config, "premise: that config is not the one the story records under").not.toBe(storyConfig(base));
    const result = extendOk(football, { ...base, streams: [...base.streams, same] });
    expect(result.appended.length, "every story is still appended").toBe(FORFEIT_AWARD_CASES.length);
    expect(result.corpus.streams.filter((s) => s.seed === FOLD_OPTION_SEED_BASE + 1).map((s) => s.config).sort()).toEqual([same.config, storyConfig(base)].sort());
  });

  it("records each stream in its corpus's own format: a format-1 corpus gets the four stored fields and none of the kernel fields", () => {
    const football = sport("football");
    const base = asFormatOne(committedBefore("football"));
    expect(corpusFormat(base), "premise: the corpus is format 1").toBe(1);
    const result = extendOk(football, base);
    const added = result.corpus.streams.filter((s) => s.foldOptions !== undefined);
    expect(added.length).toBe(FORFEIT_AWARD_CASES.length);
    for (const s of added) expect(Object.keys(s), identity(s)).toEqual(["config", "seed", "foldOptions", "events", "states", "outcome", "summary", "deltas"]);
  });

  it("stores an appended stream in the corpus's SLIM form: a ledger long enough to have digestible steps comes back digested (a custom story, since the committed ones are all anchors)", () => {
    const football = sport("football");
    const base = committedBefore("football");
    const retired = storyById("football.retired_after_play");
    // the retirement story with more play behind it: the generator's own walk (seed 5: nine sport events, all valid after a Start) between the Start and the retirement
    const long: FoldOptionStory = {
      ...retired,
      build: (ctx) => {
        const short = retired.build(ctx)!;
        const play = buildStream(ctx.module, ctx.cfg as never, ctx.lineups, 5, 40)
          .filter((e) => !e.type.startsWith("core."))
          .slice(0, 8)
          .map((e) => ({ type: e.type, payload: e.payload }));
        return { ...short, events: [ev("core.start"), ...play, short.events.at(-1)!] };
      },
    };
    const result = extendOk(football, base, [long]);
    expect(result.appended, "premise: the custom story was appended").toHaveLength(1);
    const added = result.corpus.streams.at(-1)!;
    expect(added.events.length, "premise: more steps than the anchors alone").toBeGreaterThan(5);
    expect(isSlimStream(added), "the appended stream holds digests, as every stream of a slim corpus does").toBe(true);
    const whole: GoldenStream = { ...added, states: recomputeStream(football, result.corpus.configs[added.config], added.events, added.lineups, 3, added.foldOptions).states };
    expect(JSON.stringify(added), "and is exactly the slim form of what was recorded").toBe(JSON.stringify(slimStream(football, result.corpus, whole)));
  });

  it("reports a hole its builder cannot close instead of inventing a stream, and refuses a built ledger that misses its story", () => {
    const football = sport("football");
    const base = committedBefore("football");
    const story = storyById("football.walkover");
    const dry = extendOk(football, base, [{ ...story, build: () => null }]);
    expect(dry.appended).toEqual([]);
    expect(dry.stillMissing).toEqual(["football.walkover"]);
    expect(dry.corpus.streams.length).toBe(base.streams.length);
    expect(() => extendFoldOptions(football, base, [{ ...story, build: () => ({ events: [{ type: "core.start", payload: {} }], foldOptions: { forfeitAward: [9, 3] } }) }])).toThrow(/does not reach its story/);
  });

  it("refuses a sport that has no config to record a story under (an empty corpus), by name", () => {
    const football = sport("football");
    const base = committedBefore("football");
    expect(() => extendFoldOptions(football, { ...base, configs: {}, streams: [] })).toThrow(/football records no config/);
  });
});

describe("every replay path of the toolchain offers a committed award stream its own options", () => {
  const awardStreams = (key: string): GoldenStream[] => readCorpus(key).streams.filter((s) => s.foldOptions !== undefined);
  const stripped = (corpus: GoldenCorpus): GoldenCorpus => ({ ...corpus, streams: corpus.streams.map(({ foldOptions: _dropped, ...rest }) => rest) });

  it("verifyStream accepts each award stream, and names what moved when the options are gone from a stream the award reaches (and only that kind)", () => {
    let landed = 0;
    let withheld = 0;
    for (const module of readers()) {
      const corpus = readCorpus(module.key);
      for (const stream of awardStreams(module.key)) {
        const label = `${module.key} ${identity(stream)}`;
        expect(verifyStream(module, corpus, stream), label).toEqual([]);
        const { foldOptions: _dropped, ...without } = stream;
        const problems = verifyStream(module, corpus, without);
        const story = FOLD_OPTION_STORIES.find((st) => st.sport === module.key && st.seed === stream.seed)!;
        if (story.case.lands) {
          expect(problems.join("\n"), `${label}: the award is gone, so the recorded summary is not what the fold gives`).toMatch(/summary/);
          landed++;
        } else {
          expect(problems, `${label}: the kernel withholds the award, so dropping it moves nothing`).toEqual([]);
          withheld++;
        }
      }
    }
    expect(landed).toBe(readers().length * FORFEIT_AWARD_CASES.filter((c) => c.lands).length);
    expect(withheld).toBe(readers().length * FORFEIT_AWARD_CASES.filter((c) => !c.lands).length);
  }, sweepBudget("read"));

  it("rebaselineCorpus re-folds each award stream to the very bytes it holds, and moves the landed ones the day their options are dropped", () => {
    let same = 0;
    let moved = 0;
    for (const module of readers()) {
      const corpus = readCorpus(module.key);
      const again = rebaselineCorpus(module, corpus);
      const dropped = rebaselineCorpus(module, stripped(corpus));
      corpus.streams.forEach((stream, i) => {
        if (stream.foldOptions === undefined) return;
        const label = `${module.key} ${identity(stream)}`;
        expect(JSON.stringify(again.streams[i]), `${label}: a re-baseline of the committed stream changes nothing`).toBe(JSON.stringify(stream));
        same++;
        const story = FOLD_OPTION_STORIES.find((st) => st.sport === module.key && st.seed === stream.seed)!;
        if (story.case.lands) {
          expect(dropped.streams[i]!.summary, `${label}: refolded without its options the headline moves`).not.toBe(stream.summary);
          moved++;
        } else expect(dropped.streams[i]!.summary, `${label}: a withheld award moves nothing`).toBe(stream.summary);
      });
    }
    expect(same).toBe(FOLD_OPTION_STORIES.length);
    expect(moved).toBe(readers().length * FORFEIT_AWARD_CASES.filter((c) => c.lands).length);
  }, sweepBudget("probe"));

  it("a format-1 award stream recorded WITHOUT its options is a stale stream (would not survive), not an effective-only one: the second-chance replay offers the options too", () => {
    const football = sport("football");
    const view = asFormatOne(readCorpus("football"));
    const at = view.streams.findIndex((s) => s.seed === storyById("football.walkover").seed && s.foldOptions !== undefined);
    expect(at, "premise: the format-1 view holds the walkover award stream").toBeGreaterThan(-1);
    const stream = view.streams[at]!;
    // the four fields format 1 stores, folded WITHOUT the award: the stream as if its options had never been offered
    const stale = recomputeStream(football, view.configs[stream.config], stream.events, stream.lineups, 1);
    const tampered: GoldenCorpus = { ...view, streams: view.streams.map((s, i) => (i === at ? { ...s, states: stale.states, outcome: stale.outcome, summary: stale.summary, deltas: stale.deltas } : s)) };
    let message = "accepted";
    try {
      reformatCorpus(football, tampered, 3);
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/would not survive/);
    expect(message, "a stream whose own replay (options and all) disagrees is stale, whatever format 2 would add").not.toMatch(/EFFECTIVE ones/);
  });

  it("the mutation list is handed an award stream's options: the context's unmutated replay verifies clean in both storage forms (counted)", () => {
    let checked = 0;
    for (const story of FOLD_OPTION_STORIES.filter((s) => s.case.lands)) {
      const { module, corpus, stream } = committedOf(story);
      const index = corpus.streams.indexOf(stream);
      for (const form of ["full", "slim"] as const) {
        const ctx = mutationContext(module, corpus, slimCorpus(module, corpus), form, index, 0, 0, null);
        expect(ctx.verify(ctx.replayed), `${story.id} ${form}: the replay the mutations start from is the stream as recorded`).toEqual([]);
        expect(ctx.replayed.summary, `${story.id} ${form}: and it holds the award's headline`).toBe(stream.summary);
        checked++;
      }
    }
    expect(checked).toBe(2 * readers().length * FORFEIT_AWARD_CASES.filter((c) => c.lands).length);
  });

  it("reformatCorpus takes the format-1 view of a reading sport's corpus back to the committed bytes, award streams included", () => {
    let sports = 0;
    for (const module of readers()) {
      const committed = readCorpus(module.key);
      const back = reformatCorpus(module, asFormatOne(committed), 3);
      expect(JSON.stringify(back), module.key).toBe(JSON.stringify(committed));
      sports++;
    }
    expect(sports).toBe(readers().length);
  }, sweepBudget("build", readers().length * 2));
});

describe("the recomputation a reviewer is told to run is the whole input of the stream", () => {
  it("a re-baseline report that cannot name a moved key prints the recompute line with the corpus format and the stream's foldOptions", () => {
    const football = sport("football");
    const corpus = readCorpus("football");
    const quiet = corpusStateDiff(corpus, corpus, football);
    expect(formatCorpusStateDiff(quiet), "the empty case: nothing moved, no hint").not.toContain("recomputeStream");
    const digestOnly: StreamStateDiff = {
      index: 0, config: "default", seed: 1, changedSteps: [3], digestOnlySteps: [3], reformattedSteps: [], changedStateKeys: [],
      outcomeMoved: false, summaryMoved: false, deltasMoved: false, summaryStepsMoved: [], overlayKeysMoved: [], statsKeysMoved: [], eventsMoved: false,
    };
    const report = formatCorpusStateDiff({ ...quiet, streams: [digestOnly], changedStreams: 1, changedStates: 1, digestOnlyStates: 1 });
    expect(report).toContain("recomputeStream(module, corpus.configs[stream.config], stream.events, stream.lineups, corpusFormat(corpus), stream.foldOptions).states[N]");
  });
});

describe("the policy text says what the corpora do (GOLDEN-POLICY.md)", () => {
  const policy = readFileSync(new URL("./GOLDEN-POLICY.md", import.meta.url), "utf8").replace(/\s+/g, " ");
  it("documents the foldOptions field: what it is, that only forfeitAward is allowed, and that it is part of the stream's input identity", () => {
    expect(policy).toContain("`foldOptions`");
    expect(policy).toMatch(/only `forfeitAward` is allowed/);
    expect(policy).toMatch(/part of the stream's input/);
    // the file it names is the one that exists, and the seeds it quotes are the table's
    expect(policy).toContain("`src/testkit/golden-fold-options.ts`");
    expect(existsSync(new URL("./golden-fold-options.ts", import.meta.url))).toBe(true);
    expect(policy).toContain(`${FOLD_OPTION_SEED_BASE + 1}-${FOLD_OPTION_SEED_BASE + FORFEIT_AWARD_CASES.length}`);
  });
  it("no longer lists the server-only fold input among what the corpora cannot see, and says what stays unseen", () => {
    expect(policy).not.toContain("**A server-only fold input**");
    expect(policy).not.toContain("no corpus carries one, and `recomputeStream`");
    expect(policy).toMatch(/Retired by GF-3 T2/);
    // a fold option only the stories offer: another offered input is still a story the corpus does not hold
    expect(policy).toMatch(/A NEW fold option owes a story/);
  });
});
