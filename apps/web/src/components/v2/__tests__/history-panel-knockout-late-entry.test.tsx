// W4 app-A Task 10 (X-LE-13; pre-flight D2): the History panel's side of the knockout late entry's undo barrier.
//
// 1. "Add late player" into a drawn knockout appends a `knockout_late_entry` ledger row, listed in "Recent edits" as not
//    undoable. Without a key it falls through to the raw event type — an English snake_case word in a translated list.
// 2. Undo, Redo and Restore across it are refused with KO_LATE_ENTRY_NOT_UNDOABLE, a KNOCKOUT code: the panel says the
//    dictionary's sentence (which points to Withdraw), never the server's English.
//
// Harness: history-panel-seed-confirm.test.tsx's (no provider tree, so `useMsg` falls back to the English catalogue; every
// refusal carries a server sentence that DIFFERS from the dictionary's).
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
// The confirm dialog answers yes, and keeps what it was asked to say (M11: Restore's body).
const { confirmAsked } = vi.hoisted(() => ({ confirmAsked: [] as { title?: string; body?: string }[] }));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => async (o: { title?: string; body?: string }) => {
    confirmAsked.push(o);
    return true;
  },
}));
const apiV1 = vi.fn();
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return { ...actual, apiV1: (...args: unknown[]) => apiV1(...args) };
});

const { ApiV1Error } = await import("@/lib/client-v1");
const { HistoryPanel } = await import("../history-panel");

const EN = en as unknown as Record<string, string>;
const DICTS = { en, es, fr, nl } as unknown as Record<string, Record<string, string>>;

/** The plan's event type and code (Task 10), and the keys that say them — typed here, never read from the panel. */
const EVENT = "knockout_late_entry";
const EVENT_KEY = "history.event.knockoutLateEntry";
const CODE = "KO_LATE_ENTRY_NOT_UNDOABLE";
const CODE_KEY = "knockout.refusal.KO_LATE_ENTRY_NOT_UNDOABLE";
const CODE_STATUS = 409;
/** The plan's sentences (Task 10 brief), typed here. */
const EVENT_EN = "Late player added to the bracket";
const CODE_EN = "Adding a late player can't be undone. Withdraw the player instead.";

const CHECKPOINTS = [
  { id: "cp-1", seq: 1, label: "Before the draw", kind: "manual" as const, created_at: "2026-11-07T09:00:00.000Z" },
];

interface PanelProps {
  divisionId: string;
  scheduleLocked: boolean;
  canEdit: boolean;
  viewerPlan: "community";
}

async function mount(events: unknown[] = []) {
  apiV1.mockReset();
  apiV1.mockImplementation(async (path: string) =>
    path.endsWith("/history") ? { watermark: null, seq: events.length + 1, events } : CHECKPOINTS,
  );
  const island = renderIsland<PanelProps>((props: PanelProps) => HistoryPanel(props), {
    divisionId: "d1",
    scheduleLocked: false,
    canEdit: true,
    viewerPlan: "community",
  });
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };
  await settle();
  const byTestid = (id: string): ReactElement[] =>
    island.tree().filter((el: ReactElement) => propsOf(el)["data-testid"] === id);
  return { island, byTestid, settle };
}

describe("HistoryPanel — a knockout late entry's barrier row is named in the reader's language (D2)", () => {
  it("renders it through the dictionary, never the raw event type, and as not undoable", async () => {
    const text = (
      await mount([{ seq: 2, type: EVENT, undoable: false, undone: false, created_at: "2026-11-07T10:00:00.000Z" }])
    ).island.text();
    expect(EN[EVENT_KEY], `${EVENT_KEY} is the plan's label`).toBe(EVENT_EN);
    expect(text, `${EVENT} must render ${EVENT_KEY}`).toContain(EVENT_EN);
    expect(text, `${EVENT} fell through to the raw event type`).not.toContain(EVENT);
    expect(text).toContain(EN["history.notUndoable"]);
  });

  it("the label and the refusal exist, translated, in all four dictionaries", () => {
    let checked = 0;
    for (const key of [EVENT_KEY, CODE_KEY]) {
      for (const [locale, dict] of Object.entries(DICTS)) {
        const value = dict[key];
        expect(typeof value === "string" && value.trim() !== "", `${locale}/${key} is missing`).toBe(true);
        if (locale !== "en") expect(value, `${locale}/${key} copies the English`).not.toBe(EN[key]);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: (key, locale) pairs").toBe(8);
  });
});

describe("HistoryPanel — KO_LATE_ENTRY_NOT_UNDOABLE on Undo, Redo or Restore is said in the reader's language", () => {
  async function refuse(control: "history-undo" | "history-redo" | "checkpoint-restore") {
    const ctx = await mount([
      { seq: 1, type: "fixtures_generated", undoable: true, undone: false, created_at: "2026-11-07T10:00:00.000Z" },
    ]);
    const SERVER = `server says ${CODE} in English`;
    apiV1.mockImplementation(async (path: string) => {
      if (/\/(undo|redo|restore)$/.test(path)) throw new ApiV1Error(SERVER, CODE_STATUS, CODE);
      return path.endsWith("/history") ? { watermark: null, seq: 2, events: [] } : CHECKPOINTS;
    });
    const button = ctx.byTestid(control)[0];
    expect(button, `${control} is on the panel`).toBeDefined();
    await (propsOf(button!).onClick as () => unknown)();
    await ctx.settle();
    const banner = ctx.byTestid("history-error");
    return { shown: banner.length === 0 ? null : String(propsOf(banner[0]!).children), SERVER };
  }

  it("each of the three step doors paints the dictionary's sentence (pointing to Withdraw), never the server's", async () => {
    expect(EN[CODE_KEY]).toBe(CODE_EN);
    let checked = 0;
    for (const control of ["history-undo", "history-redo", "checkpoint-restore"] as const) {
      const { shown, SERVER } = await refuse(control);
      expect(shown, `${control}: the refusal is not said locally`).toBe(CODE_EN);
      expect(shown).not.toBe(SERVER);
      checked++;
    }
    expect(checked, "anti-vacuity: the three step doors").toBe(3);
  });
});

describe("HistoryPanel — a knockout refusal that names a number is said with the number filled in (T15 review: no literal {min})", () => {
  // QUALIFYING_MAIN_TOO_FEW's sentence has a {min} hole, filled from the envelope's fields (`err.extra`). The panel's knockout
  // branch used to say the bare dictionary key, so a person read "needs at least {min} entrants".
  const MIN_CODE = "QUALIFYING_MAIN_TOO_FEW";
  async function refuseWith(control: "history-undo" | "history-redo" | "checkpoint-restore", extra: Record<string, unknown>) {
    const ctx = await mount([{ seq: 1, type: "fixtures_generated", undoable: true, undone: false, created_at: "2026-11-07T10:00:00.000Z" }]);
    apiV1.mockImplementation(async (path: string) => {
      if (/\/(undo|redo|restore)$/.test(path)) throw new ApiV1Error("server says QUALIFYING_MAIN_TOO_FEW in English", 422, MIN_CODE, extra);
      return path.endsWith("/history") ? { watermark: null, seq: 2, events: [] } : CHECKPOINTS;
    });
    const button = ctx.byTestid(control)[0];
    expect(button, `${control} is on the panel`).toBeDefined();
    await (propsOf(button!).onClick as () => unknown)();
    await ctx.settle();
    const banner = ctx.byTestid("history-error");
    return banner.length === 0 ? null : String(propsOf(banner[0]!).children);
  }

  it("each of the three step doors paints the sentence with the bound the server sent, and no hole left in it", async () => {
    // The hole is in the dictionary's sentence, typed here as the premise; the expected text is that sentence with the bound
    // written in by hand.
    expect(EN["knockout.refusal.QUALIFYING_MAIN_TOO_FEW"]).toBe("Qualifying + Main draw needs at least {min} entrants.");
    let checked = 0;
    for (const control of ["history-undo", "history-redo", "checkpoint-restore"] as const) {
      for (const [min, sentence] of [[4, "Qualifying + Main draw needs at least 4 entrants."], [8, "Qualifying + Main draw needs at least 8 entrants."]] as const) {
        const shown = await refuseWith(control, { min });
        expect(shown, `${control} at ${min}`).toBe(sentence);
        expect(shown).not.toContain("{");
        checked++;
      }
    }
    expect(checked, "anti-vacuity: three doors, two bounds").toBe(6);
  });
});
