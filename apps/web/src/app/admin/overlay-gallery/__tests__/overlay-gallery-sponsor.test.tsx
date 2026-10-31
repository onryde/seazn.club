// R4 S7 — the staff gallery's sponsor cells, through the REAL page and the REAL client component (spec 2026-10-27 §3.5).
//
// `gallery-matrix.test.ts` proves the cell source declares template × sport × slot; this proves each such cell DRAWS
// it: the page's own props, the gallery's own `cellData`, the stage's own slot placement — rendered to markup, so a cell
// that lost its plan or its pinned card reads as a cell without a card here, not only in the CI-only e2e (check 9).
// Expected boxes come from the registry's declarations, the card's name from the gallery's declared cards.
import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OVERLAY_TEMPLATES, type CanvasBox } from "@/components/overlay/template-registry";
import { GALLERY_SPONSOR_CARDS, type GalleryCell } from "@/components/overlay/gallery-matrix";
import { SPONSOR_CAROUSEL_SCENES } from "@/components/overlay/overlay-scenes";
import { sponsorShortLinkText } from "@/lib/sponsor-clicks";

vi.mock("@/lib/admin", () => ({ requireStaff: vi.fn(async () => ({ id: "staff-1", is_staff: true })) }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: vi.fn(async () => "en") }));

function findElement(node: ReactNode, match: (el: ReactElement) => boolean): ReactElement | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, match);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  if (match(node)) return node;
  return findElement((node.props as { children?: ReactNode }).children, match);
}

/** One figure's markup per cell key: the gallery renders one `<figure data-gallery-cell>` per cell. */
function figures(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of html.split("<figure").slice(1)) {
    const key = /data-gallery-cell="([^"]+)"/.exec(part)?.[1];
    if (key !== undefined) out.set(key.replaceAll("&amp;", "&"), part);
  }
  return out;
}

const slotStyle = (b: CanvasBox) =>
  `--ovl-sponsor-x:${b.x}px;--ovl-sponsor-y:${b.y}px;--ovl-sponsor-w:${b.width}px;--ovl-sponsor-h:${b.height}px`;

async function renderGallery(keep: (c: GalleryCell) => boolean) {
  const { OverlayGallery } = await import("../overlay-gallery");
  const { default: Page } = await import("../page");
  const tree = (await Page({ searchParams: Promise.resolve({}) })) as ReactElement;
  const gallery = findElement(tree, (el) => el.type === OverlayGallery);
  expect(gallery, "the page renders an <OverlayGallery>").toBeDefined();
  const props = gallery!.props as Parameters<typeof OverlayGallery>[0];
  const cells = props.cells.filter(keep);
  return { cells, html: renderToStaticMarkup(<OverlayGallery {...props} cells={cells} />) };
}

describe("the gallery's sponsor cells draw the card in the template's declared slot", () => {
  it("every sponsor-slot cell: one card, in its slot's declared box, the 43-character name and the short link", async () => {
    const { cells, html } = await renderGallery((c) => c.sponsorSlot !== null);
    const byKey = figures(html);
    const title = GALLERY_SPONSOR_CARDS[0]!;
    const link = sponsorShortLinkText(title.shortCode);
    expect(link, "premise: the title card prints a short link").not.toBeNull();
    let checked = 0;
    for (const cell of cells) {
      const fig = byKey.get(cell.key);
      expect(fig, `${cell.key} is drawn`).toBeDefined();
      const declared = OVERLAY_TEMPLATES[cell.templateId as keyof typeof OVERLAY_TEMPLATES].sponsorSlots[cell.sponsorSlot!];
      expect(fig!.match(/data-testid="ovl-sponsor-card"/g), `${cell.key}: exactly one card`).toHaveLength(1);
      expect(fig, `${cell.key}: the ${cell.sponsorSlot} slot`).toContain(`data-testid="ovl-sponsor-slot" data-slot="${cell.sponsorSlot}"`);
      expect(fig, `${cell.key}: the declared box`).toContain(slotStyle(declared));
      expect(fig, `${cell.key}: the card in the slot's own look`).toContain(`data-style="${cell.sponsorSlot}"`);
      expect(fig, `${cell.key}: held, not folding`).toContain('data-phase="hold"');
      expect(fig).toContain(title.name.replaceAll("&", "&amp;"));
      expect(fig).toContain(`data-testid="ovl-sponsor-link" class="ovl-sponsor-link">${link}<`);
      // The card is not ALSO drawn as a slab in the moment slot.
      expect(fig, `${cell.key}: no slab`).not.toContain('data-testid="overlay-moment"');
      checked++;
    }
    console.log(`sponsor-slot cells drawn and checked: ${checked}`);
    expect(checked, "anti-vacuity").toBeGreaterThan(0);
    expect(byKey.size).toBe(checked);
  });

  it("every carousel cell: the banner slot is placed (the showing starts in an effect, after the markup)", async () => {
    const { cells, html } = await renderGallery((c) => c.carousel);
    const byKey = figures(html);
    let checked = 0;
    for (const cell of cells) {
      expect(SPONSOR_CAROUSEL_SCENES).toContain(cell.scene);
      const fig = byKey.get(cell.key);
      expect(fig, `${cell.key} is drawn`).toBeDefined();
      const banner = OVERLAY_TEMPLATES[cell.templateId as keyof typeof OVERLAY_TEMPLATES].sponsorSlots.banner;
      expect(fig, `${cell.key}: the carousel's slot`).toMatch(/data-testid="ovl-sponsor-slot" data-slot="banner" data-carousel=""/);
      expect(fig, `${cell.key}: the declared banner box`).toContain(slotStyle(banner));
      checked++;
    }
    console.log(`carousel cells drawn and checked: ${checked}`);
    expect(checked, "anti-vacuity").toBeGreaterThan(0);
  });

  it("a plain live cell carries no sponsor slot (the plan rides on sponsor and carousel cells only)", async () => {
    const { cells, html } = await renderGallery(
      (c) => c.sponsorSlot === null && !c.carousel && c.momentSampleId === null && c.resultStatus === null && c.snapshot === "live",
    );
    expect(cells.length, "anti-vacuity").toBeGreaterThan(0);
    expect(html).not.toContain('data-testid="ovl-sponsor-slot"');
  });
});
