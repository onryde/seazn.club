# Settings W3 — the gating matrix, and the programme's first mutation sweep

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For every gated control on the seven `?tab=` panels of
`/o/{orgSlug}/settings`, assert both what the UI renders AND what the route
itself answers to the same write — then prove each negative assertion can
redden.

**Architecture:** One spec per failure class, all on `APIRequestContext` with
no browser except where a claim is about what a person SEES. A `page` is a
budget line, not a default.

**Tech Stack:** Playwright 1.61.1 (`walkthrough` project, `--workers=3`),
`e2e/settings-support.ts`, `e2e/helpers.ts`, real Postgres.

**Spec:** `docs/superpowers/specs/2026-09-03-settings-walkthrough-design.md`
(register cases 5-9, 11-14). Programme record and every verified fact this plan
is built on: `docs/superpowers/specs/2026-09-03-settings-walkthrough-prompts/_INDEX.md`,
rules: `_RULES.md` beside it. **Read both before Task 1.**

---

## Global Constraints

- **The ≤60s programme budget holds** (owner ruling 6). W2 spent ~30s and six
  waves remain. W3's share is **≤10s added to the walkthrough leg**, measured
  and reported with raw numbers. A task that blows it gets restructured, not
  excused.
- **No browser unless the assertion is about what a person sees.** The matrix's
  UI half needs the DOM; its API half does not. `_RULES.md` §5.4.
- **Every negative assertion must be shown to redden when its guard is
  mutated.** A fresh org is Community, so "this is gated on Free" passes
  vacuously by default. This is the whole point of the wave — `_RULES.md` §1.
- **Never flip a plan without splitting the group** (`_RULES.md` §2), and read
  its W3 correction: a freshly created org already has its OWN group.
- **`setEntitlementOverrideSql(orgId, featureKey, intValue)` is the tool**, not
  `setOrgPlanBySql`. `setBoolEntitlementOverrideSql` for boolean features.
- **Status codes branch by route family.** `/api/orgs/**` returns **401** for
  both "not a member" and "insufficient role". `/api/v1/**` returns **401** for
  non-member, **403** for insufficient role. A wrong expectation here reads as
  a product defect. Full per-route table in `_INDEX.md`.
- **Restore every borrowed privilege in a `finally`**, and release every seeded
  org with `releaseSeededOrgSql` — a soft delete alone does not free the slot.
- Scope every count to a per-spec `TAG`. Never a global total.
- No `waitForTimeout`; `expect.poll` / `waitForResponse` only. No screenshots,
  no axe.
- Helpers never live under `e2e/walkthrough/` — every `.ts` there is loaded as
  a spec (`_RULES.md` §3).
- `pnpm install`, not npm. Judge vitest green only from the JSON reporter.

---

## File Structure

| file | responsibility |
|---|---|
| `apps/web/e2e/settings-support.ts` (modify) | `seedMemberIdentity`, `expectGate`, `TABS` |
| `apps/web/e2e/helpers.ts` (modify) | nothing new expected; read before adding |
| `apps/web/e2e/walkthrough/settings-role-gates.spec.ts` (create) | cases 5, 6 |
| `apps/web/e2e/walkthrough/settings-entitlement-gates.spec.ts` (create) | cases 7, 8, 9 + the three UI-only findings |
| `apps/web/e2e/walkthrough/settings-ownership.spec.ts` (create) | cases 11-14 |
| `docs/superpowers/specs/2026-09-03-settings-walkthrough-prompts/_INDEX.md` | the mutation sweep's record |

---

### Task 1: The member identity, and the matrix primitive

**Files:**
- Modify: `apps/web/e2e/settings-support.ts`

**Interfaces:**
- Consumes: `seedSettingsOrg(request, {plan?, label?})`, `releaseSettingsOrg`,
  `settingsUrl(slug, tab)` — all already exported.
- Produces:
  - `seedMemberIdentity(browser, request, orgId, role): Promise<MemberIdentity>`
    where `MemberIdentity = { ctx: BrowserContext; request: APIRequestContext; userId: string; release: () => Promise<void> }`
  - `expectGate(opts: { label: string; request: APIRequestContext; method: "GET"|"POST"|"PATCH"|"DELETE"; path: string; body?: unknown; expectStatus: number }): Promise<void>`
  - `TABS: readonly string[]` — the seven keys, imported from the app's own
    `SETTINGS_TABS` rather than retyped.

**Why this task exists.** There is **no non-owner-member helper in the suite**.
Verified: no `impersonate`, `loginAs`, `addMemberSql` or `setMemberRoleSql`
anywhere under `apps/web/e2e/`. The only working pattern is
`members-roles.spec.ts:17-35` — the owner mints
`POST /api/orgs/{id}/invites {role, max_uses}`, then a **second browser context
on `e2e/.auth/community.json`** calls `POST /api/invites/{token}/accept`.
`members/route.ts` exports **GET only**; there is no add-member POST.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/e2e/walkthrough/settings-support-smoke.spec.ts`:

```ts
test("a seeded member really holds the role, from the app's own answer", async ({
  browser,
  request,
}) => {
  const org = await seedSettingsOrg(request, { label: "w3-ident" });
  const member = await seedMemberIdentity(browser, request, org.orgId, "viewer");
  try {
    // The app's answer, not our own bookkeeping: GET /api/orgs/{id}/members is
    // open to every ORG_ROLE, so the member can read its own row back.
    const seen = await apiJson<{ user_id: string; role: string }[]>(
      member.request,
      `/api/orgs/${org.orgId}/members`,
    );
    expect(seen.status, "the seeded member cannot read the member list").toBe(200);
    const mine = (seen.data ?? []).find((m) => m.user_id === member.userId);
    expect(mine?.role, "the invite was accepted but the role did not stick").toBe(
      "viewer",
    );
    // And that it is NOT the owner — the failure mode this helper exists to
    // avoid is silently handing back the shared Pro session, which would make
    // every gate assertion below pass for the wrong reason.
    const whoami = await apiJson<{ id: string }>(request, "/api/users/me");
    expect(member.userId).not.toBe(whoami.data?.id);
  } finally {
    await member.release();
    await releaseSettingsOrg(request, org);
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && PLAYWRIGHT_BASE=http://localhost:<port> \
  npx playwright test e2e/walkthrough/settings-support-smoke.spec.ts \
  --project=walkthrough --reporter=line
```

Expected: `seedMemberIdentity is not a function`.

- [ ] **Step 3: Implement**

```ts
import { test, type APIRequestContext, type Browser, type BrowserContext } from "@playwright/test";

export interface MemberIdentity {
  ctx: BrowserContext;
  request: APIRequestContext;
  userId: string;
  release: () => Promise<void>;
}

/**
 * A real non-owner member of `orgId`, drivable as its own APIRequestContext.
 *
 * The community storageState is the ONLY second identity the suite has, and
 * no project wires it in (playwright.config.ts declares pro.json everywhere),
 * so it is opted into per-context exactly like members-roles.spec.ts:17-35.
 *
 * `browser.newContext()` with NO storageState would inherit the signed-in Pro
 * session — the bug that makes a gate test pass as the owner. The path is
 * named explicitly for that reason.
 */
export async function seedMemberIdentity(
  browser: Browser,
  owner: APIRequestContext,
  orgId: string,
  role: "admin" | "viewer" | "scorer",
): Promise<MemberIdentity> {
  const invite = await owner.post(`/api/orgs/${orgId}/invites`, {
    data: { role, max_uses: 1 },
  });
  if (!invite.ok()) {
    throw new Error(`invite mint failed: ${invite.status()} ${await invite.text()}`);
  }
  const token = ((await invite.json()) as { data: { token: string } }).data.token;

  const ctx = await browser.newContext({ storageState: "e2e/.auth/community.json" });
  const accept = await ctx.request.post(`/api/invites/${token}/accept`);
  if (!accept.ok()) {
    await ctx.close();
    throw new Error(`invite accept failed: ${accept.status()} ${await accept.text()}`);
  }
  const me = await ctx.request.get("/api/users/me");
  const userId = ((await me.json()) as { data: { id: string } }).data.id;

  return {
    ctx,
    request: ctx.request,
    userId,
    // The community user outlives this test. Remove the membership so the next
    // run's accept is a fresh join rather than a no-op on an existing row.
    release: async () => {
      await owner.delete(`/api/orgs/${orgId}/members/${userId}`).catch(() => {});
      await ctx.close();
    },
  };
}

/**
 * Assert the ROUTE's own answer to a write, with the label in the message.
 *
 * Deliberately asserts an exact status, not `>= 400`: the two route families
 * differ (401 vs 403) and "some kind of refusal" is satisfied by a 404 from a
 * path typo, which is how a matrix row silently stops testing anything.
 */
export async function expectGate(opts: {
  label: string;
  request: APIRequestContext;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  expectStatus: number;
}): Promise<void> {
  const { request, method, path, body } = opts;
  const res = await request.fetch(path, {
    method,
    ...(body === undefined ? {} : { data: body }),
  });
  expect(
    res.status(),
    `${opts.label}: ${method} ${path} answered ${res.status()}, expected ${opts.expectStatus} — ${await res.text()}`,
  ).toBe(opts.expectStatus);
}
```

- [ ] **Step 4: Run it and watch it pass.** Same command as Step 2.

- [ ] **Step 5: Commit**

```bash
git commit -o apps/web/e2e/settings-support.ts \
  apps/web/e2e/walkthrough/settings-support-smoke.spec.ts \
  -m "test(settings): a real non-owner member identity for the W3 matrix"
```

---

### Task 2: Role gates — register cases 5 and 6

**Files:**
- Create: `apps/web/e2e/walkthrough/settings-role-gates.spec.ts`

**Interfaces:** consumes Task 1's `seedMemberIdentity`, `expectGate`, `TABS`.

**The table to drive.** Every row is verified in `_INDEX.md`; re-pin before
trusting a line number. A `viewer` receives:

| method + path | expect |
|---|---|
| `PATCH /api/orgs/{id}` | 401 |
| `POST /api/orgs/{id}/logo-upload-url` | 401 |
| `POST /api/orgs/{id}/content-upload` | 401 |
| `POST /api/orgs/{id}/invites` | 401 |
| `POST /api/orgs/{id}/members/{userId}/role` | 401 |
| `DELETE /api/orgs/{id}/members/{userId}` | 401 |
| `POST /api/orgs/{id}/transfer-owner` | 401 |
| `POST /api/v1/orgs/{id}/sponsors` | 403 |
| `POST /api/v1/orgs/{id}/sponsor-packages` | 403 |
| `POST /api/v1/orgs/{id}/posts/digest` | 403 |
| `GET /api/v1/orgs/{id}/api-keys` | 403 |
| `POST /api/v1/orgs/{id}/api-keys` | 403 |

- [ ] **Step 1: Write the refusal sweep**

```ts
const DENIED: { label: string; method: "GET"|"POST"|"PATCH"|"DELETE"; path: (o: string, u: string) => string; body?: unknown; status: number }[] = [
  { label: "rename the org", method: "PATCH", path: (o) => `/api/orgs/${o}`, body: { name: `${TAG}-nope` }, status: 401 },
  { label: "mint an invite", method: "POST", path: (o) => `/api/orgs/${o}/invites`, body: { role: "viewer", max_uses: 1 }, status: 401 },
  { label: "create a sponsor", method: "POST", path: (o) => `/api/v1/orgs/${o}/sponsors`, body: { name: `${TAG}-s` }, status: 403 },
  { label: "list api keys", method: "GET", path: (o) => `/api/v1/orgs/${o}/api-keys`, status: 403 },
  // …the remaining rows from the table above
];

test("a viewer is refused every write, by the route and not just the UI", async ({ browser, request }) => {
  const org = await seedSettingsOrg(request, { label: "w3-role" });
  const member = await seedMemberIdentity(browser, request, org.orgId, "viewer");
  try {
    for (const row of DENIED) {
      await expectGate({
        label: row.label,
        request: member.request,
        method: row.method,
        path: row.path(org.orgId, member.userId),
        body: row.body,
        expectStatus: row.status,
      });
    }
  } finally {
    await member.release();
    await releaseSettingsOrg(request, org);
  }
});
```

- [ ] **Step 2: The POSITIVE pair, or the sweep proves nothing**

A sweep of refusals passes in full against an identity that is simply broken —
a context with no session refuses everything. Two rows pin that this identity
is a real, working member:

```ts
test("the same viewer is ALLOWED what a viewer may do", async ({ browser, request }) => {
  // GET members is gated on ORG_ROLES, which includes viewer (route.ts:13).
  await expectGate({ label: "read the member list", request: member.request,
    method: "GET", path: `/api/orgs/${org.orgId}/members`, expectStatus: 200 });
  // GET sponsors is a `read` scope and viewer is in READ_ROLES.
  await expectGate({ label: "read sponsors", request: member.request,
    method: "GET", path: `/api/v1/orgs/${org.orgId}/sponsors`, expectStatus: 200 });
});
```

- [ ] **Step 3: Case 6 — the role select is owner-only-and-not-self in the UI,
      and the ROUTE has no self guard**

Verified: `role/route.ts` compares nothing to the caller; the UI hides it with
`isOwner && m.user_id !== currentUserId` (`org-team.tsx:191`). So an owner can
demote themselves via the API **provided another owner exists**. Drive it:
seed a second owner, then have the first demote itself, assert 200, assert the
role really moved by reading it back, then restore.

```ts
// Assert the route's answer AND the row, because a 200 that changed nothing
// satisfies the status assertion on its own.
```

- [ ] **Step 4: Run the whole file** (never a `-g` slice), commit.

---

### Task 3: Entitlement gates — cases 7, 8, 9, and the three UI-only findings

**Files:**
- Create: `apps/web/e2e/walkthrough/settings-entitlement-gates.spec.ts`

**This task carries the wave's headline findings.** All three were read end to
end and are recorded in `_INDEX.md`. Each is a hypothesis until driven.

- [ ] **Step 1: Finding A — brand colour has no write-side check**

`PATCH /api/orgs/{id}` is `requireOrgRole(EDITOR_ROLES)` → schema →
`mergeBrandColor` → update. No feature check anywhere in the file, no trigger.
Seed a **Community** org, PATCH a brand colour as its owner, assert **200**,
and read the row back to prove it persisted.

Then the part that decides whether this is a real customer defect or only an
untidy API: the read mask has a **reachable exception**. `page.tsx:386` hands
raw `active.branding` to `OrgAbout`, whose `previewStyle` is
`publicThemeStyleChain(branding)` — unmasked (`org-about.tsx:57`) — on the
Organisation tab, which a Community org can open. **This one needs a browser.**
Open the tab and assert whether the colour is visible in that preview.

Write down what you SEE. If the preview does not show it, that is a finding
too, and the record in `_INDEX.md` gets corrected.

- [ ] **Step 2: Finding B — `GET api-keys` has no `api.access` guard**

`listApiKeys` calls only `requireSession`; `requireFeature("api.access")` is in
`createApiKey` alone. Seed a Community org, GET the list as its owner, assert
**200**, and assert the UI shows the upsell panel for the same org — the two
halves together are the finding.

- [ ] **Step 3: Finding C — `DELETE /api/tour` has no org check**

No `orgId` parameter at all. Seed a member, DELETE, assert **200**.

- [ ] **Step 4: Case 8 — `?tab=api` on a Free org**

`setEntitlementOverrideSql(orgId, "api.access", 0)`, then assert the panel is
the upsell and `POST api-keys` answers **402**.

**Mind the order.** `requireFeature("api.access")` runs BEFORE the `api.write`
check, so a Community editor choosing the `score` scope gets 402 with
`feature_key: "api.access"` — NOT `api.write`. Assert the `feature_key` in the
body, not merely the 402, and pick the case whose right answer differs from the
wrong one's constant.

- [ ] **Step 5: Case 7 — a genuine Pro→Free transition**

The only row needing a plan flip. A fresh org already has its own group
(`auth.ts:292-330`), so `splitOrgIntoOwnGroupSql` is belt-and-braces here, not
load-bearing — call it anyway per `_RULES.md` §2. Set a brand colour on Pro,
flip to community, assert what the settings page renders and whether the value
is still saveable.

- [ ] **Step 6: Case 9 — org-switch into an org without the entitlement**

Two orgs, one with `sponsors.tiers` overridden off. Switch the active org via
`POST /api/orgs/active {org_id}` — **snake_case, behind `.strict()`**; `orgId`
400s. Restore the previous active org in a `finally`, or the rest of the leg
runs against the wrong org.

---

### Task 4: Ownership and last-actor — cases 11-14

**Files:**
- Create: `apps/web/e2e/walkthrough/settings-ownership.spec.ts`

**Every test here seeds a THROWAWAY org.** Three of the four cases are
irreversible or flip which session holds owner rights, so the shared Pro org
cannot survive them.

- [ ] **Case 11 — last owner leaves.** `DELETE /api/orgs/{id}/members/me`
      answers **409** "You are the sole owner…". Also assert the UI half: an
      owner **never sees** the Leave control (`page.tsx:666` renders it only
      when `role !== "owner"`), and an owner alone gets the static
      `settings.account.soleOwner` text.
- [ ] **Case 12 — delete account while owning an org with other members.**
      `DELETE /api/users/me {confirm:"DELETE"}` → **409**. Drive it with the
      seeded member present. **Do NOT run this as the shared Pro user** — it is
      terminal (anonymise + `destroySession`, no undelete route).
      **Also record the gap:** a sole owner whose org has NO other members is
      not blocked, and `:157-158` deletes the membership unconditionally,
      leaving the org row with zero members and no owner. Assert that behaviour
      as it is and record it as a finding rather than changing it in this wave.
- [ ] **Case 13 — transfer ownership at one member.** The control is not
      rendered (`page.tsx:660-663` requires `members.length > 1`). Assert the
      absence, then the second guard: a 2-member all-owner org passes the page
      check and lands on the dead-end text at `account-actions.tsx:252-258`.
- [ ] **Case 14 — demote the only owner.** Route answers **409** "An
      organization must keep at least one owner".

---

### Task 5: The mutation sweep

**Files:**
- Modify: `docs/superpowers/specs/2026-09-03-settings-walkthrough-prompts/_INDEX.md`

Every negative assertion in Tasks 2-4 is decoration until it has been shown to
redden. A fresh org is Community, so the gated-on-Free rows are exactly the
shape that passes for the wrong reason.

- [ ] **Step 1: Mutate per SURFACE, one at a time.** Two guards covering for
      each other are each untested. Minimum set:
      1. `requireOrgRole` in `/api/orgs/[id]/route.ts` → return without
         throwing.
      2. `requireOrgAuth`'s role branch in `api-v1/auth.ts:216-218` → always
         allow.
      3. `requireFeature("api.access")` in `usecases/api-keys.ts:42` → delete.
      4. The last-owner count in `members/me/route.ts:22-31` → `if (false)`.
      5. The last-owner count in `role/route.ts:35-41` → `if (false)`.
      6. The sole-owner block in `users/me/route.ts:85-103` → delete.
      7. `page.tsx:666`'s `role !== "owner"` → `true`.

- [ ] **Step 2: For each — rebuild, confirm the server is serving the mutant,
      run, restore.**

      **The rebuild checklist is not optional here.** Mutation inverts the
      stakes: a stale server makes a mutant look SURVIVED, which is exactly
      backwards. After every rebuild — probe
      `/_next/static/$(cat .next/BUILD_ID)/_buildManifest.js` (never
      `/api/health`, which answers 200 for a DELETED bundle), `lsof` the old
      port for an orphan still serving pre-fix code, and re-run
      `--project=setup` if the port moved. **Never `--no-deps`.** Best of all,
      read back behaviour the process itself produces before trusting it.

- [ ] **Step 3: Record every mutant and its verdict in `_INDEX.md`** — the
      mutant, the test that killed it, or SURVIVED plus what was added. A
      surviving mutant that compiles may also be a bad probe; check the mutant
      actually changed behaviour before concluding the test is weak.

- [ ] **Step 4: Measure the budget.** Report added tests, serial test time and
      wall-clock at `--workers=3`, against the ≤10s share. Raw numbers.

---

## Self-review

- **Spec coverage:** cases 5, 6 → Task 2. 7, 8, 9 → Task 3. 11, 12, 13, 14 →
  Task 4. Case 10 is W5's; case 24's settings half shipped in W1/W2.
- **Not placeholders:** every route, status and file:line above comes from a
  handler read end to end and recorded in `_INDEX.md`. Re-pin anyway — a
  cross-session line number is branch-relative.
- **Type consistency:** `seedMemberIdentity` and `expectGate` are named
  identically in Task 1's implementation and in Tasks 2-4's use.
- **Known risk:** Task 1 depends on `POST /api/invites/{token}/accept` working
  for a user who is already a member from a previous run. `release()` deletes
  the membership for that reason; if a run dies before `release`, the next
  accept may no-op. If that bites, make the accept idempotent-tolerant rather
  than asserting on it.
