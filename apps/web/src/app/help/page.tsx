import Link from "next/link";
import {
  BookUser, CalendarClock, ClipboardList, CreditCard, LayoutGrid,
  Megaphone, Play, Rocket, Trophy, UserCheck, Users, Webhook,
} from "lucide-react";
import { HELP_SECTIONS, helpNav } from "@/server/help-content";
import { FORMAT_FAMILIES } from "@/config/format-gallery";
import { HelpSearch } from "@/components/help/help-search";

export const revalidate = 3600;

const SECTION_ICONS: Record<string, React.ComponentType<{ className?: string; strokeWidth?: number; "aria-hidden"?: boolean }>> = {
  "getting-started": Rocket,
  formats: LayoutGrid,
  entrants: Users,
  players: UserCheck,
  registration: ClipboardList,
  scheduling: CalendarClock,
  scoring: Play,
  divisions: Trophy,
  sharing: Megaphone,
  directory: BookUser,
  billing: CreditCard,
  api: Webhook,
};

const blurbOf = (key: string) => HELP_SECTIONS.find((s) => s.key === key)?.blurb ?? "";
const pagesLabel = (n: number) => `${n} ${n === 1 ? "page" : "pages"}`;

// The help home (layout A, section 3): a heading, ONE search box with results as you type, then a card per
// section with its page count and its pages. Each card carries the section's key as its id, which is
// where an article's breadcrumb section link lands. Formats is a generated gallery, so its card links there.
export default function HelpIndexPage() {
  const nav = helpNav();
  return (
    <main>
      <h1 className="mk-display text-4xl font-bold text-purple-950 sm:text-5xl">How can we help?</h1>
      <p className="mt-3 max-w-2xl text-slate-600">
        How to run tournaments and leagues on Seazn Club, written for organisers. New here? Start with
        Getting started.
      </p>

      <div className="mt-6 max-w-2xl">
        <HelpSearch variant="hero" />
      </div>

      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {nav.map((section) => {
          const Icon = SECTION_ICONS[section.section] ?? LayoutGrid;
          return (
            <section
              key={section.section}
              id={section.section}
              aria-labelledby={`help-card-${section.section}`}
              className="min-w-0 scroll-mt-24 rounded-2xl border border-slate-200 p-5"
            >
              <div className="flex items-baseline justify-between gap-3">
                <h2 id={`help-card-${section.section}`} className="flex items-center gap-2 font-semibold text-slate-900">
                  <Icon aria-hidden className="h-4 w-4 shrink-0 text-purple-600" strokeWidth={1.75} />
                  {section.label}
                </h2>
                <span className="shrink-0 text-xs text-slate-500">{pagesLabel(section.articles.length)}</span>
              </div>
              <p className="mt-1.5 text-sm text-slate-600">{blurbOf(section.section)}</p>
              <ul className="mt-3 space-y-1 text-sm">
                {section.articles.map((a) => (
                  <li key={a.slug}>
                    <Link href={`/help/${a.slug}`} className="text-purple-800 underline-offset-2 hover:underline">
                      {a.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        <section
          id="formats"
          aria-labelledby="help-card-formats"
          className="min-w-0 scroll-mt-24 rounded-2xl border border-slate-200 p-5"
        >
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="help-card-formats" className="flex items-center gap-2 font-semibold text-slate-900">
              <LayoutGrid aria-hidden className="h-4 w-4 shrink-0 text-purple-600" strokeWidth={1.75} />
              Formats
            </h2>
            <span className="shrink-0 text-xs text-slate-500">{FORMAT_FAMILIES.length} formats</span>
          </div>
          <p className="mt-1.5 text-sm text-slate-600">{blurbOf("formats")}</p>
          <Link href="/help/formats" className="mt-3 inline-block text-sm font-medium text-purple-800 underline-offset-2 hover:underline">
            Open the format gallery
          </Link>
        </section>
      </div>

      <p className="mt-10 rounded-2xl bg-purple-50/60 p-5 text-sm text-slate-600">
        Can&apos;t find it? Email{" "}
        <a href="mailto:support@seazn.club" className="font-medium text-purple-700 underline">
          support@seazn.club
        </a>{" "}
        — real answers from the people who build this.
      </p>
    </main>
  );
}
