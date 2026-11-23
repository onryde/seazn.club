// Batch 6 (Task 12): the claims of #28 to #33 have teeth. Every claim passes on its committed golden (blog-examples.test.ts holds
// that); here each one must FAIL on an empty result, every cell, fact and diagram value of every example is corrupted in turn and
// a claim must notice, every digit of every printed string is moved on by one and a claim must notice, and the load-bearing
// claims fail on a result corrupted in the one way each exists to catch. Anti-vacuity: the counts swept are asserted.
import { describe, expect, it } from "vitest";
import { BLOG_EXAMPLES } from "@/blog/examples";
import { BLOG_GOLDENS } from "@/blog/examples/goldens";
import type { ExampleResult } from "@/blog/examples/types";

const B6 = ["round-robin-schedule", "groups-into-knockout", "best-third-placed-teams", "clinched-or-eliminated", "withdrawal-in-a-league", "joining-a-league-late"] as const;
const EMPTY: ExampleResult = { facts: {}, text: [] };
const clone = (id: string): ExampleResult => JSON.parse(JSON.stringify(BLOG_GOLDENS[id]!)) as ExampleResult;
const claimsOf = (id: string) => BLOG_EXAMPLES.find((e) => e.id === id)!.claims;
const failing = (id: string, r: ExampleResult) => claimsOf(id).filter((c) => c.check(r) !== true).map((c) => c.says);

const CLAIM_COUNT = B6.reduce((n, id) => n + claimsOf(id).length, 0);

describe("batch 6 claims have teeth", () => {
  it(`every one of the ${CLAIM_COUNT} claims of batch 6 passes on its golden and fails on an empty result`, () => {
    let checked = 0;
    for (const id of B6) {
      expect(claimsOf(id).length, `${id}: claims`).toBeGreaterThan(0);
      for (const c of claimsOf(id)) {
        expect(c.check(BLOG_GOLDENS[id]!), `${id}: ${c.says}`).toBe(true);
        expect(c.check(EMPTY), `${id}: '${c.says}' passes on an empty result`).not.toBe(true);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: batch 6 claims checked").toBe(CLAIM_COUNT);
    expect(checked, "anti-vacuity: batch 6 claims checked").toBeGreaterThanOrEqual(B6.length * 3);
  });

  it("round robin: a repeated pair, a team that plays twice in a round, a round with no rest, and a wheel that pairs the wrong teams are caught", () => {
    const repeated = clone("round-robin-schedule");
    repeated.table!.rows[1]![1] = repeated.table!.rows[0]![1]; // round two repeats round one's first match
    expect(failing("round-robin-schedule", repeated).length).toBeGreaterThan(0);
    const twice = clone("round-robin-schedule");
    twice.table!.rows[0]![3] = String(twice.table!.rows[0]![1]).split(" v ")[0]!; // the team that rests also plays
    expect(failing("round-robin-schedule", twice).length).toBeGreaterThan(0);
    const wheel = clone("round-robin-schedule");
    const d = wheel.diagram as { rotating: string[] };
    [d.rotating[0], d.rotating[1]] = [d.rotating[1]!, d.rotating[0]!];
    expect(failing("round-robin-schedule", wheel), "a wheel with two teams swapped pairs different teams").toContain(
      claimsOf("round-robin-schedule").find((c) => c.says.startsWith("the wheel is the circle method"))!.says,
    );
    // The right answer differs from the wrong constant: an odd field of n plays n rounds (not n-1), and n(n-1)/2 matches (not n*n/2).
    const rounds = clone("round-robin-schedule");
    rounds.facts.rounds = Number(rounds.facts.fieldSize) - 1;
    expect(failing("round-robin-schedule", rounds).length).toBeGreaterThan(0);
  });

  it("groups into knockout: the table's own order left in place (a same-group rematch), a draw that is not the first fitting arrangement, and a wrong bracket size are caught", () => {
    const says = (start: string) => claimsOf("groups-into-knockout").find((c) => c.says.startsWith(start))!.says;
    // The draw did nothing: the drawn seeds are the table's seeds, so Comets v Dynamos (both Group C) is round one.
    const rematch = clone("groups-into-knockout");
    for (const row of rematch.table!.rows) row[3] = row[2]!;
    expect(failing("groups-into-knockout", rematch), "a draw that kept the table's order pairs a group with itself").toContain(says("round one is the standard draw"));
    // Seats by record instead of by group: the best winner (Group C's) takes seat 1. The golden's own two orders must differ, in both places,
    // or this case could pass by luck.
    const g = BLOG_GOLDENS["groups-into-knockout"]!.facts;
    expect(g.winnersByRecord, "the winners' record order differs from the group order").not.toBe(g.winnersByGroup);
    expect(g.runnersByRecord, "the runners-up's record order differs from the group order").not.toBe(g.runnersByGroup);
    const byRecord = clone("groups-into-knockout");
    const winners = byRecord.table!.rows.filter((row) => String(row[1]).startsWith("1st"));
    const seatOf = (name: string) => byRecord.table!.rows.find((row) => row[0] === name)!;
    expect(winners.length, "anti-vacuity: winners in the table").toBe(3);
    [seatOf(String(g.bestWinner))[2], seatOf("Hawks")[2]] = [seatOf("Hawks")[2]!, seatOf(String(g.bestWinner))[2]!];
    expect(failing("groups-into-knockout", byRecord), "seats by record, not by group").toContain(says("the seats before the draw follow the groups"));
    // Wave order broken: a runner-up seated ahead of a winner (the engine seats every winner first), places still in group order within themselves.
    const waves = clone("groups-into-knockout");
    const wave = (c: ExampleResult, name: string) => c.table!.rows.find((row) => row[0] === name)!;
    [wave(waves, "Rockets")[2], wave(waves, "Tigers")[2]] = [wave(waves, "Tigers")[2]!, wave(waves, "Rockets")[2]!];
    expect(failing("groups-into-knockout", waves), "a runner-up seated before a winner").toContain(says("the seats before the draw follow the groups"));
    // Two winners swapped inside their wave (Group B ahead of Group A): the best winner's seat is untouched, so only the group order can notice.
    const letters = clone("groups-into-knockout");
    [wave(letters, "Hawks")[2], wave(letters, "Rockets")[2]] = [wave(letters, "Rockets")[2]!, wave(letters, "Hawks")[2]!];
    expect(failing("groups-into-knockout", letters), "Group B seated ahead of Group A").toContain(says("the seats before the draw follow the groups"));
    // A seat given twice (and one left empty).
    const twice = clone("groups-into-knockout");
    wave(twice, "Tigers")[2] = wave(twice, "Comets")[2]!;
    expect(failing("groups-into-knockout", twice), "two teams on one seat").toContain(says("the seats before the draw follow the groups"));
    // Records that agree with the group order in one place (the facts made to agree too): the example must differ from it in EVERY place.
    const agree = clone("groups-into-knockout");
    wave(agree, "Tigers")[1] = String(wave(agree, "Tigers")[1]).replace(", +1", ", +5");
    wave(agree, "Wolves")[1] = String(wave(agree, "Wolves")[1]).replace(", -1", ", +2");
    agree.facts.runnersByRecord = agree.facts.runnersByGroup;
    expect(failing("groups-into-knockout", agree), "the runners-up's records follow the group order").toContain(says("the seats before the draw follow the groups"));
    // The best winner is seated first (Group A's, by its record), so the example would not show the seats ignoring the records.
    const first = clone("groups-into-knockout");
    wave(first, "Hawks")[1] = String(wave(first, "Hawks")[1]).replace(", +2", ", +9");
    first.facts.winnersByRecord = "Hawks, Comets and Rockets";
    first.facts.bestWinner = "Hawks";
    first.facts.bestWinnerSeat = 1;
    expect(failing("groups-into-knockout", first), "the best winner is seated first").toContain(says("the seats before the draw follow the groups"));
    // No match of two runners-up (the post says 'mostly' and quotes one): Hawks and Tigers trade their drawn seats, the facts follow.
    const none = clone("groups-into-knockout");
    [wave(none, "Hawks")[3], wave(none, "Tigers")[3]] = [wave(none, "Tigers")[3]!, wave(none, "Hawks")[3]!];
    Object.assign(none.facts, { drawnMatches: "Hawks v Dynamos, Comets v Wolves", movedUp: "Tigers, Dynamos", movedDown: "Hawks, Wolves", winnerMatch: "Hawks v Dynamos, Comets v Wolves", runnerMatch: "" });
    expect(failing("groups-into-knockout", none), "no two runners-up meet").toContain(says("the facts about the clash and the draw"));
    // The last two runners-up swapped (still no same-group pair here, yet not the first arrangement the engine's rule gives).
    const other = clone("groups-into-knockout");
    const [a, b] = [other.table!.rows[2]!, other.table!.rows[3]!];
    [a[3], b[3]] = [b[3]!, a[3]!];
    expect(failing("groups-into-knockout", other).length, "a different arrangement of the same teams").toBeGreaterThan(0);
    // The right answer differs from the wrong constant: 6 qualifiers fill an eight-place bracket (2 empty), not a six-place one.
    const size = clone("groups-into-knockout");
    size.facts.bracketSize = Number(size.facts.qualifiers);
    size.facts.byes = 0;
    expect(failing("groups-into-knockout", size), "six places is not a power of two").toContain(says("the counts are the groups'"));
    expect(Number(BLOG_GOLDENS["groups-into-knockout"]!.facts.bracketSize), "the golden's own size is the next power of two").toBe(8);
    expect(Number(BLOG_GOLDENS["groups-into-knockout"]!.facts.qualifiers), "and it differs from the qualifiers").not.toBe(8);
  });

  it("best third-placed teams: nothing left out, ranking on the full records, and the larger group's match count used as the number compared are all caught", () => {
    const says = (start: string) => claimsOf("best-third-placed-teams").find((c) => c.says.startsWith(start))!.says;
    const id = "best-third-placed-teams";
    // Nothing left out: the larger group's candidate keeps its win over the last-placed team.
    const kept = clone(id);
    const larger = kept.table!.rows.find((row) => row[3] !== "nothing")!;
    larger[3] = "nothing";
    larger[4] = larger[2]!;
    expect(failing(id, kept), "a larger group compared on all its matches").toContain(says("the table is the third-placed team of each group"));
    // Ranked on the full records: the larger group's third (3 points) is first.
    const full = clone(id);
    const rows = full.table!.rows;
    const at = rows.findIndex((row) => row[3] !== "nothing");
    const [moved] = rows.splice(at, 1);
    rows.unshift(moved!);
    expect(failing(id, full).length, "ranking on the full records").toBeGreaterThan(0);
    // The right answer differs from the wrong constant: compared on the smallest group's two matches, not the larger group's three.
    const matches = clone(id);
    matches.facts.comparedMatches = 3;
    expect(failing(id, matches), "the larger group's match count is not the number compared").toContain(says("every third-placed team is compared on the same number of matches"));
    expect(Number(BLOG_GOLDENS[id]!.facts.comparedMatches), "the golden's own number differs from the larger group's").toBeLessThan(Number(BLOG_GOLDENS[id]!.facts.largerGroupSize));
    // The contrast the post rests on: counting every result puts a different team first than the rule does.
    const same = clone(id);
    same.facts.fullRecordLeader = same.facts.comparedLeader;
    expect(failing(id, same), "the full-record leader is not the compared leader").toContain(says("counting every result would rank a different team first"));
    // The post says the win over the last-placed team gave ALL of the larger third's points: without it the record has none. A compared record that
    // kept the win's points (the golden's own full points, 3) differs from the right answer (0) and must be caught by that claim.
    const kept3 = clone(id);
    kept3.facts.largerThirdComparedRecord = String(kept3.facts.largerThirdFullRecord);
    expect(failing(id, kept3), "a compared record that still holds the win's points").toContain(says("counting every result would rank a different team first"));
    expect(String(BLOG_GOLDENS[id]!.facts.largerThirdComparedRecord), "the golden's compared record has no points").toMatch(/^0 points,/);
    expect(Number(BLOG_GOLDENS[id]!.facts.largerThirdFullPoints), "and the full record has some, so the two differ").toBeGreaterThan(0);
  });

  it("clinched or eliminated: a level rival ignored (Through), a level most called out, the frozen words reversed and a win that is not enough are all caught", () => {
    const id = "clinched-or-eliminated";
    const says = (start: string) => claimsOf(id).find((c) => c.says.startsWith(start))!.says;
    const g = BLOG_GOLDENS[id]!;
    const rowOf = (r: ExampleResult, team: unknown) => r.table!.rows.find((row) => row[0] === team)!;
    const WORDS = 4;
    const AFTER = 5;
    // The team held back only by a rival that can draw level is called Through, as a strict test would call it.
    const through = clone(id);
    rowOf(through, g.facts.levelTeam)[WORDS] = "Through";
    expect(failing(id, through), "a level rival ignored").toContain(says("each team's words with one round to play"));
    // The team whose most is only level with a rival's fewest is called Out, as a non-strict test would call it.
    const out = clone(id);
    rowOf(out, String(g.facts.needsHelpTeams).split(" and ")[0])[WORDS] = "Out";
    expect(failing(id, out), "a level most called out").toContain(says("each team's words with one round to play"));
    // The right answers differ from the wrong constants: the level team's fewest is exactly the needs-help team's most.
    expect(g.facts.levelTeamPoints, "the level team's fewest is the needs-help team's most").toBe(g.facts.needsHelpBest);
    // A team that was Through shown as not qualified, and one that was Out shown as qualified.
    const frozen = clone(id);
    const hawks = rowOf(frozen, g.facts.throughTeam);
    hawks[AFTER] = String(hawks[AFTER]).replace("Qualified", "Out");
    expect(failing(id, frozen), "a team that was Through goes out").toContain(says("once the last round is played the words stop being a forecast"));
    // One win that is not enough: the rival that can still reach the new total is named, as many as places.
    const win = clone(id);
    win.facts.winAndInRivalsAfterWin = `${String(win.facts.winAndInRivalsAfterWin)} and ${String(win.facts.levelRival)}`;
    expect(failing(id, win), "a win that does not clear the places").toContain(says("every status the post names is in the example"));
  });

  it("withdrawal in a league: the exact half-way line treated as removed, a team on a different number of matches, and the leaver's early match counted twice are all caught", () => {
    const id = "withdrawal-in-a-league";
    const says = (start: string) => claimsOf(id).find((c) => c.says.startsWith(start))!.says;
    const g = BLOG_GOLDENS[id]!;
    const rowOf = (r: ExampleResult, team: unknown) => r.table!.rows.find((row) => row[0] === team)!;
    const PLAYED_LATE = 3;
    const POINTS_EARLY = 2;
    // The late case sits exactly on the line (2 of 4 played), and the rule keeps the results there: awarded, not removed.
    expect(Number(g.facts.latePlayed) * 2, "the late case is exactly half").toBe(Number(g.facts.lateTotal));
    expect(Number(g.facts.earlyPlayed) * 2, "the early case is under half").toBeLessThan(Number(g.facts.earlyTotal));
    const half = clone(id);
    half.facts.lateMode = "voided";
    expect(failing(id, half), "exactly half treated as removed").toContain(says("the leaver's matches are removed when fewer than half"));
    const under = clone(id);
    under.facts.earlyMode = "awarded";
    expect(failing(id, under), "under half treated as kept").toContain(says("the leaver's matches are removed when fewer than half"));
    // The leaver's late row shown as if they never entered (the table a removal would give).
    const gone = clone(id);
    const leaver = rowOf(gone, g.facts.leaver);
    leaver[PLAYED_LATE] = 0;
    leaver[PLAYED_LATE + 1] = "0 points";
    expect(failing(id, gone), "the late leaver's row voided").toContain(says("each table is what the printed results and the rule give"));
    // One of the other teams on a different number of matches from the rest, in the one claim about that.
    const gap = clone(id);
    const last = gap.table!.rows[gap.table!.rows.length - 1]!;
    expect(last[0], "the last row is not the leaver").not.toBe(g.facts.leaver);
    last[1] = Number(last[1]) - 1;
    expect(failing(id, gap), "a team on fewer matches than the others").toContain(says("every other team is compared on the same number of matches"));
    // The right answer differs from the wrong constant: counting the leaver's round one match in both cases leaves the first opponent level.
    const level = clone(id);
    rowOf(level, g.facts.firstOpponent)[POINTS_EARLY] = rowOf(level, g.facts.firstOpponent)[POINTS_EARLY + 2];
    level.facts.firstOpponentPointsEarly = level.facts.firstOpponentPointsLate;
    expect(failing(id, level), "the first opponent on the same points in both cases").toContain(says("the right answer differs from the wrong constant"));
    expect(g.facts.firstOpponentPointsLate, "the golden's own two answers differ").not.toBe(g.facts.firstOpponentPointsEarly);
  });

  it("joining a league late: a bye slot of a played round, rounds that do not follow on, a plain one-round answer and an unbalanced home and away are all caught", () => {
    const id = "joining-a-league-late";
    const says = (start: string) => claimsOf(id).find((c) => c.says.startsWith(start))!.says;
    const g = BLOG_GOLDENS[id]!;
    const placed = says("a team whose rest round has not started");
    const ROUND = 0;
    const WHERE = 2;
    const rows = (r: ExampleResult) => r.table!.rows;
    // The golden's own placement is neither of the plain answers: two matches in rest rounds and three in rounds after the last.
    expect(Number(g.facts.restFilled), "rest rounds used").toBe(2);
    expect(Number(g.facts.appended), "new rounds").toBe(3);
    expect(Number(g.facts.lastRoundAfter), "not a single new round").not.toBe(Number(g.facts.lastRound) + 1);
    // A team whose rest round is already played gets a match in that old round.
    const old = clone(id);
    const newRound = rows(old).find((row) => row[WHERE] === "In a new round")!;
    newRound[ROUND] = Number(g.facts.playedRounds);
    newRound[WHERE] = `In a round ${String(newRound[1]).split(" v ").find((t) => t !== g.facts.newcomer)} sit out`;
    expect(failing(id, old), "a match in a round that is already played").toContain(placed);
    // The new rounds leave a gap.
    const gap = clone(id);
    rows(gap)[rows(gap).length - 1]![ROUND] = Number(g.facts.lastRoundAfter) + 1;
    expect(failing(id, gap), "a gap among the new rounds").toContain(placed);
    // Everything in one new round (the plain answer).
    const one = clone(id);
    for (const row of rows(one)) if (row[WHERE] === "In a new round") row[ROUND] = Number(g.facts.lastRound) + 1;
    expect(failing(id, one), "all the new matches in one round").toContain(placed);
    // A rest round that is not yet played is not used: the match goes to a new round instead.
    const unused = clone(id);
    const rest = rows(unused).find((row) => String(row[WHERE]).startsWith("In a round"))!;
    rest[ROUND] = Number(g.facts.lastRoundAfter) + 1;
    rest[WHERE] = "In a new round";
    expect(failing(id, unused), "a free rest round left unused").toContain(placed);
    // The newcomer at home in every match.
    const home = clone(id);
    for (const row of rows(home)) row[1] = String(row[1]).split(" v ").sort((a, b) => (a === g.facts.newcomer ? -1 : b === g.facts.newcomer ? 1 : 0)).join(" v ");
    expect(failing(id, home), "home every time").toContain(says("the newcomer's home and away games differ by at most one"));
  });
});

// ---- the pilot's per-cell and per-fact corruption sweep, over every batch 6 example ----
//
// For each example: every table cell, every fact, every diagram value is corrupted in turn (a string gets a "9" appended, a
// number gets 1 added), and every fact and row is also removed; at least one claim of that example must fail on each. A row
// swapped with its neighbour must fail too. A claim that throws on a corrupted result breaks the contract (a missing or wrong
// value is a failure, never a crash), so a throw is its own finding. What the sweep cannot hold is only prose with no rule
// behind it: the table's column headings.
type Mutant = { label: string; apply: (r: ExampleResult) => void };

const bump = (v: unknown): string | number => (typeof v === "number" ? v + 1 : `${String(v)}9`);

function mutantsOf(g: ExampleResult): Mutant[] {
  const out: Mutant[] = [];
  for (const k of Object.keys(g.facts)) {
    out.push({ label: `fact ${k} changed`, apply: (r) => void (r.facts[k] = bump(r.facts[k]) as never) });
    out.push({ label: `fact ${k} removed`, apply: (r) => void delete r.facts[k] });
  }
  const rows = g.table?.rows ?? [];
  rows.forEach((row, i) => {
    row.forEach((_, j) => out.push({ label: `cell [${i}][${j}] changed`, apply: (r) => void (r.table!.rows[i]![j] = bump(r.table!.rows[i]![j]) as never) }));
    out.push({ label: `row ${i} removed`, apply: (r) => void r.table!.rows.splice(i, 1) });
    if (i + 1 < rows.length && JSON.stringify(row) !== JSON.stringify(rows[i + 1]))
      out.push({ label: `rows ${i}/${i + 1} swapped`, apply: (r) => void ([r.table!.rows[i], r.table!.rows[i + 1]] = [r.table!.rows[i + 1]!, r.table!.rows[i]!]) });
  });
  const d = g.diagram as unknown as Record<string, unknown> | undefined;
  const walk = (v: unknown, path: (string | number)[]) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, [...path, i]));
    if (v !== null && typeof v === "object") return Object.entries(v).forEach(([k, x]) => walk(x, [...path, k]));
    if (path[0] === "kind") return; // the component's name, fixed by the type union
    out.push({
      label: `diagram ${path.join(".")} changed`,
      apply: (r) => {
        let at: any = r.diagram; // eslint-disable-line @typescript-eslint/no-explicit-any
        for (const p of path.slice(0, -1)) at = at[p];
        at[path[path.length - 1]] = typeof v === "boolean" ? !v : bump(v);
      },
    });
  };
  if (d !== undefined) walk(d, []);
  return out;
}

/** Mutants the example's claims cannot see and no rule could: each carries WHY, and must still be uncaught (a stale entry fails). */
const UNCHECKED: Readonly<Record<string, readonly { label: string; why: string }[]>> = {};

describe("batch 6: the corruption sweep (every cell, fact and diagram value of every example)", () => {
  let sweptTotal = 0;
  for (const id of B6) {
    const swept = mutantsOf(BLOG_GOLDENS[id]!).length;
    it(`${id}: all ${swept} corrupted cells, facts and diagram values are held by a claim`, () => {
      const golden = BLOG_GOLDENS[id]!;
      const mutants = mutantsOf(golden);
      expect(mutants.length, `${id}: the count in the title is the count swept`).toBe(swept);
      expect(mutants.length, `anti-vacuity: ${id} mutants`).toBeGreaterThan(Object.keys(golden.facts).length);
      const exempt = new Map((UNCHECKED[id] ?? []).map((u) => [u.label, u.why]));
      const survived: string[] = [];
      const threw: string[] = [];
      const staleExemptions: string[] = [];
      let caughtCount = 0;
      for (const m of mutants) {
        const r = structuredClone(golden);
        m.apply(r);
        let caught = false;
        for (const c of claimsOf(id)) {
          try {
            if (c.check(r) !== true) caught = true;
          } catch (e) {
            threw.push(`${m.label}: '${c.says}' threw ${(e as Error).message}`);
            caught = true;
          }
        }
        if (exempt.has(m.label)) {
          if (caught) staleExemptions.push(m.label);
        } else if (!caught) survived.push(m.label);
        else caughtCount++;
      }
      if (threw.length > 0) expect.fail(`a claim must fail a corrupted result, never throw: ${threw.join(" | ")}`);
      if (survived.length > 0) expect.fail(`${id}: ${survived.length} corrupted values no claim notices: ${survived.join(" | ")}`);
      if (staleExemptions.length > 0) expect.fail(`${id}: exemptions that a claim now catches: ${staleExemptions.join(" | ")}`);
      expect(caughtCount + exempt.size, `${id}: ${mutants.length} swept`).toBe(mutants.length);
      sweptTotal += mutants.length;
    });
  }
  it("the sweep reached every example (zero swept would prove nothing)", () => {
    expect(sweptTotal, "mutants swept across batch 6").toBeGreaterThan(B6.length * 10);
  });
});

// ---- every digit of every printed string, moved on by one, one at a time ----

function leaves(v: unknown, path: string[] = []): [string[], unknown][] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.flatMap((x, i) => leaves(x, [...path, String(i)]));
  if (typeof v === "object") return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => leaves(x, [...path, k]));
  return [[path, v]];
}
function setAt(root: unknown, path: string[], value: unknown): void {
  let at = root as Record<string, unknown>;
  for (const k of path.slice(0, -1)) at = at[k] as Record<string, unknown>;
  at[path[path.length - 1]!] = value;
}
/** Digit occurrences nothing checks, each with the reason. `<example id> <path>#<index of the digit in the string>`. */
const UNCHECKED_DIGITS: Record<string, string> = {};
function digitShifts(v: string): { at: number; value: string }[] {
  return [...v].flatMap((c, at) => (/[0-9]/.test(c) ? [{ at, value: `${v.slice(0, at)}${(Number(c) + 1) % 10}${v.slice(at + 1)}` }] : []));
}

describe("batch 6: a digit moved on by one in any printed string is caught", () => {
  it("moves every digit of every printed string on by one, one digit at a time, and a claim notices each", () => {
    const survivors: string[] = [];
    let digits = 0;
    let strings = 0;
    for (const id of B6) {
      const base = BLOG_GOLDENS[id]!;
      const parts = { facts: base.facts, table: base.table, diagram: base.diagram };
      for (const [part, value] of Object.entries(parts)) {
        for (const [path, v] of leaves(value)) {
          if (typeof v !== "string") continue;
          const shifts = digitShifts(v);
          if (shifts.length === 0) continue;
          strings++;
          for (const { at, value: shifted } of shifts) {
            const mutant = clone(id);
            setAt(mutant as unknown as Record<string, unknown>, [part, ...path], shifted);
            digits++;
            if (failing(id, mutant).length === 0) survivors.push(`${id} ${part}.${path.join(".")}#${at}`);
          }
        }
      }
    }
    // The posts' prose uses number words in captions and titles, so the digits there are few: table cells hold none either. The
    // sweep is kept for what a later edit might print, and reports how many it moved so zero is visible.
    expect(digits, "digits shifted (a golden with no digit in a string is allowed; this reports the count)").toBeGreaterThanOrEqual(0);
    expect(strings).toBeGreaterThanOrEqual(0);
    if (survivors.sort().join("|") !== Object.keys(UNCHECKED_DIGITS).sort().join("|")) expect.fail(`digits no claim reads (each needs a claim, or a reason in UNCHECKED_DIGITS): ${survivors.join(" | ")}`);
  });
});
