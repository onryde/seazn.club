# W2 — matrix & plumbing (entitlements v18)

**This file supersedes `2026-09-03-entitlements-w2-matrix-and-plumbing.md`** (note the
"and"), which the W1 session wrote before W2 began and which was deleted in this wave. It
was a Tasks 0-9 skeleton that still named V391 for the matrix migration — now **V393**,
after main's own V391 collided with it — and carried none of the owner rulings made during
execution. Two plans for one wave is how the wrong one gets read; there is now one.

Branch `feat/entitlements-w2-matrix-plumbing`, cut from `main` @ `ae0751682`.
Brief: `../specs/2026-09-02-entitlements-v18-prompts/W2-matrix-and-plumbing.md`.
Design of record: `../specs/2026-09-02-entitlements-v18-three-tier-design.md`.
Decision log: `../specs/2026-09-02-entitlements-v18-prompts/_INDEX.md`.

W2 makes the three-tier matrix true in the database and in code. No customer-facing
surface work — that is W3.

## Current state — 2026-09-04, written for a session that has none of this in context

**STATE AT 2026-09-05 (late) — read this first.**

**PR #719 has ZERO CI, and the reason is not obvious.** `mergeable=CONFLICTING`,
`mergeStateStatus=DIRTY` — GitHub cannot compute a merge ref for a conflicting PR, so
no `pull_request` workflow runs AT ALL. `gh pr checks` says "no checks reported",
which looks like nothing is wrong rather than like a problem. **The absence of a red is
not a green.** I wasted two wrong explanations before reading the merge state: it is
not draft status (marking it ready changed nothing, and `ready_for_review` is not even
in `pull_request`'s default event set) and not workflow gating. **Rebase onto main and
CI starts working.**

**TWO REBASE TRAPS, both live for this branch specifically:**

1. **`apps/web/src/lib/i18n-keys.ts` is GENERATED, so a clean textual merge proves
   nothing.** Two waves both adding dictionary keys merge cleanly into a file the
   generator would never emit — git resolves the text, not the invariant. This branch
   regenerated it (the pricing-card i18n work adds 22 keys, plus `nav.dashboard` and the
   Pro card's), and main has been adding keys too. **After rebasing, re-run the
   `gen-keys` step and require a ZERO diff.** A non-empty diff means the merged file was
   wrong, however clean the merge looked.
2. **`apps/web/e2e/mobile.spec.ts` is `describe.configure({ mode: "serial" })`, so a
   failure COUNT there is a floor, not a total** — the first red aborts the rest of the
   file. Re-run after each fix until a full pass completes. CI's "2 failed" has already
   concealed a third failure in that file once.

**Do NOT rebase while an agent is mid-task** — one file was still dirty when this was
written.

**And when you do rebase, expect an INHERITED e2e red.** Main's walkthrough leg is
currently red, landing on `/login`. **The CAUSE is disputed as of 2026-09-05 — two
hypotheses fit the same symptom, and neither is confirmed.** One: a redirect built with
`new URL("/path", req.url)` emits the server's internal bind address in CI (no
`HOSTNAME` set there), so the session cookie is withheld across the origin mismatch —
invisible locally because `seazn-env` pins `HOSTNAME=127.0.0.1`. Two: an auth-state bug
in `settings/page.tsx`, a different file and a different mechanism. **Do not assume
either.** Note the second is a file THIS BRANCH also modifies (i18n strings only), so
if you are diagnosing post-rebase, that overlap is worth knowing before you conclude
the red is purely inherited. What IS established: the commit is `997ad225b` and **it is
not in this branch yet** — my own dispatch (run 33966576108, verified against `refs/pull/719/head`) was
green on the walkthrough leg without it. Rebasing pulls it in. So a walkthrough red on
the next run is almost certainly that, not the rebase: check it BEFORE bisecting 148
commits of your own.

**e2e result on this branch so far: 6 of 8 jobs green**, including all seven width
projects and the walkthrough. Of the two reds, one is genuinely ours —
`open-scheduling.spec.ts:241` asserts a Community scheduling paywall that V393
deliberately removed, so the test encodes pre-v18 packaging and would go red on `main`
after merge. The other shard reports `Billing is not yet configured` (503), untriaged.


**Draft PR #719 is open**, branch pushed, 146 commits ahead of `origin/main` and 3
behind (main moves fast; rebase before merging). CI is the venue now, not this
machine: `ci.yml` triggers on `pull_request:` ONLY — typecheck, lint, sharded unit and
smoke — and `e2e.yml` triggers on push to `main` only, so `workflow_dispatch` with a
`pr` input is the SOLE pre-merge e2e signal for a feature branch. One dispatch has run
against #719; that is the first e2e this wave has ever had, and the seven width
projects had never seen this branch.

**Boundary gate, run locally on this branch: 14,034 tests / 13,954 passed / 67 pending
/ 0 real failures.** 1,117 files, every `.testResults[].name` inside the worktree. The
13 reds were environmental and BOTH causes were proven, not assumed: ten were a
hand-written `PLACEMENT_SERVICE_HOST=127.0.0.1` (it is a **host:port** string —
`eval "$(seazn-env env --label entw2)"` and they are 27/27), and three were
`credits-monthly-cron` losing to cross-suite contention, 24/24 alone. `tsc` 0 on both
configs.

**Driven in a browser** against a prod build of this branch at 1280/768/320 and in four
locales. That is what found the copy defects the unit suite could not see.

**IN FLIGHT at the time of writing:** an implementer localising
`components/pro-price-card.tsx` and widening the source scan. If the tree is dirty when
you arrive, that is its work — check `git status` before assuming anything was lost, and
read its commit messages rather than only its report.

**2026-09-05: rebased onto `origin/main` cleanly — 44 commits in, no conflicts, now
134 ahead / 0 behind, tsc 0, and PR #716 is in the branch so builds get the Turbopack
cache.** Deferred on machine load (peaks of 252 on 12 cores, five labels resident):
the full vitest boundary gate, the prod rebuild, and the driven walkthrough. All three
are still OWED before this wave can be called done — a red produced at that load is not
evidence of anything, and a build started beside a live agent already died at exit 137.

Branch `feat/entitlements-w2-matrix-plumbing` in worktree
`.claude/worktrees/entw2`. **90 commits ahead of `origin/main`, 20 behind** — a rebase
is owed and has not been done. Local env label `entw2` (Postgres :54788, placement
:50832; the server on :3300 serves a STALE bundle — rebuild before driving anything).

**Migrations added by this wave: V393–V398.** V393 the matrix rewrite, V394 drop AUD,
V395 credits/squad/scorer seat, V396 public-by-default plus the three share loops going
paid, V397 the dashboard accent key, V398 the additive platform fee. Note V391 is
**main's** `official_availability_org_write`, not ours — the original V391 collided and
ours renumbered to V393; do not "correct" a V393 reference back.

**The last full gate is STALE.** It read unit 13859 total / 13792 passed / 0 failed,
smoke 971 / 0, tsc 0 on both configs — but it ran before `5a8a1305a` (V398), the charm
reprice, the fee/price copy rewrite and the ladder guard. Those four commits carry only
their own scoped verification. **Nobody has run a whole-suite gate on this branch as it
now stands**, and per RULES.md the wave boundary owes one: full vitest via
`--reporter=json --outputFile` with `.testResults[].name` confirmed inside this worktree,
both tsc configs, and a full smoke.

### The five boundary gaps are APPLIED (2026-09-04)

`4bfea8baf` `e09286dbf` INR packs + the parity/dominance guard · `395aef3b2` the degrade
card names both caps · `714069a1e` the pricing crossover, derived · `5188afd49` a blank
fee field no longer saves 0% · `d62daae1a` the stale `feePercentFor` comment ·
`92f603d90` Pass L is 512, not "no entrant limit at all", in four locales ·
`c2ce241f6` 58 tests that had been collecting as zero · `1f269b3d6` four comments quoting
a moved price and a deleted currency.

**The crossover figures, recorded here because they otherwise live only in a commit
message:** `lib/pricing-crossover.ts` solves `passMinor + F·passFee/100 =
proMonthlyMinor + F·proFee/100` from the seed and `plan_entitlements`, giving **$150 /
€150 / £100 / ₹5,000** today. It returns null — and the line disappears — when the ladder
is not the shape the sentence describes, rather than quietly reversing its meaning.

**Quota note, 2026-09-04:** the account hit its Opus weekly limit during this round
(resets Sep 5, 19:00 Europe/London). An Opus subagent dispatched into that state **dies
on arrival and can surface as a "completed" agent with a truncated final message**, which
reads like an ordinary terse completion. One agent here died one second after its commit
landed; its findings were recovered from the commit message and its uncommitted work from
the dirty tree. Until the reset, dispatch on Sonnet, and verify a completed agent's
commits exist rather than trusting the notice.

### Closing sequence — these do NOT commute (2026-09-05)

Learned the hard way this wave; a later session that reorders them pays twice.

1. **Let every agent finish first.** A rebase rewrites history under an agent that
   is still committing, and the git index is shared across the worktree — so a
   rebase mid-flight corrupts work that reported success.
2. **Then rebase.** `origin/main` moves fast (it went 0 → 41 behind inside a day,
   and other sessions' fetches update the shared ref under you). The last rebase
   surfaced a real conflict where main had independently fixed one of our own
   findings, better than we had.
3. **Then the boundary gate**, judged from `--reporter=json` with
   `.testResults[].name` confirmed inside this worktree.
4. **Only then drive the product.** Two things changed machine-local on
   2026-09-05 that alter how the build behaves, so read them before trusting one.
   **A successful local build no longer means types are clean** — `seazn-env`
   now builds with `SKIP_TYPECHECK=1`, because the ~3GB `node` worker under
   `next build` was Next's own JS TypeScript checker (Next cannot use the TS 7 Go
   binary), and CI already skipped it. Run `npx turbo run typecheck` or
   `seazn-env gate` separately; a green build is no longer evidence.
   And **never `rm -rf apps/web/.next` by hand** — `seazn-env rebuild` now
   preserves `.next/cache`, which is what makes a one-file change 24s instead of
   a 3.7-minute cold compile; deleting it throws ~800MB of cache away. The
   Turbopack build-cache flag itself is inert until PR #716 is in the branch.
   Even so: A prod build wants ~2.8GB; run it beside live
   agents and the build dies with **exit 137 AFTER printing "Compiled
   successfully"**, which reads like a code failure and is not one. Take the
   environment down to just Postgres first.

**Flyway note for anyone with an existing local DB:** V396 and V398 were edited
after applying (comments, and V398's guard). Their checksums changed, so
`db:apply` will refuse to validate until `bash scripts/flyway.sh repair` — or use
a fresh schema. Repaired on the `entw2` label already; 237 migrations validate at
version 397.

### What is left before this wave can be reviewed for merge

1. **~~The payment rail~~ — RESOLVED as a launch gate, not W2 work.** See the correction
   below: `on_behalf_of` cannot do this, and the owner ruled that V398's rates stand while
   LAUNCH waits on a direct-charge migration in its own wave. Nothing further is owed here
   by W2. Ships with the `admin-platform-settings.tsx:12-13` fix, where
   `Number("")` is `0`, so clearing the platform-fee field SAVES 0%. That fix owes a
   paired positive assertion (empty rejected AND a real value still accepted), or it
   passes by refusing everything. Also folded in: `server/usecases/registrations.ts:78`
   still comments `feePercentFor` as "(pro 2, event-pass 5)" — the pass rungs are 4
   since V398. It was left deliberately (outside T22's touch list), not missed.
2. **T16** — the rate on the Connect card, read from `registration.fee_percent` rather
   than typed in. Two help articles still quote "1% on Pro Plus", a plan that no longer
   exists.
3. **Reviewer pass 4** — whole-wave, pre-merge. Passes 1–3 each found live defects,
   including one paywall regression that a green test had pinned as correct.
4. **Driven customer verification** — the wizard's default-public checkbox, the degrade
   note at the dashboard cap, and the Contact-us CTA, at 1280/768/320 in four locales.
   Driven in a browser, not grepped: three product facts asserted from reads alone were
   wrong in this wave.
5. **A full smoke re-run** at the wave boundary, and the rebase.

Then W4 opens with the Stripe sandbox sync as its FIRST task — see "Owed to W4" below.

### T22 closed 2026-09-04 — five commits, `5a8a1305a` … `7281dc594`

V398 plus the charm reprice, every fee/price string rewritten once against the final
numbers, the fee-ladder guard widened past `plans.md`, and smoke's fee assertions
re-derived from the matrix instead of pinning 8 and 5. Verification as reported and
spot-checked against the tree: tsc EXIT=0 on both configs, eslint EXIT=0 on the six
touched files, `db:apply` "now at version v397" with psql agreeing, and scoped vitest
**452 / 452 / 0** across 19 files with every `.testResults[].name` inside this worktree.
Three mutants, each killed by the rule it was aimed at — including the `groups.md` fee
row, which the OLD call site never read at all.

**A fourth fee-table surface was found**, against a brief that named three:
`content/help/billing/event-pass.md:18` transposes the table (one column per pass rung),
so `feeLadderTables` cannot parse it. It got its own rule, `passFeeRowFaults`
(`lib/copy-truth.ts:3229`), which REFUSES rather than guesses if the two rungs ever stop
sharing a rate. Fifth instance this wave of "the brief is a hypothesis".

Not covered by T22 and still owed to the boundary run: `scripts/smoke.ts` has no suite
filter, so its fee assertions have been type-checked and read but never EXECUTED. The
full smoke is the arbiter.

## Owner decisions taken 2026-09-03, before any code

1. **Pro monthly base is USD 12, not 9**, and the whole set-point table re-anchors on
   it (the other four currencies are set points anchored on USD, not FX — leaving them
   at §3a would put AUD 12 = USD 12 and break the stated "AUD reads against a 15–20
   norm" rationale). AUD was removed outright later the same day (T10), so that
   rationale is now historical — the re-anchoring of EUR/GBP/INR still stands on its
   own, since each is a set point against a local norm rather than an FX conversion.
2. **Tier 2+ stays at §3a's rule — half the base**, rounded down to a whole major
   unit (INR to the nearest x99). A 60% rate ($7 extra org) was chosen and then
   REVERTED by the owner once its true cost was measured: `extraOrgPrice()`'s own
   comment says the prose "half your plan's rate" is repeated across four locales,
   and `extra-org-price-parity.test.ts` names the surfaces — 6 dictionary keys × 4
   locales, `config/tips.ts`, both seed product descriptions, 3 help articles and 2
   e2e specs, ~30 edits. Holding the ratio keeps W2 out of the dictionaries
   altogether, which is what the Pro Plus split ruling wanted. **The extra
   organisation is $6, not $7** — do not "restore" the 60% figure from an earlier
   draft of this file.

   Note the INR consequence of the x99 rule: ₹499 ÷ 2 = ₹249.50, and the nearest
   x99 below that is **₹199**, so INR tier 2+ is 40% of base rather than 50%. That
   is the rule working as written (today's ₹1,399 → ₹699 rounds the same way).

   **CORRECTION (2026-09-03).** An earlier version of this line claimed the parity
   guard "asserts at-most-half, not exactly-half". That was wrong, and was written
   from the test's header comment rather than its assertions — a grep standing in for
   a read. `extra-org-price-parity.test.ts` ALSO carried a lower bound of 45% of base,
   which ₹199 of ₹499 (39.9%) fails. The bound was re-derived as one rounding STEP
   below half (₹100 for INR, one major unit elsewhere), because rounding to a grid
   costs a fixed amount and so eats a larger fraction of a cheaper plan. It still
   kills a rider set to half of half.

   **Owner ruling 2026-09-03**, put explicitly with the alternative on the table:
   keep ₹499 and the re-derived bound. ₹599 would have landed the rider at 49.9%
   and needed no guard change; rejected because it costs the volume market R12 is
   courting 20%, and because the rounding error runs in the CUSTOMER's favour —
   they pay less than half, and no copy claims exactly half.

8. **Orphaned Pro Plus riders: left as-is, both parked tests deleted (owner ruling
   2026-09-03).** `isOrgAddonItem` matches `lookup_key` against the catalog set and
   `stripe-sync` never prunes, so a subscription still carrying
   `seazn_extra_org_pro_plus_monthly` is unrecognised — never re-priced, never
   synced, never alerted, and still billing. Sandbox-only, no real money, so the
   owner ruled it not worth code that outlives Pro Plus. **This is a known silent
   billing path and must be closed before a live Stripe catalogue exists** — it is
   recorded in `_INDEX.md` as owed, not fixed.
3. **Event Pass L rises** to 39 USD. Bounded by §3a's own prose on both sides:
   `3 × L ≥ annual` (the nudge) and `2 × L < annual` ("a two-tournament organiser is
   never pushed into a subscription"), which pins USD L to 33–49.
4. **Event Pass M stays 15** — the approved R14 mockups print it, and it gains nothing
   from moving.
5. **W2 ships a minimal safe "Contact us" CTA** (plan-label entry + upgrade-gate /
   plan-badge mailto). No design work; it exists only so an enterprise-gated feature
   cannot render an undefined plan label in the wave between W2 and W3. The DESIGNED
   pricing page and billing settings remain W3's.
6. **`pro-plus-tier.spec.ts` and `pricing-pro-plus.spec.ts` are deleted in W2**, with
   the replacement debt (`pricing-v18.spec.ts`, `enterprise-gate.spec.ts`) recorded in
   `_INDEX.md` as owed to W3.
7. Greenfield reconfirmed by the owner: no prod data. R7 stands — `pro_plus` deletes
   unconditionally, no grandfathering.

### The price table AS SHIPPED (T22, 2026-09-04) — read this, not the draft below

Charm `.99` throughout, on the owner's ruling. **The draft table this section used to
carry is superseded and has been deleted rather than left below it**, because a stale
price table inside the wave's own plan is exactly the trap this programme keeps paying
for. Numbers below were read back out of `apps/web/src/config/stripe-plans.json`, not
copied from the task report.

Minor units, as the seed stores them. USD rides `unit_amount`; `currency_options`
carries only `eur/gbp/inr`. **AUD is GONE** (T10) — four currencies, not five; do not
reinstate it from an earlier draft.

| lookup_key | usd | eur | gbp | inr |
|---|---|---|---|---|
| `seazn_pro_monthly` tier 1 | 1499 | 1299 | 1099 | 59900 |
| `seazn_pro_monthly` tier 2+ | 699 | 599 | 499 | 29900 |
| `seazn_pro_annual` tier 1 | 12899 | 10899 | 8899 | 499900 |
| `seazn_pro_annual` tier 2+ | 6399 | 5399 | 4399 | 249900 |
| `seazn_event_pass` (M) | 1199 | 999 | 899 | 49900 |
| `seazn_event_pass_l` | 4499 | 3899 | 3199 | 169900 |
| `seazn_extra_org_pro_monthly` | 699 | 599 | 499 | 29900 |
| `seazn_seat_monthly` (hidden, R13) | 199 | 199 | 199 | 9900 |
| `seazn_size_pack_32` | 499 | 499 | 399 | 19900 |
| `seazn_credits_10` (40 credits) | 1000 | 900 | 800 | 39900 |
| `seazn_credits_25` (105 credits) | 2500 | 2300 | 2000 | 99900 |
| `seazn_credits_50` (220 credits) | 5000 | 4600 | 4000 | 199900 |
| `seazn_credits_100` (460 credits) | 10000 | 9200 | 7900 | 399900 |

The extra-org rate is not a separate SKU on annual — it is the `up_to: inf` rung of each
plan's graduated ladder, which is why tier 2+ and `extra_org_pro_monthly` are the same
number on monthly and there is no `extra_org_pro_annual` lookup_key to grep for.

**Six rules, verified in all four currencies** (usd / eur / gbp / inr):
- annual ÷ monthly ∈ 8–9: 8.61 / 8.39 / 8.10 / 8.35
- tier 2+ ≤ half base, monthly 699≤749.5, 599≤649.5, 499≤549.5, 29900≤29950;
  annual 6399≤6449.5, 5399≤5449.5, 4399≤4449.5, 249900≤249950
- M < L < annual: 1199<4499<12899 · 999<3899<10899 · 899<3199<8899 · 49900<169900<499900
- 3 × L ≥ annual: 13497≥12899 · 11697≥10899 · 9597≥8899 · 509700≥499900
- 2 × L < annual: 8998<12899 · 7798<10899 · 6398<8899 · 339800<499900
- **NEW — M < Pro monthly**: 1199<1499 · 999<1299 · 899<1099 · 49900<59900. Added
  because charm pricing brought the entry pass within a rounding error of a month of
  Pro; a mutant that lifted Pass M above Pro monthly was caught by this rule ALONE
  while the other eight stayed green, so it is the one that detects a dominated rung.


Consequences to carry into W3: the design's "revenue per Pro org falls 53%" is now
~37%, and the approved mockups print the old $9/$15 pair. Both are W3's to amend.
§3a's own price table is superseded by the one above and must be rewritten there too,
so the spec does not contradict the seed. The "half the base rounded DOWN" RULE in
§3a survives unchanged.

## Premises re-pinned against the tree — eight corrections

The brief asks to be told when it is wrong. It is wrong in eight places.

1. **W1 is merged.** PR #704 merged 2026-09-03T09:11:53Z as `ae0751682`. W2 branches
   from `main`; there is no W1 branch to run against.
2. **`PASS_CREDIT_GRANT` has three read sites**, not two: `billing.ts:16`,
   `copy-truth.ts:40`, `pass-ladder.ts:12`. Defined `pricing-cards.ts:61`.
3. **`pass-credit.ts` is a different concept.** It credits a pass PURCHASE PRICE
   toward a subscription (`creditPassTowardSubscription`); it never imports the grant
   constant. Design §6 names it in error. Nothing owed there.
4. **Credits are DB-only.** `monthlyPerSeatByPlan` is the single read site, but the
   numbers live solely in `plan_entitlements` (`credits.ts:311-313`). No `10/60/200`
   literal exists in code — Free 5 / Pro 35 is a migration change, not a code change.
5. **The Pro Plus footprint is 28 non-test source files**, not the brief's 31 or the
   spec's 33 (51 if `src/config/*.json` and `scripts/` are counted). Plus 68 test
   files and 8 e2e specs.
6. **There are more plan-key mirrors than the brief's six.** The three `z.enum` sites
   are right (`types.ts:203`, `api/billing/plan/route.ts:6`, `.../preview/route.ts:6`),
   but `entitlement-admin.ts:37-43` (`ADMIN_PLAN_KEYS`) and `currency.ts:85-86,104`
   are unnamed mirrors, and `ADMIN_PLAN_KEYS` and `PRICING_PLAN_KEYS` independently
   hardcode the identical five-key list.
7. **Pass `competitions.max_active` "+1" needs no work.** There is no additive
   mechanism on `int_value` and no pass row for the key. The effect already exists as
   an exclusion: `competitions.ts:113-120` subtracts passed competitions out of the
   active count. Do not insert rows.
8. **`requireFeature` already takes a competition id.** `entitlements.ts:666-672`
   signs `requireFeature(orgId, featureKey, competitionId?)`; the three officials call
   sites simply never pass it. Call-site change only.

The brief's own corrections 1 (per-currency prices are not new plumbing) and 2
(officials has three sites) are confirmed true. Its correction 3 (31 files) is not.

## Resolver semantics — measured, and load-bearing for the migration

- **INT key:** only `int_value` is read (`getLimit`, `entitlements.ts:613-614`).
  `bool_value` on an int row is ignored noise, and the table has plenty of it
  (`clubs.max`/pro is `(t,20)`, `teams.max`/pro is `(t,40)`).
- **`int_value = NULL` means unlimited. A key that resolves to NO ROW AT ALL gives 0** —
  `const base = row ? row.int_value : 0`. Deleting an int key from every plan DENIES it;
  it does not free it. Safe here only because nothing reads the four deleted keys.

  **Say "resolves to no row", never "has no row" — the distinction is load-bearing and
  I got it wrong once in writing.** `resolveFromDb` fetches the PLAN row first and
  unconditionally as the base; the pass matrix is an overlay applied field by field,
  and keys missing from it fall through to the plan row. So an ABSENT pass row is not a
  zero: a passed community org with no `clubs.max` pass row still resolves community's
  5. Read as "absent row ⇒ 0", the rule invites someone to "fix" a non-defect by
  re-inserting rows V319 deliberately deleted — which was a peer's exact objection when
  I stated it the sloppy way to them. The 0 arises only when NO plan row exists either.

  Stronger still for the org-wide int keys (`clubs.max`, `teams.max`, `import.bulk`):
  the pass branch is inside `if (competitionId)` and their call sites pass none, so the
  pass matrix is never consulted for them on any path. Those absent rows are
  unreachable, not zeroing.
- **BOOL key:** `bool_value === true`, strictly (`:460`). NULL or no row denies.
- **Pass overlay** (`resolveFromDb`, the `if (competitionId)` branch): bool can only
  GRANT; int is `betterInt` = max(), or min() for the single `LOWER_IS_BETTER` key
  `registration.fee_percent`. NULL is handled correctly as unlimited
  (`pass-vs-plan.ts:50-62`), so the no-op pass `teams.squad_max` rows cannot downgrade
  a Pro org. Deleting them is tidy-up, not a bug fix.

## Tasks

Sequenced so the guards fail in the intended order: **guard red → data changed →
copy true → guard green.** Expect a red tree from T1 until T8. Never weaken a guard
to get green.

### T1 — migration `V391__entitlements_v18.sql` + the matrix pin test
Order matters; the three FKs into `plans` (`subscriptions`, `plan_entitlements`,
`competition_passes`) have no cascade.

1. `insert into plans('enterprise', is_public=false)`.
2. Copy every `pro_plus` row to `plan_key='enterprise'`, then set
   `ai.credits.monthly = 500` and `registration.fee_percent = 1`.
3. Apply §2 to `community`, `pro`, `event_pass`, `event_pass_l` — 30 value changes,
   12 inserts, 2 row deletes. Table in `w2-delta.md` (workspace), reproduced in the
   migration's own header comment.
4. Delete the four inert keys on every plan: `officials.per_fixture.max`,
   `domains.custom`, `support.priority`, `stats.club_championship`.
5. `update subscriptions set plan_key='pro' where plan_key='pro_plus'`.
6. `delete from plan_entitlements where plan_key='pro_plus'`; `delete from plans where
   key='pro_plus'`. Unconditional (R7).

Pin test asserts every cell of the live matrix against §2 **parsed from the design
doc's own markdown**, not a table typed into the test — with anti-vacuity floors (a
minimum row count and all five plan columns present) so a parse that silently matches
nothing cannot pass.

### T2 — `PlanKey` and the mirrors
`PLAN_KEYS` becomes `["community","pro","enterprise"]`. The three `z.enum` sites, the
`plan-label.ts` map, `admin-plan.ts:136`, `pricing-matrix.ts:29-35`,
`entitlement-admin.ts:37-43` and `currency.ts:85-86,104` all converge onto derived
sets. `PRICING_PLAN_KEYS` (four purchasable columns) and `ADMIN_PLAN_KEYS` (five,
including enterprise) legitimately differ — they derive from one union rather than
being hand-listed twice.

### T3 — `featurePlan()` three-valued + the minimal Contact-us CTA
`ENTERPRISE_FEATURES = {api.write}` plus any int whose Pro value is the ceiling →
`"enterprise"`; everything else → `"pro"`. `scorers.max` and `officials.auto` leave
the set. `plan-label` gains an enterprise entry; `upgrade-gate` / `plan-badge` render
a `mailto:hello@seazn.club` CTA with the feature's human label prefilled.
Mutation check: delete the enterprise branch and the gate test must red.

### T4 — `stripe-plans.json` (real path `apps/web/src/config/stripe-plans.json`)
Write the table above into every price and tier's `unit_amount` + `currency_options`
(`eur/gbp/inr/aud`; USD rides `unit_amount`). Delete `plans[1]` (`pro_plus`) and
`org_addons[1]` (`extra_org_pro_plus`). R13: hide the extra seat — one dictionary key
and three help lines; the backend and the catalog price stay dormant and functional,
because no purchase UI exists to remove.

### T5 — per-rung pass credits
`PASS_CREDIT_GRANT: Record<"event_pass"|"event_pass_l", number> = {event_pass: 25,
event_pass_l: 50}`. The rung is already in scope at the grant site (`billing.ts:901`
inside `recordPassPurchase`, whose `passKey` is a required arg fed by
`passKeyForSession`). Update the three read sites and `passCreditGrantFaults`, whose
flat `+${PASS_CREDIT_GRANT} AI credits` literal and flat-number regex both break the
moment two rungs quote different numbers. Test with cases where the right answer
differs from the old constant.

### T6 — officials competition id
Pass the division's / stage's competition id at `autoAssignOfficials`,
`applyOfficialAssignments` and `sourceOfficials`. A Free org with a pass on
competition A runs auto-officials on A's division and is 402'd on B's. Mutation
check: drop the id from one call and the test must red.

### T7 — inert-key fallout
`entitlement-domains.ts:56` (`support.priority`), `feature-copy.ts:55`
(`stats.club_championship` reason), `scripts/smoke.ts:1950-1951,12217,12277`,
`org-addons-resolver.test.ts:138,145` (asserts `getLimit(...) === null`, which becomes
0), `pro-plus-matrix.test.ts`, `v17-phase1-matrix.test.ts`, `pricing-matrix.test.ts`,
`pricing-cards.test.ts`. `i18n-keys.ts` is generated — regenerate, never hand-merge.

### T8 — copy-truth guards
`copy-truth.ts` is pure (no DB import); it reds through its callers, which query
`plan_entitlements` live. Delete `plusDifferentiatorFaults`; teach `capClaimFaults`
that L is 512 and not "unlimited"; make `passCreditGrantFaults` per-rung; add
`enterpriseClaimFaults` (custom domain / white label / SSO may never read as included)
and `freeClaimFaults` (nothing may still call a now-free key "a Pro feature").
Deleting the `support.priority` row removes the matrix anchor for the "priority
support" claim regexes at `:396`, `:2121`, `:2210`, `:2296` — `enterpriseClaimFaults`
must replace that anchor in the same commit, not merely drop it.

**Carried from W1, and worse than briefed:** the per-locale paywall vocabulary lives
at `copy-truth.ts:589-614`, and the "es 148 / fr 115 / nl 133" liveness floor named in
the brief is a **stale measured comment** at `dictionary-copy-truth.test.ts:3402`. The
actual enforced floor is a single literal `50`, identical for every locale and both
axes. Widen the word lists and raise each floor to its own measured value.

### T8b — the copy V393 has ALREADY falsified

The brief sends the four locale dictionaries to W3. That ruling's stated reason is
that two waves must never edit one tree at the same time — and W3 has not started,
so the reason does not bind here. What does bind is the standing rule that a
migration changing rows a copy surface quotes is ONE unit of work with the fix to
that copy. V393 has already made these false; shipping the wave without them tells
customers a 512-entrant cap is unlimited.

| surface | claim | truth after V393 |
|---|---|---|
| `pricing.pass.ladder.capsUnlimited` | "unlimited entrants" (L) | 512 |
| `upgrade.ladder.entrantsUnlimited` | "Unlimited entrants" | 512 |
| `upgrade.ladder.divisionsUnlimited` | "Unlimited divisions" | Pro is 20 |
| `billing.pro.f1` | "Unlimited competitions & divisions" | divisions 20 |
| `upgrade.owned.nextBody` | "Pro … with unlimited divisions" | 20 |
| `tips.billing.event-pass.body` | "an L pass gives it unlimited entrants" | 512 |
| `pricing.meta.description` | "from $29 … Pro at $19/month" | $15 / $12 |
| `lib/pricing-cards.ts:43` | "20 & unlimited on L" | 512 |
| `lib/pricing-cards.ts:64` | "Unlimited competitions & divisions" | competitions yes, divisions 20 |

Seven dictionary keys in four locales, two code lines, and `config/tips.ts` (the
source the en dictionary mirrors). Prices elsewhere are interpolated — only two
hardcoded money lines per locale — so the price half of this is small.

**Scope discipline: W2 fixes ONLY the strings its own rows falsified.** Rebuilding
the cards from the dictionaries, and every "Pro Plus" string, stay W3's. Regenerate
`lib/i18n-keys.ts` rather than hand-merging it.

### T10 — remove AUD entirely (owner ruling 2026-09-03)

The owner chose full removal with the cost stated: **Australian clubs lose the
ability to collect entry fees in AUD.** AUD does two jobs here and this takes both.

- `SUPPORTED_CURRENCIES` in `lib/currency.ts` drops to four. `REGISTRATION_CURRENCIES`
  is DERIVED from it (one authority, explicit exclusions) so it follows automatically —
  do not add a second list.
- **Migration `V394`**: `organizations.currency` carries
  `CHECK (currency = ANY (ARRAY['usd','eur','gbp','inr','aud']))`. Alter it to drop
  `aud`. `org-currency.test.ts` fails if code and constraint disagree, which is the
  guard that makes this safe — do not weaken it. Greenfield, so no rows need
  converting, but the migration should FAIL LOUDLY if any org row is still `aud`
  rather than silently violating the new constraint.
- Every `currency_options` block in `stripe-plans.json` loses its `aud` entry, and
  copy-truth's `SEED_CURRENCIES` drops to four.
- The two label maps that hand-write `aud: "A$ AUD"` (`currency-switcher.tsx`,
  `org-registration-currency.tsx`) lose the row; both are `Record`s keyed on the
  type, so a missed one is a compile error rather than a blank option.

**The landmine that makes a PARTIAL removal worse than either end state:**
`amountFor` is `spec.currency_options?.[currency] ?? spec.unit_amount`. Drop `aud`
from the seed while leaving it in `SUPPORTED_CURRENCIES` and the pricing page renders
the USD number under an A$ symbol — no error, a wrong price. Seed and supported-list
must move in the SAME commit.

## Stripe sandbox — owner ruling, and two findings that change the work

**Ruling (2026-09-03): all billing testing runs against a real Stripe SANDBOX in
e2e or a walkthrough, never the hand-written fixture.** The fixture server's own
header agrees: "Only a real test-mode account settles whether Stripe bills a second
seat at half rate." It is used by ZERO e2e specs today — only by vitest unit tests —
so every `*.spec.ts` already resolves to real Stripe or to a dummy key.

**There is NO Stripe LIVE-mode catalogue** — owner, 2026-09-03: plans and prices exist
in the SANDBOX only. That bounds every risk below to test mode, and it means a
reprice cannot hurt a paying customer. It does not make the guards optional: the
sandbox is the only place the seed's shape is ever validated at all.

**Finding A — `stripe:sync` never prunes.** `scripts/stripe-sync.ts` iterates only the
seed's own collections and exits. It archives a price ONLY when a still-named
`lookup_key`'s amount has drifted (`:410-415`, `prices.update(p.id, {active:false})`),
which is exactly the reprice path this wave needs and is the reason the reprice works
at all — Stripe amounts are immutable, so a changed amount means a NEW price plus an
archived old one. But a seed entry that DISAPPEARS is never visited, so removing
`pro_plus` and `extra_org_pro_plus` leaves both active and purchasable in the sandbox,
where `planKeyForPrice` would resolve a real price id to a `plans` row this wave
deleted. No customer can reach it, so this is cleanup rather than an incident — but
W2 must still prove the mapper FAILS SAFE for an orphaned price id, because that is
the behaviour that would matter the day a live catalogue exists.

**Finding B — nothing checks the seed against live Stripe.** `stripe-plans.test.ts`
is seed-internal (unique lookup keys, currencies present, M < L). The one live sync
test uses a throwaway spec and says it "never touches the real seed's". No CI step
runs the `.live.` tests. So this wave rewrites every amount in five currencies and two
graduated tiers with no guard that Stripe accepted any of them. Add one: list live
prices by `lookup_key` and assert `unit_amount` and every `currency_options` entry
against the seed, gated on `BILLING_LIVE=1` and an `sk_test_` key like its neighbours.

**Sandbox proofs owed by this wave**, each driven through the real producer and
consumer, never a fixture:
1. `stripe:sync` against test mode, then the read-back guard above — this is the only
   thing that settles whether the new graduated tiers and four-currency options are
   accepted. Watch specifically whether REMOVING `aud` from an existing price's
   `currency_options` is honoured, or whether Stripe requires a new price for it;
   with no live catalogue, recreating under a transferred `lookup_key` is a free
   option if it is not.
2. The per-rung pass grant, end to end: real hosted Checkout with `4242…`, real
   `checkout.session.completed` returned by `stripe listen --forward-to`, wallet
   asserted at +25 for M and +50 for L. The path is
   `pass-checkout/route.ts` → `billing.ts` metadata → `billing-events.ts`
   `handleCheckoutCompleted` → `passKeyForSession` → `recordPassPurchase`, with a
   `passSessionRungMatchesPrice` guard in between that must be exercised, not assumed.
3. A Pro checkout at the NEW price, proving price-id resolution after the reprice.

There is no runbook for pointing a local run at the sandbox — `docs/runbooks/e2e-local.md`
documents only the CI dummies. Write one as part of this work.

### T11 — no FX fallback, ever (owner ruling 2026-09-03)

**"We must not fall back currency."** Two layers, and only one of them was covered.

**Covered already.** `stripe-sync.ts`'s `assertCurrencyCoverage` THROWS at sync time if
any price lacks a set point for a required currency, and its comment states the reason
exactly: "a hole does NOT fail at sync time — Stripe accepts the price and falls back to
ADAPTIVE PRICING, an FX-converted amount decided at render time from the buyer's IP …
Refusing to sync is the cheap failure; a silently FX-priced SKU in production is not."
`REQUIRED_CURRENCIES` is pinned to `SUPPORTED_CURRENCIES` by `stripe-sync.test.ts`, so
the four we sell in cannot develop a hole.

**NOT covered.** Stripe Checkout's Adaptive Pricing is an ACCOUNT-level default that
applies regardless of our seed. The SDK is explicit: `adaptive_pricing.enabled`
"Defaults to your dashboard setting". Nothing in this repo sets it, asserts it, or
mentions it. So a buyer in an unsupported currency — which, after T10, means every
Australian buyer — can be shown a Stripe-converted local amount we never set.

**The fix goes in code, not the Dashboard**, because a Dashboard toggle is an authority
nobody here owns and anyone can flip: pass `adaptive_pricing: { enabled: false }` on
BOTH Checkout Session creations (`billing.ts:186` subscription, `:329` pass). Both
already pass an explicit `currency: args.currency ?? "usd"`, so the session currency is
ours; this stops Stripe re-presenting it.

Tests: assert the param is sent on both paths; assert a created session comes back with
the currency we asked for, not a localised one. Mutation: drop the param and the test
must red. The sandbox run should then confirm a real session created for a non-supported
locale is denominated in USD.

Queued behind T5, which is editing `billing.ts` right now.

### T12 — V395: credits re-cut, squad cap raised, scorer seat deleted

Four changes in one migration plus their code and copy. All owner-ruled 2026-09-03.

**(0) The AI credit re-cut.** `ai.credits.monthly` pro **35 → 25**; `ai.credits.trial`
pro **20 → 15**; the pass grant becomes M **25** (unchanged) / L **50 → 35**. Free stays
**5** — the owner settled that separately: "AI Credit is fine, that's the selling point."
**The trial cut is PRO ONLY** — owner confirmed 2026-09-03 when the asymmetry was put to
them. Enterprise keeps `ai.credits.trial` 20 and `ai.credits.monthly` 500, deliberately.
So enterprise's trial is larger than Pro's, which is intended and not a drift to "fix":
enterprise is a staff-granted contact-us plan whose numbers are set per deal, not a rung
a customer self-serves onto. Touch `plan_key = 'pro'` only.

**This is rework of T5, not a fresh change.** T5 shipped the per-rung grant at 25/50 with
copy in four locales, and L's number is quoted in: the seed's `event_pass_l` product
description ("+50 AI credits"), three marketing keys and one ui key × 4 locales,
`config/tips.ts`, two English help articles, and two re-approved digest gates. Every one
moves to 35. Prefer interpolating from `PASS_CREDIT_GRANT` over writing a third literal.

Recorded consequence, raised and accepted: Pro's monthly grant (25) is now BELOW the
cheapest credit pack (40 credits for $10), so a customer whose only unmet need is AI is
better off buying a pack than upgrading. Coherent with the design's "credits are compute,
not packaging"; incoherent if credits are meant to pull people to Pro. The owner chose the
numbers with this stated.

Also check `localeCreditLeadershipFaults` (`copy-truth.ts:2782`) — it guards the claim
"the largest monthly AI credit grant" and still names `pro_plus` in its failure message,
a plan V393 deleted. It has to learn the new ordering (enterprise 500 > pro 25 >
community 5) as part of the copy sweep.

**(1) Free `teams.squad_max` 20 → 23.**

Design §2 justifies Free's squad cap as "Free =
one matchday squad". Measured against the engine's own declarations, it is not:
`football.ts` is `lineup: { size: 11, benchMax: 12 }` = **23**, and `icehockey.ts` is
`{ size: 6, benchMax: 17 }` = **23**. Cricket is 15 and volleyball 14, so those fit — but
a football or ice-hockey club cannot register its first full squad on Free at all. That is
the same "broken on night one" failure the design cites when it freed double-elimination.

Pro stays 40, which keeps the real distinction (matchday squad vs season roster). Do NOT
change the copy: "squads of 40" is a Pro claim and is unaffected.

Derive nothing here from the design doc — it says "cricket 15, football 23, rugby 23",
and RUGBY IS NOT IN THE ENGINE CATALOGUE. The sports that exist are football, cricket,
volleyball, badminton, tabletennis, icehockey and carrom. Use the engine's numbers.

**(2) DELETE the `scorers.max` cap; keep the scorer role.**

**(3) Fix the import-cap paywall message — it quotes a number that has never been right.**
`feature-copy.ts:82` says "Files over 20 rows need a Pro plan" and the comment at
`imports.ts:121` says "Community capped at 20 rows/file". The cap is **50** (per FILE,
checked as `withinLimit(orgId, "import.bulk", rows.length)` at preview time — unlimited
files, capped rows in each). A Free user refused at 60 rows is told the limit is 20 and
splits into three files when two would do. Predates W2, but it is a false customer-facing
claim in a file this wave already edits. Quote the cap from the entitlement rather than
hardcoding a third literal — a second hardcoded number is exactly how this one drifted.
The cap itself STAYS 50; the defect is the message.

#### Why the cap goes (owner ruling 2026-09-03)

**Ruling: delete the cap, do not deprecate the role in this wave.**

**CORRECTED 2026-09-03 — the owner was right and this plan was wrong twice.**
An earlier version of this entry claimed "officials cannot log in" and that officials
and scorers are not substitutes. Both are false, and the way they were reached is the
lesson: the `officials` table has no `user_id`, so the check stopped there — but the
link runs `officials.person_id → persons.user_id`. Then `/my-matches` was found to read
only `scorer_assignments`, and "officials have no surface" was concluded from it — but
`/me` carries a whole `OfficiatingLane` built on `me-officiating.ts`, and its own header
says "All plans, free included". A capability claim settled by two partial reads instead
of following the chain to its end.

**What is actually true.** `requireFixtureActor` (`server/api-v1/auth.ts`) grants an
ACCEPTED official both read AND score on a fixture with NO org role at all:

    if (!role) {
      // Non-member — the only remaining door is an *accepted* fixture_officials
      // assignment on this exact fixture. Covers both read and score.
      if (await acceptedOfficialCovers(user.id, fixtureId)) return ctx;

So a Free org delegates scoring today by adding an official, who claims their account,
accepts the fixture at `/me`, and scores it — no seat, no admin account, no device link.
The scorer role IS redundant for the volunteer-scores-a-match case, exactly as the owner
said. Device links stay Pro/Event-Pass only (owner reconfirmed 2026-09-03); they buy the
ANONYMOUS hand-over, which is a different product from a named official with a login.

What IS true: the scorer feature is half-built. `scorer_assignments` has three
production writers (`scorers.ts:125`, `invites.ts:86,136`) and **no UI anywhere** creates
one — grep across `components/` and `app/` returns nothing. The only path is inviting
somebody as a scorer with a default scope. That is what #244 meant by "dormant legacy".

So the cap is the part that is actually wrong, and it goes:
- It meters a capability the product gives away — W1 ruled scoring free on every plan.
- We would advertise "10 scorer seats" for a feature with no assignment UI, on a
  comparison table that (per #244) does not even carry the row.
- Deleting the key removes T12's original visibility problem at the root rather than
  restoring a row to two surfaces to describe something half-built.

Scope: migration **V395** deleting `scorers.max` from `plan_entitlements` (and any
`org_entitlement_overrides`), the two enforcement branches that read it
(`app/api/orgs/[id]/members/[userId]/role/route.ts` and `lib/invites.ts` — each falls
back to the `members.max` pool, which is the honest answer once the seat is not
separately sold), `feature-copy.ts`'s reason string, and every copy surface selling
scorer seats (design §3's Pro card says "10 staff + 10 scorer seats" — that claim dies
with the key, and by this wave's own rule the copy fix ships WITH the row deletion).

**Remember the resolver's edge: a key with NO ROW resolves to 0, not unlimited.** So the
call sites must stop asking for `scorers.max` entirely — leaving the read in place while
deleting the row would deny every scorer promotion instead of freeing it. That is the
single most likely way to get this wrong.

**Deprecating the ROLE is now viable and is recommended as its OWN wave, not this one.**
The blocking objection (Free loses delegated scoring) has dissolved — officials cover it
free. What remains is scope and risk, not principle: 21 non-test files (42 with tests),
`/my-matches`, `scorer_assignments`, six branches in `page-auth.ts`, and a live branch of
`requireFixtureActor` (`scoresViaAssignment` / `requireScorable`). That last one is an
AUTHORISATION path — the wrong edit there widens who can write score events. W2 is
already carrying a live pass-scoping defect and a red copy sweep; bolting an auth-path
deletion onto it is how a wave ships a security regression behind a green suite.

Sequence: delete the CAP here (small, and it removes a false claim), then take the role
in its own wave with its own review. Anything still creating scorer assignments —
`invites.ts`'s scorer-with-default-scope path — needs a migration story for existing rows
and a decision on what an org with live scorers sees the day it lands.

### T12-orig — the visibility finding this superseded (kept for the record)

V393 turned `scorers.max` from a dormant 1/1 into a real differentiator (Free **2**,
Pro **10**), and design §3's Pro card sells "10 staff + 10 scorer seats". The cap IS
enforced — `app/api/orgs/[id]/members/[userId]/role/route.ts:22` on a role change to
scorer, and `lib/invites.ts:67` on a scorer invite acceptance, against a pool separate
from `members.max`.

But both surfaces that would SHOW it were deliberately removed while it was dormant,
and neither decision was revisited by this wave:
- `entitlement-domains.ts:8` — "scorers.max is deliberately absent (#244): the seat is
  dormant legacy" → absent from `/admin` entitlements.
- `pricing-matrix.ts:117` — "scorers.max retired from the comparison (#244)" → not a row
  on the public pricing table.

Those calls were right at 1/1: a cap identical on both plans differentiates nothing.
They are wrong at 2/10 — we would advertise a seat count the comparison table does not
list. Restore the row in both, or the Pro card sells something the matrix page denies.

Two smoke checks also still assert the retired numbers and must be rewritten, not
deleted: `scripts/smoke.ts:1761` ("scorers.max = 1 on community, so exactly one fits")
and `:15421,15430` ("scorers.max (Pro = 1): a second scorer can't take a seat",
asserting 402). The second's NAME states the old rule, which is the shape this repo has
been bitten by before — read what it asserts, then move it to Free 2 / Pro 10.

### T14 — V395: grant `import.events` on every plan (owner ruling 2026-09-03)

Raised by the scheduler-bench session as "G4, blocked on W2". Verified before acting, and
it was NOT what the report said: `import.events` has zero rows AND exactly one reader —

    app/api/v1/divisions/[id]/events/import/route.ts:28
      await requireFeature(auth.orgId, "import.events"); // 402 during rollout

The 402 was a deliberate rollout kill-switch, not a forgotten matrix row, and the key
appears nowhere in design §2. So this is a FEATURE LAUNCH decision, not plumbing. It was
put to the owner as such, twice: ship or hold, then which plans.

**Ruling: ship it, TRUE on every plan — community, pro, enterprise, event_pass,
event_pass_l.** Rationale accepted: R9 says scoring detail is never a price boundary and
W1 already stripped the fidelity-band gate off this very importer, so gating the same
importer by plan would re-introduce the boundary R9 removed. The house pattern for imports
is a volume cap rather than a gate (`import.bulk` is 50 Free / 500 Pro); if event-import
volume needs bounding later, add a CAP key, do not convert this into a gate.

Scope:
- Migration **V395** inserting `import.events` bool true for all five plans.
- **Add the key to design §2** — `entitlements-v18-matrix.test.ts` parses that table, so a
  row in the database that §2 does not name is drift by construction.
- Update the `// 402 during rollout` comment at the call site; it is no longer true, and a
  stale comment saying a live feature is gated is how the next reader re-disables it.
- Check whether the key belongs in `ENTITLEMENT_DOMAINS` / the pricing comparison. It is
  true everywhere, so it differentiates nothing and probably should NOT be a pricing row —
  but say which, rather than leaving it to chance.
- `feature-copy.ts` reason string: with every plan granting it the 402 becomes unreachable
  for any org on a plan. Decide whether the reason stays for the no-plan case or goes.

Sequenced AFTER T12 (V395) because that task is in flight; do not send a mid-task
correction — this repo has had a subagent reject one as prompt injection.

**For the bench session:** this unblocks their G4 once W2 merges. Their G7 (`business`
seeded by V112, absent live) is CORRECT and was never blocked on W2 — the live catalogue
is community / enterprise / event_pass / event_pass_l / pro, `business` is long gone, and
"query the catalogue, never read it off migrations" remains the rule. W2 improves it:
`pro_plus` is deleted and `enterprise` added, the plan-key mirrors are converged onto one
union, and the live catalogue is now pinned against design §2 by a test.

### T15 — V395 part B: the three share loops become paid (owner ruling 2026-09-03)

**This REVERSES four cells V393 set eight hours ago**, and reverses design §2's growth
thesis. Recorded in full because a reader finding V393 and V395 disagreeing will otherwise
assume one is a mistake.

**Three loops move, not four.** An earlier draft also flipped `branding` (the org's own
logo) to false on Free. WITHDRAWN by the owner: a free club uploads its own logo. What we
sell is the removal of OUR badge, which is now enterprise-only — so Free keeps its identity
and loses only the amplification.

| key | Free | Pro | Pass M/L | note |
|---|---|---|---|---|
| `branding` (org logo) | **true — UNCHANGED** | true | true | flip WITHDRAWN, owner 2026-09-03: a free club uploads its own logo |
| `dashboard.player_profiles` | true → **false** | true | true | pass rows exist |
| `embeds.enabled` | true → **false** | true | **no row → INSERT true** | see trap below |
| `news.auto` | true → **false** | true | true | pass rows exist |

**The trap:** `embeds.enabled` has NO pass rows today. Flip Free to false without inserting
them and the Event Pass falls through to the community row and silently LOSES embeds — the
resolver only overlays what a pass row explicitly grants. Insert `event_pass` and
`event_pass_l` true in the same statement.

**`dashboard.branding`: SUPERSEDED, twice, within the hour — read only this version.**
Owner, final: **the badge is SHOWN on every plan except enterprise.** `dashboard.branding`
true means the badge is REMOVED, so the cells are community false, pro **true → false**,
event_pass false, event_pass_l false, enterprise true. Badge removal becomes an
ENTERPRISE-ONLY feature, which is exactly where R3 puts white label ("White label, custom
domain, write API, priority support → Contact Us").

An intermediate ruling set the pass rungs true. It was never built, so there is nothing to
revert — but note that this also moves **Pro**, which no earlier draft did. Design §2 marks
this cell "D7, never moves"; it has now moved, deliberately, and that note is the older
decision.

Net effect: every self-serve plan carries our badge, including Pro. The acquisition loop
survives the share-loop reversal after all — it just runs through public dashboards rather
than through profiles, embeds and posts.

**`dashboard.public.max`: Free 3 → 2, Pro ∞ → 10.** Pro loses "unlimited public
dashboards", so check `capClaimFaults` and any card copy claiming it.

**`assertPublicQuota` is the real defect, and BOTH remaining rulings land on it.**
Owner, 2026-09-03: the cap counts **ACTIVE public dashboards only**, and a passed
competition does not count against it.

`competitions.ts` `assertPublicQuota` today is a flat
`select count(*) from competitions where visibility = 'public'` — **no status filter and
no pass exclusion**. So a club that has run three seasons carries three public dashboards
for ever and is refused a fourth while nothing is running. That is not a policy gap, it is
a leak: the cap counts history rather than live surfaces, which is why 3 felt tight and 2
would have felt broken.

`assertActiveQuota` twenty lines above already solves both halves, and its own comment says
why — *"competition past that boundary was keeping a free slot for ever"*:

    where c.status in ${tx([...ACTIVE_COMPETITION_STATUSES])}
      and not exists (
        select 1 from competition_passes cp
         where cp.competition_id = c.id
           and pass_applies(c.status, c.ends_on, (now() at time zone 'utc')::date))

Give `assertPublicQuota` the same two clauses. **Factor the shared predicate out rather
than copying it** — that function's header already states the intent ("the same predicate
the resolver uses, so the three sites cannot drift apart again"), and `assertPublicQuota`
is conspicuously not one of those three sites. Copying would make it a fourth place to
drift.

Its comment is stale too: "Community holds 1 public competition at a time" against a cap
of 2. Third stale hardcoded cap found in this area today.

**Why a row cannot do this:** `dashboard.public.max` is
an ORG-level integer and a pass can never lift one. Worse, the count has no pass exclusion:
`competitions.ts:131-141` is `select count(*) from competitions where visibility='public'`
then `withinLimit(orgId, "dashboard.public.max", count + 1)` — flat. `competitions.max_active`
solves the identical problem at `:113-120` by subtracting passed competitions out of the
count via a `not exists (… pass_applies …)` clause. Mirror that here: a passed competition's
public dashboard must not count against the org's cap. Same shape as this wave's "+1"
finding; do not try to express it as a matrix row.

Also stale and now more wrong: `feature-copy.ts` says "Your plan hosts one public dashboard
at a time" — the cap is 2 on Free and 10 on Pro. Quote the entitlement, do not hardcode a
fourth literal.

The counter-argument was put and overruled: design §2 made these three free as acquisition
loops ("Three share loops go free… Each one puts the badge in front of people who are not
yet customers"), and `news.auto` was itself an earlier "owner asked" free cell. The owner
chose value capture over the loop. Do not "restore" these to Free on the strength of the
design doc — the doc is now the older decision.

**Copy that this falsifies and must move WITH the rows** (the wave's standing rule):
- Design §2's four cells, or `entitlements-v18-matrix.test.ts` reds — it parses that table.
- Design §3's Free card, which sells "player profiles, embeds and auto-drafted posts
  (badge on)", and the "Why this attracts more customers" section built on the three loops.
- `lib/pricing-cards.ts`'s `FREE_FEATURES` array.
- The Free card bullets in all four locale dictionaries.
- Sweep B's planned `freeClaimFaults` must not treat these as free keys.

### T16 — the fee disclosure exists; name the rate and fix the stale one

**CORRECTED after the owner showed the live screen.** An earlier version of this entry
claimed the Connect page "mentions no fee, no percentage and no terms". That was WRONG. It
was reached by reading `page.tsx` and its two dictionary keys and never following into
`<OrgPaymentInstructions>`, which is the component that renders the CTA. Third product-fact
claim made from a partial read in one session — the other two were "officials cannot log
in" and "officials have no surface", both also wrong, both also settled by opening one more
file. A claim about what a PERSON SEES is only settled by driving the product.

**What is actually shipped**, in the onboarding card, directly above the "Resume Stripe
onboarding" button — `pay.stepGoLiveDetail`:

> "Charges enabled: divisions can take card entry fees, entries confirm on payment, and
> payouts land in your bank on Stripe's schedule — minus Stripe's processing fee and the
> platform fee for your plan."

That is disclosure at the point of consent, and it is well placed. Note it again describes
the ADDITIVE model, which the code does not implement — reinforcing that making the fee
additive implements what both the UI and the help already promise.

**What is actually owed, and it is smaller:**
1. **The rate is never shown anywhere near the decision.** `pay.stepGoLiveDetail` says "the
   platform fee for your plan" without saying what that is, and no `connect.*` string names
   a percentage. Add the resolved rate, READ FROM `registration.fee_percent`, never
   hardcoded.
2. **`tips.registration.platform-fee.body` is a live false claim** — "8% on Community, 5%
   on a competition with an Event Pass, 2% on Pro, **1% on Pro Plus**". Pro Plus is deleted,
   and every number changes when the fee goes additive. Four locales.
3. The same stale list in `registration/open-registration.md:19` and
   `getting-started/create-your-organisation.md:21`.

### T17 — V397: the public accent colour gets its own key (owner ruling 2026-09-03)

**`dashboard.branding` was overloaded and nobody knew.** It gates badge removal AND the
public accent/theme colour, in one SQL expression — `server/public-site/data.ts:361-363`:

    org_has_feature(o.id, 'dashboard.branding') as branded,
    case when org_has_feature(o.id, 'dashboard.branding')
         then o.branding else '{}'::jsonb end as branding,   -- accent/theme
    case when org_has_feature(o.id, 'branding') then o.logo_url end as logo_url

So the split was already HALF done: the logo rides `branding` (free), while colour and
badge share one key. The badge ruling turned that key off for Pro, and took Pro's brand
colour off its public pages with it — a visible downgrade a paying customer did not ask
for. Four smoke checks caught it and were left RED on purpose; silencing them would have
frozen a live regression as expected behaviour.

**Ruling: a NEW key for the colour, Pro and above.** Rejected: letting colour ride
`branding` (would give it to Free — the owner chose to keep it as a paid visual
differentiator).

- New key (suggest `dashboard.theme`): community **false**, pro **true**, enterprise
  **true**, and **no pass rows** — it is ORG-level, so a pass could never lift it and a row
  would be inert. Add it to design §2 or the pin test reds.
- `public-site/data.ts` — the `o.branding` jsonb case moves onto the new key.
  `dashboard.branding` keeps ONLY the `branded` badge flag.
- The four smoke checks then describe the truth again; do not edit them to match a defect.

**Smoke fallout this wave still owes** (from V396's partial run — 159 passed / 6 failed,
then `ERROR: fetch failed` aborted at check 165, so that is a FLOOR, not a green smoke):
- `billing-group: quotas are per org…` asserts `members.max === 15`; V393 made Pro **10**.
- `jul3 officials auto is Pro Plus only`; V393 gave `officials.auto` to **Pro**.
- `smoke.ts:2460` and `:2702` assert `dashboard.player_profiles` is free on Community —
  V396 made it **false**; unreached in that run, so unobserved and WILL fail.
- `smoke.ts:4797`/`:4801` assert the free `news.auto` toggle and a digest 402 — now true
  again; will pass, but re-read them rather than assuming.

### T18 — C4's fixture writes, and a stale comment found beside them

**C4 (reviewer pass 1, re-verified OUTSTANDING in pass 2): eleven raw-SQL writes of
`plan_key='pro_plus'` into a column with a live FK.** `scripts/smoke.ts:1998, 3438, 3694,
11467, 11972, 12136, 12464`; `e2e/ai-architect.spec.ts:82`;
`e2e/payments-hardening.spec.ts:955`; `e2e/schedule-panels.spec.ts:82, 119`. Plus
`e2e/helpers.ts:443`'s union still admitting the key.

A previous sweep repointed ~90 cases across 53 files and truthfully reported that — and
still missed every one of these, because `setPlan` takes a `string`, so no typecheck can
see them. **They fail only AFTER merge**, since e2e runs on push-to-main and never on a PR.
That is the whole reason this is high priority despite looking like test cleanup.

**A stale comment found while verifying a peer session's warning about the same file.**
`helpers.ts:1066-1073` documents `splitOrgIntoOwnGroupSql` with: "a new org joins its
creator's EXISTING group (lib/auth.ts createOrgForUser), so three orgs minted by one e2e
user are three orgs on ONE bill". **That contradicts the function it cites.**
`createOrgForUser` (`lib/auth.ts:303`) inserts a FRESH subscription inside its transaction
and attaches the new org to it — its own race comment says "each minted an org + a
Community group". The only writers that attach an org to an existing group are the explicit
usecases at `billing-groups.ts:975` and `:1260`. Fix the comment while narrowing the union
in the same file.

**What IS true and matters for this task:** `setOrgPlanBySql` (`helpers.ts:441-449`) is
GROUP-scoped — it resolves `requireGroupId` and updates `subscriptions where id = groupId`.
So repointing a fixture's plan moves every org sharing that group. For e2e orgs minted
through `createOrgForUser` that group holds exactly one org, so it is safe; it is only a
hazard where a spec has deliberately joined orgs. Check each of the eleven for which shape
it is before repointing.

### T19 — gate the officials import (owner ruling 2026-09-03: fix it in W2)

**`POST /api/v1/officials/import` bypasses `import.bulk` entirely.** Found by the
directory-walkthroughs session, confirmed independently here before acting.
`app/api/v1/officials/import/route.ts` calls `importOfficials`
(`server/usecases/officials.ts:278`), which has NO `requireFeature`, NO `withinLimit`, and
never mentions `import.bulk` — while the sibling path gates at `imports.ts:132`. So the
50-row Free cap is unenforceable through that route. API-only, no UI, which is why it went
unnoticed.

Ruled into W2: this wave exists to make the matrix true in code, and it is already fixing
that key's stale paywall message. A cap with a bypass is not a cap.

**The fix, mirroring the sibling exactly — do not invent a second shape:**
`importOfficials` parses `const [header, ...data] = table` at :285, so `data.length` is the
row count. Gate AFTER the header validation (:291) and BEFORE `return withTenant(...)`
(:293) — `withinLimit` queries the POOLED sql proxy while `withTenant` pins a connection
for its whole callback, and the sibling is pre-transaction for that reason.

    const quota = await withinLimit(auth.orgId, "import.bulk", data.length);
    if (!quota.ok) {
      throw new PaymentRequiredError("import.bulk", {
        limit: quota.limit,
        reason: bulkImportRowsReason(quota.limit),
      });
    }

Reuse `bulkImportRowsReason` — the sibling's comment explains that `extra` is spread AFTER
`reason` in both envelopes, which is what lets the paywall quote the real number instead of
a third hardcoded copy. Do not hardcode 50.

**Tests owed:** a Free org importing 51 officials rows is refused 402 with `feature_key`
`import.bulk` and the message quoting the LIVE cap; 50 succeeds; a Pro org's 51 succeeds.
Mutation: delete the gate and the refusal test must red. This is a live API route that
starts refusing, so it needs an e2e through the real HTTP door, not a usecase call.

**Greenfield, so no caller is broken today** — but it IS a behaviour change to a shipped
route, and the commit message should say so plainly.

### T20 — reviewer pass 3 findings (1 critical, 4 important)

**CRITICAL — the degrade note ships on the MINORITY create path.** V396 made competitions
public by default and degrade to private at the cap instead of 402ing. `createCompetition`
returns the full row so the wizard can diff requested-vs-created and render
`public-quota-degraded`. `instantiateTemplate` performs the identical degrade, but
`FromTemplateResult` (`server/api-v1/schemas.ts:945-953`) **carries no `visibility`**, so
the client has nothing to diff, and `components/v2/template-gallery.tsx:297` redirects
unconditionally. **The gallery is the DEFAULT path** — `/competitions/new` opens on it and
"start blank" is a button inside it (`e2e/helpers.ts:1622`). A Free org at its cap creates
from a template, gets a SILENTLY private competition, shares the link, and fans get a
private page. The e2e proved the wizard, which is the path fewer people take.

**IMPORTANT:**
1. `usecases/org-posts.ts:1590` vs the sweep at `:1655` — the digest 402 has a hole at
   `total === 0`, and a comment five lines above claims the two cannot differ. They do: a
   Free org with no competitions still mints a `weekly_digest`. Read what the code does,
   not what the comment promises.
2. `newsAutoCompetitionScope:1136-1143` is an N+1 resolver loop **inside the weekly cron**.
   `org_has_feature`'s 3-arg form does it in one query.
3. `templates.ts:187-188` keys the guard on `=== "public"` but the value on `?? "public"` —
   an omitted visibility skips the quota check entirely while still creating a public
   competition.

**C4 is bigger than the brief says — correct it before dispatching T18.** All seven
`smoke.ts` line numbers are STALE (the smoke rewrite `45180182a` shifted them 4-20 lines),
and **two sites were missing**: `scripts/repro-ai-bracket-frozen-feeder.ts:206` and a
SECOND union at `e2e/payments-hardening.spec.ts:137`. So it is **13 sites, not 11**. Re-pin
every one by grep before editing.

**C3:** every pass-1 "unlimited" site survives in the committed range, plus a new one —
`content/help/billing/plans.md:9`'s "1 public dashboard".

**Came back CLEAN, and worth recording so it is not re-litigated:** `assertPublicQuota` is
genuinely FACTORED, not copy-pasted — the predicate is `liveUnpassedCompetition`
(`entitlement-freeze.ts:16-45`), four call sites, no fourth copy, and
`billing-meter-parity.test.ts` guards the call site AND the fragment body separately. All
eight pass-lift offenders are really fixed, each resolver call carrying a competition id.
The digest scoping is proven by entrant-name presence/absence rather than a boolean.
`import.events` has two live readers, so the grant is not inert. Guard integrity: five
assertions removed against fifty-eight added, every removal read and replaced with the new
truth; no `.only`, no `xit`; the three added `skipIf` are the standard DB gate.

**The §2 pin is ONE-WAY, and three places claim it is not.**
`server/__tests__/entitlements-v18-matrix.test.ts` has five cases and every one iterates
rows PARSED OUT OF THE DESIGN DOC, asserting the database matches. Nothing goes the other
direction: nothing enumerates `plan_entitlements` and asks whether each key appears in §2.
The sibling `retired-matrix-keys.test.ts:30-87` is absence-only against a hardcoded list
and pins the `plans` table, not feature keys.

V396's header (`:3-5`), V397's header (`:3-4`) and this plan's T14 all rest on the sentence
"a row in the database that §2 does not name is drift by construction". **That guarantee
does not exist.** I wrote it, and it was repeated into two migration headers.

No live defect — `import.events` and `dashboard.theme` were both added to §2 in the same
commits, which is exactly the discipline those headers describe. The exposure is the NEXT
migration that forgets, whose author will have been told three times that it cannot happen.
A false guarantee is worse than no guarantee: it manufactures confidence where a reader
would otherwise check. Same shape as `passCreditProseFaults` reading only the first table
cell and believing it had scanned the row.

**Fix — one test case:** `select distinct feature_key from plan_entitlements`, subtract the
keys parsed from §2 and the known-deleted set, assert the remainder is empty. Then the
three headers become true instead of aspirational.

**Nobody has a green smoke on this branch** — the last run aborted at check 165.

### Owed to W4 — the Stripe sandbox sync, and what can actually be removed

**Owner ruling 2026-09-04: the sync runs in W4, but as its FIRST task, not its last.**

W2 is too early — prices are not final until the additive-fee change lands, and syncing
twice mints two generations of archived prices for nothing. W4's end is too late, because
**nothing has ever validated this seed's shape against real Stripe**: the per-currency
`currency_options`, the graduated tier ladders, and whether Stripe honours REMOVING `aud`
from an existing price's currency options are all unverified. A malformed seed should
surface before the wave that depends on it is finished.

**What can be deleted, verified against the installed SDK (stripe@22.3.0), not assumed:**
- **Prices CANNOT be deleted.** `Prices` exposes `create`, `list`, `retrieve`, `search`,
  `update` — there is **no `del`**. Archiving (`active: false`) is the only removal.
- **Products expose `del`**, but Stripe refuses while any price references the product, and
  every product here has prices. In practice: archive.

**Most of it self-heals.** `scripts/stripe-sync.ts:411-417` already archives on drift — for
a still-named `lookup_key` whose amount changed it mints a replacement and sets the old
price `active: false`. So running sync after V398 archives every superseded amount by
itself.

**The true orphans are only the entries whose seed rows this wave DELETED** — `pro_plus`
monthly and annual (both graduated tiers) and `extra_org_pro_plus`. Sync never visits a
collection member that no longer exists, so they stay active and purchasable in the
sandbox. About six objects, archived by hand in the Dashboard as a recorded ops step.

**Do NOT wipe the sandbox's test data**, tempting though greenfield makes it. It is
ACCOUNT-WIDE: peer sessions are live and at least one drives real test-mode hosted Checkout
(`rs007` types `4242…`), and it would invalidate `plans.stripe_price_id_*` in every local
label's database, each of which would then need its own re-sync. If a clean slate is ever
wanted it is a coordinated action, not a side effect of a wave.

**Also owed in the same task:** the seed-versus-live read-back guard. Nothing today lists
live prices by `lookup_key` and asserts `unit_amount` plus every `currency_options` entry
against the seed — `stripe-plans.test.ts` only checks the seed against itself, and no CI
step runs the `.live.` tests. Gate it on `BILLING_LIVE=1` and an `sk_test_` key like its
neighbours.

### T9 — sweep and gates
Delete the two dead e2e specs. Rerun the 34 files that assert against
`plan_entitlements` and the 8 copy-truth importers (4 need a live DB). Unit, e2e,
smoke and regression per RULES.md. Judge vitest only from `--reporter=json
--outputFile`, confirming `.testResults[].name` resolves inside this worktree.

## Product-owner gaps found at the W2 boundary (2026-09-04)

Five, ranked by money at stake. Each was verified against the tree or the `entw2`
database, not inferred from a brief. Numbers below use Stripe's standard
2.9% + $0.30 on a $1,000 competition, and the live matrix: community 5%, pass 4%,
pro 2%, enterprise 1%.

### 1. The rate cut shipped; the thing that pays for it did not. BLOCKS MERGE.

`on_behalf_of` appears **nowhere in the tree** — grep of `apps/web/src` and
`packages` returns nothing — while V398's cut is already applied in the database.
Today, on this branch, the platform charges less AND still absorbs Stripe's fee.

| $1,000 competition | platform gross | Stripe | platform net |
|---|---|---|---|
| Before V398 (community 8%, no rail) | $80.00 | −$29.30 | **$50.70** |
| **Today** (community 5%, no rail) | $50.00 | −$29.30 | **$20.70** |
| Intended (community 5% + rail) | $50.00 | club pays | **$50.00** |

A 37.5% headline cut is a **59% cut in contribution** without the rail, and roughly
**neutral** with it — which is the proof the cut was SIZED for the rail rather than
taken on its own. The pass rungs move the same way (5%→4% is −48% net without the
rail, +93% with it, because the rail is worth more than the point given away).

**Recommendation: V398 and `on_behalf_of` are one unit of work and must land in one
commit, or the migration reverts with it.** Merging W2 as it stands ships a priced
promise to clubs ("we absorb the card fee") that the code does not keep, and takes
the revenue cut anyway. This is the same shape as W1's merge gate — a row-deleting
migration that outran the surface that pays for it.


### CORRECTION 2026-09-04 — `on_behalf_of` does not move Stripe's fee. The rail as costed cannot be built.

Raised by the implementer, which refused to write the change rather than ship something
that looks like the fix, and verified independently against
`https://docs.stripe.com/connect/charges` before acting on it.

**Destination charges — what we run today:** "Stripe debits fees from your platform's
balance." `on_behalf_of` makes the connected account the *business of record*: it settles
in that account's country, uses that country's fee **structure**, its statement
descriptor, address and payout timing. On the question of who pays, the same page is
explicit that with `on_behalf_of` set, "the country of the connected account is used to
determine the country specific fees **charged to your platform account**."

**Only direct charges have the lever:** "You can choose whether to have Stripe debit fees
directly from connected accounts or from your platform account." That is a charge-TYPE
migration, and it carries two more consequences: refunds and chargebacks move to the
connected account's balance (today "your platform balance is automatically debited for
the disputed amount and fee", and on legacy Express "your platform is responsible for
disputes and fraud"), and "direct charges aren't recommended for legacy v1 Express and
Custom accounts" — `stripe-connect.ts:133` creates exactly those, so it is a Connect
onboarding migration to v2 accounts as well.

**Three places in the tree asserted the false premise**, so this was the wave's belief and
not one agent's misreading: this plan, the W3 spec, and `V398`'s own header.

**What the arithmetic really says**, per $1,000 of entry fees, Stripe at 2.9% + $0.30:

| | platform gross | Stripe | platform net |
|---|---|---|---|
| Community 8% (before V398) | $80 | −$29.30 | **$50.70** |
| Community 5% (today) | $50 | −$29.30 | **$20.70** |
| Pass 4% (today) | $40 | −$29.30 | **$10.70** |
| Pro 2% (unchanged by V398) | $20 | −$29.30 | **−$9.30** |
| Enterprise 1% (unchanged) | $10 | −$29.30 | **−$19.30** |
| Direct charges, any rate | rate | club pays | **the full rate** |

**V398 diagnosed this correctly and prescribed a mechanism that does not exist.** Its
header's claim — "Pro and Enterprise LOSE MONEY on every registration… because the loss
is a rate, not a fixed overhead a big entry fee eventually absorbs" — is exactly right,
and was already true BEFORE V398: any rate under Stripe's own 2.9% is negative and gets
more negative as the club grows. V398 did not create the hole; it deepened it for
community and the passes while leaving the two negative rungs untouched.

**Nothing is lost today** — greenfield, no live registrations — so this is a decision
about what we launch with, not a leak to staunch.

**OWNER RULING 2026-09-04: keep V398's rates, and gate LAUNCH on the charge-type
migration.** The rates stay 5 / 4 / 2 / 1 because they are the correct rates for the
model we intend, and the cut costs nothing until clubs transact. Direct charges is what
the design already commits to and how the market quotes ("2.5% on top of Stripe"), and
it moves dispute liability off the platform — today our balance is debited for every
chargeback, and on legacy Express we carry fraud liability outright.

**The gate, stated so a later session cannot merge past it:** no club takes real
registrations until direct charges land. That is a programme, not a task — direct
charges need v2 accounts and `stripe-connect.ts:133` creates Express — and it owes its
own wave with its own design. Until it ships, every rate in the matrix is a promise
about a charge shape we do not yet run.

Rejected, with reasons, so they are not re-proposed: reverting V398 (restores community
margin but leaves Pro and Enterprise structurally negative, and undoes a four-locale
copy sweep); repricing above Stripe's cost (Pro to ~3.5%, contradicting the positioning
V398's own header cites, and V316 locks a competition's rate at first paid entry so it
would reach only unsold competitions); and running registrations as a subscription-funded
loss leader (works at $1,000/month, and at $5,000/month the same Pro org is $30 under
water every month, because the loss is a rate).

### 2. INR credit packs were half as generous as every other market — CORRECTED

**My original write-up of this finding was wrong in its arithmetic and its customer
story, and is replaced here rather than left standing.** I read the `10` in
`seazn_credits_10` as the credit count. It is the pack's USD dollar price; the grant is
the sibling `credits` field — **40 / 105 / 220 / 460**. Caught by the implementer, and
verified against the seed before accepting it. So packs were never "dominated": at
₹799 for 40 credits they were already cheaper per credit than Pro's included rate. Every
sentence I wrote about an Indian customer facing a top-up that costs more than the
better product was false.

**What is true, and was worth fixing.** A pack's per-credit price as a multiple of the
plan's included rate (Pro is ₹599 / $14.99 for **25** credits a month), across the four
rungs:

| | usd | eur | gbp | **inr, before** | **inr, after** |
|---|---|---|---|---|---|
| pack ÷ included | 0.363–0.417 | 0.385–0.433 | 0.391–0.455 | **0.726–0.834** | **0.363–0.416** |

INR sat at **exactly 2.00× USD's multiple in all four rungs** — the packs were half as
generous in India as everywhere else, because the plans were re-anchored to PPP set
points this wave and the packs were carried as "unchanged". The prescription was right
even though the reasoning behind it was not: shifting each INR rung down one lands
within 0.15% of USD's ratio.

**The guard that shipped is not the one I briefed.** I asked for "pack per-credit ≥ the
included rate, ≤ 2× it", which is red on the tree in every currency both before and
after the fix — it encodes my inverted arithmetic. Replaced with two rules that are
derived rather than asserted: **parity** (each market's pack-to-plan multiple within 25%
of the anchor currency's, a ratio because set price points make absolute amounts
incomparable across markets) and **dominance** (the multiple stays under 1, so a top-up
never becomes cheaper than subscribing). Both read the included count live from
`plan_entitlements`. Each was mutation-proved to fail alone: restoring inr 79900 reds
parity only; tripling `credits_10` in all four markets reds dominance only.

**The lesson, since it is the third of its kind in this wave:** I asserted a per-unit
economics claim from a key NAME without opening the record it names. A grep is not a
read — and a key called `credits_10` is a hypothesis about what it grants.

### 3. An empty platform-fee field saves 0% — SUPERSEDED BY MAIN, and the commit message now overstates

**The settings-walkthrough programme found and fixed this independently, and its fix
reached `main` first.** The 2026-09-04 rebase brought in `f9ab8e5f7` ("an empty fee field
is not a valid 0%"), `bf3b8cda4` ("says it is EMPTY, not 0–100 only"), `f3b0aea55` (the
same fail-open in `platformFeePercentSql`, where a jsonb-null row read as 0%) and
`fdbe826b5` (a support-role staff member handed a live Save that can only collect a 401).

**Main's version is the one that survived the conflict, deliberately.** Ours collapsed
the state into a single `number | null`, which cannot distinguish "the box is empty" from
"the number is out of range" — and main's split exists precisely so the note beside a
dead Save names the actual reason. Main's also carries a `canWrite` prop that ours did
not have; resolving the conflict the other way would have dropped it and silently
restored the support-role defect main had just fixed. `git checkout --theirs` during a
REBASE selects the commit being replayed, not upstream, and did exactly that on the first
attempt — caught by grepping the resolved file for `canWrite` rather than trusting the
resolution.

**What we still owed, and kept:** the card's prose said "Pro carries 2%, Event Pass 5%".
The pass rungs are 4% since V398, so main's copy was stale on arrival. It no longer
restates any rate — the plan matrix owns those numbers, and a staff card restating them
is how this went stale in the first place. Our `parseFeePercentInput` helper and its unit
test were dropped as redundant against main's e2e coverage, which drives the real control.

**Note for the reviewer:** commit `7d904b732` still carries its original subject, "an
empty platform-fee box saved 0% and called it a decision", while its surviving content is
only the prose fix. History could not be reworded (no interactive rebase in this
environment), so it is recorded here instead. Read the diff, not the subject.

### 3b. The original finding, for the record — an empty platform-fee field saves 0%, on both layers.

`admin-platform-settings.tsx:12` — `Number("")` is `0`, and `Number.isFinite(0) &&
0 >= 0` is `true`, so the client calls an empty box valid. The server agrees:
`api/admin/settings/route.ts:15` is `z.number().min(0).max(100)`. A staff member who
clears the field to retype it and hits save sets the platform default to zero, with
a success toast and an audit row that looks deliberate.

`feePercentFor` (`registrations.ts:78`) falls through to `platformFeeDefault()`
whenever the entitlement is null **or ≤ 0**, so the blast radius is every charge on
the fallback path.

**Recommendation:** keep `min(0)` — a deliberate 0% promo is legitimate — but stop
translating *empty* into zero: require a non-blank field client-side. **Ship it with
the paired positive assertion** (empty rejected AND `0` still accepted from a
deliberate entry), or the test passes by refusing everything, which is the failure
class this repo has shipped twice.

### 4. The pass/Pro crossover is a good ladder that nothing explains.

Pass M $11.99 at 4% versus Pro $14.99/mo at 2%: the extra 2 points cost $3.00 at
$150 of entry fees, which is where Pro overtakes the pass for a one-month
competition. Below it the pass wins; above it Pro does. That is a defensible ladder
and it is stated **nowhere a customer can see** — so the page reads simply "the pass
is cheaper", which pushes volume at the one-time SKU.

**Recommendation (W3, with the pricing page):** one comparator line — "Running a
single competition? The pass is cheaper until about $150 in entry fees." **Owner
value:** the recurring SKU is the retention SKU; naming the crossover routes
high-GMV organisers to it without discounting anything.

### 5. The degrade screen withholds the number that sizes the upgrade.

The path is built and good — the create is not refused, `public_quota_degraded`
comes back on the 201, and `competition-wizard.tsx:103` renders a card with an
`UpgradeGate`. But the client destructures only `{ name, slug }` and **drops
`limit`**, and the copy is "Your plan's public dashboards are all in use". The
organiser never learns they are at **2** and that Pro is **10**.

**Recommendation:** thread `limit` through and name both numbers. **Owner value:**
this is the single best-timed upgrade moment in the product — the customer wanted
public and did not get it — and it is the one place currently refusing to quantify
what upgrading buys.

### Not a gap, but an obligation: the growth reversal needs a measurement

Player profiles, embeds and auto posts went back behind the paywall this wave, which
also removes the badge from the surfaces that carried it off-platform. That was an
explicit owner ruling and is not re-litigated here — but it trades distribution for
revenue, and nothing in the tree measures the distribution side. Worth a baseline
before W3 ships the surfaces, so the trade can be read later instead of argued.

## Constraints

- Four locale dictionaries for any changed user-facing string; `lib/i18n-keys.ts` is
  generated. `content/help/**` is English-only and mostly W3's.
- The Event Pass overlay is competition-scoped only. A pass can never lift an
  org-level integer. Do not design around a capability that does not exist.
- DB schema is `seazn_club`, not `public`; the plans table's column is `key`.
- Never `git stash` in a worktree here. Never `UPDATE_GOLDEN=1`.
- Smoke is the PR-only gate; e2e runs on push-to-main only, so a PR carries no e2e
  signal — read `.github/workflows/e2e.yml` rather than trusting any summary of it.

## Post-rebase findings (2026-09-06) — found by CI and by driving the product

Three defects that only exist because two correct waves met, plus one product
ruling. None was visible to a green local gate.

### 1. Duplicate Flyway version — a MERGE-ONLY defect, invisible to git

main's #728 landed `V392__fix_double_encoded_bracket_bye_outcome.sql` while this
branch already held `V392__entitlements_v18.sql`. Different filenames, so the
rebase replayed 156 commits **clean** and reported success; tsc and the whole
suite pass, because migrations are SQL. Flyway then refuses to run **at all** —
not "skips one" — so no fresh clone, worktree or CI Postgres job can build a
schema.

This branch yielded (V392–V397 → **V393–V398**, 108 referencing files) because
#728 is merged and moving a merged version breaks `schema_history` for anyone
who ran it. Proven, not asserted: a fresh DB reported `now at version v398`, and
the references reconcile exactly — 109 files matched `V392` before (108 ours + 1
theirs), 108 now cite `V393` and exactly one still cites `V392`.

**Standing check, third occurrence in this repo:** after ANY rebase that pulls
schema, `ls db/migration/deltas | tail` before opening the PR.

### 2. `dashboard.public.max` metered DRAFTS — silent private downgrade

The cap shared `ACTIVE_COMPETITION_STATUSES` with `competitions.max_active`, so
a draft consumed a public-dashboard slot while publishing nothing. On Free (cap
2) an organiser holding two drafts for next season had their THIRD competition
created **private** — and since T15/F a create degrades rather than refusing,
the only symptom was a share link that 404ed.

Found by CI, then reproduced locally and confirmed against the live DB: the
shared fixture org held **279 competitions against an override of 50**, and the
229 after the fiftieth were private. Five public-page specs failed with "This
link is no longer valid", which looks nothing like a quota failure.

Fixed by splitting the sets (`PUBLIC_DASHBOARD_STATUSES` = published/live) and
moving enforcement from create to **publish**, which needed a new 402 in
`patchCompetition` — without it, freeing drafts opens a wider bypass than it
closes (create N public drafts metering zero, publish them all, cap enforced
nowhere). Only a real transition charges: republishing and published → live must
not re-charge a held slot.

**Owner ruling (2026-09-06):** a draft is an active slot but not a public
dashboard. The organiser now meets the cap with the competition already built,
rather than discovering it as a dead link.

### 3. Sentinels that guarded what this wave deliberately freed

`open-scheduling.spec.ts` asserted `scheduling.multi_division` still walls
Community — a guaranteed red the moment this branch reaches main, and invisible
until then because **e2e runs only on push to main**. Inverted rather than
deleted, so it now guards the ruling that the joint board is free.

Cost worth recording: that file was two-sided by design, with
`multi_division` as its counterweight. Every scheduling key is now free on
Community (`scheduling.ai` V302, board/constraints V353, multi_division V393),
so the counterweight is **gone and cannot be rebuilt from that surface**. It is
stated in the file, because its shape still looks like it proves gates bind.

Sweep method that found it, and should be repeated for any key a migration
frees: `grep -rn -a 'data-feature="<key>"' apps/web/e2e` per key in the
migration's `feature_key in (...)` list. Of eight keys freed, exactly one had a
sentinel — and it was fatal.

### 4. A retired plan crashed a live billing probe

`billing-proration.live.test.ts` selected `from plans where key = 'pro_plus'`,
which V393 deletes, so the bare `plus.annual` threw a TypeError rather than
failing an assertion — the row above it was already guarded with `pro?.annual`,
the sibling never was. Now derived from the catalog (`is_public and key <>
'pro'`) rather than named, so a plan added or retired moves the loop with it.

### Still open

- Does anything SURFACE `public_quota_degraded` on a screen? The API carries the
  note; if no UI reads it, the organiser still just sees a dead link and the
  note is an inert seam.
- `mobile.spec.ts:4384` (2048 swipe) fails at both tablet widths; main passes it.
  Unrelated to this wave, needs its own look.
- `org-less-destination.spec.ts:137` is red on main itself — not ours.
