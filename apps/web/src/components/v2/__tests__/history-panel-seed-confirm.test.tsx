// W4 app-A Task 5 (K1; pre-flight D2): the History panel's side of the seed confirm's undo barrier.
//
// 1. The confirm appends a `seed_confirmed` ledger row, listed in "Recent edits". Without a key it falls through to the
//    raw event type — an English snake_case word in a translated list (the defect TYPE_LABEL_KEYS exists to stop).
// 2. Undo, Redo and Restore can now be refused with a KNOCKOUT code, SEED_CONFIRM_NOT_UNDOABLE. The panel's refusal
//    branches knew only the Swiss table, so the server's English sentence fell through to the banner.
//
// The harness has no provider tree, so `useMsg` falls back to the English catalogue. To tell "the branch fired" from "the
// server's English fell through", every refusal carries a server message that DIFFERS from the dictionary's sentence; the
// four-locale half is pinned against the dictionaries.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => true),
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

/** The plan's event type and code (Task 5), and the keys that say them — typed here, never read from the panel. */
const EVENT = "seed_confirmed";
const EVENT_KEY = "history.event.seedConfirmed";
const CODE = "SEED_CONFIRM_NOT_UNDOABLE";
const CODE_KEY = "knockout.refusal.SEED_CONFIRM_NOT_UNDOABLE";
const CODE_STATUS = 409;

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

describe("HistoryPanel — the seed confirm's barrier row is named in the reader's language (D2)", () => {
  it("renders it through the dictionary, never the raw event type, and as not undoable", async () => {
    const text = (
      await mount([{ seq: 2, type: EVENT, undoable: false, undone: false, created_at: "2026-11-07T10:00:00.000Z" }])
    ).island.text();
    expect(typeof EN[EVENT_KEY], `${EVENT_KEY} is missing from en/ui.json`).toBe("string");
    expect(text, `${EVENT} must render ${EVENT_KEY}`).toContain(EN[EVENT_KEY]);
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

  it("keeps neither English sentence as a literal in the component source", () => {
    const src = readFileSync(join(process.cwd(), "src/components/v2/history-panel.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    for (const key of [EVENT_KEY, CODE_KEY]) expect(src, `${key}'s English is hardcoded`).not.toContain(EN[key]);
  });
});

describe("HistoryPanel — SEED_CONFIRM_NOT_UNDOABLE on Undo, Redo or Restore is said in the reader's language", () => {
  /** Press `control` and have the server refuse with `code`, carrying a server sentence unlike the dictionary's. */
  async function refuse(control: "history-undo" | "history-redo" | "checkpoint-restore", code: string, status: number) {
    const ctx = await mount([
      { seq: 1, type: "fixtures_generated", undoable: true, undone: false, created_at: "2026-11-07T10:00:00.000Z" },
    ]);
    const SERVER = `server says ${code} in English`;
    apiV1.mockImplementation(async (path: string) => {
      if (/\/(undo|redo|restore)$/.test(path)) throw new ApiV1Error(SERVER, status, code);
      return path.endsWith("/history") ? { watermark: null, seq: 2, events: [] } : CHECKPOINTS;
    });
    const button = ctx.byTestid(control)[0];
    expect(button, `${control} is on the panel`).toBeDefined();
    expect(propsOf(button!).disabled, `${control} is live`).not.toBe(true);
    await (propsOf(button!).onClick as () => unknown)(); // Restore's handler awaits its confirm dialog
    await ctx.settle();
    const banner = ctx.byTestid("history-error");
    return { shown: banner.length === 0 ? null : String(propsOf(banner[0]!).children), SERVER };
  }

  it("each of the three step doors paints the dictionary's sentence, never the server's", async () => {
    const LOCAL = EN[CODE_KEY];
    expect(typeof LOCAL, `${CODE_KEY} is in en/ui.json`).toBe("string");
    let checked = 0;
    for (const control of ["history-undo", "history-redo", "checkpoint-restore"] as const) {
      const { shown, SERVER } = await refuse(control, CODE, CODE_STATUS);
      expect(shown, `${control}: the refusal is not said locally`).toBe(LOCAL);
      expect(shown).not.toBe(SERVER);
      checked++;
    }
    expect(checked, "anti-vacuity: the three step doors").toBe(3);
  });

  it("a code that only LOOKS like a knockout refusal still surfaces the server's own message (the negative pair)", async () => {
    const { shown, SERVER } = await refuse("history-undo", "SEED_CONFIRM_SOMETHING_NEW", 409);
    expect(shown).toBe(SERVER);
  });
});
