// Every selector the browser layer clicks is pinned to the product file it must
// appear in, and every label to the en dictionary's value: a product rename
// reds HERE, by name, not as a timeout mid-run. The product is read as TEXT —
// nothing is imported from apps/web (R3) — and expected values come from the
// product's text and the bench's own constants, never from selectors.ts.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FINALIZE_TESTID, SEND_NOW_TESTID, START_MATCH_TESTID, selectorForTapStep, type TapStep } from "../../bench/lib/drivers/scorer.ts";
import { MissingLabel, DATA, NAME, PAD_PINS, TESTID, templateLabel } from "../lib/browser/selectors.ts";
import { TEMPLATE_ROW_KEYS, type TemplateRowKey } from "../lib/catalogue.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const src = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");
const enUi = () => JSON.parse(src("apps/web/src/dictionaries/en/ui.json")) as Record<string, string>;

describe("selectors are pinned to the product's text", () => {
  it("empty case first: every table is non-empty", () => {
    expect(Object.keys(TESTID).length).toBeGreaterThan(0);
    expect(Object.keys(NAME).length).toBeGreaterThan(0);
    expect(Object.keys(DATA).length).toBeGreaterThan(0);
    expect(PAD_PINS.length).toBeGreaterThan(0);
  });

  it("every testid and data needle appears in the file it is pinned to", () => {
    const pins = [...Object.entries(TESTID), ...Object.entries(DATA)];
    const missing = pins.filter(([, p]) => !src(p.file).includes(p.needle)).map(([k, p]) => `${k}: ${p.needle} not in ${p.file}`);
    expect(pins.length).toBe(Object.keys(TESTID).length + Object.keys(DATA).length);
    expect(missing).toEqual([]);
  });

  it("each testid's needle IS its id in the product's markup: a literal data-testid, or a ConfirmDialog prop the dialog composes", () => {
    const wrong: string[] = [];
    let via = 0;
    for (const [k, p] of Object.entries(TESTID)) {
      if ("via" in p && p.via !== undefined) {
        via++;
        // `testId="start-confirm"` at the call site + `${testId}-confirm` in the dialog = start-confirm-confirm.
        const prop = /^testId="([\w-]+)"$/.exec(p.needle)?.[1];
        const suffix = /^`\$\{testId\}(-[\w-]+)`$/.exec(p.via.needle)?.[1];
        if (prop === undefined || suffix === undefined || `${prop}${suffix}` !== p.id) wrong.push(`${k}: ${p.needle} + ${p.via.needle} is not ${p.id}`);
        if (!src(p.via.file).includes(`data-testid={testId ? ${p.via.needle} : undefined}`)) wrong.push(`${k}: ${p.via.file} no longer composes ${p.via.needle}`);
      } else if (p.needle !== `data-testid="${p.id}"`) {
        wrong.push(`${k}: needle ${p.needle} is not data-testid="${p.id}"`);
      }
    }
    expect(via).toBe(2);
    expect(wrong).toEqual([]);
  });

  it("each DATA selector's attributes are the ones its needle pins", () => {
    const wrong = Object.entries(DATA).flatMap(([k, d]) => {
      const attrs = [...d.selector.matchAll(/\[([\w-]+)/g)].map((m) => m[1]);
      const tag = /^([a-z]+)\[/.exec(d.selector)?.[1];
      const out = attrs.length === 0 ? [`${k}: selector ${d.selector} names no attribute`] : attrs.filter((a) => !d.needle.includes(a)).map((a) => `${k}: ${a} not in needle ${d.needle}`);
      if (tag !== undefined && !d.needle.includes(`<${tag} `)) out.push(`${k}: element ${tag} not in needle ${d.needle}`);
      return out;
    });
    expect(Object.keys(DATA).length).toBe(5);
    expect(wrong).toEqual([]);
  });

  it("every PAD_PINS needle is the bench's own value and appears in its product file", () => {
    const bench: Record<string, string> = { START_MATCH_TESTID, FINALIZE_TESTID, SEND_NOW_TESTID };
    let checked = 0;
    for (const p of PAD_PINS) if (p.name in bench) { expect(bench[p.name], p.name).toBe(p.needle); checked++; }
    expect(checked).toBe(3);
    for (const kind of ["tile", "number", "confirm", "choice"] as const) {
      const pin = PAD_PINS.find((p) => p.name === kind)!;
      const step = kind === "tile" ? { kind, tileId: "x" } : kind === "choice" ? { kind, optionId: "x" } : kind === "number" ? { kind, value: 1 } : { kind };
      expect(selectorForTapStep(step as TapStep), kind).toContain(pin.needle);
    }
    const missing = PAD_PINS.filter((p) => !src(p.file).includes(p.needle)).map((p) => `${p.name}: ${p.needle} not in ${p.file}`);
    expect(PAD_PINS.length).toBe(8);
    expect(missing).toEqual([]);
  });

  it("every dictionary-pinned name is the en dictionary's value, and no key is a placeholder", () => {
    const ui = enUi();
    const wrong = Object.entries(NAME).filter(([, n]) => "dictKey" in n && (n.dictKey.startsWith("<") || ui[n.dictKey] !== n.text)).map(([k, n]) => `${k}: ${"dictKey" in n ? n.dictKey : ""} → ${"dictKey" in n ? ui[n.dictKey] : ""}`);
    expect(wrong).toEqual([]);
  });

  it("every dictionary-pinned name's key is the one its component passes (quoted, whole), and every hardcoded name is in its file", () => {
    let dict = 0;
    let literal = 0;
    const wrong = Object.entries(NAME).flatMap(([k, n]) => {
      if ("dictKey" in n) { dict++; return src(n.file).includes(`"${n.dictKey}"`) ? [] : [`${k}: "${n.dictKey}" not in ${n.file}`]; }
      literal++;
      const out = src(n.file).includes(n.needle) ? [] : [`${k}: ${n.needle} not in ${n.file}`];
      if (!n.needle.includes(n.text)) out.push(`${k}: needle ${n.needle} does not carry the text ${n.text}`);
      return out;
    });
    expect(dict + literal).toBe(Object.keys(NAME).length);
    expect(dict).toBeGreaterThan(0);
    expect(literal).toBeGreaterThan(0);
    expect(wrong).toEqual([]);
  });

  it("templateLabel reads the en dictionary for every template row", () => {
    for (const row of TEMPLATE_ROW_KEYS) expect(templateLabel(row)).toBe(JSON.parse(src("apps/web/src/dictionaries/en/ui.json"))[`format.template.${row}.label`]);
    expect(TEMPLATE_ROW_KEYS.length).toBe(16);
    expect(templateLabel("league")).toBe("League");
    // The key shape is the builder's own (division-builder.tsx renders the radio's label from it).
    expect(src("apps/web/src/components/v2/division-builder.tsx")).toContain("msg(`format.template.${t.key}.label` as MessageKey)");
  });

  it("templateLabel refuses a row the dictionary has no label for, by name", () => {
    expect(() => templateLabel("no_such_row" as TemplateRowKey)).toThrow(MissingLabel);
  });
});
