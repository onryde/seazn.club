import { MarketingNav } from "@/components/marketing-nav";
import { FunnelClaim } from "@/components/funnel-claim";
import { DictProvider } from "@/components/i18n/dict-provider";
import { HtmlLang } from "@/components/i18n/html-lang";
import { funnelDraftCard } from "@/lib/funnel";
import { getDictionary } from "@/lib/i18n";
import { resolveLocale } from "@/lib/resolve-locale";

/** Landing for the emailed funnel link (v3/07 §6) — the token signs the
 *  visitor in AND creates the drafted competition. The emailed URL carries no
 *  language, so the card is worded in the one the draft was started in (read by
 *  the token, never claiming it), else as /magic-link resolves it (the
 *  switcher's cookie, the account's, then the browser's). The draft's sport, read the same way, is what the card's
 *  "Start again" carries when the claim finds its first day has passed; its reference is what the card names when a newer
 *  start replaced the link (V518). */
export default async function FunnelClaimPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const draft = token ? await funnelDraftCard(token) : null;
  const locale = draft?.locale ?? (await resolveLocale());
  const ui = await getDictionary(locale, "ui");
  return (
    <>
      <HtmlLang lang={locale} />
      <MarketingNav lang={locale} />
      <main className="mx-auto max-w-md px-4 py-12">
        <DictProvider dict={ui} locale={locale}>
          <FunnelClaim token={token ?? null} restartSport={draft?.sportKey ?? null} reference={draft?.reference ?? null} />
        </DictProvider>
      </main>
    </>
  );
}
