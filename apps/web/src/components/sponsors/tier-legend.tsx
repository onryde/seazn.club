"use client";

// "What each tier gets" - the legend under the Packages tab's price list (owner, 2026-11-11: "can we have some description or legend
// in package under the panel for explain the different tier usage?"). A package sets a sponsor's tier; this says what a tier IS,
// in the words of what the public pages draw for it (`TIER_LEGEND_MSG`), and how many turns it takes in the stream rotation.
//
// The turns are the planner's own weights (`SPONSOR_TIER_WEIGHTS`, owner ruling D9), read at render and interpolated - never typed
// into the copy, so a change to the weights moves the legend with it (tier-legend.test.tsx swaps the constant to prove it).
// Highest tier first, the order of `SPONSOR_TIERS`.
//
// Quiet on purpose: the price is the loud thing on this tab, so the legend is a borderless tinted panel of divided rows, the
// tier's own chip (the one the package cards wear, with a hairline ring: Gold and Partner are pale tints that vanish on the
// panel's own tint without one) on the left and the words on the right.
//
// A plan without organisation-wide tiers still sees all four rows - the legend is also what the upgrade buys - with one line under
// them saying what the plan can sell (`placementNeedsTiers`: Partner for the whole organisation is the one placement every plan has).
import { useMsg, useMsgPlural } from "@/components/i18n/dict-provider";
import { TIER_BADGE, TIER_LEGEND_MSG, TIER_MSG } from "@/components/sponsors/tier-labels";
import { SPONSOR_TIERS, SPONSOR_TIER_WEIGHTS } from "@/lib/sponsor-tiers";

const CHIP = "rounded-full px-2 py-0.5 text-[11px] font-medium";

export interface TierLegendProps {
  /** `sponsors.tiers` is on for the whole organisation (a paid plan). Off: the plan line under the rows says what to upgrade for. */
  tiersOrgWide: boolean;
}

export function TierLegend({ tiersOrgWide }: TierLegendProps) {
  const msg = useMsg();
  const plural = useMsgPlural();
  return (
    <section data-testid="tier-legend" aria-labelledby="tier-legend-heading" className="min-w-0 rounded-xl bg-slate-50 p-4">
      <h3 id="tier-legend-heading" className="text-sm font-semibold text-slate-800">
        {msg("sponsors.pkg.legend.heading")}
      </h3>
      <ul className="mt-3 divide-y divide-slate-200/70">
        {SPONSOR_TIERS.map((tier) => (
          <li
            key={tier}
            data-testid="tier-legend-row"
            data-tier={tier}
            className="grid min-w-0 grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-x-3 py-2.5 first:pt-0 last:pb-0"
          >
            <span data-testid="tier-legend-chip" className={`w-fit ring-1 ring-inset ring-slate-900/5 ${CHIP} ${TIER_BADGE[tier]}`}>
              {msg(TIER_MSG[tier])}
            </span>
            <div className="min-w-0">
              <span data-testid="tier-legend-what" className="block min-w-0 break-words text-sm text-slate-700">
                {msg(TIER_LEGEND_MSG[tier])}
              </span>
              <span data-testid="tier-legend-turns" className="mt-0.5 block min-w-0 break-words text-xs tabular-nums text-slate-500">
                {plural("sponsors.pkg.legend.turns", SPONSOR_TIER_WEIGHTS[tier])}
              </span>
            </div>
          </li>
        ))}
      </ul>
      {tiersOrgWide ? null : (
        <p data-testid="tier-legend-plan" className="mt-3 min-w-0 break-words border-t border-slate-200/70 pt-3 text-xs text-slate-500">
          {msg("sponsors.pkg.legend.plan", { partner: msg(TIER_MSG.partner) })}
        </p>
      )}
    </section>
  );
}
