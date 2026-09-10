// The organiser's stream panel (Stream Overlay W1, task 6).
//
// `apps/web` vitest is `environment: "node"` — NO DOM. So this file proves the
// things a static render and a driven island CAN prove: which controls exist,
// what the style strip is BUILT FROM, what the preview is HANDED, which branch
// the Phone tab takes, and what the save button does with a bad link. It cannot
// see wrap, overflow, tap area or the cascade; those are Task 8's e2e.
//
// Two disciplines the wave's own rules impose and this file follows:
//
//   * every expectation about the style strip is DERIVED from
//     `themesForSport` / `defaultThemeFor` — never a table typed here, so a
//     fourth theme moves the test with the registry instead of leaving it
//     asserting yesterday's list (AGENTS.md class 19);
//   * the opaque-preview caption is derived from the DICTIONARY, not from the
//     word "slate" — the panel must not know a theme by name.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";
import { renderIsland, propsOf, walk, expandWithHooks } from "@/components/__tests__/_hook-harness";
import { OverlayStage } from "@/components/overlay/overlay-stage";
import { UpgradeGate } from "@/components/upgrade-gate";
import { defaultThemeFor, themesForSport } from "@/components/overlay/theme-registry";
import { messages } from "@/lib/messages";
import {
  FixtureStreamPanel,
  FixtureStreamToggle,
  CANVAS_H,
  CANVAS_W,
  CREDIT_PACKS,
  PREVIEW_MAX_W_PX,
  previewScaleFor,
  type StreamPanelContext,
  type StreamPanelFixture,
} from "@/components/v2/fixture-stream-panel";

const apiV1 = vi.fn<(url: string, options?: { method?: string; json?: unknown }) => Promise<unknown>>(
  async () => ({}),
);
vi.mock("@/lib/client-v1", () => ({
  apiV1: (url: string, options?: { method?: string; json?: unknown }) => apiV1(url, options),
  ApiV1Error: class extends Error {},
}));

// The preview's own first fetch. Left rejecting by default: the panel must
// render its seed from the ROW, so a failing fetch is the interesting case.
const fetchOverlayFixture = vi.fn(async () => {
  throw new Error("offline");
});
vi.mock("@/components/public-site/live-score-data", () => ({
  fetchOverlayFixture: () => fetchOverlayFixture(),
  fetchLiveFixture: async () => ({}),
  fetchPublicRealtimeToken: async () => ({ token: "", channel: "" }),
}));

const TZ = "Europe/London";

const FIXTURE: StreamPanelFixture = {
  id: "f-1",
  status: "in_play",
  outcome: null,
  scheduled_at: "2026-09-10T14:00:00.000Z",
  home_entrant_id: "e1",
  away_entrant_id: "e2",
};

const ENTRANTS = { e1: "Alpha Athletic", e2: "Bravo Rangers" };

function ctx(o: Partial<StreamPanelContext> = {}): StreamPanelContext {
  return {
    entitled: true,
    relayEntitled: false,
    sportKey: "football",
    overlayDict: {},
    viewerPlan: "community",
    ...o,
  };
}

function open(o: Partial<StreamPanelContext> = {}) {
  return renderIsland(FixtureStreamPanel, {
    fixture: FIXTURE,
    entrantNames: ENTRANTS,
    tz: TZ,
    stream: ctx(o),
  });
}

const attr = (el: ReactElement, name: string): unknown => propsOf(el)[name];
const byTestId = (tree: ReactElement[], id: string): ReactElement | undefined =>
  tree.find((el) => attr(el, "data-testid") === id);
const allTestIds = (tree: ReactElement[], id: string): ReactElement[] =>
  tree.filter((el) => attr(el, "data-testid") === id);

/** The style strip's tabs, in DOM order, by the attribute that marks them —
 *  never by a `stream-tab-` testid prefix, which `stream-tab-obs` also matches. */
const styleTabs = (tree: ReactElement[]): ReactElement[] =>
  tree.filter((el) => typeof attr(el, "data-stream-style") === "string");
const styleIds = (tree: ReactElement[]): string[] =>
  styleTabs(tree).map((el) => String(attr(el, "data-stream-style")));

const click = (el: ReactElement | undefined): void => {
  const onClick = el && (propsOf(el).onClick as (() => void) | undefined);
  if (!onClick) throw new Error("no onClick on that element — the test is asserting nothing");
  onClick();
};

const stageOf = (tree: ReactElement[]): ReactElement => {
  const stage = tree.find((el) => el.type === OverlayStage);
  if (!stage) throw new Error("no <OverlayStage> in the panel — the preview is not the real stage");
  return stage;
};

/** The binding sheet itself — `live-cell-cap.test.ts`'s own path shape. */
const SHEET_PATH = join(
  __dirname,
  "../../../../../..",
  "docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_THEMES.md",
);

const DICT_DIR = join(__dirname, "..", "..", "..", "dictionaries");
const uiDict = (locale: string): Record<string, string> =>
  JSON.parse(readFileSync(join(DICT_DIR, locale, "ui.json"), "utf8"));

beforeEach(() => {
  apiV1.mockClear();
  fetchOverlayFixture.mockClear();
});

describe("the style strip is built from the registry", () => {
  // A sport whose default differs from another's, so an ordering/selection
  // mistake cannot hide behind one lucky constant (AGENTS.md class 19).
  it("premise: two sports really do open on different themes", () => {
    expect(defaultThemeFor("cricket")).not.toBe(defaultThemeFor("football"));
  });

  it.each(["football", "cricket", "badminton"])(
    "%s renders exactly the themes themesForSport returns, in registry order",
    (sportKey) => {
      const tree = open({ sportKey }).tree();
      const expected = themesForSport(sportKey).map((t) => t.id);
      expect(expected.length, "premise: the registry offers more than one theme").toBeGreaterThan(1);
      expect(styleIds(tree)).toEqual(expected);
    },
  );

  it("labels every style tab from the registry's own labelKey, never English typed here", () => {
    const tree = open({ sportKey: "football" }).tree();
    for (const theme of themesForSport("football")) {
      const tab = byTestId(tree, `stream-tab-${theme.id}`);
      expect(tab, `no tab for ${theme.id}`).toBeDefined();
      const label = (messages as Record<string, string>)[theme.labelKey];
      expect(label, `${theme.labelKey} is missing from the ui catalog`).toBeTypeOf("string");
      expect(JSON.stringify(propsOf(tab!).children)).toContain(label);
    }
  });

  it("the OBS/Phone pair is NOT part of the style strip", () => {
    const tree = open().tree();
    expect(styleIds(tree)).not.toContain("obs");
    expect(styleIds(tree)).not.toContain("phone");
    expect(byTestId(tree, "stream-tab-obs"), "the OBS tab").toBeDefined();
    expect(byTestId(tree, "stream-tab-phone"), "the Phone tab").toBeDefined();
  });

  it("every style tab is a real tab (role + aria-selected), exactly one selected", () => {
    const tabs = styleTabs(open().tree());
    for (const tab of tabs) expect(attr(tab, "role")).toBe("tab");
    expect(tabs.filter((t) => attr(t, "aria-selected") === true)).toHaveLength(1);
  });
});

describe("the strip OPENS on the sport's own default, not merely on something", () => {
  it.each(["football", "cricket", "badminton", "tennis", "volleyball"])(
    "%s opens on defaultThemeFor",
    (sportKey) => {
      const tree = open({ sportKey }).tree();
      const selected = styleTabs(tree).find((t) => attr(t, "aria-selected") === true);
      expect(String(attr(selected!, "data-stream-style"))).toBe(defaultThemeFor(sportKey));
    },
  );

  it.each(["football", "cricket"])("%s hands the preview the same default", (sportKey) => {
    const stage = stageOf(open({ sportKey }).tree());
    expect(propsOf(stage).style).toBe(defaultThemeFor(sportKey));
    expect(propsOf(stage).sportKey).toBe(sportKey);
  });

  it("selecting another style moves BOTH the preview and the OBS link", () => {
    const island = open({ sportKey: "football" });
    const other = themesForSport("football").find((t) => t.id !== defaultThemeFor("football"))!;
    click(styleTabs(island.tree()).find((t) => attr(t, "data-stream-style") === other.id));
    expect(propsOf(stageOf(island.tree())).style).toBe(other.id);
    expect(String(propsOf(byTestId(island.tree(), "stream-link")!).value)).toContain(
      `?style=${other.id}`,
    );
  });
});

describe("the preview is the real stage, seeded from the row", () => {
  it("renders <OverlayStage> inside the strip, on the row's own fixture", () => {
    const tree = open().tree();
    expect(byTestId(tree, "stream-preview"), "the 360px strip").toBeDefined();
    const stage = stageOf(tree);
    expect(propsOf(stage).fixtureId).toBe(FIXTURE.id);
    expect(propsOf(stage).fit, "the console preview scales its own wrapper").toBeFalsy();
    expect(propsOf(stage).realtime, "the console never opens a realtime channel").toBe(false);
    const initial = propsOf(stage).initial as { status: string; venueTz: string };
    expect(initial.status, "seeded from the row, so a dead endpoint still previews").toBe(
      FIXTURE.status,
    );
    expect(initial.venueTz, "the VENUE zone, never the org zone").toBe(TZ);
  });

  it("hands the stage the entrant names the row already resolved", () => {
    const stage = stageOf(open().tree());
    const sides = propsOf(stage).sides as { id: string; name: string }[];
    expect(sides.map((s) => s.name)).toEqual([ENTRANTS.e1, ENTRANTS.e2]);
  });

  // _THEMES.md §8, SECOND correction 2026-09-10: **scale to the container**.
  // The first correction (owner ruling, 360px strip) fixed the vertical half
  // only — at a FIXED `scale(640/1920)` the panel still painted a 640px canvas
  // however wide the strip actually was, so at a 320px viewport (~296px panel)
  // about a third of the frame was visible and §3's bar — cricket's default —
  // had its score cells cropped off the right edge with nothing to scroll to.
  //
  // 360 is not lost: it is 640 × 1080/1920, so a capped 640px strip is still
  // 360 tall. It is a consequence of the aspect ratio now instead of a number
  // of its own.
  //
  // WHAT THIS FILE CANNOT SEE: node has no layout, so nothing here measures a
  // strip or proves the observer fires. `previewScaleFor` is the pure half;
  // `stream-overlay.spec.ts`'s "§8: the preview scales to the strip" opens the
  // real console at three viewports and compares the painted canvas box with
  // the strip's own.
  it("the sheet binds a CONTAINER scale, not a constant", () => {
    // Derived from `_THEMES.md`, so a further amendment moves this test rather
    // than leaving it pinning a superseded value — which is exactly what the
    // pair of assertions this replaced had become.
    const sheet = readFileSync(SHEET_PATH, "utf8");
    const row = sheet.split("\n").find((l) => l.includes("| live preview |"));
    expect(row, "§8 no longer has a `live preview` row").toBeDefined();
    expect(row!, "the sheet must still bind scale-to-container").toMatch(/scale\(w\/1920\)/);
  });

  it("the whole authored canvas is visible at EVERY width, not just at one", () => {
    // The invariant, stated the way the sheet states it: authored px across the
    // strip = 1920 at any `w`. A constant satisfies this at exactly one width.
    for (const w of [214, 296, 375, 512, PREVIEW_MAX_W_PX]) {
      expect(w / previewScaleFor(w), `authored px across a ${w}px strip`).toBeCloseTo(CANVAS_W, 6);
    }
  });

  it("the differential — a phone-width strip is NOT the desktop number", () => {
    // The regression this exists for. `640/1920` is what shipped, and it is
    // what a reverted implementation would return at 296 as well.
    expect(previewScaleFor(296), "the defect: 296px of strip painting 640px of canvas").not.toBe(
      PREVIEW_MAX_W_PX / CANVAS_W,
    );
    expect(previewScaleFor(296)).toBe(296 / CANVAS_W);
    // ...and desktop is unchanged, which is what §8's OBS-link copy rests on.
    expect(previewScaleFor(PREVIEW_MAX_W_PX)).toBe(PREVIEW_MAX_W_PX / CANVAS_W);
    expect(PREVIEW_MAX_W_PX * (CANVAS_H / CANVAS_W), "the owner's 360px strip still falls out").toBe(
      360,
    );
  });

  it("the strip is capped at §8's 640, and a degenerate measurement falls back to it", () => {
    expect(previewScaleFor(900), "a wide console must not inflate the graphic").toBe(
      PREVIEW_MAX_W_PX / CANVAS_W,
    );
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(previewScaleFor(bad), `${bad} must not paint a zero-scale canvas`).toBe(
        PREVIEW_MAX_W_PX / CANVAS_W,
      );
    }
  });

  it("the strip is MEASURED and the canvas renders at that scale — not a constant nothing reads", () => {
    const tree = open().tree();
    const strip = byTestId(tree, "stream-preview");
    const style = propsOf(strip!).style as Record<string, unknown>;
    // The pinned pixel height is the thing the correction removed: the strip's
    // height follows its own width now, so there is no second number to drift.
    expect(style.height, "a pinned pixel height is a fixed scale wearing a hat").toBeUndefined();
    expect(style.aspectRatio).toBe(`${CANVAS_W} / ${CANVAS_H}`);
    expect(style.maxWidth).toBe(PREVIEW_MAX_W_PX);
    // A ref on the strip is what makes the scale a MEASUREMENT. Without it
    // nothing observes the box and `previewScaleFor` can only ever be handed
    // its own fallback — the constant, back again, with a function around it.
    expect(propsOf(strip!).ref, "nothing measures the strip").toBeDefined();
    const canvas = byTestId(tree, "stream-preview-canvas");
    const cstyle = propsOf(canvas!).style as Record<string, unknown>;
    expect(cstyle.width).toBe(CANVAS_W);
    expect(cstyle.height).toBe(CANVAS_H);
    // Unmeasured (no layout here), so this is the fallback — but it must be
    // the FUNCTION's fallback, not a literal beside it.
    expect(cstyle.transform).toBe(`scale(${previewScaleFor(PREVIEW_MAX_W_PX)})`);
    expect(String(propsOf(strip!).className), "no h-24 (96px) left behind").not.toMatch(/\bh-\d/);
  });
});

describe("the opaque-preview caption is dictionary-driven, not theme-named", () => {
  const captionKeyFor = (id: string) => `stream.preview.${id}`;
  const en = uiDict("en");
  const withCaption = themesForSport("football")
    .map((t) => t.id)
    .filter((id) => typeof en[captionKeyFor(id)] === "string");

  it("premise: at least one shipped theme declares a preview caption", () => {
    expect(withCaption.length).toBeGreaterThan(0);
  });

  it("every declared caption exists in all four locales", () => {
    for (const locale of ["en", "fr", "es", "nl"]) {
      const dict = uiDict(locale);
      for (const id of withCaption) {
        expect(typeof dict[captionKeyFor(id)], `${locale} is missing ${captionKeyFor(id)}`).toBe(
          "string",
        );
      }
    }
  });

  it("shows the caption for a theme that declares one and for no other", () => {
    for (const theme of themesForSport("football")) {
      const island = open({ sportKey: "football" });
      click(styleTabs(island.tree()).find((t) => attr(t, "data-stream-style") === theme.id));
      const note = byTestId(island.tree(), "stream-preview-note");
      if (withCaption.includes(theme.id)) {
        expect(note, `${theme.id} declares a caption`).toBeDefined();
        expect(JSON.stringify(propsOf(note!).children)).toContain(en[captionKeyFor(theme.id)]);
      } else {
        expect(note, `${theme.id} declares no caption`).toBeUndefined();
      }
    }
  });
});

describe("the stream-link field refuses a bad link before it sends", () => {
  const type = (island: ReturnType<typeof open>, value: string) => {
    const input = byTestId(island.tree(), "stream-url-input")!;
    (propsOf(input).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
  };

  it("an off-list host is refused inline and NEVER reaches the API", async () => {
    const island = open();
    type(island, "https://evil.example/www.youtube.com");
    await (propsOf(byTestId(island.tree(), "stream-save")!).onClick as () => Promise<void>)();
    const error = byTestId(island.tree(), "stream-error");
    expect(error, "no inline error rendered").toBeDefined();
    expect(JSON.stringify(propsOf(error!).children)).toContain(messages["stream.error.link"]);
    expect(apiV1).not.toHaveBeenCalled();
  });

  it("an allowed host PUTs the fixture's stream route and reaches Saved", async () => {
    const island = open();
    const url = "https://www.youtube.com/watch?v=abc";
    type(island, url);
    expect(JSON.stringify(propsOf(byTestId(island.tree(), "stream-save")!).children)).toContain(
      messages["stream.save"],
    );
    await (propsOf(byTestId(island.tree(), "stream-save")!).onClick as () => Promise<void>)();
    expect(apiV1).toHaveBeenCalledTimes(1);
    expect(apiV1.mock.calls[0]![0]).toBe(`/api/v1/fixtures/${FIXTURE.id}/stream`);
    expect(apiV1.mock.calls[0]![1]).toMatchObject({ method: "PUT", json: { streamUrl: url } });
    expect(JSON.stringify(propsOf(byTestId(island.tree(), "stream-save")!).children)).toContain(
      messages["stream.saved"],
    );
    expect(byTestId(island.tree(), "stream-error")).toBeUndefined();
  });

  it("an empty field CLEARS the link (null on the wire), it is not an error", async () => {
    const island = open();
    type(island, "   ");
    await (propsOf(byTestId(island.tree(), "stream-save")!).onClick as () => Promise<void>)();
    expect(byTestId(island.tree(), "stream-error")).toBeUndefined();
    expect(apiV1.mock.calls[0]![1]).toMatchObject({ json: { streamUrl: null } });
  });
});

describe("the Phone tab reads the §5.3 gate and ships nothing else", () => {
  const phone = (o: Partial<StreamPanelContext>) => {
    const island = open(o);
    click(byTestId(island.tree(), "stream-tab-phone"));
    return island;
  };

  it("without streaming.relay it is the UpgradeGate for THAT key", () => {
    const tree = phone({ relayEntitled: false }).tree();
    expect(byTestId(tree, "stream-phone-gate"), "the gate card").toBeDefined();
    const gate = tree.find((el) => el.type === UpgradeGate);
    expect(gate, "no <UpgradeGate>").toBeDefined();
    expect(propsOf(gate!).feature).toBe("streaming.relay");
    expect(byTestId(tree, "stream-buy-soon"), "credits must not be offered").toBeUndefined();
  });

  it("with streaming.relay it is the buy-credits card, inert in W1", () => {
    const tree = phone({ relayEntitled: true }).tree();
    expect(tree.find((el) => el.type === UpgradeGate), "no upsell once entitled").toBeUndefined();
    const soon = byTestId(tree, "stream-buy-soon");
    expect(soon, "the placeholder CTA").toBeDefined();
    expect(propsOf(soon!).disabled, "R1 owns checkout; W1's button is inert").toBe(true);
    const packs = allTestIds(tree, "stream-credit-pack");
    expect(packs).toHaveLength(CREDIT_PACKS.length);
    expect(packs.map((p) => Number(attr(p, "data-pack")))).toEqual(
      CREDIT_PACKS.map((p) => p.matches),
    );
    for (const pack of packs) expect(propsOf(pack).disabled).toBe(true);
  });

  it("the OBS tab's own body is gone while Phone is selected, and comes back", () => {
    const island = phone({ relayEntitled: true });
    expect(byTestId(island.tree(), "stream-preview")).toBeUndefined();
    click(byTestId(island.tree(), "stream-tab-obs"));
    expect(byTestId(island.tree(), "stream-preview")).toBeDefined();
    expect(byTestId(island.tree(), "stream-phone-gate")).toBeUndefined();
  });
});

describe("phone first — the 44px floor is the BASE, not an override", () => {
  // §8: "at 320 every control full width and 44 px tall, tabs 44 px". Written
  // mobile-first, so the floor must be on the UNPREFIXED class: a
  // `max-md:h-11` would satisfy the rendered page only by out-ordering a base
  // utility in the generated CSS, which nothing in a node-environment suite
  // can see. This asserts the spelling that needs no ordering at all.
  const TAPPABLE = /(^|\s)(min-h-11|h-11)(\s|$)/;

  it("every control an organiser taps carries it", () => {
    const seen: string[] = [];
    const check = (el: ReactElement | undefined, what: string) => {
      expect(el, `${what} did not render`).toBeDefined();
      seen.push(what);
      expect(
        String(propsOf(el!).className ?? ""),
        `${what} has no unprefixed 44px floor`,
      ).toMatch(TAPPABLE);
    };
    for (const relayEntitled of [false, true]) {
      const island = open({ relayEntitled });
      for (const tab of styleTabs(island.tree())) check(tab, `style tab ${attr(tab, "data-stream-style")}`);
      for (const id of ["stream-tab-obs", "stream-tab-phone", "stream-link", "stream-copy", "stream-url-input", "stream-save"]) {
        check(byTestId(island.tree(), id), id);
      }
      click(byTestId(island.tree(), "stream-tab-phone"));
      if (relayEntitled) {
        for (const pack of allTestIds(island.tree(), "stream-credit-pack")) check(pack, "credit pack");
        check(byTestId(island.tree(), "stream-buy-soon"), "stream-buy-soon");
      }
    }
    // The positive pair: without it an empty tree passes every check above.
    expect(seen.length, "nothing was checked").toBeGreaterThanOrEqual(20);
  });

  it("and the toggle in the row itself does too", () => {
    const button = walk(expandWithHooks(FixtureStreamToggle, { open: false, onToggle: () => {} })).find(
      (el) => attr(el, "data-testid") === "fixture-stream-toggle",
    );
    expect(String(propsOf(button!).className ?? "")).toMatch(TAPPABLE);
  });
});

describe("one DOM, branched — never a second phone tree", () => {
  it("nothing in the panel is hidden by width, at either tab", () => {
    for (const relayEntitled of [false, true]) {
      const island = open({ relayEntitled });
      for (const testId of ["stream-tab-obs", "stream-tab-phone"]) {
        click(byTestId(island.tree(), testId));
        const hidden = island
          .tree()
          .map((el) => String(propsOf(el).className ?? ""))
          .filter((cls) => /(^|\s)(max-)?md:hidden(\s|$)/.test(cls));
        expect(hidden, `${testId} hides a control by width`).toEqual([]);
      }
    }
  });
});

describe("the toggle", () => {
  it("carries the wave's testid, an accessible name and its expanded state", () => {
    const tree = walk(expandWithHooks(FixtureStreamToggle, { open: false, onToggle: () => {} }));
    const button = byTestId(tree, "fixture-stream-toggle");
    expect(button, "no fixture-stream-toggle").toBeDefined();
    expect(propsOf(button!)["aria-expanded"]).toBe(false);
    expect(propsOf(button!)["aria-label"]).toBe(messages["stream.toggle"]);
  });
});
