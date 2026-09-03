# W2 — matrix & plumbing

**Programme:** entitlements v18 (Free / Pro / Event Pass). Design of record:
`../2026-09-02-entitlements-v18-three-tier-design.md` — the target matrix is §2,
prices are §3a, owner rulings R1–R14 are §1. Decision log: `_INDEX.md` beside this
file. **W1 is complete and merged/open as PR #704; W2 runs against its tree.**

**Written from the tree, not from the spec's intentions** — every number below was
measured on `feat/entitlements-w1-scoring-free` @ `64bd013a9` against DB label
`entw1` (flyway head V390). Full evidence: `w2-recon.md` in the W1 SDD workspace.
Re-pin anyway before building: line numbers are branch-relative and eight briefs
in W1 carried a false premise. **If a premise here is wrong, say so with evidence
rather than working around it.**

## What W2 is

The matrix becomes true in the database and in code. No customer-facing surface
work — that is W3. In one line: **W1 made scoring free; W2 makes the three-tier
matrix real everywhere except the pages that display it.**

## Three corrections to the spec, already verified

1. **Per-currency prices are NOT new plumbing.** `stripe-plans.json` already
   carries five-currency `currency_options` per price, per tier. R12 is a
   numbers change against an existing shape. Do not design a currency structure.
2. **Officials has THREE ungated call sites, not two** — `officials.ts:396`,
   `:435` and `:695`. The spec's pin names two; `sourceOfficials` is the third.
3. **Pro Plus is 31 non-test source files**, not the 33 the spec estimates.

## Owner rulings for this wave (2026-09-03)

- **Pass credits are a ONE-TIME TOP-UP.** Per-rung grants (M +25, L +50) land in
  the wallet at purchase and STAY — no expiry, no clawback, no cap. A customer
  keeps what they paid for. `PASS_CREDIT_GRANT = 25` is today a single constant
  read by two modules and pinned in three copy-truth sites; it becomes per-rung.
- **Pro Plus removal SPLITS.** W2 takes code, types, DB, Stripe and tests. The
  20 help articles and the four locale dictionaries go to **W3**, which already
  owns help, dictionaries and emails — so two waves never edit the same help
  tree, the shape that caused conflicts between W1 and the parallel scorepad wave.
- **Converge the plan-key mirrors in W2.** Three files hardcode
  `z.enum(["pro","pro_plus"])` and three more hand-maintain their own copy
  (`plan-label.ts`, `featurePlan()`'s `PLUS_FEATURES`, `admin-plan.ts:136-137`,
  plus `pricing-matrix.ts:29-37`). `PlanKey` (`lib/types.ts:212,220`) is the one
  canonical enum. Deleting a plan is exactly when a hidden mirror bites: it
  compiles clean and refuses a real request at runtime.

## Scope

- **Migration `V391__entitlements_v18.sql`** — next free number; branch head is
  V390, `origin/main` V389, nothing reserves 391+. Set every changed cell from
  §2, delete the `pro_plus` plan and its 57 rows, and delete the four inert keys
  (`domains.custom`, `support.priority`, `officials.per_fixture.max`,
  `stats.club_championship`) — confirmed zero-read, and the spec's rule is that
  the matrix carries only enforced keys. **No fifth inert key exists; do not go
  hunting for one.**
- **Types and the plan enum** — `PlanKey` loses `pro_plus`; the six mirrors
  converge onto it.
- **`featurePlan`, labels, add-on sets, `stripe-plans.json`** — the R12 set
  points per currency (§3a), the Pro Plus tier block (52 lines) removed.
- **Credits** — `monthlyPerSeatByPlan` in `credits.ts` is the single grant read
  site; today community=10 / pro=60 / pro_plus=200. §2 sets Free **5**, Pro
  **35**. Pass grants become per-rung.
- **Officials competition id** — gate all three sites.
- **R13** — hide the extra-seat add-on: one dictionary key and three help lines.
  **No purchase UI exists**, so there is nothing to remove from the interface;
  the backend stays dormant and functional.
- **Unit pins and copy-truth guards** — see below.

## The guards that will fight back

W1's lesson, and it will repeat here: **deleting `plan_entitlements` rows reddens
every guard that checks copy against the matrix**, because a bullet pointing at a
missing row is exactly as unresolvable as one pointing at a false row. Nine
`copy-truth.ts` functions and ~11 test files will trip on this migration.

**Make the copy true; never weaken a guard to get green.** Those guards are the
only thing that catches the next wave doing this. Expect a red tree mid-wave and
sequence deliberately: guard red → data changed → copy true → guard green.

## Carried from W1

Widen `copy-truth.ts`'s per-locale paywall vocabulary. W1 built it from strings
lifted out of shipped copy by a non-native speaker, held by a liveness floor per
locale (es 148 / fr 115 / nl 133) so an emptied list cannot pass by matching
nothing. The mechanism is sound and bounded; the word lists want a native
speaker's eye.

## Constraints

- Four locale dictionaries for any changed user-facing string, and
  `lib/i18n-keys.ts` is GENERATED — regenerate, never hand-merge.
- `content/help/**` is English-only — and in W2's case, mostly W3's to touch.
- The Event Pass overlay is **competition-scoped only** (`entitlements.ts:361`,
  `if (competitionId)`), double-enforced by there being no pass-plan rows for
  org-level integer keys. A pass can never lift `members.max`, `teams.max`,
  `scorers.max` or any other org-level integer. Verified live; do not design
  around a capability that does not exist.
- Judge vitest ONLY from `--reporter=json --outputFile`. The DB schema is
  `seazn_club`, not `public` (`current_schema()` defaults to `public`; set
  `search_path`), and the plans table's column is `key`, not `plan_key`.
- Never `git stash` in a worktree here. Never `UPDATE_GOLDEN=1`.
- All four test types per RULES.md: unit, e2e, smoke, regression. Smoke is the
  PR-only gate; e2e runs on push-to-main only, so a PR carries no e2e signal.
