# Seazn-hosted Video Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-match destination **Seazn**. A Seazn match runs composed, plays live on the public match page and on Match Day from a signed Cloudflare programme input, and its replay moves to Bunny Stream, where it stays while the org is a customer. Delivered minutes are measured for staff. Before any of it, Phase 0 makes YouTube Connect safe for customers' channels: no automatic retry loop, a per-fixture runaway ceiling, a non-blocking pre-Go-live warning for young or recently churned channels, and a fuller broadcast description.

**Architecture:** Phase 0 (YouTube Connect only): automatic start gets its own persisted backoff on `org_youtube_connections` (separate from the live-state record that feeds `liveStateOf`); a ceiling of 10 broadcasts per fixture per rolling hour guards runaway bugs; `YouTubePort` gains `channelCreatedAt` and `recentBroadcasts`, which feed a fail-open safety check behind a pre-Go-live warning; `broadcastDescription` gains localised match facts. Every Phase 0 guard sits inside `prepareYoutubeBroadcast` after its connection check, or in the panel behind a YouTube-connection predicate, so a target with no YouTube connection (pasted key, Seazn) never meets one. Phases 1–3: Seazn is one `org_stream_targets` row per org with `kind = 'seazn'` and no credential. Every admission, holder and picker path reads it from there, so `target_id` stays the session's one destination fact. A Seazn session is composed. The programme input (Input B, R2004) that composed sessions already create becomes the viewers' input: it is created signed and gets no Cloudflare output. A tick pass moves finished programme recordings to Bunny through a new `ReplayHost` port. From Phase 1 on, the daily sweep holds every Seazn recording past 3 days (Cloudflare's 30-day floor is the backstop) so Phase 2 can still move it; Phase 3 measures delivery and deletes the replays of deleted orgs.

**Tech Stack:** Next.js (apps/web), TypeScript 7, postgres.js (`sql`, the non-tenant client for stream tables), zod 4 api-v1 schemas plus `npm run openapi:gen`, `jose` (already a dependency) for RS256 tokens, `FakeYouTube` (`server/youtube/fake.ts`) behind the `YouTubePort` seam (`port.ts`) for Phase 0, `hls.js` (new, pinned exactly), vitest (node env, real Postgres), Playwright e2e, and `scripts/smoke/suites`.

**Specs (two):**

- Phase 0: `docs/superpowers/specs/2026-11-19-youtube-connect-channel-safety-design.md` (owner chose approach B, 2026-11-19; the plan for it owner-approved 2026-11-20). Its source plan, `docs/superpowers/plans/2026-11-20-youtube-connect-channel-safety.md`, is folded in here as Phase 0 and superseded by it.
- Phases 1–3: `docs/superpowers/specs/2026-11-20-seazn-hosted-video-design.md`.

Executors read the spec of their phase first; both are binding. Also read `apps/web/src/server/MODULARIZATION.md`, `docs/superpowers/RULES.md` and `docs/superpowers/TEST-STRATEGY.md`.

## Global Constraints

- **Migration numbers: V538 and V539 for Phase 0 (it ships first), then V540, V541, V542 for Phases 1–3.** V538 `youtube_auto_backoff` (Task 1), V539 `youtube_channel_created_at` (Task 3), V540 `seazn_destination` (Task 9), V541 `seazn_replays` (Task 23), V542 `seazn_delivery` (Task 28). The Seazn spec's "next is V531" and the YouTube plan's "next free V" are both resolved here: this branch already has V531–V537 (no V533). Never reuse a number. Re-check `ls db/migration/deltas | sort -V | tail -3` at each rebase and renumber if main has moved.
- **Phase 0 has no flag.** Its source plan defines none: it changes YouTube Connect for every org and ships first, alone or as its own PR (`feat/youtube-channel-safety` off main) before Phases 1–3 rebase on it.
- **Three server flags, all off by default**, read in `apps/web/src/server/relay/config.ts`, the one place relay numbers and settings live, and parsed the way `STREAM_SRT_ENABLED` is (`"true"`/`"false"`, anything else throws): `SEAZN_HOSTED_LIVE` (Phase 1), `SEAZN_HOSTED_REPLAY` (Phase 2, which needs LIVE), `SEAZN_HOSTED_COST` (Phase 3). With LIVE off, no reader lists, picks, resolves or admits a `seazn` row, so no new Seazn stream can start. Controller ruling (2026-11-20): a fixture that already streamed to Seazn keeps showing its Seazn live and replay whatever LIVE is. The flag gates new picks and starts, never playback of what exists.
- G1, the anti-goal: a Seazn session creates no `youtube_broadcasts` row, prepares no broadcast, adds no Cloudflare output and reads no key. A non-Seazn session's path does not change by one byte. Every task that touches start, apply or tick carries a regression test for a pasted-key session and a YouTube session.
- G5: **all Seazn playback is signed.** That covers the Cloudflare programme input (`recording.requireSignedURLs: true`, `allowedOrigins` = the Seazn hosts) and the Bunny CDN (token authentication, with the library's allowed domains set to the Seazn hosts). The camera input stays unsigned, because the phone's `playbackUrl` (`capture-phone.ts:269`) reads it.
- `ingest-cf.ts:10-15`: never send an update that changes `recording` on a live input. The signed settings are part of the create body, and `setInputEnabled` re-sends exactly what the create sent.
- Secrets (the Cloudflare signing key, the Bunny API key, the Bunny token key) come from env through `config.ts` only. They never appear in a URL query, a log, an error, a `stream_provider_calls` row or a database column. A signed token appears only in the playback URL handed to the viewer.
- Courts stay out (spec §7.2). `court_stream_links` admits YouTube connections only (court stream O9), so a `seazn` row (no connection) is already refused there. A test pins that.
- Billing is unchanged (spec §7.3): a Seazn match takes one stream credit through the same admission, balance and `consume_credit` path as any composed match.
- Every new user-facing string goes in `src/dictionaries/{en,es,fr,nl}/ui.json` (and `public.json` for the match page). `src/lib/i18n-keys.ts` is generated and never hand-edited.
- UI changes are verified at 1280, 768 and 320 with no horizontal page scroll. `/admin` is verified at 1280 only.
- Phase 0 rules (from the YouTube spec and plan):
  - A human-tapped Go live is NEVER blocked by the backoff, by the warning, or by anything except the 10-per-hour runaway ceiling. An organiser is never blocked mid-match (the spec's anti-goal); there is no cap on human Stop/Go live restarts.
  - Phase 0's constants live in `apps/web/src/lib/youtube.ts`, beside `YOUTUBE_LIVE_STATE_FRESH_MINUTES` (`:53`), never inline.
  - Quota: `channels.list` and `liveBroadcasts.list` cost 1 unit each. The warning check runs once per Go live tap, never per beat and never from the automatic start.
  - No privacy-default change (it stays the connection's `default_privacy`), no title format change, no change to how streams are relayed, no admin UI, `/admin` untouched.
  - Descriptions carry no hashtags and one match link only. Broadcast description keys follow the `streaming.youtube.broadcast.*` family.
  - Every Phase 0 guard (backoff, ceiling, warning) applies to YouTube Connect targets only. A target with no YouTube connection, Seazn included, never meets one; Tasks 11 and 16 pin that from the Seazn side.
  - `YouTubePort` gains `channelCreatedAt` and `recentBroadcasts` in Task 3 (`server/youtube/port.ts`, `fake.ts`). No Seazn task touches either file; any later change to them builds on those two methods and keeps them.
  - Phase 0 e2e specs are written and run by CI only (`workflow_dispatch --ref`), as its source plan says; Phases 1–3 run their named Playwright files locally as their steps say.
- Work in a worktree, never the main checkout. A fresh worktree has no node_modules: follow the `seazn-local-env` skill. Read `apps/web/src/server/MODULARIZATION.md` before touching `server/`: verbatim moves only, and no behaviour change rides along.
- After any new dictionary key: `npm run i18n:gen-keys` (root `package.json:61`).
- Re-verify every line number in this plan; they are hypotheses (re-checked against the code on 2026-11-20).
- Commit per task. No push, no PR inside a task (the wave boundary opens it).
- Run only the tests that cover the files you changed. Never the full suite or a full `tsc`. Use `grep -a` on result files. Read the counts from `--reporter=json --outputFile=<scratch>/r.json` (`numPassedTests`/`numTotalTests`, with paths under this worktree). Never run the full suite locally.
- After any api-v1 change: `npm run openapi:gen && git status --porcelain` must show only your intended openapi diff.

## Review Focus

Items 1–5 are the Seazn phases'; items 6–10 are Phase 0's.

1. **Two Seazn matches of one org live at the same time.** Both are admitted, because one shared `seazn` row must never read as "destination in use". Pinned in Task 9 (the index) and Task 11 (the holder guard and admission).
2. **The flag goes off after a fixture saved Seazn as its pick, or while a Seazn session runs.** A new start is refused with a typed 422, the saved Seazn pick resolves to **no destination** ("waiting for a destination"), never silently to YouTube or another external one (spec anti-goal), and the running session runs on and ends normally. Pinned in Task 10 and Task 11.
3. **A viewer who loaded the page before kick-off, or keeps it open past the token's expiry.** The player appears when the session goes live, without a reload, and re-mints before expiry while keeping the same `<video>` element. Pinned in Task 15.
4. **A Stop and restart, which makes two sessions, or one programme input with two recordings.** Every recording becomes a replay, numbered by recording start across sessions. Pinned in Task 24 and Task 25.
5. **Bunny never becomes playable** (status 5 or 6, a fetch that keeps failing, an unreachable API). The Cloudflare recording is never deleted, retries back off, staff are alerted once after 3 days, and the sweep never deletes it. Pinned in Task 24 and Task 18.
6. **The backoff must not hide a channel that recovered.** A successful human Go live clears the backoff, and the automatic start then retries at once. Pinned in Task 1 and Task 6.
7. **An automatic start refused by the backoff leaves no half-created broadcast or reserved key behind** (check `failRow` and the reservation cleanup). Pinned in Task 1.
8. **The ceiling window rolls.** The 11th refuses, and one hour later the next succeeds. Refused attempts do not count toward the ceiling, and a Seazn session is never counted or limited. Pinned in Task 2 and Task 11.
9. **A safety-check API failure** (quota, 401, timeout) shows NO warning and never blocks Go live, and it never marks the connection `reconnect_needed` for a mere read failure. A Seazn pick never shows the warning. Pinned in Task 4 and Task 16.
10. **The description** for a fixture with no venue, no start time, a private competition (no match link), TBD entrants and a 300-character competition name stays within YouTube's limit and has no `<` or `>`. Pinned in Task 5.

---

# Phase 0 — YouTube channel safety (no flag)

Spec: `docs/superpowers/specs/2026-11-19-youtube-connect-channel-safety-design.md` (owner chose approach B, 2026-11-19; plan owner-approved 2026-11-20). Phase 0 has **no flag**: it changes YouTube Connect for every org and ships first, before any Seazn flag exists. Its source plan is `docs/superpowers/plans/2026-11-20-youtube-connect-channel-safety.md`; this phase supersedes it where they differ (line numbers below were re-verified on 2026-11-20). Paths in this phase are under `apps/web/src/` unless stated.

### Task 1: Auto-start backoff

**Files:**

- Create: `db/migration/deltas/V538__youtube_auto_backoff.sql`
- Modify: `apps/web/src/lib/youtube.ts` (constants beside `YOUTUBE_LIVE_STATE_FRESH_MINUTES`, `:53`)
- Modify: `apps/web/src/server/youtube/connections.ts` (`recordAutoBackoff`, `clearAutoBackoff`, `autoBackoffRefusal`, `backoffSeconds`, beside `freshLiveRefusal` `:252`)
- Modify: `apps/web/src/server/youtube/prepare.ts`:
  - the target select in `prepareYoutubeBroadcast` (`:133-141`) reads `auto_retry_after` (and `auto_backoff_code` if added);
  - the automatic-start refusal beside `freshLiveRefusal` (`:157`);
  - `failRow` (`:513-529`) records the backoff;
  - a successful prepare clears it.
- Test: `apps/web/src/server/youtube/__tests__/auto-backoff.test.ts` (new; follow `prepare.test.ts`'s DB/fake setup)

**Interfaces — Produces:**

- In `lib/youtube.ts`: `YOUTUBE_AUTO_BACKOFF_BASE_SECONDS = 60`, `YOUTUBE_AUTO_BACKOFF_MAX_SECONDS = 1800`, `YOUTUBE_AUTO_BACKOFF_CODES: readonly YoutubeRefusalCode[]` = `youtube_limit_reached`, `youtube_channel_busy`, `youtube_unavailable` (all three are in `YOUTUBE_REFUSAL_CODES`, `:25-27`).
- In `connections.ts`:
  - `export function backoffSeconds(count: number): number` = `min(60 * 2^(count-1), 1800)`;
  - `export async function recordAutoBackoff(exec, orgId, connectionId, now: Date): Promise<void>` (increments the count, sets `auto_retry_after = now + backoffSeconds(newCount)`);
  - `export async function clearAutoBackoff(exec, orgId, connectionId): Promise<void>`;
  - `export function autoBackoffRefusal(r: { auto_retry_after: Date | null }, now: Date): boolean`.
- Columns on `org_youtube_connections`: `auto_backoff_count int not null default 0`, `auto_retry_after timestamptz null`. Deliberately NOT `last_error_code`/`last_health_at`: those feed `liveStateOf` and the Streaming page.
- The backoff is per YouTube **connection**. A target with no connection (pasted key, and Seazn from Task 9 on) returns from `prepareYoutubeBroadcast` at `target.connection_id === null` (`:143`) before the backoff is read, so it is never backed off.

- [ ] **Step 1: Write the failing tests.**
  - `backoffSeconds(1..8)` = 60, 120, 240, 480, 960, 1800, 1800, 1800, derived from the constants, plus one literal sanity case where the answer differs from the constant.
  - `autoBackoffRefusal` is true before `auto_retry_after`, false at and after it, false when null.
  - Sequence tests through the REAL `prepareYoutubeBroadcast` with `FakeYouTube` forced to `youtube_limit_reached`:
    - an automatic start refuses with the YouTube call made once;
    - a second automatic start inside the window refuses WITHOUT a port call (assert the fake's call count);
    - a human (`organiser`) start inside the window DOES call the port;
    - after a success the count is 0, and an automatic start calls the port again.
    - an automatic start refused by the backoff leaves no `youtube_broadcasts` row in `created`, `bound` or `reserved` and no reserved pooled key (Review Focus 7).
- [ ] **Step 2: Run them and see them fail** (functions undefined). `cd apps/web && npx vitest run src/server/youtube/__tests__/auto-backoff.test.ts --reporter=json --outputFile=$SCRATCH/t1.json`.
- [ ] **Step 3: Write V538, the constants and the four `connections.ts` functions.** Apply V538 to a fresh local schema per the `seazn-local-env` skill. Never apply it to a shared database.
- [ ] **Step 4: Wire into `prepare.ts`.**
  - For `startCause === "automatic"`, refuse when `autoBackoffRefusal` is true, with the stored code. If no code is stored, throw `youtube_unavailable`; add `auto_backoff_code text null` in V538 if the original code is needed (builder's call).
  - In `failRow`, when the code is in `YOUTUBE_AUTO_BACKOFF_CODES`, call `recordAutoBackoff`.
  - On any successful prepare, call `clearAutoBackoff`.
- [ ] **Step 5: Run the Step 2 command again, plus `prepare.test.ts` and `connections.test.ts` scoped.** Expect PASS.
- [ ] **Step 6: Mutate once each:** make `autoBackoffRefusal` return `false`; make the human start honour it. Each turns a test red. Restore. Report the mutants killed.
- [ ] **Step 7: Commit** `feat(youtube): back off automatic start after a refusal`.

### Task 2: Per-fixture runaway ceiling

**Files:**

- Modify: `apps/web/src/lib/youtube.ts` (`YOUTUBE_MAX_BROADCASTS_PER_FIXTURE_PER_HOUR = 10`)
- Modify: `apps/web/src/server/youtube/prepare.ts` (the guard before `insertBroadcast`, `:387`, under the same admission transaction rules as `lockConnection` `:299`: never hold a lock across a port call)
- Modify: `apps/web/src/lib/stream-session-view.ts` / `src/dictionaries/*/ui.json` only if the existing copy does not fit. `stream.error.youtube_limit_reached` exists (`en/ui.json:7206`, mapped at `stream-session-view.ts:240`): reuse it if it reads correctly for the fixture case.
- Test: `apps/web/src/server/youtube/__tests__/fixture-ceiling.test.ts`

**Interfaces — Produces:**

- `export async function recentBroadcastCount(exec, fixtureId: string, now: Date): Promise<number>` in `server/youtube/parts.ts` or `prepare.ts` (builder's call, per MODULARIZATION.md): the count of `youtube_broadcasts` rows for the fixture created in the last 60 min. Existing data only: `youtube_broadcasts` already has `fixture_id` and `created_at` (V479 `:176,196`). No new table.
- Refusal code `youtube_limit_reached`.
- The ceiling counts `youtube_broadcasts` rows only and lives inside `prepareYoutubeBroadcast` after the connection check, so a session that prepares no broadcast (pasted key, Seazn) is never counted or limited.

- [ ] **Step 1: Write the failing tests** through the real prepare path:
  - 10 successive Stop/Go live cycles succeed; the 11th refuses `youtube_limit_reached` with NO port insert call;
  - with `now` advanced 61 minutes the next succeeds;
  - a refused attempt leaves the count unchanged (the 12th also refuses, then the window roll succeeds);
  - another fixture is unaffected.
- [ ] **Step 2: Run them and see them fail.** `cd apps/web && npx vitest run src/server/youtube/__tests__/fixture-ceiling.test.ts --reporter=json --outputFile=$SCRATCH/t2.json`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the Step 2 command again, plus `prepare.test.ts` scoped.** Expect PASS.
- [ ] **Step 5: Mutate once each:** `return true` on the guard, and an off-by-one (`>` vs `>=`). Both must die.
- [ ] **Step 6: Commit** `feat(youtube): per-fixture runaway ceiling on new broadcasts`.

### Task 3: Channel facts (created date, recent short broadcasts)

**Files:**

- Create: `db/migration/deltas/V539__youtube_channel_created_at.sql` (`channel_created_at timestamptz null` on `org_youtube_connections`; nullable for existing rows)
- Modify: `apps/web/src/server/youtube/port.ts` (`YouTubePort`, `:153`)
- Modify: `apps/web/src/server/youtube/google.ts`. `listMyChannels` (`:264-274`) already calls `channels.list?part=snippet&mine=true` and keeps only `id`/`title`; the new method reads `snippet.publishedAt` the same way. A new `liveBroadcasts.list` call is added.
- Modify: `apps/web/src/server/youtube/fake.ts`
- Modify: the connect write. The row is inserted in `token-store.ts:72`, reached from `saveConnectionFromGrant` (`connections.ts:132`) and `pickYoutubeChannel` (`connections.ts:203`). (The source plan's `connections.ts ~142` is stale.)
- Create: `apps/web/src/server/youtube/channel-safety.ts`
- Test: `apps/web/src/server/youtube/__tests__/channel-facts.test.ts`

**Interfaces — Produces:**

- `YouTubePort.channelCreatedAt(at: string, channelId: string): Promise<Date | null>`. It reads `channels.list?part=snippet&mine=true` `snippet.publishedAt` of the item whose `id` is `channelId` (one grant can list several channels, which is why `listMyChannels` answers an array), and null when none matches. 1 quota unit. (The source plan's signature had no `channelId`; added here.)
- `YouTubePort.recentBroadcasts(at: string, since: Date): Promise<{ startedAt: Date; endedAt: Date | null }[]>`. It reads `liveBroadcasts.list?part=snippet,status&mine=true` (`broadcastType=all`) and pages until older than `since`, capped at 3 pages. Errors map through the existing `mapGoogleError` (`google.ts:72`). Never log bodies or tokens (`port.ts` SECRETS rules).
- `FakeYouTube` gains seedable channel creation dates and broadcast history for both methods.
- `export function channelSafetyWarning(f: { createdAt: Date | null; broadcasts: { startedAt: Date; endedAt: Date | null }[]; now: Date }): { young: boolean; shortRecent: number; warn: boolean }`, pure, in `channel-safety.ts`.
  - Constants in `lib/youtube.ts`: `YOUTUBE_YOUNG_CHANNEL_DAYS = 30`, `YOUTUBE_SHORT_BROADCAST_MINUTES = 10`, `YOUTUBE_SHORT_BROADCAST_WARN_COUNT = 2`, and the 24 h window.
  - A broadcast with `endedAt` null (still live) is not short.
  - `warn = young || shortRecent >= 2`. `createdAt` null means `young` is false.
- These two port methods are Phase 0's. Any later task that touches `server/youtube/port.ts` or `fake.ts` builds on them and keeps them (no Seazn task is planned to touch either file; Seazn has no YouTube port).

- [ ] **Step 1: Write the failing tests.**
  - Pure, a table over: age 29 d / 30 d / 31 d; 0, 1, 2 and 3 short; 2 long; 1 short + 1 long; 2 short just outside 24 h; `endedAt` null; `createdAt` null. Expected values derive from the constants.
  - Port, against `FakeYouTube`: `channelCreatedAt` returns the seeded date for the named channel and null for another; `recentBroadcasts` filters by `since`.
- [ ] **Step 2: Run them and see them fail.** `cd apps/web && npx vitest run src/server/youtube/__tests__/channel-facts.test.ts --reporter=json --outputFile=$SCRATCH/t3.json`.
- [ ] **Step 3: Implement** the port, fake, Google adapter, pure function, V539 (applied locally only), and the store of `channel_created_at` when a connection is created. The read is best effort: a failed read stores null and never fails the connect.
- [ ] **Step 4: Run the Step 2 command again, plus `google.test.ts`, `fake.test.ts` and `connections.test.ts` scoped.** Expect PASS.
- [ ] **Step 5: Mutate once each:** flip `>=` to `>` on the warn count; drop the `young` branch. Both must die.
- [ ] **Step 6: Commit** `feat(youtube): channel age and recent short broadcasts`.

### Task 4: Pre-Go-live warning

**Files:**

- Create: `apps/web/src/app/api/v1/orgs/[id]/youtube-connections/[connectionId]/safety/route.ts`, returning `{ warn: boolean; young: boolean; shortRecent: number }`. Follow that folder's auth and org-scoping pattern exactly (`[connectionId]/route.ts`): 404 for a foreign connection, before any port call. Register it for OpenAPI and run `npm run openapi:gen` (the `ci.yml` drift check).
- Modify: `apps/web/src/server/youtube/prepare.ts`: export `accessTokenFor` (`:173`, private today), or extract it per MODULARIZATION.md.
- Modify: `apps/web/src/components/v2/fixture-stream-panel.tsx` `onGoLive` (`:1154`, which POSTs `/api/v1/fixtures/{id}/stream-sessions`). When the chosen target has a YouTube connection (`StreamTarget.youtube` non-null, `schemas/streaming.ts:463`), fetch the safety route once per Go live tap and show a dismissible, non-blocking notice; a second tap ("Go live anyway") proceeds. Any other target (pasted key, or `youtube: null`) never calls it. A court-streamed match (`court !== null`) goes to its court link's channel, so the check uses that link's connection or is skipped (builder's call, stated in the report).
- Modify: `src/dictionaries/{en,es,fr,nl}/ui.json` for the copy, then `npm run i18n:gen-keys` (root `package.json:61`).
- Test: `apps/web/src/app/api/v1/orgs/[id]/youtube-connections/__tests__/youtube-connections-safety.test.ts` (beside `youtube-connections-routes.test.ts`, where this folder's route tests live); `apps/web/src/components/v2/__tests__/fixture-stream-panel.safety.test.tsx` (a sibling: `fixture-stream-panel.test.tsx` is 459 KB) for the notice on a YouTube connection target and Go live anyway proceeding; a Playwright spec under `apps/web/e2e/` for the notice (written, run by CI only; do NOT run e2e locally in Phase 0).

**Interfaces:**

- Consumes: `channelSafetyWarning`, `YouTubePort.channelCreatedAt` / `recentBroadcasts` (Task 3), `accessTokenFor`.
- Behaviour:
  - On any port error, answer `{ warn: false, young: false, shortRecent: 0 }` with HTTP 200 and log via `captureError`.
  - Do NOT call `markIfGrantDead` (`prepare.ts:194`) or `markReconnectNeeded` (`token-store.ts:101`): a read failure must not move the connection status.
  - One call per Go live tap, never from phone beats or the automatic start.
- Copy (English): "Several short test streams can get a YouTube channel flagged, even unlisted. Test on a throwaway channel." Buttons "Go live anyway" / "Cancel" (keys, 4 locales).
- Produces for Task 16: a panel-level predicate `needsChannelCheck(target): boolean` (true only when `target.youtube !== null`), so the Seazn option added there is excluded by construction.

- [ ] **Step 1: Write the failing tests.**
  - The route returns `warn: true` for a young channel and for 2 short broadcasts.
  - It returns `warn: false` and 200 when the fake throws `youtube_unavailable`, `youtube_limit_reached` and `youtube_reconnect_needed`, and the connection status is unchanged after the dead-grant case.
  - A foreign org gets 404 with zero port calls.
  - Panel: a pasted-key target's Go live makes no safety fetch.
  - Locale: all four dictionaries have every new key (anti-vacuity: report the key count).
- [ ] **Step 2: Run them and see them fail.** `cd apps/web && npx vitest run "src/app/api/v1/orgs/[id]/youtube-connections/__tests__/youtube-connections-safety.test.ts" src/components/v2/__tests__/fixture-stream-panel.safety.test.tsx --reporter=json --outputFile=$SCRATCH/t4.json`.
- [ ] **Step 3: Implement** the route, the UI and the copy. Then `npm run openapi:gen && git status --porcelain`.
- [ ] **Step 4: Run the Step 2 command again.** Expect PASS.
- [ ] **Step 5: Drive the real UI once by hand at 320 and 1280** (screenshots to the local :8765 server, no PNGs in the repo), and read what you saw into the report.
- [ ] **Step 6: Mutate once each:** make the route 500 on a port error (the fail-open test fails); remove the 404 scoping.
- [ ] **Step 7: Commit** `feat(youtube): warn before a risky Go live`.

### Task 5: Richer description

**Files:**

- Modify: `apps/web/src/server/youtube/title.ts` (`broadcastDescription`, `:65`)
- Modify: `apps/web/src/server/youtube/prepare.ts` (`textsFor`, `:265-292`: extend the fixture select with sport, round, venue and start time; pass the new args)
- Modify: `src/dictionaries/{en,es,fr,nl}/ui.json`, keys under `streaming.youtube.broadcast.*` (the family `textsFor` already reads), then `npm run i18n:gen-keys`
- Test: `apps/web/src/server/youtube/__tests__/title.test.ts` (extend)

**Interfaces — Produces:**

- `broadcastDescription(a: { line: string; matchUrl: string | null; poweredBy: string; siteUrl: string; facts?: string[] })`. `facts` is an ordered list of already-localised, already-cleaned lines: sport and round; competition; venue when present; date and time.
- Output: the facts block, a blank line, the match link line (only when `matchUrl` is non-null), a blank line, then ONE footer "Scored live with Seazn Club" plus the site link.
- Keep the existing "no `<`/`>`" cleaning and a total length cap of 5000 characters (YouTube's limit), trimming facts first.
- Sport and round names reuse the existing translated labels; no hardcoded English. The locale is the org's `default_locale`, as `textsFor` already resolves it (fallback English).
- Time formatting uses the competition/org locale and timezone. With no timezone, the time line is left out.
- Title format unchanged. No hashtags, one match link only.

- [ ] **Step 1: Write the failing tests.**
  - For each of the 4 locales, the description contains the localised footer, exactly one match link when `matchUrl` is set, and only the site link when it is null.
  - With and without venue; TBD entrants; a private competition (no match link).
  - A 300-character competition name stays under the cap.
  - The output contains no `<` or `>`.
  - Titles are unchanged (re-run the existing title tests).
- [ ] **Step 2: Run them and see them fail.** `cd apps/web && npx vitest run src/server/youtube/__tests__/title.test.ts --reporter=json --outputFile=$SCRATCH/t5.json`.
- [ ] **Step 3: Implement**, add the dictionary keys and regenerate the i18n keys.
- [ ] **Step 4: Run the Step 2 command again, plus `prepare.test.ts` scoped.** Expect PASS.
- [ ] **Step 5: Mutate once each:** drop the length cap; drop the `<>` cleaning. Both must die.
- [ ] **Step 6: Commit** `feat(youtube): match facts in the broadcast description`.

### Task 6: Phase 0 seam proof

**Files:**

- Test: `apps/web/src/server/youtube/__tests__/channel-safety-seam.test.ts`

- [ ] **Step 1: Write one test** that drives the REAL producers and consumers end to end with `FakeYouTube`:
  - connect (stores `channel_created_at`);
  - the safety route returns warn for a 5-day-old channel;
  - an automatic start is refused with `youtube_limit_reached` twice, the second without a port call;
  - a human Go live proceeds and clears the backoff;
  - the description produced by `prepareYoutubeBroadcast` (read from the fake's recorded insert) contains the fact lines.

  It guards the "inert seam" failure class: it fails if any of Tasks 1–5 is declared but never reached.

- [ ] **Step 2: Run the Phase 0 scoped set** in one JSON run: `src/server/youtube/__tests__`, the safety route test, the panel test, and the dictionary/key tests. Paste the raw `numPassedTests/numTotalTests` and `.testResults[].name` evidence, every path under this worktree.
- [ ] **Step 3: Commit** `test(youtube): channel-safety seam proof`.

**Phase 0 wave boundary (orchestrator):** rerun the scoped set from the worktree with an absolute `cd`, check that the names resolve inside the worktree, run the `reviewer` agent on the Phase 0 diff, then a PR for owner sign-off. Phase 0 e2e comes from CI via `workflow_dispatch --ref`.

---

# Phase 1 — Seazn live (`SEAZN_HOSTED_LIVE`)

### Task 7: Probe Cloudflare signed live playback

The adapter changes in Task 12 rest on three vendor behaviours that the docs leave open: `requireSignedURLs` and `allowedOrigins` placed inside `recording` on a **live input**, a self-signed token whose `sub` is the **live input uid**, and a `PUT` that keeps the setting. Settle them before building on them.

**Files:**

- Create: `apps/web/src/server/relay/__tests__/cf-signed-live.live.test.ts`, gated the way `fly-client.live.test.ts` is (`_live-fly-gate.ts` pattern: skipped unless `CF_LIVE_PROBE=1` plus the account env)
- Create: `docs/superpowers/specs/2026-11-20-seazn-hosted-probes.md` (results only)

- [ ] **Step 1: Write the probe.** Create an input with `recording: { mode: "automatic", requireSignedURLs: true, allowedOrigins: ["seazn.club"], timeoutSeconds: 180 }`. Assert:
  - the echo carries both settings;
  - an unsigned `/{uid}/manifest/video.m3u8` answers 401 or 403;
  - a `jose`-signed RS256 token `{ sub: uid, kid, exp: now+600 }` at `/{token}/manifest/video.m3u8` answers 200 (or 204 while idle; anything but 401/403);
  - a `PUT` that re-sends the same `recording` with `enabled: false` echoes `requireSignedURLs: true`;
  - the video the input records reads `requireSignedURLs: true` in `GET /stream/{videoId}`.

  Then delete the video and the input.

- [ ] **Step 2: Run it against the staging account.** `cd apps/web && CF_LIVE_PROBE=1 npx vitest run src/server/relay/__tests__/cf-signed-live.live.test.ts`. Record each assertion's result in the probes doc. If `sub` = input uid fails, stop and raise it: Task 13 must then sign the input's current live video uid (`listInputVideos` → the `inProgress` one), which the doc records as the fallback.
- [ ] **Step 3: Commit** `test(stream): live probe for signed Cloudflare live inputs`.

### Task 8: Seazn settings in relay config

**Files:**

- Modify: `apps/web/src/server/relay/config.ts` (beside `streamPlaybackHost`/`srtEnabled`, `:314-342`)
- Test: `apps/web/src/server/relay/__tests__/config.test.ts`

**Interfaces — Produces:**

- `seaznHostedLive(env?): boolean`, `seaznHostedReplay(env?): boolean`, `seaznHostedCost(env?): boolean`. Unset means false. `"true"`/`"false"` are accepted case-insensitively; anything else throws and names the variable. `seaznHostedReplay` is true only when LIVE is true too.
- `seaznVideoOrigins(env?): string[] | null`. Reads `SEAZN_VIDEO_ORIGINS`, comma-separated bare hostnames trimmed and de-duplicated. Null when unset. Throws on an entry with a scheme or path.
- `streamSigningKey(env?): { keyId: string; pem: string } | null`. Reads `STREAM_SIGNING_KEY_ID` and `STREAM_SIGNING_KEY_PEM_B64`, and null unless both are set. Under the FAKE driver the answer is `{ keyId: "fake", pem }` from `fakeSigningKey()` in `fakes.ts`, an RSA pair generated with `jose` `generateKeyPair("RS256")` once per process and kept in memory. No private key is committed.
- `SEAZN_LIVE_TOKEN_TTL_SECONDS = 3600` and `SEAZN_TOKEN_REFRESH_BEFORE_SECONDS = 300`.

  Plan decision: a 1 h token that the client island re-mints 5 min before expiry (Task 15). That keeps the token short-lived (spec §5.2), stays far under Cloudflare's 24 h cap, and a 3 h match costs three mints per viewer.

- [ ] **Step 1: Write the failing tests.**
  - `seaznHostedLive({})` is false. `({SEAZN_HOSTED_LIVE:"TRUE"})` is true. `"yes"` throws `/SEAZN_HOSTED_LIVE/`.
  - `seaznHostedReplay({SEAZN_HOSTED_REPLAY:"true"})` is false while LIVE is unset.
  - `seaznVideoOrigins({SEAZN_VIDEO_ORIGINS:" seazn.club,www.seazn.club,seazn.club"})` equals `["seazn.club","www.seazn.club"]`, and `"https://seazn.club"` throws.
  - `streamSigningKey` is null when only one of the two variables is set.
  - The values are pinned to the constants: `SEAZN_LIVE_TOKEN_TTL_SECONDS === 3600`.
- [ ] **Step 2: Run them and see them fail.** `cd apps/web && npx vitest run src/server/relay/__tests__/config.test.ts --reporter=json --outputFile=$SCRATCH/t8.json`.
- [ ] **Step 3: Implement** the five readers and the constants.
- [ ] **Step 4: Run the Step 2 command again.** Expect PASS. Mutate one guard: make `seaznHostedReplay` ignore LIVE, and the LIVE-unset test fails.
- [ ] **Step 5: Commit** `feat(stream): Seazn-hosted settings and flags`.

### Task 9: Migration V540 — the Seazn destination row

**Files:**

- Create: `db/migration/deltas/V540__seazn_destination.sql`
- Test: `apps/web/src/server/relay/__tests__/seazn-destination-migration.test.ts`, following `court-stream-migration.test.ts`. Extend `migration-shape.test.ts` if it enumerates the kind check.

**Plan decision:** use a `kind = 'seazn'` row on `org_stream_targets`, not a flag on `fixture_stream_settings`. `fixture_stream_sessions.target_id`, `court_stream_links.target_id` (not null), the picker, `fixtureStreamTarget`'s default and the session's `destination_kind` copy (`start.ts:477`) all key on a target row, so a row keeps every reader working and a flag would fork each of them.

**DDL:**

- Widen the kind check to `('youtube','facebook','twitch','kick','custom_rtmp','seazn')`.
- Replace `org_stream_targets_one_source` with `check ((kind = 'seazn' and rtmp_enc is null and youtube_connection_id is null) or (kind <> 'seazn' and (rtmp_enc is null) <> (youtube_connection_id is null)))`.
- `create unique index org_stream_targets_one_seazn on org_stream_targets (org_id) where kind = 'seazn'`.
- Insert one row per existing organisation: `label 'Seazn'`, `watch_url null`. Create function `ensure_seazn_target()` as `security definer` with `set search_path = public, pg_temp`, owned by the migration role, and an `after insert on organizations` trigger that inserts the row (`on conflict do nothing`). `org_stream_targets` has forced RLS with no policy (V410 `:407-408`), so an invoker-rights trigger would fail an org insert made by the app role.
- `fixture_stream_inputs` gains `access jsonb null`: the signed settings an input was CREATED with (`{"signed":true,"allowedOrigins":[…]}`), written once by provisioning and never updated (Task 12).
- `create table seazn_held_alerts (cf_video_id text primary key, session_id uuid not null references fixture_stream_sessions(id) on delete restrict, alerted_at timestamptz not null default now())`, with RLS as in V430. It is the one-alert-per-recording mark for the sweep hold (Task 18); it needs no replay row, so it works in Phase 1.
- Drop and recreate `fixture_stream_sessions_one_active_target` (V479 `:285-289`) with an added `and destination_kind is distinct from 'seazn'`. `destination_kind` is written once at insert and never updated, so the predicate is stable.

  Plan decision: rows are created by trigger rather than lazily on read. `fixtureStreamTarget` is documented as writing nothing, and RULES.md is greenfield, so no backfill concern applies.

- [ ] **Step 1: Write the failing tests.**
  - A new org gets exactly one `seazn` row.
  - A second `seazn` row for that org fails 23505.
  - A `seazn` row with `rtmp_enc` set fails 23514. A `youtube` row with neither source still fails 23514 (the regression).
  - Two `live` sessions on one `seazn` target insert. Two on one pasted target still fail 23505.
  - The RLS state of `org_stream_targets` is unchanged (`rls-static.test.ts`), and `seazn_held_alerts` is listed.
  - An organisation inserted under `set local role app_user` (the app role) commits and gets its `seazn` row. Run it once with the function as invoker to see it fail, then as definer.
- [ ] **Step 2: Run them and see them fail** (table shape missing). `cd apps/web && npx vitest run src/server/relay/__tests__/seazn-destination-migration.test.ts src/server/relay/__tests__/migration-shape.test.ts src/server/relay/__tests__/rls-static.test.ts --reporter=json --outputFile=$SCRATCH/t9.json`.
- [ ] **Step 3: Write V540.** Apply it to a fresh local schema per the `seazn-local-env` skill (`db:apply` then `sync:sports`). Never apply it to a shared database.
- [ ] **Step 4: Run the Step 2 command again.** Expect PASS.
- [ ] **Step 5: Commit** `feat(db): V540 Seazn destination row`.

### Task 10: Destination reads and writes know Seazn

**Files:**

- Modify: `apps/web/src/server/api-v1/schemas/streaming.ts:70` (`StreamTargetKind` gains `"seazn"`)
- Modify: `apps/web/src/server/usecases/stream-targets.ts`:
  - `listStreamTargets :66-95`: when LIVE is on, Seazn is first, `keyHint: null`, `inUse: null`; when LIVE is off, the row is left out.
  - `patchStreamTarget :163`, `removeStreamTarget :198`: both refuse a `seazn` row.
- Modify: `apps/web/src/server/usecases/stream-codes.ts`:
  - `fixtureStreamTarget :496-509`: when LIVE is on, list `seazn` first; when off, exclude it.
  - `writeStreamSettings :515`: refuse a `seazn` target with 422 `seazn_unavailable` while LIVE is off.
- Modify: `apps/web/src/server/usecases/stream-target-holders.ts:43-66` (`holderRows`): add `and t.kind <> 'seazn'` beside the existing `t.youtube_connection_id is null`.
- Read, no change expected: `apps/web/src/lib/stream-destinations.ts:79-81` (`resolveStreamTarget`). A saved pick that is not in the live list answers `null`, so with LIVE off (Seazn excluded from the list) a saved Seazn pick resolves to no destination. Pin that with a test; never add a fallback there.
- Test: `src/server/usecases/__tests__/stream-targets.test.ts`, `src/server/usecases/__tests__/stream-codes.test.ts` (or the file that covers `fixtureStreamTarget`), `src/server/usecases/__tests__/court-streams.test.ts`

**Interfaces — Produces:**

- `SEAZN_TARGET_FIXED = "seazn_destination_fixed"`: the 422 code for patch and remove.
- `SEAZN_UNAVAILABLE = "seazn_unavailable"`: the 422 code when a write or start names a Seazn target while LIVE is off.
- SQL fragment `seaznOrder(on: boolean)` in `stream-targets.ts`. When on it is `order by (kind = 'seazn') desc, created_at, id`. When off it is `kind <> 'seazn'` in the WHERE plus the old order.

- [ ] **Step 1: Write the failing tests.**
  - LIVE on: `listStreamTargets` returns the Seazn row first for an org with two older pasted keys, and `fixtureStreamTarget` with no saved pick answers it with `source: "default"`.
  - LIVE off: neither function returns it, and the pick is the oldest pasted key (the regression).
  - LIVE off with a fixture whose saved pick is the Seazn row (`target_chosen` true): `fixtureStreamTarget` answers `null`, not any external destination, even when the org has a YouTube connection (Review Focus 2, spec anti-goal).
  - `patchStreamTarget` and `removeStreamTarget` on Seazn give 422 `seazn_destination_fixed`, and the row is unchanged.
  - `holderRows` with a live session on Seazn returns `[]`.
  - Court link create with the Seazn target id gives the existing YouTube-only refusal.
- [ ] **Step 2: Run them and see them fail.** `cd apps/web && npx vitest run src/server/usecases/__tests__/stream-targets.test.ts src/server/usecases/__tests__/court-streams.test.ts <the stream-codes test file> --reporter=json --outputFile=$SCRATCH/t10.json`.
- [ ] **Step 3: Implement.** Then `npm run openapi:gen` (the kind enum and the two refusal codes).
- [ ] **Step 4: Run the Step 2 command again.** Expect PASS. Check that the openapi diff is the kind enum and the codes only. Mutate `holderRows`: drop the new predicate, and the holder test fails.
- [ ] **Step 5: Commit** `feat(stream): Seazn in destination reads and writes`.

### Task 11: Admission of a Seazn session

**Files:**

- Modify: `apps/web/src/server/usecases/stream-sessions/start.ts`:
  - mode: the target's kind is read first, and a `seazn` target sets `body.mode = "composed"` BEFORE `composedRunnerDown` is computed (`:253`), so the composed gate (`admitMode`) judges the mode that will actually run;
  - the destination doors (`:316-340`) are kept and still called; they skip the Seazn target through `pastedTarget` (next bullet) and `holderRows` (Task 10);
  - the secret re-check (`:455-466`, `readTargetSecret`/`checkDestination`) and the earlier `refuseUnreadableTarget` are skipped for a `seazn` target.
- Modify: `apps/web/src/server/usecases/stream-sessions/holders.ts:60-61` (`pastedTarget`): a `kind = 'seazn'` target is not pasted (`x.youtube_connection_id is not null or x.kind = 'seazn'`). The calls stay, so the same-fixture half of `tearDownPriorMachines` (`:103`) and `releasePriorOutputs` (`:153`) still destroys a previous composed Machine of this fixture, while another fixture's Seazn session is never touched.
- Modify: `apps/web/src/server/usecases/stream-sessions/refusals.ts` (the two new refusals)
- Modify: `apps/web/src/server/usecases/capture-phone.ts:807-834` (`phoneStartRefusal`): `seazn_unavailable` → `noDestination(...)`; `seazn_video_unconfigured` → `CaptureRefusalError(503, "unavailable", …)`; `composed_unavailable` stops being a thrown caller bug and maps to `CaptureRefusalError(503, "unavailable", …)`, because a Seazn target now makes a phone start composed whatever `startModeFor` resolved.
- Modify: `apps/web/src/server/usecases/stream-auto.ts:32-57` (`autoStartRefusalOf`): the same three codes, as the retryable "unavailable" family it already uses for `composed_unavailable`.
- Test: `apps/web/src/server/usecases/__tests__/stream-sessions.test.ts` (new `describe("Seazn destination")` block, or a sibling `stream-sessions.seazn.test.ts` using `_session-rig.ts`, given the file is 517 KB)

**Interfaces:**

- Consumes: `seaznHostedLive`, `seaznVideoOrigins`, `streamSigningKey` (Task 8). From Phase 0: the automatic-start backoff (Task 1: `auto_retry_after` on `org_youtube_connections`) and the per-fixture ceiling (Task 2: `YOUTUBE_MAX_BROADCASTS_PER_FIXTURE_PER_HOUR`, refusal `youtube_limit_reached`). Both live inside `prepareYoutubeBroadcast` (`start.ts:399`), after its `connection_id === null` return (`prepare.ts:143`). A Seazn target has no YouTube connection and prepares no broadcast (G1), so neither guard ever reaches it; this task pins that rather than adding a Seazn branch to either guard.
- Produces:
  - `isSeaznTarget(tx, orgId, targetId): Promise<boolean>` in `destination.ts`.
  - Refusals: 422 `seazn_unavailable` (LIVE off), and 503 `seazn_video_unconfigured` (LIVE on with no origins or no signing key under a real driver), both raised before any provider call.

  Plan decision: coerce the mode rather than refuse passthrough. The phone's start and the automatic start read the fixture's stored `stream_mode`, and refusing would strand them. `composedUnavailable()` still refuses first, by name.

- [ ] **Step 1: Write the failing tests.** Use the fakes (`relay/fakes.ts`).
  - A passthrough create on Seazn makes a session with `mode = 'composed'` and `destination_kind = 'seazn'`, no `youtube_broadcasts` row, and no `readTargetSecret` call (spy).
  - A second fixture of the same org starts on Seazn while the first is live, so both are admitted (Review Focus 1).
  - LIVE off gives 422 `seazn_unavailable` with zero provider calls and no row.
  - LIVE on with no signing key under a non-fake driver mode gives 503 `seazn_video_unconfigured` with zero provider calls.
  - One credit is consumed at live, the same count a composed YouTube session consumes.
  - On a deployment with no compositor runner, a phone start on Seazn (stored mode passthrough) is refused `composed_unavailable` before any provider call, and `phoneStartRefusal` maps it to 503 `unavailable` (no throw). `autoStartRefusalOf` maps it too.
  - `phoneStartRefusal` and `autoStartRefusalOf` each map `seazn_unavailable` and `seazn_video_unconfigured` (one test per code per mapper).
  - A Seazn restart of the same fixture whose previous composed session left an undestroyed Machine: `tearDownPriorMachines` destroys it. Another fixture's live Seazn Machine is untouched.
  - Regression: a pasted-key start and a YouTube start produce the same provider-call sequence as before (assert against the recorded call list).
  - Phase 0 guards never touch Seazn (Review Focus 8):
    - Backoff: the org's YouTube connection is in backoff (`auto_retry_after` an hour ahead, `auto_backoff_count` 3). An **automatic** start of a fixture on the Seazn target is admitted and reaches `live`, `FakeYouTube` records zero calls, and the connection's `auto_backoff_count` and `auto_retry_after` are unchanged afterwards. The same automatic start on the YouTube target of that org is refused by the backoff (the control: proves the fixture really was backed off).
    - Ceiling: a fixture with 10 `youtube_broadcasts` rows created in the last hour (Phase 0's ceiling reached), then switched to Seazn. An 11th start, and a 12th after a Stop, are both admitted on Seazn with no `youtube_limit_reached` refusal and no new `youtube_broadcasts` row. The same 11th start on the YouTube target is refused `youtube_limit_reached` (the control).
    - Ten Stop/Go live cycles of one fixture on Seazn inside an hour, then the 11th: admitted (Seazn sessions are not counted by `recentBroadcastCount`).
- [ ] **Step 2: Run them and see them fail.** `cd apps/web && npx vitest run src/server/usecases/__tests__/stream-sessions.seazn.test.ts --reporter=json --outputFile=$SCRATCH/t11.json`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the Step 2 command again.** Expect PASS. Then run the scoped regression: `stream-sessions.test.ts` and `relay-sweep.test.ts`. Mutate `pastedTarget` back to its old predicate, and the two-matches test fails.
- [ ] **Step 5: Commit** `feat(stream): admit Seazn sessions as composed with no external destination`.

### Task 12: No output, signed programme input

**Files:**

- Modify: `apps/web/src/server/relay/domain/session.ts`:
  - `Session` gains `destination: "external" | "seazn"`;
  - `provisioned` (`:398-403`) emits `[]` instead of `[{ type: "add_output" }]` when `destination === "seazn"`.
- Modify: `apps/web/src/server/usecases/stream-sessions/session-row.ts` (map `destination_kind = 'seazn'` to `"seazn"`, everything else to `"external"`)
- Modify: `apps/web/src/server/usecases/stream-sessions/provision.ts:35-36,64-67` (the programme create passes `access`, and `fixture_stream_inputs.access` is written in the same statement that stores the input's credentials, never updated afterwards)
- Modify: `apps/web/src/server/relay/ports.ts`:
  - `IngestCreateSpec` gains `access?: { signed: true; allowedOrigins: string[] }`;
  - `InputSwitchMeta` gains `access?`, the value READ from `fixture_stream_inputs.access`, never from env. So an env change to `SEAZN_VIDEO_ORIGINS` can never alter `recording` on an existing input (`ingest-cf.ts:10-15`).
- Modify: `apps/web/src/server/relay/ingest-cf.ts`:
  - `createLiveInput :270-300`: `recording` becomes `liveInputRecording(spec.access)`;
  - the read-back compares `requireSignedURLs`/`allowedOrigins`;
  - `setInputEnabled :499-516`: re-sends `liveInputRecording(meta.access)` and verifies the echo.
- Modify: `apps/web/src/server/relay/fakes.ts` (the fake keeps `access` per input; `inputAccess(inputId)` lets tests read it)
- Callers: the only production caller of `setInputEnabled` is `port-effects.ts:180`, and it switches the CAMERA (unsigned, no `access`). No programme input is switched today. The adapter refuses a `role: "programme"` call whose meta has no `access` key at all (`access: null` is the explicit unsigned answer read from the row), so a future caller cannot send an unsigned body to a signed input by forgetting the field.
- Modify: `apps/web/src/server/relay/__tests__/ingest-cf.test.ts:1144-1148`. The pin that `recording: LIVE_INPUT_RECORDING` appears exactly twice becomes: `recording: liveInputRecording(` appears exactly twice (create and PUT), `liveInputRecording`'s body spreads `LIVE_INPUT_RECORDING`, and the one-`mode:`-literal assertion is unchanged.
- Test: `relay/domain/__tests__/session.test.ts`, `relay/__tests__/ingest-cf.test.ts`, `relay/__tests__/fakes.test.ts`, `usecases/__tests__/stream-sessions.seazn.test.ts`

**Interfaces — Produces:**

- `liveInputRecording(access?: IngestCreateSpec["access"]): typeof LIVE_INPUT_RECORDING & { requireSignedURLs?: true; allowedOrigins?: string[] }`, exported from `ingest-cf.ts`.
- `seaznAccess(): { signed: true; allowedOrigins: string[] }`, in `destination.ts`. It throws if the origins are null; admission has already refused that case.

- [ ] **Step 1: Write the failing tests.**
  - Domain: `decide(provisioned)` on a Seazn session gives `effects: []`, and on an external one gives `[{type:"add_output"}]`. Sweep both modes × both destinations.
  - ingest-cf, using the existing mocked-fetch harness:
    - the programme create body for Seazn carries `recording.requireSignedURLs === true` and `allowedOrigins === ["seazn.club"]`;
    - the camera create body carries neither;
    - an echo missing `requireSignedURLs` throws `/settings were not applied/`;
    - `setInputEnabled(…, { access })` re-sends both;
    - `setInputEnabled(…, { role: "programme" })` with no `access` key throws before any fetch.
  - Usecase:
    - a Seazn session reaches `live` on the fake with `output_uid` null and no `add_output` row in `stream_provider_calls`;
    - a `target_rejected` never fires across ten ticks (the tick's existing `outputState` read on the programme input answers with no output, which decides nothing; no tick change is made);
    - `fixture_stream_inputs.access` is set on the programme row and null on the camera row, and no statement in `src/server` updates it (grep test).
  - Regression: an external composed session still adds exactly one output on the programme input.
- [ ] **Step 2: Run them and see them fail.** `cd apps/web && npx vitest run src/server/relay/domain/__tests__/session.test.ts src/server/relay/__tests__/ingest-cf.test.ts src/server/relay/__tests__/fakes.test.ts src/server/usecases/__tests__/stream-sessions.seazn.test.ts --reporter=json --outputFile=$SCRATCH/t12.json`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the Step 2 command again.** Expect PASS. Run `runner.test.ts` and `port-boundary.test.ts` scoped. Mutate the `provisioned` branch, and the domain test fails.
- [ ] **Step 5: Commit** `feat(stream): Seazn sessions publish to a signed programme input with no output`.

### Task 13: Sign Cloudflare playback

**Files:**

- Create: `apps/web/src/server/video/cf-playback.ts`
- Test: `apps/web/src/server/video/__tests__/cf-playback.test.ts`

**Interfaces — Produces:**

- `signLivePlayback(inputUid: string, now: Date): Promise<{ src: string; expiresAt: string }>`. Its claims are `{ sub: inputUid, kid, exp: now + SEAZN_LIVE_TOKEN_TTL_SECONDS, nbf: now - 30 }`, signed RS256 with `jose` `SignJWT`. `src` is `https://${streamPlaybackHost()}/${token}/manifest/video.m3u8`. Under the fake driver, `src` is `https://playback.fake.invalid/${token}/manifest/video.m3u8`.
- `signDownload(videoUid: string, now: Date, ttlSeconds: number): Promise<string>` for Phase 2. It adds `downloadable: true` and returns `https://<host>/<token>/downloads/default.mp4`.

  Plan decision: self-sign with a key from `POST /stream/keys`, held in env, rather than call `/stream/{uid}/token` per viewer. It costs no API call per page view and no rate-limit exposure.

- [ ] **Step 1: Write the failing tests.**
  - Verify the token with the matching public key: `sub`, `kid`, `exp - iat === 3600`.
  - The URL holds no `?` (the token is a path segment, never a query).
  - The error message for a missing key does not contain the PEM (assert that no substring of the PEM appears in `String(err)`).
- [ ] **Step 2: Run them and see them fail.** `cd apps/web && npx vitest run src/server/video/__tests__/cf-playback.test.ts --reporter=json --outputFile=$SCRATCH/t13.json`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the Step 2 command again.** Expect PASS.
- [ ] **Step 5: Commit** `feat(stream): signed Cloudflare playback URLs`.

### Task 14: Public video read and route

**Files:**

- Create: `apps/web/src/server/video/seazn-video.ts`
- Create: `apps/web/src/app/api/v1/public/fixtures/[id]/video/route.ts`, modelled on `realtime-token/route.ts` (`publicRateLimit`, `v1`, `reply`)
- Modify: `apps/web/src/server/api-v1/schemas/` (the public resource group; add `PublicFixtureVideo`) and the openapi registration
- Test: `apps/web/src/server/video/__tests__/seazn-video.test.ts`, `apps/web/src/app/api/v1/public/fixtures/[id]/video/route.test.ts`

**Interfaces — Produces:**

- `type PublicFixtureVideo = { live: { src: string; expiresAt: string } | null; replay: { partNo: number; src: string; expiresAt: string }[] }`. `replay` stays `[]` until Task 25.
- `seaznFixtureVideo(fixtureId: string, now: Date): Promise<PublicFixtureVideo>`. The fixture must be readable through `public_fixtures_v`, the same redaction `replayParts` relies on (`server/youtube/parts.ts:38`); if not, it returns `{live:null, replay:[]}`. `live` is set only when the fixture's latest session has `destination_kind = 'seazn'` and `state = 'live'`; `src` is signed for its programme input uid (`readFirstInput(tx, sid, "programme")`). The LIVE flag is not read here: a Seazn session that exists keeps playing (controller ruling).
- `seaznFixtureVideoForOrg(orgId, fixtureId, now)`: the same answer, org-scoped, for Match Day and the organiser panel. It covers private competitions (spec G5).
- `GET /api/v1/public/fixtures/{id}/video` returns 200 `PublicFixtureVideo` with `Cache-Control: private, no-store`, so a signed URL is never cached at the edge.

- [ ] **Step 1: Write the failing tests.**
  - A Seazn live session gives `live.src` matching `/^https:\/\/playback\.fake\.invalid\/[^/?]+\/manifest\/video\.m3u8$/`.
  - Each of these gives `live: null`: state `warming`, `ending` or `completed`; a YouTube session; a private competition through the public read. The org read of the private one is set.
  - The route answers `no-store` and hits the rate limit like its sibling.
  - LIVE off still gives `live.src` for a Seazn session that is live (the controller ruling).
- [ ] **Step 2: Run them and see them fail.** `cd apps/web && npx vitest run src/server/video/__tests__/seazn-video.test.ts "src/app/api/v1/public/fixtures/[id]/video" --reporter=json --outputFile=$SCRATCH/t14.json`.
- [ ] **Step 3: Implement.** Then run `npm run openapi:gen`.
- [ ] **Step 4: Run the Step 2 command again.** Expect PASS.
- [ ] **Step 5: Commit** `feat(stream): public Seazn video read`.

### Task 15: Seazn player on the public match page

**Files:**

- Modify: `apps/web/package.json`: add `hls.js`, pinned to the exact current version (`npm view hls.js version`, no caret).
- Create: `apps/web/src/components/public-site/match-centre/seazn-player.tsx` (client: hls.js with `enableWorker: false`, and native HLS when `video.canPlayType("application/vnd.apple.mpegurl")`)
- Create: `apps/web/src/components/public-site/match-centre/seazn-video-island.tsx` (client: fetches the Task 14 route)
- Create: `apps/web/src/components/public-site/match-centre/seazn-video-schedule.ts` (pure: when to fetch next)
- Modify: `apps/web/src/app/(public)/live/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/page.tsx:265,472`. When `seaznVideoPlan(fixtureId)` answers `"seazn"`, the page mounts `<SeaznVideoIsland fixtureId>` in the `replay` slot instead of `<ReplayEmbed>`. Every other fixture keeps today's slot byte for byte (spec §5.1).
- Create: `apps/web/src/server/video/seazn-video-plan.ts`: `seaznVideoPlan(fixtureId: string): Promise<"seazn" | "external">`, decided from the fixture's OWN facts, never from `fixtureStreamTarget` (`stream-codes.ts:496-509` answers `{id,label,source}` with no kind):
  - any session of the fixture with `destination_kind = 'seazn'` → `seazn`, **whatever LIVE is** (controller ruling: LIVE off stops new Seazn streams only). Phase 1 reads `fixture_stream_sessions` alone; the replay-rows arm is added in Task 25, once V541 exists;
  - any other session, or the fixture decided → `external`;
  - no session at all and not decided → `seazn` only when LIVE is on and the fixture's resolved target row has `kind = 'seazn'` (saved, or the org's default). The island then renders nothing until the route answers live. With LIVE off this arm answers `external`.

  Plan decision: the last arm is the one use of the default pick, and only for a fixture that has never streamed and is not over. A viewer who opens the page before kick-off still gets the player at live without reloading (Review Focus 3), and a past YouTube fixture with no saved choice can never flip, because it has sessions.

- Modify: `apps/web/src/proxy.ts:91`: `connect-src` and a new `media-src 'self' blob:` add `https://${streamPlaybackHost()}` (and in Phase 2 the Bunny CDN host).
- Modify: `src/dictionaries/{en,es,fr,nl}/public.json`: keys `seaznVideo.live` ("Live"), `seaznVideo.unavailable` ("The video can't play right now"), `seaznVideo.part` ("Part {n}").
- Test: `components/public-site/match-centre/__tests__/seazn-video-schedule.test.ts`, `components/public-site/match-centre/__tests__/seazn-video-island.test.tsx` (SSR markup), `app/(public)/.../fixtures/[fixtureId]/__tests__/page.test.ts`, `apps/web/e2e/public-fixture.spec.ts`, `apps/web/e2e/mobile/public-pages.spec.ts`

**Interfaces — Produces:**

- `nextVideoFetchMs(video: PublicFixtureVideo | null, now: Date): number`:
  - not live and no replay: `30_000`;
  - live: `expiresAt - now - SEAZN_TOKEN_REFRESH_BEFORE_SECONDS*1000`, floored at `30_000`;
  - replay: the earliest part's expiry minus 5 min.
- `<SeaznVideoIsland fixtureId={string} endpoint?: "public" | "org" />`. The default `public` reads `/api/v1/public/fixtures/{id}/video`; `org` reads `/api/v1/fixtures/{id}/video` (Task 17).
- `<SeaznPlayer src={string} title={string} />`. It keeps one `<video>` across `src` changes for the same session, and swaps the source at the current time, so a refreshed token does not restart the picture.
- Plan decision: the player loads through a client island rather than with tokens minted in the server render. The page is ISR (`revalidate = 30`, `page.tsx:174`), and a token baked into cached HTML would be served past its expiry. The island also catches warming turning to live without a reload.

- [ ] **Step 1: Write the failing tests.**
  - Schedule: `null` gives 30 000. Live with an expiry 60 min away gives 55 min (Review Focus 3). Live with an expiry 2 min away gives 30 000.
  - Page: a YouTube fixture renders `ReplayEmbed` and no `data-testid="seazn-video"`. A Seazn fixture renders the island and no YouTube markup (anchor the assertion on `="`).
  - `seaznVideoPlan` with LIVE off: a fixture with an ended Seazn session answers `seazn`, and the page renders the island, never `ReplayEmbed` (the ruling). An unstarted fixture whose default would be Seazn answers `external`.
  - `seaznVideoPlan` with LIVE on: a past YouTube fixture with no saved choice (its org's default now resolves Seazn) answers `external`, and the page renders `ReplayEmbed` with its parts (the blocker regression). An unstarted fixture whose default is Seazn answers `seazn`. A fixture with one Seazn session answers `seazn` even after the org's default changes.
  - Player: rendering `<SeaznPlayer>` with `src` A then `src` B (a token refresh) keeps the same `<video>` element instance (same node; a ref counter of mounts stays at 1), and hls.js `loadSource` is called with B without `destroy()` (spy on a mocked hls.js).
  - e2e, fake driver: pick Seazn and Go live → the public page shows `[data-testid=seazn-player] video` with a `src` or `data-src` on the fake host, with no reload between warming and live. At 320, 768 and 1280: no horizontal scroll.
- [ ] **Step 2: Run them and see them fail.** `cd apps/web && npx vitest run src/components/public-site/match-centre/__tests__/seazn-video-schedule.test.ts src/components/public-site/match-centre/__tests__/seazn-video-island.test.tsx "src/app/(public)/live" --reporter=json --outputFile=$SCRATCH/t15.json`; `npx playwright test e2e/public-fixture.spec.ts e2e/mobile/public-pages.spec.ts` (whole files).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run both commands again.** Expect PASS. Take screenshots at the three widths and open each one.
- [ ] **Step 5: Commit** `feat(stream): Seazn live player on the match page`.

### Task 16: Organiser picker — Seazn first and pre-selected

**Files:**

- Modify: `apps/web/src/components/v2/fixture-destination-picker.tsx:47` (a `seazn` option: Seazn mark, label `stream.dest.kind.seazn`, a one-line sub "Plays on this match's page")
- Modify: `apps/web/src/components/v2/stream-platform-mark.tsx` (a Seazn mark)
- Modify: `apps/web/src/components/v2/stream-destinations-panel.tsx` (the Seazn row shows with no Rename, Replace key or Remove)
- Modify: `apps/web/src/components/v2/fixture-stream-panel.tsx`. Phase 0's pre-Go-live warning (Task 4) already sits in `onGoLive` (`:1154`) behind `needsChannelCheck(target)` (true only for a target with a YouTube connection). The Seazn row has `youtube: null`, so it must never fetch the safety route or show the notice: build on that predicate, never beside it. (No other logic change expected: `serverPick` comes from `fixtureStreamTarget`, which Task 10 already answers with Seazn; verify. The 2,805-line file is not split in this plan.)
- Modify: `src/dictionaries/{en,es,fr,nl}/ui.json`: `stream.dest.kind.seazn` ("Seazn"), `stream.dest.seazn.sub` ("Plays on this match's page"), `streamDest.error.seaznFixed` ("Seazn is always available and can't be changed"), `stream.refusal.seazn_unavailable`, `stream.refusal.seazn_video_unconfigured`
- Test: `components/v2/__tests__/fixture-destination-picker.test.tsx`, `components/v2/__tests__/stream-destinations-panel.test.tsx`, `components/v2/__tests__/fixture-stream-panel.safety.test.tsx` (Task 4's file, extended), `e2e/streaming-destinations.spec.ts` (`e2e/walkthrough/`), `e2e/mobile/` (the stream-panel area file)

- [ ] **Step 1: Write the failing tests.**
  - The picker lists Seazn first and checked for a fixture with no pick.
  - Picking a pasted key and reloading keeps the pasted key (the server answer).
  - The destinations panel row for Seazn has no `button[name=Remove]`.
  - The `nl` render shows the Dutch strings.
  - Phase 0 warning stays YouTube-only (Review Focus 9), in `fixture-stream-panel.safety.test.tsx` (Task 4's file): with Seazn picked on an org whose YouTube connection would warn (fake safety route answers `warn: true`), Go live makes zero requests to `/youtube-connections/*/safety`, renders no channel-safety notice, and POSTs `stream-sessions` with the Seazn `targetId` on the first tap. The same panel with the YouTube connection target picked shows the notice (the control). `needsChannelCheck` answers false for a `kind: "seazn"` target.
  - e2e: a new org's match panel shows Seazn selected, and Go live starts a session with `destination_kind = 'seazn'`.
- [ ] **Step 2: Run them and see them fail.** Run vitest on the three component tests; run `npx playwright test e2e/walkthrough/streaming-destinations.spec.ts e2e/mobile/` on whole files.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run both again.** Expect PASS. Take screenshots at 320, 768 and 1280.
- [ ] **Step 5: Commit** `feat(stream): Seazn is the preferred destination in the match panel`.

### Task 17: Match Day plays the Seazn live

**Files:**

- Modify: `apps/web/src/lib/match-day/types.ts:83-86` and `apps/web/src/server/api-v1/schemas/fixtures.ts:154`: `live_video` keeps its YouTube shape untouched; a separate `live_seazn: boolean` is added beside it (true while the match's open session is a live Seazn session). The URL is not in the polled board. The preview fetches it through the org-scoped read below, so a polled board never carries a token.
- Modify: `apps/web/src/server/usecases/match-day.ts:845-866` (sets `live_seazn`)
- Create: `apps/web/src/app/api/v1/fixtures/[id]/video/route.ts` (organiser auth; `seaznFixtureVideoForOrg`)
- Modify: `apps/web/src/components/v2/match-day/court-stream-preview.tsx` (`live_seazn` renders `<SeaznVideoIsland fixtureId endpoint="org" />`, with the score line under the picture as today)
- Modify: the `streamPreviewOf` caller and `match-day/view` where `live_video.url` is read
- Test: `components/v2/match-day/__tests__/match-day-ssr.test.tsx`, `server/usecases/__tests__/match-day*.test.ts` (the file covering `live_video`), `e2e/match-day.spec.ts`, `e2e/mobile/match-surfaces.spec.ts`

- [ ] **Step 1: Write the failing tests.**
  - A Seazn live match on a playing court gives `live_seazn: true` and `live_video: null`, and the board JSON contains no `playback.fake.invalid`.
  - A YouTube one is unchanged.
  - e2e: a Match Day court with a live Seazn match shows `[data-testid=seazn-player]`. At 320 there is no horizontal scroll.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** Then run `npm run openapi:gen`.
- [ ] **Step 4: Run them again.** Expect PASS.
- [ ] **Step 5: Commit** `feat(match-day): Seazn live preview`.

### Task 18: Sweep hold for Seazn recordings (ships with Phase 1)

Controller ruling (2026-11-20): every `destination_kind = 'seazn'` recording is held past 3 days **regardless of `SEAZN_HOSTED_REPLAY`**, so Phase 1 never loses a replay that Phase 2 will later move. Cloudflare's 30-day `deleteRecordingAfterDays` stays the backstop.

**Files:**

- Modify: `apps/web/src/server/usecases/relay-sweep.ts:507-560` (step 4, RETENTION)
- Modify: `SweepResult` (`:49`): add `seaznHeld: number` and `seaznHeldPastPromise: number`
- Test: `apps/web/src/server/usecases/__tests__/relay-sweep.test.ts` (new describe), `lib/__tests__/relay-sweep-workflow.test.ts` if it pins the result keys

**Interfaces:**

- `retentionPlan` stays pure and unchanged.
- The sweep removes from `ownedVideos` every video whose `inputId` is the programme input of a session with `destination_kind = 'seazn'`, whatever the flags. Their deletion is the mover's (Task 24) once Bunny has a playable copy, or Cloudflare's own at 30 days. Inputs that still name a held video are deferred by the existing rule (`:552-555`).
- For each held video older than `RECORDING_RETENTION_DAYS` with no `seazn_held_alerts` row and no `playable` replay: one `captureError(new Error("relay sweep: a Seazn recording past 3 days has not reached Bunny"), { route: "relay.sweep.seazn_held", extra: { sessionId, cfVideoId } })`, then an insert into `seazn_held_alerts` (V540). That is one alert per recording, ever, with or without a replay row.
- Held recordings count against the Cloudflare storage block. Admission and the sweep already read live usage (`storageHeadroomMinutes`), so a full block refuses new starts by the existing rule; nothing new is added for it.

- [ ] **Step 1: Write the failing tests.**
  - REPLAY off, LIVE on: a 4-day-old Seazn programme video is not deleted, its input is not deleted, `seaznHeld 1`, `captureError` is called once, and a second pass makes no second call (the ruling).
  - The same with REPLAY on and no replay row: also held.
  - A 4-day-old YouTube programme video: deleted (the regression).
  - A camera recording of a Seazn session is still deleted at the end of the session (step 2, `:349-362`, unchanged).
- [ ] **Step 2: Run them and see them fail.** `cd apps/web && npx vitest run src/server/usecases/__tests__/relay-sweep.test.ts --reporter=json --outputFile=$SCRATCH/t18.json`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the Step 2 command again.** Expect PASS. Mutate the hold filter by removing the destination predicate, and the YouTube test fails.
- [ ] **Step 5: Commit** `feat(stream): the sweep holds Seazn recordings past 3 days`.

### Task 19: Phase 1 smoke and walkthrough

**Files:**

- Create: `scripts/smoke/suites/seaznHosted.ts`, registered as `streamTargets.ts` is. It covers the Seazn row present and first, the start refused while LIVE is off, and the public video route `no-store`.
- Create: `apps/web/e2e/walkthrough/seazn-hosted.spec.ts`. On the fake driver, organiser and spectator: Seazn pre-selected → Go live → the spectator sees the player → Stop → the player goes and the page shows its ended state. The database has 0 `youtube_broadcasts` rows and 0 `add_output` provider calls for the fixture.

- [ ] **Step 1: Write both.**
- [ ] **Step 2: Run them.** `npx playwright test e2e/walkthrough/seazn-hosted.spec.ts`, and the smoke suite by its runner. Expect PASS.
- [ ] **Step 3: Run the scoped regression.** Run every vitest path from Tasks 8–18 in one JSON run, check that `numTotalTests` equals the per-task sum, then `npx playwright test e2e/walkthrough/stream-relay.spec.ts e2e/walkthrough/streaming-destinations.spec.ts` on whole files.
- [ ] **Step 4: Commit** `test(stream): Seazn live smoke and walkthrough`.

---

# Phase 2 — Replay on Bunny (`SEAZN_HOSTED_REPLAY`)

### Task 20: Probe Bunny Stream

The docs (checked 2026-11-20) show that `POST /library/{id}/videos/fetch` returns only `{success,message,statusCode}`, not the new guid. They do not show the Create Collection endpoint, and they do not confirm that CDN token authentication covers the Stream delivery host.

**Files:**

- Create: `apps/web/src/server/video/__tests__/bunny.live.test.ts`, gated by `BUNNY_LIVE_PROBE=1`
- Modify: `docs/superpowers/specs/2026-11-20-seazn-hosted-probes.md`

- [ ] **Step 1: Write the probe.**
  - `POST /library/{lib}/collections {name}` returns a `guid`.
  - Fetch a public test MP4 with `title = "probe:<uuid>"` and `collectionId`.
  - `GET /library/{lib}/videos?search=probe:<uuid>&collection=<guid>` finds exactly one item. Poll `GET /videos/{guid}` until `status === 4`.
  - The HLS playlist at `https://{BUNNY_CDN_HOST}/{guid}/playlist.m3u8` gives 403 unsigned and 200 with a directory token (`token_path=/{guid}/`). One segment URL from that playlist also gives 200.
  - The fetch is repeated with a Cloudflare signed `downloads/default.mp4` URL from Task 7's account.
  - `DELETE /videos/{guid}` answers 200.
- [ ] **Step 2: Run it and record each result.** If the search cannot find the fetched video, raise it before Task 22. The fallback recorded in the doc: create the video (`POST /videos` returns a guid) and stream the Cloudflare MP4 through the server with `PUT /videos/{guid}`.
- [ ] **Step 3: Commit** `test(stream): live probe for Bunny Stream`.

### Task 21: The `ReplayHost` port, its fake and config

**Files:**

- Create: `apps/web/src/server/video/replay-ports.ts`
- Create: `apps/web/src/server/video/replay-fake.ts`
- Create: `apps/web/src/server/video/replay-driver.ts`
- Modify: `apps/web/src/server/relay/config.ts`. It reads `REPLAY_DRIVER` (`fake` | `bunny`, where unset under the fake relay driver is `fake`), `BUNNY_STREAM_LIBRARY_ID`, `BUNNY_STREAM_API_KEY`, `BUNNY_CDN_HOST` and `BUNNY_TOKEN_KEY`. `bunnyConfig()` throws naming the missing variable and never echoes a value.
- Modify: `apps/web/src/server/usecases/stream-sessions/deps.ts` (`SessionDeps` gains `replay?: ReplayHost`, like `youtube?`)
- Test: `apps/web/src/server/video/__tests__/replay-fake.test.ts`, `relay/__tests__/config.test.ts`

**Interfaces — Produces:**

```ts
export type ReplayState = "processing" | "playable" | "failed" | "absent";
export interface ReplayHost {
  ensureCollection(orgId: string): Promise<string>; // collection id; idempotent by name `org:<orgId>`
  fetchFromUrl(a: {
    collectionId: string;
    title: string;
    url: string;
  }): Promise<void>;
  findByTitle(collectionId: string, title: string): Promise<string[]>; // guids with exactly this title, oldest first
  state(
    videoId: string,
  ): Promise<{ state: ReplayState; lengthSeconds: number | null }>;
  remove(videoId: string): Promise<"deleted" | "absent">;
  signedPlaylist(videoId: string, now: Date, ttlSeconds: number): string; // pure, no call
  signedDownload(videoId: string, now: Date, ttlSeconds: number): string; // pure; the MP4 fallback file, same token scheme
  watchMinutes(videoId: string, from: Date, to: Date): Promise<number>; // Phase 3
}
```

- Bunny `status` maps as follows: 4 → `playable`; 5 and 6 → `failed`; 0–3, 7 and 8 → `processing`; 404 → `absent`.
- `REPLAY_TOKEN_TTL_SECONDS = 3600`.
- Plan decision: one Bunny collection per org, named `org:<orgId>`, with its id cached in `org_video_collections` (Task 23). The spec recommends it, and it makes an org's replays listable and deletable as a set.
- Plan decision: the Bunny keys are env secrets read through `config.ts`, like the Cloudflare token. They are never stored in the database.

- [ ] **Step 1: Write the failing tests.**
  - The fake's `fetchFromUrl` then `findByTitle` returns one guid; two fetches of one title return two, oldest first.
  - The state machine is `processing` → `playable` after `fake.advance(guid)`, and `fake.fail(guid)` gives `failed`.
  - A repeated `ensureCollection` returns the same id.
  - `bunnyConfig({})` throws `/BUNNY_STREAM_API_KEY/`, and the message contains no value.
- [ ] **Step 2: Run them and see them fail.** `cd apps/web && npx vitest run src/server/video/__tests__/replay-fake.test.ts src/server/relay/__tests__/config.test.ts --reporter=json --outputFile=$SCRATCH/t21.json`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the Step 2 command again.** Expect PASS. Extend `port-boundary.test.ts`: `replay-ports.ts` names no Bunny vocabulary.
- [ ] **Step 5: Commit** `feat(stream): ReplayHost port and fake`.

### Task 22: The Bunny adapter

**Files:**

- Create: `apps/web/src/server/video/replay-bunny.ts`
- Test: `apps/web/src/server/video/__tests__/replay-bunny.test.ts` (mocked fetch, like `ingest-cf.test.ts`)

**Interfaces:**

- Consumes: the `ReplayHost` port (Task 21) and `bunnyConfig()`.
- Produces: `class BunnyReplayHost implements ReplayHost`.
  - Base URL `https://video.bunnycdn.com/library/{libraryId}`, with the `AccessKey` header.
  - `signedPlaylist` returns `https://{cdnHost}/bcdn_token={token}&expires={exp}&token_path=%2F{guid}%2F/{guid}/playlist.m3u8`, with `token = base64url(HMAC-SHA256(BUNNY_TOKEN_KEY, "/{guid}/" + exp))`. That is the formula from `bunny.net/docs/cdn-token-authentication`; Task 20's probe confirms it, and the probe's result wins if they differ.
  - Each call is recorded through the same redaction floor as `ingest-cf.ts` (`sanitise.ts`), so the AccessKey is never written.
  - The `fetchFromUrl` body's `url` is a signed Cloudflare download (its token is a path segment). Before the call is recorded in `stream_provider_calls`, the token segment is replaced by `[signed]`, and the `title` is kept.

- [ ] **Step 1: Write the failing tests.**
  - `fetchFromUrl` POSTs `/videos/fetch?collectionId=c1` with body `{url,title}`.
  - `state` maps 4, 5, 3 and 404 as Task 21 states.
  - `findByTitle` sends `search=` and returns the exact title match only, ignoring a prefix match.
  - The `AccessKey` value is absent from every thrown message and from every recorder payload.
  - The recorded `fetchFromUrl` payload holds `https://<host>/[signed]/downloads/default.mp4` and no substring of the token passed in; a thrown fetch error holds no token either.
  - `signedPlaylist` matches a vector computed by hand in the test from the documented formula.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expect PASS.
- [ ] **Step 5: Commit** `feat(stream): Bunny Stream adapter`.

### Task 23: Migration V541 — replays

**Files:**

- Create: `db/migration/deltas/V541__seazn_replays.sql`
- Test: `apps/web/src/server/relay/__tests__/seazn-replays-migration.test.ts`

**DDL:**

- `org_video_collections (org_id uuid primary key references organizations(id) on delete restrict, collection_id text not null, created_at timestamptz not null default now())`.
- `fixture_video_replays`:
  - `id uuid pk`;
  - `org_id uuid not null references organizations(id) on delete restrict`;
  - `session_id uuid not null references fixture_stream_sessions(id) on delete restrict`;
  - `fixture_id uuid null references fixtures(id) on delete set null`;
  - `cf_video_id text not null unique`, `recorded_at timestamptz not null`;
  - `part_no int not null`, assigned once at discovery (the fixture's highest `part_no` + 1, in `recorded_at` order within a batch) and never changed, with `unique (fixture_id, part_no)`. A part keeps its number whatever becomes playable first;
  - `state text not null check (state in ('found','downloading','fetching','encoding','playable','failed','deleted'))`, `state_at timestamptz not null default now()` (moved by every state write);
  - `bunny_video_id text null`, `length_seconds int null`;
  - `attempts int not null default 0`, `next_attempt_at timestamptz not null default now()`;
  - `cf_deleted_at timestamptz null`, `playable_at timestamptz null`, `bunny_cleaned_at timestamptz null` (a deleted row whose Bunny copies have all been removed);
  - `deleted_at timestamptz null`, `deleted_by uuid null`, `deleted_reason text null check (deleted_reason in ('organiser','org_deleted'))`;
  - `created_at timestamptz not null default now()`.
- Index on `(state, next_attempt_at)` where `state not in ('playable','deleted')`. Index on `(fixture_id, recorded_at)`.
- Check: `bunny_video_id is not null or state in ('found','downloading','fetching','failed','deleted')`.
- `fixture_stream_inputs` gains `replays_discovered_at timestamptz null`: discovery's mark that it has listed this programme input's finished recordings for good.
- RLS on both tables follows V430: enable + force, no policy, no grant.
- View `public_fixture_seazn_replays_v (fixture_id, part_no, bunny_video_id)`. It keeps `state = 'playable'` rows with their stored `part_no` (gaps allowed while a part is still processing), under the same WHERE redaction as `public_fixture_youtube_parts_v`. Not granted to `app_user`.

  Plan decision: `on delete restrict` on `org_id`. No product path hard-deletes an organisation (`extra-orgs.ts:301`), and a cascade would drop the Bunny ids that Task 30 needs to delete the videos.

- [ ] **Step 1: Write the failing tests.**
  - A replay row with `state 'playable'` and no `bunny_video_id` fails 23514.
  - A duplicate `cf_video_id` fails 23505.
  - Deleting an org with a replay fails 23503.
  - The view shows two playable rows as parts 1 and 2; with part 1 still `encoding`, part 2 shows as 2 (not renumbered to 1); a private competition has no row.
  - A second row with the same `(fixture_id, part_no)` fails 23505.
  - `rls-static.test.ts` lists both tables.
- [ ] **Step 2: Run them, write V541 and apply it locally, then run them again.** Expect FAIL first, then PASS.
- [ ] **Step 3: Commit** `feat(db): V541 Seazn replays`.

### Task 24: Move recordings to Bunny

**Files:**

- Create: `apps/web/src/server/video/domain/replay-move.ts` (pure: the next step for a row)
- Create: `apps/web/src/server/usecases/seazn-replays.ts` (`discoverSeaznRecordings`, `moveSeaznRecordings`)
- Modify: `apps/web/src/server/relay/ports.ts`, `ingest-cf.ts` and `fakes.ts`: `IngestProvider` gains `createDownload(videoId): Promise<"ready" | "inprogress">` (`POST /stream/{uid}/downloads`, then read `default.status`; idempotent). The download goes with the video when `deleteVideo` runs.
- Modify: `apps/web/src/app/api/cron/stream-tick/route.ts`, adding a third pass `seazn` after the session pass. It never throws and answers `{ discovered, moved, playable, failed, deferred }`.
- Modify: `apps/cron-worker/src/schedule.ts:172`: `failureCounts` gains `"data.seazn.failed"`; extend `drift.test.ts` so it finds the field.

  Plan decision: the pass runs INSIDE the tick's existing 45 s (`STREAM_TICK_BUDGET_MS`, `tick.ts:202`), never after it. It gets `min(SEAZN_MOVE_BUDGET_MS = 8_000, what is left of the 45 s)` and starts no provider call with under 2 s left, so the whole firing still stops starting work at 45 s, inside the Worker's 60 s. When the session pass uses the whole budget, the seazn pass defers to the next minute (`deferred`).

- Test: `video/domain/__tests__/replay-move.test.ts`, `usecases/__tests__/seazn-replays.test.ts`, `app/api/cron/stream-tick/route.test.ts`

**Interfaces — Produces:**

- `nextReplayStep(row: ReplayRow, now: Date): ReplayStep`, a transition table:
  - `found` → `create_download`;
  - `downloading`: `create_download` again until `ready`, then `fetch`;
  - `fetching` → `find_guid`, and `encoding` once found. A `fetching` row whose `state_at` is older than `SEAZN_FETCH_STALE_MINUTES = 120` with no guid found goes back to `downloading`, and the fetch is sent again.

    Plan decision: 120 min is well above a 3 h 1080p MP4 fetch-and-ingest, and short enough that a lost fetch costs one retry within the day;

  - `encoding` → `poll_state` (`playable` sets `playable_at`, `failed` sets state `failed`);
  - `playable` with `cf_deleted_at` null → `delete_cf`;
  - `deleted` with `bunny_cleaned_at` null → `cleanup`: `findByTitle` and `remove` every match (a fetch in flight when the organiser deleted can land later), delete the Cloudflare copy if still there, then set `bunny_cleaned_at`. It repeats until a `findByTitle` after `SEAZN_FETCH_STALE_MINUTES` past `deleted_at` finds none.
  - A failure sets `attempts+1` and `next_attempt_at = now + min(2^attempts, 60) minutes`.
  - `failed` retries from `found` while `now - recorded_at < 30 days`.
- `discoverSeaznRecordings(deps, now)`: for each programme input of a Seazn session that ended more than `FINALISATION_GRACE_SECONDS` ago and whose `replays_discovered_at` is null, calls `listInputVideos(programme)` and inserts a `found` row per video (`on conflict (cf_video_id) do nothing`, `part_no` assigned as V541 says). When every listed video is finished (`inProgress === false`), it sets `replays_discovered_at`, and the input is never listed again.
- `moveSeaznRecordings(deps, { now, budgetMs })`. Concurrency and idempotency rules:
  - Rows are claimed in a short transaction, `select … where next_attempt_at <= now and state not in ('playable') … for update skip locked limit 10` (plus deleted rows awaiting cleanup), so two overlapping ticks never take one row.
  - The next state is written and committed BEFORE the provider call (`found → downloading`, `downloading → fetching` before `fetchFromUrl`), so a crash after the call is resumed by `find_guid` or the stale timeout, never by a blind second fetch.
  - Every state update is conditional: `update … set state = $next, state_at = now() where id = $id and state = $expected`. Zero rows updated means another actor moved it (an organiser delete), and the pass drops the row.
  - `findByTitle` returning more than one guid (a re-fetch raced the first) keeps the earliest and `remove`s the rest. The port's `findByTitle` returns `string[]` for this.
  - The Bunny title is `seazn:{sessionId}:{cfVideoId}`. The fetch URL is `signDownload(cfVideoId, now, 6*3600)` (Task 13). `deleteVideo` on Cloudflare runs only from `playable`; `in_progress` leaves `cf_deleted_at` null for the next tick.
- Plan decision: run from the stream tick (prod every minute) rather than from `persist.ts` or the daily sweep. `persist` runs inside the session's row transaction, where provider calls do not belong, and a daily pass would hold every recording on Cloudflare for up to a day for no reason. The tick already has the budget and failure-counter pattern (`endYoutube`).
- Plan decision: Bunny fetches Cloudflare's MP4 download through a signed `downloadable` token. Bunny fetches a file, not an HLS playlist, and the recording is signed (Task 12). Task 20's probe confirms that Bunny accepts the URL.

- [ ] **Step 1: Write the failing tests.**
  - Table sweep: every state × {success, provider throws} gives the expected step or backoff. The sweep reports how many cases it checked, and zero fails.
  - Usecase on the fakes:
    - a stopped and restarted Seazn match (two sessions) yields two rows ordered by `recorded_at` (Review Focus 4);
    - with `fake.fail(guid)`, the Cloudflare video is never deleted and `attempts` grows with backoff (Review Focus 5);
    - `deleteVideo` is never called before `playable`. Assert the call order: `deleteVideo` index > `state→playable` index;
    - REPLAY off gives zero discover and zero move calls;
    - overlap: two `moveSeaznRecordings` runs started together on one `found` row make exactly one `createDownload` and one `fetchFromUrl` call;
    - crash-resume: a throw injected after `fetchFromUrl` leaves the row `fetching`; the next run finds the guid and moves to `encoding` with no second fetch. With the fetch lost (fake drops it), the row goes back to `downloading` only after 120 min (assert at 119 and at 121);
    - duplicate guids: `findByTitle` answering two guids keeps the earlier and removes the other;
    - delete during fetch: an organiser delete lands while the row is `fetching`; the mover's conditional update hits zero rows, and the cleanup step later removes the guid the fetch produced and the Cloudflare copy, then sets `bunny_cleaned_at`;
    - an input with `replays_discovered_at` set is never listed again (zero `listInputVideos` calls on the second run);
    - a YouTube session's recordings are never discovered.
  - Route: the answer carries `seazn` counters, and a throwing pass answers `seazn.failed: 1` while the session pass still runs.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expect PASS. Mutate the `playable` guard on `delete_cf`, and the order test fails.
- [ ] **Step 5: Commit** `feat(stream): move Seazn recordings to Bunny`.

### Task 25: Replay on the match page and in the panel

**Files:**

- Modify: `apps/web/src/server/video/seazn-video.ts` (`replay` is filled from `public_fixture_seazn_replays_v`, each part's `src` from `signedPlaylist`; the org read reads the table). The REPLAY flag gates moving, not playing: a playable replay plays whatever LIVE or REPLAY is.
- Modify: `apps/web/src/server/video/seazn-video-plan.ts` (Task 15): add the arm "any non-deleted `fixture_video_replays` row → `seazn`", flag-independent like the session arm.
- Modify: `seazn-video-island.tsx` (with no live and a non-empty replay, it renders the parts in `partNo` order, "Part 1", "Part 2" when there are two or more, one `<SeaznPlayer>` at a time, the same part picker shape as `ReplayEmbed`'s)
- Modify: `apps/web/src/proxy.ts` (add `https://${BUNNY_CDN_HOST}` to `connect-src` and `media-src`)
- Create: `apps/web/src/server/video/organiser-replays.ts`: `fixtureSeaznReplays(orgId, fixtureId): Promise<{ id: string; partNo: number; state: "processing" | "playable" | "failed"; lengthSeconds: number | null }[]>`
- Modify: `apps/web/src/components/v2/fixture-stream-panel.tsx` (a Seazn fixture's ended state lists its replays with their state; the strings are in Task 26)
- Test: `seazn-video.test.ts`, `seazn-video-island.test.tsx`, `e2e/walkthrough/seazn-hosted.spec.ts` (extended)

- [ ] **Step 1: Write the failing tests.**
  - Two playable rows give `replay` of length 2 in `recorded_at` order, and each `src` contains `token_path=%2F<guid>%2F`.
  - A `processing` row is not public.
  - A replay of a private competition is absent from the public read and present in the org read.
  - LIVE off (and REPLAY off): a fixture with an ended Seazn session and a playable replay answers `seazn` from `seaznVideoPlan`, the page renders the Seazn replay player, never `ReplayEmbed`, and the route lists the part (the controller ruling).
  - e2e: after Stop, `fake.advance` and a tick, the page shows Part 1 and Part 2 for a stop/restart match.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expect PASS. Take screenshots at 320, 768 and 1280.
- [ ] **Step 5: Commit** `feat(stream): Seazn replay player`.

### Task 26: The organiser deletes a replay

**Files:**

- Create: `apps/web/src/app/api/v1/fixtures/[id]/replays/[replayId]/route.ts` (`DELETE`; the editor role, `requireSessionEditor`)
- Modify: `apps/web/src/server/video/organiser-replays.ts`: `deleteSeaznReplay(auth: AuthCtx, fixtureId: string, replayId: string): Promise<{ deleted: true }>`. It is org-scoped, so another org's id gives 404. It takes the row `for update` (waiting for a mover's short claim transaction, never for a provider call), sets `state 'deleted'`, `state_at`, `deleted_reason 'organiser'`, `deleted_by` and commits. That write wins over the mover, whose next conditional update finds zero rows. It then calls `replay.remove` on a known `bunny_video_id` (idempotent on `absent`). Any Bunny copy still in flight, and the Cloudflare copy, are removed by the mover's `cleanup` step (Task 24).
- Modify: `fixture-stream-panel.tsx` (a Delete per part, confirmed by a dialog, and a Download link per playable part from `signedDownload`, 1 h). Spec §5.5 lets the organiser download during the 30-day grace, and the same link serves them at any time.
- Modify: `src/dictionaries/{en,es,fr,nl}/ui.json`: `stream.replay.seazn.title` ("Replay on Seazn"), `stream.replay.seazn.processing` ("Getting the replay ready"), `stream.replay.seazn.failed` ("This replay could not be prepared — Seazn has been told"), `stream.replay.delete` ("Delete replay"), `stream.replay.download` ("Download"), `stream.replay.deleteConfirm` ("Delete this replay for everyone? This can't be undone.")
- Test: `organiser-replays.test.ts`, `route.test.ts`, `e2e/walkthrough/seazn-hosted.spec.ts`

- [ ] **Step 1: Write the failing tests.**
  - The editor deletes, and the public read no longer lists the part.
  - A second delete answers 200 `{deleted:true}` with no second `remove` call.
  - A viewer role gives 403. Another org gives 404.
  - Bunny `remove` throwing still answers 200: the row is `deleted`, and `cleanup` retries the removal (the public read no longer lists it either way).
  - Delete while the row is `fetching`: 200, then the Task 24 cleanup removes the late guid.
  - A playable part's Download `href` carries a token and `expires`, and a `processing` part has no Download.
- [ ] **Step 2: Run them, implement, then run them again.** Expect FAIL first, then PASS. Then `npm run openapi:gen`.
- [ ] **Step 3: Commit** `feat(stream): organiser deletes a Seazn replay`.

### Task 27: Phase 2 smoke and scoped regression

- [ ] **Step 1: Extend `scripts/smoke/suites/seaznHosted.ts`** with a replay row reaching playable on the fake host, and the public route listing it.
- [ ] **Step 2: Run the regression in one JSON run.** It covers every vitest path from Tasks 21–26, then `npx playwright test e2e/walkthrough/seazn-hosted.spec.ts e2e/walkthrough/stream-relay.spec.ts`. Check the counts and paths.
- [ ] **Step 3: Commit** `test(stream): Seazn replay smoke`.

---

# Phase 3 — Cost and lifecycle (`SEAZN_HOSTED_COST`)

### Task 28: Migration V542 — delivered minutes

**Files:**

- Create: `db/migration/deltas/V542__seazn_delivery.sql`. Table `fixture_video_delivery (session_id uuid primary key references fixture_stream_sessions(id) on delete restrict, org_id uuid not null, live_minutes numeric(12,1) not null default 0, replay_minutes numeric(12,1) not null default 0, live_measured_through date null, replay_measured_through date null, updated_at timestamptz not null default now())`, with RLS as in V430.
- Test: `apps/web/src/server/relay/__tests__/seazn-delivery-migration.test.ts`

- [ ] **Step 1: Write the test** (table shape, `numeric(12,1)`, RLS listed), see it fail, write V542, apply it locally, and see it pass.
- [ ] **Step 2: Commit** `feat(db): V542 Seazn delivered minutes`.

### Task 29: Read delivered minutes

**Files:**

- Create: `apps/web/src/server/video/cf-analytics.ts`: `liveMinutesViewed(uids: string[], from: Date, to: Date): Promise<Record<string, number>>`. It POSTs to `https://api.cloudflare.com/client/v4/graphql` with `streamMinutesViewedAdaptiveGroups(filter: { uid_in, date_geq, date_leq }, limit)` and sums `sum.minutesViewed` per uid. Windows longer than 32 days are refused.
- Modify: `replay-bunny.ts` and `replay-fake.ts`. `watchMinutes(videoId, from, to)` reads `GET /library/{lib}/statistics?videoGuid=&dateFrom=&dateTo=` and sums `watchTimeChart` values. The probe settles the unit; the docs do not state it.
- Modify: `apps/web/src/server/relay/config.ts`: `CLOUDFLARE_ANALYTICS_TOKEN` and the account id reuse the relay's account env.
- Modify: the Task 20 probe file and the Task 7 probe file, adding one assertion each: Task 7, whether a live HLS view of a programme input is keyed by the **input uid** or by its live video uid; Task 20, the `watchTimeChart` unit.
- Test: `video/__tests__/cf-analytics.test.ts` (mocked fetch), `replay-bunny.test.ts`

**Plan decision:** query the programme input uid **and** each of its video uids, and sum them. The Cloudflare docs key `uid` as "Video ID (for HLS/DASH)", and whether a live input's live HLS minutes sit under the input uid is unmeasured. Summing both counts the minutes wherever they land; the probe then drops the key that never carries any.

- [ ] **Step 1: Write the failing tests.**
  - The GraphQL body carries `uid_in` with the given uids, and the date filters are ISO dates.
  - A 33-day window throws.
  - A `errors[]` answer throws without echoing the token.
  - Bunny's `watchTimeChart` `{a:60,b:30}` sums to the expected minutes under the probed unit.
- [ ] **Step 2: Run them, implement, then run them again.** Expect FAIL first, then PASS.
- [ ] **Step 3: Commit** `feat(stream): delivered-minute readers`.

### Task 30: The daily measurement pass, staff view and org-deleted grace

**Files:**

- Create: `apps/web/src/server/usecases/seazn-cost.ts`:
  - `measureSeaznDelivery(deps, now)`: for Seazn sessions ended within the last 31 days, live minutes through yesterday. For every replay not deleted, replay minutes through yesterday. Both are upserted into `fixture_video_delivery`.
  - `purgeDeletedOrgReplays(deps, now)`: for orgs with `organizations.deleted_at < now - 30 days`, `replay.remove` each non-deleted replay and set `state 'deleted'`, `deleted_reason 'org_deleted'`.
- Modify: `apps/web/src/server/usecases/relay-sweep.ts`. It adds step 6, `seazn` (COST flag), after retention. Each sub-pass is wrapped like the others and never fails the sweep. It adds `SweepResult.seaznMeasured` and `seaznReplaysPurged`.
- Modify: `apps/web/src/app/admin/orgs/[id]/page.tsx`: a "Seazn video" table (staff only, 1280 only) of the last 50 Seazn sessions, with fixture, ended, live minutes, replay minutes and replay state. English only (`/admin`).
- Test: `usecases/__tests__/seazn-cost.test.ts`, `relay-sweep.test.ts`, `app/admin/orgs/[id]` SSR test if present, `e2e/walkthrough/stream-credits-admin.spec.ts` (extended: the staff table renders)

**Plan decision:** the 30-day clock starts at `organizations.deleted_at` (V021). It is the only "closed or deleted" mark the schema has. No product path sets it today: account deletion soft-deletes the user only (`api/users/me/route.ts:176-185`), and there is no org close. So until such a path exists, a staff member sets it. A credits-only org or an org between subscriptions never starts the clock (spec §5.5).

- [ ] **Step 1: Write the failing tests.**
  - A Seazn session with fake analytics `{inputUid: 12.5, videoUid: 3}` stores `live_minutes 15.5`, and a second run on the same day does not double it (`*_measured_through` is the guard).
  - An org with `deleted_at = now - 31 days` has its replays removed. One at `now - 29 days` keeps them. An active org keeps them.
  - COST off gives zero analytics calls.
  - Analytics throwing leaves the sweep's other counters intact and calls `captureError` once.
  - The admin page shows the row.
- [ ] **Step 2: Run them and see them fail.** `cd apps/web && npx vitest run src/server/usecases/__tests__/seazn-cost.test.ts src/server/usecases/__tests__/relay-sweep.test.ts --reporter=json --outputFile=$SCRATCH/t30.json`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expect PASS. Mutate the 30-day comparison to `<= now`, and the 29-day test fails. Take a screenshot of the admin page at 1280.
- [ ] **Step 5: Commit** `feat(stream): measure Seazn delivery and purge deleted orgs' replays`.

### Task 31: Phase 3 smoke and final regression

- [ ] **Step 1: Extend `seaznHosted.ts`.** The sweep answer carries `seaznMeasured`, and the admin table loads.
- [ ] **Step 2: Run the regression.** Run every vitest path from all tasks in one JSON run (check `numTotalTests` against the per-task sum and every path under this worktree), then `npx playwright test e2e/walkthrough/seazn-hosted.spec.ts e2e/walkthrough/stream-relay.spec.ts e2e/walkthrough/streaming-destinations.spec.ts e2e/match-day.spec.ts e2e/public-fixture.spec.ts` and all of `e2e/mobile/`. Finish with `npm run openapi:gen && git status --porcelain`.
- [ ] **Step 3: Commit** `test(stream): Seazn cost smoke`.

---

## Operator setup (not code; listed so a flag is never turned on half-configured)

- Phase 1:
  - `POST /accounts/{id}/stream/keys`, then put the result in `STREAM_SIGNING_KEY_ID` / `STREAM_SIGNING_KEY_PEM_B64`;
  - set `SEAZN_VIDEO_ORIGINS`;
  - then `SEAZN_HOSTED_LIVE=true`.
- Phase 2:
  - Bunny library with MP4 fallback on and allowed domains = the Seazn hosts;
  - CDN token authentication on, with its key in `BUNNY_TOKEN_KEY`;
  - `REPLAY_DRIVER=bunny`;
  - then `SEAZN_HOSTED_REPLAY=true`.
- Phase 3:
  - an analytics-read Cloudflare token;
  - then `SEAZN_HOSTED_COST=true`.
