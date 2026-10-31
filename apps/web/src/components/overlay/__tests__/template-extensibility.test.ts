// Spec 2026-10-15 §5 / §4.7 — "adding a template is one entry and one component; nothing else changes" (R2007 step 2).
//
// A throwaway template, declared HERE and nowhere else, has to reach every reader with no other edit: the picker list,
// the gallery's cell source (and so every e2e sweep, which renders those cells 1:1), the card layout (a new box moves
// the cards), and retired-id resolution. The page-level leg mocks the registry MODULE so the gallery page's own
// `OVERLAY_TEMPLATES` import carries the probe — the page is the cell source the e2e renders.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type * as RegistryModule from "../template-registry";

const H = vi.hoisted(() => ({
  probeBox: { x: 1380, y: 54, width: 480, height: 600 },
  // R4 S7: every entry declares its two sponsor slots (spec 2026-10-27 §3.5) — here clear of the probe's box, left side.
  probeSlots: { lower_third: { x: 60, y: 810, width: 1000, height: 120 }, banner: { x: 96, y: 228, width: 560, height: 480 } },
}));

vi.mock("../template-registry", async (importOriginal) => {
  const orig = await importOriginal<typeof RegistryModule>();
  const { OverlayBug } = await import("../overlay-bug");
  const probe: RegistryModule.OverlayTemplateDef<string> = {
    id: "probe",
    labelKey: "stream.tab.bug",
    sports: ["badminton"],
    component: OverlayBug,
    slabPlacement: "bug",
    sceneCardSafeArea: H.probeBox,
    sponsorSlots: H.probeSlots,
  };
  return { ...orig, OVERLAY_TEMPLATES: { ...orig.OVERLAY_TEMPLATES, probe } };
});

vi.mock("@/lib/admin", () => ({ requireStaff: vi.fn(async () => ({ id: "staff-1", is_staff: true })) }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: vi.fn(async () => "en") }));
vi.mock("@/server/overlay/gallery-snapshots", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/server/overlay/gallery-snapshots")>();
  return { ...orig, galleryResultVariants: vi.fn(() => []) };
});

let A: typeof RegistryModule;
let PROBE: RegistryModule.OverlayTemplateDef<string>;
let REG: RegistryModule.TemplateRegistry;
let RETIRED: RegistryModule.TemplateRegistry;

beforeAll(async () => {
  // The REAL module, unmocked: the throwaway entry is added to it here, in the test, exactly as the brief declares.
  A = await vi.importActual<typeof RegistryModule>("../template-registry");
  const { OverlayBug } = await import("../overlay-bug");
  PROBE = {
    id: "probe",
    labelKey: "stream.tab.bug",
    sports: ["badminton"],
    component: OverlayBug,
    // Its own box (top-right), so the test can prove a new template moves the cards with no other edit.
    slabPlacement: "bug",
    sceneCardSafeArea: H.probeBox,
    sponsorSlots: H.probeSlots,
  };
  REG = { ...A.OVERLAY_TEMPLATES, probe: PROBE };
  RETIRED = { ...REG, gone: { ...PROBE, id: "gone", retired: { replacedBy: "probe" } } };
});

const VARIANTS = [{ status: "walkover", sportKey: "badminton" }];

describe("a throwaway template reaches every reader with no other edit", () => {
  it("the picker: offered to badminton (last, registry order), never to cricket", () => {
    const badminton = A.templatesForSportFrom(REG, "badminton").map((t) => t.id);
    expect(badminton[badminton.length - 1]).toBe("probe");
    expect(A.templatesForSportFrom(REG, "cricket").map((t) => t.id)).not.toContain("probe");
  });

  it("the gallery's cell source: exactly the declared probe cells, all badminton", async () => {
    const { galleryCells, GALLERY_CAROUSEL_SPORTS, GALLERY_MOMENT_SAMPLES, GALLERY_SNAPSHOT_KINDS, GALLERY_SPONSOR_FACE_SPORTS } =
      await import("../gallery-matrix");
    const { OVERLAY_SCENES, SPONSOR_CAROUSEL_SCENES } = await import("../overlay-scenes");
    const cells = galleryCells(REG, VARIANTS).filter((c) => c.templateId === "probe");
    const firing = OVERLAY_SCENES.filter((s) => s.momentsFire).length;
    const badmintonSamples = GALLERY_MOMENT_SAMPLES.filter((s) => s.sportKey === "badminton").length;
    const plain = cells.filter((c) => c.momentSampleId === null && c.resultStatus === null && c.sponsorSlot === null && !c.carousel);
    const moment = cells.filter((c) => c.momentSampleId !== null);
    const variant = cells.filter((c) => c.resultStatus !== null);
    // R4 S7: the probe's own declared slots, and the carousel when badminton is a carousel sport.
    const sponsor = cells.filter((c) => c.sponsorSlot !== null);
    const carousel = cells.filter((c) => c.carousel);
    const carouselScenes = OVERLAY_SCENES.filter((s) => SPONSOR_CAROUSEL_SCENES.includes(s.id)).length;
    expect(plain).toHaveLength(OVERLAY_SCENES.length * GALLERY_SNAPSHOT_KINDS.length);
    expect(moment).toHaveLength(badmintonSamples * firing);
    expect(variant).toHaveLength(VARIANTS.length);
    const faces = (GALLERY_SPONSOR_FACE_SPORTS as readonly string[]).includes("badminton") ? 2 : 1;
    expect(sponsor.map((c) => c.sponsorSlot).sort()).toEqual(Object.keys(H.probeSlots).flatMap((k) => Array(faces).fill(k)).sort());
    expect(carousel).toHaveLength((GALLERY_CAROUSEL_SPORTS as readonly string[]).includes("badminton") ? carouselScenes : 0);
    expect(badmintonSamples * firing, "anti-vacuity: badminton has firing moment samples").toBeGreaterThan(0);
    for (const c of cells) expect(c.sportKey, c.key).toBe("badminton");
    console.log(
      `probe cells: ${cells.length} (plain ${plain.length}, moment ${moment.length}, variant ${variant.length}, sponsor ${sponsor.length}, carousel ${carousel.length})`,
    );
  });

  it("…and without the entry, no probe cell (the cell source reads its ARGUMENT, not the module's registry)", async () => {
    const { galleryCells } = await import("../gallery-matrix");
    const shipped = galleryCells(A.OVERLAY_TEMPLATES, VARIANTS);
    expect(shipped.length, "anti-vacuity").toBeGreaterThan(0);
    expect(shipped.filter((c) => c.templateId === "probe")).toHaveLength(0);
  });

  it("the gallery PAGE hands the client exactly galleryCells(registry, variants) — so every e2e sweep sees the probe", async () => {
    const { galleryCells } = await import("../gallery-matrix");
    const { OverlayGallery } = await import("@/app/admin/overlay-gallery/overlay-gallery");
    const { default: Page } = await import("@/app/admin/overlay-gallery/page");
    const tree = (await Page({ searchParams: Promise.resolve({}) })) as ReactElement;
    const gallery = findElement(tree, (el) => el.type === OverlayGallery);
    expect(gallery, "the page renders an <OverlayGallery>").toBeDefined();
    const cells = (gallery!.props as { cells: { templateId: string; sportKey: string }[] }).cells;
    const probe = cells.filter((c) => c.templateId === "probe");
    expect(probe.length, "the probe's cells reach the page").toBeGreaterThan(0);
    for (const c of probe) expect(c.sportKey).toBe("badminton");
    expect(cells).toEqual(galleryCells(REG, []));
  });

  it("a new box moves the cards: the probe's region is clear of its box, and differs from the bug's", () => {
    const region = A.cardRegionFor(PROBE.sceneCardSafeArea);
    expect(region).not.toBeNull();
    const r = region!;
    const b = PROBE.sceneCardSafeArea;
    const apart = r.x >= b.x + b.width || r.x + r.width <= b.x || r.y >= b.y + b.height || r.y + r.height <= b.y;
    expect(apart, `${JSON.stringify(r)} intersects ${JSON.stringify(b)}`).toBe(true);
    expect(r).not.toEqual(A.cardRegionFor(A.OVERLAY_TEMPLATES.bug.sceneCardSafeArea));
  });

  it("a retired id resolves to its replacement (a stored choice), and the picker hides it", () => {
    expect(A.resolveTemplateFrom(RETIRED, "gone", "badminton", "bug").id).toBe("probe");
    expect(A.templatesForSportFrom(RETIRED, "badminton").map((t) => t.id)).not.toContain("gone");
  });
});

/** Depth-first search of a React element tree for the first element `match` accepts. */
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
