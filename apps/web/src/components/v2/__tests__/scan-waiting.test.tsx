// Scorer sheets §4.5.2 — the Waiting screen: a side is still TBD, so there is
// no pad and no stream. It re-renders the server page every POLL_MS, only
// while it exists, and on tab return through G1's own hook.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIsland } from "@/components/__tests__/_hook-harness";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { isValidElement, type ReactNode } from "react";
import { ScanWaiting } from "@/components/v2/scan-waiting";
import { POLL_MS } from "@/components/v2/scorepad/use-fixture-stream";
import en from "@/dictionaries/en/ui.json";

/** Sentinels, so a string the screen looked up itself cannot pass for one it
 *  was handed. */
const COPY = { lead: "«waiting-for»", vs: "«vs»", hint: "«hint»" };
const props = (over: Partial<Parameters<typeof ScanWaiting>[0]> = {}) => ({
  home: "A",
  away: "B",
  matchRef: "SF·1",
  meta: [] as string[],
  copy: COPY,
  ...over,
});

type El = { type: unknown; props: { className?: string; children?: ReactNode; "data-testid"?: string } };
/** Every host element from the root down to the first one carrying `testid`. */
function pathTo(node: ReactNode, testid: string, trail: El[] = []): El[] | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = pathTo(n as ReactNode, testid, trail);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const el = node as unknown as El;
  const here = [...trail, el];
  if (el.props["data-testid"] === testid) return here;
  return pathTo(el.props.children, testid, here);
}

beforeEach(() => {
  vi.useFakeTimers();
  router.refresh.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Listener = () => void;
function recordingTarget() {
  const listeners: Record<string, Listener[]> = {};
  return {
    listeners,
    addEventListener: (type: string, fn: Listener) => void (listeners[type] ??= []).push(fn),
    removeEventListener: (type: string, fn: Listener) =>
      void (listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn)),
  };
}
const fire = (t: { listeners: Record<string, Listener[]> }, type: string) => {
  for (const fn of [...(t.listeners[type] ?? [])]) fn();
};

describe("ScanWaiting (scorer sheets §4.5.2)", () => {
  it("re-renders the page every POLL_MS — and not before", () => {
    renderIsland(ScanWaiting, props({ meta: ["Court 3"] }));
    vi.advanceTimersByTime(POLL_MS - 1);
    expect(router.refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(POLL_MS);
    expect(router.refresh).toHaveBeenCalledTimes(2);
  });

  it("stops the moment Waiting unmounts (only while waiting)", () => {
    const island = renderIsland(ScanWaiting, props());
    island.unmount();
    vi.advanceTimersByTime(POLL_MS * 3);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("re-renders on a tab return too — G1's floor, the same hook, and not on a hide", () => {
    const doc = { ...recordingTarget(), visibilityState: "hidden" as DocumentVisibilityState };
    const win = recordingTarget();
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", win);
    renderIsland(ScanWaiting, props());
    fire(doc, "visibilitychange");
    expect(router.refresh, "a hide re-renders nothing").not.toHaveBeenCalled();
    doc.visibilityState = "visible";
    fire(doc, "visibilitychange");
    expect(router.refresh).toHaveBeenCalledTimes(1);
    fire(win, "focus");
    expect(router.refresh).toHaveBeenCalledTimes(2);
  });

  it("names both sides, the TBD one by its slot label", () => {
    const island = renderIsland(ScanWaiting, props({ home: "Winner of SF·1", away: "Ben Lim" }));
    expect(island.text()).toContain("Winner of SF·1");
    expect(island.text()).toContain("Ben Lim");
  });

  // Task 6 review I2: this screen polls the server page every POLL_MS, and a
  // dictionary provider around it re-sent the whole `ui` dictionary on every
  // poll. So it looks nothing up: the page hands it its three sentences.
  it("says exactly the words it was handed, and looks none up (review I2)", () => {
    const text = renderIsland(ScanWaiting, props()).text();
    for (const s of Object.values(COPY)) expect(text).toContain(s);
    for (const key of ["device.scan.waitingFor", "device.scan.waitingHint"] as const) {
      expect(text, `no ${key} from the English catalog`).not.toContain(en[key]);
    }
  });

  // Task 6 review minor (c): at 320 the one-line meta truncated the match ref
  // away — the one part a scorer checks against the sheet. The meta wraps now,
  // and the ref is its own element that never truncates and never splits.
  it("keeps the match ref whole: its own element, and nothing on its path truncates (review minor c)", () => {
    const tree = renderIsland(
      ScanWaiting,
      props({ matchRef: "QF·3", meta: ["Court 12 — the long one by the car park", "Sat 10:30", "Open Singles"] }),
    ).tree();
    const path = pathTo(tree as ReactNode, "scan-waiting-ref");
    expect(path, "the ref has its own element").not.toBeNull();
    const ref = path!.at(-1)!;
    expect(ref.props.children).toBe("QF·3");
    expect(ref.props.className ?? "", "the ref never breaks across lines").toMatch(/\bwhitespace-nowrap\b/);
    for (const el of path!) {
      expect(el.props.className ?? "", "nothing between the screen and the ref clips it").not.toMatch(
        /\b(truncate|overflow-hidden|text-ellipsis)\b/,
      );
    }
  });
});

// Owner-approved fix 2026-09-24: a sheet scanned before the organiser starts the
// division gets its own screen, "Not started yet" — the same component, so it
// moves on to Confirm through the same refresh Waiting uses.
describe("ScanWaiting, waiting on the division's start (owner fix 2026-09-24)", () => {
  /** The screen's root: `tree()` walks pre-order, so the first element. */
  const rootOf = (island: { tree: () => unknown }) => (island.tree() as El[])[0]!;

  it("the everyday case first: with no `waitingOn` it is the sides' Waiting, never Not started", () => {
    const island = renderIsland(ScanWaiting, props());
    expect(rootOf(island).props["data-testid"]).toBe("scan-waiting");
    expect(pathTo(island.tree() as ReactNode, "scan-not-started-title"), "no headline on Waiting").toBeNull();
  });

  it("an unstarted division: its own screen, the handed headline as a heading, both names, the ref and the body", () => {
    const island = renderIsland(ScanWaiting, props({ waitingOn: "division_start", home: "Ada", away: "Ben" }));
    const root = rootOf(island);
    expect(root.props["data-testid"]).toBe("scan-not-started");
    const title = pathTo(island.tree() as ReactNode, "scan-not-started-title")?.at(-1);
    expect(title, "the headline has its own element").toBeDefined();
    expect(title!.type, "…and it is the page heading").toBe("h1");
    expect(title!.props.children).toBe(COPY.lead);
    const text = island.text();
    for (const s of ["Ada", "Ben", "SF·1", COPY.vs, COPY.hint]) expect(text).toContain(s);
    for (const key of ["device.scan.notStarted.title", "device.scan.notStarted.body"] as const) {
      expect(text, `no ${key} from the English catalog`).not.toContain(en[key]);
    }
  });

  it("re-renders the page every POLL_MS and on a tab return — the way it moves on to Confirm by itself", () => {
    const doc = { ...recordingTarget(), visibilityState: "visible" as DocumentVisibilityState };
    const win = recordingTarget();
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", win);
    renderIsland(ScanWaiting, props({ waitingOn: "division_start" }));
    vi.advanceTimersByTime(POLL_MS - 1);
    expect(router.refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    fire(win, "focus");
    expect(router.refresh).toHaveBeenCalledTimes(2);
  });
});
