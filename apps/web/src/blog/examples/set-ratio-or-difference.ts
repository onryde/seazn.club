// Post #10, "Set ratio or set difference: which does my sport use?".
//
// THE TABLE, badminton (the sport that ranks by set difference): four players play a real round robin (seeded walks,
// refolded by the app's read fold) in which Cy, Ana and Ben each win two matches. Their set records give Cy and Ana the
// same set DIFFERENCE but different set RATIOS. Ranked through the app's ranking path twice: by badminton's own order
// (difference, then the match between the two still level), and by the same order with ratios in place of differences.
// The two put a different player first. The difference and ratio cells are the public table's own text (`derivedText`).
//
// THE FACTS, every sport: which set, game, board or point measures its declared league order uses, in order, in the words of the
// Standings tab and the public table's "split on" line ("set difference" for every set sport). The organiser's editor, stage card
// and division builder name the same step in the sport's own unit ("game difference" in badminton, table tennis and carrom), so
// the example also holds both words and which sports count games (read off each module's declared set ledger label, "Games won").
//
// WHAT CHECKS IT. The difference and ratio cells are recomputed from the sets cells (won minus lost, won over lost); the
// places are recomputed from the cells by BWF General Competition Regulations 16.2 (wins; for two level, their match; for
// three or more, set difference, then the match of any two left level); the per-sport facts read each module's DECLARED
// order (`defaultOrderOf`), never the loader `build()` reads.
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule, TiebreakerKey } from "@seazn/engine/sport";
import { declaredCfgs, defaultOrderOf, forEachSport } from "@seazn/engine/testkit";
import { sportLabel } from "@/blog/labels";
import ui from "@/dictionaries/en/ui.json";
import { editorLabel, standingsLabel } from "@/blog/labels-screens";
import { derivedText } from "@/server/public-site/standings-view";
import { startingVariantKey } from "./starting-variant";
import { factsRepeatTheTable, placeOf, placeText, playAndRank, scoreOf, rowOf, stageRules, type MatchView, type Meeting } from "./tie-break-play";
import type { BlogExample, Claim, ExampleResult } from "./types";

export const SET_RATIO_OR_DIFFERENCE_ID = "set-ratio-or-difference";

/**
 * The columns, in the words the badminton table prints: the ledger's own label for the set count ("Games won", "Games lost": the
 * module's declared metric labels, since badminton counts games where volleyball counts sets) and the Standings words for the two
 * measures ("set difference", "set ratio").
 */
function columns(): string[] {
  const metrics = builtinModules.find((m) => m.key === "badminton")!.metrics;
  const label = (key: string) => metrics.find((x) => x.key === key)?.label ?? "";
  const up = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return ["Player", "Matches won", label("sets_won"), label("sets_lost"), up(standingsLabel("set_diff", "badminton")), up(standingsLabel("set_ratio", "badminton")), "Place, badminton's order", "Place, with set ratio instead"];
}
export const COLUMNS = columns();
export const C = { player: 0, won: 1, setsWon: 2, setsLost: 3, diff: 4, ratio: 5, own: 6, ratioOrder: 7 } as const;

const PLAYERS = [
  { id: "cy", name: "Cy" },
  { id: "ana", name: "Ana" },
  { id: "ben", name: "Ben" },
  { id: "dev", name: "Dev" },
];
const nameOf = (id: string) => PLAYERS.find((p) => p.id === id)!.name;
const sets = (h: number, a: number) => (v: MatchView) => v.home.metrics.sets_won === h && v.away.metrics.sets_won === a;

/** Cy beat Ana, Ana beat Ben, Ben beat Cy (taking a set off her), and all three beat Dev, Cy dropping a set to him. */
const MEETINGS: Meeting[] = [
  { home: "cy", away: "ana", what: "Cy beats Ana 2-0", seed: 7, want: sets(2, 0) },
  { home: "ana", away: "ben", what: "Ana beats Ben 2-0", seed: 7, want: sets(2, 0) },
  { home: "ben", away: "cy", what: "Ben beats Cy 2-1", seed: 11, want: sets(2, 1) },
  { home: "cy", away: "dev", what: "Cy beats Dev 2-1", seed: 11, want: sets(2, 1) },
  { home: "ana", away: "dev", what: "Ana beats Dev 2-0", seed: 7, want: sets(2, 0) },
  { home: "ben", away: "dev", what: "Ben beats Dev 2-0", seed: 7, want: sets(2, 0) },
];

/** The measures a league order compares sets, games, boards or points by. */
const MEASURES: ReadonlySet<string> = new Set(["set_diff", "point_diff", "set_ratio", "point_ratio", "game_ratio", "board_ratio", "h2h_set_ratio", "h2h_point_ratio"]);

/** The measures of an order, in the Standings tab's words for that sport. */
export function measureWords(order: readonly TiebreakerKey[], sportKey: string): string {
  const found = order.filter((k) => MEASURES.has(k));
  return found.length === 0 ? "no set or point measure" : found.map((k) => standingsLabel(k, sportKey)).join(", then ");
}

/** "a, b and c" */
const listOf = (items: readonly string[]) => (items.length < 2 ? (items[0] ?? "none") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

/** Whether a sport counts games where volleyball counts sets: its declared set ledger is labelled "Games won". */
export function countsGames(module: AnySportModule): boolean {
  return /^games\b/i.test(module.metrics.find((x) => x.key === "sets_won")?.label ?? "");
}

/** Badminton's own order with each difference swapped for the ratio of the same ledger (and nothing else moved). */
function ratioOrder(order: readonly TiebreakerKey[]): TiebreakerKey[] {
  return order.map((k) => (k === "set_diff" ? "set_ratio" : k === "point_diff" ? "point_ratio" : k));
}

const badminton = () => builtinModules.find((m) => m.key === "badminton")!;

function build(): ExampleResult {
  const sport = badminton();
  const cfg = declaredCfgs(sport).find((c) => c.name === startingVariantKey(sport))!.cfg;
  const own = playAndRank({ module: sport, cfg, kind: "league", entrants: PLAYERS, meetings: MEETINGS });
  const swapped = ratioOrder(own.rules.tiebreakers);
  const ratio = playAndRank({ module: sport, cfg, kind: "league", entrants: PLAYERS, meetings: MEETINGS, stageOrder: swapped });
  const lines = (r: typeof own) => r.played.map((p) => `${nameOf(p.meeting.home)} ${p.view.headline} ${nameOf(p.meeting.away)}`);
  if (JSON.stringify(lines(own)) !== JSON.stringify(lines(ratio))) throw new Error("set-ratio-or-difference: the two rankings played different matches");

  const rows = [...own.rows]
    .sort((a, b) => a.rank! - b.rank!)
    .map((r) => [
      nameOf(r.entrantId),
      r.won,
      r.metrics.sets_won ?? 0,
      r.metrics.sets_lost ?? 0,
      derivedText(r, "set_diff", own.layout),
      derivedText(r, "set_ratio", own.layout),
      placeText(r.rank!),
      placeText(rowOf(ratio.rows, r.entrantId).rank!),
    ]);

  const facts: ExampleResult["facts"] = {};
  for (const p of PLAYERS) {
    const r = rowOf(own.rows, p.id);
    facts[`${p.id}SetDifference`] = derivedText(r, "set_diff", own.layout);
    facts[`${p.id}SetRatio`] = derivedText(r, "set_ratio", own.layout);
    facts[`${p.id}PlaceOwn`] = placeText(r.rank!);
    facts[`${p.id}PlaceRatio`] = placeText(rowOf(ratio.rows, p.id).rank!);
  }
  facts.levelWins = rowOf(own.rows, "cy").won;
  facts.cyBeatAna = own.played.find((p) => p.meeting.home === "cy" && p.meeting.away === "ana")!.view.headline;
  facts.ownSplitBy = standingsLabel(rowOf(own.rows, "cy").tieBreak?.key ?? "wins", "badminton");
  facts.ratioSplitBy = standingsLabel(rowOf(ratio.rows, "ana").tieBreak?.key ?? "wins", "badminton");
  const gameSports: string[] = [];
  const setSports: string[] = [];
  const visited = forEachSport(({ module: m }) => {
    const order = stageRules(m, declaredCfgs(m).find((c) => c.name === startingVariantKey(m))!.cfg, "league").tiebreakers;
    facts[`${m.key}Measures`] = measureWords(order, m.key);
    if (m.metrics.some((x) => x.key === "sets_won")) (countsGames(m) ? gameSports : setSports).push(sportLabel(m.key).toLowerCase());
  });
  facts.sportCount = visited;
  // The same step in the sport's own unit (the editor) and in the Standings tab's word, for a game sport.
  facts.gameSports = listOf(gameSports).replace(/^./, (c) => c.toUpperCase());
  facts.setSports = listOf(setSports);
  facts.editorDifference = editorLabel("set_diff", "badminton");
  facts.editorRatio = editorLabel("set_ratio", "badminton");
  facts.standingsDifference = standingsLabel("set_diff", "badminton");
  facts.standingsRatio = standingsLabel("set_ratio", "badminton");
  const result: ExampleResult = { facts, table: { caption: "", columns: COLUMNS, rows }, text: [...lines(own).map((l) => `${l}.`), ...sportLines(facts)] };
  result.table!.caption = captionOf(result);
  return result;
}

/** The table's caption, said from its own cells: nothing the cells can say is typed. */
export function captionOf(r: Pick<ExampleResult, "facts" | "table">): string {
  const rows = r.table?.rows ?? [];
  const level = rows.filter((x) => x[C.won] === r.facts.levelWins).map((x) => String(x[C.player]));
  const at = (col: number, place: number) => rows.find((x) => placeOf(x[col]) === place)?.[C.player];
  return `${listOf(level)} each win ${String(r.facts.levelWins)} matches. Badminton's order puts ${String(at(C.own, 1))} first; the same results ranked by set ratio put ${String(at(C.ratioOrder, 1))} first.`;
}

function sportLines(facts: ExampleResult["facts"]): string[] {
  const out: string[] = [];
  forEachSport(({ module }) => out.push(`${sportLabel(module.key)}: ${String(facts[`${module.key}Measures`])}.`));
  return out;
}

// ---- claims ----

const placeNum = placeOf;
const ratioNum = (v: unknown) => Number(String(v));

/** BWF GCR 16.2, from the cells: wins; two level, their match; three or more, set difference, then two left, their match. */
function bwfPlaces(r: ExampleResult): Map<string, number> | string {
  const rows = r.table?.rows ?? [];
  const beat = scoreOf(r.facts.cyBeatAna);
  if (beat === null) return "no Cy-Ana result";
  const cyBeatAna = beat[0] > beat[1];
  const meeting = (a: string, b: string): number => {
    const pair = new Set([a, b]);
    if (pair.has("Cy") && pair.has("Ana")) return (a === "Cy") === cyBeatAna ? -1 : 1;
    return 0;
  };
  const diff = (x: (string | number)[]) => Number(x[C.setsWon]) - Number(x[C.setsLost]);
  const groups = new Map<number, (string | number)[][]>();
  for (const x of rows) groups.set(Number(x[C.won]), [...(groups.get(Number(x[C.won])) ?? []), x]);
  const out: (string | number)[][] = [];
  for (const w of [...groups.keys()].sort((a, b) => b - a)) {
    const g = groups.get(w)!;
    if (g.length === 2) g.sort((a, b) => meeting(String(a[C.player]), String(b[C.player])));
    else
      g.sort((a, b) => {
        if (diff(a) !== diff(b)) return diff(b) - diff(a);
        return meeting(String(a[C.player]), String(b[C.player]));
      });
    out.push(...g);
  }
  return new Map(out.map((x, i) => [String(x[C.player]), i + 1]));
}

const caseClaims: Claim[] = [
  {
    says: "each set difference cell is sets won minus sets lost, and each set ratio cell sets won over sets lost",
    source: "BWF GCR 16.2.3 (games difference) and the set ratio's definition, over the row's own cells",
    check(r) {
      for (const x of r.table?.rows ?? []) {
        const w = Number(x[C.setsWon]);
        const l = Number(x[C.setsLost]);
        if (Number(String(x[C.diff]).replace("+", "")) !== w - l) return `${String(x[C.player])}: difference cell ${String(x[C.diff])}, sets ${w}-${l}`;
        if (l > 0 && Math.abs(ratioNum(x[C.ratio]) - w / l) > 0.005) return `${String(x[C.player])}: ratio cell ${String(x[C.ratio])}, sets ${w}-${l}`;
      }
      return (r.table?.rows.length ?? 0) === PLAYERS.length || "rows missing";
    },
  },
  {
    says: "three players are level on matches won, and two of them share a set difference but not a set ratio",
    source: "the case's premise, read off the table (what makes the two measures disagree)",
    check(r) {
      const rows = r.table?.rows ?? [];
      const top = rows.filter((x) => x[C.won] === r.facts.levelWins);
      if (top.length !== 3) return `${top.length} players on ${String(r.facts.levelWins)} wins`;
      const cy = rows.find((x) => x[C.player] === "Cy");
      const ana = rows.find((x) => x[C.player] === "Ana");
      if (cy === undefined || ana === undefined) return "Cy or Ana missing";
      if (cy[C.diff] !== ana[C.diff]) return "Cy and Ana differ on set difference";
      return cy[C.ratio] !== ana[C.ratio] || "Cy and Ana share a set ratio";
    },
  },
  {
    says: "badminton's own order is wins, then for two level their match, then set difference (BWF 16.2), and its places are the rulebook's",
    source: "defaultOrderOf(badminton, \"league\") and BWF GCR 16.2, over the table's cells",
    check(r) {
      const declared = defaultOrderOf(badminton(), "league");
      if (declared[0] !== "wins" || declared[1] !== "h2h_two" || declared[2] !== "set_diff") return `badminton declares [${declared.join(", ")}]`;
      const want = bwfPlaces(r);
      if (typeof want === "string") return want;
      for (const x of r.table?.rows ?? []) if (placeNum(x[C.own]) !== want.get(String(x[C.player]))) return `${String(x[C.player])}: ${String(x[C.own])}, BWF gives ${want.get(String(x[C.player]))}`;
      return true;
    },
  },
  {
    says: "with ratios in place of differences, the three level players rank by set ratio, and someone else is first (class 19)",
    source: "the set ratio's definition over the table's cells",
    check(r) {
      const rows = r.table?.rows ?? [];
      const level = rows.filter((x) => x[C.won] === r.facts.levelWins);
      const byRatio = [...level].sort((a, b) => Number(b[C.setsWon]) / Number(b[C.setsLost]) - Number(a[C.setsWon]) / Number(a[C.setsLost]));
      for (const [i, x] of byRatio.entries()) if (placeNum(x[C.ratioOrder]) !== i + 1) return `${String(x[C.player])}: ${String(x[C.ratioOrder])}, the ratio gives ${i + 1}`;
      const firstOwn = rows.find((x) => placeNum(x[C.own]) === 1)?.[C.player];
      const firstRatio = rows.find((x) => placeNum(x[C.ratioOrder]) === 1)?.[C.player];
      return firstOwn !== firstRatio || `both orders put ${String(firstOwn)} first`;
    },
  },
];

function sportClaim(module: AnySportModule): Claim {
  return {
    says: `${sportLabel(module.key)}: the measures fact names the measures of the sport's declared league order, in order`,
    source: "defaultOrderOf(module, \"league\")",
    sport: module.key,
    check(r) {
      const want = measureWords(defaultOrderOf(module, "league"), module.key);
      return r.facts[`${module.key}Measures`] === want || `fact '${String(r.facts[`${module.key}Measures`])}', declared '${want}'`;
    },
  };
}

const DICT = ui as Record<string, string>;

const wordClaims: Claim[] = [
  {
    says: "neither place column lists the players in alphabetical order (a claim that an alphabetical sort would also pass tells nothing about the order)",
    source: "ordering test, class 19: the sort key must be perturbed against a plausible wrong one",
    check(r) {
      const rows = r.table?.rows ?? [];
      if (rows.length < 3) return `${rows.length} rows`;
      for (const col of [C.own, C.ratioOrder]) {
        const byPlace = [...rows].sort((a, b) => placeOf(a[col]) - placeOf(b[col])).map((x) => String(x[C.player]));
        if (JSON.stringify(byPlace) === JSON.stringify([...byPlace].sort())) return `the ${COLUMNS[col]} column is alphabetical (${byPlace.join(", ")})`;
      }
      return true;
    },
  },
  {
    says: "the caption is the one said from the table's own cells and the facts",
    source: "the table's cells and the example's facts (nothing in it is typed)",
    check(r) {
      const want = captionOf(r);
      return r.table?.caption === want || `caption is '${String(r.table?.caption)}', the cells give '${want}'`;
    },
  },
  {
    says: "the table's set ledger columns say what badminton's own table says (Games won, Games lost), its measure columns the Standings words",
    source: "badminton's declared metrics (sets_won, sets_lost labels) and the dictionary's div.detail.tiebreak.rule.set_diff / set_ratio",
    check(r) {
      const metrics = badminton().metrics;
      const cols = r.table?.columns ?? [];
      const won = metrics.find((x) => x.key === "sets_won")?.label;
      const lost = metrics.find((x) => x.key === "sets_lost")?.label;
      if (cols[C.setsWon] !== won || cols[C.setsLost] !== lost) return `columns '${String(cols[C.setsWon])}' / '${String(cols[C.setsLost])}', the module declares '${String(won)}' / '${String(lost)}'`;
      const diff = DICT["div.detail.tiebreak.rule.set_diff"] ?? "";
      const ratio = DICT["div.detail.tiebreak.rule.set_ratio"] ?? "";
      if (cols[C.diff] !== diff.charAt(0).toUpperCase() + diff.slice(1)) return `difference column '${String(cols[C.diff])}', the Standings words say '${diff}'`;
      return cols[C.ratio] === ratio.charAt(0).toUpperCase() + ratio.slice(1) || `ratio column '${String(cols[C.ratio])}', the Standings words say '${ratio}'`;
    },
  },
  {
    says: "badminton, table tennis and carrom count games where volleyball and tennis count sets: the editor says game difference and game ratio for the former, the Standings tab says set difference and set ratio for every set sport",
    source: "each module's declared set ledger label (Games won / Sets won) and the dictionary: div.detail.tiebreak.rule.set_diff and set_ratio (the Standings words), their .<sport> variants (the editor's unit words)",
    check(r) {
      const games: string[] = [];
      const sets: string[] = [];
      const visited = forEachSport(({ module }) => {
        const label = module.metrics.find((x) => x.key === "sets_won")?.label;
        if (label === undefined) return;
        const word = label.split(" ")[0]!.toLowerCase();
        if (word === "games") games.push(module.key);
        else if (word === "sets") sets.push(module.key);
        else throw new Error(`${module.key}: a set ledger labelled '${label}'`);
        // The editor's variant exists exactly for the games sports, and reads "game ...".
        const variant = DICT[`div.detail.tiebreak.rule.set_diff.${module.key}`];
        if (word === "games" && !(typeof variant === "string" && variant.startsWith("game"))) throw new Error(`${module.key}: no 'game ...' editor label`);
        if (word === "sets" && variant !== undefined) throw new Error(`${module.key}: an editor label for a sport that counts sets`);
      });
      if (visited === 0 || games.length === 0 || sets.length === 0) return `registry ${visited}, ${games.length} game sports, ${sets.length} set sports`;
      const name = (keys: string[]) => keys.map((k) => sportLabel(k).toLowerCase());
      const upper = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
      if (r.facts.gameSports !== upper(listOf(name(games)))) return `gameSports '${String(r.facts.gameSports)}', declared '${upper(listOf(name(games)))}'`;
      if (r.facts.setSports !== listOf(name(sets))) return `setSports '${String(r.facts.setSports)}', declared '${listOf(name(sets))}'`;
      if (r.facts.editorDifference !== DICT["div.detail.tiebreak.rule.set_diff.badminton"]) return `editorDifference '${String(r.facts.editorDifference)}'`;
      if (r.facts.editorRatio !== DICT["div.detail.tiebreak.rule.set_ratio.badminton"]) return `editorRatio '${String(r.facts.editorRatio)}'`;
      if (r.facts.standingsDifference !== DICT["div.detail.tiebreak.rule.set_diff"]) return `standingsDifference '${String(r.facts.standingsDifference)}'`;
      if (r.facts.standingsRatio !== DICT["div.detail.tiebreak.rule.set_ratio"]) return `standingsRatio '${String(r.facts.standingsRatio)}'`;
      // Class 19: the two screens' words differ, or the sentence that says which screen says what has nothing to say.
      return r.facts.editorDifference !== r.facts.standingsDifference && r.facts.editorRatio !== r.facts.standingsRatio || "the editor and the Standings tab say the same words";
    },
  },
];

const claims: Claim[] = [
  ...caseClaims,
  ...wordClaims,
  factsRepeatTheTable(PLAYERS, C.player, { SetDifference: C.diff, SetRatio: C.ratio, PlaceOwn: C.own, PlaceRatio: C.ratioOrder }),
  {
    says: "Cy and Ana are split by their match under badminton's order, and by set ratio once ratios replace differences",
    source: "defaultOrderOf(badminton, \"league\") (head-to-head between the two) and set ratio's place in the swapped order",
    check(r) {
      if (r.facts.ownSplitBy !== standingsLabel("h2h_two", "badminton")) return `ownSplitBy ${String(r.facts.ownSplitBy)}`;
      return r.facts.ratioSplitBy === standingsLabel("set_ratio", "badminton") || `ratioSplitBy ${String(r.facts.ratioSplitBy)}`;
    },
  },
  {
    says: "the per-sport measures cover the whole registry, and count it",
    source: "the sport registry (forEachSport)",
    check(r) {
      const visited = forEachSport(() => {});
      return r.facts.sportCount === visited || `sportCount ${String(r.facts.sportCount)}, registry ${visited}`;
    },
  },
];
if (forEachSport(({ module }) => claims.push(sportClaim(module))) === 0) throw new Error("set-ratio-or-difference: the sport registry is empty");

export const setRatioOrDifference: BlogExample = {
  id: SET_RATIO_OR_DIFFERENCE_ID,
  kind: "engine",
  sports: "all",
  build,
  claims,
};
