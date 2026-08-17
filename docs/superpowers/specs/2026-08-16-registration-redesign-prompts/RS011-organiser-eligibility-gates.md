# RS011 — organiser-side eligibility gates: shared guard, 7 gate points, audited override

Paste this whole file as the session opener. Read `_RULES.md`, then `_INDEX.md`
(RS002's verdicts especially), then this. Server + UI session.

Branch `feat/rs011-organiser-eligibility-gates` in a fresh worktree. One PR.
Issue **#412** (originally the scoringpad-v2 programme's `L1`; re-homed here
2026-08-17 — see "Provenance" below).
Design: `../2026-08-16-registration-redesign-design.md` (eligibility, owner
ruling 3) + `../2026-08-03-scoringpad-v2-design.md` Part I, WS1. Closes #407 WS1.

**Depends on RS002** (the evaluator). File-disjoint from RS004–RS009, so it may
run alongside either lane — but it writes `api-v1/schemas.ts`, which `L2`
(date hardening, #413) also writes, so those two are **sequential**, never
parallel. Run before RS010 closeout.

## Provenance — read before trusting any line number below

This prompt is the surviving half of `L1-412-w1-eligibility.md`
(`../2026-08-06-scoringpad-v2-prompts/`). That brief was written 2026-08-06
against a registration model that **no longer exists**. The registration-path
half of it — the shared evaluator, dob/gender on player input, the
confirm/waive/mark-paid gates, the team `players[]` dob check, the confirm-panel
UI — is **owned by RS002/RS003/RS005 and is NOT in this session's scope.**
What is left is the organiser side, which the RS programme never touched.

Three premises of the old brief are already false on `main`:

1. **Eligibility is no longer jsonb-only.** RS001 shipped first-class
   `divisions.category` / `age_min` / `age_max`
   (`db/migration/deltas/V364__registrations_regroup.sql:110-116`).
   `divisions.eligibility` jsonb survives for custom extra rules. The old brief's
   plan to *replace* the untyped eligibility arrays with a typed
   `AgeRuleS`/`GenderRuleS`/`OtherRuleS` union therefore covers only half the
   model — the typed union is still worth having for the jsonb remainder, but it
   is **additive to** the first-class columns, never a substitute.
2. **The registration envelope moved.** dob/gender/guardian left `registrations`
   for `registration_players` (V363/V364). Any gate that reads a registrant's dob
   from the old place is reading a dropped column.
3. **Every line reference in the old brief predates #402, #404, RS001 and
   RS001b.** Scout re-pins all of them first. A moved gate point is a finding,
   not a footnote.

## Entry conditions — check these in the first 10 minutes

- **RS002 merged.** If not, stop.
- **What shape did RS002 leave `eligibilityIssues()` in?** On `main` today it is
  `eligibilityIssues(rules, {dob, gender}, seasonStartYear) → string[]`
  (`server/usecases/registrations.ts:177-181`) — **human sentences, no codes**.
  This session needs machine codes to fill `extra.violations[]` and to let the
  dialog list offenders. Two cases:
  - RS002 already returns structured issues → consume them, change nothing.
  - RS002 still returns `string[]` → **changing that return shape is in scope
    here**, including adapting RS002's own call sites. It is a handover gap, not
    a blocker, and not a new issue. Record it in the PR body under
    `Unplanned fixes`.
- **Is `rosterIssues(division, players[])` (RS002 scope item 2) exported and
  reusable against a person row rather than a `registration_players` row?** The
  organiser gates hold `persons`, not registration players. If it is welded to
  the registration shape, extract the pure core rather than writing a second
  evaluator — **two eligibility evaluators is the exact failure this re-homing
  exists to prevent.**

## Why

Divisions declare eligibility, and **only the public registration path enforces
it**. Every organiser-side path accepts an ineligible person silently, and the
UI claims otherwise (`components/v2/entrants-panel.tsx:224` — re-pin).

Deferred on purpose once (`design/v1/DEFERRED.md:82-84`); #407 and the RS design
both close it now: **block, with an audited override-with-reason.**

## Scope

1. **New `server/usecases/eligibility.ts`** (+ `usecases/audit.ts`): move
   `ageAt` / `isMinor` / `requiresDob` / the rule types out of
   `registrations.ts` (re-export for compat; `registrations.ts` imports
   `eligibility.ts`, **never** the reverse). Home the RS002 evaluator here too if
   RS002 left it inside `registrations.ts` — one module owns eligibility.
   - `evaluateEligibility(division, {dob, gender}, seasonStartYear) → {violations, warnings}`
     reading **first-class columns + jsonb rules**. Violation codes
     `AGE_TOO_OLD | AGE_TOO_YOUNG | GENDER_NOT_ALLOWED | CATEGORY_MISMATCH`;
     warnings `MISSING_DOB | MISSING_GENDER`; unknown jsonb rule kinds skipped
     leniently.
   - `gateRosterEligibility(tx, {divisionId, personIds, context, override, actorId}) → warnings[]`
     — without an override, throws
     `HttpError(422, msg, "ELIGIBILITY_VIOLATION", {violations, warnings})`;
     with `override.reason`, writes **one** `competition_events` row of type
     `eligibility.overridden` (via `audit.ts`, moved from `registrations.ts:313`
     — re-pin) naming actor + reason, then proceeds.
2. **Zod (`server/api-v1/schemas.ts`)**: typed `AgeRuleS` / `GenderRuleS` /
   `OtherRuleS` union replacing the untyped eligibility arrays on
   CreateDivision / PatchDivision (**write-time only**, and additive to the
   first-class `category`/`age_min`/`age_max` fields RS001 added — do not
   re-model those here). Optional `EligibilityOverride {reason: 3..500}` on
   CreateEntrant / PatchEntrant / PutLineup / roster-sync bodies.
   `NewPersonMemberInput` gains optional `dob`/`gender`, threaded through
   `resolveInlineMembers`.
   **Do not touch `PutRegistrationSettings`** — `L2` (#413) owns its date
   refines; RS001b owns its currency shape.
3. **Gate wiring — 7 points** (re-pin every one):
   - `createEntrants` (`entrants.ts:208`) after final roster resolution — covers
     copy_roster + squad seed
   - `insertMembers` (`entrants.ts:155`)
   - `patchEntrant` (`entrants.ts:380`)
   - `syncEntrantRosterFromSquad` (`entrants.ts:410`)
   - `setTeamSquad` (`teams.ts:208`) — **warnings only**, division-agnostic,
     evaluated per enrolled division
   - imports (`imports.ts:297`) — `planImport` emits error/warning issues,
     `commitImport` accepts one override and audits **once**
   - `putLineup` (`fixtures.ts:80`) — catches pre-feature rosters
4. **UI**: new `components/v2/eligibility-override-dialog.tsx` — on
   `ELIGIBILITY_VIOLATION`, list the violations, take a reason, retry with the
   override. Wire into `entrants-panel.tsx`; amber warning chips for `MISSING_*`;
   the `:224` banner claim finally becomes true.
5. Delete `design/v1/DEFERRED.md:82-84`.

**Explicitly NOT in scope** (RS002/RS003/RS005 own them; touching them here is a
merge conflict, not thoroughness): registration group submit, the
confirm/waive/mark-paid gates, `materialise`, per-player registration
validation, the mixed-composition rule as a *registration* check, the
registrations confirm panel, and the public submit path's stricter
missing-data behaviour. The Stripe-webhook materialise path stays **ungated** —
payment is already taken.

No migration: rules stay in `divisions.eligibility` jsonb + the RS001 columns,
audit reuses `competition_events`. (Greenfield rules allow a column if the jsonb
turns out to be the wrong shape — if you conclude that, say so and ask before
adding one.)

## Acceptance criteria

- [ ] All 7 gate points reject an over-age / wrong-gender / wrong-category person
      with 422 code `ELIGIBILITY_VIOLATION` — assert the **code**, never a bare
      `{status: 422}`
- [ ] The same request with `override.reason` succeeds and writes **exactly one**
      `eligibility.overridden` audit row naming actor and reason (one per
      request, not one per person)
- [ ] Missing dob/gender on organiser paths is an amber warning, never a block
- [ ] `setTeamSquad` never hard-blocks (warnings only)
- [ ] **Exactly one** eligibility evaluator exists repo-wide — grep proves the
      registration path and the organiser path call the same function
- [ ] First-class `category`/`age_min`/`age_max` **and** jsonb rules both
      enforced at every gate; a division carrying only jsonb and a division
      carrying only columns each block correctly
- [ ] Stripe-webhook materialise path unchanged — regression test
- [ ] `npm run openapi:gen` run and `openapi/*.json` committed (schemas changed);
      `i18n:gen-keys`; then `git status --porcelain` **empty**
- [ ] i18n: new keys in all 4 dictionaries, `i18n:check` green
- [ ] Dialog screenshots at desktop **1280**, **768** and **320**, no horizontal
      scroll at any, touch-sized targets
- [ ] Vitest counts from the JSON reporter with paths confirmed in
      `.testResults[].name`

### Test types (all four, per standing policy)

- **Unit** — `eligibility.test.ts`: cutoff boundaries, gender rules, category
  semantics, first-class-vs-jsonb precedence, missing-data warnings, lenient
  parse of unknown jsonb rule kinds.
- **DB integration** — `entrants-eligibility.test.ts`: 422 with code, override
  path, audit row count, warning paths, patch / sync / squad-seed; extend the
  team-squad and imports suites; a lineup-gate test.
- **E2E (Playwright)** — over-age roster add → dialog appears → blocked without a
  reason → succeeds with one. Desktop + 320 + 768.
- **Smoke** — extend `scripts/smoke.ts` so an organiser path exercises a gate
  (pro and free).
- **Regression** — Stripe-webhook path stays ungated; the `:224` banner claim is
  now true; RS002's registration-path eligibility tests still green after the
  evaluator moves module.

## Gotchas

- `HttpError` assertions must pin the error **code** — a bare 422 is satisfied by
  every other guard on the path.
- Roster persons often have null dob/gender (inline input captures `full_name`
  only). That is the warning state, not a bug.
- `entrants-panel.tsx` strings feed e2e assertions — `git grep -a` new and
  changed text across both e2e phases before merge.
- Persons identity index is scoped to `lane='player'`; officials mint
  unconditionally and cannot dedupe (#404's merge tool rewrote parts of that
  model).
- Moving `ageAt`/`isMinor`/`requiresDob` out of `registrations.ts` breaks callers
  that `tsc` will catch, and **tests that import them by path, which it will
  not** — grep the test tree too.
- Follow `seazn-local-env`: a fresh schema needs `db:apply` **and**
  `sync:sports`.

## Execution

One coherent file set (schemas + usecases + UI) → **one inline implementer
pass**. Do not parallelise.

**Scout (sonnet) brief:** re-pin every line reference in "Entry conditions",
"Why" and "Scope" against current `main` (they predate #402, #404, RS001,
RS001b) and report any that moved or no longer exist. Report the exact current
signature and return type of `eligibilityIssues` and of anything RS002 added
beside it, plus where `competition_events` write helpers now live. file:line
table only, under 30 lines, no file contents. Flag mismatches loudly.

**Implementer (sonnet, xhigh):** brief carries the re-pinned table, the 7 gate
list, the "Stripe path NOT gated" rule, the not-in-scope list, and the
code-assertion requirement. Load `frontend-design:frontend-design` for the
dialog.

**Reviewer (sonnet, xhigh):** does every gate assert the **code**? Is the audit
row written exactly once per overridden request? Is `setTeamSquad` truly
warning-only? Is there exactly one evaluator? Does any gate read a column
V363/V364 dropped? Gap list only.

## On close

`_INDEX.md`: RS011 → DONE, the 7 gate points **as actually wired** (they may
differ from this brief), the override audit shape, and the final evaluator
signature. Flip `L1` in `../2026-08-06-scoringpad-v2-prompts/_INDEX.md` to
DONE-VIA-RS011. Update help pages for the override flow. Memory +
`scripts/agent-memory-snapshot.sh`.
