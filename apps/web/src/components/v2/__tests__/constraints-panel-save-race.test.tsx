// Live report: an organiser typed "5" into max-per-day and it stored as 10,
// then 8 (division 7f41f7c4-e1d6-4432-b65c-7343f504e866, org `hhhh`,
// competition `test0002`, division `test001`). This suite reproduces the
// mechanism and pins the fix.
//
// `constraints-panel.tsx`'s per-keystroke fields (`restMin`, the max-per-day
// input below it, and every checkbox/select on this sheet) used to call
// `save(next)` with `next` built from the `constraints` closure AT KEYSTROKE
// TIME, and fire its GET-then-PUT round trip IMMEDIATELY — no debounce, no
// sequencing. Two edits close together therefore raced two independent
// GET+PUT pairs over the network, and the LAST RESPONSE TO ARRIVE won the
// write, regardless of which request was SENT last. Nothing stopped the
// request behind an earlier, slower keystroke from landing after a later,
// faster one and silently overwriting it.
//
// `saveConstraints`'s queue fix (below) is unaffected by the LATER change
// that moved restMin/max-per-day off per-keystroke saving onto draft-then-
// commit (blur, Enter — constraints-panel-commit-semantics.test.tsx): that
// change only moved WHEN `saveConstraints` is called, not what it does once
// called. So the race this file exists to pin still exists, one level up —
// two rapid COMMITS (not keystrokes) on the same field still queue two
// independent GET+PUT pairs, and the fix must still serialize them. Every
// `fireChange` below is followed by `fireBlur` for exactly that reason: a
// change alone no longer reaches the save path at all (that is now pinned
// separately), so the race has to be driven the way an organiser actually
// triggers two saves under the new model — type, commit, type again, commit
// again — for this suite to still be exercising the real mechanism rather
// than dead code.
//
// Reproduced here with vitest's fake timers rather than real ones: the mock
// `apiV1` gives each GET a caller-controlled delay, so "the first request's
// round trip happens to be slower" is deterministic instead of a timing
// gamble.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConstraintsPanel } from "../constraints-panel";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import type { ReactElement } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

// `useConfirm` throws outside its provider (context default is null) — same
// mock blackout-editor.test.tsx uses. Nothing here reaches the bulk-shift
// confirm dialog.
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => async () => true,
}));

const api = vi.hoisted(() => ({
  calls: [] as { url: string; options?: { method?: string; json?: unknown } }[],
  storedConfig: {} as Record<string, unknown>,
  /** One entry consumed per GET call, in CALL order — lets a test say "the
   *  Nth read this test issues takes this long," independent of how many
   *  microtask hops either implementation needs before it actually issues
   *  that read. */
  getDelaysMs: [] as number[],
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual, // ApiV1Error stays the REAL class.
    apiV1: vi.fn((url: string, options?: { method?: string; json?: unknown }) => {
      api.calls.push({ url, options });
      if (options?.method === "PUT") {
        // Simulates the server: whatever this PUT sends becomes the new
        // stored row, exactly like the real read-modify-write endpoint.
        api.storedConfig = (options.json as { config: Record<string, unknown> }).config;
        return Promise.resolve({});
      }
      const delay = api.getDelaysMs.shift() ?? 0;
      if (delay === 0) return Promise.resolve({ division_id: "d1", config: api.storedConfig });
      return new Promise((resolve) => {
        setTimeout(() => resolve({ division_id: "d1", config: api.storedConfig }), delay);
      });
    }),
  };
});

/** A hard rule with no bearing on max-per-day or restMin at all — present
 *  purely to prove `withMaxFixturesPerDay`'s "every other hard rule
 *  untouched" guarantee survives a QUEUED save, not just a solo one. */
const SENTINEL_RULE = { type: "min_rest", scope: { kind: "division", divisionId: "d1" } };

function baseConfig(constraints: Record<string, unknown> = {}): Record<string, unknown> {
  return { courts: ["Court 1"], matchMinutes: 30, gapMinutes: 0, constraints };
}

function panelProps(config: Record<string, unknown>) {
  return {
    divisionId: "d1",
    initialSettings: { division_id: "d1", config },
    canEdit: true,
    orgTz: "Pacific/Auckland",
    viewerPlan: "community" as const,
  };
}

/** The max-per-day input is the only `type="number"` field with `min={1}`:
 *  restMin uses `min={0}`, and the bulk-shift-minutes field has no `min` at
 *  all. Locating it this way avoids depending on translated copy. */
function findMaxPerDayInput(tree: ReactElement[]): ReactElement {
  const el = tree.find((e) => e.type === "input" && propsOf(e).min === 1);
  if (!el) throw new Error("max-per-day input not found");
  return el;
}

/** restMin is the one numeric field with this literal id. */
function findRestMinInput(tree: ReactElement[]): ReactElement {
  const el = tree.find((e) => e.type === "input" && propsOf(e).id === "rest-min");
  if (!el) throw new Error("rest-min input not found");
  return el;
}

function fireChange(el: ReactElement, value: string) {
  (propsOf(el).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
}

/** Commits a draft the way a blur does — see the module comment above for
 *  why every race in this file now needs one after each `fireChange`. */
function fireBlur(el: ReactElement) {
  (propsOf(el).onBlur as (e: unknown) => void)({});
}

type HardRule = { type: string; count?: number; scope?: { kind: string; divisionId?: string } };
function storedHard(): HardRule[] | undefined {
  return (api.storedConfig as { constraints?: { hard?: HardRule[] } }).constraints?.hard;
}

beforeEach(() => {
  vi.useFakeTimers();
  api.calls.length = 0;
  api.getDelaysMs.length = 0;
  api.storedConfig = baseConfig({ hard: [SENTINEL_RULE] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("max-per-day — out-of-order network responses", () => {
  it("stores the LAST-committed value even when the EARLIER commit's round trip is the slower one", async () => {
    // Committing "1" fires the SLOW request; a moment later, committing "10"
    // (still before the first request has returned) fires a FAST one. Each
    // edit needs its own `fireBlur` now — a bare `fireChange` only updates
    // the draft and never reaches the save path at all (pinned separately in
    // constraints-panel-commit-semantics.test.tsx).
    api.getDelaysMs.push(200, 10);

    const island = renderIsland(ConstraintsPanel, panelProps(baseConfig({ hard: [SENTINEL_RULE] })));
    const input = () => findMaxPerDayInput(island.tree());

    fireChange(input(), "1");
    fireBlur(input());
    fireChange(input(), "10");
    fireBlur(input());

    // Let every scheduled timer fire in simulated-time order, and every
    // promise continuation between them settle, regardless of how many
    // ticks either implementation needs before it issues its next GET.
    await vi.advanceTimersByTimeAsync(1000);

    const puts = api.calls.filter((c) => c.options?.method === "PUT");
    expect(puts.length, `calls: ${api.calls.map((c) => c.options?.method ?? "GET").join(",")}`).toBeGreaterThanOrEqual(2);

    const rule = storedHard()?.find((r) => r.type === "max_fixtures_per_day");
    // The organiser's LAST commit was "10" — that is what must be
    // persisted, never the "1" from the commit whose round trip merely
    // happened to be slower.
    expect(rule?.count).toBe(10);
    // A debounce or a batched write must not regress this: an unrelated
    // hard rule already on the division must still be there afterwards.
    expect(storedHard()).toContainEqual(SENTINEL_RULE);
  });

  it("clearing the field after a slow in-flight edit still removes the rule, not the earlier count", async () => {
    api.getDelaysMs.push(200, 10);
    const island = renderIsland(ConstraintsPanel, panelProps(baseConfig({ hard: [SENTINEL_RULE] })));
    const input = () => findMaxPerDayInput(island.tree());

    fireChange(input(), "7"); // slow
    fireBlur(input());
    fireChange(input(), ""); // fast — clears it
    fireBlur(input());

    await vi.advanceTimersByTimeAsync(1000);

    expect(storedHard()?.find((r) => r.type === "max_fixtures_per_day")).toBeUndefined();
    expect(storedHard()).toContainEqual(SENTINEL_RULE);
  });
});

describe("restMin — same shape, same fix", () => {
  it("stores the LAST-committed rest minutes even when the EARLIER commit's round trip is the slower one", async () => {
    api.getDelaysMs.push(200, 10);
    const island = renderIsland(ConstraintsPanel, panelProps(baseConfig({ hard: [SENTINEL_RULE] })));
    const input = () => findRestMinInput(island.tree());

    fireChange(input(), "3");
    fireBlur(input());
    fireChange(input(), "35");
    fireBlur(input());

    await vi.advanceTimersByTimeAsync(1000);

    const puts = api.calls.filter((c) => c.options?.method === "PUT");
    expect(puts.length, `calls: ${api.calls.map((c) => c.options?.method ?? "GET").join(",")}`).toBeGreaterThanOrEqual(2);

    const cfg = api.storedConfig as { constraints?: { restMin?: number } };
    expect(cfg.constraints?.restMin).toBe(35);
    expect(storedHard()).toContainEqual(SENTINEL_RULE);
  });
});

describe("max-per-day — a single edit, no race (sanity backstop)", () => {
  it("stores a freshly-typed multi-digit value exactly, once committed", async () => {
    const island = renderIsland(ConstraintsPanel, panelProps(baseConfig({})));
    const input = () => findMaxPerDayInput(island.tree());
    fireChange(input(), "42");
    fireBlur(input());
    await vi.advanceTimersByTimeAsync(1000);

    expect(storedHard()?.find((r) => r.type === "max_fixtures_per_day")?.count).toBe(42);
  });

  it("removes the rule when cleared and committed, leaving other hard rules untouched", async () => {
    const island = renderIsland(
      ConstraintsPanel,
      panelProps(
        baseConfig({
          hard: [SENTINEL_RULE, { type: "max_fixtures_per_day", count: 5, scope: { kind: "division", divisionId: "d1" } }],
        }),
      ),
    );
    const input = () => findMaxPerDayInput(island.tree());
    fireChange(input(), "");
    fireBlur(input());
    await vi.advanceTimersByTimeAsync(1000);

    expect(storedHard()?.find((r) => r.type === "max_fixtures_per_day")).toBeUndefined();
    expect(storedHard()).toContainEqual(SENTINEL_RULE);
  });
});
