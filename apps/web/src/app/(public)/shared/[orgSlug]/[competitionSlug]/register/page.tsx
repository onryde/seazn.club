export const dynamic = "force-dynamic";
// Public register flow (RS006 — design doc
// `2026-08-16-registration-redesign-design.md` §4). Server component
// wrapper: resolves the existence/visibility gate and fetches the register
// panel data exactly as the closed-state stub did, then hands it to the
// client stepper (register-stepper.tsx) for the interactive part. A
// competition with NO enabled divisions keeps the closed/"not open" state
// this route has shown since the RS001 demolition — register-page-closed
// test.tsx pins that exact markup, unchanged by this session.
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { publicRegistrationInfo } from "@/server/usecases/registrations";
import { HttpError } from "@/lib/errors";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import { DictProvider } from "@/components/i18n/dict-provider";
import { RegisterStepper } from "@/components/public-site/register/register-stepper";

type Props = {
  params: Promise<{ orgSlug: string; competitionSlug: string }>;
  // RS007's join-link deep-link (`?join=<CODE>`, design §4) — read here so
  // the seam is real, not built: RegisterStepper accepts and ignores it
  // (see that file's header) until RS007 lands the join flow.
  searchParams: Promise<{ join?: string }>;
};

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function RegisterPage({ params, searchParams }: Props) {
  const { orgSlug, competitionSlug } = await params;
  const { join } = await searchParams;
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

  if (info.divisions.length === 0) {
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

  return (
    <DictProvider dict={ui} locale={locale}>
      <div className="mx-auto max-w-4xl">
        <p className="text-xs text-ink-muted">
          <Link
            href={`/shared/${orgSlug}/${competitionSlug}`}
            className="hover:text-accent-strong hover:underline"
          >
            {info.competition.name}
          </Link>{" "}
          / {t(ui, "register.title")}
        </p>
        <h1 className="mt-1 mb-4 font-display text-4xl font-bold uppercase tracking-tight text-ink">
          {t(ui, "register.title")}
        </h1>
        <RegisterStepper
          orgSlug={orgSlug}
          competitionSlug={competitionSlug}
          info={info}
          locale={locale}
          joinCode={join ?? null}
        />
      </div>
    </DictProvider>
  );
}
