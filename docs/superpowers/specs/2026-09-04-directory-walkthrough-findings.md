# Directory walkthroughs — what driving the product turned up

**Date:** 2026-09-04
**Branch:** `feat/directory-walkthroughs`
**Programme:** `docs/superpowers/specs/2026-09-03-directory-walkthroughs-design.md`

Five walkthrough specs were built for `/directory`. Building them meant driving
the product by hand rather than reading it, and that turned up five things the
code does not say about itself. Two are fixed on this branch. Three are not, and
each says why.

Recorded because a claim about what a PERSON SEES is settled only by driving the
product — every item below was found that way, and two of them contradict what
the code's own comments assert.

---

## 1. A refused import left the previous file's plan committable — FIXED HERE

**What an organiser hit.** Import one file: its plan renders with a live
"Commit import" button. Import a second file that trips a plan cap: the paywall
appears — *above the first file's plan, whose Commit button is still enabled.*
Pressing it imports the file they were just told was rejected.

**Why.** `ImportWizard.upload()` reset `error`, `paywallFeature` and `result` but
never `preview`, and `fail()` did not either. The `UpgradeGate` renders above the
`{preview && !result}` block, so the refusal stacked on top of a live action
rather than replacing it.

**Fixed** by clearing `preview` in `upload()`'s **`catch`** — on failure only.

The first cut cleared it at the top of `upload()`, which was wrong: `remap()`
re-enters that same function on every mapping change, so it unmounted the
mapping card mid-flight on SUCCESSFUL remaps too. Corrected in `4ef658ffb`.
**Do not move the line back to the top** — a later reader of this paragraph did
not have that context, which is exactly how a fix gets reverted.

Not in `fail()` either, which the COMMIT path shares: a commit 402 must leave
the plan on screen to trim. (It does so by never clearing `preview` at all —
`commit()` handles 402 inline and returns before `fail()` is reached.)

**Still open on this path** (found by a later review, not yet fixed): a FAILED
remap now strands the organiser. The mapping selects and the "Re-map &
re-preview" button both live inside `{preview && !result}`, so clearing on
failure removes the very control needed to retry — and `remap()` has already
written the bad mapping to `localStorage`, so later uploads re-send it.

**Why no existing test caught it.** The clubs-import walkthrough navigates to
`/import` between uploads, which unmounts the wizard and takes the stale preview
with it. The defect only exists when both uploads happen on one mounted wizard —
which is what a person does, and what no spec did. Now covered by
`directory-import-paywall-preview.spec.ts`, which fails without the fix.

## 2. Two comments asserted entitlement values that had moved — FIXED HERE

`imports.ts` claimed "Community capped at 20 rows/file" (live `import.bulk` for
community: **50**) and "the Club hierarchy itself is Pro" (live
`clubs.hierarchy`: granted on **all five plans**, community included).

The second is the dangerous one: `clubs.hierarchy` is checked immediately before
the `clubs.max` cap, so a reader trusting that comment would conclude a community
org cannot reach the cap at all — and would design a test that proves nothing.

Both now point at the live catalog instead of restating a number. Checked against
`seazn_club.plan_entitlements`, not against migrations.

---

## 2b. The paywall BADGE still says Pro, after the sentence stopped — NOT FIXED

**Found by driving the product at three widths, not by reading it** — the fixed
sentence is correct and the gate around it is not. What actually renders is:

> **PRO ✦**  This file has more rows than your plan allows — split it into
> smaller files, or upgrade for a higher limit.

`featurePlan()` (`feature-copy.ts:184`) is
`PLUS_FEATURES.has(key) ? "pro_plus" : "pro"` — every key that is not Plus is
badged **Pro**, with no notion of a key the customer already partly holds.
`import.bulk` is dual-valued: a community org has a real 50-row allowance, so
"PRO" misdescribes it exactly as the old sentence did. Fixing the copy and
leaving the badge means the screen still makes the claim, more prominently and
in fewer words.

**Not fixed here, deliberately.** `featurePlan` feeds every `UpgradeGate` in the
product and `feature-copy.test.ts` pins several of its answers, so changing it
is a broad blast radius for a branch about directory walkthroughs. It belongs
with the other entitlement-truth items (§3b below and the `openapi.ts` Pro
claims) as one coherent "our paywalls overstate what is Pro" change.

**Verified while there:** no horizontal page scroll at 1280, 768 or 320, and the
copy wraps cleanly at 320.

## 3. The stranded-fixture banner and the board can disagree — NOT FIXED

**What an organiser could hit.** Narrow a court's hours and be told
"1 scheduled fixture on this court now falls outside these hours", then open the
board and find nothing reported.

**Why.** Two authorities compute one displayed fact.
`strandedFixtureIdsFor` counts every `scheduled`/`in_play` fixture on the court
with no division, candidacy or archived filter. `validateScheduleIn` loads
calendars only for *candidate* courts, and an absent calendar is **no check at
all**. So a fixture hand-placed on a court outside its division's candidate set
is counted by the banner and invisible to the board. A second axis: the banner
counts across all divisions, validate is division-scoped.

Both placements are permitted today — `court_tag_mismatch` and
`outside_court_hours` are each carved out of `isBlockingConflict`.

**Not fixed here** because it is a design question, not a bug with an obvious
patch: either the banner narrows to what the board can see, or the board widens.
That is a product call about which number an organiser should trust, and it wants
an owner decision before code.

## 4. `officials.roles_multi` is free while four surfaces call it Pro — NOT FIXED

The entitlement is granted on **all five plans**, and enforcement is client-side
only. Four surfaces still describe it as Pro (`feature-copy.ts`,
`feature-copy.test.ts`, `openapi.ts`, `officials-directory-panel.tsx`), and
`openapi.ts` declares a 402 that no route can emit.

The owner has already ruled the ungate wrong and that it should be Pro again.

**Not fixed here** deliberately. This is a plan-catalog change, and a concurrent
session owns entitlements work. A unilateral edit to a shared literal from a test
branch makes the eventual merge worse, not better. It belongs in the entitlements
lane, and the walkthrough that covers it is written to INVERT rather than be
deleted when the re-gate lands.

## 5. A cross-tenant read is one caller away — NOT FIXED

`strandedFixtureIdsFor` runs on the pooled `sql` outside `withTenant` with no
`org_id` predicate. It is safe today only because its single caller validated the
court inside the tenant transaction first. Any second caller inherits a
cross-tenant read. It also has no archived-court guard, so an archived court can
still produce a banner the board is designed never to echo.

**Not fixed here** because it is not currently exploitable and the fix belongs
with whoever changes that call graph — but it is a latent hazard, not a style
note, and it should not sit unrecorded.

---

## What this cost, and the pattern in it

Across the programme **19 briefed premises proved false** — mechanisms that did
not exist, entitlements on the wrong plans, a shipped comment that contradicted
the function it cited, a mutation target on a code path that was never involved.

The pattern is consistent enough to be worth stating: every false premise came
from reading code and asserting a property of it, and every correction came from
running the product. A grep is not a read, a read is not a run, and a claim about
what a person sees is settled only by driving it.
