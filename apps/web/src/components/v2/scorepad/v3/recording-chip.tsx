"use client";

// The Recording Chip — R1 chassis (Task 9). Replaces the pad's raw
// `Result only · Card · Timeline · Detail 🔒` fidelity picker with a
// single chip that states the recording level in sport words. Named
// defect of the rejected pad this task exists to kill: "a bare padlock
// with no explanation" — a locked level must ALWAYS be worded, never a
// silent lock icon. That rule binds both branches below: the entitled
// branch states the level in plain words, and the locked branch never
// stops at a boolean — it always carries a full "{band} — available on
// {plan}" sentence (`pad.recording.locked`).
//
// FALSE PREMISE already found by the scout (pins.md §5, restated here so
// a future reader doesn't re-derive it wrong): there is no
// "fidelity-switcher.tsx hook" to reuse. `FidelitySwitcher`'s active band
// and entitlements arrive as plain PROPS (`value`/`entitlements`/
// `fidelityEntitlements`), and its own `isLocked(band)` reads
// `fidelityEntitlements[band]` + `entitlements[needed]` directly. This
// file does not import either raw shape: `buildRecording` takes the
// EQUIVALENT, already-resolved values as plain parameters —
// `entitledBands`, a caller-computed set of the bands the org currently
// holds (the same posture ribbon.ts's `buildRibbon` and detail-dock.tsx's
// `dockController` already take: a pure builder gets simple, resolved
// data, never a raw prop bag it would have to re-derive itself). A
// future integration wave computes `entitledBands` from
// `entitlements`/`fidelityEntitlements` the exact same way
// `fidelity-switcher.tsx`'s own `isLocked` does.
//
// R1 SHIPS GENERIC WORDING ONLY: the five `pad.recording.*` keys below
// are the only copy this task adds. Per-sport overrides
// (`pad.<sport>.recording.band.N`) land with each conversion wave,
// exactly like ribbon.ts's per-sport `pad.<sport>.ribbon.<suffix>` keys
// do — out of scope here.
//
// PLAN NAME (a judgment call the brief leaves open — flagged in
// task-9-report.md): `buildRecording`'s signature carries no
// entitlement-key-to-plan-name resolver, and none exists anywhere in
// this codebase today (no `packages/engine/src/sports/*.ts` module
// currently populates `fidelityEntitlements` with a real entry —
// grepped 2026-08-16 — so there is no real per-band plan to resolve
// yet). Reuses the existing, already-unlocalized `planLabel()`
// (`@/lib/plan-label` — "Plan names are product names — they are the
// same in every locale," that file's own header), fixed to the "pro"
// plan for R1. A later wave that wires a specific band to a specific
// plan key must extend this signature, not patch around it.
//
// FIDELITY BAND SCALE IS CLOSED 0–3, NEVER A TIER 4 (standing programme
// ruling; packages/engine/src/sport/module.ts:124's `FidelityBand = 0 |
// 1 | 2 | 3` enforces this at the type level already). `buildRecording`
// ALSO enforces it at runtime (`assertBand` below) — defensive, because
// a band number reaching this function from persisted/DB-sourced data
// (unlike a literal in source) is not actually narrowed by the compiler.
import { useState } from "react";
import type { FidelityBand } from "@seazn/engine/sport";
import type { MessageKey } from "@/lib/messages";
import { planLabel } from "@/lib/plan-label";
import type { MsgFn } from "./ribbon";

const BAND_LABEL_KEY: Record<FidelityBand, MessageKey> = {
  0: "pad.recording.band.0",
  1: "pad.recording.band.1",
  2: "pad.recording.band.2",
  3: "pad.recording.band.3",
};

/** R1's fixed stand-in plan key for every locked band — see the header
 *  comment's "PLAN NAME" note. */
const LOCK_PLAN_KEY = "pro";

export interface RecordingView {
  label: string;
  locked: boolean;
  /** Present iff `locked` — the full worded sentence, never a bare
   *  boolean/icon. */
  upsell?: string;
}

function assertBand(value: number, paramName: string): asserts value is FidelityBand {
  if (value !== 0 && value !== 1 && value !== 2 && value !== 3) {
    throw new RangeError(
      `buildRecording: ${paramName} must be a FidelityBand (closed 0-3) — got ${value}`,
    );
  }
}

/**
 * Word one fidelity band for the Recording Chip.
 *
 * `fidelity` is the band being described (the caller may query the
 * fixture's own active band to render its current state, or
 * `activeBand + 1` to preview the next tier — see `RecordingChip`
 * below, which does both). `activeBand` is the fixture's own
 * currently-active band; besides grounding the closed-0-3 runtime
 * check alongside `fidelity`, it is what a caller builds the "next
 * tier" query against. `entitledBands` is the pre-resolved set of
 * bands the org currently holds (see header comment).
 *
 * Entitled -> `{label, locked:false}`. Not entitled -> `{label,
 * locked:true, upsell}`, where `upsell` is the full
 * `pad.recording.locked` sentence — generalised to ANY unentitled band,
 * not only `activeBand + 1` (the brief's own required case): the same
 * formula is correct for every locked band there is, and restricting it
 * would just be an arbitrary, untested special case.
 */
export function buildRecording(
  fidelity: FidelityBand,
  activeBand: FidelityBand,
  entitledBands: ReadonlySet<FidelityBand>,
  t: MsgFn,
): RecordingView {
  assertBand(fidelity, "fidelity");
  assertBand(activeBand, "activeBand");
  const label = t(BAND_LABEL_KEY[fidelity]);
  if (entitledBands.has(fidelity)) {
    return { label, locked: false };
  }
  return {
    label,
    locked: true,
    upsell: t("pad.recording.locked", { band: label, plan: planLabel(LOCK_PLAN_KEY) }),
  };
}

export interface RecordingChipProps {
  /** The fixture's own currently-active recording band. */
  activeBand: FidelityBand;
  /** Pre-resolved set of bands the org currently holds — see
   *  `buildRecording`'s own doc. */
  entitledBands: ReadonlySet<FidelityBand>;
  /** Same MsgFn-shaped lookup scorebug.tsx's/tile-grid.tsx's/
   *  detail-dock.tsx's own `t` prop take (useMsg()/msgFor() both hand
   *  callers this shape). */
  t: MsgFn;
}

/**
 * Renders the current recording level as a single 44px pill (never a
 * bare padlock). Collapsed, it states only the active band in sport
 * words — that alone is never locked (an org cannot be actively using a
 * band it does not hold), so the collapsed pill carries no lock
 * treatment at all. A disclosure chevron appears only when a next tier
 * exists AND is genuinely locked; tapping it reveals that tier's own
 * fully worded upsell sentence below — "the explainer" the brief asks
 * this chip to open. When nothing is left to unlock (already at band 3,
 * or the next tier is already entitled too), the button stays real and
 * focusable but the tap is a no-op: there is nothing to disclose, and
 * showing a disclosure affordance with nothing behind it would be its
 * own small lie.
 *
 * R1 ships this component unwired (same posture Scorebug/TileGrid/
 * DetailDock shipped their own optional callbacks in this wave): it
 * REPLACES fidelity-switcher.tsx's four-button picker only when a sport
 * converts (R2+) — both exist side by side until then.
 */
export function RecordingChip({ activeBand, entitledBands, t }: RecordingChipProps) {
  const [expanded, setExpanded] = useState(false);

  const current = buildRecording(activeBand, activeBand, entitledBands, t);
  const nextBand: FidelityBand | null = activeBand < 3 ? ((activeBand + 1) as FidelityBand) : null;
  const next = nextBand === null ? null : buildRecording(nextBand, activeBand, entitledBands, t);
  const showUpsell = next !== null && next.locked;

  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={showUpsell ? expanded : undefined}
        onClick={() => {
          if (showUpsell) setExpanded((v) => !v);
        }}
        style={{ minHeight: 44 }}
        className="flex w-full min-w-0 items-center gap-2 rounded-full border border-slate-200 bg-white px-4 text-left text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400"
      >
        <span
          aria-hidden="true"
          className={`h-2 w-2 shrink-0 rounded-full ${current.locked ? "bg-amber-500" : "bg-violet-600"}`}
        />
        <span className="min-w-0 flex-1 truncate">{current.label}</span>
        {showUpsell && (
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${expanded ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 6l4 4 4-4" />
          </svg>
        )}
      </button>
      {/* Defensive, not decorative (Task 11 fix batch, deferred from Task 9's
       * review). buildRecording's own contract says the ACTIVE band can
       * never be locked ("an org cannot be actively using a band it does
       * not hold" — see the doc comment above). If that invariant is ever
       * violated anyway — an entitlement revoked mid-fixture, say — this
       * component's whole reason to exist is to never go silent about a
       * lock (header comment's "never a silent lock icon" rule), so a bare
       * `current.label` with no lock treatment would be exactly the defect
       * this chip replaces. Unreachable while every caller upholds the
       * invariant, and R1 ships this component with zero callers either
       * way (registry.ts's V3_SKINS is empty) — but "unreachable today"
       * ships inert, not untested, in this repo. */}
      {current.locked && current.upsell && (
        <p className="mt-1.5 min-w-0 break-words px-4 text-xs font-medium text-amber-700">{current.upsell}</p>
      )}
      {expanded && showUpsell && next?.upsell && (
        <p className="mt-1.5 min-w-0 break-words px-4 text-xs font-medium text-slate-500">{next.upsell}</p>
      )}
    </div>
  );
}
