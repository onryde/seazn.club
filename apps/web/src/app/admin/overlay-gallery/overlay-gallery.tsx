"use client";
// The staff overlay gallery's grid (R2007; spec 2026-10-15 §4.8). One `OverlayPreview` per cell — the same render the
// organiser's picker uses — over a checkerboard, so the overlay's transparency reads as transparency. Every cell
// carries its coordinates and its template's declared geometry as data attributes: the gallery e2e reads them to check
// the text floor, the bar lift, the safe area and the slab placement against the rendered page.
import Link from "@/components/ui/console-link";
import { t } from "@/lib/i18n-runtime";
import { momentsFor, type OverlayMoment } from "@/lib/overlay-moments";
import { shortCode, type OverlayMsg, type OverlaySideInput } from "@/lib/overlay-model";
import type { DecidedOutcomeTemplates } from "@/lib/scoring-vocab";
import type { OverlayLiveData } from "@/components/public-site/live-score-data";
import { OverlayPreview } from "@/components/overlay/overlay-preview";
import { OVERLAY_SCENES } from "@/components/overlay/overlay-scenes";
import { OVERLAY_SPORT_KEYS } from "@/components/overlay/overlay-tokens";
import { OVERLAY_TEMPLATES, type TemplateId } from "@/components/overlay/template-registry";
import {
  GALLERY_MOMENT_SAMPLES,
  type GalleryCell,
  type GallerySnapshotKind,
} from "@/components/overlay/gallery-matrix";

export type GalleryFrame = "full" | "844" | "390";

export interface OverlayGalleryProps {
  cells: GalleryCell[];
  snapshots: Record<string, Record<GallerySnapshotKind, OverlayLiveData>>;
  /** Keyed `${status}:${sportKey}`. */
  variantSnapshots: Record<string, OverlayLiveData>;
  sides: [OverlaySideInput, OverlaySideInput];
  slateMeta: { competition: string; stage: string };
  startLabel: string | null;
  publicDict: Record<string, string>;
  uiDict: Record<string, string>;
  decidedTemplates: DecidedOutcomeTemplates;
  sport: string | null;
  frame: GalleryFrame;
  frameWidth: number;
}

const FRAME_LABEL: Readonly<Record<GalleryFrame, string>> = {
  full: "admin.overlayGallery.frameFull",
  "844": "admin.overlayGallery.framePhoneLandscape",
  "390": "admin.overlayGallery.framePhonePortrait",
};

/** The data a cell renders. A cell whose key finds no snapshot, or a moment sample that raises no slab, is refused by
 *  name: a cell is never drawn from the wrong data, and a blank cell would read as a template defect. */
function cellData(
  cell: GalleryCell,
  props: OverlayGalleryProps,
  msg: OverlayMsg,
): { snapshot: OverlayLiveData; moment: OverlayMoment | undefined } {
  const snapshot =
    cell.resultStatus !== null
      ? props.variantSnapshots[`${cell.resultStatus}:${cell.sportKey}`]
      : props.snapshots[cell.sportKey]?.[cell.snapshot];
  if (snapshot === undefined) throw new Error(`overlay gallery: no snapshot for cell ${cell.key}`);
  if (cell.momentSampleId === null) return { snapshot, moment: undefined };
  const sample = GALLERY_MOMENT_SAMPLES.find((s) => s.id === cell.momentSampleId);
  if (sample === undefined) throw new Error(`overlay gallery: no moment sample ${cell.momentSampleId}`);
  // The REAL derivation, over the stage's own side codes: the slab a broadcast would raise for this event.
  const codes: [string, string] = [shortCode(props.sides[0]), shortCode(props.sides[1])];
  const moment = momentsFor(sample.sportKey, [sample.event], sample.event.seq - 1, msg, codes)[0];
  if (moment === undefined) throw new Error(`overlay gallery: sample ${sample.id} raises no moment`);
  return { snapshot, moment };
}

function cellState(cell: GalleryCell, ui: Record<string, string>, moment: OverlayMoment | undefined): string {
  if (cell.resultStatus !== null) return t(ui, `score.status.${cell.resultStatus}`);
  if (moment !== undefined) return `${t(ui, "admin.overlayGallery.moments")}: ${moment.headline}`;
  return t(ui, `admin.overlayGallery.snapshot.${cell.snapshot}`);
}

export function OverlayGallery(props: OverlayGalleryProps) {
  const ui = props.uiDict;
  const msg: OverlayMsg = (key, vars) => t(props.publicDict, key, vars);
  const href = (over: { sport?: string | null; frame?: GalleryFrame }) => {
    const sport = over.sport === undefined ? props.sport : over.sport;
    const frame = over.frame ?? props.frame;
    const q = new URLSearchParams();
    if (sport !== null) q.set("sport", sport);
    if (frame !== "full") q.set("frame", frame);
    const s = q.toString();
    return s.length > 0 ? `/admin/overlay-gallery?${s}` : "/admin/overlay-gallery";
  };
  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1 ${
      active
        ? "border-purple-400 bg-purple-900/60 text-white"
        : "border-slate-700 text-slate-300 hover:border-slate-500 hover:text-white"
    }`;
  // One section per sport, cells in the matrix's own order within it.
  const sports = OVERLAY_SPORT_KEYS.filter((s) => props.cells.some((c) => c.sportKey === s));

  return (
    <div data-testid="overlay-gallery" data-cell-count={props.cells.length} className="space-y-8">
      <div className="space-y-4">
        <h1 className="text-xl font-bold text-white">{t(ui, "admin.overlayGallery.title")}</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="w-16 text-slate-400">{t(ui, "admin.overlayGallery.sport")}</span>
          <Link href={href({ sport: null })} className={chip(props.sport === null)} aria-current={props.sport === null ? "page" : undefined}>
            {t(ui, "admin.overlayGallery.allSports")}
          </Link>
          {OVERLAY_SPORT_KEYS.map((s) => (
            <Link key={s} href={href({ sport: s })} className={chip(props.sport === s)} aria-current={props.sport === s ? "page" : undefined}>
              {t(ui, `sport.${s}`)}
            </Link>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="w-16 text-slate-400">{t(ui, "admin.overlayGallery.frame")}</span>
          {(Object.keys(FRAME_LABEL) as GalleryFrame[]).map((f) => (
            <Link key={f} href={href({ frame: f })} className={chip(props.frame === f)} aria-current={props.frame === f ? "page" : undefined}>
              {t(ui, FRAME_LABEL[f])}
            </Link>
          ))}
        </div>
      </div>

      {sports.map((sport) => (
        <section key={sport} className="space-y-3" aria-labelledby={`gallery-${sport}`}>
          <h2 id={`gallery-${sport}`} className="border-b border-slate-800 pb-1 text-base font-semibold text-white">
            {t(ui, `sport.${sport}`)}
          </h2>
          <div
            className="grid gap-x-6 gap-y-5"
            style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${props.frameWidth}px, max-content))` }}
          >
            {props.cells
              .filter((cell) => cell.sportKey === sport)
              .map((cell) => {
                const def = OVERLAY_TEMPLATES[cell.templateId as TemplateId];
                if (def === undefined) throw new Error(`overlay gallery: no template ${cell.templateId}`);
                const { snapshot, moment } = cellData(cell, props, msg);
                const scene = OVERLAY_SCENES.find((s) => s.id === cell.scene);
                return (
                  <figure
                    key={cell.key}
                    data-gallery-cell={cell.key}
                    data-template={cell.templateId}
                    data-sport={cell.sportKey}
                    data-scene={cell.scene}
                    data-snapshot={cell.snapshot}
                    data-moment={cell.momentSampleId ?? ""}
                    data-result-status={cell.resultStatus ?? ""}
                    data-slab-placement={def.slabPlacement}
                    data-safe-area={JSON.stringify(def.sceneCardSafeArea)}
                    className="m-0 space-y-1.5"
                  >
                    <figcaption className="flex flex-wrap items-baseline gap-x-3 text-sm">
                      <span className="font-semibold text-white">{t(ui, def.labelKey)}</span>
                      <span className="text-slate-300">{cellState(cell, ui, moment)}</span>
                      {scene && <span className="text-xs text-slate-500">{t(ui, scene.labelKey)}</span>}
                    </figcaption>
                    <div
                      className="w-fit rounded-sm ring-1 ring-slate-700"
                      style={{
                        // Transparency must read as transparency: the overlay paints only its own boxes.
                        background: "repeating-conic-gradient(#334155 0% 25%, #1e293b 0% 50%) 0 0 / 24px 24px",
                      }}
                    >
                      <OverlayPreview
                        template={def.id}
                        sportKey={cell.sportKey}
                        scene={cell.scene}
                        snapshot={snapshot}
                        sides={props.sides}
                        slateMeta={props.slateMeta}
                        startLabel={props.startLabel}
                        dict={props.publicDict}
                        decidedTemplates={props.decidedTemplates}
                        frameWidth={props.frameWidth}
                        {...(moment ? { moment } : {})}
                      />
                    </div>
                  </figure>
                );
              })}
          </div>
        </section>
      ))}
    </div>
  );
}
