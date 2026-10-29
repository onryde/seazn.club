// Shared by the W2c Task 11 stage-door tests: a config FRAGMENT a stage can save for a declared key, from the editor's own
// builders (`SPORT_RULES`) where one writes the key, else from the engine's own schema. Every value is one the sport's
// OWN configSchema accepts on top of the variant's preset, so a refusal from the endpoint is the endpoint's, never a
// probe the engine itself would refuse (cricket's 6-ball innings under a 4-over bowler cap) - nor one the engine's
// write-door refusals answer (W2e Task 13: ruling 31's set-target floor turns volleyball's editor minimum of 1 away).
import { SPORT_RULES } from "@/lib/match-rules";
import type { AnySportModule } from "@seazn/engine/sport";
import { stageTopKeysFor, writeConfigIssues } from "@seazn/engine/sport";
import { canonicalJson } from "@/lib/canonical-json";

/** The values a field can be probed with, in the order tried: its smallest and largest number, every option, on and off,
 *  the empty list. */
const probes = (f: { kind: string; options?: { value: string }[]; min?: number; max?: number }): string[] =>
  f.kind === "select" ? f.options!.map((o) => o.value)
  : f.kind === "bool" ? ["on", "off"]
  : f.kind === "sequence" ? [""]
  : [String(f.min ?? 1), ...(f.max === undefined ? [] : [String(f.max)])];

/** The sport's own answer to a config: its schema accepts it, and its write door refuses nothing in it. */
const accepted = (m: AnySportModule, cfg: Record<string, unknown>): boolean =>
  m.configSchema.safeParse(cfg).success && writeConfigIssues(m, cfg).length === 0;

/** The built CONFIG fragment a field writes for the first of its probes that the sport's OWN schema accepts on top of
 *  the variant's preset - the API takes config keys, never form keys, and a probe the engine itself refuses (cricket's
 *  6-ball innings under a 4-over bowler cap) says nothing about the endpoint. `{}` = no field builds this key. */
export function builtFor(m: AnySportModule, variant: string, top: string): Record<string, unknown> {
  const base = m.variants[variant] as Record<string, unknown>;
  for (const f of SPORT_RULES[m.key] ?? []) {
    if (!f.edits.some((k) => k.split(".")[0] === top)) continue;
    for (const p of probes(f)) {
      const frag = f.build(p, {});
      if (Object.keys(frag).length > 0 && accepted(m, { ...base, ...frag })) return frag;
    }
  }
  return {};
}

/** A key no editor field builds (football's `rollingSubs`, cricket's `minOversForResult`...): the value the engine's own
 *  schema gives it on the variant's preset, or - for an optional key with no default - the first of a few plain values
 *  the schema accepts. `{}` = nothing the engine accepts, which the test reports. */
export function engineValueFor(m: AnySportModule, variant: string, top: string): Record<string, unknown> {
  const base = m.variants[variant] as Record<string, unknown>;
  const own = (m.configSchema.parse(base) as Record<string, unknown>)[top];
  if (own !== undefined) return { [top]: own };
  for (const c of [true, 1, 0]) if (m.configSchema.safeParse({ ...base, [top]: c }).success) return { [top]: c };
  return {};
}


/** Every fragment the editor's builders write for `top` that the sport's schema accepts on the variant's preset. */
export function editorFragments(m: AnySportModule, variant: string, top: string): Record<string, unknown>[] {
  const base = m.variants[variant] as Record<string, unknown>;
  const out: Record<string, unknown>[] = [];
  for (const f of SPORT_RULES[m.key] ?? []) {
    if (!f.edits.some((k) => k.split(".")[0] === top)) continue;
    for (const p of probes(f)) {
      const frag = f.build(p, {});
      if (Object.keys(frag).length > 0 && accepted(m, { ...base, ...frag })) out.push(frag);
    }
  }
  return out;
}

/** Every (key, fragment) a `kind` stage can save that CHANGES what the division resolves for that key - the engine's parse
 *  of the preset with and without it - one per key, in the engine's declaration order. A save of the value a division
 *  already has moves nothing, and a sweep over such saves would pass whether or not the endpoint re-wrote anything. */
export function movingFragments(m: AnySportModule, variant: string, kind: Parameters<typeof stageTopKeysFor>[1]): { key: string; frag: Record<string, unknown> }[] {
  const base = m.variants[variant] as Record<string, unknown>;
  const was = m.configSchema.parse(base) as Record<string, unknown>;
  const out: { key: string; frag: Record<string, unknown> }[] = [];
  for (const key of stageTopKeysFor(m, kind, variant)) {
    for (const frag of editorFragments(m, variant, key)) {
      const now = m.configSchema.parse({ ...base, ...frag }) as Record<string, unknown>;
      if (canonicalJson(now[key]) !== canonicalJson(was[key])) {
        out.push({ key, frag });
        break;
      }
    }
  }
  return out;
}

/** The first (key, fragment) a `kind` stage can save that CHANGES what the division resolves for that key, or null when the
 *  sport has none. */
export function movingFragment(m: AnySportModule, variant: string, kind: Parameters<typeof stageTopKeysFor>[1]): { key: string; frag: Record<string, unknown> } | null {
  return movingFragments(m, variant, kind)[0] ?? null;
}
