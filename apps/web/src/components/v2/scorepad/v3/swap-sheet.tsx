"use client";
// Swap sheet — R1 chassis (Task 8). Spec §2.7 (owner ask 2026-08-15): the
// engine already models in-play personnel changes per sport law (S3/#426:
// five core.lineup.* sibling events + per-variant lineupPolicy(cfg) —
// football caps/no-re-entry vs rolling dispensations, FIVB once-and-same-
// position + libero, cricket concussion replacement and retired-hurt
// resume, both hockey codes unlimited rolling) and returns a refusal as a
// VALUE, never a throw (reduceLineupEvent, core/lineup.ts). v2 never
// surfaced this from the pad; this file is the first chassis primitive
// that does: an off-player picker (current on-field, via resolvePool) then
// an on-player picker (bench, via swapCandidates) — a policy refusal
// renders as inline sport-worded copy, never a dead or silently-disabled
// control.
//
// swapCandidates(view, policyVerdict): `policyVerdict` is the module's own
// already-resolved verdict for whether a substitution is currently legal
// for this side at all — the shape a real caller builds from
// reduceLineupEvent's `{ok:false, reason}` refusal. This pure function
// takes it as an opaque value rather than calling the reducer itself,
// since that needs a concrete off/on pair this function does not have (it
// is building the CANDIDATE LIST a caller picks "on" from, not replaying a
// specific swap). A refused verdict collapses the candidate pool to empty
// and carries `.reason` through UNCHANGED — the sheet renders that string
// verbatim, never re-translated (task-8 dispatch, explicit constraint: a
// policy refusal is engine-authored copy, not a translation key). An ok
// verdict with a genuinely empty bench also yields empty candidates, but
// with `reason` left undefined — the renderer tells the two apart and
// falls back to the same reused `scorepad.attribution.noRoster` empty
// state attribution-picker.tsx already uses, rather than a fabricated
// second string.
//
// SCOPE NOTE: the OFF list (who can come off) is `resolvePool({pool:
// "onfield"}, view)` directly, no policy gate — spec §2.7 says "both
// filtered by lineupPolicy(cfg)", but a per-sport rule about WHO may be
// taken off (e.g. a keeper mid-passage-of-play) needs a concrete engine
// call this sport-agnostic primitive is not positioned to make; deferred
// to the skin wiring this sheet in R2+, the same deferral Ruling F already
// prices in for resolvePool's own side-selection.
//
// RENDERER DESIGN: see context-strip.tsx's own header for the shared token
// reasoning (violet-600 = "engaged right now", slate neutral = resting,
// the reused candidate-chip shape via renderCandidateRow). This card
// deliberately does NOT borrow detail-dock.tsx's cream surface + lime
// depletion bar — that signature specifically means "ephemeral, closing in
// Ns", and a substitution has no timer; the wrong signal here would be
// urgency where none exists. A plain white/slate-200 card (TileGrid's own
// "standard" surface) reads as a considered decision instead. Step titles
// use the app's existing `.mk-eyebrow` utility (globals.css) — the same
// section-label device the rest of the "floodlit console" language already
// uses — rather than inventing new label chrome for two lines of copy.
import { useState } from "react";
import { renderCandidateRow, resolvePool, type PoolView, type TFn } from "./context-strip";

export interface PolicyVerdict {
  readonly ok: boolean;
  /** Sport-worded refusal copy, verbatim from the module — never
   *  re-translated, never fabricated. Present only when `ok` is false. */
  readonly reason?: string;
}

export interface SwapCandidatesResult {
  readonly candidates: readonly string[];
  /** Carried through from `policyVerdict.reason`, verbatim, ONLY when the
   *  verdict itself refused (candidates is then always empty). Undefined
   *  for an ok verdict, even one whose bench happens to be empty — that
   *  case is not a policy refusal and must not borrow its copy. */
  readonly reason?: string;
}

/** The swap-specific pool filter: gated by the module's own policy verdict
 *  first, resolvePool's bench pool second. See the file header. */
export function swapCandidates(view: PoolView, policyVerdict: PolicyVerdict): SwapCandidatesResult {
  if (!policyVerdict.ok) return { candidates: [], reason: policyVerdict.reason };
  return { candidates: resolvePool({ pool: "bench" }, view) };
}

export interface SwapSheetSpec {
  /** i18n key, caller-authored (e.g. a skin's own
   *  "scorepad.skin.football.swap.off") — same pre-resolved-key convention
   *  as every other v3 spec field carrying a "label"/"title". */
  readonly offLabel: string;
  readonly onLabel: string;
}

export interface SwapSheetProps {
  spec: SwapSheetSpec;
  view: PoolView;
  policyVerdict: PolicyVerdict;
  personNames: Readonly<Record<string, string>>;
  t: TFn;
  /** Fires once both picks are made. Nothing here decides which engine
   *  event this becomes (`football.sub` vs `core.lineup.substitution`,
   *  spec §2.7) — same thin-renderer posture as every other v3 primitive. */
  onSwap: (off: string, on: string) => void;
}

/**
 * Off-player picker -> on-player picker. `offId === null` renders the off
 * step; picking one moves to the on step, whose header shows the chosen
 * player as a violet "engaged" chip — itself tappable to reopen the off
 * step, so a wrong pick is never a dead end. The on step's candidates come
 * from `swapCandidates`; an empty result renders `reason` verbatim when
 * the verdict refused, else the reused `noRoster` empty state — never a
 * disabled button either way.
 */
export function SwapSheet({ spec, view, policyVerdict, personNames, t, onSwap }: SwapSheetProps) {
  const [offId, setOffId] = useState<string | null>(null);
  const emptyText = t("scorepad.attribution.noRoster");

  if (offId === null) {
    return (
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <p className="mk-eyebrow px-4 pt-3 text-slate-600">{t(spec.offLabel)}</p>
        <div className="px-4 py-3">
          {renderCandidateRow(resolvePool({ pool: "onfield" }, view), personNames, t, setOffId, emptyText)}
        </div>
      </div>
    );
  }

  const { candidates, reason } = swapCandidates(view, policyVerdict);
  const offName = personNames[offId] ?? t("eventCopy.unknownPerson");

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
        <p className="mk-eyebrow text-slate-600">{t(spec.onLabel)}</p>
        <button
          type="button"
          onClick={() => setOffId(null)}
          aria-label={`${t(spec.offLabel)}: ${offName}`}
          style={{ minHeight: 44 }}
          className="min-w-0 shrink-0 break-words rounded-full border border-transparent bg-violet-600 px-4 text-sm font-medium text-white transition-colors hover:bg-violet-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400"
        >
          {offName}
        </button>
      </div>
      <div className="px-4 py-3">
        {candidates.length === 0 && reason !== undefined ? (
          <p className="text-xs text-slate-600">{reason}</p>
        ) : (
          renderCandidateRow(candidates, personNames, t, (id) => onSwap(offId, id), emptyText)
        )}
      </div>
    </div>
  );
}
