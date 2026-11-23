// Post #22, "How does americano rotate partners?". Eight players on the americano template's own courts and rounds (the
// stage the division builder makes, `buildTemplateStages("americano")`), handed to the engine's rotation
// (`generateAmericano`, which the app's generator calls with the same arguments, usecases/stages/generators.ts
// `americanoGen`). The result is the round-by-round draw, the partner grid, and how far the rotation covers the field.
// A ninth player shows who sits out. Which sports are offered the format is read from the builder's own offer
// (`templatesForSport` over each sport's declared entrant model), sweeping the whole registry.
//
// WHAT CHECKS IT. The claims re-read the template's declaration and each sport's entrant-model declaration directly, and
// recount the table and the diagram with their own code. None reads `build()`'s intermediate values.
import { generateAmericano } from "@seazn/engine/scheduling";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { forEachSport } from "@seazn/engine/testkit";
import { sportLabel } from "@/blog/labels";
import { buildTemplateStages, templatesForSport } from "@/lib/format-templates";
import { CHESS_SPORT_KEY, PAIR_MINTING_NEEDS_KINDS } from "@/lib/chess-individual-only-rule";
import type { Claim, DiagramModel, EngineExample, ExampleResult } from "./types";

export const AMERICANO_ROTATION_ID = "americano-rotation";

/** Fictional players, in the order the stage hands them to the rotation (the division's entrant order). */
export const AMERICANO_PLAYERS = ["Ana", "Ben", "Cy", "Dev", "Eli", "Fay", "Gus", "Hal"] as const;
const NINTH = "Ivy";
const KNOBS = { qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 } as const;

/** The americano stage the builder makes: its own declared courts and rounds. */
export function americanoTemplateConfig(): { courtCount: number; rounds: number } {
  const [stage] = buildTemplateStages("americano", KNOBS);
  const cfg = (stage?.config ?? {}) as { mode?: unknown; courtCount?: unknown; rounds?: unknown };
  if (stage?.kind !== "americano" || cfg.mode !== "americano" || typeof cfg.courtCount !== "number" || typeof cfg.rounds !== "number") {
    throw new Error("americano-rotation: the americano template no longer declares an americano stage with courts and rounds");
  }
  return { courtCount: cfg.courtCount, rounds: cfg.rounds };
}

const pairKey = (a: string, b: string) => [a, b].sort().join("|");
const pairWords = (p: readonly string[]) => `${p[0]} and ${p[1]}`;

/** A list read the way a person writes it: "a, b and c". */
export function listWords(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The sports the builder offers americano to, by the product's own offer, in registry order. */
function offeredSports(): { offered: string[]; refused: string[] } {
  const offered: string[] = [];
  const refused: string[] = [];
  forEachSport(({ module }) => {
    const kinds = effectiveEntrantModel(module.entrantModel, null).kinds;
    (templatesForSport(module.key, kinds).some((t) => t.key === "americano") ? offered : refused).push(module.key);
  });
  return { offered, refused };
}

/** The generic sport reads as "any other sport" in prose; every other sport as its product name. */
function sportWords(key: string): string {
  return key === "generic" ? "any other sport" : sportLabel(key).toLowerCase();
}

function build(): ExampleResult {
  const { courtCount, rounds } = americanoTemplateConfig();
  const players = [...AMERICANO_PLAYERS];
  const draw = generateAmericano(players, { mode: "americano", courtCount, rounds });

  const partnered = new Map<string, number[]>();
  const rows: string[][] = [];
  const gridRounds: { pairs: [string, string][] }[] = [];
  for (const round of draw) {
    const cells = [`Round ${round.roundNo}`];
    const pairs: [string, string][] = [];
    for (const m of round.matches) {
      cells.push(`${pairWords(m.team1)} against ${pairWords(m.team2)}`);
      for (const side of [m.team1, m.team2]) {
        pairs.push([side[0], side[1]]);
        const k = pairKey(side[0], side[1]);
        partnered.set(k, [...(partnered.get(k) ?? []), round.roundNo]);
      }
    }
    rows.push(cells);
    gridRounds.push({ pairs });
  }

  const allPairs: string[] = [];
  for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) allPairs.push(pairKey(players[i]!, players[j]!));
  const never = allPairs.filter((k) => !partnered.has(k));
  const twice = allPairs.filter((k) => (partnered.get(k)?.length ?? 0) > 1);
  const firstTwice = twice[0]?.split("|") ?? [];
  const firstNever = never[0]?.split("|") ?? [];
  const pivot = players[0]!;
  const pivotPartners = new Set(allPairs.filter((k) => k.split("|").includes(pivot) && partnered.get(k)?.length === 1));

  // A ninth player: one more than the courts hold, so somebody sits out each round.
  const nine = generateAmericano([...players, NINTH], { mode: "americano", courtCount, rounds });
  const sitOuts = nine.map((r) => r.byes);

  const { offered, refused } = offeredSports();

  const diagram: DiagramModel = {
    kind: "partnerGrid",
    title: `Every pair of the ${players.length} players, and the round they played on the same side. An empty square is a pair that never partnered; two numbers, a pair that partnered twice.`,
    players,
    rounds: gridRounds,
  };

  return {
    facts: {
      players: players.length,
      courts: courtCount,
      rounds,
      matchesPerRound: draw[0]?.matches.length ?? 0,
      partnerPairs: partnered.size,
      allPairs: allPairs.length,
      neverPartnered: never.length,
      partneredTwice: twice.length,
      pivot,
      pivotPartners: pivotPartners.size,
      twicePair: pairWords(firstTwice),
      twiceRounds: listWords((partnered.get(twice[0] ?? "") ?? []).map(String)),
      neverPair: pairWords(firstNever),
      ninthPlayer: NINTH,
      sitOutsPerRound: sitOuts[0]?.length ?? 0,
      sitOutFirstRounds: listWords(sitOuts.slice(0, 3).map((b, i) => `${b.join(", ")} in round ${i + 1}`)),
      offeredSports: listWords(offered.map(sportWords)),
      offeredCount: offered.length,
      refusedSports: listWords(refused.map(sportWords)),
      refusedCount: refused.length,
    },
    table: {
      caption: `${players.length} players on ${courtCount} courts over ${rounds} rounds, as Seazn draws them. Each match puts two pairs against each other.`,
      columns: ["Round", ...Array.from({ length: courtCount }, (_, c) => `Court ${c + 1}`)],
      rows,
    },
    diagram,
    text: [],
  };
}

// ---- claims: each re-reads a declaration (the template, the entrant models) or recounts the table with its own code ----

/** The pairs on the same side in one table cell "A and B against C and D". */
function cellPairs(cell: string): [string, string][] | null {
  const m = /^(\S+) and (\S+) against (\S+) and (\S+)$/.exec(cell);
  return m ? [[m[1]!, m[2]!], [m[3]!, m[4]!]] : null;
}

function tablePairs(result: ExampleResult): [string, string][][] | string {
  const out: [string, string][][] = [];
  for (const row of result.table?.rows ?? []) {
    const pairs: [string, string][] = [];
    for (const cell of row.slice(1)) {
      const p = cellPairs(String(cell));
      if (p === null) return `'${String(cell)}' is not a match of two pairs`;
      pairs.push(...p);
    }
    out.push(pairs);
  }
  return out.length > 0 ? out : "the table has no rounds";
}

const claims: Claim[] = [
  {
    says: "the draw runs the americano template's own number of rounds, with one column per court it declares",
    source: "lib/format-templates.ts STAGE_TEMPLATES americano (config.courtCount, config.rounds)",
    check(r) {
      const { courtCount, rounds } = americanoTemplateConfig();
      if (r.table?.rows.length !== rounds) return `${r.table?.rows.length ?? 0} rounds, the template declares ${rounds}`;
      if (r.facts.rounds !== rounds || r.facts.courts !== courtCount) return "the rounds or courts fact differs from the template";
      return r.table.rows.every((row) => row.length === courtCount + 1) || "a round does not fill every court";
    },
  },
  {
    says: "with four players per court, every player plays every round, once, and nobody sits out",
    source: "americano rule: a field of 4 x courts players fills every court (engine americano.js quartets)",
    check(r) {
      const rounds = tablePairs(r);
      if (typeof rounds === "string") return rounds;
      const players = [...AMERICANO_PLAYERS].sort().join(",");
      for (const [i, pairs] of rounds.entries()) {
        const seen = pairs.flat().sort().join(",");
        if (seen !== players) return `round ${i + 1} seats ${seen}`;
      }
      return true;
    },
  },
  {
    says: "the partner counts in the facts are the pairs the table really shows, out of every pair the field holds",
    source: "a recount of the table; the field's pairs are n(n-1)/2 for the players listed",
    check(r) {
      const rounds = tablePairs(r);
      if (typeof rounds === "string") return rounds;
      const count = new Map<string, number>();
      for (const pairs of rounds) for (const [a, b] of pairs) count.set(pairKey(a, b), (count.get(pairKey(a, b)) ?? 0) + 1);
      const n = AMERICANO_PLAYERS.length;
      const all = (n * (n - 1)) / 2;
      const never = all - count.size;
      const twice = [...count.values()].filter((v) => v > 1).length;
      if (r.facts.allPairs !== all) return `allPairs ${String(r.facts.allPairs)}, the field holds ${all}`;
      if (r.facts.partnerPairs !== count.size) return `partnerPairs ${String(r.facts.partnerPairs)}, the table shows ${count.size}`;
      if (r.facts.neverPartnered !== never) return `neverPartnered ${String(r.facts.neverPartnered)}, the table leaves ${never}`;
      return r.facts.partneredTwice === twice || `partneredTwice ${String(r.facts.partneredTwice)}, the table shows ${twice}`;
    },
  },
  {
    says: "the rotation does not partner every pair once: some pairs repeat and some never meet (a round-robin of partners would cover all of them)",
    source: "class 19 witness: the full-coverage constant n(n-1)/2 differs from what the product draws (engine americano.js rotationOrder)",
    check(r) {
      const all = Number(r.facts.allPairs);
      const met = Number(r.facts.partnerPairs);
      return (met < all && Number(r.facts.partneredTwice) > 0 && Number(r.facts.neverPartnered) === all - met) || `met ${met} of ${all}`;
    },
  },
  {
    says: "the first player stays put and partners every other player exactly once",
    source: "engine americano.js rotationOrder: player 0 is fixed and the rest rotate",
    check(r) {
      const rounds = tablePairs(r);
      if (typeof rounds === "string") return rounds;
      const pivot = AMERICANO_PLAYERS[0];
      const partners = rounds.flat().filter((p) => p.includes(pivot)).map((p) => (p[0] === pivot ? p[1] : p[0]));
      const others = AMERICANO_PLAYERS.filter((p) => p !== pivot);
      if (r.facts.pivot !== pivot || r.facts.pivotPartners !== others.length) return "the pivot facts are wrong";
      return (partners.length === others.length && new Set(partners).size === others.length) || `the first player partners ${partners.join(", ")}`;
    },
  },
  {
    says: "the partner grid draws exactly the table's pairs, round by round",
    source: "a recount of the table against the diagram model",
    check(r) {
      const rounds = tablePairs(r);
      if (typeof rounds === "string") return rounds;
      const d = r.diagram;
      if (d?.kind !== "partnerGrid") return "no partner grid";
      if (JSON.stringify(d.players) !== JSON.stringify(AMERICANO_PLAYERS)) return "the grid's players differ";
      const norm = (ps: [string, string][]) => ps.map(([a, b]) => pairKey(a, b)).sort().join(",");
      return (d.rounds.length === rounds.length && d.rounds.every((g, i) => norm(g.pairs) === norm(rounds[i]!))) || "the grid and the table disagree";
    },
  },
  {
    says: "a ninth player on the same courts means one player sits out each round",
    source: "americano rule: courts hold 4 x courts players; the rest sit out (template courtCount)",
    check(r) {
      const { courtCount } = americanoTemplateConfig();
      const expected = AMERICANO_PLAYERS.length + 1 - 4 * courtCount;
      return r.facts.sitOutsPerRound === expected || `sitOutsPerRound ${String(r.facts.sitOutsPerRound)}, expected ${expected}`;
    },
  },
  {
    says: "americano is offered in exactly the sports whose players can enter alone, except chess",
    source: "each sport's entrantModel declaration, resolved by the engine (effectiveEntrantModel: kinds include individual), and the chess individual-only ruling (lib/chess-individual-only-rule.ts)",
    check(r) {
      const expected = builtinModules
        .filter((m) => m.key !== CHESS_SPORT_KEY && PAIR_MINTING_NEEDS_KINDS.every((k) => (effectiveEntrantModel(m.entrantModel, null).kinds as readonly string[]).includes(k)))
        .map((m) => sportWords(m.key));
      const refused = builtinModules.map((m) => sportWords(m.key)).filter((w) => !expected.includes(w));
      if (expected.length === 0 || refused.length === 0) return "anti-vacuity: the offer must split the registry";
      if (r.facts.offeredCount !== expected.length || r.facts.refusedCount !== refused.length) return "offer counts differ from the declarations";
      if (r.facts.offeredSports !== listWords(expected)) return `offered '${String(r.facts.offeredSports)}', declarations give '${listWords(expected)}'`;
      return r.facts.refusedSports === listWords(refused) || `refused '${String(r.facts.refusedSports)}'`;
    },
  },
];

export const americanoRotation: EngineExample = {
  id: AMERICANO_ROTATION_ID,
  kind: "engine",
  sports: "all",
  build,
  claims,
};
