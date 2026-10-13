// The web half of P1 (spec §9 as amended; rule X-SR-1). One call per sport file, so `vitest related
// src/lib/match-rules/<sport>.ts` runs only that sport's contract: this module imports the engine and the field TYPE,
// never the registry (`../index.ts`), which would link every sport's file into every sport's contract.
//
// Expected populations come from the engine's `ruleKeys` and `configSchema`, never from the web file under test.
import { describe, expect, it } from "vitest";
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
}

/** A hand-built field from older code carries no list at all; it edits nothing, and the first test fails it by name. */
const editsOf = (f: RuleField): readonly string[] => (Array.isArray(f.edits) ? f.edits : []);
const topOf = (key: string): string => key.split(".")[0]!;

const probes = (f: RuleField): string[] =>
  f.kind === "select" ? (f.options ?? []).map((o) => o.value)
  : f.kind === "bool" ? ["on", "off"]
  : f.kind === "sequence" ? ["", (f.options ?? []).map((o) => o.value).join(","), [...(f.options ?? [])].reverse().map((o) => o.value).join(",")]
  : [String(f.min ?? 1), ...(f.max === undefined ? [] : [String(f.max)])];

/** Every output a field's builders can produce over its probes: `build` with the form empty and with only its own value
 *  set (a builder that reads its own `values` entry, football's shoot-out pair, writes nothing from an empty form),
 *  and `buildOnBlank` with the form empty and with its own entry blank. */
function outputsOf(f: RuleField): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const v of probes(f)) out.push(f.build(v, {}), f.build(v, { [f.key]: v }));
  if (f.buildOnBlank) out.push(f.buildOnBlank({}), f.buildOnBlank({ [f.key]: "" }));
  return out;
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
        for (const out of outputsOf(f)) for (const k of Object.keys(out)) { expect(tops.has(k), `${f.key} writes ${k}`).toBe(true); seen.add(k); checked++; }
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

    it("X-SR-1 every build() output parses the engine schema over every variant preset the field is offered for", () => {
      let checked = 0;
      let crossField = 0;
      let notOffered = 0;
      // Generic's schema has no default for resultMode/allowDraws, so `{}` is not a config there (a base the bare
      // schema refuses cannot judge a field); every variant preset must always be one.
      const bases: [string | null, Record<string, unknown>][] = [[null, {}], ...Object.entries(m.variants)]
        .filter(([, b]) => m.configSchema.safeParse(b).success) as [string | null, Record<string, unknown>][];
      expect(bases.length, "no base config parses").toBeGreaterThanOrEqual(variantNames.length);
      for (const [variant, preset] of bases) {
        const offeredKeys = new Set([...stageKeysFor(m, null, variant), ...pointsKeysFor(m, null, variant)]);
        for (const f of fields) {
          // A field the engine does not offer in this variant (cricket's super over under the test match, whose two innings the
          // schema refuses it) is not judged there: that is `appliesTo.variants` doing its job, and the stage form never shows it.
          if (!editsOf(f).every((k) => offeredKeys.has(k))) { notOffered++; continue; }
          // A NUMBER field's range ends are probed alone, over a preset that may constrain them from another key (volleyball
          // `cap` at its minimum 15 sits under the preset's 25-point set; cricket `overs` at 1 sits under minOversForResult).
          // That refusal is a refinement across keys, `code: "custom"`; a wrong key, type or range is not, and still fails.
          // The field must still parse at SOME probe, so a field the schema always refuses is not waved through.
          let parsedAtSome = false;
          for (const out of outputsOf(f)) {
            const r = m.configSchema.safeParse({ ...preset, ...out });
            if (r.success) { parsedAtSome = true; checked++; continue; }
            const refinementOnly = f.kind === "number" && r.error.issues.every((i) => i.code === "custom");
            expect(refinementOnly, `${variant}/${f.key}: ${JSON.stringify(r.error.issues)}`).toBe(true);
            crossField++;
          }
          expect(parsedAtSome, `${variant}/${f.key}: no probe of this field parses over this preset`).toBe(true);
        }
      }
      expect(checked).toBeGreaterThan(0);
      expect(crossField, "refinement refusals tolerated on number ranges").toBeLessThan(checked);
      expect(notOffered, "fields skipped for a variant that does not offer them").toBeLessThan(checked);
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
