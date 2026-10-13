// The web half of P1 (spec §9 as amended; rule X-SR-1). One call per sport file, so `vitest related
// src/lib/match-rules/<sport>.ts` runs only that sport's contract: this module imports the engine and the field TYPE,
// never the registry (`../index.ts`), which would link every sport's file into every sport's contract.
//
// Expected populations come from the engine's `ruleKeys` and `configSchema`, never from the web file under test.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { StageKind } from "@seazn/engine/core";
import { fixtureKeysFor, pointsKeysFor, stageKeysFor, type AnySportModule } from "@seazn/engine/sport";
import type { RuleField } from "../types.ts";

export interface ContractOptions {
  /**
   * Settable engine keys (scope `stage` or `match`) that NO web field edits yet, each with the reason or the task that
   * closes it. The contract must not go red silently for a key the organiser has no control for, so each is listed, and
   * the list is checked as an EXACT set: a key with no field and no row fails, and a row whose key has a field (or is
   * not settable) fails, so the task that adds the field has to delete the row.
   */
  readonly noWebFieldYet?: Readonly<Record<string, string>>;
  /**
   * Field key -> top-level cfg keys its `build()` ALSO writes, beyond the keys it `edits`: a coherence side effect (carrom
   * `gameTo` lowers `queenCapAt` with it, because the schema refines `queenCapAt <= gameTo`). Each is checked to be a
   * declared key's top segment and to be actually written by that build, so a stale row fails.
   */
  readonly companionWrites?: Readonly<Record<string, readonly string[]>>;
  /**
   * The cross-field refusals a probe of a NUMBER field is allowed to meet when it is built over a variant preset, keyed
   * `<variant>/<field>/<probe>` -> the engine's own refusal message. A range end can sit under a value another key fixes
   * (volleyball `cap` at 15 under the preset's 25-point set); that is a refinement across keys, not a wrong field. The set
   * is checked EXACT, both ways: a refusal that is not listed fails (a new one must be read and added), and a row the
   * engine no longer produces fails (so the list cannot rot).
   */
  readonly crossField?: Readonly<Record<string, string>>;
  /**
   * Number fields whose built value the engine's schema gives NO maximum (a hockey period's minutes are any positive
   * integer). The UI's range for them is the web's own choice, so nothing can check it against the engine; they are
   * listed, as an exact set, so a bound the engine later adds is noticed (the row must go) and a field that LOSES its
   * range cannot slip in unremarked.
   */
  readonly noEngineMax?: readonly string[];
}

/** A hand-built field from older code carries no list at all; it edits nothing, and the first test fails it by name. */
const editsOf = (f: RuleField): readonly string[] => (Array.isArray(f.edits) ? f.edits : []);
const topOf = (key: string): string => key.split(".")[0]!;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const probes = (f: RuleField): string[] =>
  f.kind === "select" ? (f.options ?? []).map((o) => o.value)
  : f.kind === "bool" ? ["on", "off"]
  : f.kind === "sequence" ? ["", (f.options ?? []).map((o) => o.value).join(","), [...(f.options ?? [])].reverse().map((o) => o.value).join(",")]
  : [String(f.min ?? 1), ...(f.max === undefined ? [] : [String(f.max)])];

/** Every output a field's builders can produce over its probes, each with the probe that made it: `build` with the form
 *  empty and with only its own value set (a builder that reads its own `values` entry, football's shoot-out pair, writes
 *  nothing from an empty form), and `buildOnBlank` with the form empty and with its own entry blank. */
function outputsOf(f: RuleField): { probe: string; out: Record<string, unknown> }[] {
  const out: { probe: string; out: Record<string, unknown> }[] = [];
  for (const v of probes(f)) {
    out.push({ probe: v, out: f.build(v, {}) }, { probe: v, out: f.build(v, { [f.key]: v }) });
  }
  if (f.buildOnBlank) out.push({ probe: "blank", out: f.buildOnBlank({}) }, { probe: "blank", out: f.buildOnBlank({ [f.key]: "" }) });
  return out;
}

export interface BuildVerdict {
  /** outputs the engine schema accepted */
  readonly checked: number;
  /** refusals met and tolerated, `<variant>/<field>/<probe>` -> message */
  readonly tolerated: Record<string, string>;
  /** field x variant pairs not judged because the engine does not offer the field in that variant */
  readonly notOffered: number;
}

/**
 * Every build() output of every field, laid over every variant preset that parses, judged by the engine's own schema.
 * THREE guards, each answering a different question, so each can be witnessed (and mutated) alone:
 *  1. only a NUMBER field's CROSS-FIELD (`code: "custom"`) refusal is tolerated; a wrong key, type or range, or any
 *     refusal of a select/bool field, throws;
 *  2. a field must parse at SOME probe, so one the schema always refuses is not waved through by (1);
 *  3. the set of tolerated refusals is returned, for the caller to pin EXACTLY (`assertPinned`).
 * A field the engine does not offer in a variant (cricket's super over under the test match, whose two innings the schema
 * refuses it) is not judged there: that is `appliesTo.variants` doing its job.
 */
export function judgeBuilds(m: AnySportModule, fields: readonly RuleField[]): BuildVerdict {
  const tolerated: Record<string, string> = {};
  let checked = 0;
  let notOffered = 0;
  const variantNames = Object.keys(m.variants);
  // Generic's schema has no default for resultMode/allowDraws, so `{}` is not a config there (a base the bare schema
  // refuses cannot judge a field); every variant preset must always be one.
  const bases: [string | null, Record<string, unknown>][] = ([[null, {}], ...Object.entries(m.variants)] as [string | null, Record<string, unknown>][])
    .filter(([, b]) => m.configSchema.safeParse(b).success);
  if (bases.length < variantNames.length) throw new Error(`${m.key}: a variant preset does not parse its own schema`);
  for (const [variant, preset] of bases) {
    const offeredKeys = new Set([...stageKeysFor(m, null, variant), ...pointsKeysFor(m, null, variant)]);
    for (const f of fields) {
      if (!editsOf(f).every((k) => offeredKeys.has(k))) { notOffered++; continue; }
      let parsedAtSome = false;
      for (const { probe, out } of outputsOf(f)) {
        const r = m.configSchema.safeParse({ ...preset, ...out });
        if (r.success) { parsedAtSome = true; checked++; continue; }
        const at = `${variant ?? "-"}/${f.key}/${probe}`;
        const crossField = f.kind === "number" && r.error.issues.every((i) => i.code === "custom");
        if (!crossField) throw new Error(`${at} is refused and is not a cross-field refusal on a number field: ${JSON.stringify(r.error.issues)}`);
        tolerated[at] = r.error.issues.map((i) => i.message).join(" | ");
      }
      if (!parsedAtSome) throw new Error(`${variant ?? "-"}/${f.key}: no probe of this field parses over this preset`);
    }
  }
  return { checked, tolerated, notOffered };
}

/** The tolerated refusals are EXACTLY the pinned ones, both ways. */
export function assertPinned(actual: Readonly<Record<string, string>>, pinned: Readonly<Record<string, string>>): void {
  for (const [at, message] of Object.entries(actual)) {
    expect(Object.hasOwn(pinned, at), `${at} is refused ("${message}") and is not in the crossField list`).toBe(true);
    expect(message, `${at}: the refusal changed`).toBe(pinned[at]);
  }
  for (const at of Object.keys(pinned)) expect(Object.hasOwn(actual, at), `${at} is listed in crossField but the engine no longer refuses it`).toBe(true);
}

// ---- the UI's range against the engine's declared bounds ------------------------------------------------------------

interface Bound { readonly min?: number; readonly minExclusive?: boolean; readonly max?: number }
/** `.int()` adds the safe-integer range to the JSON schema; that is not a bound anyone declared. */
const declaredBound = (n: number | undefined): number | undefined => (n === undefined || Math.abs(n) >= Number.MAX_SAFE_INTEGER ? undefined : n);

type JsonNode = Record<string, unknown>;
const branches = (s: JsonNode): JsonNode[] => [...((s.anyOf as JsonNode[]) ?? []), ...((s.oneOf as JsonNode[]) ?? []), ...((s.allOf as JsonNode[]) ?? [])];
function child(s: JsonNode, key: string): JsonNode | undefined {
  const props = s.properties as Record<string, JsonNode> | undefined;
  if (props && Object.hasOwn(props, key)) return props[key];
  for (const b of branches(s)) { const c = child(b, key); if (c) return c; }
  return undefined;
}
function numberBound(n: JsonNode): Bound | undefined {
  if (n.type === "number" || n.type === "integer") {
    const exclusiveMin = declaredBound(n.exclusiveMinimum as number | undefined);
    return { min: exclusiveMin ?? declaredBound(n.minimum as number | undefined), minExclusive: exclusiveMin !== undefined, max: declaredBound(n.maximum as number | undefined) };
  }
  for (const b of branches(n)) { const r = numberBound(b); if (r) return r; }
  return undefined;
}
/** The bound the engine's schema declares at a cfg path, or undefined if the path is not a number the schema bounds. */
function boundAt(json: JsonNode, path: readonly string[]): Bound | undefined {
  let node: JsonNode | undefined = json;
  for (const k of path) { node = node && child(node, k); if (!node) return undefined; }
  return numberBound(node);
}
/** The numeric leaves a build wrote, with their cfg paths. */
function numericLeaves(o: unknown, at: string[] = []): { path: string[]; value: number }[] {
  if (typeof o === "number") return [{ path: at, value: o }];
  if (!isObj(o)) return [];
  return Object.entries(o).flatMap(([k, v]) => numericLeaves(v, [...at, k]));
}

export interface RangeVerdict {
  /** number fields judged (every one: a number field with no range is an error, not a skip) */
  readonly judged: number;
  /** (field, end, side) pairs compared with a bound the engine declared */
  readonly checked: number;
  /** number fields with a range whose built value the engine gives no maximum */
  readonly noEngineMax: string[];
}

/**
 * Each NUMBER field's range ends, after the field's own `build`, lie inside the bounds the engine's schema declares for the
 * value that results (read off `z.toJSONSchema`, the schema's own statement). An end outside them is a control that offers
 * a value the engine refuses (or, at the low end, one it rejects as too small). A field whose value the engine gives no
 * maximum cannot be checked at its top end: it comes back in `noEngineMax` for the caller to pin.
 */
export function judgeRanges(m: AnySportModule, fields: readonly RuleField[]): RangeVerdict {
  const json = z.toJSONSchema(m.configSchema as never, { io: "input", unrepresentable: "any" }) as JsonNode;
  let checked = 0;
  let judged = 0;
  const noEngineMax: string[] = [];
  for (const f of fields) {
    if (f.kind !== "number") continue;
    if (f.min === undefined || f.max === undefined) throw new Error(`${m.key}.${f.key}: a number field declares both ends of its range`);
    judged++;
    const edits = editsOf(f);
    let hasMax = false;
    for (const end of [f.min, f.max]) {
      const out = f.build(String(end), {});
      // The leaf a form value becomes: what the build wrote under a key this field edits, else (a sub-field whose parent
      // assembles the object) the number typed, at its first edited key.
      const leaves = numericLeaves(out).filter((l) => edits.some((e) => l.path.join(".") === e || l.path.join(".").startsWith(`${e}.`)));
      const targets = leaves.length > 0 ? leaves : [{ path: edits[0]!.split("."), value: end }];
      for (const t of targets) {
        const b = boundAt(json, t.path);
        if (b === undefined) continue;
        if (b.min !== undefined) {
          expect(b.minExclusive ? t.value > b.min : t.value >= b.min, `${m.key}.${f.key}: range end ${end} builds ${t.value} at ${t.path.join(".")}, below the engine's ${b.minExclusive ? "exclusive " : ""}minimum ${b.min}`).toBe(true);
          checked++;
        }
        if (b.max !== undefined) {
          expect(t.value <= b.max, `${m.key}.${f.key}: range end ${end} builds ${t.value} at ${t.path.join(".")}, above the engine's maximum ${b.max}`).toBe(true);
          if (end === f.max) hasMax = true;
          checked++;
        }
      }
    }
    if (!hasMax) noEngineMax.push(f.key);
  }
  return { judged, checked, noEngineMax };
}

export function runContract(m: AnySportModule, fields: readonly RuleField[], opts: ContractOptions = {}): void {
  const declared = new Set(Object.keys(m.ruleKeys ?? {}));
  const declaredTops = new Set([...declared].map(topOf));
  const noFieldYet = opts.noWebFieldYet ?? {};
  const companions = opts.companionWrites ?? {};
  const variantNames = Object.keys(m.variants);

  describe(`${m.key} — web contract (X-SR-1)`, () => {
    it("X-SR-1 every web field names one or more declared engine keys", () => {
      let checked = 0;
      for (const f of fields) {
        expect(editsOf(f).length, `${f.key} edits no engine key`).toBeGreaterThan(0);
        expect(new Set(editsOf(f)).size, `${f.key} names a key twice`).toBe(editsOf(f).length);
        for (const k of editsOf(f)) { expect(declared.has(k), `${f.key} edits undeclared ${k}`).toBe(true); checked++; }
      }
      expect(checked).toBeGreaterThan(0);
    });

    it("X-SR-1 every settable (stage or match) engine key has a web field or a listed NO_WEB_FIELD_YET row, in every kind × variant", () => {
      const edited = new Set(fields.flatMap(editsOf));
      const unedited = new Set<string>();
      let cells = 0;
      let keysSeen = 0;
      for (const kind of [null, ...StageKind.options])
        for (const variant of [null, ...variantNames]) {
          for (const k of stageKeysFor(m, kind, variant)) { keysSeen++; if (!edited.has(k)) unedited.add(k); }
          cells++;
        }
      expect(cells).toBe((StageKind.options.length + 1) * (variantNames.length + 1));
      expect(keysSeen, "the sweep saw no settable key at all").toBeGreaterThan(0);
      expect([...unedited].sort(), "settable keys with no web field, against the NO_WEB_FIELD_YET rows").toEqual(Object.keys(noFieldYet).sort());
      for (const [k, why] of Object.entries(noFieldYet)) expect(why.length, `${k}: a row needs its reason`).toBeGreaterThan(0);
    });

    it("X-SR-1 every key a build() writes is the top segment of a key the field names, or a listed companion write", () => {
      let checked = 0;
      const written = new Map<string, Set<string>>();
      for (const f of fields) {
        const tops = new Set([...editsOf(f).map(topOf), ...(companions[f.key] ?? [])]);
        const seen = new Set<string>();
        for (const { out } of outputsOf(f)) for (const k of Object.keys(out)) { expect(tops.has(k), `${f.key} writes ${k}`).toBe(true); seen.add(k); checked++; }
        written.set(f.key, seen);
      }
      expect(checked).toBeGreaterThan(0);
      // The companion table is honest: a real field, a declared top key, and a write that really happens.
      for (const [fieldKey, tops] of Object.entries(companions)) {
        expect(written.has(fieldKey), `companion row for unknown field ${fieldKey}`).toBe(true);
        for (const top of tops) {
          expect(declaredTops.has(top), `${fieldKey}: companion ${top} is not a declared key`).toBe(true);
          expect(written.get(fieldKey)!.has(top), `${fieldKey} never writes ${top}: stale companion row`).toBe(true);
        }
      }
    });

    it("X-SR-1 every build() output parses the engine schema over every variant preset the field is offered for, bar the pinned cross-field refusals", () => {
      const verdict = judgeBuilds(m, fields);
      expect(verdict.checked).toBeGreaterThan(0);
      expect(verdict.notOffered, "fields skipped for a variant that does not offer them").toBeLessThan(verdict.checked);
      assertPinned(verdict.tolerated, opts.crossField ?? {});
    });

    it("X-SR-1 every number field's range ends lie inside the bounds the engine's schema declares; fields it gives no maximum are listed", () => {
      const verdict = judgeRanges(m, fields);
      const numbered = fields.filter((f) => f.kind === "number").length;
      expect(verdict.judged, "every number field was judged").toBe(numbered);
      // A sport with number fields compared or listed at least one; one with none (tennis, generic) has nothing to judge.
      expect(verdict.checked + verdict.noEngineMax.length > 0, `${m.key}: ${numbered} number fields and no end was compared or listed`).toBe(numbered > 0);
      expect([...verdict.noEngineMax].sort(), "number fields the engine gives no maximum, against the noEngineMax list").toEqual([...(opts.noEngineMax ?? [])].sort());
    });

    it("X-SR-1 a match-scoped field never edits a stage-only key", () => {
      let checked = 0;
      const match = new Set(fixtureKeysFor(m, null, null));
      for (const f of fields)
        if (editsOf(f).some((k) => match.has(k))) {
          for (const k of editsOf(f)) expect(match.has(k), `${f.key} mixes ${k}`).toBe(true);
          checked++;
        }
      // boardgame and generic declare no match keys; every other sport must have at least one match field (never a vacuous pass)
      expect(checked > 0, `${m.key}: match fields iff match keys`).toBe(match.size > 0);
    });

    it("X-SR-1 a field never mixes table-points keys with stage or match keys", () => {
      const stage = new Set(stageKeysFor(m, null, null));
      const points = new Set(pointsKeysFor(m, null, null));
      let inStage = 0;
      let inPoints = 0;
      for (const f of fields) {
        const e = editsOf(f);
        const allStage = e.every((k) => stage.has(k));
        const allPoints = e.every((k) => points.has(k));
        expect(allStage || allPoints, `${f.key} edits ${e.join(", ")}: a field belongs to the stage/match form or the points form, not both`).toBe(true);
        if (allStage) inStage++; else inPoints++;
      }
      expect(inStage + inPoints, "every field was placed").toBe(fields.length);
      expect(inStage, `${m.key}: no stage or match field at all`).toBeGreaterThan(0);
    });
  });
}
