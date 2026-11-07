// /day/{token} — a Match Day code's QR payload (capture S4 design §3, §9 item 2; MD-1 Task 2). The Seazn Club app reads
// the token off this URL itself; a phone's own camera lands here instead, and the page says to scan the code with the
// app. It NEVER resolves the token: a live code, a withdrawn one and a made-up one all get the same page, so the page is
// no oracle, and the token is never written into the HTML (it is a credential; telemetry scrubs it from the URL too,
// lib/scrub-score-url.ts `/day/`).
import type { Metadata } from "next";
import { NightStage } from "@/components/night-stage";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  // The URL is a credential: a link followed from this page must not carry it in a Referer.
  referrer: "no-referrer",
};

// No props: Next passes `params` (the token), and this page deliberately declares none, so it cannot read it.
export default async function MatchDayCodePage() {
  const ui = await getDictionary(await resolveLocale(), "ui");
  return (
    <NightStage maxW="max-w-md">
      <div data-testid="match-day-code-landing" className="text-center">
        <h1 className="app-display text-3xl font-bold tracking-tight text-cream">{t(ui, "matchDay.code.landing.title")}</h1>
        <p className="mt-3 text-sm text-cream/80">{t(ui, "matchDay.code.landing.body")}</p>
      </div>
    </NightStage>
  );
}
