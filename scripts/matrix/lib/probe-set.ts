// --set w1b-probe: the smallest live set that drives W1b's new L3 paths
// against the real product —
//  - the single-stage, ungated API-only rows (LIFECYCLE on generic);
//  - one DENIED case per gated row (⛔, ruling 24), each org denied its gate;
//  - one committed variant case per slice sport, its override on the wire.
// Every part is derived: the rows from the catalogue registry, the gates from
// the text-pinned product gate map (format-gates-copy.ts), the variant cases
// from the COMMITTED variants.json (Task 8) by the rule in pickProbeVariant.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { API_ONLY_ROWS, ROW_KEYS, stagesForRow, type RowKey } from "./catalogue.ts";
import { expectedGate, type FormatGate } from "./format-gates-copy.ts";
import type { CaseSpec } from "./scenarios/types.ts";
import { SLICE_ROWS, SLICE_SPORTS } from "./slice.ts";
import { scorable, type VariantCase } from "./variants.ts";
// Type-only: run.ts value-imports this module, and an erased import cannot cycle.
import type { PlannerCli, PlanCases } from "../run.ts";

export const PROBE_SET = "w1b-probe";

/** The API-only rows this set drives: single-stage (a multi-stage row needs
 *  seed-proposal handling, deferred to W1-driving) and ungated (a gated row's
 *  case is its DENIED one). */
export const PROBE_API_ROWS: readonly RowKey[] = Object.freeze(API_ONLY_ROWS.filter((r) => stagesForRow(r).length === 1 && expectedGate(stagesForRow(r)) === null));

/** Every row the product gates, with its gate, in registry order — from the
 *  gate map, never a typed list, so a product change to the gates moves this
 *  set with it. */
const PROBE_DENIED: readonly { row: RowKey; gate: FormatGate }[] = Object.freeze(ROW_KEYS.flatMap((row) => {
  const gate = expectedGate(stagesForRow(row));
  return gate === null ? [] : [{ row, gate }];
}));
export const PROBE_DENIED_ROWS: readonly RowKey[] = Object.freeze(PROBE_DENIED.map((d) => d.row));

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
  /** The committed variant set (default: scripts/matrix/catalogue/variants.json). */
  variants?: () => VariantsFile;
  /** Re-scores a bound case (default: variants.ts scorable). */
  rescore?: (vc: VariantCase) => string | null;
}

const readVariants = (): VariantsFile => JSON.parse(readFileSync(VARIANTS_JSON, "utf8")) as VariantsFile;

/** The planner, with its file read and its re-score injectable. Everything
 *  that needs no DB — the file, the selection, the re-score — happens here, at
 *  construction, so run.ts refuses a bad set before it opens a connection. */
export function makeProbePlanner(deps: ProbeDeps = {}): PlanCases {
  return (cli) => {
    if (cli.only !== undefined || cli.scenario !== undefined || cli.canary !== undefined) throw new SetTakesNoFilter(PROBE_SET, cli);
    const file = (deps.variants ?? readVariants)();
    const bound = SLICE_SPORTS.map((sport) => {
      const cases = file.sports.find((s) => s.sport === sport)?.cases ?? [];
      return requireScorable(pickProbeVariant(sport, cases), deps.rescore);
    });
    return {
      // Generic's order picks the API/DENIED variant; every declared sport's
      // order is compared with the offline default before any case (RF5).
      sports: SLICE_SPORTS,
      deniesFeatures: PROBE_DENIED_ROWS.length > 0,
      plan: (variantFor) => {
        const out: CaseSpec[] = [];
        const g = variantFor(PROBE_SPORT);
        for (const row of PROBE_API_ROWS) out.push({ caseId: `${row}|${PROBE_SPORT}|${g}|LIFECYCLE`, row, sport: PROBE_SPORT, variant: g, scenario: "LIFECYCLE", canary: false });
        for (const { row, gate } of PROBE_DENIED) {
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
