# Retire Scorer Org-Member Role (#707) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the redundant `scorer` org-member role and `scorer_assignments` table; scoring delegation remains via accepted officials (all plans) plus owner/admin.

**Architecture:** One Flyway delta removes data (option A) and tightens CHECKs. Application code drops assignment writers/readers and `/my-matches`. `requireScorable` / `requireFixtureActor` keep owner/admin and `acceptedOfficialCovers`; viewers no longer score via `scorer_assignments` (table gone) — official assignment is the Free path. Desk `hasScorer` repoints to the officials rail, not a stub false.

**Tech Stack:** SQL migrations under `db/migration/deltas/`, TypeScript Next.js app routes, vitest, Playwright e2e, smoke (`scripts/smoke.ts`), OpenAPI regen.

**Spec:** `docs/superpowers/specs/2026-09-15-retire-scorer-role-design.md`  
**Issue:** #707 · Owner ruling 2026-09-15: **Option A** (delete scorer memberships + assignments)

## Global Constraints

- Execute **after** F6/#625 is merged or in a disjoint worktree that does not fight F6 on the same files; prefer sequential on `main`.
- New worktree off `main`. Prefix verifies with `cd <abs worktree> &&`.
- **Migration number is never pinned:** at Task 1 start, `ls db/migration/deltas | sort -V | tail -1` and take next free `V4xx`. Also check unmerged branches for claimed numbers.
- Greenfield: no prod data preservation (`docs/superpowers/RULES.md`).
- **Do not** delete officials-rail concepts: `official-roles.ts` keys, `desk.*.no_scorer*`, `hasAssignedScorer` in fixture-row-action.
- **Do not** change device-link entitlements.
- i18n: remove dead role strings in 4 locales + `pnpm i18n:gen-keys`; keep desk no_scorer copy.
- OpenAPI: delete assigned-fixtures route entry; `npm run openapi:gen` clean.
- Vitest: JSON reporter only; confirm worktree paths in results.
- `grep -a` always in this repo.

---

## File map (primary)

| Area | Paths |
|---|---|
| Migration | `db/migration/deltas/VNNN__retire_scorer_role.sql` (NNN at start) |
| Auth / usecases | `apps/web/src/server/usecases/scorers.ts`, `api-v1/auth.ts`, `page-auth.ts`, `lib/auth.ts`, `lib/invites.ts`, `usecases/invites.ts`, `usecases/fixtures.ts`, `usecases/competition-desk.ts` |
| Routes / UI | `app/my-matches/`, `api/v1/me/assigned-fixtures/`, `api/orgs/.../role/`, `components/org-team.tsx`, `app/o/.../layout.tsx`, `app/orgs/new/page.tsx`, `app/join/[token]/` |
| Types / API | `lib/types.ts` `ORG_ROLES`, OpenAPI, `key-scopes.ts` |
| i18n / marketing | dictionaries `role.scorer` etc.; optional dead `pricing.matrix.scorers.max` |
| Tests | `scorers.test.ts`, `scorer-seat-pool.test.ts`, e2e `scorer.spec.ts`, smoke scorer invite blocks, registration role probes |

---

### Task 1: Migration (option A)

**Files:**
- Create: `db/migration/deltas/VNNN__retire_scorer_role.sql`
- Test: migration applies on env (`db:apply` / project recipe); optional SQL assertion in a usecase test that inserting `role='scorer'` fails

- [ ] **Step 1: Resolve version**

```bash
cd <worktree> && ls db/migration/deltas | sort -V | tail -1
# Next free = that + 1. Name: VNNN__retire_scorer_role.sql
```

- [ ] **Step 2: Write delta**

```sql
-- Retire org-member role 'scorer' and scorer_assignments (#707, option A).
DELETE FROM scorer_assignments;
DELETE FROM org_members WHERE role = 'scorer';
DELETE FROM org_invites WHERE role = 'scorer';

DROP INDEX IF EXISTS scorer_assignments_created_by_idx; -- V275 name; confirm with \d
-- drop any other indexes/policies named in V115
DROP TABLE IF EXISTS scorer_assignments;

ALTER TABLE org_members DROP CONSTRAINT IF EXISTS org_members_role_check;
ALTER TABLE org_members ADD CONSTRAINT org_members_role_check
  CHECK (role = ANY (ARRAY['owner'::text, 'admin'::text, 'viewer'::text]));

ALTER TABLE org_invites DROP CONSTRAINT IF EXISTS org_invites_role_check;
ALTER TABLE org_invites ADD CONSTRAINT org_invites_role_check
  CHECK (role = ANY (ARRAY['owner'::text, 'admin'::text, 'viewer'::text]));
```

Confirm exact constraint/index names from `V115__scorer_role.sql` and `V275__advisor_indexes.sql` before writing. Drop `default_scope` only if greps show zero remaining readers after Task 2–3 (otherwise leave column).

- [ ] **Step 3: Apply on local env** (follow `seazn-local-env` skill; confirm `data_directory` is yours)

- [ ] **Step 4: Commit migration only**

```bash
git commit -m "$(cat <<'EOF'
chore(db): retire scorer role and scorer_assignments

EOF
)"
```

---

### Task 2: Auth — requireScorable without assignments table

**Files:**
- Modify: `apps/web/src/server/usecases/scorers.ts` (or split `acceptedOfficialCovers` into a small module if the file becomes empty)
- Modify: `apps/web/src/server/api-v1/auth.ts` (`requireFixtureActor`)
- Modify: `apps/web/src/server/usecases/fixtures.ts` (lineup gate using `scoresViaAssignment`)
- Modify: `apps/web/src/app/api/v1/public/fixtures/[id]/realtime-token/route.ts`
- Test: rewrite `apps/web/src/server/usecases/__tests__/scorers.test.ts`

**Interfaces:**
- Consumes: `acceptedOfficialCovers(userId, fixtureId)`
- Produces:

```ts
export async function requireScorable(auth: AuthCtx, fixtureId: string): Promise<FixtureScope> {
  // owner/admin/api_key write → ok
  // else if acceptedOfficialCovers → ok
  // else 403
}
// Delete: createAssignment, listAssignedFixtures, scorerCovers, scoresViaAssignment
// OR keep scoresViaAssignment only if still needed — prefer delete and fix call sites
```

- [ ] **Step 1: Failing tests**

1. Official with no org membership can requireScorable / score (keep or add).
2. User with only deleted assignment path cannot (assert 403).
3. Delete tests that create `scorer_assignments` rows.

- [ ] **Step 2: Implement auth slimdown**; remove SQL against `scorer_assignments`.

- [ ] **Step 3: Run scorers + auth-related tests — PASS**

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(auth): score via officials only; drop scorer assignments

EOF
)"
```

---

### Task 3: Delete scorer surfaces (routes, invites, UI)

**Files:**
- Delete: `apps/web/src/app/my-matches/`
- Delete: `apps/web/src/app/api/v1/me/assigned-fixtures/`
- Modify: `openapi.ts`, `openapi/v1.json` via `npm run openapi:gen`, `key-scopes.ts`
- Modify: `lib/types.ts`, `lib/invites.ts`, `usecases/invites.ts`, `components/org-team.tsx`, `page-auth.ts`, `lib/auth.ts` (`isScorerOnly`), layouts/filters that exclude `role === "scorer"`
- Modify: member role route — remove `'scorer'` branch
- Test: delete/update `scorer-seat-pool.test.ts`, invite-claim tests, org-team tests

- [ ] **Step 1: Grep inventory (must be empty of org-role scorer when done)**

```bash
cd <worktree> && git grep -a -n "scorer_assignments\|role === \"scorer\"\|role === 'scorer'\|/my-matches\|assigned-fixtures" -- apps/web/src db/migration/deltas | head -80
```

Treat officials `role_keys` / desk copy as false positives — do not delete those.

- [ ] **Step 2: Remove routes + invite/UI + OpenAPI**

- [ ] **Step 3: i18n remove** `role.scorer`, `join.role.scorer`, `settings.team.role.scorer`, `billing.usage.scorerNote` (and marketing `pricing.matrix.scorers.max` if still present). Keep `desk.*.no_scorer*`. Run `pnpm i18n:gen-keys`.

- [ ] **Step 4: Tests green for invites/role/openapi coverage**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat: remove scorer org role surfaces and invites

EOF
)"
```

---

### Task 4: Competition desk `hasScorer` → officials rail

**Files:**
- Modify: `apps/web/src/server/usecases/competition-desk.ts` (~349–365)
- Test: `competition-desk.test.ts`, fixture-row-action tests as needed

- [ ] **Step 1: Read how `hasAssignedScorer` / fixture_officials already signal “has a scorer” on the desk**

- [ ] **Step 2: Failing test** — desk row with accepted official scorer shows attention clear; without official shows `no_scorer` (or current product rule). Must **not** depend on `scorer_assignments`.

- [ ] **Step 3: Repoint query**; remove `scorer_assignments` select.

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
fix(desk): derive hasScorer from officials, not scorer_assignments

EOF
)"
```

---

### Task 5: E2E + smoke — Free official scores; kill scorer journey

**Files:**
- Delete or rewrite: `apps/web/e2e/scorer.spec.ts`
- Modify: `scripts/smoke.ts` scorer invite provisioning (~1970–1999, ~16271+)
- Modify: helpers `assignScorerSql` if any
- Walkthrough specs that invite role scorer

- [ ] **Step 1: Replace scorer e2e with official path** (add official → claim → accept → score on Free), or assert existing officials e2e covers it and delete `scorer.spec.ts`.

- [ ] **Step 2: Smoke** — remove member/scorer invite assertions; keep officials smoke.

- [ ] **Step 3: Run** (env per seazn-local-env):

```bash
cd <worktree>/apps/web && pnpm exec playwright test e2e/scorer.spec.ts # or the replacement file
# smoke subset if documented
```

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
test: replace scorer journey with officials scoring path

EOF
)"
```

---

### Task 6: HTTP proof + mutation check + closeout

**Files:**
- Test: auth/HTTP test proving ex-scorer role cannot be created (CHECK / API 400) and official can POST score events
- Docs: comment on issue #707 when PR opens

- [ ] **Step 1: Test** — `POST` member role `scorer` → 400; insert via SQL in test tx fails CHECK.

- [ ] **Step 2: Test** — accepted official scores through the **route** used in production (not only usecase).

- [ ] **Step 3: Mutation** — temporarily restore `role === "scorer"` in a deleted guard in a throwaway branch of the test file's mutant comment pattern used elsewhere in repo — or a static test that `ORG_ROLES` excludes scorer:

```ts
expect(ORG_ROLES).not.toContain("scorer");
```

- [ ] **Step 4: Final grep** — no `scorer_assignments` under `apps/web/src`.

- [ ] **Step 5: Commit + open PR** linking #707

---

## Self-review (author)

| Spec requirement | Task |
|---|---|
| Option A delete memberships + assignments | Task 1 |
| CHECK without scorer | Task 1 |
| Drop assignment auth branch; keep officials | Task 2 |
| Delete /my-matches, assigned-fixtures, invite path | Task 3 |
| Desk hasScorer via officials | Task 4 |
| Free official e2e/smoke | Task 5 |
| HTTP proof + mutation | Task 6 |
| Device links untouched | Global / grep device-link in review |
| Keep desk.no_scorer i18n | Task 3 |

Viewer scoring via assignments intentionally removed with the table (spec). Officials remain the Free delegation path.
