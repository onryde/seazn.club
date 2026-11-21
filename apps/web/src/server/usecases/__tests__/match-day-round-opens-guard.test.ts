// Match Day online, Task 5 - `withRoundOpensToday` (match-day.ts) owes `countFixturesToday` the sealed round opens it cannot read
// itself. The opens are read in `withTenant`'s privileged prelude and handed to `fn`; this is the guard on the seam between the two:
// a transaction in which the prelude did NOT run must REFUSE, never hand `fn` an empty list (an empty list reads as "no round was
// opened", the silent answer that would take every online night off the match day). The DB-backed cases that drive the real prelude
// are in match-day-home-today.test.ts; this file makes the refusal reachable without a database.
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  withTenant: vi.fn<(orgId: string, fn: (tx: unknown) => Promise<unknown>, opts?: { privilegedPrelude?: (tx: unknown) => Promise<void> }) => Promise<unknown>>(),
  roundOpensToday: vi.fn(),
}));
vi.mock("@/lib/db", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/db")>()), withTenant: hoisted.withTenant }));
vi.mock("@/server/external-play/round-open", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/external-play/round-open")>()), roundOpensToday: hoisted.roundOpensToday }));

import { withRoundOpensToday } from "../match-day";

const NOW = new Date("2026-11-19T12:00:00.000Z");
const TX = { tx: true };
const OPEN = { stageId: "stage-1", roundNo: 1, openedAt: new Date("2026-11-19T11:00:00.000Z"), windowLive: true };

beforeEach(() => {
  hoisted.withTenant.mockReset();
  hoisted.roundOpensToday.mockReset();
});

describe("withRoundOpensToday - the sealed read reaches fn, or fn is never called", () => {
  it("refuses, and never runs fn, when the transaction's prelude did not run", async () => {
    hoisted.withTenant.mockImplementation((_orgId, fn) => fn(TX)); // a withTenant that drops the options: the prelude is skipped
    const fn = vi.fn(async () => 7);
    await expect(withRoundOpensToday("org-1", NOW, fn)).rejects.toThrow(/did not run before the role dropped/);
    expect(fn, "fn must not see a transaction with no opens").not.toHaveBeenCalled();
  });

  it("the positive pair: with the prelude run, fn gets the transaction and exactly what the prelude read, scoped to the org and the instant asked", async () => {
    hoisted.roundOpensToday.mockResolvedValue([OPEN]);
    hoisted.withTenant.mockImplementation(async (_orgId, fn, opts) => {
      await opts?.privilegedPrelude?.(TX);
      return fn(TX);
    });
    const fn = vi.fn(async (_tx: unknown, opens: readonly unknown[]) => opens.length);
    expect(await withRoundOpensToday("org-1", NOW, fn as never)).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0]![1]).toEqual([OPEN]);
    expect(hoisted.roundOpensToday).toHaveBeenCalledWith(TX, "org-1", NOW);
    expect(hoisted.withTenant.mock.calls[0]![0], "the tenant transaction is the org's").toBe("org-1");
  });

  it("an organisation with no round opened is a real, empty answer: fn runs with []", async () => {
    hoisted.roundOpensToday.mockResolvedValue([]);
    hoisted.withTenant.mockImplementation(async (_orgId, fn, opts) => {
      await opts?.privilegedPrelude?.(TX);
      return fn(TX);
    });
    const fn = vi.fn(async (_tx: unknown, opens: readonly unknown[]) => opens);
    expect(await withRoundOpensToday("org-1", NOW, fn as never)).toEqual([]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a prelude that throws takes the whole read with it: fn never runs on a half-read", async () => {
    hoisted.roundOpensToday.mockRejectedValue(new Error("sealed read failed"));
    hoisted.withTenant.mockImplementation(async (_orgId, fn, opts) => {
      await opts?.privilegedPrelude?.(TX);
      return fn(TX);
    });
    const fn = vi.fn(async () => 1);
    await expect(withRoundOpensToday("org-1", NOW, fn)).rejects.toThrow("sealed read failed");
    expect(fn).not.toHaveBeenCalled();
  });
});
