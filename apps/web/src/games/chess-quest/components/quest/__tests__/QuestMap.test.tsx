// The quest map on a phone — design of record: scratchpad
// games-phone-options.html, "Quest hub on a phone" ("Map as rows").
//
// At 320 the map used to render all 62 day chips inside 11 land cards, a
// ~1,400px wall between the header and the lesson card. Each land is now a
// collapsed row (glyph · name · Days a–b · n of m · chevron) that expands to
// its chips; the land holding the CURRENT lesson opens by default. ≥768 is
// unchanged: every chip stays visible, so the collapse is expressed as
// `max-md:hidden` and never a bare `hidden`.
//
// Rendered through react-dom/server — this workspace has no jsdom (see
// Board.test.tsx's header). Interaction (tapping a row) is a browser
// concern; what a static render CAN prove is the default-open land, that a
// closed land contributes no visible day button at 320, and that ≥768 still
// shows them all.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LANDS } from "../../../content/lands";
import { LESSONS } from "../../../content/lessons";
import { ProgressProvider } from "../../../lib/progress";
import { collapseInForce, QuestMap } from "../QuestMap";
import { dayOf } from "../questData";

// ProgressProvider reads window.localStorage at init (it only ever mounts in
// the browser). Stubbing `window` is how this suite seeds a player who is
// PAST land 1 — without it every render defaults to lesson 1 and a mutant
// that simply opens LANDS[0] would pass.
function renderMap(weeksDone: number[] = []): string {
  if (weeksDone.length) {
    const blob = {
      active: "p1",
      seq: 1,
      muted: false,
      voiceOff: false,
      profiles: {
        p1: {
          name: "",
          mode: "classic",
          weeks: Object.fromEntries(weeksDone.map((n) => [n, true])),
          stars: {},
          best: {},
          solved: [],
          solved2: [],
          hunts: [],
          tactics: {},
          activity: [],
          created: "2026-01-01",
        },
      },
    };
    const raw = JSON.stringify(blob);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => (k === "seazn-games:chess-quest:v1" ? raw : null),
        setItem: () => {},
        removeItem: () => {},
      },
    });
  }
  return renderToStaticMarkup(
    <ProgressProvider>
      <QuestMap selected={weeksDone.length ? weeksDone.length + 1 : 1} onSelect={() => {}} />
    </ProgressProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function tagWith(html: string, attr: string): string {
  const at = html.indexOf(attr);
  expect(at, `no element carries ${attr}`).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<", at);
  return html.slice(start, html.indexOf(">", at) + 1);
}

// Matches a class token exactly, anchored on the quote/space before it: a
// bare /\bmd:hidden\b/ also matches inside "max-md:hidden", so an assertion
// written that way passes on its own inversion.
function cls(name: string): RegExp {
  return new RegExp(`["\\s]${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s"]`);
}

const daysId = (landId: number) => `cq-land-${landId}-days`;
const chipsTag = (html: string, landId: number) => tagWith(html, `id="${daysId(landId)}"`);
const toggleTag = (html: string, landId: number) =>
  tagWith(html, `aria-controls="${daysId(landId)}"`);

// A closed land is hidden at phone widths only.
const hiddenOnPhones = (tag: string) => cls("max-md:hidden").test(tag);
// …never at every width, which would blank it on desktop too.
const hiddenEverywhere = (tag: string) => cls("hidden").test(tag);

describe("QuestMap — lands collapse to rows on phones", () => {
  it("opens the land holding the current lesson and closes the rest (fresh player: land 1)", () => {
    const html = renderMap();
    expect(toggleTag(html, LANDS[0].id)).toContain('aria-expanded="true"');
    expect(hiddenOnPhones(chipsTag(html, LANDS[0].id))).toBe(false);
    for (const land of LANDS.slice(1)) {
      expect(toggleTag(html, land.id), `land ${land.id} should start closed`).toContain(
        'aria-expanded="false"',
      );
      expect(hiddenOnPhones(chipsTag(html, land.id)), `land ${land.id} chips`).toBe(true);
    }
  });

  // The differential case: a player who has finished lessons 1–12 is CURRENT
  // on lesson 13, which lives in land 4 — so land 4 opens and land 1 does
  // not. Replacing the default-open logic with a constant (LANDS[0]) passes
  // the fresh-player case above and dies here.
  it("opens land 4 for a player currently on lesson 13, and land 1 is closed", () => {
    const html = renderMap([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const current = LANDS.find((l) => 13 >= l.weeks[0] && 13 <= l.weeks[1])!;
    expect(current.id).toBe(4);
    expect(toggleTag(html, current.id)).toContain('aria-expanded="true"');
    expect(hiddenOnPhones(chipsTag(html, current.id))).toBe(false);
    expect(toggleTag(html, LANDS[0].id)).toContain('aria-expanded="false"');
    expect(hiddenOnPhones(chipsTag(html, LANDS[0].id))).toBe(true);
  });

  it("a closed land is hidden on phones only — every chip still renders at ≥768", () => {
    const html = renderMap();
    for (const land of LANDS) {
      expect(hiddenEverywhere(chipsTag(html, land.id)), `land ${land.id}`).toBe(false);
    }
    // Every lesson keeps a day button at every width (the e2e suite clicks
    // Day 33 / Day 41 at 1280 by this exact accessible name).
    expect(html.split("aria-label=\"Day ").length - 1).toBe(LESSONS.length);
    expect(html).toContain(`aria-label="Day ${dayOf(17)}: ${LESSONS[16].title}"`);
  });

  it("shows an n-of-m day count per land, on phones only", () => {
    const html = renderMap([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const land1 = LANDS[0];
    const land4 = LANDS[3];
    const total = (l: (typeof LANDS)[number]) => l.weeks[1] - l.weeks[0] + 1;
    const tag1 = tagWith(html, `>4 of ${total(land1)} done<`);
    expect(tag1).toMatch(cls("md:hidden"));
    expect(html).toContain(`>0 of ${total(land4)} done<`);
  });
});

// `md:pointer-events-none` on the land row blocks the pointer, not the
// keyboard: at ≥768 a keyboard user could Tab to the row, press Enter, and
// flip aria-expanded to false over a land whose chips are ALL still on screen
// (the collapse is `max-md:hidden` and nothing else). `tabindex` cannot be
// varied by a media query, so the fix is behavioural — the toggle no-ops
// wherever the collapse is not in force.
//
// The gate's OWN predicate is unit-testable; the click that consults it is
// not (this workspace has no jsdom — see the file header), so the keyboard
// half is a browser concern.
describe("QuestMap — the land toggle is inert where the collapse is not", () => {
  it("holds the collapse in force below md only, and never during SSR", () => {
    // No window at all: server render, where there is nothing to toggle.
    expect(collapseInForce()).toBe(false);

    const asked: string[] = [];
    vi.stubGlobal("window", {
      matchMedia: (q: string) => {
        asked.push(q);
        return { matches: true };
      },
    });
    expect(collapseInForce()).toBe(true);
    // Pinned to Tailwind's `md` minus one: a query that drifted off the
    // breakpoint would gate the toggle at a width the CSS does not collapse.
    expect(asked).toEqual(["(max-width: 767px)"]);

    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    expect(collapseInForce()).toBe(false);

    // A browser too old for matchMedia is treated as "no collapse" rather
    // than throwing inside a click handler.
    vi.stubGlobal("window", {});
    expect(collapseInForce()).toBe(false);
  });

  it("still renders aria-expanded from state, so the attribute stays honest below md", () => {
    const html = renderMap();
    expect(toggleTag(html, LANDS[0].id)).toContain('aria-expanded="true"');
    expect(toggleTag(html, LANDS[1].id)).toContain('aria-expanded="false"');
    // The pointer half of the same rule, unchanged.
    expect(toggleTag(html, LANDS[0].id)).toMatch(cls("md:pointer-events-none"));
  });
});

describe("QuestMap — phone tap targets", () => {
  it("every day chip is 44px on phones and keeps its desktop size", () => {
    const html = renderMap();
    const chips = html.match(/<button[^>]*aria-label="Day [^"]*"[^>]*>/g) ?? [];
    expect(chips.length).toBe(LESSONS.length);
    for (const chip of chips) {
      expect(chip).toMatch(cls("max-md:h-11"));
      expect(chip).toMatch(cls("max-md:min-w-11"));
      expect(chip).toMatch(cls("h-9"));
    }
  });

  it("every land row is a 48px control on phones", () => {
    const html = renderMap();
    for (const land of LANDS) {
      expect(toggleTag(html, land.id), `land ${land.id} row`).toMatch(cls("max-md:min-h-12"));
    }
  });
});
