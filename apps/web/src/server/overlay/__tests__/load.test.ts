// `loadOverlayLiveData` — cached public row + venue zone + a fold inside
// `unstable_cache` KEYED ON last_seq (design §3.2). The claim under test is
// the COST claim: with N polls at the same last_seq the ledger is folded
// once; a ledger advance folds once more. `unstable_cache` is a Next
// runtime API absent under vitest — this double is a real memo keyed on the
// keys array (the passthrough double the neighbouring tests use would let a
// missing key pass).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const memo = new Map<string, unknown>();
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => Promise<unknown>, keys: string[]) => async () => {
    const k = keys.join("|");
    if (!memo.has(k)) memo.set(k, await fn());
    return memo.get(k);
  },
  revalidateTag: vi.fn(),
}));

const fold = vi.fn();
vi.mock("@/server/engine-db/fold", () => ({ foldFixture: (...args: unknown[]) => fold(...args) }));

const row = vi.fn();
vi.mock("@/server/usecases/public", () => ({ publicFixture: (...args: unknown[]) => row(...args) }));

vi.mock("@/lib/db", () => ({
  sql: Object.assign(
    async () => [{ division_tz: null, org_tz: "Europe/London" }],
    { begin: async (fn: (tx: unknown) => Promise<unknown>) => fn({}) },
  ),
}));

import { loadOverlayLiveData } from "../load";

beforeEach(() => {
  memo.clear();
  fold.mockReset();
  row.mockReset();
  fold.mockResolvedValue({
    fixtureId: "fx",
    lastSeq: 3,
    state: {},
    summary: {},
    outcome: null,
    active: [],
  });
});
afterEach(() => vi.clearAllMocks());

const ROW = (last_seq: number) => ({
  id: "fx",
  division_id: "d1",
  status: "in_play",
  summary: { headline: "1 — 0" },
  outcome: null,
  last_seq,
});

describe("loadOverlayLiveData", () => {
  it("folds ONCE for three polls at the same last_seq", async () => {
    row.mockResolvedValue(ROW(3));
    await loadOverlayLiveData("fx");
    await loadOverlayLiveData("fx");
    const out = await loadOverlayLiveData("fx");
    expect(fold).toHaveBeenCalledTimes(1);
    expect(out.lastSeq).toBe(3);
    expect(out.venueTz).toBe("Europe/London");
    expect(out.summary).toEqual({ headline: "1 — 0" });
  });

  it("folds AGAIN when the ledger advances (the key is last_seq, not the fixture id)", async () => {
    row.mockResolvedValueOnce(ROW(3)).mockResolvedValueOnce(ROW(4));
    await loadOverlayLiveData("fx");
    await loadOverlayLiveData("fx");
    expect(fold).toHaveBeenCalledTimes(2);
  });

  it("a fixture with no events (last_seq null) skips the fold entirely", async () => {
    row.mockResolvedValue({ ...ROW(0), last_seq: null });
    const out = await loadOverlayLiveData("fx");
    expect(fold).not.toHaveBeenCalled();
    expect(out.clock).toBeUndefined();
    expect(out.cricket).toBeUndefined();
  });

  it("propagates publicFixture's 404 unchanged (visibility is the view's decision, not this loader's)", async () => {
    row.mockRejectedValue(Object.assign(new Error("fixture not found"), { status: 404 }));
    await expect(loadOverlayLiveData("fx")).rejects.toThrow("fixture not found");
    expect(fold).not.toHaveBeenCalled();
  });
});
