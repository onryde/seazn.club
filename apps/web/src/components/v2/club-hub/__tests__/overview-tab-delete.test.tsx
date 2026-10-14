// The club hub's danger zone (overview-tab.tsx). Two defects, one handler:
//
// 1. `run()` swallowed a failed DELETE — it caught the error, put it on the
//    page, and returned normally — and the click handler then navigated away
//    regardless. The organiser landed on the directory with the error left
//    behind on a page they could no longer see, and read the club as deleted
//    when it was still there.
// 2. The navigation was `router.push`, so Back restored the deleted club's
//    page from the client router cache.
// 3. (Owner option A, 2026-10-14) Even once it stayed put, the refusal
//    rendered in the tab's TOP banner — off-screen at every width when the
//    organiser is down at the Delete button (320: 1136px above the fold). A
//    delete failure, and its paywall, now render inside the danger zone,
//    beside the button; every other failure on the tab stays at the top.
//
// INTERACTION test on purpose (`renderIsland`, not `renderToStaticMarkup`):
// both defects live in what the click DOES with the DELETE's outcome, which a
// static render cannot exercise (repo standing trap: "pure-builder tests
// cannot see wiring").
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { OverviewTab } from "../overview-tab";
import { t } from "@/lib/i18n-runtime";
import uiEn from "@/dictionaries/en/ui.json";

const testMsg = (key: string, vars?: Record<string, string | number>) => t(uiEn, key, vars);

const h = vi.hoisted(() => ({
  calls: [] as { url: string; method?: string }[],
  /** What the DELETE does this test: resolve, or throw this error. */
  deleteOutcome: null as null | Error,
  /** What the profile PATCH does: resolve, or throw this error. */
  patchOutcome: null as null | Error,
  /** What the confirm dialog answers. */
  confirmAnswer: true,
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual, // ApiV1Error stays the REAL class — `run()` branches on it.
    apiV1: vi.fn(async (url: string, options?: { method?: string }) => {
      h.calls.push({ url, method: options?.method });
      if (options?.method === "DELETE" && h.deleteOutcome) throw h.deleteOutcome;
      if (options?.method === "PATCH" && h.patchOutcome) throw h.patchOutcome;
      return {};
    }),
  };
});

vi.mock("next/navigation", () => ({ useRouter: () => h.router }));

vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => () => Promise.resolve(h.confirmAnswer),
}));

const CLUB = {
  id: "club-1",
  name: "Doomed FC",
  short_name: null,
  slug: null,
  logo_path: null,
  colors: null,
  external_ref: null,
  home_ground: null,
  website: null,
  notes: null,
  contacts: [],
};

function render() {
  return renderIsland(OverviewTab, {
    club: CLUB,
    canEdit: true,
    storageBase: "https://storage.example",
    viewerPlan: "pro" as const,
  });
}

function deleteButton(island: ReturnType<typeof render>) {
  const label = testMsg("clubs.delete");
  const found = island
    .tree()
    .filter((e) => e.type === "button" && textOf(propsOf(e).children as never) === label);
  // Exactly one: a second "Delete" (a contact row's) would make this click
  // ambiguous, and the test would be pinning whichever came first.
  expect(found).toHaveLength(1);
  return propsOf(found[0]!).onClick as () => Promise<void>;
}

/** The danger-zone card: the one <section> whose subtree holds the Delete button. */
function dangerZone(island: ReturnType<typeof render>): ReactElement {
  const label = testMsg("clubs.delete");
  const zones = island
    .tree()
    .filter(
      (e) =>
        e.type === "section" &&
        walk(propsOf(e).children as never).some(
          (c) => c.type === "button" && textOf(propsOf(c).children as never) === label,
        ),
    );
  expect(zones).toHaveLength(1);
  return zones[0]!;
}

/** Every role="alert" carrying `text`, split by where it renders. */
function alertsSaying(island: ReturnType<typeof render>, text: string) {
  const says = (e: ReactElement) => propsOf(e).role === "alert" && textOf(propsOf(e).children as never).includes(text);
  const inZone = walk(propsOf(dangerZone(island)).children as never).filter(says).length;
  const everywhere = island.tree().filter(says).length;
  return { inZone, elsewhere: everywhere - inZone };
}

const deletes = () => h.calls.filter((c) => c.method === "DELETE");
const navigations = () => h.router.push.mock.calls.length + h.router.replace.mock.calls.length;

describe("club hub danger zone — Delete", () => {
  beforeEach(() => {
    h.calls.length = 0;
    h.deleteOutcome = null;
    h.patchOutcome = null;
    h.confirmAnswer = true;
    h.router.push.mockClear();
    h.router.replace.mockClear();
    h.router.refresh.mockClear();
  });

  it("a DELETE the server refuses keeps the organiser on the club, with the server's reason on screen", async () => {
    const { ApiV1Error } = await import("@/lib/client-v1");
    h.deleteOutcome = new ApiV1Error("Club still has entries in a live division.", 409, "CONFLICT");
    const island = render();
    expect(island.text()).not.toContain("Club still has entries in a live division.");

    await deleteButton(island)();

    expect(deletes()).toHaveLength(1);
    expect(navigations()).toBe(0);
    // Beside the button that caused it, once — not in the tab's top banner.
    expect(alertsSaying(island, "Club still has entries in a live division.")).toEqual({ inZone: 1, elsewhere: 0 });
  });

  it("a DELETE that throws a non-Error still stays put and shows the fallback sentence", async () => {
    h.deleteOutcome = "socket hang up" as unknown as Error;
    const island = render();

    await deleteButton(island)();

    expect(deletes()).toHaveLength(1);
    expect(navigations()).toBe(0);
    expect(alertsSaying(island, testMsg("clubs.overview.saveFailed"))).toEqual({ inZone: 1, elsewhere: 0 });
  });

  it("a DELETE refused on plan stays put and shows the upgrade gate, not a navigation", async () => {
    const { ApiV1Error } = await import("@/lib/client-v1");
    h.deleteOutcome = new ApiV1Error("Upgrade", 402, "PAYMENT_REQUIRED", { feature_key: "clubs.hub" });
    const island = render();

    await deleteButton(island)();

    expect(navigations()).toBe(0);
    const isGate = (e: ReactElement) => propsOf(e).feature === "clubs.hub";
    expect(walk(propsOf(dangerZone(island)).children as never).filter(isGate)).toHaveLength(1);
    expect(island.tree().filter(isGate)).toHaveLength(1); // and not also at the top
  });

  it("a failure that is NOT the delete (the profile save) stays in the tab's top banner", async () => {
    h.patchOutcome = new Error("Slug already taken.");
    const island = render();
    const save = island
      .tree()
      .filter((e) => e.type === "button" && textOf(propsOf(e).children as never) === testMsg("clubs.overview.save"));
    expect(save).toHaveLength(1);

    await (propsOf(save[0]!).onClick as () => Promise<void>)();

    expect(alertsSaying(island, "Slug already taken.")).toEqual({ inZone: 0, elsewhere: 1 });
  });

  it("a DELETE that succeeds REPLACES the history entry with the directory, so Back cannot restore the deleted club", async () => {
    const island = render();

    await deleteButton(island)();

    expect(deletes()).toHaveLength(1);
    expect(h.router.replace.mock.calls).toEqual([["/directory?tab=clubs"]]);
    expect(h.router.push).not.toHaveBeenCalled();
  });

  it("cancelling the confirm sends nothing and goes nowhere", async () => {
    h.confirmAnswer = false;
    const island = render();

    await deleteButton(island)();

    expect(deletes()).toHaveLength(0);
    expect(navigations()).toBe(0);
  });

  it("a refused DELETE, then a retry that succeeds: the retry navigates (the failure leaves no latch)", async () => {
    const { ApiV1Error } = await import("@/lib/client-v1");
    h.deleteOutcome = new ApiV1Error("Try again shortly.", 503, "UNAVAILABLE");
    const island = render();

    await deleteButton(island)();
    expect(navigations()).toBe(0);
    expect(island.text()).toContain("Try again shortly.");

    h.deleteOutcome = null;
    await deleteButton(island)();

    expect(deletes()).toHaveLength(2);
    expect(h.router.replace.mock.calls).toEqual([["/directory?tab=clubs"]]);
  });
});
