export const dynamic = "force-dynamic";
// Public registration status by reference — CLOSED (RS001 registration
// demolition). `publicRegistrationStatusByRef`/`reconcileRegistrationBySession`
// read `ref_code`/`access_token_hash` off `registrations`, which V364 moved
// to `registration_groups`; nothing can submit a registration right now (the
// old endpoint is deleted, the new one lands in RS003), so no ref can
// resolve to anything. RS007 re-points this page at group refs. Owner-
// accepted: prod has zero registration rows, so nothing regresses (design §7
// phasing).
import type { Metadata } from "next";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import { DictProvider } from "@/components/i18n/dict-provider";

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function RefStatusPage() {
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");

  return (
    <DictProvider dict={ui} locale={locale}>
      <main className="mx-auto max-w-xl px-4 py-10">
        <h1 className="font-display text-2xl font-semibold text-ink">
          {t(ui, "register.closed.title")}
        </h1>
        <p className="mt-2 text-sm text-zinc-500">{t(ui, "register.notOpen")}</p>
      </main>
    </DictProvider>
  );
}
