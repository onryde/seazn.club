// Regression: the checkpoint list (the "Save points" panel) rendered nearly
// illegible for any viewer with OS dark mode on — stray `dark:*` Tailwind
// classes fired (this app has NO dark-mode support anywhere else; `dark:`
// here is the unconfigured, automatic `prefers-color-scheme` variant, not an
// opt-in class toggle), swapping labels/timestamps to colors meant for a
// dark background while the card itself stayed white. The baseline
// light-mode colors (`text-slate-400`/`text-slate-500` at 10-12.5px) were
// ALSO already below WCAG AA on their own — the same class of bug already
// fixed once in this codebase (Move panel's hint text, board-view-redesign
// 2026-08-10).
//
// Same harness as history-panel-eviction-notice.test.tsx: a static render
// can't reach the checkpoint list — it loads via an effect on mount.
import { describe, expect, it, vi } from "vitest";
import { renderIsland, propsOf, textOf } from "@/components/__tests__/_hook-harness";
import type { ReactElement } from "react";

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

interface PanelProps {
  divisionId: string;
  scheduleLocked: boolean;
  canEdit: boolean;
}
type Island = ReturnType<typeof renderIsland<PanelProps>>;

async function renderWithCheckpoints(checkpoints: unknown[]): Promise<Island> {
  apiV1.mockReset();
  apiV1.mockImplementation(async (path: string) => {
    if (path.endsWith("/history")) return { watermark: 1, seq: 1, events: [] };
    return checkpoints;
  });
  const island = renderIsland<PanelProps>((props: PanelProps) => HistoryPanel(props), {
    divisionId: "d1",
    scheduleLocked: false,
    canEdit: true,
  });
  // The mount-time `load()` effect defers via `setTimeout(0)` and awaits two
  // fetches — two ticks lets both settle, same margin the eviction-notice
  // suite already uses for its own post-submit reload.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  return island;
}

const findByText = (island: Island, text: string): ReactElement | undefined =>
  island.tree().find((el: ReactElement) => textOf(propsOf(el).children) === text);

describe("HistoryPanel — save-point list stays legible (contrast regression)", () => {
  it("carries no dark: utility anywhere in the panel", async () => {
    const island = await renderWithCheckpoints([
      { id: "c1", seq: 1, label: "asdasd", kind: "manual", created_at: "2026-07-29T21:24:28.000Z" },
    ]);
    const classNames = island
      .tree()
      .map((el) => String(propsOf(el).className ?? ""))
      .join(" ");
    expect(classNames).not.toMatch(/dark:/);
  });

  it("a superseded save point's label stays readable at slate-600 — the strikethrough carries 'inactive', not an illegible color", async () => {
    const island = await renderWithCheckpoints([
      {
        id: "c1",
        seq: 1,
        label: "old one",
        kind: "ai",
        superseded: true,
        created_at: "2026-08-06T23:56:59.000Z",
      },
      {
        id: "c2",
        seq: 2,
        label: "Before AI",
        kind: "ai",
        superseded: false,
        created_at: "2026-08-06T23:56:59.000Z",
      },
    ]);
    const label = findByText(island, "old one");
    expect(label).toBeTruthy();
    expect(String(propsOf(label!).className)).toContain("slate-600");
    expect(String(propsOf(label!).className)).not.toContain("slate-400");
  });

  it("the group heading and count ('Yours', '1 used') use slate-600, not the too-faint slate-400/500", async () => {
    const island = await renderWithCheckpoints([
      { id: "c1", seq: 1, label: "asdasd", kind: "manual", created_at: "2026-07-29T21:24:28.000Z" },
    ]);
    const heading = findByText(island, "Yours");
    const count = findByText(island, "1 used");
    expect(heading).toBeTruthy();
    expect(count).toBeTruthy();
    expect(String(propsOf(heading!).className)).toContain("slate-600");
    expect(String(propsOf(count!).className)).toContain("slate-600");
  });
});
