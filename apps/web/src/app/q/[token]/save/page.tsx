// Quick match plan 3, Task 5 (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §7.7 as amended 2026-11-08, C3,
// C19; plan 3 Amend T5 [D2, B22, B24, B25]): the save page, `GET /q/<token>/save`. Where the sign-in hand-off lands
// (`/login?next=/q/<token>/save`) and where the reminder mail's "Save it" opens (branch review B I1).
//
// It NEVER writes: a GET is followed by link previews, prefetchers and mail scanners, so the save is the button's post
// (`/q/<token>/save/confirm`, ./confirm/route.ts), never this page. What it shows:
//   - an unknown, malformed, expired or deleted token: plan 2's dead screen, which never says which;
//   - signed in and already yours: straight to the home;
//   - saved by somebody else (signed in or not: a saved match is no longer anyone else's to save): the taken line and the
//     way back to the match;
//   - anything else: the match's name, what saving does, and one button.
// The session is read only for a saved match, the one case where who is looking changes the page.
//
// Words: the VIEWER's (`resolveLocale()` with no org default, as the home), never the row's. Never cached, never indexed.
// Everything here that holds the token (the form's action, the back link) carries `ph-no-capture` (the token is the match's
// credential, O3; scrub-secret-painters.test.ts).
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { HtmlLang } from "@/components/i18n/html-lang";
import { gantry, QuickMatchDead, type QuickMatchCopy } from "@/components/quick-match/home";
import { QuickMatchSaveForm } from "@/components/quick-match/save-form";
import { getCurrentUser } from "@/lib/auth";
import { getDictionary } from "@/lib/i18n";
import { t } from "@/lib/i18n-runtime";
import { resolveLocale } from "@/lib/resolve-locale";
import { routes } from "@/lib/routes";
import { resolveQuickMatchToken } from "@/server/usecases/quick-match-home";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");
  return { title: t(ui, "quickMatch.home.save"), robots: { index: false, follow: false } };
}

const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cream";

export default async function QuickMatchSavePage({ params }: { params: Promise<{ token: string }> }) {
  const token = (await params).token.trim();
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");
  const tt: QuickMatchCopy["t"] = (key, vars) => t(ui, key, vars);

  const row = await resolveQuickMatchToken(token);
  if (!row) {
    return (
      <>
        <HtmlLang lang={locale} />
        <QuickMatchDead locale={locale} t={tt} />
      </>
    );
  }

  const taken = row.savedByUserId !== null;
  if (taken) {
    const viewer = await getCurrentUser();
    if (viewer !== null && viewer.id === row.savedByUserId) redirect(routes.quickMatch(token));
  }

  return (
    <>
      <HtmlLang lang={locale} />
      <div className="flex min-h-screen flex-col bg-night text-cream">
        {gantry(tt)}
        <main lang={locale} className="flex min-w-0 flex-1 flex-col">
          <section
            data-testid="qm-save-page"
            aria-labelledby="qm-save-heading"
            className="mx-auto flex w-full max-w-md min-w-0 flex-1 flex-col justify-center gap-3 px-4 py-12 sm:px-6"
          >
            {taken ? (
              <h1
                id="qm-save-heading"
                data-testid="qm-save-taken"
                className="app-display text-2xl font-bold leading-tight text-cream [overflow-wrap:anywhere]"
              >
                {tt("quickMatch.flash.taken")}
              </h1>
            ) : (
              <>
                <h1
                  id="qm-save-heading"
                  data-testid="qm-save-title"
                  className="app-display text-2xl font-bold leading-tight text-cream [overflow-wrap:anywhere]"
                >
                  {tt("quickMatch.save.title", { name: row.name })}
                </h1>
                <p data-testid="qm-save-hint" className="text-sm leading-relaxed text-[#b7aede]">
                  {tt("quickMatch.save.hint")}
                </p>
                <div className="mt-3 min-w-0">
                  <QuickMatchSaveForm
                    action={routes.quickMatchSaveConfirm(token)}
                    label={tt("quickMatch.home.save")}
                    look="primary"
                  />
                </div>
              </>
            )}
            <a
              data-testid="qm-save-back"
              href={routes.quickMatch(token)}
              className={`ph-no-capture app-display inline-flex min-h-11 max-w-full items-center justify-center self-center rounded-lg px-4 py-2 text-center text-sm font-semibold leading-tight text-[#b7aede] underline-offset-4 hover:text-cream hover:underline ${FOCUS}`}
            >
              {tt("quickMatch.save.backHome")}
            </a>
          </section>
        </main>
      </div>
    </>
  );
}
