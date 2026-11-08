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
// component, and no further: the only client component here is `HtmlLang`, which takes the locale alone.
import type { Metadata } from "next";
import { HtmlLang } from "@/components/i18n/html-lang";
import { QuickMatchDead, QuickMatchHomeView, type QuickMatchCopy } from "@/components/quick-match/home";
import { getDictionary } from "@/lib/i18n";
import { plural, t } from "@/lib/i18n-runtime";
import { resolveLocale } from "@/lib/resolve-locale";
import { levelWords } from "@/lib/score/levels";
import { readQuickMatchHome, resolveQuickMatchToken } from "@/server/usecases/quick-match-home";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");
  return { title: t(ui, "quickMatch.home.title"), robots: { index: false, follow: false } };
}

export default async function QuickMatchHomePage({ params }: { params: Promise<{ token: string }> }) {
  const token = (await params).token.trim();
  const locale = await resolveLocale();
  const [ui, pub] = await Promise.all([getDictionary(locale, "ui"), getDictionary(locale, "public")]);
  const copy: QuickMatchCopy = {
    t: (key, vars) => t(ui, key, vars),
    plural: (key, count, vars) => plural(ui, key, count, locale, vars),
    levels: levelWords(pub),
  };

  const row = await resolveQuickMatchToken(token);
  const home = row ? await readQuickMatchHome(row) : null;
  return (
    <>
      <HtmlLang lang={locale} />
      {home ? <QuickMatchHomeView home={home} copy={copy} /> : <QuickMatchDead locale={locale} t={copy.t} />}
    </>
  );
}
