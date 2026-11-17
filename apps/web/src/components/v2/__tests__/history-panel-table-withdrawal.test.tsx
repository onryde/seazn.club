// W5 T8 (RB5-W7; Task 8b): a league or group withdrawal and its Reinstate each appear in "Recent edits" as ONE line, in the
// reader's language — never as the raw ledger type. (Their per-line write-ahead rows never reach the panel: the server leaves
// them out, table-expunge.test.ts.) Harness: history-panel-roundrobin-late-entry.test.tsx's.
import { describe, expect, it, vi } from "vitest";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
// The confirm dialog answers yes (nothing here confirms; the panel mounts the hook).
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => async () => true }));
const apiV1 = vi.fn();
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return { ...actual, apiV1: (...args: unknown[]) => apiV1(...args) };
});

const { HistoryPanel } = await import("../history-panel");

const EN = en as unknown as Record<string, string>;
const DICTS = { en, es, fr, nl } as unknown as Record<string, Record<string, string>>;

/** The ledger types and the keys that say them — typed here, never read from the panel. */
const ROWS = [
  { type: "table_withdrawal", key: "history.event.tableWithdrawal", en: "Withdrawal applied to the table" },
  { type: "table_withdrawal_voided", key: "history.event.tableWithdrawalReversed", en: "Withdrawal reversed in the table" },
] as const;

interface PanelProps {
  divisionId: string;
  scheduleLocked: boolean;
  canEdit: boolean;
  viewerPlan: "community";
}

async function mount(events: unknown[]) {
  apiV1.mockReset();
  apiV1.mockImplementation(async (path: string) =>
    path.endsWith("/history") ? { watermark: null, seq: events.length + 1, events } : [],
  );
  const island = renderIsland<PanelProps>((props: PanelProps) => HistoryPanel(props), {
    divisionId: "d1",
    scheduleLocked: false,
    canEdit: true,
    viewerPlan: "community",
  });
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  return island;
}

describe("HistoryPanel — a table withdrawal and its Reinstate are named in the reader's language", () => {
  it("renders each through the dictionary, never the raw ledger type, as not undoable", async () => {
    const events = ROWS.map((r, i) => ({ seq: 10 - i, type: r.type, undoable: false, undone: false, created_at: "2026-11-17T10:00:00.000Z" }));
    const text = (await mount(events)).text();
    let checked = 0;
    for (const r of ROWS) {
      expect(EN[r.key], `${r.key} is the label`).toBe(r.en);
      expect(text, `${r.type} must render ${r.key}`).toContain(r.en);
      checked++;
    }
    expect(text, "a raw ledger type fell through").not.toMatch(/table_withdrawal/);
    expect(text).toContain(EN["history.notUndoable"]);
    expect(checked, "anti-vacuity: rows").toBe(2);
  });

  it("both labels exist, translated, in all four dictionaries", () => {
    let checked = 0;
    for (const { key } of ROWS) {
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
