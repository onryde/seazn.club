// Post #28, "How is a round-robin schedule made, and what happens with an odd number of teams?". Five teams are put through
// the app's own league producer (`roundRobinStagePlan`, the call Generate makes: the engine's `generateRoundRobin` over the
// seeded field), and the table is the first leg, round by round, with the team that sits out. A second field of six, and
// the same five over two legs, are generated the same way and reported as facts (how many rounds, how many matches, how the
// home and away games split, what the second leg's first round is).
//
// WHAT CHECKS IT. The claims hold the printed schedule to the definition of a single round robin (every pair meets exactly
// once, nobody plays twice in a round, in an odd field exactly one team rests each round and each rests once, the home and
// away games differ by at most one), to the counting formulas (n(n-1)/2 matches a leg, n rounds for an odd n and n-1 for an
// even one), and the wheel to the circle method's own pairing rule: they never call the producer that built the table.
import { forEachSport } from "@seazn/engine/testkit";
import { roundRobinStagePlan } from "@/server/usecases/stages/generators";
import type { GenFixture } from "@/server/usecases/stages/types";
import { capitalised, captionClaim, col, guarded, numberWord, offeredInEverySportClaim } from "./swiss-claims";
import type { BlogExample, Claim, ExampleResult } from "./types";

export const ROUND_ROBIN_SCHEDULE_ID = "round-robin-schedule";

/** Five teams, listed best seed first (the order the schedule is built from). */
const TEAMS = ["Hawks", "Rockets", "Comets", "Dynamos", "Wolves"] as const;
/** A field of six, for the even case. */
const SIX = ["Hawks", "Rockets", "Comets", "Dynamos", "Wolves", "Tigers"] as const;
const EMPTY_SEAT = "Empty seat";

interface Line {
  round: number;
  home: string;
  away: string;
}

/** The app's league draw for a field and a number of legs: the lines and who sits out each round. */
function draw(field: readonly string[], legs: number): { lines: Line[]; rests: Map<number, string> } {
  const names = new Map(field.map((n) => [`id-${n}`, n]));
  const entrants = field.map((n, i) => ({ id: `id-${n}`, seed: i + 1, swiss_first_round: null }));
  const plan = roundRobinStagePlan("league", { legs }, entrants, new Map());
  const name = (id: string) => names.get(id) ?? (() => { throw new Error(`blog example: unknown entrant ${id}`); })();
  const lines = plan.gen.map((f: GenFixture) => ({ round: f.roundNo, home: name(f.home!), away: name(f.away!) }));
  return { lines, rests: new Map(plan.byes.map((b) => [b.round_no, name(b.entrant_id)])) };
}

const versus = (l: { home: string; away: string }) => `${l.home} v ${l.away}`;
const homeCount = (lines: readonly Line[], team: string) => lines.filter((l) => l.home === team).length;

function build(): ExampleResult {
  const one = draw(TEAMS, 1);
  const two = draw(TEAMS, 2);
  const six = draw(SIX, 1);
  const rounds = [...new Set(one.lines.map((l) => l.round))].sort((a, b) => a - b);
  const rows = rounds.map((r) => {
    const matches = one.lines.filter((l) => l.round === r);
    return [r, versus(matches[0]!), versus(matches[1]!), one.rests.get(r) ?? ""];
  });
  const homes = TEAMS.map((t) => homeCount(one.lines, t));
  const sixHomes = SIX.map((t) => homeCount(six.lines, t));
  const firstLegTwo = two.lines.filter((l) => l.round === 1).map(versus).join(", ");
  const secondLegOne = two.lines.filter((l) => l.round === rounds.length + 1).map(versus).join(", ");
  if (homes.some((h) => h !== homes[0]) || two.lines.length !== 2 * one.lines.length) throw new Error("blog example: the five-team schedule is not what the post says");
  // The wheel of round one: the field in seed order, the empty seat where an odd field's rest is drawn.
  const first = rounds[0]!;
  return {
    facts: {
      fieldSize: TEAMS.length,
      rounds: rounds.length,
      matches: one.lines.length,
      matchesPerRound: one.lines.filter((l) => l.round === first).length,
      opponentsEach: new Set(one.lines.filter((l) => l.home === TEAMS[0] || l.away === TEAMS[0]).flatMap((l) => [l.home, l.away]).filter((t) => t !== TEAMS[0])).size,
      homeEach: homes[0]!,
      awayEach: TEAMS.length - 1 - homes[0]!,
      twoLegRounds: new Set(two.lines.map((l) => l.round)).size,
      twoLegMatches: two.lines.length,
      firstLegRoundOne: firstLegTwo,
      secondLegRoundOne: secondLegOne,
      evenFieldSize: SIX.length,
      evenRounds: new Set(six.lines.map((l) => l.round)).size,
      evenMatches: six.lines.length,
      evenMatchesPerRound: six.lines.filter((l) => l.round === first).length,
      evenHomeFewest: Math.min(...sixHomes),
      evenHomeMost: Math.max(...sixHomes),
      sportCount: forEachSport(() => undefined),
    },
    table: {
      caption: `The first leg of a league of five teams. Every team meets every other once, and one team rests in each of the five rounds.`,
      columns: ["Round", "Match", "Match", "Sits out"],
      rows,
    },
    diagram: {
      kind: "roundRobinWheel",
      title: `Round ${numberWord(first)} of ${numberWord(TEAMS.length)} teams. ${capitalised(numberWord(TEAMS.length))} teams and an empty seat make ${numberWord(TEAMS.length + 1)} places. The empty seat stays where it is, the ${numberWord(TEAMS.length)} teams move one place round the loop every round, and each column of the picture is a match. Whoever meets the empty seat sits out.`,
      fixed: EMPTY_SEAT,
      rotating: [...TEAMS],
      round: first,
    },
    text: [],
  };
}

// ---- claims ----

const sideNames = (cell: string): [string, string] => {
  const m = /^(.+) v (.+)$/.exec(cell);
  if (m === null) throw new Error(`'${cell}' is not 'A v B'`);
  return [m[1]!, m[2]!];
};
const key = (a: string, b: string) => [a, b].sort().join("|");

interface Parsed {
  rows: { round: number; matches: [string, string][]; rests: string }[];
  teams: string[];
}
/** The printed schedule, read back: every round's matches (home first) and who sits out. */
function parse(r: ExampleResult): Parsed {
  const rows = (r.table?.rows ?? []).map((row) => ({
    round: Number(row[col(r, "Round")]),
    matches: [sideNames(String(row[1])), sideNames(String(row[2]))] as [string, string][],
    rests: String(row[3]),
  }));
  const teams = [...new Set(rows.flatMap((x) => [...x.matches.flat(), x.rests]))].sort();
  return { rows, teams };
}

const claims: Claim[] = [
  {
    says: "every pair of teams meets exactly once, nobody plays twice in a round, and in an odd field exactly one team sits out each round, each team once",
    source: "the definition of a single round robin; an odd field rests one team a round, and over the rounds each rests once",
    check: guarded((r) => {
      const { rows, teams } = parse(r);
      const n = teams.length;
      if (n < 3 || n % 2 === 0) return `${n} teams, the example is an odd field`;
      if (rows.length !== n) return `${rows.length} rounds for ${n} teams (an odd field plays ${n})`;
      const met = new Set<string>();
      const rested = new Map<string, number>();
      for (const [i, row] of rows.entries()) {
        if (row.round !== i + 1) return `row ${i + 1} is round ${row.round}`;
        const seats = [...row.matches.flat(), row.rests];
        if (new Set(seats).size !== n || seats.length !== n) return `round ${row.round} does not seat every team exactly once: ${seats.join(", ")}`;
        for (const [a, b] of row.matches) {
          if (met.has(key(a, b))) return `${a} meet ${b} twice`;
          met.add(key(a, b));
        }
        rested.set(row.rests, (rested.get(row.rests) ?? 0) + 1);
      }
      if (met.size !== (n * (n - 1)) / 2) return `${met.size} different pairs, expected ${(n * (n - 1)) / 2}`;
      for (const t of teams) if (rested.get(t) !== 1) return `${t} sits out ${rested.get(t) ?? 0} times`;
      return true;
    }),
  },
  {
    says: "no team plays more than one more home game than away, and the table's own counts are the post's",
    source: "the home-and-away fairness a schedule aims for: the two counts of any team differ by at most one; with an odd field they can be equal",
    check: guarded((r) => {
      const { rows, teams } = parse(r);
      if (teams.length === 0) return "no teams";
      const home = new Map<string, number>();
      const away = new Map<string, number>();
      for (const row of rows) for (const [h, a] of row.matches) { home.set(h, (home.get(h) ?? 0) + 1); away.set(a, (away.get(a) ?? 0) + 1); }
      for (const t of teams) {
        const h = home.get(t) ?? 0;
        const a = away.get(t) ?? 0;
        if (Math.abs(h - a) > 1) return `${t}: ${h} at home, ${a} away`;
        if (h !== Number(r.facts.homeEach) || a !== Number(r.facts.awayEach)) return `${t}: ${h} home and ${a} away, the post says ${String(r.facts.homeEach)} and ${String(r.facts.awayEach)}`;
      }
      return true;
    }),
  },
  {
    says: "the counts the post cites are the formulas': n(n-1)/2 matches a leg, n rounds for an odd n, half of n-1 teams' matches at home, twice that over two legs",
    source: "round-robin counting: n(n-1)/2 matches per leg; the circle method plays n rounds for an odd field of n (n-1 for an even one); n-1 matches per team split between home and away",
    check: guarded((r) => {
      const f = r.facts;
      const n = Number(f.fieldSize);
      if (!(n >= 3) || n % 2 === 0) return `fieldSize ${String(f.fieldSize)} is not an odd field`;
      const matches = (n * (n - 1)) / 2;
      if (Number(f.matches) !== matches) return `matches is ${String(f.matches)}, n(n-1)/2 is ${matches}`;
      if (Number(f.rounds) !== n) return `rounds is ${String(f.rounds)}, an odd field of ${n} plays ${n}`;
      if (Number(f.matchesPerRound) !== (n - 1) / 2) return `matchesPerRound is ${String(f.matchesPerRound)}, (n-1)/2 is ${(n - 1) / 2}`;
      if (Number(f.opponentsEach) !== n - 1) return `opponentsEach is ${String(f.opponentsEach)}, each team meets the other n-1 = ${n - 1}`;
      if (Number(f.homeEach) + Number(f.awayEach) !== n - 1) return `home and away are not the ${n - 1} matches of a team`;
      if (Number(f.twoLegMatches) !== 2 * matches) return `twoLegMatches is ${String(f.twoLegMatches)}, twice ${matches}`;
      if (Number(f.twoLegRounds) !== 2 * n) return `twoLegRounds is ${String(f.twoLegRounds)}, twice ${n}`;
      const tableTeams = parse(r).teams.length;
      return tableTeams === n || `the table has ${tableTeams} teams, fieldSize says ${n}`;
    }),
  },
  {
    says: "the second leg repeats the first with home and away swapped: its first round is round one's matches turned round, and the first leg's round one is the table's",
    source: "round-robin legs: a second leg replays the first with the home and away sides exchanged (the engine's `legs` rule: even legs mirror)",
    check: guarded((r) => {
      const first = parse(r).rows[0];
      if (first === undefined) return "no rounds";
      const turned = (m: [string, string][]) => m.map(([a, b]) => `${b} v ${a}`).join(", ");
      const same = (m: [string, string][]) => m.map(([a, b]) => `${a} v ${b}`).join(", ");
      if (r.facts.firstLegRoundOne !== same(first.matches)) return `firstLegRoundOne is '${String(r.facts.firstLegRoundOne)}', the table's round one is '${same(first.matches)}'`;
      return r.facts.secondLegRoundOne === turned(first.matches) || `secondLegRoundOne is '${String(r.facts.secondLegRoundOne)}', expected '${turned(first.matches)}'`;
    }),
  },
  {
    says: "a field of six plays five rounds of three matches, fifteen matches in all, each team at home two or three times: one team more adds a match to every round and no round",
    source: "round-robin counting for an even n: n-1 rounds, n/2 matches a round, n(n-1)/2 matches; a team's n-1 matches split between home and away to within one",
    check: guarded((r) => {
      const f = r.facts;
      const n = Number(f.evenFieldSize);
      if (!(n >= 4) || n % 2 !== 0) return `evenFieldSize ${String(f.evenFieldSize)} is not an even field`;
      if (Number(f.evenRounds) !== n - 1) return `evenRounds is ${String(f.evenRounds)}, an even field of ${n} plays ${n - 1}`;
      if (Number(f.evenMatchesPerRound) !== n / 2) return `evenMatchesPerRound is ${String(f.evenMatchesPerRound)}, n/2 is ${n / 2}`;
      if (Number(f.evenMatches) !== (n * (n - 1)) / 2) return `evenMatches is ${String(f.evenMatches)}, n(n-1)/2 is ${(n * (n - 1)) / 2}`;
      if (Number(f.evenHomeFewest) !== Math.floor((n - 1) / 2) || Number(f.evenHomeMost) !== Math.ceil((n - 1) / 2)) return `home games run ${String(f.evenHomeFewest)} to ${String(f.evenHomeMost)}, expected ${Math.floor((n - 1) / 2)} to ${Math.ceil((n - 1) / 2)}`;
      // The post's point: the field of six is the odd field's plus one team, and has the same number of rounds.
      return Number(f.evenFieldSize) === Number(f.fieldSize) + 1 && Number(f.evenRounds) === Number(f.rounds) || "the field of six is not the five plus one, or plays a different number of rounds";
    }),
  },
  {
    says: "the wheel is the circle method: the empty seat stays, the others sit in a loop, and each column pairs a team in the loop with the one opposite it; the team opposite the empty seat is the one the table sits out in that round",
    source: "the circle (Berger) method: one place stays fixed and the others rotate; with the fixed place empty, whoever meets it rests",
    check: guarded((r) => {
      const d = r.diagram;
      if (d === undefined || d.kind !== "roundRobinWheel") return "no wheel";
      const { rows } = parse(r);
      const row = rows.find((x) => x.round === d.round);
      if (row === undefined) return `the table has no round ${d.round}`;
      const loop = d.rotating;
      const m = loop.length; // the places in the loop, besides the fixed one
      if (m < 3 || m % 2 === 0) return `${m} places in the loop`;
      // The loop is read top row left to right, then the bottom row right to left: place j is opposite place m-2-j; the last place meets the fixed one.
      const pairs = new Set<string>();
      for (let j = 0; j <= (m - 3) / 2; j++) pairs.add(key(loop[j]!, loop[m - 2 - j]!));
      const printed = new Set(row.matches.map(([a, b]) => key(a, b)));
      if (pairs.size !== printed.size || [...pairs].some((p) => !printed.has(p))) return `the wheel pairs ${[...pairs].join(", ")}, the table's round ${d.round} is ${[...printed].join(", ")}`;
      if (d.fixed !== EMPTY_SEAT) return `the fixed place is '${d.fixed}', an odd field's is the empty seat`;
      if (loop[m - 1] !== row.rests) return `${String(loop[m - 1])} is opposite the empty seat, the table sits out ${row.rests}`;
      return [...loop].sort().join() === parse(r).teams.join() || "the loop does not hold exactly the table's teams";
    }),
  },
  captionClaim("the table's caption says what the example is: five teams, once each, five rounds", (f) => [
    `${numberWord(Number(f.fieldSize))} teams`,
    `${numberWord(Number(f.rounds))} rounds`,
  ]),
  {
    says: "the picture's caption says the key fact: the empty seat stays, the teams move one place a round, each column is a match, and whoever meets the empty seat sits out",
    source: "the example's own facts, read back into the diagram's title",
    check: guarded((r) => {
      const n = Number(r.facts.fieldSize);
      const round = r.diagram?.kind === "roundRobinWheel" ? r.diagram.round : Number.NaN;
      const want = `Round ${numberWord(round)} of ${numberWord(n)} teams. ${capitalised(numberWord(n))} teams and an empty seat make ${numberWord(n + 1)} places. The empty seat stays where it is, the ${numberWord(n)} teams move one place round the loop every round, and each column of the picture is a match. Whoever meets the empty seat sits out.`;
      return r.diagram?.title === want || `the picture's caption is '${r.diagram?.title ?? ""}', expected '${want}'`;
    }),
  },
  offeredInEverySportClaim("league", "league", "sportCount"),
];

export const roundRobinSchedule: BlogExample = {
  id: ROUND_ROBIN_SCHEDULE_ID,
  kind: "engine",
  sports: "all",
  build: () => build(),
  claims,
};
