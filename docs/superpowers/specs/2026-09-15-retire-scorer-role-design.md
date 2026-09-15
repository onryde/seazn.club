# Retire the `scorer` org-member role (#707)

**Status:** owner-approved brainstorm 2026-09-15.  
**Issue:** [#707](https://github.com/onryde/seazn.club/issues/707)  
**Owner ruling (2026-09-15):** **Option A** — delete all `org_members` with `role = 'scorer'` and all `scorer_assignments` rows; no demotion to viewer.

## Problem

The `scorer` org role is redundant. An accepted fixture official already reads and scores with **no** org role on every plan including Free (`requireFixtureActor` → `acceptedOfficialCovers`; `/me` OfficiatingLane). W2 removed the `scorers.max` seat cap; the role and assignment table remain. Scorer assignment has writers but no assignment UI — only invite-with-default-scope. Device links (anonymous hand-over) are a different product and stay.

## Goals

1. Remove `scorer` from `org_members.role` and `org_invites.role` CHECKs.
2. Drop `scorer_assignments` and stop writing/reading it.
3. Remove `/my-matches`, `GET /me/assigned-fixtures`, and invite/role UI paths that create scorers.
4. Keep scoring for: owner/admin; **viewer** who still has a covering path where product intends it; **accepted officials** (primary Free delegation).
5. Prove via HTTP-level tests that an ex-scorer membership cannot write scores and an accepted official still can.

## Non-goals

- Touching officials `role_keys` that include the string `"scorer"` (different concept — desk `no_scorer` / assigned official scorer).
- Removing device links or changing Pro/Event Pass device entitlements.
- Reworking `divisions.scorer_can_finalize` / `scorer_can_enter_lineups` capability flags in this wave unless a compile/type error forces a rename — prefer leave column names, drop only org-role coupling.
- Migrating people to officials automatically.

## Design

### Migration (next free `V4xx` at implement time — never pin in the plan)

Order in one delta:

1. `DELETE FROM scorer_assignments;`
2. `DELETE FROM org_members WHERE role = 'scorer';`
3. `DELETE FROM org_invites WHERE role = 'scorer';` (pending invites cannot accept into a removed role)
4. Drop policies/indexes on `scorer_assignments`; `DROP TABLE scorer_assignments;`
5. Drop and recreate `org_members_role_check` and `org_invites_role_check` as `IN ('owner','admin','viewer')`.
6. Leave `org_invites.default_scope` column unless nothing reads it after scorer removal — if only scorer used it, drop in the same migration or a follow-up in the same PR if greps are clean.

Greenfield: no prod backfill (`RULES.md`). Local/dev DBs only.

### Auth

- `scoresViaAssignment(role)` — remove `role === "scorer"`; **keep** `role === "viewer"` (umpire invites / assignment-shaped rights for viewers must not break). After table drop, `scorerCovers` either dies or is rewritten to only what still exists — inventory showed `scorerCovers` reads `scorer_assignments`. If viewers depended on that table for score rights, product decision: viewers score only via **accepted official** or lose assignment-based score. **Ruling for this wave:** after dropping the table, viewer scoring requires `acceptedOfficialCovers` (same as non-members). Update `requireScorable` accordingly: owner/admin → ok; else accepted official → ok; else 403. Delete `createAssignment` / `listAssignedFixtures` / `scorerCovers` / assignment writers.
- `requireFixtureActor` — drop scorer-only comments/branches that assumed org scorer role.
- `page-auth.ts` — remove `/my-matches` redirects and `allowScorer` / `scorerCovers` gates; scorers are gone.
- `isScorerOnly` — delete; post-login routing no longer sends anyone to `/my-matches`.

### Surfaces to delete or repoint

| Surface | Action |
|---|---|
| `app/my-matches/` | Delete page |
| `api/v1/me/assigned-fixtures` | Delete route; remove OpenAPI + key-scopes entry; regen openapi |
| `org-team` invite `<option value="scorer">` | Remove; `ORG_ROLES` / zod invite enum lose `scorer` |
| `lib/invites.ts` scorer assignment insert | Remove |
| `usecases/scorers.ts` | Delete or gut to only helpers still needed (`acceptedOfficialCovers` may move to auth/officials module) |
| `competition-desk.ts` `scorer_assignments` → `hasScorer` | Repoint `hasScorer` to officials-rail signal already used elsewhere (`hasAssignedScorer` / fixture_officials), **not** a silent always-false that hides `no_scorer` attention incorrectly — match desk product meaning (needs an assigned scoring official). |
| i18n `role.scorer`, `join.role.scorer`, `settings.team.role.scorer`, `billing.usage.scorerNote` | Remove keys + gen-keys; **keep** `desk.*.no_scorer*` |
| marketing `pricing.matrix.scorers.max` | Remove if still present after W2 (dead matrix row) |
| e2e `scorer.spec.ts`, smoke scorer invite path | Replace with official claim→accept→score on Free, or delete and rely on existing officials smoke |

### Tests

- Flip/delete `scorers.test.ts` assignment suite; keep official-cover tests.
- Role API / seat-pool tests that assert `scorer` → delete or assert 400.
- Registration 403 probes using `memberWithRole(..., "scorer")` → use `viewer` or non-member.
- HTTP proof: user who would have been scorer-only cannot POST score events; accepted official can.
- Mutation: reintroduce `role === "scorer"` in a guard → test fails (or snapshot CHECK constraint test).

## Acceptance

- [ ] No `scorer` value in role CHECKs; table gone.
- [ ] No production writer/reader of `scorer_assignments`.
- [ ] Officials still score with no org role (HTTP).
- [ ] Free org official path still works end-to-end.
- [ ] Device links untouched.
- [ ] Desk `no_scorer` still means “needs a scoring official,” not the deleted org role.

## Sequencing

After F6/#625 merges (or parallel worktree with disjoint files — **not** disjoint: both may touch OpenAPI/i18n; prefer sequential: F6 then this).
