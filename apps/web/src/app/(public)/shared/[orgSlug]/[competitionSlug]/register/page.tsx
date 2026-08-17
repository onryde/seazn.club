export const dynamic = "force-dynamic";
// Public register flow — CLOSED (RS001 registration demolition). The
// old single-entry form + endpoint are gone; the new cart stepper (design
// doc `2026-08-16-registration-redesign-design.md` §4) lands in RS006. Until
// then this route stays live but shows the existing "not open" state
// unconditionally — owner-accepted: prod has zero registration rows, so
// nothing regresses (design §7 phasing).
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { publicRegistrationInfo } from "@/server/usecases/registrations";
import { HttpError } from "@/lib/errors";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import { DictProvider } from "@/components/i18n/dict-provider";

type Props = { params: Promise<{ orgSlug: string; competitionSlug: string }> };

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function RegisterPage({ params }: Props) {
  const { orgSlug, competitionSlug } = await params;
  // Existence/visibility check only — still the real gate a bad slug hit
  // before (competitions.visibility in public/unlisted, org active).
  let info;
  try {
    info = await publicRegistrationInfo(orgSlug, competitionSlug);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) notFound();
    throw err;
  }

  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");

  return (
    <DictProvider dict={ui} locale={locale}>
      <div className="mx-auto max-w-2xl">
        <p className="text-xs text-ink-muted">
          <Link
            href={`/shared/${orgSlug}/${competitionSlug}`}
            className="hover:text-accent-strong hover:underline"
          >
            {info.competition.name}
          </Link>{" "}
          / {t(ui, "register.title")}
        </p>
        <h1 className="mt-1 font-display text-4xl font-bold uppercase tracking-tight text-ink">
          {t(ui, "register.title")}
        </h1>
        <p className="mt-4 text-sm text-zinc-500">{t(ui, "register.notOpen")}</p>
      </div>
    </DictProvider>
  );
}
