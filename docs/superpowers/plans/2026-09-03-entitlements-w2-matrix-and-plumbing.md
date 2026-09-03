# W2 — Matrix & Plumbing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the three-tier matrix true in the database and in code — Free, Pro, Event Pass — with Pro Plus deleted outright, without touching the pages that display it.

**Architecture:** One Flyway delta sets every changed cell and removes a plan; TypeScript's canonical `PlanKey` absorbs six hand-maintained mirrors; `stripe-plans.json` takes the R12 set points into a per-currency structure that already exists. The copy guards that check marketing against the matrix will go red on the migration and must be made true, never lenient.

**Tech Stack:** TypeScript 7, Node 26, pnpm, Next.js (standalone output), Postgres + Flyway SQL deltas, vitest (`environment: "node"`, no DOM), Playwright, four locale dictionaries with a generated key union.

**Spec:** `docs/superpowers/specs/2026-09-02-entitlements-v18-three-tier-design.md` — matrix §2, prices §3a, rulings §1.
**Wave prompt:** `docs/superpowers/specs/2026-09-02-entitlements-v18-prompts/W2-matrix-and-plumbing.md`.
**Measured ground:** `w2-recon.md` in the W1 SDD workspace — read it before trusting any line number here.

## Global Constraints

- **The matrix in spec §2 is the single source of cell values.** Read them from
  there; do NOT transcribe the table into a task, a test or a fixture. A
  hand-copied matrix is how a wave ships yesterday's numbers.
- **Never weaken a guard to get green.** Nine `copy-truth.ts` functions and ~11
  test files trip on the migration. Sequence: guard red → data changed → copy
  true → guard green.
- The Event Pass overlay is **competition-scoped only** (`entitlements.ts:361`).
  A pass can never lift an org-level integer. Do not design around it.
- Any changed user-facing string goes in all four locale dictionaries;
  `lib/i18n-keys.ts` is GENERATED — regenerate, never hand-merge.
- `content/help/**` and the four locale dictionaries' Pro Plus copy belong to
  **W3**, not this wave. Touch them only where a task below names them.
- DB schema is `seazn_club` (set `search_path`; `current_schema()` is `public`);
  the plans table column is `key`, not `plan_key`.
- Judge vitest ONLY from `--reporter=json --outputFile`; confirm
  `.testResults[].name` resolves inside the worktree. Never `git stash` in a
  worktree here. All four test types per RULES.md: unit, e2e, smoke, regression.
- Line numbers in this plan are branch-relative and were measured at
  `64bd013a9`. Grep the symbol; re-pin before editing.

---

### Task 0: Environment and baselines

**Files:** none (environment only).

- [ ] **Step 1: Stand up a fresh environment**

`seazn-env up --label w2` (fresh pg + `db:apply` + `sync:sports`). `db:apply`
alone is NOT a fresh schema — without `sync:sports` the sport catalog is
unseeded and `funnel.test.ts` fails `expected 'generic' to be 'badminton'`,
which reads exactly like a regression.

- [ ] **Step 2: Record baselines before changing anything**

Run and write down, from the JSON reporter: engine total/passed/failed;
`apps/web` `src/lib` + `src/components` total/passed/failed; `tsc --noEmit` on
both configs; `eslint`. Every later "no new breakage" claim is judged against
these numbers, so a guessed baseline poisons the whole wave.

- [ ] **Step 3: Capture the matrix as it stands**

Dump `plan_entitlements` (plan, feature_key, bool_value, int_value) to a file in
the SDD workspace. This is the before-picture the migration's test compares
against, and the evidence that a cell changed rather than merely being asserted.

---

### Task 1: Migration V391 — the matrix becomes true

**Files:**
- Create: `db/migration/deltas/V391__entitlements_v18.sql`
- Create: `apps/web/src/server/usecases/__tests__/matrix-v18.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the resolved matrix every later task asserts against.

- [ ] **Step 1: Write the failing test first**

A DB-backed test that resolves each changed cell THROUGH THE RESOLVER
(`hasFeature` / `getLimit`), not by reading rows — a row test proves the SQL,
a resolver test proves the product. Derive expectations from spec §2 by reading
it, and assert `pro_plus` resolves as an unknown plan. Include Free's
`competitions.max_active` = 3, Pro's `teams.max` = 100, and the four deleted
inert keys resolving as absent.

- [ ] **Step 2: Run it and watch it fail**

`cd apps/web && eval "$(seazn-env env --label w2)" && npx vitest run src/server/usecases/__tests__/matrix-v18.test.ts --reporter=json --outputFile=/tmp/t1.json`
Expected: failures naming the old values. If anything PASSES here, the test is
asserting today's state — fix the test before writing the migration.

- [ ] **Step 3: Write the migration**

`V391` — next free number (branch head V390, `origin/main` V389). Set every
changed cell from §2; delete the `pro_plus` plan and its 57 rows; delete the
four inert keys `domains.custom`, `support.priority`,
`officials.per_fixture.max`, `stats.club_championship`. A duplicate Flyway
version has survived a clean rebase in this repo — re-check the number against
`origin/main` immediately before committing.

- [ ] **Step 4: Apply and re-run**

`DATABASE_URL=... npm run db:apply` then the test. Expected: green.

- [ ] **Step 5: Record what the copy guards now say**

Run the copy suites and SAVE the failure list. They are supposed to be red here —
this list is Task 8's worklist and the evidence that the guards noticed.

- [ ] **Step 6: Commit**

```bash
git add db/migration/deltas/V391__entitlements_v18.sql apps/web/src/server/usecases/__tests__/matrix-v18.test.ts
git commit -m "feat(entitlements): the v18 matrix — three tiers, Pro Plus deleted, four inert keys retired"
```

---

### Task 2: `PlanKey` absorbs its six mirrors

**Files:**
- Modify: `apps/web/src/lib/types.ts:212,220` (canonical `PlanKey`)
- Modify: `apps/web/src/lib/plan-label.ts`, `apps/web/src/lib/pricing-matrix.ts:29-37`, `apps/web/src/server/usecases/admin-plan.ts:136-137`, and the three files hardcoding `z.enum(["pro","pro_plus"])` — grep the literal to find all three
- Modify: `featurePlan()`'s `PLUS_FEATURES` set

**Interfaces:**
- Consumes: Task 1's migration (the plan no longer exists in data).
- Produces: one plan-key definition every later task imports.

- [ ] **Step 1: Write the failing test**

Assert there is exactly ONE definition: a test that greps the tree for
`"pro_plus"` in non-test, non-migration source and expects an empty list, plus
an assertion that each former mirror now derives from `PlanKey` (import it and
compare, rather than re-listing the values).

- [ ] **Step 2: Run it, watch it fail**, naming the six sites.

- [ ] **Step 3: Converge them**

Remove `pro_plus` from `PlanKey`; repoint each mirror at it. A `z.enum` needs
the values spread from the canonical list, not retyped.

- [ ] **Step 4: Typecheck both configs** — `tsc --noEmit` will name every
consumer the deletion breaks. That list is the real blast radius; work it down.

- [ ] **Step 5: Run the full `src/lib` + `src/components` suites** against the
Task 0 baseline. Expect the copy guards still red (Task 8) and nothing else new.

- [ ] **Step 6: Commit**

```bash
git commit -m "refactor(plans): one PlanKey, six mirrors retired"
```

---

### Task 3: Stripe prices — the R12 set points

**Files:**
- Modify: `apps/web/src/lib/stripe-plans.json` (or its real path — grep `currency_options`)
- Modify: whatever reads it (the recon names the readers)
- Test: extend the existing stripe-plans unit pins

**Interfaces:**
- Consumes: `PlanKey` from Task 2.
- Produces: the prices W3's pricing page will display.

- [ ] **Step 1: Write the failing test** asserting each tier's five currencies
match spec §3a's set points — read from §3a, not retyped into the test — and
that no `pro_plus` tier block remains.

- [ ] **Step 2: Run it, watch it fail.**

- [ ] **Step 3: Edit the JSON.** The five-currency `currency_options` structure
ALREADY EXISTS per price and per tier; only the numbers change. Remove the
52-line Pro Plus block.

- [ ] **Step 4: Re-run; green.** Then run the whole billing suite — a price
shape feeds checkout, and a broken price is a broken purchase.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(billing): R12 prices at purchasing-power set points, Pro Plus tier removed"
```

---

### Task 4: Credits — new grants, per-rung pass top-up

**Files:**
- Modify: `apps/web/src/server/usecases/credits.ts` (`monthlyPerSeatByPlan`)
- Modify: the `PASS_CREDIT_GRANT` constant and its two reading modules — grep the symbol
- Test: the credits suites, plus the three copy-truth sites that pin the grant

**Interfaces:**
- Consumes: `PlanKey`.
- Produces: the wallet behaviour W4's proof e2es assert.

- [ ] **Step 1: Write the failing tests**

Monthly grants become Free **5**, Pro **35** (today community=10, pro=60,
pro_plus=200 — the third disappears with the plan). The pass grant becomes
per-rung: **M +25, L +50**.

**Owner ruling — pass credits are a ONE-TIME TOP-UP.** They land in the wallet
at purchase and STAY: no expiry, no clawback, no cap. Write a test that proves
they survive the pass's own expiry, because that is the behaviour a customer
paid for and the one a future "tidy-up" would silently remove.

- [ ] **Step 2: Run, watch fail.**
- [ ] **Step 3: Implement** — the grant is a single read site; the pass constant
becomes per-rung, derived from the rung rather than branched on it twice.
- [ ] **Step 4: Re-run, green**, including the copy-truth pins that quote the numbers.
- [ ] **Step 5: Commit**

```bash
git commit -m "feat(credits): v18 monthly grants, and pass credits become a per-rung top-up that stays"
```

---

### Task 5: Officials — gate all three sites

**Files:**
- Modify: `apps/web/src/server/usecases/officials.ts:396`, `:435`, `:695`
- Test: `apps/web/src/server/usecases/__tests__/` — a case per site

**Interfaces:** consumes the matrix; produces no new symbol.

- [ ] **Step 1: Write three failing tests** — one per call site, each asserting
the refusal a non-entitled org gets. **The spec names only two sites; the third
(`sourceOfficials`, `:695`) was found by recon.** A test per site, not one test
per feature — two guards covering for each other are each untested.
- [ ] **Step 2: Run, watch all three fail.**
- [ ] **Step 3: Gate them.**
- [ ] **Step 4: Mutate each gate in turn** — delete the predicate, confirm the
matching test reds and the other two do not. That is what proves three sites
rather than one shared path.
- [ ] **Step 5: Commit**

```bash
git commit -m "fix(officials): the competition-id gate covers all three call sites"
```

---

### Task 6: R13 — hide the extra-seat add-on

**Files:**
- Modify: one dictionary key (all four locales) — grep the add-on strip line
- Modify: three help lines
- Regenerate: `apps/web/src/lib/i18n-keys.ts`

- [ ] **Step 1:** Confirm the recon's finding first: **no purchase UI exists**,
so "hidden" means copy only and the backend stays dormant and functional. If you
find a purchase control, STOP and report — the ruling was made on the premise
that there is none.
- [ ] **Step 2:** Remove the dictionary key from all four locales and the three
help lines; regenerate keys.
- [ ] **Step 3:** Run the dead-key detector (`find-dead-pad-keys.test.ts` guards
`pad.*`; check whether an equivalent guards this namespace) and the copy suites.
- [ ] **Step 4: Commit**

```bash
git commit -m "chore(billing): the extra-seat add-on is unadvertised, its backend dormant"
```

---

### Task 7: Copy-truth guards become true

**Files:**
- Modify: `apps/web/src/lib/copy-truth.ts` and the ~11 test files from Task 1 Step 5
- Modify: the marketing/billing strings those guards check (four locales)

- [ ] **Step 1:** Work Task 1's saved failure list. Each says the same thing from
a different angle: copy promises a capability whose row moved or vanished.
- [ ] **Step 2:** Make each claim TRUE. Do not delete a guard, relax an
expectation, or skip a test. If a guard looks wrong, report it rather than
editing it — W1 found one that was right and one whose subject had silently
disappeared.
- [ ] **Step 3 — carried from W1:** widen the per-locale paywall vocabulary.
W1 built it from strings lifted out of shipped copy by a non-native speaker,
held by a liveness floor (es 148 / fr 115 / nl 133) so an emptied list cannot
pass. Add terms; keep the floors; a native speaker should review.
- [ ] **Step 4:** Mutation-prove — reinstate a paid claim about a now-free
capability in ONE locale that is not English, and confirm the guard reds and
names the locale, key and string. Restore in the same bash call.
- [ ] **Step 5: Commit**

```bash
git commit -m "fix(copy): the matrix and the marketing agree again, in four locales"
```

---

### Task 8: The four test types, and the proofs

**Files:**
- Modify: `scripts/smoke.ts` — the plan-gated assertions that named `pro_plus`
- Create/modify: an e2e proving a Free org's caps and a Pass org's overlay
- Modify: any fixture seeding `pro_plus`

- [ ] **Step 1:** Grep `pro_plus` across `scripts/` and `apps/web/e2e/`. Every
hit is either a fixture to repoint or an assertion pinning a plan that no longer
exists. **A live assertion pinning a retired plan is how W1 nearly shipped a
smoke test asserting the paywall it had just removed.**
- [ ] **Step 2:** Write the Free-caps e2e and the Pass-overlay e2e. The overlay
one must assert the constraint, not just the grant: a pass lifts a
competition-scoped value and does NOT lift an org-level integer.
- [ ] **Step 3:** Run smoke against a REBUILT prod bundle (`seazn-env rebuild
--label w2`) — a second `up --server` re-serves the previous build and passes
every health check. Paste the final line into the report.
- [ ] **Step 4: Commit**

```bash
git commit -m "test(entitlements): Free caps and the pass overlay, proven end to end"
```

---

### Task 9: Closeout

- [ ] **Step 1:** Update `_INDEX.md` in the prompts directory — W2's status, any
ruling made during execution, and anything found and not fixed. **The SDD ledger
is git-ignored and deleted at close-out; the index is what survives.**
- [ ] **Step 2:** Re-run every gate against Task 0's baselines and record the
numbers. Drive the product once as a Free org and once with a Pass — a green
suite is not a working product.
- [ ] **Step 3:** Confirm what W2 deliberately did NOT do: the 20 help articles
and the four locales' Pro Plus copy belong to W3, and the pricing page redesign
is W3's. Say so explicitly so the closeout is not read as "Pro Plus is gone
everywhere".
- [ ] **Step 4:** Final whole-branch review before offering the branch.
