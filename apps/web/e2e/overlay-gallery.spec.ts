import { test, expect, type Page } from "@playwright/test";
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
  }
  for (const root of roots) {
    const key = root.closest<HTMLElement>("[data-gallery-cell]")?.dataset.galleryCell ?? "?";
    for (const fig of root.querySelectorAll<HTMLElement>(".ovl-detail-figures, .ovl-ball-glyph, .ovl-detail-mark")) {
      if (!visible(fig)) continue;
      const isMark = fig.classList.contains("ovl-detail-mark");
      if (isMark) marks++;
      else figures++;
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
  return { figures, marks, ellipsised, squeezed, floored, cut };
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
        `[8] frame ${query || "full"}: cells ${declared}, figures + glyphs checked: ${read.figures}, marks checked: ${read.marks}, cut boxes read: ${read.ellipsised}, figures cut: ${read.cut.length}`,
      );
      expect(read.figures, `anti-vacuity: no crease figure or ball glyph was read at ${query || "full"}`).toBeGreaterThan(0);
      expect(read.marks, `anti-vacuity: no striker mark was read at ${query || "full"}`).toBeGreaterThan(0);
      expect.soft(read.cut, `figures cut at ${query || "full"}`).toEqual([]);
    }
  });

  // 8b — confirm pass, PR #974: check 8 reads the gallery's own names, and those never squeeze an entry down to its
  // figures — so the floor that holds them (`.ovl-detail-entry--figures { min-width: auto }`) went unread, and that rule
  // set to 0 passed check 8. Here the first name in every crease band is made hostile (400 characters, no digits): the
  // band must give nearly all of it back, a flex row shrinks every entry in proportion to its width, and an entry with
  // no floor is pushed under its own figures, which then spill out of it. The witness that the squeeze reached a floor:
  // some name in a squeezed band gave every pixel it had. Full HD only — a frame scales the one 1920 layout (check 8
  // reads all three). Cricket only, with no sweep: the crease is the only detail line that carries figures.
  test("check 8b: a hostile name squeezes the crease band, and every figure still sits whole inside its own entry", async ({ page }) => {
    await signInStaff(page);
    const declared = await openGallery(page, "");
    const read = await page.evaluate(probeFigures, HOSTILE_NAME);
    console.log(
      `[8b] cells ${declared}, crease bands squeezed: ${read.squeezed}, reaching a floor: ${read.floored}, figures + glyphs + marks checked: ${read.figures + read.marks}, figures cut: ${read.cut.length}`,
    );
    expect(read.squeezed, "anti-vacuity: no crease band was squeezed").toBeGreaterThan(0);
    expect(read.floored, "anti-vacuity: the squeeze never reached a figures floor").toBeGreaterThan(0);
    expect(read.figures, "anti-vacuity: no figure was read").toBeGreaterThan(0);
    expect.soft(read.cut, "figures cut under the squeeze").toEqual([]);
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
