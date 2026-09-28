// Config variants (design §5). Per sport, every field the organiser can set
// (SPORT_RULES) is covered PAIR-WISE across (row, preset) with boundary
// classes — the engine's configSchema is unbounded (false premise 2), so the
// bounds are the product's. Each combination is what the product's own
// buildRuleOverride builds over the fields visibleRuleFields shows, validated
// by the engine's configSchema. Deterministic greedy cover: no clock, no
// randomness (R11) — a regeneration is a reviewed diff of variants.json.
import type { StageKind } from "@seazn/engine/core";
import { SPORT_RULES, buildRuleOverride, visibleRuleFields, type RuleField } from "../../../apps/web/src/lib/match-rules.ts";
import { ROW_KEYS, builderDefaultVariant, stagesForRow, type RowKey } from "./catalogue.ts";
import { foldStream } from "./fold.ts";
import { resolveSportCfg, sportModule, variantKeys } from "./sport-cfg.ts";
import { generateStream, matchesRequest } from "./streams/index.ts";

/** scripts/sync-sports.ts:32-36 (not exported there) — the display name every
 *  system variant is stored under, and so what the builder orders by
 *  (`order by is_system desc, name`). Text-pinned by variants.test.ts. */
export function titleCase(key: string): string {
  return key
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const byCodepoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The builder's variant order for a fresh org, derived offline: system
 *  variants by name in CODEPOINT order. The live DB sorts by its collation;
 *  run.ts refuses a run where the two defaults differ (Review Focus 5). */
export function offlineVariantOrder(sport: string): string[] {
  return [...variantKeys(sport)].sort((a, b) => byCodepoint(titleCase(a), titleCase(b)) || byCodepoint(a, b));
}

export function offlineBuilderDefault(sport: string): string {
  return builderDefaultVariant(sport, offlineVariantOrder(sport));
}

export interface Level { readonly cls: string; readonly raw: string }

export class FieldUnbounded extends Error {
  readonly field: string;
  constructor(field: string) {
    super(`variants: field '${field}' declares no finite bound/option set — no boundary classes exist`);
    this.name = "FieldUnbounded";
    this.field = field;
  }
}

/** min, max, one interior value (when the range has one), then blank = the
 *  preset's own default (no override). Bools: on / off / blank. Selects: every
 *  option, then blank. */
export function levelsOf(field: RuleField): Level[] {
  switch (field.kind) {
    case "number": {
      if (field.min === undefined || field.max === undefined) throw new FieldUnbounded(field.key);
      const out: Level[] = [{ cls: "min", raw: String(field.min) }, { cls: "max", raw: String(field.max) }];
      const mid = Math.round((field.min + field.max) / 2);
      if (mid > field.min && mid < field.max) out.push({ cls: "interior", raw: String(mid) });
      out.push({ cls: "blank", raw: "" });
      return out;
    }
    case "bool":
      return [{ cls: "on", raw: "on" }, { cls: "off", raw: "off" }, { cls: "blank", raw: "" }];
    case "select": {
      const opts = field.options ?? [];
      if (opts.length === 0) throw new FieldUnbounded(field.key);
      return [...opts.map((o) => ({ cls: `option:${o.value}`, raw: o.value })), { cls: "blank", raw: "" }];
    }
  }
}

export interface Factor { readonly name: string; readonly levels: readonly Level[] }

export function factorsFor(sport: string): Factor[] {
  return [
    { name: "row", levels: ROW_KEYS.map((r) => ({ cls: r, raw: r })) },
    { name: "preset", levels: offlineVariantOrder(sport).map((v) => ({ cls: v, raw: v })) },
    ...(SPORT_RULES[sport] ?? []).map((f) => ({ name: f.key, levels: levelsOf(f) })),
  ];
}

export type Built = { readonly ok: true; readonly overrides: Record<string, unknown>; readonly cfg: unknown } | { readonly ok: false; readonly reason: string };

/** As the editor would send it: only visible fields may carry a value, and the
 *  override crosses the wire as JSON (an `undefined` delete-marker from a
 *  field's buildOnBlank is dropped, as JSON.stringify drops it). */
export function buildVariant(sport: string, preset: string, values: Record<string, string>): Built {
  const inherited = ((sportModule(sport).variants as Record<string, unknown>)[preset] ?? {}) as Record<string, unknown>;
  const visible = new Set(visibleRuleFields(sport, values, inherited).map((f) => f.key));
  for (const [k, v] of Object.entries(values)) {
    if (v !== "" && !visible.has(k)) return { ok: false, reason: `${k} is not shown with these values (visibleRuleFields)` };
  }
  const overrides = JSON.parse(JSON.stringify(buildRuleOverride(sport, values, inherited))) as Record<string, unknown>;
  try {
    return { ok: true, overrides, cfg: resolveSportCfg(sport, preset, overrides) };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export interface VariantCase {
  readonly id: string;
  readonly sport: string;
  readonly row: RowKey;
  readonly preset: string;
  readonly classes: Readonly<Record<string, string>>;
  readonly values: Readonly<Record<string, string>>;
  readonly overrides: Readonly<Record<string, unknown>>;
  readonly scorable: string | null;
}
export interface Uncoverable { readonly sport: string; readonly a: string; readonly b: string; readonly reason: string }
export interface SportVariants {
  readonly sport: string;
  readonly defaultPreset: string;
  readonly factors: number;
  readonly pairs: number;
  readonly covered: number;
  readonly cases: VariantCase[];
  readonly uncoverable: Uncoverable[];
}

export class VariantGenerationStuck extends Error {
  constructor(sport: string, factor: string, at: string) {
    super(`variants: ${sport}: no valid level for '${factor}' after ${at} — refusing to skip the pair`);
    this.name = "VariantGenerationStuck";
  }
}

export function buildSportVariants(sport: string, deps: { validate?: typeof buildVariant } = {}): SportVariants {
  const validate = deps.validate ?? buildVariant;
  const fs = factorsFor(sport);
  const F = fs.length;
  const defaultPreset = offlineBuilderDefault(sport);
  const presetIx = fs[1].levels.findIndex((l) => l.raw === defaultPreset);
  const lvl = (f: number, l: number): Level => fs[f].levels[l];
  const label = (f: number, l: number): string => `${fs[f].name}=${lvl(f, l).cls}`;
  const valuesOf = (asg: readonly number[]): Record<string, string> => {
    const out: Record<string, string> = {};
    for (let k = 2; k < F; k++) if (asg[k] >= 0 && lvl(k, asg[k]).raw !== "") out[fs[k].name] = lvl(k, asg[k]).raw;
    return out;
  };
  const presetOf = (asg: readonly number[]): string => lvl(1, asg[1] >= 0 ? asg[1] : presetIx).raw;
  const check = (asg: readonly number[]): Built => validate(sport, presetOf(asg), valuesOf(asg));
  const key = (i: number, a: number, j: number, b: number): string => `${i}:${a}|${j}:${b}`;

  const uncovered = new Map<string, readonly [number, number, number, number]>();
  for (let i = 0; i < F; i++) for (let j = i + 1; j < F; j++)
    for (let a = 0; a < fs[i].levels.length; a++) for (let b = 0; b < fs[j].levels.length; b++) uncovered.set(key(i, a, j, b), [i, a, j, b]);
  const pairs = uncovered.size;

  // A pair invalid with every other factor at its default is NOT thereby
  // uncoverable: cricket's overs=1 is refused under t20's 4 overs a bowler but
  // valid under the test preset; badminton's cap=15 is refused under bwf's
  // 21-point sets but valid at best of 1 with 11 points — two levels at once.
  // So such a pair is completed by the FEWEST other factor levels that make it
  // valid (its rescue: 1 level, then any 2, … up to all of them), or listed.
  // The search is exhaustive, so a listed pair has no valid completion at all.
  // Row is never varied: validate takes (sport, preset, values), so the row
  // cannot change its answer.
  const isDefault = (k: number, v: number): boolean => (k === 1 ? v === presetIx : lvl(k, v).raw === "");
  const completeWith = (asg: number[], free: readonly number[], from: number, left: number): number[] | null => {
    if (left === 0) return check(asg).ok ? [...asg] : null;
    for (let x = from; x < free.length; x++) {
      const k = free[x];
      for (let v = 0; v < fs[k].levels.length; v++) {
        if (isDefault(k, v)) continue;
        asg[k] = v;
        const hit = completeWith(asg, free, x + 1, left - 1);
        asg[k] = -1;
        if (hit !== null) return hit;
      }
    }
    return null;
  };
  const uncoverable: Uncoverable[] = [];
  const rescue = new Map<string, readonly number[]>();
  for (const [pk, [i, a, j, b]] of [...uncovered]) {
    const asg = new Array<number>(F).fill(-1);
    asg[i] = a;
    asg[j] = b;
    const r = check(asg);
    if (r.ok) continue;
    const free: number[] = [];
    for (let k = 1; k < F; k++) if (k !== i && k !== j) free.push(k);
    let found: number[] | null = null;
    for (let depth = 1; depth <= free.length && found === null; depth++) found = completeWith(asg, free, 0, depth);
    if (found !== null) {
      rescue.set(pk, found);
      continue;
    }
    uncovered.delete(pk);
    uncoverable.push({ sport, a: label(i, a), b: label(j, b), reason: `${r.reason} — and no combination of the other factors' levels makes the pair valid` });
  }

  const cases: VariantCase[] = [];
  while (uncovered.size > 0) {
    const [pk, [i, a, j, b]] = uncovered.entries().next().value!;
    const asg = [...(rescue.get(pk) ?? new Array<number>(F).fill(-1))];
    asg[i] = a;
    asg[j] = b;
    for (let k = 0; k < F; k++) {
      if (asg[k] >= 0) continue;
      let best = -1;
      let bestGain = -1;
      for (let v = 0; v < fs[k].levels.length; v++) {
        const trial = [...asg];
        trial[k] = v;
        if (!check(trial).ok) continue;
        let gain = 0;
        for (let m = 0; m < F; m++) {
          if (m === k || trial[m] < 0) continue;
          if (uncovered.has(m < k ? key(m, trial[m], k, v) : key(k, v, m, trial[m]))) gain++;
        }
        if (gain > bestGain) { best = v; bestGain = gain; }
      }
      if (best < 0) throw new VariantGenerationStuck(sport, fs[k].name, asg.map((x, f) => (x >= 0 ? label(f, x) : "")).filter(Boolean).join(", "));
      asg[k] = best;
    }
    const built = check(asg);
    if (!built.ok) throw new VariantGenerationStuck(sport, "(complete case)", built.reason);
    for (let x = 0; x < F; x++) for (let y = x + 1; y < F; y++) uncovered.delete(key(x, asg[x], y, asg[y]));
    const classes: Record<string, string> = {};
    for (let k = 2; k < F; k++) classes[fs[k].name] = lvl(k, asg[k]).cls;
    const partial = { id: `${sport}#${String(cases.length + 1).padStart(3, "0")}`, sport, row: lvl(0, asg[0]).raw as RowKey, preset: presetOf(asg), classes, values: valuesOf(asg), overrides: built.overrides };
    cases.push({ ...partial, scorable: scorable({ ...partial, scorable: null }) });
  }
  return { sport, defaultPreset, factors: F, pairs, covered: pairs - uncoverable.length, cases, uncoverable };
}

const errText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** Can the harness score a fixture under this case? Win for each side, on the
 *  row's first stage kind, generated then folded through the real engine.
 *  `deps.generate` exists only so a test can reach the fold-mismatch reason:
 *  no shipped generator is known to produce a stream that folds to the other
 *  side, so the branch is a guard, and a guard owes a test that reaches it. */
export function scorable(vc: VariantCase, deps: { generate?: typeof generateStream } = {}): string | null {
  const generate = deps.generate ?? generateStream;
  let cfg: unknown;
  try { cfg = resolveSportCfg(vc.sport, vc.preset, vc.overrides); } catch (e) { return `cfg: ${errText(e)}`; }
  const stageKind = stagesForRow(vc.row)[0].kind as StageKind;
  for (const winner of ["home", "away"] as const) {
    const req = { sportKey: vc.sport, cfg, stageKind, home: "matrix-home", away: "matrix-away", outcome: { kind: "win", winner } as const };
    try {
      const events = generate(req);
      const out = foldStream(sportModule(vc.sport), cfg, req.home, req.away, events).outcome;
      if (matchesRequest(req, out) !== "match") return `win-${winner}: folded ${JSON.stringify(out)}`;
    } catch (e) {
      return `win-${winner}: ${errText(e)}`;
    }
  }
  return null;
}
