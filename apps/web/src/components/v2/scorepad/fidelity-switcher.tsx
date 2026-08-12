"use client";
// Tier picker per fixture (S10/#419 W8, chassis item 3). Band is a pure
// view/recording-depth selection — nothing here ever touches the folded
// match state, so "upgrade keeps state" holds structurally: `onChange` just
// hands the caller a new `FidelityBand` number, the same one view-model.ts's
// `buildPadView`/`allActionViews` already take as `ctx.band`.
//
// A downgrade needs a confirm step (product ruling: "WARNS before hiding
// actions and never deletes anything") because it can hide in-progress work
// from view — an upgrade never hides anything the scorer could already see,
// so it applies immediately, matching an ordinary settings toggle. A band
// whose required entitlement the org lacks is DISABLED, not omitted — the
// org should see the tier exists, not wonder why it's missing (mirrors
// view-model.ts's own "locked, not absent" rule for individual actions).
import { useState } from "react";
import { useMsg } from "@/components/i18n/dict-provider";
import type { FidelityBand, PadSpec } from "@seazn/engine/sport";
import type { MessageKey } from "@/lib/messages";

const BANDS: readonly FidelityBand[] = [0, 1, 2, 3];

const BAND_LABEL_KEY: Record<FidelityBand, MessageKey> = {
  0: "scorepad.fidelity.band.result",
  1: "scorepad.fidelity.band.card",
  2: "scorepad.fidelity.band.timeline",
  3: "scorepad.fidelity.band.detail",
};

export interface FidelitySwitcherProps {
  value: FidelityBand;
  onChange: (band: FidelityBand) => void;
  entitlements: Readonly<Record<string, boolean>>;
  fidelityEntitlements: PadSpec["fidelityEntitlements"];
}

export function FidelitySwitcher({ value, onChange, entitlements, fidelityEntitlements }: FidelitySwitcherProps) {
  const msg = useMsg();
  // The band awaiting confirmation, or null when no downgrade is pending.
  const [pending, setPending] = useState<FidelityBand | null>(null);

  function isLocked(band: FidelityBand): boolean {
    const needed = fidelityEntitlements[band];
    return needed !== undefined && !entitlements[needed];
  }

  function requestChange(band: FidelityBand) {
    if (band === value || isLocked(band)) return;
    if (band < value) {
      setPending(band);
      return;
    }
    onChange(band); // upgrade — applies immediately, keeps state
  }

  function confirmDowngrade() {
    if (pending === null) return;
    onChange(pending);
    setPending(null);
  }

  function cancelDowngrade() {
    setPending(null);
  }

  return (
    <div className="card space-y-2 p-3">
      <p className="label !mb-0">{msg("scorepad.fidelity.heading")}</p>
      <div className="flex gap-1.5">
        {BANDS.map((band) => {
          const locked = isLocked(band);
          const active = band === value;
          return (
            <button
              key={band}
              type="button"
              data-band={band}
              disabled={locked}
              aria-pressed={active}
              title={locked ? msg("scorepad.fidelity.locked") : undefined}
              onClick={() => requestChange(band)}
              className={`flex-1 rounded-lg border px-2 py-2 text-xs font-semibold transition ${
                active
                  ? "border-purple-600 bg-purple-600 text-white"
                  : locked
                    ? "cursor-not-allowed border-purple-100 bg-white text-purple-300 opacity-60"
                    : "border-purple-200 bg-white text-purple-700 hover:bg-purple-50"
              }`}
            >
              {msg(BAND_LABEL_KEY[band])}
              {locked && <span aria-hidden> 🔒</span>}
            </button>
          );
        })}
      </div>

      {pending !== null && (
        <div role="alertdialog" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p>{msg("scorepad.fidelity.downgradeWarning")}</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              data-role="cancel-downgrade"
              className="btn btn-ghost flex-1"
              onClick={cancelDowngrade}
            >
              {msg("scorepad.fidelity.cancel")}
            </button>
            <button
              type="button"
              data-role="confirm-downgrade"
              className="btn btn-danger flex-1"
              onClick={confirmDowngrade}
            >
              {msg("scorepad.fidelity.confirmDowngrade")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
