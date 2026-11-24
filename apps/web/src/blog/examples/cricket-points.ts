// Post #3, "How many points does a cricket team get for a tie or a washed-out match?". Cricket only (the reason is on the
// export below): a tie, a no result and a two-innings draw are cricket's table results alone, and the sweep here counts
// the sports whose league can reach one. Each row is a real match, played to that ending through the engine's own event
// stream and paid by the rules the standings read (kit.ts: the web's one table-rules loader, then `payout`).
//
// WHICH MATCHES: Ana beats Ben; Cy and Dev tie; Cy and Dev are rained off in a limited-overs match (the scorer's
// Abandon, which is a no result); the same tie with a super over switched on, which the winner takes; and in a Test match a
// win, a draw by play, a tie, and a match that is abandoned (which a two-innings match books as a draw, never as a no
// result: DECLARED_BUT_UNREACHABLE in the pilot is the proof of that, re-run by blog-examples.test.ts).
//
// WHAT CHECKS IT. The claims recompute every expected cell and fact from the module's own declarations (its points rule,
// `reachableResultKinds`, `reachableDecidedIn`, `inningsPerSide`) with the cfg composed straight from the schema, in code
// that shares no formatter with `build()`.
import { pointsText } from "@seazn/engine/competition";
import { stageDefaultsFor } from "@seazn/engine/sport";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { declaredCfgs, forEachSport } from "@seazn/engine/testkit";
import { sportLabel, variantLabel } from "@/blog/labels";
import { NAMES, moduleOf, play, sentenceList, variantsOf, winnerLoserPoints, type Cfg, type Played, type StageRules, declaredLeaguePoints, joinAnd } from "./kit";
import type { BlogExample, Claim, ExampleResult } from "./types";

export const CRICKET_POINTS_ID = "cricket-points";

const COLUMNS = ["How the match ended", "Format", "One side gets", "The other side gets"];
const C = { how: 0, format: 1, one: 2, other: 3 } as const;

const cricket = (): AnySportModule => moduleOf("cricket");
const abandoned = (p: Played): boolean => p.events.some((e) => e.type === "core.abandon");

/** The cfg of a declared variant, as the module's own schema parses it (declaredCfgs holds each one). */
const cfgOf = (module: AnySportModule, variantKey: string): Cfg => {
  const hit = declaredCfgs(module).find((c) => c.name === variantKey);
  if (hit === undefined) throw new Error(`cricket-points: '${variantKey}' is not a declared cricket variant`);
  return hit.cfg;
};

/** A variant plays two innings a side (a Test match) or one (every limited-overs format). */
const twoInnings = (cfg: Cfg): boolean => (cfg as { inningsPerSide: number }).inningsPerSide === 2;

interface Row {
  id: string;
  how: string;
  /** The variant the match is played in, and whether the stage switched the super over on. */
  variantKey: string;
  superOver: boolean;
  factKeys: [string, string | null];
  /** Plays the match, and says what each side was paid: [one, other]. */
  run(module: AnySportModule, cfg: Cfg, rules: StageRules | null): { points: [number, number]; line: string };
}

const level = (p: Played): [number, number] => {
  const [a, b] = p.paid;
  if (a.points !== b.points) throw new Error(`cricket-points: a level match paid ${a.points} and ${b.points}`);
  return [a.points, b.points];
};

const ROWS: Row[] = [
  {
    id: "win",
    how: "A win",
    variantKey: "t20",
    superOver: false,
    factKeys: ["winWinner", "winLoser"],
    run(m, cfg, rules) {
      const p = play(m, cfg, "t20 win", ["ana", "ben"], (o) => o.kind === "win" && o.winner === "ana", { rules, variantKey: "t20" });
      return { points: winnerLoserPoints(p), line: `${NAMES.ana} beat ${NAMES.ben} ${p.headline}` };
    },
  },
  {
    id: "tie",
    how: "A tie",
    variantKey: "t20",
    superOver: false,
    factKeys: ["tieEach", null],
    run(m, cfg, rules) {
      const p = play(m, cfg, "t20 tie", ["cy", "dev"], (o) => o.kind === "tie", { rules, variantKey: "t20" });
      return { points: level(p), line: `${NAMES.cy} and ${NAMES.dev} tied ${p.headline}` };
    },
  },
  {
    id: "superOver",
    how: "A tie, settled by a super over",
    variantKey: "t20",
    superOver: true,
    factKeys: ["superOverWinner", "superOverLoser"],
    run(m, cfg, rules) {
      const p = play(m, cfg, "t20 super over win", ["ana", "ben"], (o) => o.kind === "win" && o.winner === "ana" && o.method === "super_over", { rules, variantKey: "t20" });
      return { points: winnerLoserPoints(p), line: `${NAMES.ana} beat ${NAMES.ben} in a super over ${p.headline}` };
    },
  },
  {
    id: "noResult",
    how: "Abandoned, with no result",
    variantKey: "t20",
    superOver: false,
    factKeys: ["noResultEach", null],
    run(m, cfg, rules) {
      const p = play(m, cfg, "t20 no result", ["cy", "dev"], (o, _pair, _played, ev) => o.kind === "no_result" && ev.some((e) => e.type === "core.abandon"), { rules, variantKey: "t20" });
      return { points: level(p), line: `${NAMES.cy} and ${NAMES.dev} abandoned, no result, ${p.headline}` };
    },
  },
  {
    id: "testWin",
    how: "A win",
    variantKey: "test",
    superOver: false,
    factKeys: ["testWinWinner", "testWinLoser"],
    run(m, cfg, rules) {
      const p = play(m, cfg, "test win", ["ana", "ben"], (o) => o.kind === "win" && o.winner === "ana", { rules, variantKey: "test" });
      return { points: winnerLoserPoints(p), line: `${NAMES.ana} beat ${NAMES.ben} ${p.headline}` };
    },
  },
  {
    id: "testDraw",
    how: "A draw",
    variantKey: "test",
    superOver: false,
    factKeys: ["testDrawEach", null],
    run(m, cfg, rules) {
      const p = play(m, cfg, "test draw", ["cy", "dev"], (o, _pair, _played, ev) => o.kind === "draw" && !ev.some((e) => e.type === "core.abandon"), { rules, variantKey: "test" });
      return { points: level(p), line: `${NAMES.cy} and ${NAMES.dev} drew ${p.headline}` };
    },
  },
  {
    id: "testTie",
    how: "A tie",
    variantKey: "test",
    superOver: false,
    factKeys: ["testTieEach", null],
    run(m, cfg, rules) {
      const p = play(m, cfg, "test tie", ["cy", "dev"], (o) => o.kind === "tie", { rules, variantKey: "test" });
      return { points: level(p), line: `${NAMES.cy} and ${NAMES.dev} tied ${p.headline}` };
    },
  },
  {
    id: "testAbandoned",
    how: "Abandoned",
    variantKey: "test",
    superOver: false,
    factKeys: ["testAbandonedEach", null],
    run(m, cfg, rules) {
      const p = play(m, cfg, "test abandoned", ["cy", "dev"], (o, _pair, _played, ev) => o.kind === "draw" && ev.some((e) => e.type === "core.abandon"), { rules, variantKey: "test" });
      if (!abandoned(p)) throw new Error("cricket-points: the abandoned Test match has no abandon in its ledger");
      return { points: level(p), line: `${NAMES.cy} and ${NAMES.dev} abandoned, booked as a draw, ${p.headline}` };
    },
  },
];

/** The stage rules a super-over row plays under: the engine's preset for a stage that needs a winner (it switches the super over on). */
const superOverRules = (m: AnySportModule, variantKey: string): StageRules => {
  const rules = stageDefaultsFor(m, "knockout", variantKey) as StageRules;
  if (rules.superOver !== true) throw new Error(`cricket-points: the knockout preset for '${variantKey}' does not switch the super over on`);
  return rules;
};

/** The variants whose matches are one innings a side: every limited-overs format. */
const limitedVariants = (m: AnySportModule) => variantsOf(m).filter((v) => !twoInnings(v.cfg));

const formatOf = (row: Row): string => `${variantLabel("cricket", row.variantKey)}${row.superOver ? ", super over on" : ""}`;

function build(): ExampleResult {
  const m = cricket();
  const facts: ExampleResult["facts"] = {};
  const rows: (string | number)[][] = [];
  const text: string[] = [
    "Each row is a real cricket match played to that ending: Ana beats Ben, and Cy and Dev finish level, are rained off or are abandoned.",
  ];
  for (const row of ROWS) {
    const rules = row.superOver ? superOverRules(m, row.variantKey) : null;
    const { points, line } = row.run(m, cfgOf(m, row.variantKey), rules);
    const [one, other] = points;
    facts[row.factKeys[0]] = pointsText(one, "whole");
    if (row.factKeys[1] !== null) facts[row.factKeys[1]] = pointsText(other, "whole");
    rows.push([row.how, formatOf(row), pointsText(one, "whole"), pointsText(other, "whole")]);
    text.push(`${row.how}, ${formatOf(row)}: ${line}.`);
  }
  const visited = forEachSport(() => undefined);
  const withLevel: string[] = [];
  const withoutLevel: string[] = [];
  forEachSport(({ module }) => {
    for (const { cfg } of declaredCfgs(module)) {
      const kinds = module.reachableResultKinds(cfg, "league");
      if (kinds.has("tie") || kinds.has("noResult")) {
        withLevel.push(sportLabel(module.key));
        return;
      }
    }
    withoutLevel.push(sportLabel(module.key));
  });
  facts.sportCount = visited;
  facts.sportsWithTieOrNoResult = withLevel.length;
  facts.sportsWithoutTieOrNoResult = withoutLevel.length;
  facts.withoutTieOrNoResultList = sentenceList(withoutLevel);
  facts.limitedOversList = joinAnd(limitedVariants(m).map((v) => variantLabel("cricket", v.key)));
  return {
    facts,
    table: { caption: "What each side gets for each way a cricket match can end, by format.", columns: COLUMNS, rows },
    text,
  };
}

// ---- claims: every expected value below is recomputed from the sport module's own declarations ----

const DECLARED = "the cricket module's league points rule (win, loss, tie, noResult, draw)";

interface Expected {
  row: Row;
  cells: [string, string, string, string];
  facts: Record<string, string>;
}

/** What the declarations say each row pays: [one side, the other]. */
function expectedPoints(m: AnySportModule, row: Row): [number, number] {
  const rules = row.superOver ? superOverRules(m, row.variantKey) : {};
  const cfg = m.configSchema.parse({ ...(m.variants[row.variantKey] ?? {}), ...rules });
  const rule = declaredLeaguePoints(m, cfg);
  switch (row.id) {
    case "win":
    case "testWin":
      return [rule.win.regulation, rule.loss.regulation];
    case "superOver": {
      if (!m.reachableDecidedIn(cfg, "league").has("so")) throw new Error("the declarations reach no super over under the stage's rules");
      return [rule.win.so ?? rule.win.ot ?? rule.win.regulation, rule.loss.so ?? rule.loss.ot ?? rule.loss.regulation];
    }
    case "tie":
    case "testTie":
      return [rule.tie!, rule.tie!];
    case "noResult":
      if (!m.reachableResultKinds(cfg, "league").has("noResult")) throw new Error("the declarations reach no 'no result'");
      return [rule.noResult ?? 0, rule.noResult ?? 0];
    case "testDraw":
    case "testAbandoned":
      // An abandoned two-innings match is a draw (the engine's abandon), so it pays the draw.
      if (rule.draw === undefined || !m.supportsDraws(cfg, "league")) throw new Error("the declarations stand no draw in this variant");
      return [rule.draw, rule.draw];
    default:
      throw new Error(`no expectation for row ${row.id}`);
  }
}

function expectedRows(m: AnySportModule): Expected[] {
  return ROWS.map((row) => {
    const [one, other] = expectedPoints(m, row);
    const f = (n: number) => pointsText(n, "whole");
    const facts: Record<string, string> = { [row.factKeys[0]]: f(one) };
    if (row.factKeys[1] !== null) facts[row.factKeys[1]] = f(other);
    return { row, cells: [row.how, formatOf(row), f(one), f(other)], facts };
  });
}

function claimsFor(m: AnySportModule): Claim[] {
  const mine = (says: string, source: string, check: Claim["check"]): Claim => ({ says: `Cricket: ${says}`, source, sport: "cricket", check });
  const expected = expectedRows(m);
  return [
    mine("the rows are the eight endings, in order, each with its format", "the example's own list of endings", (r) => {
      const got = (r.table?.rows ?? []).map((x) => `${String(x[C.how])} / ${String(x[C.format])}`);
      const want = expected.map((e) => `${e.cells[0]} / ${e.cells[1]}`);
      return JSON.stringify(got) === JSON.stringify(want) || `rows are [${got.join("; ")}], expected [${want.join("; ")}]`;
    }),
    mine("what each ending pays, in the table and in the facts a post cites, is what the rule pays", DECLARED, (r) => {
      for (const e of expected) {
        const row = (r.table?.rows ?? []).find((x) => x[C.how] === e.cells[0] && x[C.format] === e.cells[1]);
        if (row === undefined) return `no row '${e.cells[0]}' / '${e.cells[1]}'`;
        if (row[C.one] !== e.cells[2] || row[C.other] !== e.cells[3]) return `${e.cells[0]} / ${e.cells[1]}: the row pays ${String(row[C.one])} and ${String(row[C.other])}, the declaration gives ${e.cells[2]} and ${e.cells[3]}`;
        for (const [k, v] of Object.entries(e.facts)) if (r.facts[k] !== v) return `fact ${k} is ${String(r.facts[k])}, the declaration gives ${v}`;
      }
      return true;
    }),
    mine("a draw stands in the two-innings format only, and the table has a draw row for that format alone", "the points rule's draw and supportsDraws, in every cricket variant", (r) => {
      let checked = 0;
      for (const { key, cfg } of variantsOf(m)) {
        const rule = declaredLeaguePoints(m, cfg);
        const two = twoInnings(cfg);
        if ((rule.draw !== undefined) !== two) return `${key}: draw is ${String(rule.draw)} but inningsPerSide says ${two ? "two" : "one"}`;
        if (m.supportsDraws(cfg as never, "league") !== two) return `${key}: supportsDraws disagrees with the innings`;
        checked++;
      }
      if (checked === 0) return "no cricket variant was checked";
      const drawRows = (r.table?.rows ?? []).filter((x) => x[C.how] === "A draw");
      if (drawRows.length !== 1 || drawRows[0]![C.format] !== variantLabel("cricket", "test")) return `the draw rows are [${drawRows.map((x) => String(x[C.format])).join(", ")}], expected the Test match alone`;
      return true;
    }),
    mine("every limited-overs format pays the same as T20, and the post names exactly those formats", "the points rule of every one-innings variant", (r) => {
      const limited = variantsOf(m).filter((v) => !twoInnings(v.cfg));
      if (limited.length < 2) return `only ${limited.length} limited-overs variants`;
      const base = JSON.stringify(declaredLeaguePoints(m, cfgOf(m, "t20")));
      for (const v of limited) if (JSON.stringify(declaredLeaguePoints(m, v.cfg)) !== base) return `${v.key} pays differently from T20`;
      const want = joinAnd(limited.map((v) => variantLabel("cricket", v.key)));
      return r.facts.limitedOversList === want || `limitedOversList is '${String(r.facts.limitedOversList)}', expected '${want}'`;
    }),
  ];
}

function acrossSports(): Claim[] {
  return [
    {
      says: "cricket is the only sport whose league can end in a tie or a no result, counted over the whole registry",
      source: "reachableResultKinds of every sport module, in every declared config",
      check(result) {
        const have: string[] = [];
        const visited = forEachSport(({ module }) => {
          for (const { cfg } of declaredCfgs(module)) {
            const k = module.reachableResultKinds(cfg, "league");
            if (k.has("tie") || k.has("noResult")) {
              have.push(module.key);
              return;
            }
          }
        });
        if (result.facts.sportCount !== visited) return `sportCount is ${String(result.facts.sportCount)}, the registry has ${visited}`;
        if (JSON.stringify(have) !== JSON.stringify(["cricket"])) return `sports that can tie or have no result: [${have.join(", ")}]`;
        // The post names the OTHER sports from this sweep too: every registry sport but the ones that can, in registry order.
        const others = builtinModules.filter((m) => !have.includes(m.key)).map((m) => sportLabel(m.key));
        if (others.length === 0) return "no sport was left that has neither a tie nor a no result";
        if (result.facts.sportsWithoutTieOrNoResult !== others.length || result.facts.withoutTieOrNoResultList !== sentenceList(others)) {
          return `withoutTieOrNoResultList is '${String(result.facts.withoutTieOrNoResultList)}' (${String(result.facts.sportsWithoutTieOrNoResult)}), the registry leaves ${others.length}: '${sentenceList(others)}'`;
        }
        return result.facts.sportsWithTieOrNoResult === have.length || `sportsWithTieOrNoResult is ${String(result.facts.sportsWithTieOrNoResult)}, expected ${have.length}`;
      },
    },
  ];
}

const claims: Claim[] = [...acrossSports(), ...claimsFor(cricket())];

export const cricketPoints: BlogExample = {
  id: CRICKET_POINTS_ID,
  kind: "engine",
  sports: ["cricket"],
  singleSportReason: "cricket only: a tie, a no result and a two-innings draw are cricket's table results alone (the sweep in the claims counts the registry)",
  build,
  claims,
};
