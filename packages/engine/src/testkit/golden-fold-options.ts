// Golden streams that carry a `foldOptions` (GF-3 Task 2) - the forfeit award the SERVER folds with and no corpus stream offered.
//
// WHY. `apps/web` folds with `{ strictFromSeq, forfeitAward }` (`append-event.ts`, `fold.ts`): the stage points rule's award for a
// forfeit with nothing played. Football, generic, hockey and ice hockey keep it in module state (`state.forfeitAward`) and read it for their
// forfeit credit and their headline; every other sport ignores it. Until now no stream offered one, so a change to how those four credit an
// award moved no golden and the fold-epoch guard passed it unseen (GOLDEN-POLICY.md, "What the guard cannot see", the bullet this retires).
// A stream now records the award it was folded with (`GoldenStream.foldOptions`, part of its INPUT), the recorder offers it to every prefix
// fold exactly as the write path does (`strictFold`), and the stories below append the streams that reach it.
//
// WHAT. A table of named stories: (a sport that reads the award) x (a forfeit case). The reading sports are the engine's own declaration
// (`awardScoreKeys`), so a sport that starts reading the award owes the stories at once (`foldOptionHoles` names them; a test fails). The
// cases are the three shapes of the kernel's rule (`unplayedForfeitEvent`: `by !== "both" && (reason === "walkover" || !playedBefore)`):
//   - walkover: a side that never arrived, nothing recorded. The award lands.
//   - withdrew_unplayed: a withdrawal after the Start, before any play. The award lands (the walkover reason is not the only way in).
//   - retired_after_play: a retirement once play is recorded. The kernel WITHHOLDS the award, so a stream that offers one records the
//     same match as one that does not: the other direction of the rule, pinned so a reader that stopped checking the kernel's word shows.
// The sides differ on purpose (the away side walks over; the home side withdraws and retires), so a winner-first pair read against the wrong
// side is a different recording.
//
// THE AWARD IS DERIVED, NOT TYPED. `build` folds the ledger WITHOUT the option, asks the module what it credits that forfeit on its own
// (`forfeitCredit`, under the metric keys the module declares in `awardScoreKeys`), and offers a pair that differs from that credit in BOTH
// numbers, through a real `PointsRule` and `forfeitAwardOffer` (competition/points.ts: the function the server calls; called here, never
// reimplemented). A reader that dropped, swapped or ignored the offer is therefore a different recording whatever the sport's own default is.
//
// `reached` is the verdict over the engine's own folds (never a value typed here): the stream's ledger ends in the case's forfeit, it offers an
// award that differs from the sport's own credit, and recording it WITH the offer differs from recording it WITHOUT exactly as the case says
// (the state holds the award and the headline and the credit move; or nothing moves). It reads the module through `forfeitCredit` and
// `recomputeStream` only, never `outcomeOf` (see golden-branches.ts for why that list is kept short).
//
// HOW IT IS USED. `foldOptionHoles` is the stories no recorded stream reaches; `extendFoldOptions` appends one slim stream per hole after
// everything already there, under the config the sport's coverage streams already use (no new config). `EXTEND_GOLDEN=1` runs it after the
// branch pass. Streams carry `seed` in (3000, BRANCH_SEED_BASE): clear of the generator's walks, of the branches' and of the floor's, so none of
// their keep-rules or reproductions count them. The epoch guard keys a stream `config#seed`.
import { PointsRule, forfeitAwardOffer } from "../competition/points.ts";
import { foldMatchWithStoppage } from "../core/events.ts";
import type { AwardReason, LineupPair } from "../core/types.ts";
import { resolvePositions } from "../sport/catalog.ts";
import type { AnySportModule } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";
import {
  corpusFormat,
  recomputeStream,
  slimStream,
  type GoldenCorpus,
  type GoldenEvent,
  type GoldenFoldOptions,
  type GoldenStream,
} from "./golden.ts";
import { buildStream, defaultLineupPair, makeEnvelope } from "./helpers.ts";

const STRICT_ALL = { strictFromSeq: 0 } as const;

/** A fold-option stream's `seed` is `FOLD_OPTION_SEED_BASE + 1 + (index of its case)`. Above every generator seed (the coverage scan stops at
 *  3000, so a later `extendCorpus` can never collide with it) and below the branch streams' base (90000) and the floor's stride (100000), so
 *  neither the floor's reproduction nor the branch keep-rule counts it. The epoch guard keys a stream `config#seed`. */
export const FOLD_OPTION_SEED_BASE = 80_000;
/** How many generator seeds `drawPlay` tries for a walk that opens with a Start and then a sport event. */
const PLAY_SEED_BUDGET = 60;
/** How long a walk `drawPlay` asks the generator for. */
const PLAY_WALK_MAX = 40;

const ev = (type: string, payload: unknown = {}): GoldenEvent => ({ type, payload });
const obj = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

// ------------------------------------------------------------------------------------------------------------- cases

export interface ForfeitAwardCase {
  /** The token a story is named by: `<sport>.<id>`. */
  readonly id: string;
  /** The `core.forfeit` reason the ledger ends in. */
  readonly reason: AwardReason;
  /** Which side forfeits. */
  readonly offender: "home" | "away";
  /** Whether play is recorded before the forfeit (the kernel's `playRecorded`). */
  readonly played: boolean;
  /** Whether the kernel hands the module the offered award for this forfeit (`unplayedForfeitEvent`). A test holds this to the kernel's
   *  own predicate over every committed story, so it is a statement of the rule, not a value the verdict trusts. */
  readonly lands: boolean;
  /** The case in the words of the rule. */
  readonly what: string;
}

export const FORFEIT_AWARD_CASES: readonly ForfeitAwardCase[] = [
  { id: "walkover", reason: "walkover", offender: "away", played: false, lands: true, what: "a side that never arrived: a walkover with nothing recorded" },
  { id: "withdrew_unplayed", reason: "withdrew", offender: "home", played: false, lands: true, what: "a withdrawal after the Start and before any play" },
  { id: "retired_after_play", reason: "retired", offender: "home", played: true, lands: false, what: "a retirement once play is recorded: the kernel withholds the award" },
];

// ---------------------------------------------------------------------------------------------------------- verdicts

/** A recorded stream as a verdict sees it: the module, the RAW config it was recorded under, its lineups (absent = the default pair), its
 *  ledger and the options it was folded with. */
export interface AwardRecorded {
  readonly module: AnySportModule;
  readonly raw: unknown;
  readonly lineups: LineupPair | undefined;
  readonly events: readonly GoldenEvent[];
  readonly foldOptions: GoldenFoldOptions | undefined;
}

/** What `build` is given: the module, the raw config the stream is recorded under, the parsed config and the default lineup pair. */
export interface AwardBuildCtx {
  readonly module: AnySportModule;
  readonly raw: unknown;
  readonly cfg: unknown;
  readonly lineups: LineupPair;
}

/** A built ledger and the award it is folded with. */
export interface AwardBuilt {
  readonly events: GoldenEvent[];
  readonly foldOptions: GoldenFoldOptions;
}

const lineupsOf = (r: AwardRecorded): { cfg: unknown; lineups: LineupPair } => {
  const cfg = r.module.configSchema.parse(r.raw) as unknown;
  return { cfg, lineups: r.lineups ?? defaultLineupPair(resolvePositions(r.module, cfg)) };
};

/** The module's own credit for the forfeit that ends `events`, folded WITHOUT any offered award: the numbers the table gets when no stage
 *  rule speaks, under the module's own metric keys. `winner` is the side that gains. Null when the ledger does not fold. */
function ownCredit(
  module: AnySportModule,
  cfg: unknown,
  lineups: LineupPair,
  events: readonly GoldenEvent[],
  reason: AwardReason,
  offender: "home" | "away",
): { readonly for: number; readonly against: number } | null {
  const keys = module.awardScoreKeys;
  if (keys === undefined) return null;
  try {
    const folded = foldMatchWithStoppage(module as never, cfg as never, lineups, events.map((e, i) => makeEnvelope(i, e, e.voids)), STRICT_ALL);
    const credit = module.forfeitCredit(cfg, folded.state, reason, offender);
    const winner = credit.perSide[offender === "home" ? 1 : 0];
    const gained = winner[keys.for];
    const lost = winner[keys.against];
    // the module declared these keys, so its credit holds them: a module that does not is reported, never read as a zero
    if (gained === undefined || lost === undefined) return null;
    return { for: gained, against: lost };
  } catch {
    return null;
  }
}

/** The fields a stream stores, as one comparable string: the recording an award either moves or leaves alone. */
const stored = (r: ReturnType<typeof recomputeStream>): string =>
  JSON.stringify([r.states, r.outcome, r.summary, r.deltas, r.summaries ?? null, r.overlay ?? null, r.playerStats ?? null]);

/** The verdict for one case: null when the recorded stream reaches it, else why not. Exported so a test can hand it a doctored case or a
 *  wrapped module. The cheap shape guards come first (most streams in a corpus offer no award and are refused before any fold). */
export function reachesAward(c: ForfeitAwardCase): (r: AwardRecorded) => string | null {
  return (r) => {
    const keys = r.module.awardScoreKeys;
    if (keys === undefined) return `${r.module.key} declares no awardScoreKeys, so it never reads an award`;
    if (r.foldOptions === undefined) return "the stream offers no award (it records no foldOptions)";
    const { cfg, lineups } = lineupsOf(r);
    const last = r.events[r.events.length - 1];
    const payload = obj(last?.payload);
    if (last?.type !== "core.forfeit" || payload.reason !== c.reason || payload.by !== lineups[c.offender].entrantId) {
      return `the ledger does not end in a ${c.reason} forfeit by the ${c.offender} side`;
    }
    const own = ownCredit(r.module, cfg, lineups, r.events, c.reason, c.offender);
    if (own === null) return "the ledger does not fold without the award, so the sport's own credit cannot be read";
    const [winner, loser] = r.foldOptions.forfeitAward;
    if (winner === own.for) return `the award's winner number ${winner} equals the sport's own credit (${keys.for} ${own.for}), so a dropped or ignored award would record the same`;
    if (loser === own.against) return `the award's loser number ${loser} equals the sport's own credit (${keys.against} ${own.against}), so a dropped or ignored award would record the same`;

    let without: ReturnType<typeof recomputeStream>;
    let offered: ReturnType<typeof recomputeStream>;
    try {
      without = recomputeStream(r.module, r.raw, r.events, r.lineups, 3);
      offered = recomputeStream(r.module, r.raw, r.events, r.lineups, 3, r.foldOptions);
    } catch (error) {
      return `the ledger does not record under its options: ${error instanceof Error ? error.message : String(error)}`;
    }
    const finalState = obj(JSON.parse(offered.states[offered.states.length - 1] ?? "null"));
    if (!c.lands) {
      // withheld: the kernel does not hand the module the award, so offering one is the same recording, every stored field (`states`
      // holds the whole module state at every step, so a module that kept the award anywhere shows here)
      if (stored(offered) !== stored(without)) return "offering the award changed the recording of a forfeit the case says the kernel withholds it from";
      return null;
    }
    const held = finalState.forfeitAward;
    if (JSON.stringify(held) !== JSON.stringify([...r.foldOptions.forfeitAward])) return `the module state holds ${JSON.stringify(held ?? null)}, not the offered award, so the award never reached it`;
    if (offered.summary === without.summary) return "the headline reads the same with and without the award";
    if (offered.deltas === without.deltas) return "the table's credit is the same with and without the award";
    return null;
  };
}

// ------------------------------------------------------------------------------------------------------------ stories

export interface FoldOptionStory {
  /** `<sport>.<case>`, unique: the token a hole is named by. */
  readonly id: string;
  /** The module key. */
  readonly sport: string;
  readonly case: ForfeitAwardCase;
  /** The stream's `seed`, in (3000, BRANCH_SEED_BASE); its identity is `config#seed`. */
  readonly seed: number;
  /** null when a RECORDED stream reaches the story, else why it does not. */
  reached(r: AwardRecorded): string | null;
  /** The ledger of a stream that reaches it and the award it is folded with, or null when none can be built. */
  build(c: AwardBuildCtx): AwardBuilt | null;
}

/** A Start and the first sport event the module's own generator draws after it: play has been recorded and the match is undecided. Null
 *  where no walk in the budget opens that way. The lowest seed wins, so the ledger is a pure function of the module. */
function drawPlay(c: AwardBuildCtx): GoldenEvent | null {
  for (let seed = 1; seed <= PLAY_SEED_BUDGET; seed++) {
    const walk = buildStream(c.module, c.cfg as never, c.lineups, seed, PLAY_WALK_MAX);
    const at = walk.findIndex((e) => !e.type.startsWith("core."));
    const first = walk[at];
    if (first !== undefined && walk.slice(0, at).every((e) => e.type === "core.start")) return { type: first.type, payload: first.payload };
  }
  return null;
}

/** The ledger of a case: the forfeit, preceded by what the case says came before it. */
function ledgerOf(c: ForfeitAwardCase, ctx: AwardBuildCtx): GoldenEvent[] | null {
  const forfeit = ev("core.forfeit", { by: ctx.lineups[c.offender].entrantId, reason: c.reason });
  if (!c.played) return c.reason === "walkover" ? [forfeit] : [ev("core.start"), forfeit];
  const play = drawPlay(ctx);
  return play === null ? null : [ev("core.start"), play, forfeit];
}

function buildAward(c: ForfeitAwardCase, ctx: AwardBuildCtx): AwardBuilt | null {
  const events = ledgerOf(c, ctx);
  if (events === null) return null;
  const own = ownCredit(ctx.module, ctx.cfg, ctx.lineups, events, c.reason, c.offender);
  if (own === null) return null;
  // differs from the sport's own credit in BOTH numbers (winner's +2, loser's +1), and winner first so the pair is not symmetric
  const rule = PointsRule.parse({ base: { win: 3, draw: 1, loss: 0 }, forfeit: { winnerPoints: 3, loserPoints: 0, awardScore: [own.for + 2, own.against + 1] } });
  const forfeitAward = forfeitAwardOffer(rule, ctx.module);
  return forfeitAward === undefined ? null : { events, foldOptions: { forfeitAward } };
}

/** Every story: the sports that declare `awardScoreKeys` (registry order) x the cases (table order). */
export const FOLD_OPTION_STORIES: readonly FoldOptionStory[] = builtinModules
  .filter((module) => module.awardScoreKeys !== undefined)
  .flatMap((module) =>
    FORFEIT_AWARD_CASES.map((c, index): FoldOptionStory => ({
      id: `${module.key}.${c.id}`,
      sport: module.key,
      case: c,
      seed: FOLD_OPTION_SEED_BASE + 1 + index,
      reached: reachesAward(c),
      build: (ctx) => buildAward(c, ctx),
    })),
  );

// ------------------------------------------------------------------------------------------------------------ the path

/** The config a sport's fold-option streams are recorded under: `default` where the corpus has one (football, hockey, ice hockey), else
 *  `score` (generic), else the first. The stories add no config of their own: a name the corpus already holds keeps its recorded raw. Throws
 *  by name on a corpus with none. */
export function foldOptionConfigName(module: AnySportModule, corpus: GoldenCorpus): string {
  for (const name of ["default", "score"]) if (Object.hasOwn(corpus.configs, name)) return name;
  const first = Object.keys(corpus.configs)[0];
  if (first === undefined) throw new Error(`golden fold options: ${module.key} records no config to record a stream under`);
  return first;
}

const recordedOf = (module: AnySportModule, corpus: GoldenCorpus, stream: GoldenStream): AwardRecorded => ({
  module,
  raw: corpus.configs[stream.config],
  lineups: stream.lineups,
  events: stream.events,
  foldOptions: stream.foldOptions,
});

/** The stories of `module` that NO recorded stream reaches. A stream that already reaches one - whatever its config name or seed - makes that
 *  story a skip. */
export function foldOptionHoles(module: AnySportModule, corpus: GoldenCorpus, stories: readonly FoldOptionStory[] = FOLD_OPTION_STORIES): string[] {
  return stories
    .filter((story) => story.sport === module.key)
    .filter((story) => !corpus.streams.some((stream) => story.reached(recordedOf(module, corpus, stream)) === null))
    .map((story) => story.id);
}

export interface FoldOptionExtension {
  readonly corpus: GoldenCorpus;
  /** `story-id config:seed` of every stream appended, in story order. */
  readonly appended: string[];
  /** The holes a builder could not close. */
  readonly stillMissing: string[];
}

/** Appends one slim stream per hole, after everything already there. Existing streams and configs are carried over untouched; a corpus with no
 *  holes comes back unchanged (a second call appends nothing). An identity another stream already holds is refused by name: the epoch guard keys a
 *  stream by `config#seed`, and a quiet overwrite would change an existing stream's input. A ledger built for a story that does not reach it is
 *  refused too, never appended. */
export function extendFoldOptions(module: AnySportModule, existing: GoldenCorpus, stories: readonly FoldOptionStory[] = FOLD_OPTION_STORIES): FoldOptionExtension {
  const corpus: GoldenCorpus = { ...existing, configs: { ...existing.configs }, streams: [...existing.streams] };
  const appended: string[] = [];
  const stillMissing: string[] = [];
  for (const story of stories.filter((s) => s.sport === module.key)) {
    if (corpus.streams.some((stream) => story.reached(recordedOf(module, corpus, stream)) === null)) continue;
    const name = foldOptionConfigName(module, corpus);
    if (corpus.streams.some((s) => s.config === name && s.seed === story.seed)) {
      throw new Error(`golden fold options: ${module.key} already has a stream ${name}#${story.seed}; the epoch guard keys streams by that identity`);
    }
    const raw = corpus.configs[name];
    const cfg = module.configSchema.parse(raw) as unknown;
    const built = story.build({ module, raw, cfg, lineups: defaultLineupPair(resolvePositions(module, cfg)) });
    if (built === null) {
      stillMissing.push(story.id);
      continue;
    }
    const stream: GoldenStream = {
      config: name,
      seed: story.seed,
      foldOptions: built.foldOptions,
      events: built.events,
      ...recomputeStream(module, raw, built.events, undefined, corpusFormat(corpus), built.foldOptions),
    };
    const verdict = story.reached(recordedOf(module, corpus, stream));
    if (verdict !== null) throw new Error(`golden fold options: the ledger built for ${story.id} does not reach its story: ${verdict}`);
    corpus.streams.push(slimStream(module, corpus, stream));
    appended.push(`${story.id} ${name}:${story.seed}`);
  }
  return { corpus, appended, stillMissing };
}
