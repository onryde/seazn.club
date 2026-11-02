// W3 T5 (X-SW-28, design §10.8): the History panel's side of Undo of Pair next.
//
// 1. Two new ledger events — an organiser's "Add late player" (`swiss_late_entry`) and a change to a Swiss's round
//    count (`swiss_rounds_changed`) — appear in "Recent edits". Without a key they fall through to the raw event type,
//    an English snake_case word in a translated list.
// 2. Undo, Redo and Restore can now be refused with a Swiss code (`SWISS_UNDO_ROUND_STARTED`, and the two barriers).
//    The server's sentence is English; the panel says the refusal in the reader's language, off the CODE.
//
// The harness has no provider tree, so `useMsg` falls back to the English catalog. To tell "the branch fired" from
// "the server's English fell through", every refusal here carries a server message that DIFFERS from the dictionary's
// sentence; the four-locale half is pinned against the dictionaries and the component source below.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { SWISS_REFUSALS, type SwissRefusalCode } from "@/lib/swiss-refusals";
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

/** The plan's two barrier event types and the keys that name them (W3 T5 brief, "labels for the event types"). */
const SWISS_EVENT_KEYS = [
  ["swiss_late_entry", "history.event.swissLateEntry"],
  ["swiss_rounds_changed", "history.event.swissRoundsChanged"],
] as const;

/** The refusals an Undo, Redo or Restore can now raise (W3 T5: the started round and the two barriers). */
const STEP_REFUSALS: readonly SwissRefusalCode[] = [
  "SWISS_UNDO_ROUND_STARTED",
  "SWISS_LATE_ENTRY_NOT_UNDOABLE",
  "SWISS_ROUNDS_CHANGE_NOT_UNDOABLE",
];

const CHECKPOINTS = [
  { id: "cp-1", seq: 1, label: "Before pairing", kind: "manual" as const, created_at: "2026-10-31T09:00:00.000Z" },
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

describe("HistoryPanel — the Swiss barrier events are named in the reader's language", () => {
  it("renders both through the dictionary, never the raw event type", async () => {
    const events = SWISS_EVENT_KEYS.map(([type], i) => ({
      seq: 3 - i,
      type,
      undoable: false,
      undone: false,
      created_at: "2026-10-31T10:00:00.000Z",
    }));
    const text = (await mount(events)).island.text();
    let checked = 0;
    for (const [type, key] of SWISS_EVENT_KEYS) {
      expect(typeof EN[key], `${key} is missing from en/ui.json`).toBe("string");
      expect(text, `${type} must render ${key}`).toContain(EN[key]);
      expect(text, `${type} fell through to the raw event type`).not.toContain(type);
      checked++;
    }
    expect(checked).toBe(2);
    // A barrier is not undoable (the engine skips it); the row says so.
    expect(text).toContain(EN["history.notUndoable"]);
  });

  it("each label exists, translated, in all four dictionaries, and stays on this panel", () => {
    const OFFSITE = /\b(board|tab)\b|tablero|tableau|\bbord\b|pesta[ñn]a|onglet|tabblad/i;
    let checked = 0;
    for (const [, key] of SWISS_EVENT_KEYS) {
      for (const [locale, dict] of Object.entries(DICTS)) {
        const value = dict[key];
        expect(typeof value === "string" && value.trim() !== "", `${locale}/${key} is missing`).toBe(true);
        if (locale !== "en") expect(value, `${locale}/${key} copies the English`).not.toBe(EN[key]);
        expect(value, `${locale}/${key} points off this panel`).not.toMatch(OFFSITE);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: (key, locale) pairs").toBe(8);
  });

  it("keeps neither label as an English literal in the component source", () => {
    const src = readFileSync(join(process.cwd(), "src/components/v2/history-panel.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    for (const [, key] of SWISS_EVENT_KEYS) expect(src, `${key}'s English is hardcoded`).not.toContain(EN[key]);
  });
});

describe("HistoryPanel — a Swiss refusal of Undo, Redo or Restore is said in the reader's language", () => {
  /** Press `control` and have the server refuse with `code`, carrying a server sentence unlike the dictionary's. */
  async function refuse(control: "history-undo" | "history-redo" | "checkpoint-restore", code: string) {
    const ctx = await mount([
      { seq: 1, type: "fixtures_generated", undoable: true, undone: false, created_at: "2026-10-31T10:00:00.000Z" },
    ]);
    const SERVER = `server says ${code} in English`;
    apiV1.mockImplementation(async (path: string) => {
      // The status the server answers with for a table code (the table's own), never one typed in for all of them; a
      // code outside the table (the look-alike case below) has no row, so it answers a plain 409.
      const status = Object.hasOwn(SWISS_REFUSALS, code) ? SWISS_REFUSALS[code as SwissRefusalCode].status : 409;
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

  it("Undo: each step refusal paints its own dictionary sentence, never the server's", async () => {
    let checked = 0;
    for (const code of STEP_REFUSALS) {
      const LOCAL = EN[SWISS_REFUSALS[code].key];
      expect(typeof LOCAL, `${code}: en/ui.json has its sentence`).toBe("string");
      const { shown, SERVER } = await refuse("history-undo", code);
      expect(shown, `${code}: the refusal is not said locally`).toBe(LOCAL);
      expect(shown).not.toBe(SERVER);
      checked++;
    }
    expect(checked, "anti-vacuity: refusals driven").toBe(STEP_REFUSALS.length);
  });

  it("Redo and Restore go through the same branch", async () => {
    const redo = await refuse("history-redo", "SWISS_LATE_ENTRY_NOT_UNDOABLE");
    expect(redo.shown).toBe(EN["swiss.refusal.SWISS_LATE_ENTRY_NOT_UNDOABLE"]);
    const restore = await refuse("checkpoint-restore", "SWISS_LATE_ENTRY_NOT_UNDOABLE");
    expect(restore.shown).toBe(EN["swiss.refusal.SWISS_LATE_ENTRY_NOT_UNDOABLE"]);
  });

  it("a code that only LOOKS Swiss still surfaces the server's own message", async () => {
    // The negative pair: the branch keys on the refusal table, not on a prefix.
    const { shown, SERVER } = await refuse("history-undo", "SWISS_SOMETHING_NEW");
    expect(shown).toBe(SERVER);
  });
});
