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

// W4 B1b review M11 (controller ruling, fix round 1): Restore is a loop of Undos, so since T5 it stops at a confirmed draw
// (an undo barrier). Its confirm used to promise "Schedule edits made after {name} are undone" — every one, which is now
// false. The body says where it stops. The English sentence is typed here (the ruling's), never read from the panel.
describe("HistoryPanel — Restore's confirm says it stops at a change that can't be undone (M11)", () => {
  const KEY = "confirm.restoreCheckpoint.body";
  const SENTENCE =
    "Schedule edits made after {name} are undone. A change that can't be undone, such as a confirmed draw, stops the restore there. Results are never touched.";
  /** The pre-T5 sentences, which promised every edit back: typed so a locale left on them is caught. */
  const BEFORE: Record<string, string> = {
    en: "Schedule edits made after {name} are undone. Results are never touched.",
    es: "Se deshacen las ediciones del calendario realizadas después de {name}. Los resultados nunca se tocan.",
    fr: "Les modifications du calendrier effectuées après {name} sont annulées. Les résultats ne sont jamais touchés.",
    nl: "Planningswijzigingen na {name} worden ongedaan gemaakt. Resultaten worden nooit gewijzigd.",
  };

  it("the Restore button asks with the ruling's sentence, the save point named", async () => {
    const ctx = await mount([]);
    apiV1.mockImplementation(async (path: string) =>
      path.endsWith("/restore") ? { steps: 0 } : path.endsWith("/history") ? { watermark: null, seq: 1, events: [] } : CHECKPOINTS,
    );
    confirmAsked.length = 0;
    const button = ctx.byTestid("checkpoint-restore")[0];
    expect(button, "checkpoint-restore is on the panel").toBeDefined();
    await (propsOf(button!).onClick as () => unknown)();
    await ctx.settle();
    expect(confirmAsked.length, "anti-vacuity: the confirm was asked once").toBe(1);
    expect(confirmAsked[0]!.body).toBe(SENTENCE.replace("{name}", CHECKPOINTS[0]!.label));
  });

  it("every locale says where it stops: translated, the save point kept, none left on the old promise", () => {
    expect(EN[KEY], "en is the ruling's sentence").toBe(SENTENCE);
    let checked = 0;
    for (const [locale, dict] of Object.entries(DICTS)) {
      const value = dict[KEY]!;
      expect(value, `${locale}: names the save point`).toContain("{name}");
      expect(value, `${locale}: still promises every edit back`).not.toBe(BEFORE[locale]);
      if (locale !== "en") expect(value, `${locale} copies the English`).not.toBe(SENTENCE);
      checked++;
    }
    expect(checked, "anti-vacuity: four locales").toBe(4);
  });
});
