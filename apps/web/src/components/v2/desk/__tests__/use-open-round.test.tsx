// Task 4 (arbiter round column) - the Open / Resend / "+5" press as a hook, driven through the REAL reducer and runner
// (open-round-state.ts) with the network doubled at `apiV1`. open-round-control-actions.test.tsx already proves each press
// through the control for one round; this file proves what the hook adds and the control could never show: the EMPTY case
// (a null view is a handle that does nothing), a redraw of the same round with a new number (the press follows it, the runner
// does not restart, so a double tap across the redraw still sends one request), and a round that goes away.
// No DOM in this workspace: the hook harness renders a probe that hands the handle out as a prop.
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import type { OpenRoundView } from "@/lib/open-round";
import { emptyExtendTally } from "@/lib/checkin-extend";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

type Call = { url: string; json?: unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void };
const net = vi.hoisted(() => ({ calls: [] as Call[] }));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { json?: unknown }) =>
      new Promise((resolve, reject) => net.calls.push({ url, json: options?.json, resolve, reject })),
  };
});

import { initialOpenRoundUi } from "../open-round-state";
import { useOpenRound, type OpenRoundHandle } from "../use-open-round";

/** The probe hands the whole handle out as a prop, so a test reads and calls exactly what a second caller would. */
function Probe({ view }: { view: OpenRoundView | null }) {
  return createElement("probe", { handle: useOpenRound(view) });
}
const mount = (view: OpenRoundView | null) => {
  const ui = renderIsland(Probe, { view });
  const handle = () => propsOf(ui.tree()[0]!).handle as OpenRoundHandle;
  return { ui, handle };
};
const flush = () => new Promise((r) => setTimeout(r, 0));

// A stage and round number nothing else in the repo uses, so a press that read the wrong field cannot land on the right URL.
const VIEW = (o: Partial<OpenRoundView> = {}): OpenRoundView => ({
  stageId: "stage-Z",
  stageName: "Swiss",
  roundNo: 7,
  state: "paired",
  openedAt: null,
  deadlineAt: null,
  windowMinutes: 10,
  staggered: false,
  batches: [],
  staggerSpanMinutes: 0,
  scheduledAt: null,
  press: "open",
  earlierInPlay: [],
  pairings: [],
  extendableBoards: 0,
  extendWindows: [],
  extendRefusals: emptyExtendTally(),
  ...o,
});

beforeEach(() => {
  net.calls.length = 0;
  router.refresh.mockReset();
});

describe("useOpenRound - the empty case first", () => {
  it("a null view is the initial state and five presses that do nothing: no state change, no request, no refresh", async () => {
    const { handle } = mount(null);
    expect(handle().state).toEqual(initialOpenRoundUi());
    const presses: [string, (h: OpenRoundHandle) => void][] = [
      ["ask", (h) => h.ask()],
      ["cancel", (h) => h.cancel()],
      ["open", (h) => h.open()],
      ["resend", (h) => h.resend("fx-9")],
      ["extend", (h) => h.extend()],
    ];
    for (const [name, press] of presses) {
      press(handle());
      await flush();
      expect(handle().state, `${name} on a null view leaves the state alone`).toEqual(initialOpenRoundUi());
    }
    expect(presses, "five presses were tried").toHaveLength(5);
    expect(net.calls, "nothing reached the network").toHaveLength(0);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("its pair: the same ask() on a real round DOES change the state (so the test above is not vacuous)", () => {
    const { handle } = mount(VIEW());
    expect(handle().state).toEqual(initialOpenRoundUi());
    handle().ask();
    expect(handle().state.confirming).toBe(true);
    handle().cancel();
    expect(handle().state.confirming).toBe(false);
    expect(net.calls).toHaveLength(0);
  });

  it("a round that goes away reports the initial state again, and its presses stop doing anything", async () => {
    const { ui, handle } = mount(VIEW());
    handle().ask();
    expect(handle().state.confirming).toBe(true);
    ui.rerender({ view: null });
    expect(handle().state).toEqual(initialOpenRoundUi());
    handle().open();
    handle().extend();
    await flush();
    expect(net.calls).toHaveLength(0);
  });
});

describe("useOpenRound - the presses follow THIS round", () => {
  it("open, resend and extend each send for the view's own stage and round number, one request at a time", async () => {
    const { handle } = mount(VIEW({ stageId: "stage-Z", roundNo: 7 }));
    handle().ask();
    handle().open();
    expect(net.calls.map((c) => [c.url, c.json])).toEqual([["/api/v1/stages/stage-Z/open-round", { roundNo: 7 }]]);
    net.calls[0]!.resolve({ opened: true, invited: 0, retrying: 0, skipped: [] });
    await flush();
    handle().resend("fx-9");
    expect(net.calls[1]!.url).toBe("/api/v1/fixtures/fx-9/external-play/resend");
    net.calls[1]!.resolve({ emailed: 1, retrying: 0 });
    await flush();
    handle().extend();
    expect(net.calls.slice(2).map((c) => [c.url, c.json])).toEqual([["/api/v1/stages/stage-Z/extend-checkin", { roundNo: 7 }]]);
    net.calls[2]!.resolve({ extended: 1, skipped: [] });
    await flush();
    expect(net.calls, "exactly the three presses went out").toHaveLength(3);
    expect(router.refresh, "each answer refreshed the page once").toHaveBeenCalledTimes(3);
  });

  it("a redraw with another round number retargets the press, and the runner survives it: a double tap across the redraw sends ONE request", async () => {
    const { ui, handle } = mount(VIEW({ roundNo: 7 }));
    handle().ask();
    handle().open();
    expect(net.calls).toHaveLength(1);
    ui.rerender({ view: VIEW({ roundNo: 8 }) });
    handle().open();
    expect(net.calls, "the first is still in flight; the redraw did not hand out a second runner").toHaveLength(1);
    net.calls[0]!.resolve({ opened: true, invited: 0, retrying: 0, skipped: [] });
    await flush();
    handle().ask();
    handle().open();
    expect(net.calls.map((c) => c.json)).toEqual([{ roundNo: 7 }, { roundNo: 8 }]);
  });
});
