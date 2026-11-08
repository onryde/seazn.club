// Quick match (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §4 step 4, C12; plan 1 Task 9): the scoring
// pad's way back to its quick match's home. `/score/[token]` renders it beside `DeviceScorePad` only for a quick match's
// fixture (the page decides, server-side); the pad itself is untouched.
//
// A server component with no state: the page hands it the finished href and the label already in the viewer's language,
// so no token helper and no dictionary ever reach the browser for it.
//
// Placement (AGENTS.md "The phone composition"; scorepad v3 phone composition design §1): the page lays the link and the
// pad out as one flex column, link first. From md up the link sits ABOVE the pad, where a way back is looked for. Below
// md it goes LAST (`max-md:order-last`), under the pad: on a 568px-tall phone every pixel above the board is the
// scorer's first-tap headroom, and a way back is wanted after the match, not before each rally. One element, ordered by
// width; never a second phone copy.

/** The home link's href holds the home token, a capability: whoever holds it can score the match. PostHog autocapture
 *  records a clicked anchor's href and replay records the DOM, so the anchor carries `ph-no-capture` (pre-flight B9; the
 *  join-code precedent, components/registration-hub-registrant-join-code.tsx). The telemetry scrubber covers `/q/<token>`
 *  too (lib/scrub-score-url.ts `SECRET_PATH_ROUTES`), for the navigation the click starts. */
export function QuickMatchBackLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      data-testid="quick-match-back-link"
      className="ph-no-capture inline-flex min-h-11 items-center gap-1.5 self-start rounded text-sm font-medium text-court-muted underline-offset-4 transition hover:text-court-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-court-ink max-md:order-last"
    >
      {/* The arrow is decoration: the link's accessible name is the label alone. */}
      <span aria-hidden="true">←</span>
      {label}
    </a>
  );
}
