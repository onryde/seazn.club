// The sponsor tiers' labels and badge classes: ONE home for the Sponsors tab (components/org-sponsors.tsx) and the On stream
// tab (components/sponsors/on-stream-tab.tsx), so the second does not have to import the first's whole manager (its form, its
// upload code, its confirm dialog) just to name a tier. Pure constants - no hooks, no "use client" needed.
import type { MessageKey } from "@/lib/messages";
import type { SponsorTier } from "@/lib/sponsor-tiers";

// Typed key map — the i18n house rule bans dynamic `msg()` keys.
export const TIER_MSG: Record<SponsorTier, MessageKey> = {
  title: "sponsors.tier.titleTier",
  gold: "sponsors.tier.gold",
  silver: "sponsors.tier.silver",
  partner: "sponsors.tier.partner",
};

export const TIER_BADGE: Record<SponsorTier, string> = {
  title: "bg-amber-100 text-amber-800",
  gold: "bg-yellow-50 text-yellow-700",
  silver: "bg-slate-200 text-slate-600",
  partner: "bg-slate-100 text-slate-500",
};
