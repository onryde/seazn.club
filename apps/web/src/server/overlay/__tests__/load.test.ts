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

// W2 — the loader now issues THREE different queries (the venue zone, the
// division's consent settings, the public line-up), so a single catch-all
// response would answer all three with the venue row and prove nothing. This
// double dispatches on the SQL text and records what was asked, which is how
// "the person read is skipped when the window names nobody" is asserted at all.
//
// `vi.hoisted`, NOT a plain `const`: a `vi.mock` factory is hoisted above the
// module body, so a factory that READS a top-level binding while it is being
// built (rather than inside a closure the factory returns) throws
// "Cannot access 'x' before initialization" — and that arrives as a COLLECTION
// failure, which the JSON reporter reports as zero tests rather than as a red.
const { queries } = vi.hoisted(() => ({ queries: [] as string[] }));

vi.mock("@/lib/db", () => ({
  sql: Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      queries.push(text.replace(/\s+/g, " ").trim());
      void values;
      if (text.includes("division_tz") || text.includes("org_tz")) {
        return [{ division_tz: null, org_tz: "Europe/London" }];
      }
      if (text.includes("player_name_display")) {
        return [{ youth: false, player_name_display: "full" }];
      }
      if (text.includes("from lineups")) {
        return [
          { entrant_id: "E-home", person_id: "p-scorer", full_name: "Ada Lovelace", consent: null },
          { entrant_id: "E-away", person_id: "p-shy", full_name: "Grace Hopper", consent: { public_name: false } },
        ];
      }
      return [];
    },
    { begin: async (fn: (tx: unknown) => Promise<unknown>) => fn({}) },
  ),
}));

import { loadOverlayLiveData } from "../load";
import { resolvePersonDisplayName } from "@/lib/name-display";

beforeEach(() => {
  memo.clear();
  queries.length = 0;
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
  home_entrant_id: "E-home",
  away_entrant_id: "E-away",
});

/** An envelope as `FoldedFixture.active` carries it. */
const ev = (seq: number, type: string, payload: unknown) => ({
  id: `e-${seq}`,
  fixtureId: "fx",
  seq,
  type,
  payload,
  recordedAt: "2026-09-11T09:00:00.000Z",
  recordedBy: null,
});
const withActive = (active: unknown[]) =>
  fold.mockResolvedValue({ fixtureId: "fx", lastSeq: 3, state: {}, summary: {}, outcome: null, active });
const askedForPeople = () => queries.some((q) => q.includes("from lineups"));

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

  it("W2 — `recent` is ALWAYS an array, even for a fixture that has never been folded", async () => {
    row.mockResolvedValue({ ...ROW(0), last_seq: null });
    const out = await loadOverlayLiveData("fx");
    expect(out.recent).toEqual([]);
  });

  it("W2 — a ledger that names NOBODY costs no person read at all", async () => {
    row.mockResolvedValue(ROW(3));
    withActive([ev(1, "core.start", {}), ev(2, "football.goal", { by: "E-home" })]);
    const out = await loadOverlayLiveData("fx");
    expect(out.recent).toEqual([
      { seq: 2, type: "football.goal", at: "2026-09-11T09:00:00.000Z", payload: { side: 0, ownGoal: false, penalty: false } },
    ]);
    expect(askedForPeople()).toBe(false);
  });

  it("W2 — a named scorer IS read, and arrives through the CONSENT resolver, not as the stored name", async () => {
    row.mockResolvedValue(ROW(3));
    withActive([
      ev(1, "core.start", {}),
      ev(2, "football.goal", { by: "E-home", scorer: "p-scorer" }),
      ev(3, "football.card", { by: "E-away", person: "p-shy", color: "red" }),
    ]);
    const out = await loadOverlayLiveData("fx");
    expect(askedForPeople()).toBe(true);
    expect(out.recent?.[0]?.payload.person).toEqual({ name: "Ada Lovelace", masked: false });
    // Derived from the resolver rather than typed here, so a change to the
    // masking convention moves this expectation with it.
    expect(out.recent?.[1]?.payload.person).toEqual({
      name: resolvePersonDisplayName("Grace Hopper", { public_name: false }, "full", false),
      masked: true,
    });
    expect(out.recent?.[1]?.payload.person?.name).not.toBe("Grace Hopper");
  });

  it("W2 — a person id the LINE-UP never named is left unnamed rather than published", async () => {
    row.mockResolvedValue(ROW(3));
    withActive([ev(2, "football.goal", { by: "E-home", scorer: "p-stale" })]);
    const out = await loadOverlayLiveData("fx");
    expect(out.recent?.[0]?.payload.person).toBeUndefined();
  });

  it("W2 — a fixture with an unassigned entrant yields no moments and does not throw", async () => {
    row.mockResolvedValue({ ...ROW(3), away_entrant_id: null });
    withActive([ev(2, "football.goal", { by: "E-home" })]);
    const out = await loadOverlayLiveData("fx");
    expect(out.recent).toEqual([]);
    expect(out.summary).toEqual({ headline: "1 — 0" });
  });

  it("propagates publicFixture's 404 unchanged (visibility is the view's decision, not this loader's)", async () => {
    row.mockRejectedValue(Object.assign(new Error("fixture not found"), { status: 404 }));
    await expect(loadOverlayLiveData("fx")).rejects.toThrow("fixture not found");
    expect(fold).not.toHaveBeenCalled();
  });
});
