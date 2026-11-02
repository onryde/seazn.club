// PB2 re-review 1, m11: an organisation with NO competitions ceiling opens no transaction to learn that nothing of it is
// frozen. The stored freeze (`competitions.frozen_at`) made every read open one — begin, set_config, set role, the count,
// commit — for every Pro guard and every `getCompetition`/`listCompetitions`, only to find nothing held. The early return
// is back: unlimited and nothing marked costs one pooled statement on the partial index and no transaction; marks left from
// before the ceiling went away are cleared through the full path (the upgrade thaws everything), so a later downgrade
// chooses afresh. The DB half of that sequence is scoring-frozen-competition.test.ts ("an upgrade drops the stored choice").
//
// The two modules the read talks to are stubbed so the test can COUNT what it opened; no database.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  limit: null as number | null,
  marked: false,
  pooled: [] as string[],
  tenants: 0,
}));

vi.mock("@/lib/entitlements", () => ({
  getLimit: vi.fn(async () => state.limit),
}));

vi.mock("@/lib/db", () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => {
    state.pooled.push(strings.join("?"));
    return [{ marked: state.marked }];
  }),
  withTenant: vi.fn(async () => {
    state.tenants++;
    return new Set<string>();
  }),
}));

const { frozenCompetitionIds } = await import("../entitlement-freeze");

beforeEach(() => {
  state.limit = null;
  state.marked = false;
  state.pooled = [];
  state.tenants = 0;
});

describe("frozenCompetitionIds on an unlimited organisation (PB2 re-review 1, m11)", () => {
  it("unlimited with nothing marked: the empty set, ONE pooled statement and NO transaction", async () => {
    expect(await frozenCompetitionIds("org-a")).toEqual(new Set());
    expect(state.tenants, "transactions opened").toBe(0);
    expect(state.pooled, "pooled statements").toHaveLength(1);
    expect(state.pooled[0]).toMatch(/frozen_at is not null/);
  });

  it("a second read is the same: no transaction accumulates", async () => {
    await frozenCompetitionIds("org-a");
    await frozenCompetitionIds("org-a");
    expect([state.tenants, state.pooled.length]).toEqual([0, 2]);
  });

  it("unlimited with marks left from before (an upgrade): the full path runs, once, to clear them", async () => {
    state.marked = true;
    await frozenCompetitionIds("org-a");
    expect(state.tenants).toBe(1);
  });

  it("a ceiling (including 0): the full path, as before — the count is asked inside the transaction, no pooled pre-read", async () => {
    for (const limit of [0, 3]) {
      state.limit = limit;
      state.pooled = [];
      state.tenants = 0;
      await frozenCompetitionIds("org-a");
      expect([limit, state.tenants, state.pooled.length]).toEqual([limit, 1, 0]);
    }
  });
});
