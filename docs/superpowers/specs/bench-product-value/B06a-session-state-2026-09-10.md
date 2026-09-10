# B06a — session state (live, rewritten at each task boundary)

Worktree `.claude/worktrees/bench-b06a`, branch `feat/bench-b06a-framework`,
cut from `8f3e3d655`. Nothing pushed yet; no PR yet.

- Plan (nine tasks, with the test code and the pinned routes for T6/T7):
  `docs/superpowers/plans/2026-09-09-bench-b06a-suite-framework.md`
- Design of record, owner decisions D1–D8:
  `designs/2026-09-09-b06-pack-pilot-design.md`
- B06b (the darts pack) is a SEPARATE later wave. PackSchema freezes when
  **B06b** merges, not this one.

## Where the wave is

| task | state |
|---|---|
| 1 — suite registry | **COMMITTED** `bf9853b94` |
| 2 — extract the runner | **COMMITTED** `3acc0ace9` |
| 3 — `compareMatches` | **COMMITTED** `bffb3fabe` |
| 4 — `compareSpecials` | **COMMITTED** `04f302798` |
| 5 — provenance writer | **COMMITTED** `aadfcf30a` |
| 6 — claim accept (§9 P2) | **COMMITTED** `1e1289c06`, `ae2d6f914`, `8da28fd25`, `734f16dbe` |
| 7 — news drafts + publish (§9 P6) | **NEXT** — routes being re-pinned |
| 8 — doc corrections | not started |
| 9 — live run, both placement legs | not started — **needs a local env; orchestrator only, never a subagent (600s watchdog)** |

## Gate numbers, in order, so a regression is visible

| point | files | tests | failed suites |
|---|---|---|---|
| baseline (before task 1) | 36 | 1397/1397 | 0 |
| after task 1 | 37 | 1404/1404 | 0 |
| after task 2 | 38 | 1408/1408 | 0 |
| after task 3 | 39 | 1420/1420 | 0 |
| after task 4 | 40 | 1430/1430 | 0 |
| after task 5 | 41 | 1438/1438 | 0 |
| after task 6 | 42 | 1457/1457 | 0 |

Gate command (the apps/web suite and `turbo` never see `scripts/bench`):

```
./packages/engine/node_modules/.bin/vitest run --reporter=json \
  --outputFile=/tmp/b06a.json --testTimeout=30000 scripts/bench
```

Then `npm run typecheck:scripts` (expect 0) and
`rtk proxy npm run lint:scripts` (expect no `✖`).

**Counts rise by more than the tests written**: `strip-types-loadable.test.ts`
generates one case per bench MODULE, so each new `lib/**.ts` file adds one.

## Findings so far (these belong in the PR body)

1. **The plan's task-2 premise was false.** The DLS probe, registration drivers,
   discipline subject and cross-division court probe were briefed as
   `_tiny`-specific and needing hooks. All four are already pack-driven —
   grepping the 2,480-line `try` block for a hardcoded pack ref returns comments
   only. The extraction became a file move plus one parameter.
2. **The registry broke two existing mocks.** `vi.mock("../suites/tiny.ts")`
   returning only `runTinySuite` fails COLLECTION once `registry.ts` also
   imports `TINY_PACK_PATH` — which reads as a lost suite, not a failed test.
3. **The runner used to default a missing `packPath` to `TINY_PACK_PATH`** — a
   suite that forgot to pass one would fold the proof pack while reporting its
   own name. Gone; both halves mutation-proved.
4. **A new HTTP read costs every suite-level fake a route it does not model.**
   Task 3 (fixtures board) and task 4 (folded state) both hit it; task 4 would
   additionally have owed a state its sport module accepts. Solved with
   injectable seams — `input.matchBoard`, `input.specialSubjects` — whose echo
   helpers are VACUOUS by construction and say so in their doc comments. The
   real coverage is the comparator unit tests plus one wrong-data wiring test
   each.
5. **The `no_subject` branch in `compareMatches` was unreachable** and survived
   mutation. Cause: the loop only visits divisions the pack declares matches
   for, and stage 0 already REFUSES a pack whose stream has no expected match
   ("a replayed stream with no oracle asserts nothing"). Branch deleted; a test
   pins the refusal instead.
6. **A specials standings claim reads that fixture's own `StandingsDelta`,**
   not the cumulative table — `_tiny` claims `won: 1` where its table says 2,
   and the pack is right. Derived by the ENGINE from the PRODUCT's folded
   outcome and state, guarded so an unrecognised state shape reds as an absent
   cell rather than throwing.
7. **A `squads` claim has no live source** — reported UNSUPPORTED and reds,
   never silently satisfied.
8. **I duplicated `resolveStatePath`** (`validate-pack.ts:580`, since B02) with
   a worse copy that did not index arrays. Replaced; one authority per fact.
9. **`provenancePct` had a field and no writer since B01.** Now written, with
   the COUNTS beside it, and `total` is the stream count so an unknown
   provenance value shows as a gap rather than a flattering denominator.
10. **Process:** `git checkout <file>` to strip a debug line also reverted that
    file's uncommitted wiring. Remove debug lines surgically.

## Task 6 findings (these belong in the PR body, after the ten above)

11. **Every one of the plan's four task-6 route facts was wrong.** The claim
    token is shown ONCE on the mint response's `claim_url` and the read-back
    GET omits it, so `seed.ts` could not accept what it had just minted — the
    accept flow was not merely unbuilt, it was UNREACHABLE, which is how it
    stayed owed for three waves. Accept takes no body, requires a session, and
    matches the SIGNED-IN email (403 CLAIM_EMAIL_MISMATCH), so it is one
    sign-in per invitee. `GET /persons/{id}/claim-invites` is `getOpenClaim`,
    `where claimed_at is null` — an accepted invite reads back as `null`, so
    the plan's "assert claimed_at != null" would have asserted against a row
    the route refuses to return. And `/api/claims/*` is the non-v1 envelope,
    which DROPS the error `code`: `CLAIM_INVALID` never crosses the wire, so
    asserting it would have been an assertion that could never fail.
12. **The plan's "replace the unclaimed assertion" premise was false.** That
    assertion reads a seed-time snapshot and proves SEEDING never accepts;
    acceptance later in the run does not falsify it. Kept, with the
    post-acceptance assertions added beside it.
13. **A `no_subject` oracle carrying `passed: false` destroys the whole run
    report.** `OracleResult`'s `superRefine` requires
    `passed === (verdict !== "fail")` and `writeReport` parses before writing,
    so the first pack with no claim invites would have thrown inside the report
    writer and left NO report on disk. Invisible to every suite-level test:
    they all call the runner, none call `writeReport`. Found in review, and now
    guarded by parsing every oracle the runner pushes.
14. **A fifth suite-level fake existed.** `tiny-suite.test.ts` — shared by the
    scheduling and registration suites via `makeFakeServer` — modelled the
    claim-invite mint with no secret at all. Only found because `seed.ts` was
    changed to REFUSE a secretless mint instead of dropping it.
15. **`report.claims` had a field and no writer since B01**, exactly like
    `provenancePct` before T5.

Mutation sweep, 8 mutants, 8 killed, each with a named killer: the negative
case hardcoded, `limit` ignored, `tamperToken` inert, the vacuity conjunct
dropped, the untouched-invite re-read deleted, the stats comparison deleted,
the naive session latch re-injected, and `passed` hardcoded past its verdict.

## Task 6, as built (superseded — kept for the route facts)

Routes are pinned in the plan, in-task, and are NOT all under `/api/v1`:
`GET /api/claims/{token}` → `POST /api/auth/magic-link` →
`POST /api/auth/magic-link/consume` → `POST /api/claims/{token}/accept`;
refusals `401 CLAIM_INVALID | CLAIM_EXPIRED | CLAIM_REVOKED`,
`409 CLAIM_CLAIMED`. Claimed stats: `GET /api/v1/persons/{id}/stats`
(`?group=sport` for career) — that route does NOT mask names, so do not assert
masking on it.

`_tiny` seeds invites (`lib/seed-plan.ts:313-334`) and the runner currently
asserts they stay UNCLAIMED — that assertion must be REPLACED by the
post-acceptance one, never deleted.

Expect the same fake-world tax as tasks 3 and 4: the suite-level worlds will owe
the claim routes, and the honest answer is another injectable seam plus a
discriminating wiring test, not a fake that satisfies itself.

## Task 7 note that changes an assertion

`shouldFirePostPublished` (`org-posts.ts:100`) fires a PostHog `captureServer`
call — **no table row, no outbox** — so "observed exactly once" is NOT
HTTP-observable. Assert the predicate by proxy: a second publish must not move
`published_at`. Drafting is automatic inside the scoring path and needs BOTH
`divisions.auto_posts` and `hasFeature("news.auto")`, or `drafted` is
legitimately 0 and the step proves nothing. A local server posts to LIVE
PostHog, so do not loop the publish step.
