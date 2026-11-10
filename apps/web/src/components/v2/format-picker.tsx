"use client";

// FMT5 (owner-approved mock, 2026-11-03): the C9 builder's format picker, extracted so the Format dialog on the Fixtures
// tab's Division rules card opens the SAME picker rather than a copy: the same cards (shape diagram, match count, time), the
// five suggested and the Show more tile as the sixth cell, Americano and Mexicano last, the lime states, the plan locks and
// the knobs each format shows. The model is lib/division-builder/format-choice.ts; this file is its one rendering.
//
// A render FUNCTION, not a component: the screen calls it inline (`{formatPickerFields({...})}`), so its controls sit in
// the screen's own tree — the island harness the builder's suites drive (components/__tests__/_hook-harness.ts) expands
// one component and walks its output, and would not see into a nested one. It therefore takes no hooks: the screen hands
// it its `msg`, `msgPlural` and locale.
//
// The testids are the builder's (`division-builder-templates`, `-estimate-<key>`, `-show-all`, `-carry`): one component, one
// set of ids, pinned by the matrix's selectors (tools/matrix/lib/browser/selectors.ts). The builder and the dialog never
// share a page; a test of the dialog scopes them by the dialog's own testid.
import { useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { UpgradeGate } from "@/components/upgrade-gate";
import type { useMsg, useMsgPlural } from "@/components/i18n/dict-provider";
import { FormatShape } from "@/components/v2/division-builder/format-shape";
import { LegsChoice } from "@/components/v2/legs-choice";
import { doubleElimFormatReason } from "@/lib/feature-copy";
import { FORMAT_BOUNDS } from "@/lib/format-bounds";
import { STAGE_TEMPLATES, type StageDraft, type StandingsCarry } from "@/lib/format-templates";
import { thirdPlaceOffer, type FormatKnobsShown, type FormatPickerView } from "@/lib/division-builder/format-choice";
import type { ThirdPlaceMode } from "@/lib/third-place";
import { ThirdPlaceChoice } from "@/components/v2/third-place-choice";
import type { MessageKey } from "@/lib/messages";
import { swissRoundsGuidanceLine } from "@/lib/swiss-rounds";
import type { ViewerPlan } from "@/lib/viewer-plan";

/** Owner 2026-11-03 (C9 round 4): a sport tile's icon and a format card's diagram are grey at rest and lime when the
 *  tile is hovered, keyboard-focused or picked; the tile's border and fill do not change. lime-700 is the house's deeper
 *  lime (lime-700 text across the console): the gantry hairline's --mk-lime reads 1.51:1 on the white tile and 1.41:1 on
 *  the picked purple-50, under the 3:1 a graphic needs, while lime-700 reads 4.96:1 and 4.63:1. */
export const TILE_ICON_PICKED = "text-lime-700";
export const TILE_ICON_LIVE = "group-hover:text-lime-700 group-has-[:focus-visible]:text-lime-700";
export const TILE_ICON_MOTION = "transition-colors motion-reduce:transition-none";

/**
 * The `formats.double_elim` gate's per-kind wording (feature-copy.ts's `doubleElimFormatReason`), given the stage
 * drafts about to be submitted (bug-fix follow-up 2026-08-18, gate-copy): a `group_playoffs` template builds a
 * `page_playoff` stage, which must not read "Double-elimination brackets are a Pro format." Returns undefined for every
 * other feature key; `<UpgradeGate>` then falls back to its own `featureReason(feature)`.
 */
export function paywallReasonForStages(featureKey: string, stages: StageDraft[]): string | undefined {
  if (featureKey !== "formats.double_elim") return undefined;
  const gatedStage = stages.find((s) => s.kind === "double_elim" || s.kind === "page_playoff");
  return doubleElimFormatReason(gatedStage?.kind ?? "double_elim");
}

/** The picker's state, owned by the screen that renders it (the builder keeps it across its steps; the dialog for as long
 *  as it is open). `templatePicked` is null until a card is picked: the screen then shows its opening format. */
export interface FormatKnobsState {
  templatePicked: string | null;
  setTemplatePicked: Dispatch<SetStateAction<string | null>>;
  qualified: number;
  setQualified: Dispatch<SetStateAction<number>>;
  /** Null until the Rounds box is typed in: the box follows the field's default (swissRoundsDefault) until then. */
  swissRoundsPicked: number | null;
  setSwissRoundsPicked: Dispatch<SetStateAction<number | null>>;
  poolCount: number;
  setPoolCount: Dispatch<SetStateAction<number>>;
  legs: number;
  setLegs: Dispatch<SetStateAction<number>>;
  standingsCarry: StandingsCarry;
  setStandingsCarry: Dispatch<SetStateAction<StandingsCarry>>;
  /** B4 T10 (X-TP-2): Shared by default (`thirdPlaceModeOf`'s one default), the division's stored choice in the dialog. */
  thirdPlace: ThirdPlaceMode;
  setThirdPlace: Dispatch<SetStateAction<ThirdPlaceMode>>;
  showAll: boolean;
  setShowAll: Dispatch<SetStateAction<boolean>>;
}

export interface FormatKnobsInit {
  template?: string | null;
  qualified?: number;
  swissRounds?: number | null;
  poolCount?: number;
  legs?: number;
  standingsCarry?: StandingsCarry;
  thirdPlace?: ThirdPlaceMode;
}

/** The picker's state, opening at `init` (the builder: the templates' defaults; the dialog: the division's stages as
 *  stored, `formatChoiceFromStages`). Read once, at mount. */
export function useFormatKnobs(init: FormatKnobsInit = {}): FormatKnobsState {
  const [templatePicked, setTemplatePicked] = useState<string | null>(init.template ?? null);
  const [qualified, setQualified] = useState(init.qualified ?? 4);
  const [swissRoundsPicked, setSwissRoundsPicked] = useState<number | null>(init.swissRounds ?? null);
  const [poolCount, setPoolCount] = useState(init.poolCount ?? 2);
  const [legs, setLegs] = useState(init.legs ?? 1);
  const [standingsCarry, setStandingsCarry] = useState<StandingsCarry>(init.standingsCarry ?? "none");
  const [thirdPlace, setThirdPlace] = useState<ThirdPlaceMode>(init.thirdPlace ?? "shared");
  const [showAll, setShowAll] = useState(false);
  return {
    templatePicked,
    setTemplatePicked,
    qualified,
    setQualified,
    swissRoundsPicked,
    setSwissRoundsPicked,
    poolCount,
    setPoolCount,
    legs,
    setLegs,
    standingsCarry,
    setStandingsCarry,
    thirdPlace,
    setThirdPlace,
    showAll,
    setShowAll,
  };
}

export function formatPickerFields({
  msg,
  msgPlural,
  locale,
  template,
  knobs,
  swissRounds,
  shown,
  view,
  stages,
  guidanceEntrants,
  templateLocks,
  viewerPlan,
}: {
  msg: ReturnType<typeof useMsg>;
  msgPlural: ReturnType<typeof useMsgPlural>;
  locale: string;
  /** The format shown picked: the screen's pick, else its opening format. */
  template: string;
  knobs: FormatKnobsState;
  /** The Rounds box's value: the pick, else the field's default. */
  swissRounds: number;
  shown: FormatKnobsShown;
  view: FormatPickerView;
  /** The picked format's drafts (`formatStagesFor`): the plan gate's wording reads their kinds. */
  stages: StageDraft[];
  /** The field the Swiss rounds guidance is counted for: the builder's plan, the division's entrants. */
  guidanceEntrants: number;
  templateLocks: Readonly<Record<string, string>>;
  viewerPlan: ViewerPlan;
}): ReactNode {
  const hoursText = (minutes: number) =>
    new Intl.NumberFormat(locale, { style: "unit", unit: "hour", unitDisplay: "short", maximumFractionDigits: 1 }).format(Math.round((minutes / 60) * 10) / 10);
  const { ranked, pickerOrder, suggested, folded, foldedCount, estimate, estimateMins, templateLock, carryLocked } = view;
  const { showAll, setShowAll } = knobs;

  return (
    <>
      <fieldset className="min-w-0">
        <legend className="text-sm font-medium text-slate-800">{showAll ? msg("divBuilder.allFormats") : msg("divBuilder.suggested")}</legend>
        <div id="division-builder-templates" className="mt-2 grid gap-2 md:grid-cols-2" data-testid="division-builder-templates">
          {/* The division's OFFER, not every template: chess is individual-only (owner ruling 2026-10-26), so it is
              offered no americano/mexicano (format-templates.ts templatesForSport), nor is a division of pairs or
              teams (C9 review 2, N1: formatOfferFor). In the picker's order: the ranking, Americano and Mexicano
              after every other (C9 R2). */}
          {pickerOrder.map((key) => {
            const t = STAGE_TEMPLATES.find((x) => x.key === key)!;
            const row = ranked.find((r) => r.key === key)!;
            const picked = template === key;
            // The card's counts at the knobs as they stand for the picked card, the opening knobs for the rest.
            const est = picked ? estimate : row.estimate;
            const mins = picked ? estimateMins : row.minutes;
            const locked = templateLocks[key] !== undefined;
            // W4 T15 (X-PL-1, X-QM-5; owner pick 5A): a format this field cannot play stays on show, greyed and unpickable, saying
            // what unlocks it. A pick made before the plan shrank keeps its picked look, and Next says why it cannot go on.
            const sizeGate = view.sizeGate(t.key);
            const gated = sizeGate !== null;
            const surface = picked
              ? "border-purple-500 bg-purple-50 text-purple-900"
              : gated
                ? "border-dashed border-slate-300 bg-slate-50 text-slate-500"
                : "border-slate-200 bg-white text-slate-700 hover:border-purple-200";
            return (
              <label
                key={t.key}
                data-template={t.key}
                data-suggested={suggested.includes(t.key) ? "" : undefined}
                data-size-gated={sizeGate?.code}
                aria-disabled={gated ? "true" : undefined}
                className={`${folded(t.key) ? "hidden" : "flex"} group min-h-11 min-w-0 ${gated ? "cursor-not-allowed" : "cursor-pointer"} gap-3 rounded-lg border p-3 text-sm transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-purple-600 ${surface}`}
              >
                <input type="radio" name="template" checked={picked} disabled={gated} onChange={() => knobs.setTemplatePicked(t.key)} className="sr-only" />
                <FormatShape
                  stages={t.build({ qualified: 4, swissRounds: 3, poolCount: 2, legs: 1 })}
                  className={`shrink-0 ${TILE_ICON_MOTION} ${picked ? TILE_ICON_PICKED : gated ? "text-slate-300" : `text-slate-400 ${TILE_ICON_LIVE}`}`}
                />
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-x-2">
                    {/* t.key is a plain string, so the key cannot be checked against MessageKey's union without a
                        cast; format-templates.test.ts's dictionary-coverage test is the runtime backstop. */}
                    <span className="font-medium">{msg(`format.template.${t.key}.label` as MessageKey)}</span>
                    {locked && <span className="rounded bg-amber-100 px-1.5 text-[11px] font-semibold text-amber-800">{msg("divBuilder.card.pro")}</span>}
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-500">{msg(`format.template.${t.key}.help` as MessageKey)}</span>
                  {gated ? (
                    <span className="mt-1 block text-xs font-semibold text-amber-800" data-testid={`division-builder-size-reason-${t.key}`}>
                      {msg("divBuilder.card.needsEntrants", { min: sizeGate.min, count: view.planEntrants })}
                    </span>
                  ) : (
                    <span className="mt-1 block text-xs font-medium text-slate-700" data-testid={`division-builder-estimate-${t.key}`}>
                      {est.matches === null
                        ? msg("divBuilder.card.noDraw")
                        : [msgPlural("divBuilder.card.matches", est.matches, { count: est.matches }), mins === null ? null : msg("divBuilder.card.about", { time: hoursText(mins) })]
                            .filter((x) => x !== null)
                            .join(" · ")}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
          {/* C9 R2: Show more is the grid's next cell (the sixth, collapsed), a card-sized tile with a dashed edge -
              beside the fifth card it takes that row's height. */}
          {(showAll || foldedCount > 0) && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              aria-expanded={showAll}
              aria-controls="division-builder-templates"
              data-testid="division-builder-show-all"
              className="flex min-h-20 min-w-0 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white p-3 text-center text-sm font-medium text-purple-700 transition hover:border-purple-300 hover:bg-purple-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-600"
            >
              {/* m5 (C9 review 3): one wording across both pickers, the owner's "show more" - "Show 8 more formats". */}
              {showAll ? msg("divBuilder.showFewer") : msgPlural("divBuilder.format.showMore", foldedCount, { count: foldedCount })}
            </button>
          )}
        </div>
      </fieldset>

      {templateLock !== undefined && (
        <UpgradeGate feature={templateLock} reason={paywallReasonForStages(templateLock, stages)} compact viewerPlan={viewerPlan} />
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        {shown.legs && (
          <div className="sm:col-span-2">
            <LegsChoice legend={msg("wizard.legs")} legendClassName="label" value={knobs.legs} onChange={knobs.setLegs} />
          </div>
        )}
        {shown.pools && (
          <label className="block">
            <span className="label">{msg("wizard.pools")}</span>
            <input
              type="number"
              data-format-bound="pools"
              min={FORMAT_BOUNDS.pools.min}
              max={FORMAT_BOUNDS.pools.max}
              value={knobs.poolCount}
              onChange={(e) => knobs.setPoolCount(Number(e.target.value))}
              className="input min-h-11"
            />
          </label>
        )}
        {shown.rounds && (
          <div>
            <label className="block">
              <span className="label">{msg("wizard.rounds")}</span>
              <input
                type="number"
                data-format-bound="swissRounds"
                min={FORMAT_BOUNDS.swissRounds.min}
                max={FORMAT_BOUNDS.swissRounds.max}
                value={swissRounds}
                onChange={(e) => knobs.setSwissRoundsPicked(Number(e.target.value))}
                aria-describedby="builder-swiss-rounds-guidance"
                className="input min-h-11"
              />
            </label>
            {/* W3 T11 (X-SW-16): the builder has no roster yet, so the plan's entrant count is the one the line uses; the
                dialog counts the division's entrants. OUTSIDE the label, so it is the box's description, not its name. */}
            <p id="builder-swiss-rounds-guidance" data-testid="builder-swiss-rounds-guidance" className="mt-1 text-xs text-slate-500">
              {swissRoundsGuidanceLine(guidanceEntrants, msgPlural)}
            </p>
          </div>
        )}
        {shown.secondStage && (
          <label className="block">
            <span className="label">{msg("wizard.qualify")}</span>
            <input
              type="number"
              data-format-bound="qualify"
              min={FORMAT_BOUNDS.qualify.min}
              max={FORMAT_BOUNDS.qualify.max}
              value={knobs.qualified}
              onChange={(e) => knobs.setQualified(Number(e.target.value))}
              className="input min-h-11"
            />
          </label>
        )}
        {shown.thirdPlace && (
          <div className="sm:col-span-2">
            <ThirdPlaceChoice
              value={knobs.thirdPlace}
              onChange={knobs.setThirdPlace}
              offer={thirdPlaceOffer(template, knobs, guidanceEntrants)}
            />
          </div>
        )}
        {shown.carry && (
          <label className="block">
            <span className="label">{msg("format.carry.label")}</span>
            <select
              data-testid="division-builder-carry"
              value={knobs.standingsCarry}
              onChange={(e) => knobs.setStandingsCarry(e.target.value as StandingsCarry)}
              className="select min-h-11"
            >
              <option value="none">{msg("format.carry.none")}</option>
              <option value="points">{msg("format.carry.points")}</option>
              <option value="full">{msg("format.carry.full")}</option>
            </select>
            <span className="mt-0.5 block text-xs text-slate-500">{msg("format.carry.help")}</span>
          </label>
        )}
      </div>
      {carryLocked && <UpgradeGate feature="standings.carry_over" compact viewerPlan={viewerPlan} />}
    </>
  );
}
