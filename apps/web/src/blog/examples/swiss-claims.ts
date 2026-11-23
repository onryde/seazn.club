// Batch 3's shared claim helpers for the Swiss posts' examples. Pure readers of a committed result: they parse what a
// table cell says and never call the code that built it.
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { forEachSport } from "@seazn/engine/testkit";
import { templatesForSport } from "@/lib/format-templates";
import type { Cell, Claim, ExampleResult } from "./types";

/** "1½" -> 1.5, "½" -> 0.5, "2" -> 2: a chess score as the table prints it. NaN for anything else. */
export function scoreOf(cell: Cell): number {
  const s = String(cell).trim();
  const m = /^(\d*)(½?)$/.exec(s);
  if (m === null || s.length === 0) return Number.NaN;
  return (m[1] === "" ? 0 : Number(m[1])) + (m[2] === "½" ? 0.5 : 0);
}

/** The column index of a header, or a thrown error naming it (a claim reports a missing column as a failure). */
export function col(result: ExampleResult, name: string): number {
  const i = result.table?.columns.indexOf(name) ?? -1;
  if (i < 0) throw new Error(`no column '${name}'`);
  return i;
}

/** Runs a check that may throw on a malformed result, and reports the throw as the claim's failure. */
export function guarded(check: (r: ExampleResult) => boolean | string): Claim["check"] {
  return (r) => {
    try {
      return check(r);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
}

/** Every sport in the registry, and whether the builder offers it a format whose stages include `stageKind`. */
export function offeredEverywhere(templateKey: string): { visited: number; missing: string[] } {
  const missing: string[] = [];
  const visited = forEachSport(({ module }) => {
    const kinds = effectiveEntrantModel(module.entrantModel, null).kinds;
    if (!templatesForSport(module.key, kinds).some((t) => t.key === templateKey)) missing.push(module.key);
  });
  return { visited, missing };
}

/** The example-wide claim: the format is offered for every sport in the registry, and the sweep counted them. */
export function offeredInEverySportClaim(templateKey: string, label: string, countFact: string): Claim {
  return {
    says: `the ${label} format is offered for every sport in the registry, and the post's sport count is the registry's`,
    source: "the formats the division builder offers a sport (templatesForSport over the sport's own entrant model), swept with forEachSport",
    check(result) {
      const { visited, missing } = offeredEverywhere(templateKey);
      if (visited === 0) return "the sweep visited no sport";
      if (missing.length > 0) return `not offered for ${missing.join(", ")}`;
      return Number(result.facts[countFact]) === visited || `${countFact} is ${String(result.facts[countFact])}, the registry has ${visited}`;
    },
  };
}
