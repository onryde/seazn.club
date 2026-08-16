# RS006 — public stepper + cart (registration surface returns)

Paste this whole file as the session opener. Read `_RULES.md`, then `_INDEX.md`
(RS003's endpoint shapes), then this. **Biggest UI session of the programme**
— load `frontend-design:frontend-design` before any component work.

Branch `feat/rs006-public-stepper` in a fresh worktree. One PR.
Design: `../2026-08-16-registration-redesign-design.md` §4 — the five steps
are specified there; this prompt does not re-specify them, it binds them.

## Why

This PR turns public registration back ON. Everything RS001 deleted is
replaced by the stepper: multi-entry cart, eligibility-aware division picking,
per-player rosters, consent, one payment. It is the programme's public face —
mobile-first (a parent on a phone), full polish.

## Scope

New tree `apps/web/src/components/public-site/register/` (stepper chassis +
one component per step), replacing the closed-state stub inside
`.../register/page.tsx` with the live flow. Steps 1–5 exactly per design §4:

1. **WHO** — contact, "I'm playing" toggle, dob/gender only when needed.
2. **ENTRIES** — division cards with badges (category/age/fee/capacity/
   window), grey-with-reason for self-ineligible divisions (still pickable
   for team entries), cart with add/remove/duplicate-division support,
   free-agent option where allowed.
3. **DETAILS** — per entry: roster builder (port `parseRoster` from git
   history — typed AND pasted entry), per-player dob/gender only when the
   division requires, live per-player eligibility + the mixed-composition
   meter, custom form_fields renderer (port from history), partner for pairs.
4. **CONSENT** — privacy (required, versioned, **names-public-by-default
   copy** — owner ruling 5), media optional, guardian block for minor
   registrant, captain-roster notice.
5. **REVIEW→PAY** — line items, waitlist-flagged entries marked "not charged
   now", submit → RS003 endpoint → Stripe redirect when payable, else
   straight to status ref.

Chassis rules: client state machine, back-navigation preserves state, browser
refresh mid-flow survives (sessionStorage), step validation gates Next,
single-open-division competitions collapse step 2, deep-link `?join=` is
RS007 (leave the seam, render nothing for it yet). Honeypot field rendered.
Status page stays RS001's stub this session **except** the post-submit
redirect target must show the group ref + per-entry statuses minimally
(RS007 builds it out — keep this minimal version deliberately unstyled-simple
but correct).

## Acceptance criteria

- [ ] Playwright, prod build: full cart (Team A + Team B same division +
      self into another) → submit → DB rows correct → minimal status render
- [ ] Free path confirms instantly; paid path redirects to Stripe checkout
      and completes with a test card (full loop, webhook flips group)
- [ ] Mixed division: all-male roster blocked at step 3 with the meter
      explaining; fixed roster passes
- [ ] Underage player named by row in the error; ineligible-self division
      greyed at step 2 with reason, still accepts a team entry
- [ ] Waitlist: cart shows "not charged now" and subtotal excludes it
- [ ] Refresh at step 3 → state intact; back from step 5 → edits stick
- [ ] Single-division competition skips step 2
- [ ] Honeypot + rate-limit behavior verified once through the UI
- [ ] Every string ×4 locales (`register.*` namespace reclaimed; leftovers
      from RS001 cleaned); `i18n:check` green
- [ ] Screenshots 1280/768/**320** per step, no horizontal scroll; stepper in
      the `mobile.spec.ts` seven-width matrix
- [ ] Counts from JSON reporter; `tsc EXIT=0`; lint clean; drift gates clean

### Test types

- **Unit** — cart reducer/state machine, eligibility presentation mapping,
  roster parse (property: parse(serialize(x))=x).
- **E2E** — the loops above; the widths. **Smoke** — deferred RS010.
- **Regression** — single-entry division registers unchanged (cart of one);
  subtotal-excludes-waitlist.

## Gotchas

- **320px first.** The cart, the roster table and the stepper nav are the
  three overflow risks; grid `min-width:auto` trap applies.
- RSC serializes an omitted prop as `"$undefined"` — anchor e2e assertions on
  `="` (repo standing trap).
- `/magic-link` never hydrates on dev — no login needed here (public), but
  the prod-build recipe still applies; `standalone` output means `next start`
  serves the WRONG server.
- Stripe test loop: owner-sanctioned live-mode local testing exists for
  billing, but registration uses TEST mode here; never print keys.
- The eligibility copy must come from the same rule evaluation RS002 ships —
  do not re-implement rules client-side beyond presentation (fork = drift).
  Client pre-checks are UX; the server verdict is truth.
- Session budget: if step 3's builder runs long, cut scope at the seam RS007
  owns (status page) — never at test types.

## Execution

Scout: RS003 response shapes (from `_INDEX.md`), old `parseRoster` +
form-fields renderer via git history, sessionStorage precedent in repo,
public-page layout/theming conventions. One implementer loop, steps in order
(chassis → 1 → 2 → 3 → 4 → 5); reviewer after chassis+1–2 and again at end
(two review rounds — the session is big). Reviewer focus: state-machine
holes (skip-ahead via URL), client/server eligibility fork, i18n gaps,
320px overflow.

## On close

`_INDEX.md`: RS006 → DONE + PR#, **public registration LIVE again** noted,
the stepper component contract (props/state shape) RS007 extends, any scope
cut. Memory + snapshot.
