// S13/#422 W11 cutover — re-pin of `period-pad-countdown.test.tsx` (v1's
// `PeriodPad`, deleted this session) against the v2 period skin. #355's
// original contract: countdown() must read live state during render, not a
// ref, so these pin the same VISIBLE behaviour the ref-free version had —
// full duration on arrival, ticking down once a second, cleanup on release
// (no stale stamp leaking into the next suspension), and the interval
// stopping once none remain.
//
// v1 had this; v2's period skin did not (found during the cutover scout —
// zero references to `classKey`/`teamShort`/`setInterval` anywhere in
// period-skin.tsx). Restored on the v2 skin as `SuspensionCountdownList`
// (period-skin.tsx) rather than dropped, per the controller's ruling: a
// suspension countdown that does not tick is a scorer watching a frozen
// number while a penalty expires.
//
// Real engine fixtures throughout (this file's own established convention,
// see period-skin.test.ts's header) — a real `hockey.suspension.start`
// event, folded through `foldClient`, not a hand-rolled state shape. Direct
// `renderIsland(SuspensionCountdownList, ...)`, never through `PeriodSkin`:
// it is a REAL JSX-instantiated component (not a plain render helper), so
// `_hook-harness`'s `walk()` cannot see inside it from a parent's own
// render — the same reason `ActionForm`/`ThisOverGroup` are always rendered
// directly in this test suite, never reached by walking a parent's tree.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";
import { messages, type MessageKey } from "@/lib/messages";
import { t as tRuntime } from "@/lib/i18n-runtime";
import { hockey } from "@seazn/engine/sports/hockey";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import { foldClient } from "../module-client";
import { SuspensionCountdownList } from "../skins/period-skin";

type MsgFn = (key: MessageKey, vars?: Record<string, string | number>) => string;
/** Real English fallback (dict-provider.tsx's own outside-a-provider
 *  behaviour) — matches period-skin.test.ts's own `msg` exactly. */
const msg: MsgFn = (key, vars) => tRuntime(messages, key, vars);

const cfg = hockey.configSchema.parse({});
const lineups = defaultLineupPair(hockey.positions);
const HOME = lineups.home.entrantId;

/** Folds `core.start` + a real `hockey.suspension.start` (class "green" —
 *  hockey's own default `HOCKEY_SUSPENSIONS.green`, 2 nominal minutes, never
 *  hand-invented) and returns the resulting `state.suspensions`, exactly the
 *  shape `PeriodSkin` itself reads via `readSuspensions`. */
function suspensionState(extraEvents: ReturnType<typeof makeEnvelope>[] = []) {
  const events = [
    makeEnvelope(0, { type: "core.start", payload: {} }),
    makeEnvelope(1, { type: "hockey.suspension.start", payload: { by: HOME, class: "green" } }),
    ...extraEvents,
  ];
  return foldClient(hockey, cfg, lineups, events).suspensions as unknown as {
    side: "home" | "away";
    classKey: string;
    permanent: boolean;
    minutes?: number;
  }[];
}

const hintOf = (tree: ReturnType<typeof walk>) => {
  const hint = tree.find((el) => propsOf(el)["data-testid"] === "suspension-countdown-hint");
  const text = (n: unknown): string =>
    n === null || n === undefined || typeof n === "boolean"
      ? ""
      : typeof n === "string" || typeof n === "number"
        ? String(n)
        : Array.isArray(n)
          ? n.map(text).join("")
          : text((n as { props?: { children?: unknown } }).props?.children);
  return hint ? text(hint) : null;
};

describe("period skin — SuspensionCountdownList (re-pinned from period-pad-countdown.test.tsx, #355)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing when no suspension is running", () => {
    const island = renderIsland(SuspensionCountdownList, { suspensions: [], cfg, msg });
    expect(hintOf(island.tree())).toBeNull();
  });

  it("shows the class's full nominal duration the moment a real folded suspension appears", () => {
    const suspensions = suspensionState();
    expect(suspensions).toHaveLength(1); // sanity: the fold really recorded it
    const island = renderIsland(SuspensionCountdownList, { suspensions, cfg, msg });
    expect(hintOf(island.tree())).toBe("2:00");
  });

  it("ticks down once a second as the penalty runs", () => {
    const suspensions = suspensionState();
    const island = renderIsland(SuspensionCountdownList, { suspensions, cfg, msg });
    expect(hintOf(island.tree())).toBe("2:00");

    vi.advanceTimersByTime(5000);
    expect(hintOf(island.tree())).toBe("1:55");

    vi.advanceTimersByTime(60000);
    expect(hintOf(island.tree())).toBe("0:55");
  });

  it("cleans up the stamp when the suspension ends, so the next one starts fresh", () => {
    const suspensions = suspensionState();
    const island = renderIsland(SuspensionCountdownList, { suspensions, cfg, msg });
    vi.advanceTimersByTime(10000);
    expect(hintOf(island.tree())).toBe("1:50");

    // Released: the scorer's explicit action (hockey.suspension.end), not a
    // timeout — refold to a real empty `state.suspensions`.
    const released = suspensionState([makeEnvelope(2, { type: "hockey.suspension.end", payload: { by: HOME, class: "green" } })]);
    expect(released).toHaveLength(0);
    island.rerender({ suspensions: released, cfg, msg });
    expect(hintOf(island.tree())).toBeNull();

    vi.advanceTimersByTime(30000);
    // A brand-new suspension at the same array index (0) — a stale stamp
    // from the first one would show less than the full 2:00 here.
    island.rerender({ suspensions: suspensionState(), cfg, msg });
    expect(hintOf(island.tree())).toBe("2:00");
  });

  it("stops ticking once no suspensions remain", () => {
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const suspensions = suspensionState();
    const island = renderIsland(SuspensionCountdownList, { suspensions, cfg, msg });
    island.rerender({ suspensions: [], cfg, msg });
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
