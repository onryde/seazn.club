// Post #27, "What happens when neither side turns up?". For every sport in the registry, under the variant a new division
// starts on, one double walkover is recorded the way the console records it (`core.forfeit{by: "both", reason:
// "walkover"}`) and folded by the app's own read fold (`foldFrom`). The table's booking is the sport's `standingsDelta`
// over that outcome, paid by the web's one table-rules loader (`tableRulesOf`) and `payout`, the path every standings
// read takes. For comparison, the same sport's single walkover (forfeit-scores.ts's fold) is paid the same way.
//
// WHAT A PERSON SEES (fix round 1, I1). The fold's headline for a double walkover is a "0 — 0" (or "L — L"), but no screen
// paints it: every score-line host asks `creditsNobody` first and shows the tag and the sentence instead. So the table's
// "What the match shows" column is that tag and sentence, read through `forfeitTag` and the English dictionary, and the
// score is not shown at all.
//
// WHAT CHECKS IT. The claims hold the result to the engine's declaration of a double walkover (its `forfeitCredit` with `by: "both"`:
// nothing credited, every metric out of every ratio, X-DW-4) and to `advancesNobody` (a double walkover sends nobody on in
// a bracket), and witness that a double walkover is not "a loss each": where a played loss pays a point (table tennis),
// the double walkover still pays none. The refusal on a match that feeds nothing is read from the same two functions the
// server's guard and the console's dialog call (`doubleWalkoverRefused`, `forfeitDialogModel`), in every sport.
import { advancesNobody, forbidsLevelResult, StageKind, type MatchOutcome } from "@seazn/engine/core";
import { decidedInFor, payout, setsToWinOf } from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { forEachSport } from "@seazn/engine/testkit";
import publicDict from "@/dictionaries/en/public.json";
import { forfeitBaseState, forfeitDialogModel } from "@/components/v2/forfeit-dialog";
import { doubleWalkoverRefused } from "@/lib/double-walkover-next-match";
import { finalTitleTag } from "@/lib/final-title-tag";
import { creditsNobody, forfeitTag, forfeitWords, FORFEIT_SENTENCE_KEY, FORFEIT_TAG_KEY, NO_LEDGER } from "@/lib/forfeit-tag";
import { bracketAfterRoundOne, KNOCKOUT_PLAYERS } from "./knockout-withdrawal";
import { forfeitFold, lineupsFor, scoreShown } from "./forfeit-scores";
import { pickerSportName } from "./sport-name";
import type { Claim, EngineExample, ExampleResult } from "./types";
import { leagueRules, startingCfg } from "./kit";

export const DOUBLE_WALKOVER_ID = "double-walkover";

const C = { sport: 0, shows: 1, points: 2, played: 3, lost: 4 } as const;
const DICT = publicDict as Record<string, string>;
/** The match's tag and its sentence, joined: what the console, the hub and the live score print for a double walkover. */
const SHOWS_JOIN = " · ";
/** The seat a double walkover leaves nobody in (the picture's word). */
const NOBODY = "nobody";

function dictWord(key: string): string {
  const w = DICT[key];
  if (typeof w !== "string" || w.length === 0) throw new Error(`double-walkover: the English dictionary has no '${key}'`);
  return w;
}

function paid(module: AnySportModule, by: string) {
  const { cfg, outcome, headline, delta } = forfeitFold(module, by, "walkover");
  const pay = payout(outcome, decidedInFor(module, outcome), [delta[0]!, delta[1]!], true, leagueRules(module, cfg).points, module.awardScoreKeys, setsToWinOf(module, cfg));
  return { outcome, headline, delta, pay };
}

/** The tag and sentence a double walkover reads as, through the product's one reader and its English words. */
function shownWords(outcome: unknown): { tag: string; sentence: string } {
  const tag = forfeitTag(outcome, NO_LEDGER);
  if (tag === null) throw new Error("double-walkover: the outcome carries no forfeit tag");
  const w = forfeitWords(tag, (key) => dictWord(key), () => "");
  return { tag: w.tag, sentence: w.sentence };
}

/** The eight-player draw's first two quarter-finals and the semi-final they feed, from the engine's own wiring. */
function quarterPair() {
  const lines = bracketAfterRoundOne();
  const semi = lines.find((l) => l.round === 1)!;
  const byId = new Map(lines.map((l) => [l.id, l]));
  return { first: byId.get(semi.homeFrom!)!, second: byId.get(semi.awayFrom!)!, semi };
}

function build(): ExampleResult {
  const rows: (string | number)[][] = [];
  const facts: Record<string, string | number> = {};
  let nobodyAdvances = 0;
  let words: { tag: string; sentence: string } | null = null;
  const visited = forEachSport(({ module }) => {
    const both = paid(module, "both");
    if (advancesNobody(both.outcome)) nobodyAdvances++;
    const [h] = both.pay;
    // No score: a double walkover credits nobody, and every host that would paint the fold's "0 — 0" shows the tag instead.
    if (!creditsNobody(both.outcome)) throw new Error(`double-walkover: ${module.key}'s double walkover would be painted as a score`);
    const shown = shownWords(both.outcome);
    words = shown;
    rows.push([pickerSportName(module.key), `${shown.tag}${SHOWS_JOIN}${shown.sentence}`, h!.points, h!.played === 1 ? "Yes" : "No", h!.lost === 1 ? "Yes" : "No"]);
    facts[`${module.key}Points`] = h!.points;
  });
  // The comparison the post draws: a table tennis loss that was played earns a point; a double walkover earns none.
  const tt = builtinModules.find((m) => m.key === "tabletennis")!;
  const single = paid(tt, "ben");
  facts.tabletennisWalkoverLoss = single.pay.find((d) => d.lost === 1)?.points ?? -1;
  facts.tabletennisPlayedLoss = leagueRules(tt, startingCfg(tt)).points.loss.regulation;
  facts.sportCount = visited;
  facts.nobodyAdvancesIn = nobodyAdvances;
  facts.tag = (words as { tag: string } | null)?.tag ?? "";
  facts.sentence = (words as { sentence: string } | null)?.sentence ?? "";

  // The picture (M9): two quarter-finals feeding a semi-final. The second is a double walkover, so nobody comes from it and
  // the first one's winner walks over the semi-final.
  const { first, second } = quarterPair();
  const winner = first.winner!;
  return {
    facts,
    table: {
      caption: "A double walkover in each sport, on the settings a new division starts with: what the match shows, and what each of the two sides gets in the table.",
      columns: ["Sport", "What the match shows", "Points each side gets", "Counts as played", "Counts as a loss"],
      rows,
    },
    diagram: {
      kind: "walkoverBracket",
      title: `Neither ${second.home} nor ${second.away} turned up for the second quarter-final, so nobody goes on from it. ${winner}, who won the first, walks over the semi-final and goes through.`,
      rounds: [
        {
          name: "Quarter-finals",
          matches: [
            { sides: [first.home!, first.away!], winner, result: `${winner} won` },
            { sides: [second.home!, second.away!], struck: [second.home!, second.away!], result: "Neither turned up" },
          ],
        },
        { name: "Semi-final", matches: [{ sides: [winner, NOBODY], vacant: [NOBODY], winner, result: "Walkover" }] },
      ],
    },
    text: [],
  };
}

// ---- claims: the engine's declaration of a double walkover, and its bracket rule ----

function claimsFor(module: AnySportModule): Claim[] {
  const key = module.key;
  const rowOf = (r: ExampleResult) => r.table?.rows.find((x) => x[C.sport] === pickerSportName(key));
  return [
    {
      says: `${key}: a double walkover credits each side nothing, so it scores no points and is out of every ratio`,
      source: `${key} forfeitCredit with by "both" (X-DW-4: nothing credited, every metric excluded)`,
      sport: key,
      check(r) {
        const row = rowOf(r);
        if (row === undefined) return "no row";
        // The sport's own declaration of a double walkover: forfeitCredit with `by: "both"`.
        const cfg = startingCfg(module);
        const credit = module.forfeitCredit(cfg as never, module.init(cfg as never, lineupsFor(module, cfg) as never), "walkover", "both");
        if (credit.perSide.some((side) => Object.values(side).some((v) => v !== 0))) return "the declaration now credits something";
        if (credit.excluded.length === 0) return "the declaration no longer keeps the match out of the ratios";
        if (row[C.points] !== 0 || r.facts[`${key}Points`] !== 0) return `pays ${String(row[C.points])}`;
        return (row[C.played] === "Yes" && row[C.lost] === "Yes") || `played ${String(row[C.played])}, lost ${String(row[C.lost])}`;
      },
    },
    {
      says: `${key}: the match shows the double walkover's tag and sentence, never the fold's score, because the product's hosts hide a score that credits nobody`,
      source: `forfeitTag / creditsNobody (lib/forfeit-tag.ts), the English public dictionary (${FORFEIT_TAG_KEY.double_walkover}, ${FORFEIT_SENTENCE_KEY.double_walkover}); the fold's headline is what a host would otherwise paint`,
      sport: key,
      check(r) {
        const row = rowOf(r);
        if (row === undefined) return "no row";
        const { outcome, headline } = forfeitFold(module, "both", "walkover");
        if (!creditsNobody(outcome)) return "the product no longer hides a double walkover's score";
        // The witness that the hiding matters: the fold's headline is a score line a host would paint (or, for cricket, none).
        if (key === "football" && !/\d/.test(scoreShown(headline))) return "anti-vacuity: football's fold headline reads no score, so there is nothing to hide";
        const want = `${dictWord(FORFEIT_TAG_KEY.double_walkover)}${SHOWS_JOIN}${dictWord(FORFEIT_SENTENCE_KEY.double_walkover)}`;
        if (/\d\s*[—–-]\s*\d/.test(String(row[C.shows]))) return `shows a score: '${String(row[C.shows])}'`;
        return row[C.shows] === want || `shows '${String(row[C.shows])}', the product's words are '${want}'`;
      },
    },
    {
      says: `${key}: the console offers "both sides" on a match that feeds a next match, and offers it nowhere on a match that feeds none`,
      source: "forfeitDialogModel (components/v2/forfeit-dialog.tsx): who, guidance — the model the console's dialog renders",
      sport: key,
      check(r) {
        if (rowOf(r) === undefined) return `no ${key} row`; // read the result: an empty one has no row for this sport
        const cfg = startingCfg(module);
        const base = forfeitBaseState(module, cfg, null, lineupsFor(module, cfg) as never);
        const feeds = forfeitDialogModel(module, cfg, base, { noNextMatch: false, playRecorded: false });
        const final = forfeitDialogModel(module, cfg, base, { noNextMatch: true, playRecorded: false });
        if (!feeds.who.includes("both") || feeds.guidance !== null) return "a match with a next match does not offer both sides";
        return (!final.who.includes("both") && final.guidance === "noNextMatch") || "a match with no next match still offers both sides";
      },
    },
  ];
}

const claims: Claim[] = [
  {
    says: "the table holds every sport of the registry, in order, and a double walkover sends nobody on in every one of them",
    source: "the sport registry (forEachSport) and the engine's advancesNobody (a double walkover advances nobody)",
    check(r) {
      const labels: string[] = [];
      const visited = forEachSport(({ module }) => labels.push(pickerSportName(module.key)));
      if (r.facts.sportCount !== visited || r.facts.nobodyAdvancesIn !== visited) return "counts differ from the registry";
      if (!advancesNobody({ kind: "double_walkover" } as MatchOutcome)) return "the engine now advances someone";
      return JSON.stringify((r.table?.rows ?? []).map((x) => x[C.sport])) === JSON.stringify(labels) || "rows differ from the registry";
    },
  },
  {
    says: "the tag and the sentence the post quotes are the product's English words for a double walkover",
    source: `the English public dictionary, read through forfeitTag's own keys (${FORFEIT_TAG_KEY.double_walkover}, ${FORFEIT_SENTENCE_KEY.double_walkover})`,
    check(r) {
      return (
        (r.facts.tag === dictWord(FORFEIT_TAG_KEY.double_walkover) && r.facts.sentence === dictWord(FORFEIT_SENTENCE_KEY.double_walkover)) ||
        `tag '${String(r.facts.tag)}', sentence '${String(r.facts.sentence)}'`
      );
    },
  },
  {
    says: "a double walkover is not a loss each: in table tennis a played loss pays what the rule declares, a single walkover's loser and a double walkover pay nothing",
    source: "class 19 witness: table tennis pays a played loss (ITTF) more than nothing; the double walkover pays 0 (forfeitCredit by both). The played loss is read from the stage's declared table rule (tableRulesOf)",
    check(r) {
      const tt = builtinModules.find((m) => m.key === "tabletennis")!;
      const playedLoss = leagueRules(tt, startingCfg(tt)).points.loss.regulation;
      if (!(playedLoss > 0)) return "anti-vacuity: a table tennis played loss must pay something for this witness";
      if (r.facts.tabletennisPlayedLoss !== playedLoss) return `the played loss is ${String(r.facts.tabletennisPlayedLoss)}, the rule declares ${playedLoss}`;
      return (r.facts.tabletennisPoints === 0 && r.facts.tabletennisWalkoverLoss === 0) || "table tennis pays a double walkover or a walkover loss";
    },
  },
  {
    says: "a deciding final that carries a double walkover reads as a vacant title (the way two withdrawn finalists leave it), a third-place match or a played final that does not",
    source: "finalTitleTag (lib/final-title-tag.ts), the one reader every bracket tile asks; the product writes the final's double walkover when both finalists withdraw (usecases/__tests__/vacant-title.test.ts)",
    check(r) {
      // Read the result, so an empty one fails: the example must have swept every sport the rule is the same in.
      if (r.facts.sportCount !== builtinModules.length) return `sportCount ${String(r.facts.sportCount)}, the registry holds ${builtinModules.length}`;
      const dw = { kind: "double_walkover" };
      const tag = (f: { is_final: boolean; third_place: boolean; status?: string; outcome: unknown }) => finalTitleTag({ status: "forfeited", ...f });
      const seen = {
        final: tag({ is_final: true, third_place: false, outcome: dw }),
        bronze: tag({ is_final: false, third_place: true, outcome: dw }),
        bronzeFlaggedFinal: tag({ is_final: true, third_place: true, outcome: dw }),
        semi: tag({ is_final: false, third_place: false, outcome: dw }),
        notSettled: tag({ is_final: true, third_place: false, status: "scheduled", outcome: dw }),
        played: finalTitleTag({ is_final: true, third_place: false, status: "decided", outcome: { kind: "win", winner: "a", loser: "b" } }),
      };
      const want = { final: "vacant", bronze: null, bronzeFlaggedFinal: null, semi: null, notSettled: null, played: null };
      return JSON.stringify(seen) === JSON.stringify(want) || `title tags are ${JSON.stringify(seen)}, expected ${JSON.stringify(want)}`;
    },
  },
  {
    says: "a double walkover is refused exactly where a bracket match feeds no next match (a final, a third-place match, a stepladder's last rung), and never in a table or on a ladder",
    source: "doubleWalkoverRefused (lib/double-walkover-next-match.ts), the guard the server and the console share, over the engine's StageKind list (BRACKET_KINDS, the ladder exempt)",
    check(r) {
      // Read the result, so an empty one fails: the example must have swept every sport this guard is shared by.
      if (r.facts.sportCount !== builtinModules.length) return `sportCount ${String(r.facts.sportCount)}, the registry holds ${builtinModules.length}`;
      const refusing = new Set(["knockout", "double_elim", "stepladder", "page_playoff"]);
      const kinds = StageKind.options as readonly string[];
      if (kinds.length < 9) return "anti-vacuity: the stage kind list shrank";
      for (const kind of kinds) {
        if (doubleWalkoverRefused(kind, true) !== false) return `${kind}: refused on a match that feeds a next match`;
        if (doubleWalkoverRefused(kind, false) !== refusing.has(kind)) return `${kind}: refusal on a match that feeds none is ${String(doubleWalkoverRefused(kind, false))}`;
      }
      // The two halves the rule is built from: bracket kinds forbid a level result, the ladder alone is exempt.
      return (forbidsLevelResult("ladder") && !doubleWalkoverRefused("ladder", false) && !forbidsLevelResult("league")) || "the ladder exemption or the table kinds changed";
    },
  },
  {
    says: "the picture draws a quarter-final nobody turned up for, and the winner of the quarter-final beside it walking over the semi-final they both feed",
    source: "standard single-elimination seeding (1 meets 8, 4 meets 5; their winners meet in the first semi-final); advancesNobody; engine-db/__tests__/double-walkover-seating.test.ts:107 (the same shape through the real usecases)",
    check(r) {
      const d = r.diagram;
      if (d?.kind !== "walkoverBracket") return "no walkover bracket";
      if (!advancesNobody({ kind: "double_walkover" } as MatchOutcome)) return "the engine now advances someone";
      const [qf, sf] = d.rounds;
      if (d.rounds.length !== 2 || qf?.matches.length !== 2 || sf?.matches.length !== 1) return "the picture is not two quarter-finals and a semi-final";
      const seed = (n: number) => KNOCKOUT_PLAYERS[n - 1]!;
      const [a, b] = qf.matches as [(typeof qf.matches)[number], (typeof qf.matches)[number]];
      const sameSet = (x: readonly string[], y: readonly string[]) => [...x].sort().join("|") === [...y].sort().join("|");
      if (!sameSet(a.sides, [seed(1), seed(8)]) || a.winner !== seed(1) || a.struck !== undefined) return "quarter-final 1 is not the first seed's win over the eighth";
      if (!sameSet(b.sides, [seed(4), seed(5)]) || !sameSet(b.struck ?? [], b.sides) || b.winner !== undefined) return "quarter-final 2 is not a double walkover between the fourth and fifth seeds";
      const [s] = sf.matches;
      if (qf.name !== "Quarter-finals" || sf.name !== "Semi-final") return `the picture's rounds are '${qf.name}' and '${sf.name}'`;
      if (a.result !== `${seed(1)} won` || b.result !== "Neither turned up" || s?.result !== "Walkover") return `the result lines are '${a.result}', '${b.result}' and '${String(s?.result)}'`;
      if (a.vacant !== undefined || b.vacant !== undefined || s?.vacant?.length !== 1 || s.vacant[0] !== NOBODY) return "only the semi-final's empty seat, 'nobody', is drawn as a seat and not a name";
      return (s !== undefined && s.sides.length === 2 && s.sides[0] === seed(1) && s.sides[1] === NOBODY && s.winner === seed(1) && s.struck === undefined) || "the semi-final is not a walkover for the first quarter-final's winner";
    },
  },
];
const sportsClaimed = forEachSport(({ module }) => {
  claims.push(...claimsFor(module));
});
if (sportsClaimed !== builtinModules.length) throw new Error("double-walkover: the sweep missed a sport");

export const doubleWalkover: EngineExample = {
  id: DOUBLE_WALKOVER_ID,
  kind: "engine",
  sports: "all",
  build,
  claims,
};
