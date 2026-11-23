// What the engine examples share: playing one real match to a wanted result, and reading the rules a table pays by.
// Moved out of the pilot (standings-points.ts) unchanged in behaviour, and widened by one optional input: the rules a
// stage sets for itself (an organiser switching a decider on in a league stage's Deciders section), which the app reads
// through the same two doors it always does (`postedStageCfg` for the match's format, `tableRulesOf` for the points).
//
// WHICH MATCHES. A match is the first seeded walk of the testkit, in seed order, whose refolded outcome `accept` takes. The
// refold is the app's own read fold (`foldFrom`: the outcome and the headline are the kernel's readers, `outcomeOf` and
// `summaryOf`, as every stored fixture's are), and it must leave the state the walk's own last step left. The search is
// deterministic, so an example needs no typed seed and no typed score.
import { playRecorded, type EventEnvelope, type MatchOutcome } from "@seazn/engine/core";
import { decidedInFor, forfeitShaped, payout, setsToWinOf, type FixtureResult } from "@seazn/engine/competition";
import { resolvePositions } from "@seazn/engine/sport";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { buildWalk, declaredCfgs, lineupFromCatalog } from "@seazn/engine/testkit";
import { postedStageCfg } from "@/lib/stage-decider-off";
import { foldFrom } from "@/server/engine-db/fold";
import { tableRulesOf, type LoadedTableRules } from "@/server/engine-db/table-rules";

export const NAMES: Record<string, string> = { ana: "Ana", ben: "Ben", cy: "Cy", dev: "Dev" };
/** The seeded search's bounds: far past what any sport needs, so a miss is a real fault and not a short budget. */
export const MAX_SEEDS = 20000;
export const MAX_EVENTS = 3000;

export type Cfg = unknown;

/** One sport's module from the registry, by key. A sport that is not there is a fault, never a skipped example. */
export function moduleOf(key: string): AnySportModule {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`blog example: no '${key}' module in the sport registry`);
  return m;
}

/**
 * A sport's own league points declaration for a config (its `tablePointsRule`). The example CLAIMS read it, never the
 * loader the example's `build()` reads, because an expected value is never derived from the code under test. It is the
 * ONE call of the sport's points rule in the blog examples, which is why table-rules-single-resolver.test.ts names it.
 */
export function declaredLeaguePoints(module: AnySportModule, cfg: Cfg): ReturnType<AnySportModule["tablePointsRule"]> {
  return module.tablePointsRule(cfg as never, "league");
}

export const upperFirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
export const compact = (variantKey: string): string => upperFirst(variantKey.replace(/[^a-z0-9]/gi, ""));

export function groupBy<T>(items: T[], keyOf: (t: T) => string): T[][] {
  const groups: T[][] = [];
  for (const it of items) {
    const g = groups.find((x) => keyOf(x[0]!) === keyOf(it));
    if (g) g.push(it);
    else groups.push([it]);
  }
  return groups;
}

export function joinOr(words: string[]): string {
  return words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
}

/** The variants a module declares by name (declaredCfgs also lists the bare schema default, which is no variant). */
export function variantsOf(module: AnySportModule): { key: string; cfg: Cfg }[] {
  return declaredCfgs(module)
    .filter((c) => Object.hasOwn(module.variants, c.name))
    .map((c) => ({ key: c.name, cfg: c.cfg as Cfg }));
}

/** The stage rules an organiser sets by switching a sport's deciders ON in a stage's Deciders section: the engine's own
 *  preset for a knockout stage of this variant (`stageDefaults`), empty for a sport that has no decider to switch on. */
export type StageRules = Record<string, unknown>;

/**
 * The format a league stage plays: the division's variant config with the stage's own rules laid over it, through the
 * one composition the product's create door and read fold share (`postedStageCfg`). No rules: the variant's own config.
 */
export function leagueCfg(module: AnySportModule, variantKey: string, cfg: Cfg, rules: StageRules | null): Cfg {
  return rules === null ? cfg : postedStageCfg(module, cfg, "league", variantKey, rules);
}

/**
 * The rules a league table pays and ranks by, read where every standings read reads them: the web's one loader
 * (`tableRulesOf`, table-rules-single-resolver.test.ts), over the rows of a league stage that has not started. So no
 * pin and no division order: the loader's live layers, down to the sport's. `rules`, when given, are the stage's own.
 */
export function leagueRules(module: AnySportModule, cfg: Cfg, rules: StageRules | null = null, points: unknown = null): LoadedTableRules {
  const own: Record<string, unknown> = {};
  if (rules !== null) own.rules = rules;
  if (points !== null) own.points = points;
  return tableRulesOf(
    {
      stageId: `blog-example:${module.key}`,
      kind: "league",
      status: "pending",
      stageConfig: Object.keys(own).length === 0 ? null : own,
      pin: null,
      pinnedAt: null,
      divisionConfig: cfg,
      divisionTiebreakers: null,
    },
    module,
  );
}

export interface Played {
  outcome: MatchOutcome;
  paid: FixtureResult;
  headline: string;
  /** Whether anything was played (`playRecorded` of the ledger): a forfeit with nothing played is paid as unplayed. */
  played: boolean;
  /** The ledger the match was played from: an example reads HOW it ended (an abandon, a forfeit) off it. */
  events: readonly EventEnvelope[];
}

export interface PlayOpts {
  /** The stage's own rules (see `leagueCfg`); `cfg` passed to `play` is then the division's variant config. */
  rules?: StageRules | null;
  variantKey?: string;
  /** The points rule the stage sets for itself (a preset chip in its Points section), over the sport's own. */
  points?: unknown;
  /** Accept a forfeit or an award (default: only a decided, played-to-the-end match is wanted). */
  allowForfeit?: boolean;
}

/**
 * Plays one match to the wanted result and pays it as the table would: the first seeded walk, in seed order, whose
 * refolded outcome `accept` takes, paid by the loader's rule through the engine's `payout`.
 */
export function play(
  module: AnySportModule,
  cfg: Cfg,
  what: string,
  sides: [string, string],
  accept: (outcome: MatchOutcome, pair: FixtureResult, played: boolean, events: readonly EventEnvelope[]) => boolean,
  opts: PlayOpts = {},
): Played {
  const rules = opts.rules ?? null;
  const matchCfg = leagueCfg(module, opts.variantKey ?? "", cfg, rules);
  const catalog = resolvePositions(module, matchCfg);
  const lineups = { home: lineupFromCatalog(catalog, sides[0]), away: lineupFromCatalog(catalog, sides[1]) };
  const table = leagueRules(module, cfg, rules, opts.points ?? null);
  const wanted = opts.allowForfeit === true ? ["win", "draw", "tie", "no_result", "award"] : ["win", "draw", "tie", "no_result"];
  for (let seed = 1; seed <= MAX_SEEDS; seed++) {
    const { events, states } = buildWalk(module, matchCfg, lineups, seed, MAX_EVENTS);
    const last = states[states.length - 1];
    // An empty walk is no match (and the read fold refuses an empty ledger).
    if (last === undefined) continue;
    const folded = foldFrom(`blog-example:${module.key}:${seed}`, { sportKey: module.key, module, cfg: matchCfg, lineups, envelopes: events, stageKind: "league" });
    if (JSON.stringify(folded.state) !== JSON.stringify(last)) {
      throw new Error(`${module.key}: seed ${seed}: the app's fold and the walk disagree on the state`);
    }
    const outcome = folded.outcome;
    // Only a decided match can be wanted; a forfeit only when the example asks for one.
    if (outcome === null || !wanted.includes(outcome.kind)) continue;
    if (forfeitShaped(outcome) && opts.allowForfeit !== true) continue;
    const delta = module.standingsDelta(outcome, matchCfg as never, { kind: "league" }, folded.state);
    const pair: FixtureResult = [delta[0], delta[1]];
    const played = playRecorded(events as readonly EventEnvelope[], module);
    if (!accept(outcome, pair, played, events as readonly EventEnvelope[])) continue;
    const paid = payout(outcome, decidedInFor(module, outcome), pair, played, table.points, module.awardScoreKeys, setsToWinOf(module, matchCfg));
    return { outcome, paid, headline: folded.summary.headline, played, events: events as readonly EventEnvelope[] };
  }
  throw new Error(`${module.key}: no seed up to ${MAX_SEEDS} gives the wanted match (${what})`);
}

export function winnerSetScore(pair: FixtureResult): string | null {
  const w = pair.find((d) => d.won === 1);
  const won = w?.metrics.sets_won;
  const lost = w?.metrics.sets_lost;
  return won === undefined || lost === undefined ? null : `${won}-${lost}`;
}

/** What the winner and the loser of a decided match (a win, or a forfeit's award) were paid, by entrant (a booked shoot-out has no `won` flag). */
export function winnerLoserPoints(p: Played): [number, number] {
  const o = p.outcome;
  // A forfeit is an award (it names its winner and loser); no other kind does.
  if (o.kind !== "win" && o.kind !== "award") throw new Error("a winner and a loser need a win or an award");
  const w = p.paid.find((d) => d.entrantId === o.winner);
  const l = p.paid.find((d) => d.entrantId === o.loser);
  if (w === undefined || l === undefined) throw new Error("the paid pair does not name the match's winner and loser");
  return [w.points, l.points];
}
