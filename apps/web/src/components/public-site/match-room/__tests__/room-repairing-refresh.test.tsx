// Final re-review 4, I2: the room page loaded inside a re-pair gap renders the re-pair card headerless with
// RepairingRefresh, which re-asks the SERVER page (router.refresh) at the room's own idle cadence — the copy says the
// page "updates by itself", so it must. It stops when the page stops rendering it: the board paired again (the room)
// or the room's 404 (card 7). Driven through the shared hook harness: its effect is real, the router is the seam.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIsland } from "@/components/__tests__/_hook-harness";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { RepairingRefresh } from "../room-repairing-refresh";
import { IDLE_POLL_MS } from "../use-room";

beforeEach(() => {
  vi.useFakeTimers();
  router.refresh.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("I2: the re-pair card's page re-asker", () => {
  it("the empty case: nothing is asked on mount, nor before one idle poll has passed", async () => {
    const island = renderIsland(RepairingRefresh, {});
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS - 1);
    expect(router.refresh).not.toHaveBeenCalled();
    island.unmount();
  });

  it("re-asks the page once per idle poll, read after read, for as long as the gap lasts — and never after it is gone (the page rendered the room or card 7)", async () => {
    const island = renderIsland(RepairingRefresh, {});
    for (let n = 1; n <= 4; n += 1) {
      await vi.advanceTimersByTimeAsync(IDLE_POLL_MS);
      expect(router.refresh, `poll ${n}`).toHaveBeenCalledTimes(n);
    }
    island.unmount();
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS * 3);
    expect(router.refresh, "unmounted: no more").toHaveBeenCalledTimes(4);
  });
});
