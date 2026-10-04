// --set w1b-probe: the smallest live set that drives W1b's new L3 paths
// against the real product —
//  - the single-stage API-only rows, gated or not (LIFECYCLE on generic, in an
//    org denied nothing; run.ts refuses the run, PlanLacksGate, when the case
//    orgs' plan does not grant the row's gate);
//  - one DENIED case per gated row (⛔, ruling 24), each org denied its gate;
//  - one committed variant case per slice sport, its override on the wire.
// Every part is derived: the rows from the catalogue registry, the gates from
// the text-pinned product gate map (format-gates-copy.ts), the variant cases
// from the COMMITTED variants.json (Task 8) by the rule in pickProbeVariant.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { API_ONLY_ROWS, ROW_KEYS, stagesForRow, type RowKey, type StagePostBody } from "./catalogue.ts";
import { expectedGate, type FormatGate } from "./format-gates-copy.ts";
import type { CaseSpec } from "./scenarios/types.ts";
import { SLICE_ROWS, SLICE_SPORTS } from "./slice.ts";
import { scorable, type VariantCase } from "./variants.ts";
// Type-only: run.ts value-imports this module, and an erased import cannot cycle.
import type { PlannerCli, PlanCases } from "../run.ts";

export const PROBE_SET = "w1b-probe";

/** A row's stage derivation threw while the set was being built (fix round 1,
 *  m-1). Named, so run.ts refuses the set (exit 2) instead of dying at import. */
export class ProbeRowUnderivable extends Error {
  readonly row: string;
  constructor(row: string, cause: unknown) {
    super(`probe-set: row '${row}' cannot be derived (${cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)}) — the set is refused before the DB`);
    this.name = "ProbeRowUnderivable";
    this.row = row;
  }
}

export interface ProbeRows {
  /** The API-only rows driven LIFECYCLE: single-stage only — `w1b-probe` is
   *  W1b's frozen probe; the multi-stage API-only row (`group_group_ko`) is
   *  driven by the `w1-driving` set (`lib/w1-driving-set.ts`), which
   *  W1-driving added — gated or not: a gated row's ALLOWED path is driven
   *  here, its refusal by its DENIED case (fix round 1, I-1: a 402 alone
   *  proves only that the body parses). */
  readonly api: readonly RowKey[];
  /** Every row the product gates, with its gate, in registry order — from the
   *  gate map, never a typed list, so a product change to the gates moves
   *  this set with it. */
  readonly denied: readonly { row: RowKey; gate: FormatGate }[];
}

/** The set's rows, derived on every call and never at import (m-1): run.ts
 *  value-imports this module, so an import-time throw would kill every mode
 *  with exit 1 and a raw stack. Here it is ProbeRowUnderivable, raised inside
 *  runSlice's planner try (exit 2). */
export function probeRows(stagesFor: (row: RowKey) => readonly StagePostBody[] = stagesForRow): ProbeRows {
  const isApi = new Set<string>(API_ONLY_ROWS);
  const api: RowKey[] = [];
  const denied: { row: RowKey; gate: FormatGate }[] = [];
  for (const row of ROW_KEYS) {
    let stages: readonly StagePostBody[];
    try { stages = stagesFor(row); } catch (e) { throw new ProbeRowUnderivable(row, e); }
    if (isApi.has(row) && stages.length === 1) api.push(row);
    const gate = expectedGate(stages);
    if (gate !== null) denied.push({ row, gate });
  }
  return { api: Object.freeze(api), denied: Object.freeze(denied) };
}

/** The API-only and DENIED cases run on one sport: both row shapes and the
 *  gates are sport-independent (stagesForRow takes no sport; createStages
 *  gates on stage kinds), and generic is the cheapest sport to drive. */
const PROBE_SPORT = "generic";

const VARIANTS_JSON = resolve(dirname(fileURLToPath(import.meta.url)), "..", "catalogue", "variants.json");

/** A named set is the whole set: a filter handed to it would be silently
 *  ignored. parseCli refuses the combination; this is the guard behind it. */
export class SetTakesNoFilter extends Error {
  constructor(set: string, cli: PlannerCli) {
    const given = (["only", "scenario", "canary"] as const).filter((k) => cli[k] !== undefined).map((k) => `--${k}`);
    super(`probe-set: --set ${set} runs the whole set; it takes no ${given.join(", ")}`);
    this.name = "SetTakesNoFilter";
  }
}

/** No committed case of the sport meets the selection rule. */
export class NoProbeVariant extends Error {
  constructor(sport: string) {
    super(`probe-set: no committed variant case for ${sport} has a non-empty override, a recorded scorable run and a slice row`);
    this.name = "NoProbeVariant";
  }
}

/** A bound variant case the harness cannot score (T6/T8 carry): its committed
 *  record says so, or re-scoring it NOW through the real generate-then-fold
 *  does — the committed `scorable` is a claim made when the catalogue was
 *  generated, and a live run must not bind a case the engine refuses today. */
export class BoundVariantUnscorable extends Error {
  readonly caseId: string;
  readonly reason: string;
  constructor(caseId: string, reason: string) {
    super(`probe-set: bound variant ${caseId} is not scorable — ${reason}`);
    this.name = "BoundVariantUnscorable";
    this.caseId = caseId;
    this.reason = reason;
  }
}

/** The selection rule, stated once: the FIRST case in committed (generation)
 *  order whose override is non-empty (else it is a default case), whose
 *  recorded `scorable` is null, and whose row is a slice row (a shape W1a
 *  already drives, so the override is the only new thing on the wire). */
export function pickProbeVariant(sport: string, cases: readonly VariantCase[]): VariantCase {
  const vc = cases.find((c) => Object.keys(c.overrides).length > 0 && c.scorable === null && (SLICE_ROWS as readonly string[]).includes(c.row));
  if (vc === undefined) throw new NoProbeVariant(sport);
  return vc;
}

/** Refuses a case whose committed record OR whose re-score today is not null. */
export function requireScorable(vc: VariantCase, rescore: (vc: VariantCase) => string | null = scorable): VariantCase {
  if (vc.scorable !== null) throw new BoundVariantUnscorable(vc.id, `committed: ${vc.scorable}`);
  const now = rescore(vc);
  if (now !== null) throw new BoundVariantUnscorable(vc.id, `re-scored now: ${now}`);
  return vc;
}

interface VariantsFile { sports: { sport: string; cases: VariantCase[] }[] }

export interface ProbeDeps {
  /** The committed variant set (default: tools/matrix/catalogue/variants.json). */
  variants?: () => VariantsFile;
  /** Re-scores a bound case (default: variants.ts scorable). */
  rescore?: (vc: VariantCase) => string | null;
  /** A row's stage bodies (default: catalogue.ts stagesForRow). */
  stagesFor?: (row: RowKey) => readonly StagePostBody[];
}

const readVariants = (): VariantsFile => JSON.parse(readFileSync(VARIANTS_JSON, "utf8")) as VariantsFile;

/** The planner, with its row derivation, file read and re-score injectable.
 *  Everything that needs no DB — the rows, the file, the selection, the
 *  re-score — happens here, at construction, so run.ts refuses a bad set
 *  before it opens a connection. */
export function makeProbePlanner(deps: ProbeDeps = {}): PlanCases {
  return (cli) => {
    if (cli.only !== undefined || cli.scenario !== undefined || cli.canary !== undefined) throw new SetTakesNoFilter(PROBE_SET, cli);
    const rows = probeRows(deps.stagesFor);
    const file = (deps.variants ?? readVariants)();
    const bound = SLICE_SPORTS.map((sport) => {
      const cases = file.sports.find((s) => s.sport === sport)?.cases ?? [];
      return requireScorable(pickProbeVariant(sport, cases), deps.rescore);
    });
    return {
      // Generic's order picks the API/DENIED variant; every declared sport's
      // order is compared with the offline default before any case (RF5).
      sports: SLICE_SPORTS,
      deniesFeatures: rows.denied.length > 0,
      plan: (variantFor) => {
        const out: CaseSpec[] = [];
        const g = variantFor(PROBE_SPORT);
        for (const row of rows.api) out.push({ caseId: `${row}|${PROBE_SPORT}|${g}|LIFECYCLE`, row, sport: PROBE_SPORT, variant: g, scenario: "LIFECYCLE", canary: false });
        for (const { row, gate } of rows.denied) {
          out.push({ caseId: `${row}|${PROBE_SPORT}|${g}|DENIED`, row, sport: PROBE_SPORT, variant: g, scenario: "DENIED", canary: false, deny: [gate] });
        }
        for (const vc of bound) {
          out.push({ caseId: `${vc.row}|${vc.sport}|${vc.preset}|LIFECYCLE|${vc.id}`, row: vc.row, sport: vc.sport, variant: vc.preset, scenario: "LIFECYCLE", canary: false, overrides: vc.overrides });
        }
        return out;
      },
    };
  };
}

export const probePlanner: PlanCases = makeProbePlanner();
