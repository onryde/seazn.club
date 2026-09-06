// #pins-ui (owner ruling 2026-08-12) — StagesPanel's "Auto-schedule remaining"
// CTA (v3/04 §3 item 3, `autoScheduleStage`) is a SECOND, independent
// propose+apply implementation for POST /stages/{id}/schedule/auto — it does
// not go through the board's `useBoardActions.autoRun` (see
// board/__tests__/auto-run-seq.test.tsx for that one). It had the identical
// defect: the apply never sent `expected_seq`, so a lock toggled mid-solve was
// silently overwritten. Same treatment, same three guarantees:
//
//   1. the apply now carries `expected_seq`, seeded from the `divisionSeq`
//      prop (threaded from the already-fetched `division.seq` in page.tsx —
//      this panel never held the division's watermark before);
//   2. a 409 silently re-solves ONCE against the fresh board and applies THAT
//      proposal with the fresh seq the 409 carries, never the stale one;
//   3. a SECOND 409 is not retried again — it falls through to the panel's
//      ordinary error banner, same as any other unrecognised failure here.
//
// No DOM (vitest `environment: "node"`, no jsdom) — driven through the shared
// hook harness, same pattern as stages-panel-result-strip.test.tsx.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { expandWithHooks, propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";
import { StageRail } from "@/components/v2/desk/stage-rail";

const nav = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: nav.refresh, push: nav.push }) }));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));

const net = vi.hoisted(() => ({
  calls: [] as { url: string; json?: unknown }[],
  autoQueue: [] as Record<string, unknown>[],
  applyQueue: [] as (() => Promise<unknown>)[],
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { method?: string; json?: unknown }) => {
      net.calls.push({ url, json: options?.json });
      if (url.endsWith("/schedule/auto")) {
        const next = net.autoQueue.shift();
        return Promise.resolve(next ?? { assignments: [] });
      }
      if (url.endsWith("/schedule/apply")) {
        const next = net.applyQueue.shift();
        return next ? next() : Promise.resolve({ applied: 1 });
      }
      return Promise.resolve({});
    },
  };
});

import { StagesPanel } from "@/components/v2/stages-panel";
import { ApiV1Error } from "@/lib/client-v1";

const STAGE = {
  id: "s1",
  seq: 0,
  kind: "league",
  name: "League",
  config: {},
  progression: null,
  status: "active",
};
/** UNSCHEDULED, deliberately — the auto-schedule CTA lives in the pinned
 *  unscheduled section (same reasoning as stages-panel-result-strip.test.tsx). */
const FIXTURE = {
  id: "f1",
  stage_id: "s1",
  pool_id: null,
  round_no: 1,
  seq_in_round: 1,
  fixture_no: 1,
  home_entrant_id: "e1",
  away_entrant_id: "e2",
  scheduled_at: null,
  venue: null,
  court_label: null,
  status: "scheduled",
  outcome: null,
};

const baseProps = {
  divisionId: "d1",
  divisionSeq: 5,
  competitionId: "c1",
  orgSlug: "org",
  compSlug: "comp",
  divSlug: "div",
  stages: [STAGE],
  fixtures: [FIXTURE],
  entrantNames: { e1: "Alpha", e2: "Bravo" },
  canEdit: true,
  tz: "UTC",
  orgTz: "UTC",
  canExport: false,
} as unknown as Parameters<typeof StagesPanel>[0];

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Task 4, fix round 1 — the auto-schedule CTA now lives on `<StageRail>`,
 *  which `walk()`'s default `expand` cannot see past (it only recurses an
 *  element's `.props.children`, never invoking a nested function
 *  component's own render — see stage-rail.tsx's own header). Expand
 *  `<StageRail>` the same way `create-org-form.test.tsx`'s `expandRows`
 *  expands the hookless `BillRow`, except `StageRail` calls a real hook
 *  (`useMsg`), so `expandWithHooks` (not a bare `StageRail(propsOf(el))`
 *  call) installs a minimal dispatcher for the duration of the call. */
function expandStageRail(node: ReactNode): ReactElement[] {
  const top = walk(node);
  const rails = top.filter((el) => el.type === StageRail);
  return [
    ...top,
    ...rails.flatMap((el) => walk(expandWithHooks(StageRail, propsOf(el) as unknown as Parameters<typeof StageRail>[0]))),
  ];
}

/** The panel's auto-schedule CTA, by testid — see stages-panel-result-strip
 *  .test.tsx for why (not by shape, not by copy). */
function fireAutoSchedule(tree: ReactElement[]): Promise<void> {
  const cta = tree.find((n) => propsOf(n)["data-testid"] === "stage-auto-schedule");
  if (!cta) throw new Error("the unscheduled section rendered no auto-schedule CTA");
  return Promise.resolve((propsOf(cta).onClick as () => Promise<void> | void)()) as Promise<void>;
}

const solveOk = (fixtureId: string, at: string, court: string) => ({
  assignments: [{ fixture_id: fixtureId, scheduled_at: at, court_label: court }],
});
const applyOk = () => Promise.resolve({ applied: 1 });
const applyConflict = (currentSeq: number) => () =>
  Promise.reject(
    new ApiV1Error("schedule changed since you loaded it", 409, "SEQ_CONFLICT", {
      current_seq: currentSeq,
    }),
  );

const applyBodies = () =>
  net.calls.filter((c) => c.url.endsWith("/schedule/apply")).map((c) => c.json) as Record<
    string,
    unknown
  >[];
const autoCalls = () => net.calls.filter((c) => c.url.endsWith("/schedule/auto"));
/** The exact text `err.message` renders as, via the panel's plain `<p>{error}
 *  </p>` banner (no testid on it) — present iff the failure surfaced. */
const errorNode = (tree: ReactElement[]) =>
  tree.find((n) => propsOf(n).children === "schedule changed since you loaded it");

beforeEach(() => {
  net.calls = [];
  net.autoQueue = [];
  net.applyQueue = [];
  nav.refresh.mockClear();
});

describe("StagesPanel auto-schedule — the apply carries expected_seq", () => {
  it("seeds it from the divisionSeq prop", async () => {
    net.autoQueue = [solveOk("f1", "2026-08-01T09:00:00.000Z", "C1")];
    net.applyQueue = [applyOk];
    const island = renderIsland(StagesPanel, baseProps, expandStageRail);

    await fireAutoSchedule(island.tree());
    await flush();

    expect(applyBodies()).toEqual([expect.objectContaining({ expected_seq: 5 })]);
  });
});

describe("StagesPanel auto-schedule — a 409 re-solves ONCE against the fresh board", () => {
  it("applies the FRESH proposal with the FRESH seq, never the stale one, and stays silent", async () => {
    net.autoQueue = [
      solveOk("f1", "2026-08-01T09:00:00.000Z", "C1"),
      solveOk("f1", "2026-08-01T10:00:00.000Z", "C2"),
    ];
    net.applyQueue = [applyConflict(9), applyOk];
    const island = renderIsland(StagesPanel, baseProps, expandStageRail);

    await fireAutoSchedule(island.tree());
    await flush();

    expect(autoCalls()).toHaveLength(2); // exactly one silent re-solve
    const bodies = applyBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ expected_seq: 5 });
    expect(bodies[1]).toMatchObject({
      expected_seq: 9,
      assignments: [{ fixture_id: "f1", scheduled_at: "2026-08-01T10:00:00.000Z", court_label: "C2" }],
    });
    expect(errorNode(island.tree())).toBeUndefined(); // silent — no error banner
    expect(nav.refresh).toHaveBeenCalled(); // the retry's apply really landed
  });

  it("a SECOND 409 is not retried again — the panel's normal error path takes over", async () => {
    net.autoQueue = [
      solveOk("f1", "2026-08-01T09:00:00.000Z", "C1"),
      solveOk("f1", "2026-08-01T10:00:00.000Z", "C2"),
    ];
    net.applyQueue = [applyConflict(9), applyConflict(15)];
    const island = renderIsland(StagesPanel, baseProps, expandStageRail);

    await fireAutoSchedule(island.tree());
    await flush();

    expect(autoCalls()).toHaveLength(2); // no third solve
    expect(applyBodies()).toHaveLength(2); // no second retry
    expect(errorNode(island.tree())).toBeDefined(); // surfaced normally
    expect(nav.refresh).not.toHaveBeenCalled();
  });
});
