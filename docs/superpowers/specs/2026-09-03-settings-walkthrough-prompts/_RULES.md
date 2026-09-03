# Settings walkthroughs — standing rules

Read this before touching anything in this programme. These are the rules a
fresh session will otherwise re-derive wrongly, at a cost already paid once.

## 1. Every project runs as ONE shared Pro org

`playwright.config.ts` sets `AUTH_STATE = "e2e/.auth/pro.json"` and the
`parallel`, `walkthrough` and `serial` projects all use it. `auth.setup.ts`
provisions a Community state too; nothing wires it in.

- **A "this is gated on Free" assertion is vacuous by default.** It passes on
  an org where the entitlement is already allowed. Every negative assertion in
  this programme must be shown to redden when its guard is mutated.
- **Every count counts the whole run.** Orgs, clubs, persons and registrations
  accumulate across projects. Scope counts to the per-spec `TAG`, never to a
  global total.

## 2. Never flip a plan without splitting the group first

`setOrgPlanBySql` (`e2e/helpers.ts:441`) is **group-scoped** — it updates
`subscriptions` by group id. `POST /api/orgs` creates an org that joins its
creator's **existing** group. So "mint a fresh org, set its plan" moves the
shared Pro org too, and reddens other people's specs across the leg.

Preference order:

1. `setEntitlementOverrideSql(orgId, featureKey, intValue)` — org-scoped,
   parallel-safe, and the right granularity for a gating matrix.
2. If a genuine plan transition is under test:
   `POST /api/orgs` → `splitOrgIntoOwnGroupSql(orgId)` → `setOrgPlanBySql`,
   then restore the active org.
3. Never step 2 without the split.

## 3. Helpers must not live under `e2e/walkthrough/`

The `walkthrough` project's `testMatch` is a bare directory regex matched
against each file's **absolute** path, and `testMatch` replaces Playwright's
default spec pattern rather than intersecting with it. Every `.ts` under
`e2e/walkthrough/` is therefore loaded as a spec. A helper placed there fails
with `test file "…" should not import test file "…"`.

- SQL helpers (needing `withDb`) → `e2e/helpers.ts`, beside `setOwnerStaffSql`.
- Page-driving helpers → `e2e/settings-support.ts`.
- Specs → `e2e/walkthrough/settings-*.spec.ts`.

CI needs no edit: the project is directory-anchored and `e2e.yml` already runs
`--project=walkthrough --workers=3`.

## 4. Restore every borrowed privilege and every shared resource

The shared Pro user outlives the test that borrowed from it.

- `setOwnerStaffRoleSql(orgId, role)` — always restored in a `finally`.
- The Connect fixture account `acct_1U8o7FBlv9TBkyYa` has **no release path**
  and only one org may hold it. Smoke's sponsor-checkout suite crashes when
  another org already claims it. Release and restore the prior holder in
  `afterAll`, and keep that leg serial.
- The platform fee default is global. A spec that writes it restores it.

## 5. Speed rules

1. One org per test, seeded via API → `mode: "parallel"`. But a fresh org is
   not automatically isolated — see rule 2.
2. At most one `page.reload()` per tab.
3. "Did it persist?" is an API read. "Does it render back?" is the one reload.
4. The matrix's API half uses `APIRequestContext`, no page.
5. No `waitForTimeout`. `expect.poll` / `waitForResponse` only.
6. No screenshots, no axe — `gallery.capture` and `mobile.spec.ts` own those.
7. Derived timeouts: `Math.max(FLOOR, base + n * per_unit)`, never a flat
   constant beside a derived cost.

Budget: **≤60s added to the walkthrough leg across the whole programme.**
Measured each wave, reported with raw numbers. A wave that blows it gets
restructured; the budget is not raised.

## 6. Toolchain

`package.json` declares `pnpm@10.34.5` and `node >=26`. A fresh worktree
installs with **`pnpm install`** — `npm install` fails with
`Unsupported URL Type "workspace:"`. Most docs in this repo say `npm run`;
they are right about scripts and wrong about install.

## 7. Reading a green

`rtk` vitest summaries print `PASS(0) FAIL(0)` for a suite that failed to
collect, and swallow exit codes. Judge green only from
`--reporter=json --outputFile`, and confirm `.testResults[].name` resolves
inside this worktree — shell cwd resets to the main checkout between calls,
so a verify run can silently execute on `main`.

For Playwright: run the whole spec file, never a `-g` slice. When a serial
file goes red, the count is a floor, not a total — re-run after each fix.

## 8. What settles a claim

A claim about what a person SEES is settled by driving the product, never by
reading the code. Every case in the register is a hypothesis. A case that
turns out already-correct is a finding to record, not a failure.
