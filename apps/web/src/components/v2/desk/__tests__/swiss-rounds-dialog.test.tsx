// W3 Task 12 Phase 2 (X-SW-17; owner pick B) — the rounds dialog driven the way a browser would (`renderIsland`: press
// the stepper, read the preview, press Save), plus the rail's chip and the More menu's "Add a round" rendered for real.
// Every expected sentence is that locale dictionary's own copy filled with numbers typed from the rulebook (§3.1: hard
// max n − 1 even / n odd, safe max ⌊n/2⌋; a round of n holds ⌊n/2⌋ matches), never read off the code under test. Run
// in English and in French: a non-English locale is the only way a raw English sentence and the localised one differ.
// Single-sport by nature: the dialog reads a field size and rows; no sport reaches it (the chess switch's sport gate is
// pinned in stages-panel-swiss-rounds-edit.test.tsx).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import enUi from "@/dictionaries/en/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import type { SwissRoundControl, SwissRoundsEditFixture } from "@/lib/swiss-rounds-edit";
import {
  SwissAddRoundMenuItem,
  SwissRoundsChip,
  SwissRoundsDialog,
  type SwissRoundsDialogProps,
  type SwissRoundsRail,
  type SwissRoundsRefusal,
} from "../swiss-rounds-dialog";

type Loc = "en" | "fr";
const DICTS: Record<Loc, Record<string, string>> = {
  en: enUi as unknown as Record<string, string>,
  fr: frUi as unknown as Record<string, string>,
};
const active = vi.hoisted(() => ({ locale: "en" as "en" | "fr" }));
const MSG = {
  en: (key: string, vars?: Record<string, string | number>) => tRuntime(DICTS.en as unknown as Dict, key, vars),
  fr: (key: string, vars?: Record<string, string | number>) => tRuntime(DICTS.fr as unknown as Dict, key, vars),
};
const PLURAL = {
  en: (key: string, count: number, vars?: Record<string, string | number>) => pluralRuntime(DICTS.en as unknown as Dict, key, count, "en", vars),
  fr: (key: string, count: number, vars?: Record<string, string | number>) => pluralRuntime(DICTS.fr as unknown as Dict, key, count, "fr", vars),
};
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMsg: () => MSG[active.locale],
  useMsgPlural: () => PLURAL[active.locale],
}));
const LOCALES: Loc[] = ["en", "fr"];
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k]));
const HARD_MAX = (n: number) => (n % 2 === 0 ? n - 1 : n);

/** `rounds` rounds of unseated shells for a field of `n`, as the mint writes them. */
function shells(n: number, rounds: number): SwissRoundsEditFixture[] {
  const out: SwissRoundsEditFixture[] = [];
  for (let r = 1; r <= rounds; r++) {
    for (let b = 1; b <= Math.floor(n / 2); b++) {
      out.push({ round_no: r, ext_key: `sw-r${r}-b${b}`, home_entrant_id: null, away_entrant_id: null, outcome: null });
    }
    if (n % 2 === 1) out.push({ round_no: r, ext_key: `sw-r${r}-bye`, home_entrant_id: null, away_entrant_id: null, outcome: null });
  }
  return out;
}
const seatRound = (rows: SwissRoundsEditFixture[], r: number) =>
  rows.map((f) => (f.round_no === r ? { ...f, home_entrant_id: `h-${f.ext_key}`, away_entrant_id: `a-${f.ext_key}` } : f));

function control(over: Partial<SwissRoundControl> & { field: number | null }): SwissRoundControl {
  const field = over.field;
  return {
    started: false,
    rounds: 5,
    chess: false,
    addRound: { canAddRound: true, refusal: null, field, hardMax: field === null ? null : HARD_MAX(field) },
    ...over,
  };
}

function open(over: Partial<SwissRoundsDialogProps> & { control: SwissRoundControl }) {
  const calls = { save: [] as number[], addRound: 0, closed: 0 };
  const props: SwissRoundsDialogProps = {
    stageId: "s1",
    fixtures: [],
    onSave: async (_id, rounds) => {
      calls.save.push(rounds);
      return null;
    },
    onAddRound: async () => {
      calls.addRound++;
      return null;
    },
    onClose: () => {
      calls.closed++;
    },
    ...over,
  };
  const island = renderIsland(SwissRoundsDialog, props);
  const find = (testid: string): ReactElement | undefined => island.tree().find((e) => propsOf(e)["data-testid"] === testid);
  const get = (testid: string): ReactElement => {
    const el = find(testid);
    if (!el) throw new Error(`no ${testid} in the dialog`);
    return el;
  };
  const press = (testid: string) => (propsOf(get(testid)).onClick as () => void)();
  const disabled = (testid: string) => propsOf(get(testid)).disabled === true;
  return { island, find, get, press, disabled, calls };
}

describe.each(LOCALES)("SwissRoundsDialog (X-SW-17, owner pick B) [%s]", (locale) => {
  const D = DICTS[locale];
  beforeEach(() => {
    active.locale = locale;
  });

  it("5 → 3 on a field of 6: before Save it names rounds 4 to 5 and their 6 unplayed matches; Save sends 3 once and closes", async () => {
    const d = open({ control: control({ field: 6, rounds: 5 }), fixtures: shells(6, 5) });
    // Opens on the stored count, nothing to save, no preview.
    expect(textOf(d.get("stage-rounds-value"))).toBe("5");
    expect(d.disabled("stage-rounds-save"), "the same count is nothing to save").toBe(true);
    expect(d.find("stage-rounds-preview")).toBeUndefined();
    expect(textOf(d.get("stage-rounds-guidance"))).toBe(fill(D["swiss.rounds.guidance.other"]!, { n: 6, count: 3, hardMax: 5 }));

    d.press("stage-rounds-fewer");
    d.press("stage-rounds-fewer");
    expect(textOf(d.get("stage-rounds-value"))).toBe("3");
    expect(textOf(d.get("stage-rounds-removed"))).toBe(fill(D["stage.rounds.preview.removeMany.other"]!, { from: 4, to: 5, count: 6 }));
    expect(d.find("stage-rounds-added")).toBeUndefined();
    expect(textOf(d.get("stage-rounds-preview")), "and that Undo can't bring them back").toContain(D["swiss.refusal.SWISS_ROUNDS_CHANGE_NOT_UNDOABLE"]);
    expect(d.find("stage-rounds-warn"), "3 is the safe max for 6: no warning").toBeUndefined();

    d.press("stage-rounds-save");
    await flush();
    expect(d.calls.save, "one write, with the count shown").toEqual([3]);
    expect(d.calls.closed, "a landed Save closes the dialog").toBe(1);
  });

  it("+ stops at the field's hard maximum; − stops at the latest paired round and says why", () => {
    // A field of 6: hard max 5. From 4, one press reaches it and the next is refused before it is sent.
    const up = open({ control: control({ field: 6, rounds: 4 }), fixtures: shells(6, 4) });
    expect(up.disabled("stage-rounds-more")).toBe(false);
    up.press("stage-rounds-more");
    expect(textOf(up.get("stage-rounds-value"))).toBe(String(HARD_MAX(6)));
    expect(up.disabled("stage-rounds-more"), "the hard max is the ceiling").toBe(true);
    expect(textOf(up.get("stage-rounds-added"))).toBe(fill(D["stage.rounds.preview.addOne.other"]!, { round: 5, count: 3 }));
    expect(textOf(up.get("stage-rounds-warn")), "above the safe max ⌊6/2⌋ = 3: the T11 warning").toBe(
      fill(D["swiss.rounds.warn.other"]!, { safeMax: 3, recommended: 3, hardMax: 5 }),
    );

    // Round 2 paired: 3 can go to 2, never to 1.
    const down = open({ control: control({ field: 6, rounds: 3 }), fixtures: seatRound(seatRound(shells(6, 3), 1), 2) });
    expect(down.find("stage-rounds-min"), "not at the floor yet").toBeUndefined();
    down.press("stage-rounds-fewer");
    expect(textOf(down.get("stage-rounds-value"))).toBe("2");
    expect(down.disabled("stage-rounds-fewer"), "the paired round is the floor").toBe(true);
    expect(textOf(down.get("stage-rounds-min"))).toBe(D["swiss.refusal.SWISS_ROUNDS_BELOW_SEATED"]);
    expect(down.disabled("stage-rounds-save"), "2 still goes through").toBe(false);
  });

  it("a stored count above the field's hard max (shrunk before Start) opens refused; Save stays off until it is lowered", () => {
    const d = open({ control: control({ field: 4, rounds: 5 }), fixtures: shells(6, 5) });
    expect(textOf(d.get("stage-rounds-above-max"))).toBe(D["swiss.refusal.SWISS_ROUNDS_ABOVE_MAX"]);
    expect(d.disabled("stage-rounds-more")).toBe(true);
    d.press("stage-rounds-fewer");
    expect(d.find("stage-rounds-above-max"), "4 is still above 3").toBeDefined();
    expect(d.disabled("stage-rounds-save"), "never sends a count the server refuses").toBe(true);
    d.press("stage-rounds-fewer");
    expect(d.find("stage-rounds-above-max")).toBeUndefined();
    expect(d.disabled("stage-rounds-save")).toBe(false);
    expect(textOf(d.get("stage-rounds-removed"))).toBe(fill(D["stage.rounds.preview.removeMany.other"]!, { from: 4, to: 5, count: 6 }));
  });

  it("the empty case: nothing drawn yet — the change is only stored, and the dialog says Generate makes the rounds", () => {
    const d = open({ control: control({ field: 6, rounds: 3 }), fixtures: [] });
    d.press("stage-rounds-more");
    expect(textOf(d.get("stage-rounds-not-drawn"))).toBe(D["stage.rounds.preview.notDrawn"]);
    expect(d.find("stage-rounds-added")).toBeUndefined();
    expect(d.find("stage-rounds-removed")).toBeUndefined();
  });

  it("SWISS_ROUNDS_LOCKED from Save (a match started meanwhile): the rounds sentence, and Add a round beside it only when it goes through", async () => {
    const locked = (canAddRound: boolean): SwissRoundsRefusal => ({
      code: "SWISS_ROUNDS_LOCKED",
      extra: { canFinish: false, canAddRound },
      message: "server English",
    });
    const d = open({ control: control({ field: 6, rounds: 3 }), fixtures: shells(6, 3), onSave: async () => locked(true) });
    d.press("stage-rounds-fewer");
    d.press("stage-rounds-save");
    await flush();
    expect(d.calls.closed, "a refusal keeps the dialog open").toBe(0);
    // Phase 2 fix: only the recovery offered is named (canFinish false, canAddRound true), never "Finish now".
    expect(textOf(d.get("stage-rounds-error"))).toContain(`${D["swiss.refusal.SWISS_ROUNDS_LOCKED"]} ${D["swiss.rounds.locked.add"]}`);
    expect(textOf(d.get("stage-rounds-error"))).not.toContain(D["swiss.rounds.locked.finishOrAdd"]);
    expect(textOf(d.get("stage-rounds-error")), "never the server's English").not.toContain("server English");
    expect(textOf(d.get("stage-rounds-add-round"))).toBe(D["stage.more.addRound"]);
    d.press("stage-rounds-add-round");
    await flush();
    expect(d.calls.addRound).toBe(1);
    expect(d.calls.closed, "the round added, the dialog closes").toBe(1);

    // The negative pair: canAddRound false — the sentence, and no button that would only be refused.
    const n = open({ control: control({ field: 6, rounds: 3 }), fixtures: shells(6, 3), onSave: async () => locked(false) });
    n.press("stage-rounds-fewer");
    n.press("stage-rounds-save");
    await flush();
    expect(textOf(n.get("stage-rounds-error"))).toContain(`${D["swiss.refusal.SWISS_ROUNDS_LOCKED"]} ${D["swiss.rounds.locked.none"]}`);
    expect(n.find("stage-rounds-add-round")).toBeUndefined();
  });
});

describe.each(LOCALES)("the rail's rounds chip and the More menu's Add a round [%s]", (locale) => {
  const D = DICTS[locale];
  beforeEach(() => {
    active.locale = locale;
  });
  const rail = (c: SwissRoundControl): SwissRoundsRail => ({
    control: c,
    fixtures: [],
    onSave: async () => null,
    onAddRound: async () => null,
  });

  it("the chip: \"Rounds: N\" with Edit until the first start, a fixed chip after it", () => {
    const editable = renderToStaticMarkup(<SwissRoundsChip stageId="s1" busy={null} rail={rail(control({ field: 6, rounds: 5 }))} onOpen={() => {}} />);
    expect(editable).toMatch(/^<button[^>]*data-testid="stage-rounds"[^>]*data-state="editable"/);
    expect(editable).toContain(fill(D["stage.rounds.chip"]!, { n: 5 }));
    expect(editable).toContain(`>${D["stage.rounds.edit"]}<`);
    const fixed = renderToStaticMarkup(
      <SwissRoundsChip stageId="s1" busy={null} rail={rail(control({ field: 6, rounds: 5, started: true }))} onOpen={() => {}} />,
    );
    expect(fixed).toMatch(/^<span[^>]*data-testid="stage-rounds"[^>]*data-state="fixed"/);
    expect(fixed).toContain(fill(D["stage.rounds.chip"]!, { n: 5 }));
    expect(fixed, "nothing to edit once play starts").not.toContain(`>${D["stage.rounds.edit"]}<`);
  });

  it("pressing the chip asks the rail to close its phone sheet first", () => {
    let opened = 0;
    const island = renderIsland(SwissRoundsChip, {
      stageId: "s1",
      busy: null,
      rail: rail(control({ field: 6, rounds: 5 })),
      onOpen: () => {
        opened++;
      },
    });
    const chip = island.tree().find((e) => propsOf(e)["data-testid"] === "stage-rounds")!;
    (propsOf(chip).onClick as () => void)();
    expect(opened).toBe(1);
  });

  it("Add a round: offered after the first start exactly when it goes through; at the hard max disabled with the reason; never before the start or once over", () => {
    type Row = { name: string; c: SwissRoundControl; shown: boolean; enabled?: boolean; hint?: string };
    const ROWS: Row[] = [
      {
        name: "started, 6 entrants on 3 rounds (hard max 5)",
        c: control({ field: 6, rounds: 3, started: true }),
        shown: true,
        enabled: true,
        hint: fill(D["stage.more.addRound.hint.other"]!, { round: 4, count: 6 }),
      },
      {
        name: "started, 4 entrants on 3 rounds (at the hard max 3)",
        c: control({ field: 4, rounds: 3, started: true, addRound: { canAddRound: false, refusal: "above_max", field: 4, hardMax: 3 } }),
        shown: true,
        enabled: false,
        hint: fill(D["stage.more.addRound.atMax.other"]!, { field: 4, count: 3 }),
      },
      { name: "before the first start (the dialog edits the count)", c: control({ field: 6, rounds: 3 }), shown: false },
      {
        name: "over",
        c: control({ field: null, rounds: 3, started: true, addRound: { canAddRound: false, refusal: "over", field: null, hardMax: null } }),
        shown: false,
      },
      {
        name: "no pairable field",
        c: control({ field: 1, rounds: 3, started: true, addRound: { canAddRound: false, refusal: "field", field: 1, hardMax: null } }),
        shown: false,
      },
    ];
    let checked = 0;
    for (const r of ROWS) {
      const html = renderToStaticMarkup(<SwissAddRoundMenuItem stageId="s1" busy={null} rail={rail(r.c)} />);
      if (!r.shown) {
        expect(html, r.name).toBe("");
      } else {
        expect(html, r.name).toContain('data-testid="stage-add-round"');
        expect(html, r.name).toContain(D["stage.more.addRound"]);
        expect(/<button[^>]*disabled=""/.test(html), `${r.name}: disabled`).toBe(!r.enabled);
        expect(html, r.name).toContain(r.hint!.replace(/'/g, "&#x27;"));
      }
      checked++;
    }
    expect(checked, "anti-vacuity: rows rendered").toBe(ROWS.length);
    expect(ROWS.filter((r) => r.shown).length).toBeGreaterThan(0);
    expect(ROWS.filter((r) => !r.shown).length).toBeGreaterThan(0);
  });
});
