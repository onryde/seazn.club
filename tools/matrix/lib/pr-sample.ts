// --set pr-sample (W1d Task 7, R27, D13): the per-PR sample.
//
// A PR that touches the engine or stages.ts declares the matrix rows it touches (`Matrix rows:` in its body,
// read by ci/pr-rows.ts). The sample is the L3 cases on those rows (the w1-driving set's cases there) plus a
// FIXED sample of 33: the slice's 24 cases, and league|<sport>|<variant>|LIFECYCLE on the 9 sports the slice
// lacks, so every registered sport has at least one case in every PR's sample. It is judged against the
// committed baseline (catalogue/baseline.json names it), restricted to the EXACT ids it plans.
//
// `variantFor` is the only variant authority (review m10): the run's own builder-default reader, never a
// constant here. The rows are validated against the catalogue wherever they enter (parseRows at the CLI and the
// body, planPrSample and the planner for a caller that skips it), and a refusal names the row and lists the
// catalogue, so a typo is never read as "the fixed sample only".
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ROW_KEYS, SPORT_KEYS } from "./catalogue.ts";
import type { CaseSpec } from "./scenarios/types.ts";
import { SLICE_SPORTS, planSliceCases } from "./slice.ts";
import { planW1Driving } from "./w1-driving-set.ts";
// Type-only: run.ts value-imports this module, and an erased import cannot cycle.
import type { PlanCases } from "../run.ts";

export const PR_SAMPLE_SET = "pr-sample";

const MATRIX = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(MATRIX, "..", "..");

// --- the rows a PR declares ---------------------------------------------------------------------------------------

/** A row the declaration names that the catalogue lacks. Named, with the whole catalogue, so the author sees the typo. */
export class UnknownRow extends Error {
  constructor(row: string) {
    super(`matrix rows: unknown row '${row}' (rows: ${ROW_KEYS.join(", ")}; or all, or none)`);
    this.name = "UnknownRow";
  }
}

/** --set pr-sample was asked to plan with no rows declared. A sample nobody declared rows for is not "none": the
 *  workflow always passes the declaration, so its absence is a wiring fault, never a default. */
export class PrSampleNeedsRows extends Error {
  constructor() {
    super(`--set ${PR_SAMPLE_SET} needs the rows a PR declares: --rows <row>[,<row>...] | all | none`);
    this.name = "PrSampleNeedsRows";
  }
}

/** The fixed sample planned nothing. It is the sample's floor — every PR runs it whatever rows it declares — so a plan
 *  built over none is no sample, and a run of nothing must never read as one. */
export class EmptyPrSample extends Error {
  constructor() {
    super(`${PR_SAMPLE_SET}: the fixed sample plans no case, so there is no sample to run (it is the floor of every PR's plan, whatever rows it declares)`);
    this.name = "EmptyPrSample";
  }
}

const ROW_SET: ReadonlySet<string> = new Set(ROW_KEYS);

/** `none`, optionally with a reason after a dash: `none — copy only`. The dash needs a space before it. */
const NONE = /^none(?:\s+[—–-]\s*.*)?$/;

/** What follows `Matrix rows:`: `all`; `none` (with an optional reason); or catalogue rows, comma-separated. The result
 *  is sorted and deduplicated, so one declaration has one canonical form. Matched exactly, never case-folded, so what
 *  is planned is what was typed. */
export function parseRows(text: string): readonly string[] | "all" {
  const t = text.trim();
  if (t === "all") return "all";
  if (NONE.test(t)) return [];
  const rows = t.split(",").map((r) => r.trim());
  for (const r of rows) if (!ROW_SET.has(r)) throw new UnknownRow(r);
  return [...new Set(rows)].sort();
}

/** The one spelling of a declaration — what planOf records and the workflow passes back: `none`, `all`, or the sorted rows. */
export function formatRows(rows: readonly string[] | "all"): string {
  if (rows === "all") return "all";
  return rows.length === 0 ? "none" : [...new Set(rows)].sort().join(",");
}

// --- the plan ------------------------------------------------------------------------------------------------------

/** The fixed sample: the slice's 24 cases, then league|<sport>|<variant>|LIFECYCLE for each registered sport the slice
 *  lacks (9 at HEAD). Every sport the registry holds appears, so a PR on any row still exercises each sport once. */
export function fixedSample(variantFor: (sport: string) => string): CaseSpec[] {
  const out = planSliceCases(variantFor);
  for (const sport of SPORT_KEYS) {
    if ((SLICE_SPORTS as readonly string[]).includes(sport)) continue;
    const variant = variantFor(sport);
    out.push({ caseId: `league|${sport}|${variant}|LIFECYCLE`, row: "league", sport, variant, scenario: "LIFECYCLE", canary: false });
  }
  return out;
}

/** Seams for the tests that must reach what no committed plan can: a fixed sample that plans nothing, and proof
 *  that a plan declaring no rows never consults the w1-driving set. */
export interface PrSampleDeps {
  /** The fixed sample (default: fixedSample). */
  fixed?: (variantFor: (sport: string) => string) => CaseSpec[];
  /** The whole w1-driving set (default: planW1Driving with an explicit empty filter). */
  w1?: (variantFor: (sport: string) => string) => CaseSpec[];
}

/** The declared rows, refused by name when the catalogue lacks one (a caller that skipped parseRows). */
function checkRows(rows: readonly string[] | "all"): readonly string[] | "all" {
  if (rows === "all") return rows;
  for (const r of rows) if (!ROW_SET.has(r)) throw new UnknownRow(r);
  return rows;
}

/** The sample for `rows`: the w1-driving cases on those rows (the full set, its filter argument explicit), then the
 *  fixed sample, each case once — a row's own cases lead, in w1-driving order, and the fixed sample's remaining cases
 *  follow in its order. */
export function planPrSample(rows: readonly string[] | "all", variantFor: (sport: string) => string, deps: PrSampleDeps = {}): CaseSpec[] {
  const declared = checkRows(rows);
  const fixed = (deps.fixed ?? fixedSample)(variantFor);
  // The assumption "the fixed sample is non-empty" is asserted here, so the plan below is never empty.
  if (fixed.length === 0) throw new EmptyPrSample();
  // No rows declared: the w1-driving set is not consulted, so the fixed sample runs whatever state its files are in.
  const w1 = deps.w1 ?? ((v: (sport: string) => string) => planW1Driving(v, {}));
  const onRows = declared !== "all" && declared.length === 0
    ? []
    : w1(variantFor).filter((c) => declared === "all" || declared.includes(c.row));
  const seen = new Set<string>();
  const out: CaseSpec[] = [];
  for (const c of [...onRows, ...fixed]) {
    if (seen.has(c.caseId)) continue;
    seen.add(c.caseId);
    out.push(c);
  }
  return out;
}

/** run.ts's SETS['pr-sample']: the plan for the rows the command line declared. It declares every registered sport
 *  (the fixed sample spans them all), so the runner reads each one's variant order before planning. */
export const prSamplePlanner: PlanCases = (cli) => {
  if (cli.rows === undefined) throw new PrSampleNeedsRows();
  const rows = checkRows(cli.rows);
  return { sports: SPORT_KEYS, deniesFeatures: false, plan: (variantFor) => planPrSample(rows, variantFor) };
};

// --- the committed baseline ----------------------------------------------------------------------------------------

/** catalogue/baseline.json is missing, not what it should be, or names a file that is not there: a sample judged
 *  against nothing would pass every PR. */
export class BaselineUnreadable extends Error {
  constructor(file: string, why: string) {
    super(`pr-sample: the baseline file ${file} cannot be used — ${why}`);
    this.name = "BaselineUnreadable";
  }
}

/** Owner ruling 70's cases (2026-10-05): the ruling names these three and no others. They are frozen HERE, in code, so the list is the
 *  ruling's at runtime and not only in a CI test: a `ruling70` block that names any other set is refused at load (BaselineUnreadable,
 *  and exit 2 from `judge regression`). The list retires with the SW-H1 fix: remove `ruling70` from catalogue/baseline.json and this
 *  constant together, and re-baseline L3. */
export const RULING_70_IDS: readonly string[] = [
  "swiss_knockout|football|11-a-side|R4",
  "swiss_knockout|carrom|club-29|R4",
  "swiss_knockout|generic|score|R4",
];

/** Owner ruling 70 (2026-10-05): cases the baseline records in ONE state whatever the baseline run showed, because the
 *  product's own randomness (a UUID-hashed lots draw, by design) exposes a defect in some runs and not in others. Triage keys
 *  only reds, so a case the baseline run saw WORK has no rule to say it is red; the override is the baseline's own say-so.
 *  `state` can only be red: forcing a case to a HELD state would hide a regression, and nothing asks for that.
 *  The block is bound to the run it was written for (`workflowRun`, `tag`, `tagCommit`): see baselineOverrides. */
const Ruling70 = z.strictObject({
  note: z.string().min(1),
  state: z.literal("red"),
  /** The defect's id in the W1-driving map (P6), its audit gap (SW-H1) and the wave that owns it. */
  cause: z.string().min(1),
  gap: z.string().min(1),
  wave: z.string().min(1),
  /** The baseline run this list qualifies: the workflow run that produced the committed L3 (its results.json runId is
   *  `ci-<workflowRun>-<attempt>-l3`), the tag it was dispatched on, and that tag's commit. */
  workflowRun: z.number().int().positive(),
  tag: z.string().min(1),
  tagCommit: z.string().regex(/^[0-9a-f]{40}$/, "a full 40-hex commit"),
  ids: z.array(z.string().min(1)).min(1),
}).superRefine((v, ctx) => {
  const want = new Set(RULING_70_IDS);
  const extra = [...new Set(v.ids)].filter((id) => !want.has(id));
  const missing = RULING_70_IDS.filter((id) => !v.ids.includes(id));
  const twice = v.ids.filter((id, i) => v.ids.indexOf(id) !== i);
  if (extra.length + missing.length + twice.length > 0) {
    ctx.addIssue({
      code: "custom", path: ["ids"],
      message: `owner ruling 70 names exactly its ${RULING_70_IDS.length} cases and no others (extra: ${extra.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}; listed twice: ${twice.join(", ") || "none"}); a different list is a new ruling`,
    });
  }
});
export type Ruling70Overrides = z.infer<typeof Ruling70>;

const BaselineFile = z.object({ L3: z.string(), ruling70: Ruling70.optional() });

/** catalogue/baseline.json, read and parsed: refused by name when it is missing, not JSON, or not the shape. */
function readBaselineFile(dirs: { catalogue?: string; repo?: string }): { file: string; data: z.infer<typeof BaselineFile> } {
  const file = resolve(dirs.catalogue ?? resolve(MATRIX, "catalogue"), "baseline.json");
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { throw new BaselineUnreadable(file, "it cannot be read"); }
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new BaselineUnreadable(file, "it is not JSON"); }
  const parsed = BaselineFile.safeParse(json);
  if (!parsed.success) throw new BaselineUnreadable(file, `it is not { "L3": "<path>", "ruling70"?: { … } } — ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  return { file, data: parsed.data };
}

/** The committed L3 baseline's results.json, resolved against the repo root: catalogue/baseline.json names it
 *  (`{ "L3": "<repo-relative path>" }`; PR-B moves the name to its own evidence). Refused when the file is missing, is
 *  not that shape, or names a file that is not there. */
export function baselineL3Path(dirs: { catalogue?: string; repo?: string } = {}): string {
  const { file, data } = readBaselineFile(dirs);
  const path = resolve(dirs.repo ?? REPO, data.L3);
  if (!existsSync(path) || !statSync(path).isFile()) throw new BaselineUnreadable(file, `its L3 names ${data.L3}, which is not a file there`);
  return path;
}

/** Whether the ruling-70 list qualifies the run `runId`: the run it was written for. A results.json's runId is
 *  `ci-<workflowRun>-<attempt>-l3`, so a re-baselined L3 (a later workflow run) is not the run the list was written for. */
export function ruling70AppliesTo(block: Pick<Ruling70Overrides, "workflowRun">, runId: string): boolean {
  return new RegExp(`^ci-${block.workflowRun}-\\d+-l3$`).test(runId);
}

/** The baseline's ruling-70 override list, or null when baseline.json carries none. `judge regression` applies it to the
 *  baseline it is given, so every caller that judges against the baseline (matrix:sample, a weekly run) honours it.
 *  A block is checked against the committed L3 it sits beside: written for another run (the L3 was re-baselined) or another
 *  tag commit, it is refused, so the override cannot outlive the baseline it qualifies (T21 review M1). */
export function baselineOverrides(dirs: { catalogue?: string; repo?: string } = {}): Ruling70Overrides | null {
  const { file, data } = readBaselineFile(dirs);
  const block = data.ruling70;
  if (block === undefined) return null;
  const l3 = baselineL3Path(dirs);
  let prov: { runId?: unknown; harnessCommit?: unknown };
  try { prov = JSON.parse(readFileSync(l3, "utf8")) as typeof prov; } catch { throw new BaselineUnreadable(file, `ruling70 cannot be checked: ${data.L3} is not JSON`); }
  if (typeof prov.runId !== "string" || typeof prov.harnessCommit !== "string" || prov.harnessCommit.length < 7) {
    throw new BaselineUnreadable(file, `ruling70 cannot be checked: ${data.L3} carries no runId and harnessCommit`);
  }
  const stale = "the SW-H1 fix removes ruling70 and re-baselines L3; until then a re-baseline must carry the block forward by hand, with the new run's provenance";
  if (!ruling70AppliesTo(block, prov.runId)) {
    throw new BaselineUnreadable(file, `ruling70 was written for workflow run ${block.workflowRun} (tag ${block.tag}) and the L3 it sits beside is ${prov.runId}: ${stale}`);
  }
  if (!block.tagCommit.startsWith(prov.harnessCommit)) {
    throw new BaselineUnreadable(file, `ruling70 names tag ${block.tag} at ${block.tagCommit}, and the L3 it sits beside was run from ${prov.harnessCommit}: ${stale}`);
  }
  return block;
}
