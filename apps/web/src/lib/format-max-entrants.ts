// W5 B4 (stress F8; owner 2026-11-21: the limit is "entrants per division", per format, the same on every plan): the most
// entrants a division's format can START. Start draws every line of the first stage in ONE request; past a measured number of
// lines that request outlives what a browser and the edge wait for (stress-report F8: 19,900 lines, 196 s). The budget is
// counted in LINES (`START_LINE_BUDGET`, measured), and each format's MAX ENTRANTS is the largest field whose first-stage draw
// fits it: a league's lines grow with the square of its field and a knockout's with the field, so one flat entrant number would
// be wrong for one of them.
//
// The count at a field is the REAL generator's (never a formula typed here): the engine's `roundRobinFixtureCount` per pool,
// pools dealt as Start deals them (`seededSnake`: sizes differ by at most one); the engine's single- and double-elimination and
// stepladder generators, byes included (every line they emit is a fixture row); and the Swiss shells Start mints
// (`planSwissShells`, every round at once). A kind whose Start draw does not grow with its field has no max here (null):
// americano draws its config's courts x rounds, a ladder draws nothing until a challenge, a page playoff seats exactly four.
// Their draws are held to the budget by the server's exact count instead (DRAW_TOO_LARGE, usecases/stages/generate-tx.ts).
//
// Who asks: the builder (the picked card's max; format-choice.ts), the division page's Start (launch-actions.tsx, disabled over
// it), registration (submit's cap, places-left.ts), and the server's create and draw doors (stage-graph.ts, swiss-gen.ts).
// Client-safe: the engine's scheduling barrel is already in client bundles (`lib/cross-pool-separable.ts`).
import { generateDoubleElim, generateSingleElim, generateStepladder, roundRobinFixtureCount } from "@seazn/engine/scheduling";
import { planSwissShells } from "./swiss-shell.ts";
import { swissRoundsDefault } from "./swiss-rounds.ts";

/** The most fixture lines one Start may draw: measured (b4-report.md, F8). */
export const START_LINE_BUDGET = 5_000;

/** A stage as its kind and stored config: the division's first stage, a template's first draft. */
export interface FormatStage {
  kind: string;
  config?: unknown;
}

/** The smallest field the search starts from: every format plays it, and at every bounded knob its draw is far inside the budget
 *  (a Swiss's rounds are not bounded above: past it the search walks down instead). */
const PROBE_FLOOR = 8;
/** Past this field a draw that still fits the budget is one that does not grow with the field (asserted per kind in the tests). */
const PROBE_CEILING = 1 << 16;

const entrantIds = (n: number): string[] => Array.from({ length: n }, (_, i) => `e${i + 1}`);

function wholeAtLeastOne(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : null;
}

/** The pools Start deals `n` entrants into (`seededSnake`, generators.ts: a snake deal, sizes differ by at most one). */
function poolSizes(n: number, pools: number): number[] {
  const p = Math.max(1, Math.min(pools, n));
  return Array.from({ length: p }, (_, i) => Math.floor(n / p) + (i < n % p ? 1 : 0));
}

/** What a stage's Start count reads from its config, read as each generator reads it: legs truncated into 1..8 and pools (absent
 *  1) as `roundRobinStagePlan`; a Swiss's stored rounds (null: the field's default, a template's draft); a knockout's play-off; a
 *  double elimination's reset. Nothing else in a config moves the count - in particular nothing that changes in play
 *  (`round_byes`, `rank_overrides`, `rules`, `points`, `qualified`) - so this is also the memo's key (B4 review m-3). */
interface StartShape {
  kind: string;
  legs?: number;
  pools?: number;
  rounds?: number | null;
  thirdPlace?: boolean;
  bracketReset?: boolean;
}

function startShape(stage: FormatStage): StartShape {
  const cfg = (stage.config ?? {}) as Record<string, unknown>;
  switch (stage.kind) {
    case "league":
    case "group":
      return {
        kind: stage.kind,
        legs: Math.min(Math.max(typeof cfg.legs === "number" ? Math.trunc(cfg.legs) : 1, 1), 8),
        pools: stage.kind === "group" ? (wholeAtLeastOne((cfg.pools as { count?: unknown } | undefined)?.count) ?? 1) : 1,
      };
    case "swiss":
      return { kind: stage.kind, rounds: wholeAtLeastOne(cfg.rounds) };
    case "knockout":
      return { kind: stage.kind, thirdPlace: cfg.thirdPlace === true };
    case "double_elim":
      return { kind: stage.kind, bracketReset: cfg.bracketReset === true };
    default:
      return { kind: stage.kind };
  }
}

/** The lines Start draws for `stage` over a field of `n`, by the real generator; null for a kind whose draw does not grow with
 *  its field. The config is read through `startShape`, and only through it. */
export function startLines(stage: FormatStage, n: number): number | null {
  return linesOfShape(startShape(stage), n);
}

function linesOfShape(shape: StartShape, n: number): number | null {
  const field = Number.isInteger(n) && n > 0 ? n : 0;
  switch (shape.kind) {
    case "league":
    case "group":
      return poolSizes(field, shape.pools!).reduce((sum, size) => sum + roundRobinFixtureCount(size, shape.legs!), 0);
    case "swiss":
      return planSwissShells(shape.rounds ?? swissRoundsDefault(field), field).length;
    case "knockout":
      return generateSingleElim({ entrants: entrantIds(field), thirdPlace: shape.thirdPlace === true }).fixtures.length;
    case "double_elim":
      return generateDoubleElim({ entrants: entrantIds(field), bracketReset: shape.bracketReset === true }).fixtures.length;
    case "stepladder":
      return generateStepladder({ entrants: entrantIds(field) }).fixtures.length;
    default:
      return null;
  }
}

const maxMemo = new Map<string, number | null>();

/** How many entries the memo holds (tests only: the memo must not grow with play state, m-3). */
export function __formatMaxMemoSizeForTests(): number {
  return maxMemo.size;
}

/** The largest field `stage` can start within the budget, or null when its draw does not grow with the field. The search
 *  doubles from PROBE_FLOOR until the draw passes the budget, then halves the gap: it reads a draw that never shrinks as its
 *  field grows (lib/__tests__/format-max-entrants.test.ts walks every field up to each max, and the one past it). */
export function formatMaxEntrants(stage: FormatStage): number | null {
  const shape = startShape(stage);
  const memoKey = JSON.stringify(shape);
  const memo = maxMemo.get(memoKey);
  if (memo !== undefined) return memo;
  const lines = (n: number) => linesOfShape(shape, n);
  const floor = lines(PROBE_FLOOR);
  let max: number | null = null;
  if (floor !== null) {
    if (floor > START_LINE_BUDGET) {
      // A draw past the budget at the floor itself: a Swiss whose stored rounds the stage door bounds from below only
      // (schemas/stages.ts). Walk down to the largest field that fits; 0 when not even one entrant's draw does.
      let n = PROBE_FLOOR - 1;
      while (n > 0 && lines(n)! > START_LINE_BUDGET) n--;
      maxMemo.set(memoKey, n);
      return n;
    }
    let lo = PROBE_FLOOR;
    let hi = lo * 2;
    while (hi <= PROBE_CEILING && lines(hi)! <= START_LINE_BUDGET) {
      lo = hi;
      hi *= 2;
    }
    if (hi <= PROBE_CEILING) {
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (lines(mid)! <= START_LINE_BUDGET) lo = mid;
        else hi = mid;
      }
      max = lo;
    }
  }
  maxMemo.set(memoKey, max);
  return max;
}

/** A field over its format's max: what the refusal and the disabled Start say. */
export interface FormatMaxGate {
  max: number;
  entrants: number;
}

/** Why a division whose stages are `stages` (seq order) cannot start a field of `n`, or null. EMPTY CASE FIRST: no stages, no
 *  format, nothing to refuse. Only the FIRST stage is drawn at Start; a later stage draws from its qualifiers. */
export function formatMaxGate(stages: readonly FormatStage[], n: number): FormatMaxGate | null {
  const first = stages[0];
  if (first === undefined) return null;
  const max = formatMaxEntrants(first);
  return max !== null && n > max ? { max, entrants: n } : null;
}
