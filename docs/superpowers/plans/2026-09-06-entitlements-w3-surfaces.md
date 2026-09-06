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
