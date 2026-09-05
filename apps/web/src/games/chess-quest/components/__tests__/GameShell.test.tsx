// GameShell's phone composition (Option 1 — "Board first, picks in a sheet",
// docs design of record 2026-09-05). Every game used to render ONE `max-w-xl`
// column with zero breakpoint classes, so 320px was the desktop control set
// shrunk. The shell now branches ONE DOM with `max-md:*` / `md:hidden`:
//
//   phone   header → subtitle → board → coach → extra → sticky controls
//   desktop header → coach → subtitle → picker (inline) → extra → board → controls
//
// This workspace has no jsdom (vitest `environment: "node"` — see
// Board.test.tsx), so the branch is pinned by CLASSES on the rendered markup
// rather than by measuring boxes. That is exactly the blind spot the repo's
// own rules call out, so the assertions here anchor on the class token with
// its delimiters: a bare /md:hidden/ ALSO matches inside `max-md:hidden` and
// would pass on its own inversion.
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GameShell } from "../GameShell";
import { PuzzleDots } from "../games/PuzzleDots";
import { nextTier, TacticTrainer } from "../games/TacticTrainer";
import { ProgressProvider } from "../../lib/progress";

/** `md:hidden` as a whole class token — never the tail of `max-md:hidden`. */
const MD_HIDDEN = /["\s]md:hidden(?=["\s])/;
/** `max-md:hidden` as a whole class token. */
const MAX_MD_HIDDEN = /["\s]max-md:hidden(?=["\s])/;

function idx(html: string, key: string): number {
  const at = html.indexOf(`data-cq="${key}"`);
  if (at === -1) throw new Error(`data-cq="${key}" not found in markup`);
  return at;
}

/** The opening tag of the element carrying `data-cq="<key>"`. */
function tagFor(html: string, key: string): string {
  const at = idx(html, key);
  const start = html.lastIndexOf("<", at);
  const end = html.indexOf(">", at);
  if (start === -1 || end === -1) throw new Error(`malformed tag around data-cq="${key}"`);
  return html.slice(start, end + 1);
}

/** The `max-md:order-N` a slot carries, i.e. its position in the phone column. */
function phoneOrder(html: string, key: string): number {
  const m = tagFor(html, key).match(/["\s]max-md:order-(\d+)(?=["\s])/);
  if (!m) throw new Error(`data-cq="${key}" carries no max-md:order-* class`);
  return Number(m[1]);
}

function renderShell(
  opts: { picker?: boolean; subtitle?: boolean; controls?: boolean } = {},
): string {
  const { picker = true, subtitle = true, controls = true } = opts;
  return renderToStaticMarkup(
    <GameShell
      title="Mate in 1"
      score="🧩 2 / 5 solved"
      status="Coach says <strong>go</strong>"
      subtitle={subtitle ? <span>SUBTITLE-MARKER</span> : undefined}
      picker={
        picker
          ? {
              label: "Packs",
              children: (
                <button type="button">PICKER-CHILD-MARKER</button>
              ),
            }
          : undefined
      }
      extra={<PuzzleDots count={5} current={2} isSolved={(i) => i === 0} onPick={() => {}} />}
      controls={
        controls ? (
          <>
            <button type="button">Hint</button>
            <button type="button">Start pack over</button>
          </>
        ) : undefined
      }
    >
      <div>BOARD-MARKER</div>
    </GameShell>,
  );
}

describe("GameShell — phone composition (one DOM, branched)", () => {
  it("orders the phone column header → subtitle → board → coach → extra → controls", () => {
    const html = renderShell();
    expect(phoneOrder(html, "header")).toBe(1);
    expect(phoneOrder(html, "subtitle")).toBe(2);
    expect(phoneOrder(html, "board-slot")).toBe(3);
    expect(phoneOrder(html, "coach")).toBe(4);
    expect(phoneOrder(html, "extra")).toBe(5);
    expect(phoneOrder(html, "controls")).toBe(6);
  });

  it("keeps the DESKTOP source order header → coach → subtitle → picker → extra → board", () => {
    const html = renderShell();
    // Source order IS desktop order — no `md:order-*` anywhere, so the
    // unbranched (>=768) layout is exactly the document order.
    expect(idx(html, "header")).toBeLessThan(idx(html, "coach"));
    expect(idx(html, "coach")).toBeLessThan(idx(html, "subtitle"));
    expect(idx(html, "subtitle")).toBeLessThan(idx(html, "picker-inline"));
    expect(idx(html, "picker-inline")).toBeLessThan(idx(html, "extra"));
    expect(idx(html, "extra")).toBeLessThan(idx(html, "board-slot"));
    expect(idx(html, "board-slot")).toBeLessThan(idx(html, "controls"));
    expect(html).not.toMatch(/["\s]md:order-\d/);
  });

  it("renders picker.children inline for desktop AND inside the phone sheet", () => {
    const html = renderShell();
    const inlineSeg = html.slice(idx(html, "picker-inline"), idx(html, "extra"));
    const sheetSeg = html.slice(idx(html, "picker-sheet"));
    expect(inlineSeg).toContain("PICKER-CHILD-MARKER");
    expect(sheetSeg).toContain("PICKER-CHILD-MARKER");
    // …and each copy is hidden at the width the other one serves.
    expect(tagFor(html, "picker-inline")).toMatch(MAX_MD_HIDDEN);
    expect(tagFor(html, "picker-sheet")).toMatch(MD_HIDDEN);
    expect(tagFor(html, "picker-sheet")).not.toMatch(MAX_MD_HIDDEN);
    // Neither wrapper may be a flex item of the column: a puzzle game's
    // picker children are themselves `md:hidden`, so a plain block would
    // claim a `gap-3` of the desktop column while rendering nothing.
    expect(tagFor(html, "picker-inline")).toMatch(/["\s]contents(?=["\s])/);
    expect(tagFor(html, "picker-sheet")).toMatch(/["\s]contents(?=["\s])/);
  });

  it("gives the sheet a labelled dialog, a grab handle and a close button, closed by default", () => {
    const html = renderShell();
    const sheetSeg = html.slice(idx(html, "picker-sheet"));
    expect(tagFor(html, "picker-sheet")).toContain("hidden=");
    expect(sheetSeg).toContain('role="dialog"');
    expect(sheetSeg).toContain('aria-label="Packs"');
    expect(sheetSeg).toContain('data-cq="picker-sheet-handle"');
    expect(sheetSeg).toContain('aria-label="Close"');
    expect(tagFor(html, "picker-sheet-panel")).toMatch(/fixed/);
    expect(tagFor(html, "picker-sheet-panel")).toMatch(/bottom-0/);
  });

  // Focus management: what a static render CAN pin is the dialog contract the
  // browser behaviour hangs off — the panel is programmatically focusable, and
  // declares itself a named modal dialog. Focus RESTORE on close (the sheet's
  // wrapper goes display:none, so focus would otherwise fall to <body> and a
  // keyboard user would lose the thumb bar) and the Tab cycle that keeps focus
  // inside the panel are DOM behaviour, and this workspace has no jsdom.
  // e2e/games-phone.spec.ts drives the sheet's open / Escape / close-on-pick
  // flow in a browser but asserts nothing about focus, so those two are
  // currently proven by neither gate — a browser check is owed.
  it("makes the sheet panel a focusable, named modal dialog", () => {
    const panel = tagFor(renderShell(), "picker-sheet-panel");
    expect(panel).toContain('tabindex="-1"');
    expect(panel).toContain('role="dialog"');
    expect(panel).toContain('aria-modal="true"');
    expect(panel).toContain('aria-label="Packs"');
  });

  it("puts the picker button in the MIDDLE of the controls bar, phone-only", () => {
    const html = renderShell();
    const controlsSeg = html.slice(idx(html, "controls"), idx(html, "picker-sheet"));
    expect(controlsSeg).toContain("Packs");
    expect(controlsSeg).toContain('data-cq="picker-button"');
    expect(tagFor(html, "picker-button")).toMatch(MD_HIDDEN);
    // Hint · Packs · Start pack over — the design's three-up thumb bar.
    expect(controlsSeg.indexOf("Hint")).toBeLessThan(controlsSeg.indexOf("Packs"));
    expect(controlsSeg.indexOf("Packs")).toBeLessThan(controlsSeg.indexOf("Start pack over"));
  });

  it("makes the controls bar a sticky equal-width 44px thumb bar on phones only", () => {
    const tag = tagFor(renderShell(), "controls");
    expect(tag).toMatch(/["\s]max-md:sticky(?=["\s])/);
    expect(tag).toMatch(/["\s]max-md:bottom-0(?=["\s])/);
    expect(tag).toMatch(/max-md:grid-flow-col/);
    expect(tag).toMatch(/max-md:auto-cols-fr/);
    expect(tag).toMatch(/h-11/);
    // Desktop keeps today's wrapping centred row.
    expect(tag).toMatch(/["\s]md:flex(?=["\s])/);
    expect(tag).toMatch(/md:flex-wrap/);
  });

  it("shrinks the title on phones but keeps the h2 the e2e asserts on", () => {
    const html = renderShell();
    expect(html).toContain("<h2");
    expect(html).toContain("Mate in 1");
    expect(tagFor(html, "title")).toMatch(/["\s]max-md:text-lg(?=["\s])/);
  });

  it("omits the subtitle strip, the picker button and the sheet when not given", () => {
    const html = renderShell({ picker: false, subtitle: false });
    expect(html).not.toContain('data-cq="subtitle"');
    expect(html).not.toContain('data-cq="picker-button"');
    expect(html).not.toContain('data-cq="picker-sheet"');
    expect(html).not.toContain('role="dialog"');
    // …and the rest of the shell still composes.
    expect(html).toContain("BOARD-MARKER");
    expect(phoneOrder(html, "board-slot")).toBe(3);
  });
});

describe("PuzzleDots — stepper on phones, numbered grid on desktop", () => {
  const html = renderToStaticMarkup(
    <PuzzleDots count={5} current={2} isSolved={(i) => i === 0} onPick={() => {}} />,
  );

  it("hides the stepper above md and the numbered dots below it", () => {
    expect(tagFor(html, "puzzle-stepper")).toMatch(MD_HIDDEN);
    expect(tagFor(html, "puzzle-stepper")).not.toMatch(MAX_MD_HIDDEN);
    expect(tagFor(html, "puzzle-dots")).toMatch(MAX_MD_HIDDEN);
    expect(tagFor(html, "puzzle-dots")).not.toMatch(MD_HIDDEN);
  });

  it("announces the current puzzle and offers 44px arrows", () => {
    expect(html).toContain("3 of 5");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-label="Previous puzzle"');
    expect(html).toContain('aria-label="Next puzzle"');
    const at = html.indexOf('aria-label="Previous puzzle"');
    const prev = html.slice(html.lastIndexOf("<button", at), html.indexOf(">", at) + 1);
    expect(prev).toMatch(/["\s]h-11(?=["\s])/);
    expect(prev).toMatch(/["\s]w-11(?=["\s])/);
    // The compact dots beside the count are decoration, not a second control.
    expect(tagFor(html, "puzzle-stepper-dots")).toContain('aria-hidden="true"');
  });

  it("keeps the desktop dots' aria-label and solved/current styling", () => {
    expect(html).toContain('aria-label="Puzzle 1"');
    expect(html).toContain('aria-label="Puzzle 5"');
    const dot1 = html.slice(html.lastIndexOf("<button", html.indexOf('aria-label="Puzzle 1"')));
    expect(dot1.slice(0, dot1.indexOf(">"))).toContain("border-emerald-500");
  });

  it('the "grid" variant is the phone sheet\'s 44px jump grid, and never paints beside the desktop dots', () => {
    const grid = renderToStaticMarkup(
      <PuzzleDots
        count={5}
        current={2}
        isSolved={() => false}
        onPick={() => {}}
        variant="grid"
      />,
    );
    expect(grid).not.toContain('data-cq="puzzle-stepper"');
    // `md:hidden` is load-bearing, not belt-and-braces: GameShell renders
    // every picker's children INLINE for desktop as well as in the sheet, so
    // without it a puzzle game shows two dot grids at >=768.
    expect(tagFor(grid, "puzzle-dots-sheet")).toMatch(MD_HIDDEN);
    expect(tagFor(grid, "puzzle-dots-sheet")).not.toMatch(MAX_MD_HIDDEN);
    // 44px targets, and a distinct accessible name so the sheet copy and the
    // desktop copy are never two controls with one name.
    expect(grid).toContain('aria-label="Go to puzzle 1"');
    expect(grid).not.toContain('aria-label="Puzzle 1"');
    expect(grid).toMatch(/["\s]h-11(?=["\s])/);
  });
});

// Driven through the REAL producer rather than a fixture: the shell props
// above prove the shell, and a picker that no game ever passes is an inert
// seam. Trick Shots is the one game whose picker is a redesign in its own
// right (the 17-chip wall becomes tier tabs + one short chip row), so it is
// the one worth folding through the shell here.
describe("TacticTrainer — tier tabs replace the 17-pack chip wall", () => {
  function fakeStorage(): Storage {
    const map = new Map<string, string>();
    return {
      get length() {
        return map.size;
      },
      clear: () => map.clear(),
      getItem: (k) => (map.has(k) ? map.get(k)! : null),
      key: (i) => Array.from(map.keys())[i] ?? null,
      removeItem: (k) => void map.delete(k),
      setItem: (k, v) => void map.set(k, String(v)),
    };
  }

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  function renderTrainer(): string {
    (globalThis as { window?: unknown }).window = { localStorage: fakeStorage() };
    return renderToStaticMarkup(
      <ProgressProvider>
        <TacticTrainer pack="fork" />
      </ProgressProvider>,
    );
  }

  it('titles the game "Trick Shots" and moves the pack name into the subtitle', () => {
    const html = renderTrainer();
    expect(html).toContain(">Trick Shots</h2>");
    expect(html).not.toContain("Trick Shots —");
    const subtitle = html.slice(idx(html, "subtitle"), idx(html, "picker-inline"));
    expect(subtitle).toContain("The Fork");
    expect(subtitle).toContain("First tricks");
  });

  it("shows five tier tabs and ONLY the active tier's packs in the desktop chip row", () => {
    const html = renderTrainer();
    const tabs = html.slice(idx(html, "pack-tabs"), idx(html, "pack-sections"));
    expect(tagFor(html, "pack-tabs")).toMatch(MAX_MD_HIDDEN);
    expect(tabs).toContain('role="tablist"');
    expect(tabs.match(/role="tab"/g)).toHaveLength(5);
    for (const tier of ["First tricks", "Master", "Set-ups", "Finishers", "Win a Piece"]) {
      expect(tabs).toContain(tier);
    }
    // Tier 1 is active, so its four packs are chips and the other thirteen
    // are NOT — the whole point of the redesign.
    expect(tabs).toContain("The Skewer");
    expect(tabs).not.toContain("Deflection");
    expect(tabs).not.toContain("Back-Rank");
    expect(tabs).toContain("0/6"); // per-pack progress on the chip
  });

  it("lists every pack as a 44px row, grouped by tier, for the phone sheet", () => {
    const html = renderTrainer();
    const sections = html.slice(idx(html, "pack-sections"), idx(html, "extra"));
    expect(tagFor(html, "pack-sections")).toMatch(MD_HIDDEN);
    for (const name of ["The Fork", "Deflection", "The Back-Rank Trap", "Win a Piece"]) {
      expect(sections).toContain(name);
    }
    expect(sections).toMatch(/["\s]h-11(?=["\s])/);
  });

  it('opens the phone thumb bar\'s middle button on "Packs"', () => {
    const html = renderTrainer();
    expect(tagFor(html, "picker-button")).toMatch(MD_HIDDEN);
    expect(html.slice(idx(html, "picker-button"))).toContain("Packs");
    // …and the sheet it opens is the same picker, not a second phone tree.
    const sheet = html.slice(idx(html, "picker-sheet"));
    expect(sheet).toContain('data-cq="pack-sections"');
    expect(sheet).toContain('aria-label="Packs"');
  });

  // role="tab" is a promise of tab BEHAVIOUR: a screen reader says "tab 1 of
  // 5" and the user then expects arrow keys, one stop in the tab sequence,
  // and a panel the tab is announced as controlling. Five buttons wearing the
  // role gave none of that.
  it("wires the tier tabs as a real tablist: id/aria-controls pairing and roving tabIndex", () => {
    const html = renderTrainer();
    const tabs = html.slice(idx(html, "pack-tabs"), idx(html, "pack-sections"));
    const panelAt = tabs.indexOf('role="tabpanel"');
    expect(panelAt, "no tabpanel in the desktop tier block").toBeGreaterThan(-1);
    const panelTag = tabs.slice(tabs.lastIndexOf("<", panelAt), tabs.indexOf(">", panelAt) + 1);
    const panelId = panelTag.match(/\sid="([^"]+)"/)?.[1];
    expect(panelId, "the tabpanel carries no id for aria-controls to point at").toBeTruthy();

    const tabTags = tabs.match(/<button[^>]*role="tab"[^>]*>/g) ?? [];
    expect(tabTags).toHaveLength(5);
    const tabIds = new Set<string>();
    for (const tag of tabTags) {
      expect(tag).toContain(`aria-controls="${panelId}"`);
      const id = tag.match(/\sid="([^"]+)"/)?.[1];
      expect(id, `a tab carries no id: ${tag}`).toBeTruthy();
      tabIds.add(id!);
    }
    expect(tabIds.size, "the five tabs must not share an id").toBe(5);

    // Roving focus: exactly ONE tab is in the tab sequence — the selected one
    // — and the other four are reachable only by arrow key.
    const selected = tabTags.filter((t) => t.includes('aria-selected="true"'));
    expect(selected).toHaveLength(1);
    expect(selected[0]).toContain('tabindex="0"');
    expect(tabTags.filter((t) => t.includes('tabindex="-1"'))).toHaveLength(4);
  });

  // The key handling itself needs focus and a DOM; the arithmetic under it
  // does not, and it is where the off-by-ones live (both ends wrap).
  it("moves the selection with ArrowLeft/ArrowRight/Home/End, wrapping at both ends", () => {
    expect(nextTier(1, "ArrowRight")).toBe(2);
    expect(nextTier(5, "ArrowRight")).toBe(1);
    expect(nextTier(3, "ArrowLeft")).toBe(2);
    expect(nextTier(1, "ArrowLeft")).toBe(5);
    expect(nextTier(4, "Home")).toBe(1);
    expect(nextTier(2, "End")).toBe(5);
    // Anything else is left to the browser (Tab, Enter, typing).
    expect(nextTier(2, "Tab")).toBeNull();
    expect(nextTier(2, "ArrowDown")).toBeNull();
  });
});
