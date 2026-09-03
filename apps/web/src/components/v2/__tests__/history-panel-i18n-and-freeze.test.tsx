// Two defects in one panel, plus the testids two walkthrough specs select on.
//
// 1. NINE hardcoded English strings. The panel already reads `confirm.*`,
//    `history.checkpoint.*` and `history.restore.*` from the dictionary, so a
//    Spanish, French or Dutch organiser got a half-translated card — including
//    the heading of a Pro-gated feature (`schedule.versioning`) and the label
//    on the most destructive control on the page.
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
//    frozen case here is driven with `canEdit` TRUE.
//
// Why a sentinel dict rather than a text assertion: `useMsg` falls back to the
// English catalog outside a DictProvider (dict-provider.tsx), and this change
// keeps every English value byte-identical to the literal it replaces (e2e
// specs select "Recent edits", "Save point" and "Clear schedule…" by name). So
// a render under the English fallback CANNOT tell a dictionary read from a
// hardcoded literal — both emit the same bytes. Providing a stub dict whose
// values are sentinels is what makes the difference observable: a literal
// survives the locale switch, a `msg()` call does not.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { DictProvider } from "@/components/i18n/dict-provider";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";

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

/** Every string this task moves into the dictionary, keyed the way the panel
 *  now asks for it. Values are sentinels: none of them is English, so any of
 *  them appearing in the markup proves the panel went through `msg()`. */
const XX: Record<string, string> = {
  "history.title": "HISTORY-TITLE-XX",
  "history.freezeAll": "FREEZE-ALL-XX",
  "history.recent.title": "RECENT-TITLE-XX",
  "history.recent.empty": "RECENT-EMPTY-XX",
  "history.savePoints.title": "SAVEPOINTS-TITLE-XX",
  "history.savePoints.create": "SAVEPOINT-CREATE-XX",
  "history.danger.title": "DANGER-TITLE-XX",
  "history.danger.body": "DANGER-BODY-XX",
  "history.danger.clear": "DANGER-CLEAR-XX",
  "history.danger.frozen": "DANGER-FROZEN-XX",
};

/** The literals as they appear in the SHIPPED markup, anchored on `>`…`<`
 *  wherever the string is short enough to collide with an attribute value —
 *  "Save point" is also the `aria-label` of the input beside the button, and
 *  that aria-label is deliberately NOT part of this change. */
const ENGLISH_LITERALS = [
  ">History<",
  "Freeze whole schedule",
  ">Recent edits<",
  "Nothing yet.",
  ">Save points<",
  ">Save point<",
  ">Danger zone<",
  "Clears timetable slots only",
  "Clear schedule",
];

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

describe("HistoryPanel — the Danger zone respects the schedule freeze", () => {
  it("disables the clear button and says why when the division is frozen", () => {
    const html = englishMarkup(true);
    expect(tagOf(html, "schedule-clear")).toContain('disabled=""');
    expect(tagOf(html, "schedule-clear-reason")).not.toBe("");
    expect(html).toContain("The schedule is frozen.");
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
  it("renders the active locale's copy, not English, for all nine strings", () => {
    const html = sentinelMarkup(true);
    for (const [key, sentinel] of Object.entries(XX)) {
      expect(html, `${key} must be read through msg()`).toContain(sentinel);
    }
  });

  it("emits none of the nine English literals once another locale is active", () => {
    const html = sentinelMarkup(true);
    for (const literal of ENGLISH_LITERALS) {
      expect(html, `hardcoded literal still shipping: ${literal}`).not.toContain(literal);
    }
  });

  it("still renders the exact English copy the e2e specs select by name", () => {
    // The dictionary values are byte-identical to the literals they replace;
    // open-scheduling.spec.ts and schedule-panels.spec.ts select "Save point"
    // and "Recent edits" by accessible name, so a reworded English value is a
    // silent e2e break.
    const html = englishMarkup(false);
    expect(html).toContain(">Recent edits<");
    expect(html).toContain(">Save point<");
    expect(html).toContain(">Danger zone<");
    expect(html).toContain("Clear schedule");
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
