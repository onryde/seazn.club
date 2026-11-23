// Post #11, "What are Buchholz and Sonneborn-Berger, and why do they decide Swiss ties?".
//
// THE TABLE, chess: six players play three Swiss rounds (the variant a new chess division starts on; the pairings are the
// fixture, every game is a real one: a seeded walk refolded by the app's read fold). Three players finish on the same
// points. Ranked through the app's ranking path for a Swiss stage (`toTableStage` builds the Swiss ledger's inputs, the
// engine's `completeTableStage` ranks), Buchholz Cut-1 lifts the one who met the strongest field, and Sonneborn-Berger
// separates the two who are level on both Buchholz figures. The tie-break cells are the public table's own text
// (`derivedText` on a Swiss layout, which spells them in the table's half points).
//
// THE FACTS, every sport: the order its Swiss stage ranks by after points (the per-sport block of the post).
//
// WHAT CHECKS IT. FIDE C.07 (2026) recomputed from the table's own cells: Buchholz is the sum of the opponents' scores;
// Cut-1 drops the lowest of them; Sonneborn-Berger adds the scores of the opponents beaten and half the scores of those
// drawn with. The places follow chess's DECLARED Swiss order (`defaultOrderOf`), and so do the per-sport facts.
import { resultColumnText } from "@seazn/engine/competition";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule } from "@seazn/engine/sport";
import { declaredCfgs, defaultOrderOf, forEachSport } from "@seazn/engine/testkit";
import { sportLabel } from "@/blog/labels";
import { standingsLabel } from "@/blog/labels-screens";
import { derivedText } from "@/server/public-site/standings-view";
import { startingVariantKey } from "./starting-variant";
import { factsRepeatTheTable, placeOf, placeText, playAndRank, rowOf, stageRules, type MatchView, type Meeting } from "./tie-break-play";
import type { BlogExample, Claim, ExampleResult } from "./types";

export const BUCHHOLZ_SONNEBORN_BERGER_ID = "buchholz-sonneborn-berger";

export const COLUMNS = ["Player", "Points", "Games", "Buchholz Cut-1", "Buchholz", "Sonneborn–Berger", "Place", "Separated by"];
export const C = { player: 0, points: 1, games: 2, cut1: 3, buchholz: 4, sb: 5, place: 6, by: 7 } as const;

const PLAYERS = [
  { id: "ana", name: "Ana" },
  { id: "ben", name: "Ben" },
  { id: "cy", name: "Cy" },
  { id: "dev", name: "Dev" },
  { id: "eve", name: "Eve" },
  { id: "fay", name: "Fay" },
];
const nameOf = (id: string) => PLAYERS.find((p) => p.id === id)!.name;
const homeWins = (v: MatchView) => v.outcome.kind === "win" && v.outcome.winner === v.home.entrantId;
const drawn = (v: MatchView) => v.outcome.kind === "draw";

/** Three rounds, three boards a round. Every player meets three others; nobody meets anyone twice. */
const MEETINGS: Meeting[] = [
  { round: 1, home: "ana", away: "dev", what: "round 1: Ana draws with Dev", seed: 2, want: drawn },
  { round: 1, home: "ben", away: "eve", what: "round 1: Ben beats Eve", seed: 5, want: homeWins },
  { round: 1, home: "cy", away: "fay", what: "round 1: Cy draws with Fay", seed: 2, want: drawn },
  { round: 2, home: "ana", away: "cy", what: "round 2: Ana draws with Cy", seed: 2, want: drawn },
  { round: 2, home: "ben", away: "fay", what: "round 2: Ben beats Fay", seed: 5, want: homeWins },
  { round: 2, home: "dev", away: "eve", what: "round 2: Dev beats Eve", seed: 5, want: homeWins },
  { round: 3, home: "ana", away: "ben", what: "round 3: Ana beats Ben", seed: 5, want: homeWins },
  { round: 3, home: "cy", away: "eve", what: "round 3: Cy beats Eve", seed: 5, want: homeWins },
  { round: 3, home: "dev", away: "fay", what: "round 3: Dev beats Fay", seed: 5, want: homeWins },
];
const ROUNDS = 3;

const chess = () => builtinModules.find((m) => m.key === "boardgame")!;

/** "2½" / "½" / "3" as a number. */
export function halves(text: unknown): number {
  const s = String(text);
  const half = s.endsWith("½") ? 0.5 : 0;
  const whole = s.replace("½", "");
  return (whole === "" ? 0 : Number(whole)) + half;
}

function gamesText(id: string, played: ReturnType<typeof playAndRank>["played"]): string {
  return played
    .filter((p) => p.meeting.home === id || p.meeting.away === id)
    .sort((a, b) => (a.meeting.round ?? 0) - (b.meeting.round ?? 0))
    .map((p) => {
      const opp = nameOf(p.meeting.home === id ? p.meeting.away : p.meeting.home);
      const o = p.view.outcome;
      if (o.kind === "draw") return `drew with ${opp}`;
      return o.kind === "win" && o.winner === id ? `beat ${opp}` : `lost to ${opp}`;
    })
    .join(", ");
}

function build(): ExampleResult {
  const sport = chess();
  const cfg = declaredCfgs(sport).find((c) => c.name === startingVariantKey(sport))!.cfg;
  const ranked = playAndRank({ module: sport, cfg, kind: "swiss", entrants: PLAYERS, meetings: MEETINGS, rounds: ROUNDS });
  const L = ranked.layout;
  const rows = [...ranked.rows]
    .sort((a, b) => a.rank! - b.rank!)
    .map((r) => [
      nameOf(r.entrantId),
      resultColumnText(r, "points", L),
      gamesText(r.entrantId, ranked.played),
      derivedText(r, "buchholz_cut1", L),
      derivedText(r, "buchholz", L),
      derivedText(r, "sberger", L),
      placeText(r.rank!),
      r.tieBreak === undefined ? "Points" : standingsLabel(r.tieBreak.key, "boardgame"),
    ]);
  const facts: ExampleResult["facts"] = {};
  for (const p of PLAYERS) {
    const r = rowOf(ranked.rows, p.id);
    facts[`${p.id}Points`] = resultColumnText(r, "points", L);
    facts[`${p.id}Cut1`] = derivedText(r, "buchholz_cut1", L);
    facts[`${p.id}Buchholz`] = derivedText(r, "buchholz", L);
    facts[`${p.id}SonnebornBerger`] = derivedText(r, "sberger", L);
    facts[`${p.id}Place`] = placeText(r.rank!);
    facts[`${p.id}Games`] = gamesText(p.id, ranked.played);
  }
  facts.rounds = ROUNDS;
  facts.players = PLAYERS.length;
  const visited = forEachSport(({ module: m }) => {
    const order = stageRules(m, declaredCfgs(m).find((c) => c.name === startingVariantKey(m))!.cfg, "swiss").tiebreakers;
    facts[`${m.key}SwissOrder`] = order.slice(1).map((k) => standingsLabel(k, m.key)).join(", ");
  });
  facts.sportCount = visited;
  const result: ExampleResult = {
    facts,
    table: { caption: "", columns: COLUMNS, rows },
    text: [
      ...ranked.played.map((p) => `Round ${p.meeting.round}: ${nameOf(p.meeting.home)} ${p.view.headline} ${nameOf(p.meeting.away)}.`),
      ...(() => {
        const out: string[] = [];
        forEachSport(({ module: m }) => out.push(`${sportLabel(m.key)}, Swiss: ${String(facts[`${m.key}SwissOrder`])}.`));
        return out;
      })(),
    ],
  };
  result.table!.caption = captionOf(result);
  return result;
}

/** The caption, said from the table's own cells: the group on the same points and the steps that split it. */
export function captionOf(r: Pick<ExampleResult, "facts" | "table">): string {
  const rows = [...(r.table?.rows ?? [])].sort((a, b) => placeOf(a[C.place]) - placeOf(b[C.place]));
  const byPoints = new Map<number, (string | number)[][]>();
  for (const x of rows) byPoints.set(halves(x[C.points]), [...(byPoints.get(halves(x[C.points])) ?? []), x]);
  const group = [...byPoints.values()].sort((a, b) => b.length - a.length)[0] ?? [];
  const names = group.map((x) => String(x[C.player]));
  const steps = [...new Set(group.map((x) => String(x[C.by])).filter((b) => b !== "Points"))];
  return `${String(r.facts.players)} players after ${String(r.facts.rounds)} Swiss rounds. ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} finish level on ${String(group[0]?.[C.points])} points, and ${steps.join(" and ")} put them in that order.`;
}

// ---- claims: FIDE C.07 (2026), from the table's own cells ----

interface Game {
  opp: string;
  result: "won" | "drew" | "lost";
}
function gamesOf(x: (string | number)[]): Game[] {
  return String(x[C.games])
    .split(", ")
    .map((g): Game => {
      const m = g.match(/^(beat|drew with|lost to) (.+)$/);
      if (m === null) throw new Error(`a game reads '${g}'`);
      return { opp: m[2]!, result: m[1] === "beat" ? "won" : m[1] === "drew with" ? "drew" : "lost" };
    });
}

function fideFigures(r: ExampleResult): Map<string, { points: number; cut1: number; buchholz: number; sb: number }> {
  const rows = r.table?.rows ?? [];
  const points = new Map(rows.map((x) => [String(x[C.player]), halves(x[C.points])]));
  const out = new Map<string, { points: number; cut1: number; buchholz: number; sb: number }>();
  for (const x of rows) {
    const games = gamesOf(x);
    const opps = games.map((g) => points.get(g.opp) ?? Number.NaN);
    const buchholz = opps.reduce((a, b) => a + b, 0);
    const cut1 = buchholz - Math.min(...opps);
    const sb = games.reduce((a, g, i) => a + (g.result === "won" ? opps[i]! : g.result === "drew" ? opps[i]! / 2 : 0), 0);
    out.set(String(x[C.player]), { points: points.get(String(x[C.player]))!, cut1, buchholz, sb });
  }
  return out;
}

const caseClaims: Claim[] = [
  {
    says: "each player's points are their games: a win 1, a draw ½, a loss 0",
    source: "FIDE Laws of Chess (the game score) and chess's declared half-point table",
    check(r) {
      for (const x of r.table?.rows ?? []) {
        const want = gamesOf(x).reduce((a, g) => a + (g.result === "won" ? 1 : g.result === "drew" ? 0.5 : 0), 0);
        if (halves(x[C.points]) !== want) return `${String(x[C.player])}: ${String(x[C.points])} points, the games give ${want}`;
      }
      return (r.table?.rows.length ?? 0) === PLAYERS.length || "rows missing";
    },
  },
  {
    says: "every Buchholz, Buchholz Cut-1 and Sonneborn–Berger cell is FIDE's figure",
    source: "FIDE C.07 (2026) tie-break regulations (Buchholz, Buchholz Cut-1, Sonneborn–Berger), as the tie-break code's header cites them, over the table's cells",
    check(r) {
      const fide = fideFigures(r);
      for (const x of r.table?.rows ?? []) {
        const f = fide.get(String(x[C.player]))!;
        if (halves(x[C.buchholz]) !== f.buchholz) return `${String(x[C.player])}: Buchholz ${String(x[C.buchholz])}, FIDE gives ${f.buchholz}`;
        if (halves(x[C.cut1]) !== f.cut1) return `${String(x[C.player])}: Cut-1 ${String(x[C.cut1])}, FIDE gives ${f.cut1}`;
        const sb = String(x[C.sb]).includes(".") ? Number(x[C.sb]) : halves(x[C.sb]);
        if (Math.abs(sb - f.sb) > 1e-9) return `${String(x[C.player])}: Sonneborn–Berger ${String(x[C.sb])}, FIDE gives ${f.sb}`;
      }
      return true;
    },
  },
  {
    says: "the places follow chess's declared Swiss order: points, Buchholz Cut-1, Buchholz, Sonneborn–Berger",
    source: "defaultOrderOf(boardgame, \"swiss\")",
    check(r) {
      const declared = defaultOrderOf(chess(), "swiss");
      if (declared.slice(0, 4).join() !== "points,buchholz_cut1,buchholz,sberger") return `chess's Swiss order is [${declared.join(", ")}]`;
      const fide = fideFigures(r);
      const names = [...fide.keys()];
      names.sort((a, b) => {
        const x = fide.get(a)!;
        const y = fide.get(b)!;
        return y.points - x.points || y.cut1 - x.cut1 || y.buchholz - x.buchholz || y.sb - x.sb;
      });
      for (const x of r.table?.rows ?? []) {
        const want = names.indexOf(String(x[C.player])) + 1;
        if (placeOf(x[C.place]) !== want) return `${String(x[C.player])}: ${String(x[C.place])}, the order gives ${want}`;
      }
      return true;
    },
  },
  {
    says: "three players share a score; Cut-1 separates one of them, and two are level on both Buchholz figures and split by Sonneborn–Berger",
    source: "the case's premise (each of the three ladders decides something), read off the table",
    check(r) {
      const fide = fideFigures(r);
      const byScore = new Map<number, string[]>();
      for (const [n, f] of fide) byScore.set(f.points, [...(byScore.get(f.points) ?? []), n]);
      const three = [...byScore.values()].find((g) => g.length === 3);
      if (three === undefined) return "no three players share a score";
      const cut1s = three.map((n) => fide.get(n)!.cut1);
      const top = Math.max(...cut1s);
      const rest = three.filter((n) => fide.get(n)!.cut1 !== top);
      if (rest.length !== 2) return "Cut-1 does not separate exactly one of the three";
      const [a, b] = rest.map((n) => fide.get(n)!);
      if (a!.cut1 !== b!.cut1 || a!.buchholz !== b!.buchholz) return "the other two differ on Buchholz";
      return a!.sb !== b!.sb || "the other two share a Sonneborn–Berger";
    },
  },
];

function sportClaim(module: AnySportModule): Claim {
  return {
    says: `${sportLabel(module.key)}: the Swiss order fact is the sport's declared Swiss order after points`,
    source: "defaultOrderOf(module, \"swiss\")",
    sport: module.key,
    check(r) {
      const want = defaultOrderOf(module, "swiss").slice(1).map((k) => standingsLabel(k, module.key)).join(", ");
      return r.facts[`${module.key}SwissOrder`] === want || `fact '${String(r.facts[`${module.key}SwissOrder`])}', declared '${want}'`;
    },
  };
}

/** The first of chess's Swiss steps after points on which two rows differ, as the table labels it. */
function firstDifference(a: (string | number)[], b: (string | number)[]): string | null {
  const sb = (x: (string | number)[]) => (String(x[C.sb]).includes(".") ? Number(x[C.sb]) : halves(x[C.sb]));
  if (halves(a[C.cut1]) !== halves(b[C.cut1])) return standingsLabel("buchholz_cut1", "boardgame");
  if (halves(a[C.buchholz]) !== halves(b[C.buchholz])) return standingsLabel("buchholz", "boardgame");
  if (sb(a) !== sb(b)) return standingsLabel("sberger", "boardgame");
  return null;
}

/** The separated-by column, from the cells: shared with the bye example, whose table has the same columns. */
export const separatedByClaim: Claim = {
  says: "the separated-by column names the first step, after points, on which a player differs from the level player below them (the last of a group: above)",
  source: "defaultOrderOf(boardgame, \"swiss\") over the table's cells (a player alone on their points is separated by points)",
  check(r) {
    const rows = [...(r.table?.rows ?? [])].sort((a, b) => placeOf(a[C.place]) - placeOf(b[C.place]));
    for (const [i, x] of rows.entries()) {
      const level = rows.filter((y) => y !== x && halves(y[C.points]) === halves(x[C.points]));
      if (level.length === 0) {
        if (x[C.by] !== "Points") return `${String(x[C.player])}: separated by ${String(x[C.by])}, alone on their points`;
        continue;
      }
      // Against the level player just below (or, for the last of the group, just above).
      const next = rows[i + 1] !== undefined && level.includes(rows[i + 1]!) ? rows[i + 1]! : rows[i - 1]!;
      const want = firstDifference(x, next);
      if (x[C.by] !== want) return `${String(x[C.player])}: separated by ${String(x[C.by])}, the cells give ${String(want)}`;
    }
    return rows.length > 0 || "no rows";
  },
};

const claims: Claim[] = [
  ...caseClaims,
  factsRepeatTheTable(PLAYERS, C.player, { Points: C.points, Cut1: C.cut1, Buchholz: C.buchholz, SonnebornBerger: C.sb, Place: C.place, Games: C.games }),
  separatedByClaim,
  {
    says: "the caption is the one said from the table's own cells and the facts",
    source: "the table's cells and the example's facts (nothing in it is typed)",
    check(r) {
      const want = captionOf(r);
      return r.table?.caption === want || `caption is '${String(r.table?.caption)}', the cells give '${want}'`;
    },
  },
  {
    says: "six players, three rounds: every player has one game a round",
    source: "the fixture's three rounds of three boards",
    check(r) {
      const rows = r.table?.rows ?? [];
      if (r.facts.players !== rows.length) return `players ${String(r.facts.players)}, rows ${rows.length}`;
      for (const x of rows) if (gamesOf(x).length !== r.facts.rounds) return `${String(x[C.player])} has ${gamesOf(x).length} games, rounds is ${String(r.facts.rounds)}`;
      return true;
    },
  },
  {
    says: "the per-sport Swiss orders cover the whole registry, and count it",
    source: "the sport registry (forEachSport)",
    check(r) {
      const visited = forEachSport(() => {});
      return r.facts.sportCount === visited || `sportCount ${String(r.facts.sportCount)}, registry ${visited}`;
    },
  },
];
if (forEachSport(({ module }) => claims.push(sportClaim(module))) === 0) throw new Error("buchholz-sonneborn-berger: the sport registry is empty");

export const buchholzSonnebornBerger: BlogExample = {
  id: BUCHHOLZ_SONNEBORN_BERGER_ID,
  kind: "engine",
  sports: "all",
  build,
  claims,
};
