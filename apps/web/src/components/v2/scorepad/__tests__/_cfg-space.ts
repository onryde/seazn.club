// Shared cfg-space walk for the scorepad coverage suites (extracted in
// S11/#420 from view-model-coverage.test.ts, where it landed in S10/#419).
//
// Extracted rather than copied ON PURPOSE: S11's skin-coverage gate must sweep
// EXACTLY the cfg space S10's view-model coverage sweeps, or the two answer
// "every action" differently and the skin gate silently checks a smaller world
// than the universal renderer was held to. This repo already has that failure
// on record (two parallel vocabulary lookup paths that drifted), so there is
// one walk and both suites import it.
//
// The walk's own recorded trap, from S10: default + named variants ALONE
// silently undercounts (123 of 164 label keys), because several actions and
// panels exist only behind a cfg leaf no shipped variant sets — cricket's
// superOver/dls.enabled, football's non-null shootout, generic's allowDraws,
// badminton's records.timeouts. Hence the leaf-override pass.
import type { AnySportModule } from "@seazn/engine/sport";

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
 *  BOTH, so a flag no shipped variant turns on is still explored. */
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
 * Every DISTINCT parseable cfg in a module's whole cfg space: default + every
 * named variant + every single cfg-leaf override merged onto the PARSED base
 * (never onto the sparse preset — some modules require a whole sub-object
 * restated wholesale). Deduped by parsed-JSON identity.
 */
export function cfgSpace(module: Pick<AnySportModule, "configSchema" | "variants">): unknown[] {
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

// W1 / Task 4 (entitlements v18): `grantAllEntitlements` lived here — every
// entitlement a spec's fidelity map referenced, all granted, so a coverage
// sweep measured what a spec DECLARED rather than what an org had bought.
// `PadSpec.fidelityEntitlements` is gone from the engine and there is nothing
// left to grant: a coverage sweep at band 3 now sees the whole declaration by
// construction.
