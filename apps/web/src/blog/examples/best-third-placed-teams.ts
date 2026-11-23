// Post #30, "How are the best third-placed teams picked?". Ten football teams are dealt into three groups by the app's own draw
// (`seededSnake`, which leaves the groups unequal: 3, 3 and 4), play their group matches through the engine's event stream, and are folded
// as a pooled stage (`playGroups`). The app's own template (`buildTemplateStages("groups_ko")`, eight qualifiers from three groups) takes
// the top two of each group and the two best third-placed teams; the app's resolver (`resolveStoredProgression`) seats them and carries
// the engine's comparison basis, and the app's footnote function (`bestNthBasisNote`, in the real English dictionary) says what was left
// out. The same resolver, asked for all three third-placed teams, ranks the one that does not go through too.
//
// WHAT CHECKS IT. The claims recompute the whole table from the printed result lines and the rulebook, never from the code that built
// it: each group's table (football's declared league points, ranked by points and then goal difference), the smallest group's size, the
// bottom places of a larger group whose results are left out, the third-placed teams' records on the same number of matches, and the
// order of those records (football's declared cross-group keys, head-to-head steps removed). A second claim holds the contrast the post
// is about: with every result counted a different team leads.
import { builtinModules } from "@seazn/engine/sports";
import { declaredCfgs, defaultOrderOf, forEachSport } from "@seazn/engine/testkit";
import { isHeadToHeadKey, type ProgressionSpec, type SourceShape } from "@seazn/engine/competition";
import { buildTemplateStages } from "@/lib/format-templates";
import { bestNthBasisNote } from "@/lib/bestnth-basis-note";
import { resolveStoredProgression } from "@/server/usecases/stored-progression";
import { seededSnake } from "@/server/usecases/stages/generators";
import publicDict from "@/dictionaries/en/public.json";
import { playGroups } from "./group-play";
import { declaredLeaguePoints } from "./kit";
import { startingVariantKey } from "./starting-variant";
import { placeText, type Meeting, type MatchView } from "./tie-break-play";
import { capitalised, col, guarded, numberWord, offeredInEverySportClaim } from "./swiss-claims";
import type { BlogExample, Claim, ExampleResult } from "./types";

export const BEST_THIRD_ID = "best-third-placed-teams";

/** Best seed first: the order the organiser signed the teams up in. Ten teams in three groups leave groups of 3, 3 and 4. */
const TEAMS = ["Hawks", "Rockets", "Comets", "Dynamos", "Wolves", "Tigers", "Lions", "Bears", "Foxes", "Eagles"] as const;
const GROUPS = 3;
const TOP_EACH = 2;
const QUALIFIED = 8;
const NTH = 3;
const BEST_COUNT = QUALIFIED - GROUPS * TOP_EACH;
const idOf = (name: string) => name.toLowerCase();
const nameOfId = (id: string) => TEAMS.find((t) => idOf(t) === id) ?? id;
const goals = (h: number, a: number) => (v: MatchView) => v.home.metrics.gf === h && v.away.metrics.gf === a;
const poolName = (key: string) => `Group ${key}`;
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const pointsText = (n: number) => `${n} ${n === 1 ? "point" : "points"}`;
const POOL_KEYS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** The group matches, home side first. Group A: Hawks, Tigers, Lions. Group B: Rockets, Wolves, Bears. Group C (four teams): Comets,
 *  Dynamos, Foxes, Eagles. Foxes finish third in Group C on three points, all of them from the win over last-placed Eagles; Bears finish
 *  third in Group B with a point from two draws; Lions finish third in Group A without a point. */
const SCORES: { home: string; away: string; h: number; a: number; seed: number }[] = [
  { home: "hawks", away: "tigers", h: 1, a: 0, seed: 5 },
  { home: "hawks", away: "lions", h: 1, a: 0, seed: 5 },
  { home: "tigers", away: "lions", h: 1, a: 0, seed: 5 },
  { home: "rockets", away: "wolves", h: 1, a: 1, seed: 62 },
  { home: "rockets", away: "bears", h: 1, a: 0, seed: 5 },
  { home: "wolves", away: "bears", h: 0, a: 0, seed: 9 },
  { home: "comets", away: "dynamos", h: 1, a: 0, seed: 5 },
  { home: "comets", away: "foxes", h: 3, a: 0, seed: 202 },
  { home: "comets", away: "eagles", h: 1, a: 0, seed: 5 },
  { home: "dynamos", away: "foxes", h: 1, a: 0, seed: 5 },
  { home: "dynamos", away: "eagles", h: 1, a: 0, seed: 5 },
  { home: "foxes", away: "eagles", h: 1, a: 0, seed: 5 },
];

const football = () => builtinModules.find((m) => m.key === "football")!;
const DICT = publicDict as Record<string, string>;
/** The app's translator over the real English dictionary: a key's text with its `{vars}` filled in. A missing key is a thrown error. */
const t = (key: string, vars?: Record<string, string | number>): string => {
  const text = DICT[key];
  if (text === undefined) throw new Error(`best-third-placed-teams: the English dictionary has no '${key}'`);
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? `{${name}}`));
};

interface Candidate {
  id: string;
  pool: string;
  poolSize: number;
  full: { points: number; diff: number; played: number };
  compared: { points: number; diff: number; played: number };
  leftOut: { id: string; place: number }[];
}

function build(): ExampleResult {
  const sport = football();
  const variant = startingVariantKey(sport);
  const cfg = declaredCfgs(sport).find((c) => c.name === variant)?.cfg;
  if (cfg === undefined) throw new Error(`best-third-placed-teams: football has no declared variant '${variant}'`);
  const entrants = TEAMS.map((name, i) => ({ id: idOf(name), name, seed: i + 1 }));
  const dealt = seededSnake(entrants.map((e) => ({ ...e, swiss_first_round: null })), GROUPS);
  const pools = new Map(dealt.map((members, i) => [POOL_KEYS[i]!, members.map((m) => m.id)] as const));
  const meetings: Meeting[] = SCORES.map((s) => ({ home: s.home, away: s.away, what: `${nameOfId(s.home)} ${s.h}-${s.a} ${nameOfId(s.away)}`, want: goals(s.h, s.a), ...(s.seed > 0 ? { seed: s.seed } : {}) }));
  const played = playGroups({ module: sport, cfg, entrants, pools, meetings });

  // The app's template for eight qualifiers from three groups: the top two of each, then the best third-placed.
  const stages = buildTemplateStages("groups_ko", { qualified: QUALIFIED, swissRounds: 5, poolCount: GROUPS, legs: 1 });
  const progression = stages[1]!.progression as unknown as ProgressionSpec;
  const take = progression.sources[0]!.take;
  const bestRule = take.find((r) => r.kind === "bestNth");
  if (bestRule === undefined || bestRule.kind !== "bestNth" || bestRule.nth !== NTH || bestRule.count !== BEST_COUNT) throw new Error("best-third-placed-teams: the template's take is not 'the best N third-placed'");
  const shape: SourceShape = { poolKeys: [...pools.keys()] };
  const seated = resolveStoredProgression(progression, [shape], [played.tables], "knockout", ["group"]);
  const seatedThirds = seated.qualifiers.filter((q) => q.descriptor.kind === "best_nth");
  // The same resolver asked for every group's third-placed team: the whole ranking, the one that does not go through included.
  const everyThird: ProgressionSpec = { ...progression, sources: [{ ...progression.sources[0]!, take: [{ kind: "bestNth", nth: NTH, count: GROUPS, normaliseUnequalPools: true }] }] };
  const ranked = resolveStoredProgression(everyThird, [shape], [played.tables], "knockout", ["group"]).qualifiers.filter((q) => q.descriptor.kind === "best_nth");
  if (ranked.length !== GROUPS) throw new Error(`best-third-placed-teams: ${ranked.length} third-placed teams ranked, ${GROUPS} groups`);
  if (seatedThirds.map((q) => q.entrantId).join() !== ranked.slice(0, BEST_COUNT).map((q) => q.entrantId).join()) throw new Error("best-third-placed-teams: the template's seats are not the first of the full ranking");
  // The seats the knockout takes come in this order: every group's winner, then every runner-up, then the best third-placed.
  const lastGroupSeat = Math.max(...seated.qualifiers.filter((q) => q.descriptor.kind === "group_rank").map((q) => q.seed));
  if (seatedThirds.length !== BEST_COUNT || seatedThirds.some((q) => q.seed <= lastGroupSeat)) throw new Error("best-third-placed-teams: the best third-placed teams are not seated after every group place");
  const basis = ranked[0]!.basis;
  if (basis === undefined) throw new Error("best-third-placed-teams: the resolver returned no comparison basis");

  const candidates: Candidate[] = ranked.map((q) => {
    const pool = q.pool ?? "";
    const rows = played.rows.get(pool)!;
    const row = rows.find((r) => r.entrantId === q.entrantId)!;
    const dropped = q.basis!.dropped.find((d) => d.pool === pool)?.against ?? [];
    let points = row.points;
    let diff = row.metrics.gd ?? 0;
    let n = row.played;
    for (const [home, away] of played.results.get(pool)!) {
      const mine = home.entrantId === q.entrantId && dropped.includes(away.entrantId) ? home : away.entrantId === q.entrantId && dropped.includes(home.entrantId) ? away : undefined;
      if (mine === undefined) continue;
      points -= mine.points;
      diff -= mine.metrics.gd ?? 0;
      n -= mine.played;
    }
    return {
      id: q.entrantId,
      pool,
      poolSize: rows.length,
      full: { points: row.points, diff: row.metrics.gd ?? 0, played: row.played },
      compared: { points, diff, played: n },
      leftOut: dropped.map((id) => ({ id, place: rows.findIndex((r) => r.entrantId === id) + 1 })),
    };
  });
  const comparedOn = new Set(candidates.map((c) => c.compared.played));
  if (comparedOn.size !== 1 || [...comparedOn][0] !== basis.matchesCounted) throw new Error(`best-third-placed-teams: the thirds were not compared on one number of matches (${[...comparedOn].join(", ")}; the engine says ${basis.matchesCounted})`);
  const larger = candidates.find((c) => c.leftOut.length > 0);
  if (larger === undefined) throw new Error("best-third-placed-teams: no group is larger than the smallest, so the example shows nothing");
  const fullLeader = [...candidates].sort((a, b) => b.full.points - a.full.points || b.full.diff - a.full.diff)[0]!;
  if (fullLeader.id === candidates[0]!.id) throw new Error("best-third-placed-teams: counting every result changes nothing, so the example shows nothing");

  // The product's own footnote under the group table, in the English dictionary.
  const names = Object.fromEntries(TEAMS.map((n) => [idOf(n), n]));
  const poolsForNote = [...pools.keys()].map((key) => ({ key, rows: played.rows.get(key)!.map((r) => ({ entrantId: r.entrantId, rank: r.rank, played: r.played })) }));
  const note = bestNthBasisNote(basis, poolsForNote, names, new Set(), t, "en");
  if (note === null) throw new Error("best-third-placed-teams: the app wrote no footnote for a comparison that left a result out");
  const sizes = [...pools.values()].map((m) => m.length);
  const recordText = (r: { points: number; diff: number; played: number }) => `${pointsText(r.points)}, ${signed(r.diff)} from ${r.played} matches`;
  const leftOutText = (c: Candidate) => (c.leftOut.length === 0 ? "nothing" : c.leftOut.map((l) => `v ${nameOfId(l.id)} (${placeText(l.place)})`).join(", "));
  const thirdsThrough = candidates.slice(0, BEST_COUNT).map((c) => nameOfId(c.id));
  const outThirds = candidates.slice(BEST_COUNT).map((c) => nameOfId(c.id));
  const groupLine = (c: Candidate) => `${poolName(c.pool)}, ${numberWord(c.poolSize)} teams`;

  return {
    facts: {
      teams: TEAMS.length,
      groupCount: GROUPS,
      groupSizes: `${sizes.slice(0, -1).join(", ")} and ${sizes[sizes.length - 1]}`,
      topEach: TOP_EACH,
      bestCount: BEST_COUNT,
      qualified: QUALIFIED,
      signUpOrder: TEAMS.join(", "),
      comparedMatches: basis.matchesCounted,
      largerGroup: poolName(larger.pool),
      largerGroupSize: larger.poolSize,
      smallestGroupSize: Math.min(...sizes),
      largerThird: nameOfId(larger.id),
      largerThirdFullPoints: larger.full.points,
      largerThirdFullRecord: recordText(larger.full),
      largerThirdComparedRecord: recordText(larger.compared),
      leftOutTeam: nameOfId(larger.leftOut[0]!.id),
      leftOutPlace: placeText(larger.leftOut[0]!.place),
      fullRecordLeader: nameOfId(fullLeader.id),
      comparedLeader: nameOfId(candidates[0]!.id),
      thirdsThrough: thirdsThrough.join(" and "),
      outThird: outThirds.join(" and "),
      footnoteLine: note.line,
      footnoteNothingLeftOut: note.leftOut.find((l) => !l.includes(" v ")) ?? "",
      footnoteLeftOutLine: note.leftOut.find((l) => l.includes(" v ")) ?? "",
      sportCount: forEachSport(() => undefined),
    },
    table: {
      caption: `${capitalised(numberWord(GROUPS))} groups of ${sizes.slice(0, -1).map(numberWord).join(", ")} and ${numberWord(sizes[sizes.length - 1]!)}, the top ${numberWord(TOP_EACH)} of each go through, and so do the ${numberWord(BEST_COUNT)} best third-placed teams. Each is compared on ${numberWord(basis.matchesCounted)} matches, so ${nameOfId(larger.id)} are compared without their result against ${nameOfId(larger.leftOut[0]!.id)}.`,
      columns: ["Third place of", "Team", "Record in its own group", "Results left out", "Compared on", "Place among the thirds", "Result"],
      rows: candidates.map((c, i) => [poolName(c.pool), nameOfId(c.id), recordText(c.full), leftOutText(c), recordText(c.compared), placeText(i + 1), i < BEST_COUNT ? "Through" : "Out"]),
    },
    diagram: {
      kind: "bestPlaced",
      title: `The ${numberWord(BEST_COUNT)} best third-placed teams go through. Each is compared on ${numberWord(basis.matchesCounted)} matches, so the result of a team in a larger group against its last-placed team is left out.`,
      take: BEST_COUNT,
      candidates: candidates.map((c) => ({
        team: nameOfId(c.id),
        group: groupLine(c),
        counted: `Counted: ${recordText(c.compared)}`,
        leftOut: c.leftOut.length === 0 ? "Left out: nothing" : `Left out: ${leftOutText(c)}`,
      })),
    },
    text: played.played.map((p) => `${nameOfId(p.meeting.home)} ${p.view.headline} ${nameOfId(p.meeting.away)}.`),
  };
}

// ---- claims ----

interface Third {
  group: string;
  team: string;
  full: string;
  leftOut: string;
  compared: string;
  place: string;
  result: string;
}

function thirdsOf(r: ExampleResult): Third[] {
  const c = { group: col(r, "Third place of"), team: col(r, "Team"), full: col(r, "Record in its own group"), left: col(r, "Results left out"), cmp: col(r, "Compared on"), place: col(r, "Place among the thirds"), result: col(r, "Result") };
  return (r.table?.rows ?? []).map((row) => ({ group: String(row[c.group]), team: String(row[c.team]), full: String(row[c.full]), leftOut: String(row[c.left]), compared: String(row[c.cmp]), place: String(row[c.place]), result: String(row[c.result]) }));
}

interface Standing {
  team: string;
  points: number;
  diff: number;
  played: number;
}

/** Each group's table, rebuilt from the printed result lines: the groups are the sets of teams that met, the points are football's declared
 *  ones, the order is points and then goal difference (a tie on both is refused: the example is meant to have none). The results are kept
 *  so a bottom team's can be left out. */
function groupsFromResults(r: ExampleResult): { tables: Standing[][]; results: { home: string; away: string; h: number; a: number }[] } {
  const sport = football();
  const variant = startingVariantKey(sport);
  const cfg = declaredCfgs(sport).find((c) => c.name === variant)?.cfg;
  const rule = declaredLeaguePoints(sport, cfg);
  if (rule.draw === undefined) throw new Error("football declares no draw points");
  const results = r.text.map((line) => {
    const m = /^(.+) (\d+) — (\d+) (.+)\.$/.exec(line);
    if (m === null) throw new Error(`'${line}' is not a result line`);
    return { home: m[1]!, away: m[4]!, h: Number(m[2]), a: Number(m[3]) };
  });
  // The groups: the sets of teams joined by a match.
  const groupOf = new Map<string, number>();
  let groups = 0;
  for (const x of results) {
    const gh = groupOf.get(x.home);
    const ga = groupOf.get(x.away);
    if (gh === undefined && ga === undefined) {
      groupOf.set(x.home, groups);
      groupOf.set(x.away, groups);
      groups++;
    } else if (gh !== undefined && ga === undefined) groupOf.set(x.away, gh);
    else if (gh === undefined && ga !== undefined) groupOf.set(x.home, ga);
    else if (gh !== ga) for (const [k, v] of groupOf) if (v === ga) groupOf.set(k, gh!);
  }
  const ids = [...new Set([...groupOf.values()])].sort((a, b) => a - b);
  const stand = new Map<string, Standing>();
  for (const team of groupOf.keys()) stand.set(team, { team, points: 0, diff: 0, played: 0 });
  for (const x of results) {
    const hs = stand.get(x.home)!;
    const as = stand.get(x.away)!;
    hs.played++;
    as.played++;
    hs.diff += x.h - x.a;
    as.diff += x.a - x.h;
    hs.points += x.h > x.a ? rule.win.regulation : x.h === x.a ? rule.draw : rule.loss.regulation;
    as.points += x.a > x.h ? rule.win.regulation : x.h === x.a ? rule.draw : rule.loss.regulation;
  }
  const tables = ids.map((id) => [...stand.values()].filter((s) => groupOf.get(s.team) === id).sort((x, y) => y.points - x.points || y.diff - x.diff));
  for (const table of tables) {
    for (let i = 1; i < table.length; i++) if (table[i]!.points === table[i - 1]!.points && table[i]!.diff === table[i - 1]!.diff) throw new Error(`${table[i - 1]!.team} and ${table[i]!.team} are level on points and goal difference, the example is meant to have no tie`);
  }
  return { tables, results };
}

/** The cross-group keys football declares: its table order without the head-to-head steps (entrants of different groups never met). */
function crossGroupKeys(): string[] {
  return defaultOrderOf(football()).filter((k) => !isHeadToHeadKey(k)).map(String);
}

interface Derived {
  group: number;
  team: string;
  size: number;
  full: Standing;
  compared: Standing;
  leftOut: { team: string; place: number }[];
}

/** The rulebook's reading of the table: the third-placed team of every group that has one, the size of the smallest such group, the bottom
 *  places of a larger group left out of its candidate's record, and the candidates ranked by points and then goal difference. */
function derive(r: ExampleResult): Derived[] {
  const { tables, results } = groupsFromResults(r);
  const nth = NTH;
  const supplying = tables.map((table, group) => ({ table, group })).filter(({ table }) => table.length >= nth);
  const smallest = Math.min(...supplying.map(({ table }) => table.length));
  const keys = crossGroupKeys();
  if (keys[0] !== "points" || keys[1] !== "diff") throw new Error(`football's cross-group order is ${keys.join(", ")}, not points then goal difference first`);
  const out = supplying.map(({ table, group }): Derived => {
    const candidate = table[nth - 1]!;
    const bottom = table.slice(smallest);
    const dropped = new Set(bottom.map((s) => s.team));
    const compared = { ...candidate };
    const rule = declaredLeaguePointsOf();
    for (const x of results) {
      const mine = x.home === candidate.team && dropped.has(x.away) ? { for: x.h, against: x.a } : x.away === candidate.team && dropped.has(x.home) ? { for: x.a, against: x.h } : undefined;
      if (mine === undefined) continue;
      compared.played--;
      compared.diff -= mine.for - mine.against;
      compared.points -= mine.for > mine.against ? rule.win : mine.for === mine.against ? rule.draw : rule.loss;
    }
    return { group, team: candidate.team, size: table.length, full: candidate, compared, leftOut: bottom.map((s) => ({ team: s.team, place: table.indexOf(s) + 1 })) };
  });
  out.sort((a, b) => b.compared.points - a.compared.points || b.compared.diff - a.compared.diff);
  for (let i = 1; i < out.length; i++) if (out[i]!.compared.points === out[i - 1]!.compared.points && out[i]!.compared.diff === out[i - 1]!.compared.diff) throw new Error(`${out[i - 1]!.team} and ${out[i]!.team} are level on the compared record, the example is meant to have no tie`);
  return out;
}

function declaredLeaguePointsOf(): { win: number; draw: number; loss: number } {
  const sport = football();
  const variant = startingVariantKey(sport);
  const cfg = declaredCfgs(sport).find((c) => c.name === variant)?.cfg;
  const rule = declaredLeaguePoints(sport, cfg);
  return { win: rule.win.regulation, draw: rule.draw ?? Number.NaN, loss: rule.loss.regulation };
}

const record = (s: Standing) => `${s.points} ${s.points === 1 ? "point" : "points"}, ${signed(s.diff)} from ${s.played} matches`;
const groupLetter = (index: number) => POOL_KEYS[index]!;

const claims: Claim[] = [
  {
    says: "the groups are dealt by seed along the groups and back (1 to N, then N to 1), they come out unequal, and each is a set of teams that met each other once",
    source: "the seeded-snake deal of the sign-up order (the app's `seeded_snake`: seeds 1..N along the groups, then N..1, repeating); a group stage's matches are every pair of a group once",
    check: guarded((r) => {
      const order = String(r.facts.signUpOrder).split(", ");
      const g = Number(r.facts.groupCount);
      if (order.length !== Number(r.facts.teams) || !(g >= 2)) return `${order.length} teams, ${g} groups`;
      const dealt: string[][] = Array.from({ length: g }, () => []);
      order.forEach((team, i) => dealt[Math.floor(i / g) % 2 === 0 ? i % g : g - 1 - (i % g)]!.push(team));
      const { tables, results } = groupsFromResults(r);
      if (tables.length !== g) return `${tables.length} groups met, ${g} dealt`;
      const sizes = dealt.map((d) => d.length);
      if (new Set(sizes).size < 2) return "the groups are equal, so nothing is left out and the example shows nothing";
      const formatted = `${sizes.slice(0, -1).join(", ")} and ${sizes[sizes.length - 1]}`;
      if (r.facts.groupSizes !== formatted) return `groupSizes is '${String(r.facts.groupSizes)}', the deal gives '${formatted}'`;
      for (const d of dealt) {
        const table = tables.find((tb) => tb.some((s) => s.team === d[0]));
        if (table === undefined || [...table.map((s) => s.team)].sort().join() !== [...d].sort().join()) return `a group is not the deal's ${d.join(", ")}`;
        const pairs = (d.length * (d.length - 1)) / 2;
        const played = results.filter((x) => d.includes(x.home) && d.includes(x.away)).length;
        if (played !== pairs) return `${d.join(", ")} play ${played} matches, a round robin of ${d.length} is ${pairs}`;
      }
      return true;
    }),
  },
  {
    says: "the qualifiers are the top of each group plus the best third-placed: groups x top + best = the stage's qualifiers",
    source: "arithmetic on the format: 8 qualifiers from 3 groups = 2 of each (6) and the 2 left over taken from the third-placed (the template's own take)",
    check: guarded((r) => {
      const f = r.facts;
      if (![f.groupCount, f.topEach, f.bestCount, f.qualified].every((v) => Number.isInteger(Number(v)))) return "a count is not a whole number";
      if (Number(f.qualified) !== Number(f.groupCount) * Number(f.topEach) + Number(f.bestCount)) return `${String(f.qualified)} is not ${String(f.groupCount)} x ${String(f.topEach)} + ${String(f.bestCount)}`;
      if (Number(f.bestCount) >= Number(f.groupCount)) return "the best third-placed taken are all of them, so nothing is chosen";
      return thirdsOf(r).filter((x) => x.result === "Through").length === Number(f.bestCount) || "the table's 'Through' count is not bestCount";
    }),
  },
  {
    says: "the table is the third-placed team of each group, ranked on the same number of matches: the larger group's candidate without its results against the group's last-placed team, then points and goal difference",
    source: "the engine's declared best-Nth rule (RB5-U1, ruling 286): the bottom k = size - the smallest size are left out of the larger group's candidate, and candidates are ranked by the source stage's cross-group order, football's points then goal difference; every record rebuilt from the printed results and football's declared league points",
    check: guarded((r) => {
      const want = derive(r);
      const got = thirdsOf(r);
      if (got.length !== want.length) return `${got.length} rows, the groups have ${want.length} third-placed teams`;
      for (const [i, w] of want.entries()) {
        const x = got[i]!;
        const expected: Third = {
          group: `Group ${groupLetter(w.group)}`,
          team: w.team,
          full: record(w.full),
          leftOut: w.leftOut.length === 0 ? "nothing" : w.leftOut.map((l) => `v ${l.team} (${placeText(l.place)})`).join(", "),
          compared: record(w.compared),
          place: placeText(i + 1),
          result: i < Number(r.facts.bestCount) ? "Through" : "Out",
        };
        for (const k of Object.keys(expected) as (keyof Third)[]) if (x[k] !== expected[k]) return `row ${i + 1} ${k}: '${x[k]}', rebuilt from the results '${expected[k]}'`;
      }
      return true;
    }),
  },
  {
    says: "every third-placed team is compared on the same number of matches, the smallest group's, and that is what the post says",
    source: "the engine's declared best-Nth rule: every candidate is compared on the number of matches the smallest supplying group played for that place",
    check: guarded((r) => {
      const want = derive(r);
      const counts = new Set(want.map((w) => w.compared.played));
      if (counts.size !== 1) return `compared on ${[...counts].join(" and ")} matches`;
      const smallest = Math.min(...want.map((w) => w.size));
      if ([...counts][0] !== smallest - 1) return `compared on ${[...counts][0]}, the smallest group plays ${smallest - 1} matches each`;
      if (Number(r.facts.smallestGroupSize) !== smallest) return `smallestGroupSize is ${String(r.facts.smallestGroupSize)}, the smallest group has ${smallest} teams`;
      return Number(r.facts.comparedMatches) === smallest - 1 || `comparedMatches is ${String(r.facts.comparedMatches)}, the smallest group's teams play ${smallest - 1}`;
    }),
  },
  {
    says: "counting every result would rank a different team first: the larger group's third-placed team has the best full record, and is last once its result against the last-placed team is left out",
    source: "the same results counted two ways: with every result of the group, and as the best-Nth rule counts them",
    check: guarded((r) => {
      const want = derive(r);
      const fullOrder = [...want].sort((a, b) => b.full.points - a.full.points || b.full.diff - a.full.diff);
      const larger = want.find((w) => w.leftOut.length > 0);
      if (larger === undefined) return "no group is larger than the smallest";
      if (fullOrder[0]!.team === want[0]!.team) return "the full records rank the same team first, so the example shows nothing";
      if (r.facts.fullRecordLeader !== fullOrder[0]!.team) return `fullRecordLeader is '${String(r.facts.fullRecordLeader)}', the full records give '${fullOrder[0]!.team}'`;
      if (r.facts.comparedLeader !== want[0]!.team) return `comparedLeader is '${String(r.facts.comparedLeader)}', the compared records give '${want[0]!.team}'`;
      if (r.facts.largerThird !== larger.team) return `largerThird is '${String(r.facts.largerThird)}', the larger group's third is '${larger.team}'`;
      if (r.facts.largerGroup !== `Group ${groupLetter(larger.group)}` || Number(r.facts.largerGroupSize) !== larger.size) return "the larger group is not the facts'";
      if (Number(r.facts.largerThirdFullPoints) !== larger.full.points) return `largerThirdFullPoints is ${String(r.facts.largerThirdFullPoints)}, ${larger.full.points} from the results`;
      if (r.facts.largerThirdFullRecord !== record(larger.full)) return `largerThirdFullRecord is '${String(r.facts.largerThirdFullRecord)}'`;
      if (r.facts.largerThirdComparedRecord !== record(larger.compared)) return `largerThirdComparedRecord is '${String(r.facts.largerThirdComparedRecord)}'`;
      if (r.facts.leftOutTeam !== larger.leftOut[0]!.team || r.facts.leftOutPlace !== placeText(larger.leftOut[0]!.place)) return "the team left out is not the facts'";
      return want.indexOf(larger) === want.length - 1 || `${larger.team} is not last once the result is left out`;
    }),
  },
  {
    says: "the best third-placed teams through, and the ones out, are the facts' words for the table's first and last rows",
    source: "the ranking rebuilt from the printed results, cut after the number of best third-placed teams the format takes",
    check: guarded((r) => {
      const want = derive(r);
      const n = Number(r.facts.bestCount);
      const through = want.slice(0, n).map((w) => w.team).join(" and ");
      const out = want.slice(n).map((w) => w.team).join(" and ");
      if (r.facts.thirdsThrough !== through) return `thirdsThrough is '${String(r.facts.thirdsThrough)}', the ranking gives '${through}'`;
      return r.facts.outThird === out || `outThird is '${String(r.facts.outThird)}', the ranking gives '${out}'`;
    }),
  },
  {
    says: "the footnote lines are the product's own English words for the comparison: who is compared, on how many matches, and which results are not counted",
    source: "the English dictionary's table.bestNth.* strings (the standings footnote under a group stage), filled with the values rebuilt from the printed results",
    check: guarded((r) => {
      const want = derive(r);
      const larger = want.find((w) => w.leftOut.length > 0);
      if (larger === undefined) return "no group is larger than the smallest";
      const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th"}`;
      const who = DICT["table.bestNth.who.other"]!.replace("{nth}", ordinal(NTH));
      const against = DICT["table.bestNth.against"]!.replace("{place}", ordinal(larger.leftOut[0]!.place)).replace("{pools}", DICT["table.poolLabel"]!.replace("{key}", groupLetter(larger.group)));
      const line = DICT["table.bestNth.basis.other"]!.replace("{who}", who).replace("{count}", String(Math.min(...want.map((w) => w.size)) - 1)).replace("{against}", against);
      if (r.facts.footnoteLine !== line) return `footnoteLine is '${String(r.facts.footnoteLine)}', the dictionary gives '${line}'`;
      const left = DICT["table.bestNth.leftOut.result"]!.replace("{name}", larger.team).replace("{opponent}", larger.leftOut[0]!.team).replace("{place}", ordinal(larger.leftOut[0]!.place)).replace("{pool}", DICT["table.poolLabel"]!.replace("{key}", groupLetter(larger.group)));
      if (r.facts.footnoteLeftOutLine !== left) return `footnoteLeftOutLine is '${String(r.facts.footnoteLeftOutLine)}', the dictionary gives '${left}'`;
      const smallest = want.filter((w) => w.leftOut.length === 0).sort((a, b) => a.group - b.group)[0]!;
      const none = DICT["table.bestNth.leftOut.none"]!.replace("{name}", smallest.team).replace("{pool}", DICT["table.poolLabel"]!.replace("{key}", groupLetter(smallest.group)));
      return r.facts.footnoteNothingLeftOut === none || `footnoteNothingLeftOut is '${String(r.facts.footnoteNothingLeftOut)}', the dictionary gives '${none}'`;
    }),
  },
  {
    says: "the table's caption and the picture's caption say what the example is, in words: the groups and their sizes, how many go through from the top and from the thirds, and whose result is left out",
    source: "the example's own facts, read back into the caption and the title",
    check: guarded((r) => {
      const f = r.facts;
      const sizes = String(f.groupSizes).replace(" and ", ", ").split(", ").map(Number);
      const sizesText = `${sizes.slice(0, -1).map(numberWord).join(", ")} and ${numberWord(sizes[sizes.length - 1]!)}`;
      const cap = `${capitalised(numberWord(Number(f.groupCount)))} groups of ${sizesText}, the top ${numberWord(Number(f.topEach))} of each go through, and so do the ${numberWord(Number(f.bestCount))} best third-placed teams. Each is compared on ${numberWord(Number(f.comparedMatches))} matches, so ${String(f.largerThird)} are compared without their result against ${String(f.leftOutTeam)}.`;
      if (r.table?.caption !== cap) return `the caption is '${r.table?.caption ?? ""}', expected '${cap}'`;
      const title = `The ${numberWord(Number(f.bestCount))} best third-placed teams go through. Each is compared on ${numberWord(Number(f.comparedMatches))} matches, so the result of a team in a larger group against its last-placed team is left out.`;
      return r.diagram?.title === title || `the picture's caption is '${r.diagram?.title ?? ""}', expected '${title}'`;
    }),
  },
  {
    says: "the picture's cards are the table's rows in the same order, with the same group, record counted and result left out, and the first bestCount marked through",
    source: "the table's own rows read back into the picture",
    check: guarded((r) => {
      const rows = thirdsOf(r);
      const d = r.diagram;
      if (d?.kind !== "bestPlaced") return "no best-placed diagram";
      if (d.take !== Number(r.facts.bestCount)) return `the picture takes ${d.take}, bestCount is ${String(r.facts.bestCount)}`;
      if (d.candidates.length !== rows.length) return `${d.candidates.length} cards, ${rows.length} rows`;
      const want = derive(r);
      for (const [i, x] of rows.entries()) {
        const c = d.candidates[i]!;
        if (c.team !== x.team) return `card ${i + 1} is ${c.team}, row ${i + 1} is ${x.team}`;
        if (c.group !== `${x.group}, ${numberWord(want[i]!.size)} teams`) return `card ${i + 1}: '${c.group}'`;
        if (c.counted !== `Counted: ${x.compared}`) return `card ${i + 1}: '${c.counted}'`;
        if (c.leftOut !== `Left out: ${x.leftOut}`) return `card ${i + 1}: '${c.leftOut}'`;
      }
      return true;
    }),
  },
  {
    says: "in every sport the third-placed teams are ranked by that sport's own table order with the head-to-head steps removed (entrants of different groups never met), and the order is never empty",
    source: "each sport's declared table order (defaultOrderOf), swept with forEachSport, minus the engine's own head-to-head keys (isHeadToHeadKey)",
    check: guarded((r) => {
      const empty: string[] = [];
      const visited = forEachSport(({ key, module: sportModule }) => {
        if (defaultOrderOf(sportModule).filter((k) => !isHeadToHeadKey(k)).length === 0) empty.push(key);
      });
      if (visited === 0) return "the sweep visited no sport";
      if (empty.length > 0) return `no cross-group order left for ${empty.join(", ")}`;
      return Number(r.facts.sportCount) === visited || `sportCount is ${String(r.facts.sportCount)}, the registry has ${visited}`;
    }),
  },
  offeredInEverySportClaim("groups_ko", "groups-then-knockout (with its best third-placed seats)", "sportCount"),
];

export const bestThirdPlacedTeams: BlogExample = {
  id: BEST_THIRD_ID,
  kind: "engine",
  sports: "all",
  build: () => build(),
  claims,
};
