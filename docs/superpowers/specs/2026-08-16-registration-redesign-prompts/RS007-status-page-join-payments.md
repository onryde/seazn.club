# RS007 — group status page, join flow, pay-on-promotion

Paste this whole file as the session opener. Read `_RULES.md`, then `_INDEX.md`
(RS006's stepper contract), then this. Public UI session — load
`frontend-design:frontend-design`; payment work loads `stripe:*`.

Branch `feat/rs007-status-join-payments` in a fresh worktree. One PR.
Design: `../2026-08-16-registration-redesign-design.md` §4 ("After submit" +
join flow + step-5 payment semantics).

## Why

RS006 shipped the entry path; this session ships everything that happens
AFTER: the group's home page (status/manage), the player-side join flow that
closes the consent gap for captain-entered rosters, and the money edge cases
(waitlist promotion payment, expiry).

## Scope

1. **Group status page** — rebuild `.../register/status` from RS006's minimal
   render into the real surface (authorized by ref + access token link, as
   the old page was): per-entry status timeline, roster fill meter with
   per-player consent chips, captain's copy-join-link, cancel entry (with
   confirm; calls RS002 withdraw), payment state incl. "pay now" for
   promoted-from-waitlist entries, resend-confirmation. This page is the link
   in every registration email.
2. **Join flow** — `?join=<CODE>` on the register route: context header
   ("Joining Team A · Mens Open"), steps WHO + CONSENT only (reuse RS006 step
   components — the seam it left), per-player eligibility from the division,
   guardian path for minor joiners (consent_status=`guardian`), full-roster
   and dead-code errors as designed empty-states, success → mini
   confirmation with the team's fill meter. Joining sets
   `consent_status='granted'` — this IS the consent moment (owner ruling 4);
   copy must say the name-public default plainly here too.
3. **Pay-on-promotion** — promotion (RS002/RS005) already flags the state;
   this session ships the registrant-facing path: email link → status page →
   "pay now" → Stripe checkout for that entry → webhook confirms; expiry
   (`expires_at`) lapses the promotion back to waitlist-tail (verify RS002
   shipped the lapse; if not, build it here and note the premise false).
4. **Emails**: confirmation (group summary + status link), join invite is NOT
   an email (captain shares the link) — but promotion + payment-due emails
   are; extend whatever mailer RS005 settled on.

## Acceptance criteria

- [ ] Playwright: captain registers team (RS006 flow) → copies join link →
      second browser context joins as player → status page roster meter
      +1, consent chip granted; third context joins as minor → guardian path
- [ ] Full roster → join page shows the designed error, no row inserted
- [ ] Cancel entry from status page → withdrawn everywhere (hub row too)
- [ ] Waitlist promotion e2e: promote in hub → email/state → pay with test
      card → confirmed; let `expires_at` lapse (clock-controlled test) →
      back to waitlist, slot re-offered
- [ ] Status page authz: wrong token → 404-shape, no data leak; ref alone
      insufficient
- [ ] The pair/`join_code` decision above is recorded in `_INDEX.md` with its
      reasoning — including, if pairs stay out, the copy change that stops
      `register.consent.rosterNotice` promising a join that cannot happen
- [ ] An entry with money owed renders how to pay it: "pay now" for card,
      the resolved `paymentInstructions` for offline — no state that states
      a debt and offers nothing
- [ ] Reconcile-on-load closes the missed-webhook window on the page the
      paid flow actually returns to: with the webhook suppressed, a visit to
      `…/register/status?…&session_id=…` reads as paid on first view
- [ ] ×4 locales; screenshots 1280/768/320; both surfaces in seven-width
      matrix
- [ ] Counts from JSON reporter; `tsc EXIT=0`; lint clean; drift gates clean

### Test types

- **Unit** — promotion-lapse logic, join eligibility reuse, token authz.
- **E2E** — the three loops above. **Smoke** — deferred RS010.
- **Regression** — join respects roster cap; token authz; lapse returns
  the slot.

## Found while using the shipped RS006 flow (2026-08-27)

Three things surfaced by driving the merged stepper through a real Stripe
Connect payment (`apps/web/e2e/registration-connect-walkthrough.spec.ts`).
The first CHANGES THIS WAVE'S SCOPE; read it before estimating.

- **A `pair` entry never gets a `join_code`, so doubles has no join path.**
  Minting is gated on `entrant_kind === "team"`
  (`registration-submit.ts`, the non-free-agent team branch), and
  `joinTeamEntry` resolves solely by `join_code`. Scope item 2 as written
  ("player-side join flow that closes the consent gap for captain-entered
  rosters") therefore closes it for TEAMS and leaves DOUBLES open — the
  partner stays a name on someone else's roster who never confirms their
  own details or consent. That is the same gap this wave exists to close,
  and RS006 already promises otherwise in copy
  (`register.consent.rosterNotice`: "We'll ask each of them to confirm
  their own details and consent when they join or claim their spot").
  Decide explicitly: widen minting to pairs, or state in the spec that
  doubles partners are out of scope and stop the copy promising it.
  Widening is not free — `join_code` is a capability token with a partial
  unique index (V364) and a collision-retry loop; a pair's roster is fixed
  at exactly two (`registration-submit.ts` 422s otherwise), so "join" there
  means CLAIMING a named row, not growing a roster.

- **The missed-webhook fallback is on the wrong page — it exists, and the
  paid flow never reaches it.** `reconcileRegistrationBySession`
  (`registrations.ts:2522`) is wired into `/r/[ref]` and covered by that
  page's tests. But `createRegistrationCheckout`'s `returnBase` takes the
  TOKEN branch whenever a token exists — which a cart submit always has —
  so a paying registrant returns to
  `/shared/<org>/<comp>/register/status?rid=…&token=…&checkout=success&session_id=…`,
  and `status/page.tsx` contains no reference to `reconcile`, `session_id`
  or `checkout` at all. Stripe appends that `session_id` specifically for
  this page to consume and the page drops it on the floor. Verified by
  paying a real destination charge: the redirect lands on the status page,
  not `/r/<ref>`.

  So the fix is a wiring job, not new plumbing: call the existing usecase
  from the status page as `/r/[ref]` already does. It pays off three
  times — production self-heals inside the webhook retry window, the local
  walkthrough stops needing `stripe listen`, and a genuinely end-to-end
  paid test becomes possible in CI. Keep the webhook primary regardless:
  async payment methods settle days later and a registrant may never
  revisit the page.

- **An unpaid entry shows its debt and no way to settle it.** Verified on
  a real submit: the page renders "pending £25" with no payment
  instructions and no pay control. For the offline/`payment_method` case
  the data is already resolved server-side — `registrations.ts` builds
  `paymentInstructions` (per-division override falling back to
  `org.payment_instructions`) for the emails — so this is a rendering gap
  on the page this wave rebuilds, not new plumbing.

## Gotchas

- **`/r/[ref]` and its `ticket.png` sibling are on the closed state and are
  yours to restore.** RS001 verified they DO read registrations
  (`publicRegistrationStatusByRef` + `reconcileRegistrationBySession`) and
  `ref_code` moved to `registration_groups` — so the ref they resolve is now a
  CART ref, and the page becomes a cart status page (design §4 "After submit").
- **Refunds are cart-level until someone fixes them.** RS002 owns the decision
  (see its "Entry conditions" section); if it has not landed by the time you
  wire cancel-an-entry, do not ship an entry-level cancel that calls a
  cart-level refund — it would claw back a sibling entry's money.
- Two browser contexts in one Playwright test share nothing — correct here;
  but the seven-width projects race over ONE org: tag data per project.
- Clock control: no `Date.now` freezing on the server — drive expiry via a
  short `expires_at` written by the test, not by mocking time in prod code.
- Email in tests: assert through whatever capture the repo's existing mailer
  tests use; never send real mail from the suite.
- The join link is a capability token — treat `join_code` like a secret in
  logs (structured logging must not print it raw).

## Execution

Scout: RS006 seam + step component exports, mailer harness, webhook shape
from RS003. One implementer loop (status page → join → promotion-pay);
reviewer focus: authz, consent-state transitions, promotion race
(promote-vs-lapse), copy honesty on the consent moment.

## On close

`_INDEX.md`: RS007 → DONE + PR#, the consent-moment copy as shipped (RS008
reuses it), lapse premise verdict. Memory + snapshot.
