"use client";

// R2006 (overlay templates spec 2026-10-15 §4.4 D5–D7; owner ruling 2026-10-19, "Option C"): the per-fixture score
// style picker. ONE component, mounted in exactly one place at a time — the Phone tab's score card (Ready, the score on)
// or the OBS overlay tab, never both (the tabs are exclusive) and never a phone/desktop twin (AGENTS.md phone composition:
// exactly two controls are duplicated, and this is not one of them).
//
//  - The options are `templatesForSport(sport)` in registry order (retired ones hidden by R2007), handed in by the panel.
//    No template id is a literal here.
//  - Each thumbnail is `<OverlayPreview>` — the one render function (D6) — fed THIS fixture's real data: the panel's
//    `live ?? seed` snapshot, its sides and start label, and the page's overlay dictionary. Never a picture.
//  - The scene toggle (one segment per `OVERLAY_SCENES` entry) moves the thumbnails only and is never persisted.
//  - A grid, not a rail (owner-approved mock): 1-up below 375, 2-up from 375. Nothing here scrolls sideways, so the
//    clipping scan has nothing to exempt (AGENTS.md class 23).
//  - Tap targets: every option is a full card; every segment is 44 px tall on a phone and 36 px from 768 (owner ruling
//    2026-10-19, "switch heights").
//  - Keyboard (PR #989 review m6): both radiogroups are ONE tab stop each — the checked radio is tabbable, the rest are
//    not (roving tabindex) — and the arrow keys move and select within the group, wrapping, as the WAI-ARIA radio group
//    pattern expects; Home/End jump to the ends.
import { useCallback, useState, type KeyboardEvent } from "react";
import { Check } from "lucide-react";
import { useMsg } from "@/components/i18n/dict-provider";
import { OverlayPreview } from "@/components/overlay/overlay-preview";
import { OVERLAY_SCENES, type SceneId } from "@/components/overlay/overlay-scenes";
import type { OverlayTemplateDef, TemplateId } from "@/components/overlay/template-registry";
import type { OverlayLiveData } from "@/components/public-site/live-score-data";
import type { MessageKey } from "@/lib/messages";
import type { OverlaySideInput } from "@/lib/overlay-model";
import type { DecidedOutcomeTemplates } from "@/lib/scoring-vocab";

/** What every thumbnail renders: this fixture's own data, as the panel resolved it. */
export interface TemplatePreviewData {
  sportKey: string;
  snapshot: OverlayLiveData;
  sides: [OverlaySideInput, OverlaySideInput];
  startLabel: string | null;
  dict: Record<string, string>;
  decidedTemplates: DecidedOutcomeTemplates;
}

/** A thumbnail's frame width before its cell has been measured (a server render, or the first paint). The cell clips
 *  it (`overflow-hidden`), and the first observation replaces it with the cell's own width. */
export const THUMB_FALLBACK_W_PX = 240;

/**
 * WAI-ARIA radio group keys: the arrows move AND select, wrapping at both ends; Home/End jump to the ends; any other key
 * is the browser's (so Tab still leaves the group). `index` is the checked radio's (-1: none checked, as the first is
 * then the tab stop). Null: not a key the group handles. Pure, so it is testable without a DOM.
 */
export function radioIndexForKey(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  const at = index < 0 ? 0 : index;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return index < 0 ? 0 : (at + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return index < 0 ? count - 1 : (at - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** The group's key handler: picks the radio the key lands on and moves DOM focus to it — focus must follow the
 *  selection, or the ring stays on a radio that is no longer checked while another carries `tabIndex` 0. */
function radioGroupKeys(index: number, count: number, pick: (next: number) => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    const next = radioIndexForKey(e.key, index, count);
    if (next === null) return;
    e.preventDefault();
    pick(next); // the template pick skips the option already checked (`pickTemplate`); a scene re-set is a no-op
    e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };
}

/** The cell's measured content width — a callback ref, so the observer follows the node that exists. */
function useCellWidth(): [(el: HTMLElement | null) => (() => void) | undefined, number | null] {
  const [w, setW] = useState<number | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box && box.width > 0) setW(Math.floor(box.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function TemplateOption(p: {
  def: OverlayTemplateDef;
  selected: boolean;
  /** The group's one tab stop (roving tabindex): the checked option, or the first when none is. */
  tabStop: boolean;
  onPick: () => void;
  scene: SceneId;
  preview: TemplatePreviewData;
}) {
  const msg = useMsg();
  const [ref, w] = useCellWidth();
  return (
    <button
      type="button"
      role="radio"
      aria-checked={p.selected}
      data-testid={`stream-template-${p.def.id}`}
      data-template={p.def.id}
      tabIndex={p.tabStop ? 0 : -1}
      onClick={p.onPick}
      className={`flex min-h-11 w-full min-w-0 flex-col gap-1.5 rounded-lg bg-white p-1.5 text-left transition motion-reduce:transition-none ${
        p.selected ? "ring-2 ring-purple-600" : "ring-1 ring-purple-100 hover:ring-purple-300"
      }`}
    >
      <span
        ref={ref}
        aria-hidden
        className="block w-full overflow-hidden rounded-md"
        style={{ aspectRatio: "1920 / 1080", background: "linear-gradient(180deg, #3d7a3a, #2e6a2d)" }}
      >
        <OverlayPreview
          template={p.def.id}
          sportKey={p.preview.sportKey}
          scene={p.scene}
          snapshot={p.preview.snapshot}
          sides={p.preview.sides}
          startLabel={p.preview.startLabel}
          dict={p.preview.dict}
          decidedTemplates={p.preview.decidedTemplates}
          frameWidth={w ?? THUMB_FALLBACK_W_PX}
        />
      </span>
      <span className="flex min-h-8 min-w-0 items-center gap-2 px-1.5">
        <span
          aria-hidden
          className={`grid h-4 w-4 shrink-0 place-items-center rounded-full ${p.selected ? "bg-purple-600 text-white" : "ring-1 ring-slate-300"}`}
        >
          {p.selected && <Check className="h-3 w-3" strokeWidth={3} />}
        </span>
        <span className="min-w-0 truncate text-sm font-medium text-slate-800">{msg(p.def.labelKey as MessageKey)}</span>
      </span>
    </button>
  );
}

export function StreamTemplatePicker(p: {
  /** `templatesForSport(sport)`, in registry order — the panel's, never a list typed here. */
  templates: readonly OverlayTemplateDef[];
  selected: TemplateId;
  onPick: (id: TemplateId) => void;
  preview: TemplatePreviewData;
  /** Scopes the DOM ids (two panels on one page never share one). */
  idPrefix: string;
  /** The last pick did not save — the picker shows the stored style again, and says so. */
  saveFailed: boolean;
  /** A line under the title (PR #989 review m1): the OBS tab's grid while a composed session is open says a pick applies
   *  to the NEXT stream — a running session never moves (stream-sessions.ts copies the style at create). */
  note?: string | null;
}) {
  const msg = useMsg();
  const [scene, setScene] = useState<SceneId>(OVERLAY_SCENES[0].id);
  const sceneAt = OVERLAY_SCENES.findIndex((s) => s.id === scene);
  const templateAt = p.templates.findIndex((def) => def.id === p.selected);
  const pickTemplate = (id: TemplateId) => {
    if (p.selected !== id) p.onPick(id);
  };
  const titleId = `${p.idPrefix}-template-title`;
  const sceneId = `${p.idPrefix}-template-scenes`;
  return (
    <div data-testid="stream-template-picker" className="min-w-0">
      <p id={titleId} className="text-sm font-medium text-slate-800">
        {msg("stream.template.title")}
      </p>
      {p.note && (
        <p data-testid="stream-template-note" className="mt-0.5 text-xs text-slate-600">
          {p.note}
        </p>
      )}
      <div className="mt-2 flex min-w-0 flex-col gap-1 md:flex-row md:items-center md:gap-3">
        <span id={sceneId} className="text-xs text-slate-600">
          {msg("stream.template.scenes")}
        </span>
        <div
          role="radiogroup"
          aria-labelledby={sceneId}
          data-testid="stream-scene-group"
          onKeyDown={radioGroupKeys(sceneAt, OVERLAY_SCENES.length, (i) => setScene(OVERLAY_SCENES[i]!.id))}
          className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 md:flex md:w-fit"
        >
          {OVERLAY_SCENES.map((s, i) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={scene === s.id}
              tabIndex={i === (sceneAt < 0 ? 0 : sceneAt) ? 0 : -1}
              data-testid={`stream-scene-${s.id}`}
              onClick={() => setScene(s.id)}
              className={`min-h-11 min-w-11 rounded-md px-3 text-xs font-medium leading-tight md:min-h-9 ${
                scene === s.id ? "bg-white text-purple-700 shadow-sm" : "text-slate-600 hover:text-slate-900"
              }`}
            >
              {msg(s.labelKey as MessageKey)}
            </button>
          ))}
        </div>
      </div>
      <div
        role="radiogroup"
        aria-labelledby={titleId}
        data-testid="stream-template-group"
        onKeyDown={radioGroupKeys(templateAt, p.templates.length, (i) => pickTemplate(p.templates[i]!.id))}
        className="mt-3 grid grid-cols-1 gap-3 min-[375px]:grid-cols-2 md:grid-cols-[repeat(2,minmax(0,280px))]"
      >
        {p.templates.map((def, i) => (
          <TemplateOption
            key={def.id}
            def={def}
            selected={p.selected === def.id}
            tabStop={i === (templateAt < 0 ? 0 : templateAt)}
            onPick={() => pickTemplate(def.id)}
            scene={scene}
            preview={p.preview}
          />
        ))}
      </div>
      {p.saveFailed && (
        <p data-testid="stream-template-error" role="alert" className="mt-2 text-sm text-red-700">
          {msg("stream.template.saveFailed")}
        </p>
      )}
    </div>
  );
}
