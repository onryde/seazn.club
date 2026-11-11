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
// A plan without organisation-wide tiers still sees all four rows - the legend is also what the upgrade buys - and a plan line under
// them that says two true things: what its own pages and stream do (the public board draws every sponsor in ONE flat strip, and the
// stream draws every card as a partner, so each takes the partner's turns - the rows above describe the tiered board, and a free club
// must not read promises its pages do not keep), and what needs a paid plan or an Event Pass (`placementNeedsTiers`: Partner for the
// whole organisation is the one placement every plan has). An editor gets the way out (the billing link, the online note's own).
//
// The legend folds at EVERY width (`PhoneDisclosure` in its `allWidths` mode, one DOM; owner, 2026-11-11: it folded only below `md`, and
// he wanted the same open / hide row on a desktop): its summary IS the heading - there is no h3 of its own, and the section's
// `aria-labelledby` points at the summary's text. It starts open when the list has no packages yet (`startOpen` -> `phoneStartOpen`):
// an empty tab needs it most; with packages the price list is the page and this starts folded out of the way. A reader's own tap is
// theirs: creating the first package does not fold a legend they have open.
import { useMsg, useMsgPlural } from "@/components/i18n/dict-provider";
import { TIER_BADGE, TIER_LEGEND_MSG, TIER_MSG } from "@/components/sponsors/tier-labels";
import Link from "@/components/ui/console-link";
import { PhoneDisclosure } from "@/components/v2/phone-disclosure";
import { SPONSOR_TIERS, SPONSOR_TIER_WEIGHTS } from "@/lib/sponsor-tiers";

const CHIP = "rounded-full px-2 py-0.5 text-[11px] font-medium";
/** The same classes as package-list.tsx's `LOCK_LINK` (the online note's upgrade link): a 44px target on a phone. */
const UPGRADE_LINK = "inline-flex items-center font-medium text-purple-700 underline max-md:min-h-11";

export interface TierLegendProps {
  /** `sponsors.tiers` is on for the whole organisation (a paid plan). Off: the plan line under the rows says what its pages do and what to upgrade for. */
  tiersOrgWide: boolean;
  /** Where "Upgrade your plan" goes (the billing page). Drawn on the plan line for an editor only, and only when there is a plan line. */
  billingHref: string;
  canEdit: boolean;
  /** The fold starts open (an empty price list), at every width. With packages it starts folded. */
  startOpen: boolean;
}

export function TierLegend({ tiersOrgWide, billingHref, canEdit, startOpen }: TierLegendProps) {
  const msg = useMsg();
  const plural = useMsgPlural();
  return (
    <div data-testid="tier-legend-fold" className="min-w-0">
      <PhoneDisclosure
        allWidths
        summary={<span id="tier-legend-heading">{msg("sponsors.pkg.legend.heading")}</span>}
        showLabel={msg("sponsors.pkg.legend.show")}
        hideLabel={msg("sponsors.pkg.legend.hide")}
        phoneStartOpen={startOpen}
      >
        <section data-testid="tier-legend" aria-labelledby="tier-legend-heading" className="mt-2 min-w-0 rounded-xl bg-slate-50 p-4">
          <ul className="divide-y divide-slate-200/70">
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
            <div data-testid="tier-legend-plan" className="mt-3 min-w-0 space-y-1.5 border-t border-slate-200/70 pt-3 text-xs text-slate-500">
              {/* What its own pages and stream do: every card is a partner here (`sponsorCardOf`), so the turns are the PARTNER's. */}
              <p data-testid="tier-legend-plan-board" className="min-w-0 break-words">
                {plural("sponsors.pkg.legend.planBoard", SPONSOR_TIER_WEIGHTS.partner)}
              </p>
              <p data-testid="tier-legend-plan-tiers" className="min-w-0 break-words">
                {msg("sponsors.pkg.legend.plan", { partner: msg(TIER_MSG.partner) })}
              </p>
              {canEdit ? (
                <Link data-testid="tier-legend-upgrade" href={billingHref} className={UPGRADE_LINK}>
                  {msg("sponsors.dealSheet.upgrade")}
                </Link>
              ) : null}
            </div>
          )}
        </section>
      </PhoneDisclosure>
    </div>
  );
}
