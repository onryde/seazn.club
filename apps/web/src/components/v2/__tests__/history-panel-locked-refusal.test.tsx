// Two gaps this panel had around the schedule freeze, both reachable without a
// race:
//
// 1. The generic `catch` in `run()` painted `err.message` onto the card. Every
//    server refusal in this console is English prose, so a Spanish organiser
//    whose frozen division refused an undo read a translated panel with an
//    English sentence in the middle of it. The refusal is machine-readable
//    (`SCHEDULE_LOCKED_CODE` on the /api/v1 envelope), so the client can say it
//    in the reader's own words — branching on the CODE, never on the sentence,
//    which would break the moment the sentence is reworded.
//
// 2. Delete beside Restore ON THE SAME ROW was `disabled={busy}` while Restore
//    was `disabled={busy || scheduleLocked}`. `deleteCheckpoint` now refuses a
//    frozen division with a live 422, so the frozen panel offered an enabled
//    button that could only fail — and Delete is the IRREVERSIBLE half of that
//    row: it destroys the rewind the freeze exists to protect.
//
// The rows only exist after the mount fetch, so this drives the real island
// through the hook harness rather than `renderToStaticMarkup` (a static render
// of this panel has no checkpoints and therefore no buttons at all). The
// harness has no provider tree, so `useMsg` falls back to the English catalog —
// the production path for an English organiser, and why the "is this really
// from the dictionary" half lives in schedule-lock-refusal-copy.test.ts against
// the four dictionaries and the component SOURCE.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { SCHEDULE_LOCKED_CODE, SCHEDULE_LOCKED_MESSAGE } from "@/lib/schedule-lock";
import enUi from "@/dictionaries/en/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
// Confirmed by default: the two guarded controls this file drives are behind a
// dialog, and the thing under test is what happens AFTER the organiser says yes.
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => true),
}));

const apiV1 = vi.fn();
// `importOriginal`, not a stub class: the panel branches on
// `err instanceof ApiV1Error && err.code === …`, and a hand-rolled
// `class extends Error {}` carries no `code` at all — the branch would be
// unreachable and the test would pass on the fallback for the wrong reason.
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return { ...actual, apiV1: (...args: unknown[]) => apiV1(...args) };
});

const { ApiV1Error } = await import("@/lib/client-v1");
const { HistoryPanel } = await import("../history-panel");

const EN = enUi as unknown as Record<string, string>;

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
    label: "Before AI",
    kind: "ai" as const,
    created_at: "2026-09-03T11:00:00.000Z",
  },
];

interface PanelProps {
  divisionId: string;
  scheduleLocked: boolean;
  canEdit: boolean;
}

/** Mount the real island and let both mount fetches settle. `canEdit` is held
 *  TRUE throughout: at the mount site it is `canEdit && !billingFrozen`, the
 *  ORG's billing freeze, a different thing with a confusingly similar name.
 *  Only `scheduleLocked` varies. */
async function mount(scheduleLocked: boolean, rows = CHECKPOINTS) {
  apiV1.mockReset();
  apiV1.mockImplementation(async (path: string) =>
    path.endsWith("/history") ? { watermark: 1, seq: 2, events: [] } : rows,
  );
  const island = renderIsland<PanelProps>((props: PanelProps) => HistoryPanel(props), {
    divisionId: "d1",
    scheduleLocked,
    canEdit: true,
  });
  const settle = async () => {
    // The mount effect defers via setTimeout(0) and awaits two fetches — two
    // ticks lets both settle, the same margin the sibling suites use.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };
  await settle();
  const byTestid = (id: string): ReactElement[] =>
    island.tree().filter((el: ReactElement) => propsOf(el)["data-testid"] === id);
  return { island, byTestid, settle };
}

describe("HistoryPanel — a frozen schedule refuses Delete too, not only Restore", () => {
  it("disables Delete on a frozen division, exactly as Restore beside it is", async () => {
    const { byTestid } = await mount(true);
    const deletes = byTestid("checkpoint-delete");
    // Delete is offered on MANUAL save points only — an AI anchor costs no
    // quota and the next apply makes a new one.
    expect(deletes, "the manual save point has no Delete at all").toHaveLength(1);
    expect(propsOf(deletes[0]!).disabled, "a frozen division still offers Delete").toBe(true);
    // The row's own Restore is the reference: the two must not disagree about
    // whether this row is editable.
    for (const r of byTestid("checkpoint-restore")) expect(propsOf(r).disabled).toBe(true);
  });

  it("leaves Delete live when the schedule is not frozen", async () => {
    const { byTestid } = await mount(false);
    const deletes = byTestid("checkpoint-delete");
    expect(deletes).toHaveLength(1);
    expect(propsOf(deletes[0]!).disabled).toBe(false);
  });

  it("makes the disabled Delete LOOK disabled — it is a bare text button, not a .btn", async () => {
    // `.btn` carries `disabled:cursor-not-allowed disabled:opacity-50`
    // (globals.css); this control inherits none of it. And `:hover` still
    // matches a DISABLED button, so a bare `hover:text-rose-600` keeps painting
    // the destructive affordance on a control that does nothing. Same reasoning
    // the Restore beside it already documents.
    const { byTestid } = await mount(true);
    const className = String(propsOf(byTestid("checkpoint-delete")[0]!).className ?? "");
    expect(className, "no disabled cursor").toContain("disabled:cursor-not-allowed");
    expect(className, "a disabled control at full strength").toContain("disabled:opacity-50");
    expect(className, "the hover colour is not gated on enabled").not.toMatch(
      /(^|\s)hover:text-rose-600/,
    );
  });

  it("says why, naming BOTH refused actions when a manual save point is on the list", async () => {
    const { byTestid } = await mount(true);
    const reasons = byTestid("checkpoint-restore-reason");
    expect(reasons, "the frozen list states no reason").toHaveLength(1);
    expect(propsOf(reasons[0]!).children).toBe(EN["history.checkpoint.frozenDelete"]);
  });

  it("does not promise Delete on a list that has no manual save point to delete", async () => {
    // Unfreezing would not put a Delete on an AI anchor — the button is not
    // offered there at all — so naming it would be a sentence about a control
    // that cannot appear.
    const { byTestid } = await mount(true, [CHECKPOINTS[1]!]);
    expect(byTestid("checkpoint-delete"), "an AI anchor grew a Delete").toHaveLength(0);
    expect(propsOf(byTestid("checkpoint-restore-reason")[0]!).children).toBe(
      EN["history.checkpoint.frozen"],
    );
  });

  it("keeps the control visible rather than removing it", async () => {
    // A vanished button reads as a missing feature; a disabled one teaches that
    // unfreezing is the way back. Both states render the row AND the button.
    expect((await mount(true)).byTestid("checkpoint-delete")).toHaveLength(1);
    expect((await mount(false)).byTestid("checkpoint-delete")).toHaveLength(1);
  });
});

describe("HistoryPanel — a refused write says so in the reader's language", () => {
  /** Mount UNFROZEN and let the server refuse: that is the reachable state the
   *  disabled buttons cannot cover — a second tab, or a second organiser,
   *  freezing the division after this page rendered. The prop is stale, the
   *  control is live, and the 422 is the only thing that says no. */
  async function refuse(error: unknown) {
    const ctx = await mount(false);
    apiV1.mockImplementation(async (path: string) => {
      if (path.endsWith("/undo")) throw error;
      return path.endsWith("/history") ? { watermark: 1, seq: 2, events: [] } : CHECKPOINTS;
    });
    const undo = ctx.byTestid("history-undo")[0]!;
    expect(propsOf(undo).disabled, "the stale prop must leave the control live").toBe(false);
    (propsOf(undo).onClick as () => void)();
    await ctx.settle();
    const banner = ctx.byTestid("history-error");
    return banner.length === 0 ? null : String(propsOf(banner[0]!).children);
  }

  it("renders a LOCAL sentence for the freeze refusal, not the server's English", async () => {
    const LOCAL = EN["history.error.frozen"]!;
    // The expected value must exist before its presence — or the server
    // sentence's absence — means anything.
    expect(typeof LOCAL, "history.error.frozen is missing from en/ui.json").toBe("string");

    const shown = await refuse(
      new ApiV1Error(SCHEDULE_LOCKED_MESSAGE, 422, SCHEDULE_LOCKED_CODE),
    );
    expect(shown, "the refusal is not said in the reader's language").toBe(LOCAL);
    expect(shown, "the server's English sentence reached the card").not.toContain(
      SCHEDULE_LOCKED_MESSAGE,
    );
  });

  it("still surfaces an unrecognised failure's own message", async () => {
    // Deliberately NOT blanket-suppressed. An unknown failure the organiser
    // cannot quote is worse than an untranslated one they can: the message is
    // the only diagnostic that reaches them, and every refusal this client DOES
    // recognise now has its own sentence.
    expect(await refuse(new ApiV1Error("division is mid-solve", 409, "BUSY"))).toBe(
      "division is mid-solve",
    );
    expect(await refuse(new Error("network down"))).toBe("network down");
  });

  // The refusal in the branch IMMEDIATELY ABOVE the freeze one, missed by the
  // pass that added it: `SEQ_CONFLICT` already branched on the code and then
  // painted a hardcoded English literal, so a Spanish organiser who lost a race
  // to a second tab read the same English line in the same translated panel.
  //
  // What this case can and cannot see: the harness has NO provider tree, so
  // `useMsg` falls back to the English catalog and a hardcoded literal renders
  // identically to a dictionary read. It pins that the branch FIRES and that
  // the server's own message does not reach the banner. That the sentence
  // comes from the dictionary at all is pinned by the source scan in
  // schedule-lock-refusal-copy.test.ts, which is the only guard that can tell
  // the two apart — and it is red on this file until the literal is gone.
  it("says the concurrent-edit refusal in the reader's language too", async () => {
    const LOCAL = EN["history.error.seqConflict"]!;
    expect(typeof LOCAL, "history.error.seqConflict is missing from en/ui.json").toBe("string");

    const shown = await refuse(new ApiV1Error("stale seq 7 != 9", 409, "SEQ_CONFLICT"));
    // NOT a proof that the sentence came from the dictionary: with no provider
    // tree, `msg(...)` and the old hardcoded literal produce the SAME string
    // here. This asserts the branch fires and says the right words. The source
    // scan named above is what proves where the words came from.
    expect(shown, "the SEQ_CONFLICT branch does not reach the banner").toBe(LOCAL);
    expect(
      shown,
      "the server's diagnostic reached the organiser instead of the recognised sentence",
    ).not.toContain("stale seq");
  });

  it("shows no banner at all when the write succeeds", async () => {
    // The negative half: a banner that renders unconditionally would satisfy
    // every assertion above without the branch existing.
    const ctx = await mount(false);
    apiV1.mockImplementation(async (path: string) =>
      path.endsWith("/history") ? { watermark: 1, seq: 2, events: [] } : CHECKPOINTS,
    );
    (propsOf(ctx.byTestid("history-undo")[0]!).onClick as () => void)();
    await ctx.settle();
    expect(ctx.byTestid("history-error")).toHaveLength(0);
  });
});
