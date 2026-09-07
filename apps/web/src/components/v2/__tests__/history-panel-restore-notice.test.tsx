// Restore says what it did — including when it did nothing.
//
// `restoreCheckpoint` (usecases/history.ts) returns `{ watermark, steps }` and
// short-circuits to `steps: 0` whenever the division's watermark is already at
// or before the checkpoint's — a legitimate outcome (the commonest way to reach
// it is an AI apply that FAILED, leaving the "Before AI" anchor equal to the
// live board), and until now an entirely silent one: HTTP 200, a reload, and a
// board that looks identical. The organiser cannot tell that from a restore
// that did not work, which is exactly how it was reported.
//
// Nothing server-side needs to change for that; what was missing is the
// sentence. This drives the real island — state, effects, the English catalog —
// through the shared hook harness, because the notice only exists AFTER a click.
import { describe, expect, it, vi } from "vitest";
import { renderIsland, propsOf, textOf } from "@/components/__tests__/_hook-harness";
import type { ReactElement } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
// Confirmed, not cancelled — the restore path under test is the one past the
// dialog.
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => true),
}));

const apiV1 = vi.fn();
vi.mock("@/lib/client-v1", () => ({
  apiV1: (...args: unknown[]) => apiV1(...args),
  ApiV1Error: class extends Error {},
}));

const { HistoryPanel } = await import("../history-panel");

const CHECKPOINT = {
  id: "cp1",
  seq: 3,
  label: "Before AI",
  kind: "ai" as const,
  created_at: "2026-08-25T22:51:00.000Z",
};

/** The panel's mount reads plus whatever `POST /restore` answers with. */
function stubApi(restoreReturns: unknown) {
  apiV1.mockReset();
  apiV1.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (init?.method === "POST") return restoreReturns;
    if (path.endsWith("/history")) return { watermark: 4, seq: 4, events: [] };
    return [CHECKPOINT];
  });
}

interface PanelProps {
  divisionId: string;
  scheduleLocked: boolean;
  canEdit: boolean;
  viewerPlan: "community";
}
type Island = ReturnType<typeof renderIsland<PanelProps>>;

const render = (): Island =>
  renderIsland<PanelProps>((props: PanelProps) => HistoryPanel(props), {
    divisionId: "d1",
    scheduleLocked: false,
    canEdit: true,
    viewerPlan: "community",
  });

const settle = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
};

/** Click the checkpoint row's Restore action and let the reload drain. */
async function clickRestore(island: Island) {
  const button = island
    .tree()
    .find(
      (el: ReactElement) =>
        el.type === "button" && propsOf(el).children === "Restore",
    );
  expect(button, "the checkpoint row renders a Restore button").toBeTruthy();
  await (propsOf(button!).onClick as () => Promise<void>)();
  await settle();
}

describe("restoring a save point reports what it did", () => {
  it("says so when the board was already at that save point", async () => {
    stubApi({ watermark: 3, steps: 0 });
    const island = render();
    await settle();

    await clickRestore(island);

    expect(textOf(island.tree())).toContain(
      "Nothing to undo — the board is already at this save point.",
    );
  });

  it("counts the changes it undid", async () => {
    stubApi({ watermark: 3, steps: 2 });
    const island = render();
    await settle();

    await clickRestore(island);

    // Plural, through the real catalog: the singular is a different sentence
    // and a hard-coded "changes" would read wrong on the commonest restore.
    expect(textOf(island.tree())).toContain("Restored — undid 2 changes.");
  });

  it("uses the singular for a one-step restore", async () => {
    stubApi({ watermark: 3, steps: 1 });
    const island = render();
    await settle();

    await clickRestore(island);

    expect(textOf(island.tree())).toContain("Restored — undid 1 change.");
  });
});
