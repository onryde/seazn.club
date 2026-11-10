// W4 B5b review I-1: the console's `live` is `useState(initialState)`, which `router.refresh()` never re-seeds, so a
// ruling must ALSO call the console's `resync()` (`onChanged`). apps/web vitest is node-env, so the hook wiring itself is
// proven by e2e/bracket-finish.spec.ts X-CH-4 (Undo on a page loaded declared, offer comes back); this pins the sequence
// the two blocks share: write, THEN resync, THEN refresh; a refused write runs neither.
import { describe, expect, it, vi } from "vitest";

const apiV1 = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client-v1", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/client-v1")>()), apiV1 }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { commitJointWinners } from "@/components/v2/joint-winners-block";

describe("commitJointWinners (review I-1)", () => {
  it("declare and undo: the write, then the console's resync, then the refresh - in that order", async () => {
    let checked = 0;
    for (const method of ["POST", "DELETE"] as const) {
      const log: string[] = [];
      apiV1.mockReset().mockImplementation(async (url: string, init: { method: string }) => {
        log.push(`${init.method} ${url}`);
        return {};
      });
      await commitJointWinners(method, "fx-1", { onChanged: async () => void log.push("resync"), refresh: () => void log.push("refresh") });
      expect(log).toEqual([`${method} /api/v1/fixtures/fx-1/joint-winners`, "resync", "refresh"]);
      checked++;
    }
    expect(checked, "anti-vacuity: both directions").toBe(2);
  });

  it("a refused write runs neither the resync nor the refresh, and the refusal propagates", async () => {
    apiV1.mockReset().mockRejectedValue(new Error("refused"));
    const onChanged = vi.fn();
    const refresh = vi.fn();
    await expect(commitJointWinners("POST", "fx-1", { onChanged, refresh })).rejects.toThrow("refused");
    expect(onChanged).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a failed resync is swallowed: the write landed, so the refresh still runs and no refusal is shown", async () => {
    apiV1.mockReset().mockResolvedValue({});
    const refresh = vi.fn();
    await expect(commitJointWinners("DELETE", "fx-1", { onChanged: async () => { throw new Error("offline"); }, refresh })).resolves.toBeUndefined();
    expect(refresh).toHaveBeenCalledOnce();
  });
});
