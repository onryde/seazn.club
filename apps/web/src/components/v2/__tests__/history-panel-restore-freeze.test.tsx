// The freeze has to bind BOTH destructive controls in this panel, not one.
//
// The Danger zone's clear already refuses a frozen division — button disabled,
// reason stated (history-panel-i18n-and-freeze.test.tsx). Restore did not, and
// it is the wider of the two edits: clear empties unlocked slots, a restore
// rewrites every fixture's time and court back to the save point. The two
// controls sit a few hundred pixels apart in the same console, so an organiser
// who froze the board found the smaller edit refused and the larger one live.
//
// Two things are asserted separately on purpose, because each has its own way
// of silently disappearing: the BUTTON's `disabled`, and the NOTE that says
// why. A pair of guards that cover for each other are both untested — deleting
// either one must red something here on its own.
//
// The rows this drives only exist after the mount fetch, so this uses the hook
// harness rather than `renderToStaticMarkup`: a static render of this panel has
// an empty checkpoint list and no restore button to disable. The harness has no
// provider tree, so `useMsg` falls back to the English catalog — the production
// path for an English organiser, and the reason the i18n half below is proved
// against the four dictionaries and the component SOURCE rather than by
// switching locale at render time.
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

/** The key the frozen restore states its reason with. Its sibling
 *  `history.danger.frozen` says "to clear slots", which is the wrong sentence
 *  here — the control it names is a different one. */
const KEY = "history.checkpoint.frozen";

const CHECKPOINTS = [
  {
    id: "cp-1",
    seq: 1,
    label: "Before rain reshuffle",
    kind: "manual" as const,
    created_at: "2026-09-03T10:00:00.000Z",
  },
  {
    id: "cp-2",
    seq: 2,
    label: "Before AI",
    kind: "ai" as const,
    created_at: "2026-09-03T11:00:00.000Z",
  },
];

interface PanelProps {
  divisionId: string;
  scheduleLocked: boolean;
  canEdit: boolean;
}

/** Mount the real island with `rows` save points and let both fetches settle.
 *  `canEdit` is held TRUE throughout: at the mount site it is
 *  `canEdit && !billingFrozen`, the ORG's billing freeze — a different thing
 *  with a confusingly similar name. Only `scheduleLocked` varies, or the
 *  differential proves nothing about the schedule freeze. */
async function render(scheduleLocked: boolean, rows = CHECKPOINTS) {
  apiV1.mockReset();
  apiV1.mockImplementation(async (path: string) =>
    path.endsWith("/history") ? { watermark: 1, seq: 2, events: [] } : rows,
  );
  const island = renderIsland<PanelProps>((props: PanelProps) => HistoryPanel(props), {
    divisionId: "d1",
    scheduleLocked,
    canEdit: true,
  });
  // The mount effect defers via setTimeout(0) and awaits two fetches — two
  // ticks lets both settle, the same margin the sibling suites use.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  const byTestid = (id: string): ReactElement[] =>
    island.tree().filter((el: ReactElement) => propsOf(el)["data-testid"] === id);
  return {
    restores: byTestid("checkpoint-restore"),
    reasons: byTestid("checkpoint-restore-reason"),
  };
}

describe("HistoryPanel — the key the frozen restore speaks with exists", () => {
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

describe("HistoryPanel — a frozen schedule refuses the restore too", () => {
  it("disables every save point's Restore and says why", async () => {
    const { restores, reasons } = await render(true);
    expect(restores).toHaveLength(2);
    for (const b of restores) expect(propsOf(b).disabled).toBe(true);
    expect(reasons, "the frozen restore states no reason").toHaveLength(1);
    expect(propsOf(reasons[0]!).children).toBe(EN[KEY]);
  });

  it("leaves Restore live, with no reason note, when the schedule is not frozen", async () => {
    const { restores, reasons } = await render(false);
    expect(restores).toHaveLength(2);
    for (const b of restores) expect(propsOf(b).disabled).toBe(false);
    expect(reasons).toHaveLength(0);
  });

  it("makes the disabled Restore LOOK disabled, not merely act disabled", async () => {
    // The clear button is a `.btn`, and `.btn` carries
    // `disabled:cursor-not-allowed disabled:opacity-50` (globals.css). This one
    // is a bare text button, so it inherits none of that: with a custom
    // `color` set, a disabled <button> renders identically to a live one and
    // still underlines on hover, which is a control that lies about itself.
    // The reason note explains a state the control has to be showing.
    //
    // Class tokens, not computed style — this environment has no browser. The
    // three below are the same stock utilities `.btn` uses, so "present" and
    // "in effect" coincide as closely as they can without one.
    const { restores } = await render(true);
    for (const b of restores) {
      const className = String(propsOf(b).className ?? "");
      expect(className, "no disabled cursor").toContain("disabled:cursor-not-allowed");
      expect(className, "a disabled control at full strength").toContain("disabled:opacity-50");
      // `:hover` still matches a disabled button, so a bare `hover:underline`
      // keeps painting the link affordance on a control that does nothing.
      expect(className, "the hover underline is not gated on enabled").not.toMatch(
        /(^|\s)hover:underline/,
      );
    }
  });

  it("keeps the control visible rather than removing it — a vanished button reads as a missing feature", async () => {
    // Both states render both rows AND both buttons; only `disabled` differs.
    // A future change that hides them instead fails here.
    expect((await render(true)).restores).toHaveLength(2);
    expect((await render(false)).restores).toHaveLength(2);
  });

  it("says nothing about restoring when the division has no save points to restore", async () => {
    // The note explains a disabled control. With no rows there is no control,
    // and the sentence would be a paragraph about a button that is not there.
    const { restores, reasons } = await render(true, []);
    expect(restores).toHaveLength(0);
    expect(reasons).toHaveLength(0);
  });
});

describe("HistoryPanel — the frozen-restore note is real copy, in every locale", () => {
  it("keeps the English sentence out of the component source", async () => {
    // The rows render under the English fallback, so the markup cannot tell a
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
    // card. Same sweep, same regex, applied to the sibling sentence — and per
    // locale, because that defect entered through the translations too.
    const OFFSITE = /\b(board|tab)\b|tablero|tableau|\bbord\b|pesta[ñn]a|onglet|tabblad/i;
    for (const locale of Object.keys(DICTS)) {
      const value = DICTS[locale]![KEY]!;
      expect(value, `${locale}/${KEY} points off this panel: "${value}"`).not.toMatch(OFFSITE);
    }
  });

  it("points the same way, in the same word, as the sentence about the freeze it shares a panel with", () => {
    // "Above" is per-locale copy, not a constant. `history.danger.body` already
    // says it in each locale (arriba / ci-dessus / hierboven) and points at the
    // same checkbox; two sentences in one console must not disagree about
    // which direction it is in.
    const DEIXIS: Record<string, string> = {
      en: "above",
      es: "arriba",
      fr: "ci-dessus",
      nl: "hierboven",
    };
    for (const [locale, word] of Object.entries(DEIXIS)) {
      expect(
        DICTS[locale]!["history.danger.body"]!.toLowerCase(),
        `the sibling sentence stopped saying "${word}" in ${locale} — re-pick the word`,
      ).toContain(word);
      expect(
        DICTS[locale]![KEY]!.toLowerCase(),
        `${locale}/${KEY} must point at the freeze checkbox the same way its neighbour does`,
      ).toContain(word);
    }
  });
});
