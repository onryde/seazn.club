// Post #15, "Can a player join or leave a Swiss tournament after round one?". Six chess players start a four-round Swiss;
// Fay leaves once round 2 is paired, and Gil is added late and joins from round 3. Everything is the app's own path
// (swiss-run.ts): the round's field (`swissFieldForRound`) leaves Gil out until his first round, the engine's Swiss
// withdrawal rule (`withdrawTableEntrant`) decides what happens to Fay's paired board, and later rounds are paired without
// her. Every score is read back through the app's read fold and paid by the web's one rules loader.
//
// The fixture lists the players in sign-up order, Gil last (he is added late), with seeds that are neither that order nor the
// alphabet's (swiss-claims.ts seedsIndistinguishable).
//
// Chess only, with the reason: neither rule reads the sport (the round's field and the withdrawal rule take none), and the
// example-wide claim sweeps the registry for the Swiss format being offered to every sport.
import { forEachSport } from "@seazn/engine/testkit";
import { BYE_CELL, captionClaim, col, floatRuleProblem, guarded, offeredInEverySportClaim, parseSeededLabel, scoreOf, seededLabel, seedReader, type PairedRound, type Seeded } from "./swiss-claims";
import { declaredBestWin } from "./swiss-bye";
import { moduleOf, roundDiagram, runSwiss, startingCfg, swissRules, walkover, type BoardResult } from "./swiss-run";
import type { BlogExample, Claim, ExampleResult } from "./types";

export const SWISS_LATE_AND_WITHDRAW_ID = "swiss-late-and-withdraw";

/** The fixture: the six who start, then the late entrant last, each with the seed the organiser gave. */
export const SWISS_LATE_FIXTURE: readonly Seeded[] = [
  { name: "Dev", seed: 3 },
  { name: "Fay", seed: 1 },
  { name: "Ben", seed: 5 },
  { name: "Eve", seed: 2 },
  { name: "Ana", seed: 6 },
  { name: "Cy", seed: 7 },
  { name: "Gil", seed: 4 },
];
const seedOf = seedReader(SWISS_LATE_FIXTURE);
const LATE = { name: "Gil", firstRound: 3 } as const;
const LEAVER = { name: "Fay", round: 2 } as const;
const ROUNDS = 4;
/** Which side wins each board, round by round: the fixture's own input (a walked-over board ignores it). */
const PLAN: Record<number, BoardResult[]> = {
  1: ["home", "draw", "away"],
  2: ["home", "home", "home"],
  3: ["away", "home", "draw"],
  4: ["home", "draw", "home"],
};

const NOT_YET = "Not entered yet";
const LEFT = "Left";
const roundColumn = (r: number) => `Round ${r}`;
const COLUMNS = ["Player", ...Array.from({ length: ROUNDS }, (_, i) => roundColumn(i + 1)), "Total"];

/** `fixture` is a parameter so a test can build the same example on other seeds and see the table move. */
export function buildSwissLate(fixture: readonly Seeded[] = SWISS_LATE_FIXTURE): ExampleResult {
  const seed = seedReader(fixture);
  const everyone: { id: string; name: string; seed: number; firstRound?: number }[] = fixture.map((p) => ({
    id: p.name.toLowerCase(),
    name: p.name,
    seed: p.seed,
    ...(p.name === LATE.name ? { firstRound: LATE.firstRound } : {}),
  }));
  const run = runSwiss({
    stageId: "blog-example:swiss-late-and-withdraw",
    sportKey: "boardgame",
    rounds: ROUNDS,
    entrants: everyone,
    withdrawnAfterPairing: { entrant: LEAVER.name.toLowerCase(), round: LEAVER.round },
    result: (r, b) => {
      const want = PLAN[r]?.[b - 1];
      if (want === undefined) throw new Error(`swiss-late-and-withdraw: no planned result for round ${r} board ${b}`);
      return want;
    },
  });
  const cells = new Map<string, string[]>(everyone.map((e) => [e.id, []]));
  const text: string[] = [];
  for (const round of run.rounds) {
    const done = new Set<string>();
    for (const b of round.boards) {
      const [h, a] = [run.name(b.home), run.name(b.away)];
      if (b.walkoverTo !== undefined) {
        const winner = b.walkoverTo;
        const leaver = winner === b.home ? b.away : b.home;
        cells.get(winner)!.push(`Won without playing (${run.name(leaver)} left)`);
        cells.get(leaver)!.push(`${LEFT}: ${run.name(winner)} wins without playing`);
        text.push(`Round ${round.round}: ${run.name(leaver)} left after the round was paired, so ${run.name(winner)} wins that board without playing.`);
      } else if (b.result === "draw") {
        cells.get(b.home)!.push(`Drew with ${a}`);
        cells.get(b.away)!.push(`Drew with ${h}`);
      } else {
        const [w, l] = b.result === "home" ? [b.home, b.away] : [b.away, b.home];
        cells.get(w)!.push(`Beat ${run.name(l)}`);
        cells.get(l)!.push(`Lost to ${run.name(w)}`);
      }
      done.add(b.home).add(b.away);
    }
    if (round.bye !== null) {
      cells.get(round.bye.entrant)!.push(BYE_CELL);
      done.add(round.bye.entrant);
    }
    for (const e of everyone) {
      if (done.has(e.id)) continue;
      cells.get(e.id)!.push(round.round < (e.firstRound ?? 1) ? NOT_YET : LEFT);
    }
  }
  const final = run.rounds[run.rounds.length - 1]!.after;
  // Best seed first, whatever the sign-up order and whenever the player joined.
  const rows = [...everyone].sort((a, b) => a.seed - b.seed).map((e) => [seededLabel(e.name, e.seed), ...cells.get(e.id)!, run.points(final.get(e.id) ?? 0)]);
  const late = LATE.name.toLowerCase();
  const leaver = LEAVER.name.toLowerCase();
  const leftBoard = run.rounds[LEAVER.round - 1]!.boards.find((b) => b.walkoverTo !== undefined);
  if (leftBoard === undefined || run.withdrawal === null) throw new Error("swiss-late-and-withdraw: the leaver's board was not walked over");
  const lateBefore = run.rounds[LATE.firstRound - 2]!.after.get(late) ?? 0;
  const facts: ExampleResult["facts"] = {
      playerCount: fixture.length - 1,
      roundCount: run.rounds.length,
      sportCount: forEachSport(() => undefined),
      lateName: LATE.name,
      lateFirstRound: LATE.firstRound,
      lateMissedRounds: LATE.firstRound - 1,
      lateScoreBeforeFirst: run.points(lateBefore),
      lateTotal: run.points(final.get(late) ?? 0),
      leaverName: LEAVER.name,
      leaverRound: LEAVER.round,
      leaverTotal: run.points(final.get(leaver) ?? 0),
      walkoverWinner: run.name(leftBoard.walkoverTo!),
      fieldAfterLeaving: run.rounds[LEAVER.round]!.field.length,
      // The players who started, are still in, and play the round after the leaver left: the field without the latecomer.
      regularsAfterLeaving: run.rounds[LEAVER.round]!.field.filter((id) => id !== late).length,
  };
  const label = (id: string) => seededLabel(run.name(id), seed(run.name(id)));
  return {
    facts,
    table: {
      caption: `A ${facts.roundCount}-round chess Swiss: ${String(facts.leaverName)} leaves once round ${facts.leaverRound} is paired, and ${String(facts.lateName)} joins from round ${facts.lateFirstRound}. Players are listed best seed first, and the number in brackets is the seed.`,
      columns: COLUMNS,
      rows,
    },
    diagram: roundDiagram(
      run,
      LATE.firstRound,
      `Round ${LATE.firstRound}: ${LATE.name} plays a first game, and ${LEAVER.name}, who left once round ${LEAVER.round} was paired, is not seated. The other ${run.rounds[LATE.firstRound - 1]!.field.length - 1} players are paired as usual.`,
      label,
      { notSeated: [{ name: label(leaver), why: `left after round ${LEAVER.round} was paired` }] },
    ),
    text,
  };
}

// ---- claims: each reads the committed grid and checks it against the rule it names ----

type Grid = Map<string, { rounds: string[]; total: number; printed: number }>;
function gridOf(r: ExampleResult): Grid {
  const p = col(r, "Player");
  const t = col(r, "Total");
  const rs = Array.from({ length: ROUNDS }, (_, i) => col(r, roundColumn(i + 1)));
  return new Map(
    (r.table?.rows ?? []).map((row) => {
      const who = parseSeededLabel(row[p]!);
      return [who.name, { rounds: rs.map((i) => String(row[i])), total: scoreOf(row[t]!), printed: who.seed }];
    }),
  );
}
/** What a cell scores: FIDE Laws of Chess art. 10.1 (win 1, draw ½, loss 0), C.04.1 (2026) rule 3 (a bye, a win's points), and a
 *  game won because the opponent left counts as a win; a round not played (not entered yet, or after leaving) scores 0. */
function cellScore(cell: string): number {
  if (/^Beat /.test(cell) || /^Won without playing/.test(cell) || cell === BYE_CELL) return 1;
  if (/^Drew with /.test(cell)) return 0.5;
  if (/^Lost to /.test(cell) || cell === NOT_YET || cell.startsWith(LEFT)) return 0;
  return Number.NaN;
}
const opponentIn = (cell: string): string | null => /^(?:Beat|Lost to|Drew with) (.+)$/.exec(cell)?.[1] ?? null;

/** The rounds as the grid prints them: who was seated, who each player met, and the points going in (a round not played scores 0). */
function roundsOf(r: ExampleResult): PairedRound[] {
  const g = gridOf(r);
  const out: PairedRound[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    const score = new Map<string, number>();
    const pairs = new Map<string, [string, string]>();
    let bye: string | null = null;
    for (const [p, row] of g) {
      const cell = row.rounds[i]!;
      if (cell === NOT_YET || cell === LEFT) continue;
      score.set(
        p,
        row.rounds.slice(0, i).reduce((a, c) => a + cellScore(c), 0),
      );
      if (cell === BYE_CELL) bye = p;
      const other = opponentIn(cell) ?? /^Won without playing \((.+) left\)$/.exec(cell)?.[1] ?? /^Left: (.+) wins without playing$/.exec(cell)?.[1] ?? null;
      if (other !== null) pairs.set([p, other].sort().join("|"), [p, other]);
    }
    out.push({ round: i + 1, score, pairs: [...pairs.values()], bye });
  }
  return out;
}

const claims: Claim[] = [
  {
    says: "every total is the sum of the player's rounds: 1 a win or a bye, ½ a draw, 0 a loss or a round not played",
    source: "FIDE Laws of Chess art. 10.1; FIDE Handbook C.04.1 (2026) rule 3 (a bye scores a win); C.04.2 (2026) art. 2.4 (a round a late entrant missed scores 0)",
    check: guarded((r) => {
      const g = gridOf(r);
      if (g.size !== SWISS_LATE_FIXTURE.length) return `${g.size} players listed`;
      for (const [p, row] of g) {
        const sum = row.rounds.reduce((a, c) => a + cellScore(c), 0);
        if (Number.isNaN(sum)) return `${p}: a cell reads as no result (${row.rounds.join(" | ")})`;
        if (sum !== row.total) return `${p}: rounds add to ${sum}, the total is ${row.total}`;
      }
      return true;
    }),
  },
  {
    says: "a late player is in no round before their first: they miss it and score nothing for it, then are paired like everyone else",
    source: "FIDE Handbook C.04.2 (2026) art. 2.4 (a player joining late scores 0 for the rounds missed); the app's round field (a late entrant joins from their first round)",
    check: guarded((r) => {
      const row = gridOf(r).get(LATE.name);
      if (row === undefined) return "no late player";
      for (let i = 0; i < LATE.firstRound - 1; i++) if (row.rounds[i] !== NOT_YET) return `${LATE.name} round ${i + 1}: ${row.rounds[i]}`;
      for (let i = LATE.firstRound - 1; i < ROUNDS; i++) if (row.rounds[i] === NOT_YET || row.rounds[i]!.startsWith(LEFT)) return `${LATE.name} round ${i + 1}: ${row.rounds[i]}`;
      return String(r.facts.lateScoreBeforeFirst) === "0" || `the late player starts on ${String(r.facts.lateScoreBeforeFirst)}`;
    }),
  },
  {
    says: "a player who leaves keeps every result already played, and is in no pairing after leaving",
    source: "the Swiss withdrawal rule (engine withdrawTableEntrant): played results stand, later rounds pair without the player (FIDE Handbook C.04.2 (2026) art. 3.2: a withdrawn player is not paired again)",
    check: guarded((r) => {
      const row = gridOf(r).get(LEAVER.name);
      if (row === undefined) return "no leaver";
      for (let i = 0; i < LEAVER.round - 1; i++) if (Number.isNaN(cellScore(row.rounds[i]!)) || row.rounds[i]!.startsWith(LEFT)) return `${LEAVER.name} round ${i + 1} was struck: ${row.rounds[i]}`;
      const kept = row.rounds.slice(0, LEAVER.round - 1).reduce((a, c) => a + cellScore(c), 0);
      if (kept === 0) return "the leaver scored nothing before leaving, so this case cannot show a kept result";
      for (let i = LEAVER.round - 1; i < ROUNDS; i++) if (!row.rounds[i]!.startsWith(LEFT)) return `${LEAVER.name} round ${i + 1}: ${row.rounds[i]}`;
      return row.total === kept || `${LEAVER.name}'s total ${row.total}, the kept results give ${kept}`;
    }),
  },
  {
    says: "the board the leaver was already paired on is won by the opponent without playing, and scores them a win",
    source: "the Swiss withdrawal rule (engine withdrawTableEntrant): the paired board is walked over to the opponent and scores them a win; FIDE Handbook C.07 (2026) art. 16.2 category 2 reads a forfeit win as a win",
    check: guarded((r) => {
      const g = gridOf(r);
      const i = LEAVER.round - 1;
      const winners = [...g].filter(([, row]) => row.rounds[i] === `Won without playing (${LEAVER.name} left)`);
      if (winners.length !== 1) return `${winners.length} players won without playing in round ${LEAVER.round}`;
      return winners[0]![0] === String(r.facts.walkoverWinner) || `the post names ${String(r.facts.walkoverWinner)}`;
    }),
  },
  {
    says: "nobody meets the same opponent twice, and each round seats every player in its field once",
    source: "FIDE Handbook C.04.1 (2026) rule 2 (no rematch) and rule 3 (a bye is the one unpaired player of an odd field, so one at most per round)",
    check: guarded((r) => {
      const g = gridOf(r);
      const met = new Set<string>();
      for (let i = 0; i < ROUNDS; i++) {
        let byes = 0;
        for (const [p, row] of g) {
          const o = opponentIn(row.rounds[i]!);
          if (row.rounds[i] === BYE_CELL) byes++;
          if (o === null) continue;
          const back = g.get(o)?.rounds[i];
          if (back === undefined || opponentIn(back) !== p) return `round ${i + 1}: ${p} v ${o} is not on both rows`;
          const k = [p, o].sort().join("|");
          if (p < o) {
            if (met.has(k)) return `${p} and ${o} meet twice`;
            met.add(k);
          }
        }
        if (byes > 1) return `round ${i + 1} has ${byes} byes`;
      }
      return met.size > 0 || "no games";
    }),
  },
  {
    says: "the seed printed beside each player is that player's seed in the fixture",
    source: "the example's fixture (the seeds the organiser gave), read back from the table",
    check: guarded((r) => {
      let n = 0;
      for (const [p, row] of gridOf(r)) {
        if (row.printed !== seedOf(p)) return `${p}: printed seed ${row.printed}, the fixture has ${seedOf(p)}`;
        n++;
      }
      return n > 0 || "no players";
    }),
  },
  {
    says: "each round from round 2 floats as few players out of each score group as any rematch-free pairing can, taking the groups from the top (the round a late player joins and a leaver is gone is where this differs from the fewest floats over the whole round)",
    source: "the engine's own statement of the rule (scheduling/swiss.js header: each score group is paired in turn from the top and moves the fewest players to the next) under FIDE Handbook C.04.3 [C1] no rematch; brute force over every rematch-free pairing, never the engine",
    check: guarded((r) => {
      const { problem, checked } = floatRuleProblem(roundsOf(r));
      return problem ?? (checked >= ROUNDS - 1 || `${checked} rounds checked, the example plays ${ROUNDS - 1} after the first`);
    }),
  },
  {
    says: "the post's facts are the grid's: who starts, who joins late and from which round, what each ends on, who leaves and after which round, and the fields after the leaver goes",
    source: "the committed grid (FIDE Laws of Chess art. 10.1 points) and the example's fixture",
    check: guarded((r) => {
      const g = gridOf(r);
      const f = r.facts;
      const rounds = (name: string) => g.get(name)?.rounds ?? [];
      const late = [...g].filter(([, row]) => row.rounds[0] === NOT_YET).map(([p]) => p);
      if (late.length !== 1) return `${late.length} players miss round 1, the post names one`;
      const missed = rounds(late[0]!).filter((c) => c === NOT_YET).length;
      const leavers = [...g].filter(([, row]) => row.rounds[ROUNDS - 1]!.startsWith(LEFT)).map(([p]) => p);
      if (leavers.length !== 1) return `${leavers.length} players have left by the last round, the post names one`;
      const leftAt = rounds(leavers[0]!).findIndex((c) => c.startsWith(`${LEFT}:`)) + 1;
      if (leftAt === 0) return `${leavers[0]}: no round where the walkover is booked`;
      const seatedAfter = [...g].filter(([, row]) => row.rounds[leftAt] !== undefined && row.rounds[leftAt] !== NOT_YET && row.rounds[leftAt] !== LEFT).map(([p]) => p);
      const checks: [string, unknown, unknown][] = [
        ["playerCount", f.playerCount, g.size - late.length],
        ["roundCount", f.roundCount, ROUNDS],
        ["lateName", f.lateName, late[0]],
        ["lateFirstRound", f.lateFirstRound, missed + 1],
        ["lateMissedRounds", f.lateMissedRounds, missed],
        ["leaverName", f.leaverName, leavers[0]],
        ["leaverRound", f.leaverRound, leftAt],
        ["fieldAfterLeaving", f.fieldAfterLeaving, seatedAfter.length],
        ["regularsAfterLeaving", f.regularsAfterLeaving, seatedAfter.filter((p) => p !== late[0]).length],
      ];
      for (const [k, got, want] of checks) if (String(got) !== String(want)) return `${k} is '${String(got)}', the grid gives '${String(want)}'`;
      const total = scoreOf(String(f.leaverTotal));
      if (Number.isNaN(total) || total !== g.get(leavers[0]!)!.total) return `leaverTotal is '${String(f.leaverTotal)}', the grid gives ${g.get(leavers[0]!)!.total}`;
      const lateTotal = scoreOf(String(f.lateTotal));
      if (Number.isNaN(lateTotal) || lateTotal !== g.get(late[0]!)!.total) return `lateTotal is '${String(f.lateTotal)}', the grid gives ${g.get(late[0]!)!.total}`;
      return true;
    }),
  },
  {
    says: "the diagram draws the grid's own round: the same boards, colours and points going in, and names the player it leaves out",
    source: "the committed grid (the diagram is drawn from the same run)",
    check: guarded((r) => {
      const d = r.diagram;
      if (d === undefined || d.kind !== "swissRound") return "no Swiss round diagram";
      const round = roundsOf(r).find((x) => x.round === d.round);
      if (round === undefined) return `the grid has no round ${d.round}`;
      const label = (n: string) => seededLabel(n, seedOf(n));
      if (d.pairings.length !== round.pairs.length) return `${d.pairings.length} boards drawn, the grid has ${round.pairs.length}`;
      const g0 = gridOf(r);
      for (const [i, p] of d.pairings.entries()) {
        if (p.board !== i + 1) return `the ${i + 1}th board is drawn as board ${p.board}`;
        const first = parseSeededLabel(p.first).name;
        const second = parseSeededLabel(p.second ?? "").name;
        const cell = g0.get(first)?.rounds[d.round - 1] ?? "";
        const want = cell.startsWith("Beat ") ? "1 — 0" : cell.startsWith("Lost to ") ? "0 — 1" : cell.startsWith("Drew with ") ? "½ — ½" : null;
        if (want === null) return `board ${p.board}: ${first}'s cell '${cell}' is not a played result`;
        if (p.result !== want) return `board ${p.board}: drawn result '${String(p.result)}', ${first}'s cell reads '${cell}'`;
        const mine = round.pairs.some(([a, b]) => (a === first && b === second) || (a === second && b === first));
        if (!mine) return `board ${p.board}: ${p.first} v ${String(p.second)} is not a board of round ${d.round} in the grid`;
        if (p.first !== label(first) || p.second !== label(second)) return `board ${p.board}: a seed is not the fixture's`;
        if (p.firstWhite !== true) return `board ${p.board}: the first player is White in the table`;
        if (scoreOf(p.firstScore!) !== round.score.get(first) || scoreOf(p.secondScore!) !== round.score.get(second)) return `board ${p.board}: points drawn ${String(p.firstScore)} and ${String(p.secondScore)}, the grid has ${round.score.get(first)} and ${round.score.get(second)}`;
        if (p.float !== (round.score.get(first) !== round.score.get(second))) return `board ${p.board}: float drawn ${String(p.float)}`;
      }
      const g = gridOf(r);
      const outNames = (d.notSeated ?? []).map((n) => parseSeededLabel(n.name).name);
      const absent = [...g].filter(([, row]) => row.rounds[d.round - 1] === LEFT || row.rounds[d.round - 1] === NOT_YET).map(([p]) => p);
      if (outNames.sort().join(",") !== absent.sort().join(",")) return `the diagram leaves out '${outNames.join(", ")}', the grid has '${absent.join(", ")}' not seated in round ${d.round}`;
      if (absent.length === 0) return "nobody is left out, so the diagram cannot show a player who left";
      // The caption's names, rounds and count are the facts the post prints, and the boards drawn.
      const others = d.pairings.length * 2 - 1;
      const t = String(d.title);
      const wanted = [`Round ${String(r.facts.lateFirstRound)}`, String(r.facts.lateName), String(r.facts.leaverName), `once round ${String(r.facts.leaverRound)} was paired`, `The other ${others} players`];
      const missing = wanted.filter((w) => !t.includes(w));
      return missing.length === 0 || `the diagram's caption does not say '${missing.join("', '")}'`;
    }),
  },
  {
    says: "in every sport the opponent of a player who left is paid a win, what the sport's declared Swiss points pay, and the player who left is booked a loss",
    source: "the sport's declared Swiss points (tablePointsRule of the Swiss stage, the clean-sweep win where points go by set score, read through swiss-bye's declaredBestWin); the Swiss withdrawal rule walks the board over to the opponent",
    check() {
      let n = 0;
      const bad: string[] = [];
      const visited = forEachSport(({ module }) => {
        const m = moduleOf(module.key);
        const cfg = startingCfg(m);
        const rules = swissRules(m, cfg, `blog-example:swiss-late-and-withdraw:${module.key}`);
        const paid = walkover(m, cfg, rules, "stays", "leaves", "leaves").paid;
        const stays = paid.find((d) => d.entrantId === "stays");
        const leaves = paid.find((d) => d.entrantId === "leaves");
        const win = declaredBestWin(m, cfg);
        if (stays === undefined || leaves === undefined) bad.push(`${module.key}: a side is missing`);
        else if (stays.points !== win || stays.won !== 1 || leaves.points !== 0 || leaves.lost !== 1) bad.push(`${module.key}: the opponent is paid ${stays.points} (${stays.won} won), the declaration's win is ${win}; the leaver ${leaves.points} (${leaves.lost} lost)`);
        n++;
      });
      if (visited === 0 || n !== visited) return `${n} sports checked of ${visited}`;
      return bad.length === 0 || bad.join("; ");
    },
  },
  captionClaim("the caption's counts and names are the post's: the rounds, who leaves and after which round, who joins and from which", (f) => [`A ${String(f.roundCount)}-round chess Swiss`, `${String(f.leaverName)} leaves once round ${String(f.leaverRound)}`, `${String(f.lateName)} joins from round ${String(f.lateFirstRound)}`]),
  offeredInEverySportClaim("swiss", "Swiss", "sportCount"),
];

export const swissLateAndWithdraw: BlogExample = {
  id: SWISS_LATE_AND_WITHDRAW_ID,
  kind: "engine",
  sports: ["boardgame"],
  singleSportReason: "chess only: neither rule reads the sport (the round's field and the withdrawal rule take none); the example-wide claim sweeps the Swiss format across every sport",
  build: () => buildSwissLate(),
  claims,
};
