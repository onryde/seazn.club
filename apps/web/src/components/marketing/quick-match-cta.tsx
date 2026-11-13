// The marketing hero's door to a quick match (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5 step 1;
// plan 2 Task 9): one link to the setup screen beside the start-a-competition funnel, with no sign-in wall, and one line
// on what it is. Styled as the page's secondary action (the finale's second button: cream text on a #4a3885 outline), so
// the funnel's lime Start stays the hero's one primary.
//
// The href is locale-PREFIXED: only `/<lang>/play` resolves (proxy.ts rewrites an unprefixed marketing path only when it
// is listed), and the create route sends a refusal back to the same path (app/api/quick-match/route.ts).
import Link from "@/components/ui/console-link";
import { routes } from "@/lib/routes";

export function QuickMatchCta({ lang, label, hint }: { lang: string; label: string; hint: string }) {
  return (
    <div data-testid="qm-cta" className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
      <Link
        href={routes.quickMatchSetup(lang)}
        aria-describedby="qm-cta-hint"
        className="mk-display inline-flex min-h-11 shrink-0 items-center justify-center rounded-xl border border-[#4a3885] px-6 text-base font-semibold tracking-[0.02em] text-[var(--mk-cream)] transition hover:border-[var(--mk-lime)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--mk-lime)]"
      >
        {label}
      </Link>
      <p id="qm-cta-hint" className="min-w-0 text-sm text-[#b7aede]">
        {hint}
      </p>
    </div>
  );
}
