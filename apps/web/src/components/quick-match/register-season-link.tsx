// /play's quiet door to a season (owner 2026-11-13, quick-match-decision-log.md: "Or register to start a season"; start
// wizard plan 2026-11-13 Task 5): a link from the quick match setup to the organiser's /start wizard, carrying the sport
// the chips have chosen so the wizard opens on it.
//
// Where it sits: the setup form mounts it after its Start zone, as the form's last child. Below 640px the Start bar docks
// to the screen's foot inside the form and must not grow, so the door is never in the bar: it is in the form's flow under
// the bar's resting place, met once the guest scrolls to the end. From 768px the zone is a column and the door follows it.
//
// The href is `/<lang>/start?sport=<key>` for a sport /start takes (`funnelSportByKeyOrName`, the list /start's parser
// reads, start/prefill.ts), else the plain `/<lang>/start`: a link never sends what its reader would drop. Before the
// script runs the other chips are disabled (setup-form.tsx, I1), so the server's sport is the only one a guest can have
// and its link is right without the script. No hooks and no directive: it renders inside the setup island.
import Link from "@/components/ui/console-link";
import { funnelSportByKeyOrName } from "@/lib/funnel-sports";

/** `/<lang>/start`, with `?sport=<key>` when /start lists the sport (by key or name, sent as its key). */
export function startHrefForSport(lang: string, sportKey: string | null | undefined): string {
  const sport = typeof sportKey === "string" ? funnelSportByKeyOrName(sportKey) : null;
  return sport === null ? `/${lang}/start` : `/${lang}/start?${new URLSearchParams({ sport: sport.key })}`;
}

export function RegisterSeasonLink({ lang, sportKey, label }: { lang: string; sportKey: string; label: string }) {
  return (
    <div className="mt-3 flex justify-center">
      {/* The hero's organiser door's quiet face (app/[lang]/(marketing)/page.tsx): lavender words, an underline that
          turns lime under the pointer, a 44px tap floor. Balanced lines where it wraps (fr/nl at 320), so the arrow never
          sits alone on a line. /start is dynamic with no loading boundary, so no prefetch. */}
      <Link
        href={startHrefForSport(lang, sportKey)}
        data-testid="qm-register-season"
        className="inline-flex min-h-11 min-w-0 max-w-full items-center text-balance px-1 text-center text-sm text-[#b7aede] underline decoration-[#4a3885] underline-offset-4 transition hover:text-[var(--mk-cream)] hover:decoration-[var(--mk-lime)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--mk-lime)]"
      >
        {label}
      </Link>
    </div>
  );
}
