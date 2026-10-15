// ProductTour's step machine (ESLint L3). The step used to be copied out of
// `sessionStorage` into state by an effect, behind a `mounted` flag set by a
// second effect; it is now READ from storage through `useSyncExternalStore`
// and derived against the current page. Nothing tested the machine before
// (product-tour.test.ts pins the STEPS table and placement only), so this pins
// the sequence a user walks — including the trap of a restart right after the
// user closed the tour, which a "re-run when the stored value changes" effect
// would fall into while the server-sent `autoStart` is still true.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

const h = vi.hoisted(() => ({ pathname: "/", pushed: [] as string[] }));
vi.mock("next/navigation", () => ({
  usePathname: () => h.pathname,
  useRouter: () => ({ push: (to: string) => h.pushed.push(to) }),
}));
// The harness renders one element tree; a portal is just its children here.
vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createPortal: (children: ReactNode) => children,
}));

import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { ProductTour, STEPS, TOUR_STORAGE_KEY } from "../product-tour";
import { routes } from "@/lib/routes";

const ORG = "acme";
const HOME = routes.orgHome(ORG);
const DICT: Record<string, string> = Object.fromEntries(
  STEPS.flatMap((s) => [
    [`tour.${s.id}.title`, `TITLE-${s.id}`],
    [`tour.${s.id}.body`, `BODY-${s.id}`],
  ]).concat([
    ["tour.next", "NEXT"],
    ["tour.back", "BACK"],
    ["tour.skip", "SKIP"],
    ["tour.finish", "FINISH"],
    ["tour.dialogLabel", "TOUR"],
  ]),
);

let session: Map<string, string>;
const posts: string[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  h.pathname = HOME;
  h.pushed = [];
  posts.length = 0;
  session = new Map();
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => session.get(k) ?? null,
    setItem: (k: string, v: string) => void session.set(k, v),
    removeItem: (k: string) => void session.delete(k),
  });
  // No target elements on this "page": every step falls back to the centred card.
  vi.stubGlobal("document", { querySelector: () => null, body: {} });
  vi.stubGlobal("window", {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      posts.push(url);
      return Promise.resolve({ ok: true } as Response);
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Every island is unmounted after its test: the tour store's listeners are
// module-level, so a leftover island from an earlier test would otherwise
// re-render (and run its effects) on this test's writes.
const mounted: { unmount: () => void }[] = [];
afterEach(() => {
  for (const island of mounted.splice(0)) island.unmount();
});
const mount = (autoStart: boolean) => {
  const island = renderIsland(ProductTour, { autoStart, orgSlug: ORG, dict: DICT }, undefined, {
    hydrate: true,
  });
  mounted.push(island);
  return island;
};
const press = (island: ReturnType<typeof mount>, label: string) => {
  const button = island.tree().find((el) => el.type === "button" && propsOf(el).children === label);
  expect(button, `no ${label} button`).toBeDefined();
  (propsOf(button!).onClick as () => void)();
};

describe("ProductTour — the step machine", () => {
  it("server render is empty even with a tour in progress (no portal before hydration)", () => {
    session.set(TOUR_STORAGE_KEY, "1");
    expect(renderToStaticMarkup(<ProductTour autoStart orgSlug={ORG} dict={DICT} />)).toBe("");
  });

  it("auto-starts on the org home: writes step 0 and shows the welcome card", () => {
    const island = mount(true);
    expect(session.get(TOUR_STORAGE_KEY)).toBe("0");
    expect(island.text()).toContain("TITLE-welcome");
  });

  it("empty case: no autoStart and nothing stored shows nothing and writes nothing", () => {
    const island = mount(false);
    expect(island.tree()).toEqual([]);
    expect(session.has(TOUR_STORAGE_KEY)).toBe(false);
  });

  it("resumes a stored step on ITS page, and hides (key kept) on another page", () => {
    session.set(TOUR_STORAGE_KEY, "1"); // org-chip, on the org home
    expect(mount(false).text()).toContain("TITLE-org-chip");

    session.set(TOUR_STORAGE_KEY, "3"); // connect, on the payments page
    const away = mount(false);
    expect(away.tree()).toEqual([]);
    expect(session.get(TOUR_STORAGE_KEY), "the destination page resumes it").toBe("3");
  });

  it("a junk stored step is dropped", () => {
    session.set(TOUR_STORAGE_KEY, "not-a-step");
    expect(mount(false).tree()).toEqual([]);
    expect(session.has(TOUR_STORAGE_KEY)).toBe(false);
  });

  it("Next on the same page advances in place; Next onto another page navigates and hides", () => {
    const island = mount(true);
    press(island, "NEXT");
    expect(session.get(TOUR_STORAGE_KEY)).toBe("1");
    expect(island.text()).toContain("TITLE-org-chip");
    expect(h.pushed).toEqual([]);

    press(island, "NEXT"); // org-rename lives on the settings page
    expect(session.get(TOUR_STORAGE_KEY)).toBe("2");
    expect(h.pushed).toEqual([STEPS[2]!.path(ORG)]);
    expect(island.tree(), "hidden until the destination page resumes it").toEqual([]);
  });

  it("Skip closes it, records completion, and does NOT restart while autoStart is still true", () => {
    const island = mount(true);
    expect(textOf(island.tree())).toContain("TITLE-welcome");
    press(island, "SKIP");
    expect(session.has(TOUR_STORAGE_KEY)).toBe(false);
    expect(island.tree()).toEqual([]);
    expect(posts).toEqual(["/api/tour"]);
    // A later render on the same page (any parent re-render) must not restart it.
    island.rerender({ autoStart: true, orgSlug: ORG, dict: DICT });
    expect(island.tree()).toEqual([]);
    expect(session.has(TOUR_STORAGE_KEY)).toBe(false);
  });
});
