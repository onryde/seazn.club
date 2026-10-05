// Every selector the browser layer clicks is pinned to the product file it must
// appear in, and every label to the en dictionary's value: a product rename
// reds HERE, by name, not as a timeout mid-run. The product is read as TEXT —
// nothing is imported from apps/web (R3) — and expected values come from the
// product's text and the bench's own constants, never from selectors.ts.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FINALIZE_TESTID, SEND_NOW_TESTID, START_MATCH_TESTID, selectorForTapStep, type TapStep } from "../../bench/lib/drivers/scorer.ts";
import { MissingLabel, DATA, NAME, PAD_PINS, TEMPLATE_CARD, TESTID, UnreadableLiteral, UnrenderableName, literalText, renderedName, templateCardTestid, templateLabel } from "../lib/browser/selectors.ts";
import { UnknownTemplate } from "../lib/templates.ts";
import { TEMPLATE_ROW_KEYS, type TemplateRowKey } from "../lib/catalogue.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const src = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");
const enUi = () => JSON.parse(src("apps/web/src/dictionaries/en/ui.json")) as Record<string, string>;
/** The en dictionary a pin names (ui.json unless it says otherwise), read here — never through selectors.ts. */
const enDict = (dict: "ui" | "public" | undefined) => JSON.parse(src(`apps/web/src/dictionaries/en/${dict ?? "ui"}.json`)) as Record<string, string>;
const dictOf = (n: object): "ui" | "public" | undefined => ("dict" in n && (n.dict === "ui" || n.dict === "public") ? n.dict : undefined);

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
    expect(Object.keys(DATA).length).toBe(13);
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
    let plain = 0;
    let publicDict = 0;
    const wrong = Object.entries(NAME).filter(([, n]) => "dictKey" in n && !("rendered" in n && n.rendered !== undefined)).filter(([, n]) => {
      plain++;
      if (!("dictKey" in n)) return false;
      if (dictOf(n) === "public") publicDict++;
      return n.dictKey.startsWith("<") || enDict(dictOf(n))[n.dictKey] !== n.text;
    }).map(([k, n]) => `${k}: ${"dictKey" in n ? n.dictKey : ""} → ${"dictKey" in n ? enDict(dictOf(n))[n.dictKey] : ""}`);
    expect(plain).toBeGreaterThan(0);
    // Task 5: the champion banner's label is the PUBLIC dictionary's (the ui one has no table.champion).
    expect(publicDict).toBe(1);
    expect(enUi()["table.champion"]).toBeUndefined();
    expect(NAME.championLabel.text).toBe(enDict("public")["table.champion"]);
    expect(wrong).toEqual([]);
  });

  it("a hardcoded name is read out of its needle — a quoted string or one element's text — and anything else is refused by name", () => {
    expect(literalText('"Add entrant"')).toBe("Add entrant");
    expect(literalText('<span className="label">Seed</span>')).toBe("Seed");
    const cannot = ['Add entrant', '"Add entrant', '<span className="label">{msg("x")}</span>', '<span>Seed</div>', '<span className="label"> Seed</span>', '""'];
    for (const n of cannot) expect(() => literalText(n), n).toThrow(UnreadableLiteral);
    expect(cannot.length).toBe(6);
    // Every hardcoded NAME derives its text so (the literal pins below check the file carries the needle).
    let literal = 0;
    for (const n of Object.values(NAME)) if (!("dictKey" in n)) { literal++; expect(n.text).toBe(literalText(n.needle)); }
    expect(literal).toBe(3);
  });

  // M-4: a label the component decorates in a template literal —
  // competition-wizard.tsx renders `${msg("comp.wizard.endsOn")} *` — has an
  // accessible name that is NOT the dictionary value, and an exact-name
  // locator built from the bare value clicks nothing.
  /** The product's template literal around `msg("<key>")` in `file`, read from the product — never from selectors.ts. */
  const productTemplate = (file: string, key: string) => {
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return [...src(file).matchAll(new RegExp("`([^`]*)\\$\\{msg\\(\"" + esc + "\"\\)\\}([^`]*)`", "g"))];
  };
  it("a decorated dictionary name is the product's template filled with the en value, and its template is pinned verbatim", () => {
    const ui = enUi();
    let decorated = 0;
    const wrong = Object.entries(NAME).flatMap(([k, n]) => {
      if (!("dictKey" in n) || !("rendered" in n) || n.rendered === undefined) return [];
      decorated++;
      const found = productTemplate(n.file, n.dictKey);
      if (found.length !== 1) return [`${k}: ${n.file} renders "${n.dictKey}" in ${found.length} template literals, not 1`];
      const [whole, before, after] = found[0]!;
      const out: string[] = [];
      if (n.rendered !== whole) out.push(`${k}: rendered ${n.rendered} is not the product's ${whole}`);
      if (n.text !== `${before}${ui[n.dictKey]}${after}`) out.push(`${k}: text ${JSON.stringify(n.text)} is not ${JSON.stringify(`${before}${ui[n.dictKey]}${after}`)}`);
      return out;
    });
    // W1-driving Task 13: the template sheet's Ends on is the same decorated label (template-gallery.tsx:458).
    expect(decorated).toBe(2);
    expect(wrong).toEqual([]);
    // Witness, read off competition-wizard.tsx:244 and en "comp.wizard.endsOn": "Ends on" today.
    expect(NAME.endsOn.text).toBe("Ends on *");
    expect(NAME.templateEndsOn.text).toBe("Ends on *");
  });

  it("a dictionary name its component decorates must declare it: no plain dictKey pin whose key the file renders inside a template", () => {
    let plain = 0;
    const wrong = Object.entries(NAME).flatMap(([k, n]) => {
      if (!("dictKey" in n) || ("rendered" in n && n.rendered !== undefined)) return [];
      plain++;
      const found = productTemplate(n.file, n.dictKey);
      return found.length === 0 ? [] : [`${k}: ${n.file} renders ${found[0]![0]} — pin it with \`rendered\`, the bare value is not its name`];
    });
    expect(plain).toBeGreaterThan(0);
    expect(wrong).toEqual([]);
  });

  it("renderedName refuses a template it cannot fill, and a key the dictionary lacks, by name", () => {
    expect(renderedName("comp.wizard.endsOn", "`${msg(\"comp.wizard.endsOn\")} *`")).toBe(`${enUi()["comp.wizard.endsOn"]} *`);
    const cannot = [
      "${msg(\"comp.wizard.endsOn\")} *", // not a template literal
      "`Ends on *`", // no call to fill
      "`${msg(\"comp.wizard.endsOn\")} ${msg(\"comp.wizard.endsOn\")}`", // two
      "`${msg(\"comp.wizard.endsOn\")} ${required}`", // another interpolation left
    ];
    for (const t of cannot) expect(() => renderedName("comp.wizard.endsOn", t), t).toThrow(UnrenderableName);
    expect(() => renderedName("no.such.key", "`${msg(\"no.such.key\")} *`")).toThrow(MissingLabel);
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

// W1-driving Task 13: the gallery composes each card's testid from the
// template's key (template-gallery.tsx:242). Pinned as the product's own
// composition — the prefix is read out of the needle, never typed — and every
// catalog key composes a testid the gallery renders.
describe("the template card's composed testid (W1-driving Task 13)", () => {
  const CATALOG = "apps/web/src/server/templates/catalog";
  it("the composition is in the gallery, verbatim, and the prefix is the needle's own", () => {
    expect(TEMPLATE_CARD.file).toBe("apps/web/src/components/v2/template-gallery.tsx");
    expect(src(TEMPLATE_CARD.file)).toContain(TEMPLATE_CARD.needle);
    const prefix = /^data-testid=\{`([\w-]+)\$\{template\.key\}`\}$/.exec(TEMPLATE_CARD.needle)?.[1];
    expect(prefix).toBe("template-card-");
    // Anchored on `="`-free JSX: the gallery passes the key, and the card is a button.
    expect(src(TEMPLATE_CARD.file)).toMatch(/<button\s+type="button"\s+onClick=\{onSelect\}\s+data-testid=\{`template-card-\$\{template\.key\}`\}/);
  });
  it("every catalog template's key composes its card testid; an unknown or unsafe key is refused by name", () => {
    const keys = readdirSync(resolve(REPO, CATALOG)).filter((f) => f.endsWith(".json")).map((f) => (JSON.parse(src(`${CATALOG}/${f}`)) as { key: string }).key);
    expect(keys.length).toBeGreaterThan(0);
    const prefix = /`([\w-]+)\$\{/.exec(TEMPLATE_CARD.needle)![1]!;
    for (const key of keys) expect(templateCardTestid(key), key).toBe(`${prefix}${key}`);
    for (const bad of ["", "no-such-template", "box-league\"]", "../box-league"]) expect(() => templateCardTestid(bad), JSON.stringify(bad)).toThrow(UnknownTemplate);
  });
  it("the console's Void last entry is the button the product renders with score.voidLast (not its title key), named by that dictionary entry (W1d Task 14)", () => {
    expect(NAME.voidLast).toMatchObject({ dictKey: "score.voidLast", file: "apps/web/src/components/v2/fixture-console.tsx" });
    expect(NAME.voidLast.text).toBe(enUi()["score.voidLast"]);
    // The button's visible text is the key; its title is the other one, which names the entry it would void.
    expect(src(NAME.voidLast.file)).toContain('{msg("score.voidLast")}');
    expect(src(NAME.voidLast.file)).toContain('title={msg("score.voidLastTitle"');
    expect(enUi()["score.voidLast"]).not.toBe(enUi()["score.voidLastTitle"]);
  });
  it("the detail sheet's CTA, its form and its two fields are the product's", () => {
    expect(TESTID.templateDetailSubmit).toMatchObject({ id: "template-detail-submit", file: "apps/web/src/components/v2/template-gallery.tsx" });
    expect(DATA.templateDetailForm).toMatchObject({ selector: 'form[id="template-detail-form"]', file: "apps/web/src/components/v2/template-gallery.tsx" });
    // The CTA submits THAT form (the button sits in the modal's footer, outside it).
    expect(src(TESTID.templateDetailSubmit.file)).toContain('form="template-detail-form"');
    expect(NAME.templateName).toMatchObject({ dictKey: "comp.wizard.name.label", file: "apps/web/src/components/v2/template-gallery.tsx" });
    expect(NAME.templateName.text).toBe(enUi()["comp.wizard.name.label"]);
  });
});
