// pack-io.ts — the ONE way a pack reaches a bench runner, and the facts a
// runner derives from one.
//
// `lib/validate-pack.ts` is deliberately PURE: it is handed an already-parsed
// value and does no I/O at all, so it can be the bench's permanent DB-free CI
// presence. This file is the thin layer around it that reads the file — the
// one piece of filesystem stage 0's doctrine allows ("no DB, no HTTP, no env
// vars, no filesystem beyond reading the pack file").
//
// ---------------------------------------------------------------------------
// TWO SEAMS THIS SHAPE EXISTS TO KEEP LIVE
// ---------------------------------------------------------------------------
//
// 1. `expectedSuite` IS DERIVED FROM THE FILENAME, IN ONE PLACE.
//    `validatePack`'s pack/filename consistency check takes the suite key the
//    CALLER expects. That option is required (so a caller cannot omit it), but
//    a caller could still pass a constant, or the pack's own `suite` — and both
//    make the check a tautology that validates green forever. Deriving it here,
//    from the path the bytes actually came from, means no runner ever chooses.
//
// 2. WARNINGS AND ERRORS ARE SEPARATE FIELDS OF A DISCRIMINATED UNION, never
//    one `findings` list a caller has to remember to filter. `_tiny` carries
//    two permanent `*.not_derived` warnings BY DESIGN — stage 0 says what it
//    does not derive rather than staying silent — so a runner gating on "any
//    finding at all" reds forever, and the obvious repair is to delete the
//    honest warning. `pack` exists only on the `ok: true` branch and `errors`
//    only on the `ok: false` one, so `tsc` refuses both mistakes rather than a
//    convention asking a reader not to make them.
//
// Runtime constraints (B02 GLOBAL.md): no TS `enum`, no `namespace`, no
// emit-dependent syntax; `.ts` on every relative import; nothing from apps/web.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { roundRobinFixtureCount, type Pack } from "./pack-schema.ts";
import { validatePack, type PackFinding } from "./validate-pack.ts";

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** The suite key a pack file's NAME claims — `packs/_tiny.json` -> `_tiny`.
 *  `PackSchema`'s own comment on `suite` says a pack's identity "is checked
 *  against its filename by the validator"; this is the filename half. */
export function suiteKeyFromPackPath(file: string): string {
  return path.basename(file, ".json");
}

export interface PackLoadOk {
  readonly ok: true;
  readonly pack: Pack;
  /** Non-fatal, and REPORTABLE: stage 0 names what it did not check. */
  readonly warnings: readonly PackFinding[];
}

export interface PackLoadRefused {
  readonly ok: false;
  readonly errors: readonly PackFinding[];
  readonly warnings: readonly PackFinding[];
}

export type PackLoad = PackLoadOk | PackLoadRefused;

/** The severity split, read off the FIELD. The one place a runner's
 *  errors-vs-warnings distinction is decided. */
export function splitBySeverity(findings: readonly PackFinding[]): {
  errors: readonly PackFinding[];
  warnings: readonly PackFinding[];
} {
  return {
    errors: findings.filter((f) => f.severity === "error"),
    warnings: findings.filter((f) => f.severity === "warning"),
  };
}

/** One finding as a report line: what, where, and what diverged. */
export function formatFinding(finding: PackFinding): string {
  return `${finding.code} @ ${finding.where}: ${finding.message}`;
}

/**
 * Validate already-read bytes AS IF they came from `file`.
 *
 * Split from `loadPackFile` so the whole pack/filename contract is testable
 * without touching a disk — and so a caller that already holds the value (a
 * pack builder checking its own output) runs the same gate.
 */
export function loadPackValue(raw: unknown, file: string): PackLoad {
  const result = validatePack(raw, { expectedSuite: suiteKeyFromPackPath(file) });
  const { errors, warnings } = splitBySeverity(result.findings);
  // Gated on the validator's own structural answer (`ok` is "no error-severity
  // finding"), not on a count recomputed here.
  if (!result.ok || result.pack === null) return { ok: false, errors, warnings };
  return { ok: true, pack: result.pack, warnings };
}

export async function loadPackFile(file: string): Promise<PackLoad> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (err) {
    // Named as a finding rather than thrown: a runner reports a missing or
    // malformed pack the same way it reports a wrong one, and one refusal path
    // is one thing to test.
    return {
      ok: false,
      warnings: [],
      errors: [
        {
          code: "pack.unreadable",
          severity: "error",
          where: file,
          message: `could not read the pack at ${file}: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
  return loadPackValue(raw, file);
}

// ---------------------------------------------------------------------------
// Facts a runner derives from a parsed pack
// ---------------------------------------------------------------------------

/**
 * The product's own leg clamp — `usecases/stages.ts:756`,
 * `Math.min(Math.max(rawLegs, 1), 8)`, whose comment reads "Jul3/08 §2:
 * legs > 2 allowed (triple/quad RR), capped at 8".
 *
 * A HAND MIRROR of a product constant, which `scripts/bench` cannot import
 * (GLOBAL.md: `@/` aliases do not resolve here and most of that tree is
 * `server-only`) — the same trade `validate-pack.ts` documents for
 * `STAGE_DECIDER_KEYS`. Mirrored only to REFUSE, never to predict: past this
 * bound the product mints fewer fixtures than the arithmetic below says, so a
 * pack that declares more gets a refusal naming the clamp instead of a fixture
 * count that is quietly wrong.
 */
const PRODUCT_MAX_LEGS = 8;

/**
 * How many fixtures the product's generator will mint for one LEAGUE stage of
 * this pack — derived from the pack's OWN declaration (the entrants it gives
 * that division, and the stage's own `legs`), never a number typed into a
 * runner.
 *
 * The bound has to move with the pack. `_tiny` declares two entrants and
 * `legs: 3` and therefore three fixtures today; it declared one fixture before
 * the legs arrived, and the assertion that hardcoded `!== 1` went on passing
 * for a shape the pack no longer had.
 *
 * LEAGUE ONLY, on purpose. A knockout's fixture count is a bracket-shape
 * question and a group stage's is per pool, and a pack declares no pool — so
 * this refuses rather than answering a number it cannot derive.
 */
export function expectedFixtureCount(pack: Pack, divisionRef: string, stageRef: string): number {
  const division = pack.divisions.find((d) => d.ref === divisionRef);
  if (division === undefined) {
    throw new Error(`this pack declares no division "${divisionRef}"`);
  }
  const stage = division.stages.find((s) => s.ref === stageRef);
  if (stage === undefined) {
    throw new Error(`division "${divisionRef}" declares no stage "${stageRef}"`);
  }
  if (stage.kind !== "league") {
    throw new Error(
      `stage "${stageRef}" is kind "${stage.kind}" — only a league stage's fixture count is a ` +
        `round robin over the division's entrants. A bracket's is a bracket shape and a group's is ` +
        `per pool, which a pack does not declare`,
    );
  }
  const rawLegs = stage.config["legs"];
  const legs = rawLegs === undefined ? 1 : rawLegs;
  if (typeof legs !== "number" || !Number.isInteger(legs) || legs < 1) {
    throw new Error(
      `stage "${stageRef}" declares legs ${JSON.stringify(rawLegs)} — legs is a positive integer`,
    );
  }
  if (legs > PRODUCT_MAX_LEGS) {
    throw new Error(
      `stage "${stageRef}" declares ${legs} legs, and the product clamps legs to ` +
        `${PRODUCT_MAX_LEGS} (usecases/stages.ts:756) — so the fixture count this pack implies is ` +
        `not the count the generator would mint, and predicting one would be wrong rather than ` +
        `merely unhelpful`,
    );
  }
  const entrants = pack.entrants.filter((e) => e.divisionRef === divisionRef).length;
  return roundRobinFixtureCount(entrants, legs);
}
