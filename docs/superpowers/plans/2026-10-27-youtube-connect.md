# YouTube Connect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An org admin connects its YouTube channel once in Directory → Streaming. From then on, every Go live on that
destination gets its own live, titled YouTube broadcast that Seazn creates, binds, keeps open through a 5-minute restart
window, and ends. Every match gets its replay link(s).

**Architecture:** The connection is a new org-scoped table holding a sealed refresh token (new KEK `YOUTUBE_TOKEN_KEK`).
It appears as an `org_stream_targets` row (`kind = 'youtube'`, FK to the connection, `rtmp_enc` null), so every existing
reader keeps working. A `YouTubePort` with a live Google driver and a deterministic fake is selected per process, like
`RELAY_DRIVERS`. Go live adds a prepare step that reuses or creates a broadcast on a pooled key (sealed under RELAY_KEK)
and makes no YouTube call while it holds a lock. `add_output` then reads the pooled key. Ending is computed from facts
(`fixture_stream_sessions.ended_at`, `fixtures.status`/`finished_at`) by a new first step of the existing stream tick,
which now fires on every fast firing (every minute on prod, every 5 min on stg — Q1 ruled (b)). It runs claim → commit → call → finalize. The daily relay sweep gains
health, 30-day refresh and 30-day purge. The relay, the compositor and `docs/contracts/relay-job.v1.json` do not change.

**Tech Stack:** Next (the repo fork, see `AGENTS.md`; read `node_modules/next/dist/docs/` before touching a route),
TypeScript 7, Node 26, postgres.js (`sql.begin`), Postgres 17 + Flyway deltas, zod + the api-v1 OpenAPI registry,
vitest (`environment: "node"`), Playwright via CI dispatch only, Cloudflare cron Worker (`apps/cron-worker`), the
YouTube Data API v3 + Google OAuth 2.0 (web server flow + PKCE).

**Spec:** `docs/superpowers/specs/2026-10-27-youtube-connect-design.md`. It is owner-approved, and its §0 decisions
D1–D11 are the owner's and are not re-decided here. Executors read the spec section a task cites before starting it.

**Branch and merge.** Implementation happens on the new branch `feat/youtube-connect` in its own worktree
`/Users/ashokhein/github/seazn.club/.claude/worktrees/youtube-connect`, cut from `docs/youtube-connect-spec` (T0).
Batches B1–B7 are PR-sized **review gates** on that one branch, not separate merges. D11 (no feature switch) means a
merged B3 would put **Connect YouTube** on prod before Go live could use it. So there is **one PR**: a draft from the
end of B1, merged after B7, and only on the owner's explicit go.

---

## Findings: spec pins re-verified on `9b5e014eb8` (origin/main `1e0ffaaf1e` + spec)

Every §3.2 pin was re-checked against the tree. The pins not listed here hold. Lines below are as of `9b5e014eb8`;
executors re-pin each one by symbol (`grep -an <symbol>`) before editing.

| # | Spec says | The tree says | Plan does |
|---|---|---|---|
| F1 (FALSE) | `targetHolderFor` call sites `stream-sessions.ts:1250,1644,1821`. | `:1250` is the definition, `:1644` is the **only** call, and `:1821-1826` is the 23505 mapper for the V421 index. | T3 narrows `holderRows` and the V421 index. The mapper stays as it is: once the index is narrowed, an API row can never raise it. |
| F2 (FALSE) | The tick's break is at `:2424-2427`. | The budget check is at `:2419` and `break` at `:2421`. | T15 edits by symbol (`STREAM_TICK_BUDGET_MS`). |
| F3 (FALSE) | "Email-outbox shares the fast trigger and is unaffected." | `email-outbox` is `due: { kind: "every" }` on `FAST_TRIGGER` (`schedule.ts:147-153`). Today it runs every 5 min on stg, under owner ruling 2026-10-20. Changing stg's `FAST_TRIGGER` to `* * * * *` makes it run **every minute on stg**. The `FAST_TRIGGER` doc comment (`schedule.ts:55-57`) says stg keeps `*/5` because "stg is `min_machines_running = 0`, and a minute trigger would keep it awake all day". | **Owner ruled Q1 = (b), 2026-10-27:** stg's `FAST_TRIGGER` stays `*/5`; `wrangler.json` and the email-outbox cadence are unchanged. Stream-tick runs on every fast firing (prod every minute, stg every 5 min), so on stg an end can land up to 5 min late: T22's stg window is [5, 10) min. |
| F4 | Only `targetHolderFor` treats the target as the unit of exclusivity. | Four more places do. (a) `tearDownPriorMachines` (`:1292`, `or target_id = $t` at `:1300`). (b) `releasePriorOutputs` (`:1340`, `:1350`); both refuse `target_in_use` over **another fixture's** leftovers on the same target. (c) `holderRows` (`stream-target-holders.ts:43`), which also feeds the Directory `inUse`, Replace/Remove and `expireTargetHolders` (`:2952`). (d) `readKeyHints` (`secret-columns.ts:282`) opens every row's `rtmp_enc`. | T3 narrows (a), (b) and (c) to pasted rows. For an API row, another fixture's leftovers are on a different pooled key and cannot collide. T3 also filters (d) to `rtmp_enc is not null`. |
| F5 | `readTargetSecret` is read at `:922` (`add_output`). | There are four readers: `:922` (`runEffects`), `:1454` (`refuseUnreadableTarget`), `:1741` (admission) and `:2878` (`sessionFactsForJob`, the passthrough job facts). Each throws on a null `rtmp_enc`. | T11 adds one helper, `readSessionDestination`, used at `:922` and `:2878`, so the job contract shape is unchanged. Admission and the early probe skip the secret read for API rows. |
| F6 | `:1741` is "admission". | `:1741` is the in-transaction `readTargetSecret`. `admit` is called at `:1696` (W5 probe), `:1708` (unreadable probe) and `:1724` (authority). | T11 places prepare by symbol (after `refuseUnreadableTarget`, before `storageUsage()`). |
| F7 | The relay-sweep runs the daily YouTube work. | `relay-sweep/route.ts:24` returns `{ disabled: true }` **before** sweeping on a relay-disabled deployment. This is the same trap §6.6 names for the tick. | T17 runs the YouTube daily pass **before** that return, the same fix as the tick (T15). |
| F8 | `fixtures.finished_at` marks a finished match. | Since V432 (`:19-31`) the trigger also stamps `finished_at` on `needs_decision`. | The end rule (T13) decides "finished" from `fixtures.status ∈ {decided, finalized, forfeited, abandoned, cancelled}` and takes F from `finished_at` only then. |
| F9 | Persist at `:188`; Effect union `session.ts:154-161`; `release_output` prepended at `:364-365`; `credit_refused` at `:419`. | Persist `:180`; union `:154-166`; prepend `:370`; `:418` is inside `apply()`'s own body, not a call site. | Pointers only. No task builds on them. |
| F10 | `apply()` direct callers listed in §3.2. | Nine more call sites exist that the list omits: `:687, :886, :982, :1844, :1901, :1910, :2128, :2580, :2591`. | T14's "every end path" sweep enumerates **terminal states reached**, not call sites (see T14 Step 1), so a path the list missed is still covered. |
| F11 | Google sign-in scopes live in `lib/oauth.ts`. | They are in `app/api/auth/google/route.ts:44-47`. `lib/oauth.ts` holds URLs and cookie names only. | T7 adds the YouTube constants to `lib/oauth.ts` and does not touch the sign-in routes. |
| F12 | Store the "google subject of the granting account". | With scope `youtube` only (no `openid`), the token response carries no `id_token`. | T6 reads the subject from `POST https://oauth2.googleapis.com/tokeninfo` (token in the **body**). The builder verifies that it returns `sub` for a youtube-only token. If it does not, `google_sub` stays null and the shared-grant check in T18 is skipped (always revoke). That is a rare case (owner rule: skip rare). |
| F13 | Privacy policy page: "builder locates the page source". | `app/legal/privacy/page.tsx`: inline English JSX, 114 lines, no dictionary. | **Owner question Q2.** T19 follows the existing page (English) unless the owner rules otherwise. |
| F14 | Public match page shows the replay link. | `app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/page.tsx:416-421` renders the single `fixtures.stream_url`, through `streamLinkLabelKey(status)`. Its stream_url comes from `public_fixtures_v`, which redacts `setup` divisions (V401). | T1 adds the view `public_fixture_youtube_parts_v` with the same redaction. T16 renders the parts list. |

## Plan decisions where the spec leaves the builder a choice (§11) or is underdetermined

| # | Decision | Why |
|---|---|---|
| P1 | The V421 index is narrowed through a new column `fixture_stream_sessions.youtube_broadcast_id` (`… where state in (5 active) and youtube_broadcast_id is null`). A partial index cannot read `org_stream_targets`. | Every API session carries its broadcast, and pasted sessions never do. T11 guards "API target ⇒ broadcast id set" in code and tests it. |
|  | **[Amended after T1 review, 9456a5555a]:** the predicate is `and not api_backed` on a new `fixture_stream_sessions.api_backed boolean not null default false` (set at admission, never changed; check `broadcast_implies_api_backed`), because `youtube_broadcast_id … on delete set null` re-exposed active API sessions to the pasted uniqueness. | |
| P2 | Open-broadcast uniqueness. **Per fixture**: states `created, bound, reserved, live` (not `ending`). **Per key**: `created, bound, reserved, live, ending`. | §6.2 says admission treats `ending` as gone and creates a new broadcast, and the fixture index must let it. The ending row still holds its key until `transition(complete)` returns, so the new broadcast takes another key. |
| P3 | The key cap is enforced in the DB: `youtube_stream_keys.slot smallint check (slot between 1 and 10)` plus `unique (connection_id, slot) where retired_at is null`. The live-stream insert happens outside any lock. A lost slot race deletes the extra liveStream and retries the pick once. | §5.3 "never more than 10" with no lock held across a YouTube call (§6.2 step 4). |
| P4 | The broadcast row is written `created` **before** `liveBroadcasts.insert`, gets `yt_broadcast_id` right after insert, and becomes `bound` after `bind`. Orphans are `created`, or `bound` with no session ever attached, older than 10 min. | §6.2's orphan rule needs the row to exist before the call. A crash between insert and bind would otherwise litter an "upcoming" broadcast nobody records. `bound` with no session is the same orphan one step later. |
| P5 | "A session for the fixture is active" (§6.4) is read as "an active session **on this broadcast** (`youtube_broadcast_id = b.id`), or an unlapsed reservation". | It gives the same answer as the spec wording in every case but one: the organiser switching the fixture to a pasted key inside grace. Under the literal wording, that pasted stream would hold the YouTube broadcast open forever. Covered by Review Focus 3. The same narrowing applies to the end-time anchor: **S is the latest `ended_at` among sessions on this broadcast**, not among all the fixture's sessions (spec §6.4 says the fixture's), so a pasted session's Stop never moves an API broadcast's end. |
| P6 | Reservation lapse: `YOUTUBE_RESERVATION_MINUTES = 2` (§6.2 "~2 min"). End retry backoff: 1, 2, 4, … minutes, capped at 60 (`next_attempt_at`; after the n-th consecutive failure `min(2^(n-1), 60)` min, so the first retry is 1 min later). Google call timeout: 10 s. End-step budget slice: 15 s of the existing 45 s. | §11 leaves these to the builder. 15 + 30 = 45 keeps the pass under the Worker's 60 s. |
| P7 | An admission that finds this fixture's open broadcast **due but unclaimed** claims it for ending itself (marks it `ending`, commits) and takes the new-broadcast path. The tick finalizes it. | Without this, P2's fixture index blocks the new broadcast until the next tick. |
| P8 | A broadcast deleted because it never went live ends `failed`, with `last_error_code = 'never_live'`. An orphan ends `failed`, with code `orphan`. Only `complete` rows are replay parts. | §6.4 says "deleted instead". The spec's state list has no separate state for that. |
| P9 | `PATCH`/`DELETE /orgs/:id/stream-targets/:targetId` on an API row answer 422 `YOUTUBE_USE_DISCONNECT`. The Directory never offers Replace key or Remove on an API row. | §6.8: disconnect is the one way out. Replace key has no meaning for a pooled key. |
| P10 | OAuth intent is kept in a server row (`youtube_connect_pending`, keyed by `sha256(state)`, 10-min expiry). The row holds the consent tick, visibility, made-for-kids, the user and the org. After a multi-channel grant it also holds the sealed token and channel list for the picker. Cookies carry only `state` and the PKCE verifier. | The refresh token never touches a cookie, a URL or the client. The consent is recorded before Google is asked. |
| P11 | Title limit 100 characters, and `<` / `>` removed (YouTube's documented `snippet.title` rules). The builder re-reads developers.google.com/youtube/v3/live/docs/liveBroadcasts#snippet.title before T10 and records the finding in its report. The words use the existing `ui.json` keys `schedule.vs` / `schedule.tbd` in the org's `default_locale`. | §6.5, §11. |
| P12 | The YouTube driver is selected by `YOUTUBE_DRIVER=fake\|live`. Unset is `fake` outside production and `live` in production. The fake control route and the fake authorize route answer 404 unless the mode is `fake` **and** the env-name gate the fake-ingest control route uses passes (`app/api/internal/relay/fake-ingest/[inputId]/route.ts:17`). `e2e.yml` and the smoke job set `YOUTUBE_DRIVER: fake` explicitly. | The pattern of `relayDriverMode` (`relay/config.ts:419`). A prod process can never be served a fake grant. |

## Owner questions (recommendations built; the controller confirms before the owning batch merges)

- **Q1 (F3), owning task T15. RULED (b), owner 2026-10-27:** stg's fast trigger stays `*/5`; stg is not kept awake
  all day; email-outbox cadence unchanged. Stream-tick runs on every fast firing (prod 1 min, stg 5 min).
- **Q2 (F13), owning task T19. RULED OK, owner 2026-10-27:** English section in the existing page. The privacy page is English-only inline JSX today. *Recommendation: add the DP
  III.A.2 section in English, in that page,* the way the rest of the policy is written. The final legal wording is
  owner prerequisite 2 anyway. If the owner wants the policy localised, that is the whole page, not this section.
  The consent step's wording **is** in all four locales (T9).

## Global Constraints

- **Worktree:** `/Users/ashokhein/github/seazn.club/.claude/worktrees/youtube-connect`, branch `feat/youtube-connect`.
  Prefix every shell call with `cd <worktree> &&` or `cd <worktree>/apps/web &&`. Never touch the main checkout. Never
  `git stash`; use a WIP commit to set work aside.
- **Agents:** web implementers are `implementer-sonnet` (owner rule 2026-10-19, recorded in the controller's memory: web implementers = Sonnet; it postdates RULES.md's Opus-minimum line). Each task is reviewed by `reviewer` (Opus), and every batch
  closes with one `reviewer` pass over the whole batch diff. Never set `model:` on a dispatch. Every dispatch carries
  exact paths, acceptance criteria, what not to touch, the verify command and an output cap (`AGENTS.md`
  §Orchestration).
- **Owner decisions D1–D11 bind** (spec §0): the API path, with no pasted-key fallback (D6). Visibility is chosen at
  connect, Unlisted preselected (D2). Grace is **5 min** (D4). Ending is **2 min** after Stop or result when finished
  (D5). The consent box is ticked once per connection (D7). The stream tick runs on every fast firing: every minute on prod, every 5 min on stg (D9 as amended by Q1 = b). The web app
  only (D10). **No feature switch, no staff gate** (D11).
- **Google facts used as expected values** (spec §3.1, typed into tests from the spec, never imported from the code):
  10 concurrent streams per channel, 3 per stream key. Scope `https://www.googleapis.com/auth/youtube` only.
  `enableAutoStart=true`, `enableAutoStop=false`, `enableMonitorStream=false`. 7-day token life in Testing mode.
  DP III.E.4: 30-day refresh of stored YouTube data, and purge within 7 days of an in-app revoke (inline here).
- **Never touched:** `docs/contracts/relay-job.v1.json`, anything under `apps/relay*` or the compositor, the pasted-key
  create/replace path's behaviour, the Google **sign-in** routes (`app/api/auth/google/*`), credit rules
  (`stream-credits.ts`, `CREDIT_REUSE_HOURS`, `FREE_RESTARTS_PER_WINDOW`).
- **Locks:** no row or advisory lock is held across a YouTube or Google call, anywhere. `apply()` never reads or
  writes `youtube_broadcasts` (spec §6.3: org → session → broadcast would deadlock against the end step).
- **Secrets:** refresh tokens, access tokens, stream keys, ingestion URLs and Google response bodies never reach a log
  line, an error message, an `HttpError` extra, a URL (no `?access_token=`, no `?token=`; use the `Authorization`
  header or a POST body), argv, Sentry, PostHog or a telemetry row. Errors are stored as **codes** (`[a-z_:]{1,64}`).
  Refresh tokens are sealed with `YOUTUBE_TOKEN_KEK`. Pooled keys are sealed with RELAY_KEK in the `{url, streamKey}`
  JSON shape. `enc-boundary.test.ts` gets a fourth owner group.
- **Tenancy:** every connection, key and broadcast read is org-scoped (`org_id = $org`). New tables take the stream
  pattern: `enable` + `force row level security`, no policy, no grant to `app_user`, read with privileged `sql`
  (`relay/__tests__/rls-static.test.ts`).
- **Migration:** exactly one delta, `db/migration/deltas/V4NN__youtube_connect.sql`. `V4NN` is a placeholder. Before
  the PR is marked ready and again right before merge, run
  `git fetch origin && git ls-tree --name-only origin/main db/migration/deltas/ | sort -V | tail -1` and take max + 1
  (origin/main max is V477 today, so expect V478 or later). Then `git mv` and amend the T1 commit while
  unmerged. Load `supabase:supabase-postgres-best-practices` before writing it. Greenfield: no backfill.
- **Copy:** every user-facing string goes into `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`, then
  `cd apps/web && npm run i18n:gen-keys` (the keys file is generated; never hand-edit it). YouTube branding: the icon
  where the API has a presence, never the most prominent element. "YouTube" never appears in a Seazn product name.
- **UI:** load `frontend-design:frontend-design` in every UI task. Mobile-first. Screenshot at 1280, 768 and 320 with
  no horizontal page scroll, using the house theme (mocks are layout only). Each UI task writes its OWN CI-dispatched shots spec
  (`apps/web/e2e/youtube-*.shots.spec.ts`) and publishes the captures to an Artifact page, never into the repo (R8). UI build tasks (T9, T12, T16 UI half, T18 UI half) are **blocked on the owner's choice in T4**.
- **OpenAPI:** before every commit that touches `server/api-v1/**` or an `app/api/v1/**` route, run
  `npm run openapi:gen && git status --porcelain`. It must print nothing beyond the files that commit already stages.
  New v1 routes get a `key-scopes.ts` entry with the same scope family as `/orgs/:id/stream-targets`.
- **ENV:** `S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh`. Run `$S up --label youtube-connect`, then
  `eval "$($S env --label youtube-connect)"`. Run env down/up after any edit to the migration. Never a bare
  `db:apply`. Confirm `show data_directory` is this label's. Export `YOUTUBE_TOKEN_KEK` (64 hex) and
  `YOUTUBE_DRIVER=fake` in the test env, the same way the env sets `RELAY_KEK`.
- **VERIFY `<files>` → `tN`** (scoped only; never the full suite or the gate):
  ```
  cd /Users/ashokhein/github/seazn.club/.claude/worktrees/youtube-connect/apps/web && eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label youtube-connect)" && npx vitest run <files> --reporter=json --outputFile=$OUT/tN.json; echo EXIT=$?
  jq '{total: .numTotalTests, passed: .numPassedTests, failed: .numFailedTests, files: [.testResults[].name]}' $OUT/tN.json
  ```
  Green means all of: `EXIT=0`, `failed == 0`, `total` at least the step's count, and every file listed under this
  worktree's path. `rtk`'s `PASS(0) FAIL(0)` is not a result. A zsh-empty file list runs the FULL suite, so always
  name the files.
- **TSC:** `cd <worktree>/apps/web && rtk proxy npx tsc --noEmit -p tsconfig.json; echo EXIT=$?`.
  **LINT `<files>`:** `cd <worktree>/apps/web && rtk proxy npx eslint <files>; echo EXIT=$?`; read `✖ N problems`.
  **cron-worker:** `cd <worktree>/apps/cron-worker && npx vitest run test/<file> --reporter=json --outputFile=$OUT/tN.json; echo EXIT=$?`.
- **MUTATE** (TEST-STRATEGY rule 5). `cp file /…/scratchpad/<agent>/file.bak`, edit the one guard, run VERIFY: the
  named test must FAIL and `total` must be unchanged. `cp` the backup back, then run VERIFY green. Mutate one guard at
  a time. The report names the killing test per mutant. Never use `git checkout`, `git restore` or `git stash` on a
  file.
- **Four test types per task** (RULES.md §Testing): unit, E2E, smoke and regression. A backend task's E2E and smoke are
  owed in T20/T21 and **named** in the task's acceptance line. The task is not done until those named tests exist
  and pass in B7.
- **E2E only by CI dispatch:** push, then `gh workflow run e2e.yml --ref feat/youtube-connect -f pr=<n>`. The agent
  pushes and dispatches, then hands back, and the controller watches. No local Playwright, no local server.
- **Test rules** (TEST-STRATEGY): test the sequence (second call, empty input, after a void/withdraw). Every sweep
  returns how many items it checked, and zero checked FAILS. Expected values come from the spec or Google's docs as
  literals (`5`, `2`, `10`, `3`), never imported constants. Include at least one case where the right answer differs
  from the wrong constant's. Every negative assertion gets its positive pair. "Another sport" is not applicable to
  this feature (streaming is sport-agnostic), so the reviewer records that answer with the reason.
- **Kill only your own PIDs. No evidence PNGs in the repo. Scratchpad: a per-agent subdirectory, never `rm *`.**
- **Commit trailer:** every commit message ends with a blank line, then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  (or whatever attribution the executing session's system prompt gives).

## Review Focus

These are the five inputs the spec implies but no §9 test exercises, most likely first. Each has its test in the
owning task.

1. **Long or awkward match names.** A 43-character entrant name, `<`/`>` in a division name, or TBD v TBD. The title
   must stay ≤ 100 characters, the competition is trimmed first, and YouTube must not reject it. *T10 Step 1,
   `broadcastTitle` cases.*
2. **A replayed or double OAuth callback.** Back button, double tap, or a second tab completing the same `state`. The
   second callback must answer `expired` and create no second connection or token. *T7 Step 1.*
3. **The organiser switches the fixture to a pasted key inside grace** (P5). The API broadcast must still end at Stop
   + 5 min, even though a pasted session is now live on the fixture. *T13 Step 1 and T14 Step 1.*
4. **An org whose default locale is not English.** The title and description must use that locale's `schedule.vs` /
   `schedule.tbd` and description line, never English. *T10 Step 1.*
5. **A channel renamed or a live permission withdrawn on YouTube between match days.** The daily health check must
   refresh `channel_title` and the destination label, and surface `youtube_live_blocked`/`not_enabled` before match
   day. *T17 Step 1.*

---

## File structure

New, under `apps/web/src/`:

| File | Responsibility |
|---|---|
| `lib/youtube.ts` | Client-safe constants: `YOUTUBE_SCOPE`, `YOUTUBE_CONSENT_VERSION`, policy URLs, `youtubeWatchUrl(id)`, privacy enum, refusal code union. |
| `server/youtube/port.ts` | `YouTubePort` interface, `YouTubeError`, `YoutubeErrorCode`. |
| `server/youtube/google.ts` | The live driver: OAuth token calls, Data API calls, `mapGoogleError`. |
| `server/youtube/fake.ts` | `FakeYouTube`: the deterministic in-memory channel(s), limits, error injection, token death. |
| `server/youtube/driver.ts` | `youtubeDriverMode()`, `youtubeDriver()`, `setYoutubeDriverForTest()`. |
| `server/youtube/token-store.ts` | **The only file naming `refresh_token_enc`** (YOUTUBE_TOKEN_KEK group): seal, open and clear tokens on connections and pending rows. |
| `server/youtube/connections.ts` | The connect/pick/reconnect save, settings, consent re-tick, and the Directory projection. |
| `server/youtube/title.ts` | `broadcastTitle`, `broadcastDescription`. |
| `server/youtube/prepare.ts` | Go-live prepare: reserve/reuse, the key pool, insert/bind, abandon, attach. |
| `server/youtube/end-rule.ts` | The pure §6.4 rule plus the facts reader. |
| `server/youtube/end-step.ts` | `endDueBroadcasts`: claim → commit → call → finalize, and orphan cleanup. |
| `server/youtube/daily.ts` | Health check, 30-day refresh, 30-day purge of dead grants. |
| `server/youtube/disconnect.ts` | Disconnect, purge and revoke. |
| `app/api/youtube/connect/route.ts` | POST: start the OAuth (consent recorded first). |
| `app/api/youtube/connect/callback/route.ts` | GET: the OAuth callback. |
| `app/api/youtube/connect/fake-authorize/route.ts` | GET: the fake-mode authorize hop (404 unless fake). |
| `app/api/internal/youtube/fake/route.ts` | POST: the fake control route for e2e (404 unless fake). |
| `app/api/v1/orgs/[id]/youtube-connections/route.ts` | POST: pick a channel from a pending grant. |
| `app/api/v1/orgs/[id]/youtube-connections/pending/[pendingId]/route.ts` | GET: the picker's channel list. |
| `app/api/v1/orgs/[id]/youtube-connections/[connectionId]/route.ts` | PATCH: settings and consent. DELETE: disconnect. |

Modified: `server/relay/crypto.ts`, `server/relay/secret-columns.ts`, `server/relay/__tests__/enc-boundary.test.ts`,
`server/usecases/stream-target-holders.ts`, `server/usecases/stream-targets.ts`, `server/usecases/stream-sessions.ts`,
`server/api-v1/{schemas,openapi,key-scopes}.ts`, `app/api/cron/{stream-tick,relay-sweep}/route.ts`,
`apps/cron-worker/src/schedule.ts` (`wrangler.json` is NOT modified, Q1 = b), `components/v2/stream-destinations-panel.tsx`, the fixture stream
panel (located in T12), the public match page, `app/legal/privacy/page.tsx`, the four `ui.json`,
`.github/workflows/{e2e,ci}.yml` (env only), `scripts/smoke.ts`.

---

## T0 (controller, no dispatch): worktree, env, pins

- [ ] `cd /Users/ashokhein/github/seazn.club && git worktree add .claude/worktrees/youtube-connect -b feat/youtube-connect docs/youtube-connect-spec`
- [ ] `cd …/youtube-connect && pnpm install` (a fresh worktree has no `node_modules`), then `$S up --label youtube-connect`.
- [ ] Re-pin the migration max (Global Constraints) and record it in the B1 dispatch.
- [ ] Dispatch T4 (UI options) at once, in parallel with T1–T3. It writes no repo file, and the owner's choice gates B3's UI.

# B1 — Schema, secrets, pasted-only narrowing (T1–T4)

### Task 1: The migration

**Files:**
- Create: `db/migration/deltas/V4NN__youtube_connect.sql`
- Test: `apps/web/src/server/youtube/__tests__/migration.test.ts`
- Modify (only if they enumerate stream tables or deltas by name): `server/relay/__tests__/rls-static.test.ts`, `server/relay/__tests__/migration-shape.test.ts`

**Interfaces:**
- Produces (tables and columns that later tasks rely on):
  - `org_youtube_connections(id uuid pk, org_id uuid not null → organizations on delete cascade, channel_id text not null, channel_title text not null, google_sub text null, refresh_token_enc bytea null, granted_scope text not null, default_privacy text not null default 'unlisted' check in ('unlisted','public','private'), made_for_kids boolean not null default false, consent_by uuid not null → users, consent_at timestamptz not null, consent_version int not null, status text not null check in ('connected','reconnect_needed','revoked'), status_since timestamptz not null default now(), last_health_at timestamptz, last_error_code text, created_by uuid not null → users, created_at timestamptz not null default now(), revoked_at timestamptz)`, plus checks `org_youtube_connections_revoked_no_token ((status = 'revoked') = (refresh_token_enc is null))` and `org_youtube_connections_revoked_at ((status = 'revoked') = (revoked_at is not null))`, immediate, not deferrable (R1: every write of these columns is one `token-store.ts` statement, T2), and `unique (channel_id) where status <> 'revoked'` named `org_youtube_connections_one_live_channel`. Index `(org_id)`.
  - `youtube_connect_pending(id uuid pk, state_hash text unique not null, org_id, user_id, connection_id uuid null → org_youtube_connections (the reconnect target), default_privacy, made_for_kids, consent_version int, consent_at, refresh_token_enc bytea null, granted_scope text null, google_sub text null, channels jsonb null, expires_at timestamptz not null, created_at)`.
  - `youtube_stream_keys(id uuid pk, org_id, connection_id → org_youtube_connections on delete cascade, slot smallint not null constraint youtube_stream_keys_slot_range check (slot between 1 and 10), live_stream_id text not null, pool_rtmp_enc bytea not null, created_at, retired_at timestamptz)`, plus `youtube_stream_keys_one_live_slot`: unique `(connection_id, slot) where retired_at is null`, and `unique (connection_id, live_stream_id)`.
  - `youtube_broadcasts(id uuid pk, org_id, connection_id → org_youtube_connections, fixture_id → fixtures on delete cascade, key_id uuid null → youtube_stream_keys, yt_broadcast_id text null, title text not null, privacy text not null, state text not null check in ('created','bound','reserved','live','ending','complete','failed'), reserved_until timestamptz null, last_session_id uuid null → fixture_stream_sessions on delete set null, claimed_at, completed_at, refreshed_at timestamptz not null default now(), last_error_code text, attempts int not null default 0, next_attempt_at timestamptz null, created_at)`, plus `youtube_broadcasts_reserved_until check ((state = 'reserved') = (reserved_until is not null))`. Indexes:
    - `youtube_broadcasts_one_open_per_fixture`: unique `(fixture_id)` where state in `('created','bound','reserved','live')`.
    - `youtube_broadcasts_one_open_per_key`: unique `(key_id)` where state in `('created','bound','reserved','live','ending')`.
    - `youtube_broadcasts_open_due_idx`: on `(next_attempt_at nulls first, created_at)` where state in `('created','bound','reserved','live','ending')` (the V470 `email_outbox_due_idx` pattern).
    - `youtube_broadcasts_parts_idx`: on `(fixture_id, completed_at)` where `state = 'complete'`.
  - `org_stream_targets`: `alter column rtmp_enc drop not null`, add `youtube_connection_id uuid null → org_youtube_connections`, check `org_stream_targets_one_source ((rtmp_enc is null) <> (youtube_connection_id is null))`, check `(youtube_connection_id is null or kind = 'youtube')`.
  - `fixture_stream_sessions`: add `youtube_broadcast_id uuid null → youtube_broadcasts on delete set null`. Drop and recreate `fixture_stream_sessions_one_active_target` as `on (target_id) where state in ('requested','provisioning','warming','live','ending') and youtube_broadcast_id is null` (P1).
  - View `public_fixture_youtube_parts_v(fixture_id, video_id, part_no, completed_at)`: `complete` rows only, `part_no = row_number() over (partition by fixture_id order by completed_at, id)`, with the same `setup`-division redaction as `public_fixtures_v` (V401, read it). **No grant** (R7): only the server usecase `replayParts` (T16) reads it, on the privileged `sql` (the stream pattern); the view exists so the redaction lives in one place.
  - Every new table: `enable` + `force row level security`, no policy, no grant.

- [ ] **Step 1: Write the failing tests.** Each test inserts through raw `sql` on the fresh DB and asserts the
  constraint **name** (`constraint_name`), not just the SQLSTATE.

```ts
it("a destination row has exactly one source: both or neither is refused, each one alone is accepted", async () => {
  await expect(insertTarget({ rtmp: true, connection: true })).rejects.toMatchObject({ code: "23514", constraint_name: "org_stream_targets_one_source" });
  await expect(insertTarget({ rtmp: false, connection: false })).rejects.toMatchObject({ code: "23514", constraint_name: "org_stream_targets_one_source" });
  await expect(insertTarget({ rtmp: true, connection: false })).resolves.toBeTruthy();   // the positive pair
  await expect(insertTarget({ rtmp: false, connection: true })).resolves.toBeTruthy();
});
it("two ACTIVE sessions on one API target are allowed (one per broadcast); on a pasted target the second is still 23505", async () => {
  // fixtures A, B; API target T_api with broadcasts bA, bB; pasted target T_key
  await activeSession({ fixture: A, target: T_api, broadcast: bA });
  await expect(activeSession({ fixture: B, target: T_api, broadcast: bB })).resolves.toBeTruthy();
  await activeSession({ fixture: A2, target: T_key, broadcast: null });
  await expect(activeSession({ fixture: B2, target: T_key, broadcast: null }))
    .rejects.toMatchObject({ code: "23505", constraint_name: "fixture_stream_sessions_one_active_target" });
});
it("one open broadcast per fixture — but an ENDING one does not block a new one", async () => {
  const b1 = await broadcast({ fixture: F, key: k1, state: "live" });
  await expect(broadcast({ fixture: F, key: k2, state: "created" })).rejects.toMatchObject({ constraint_name: "youtube_broadcasts_one_open_per_fixture" });
  await setState(b1, "ending");
  await expect(broadcast({ fixture: F, key: k2, state: "created" })).resolves.toBeTruthy();
});
it("one open broadcast per key, ending INCLUDED; complete frees the key", async () => {
  const b1 = await broadcast({ fixture: F1, key: k1, state: "ending" });
  await expect(broadcast({ fixture: F2, key: k1, state: "created" })).rejects.toMatchObject({ constraint_name: "youtube_broadcasts_one_open_per_key" });
  await setState(b1, "complete");
  await expect(broadcast({ fixture: F2, key: k1, state: "created" })).resolves.toBeTruthy();
});
it("a connection holds at most 10 live keys — slot 11 is refused, and a retired slot is reusable", async () => {
  for (let s = 1; s <= 10; s++) await key({ connection: C, slot: s });   // 10: YouTube's per-channel cap (spec §3.1)
  await expect(key({ connection: C, slot: 11 })).rejects.toMatchObject({ code: "23514", constraint_name: "youtube_stream_keys_slot_range" });
  await expect(key({ connection: C, slot: 3 })).rejects.toMatchObject({ code: "23505", constraint_name: "youtube_stream_keys_one_live_slot" });
  await retire(C, 3);
  await expect(key({ connection: C, slot: 3 })).resolves.toBeTruthy();
});
it("a channel is live in at most one org; revoking frees it for another org", async () => {
  const c = await connection({ org: O1, channel: "UC1", status: "connected" });
  await expect(connection({ org: O2, channel: "UC1", status: "connected" })).rejects.toMatchObject({ constraint_name: "org_youtube_connections_one_live_channel" });
  await revoke(c);
  await expect(connection({ org: O2, channel: "UC1", status: "connected" })).resolves.toBeTruthy();
});
it("revoked ⇔ no token and revoked ⇔ revoked_at: all 4 directions refused BY NAME; both consistent shapes accepted", async () => {
  // connected + null token, revoked + token → org_youtube_connections_revoked_no_token
  // connected + revoked_at, revoked + null revoked_at → org_youtube_connections_revoked_at
  // positive pair: connected + token + null revoked_at; revoked + null token + revoked_at → both insert
});
it("reserved ⇔ reserved_until: both directions refused as youtube_broadcasts_reserved_until; reserved + reserved_until accepted", …);
it("the parts view lists complete rows only, numbered by completion, and nothing for a setup division", async () => {
  // complete at 10:00 and 11:00, plus one failed and one live → exactly [{part_no:1},{part_no:2}]; flip the division to setup → []
});
it("every new table is RLS enabled AND forced, with no policy", async () => {
  // pg_class.relrowsecurity && relforcerowsecurity for the 4 tables; pg_policies count 0. checked === 4
});
```

- [ ] **Step 2: Run VERIFY `src/server/youtube/__tests__/migration.test.ts` → `t1`.** Expected: FAIL (tables absent).
- [ ] **Step 3: Write the delta** to the shapes in Interfaces, then run `$S down && $S up --label youtube-connect`.
- [ ] **Step 4: Run VERIFY → `t1`.** Expected: green, `total ≥ 10`. Also run VERIFY over
  `src/server/relay/__tests__/rls-static.test.ts src/server/relay/__tests__/migration-shape.test.ts`. If either names
  the V421 index's predicate or enumerates stream deltas, update that test to the new predicate. Never delete an
  assertion to do it.
- [ ] **Step 5: MUTATE** the three guards one at a time: remove `and youtube_broadcast_id is null` (the pasted-23505
  case must stay green while the API case fails), remove `'ending'` from the per-key index, and drop `org_stream_targets_one_source`.
  Name the killer for each.
- [ ] **Step 6: Commit** `feat(youtube): schema for connections, key pool, broadcasts`.

**Four types:** unit (this file); regression (rls-static, migration-shape); E2E `youtube-connect.spec.ts › connect →
Go live` (T20); smoke `youtube: stream-tick answers` (T21).

### Task 2: Secrets: the KEK, the token store, the pooled-key columns

**Files:**
- Modify: `apps/web/src/server/relay/crypto.ts` (`KekName`, `fingerprintYoutubeChannel`)
- Modify: `apps/web/src/server/relay/secret-columns.ts` (pooled-key SQL, and `readTargetSecret`'s API-row refusal)
- Create: `apps/web/src/server/youtube/token-store.ts`
- Modify: `apps/web/src/server/relay/__tests__/enc-boundary.test.ts`
- Test: `apps/web/src/server/youtube/__tests__/token-store.test.ts`, `apps/web/src/server/relay/__tests__/secret-columns.test.ts` (add cases), `apps/web/src/server/relay/__tests__/crypto.test.ts` (add cases)

**Interfaces:**
- Produces:
  - `type KekName = … | "YOUTUBE_TOKEN_KEK"`.
  - `fingerprintYoutubeChannel(channelId: string): string`: 64 lower-hex. HKDF info `"seazn/stream-destination-fingerprint/youtube-channel/v1"`. Never equal to any `fingerprintDestination` output for the same string.
  - `secret-columns.ts`: `insertPooledKey(tx: Tx, a: { orgId: string; connectionId: string; slot: number; liveStreamId: string; ingest: { url: string; streamKey: string } }): Promise<{ keyId: string }>` and `readPooledKey(tx: Tx, orgId: string, keyId: string): Promise<{ url: string; streamKey: string }>`. The latter throws `TargetSecretUnreadableError` with kind `youtube` on a bad envelope, and rethrows a KEK fault (`rethrowKekFault`).
  - `readTargetSecret` on a row whose `rtmp_enc is null` throws `ApiBackedTargetError` (new, exported; carries `targetId` only). Its message never contains a key.
  - `token-store.ts` owns **every** statement that names `refresh_token_enc` (R1), so T1's revoked checks hold within one statement each:
    - `insertConnectionWithToken(tx, a: { orgId: string; channelId: string; channelTitle: string; googleSub: string | null; grantedScope: string; defaultPrivacy: YoutubePrivacy; madeForKids: boolean; consentBy: string; consentAt: Date; consentVersion: number; createdBy: string; refreshToken: string }): Promise<{ connectionId: string }>` (status `connected`);
    - `replaceConnectionToken(tx, orgId: string, connectionId: string, refreshToken: string): Promise<boolean>` (token, `status = 'connected'`, `status_since = now()`, `last_error_code = null`; false when there is no non-revoked row of this org);
    - `revokeConnection(tx, orgId: string, connectionId: string): Promise<boolean>`: ONE statement, `refresh_token_enc = null, status = 'revoked', revoked_at = now()` (false when already revoked or not this org's);
    - `sealPendingToken(tx, pendingId: string, refreshToken: string): Promise<void>` and `takePendingToken(tx, orgId: string, pendingId: string): Promise<string | null>`;
    - `openToken(exec, orgId: string, connectionId: string): Promise<string | null>`: null for a missing row, another org's row, or a revoked one (one pinned behaviour).
    T8, T17 and T18 call these; no other file writes `status = 'revoked'` or the token.
- Consumes: T1 columns `refresh_token_enc` (both tables) and `pool_rtmp_enc`.

- [ ] **Step 1: Write the failing tests.**

```ts
// enc-boundary.test.ts — the union gains the fourth group; owner files are named
const YOUTUBE_COLUMNS = ["refresh_token_enc"];
const YOUTUBE_OWNER = "server/youtube/token-store.ts";
// STREAM_COLUMNS gains "pool_rtmp_enc" (RELAY_KEK, server/relay/** only)
expect(ENC_COLUMNS).toEqual([...STREAM_COLUMNS, ...DEVICE_LINK_COLUMNS, ...LICHESS_COLUMNS, ...YOUTUBE_COLUMNS].sort());
it("only token-store.ts names refresh_token_enc — and it does", …);   // negative + positive pair, offenders === []

// token-store.test.ts
it("a sealed token opens under YOUTUBE_TOKEN_KEK and NOT under RELAY_KEK", …);   // openWith("RELAY_KEK", bytes) throws
it("openToken returns null for another org's id, exactly as for a missing id and for a revoked row (3 cases, one behaviour)", …);
it("an unset YOUTUBE_TOKEN_KEK throws the KEK's own sentence, which contains no token", …);
it("revokeConnection nulls the token and sets revoked + revoked_at in ONE statement (T1's checks never fire); a second call returns false", …);
it("insertConnectionWithToken writes a connected row whose token opens; replaceConnectionToken on a revoked row returns false and writes nothing", …);

// secret-columns.test.ts
it("readPooledKey round-trips {url, streamKey}; another org's keyId is 'not found'", …);
it("readTargetSecret on an API-backed row throws ApiBackedTargetError, never a decrypt error, and names no key", …);
// crypto.test.ts
it("fingerprintYoutubeChannel is stable, 64 hex, and differs from fingerprintDestination over the same text", …);
```

- [ ] **Step 2: Run VERIFY** over the four test files → `t2`. Expected: FAIL.
- [ ] **Step 3: Implement** to the Interfaces. `token-store.ts` seals with `sealWith("YOUTUBE_TOKEN_KEK", …)`.
  `insertPooledKey` seals with `seal()` (RELAY_KEK).
- [ ] **Step 4: Run VERIFY → `t2`.** Expected: green. **MUTATE** the org filter in `openToken`, and separately the
  KEK name used by `insertConnectionWithToken`. Name the killers.
- [ ] **Step 5: Commit** `feat(youtube): YOUTUBE_TOKEN_KEK, token store, pooled-key envelope`.

**Four types:** unit (above); regression (enc-boundary, crypto); E2E (T20 `› connect: consent → picker → row`); smoke
`youtube: reconnect-needed refusal` (T21, reads a sealed connection).

### Task 3: The target is the unit of exclusivity for pasted rows only

**Files:**
- Modify: `apps/web/src/server/usecases/stream-target-holders.ts` (`holderRows`)
- Modify: `apps/web/src/server/usecases/stream-sessions.ts` (`tearDownPriorMachines` `:1292`, `releasePriorOutputs` `:1340`)
- Modify: `apps/web/src/server/relay/secret-columns.ts` (`readKeyHints` `:282`)
- Modify: `apps/web/src/server/usecases/stream-targets.ts` (`patchStreamTarget`, `removeStreamTarget`, and the `listStreamTargets` hint read)
- Test: `apps/web/src/server/usecases/__tests__/stream-target-holders.test.ts`, `stream-targets.test.ts`, `stream-sessions.test.ts` (add cases)

**Interfaces:**
- Produces: `holderRows` never returns a session whose target has `youtube_connection_id is not null`. The cross-fixture
  arm (`or target_id = $t`) of both prior-teardown queries applies to pasted targets only. `patchStreamTarget` and
  `removeStreamTarget` on an API row throw `HttpError(422, …, "YOUTUBE_USE_DISCONNECT")`.

- [ ] **Step 1: Write the failing tests** (seed API rows with raw SQL through T1's tables; no YouTube call is needed).

```ts
it("holderRows: an active session on an API target is no holder; on a pasted target it is (positive pair)", …);
it("Directory list: an API row with two live sessions reads inUse === null and no keyHint; the list does not throw on its null rtmp_enc", …);
it("tearDownPriorMachines: another fixture's ended composed session with a listed Machine on the SAME API target is not torn down and refuses nothing", async () => {
  // FakeRunner lists a machine for the other fixture's terminal session; start on fixture B, target T_api → runner.destroy calls === 0
});
it("…but on a PASTED target the same leftover is destroyed (the existing I1 behaviour stands)", …);
it("releasePriorOutputs: the same pair, for an unreleased output", …);
it("PATCH and DELETE on an API row → 422 YOUTUBE_USE_DISCONNECT; the row is unchanged (archived_at null)", …);
```

- [ ] **Step 2: Run VERIFY** over the three test files → `t3`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement.** In `holderRows`, add `and t.youtube_connection_id is null`. In both prior queries,
  replace `(fixture_id = $f or target_id = $t)` with `(fixture_id = $f or (target_id = $t and not exists(select 1 from org_stream_targets x where x.id = $t and x.youtube_connection_id is not null)))`
  or an equivalent join. In `readKeyHints`, add `and rtmp_enc is not null`. The PATCH/DELETE refusal goes after the
  existing 404 checks and before any lock-dependent check.
- [ ] **Step 4: Run VERIFY → `t3`** plus the **whole existing** `stream-target-holders.test.ts`, `stream-targets.test.ts`
  and `stream-sessions.test.ts` files (regression for the pasted path). **MUTATE** the `holderRows` predicate and the
  teardown predicate, one at a time.
- [ ] **Step 5: Commit** `feat(youtube): pasted-key rows alone hold a destination`.

**Four types:** unit + regression (above); E2E `directory-stream-destinations.spec.ts` stays green (the pasted path is
unchanged) and `youtube-connect.spec.ts › two matches on one channel` (T20); smoke `youtube: list shape` (T21).

### Task 4: UI options for the owner (no repo change; gates T9, T12, T16, T18's UI)

**Files:** none in the repo. Mocks go to the scratchpad and are published as **one Artifact page**.

- [ ] **Step 1:** Load `frontend-design:frontend-design` and `artifact-design`. Read `components/v2/stream-destinations-panel.tsx`,
  `app/directory/page.tsx:270-287`, the fixture stream panel (locate it with `grep -arl "stream-destinations\|targetId" components/v2`),
  and the public match page's `public-stream-link` block. Mocks are layout only; the build uses the house theme.
- [ ] **Step 2:** Produce **at least two** options, each at 320, 768 and 1280, for:
  (a) Directory → Streaming: the Connect YouTube action beside Add destination, the consent step (visibility with
  Unlisted preselected, made-for-kids with No preselected, the D7 checkbox with the spec §6.1 draft wording, the button
  disabled until ticked, the three links), the channel picker, and the destination row (icon · channel · visibility ·
  status badge Connected / Reconnect needed / Not enabled for live / Review updated terms, plus the actions Reconnect,
  Settings, Disconnect);
  (b) the fixture stream panel: an API row in the picker, one refusal with its action (e.g. `youtube_reconnect_needed`
  → "Reconnect YouTube"), and the after-match replay link;
  (c) the public match page with one part ("Watch on YouTube") and with two ("Part 1", "Part 2").
- [ ] **Step 3:** Publish and hand the link to the controller **with a recommendation as product owner** (which option
  and why, stated in what the club gets). The controller puts it to the owner. Record the choice in this plan under
  T9 before T9 is dispatched.

**B1 gate:** a `reviewer` pass over the B1 diff. Open the draft PR (`gh pr create --draft`), push, and dispatch e2e on
the branch to prove the pasted path is unbroken (`directory-stream-destinations`, `stream-relay` walkthroughs).

# B2 — The YouTube port (T5–T6)

### Task 5: Port, fake, driver selection, fake control route

**Files:**
- Create: `apps/web/src/lib/youtube.ts`, `apps/web/src/server/youtube/{port,fake,driver}.ts`, `apps/web/src/app/api/internal/youtube/fake/route.ts`
- Test: `apps/web/src/server/youtube/__tests__/fake.test.ts`, `driver.test.ts`, `apps/web/src/app/api/internal/youtube/fake/__tests__/route.test.ts`

**Interfaces:**
- Produces:
```ts
// lib/youtube.ts (client-safe)
export const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube";
export const YOUTUBE_CONSENT_VERSION = 1;
export type YoutubePrivacy = "unlisted" | "public" | "private";
export type YoutubeRefusalCode = "youtube_reconnect_needed" | "youtube_live_not_enabled" | "youtube_live_blocked"
  | "youtube_limit_reached" | "youtube_channel_busy" | "youtube_unavailable";
export const youtubeWatchUrl = (videoId: string) => `https://www.youtube.com/watch?v=${videoId}`;
// + YOUTUBE_TOS_URL, YOUTUBE_GUIDELINES_URL, GOOGLE_PRIVACY_URL ("http://www.google.com/policies/privacy"),
//   GOOGLE_PERMISSIONS_URL ("https://security.google.com/settings/security/permissions")

// server/youtube/port.ts
export type YoutubeErrorCode = Exclude<YoutubeRefusalCode, "youtube_channel_busy"> | "youtube_not_found";
export class YouTubeError extends Error { constructor(readonly code: YoutubeErrorCode, readonly reason: string /* Google's reason token, [A-Za-z]{0,64}; never a body */) }
export type BroadcastLife = "created" | "ready" | "testing" | "live" | "complete" | "revoked" | "absent";
export interface YouTubePort {
  readonly mode: "fake" | "live";
  authorizeUrl(a: { state: string; codeChallenge: string; redirectUri: string }): string;
  exchangeCode(a: { code: string; codeVerifier: string; redirectUri: string }): Promise<{ refreshToken: string; scope: string; googleSub: string | null }>;
  accessToken(refreshToken: string): Promise<string>;                       // invalid_grant → YouTubeError youtube_reconnect_needed
  listMyChannels(at: string): Promise<{ id: string; title: string }[]>;
  liveEnabled(at: string): Promise<"enabled" | "not_enabled" | "blocked">;
  insertStream(at: string, a: { title: string }): Promise<{ streamId: string; ingest: { url: string; streamKey: string } }>;
  deleteStream(at: string, streamId: string): Promise<void>;                 // absent → resolves
  insertBroadcast(at: string, a: { title: string; description: string; scheduledStart: Date; privacy: YoutubePrivacy; madeForKids: boolean }): Promise<{ broadcastId: string }>;
  bind(at: string, broadcastId: string, streamId: string): Promise<void>;
  broadcastLife(at: string, broadcastId: string): Promise<BroadcastLife>;
  complete(at: string, broadcastId: string): Promise<void>;                  // already complete → resolves
  deleteBroadcast(at: string, broadcastId: string): Promise<void>;           // absent → resolves
  existingVideos(at: string, ids: readonly string[]): Promise<Set<string>>;  // ≤ 50 ids per call, else throws
  revoke(refreshToken: string): Promise<void>;
}
// server/youtube/driver.ts
export function youtubeDriverMode(): "fake" | "live";   // YOUTUBE_DRIVER; unset ⇒ fake outside production, live in production
export function youtubeDriver(): YouTubePort;           // one per process; fake is a globalThis singleton
export function setYoutubeDriverForTest(p: YouTubePort | null): void;
// server/youtube/fake.ts
export class FakeYouTube implements YouTubePort {
  constructor(o?: { channels?: { id: string; title: string }[]; now?: () => Date });
  failNext(method: keyof YouTubePort, code: YoutubeErrorCode, reason?: string): void;
  killToken(refreshToken: string): void;          // the next accessToken → youtube_reconnect_needed
  tokenHandle(refreshToken: string): string; killHandle(handle: string): void; setAutoVideo(on: boolean): void;   // R6: e2e handles
  setChannels(c: { id: string; title: string }[]): void;
  setLive(state: "enabled" | "not_enabled" | "blocked"): void;
  videoOn(streamId: string): void; videoOff(streamId: string): void;   // auto-start: a bound 'ready' broadcast → 'live'
  deleteVideo(videoId: string): void;
  readonly calls: { method: string; at: Date }[];   // never records tokens or keys
  liveBroadcastCount(): number; streamsCount(): number; boundOpenCount(streamId: string): number;
}
```
- The fake control route (R6): `POST /api/internal/youtube/fake` with body `{ op: "setChannels" | "failNext" | "killToken" | "videoOn" | "videoOff" | "deleteVideo" | "setLive" | "autoVideo" | "state", … }`. It answers 404 unless `youtubeDriverMode() === "fake"` **and** the fake-ingest route's env-name gate passes (P12). e2e never sees a token or a key, so ops take **handles**: `state` with `{ fixtureId }` answers `{ connectionId, tokenHandle, broadcasts: [{ videoId, life, streamId }] }` (the fake assigns an opaque `tokenHandle` per refresh token; the route resolves the fixture's connection and broadcasts server-side); `killToken` takes `{ tokenHandle }`; `videoOn`/`videoOff` take `{ streamId }`; `autoVideo { on }` makes every `bind` flip its broadcast to `live` at once, as if video arrived. The fake has no ingest to observe, so e2e turns `autoVideo` on and its broadcasts can complete as replay parts.

- [ ] **Step 1: Write the failing tests.** These are the fake's realism, from Google's documented limits.

```ts
it("auto-start: a bound broadcast goes live when video arrives, and auto-stop is OFF — it stays live after videoOff", …);
it("an 11th concurrently live broadcast on one channel is refused; the 10th is not", async () => {   // 10: support.google.com/youtube/answer/2474026
  // 10 keys, 10 bound broadcasts, videoOn each → liveBroadcastCount() === 10; the 11th videoOn → YouTubeError youtube_limit_reached
});
it("a 4th open broadcast bound to one key is refused; the 3rd is not", …);   // 3 per stream key, same source
it("a killed token: accessToken → youtube_reconnect_needed; the bound key still carries video (videoOn on a live broadcast keeps it live)", …);
it("failNext injects exactly once, for every refusal code", async () => {
  const codes = ["youtube_reconnect_needed","youtube_live_not_enabled","youtube_live_blocked","youtube_limit_reached","youtube_unavailable"] as const;
  let checked = 0; for (const c of codes) { /* inject, the call throws c, the next call succeeds */ checked++; }
  expect(checked).toBe(5);
});
it("calls[] records method names only — no token or key substring appears in JSON.stringify(fake.calls)", …);
it("driver: production with YOUTUBE_DRIVER unset is live, never fake; test env unset is fake; 'fake' in production is fake (e2e)", …);
it("control route: 404 when mode is live; 404 when the env-name gate refuses; 200 in fake + allowed env", …);
it("control route (R6): 'state' answers handles only — its JSON holds no refresh token, stream key or ingest url; killToken by handle kills that token; autoVideo on → a bind leaves the broadcast 'live'", …);
```

- [ ] **Step 2: Run VERIFY** over the three files → `t5`. Expected: FAIL.
- [ ] **Step 3: Implement** to the Interfaces. The fake's limits are its own literals (10, 3), copied from Google's page
  with the URL in a comment.
- [ ] **Step 4: Run VERIFY → `t5`** green. **MUTATE** the route gate (`return true`) and the production-default branch
  of `youtubeDriverMode`. Name the killers.
- [ ] **Step 5: Commit** `feat(youtube): port, deterministic fake, driver selection`.

**Four types:** unit (above); regression (the driver default); E2E (T20 drives the fake through this route); smoke
`youtube: fake control route answers in fake mode` (T21).

### Task 6: The Google driver

**Files:**
- Create: `apps/web/src/server/youtube/google.ts`
- Test: `apps/web/src/server/youtube/__tests__/google.test.ts` (with `fetch` mocked; no network)

**Interfaces:**
- Consumes: `YouTubePort`, `YouTubeError` (T5); `GOOGLE_AUTH_URL`, `GOOGLE_TOKEN_URL`, `googleConfigured()` (`lib/oauth.ts`).
- Produces: `class GoogleYouTube implements YouTubePort`, and `mapGoogleError(a: { status: number; reason?: string; oauthError?: string }): YoutubeErrorCode`.

- [ ] **Step 0:** Re-read, and record the URLs in the task report: liveBroadcasts (insert/bind/transition/delete/list),
  liveStreams (insert/delete), videos.list, channels.list, oauth2 web-server (offline, revoke), tokeninfo. Confirm three
  things: (1) the title limit (P11); (2) whether `tokeninfo` returns `sub` for a youtube-only token (F12); (3) whether
  revoking one refresh token revokes the user's whole grant to the client (spec §6.8). Record each answer in the
  report. Tasks T7 and T18 read them.
- [ ] **Step 1: Write the failing tests** (asserting request shapes from Google's docs and the spec, not from `google.ts`).

```ts
it("authorizeUrl: response_type=code, access_type=offline, prompt=consent, scope is EXACTLY the youtube scope, code_challenge_method=S256", …);
it("insertBroadcast body: contentDetails.enableAutoStart true, enableAutoStop false, monitorStream.enableMonitorStream false; status.privacyStatus as given; status.selfDeclaredMadeForKids as given; part=snippet,status,contentDetails", …);
it("insertStream: cdn.ingestionType 'rtmp', contentDetails.isReusable true; returns ingestionAddress + streamName as {url, streamKey}", …);
it("complete: liveBroadcasts/transition?broadcastStatus=complete&id=…&part=status; a 'redundantTransition' answer resolves", …);
it("every call sends the token in the Authorization header; no request URL contains the access or refresh token", async () => {
  // every method that makes a request (13: all but authorizeUrl; exchangeCode makes 2 — token + tokeninfo) → 14 captured requests;
  // each: expect(url).not.toContain(TOKEN); Data API calls also carry `Authorization: Bearer <at>`. checked === 14
});
it("revoke and tokeninfo send the token in a form POST body, never the query string", …);
it("mapGoogleError table", () => {
  const rows: [Parameters<typeof mapGoogleError>[0], string][] = [
    [{ status: 400, oauthError: "invalid_grant" }, "youtube_reconnect_needed"],
    [{ status: 401, reason: "authError" }, "youtube_reconnect_needed"],
    [{ status: 403, reason: "insufficientPermissions" }, "youtube_reconnect_needed"],
    [{ status: 403, reason: "liveStreamingNotEnabled" }, "youtube_live_not_enabled"],
    [{ status: 403, reason: "livePermissionBlocked" }, "youtube_live_blocked"],
    [{ status: 403, reason: "limitExceeded" }, "youtube_limit_reached"],
    [{ status: 403, reason: "userBroadcastsExceedLimit" }, "youtube_limit_reached"],
    [{ status: 403, reason: "rateLimitExceeded" }, "youtube_limit_reached"],
    [{ status: 403, reason: "userRequestsExceedRateLimit" }, "youtube_limit_reached"],
    [{ status: 403, reason: "quotaExceeded" }, "youtube_limit_reached"],
    [{ status: 404, reason: "liveBroadcastNotFound" }, "youtube_not_found"],
    [{ status: 500 }, "youtube_unavailable"], [{ status: 503 }, "youtube_unavailable"],
    [{ status: 418, reason: "somethingNew" }, "youtube_unavailable"],
  ];
  let checked = 0; for (const [i, want] of rows) { expect(mapGoogleError(i), JSON.stringify(i)).toBe(want); checked++; }
  expect(checked).toBe(rows.length);
});
it("a timeout (10 s, AbortSignal) is youtube_unavailable; a network error too", …);
it("a thrown YouTubeError's message and reason never contain the response body (the body carries a marker string; assert absent)", …);
it("existingVideos refuses > 50 ids without calling", …);
```

- [ ] **Step 2: Run VERIFY → `t6`** red. **Step 3: Implement.** Plain `fetch`, no new dependency.
  `exchangeCode` calls `tokeninfo` for `sub` per the Step 0 answer.
- [ ] **Step 4: Run VERIFY → `t6`** green. **MUTATE** `enableAutoStop: false → true`, and the `invalid_grant` row.
- [ ] **Step 5: Commit** `feat(youtube): Google driver with error-code mapping`.

**Four types:** unit + regression (the mapping table); E2E: none can reach Google, so the stg acceptance runbook (T22)
is this driver's end-to-end. Smoke: none can reach Google on CI (the smoke job runs the fake driver); the named probe is
the runbook's `stg: connect a real channel` step (T22). Recorded exception to R12's every-task-names-a-smoke rule.

**B2 gate:** `reviewer` over B2. Push.

# B3 — Connect flow (T7–T9)

### Task 7: The OAuth route pair

**Files:**
- Modify: `apps/web/src/lib/oauth.ts` (YouTube cookie names and redirect URI)
- Create: `apps/web/src/app/api/youtube/connect/route.ts`, `…/connect/callback/route.ts`, `…/connect/fake-authorize/route.ts`
- Test: `apps/web/src/app/api/youtube/connect/__tests__/connect-routes.test.ts` (the pattern of `lichess-oauth-routes.test.ts`)

**Interfaces:**
- Consumes: `youtubeDriver()` (T5), `token-store` (T2), `saveConnectionFromGrant` (T8; a stub that throws is fine until T8 lands, and both commit in B3), `pkceVerifier`/`pkceChallenge` (`server/external-play/pkce.ts`), `EDITOR_ROLES` (`lib/types.ts:24`).
- Produces:
  - `lib/oauth.ts`: `YOUTUBE_OAUTH_STATE_COOKIE = "seazn_youtube_oauth_state"`, `YOUTUBE_OAUTH_VERIFIER_COOKIE = "seazn_youtube_oauth_verifier"`, `youtubeRedirectUri(req) = process.env.YOUTUBE_REDIRECT_URI || \`${baseUrl(req)}/api/youtube/connect/callback\``.
  - `POST /api/youtube/connect`, form fields `orgId`, `privacy`, `madeForKids`, `consent` (must be `"1"`), and optional `connectionId` (reconnect). It requires a signed-in editor of `orgId`. It refuses a present `Origin` that is not `baseUrl(req)`. It writes a `youtube_connect_pending` row (consent recorded: user, now, `YOUTUBE_CONSENT_VERSION`), sets the two cookies (httpOnly, lax, 600 s), and answers 303 to `port.authorizeUrl(…)`.
  - `GET /api/youtube/connect/callback`. Every exit is `303 /directory?tab=streaming&youtube=<code>`, with code in `connected | pick | no_channel | scope_missing | other_org | different_channel | denied | expired | not_configured | forbidden`. `pick` also carries `&pending=<id>`.

- [ ] **Step 1: Write the failing tests.**

```ts
it("start: no consent → 400 and no pending row, no cookie; consent=1 → pending row with consent_version 1, consent_by = user, and a 303 to an authorize URL carrying the state", …);
it("start: a non-editor (scorer) of the org → 403; an editor of ANOTHER org → 404", …);
it("callback: state cookie ≠ query state → expired, nothing stored", …);
it("callback REPLAYED: the same state a second time → expired; still exactly one connection row", …);   // Review Focus 2
it("callback: the user lost the editor role between start and callback → landing 'forbidden', the grant revoked, nothing stored", …);
it("callback: granted scope lacks the youtube scope → scope_missing; port.revoke called once; no connection row", …);   // §9.3 mutation target
it("callback: zero channels → no_channel; revoked; one channel → connected (connection + destination row); two → pick, token sealed on the pending row, NOT on any connection", …);
it("callback: Google 'access_denied' → denied, no call to exchangeCode", …);
it("reconnect: connectionId given and the grant's channel differs → different_channel, the old token untouched", …);
it("no URL produced by any exit contains the code, the token or the verifier", …);
it("fake-authorize: 404 in live mode; in fake mode 303 back to the callback with the same state", …);
```

- [ ] **Step 2: Run VERIFY → `t7`** red. **Step 3: Implement.** Read `node_modules/next/dist/docs/` on route handlers
  and `cookies()` first. The callback re-checks the role with a fresh read, never from the pending row.
- [ ] **Step 4: Run VERIFY → `t7`** green. **MUTATE** the scope check (spec §9.3: `return true`) and the state-equality
  check, one at a time.
- [ ] **Step 5: Commit** `feat(youtube): connect OAuth route pair (PKCE, state, consent first)`.

**Four types:** unit + regression (above); E2E `youtube-connect.spec.ts › connect: consent → picker → row` (T20);
smoke `youtube: connect without consent is refused` (T21).

### Task 8: Connections usecase, Directory projection, v1 routes

**Files:**
- Create: `apps/web/src/server/youtube/connections.ts`
- Create: `apps/web/src/app/api/v1/orgs/[id]/youtube-connections/route.ts`, `…/pending/[pendingId]/route.ts`, `…/[connectionId]/route.ts` (PATCH only here; DELETE lands in T18)
- Modify: `apps/web/src/server/api-v1/{schemas,openapi,key-scopes}.ts`, `apps/web/src/server/usecases/stream-targets.ts` (`listStreamTargets` adds the `youtube` block)
- Test: `apps/web/src/server/youtube/__tests__/connections.test.ts`, the route tests beside each route

**Interfaces:**
- Produces:
```ts
export async function saveConnectionFromGrant(a: { pendingId: string; channelId: string; userId: string }, port: YouTubePort): Promise<{ connectionId: string; targetId: string }>;
// one transaction: insertConnectionWithToken (token-store.ts, R1) + insert org_stream_targets (kind youtube, label = channel title,
// youtube_connection_id, dest_fingerprint = fingerprintYoutubeChannel(channelId), rtmp_enc null); delete the pending row.
// 23505 org_youtube_connections_one_live_channel → HttpError(409, "This channel is connected to another organisation on Seazn", "YOUTUBE_OTHER_ORG"), then — outside the rolled-back tx — port.revoke(the new token)
// (same org, same channel, live → returns the existing ids, token replaced). Reconnect (pending.connection_id set): replaceConnectionToken (token-store.ts, R1:
// token + connected + status_since + last_error_code null, one statement); every 'ending' or due broadcast of it gets next_attempt_at = null.
export async function updateConnectionSettings(auth: AuthCtx, orgId: string, connectionId: string, b: { privacy?: YoutubePrivacy; madeForKids?: boolean; consent?: true }): Promise<YoutubeConnectionView>;
export type YoutubeConnectionView = { connectionId: string; channelTitle: string; privacy: YoutubePrivacy; madeForKids: boolean;
  status: "connected" | "reconnect_needed"; liveState: "enabled" | "not_enabled" | "blocked" | "unknown"; termsOutdated: boolean; openBroadcasts: number };
// schemas.ts: StreamTarget gains `youtube: YoutubeConnectionView.nullable()` (null for pasted rows); new YoutubeConnectionSettings, YoutubePendingChannels.
```
- `POST /orgs/:id/youtube-connections` `{ pendingId, channelId }`. `GET /orgs/:id/youtube-connections/pending/:pendingId` returns `{ channels: {id,title}[] }`: only the pending row's own user, unexpired, and the org's. `PATCH /orgs/:id/youtube-connections/:connectionId` takes `{ privacy?, madeForKids?, consent? }`. Writes are EDITOR_ROLES (the `requireOrgAuth(req, id, "write")` the stream-targets routes use).

- [ ] **Step 1: Write the failing tests.**

```ts
it("connect: a channel live in org A, connected from org B → 409 YOUTUBE_OTHER_ORG with the spec's sentence; org A untouched", …);   // §9.2
it("connect the same channel again in the SAME org → the existing connection, token replaced, still one destination row", …);
it("pick: a channelId not in the pending row's list → 422; an expired pending → 410; another user's pending → 404", …);
it("consent text changed (YOUTUBE_CONSENT_VERSION stubbed to 2 via vi.mock of lib/youtube): termsOutdated true; PATCH consent → false and consent_version 2, consent_by = caller", …);   // §9.2 (Go live still works: T11)
it("settings: privacy 'public' persists; an unknown privacy → 422; madeForKids flips", …);
it("Directory list: the API row carries youtube{…}, keyHint null, inUse null; a pasted row carries youtube null", …);
it("org B cannot list, read the pending channels of, or PATCH org A's connection — 404 each", …);   // §9.2 cross-org (see)
it("a v1 API key with read scope cannot POST/PATCH (key-scopes)", …);
```

- [ ] **Step 2: Run VERIFY → `t8`** red. **Step 3: Implement.** **Step 4:** VERIFY green. TSC. Run
  `npm run openapi:gen && git status --porcelain` and commit the regenerated spec with the change. **MUTATE** the
  other-org mapping (map it to "existing") and the pending-owner check.
- [ ] **Step 5: Commit** `feat(youtube): connections usecase, Directory projection, v1 routes`.

**Four types:** unit + regression; E2E `youtube-connect.spec.ts › connect` and `› review updated terms` is not
e2e-reachable (it needs a version bump), so it stays unit-only, with the reason recorded; smoke `youtube: list shape` (T21).

### Task 9: Directory UI (blocked on T4's choice)

> **Owner's T4 choice (2026-10-27):** Directory → Streaming = **Option A** connect flow (Connect YouTube secondary
> beside Add destination; inline consent card; inline channel picker) **with Option B's channel rows** (status
> sentence + the fixing button on show, full-width on a phone). Fixture stream panel (T12) = **Option B** (custom
> list with kind + health on every row; a refusal replaces Go live with its fix; replays as rows with times + Copy
> link; re-read connection health on tab focus; rebuild keyboard/typeahead/focus for the list). Public page (T16) =
> see D12 under T16. Mocks: controller scratchpad `t4/youtube-ui-options.html`.

**Owner's choice from T4:** *(controller records the option here before dispatch)*

**Files:**
- Modify: `apps/web/src/components/v2/stream-destinations-panel.tsx` (it may split one focused child component out of it, `components/v2/youtube-connect-panel.tsx`, if the panel would otherwise pass ~800 lines)
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`, then `npm run i18n:gen-keys`
- Test: `apps/web/src/components/v2/__tests__/youtube-connect-panel.test.ts` (markup render, node env)
- Create: `apps/web/e2e/youtube-directory.shots.spec.ts` (R8)

**Interfaces:** Consumes T7's form POST and landing codes, T8's list `youtube` block, the PATCH, and the pending GET.
Copy keys (under `streaming.youtube.`): `connect`, `consent.title`, `consent.body` (spec §6.1 draft, owner's legal
text later), `consent.tos`, `consent.guidelines`, `consent.privacy`, `privacy.unlisted|public|private`,
`madeForKids.label|no|yes`, `picker.title`, `status.connected|reconnectNeeded|notEnabled|blocked|reviewTerms`,
`notEnabledHint` ("YouTube can take up to 24 hours"), `action.reconnect|settings|disconnect`, and one key per landing
code (`landing.connected|no_channel|scope_missing|other_org|different_channel|denied|expired|not_configured|forbidden`).

- [ ] **Step 1: Write the failing tests:**
  - the Connect button is disabled until the box is ticked (render both states);
  - Unlisted and No are preselected (**pin the value the control opens at**, AGENTS.md class 19);
  - every landing code renders its own key, `checked === 9` (`pick` opens the picker instead);
  - an API row shows no Replace key and no Remove;
  - a key from each locale renders (no English fallback in `es`).
- [ ] **Step 2–4:** red → implement → VERIFY green. Then build-verify by CI dispatch (no local server). R8: this task writes
  its own `apps/web/e2e/youtube-directory.shots.spec.ts` (pattern: `e2e/credits-tab-shots.spec.ts`; the fake port via
  the T5 control route), capturing the Connect action, the consent step, the picker and the connection row at 1280,
  768 and 320, each asserting `document.documentElement.scrollWidth <= clientWidth`. Push, dispatch it by CI, and
  publish the captures to an Artifact page. No
  horizontal scroll, and `min-w-0` on every truncating chain (channel names).
- [ ] **Step 5: Commit** `feat(youtube): Directory connect, consent, picker, connection row`.

**Four types:** unit (markup); E2E `youtube-directory.shots.spec.ts` (this task, three widths) + `youtube-connect.spec.ts
› connect` (T20); smoke `youtube: directory renders Connect YouTube` (T21);
regression `directory-stream-destinations.spec.ts` unchanged.

**B3 gate:** `reviewer` over B3 plus a visual sign-off per screen (AGENTS.md class 11). Push. Dispatch e2e.

# B4 — Go live (T10–T12)

### Task 10: The prepare module

**Files:**
- Create: `apps/web/src/server/youtube/{prepare,title}.ts`
- Test: `apps/web/src/server/youtube/__tests__/prepare.test.ts`, `title.test.ts`

**Interfaces:**
- Consumes: T1 tables, T2 `insertPooledKey`, `openToken`, T5 port, `broadcastEndDueAt` + `readEndFacts` (T13).
  **Ordering:** T13 is pure and has no dependency past T1, so the controller dispatches it **at the start of B4,
  before T10**. It stays listed under B5 because its review belongs with the end step.
- Produces:
```ts
export type Prepared = { broadcastId: string; reused: boolean; keyId: string };
/** null when targetId is a pasted row. Throws HttpError with a YoutubeRefusalCode (409; youtube_limit_reached 429; youtube_unavailable 503
 *  everywhere, R3), extra { connectionId } only — or the EXISTING active_session 409 (refuse()'s shape, no new code, R3) while another admission
 *  holds an unlapsed reservation. Never holds a lock across a port call. */
export async function prepareYoutubeBroadcast(a: { orgId: string; fixtureId: string; targetId: string; now: Date }, port: YouTubePort): Promise<Prepared | null>;
/** A refused admission: created-new → deleteBroadcast at YouTube + row 'failed' code 'admission_refused', only while the row is still
 *  'created'/'bound' (a row another admission reserved meanwhile is left to it); reused → reservation released
 *  (state back to 'live' when last_session_id is set, else 'bound'). Never throws (reports). */
export async function abandonPrepared(p: Prepared, port: YouTubePort): Promise<void>;
/** Inside admission's transaction, after the session insert: reserved|bound → live, reserved_until null, last_session_id = sessionId.
 *  0 rows updated (the reservation lapsed and the end step claimed it), or a reused row whose key_id / yt_broadcast_id is still null
 *  (two Go lives on one fixture in the same second; rare) → HttpError(503, …, "youtube_unavailable") (R3). */
export async function attachPrepared(tx: Tx, p: Prepared, sessionId: string): Promise<void>;
export const YOUTUBE_RESERVATION_MINUTES = 2;
export function broadcastTitle(a: { home: string | null; away: string | null; division: string; competition: string; vs: string; tbd: string }): string;   // ≤ 100, '<' '>' removed, competition trimmed first
export function broadcastDescription(a: { line: string; matchUrl: string }): string;
```
- The algorithm the signatures do not determine (spec §6.2 with P2, P3, P4, P7):
  1. Read the connection through the target. If its status is not `connected`, throw `youtube_reconnect_needed`.
     Get the access token with `port.accessToken(openToken(…))`.
  2. Short tx: `select … from youtube_broadcasts where fixture_id = $f and state in ('created','bound','live','reserved') for update`
     (R3: `created` included; `ending` is never selected, so a claimed row is never reused).
     - Row reserved-unlapsed: another Go live is mid-admission → the existing `active_session` 409 (R3).
     - Else, with `dueAt = broadcastEndDueAt(await readEndFacts(tx, id), now)`: **reuse when `dueAt === null || dueAt > now`**
       (R2: null means never due while a session is active, or before any session): set it `reserved`,
       `reserved_until = now + 2 min`, commit, return `{ reused: true }`.
     - Else (due, unclaimed): set it `ending` (`claimed_at = now`), commit, continue to step 3 (P7).
  3. Short tx: lock the connection row and pick a free non-retired key (no row in the per-key open set). If one is
     free, insert the broadcast row `created` with that `key_id` and its `title` (computed before the tx; the column is NOT NULL). If none is free and fewer than 10 are live, insert the
     row `created` with `key_id null`. Outside the tx, call `port.insertStream`. Then in a tx: `insertPooledKey` at the
     lowest free slot and set the row's `key_id`. A slot 23505 means another admission won the race: delete that
     liveStream and retry the pick once. If 10 are busy, throw `youtube_channel_busy` (no row written). A 23505 on
     `youtube_broadcasts_one_open_per_fixture` (a concurrent admission inserted first) → re-read and take step 2's
     reuse path (R3).
  4. Outside any tx: `port.insertBroadcast` (title, description, `scheduledStart = now`, the connection's privacy and
     made-for-kids). Write `yt_broadcast_id` (the title was written in step 3). Then `port.bind`, then mark the row `bound`. On any port
     throw: delete at YouTube what was created, set the row `failed` with the code, and rethrow as the refusal.

- [ ] **Step 1: Write the failing tests** (FakeYouTube, fresh DB, expected numbers typed from the spec).

```ts
it("title: 'Home v Away · Division · Competition'; a 43-char entrant pair + long competition stays ≤ 100 and trims the competition FIRST (division intact)", …);   // RF1
it("title: '<' and '>' are removed; TBD v TBD uses the tbd word", …);
it("RF4 (R4): prepareYoutubeBroadcast for an org whose default_locale is 'es' → the fake's recorded insertBroadcast title uses es's schedule.vs (a TBD side es's schedule.tbd) and the description es's line; expected words read from dictionaries/es/ui.json by import, and the en words are ABSENT", …);   // through prepare: the dictionary lookup lives inside it
it("reuse inside grace: an open 'live' broadcast stopped 4 min ago → same broadcastId, same key, reserved, reserved_until = now + 2 min; ZERO insertBroadcast calls", …);   // §9.3 mutation target
it("…stopped 6 min ago → claimed 'ending', a NEW broadcast on a DIFFERENT key", …);   // 6 ≠ 5: the right answer differs from the off-by-one
it("a claimed (ending) broadcast is never reused", …);
it("R2: a broadcast whose session is still ACTIVE (dueAt null) is selected for reuse, not claimed; a reserved-unlapsed row → the existing active_session 409", …);
it("R3: a concurrent admission's 'created' row on the same fixture (23505 on one_open_per_fixture) → re-read → reused; one broadcast at YouTube", …);
it("two fixtures prepared at once on one channel → two keys; when the first completes, a third fixture reuses its key (no insertStream)", …);   // §9.2
it("key-busy: 10 open broadcasts on 10 keys → the 11th throws youtube_channel_busy; no row, no insertStream, no insertBroadcast", …);   // 10: §3.1; §9.3 mutation target
it("each port refusal at each step leaves no 'created'/'bound' row and deletes what YouTube got", async () => {
  // matrix: step ∈ {accessToken, insertStream, insertBroadcast, bind} × code ∈ 5 codes → refusal code equals the injected one;
  // youtube_broadcasts open rows === 0; fake.liveBroadcastCount() === 0 and no orphan 'upcoming' in the fake; checked === 20
});
it("abandonPrepared: created-new → deleteBroadcast called, row 'failed'; reused → back to 'live', reserved_until null", …);
it("attachPrepared after the reservation lapsed and the end step claimed it → 503 youtube_unavailable; the claimed row stays 'ending'", …);
it("a connection in reconnect_needed → youtube_reconnect_needed before any port call", …);
it("org B's fixture cannot be prepared on org A's API target → 404, zero port calls", …);   // §9.2 cross-org (use)
```

- [ ] **Step 2–4:** red → implement → VERIFY green → TSC. **MUTATE**, one at a time:
  - the reuse predicate (`dueAt === null || dueAt > now` → `true`), killed by the 6-min test;
  - the key-busy predicate (`< 10` → `<= 10`);
  - the reserved-unlapsed refusal.
- [ ] **Step 5: Commit** `feat(youtube): go-live prepare (reuse, key pool, insert, bind)`.

**Four types:** unit + regression; E2E `youtube-connect.spec.ts › Go live → Stop → Go live = same video` (T20); smoke
`youtube: reconnect-needed refusal` (T21).

### Task 11: Wire prepare into admission and `add_output`

**Files:**
- Modify: `apps/web/src/server/usecases/stream-sessions.ts` (`startBroadcast` `:1553`, `refuseUnreadableTarget` `:1448`, `runEffects` `:913-923`, `sessionFactsForJob` `:2871-2880`; re-pin each by symbol)
- Test: `apps/web/src/server/usecases/__tests__/stream-youtube-golive.test.ts` (new; reuse `relay/__tests__/_session-rig.ts`)

**Interfaces:**
- Consumes: T10's `prepareYoutubeBroadcast`, `abandonPrepared` and `attachPrepared`; T2's `readPooledKey`.
- Produces:
  - `readSessionDestination(tx: Tx, row: { org_id: string; target_id: string; youtube_broadcast_id: string | null }): Promise<{ url: string; streamKey: string }>`: the pooled key via the broadcast when the id is set, else `readTargetSecret`. Used at `:922` and `:2878`.
  - `SessionDeps` gains `youtube: YouTubePort`, and `defaultDeps` sets `youtube: youtubeDriver()`.
- Placement, by symbol:
  - `refuseUnreadableTarget` returns early for an API row.
  - After `refuseUnreadableTarget(…)` and before `deps.drivers.ingest.storageUsage()`: when the same no-storage
    `admit` probe passes, call `prepared = await prepareYoutubeBroadcast(…, deps.youtube)`.
  - Inside the admission tx, for an API row, skip the `readTargetSecret`/`checkDestination` block. The session insert
    sets `youtube_broadcast_id = prepared.broadcastId` **and `api_backed = true`** (post-T1 amendment; never updated afterwards — add a test that an UPDATE leaving a broadcast id with api_backed false is refused by `broadcast_implies_api_backed`), then calls `attachPrepared(tx, prepared, sid)`.
  - On any throw **after prepare** (`storageUsage()`, the admission transaction including the 23505 mappers, anything
    before the session commits), call `abandonPrepared` before rethrowing (R12; spec §6.2: deleted, never left "upcoming").
  - A thrown guard: an API row with `prepared === null`, or a pasted row with one, is a caller bug, refused by name
    (TEST-STRATEGY rule 4).

- [ ] **Step 1: Write the failing tests** (organiser Go live through `startBroadcast`, FakeIngest + FakeRunner + FakeYouTube).

```ts
for (const mode of ["passthrough", "composed"] as const) {   // §9.2: both
  it(`${mode}: Go live on an API row → session.youtube_broadcast_id set; FakeIngest.addOutput got the POOLED {url, streamKey} (not any rtmp_enc)`, …);
  it(`${mode}: Go live → Stop → Go live inside 5 min → same youtube_broadcast_id on both sessions, same key, exactly ONE insertBroadcast`, …);
}
it("each refusal code: refused with that code, credit ledger rows unchanged, addOutput calls 0, no open broadcast, no Cloudflare input created", async () => {
  // 6 codes: 5 via fake.failNext + youtube_channel_busy via 10 open broadcasts; checked === 6   // §9.2
});
it("admission refused AFTER the broadcast was created (no_credits forced inside the tx) → deleteBroadcast called, row 'failed', no session", …);   // §9.2
it("storageUsage() throws after prepare → the broadcast is deleted at YouTube and its row 'failed', not left for the orphan sweep", …);   // R12
it("an 11th concurrent Go live → youtube_channel_busy, nothing charged, no CF output", …);   // §9.2
it("consent outdated (version stubbed to 2) → Go live still succeeds", …);   // §9.2 / §6.1 step 5
it("two fixtures live at once on ONE API target → both admitted (no target_in_use), two keys", …);
it("a pasted target: two fixtures → the second is still target_in_use (positive pair)", …);
it("sessionFactsForJob on a passthrough API session answers target = the pooled key (contract shape unchanged)", …);
it("guard: an API-backed target that reaches the insert with no prepared broadcast is refused by name", …);
it("apply() never touches youtube_broadcasts: Stop leaves the broadcast row's state and updated columns byte-identical", …);   // §6.3
```

- [ ] **Step 2–4:** red → implement → VERIFY over the new file **and** the existing `stream-sessions.test.ts`,
  `stream-go-live-phone.test.ts` and `stream-start-mode.test.ts` (regression). Then TSC. **MUTATE** the
  `abandonPrepared` call in the catch, killed by the after-created test.
- [ ] **Step 5: Commit** `feat(youtube): Go live streams into the prepared broadcast`.

**Four types:** unit + regression (above); E2E `youtube-connect.spec.ts › Go live → Stop → Go live` and `› refusal
copy` (T20); smoke `youtube: reconnect-needed refusal` (T21).

### Task 12: Fixture stream panel (blocked on T4's choice)

**Files:**
- Modify: the fixture stream panel and its refusal-copy map. Locate them with
  `grep -arn "target_in_use\|no_credits" apps/web/src/components` and record the paths in the report.
- Modify: `ui.json` × 4, then `i18n:gen-keys`.
- Test: the panel's existing markup test file (add cases).

- [ ] **Step 1: Failing tests.**
  - Each of the 6 refusal codes renders its own key and its action, `checked === 6`. `youtube_reconnect_needed` links
    to `/directory?tab=streaming`.
  - The picker lists an API row with the YouTube icon and channel name.
  - An unknown `youtube_*` code falls back to the generic error, never a raw code.
- [ ] **Step 2–4:** red → implement → green. Copy is the spec §6.2 table's gist, in four locales. R8: write
  `apps/web/e2e/youtube-panel.shots.spec.ts` (the API row in the picker, one refusal with its action, the after-match
  link) at 1280/768/320 with the no-horizontal-scroll assertion; CI dispatch; Artifact page.
- [ ] **Step 5: Commit** `feat(youtube): fixture panel picker and refusal copy`.

**Four types:** unit; E2E `youtube-panel.shots.spec.ts` (this task) + `youtube-connect.spec.ts › refusal copy` (T20);
smoke `youtube: reconnect-needed refusal` (T21); regression
(the existing refusal codes still render).

**B4 gate:** `reviewer` plus visual sign-off. Push. Dispatch e2e.

# B5 — Ending, the tick, replay parts (T13–T16)

### Task 13: The end rule

**Files:**
- Create: `apps/web/src/server/youtube/end-rule.ts`
- Test: `apps/web/src/server/youtube/__tests__/end-rule.test.ts`

**Interfaces:**
- Produces:
```ts
export type EndFacts = { activeSessionOnBroadcast: boolean; reservedUntil: Date | null; latestEndedAt: Date | null;
  fixtureStatus: string; finishedAt: Date | null; terminalWithoutEndedAt: boolean };
/** null = NEVER due while a session on this broadcast is active, a reservation is unlapsed, or no session has used it yet
 *  (R2: T10 reuses on null). S = the latest ended_at among sessions ON THIS BROADCAST (P5).
 *  Throws EndRuleInvariantError when terminalWithoutEndedAt. */
export function broadcastEndDueAt(f: EndFacts, now: Date): Date | null;
export async function readEndFacts(exec: Tx | typeof sql, broadcastId: string): Promise<EndFacts>;   // plain selects, no lock
export const YOUTUBE_GRACE_MINUTES = 5; export const YOUTUBE_FINISHED_END_MINUTES = 2;
export const FINISHED_STATUSES = ["decided", "finalized", "forfeited", "abandoned", "cancelled"] as const;   // never needs_decision (F8)
```

- [ ] **Step 1: Failing tests.** The table is spec §6.4 with D4 and D5. The minutes are literals, never the
  constants. The empty case comes first.

```ts
const T0 = new Date("2026-11-01T10:00:00Z"); const m = (n: number) => new Date(T0.getTime() + n * 60_000);
it("EMPTY CASE FIRST: no session ever on the broadcast → null (not due; the orphan rule owns it)", …);
it("active session on the broadcast → null, whatever the result", …);                       // §9.3 mutation target
it("unlapsed reservation → null; lapsed reservation → the normal rule", …);
it("Stop, not finished → due at Stop + 5", () => expect(due({ S: m(0), status: "in_progress" })).toEqual(m(5)));
it("finished, then Stop → Stop + 2", () => expect(due({ S: m(0), status: "decided", F: m(-10) })).toEqual(m(2)));
it("Stop, then finished at +1 → +3", () => expect(due({ S: m(0), status: "finalized", F: m(1) })).toEqual(m(3)));   // §9.2
it("Stop, then finished at +4 → min(+5, +6) = +5", () => expect(due({ S: m(0), status: "decided", F: m(4) })).toEqual(m(5)));
it("needs_decision with finished_at set is NOT finished → +5 (F8)", () => expect(due({ S: m(0), status: "needs_decision", F: m(1) })).toEqual(m(5)));
it("result reverted (status back to in_progress, finished_at null) → +5", …);                // §9.2
it("every FINISHED_STATUSES member ends at +2 (from the spec list, typed here), checked === 5; every other status +5", …);
it("S is the LATEST ended_at across two sessions on the broadcast", …);
it("a terminal session with ended_at null throws EndRuleInvariantError (assumption made a guard)", …);
it("RF3: a pasted session ACTIVE on the fixture does not keep the API broadcast open — facts read 'no active session on broadcast'", …);   // readEndFacts, DB
```

- [ ] **Step 2–4:** red → implement → VERIFY green. **MUTATE** the active guard (§9.3) and `Math.min` → `Math.max`.
- [ ] **Step 5: Commit** `feat(youtube): end rule from session and result facts`.

**Four types:** unit + regression; E2E `youtube-connect.spec.ts › Stop > 5 min ⇒ new video` (T20); smoke `youtube:
stream-tick answers` (T21).

### Task 14: The end step

> **Owner D15 (2026-10-27), for R4 sponsors-on-stream:** add `actual_start_at timestamptz null` and
> `actual_end_at timestamptz null` to `youtube_broadcasts` (amend V478 in place — unmerged; env down/up), and fill
> both at finalize from YouTube's `snippet.actualStartTime` / `snippet.actualEndTime` (verify the field names in
> the liveBroadcasts resource docs) on the `transition(complete)` response; if absent there, one
> `liveBroadcasts.list` (1 unit). Null while live and for a `failed` row. Tests: both set after a normal end (values
> from the fake's scripted times, not from code), null on a never-live/failed row. R4 FKs its rows to
> `youtube_broadcasts(id) on delete cascade`, so purges cover it.
> **Post-T1 amendment:** an `ending` row with no `yt_broadcast_id` finalizes as **`failed`**, never `complete`
> (V478 check `complete_has_facts` would refuse it forever). `last_error_code` stores OUR code (`^[a-z_:]{1,64}$`,
> V478 shape check), never Google's camelCase `reason` token — map first.

**Files:**
- Create: `apps/web/src/server/youtube/end-step.ts`
- Test: `apps/web/src/server/youtube/__tests__/end-step.test.ts`

**Interfaces:**
- Consumes: T13; `setFixtureStreamUrl` (`usecases/fixtures.ts:512`, through the `fillReplayUrl` actor shape `:2929`); T5 port; T2 `openToken`.
- Produces:
```ts
export type YoutubeEndResult = { ended: number; neverLive: number; orphans: number; failed: number; deferred: number };
export async function endDueBroadcasts(port: YouTubePort, o: { now: () => Date; budgetMs: number; wallClock?: () => number; orgIds?: readonly string[]; hooks?: EndStepHooks }): Promise<YoutubeEndResult>;
export const YOUTUBE_END_BUDGET_MS = 15_000;
/** Test seam only: called between the claim's commit and the YouTube call. */
export type EndStepHooks = { afterClaim?: (broadcastId: string) => Promise<void> };
```
- Algorithm (spec §6.4 "Races"). Select candidate ids with `state in ('created','bound','reserved','live','ending')`
  and `(next_attempt_at is null or <= now)` on a non-revoked connection, `reconnect_needed` included (R5, spec §6.7: retried with backoff, never skipped) (oldest first; `orgIds` is test-only, and an
  empty array is refused). For each, while inside the budget:
  1. tx: `for update skip locked` on the row; skipped → next. If the state is `ending`, go to step 2 (the retry of a
     crashed claim). If it is an orphan (P4: `created`/`bound`, no session ever, `created_at < now - 10 min`), claim it
     with orphan intent. Else compute `broadcastEndDueAt(readEndFacts(tx, id))`; not due → commit, next. Due → `state
     = 'ending', claimed_at = now`, commit.
  2. No lock held: `accessToken`, then `broadcastLife`. `ready`/`created`/`absent`, or orphan intent → `deleteBroadcast`
     → outcome failed (`never_live` / `orphan`). `live`/`testing` → `complete`. `complete` → nothing to call. `revoked` (Google's life when the
     channel's grant is gone) → handled as `youtube_reconnect_needed` (R5).
  3. tx: `update … set state = $outcome, completed_at = now where id = $id and state = 'ending'` (finalize never moves
     any other state). On `complete`, write `youtubeWatchUrl(yt_broadcast_id)` through `setFixtureStreamUrl` only when
     `fixtures.stream_url is null`. The actor is `fillReplayUrl`'s shape built from the last session's `created_by`,
     falling back to the connection's `created_by` when `last_session_id` was set null.
  - Errors (R5): every code, `youtube_reconnect_needed` included: `attempts++`, `next_attempt_at = now +
    min(2^(attempts-1), 60) min` (first retry 1 min later, then 2, 4, … 60; P6), `last_error_code`; the row stays
    `ending`. `youtube_reconnect_needed` also moves the connection to `reconnect_needed` (status_since now) and is not
    counted `failed` (a known state); other codes count `failed`. A reconnect resets `next_attempt_at` (T8). A throw
    never stops the loop.

- [ ] **Step 1: Failing tests** (FakeYouTube, real DB, sessions driven through the T11 path or the session rig).

```ts
it("Go live → Stop → 6 min later the step runs → broadcast complete, transition called once; next Go live → a NEW broadcast", …);   // §9.2
it("finished then Stop: due at +2 — not ended at +1:59, ended at +2:00", …);
it("each end path fires the rule from ended_at", async () => {
  // drive a session on the broadcast to terminal through: stopSession (organiser), capture-phone stop, auto-stop (endIfAutoStopDue),
  // applyExpiry (deadline), output_failed (failClosedOnOutput), relay_disabled (stopSession on a disabled deployment);
  // for each: ended_at set by the domain, step at ended_at + 4:59 → not ended; at + 5:00 → ended. checked === 6
});
it("two overlapping firings (Promise.all of two endDueBroadcasts) → exactly ONE complete call, ended sums to 1", …);   // §9.2
it("race, order A: admission reserves first → the step sees the reservation → not due; the session attaches; broadcast stays live", …);   // §9.2
it("race, order B: the step claims first (`o.hooks.afterClaim` pauses it, R5) → admission takes the new-broadcast path; the claimed row ends 'complete', the new one is live; no session references a complete broadcast", …);
it("token killed mid-match: video keeps flowing (fake.videoOn stays live), the step marks reconnect_needed, does NOT call complete, and RETRIES at +1 min and +2 min (accessToken attempted each time, R5); after reconnect (saveConnectionFromGrant) the next run ends it", …);   // §9.2
it("never-live broadcast (bound, video never arrived, session ended) → deleteBroadcast, state failed 'never_live', not a replay part", …);
it("orphan: 'created' 11 min old, no session → deleted at YouTube, failed 'orphan'; 9 min old → untouched", …);   // 10 min: spec §6.2
it("stream_url: null → set to the watch URL; already set by the club → untouched (Part 1 rule)", …);
it("backoff: an unavailable error sets next_attempt_at = now + 1 min after the first failure and + 2 min after the second (P6); the row is not selected before that", …);
it("broadcastLife 'revoked' → connection reconnect_needed, the row stays 'ending' with backoff (R5)", …);
it("RF3: fixture switched to a pasted key inside grace, pasted session live → the API broadcast still ends at Stop + 5", …);
it("budget: wallClock past 15 s after the first row → the rest counted deferred, not failed", …);
it("orgIds: [] is refused", …);
```

- [ ] **Step 2–4:** red → implement → VERIFY green. **MUTATE** the `skip locked` (drop it, killed by overlap or race),
  the finalize `where state = 'ending'` (killed by race B) and the reconnect retry (make it skip: killed by the token-killed test's retry assertions).
- [ ] **Step 5: Commit** `feat(youtube): end step (claim, call, finalize)`.

**Four types:** unit + regression; E2E `youtube-connect.spec.ts › Stop > 5 min ⇒ new video` (T20); smoke
`youtube: stream-tick answers` (T21).

### Task 15: Tick wiring and cadence

**Files:**
- Modify: `apps/web/src/app/api/cron/stream-tick/route.ts`; `apps/web/src/server/usecases/stream-sessions.ts` (`tickOpenSessions` gains `budgetMs?: number`, default `STREAM_TICK_BUDGET_MS`)
- Modify: `apps/cron-worker/src/schedule.ts` (stream-tick `due: { kind: "every" }`; `FAST_TRIGGER` UNCHANGED — stg stays `*/5` (owner Q1 = b, 2026-10-27); the doc comments at `:113-116`, `:140-142` updated to the new truth; failureCounts add `"data.youtube.failed"`). `wrangler.json` UNCHANGED.
- Test: `apps/web/src/app/api/cron/stream-tick/route.test.ts`, `apps/cron-worker/test/{schedule,drift,run}.test.ts` (`run.test.ts:18` `FIVE_MINUTE_ROWS` lists stream-tick: it leaves that list and its throttle cases are re-pinned, R12)

**Interfaces:** the route answer is `StreamTickAnswer & { youtube: YoutubeEndResult }`. The YouTube step runs first,
then the relay-disabled return, then `tickOpenSessions(deps, { budgetMs: STREAM_TICK_BUDGET_MS - elapsed })`. A throw
from the YouTube step becomes `youtube: { …zeros, failed: 1 }` and never stops the session pass.

- [ ] **Step 1: Failing tests.**

```ts
it("relay DISABLED deployment: a due broadcast is still ended, and the answer is {disabled:true, …, youtube:{ended:1}}", …);   // §9.2
it("the YouTube step runs BEFORE the session pass (call order recorded)", …);
it("a throwing YouTube step → youtube.failed 1, sessions still ticked", …);
it("the session pass gets 45 s minus what the YouTube step spent (scripted wallClock)", …);
// cron-worker
it("stream-tick is due on EVERY fast firing: prod 10:01, 10:02, 10:03 each include it", …);
it("stg's fast trigger stays '*/5 * * * *' (owner Q1 = b); stream-tick due at every stg firing 10:05, 10:10", …);
it("external-play stays 5-minutely on prod: due at 10:05, not at 10:06", …);   // the positive pair
it("email-outbox cadence unchanged: every fast firing in both envs (prod minute, stg 5 min)", …);
```

- [ ] **Step 2–4:** red → implement → run VERIFY (web route) plus the cron-worker VERIFY → green. **MUTATE** the step
  order (move YouTube after the disabled return), killed by the disabled test.
- [ ] **Step 5: Commit** `feat(youtube): stream tick ends due broadcasts first, on every fast firing`.
- Note: on stg a broadcast's end can land up to 5 min late (accepted by the owner, Q1 = b); stg acceptance timings
  in T22's runbook allow for it.

**Four types:** unit + regression (drift, schedule, run); E2E `youtube-connect.spec.ts › Stop > 5 min` posts the tick route
(T20); smoke `youtube: stream-tick answers with youtube counters` (T21).

### Task 16: Replay parts (UI half blocked on T4)

> **Owner D12 + part rule (2026-10-27) — supersedes the T4 pill for API-connected matches:** the public match page
> **embeds the YouTube player** behind a **click-to-play facade** (thumbnail + play button; the iframe loads only on
> tap; `youtube-nocookie.com` privacy mode), with a small **"Open on YouTube"** link under it. Pasted-key matches
> keep today's link pill. **Part tabs appear ONLY when a match has 2+ parts**; one part = the player alone, no
> "Part 1" anywhere (tests: single part renders no part label; two parts render both tabs). `src/proxy.ts` CSP
> `frame-src` gains the YouTube embed origin(s) only. If the channel disabled embedding (or the embed errors), fall
> back to the link. Before building: verify Google's embedded-player rules (YouTube Required Minimum Functionality /
> Developer Policies: minimum player size, never obscure controls or branding) from the docs, and show the owner
> **2+ embed layouts** (320/768/1280) before the UI half is built.

**Files:**
- Modify: the public match page (`page.tsx:405-430` block); the fixture stream panel's after-match area (path from T12)
- Create: `apps/web/src/server/youtube/parts.ts`: `replayParts(fixtureId: string): Promise<{ partNo: number; url: string }[]>` reading `public_fixture_youtube_parts_v` on the privileged `sql` (R7, the stream pattern)
- Modify: `ui.json` × 4 (`streaming.youtube.watch`, `streaming.youtube.part` with `{n}`)
- Test: `apps/web/src/server/youtube/__tests__/parts.test.ts`; the page tested through its **real server loader** (the
  function the page calls for its fixture data, extended to return `parts`), never a test role reading the view (R7)
- Create: `apps/web/e2e/youtube-parts.shots.spec.ts` (R8)

- [ ] **Step 1: Failing tests.**
  - Restart after completion (complete b1, Go live again, complete b2) gives `[{partNo:1},{partNo:2}]`. The page
    renders "Part 1" and "Part 2" in order. With one part it renders the `watch` key, not "Part 1".
  - Zero parts renders the existing `public-stream-link` path unchanged (empty case first).
  - With parts, the list replaces the single link when `stream_url` is Part 1's URL (never shown twice); a club's own
    different `stream_url` still renders beside the parts.
  - A setup division renders nothing.
  - A `cancelled` fixture renders nothing: it follows `streamLinkLabelKey`'s void rule (§3.9 comment, read it).
- [ ] **Step 2–4:** red → implement → green. R8: `youtube-parts.shots.spec.ts` captures the one-part and two-part
  public page at 1280/768/320 (no horizontal scroll asserted); CI dispatch; Artifact page.
- [ ] **Step 5: Commit** `feat(youtube): match page lists YouTube replay parts`.

**Four types:** unit; E2E `youtube-parts.shots.spec.ts` (this task) + `youtube-connect.spec.ts › replay link(s)` (T20);
smoke `youtube: public match page lists parts` (T21); regression (a pasted-key
fixture's single link is unchanged).

**B5 gate:** `reviewer` plus visual sign-off. Push. Dispatch e2e.

# B6 — Daily work and disconnect (T17–T18)

### Task 17: Daily health, 30-day refresh, dead-grant purge

**Files:**
- Create: `apps/web/src/server/youtube/daily.ts`
- Modify: `apps/web/src/app/api/cron/relay-sweep/route.ts` (the YouTube pass **before** the disabled return, F7); `apps/cron-worker/src/schedule.ts` relay-sweep row `failureCounts: ["data.youtube.failed"]`; the relay-sweep answer type declares `youtube: YoutubeDailyResult` so `drift.test.ts` resolves the counter
- Test: `apps/web/src/server/youtube/__tests__/daily.test.ts`; extend the EXISTING `apps/web/src/app/api/cron/relay-sweep/route.test.ts`; `apps/cron-worker/test/drift.test.ts` (its counter count rises by one)

**Interfaces:**
```ts
export type YoutubeDailyResult = { checked: number; reconnectNeeded: number; refreshed: number; removed: number; purged: number; failed: number };
export async function youtubeDaily(port: YouTubePort, now: Date): Promise<YoutubeDailyResult>;
export const YOUTUBE_REFRESH_AFTER_DAYS = 25; export const YOUTUBE_DEAD_GRANT_PURGE_DAYS = 30;
export async function purgeConnectionData(tx: Tx, connectionId: string): Promise<{ broadcasts: number; streamUrlsCleared: number }>;   // shared with T18
```

- [ ] **Step 1: Failing tests.**

```ts
it("health: invalid_grant → reconnect_needed (status_since now); liveEnabled not_enabled → last_error_code youtube_live_not_enabled, status stays connected", …);
it("RF5: channel renamed at YouTube → channel_title AND the destination row's label updated", …);
it("RF5: live blocked → the Directory view's liveState 'blocked'", …);
it("refresh: rows refreshed 26 days ago → videos.list called in batches of ≤ 50 (120 rows → 3 calls: 50, 50, 20); present → refreshed_at now", …);   // 50: Google's per-call id cap
it("refresh: a video deleted on YouTube → row deleted AND fixtures.stream_url cleared when it pointed at that video; a club's own link untouched", …);   // §9.2
it("refresh: rows refreshed 24 days ago are not called (EMPTY batch → zero calls, checked reported)", …);
it("dead grant: reconnect_needed for 31 days → purge (broadcast rows of the connection gone, its stream_urls cleared, token cleared + status revoked through token-store's revokeConnection, R1); 29 days → untouched", …);   // 30: DP III.E.4
it("relay-disabled deployment → the YouTube daily pass still runs (answer carries youtube{…})", …);
```

- [ ] **Step 2–4:** red → implement → green. **MUTATE** the 25-day threshold comparison and the "points at it" check
  on stream_url clearing.
- [ ] **Step 5: Commit** `feat(youtube): daily health, 30-day refresh, dead-grant purge`.

**Four types:** unit + regression; E2E: none (a daily job with no user surface). The trace forward is the Directory
status badge, covered by T20's `› reconnect needed badge` via the fake's `killToken` plus a manual relay-sweep POST.
Smoke `youtube: relay-sweep answers` (T21).

### Task 18: Disconnect, purge, revoke (UI half blocked on T4)

**Files:**
- Create: `apps/web/src/server/youtube/disconnect.ts`
- Modify: `app/api/v1/orgs/[id]/youtube-connections/[connectionId]/route.ts` (DELETE), `schemas.ts`/`openapi.ts`/`key-scopes.ts`, the Directory row's Disconnect action, `ui.json` × 4; extend `apps/web/e2e/youtube-directory.shots.spec.ts` (T9) with the disconnect confirm and the `YOUTUBE_IN_USE` refusal at 1280/768/320 (R8)
- Test: `apps/web/src/server/youtube/__tests__/disconnect.test.ts`, the route test

**Interfaces:**
```ts
export async function disconnectYoutube(auth: AuthCtx, orgId: string, connectionId: string, port: YouTubePort): Promise<{ revokedAtGoogle: boolean; keysDeleted: number; purged: { broadcasts: number; streamUrlsCleared: number } }>;
// tx1: lock connection; any broadcast in ('reserved','bound','live') whose end is NOT due (broadcastEndDueAt null or > now)
//      → HttpError(409, "A match is using this channel", "YOUTUBE_IN_USE") (R9: 'ending'/claimed and due rows do not block; they are purged);
//      openToken into memory; token-store's revokeConnection (token null + revoked + revoked_at, ONE statement, R1); archive the destination row; commit.
// no lock: with the in-memory token, end each due/ending broadcast at YouTube (complete, or delete if never live; best-effort, so none is left
//      live with no picture); deleteStream for each key; revoke unless another non-revoked connection has the same google_sub (T6 Step 0; record 'revoke_skipped_shared_grant').
// tx2: purgeConnectionData; delete key rows. A YouTube failure in the middle never stops tx2.
```

- [ ] **Step 1: Failing tests.**

```ts
it("disconnect while a broadcast is live → 409 YOUTUBE_IN_USE, nothing changed", …);                 // §9.2; §9.3 mutation target
it("disconnect inside grace (Stopped 2 min ago, broadcast live) → 409", …);
it("R9: a reconnect_needed connection holding a claimed 'ending' row → disconnect succeeds and purges it", …);
it("R9: a due-but-unclaimed live broadcast (Stopped 6 min ago) does not block; it is completed at YouTube before the revoke", …);
it("disconnect idle → token revoked at Google once, keys deleted at YouTube, token null, status revoked, destination archived, broadcast rows gone, fixtures.stream_url pointing at its videos cleared, a club's own link kept", …);   // §9.2
it("a SECOND disconnect → 404 (already revoked), no Google call", …);
it("same google_sub on another live connection → no revoke call, recorded; that connection still works", …);
it("org B cannot disconnect org A's connection → 404; a scorer → 403", …);   // §9.2 cross-org
it("after disconnect, the same channel can be connected by another org", …);
it("Go live on the archived destination after disconnect → the existing 404 target_not_found", …);
```

- [ ] **Step 2–4:** red → implement → green → openapi drift empty. **MUTATE** the in-use guard (§9.3). CI-dispatch the
  shots spec; Artifact page.
- [ ] **Step 5: Commit** `feat(youtube): disconnect with revoke and inline purge`.

**Four types:** unit + regression; E2E `youtube-connect.spec.ts › disconnect` (T20); smoke `youtube: disconnect
unknown → 404` (T21).

**B6 gate:** `reviewer`. Push. Dispatch e2e.

# B7 — Policy, end-to-end, smoke, stg runbook (T19–T22)

### Task 19: Privacy policy additions (Q2)

**Files:** Modify `apps/web/src/app/legal/privacy/page.tsx`. Test: its markup test (create one if absent).

- [ ] **Step 1: Failing test.** Each item is asserted as an `href="…"` anchor or exact text:
  - the page says Seazn uses YouTube API Services;
  - it links `http://www.google.com/policies/privacy` and `https://security.google.com/settings/security/permissions`;
  - it links the YouTube ToS;
  - it names what is accessed, stored, used and shared (channel id and title, a refresh token, broadcast/video ids and
    titles, kept up to 30 days and refreshed or deleted), the in-app disconnect and its 7-day purge, and a contact.
  - `checked === 7` (the API Services text, the Google privacy href, the permissions href, the ToS href, the data list,
    the disconnect + 7-day purge, a contact).
- [ ] **Step 2–4:** red → write the section (DP III.A.2 per spec §3.4; re-read developers.google.com/youtube/terms/developer-policies first) → green.
- [ ] **Step 5: Commit** `docs(privacy): YouTube API Services disclosure`.

**Four types:** unit; E2E `youtube-connect.spec.ts › consent links resolve` (T20); smoke `youtube: /legal/privacy
names YouTube API Services` (T21); regression (the existing sections unchanged).

### Task 20: The e2e spec

**Files:**
- Create: `apps/web/e2e/walkthrough/youtube-connect.spec.ts` (follow `walkthrough/directory-stream-destinations.spec.ts` and `walkthrough/stream-relay.spec.ts` for login, org seeding and fake-ingest driving)
- Modify: `.github/workflows/e2e.yml` (env on every job that starts the server: `YOUTUBE_DRIVER: fake` and a per-run `YOUTUBE_TOKEN_KEK`, generated the way `RELAY_KEK` is at `:976-980`), plus its wiring test `e2e-ci-wiring.test.ts` ("YOUTUBE_TOKEN_KEK reaches every …")

- [ ] **Step 1: Write the spec.** Each test drives the UI and the fake control route (`autoVideo` on, so broadcasts go live and can complete as parts;
  tokens and streams addressed only by the handles `state` returns, R6), and asserts what the screen shows
  plus the fake's counts:
  - `connect: consent → picker → row`. The Connect button is disabled until ticked. Two fake channels lead to the
    picker. The row shows the channel name and the Unlisted badge. (Captures belong to T9's shots spec, R8.)
  - `connect → Go live` (T1's named test): connect one channel and Go live on its row; the session is live and `state`
    shows one bound broadcast.
  - `Go live → Stop → Go live = same video`. Fake `insertBroadcast` count stays 1, and the panel shows live.
  - `Stop > 5 min ⇒ new video`. Advance by POSTing the tick route with a server clock override if one exists,
    otherwise by stamping `ended_at` back in the DB the way existing walkthroughs age rows. Record which in the report.
    The next Go live gives count 2.
  - `refusal copy`: `failNext youtube_live_not_enabled`, Go live, then the spec sentence is visible and no session
    exists.
  - `replay link(s)`: two parts give "Part 1" and "Part 2" on the public page.
  - `reconnect needed badge`: `killToken` with the `tokenHandle` from `state`, POST relay-sweep, then the badge shows.
  - `disconnect`: refused while live; after the end, the disconnect succeeds and the row is gone.
  - `two matches on one channel`: both live, no `target_in_use`.
  - `consent links resolve`: the three hrefs are the exact spec URLs.
- [ ] **Step 2:** Push, then `gh workflow run e2e.yml --ref feat/youtube-connect -f pr=<n>`. Hand back. The controller
  watches, and runs the **whole** spec file plus `mobile.spec.ts`, never a `-g` slice (AGENTS.md class 21).
- [ ] **Step 3: Commit** `test(e2e): YouTube connect walkthrough on the fake port`.

### Task 21: Smoke

**Files:** Modify `scripts/smoke.ts` (one `// --- youtube connect` section); the smoke job's env in `.github/workflows/ci.yml` (`YOUTUBE_DRIVER: fake`, `YOUTUBE_TOKEN_KEK`).

- [ ] **Step 1: Add probes**, each under the name its owning task cites. Anti-vacuity: the section reports `probes === 10`.
  - `youtube: stream-tick answers` (T1, T13, T14, T15): `POST /api/cron/stream-tick` → 200, `data.youtube.failed === 0`, numeric `ended`.
  - `youtube: relay-sweep answers` (T17): `POST /api/cron/relay-sweep` → `data.youtube` present.
  - `youtube: connect without consent is refused` (T7): `POST /api/youtube/connect` without `consent` → 400.
  - `youtube: reconnect-needed refusal` (T2, T10, T11, T12): a connection seeded `reconnect_needed` through the smoke's
    `postgres` handle (any non-null token bytes: prepare refuses on status before opening it), then Go live → 409
    `youtube_reconnect_needed`, no session row.
  - `youtube: list shape` (T3, T8): the Directory list carries that API row with `youtube.status === "reconnect_needed"`,
    `keyHint === null`, `inUse === null`.
  - `youtube: fake control route answers in fake mode` (T5): `POST /api/internal/youtube/fake {op:"state"}` → 200, and the
    body holds no token or key.
  - `youtube: directory renders Connect YouTube` (T9): `GET /directory?tab=streaming` HTML has `data-testid="youtube-connect"`.
  - `youtube: public match page lists parts` (T16): one seeded `complete` broadcast → the public page has
    `data-testid="youtube-part-1"`.
  - `youtube: disconnect unknown → 404` (T18): `DELETE /api/v1/orgs/:id/youtube-connections/<random uuid>` → 404.
  - `youtube: /legal/privacy names YouTube API Services` (T19).
  - Each probe asserts `="` anchored attributes where it reads HTML (AGENTS.md trap).
- [ ] **Step 2:** Smoke runs on the PR's CI job. Paste back the counts. **Step 3: Commit** `test(smoke): YouTube connect probes`.

### Task 22: stg acceptance runbook and PR readiness

**Files:** Create `docs/superpowers/specs/2026-10-27-youtube-connect-stg-runbook.md` (the owner runs it; spec §8, §9.4).

- [ ] **Step 1: Write the runbook.**
  - **Prerequisites** (§8 1–4): Data API enabled, scope on the consent screen, callback URIs
    `https://<stg>/api/youtube/connect/callback` and prod, `YOUTUBE_TOKEN_KEK` on stg and prod, Testing-mode 7-day
    note.
  - **Steps:** connect a real channel. Run R-VRVN: two Go lives about 60 s apart should give one video in Studio.
    Leave a gap over 5 min: two videos, both titled with the spec format. Check the replay links on the match page.
    Then disconnect: the token is revoked at myaccount, the keys are gone in Studio, and the links are cleared.
  - **Read-only stg SQL** the agent runs afterwards (`REMOTE_DATABASE_URL`, schema `seazn_club`): the
    `youtube_broadcasts` states and times against `fixture_stream_sessions.ended_at`, with end time minus Stop
    expected in [5, 10) min on stg (its tick fires every 5 min, Q1 = b; prod's would be [5, 6)). Also record the real visibility (spec §10 unknown).
- [ ] **Step 2: PR readiness (controller).**
  - Renumber `V4NN` to the actual max + 1.
  - Run `npm run openapi:gen && git status --porcelain`, which must be empty.
  - Run `i18n:check`.
  - Run a final `reviewer` over the whole branch, which answers the four TEST-STRATEGY questions in writing.
  - Get per-screen visual verdicts.
  - Re-run e2e after the renumber. Mark the PR ready. Merge only on the owner's explicit go, after the owner runs the
    stg steps.
- [ ] **Step 3: Commit** `docs(youtube): stg acceptance runbook`.

**B7 gate:** a `reviewer` pass over the whole branch. Paste back the e2e and smoke counts.

---

## Spec coverage map (self-review)

| Spec | Task(s) |
|---|---|
| §0 D1 API per Go live | T10, T11 |
| D2 visibility at connect | T7, T8, T9 |
| D3 Directory → Streaming | T8, T9 |
| D4 5-min join | T10, T13, T14 |
| D5 2 min after finish | T13, T14 |
| D6 refuse, no fallback | T10, T11, T12 |
| D7 consent once per connection | T7, T8, T9 |
| D8 shared timer | T14, T15 |
| D9 tick cadence (amended: stg stays 5 min, Q1 = b) | T15 |
| D10 web only | Global Constraints |
| D11 no switch | Branch-and-merge note; no flag anywhere |
| §5.1–5.4 | T1, T2 |
| §5.2 narrowing | T1, T3 |
| §6.1 | T7, T8, T9 |
| §6.2 + refusals | T10, T11, T12 |
| §6.3 | T11 (the `apply` untouched test) |
| §6.4 + races | T13, T14 |
| §6.5 | T10 |
| §6.6 | T14, T15, T17 |
| §6.7 | T14 |
| §6.8 | T18, T17 (dead-grant purge) |
| §6.9 | T4, T9, T12, T16, T18, T19 |
| §7 | T2, T6, T7, T8, T18 |
| §8 | T22 |
| §9.1 | T5 |
| §9.2 sequences | T8, T10, T11, T13, T14, T15, T16, T17, T18 (each marked `§9.2`) |
| §9.3 mutations | reuse (T10), active ⇒ not due (T13), key-busy (T10), disconnect refusal (T18), scope check (T7) |
| §9.4 | T20, T21, T22 |

Spec requirements with no owning task: **none**. Q1 and Q2 ruled by the owner 2026-10-27 (b; English OK) (privacy
page locale).
