// Regression + wiring tests for converting restMin and max-per-day from
// per-keystroke saving to draft-then-commit (blur, Enter).
//
// Before this change, restMin and max-per-day called `saveConstraints` (a
// GET-then-PUT round trip) from `onChange`, the same as every OTHER control
// on this sheet — correct for a checkbox or select, where every intermediate
// state is a valid value, but not for a number typed digit by digit. PR #505
// (constraints-panel-save-race.test.tsx) fixed WHICH of several concurrent
// writes wins; it did not stop every keystroke from being a write at all.
// Typing "12" into max-per-day made "1" the live constraint for a moment —
// an Auto-schedule kicked off, or another tab reading the division, in that
// moment built the board against a half-typed number. This suite pins the
// fix: typing alone must never reach the save path; only blur or Enter may.
//
// Same mock shape as constraints-panel-save-race.test.tsx (this file is the
// sibling suite for the SAME two fields), including the controllable GET
// delay, reused here to prove the "a slow in-flight commit must not clobber
// a newer, still-uncommitted edit" half of requirement 5.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConstraintsPanel } from "../constraints-panel";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import type { ReactElement } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

// `useConfirm` throws outside its provider (context default is null) — same
// mock constraints-panel-save-race.test.tsx uses. Nothing here reaches the
// bulk-shift confirm dialog.
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => async () => true,
}));

const api = vi.hoisted(() => ({
  calls: [] as { url: string; options?: { method?: string; json?: unknown } }[],
  storedConfig: {} as Record<string, unknown>,
  /** One entry consumed per GET call, in call order — lets a test say "the
   *  Nth read this test issues takes this long." */
  getDelaysMs: [] as number[],
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual, // ApiV1Error stays the REAL class.
    apiV1: vi.fn((url: string, options?: { method?: string; json?: unknown }) => {
      api.calls.push({ url, options });
      if (options?.method === "PUT") {
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

function baseConfig(constraints: Record<string, unknown> = {}): Record<string, unknown> {
  return { courts: ["Court 1"], matchMinutes: 30, gapMinutes: 0, constraints };
}

function panelProps(config: Record<string, unknown>) {
  return {
    divisionId: "d1",
    initialSettings: { division_id: "d1", config },
    canEdit: true,
    orgTz: "Pacific/Auckland",
  };
}

/** The max-per-day input is the only `type="number"` field with `min={1}` —
 *  same lookup constraints-panel-save-race.test.tsx uses, unaffected by this
 *  file's markup changes since `min={1}` itself did not move. */
function findMaxPerDayInput(tree: ReactElement[]): ReactElement {
  const el = tree.find((e) => e.type === "input" && propsOf(e).min === 1);
  if (!el) throw new Error("max-per-day input not found");
  return el;
}
function findRestMinInput(tree: ReactElement[]): ReactElement {
  const el = tree.find((e) => e.type === "input" && propsOf(e).id === "rest-min");
  if (!el) throw new Error("rest-min input not found");
  return el;
}
function findById(tree: ReactElement[], id: string): ReactElement {
  const el = tree.find((e) => propsOf(e).id === id);
  if (!el) throw new Error(`no element with id "${id}" found`);
  return el;
}

function fireChange(el: ReactElement, value: string) {
  (propsOf(el).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
}
/** Throws with a clear message rather than a bare "undefined is not a
 *  function" when the handler doesn't exist yet — the expected shape of the
 *  RED step against the pre-change component, which wired no onBlur/onKeyDown
 *  at all. */
function fireBlur(el: ReactElement) {
  const handler = propsOf(el).onBlur as ((e: unknown) => void) | undefined;
  if (!handler) throw new Error("input has no onBlur handler — commit-on-blur is not wired up");
  handler({});
}
function fireKey(el: ReactElement, key: string) {
  const handler = propsOf(el).onKeyDown as ((e: { key: string }) => void) | undefined;
  if (!handler) throw new Error("input has no onKeyDown handler — commit-on-Enter/Escape is not wired up");
  handler({ key });
}

function puts() {
  return api.calls.filter((c) => c.options?.method === "PUT");
}
type HardRule = { type: string; count?: number; scope?: { kind: string; divisionId?: string } };
function storedHard(): HardRule[] | undefined {
  return (api.storedConfig as { constraints?: { hard?: HardRule[] } }).constraints?.hard;
}
function storedRestMin(): number | undefined {
  return (api.storedConfig as { constraints?: { restMin?: number } }).constraints?.restMin;
}

beforeEach(() => {
  vi.useFakeTimers();
  api.calls.length = 0;
  api.getDelaysMs.length = 0;
  api.storedConfig = baseConfig({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe("regression — typing alone must not save; only blur or Enter may", () => {
  it("max-per-day: typing does not call the save path", async () => {
    const island = renderIsland(ConstraintsPanel, panelProps(baseConfig({})));
    fireChange(findMaxPerDayInput(island.tree()), "4");
    await vi.advanceTimersByTimeAsync(1000);
    expect(puts().length, `calls: ${api.calls.map((c) => c.options?.method ?? "GET").join(",")}`).toBe(0);
  });

  it("max-per-day: blur commits the typed value", async () => {
    const island = renderIsland(ConstraintsPanel, panelProps(baseConfig({})));
    const input = () => findMaxPerDayInput(island.tree());
    fireChange(input(), "4");
    fireBlur(input());
    await vi.advanceTimersByTimeAsync(1000);
    expect(puts().length).toBe(1);
    expect(storedHard()?.find((r) => r.type === "max_fixtures_per_day")?.count).toBe(4);
    expect(propsOf(findMaxPerDayInput(island.tree())).value).toBe("4");
  });

  it("max-per-day: Enter commits the typed value", async () => {
    const island = renderIsland(ConstraintsPanel, panelProps(baseConfig({})));
    const input = () => findMaxPerDayInput(island.tree());
    fireChange(input(), "6");
    fireKey(input(), "Enter");
    await vi.advanceTimersByTimeAsync(1000);
    expect(puts().length).toBe(1);
    expect(storedHard()?.find((r) => r.type === "max_fixtures_per_day")?.count).toBe(6);
  });

  it("restMin: typing does not call the save path", async () => {
    const island = renderIsland(ConstraintsPanel, panelProps(baseConfig({})));
    fireChange(findRestMinInput(island.tree()), "40");
    await vi.advanceTimersByTimeAsync(1000);
    expect(puts().length, `calls: ${api.calls.map((c) => c.options?.method ?? "GET").join(",")}`).toBe(0);
  });

  it("restMin: blur commits the typed value", async () => {
    const island = renderIsland(ConstraintsPanel, panelProps(baseConfig({})));
    const input = () => findRestMinInput(island.tree());
    fireChange(input(), "40");
    fireBlur(input());
    await vi.advanceTimersByTimeAsync(1000);
    expect(puts().length).toBe(1);
    expect(storedRestMin()).toBe(40);
  });

  it("restMin: Enter commits the typed value", async () => {
    const island = renderIsland(ConstraintsPanel, panelProps(baseConfig({})));
    const input = () => findRestMinInput(island.tree());
    fireChange(input(), "25");
    fireKey(input(), "Enter");
    await vi.advanceTimersByTimeAsync(1000);
    expect(puts().length).toBe(1);
    expect(storedRestMin()).toBe(25);
  });
});

describe("Escape reverts without saving", () => {
  it("max-per-day: Escape restores the committed text and a later blur does not save", async () => {
    const island = renderIsland(
      ConstraintsPanel,
      panelProps(baseConfig({ hard: [{ type: "max_fixtures_per_day", count: 5, scope: { kind: "division", divisionId: "d1" } }] })),
    );
    const input = () => findMaxPerDayInput(island.tree());
    fireChange(input(), "99");
    expect(propsOf(input()).value).toBe("99");
    fireKey(input(), "Escape");
    expect(propsOf(input()).value).toBe("5");
    fireBlur(input());
    await vi.advanceTimersByTimeAsync(1000);
    expect(puts().length).toBe(0);
  });

  it("restMin: Escape restores the committed text and a later blur does not save", async () => {
    const island = renderIsland(ConstraintsPanel, panelProps(baseConfig({ restMin: 15 })));
    const input = () => findRestMinInput(island.tree());
    fireChange(input(), "999");
    fireKey(input(), "Escape");
    expect(propsOf(input()).value).toBe("15");
    fireBlur(input());
    await vi.advanceTimersByTimeAsync(1000);
    expect(puts().length).toBe(0);
  });
});

describe("unchanged blur does not write", () => {
  it("focusing and blurring max-per-day without typing anything does not save", async () => {
    const island = renderIsland(
      ConstraintsPanel,
      panelProps(baseConfig({ hard: [{ type: "max_fixtures_per_day", count: 5, scope: { kind: "division", divisionId: "d1" } }] })),
    );
    fireBlur(findMaxPerDayInput(island.tree()));
    await vi.advanceTimersByTimeAsync(1000);
    expect(puts().length).toBe(0);
  });

  it("retyping the value that is already committed does not save on blur", async () => {
    const island = renderIsland(ConstraintsPanel, panelProps(baseConfig({ restMin: 20 })));
    const input = () => findRestMinInput(island.tree());
    fireChange(input(), "20");
    fireBlur(input());
    await vi.advanceTimersByTimeAsync(1000);
    expect(puts().length).toBe(0);
  });
});

describe('the "Saved" indicator', () => {
  it("is aria-live=polite, empty at rest, and shows the localized text right after a commit", async () => {
    const island = renderIsland(ConstraintsPanel, panelProps(baseConfig({})));
    const indicator = () => findById(island.tree(), "rest-min-saved");
    expect(propsOf(indicator())["aria-live"]).toBe("polite");
    expect(textOf(indicator())).toBe(""); // reserves its space, shows nothing at rest

    const input = () => findRestMinInput(island.tree());
    fireChange(input(), "40");
    fireBlur(input());
    await vi.advanceTimersByTimeAsync(1000);

    expect(textOf(findById(island.tree(), "rest-min-saved"))).toBe("Saved.");
  });

  it("clears itself again after the pulse window", async () => {
    const island = renderIsland(ConstraintsPanel, panelProps(baseConfig({})));
    const input = () => findRestMinInput(island.tree());
    fireChange(input(), "40");
    fireBlur(input());
    await vi.advanceTimersByTimeAsync(1000);
    expect(textOf(findById(island.tree(), "rest-min-saved"))).toBe("Saved.");

    await vi.advanceTimersByTimeAsync(5000); // well past the pulse window
    expect(textOf(findById(island.tree(), "rest-min-saved"))).toBe("");
  });

  it("max-per-day has its own indicator, independent of restMin's", async () => {
    const island = renderIsland(ConstraintsPanel, panelProps(baseConfig({})));
    const input = () => findMaxPerDayInput(island.tree());
    fireChange(input(), "8");
    fireBlur(input());
    await vi.advanceTimersByTimeAsync(1000);

    expect(textOf(findById(island.tree(), "max-per-day-saved"))).toBe("Saved.");
    expect(textOf(findById(island.tree(), "rest-min-saved"))).toBe(""); // untouched field stays quiet
  });
});

describe("the draft re-seeds when the committed value changes (requirement 5)", () => {
  it("a slow in-flight commit does not clobber a NEWER, still-uncommitted edit typed after it", async () => {
    api.getDelaysMs.push(200); // the GET half of the "20" commit is slow
    const island = renderIsland(ConstraintsPanel, panelProps(baseConfig({ restMin: 0 })));
    const input = () => findRestMinInput(island.tree());

    fireChange(input(), "20");
    fireKey(input(), "Enter"); // commits "20" — GET+PUT queued, GET is slow

    // Before that round trip resolves, the organiser starts a NEW,
    // uncommitted edit in the same field:
    fireChange(input(), "99");
    expect(propsOf(input()).value).toBe("99");

    // Let the slow "20" commit land.
    await vi.advanceTimersByTimeAsync(1000);

    // The just-landed commit must not stomp the organiser's live,
    // uncommitted "99" — the same "don't yank a deliberate action" rule the
    // schedule board's day-tab re-derivation uses. It WAS persisted, though:
    // this is a display guarantee, not a data-loss bug.
    expect(propsOf(input()).value).toBe("99");
    expect(storedRestMin()).toBe(20);

    // And Escape now targets the FRESH committed value ("20"), not the
    // stale "0" that was current when this edit started.
    fireKey(input(), "Escape");
    expect(propsOf(input()).value).toBe("20");
  });

  it("a clean (untouched) field picks up a value committed by its own prior save", async () => {
    const island = renderIsland(ConstraintsPanel, panelProps(baseConfig({ restMin: 5 })));
    const input = () => findRestMinInput(island.tree());
    expect(propsOf(input()).value).toBe("5");

    fireChange(input(), "30");
    fireBlur(input());
    await vi.advanceTimersByTimeAsync(1000);

    // Nothing further typed in the meantime (clean) — the field reflects
    // the new committed value via the same re-seed mechanism, not a
    // leftover optimistic draft.
    expect(propsOf(findRestMinInput(island.tree())).value).toBe("30");
  });
});

describe("unmount flushes a dirty draft (Critical: browser Back discards it otherwise)", () => {
  // Browser Back (or a trackpad swipe-back) is a `popstate` navigation with
  // no mousedown on any element, so — unlike clicking another tab, where a
  // native click's mousedown blurs the focused element first — no native
  // blur fires before `{tab === "constraints" && ...}` (schedule/page.tsx)
  // stops rendering this panel. Without a flush on unmount, a dirty draft is
  // discarded silently: the cap reverts with no error and nothing on screen
  // distinguishing it from a successful save.
  it("max-per-day: typing then unmounting without blur still saves the typed value", async () => {
    const island = renderIsland(ConstraintsPanel, panelProps(baseConfig({})));
    fireChange(findMaxPerDayInput(island.tree()), "4");
    island.unmount();
    await vi.advanceTimersByTimeAsync(1000);
    expect(puts().length, `calls: ${api.calls.map((c) => c.options?.method ?? "GET").join(",")}`).toBe(1);
    expect(storedHard()?.find((r) => r.type === "max_fixtures_per_day")?.count).toBe(4);
  });

  it("restMin: typing then unmounting without blur still saves the typed value", async () => {
    const island = renderIsland(ConstraintsPanel, panelProps(baseConfig({})));
    fireChange(findRestMinInput(island.tree()), "40");
    island.unmount();
    await vi.advanceTimersByTimeAsync(1000);
    expect(puts().length, `calls: ${api.calls.map((c) => c.options?.method ?? "GET").join(",")}`).toBe(1);
    expect(storedRestMin()).toBe(40);
  });

  it("max-per-day: the flush sends the LATEST typed value, not an earlier one from a stale ref", async () => {
    // Types "8" then "12" before unmounting — the assertion that catches a
    // ref captured once (at mount, or at the first keystroke) instead of
    // refreshed every render: a stale ref would flush "8", or nothing.
    const island = renderIsland(ConstraintsPanel, panelProps(baseConfig({})));
    const input = () => findMaxPerDayInput(island.tree());
    fireChange(input(), "8");
    fireChange(input(), "12");
    island.unmount();
    await vi.advanceTimersByTimeAsync(1000);
    expect(puts().length).toBe(1);
    expect(storedHard()?.find((r) => r.type === "max_fixtures_per_day")?.count).toBe(12);
  });

  it("unmounting with nothing typed (both fields clean) sends nothing", async () => {
    // A flush that fires unconditionally would write on every tab switch —
    // this is the negative control for that failure mode.
    const island = renderIsland(
      ConstraintsPanel,
      panelProps(
        baseConfig({
          restMin: 15,
          hard: [{ type: "max_fixtures_per_day", count: 5, scope: { kind: "division", divisionId: "d1" } }],
        }),
      ),
    );
    island.unmount();
    await vi.advanceTimersByTimeAsync(1000);
    expect(puts().length, `calls: ${api.calls.map((c) => c.options?.method ?? "GET").join(",")}`).toBe(0);
  });

  it("a field already committed via blur does not save again on a later unmount", async () => {
    // The "click another tab" case the code review found NOT affected
    // (native blur already committed it, so the field is clean by the time
    // unmount's cleanup runs) — pinned so the fix cannot regress it into a
    // double save.
    const island = renderIsland(ConstraintsPanel, panelProps(baseConfig({})));
    const input = () => findMaxPerDayInput(island.tree());
    fireChange(input(), "6");
    fireBlur(input());
    await vi.advanceTimersByTimeAsync(1000);
    expect(puts().length).toBe(1);

    island.unmount();
    await vi.advanceTimersByTimeAsync(1000);
    expect(puts().length).toBe(1); // still just the one PUT from blur
  });
});
