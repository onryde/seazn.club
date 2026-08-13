// Coverage — the headline S10 acceptance criterion: for EVERY builtin module
// x its WHOLE cfg space, at full band, every action padSpec(cfg) declares is
// reachable through the view-model, and the payload buildActionPayload
// builds for it PARSES against that module's own eventSchemas[type] zod
// schema. Walks the cfg space exactly like
// apps/web/src/lib/__tests__/scoring-vocab.test.ts's own `declaredPadLabels`
// (default + every named variant + every single cfg-leaf override merged
// onto the PARSED base) — that walk's own recorded trap: default+variants
// alone silently undercounts (123 of 164 label keys), because several
// actions/panels exist ONLY behind a cfg leaf no shipped variant sets
// (cricket's superOver:true, dls.enabled:true; football's non-null
// shootout; generic's allowDraws:true; badminton's records.timeouts:true).
//
// IMPORTANT: the sweep (`runSweep`) collects PROBLEMS as plain data and
// throws nothing — every `expect()` lives inside an `it()`. A first version
// of this file ran `expect()` straight from the top-level `describe` body
// (collection time); a real regression there threw DURING collection, which
// registered as a 0-assertion file-level failure with every `it` silently
// unregistered — the exact "mutant that breaks collection reads as a
// different shape than a normal red" trap. Verified by mutation (see the
// commit history): a hardcoded allowlist dropped into `resolveActionView`
// now reds two clearly-named `it`s with a real diff, not a collection crash.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { resolvePositions } from "@seazn/engine/sport";
import type { AnySportModule, PadAction, PadField, PadFieldValue, PadSpec } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { defaultLineupPair } from "@seazn/engine/testkit";
import { allActionViews, buildActionPayload } from "../view-model";

type Json = Record<string, unknown>;

function setPath(root: Json, path: string[], value: unknown): Json {
  let cursor = root;
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i] as string;
    cursor[segment] = (cursor[segment] as Json | undefined) ?? {};
    cursor = cursor[segment] as Json;
  }
  cursor[path[path.length - 1] as string] = value;
  return root;
}

function deepMerge(base: Json, over: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const existing = out[k];
    out[k] =
      v && typeof v === "object" && !Array.isArray(v) && existing && typeof existing === "object"
        ? deepMerge(existing as Json, v as Json)
        : v;
  }
  return out;
}

/** Dotted leaf path -> every value worth trying there. Booleans always get
 *  BOTH, so a flag no shipped variant turns on is still explored. Mirrors
 *  scoring-vocab.test.ts's own `cfgLeafValues` verbatim. */
function cfgLeafValues(cfg: unknown, out: Map<string, Set<unknown>>, prefix: string[] = [], depth = 0): void {
  if (depth > 3 || !cfg || typeof cfg !== "object" || Array.isArray(cfg)) return;
  for (const [k, v] of Object.entries(cfg as Json)) {
    const path = [...prefix, k];
    const id = path.join(".");
    if (typeof v === "boolean") {
      if (!out.has(id)) out.set(id, new Set());
      out.get(id)!.add(true);
      out.get(id)!.add(false);
    } else if (typeof v === "string") {
      if (!out.has(id)) out.set(id, new Set());
      out.get(id)!.add(v);
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      cfgLeafValues(v, out, path, depth + 1);
    }
  }
}

/**
 * Every DISTINCT parseable cfg in a module's whole cfg space: default +
 * every named variant + every single cfg-leaf override merged onto the
 * PARSED base (never onto the sparse preset — some modules require a whole
 * sub-object restated wholesale, see
 * reference_padspec_label_cfg_space_walk.md's badminton/records example).
 * Deduped by parsed-JSON identity so a leaf override that coincides with an
 * already-seen cfg (e.g. a boolean already `false` by default) is not
 * re-walked twice for no new coverage.
 */
function cfgSpace(module: Pick<AnySportModule, "configSchema" | "variants">): unknown[] {
  const bases: Json[] = [{}, ...(Object.values(module.variants ?? {}) as Json[])];
  const leaves = new Map<string, Set<unknown>>();
  for (const base of bases) {
    const parsed = module.configSchema.safeParse({ ...base });
    if (parsed.success) cfgLeafValues(parsed.data, leaves);
  }
  const cfgs: unknown[] = [];
  const seen = new Set<string>();
  const record = (raw: unknown) => {
    const parsed = module.configSchema.safeParse(raw);
    if (!parsed.success) return; // not a cfg this module accepts — not padSpec's problem
    const key = JSON.stringify(parsed.data);
    if (seen.has(key)) return;
    seen.add(key);
    cfgs.push(parsed.data);
  };
  for (const base of bases) record({ ...base });
  for (const base of bases) {
    const parsed = module.configSchema.safeParse(base);
    if (!parsed.success) continue;
    for (const [id, values] of leaves) {
      for (const value of values) {
        record(deepMerge(parsed.data as Json, setPath({}, id.split("."), value)));
      }
    }
  }
  return cfgs;
}

function grantAllEntitlements(spec: PadSpec): Record<string, boolean> {
  return Object.fromEntries(Object.values(spec.fidelityEntitlements).map((key) => [key, true]));
}

function fieldArb(field: PadField): fc.Arbitrary<PadFieldValue> {
  switch (field.kind) {
    case "enum":
      return fc.constantFrom(...field.values);
    case "number":
      return fc.integer({ min: field.min, max: field.max });
    case "toggle":
      return fc.boolean();
  }
}

/** Real lineups (never fake ids) so an attribution field's value is exactly
 *  the shape a real payload would carry — matching the technique the
 *  engine's OWN conformance property test uses (testkit/conformance-pad.ts
 *  `padSpecConformanceSuite`), not a parallel one. */
function attrArb(
  item: PadAction["attribution"][number],
  entrantIds: readonly [string, string],
  personPool: readonly string[],
): fc.Arbitrary<PadFieldValue> {
  const pool = item.kind === "side" ? entrantIds : personPool.length > 0 ? personPool : ["p1"];
  return fc.constantFrom(...pool);
}

/** Returns a problem STRING when `buildActionPayload` (THIS file's own
 *  wiring) builds something the module's real `eventSchemas[type]` rejects
 *  — never throws, so a real regression here reports through a normal `it`
 *  failure rather than crashing collection. A modest run count is
 *  deliberate: this checks for DRIFT between the view-model's payload
 *  assembly and the engine's own `buildPathObject`-based reference
 *  construction, not a fresh independent proof of the schema's own shape —
 *  that 200-run property test already lives in
 *  testkit/conformance-pad.ts's `checkActionPayloadsAccepted`. */
function payloadProblem(
  action: PadAction,
  schema: { safeParse(v: unknown): { success: boolean; error?: { issues: { message: string }[] } } },
  entrantIds: readonly [string, string],
  personPool: readonly string[],
): string | null {
  const fieldsArb = fc.record(Object.fromEntries(action.fields.map((f) => [f.path, fieldArb(f)])));
  const attrArbs = action.attribution.map((item) => attrArb(item, entrantIds, personPool));
  const arb = attrArbs.length > 0 ? fc.tuple(fieldsArb, fc.tuple(...attrArbs)) : fieldsArb.map((f) => [f, []] as const);
  try {
    fc.assert(
      fc.property(arb, ([fieldValues, attrValues]) => {
        const values: Record<string, PadFieldValue | undefined> = { ...fieldValues };
        action.attribution.forEach((item, i) => {
          values[item.path] = (attrValues as PadFieldValue[])[i];
        });
        const payload = buildActionPayload(action, values);
        const result = schema.safeParse(payload);
        if (!result.success) {
          throw new Error(
            `built a payload eventSchemas rejects: ${JSON.stringify(payload)} — ` +
              `${result.error?.issues.map((i) => i.message).join("; ")}`,
          );
        }
      }),
      { numRuns: 15 },
    );
    return null;
  } catch (err) {
    return `action "${action.type}" (${action.labelKey.key}): ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// The sweep itself — collected ONCE (top of the describe block), returning
// plain data + problem lists. No `expect()` in here: every assertion lives
// in an `it()` below, so a real regression fails ONE named test instead of
// crashing collection for the whole file (see the module header).
// ---------------------------------------------------------------------------

interface SweepResult {
  /** module.key -> number of DISTINCT parseable cfgs walked. */
  cfgCounts: Map<string, number>;
  /** Every reachable action's labelKey.key, across every module x cfg. */
  reachableKeys: Set<string>;
  /** Total (module, cfg, action) triples proven reachable — NOT deduped;
   *  the raw count behind the floor assertion. */
  totalReachable: number;
  /** Unique (module.key, JSON(action)) action shapes actually schema-parse-
   *  checked (deduped — see `cfgSpace`'s own header for why). */
  uniqueActionsChecked: number;
  /** Human-readable violations of "every declared action is reachable at
   *  full band, unlocked, in the same order `padSpec` declared it". Empty
   *  when the sweep is clean. */
  reachabilityProblems: string[];
  /** Human-readable violations of "the built payload parses". Empty when
   *  the sweep is clean. */
  payloadProblems: string[];
}

function runSweep(): SweepResult {
  const cfgCounts = new Map<string, number>();
  const reachableKeys = new Set<string>();
  let totalReachable = 0;
  const reachabilityProblems: string[] = [];
  const payloadProblems: string[] = [];
  const uniqueActions = new Map<
    string,
    { module: AnySportModule; action: PadAction; entrantIds: readonly [string, string]; personPool: readonly string[] }
  >();

  for (const sportModule of builtinModules) {
    if (!sportModule.padSpec || !sportModule.eventSchemas) continue; // not S6-wired — nothing to sweep
    const cfgs = cfgSpace(sportModule);
    cfgCounts.set(sportModule.key, cfgs.length);

    for (const cfg of cfgs) {
      const spec = sportModule.padSpec(cfg);
      const rawActions = spec.panels.flatMap((panel) => panel.actions);
      const entitlements = grantAllEntitlements(spec);
      const views = allActionViews(spec, { band: 3, entitlements });

      // Reachability: at band 3 (max), EVERY declared action must come back
      // — same length, same order (allActionViews walks panels/actions in
      // spec.panels's own order), so a dropped action is caught positionally
      // AND by count, not merely by set membership (which a duplicate could
      // mask).
      if (views.length !== rawActions.length) {
        reachabilityProblems.push(
          `${sportModule.key}: action count mismatch at full band for cfg ${JSON.stringify(cfg)} — ` +
            `expected ${rawActions.length}, got ${views.length}`,
        );
      }
      rawActions.forEach((raw, i) => {
        const view = views[i];
        if (!view || view.type !== raw.type || view.labelKey.key !== raw.labelKey.key) {
          reachabilityProblems.push(
            `${sportModule.key} action #${i} (${raw.labelKey.key}, type "${raw.type}") is unreachable at full band ` +
              `for cfg ${JSON.stringify(cfg)}`,
          );
          return;
        }
        if (view.availability.kind !== "available") {
          reachabilityProblems.push(
            `${sportModule.key}: "${raw.labelKey.key}" is not "available" (got "${view.availability.kind}") ` +
              `even with every fidelityEntitlements key granted`,
          );
        }
        reachableKeys.add(raw.labelKey.key);
        totalReachable += 1;
      });

      const catalog = resolvePositions(sportModule, cfg);
      const lineups = defaultLineupPair(catalog);
      const entrantIds: readonly [string, string] = [lineups.home.entrantId, lineups.away.entrantId];
      const personPool = [...lineups.home.slots, ...lineups.away.slots].map((slot) => slot.personId);
      for (const action of rawActions) {
        const dedupeKey = `${sportModule.key}::${JSON.stringify(action)}`;
        if (!uniqueActions.has(dedupeKey)) {
          uniqueActions.set(dedupeKey, { module: sportModule, action, entrantIds, personPool });
        }
      }
    }
  }

  for (const { module: sportModule, action, entrantIds, personPool } of uniqueActions.values()) {
    const schema = sportModule.eventSchemas![action.type];
    if (!schema) {
      payloadProblems.push(`${sportModule.key}: no eventSchemas["${action.type}"] for action ${action.labelKey.key}`);
      continue;
    }
    const problem = payloadProblem(action, schema, entrantIds, personPool);
    if (problem) payloadProblems.push(`${sportModule.key}: ${problem}`);
  }

  return {
    cfgCounts,
    reachableKeys,
    totalReachable,
    uniqueActionsChecked: uniqueActions.size,
    reachabilityProblems,
    payloadProblems,
  };
}

describe("view-model coverage — every builtin module x its whole cfg space, at full band", () => {
  const result = runSweep();

  it("walked every one of the 11 builtin modules (none silently skipped)", () => {
    expect(result.cfgCounts.size).toBe(11);
  });

  it("every declared action is reachable, unlocked, at full band with every entitlement granted", () => {
    expect(result.reachabilityProblems).toEqual([]);
  });

  it("every reachable action's built payload parses against its own module's eventSchemas", () => {
    expect(result.payloadProblems).toEqual([]);
    // Floor (measured this session: 167 unique action shapes fast-check
    // verified) so a silent "0 unique actions checked" — e.g. every
    // module's eventSchemas came back undefined — cannot pass as a vacuous
    // green alongside an empty problems array.
    expect(result.uniqueActionsChecked).toBeGreaterThanOrEqual(120);
  });

  it("the cfg-space walk reaches actions only an off-default cfg can produce (vacuity guard)", () => {
    // Pinned by NAME, mirroring scoring-vocab.test.ts's own vacuity guard: if
    // the walk regresses to default+named-variants only, every one of these
    // disappears without the walk itself ever going red.
    for (const key of [
      "pad.cricket.action.superOverBall", // needs superOver: true
      "pad.cricket.action.revise", // needs dls.enabled: true
      "pad.football.action.shootoutKick", // needs a non-null shootout cfg
      "pad.generic.action.draw", // needs allowDraws: true
      "pad.badminton.action.timeout", // needs records.timeouts: true
    ]) {
      expect([...result.reachableKeys], `cfg-space walk never reached "${key}"`).toContain(key);
    }
  });

  it("reaches a floor number of distinct reachable actions across the whole cfg space", () => {
    // Measured this session (11 modules, 133 total (module,cfg) pairs): 85
    // distinct action labelKeys, 921 (module,cfg,action) triples. Floors
    // pinned below the measured values (never AT them) so routine,
    // legitimate spec growth doesn't red this test — only a real coverage
    // regression does.
    expect(result.reachableKeys.size).toBeGreaterThanOrEqual(75);
    expect(result.totalReachable).toBeGreaterThanOrEqual(700);
  });
});
