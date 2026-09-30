// Design §4's scenario catalogue as data (R11: a reviewed file, never a draw).
// The design's parents in design order, split into atoms by the rule in the W1b
// plan Task 4: split on alternative organiser INPUTS or CONDITIONS, never on an
// outcome the product/rulebook decides, never on a sport's own mechanism. A
// parent whose design text reads as alternatives (vs / or / slash) and is NOT
// split carries a written `noSplit` reason (scenario-catalogue.test.ts).
// Ruling 26 (O9): E stays its own scenarios; only E2 runs in L3.
// Ruling 30: M4 splits by whether the abandon carries a result; M12 is new.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ROW_KEYS, SPORT_KEYS, cellId } from "./catalogue.ts";
import { NO_CODE, NO_MESSAGE } from "./driver/types.ts";
import { FENCES } from "./model/fences.ts";
import { routeTo, type Route } from "./routing.ts";
import type { ScenarioKey } from "./scenarios/types.ts";

export type Family = "R" | "M" | "F" | "D" | "P" | "Q" | "X" | "C" | "E";
export type Layer = "L2" | "L3";
/** `facts`: the organiser-input facts that tell an atom from its siblings,
 *  where the titles alone could read as overlapping. Every pair of atoms in a
 *  parent that states them differs on a shared fact (scenario-catalogue.test.ts). */
interface Atom { readonly suffix: "a" | "b" | "c"; readonly title: string; readonly facts?: Readonly<Record<string, string>> }
export interface ParentScenario { readonly id: string; readonly title: string; readonly atoms: readonly Atom[]; readonly noSplit?: string }

const P = (id: string, title: string, atoms: readonly Atom[] = [], noSplit?: string): ParentScenario =>
  Object.freeze(noSplit === undefined ? { id, title, atoms } : { id, title, atoms, noSplit });
const A = (suffix: Atom["suffix"], title: string, facts?: Atom["facts"]): Atom =>
  facts === undefined ? { suffix, title } : { suffix, title, facts: Object.freeze({ ...facts }) };

export const PARENTS: readonly ParentScenario[] = Object.freeze([
  P("R1", "late entry before Start"),
  P("R2", "late entry after Start"),
  P("R3", "withdrawal before Start"),
  // Split on WHEN the organiser withdraws the entrant; expunge-vs-keep is the
  // engine's answer to that input (design §4), asserted, never picked. The
  // finalized (locked) fixtures matter only under half played: only an
  // expunge plans played fixtures, so only it can meet a locked one and skip
  // it (withdrawal.ts applyUpdate; r4-withdrawal.ts skippedItem). At or after
  // half the pending fixtures are walked over and a finalized one is never
  // planned, so R4b states no finalized fact.
  P("R4", "withdrawal mid-event after some results", [
    A("a", "under half the entrant's matches played, none of its fixtures finalized", { played: "under half", finalized: "none" }),
    A("b", "half or more of the entrant's matches played", { played: "half or more" }),
    A("c", "under half the entrant's matches played, some of its fixtures already finalized", { played: "under half", finalized: "some" }),
  ]),
  P("R5", "withdrawal after the entrant has played all their matches"),
  P("R6", "withdrawal of an entrant already drawn into a later bracket/playoff slot", [],
    "bracket vs playoff slot is the row's shape (applicability), not an organiser input"),
  P("R7", "disqualification (today: status only, no fixture cascade)"),
  P("R8", "entrant deleted"),
  P("R9", "pair/team rename or lineup change mid-event", [A("a", "pair/team rename mid-event"), A("b", "lineup change mid-event")]),
  P("R10", "waitlist promotion after the draw"),
  P("R11", "duplicate entrant", [A("a", "same person entered twice"), A("b", "same person in two partnerships in one division")]),
  P("R12", "doubles partner withdraws", [A("a", "→ a substitute joins"), A("b", "→ the pair is dissolved")]),
  P("R13", "entrant moved to another division after the draw"),
  P("R14", "retires from one match, continues in the next"),
  P("R15", "entrant leaves after their last match and is still paired next round"),
  P("R16", "substitute / different lineup in a team match (stats attribution)", [],
    "'substitute' and 'different lineup' name one input: a changed team lineup"),
  P("M1", "walkover in only one match"),
  P("M2", "double walkover"),
  P("M3", "retirement mid-match (partial score)"),
  // Ruling 30: split on whether the abandon carries a result.
  P("M4", "abandoned", [
    A("a", "with no result"),
    A("b", "with a result (a cricket DLS decision, a football award-policy abandon)"),
  ]),
  P("M5", "draw in a stage that cannot end level"),
  P("M6", "tie after regulation → decider (shoot-out, super over, extra time, chess tiebreak)", [], "the decider is the sport's mechanism (variant axis), not an organiser input"),
  P("M7", "void a decided result", [A("a", "before the next match started"), A("b", "after the next match started")]),
  P("M8", "correct a finalized score", [A("a", "winner stays"), A("b", "winner flips")]),
  P("M9", "forfeit/award by the organiser", [A("a", "forfeit (core.forfeit)"), A("b", "award (core.award)")]),
  P("M10", "disqualification mid-match"),
  P("M11", "a rules change attempted mid-match — must refuse (ruling 12)"),
  // Ruling 30.
  P("M12", "player injured mid-match (team sport)", [
    A("a", "a substitute comes on and the match continues"),
    A("b", "no replacement: the team plays short"),
    A("c", "a cricket batter retires hurt, then resumes"),
  ]),
  P("F1", "odd field (byes)"),
  P("F2", "field below the format's minimum"),
  P("F3", "non-power-of-two bracket"),
  P("F4", "unequal pools"),
  P("F5", "ties", [A("a", "two-way tie"), A("b", "three-or-more-way tie")]),
  P("F6", "everyone level"),
  P("F7", "tie falling through to lots"),
  P("F8", "protected seeds"),
  P("D1", "two divisions merged"),
  P("D2", "one division split"),
  P("D3", "seeding changed after the draw is published"),
  P("D4", "separation", [A("a", "same-club separation"), A("b", "same-country separation")]),
  P("D5", "re-draw after fixtures are published or timed", [A("a", "after fixtures are published (untimed)"), A("b", "after fixtures are timed")]),
  P("D6", "format changed after entries close"),
  P("D7", "stage rules changed after Start"),
  P("P1", "complete a stage with a fixture pending"),
  P("P2", "group → knockout with a qualifying tie unresolved"),
  P("P3", "Generate after a roster change"),
  P("P4", "Rebuild after results exist"),
  P("P5", "undo", [A("a", "undo Generate"), A("b", "undo Pair next round")]),
  P("P6", "per-stage rule override (a best-of-3 final)"),
  P("P7", "rank override"),
  P("Q1", "qualifier decided, then a correction changes it after the knockout draw", [A("a", "decided by lots"), A("b", "decided by the organiser")]),
  P("Q2", "group winner withdraws after qualifying → promote next or bye", [], "promote-next vs bye is the rulebook's answer (an expected value), not an input"),
  P("Q3", "third-place match skipped → shared 3rd"),
  P("Q4", "final not played", [A("a", "→ joint winners"), A("b", "→ decided by table")]),
  P("Q5", "plate", [A("a", "plate entrant withdraws"), A("b", "a main-draw loser declines the plate")]),
  P("X1", "weather stops play mid-round", [A("a", "resumed next day"), A("b", "cancelled")]),
  P("X2", "event cut short: remaining rounds cancelled, standings and winner from an incomplete table"),
  P("X3", "a round shortened on the fly (fixture-level format override before start)"),
  P("X4", "a match resumed or replayed", [A("a", "resumed from its saved score"), A("b", "replayed from scratch"), A("c", "replayed after a protest")]),
  P("C1", "scores swapped home/away", [], "one input: the two sides' scores exchanged"),
  P("C2", "result entered on the wrong match"),
  P("C3", "protest upheld", [A("a", "result overturned"), A("b", "replayed a day later")]),
  P("C4", "ineligible player → retroactive forfeits across the table"),
  P("C5", "points deduction (conduct) applied to the table"),
  P("C6", "late correction", [A("a", "after the stage is complete"), A("b", "after the event is complete")]),
  P("C7", "result annulled weeks later"),
  P("E1", "phone pad"),
  P("E2", "single-event result over the API (there is no separate quick-result endpoint)"),
  P("E3", "Bo1 points editor"),
  P("E4", "device link / printed scorer-sheet scan", [A("a", "device link"), A("b", "printed scorer-sheet scan")]),
]);

/** Design §4 "Cases that need times" and the browser-only entry paths: never
 *  L3. Keyed by ATOM: every atom of a needs-times parent, except the ones
 *  design §4 says run in L3 ("Within D5 only D5b … needs times; D5a … runs in
 *  L3" — publishSchedule accepts an untimed board). */
const L3_EXCLUDED: Readonly<Record<string, string>> = Object.freeze({
  E1: "browser-only: the phone pad (L2)",
  E3: "browser-only: the Bo1 points editor (L2)",
  E4a: "needs times (design §4): device link",
  E4b: "needs times (design §4): printed-sheet surface",
  X1a: "needs times (design §4)",
  X1b: "needs times (design §4)",
  D5b: "needs times (design §4): the re-draw of a timed schedule",
});
/** L3-only: the API path has no browser counterpart. */
const L2_EXCLUDED = new Set(["E2"]);

/** Design §4 "Known 🚫 at design time" (no route or screen today), keyed by
 *  PARENT, with the route to the wave that owes each a build-or-refuse ruling
 *  ("division-level D1, D2, R13 in W9; D4 in W4; Q4 in W4; C5 in W5"). */
const KNOWN_NO_PATH: Readonly<Record<string, Route>> = Object.freeze({
  D1: routeTo("W9", "division merge: build-or-refuse ruling (design §4)"),
  D2: routeTo("W9", "division split: build-or-refuse ruling (design §4)"),
  R13: routeTo("W9", "entrant moved to another division after the draw: build-or-refuse ruling (design §4)"),
  D4: routeTo("W4", "separation: build-or-refuse ruling (design §4)"),
  Q4: routeTo("W4", "final not played: build-or-refuse ruling (design §4)"),
  C5: routeTo("W5", "points deduction: carry_deltas exists only through stage PUT, FORMAT_LOCKED once fixtures exist; build-or-refuse ruling (design §4)"),
});
/** Design §4 "Known UI-only 🚫" (ruling 30), keyed by ATOM: an HTTP route
 *  exists (L3 runs), but no screen sends it (the L2 run records 🚫). M12b's
 *  `core.lineup.retirement` has no pad or console control, and no
 *  minimum-players rule exists; both are owed to W2. */
const KNOWN_UI_NO_PATH: Readonly<Record<string, Route>> = Object.freeze({
  M12b: routeTo("W2", "core.lineup.retirement has no pad or console control (ruling 30)"),
});

export interface AtomicScenario {
  readonly id: string;
  readonly parent: string;
  readonly family: Family;
  readonly title: string;
  readonly layers: readonly Layer[];
  readonly l3Excluded: string | null;
  readonly knownNoPath: string | null;
  readonly l2NoPath: string | null;
}

export const ATOMIC: readonly AtomicScenario[] = Object.freeze(PARENTS.flatMap((p) => {
  const atoms = p.atoms.length === 0
    ? [{ id: p.id, title: p.title }]
    : p.atoms.map((a) => ({ id: `${p.id}${a.suffix}`, title: `${p.title}: ${a.title}` }));
  return atoms.map((a): AtomicScenario => {
    const l3Excluded = L3_EXCLUDED[a.id] ?? null;
    const layers: Layer[] = [...(L2_EXCLUDED.has(a.id) ? [] : ["L2" as const]), ...(l3Excluded === null ? ["L3" as const] : [])];
    return Object.freeze({
      id: a.id,
      parent: p.id,
      family: p.id[0] as Family,
      title: a.title,
      layers: Object.freeze(layers),
      l3Excluded,
      knownNoPath: KNOWN_NO_PATH[p.id]?.wave ?? null,
      l2NoPath: KNOWN_UI_NO_PATH[a.id]?.wave ?? null,
    });
  });
}));

export const LIFECYCLE_ID = "LIFECYCLE";
export const l3Atomic = (): AtomicScenario[] => ATOMIC.filter((a) => a.layers.includes("L3"));
export const l2Atomic = (): AtomicScenario[] => ATOMIC.filter((a) => a.layers.includes("L2"));

/** Atoms a W1a scenario already drives. R4a is W1a's R4 (seed 3 of 8 withdraws
 *  after round 1: under half the entrant's matches played). */
export const HARNESS_SCENARIO: Readonly<Record<string, ScenarioKey>> = Object.freeze({ LIFECYCLE: "LIFECYCLE", M1: "M1", R4a: "R4", F1: "F1" });

// --- R29: shrunk fast-check failures as named regression cases ---------------
export const REGRESSIONS_PATH = "scripts/matrix/catalogue/regressions.json";
const CELLS = new Set(ROW_KEYS.flatMap((r) => SPORT_KEYS.map((s) => cellId(r, s))));
/** The model's generic checks — any refusal it held legal, any refusal the
 *  product did not name (every 5xx included), any harness error — which name
 *  no single failure: a case on one must carry `match` (T15 fix rounds 2 and
 *  3), or it would make every such failure on its cell "known". The names are
 *  state.ts's (UNEXPECTED_REFUSAL, REFUSAL_NAMED) and run-cell.ts's
 *  (MODEL_ERROR); model-run-cell.test.ts pins them. They are also the only
 *  checks whose failure carries the product's answer (`said`: commands.ts's
 *  refusals, an escaped RefusedCall), so a match is refused on every other
 *  (final batch FB-3). */
export const MATCH_REQUIRED_CHECKS = ["model-unexpected-refusal", "model-refusal-named", "model-error"] as const;
const matchRequired = (check: string): boolean => (MATCH_REQUIRED_CHECKS as readonly string[]).includes(check);
/** A match names a failure by the product's words (final batch FB-3): at
 *  least this long once trimmed — the committed ones run 28+ — so a word such
 *  as "fixture" or a lone code cannot name every refusal on its cell. */
export const MATCH_MIN_LENGTH = 12;
/** What RefusedCall writes around the product's words (its request line and
 *  placeholders): a match carrying any of it names the harness's text. */
const REQUEST_LINE_TEXT: readonly (readonly [(match: string) => boolean, string])[] = [
  [(m) => m.includes("→"), "RefusedCall's arrow"],
  [(m) => /\bHTTP \d{3}\b/.test(m), "a status line"],
  [(m) => m.includes(NO_CODE) || m.includes(NO_MESSAGE), "a placeholder"],
  [(m) => /^\s*(?:GET|POST|PUT|PATCH|DELETE)\b/.test(m), "a request method"],
  [(m) => m.includes("/api/"), "a request path"],
  [(m) => /^\s*[A-Z][A-Z0-9_]*\s*$/.test(m), "a bare code (the status line's, never the product's words)"],
];
/** Why a match is too weak to name one failure, or null. */
function trivialMatch(match: string): string | null {
  if (match.trim().length < MATCH_MIN_LENGTH) return `under ${MATCH_MIN_LENGTH} characters once trimmed`;
  return REQUEST_LINE_TEXT.find(([is]) => is(match))?.[1] ?? null;
}
const FENCE_IDS: ReadonlySet<string> = new Set(FENCES.map((f) => f.id));
const RegressionSchema = z.strictObject({
  id: z.string().regex(/^MB-\d{3}$/),
  title: z.string().min(1),
  issue: z.string().regex(/^#\d+$/).nullable(),
  cell: z.string().refine((c) => CELLS.has(c), "cell is not on the grid"),
  variant: z.string().min(1),
  check: z.string().min(1),
  seed: z.number().int(),
  path: z.string().min(1),
  /** fast-check's commands replay hint (`fc.commands(…, { replayPath })`): with
   *  seed + path alone the shrunk command list may not reproduce (R-PF9).
   *  null only when the counterexample carried none. */
  replayPath: z.string().min(1).nullable(),
  /** The command bound the finding run used (`--max-commands`). Replay uses it:
   *  a shorter bound may never reach the failing command (W1b carry b). */
  maxCommands: z.number().int().min(1),
  /** Whether the finding run had its fences on (its report's cell `fences`),
   *  as the run's own evidence (W1b carry b). Replay honours it while the case
   *  names no fence of its own (replayFences). */
  fencesOn: z.boolean(),
  fence: z.string().min(1).nullable(),
  /** Text that must appear in the product's own words (its refusal message,
   *  or a server assertion it carries — never RefusedCall's request line, never
   *  the harness's lines) for this case to name the failure: a failure is
   *  known only when cell, check AND match agree. Owed on MATCH_REQUIRED_CHECKS
   *  (null there would name every failure on the check) and refused on every
   *  other check, which never carries the product's answer: null names those
   *  (final batch FB-3). A trivial match is refused (trivialMatch). */
  match: z.string().min(1).nullable(),
  status: z.enum(["open", "fixed"]),
  found: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  runId: z.string().min(1),
}).superRefine((r, ctx) => {
  if (r.match === null && matchRequired(r.check)) {
    ctx.addIssue({ code: "custom", path: ["match"], message: `${r.id}: match is required on ${r.check} — the text in the failure's evidence that names it (the product's message)` });
  }
  if (r.match !== null && !matchRequired(r.check)) {
    ctx.addIssue({ code: "custom", path: ["match"], message: `${r.id}: a match is refused on ${r.check}, which never carries the product's answer — the harness judges it alone, so a null match names it` });
  }
  const trivial = r.match === null ? null : trivialMatch(r.match);
  if (trivial !== null) {
    ctx.addIssue({ code: "custom", path: ["match"], message: `${r.id}: match ${JSON.stringify(r.match)} is trivial (${trivial}) — quote the product's own words` });
  }
  // F-2: a fence is one the model has, or the case claims a fence nothing applies.
  if (r.fence !== null && !FENCE_IDS.has(r.fence)) {
    ctx.addIssue({ code: "custom", path: ["fence"], message: `${r.id}: fence ${JSON.stringify(r.fence)} is not one of the model's fences (${[...FENCE_IDS].join(", ")})` });
  }
});
export type RegressionCase = z.infer<typeof RegressionSchema>;

/** The fences a --regressions replay of `r` runs with (W1c Task 2, controller
 *  ruling Q1): the finding run's own, unless the case names a fence. A fence
 *  named for a case is added after its finding — it fences out the very
 *  command the case exists to reproduce — so such a case replays unfenced. */
export function replayFences(r: Pick<RegressionCase, "fencesOn" | "fence">): boolean {
  return r.fencesOn && r.fence === null;
}
const FileSchema = z.strictObject({ schemaVersion: z.literal(1), regressions: z.array(RegressionSchema) });

export function parseRegressions(json: unknown): RegressionCase[] {
  const { regressions } = FileSchema.parse(json);
  const seen = new Set<string>();
  for (const r of regressions) {
    if (seen.has(r.id)) throw new Error(`regressions: duplicate id ${r.id}`);
    seen.add(r.id);
  }
  return regressions;
}

export function loadRegressions(repoRoot: string = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")): RegressionCase[] {
  return parseRegressions(JSON.parse(readFileSync(resolve(repoRoot, REGRESSIONS_PATH), "utf8")));
}
