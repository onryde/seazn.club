// Phone composition of the Chess Quest hub — design of record:
// scratchpad games-phone-options.html, "Quest hub on a phone".
//
// The hub used to be one 2,650px column at 320: header, then all 62 day
// chips, and only THEN the lesson card — the one thing a player comes to
// tap — 1,900px down the page. On phones the order is now header → view
// switch → today's lesson → map → grown-ups, expressed as `max-md:order-*`
// on wrappers over ONE DOM (never a second phone tree), so ≥768 keeps
// today's source order and the ≥1024 two-column grid untouched.
//
// This suite renders through react-dom/server (this workspace has no jsdom —
// see Board.test.tsx's header). It therefore pins the ORDER CLASSES and the
// single-tree property; the geometry itself is proven in a browser by
// mobile.spec.ts's width matrix.
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ChessQuest from "../index";

// Rendered in a hook, never at module scope: a throw while collecting a file
// yields ZERO tests, which a summary reads as green (AGENTS.md failure class
// 9). The same throw inside beforeAll fails every test in the file, loudly.
let html = "";
beforeAll(() => {
  html = renderToStaticMarkup(<ChessQuest />);
});

// The opening tag of the wrapper carrying data-cq-slot="<slot>".
function slotTag(slot: string): string {
  const at = html.indexOf(`data-cq-slot="${slot}"`);
  expect(at, `no wrapper carries data-cq-slot="${slot}"`).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<", at);
  return html.slice(start, html.indexOf(">", at) + 1);
}

function count(needle: string): number {
  return html.split(needle).length - 1;
}

// Matches a class token exactly, anchored on the quote/space that precedes
// it — a bare /\bmd:order-1\b/ also matches inside "max-md:order-1", so an
// assertion written that way passes on its own inversion.
function cls(name: string): RegExp {
  return new RegExp(`["\\s]${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s"]`);
}

describe("quest hub — phone order (max-md:order-*)", () => {
  // Two ordering contexts, each numbered from 1: the page column
  // (header/switch/grid) and the lesson+map grid (lesson/map/grown-ups),
  // whose right column collapses to `contents` on phones so its children
  // sort alongside the map. `order` only sorts within its own container,
  // so the two 1s never compete.
  const PAGE_ORDER: [string, number][] = [
    ["header", 1],
    ["switch", 2],
    ["grid", 3],
  ];
  const GRID_ORDER: [string, number][] = [
    ["lesson", 1],
    ["map", 2],
    ["grownups", 3],
  ];

  for (const [slot, n] of [...PAGE_ORDER, ...GRID_ORDER]) {
    it(`${slot} sits at position ${n} on phones`, () => {
      expect(slotTag(slot)).toMatch(cls(`max-md:order-${n}`));
    });
  }

  it("the lesson/grown-ups column becomes `contents` on phones, so the lesson can outrank the map", () => {
    // Without this the right column stays one box and the map — its grid
    // sibling — renders above BOTH the lesson card and the drawer, which is
    // exactly the 1,900px scroll this composition exists to remove.
    expect(slotTag("lesson-column")).toMatch(cls("max-md:contents"));
  });

  it("desktop order is source order: switch, header, grid — no md:order-* overrides", () => {
    const at = (slot: string) => html.indexOf(`data-cq-slot="${slot}"`);
    expect(at("switch")).toBeLessThan(at("header"));
    expect(at("header")).toBeLessThan(at("grid"));
    expect(at("lesson")).toBeGreaterThan(at("map"));
    // A `md:order-*` (as opposed to `max-md:order-*`) would move ≥768 too.
    expect(html.replace(/max-md:order-\d/g, "")).not.toMatch(/\bmd:order-\d/);
  });

  it("keeps the ≥1024 two-column grid", () => {
    expect(slotTag("grid")).toMatch(cls("lg:grid-cols-2"));
  });

  // The free-play view needs a tap to reach and this workspace has no DOM, so
  // this one reads the source. It is not decoration: the switch carries
  // max-md:order-2, so an arcade grid left at the default order 0 sorts ABOVE
  // it on phones and buries the Quest/Free play control under ten cards.
  it("orders the free-play grid below the switch on phones too", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../index.tsx"), "utf8");
    const arcadeAt = src.indexOf("{ARCADE.map(");
    expect(arcadeAt, "the arcade branch moved — repoint this test").toBeGreaterThan(-1);
    const gridTag = src.slice(src.lastIndexOf('<div className="grid', arcadeAt), arcadeAt);
    expect(gridTag).toMatch(cls("max-md:order-3"));
    expect(slotTag("switch")).toMatch(cls("max-md:order-2"));
  });
});

describe("quest hub — one DOM, branched (no second phone tree)", () => {
  it("mounts exactly one lesson card, one map and one grown-ups drawer", () => {
    expect(count('data-cq-slot="lesson"')).toBe(1);
    expect(count('data-cq-slot="map"')).toBe(1);
    expect(count('data-cq-slot="grownups"')).toBe(1);
    // The card's own mark-done control, as a content-level cross-check that
    // the card itself is not duplicated behind the wrapper count.
    expect(count("Mark day done")).toBe(1);
  });

  it("gives the lesson card's actions and the view switch a 44px phone tap target", () => {
    // `.btn` is 36px; the card is the first thing under the thumb on a phone.
    const buttonTagAround = (at: number) => {
      expect(at, "no such control").toBeGreaterThan(-1);
      const start = html.lastIndexOf("<button", at);
      return html.slice(start, html.indexOf(">", start) + 1);
    };
    for (const label of ["Play Square Race", "Mark day done"]) {
      expect(
        buttonTagAround(html.indexOf(label)),
        `"${label}" is under 44px on phones`,
      ).toMatch(cls("max-md:min-h-11"));
    }
    for (const label of ["Quest", "Free play"]) {
      expect(
        buttonTagAround(html.indexOf(`>${label}<`)),
        `the "${label}" switch is under 44px on phones`,
      ).toMatch(cls("max-md:min-h-11"));
    }
  });

  it("mounts exactly one Quest/Free play switch", () => {
    expect(count(">Free play<")).toBe(1);
    expect(count(">Quest<")).toBe(1);
  });

  it("hides nothing on the hub's own wrappers at every width", () => {
    // A bare `hidden` on one of these wrappers would blank the slot on
    // DESKTOP too — the failure mode a `max-md:`-only branch cannot have.
    for (const slot of ["header", "switch", "grid", "lesson", "map", "grownups"]) {
      expect(slotTag(slot), `${slot} is hidden at every width`).not.toMatch(cls("hidden"));
    }
  });
});
