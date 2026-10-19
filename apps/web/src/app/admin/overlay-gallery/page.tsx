import { requireStaff } from "@/lib/admin";
import { getDictionary } from "@/lib/i18n";
import { resolveLocale } from "@/lib/resolve-locale";
import { msgFor } from "@/lib/messages-i18n";
import type { MessageKey } from "@/lib/messages";
import { overlayStartLabel } from "@/lib/overlay-model";
import { decidedOutcomeTemplates } from "@/lib/scoring-vocab";
import type { OverlayLiveData } from "@/components/public-site/live-score-data";
import { OVERLAY_SPORT_KEYS } from "@/components/overlay/overlay-tokens";
import { OVERLAY_TEMPLATES } from "@/components/overlay/template-registry";
import { galleryCells } from "@/components/overlay/gallery-matrix";
import {
  GALLERY_SIDES,
  GALLERY_SLATE_META,
  galleryResultVariants,
  gallerySnapshots,
} from "@/server/overlay/gallery-snapshots";
import { OverlayGallery, type GalleryFrame } from "./overlay-gallery";
import { parseGalleryStress, stressSides, stressTemplates } from "./gallery-stress";

export const dynamic = "force-dynamic";

/** Spec 2026-10-15 §4.5: the three frames a broadcast is watched at, as rendered preview widths. */
const FRAMES: Readonly<Record<GalleryFrame, number>> = { full: 960, "844": 844, "390": 390 };

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** The request's sample data, anchored at the request's own instant (a live clock reads the event times). A plain
 *  function, not the component body: the wall clock is read once per request, outside render. */
function galleryData() {
  const now = Date.now();
  return {
    snapshots: gallerySnapshots(now),
    variants: galleryResultVariants(now),
    startIso: new Date(now + 90 * 60_000).toISOString(),
  };
}

/**
 * The staff overlay gallery (R2007; spec 2026-10-15 §4.8) — every template × sport × scene × state, plus every moment
 * sample and every Result-card variant, each drawn through the SAME preview render the organiser's picker uses
 * (`OverlayPreview`). Staff-only — the page asks itself, because a Next layout does not gate its segments — and
 * desktop-only (the `/admin` exemption, owner 2026-09-28).
 *
 * The cells are `galleryCells(OVERLAY_TEMPLATES, …)`, the gallery's ONE cell source: a template added to the registry
 * appears here, and in every e2e sweep over this page, with no edit to this file.
 */
export default async function AdminOverlayGalleryPage({
  searchParams,
}: {
  searchParams: Promise<{
    sport?: string | string[];
    frame?: string | string[];
    // The stress mode (`gallery-stress.ts`; owner ruling 1, 2026-10-19): gallery check 4c's real-producer sweep.
    decided?: string | string[];
    name?: string | string[];
    code?: string | string[];
  }>;
}) {
  await requireStaff();
  const query = await searchParams;
  const requestedSport = one(query.sport);
  const sport = requestedSport !== undefined && OVERLAY_SPORT_KEYS.includes(requestedSport) ? requestedSport : null;
  const requestedFrame = one(query.frame);
  const frame: GalleryFrame =
    requestedFrame !== undefined && Object.hasOwn(FRAMES, requestedFrame) ? (requestedFrame as GalleryFrame) : "full";

  const locale = await resolveLocale();
  const uiDict = (await getDictionary(locale, "ui")) as Record<string, string>;
  const publicDict = (await getDictionary(locale, "public")) as Record<string, string>;

  const stress = parseGalleryStress({ decided: one(query.decided), name: one(query.name), code: one(query.code) }, uiDict);
  const templates = decidedOutcomeTemplates((k, v) => msgFor(locale, k, v));

  const { snapshots, variants, startIso } = galleryData();
  const variantSnapshots: Record<string, OverlayLiveData> = Object.fromEntries(
    variants.map(({ variant, snapshot }) => [`${variant.status}:${variant.sportKey}`, snapshot]),
  );
  const cells = galleryCells(
    OVERLAY_TEMPLATES,
    variants.map((v) => v.variant),
  ).filter((cell) => sport === null || cell.sportKey === sport);

  return (
    <OverlayGallery
      cells={cells}
      snapshots={snapshots}
      variantSnapshots={variantSnapshots}
      sides={stressSides([{ ...GALLERY_SIDES[0] }, { ...GALLERY_SIDES[1] }], stress)}
      slateMeta={{ ...GALLERY_SLATE_META }}
      // A start 90 minutes out, in the reader's locale: what the warming card shows a club before kick-off.
      startLabel={overlayStartLabel(startIso, locale, "UTC")}
      publicDict={publicDict}
      uiDict={uiDict}
      decidedTemplates={stress.decided === null ? templates : stressTemplates(templates, msgFor(locale, stress.decided as MessageKey))}
      sport={sport}
      frame={frame}
      frameWidth={FRAMES[frame]}
    />
  );
}
