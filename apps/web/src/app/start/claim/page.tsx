import { MarketingNav } from "@/components/marketing-nav";
import { FunnelClaim } from "@/components/funnel-claim";
import { DictProvider } from "@/components/i18n/dict-provider";
import { getDictionary } from "@/lib/i18n";
import { resolveLocale } from "@/lib/resolve-locale";

/** Landing for the emailed funnel link (v3/07 §6) — the token signs the
 *  visitor in AND creates the drafted competition. The emailed URL carries no
 *  language, so the visitor's is resolved as /magic-link resolves it (the
 *  switcher's cookie, the account's, then the browser's), and the card is worded
 *  in it. */
export default async function FunnelClaimPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");
  return (
    <>
      <MarketingNav lang={locale} />
      <main className="mx-auto max-w-md px-4 py-12">
        <DictProvider dict={ui} locale={locale}>
          <FunnelClaim token={token ?? null} />
        </DictProvider>
      </main>
    </>
  );
}
