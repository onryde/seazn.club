# Directory Walkthroughs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four Playwright walkthrough specs that drive `/directory`'s players, officials, venues and clubs journeys end-to-end through the real UI, plus the shared kit they need.

**Architecture:** Four new spec files under `apps/web/e2e/walkthrough/` (auto-selected by the existing `walkthrough` project — no config or CI edit), and one shared non-spec module at `apps/web/e2e/directory-kit.ts`. Setup reaches state via the API; every step that IS the thing under test is typed, tapped or uploaded. Each spec owns its data by unique-suffixing every name it creates, and the two specs that need a non-Pro plan mint their own org.

**Tech Stack:** Playwright (`@playwright/test`), TypeScript 7, Node 26, pnpm. Vitest for the wiring guard. `scripts/smoke.ts` for smoke.

**Spec:** `docs/superpowers/specs/2026-09-03-directory-walkthroughs-design.md`

## Global Constraints

Copied verbatim from the spec and from `docs/superpowers/RULES.md`. Every task's requirements implicitly include this section.

- **Never place a helper under `e2e/walkthrough/`.** `WALKTHROUGH = /[\\/]e2e[\\/]walkthrough[\\/]/` matches *any* file in that folder, so a helper there is selected as a spec and Playwright rejects the run with `test file "X" should not import test file "helpers.ts"`. The kit goes at `apps/web/e2e/directory-kit.ts`.
- **Setup may use the API to REACH a state; every step that IS the thing under test must be DONE THROUGH THE UI** — tapped, typed, submitted — and the system's own record must agree with it.
- **`AUTH_STATE` is `e2e/.auth/pro.json` — the shared PRO org.** A free-plan assertion made against it is vacuous. Any COUNT made against it counts the whole run's leftovers.
- **Scope every count to a per-spec unique token.** Never assert a global total.
- **A fresh org gets its OWN billing group** (`POST /api/orgs` → `createOrgForUser`, `lib/auth.ts:303`, which inserts a new `subscriptions` row). No `splitOrgIntoOwnGroupSql` call is needed. `setOrgPlanBySql` is nonetheless group-scoped (`helpers.ts:441-449`).
- **Never hardcode a plan limit value.** Read it live. `pro_plus` is being deleted and `enterprise` added by an in-flight branch; write against `"pro" | "community"` only.
- **Never construct a claim URL.** Read it from `data-testid="claim-link"` and navigate. Constructing it is how a dead link stays green.
- **Bare `browser.newContext()` inherits the owner session.** Spell out `storageState: { cookies: [], origins: [] }`.
- **No test may exceed the 60s default `timeout`.** A spec needing `test.setTimeout` has failed the speed budget and must be split. Where a budget must be raised, express it as a derived cost (`Math.max(FLOOR, base + n * PER_ITEM)`), never a flat constant.
- **`expect.poll`, never `page.waitForTimeout`.**
- **Every spec must be mutated until it goes red before it is trusted.** Named mutants are in each task.
- **Judge a vitest run only from `--reporter=json --outputFile`** (`numPassedTests` / `numTotalTests`), and confirm `.testResults[].name` paths are under this worktree. `rtk` prints `PASS(0) FAIL(0)` for a suite that failed to collect.
- **Prefix `cd <abs worktree> &&` in the same call as every command you judge.** The shell cwd resets to the main checkout between calls.
- **Never `git stash` in this worktree** — the stash stack is shared with the main checkout.
- **`grep -a` always** — this repo reports source files as binary and hides the lines otherwise.
- Worktree: `/Users/ashokhein/github/seazn.club/.claude/worktrees/dir-walkthrough`. Branch: `feat/directory-walkthroughs`.
- **Review after EVERY task, not once at the end.** Each task's final step is a
  `reviewer` dispatch on that task's diff before the next task starts. Batching
  review to the end is how a wave ships past five reviewer passes and is still
  Needs Fixes. A task is not done because its own test is green.
- **Re-run the whole `walkthrough` project at every task boundary**, not just at
  the end — the four new specs share a server with the existing nineteen, and a
  `-g` slice is a filename sweep wearing a costume.
- **A subagent runs only the tests covering the files it changed.** The full
  vitest suite, the full typecheck/lint gate, and the whole `walkthrough`
  Playwright project are run by the CONTROLLER at each task boundary, never
  delegated. `AGENTS.md`: "Never accept 'done, tests pass' without the raw
  counts pasted back. Rerun the gate yourself at the wave boundary." A
  delegated full-suite run costs a subagent's whole context and returns a
  number the controller must re-verify anyway.
- Local env label: `dirw`. `eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label dirw)"` exports `DATABASE_URL` / `SMOKE_BASE` / `PLACEMENT_SERVICE_*`.

---

## File Structure

| file | responsibility |
|---|---|
| `apps/web/e2e/directory-kit.ts` (create) | Shared non-spec module. Fresh-org minting, live entitlement reads, CSV building, and the five venue-card locator helpers lifted from `venues.spec.ts`. **Must not live under `e2e/walkthrough/`.** |
| `apps/web/e2e/__tests__/directory-kit.test.ts` (create) | Vitest over the kit's pure helpers (CSV builder, stamp). |
| `apps/web/e2e/walkthrough/directory-player-identity.spec.ts` (create) | Two tests: the duplicate queue tells the truth; a claim link is not transferable. |
| `apps/web/e2e/walkthrough/directory-officials-roles.spec.ts` (create) | One test: the `officials.roles_multi` gate asserted in both directions, then invite + claim. |
| `apps/web/e2e/walkthrough/directory-venues-courts.spec.ts` (create) | One test: three courts, a restricted calendar, and the server-computed stranded count. |
| `apps/web/e2e/walkthrough/directory-clubs-import-limits.spec.ts` (create) | One test: New-club form, then multi-CSV import against two caps at two lifecycle stages. |
| `scripts/smoke.ts` (modify) | Add a `directorySuite()` — four tabs plus `/import`. |
| `apps/web/e2e/walkthrough/README.md` (modify) | Add the four rows to the "What is here" table. |

**No edit to `playwright.config.ts`, `.github/workflows/e2e.yml`, or `e2e-ci-wiring.test.ts`.** Selection is by directory regex; four new files in `e2e/walkthrough/` are covered by construction.

---

## Task 1: The shared kit

**Files:**
- Create: `apps/web/e2e/directory-kit.ts`
- Create: `apps/web/e2e/__tests__/directory-kit.test.ts`

**Interfaces:**
- Consumes: `TAG`, `apiJson`, `loginUi`, `setEntitlementOverrideSql` from `apps/web/e2e/helpers.ts`. **Does not edit that file** — it is being changed concurrently on another branch.
- Produces, relied on by Tasks 2–5:
  - `stamp(): string`
  - `uniqueName(label: string): string`
  - `freshOrg(page: Page, label: string): Promise<{ orgId: string; email: string }>`
  - `liveLimit(page: Page, orgId: string, key: string): Promise<number | null>`
  - `setEntitlementOverrideSql(orgId, featureKey, intValue)` (re-exported from `helpers.ts`)
  - `participantCsv(rows: ReadonlyArray<{ club: string; team: string; player: string }>): string`
  - `findContainer(root, containerSelector, label, value): Promise<Locator | null>`
  - `findVenueCard(page, venueName): Promise<Locator | null>`
  - `waitForVenueCard(page, venueName): Promise<Locator>`
  - `findCourtRow(page, venueName, courtName): Promise<Locator | null>`
  - `waitForCourtRow(page, venueName, courtName): Promise<Locator>`

- [ ] **Step 1: Write the failing unit test**

Create `apps/web/e2e/__tests__/directory-kit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { participantCsv, uniqueName } from "../directory-kit";

describe("participantCsv", () => {
  it("emits a header row the importer recognises", () => {
    const csv = participantCsv([{ club: "Harbour", team: "Harbour U13", player: "Ada" }]);
    expect(csv.split("\n")[0]).toBe("Club,Team,Player");
  });

  it("emits one row per entry and no trailing newline", () => {
    const csv = participantCsv([
      { club: "A", team: "A1", player: "P1" },
      { club: "B", team: "B1", player: "P2" },
    ]);
    expect(csv.split("\n")).toHaveLength(3);
    expect(csv.endsWith("\n")).toBe(false);
  });

  // A club name carrying a comma must not become two columns. Without quoting,
  // "Harbour, West" shifts Team into Player and the import silently plans the
  // wrong entities rather than failing.
  it("quotes a field containing a comma", () => {
    const csv = participantCsv([{ club: "Harbour, West", team: "T", player: "P" }]);
    expect(csv.split("\n")[1]).toBe('"Harbour, West",T,P');
  });

  it("escapes an embedded double quote by doubling it", () => {
    const csv = participantCsv([{ club: 'The "Reds"', team: "T", player: "P" }]);
    expect(csv.split("\n")[1]).toBe('"The ""Reds""",T,P');
  });
});

describe("uniqueName", () => {
  it("keeps the label as a prefix so a spec can still read the row", () => {
    expect(uniqueName("Court A")).toMatch(/^Court A /);
  });

  // Two calls in the same process must not collide: every count in these specs
  // is scoped by this string.
  it("does not repeat across calls", () => {
    const seen = new Set(Array.from({ length: 200 }, () => uniqueName("x")));
    expect(seen.size).toBe(200);
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/dir-walkthrough/apps/web && \
npx vitest run e2e/__tests__/directory-kit.test.ts --reporter=json \
  --outputFile=/tmp/dirkit.json > /dev/null 2>&1; echo "EXIT=$?"; \
node -e 'const r=require("/tmp/dirkit.json");console.log(r.numTotalTests,r.numPassedTests,r.numFailedTestSuites)'
```

Expected: the suite fails to COLLECT — `numFailedTestSuites: 1`, `numTotalTests: 0`, because `../directory-kit` does not exist. **A collection failure reports `numFailedTests: 0`; judge on `numFailedTestSuites` and `numTotalTests`, not on the failure count.**

- [ ] **Step 3: Write the kit**

Create `apps/web/e2e/directory-kit.ts`. Lift the five venue helpers **verbatim** from `apps/web/e2e/venues.spec.ts:26-108` (`uniqueName`, `findContainer`, `findVenueCard`, `findCourtRow`, `waitForVenueCard`, `waitForCourtRow`) — they are already correct and already used; do not reimplement them. Then add:

```ts
import { expect, type Page, type Locator } from "@playwright/test";
import { TAG, apiJson, loginUi, setEntitlementOverrideSql } from "./helpers";

export function stamp(): string {
  return `${TAG}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * A signed-in user with an org of its own.
 *
 * Every directory spec needs one. The walkthrough project's storageState is
 * e2e/.auth/pro.json — one PRO org shared with every other spec in the leg —
 * and the Players tab renders only the OLDEST 200 persons (page.tsx:106 passes
 * limit 200; listPersons orders by created_at). So a person created late in a
 * shared org is not merely hard to count, it is not on the page, and a
 * "no duplicate was suggested" assertion passes for the wrong reason.
 *
 * A fresh org also arrives on the COMMUNITY plan for free: createOrgForUser
 * (lib/auth.ts:303) inserts plan_key 'community' and stamps the new
 * subscription onto the org, so the org is alone in its own billing group and
 * needs no splitOrgIntoOwnGroupSql call.
 *
 * The caller must set `test.use({ storageState: { cookies: [], origins: [] } })`
 * at FILE scope. A bare browser.newContext() inherits the owner session.
 */
export async function freshOrg(page: Page, label: string): Promise<{ orgId: string; email: string }> {
  const s = stamp();
  const email = `dir-${label}-${s}@example.com`;
  await loginUi(page, email, "/");
  const created = await apiJson<{ id: string }>(page.request, "/api/orgs", "POST", {
    name: `${label} ${s}`,
  });
  const orgId = created.data?.id;
  if (!orgId) throw new Error(`freshOrg: POST /api/orgs returned no id (status ${created.status})`);
  return { orgId, email };
}

/**
 * The org's CURRENT effective limit for `key`.
 *
 * Never hardcode a limit in a spec: the plan catalog is re-valued independently
 * of this suite. Returns null for unlimited, a number otherwise, and THROWS
 * when the key is absent from the org's plan — getLimit resolves a missing
 * matrix row to 0 and refuses everything, so an absent row must fail loudly
 * here rather than surface as a confusing 402 several steps later.
 *
 * Read through the API, NOT raw SQL. GET /api/orgs/{id}/entitlements resolves
 * every value through lib/entitlements' own getLimit, so it agrees with
 * enforcement by construction. That route used to union overrides in raw SQL
 * itself, and its own header records what that cost: "no expires_at filter, no
 * comped_until degradation and no past_due grace -- and it coalesced int_value,
 * which silently demoted every staff 'unlimited' grant to the plan's number."
 * A hand-rolled query in this kit would reintroduce exactly that drift, and it
 * would drift silently, in the direction of a SMALLER cap.
 */
export async function liveLimit(page: Page, orgId: string, key: string): Promise<number | null> {
  const res = await apiJson<{
    plan_key: string;
    entitlements: Record<string, { limit?: number | null; enabled?: boolean }>;
  }>(page.request, `/api/orgs/${orgId}/entitlements`, "GET");
  const body = res.data;
  if (!body) throw new Error(`liveLimit: GET entitlements failed (status ${res.status})`);
  const row = body.entitlements[key];
  if (row === undefined) {
    throw new Error(
      `liveLimit: plan "${body.plan_key}" has no matrix row for "${key}" -- ` +
        `getLimit would resolve it to 0 and refuse everything`,
    );
  }
  if (!("limit" in row)) throw new Error(`liveLimit: "${key}" is a boolean feature, not a quota`);
  return row.limit ?? null;
}

/** Re-export so a spec sets a deterministic cap without importing two modules.
 *  Org-scoped: org_entitlement_overrides is PRIMARY KEY (org_id, feature_key)
 *  (db/migration/deltas/V101__billing.sql:66-73), so it cannot leak into
 *  another spec's org. */
export { setEntitlementOverrideSql };

/** RFC4180 quoting: a field containing a comma, quote or newline is quoted and
 *  its own quotes doubled. Without this a club name with a comma shifts every
 *  later column and the importer plans the wrong entities silently. */
function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** A participant sheet. `Club`/`Team`/`Player` are recognised header aliases
 *  (import-parse.ts HEADER_ALIASES: clubname/club, team/teamname, player/...). */
export function participantCsv(
  rows: ReadonlyArray<{ club: string; team: string; player: string }>,
): string {
  return [
    "Club,Team,Player",
    ...rows.map((r) => [r.club, r.team, r.player].map(csvCell).join(",")),
  ].join("\n");
}
```

Two facts this code relies on, both already verified — do not re-derive them,
and do not quietly work around them either:

- `withDb` is **not exported** from `helpers.ts` (`:289` is a bare
  `async function`). That is why `liveLimit` goes through the API. Do **NOT**
  add an `export` to it: `helpers.ts` is being edited concurrently on
  `feat/entitlements-w2-matrix-plumbing`, and a one-word change there is still
  a conflict in a file someone else is rewriting.
- `setEntitlementOverrideSql` **is** exported (`helpers.ts:473`) and writes
  `org_entitlement_overrides`, whose PRIMARY KEY is `(org_id, feature_key)`
  (`db/migration/deltas/V101__billing.sql:66-73`), so its upsert is safe.

- [ ] **Step 4: Run the unit test and verify it passes**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/dir-walkthrough/apps/web && \
npx vitest run e2e/__tests__/directory-kit.test.ts --reporter=json \
  --outputFile=/tmp/dirkit.json > /dev/null 2>&1; echo "EXIT=$?"; \
node -e 'const r=require("/tmp/dirkit.json");console.log("total",r.numTotalTests,"passed",r.numPassedTests,"failedSuites",r.numFailedTestSuites);r.testResults.forEach(t=>console.log(t.name))'
```

Expected: `total 6 passed 6 failedSuites 0`, and the printed path resolves **inside this worktree**.

- [ ] **Step 5: Prove the kit does not break Playwright's collection**

A file under `e2e/` that is not a spec is fine, but a file under `e2e/walkthrough/` is not. Confirm the kit is selected by no project:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/dir-walkthrough/apps/web && \
npx playwright test --project=walkthrough --list 2>&1 | grep -c "directory-kit"
```

Expected: `0`.

- [ ] **Step 6: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/dir-walkthrough && \
git add apps/web/e2e/directory-kit.ts apps/web/e2e/__tests__/directory-kit.test.ts && \
git commit -m "test(directory): shared kit for the directory walkthroughs"
```

---

## Task 2: Player identity — the duplicate queue tells the truth

**Files:**
- Create: `apps/web/e2e/walkthrough/directory-player-identity.spec.ts`

**Interfaces:**
- Consumes: `freshOrg`, `stamp` (Task 1); `failOnNativeDialog` from `../helpers`.
- Produces, for Task 3 in the SAME file: `roster(page)`, `queue(page)`,
  `addPerson(page, {name, dob?}) => Promise<string>` (returns the person id),
  `escapeRe(s)`. Task 3 must reuse these, never redeclare them.
- **Import `loginUi` only in Task 3**, which is the first user of it. Adding it
  here leaves an unused import and fails lint at this task's own commit.

Two tests in one file. They are split because neither fits the 60s default `timeout` together, and a task that needs `test.setTimeout` has failed the speed budget.

**Selectors — all verified against the tree, do not guess replacements:**

| thing | selector |
|---|---|
| roster table | `page.getByRole("table", { name: "Players" })` |
| add: name | `page.getByLabel("Full name")` (placeholder `Priya Sharma`) |
| add: dob | `page.getByLabel("DOB (eligibility only)")` |
| add: gender | `page.getByLabel("Gender")` (`select`: `""`/`m`/`f`/`x`) |
| add: submit | `page.getByRole("button", { name: "Add player" })` — disabled until name non-blank |
| a person's id | the row's `[data-merge-pick="<personId>"]` attribute |
| queue region | `page.getByRole("region", { name: "Possible duplicates" })` |
| a candidate pair | `li[data-candidate="<aId>:<bId>"]` |
| evidence chip | `li[data-evidence-kind="name"\|"dob"\|"shared_entrant"]` + `data-evidence-on="true"\|"false"` |
| open merge | `[data-review="<aId>:<bId>"]`, name `Review` |
| merge dialog | `page.getByRole("dialog", { name: "Merge two records" })` |
| affirm gate | `[data-affirm="1"]` — the confirm stays disabled until checked |
| confirm merge | `[data-merge-confirm="1"]`, name `Merge records` |
| undo a merge | `[data-undo="<mergeId>"]`, name `Undo` |
| undo dialog | `page.getByRole("dialog", { name: "Undo this merge?" })`, confirm `[data-reverse-confirm="1"]` |

**THE TRAP, and the reason this task exists at all:** all three `data-evidence-kind` chips **always render** (`duplicates-panel.tsx:344`); only `data-evidence-on` distinguishes fired from not-fired. An assertion written as `locator('[data-evidence-kind="dob"]')` + `toBeVisible()` passes whether or not dob evidence fired — it passes on its own inversion. **Every evidence assertion must read `data-evidence-on`.** `person-merge.spec.ts:71,76` already does this; follow it.

- [ ] **Step 1: Write the file header and Test A's failing body**

```ts
import { test, expect, type Page } from "@playwright/test";
import { failOnNativeDialog } from "../helpers";
import { freshOrg, stamp } from "../directory-kit";

/**
 * The organiser's identity journey on /directory?tab=players, driven by hand.
 *
 * Test A asserts the duplicate queue in BOTH directions — that a real duplicate
 * is proposed, and that a same-name pair with DIFFERING dobs is suppressed. The
 * suppression case is the one no existing spec makes, and it is what a
 * "suggest everything" mutant dies on.
 *
 * Test B follows a claim link the way its recipient would, from the page that
 * emitted it, and asserts all four ways a claim is refused.
 *
 * Fresh org, deliberately. The walkthrough project's storageState is the shared
 * PRO org, and the Players tab renders only the OLDEST 200 persons
 * (page.tsx:106 passes limit 200; listPersons orders by created_at) — so a
 * person created late in a shared org is not on the page at all, and every
 * assertion below would pass or fail on who else ran first.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const roster = (page: Page) => page.getByRole("table", { name: "Players" });
const queue = (page: Page) => page.getByRole("region", { name: "Possible duplicates" });

async function addPerson(
  page: Page,
  opts: { name: string; dob?: string },
): Promise<string> {
  await page.getByLabel("Full name").fill(opts.name);
  if (opts.dob) await page.getByLabel("DOB (eligibility only)").fill(opts.dob);
  await page.getByRole("button", { name: "Add player" }).click();
  const row = roster(page).getByRole("row", { name: new RegExp(escapeRe(opts.name)) });
  await expect(row).toBeVisible({ timeout: 15_000 });
  const id = await row.locator("[data-merge-pick]").getAttribute("data-merge-pick");
  if (!id) throw new Error(`no person id on the row for "${opts.name}"`);
  return id;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("the duplicate queue proposes a real pair and suppresses a false one", async ({ page }) => {
  failOnNativeDialog(page);
  const s = stamp();
  await freshOrg(page, "identity");
  await page.goto("/directory?tab=players");

  // One human, entered twice: same folded name, same dob. The queue's entry
  // ticket is a shared normalised name; the matching dob raises the rank.
  const twinName = `Alex Morgan ${s}`;
  const keepId = await addPerson(page, { name: twinName, dob: "1990-04-02" });
  const dupeId = await addPerson(page, { name: twinName, dob: "1990-04-02" });

  // A DIFFERENT human who happens to share the name. A differing non-null dob
  // SUPPRESSES the pair outright (person-duplicates.ts) — it is the strongest
  // evidence in the data that these are two people.
  const otherId = await addPerson(page, { name: twinName, dob: "1986-11-19" });

  await page.reload();

  const pair = queue(page).locator(`[data-candidate="${keepId}:${dupeId}"]`);
  await expect(pair).toBeVisible({ timeout: 15_000 });

  // data-evidence-on, NOT mere presence: all three chips always render, so a
  // presence assertion would pass on its own inversion.
  await expect(pair.locator('[data-evidence-kind="name"]')).toHaveAttribute(
    "data-evidence-on",
    "true",
  );
  await expect(pair.locator('[data-evidence-kind="dob"]')).toHaveAttribute(
    "data-evidence-on",
    "true",
  );

  // The suppression. The third person must appear in NO pair, in either order.
  for (const id of [keepId, dupeId]) {
    await expect(queue(page).locator(`[data-candidate="${otherId}:${id}"]`)).toHaveCount(0);
    await expect(queue(page).locator(`[data-candidate="${id}:${otherId}"]`)).toHaveCount(0);
  }
  // And the queue holds exactly the one pair — assertable only because the org
  // is this spec's own.
  await expect(queue(page).locator("[data-candidate]")).toHaveCount(1);
});
```

- [ ] **Step 2: Run it and verify it fails**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/dir-walkthrough/apps/web && \
eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label dirw)" && \
npx playwright test --project=walkthrough directory-player-identity \
  --reporter=list > /tmp/t2a.log 2>&1; echo "EXIT=$?"; tail -20 /tmp/t2a.log
```

Expected: FAIL — the file does not compile yet if `escapeRe` or the kit import is wrong, or the assertions fail. **Confirm the failure names THIS spec**, not a collection error.

- [ ] **Step 3: Make it pass**

No product code changes should be needed. If the queue does not propose the pair, read `person-duplicates.ts`'s suppression rules again before editing anything: a tombstoned row, a differing lane, or two different non-null `user_id`s each suppress a pair, and a fresh org has none of those.

- [ ] **Step 4: Verify it passes and is under budget**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/dir-walkthrough/apps/web && \
eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label dirw)" && \
npx playwright test --project=walkthrough directory-player-identity \
  --reporter=list > /tmp/t2a.log 2>&1; echo "EXIT=$?"; grep -E "passed|failed|\([0-9]+m?s\)" /tmp/t2a.log | tail -5
```

Expected: `1 passed`. The per-test duration must be **under 60s** — the default `timeout`. If it is not, the spec needs splitting, not a raised timeout.

- [ ] **Step 5: Mutate it — prove it can fail**

Comment out the differing-dob suppressor in `apps/web/src/server/usecases/person-duplicates.ts` (the clause that excludes pairs whose non-null dobs differ), rebuild, and re-run.

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/dir-walkthrough && \
~/.claude/skills/seazn-local-env/scripts/seazn-env.sh rebuild --label dirw && \
cd apps/web && eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label dirw)" && \
npx playwright test --project=walkthrough directory-player-identity --reporter=list 2>&1 | tail -8
```

Expected: **RED**, on the suppression assertion. Then revert the mutation, `rebuild` again, and confirm green. A spec that stays green under this mutation is decoration — do not proceed until it goes red.

- [ ] **Step 6: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/dir-walkthrough && \
git add apps/web/e2e/walkthrough/directory-player-identity.spec.ts && \
git commit -m "test(directory): walkthrough — the duplicate queue in both directions"
```

---

## Task 3: Player identity — a claim link is not transferable

**Files:**
- Modify: `apps/web/e2e/walkthrough/directory-player-identity.spec.ts` (add the second test)

**Interfaces:**
- Consumes: everything Task 2 defined in the same file (`roster`, `queue`, `addPerson`, `escapeRe`, `stamp`, `freshOrg`) — reuse them, do not redeclare.
- **Widen Task 2's import line to `import { failOnNativeDialog, loginUi } from "../helpers";`** — this task is `loginUi`'s first user.

**Selectors:**

| thing | selector |
|---|---|
| invite | `page.getByRole("button", { name: "Invite to claim…" })` (literal ellipsis char) |
| invite dialog | `page.getByRole("dialog", { name: \`Invite ${name} to claim their profile\` })` |
| email field | `page.getByLabel("Their email")` |
| send | `page.getByRole("button", { name: "Send invite" })` |
| the link | `page.getByTestId("claim-link")` — **text content IS the URL** |
| emailed instead | `page.getByTestId("claim-emailed")` |
| revoke | `page.getByRole("button", { name: "Withdraw invite" })` |
| unlink | `page.getByRole("button", { name: "Unlink" })` |
| unlink dialog | `page.getByRole("dialog", { name: "Unlink this player account?" })` |
| claimed badge | text `Claimed` |
| invited badge | text `Invite pending` |
| accept (right user) | `page.getByRole("button", { name: /This is me — claim/ })` |
| refused (wrong user) | heading `Wrong account for this invite` |

**Two traps:**

1. `data-testid="claim-link"` renders **only when `email_sent` is false** (`invite-claim.tsx:181`) — it is the send-failure fallback, which is the normal path with no SMTP. Assert `claim-emailed` has count 0 first, so a configured mailer turns into a clear failure rather than a `null` link.
2. The second user must be a genuinely different browser context with **empty** storage. A bare `browser.newContext()` inherits the owner session and every refusal below passes vacuously.

- [ ] **Step 1: Write the failing test**

```ts
test("a claim link is not transferable, and four things kill it", async ({ page, browser }) => {
  failOnNativeDialog(page);
  const s = stamp();
  await freshOrg(page, "claims");
  await page.goto("/directory?tab=players");

  const personName = `Rae Sandoval ${s}`;
  await addPerson(page, { name: personName });
  const ownerEmail = `claimant-a-${s}@example.com`;
  const strangerEmail = `claimant-b-${s}@example.com`;

  const emptyState = () => ({ storageState: { cookies: [], origins: [] } });

  async function invite(email: string): Promise<string> {
    await page.getByRole("button", { name: "Invite to claim…" }).click();
    const dialog = page.getByRole("dialog", {
      name: `Invite ${personName} to claim their profile`,
    });
    await dialog.getByLabel("Their email").fill(email);
    await dialog.getByRole("button", { name: "Send invite" }).click();
    // The link only renders on the send-FAILURE fallback. If a mailer is
    // configured this goes green-but-empty, so fail loudly instead.
    await expect(
      dialog.getByTestId("claim-emailed"),
      "a mailer sent the invite, so no link is shown — this spec needs the fallback",
    ).toHaveCount(0);
    const link = await dialog.getByTestId("claim-link").textContent();
    if (!link) throw new Error("no claim link rendered");
    await dialog.getByRole("button", { name: "Done" }).click();
    return link.trim();
  }

  /** Opens `url` as a signed-in `email`, from a genuinely empty context. */
  async function asUser<T>(email: string, url: string, fn: (p: Page) => Promise<T>): Promise<T> {
    const ctx = await browser.newContext(emptyState());
    try {
      const p = await ctx.newPage();
      await loginUi(p, email, url);
      return await fn(p);
    } finally {
      await ctx.close();
    }
  }

  // --- 1. the wrong person follows the link -------------------------------
  const link1 = await invite(ownerEmail);
  await asUser(strangerEmail, link1, async (p) => {
    await expect(p.getByRole("heading", { name: "Wrong account for this invite" })).toBeVisible();
    await expect(p.getByRole("button", { name: /This is me — claim/ })).toHaveCount(0);
  });
  await page.reload();
  await expect(page.getByText("Invite pending")).toBeVisible();

  // --- the right person claims it ----------------------------------------
  await asUser(ownerEmail, link1, async (p) => {
    await p.getByRole("button", { name: /This is me — claim/ }).click();
    await expect(p.getByRole("button", { name: /This is me — claim/ })).toHaveCount(0);
  });
  await page.reload();
  await expect(page.getByText("Claimed")).toBeVisible();

  // --- 2. the organiser unlinks ------------------------------------------
  await page.getByRole("button", { name: "Unlink" }).click();
  const unlinkDialog = page.getByRole("dialog", { name: "Unlink this player account?" });
  // tone: "danger" blocks Enter — click, never press.
  await unlinkDialog.getByRole("button", { name: "Unlink" }).click();
  await expect(page.getByText("Claimed")).toHaveCount(0);

  // --- 3. a re-invite kills the previous link ----------------------------
  const link2 = await invite(ownerEmail);
  const link3 = await invite(ownerEmail);
  expect(link3).not.toBe(link2);
  await asUser(ownerEmail, link2, async (p) => {
    // person_claims_open_uq allows ONE open claim; minting link3 revoked link2.
    await expect(p.getByRole("button", { name: /This is me — claim/ })).toHaveCount(0);
  });

  // --- 4. the organiser revokes the open invite --------------------------
  await page.reload();
  await page.getByRole("button", { name: "Withdraw invite" }).click();
  await expect(page.getByText("Invite pending")).toHaveCount(0);
  await asUser(ownerEmail, link3, async (p) => {
    await expect(p.getByRole("button", { name: /This is me — claim/ })).toHaveCount(0);
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Same command as Task 2 Step 2. Expected: FAIL, naming this test.

- [ ] **Step 3: Make it pass**

If the wrong-email case does NOT refuse, that is a real product defect — stop and report it rather than weakening the assertion. The refusal lives in `assertClaimEmail` (`person-claims.ts:299`).

- [ ] **Step 4: Verify green and under 60s**

Same command as Task 2 Step 4. Expected `2 passed` for the file, each test under 60s.

- [ ] **Step 5: Mutate it**

In `apps/web/src/server/usecases/person-claims.ts`, make `assertClaimEmail` return without throwing. Rebuild, re-run.

Expected: **RED** on the "Wrong account for this invite" assertion. Revert, rebuild, confirm green.

- [ ] **Step 6: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/dir-walkthrough && \
git add apps/web/e2e/walkthrough/directory-player-identity.spec.ts && \
git commit -m "test(directory): walkthrough — the four ways a claim link dies"
```

---

## Task 4: Officials — the roles_multi gate, asserted in both directions

**Files:**
- Create: `apps/web/e2e/walkthrough/directory-officials-roles.spec.ts`

**Interfaces:**
- Consumes: `freshOrg`, `stamp` (Task 1); `setOrgPlanBySql`, `failOnNativeDialog` from `./helpers`; `ALL_OFFICIAL_ROLES` from `../../src/lib/official-roles`.

**Selectors:**

| thing | selector |
|---|---|
| add: name | `page.getByLabel("Name", { exact: true })` (real `htmlFor="off-add-name"`) |
| add: submit | `page.getByRole("button", { name: "Add official" })` |
| role chip group | `page.getByRole("group", { name: "Roles" })` |
| one chip | `group.getByRole("button", { name: "chair umpire", exact: true })` |
| chip state | `aria-pressed` — `"true"` when selected |
| the whole selected set | `group.getByRole("button", { pressed: true }).allTextContents()` |
| upgrade gate | `page.locator('[data-feature="officials.roles_multi"]')` |
| an official's row | `page.locator("li").filter({ hasText: name })` |
| invite | `row.getByRole("button", { name: "Invite" })` |
| invite email | `row.getByLabel("Email", { exact: true })` |
| send | `row.getByRole("button", { name: "Send invite" })` |
| the claim link | `row.getByText(/\/claim\/pc_/)` |

**Four traps, every one of which would silently weaken this test:**

1. **A chip's accessible name is the underscore-stripped LOWERCASE string** — `"chair umpire"`, not `"Chair Umpire"`. The capitalisation is CSS. Use `exact: true`.
2. **The default selection is already `["referee"]`**, and a lone chip cannot be deselected (`nextOfficialRoles` keeps ≥1). So do **not** start from `ALL_OFFICIAL_ROLES[0]` — it is already on. Pick indices **1 then 2**.
3. **`data-feature` is the only place the key appears in the DOM.** There is no testid, and the visible text is `featureReason(feature)`. Asserting on the prose would break on a copy edit.
4. **The officials invite does NOT render `data-testid="claim-link"`.** That testid is the persons rail only (`invite-claim.tsx:181`). Here the URL is in a bare `<code>`; match it by text.

`ALL_OFFICIAL_ROLES` is imported rather than hardcoded so a change to the sport presets moves this test with it. Chip order is that array's order — first-seen union of the presets, **not alphabetical**.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "@playwright/test";
import { failOnNativeDialog, setOrgPlanBySql } from "../helpers";
import { freshOrg, stamp } from "../directory-kit";
import { ALL_OFFICIAL_ROLES } from "../../src/lib/official-roles";

/**
 * officials.roles_multi is a Pro entitlement. This drives it from BOTH sides:
 * on the free plan a second pick must SWAP and raise the upgrade gate; on Pro
 * both roles must stick, and survive a reload — the jsonb write, not the
 * client state.
 *
 * An entitlement asserted only on the allowed side is untested: the swap branch
 * is the one a "rolesMultiAllowed = true" mutant kills, and nothing else covers
 * it end to end.
 *
 * Fresh org: the walkthrough storageState is the shared PRO org, where the
 * free-plan half of this test would pass vacuously. A fresh org arrives on
 * community for free (createOrgForUser inserts plan_key 'community').
 */
test.use({ storageState: { cookies: [], origins: [] } });

test("roles_multi swaps on the free plan and sticks on Pro", async ({ page }) => {
  failOnNativeDialog(page);
  const s = stamp();
  const { orgId } = await freshOrg(page, "officials");

  // Derived from the engine's own declarations, never a typed-in table.
  // [0] is "referee" and is selected by default, so start at [1].
  const roleA = ALL_OFFICIAL_ROLES[1];
  const roleB = ALL_OFFICIAL_ROLES[2];
  const label = (r: string) => r.replace(/_/g, " ");

  await page.goto("/directory?tab=officials");
  const name = `Wren Adeyemi ${s}`;
  await page.getByLabel("Name", { exact: true }).fill(name);

  const chips = page.getByRole("group", { name: "Roles" });
  await chips.getByRole("button", { name: label(roleA), exact: true }).click();
  await chips.getByRole("button", { name: label(roleB), exact: true }).click();

  // --- free plan: the second pick SWAPPED, it did not add -----------------
  await expect(
    chips.getByRole("button", { name: label(roleB), exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    chips.getByRole("button", { name: label(roleA), exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(chips.getByRole("button", { pressed: true })).toHaveCount(1);
  await expect(page.locator('[data-feature="officials.roles_multi"]')).toBeVisible();

  await page.getByRole("button", { name: "Add official" }).click();
  const row = page.locator("li").filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 15_000 });

  // --- Pro: both roles stick, and SURVIVE A RELOAD ------------------------
  await setOrgPlanBySql({ orgId }, "pro");
  await page.reload();

  const rowChips = row.getByRole("group", { name: "Roles" });
  await rowChips.getByRole("button", { name: label(roleA), exact: true }).click();
  await expect(rowChips.getByRole("button", { pressed: true })).toHaveCount(2);
  await expect(page.locator('[data-feature="officials.roles_multi"]')).toHaveCount(0);

  await page.reload();
  const persisted = await row
    .getByRole("group", { name: "Roles" })
    .getByRole("button", { pressed: true })
    .allTextContents();
  expect(persisted.map((t) => t.trim()).sort()).toEqual([label(roleA), label(roleB)].sort());

  // --- the official is invited, and the link is real ----------------------
  await row.getByRole("button", { name: "Invite" }).click();
  await row.getByLabel("Email", { exact: true }).fill(`official-${s}@example.com`);
  await row.getByRole("button", { name: "Send invite" }).click();
  await expect(row.getByText(/\/claim\/pc_/)).toBeVisible({ timeout: 15_000 });
});
```

If the row's roles editor is not a `group` named `Roles` (i.e. the row uses a different picker mount than the add form), read `officials-directory-panel.tsx:231` and `:290` and scope to whichever it is. Do **not** fall back to a page-wide `getByRole("group")` — there are two pickers on this page and a page-wide match will hit the add form's.

- [ ] **Step 2: Run and verify it fails**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/dir-walkthrough/apps/web && \
eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label dirw)" && \
npx playwright test --project=walkthrough directory-officials-roles --reporter=list 2>&1 | tail -20
```

- [ ] **Step 3: Make it pass.** No product change expected.

- [ ] **Step 4: Verify green and under 60s.**

- [ ] **Step 5: Mutate it**

In `apps/web/src/app/directory/page.tsx:184`, replace `hasFeature(auth.orgId, "officials.roles_multi")` with `Promise.resolve(true)`. Rebuild, re-run.

Expected: **RED** on the swap assertion (`toHaveCount(1)`) and on the gate's visibility. Revert, rebuild, confirm green.

- [ ] **Step 6: Commit**

```bash
\
git add apps/web/e2e/walkthrough/directory-officials-roles.spec.ts && \
git commit -m "test(directory): walkthrough — roles_multi asserted in both directions"
```

---

## Task 5: Venues — three courts, a restricted calendar, and the stranded count

**Files:**
- Create: `apps/web/e2e/walkthrough/directory-venues-courts.spec.ts`

**Interfaces:**
- Consumes: `freshOrg`, `stamp`, `uniqueName`, `waitForVenueCard`, `waitForCourtRow` (Task 1); `apiJson`, `seedRosteredFixture`, `failOnNativeDialog` from `./helpers`.

**Selectors:**

| thing | selector |
|---|---|
| add venue | `page.getByPlaceholder("e.g. Riverside Sports Centre")` + `getByRole("button", { name: "Add venue", exact: true })` |
| add court | `venueCard.getByPlaceholder("e.g. Court 1")` + `venueCard.getByRole("button", { name: "Add court", exact: true })` — **must be scoped to the venue card**, there is one form per venue |
| open the calendar | `courtRow.getByRole("button", { name: "Hours", exact: true })` (flips to `Hide hours`) |
| open / close time | `getByRole("combobox", { name: "Open" })` / `{ name: "Close" }` |
| add a range | `getByRole("button", { name: "Add a time range" })` — **one per weekday, use `.nth(weekday)`**, Sun=0 |
| exception date | `getByRole("textbox", { name: "Exception date" })` |
| exception closed | `getByRole("checkbox", { name: "Closed all day", exact: true })` |
| add an exception | `getByRole("button", { name: "Add an exception date" })` |
| save | `getByRole("button", { name: "Save calendar", exact: true })` |

**Traps:**

1. **`getByLabel` resolves ZERO matches for the calendar's fields.** They use wrapping `<label>` + `sr-only` span, not `htmlFor` (documented at `venues.spec.ts:140-146`). Use `getByRole` with the accessible name. The venue/court *name* inputs are different — those are real `aria-label`s and `getByLabel` works, which is what `findContainer` relies on.
2. **`Closed all day.` (the weekday `<p>`, with a period) vs `Closed all day` (the exception checkbox, no period).** A non-`exact` match cross-hits. Always pass `exact: true`.
3. **Save is disabled** on `busy || overlap || invalidRange || hasEmptyExceptionDate`. If the click does nothing, read the warning text (`venues.calendar.overlapWarning` / `invalidRangeWarning`) rather than adding a wait.
4. **`outside_court_hours` is ADVISORY** (`calendar.ts:330` excludes it from `isBlockingConflict`). Asserting that the placer avoids the closed window would fail against correct behaviour. Assert it is RAISED and that the fixture still stands.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "@playwright/test";
import { apiJson, failOnNativeDialog } from "../helpers";
import { freshOrg, stamp, uniqueName, waitForVenueCard, waitForCourtRow } from "../directory-kit";
// apiJson is used by the fixture-seeding block below; if that block ends up not
// needing it, drop the import -- an unused import fails lint.

/**
 * A venue with THREE courts (venues.spec.ts has only ever made one), a
 * restricted per-court calendar, and the proof that the restriction reaches
 * the engine.
 *
 * The proof is the SAVE RESPONSE's newlyStrandedFixtureCount, not the form:
 * it is computed server-side from the real placement path, so it cannot be
 * satisfied by the values this spec just typed in. A reload-and-compare would
 * only prove the round-trip.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test("a court's restricted hours reach the scheduler and raise an advisory conflict", async ({
  page,
}) => {
  failOnNativeDialog(page);
  const s = stamp();
  const { orgId } = await freshOrg(page, "venues");

  const venueName = uniqueName("Riverside Sports Centre");
  const courtNames = [uniqueName("Court A"), uniqueName("Court B"), uniqueName("Court C")];

  await page.goto("/directory?tab=venues");
  await page.getByPlaceholder("e.g. Riverside Sports Centre").fill(venueName);
  await page.getByRole("button", { name: "Add venue", exact: true }).click();
  const venueCard = await waitForVenueCard(page, venueName);

  for (const courtName of courtNames) {
    await venueCard.getByPlaceholder("e.g. Court 1").fill(courtName);
    await venueCard.getByRole("button", { name: "Add court", exact: true }).click();
    await waitForCourtRow(page, venueName, courtName);
  }

  // SETUP, via the API deliberately: fixtures on these courts are the state
  // this journey needs to REACH, not the thing under test. This is the real
  // sequence from court-tags-scheduling.spec.ts:604-687 — the auto+apply step
  // is load-bearing, because moveFixture's MOVABLE_STATUS gate refuses a PATCH
  // timetable move on a fixture that was never placed at all.
  const seeded = await seedRosteredFixture(page.request, {
    label: `Riverside ${s}`,
    sportKey: "badminton",
    variantKey: "singles",
    home: [{ name: `Home ${s}` }],
    away: [{ name: `Away ${s}` }],
    entrantKind: "individual",
  });
  const courtIds = await apiJson<{ id: string; name: string }[]>(
    page.request,
    `/api/v1/orgs/${orgId}/venues`,
    "GET",
  );
  // Resolve court 2's id from the venue read, then pin the fixture onto it at a
  // time INSIDE the window the calendar below will close.
  // PatchFixture (schemas.ts:964) is .strict() — court_id and scheduled_at only.
  await apiJson(page.request, `/api/v1/fixtures/${seeded.fixtureId}`, "PATCH", {
    court_id: court2Id,
    scheduled_at: wednesdayAt("10:00"),
  });

  // --- restrict court 2 -------------------------------------------------
  const courtRow = await waitForCourtRow(page, venueName, courtNames[1]);
  await courtRow.getByRole("button", { name: "Hours", exact: true }).click();

  // ONE Wednesday range closes the whole rest of the week. court-windows.ts:165
  // `baseFor`: hours.length === 0 means the full civil day (open all day); but
  // once ANY row exists, :170-173 filters by weekday and every day without a
  // row is CLOSED. So adding 18:00-20:00 on Wednesday both narrows Wednesday
  // and shuts the other six days — which is what strands the 10:00 fixture.
  const WEDNESDAY = 3; // Sun = 0
  await courtRow.getByRole("button", { name: "Add a time range" }).nth(WEDNESDAY).click();
  // A new range defaults to 09:00-17:00 (venues-panel.tsx:973). The time fields
  // are <select>s whose option values are "HH:MM" strings
  // (datetime-field.tsx:176-206; steppedTimes gives 96 quarter-hours).
  // Their labels are sr-only, so getByLabel finds NOTHING — use the role.
  const wednesday = courtRow.getByRole("button", { name: "Add a time range" }).nth(WEDNESDAY);
  await courtRow.getByRole("combobox", { name: "Open" }).last().selectOption("18:00");
  await courtRow.getByRole("combobox", { name: "Close" }).last().selectOption("20:00");

  // Capture the PUT the Save button fires — the response carries the proof.
  const savePromise = page.waitForResponse(
    (r) => /\/courts\/[^/]+\/calendar$/.test(r.url()) && r.request().method() === "PUT",
  );
  await courtRow.getByRole("button", { name: "Save calendar", exact: true }).click();
  const saved = await savePromise;
  const body = (await saved.json()) as {
    data?: { newlyStrandedFixtureCount: number; strandedFixtureCount: number };
  };
  expect(saved.status()).toBe(200);
  expect(
    body.data?.newlyStrandedFixtureCount ?? 0,
    "the calendar write did not strand the fixture — the restriction never reached the engine",
  ).toBeGreaterThan(0);

  // --- it survives a reload --------------------------------------------
  await page.reload();
  const reopened = await waitForCourtRow(page, venueName, courtNames[1]);
  await reopened.getByRole("button", { name: "Hours", exact: true }).click();
  await expect(reopened.getByRole("combobox", { name: "Open" }).last()).toHaveValue("18:00");
  await expect(reopened.getByRole("combobox", { name: "Close" }).last()).toHaveValue("20:00");

  // --- the conflict is raised, and it is ADVISORY -----------------------
  // Asserted through the validate API, NOT the board: the board's copy for this
  // conflict is already pinned by court-tags-scheduling.spec.ts:697-706, and
  // re-asserting it here would duplicate that coverage while proving less.
  // ScheduleConflict (schemas.ts:1548-1592) carries `blocking` — so the API can
  // state the advisory property DIRECTLY, which no board assertion can.
  const validated = await apiJson<{ conflicts: { fixture_id: string; code: string; blocking: boolean }[] }>(
    page.request,
    `/api/v1/divisions/${seeded.divisionId}/schedule/validate`,
    "POST",
    {},
  );
  const courtConflicts = (validated.data?.conflicts ?? []).filter(
    (c) => c.fixture_id === seeded.fixtureId && c.code.includes("court"),
  );
  expect(courtConflicts.length, "no court conflict was raised for the stranded fixture").toBeGreaterThan(0);
  expect(
    courtConflicts.every((c) => c.blocking === false),
    "outside_court_hours is advisory by design (calendar.ts:330) — a blocking one is a behaviour change",
  ).toBe(true);
});
```

Two things the implementer must resolve from the tree, both small and both
checkable — do NOT guess either:

- `court2Id`: read it from `GET /api/v1/orgs/{orgId}/venues` (the venues read
  nests its courts — `listVenues` returns `courts` per venue) and match on
  `courtNames[1]`. Confirm the response shape before destructuring it.
- `wednesdayAt("10:00")`: a helper returning an ISO-8601 string **with offset**
  (`PatchFixture` uses `z.iso.datetime({ offset: true })`) for the next
  Wednesday at 10:00 UTC. Write it in the spec file; keep it pure so it is
  obvious.

Also confirm `seedRosteredFixture`'s returned `divisionId` is the one
`/schedule/validate` wants, and that the fixture reached a status
`moveFixture` will accept — `court-tags-scheduling.spec.ts:604-687` runs
`schedule-settings` → `schedule/auto` → `schedule/apply` before its PATCH for
exactly that reason. If the bare PATCH 4xxs, add those three calls rather than
weakening the assertion.

- [ ] **Step 2: Run and verify it fails.** Command as Task 4 Step 2, with `directory-venues-courts`.

- [ ] **Step 3: Fill the two blanks and make it pass.**

- [ ] **Step 4: Verify green and under 60s.**

- [ ] **Step 5: Mutate it**

In `apps/web/src/server/usecases/court-candidates.ts`, make `resolveCourtCalendars` return an empty map. Rebuild, re-run.

Expected: **RED** on `newlyStrandedFixtureCount`. This is the mutation that matters: it proves the number comes from the engine's view of the calendar and not from the form. Revert, rebuild, confirm green.

- [ ] **Step 6: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/dir-walkthrough && \
git add apps/web/e2e/walkthrough/directory-venues-courts.spec.ts && \
git commit -m "test(directory): walkthrough — court hours reach the placer"
```

---

## Task 6: Clubs — multi-CSV import against two caps at two lifecycle stages

**Files:**
- Create: `apps/web/e2e/walkthrough/directory-clubs-import-limits.spec.ts`

**Interfaces:**
- Consumes: `freshOrg`, `stamp`, `liveLimit`, `setEntitlementOverrideSql`, `participantCsv` (Task 1); `failOnNativeDialog` from `./helpers`.

**Selectors:**

| thing | selector |
|---|---|
| new club | `page.getByRole("button", { name: "New club" })` |
| club name draft | `page.getByLabel("Club name")` (key `clubs.list.newClubPrompt`) |
| create | `page.getByRole("button", { name: "Create" })` |
| import link | `page.getByRole("link", { name: "Import" })` → `/import` |
| file input | `page.locator('input[type="file"]')` — **upload fires on change, there is no submit** |
| preview heading | `page.getByRole("heading", { name: /^Preview — / })` |
| stats line | text `{clubs} clubs · {teams} teams · {persons} players · …` (middot-separated) |
| commit | `page.getByRole("button", { name: "Commit import" })` — becomes `Fix errors to commit` when any issue is `severity:"error"`, so `/commit import/i` will NOT match the error state |
| committed | `page.getByRole("heading", { name: "Import committed" })` |
| upgrade gate | `page.locator('[data-feature="clubs.max"]')` / `[data-feature="import.bulk"]` |

**Traps:**

1. **`liveLimit` asserts the catalog, the override drives the journey.** These are two jobs. Reading the live value proves the matrix row exists (a *missing* row resolves to 0 and refuses everything — that must fail loudly, not as a confusing 402 three steps later). The override then gives a small deterministic cap so the CSVs stay tiny. Deriving the journey from Pro's real `clubs.max` would mean importing 25+ clubs.
2. **The two caps fire at different stages.** `clubs.max` is checked at **commit** (`imports.ts:301,429`); `import.bulk` is checked at **create/upload** (`imports.ts:122`). A spec that only exercises one is proving one gate twice.
3. **`commitImport` is one transaction, all-or-nothing** (`imports.ts:281`). The "club count unchanged after the refusal" assertion is what proves that, and it is the assertion a non-transactional mutant dies on.
4. The wizard reads `error.feature_key` (not `error.feature`) and mounts a **non-compact** `UpgradeGate`, so the DOM carries `div[data-feature="…"]`.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "@playwright/test";
import { failOnNativeDialog } from "../helpers";
import {
  freshOrg,
  stamp,
  liveLimit,
  setEntitlementOverrideSql,
  participantCsv,
} from "../directory-kit";

/**
 * The organiser's bulk-load journey: one club by hand, then CSVs through
 * /import until a plan cap refuses one — and the proof that the refusal wrote
 * nothing.
 *
 * Two caps, two lifecycle stages, two feature keys: clubs.max at COMMIT
 * (imports.ts:301,429) and import.bulk at CREATE (imports.ts:122). Proving
 * only one would be proving one gate twice.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const CAP = 3;
const ROWS = 5;

test("the importer refuses at two different caps, and writes nothing when it does", async ({
  page,
}) => {
  failOnNativeDialog(page);
  const s = stamp();
  const { orgId } = await freshOrg(page, "clubs");

  // (a) The catalog still HAS these rows. No hardcoded value — a re-valued row
  // must move this test, and a DELETED row must fail loudly right here.
  const catalogClubsMax = await liveLimit(page, orgId, "clubs.max");
  const catalogBulk = await liveLimit(page, orgId, "import.bulk");
  expect(catalogClubsMax === null || catalogClubsMax > 0).toBe(true);
  expect(catalogBulk === null || catalogBulk > 0).toBe(true);

  // (b) Now pin small, deterministic caps for the journey itself.
  await setEntitlementOverrideSql(orgId, "clubs.max", CAP);
  await setEntitlementOverrideSql(orgId, "import.bulk", ROWS);

  // --- one club, by hand, through the tab's own form ---------------------
  await page.goto("/directory?tab=clubs");
  const firstClub = `Harbour ${s}`;
  await page.getByRole("button", { name: "New club" }).click();
  await page.getByLabel("Club name").fill(firstClub);
  await page.getByRole("button", { name: "Create" }).click();
  // Creating a club router.pushes to the club hub.
  await expect(page).toHaveURL(/\/clubs\/[0-9a-f-]{36}/, { timeout: 15_000 });

  await page.goto("/directory?tab=clubs");
  await page.getByRole("link", { name: "Import" }).click();
  await expect(page).toHaveURL(/\/import$/);

  const upload = async (csv: string, filename: string) => {
    await page.locator('input[type="file"]').setInputFiles({
      name: filename,
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
  };

  const clubRows = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => ({
      club: `${prefix} ${i} ${s}`,
      team: `${prefix} ${i} U13 ${s}`,
      player: `Player ${prefix} ${i} ${s}`,
    }));

  // --- CSV #1: one more club, under the cap. Commits. --------------------
  await upload(participantCsv(clubRows(1, "Alpha")), "one.csv");
  await page.getByRole("button", { name: "Commit import" }).click();
  await expect(page.getByRole("heading", { name: "Import committed" })).toBeVisible({
    timeout: 20_000,
  });

  await page.goto("/directory?tab=clubs");
  const clubsAfterFirst = await page.getByRole("link", { name: new RegExp(s) }).count();

  // --- CSV #2: crosses clubs.max. Refused at COMMIT with 402. ------------
  await page.goto("/import");
  await upload(participantCsv(clubRows(CAP, "Beta")), "over-cap.csv");
  await page.getByRole("button", { name: "Commit import" }).click();
  await expect(page.locator('[data-feature="clubs.max"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Import committed" })).toHaveCount(0);

  // The all-or-nothing transaction: NOTHING was written.
  await page.goto("/directory?tab=clubs");
  await expect(page.getByRole("link", { name: new RegExp(s) })).toHaveCount(clubsAfterFirst);

  // --- CSV #3: too many ROWS. Refused at CREATE, different key. ----------
  await page.goto("/import");
  await upload(participantCsv(clubRows(ROWS + 1, "Gamma")), "too-many-rows.csv");
  await expect(page.locator('[data-feature="import.bulk"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: /^Preview — / })).toHaveCount(0);

  // --- raise the cap; the same file now commits --------------------------
  await setEntitlementOverrideSql(orgId, "clubs.max", CAP + 10);
  await page.goto("/import");
  await upload(participantCsv(clubRows(CAP, "Beta")), "over-cap.csv");
  await page.getByRole("button", { name: "Commit import" }).click();
  await expect(page.getByRole("heading", { name: "Import committed" })).toBeVisible({
    timeout: 20_000,
  });
  await page.goto("/directory?tab=clubs");
  await expect(page.getByRole("link", { name: new RegExp(s) }).first()).toBeVisible();
});
```

If the club-count locator (`getByRole("link", { name: … })`) does not select club rows, read `clubs-teams-list.tsx:240` — the row is a `Link href={/clubs/${c.id}}` whose text is the club name. There are **no `data-testid`s in that file**; anchor on the href pattern if the accessible name is ambiguous. Do not add testids to product code for this.

Entitlement resolution is **cache-aside with a 5-minute TTL** (`lib/entitlements.ts`). If an override does not take effect immediately, find how the existing suite invalidates it — `invalidateOrgEntitlements` is exported — rather than inserting a wait. A `waitForTimeout` here would be both slow and wrong.

- [ ] **Step 2: Run and verify it fails.**

- [ ] **Step 3: Make it pass.**

- [ ] **Step 4: Verify green and under 60s.**

- [ ] **Step 5: Mutate it — twice**

a. Make `commitImport` (`imports.ts:281`) commit each entity in its own transaction instead of one. Expected: **RED** on the "count unchanged" assertion.
b. Remove the `import.bulk` check at `imports.ts:122`. Expected: **RED** on CSV #3.

Revert each, rebuild, confirm green. Mutate them **one at a time** — two guards covering for each other are each untested.

- [ ] **Step 6: Commit**

```bash
\
git add apps/web/e2e/walkthrough/directory-clubs-import-limits.spec.ts && \
git commit -m "test(directory): walkthrough — two import caps, two stages, nothing written"
```

---

## Task 7: Smoke, README, and the speed gate

**Files:**
- Modify: `scripts/smoke.ts`
- Modify: `apps/web/e2e/walkthrough/README.md`

`/directory` has exactly one existing smoke check (`:12550`, which asserts a French nav string and nothing about directory content) and **`/import` has none at all**. This is genuinely uncovered ground.

- [ ] **Step 1: Add the smoke checks**

`smoke.ts` has no registry: `check(label, cond)` is a counter and suites are plain `async function`s awaited in source order from `main()`. `html(session, path)` (`:12641`) returns `{status, body}`. Follow the shape at `:12550`:

```ts
async function directorySuite() {
  for (const tab of ["players", "clubs", "officials", "venues"]) {
    const page = await html(owner, `/directory?tab=${tab}`);
    check(`directory: ?tab=${tab} renders`, page.status === 200 && page.body.includes("Directory"));
  }
  // /import had no smoke coverage at all before this.
  const imp = await html(owner, "/import");
  check(
    "import: the wizard renders its file input",
    imp.status === 200 && imp.body.includes('type="file"'),
  );
}
```

Use whatever authed session variable the neighbouring suites use (`:12550` uses `mailer`); read the surrounding function rather than assuming `owner` exists. Then `await directorySuite();` beside the other calls in `main()`.

**Assert on something the page actually contains.** Print what you saw if a check fails — `check()` prints only PASS/FAIL, so verify the string is really in the body by hand before trusting a green.

- [ ] **Step 2: Run smoke**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/dir-walkthrough && \
eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label dirw)" && \
npm run test:smoke > /tmp/smoke.log 2>&1; echo "EXIT=$?"; \
grep -E "^FAIL|passed, .* failed" /tmp/smoke.log | tail -20
```

Expected: `0 failed`, and the five new labels present. A pre-existing unrelated failure is not yours to chase — note it and move on.

- [ ] **Step 3: Update the walkthrough README**

Add four rows to the "What is here" table in `apps/web/e2e/walkthrough/README.md`, matching the existing one-line style.

- [ ] **Step 4: THE SPEED GATE — CONTROLLER RUNS THIS. Measure, do not assert**

The owner's requirement is that these be fast. The leg's wall clock is `max(longest single test, total ÷ workers)`. **The config's cost comment is stale** — it describes 3 specs totalling ~245s and the folder now holds 19 specs / ~40 tests — so do not reuse its arithmetic.

Measure both sides:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/dir-walkthrough/apps/web && \
eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label dirw)" && \
git stash list && \
/usr/bin/time -p npx playwright test --project=walkthrough --workers=2 \
  > /tmp/leg-after.log 2>&1; echo "EXIT=$?"; tail -5 /tmp/leg-after.log
```

Then the same on the branch point:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/dir-walkthrough && \
git checkout main -- . 2>/dev/null; # do NOT git stash in a worktree — the stack is shared
```

Better: measure the baseline **before** Task 1 lands, on a detached checkout of `main` in a separate worktree, and record the number in this file. If that was not done, measure `--workers=2` with and without `--grep-invert "directory-"`.

**Gate: the delta must be ≤ 10% of the baseline wall clock.** If it is not, move setup off the UI — do not delete assertions to buy time.

Record both numbers in the commit message. "Fast" asserted without a measurement is exactly the claim this repo's rules exist to stop.

- [ ] **Step 5: Full-file e2e sweep — CONTROLLER RUNS THIS, not the implementer**

A `-g` filter is a filename sweep wearing a costume. Run the whole project:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/dir-walkthrough/apps/web && \
eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label dirw)" && \
npx playwright test --project=walkthrough --workers=2 --reporter=list \
  > /tmp/leg.log 2>&1; echo "EXIT=$?"; grep -E "passed|failed" /tmp/leg.log | tail -3
```

Every walkthrough spec must still pass — the four new files share a server with them.

- [ ] **Step 6: Unit + typecheck + lint — CONTROLLER RUNS THIS, not the implementer**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/dir-walkthrough && \
~/.claude/skills/seazn-local-env/scripts/seazn-env.sh gate --label dirw 2>&1 | tail -20
```

Judge on the `Cached: N cached, M total` line, not on exit 0 — a cache hit replays a previous run and exits 0 without executing anything.

- [ ] **Step 7: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/dir-walkthrough && \
git add scripts/smoke.ts apps/web/e2e/walkthrough/README.md && \
git commit -m "test(directory): smoke for four tabs and /import; record the leg cost"
```

---

## Self-review notes

- **Spec coverage.** §4.1 → Tasks 2+3. §4.2 → Task 4. §4.3 → Task 5. §4.4 → Task 6. §7 unit → Task 1. §7 smoke → Task 7. §5 speed gate → Task 7 Step 4.
- **Dropped from the spec, deliberately:** §4.2's blackout step. There is **no blackout UI on the directory tab** — `POST /api/v1/officials/{id}/availability` is the only org-side path. An API-only assertion is not a walkthrough step; it belongs in `officials-directory.spec.ts` or an API spec. Recorded here so the omission is not read as an oversight.
- **Not done:** no edit to `playwright.config.ts`, `e2e.yml`, `e2e-ci-wiring.test.ts`, or `helpers.ts`. The first three are covered by construction; the fourth is being edited on another branch.
