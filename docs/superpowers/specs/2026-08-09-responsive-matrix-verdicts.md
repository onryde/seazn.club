# Responsive matrix — tablet verdicts (#349 Task 4)

Eyeball pass over every `mobile.spec.ts` route-array surface + the publish-gate
sheet + the z3 schedule board + `/admin`, screenshotted at 768×1024 and
834×1194 (`e2e/.auth/pro.json`, one throwaway Playwright script, not
committed). Screenshots: `/tmp/349/tablet/<slug>-{768,834}.png`. The
`frontend-design` skill was loaded before making any verdict, per the
controller ruling on this task.

**Method note:** 768 and 834 render byte-for-byte identical layouts on every
surface below — both widths sit inside Tailwind's default `[768,1024)` band
(`md:` on, `lg:` off), and nothing in this codebase forks on a custom
breakpoint inside that range (the schedule board's own JS fork is at 640px,
below both). So each row's verdict holds at both widths; only one screenshot
pair is referenced per row for brevity.

**Touch-target defect fixed in this task, not tabulated below:** the z3
schedule board's `schedule-auto`/`schedule-reflow`/`schedule-polish` buttons
dropped to 28px past the `sm` breakpoint (`sm:min-h-0` in
`apps/web/src/components/v2/schedule-board.tsx`). Per controller ruling this
is a width-INDEPENDENT invariant (44px touch targets at every width), so it
was fixed directly in this task (removed `sm:min-h-0` from all three
buttons), not deferred to Task 5/6. See task-4-report.md for the fix,
rebuild/restart, and green re-run evidence.

**Result: 39 OK / 1 D / 0 P.** This was not assumed going in; the brief's
named "known suspects" (org settings sidebar, marketing nav, console shell,
schedule board) were screenshotted and inspected like everything else. Three
of the four held up clean: full desktop nav at both widths (no
hamburger-next-to-links half-collapse), no sidebar/content collisions. The
fourth — the schedule board — is the one D row below: its action toolbar
breaks into 2 rows at both tablet widths, isolating the "Freeze schedule"
button behind a stretched `flex-1` spacer gap (see the schedule board row for
file:line detail). Task 5 has exactly one row to implement from this table
(the schedule board); Task 6 has zero. The rest of the app's shell and
console pages already commit to a `md:` (768px) desktop layout with no
half-measures.

**One pre-existing, out-of-scope defect found while building the screenshot
fixtures:** `mobile.spec.ts`'s "console routes: no horizontal scroll" test
navigates `/competitions/{id}`, `/competitions/{id}/settings`,
`/divisions/{id}`, `/divisions/{id}?tab=fixtures`,
`/divisions/{id}?tab=standings` and `/divisions/{id}/registrations` — all
dead (404) routes. No
`src/app/competitions/[id]` or `src/app/divisions/[id]` page exists; the
console moved to the `/o/{org}/c/{comp}/d/{div}` slug chain before this
wave. The test still passes because a 404 page has no horizontal overflow —
vacuous, not a real width check, at every width it runs at (not tablet-
specific). Out of scope to fix here (unrelated to the width-branch work, and
touching it risks the already-green phone gates); the four screenshots below
against those conceptual surfaces were taken against the real canonical
addresses instead so the verdict reflects the actual page. Flagged for the
owner / a future task, not corrected in `mobile.spec.ts`.

## Verdicts

| surface | route | verdict (D/P) | rationale (1 line) | files to touch | screenshots |
|---|---|---|---|---|---|
| console dashboard / competitions list | `/dashboard` | OK | 2-col card grid, full desktop nav on one line, no collisions | — | `console-dashboard-{768,834}.png` |
| competition overview | `/o/{org}/c/{comp}` | OK | action row + division cards fit cleanly, no wrap | — | `console-competition-{768,834}.png` |
| competition settings | `/o/{org}/c/{comp}/settings` | OK | visibility/branding form reads well at this width | — | `console-competition-settings-{768,834}.png` |
| division overview (entrants tab) | `/o/{org}/c/{comp}/d/{div}` | OK | tabs + action buttons + entrant table all fit, no cramping | — | `console-division-{768,834}.png` |
| division fixtures tab | `/o/{org}/c/{comp}/d/{div}?tab=fixtures` | OK | same shell as division overview, holds | — | `console-division-fixtures-{768,834}.png` |
| division standings tab | `/o/{org}/c/{comp}/d/{div}?tab=standings` | OK | same shell, holds | — | `console-division-standings-{768,834}.png` |
| division registrations (closest real equivalent: settings tab) | `/o/{org}/c/{comp}/d/{div}?tab=settings` | OK | accordion sections stack cleanly, no overlap | — | `console-division-registrations-{768,834}.png` |
| org settings — organisation (named suspect) | `/settings?tab=organization` | OK | sidebar (190px) + content two-column layout, generous gap, no overlap | — | `console-settings-organization-{768,834}.png` |
| org settings — news | `/settings?tab=news` | OK | list + CTA fit inside the settings content column | — | `console-settings-news-{768,834}.png` |
| org settings — sponsors | `/settings?tab=sponsors` | OK | two stacked forms fit without crowding | — | `console-settings-sponsors-{768,834}.png` |
| org settings — team | `/settings?tab=team` | OK | member row + invite forms fit on one column comfortably | — | `console-settings-team-{768,834}.png` |
| org settings — API | `/settings?tab=api` | OK | key-creation form + capability cards fit in one row | — | `console-settings-api-{768,834}.png` |
| org settings — account | `/settings?tab=account` | OK | stacked profile/preference cards, no overlap | — | `console-settings-account-{768,834}.png` |
| org settings — billing | `/settings/billing` | OK | plan + usage cards fit, no crowding | — | `console-settings-billing-{768,834}.png` |
| Event Pass upgrade page | `/o/{org}/c/{comp}/upgrade` | OK | pass card + comparison table both fit without collision | — | `console-upgrade-{768,834}.png` |
| directory (players/clubs/officials) | `/directory` | OK | dedupe panel + add-player form + table fit in one column | — | `console-directory-{768,834}.png` |
| bulk import | `/import` | OK | single-purpose upload card, no layout issue | — | `console-import-{768,834}.png` |
| my matches (scorer) | `/my-matches` | OK | minimal shell, empty-state card fits | — | `console-my-matches-{768,834}.png` |
| marketing home (nav-flip suspect) | `/` | OK | full desktop nav (Formats/Scheduling/Pricing/Use cases/Log In/Start free) renders on one line — no hamburger-next-to-links half-collapse | — | `public-home-{768,834}.png` |
| pricing | `/pricing` | OK | plan cards + comparison table fit; wide table scrolls in its own container by design | — | `public-pricing-{768,834}.png` |
| public org hub | `/shared/{org}` | OK | hero + news + competitions list fit, no overlap | — | `public-org-{768,834}.png` |
| public competition page | `/shared/{org}/{comp}` | OK | hero + divisions list fit | — | `public-competition-{768,834}.png` |
| public registration | `/shared/{org}/{comp}/register` | OK | progress bar + form fit in one column, no crowding | — | `public-register-{768,834}.png` |
| public news feed | `/shared/{org}/news` | OK | 2-col card grid, no overlap | — | `news-feed-{768,834}.png` |
| public news post | `/shared/{org}/news/{slug}` | OK | article + share buttons fit | — | `news-post-{768,834}.png` |
| publish-gate confirm sheet | `/o/{org}/c/{comp}/d/{div}/schedule?tab=board` (dialog open) | OK | renders as a centered modal (not the phone bottom sheet) at this width, conflict list and Cancel/Publish anyway both fit without clipping | — | `publish-gate-sheet-{768,834}.png` |
| z3 schedule board (schedule-board.tsx:347 JS fork; named suspect) | `/o/{org}/c/{comp}/d/{div}/schedule?tab=board` | D | action toolbar (`flex flex-wrap` container, schedule-board.tsx:901) breaks into 2 rows, isolating the "Freeze schedule" button behind a stretched `flex-1` spacer gap (schedule-board.tsx:980) | `apps/web/src/components/v2/schedule-board.tsx` (toolbar container ~:901 + spacer ~:980) | `schedule-board-{768,834}.png` |
| admin dashboard | `/admin` | OK (functional bar) | staff nav overflows into its own `overflow-x-auto` container (by design, same pattern as the pricing table) — not clipped/broken, reachable via scroll | — | `admin-home-{768,834}.png` |
| admin AI runs | `/admin/ai-runs` | OK (functional bar) | table renders, empty state clean | — | `admin-ai-runs-{768,834}.png` |
| admin audit log | `/admin/audit` | OK (functional bar) | hash-chain banner + table render fully | — | `admin-audit-{768,834}.png` |
| admin billing events (Stripe) | `/admin/billing-events` | OK (functional bar) | wide event table renders, functional | — | `admin-billing-events-{768,834}.png` |
| admin coupons | `/admin/coupons` | OK (functional bar) | create form + table fit | — | `admin-coupons-{768,834}.png` |
| admin entitlements | `/admin/entitlements` | OK (functional bar) | large matrix renders (own scroll), functional | — | `admin-entitlements-{768,834}.png` |
| admin fixture config snapshot | `/admin/fixtures` | OK (functional bar) | lookup form renders cleanly | — | `admin-fixtures-{768,834}.png` |
| admin impersonate | `/admin/impersonate` | OK (functional bar) | same dashboard shell, functional | — | `admin-impersonate-{768,834}.png` |
| admin orgs | `/admin/orgs` | OK (functional bar) | org table renders fully, functional | — | `admin-orgs-{768,834}.png` |
| admin pass-credit reversals | `/admin/pass-credit-reversals` | OK (functional bar) | same shell/table pattern as sibling admin pages | — | `admin-pass-credit-reversals-{768,834}.png` |
| admin revenue | `/admin/revenue` | OK (functional bar) | stat cards + by-month/by-org tables render fully | — | `admin-revenue-{768,834}.png` |
| admin settings | `/admin/settings` | OK (functional bar) | single settings card, functional | — | `admin-settings-{768,834}.png` |
| admin users | `/admin/users` | OK (functional bar) | long user table renders fully, functional | — | `admin-users-{768,834}.png` |

## Counts

- OK: 39
- D: 1
- P: 0

Task 5 has exactly one row to implement from this table (the z3 schedule
board — toolbar wrap break, see row above); Task 6 has zero.
