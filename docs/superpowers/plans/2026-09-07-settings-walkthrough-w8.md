# Settings W8 Implementation Plan — fix wave, second mutation sweep, programme review

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** W8 is the programme's first PRODUCTION-code wave (W1-W7 were test-only per
design §10). Fix the real, contained defects the matrix proved broken
(F1/F2/F3/F4/F8/F10/F12, plus F14's cheap half), run the second mutation
sweep design §9 requires, and close the programme review out as a read-through
of the fixes plus the standard final whole-branch review. Two real defects
(F5, F6, F7) are explicitly scoped OUT — see §0 for why.

**Architecture:** Nine small tasks, each touching one finding (or a tight
cluster of two trivial ones). Every task that changes production behavior
ships a regression test that fails without the fix (design §9), in the
SAME task. Four tasks touch a dictionary string and therefore all four
locales plus `npm run i18n:gen-keys`. The mutation sweep is its own task,
run after every fix is in so the sweep also covers this wave's own new
guards. The final task is the whole-branch review's own scope — no separate
"programme review" task (see §0's ruling on this).

**Tech Stack:** Same as W1-W7 (Playwright `walkthrough` project,
`apps/web/e2e/settings-support.ts` helpers) plus, for the first time in this
programme, real production files under `apps/web/src`.

**Spec:** `docs/superpowers/specs/2026-09-03-settings-walkthrough-design.md`
(design of record, §9 mutation-sweep rule, §10 production-changes rule),
`docs/superpowers/specs/2026-09-03-settings-walkthrough-prompts/FINDINGS.md`
(every finding this plan fixes or defers, read in full before touching
anything — this plan quotes it but is not a substitute for it),
`_INDEX.md`/`_RULES.md` beside it.

## §0. Ground truth as of 2026-09-07 (re-verified against `origin/main` at `cfe97642f`, not FINDINGS.md's prose alone)

**Scope decision — IN vs OUT, and why.** FINDINGS.md records 14 findings.
Nine are real defects (F1, F2, F5, F7, F8, F10, F12, F14-partial — F3/F4/F6/F9/F11/F13
are documentation-only or deliberately-not-a-defect). Not all nine fit one
wave:

| Finding | Decision | Why |
| --- | --- | --- |
| F1 | **IN — Task 1** | One branch in one page component's ladder, contained. |
| F2 | **IN — Task 2** | Copy-only, `plural()` already exists and is used elsewhere in this repo — no new i18n machinery needed. |
| F3, F4 | **IN — Task 3** | Comment-only, FINDINGS.md's own Status lines say "fix whenever the file is next touched" — this wave touches both files for F1/F8's own reasons, so do it now. |
| F5 | **IN, SCOPED DOWN — Task 8** | Re-researched below: the full fix (a tagged result type) has THREE production call sites outside the billing page (`pass-credit.ts`, `lib/billing.ts`), not one — bigger than FINDINGS.md's entry implied. W8 ships the safe, contained half (the outage is no longer silent — it is logged) and defers the page's distinct-error-state UI to a follow-up wave, which is a real, recorded scope-down, not a silent partial fix. |
| F6 | **OUT — defer** | FINDINGS.md's own Status line: "larger than the small mechanical fixes… better suited to a dedicated task" (four locale dictionaries plus a `CANCEL_REASONS` key per reason, on a money-adjacent dialog). Confirmed still true by inspection — untouched by this plan. |
| F7 | **OUT — defer** | FINDINGS.md's own Status line: "a schema column plus a re-send/copy affordance plus supersede-on-remint, which is a task, not an inline fix." Confirmed still true — no session has scoped this since W4. |
| F8 | **IN — Task 4** | One merge-check mirroring an existing pattern (`age_min`/`age_max`), one file, one existing test file with the exact spot already marked. |
| F10 | **IN — Task 5** | Two `.ok` checks in an e2e helper. Trivial, low risk (test infra, not production src). |
| F12 | **IN — Task 6** | Same shape as F8, mirrors an existing pattern in the SAME file. Exact test spot already marked. |
| F14 | **IN (option a only) — Task 7** | See below: option (b)'s true cost is bigger than FINDINGS.md estimated. Option (a) ships now; (b) is recorded as a NEW, more accurately scoped finding for a later wave. |

**`design §10`'s "at minimum the `/admin/settings` dead Save" bar is
ALREADY CLEARED.** `_INDEX.md:141-142` records the ORIGINAL programme-numbered
F1 (`/admin/settings` Save enabled for a `support`-role staff user, 401) as
**FIXED** at `fdbe826b5`, and F2 (`Number("") === 0` zeroing the platform fee)
as **FIXED** at `f9ab8e5f7` — both landed in W1, per Recommendation 1 in
`_INDEX.md`'s "Recommendations I made" section. Confirmed these commits exist
on `origin/main`'s history (`git log --oneline | grep -E 'fdbe826b5|f9ab8e5f7'`
— re-run this yourself before starting; do not trust this line alone). This is
a NON-ISSUE for W8 — nothing to do here.

**F14's true scope, corrected from FINDINGS.md's estimate.** FINDINGS.md
calls option (b) "a client mirror rule in `validateConfigState` plus its unit
case" — cheap. It is not. `ConfigFieldKey`
(`apps/web/src/components/registration-hub-save-error.ts:19-37`) has NO
`"free_agent_fee_cents"` member at all, and `ROUTABLE_FIELDS` (same file,
`:45-64`) has no entry for it either — there is no render site
(`[data-field-error="free_agent_fee_cents"]`) anywhere in
`registration-hub-config-panel.tsx` for this field. A real option (b) needs:
(1) add the type member, (2) add it to `ROUTABLE_FIELDS`, (3) add a render
site in the panel's money section, (4) add the `validateConfigState` mirror
rule, AND (5) fix `MESSAGE_FIELD_PATTERNS`
(`registration-hub-save-error.ts:84-92`) — its
`/card entry fees must be at least/i` pattern currently routes BOTH guards'
identical error string to `"fee_cents"` unconditionally, so a real
`free_agent_fee_cents` 422 today renders on the WRONG field. That is a small,
real, second defect this research surfaced — record it as **F15** (new, this
plan's own finding) rather than silently absorbing it into an already-passing
task. W8 ships option (a) only (Task 7); F15 and full option (b) are OUT,
recorded for W8's own follow-up or a dedicated future wave.

**F5's true scope, corrected from FINDINGS.md's estimate.**
`getBillingOverview` (`apps/web/src/server/usecases/billing-manage.ts:247`)
has a legitimate early return for "no customer" BEFORE its `try` block
(`:249`, `if (!sub?.stripe_customer_id) return null;`) — so the `catch {
return null; }` at the end of the function (confirm current line number; was
`:316-319` in the finding's own citation) is EXCLUSIVELY the fetch-failed
case already, no null-customer conflation inside the catch itself. Good news:
a fix does not need to disentangle two meanings inside one catch. Bad news:
`getBillingOverview` has exactly ONE production caller, the billing page
itself (`app/o/[orgSlug]/settings/billing/page.tsx:128`). **[CORRECTED W8
Task 8 review — this paragraph originally claimed "THREE callers beyond the
billing page", naming `pass-credit.ts` and `lib/billing.ts`; both only
mention the function in JSDoc prose and neither imports it. The claim was
copied verbatim into FINDINGS.md's F5 Status and had to be retracted there
too — do not re-derive it from here.]** So a return-TYPE change (e.g. to a
tagged `{ok:true,data}|{ok:false,reason}` union, which is what a real
distinct-UI fix needs) does NOT ripple widely; what makes that fix big is
the page side — a visible error state, its four-locale copy, and re-gating
`CancelSubscriptionButton`. Task 8 below ships the
safe subset: log the swallowed error (so the outage is observable in
Sentry/logs, closing "with no log" from the finding) without changing the
function's signature or any caller. The page-level distinct-error-UI half of
F5 (closing "no distinction… silently drops Cancel's own preconditions")
stays open, deferred alongside F6/F7 — update F5's own FINDINGS.md Status
line to say so explicitly rather than leaving it silently half-true.

**Mutation sweep scope (design §9, "one sweep at W3, one at W8").** W3's own
sweep (`_INDEX.md`, "W3 Task 5") mutated exactly 7 server-side GATES — one
`requireOrgRole`/`requireFeature`/ownership-count predicate per matrix spec
that exists to prove it, each independently killed and restored. W4-W7 did
heavy PER-TASK mutation testing during their own SDD loops (verified: W6's
task reports alone show ~14 mutants), but that covered VALIDATION BOUNDS
(zod refinements, capacity/fee ranges) — a different class from W3's sweep,
which was specifically ENTITLEMENT/ROLE/OWNERSHIP gates. No dedicated,
cross-file sweep of W4-W7's entitlement gates has happened. Task 9 below
sweeps these, confirmed by direct source read (`grep -rn "requireFeature"`
across the wave's usecases), analogous in kind and size to W3's 7:

| # | File:line | Gate | Proven by |
| --- | --- | --- | --- |
| 1 | `usecases/competitions.ts:312` | `requireFeature(orgId, "discovery.listed")` (create) | `settings-competition-gates.spec.ts` |
| 2 | `usecases/competitions.ts:517` | `requireFeature(orgId, "discovery.listed")` (patch) | `settings-competition-gates.spec.ts` |
| 3 | `usecases/competitions.ts:520` | `requireFeature(orgId, "discovery.branding")` | `settings-competition-gates.spec.ts` |
| 4 | `usecases/divisions.ts:625` | `requireFeature(orgId, "formats.advanced", competitionId)` | confirm which spec exercises `auto_progress` — re-derive during Task 9, do not assume |
| 5 | `usecases/divisions.ts:631` | `requireFeature(orgId, "news.auto", competitionId)` | confirm which spec exercises `auto_posts` — re-derive during Task 9 |
| 6 | `usecases/registrations.ts:1804` | `requireFeature(orgId, "registration.enabled")` | confirm which spec — re-derive during Task 9 |
| 7 | `usecases/registrations.ts:1858` | `requireFeature(orgId, "registration.paid", …)` | `settings-registration-bounds.spec.ts` (W7's card-fee Connect-gate proof already exercises this — confirm it actually reddens on deletion, or find the real prover, before counting it proven) |
| 8 | `usecases/sponsors.ts:102` | `requireFeature(orgId, "sponsors.tiers", …)` | `settings-sponsor-monetize.spec.ts` |
| 9 | `usecases/sponsors.ts:380` | `requireFeature(orgId, "sponsors.monetize", …)` | `settings-sponsor-monetize.spec.ts` |

Gates 4-6 have no spec cited above because this research did not trace them
to a specific existing matrix test in the time available — Task 9's FIRST
step is to find (or confirm the absence of) that coverage before mutating,
exactly as W3's own sweep did per-gate. If a gate has NO existing matrix spec
that would redden, that is itself a finding to record (an untested
entitlement gate), not a silent skip.

**This wave's OWN new guards also enter the sweep** (Tasks 1-7 add: F1's
`view.orgCap === null` branch condition, F8's stored-row date-order check,
F12's stored-row cutoff merge check, F14's new API-layer test's own
assertion) — Task 9 runs after Tasks 1-8 are all committed, and mutates
those too, alongside the 9 pre-existing gates above.

**"Programme review" — ruling.** Neither the design doc nor `_RULES.md`
define this as a distinct deliverable beyond the wave table's one-line
mention (design §4: "W8 | Fix wave + programme review | — | + second
mutation sweep"). No session before this one scoped it further. Simplest
reasonable reading, adopted here: the standard SDD final whole-branch review
already reviews this wave's full diff; "programme review" is satisfied by
that review ALSO reading (not just skimming) `FINDINGS.md` in full and
`_INDEX.md`'s "Recommendations I made" section, confirming every fixed
finding's Status line is updated to FIXED with its commit SHA (Task 10,
below), and confirming no OTHER open recommendation in `_INDEX.md` was
missed. This is stated explicitly here so a later session does not invent a
separate, larger "audit every wave's code" task that nothing in this
programme has ever asked for.

## Global Constraints

- `pnpm@10.34.5`, `node >=26`. Fresh worktree: `pnpm install`, then
  `db:apply` + `sync:sports`.
- **This is the programme's first production-code wave.** Every task that
  touches `apps/web/src` (Tasks 1, 2, 3, 4, 6, 7's option-a is test-only,
  8) ships a regression test in the SAME task that fails without the fix —
  confirm the fail by reverting the fix locally and re-running, per
  design §9, before committing.
- Any new or changed user-facing string → all 4 locale dictionaries
  (`en`, `es`, `fr`, `nl`, under `apps/web/src/dictionaries/`), then
  `npm run i18n:gen-keys` from the repo root (regenerates
  `i18n-keys.ts` — never hand-edit it). Tasks 1 and 2 both touch strings.
- One org per spec file (existing pattern), seeded and released per this
  programme's established, twice-enforced pattern: `if (comp) await
  releaseCompetition(...); if (org) await releaseSettingsOrg(...)` —
  independently guarded per-resource. Where a task extends an EXISTING spec
  file (Tasks 1, 2, 4, 6, 7), follow that file's own existing seed/release
  shape exactly — do not introduce a second pattern in the same file.
- Mutation-testing discipline for every new guard this wave adds (design
  §9): delete or invert the predicate, confirm the covering matrix spec
  reddens, restore via `cp -p` backup (never `git checkout`), re-confirm
  green. Tasks 1, 4, 6 each need this for their own new guard, in addition
  to Task 9's dedicated sweep.
- Helper placement: page-driving/seed helpers → `settings-support.ts` or
  `helpers.ts` if reusable, else file-local. Specs → `e2e/walkthrough/`
  only, never a helper file there.
- `test.describe.configure({ mode: "default" })`, never `serial`. No
  `waitForTimeout`. No screenshots, no axe.
- Read the dictionary's real current key before writing an assertion or a
  fix — every dict snippet in this plan needs re-confirming against the
  live file (keys drift; this plan's own snippets are a starting point, not
  a source of truth).
- Budget reporting: same fast-path bucket as W1-W7 (`_INDEX.md`'s running
  total, currently ~149-165s through W7) — report this wave's new/extended
  test time against it. No real-money leg is added by this wave.

---

### Task 1: F1 — an enterprise-plan org's add-ons tab stops offering an upgrade it cannot use

**Files:**
- Modify: `apps/web/src/app/o/[orgSlug]/settings/add-ons/page.tsx`
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`
- Modify: `apps/web/e2e/walkthrough/settings-add-ons-drive.spec.ts`

**Interfaces:**
- Consumes: `view.orgCap` (`null` = unlimited), `view.addonAvailable`,
  `view.priceMinor` — all already produced by `getAddOnsTab`
  (`apps/web/src/server/usecases/add-ons-tab.ts`), unchanged by this task.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Read the current branch ladder exactly**

`apps/web/src/app/o/[orgSlug]/settings/add-ons/page.tsx:77-90` (re-confirm
these line numbers against the live file first):

```tsx
{!view.addonAvailable || view.priceMinor === null ? (
  <p className="rounded-xl border border-purple-100 bg-purple-50/50 p-4 text-sm text-slate-600">
    {t(dict, "addOns.communityNotice")}
  </p>
) : !view.hasLiveSubscription ? (
  ...
```

An org whose plan has `orgCap === null` (unlimited — `enterprise` today) also
fails `view.addonAvailable` (no `org_addons` catalog row for that plan), so it
falls into the SAME first arm as a Community org, telling it to "upgrade to
Pro" right below a summary line that already said its plan sets no limit.

- [ ] **Step 2: Add a new dictionary key, all 4 locales**

`apps/web/src/dictionaries/en/ui.json` — add next to `addOns.communityNotice`:

```json
"addOns.unlimitedNotice": "Your plan already covers unlimited organisations — there is nothing to add here.",
```

Add the equivalent to `es/ui.json`, `fr/ui.json`, `nl/ui.json` (translate
faithfully; do not leave English in a non-English file). Run
`npm run i18n:gen-keys` from the repo root and confirm it exits 0 and
`i18n-keys.ts` picks up the new key (grep it in the regenerated file).

- [ ] **Step 3: Add the new branch, ahead of the existing ladder**

```tsx
{view.orgCap === null ? (
  <p className="rounded-xl border border-purple-100 bg-purple-50/50 p-4 text-sm text-slate-600">
    {t(dict, "addOns.unlimitedNotice")}
  </p>
) : !view.addonAvailable || view.priceMinor === null ? (
  <p className="rounded-xl border border-purple-100 bg-purple-50/50 p-4 text-sm text-slate-600">
    {t(dict, "addOns.communityNotice")}
  </p>
) : !view.hasLiveSubscription ? (
  ...
```

The unlimited check must come FIRST — an unlimited-cap org also fails
`addonAvailable`, so ordering it after `communityNotice` would never be
reached.

- [ ] **Step 4: Write the failing regression test first**

Extend `apps/web/e2e/walkthrough/settings-add-ons-drive.spec.ts`. Read its
existing `seedStray`/`setOrgSubscriptionSql`/`ui()` helpers (already imported
in this file — do not re-derive or duplicate them) before writing. Add a new
test near the existing `communityNotice` test (~line 514):

```ts
test("an enterprise org (unlimited cap) is not told to upgrade to Pro", async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  test.setTimeout(budget(1, 0));
  const enterprise = await seedStray(request, { plan: "community", label: "W8-addons-enterprise" });
  try {
    await setOrgSubscriptionSql(enterprise.orgId, {
      plan_key: "enterprise",
      status: "active",
      stripe_subscription_id: `sub_e2e_addons_ent_${enterprise.orgId.slice(0, 8)}`,
    });
    await page.goto(routes.addOns(enterprise.slug));
    await expect(page.getByText(ui("addOns.unlimitedNotice"))).toBeVisible({ timeout: READ_MS });
    await expect(page.getByText(ui("addOns.communityNotice"))).toHaveCount(0);
  } finally {
    await releaseSettingsOrg(request, enterprise);
  }
});
```

`seedStray`'s own `opts.plan` type is `"community" | "pro"` — seed as
`"community"` (cheapest valid literal) then override via
`setOrgSubscriptionSql` directly, same two-step shape the file's own
`makeGroupLive` helper uses. Confirm `routes.addOns` and `ui()` resolve as
used elsewhere in this file (they do, per the file's existing tests) before
trusting this snippet verbatim.

- [ ] **Step 5: Run it, confirm it FAILS against the pre-fix code**

Temporarily stash Step 3's change (`git stash push -- apps/web/src/app/o/\[orgSlug\]/settings/add-ons/page.tsx`
is unsafe per this repo's worktree rules — instead `cp -p` the file before
editing it, apply the fix, and to prove the RED state, revert to the `cp -p`
copy temporarily, re-run, confirm red, then re-apply the fix from the copy
you made of the FIXED version). Run:

```bash
cd apps/web && PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/w8-t1.json npx playwright test --project=walkthrough --workers=1 -g "enterprise org"
```

Expected on the pre-fix code: the new test fails (`unlimitedNotice` never
renders). On the fixed code: passes.

- [ ] **Step 6: Run the whole file, JSON reporter, confirm no other regression**

```bash
cd apps/web && PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/w8-t1-full.json npx playwright test --project=walkthrough --workers=1 e2e/walkthrough/settings-add-ons-drive.spec.ts
```

- [ ] **Step 7: Mutation-test the new guard**

`cp -p` the page file, delete the new `view.orgCap === null` branch (fold
back to the original ladder), confirm the new test reddens, restore from the
`cp -p` backup, `diff` empty, re-confirm green.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/app/o/\[orgSlug\]/settings/add-ons/page.tsx \
        apps/web/src/dictionaries/en/ui.json apps/web/src/dictionaries/es/ui.json \
        apps/web/src/dictionaries/fr/ui.json apps/web/src/dictionaries/nl/ui.json \
        apps/web/src/lib/i18n-keys.ts \
        apps/web/e2e/walkthrough/settings-add-ons-drive.spec.ts
git commit -m "fix(settings): F1 — an unlimited-cap org is not told to upgrade to Pro"
```

---

### Task 2: F2 — `addOns.cap.summaryUnlimited` gets a real plural rule

**Files:**
- Modify: `apps/web/src/app/o/[orgSlug]/settings/add-ons/page.tsx`
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`
- Modify: `apps/web/e2e/walkthrough/settings-add-ons-drive.spec.ts`

**Interfaces:**
- Consumes: `plural(dict, key, count, locale, vars?)` from
  `apps/web/src/lib/i18n.ts` (already exported, already used elsewhere —
  e.g. `apps/web/src/app/o/[orgSlug]/page.tsx:207` — do not reinvent it).
- Produces: nothing later tasks depend on. Can run independently of Task 1
  (touches the same page file — sequence AFTER Task 1 to avoid a merge
  conflict on the same lines; SDD runs tasks sequentially by default so this
  is automatic, not something to engineer).

- [ ] **Step 1: Confirm the current key and call site**

`apps/web/src/app/o/[orgSlug]/settings/add-ons/page.tsx` (re-confirm line
number against the live file — Task 1 will have shifted it slightly):

```tsx
const capSummary =
  view.orgCap === null
    ? t(dict, "addOns.cap.summaryUnlimited", { count: view.liveOrgCount })
    : t(dict, "addOns.cap.summary", { count: view.liveOrgCount, cap: view.orgCap });
```

`apps/web/src/dictionaries/en/ui.json` currently has ONE flat key:
`"addOns.cap.summaryUnlimited": "Using {count} organisations on this bill — your plan sets no limit."`
— no plural split. Confirm this is still the exact current value before
editing (dictionary content can drift).

- [ ] **Step 2: Split the key into `.one`/`.other`, all 4 locales**

Follow the exact precedent at `apps/web/src/dictionaries/en/ui.json`'s
`board.ai.repair.title.one`/`.other` pair. Replace the single
`addOns.cap.summaryUnlimited` key in EACH of `en`, `es`, `fr`, `nl` with:

```json
"addOns.cap.summaryUnlimited.one": "Using {count} organisation on this bill — your plan sets no limit.",
"addOns.cap.summaryUnlimited.other": "Using {count} organisations on this bill — your plan sets no limit.",
```

(Translate `es`/`fr`/`nl` faithfully — do not copy the English string into
them.) Run `npm run i18n:gen-keys` and confirm it exits 0.

- [ ] **Step 3: Switch the call site from `t()` to `plural()`**

```tsx
const locale = await resolveLocale(); // already present earlier in this file — reuse it, do not re-derive
const capSummary =
  view.orgCap === null
    ? plural(dict, "addOns.cap.summaryUnlimited", view.liveOrgCount, locale)
    : t(dict, "addOns.cap.summary", { count: view.liveOrgCount, cap: view.orgCap });
```

Add `plural` to this file's existing `import { getDictionary, t } from
"@/lib/i18n"` line (re-check the exact current import statement — it may
already list other named imports). Confirm `resolveLocale()` is already
called earlier in this file (it is, for `getDictionary`) — reuse that
binding, do not call it twice.

- [ ] **Step 4: Write the failing regression test first**

Extend `settings-add-ons-drive.spec.ts` — a variant of Task 1's new test, or
a small addition to it if Task 1's test already puts an enterprise org at
exactly 1 org (check: `seedSettingsOrg`/`seedStray` typically creates the org
itself as the group's only member, so `liveOrgCount` starts at 1 — confirm
this live rather than assuming). If Task 1's test already has an enterprise
org showing 1 org, extend that same test with one more assertion instead of
seeding a second org:

```ts
await expect(page.getByText("Using 1 organisation on this bill")).toBeVisible({ timeout: READ_MS });
await expect(page.getByText("Using 1 organisations on this bill")).toHaveCount(0);
```

Anchor on the exact singular/plural noun boundary ("organisation" vs
"organisations"), not a substring both share.

- [ ] **Step 5: Run it, confirm RED on pre-fix code, then GREEN on fixed code** — same procedure as Task 1 Step 5.

- [ ] **Step 6: Run the whole file, JSON reporter, confirm no regression** — same command as Task 1 Step 6.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app/o/\[orgSlug\]/settings/add-ons/page.tsx \
        apps/web/src/dictionaries/en/ui.json apps/web/src/dictionaries/es/ui.json \
        apps/web/src/dictionaries/fr/ui.json apps/web/src/dictionaries/nl/ui.json \
        apps/web/src/lib/i18n-keys.ts \
        apps/web/e2e/walkthrough/settings-add-ons-drive.spec.ts
git commit -m "fix(settings): F2 — addOns.cap.summaryUnlimited gets a real plural rule"
```

---

### Task 3: F3 + F4 — two stale comments, comment-only, no test owed

**Files:**
- Modify: `apps/web/src/lib/org-addons.ts`
- Modify: `apps/web/src/app/api/billing/extra-orgs/route.ts`
- Modify: `apps/web/src/server/usecases/add-ons-tab.ts`

**Interfaces:** none — comment text only, zero behavior change.

- [ ] **Step 1: F3 — correct the false "Pro Plus" catalog claim**

`apps/web/src/lib/org-addons.ts`'s module header, `orgAddonPriceMinor`'s doc
comment, and `setExtraOrgs`'s doc comment (re-find the exact current line
numbers — this plan does not pin them, confirm by reading the file fresh)
describe "$9/mo Pro, $19/mo Pro Plus" and argue the two rates are load-bearing.
There is no `pro_plus` plan row today (confirm live:
`select distinct plan_key from plans` should show `community, enterprise,
event_pass, event_pass_l, pro` — no `pro_plus`), and
`config/stripe-plans.json`'s `org_addons` holds exactly one entry (`pro`).
Rewrite each of the three comments to state the CURRENT catalog shape (one
rider, `pro` only) rather than the two-tier one, and drop the "would let Pro +
extras undercut Pro Plus" argument since there is no Pro Plus to undercut.

The identical stale claim also appears in
`apps/web/src/app/api/billing/extra-orgs/route.ts` (re-find the line — cited
around `:13` in FINDINGS.md, re-confirm) — correct it there too, in the same
task, since FINDINGS.md's own F3 entry says both sites move together.

- [ ] **Step 2: F4 — correct the false "no plan grants unlimited" claim**

`apps/web/src/server/usecases/add-ons-tab.ts` (cited around `:141-142` in
FINDINGS.md, re-confirm) states "No plan grants unlimited `orgs.max_owned`, so
`orgCap === null` means a staff override with a null `int_value`" — false
since V393 added `enterprise` with `orgs.max_owned` unlimited (confirm live:
`select orgs_max_owned from plan_entitlements where plan_key = 'enterprise'`
— or the equivalent current column/table shape, re-derive if the schema has
moved). Rewrite the comment to name BOTH cases `orgCap === null` can mean: a
staff override, OR a plan (today: `enterprise`) whose catalog entry is
genuinely unlimited. The `capReduced` LOGIC itself needs no change — this is
a documentation-only fix, confirmed by FINDINGS.md's own F4 entry.

- [ ] **Step 3: Confirm no test asserts the old comment text** (none should —
comments are not assertable) and run `cd apps/web && npx tsc --noEmit` to
confirm the comment-only edits compile clean (should be a no-op for `tsc`,
confirms nothing else broke).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/org-addons.ts apps/web/src/app/api/billing/extra-orgs/route.ts \
        apps/web/src/server/usecases/add-ons-tab.ts
git commit -m "docs(settings): F3+F4 — correct two stale add-ons catalog comments"
```

---

### Task 4: F8 — a partial PATCH can no longer leave a competition ending before it starts

**Files:**
- Modify: `apps/web/src/server/usecases/competitions.ts`
- Modify: `apps/web/src/server/api-v1/schemas.ts` (comment only — the code
  is unchanged, but the comment becomes TRUE once this task lands, so
  re-read it and confirm it no longer needs a correction rather than leaving
  it stale in the other direction)
- Modify: `apps/web/e2e/walkthrough/settings-competition-gates.spec.ts`

**Interfaces:**
- Consumes: `ENDS_BEFORE_STARTS` (exported constant,
  `apps/web/src/server/api-v1/schemas.ts:71` — re-confirm the exact line),
  the `HttpError` class already imported in `competitions.ts`.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Read `patchCompetition`'s existing merge-check pattern for `age_min`/`age_max` in the SIBLING file, `divisions.ts`, before writing this one**

`apps/web/src/server/usecases/divisions.ts:647-662` (re-confirm) is the model
to mirror — merge the patch against the STORED row inside the same
transaction, check the merged pair, throw a 422 with the existing exported
message constant if it's invalid. Do not invent a different shape.

- [ ] **Step 2: Add `starts_on`/`ends_on` to the existing `before` select**

`apps/web/src/server/usecases/competitions.ts`, inside `patchCompetition`'s
`withTenant` callback (re-confirm line — was `:535-538` in this research):

```ts
const [before] = await tx<
  { visibility: string; discoverable: boolean; status: string; name: string; slug: string;
    starts_on: string | null; ends_on: string | null }[]
>`
  select visibility, discoverable, status, name, slug, starts_on, ends_on from competitions where id = ${id}`;
```

- [ ] **Step 3: Add the merge-check, mirroring `divisions.ts`'s shape**

Immediately after the `before` null-check (`if (!before) throw new
HttpError(404, "competition not found");`):

```ts
if (patch.starts_on !== undefined || patch.ends_on !== undefined) {
  const mergedStarts = patch.starts_on !== undefined ? patch.starts_on : before.starts_on;
  const mergedEnds = patch.ends_on !== undefined ? patch.ends_on : before.ends_on;
  if (mergedStarts && mergedEnds && mergedEnds < mergedStarts) {
    throw new HttpError(422, ENDS_BEFORE_STARTS);
  }
}
```

Import `ENDS_BEFORE_STARTS` from `../api-v1/schemas` if not already imported
in this file (check the existing import block first).

- [ ] **Step 4: Confirm `schemas.ts`'s comment no longer needs a correction**

`api-v1/schemas.ts:65-68` (re-confirm) already SAYS a re-check exists in the
use-case — that was false before this task and becomes TRUE after it. Read
the comment fresh once Step 3 lands; if its wording still accurately
describes the merge-check you just wrote, leave it. If it describes a
DIFFERENT shape than what you actually built, correct it to match reality
(do not leave a now-partially-wrong comment just because it happened to
become less wrong).

- [ ] **Step 5: Move the existing test assertion from "NOT asserted, deliberately" to a real assertion**

`apps/web/e2e/walkthrough/settings-competition-gates.spec.ts` already marks
the exact spot (re-confirm around line 722-745, the long comment block
starting "WHAT THIS TEST DOES NOT COVER, and it is not an oversight"). Replace
that comment block with a real test:

```ts
// F8, fixed: the same inversion assembled across TWO requests is now refused
// exactly like the same inversion in ONE request, above.
const secondPatch = await patchComp(request, comp.id, { ends_on: "2027-01-01" });
// `starts_on = 2027-06-01` from the earlier `allowed` patch above is still stored.
expect(secondPatch.status, `cross-request inversion must be refused: ${JSON.stringify(v1Error(secondPatch))}`).toBe(422);
expect(v1Error(secondPatch)?.message ?? JSON.stringify(secondPatch.error)).toContain(L.endsBeforeStarts);

const afterRefused = await readComp(request, comp.id);
expect(afterRefused.ends_on, "a refused patch must not have written the new end date").toBe("2027-06-01");
```

Confirm the exact response shape (`v1Error`, `L.endsBeforeStarts` or the raw
`ENDS_BEFORE_STARTS` string) matches this file's own existing helpers before
trusting this snippet — read the file's imports and the `allowed`/`dateIssue`
assertions immediately above the spot for the established pattern.

- [ ] **Step 6: Run it, confirm RED then GREEN** (same procedure as Task 1
Step 5, this file instead).

- [ ] **Step 7: Mutation-test the new guard** — `cp -p` `competitions.ts`,
delete the new merge-check block, confirm the test reddens (422 becomes
200), restore, `diff` empty, re-confirm green.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/server/usecases/competitions.ts \
        apps/web/e2e/walkthrough/settings-competition-gates.spec.ts
git commit -m "fix(settings): F8 — refuse a competition PATCH that leaves it ending before it starts"
```

---

### Task 5: F10 — `invalidateOrgEntitlements` no longer fails silently open

**Files:**
- Modify: `apps/web/e2e/helpers.ts`

**Interfaces:**
- Consumes/modifies: `invalidateOrgEntitlements(request, orgId)`
  (`apps/web/e2e/helpers.ts:961-985`, re-confirm), used by 3+ existing
  specs — do not change its signature, only its internal behavior.
- Produces: nothing later tasks depend on. This is test infrastructure, not
  production `apps/web/src` code — the "4 locale dictionaries" constraint
  does not apply.

- [ ] **Step 1: Read the current implementation exactly**

```ts
export async function invalidateOrgEntitlements(
  request: APIRequestContext,
  orgId: string,
): Promise<void> {
  const setStaff = (on: boolean) => setOwnerStaffSql(orgId, on);
  const KEY = "e2e.cache.bust";
  await setStaff(true);
  try {
    await request.fetch(`/api/admin/orgs/${orgId}/entitlement-override`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      data: { feature_key: KEY, reason: "e2e: drop cached entitlements after SQL flip" },
    });
    await request.fetch(`/api/admin/orgs/${orgId}/entitlement-override`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      data: { feature_key: KEY },
    });
  } finally {
    await setStaff(false);
  }
}
```

Neither `fetch` call's response status is checked — a 5xx or a dropped
connection is silently ignored and the caller proceeds believing the cache
was cleared.

- [ ] **Step 2: Add status checks that throw on failure**

```ts
export async function invalidateOrgEntitlements(
  request: APIRequestContext,
  orgId: string,
): Promise<void> {
  const setStaff = (on: boolean) => setOwnerStaffSql(orgId, on);
  const KEY = "e2e.cache.bust";
  await setStaff(true);
  try {
    const setRes = await request.fetch(`/api/admin/orgs/${orgId}/entitlement-override`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      data: { feature_key: KEY, reason: "e2e: drop cached entitlements after SQL flip" },
    });
    if (!setRes.ok()) {
      throw new Error(`invalidateOrgEntitlements: set override failed (${setRes.status()}) for org ${orgId}`);
    }
    const clearRes = await request.fetch(`/api/admin/orgs/${orgId}/entitlement-override`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      data: { feature_key: KEY },
    });
    if (!clearRes.ok()) {
      throw new Error(`invalidateOrgEntitlements: clear override failed (${clearRes.status()}) for org ${orgId}`);
    }
  } finally {
    await setStaff(false);
  }
}
```

- [ ] **Step 3: Confirm every existing caller still passes**

Find every call site (`grep -rn "invalidateOrgEntitlements(" apps/web/e2e`)
and run each of their spec FILES (not a `-g` slice) with the JSON reporter.
All should stay green — this change only adds a throw on a path that was
already broken; it must not fire on the HAPPY path any existing spec relies
on.

- [ ] **Step 4: Prove the new throw actually fires — a real regression proof for test infrastructure**

Write a small, throwaway-in-spirit-but-committed proof: a scratch test (or an
addition to one of the existing 3 callers' spec files, whichever this
programme's convention prefers — check how W5's own finding-fix for the
SAME helper was tested, if it was) that mocks or forces a failing response
(e.g. `page.route`/`request` interception is not available on a bare
`APIRequestContext` call from a Node-side helper test — instead, temporarily
point at a garbage org id that 404s, or use `request.fetch` directly in a
throwaway confirming the new `if (!setRes.ok())` branch throws for a 404).
If no clean way to force a real failure exists without over-engineering,
mutation-test instead: `cp -p` the file, delete both `if (!...ok())` checks,
confirm... there is nothing to redden them against without a real failure —
in that case, document in the commit message that this fix is proven by
CODE REVIEW and the existing-callers-still-green check (Step 3) rather than
a dedicated failure-injection test, and say why (no failure-injection seam
exists yet for this specific fetch pair). This is a legitimate, recorded
limitation, not a shortcut to hide.

- [ ] **Step 5: Commit**

```bash
git add apps/web/e2e/helpers.ts
git commit -m "fix(settings): F10 — invalidateOrgEntitlements no longer fails silently open"
```

---

### Task 6: F12 — a PATCH can no longer orphan one half of the age cutoff

**Files:**
- Modify: `apps/web/src/server/usecases/divisions.ts`
- Modify: `apps/web/e2e/walkthrough/settings-registration-bounds.spec.ts`

**Interfaces:**
- Consumes: `AGE_CUTOFF_BOTH_OR_NEITHER`, `AGE_CUTOFF_DAY_INVALID_FOR_MONTH`,
  `isValidCutoffDay` (`apps/web/src/lib/registration-rules.ts:228`,
  re-confirm) — `isValidCutoffDay` needs importing into `divisions.ts` if
  not already there (check the existing import block first).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Add the merge-check, mirroring the `age_min`/`age_max` block in the SAME file**

`apps/web/src/server/usecases/divisions.ts`, inside `patchDivision`'s
`withTenant` callback, immediately after the existing `age_min`/`age_max`
merge-check block (`:647-684`, re-confirm — this is the block that already
does exactly this shape for the sibling pair):

```ts
if (patch.age_cutoff_month !== undefined || patch.age_cutoff_day !== undefined) {
  const [currentCutoff] = await tx<{ age_cutoff_month: number | null; age_cutoff_day: number | null }[]>`
    select age_cutoff_month, age_cutoff_day from divisions where id = ${id}`;
  if (!currentCutoff) throw new HttpError(404, "division not found");
  const mergedMonth = patch.age_cutoff_month !== undefined ? patch.age_cutoff_month : currentCutoff.age_cutoff_month;
  const mergedDay = patch.age_cutoff_day !== undefined ? patch.age_cutoff_day : currentCutoff.age_cutoff_day;
  if ((mergedMonth != null) !== (mergedDay != null)) {
    throw new HttpError(422, AGE_CUTOFF_BOTH_OR_NEITHER);
  }
  if (mergedMonth != null && mergedDay != null && !isValidCutoffDay(mergedMonth, mergedDay)) {
    throw new HttpError(422, AGE_CUTOFF_DAY_INVALID_FOR_MONTH);
  }
}
```

Confirm `AGE_CUTOFF_BOTH_OR_NEITHER`/`AGE_CUTOFF_DAY_INVALID_FOR_MONTH` are
already imported into `divisions.ts` (they should be, for
`isAgeCutoffCheckViolation`'s own use at `:842` — reuse that import, do not
add a duplicate).

- [ ] **Step 2: Correct `schemas.ts`'s comment the same way Task 4 did for `ENDS_BEFORE_STARTS`**

`api-v1/schemas.ts:263-267` (re-confirm) currently claims a merge-and-validate
backstop exists for the cutoff pair (via `isAgeCutoffCheckViolation`) — that
claim is now TRUE for the both-or-neither half (Step 1 adds it), but the
comment's SPECIFIC reasoning ("no merge-and-validate/DB-race backstop is
needed for this one, unlike age_min/age_max... this can only ever be
evaluated with both present") is now inaccurate in the other direction — it
argued NO merge check was needed, and this task just added one anyway
(correctly — the ORIGINAL argument had a hole, per F12's own root-cause: an
explicit `null` is not "absent" the way the argument assumed). Rewrite this
comment to state what is actually true post-fix: the both-or-neither and
day-validity checks are enforced on the MERGED value, exactly like
`age_min`/`age_max`, closing the explicit-null gap F12 found.

- [ ] **Step 3 (optional, judgment call — decide during execution, not before): the DB CHECK rewrite**

FINDINGS.md's F12 entry suggests, as an OPTIONAL hardening,
`num_nulls(age_cutoff_month, age_cutoff_day) <> 1` as a replacement for
`divisions_age_cutoff_check`. This is a schema migration — genuinely outside
this task's "one merge-check" scope and this programme has never shipped a
schema migration mid-wave. SKIP this for W8; the application-layer fix in
Step 1 closes the real defect (the API now refuses the orphan write) even
though the CHECK constraint itself remains structurally unable to catch it —
which is fine, since the API layer is now the enforcement point, matching
how `age_min`/`age_max`'s own merge-check works alongside a CHECK that has
the same structural gap. Do not add a migration to this task; if a future
session wants the belt-and-braces DB constraint, that is its own small task.

- [ ] **Step 4: Turn the existing "NOT asserted here, deliberately" comment into a real assertion**

`apps/web/e2e/walkthrough/settings-registration-bounds.spec.ts:341-350`
(re-confirm — the comment inside `"cutoff both-or-neither..."`, immediately
after the `dayOnly` assertion and before the `bothNull` positive-pair
assertion). Replace the comment block with:

```ts
// F12, fixed: an explicit null on ONE half is now refused exactly like a
// value on one half — the merge-check compares against the STORED other half.
await patchDivision(request, div.id, { age_cutoff_month: 9, age_cutoff_day: 1 }); // establish a real pair first
const dayNulled = await patchDivision(request, div.id, { age_cutoff_day: null });
expectCutoffIssue(dayNulled, AGE_CUTOFF_BOTH_OR_NEITHER, "explicit null on age_cutoff_day alone");
const readBack = await apiJson<{ age_cutoff_month: number | null; age_cutoff_day: number | null }>(
  request, `/api/v1/divisions/${div.id}`, "GET",
);
expect(readBack.data?.age_cutoff_month, "a refused patch must not have orphaned the stored month").toBe(9);
expect(readBack.data?.age_cutoff_day, "a refused patch must not have written the explicit null").toBe(1);
```

Confirm `expectCutoffIssue`'s exact signature and `apiJson`'s import are
already present in this file (they are, per W7's own commits) before
trusting this snippet verbatim — this file already has both helpers.

- [ ] **Step 5: Run it, confirm RED then GREEN.**

- [ ] **Step 6: Mutation-test the new guard** — `cp -p` `divisions.ts`,
delete the new cutoff merge-check block, confirm the test reddens, restore,
`diff` empty, re-confirm green.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/server/usecases/divisions.ts \
        apps/web/e2e/walkthrough/settings-registration-bounds.spec.ts
git commit -m "fix(settings): F12 — refuse a PATCH that orphans one half of the age cutoff"
```

---

### Task 7: F14 (option a) — server-side test coverage for `free_agent_fee_cents`'s minimum, and record F15 (the misrouting bug this research found)

**Files:**
- Modify: `apps/web/e2e/walkthrough/settings-registration-bounds.spec.ts`
- Modify: `docs/superpowers/specs/2026-09-03-settings-walkthrough-prompts/FINDINGS.md`

**Interfaces:** none new — test-only, no production code change (option (a)
only; option (b) and F15 are explicitly OUT of this task, see §0).

- [ ] **Step 1: Add the API-layer test for the free-agent fee minimum**

Mirror Task 2's own pattern in the SAME file (search for the existing
"card entry fee below 1.00 is refused server-side" test — extend near it, do
not duplicate its Connect-account setup if it is already in this file's
`beforeAll`). This guard sits AHEAD of the Connect gate (confirmed in §0),
so unlike the `fee_cents` proof, this one does NOT need a Connect account
attached first:

```ts
test("free_agent_fee_cents below 1.00 is refused, even with no Connect account attached", async ({ request }) => {
  const div = await seedDivision(request, comp.id, { name: `W8 bounds free-agent-fee ${TAG()}` });
  try {
    await patchDivision(request, div.id, { entrant_kind: "team" });
    const res = await apiJson(request, `/api/v1/divisions/${div.id}/registration-settings`, "PUT", {
      enabled: true, entrant_kind: "team", payment_method: "stripe",
      fee_cents: 0, allow_free_agents: true, free_agent_fee_cents: 50, approval: "auto",
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.error)).toContain("Card entry fees must be at least 1.00");

    const accepted = await apiJson(request, `/api/v1/divisions/${div.id}/registration-settings`, "PUT", {
      enabled: true, entrant_kind: "team", payment_method: "stripe",
      fee_cents: 0, allow_free_agents: true, free_agent_fee_cents: 100, approval: "auto",
    });
    expect(accepted.status).toBeLessThan(300);
  } finally {
    await releaseDivision(request, div.id);
  }
});
```

Confirm `entrant_kind: "team"` genuinely needs setting via a separate PATCH
first (division defaults may already be `"team"` — check `DEFAULT_SETTINGS`
or the seed default before assuming this PATCH is necessary) and confirm
`fee_cents: 0` does not ITSELF trip the main fee-minimum guard (0 is the
documented "free" value, per `registrations.ts`'s own `> 0 && < 100`
condition — 0 should pass through untouched) before trusting this snippet.

- [ ] **Step 2: Run it, confirm it passes against the UNCHANGED server** — this
is coverage for EXISTING correct behavior, not a fix, so there is no RED
state to prove here; confirm the test is not vacuous by temporarily changing
`50` to `150` and confirming it now fails the first assertion (proves the
test can distinguish pass/fail), then restore.

- [ ] **Step 3: Record F15 — the misrouting bug this plan's own research found**

Add a new entry to `FINDINGS.md`'s `## W8` section (create it, following the
exact format of the `## W4`-`## W7` sections above it):

```markdown
## W8

### F15 (real, low severity, documentation only — NOT fixed) — a `free_agent_fee_cents` 422 renders on the WRONG field

Found: W8 planning research, while scoping F14's option (b).

`ConfigFieldKey` (`apps/web/src/components/registration-hub-save-error.ts:19-37`)
has no `"free_agent_fee_cents"` member, and `MESSAGE_FIELD_PATTERNS`
(same file, `:84-92`)'s `/card entry fees must be at least/i` pattern matches
BOTH `fee_cents`'s and `free_agent_fee_cents`'s identical error string and
routes it unconditionally to `"fee_cents"`. So a real
`free_agent_fee_cents` 422 (this wave's own Task 7 proves the server throws
it) renders as a field error on `fee_cents` — the WRONG input — rather than
on the free-agent fee field, which has no render site to route to anyway.

**Status:** open, not fixed this wave. A real fix needs: adding
`"free_agent_fee_cents"` to `ConfigFieldKey` and `ROUTABLE_FIELDS`, a render
site in the panel's money section, a `validateConfigState` mirror rule (the
option (b) FINDINGS.md's own F14 entry originally proposed), and
disambiguating `MESSAGE_FIELD_PATTERNS`'s pattern (the two guards throw an
IDENTICAL string server-side, so the client cannot tell them apart from the
message alone — the fix likely needs the server to throw two distinguishable
messages, or the client to infer from which of the two fields is non-null in
the outgoing PUT body). Bigger than the "client mirror rule" F14 originally
estimated — recommend a dedicated follow-up task, not an inline fix.
```

- [ ] **Step 4: Wire into `e2e-ci-wiring.test.ts`** — the test file itself
is already wired (extended, not new); confirm the vitest inventory test
still passes unchanged (no new file to add).

- [ ] **Step 5: Commit**

```bash
git add apps/web/e2e/walkthrough/settings-registration-bounds.spec.ts \
        docs/superpowers/specs/2026-09-03-settings-walkthrough-prompts/FINDINGS.md
git commit -m "test(settings): F14(a) — free_agent_fee_cents minimum server-side coverage; record F15"
```

---

### Task 8: F5 (scoped down) — a Stripe outage on `/settings/billing` is no longer silent

**Files:**
- Modify: `apps/web/src/server/usecases/billing-manage.ts`
- Modify: `docs/superpowers/specs/2026-09-03-settings-walkthrough-prompts/FINDINGS.md`

**Interfaces:** none — the function's return type and every caller's contract
are UNCHANGED by this task (deliberately, see §0's scope-down).

- [ ] **Step 1: Read the current catch block exactly**

`apps/web/src/server/usecases/billing-manage.ts` (re-confirm current line —
was cited around `:316-319`):

```ts
  } catch {
    return null;
  }
}
```

Confirm this catch sits AFTER the legitimate `if (!sub?.stripe_customer_id)
return null;` early return (near the top of the function, `:249`) — the two
`return null`s mean different things at the call site today (no customer vs.
fetch failed), and this task does NOT disentangle that (see §0) — it only
makes the fetch-failed case OBSERVABLE.

- [ ] **Step 2: Add logging, keep the swallow**

```ts
  } catch (err) {
    logger.error({ err, orgId }, "getBillingOverview: Stripe fetch failed, rendering as no-customer");
    return null;
  }
}
```

Confirm this file already imports a `logger` (check the top of the file for
an existing import from this repo's logging module — every other usecase
file in this programme uses one; do not invent a new logging mechanism).
If none is imported here yet, add the same import this repo's other usecase
files use (e.g. `registrations.ts`, `divisions.ts` — check their import
block for the exact module path).

- [ ] **Step 3: Update F5's own FINDINGS.md Status line to reflect the real scope-down**

Find F5's entry (`## W4` section) and replace its `**Status:**` paragraph
with:

```markdown
**Status:** PARTIALLY fixed, W8 (`<commit sha — fill in after commit>`). The
outage is no longer silent — `getBillingOverview`'s catch now logs the
failure. The page-level distinct-error-state half (Cancel subscription
staying visible, Retry/PromoBox/IntervalSwitcher silently disappearing, with
no visible indication anything went wrong) is DEFERRED — a real fix needs a
visible distinct-error UI state on the billing page, four-locale copy for it,
a re-gate of `CancelSubscriptionButton`, and a return type that separates all
THREE of the function's null producers, which is a bigger, coordinated change
than this wave's contained-fix bar. Recommend a dedicated future task,
alongside F6/F7.
```

**[CORRECTED W8 Task 8 review]** the template above originally gave the
deferral reason as "its three callers (`pass-credit.ts`, `lib/billing.ts`,
and this page)". That is FALSE — see the correction at the head of this
task's preamble. `getBillingOverview` has ONE production caller. The
deferral stands on its cost, not on a caller count.

- [ ] **Step 4: Run the relevant unit/vitest coverage for `billing-manage.ts` to confirm the logging addition doesn't change behavior**

```bash
cd apps/web && npx vitest run src/server/usecases/__tests__/billing-overview-passes.test.ts --reporter=json --outputFile=/tmp/w8-t8.json
```

Confirm the same pass count as before this task's change (a log call must
not change any return value or throw).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/usecases/billing-manage.ts \
        docs/superpowers/specs/2026-09-03-settings-walkthrough-prompts/FINDINGS.md
git commit -m "fix(settings): F5 (partial) — a Stripe outage on billing is now logged, not silent"
```

---

### Task 9: the second mutation sweep — 9 pre-existing entitlement gates plus this wave's own 3 new guards

**Files:** none created or modified except a scratch log of the sweep's
results, appended to `_INDEX.md` (see Step 4).

**Interfaces:** consumes every gate listed in §0's table, plus Tasks 1, 4, 6's
new guards (already individually mutation-tested in their own tasks — this
sweep RE-CONFIRMS them as part of one coherent pass, per design §9's "one
sweep at W3, one at W8" being a single dedicated pass, not a rely-on-scattered-
per-task-kills substitute).

- [ ] **Step 1: For each of the 9 gates in §0's table, confirm (or find) the matrix spec that proves it**

Gates 1-3, 8-9 already have a cited prover. Gates 4-7 do not — before
mutating, grep the relevant matrix spec file(s) for a test that would
plausibly redden if the gate were deleted (e.g. for gate 4,
`formats.advanced`, check `settings-schedule-drive.spec.ts` and
`settings-schedule-bounds.spec.ts` for any `auto_progress` case; for gate 7,
re-check whether W7's card-fee Connect-gate test genuinely depends on
`registration.paid` firing, or only on `charges_enabled`). If a gate has NO
prover, do not mutate it blind — record it as a NEW finding (an untested
entitlement gate) rather than silently skipping it or writing a throwaway
spec never intended to be committed (per W3's own precedent for its mutant 6,
which used a disposable scratch spec exactly for this situation — follow
that precedent if needed).

- [ ] **Step 2: Mutate each gate, one at a time, `cp -p` before each, `diff` empty after each**

Same procedure as W3's own Task 5: comment out or `.catch(() => undefined)`
the predicate, run the WHOLE affected spec file (never a `-g` slice), confirm
it reddens for the RIGHT reason (read the actual failure, not just "it
failed"), restore, confirm `diff` empty before the next mutation. Use a real
`seazn-env rebuild --label <yours>` between mutations that touch server code
requiring a rebuild to take effect (confirm whether this repo's dev/test
setup needs a rebuild for a usecase-file change or picks it up live — check
how W3's own sweep handled this, since it explicitly used `seazn-env rebuild`
between mutations).

- [ ] **Step 3: Re-confirm Tasks 1, 4, 6's own guards as part of this same pass**

These were individually mutation-tested inside their own tasks already — this
step is a lightweight re-confirmation (re-run the specific test each proved,
without re-mutating, since the mutation already happened once per-task) to
fold them into ONE coherent sweep record rather than three scattered ones.

- [ ] **Step 4: Write the sweep's results table to `_INDEX.md`**

Follow the exact format of "### W3 Task 5 — the mutation sweep: 7/7 killed,
all restores byte-identical" (`_INDEX.md`, re-find the section) — a
`## W8 Task 9` subsection with the same columns (`#`, `File:line`,
`Mutation`, `Killed by`, `Observed redden`), one row per gate actually
mutated, plus a note for any gate found to have no prover (recorded as its
own finding, not silently dropped).

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-09-03-settings-walkthrough-prompts/_INDEX.md
git commit -m "test(settings): W8 Task 9 — second mutation sweep, entitlement gates"
```

(If Step 1 surfaces an untested gate as a genuine new finding, add it to
`FINDINGS.md` in the SAME commit, following F1-F15's established format.)

---

## Final whole-branch review focus

Beyond the standard rubric: (a) confirm every regression test added in Tasks
1, 2, 4, 6 genuinely reddens on the PRE-fix code (the implementer's own
report must show this, not just claim it — re-derive if the report is
ambiguous); (b) confirm Task 3's comment-only changes touch NO logic, only
comment text (a `git diff` scan, not a claim); (c) confirm Task 5's status
checks don't break any of `invalidateOrgEntitlements`'s 3+ existing callers
(re-run their spec FILES, not a slice); (d) confirm Task 6's Step 3 decision
(skip the DB CHECK rewrite) was actually followed — no migration file should
appear in this branch's diff; (e) confirm Task 7's F15 entry accurately
describes what Task 7 itself did NOT fix (it should read as a scope
boundary, not an apology); (f) confirm Task 8's logging addition genuinely
changes nothing about `getBillingOverview`'s return value or any caller's
behavior (a `git diff` on the three other call sites should show ZERO
changes); (g) confirm Task 9's sweep actually ran against the WHOLE affected
spec files (never a `-g` slice, per this programme's own AGENTS.md class 21
lesson) and that every "no prover found" case was recorded as a finding, not
silently dropped; (h) this is the programme review — also confirm every
finding this wave fixed (F1, F2, F8, F10, F12, F5-partial) has its FINDINGS.md
Status line updated with the real commit SHA, not left saying "open".

## Budget report (fill in from each task's real numbers, owner ruling 8's fast-path bucket)

Cumulative fast-path total through W7 was ~149-165s (see `_INDEX.md`). Report
this wave's new/extended test time (Tasks 1, 2, 4, 6, 7 each add or extend
walkthrough-project test time; Task 8's vitest run and Task 5's helper change
are not walkthrough-project time and do not add to this bucket) summed
against that running total. No real-money leg is added.
