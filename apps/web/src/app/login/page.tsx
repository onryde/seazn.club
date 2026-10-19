import { redirect } from "next/navigation";
import { getCurrentUser, safeNextPath } from "@/lib/auth";
import { AuthForm } from "@/components/auth-form";
import { NightStage } from "@/components/night-stage";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import { DictProvider } from "@/components/i18n/dict-provider";
import {
  GOOGLE_FLASH_EMAIL_UNVERIFIED,
  GOOGLE_FLASH_LINKED_ELSEWHERE,
  GOOGLE_FLASH_PARAM,
} from "@/lib/oauth";

/** `?google=<code>` — why the Google callback sent the person back here. Only a
 *  code listed here is shown; anything else (and the callback's older
 *  `?error=` codes) renders nothing, and nothing from the URL is echoed. */
const GOOGLE_FLASH_KEY = {
  [GOOGLE_FLASH_EMAIL_UNVERIFIED]: "login.flash.google.email_unverified",
  [GOOGLE_FLASH_LINKED_ELSEWHERE]: "login.flash.google.linked_elsewhere",
} as const;

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; google?: string }>;
}) {
  const user = await getCurrentUser();
  // A signed-in user who arrived with a destination gets it, rather than being
  // dumped on the dashboard — otherwise following a link that bounced through
  // login loses it at the last hop.
  const { next: rawNext, [GOOGLE_FLASH_PARAM]: flash } = await searchParams;
  const next = safeNextPath(rawNext) ?? undefined;
  if (user) redirect(next ?? "/dashboard");
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");
  const flashKey =
    typeof flash === "string" && Object.hasOwn(GOOGLE_FLASH_KEY, flash)
      ? GOOGLE_FLASH_KEY[flash as keyof typeof GOOGLE_FLASH_KEY]
      : null;

  return (
    <NightStage>
      <DictProvider dict={ui} locale={locale}>
        <p className="-mt-3 mb-6 text-center text-sm text-cream/70">
          {t(ui, "login.subtitle")}
        </p>
        {flashKey && (
          <p role="alert" className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
            {t(ui, flashKey)}
          </p>
        )}
        <AuthForm next={next} />
      </DictProvider>
    </NightStage>
  );
}
