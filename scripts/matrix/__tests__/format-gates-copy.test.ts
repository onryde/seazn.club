// expectedGate is a text-pinned COPY of apps/web/src/server/usecases/format-gates.ts:
// that file imports "server-only", so the harness cannot load it. Expected
// values come from the product's own source text (the two gate bodies and
// createStages' call order), never from the copy under test.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ROW_KEYS, stagesForRow } from "../lib/catalogue.ts";
import { ADVANCED_CONFIG_KEYS, ADVANCED_KINDS, DOUBLE_ELIM_KINDS, expectedGate, expectedGates } from "../lib/format-gates-copy.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const gates = readFileSync(resolve(REPO, "apps/web/src/server/usecases/format-gates.ts"), "utf8");
const stages = readFileSync(resolve(REPO, "apps/web/src/server/usecases/stages.ts"), "utf8");
const bodyOf = (src: string, head: string): string => {
  const at = src.indexOf(head);
  expect(at, `${head} not found`).toBeGreaterThanOrEqual(0);
  const end = src.indexOf("\n}\n", at);
  expect(end, `${head} has no closing brace`).toBeGreaterThan(at);
  return src.slice(at, end);
};
const fnBody = (name: string): string => bodyOf(gates, `export function ${name}(`);
const count = (s: string, needle: string): number => s.split(needle).length - 1;

describe("expectedGate — a text-pinned copy of format-gates.ts (server-only, unimportable)", () => {
  it("the double-elim gate's kinds, the advanced gate's kinds and config keys match the product's text", () => {
    const deBody = fnBody("stageNeedsDoubleElimGate");
    const adv = fnBody("stageNeedsAdvancedFormatsGate");
    const de = [...deBody.matchAll(/kind === "([a-z_]+)"/g)].map((m) => m[1]);
    const advKinds = [...adv.matchAll(/stage\.kind === "([a-z_]+)"/g)].map((m) => m[1]);
    const advKeys = [...adv.matchAll(/stage\.config\?\.([a-z_]+) !== undefined/g)].map((m) => m[1]);
    expect(de.length).toBeGreaterThan(0);
    expect(advKinds.length).toBeGreaterThan(0);
    expect(advKeys.length).toBeGreaterThan(0);
    expect(de).toEqual([...DOUBLE_ELIM_KINDS]);
    expect(advKinds).toEqual([...ADVANCED_KINDS]);
    expect(advKeys).toEqual([...ADVANCED_CONFIG_KEYS]);
  });

  it("the copy is COMPLETE: each gate body is one flat disjunction of exactly the pinned terms (a new term of another shape reds)", () => {
    const deBody = fnBody("stageNeedsDoubleElimGate");
    const adv = fnBody("stageNeedsAdvancedFormatsGate");
    // n terms joined by n-1 `||`, and no `&&` or `!` that would change a term's meaning.
    expect(count(deBody, "||")).toBe(DOUBLE_ELIM_KINDS.length - 1);
    expect(count(adv, "||")).toBe(ADVANCED_KINDS.length + ADVANCED_CONFIG_KEYS.length - 1);
    for (const b of [deBody, adv]) {
      expect(b.includes("&&")).toBe(false);
      expect(/[^=!]![^=]/.test(b.slice(b.indexOf("{")))).toBe(false);
    }
  });

  it("createStages checks the double-elim gate before the advanced gate (so a row hitting both reports double_elim)", () => {
    const body = bodyOf(stages, "export async function createStages(");
    expect(body.indexOf("stageNeedsDoubleElimGate(")).toBeGreaterThan(0);
    expect(body.indexOf("stageNeedsDoubleElimGate(")).toBeLessThan(body.indexOf("stageNeedsAdvancedFormatsGate("));
    // Both gates read EVERY stage of the POST (some), which is what expectedGate models.
    expect(body).toContain("inputs.some((s) => stageNeedsDoubleElimGate(s.kind))");
    expect(body).toContain("inputs.some((s) => stageNeedsAdvancedFormatsGate({ kind: s.kind, config: s.config }))");
  });

  it("empty case first: no stages → no gate; a stage with no config → only its kind decides", () => {
    expect(expectedGate([])).toBeNull();
    expect(expectedGate([{ kind: "league" }])).toBeNull();
    expect(expectedGate([{ kind: "ladder" }])).toBe("formats.advanced");
  });

  it("every pinned term gates on its own, and double_elim wins when both gates are hit", () => {
    let judged = 0;
    for (const k of DOUBLE_ELIM_KINDS) { expect(expectedGate([{ kind: k, config: {} }]), k).toBe("formats.double_elim"); judged++; }
    for (const k of ADVANCED_KINDS) { expect(expectedGate([{ kind: k, config: {} }]), k).toBe("formats.advanced"); judged++; }
    // The config-key branch: no row carries these keys, so only this test reaches it.
    for (const key of ADVANCED_CONFIG_KEYS) {
      expect(expectedGate([{ kind: "league", config: { [key]: [] } }]), key).toBe("formats.advanced");
      expect(expectedGate([{ kind: "league", config: { [key]: undefined } }]), `${key}: undefined is absent`).toBeNull();
      // The product tests `!== undefined`, so a present-but-falsy value still gates.
      for (const falsy of [null, 0, false, ""]) expect(expectedGate([{ kind: "league", config: { [key]: falsy } }]), `${key}: ${String(falsy)}`).toBe("formats.advanced");
      judged++;
    }
    expect(judged).toBe(DOUBLE_ELIM_KINDS.length + ADVANCED_KINDS.length + ADVANCED_CONFIG_KEYS.length);
    expect(expectedGate([{ kind: "league", config: { byes: [] } }, { kind: "double_elim" }])).toBe("formats.double_elim");
  });

  it("final batch FB-7: expectedGates is EVERY gate a POST fires, in createStages' order (double-elim, then advanced); expectedGate is its first", () => {
    // Empty case first: no stage, and an ungated stage, fire nothing.
    expect(expectedGates([])).toEqual([]);
    expect(expectedGates([{ kind: "league" }])).toEqual([]);
    let judged = 0;
    // Each gate alone fires only itself.
    for (const k of DOUBLE_ELIM_KINDS) { expect(expectedGates([{ kind: k }]), k).toEqual(["formats.double_elim"]); judged++; }
    for (const k of ADVANCED_KINDS) { expect(expectedGates([{ kind: k }]), k).toEqual(["formats.advanced"]); judged++; }
    // A POST that trips both gates needs both — whichever stage comes first
    // (task 10 review m-6: a page_playoff stage beside a placements key).
    const both: { kind: string; config?: Record<string, unknown> }[][] = [];
    for (const de of DOUBLE_ELIM_KINDS) {
      for (const adv of ADVANCED_KINDS) both.push([{ kind: de }, { kind: adv }], [{ kind: adv }, { kind: de }]);
      for (const key of ADVANCED_CONFIG_KEYS) both.push([{ kind: de }, { kind: "league", config: { [key]: [] } }], [{ kind: "league", config: { [key]: [] } }, { kind: de }]);
    }
    for (const st of both) {
      expect(expectedGates(st), JSON.stringify(st)).toEqual(["formats.double_elim", "formats.advanced"]);
      expect(expectedGate(st), JSON.stringify(st)).toBe("formats.double_elim");
      judged++;
    }
    expect(judged).toBe(DOUBLE_ELIM_KINDS.length + ADVANCED_KINDS.length + 2 * DOUBLE_ELIM_KINDS.length * (ADVANCED_KINDS.length + ADVANCED_CONFIG_KEYS.length));
    // Over the rows, expectedGate is expectedGates' first (and no row needs both today).
    let rows = 0;
    for (const r of ROW_KEYS) {
      const all = expectedGates(stagesForRow(r));
      expect(expectedGate(stagesForRow(r)), r).toBe(all[0] ?? null);
      expect(all.length, r).toBeLessThanOrEqual(1);
      rows++;
    }
    expect(rows).toBe(ROW_KEYS.length);
  });

  it("over the 21 rows: the seven gated rows (false premise 7), the rest ungated", () => {
    const gated = ROW_KEYS.filter((r) => expectedGate(stagesForRow(r)) !== null);
    expect(gated).toEqual(["group_playoffs", "swiss_playoff", "double_elim", "americano", "mexicano", "ladder", "page_playoff_only"]);
    expect(ROW_KEYS.filter((r) => expectedGate(stagesForRow(r)) === "formats.advanced")).toEqual(["americano", "mexicano", "ladder"]);
  });
});
