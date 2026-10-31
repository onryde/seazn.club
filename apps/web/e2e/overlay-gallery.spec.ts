import { test, expect, type Page } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signInStaff } from "./overlay-kit";

// THE STAFF OVERLAY GALLERY (R2007; spec 2026-10-15 §4.5 and §4.8). Every template × sport × scene × state, every
// moment sample and every Result-card variant, drawn through the shared preview render — and this spec reads the
// RENDERED page against the floors and the layout the registry declares:
//   1. render fidelity      every cell the page declares is drawn, each with exactly one overlay root
//   2. text floor           every visible text element in every cell computes ≥ 30 px (D9)
//   2b. priority            a chase/result line ellipsises only when it alone fills its row (§4)
//   3. bar lift             every bar sits ≥ 150 canvas px off the canvas floor (D9)
//   4. safe area            each template stays inside its declared box; every card stays out of it (G2), and fits
//                           its region without clipping, a wrapped tile score or a pill cut at its first letter; the
//                           slate's brand stays out of the template's box and off its own card
//   5. slab placement       each moment cell's slab sits in the slot its template's registry entry names
//   6. no transport         the previews never fetch or subscribe (`snapshotOnly`)
//   7. frames               `?frame=844` / `?frame=390` render each preview at that width
//   8. figures              no crease figure or ball glyph is ellipsised, clipped or out of its entry, at every frame,
//                           and the striker's mark leads its name (review a and confirm pass, PR #974)
//   8b. squeeze             with one batter's name made hostile, every figure still sits whole inside its own entry
//   4c. Result card         every Result card fits by its measured headline ladder (owner ruling 1, 2026-10-19): every
//                           locale × every `fixture.decidedBy.*` sentence with a 43-character winner, through the real
//                           producer (the gallery's stress mode); never clamped, nothing hidden, each rung only when
//                           the one before does not fit on one line; the forced sentence on EVERY card that names a
//                           winner, naming the side the outcome credits by that side's own code
//   4d. side codes          two sides sharing a three-letter prefix (Harlow v Harrow) read two different codes on every
//                           template — the bug, the bar's tightest rung, the tiles and the short Result rung — and
//                           each side ONE code everywhere (the public site's `disambiguatedShorts`, owner 2026-10-19)
//                           and the widest four-letter codes the ladder mints (WOME, TOWN; WWWW, MMMM, ÆÆÆÆ, ØØØØ)
//                           fit the bug's code column, the bar's tightest rung and the tiles, at 1920, 844 and 390
//                           (#987 confirm pass N2 / M6)
//   9. sponsor slots        R4 S7 (spec 2026-10-27 §3.5): every template × sport × slot the template declares draws the
//                           real planner's card in that declared slot — clear of the scorebug's declared box, ≥ 150 px
//                           off the floor, every text ≥ 30 px, nothing overflowing the card, the 43-character name
//                           ellipsised (lower third) or clamped at two lines (banner) inside it; and the scene
//                           carousel's card sits in the banner slot, clear of the scene's match card
// The cells are `galleryCells(OVERLAY_TEMPLATES, …)` — the gallery's one cell source — so a template or scene added to
// the registry is swept here with no edit. Every check prints its count, and zero checked fails it. The per-check
// verdicts are `expect.soft`, so one run reports EVERY check that fails rather than stopping at the first.
//
// /admin is staff-only and desktop-only (owner, 2026-09-28): 1280 only, no phone widths.
// PARALLEL-SAFE: a fresh staff user of its own — the shared Pro owner's staff bit is never borrowed.

const CANVAS_W = 1920;
const TEXT_FLOOR_PX = 30; // spec §4.5 (D9)
const BAR_BOTTOM_MIN_PX = 150; // spec §4.5 (D9)
/** Sub-pixel rounding of a box scaled ×0.5 and read back. */
const TOL = 1.5;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CellProbe {
  key: string;
  template: string;
  snapshot: string;
  moment: string;
  resultStatus: string;
  slabPlacement: string;
  safeArea: Box;
  roots: number;
  /** 1 — the caption's parts (template, state, scene), as a staff member reads them. */
  captionParts: string[];
  textChecked: number;
  violators: string[];
  /** 2b — chase/result sentences read, and the ones cut while something beside them kept its width. */
  emphasisChecked: number;
  emphasisCut: string[];
  barLift: number | null;
  templateBox: Box | null;
  cardBox: Box | null;
  /** 4 — the slate's brand mark: painted by the warming/ended layer, so it owes the template's box what the card does. */
  brandBox: Box | null;
  /** 4b — the card's own fit: content it clips, a score that wraps in its tile, a pill whose first letter is cut. */
  cardFit: string[];
  pillsChecked: number;
  slotClass: string | null;
  slotHasSlab: boolean;
  previewWidth: number;
}

async function openGallery(page: Page, query = ""): Promise<number> {
  const res = await page.goto(`/admin/overlay-gallery${query}`);
  expect(res?.status(), `/admin/overlay-gallery${query}`).toBe(200);
  const root = page.locator('[data-testid="overlay-gallery"]');
  await expect(root).toHaveCount(1, { timeout: 60_000 });
  const declared = Number(await root.getAttribute("data-cell-count"));
  expect(declared, "anti-vacuity: the page declares cells").toBeGreaterThan(0);
  await expect(page.locator("[data-gallery-cell]")).toHaveCount(declared, { timeout: 60_000 });
  return declared;
}

/** Everything checks 1–5 read, per cell, in canvas px (the preview's scale divided back out). */
async function probeCells(page: Page): Promise<CellProbe[]> {
  return page.evaluate(
    ({ canvasW, floor }) => {
      const union = (rects: DOMRect[]): DOMRect | null => {
        const real = rects.filter((r) => r.width > 0 && r.height > 0);
        if (real.length === 0) return null;
        const left = Math.min(...real.map((r) => r.left));
        const top = Math.min(...real.map((r) => r.top));
        const right = Math.max(...real.map((r) => r.right));
        const bottom = Math.max(...real.map((r) => r.bottom));
        return new DOMRect(left, top, right - left, bottom - top);
      };
      return [...document.querySelectorAll<HTMLElement>("[data-gallery-cell]")].map((cell) => {
        const roots = cell.querySelectorAll('[data-testid="ovl-root"]');
        const root = roots[0] as HTMLElement | undefined;
        const base = {
          key: cell.dataset.galleryCell ?? "",
          template: cell.dataset.template ?? "",
          snapshot: cell.dataset.snapshot ?? "",
          moment: cell.dataset.moment ?? "",
          resultStatus: cell.dataset.resultStatus ?? "",
          slabPlacement: cell.dataset.slabPlacement ?? "",
          safeArea: JSON.parse(cell.dataset.safeArea ?? "null"),
          roots: roots.length,
          captionParts: [...cell.querySelectorAll("figcaption > span")].map((s) => (s.textContent ?? "").trim()),
          previewWidth: cell.querySelector('[data-testid="ovl-preview"]')?.getBoundingClientRect().width ?? 0,
        };
        if (!root) {
          return { ...base, textChecked: 0, violators: [], emphasisChecked: 0, emphasisCut: [], barLift: null, templateBox: null, cardBox: null, brandBox: null, cardFit: [], pillsChecked: 0, slotClass: null, slotHasSlab: false };
        }
        const canvas = root.getBoundingClientRect();
        const scale = canvas.width / canvasW;
        const toCanvas = (r: DOMRect | null) =>
          r === null
            ? null
            : { x: (r.left - canvas.left) / scale, y: (r.top - canvas.top) / scale, width: r.width / scale, height: r.height / scale };

        // 2 — every element with its own text, visible, at or over the floor. A CSS transform does not change the
        // COMPUTED font-size, so this reads canvas px at any frame.
        let textChecked = 0;
        const violators: string[] = [];
        for (const el of root.querySelectorAll<HTMLElement>("*")) {
          const ownText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "");
          if (!ownText) continue;
          if (!el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true } as CheckVisibilityOptions)) continue;
          textChecked++;
          const size = parseFloat(getComputedStyle(el).fontSize);
          if (!(size >= floor)) violators.push(`${el.className || el.tagName} ${size}px "${(el.textContent ?? "").trim().slice(0, 32)}"`);
        }

        // 2b — §4: a chase or result line "takes priority". It may ellipsise only when it alone fills its row; cut while
        // an entry beside it still holds width is the floor bought at the sentence's expense ("N…" beside two names).
        let emphasisChecked = 0;
        const emphasisCut: string[] = [];
        for (const em of root.querySelectorAll<HTMLElement>(".ovl-detail-emphasis")) {
          if (!em.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true } as CheckVisibilityOptions)) continue;
          emphasisChecked++;
          if (em.scrollWidth <= em.clientWidth + 1) continue;
          const row = em.parentElement!;
          const rowStyle = getComputedStyle(row);
          // clientWidth is layout px — the canvas's own px, untouched by the preview's transform — on both sides.
          const rowContent = row.clientWidth - parseFloat(rowStyle.paddingLeft) - parseFloat(rowStyle.paddingRight);
          if (em.clientWidth < rowContent - 1) {
            emphasisCut.push(`"${(em.textContent ?? "").slice(0, 32)}" cut at ${Math.round(em.clientWidth)}px of a ${Math.round(rowContent)}px row`);
          }
        }

        // 3 — the bar's bottom edge above the canvas floor.
        const bar = root.querySelector<HTMLElement>(".ovl-bar");
        const barLift = bar ? (canvas.bottom - bar.getBoundingClientRect().bottom) / scale : null;

        // 4 — the template's own elements (the `display: contents` wrapper's children) and the card.
        const tpl = root.querySelector<HTMLElement>('[data-testid="ovl-template"]');
        const templateBox = toCanvas(union(tpl ? [...tpl.children].map((c) => c.getBoundingClientRect()) : []));
        const card = root.querySelector<HTMLElement>('[data-testid="ovl-slate-card"]');
        const cardBox = card ? toCanvas(card.getBoundingClientRect()) : null;
        const brand = root.querySelector<HTMLElement>(".ovl-slate-brand");
        const brandBox = brand ? toCanvas(brand.getBoundingClientRect()) : null;
        // 4b — a card that fits its region by clipping is not a fit (`.ovl-slate-card` is overflow: hidden, max-height
        // 100%); a tile score on two lines, or a pill centred past its own left edge, is the D9 floor bought badly.
        const cardFit: string[] = [];
        let pillsChecked = 0;
        if (card) {
          if (card.scrollHeight > card.clientHeight + 1) cardFit.push(`card clips ${card.scrollHeight - card.clientHeight}px of content`);
          for (const score of card.querySelectorAll<HTMLElement>(".ovl-slate-tile-score")) {
            const cs = getComputedStyle(score);
            const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
            if (score.getBoundingClientRect().height / scale > line * 1.5) cardFit.push(`tile score wraps: "${score.textContent}"`);
          }
          for (const pill of card.querySelectorAll<HTMLElement>(".ovl-slate-pill")) {
            pillsChecked++;
            const text = [...pill.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "");
            if (!text) continue;
            const range = document.createRange();
            range.setStart(text, 0);
            range.setEnd(text, 1);
            if (range.getBoundingClientRect().left < pill.getBoundingClientRect().left - 1) {
              cardFit.push(`pill cuts its first letter: "${(pill.textContent ?? "").slice(0, 24)}"`);
            }
          }
        }

        // 5 — the slot and its slab.
        const slot = root.querySelector<HTMLElement>('[data-testid="ovl-moment-slot"]');
        return {
          ...base,
          textChecked,
          violators,
          emphasisChecked,
          emphasisCut,
          barLift,
          templateBox,
          cardBox,
          brandBox,
          cardFit,
          pillsChecked,
          slotClass: slot?.className ?? null,
          slotHasSlab: slot?.querySelector('[data-testid="overlay-moment"]') != null,
        };
      });
    },
    { canvasW: CANVAS_W, floor: TEXT_FLOOR_PX },
  );
}

const inside = (b: Box, area: Box) =>
  b.x >= area.x - TOL &&
  b.y >= area.y - TOL &&
  b.x + b.width <= area.x + area.width + TOL &&
  b.y + b.height <= area.y + area.height + TOL;
const intersects = (a: Box, b: Box) =>
  a.x + TOL < b.x + b.width && b.x + TOL < a.x + a.width && a.y + TOL < b.y + b.height && b.y + TOL < a.y + a.height;
const fmt = (b: Box | null) => (b === null ? "none" : `{x:${b.x.toFixed(1)}, y:${b.y.toFixed(1)}, w:${b.width.toFixed(1)}, h:${b.height.toFixed(1)}}`);

/**
 * Check 4d's fit sweep (#987 confirm pass N2 / M6): name pairs whose codes — resolved by the REAL producer, the public
 * site's pair rule through the gallery's `?name=` / `?away=` — are the widest four-letter codes on air. The two real
 * cases are the review's own (fontkit, Barlow Condensed SemiBold 48 px, against the bug's 96 px column): WOME 100.4 and
 * TOWN 99.1. The other two are the face's widest capitals, four of each (Æ 35.3, W 31.9, Ø 28.7, M 25.8 px a glyph):
 * a code made of them is the worst any four-letter code can be, so a fit that holds here holds for every code the
 * ladder can mint in a Latin script. `codes` is the premise (each pair resolves to its widest code), checked off the
 * page before anything is measured — never the verdict.
 */
const WIDE_CODE_PAIRS = [
  { name: "Manchester United", away: "Manchester United Women", codes: ["UNIT", "WOME"] },
  { name: "St. Ives", away: "St Ives Town", codes: ["IVES", "TOWN"] },
  { name: "Wwww Wwww", away: "Wwww Wwww Mmmm", codes: ["WWWW", "MMMM"] },
  { name: "Ææææ Ææææ", away: "Ææææ Ææææ Øøøø", codes: ["ÆÆÆÆ", "ØØØØ"] },
] as const;
const FIT_FRAMES = ["", "844", "390"] as const;

interface CodeFit {
  where: string;
  code: string;
  /** The code's painted width, in canvas px (the preview's scale divided back out). */
  ink: number;
  /** The room it has, in canvas px: the bug's column, the bar name box plus its slack, the tile's content box. */
  room: number;
  /** Bar only: the name ladder settled on a rung that fits. */
  settled?: boolean;
  /** Tiles only: the tile sits inside its card. */
  inCard?: boolean;
}

/** Check 4d's in-page read of every code a cell draws — the bug's code column, the bar's tightest rung (the LAST probe
 *  of each side's name ladder, the code it steps down to), the tiles — against the room each has. Self-contained. */
function probeCodeFit(canvasW: number) {
  const out = { bug: [] as CodeFit[], bar: [] as CodeFit[], tiles: [] as CodeFit[] };
  for (const cell of document.querySelectorAll<HTMLElement>("[data-gallery-cell]")) {
    const root = cell.querySelector<HTMLElement>('[data-testid="ovl-root"]');
    if (!root) continue;
    const where = cell.dataset.galleryCell ?? "?";
    const scale = root.getBoundingClientRect().width / canvasW;
    const inkOf = (el: Element) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect().width / scale;
    };
    const text = (el: Element) => (el.textContent ?? "").trim();
    for (const el of root.querySelectorAll<HTMLElement>(".ovl-bug-code")) {
      if (text(el) === "") continue;
      out.bug.push({ where, code: text(el), ink: inkOf(el), room: el.getBoundingClientRect().width / scale });
    }
    for (const box of root.querySelectorAll<HTMLElement>(".ovl-team-name")) {
      const probes = box.querySelectorAll<HTMLElement>(".ovl-team-name-probe");
      const last = probes[probes.length - 1];
      if (!last) continue;
      // `availableNameWidth`'s room, in canvas px: the box plus the slack before the next in-flow sibling.
      const rect = box.getBoundingClientRect();
      let room = rect.width / scale;
      const next = box.nextElementSibling;
      if (next instanceof HTMLElement && getComputedStyle(next).position !== "absolute") {
        const gap = parseFloat(getComputedStyle(box.parentElement!).columnGap) || 0;
        room += Math.max(0, (next.getBoundingClientRect().left - rect.right) / scale - gap);
      }
      out.bar.push({ where, code: text(last), ink: last.getBoundingClientRect().width / scale, room, settled: box.dataset.ladderSettled === "true" });
    }
    for (const el of root.querySelectorAll<HTMLElement>(".ovl-slate-tile-code")) {
      const tile = el.closest<HTMLElement>(".ovl-slate-tile");
      if (!tile || text(el) === "") continue;
      const cs = getComputedStyle(tile);
      const room = tile.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      const card = tile.closest<HTMLElement>('[data-testid="ovl-slate-card"]');
      const t = tile.getBoundingClientRect();
      const c = card?.getBoundingClientRect();
      const inCard = c === undefined || (t.left >= c.left - 1 && t.right <= c.right + 1);
      out.tiles.push({ where, code: text(el), ink: inkOf(el), room, inCard });
    }
  }
  return out;
}

/** 400 characters with no digit, so check 8's "an ellipsised box holds a numeral" half never reads the name itself. */
const HOSTILE_NAME = "Wolfeschlegelsteinhausenbergerdorff ".repeat(12).slice(0, 400);

/**
 * Check 8's in-page read (run through `page.evaluate`, so it is self-contained). With `hostile`, the first name in
 * every crease band is replaced first (check 8b). Each crease figure, ball glyph and striker mark must be whole
 * (never ellipsised), inside its own `.ovl-detail-entry`, and inside every ancestor that clips; each mark must sit in
 * its name's box, BEFORE the name and at its start edge, with the name between it and the figures; no ellipsised box
 * in an entry may hold a digit.
 */
function probeFigures(hostile: string | null) {
  const cut: string[] = [];
  let figures = 0;
  // R2005 change 12: the corner bug's striker line. Counted apart, so the aggregate cannot hide a bug that drew nothing.
  let bugFigures = 0;
  let bugSqueezed = 0;
  let bugNameEllipsised = 0;
  let marks = 0;
  let ellipsised = 0;
  let squeezed = 0;
  let floored = 0;
  const visible = (el: HTMLElement) =>
    el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true } as CheckVisibilityOptions);
  const roots = [...document.querySelectorAll<HTMLElement>('[data-gallery-cell] [data-testid="ovl-root"]')];
  if (hostile !== null) {
    for (const band of document.querySelectorAll<HTMLElement>('[data-gallery-cell] [data-testid="ovl-root"] .ovl-detail-band')) {
      const name = band.querySelector<HTMLElement>(".ovl-detail-name");
      if (name === null || !visible(name)) continue;
      name.textContent = hostile;
      squeezed++;
    }
    for (const band of document.querySelectorAll<HTMLElement>('[data-gallery-cell] [data-testid="ovl-root"] .ovl-detail-band')) {
      const names = [...band.querySelectorAll<HTMLElement>(".ovl-detail-name")];
      if (names.some((n) => n.textContent === hostile) && names.some((n) => n.getBoundingClientRect().width <= 1)) floored++;
    }
    // The bug's striker line has one name: made hostile, it must ELLIPSE (the name yields), and the figures beside it
    // are held whole by the same reads below.
    for (const name of document.querySelectorAll<HTMLElement>('[data-gallery-cell] [data-testid="ovl-root"] .ovl-bug-footer .ovl-detail-name')) {
      if (!visible(name)) continue;
      name.textContent = hostile;
      bugSqueezed++;
    }
    for (const name of document.querySelectorAll<HTMLElement>('[data-gallery-cell] [data-testid="ovl-root"] .ovl-bug-footer .ovl-detail-name')) {
      if (name.textContent === hostile && name.scrollWidth > name.clientWidth + 1) bugNameEllipsised++;
    }
  }
  for (const root of roots) {
    const key = root.closest<HTMLElement>("[data-gallery-cell]")?.dataset.galleryCell ?? "?";
    for (const fig of root.querySelectorAll<HTMLElement>(".ovl-detail-figures, .ovl-ball-glyph, .ovl-detail-mark")) {
      if (!visible(fig)) continue;
      const isMark = fig.classList.contains("ovl-detail-mark");
      if (isMark) marks++;
      else {
        figures++;
        if (fig.closest(".ovl-bug") !== null) bugFigures++;
      }
      const text = (fig.textContent ?? "").trim();
      if (fig.scrollWidth > fig.clientWidth + 1) cut.push(`${key}: "${text}" is ellipsised`);
      const r = fig.getBoundingClientRect();
      const entry = fig.closest<HTMLElement>(".ovl-detail-entry");
      if (entry !== null) {
        const e = entry.getBoundingClientRect();
        if (r.left < e.left - 1 || r.right > e.right + 1) cut.push(`${key}: "${text}" spills out of its entry`);
      }
      // Every ancestor that clips (overflow-x other than visible), up to and including the canvas root.
      for (let a = fig.parentElement; a !== null && a !== root.parentElement; a = a.parentElement) {
        if (a !== root && getComputedStyle(a).overflowX === "visible") continue;
        const b = a.getBoundingClientRect();
        if (r.left < b.left - 1 || r.right > b.right + 1) {
          cut.push(`${key}: "${text}" runs out of .${String(a.className || a.tagName).split(" ")[0]}`);
          break;
        }
      }
      if (isMark) {
        const who = fig.parentElement;
        const name = who?.querySelector<HTMLElement>(".ovl-detail-name") ?? null;
        const person = fig.closest<HTMLElement>(".ovl-detail-person");
        const figs = person?.querySelector<HTMLElement>(".ovl-detail-figures") ?? null;
        if (who === null || !who.classList.contains("ovl-detail-who") || name === null) {
          cut.push(`${key}: mark "${text}" is not in its name's box`);
        } else if (figs === null || who.contains(figs)) {
          cut.push(`${key}: mark "${text}" shares a box with the figures`);
        } else {
          const n = name.getBoundingClientRect();
          const f = figs.getBoundingClientRect();
          // The name's START edge: the mark's own right margin (≤ 0.2 em of the mark's font, scaled with the preview)
          // is all that may stand between them.
          const em = parseFloat(getComputedStyle(fig).fontSize) * (root.getBoundingClientRect().width / root.offsetWidth);
          const gap = n.left - r.right;
          if (gap < -1 || gap > 0.2 * em + 1) cut.push(`${key}: mark "${text}" sits ${gap.toFixed(1)}px off its name's start edge`);
          if (n.right > f.left + 1) cut.push(`${key}: mark "${text}" — the name does not stand between it and the figures`);
        }
      }
    }
    for (const el of root.querySelectorAll<HTMLElement>(".ovl-detail-entry *")) {
      const own = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "");
      if (!own || el.scrollWidth <= el.clientWidth + 1) continue;
      ellipsised++;
      if (/\d/.test(el.textContent ?? "")) cut.push(`${key}: "${(el.textContent ?? "").slice(0, 40)}" is cut and holds a numeral`);
    }
  }
  return { figures, marks, ellipsised, squeezed, floored, cut, bugFigures, bugSqueezed, bugNameEllipsised };
}

test.describe("the staff overlay gallery (R2007)", () => {
  test("checks 1–5 over every cell: fidelity, the 30 px floor, the bar lift, the safe area and the slab placement", async ({ page }) => {
    test.setTimeout(240_000);
    await signInStaff(page);
    const declared = await openGallery(page);
    const cells = await probeCells(page);

    // 1 — render fidelity.
    expect(cells.length, "every declared cell is drawn").toBe(declared);
    const rootless = cells.filter((c) => c.roots !== 1).map((c) => `${c.key} (${c.roots} roots)`);
    console.log(`[1] cells: ${cells.length}, declared: ${declared}`);
    expect(rootless, "each cell holds exactly one overlay root").toEqual([]);
    // Review (PR #974): the caption read "Broadcast bar Live Live" — the snapshot's state and the scene's name are two
    // different axes, so no caption may say the same word twice and leave the reader to guess which is which.
    const captionsRead = cells.filter((c) => c.captionParts.length > 0).length;
    const echoing = cells
      .filter((c) => new Set(c.captionParts.map((p) => p.toLowerCase())).size !== c.captionParts.length)
      .map((c) => `${c.key}: "${c.captionParts.join(" | ")}"`);
    console.log(`[1] captions read: ${captionsRead}, repeating a part: ${echoing.length}`);
    expect(captionsRead, "every cell has a caption").toBe(cells.length);
    expect.soft(echoing, "captions that say the same thing twice").toEqual([]);

    // 2 — the text floor, computed.
    const textChecked = cells.reduce((n, c) => n + c.textChecked, 0);
    const below = cells.flatMap((c) => c.violators.map((v) => `${c.key}: ${v}`));
    console.log(`[2] cells: ${cells.length}, text elements checked: ${textChecked}, below ${TEXT_FLOOR_PX}px: ${below.length}`);
    expect(textChecked, "anti-vacuity: no text element was checked").toBeGreaterThan(0);
    expect(cells.filter((c) => c.textChecked === 0).map((c) => c.key), "a cell with no text read is a blank cell").toEqual([]);
    expect.soft(below, `text below the ${TEXT_FLOOR_PX}px floor`).toEqual([]);
    const emphasisChecked = cells.reduce((n, c) => n + c.emphasisChecked, 0);
    const emphasisCut = cells.flatMap((c) => c.emphasisCut.map((e) => `${c.key}: ${e}`));
    console.log(`[2b] chase/result lines checked: ${emphasisChecked}, cut beside an entry: ${emphasisCut.length}`);
    expect(emphasisChecked, "anti-vacuity: no chase or result line was read").toBeGreaterThan(0);
    expect.soft(emphasisCut, "a chase/result line that gave way before the entries it leads").toEqual([]);

    // 3 — the bar lift.
    const barCells = cells.filter((c) => c.template === "bar");
    const lowBars = barCells.filter((c) => c.barLift === null || c.barLift < BAR_BOTTOM_MIN_PX).map((c) => `${c.key}: ${c.barLift}`);
    console.log(`[3] bar cells checked: ${barCells.length}, lowest lift: ${Math.min(...barCells.map((c) => c.barLift ?? 0)).toFixed(1)}`);
    expect(barCells.length, "anti-vacuity: no bar cell").toBeGreaterThan(0);
    expect.soft(lowBars, `bars under ${BAR_BOTTOM_MIN_PX} canvas px off the floor`).toEqual([]);

    // 4 — the safe area: each template inside its declared box, each card out of it.
    const outside = cells
      .filter((c) => c.templateBox === null || !inside(c.templateBox, c.safeArea))
      .map((c) => `${c.key}: template ${fmt(c.templateBox)} vs declared ${fmt(c.safeArea)}`);
    const cardOwed = cells.filter((c) => c.snapshot === "warming" || c.snapshot === "ended" || c.resultStatus !== "");
    const cardless = cardOwed.filter((c) => c.cardBox === null).map((c) => c.key);
    const withCard = cells.filter((c) => c.cardBox !== null);
    const overlapping = withCard
      .filter((c) => intersects(c.cardBox!, c.safeArea))
      .map((c) => `${c.key}: card ${fmt(c.cardBox)} meets declared ${fmt(c.safeArea)}`);
    console.log(
      `[4] cells: ${cells.length}, templates checked: ${cells.length - cells.filter((c) => c.templateBox === null).length}, cards checked: ${withCard.length}, cards expected ≥ ${cardOwed.length}`,
    );
    // Information only (review m1): the measured union box per template, beside the declared one.
    for (const template of [...new Set(cells.map((c) => c.template))]) {
      const boxes = cells.filter((c) => c.template === template && c.templateBox).map((c) => c.templateBox!);
      const x = Math.min(...boxes.map((b) => b.x));
      const y = Math.min(...boxes.map((b) => b.y));
      const right = Math.max(...boxes.map((b) => b.x + b.width));
      const bottom = Math.max(...boxes.map((b) => b.y + b.height));
      const declaredBox = cells.find((c) => c.template === template)!.safeArea;
      console.log(`[4] ${template}: measured union ${fmt({ x, y, width: right - x, height: bottom - y })}, declared ${fmt(declaredBox)}`);
    }
    expect(withCard.length, "anti-vacuity: no card was checked").toBeGreaterThan(0);
    expect(withCard.length, "fewer cards than the warming, ended and variant cells owe").toBeGreaterThanOrEqual(cardOwed.length);
    expect.soft(cardless, "a warming, ended or variant cell with no card").toEqual([]);
    expect.soft(outside, "templates outside their declared sceneCardSafeArea").toEqual([]);
    expect.soft(overlapping, "cards over the template's declared box").toEqual([]);
    // The brand mark the slate paints beside its card (review, PR #974): it sat at a fixed 72/54 — inside the bug's
    // declared box, under the bug's own board. It owes the template's box what the card does, and it must not sit on
    // the card it labels.
    const withBrand = cells.filter((c) => c.brandBox !== null);
    const brandOver = withBrand
      .filter((c) => intersects(c.brandBox!, c.safeArea) || (c.cardBox !== null && intersects(c.brandBox!, c.cardBox)))
      .map((c) => `${c.key}: brand ${fmt(c.brandBox)} meets declared ${fmt(c.safeArea)} or card ${fmt(c.cardBox)}`);
    console.log(`[4] slate brands checked: ${withBrand.length}, over the template or the card: ${brandOver.length}`);
    expect(withBrand.length, "anti-vacuity: no slate brand was read").toBeGreaterThan(0);
    expect.soft(brandOver, "the slate's brand over the template's declared box or its own card").toEqual([]);
    const misfit = withCard.flatMap((c) => c.cardFit.map((f) => `${c.key}: ${f}`));
    const pills = cells.reduce((n, c) => n + c.pillsChecked, 0);
    console.log(`[4b] cards checked for fit: ${withCard.length}, pills checked: ${pills}, misfits: ${misfit.length}`);
    expect(pills, "anti-vacuity: no context pill was checked").toBeGreaterThan(0);
    expect.soft(misfit, "cards that clip, wrap a score, or cut a pill's first letter").toEqual([]);

    // 5 — the slab placement.
    const momentCells = cells.filter((c) => c.moment !== "");
    const misplaced = momentCells
      .filter((c) => !(c.slotClass ?? "").split(/\s+/).includes(`ovl-moment-slot--${c.slabPlacement}`) || !c.slotHasSlab)
      .map((c) => `${c.key}: slot "${c.slotClass}" (wants --${c.slabPlacement}), slab ${c.slotHasSlab ? "present" : "ABSENT"}`);
    console.log(`[5] moment cells checked: ${momentCells.length}`);
    expect(momentCells.length, "anti-vacuity: no moment cell").toBeGreaterThan(0);
    expect.soft(misplaced, "slabs not where the template's registry entry puts them").toEqual([]);
  });

  // 9 — R4 S7. Measured off the SLOT (placed by the declaration, never transformed) and the card's own layout box, not
  // the card's painted box: a carousel card that rotates mid-probe is sliding in, and its transform would read as a
  // card out of its slot for 250 ms. The slot clips (`overflow: hidden`), so nothing of the card paints outside it.
  test("check 9 (sponsor slots): every template × sport × slot and the scene carousel — the declared slot, clear of the scorebug and the match card, the floors held, the 43-character name whole or cleanly cut, the longest name cut inside its card", async ({ page }) => {
    test.setTimeout(240_000);
    await signInStaff(page);
    await openGallery(page);
    await page.evaluate(() => document.fonts.ready);
    const slotOwed = await page.locator('[data-gallery-cell]:not([data-sponsor-slot=""])').count();
    const carouselOwed = await page.locator('[data-gallery-cell][data-sponsor-carousel="1"]').count();
    expect(slotOwed, "anti-vacuity: the page declares sponsor slot cells").toBeGreaterThan(0);
    expect(carouselOwed, "anti-vacuity: the page declares carousel cells").toBeGreaterThan(0);
    // The carousel starts its first showing in an effect, after the markup.
    await expect
      .poll(() => page.locator('[data-gallery-cell][data-sponsor-carousel="1"] [data-testid="ovl-sponsor-card"]').count(), { timeout: 30_000 })
      .toBe(carouselOwed);
    await page.waitForTimeout(500);

    const probes = await page.evaluate(
      ({ canvasW, floor }) =>
        [...document.querySelectorAll<HTMLElement>("[data-gallery-cell]")]
          .filter((cell) => (cell.dataset.sponsorSlot ?? "") !== "" || cell.dataset.sponsorCarousel === "1")
          .map((cell) => {
            const root = cell.querySelector<HTMLElement>('[data-testid="ovl-root"]')!;
            const canvas = root.getBoundingClientRect();
            const scale = canvas.width / canvasW;
            const toCanvas = (r: DOMRect) => ({
              x: (r.left - canvas.left) / scale,
              y: (r.top - canvas.top) / scale,
              width: r.width / scale,
              height: r.height / scale,
            });
            const carousel = cell.dataset.sponsorCarousel === "1";
            const slotName = carousel ? "banner" : (cell.dataset.sponsorSlot ?? "");
            const cards = [...root.querySelectorAll<HTMLElement>('[data-testid="ovl-sponsor-card"]')];
            const card = cards[0];
            const slot = card?.closest<HTMLElement>('[data-testid="ovl-sponsor-slot"]') ?? null;
            const match = root.querySelector<HTMLElement>('[data-testid="ovl-slate-card"]');
            const brand = root.querySelector<HTMLElement>(".ovl-slate-brand");
            const base = {
              key: cell.dataset.galleryCell ?? "",
              template: cell.dataset.template ?? "",
              face: cell.dataset.sponsorFace ?? "",
              logo: root.querySelector('[data-testid="ovl-sponsor-card"] .ovl-sponsor-logo') !== null,
              mono: root.querySelector('[data-testid="ovl-sponsor-card"] .ovl-sponsor-mono') !== null,
              slot: slotName,
              carousel,
              declared: (JSON.parse(cell.dataset.sponsorSlots ?? "{}") as Record<string, { x: number; y: number; width: number; height: number }>)[slotName] ?? null,
              safeArea: JSON.parse(cell.dataset.safeArea ?? "null") as { x: number; y: number; width: number; height: number },
              cards: cards.length,
              slotData: slot?.dataset.slot ?? null,
              matchBox: match ? toCanvas(match.getBoundingClientRect()) : null,
              brandBox: brand ? toCanvas(brand.getBoundingClientRect()) : null,
            };
            if (!card || !slot) {
              return { ...base, slotBox: null, fills: false, textChecked: 0, below: [] as string[], overflow: [] as string[], nameCut: false, nameCutOk: true, link: null as string | null };
            }
            const slotBox = toCanvas(slot.getBoundingClientRect());
            // The card's own layout box (offset*, transform-free) fills the slot's.
            const fills = Math.abs(card.offsetWidth - slot.clientWidth) <= 1 && Math.abs(card.offsetHeight - slot.clientHeight) <= 1;
            let textChecked = 0;
            const below: string[] = [];
            for (const el of card.querySelectorAll<HTMLElement>("*")) {
              const ownText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "");
              if (!ownText) continue;
              textChecked++;
              const size = parseFloat(getComputedStyle(el).fontSize);
              if (!(size >= floor)) below.push(`${el.className} ${size}px`);
            }
            // Nothing escapes the card: the name chain's `min-width: 0` holds, or the text column widens the row.
            const overflow: string[] = [];
            if (card.scrollWidth > card.clientWidth + 1) overflow.push(`card content ${card.scrollWidth}px in ${card.clientWidth}px`);
            if (card.scrollHeight > card.clientHeight + 1) overflow.push(`card content ${card.scrollHeight}px tall in ${card.clientHeight}px`);
            const name = card.querySelector<HTMLElement>(".ovl-sponsor-name")!;
            const nameRect = name.getBoundingClientRect();
            const cardRect = card.getBoundingClientRect();
            if (nameRect.left < cardRect.left - 1 || nameRect.right > cardRect.right + 1) overflow.push("name paints past the card");
            const cs = getComputedStyle(name);
            const cutX = name.scrollWidth > name.clientWidth + 1;
            const cutY = name.scrollHeight > name.clientHeight + 1;
            const clamp = cs.getPropertyValue("-webkit-line-clamp").trim();
            const nameCut = cutX || cutY;
            // A cut name must say so: an ellipsis on the lower third's one line, the two-line clamp on the banner.
            const nameCutOk = !nameCut || (slotName === "banner" ? clamp === "2" : cs.textOverflow === "ellipsis" && !cutY);
            const link = card.querySelector('[data-testid="ovl-sponsor-link"]')?.textContent ?? null;
            return { ...base, slotBox, fills, textChecked, below, overflow, nameCut, nameCutOk, link };
          }),
      { canvasW: CANVAS_W, floor: TEXT_FLOOR_PX },
    );

    const slotCells = probes.filter((p) => !p.carousel);
    const carouselCells = probes.filter((p) => p.carousel);
    console.log(`[9] sponsor slot cells: ${slotCells.length} of ${slotOwed}, carousel cells: ${carouselCells.length} of ${carouselOwed}`);
    expect(slotCells.length).toBe(slotOwed);
    expect(carouselCells.length).toBe(carouselOwed);
    // Every template the gallery draws shows both of its declared slots.
    const templates = [...new Set(slotCells.map((p) => p.template))];
    for (const template of templates) {
      expect(new Set(slotCells.filter((p) => p.template === template).map((p) => p.slot)), template).toEqual(new Set(["lower_third", "banner"]));
    }
    expect(templates.length, "anti-vacuity: templates with sponsor cells").toBeGreaterThan(0);

    const cardless = probes.filter((p) => p.cards !== 1 || p.slotBox === null).map((p) => `${p.key}: ${p.cards} cards`);
    const wrongSlot = probes.filter((p) => p.slotBox !== null && p.slotData !== p.slot).map((p) => `${p.key}: drawn in ${p.slotData}`);
    const undeclared = probes
      .filter((p) => p.slotBox !== null && (p.declared === null || !inside(p.slotBox, p.declared) || !inside(p.declared, p.slotBox)))
      .map((p) => `${p.key}: slot ${fmt(p.slotBox)} vs declared ${fmt(p.declared)}`);
    const notFilling = probes.filter((p) => p.slotBox !== null && !p.fills).map((p) => p.key);
    const overScorebug = probes.filter((p) => p.slotBox !== null && intersects(p.slotBox, p.safeArea)).map((p) => `${p.key}: ${fmt(p.slotBox)} meets ${fmt(p.safeArea)}`);
    const lift = (p: (typeof probes)[number]) => 1080 - (p.slotBox!.y + p.slotBox!.height);
    const low = probes.filter((p) => p.slotBox !== null && lift(p) < BAR_BOTTOM_MIN_PX - TOL).map((p) => `${p.key}: ${lift(p).toFixed(1)}px off the floor`);
    const textChecked = probes.reduce((n, p) => n + p.textChecked, 0);
    const below = probes.flatMap((p) => p.below.map((b) => `${p.key}: ${b}`));
    const overflowing = probes.flatMap((p) => p.overflow.map((o) => `${p.key}: ${o}`));
    const badCut = probes.filter((p) => !p.nameCutOk).map((p) => p.key);
    const lowerCut = slotCells.filter((p) => p.slot === "lower_third" && p.nameCut).length;
    const lowerThirds = slotCells.filter((p) => p.slot === "lower_third").length;
    // The face each cell pins (`data-sponsor-face`): full = a logo and `seazn.club/s/<code>` (R7); plain = the
    // monogram and nothing link-like (fix round 1, m3); witness = a full face whose name is the longest a sponsor can
    // have (80 characters) — too wide for any slot by the font's own metrics (sponsor-card.test.tsx), so it is the
    // ellipsis's and the clamp's witness (fix round 2). The 43-character name FITS every slot whole (758 px in an
    // 816 px lower-third column; two lines in the banner), so on its own it witnesses neither.
    const fullFaces = slotCells.filter((p) => p.face === "full");
    const plainFaces = slotCells.filter((p) => p.face === "plain");
    const witnessFaces = slotCells.filter((p) => p.face === "witness");
    const linked = [...fullFaces, ...witnessFaces];
    const linkless = linked.filter((p) => !/^seazn\.club\/s\/[A-Z0-9]+$/.test(p.link ?? "") || !p.logo || p.mono).map((p) => `${p.key}: ${p.link}`);
    const plainWrong = plainFaces.filter((p) => p.link !== null || p.logo || !p.mono).map((p) => `${p.key}: link ${p.link}, logo ${p.logo}`);
    expect(fullFaces.length + plainFaces.length + witnessFaces.length, "every sponsor-slot cell names its face").toBe(slotCells.length);
    expect(plainFaces.length, "anti-vacuity: the plain face is drawn").toBeGreaterThan(0);
    // The witness is drawn on EVERY template's every slot, and it is cut on each one (cleanly: `badCut` below).
    const witnessSlots = new Set(witnessFaces.map((p) => `${p.template}|${p.slot}`));
    const everySlot = new Set(templates.flatMap((t) => ["lower_third", "banner"].map((slot) => `${t}|${slot}`)));
    expect([...witnessSlots].sort(), "the witness reaches every template's every slot").toEqual([...everySlot].sort());
    const witnessWhole = witnessFaces.filter((p) => !p.nameCut).map((p) => p.key);
    // The scene's match card and its brand mark, where the scene draws them (Starting soon always does).
    const besideMatch = carouselCells.filter((p) => p.slotBox !== null && p.matchBox !== null);
    const overMatch = carouselCells
      .filter(
        (p) =>
          p.slotBox !== null &&
          ((p.matchBox !== null && intersects(p.slotBox, p.matchBox)) || (p.brandBox !== null && intersects(p.slotBox, p.brandBox))),
      )
      .map((p) => `${p.key}: carousel ${fmt(p.slotBox)} vs match card ${fmt(p.matchBox)}, brand ${fmt(p.brandBox)}`);
    console.log(
      `[9] cards checked: ${probes.length - cardless.length}, text elements: ${textChecked}, below ${TEXT_FLOOR_PX}px: ${below.length}, ` +
        `lowest lift: ${Math.min(...probes.filter((p) => p.slotBox).map(lift)).toFixed(1)}px, lower-third names cut: ${lowerCut} of ${lowerThirds}, ` +
        `faces: ${fullFaces.length} full, ${plainFaces.length} plain, ${witnessFaces.length} witness (cut: ${witnessFaces.length - witnessWhole.length}), ` +
        `carousel cards measured against a match card: ${besideMatch.length} of ${carouselCells.length}, over it: ${overMatch.length}`,
    );
    expect(besideMatch.length, "anti-vacuity: a carousel shares the canvas with a match card (Starting soon)").toBeGreaterThan(0);
    expect(textChecked, "anti-vacuity: no sponsor text read").toBeGreaterThan(0);
    expect(lowerCut, "anti-vacuity: a name is cut on at least one lower third (the witness)").toBeGreaterThan(0);
    expect(witnessWhole, "anti-vacuity: the longest name allowed is cut on every lower third and banner").toEqual([]);
    expect.soft(cardless, "a sponsor cell without exactly one card").toEqual([]);
    expect.soft(wrongSlot, "a card drawn in another look's slot").toEqual([]);
    expect.soft(undeclared, "a slot off its declared box").toEqual([]);
    expect.soft(notFilling, "a card that does not fill its slot").toEqual([]);
    expect.soft(overScorebug, "a sponsor slot over the template's declared box").toEqual([]);
    expect.soft(low, `a sponsor card under ${BAR_BOTTOM_MIN_PX} canvas px off the floor`).toEqual([]);
    expect.soft(below, `sponsor text below the ${TEXT_FLOOR_PX}px floor`).toEqual([]);
    expect.soft(overflowing, "sponsor content escaping its card").toEqual([]);
    expect.soft(badCut, "a cut name with no ellipsis or clamp").toEqual([]);
    expect.soft(linkless, "R7: the full face's logo and short link").toEqual([]);
    expect.soft(plainWrong, "the plain face: the monogram, no logo, nothing link-like").toEqual([]);
    expect.soft(overMatch, "a carousel card over the scene's match card").toEqual([]);
  });

  // 8 — review a (PR #974): at the 30 px floor a crease line ran out of band and its ellipsis landed on the BOWLER'S
  // FIGURES ("0.3-0-…") while the name stayed whole. A number is the fact a broadcast graphic exists to carry: a name may
  // yield, a figure never does. Read at all three frames (the canvas is laid out at 1920 and scaled, so a frame changes
  // nothing — which is exactly the claim this check holds). Three halves: every crease figure, ball glyph and striker
  // mark is whole, inside its own entry and inside every box that clips it; no ellipsised box in a detail entry holds a
  // numeral (the old one-label shape, or any future one, fails here even with no figure box to read); and the striker's
  // mark LEADS its NAME — in the name's box, at its start edge, the name between it and the figures. After the name it
  // drifted toward the figures ("Fuji… * 31" reads as the not-out "31*") and could never hug an ellipsis (confirm pass).
  test("check 8: a figure is never cut — every crease figure and ball glyph whole, at Full HD, 844 and 390", async ({ page }) => {
    test.setTimeout(300_000);
    await signInStaff(page);
    for (const query of ["", "?frame=844", "?frame=390"]) {
      const declared = await openGallery(page, query);
      const read = await page.evaluate(probeFigures, null);
      console.log(
        `[8] frame ${query || "full"}: cells ${declared}, figures + glyphs checked: ${read.figures} (in a bug: ${read.bugFigures}), marks checked: ${read.marks}, cut boxes read: ${read.ellipsised}, figures cut: ${read.cut.length}`,
      );
      expect(read.figures, `anti-vacuity: no crease figure or ball glyph was read at ${query || "full"}`).toBeGreaterThan(0);
      // R2005 change 12: the corner bug's striker line, apart — the aggregate would hide a bug that drew nothing.
      expect(read.bugFigures, `anti-vacuity: no figure was read inside an .ovl-bug cell at ${query || "full"}`).toBeGreaterThan(0);
      expect(read.marks, `anti-vacuity: no striker mark was read at ${query || "full"}`).toBeGreaterThan(0);
      expect.soft(read.cut, `figures cut at ${query || "full"}`).toEqual([]);
    }
  });

  // 8b — confirm pass, PR #974: check 8 reads the gallery's own names, and those never squeeze an entry down to its
  // figures — so the floor that holds them (`.ovl-detail-entry--figures { min-width: auto }`) went unread, and that rule
  // set to 0 passed check 8. Here the first name in every crease band is made hostile (400 characters, no digits): the
  // band must give nearly all of it back, a flex row shrinks every entry in proportion to its width, and an entry with
  // no floor is pushed under its own figures, which then spill out of it. The witness that the squeeze reached a floor:
  // some name in a squeezed band gave every pixel it had. Cricket only, with no sweep: the crease is the only detail line
  // that carries figures. R2005 change 12 adds the corner bug's striker line, whose ONE name is made hostile too: it
  // must ellipse while its figures stay whole. Read at all three frames, as check 8 is (the brief's acceptance: "check 8
  // and 8b at 1920, 844 and 390"); a frame scales the one 1920 layout, so all three must agree.
  test("check 8b: a hostile name squeezes the crease band, and every figure still sits whole inside its own entry", async ({ page }) => {
    test.setTimeout(300_000);
    await signInStaff(page);
    let frames = 0;
    for (const query of ["", "?frame=844", "?frame=390"]) {
      const at = query || "full";
      const declared = await openGallery(page, query);
      const read = await page.evaluate(probeFigures, HOSTILE_NAME);
      console.log(
        `[8b] frame ${at}: cells ${declared}, crease bands squeezed: ${read.squeezed}, reaching a floor: ${read.floored}, bug striker names squeezed: ${read.bugSqueezed} (ellipsised: ${read.bugNameEllipsised}), figures + glyphs + marks checked: ${read.figures + read.marks} (bug figures: ${read.bugFigures}), figures cut: ${read.cut.length}`,
      );
      expect(read.squeezed, `anti-vacuity: no crease band was squeezed at ${at}`).toBeGreaterThan(0);
      expect(read.floored, `anti-vacuity: the squeeze never reached a figures floor at ${at}`).toBeGreaterThan(0);
      expect(read.figures, `anti-vacuity: no figure was read at ${at}`).toBeGreaterThan(0);
      // R2005 change 12: the bug's striker name YIELDS (ellipses) and its figures stay whole (the `cut` read below).
      expect(read.bugSqueezed, `anti-vacuity: no bug striker name was squeezed at ${at}`).toBeGreaterThan(0);
      expect(read.bugNameEllipsised, `every squeezed bug striker name ellipses at ${at}`).toBe(read.bugSqueezed);
      expect(read.bugFigures, `anti-vacuity: no bug figure was read under the squeeze at ${at}`).toBeGreaterThan(0);
      expect.soft(read.cut, `figures cut under the squeeze at ${at}`).toEqual([]);
      frames++;
    }
    expect(frames, "frames checked").toBe(3);
  });

  // Owner ruling (1), 2026-10-19 (relayed by the coordinator): the Result card's headline is a MEASURED ladder — the full
  // result sentence, the same sentence with the winner's short code, that short sentence at the compact size, then the
  // highlights give way; each rung only when the one before does not fit on ONE line. (Round 1, item 2 before it: the
  // two-line clamp is the "A vs B" headline's alone, and a Result headline is never clamped.)
  //
  // Every Result card runs through the REAL producer and the REAL ladder: the gallery's stress mode
  // (`gallery-stress.ts`) makes every winner-bearing decided template one `fixture.decidedBy.*` sentence and gives each
  // side its own 43-character name, and the page is loaded in each locale. Sentences and locales come from the dictionaries on disk;
  // the cells from the page. Per card: nothing hidden (the card's own overflow, any text box cut — headline AND
  // highlights), no clamp, a rung-0..2 headline on ONE line, each rung taken only when the one before does not fit
  // (measured by a clone of the previous rung in the same card), and the highlights gone exactly at the last rung.
  test("check 4c: every Result card fits by the headline ladder — every locale × every decided sentence, a 43-character winner, the real producer", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(900_000);
    await signInStaff(page);
    const WINNER = "Haruto Fujimoto and Kenji Watanabe-Yamamoto";
    expect(WINNER.length).toBe(43);
    // The away side its OWN long name (the gallery's own club name), so the capture is a real fixture, the winner is
    // 43 characters whoever wins, and the short rung must name the winning side by THAT side's code.
    const AWAY = "Northbridge Athletic Football & Social Club";
    expect(AWAY.length).toBe(43);
    expect(AWAY[0], "two different first letters, so two different codes").not.toBe(WINNER[0]);
    const dictRoot = fileURLToPath(new URL("../src/dictionaries/", import.meta.url));
    const locales = readdirSync(dictRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    expect(locales.length, "anti-vacuity: the locales read").toBeGreaterThanOrEqual(4);

    const total = { loads: 0, cases: 0, hidden: [] as string[], rungs: { full: 0, short: 0, compact: 0, yield: 0 } as Record<string, number>, forced: 0, winnerBearing: 0, unforced: [] as string[], perLoad: new Set<number>() };
    const sweep = async (locale: string, key: string, template: string, extra: Record<string, string> = {}) => {
      await page.context().addCookies([{ name: "seazn_locale", value: locale, url: baseURL! }]);
      const q = new URLSearchParams({ decided: key, name: WINNER, away: AWAY, ...extra });
      await openGallery(page, `?${q.toString()}`);
      await page.evaluate(() => document.fonts.ready);
      await expect
        .poll(() => page.locator('[data-testid="ovl-slate-headline"][data-result-rung]:not([data-result-ladder-settled="true"])').count(), {
          message: `${locale} ${key}: every Result headline measured`,
        })
        .toBe(0);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      return page.evaluate(
        ({ template, names, score }) => {
          const out = { cells: 0, hidden: [] as string[], rungs: {} as Record<string, number>, forced: 0, winnerBearing: 0, unforced: [] as string[] };
          const linesOf = (el: HTMLElement) => Math.round(el.offsetHeight / parseFloat(getComputedStyle(el).lineHeight));
          const cells = [...document.querySelectorAll<HTMLElement>("[data-gallery-cell]")].filter((c) =>
            c.querySelector('[data-testid="ovl-slate"][data-slate-state="ended"]:not([data-card])'),
          );
          for (const cell of cells) {
            const h = cell.querySelector<HTMLElement>('[data-testid="ovl-slate-headline"]');
            const card = cell.querySelector<HTMLElement>('[data-testid="ovl-slate-card"]');
            const where = cell.dataset.galleryCell ?? "?";
            if (!h || !card) {
              out.hidden.push(`${where}: no headline or card`);
              continue;
            }
            out.cells++;
            const rung = h.getAttribute("data-result-rung") ?? "none";
            out.rungs[rung] = (out.rungs[rung] ?? 0) + 1;
            // The side the cell's OUTCOME credits (`data-result-winner`, read off the snapshot, never the model), and that
            // side's own name and code: never the first tile's, which named the home side whoever won.
            const w = cell.dataset.resultWinner;
            if (w === "0" || w === "1") {
              out.winnerBearing++;
              const code = cell.querySelector(`[data-testid="ovl-slate-tile-${w}"] .ovl-slate-tile-code`)?.textContent ?? "";
              const full = template.replaceAll("{score}", score).replaceAll("{winner}", names[Number(w)]!);
              const short = template.replaceAll("{score}", score).replaceAll("{winner}", code);
              if (h.textContent === full || h.textContent === short) out.forced++;
              else out.unforced.push(`${where} [${rung}]: "${(h.textContent ?? "").slice(0, 48)}" is not the forced sentence naming side ${w} (${code})`);
            }
            // 1. Nothing hidden: the card's own overflow, then every text box in it (the headline AND the highlights).
            if (card.scrollHeight > card.clientHeight + 1) out.hidden.push(`${where} [${rung}]: the card hides ${card.scrollHeight - card.clientHeight}px`);
            for (const el of card.querySelectorAll<HTMLElement>("*")) {
              const own = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "");
              if (!own) continue;
              const cs = getComputedStyle(el) as CSSStyleDeclaration & { webkitLineClamp?: string };
              if (el === h && cs.webkitLineClamp !== undefined && cs.webkitLineClamp !== "" && cs.webkitLineClamp !== "none") {
                out.hidden.push(`${where} [${rung}]: the Result headline is line-clamped (${cs.webkitLineClamp})`);
              }
              if (el.scrollHeight > el.clientHeight + 1 && cs.overflowY !== "visible") {
                out.hidden.push(`${where} [${rung}]: "${(el.textContent ?? "").slice(0, 28)}" cut to ${el.clientHeight}px of ${el.scrollHeight}px`);
              }
            }
            // 2. A headline rung is ONE line; the last rung alone may wrap, and it alone drops the highlights.
            if (rung !== "yield" && linesOf(h) !== 1) out.hidden.push(`${where} [${rung}]: the headline runs ${linesOf(h)} lines`);
            const hasHighlights = cell.querySelector('[data-testid="ovl-slate-highlights"]') !== null;
            if (rung === "yield" && hasHighlights) out.hidden.push(`${where} [yield]: the highlights did not give way`);
            // 3. Taken only when the rung before does not fit on one line: the previous rung, cloned into this card.
            //    short ← the full sentence at the headline size (the first probe's text); compact ← the short sentence at the
            //    headline size; yield ← the short sentence at the compact size (both the text on air).
            const previous: Record<string, { text: string; compact: boolean }> = {
              short: { text: cell.querySelector(".ovl-slate-headline-probe")?.textContent ?? "", compact: false },
              compact: { text: h.textContent ?? "", compact: false },
              yield: { text: h.textContent ?? "", compact: true },
            };
            const prev = previous[rung];
            if (prev) {
              const probe = document.createElement("span");
              probe.className = `ovl-slate-headline ovl-display${prev.compact ? " ovl-slate-headline--compact" : ""}`;
              probe.textContent = prev.text;
              h.after(probe);
              const lines = linesOf(probe);
              probe.remove();
              if (lines <= 1) out.hidden.push(`${where} [${rung}]: taken though the rung before fits on one line ("${(probe.textContent ?? "").slice(0, 40)}")`);
            }
          }
          return out;
        },
        { template, names: [WINNER, AWAY], score: "4–3" },
      );
    };

    for (const locale of locales) {
      const ui = JSON.parse(readFileSync(`${dictRoot}${locale}/ui.json`, "utf8")) as Record<string, string>;
      const keys = Object.keys(ui).filter((k) => k.startsWith("fixture.decidedBy."));
      expect(keys.length, `anti-vacuity: ${locale}'s decided sentences`).toBeGreaterThanOrEqual(10);
      for (const key of keys) {
        const read = await sweep(locale, key, ui[key]!);
        total.loads++;
        total.cases += read.cells;
        total.perLoad.add(read.cells);
        total.forced += read.forced;
        total.winnerBearing += read.winnerBearing;
        total.unforced.push(...read.unforced.map((u) => `${locale} ${key} ${u}`));
        total.hidden.push(...read.hidden.map((h) => `${locale} ${key} ${h}`));
        for (const [r, n] of Object.entries(read.rungs)) total.rungs[r] = (total.rungs[r] ?? 0) + n;
      }
    }
    console.log(
      `[4c] locales ${locales.length} (${locales.join(", ")}), loads ${total.loads}, Result cards checked ${total.cases}, naming a winner ${total.winnerBearing}, showing the forced sentence ${total.forced}, rungs ${JSON.stringify(total.rungs)}, hidden ${total.hidden.length}`,
    );
    expect([...total.perLoad], "every load draws the same Result cells").toHaveLength(1);
    expect(total.cases, "anti-vacuity: every Result card of every load").toBe(total.loads * [...total.perLoad][0]!);
    expect(total.cases).toBeGreaterThan(1000);
    // The verdict before the rung counts, so a ladder that stops early reds as the content it hides.
    expect(total.hidden.slice(0, 25), `Result cards hiding content or off the ladder (${total.hidden.length})`).toEqual([]);
    expect(total.winnerBearing, "anti-vacuity: Result cards whose outcome names a winner").toBeGreaterThan(0);
    // EVERY card that names a winner shows the forced sentence, naming the credited side by its own name or code — not
    // merely some card somewhere (a short rung naming the other side, or a stale code, drops a card out of this count).
    expect(total.unforced.slice(0, 25), `Result cards naming a winner without the forced sentence (${total.unforced.length})`).toEqual([]);
    expect(total.forced, "the forced sentence reached every card that names a winner").toBe(total.winnerBearing);
    for (const r of ["full", "short", "compact"]) expect(total.rungs[r] ?? 0, `anti-vacuity: rung ${r} reached`).toBeGreaterThan(0);

    // The last rung: the widest code the badge bound allows (`?code=`, the model's own `short` — cut to BADGE_MAX_CHARS,
    // four, since #987's confirm pass, so a longer one would air as its first four) runs even the compact short sentence
    // past one line in the narrowest card — the highlights give way, and the card still hides nothing. ÆÆÆÆ is the
    // face's widest four capitals (check 4d's `WIDE_CODE_PAIRS`).
    const reach = await sweep("fr", "fixture.decidedBy.settled.organiser", JSON.parse(readFileSync(`${dictRoot}fr/ui.json`, "utf8"))["fixture.decidedBy.settled.organiser"], { code: "ÆÆÆÆ" });
    console.log(`[4c] last rung (fr, organiser, the widest four-character code): cards ${reach.cells}, rungs ${JSON.stringify(reach.rungs)}, hidden ${reach.hidden.length}`);
    expect(reach.rungs.yield ?? 0, "anti-vacuity: the last rung reached").toBeGreaterThan(0);
    expect(reach.hidden.slice(0, 25)).toEqual([]);
  });

  // fix/overlay-team-code-disambiguation (owner ruling 2026-10-19): the overlay's side codes are the public site's
  // `disambiguatedShorts` pair. Three letters per name aired Harlow and Harrow as HAR / HAR — on the bug, at the bar's
  // tightest rung, on the tiles, and in the Result card's short rung ("HAR won 4–3 on penalties"), which named nobody.
  // Every cell of every template, read off the RENDERED page: the two sides' codes differ wherever both are drawn, each
  // side has ONE code across every template, and every short Result rung names the credited side (the cell's own
  // `data-result-winner`, read off the snapshot) by that side's code.
  test("check 4d: two sides sharing a three-letter prefix (Harlow v Harrow) read two different codes on every template — bug, bar, tiles, short Result rung — and the widest four-letter codes fit the bug, the bar and the tiles at 1920, 844 and 390", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(900_000);
    await signInStaff(page);
    const NAMES = ["Harlow", "Harrow"] as const;
    expect(NAMES[0].slice(0, 3), "premise: three letters per name collide").toBe(NAMES[1].slice(0, 3));
    const key = "fixture.decidedBy.shootout";
    const ui = JSON.parse(readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8")) as Record<string, string>;
    const template = ui[key]!;
    expect(template, "the forced sentence names its winner").toContain("{winner}");
    await page.context().addCookies([{ name: "seazn_locale", value: "en", url: baseURL! }]);
    await openGallery(page, `?${new URLSearchParams({ decided: key, name: NAMES[0], away: NAMES[1] }).toString()}`);
    await page.evaluate(() => document.fonts.ready);
    await expect
      .poll(() => page.locator('[data-testid="ovl-slate-headline"][data-result-rung]:not([data-result-ladder-settled="true"])').count(), {
        message: "every Result headline measured",
      })
      .toBe(0);
    const read = await page.evaluate(
      ({ template, score }) => {
        const text = (el: Element | null | undefined) => (el?.textContent ?? "").trim();
        const out = {
          cells: 0,
          perTemplate: {} as Record<string, { cells: number; pairs: number }>,
          pairs: { bug: 0, bar: 0, tiles: 0 } as Record<string, number>,
          same: [] as string[],
          codes: [[], []] as string[][],
          winnerBearing: 0,
          shortRungs: 0,
          wrongShort: [] as string[],
        };
        for (const cell of document.querySelectorAll<HTMLElement>("[data-gallery-cell]")) {
          const where = cell.dataset.galleryCell ?? "?";
          const tpl = cell.dataset.template ?? "?";
          out.cells++;
          const per = (out.perTemplate[tpl] ??= { cells: 0, pairs: 0 });
          per.cells++;
          const pair = (surface: string, home: string, away: string) => {
            out.pairs[surface] = (out.pairs[surface] ?? 0) + 1;
            per.pairs++;
            out.codes[0]!.push(home);
            out.codes[1]!.push(away);
            if (home === "" || away === "" || home === away) out.same.push(`${where} ${surface}: "${home}" / "${away}"`);
          };
          // The bug's code column — both rows, where both are drawn (cricket's bug carries one hero row).
          const bug = [...cell.querySelectorAll(".ovl-bug-code")].map(text);
          if (bug.length === 2) pair("bug", bug[0]!, bug[1]!);
          // The bar's tightest rung — the LAST probe of each side's name ladder, the code it steps down to.
          const rungOf = (side: string) => {
            const probes = [...cell.querySelectorAll(`[data-testid="${side}"] .ovl-team-name-probe`)];
            return probes.length > 0 ? text(probes[probes.length - 1]) : null;
          };
          const [barHome, barAway] = [rungOf("ovl-side-home"), rungOf("ovl-side-away")];
          if (barHome !== null && barAway !== null) pair("bar", barHome, barAway);
          // The scene and Result cards' tiles.
          const tile = (i: number) => cell.querySelector(`[data-testid="ovl-slate-tile-${i}"] .ovl-slate-tile-code`);
          if (tile(0) && tile(1)) pair("tiles", text(tile(0)), text(tile(1)));
          // The Result card's short rung (the ladder's second probe): the credited side, by its own code.
          const w = cell.dataset.resultWinner;
          const probes = [...cell.querySelectorAll(".ovl-slate-headline-probe")];
          if ((w === "0" || w === "1") && probes.length >= 2 && tile(0) && tile(1)) {
            out.winnerBearing++;
            const codes = [text(tile(0)), text(tile(1))];
            const want = template.replaceAll("{score}", score).replaceAll("{winner}", codes[Number(w)]!);
            const other = template.replaceAll("{score}", score).replaceAll("{winner}", codes[1 - Number(w)]!);
            const got = text(probes[1]);
            if (got === want && got !== other) out.shortRungs++;
            else out.wrongShort.push(`${where}: short rung "${got}", want "${want}"`);
          }
        }
        return out;
      },
      { template, score: "4–3" },
    );
    const unique = (xs: string[]) => [...new Set(xs)];
    console.log(
      `[4d] cells ${read.cells}, pairs ${JSON.stringify(read.pairs)}, per template ${JSON.stringify(read.perTemplate)}, codes ${JSON.stringify(read.codes.map(unique))}, short Result rungs ${read.shortRungs}/${read.winnerBearing}`,
    );
    // Anti-vacuity: every template the registry ships drew codes to compare, and every surface was read.
    const templates = Object.keys(read.perTemplate);
    expect(templates.length, "anti-vacuity: the gallery's templates").toBeGreaterThanOrEqual(2);
    for (const tpl of templates) expect(read.perTemplate[tpl]!.pairs, `anti-vacuity: ${tpl} drew both sides' codes`).toBeGreaterThan(0);
    for (const surface of ["bug", "bar", "tiles"]) expect(read.pairs[surface] ?? 0, `anti-vacuity: ${surface} pairs read`).toBeGreaterThan(0);
    // The verdicts: never one code for both sides, and ONE code per side on every template.
    expect(read.same.slice(0, 25), `sides drawn with the same code (${read.same.length})`).toEqual([]);
    expect(unique(read.codes[0]!), "Harlow reads one code on every template").toHaveLength(1);
    expect(unique(read.codes[1]!), "Harrow reads one code on every template").toHaveLength(1);
    expect(unique(read.codes[0]!)[0]).not.toBe(unique(read.codes[1]!)[0]);
    // Every short Result rung names the credited side by its own code.
    expect(read.winnerBearing, "anti-vacuity: Result cards whose outcome names a winner").toBeGreaterThan(0);
    expect(read.wrongShort.slice(0, 25), `short Result rungs naming the wrong side or an ambiguous code (${read.wrongShort.length})`).toEqual([]);
    expect(read.shortRungs).toBe(read.winnerBearing);

    // The fit (#987 confirm pass N2 / M6): the widest four-letter codes the ladder mints, at all three frames, on the
    // bug, the bar's tightest rung and the tiles. Harlow / Harrow alone measured HARL / HARR (86.8 / 89.0 px), which
    // fit a column that WOME (100.4) and TOWN (99.1) overflow — one lucky sample, so the sweep carries the widest.
    for (const frame of FIT_FRAMES) {
      for (const { name, away, codes } of WIDE_CODE_PAIRS) {
        const params = new URLSearchParams({ name, away });
        if (frame !== "") params.set("frame", frame);
        await openGallery(page, `?${params.toString()}`);
        await page.evaluate(() => document.fonts.ready);
        // A ladder whose tightest rung does not fit never settles: wait for it, and let the verdict below report it.
        await expect
          .poll(() => page.locator('.ovl-team-name:not([data-ladder-settled="true"])').count(), { timeout: 10_000 })
          .toBe(0)
          .catch(() => undefined);
        const fit = await page.evaluate(probeCodeFit, CANVAS_W);
        const at = `${frame || "1920"} ${codes.join("/")}`;
        const widest = (xs: CodeFit[]) => xs.reduce((m, x) => (x.ink > m.ink ? x : m), { ink: 0, room: 0, code: "", where: "" });
        const summary = (["bug", "bar", "tiles"] as const).map((s) => {
          const w = widest(fit[s]);
          return `${s} ${fit[s].length} (widest "${w.code}" ${w.ink.toFixed(1)} in ${w.room.toFixed(1)})`;
        });
        console.log(`[4d fit] frame ${at}: ${summary.join(", ")}`);
        for (const surface of ["bug", "bar", "tiles"] as const) {
          expect(fit[surface].length, `anti-vacuity: ${surface} codes measured at ${at}`).toBeGreaterThan(0);
          // The premise: this load drew the codes it is here for, on this surface.
          const drawn = new Set(fit[surface].map((f) => f.code));
          for (const code of codes) expect(drawn.has(code), `premise: ${surface} drew "${code}" at ${at} (drew ${[...drawn].join(", ")})`).toBe(true);
          const misfit = fit[surface]
            .filter((f) => f.ink > f.room + 0.5 || f.settled === false || f.inCard === false)
            .map((f) => `${f.where}: "${f.code}" ${f.ink.toFixed(1)}px in ${f.room.toFixed(1)}px${f.settled === false ? ", ladder unsettled" : ""}${f.inCard === false ? ", tile out of its card" : ""}`);
          expect.soft(misfit.slice(0, 25), `${surface} codes that do not fit at ${at} (${misfit.length})`).toEqual([]);
        }
      }
    }
  });

  test("check 6: no preview fetches or subscribes — nothing leaves the page for 16 s (longer than POLL_MS)", async ({ page }) => {
    test.setTimeout(180_000);
    await signInStaff(page);
    const fetches: string[] = [];
    const sockets: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/api/v1/public/fixtures/")) fetches.push(req.url());
    });
    page.on("websocket", (ws) => sockets.push(ws.url()));
    const declared = await openGallery(page);
    await page.waitForTimeout(16_000);
    console.log(`[6] cells: ${declared}, fixture fetches: ${fetches.length}, websockets: ${sockets.length}`);
    expect(fetches, "a preview polled the fixture endpoint").toEqual([]);
    expect(sockets, "a preview opened a socket").toEqual([]);
  });

  test("check 7: ?frame=844 and ?frame=390 render each preview at that width", async ({ page }) => {
    test.setTimeout(240_000);
    await signInStaff(page);
    for (const frame of [844, 390]) {
      const declared = await openGallery(page, `?frame=${frame}`);
      const widths = await page
        .locator('[data-testid="ovl-preview"]')
        .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
      const off = widths.filter((w) => Math.abs(w - frame) > 1);
      console.log(`[7] frame ${frame}: previews checked: ${widths.length} of ${declared} cells, off-width: ${off.length}`);
      expect(widths.length, "anti-vacuity").toBe(declared);
      expect(off, `previews not ${frame} px wide`).toEqual([]);
    }
  });
});
