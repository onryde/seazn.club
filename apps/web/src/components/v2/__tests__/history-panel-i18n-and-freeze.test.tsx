// Two defects in one panel, plus the testids two walkthrough specs select on.
//
// 1. The panel shipped its copy as hardcoded English while the confirm dialog
//    beside it correctly read the dictionary, so a Spanish, French or Dutch
//    organiser got a half-English card — including the heading of a Pro-gated
//    feature and the label on the most destructive control on the page. Every
//    user-facing string in the file now goes through `msg()`: the chrome, the
//    twelve event names in the "Recent edits" list, the two aria-labels and the
//    save-point placeholder.
//
// 2. The Danger zone's only render gate was `canEdit`. `HistoryPanel` already
//    RECEIVES `scheduleLocked` (schedule/page.tsx passes
//    `division.schedule_locked`) and already uses it for the freeze checkbox —
//    the clear button simply never consulted the value the component was
//    holding. On a frozen division the button was live and the organiser
//    learned about the freeze from a 422.
//
//    The gate must be the `scheduleLocked` PROP. `canEdit` at the mount site is
//    `canEdit && !billingFrozen`, and `billingFrozen` is the org's BILLING
//    freeze (over-quota ⇒ read-only) — a different thing with a confusingly
//    similar name. Gating on anything derived from `canEdit` would make the
//    guard silently unreachable while every test below still passed, so the
//    frozen case here is driven with `canEdit` TRUE and only `scheduleLocked`
//    varying.
//
// Why a sentinel dict rather than a text assertion: `useMsg` falls back to the
// English catalog outside a DictProvider (dict-provider.tsx), and this change
// keeps every English value byte-identical to the literal it replaces (four are
// selected by name from e2e — see ANCHORS below). So a render under the English
// fallback CANNOT tell a dictionary read from a hardcoded literal; both emit
// the same bytes. Providing a stub dict whose values are sentinels is what
// makes the difference observable: a literal survives the locale switch, a
// `msg()` call does not.
//
// Expected values are read from `en/ui.json` itself rather than typed in here,
// so a reworded value moves the test with it instead of leaving it asserting
// yesterday's copy.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";
import { DictProvider } from "@/components/i18n/dict-provider";
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

/** Every key the panel renders with an EMPTY history list — the chrome, the
 *  save-point form, the Danger zone. */
const STATIC_KEYS = [
  "history.aria",
  "history.title",
  "history.undo",
  "history.redo",
  "history.freezeAll",
  "history.recent.title",
  "history.recent.empty",
  "history.savePoints.title",
  "history.savePoints.placeholder",
  "history.savePoints.labelAria",
  "history.savePoints.create",
  "history.danger.title",
  "history.danger.body",
  "history.danger.clear",
  "history.danger.frozen",
] as const;

/** event type -> the key that names it. Keyed by the EVENT TYPE rather than the
 *  English label, so rewording a label never orphans its key. */
const EVENT_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["schedule_applied", "history.event.scheduleApplied"],
  ["schedule_edited", "history.event.scheduleEdited"],
  ["schedule_cleared", "history.event.scheduleCleared"],
  ["schedule_restored", "history.event.scheduleRestored"],
  ["fixtures_generated", "history.event.fixturesGenerated"],
  ["fixtures_cleared", "history.event.fixturesCleared"],
  ["pool_entrants_cleared", "history.event.poolEntrantsCleared"],
  ["pool_entrants_restored", "history.event.poolEntrantsRestored"],
  ["officials_assigned", "history.event.officialsAssigned"],
  ["participants_imported", "history.event.participantsImported"],
  ["schedule_published", "history.event.schedulePublished"],
  ["division_started", "history.event.divisionStarted"],
];

/** Sentinels derived FROM the key list, so the two can never drift apart. */
const XX: Record<string, string> = Object.fromEntries(
  [...STATIC_KEYS, ...EVENT_KEYS.map(([, k]) => k), "history.notUndoable"].map((k) => [
    k,
    `XX-${k}-XX`,
  ]),
);

/** Where each static key lands in the markup. A bare substring would match an
 *  attribute as happily as a text node ("Save point" is also the input's
 *  aria-label), so every expectation is anchored on what actually surrounds it.
 *  The arrow glyphs are part of the BUTTON, not of the dictionary value — see
 *  the component for why — so they belong in the anchor, not the expected copy. */
const ATTRIBUTE_OF: Record<string, string> = {
  "history.aria": "aria-label",
  "history.savePoints.placeholder": "placeholder",
  "history.savePoints.labelAria": "aria-label",
};
const GLYPH_OF: Record<string, string> = {
  "history.undo": "↩ ",
  "history.redo": "↪ ",
};
const anchorFor = (key: string, value: string): string =>
  ATTRIBUTE_OF[key] ? `${ATTRIBUTE_OF[key]}="${value}"` : `>${GLYPH_OF[key] ?? ""}${value}<`;

/** No provider ⇒ `useMsg` falls back to the English catalog, which IS the
 *  production path for an English organiser. */
const englishMarkup = (scheduleLocked: boolean): string =>
  renderToStaticMarkup(
    <HistoryPanel divisionId="d1" scheduleLocked={scheduleLocked} canEdit />,
  );

const sentinelMarkup = (scheduleLocked: boolean): string =>
  renderToStaticMarkup(
    <DictProvider dict={XX} locale="fr">
      <HistoryPanel divisionId="d1" scheduleLocked={scheduleLocked} canEdit />
    </DictProvider>,
  );

/** The opening tag of the element carrying `testid`, or "" when absent.
 *  React emits `disabled=""` for a true boolean and NOTHING for false, so the
 *  tag string is what discriminates the two — `.btn`'s className carries
 *  `disabled:cursor-not-allowed`, which a bare /disabled/ probe would match in
 *  both states. */
const tagOf = (html: string, testid: string): string =>
  html.match(new RegExp(`<[a-z]+[^>]*\\bdata-testid="${testid}"[^>]*>`))?.[0] ?? "";

describe("HistoryPanel — the keys this panel asks for actually exist", () => {
  // Every expectation below is DERIVED from en/ui.json. A missing key makes the
  // expected value `undefined`, and `not.toContain(undefined)` passes on any
  // input — two of the assertions in this file would go vacuously green. This
  // is the guard that stops that, so it must come first.
  it("has every key the panel renders in the English catalog", () => {
    for (const key of [
      ...STATIC_KEYS,
      ...EVENT_KEYS.map(([, k]) => k),
      "history.notUndoable",
    ]) {
      expect(EN, `${key} is missing from en/ui.json`).toHaveProperty(key);
      expect(typeof EN[key], `${key} must be a string`).toBe("string");
    }
  });
});

describe("HistoryPanel — the Danger zone respects the schedule freeze", () => {
  it("disables the clear button and says why when the division is frozen", () => {
    const html = englishMarkup(true);
    expect(tagOf(html, "schedule-clear")).toContain('disabled=""');
    expect(tagOf(html, "schedule-clear-reason")).not.toBe("");
    expect(html).toContain(EN["history.danger.frozen"]);
  });

  it("leaves the clear button live, with no reason note, when it is not frozen", () => {
    const html = englishMarkup(false);
    expect(tagOf(html, "schedule-clear")).not.toBe("");
    expect(tagOf(html, "schedule-clear")).not.toContain('disabled=""');
    expect(tagOf(html, "schedule-clear-reason")).toBe("");
  });

  it("keeps the control visible rather than removing it — a vanished button reads as a missing feature", () => {
    // Both states render the button; only its `disabled` differs. If a future
    // change hides it instead, this is the assertion that objects.
    expect(tagOf(englishMarkup(true), "schedule-clear")).not.toBe("");
    expect(tagOf(englishMarkup(false), "schedule-clear")).not.toBe("");
  });
});

describe("HistoryPanel — every string in the panel comes from the dictionary", () => {
  it("renders the active locale's copy, not English, for every static string", () => {
    const html = sentinelMarkup(true);
    for (const key of STATIC_KEYS) {
      expect(html, `${key} must be read through msg()`).toContain(anchorFor(key, XX[key]!));
    }
  });

  it("emits none of the English values once another locale is active", () => {
    const html = sentinelMarkup(true);
    for (const key of STATIC_KEYS) {
      expect(html, `hardcoded literal still shipping for ${key}`).not.toContain(
        anchorFor(key, EN[key]!),
      );
    }
  });

  it("still renders the exact English copy the e2e specs select by name", () => {
    // The dictionary values are byte-identical to the literals they replace.
    // Four are load-bearing: schedule-panels.spec.ts selects "Recent edits" and
    // the buttons named "↩ Undo"/"↪ Redo", open-scheduling.spec.ts selects the
    // "Save point" button and the "Save point label" input, and mobile.spec.ts
    // selects the input by its placeholder. A reworded English value is a
    // silent e2e break, so every one of them is pinned to en/ui.json here.
    const html = englishMarkup(true);
    for (const key of STATIC_KEYS) {
      expect(html, `${key}: the shipped English changed`).toContain(anchorFor(key, EN[key]!));
    }
  });
});

describe("HistoryPanel — the panel's copy points at the panel's own controls", () => {
  // The frozen note's first draft read "Unfreeze it on the board to clear
  // slots." True — schedule-board.tsx has a whole-division freeze toggle on the
  // same `/locks` endpoint — but it sends the organiser to another tab when the
  // checkbox that SET the freeze ("Freeze whole schedule") is a few hundred
  // pixels up this very panel. Copy that points past the nearer control teaches
  // the reader that the product is bigger and more confusing than it is.
  //
  // Written as a sweep over every key this panel owns, in every locale, rather
  // than as one assertion on the one string that was wrong: the defect entered
  // through a translated string, and a check that only reads English would not
  // have seen three quarters of it.
  const OFFSITE = /\b(board|tab)\b|tablero|tableau|\bbord\b|pesta[ñn]a|onglet|tabblad/i;
  const OWNED = [...STATIC_KEYS, ...EVENT_KEYS.map(([, k]) => k), "history.notUndoable"];

  for (const locale of Object.keys(DICTS)) {
    it(`${locale}: no string sends the organiser to another surface`, () => {
      for (const key of OWNED) {
        const value = DICTS[locale]![key]!;
        expect(value, `${locale}/${key} is missing`).toBeTypeOf("string");
        expect(value, `${locale}/${key} points off this panel: "${value}"`).not.toMatch(OFFSITE);
      }
    });
  }
});

describe("HistoryPanel — the Recent edits list names events in the reader's language", () => {
  /** One event per known type, the first of them not undoable. The panel slices
   *  to 12 and there are exactly 12 types, so all of them render. */
  const EVENTS = EVENT_KEYS.map(([type], i) => ({
    seq: EVENT_KEYS.length - i,
    type,
    undoable: i !== 0,
    undone: false,
    created_at: "2026-09-03T10:00:00.000Z",
  }));

  async function renderWithEvents() {
    apiV1.mockReset();
    apiV1.mockImplementation(async (path: string) =>
      path.endsWith("/history") ? { watermark: 1, seq: 12, events: EVENTS } : [],
    );
    const island = renderIsland(
      (props: { divisionId: string; scheduleLocked: boolean; canEdit: boolean }) =>
        HistoryPanel(props),
      { divisionId: "d1", scheduleLocked: false, canEdit: true },
    );
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    return island;
  }

  it("resolves all twelve event types through the dictionary, never the raw type", async () => {
    const text = (await renderWithEvents()).text();
    for (const [type, key] of EVENT_KEYS) {
      expect(text, `${type} must render ${key}`).toContain(EN[key]!);
      expect(text, `${type} fell through to the raw event type`).not.toContain(type);
    }
    expect(text).toContain(EN["history.notUndoable"]!);
  });

  it("keeps no English event label as a literal in the component source", () => {
    // The list above renders under the English fallback, so it cannot tell a
    // dictionary read from a literal any more than the chrome could. Reading
    // the source is what makes a reintroduced TYPE_LABELS map fail.
    const src = readFileSync(join(process.cwd(), "src/components/v2/history-panel.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    for (const [, key] of EVENT_KEYS) {
      expect(src, `${key}'s English is still hardcoded`).not.toContain(EN[key]!);
    }
    expect(src, "the not-undoable note is still hardcoded").not.toContain(EN["history.notUndoable"]!);
  });
});

describe("HistoryPanel — the testids the walkthrough specs select on", () => {
  it("marks the save-point label input and its create button", () => {
    const html = englishMarkup(false);
    expect(tagOf(html, "savepoint-label")).not.toBe("");
    expect(tagOf(html, "savepoint-create")).not.toBe("");
  });

  it("marks every save-point row with its id, and each row's restore button", async () => {
    apiV1.mockReset();
    apiV1.mockImplementation(async (path: string) =>
      path.endsWith("/history") ? { watermark: 1, seq: 1, events: [] } : CHECKPOINTS,
    );
    const island = renderIsland(
      (props: { divisionId: string; scheduleLocked: boolean; canEdit: boolean }) =>
        HistoryPanel(props),
      { divisionId: "d1", scheduleLocked: false, canEdit: true },
    );
    // The mount effect defers via setTimeout(0) and awaits two fetches — two
    // ticks lets both settle, the same margin the eviction-notice suite uses.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const byTestid = (id: string): ReactElement[] =>
      island.tree().filter((el: ReactElement) => propsOf(el)["data-testid"] === id);

    expect(byTestid("checkpoint-row")).toHaveLength(2);
    expect(byTestid("checkpoint-row").map((el) => propsOf(el)["data-checkpoint-id"])).toEqual([
      "cp-1",
      "cp-2",
    ]);
    expect(byTestid("checkpoint-restore")).toHaveLength(2);
  });
});

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
    label: "After rain reshuffle",
    kind: "manual" as const,
    created_at: "2026-09-03T11:00:00.000Z",
  },
];
