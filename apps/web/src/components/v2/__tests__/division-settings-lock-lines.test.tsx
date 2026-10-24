// W2c Task 20 (S4, X-SR-4 UI half) - what the division settings form says about a started stage, as an organiser meets it:
// the lock line under a field BEFORE anyone types, the structure lock that is no longer "any fixture exists", the partial
// save that used to read "saved" over a value that snapped back (a 200 with `refused[]`), and the 409 that names every
// refused field. The server's own halves are division-locked-fields.test.ts (the loader) and division-locks.test.ts (the writer).
//
// Node env, no DOM (AGENTS.md class 2): `MatchRuleFields` is a child component, so its markup is read through
// `renderToStaticMarkup`; the island's own markup and its Save are driven through the hook harness (the standings-points
// suite's idiom: invoke the handler the harness found, with the PATCH stubbed at `apiV1`).
//
// Where each expected value comes from: the fields and the keys they edit are SPORT_RULES, every sentence is read from the
// dictionaries on disk (en, es), the refusals are `RefusedField`'s own shape - none is typed here.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { SPORT_RULES } from "@/lib/match-rules";
import type { RefusedField } from "@/lib/rule-errors";
import { variantWordKey } from "@/lib/variant-label-keys";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

const { activeDict, net } = vi.hoisted(() => ({
  activeDict: { current: {} as Record<string, string> },
  net: {
    calls: [] as { url: string; options?: { method?: string; json?: unknown } }[],
    /** What the next PATCH answers: a body (a 200) or an error to throw. */
    patch: { body: {} as unknown, fail: null as { status: number; code: string; message: string; extra: Record<string, unknown> } | null },
  },
}));

vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  return {
    ...actual,
    useMsg: () => (key: string, vars?: Record<string, string | number>) => {
      const raw = activeDict.current[key];
      if (typeof raw !== "string") return key;
      if (!vars) return raw;
      return raw.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
    },
  };
});

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: vi.fn((url: string, options?: { method?: string; json?: unknown }) => {
      net.calls.push({ url, options });
      if (url.includes("/venues")) return Promise.resolve([]);
      if (options?.method === "PATCH" && net.patch.fail !== null) {
        const f = net.patch.fail;
        return Promise.reject(new actual.ApiV1Error(f.message, f.status, f.code, f.extra));
      }
      return Promise.resolve(net.patch.body);
    }),
  };
});

import { DivisionSettings } from "@/components/v2/division-settings";
import { MatchRuleFields } from "@/components/v2/match-rules";
import type { EffectiveEntrantModel } from "@seazn/engine/sport";

const L = (key: string, vars: Record<string, string | number> = {}, dict: Record<string, string> = enUi as Record<string, string>): string =>
  dict[key]!.replace(/\{(\w+)\}/g, (hole, name: string) => (name in vars ? String(vars[name]) : hole));

const ENTRANT_MODEL: EffectiveEntrantModel = { kinds: ["individual"], defaultKind: "individual", squadNumbers: false, captain: false, maxTeamMembers: null };
const topOf = (path: string): string => path.split(".")[0]!;
const lock = (field: string, over: Partial<RefusedField> = {}): RefusedField => ({
  field,
  code: "DIVISION_FORMAT_LOCKED",
  stageId: "stage-a",
  stageName: "Pool A",
  ...over,
});

const BADMINTON_CONFIG = { bestOf: 3, setTo: 11, finalSetTo: 11, cap: 15, winBy: 2, pointsMap: { "*": [2, 0] } };

function props(over: Record<string, unknown> = {}, sportKey = "badminton", variantKey = "short", config: Record<string, unknown> = BADMINTON_CONFIG) {
  return {
    division: { id: "d1", name: "Open", sport_key: sportKey, variant_key: variantKey, config, logo_url: null, logo_storage_path: null },
    orgId: "org1",
    variants: [{ key: variantKey, name: "Short" }, { key: "other", name: "Other" }],
    structureLocked: false,
    lockedFields: [] as RefusedField[],
    stages: [],
    canEdit: true,
    divisionPathPrefix: "/o/org/c/comp/d/",
    fixturesHref: "/o/org/c/comp/d/div/fixtures",
    embed: null,
    danger: null,
    entrantModel: ENTRANT_MODEL,
    entrantModelSource: "sport",
    autoPosts: false,
    canAutoPost: false,
    showSeeds: true,
    viewerPlan: "community",
    ...over,
  } as unknown as Parameters<typeof DivisionSettings>[0];
}

const mount = (over: Record<string, unknown> = {}, sportKey = "badminton", variantKey = "short", config: Record<string, unknown> = BADMINTON_CONFIG) =>
  renderIsland(DivisionSettings, props(over, sportKey, variantKey, config));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const byTestId = (tree: ReactElement[], id: string): ReactElement | undefined => tree.find((e) => propsOf(e)["data-testid"] === id);
const testIdsStartingWith = (tree: ReactElement[], prefix: string): string[] =>
  tree.map((e) => propsOf(e)["data-testid"]).filter((t): t is string => typeof t === "string" && t.startsWith(prefix));
const ruleFieldsEl = (tree: ReactElement[]): ReactElement => {
  const el = tree.find((e) => e.type === MatchRuleFields);
  if (!el) throw new Error("<MatchRuleFields> not found in tree");
  return el;
};
function clickButton(tree: ReactElement[], text: string): void {
  const btn = tree.find((n) => n.type === "button" && textOf(n).trim() === text);
  if (!btn) throw new Error(`no <button> "${text}" in: ${tree.map((n) => textOf(n)).join(" | ")}`);
  (propsOf(btn).onClick as () => void)();
}
const variantSelect = (tree: ReactElement[]): ReactElement => {
  const sel = tree.find((e) => e.type === "select" && Array.isArray(propsOf(e).children) && (propsOf(e).children as ReactElement[]).some?.((c) => propsOf(c)?.value === "other"));
  if (!sel) throw new Error("variant <select> not found");
  return sel;
};
const markup = (sport: string, lockedFields: readonly RefusedField[], values: Record<string, string> = {}): string =>
  renderToStaticMarkup(<MatchRuleFields sportKey={sport} values={values} onChange={() => {}} lockedFields={lockedFields} />);
const count = (html: string, needle: string): number => html.split(needle).length - 1;
/** Disabled inputs and selects - one per number / picker field (an ordered list's own "add" picker is counted apart). */
const disabledControls = (html: string): number =>
  (html.match(/<(?:input|select)\b(?![^>]*stage-rule-sequence-[^"]*-add)[^>]*\bdisabled=""/g) ?? []).length;
/** An ordered list's controls that are disabled ONLY by the lock: its add picker, and its Remove buttons (the move arrows are
 *  disabled at the ends whatever the lock says, so they cannot speak for it). */
const REMOVE_PREFIX = (enUi as Record<string, string>)["stageRules.sequence.remove"]!.split("{item}")[0]!;
const disabledSequenceControls = (html: string): number =>
  (html.match(/<select\b[^>]*stage-rule-sequence-[^"]*-add[^>]*\bdisabled=""/g) ?? []).length +
  (html.match(new RegExp(`<button\\b[^>]*aria-label="${REMOVE_PREFIX}[^"]*"[^>]*\\bdisabled=""`, "g")) ?? []).length;

beforeEach(() => {
  activeDict.current = enUi as Record<string, string>;
  net.calls.length = 0;
  net.patch.body = {};
  net.patch.fail = null;
});

describe("the match rule fields: a locked field is read-only, with its lock line before anyone types", () => {
  it("no locks: no lock line and no disabled control (the unlocked contrast)", () => {
    for (const sport of Object.keys(SPORT_RULES)) {
      const html = markup(sport, []);
      expect(count(html, 'data-testid="division-locked-'), sport).toBe(0);
      expect(disabledControls(html), `${sport}: nothing read-only`).toBe(0);
      expect(disabledSequenceControls(html), `${sport}: no ordered list read-only`).toBe(0);
    }
  });

  it("a locked key disables every field that edits it and says which stage - every field of every sport (counted)", () => {
    let checked = 0;
    for (const [sport, fields] of Object.entries(SPORT_RULES)) {
      for (const f of fields) {
        const key = topOf(f.edits[0]!);
        // The fields the sport itself declares as editing this config key (a key can have several: boardgame's clock, football's points).
        const expected = fields.filter((g) => g.key === key || g.edits.some((e) => topOf(e) === key));
        const html = markup(sport, [lock(key, { stageName: "Pool Zed" })]);
        expect(count(html, 'data-testid="division-locked-'), `${sport}/${f.key}: one line per field that edits ${key}`).toBe(expected.length);
        for (const g of expected) expect(html, `${sport}/${f.key}: ${g.key} says why`).toContain(`data-testid="division-locked-${g.key}"`);
        expect(html, `${sport}/${f.key}`).toContain(L("ruleLock.DIVISION_FORMAT_LOCKED", { stage: "Pool Zed" }));
        const sequences = expected.filter((g) => g.kind === "sequence").length;
        expect(disabledControls(html), `${sport}/${f.key}: exactly the locked fields' controls are read-only`).toBe(expected.length - sequences);
        if (sequences > 0) expect(disabledSequenceControls(html), `${sport}/${f.key}: a locked ordered list is read-only`).toBeGreaterThan(0);
        else expect(disabledSequenceControls(html), `${sport}/${f.key}: no ordered list is locked`).toBe(0);
        checked++;
      }
    }
    expect(checked, "the sweep reached the sports' fields").toBeGreaterThan(40);
  });

  it("a lock on one field leaves its neighbours editable and unmarked (badminton)", () => {
    const html = markup("badminton", [lock("setTo")]);
    expect(count(html, 'data-testid="division-locked-')).toBe(1);
    expect(html).toContain('data-testid="division-locked-setTo"');
    expect(disabledControls(html)).toBe(1);
  });

  it("the table code says the table sentence, not the format one", () => {
    const html = markup("badminton", [lock("setTo", { code: "DIVISION_TABLE_RULES_LOCKED" })]);
    expect(html).toContain(L("ruleLock.DIVISION_TABLE_RULES_LOCKED", { stage: "Pool A" }));
    expect(html).not.toContain(L("ruleLock.DIVISION_FORMAT_LOCKED", { stage: "Pool A" }));
  });

  it("the field keeps its VALUE visible while locked", () => {
    const html = markup("badminton", [lock("setTo")], { setTo: "21" });
    expect(html).toMatch(/<input[^>]*value="21"[^>]*disabled=""|<input[^>]*disabled=""[^>]*value="21"/);
  });

  it("in Spanish the line is the Spanish dictionary's", () => {
    activeDict.current = esUi as Record<string, string>;
    // MatchRuleFields reads the dictionary through useMsg (mocked above to the active locale).
    const html = markup("badminton", [lock("setTo", { stageName: "Grupo A" })]);
    expect(html).toContain(L("ruleLock.DIVISION_FORMAT_LOCKED", { stage: "Grupo A" }, esUi as Record<string, string>));
    expect(L("ruleLock.DIVISION_FORMAT_LOCKED", {}, esUi as Record<string, string>)).not.toBe(L("ruleLock.DIVISION_FORMAT_LOCKED"));
  });
});

describe("the settings island: what is locked, before the organiser types", () => {
  it("a division with fixtures and NO started stage: the structure is locked (the stage-graph door), the match rules are not", () => {
    const tree = mount({ structureLocked: true, lockedFields: [] }).tree();
    expect(byTestId(tree, "format-locked"), "the structure note").toBeDefined();
    expect(byTestId(tree, "format-template"), "the structure controls are gone").toBeUndefined();
    const rules = propsOf(ruleFieldsEl(tree));
    expect(rules.disabled, "the rule fields are editable").toBe(false);
    expect(rules.lockedFields).toEqual([]);
    expect(propsOf(variantSelect(tree)).disabled, "the variant is editable").toBe(false);
    expect(testIdsStartingWith(tree, "division-locked-"), "no lock line anywhere").toEqual([]);
  });

  it("nothing locked, structure open: the structure controls are there and no note", () => {
    const tree = mount().tree();
    expect(byTestId(tree, "format-template")).toBeDefined();
    expect(byTestId(tree, "format-locked")).toBeUndefined();
  });

  it("the variant is read-only with its line when a started stage plays it, and the summary says so", () => {
    const tree = mount({ lockedFields: [lock("variant_key")] }).tree();
    expect(propsOf(variantSelect(tree)).disabled).toBe(true);
    const line = byTestId(tree, "division-locked-variant_key");
    expect(line).toBeDefined();
    expect(textOf(line)).toContain(L("ruleLock.DIVISION_FORMAT_LOCKED", { stage: "Pool A" }));
    const group = tree.find((e) => propsOf(e).title === L("divset.format"))!;
    // The summary names the variant in words (main's #986 summary), so the lock wraps that word, never the stored key.
    const wordKey = variantWordKey("badminton", "short");
    expect(wordKey, "premise: the variant has a word in the label table").toBeDefined();
    const word = L(wordKey!);
    expect(word, "premise: the word differs from the stored key, so this pins the word").not.toBe("short");
    expect(String(propsOf(group).summary)).toContain(L("divset.variantLocked", { variant: word }));
    // the rule fields carry the lock list the page handed down
    expect(propsOf(ruleFieldsEl(tree)).lockedFields).toEqual([lock("variant_key")]);
  });

  it("an unlocked variant says nothing and is editable (the contrast)", () => {
    const tree = mount({ lockedFields: [lock("setTo")] }).tree();
    expect(propsOf(variantSelect(tree)).disabled).toBe(false);
    expect(byTestId(tree, "division-locked-variant_key")).toBeUndefined();
    const group = tree.find((e) => propsOf(e).title === L("divset.format"))!;
    expect(String(propsOf(group).summary)).not.toContain("locked");
  });

  it("the standings points boxes are read-only with a line when the table is locked (football), and open otherwise", () => {
    const points = { win: 3, draw: 1, loss: 0 };
    const locked = mount({ lockedFields: [lock("points", { code: "DIVISION_TABLE_RULES_LOCKED" })] }, "football", "standard", { points }).tree();
    const boxes = locked.filter((e) => e.type === "input" && propsOf(e).min === 0 && propsOf(e).max === 99);
    expect(boxes.length, "football shows win/draw/loss boxes").toBe(3);
    for (const b of boxes) expect(propsOf(b).disabled).toBe(true);
    expect(textOf(byTestId(locked, "division-locked-points"))).toContain(L("ruleLock.DIVISION_TABLE_RULES_LOCKED", { stage: "Pool A" }));

    const open = mount({}, "football", "standard", { points }).tree();
    for (const b of open.filter((e) => e.type === "input" && propsOf(e).min === 0 && propsOf(e).max === 99)) expect(propsOf(b).disabled).toBe(false);
    expect(byTestId(open, "division-locked-points")).toBeUndefined();
  });

  it("a viewer who cannot edit keeps every control disabled whatever the locks say (the lock does not re-open anything)", () => {
    const tree = mount({ canEdit: false, lockedFields: [] }).tree();
    expect(propsOf(ruleFieldsEl(tree)).disabled).toBe(true);
    expect(propsOf(variantSelect(tree)).disabled).toBe(true);
  });
});

describe("a save that keeps part of what was sent says so (the 200 with refused[])", () => {
  const refusedTwo = [lock("setTo"), lock("cap", { stageName: "Pool B", stageId: "stage-b" })];

  it("names EACH refused field with its stage and the partial-save line, and does not say the rules were saved", async () => {
    net.patch.body = { id: "d1", refused: refusedTwo };
    const island = mount();
    clickButton(island.tree(), L("divset.saveRules"));
    await flush();
    const tree = island.tree();
    const partial = byTestId(tree, "division-partial-save");
    expect(partial, "the partial-save block").toBeDefined();
    expect(textOf(partial)).toContain(L("ruleLock.partialSave", { n: 2 }));
    const labelOf = (key: string) => SPORT_RULES.badminton!.find((f) => f.key === key)!.label;
    for (const r of refusedTwo) {
      const item = byTestId(tree, `division-refused-${r.field}`);
      expect(item, `a line for ${r.field}`).toBeDefined();
      expect(textOf(item)).toContain(labelOf(r.field));
      expect(textOf(item)).toContain(r.stageName);
    }
    expect(tree.map((e) => textOf(e)).join("\n"), "the 'saved' notice is not shown over a value that snapped back").not.toContain(L("divset.notice.rulesSaved"));
    // Each kept field is listed ONCE: the list belongs to the partial block, and the red refusal block is for a refusal.
    expect(testIdsStartingWith(tree, "division-refused-"), "one list, in the order the server gave").toEqual(refusedTwo.map((r) => `division-refused-${r.field}`));
    expect(byTestId(tree, "division-refused-list"), "no red refusal list beside a partial save").toBeUndefined();
  });

  it("the refused fields are locked from then on, with their lines, even though the page did not know (a stage started after it loaded)", async () => {
    net.patch.body = { id: "d1", refused: refusedTwo };
    const island = mount({ lockedFields: [] });
    expect(testIdsStartingWith(island.tree(), "division-locked-"), "premise: nothing locked on load").toEqual([]);
    clickButton(island.tree(), L("divset.saveRules"));
    await flush();
    expect(propsOf(ruleFieldsEl(island.tree())).lockedFields).toEqual(refusedTwo);
  });

  it("a save with nothing refused says 'saved' and shows no partial block - an empty refused[] and a body without one alike", async () => {
    for (const body of [{ id: "d1", refused: [] }, { id: "d1" }]) {
      net.patch.body = body;
      const island = mount();
      clickButton(island.tree(), L("divset.saveRules"));
      await flush();
      const tree = island.tree();
      expect(byTestId(tree, "division-partial-save")).toBeUndefined();
      expect(tree.map((e) => textOf(e)).join("\n")).toContain(L("divset.notice.rulesSaved"));
    }
  });

  it("the sequence: a clean save after a partial one clears the block (nothing stale), and the next partial save is a fresh list", async () => {
    const island = mount();
    net.patch.body = { id: "d1", refused: refusedTwo };
    clickButton(island.tree(), L("divset.saveRules"));
    await flush();
    expect(byTestId(island.tree(), "division-partial-save")).toBeDefined();

    net.patch.body = { id: "d1", refused: [] };
    clickButton(island.tree(), L("divset.saveRules"));
    await flush();
    expect(byTestId(island.tree(), "division-partial-save"), "cleared by the clean save").toBeUndefined();
    expect(byTestId(island.tree(), "division-refused-setTo")).toBeUndefined();

    net.patch.body = { id: "d1", refused: [lock("winBy")] };
    clickButton(island.tree(), L("divset.saveRules"));
    await flush();
    expect(textOf(byTestId(island.tree(), "division-partial-save"))).toContain(L("ruleLock.partialSave", { n: 1 }));
    expect(byTestId(island.tree(), "division-refused-setTo"), "the earlier list is gone").toBeUndefined();
  });

  it("the sequence: after a partial save, a later 409 is a refusal and not a second partly saved - the flag belongs to ONE save", async () => {
    const island = mount();
    net.patch.body = { id: "d1", refused: refusedTwo };
    clickButton(island.tree(), L("divset.saveRules"));
    await flush();
    expect(byTestId(island.tree(), "division-partial-save"), "premise: the first save was partial").toBeDefined();

    net.patch.fail = { status: 409, code: "DIVISION_FORMAT_LOCKED", message: "x", extra: { refused: [lock("winBy")] } };
    clickButton(island.tree(), L("divset.saveRules"));
    await flush();
    const tree = island.tree();
    expect(byTestId(tree, "division-partial-save"), "nothing landed in the second save: it is not 'partly saved'").toBeUndefined();
    expect(testIdsStartingWith(tree, "division-refused-"), "the refusal lists this save's field only").toEqual(["division-refused-list", "division-refused-winBy"]);
  });

  it("the sequence: after a partial save, a later failure that names no field shows its error alone - the earlier list is not carried over", async () => {
    const island = mount();
    net.patch.body = { id: "d1", refused: refusedTwo };
    clickButton(island.tree(), L("divset.saveRules"));
    await flush();
    expect(testIdsStartingWith(island.tree(), "division-refused-"), "premise: the first save listed its fields").not.toEqual([]);

    net.patch.fail = { status: 500, code: "INTERNAL", message: "an unrelated server failure", extra: {} };
    clickButton(island.tree(), L("divset.saveRules"));
    await flush();
    const tree = island.tree();
    expect(tree.map((e) => textOf(e)).join("\n"), "premise: the failure shows its own error").toContain("an unrelated server failure");
    expect(testIdsStartingWith(tree, "division-refused-"), "no field line under an error that names none").toEqual([]);
    expect(byTestId(tree, "division-partial-save")).toBeUndefined();
  });

  it("another sport family: generic's abandon field is named by its label though the refusal names the config key", async () => {
    net.patch.body = { id: "d1", refused: [lock("abandonPolicy")] };
    const island = mount({}, "generic", "score", { resultMode: "score", allowDraws: true });
    clickButton(island.tree(), L("divset.saveRules"));
    await flush();
    const abandon = SPORT_RULES.generic!.find((f) => f.key === "abandon")!;
    expect(textOf(byTestId(island.tree(), "division-refused-abandonPolicy"))).toContain(abandon.label);
  });

  it("in Spanish the partial-save line and the refused line are the Spanish dictionary's", async () => {
    activeDict.current = esUi as Record<string, string>;
    net.patch.body = { id: "d1", refused: [lock("setTo", { stageName: "Grupo A" })] };
    const island = mount();
    clickButton(island.tree(), L("divset.saveRules", {}, esUi as Record<string, string>));
    await flush();
    const tree = island.tree();
    expect(textOf(byTestId(tree, "division-partial-save"))).toContain(L("ruleLock.partialSave", { n: 1 }, esUi as Record<string, string>));
    expect(textOf(byTestId(tree, "division-refused-setTo"))).toContain(L("ruleLock.DIVISION_FORMAT_LOCKED", { stage: "Grupo A" }, esUi as Record<string, string>));
  });
});

describe("what the form learned from a save is dropped once the page knows better", () => {
  it("a fresh page list that CHANGES replaces it (a stage deleted since: the learned lock must not outlive it), and one that only re-arrives does not", async () => {
    net.patch.body = { id: "d1", refused: [lock("setTo")] };
    const island = mount();
    clickButton(island.tree(), L("divset.saveRules"));
    await flush();
    expect(propsOf(ruleFieldsEl(island.tree())).lockedFields, "learned from the save").toEqual([lock("setTo")]);

    // router.refresh() hands the form a NEW array with the same content: the learned lock stands.
    island.rerender(props({ lockedFields: [] }));
    expect(propsOf(ruleFieldsEl(island.tree())).lockedFields, "same content, new identity: nothing dropped").toEqual([lock("setTo")]);

    // The page now says something else is locked (and not setTo): its list stands alone, the learned one is gone.
    island.rerender(props({ lockedFields: [lock("cap")] }));
    expect(propsOf(ruleFieldsEl(island.tree())).lockedFields).toEqual([lock("cap")]);
    expect(byTestId(island.tree(), "division-locked-setTo")).toBeUndefined();
  });

  it("the page's own lock wins over a learned one for the same field (the stage it names stands)", async () => {
    net.patch.body = { id: "d1", refused: [lock("setTo", { stageName: "Pool Learned", stageId: "stage-z" })] };
    const island = mount({ lockedFields: [lock("setTo", { stageName: "Pool Page" })] });
    clickButton(island.tree(), L("divset.saveRules"));
    await flush();
    expect(propsOf(ruleFieldsEl(island.tree())).lockedFields).toEqual([lock("setTo", { stageName: "Pool Page" })]);
  });
});

describe("a save refused outright (the 409) names every refused field too", () => {
  it("the error is the localized refusal, and BOTH refused fields are listed with their stages; nothing is called 'saved' or 'partly saved'", async () => {
    const refused = [lock("setTo"), lock("variant_key", { stageName: "Pool B", stageId: "stage-b" })];
    net.patch.fail = { status: 409, code: "DIVISION_FORMAT_LOCKED", message: "Pool A has started; ENGLISH SERVER TEXT", extra: { refused } };
    const island = mount();
    clickButton(island.tree(), L("divset.saveRules"));
    await flush();
    const tree = island.tree();
    const text = tree.map((e) => textOf(e)).join("\n");
    expect(text, "the localized sentence, not the server's English").toContain(L("rules.err.divisionFormatLocked", { stage: "Pool A" }));
    expect(text).not.toContain("ENGLISH SERVER TEXT");
    for (const r of refused) {
      const item = byTestId(tree, `division-refused-${r.field}`);
      expect(item, `a line for ${r.field}`).toBeDefined();
      expect(textOf(item)).toContain(r.stageName);
    }
    expect(byTestId(tree, "division-partial-save"), "nothing was saved").toBeUndefined();
    // and the form locks them from now on
    expect(propsOf(ruleFieldsEl(tree)).lockedFields).toEqual(refused);
  });

  it("a 409 that carries no refused list (an older server) still shows the error and no field lines", async () => {
    net.patch.fail = { status: 409, code: "DIVISION_FORMAT_LOCKED", message: "x", extra: {} };
    const island = mount();
    clickButton(island.tree(), L("divset.saveRules"));
    await flush();
    expect(testIdsStartingWith(island.tree(), "division-refused-")).toEqual([]);
    expect(byTestId(island.tree(), "division-partial-save")).toBeUndefined();
  });
});

describe("where a save says what it did: inside the Format group, directly under its Save button (I-1)", () => {
  const formatGroup = (tree: ReactElement[]): ReactElement => {
    const g = tree.find((e) => propsOf(e).title === L("divset.format"));
    if (!g) throw new Error("the Format <Group> is not in the tree");
    return g;
  };
  const subtreeOf = (group: ReactElement): ReactElement[] => walk(propsOf(group).children as ReactNode);
  const saveIndex = (sub: ReactElement[]): number => sub.findIndex((n) => n.type === "button" && textOf(n).trim() === L("divset.saveRules"));
  const noteIndex = (sub: ReactElement[]): number => sub.findIndex((n) => n.type === "p" && textOf(n).trim() === L("divset.rulesNote"));

  const scenarios: { name: string; setup: () => void; find: (e: ReactElement) => boolean; role: string }[] = [
    {
      name: "a partial save (200 with refused[])",
      setup: () => { net.patch.body = { id: "d1", refused: [lock("setTo")] }; },
      find: (e) => propsOf(e)["data-testid"] === "division-partial-save",
      role: "status",
    },
    {
      name: "a refusal (409) - its list",
      setup: () => { net.patch.fail = { status: 409, code: "DIVISION_FORMAT_LOCKED", message: "x", extra: { refused: [lock("setTo")] } }; },
      find: (e) => propsOf(e)["data-testid"] === "division-refused-list",
      role: "status",
    },
    {
      name: "a failure that names no field - its error",
      setup: () => { net.patch.fail = { status: 500, code: "INTERNAL", message: "an unrelated server failure", extra: {} }; },
      find: (e) => e.type === "p" && textOf(e).trim() === "an unrelated server failure",
      role: "alert",
    },
    {
      name: "a clean save - its notice",
      setup: () => { net.patch.body = { id: "d1" }; },
      find: (e) => e.type === "p" && textOf(e).trim() === L("divset.notice.rulesSaved"),
      role: "status",
    },
  ];

  it("each of a rules save's four outcomes renders ONCE, between the Save button and the note under it, as a live region", async () => {
    let judged = 0;
    for (const sc of scenarios) {
      net.patch.body = {};
      net.patch.fail = null;
      sc.setup();
      const island = mount();
      clickButton(island.tree(), L("divset.saveRules"));
      await flush();
      const tree = island.tree();
      expect(tree.filter(sc.find), `${sc.name}: rendered once on the whole page`).toHaveLength(1);
      const sub = subtreeOf(formatGroup(tree));
      const save = saveIndex(sub);
      const note = noteIndex(sub);
      const at = sub.findIndex(sc.find);
      expect(save, `${sc.name}: the Save button is in the group`).toBeGreaterThanOrEqual(0);
      expect(note, `${sc.name}: the note is in the group`).toBeGreaterThan(save);
      expect(at, `${sc.name}: inside the group`).toBeGreaterThanOrEqual(0);
      expect(at, `${sc.name}: after Save`).toBeGreaterThan(save);
      expect(at, `${sc.name}: before the note`).toBeLessThan(note);
      expect(propsOf(sub[at]!).role, `${sc.name}: announced`).toBe(sc.role);
      judged++;
    }
    expect(judged, "every outcome was judged").toBe(scenarios.length);
  });

  it("a save from anywhere else keeps its error at the foot of the page, outside the Format group (the rename)", async () => {
    net.patch.fail = { status: 500, code: "INTERNAL", message: "an unrelated server failure", extra: {} };
    const island = mount();
    clickButton(island.tree(), L("divset.saveName"));
    await flush();
    const tree = island.tree();
    const find = (e: ReactElement) => e.type === "p" && textOf(e).trim() === "an unrelated server failure";
    expect(tree.filter(find), "the error is on the page, once").toHaveLength(1);
    expect(subtreeOf(formatGroup(tree)).filter(find), "and not in the Format group").toEqual([]);
  });
});

describe("a refusal keeps the STORED value, and the locked control shows it again (I-2)", () => {
  const typed = (island: ReturnType<typeof mount>, patch: Record<string, string>) => {
    const el = ruleFieldsEl(island.tree());
    (propsOf(el).onChange as (v: Record<string, string>) => void)({ ...(propsOf(el).values as Record<string, string>), ...patch });
    return () => propsOf(ruleFieldsEl(island.tree())).values as Record<string, string>;
  };

  for (const [name, answer] of [
    ["a 409", () => { net.patch.fail = { status: 409, code: "DIVISION_FORMAT_LOCKED", message: "x", extra: { refused: [lock("setTo")] } }; }],
    ["a 200 with refused[]", () => { net.patch.body = { id: "d1", refused: [lock("setTo")] }; }],
  ] as const) {
    it(`after ${name}, the refused field shows what is stored and a field the save did not refuse keeps what was typed`, async () => {
      const island = mount();
      const values = typed(island, { setTo: "13", cap: "20" });
      expect(values().setTo, "premise: the typed value is on screen").toBe("13");
      answer();
      clickButton(island.tree(), L("divset.saveRules"));
      await flush();
      expect(values().setTo, "the refused field is back to the stored value").toBe(String(BADMINTON_CONFIG.setTo));
      expect(values().cap, "an unrefused field keeps what was typed").toBe("20");
      expect(propsOf(ruleFieldsEl(island.tree())).lockedFields, "and it is locked").toEqual([lock("setTo")]);
    });
  }

  it("a field refused through the config key it EDITS goes back to its stored value (generic: the abandon field, refused as abandonPolicy)", async () => {
    const abandon = SPORT_RULES.generic!.find((f) => f.key === "abandon")!;
    const stored = abandon.options!.map((o) => o.value);
    expect(stored.length, "premise: the abandon field offers a choice").toBeGreaterThan(1);
    const island = mount({}, "generic", "score", { resultMode: "score", allowDraws: true, abandonPolicy: "share" });
    const values = typed(island, { abandon: "replay" });
    expect(values().abandon, "premise: the typed choice is on screen").toBe("replay");
    net.patch.fail = { status: 409, code: "DIVISION_FORMAT_LOCKED", message: "x", extra: { refused: [lock("abandonPolicy")] } };
    clickButton(island.tree(), L("divset.saveRules"));
    await flush();
    expect(values().abandon, "back to the stored choice").toBe("share");
  });

  it("a refused VARIANT goes back to the stored variant, and a variant that was not refused stays as chosen", async () => {
    const island = mount();
    (propsOf(variantSelect(island.tree())).onChange as (e: { target: { value: string } }) => void)({ target: { value: "other" } });
    expect(propsOf(variantSelect(island.tree())).value, "premise: the chosen variant is on screen").toBe("other");
    net.patch.fail = { status: 409, code: "DIVISION_FORMAT_LOCKED", message: "x", extra: { refused: [lock("variant_key")] } };
    clickButton(island.tree(), L("divset.saveRules"));
    await flush();
    expect(propsOf(variantSelect(island.tree())).value).toBe("short");

    const other = mount();
    (propsOf(variantSelect(other.tree())).onChange as (e: { target: { value: string } }) => void)({ target: { value: "other" } });
    net.patch.fail = { status: 409, code: "DIVISION_FORMAT_LOCKED", message: "x", extra: { refused: [lock("setTo")] } };
    clickButton(other.tree(), L("divset.saveRules"));
    await flush();
    expect(propsOf(variantSelect(other.tree())).value, "a refusal of another field leaves the variant as chosen").toBe("other");
  });

  it("the standings points boxes go back to the stored points when `points` was refused (football)", async () => {
    const points = { win: 3, draw: 1, loss: 0 };
    const island = mount({}, "football", "standard", { points });
    const boxes = () => island.tree().filter((e) => e.type === "input" && propsOf(e).min === 0 && propsOf(e).max === 99);
    expect(boxes().length, "premise: football shows three boxes").toBe(3);
    (propsOf(boxes()[0]!).onChange as (e: { target: { value: string } }) => void)({ target: { value: "9" } });
    expect(propsOf(boxes()[0]!).value, "premise: the typed value is on screen").toBe("9");
    net.patch.fail = { status: 409, code: "DIVISION_TABLE_RULES_LOCKED", message: "x", extra: { refused: [lock("points", { code: "DIVISION_TABLE_RULES_LOCKED" })] } };
    clickButton(island.tree(), L("divset.saveRules"));
    await flush();
    expect(boxes().map((b) => propsOf(b).value), "the three stored values, in the form's order").toEqual(["3", "1", "0"]);
    // and the list names the boxes as the group the organiser sees, not by the raw `points` key
    expect(textOf(byTestId(island.tree(), "division-refused-points"))).toContain(L("divset.standingsPoints"));
  });

  it("a refusal of another field leaves the typed points as they are (football)", async () => {
    const points = { win: 3, draw: 1, loss: 0 };
    const other = SPORT_RULES.football!.find((f) => f.key !== "points" && !f.edits.map(topOf).includes("points"))!;
    const island = mount({}, "football", "standard", { points });
    const boxes = () => island.tree().filter((e) => e.type === "input" && propsOf(e).min === 0 && propsOf(e).max === 99);
    (propsOf(boxes()[0]!).onChange as (e: { target: { value: string } }) => void)({ target: { value: "9" } });
    net.patch.fail = { status: 409, code: "DIVISION_FORMAT_LOCKED", message: "x", extra: { refused: [lock(topOf(other.edits[0]!))] } };
    clickButton(island.tree(), L("divset.saveRules"));
    await flush();
    expect(testIdsStartingWith(island.tree(), "division-refused-"), "premise: the refusal was heard").not.toEqual([]);
    expect(propsOf(boxes()[0]!).value, "the typed points stand").toBe("9");
  });

  it("a refused field the division never stored (it inherits the variant's default) goes back to BLANK, not to the typed value", async () => {
    const withoutCap: Record<string, unknown> = { ...BADMINTON_CONFIG };
    delete withoutCap.cap;
    const island = mount({}, "badminton", "short", withoutCap);
    const values = typed(island, { cap: "20" });
    expect(values().cap, "premise: the typed value is on screen").toBe("20");
    net.patch.fail = { status: 409, code: "DIVISION_FORMAT_LOCKED", message: "x", extra: { refused: [lock("cap")] } };
    clickButton(island.tree(), L("divset.saveRules"));
    await flush();
    expect(values()).not.toHaveProperty("cap");
  });
});

describe("what a save kept is counted in controls and never named by a raw key (M-4)", () => {
  it("a refused variant with its cascade reads as the controls the organiser sees, and no raw config key reaches the screen", async () => {
    const cascade = [lock("variant_key"), lock("setTo"), lock("cap"), lock("pointsMap"), lock("tiebreakers", { code: "DIVISION_TABLE_RULES_LOCKED" })];
    net.patch.body = { id: "d1", refused: cascade };
    const island = mount();
    clickButton(island.tree(), L("divset.saveRules"));
    await flush();
    const tree = island.tree();
    const partial = byTestId(tree, "division-partial-save");
    // variant, setTo, cap, and ONE line for the two keys with no control
    expect(textOf(partial)).toContain(L("ruleLock.partialSave", { n: 4 }));
    expect(testIdsStartingWith(tree, "division-refused-")).toEqual(["division-refused-variant_key", "division-refused-setTo", "division-refused-cap", "division-refused-other"]);
    expect(textOf(byTestId(tree, "division-refused-other"))).toContain(L("ruleLock.otherSettings"));
    for (const raw of ["pointsMap", "tiebreakers"]) expect(textOf(partial), `${raw} is never shown`).not.toContain(raw);
  });
});

describe("the list the page hands down is walked, not assumed", () => {
  it("every walk of the island's tree reaches the rule fields' lock list (a new prop that nothing reads would be inert)", () => {
    const given = [lock("setTo"), lock("cap")];
    const tree = mount({ lockedFields: given }).tree();
    expect(walk(tree).length).toBeGreaterThan(10);
    expect(propsOf(ruleFieldsEl(tree)).lockedFields).toEqual(given);
  });
});
