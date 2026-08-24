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
// an on-player picker (the skin's declared candidates, else the bench, via
// swapCandidates) — a policy refusal renders as inline sport-worded copy,
// never a dead or silently-disabled control.
//
// swapCandidates(view, policyVerdict, offId, candidates?): `policyVerdict` is
// the module's own already-resolved verdict for whether a substitution is
// currently legal for this side at all — the shape a real caller builds from
// reduceLineupEvent's refusal branch. This pure function takes it as an
// opaque value rather than calling the reducer itself, since that needs a
// concrete off/on pair this function does not have (it is building the
// CANDIDATE LIST a caller picks "on" from, not replaying a specific swap).
//
// FIX ROUND 1 (review finding 1, Important): a caller's refusal is
// `LineupReduceResult`'s `{ok:false, reason: LineupRejectionReason,
// message: string}` (core/lineup.ts:270-295) — `.reason` is a TERSE
// MACHINE SLUG ("sub-cap-reached", lineup.ts:544), `.message` is the
// sport-worded PROSE ("this side has used all 3 substitutions this
// variant allows", lineup.ts:545). This file originally named its own
// field `reason` and documented it as "the module's `{ok:false, reason}`
// refusal" — wrong on both counts, and an invitation for the next wiring
// task to thread the slug onto screen. `PolicyVerdict.message` below is
// renamed to match the ENGINE's own prose field exactly (so the correct
// mapping, `message: refusalMessage(result.message)`, is also the obvious
// one) and additionally BRANDED via `refusalMessage()`/`NotRejectionCode`
// so that passing a value whose static type is `LineupRejectionReason` —
// i.e. threading `result.reason` instead of `result.message` — is a real
// tsc error, not just a doc comment (see `context-swap.test.ts`'s
// `@ts-expect-error` proof, and its end-to-end test against the REAL
// `reduceLineupEvent`). A refused verdict collapses the candidate pool to
// empty and carries `.message` through UNCHANGED — the sheet renders that
// string verbatim, never re-translated (task-8 dispatch, explicit
// constraint: a policy refusal is engine-authored copy, not a translation
// key). An ok verdict with a genuinely empty bench also yields empty
// candidates, but with `message` left undefined — the renderer tells the
// two apart and falls back to the same reused `scorepad.attribution.
// noRoster` empty state attribution-picker.tsx already uses, rather than a
// fabricated second string.
//
// SCOPE NOTE: the OFF list (who can come off) is `resolvePool({pool:
// "onfield"}, view)` directly, no policy gate — spec §2.7 says "both
// filtered by lineupPolicy(cfg)", but a per-sport rule about WHO may be
// taken off (e.g. a keeper mid-passage-of-play) needs a concrete engine
// call this sport-agnostic primitive is not positioned to make; deferred
// to the skin wiring this sheet in R2+, the same deferral Ruling F already
// prices in for resolvePool's own side-selection. R3 did NOT close this:
// its narrowing is the ON list only, because no shipped sport has an
// OFF-side per-candidate rule. `offCandidates`/`offBlocked` stay purely
// additive for whichever wave first has one.
//
// R3 CHASSIS SUB-WAVE (owner ruling 2026-08-24, `_INDEX.md` "R3 — owner
// ruling: FIX SwapSheet in the chassis, then use it"). Cricket declined this
// primitive, so football was the first skin ever to reach it, and first use
// surfaced five defects. The owner ruled to fix the chassis rather than route
// around it, because R4-R7 all inherit whatever stands here. What changed, so
// this header is not read as pre-R3 truth:
//
//   1. `SkinDefV3.swap` returns `SwapSlot[]`, each with an `id`; a tile's
//      `{swap: id}` addresses one. One slot per skin made per-side Sub tiles
//      unreachable.
//   3. `SwapSlot.eventType` is declared statically so the band filter can see
//      a swap tile — `buildEvent(off, on)` cannot answer at tile-build time.
//   4. `SwapSlot.candidates`/`blocked` bring R2c's SCOPE/ELIGIBILITY narrowing
//      to the ON list, same field names and same renderer as the context strip.
//   5. `swapCandidates` excludes the picked OFF person — nobody replaces
//      themselves. Unreachable before 4, since the two pools were complements.
//   6. A refused verdict ALWAYS states a reason; it used to fall through to
//      "No roster available yet." when the module worded none.
//
// (Defect 2 is the tile-side half of 1 and lives in types.ts.) The paragraph
// below about `noRoster` describes the OK-with-empty-bench case ONLY — that
// path is unchanged and still correct; the REFUSED path no longer shares it.
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
import type { LineupRejectionReason } from "@seazn/engine/core";
import { renderCandidateRow, resolvePool, type PoolView, type TFn } from "./context-strip";
import type { Blocked } from "./types";

/**
 * `T` collapses to `never` when its STATIC type is (a subtype of)
 * `LineupRejectionReason` — core/lineup.ts's closed union of machine slugs
 * — and passes through unchanged otherwise. A distributive conditional: for
 * a `T` that IS the whole `LineupRejectionReason` union (e.g. a variable
 * explicitly typed `: LineupRejectionReason`), every member distributes to
 * `never`, so the union-of-nevers is `never`. For a general `string` (e.g.
 * `LineupReduceResult`'s `.message`), `string extends LineupRejectionReason`
 * is false (the wider type is never assignable to the narrower literal
 * union), so the type passes through as `string`. This is what makes
 * `refusalMessage` below reject a slug at its CALL SITE rather than only in
 * a comment — see `context-swap.test.ts`'s `@ts-expect-error` proof.
 */
type NotRejectionCode<T extends string> = T extends LineupRejectionReason ? never : T;

/** Branded so a bare string cannot be assigned to `PolicyVerdict.message`
 *  without going through this constructor, AND typed (via
 *  `NotRejectionCode`) so a value statically typed `LineupRejectionReason`
 *  — i.e. `reduceLineupEvent`'s machine `.reason` slug — is rejected by
 *  tsc at the call site. The only sanctioned way to produce one is from a
 *  real refusal's `.message` (sport-worded prose), never its `.reason`. */
export type RefusalMessage = string & { readonly __refusalMessage: unique symbol };
export function refusalMessage<T extends string>(message: NotRejectionCode<T>): RefusalMessage {
  // Cast via `unknown`: `message`'s type here is the CONDITIONAL
  // `NotRejectionCode<T>`, which tsc cannot prove overlaps with the
  // branded `RefusalMessage` object-intersection type directly (a real
  // TS2352 at this exact line without the detour) — the value itself is
  // still plainly a string at runtime, so the two-step cast is safe.
  return message as unknown as RefusalMessage;
}

export interface PolicyVerdict {
  readonly ok: boolean;
  /** Sport-worded refusal PROSE — `reduceLineupEvent`'s `.message`, never
   *  its `.reason` machine slug (core/lineup.ts:270-295). Verbatim from the
   *  module, never re-translated, never fabricated. Present only when `ok`
   *  is false. */
  readonly message?: RefusalMessage;
}

export interface SwapCandidatesResult {
  readonly candidates: readonly string[];
  /** Carried through from `policyVerdict.message`, verbatim, ONLY when the
   *  verdict itself refused (candidates is then always empty). Undefined
   *  for an ok verdict, even one whose bench happens to be empty — that
   *  case is not a policy refusal and must not borrow its copy. */
  readonly message?: RefusalMessage;
}

/**
 * The swap-specific ON-list filter: gated by the module's own policy verdict
 * first, then the skin's declared SCOPE, then resolvePool's bench pool. See
 * the file header.
 *
 * R3 chassis sub-wave (owner ruling 2026-08-24, defect 4): `candidates` is
 * `SwapSlot.candidates` (types.ts) — R2c's SCOPE narrowing, extended to the
 * swap path with the identical `candidates ?? resolvePool(...)` line the
 * context strip and guided sheet already use, so the three cannot fork.
 *
 * Deliberately `??`, never a truthiness check: an EMPTY array means "nobody is
 * eligible" and must render the empty state, NOT fall back to the whole bench.
 * That absent-vs-empty divergence is the trap `ContextSlot.message` already
 * hit once (R2b review item 3).
 *
 * ELIGIBILITY (`SwapSlot.blocked`) is deliberately NOT applied here: a blocked
 * candidate stays in the list and is rendered visible-and-disabled with its
 * reason, so it must reach the renderer. Filtering it out here would silently
 * convert R2b's "visible, blocked, and REASONED" ruling back into "removed".
 *
 * `offId` — R3 defect 5. The already-picked OFF person, or `null` while the
 * off step is still open. Excluded from the result, because a player may not
 * be substituted for THEMSELVES.
 *
 * REQUIRED, not optional, and that is the point: an omitted argument would
 * default a forgetful caller straight back to the buggy behaviour, silently.
 * Saying `null` is a caller stating that nothing is picked yet.
 *
 * Why the chassis owns this rule rather than a skin: a skin's `candidates` is
 * a VALUE rebuilt from `view`, while the OFF pick lives in `SwapSheet`'s own
 * local state and never re-enters `swap(view)` — so no skin can see the pick
 * it would need to narrow against.
 *
 * Also worth knowing before anyone deletes this as dead code: with the POOLS
 * alone it is unreachable. `{pool:"onfield"}` and `{pool:"bench"}` are exact
 * complements of the playing squad, so the OFF person structurally could not
 * appear in the ON list. It became reachable the moment `candidates`
 * superseded the pool (defect 4) — a skin-supplied list is under no such
 * constraint. The guard still runs on the pool path too, so the two sources
 * cannot diverge.
 */
export function swapCandidates(
  view: PoolView,
  policyVerdict: PolicyVerdict,
  offId: string | null,
  candidates?: readonly string[],
): SwapCandidatesResult {
  if (!policyVerdict.ok) return { candidates: [], message: policyVerdict.message };
  const scoped = candidates ?? resolvePool({ pool: "bench" }, view);
  return { candidates: offId === null ? scoped : scoped.filter((id) => id !== offId) };
}

export interface SwapSheetSpec {
  /** i18n key, caller-authored (e.g. a skin's own
   *  "scorepad.skin.football.swap.off") — same pre-resolved-key convention
   *  as every other v3 spec field carrying a "label"/"title". */
  readonly offLabel: string;
  readonly onLabel: string;
  /** R3 — SCOPE for the ON list, `SwapSlot.candidates` carried through
   *  verbatim by `adaptSwapSlot` (pad-host.tsx). Same name on both sides on
   *  purpose: a rename at the adapter is exactly where two narrowing idioms
   *  start to drift apart. */
  readonly candidates?: readonly string[];
  /** R3 — ELIGIBILITY for the ON list, `SwapSlot.blocked` carried through
   *  verbatim. Pre-localised person-id -> reason; an absent key means
   *  selectable. Rendered by `renderCandidateRow`, the same function the
   *  context strip's own picker uses. */
  readonly blocked?: Blocked;
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
  /** Fires when Cancel is tapped, from EITHER step. `onSwap` is never
   *  called in this case — cancelling discards whatever off-player was
   *  already picked, the same "onComplete never fires on cancel" contract
   *  `GuidedSheetProps.onCancel` documents for its sibling sheet
   *  (guided-sheet.tsx). Optional for the same reason that one is: a
   *  caller not yet wired to remove this sheet from the tree can omit it
   *  with no crash — `SwapSheet` still resets its own pending `offId`
   *  back to the off step either way (defect fix, walkthrough
   *  2026-08-17: this sheet originally shipped with no dismiss control on
   *  either step at all, the one chassis primitive that didn't get one). */
  onCancel?: () => void;
}

/** Quietest control on the sheet — the one action that discards whatever
 *  has been picked so far, so it must never compete visually with forward
 *  progress. Byte-identical to guided-sheet.tsx's own `cancelButtonClass`
 *  (that file's header explains the "TileGrid minor treatment" reasoning
 *  in full); duplicated here rather than imported, matching how
 *  pad-host.tsx's own "more actions" cancel control already inlines the
 *  same class string instead of sharing one constant across files. */
const cancelButtonClass =
  "min-w-0 shrink-0 break-words rounded-full border border-dashed border-slate-300 bg-transparent px-4 text-sm font-medium text-slate-500 transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400";

/**
 * Off-player picker -> on-player picker. `offId === null` renders the off
 * step; picking one moves to the on step, whose header shows the chosen
 * player as a violet "engaged" chip — itself tappable to reopen the off
 * step, so a wrong pick is never a dead end. The on step's candidates come
 * from `swapCandidates`; an empty result renders `message` verbatim when
 * the verdict refused, else the reused `noRoster` empty state — never a
 * disabled button either way.
 */
export function SwapSheet({ spec, view, policyVerdict, personNames, t, onSwap, onCancel }: SwapSheetProps) {
  const [offId, setOffId] = useState<string | null>(null);
  const emptyText = t("scorepad.attribution.noRoster");
  // Defect fix (walkthrough 2026-08-17): reset local state back to the
  // start FIRST, then notify the caller — mirrors GuidedSheet's own
  // handleCancel (guided-sheet.tsx) exactly, so a half-made off pick can
  // never survive a cancel even if a future caller keeps this component
  // mounted across re-opens (today's one call site, pad-host.tsx, happens
  // to unmount it too, via `swapOpen &&`, but this component makes no
  // assumption about that — same defensive posture GuidedSheet takes for
  // its own internal state).
  const handleCancel = () => {
    setOffId(null);
    onCancel?.();
  };

  if (offId === null) {
    return (
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <p className="mk-eyebrow px-4 pt-3 text-slate-600">{t(spec.offLabel)}</p>
        <div className="px-4 py-3">
          {renderCandidateRow(resolvePool({ pool: "onfield" }, view), personNames, t, setOffId, emptyText)}
        </div>
        <div className="flex justify-end px-4 pb-3">
          <button type="button" onClick={handleCancel} style={{ minHeight: 44 }} className={cancelButtonClass}>
            {t("pad.sheet.cancel")}
          </button>
        </div>
      </div>
    );
  }

  const { candidates, message } = swapCandidates(view, policyVerdict, offId, spec.candidates);
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
        {/* R3 chassis sub-wave, sixth fix (owner ruling 2026-08-24): this
            branch keys on the VERDICT, not on whether a message happens to
            exist. It used to read `candidates.length === 0 && message !==
            undefined`, so a refusal the module worded silently fell through to
            `renderCandidateRow`'s empty state — "No roster available yet." for
            what is actually the sport's own law refusing the substitution. The
            scorer was told the wrong thing, which is worse than being told
            nothing.

            The fallback is the RENDERER's, never `swapCandidates`'s: that
            function still refuses to fabricate a message (its own tests pin
            `message: undefined`), so the chassis never invents sport-worded
            prose it has no standing to write. Exactly the split
            `rejectionText`/`scorepad.rejection.fallback` (pad-host.tsx) already
            uses for a server refusal — one chassis-generic sentence behind the
            module's own, never instead of it. */}
        {!policyVerdict.ok ? (
          <p data-role="swap-refusal" className="text-xs text-slate-600">
            {message ?? t("pad.swap.refused")}
          </p>
        ) : (
          // R3 (defect 4): `spec.blocked` reaches the SAME renderer the context
          // strip's picker uses, so a blocked ON candidate is a real disabled
          // button showing its reason beside the name — never removed, and
          // never a control that merely looks dimmed.
          renderCandidateRow(candidates, personNames, t, (id) => onSwap(offId, id), emptyText, spec.blocked)
        )}
      </div>
      <div className="flex justify-end px-4 pb-3">
        <button type="button" onClick={handleCancel} style={{ minHeight: 44 }} className={cancelButtonClass}>
          {t("pad.sheet.cancel")}
        </button>
      </div>
    </div>
  );
}
