// The freeze has to bind the REWIND primitives too, not only the two controls
// built on top of them.
//
// Clear and Restore already refuse a frozen division — button disabled, reason
// stated (history-panel-i18n-and-freeze.test.tsx, history-panel-restore-
// freeze.test.tsx). Undo and Redo did not, and `restoreCheckpoint` is a LOOP OF
// `undoDivision`: the freeze stopped the composite and left the primitive live,
// on two buttons roughly 250px above the Restore it had just disabled. Same
// blast radius, one layer down.
//
// Three things are asserted separately on purpose, because each has its own way
// of silently disappearing: Undo's `disabled`, Redo's `disabled`, and the NOTE
// that says why. Guards that cover for each other are all untested — deleting
// any one of the three must red something here on its own.
//
// The harness has no provider tree, so `useMsg` falls back to the English
// catalog — the production path for an English organiser, and the reason the
// i18n half below is proved against the four dictionaries and the component
// SOURCE rather than by switching locale at render time.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

const apiV1 = vi.fn();
vi.mock("@/lib/client-v1", () => ({
  apiV1: (...args: unknown[]) => apiV1(...args),
  ApiV1Error: class extends Error {},
}));

const { HistoryPanel } = await import("../history-panel");

const EN = enUi as unknown as Record<string, string>;
const DICTS: Record<string, Record<string, string>> = {
  en: EN,
  es: esUi as unknown as Record<string, string>,
  fr: frUi as unknown as Record<string, string>,
  nl: nlUi as unknown as Record<string, string>,
};

/** The key the frozen rewind states its reason with. Its two siblings say
 *  "to clear slots" and "to restore a save point" — both name a different
 *  control, so neither is the right sentence here. */
const KEY = "history.step.frozen";

interface PanelProps {
  divisionId: string;
  scheduleLocked: boolean;
  canEdit: boolean;
}

/** Mount the real island and let the mount fetches settle. `canEdit` is held
 *  TRUE throughout: at the mount site it is `canEdit && !billingFrozen`, the
 *  ORG's billing freeze — a different thing with a confusingly similar name.
 *  Only `scheduleLocked` varies, or the differential proves nothing about the
 *  schedule freeze. */
async function render(scheduleLocked: boolean) {
  apiV1.mockReset();
  apiV1.mockImplementation(async (path: string) =>
    path.endsWith("/history") ? { watermark: 1, seq: 2, events: [] } : [],
  );
  const island = renderIsland<PanelProps>((props: PanelProps) => HistoryPanel(props), {
    divisionId: "d1",
    scheduleLocked,
    canEdit: true,
  });
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  const byTestid = (id: string): ReactElement[] =>
    island.tree().filter((el: ReactElement) => propsOf(el)["data-testid"] === id);
  return {
    undo: byTestid("history-undo"),
    redo: byTestid("history-redo"),
    reasons: byTestid("history-step-reason"),
  };
}

describe("HistoryPanel — the key the frozen rewind speaks with exists", () => {
  // Every expectation below is DERIVED from the dictionaries. A missing key
  // makes the expected value `undefined`, and `not.toContain(undefined)` passes
  // on any input, so this guard has to come first or the source scan goes
  // vacuously green.
  for (const locale of Object.keys(DICTS)) {
    it(`${locale}/ui.json carries ${KEY}`, () => {
      expect(DICTS[locale], `${KEY} is missing from ${locale}/ui.json`).toHaveProperty(KEY);
      expect(typeof DICTS[locale]![KEY], `${locale}/${KEY} must be a string`).toBe("string");
    });
  }
});

describe("HistoryPanel — a frozen schedule refuses the rewind too", () => {
  it("disables Undo and Redo and says why", async () => {
    const { undo, redo, reasons } = await render(true);
    expect(undo, "no Undo button on the panel").toHaveLength(1);
    expect(redo, "no Redo button on the panel").toHaveLength(1);
    expect(propsOf(undo[0]!).disabled, "Undo is live on a frozen division").toBe(true);
    expect(propsOf(redo[0]!).disabled, "Redo is live on a frozen division").toBe(true);
    expect(reasons, "the frozen rewind states no reason").toHaveLength(1);
    expect(propsOf(reasons[0]!).children).toBe(EN[KEY]);
  });

  it("leaves Undo and Redo live, with no reason note, when the schedule is not frozen", async () => {
    const { undo, redo, reasons } = await render(false);
    expect(propsOf(undo[0]!).disabled, "Undo is dead on an UNFROZEN division").toBe(false);
    expect(propsOf(redo[0]!).disabled, "Redo is dead on an UNFROZEN division").toBe(false);
    expect(reasons).toHaveLength(0);
  });

  it("keeps both controls visible rather than removing them — a vanished button reads as a missing feature", async () => {
    // Both states render both buttons; only `disabled` and the note differ.
    expect((await render(true)).undo).toHaveLength(1);
    expect((await render(true)).redo).toHaveLength(1);
    expect((await render(false)).undo).toHaveLength(1);
    expect((await render(false)).redo).toHaveLength(1);
  });

  it("makes the disabled controls LOOK disabled", async () => {
    // These two are `.btn btn-ghost`, and `.btn` carries
    // `disabled:cursor-not-allowed disabled:opacity-50` (globals.css) — unlike
    // the Restore beside them, which is a bare text button and needed the
    // utilities spelled out. Class tokens, not computed style: this
    // environment has no browser, so "present" is as close to "in effect" as
    // an assertion here can get.
    const { undo, redo } = await render(true);
    for (const b of [undo[0]!, redo[0]!]) {
      expect(String(propsOf(b).className ?? "")).toMatch(/(^|\s)btn(\s|$)/);
    }
  });

  it("still says the arrow-prefixed accessible name the e2e specs select on", async () => {
    // `schedule-panels.spec.ts` clicks by accessible name ("↩ Undo"), so the
    // glyph is load-bearing and lives in the JSX rather than the dictionary.
    const { undo, redo } = await render(false);
    expect(propsOf(undo[0]!).children).toBe(`↩ ${EN["history.undo"]}`);
    expect(propsOf(redo[0]!).children).toBe(`↪ ${EN["history.redo"]}`);
  });
});

describe("HistoryPanel — the frozen-rewind note is real copy, in every locale", () => {
  it("keeps the English sentence out of the component source", async () => {
    // The panel renders under the English fallback, so the markup cannot tell a
    // dictionary read from a hardcoded literal. Reading the source is what
    // makes a literal fail.
    const src = readFileSync(join(process.cwd(), "src/components/v2/history-panel.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(src, `${KEY}'s English is hardcoded`).not.toContain(EN[KEY]!);
  });

  it("is translated, not the English value copied into three files", () => {
    for (const locale of ["es", "fr", "nl"]) {
      expect(DICTS[locale]![KEY], `${locale}/${KEY} is still the English string`).not.toBe(EN[KEY]);
    }
  });

  it("names the freeze control in THIS panel, never another surface", () => {
    // `history.danger.frozen`'s first draft sent the organiser to the board's
    // own freeze toggle when the checkbox that SET the freeze is in this very
    // card — and here it is on the same ROW as the two buttons. Same sweep,
    // same regex as the sibling sentences, and per locale, because that defect
    // entered through the translations too.
    const OFFSITE = /\b(board|tab)\b|tablero|tableau|\bbord\b|pesta[ñn]a|onglet|tabblad/i;
    for (const locale of Object.keys(DICTS)) {
      const value = DICTS[locale]![KEY]!;
      expect(value, `${locale}/${KEY} points off this panel: "${value}"`).not.toMatch(OFFSITE);
    }
  });

  it("points the same way, in the same word, as the two sentences it shares a panel with", () => {
    // "Above" is per-locale copy, not a constant. `history.danger.body` and
    // `history.checkpoint.frozen` already say it in each locale (arriba /
    // ci-dessus / hierboven) and point at the same checkbox; three sentences in
    // one console must not disagree about which direction it is in.
    const DEIXIS: Record<string, string> = {
      en: "above",
      es: "arriba",
      fr: "ci-dessus",
      nl: "hierboven",
    };
    for (const [locale, word] of Object.entries(DEIXIS)) {
      expect(
        DICTS[locale]!["history.checkpoint.frozen"]!.toLowerCase(),
        `the sibling sentence stopped saying "${word}" in ${locale} — re-pick the word`,
      ).toContain(word);
      expect(
        DICTS[locale]![KEY]!.toLowerCase(),
        `${locale}/${KEY} must point at the freeze checkbox the same way its neighbours do`,
      ).toContain(word);
    }
  });

  it("names BOTH controls it explains, not just one", () => {
    // One note covers Undo and Redo. A sentence that only mentions undo leaves
    // the reader of a disabled Redo with no explanation at all.
    const VERBS: Record<string, [string, string]> = {
      en: ["undo", "redo"],
      es: ["deshacer", "rehacer"],
      fr: ["annuler", "rétablir"],
      nl: ["ongedaan", "opnieuw"],
    };
    for (const [locale, [a, b]] of Object.entries(VERBS)) {
      const value = DICTS[locale]![KEY]!.toLowerCase();
      expect(value, `${locale}/${KEY} does not name the undo`).toContain(a);
      expect(value, `${locale}/${KEY} does not name the redo`).toContain(b);
    }
  });
});
