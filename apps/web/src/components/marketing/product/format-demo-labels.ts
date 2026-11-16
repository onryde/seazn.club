import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import { FORMAT_NAME_KEY, FORMAT_TAGLINE_KEY } from "@/lib/format-recommend";
import type { FunnelFormat } from "@/lib/funnel-formats";

/**
 * The format demo's copy, built on the server. The controls and badges reuse the setup wizard's own words
 * (`start.wizard.*`), and each card's name and one-line trade-off are the product's (`ui`), so the demo cannot say
 * something different from the screen it stands in for.
 */
const WIZARD = ["entrants", "courts", "hours", "stepper.less", "stepper.more", "matchesCount.one", "matchesCount.other", "estHours", "fits", "runsOver", "bestFit", "needsAtLeast"] as const;
const OWN = ["minutes", "minutesValue", "perEntrant", "cards"] as const;
export type FormatDemoLabels = Record<(typeof WIZARD)[number] | (typeof OWN)[number], string> & {
  formats: Record<FunnelFormat, { name: string; tagline: string }>;
};

export function formatDemoLabels(marketing: Dict, ui: Dict): FormatDemoLabels {
  return {
    ...(Object.fromEntries([
      ...WIZARD.map((k) => [k, t(marketing, `start.wizard.${k}` as never)]),
      ...OWN.map((k) => [k, t(marketing, `product.format.demo.${k}` as never)]),
    ]) as Record<(typeof WIZARD)[number] | (typeof OWN)[number], string>),
    formats: Object.fromEntries(
      (Object.keys(FORMAT_NAME_KEY) as FunnelFormat[]).map((slug) => [slug, { name: t(ui, FORMAT_NAME_KEY[slug] as never), tagline: t(ui, FORMAT_TAGLINE_KEY[slug] as never) }]),
    ) as Record<FunnelFormat, { name: string; tagline: string }>,
  };
}
