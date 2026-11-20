# YouTube Connect channel-safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Seazn creating spam-looking broadcast patterns on customers' YouTube channels, warn before risky Go lives, and give every broadcast a clearer description.

**Architecture:** Auto-start gets its own persisted backoff (separate from the live-state record that feeds `liveStateOf`). A high per-fixture ceiling guards runaway bugs. The YouTube port gains channel-created-date and recent-broadcast reads; a non-blocking, fail-open safety check feeds a pre-Go-live warning. `broadcastDescription` gains match facts, locale-built from dictionary keys.

**Tech Stack:** Next.js (read `node_modules/next/dist/docs/` before any Next code), TypeScript, postgres.js `sql`, vitest (`environment: "node"`), `FakeYouTube` (`apps/web/src/server/youtube/fake.ts`) behind the `YouTubePort` seam (`port.ts`).

**Spec:** `docs/superpowers/specs/2026-11-19-youtube-connect-channel-safety-design.md` (owner-approved 2026-11-20).

## Global Constraints
- All paths below are under `apps/web/src/` unless stated. Re-verify every line number; they are hypotheses.
- Work in a NEW worktree (`feat/youtube-channel-safety` off main); never the main checkout. Fresh worktree has no node_modules: follow the `seazn-local-env` skill.
- Read `server/MODULARIZATION.md` before touching `server/`. Verbatim moves only; no behaviour change rides along.
- SCOPED tests only: `cd apps/web && vitest run <exact path> --reporter=json --outputFile=<f>`; judge green from `numPassedTests/numTotalTests` and confirm `.testResults[].name`. Never the full suite, full tsc or e2e. `grep -a` always.
- Human-tapped Go live is NEVER blocked by backoff, by the warning, or by anything except the 10-per-hour runaway ceiling.
- Constants live in `lib/youtube.ts` (next to `YOUTUBE_LIVE_STATE_FRESH_MINUTES`, line ~53), never inline.
- Migration: list `db/migration/deltas/`, take the next free V number, never reuse; greenfield schema stance.
- Every new user-facing string goes in all 4 locale dictionaries, then run the i18n-keys generator (`new dict key requires gen-keys`). Broadcast description keys follow the existing `streaming.youtube.broadcast.*` family.
- No hashtags, one link only in descriptions. Title format unchanged. `/admin` untouched.
- Commit per task, trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. No push, no PR.

## Review Focus
1. Backoff must not hide a channel that recovered: a successful human Go live clears the backoff, and automatic start then retries immediately.
2. Automatic start refused by backoff must not leave a half-created broadcast or reserved key behind (check `failRow`/reservation cleanup).
3. Ceiling window must roll: the 11th refuses, and one hour later the next succeeds. Refused attempts must not count toward the ceiling.
4. Safety check API failure (quota, 401, timeout) shows NO warning and never blocks Go live; it must not mark the connection `reconnect_needed` for a mere read failure.
5. Description for a fixture with no venue, no start time, a private competition (no match link), TBD entrants, and a 300-character competition name stays within YouTube's description limit and has no `<` or `>`.

---

### Task 1: Auto-start backoff

**Files:**
- Create: migration `db/migration/deltas/V<next>__youtube_auto_backoff.sql`
- Modify: `lib/youtube.ts` (constants), `server/youtube/connections.ts` (`recordAutoBackoff`, `clearAutoBackoff`, `autoBackoffActive`), `server/youtube/prepare.ts` (read columns at ~135-138, apply at ~157, record in `failRow` ~513-523, clear on success)
- Test: `server/youtube/__tests__/auto-backoff.test.ts` (new; follow the neighbouring test files' DB/fake setup)

**Interfaces:**
- Produces in `lib/youtube.ts`: `YOUTUBE_AUTO_BACKOFF_BASE_SECONDS = 60`, `YOUTUBE_AUTO_BACKOFF_MAX_SECONDS = 1800`, `YOUTUBE_AUTO_BACKOFF_CODES: readonly YoutubeRefusalCode[]` = `youtube_limit_reached`, `youtube_channel_busy`, `youtube_unavailable`.
- Produces in `connections.ts`: `export function backoffSeconds(count: number): number` = `min(60 * 2^(count-1), 1800)`; `export async function recordAutoBackoff(exec, orgId, connectionId, now: Date): Promise<void>` (increments count, sets `auto_retry_after = now + backoffSeconds(newCount)`); `export async function clearAutoBackoff(exec, orgId, connectionId): Promise<void>`; `export function autoBackoffRefusal(r: {auto_retry_after: Date | null}, now: Date): boolean`.
- Columns on `org_youtube_connections`: `auto_backoff_count int not null default 0`, `auto_retry_after timestamptz null`. Deliberately NOT `last_error_code`/`last_health_at`: those feed `liveStateOf` and the Streaming page.

- [ ] **Step 1: Write failing tests.** `backoffSeconds(1..8)` = 60,120,240,480,960,1800,1800,1800 (derive from the constants, not typed literals, plus one literal sanity case where answer differs from the constant). `autoBackoffRefusal` true before `auto_retry_after`, false at/after it, false when null. Sequence tests through the REAL `prepareYoutubeBroadcast` with `FakeYouTube` forced to `youtube_limit_reached`: automatic start refuses with the YouTube call made once, a second automatic start inside the window refuses WITHOUT a port call (assert call count on the fake), a human start inside the window DOES call the port, after a success the count is 0 and automatic start calls the port again.
- [ ] **Step 2: Run to confirm failure.** Expected: new tests fail (functions undefined).
- [ ] **Step 3: Migration + constants + the three `connections.ts` functions.**
- [ ] **Step 4: Wire into `prepare.ts`.** In the target select add `auto_retry_after`; for `startCause === "automatic"` refuse with the recorded code when `autoBackoffRefusal` is true (store the refusing code in `last_error_code`-independent way: re-throw `youtube_unavailable` if no code is stored; add `auto_backoff_code text null` if you need the original code, your call). In `failRow`, when the refusal code is in `YOUTUBE_AUTO_BACKOFF_CODES`, call `recordAutoBackoff`. On any successful prepare call `clearAutoBackoff`.
- [ ] **Step 5: Run `auto-backoff.test.ts` and the existing `server/youtube/__tests__` files touching prepare/connections. Expected: all pass.**
- [ ] **Step 6: Mutate once:** make `autoBackoffRefusal` return `false`; make human start honour it. Each must turn a test red. Restore. Report mutants killed.
- [ ] **Step 7: Commit.**

### Task 2: Per-fixture runaway ceiling

**Files:**
- Modify: `lib/youtube.ts` (`YOUTUBE_MAX_BROADCASTS_PER_FIXTURE_PER_HOUR = 10`), `server/youtube/prepare.ts` (guard before `insertBroadcast`, ~387; inside the same admission transaction rules as `lockConnection`: never hold a lock across a port call)
- Modify: `lib/stream-session-view.ts` / `dictionaries/*/ui.json` only if no existing `limit_reached` copy fits the fixture case; reuse `stream.error.youtube_limit_reached` if it reads correctly
- Test: `server/youtube/__tests__/fixture-ceiling.test.ts`

**Interfaces:**
- Produces: `export async function recentBroadcastCount(exec, fixtureId: string, now: Date): Promise<number>` in `server/youtube/parts.ts` or `prepare.ts` (your call, per MODULARIZATION.md): count of `youtube_broadcasts` rows for the fixture created in the last 60 min, from existing data, no new table. Refusal code `youtube_limit_reached`.

- [ ] **Step 1: Failing tests** through the real prepare path: 10 successive Stop/Go live cycles succeed, the 11th refuses `youtube_limit_reached` with NO port insert call; with `now` advanced 61 minutes the next succeeds; a refused attempt leaves count unchanged (12th attempt also refuses, then window roll succeeds); another fixture is unaffected.
- [ ] **Step 2: Run, confirm fail. Step 3: Implement. Step 4: Run, confirm pass (+ neighbouring prepare tests).**
- [ ] **Step 5: Mutate once:** `return true` on the guard, and off-by-one (`>` vs `>=`); both must die. **Step 6: Commit.**

### Task 3: Channel facts (created date, recent short broadcasts)

**Files:**
- Modify: `server/youtube/port.ts` (interface), `server/youtube/google.ts` (~264 `channels.list`, plus a new `liveBroadcasts.list`), `server/youtube/fake.ts`, `server/youtube/connections.ts` (store at connect, ~142), migration `V<next>__youtube_channel_created_at.sql` (`channel_created_at timestamptz null` on `org_youtube_connections`; nullable for existing rows)
- Test: `server/youtube/__tests__/channel-facts.test.ts`

**Interfaces:**
- `YouTubePort.channelCreatedAt(at: string): Promise<Date | null>`: `channels.list?part=snippet&mine=true` `snippet.publishedAt`. 1 quota unit.
- `YouTubePort.recentBroadcasts(at: string, since: Date): Promise<{ startedAt: Date; endedAt: Date | null }[]>`: `liveBroadcasts.list?part=snippet,status&mine=true` (`broadcastType=all`), page through until older than `since`, cap 3 pages. Map errors with existing `mapGoogleError`. Never log bodies or tokens (port.ts SECRETS rules).
- Produces: `export function channelSafetyWarning(f: { createdAt: Date | null; broadcasts: {startedAt: Date; endedAt: Date | null}[]; now: Date }): { young: boolean; shortRecent: number; warn: boolean }` (pure) in `server/youtube/channel-safety.ts` (new). Constants in `lib/youtube.ts`: `YOUTUBE_YOUNG_CHANNEL_DAYS = 30`, `YOUTUBE_SHORT_BROADCAST_MINUTES = 10`, `YOUTUBE_SHORT_BROADCAST_WARN_COUNT = 2`, window 24h. A broadcast with `endedAt` null (still live) is not short. `warn = young || shortRecent >= 2`; `createdAt` null => `young` false.

- [ ] **Step 1: Failing tests (pure):** table over (age 29d/30d/31d, 0/1/2/3 short, 2 long, 1 short + 1 long, 2 short just outside 24h, endedAt null, createdAt null), expected derived from the constants. Port tests against `FakeYouTube`: `channelCreatedAt` returns the seeded date; `recentBroadcasts` filters by `since`.
- [ ] **Step 2: Run, confirm fail. Step 3: Implement port + fake + google + pure function + store `channel_created_at` when a connection is created (best effort: a failed read stores null and never fails the connect). Step 4: Run, confirm pass.**
- [ ] **Step 5: Mutate once:** flip `>=` to `>` on the warn count; drop the `young` branch; both must die. **Step 6: Commit.**

### Task 4: Pre-Go-live warning

**Files:**
- Create: org-scoped read route beside `app/api/v1/orgs/[id]/youtube-connections/[connectionId]/` named `safety/route.ts` returning `{ warn: boolean; young: boolean; shortRecent: number }`; follow that folder's auth/org-scoping pattern exactly (404 for a foreign connection, before any port call) and the repo's OpenAPI drift rule (`ci.yml` check) if routes are registered
- Modify: the organiser Go live UI (find via `app/api/v1/fixtures/[id]/stream-sessions/route.ts` consumers; Stream panel) to fetch once per Go live tap, show a dismissible non-blocking notice, then proceed on a second tap; `dictionaries/{en,...}/ui.json` (4 locales) for the copy; regenerate i18n keys
- Test: route unit test + a Playwright spec under `e2e/` for the notice (written, run by CI only; do NOT run e2e locally)

**Interfaces:**
- Consumes: `channelSafetyWarning`, `YouTubePort.channelCreatedAt` / `recentBroadcasts` (Task 3), `accessTokenFor` (`prepare.ts`; export it or extract per MODULARIZATION.md).
- Behaviour: on any port error return `{ warn: false, ... }` with HTTP 200, log via `captureError`, and do NOT call `markIfGrantDead` / `markReconnectNeeded` (a read failure must not move the connection status). One call per Go live tap, never from phone beats or auto-start.
- Copy (English): "Several short test streams can get a YouTube channel flagged, even unlisted. Test on a throwaway channel." Add buttons "Go live anyway" / "Cancel" (keys, 4 locales).

- [ ] **Step 1: Failing tests:** route returns `warn: true` for a young channel and for 2 short broadcasts; `warn: false` and 200 when the fake throws `youtube_unavailable`, `youtube_limit_reached` and `youtube_reconnect_needed`; connection status unchanged after the dead-grant case; foreign org => 404 with zero port calls. Locale test: all four dictionaries have every new key (anti-vacuity: report key count).
- [ ] **Step 2: Run, confirm fail. Step 3: Implement route, UI, copy. Step 4: Run, confirm pass.**
- [ ] **Step 5:** Drive the real UI once by hand at 320 and 1280 (screenshots to the local :8765 server, no PNGs in the repo), read what you saw into your report.
- [ ] **Step 6: Mutate once:** make the route 500 on port error (should fail the fail-open test); remove the 404 scoping. **Step 7: Commit.**

### Task 5: Richer description

**Files:**
- Modify: `server/youtube/title.ts` (`broadcastDescription`, ~65), `server/youtube/prepare.ts` (~270-290: extend the fixture select with sport, round, venue, start time; pass new args), `dictionaries/*/ui.json` (4 locales), keys under `streaming.youtube.broadcast.*`
- Test: `server/youtube/__tests__/title.test.ts` (extend the existing file if present)

**Interfaces:**
- `broadcastDescription(a: { line: string; matchUrl: string | null; poweredBy: string; siteUrl: string; facts?: string[] })`: `facts` is an ordered list of already-localised, already-cleaned lines (sport and round; competition; venue when present; date/time). Output: facts block, blank line, match link line (only when `matchUrl` non-null), blank line, ONE footer "Scored live with Seazn Club" plus site link. Keep the existing "no `<`/`>`" cleaning and a total length cap of 5000 characters (YouTube's limit), trimming facts first. Sport and round names reuse existing translated labels; do not hardcode English.
- Time formatting uses the competition/org locale and timezone; if a competition has no timezone, omit the time line.

- [ ] **Step 1: Failing tests:** for each of 4 locales the description contains the localised footer and exactly one `http` link when `matchUrl` set and one (the site link) when null; with and without venue; TBD entrants; private competition (no match link); 300-char competition name stays under the cap; output contains no `<` or `>`; titles unchanged (re-run existing title tests).
- [ ] **Step 2: Run, confirm fail. Step 3: Implement + dictionary keys + regenerate i18n keys. Step 4: Run, confirm pass.**
- [ ] **Step 5: Mutate once:** drop the length cap; drop the `<>` cleaning; both must die. **Step 6: Commit.**

### Task 6: Seam proof

**Files:** Test: `server/youtube/__tests__/channel-safety-seam.test.ts`

- [ ] **Step 1:** One test that drives the REAL producers and consumers end to end with `FakeYouTube`: connect (stores `channel_created_at`) -> safety route returns warn for a 5-day-old channel -> automatic start refused with `youtube_limit_reached` twice, second without a port call -> human Go live proceeds and clears backoff -> description produced by `prepareYoutubeBroadcast` (read it from the fake's recorded insert) contains the fact lines. This guards the "inert seam" failure class: it fails if any of Tasks 1-5 is declared but never reached.
- [ ] **Step 2: Run the scoped set** (`server/youtube/__tests__`, the safety route test, dictionary/key tests). Paste raw `numPassedTests/numTotalTests` and `.testResults[].name` evidence.
- [ ] **Step 3: Commit.**

---
**Verification at wave boundary (orchestrator):** rerun the scoped set myself from the worktree with an absolute `cd`, check names resolve inside the worktree, run the `reviewer` agent on the whole diff, then PR for owner sign-off. e2e comes from CI via `workflow_dispatch --ref`.
