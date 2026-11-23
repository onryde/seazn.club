// Post #26, "What score does a forfeit give, sport by sport?". For every sport in the registry, under the variant a NEW
// division of that sport starts on (starting-variant.ts), one walkover is recorded the way the console records it
// (`core.forfeit{by, reason: "walkover"}` on a match nothing was played in) and folded by the app's own read fold
// (`foldFrom`: the outcome and the headline are outcomeOf/summaryOf, as every stored fixture's are). The headline is the
// score a person sees; the table's booking (`standingsDelta` over that outcome) is what the standings count.
//
// WHAT CHECKS IT. The claims recompute the expected score from each sport's own walkover DECLARATION (`forfeitCredit`
// over the match's opening state) and from the named rulebooks for the sports that fix a number (football 3-0, hockey and
// ice hockey 5-0, chess 1-0), in code that shares nothing with `build()`'s wording. A volleyball set credit is checked
// against the variant's own set target, a cricket charge against its own innings length.
import type { EventEnvelope, MatchOutcome } from "@seazn/engine/core";
import { setsToWinOf } from "@seazn/engine/competition";
import { resolvePositions, type AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { declaredCfgs, forEachSport, lineupFromCatalog } from "@seazn/engine/testkit";
import { sportLabel } from "@/blog/labels";
import { foldFrom } from "@/server/engine-db/fold";
import { startingVariantKey } from "./starting-variant";
import type { Claim, EngineExample, ExampleResult } from "./types";

export const FORFEIT_SCORES_ID = "forfeit-scores";

const HOME = "ana";
const AWAY = "ben";
const C = { sport: 0, score: 1, counts: 2 } as const;

type Ledger = Record<string, number>;

export function startingCfg(module: AnySportModule): unknown {
  const key = startingVariantKey(module);
  return declaredCfgs(module).find((c) => c.name === key)!.cfg;
}

export function lineupsFor(module: AnySportModule, cfg: unknown) {
  const catalog = resolvePositions(module, cfg as never);
  return { home: lineupFromCatalog(catalog, HOME), away: lineupFromCatalog(catalog, AWAY) };
}

/** One match decided by a single `core.forfeit` (nothing played), folded by the app's read fold. */
export function forfeitFold(module: AnySportModule, by: string, reason: string) {
  const cfg = startingCfg(module);
  const lineups = lineupsFor(module, cfg);
  const envelopes: EventEnvelope[] = [
    { id: `wo-${module.key}`, fixtureId: `wo-${module.key}`, seq: 1, type: "core.forfeit", payload: { by, reason }, recordedAt: "2026-11-01T10:00:00.000Z", recordedBy: null },
  ];
  const folded = foldFrom(`blog-example:${module.key}:forfeit`, { sportKey: module.key, module, cfg, lineups, envelopes, stageKind: "league" } as never);
  if (folded.outcome === null) throw new Error(`${module.key}: a forfeit decided nothing`);
  const delta = module.standingsDelta(folded.outcome as MatchOutcome, cfg as never, { kind: "league" }, folded.state);
  return { cfg, outcome: folded.outcome as MatchOutcome, headline: folded.summary.headline, delta };
}

/** The headline as a reader sees it: a score with digits, a "W/O" mark, or no score at all. */
export function scoreShown(headline: string): string {
  return /[0-9A-Za-z]/.test(headline) ? headline : "No score";
}

/** What the table counts for the walkover, in words, from the two sides' booked metrics. */
function countsWords(w: Ledger, l: Ledger): string {
  const parts: string[] = [];
  if ("gf" in w) parts.push(`${w.gf} goals to ${l.gf}`);
  if ("sets_won" in w) {
    parts.push(`${w.sets_won} sets to ${l.sets_won}`);
    if ((w.points_won ?? 0) > 0) parts.push(`${w.points_won} points to ${l.points_won}`);
    if ("games_won" in w && w.games_won === 0) parts.push("no games");
  }
  if ((l.balls_faced_eff ?? 0) > 0) parts.push(`the side that did not turn up is charged ${(l.balls_faced_eff ?? 0) / 6} overs at no runs`);
  if ("wins" in w) parts.push("a win, with no colour counted");
  if ("for" in w && w.for === 0 && l.for === 0) parts.push("a win, with no score");
  return parts.join("; ");
}

function build(): ExampleResult {
  const rows: (string | number)[][] = [];
  const facts: Record<string, string | number> = {};
  const visited = forEachSport(({ module }) => {
    const { headline, delta } = forfeitFold(module, AWAY, "walkover");
    const [w, l] = [delta[0]!.metrics as Ledger, delta[1]!.metrics as Ledger];
    const shown = scoreShown(headline);
    rows.push([sportLabel(module.key), shown, countsWords(w, l)]);
    facts[`${module.key}Score`] = shown;
  });
  facts.sportCount = visited;
  return {
    facts,
    table: {
      caption: "One walkover in each sport, on the settings a new division starts with: the score the match shows, and what the table counts for it.",
      columns: ["Sport", "Score shown", "What the table counts"],
      rows,
    },
    text: [],
  };
}

// ---- claims: the expected score comes from each sport's forfeitCredit declaration and the named rulebooks ----

/** The rulebooks that fix a walkover score in goals (or a game), by sport key. */
export const RULEBOOK_WALKOVER: Readonly<Record<string, { winner: number; source: string }>> = {
  football: { winner: 3, source: "FIFA Disciplinary Code: a forfeited match is lost 3-0" },
  hockey: { winner: 5, source: "FIH Tournament Regulations: a forfeited match is lost 5-0" },
  icehockey: { winner: 5, source: "IIHF Statutes and Bylaws: a forfeited game is lost 5-0" },
  boardgame: { winner: 1, source: "FIDE Laws of Chess: a game lost by default scores 1-0" },
};

function rowOf(r: ExampleResult, module: AnySportModule): (string | number)[] | undefined {
  return r.table?.rows.find((row) => row[C.sport] === sportLabel(module.key));
}

/** The walkover the sport DECLARES (`forfeitCredit` over the opening state), winner's and loser's ledgers. */
function declared(module: AnySportModule): { cfg: unknown; w: Ledger; l: Ledger; excluded: readonly string[] } {
  const cfg = startingCfg(module);
  const state = module.init(cfg as never, lineupsFor(module, cfg) as never);
  const credit = module.forfeitCredit(cfg as never, state, "walkover", "away");
  return { cfg, w: credit.perSide[0] as Ledger, l: credit.perSide[1] as Ledger, excluded: credit.excluded };
}

/** The two numbers a headline shows, or null when it shows none. */
const numbersIn = (s: string): number[] => [...s.matchAll(/\d+/g)].map((m) => Number(m[0]));

function claimsFor(module: AnySportModule): Claim[] {
  const key = module.key;
  const out: Claim[] = [
    {
      says: `${key}: the walkover's score shows what the sport's walkover declaration credits, the side that turned up first`,
      source: `${key} forfeitCredit (the walkover credit, read over the match's opening state)`,
      sport: key,
      check(r) {
        const row = rowOf(r, module);
        if (row === undefined) return "no row";
        const { w, l } = declared(module);
        const shown = numbersIn(String(row[C.score]));
        const pair = "gf" in w ? [w.gf, l.gf] : "sets_won" in w ? [w.sets_won, l.sets_won] : "wins" in w ? [w.wins, l.wins] : [];
        if (r.facts[`${key}Score`] !== row[C.score]) return "the score fact and the cell differ";
        return JSON.stringify(shown) === JSON.stringify(pair) || `shows ${JSON.stringify(shown)}, the declaration credits ${JSON.stringify(pair)}`;
      },
    },
  ];
  const rule = RULEBOOK_WALKOVER[key];
  if (rule !== undefined)
    out.push({
      says: `${key}: the walkover is ${rule.winner}-0, as the rulebook fixes it`,
      source: rule.source,
      sport: key,
      check(r) {
        const row = rowOf(r, module);
        const shown = numbersIn(String(row?.[C.score] ?? ""));
        return (shown[0] === rule.winner && shown[1] === 0) || `shows ${JSON.stringify(shown)}`;
      },
    });
  const sets = setsToWinOf(module, startingCfg(module));
  if (sets !== undefined)
    out.push({
      says: `${key}: the walkover is every set the best-of needs, each to the variant's own set target`,
      source: `${key} variant declaration (bestOf, setTo) and setsToWinOf`,
      sport: key,
      check(r) {
        const row = rowOf(r, module);
        const cfg = startingCfg(module) as { setTo?: number };
        const want = `${sets} sets to 0; ${sets * (cfg.setTo ?? NaN)} points to 0`;
        return String(row?.[C.counts] ?? "").startsWith(want) || `counts '${String(row?.[C.counts])}', expected '${want}'`;
      },
    });
  if (key === "cricket")
    out.push({
      says: "cricket: the side that did not turn up is charged its full innings at no runs, which is what moves its net run rate",
      source: "cricket variant declaration (ballsPerInnings, ballsPerOver) and its walkover credit",
      sport: key,
      check(r) {
        const cfg = startingCfg(module) as { ballsPerInnings: number; ballsPerOver: number };
        const want = `charged ${cfg.ballsPerInnings / cfg.ballsPerOver} overs at no runs`;
        return String(rowOf(r, module)?.[C.counts] ?? "").includes(want) || `expected '${want}'`;
      },
    });
  if (key === "tennis")
    out.push({
      says: "tennis: a walkover credits sets but no games, so it cannot move a game ratio",
      source: "tennis forfeitCredit: games_won and games_lost are excluded",
      sport: key,
      check(r) {
        const { excluded } = declared(module);
        if (!excluded.includes("games_won")) return "the declaration no longer excludes games";
        return String(rowOf(r, module)?.[C.counts] ?? "").includes("no games") || "the row does not say no games";
      },
    });
  if (key === "boardgame")
    out.push({
      says: "chess: a game won by default counts no colour, so it never changes who plays white next",
      source: "boardgame forfeitCredit: white and black are excluded (FIDE C.04 colour allocation counts played games)",
      sport: key,
      check(r) {
        const { excluded } = declared(module);
        if (!excluded.includes("white") || !excluded.includes("black")) return "the declaration no longer excludes the colours";
        return String(rowOf(r, module)?.[C.counts] ?? "").includes("no colour") || "the row does not say no colour";
      },
    });
  return out;
}

const claims: Claim[] = [
  {
    says: "the table holds every sport of the registry, in registry order, and counts them",
    source: "the sport registry (builtinModules, via forEachSport)",
    check(r) {
      const labels: string[] = [];
      const visited = forEachSport(({ module }) => labels.push(sportLabel(module.key)));
      if (r.facts.sportCount !== visited) return `sportCount ${String(r.facts.sportCount)}, registry ${visited}`;
      return JSON.stringify((r.table?.rows ?? []).map((x) => x[C.sport])) === JSON.stringify(labels) || "rows differ from the registry";
    },
  },
  {
    says: "the rulebook constants differ between sports, so a single walkover score could not be right everywhere",
    source: "class 19 witness: football's 3 against hockey's 5 (FIFA, FIH)",
    check(r) {
      return numbersIn(String(r.facts.footballScore))[0] !== numbersIn(String(r.facts.hockeyScore))[0] || "football and hockey show the same walkover";
    },
  },
];
const sportsClaimed = forEachSport(({ module }) => {
  claims.push(...claimsFor(module));
});
if (sportsClaimed !== builtinModules.length) throw new Error("forfeit-scores: the sweep missed a sport");

export const forfeitScores: EngineExample = {
  id: FORFEIT_SCORES_ID,
  kind: "engine",
  sports: "all",
  build,
  claims,
};
