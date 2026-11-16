"use client";

import { DictProvider } from "@/components/i18n/dict-provider";
import { AiArchitectDemo } from "@/components/marketing/ai-architect-demo";
import type { RungWeights } from "@/lib/ai-rung";
import type { Dict, Locale } from "@/lib/i18n-constants";

/**
 * The heavy half of the recorded-runs section: the replay and the dictionary provider it reads through. Both live
 * here, behind recorded-runs.tsx's dynamic import, because `DictProvider` itself pulls the app's English message
 * catalogue (about 550 KB) into whatever chunk imports it. Mounted in the page, it would load before anyone scrolls.
 */
export default function RecordedRunsReplay({ locale, weights, dict }: { locale: Locale; weights: RungWeights; dict: Dict }) {
  return (
    <DictProvider dict={dict} locale={locale}>
      <AiArchitectDemo locale={locale} weights={weights} />
    </DictProvider>
  );
}
