# RS010 — closeout: smoke, e2e debt, help, demo, audit

Paste this whole file as the session opener. Read `_RULES.md`, then the WHOLE
`_INDEX.md` — this session's job is to discharge every debt the other nine
recorded. Sweep session; scope below is the floor, the index is the truth.

Branch `feat/rs010-registration-closeout` in a fresh worktree. One PR.

## Why

Programme debts concentrate here by design: smoke was deferred by every
session, RS001 deleted tests whose replacements must be proven complete, help
pages and the demo have never heard of the new registration, and nobody has
yet audited the whole thing as one flow.

## Scope

1. **Smoke** (`scripts/smoke.ts`): registration suite — group submit (free +
   paid-mocked path per smoke's existing Stripe convention), join, approve,
   promote, assign, opt-out resolver — through real HTTP against the smoke
   server. Restore/replace every smoke section RS001's PR body lists as
   deleted.
2. **E2E debt roll-call**: table in the PR body — every deferral recorded in
   `_INDEX.md` (RS001's deleted-test list included) → discharged (test
   file:line) or re-argued with cause. The seven-width matrix must cover:
   stepper (all steps), status page, join, hub both tabs. Add what's missing.
3. **Help pages** (`content/help/**`, English only): organiser guide
   (settings, approval, waitlist, free agents, CSV) + registrant guide
   (cart, join links, consent/opt-out, payment). Screenshots current.
4. **Demo** (`seed:demo` + demo accounts): a demo competition with open
   registration, a part-filled team with a join code, a waitlist, a manual
   division — so the owner can tour the feature. Remember: seeded demo data
   reds unrelated sweep suites — keep demo seeding out of the test DB path.
5. **Cross-flow audit** (the "one flow" pass nobody ran): one Playwright
   scenario — configure (hub) → register cart (public) → join (second
   context) → approve + promote + assign (hub) → opt-out (claim) → verify
   standings initials + entrants tab + CSV agree with each other. This is the
   contradiction-finder; a rendered page shows what unit tests cannot.
6. **Axe pass** over stepper + hub + status page (scope INCLUDES the header —
   the repo has shipped a false-clean axe scope before); fix AA contrast
   fails.
7. **i18n audit**: `i18n:check` + a sweep for hardcoded English across the
   new trees; `content/help/**` exempt.
8. **`_INDEX.md` final**: every row DONE, rulings log complete, programme
   marked closed; design doc gets a completion note.

## Acceptance criteria

- [ ] Smoke counts (before/after) pasted; new sections listed
- [ ] Debt table complete — zero silent drops
- [ ] Cross-flow audit passes; any contradiction found is FIXED this session
      (owner rule: no new issues)
- [ ] Axe: 0 serious/critical on the three surfaces, scope proven to include
      chrome
- [ ] Help renders; demo tour works from a fresh `seed:demo`
- [ ] Full web suite + engine suite green (JSON counts), `tsc EXIT=0`, lint
      clean, drift gates clean

### Test types

This session IS types 2–3 for the programme; 1 and 4 as needed by fixes.

## Gotchas

- Local smoke SKIPS the AI section without `SCHEDULING_AI_BASE_URL` — expect
  a count delta vs CI; judge the REGISTRATION sections, note the delta.
- Squatted :3100 = all three e2e projects fail; port-ownership check needs
  `-sTCP:LISTEN`.
- The cross-flow scenario spans auth modes and contexts — TAG is per
  process; seed its own org.
- Demo data + sweep suites share nothing: fresh DB for the gate rerun.

## Execution

Scout: full `_INDEX.md` debt extraction into the roll-call table (do this
FIRST — it is the session's work order). Then sequential: smoke → e2e debt →
cross-flow → axe/i18n → help/demo. Reviewer on the cross-flow scenario and
the debt table honesty.

## On close

`_INDEX.md`: RS010 → DONE + PR#, programme CLOSED, follow-ups (if the owner
parks any) listed under a parked lane. Memory: programme memory updated to
closed + snapshot.
