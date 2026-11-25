# Realtime Push Nudges: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add server pushes ("nudges") to three surfaces: the capture phone (`capture:{pairingId}`), Match Day codes (`match-day:{codeId}`), and public division topics (`division:{id}`, which go private). Each nudge is a ping, `{v, reason, at}`. It tells the client to re-read through its existing read path. The existing reads and polls stay the only truth and the only liveness. Phase 0 adds one batched transport (`broadcast()`) and one mint helper (`mintRealtimeToken()`). It also adds a security sweep for the `role: authenticated` tokens.

**Spec:** `docs/superpowers/specs/2026-11-24-realtime-push-nudges-design.md` (approved). Binding input: the phone team's constraints file it cites. Where §0 and §7 Q1 ("no URL in the beat") conflict with §2.1 and §6 ("`url, apikey` in the object", phone review 2026-11-24), **this plan follows §2.1 and §6**, which match the controller's constraint below. §7 Q1 is stale.

**Worktree:** `/Users/ashokhein/github/seazn.club-worktrees/realtime-nudges`, branch `feat/realtime-nudges` off main `8d39087623`. Paths below are under `apps/web/src/` unless they start with `db/`, `docs/`, `scripts/` or `apps/web/e2e/`.

## Global Constraints

- Repo AGENTS.md, docs/superpowers/RULES.md, TEST-STRATEGY.md, MODULARIZATION.md.
- Scoped vitest from apps/web with the JSON reporter and EXIT=$?, never the full suite. Scoped tsc only. e2e only via CI workflow_dispatch.
- 4 test types per task.
- No user-facing strings expected; if any, all 4 locales.
- Migrations V554, V555, V556 (greenfield, idempotent, V403 shape). Note: feat/seazn-hosted owns V553 and merges first; if numbering collides at rebase, renumber.
- JWTs never in URL, log, Sentry, record, snapshot, SSR HTML or the Redis hub document.
- Beat reply: one optional `realtime: {url, apikey, topic, token, expiresAt}` object. Never reuse the read names (state, label, autoAllowed, pollSeconds, venueTimezone, scheduledStart, destinationName, next, autoRefusal, stage, role, delivery).
- No server timeout or cadence changes because of nudges.
- Division rollout D-a (dual publish), then D-b only ≥14 days after the prod deploy, as a separate PR. T3.5 is marked DEFERRED and is not part of this branch's PR.
- The STG separation gate in T3.1 is a controller step (live stg), not a subagent step.
- MD_DAY_LIMIT raised to 1800/min (Q4).

How to run checks (copied from the title-sponsor plan's recipe):

- **vitest:**
  ```bash
  cd /Users/ashokhein/github/seazn.club-worktrees/realtime-nudges/apps/web && npx vitest run --reporter=json --outputFile=$SCRATCH/tN.json <exact paths>; echo EXIT=$?
  jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests,files:[.testResults[].name]}' $SCRATCH/tN.json
  ```
  Pin `total`, and confirm every `files` path resolves inside this worktree. DB suites need `DATABASE_URL` (see the `seazn-local-env` skill).
- **Scoped tsc:**
  ```bash
  echo '{"extends":"./tsconfig.json","compilerOptions":{"noEmit":true,"incremental":false,"types":["node","next"]},"include":[],"files":[<changed .ts/.tsx>]}' > tsconfig.changed.tN.json && node ../../node_modules/typescript-native/bin/tsc -p tsconfig.changed.tN.json; echo EXIT=$?; rm tsconfig.changed.tN.json
  ```
  Never commit the scratch config.
- **e2e:** subagents write specs and run only `npx playwright test --list <spec> > $SCRATCH/list.txt 2>&1; echo EXIT=$?`. Only the controller dispatches CI.
- **Smoke:** write the suite and type-check it; it runs on PR CI.
- After any api-v1 change: `npm run openapi:gen && git status --porcelain` must show only the intended diff.
- Always use `grep -a`. Never use `git stash`.
- Every new migration is applied only to a fresh local schema, never to a shared database.
- One commit per task. Commits are conventional and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No push and no PR inside a task.
- `Applies to another sport: N/A (no sport rules)` is stated in each new test file's header.
- Sequence cases are owed in every task: a **second call**, an **empty** input, **after a withdrawal or void**, and **another surface**.

## Pre-flight: line pins re-verified at 8d39087623

✓ = confirmed. **C** = corrected; the plan follows the correction.

1. ✓ `lib/realtime.ts`:
   - `BROADCAST_TIMEOUT_MS` is at :16, `publishTarget` at :27-32, `publishFixtureUpdate` at :50-78, the twin-removal note at :41-48.
   - **C** `publishDivisionUpdate` runs :87-119.
   - `mintExternalPlayLobbyToken` is at :267-285, `publishRoomBroadcast` at :338-383 (it already sends 2 messages in one POST), `mintPublicFixtureToken` at :385-402.
2. **C** `publishExternalPlayLobby` (:288-317) has **no timeout** today. Delegating it to `broadcast()` adds the 3 s timeout. That is a behaviour change, so it gets its own commit (Task 1).
3. **C** The JSDoc at :242-249 belongs to `mintPublicFixtureToken` but sits orphaned above `externalPlayLobbyTopic`. Move it when wrapping the mint.
4. ✓ Division subscribers are `components/public-site/use-live-competition.ts:344`, `components/v2/slideshow.tsx:234` and `components/v2/board/use-board-actions.ts:815`. None is private and none calls `setAuth`. Other `supabaseBrowser()` users are `use-fixture-stream.ts:57`, `match-centre/use-live-fixture.ts:321` and `match-room/use-room.ts:182`.
5. Policy shape:
   - ✓ The V403 policy is at :52-62.
   - **C** V537 (:267-330) rewrote the V403 and V452 policies with the wrapped `(select realtime.topic())` form. New policies copy V403's guards and exception handling, and V537's wrapped predicate.
   - The test stub for policies (`stubRealtime`, `visibility`, `rolledBack`) is at `lib/__tests__/resolvers-plpgsql.test.ts:254-322`.
6. ✓ The fixture door is `app/api/v1/public/fixtures/[id]/realtime-token/route.ts`: GET :27, mint :41, device-link :66. **C** It sets **no** `cache-control: no-store`. New doors set it explicitly.
7. ✓ `relay/config.ts:747-749` holds POLL 5/10/60 and :751 the near window. **C** The poll file is `server/relay/domain/poll-seconds.ts:12-18`.
8. Beat path:
   - ✓ `beats/route.ts:15-32`, `postBeat` at `capture-phone.ts:540`, `runBeat` at :553, `wireBeatAnswer` called at :778.
   - **C** `postCourtBeat` (`capture-court.ts:256`) delegates to `runBeat` (:268). Wiring in `runBeat` therefore covers both code kinds.
9. ✓ `AnswerCommon` is at `capture-schemas.ts:190-199`. **C** The replaced and taken branches use `AnswerCommon.partial()` (:211-212), so adding `realtime` to `AnswerCommon` would admit it there. Those two branches must `.omit({realtime: true})`.
10. ✓ Claim code: the `replaced` writes are at `capture-phone.ts:620` and :629, the session's pairing moves at :624 and :634, and `operator_stopped` is at :689.
11. **C** `stream-codes.ts:325` is the *lazy* `code_ended` pairing end, written on a refused call. It is not where a code ends.
    - Codes end in `wipeStreamCodeTok` (`relay/secret-columns.ts:454`). Its callers are `stream-codes.ts:207,218,245,291`, `stream-sessions/start.ts:128`, `stream-phone.ts:216` and `court-streams.ts:158,243,299`.
    - Ending a code does not end its pairings, so the `over` ping goes to every open pairing of the code.
12. **C** A session is inserted (`requested`) at `stream-sessions/start.ts:514`, which is outside `apply`. The first `apply` is `requested → provisioning` (`provision.ts:26`), run synchronously from `start.ts:595`. So `go-live` fires on entry to `provisioning` or `warming`.
13. ✓ `apply` is at `stream-sessions/apply.ts:61-165`. The transaction returns `{session, effects}` with no prior state, so the prior state must be added to that result. Sessions carry `code_id` (V430:118).
14. ✓ Match Day:
    - `match-day-code/route.ts:12`.
    - `MdBudget` at `match-day-code-door.ts:41`, `BUDGET` at :43-50.
    - `MD_DAY_LIMIT` = 600 at `lib/rate-limit.ts:221` (its comment is at :207).
    - The `match_day_codes` columns `revoked_at`, `opens_at` and `expires_at` are in V509.
15. ✓ Publish call sites:
    - `scoring.ts:520-523`, whose scope type is `{divisionId, competitionId}` (:1463); the fallback at :533 publishes the fixture only.
    - `void-lines.ts:159-160`, with a fallback at :165.
    - `match-day-call.ts:563,605`.
    - `after-write.ts:66-69` (cap 50 at :74).
    - `player-stats-refresh.ts:596`, which publishes a division `score`. It is excluded from Match Day but is dual-published automatically.
16. ✓ The highest migration is V552. ✓ The stale comment is at `components/public-site/match-centre/use-live-fixture.ts:289`.
17. **C** `ORG_ROLES` = owner, admin, viewer (`lib/types.ts:20`), and the board page admits any member (`requireCompetitionPage`). The official path is therefore **any member role, or an accepted official on a fixture of the competition**. The spec's "owner/admin" parenthetical is narrower than "whose role can open the board". Flag this to the owner.
18. ✓ The hub doc carries `competitionId` (`competition-hub-schema.ts:518`). `HUB_POLL_MS` is 15 s and `HUB_IDLE_POLL_MS` 60 s (`use-live-competition.ts:30-31`). Slideshow `POLL_MS` is 45 s and `SUBSCRIBED_POLL_MS` 5 min (:42-43).
19. ✓ `publicRateLimit` uses key `pubv1:` at 60/min (`usecases/public.ts:93`). `app/api/v1/public/__tests__/poll-rate-limit.test.ts` pins every public bucket, so the new bucket must be added there.
20. ✓ `capture-contract.test.ts` pins `SHA256` per contract at :51-70, holds the tampered guard at :843-849 and keeps exact per-directory counts. Every contract change bumps its pin.
21. Existing tests that spy on the publishers and must be translated (never loosened) when callers move to `broadcast()`: `hub-cache-invalidation.test.ts`, `schedule-fixture-cache-keys.test.ts`, `schedule-slot-writes-cache-keys.test.ts`, `score-revalidate-in-request.test.ts`, `realtime-publish.test.ts`, `realtime-publish-switch.test.ts`, `use-live-competition.test.tsx`.

## Controller steps (subagents must NOT do these)

- **CS-1, STG separation gate (Task 11).** On live stg, prove two things:
  - a public subscriber to `division:{X}` does not receive a `private: true` message on that topic;
  - a private subscriber, holding a Task 1 division token for X, does not receive a public one.

  Use hand-sent broadcast POSTs. Record the evidence in Task 11's commit body. Task 14 does not start until it passes.
- **CS-2, Supabase plan quotas.** Read concurrent connections, channels per connection, join rate, messages per month and the broadcast batch maximum from the project's plan. Write them into `lib/realtime.ts`'s header, replacing Task 1's `UNVERIFIED` placeholders, as a docs commit before Task 14. If the batch maximum is below 100, change `BROADCAST_CHUNK`.
- **CS-3, e2e dispatch.** After Task 14, run `gh workflow run e2e.yml --ref feat/realtime-nudges` (with the `pr` input once the PR exists). Read every job.
- **CS-4, STG-local timing probes** (`e2e/probes/realtime-nudge-*.spec.ts`, written by Tasks 5, 9 and 13). Run them against stg, where a real socket exists.
- **CS-5.** Report the §4.5 public-views finding to the owner (the 9 non-`security_invoker` views granted to anon). The prod check is owed. No code change.
- **CS-6.** Schedule the D-b PR (Task 15) at least 14 days after D-a reaches prod. Send kiosk-reload release notes.
- **CS-7.** Tell the phone team about the contract bumps (`capture-beat.v1.json`, the new `capture-matchday-realtime.v1.json`). They vendor after #68.

## Dependencies and parallel waves

Tasks may run in parallel only when their files are disjoint.

| Wave | Tasks | Why this order |
|---|---|---|
| A | 1 | Everything builds on `broadcast`, the mints and the builders. |
| B | 2 ∥ 3 ∥ 4 | Disjoint files: after-write/scoring; V554 + stub helper; schemas/contracts. |
| C | 5 (needs 4) ∥ 8 (needs 3) ∥ 11 (needs 3; CS-1 runs alongside) | Disjoint. |
| D | 6 (needs 5: `capture-phone.ts`, `deps.ts`) ∥ 9 (needs 4: `capture-schemas.ts`, contract test) | Disjoint. |
| E | 7 (needs 2, 6: `after-write.ts`) ∥ 12 (needs 9: `openapi.ts`) | Disjoint. |
| F | 10 (needs 7, 2: `after-write.ts`, `scoring.ts`) ∥ 13 (needs 12) ∥ 14 (needs 11 + CS-1 + CS-2; `realtime.ts` only) | Disjoint. |
| — | CS-3, CS-4, then the PR. Task 15 is DEFERRED. | |

`lib/realtime.ts` is edited only by Tasks 1 and 14. `after-write.ts` is edited by Tasks 2 → 7 → 10, and `scoring.ts` by Tasks 2 → 10, both strictly in that order.

---

## Phase 0: shared

### Task 1 (T0.1): `broadcast()`, `mintRealtimeToken()`, builders, stale comment, security sweep

**Files:**
- Modify: `lib/realtime.ts`
- Modify: `components/public-site/match-centre/use-live-fixture.ts:289` (comment only)
- Create: `lib/__tests__/realtime-broadcast.test.ts`, `lib/__tests__/realtime-mint-families.test.ts`, `server/__tests__/realtime-role-sweep.test.ts`
- Modify: `lib/__tests__/realtime-publish.test.ts` (golden bodies)

**Decisions:**
- `type RealtimeMessage = {topic: string; event: string; payload: unknown; private?: true}`.
- `broadcast(messages, label): Promise<void>`:
  - empty → no fetch;
  - chunks of `BROADCAST_CHUNK = 100`, one POST each, sequential;
  - each POST keeps today's headers and `AbortSignal.timeout(BROADCAST_TIMEOUT_MS)`;
  - `publishTarget()` null → no fetch;
  - never throws;
  - on failure it warns `[realtime] ${label} broadcast failed (${status})` with no body and no token.
- Builders:
  - `fixtureMessage(id, reason)` and `divisionMessages(id, reason): RealtimeMessage[]`. Today the latter returns only the public message, byte-identical; Task 14 adds the twin.
  - `nudgeMessage(topic, reason)` → `{topic, event: "nudge", payload: {v: Date.now(), reason, at}, private: true}`.
  - Topic builders: `captureTopic(pairingId)`, `matchDayTopic(codeId)`, `divisionTopic(id)`.
- `NudgeReason` types:
  - `CaptureNudgeReason = "go-live"|"stop"|"replaced"|"over"|"next-match"`;
  - `MatchDayNudgeReason = "score"|"schedule"|"call"`.
- `mintRealtimeToken({sub, claims, expiresAt: Date})`: same header, `aud`, `role: authenticated` and `iat`. `exp` = `floor(expiresAt/1000)`.
  - Wrappers: `mintPublicFixtureToken` (keeps the `${ttl}s` behaviour by computing `expiresAt`), `mintExternalPlayLobbyToken`, `mintCaptureToken(pairingId, expiresAt)` (`capture_pairing_id`, sub `capture:{id}`), `mintMatchDayToken(codeId, expiresAt)` (`md_code_id`, sub `md:{id}`), `mintDivisionToken(competitionId, divisionIds, expiresAt)` (`division_ids`, sub `public-competition:{id}`).
- The existing publishers delegate to `broadcast()`.
- Commits:
  - commit a is the verbatim delegation (fixture, division, room);
  - commit b is the lobby publisher gaining the timeout (pin 2);
  - commit c is the builders and mints;
  - commit d is the sweep.
- Header comment: add a "Supabase quotas: UNVERIFIED (CS-2)" block.
- §4.5 sweep (`realtime-role-sweep.test.ts`):
  - **Static** over every `db/migration/**/V*.sql`:
    - (a) no `create policy … on <table other than realtime.messages> … to (authenticated|anon|public)`;
    - (b) every `grant select … to authenticated` is matched by the same grant to `anon`;
    - (c) every `realtime.messages` policy reads exactly one `auth.jwt() ->> '<claim>'`, and no two policies share a claim.
  - **DB-level** when `DATABASE_URL` is set and the `authenticated` role exists. If the role is absent, skip and say why. It checks (a) on `pg_policies` and (b) on `information_schema.role_table_grants`.
  - Anti-vacuity: it reports counts (files, policies, grants); zero scanned fails, and fewer than 2 realtime policies fails.

- [ ] **Step 1: Failing tests.**
  - `broadcast`:
    - 0 messages → 0 fetches;
    - 1 → 1 fetch;
    - 100 → 1;
    - 101 → 2 (100 + 1);
    - 250 → 3;
    - kill switch `REALTIME_PUBLISH=off` → 0;
    - a fetch that never answers aborts at 3 s (fake timers);
    - a 500 and a thrown fetch both resolve, and the warn line contains no message body;
    - second call: an independent POST.
  - Golden bodies: `publishFixtureUpdate`, `publishDivisionUpdate` (score and schedule) and `publishRoomBroadcast`. Each POST body must equal a literal copied from today's code (written out in the test), with `v` and `at` frozen.
  - Mints:
    - each family's `sub`, claim, `aud` and `exp`, decoded with `jose`;
    - claim-overlap sweep over all five mints: no claim key is shared, and no family uses `fixture_id` or `lobby_fixture_id` except its own owner (an empty sweep fails);
    - `division_ids` is a JSON array;
    - another surface: a capture token has no `fixture_id`.
  - Role sweep: as described above, including counts.
- [ ] **Step 2: Run and see them fail** with the vitest recipe on the three new files plus `realtime-publish.test.ts`, `realtime-publish-switch.test.ts` and `realtime-lobby-token.test.ts`.
- [ ] **Step 3: Implement** the decisions in commits a–d. Fix the comment at `use-live-fixture.ts:289` ("publishFixtureUpdate sends the private message only").
- [ ] **Step 4: Verify** the same vitest set plus `server/usecases/__tests__/external-play-play.test.ts` and `external-play-room-game.test.ts`, then the scoped tsc.
- [ ] **Step 5: Mutate once each:**
  - `BROADCAST_CHUNK = 101` (the 101 case dies);
  - drop `private: true` from `nudgeMessage` (its test dies);
  - add a scratch `V999__x.sql` with `create policy p on public.fixtures for select to authenticated using (true)` (sweep (a) dies), then delete it.
- [ ] **Step 6: Four types.**
  - Unit: above.
  - Regression: golden bodies.
  - E2E: traced forward. No new spec; the existing `stream-overlay.spec.ts` and `device-links.spec.ts` cover the fixture door and push, and the controller dispatch runs them.
  - Smoke: none new; the existing captureV2 suite exercises the publishers.
- [ ] **Commit:** `refactor(realtime): one broadcast transport, family mints and topic builders` (+ the separate `fix(realtime): lobby publish gains the 3 s timeout`, `test(security): role sweep for authenticated tokens`).

### Task 2 (T0.2): batch `afterScheduleWrite` and the scoring callback

**Files:**
- Modify: `server/usecases/schedule/after-write.ts:66-69`, `server/usecases/scoring.ts:520-523`
- Create: `server/usecases/__tests__/realtime-batch-fanout.test.ts`
- Modify (translate spies, never loosen): `hub-cache-invalidation.test.ts`, `schedule-fixture-cache-keys.test.ts`, `schedule-slot-writes-cache-keys.test.ts`, `score-revalidate-in-request.test.ts`

**Decisions:**
- Inside `sendAfterDeleteOrBound`, build `[...divisionMessages(div, reason), ...(pushFixtures ? ids.map(id => fixtureMessage(id, "schedule")) : [])]` and send it as `void broadcast(msgs, "schedule")`.
- Scoring: `[fixtureMessage(f,"event"), ...(scope ? divisionMessages(scope.divisionId,"score") : []), ...advanced.map(id => fixtureMessage(id,"schedule"))]` in one call. The `.catch` fallback (:533) stays a single fixture message.
- The bounded-after-DEL ordering is unchanged.

- [ ] **Step 1: Failing tests.** Count real fetches with `REALTIME_PUBLISH` unset, stubbed env URL and key, and a `fetch` spy.
  - `afterScheduleWrite` with N = 1, 50 → exactly **1** POST (today 2 and 51), carrying N fixture messages and 1 division message;
  - N = 51 → 1 POST with the division message only;
  - N = 0 → 1 POST (division);
  - `fixturePushes:false` → division only;
  - second write → a second POST;
  - a score with 2 advanced fixtures → 1 POST with 4 messages;
  - a score whose scope is null → fixture only;
  - another surface: `void-lines` is untouched (still its own publishes; Task 10 batches it).
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement**, and translate the four existing tests' spies to a `broadcast` spy that asserts the same topics and reasons at the same moments (before or after the DEL, at the bound, exactly once).
- [ ] **Step 4: Verify** the 5 files, then the scoped tsc.
- [ ] **Step 5: Mutate:** send the fixtures in a loop of `broadcast` calls → the 1-POST regression dies.
- [ ] **Step 6: Four types.**
  - Unit and regression: above (the fetch-count regression from §5).
  - E2E: traced to `schedule-board.spec.ts` and `hub-knockout.spec.ts` (a push still refreshes them), run by the controller dispatch.
  - Smoke: the `autoSchedule` suite exercises `afterScheduleWrite`; no change.
- [ ] **Commit:** `perf(realtime): one broadcast per schedule write and per score`

---

## Phase 1: capture

### Task 3 (T1.1): V554 `capture pairing read by claim`

**Files:**
- Create: `db/migration/deltas/V554__capture_realtime_policy.sql`
- Create: `lib/__tests__/helpers/realtime-stub.ts` (verbatim move of `stubRealtime`, `rolledBack`, a parametrised `visibility(topics, claims)`, `readPolicies(names)`)
- Modify: `lib/__tests__/resolvers-plpgsql.test.ts` (import the helper; no behaviour change)
- Create: `lib/__tests__/realtime-policies.test.ts`

**Decisions:**
- V403 guards: no realtime schema → notice and return; no `realtime.messages` → return; the policy already exists → return; `insufficient_privilege` → notice.
- Policy: `for select to authenticated using (extension = 'broadcast' and (select realtime.topic()) = ('capture:' || (select auth.jwt() ->> 'capture_pairing_id')))`.

- [ ] **Step 1: Failing tests** (stubbed realtime, rolled back), each running V403, V452, V537, then V554:
  - a capture token reads `capture:A` and not `capture:B`;
  - a capture token reads neither `fixture:A` nor `external-play:A`;
  - a `fixture_id` token does not read `capture:A`;
  - `{}` reads nothing;
  - a second run of V554 is a no-op (one policy row, the "already present" notice);
  - no realtime schema → the skip notice, no error.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3:** Write V554 and move the helper (the move is its own commit, so `resolvers-plpgsql.test.ts` stays green, run before and after).
- [ ] **Step 4: Verify** both test files and the Task 1 role sweep (its policy count rises to 3).
- [ ] **Step 5: Mutate:** change the claim to `fixture_id` → the cross-family test and sweep (c) die.
- [ ] **Step 6: Four types.** Unit and regression above. E2E and smoke are traced to Task 5's specs (a subscriber joining with the token).
- [ ] **Commit:** `feat(db): V554 capture pairing realtime policy`

### Task 4 (T1.2): `CaptureRealtime` schema, contract and fixtures

**Files:**
- Modify: `server/api-v1/capture-schemas.ts:190-212`
- Modify: `docs/contracts/capture-beat.v1.json`
- Create fixtures in `docs/contracts/fixtures/capture-beat.v1/`: `answer-valid-live-realtime.json`, `answer-valid-go-live-realtime.json`, `answer-invalid-null-realtime.json`, `answer-invalid-realtime-extra-key.json`, `answer-invalid-realtime-url-in-topic.json`, `answer-invalid-replaced-realtime.json`, `answer-invalid-realtime-http-url.json`
- Modify: `server/api-v1/__tests__/capture-contract.test.ts` (SHA256 pin, counts), `server/relay/domain/beat-answer.ts` (type plus pass-through), `server/relay/domain/__tests__/beat-answer.test.ts`
- Generated: `openapi/*`

**Decisions:**
- `CaptureRealtime = z.strictObject({url: https URL, apikey: z.string().min(1).max(512), topic: z.string().regex(/^capture:[0-9a-f-]{36}$/), token: z.string().min(1).max(4096), expiresAt: EpochS})`.
- `AnswerCommon` gains `realtime: CaptureRealtime.optional()`. The replaced and taken branches use `AnswerCommon.omit({realtime:true}).partial()…`.
- `BeatAnswerCommon` gains `realtime?: CaptureRealtime | null`. `wireBeatAnswer` picks the five fields by name on the waiting, go-live, live and over branches only; it is omitted when null.
- A test asserts `realtime` is not one of the reserved read names.

- [ ] **Step 1: Failing tests.**
  - The new valid fixtures parse; the invalid ones are refused, including `realtime: null`, an extra key, an `http:` url, a topic with a URL, and replaced with `realtime`.
  - The tampered guard still refuses one extra key on every branch.
  - `wireBeatAnswer`:
    - with `realtime` on live → present;
    - with it on replaced or taken → absent;
    - with null → the key is absent;
    - `pollSeconds` is identical with and without it (constraint 4);
    - second call: the same input gives the same output.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.** Bump the contract (additive optional property), its `SHA256` pin and the counts. Run `npm run openapi:gen`.
- [ ] **Step 4: Verify** both test files, then the scoped tsc. The openapi diff is additive only.
- [ ] **Step 5: Mutate:** drop the `.omit` on replaced → `answer-invalid-replaced-realtime` dies.
- [ ] **Step 6: Four types.** Unit and regression above. E2E and smoke land in Task 5.
- [ ] **Commit:** `feat(capture): optional realtime object on the beat answer (contract bump)`

### Task 5 (T1.3): mint and wire into `runBeat` through deps

**Files:**
- Modify: `server/usecases/stream-sessions/deps.ts` (`realtime?: CaptureRealtimePort`, `realtimeOf(deps)`; not a getter in `defaultDeps`)
- Modify: `server/usecases/capture-phone.ts:770-783`
- Create: `server/usecases/capture-realtime.ts` (`captureRealtimeFor(pairingId, now, deps)`)
- Tests: `server/usecases/__tests__/capture-beat-realtime.test.ts`
- Smoke: `scripts/smoke/suites/captureV2.ts`
- E2E: `apps/web/e2e/stream-phone-panel.capture.ts` (extend), `apps/web/e2e/probes/realtime-nudge-capture.spec.ts` (STG-local, CS-4)

**Decisions:**
- `CaptureRealtimePort = {mint(pairingId, expiresAt): Promise<string>, config(): {url, apikey} | null}`. Its default reads `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- Guard: `url` must be `https:` and its host must equal `new URL(NEXT_PUBLIC_SUPABASE_URL).host`; otherwise omit and log.
- `CAPTURE_REALTIME_TTL_SECONDS = 1800` lives in `relay/config.ts` beside the POLL constants. It is not a cadence.
- In `runBeat` step 7, only when `decided.mine !== null && holder?.id === decided.mine.id && answer state ∉ {replaced, taken}`: mint, wrapped in `try`. On a throw, log `{err: String(err), codeId}` and the Sentry route `capture.beat.realtime_mint` with no token, and answer without the key.
- The stored `answered_poll_seconds` is untouched.
- Court codes are covered because `postCourtBeat` calls `runBeat` (pin 8).

- [ ] **Step 1: Failing tests** (real DB, stub port):
  - present on waiting, go-live, live, and on over while the caller is still current;
  - absent on taken, on replaced (a takeover by phone B, then A's beat), and on over after its own `ended` (pairing ended at :689);
  - a mint throw → 200, the beat stored, the key absent;
  - with a config of `http:` or a foreign host → absent;
  - `pollSeconds` and `answered_poll_seconds` are equal with and without the port;
  - second beat → a fresh token (different `iat`, frozen clock advanced 1 s);
  - another surface: a court code's beat carries a `capture:{courtPairing}` topic;
  - log-redaction spy: no `log.*`, `console.*` or `captureError` argument contains the token substring (assert it was checked at least once).
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** the new file, `capture-beat.test.ts`, `capture-court.test.ts` and `capture-model.test.ts`, then the scoped tsc.
- [ ] **Step 5: Mutate:** remove the `try` → the mint-throw test dies; drop the current-pairing check → the replaced test dies.
- [ ] **Step 6: Four types.**
  - Smoke `captureV2`: the beat answer has a `realtime` key with exactly 5 keys, and the token is absent from response headers and URL.
  - E2E: the panel flow asserts `realtime` on go-live and an unchanged `pollSeconds`; `--list` only.
  - Regression: the `pollSeconds` invariance.
- [ ] **Commit:** `feat(capture): mint a 30-min realtime token on the current pairing's beat`

### Task 6 (T1.4): `stream-sessions/nudge.ts`, the apply hook, `replaced` and code end

**Files:**
- Create: `server/usecases/stream-sessions/nudge.ts`
- Modify: `stream-sessions/apply.ts:88-165`, `stream-sessions/deps.ts` (`publish?:` on the port), `capture-phone.ts:612-640` (Decided gains `replacedPairingIds`)
- Modify: `stream-codes.ts:218,245` and `court-streams.ts:158,243,299` (after each tx)
- Test: `server/usecases/__tests__/capture-nudges.test.ts`

**Decisions:**
- `nudgeReasonFor(from, to): CaptureNudgeReason | null` is pure:
  - entry into `provisioning` or `warming` → `go-live` (pin 12);
  - into `ending` → `stop` (every end reason, `auto_stopped` included);
  - into `completed` or `failed` → `over`;
  - `from === to` → null.
- `apply` returns `from` from the transaction. After the transaction and before `runEffects`, it calls `void nudgeSession(sessionId, reason, deps)`.
- `nudgeSession` uses a pooled read, never inside the transaction. The target is the session's `pairing_id` if that pairing is still open, else the open slot-0 pairing on the session's `code_id`. With neither, nothing is sent.
- The claim pings `replaced` to the old pairing after the transaction.
- Code end sends `over` to every open pairing of the code after the transaction, at the reissue and withdraw sites only. Expiry sites are lazy (found on a phone's own call, which already answers 401); this is a deviation from the spec, to be flagged.
- Everything is fire-and-forget through `broadcast`.

- [ ] **Step 1: Failing tests.**
  - A table over every (from, to) in `SessionState`² gives its reason or null; the empty case is the same state.
  - Through the real `apply`:
    - a stop → one `stop` message on `capture:{pairing}`;
    - a second identical apply (`cmd` null) → none;
    - after a resume that moves the pairing (I-2 path) → the ping goes to the new pairing.
  - A takeover → `replaced` on the old pairing and none on the new.
  - Reissue with 2 open pairings → 2 `over` messages.
  - Withdrawing a court link → `over`.
  - A session with no open pairing → 0 messages, no error.
  - The phone's own `ended` beat → no ping for the operator's stop by the hook? Decision: it still pings `stop` to an already ended pairing → 0 targets. Assert 0.
  - The publish port throws → the apply still returns the session.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** the new file plus scoped `stream-sessions.test.ts -t "apply"`, `capture-beat.test.ts`, `capture-court.test.ts` and `court-stream*.test.ts`, then the scoped tsc.
- [ ] **Step 5: Mutate:** read `session.pairing_id` without the open check → the resume test dies; publish inside `sql.begin` → the nesting-guard test (pooled read in a transaction) dies.
- [ ] **Step 6: Four types.**
  - E2E: extend `stream-phone-panel.capture.ts` (desk Stop → the phone's next beat within ≤ cadence, with the push counted via a stub host); `--list`.
  - Smoke: `captureV2` stop path (a ping is not asserted on the wire; the answer is `over`).
  - Regression: the second-apply no-ping.
- [ ] **Commit:** `feat(capture): nudge the current pairing on session transitions, replace and code end`

### Task 7 (T1.5): court `next-match` pings from `afterScheduleWrite`

**Files:**
- Modify: `server/usecases/schedule/after-write.ts`
- Modify: `stream-sessions/nudge.ts` (`courtPairingNudges(fixtureIds)`)
- Test: `server/usecases/__tests__/court-next-match-nudge.test.ts`

**Decisions:**
- Only when `pushFixtures` is true (≤ `SCHEDULE_FIXTURE_PUSH_CAP`).
- One pooled read: fixtures → `court_id` → `court_stream_links` (competition, not withdrawn, `opens_at <= now < expires_at`) → `fixture_stream_codes.court_link_id` (open) → slot-0 open pairing. Each distinct pairing gets one message.
- The read happens before the `broadcast` call, inside the after-DEL callback, as an async IIFE whose rejection is caught. Still exactly 1 POST.

- [ ] **Step 1: Failing tests:**
  - a move of a fixture on court C with a live link → a `next-match` on C's pairing inside the same single POST;
  - 2 fixtures on C → 1 message;
  - no link, a withdrawn link, or a link for another day → 0;
  - N > 50 → 0 and no read;
  - a read that throws → the division and fixture messages are still sent;
  - another surface: a fixture code (not a court) gets no `next-match`.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** this file plus `realtime-batch-fanout.test.ts` and `hub-cache-invalidation.test.ts`, then the scoped tsc.
- [ ] **Step 5: Mutate:** drop `withdrawn_at is null` → the withdrawn test dies.
- [ ] **Step 6: Four types.** E2E is traced to `stream-phone-panel.capture.ts` court flow (`--list`). Smoke: `captureV2`'s court leg. Regression: the 1-POST count holds with court messages.
- [ ] **Commit:** `feat(capture): next-match nudge to a court's pairing on schedule writes`

---

## Phase 2: Match Day

### Task 8 (T2.1): V555 Match Day policy

**Files:** Create `db/migration/deltas/V555__match_day_realtime_policy.sql`. Modify `lib/__tests__/realtime-policies.test.ts`.

**Decision:** the policy `match day code read by claim`: `(select realtime.topic()) = ('match-day:' || (select auth.jwt() ->> 'md_code_id'))`, in V554's shape.

- [ ] **Step 1: Failing tests:**
  - an md token reads `match-day:A` only;
  - it reads neither `capture:A` nor `fixture:A`;
  - capture and fixture tokens do not read `match-day:A`;
  - `{}` reads nothing;
  - a rerun is a no-op;
  - no schema → skip.
- [ ] **Step 2:** fail. **Step 3:** write V555. **Step 4:** verify the file plus the role sweep (count 4).
- [ ] **Step 5: Mutate:** claim `capture_pairing_id` → the cross-family test dies.
- [ ] **Step 6: Four types:** as Task 3; E2E and smoke via Task 9.
- [ ] **Commit:** `feat(db): V555 match day realtime policy`

### Task 9 (T2.2): Match Day door, `MdBudget` `realtime`, contract, `MD_DAY_LIMIT` 1800

**Files:**
- Create: `app/api/v1/match-day-code/realtime-token/route.ts`
- Modify: `server/api-v1/match-day-code-door.ts:41-50`, `lib/rate-limit.ts:207-227` (`MD_REALTIME_LIMIT = {max:120, windowSeconds:60}`; `MD_DAY_LIMIT` 600 → **1800**, with its comment rewritten as 150 phones × 12/min)
- Modify: `server/api-v1/capture-schemas.ts` (`CaptureMatchdayRealtime`)
- Create: `docs/contracts/capture-matchday-realtime.v1.json` and `docs/contracts/fixtures/capture-matchday-realtime.v1/` (valid, invalid-extra-key, invalid-http-url, refusal-valid-*)
- Modify: `capture-contract.test.ts` (pin, rulebook, count), `server/api-v1/openapi.ts`
- Tests: `app/api/v1/match-day-code/__tests__/realtime-token.test.ts`
- Smoke: `scripts/smoke/suites/matchDayRealtime.ts` + `scripts/smoke/index.ts`
- E2E: `apps/web/e2e/match-day.spec.ts` (extend), `apps/web/e2e/probes/realtime-nudge-match-day.spec.ts`

**Decisions:**
- `matchDayCodeOf(req, now, "realtime")`.
- TTL = `min(3600 s, expires_at − now)`.
- Reply `{token, topic, expiresAt, url, apikey}` with `cache-control: private, no-store`.
- The Bearer token is in the header only.
- No entitlement check.

- [ ] **Step 1: Failing tests:**
  - 200 shape and header;
  - `expiresAt` = the code's `expires_at` when that is under 60 min;
  - 401 with no bearer, and 401 when `?token=md_…` is in the query (not accepted);
  - 410 withdrawn or ended; 403 not open;
  - 429 after 120 calls with `Retry-After`, and the `md_day` bucket is untouched;
  - second call → a fresh token;
  - after a withdrawal → 410 (no re-mint);
  - the day read now admits 1800 per minute and refuses the 1801st;
  - log-redaction spy for both the token and the `md_` credential;
  - contract fixtures.
- [ ] **Step 2:** fail. **Step 3:** implement and run `openapi:gen`.
- [ ] **Step 4: Verify** the new file, `capture-contract.test.ts` and `match-day-codes.test.ts`, then the scoped tsc.
- [ ] **Step 5: Mutate:** spend the `day` budget → the bucket-isolation test dies; TTL fixed at 3600 → the short-code test dies.
- [ ] **Step 6: Four types.**
  - Smoke `matchDayRealtime`: status codes, `no-store`, and no token in headers.
  - E2E: `match-day.spec.ts` gets the door answer from a real `md_` code (`--list`).
  - Regression: the `MD_DAY_LIMIT` = 1800 pin.
- [ ] **Commit:** `feat(match-day): realtime token door and nudge-ready day budget`

### Task 10 (T2.3): `match-day-nudges.ts` and its callers

**Files:**
- Create: `server/usecases/match-day-nudges.ts`
- Modify: `scoring.ts:520-523`, `void-lines.ts:155-166` (batched like Task 2), `schedule/after-write.ts` (`opts.reason?: "call"`), `match-day-call.ts:563,605` (pass `{reason:"call"}`)
- Test: `server/usecases/__tests__/match-day-nudges.test.ts`

**Decisions:**
- `matchDayNudgeMessages(competitionId, reason, now)` reads `match_day_codes` where `competition_id = $1 and revoked_at is null and opens_at <= now and now < expires_at`. The result is memoised 15 s per instance, keyed by competition.
- Callers append the messages to their one `broadcast`. Reasons: score → `score`; schedule writes → `schedule`, or `call` from `match-day-call`.
- `player-stats-refresh` is untouched.
- A failed read means no MD messages and never a lost batch.

- [ ] **Step 1: Failing tests:**
  - 0 open codes → `[]`;
  - revoked, expired and not-yet-open codes are excluded;
  - two codes on the competition → 2 messages;
  - another competition's code → excluded;
  - within 15 s a new code is not seen, at 15 s it is (fake clock);
  - score → 1 POST including the MD messages;
  - void-lines → 1 POST (today 1 + N);
  - match-day call → reason `call`;
  - a read throw → the batch is still sent;
  - after a withdrawal (revoke) and memo expiry → excluded.
- [ ] **Step 2:** fail. **Step 3:** implement.
- [ ] **Step 4: Verify** this file plus `realtime-batch-fanout.test.ts`, `match-day-code-call.test.ts` and `hub-cache-invalidation.test.ts`, then the scoped tsc.
- [ ] **Step 5: Mutate:** drop `revoked_at is null` → the revoked test dies; memo TTL 0 → the 15 s test dies.
- [ ] **Step 6: Four types.** E2E: `match-day.spec.ts` score → the day read updates (`--list`); the timing probe goes to CS-4. Smoke: `matchDayRealtime` scores once and the day read stays 200. Regression: the void-lines 1-POST count.
- [ ] **Commit:** `feat(match-day): nudge open codes on score, schedule and call`

---

## Phase 3: division topics go private (D-a)

### Task 11 (T3.1): V556 division policy (+ CS-1 gate)

**Files:** Create `db/migration/deltas/V556__division_realtime_policy.sql`. Modify `lib/__tests__/realtime-policies.test.ts`.

**Decision:** `(select realtime.topic()) like 'division:%' and ((select auth.jwt()) -> 'division_ids') ? substr((select realtime.topic()), 10)`.

- [ ] **Step 1: Failing tests:**
  - `division_ids ["A","B"]` reads `division:A` and `division:B` but not `division:C`;
  - `[]` reads nothing;
  - it does not read `fixture:A`, `capture:A` or `match-day:A`;
  - a `fixture_id: "A"` token does not read `division:A`;
  - a scalar `division_ids: "A"` reads nothing;
  - a rerun is a no-op.
- [ ] **Step 2:** fail. **Step 3:** write V556. **Step 4:** verify the file plus the role sweep (count 5).
- [ ] **Step 5: Mutate:** `substr(…, 9)` → the A/B test dies.
- [ ] **Step 6: Four types:** as Task 3. Then **hand off to the controller for CS-1**, which blocks Task 14.
- [ ] **Commit:** `feat(db): V556 division realtime policy by division_ids`

### Task 12 (T3.2): competition door (spectator and official), `pubv1rt`

**Files:**
- Create: `app/api/v1/public/competitions/[id]/realtime-token/route.ts`, `server/public-site/division-realtime.ts`
- Modify: `server/usecases/public.ts` (`publicRealtimeTokenRateLimit`, key `pubv1rt:`, 120/min), `app/api/v1/public/__tests__/poll-rate-limit.test.ts` (third bucket), `server/api-v1/openapi.ts`
- Test: `app/api/v1/public/__tests__/competition-realtime-token.test.ts`
- Smoke: `scripts/smoke/suites/divisionRealtimeDoor.ts` + `index.ts`

**Decisions:**
- Spectator path: competition via `public_competitions_v`, divisions via `public_divisions_v`, then `org_has_feature(org,'realtime',comp)`.
- Official path: a cookie user with any org role, or an accepted official on a fixture of the competition (pin 17). All divisions come from the base tables.
- 0 divisions → 403 `no_divisions`. More than 100 → 403 `too_many_divisions`.
- TTL 3600. Reply `{token, divisionIds, expiresAt}` with `private, no-store`.
- The token is never written to the hub document or SSR.

- [ ] **Step 1: Failing tests:**
  - anonymous, entitled, public → 200 with every public division (including a not-yet-live one) and `no-store`;
  - anonymous, not entitled → 403;
  - private competition, anonymous → 404;
  - a member of the org on a private competition → 200 with all divisions;
  - an accepted official → 200; a declined one → 403;
  - 101 divisions → 403 `too_many_divisions`; 0 → 403;
  - second call → a fresh token;
  - after a division is withdrawn (deleted) → absent from `divisionIds`;
  - the 121st call → 429, and the `pubv1` and `pubv1poll` buckets are untouched;
  - log-redaction spy;
  - hub-document guard: the cached hub JSON contains no `eyJ` and no `token` key.
- [ ] **Step 2:** fail. **Step 3:** implement and run `openapi:gen`.
- [ ] **Step 4: Verify** the 2 files, then the scoped tsc.
- [ ] **Step 5: Mutate:** skip the entitlement check → the not-entitled test dies; cap at `> 101` → the 101 test dies.
- [ ] **Step 6: Four types.** Smoke `divisionRealtimeDoor`: 200 or 403, `no-store`. E2E is traced in Task 13. Regression: the bucket isolation.
- [ ] **Commit:** `feat(public): competition realtime token door for private division topics`

### Task 13 (T3.3): `realtimeClient(family)`, hub, slideshow and board go private

**Files:**
- Modify: `lib/supabase-browser.ts` (`realtimeClient(family: "fixture"|"division"|"lobby")`; `supabaseBrowser()` stays as is for the unchanged callers)
- Create: `lib/division-realtime-auth.ts` (fetch the door, refresh at 50 min or on `CHANNEL_ERROR`/`CLOSED` with backoff; a 403 or 429 → `null`)
- Modify: `use-live-competition.ts:309-373` (needs `competitionId` from `initial.competitionId`), `components/v2/slideshow.tsx:42-43,215-260` (`competitionId` prop; `SUBSCRIBED_POLL_MS` → 60 s), the 4 slideshow pages, `components/v2/board/use-board-actions.ts:801-829` (+ a 60 s safety-net `router.refresh` poll), `use-live-fixture.ts:321`, `use-fixture-stream.ts:57`, `use-room.ts:182` (family clients)
- Tests: `components/public-site/__tests__/use-live-competition.test.tsx`, `components/v2/__tests__/slideshow-realtime.test.tsx`, `components/v2/board/__tests__/board-realtime.test.tsx`, `lib/__tests__/supabase-browser-families.test.ts`
- E2E: `apps/web/e2e/division-realtime-door.spec.ts`, `apps/web/e2e/probes/realtime-nudge-division.spec.ts`

**Decisions:**
- Each family gets its own `createClient`. On a door token, `setAuth(token)` runs, then `.channel("division:"+id, {config:{private:true}})`.
- A 403 or 429 means no channel; the page polls.
- The public `division:` topic is never joined.

- [ ] **Step 1: Failing tests:**
  - `realtimeClient("division") !== realtimeClient("fixture")`, and the same family returns the same client;
  - the hub on a 200 joins private with `setAuth` called first, and on a 403 stays on `HUB_POLL_MS`;
  - a second live division needs no re-fetch;
  - refresh at 50 min (fake timers);
  - `CHANNEL_ERROR` → a re-fetch with backoff;
  - the slideshow's subscribed poll is 60 s;
  - the board polls every 60 s, also with push up;
  - another surface: a page mounting the fixture and division families keeps two clients and two `setAuth` calls;
  - SSR: the server-rendered HTML contains no token.
- [ ] **Step 2:** fail. **Step 3:** implement.
- [ ] **Step 4: Verify** the 4 files, then the scoped tsc.
- [ ] **Step 5: Mutate:** board poll interval `Infinity` → the board regression dies; one shared client → the families test dies.
- [ ] **Step 6: Four types.**
  - E2E `division-realtime-door.spec.ts`: the hub, slideshow and board call the door; with a 403 stub the page still updates within its poll (`--list`).
  - The timing probe goes to CS-4.
  - Smoke: `divisionRealtimeDoor`.
  - Regression: the board poll.
- [ ] **Commit:** `feat(public): hub, slideshow and board join private division topics`

### Task 14 (T3.4): dual publish (D-a)

Gate: CS-1 passed and CS-2 recorded.

**Files:** Modify `lib/realtime.ts` (`divisionMessages` → `[publicMsg, {...publicMsg, private: true}]`) and `lib/__tests__/realtime-publish.test.ts`.

- [ ] **Step 1: Failing tests:**
  - `publishDivisionUpdate` → 1 POST with 2 messages: the public one equals the Task 1 golden body, and the twin is identical plus `private: true`;
  - the Task 2 batch → 1 POST with the twin;
  - `player-stats-refresh` (another surface) → twin included;
  - 0 divisions → no POST.
- [ ] **Step 2:** fail. **Step 3:** implement. **Step 4:** verify `realtime-publish.test.ts`, `realtime-batch-fanout.test.ts` and `hub-cache-invalidation.test.ts`.
- [ ] **Step 5: Mutate:** drop the public message → the golden test dies (D-a must keep it).
- [ ] **Step 6: Four types.** E2E: `division-realtime-door.spec.ts` plus the existing `hub-knockout.spec.ts` (an old public tab still refreshes), run via CS-3. Smoke: the hub refresh. Regression: the golden twin.
- [ ] **Commit:** `feat(realtime): dual-publish division updates (public + private twin)`

### Task 15 (T3.5): D-b, drop the public message. **DEFERRED**, not in this PR

Owner: a separate PR at least 14 days after D-a reaches prod (CS-6).

**Files:** `lib/realtime.ts`, `lib/__tests__/realtime-private-sweep.test.ts`.

- [ ] Failing sweep: spy on every message `broadcast()` is handed across `publishFixtureUpdate`, `publishDivisionUpdate`, `publishRoomBroadcast`, `publishExternalPlayLobby`, an `afterScheduleWrite` call and the score callback. Every message must have `private: true`, and an empty sweep fails.
- [ ] Implement: `divisionMessages` returns the private message only.
- [ ] Verify; mutate by re-adding the public message → the sweep dies.
- [ ] Commit `feat(realtime): division topics private only (D-b)`

## Review focus

1. A failed mint never fails a beat, and `pollSeconds` never changes (Task 5).
2. No token reaches a log, a URL, the hub document or SSR (Tasks 5, 9, 12, 13).
3. Claim names are never shared across families (Tasks 1, 3, 8, 11).
4. One POST per write, including during the dual window (Tasks 2, 7, 10, 14).
5. A replaced or taken phone gets no `realtime` object (Tasks 4, 5).
6. The board and kiosk stay fresh when push is silent (Task 13).

### Critical Files for Implementation
- /Users/ashokhein/github/seazn.club-worktrees/realtime-nudges/apps/web/src/lib/realtime.ts
- /Users/ashokhein/github/seazn.club-worktrees/realtime-nudges/apps/web/src/server/usecases/capture-phone.ts
- /Users/ashokhein/github/seazn.club-worktrees/realtime-nudges/apps/web/src/server/usecases/stream-sessions/apply.ts
- /Users/ashokhein/github/seazn.club-worktrees/realtime-nudges/apps/web/src/server/usecases/schedule/after-write.ts
- /Users/ashokhein/github/seazn.club-worktrees/realtime-nudges/apps/web/src/server/api-v1/capture-schemas.ts
