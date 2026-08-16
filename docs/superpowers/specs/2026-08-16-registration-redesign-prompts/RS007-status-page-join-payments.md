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
- [ ] ×4 locales; screenshots 1280/768/320; both surfaces in seven-width
      matrix
- [ ] Counts from JSON reporter; `tsc EXIT=0`; lint clean; drift gates clean

### Test types

- **Unit** — promotion-lapse logic, join eligibility reuse, token authz.
- **E2E** — the three loops above. **Smoke** — deferred RS010.
- **Regression** — join respects roster cap; token authz; lapse returns
  the slot.

## Gotchas

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
