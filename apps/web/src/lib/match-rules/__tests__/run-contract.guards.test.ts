// The guards of `run-contract.ts` themselves (fix round 1, I2). The sport contracts only ever hand them input they accept,
// so a guard that stopped guarding would leave every one of them green. Here each guard gets input that only IT refuses,
// so mutating any one alone is caught. Fake modules over real zod schemas, so the refusal codes are the engine's own kind.
//
// single-sport: not a sport test, it exercises the harness; no sport is named.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AnySportModule } from "@seazn/engine/sport";
import type { RuleField } from "../types.ts";
import { assertPinned, judgeBuilds, judgeRanges } from "./run-contract.ts";

const field = (key: string, o: Partial<RuleField> & Pick<RuleField, "kind">): RuleField => ({
  label: key, labelKey: "rules.field.winBy.label", edits: [key], build: (v) => ({ [key]: Number(v) }), ...o, key,
});
const num = (key: string, min: number, max: number, o: Partial<RuleField> = {}): RuleField => field(key, { kind: "number", min, max, ...o });

/** A module over `schema`, with one preset `{a: 5, b: 10}` unless given; every key in `keys` a stage key. */
const mod = (schema: z.ZodType, keys: Record<string, unknown>, variants: Record<string, unknown> = { v: { a: 5, b: 10 } }): AnySportModule =>
  ({ key: "fake", variants, ruleKeys: keys, configSchema: schema }) as unknown as AnySportModule;

const ab = z.object({ a: z.number(), b: z.number() }).refine((c) => c.b >= c.a, { message: "b must be ≥ a" });
const abKeys = { a: { scope: "stage" }, b: { scope: "stage" } };

describe("run-contract guards — judgeBuilds", () => {
  it("a cross-field refusal of a number field is tolerated and returned for pinning; the parsing probe is counted", () => {
    const v = judgeBuilds(mod(ab, abKeys), [num("b", 1, 20)]);
    expect(v.tolerated).toEqual({ "v/b/1": "b must be ≥ a" });
    expect(v.checked, "the max probe parsed").toBeGreaterThan(0);
    expect(v.notOffered).toBe(0);
  });

  it("a refusal that is NOT cross-field (a number past the engine's own range) throws, whatever else parses", () => {
    const capped = z.object({ a: z.number(), b: z.number().max(10) });
    expect(() => judgeBuilds(mod(capped, abKeys), [num("b", 1, 20)])).toThrow(/not a cross-field refusal/);
  });

  it("a cross-field refusal of a SELECT option is tolerated and returned for pinning (P-5: an option another key makes unavailable)", () => {
    const sel = field("b", { kind: "select", options: [{ value: "1", label: "1" }, { value: "20", label: "20" }] });
    const v = judgeBuilds(mod(ab, abKeys), [sel]);
    expect(v.tolerated).toEqual({ "v/b/1": "b must be ≥ a" });
    expect(v.checked, "the other option parsed").toBeGreaterThan(0);
  });

  it("a SELECT option the schema refuses for a reason that is NOT cross-field (a value outside its enum) throws", () => {
    const e = z.object({ a: z.number(), b: z.enum(["x", "y"]) });
    const sel = field("b", { kind: "select", options: [{ value: "x", label: "x" }, { value: "nope", label: "nope" }], build: (v) => ({ b: v }) });
    expect(() => judgeBuilds(mod(e, abKeys, { v: { a: 5, b: "x" } }), [sel])).toThrow(/not a cross-field refusal on a number or select field/);
  });

  it("a cross-field refusal of a BOOL field still throws: only a number range end or a select option can sit under another key", () => {
    const flag = z.object({ a: z.number(), b: z.boolean() }).refine((c) => c.b === false, { message: "b must stay off" });
    const tog = field("b", { kind: "bool", build: (v) => ({ b: v === "on" }) });
    expect(() => judgeBuilds(mod(flag, abKeys, { v: { a: 5, b: false } }), [tog])).toThrow(/not a cross-field refusal on a number or select field/);
  });

  it("a field none of whose probes parses throws, even though every refusal is cross-field", () => {
    expect(() => judgeBuilds(mod(ab, abKeys), [num("b", 1, 2)])).toThrow(/no probe of this field parses/);
  });

  it("a field the engine does not offer in the variant is counted, not judged (and not refused)", () => {
    const keys = { ...abKeys, c: { scope: "stage", appliesTo: { variants: ["other"] } } };
    const wrong = field("c", { kind: "number", min: 1, max: 2, build: () => ({ b: -1 }) });
    const v = judgeBuilds(mod(ab, keys), [num("b", 12, 20), wrong]);
    expect(v.notOffered).toBe(1);
    expect(v.tolerated).toEqual({});
  });

  it("a variant preset that does not parse its own schema is an error, not a skipped base", () => {
    expect(() => judgeBuilds(mod(ab, abKeys, { v: { a: 5 } }), [num("b", 12, 20)])).toThrow(/does not parse its own schema/);
  });
});

describe("run-contract guards — assertPinned", () => {
  it("the same set passes (the empty set too)", () => {
    assertPinned({ "v/b/1": "m" }, { "v/b/1": "m" });
    assertPinned({}, {});
  });
  it("a refusal that is not listed fails", () => {
    expect(() => assertPinned({ "v/b/1": "m" }, {})).toThrow(/not in the crossField list/);
  });
  it("a listed row the engine no longer produces fails", () => {
    expect(() => assertPinned({}, { "v/b/1": "m" })).toThrow(/no longer refuses it/);
  });
  it("a listed row whose message changed fails", () => {
    expect(() => assertPinned({ "v/b/1": "new" }, { "v/b/1": "old" })).toThrow(/the refusal changed/);
  });
});

describe("run-contract guards — judgeRanges", () => {
  const schema = z.object({
    n: z.number().int().min(5).max(10),
    p: z.number().positive(),
    free: z.number().int(),
    nest: z.object({ q: z.number().int().max(8) }).nullable(),
    clock: z.object({ base: z.number().int().max(100) }),
  });
  const keys = Object.fromEntries(["n", "p", "free", "nest.q", "clock"].map((k) => [k, { scope: "stage" }]));
  const range = (fs: RuleField[]) => judgeRanges(mod(schema, keys), fs);

  it("a range inside the engine's bounds passes, ends included (the boundary is inside), and is counted", () => {
    const r = range([num("n", 5, 10)]);
    expect(r.judged).toBe(1);
    expect(r.checked, "both ends compared with both bounds").toBe(4);
    expect(r.noEngineMax).toEqual([]);
  });

  it("a max above the engine's maximum fails, and so does a min below its minimum", () => {
    expect(() => range([num("n", 5, 11)])).toThrow(/above the engine's maximum 10/);
    expect(() => range([num("n", 4, 10)])).toThrow(/below the engine's minimum 5/);
  });

  it("an EXCLUSIVE minimum (positive) refuses its own value", () => {
    expect(() => range([num("p", 0, 5)])).toThrow(/exclusive minimum 0/);
    expect(range([num("p", 1, 5)]).noEngineMax, "positive() has no maximum").toEqual(["p"]);
  });

  it("a field the engine gives no maximum is listed, not failed, and the safe-integer range of .int() is not a bound", () => {
    expect(range([num("free", 1, 99999)]).noEngineMax).toEqual(["free"]);
  });

  it("the value compared is what the BUILD writes (a scaled field), not the number typed", () => {
    const scaled = num("n", 3, 5, { build: (v) => ({ n: Number(v) * 2 }) });
    expect(range([scaled]).checked).toBe(4);
    expect(() => range([num("n", 3, 6, { build: (v) => ({ n: Number(v) * 2 }) })])).toThrow(/builds 12/);
  });

  it("a sub-field whose build writes nothing is compared at its edited key by the number typed", () => {
    const sub = num("n", 5, 11, { build: () => ({}) });
    expect(() => range([sub])).toThrow(/above the engine's maximum 10/);
  });

  it("a nested, nullable path is resolved, and a constant the build writes beside the edited leaf is not compared", () => {
    const nested = num("q", 1, 8, { edits: ["nest.q"], build: (v) => ({ nest: { q: Number(v), count: 999 } }) });
    expect(range([nested]).checked, "both ends against the one declared bound").toBe(2);
    expect(() => range([num("q", 1, 9, { edits: ["nest.q"], build: (v) => ({ nest: { q: Number(v) } }) })])).toThrow(/above the engine's maximum 8/);
  });

  it("a field editing an object key is compared at the numeric leaves the build wrote beneath it", () => {
    const clock = num("clockBase", 1, 100, { edits: ["clock"], build: (v) => ({ clock: { base: Number(v) } }) });
    expect(range([clock]).noEngineMax).toEqual([]);
    expect(() => range([num("clockBase", 1, 101, { edits: ["clock"], build: (v) => ({ clock: { base: Number(v) } }) })])).toThrow(/above the engine's maximum 100/);
  });

  it("a number field with no range is an error, and a non-number field is not judged", () => {
    expect(() => range([field("n", { kind: "number" })])).toThrow(/declares both ends/);
    const r = range([field("n", { kind: "select", options: [{ value: "1", label: "1" }] })]);
    expect(r.judged).toBe(0);
  });
});
