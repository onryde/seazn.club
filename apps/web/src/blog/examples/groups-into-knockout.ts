// Post #29, "How do teams go from the groups into the knockout?". Nine football teams are dealt into three groups by the app's own
// draw (`seededSnake`, the call Generate makes), play their group matches through the engine's event stream, and are folded as a
// pooled stage (`playGroups`). The top two of each group go through: the app's own template (`buildTemplateStages("groups_ko")`)
// says so, the app's resolver (`resolveStoredProgression`) seats the six qualifiers, and the app's cross-pool draw
// (`drawAcrossPools`, the call the seed proposal makes) re-seats them so that nobody meets their own group in round one. The
// bracket's first round is then read off the engine's own seed positions (`seedPositions`, the geometry the draw's TBD lines hold).
//
// WHAT CHECKS IT. The claims hold the printed table to the rules, never to the code that built it: the snake deal (seeds 1..N
// along the groups, then N..1), the order of the seats (every group's winner, then every runner-up; within a rank, by points and
// then goal difference, football's declared first two keys), standard knockout seeding (1 v 8, 4 v 5, 3 v 6, 2 v 7), and the
// engine's declared draw rule (tier one keeps its place; the later tier is tried in table order and the first arrangement with no
// pool meeting itself is taken). A second field, four groups of two qualifiers, is reported as facts.
import { builtinModules } from "@seazn/engine/sports";
import { declaredCfgs, defaultOrderOf, forEachSport } from "@seazn/engine/testkit";
import { expandSources, placeDescriptors, type ProgressionSpec, type SourceShape, type SourceTables } from "@seazn/engine/competition";
import { crossPoolDraw, nextPowerOfTwo, seedPositions } from "@seazn/engine/scheduling";
import { buildTemplateStages } from "@/lib/format-templates";
import { CROSS_POOL_SHAPES, pooledSeeds } from "@/lib/cross-pool-ties";
import { resolveStoredProgression } from "@/server/usecases/stored-progression";
import { seededSnake } from "@/server/usecases/stages/generators";
import { playGroups } from "./group-play";
import { declaredLeaguePoints } from "./kit";
import { startingVariantKey } from "./starting-variant";
import { placeText, type Meeting, type MatchView } from "./tie-break-play";
import { capitalised, col, guarded, numberWord, offeredInEverySportClaim } from "./swiss-claims";
import type { BlogExample, Claim, ExampleResult } from "./types";

export const GROUPS_INTO_KNOCKOUT_ID = "groups-into-knockout";

/** Best seed first: the order the organiser signed the teams up in. */
const TEAMS = ["Hawks", "Rockets", "Comets", "Dynamos", "Wolves", "Tigers", "Lions", "Bears", "Foxes"] as const;
const GROUPS = 3;
const ADVANCE = 2;
const idOf = (name: string) => name.toLowerCase();
const nameOfId = (id: string) => TEAMS.find((t) => idOf(t) === id) ?? id;
const goals = (h: number, a: number) => (v: MatchView) => v.home.metrics.gf === h && v.away.metrics.gf === a;
const poolName = (key: string) => `Group ${key}`;

/** The group matches, home side first. Each group's winner beats both; the runner-up beats the third team. The margins are chosen so the
 *  three winners finish A, B, C on goal difference and so do the three runners-up: Group C is the weakest of its rank, twice. */
const SCORES: { home: string; away: string; h: number; a: number; seed: number }[] = [
  { home: "hawks", away: "tigers", h: 1, a: 0, seed: 5 },
  { home: "hawks", away: "lions", h: 3, a: 0, seed: 202 },
  { home: "tigers", away: "lions", h: 3, a: 0, seed: 202 },
  { home: "rockets", away: "wolves", h: 1, a: 0, seed: 5 },
  { home: "rockets", away: "bears", h: 2, a: 0, seed: 95 },
  { home: "wolves", away: "bears", h: 2, a: 0, seed: 95 },
  { home: "comets", away: "dynamos", h: 1, a: 0, seed: 5 },
  { home: "comets", away: "foxes", h: 1, a: 0, seed: 5 },
  { home: "dynamos", away: "foxes", h: 1, a: 0, seed: 5 },
];

const football = () => builtinModules.find((m) => m.key === "football")!;
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

/** The first round of an `n`-seat knockout as seed pairs, read off the engine's own seed positions (`seedPositions`, line by line, the
 *  better seed first). */
function roundOne(n: number): [number, number][] {
  const positions = seedPositions(nextPowerOfTwo(n));
  const out: [number, number][] = [];
  for (let i = 0; i < positions.length; i += 2) out.push([Math.min(positions[i]!, positions[i + 1]!), Math.max(positions[i]!, positions[i + 1]!)]);
  return out;
}

function build(): ExampleResult {
  const sport = football();
  const variant = startingVariantKey(sport);
  const cfg = declaredCfgs(sport).find((c) => c.name === variant)?.cfg;
  if (cfg === undefined) throw new Error(`groups-into-knockout: football has no declared variant '${variant}'`);
  const entrants = TEAMS.map((name, i) => ({ id: idOf(name), name, seed: i + 1 }));
  const dealt = seededSnake(entrants.map((e) => ({ ...e, swiss_first_round: null })), GROUPS);
  const pools = new Map(dealt.map((members, i) => ["ABCDEFGHIJKLMNOPQRSTUVWXYZ"[i]!, members.map((m) => m.id)] as const));
  const meetings: Meeting[] = SCORES.map((s) => ({ home: s.home, away: s.away, what: `${nameOfId(s.home)} ${s.h}-${s.a} ${nameOfId(s.away)}`, want: goals(s.h, s.a), ...(s.seed > 0 ? { seed: s.seed } : {}) }));
  const played = playGroups({ module: sport, cfg, entrants, pools, meetings });

  // The seats: the app's template (the qualifier count and the cut), the app's resolver, the app's draw.
  const stages = buildTemplateStages("groups_ko", { qualified: GROUPS * ADVANCE, swissRounds: 5, poolCount: GROUPS, legs: 1 });
  const progression = stages[1]!.progression as unknown as ProgressionSpec;
  const shape: SourceShape = { poolKeys: [...pools.keys()] };
  const resolved = resolveStoredProgression(progression, [shape], [played.tables], "knockout", ["group"]);
  const byTable = resolved.qualifiers.map((q) => ({ id: q.entrantId, pool: q.pool ?? "", tableSeed: q.seed, descriptor: q.descriptor }));
  const drawnSeed = drawAcross(resolved.qualifiers, played.tables);
  const finished = (id: string, pool: string) => {
    const row = played.rows.get(pool)!.find((r) => r.entrantId === id)!;
    return { rank: row.rank!, points: row.points, diff: row.metrics.gd ?? 0 };
  };
  const qualifiers = byTable.map((q) => ({ ...q, seed: drawnSeed.get(q.id)!, ...finished(q.id, q.pool) })).sort((a, b) => a.seed - b.seed);
  const n = qualifiers.length;
  const bySeed = new Map(qualifiers.map((q) => [q.seed, q]));
  const opponentOf = (seed: number): string => {
    const m = roundOne(n).find(([a, b]) => a === seed || b === seed)!;
    const other = m[0] === seed ? m[1] : m[0];
    return other > n ? "Straight through" : `v ${nameOfId(bySeed.get(other)!.id)}`;
  };
  const rows = qualifiers.map((q) => [nameOfId(q.id), `${placeText(q.rank)} in ${poolName(q.pool)}: ${q.points} points, ${signed(q.diff)}`, q.tableSeed, q.seed, opponentOf(q.seed)]);

  // The pairing the table's own order gave, and what it would have paired within one group.
  const tableMatches = roundOne(n).filter(([a, b]) => a <= n && b <= n).map(([a, b]) => [byTable.find((q) => q.tableSeed === a)!, byTable.find((q) => q.tableSeed === b)!] as const);
  const clash = tableMatches.find(([a, b]) => a.pool === b.pool);
  if (clash === undefined) throw new Error("groups-into-knockout: the example's table order does not clash, so it shows nothing");
  const drawnMatches = roundOne(n).filter(([a, b]) => a <= n && b <= n).map(([a, b]) => `${nameOfId(bySeed.get(a)!.id)} v ${nameOfId(bySeed.get(b)!.id)}`);
  const sortedByTable = [...byTable].sort((a, b) => a.tableSeed - b.tableSeed);
  const straight = qualifiers.filter((q) => roundOne(n).some(([a, b]) => (a === q.seed && b > n) || (b === q.seed && a > n))).map((q) => nameOfId(q.id));
  const four = fourGroups();
  const groupsDiagram = [...pools.keys()].map((key) => ({
    name: poolName(key),
    entrants: played.rows.get(key)!.map((r) => nameOfId(r.entrantId)),
    advancing: ADVANCE,
  }));
  return {
    facts: {
      teams: TEAMS.length,
      groupCount: GROUPS,
      groupSize: TEAMS.length / GROUPS,
      advance: ADVANCE,
      qualifiers: n,
      bracketSize: nextPowerOfTwo(n),
      byes: nextPowerOfTwo(n) - n,
      signUpOrder: TEAMS.join(", "),
      straightThrough: straight.join(" and "),
      tableOrderMatch: `${nameOfId(clash[0].id)} v ${nameOfId(clash[1].id)}`,
      tableOrderClashGroup: poolName(clash[0].pool),
      drawnMatches: drawnMatches.join(", "),
      movedUp: sortedByTable.filter((q) => drawnSeed.get(q.id)! < q.tableSeed).map((q) => nameOfId(q.id)).join(", "),
      movedDown: sortedByTable.filter((q) => drawnSeed.get(q.id)! > q.tableSeed).map((q) => nameOfId(q.id)).join(", "),
      fourGroupsQualified: four.qualified,
      fourGroupsRoundOne: four.pairs.join(", "),
      fourGroupsSamePool: four.samePool,
      sportCount: forEachSport(() => undefined),
    },
    table: {
      caption: `${capitalised(numberWord(GROUPS))} groups of ${numberWord(TEAMS.length / GROUPS)}, ${numberWord(ADVANCE)} from each go through. The table's own order would have put ${nameOfId(clash[0].id)} against ${nameOfId(clash[1].id)} in round one, two teams from ${poolName(clash[0].pool)}, so the draw moves the runners-up.`,
      columns: ["Team", "Finished", "Seed by the table", "Seed after the draw", "Round one"],
      rows,
    },
    diagram: {
      kind: "groupsToBracket",
      title: `${capitalised(numberWord(GROUPS))} groups of ${numberWord(TEAMS.length / GROUPS)}, the top ${numberWord(ADVANCE)} of each go through. The best ${numberWord(nextPowerOfTwo(n) - n)} group winners are straight through to the next round, and nobody meets a team from their own group in round one.`,
      groups: groupsDiagram,
      bracket: [
        {
          name: "Round one",
          matches: roundOne(n).map(([a, b]) => ({ home: nameOfId(bySeed.get(a)!.id), away: b > n ? null : nameOfId(bySeed.get(b)!.id) })),
        },
      ],
    },
    text: [...played.played.map((p) => `${nameOfId(p.meeting.home)} ${p.view.headline} ${nameOfId(p.meeting.away)}.`)],
  };
}

/** The app's cross-pool draw over the resolver's seats: its pure halves, `pooledSeeds` (the engine's input, built from the seats and the
 *  source tables) and the engine's `crossPoolDraw` with the destination's draw seed, then each qualifier's new seed is its place in the
 *  returned order - what `drawAcrossPools` does after its database read of a missing seed and its pre-search refusal. */
function drawAcross(qualifiers: readonly { entrantId: string; seed: number; sourceIndex: number; descriptor: { kind: string; rank?: number; nth?: number }; pool?: string; basis?: { levelWith: readonly string[] } }[], tables: SourceTables): Map<string, number> {
  const ordered = [...qualifiers].sort((a, b) => a.seed - b.seed);
  const seeded = pooledSeeds(ordered, [tables]);
  if (seeded === null) throw new Error("groups-into-knockout: the field is not a pooled one");
  const order = crossPoolDraw(seeded, CROSS_POOL_SHAPES.knockout!, DRAW_SEED).order;
  return new Map(order.map((id, i) => [id, i + 1] as const));
}
const DRAW_SEED = 7;

/** Four groups, the top two of each: the table's own order never pairs a group with itself, so the draw changes nothing. */
function fourGroups(): { qualified: number; pairs: string[]; samePool: number } {
  const keys = ["A", "B", "C", "D"];
  const stages = buildTemplateStages("groups_ko", { qualified: 8, swissRounds: 5, poolCount: 4, legs: 1 });
  const progression = stages[1]!.progression as unknown as ProgressionSpec;
  const placed = placeDescriptors(expandSources(progression.sources, () => ({ poolKeys: keys })), progression.placement, progression.map);
  const label = (s: (typeof placed)[number]) => (s.descriptor.kind === "group_rank" ? `${s.descriptor.pool}${s.descriptor.rank}` : "?");
  const pairs = roundOne(placed.length).map(([a, b]) => [label(placed[a - 1]!), label(placed[b - 1]!)] as const);
  return { qualified: placed.length, pairs: pairs.map(([a, b]) => `${a} v ${b}`), samePool: pairs.filter(([a, b]) => a[0] === b[0]).length };
}

// ---- claims ----

interface Qualifier {
  team: string;
  place: number;
  pool: string;
  points: number;
  diff: number;
  tableSeed: number;
  drawnSeed: number;
  opponent: string;
}

/** The printed table, read back strictly (a cell that is not what the example prints is a thrown message, which a claim reports as its failure). */
function qualifiersOf(r: ExampleResult): Qualifier[] {
  const c = { team: col(r, "Team"), finished: col(r, "Finished"), table: col(r, "Seed by the table"), drawn: col(r, "Seed after the draw"), round: col(r, "Round one") };
  return (r.table?.rows ?? []).map((row) => {
    const m = /^(\d+)(st|nd|rd|th) in Group ([A-Z]): (\d+) points, ([+-]?\d+)$/.exec(String(row[c.finished]));
    if (m === null) throw new Error(`'${String(row[c.finished])}' is not 'Nth in Group X: P points, +D'`);
    if (placeText(Number(m[1])) !== `${m[1]}${m[2]}`) throw new Error(`'${m[1]}${m[2]}' is not an ordinal`);
    if (typeof row[c.table] !== "number" || typeof row[c.drawn] !== "number") throw new Error("a seed cell is not a number");
    return { team: String(row[c.team]), place: Number(m[1]), pool: m[3]!, points: Number(m[4]), diff: Number(m[5]), tableSeed: row[c.table] as number, drawnSeed: row[c.drawn] as number, opponent: String(row[c.round]) };
  });
}

/** The first round of a knockout of `size` lines as the rulebook seeds it: seed i meets seed size+1-i, and the lines run 1, 4, 3, 2 for eight
 *  (so the top two seeds are in opposite halves). Only the eight-line draw is needed here. */
const STANDARD_EIGHT: readonly (readonly [number, number])[] = [[1, 8], [4, 5], [3, 6], [2, 7]];

const wholeNumber = (v: unknown) => Number.isInteger(Number(v));

const claims: Claim[] = [
  {
    says: "the groups are dealt by seed along the groups and back (1 to N, then N to 1), and the diagram's groups are those deals, in the groups' order",
    source: "the seeded-snake deal of the sign-up order (the app's `seeded_snake` assignment: seeds 1..N along the groups, then N..1, repeating)",
    check: guarded((r) => {
      const order = String(r.facts.signUpOrder).split(", ");
      const g = Number(r.facts.groupCount);
      if (order.length !== Number(r.facts.teams) || !(g >= 2) || order.length % g !== 0) return `${order.length} teams do not fall into ${g} equal groups`;
      const dealt: string[][] = Array.from({ length: g }, () => []);
      order.forEach((team, i) => dealt[Math.floor(i / g) % 2 === 0 ? i % g : g - 1 - (i % g)]!.push(team));
      const d = r.diagram;
      if (d?.kind !== "groupsToBracket") return "no groups diagram";
      if (d.groups.length !== g) return `${d.groups.length} groups drawn, ${g} dealt`;
      for (const [i, group] of d.groups.entries()) {
        if (group.name !== `Group ${"ABCDEFGHIJKLMNOPQRSTUVWXYZ"[i]}`) return `group ${i + 1} is called '${group.name}'`;
        if ([...group.entrants].sort().join() !== [...dealt[i]!].sort().join()) return `${group.name} holds ${group.entrants.join(", ")}, the deal gives ${dealt[i]!.join(", ")}`;
      }
      return true;
    }),
  },
  {
    says: "the counts are the groups': teams = groups x size, qualifiers = groups x those that go through, the draw has the next power of two lines and the rest are empty",
    source: "arithmetic on the format: a knockout holds a power of two lines (2, 4, 8, 16 ...) and an empty line is a place in the next round",
    check: guarded((r) => {
      const f = r.facts;
      const rows = qualifiersOf(r);
      const g = Number(f.groupCount);
      if (![f.teams, f.groupCount, f.groupSize, f.advance, f.qualifiers, f.bracketSize, f.byes].every(wholeNumber)) return "a count is not a whole number";
      if (Number(f.teams) !== g * Number(f.groupSize)) return "teams is not groups x size";
      if (Number(f.qualifiers) !== g * Number(f.advance) || rows.length !== Number(f.qualifiers)) return `${rows.length} rows, ${g} groups x ${String(f.advance)} go through`;
      let size = 1;
      while (size < Number(f.qualifiers)) size *= 2;
      if (Number(f.bracketSize) !== size) return `bracketSize is ${String(f.bracketSize)}, the next power of two is ${size}`;
      if (Number(f.byes) !== size - Number(f.qualifiers)) return `byes is ${String(f.byes)}, ${size} lines - ${String(f.qualifiers)} qualifiers`;
      const d = r.diagram;
      if (d?.kind !== "groupsToBracket") return "no groups diagram";
      if (d.groups.some((x) => x.advancing !== Number(f.advance) || x.entrants.length !== Number(f.groupSize))) return "a group's size or its number going through is not the facts'";
      return true;
    }),
  },
  {
    says: "each row says where its team finished in its group: the first N of each group, in the diagram's finishing order, and the better place never has fewer points",
    source: "the group tables the example played: the diagram lists each group in finishing order and the table says who of them went through, and with what",
    check: guarded((r) => {
      const rows = qualifiersOf(r);
      const d = r.diagram;
      if (rows.length === 0 || d?.kind !== "groupsToBracket") return "nothing to check";
      let seen = 0;
      for (const [gi, group] of d.groups.entries()) {
        const letter = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[gi]!;
        const through = group.entrants.slice(0, group.advancing).map((team, place) => ({ team, place: place + 1 }));
        for (const t of through) {
          const row = rows.find((x) => x.team === t.team);
          if (row === undefined) return `${t.team} (${t.place}, Group ${letter}) is not in the table`;
          if (row.pool !== letter || row.place !== t.place) return `${t.team} is ${row.place} in Group ${row.pool} in the table, ${t.place} in Group ${letter} in the diagram`;
          seen++;
        }
        const ps = through.map((t) => rows.find((x) => x.team === t.team)!.points);
        if (ps.some((p, i) => i > 0 && p > ps[i - 1]!)) return `a runner-up has more points than the winner in ${group.name}`;
      }
      return seen === rows.length || `${seen} qualifiers placed from the groups, ${rows.length} rows`;
    }),
  },
  {
    says: "the seats by the table are every group's winner, then every runner-up; within a place the best record comes first, by points and then goal difference (football's declared first two keys, with no head-to-head between groups)",
    source: "rank_order over the take (topNPerGroup: wave by wave) and football's declared table order, without its head-to-head steps (entrants of different groups never met)",
    check: guarded((r) => {
      const declared = defaultOrderOf(football()).filter((k) => !String(k).startsWith("h2h"));
      if (declared[0] !== "points" || declared[1] !== "diff") return `football's declared order is ${declared.join(", ")}`;
      const rows = [...qualifiersOf(r)].sort((a, b) => a.tableSeed - b.tableSeed);
      if (rows.some((x, i) => x.tableSeed !== i + 1)) return "the seeds by the table are not 1..n once each";
      for (const [i, x] of rows.entries()) {
        const prev = rows[i - 1];
        if (prev === undefined) continue;
        if (x.place < prev.place) return `${x.team} (place ${x.place}) is seated after ${prev.team} (place ${prev.place})`;
        if (x.place === prev.place) {
          if (x.points > prev.points || (x.points === prev.points && x.diff > prev.diff)) return `${x.team} has the better record but is seated after ${prev.team}`;
          if (x.points === prev.points && x.diff === prev.diff) return `${x.team} and ${prev.team} are level, the example is meant to have no tie`;
        }
      }
      return true;
    }),
  },
  {
    says: "round one is the standard draw, seed 1 against the last line and so on; the table's order paired two teams of one group, and the drawn order pairs nobody with their own group",
    source: "standard single-elimination seeding (seed i meets seed N+1-i; the lines run 1, 4, 3, 2 in an eight-line draw) and the engine's declared cross-pool rule: entrants from one pool never meet in round one",
    check: guarded((r) => {
      const rows = qualifiersOf(r);
      const size = Number(r.facts.bracketSize);
      if (size !== 8) return `bracketSize ${size}: the claim knows the eight-line draw`;
      const n = rows.length;
      const at = (seed: number, key: "tableSeed" | "drawnSeed") => rows.find((x) => x[key] === seed);
      let clashes = 0;
      for (const key of ["tableSeed", "drawnSeed"] as const) {
        let same = 0;
        for (const [a, b] of STANDARD_EIGHT) {
          if (a > n || b > n) continue;
          if (at(a, key)?.pool === at(b, key)?.pool) same++;
        }
        if (key === "tableSeed") clashes = same;
        else if (same !== 0) return `after the draw ${same} first-round matches still pair a group with itself`;
      }
      return clashes > 0 || "the table's order has no same-group pairing, so the draw shows nothing";
    }),
  },
  {
    says: "the draw keeps every group winner's seat and takes the first arrangement of the runners-up, in table order, that pairs no group with itself",
    source: "crossPoolDraw's declared rule (RB5-D10): tier 1 keeps its positions; each later tier is permuted within itself, depth-first in lexicographic order of its table positions, and the first ordering with no same-pool real-versus-real first-round pair wins",
    check: guarded((r) => {
      const rows = qualifiersOf(r);
      const n = rows.length;
      const byTable = [...rows].sort((a, b) => a.tableSeed - b.tableSeed);
      const pairsClash = (order: readonly Qualifier[]) => STANDARD_EIGHT.some(([a, b]) => a <= n && b <= n && order[a - 1]!.pool === order[b - 1]!.pool);
      const tiers = [...new Set(byTable.map((x) => x.place))].sort((a, b) => a - b);
      const first = byTable.filter((x) => x.place === tiers[0]);
      // Tier one keeps its places; each later tier is permuted, lexicographically by table position, the first fitting arrangement wins.
      let arranged: Qualifier[] = [...first];
      for (const tier of tiers.slice(1)) {
        const members = byTable.filter((x) => x.place === tier);
        const perms = (xs: readonly Qualifier[]): Qualifier[][] => (xs.length <= 1 ? [[...xs]] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest])));
        const fit = perms(members).find((p) => !pairsClash([...arranged, ...p, ...byTable.filter((x) => x.place > tier)]));
        if (fit === undefined) return "no arrangement keeps every group apart";
        arranged = [...arranged, ...fit];
      }
      for (const [i, q] of arranged.entries()) if (q.drawnSeed !== i + 1) return `${q.team} should sit at seed ${i + 1}, the table says ${q.drawnSeed}`;
      return true;
    }),
  },
  {
    says: "the last column is round one by those seeds: the two best seeds are straight through, every other team meets the seed that adds up to one more than the lines",
    source: "standard single-elimination seeding with the empty lines given to the top seeds",
    check: guarded((r) => {
      const rows = qualifiersOf(r);
      const size = Number(r.facts.bracketSize);
      const n = rows.length;
      const bySeed = new Map(rows.map((x) => [x.drawnSeed, x]));
      for (const x of rows) {
        const other = size + 1 - x.drawnSeed;
        const want = other > n ? "Straight through" : `v ${bySeed.get(other)?.team ?? "nobody"}`;
        if (x.opponent !== want) return `${x.team} (seed ${x.drawnSeed}): '${x.opponent}', expected '${want}'`;
      }
      const straight = rows.filter((x) => size + 1 - x.drawnSeed > n).sort((a, b) => a.drawnSeed - b.drawnSeed).map((x) => x.team).join(" and ");
      return r.facts.straightThrough === straight || `straightThrough is '${String(r.facts.straightThrough)}', the table gives '${straight}'`;
    }),
  },
  {
    says: "the facts about the clash and the draw are the table's: the pairing the table's order gave, its group, the matches the draw made and who moved up and down",
    source: "the table's own seed columns read back through the standard draw",
    check: guarded((r) => {
      const rows = qualifiersOf(r);
      const n = rows.length;
      const t = (seed: number) => rows.find((x) => x.tableSeed === seed)!;
      const d = (seed: number) => rows.find((x) => x.drawnSeed === seed)!;
      const real = STANDARD_EIGHT.filter(([a, b]) => a <= n && b <= n);
      const clash = real.map(([a, b]) => [t(a), t(b)] as const).find(([a, b]) => a.pool === b.pool);
      if (clash === undefined) return "no same-group pairing in the table's order";
      if (r.facts.tableOrderMatch !== `${clash[0].team} v ${clash[1].team}`) return `tableOrderMatch is '${String(r.facts.tableOrderMatch)}'`;
      if (r.facts.tableOrderClashGroup !== `Group ${clash[0].pool}`) return `tableOrderClashGroup is '${String(r.facts.tableOrderClashGroup)}'`;
      const drawn = real.map(([a, b]) => `${d(a).team} v ${d(b).team}`).join(", ");
      if (r.facts.drawnMatches !== drawn) return `drawnMatches is '${String(r.facts.drawnMatches)}', the table gives '${drawn}'`;
      const byTable = [...rows].sort((a, b) => a.tableSeed - b.tableSeed);
      const up = byTable.filter((x) => x.drawnSeed < x.tableSeed).map((x) => x.team).join(", ");
      const down = byTable.filter((x) => x.drawnSeed > x.tableSeed).map((x) => x.team).join(", ");
      if (r.facts.movedUp !== up) return `movedUp is '${String(r.facts.movedUp)}', the table gives '${up}'`;
      return r.facts.movedDown === down || `movedDown is '${String(r.facts.movedDown)}', the table gives '${down}'`;
    }),
  },
  {
    says: "four groups with two through each fill an eight-line draw winners first, and the table's order alone never pairs a group with itself",
    source: "rank_order over every winner then every runner-up (A1, B1, C1, D1, A2, B2, C2, D2) and standard single-elimination seeding (the lines run 1, 4, 3, 2)",
    check: guarded((r) => {
      const seats = ["A1", "B1", "C1", "D1", "A2", "B2", "C2", "D2"];
      const pairs = STANDARD_EIGHT.map(([a, b]) => `${seats[a - 1]} v ${seats[b - 1]}`);
      if (Number(r.facts.fourGroupsQualified) !== seats.length) return `fourGroupsQualified is ${String(r.facts.fourGroupsQualified)}`;
      if (r.facts.fourGroupsRoundOne !== pairs.join(", ")) return `fourGroupsRoundOne is '${String(r.facts.fourGroupsRoundOne)}', expected '${pairs.join(", ")}'`;
      const same = pairs.filter((p) => p[0] === p[5]).length;
      return Number(r.facts.fourGroupsSamePool) === same && same === 0 || `fourGroupsSamePool is ${String(r.facts.fourGroupsSamePool)}, the pairs have ${same}`;
    }),
  },
  {
    says: "the table's caption and the picture's caption say what the example is, in words: the groups, those that go through, the clash the draw avoided, and the byes",
    source: "the example's own facts, read back into the caption and the title",
    check: guarded((r) => {
      const f = r.facts;
      const [a, b] = String(f.tableOrderMatch).split(" v ");
      const cap = `${capitalised(numberWord(Number(f.groupCount)))} groups of ${numberWord(Number(f.groupSize))}, ${numberWord(Number(f.advance))} from each go through. The table's own order would have put ${a} against ${b} in round one, two teams from ${String(f.tableOrderClashGroup)}, so the draw moves the runners-up.`;
      if (r.table?.caption !== cap) return `the caption is '${r.table?.caption ?? ""}', expected '${cap}'`;
      const title = `${capitalised(numberWord(Number(f.groupCount)))} groups of ${numberWord(Number(f.groupSize))}, the top ${numberWord(Number(f.advance))} of each go through. The best ${numberWord(Number(f.byes))} group winners are straight through to the next round, and nobody meets a team from their own group in round one.`;
      return r.diagram?.title === title || `the picture's caption is '${r.diagram?.title ?? ""}', expected '${title}'`;
    }),
  },
  {
    says: "the diagram's round one is the table's round one: every match, in the bracket's order, with a straight-through place where the line is empty",
    source: "the table's drawn seeds through the standard draw",
    check: guarded((r) => {
      const rows = qualifiersOf(r);
      const d = r.diagram;
      if (d?.kind !== "groupsToBracket") return "no groups diagram";
      const n = rows.length;
      const team = (seed: number) => rows.find((x) => x.drawnSeed === seed)?.team ?? null;
      const want = STANDARD_EIGHT.map(([a, b]) => ({ home: team(a), away: b > n ? null : team(b) }));
      const got = d.bracket[0]?.matches ?? [];
      if (d.bracket.length !== 1 || d.bracket[0]?.name !== "Round one") return "the picture draws more or other than round one";
      return JSON.stringify(got) === JSON.stringify(want) || `the picture's round one is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`;
    }),
  },
  {
    says: "every record in the table is what the played matches pay: the group's results, paid as football's own rule pays them, give each team its points and goal difference, and each group finishes in that order",
    source: "the played results the example lists, paid by football's declared league points (3 for a win, 1 for a draw) and ranked by points then goal difference",
    check: guarded((r) => {
      const sport = football();
      const variant = startingVariantKey(sport);
      const cfg = declaredCfgs(sport).find((c) => c.name === variant)?.cfg;
      const rule = declaredLeaguePoints(sport, cfg);
      const d = r.diagram;
      if (d?.kind !== "groupsToBracket") return "no groups diagram";
      const stats = new Map<string, { points: number; diff: number }>();
      for (const g of d.groups) for (const t of g.entrants) stats.set(t, { points: 0, diff: 0 });
      let matches = 0;
      for (const line of r.text) {
        const m = /^(.+) (\d+) — (\d+) (.+)\.$/.exec(line);
        if (m === null) return `'${line}' is not a result line`;
        const [home, away, h, a] = [m[1]!, m[4]!, Number(m[2]), Number(m[3])];
        const hs = stats.get(home);
        const as = stats.get(away);
        if (hs === undefined || as === undefined) return `'${line}' names a team no group holds`;
        hs.diff += h - a;
        as.diff += a - h;
        hs.points += h > a ? rule.win.regulation : h === a ? (rule.draw ?? Number.NaN) : rule.loss.regulation;
        as.points += a > h ? rule.win.regulation : h === a ? (rule.draw ?? Number.NaN) : rule.loss.regulation;
        matches++;
      }
      const wantMatches = d.groups.reduce((n, g) => n + (g.entrants.length * (g.entrants.length - 1)) / 2, 0);
      if (matches !== wantMatches) return `${matches} matches listed, the groups play ${wantMatches}`;
      for (const g of d.groups) {
        const ordered = [...g.entrants].sort((x, y) => stats.get(y)!.points - stats.get(x)!.points || stats.get(y)!.diff - stats.get(x)!.diff);
        if (ordered.join() !== g.entrants.join()) return `${g.name} finishes ${ordered.join(", ")} on its results, the diagram lists ${g.entrants.join(", ")}`;
      }
      for (const q of qualifiersOf(r)) {
        const st = stats.get(q.team);
        if (st === undefined || st.points !== q.points || st.diff !== q.diff) return `${q.team}: the table says ${q.points} points, ${q.diff}; the results give ${String(st?.points)}, ${String(st?.diff)}`;
      }
      return true;
    }),
  },
  {
    says: "the table lists the qualifiers in the order of their seeds after the draw, from 1",
    source: "the draw's own order: seed 1 first",
    check: guarded((r) => {
      const rows = qualifiersOf(r);
      if (rows.length === 0) return "no rows";
      return rows.every((x, i) => x.drawnSeed === i + 1) || `the rows run ${rows.map((x) => x.drawnSeed).join(", ")}`;
    }),
  },
  offeredInEverySportClaim("groups_ko", "groups-then-knockout", "sportCount"),
];

export const groupsIntoKnockout: BlogExample = {
  id: GROUPS_INTO_KNOCKOUT_ID,
  kind: "engine",
  sports: "all",
  build: () => build(),
  claims,
};
