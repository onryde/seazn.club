// Post #24, "How does a ladder competition work?". A `server` example: the ladder's rules are the APP's (the engine has no
// ladder), and they run inside database transactions with no pure function to call: the challenge's reach and direction
// (usecases/stages/ad-hoc.ts `issueChallenge`) and the swap a challenger's win makes (usecases/scoring.ts, the ladder
// branch of the decided hook). So the example is RUN by an env-gated DB test (`runner` below), which drives those real
// usecases on a six-player ladder made from the ladder template and hands what it saw to `ladderResult`, the formatter
// here. The unit harness checks this file's claims against the committed golden.
//
// WHAT CHECKS IT. The claims recompute every "ladder after" from the row before it and the step's own result, with their
// own swap; the reach comes from the ladder template's declaration; none reads the formatter.
import { builtinModules } from "@seazn/engine/sports";
import { buildTemplateStages } from "@/lib/format-templates";
import type { Claim, ExampleResult, ServerExample } from "./types";

export const LADDER_CHALLENGE_ID = "ladder-challenge";
export const LADDER_RUNNER = "src/server/__tests__/blog-example-ladder.db.test.ts";

/** Six fictional players, seeded 1 to 6 in this order. */
export const LADDER_PLAYERS = ["Ana", "Ben", "Cy", "Dev", "Eli", "Fay"] as const;

/** What the DB test saw for one challenge. `refused` carries the refusal's wire code; otherwise `won` says whether the
 *  challenger won, and `walkover` whether the match was a walkover. `order` is the stored ladder after the step. */
export interface LadderStep {
  challenger: string;
  target: string;
  refused?: "LADDER_CHALLENGE_OUT_OF_RANGE" | "LADDER_CHALLENGE_NOT_UPWARD";
  won?: boolean;
  walkover?: boolean;
  /** Neither side turned up (a double walkover recorded against the challenge). */
  both?: boolean;
  order: string[];
}

export interface LadderObserved {
  /** The template's reach, as the stage the builder makes stores it. */
  reach: number;
  /** The order the first challenge wrote, from seed order. */
  start: string[];
  steps: LadderStep[];
  /** How many sports of the registry the builder offers the ladder template to (`templatesForSport`). */
  offeredIn: number;
}

const KNOBS = { qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 } as const;

/** The ladder stage the builder makes, and the reach it declares. */
export function ladderTemplateReach(): number {
  const [stage] = buildTemplateStages("ladder", KNOBS);
  const reach = (stage?.config as { challengeRange?: unknown } | undefined)?.challengeRange;
  if (stage?.kind !== "ladder" || typeof reach !== "number") throw new Error("ladder-challenge: the ladder template no longer declares a reach");
  return reach;
}

const placesUp = (order: readonly string[], challenger: string, target: string) => order.indexOf(challenger) - order.indexOf(target);

function resultWords(step: LadderStep, before: readonly string[]): string {
  if (step.refused === "LADDER_CHALLENGE_OUT_OF_RANGE") return `Refused: ${step.target} is ${placesUp(before, step.challenger, step.target)} places up`;
  if (step.refused === "LADDER_CHALLENGE_NOT_UPWARD") return `Refused: ${step.target} is below ${step.challenger}`;
  if (step.both) return "Neither side turned up; nobody moves";
  const how = step.walkover ? `${step.target} did not turn up` : step.won ? `${step.challenger} won` : `${step.target} won`;
  return step.won ? `${how}; they swap places` : `${how}; nobody moves`;
}

/** The formatter the runner calls with what it saw. Pure: no database, no usecase. */
export function ladderResult(seen: LadderObserved): ExampleResult {
  const rows: string[][] = [];
  let before = seen.start;
  seen.steps.forEach((step, i) => {
    rows.push([`${i + 1}`, `${step.challenger} challenges ${step.target}`, resultWords(step, before), step.order.join(", ")]);
    before = step.order;
  });
  const firstWin = seen.steps.find((s) => s.won === true && !s.walkover)!;
  const firstWinBefore = seen.steps.indexOf(firstWin) === 0 ? seen.start : seen.steps[seen.steps.indexOf(firstWin) - 1]!.order;
  const range = seen.steps.find((s) => s.refused === "LADDER_CHALLENGE_OUT_OF_RANGE");
  const rangeBefore = range === undefined ? [] : seen.steps.indexOf(range) === 0 ? seen.start : seen.steps[seen.steps.indexOf(range) - 1]!.order;
  const loss = seen.steps.find((s) => s.refused === undefined && s.both !== true && s.won === false);
  const walkover = seen.steps.find((s) => s.walkover === true);
  const both = seen.steps.find((s) => s.both === true);
  return {
    facts: {
      reach: seen.reach,
      offeredIn: seen.offeredIn,
      players: seen.start.length,
      top: seen.start[0]!,
      bottom: seen.start[seen.start.length - 1]!,
      winChallenger: firstWin.challenger,
      winTarget: firstWin.target,
      winPlacesUp: placesUp(firstWinBefore, firstWin.challenger, firstWin.target),
      rangeChallenger: range?.challenger ?? "",
      rangeTarget: range?.target ?? "",
      rangePlacesUp: range === undefined ? 0 : placesUp(rangeBefore, range.challenger, range.target),
      lossChallenger: loss?.challenger ?? "",
      lossTarget: loss?.target ?? "",
      walkoverChallenger: walkover?.challenger ?? "",
      walkoverTarget: walkover?.target ?? "",
      bothChallenger: both?.challenger ?? "",
      bothTarget: both?.target ?? "",
      finalOrder: seen.steps[seen.steps.length - 1]!.order.join(", "),
    },
    table: {
      caption: `A ladder of ${seen.start.length} players, seeded ${seen.start.join(", ")}, where a player may challenge up to ${seen.reach} places above. Each row is one challenge, and the ladder after it, top first.`,
      columns: ["Step", "Challenge", "What happened", "Ladder after, top first"],
      rows,
    },
    diagram: {
      kind: "ladder",
      title: `Left, the ladder before ${firstWin.challenger} challenges ${firstWin.target}; right, after ${firstWin.challenger} wins. The two swap places and nobody else moves.`,
      rungs: [...firstWinBefore],
      challenger: firstWin.challenger,
      target: firstWin.target,
      swapped: true,
    },
    text: [],
  };
}

// ---- claims: each "ladder after" recomputed from the row before it and the step's result, with the claims' own swap ----

interface Row {
  challenger: string;
  target: string;
  result: string;
  order: string[];
}
function rowsOf(r: ExampleResult): Row[] | string {
  const rows: Row[] = [];
  for (const row of r.table?.rows ?? []) {
    const m = /^(\S+) challenges (\S+)$/.exec(String(row[1]));
    if (m === null) return `'${String(row[1])}' is not a challenge`;
    rows.push({ challenger: m[1]!, target: m[2]!, result: String(row[2]), order: String(row[3]).split(", ") });
  }
  return rows.length > 0 ? rows : "no challenges";
}
const swap = (order: readonly string[], a: string, b: string) => order.map((p) => (p === a ? b : p === b ? a : p));
const startOrder: string[] = [...LADDER_PLAYERS];

const claims: Claim[] = [
  {
    says: "the ladder is offered in every sport, starts in seed order, and its reach is the one the ladder template declares",
    source: "the sport registry; issueChallenge initialises the order from seed order; lib/format-templates.ts ladder (config.challengeRange)",
    check(r) {
      if (r.facts.offeredIn !== builtinModules.length) return `offered in ${String(r.facts.offeredIn)} of ${builtinModules.length} sports`;
      if (r.facts.reach !== ladderTemplateReach()) return `reach ${String(r.facts.reach)}, the template declares ${ladderTemplateReach()}`;
      return (r.facts.top === startOrder[0] && r.facts.bottom === startOrder[startOrder.length - 1]) || "the ladder does not start in seed order";
    },
  },
  {
    says: "a challenger who wins swaps places with the player challenged, a walkover included; a challenger who loses changes nothing; a refused challenge changes nothing",
    source: "ladder rule (usecases/scoring.ts ladder swap: the winner below takes the loser's place, an award included)",
    check(r) {
      const rows = rowsOf(r);
      if (typeof rows === "string") return rows;
      let before = startOrder;
      let swaps = 0;
      let still = 0;
      for (const [i, row] of rows.entries()) {
        const swapped = row.result.endsWith("they swap places");
        const expected = swapped ? swap(before, row.challenger, row.target) : before;
        if (JSON.stringify(row.order) !== JSON.stringify(expected)) return `step ${i + 1}: ladder ${row.order.join(", ")}, expected ${expected.join(", ")}`;
        if (swapped !== (row.result.includes(`${row.challenger} won`) || row.result.includes(`${row.target} did not turn up`))) return `step ${i + 1}: '${row.result}' swaps without a challenger win`;
        if (swapped) swaps++;
        else still++;
        before = row.order;
      }
      if (r.facts.finalOrder !== before.join(", ")) return "finalOrder differs from the last row";
      return (swaps >= 2 && still >= 2) || "anti-vacuity: the steps must include swaps and steps that change nothing";
    },
  },
  {
    says: "a challenge reaches at most the declared number of places up: every allowed one is within it, and the refused one is one place further",
    source: "issueChallenge reach (ad-hoc.ts; the ladder template's challengeRange) — class 19: reach + 1 is refused, so a reach of 4 would show differently",
    check(r) {
      const rows = rowsOf(r);
      if (typeof rows === "string") return rows;
      const reach = ladderTemplateReach();
      let before = startOrder;
      let refused = 0;
      for (const row of rows) {
        const up = placesUp(before, row.challenger, row.target);
        if (row.result.startsWith("Refused: ") && row.result.includes("places up")) {
          if (up <= reach) return `${row.challenger} was refused at ${up} places, within the reach of ${reach}`;
          if (up !== reach + 1) return "anti-vacuity: the refused challenge should sit just past the reach";
          refused++;
        } else if (!row.result.startsWith("Refused") && up > reach) return `${row.challenger} reached ${up} places`;
        before = row.order;
      }
      if (r.facts.rangePlacesUp !== reach + 1) return "rangePlacesUp is not reach + 1";
      return refused === 1 || `${refused} range refusals`;
    },
  },
  {
    says: "a player can only challenge upward",
    source: "issueChallenge: LADDER_CHALLENGE_NOT_UPWARD",
    check(r) {
      const rows = rowsOf(r);
      if (typeof rows === "string") return rows;
      let before = startOrder;
      let seen = 0;
      for (const row of rows) {
        if (placesUp(before, row.challenger, row.target) <= 0) {
          if (!row.result.startsWith("Refused") || !row.result.includes("is below")) return `${row.challenger} challenged downward and was not refused`;
          seen++;
        }
        before = row.order;
      }
      return seen > 0 || "anti-vacuity: no downward challenge";
    },
  },
  {
    says: "every row reads exactly as the rules give it: the step number, the places up counted from the ladder before it, who the result names, and the ladder after",
    source: "issueChallenge (reach, direction), the ladder swap in usecases/scoring.ts (a win or a walkover swaps, anything else leaves the order); a double walkover keeps both places (lib/double-walkover-next-match.ts: the ladder is exempt)",
    check(r) {
      const rows = rowsOf(r);
      if (typeof rows === "string") return rows;
      const reach = ladderTemplateReach();
      let before = startOrder;
      for (const [i, row] of rows.entries()) {
        const { challenger: c, target: t, result } = row;
        const up = placesUp(before, c, t);
        if (String(r.table!.rows[i]![0]) !== String(i + 1)) return `row ${i + 1} is numbered '${String(r.table!.rows[i]![0])}'`;
        const allowed = up > 0 && up <= reach;
        let swaps: boolean;
        if (result === `${c} won; they swap places` || result === `${t} did not turn up; they swap places`) swaps = allowed;
        else if (result === `${t} won; nobody moves` || result === "Neither side turned up; nobody moves") swaps = false;
        else if (up > reach && result === `Refused: ${t} is ${up} places up`) swaps = false;
        else if (up <= 0 && result === `Refused: ${t} is below ${c}`) swaps = false;
        else return `step ${i + 1}: '${result}' for ${c} and ${t}, ${up} places up (reach ${reach})`;
        if (!swaps && (result.startsWith("Refused") ? false : !allowed)) return `step ${i + 1}: a played challenge ${up} places up is outside the reach`;
        if (swaps && !allowed) return `step ${i + 1}: swapped outside the reach`;
        const expected = swaps ? swap(before, c, t) : before;
        if (JSON.stringify(row.order) !== JSON.stringify(expected)) return `step ${i + 1}: ladder ${row.order.join(", ")}, expected ${expected.join(", ")}`;
        before = row.order;
      }
      return true;
    },
  },
  {
    says: "the facts name the table's steps: the first win, the refused challenge, the loss, the walkover and the double walkover, the places up, and the last ladder",
    source: "a recount of the table's rows with the claims' own parsing (no value read from the formatter)",
    check(r) {
      const rows = rowsOf(r);
      if (typeof rows === "string") return rows;
      let before = startOrder;
      const seen: Record<string, { c: string; t: string; up: number }> = {};
      for (const row of rows) {
        const up = placesUp(before, row.challenger, row.target);
        const kind = row.result.endsWith("they swap places")
          ? row.result.includes("did not turn up")
            ? "walkover"
            : "win"
          : row.result.startsWith("Refused") && row.result.includes("places up")
            ? "range"
            : row.result.endsWith("nobody moves")
              ? row.result.startsWith("Neither")
                ? "both"
                : "loss"
              : "other";
        if (seen[kind] === undefined) seen[kind] = { c: row.challenger, t: row.target, up };
        before = row.order;
      }
      const f = r.facts;
      const need = ["win", "range", "loss", "walkover", "both"] as const;
      for (const k of need) if (seen[k] === undefined) return `anti-vacuity: no ${k} step`;
      const same =
        f.players === startOrder.length &&
        f.winChallenger === seen.win!.c && f.winTarget === seen.win!.t && f.winPlacesUp === seen.win!.up &&
        f.rangeChallenger === seen.range!.c && f.rangeTarget === seen.range!.t && f.rangePlacesUp === seen.range!.up &&
        f.lossChallenger === seen.loss!.c && f.lossTarget === seen.loss!.t &&
        f.walkoverChallenger === seen.walkover!.c && f.walkoverTarget === seen.walkover!.t &&
        f.bothChallenger === seen.both!.c && f.bothTarget === seen.both!.t;
      return same || "a fact names a different step than the table shows";
    },
  },
  {
    says: "the diagram draws the first won challenge: the ladder before it, and the two players who swap",
    source: "a recount of the table against the diagram model",
    check(r) {
      const d = r.diagram;
      if (d?.kind !== "ladder") return "no ladder diagram";
      const rows = rowsOf(r);
      if (typeof rows === "string") return rows;
      const i = rows.findIndex((x) => x.result.endsWith("they swap places"));
      const before = i === 0 ? startOrder : rows[i - 1]!.order;
      return (d.swapped && d.challenger === rows[i]!.challenger && d.target === rows[i]!.target && JSON.stringify(d.rungs) === JSON.stringify(before)) || "the diagram does not match the first swap";
    },
  },
];

export const ladderChallenge: ServerExample = {
  id: LADDER_CHALLENGE_ID,
  kind: "server",
  runner: LADDER_RUNNER,
  sports: ["generic"],
  singleSportReason:
    "the ladder order lives in the stage, which no sport module reads; the format is offered in every sport (checked in the runner's sweep)",
  claims,
};
