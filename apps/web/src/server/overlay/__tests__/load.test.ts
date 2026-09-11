// `loadOverlayLiveData` — cached public row + venue zone + a fold inside
// `unstable_cache` KEYED ON last_seq (design §3.2), and W2's `recent` window
// with its derived annotations in the SAME cached pass.
//
// The claim under test is still the COST claim: with N polls at one last_seq
// the ledger is loaded once; a ledger advance loads once more. W2 adds two
// more: the person read is skipped when the window names nobody, and a name
// that reaches the wire has been through the consent resolver.
//
// THE CACHE DOUBLE SERIALISES. `unstable_cache` is a Next runtime API absent
// under vitest, and the passthrough double this file used to carry would hand
// back whatever the function returned — including a `Map`, which the real cache
// turns into `{}`. Round-tripping through JSON here is what makes that
// difference visible at all.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const memo = new Map<string, string>();
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => Promise<unknown>, keys: string[]) => async () => {
    const k = keys.join("|");
    if (!memo.has(k)) memo.set(k, JSON.stringify(await fn()));
    return JSON.parse(memo.get(k)!) as unknown;
  },
  revalidateTag: vi.fn(),
}));

// `loadFoldInputs` is the ONLY seam doubled: `foldFrom` and the derived replay
// stay REAL, so every assertion below runs through the actual engine.
const loadInputs = vi.fn();
vi.mock("@/server/engine-db/fold", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/engine-db/fold")>()),
  loadFoldInputs: (...args: unknown[]) => loadInputs(...args),
}));

const row = vi.fn();
vi.mock("@/server/usecases/public", () => ({ publicFixture: (...args: unknown[]) => row(...args) }));

// W2 — the loader issues THREE different queries (the venue zone, the
// division's consent settings, the public line-up), so a single catch-all
// response would answer all three with the venue row and prove nothing. This
// double dispatches on the SQL text and records what was asked, which is how
// "the person read is skipped when the window names nobody" is asserted at all.
//
// `vi.hoisted`, NOT a plain `const`: a `vi.mock` factory is hoisted above the
// module body, so a factory that READS a top-level binding while it is being
// built throws "Cannot access 'x' before initialization" — and that arrives as
// a COLLECTION failure, which the JSON reporter reports as zero tests rather
// than as a red.
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
          { entrant_id: "E-home", person_id: "E-home-p1", full_name: "Ada Lovelace", consent: null },
          { entrant_id: "E-away", person_id: "E-away-p1", full_name: "Grace Hopper", consent: { public_name: false } },
        ];
      }
      return [];
    },
    { begin: async (fn: (tx: unknown) => Promise<unknown>) => fn({}) },
  ),
}));

import { makeEnvelope, lineupFromCatalog, SIM_CONFIGS } from "@seazn/engine/testkit";
import { builtinModules } from "@seazn/engine/sports";
import { loadOverlayLiveData } from "../load";
import { resolvePersonDisplayName } from "@/lib/name-display";

const AT = "2026-09-11T09:00:00.000Z";
const moduleFor = (key: string) => {
  const m = builtinModules.find((mod) => mod.key === key);
  if (!m) throw new Error(`no builtin module for "${key}"`);
  return m;
};
/** The line-up pair's entrant ids ARE the fixture's sides, which is what the
 *  derived probe reads them from. Built for `E-home`/`E-away` so the row below
 *  and the fold agree. */
const lineupsFor = (key: string) => ({
  home: lineupFromCatalog(moduleFor(key).positions, "E-home"),
  away: lineupFromCatalog(moduleFor(key).positions, "E-away"),
});

/** Points `loadFoldInputs` at a real module and a real ledger. `foldFrom` and
 *  `replayDerived` then run for real on top of it. */
function withLedger(key: string, stream: readonly (readonly [string, unknown])[]) {
  const mod = moduleFor(key);
  loadInputs.mockResolvedValue({
    sportKey: key,
    module: mod,
    cfg: mod.configSchema.parse(SIM_CONFIGS[key] ?? {}),
    lineups: lineupsFor(key),
    envelopes: stream.map(([type, payload], i) => ({
      ...makeEnvelope(i + 1, { type, payload } as never),
      recordedAt: AT,
    })),
  });
}

beforeEach(() => {
  memo.clear();
  queries.length = 0;
  loadInputs.mockReset();
  row.mockReset();
  withLedger("football", [["core.start", {}]]);
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

const askedForPeople = () => queries.some((q) => q.includes("from lineups"));

describe("loadOverlayLiveData", () => {
  it("loads and folds ONCE for three polls at the same last_seq", async () => {
    row.mockResolvedValue(ROW(1));
    await loadOverlayLiveData("fx");
    await loadOverlayLiveData("fx");
    const out = await loadOverlayLiveData("fx");
    expect(loadInputs).toHaveBeenCalledTimes(1);
    expect(out.lastSeq).toBe(1);
    expect(out.venueTz).toBe("Europe/London");
    expect(out.summary).toEqual({ headline: "1 — 0" });
  });

  it("loads AGAIN when the ledger advances (the key is last_seq, not the fixture id)", async () => {
    row.mockResolvedValueOnce(ROW(1)).mockResolvedValueOnce(ROW(2));
    await loadOverlayLiveData("fx");
    await loadOverlayLiveData("fx");
    expect(loadInputs).toHaveBeenCalledTimes(2);
  });

  it("a fixture with no events (last_seq null) skips the fold entirely", async () => {
    row.mockResolvedValue({ ...ROW(0), last_seq: null });
    const out = await loadOverlayLiveData("fx");
    expect(loadInputs).not.toHaveBeenCalled();
    expect(out.clock).toBeUndefined();
    expect(out.cricket).toBeUndefined();
    expect(out.recent).toEqual([]);
  });

  it("W2 — a ledger that names NOBODY costs no person read at all", async () => {
    row.mockResolvedValue(ROW(2));
    withLedger("football", [["core.start", {}], ["football.goal", { by: "E-home" }]]);
    const out = await loadOverlayLiveData("fx");
    expect(out.recent).toEqual([
      { seq: 2, type: "football.goal", at: AT, payload: { side: 0, ownGoal: false, penalty: false } },
    ]);
    expect(askedForPeople()).toBe(false);
  });

  it("W2 — a named scorer IS read, and arrives through the CONSENT resolver, not as the stored name", async () => {
    row.mockResolvedValue(ROW(3));
    withLedger("football", [
      ["core.start", {}],
      ["football.goal", { by: "E-home", scorer: "E-home-p1" }],
      ["football.card", { by: "E-away", person: "E-away-p1", color: "red" }],
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
    row.mockResolvedValue(ROW(2));
    withLedger("football", [["core.start", {}], ["football.goal", { by: "E-home", scorer: "E-stale-p9" }]]);
    const out = await loadOverlayLiveData("fx");
    expect(out.recent?.[0]?.payload.person).toBeUndefined();
  });

  it("W2 — a fixture with an unassigned entrant yields no moments and does not throw", async () => {
    row.mockResolvedValue({ ...ROW(2), away_entrant_id: null });
    withLedger("football", [["core.start", {}], ["football.goal", { by: "E-home" }]]);
    const out = await loadOverlayLiveData("fx");
    expect(out.recent).toEqual([]);
    expect(out.summary).toEqual({ headline: "1 — 0" });
  });

  it("W2 Step 7 — `derived` SURVIVES the cache. A Map would arrive as `{}` and the slab would never fire", async () => {
    // 20 unanswered rallies leaves the leader one point from the game, which
    // the engine — not this test — decides. The point of the case is the
    // round trip: the replay produces a `Map`, the loader must hand the cache
    // something that serialises, and the wire must still carry the annotation.
    const rallies = Array.from({ length: 20 }, () => ["badminton.rally", { wonBy: "E-home" }] as const);
    row.mockResolvedValue(ROW(21));
    withLedger("badminton", [["core.start", {}], ...rallies]);
    const out = await loadOverlayLiveData("fx");
    expect(out.recent?.at(-1)?.derived?.pointState).toMatchObject({ kind: "set", side: 0 });
    // And again from the CACHE, which is where a Map would have been lost.
    const cached = await loadOverlayLiveData("fx");
    expect(loadInputs).toHaveBeenCalledTimes(1);
    expect(cached.recent?.at(-1)?.derived?.pointState).toMatchObject({ kind: "set", side: 0 });
  });

  it("propagates publicFixture's 404 unchanged (visibility is the view's decision, not this loader's)", async () => {
    row.mockRejectedValue(Object.assign(new Error("fixture not found"), { status: 404 }));
    await expect(loadOverlayLiveData("fx")).rejects.toThrow("fixture not found");
    expect(loadInputs).not.toHaveBeenCalled();
  });

  it("a fold that THROWS still serves the row's own fields, with no moments", async () => {
    row.mockResolvedValue(ROW(2));
    loadInputs.mockRejectedValue(new Error("MODULE_NOT_FOUND"));
    const out = await loadOverlayLiveData("fx");
    expect(out.summary).toEqual({ headline: "1 — 0" });
    expect(out.recent).toEqual([]);
    expect(out.clock).toBeUndefined();
  });
});
