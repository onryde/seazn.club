# Entitlements v18 — W3 (Surfaces)

Branch `feat/entitlements-w3-surfaces`, cut from `origin/main` `7c0f5b1f8`
(W1 #704 and W2 #719 both merged). Worktree `.claude/worktrees/entw3`,
environment label `entw3` (own Postgres :54513, `db:apply` + `sync:sports`,
schema **v398**).

Programme index: `../specs/2026-09-02-entitlements-v18-prompts/_INDEX.md`.
Design of record: `../specs/2026-09-02-entitlements-v18-three-tier-design.md`.

**Why this file exists.** Same reason the programme index does: rulings taken
during execution live nowhere else, and the next session re-derives them
wrongly. Written as decisions are made, not batched at close-out.

## Baseline, measured not assumed

Four matrix-derived guards were left RED by V393 and are named in the index as
W3's inheritance. All four are **GREEN** on `7c0f5b1f8` — W2 closed them:

| Guard | Result |
|---|---|
| `src/lib/__tests__/pass-scoping-guard.test.ts` | 2/2 |
| `src/components/__tests__/upgrade-gate-pass-features.test.ts` | 3/3 |
| `src/lib/__tests__/plan-copy-truth.test.ts` | 28/28 |
| `src/server/__tests__/entitlements-v18-matrix.test.ts` | 7/7 |

So W3 starts on a green main and does **not** inherit an attribution trap.
Note two of these have MOVED from the paths the index gives
(`server/usecases/__tests__/pass-scoping-guard` and
`lib/__tests__/entitlements-v18-matrix` are both wrong now) — and naming a
non-existent path to vitest does not error, it silently runs a subset and
reports green. The run that established the table above did exactly that on
its first attempt: 3 paths in, 2 suites out, `success: true`.

The live `plan_entitlements` pivot was queried directly and matches design §2
cell for cell. `plans` holds community/pro public, enterprise/event_pass/
event_pass_l non-public.

## Owner rulings taken 2026-09-06

Both were put with two-plus options and the alternatives are recorded, per the
standing bar that ≥2 UI options are shown before any surface is built.

### D1 — the Event Pass ticket's second stub slot becomes the CROSSOVER

The approved mockup (`pricing-option-a-rail.html`, R14) builds the ticket
around a two-rung stub, M and L side by side, and its own notes rule that the
two stay **two-up even at 320**: *"$15 and $29 are a comparison, and two
columns is how a comparison reads; stacking makes it a sequence and pushes the
buy button ~110px further down."*

The L rung came off sale 2026-09-05, which leaves that slot empty. **Ruling:
the second slot stops being a rung and becomes the pass-vs-Pro crossover**,
derived live from `lib/pricing-crossover.ts`, never a typed threshold.

Why this one: it discharges owner gap #4 of 2026-09-04 — *"the pass/Pro
crossover gets named on the pricing page, derived from the live catalogue
rather than typed: the pass wins below roughly $150 of entry fees and Pro
above it"* — in a slot that already exists, and it preserves the mockup's
two-up geometry at every width, so no re-composition is owed.

Rejected, and why they are recorded rather than deleted:

- **One big number.** Single rung, the freed height spent on a much larger
  price. Honest, but it leaves the crossover homeless and makes the stub ~40%
  shorter than the approved drawing for no gain.
- **Slim band, ticket shrinks.** The stub collapses and the Event Pass stops
  being the page's tallest object. This is most of the way to the
  **Pro-elevated variant the owner explicitly rejected under R14**, so it
  re-opens a settled ranking ruling. Flagged as such when it was put, not
  hidden inside a layout choice.

### D2 — the comparison matrix at 320 becomes a PER-PLAN ACCORDION

The approved mockup does not cover the matrix at all; it ends at
`COMPARISON TABLE · FAQ · FINAL CTA CONTINUE BELOW`. Today the matrix is the
full table inside `scroll-x scroll-x-fade` at every width — a desktop table
shrunk, which is the debt the index routes to this wave.

**Ruling: 1280 and 768 keep the table unchanged; 320 gets one collapsible
section per plan**, each listing that plan's own values grouped by the same
`ENTITLEMENT_DOMAINS` sections, with no horizontal scroll anywhere. Both
renderers read the SAME `buildPricingSections` data — never a second
hand-maintained list.

Rejected: a **plan switcher** (two columns at every width, comparison by
switching — cheaper, but it makes side-by-side comparison, the table's whole
job, impossible on a phone); and a **sticky feature column + reachable rail**
(least work, honest about being a table, but still the desktop artefact at a
phone width, which is precisely what the debt names).

### D3 — which "Event Pass L" strings die and which stay

The 2026-09-05 ruling says L is REMOVED from *"every surface a customer can buy
or choose from, and from every shipped string that names it"*, while also
requiring that **an org already holding an L pass keeps working exactly as
before**. Four prose survivors × four locales sit on both sides of that line:

| String | Verdict |
|---|---|
| `ui.json` `upgrade.compare.passL` | **REMOVE** — a selling surface |
| `ui.json` `upgrade.rung.l` | **REMOVE** — a selling surface |
| `emails.json` `passRevoked.rung.l` | **KEEP** — sent to an existing holder |
| `emails.json` `staffDisputeAlert.kind.passL` | **KEEP** — ops, not a customer surface |

The dormancy requirement decides it: a revocation email that cannot name the
rung the holder actually bought fails "keeps working exactly as before". This
is a controller judgment call, not an owner ruling, and is flagged as such.

## Premises in the wave brief that proved FALSE

Recorded as findings. Each was checked against the tree, and the first was
checked by reading the source rather than by grepping it.

1. **"The three non-Plus pricing cards are hardcoded-English arrays."**
   No longer true — **W2 already discharged this debt.** `FREE_CARD_BULLETS`,
   `PASS_CARD_BULLETS` and `PRO_CARD_BULLETS` in `lib/pricing-cards.ts` are
   `{key: TKey, vars}` records; `cardBullets(d, bullets, matrix)` resolves each
   `{placeholder}` out of `plan_entitlements` at render, and DROPS a bullet
   whose matrix value is unreadable rather than rendering it wrong. Confirmed
   twice: by reading the arrays, and by a source scan of
   `pricing/page.tsx` for user-reaching string literals — zero hits against 51
   `t(d, …)` calls.

2. **"At 320 the pricing matrix is a 6-column desktop table."**
   It is **four** columns — Feature plus community/event_pass/pro.
   `PRICING_PLAN_KEYS` now filters `enterprise` and `HIDDEN_PASS_KEYS`. The
   debt itself stands (it is still a scroller, still shrunk at 320); only the
   arithmetic went stale.

3. **R14's "sport rail kept as drawn" — there is no rail to keep.**
   `grep -ic sport` on `pricing/page.tsx` returns **0**. The rail in the
   approved mockup was never built. It is new work in this wave, not
   preservation, and it was not budgeted as such in the brief.

### The rail's source of truth, since it had to be decided

The `sports` table carries exactly 11 rows — the ten R14 names plus `generic`,
which R14 makes the board's foot line rather than an eleventh sport. Names are
user-facing, so they are dictionary keys in all four locales, **not** the DB's
English `name` column and not a CSS transform (CSS cannot turn "Table Tennis"
into sentence case). ORDER is an explicit editorial literal in the mockup's
order — it is NOT alphabetical, and three shared literals in this repo have
already been assumed alphabetical and were not. A guard test asserts the rail's
key SET equals the catalogue's non-`generic` sports, so the literal owns order
and the guard owns membership; a sport added later cannot leave the rail
silently stale. **No variant count is ever printed** (the DB says 37,
`sync:sports` says 31, neither verified).

## Concurrency — settings walkthrough W4, running in another session

Checked directly against `7c0f5b1f8` rather than taken on report.

- `billing-manage.tsx` (932 lines) and `operator-console.tsx` (312 lines) have
  **zero** `data-testid` attributes. That session has accepted an in-flight
  scope addition to add minimal non-behavioural testids in its Task 3, but
  **Task 3 had not landed** when this was checked. Re-check before touching
  billing settings copy.
- The sharper finding: the promo-code control, the resume-subscription control
  and the **entire operator console** have **zero** e2e reach anywhere under
  `apps/web/e2e/` today. Exhaustive behaviour greps (promo, coupon, resume,
  portal, operator), not filename greps.
- The complete set of anchors a W3 copy change could break is therefore **four
  role-name literals**: `"Cancel subscription"` (`billing-states.spec.ts:251`,
  `:260`, `event-pass.spec.ts:850`) and `"Downgrade to Community"`
  (`event-pass.spec.ts:849`). W3 preserves these four literals or re-points
  them in the same commit.
- Whoever merges second re-runs the other's specs. That protocol is the
  backstop and stands regardless of the testids.

## Defects found while surveying, owed by this wave

1. **`lib/email.ts:1147-1148` hardcodes `"$9 Pro / $19 Pro Plus"`** — a retired
   plan name and two superseded prices, in a staff alert. Survives typecheck
   because it is prose.
2. **`ScrollActiveTabIntoView` keys off `[aria-current="page"]`, and the
   division tab rail has no `aria-current` at all.** The index routes the
   320 division-rail defect to W3 with "the billing settings rail already
   solves this — copy that pattern". Copying the component alone is INERT: the
   rail owes the attribute too. `settings-nav.tsx:216,231` is the working
   reference; the division rail is
   `app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx:496-518`, which has the
   `scroll-x-fade` edge indicator but no scroll-into-view.

## CI facts, re-read rather than trusted

`.github/workflows/e2e.yml` triggers on `push: branches: [main]` and
`workflow_dispatch` (with a `pr` input) — **not** on pull requests. Its legs
are **eight**: `e2e-parallel` × 4 (parallel 1/2, parallel 2/2, parallel heavy,
walkthrough), `e2e-serial` × 1, `e2e-mobile` × 3 (phones-small 320/360/375,
phones-large 390/430, tablets 768/834). Smoke is the opposite — PRs only.

Merge bar for this wave: CI green, all eight e2e legs green, a local unit sweep
with real counts, and per-screen verdicts at 1280 / 768 / 320. Not "CI green".

## Task order

1. **Pricing page** — R14 redesign, the rail, the ticket with D1, the cards,
   the enterprise strip, the matrix with D2. Zero overlap with the concurrent
   wave, and it needed D1/D2 first. *In flight.*
2. **Gates, emails, help** — W3-B (`UpgradeGate` learns the viewer's plan; the
   prop is REQUIRED so `tsc` enumerates every call site), W3-A (`stats.player`
   split, and the public-beats-owner inversion), the `email.ts` defect above,
   the help tree, `upgrade.compare.passL` / `upgrade.rung.l` removal per D3.
3. **Billing settings LAST** — re-check for the concurrent wave's testids
   first; preserve or re-point the four anchors listed above.

Plus the e2e replacements the index lists as owed: `pricing-v18.spec.ts` (task
1) and `enterprise-gate.spec.ts` (task 2), rebuilding the five live-mechanism
cases that died with `pro-plus-tier.spec.ts` rather than guessing at them.

## Task 1 fix round — a false differentiator, and the guard that missed it

Found by reading the live matrix against the rendered card, after the suite was
green and the branch review came back Approved. Neither saw it.

**The defect.** `pricing.pass.f3` read *"Advanced formats — double elim,
ladders"*. `formats.double_elim` is **true on community** (W2's growth cell) and
on every plan; `formats.advanced` is the actual lift (false on community, true
on both pass rungs and Pro). So the bullet's headline was true and its
illustrative example — the concrete half a reader believes — was false. A Free
user was told they would gain double elimination by buying a pass. They already
had it, and the page said so itself: the comparison matrix three sections down
renders `Double elimination brackets ✓ ✓ ✓`.

Fixed to name genuinely-gated examples (americano, ladders) in all four
locales.

**Why nothing caught it.** This is the MIRROR of the class W2 already closed.
W2 found twelve paywall reasons calling a pass-granted key "a Pro feature" and
grew `freeClaimFaults` to catch them. Nothing covered the inverse — shipped card
copy naming a capability as a paid differentiator when community already grants
it. `copy-truth.ts` now carries that rule (`PAID_OVERCLAIM_VOCAB` /
`localePaidOverclaimFaults`), deriving its offending set from the LIVE matrix
rather than a list typed into the test, with an anti-vacuity floor on the
vocabulary and a discrimination case proving it does NOT fire on a legitimately
gated example.

Mutation-proven independently of the implementer's own report: reverting the en
string to "double elim, ladders" reds two assertions, one of them named
`pricing.pass.f3 no longer oversells formats.double_elim, in all four locales`.
Emptying the vocabulary reds the anti-vacuity floor.

### TWO SIBLINGS OF THE SAME DEFECT — owed by Task 2, not fixed here

Both surfaced while fixing the first. Recorded with their evidence so the next
task inherits a finding rather than a rumour.

1. **`ui.json`'s `upgrade.limit.formats`** carries the identical "double
   elimination" claim, in all four locales, on the upgrade page's comparison
   row. Same falsehood, different surface.
2. **`lib/feature-copy.ts`'s `FEATURE_REASONS["formats.double_elim"]`** reads
   *"Double-elimination brackets are a Pro format"*. It **evades
   `freeClaimFaults` on a word** — that guard looks for "a Pro feature", and
   this says "a Pro format". Currently inert because no plan lacks the row, so
   nothing renders it; it becomes live the moment a plan loses double-elim.
   The guard's vocabulary is the fragile part, exactly as suspected when the new
   rule was written, and this is the proof.

### A trap paid for in this round

`git checkout -- <file>` to undo a mutation **reverted the fix instead**, because
the fix was still uncommitted — the last committed state was the one carrying the
defect. en disagreed with es/fr/nl until it was restored from the pre-mutation
backup. The rule that follows: when mutating a file whose fix is not yet
committed, restore from an explicit backup taken before the mutation, never from
git, and re-read the value afterwards rather than assuming the restore ran.

## Product-owner round, 2026-09-06 — six fixes, and one commercial ruling

Owner asked for a product-owner pass on the built page and delegated the open
question. Each item below was measured against the RUNNING product, not read
off the code.

| # | Fix | Evidence |
|---|---|---|
| 1 | Crossover becomes stacked full-width ROW CARDS at phone width | 253 chars in an 84px column = 22 lines; slot 428px tall; ticket 1200px on a 640px screen; buy CTA at y=1392 |
| 2 | "Size M" / "Event Pass M" lose the rung suffix on selling surfaces | L is off sale; the suffix exists only to contrast with a rung nobody can buy |
| 3 | `Write API access` row gets a derived Contact-us note | 1 of 56 rows has every purchasable cell dashed |
| 4 | Two remaining "double elimination" falsehoods, + widened guard vocabulary | `FEATURE_REASONS` evaded `freeClaimFaults` by saying "a Pro format" not "a Pro feature" |
| 5 | Carrom folded into Board games; rows evened to 3×3 | owner direction; 9 entries divide evenly |
| 6 | Platform fee FAQ, stating the fee is ADDITIVE | no copy on the page says so today |

### Two of these change a guard's SHAPE rather than its strictness

**Item 4's lesson is the durable one: a guard keyed to one noun is one synonym
from useless.** `freeClaimFaults` matches "a Pro feature"; the surviving
falsehood said "a Pro format" and walked straight past it. The vocabulary, not
the rule, was the weak part — which is exactly the risk flagged when the
paid-overclaim rule was written a round earlier, now demonstrated.

**Item 5 must not weaken the rail guard to a subset check.** Set equality
against the catalogue is what stops a newly-added sport silently never
appearing on the rail. Removing carrom breaks equality, and the lazy repair
(subset) would delete the protection entirely. It becomes an explicit COVERAGE
MAP instead — every catalogue sport is either named on the rail or deliberately
mapped to an entry that covers it (`carrom → boardgame`), asserted in both
directions so neither a new sport nor a dead rail entry can hide.

### Ruling — the additive platform fee IS disclosed (controller decision)

The owner delegated this one explicitly ("you decide as a product owner"), so it
is recorded as a CONTROLLER decision, not an owner ruling.

V398 made our percentage pure margin: the club's connected account bears
Stripe's own processing cost. Nothing on `/pricing` says so, so a club reading
"2% on Pro" budgets 2% and pays roughly 2% + Stripe's cut — on a $2,000
competition, ~$40 planned against ~$105 actual.

**Disclosed, for a commercial reason as much as an honest one.** Our rate is now
a small platform take rather than a blended payments cost, and saying so makes
2% legible as what it is. Competitors already quote it explicitly ("2.5% on top
of Stripe", "1% plus standard Stripe processing"); printing a bare 2% beside
their explicit 2.5%+ wins the glance and loses the first invoice, in a
word-of-mouth market whose growth thesis is clubs telling other clubs.

**Counter-argument, stated and overruled:** a bare rate reads better at a
glance. A rate that is not the rate is worse than an unattractive true one.

**Bounded deliberately:** the copy never quotes a Stripe rate — that is Stripe's
to change, and pinning it is a copy-truth fault waiting to happen. It lands in
two places, both reusing the EXISTING `noteKey` row-note mechanism rather than a
second one: the FAQ entry, and a note under the matrix's own "Platform fee on
entry fees" row, which is where a buyer actually forms the number. The card fee
pills are left alone — too tight, and already carried by the other two.

### Rebase, 2026-09-06 — what landing on W4 revealed

Rebased onto `aabb701ea` (settings-walkthrough W4). Clean, no conflicts, Flyway
tail still V398 with no duplicate numbers.

- **s-w's Task 3 testids ARE on main**: `billing-manage.tsx` 6,
  `operator-console.tsx` 3. Task 3 of this wave anchors on those rather than on
  text, which removes the copy-rewrite risk outright.
- W4's only overlap with this wave's surface is one line in
  `org-registration-currency.tsx`. No dictionary, pricing, copy-truth or
  feature-copy collision.
- **The role-name anchors to preserve are FIVE sites, not four** — the earlier
  count in this file missed `billing.spec.ts:167`. Corrected here rather than
  left to be rediscovered.

## Task 2a (W3-A), 2026-09-07 — the split, done

The programme index's premises re-checked against the tree and confirmed
current: `publicDivisionStats` genuinely had no gate, and the three
`requireFeature("stats.player")` call sites the index's line numbers had gone
stale on are exactly `divisionPlayerStats`/`statsReadableDivisions` (×2, one
for `personStats`) and `personCareerStats` — matching the split the index
already specified.

**Key-split decision:** a distinct key, `stats.player.career` (design doc §2
option A, not the "keep one key, recut every string" alternative). V399
inserts it mirroring `stats.player`'s pre-split cells exactly (community F,
pro/both pass rungs/enterprise T), then freezes `stats.player` itself T on
every plan. Chosen over the single-key alternative because the pricing matrix
needs a row that is HONEST about two different things — the record (now
universally included) and the rollup (still a real Pro/pass differentiator) —
and one row cannot say both without a note mechanism heavier than a second
key. `stats.player` stays in `ENTITLEMENT_DOMAINS` (all-true is still a valid
row, same precedent as `formats.double_elim`) rather than being deleted from
the comparison; `stats.player.career` gets its own row right after it.

**Migration:** `db/migration/deltas/V399__stats_player_career_split.sql`.
`ls db/migration/deltas | tail` was V398 before, V399 after, no duplicate.

**Enforcement:** `divisionPlayerStats`/`personStats` keep their `stats.player`
gate calls unchanged (now free-by-default, override-denyable, same shape as
`formats.double_elim`/`cricket.dls`). `personCareerStats` moved to a NEW
sibling function, `careerReadableDivisions` (gated on `stats.player.career`),
kept SEPARATE from `statsReadableDivisions` rather than parameterised — the
pass-scoping guard statically greps for a string-literal second argument to
`hasFeature`/`requireFeature`, and a shared function taking the key as a
variable would go invisible to it. `publicDivisionStats` gained the missing
gate (`stats.player`, per-competition, 404 on deny rather than 402 — no
payment prompt for an anonymous reader) — this is the inversion fix itself.

**Copy:** `pricing.pro.f4` / `_approved-dictionary-copy.ts` / CARD_SURFACES
moved from "Player stats & scorecards" to "Career stats across competitions"
(4 locales); `tips.billing.event-pass.body` (the in-app Event Pass upgrade
tip) dropped "player stats" for "career stats" (4 locales, config/tips.ts EN
source + mirror); `FEATURE_REASONS["stats.player"]` reworded to the
override-only shape, `["stats.player.career"]` added carrying the old
sentence. `copy-truth.ts`'s `PAID_OVERCLAIM_VOCAB` gained a third entry
(`stats.player` / "player stats", four locales) with matching
`dictionary-copy-truth.test.ts` coverage (clean + pre-fix-reds + falls-silent
cases), mirroring the `formats.double_elim` precedent from Task 1's fix round.

**Findings, not routed around:**
- The brief's premise that `publicDivisionStats` "has NO entitlement gate at
  all" was TRUE, confirmed by reading the function, not just the index.
- `server/public-site/data.ts:761-763`'s comment ("the leaderboard TABLE
  stays the Pro surface") was the OLD design intent, already stale evidence
  that the public/authenticated split had drifted from what was documented —
  updated in place.
- Three test surfaces beyond the ones named in the dispatch carried the OLD
  pass-scoped `stats.player` story and would have gone red unchanged:
  `server/usecases/__tests__/pass-scope-w2.test.ts` (real-Postgres HTTP-usecase
  pass-scoping suite), `e2e/pass-scope-w2.spec.ts` (its Playwright sibling —
  not run this task per the environment rule, but read and rewritten so CI
  does not inherit a stale assertion), and `scripts/smoke.ts` (two blocks: the
  division-leaderboard pass-scoping check, and one `flagOff("stats.player")`
  clause in the org-wide-scope check). All four rewritten to prove the NEW
  split rather than deleted, each redded first against the old code/DB shape
  to confirm the rewrite is load-bearing.
- `dictionaries/en/ui.json`'s `billing.pro.f4` / `billing.community.f5` carry
  the same now-imprecise "player stats" framing on the Settings → Billing
  page (`app/o/[orgSlug]/settings/billing/page.tsx`) — left untouched, in
  scope for task 3 (billing settings) per this file's own task order, not a
  guard failure (no test cross-checks that array against the matrix).

## STATE AT 2026-09-07 — read this block first on resuming

**Branch `feat/entitlements-w3-surfaces`, 6 commits on `ff73d6278`, tree clean.**

```
93e157c7f fix(pricing): the crossover named a size the page no longer sells
f9046748a feat(stats): free the player record, keep the career rollup paid
b8f99bcb0 fix(pricing): six product-owner fixes, and a note nothing rendered
e2b2e8ca4 fix(nav): the phone header wrapped both auth buttons to three lines
8c4e3a266 fix(pricing): the pass card sold a format Free already has
4d5fb223b feat(pricing): the box office page R14 draws — rail, ticket, accordion
```

**Environment (label `entw3`)**: Postgres `:54513` db `seazn_entw3` schema **V399**;
prod server `:3350`; placement service `:50670`. Bring env vars in with
`eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label entw3)"`.
**The DB has ~6,288 orgs accumulated from suite runs** — watch for the volume
signature (suites failing on 30s timeouts rather than assertions) and rebuild the
DB if gates start timing out.

**Latest gates.** `src/lib` + `src/components` + pricing + `src/server`: **7844
total / 7777 passed / 0 real failures / 674 suites / 0 collect failures / 0
outside the worktree**. The narrower lib+components+pricing sweep: 3478 / 3453 /
0 failed / 283 suites. `tsc` clean both configs. `lint:scripts` clean. i18n
parity 5924 keys × 4 locales.

**`schedule-build-honours-locks.test.ts` reds 4/12 without the placement
service and passes 12/12 with it** — proven on the same commit, not assumed.
Start it with `up --label entw3 --placement`.

### Visual sign-off obtained from the owner

`/pricing` at 1280 / 768 / 320 (en + fr), and the marketing header folded, panel
open, and unfolded. Owner approved the design; the two defects raised at 1280
(bullet rows stretched 137px against a declared 10px; the crossover printing
"the M pass") were fixed and re-measured — gaps now 49/50, ticket height 1200 →
530, zero occurrences of "M pass" / "Size M" / "Event Pass M" on `/pricing`.

Surfaces C and D were signed off by DRIVING them, not on their string diffs:
`/o/[org]/c/[comp]/upgrade` renders "Advanced formats — ladders, americano" with
no "double elimination", and the Event Pass tip carries every figure matching the
live matrix including the new "career stats". Reaching them needs a login —
mint one by inserting into `login_links` (user_id, token, expires_at 15 min) and
visiting `/magic-link?token=…`; the tip is gated on `state.kind === "offer"`, so
an org that already HOLDS a pass will not render it.

## WHAT IS STILL OWED — roughly half the wave

| Scope item (index W3 row) | State |
|---|---|
| Pricing page redesign (R14) | **DONE**, signed off |
| Dictionaries ×4 | done for what has shipped |
| W3-A `stats.player` split | **DONE**, V399 |
| **W3-B — `UpgradeGate` plan-awareness** | **NOT STARTED** |
| **Billing settings** | **NOT STARTED** |
| **Emails** | **NOT STARTED** |
| **Help tree** | **NOT STARTED** |
| **`enterprise-gate.spec.ts`** | **DOES NOT EXIST** |
| Division tab rail @320 | **NOT STARTED** |
| "Buy the pass — M" on `/upgrade` | found, **NOT FIXED** |

### W3-B facts, re-derived from the tree 2026-09-07 (the index's pins were stale twice)

- `featurePlan(featureKey)` is `lib/feature-copy.ts:379` and is
  `ENTERPRISE_FEATURES.has(key) ? "enterprise" : "pro"` — a pure function of the
  KEY. It cannot distinguish "you need Pro" from "you have Pro".
- `UpgradeGate`'s `Props` carries `feature`, `href?`, `compact?`, `reason?` and
  **no viewer-plan prop at all** (`grep -c viewerPlan|currentPlan|orgPlan` = 0).
- **There are 87 `<UpgradeGate` call sites.** Making the new prop REQUIRED is
  what forces `tsc` to enumerate them; an optional one is how a figure quietly
  stops arriving.
- `components/v2/board/ai-out-of-credits.tsx` already carries a comment about
  the retired `pro_plus` CTA — it is the named example of a Pro org being sold
  Pro.

### The "M" that survives on `/upgrade` — four strings, one of them the buy button

Found by driving the page, invisible to every grep run before it. An earlier
check cleared `/upgrade` by verifying `upgrade.compare.passL` was unreachable
and never looking at the non-L strings beside it.

| Key | Renders as |
|---|---|
| `upgrade.buyCta` | **"Buy the pass — {rung}"** — the primary CTA |
| `upgrade.rung.sizeM` | the "M" chip beside `$11.99` |
| `upgrade.rung.m` | "Event Pass M" |
| `upgrade.compare.pass` | "EVENT PASS M" column header |

Fix them the way the crossover guard was repointed: gate the letter on
`SELLABLE_PASS_KEYS.length > 1` so it returns by itself if L goes back on sale.
Owner was told this touches the buy button and did not object.

## THE BIGGEST UNVERIFIED SURFACE — no Playwright or smoke has EVER run

`apps/web/e2e/pricing-v18.spec.ts`, `apps/web/e2e/pass-scope-w2.spec.ts` and the
`scripts/smoke.ts` additions were written by three different agents and **not one
of them has been executed**. A spec that fails to collect reports zero tests
rather than a failure, so "written" is not "passing" and must not be counted as
coverage. Run them against a prod build before any merge conversation, and run
the WHOLE spec file rather than a `-g` slice — a filtered sweep selects the
wrong tests and reports green.

Merge bar the owner set: CI green, **all 8 e2e legs** green, a local unit sweep
with real counts, and per-screen verdicts. Note a PR gets **smoke only** — e2e
triggers on push-to-main, so `workflow_dispatch -f pr=<n>` is the only pre-merge
e2e a feature branch can get.
