import { redirect } from "next/navigation";
import { getCurrentUser, safeNextPath } from "@/lib/auth";
import { AuthForm } from "@/components/auth-form";
import { NightStage } from "@/components/night-stage";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import { DictProvider } from "@/components/i18n/dict-provider";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const user = await getCurrentUser();
  // A signed-in user who arrived with a destination gets it, rather than being
  // dumped on the dashboard — otherwise following a link that bounced through
  // login loses it at the last hop.
  const { next: rawNext } = await searchParams;
  const next = safeNextPath(rawNext) ?? undefined;
  if (user) redirect(next ?? "/dashboard");
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");

  return (
    <NightStage>
      <DictProvider dict={ui} locale={locale}>
        <p className="-mt-3 mb-6 text-center text-sm text-cream/70">
          {t(ui, "login.subtitle")}
        </p>
        <AuthForm next={next} />
      </DictProvider>
    </NightStage>
  );
}
