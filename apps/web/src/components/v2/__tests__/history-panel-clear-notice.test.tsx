// A schedule clear says what it left in place (review 2 of #857, M4).
//
// `clearScheduleScoped` (usecases/history.ts) never clears a match that has
// started or finished, and answers `{ cleared, skipped: { locked, decided } }`
// — where `decided` counts every PLAYED fixture it skipped (in play, decided,
// finalized; `@/lib/played-fixture-statuses`). The panel threw that answer
// away, so an organiser who cleared a board mid-event saw live matches keep
// their slots with nothing to say why, under a danger-zone sentence that named
// only locked and decided ones. The notice only exists AFTER a click, so this
// drives the real island — state, effects, the English catalog — through the
// shared hook harness, as the restore notice's test does.
import { describe, expect, it, vi } from "vitest";
import { renderIsland, propsOf, textOf } from "@/components/__tests__/_hook-harness";
import type { ReactElement } from "react";
import { msgFor } from "@/lib/messages-i18n";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
// Confirmed, not cancelled — the path under test is the one past the dialog.
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

/** The panel's mount reads plus whatever `POST /schedule/clear` answers with;
 *  a save point to restore, for the test that takes a second action. */
function stubApi(clearReturns: unknown) {
  apiV1.mockReset();
  apiV1.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (init?.method === "POST" && path === "/api/v1/schedule/clear") return clearReturns;
    if (init?.method === "POST") return { watermark: 3, steps: 1 };
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

async function clickClear(island: Island) {
  const button = island
    .tree()
    .find((el: ReactElement) => el.type === "button" && propsOf(el)["data-testid"] === "schedule-clear");
  expect(button, "the danger zone renders the clear control").toBeTruthy();
  await (propsOf(button!).onClick as () => Promise<void>)();
  await settle();
}

const kept = (island: Island) =>
  island.tree().find((el: ReactElement) => propsOf(el)["data-testid"] === "schedule-clear-kept");

describe("clearing the schedule says what it left in place", () => {
  it("counts the matches in play or finished it kept — the locked ones are the danger zone's own sentence", async () => {
    stubApi({ cleared: 3, skipped: { locked: 4, decided: 2 }, seq: 5 });
    const island = render();
    await settle();

    await clickClear(island);

    expect(textOf(kept(island))).toBe("2 matches in play or finished were left in place.");
  });

  it("uses the singular for one", async () => {
    stubApi({ cleared: 3, skipped: { locked: 0, decided: 1 }, seq: 5 });
    const island = render();
    await settle();

    await clickClear(island);

    expect(textOf(kept(island))).toBe("1 match in play or finished was left in place.");
  });

  it("says nothing when it kept none — and the clear still went through", async () => {
    stubApi({ cleared: 3, skipped: { locked: 2, decided: 0 }, seq: 5 });
    const island = render();
    await settle();

    await clickClear(island);

    expect(apiV1).toHaveBeenCalledWith("/api/v1/schedule/clear", expect.objectContaining({ method: "POST" }));
    expect(kept(island)).toBeUndefined();
  });

  it("the next action takes the notice away — it belongs to the clear, not to the page", async () => {
    stubApi({ cleared: 3, skipped: { locked: 0, decided: 2 }, seq: 5 });
    const island = render();
    await settle();
    await clickClear(island);
    expect(kept(island)).toBeTruthy();

    const restore = island
      .tree()
      .find((el: ReactElement) => el.type === "button" && propsOf(el).children === "Restore");
    await (propsOf(restore!).onClick as () => Promise<void>)();
    await settle();

    expect(textOf(island.tree())).toContain("Restored — undid 1 change.");
    expect(kept(island)).toBeUndefined();
  });

  it("the danger zone names in-play and finished matches alongside locked ones, in every locale", () => {
    for (const locale of ["en", "es", "fr", "nl"] as const) {
      expect(msgFor(locale, "history.danger.body"), locale).not.toMatch(/\bdecided\b|decididos|décidées|besliste/);
    }
    expect(msgFor("en", "history.danger.body")).toBe(
      "Clears timetable slots only — locked fixtures and matches in play or finished always stay, and the action is undoable above.",
    );
    const island = render();
    expect(textOf(island.tree())).toContain(msgFor("en", "history.danger.body"));
  });
});
