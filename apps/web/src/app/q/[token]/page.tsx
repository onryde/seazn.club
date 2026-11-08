// Quick match plan 2, Task 5 (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5 step 3, §7.5, C19): the
// guest's home at `/q/<token>`. The token is a scoring credential (O3): it is read from the route's `params` only, trimmed
// (Review Focus 3: a trailing slash or a `?utm` never reaches it; case is part of it), and resolved by plan 1's
// `resolveQuickMatchToken`, which answers null for an unknown, malformed, expired or deleted one. Every null is the same
// dead screen, so the page never says which.
//
// Never cached (`force-dynamic`, Review Focus 2): the home after a score must be the new table. Never indexed.
// The viewer's locale (D10): `resolveLocale()` with no org default, exactly as the pad resolves it, never the row's.
//
// The read's `row` carries the creator's email and the sealed token (A14). It goes to `QuickMatchHomeView`, a SERVER
// component, and no further. The client components here take strings only: `HtmlLang` the locale, and Task 6's
// `QuickMatchScoreForm` its action (`/q/<token>/score/<fixtureId>`, the home's own path plus a fixture id) and its words.
//
// Task 6: the Score slot (each playable match's form post into the pad) and the flash: a refused action lands back here
// as `?e=<code>` (D3), printed as the viewer's `quickMatch.flash.*` line. The dead screen ignores `?e=`: a crafted one
// must not give a dead link a reason (D16).
import type { Metadata } from "next";
import { HtmlLang } from "@/components/i18n/html-lang";
import {
  homeFlashKey,
  QuickMatchDead,
  QuickMatchHomeView,
  type QuickMatchCopy,
  type QuickMatchSlots,
} from "@/components/quick-match/home";
import { matchSidesId } from "@/components/quick-match/match-list";
import { QuickMatchScoreForm } from "@/components/quick-match/score-form";
import { getDictionary } from "@/lib/i18n";
import { plural, t } from "@/lib/i18n-runtime";
import { resolveLocale } from "@/lib/resolve-locale";
import { routes } from "@/lib/routes";
import { levelWords } from "@/lib/score/levels";
import { readQuickMatchHome, resolveQuickMatchToken } from "@/server/usecases/quick-match-home";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");
  return { title: t(ui, "quickMatch.home.title"), robots: { index: false, follow: false } };
}

export default async function QuickMatchHomePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams?: Promise<{ e?: string | string[] }>;
}) {
  const token = (await params).token.trim();
  const locale = await resolveLocale();
  const [ui, pub, search] = await Promise.all([getDictionary(locale, "ui"), getDictionary(locale, "public"), searchParams]);
  const copy: QuickMatchCopy = {
    t: (key, vars) => t(ui, key, vars),
    plural: (key, count, vars) => plural(ui, key, count, locale, vars),
    levels: levelWords(pub),
    pub: (key, vars) => t(pub, key, vars),
  };

  const row = await resolveQuickMatchToken(token);
  const home = row ? await readQuickMatchHome(row) : null;
  if (!home) {
    return (
      <>
        <HtmlLang lang={locale} />
        <QuickMatchDead locale={locale} t={copy.t} />
      </>
    );
  }

  const flashKey = homeFlashKey(search?.e);
  const slots: QuickMatchSlots = {
    // Offered by the view on a live or ready match only (C11, C18), the hero's and each such row's.
    score: (fixture, place) => (
      <QuickMatchScoreForm
        action={`${routes.quickMatch(token)}/score/${fixture.id}`}
        place={place}
        label={copy.t(
          place === "row" ? "quickMatch.home.scoreShort" : fixture.live ? "quickMatch.home.continue" : "quickMatch.home.score",
        )}
        describedBy={place === "row" ? matchSidesId(fixture.id) : undefined}
      />
    ),
  };
  return (
    <>
      <HtmlLang lang={locale} />
      <QuickMatchHomeView home={home} copy={copy} slots={slots} flash={flashKey ? copy.t(flashKey) : null} />
    </>
  );
}
