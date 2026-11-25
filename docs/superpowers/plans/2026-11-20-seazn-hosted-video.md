# Seazn-hosted Video Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-match destination **Seazn**. A Seazn match runs composed, plays live on the public match page and on Match Day from a signed Cloudflare programme input, and its replay moves to Bunny Stream, where it stays while the org is a customer. Delivered minutes are measured for staff. Before any of it, Phase 0 makes YouTube Connect safe for customers' channels: no automatic retry loop, a per-fixture runaway ceiling, a non-blocking pre-Go-live warning for young or recently churned channels, and a fuller broadcast description.

**Architecture:** Phase 0 (YouTube Connect only): automatic start gets its own persisted backoff on `org_youtube_connections` (separate from the live-state record that feeds `liveStateOf`); a ceiling of 10 broadcasts per fixture per rolling hour guards runaway bugs; `YouTubePort` gains `channelCreatedAt` and `recentBroadcasts`, which feed a fail-open safety check behind a pre-Go-live warning; `broadcastDescription` gains localised match facts. Every Phase 0 guard sits inside `prepareYoutubeBroadcast` after its connection check, or in the panel behind a YouTube-connection predicate, so a target with no YouTube connection (pasted key, Seazn) never meets one. Phases 1–3: Seazn is one `org_stream_targets` row per org with `kind = 'seazn'` and no credential. Every admission, holder and picker path reads it from there, so `target_id` stays the session's one destination fact. A Seazn session is composed. The programme input (Input B, R2004) that composed sessions already create becomes the viewers' input: it is created signed and gets no Cloudflare output; viewers play it with tokens from Cloudflare's own token endpoint, and a tick pass signs each of its recordings as it appears (Cloudflare records a signed input unsigned). A tick pass moves finished programme recordings to Bunny through a new `ReplayHost` port; Bunny's webhook reports them playable, with a slow poll as the backstop. Replays play in Bunny's embed player. From Phase 1 on, the daily sweep holds every Seazn recording past 3 days (Cloudflare's 30-day floor is the backstop) so Phase 2 can still move it; Phase 3 measures delivery and deletes the replays of deleted orgs.

**Tech Stack:** Next.js (apps/web), TypeScript 7, postgres.js (`sql`, the non-tenant client for stream tables), zod 4 api-v1 schemas plus `npm run openapi:gen`, Cloudflare's `POST /stream/{uid}/token` for playback and download tokens (no key of our own, no `jose` signing: POC result C1), Bunny's embed player (iframe) for replays, `FakeYouTube` (`server/youtube/fake.ts`) behind the `YouTubePort` seam (`port.ts`) for Phase 0, `hls.js` (new, pinned exactly; live only), vitest (node env, real Postgres), Playwright e2e, and `scripts/smoke/suites`.

**Specs (two):**

- Phase 0: `docs/superpowers/specs/2026-11-19-youtube-connect-channel-safety-design.md` (owner chose approach B, 2026-11-19; the plan for it owner-approved 2026-11-20). Its source plan, `docs/superpowers/plans/2026-11-20-youtube-connect-channel-safety.md`, is folded in here as Phase 0 and superseded by it.
- Phases 1–3: `docs/superpowers/specs/2026-11-20-seazn-hosted-video-design.md`.

Executors read the spec of their phase first; both are binding. Also read `apps/web/src/server/MODULARIZATION.md`, `docs/superpowers/RULES.md` and `docs/superpowers/TEST-STRATEGY.md`.

## POC results (2026-11-20)

Measured by hand on the staging accounts. They replace what Tasks 7 and 20 set out to probe; those tasks now record these results and probe only what is still open. Cite them by ID.

Cloudflare:

- **C1. Tokens.** A live input created with `recording.requireSignedURLs: true` and `allowedOrigins`: live HLS by uid answers 401; with a token from `POST /stream/{input_uid}/token` it answers 200. Cloudflare's token endpoint is enough. Plan decision: **no signing key of our own and no `jose` minting.** Nothing else in the plan needs a key (downloads use the same endpoint with `downloadable: true`, C5), and a key would add a secret, its rotation and a JWT path to test. The cost of the endpoint (one API call per mint) is bounded by caching one token per uid on the server (Task 13), so calls scale with live inputs, not viewers.
- **C2. `allowedOrigins` is not access control.** A raw HLS request with another `Origin`/`Referer` answered 200. The only protection of live playback is the token's short life (1 h, Task 8). The spec's G5 is softened to match.
- **C3. The recording of a signed input is NOT signed.** The video Cloudflare recorded from the signed input read `requireSignedURLs: false`, publicly playable. Every Seazn recording is set `requireSignedURLs: true` (`POST /stream/{video_uid}`) as soon as it appears (Task 13), and tested. Until the next tick it is open (at most about a minute).
- **C4. Sizes.** The live ladder from a 720p input was 720/480/360/240. Cloudflare's MP4 download of the recording was 1080p (1920×1080).
- **C5. Download for Bunny.** `POST /stream/{uid}/downloads`, then a token minted with `downloadable: true`, gives `https://{cf-customer-host}/{token}/downloads/default.mp4`, which Bunny fetched.
- **C6. The list filter is a footgun.** `GET /stream?live_input_id=` filters; an unknown query parameter is silently ignored and the call answers every video on the account. During the POC a misspelt filter deleted 25 recordings. See the Global Constraint below.

Bunny:

- **B1. Fetch answers the id.** `POST /library/{id}/videos/fetch` with the C5 URL works and its body carries the new video's `id`. Plan decision: **no title search** anywhere (the old `findByTitle` is gone).
- **B2. Encoding.** 200 s of video encoded in about 2.5 min; video statuses seen 2 → 3 → 4. The library's resolutions are capped at **720p** (owner setting): nothing may assume a 1080p replay.
- **B3. Security (owner turned on):** Block direct url file access (referrer allow-list), Embed view token authentication, CDN token authentication. One library token key signs both tokens.
- **B4. Embed.** With no or a bad token the embed shows an error page. With `token = hex(sha256(tokenKey + videoGuid + expires))` at `https://iframe.mediadelivery.net/embed/{libraryId}/{guid}?token=…&expires=…` it plays. Plan decision: **replays play in Bunny's embed player (iframe) with this token; live stays hls.js on Cloudflare.** The spec preferred one player for both, but direct Bunny HLS needs an allowed `Referer` and a per-path CDN token on every request, which the embed carries for us.
- **B5. Direct files** need BOTH an allowed `Referer` AND a CDN token: `https://{cdn}/bcdn_token={t}&expires={e}&token_path=%2F{guid}%2F/{guid}/playlist.m3u8`, `t = base64url-no-pad(sha256(tokenKey + "/{guid}/" + expires + "token_path=/{guid}/"))` (a plain sha256, not an HMAC). So an organiser's download goes through our server (Task 26).
- **B6. Webhook.** Per library. Body `VideoLibraryId`, `VideoGuid`, `Status`, `EventId` (dedupe on it), `Timestamp`. Webhook statuses: 3 Finished, 4 Resolution finished (playable), 5 Failed. These are NOT the video API's statuses (B2, Task 21), where 3 is transcoding. Header `X-BunnyStream-Signature` = lowercase hex HMAC-SHA256 of the raw body keyed with the library's Read-Only API key; `X-BunnyStream-Signature-Version: v1`; `X-BunnyStream-Signature-Algorithm: hmac-sha256`. Retries at 30 s, 2 m, 10 m, 30 m, 1 h, 2 h, then dropped. Plan: a webhook route (Task 27) is the primary signal; the tick's poll every 15 min is the backstop.

Still open, and probed in Tasks 7 and 20: whether a lock set on an in-progress recording survives its end and leaves the live HLS playing; whether a `PUT` of `recording` keeps `requireSignedURLs`; whether the token's `exp` is honoured; collection create and fetch into a collection; whether an embed keeps playing past its token's `expires`; the MP4 fallback's file name at the 720p cap; and the analytics keys (Task 30).

## Replay lifecycle (owner ruling 2026-11-21, with recommendations)

Spec §5.7. **Owner ruling 2026-11-21, the sequence and only the sequence:** match decided → wait 15 min → move to Bunny (no time limit) → confirm the Bunny copy is clean and good → switch the player to Bunny → delete the Cloudflare copy within 1–2 h. From it, the owner's own numbers are the 15-min delay (G-A) and the delete inside 1–2 h (G-D). Everything more specific is a `Recommendation 2026-11-21 (applied unless the owner objects)`: the 60-min delete value, the ±2 s length check and the 720p rendition check (G-C), the interim Cloudflare playback (G-B), the live stop (G-E) and the undecided-fixture fallback (G-F). Each affected task below carries a bullet headed with its label, so its brief is self-contained. Three constants, `SEAZN_REPLAY_DELAY_MINUTES = 15`, `SEAZN_CF_DELETE_DELAY_MINUTES = 60` and `SEAZN_REPLAY_UNDECIDED_FALLBACK_HOURS = 6`, are added to `relay/config.ts` by Task 24 beside `SEAZN_LIVE_TOKEN_TTL_SECONDS`. Map: G-A trigger and G-F fallback → Task 24; G-B interim playback → Tasks 13, 14, 15, 25; G-C "clean and good" → Tasks 23, 24, 27; G-D delete timing → Tasks 23, 24, 27 (Task 18's sentence follows); G-E live stop → Task 24.

## Global Constraints

- **Migration numbers: V538 and V539 for Phase 0 (it ships first), then V541, V542, V543 for Phases 1–3.** V538 `youtube_auto_backoff` (Task 1), V539 `youtube_channel_created_at` (Task 3), V541 `seazn_destination` (Task 9), V542 `seazn_replays` (Task 23), V543 `seazn_delivery` (Task 29; **built as V552** — main's chess delta took V543 and main's stage-lots delta took V546, the next number it was given, so the 2026-11-24 rebase moved it to V552, the first number free on main and on every open branch). Renumbered 2026-11-22: main's W5 shipped `V540__w5_qualification_frozen_cut.sql` first, so the Seazn destination moved V540 → V541, the replays V541 → V542, and delivered minutes takes V543. The Seazn spec's "next is V531" and the YouTube plan's "next free V" are both resolved here: this branch already has V531–V537 (no V533). Never reuse a number. Re-check `ls db/migration/deltas | sort -V | tail -3` at each rebase and renumber if main has moved.
- **Phase 0 has no flag.** Its source plan defines none: it changes YouTube Connect for every org and ships first, alone or as its own PR (`feat/youtube-channel-safety` off main) before Phases 1–3 rebase on it.
- **Three server flags, all off by default**, read in `apps/web/src/server/relay/config.ts`, the one place relay numbers and settings live, and parsed the way `STREAM_SRT_ENABLED` is (`"true"`/`"false"`, anything else throws): `SEAZN_HOSTED_LIVE` (Phase 1), `SEAZN_HOSTED_REPLAY` (Phase 2, which needs LIVE), `SEAZN_HOSTED_COST` (Phase 3). With LIVE off, no reader lists, picks, resolves or admits a `seazn` row, so no new Seazn stream can start. Controller ruling (2026-11-20): a fixture that already streamed to Seazn keeps showing its Seazn live and replay whatever LIVE is. The flag gates new picks and starts, never playback of what exists.
- **No per-org opt-in** (owner, 2026-11-20: "No need, as we will test in stage then promote to Prod"). Every org gets the Seazn destination once `SEAZN_HOSTED_LIVE` is on in that environment; staging first, then prod. No Enable card, admin route or panel prompt.
- G1, the anti-goal: a Seazn session creates no `youtube_broadcasts` row, prepares no broadcast, adds no Cloudflare output and reads no key. A non-Seazn session's path does not change by one byte. Every task that touches start, apply or tick carries a regression test for a pasted-key session and a YouTube session.
- G5: **all Seazn playback is signed.** That covers the Cloudflare programme input (`recording.requireSignedURLs: true`, plus `allowedOrigins` = the Seazn hosts, which is cheap but blocks nothing: C2), **each recording that input makes** (signed by Task 13, because Cloudflare records it unsigned: C3), and Bunny (embed token for viewers, CDN token plus the referrer allow-list for files: B3–B5). Live protection is the token's short life. The camera input stays unsigned, because the phone's `playbackUrl` (`capture-phone.ts:269`) reads it.
- `ingest-cf.ts:10-15`: never send an update that changes `recording` on a live input. The signed settings are part of the create body, and `setInputEnabled` re-sends exactly what the create sent.
- Secrets (`BUNNY_STREAM_API_KEY`, `BUNNY_STREAM_READONLY_KEY`, `BUNNY_TOKEN_KEY`, and the existing Cloudflare API token; `BUNNY_STREAM_LIBRARY_ID` and `BUNNY_STREAM_CDN_HOST` are config, held the same way) come from env through `config.ts` only. There is no Cloudflare signing key (C1). They never appear in a URL query, a log, an error, a `stream_provider_calls` row or a database column. A signed token appears only in the playback URL handed to the viewer.
- **Cloudflare video safety (C6).** Every call that acts on a Cloudflare video (delete, sign, download) takes its uid either from a row this database stored after checking it, or from a listing whose EACH item is checked: the video's own `liveInput` (`IngestVideo.inputId`) must equal the input that was asked about, else it is skipped and counted. Never bulk-act on a filtered listing without that per-item check: Cloudflare ignores an unknown filter and answers every video on the account. The sweep's camera step already does this (`relay-sweep.ts:354-358`); new code copies it. Every task that lists or deletes videos (13, 18, 24, 27) has a test whose port answers videos of OTHER inputs and asserts none of them is touched.
- ~~Courts stay out (spec §7.2).~~ **Amended by Task 37 (finding F3, 2026-11-24):** courts may stream to Seazn. Each court match is its own session with its own inputs, so there is no split to do; `linkCourtStream` admits a connected YouTube channel or the org's offered Seazn row (422 `seazn_unavailable` when the flag or the org's switch is off, 422 `court_destination_unsupported` for a pasted key). The test that pinned the old refusal is flipped deliberately (court-streams.test.ts).
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
- **Tests (owner, 2026-11-20: "all tests are covered and written without any flaky, don't think too much corner/rare cases").** Every task's behaviour has a test on its main paths: each new endpoint, each state change, each flag on and off, and the safety rules (the per-item Cloudflare check, the recording made signed, a bad webhook signature refused). No flaky tests: fake clocks (an injected `now` or vitest fake timers, never a real sleep or wait), fake ports (no network to Cloudflare, Bunny or YouTube in unit or integration tests; only the gated `*.live.test.ts` probes of Tasks 7 and 20 touch a vendor), deterministic ids, and no reliance on the order of an unordered query (sort, or compare as sets). At most one test per failure mode; a rare race with no clear user-facing failure gets no test of its own.

## Review Focus

Items 1–5 and 11–15 are the Seazn phases'; items 6–10 are Phase 0's.

1. **Two Seazn matches of one org live at the same time.** Both are admitted, because one shared `seazn` row must never read as "destination in use". Pinned in Task 9 (the index) and Task 11 (the holder guard and admission).
2. **The flag goes off after a fixture saved Seazn as its pick, or while a Seazn session runs.** A new start is refused with a typed 422, the saved Seazn pick resolves to **no destination** ("waiting for a destination"), never silently to YouTube or another external one (spec anti-goal), and the running session runs on and ends normally. Pinned in Task 10 and Task 11.
3. **A viewer who loaded the page before kick-off, or keeps it open past the token's expiry.** The player appears when the session goes live, without a reload, and re-mints before expiry while keeping the same `<video>` element. Pinned in Task 15.
4. **A Stop and restart, which makes two sessions, or one programme input with two recordings.** Every recording becomes a replay, numbered by recording start across sessions. Pinned in Task 24 and Task 25.
5. **Bunny never becomes playable** (status 5 or 6, a fetch that keeps failing, an unreachable API, a copy that fails the length or 720p check). The Cloudflare recording is never deleted, retries back off, staff are alerted once after 3 days, and the sweep never deletes it. Pinned in Task 24 and Task 18.
6. **The backoff must not hide a channel that recovered.** A successful human Go live clears the backoff, and the automatic start then retries at once. Pinned in Task 1 and Task 6.
7. **An automatic start refused by the backoff leaves no half-created broadcast or reserved key behind** (check `failRow` and the reservation cleanup). Pinned in Task 1.
8. **The ceiling window rolls.** The 11th refuses, and one hour later the next succeeds. Refused attempts do not count toward the ceiling, and a Seazn session is never counted or limited. Pinned in Task 2 and Task 11.
9. **A safety-check API failure** (quota, 401, timeout) shows NO warning and never blocks Go live, and it never marks the connection `reconnect_needed` for a mere read failure. A Seazn pick never shows the warning. Pinned in Task 4 and Task 16.
10. **The description** for a fixture with no venue, no start time, a private competition (no match link), TBD entrants and a 300-character competition name stays within YouTube's limit and has no `<` or `>`. Pinned in Task 5.
11. **A Cloudflare listing that answers videos of other inputs** (C6). Nothing outside the asked-for input is signed, moved or deleted. Pinned in Tasks 13, 18, 24 and 27.
12. **A Seazn recording left publicly playable** (C3). The tick signs every recording of a Seazn programme input, live or ended, whatever the flags. Pinned in Task 13.
13. **A forged, repeated or dropped Bunny webhook** (B6). A bad signature changes nothing, a repeated `EventId` acts once, and a dropped webhook is caught by the 15-min poll. Pinned in Tasks 24 and 27.
14. **The switch to Bunny and the Cloudflare delete** (recommendation 2026-11-21). A copy that fails the length (±2 s) or 720p check is never swapped in, and the Cloudflare video is never deleted before `verified_at` + 60 min. Until the swap, the page plays the signed Cloudflare recording and never an unsigned one. Pinned in Tasks 14, 24, 25 and 27.
15. **A Seazn session left live after the result** (recommendation G-E). Stopped 15 min after the fixture is decided in every mode, `auto_stopped`, with no change to the existing automatic stop for any other session. Pinned in Task 24.

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

### Task 7: Record the Cloudflare POC results and probe what remains

C1–C6 settled the token and access questions this task used to probe: the input-uid token from Cloudflare's endpoint plays (C1), `allowedOrigins` blocks nothing (C2), and the recording comes out unsigned (C3). Task 12 rests on C1, and Task 13 on C1, C3 and C5. Three behaviours are still open, and Task 13's recording lock and Task 12's `setInputEnabled` rest on them.

**Files:**

- Create: `apps/web/src/server/relay/__tests__/cf-signed-live.live.test.ts`, gated the way `fly-client.live.test.ts` is (`_live-fly-gate.ts` pattern: skipped unless `CF_LIVE_PROBE=1` plus the account env)
- Create: `docs/superpowers/specs/2026-11-20-seazn-hosted-probes.md`: C1–C6 and B1–B6 copied from this plan's POC section with the date, then this task's and Task 20's results

- [ ] **Step 1: Write the probe.** Create an input with `recording: { mode: "automatic", requireSignedURLs: true, allowedOrigins: ["seazn.club"], timeoutSeconds: 180 }`, publish a short test feed to it, and assert:
  - **lock in progress:** `POST /stream/{video_uid} {requireSignedURLs:true}` on the in-progress recording echoes `true`; the live HLS through a fresh input-uid token still answers 200 after it; an unsigned `/{video_uid}/manifest/video.m3u8` answers 401 or 403; after the feed stops and the recording finishes, `GET /stream/{video_uid}` still reads `requireSignedURLs: true`;
  - **PUT keeps it:** a `PUT` that re-sends the same `recording` with `enabled: false` echoes `requireSignedURLs: true`;
  - **expiry:** a token minted with `exp` = now + 60 s answers 200 at once and 401 or 403 at now + 90 s.

  Cleanup deletes exactly the one video uid and the one input uid this probe created, each by uid. It never lists videos to find them (C6).

- [ ] **Step 2: Run it against the staging account.** `cd apps/web && CF_LIVE_PROBE=1 npx vitest run src/server/relay/__tests__/cf-signed-live.live.test.ts`. Record each result in the probes doc. If the lock does not hold on an in-progress recording, stop and raise it: Task 13 must then lock only finished recordings, and the window in C3 grows to the whole match.
- [ ] **Step 3: Commit** `test(stream): record Cloudflare POC results; probe the recording lock`.

### Task 8: Seazn settings in relay config

**Files:**

- Modify: `apps/web/src/server/relay/config.ts` (beside `streamPlaybackHost`/`srtEnabled`, `:314-342`)
- Test: `apps/web/src/server/relay/__tests__/config.test.ts`

**Interfaces — Produces:**

- `seaznHostedLive(env?): boolean`, `seaznHostedReplay(env?): boolean`, `seaznHostedCost(env?): boolean`. Unset means false. `"true"`/`"false"` are accepted case-insensitively; anything else throws and names the variable. `seaznHostedReplay` is true only when LIVE is true too.
- `seaznVideoOrigins(env?): string[] | null`. Reads `SEAZN_VIDEO_ORIGINS`, comma-separated bare hostnames trimmed and de-duplicated. Null when unset. Throws on an entry with a scheme or path.
- `SEAZN_LIVE_TOKEN_TTL_SECONDS = 3600` and `SEAZN_TOKEN_REFRESH_BEFORE_SECONDS = 300`.

  Plan decision: a 1 h token, re-minted by the server 5 min before expiry (Task 13's cache) and re-read by the client island at the same point (Task 15). The token's short life is the only protection of live playback (C2), so it stays at 1 h, far under Cloudflare's 24 h cap. One token per input is shared by all viewers, so a 3 h match costs about four token calls per server instance, whatever the audience.

- [ ] **Step 1: Write the failing tests.**
  - `seaznHostedLive({})` is false. `({SEAZN_HOSTED_LIVE:"TRUE"})` is true. `"yes"` throws `/SEAZN_HOSTED_LIVE/`.
  - `seaznHostedReplay({SEAZN_HOSTED_REPLAY:"true"})` is false while LIVE is unset.
  - `seaznVideoOrigins({SEAZN_VIDEO_ORIGINS:" seazn.club,www.seazn.club,seazn.club"})` equals `["seazn.club","www.seazn.club"]`, and `"https://seazn.club"` throws.
  - The values are pinned to the constants: `SEAZN_LIVE_TOKEN_TTL_SECONDS === 3600`.
- [ ] **Step 2: Run them and see them fail.** `cd apps/web && npx vitest run src/server/relay/__tests__/config.test.ts --reporter=json --outputFile=$SCRATCH/t8.json`.
- [ ] **Step 3: Implement** the four readers and the constants.
- [ ] **Step 4: Run the Step 2 command again.** Expect PASS. Mutate one guard: make `seaznHostedReplay` ignore LIVE, and the LIVE-unset test fails.
- [ ] **Step 5: Commit** `feat(stream): Seazn-hosted settings and flags`.

### Task 9: Migration V541 — the Seazn destination row

**Files:**

- Create: `db/migration/deltas/V541__seazn_destination.sql`
- Test: `apps/web/src/server/relay/__tests__/seazn-destination-migration.test.ts`, following `court-stream-migration.test.ts`. Extend `migration-shape.test.ts` if it enumerates the kind check.

**Plan decision:** use a `kind = 'seazn'` row on `org_stream_targets`, not a flag on `fixture_stream_settings`. `fixture_stream_sessions.target_id`, `court_stream_links.target_id` (not null), the picker, `fixtureStreamTarget`'s default and the session's `destination_kind` copy (`start.ts:477`) all key on a target row, so a row keeps every reader working and a flag would fork each of them.

**DDL:**

- Widen the kind check to `('youtube','facebook','twitch','kick','custom_rtmp','seazn')`.
- Replace `org_stream_targets_one_source` with `check ((kind = 'seazn' and rtmp_enc is null and youtube_connection_id is null) or (kind <> 'seazn' and (rtmp_enc is null) <> (youtube_connection_id is null)))`.
- `create unique index org_stream_targets_one_seazn on org_stream_targets (org_id) where kind = 'seazn'`.
- Insert one row per existing organisation: `label 'Seazn'`, `watch_url null`. Create function `ensure_seazn_target()` as `security definer` with `set search_path = public, pg_temp`, owned by the migration role, and an `after insert on organizations` trigger that inserts the row (`on conflict do nothing`). `org_stream_targets` has forced RLS with no policy (V410 `:407-408`), so an invoker-rights trigger would fail an org insert made by the app role.
- `fixture_stream_inputs` gains `access jsonb null`: the signed settings an input was CREATED with (`{"signed":true,"allowedOrigins":[…]}`), written once by provisioning and never updated (Task 12).
- `create table seazn_held_alerts (cf_video_id text primary key, session_id uuid not null references fixture_stream_sessions(id) on delete restrict, alerted_at timestamptz not null default now())`, with RLS as in V430. It is the one-alert-per-recording mark for the sweep hold (Task 18); it needs no replay row, so it works in Phase 1.
- `create table seazn_locked_videos (cf_video_id text primary key, input_row_id uuid not null references fixture_stream_inputs(id) on delete restrict, locked_at timestamptz not null default now())`, RLS as in V430: the mark that Task 13 has set `requireSignedURLs: true` on a recording (C3), so it is set once. `fixture_stream_inputs` also gains `recordings_locked_at timestamptz null`: Task 13's mark that every recording of a finished programme input is locked, so the input is never listed again.
- Drop and recreate `fixture_stream_sessions_one_active_target` (V479 `:285-289`) with an added `and destination_kind is distinct from 'seazn'`. `destination_kind` is written once at insert and never updated, so the predicate is stable.

  Plan decision: rows are created by trigger rather than lazily on read. `fixtureStreamTarget` is documented as writing nothing. The insert for existing orgs above is REQUIRED (it is the only backfill); RULES.md being greenfield means no other data needs migrating.

- [ ] **Step 1: Write the failing tests.**
  - A new org gets exactly one `seazn` row.
  - A second `seazn` row for that org fails 23505.
  - A `seazn` row with `rtmp_enc` set fails 23514. A `youtube` row with neither source still fails 23514 (the regression).
  - Two `live` sessions on one `seazn` target insert. Two on one pasted target still fail 23505.
  - The RLS state of `org_stream_targets` is unchanged (`rls-static.test.ts`), and `seazn_held_alerts` and `seazn_locked_videos` are listed.
  - An organisation inserted under `set local role app_user` (the app role) commits and gets its `seazn` row. Run it once with the function as invoker to see it fail, then as definer.
  - Existing suites that read an org's raw `org_stream_targets` rows now also see its `seazn` row: `server/youtube/__tests__/connections.test.ts` (`targetRows`, ~:56), `relay/__tests__/secret-columns.test.ts` (~:147), `relay/__tests__/token-store.test.ts` (~:110), `server/youtube/__tests__/connect-routes.test.ts` (~:1334). Where a test means external destinations, filter `kind <> 'seazn'`; never weaken an assertion otherwise. Re-grep `org_stream_targets` under `__tests__` for any other raw read.
- [ ] **Step 2: Run them and see them fail** (table shape missing). `cd apps/web && npx vitest run src/server/relay/__tests__/seazn-destination-migration.test.ts src/server/relay/__tests__/migration-shape.test.ts src/server/relay/__tests__/rls-static.test.ts --reporter=json --outputFile=$SCRATCH/t9.json`.
- [ ] **Step 3: Write V541.** Apply it to a fresh local schema per the `seazn-local-env` skill (`db:apply` then `sync:sports`). Never apply it to a shared database.
- [ ] **Step 4: Run the Step 2 command again, plus the four existing suites named in Step 1** (`connections.test.ts`, `secret-columns.test.ts`, `token-store.test.ts`, `connect-routes.test.ts`, and any other the re-grep found). Expect PASS.
- [ ] **Step 5: Commit** `feat(db): V541 Seazn destination row`.

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

- Consumes: `seaznHostedLive`, `seaznVideoOrigins` (Task 8). From Phase 0: the automatic-start backoff (Task 1: `auto_retry_after` on `org_youtube_connections`) and the per-fixture ceiling (Task 2: `YOUTUBE_MAX_BROADCASTS_PER_FIXTURE_PER_HOUR`, refusal `youtube_limit_reached`). Both live inside `prepareYoutubeBroadcast` (`start.ts:399`), after its `connection_id === null` return (`prepare.ts:143`). A Seazn target has no YouTube connection and prepares no broadcast (G1), so neither guard ever reaches it; this task pins that rather than adding a Seazn branch to either guard.
- Produces:
  - `isSeaznTarget(tx, orgId, targetId): Promise<boolean>` in `destination.ts`.
  - Refusals: 422 `seazn_unavailable` (LIVE off), and 503 `seazn_video_unconfigured` (LIVE on with no `SEAZN_VIDEO_ORIGINS` under a real driver; there is no signing key to check, C1), both raised before any provider call.

  Plan decision: coerce the mode rather than refuse passthrough. The phone's start and the automatic start read the fixture's stored `stream_mode`, and refusing would strand them. `composedUnavailable()` still refuses first, by name.

- [ ] **Step 1: Write the failing tests.** Use the fakes (`relay/fakes.ts`).
  - A passthrough create on Seazn makes a session with `mode = 'composed'` and `destination_kind = 'seazn'`, no `youtube_broadcasts` row, and no `readTargetSecret` call (spy).
  - A second fixture of the same org starts on Seazn while the first is live, so both are admitted (Review Focus 1).
  - LIVE off gives 422 `seazn_unavailable` with zero provider calls and no row.
  - LIVE on with `SEAZN_VIDEO_ORIGINS` unset under a non-fake driver mode gives 503 `seazn_video_unconfigured` with zero provider calls.
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

### Task 13: Cloudflare playback tokens and signed recordings

**Files:**

- Modify: `apps/web/src/server/relay/ports.ts`. `IngestProvider` gains:
  - `playbackToken(uid: string, o: { expiresAt: Date; downloadable?: boolean }): Promise<string>`, which is `POST /stream/{uid}/token` with `{ exp, downloadable }` (C1, C5);
  - `requireSignedVideo(videoId: string): Promise<"set" | "absent">`, which is `POST /stream/{videoId}` with `{ requireSignedURLs: true }`, checked against the echo (C3).
- Modify: `apps/web/src/server/relay/ingest-cf.ts` (both methods; the recorder writes the token answer as `[signed]`, never the token)
- Modify: `apps/web/src/server/relay/fakes.ts` (a token `fake.<uid>.<exp>[.dl]`; `videoAccess(videoId)` reads whether a video was signed; `listInputVideos` can be seeded to answer videos of other inputs, to stand in for C6)
- Create: `apps/web/src/server/video/cf-playback.ts`
- Create: `apps/web/src/server/usecases/seazn-recordings.ts` (`lockSeaznRecordings`)
- Modify: `apps/web/src/app/api/cron/stream-tick/route.ts`: a third pass `seazn` after the session pass. It never throws and answers `{ locked, refused, failed, deferred }`. Task 24 adds its replay counters.
- Modify: `apps/cron-worker/src/schedule.ts:172`: `failureCounts` gains `"data.seazn.failed"`; extend `drift.test.ts` so it finds the field.
- Test: `video/__tests__/cf-playback.test.ts`, `relay/__tests__/ingest-cf.test.ts`, `usecases/__tests__/seazn-recordings.test.ts`, `app/api/cron/stream-tick/route.test.ts`

**Interfaces — Produces:**

- `signLivePlayback(deps, inputUid: string, now: Date): Promise<{ src: string; expiresAt: string }>`. `src` is `https://${streamPlaybackHost()}/${token}/manifest/video.m3u8` (under the fake driver, `https://playback.fake.invalid/…`), with `exp = now + SEAZN_LIVE_TOKEN_TTL_SECONDS`.
- `signDownload(deps, videoUid: string, now: Date, ttlSeconds: number): Promise<string>` for Phase 2: a `downloadable: true` token, returning `https://<host>/<token>/downloads/default.mp4` (C5).
- **Recommendation 2026-11-21 (applied unless the owner objects), G-B, interim playback:** from session end until a verified Bunny copy exists, the public page plays the signed Cloudflare recording through the same token path as live. `signRecordingPlayback(deps, videoUid: string, now: Date): Promise<{ src: string; expiresAt: string }>` answers `https://${streamPlaybackHost()}/${token}/manifest/video.m3u8` with `exp = now + SEAZN_LIVE_TOKEN_TTL_SECONDS`, built by the same code and the same `deps.tokenCache` as `signLivePlayback` (keyed by uid, so a video uid and an input uid are two entries). Its caller passes a video uid read from `seazn_locked_videos` (a recording this task already signed), never one from a listing (C6). Task 14 is that caller.
- Both read a cache keyed by `(uid, downloadable)`: a cached token is reused while more than `SEAZN_TOKEN_REFRESH_BEFORE_SECONDS` of its life is left, else a new one is minted. The token is the same for every viewer, so the cache holds no viewer data. The cache is passed in `deps.tokenCache` (production wires one module-level instance; `createPlaybackTokenCache()` makes a fresh one), so every test builds its own empty cache and no test depends on run order.

  Plan decision: Cloudflare's token endpoint, not a key of our own (C1). The cache bounds the calls by live inputs, not viewers, so there is no per-page-view call and no rate-limit exposure to an audience.

- `lockSeaznRecordings(deps, { now, budgetMs }): Promise<{ locked: number; refused: number }>`:
  - It lists every programme input of a session with `destination_kind = 'seazn'` (live, ending or ended) whose `recordings_locked_at` is null, with `listInputVideos`. The flags are not read: a Seazn recording is signed whatever LIVE or REPLAY is, as Task 18 holds it whatever they are.
  - Each listed video whose own `inputId` is not that input is skipped and counted in `refused` (C6, the Global Constraint). Each one already in `seazn_locked_videos` is skipped. Every other one gets `requireSignedVideo`, then a `seazn_locked_videos` row.
  - When the session is terminal and older than `FINALISATION_GRACE_SECONDS`, and every listed video is finished and locked, it sets `recordings_locked_at`.
- Plan decision: the `seazn` pass runs INSIDE the tick's existing 45 s (`STREAM_TICK_BUDGET_MS`, `tick.ts:202`), never after it. It gets `min(SEAZN_PASS_BUDGET_MS = 8_000, what is left of the 45 s)` and starts no provider call with under 2 s left, so the whole firing still stops starting work at 45 s, inside the Worker's 60 s. When the session pass uses the whole budget, the pass defers to the next minute (`deferred`). A recording is therefore open for about a minute after it appears (C3); that is accepted.

- [ ] **Step 1: Write the failing tests.**
  - Tokens, on a mocked fetch: `playbackToken` POSTs `/stream/{uid}/token` with `exp` in seconds, and `downloadable: true` only when asked; the recorded payload and every thrown message hold no token.
  - `signLivePlayback`: the URL holds no `?` (the token is a path segment); two calls 10 min apart make one `playbackToken` call; a call 56 min after the first makes a second (the refresh window).
  - `signDownload` answers `https://<host>/<token>/downloads/default.mp4`.
  - `signRecordingPlayback` (recommendation 2026-11-21): the URL has the live shape (`…/<token>/manifest/video.m3u8`, no `?`); two calls 10 min apart for one video uid make one `playbackToken` call; a call for a video uid and a call for an input uid make two (the cache key is the uid).
  - Lock, on the fakes:
    - a live Seazn session's in-progress recording is signed in one pass (`videoAccess` true), and a second pass makes no second `requireSignedVideo` call;
    - **C6:** `listInputVideos` seeded to answer two videos of other inputs (one of them another org's Seazn input) beside the right one: only the right one is signed, `refused` is 2, and no call names the others;
    - a YouTube session's programme input is never listed;
    - `recordings_locked_at` stays null while the session is live and is set once it has ended past the grace with every video finished;
    - LIVE and REPLAY both off: a Seazn recording is still signed.
  - Route: the answer carries the `seazn` counters, and a throwing pass answers `seazn.failed: 1` while the session pass still runs.
- [ ] **Step 2: Run them and see them fail.** `cd apps/web && npx vitest run src/server/video/__tests__/cf-playback.test.ts src/server/relay/__tests__/ingest-cf.test.ts src/server/usecases/__tests__/seazn-recordings.test.ts src/app/api/cron/stream-tick/route.test.ts --reporter=json --outputFile=$SCRATCH/t13.json`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the Step 2 command again.** Expect PASS. Mutate once each: drop the `inputId` check (the C6 test fails); drop the `seazn_locked_videos` skip (the second-pass test fails).
- [ ] **Step 5: Commit** `feat(stream): Cloudflare playback tokens and signed Seazn recordings`.

### Task 14: Public video read and route

**Files:**

- Create: `apps/web/src/server/video/seazn-video.ts`
- Create: `apps/web/src/app/api/v1/public/fixtures/[id]/video/route.ts`, modelled on `realtime-token/route.ts` (`publicRateLimit`, `v1`, `reply`)
- Modify: `apps/web/src/server/api-v1/schemas/` (the public resource group; add `PublicFixtureVideo`) and the openapi registration
- Test: `apps/web/src/server/video/__tests__/seazn-video.test.ts`, `apps/web/src/app/api/v1/public/fixtures/[id]/video/route.test.ts`

**Interfaces — Produces:**

- `type PublicFixtureVideo = { live: { src: string; expiresAt: string } | null; replay: { partNo: number; player: "hls" | "embed"; src: string; expiresAt: string }[] }`.
- **Recommendation 2026-11-21 (applied unless the owner objects), G-B, interim playback:** `replay` holds the signed Cloudflare recording until a verified Bunny row exists, and Task 25 then swaps in the Bunny embed. In Phase 1 the rule reads `seazn_locked_videos` alone (V542 does not exist yet): for each locked recording of the fixture's Seazn sessions whose session is terminal, in `locked_at` order, one part: `partNo` = its position (1…n), `player: "hls"`, `src`/`expiresAt` from `signRecordingPlayback(deps, cf_video_id, now)` (Task 13). A recording not in `seazn_locked_videos` (not yet signed) is never listed. The public read keeps the same privacy as `live` (a private competition gives `replay: []`); the org read lists it. Task 25 adds the `embed` arm and the replay-rows exceptions.
- `seaznFixtureVideo(fixtureId: string, now: Date): Promise<PublicFixtureVideo>`. The fixture must be readable through `public_fixtures_v`, the same redaction `replayParts` relies on (`server/youtube/parts.ts:38`); if not, it returns `{live:null, replay:[]}`. `live` is set only when the fixture's latest session has `destination_kind = 'seazn'` and `state = 'live'`; `src` comes from `signLivePlayback` (Task 13) for its programme input uid (`readFirstInput(tx, sid, "programme")`). The LIVE flag is not read here: a Seazn session that exists keeps playing (controller ruling).
- `seaznFixtureVideoForOrg(orgId, fixtureId, now)`: the same answer, org-scoped, for Match Day and the organiser panel. It covers private competitions (spec G5).
- `GET /api/v1/public/fixtures/{id}/video` returns 200 `PublicFixtureVideo` with `Cache-Control: private, no-store`, so a signed URL is never cached at the edge.

- [ ] **Step 1: Write the failing tests.**
  - A Seazn live session gives `live.src` matching `/^https:\/\/playback\.fake\.invalid\/[^/?]+\/manifest\/video\.m3u8$/`.
  - Each of these gives `live: null`: state `warming`, `ending` or `completed`; a YouTube session; a private competition through the public read. The org read of the private one is set.
  - Interim replay (recommendation 2026-11-21): a `completed` Seazn session with one locked recording gives `live: null` and one part (`partNo 1`, `player "hls"`, `src` matching `/^https:\/\/playback\.fake\.invalid\/[^/?]+\/manifest\/video\.m3u8$/`). The same session whose recording is NOT in `seazn_locked_videos` gives `replay: []` (never an unsigned recording). A first session `completed` with a locked recording and a second one `live` gives both `live` and one part (a stop and restart). A YouTube session's recording is never listed, and a private competition gives `replay: []` through the public read and the part through the org read.
  - The route answers `no-store` and hits the rate limit like its sibling.
  - LIVE off still gives `live.src` for a Seazn session that is live (the controller ruling).
- [ ] **Step 2: Run them and see them fail.** `cd apps/web && npx vitest run src/server/video/__tests__/seazn-video.test.ts "src/app/api/v1/public/fixtures/[id]/video" --reporter=json --outputFile=$SCRATCH/t14.json`.
- [ ] **Step 3: Implement.** Then run `npm run openapi:gen`.
- [ ] **Step 4: Run the Step 2 command again.** Expect PASS.
- [ ] **Step 5: Commit** `feat(stream): public Seazn video read`.

### Task 15: Seazn player on the public match page

**Files:**

- Modify: `apps/web/package.json`: add `hls.js`, pinned to the exact current version (`npm view hls.js version`, no caret).
- Create: `apps/web/src/components/public-site/match-centre/seazn-player.tsx` (client: hls.js with `enableWorker: false`, and native HLS when `video.canPlayType("application/vnd.apple.mpegurl")`. It plays the live and the interim Cloudflare recording, a `replay` part with `player: "hls"` (recommendation 2026-11-21). Bunny replays use Bunny's embed, Task 25, B4)
- Create: `apps/web/src/components/public-site/match-centre/seazn-video-island.tsx` (client: fetches the Task 14 route)
- Create: `apps/web/src/components/public-site/match-centre/seazn-video-schedule.ts` (pure: when to fetch next)
- Modify: `apps/web/src/app/(public)/live/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/page.tsx:265,472`. When `seaznVideoPlan(fixtureId)` answers `"seazn"`, the page mounts `<SeaznVideoIsland fixtureId>` in the `replay` slot instead of `<ReplayEmbed>`. Every other fixture keeps today's slot byte for byte (spec §5.1).
- Create: `apps/web/src/server/video/seazn-video-plan.ts`: `seaznVideoPlan(fixtureId: string): Promise<"seazn" | "external">`, decided from the fixture's OWN facts, never from `fixtureStreamTarget` (`stream-codes.ts:496-509` answers `{id,label,source}` with no kind):
  - any session of the fixture with `destination_kind = 'seazn'` → `seazn`, **whatever LIVE is** (controller ruling: LIVE off stops new Seazn streams only). Phase 1 reads `fixture_stream_sessions` alone; the replay-rows arm is added in Task 25, once V542 exists;
  - any other session, or the fixture decided → `external`;
  - no session at all and not decided → `seazn` only when LIVE is on and the fixture's resolved target row has `kind = 'seazn'` (saved, or the org's default). The island then renders nothing until the route answers live. With LIVE off this arm answers `external`.

  Plan decision: the last arm is the one use of the default pick, and only for a fixture that has never streamed and is not over. A viewer who opens the page before kick-off still gets the player at live without reloading (Review Focus 3), and a past YouTube fixture with no saved choice can never flip, because it has sessions.

- Modify: `apps/web/src/proxy.ts:91`: `connect-src` and a new `media-src 'self' blob:` add `https://${streamPlaybackHost()}` (Phase 2 adds `frame-src https://iframe.mediadelivery.net` for the Bunny embed, Task 25).
- Modify: `src/dictionaries/{en,es,fr,nl}/public.json`: keys `seaznVideo.live` ("Live"), `seaznVideo.unavailable` ("The video can't play right now"), `seaznVideo.part` ("Part {n}").
- Test: `components/public-site/match-centre/__tests__/seazn-video-schedule.test.ts`, `components/public-site/match-centre/__tests__/seazn-video-island.test.tsx` (SSR markup), `app/(public)/.../fixtures/[fixtureId]/__tests__/page.test.ts`, `apps/web/e2e/public-fixture.spec.ts`, `apps/web/e2e/mobile/public-pages.spec.ts`

**Interfaces — Produces:**

- `nextVideoFetchMs(video: PublicFixtureVideo | null, now: Date): number | null` (null: no timer):
  - not live and no replay: `30_000`;
  - live: `expiresAt - now - SEAZN_TOKEN_REFRESH_BEFORE_SECONDS*1000`, floored at `30_000`;
  - replay only, every part `player: "embed"`: no timer. A replay plays in Bunny's iframe, and swapping its `src` would restart it, so the island re-reads the route only when the viewer picks a part whose `expiresAt` has passed (Task 25).
  - **Recommendation 2026-11-21 (applied unless the owner objects):** replay only, with an `hls` part (the interim Cloudflare recording): the live rule (earliest `expiresAt` − `SEAZN_TOKEN_REFRESH_BEFORE_SECONDS`, floored at `30_000`). That re-read also picks up the swap to the Bunny embed once Task 25 answers one for that part.
- `<SeaznVideoIsland fixtureId={string} endpoint?: "public" | "org" />`. The default `public` reads `/api/v1/public/fixtures/{id}/video`; `org` reads `/api/v1/fixtures/{id}/video` (Task 17).
- `<SeaznPlayer src={string} title={string} />`. It keeps one `<video>` across `src` changes for the same session, and swaps the source at the current time, so a refreshed token does not restart the picture.
- **Recommendation 2026-11-21 (applied unless the owner objects), G-B:** with no `live` and a non-empty `replay`, the island renders the parts in `partNo` order, one `<SeaznPlayer>` at a time for `player: "hls"` parts, with a part picker ("Part {n}", `seaznVideo.part`) only when there are two or more. A fixture whose session has ended therefore keeps a picture from the moment its recording is signed. Task 25 adds the `embed` arm to this same rendering.
- Plan decision: the player loads through a client island rather than with tokens minted in the server render. The page is ISR (`revalidate = 30`, `page.tsx:174`), and a token baked into cached HTML would be served past its expiry. The island also catches warming turning to live without a reload.

- [ ] **Step 1: Write the failing tests.**
  - Schedule: `null` gives 30 000. Live with an expiry 60 min away gives 55 min (Review Focus 3). Live with an expiry 2 min away gives 30 000. Replay only, no live, every part `embed`, gives `null`; replay only with an `hls` part whose expiry is 60 min away gives 55 min (recommendation 2026-11-21).
  - Island (SSR markup, recommendation 2026-11-21): no live and one `hls` part renders one `<SeaznPlayer>` and no picker; two `hls` parts render the picker "Part 1", "Part 2" and one player.
  - Page: a YouTube fixture renders `ReplayEmbed` and no `data-testid="seazn-video"`. A Seazn fixture renders the island and no YouTube markup (anchor the assertion on `="`).
  - `seaznVideoPlan` with LIVE off: a fixture with an ended Seazn session answers `seazn`, and the page renders the island, never `ReplayEmbed` (the ruling). An unstarted fixture whose default would be Seazn answers `external`.
  - `seaznVideoPlan` with LIVE on: a past YouTube fixture with no saved choice (its org's default now resolves Seazn) answers `external`, and the page renders `ReplayEmbed` with its parts (the blocker regression). An unstarted fixture whose default is Seazn answers `seazn`. A fixture with one Seazn session answers `seazn` even after the org's default changes.
  - Player: rendering `<SeaznPlayer>` with `src` A then `src` B (a token refresh) keeps the same `<video>` element instance (same node; a ref counter of mounts stays at 1), and hls.js `loadSource` is called with B without `destroy()` (spy on a mocked hls.js).
  - e2e, fake driver: pick Seazn and Go live → the public page shows `[data-testid=seazn-player] video` with a `src` or `data-src` on the fake host, with no reload between warming and live. The island re-reads on its own 30 s timer, so this one assertion carries an explicit `{ timeout: 45_000 }` (longer than one re-read) rather than the default; no other wait. At 320, 768 and 1280: no horizontal scroll.
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

**The phone's day read (capture app's Watch live link; owner ruling 2026-11-20, option A).** The phone's Match Day list
(`GET /api/v1/match-day-code`, capture-matchday-day.v1) is a different shape from the organiser board above, and it
gets its own field. The phone shows a "Watch live" link that opens the public match page in the browser. It has no
in-app player. So the phone needs the page's address and nothing else: no playback URL and no token.

- Modify: `apps/web/src/server/api-v1/capture-schemas.ts` (`CaptureMatchdayRow`, about line 362): add
  `live_seazn: z.strictObject({ watch_url: z.string().regex(CAPTURE_MATCHDAY_WATCH_URL_RE) }).nullable()`. The
  pinned shape is `live_seazn: { watch_url: string } | null`. The field is required on every row, and `null` means
  "not live on Seazn". `CAPTURE_MATCHDAY_WATCH_URL_RE` is a new exported constant beside `CAPTURE_SCORING_LINK_URL_RE`:
  `^https://[a-z0-9.-]+(?::\d+)?/live/[^/?#]+/[^/?#]+/[^/?#]+/fixtures/[0-9a-fA-F-]{36}$`. That is an absolute https
  URL with no query and no fragment, so it can carry no token.
- Modify: `apps/web/src/server/usecases/match-day-code-view.ts` (`MatchDayCodeRowView` and `codeRowViews`, about lines
  35-57 and 339-361). `codeRowViews` takes a `ReadonlyMap<fixtureId, watchUrl>` of the rows that are live on Seazn.
  `getMatchDayForCode` builds that map. A row gets `{ watch_url }` exactly when its fixture has a live Seazn session AND its public page is readable (the fixture is in `public_fixtures_v`; a private competition's page answers `live: null`, Task 14) AND `siteOrigin()` is https. Otherwise `null`: a local dev server on `http://localhost` gives no link rather than a value the strict contract refuses.
  That is the same predicate the board's `live_seazn: true` uses (above), on the same playing ids (the courts' playing
  `current` and `playingNoCourt`). The value is `` `${siteOrigin()}${routes.publicFixture(orgSlug, compSlug, divSlug, fixtureId)}` ``
  (`lib/site-origin.ts`, `lib/routes.ts:180`), the public match page on this deployment's own host
  (`https://seazn.club` in production, `https://stg.seazn.club` on staging). The phone accepts only its build's host
  and hides the link for any other. Every other row, and every candidate row in `match-day-code-call.ts` (which
  reuses `codeRowViews`), gets `null`.
- Modify: `scripts/gen-capture-contracts.ts` (the `capture-matchday-day.v1.json` entry, about line 272): prose for
  `courts.now.live_seazn` / the row's `live_seazn`: "While the match is streaming live to Seazn, the public match
  page's address on this server's own host (`watch_url`: https, no query, no fragment, never a token); null
  otherwise. The phone opens it in the browser (capture Watch live)." Re-run
  `node --experimental-strip-types scripts/gen-capture-contracts.ts`. This regenerates
  `docs/contracts/capture-matchday-day.v1.json` and `capture-matchday-call.v1.json` (whose candidates carry the row).
  Add the fixture `docs/contracts/fixtures/capture-matchday-day.v1/valid-live-seazn.json` (one playing row with
  `live_seazn: {watch_url: "https://seazn.club/live/club/open/singles/fixtures/<uuid>"}`, every other row `null`), and
  `invalid-live-seazn-query.json` (a `watch_url` with `?t=…`). Add `"live_seazn": null` to every existing row of every
  existing fixture. Move the two sha256 constants in `apps/web/src/server/api-v1/__tests__/capture-contract.test.ts:60`
  and the call contract's own.
- Test: `apps/web/src/server/usecases/__tests__/match-day-code-view.test.ts`,
  `apps/web/src/server/api-v1/__tests__/capture-contract.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - A Seazn live match on a playing court gives `live_seazn: true` and `live_video: null`, and the board JSON contains no `playback.fake.invalid`.
  - A YouTube one is unchanged.
  - e2e: a Match Day court with a live Seazn match shows `[data-testid=seazn-player]`. At 320 there is no horizontal scroll.
  - Phone day read (`match-day-code-view.test.ts`): a Seazn live match on a playing court gives
    `live_seazn: { watch_url: "<siteOrigin>/live/<org>/<comp>/<div>/fixtures/<id>" }`. A YouTube live match, a match
    that is not live, a queued row and a finished row all give `live_seazn: null`. The day read's JSON contains no
    `playback.fake.invalid` and no `?`. The test pins the origin with `vi.stubEnv("NEXT_PUBLIC_BASE_URL", "https://seazn.club")` and builds the expected URL from that literal, not from `siteOrigin()`.
  - A Seazn live match of a private competition gives `live_seazn: null`. With `NEXT_PUBLIC_BASE_URL` stubbed to `http://localhost:3000`, a Seazn live match gives `null`.
  - Contract (`capture-contract.test.ts`): `valid-live-seazn` validates and `invalid-live-seazn-query` is refused.
    The day read built by the use case validates against the regenerated `capture-matchday-day.v1.json`.
- [ ] **Step 2: Run them and see them fail.** `cd apps/web && npx vitest run src/components/v2/match-day/__tests__/match-day-ssr.test.tsx src/server/usecases/__tests__/match-day-code-view.test.ts src/server/api-v1/__tests__/capture-contract.test.ts <the match-day*.test.ts that covers live_video> --reporter=json --outputFile=$SCRATCH/t17.json`; `npx playwright test e2e/match-day.spec.ts e2e/mobile/match-surfaces.spec.ts` (whole files).
- [ ] **Step 3: Implement.** Then run `npm run openapi:gen` and `node --experimental-strip-types scripts/gen-capture-contracts.ts`.
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
- The sweep removes from `ownedVideos` every video whose `inputId` is the programme input of a session with `destination_kind = 'seazn'`, whatever the flags. Their deletion is the mover's (Task 24) once Bunny has a verified copy and `SEAZN_CF_DELETE_DELAY_MINUTES` (60) has passed (recommendation 2026-11-21), or Cloudflare's own at 30 days. The 3-day hold below is unchanged. Inputs that still name a held video are deferred by the existing rule (`:552-555`).
- For each held video older than `RECORDING_RETENTION_DAYS` with no `seazn_held_alerts` row and no `playable` replay: one `captureError(new Error("relay sweep: a Seazn recording past 3 days has not reached Bunny"), { route: "relay.sweep.seazn_held", extra: { sessionId, cfVideoId } })`, then an insert into `seazn_held_alerts` (V541). That is one alert per recording, ever, with or without a replay row.
- Held recordings count against the Cloudflare storage block. Admission and the sweep already read live usage (`storageHeadroomMinutes`), so a full block refuses new starts by the existing rule; nothing new is added for it.

- [ ] **Step 1: Write the failing tests.**
  - REPLAY off, LIVE on: a 4-day-old Seazn programme video is not deleted, its input is not deleted, `seaznHeld 1`, `captureError` is called once, and a second pass makes no second call (the ruling).
  - The same with REPLAY on and no replay row: also held.
  - A 4-day-old YouTube programme video: deleted (the regression).
  - A camera recording of a Seazn session is still deleted at the end of the session (step 2, `:349-362`, unchanged).
  - C6 (Review Focus 11): the listing answers, beside the held Seazn video, 4-day-old videos of inputs this database does not own and a video whose `inputId` is null. None is deleted, the held one is still held, and `foreignVideosSkipped` counts them. (Step 4's ownership filter already does this; the test pins that the hold change keeps it.)
- [ ] **Step 2: Run them and see them fail.** `cd apps/web && npx vitest run src/server/usecases/__tests__/relay-sweep.test.ts --reporter=json --outputFile=$SCRATCH/t18.json`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the Step 2 command again.** Expect PASS. Mutate the hold filter by removing the destination predicate, and the YouTube test fails.
- [ ] **Step 5: Commit** `feat(stream): the sweep holds Seazn recordings past 3 days`.

### Task 19: Phase 1 smoke and walkthrough

**Files:**

- Create: `scripts/smoke/suites/seaznHosted.ts`, registered as `streamTargets.ts` is. It covers the Seazn row present and first, the start refused while LIVE is off, and the public video route `no-store`.
- Create: `apps/web/e2e/walkthrough/seazn-hosted.spec.ts`. On the fake driver, organiser and spectator: Seazn pre-selected → Go live → the spectator sees the player → Stop → the live player goes and the page shows its ended state; once a tick has signed the fake's recording, the page plays it as the interim replay in the same player (recommendation 2026-11-21, Task 14). The database has 0 `youtube_broadcasts` rows and 0 `add_output` provider calls for the fixture.

- [ ] **Step 1: Write both.**
- [ ] **Step 2: Run them.** `npx playwright test e2e/walkthrough/seazn-hosted.spec.ts`, and the smoke suite by its runner. Expect PASS.
- [ ] **Step 3: Run the scoped regression.** Run every vitest path from Tasks 8–18 in one JSON run, check that `numTotalTests` equals the per-task sum, then `npx playwright test e2e/walkthrough/stream-relay.spec.ts e2e/walkthrough/streaming-destinations.spec.ts` on whole files.
- [ ] **Step 4: Commit** `test(stream): Seazn live smoke and walkthrough`.

---

# Phase 2 — Replay on Bunny (`SEAZN_HOSTED_REPLAY`)

### Task 20: Record the Bunny POC results and probe what remains

B1–B6 settled the fetch answer (the id is in the body), the statuses, both token formulas and the webhook's shape. Five behaviours are still open.

**Files:**

- Create: `apps/web/src/server/video/__tests__/bunny.live.test.ts`, gated by `BUNNY_LIVE_PROBE=1`
- Modify: `docs/superpowers/specs/2026-11-20-seazn-hosted-probes.md` (Task 7 created it with B1–B6)

- [ ] **Step 1: Write the probe.** Against the staging library, with the B3 security on:
  - **collections:** `POST /library/{lib}/collections {name}` answers a `guid`; a fetch with `collectionId` answers an `id` (B1) whose `GET /videos/{id}` names that collection;
  - **embed past expiry:** an embed loaded with `expires` = now + 60 s keeps playing a 3-min video to its end (drive a headless browser on a page served from an allowed referrer host, or record it by hand and say so);
  - **MP4 fallback at the 720p cap:** `GET /videos/{id}` lists `availableResolutions` with nothing above 720p; `https://{cdn}/bcdn_token=…/{guid}/play_{h}p.mp4` (B5 token form) answers 200 with an allowed `Referer` and 403 without one, for the highest `h` listed;
  - **delete:** `DELETE /videos/{id}` answers 200, and a second answers 404.

  Cleanup removes only the video ids and the collection this probe created.

- [ ] **Step 2: Run it and record each result.** If an embed stops at its token's expiry, raise it before Task 25: the island must then re-read the route and swap the `src` shortly before expiry, accepting a restart. If the MP4 file name differs, Task 22's `openDownload` follows what was measured.
- [ ] **Step 3: Commit** `test(stream): record Bunny POC results; probe what remains`.

### Task 21: The `ReplayHost` port, its fake and config

**Files:**

- Create: `apps/web/src/server/video/replay-ports.ts`
- Create: `apps/web/src/server/video/replay-fake.ts`
- Create: `apps/web/src/server/video/replay-driver.ts`
- Modify: `apps/web/src/server/relay/config.ts`. It reads `REPLAY_DRIVER` (`fake` | `bunny`, where unset under the fake relay driver is `fake`), `BUNNY_STREAM_LIBRARY_ID`, `BUNNY_STREAM_API_KEY`, `BUNNY_STREAM_READONLY_KEY`, `BUNNY_STREAM_CDN_HOST` and `BUNNY_TOKEN_KEY`. `bunnyConfig()` throws naming the missing variable and never echoes a value. These are server config only.
- Modify: `apps/web/src/server/usecases/stream-sessions/deps.ts` (`SessionDeps` gains `replay?: ReplayHost`, like `youtube?`)
- Test: `apps/web/src/server/video/__tests__/replay-fake.test.ts`, `relay/__tests__/config.test.ts`

**Interfaces — Produces:**

```ts
export type ReplayState = "processing" | "playable" | "failed" | "absent";
export interface ReplayHost {
  createCollection(orgId: string): Promise<string>; // named `org:<orgId>`; the caller caches the id, nothing looks it up by name
  fetchFromUrl(a: {
    collectionId: string;
    title: string;
    url: string;
  }): Promise<string>; // the new video's id, from the fetch answer's `id` (B1)
  video(videoId: string): Promise<{
    state: ReplayState;
    lengthSeconds: number | null;
    title: string | null; // read only when the webhook names a guid no row holds (Task 27); never searched
    heights: number[]; // the encoded resolutions, never above 720 (B2)
  }>;
  remove(videoId: string): Promise<"deleted" | "absent">;
  signedEmbed(
    videoId: string,
    now: Date,
    ttlSeconds: number,
  ): { src: string; expiresAt: string }; // pure, no call
  openDownload(
    videoId: string,
  ): Promise<{
    body: ReadableStream<Uint8Array>;
    bytes: number | null;
    fileName: string;
  }>; // server side only (B5)
  watchMinutes(videoId: string, from: Date, to: Date): Promise<number>; // Phase 3
}
```

- The video API's `status` maps as follows: 4 → `playable`; 5 and 6 → `failed`; 0–3, 7 and 8 → `processing`; 404 → `absent` (B2 saw 2 → 3 → 4). The webhook's statuses are a different list (B6) and are mapped in Task 27, never through this table.
- `REPLAY_EMBED_TOKEN_TTL_SECONDS = 3600`. Task 20 decides whether an embed outlives it; the number stays either way.
- Plan decision: one Bunny collection per org, named `org:<orgId>`, with its id cached in `org_video_collections` (Task 23) and created under that row's lock, so two movers never create two. A crash between create and insert leaves one empty collection, which is harmless. The spec recommends per-org collections; they make an org's replays listable and deletable as a set.
- Plan decision: the Bunny keys are env secrets read through `config.ts`, like the Cloudflare token. They are never stored in the database.

- [ ] **Step 1: Write the failing tests.**
  - The fake's `fetchFromUrl` answers a guid; two fetches of one title answer two different guids; `video(guid).title` is the title sent.
  - The state machine is `processing` → `playable` after `fake.advance(guid)`, and `fake.fail(guid)` gives `failed`. `heights` never holds a value above 720.
  - `openDownload` on the fake streams fixed bytes and answers `fileName` ending `.mp4`.
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
  - Base URL `https://video.bunnycdn.com/library/{libraryId}`, with the `AccessKey` header (`BUNNY_STREAM_API_KEY`).
  - `fetchFromUrl` answers the body's `id` (B1) and throws when it is missing.
  - `signedEmbed` answers `https://iframe.mediadelivery.net/embed/{libraryId}/{guid}?token={t}&expires={e}`, with `t = hex(sha256(BUNNY_TOKEN_KEY + guid + e))` (B4).
  - `openDownload` fetches `https://{BUNNY_STREAM_CDN_HOST}/bcdn_token={t}&expires={e}&token_path=%2F{guid}%2F/{guid}/play_{h}p.mp4`, where `h` is the highest of `video().heights` and `t = base64url-no-pad(sha256(BUNNY_TOKEN_KEY + "/{guid}/" + e + "token_path=/{guid}/"))` (B5; a plain sha256, not an HMAC). It sends `Referer: https://{the first SEAZN_VIDEO_ORIGINS host}/`, since the library blocks any other (B3), and answers the body as a stream, never buffered. Task 20's measured file name wins if it differs.
  - Each call is recorded through the same redaction floor as `ingest-cf.ts` (`sanitise.ts`), so the AccessKey is never written.
  - The `fetchFromUrl` body's `url` is a signed Cloudflare download (its token is a path segment). Before the call is recorded in `stream_provider_calls`, the token segment is replaced by `[signed]`, and the `title` is kept. A CDN token is never recorded either.

- [ ] **Step 1: Write the failing tests.**
  - `fetchFromUrl` POSTs `/videos/fetch?collectionId=c1` with body `{url,title}` and answers the `id` of the reply; a reply with no `id` throws.
  - `video` maps statuses 4, 5, 3 and 404 as Task 21 states, and reads `availableResolutions` into `heights`.
  - `signedEmbed` and the `openDownload` URL each match a vector computed by hand in the test from the B4 and B5 formulas (fixed key, guid and expiry), not by calling the code under test.
  - `openDownload` sends the `Referer` header and asks for `play_720p.mp4` when `heights` is `[240,360,480,720]`.
  - The `AccessKey`, the token key and the read-only key are absent from every thrown message and every recorder payload.
  - The recorded `fetchFromUrl` payload holds `https://<host>/[signed]/downloads/default.mp4` and no substring of the token passed in; a thrown fetch error holds no token either.
- [ ] **Step 2: Run them and see them fail.** `cd apps/web && npx vitest run src/server/video/__tests__/replay-bunny.test.ts --reporter=json --outputFile=$SCRATCH/t22.json`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expect PASS.
- [ ] **Step 5: Commit** `feat(stream): Bunny Stream adapter`.

### Task 23: Migration V542 — replays

**Files:**

- Create: `db/migration/deltas/V542__seazn_replays.sql`
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
  - `cf_deleted_at timestamptz null`, `verified_at timestamptz null`, `bunny_cleaned_at timestamptz null` (a deleted row whose Bunny copies have all been removed);
  - **Recommendation 2026-11-21 (applied unless the owner objects), G-C, G-D:** `verified_at` is set when the Bunny copy passes the length and rendition check (Task 24); `state 'playable'` means "verified", and the Cloudflare delete waits for `verified_at` + 60 min. Two columns carry what that check compares against, written at discovery from the Cloudflare listing: `cf_duration_seconds int null` (`IngestVideo.durationSeconds`) and `cf_height int null` (`IngestVideo.height`);
  - `deleted_at timestamptz null`, `deleted_by uuid null`, `deleted_reason text null check (deleted_reason in ('organiser','org_deleted'))`;
  - `created_at timestamptz not null default now()`.
- Index on `(state, next_attempt_at)` where `state not in ('playable','deleted') or cf_deleted_at is null or bunny_cleaned_at is null` (it must cover every row the mover claims: a `playable` row still on Cloudflare, a `deleted` row awaiting cleanup). Index on `(fixture_id, recorded_at)`.
- Check: `bunny_video_id is not null or state in ('found','downloading','fetching','failed','deleted')`. A second check (recommendation 2026-11-21): `state <> 'playable' or verified_at is not null`.
- `fixture_stream_inputs` gains `replays_discovered_at timestamptz null`: discovery's mark that it has listed this programme input's finished recordings for good.
- `bunny_webhook_events (event_id text primary key, received_at timestamptz not null default now())`: the dedupe mark for Bunny's `EventId` (B6, Task 27).
- RLS on all three tables follows V430: enable + force, no policy, no grant.
- View `public_fixture_seazn_replays_v (fixture_id, part_no, bunny_video_id)`. It keeps `state = 'playable'` rows with their stored `part_no` (gaps allowed while a part is still processing), under the same WHERE redaction as `public_fixture_youtube_parts_v`. Not granted to `app_user`.

  Plan decision: `on delete restrict` on `org_id`. No product path hard-deletes an organisation (`extra-orgs.ts:301`), and a cascade would drop the Bunny ids that Task 31 needs to delete the videos.

- [ ] **Step 1: Write the failing tests.**
  - A replay row with `state 'playable'` and no `bunny_video_id` fails 23514, and so does one with `state 'playable'` and no `verified_at` (recommendation 2026-11-21).
  - A duplicate `cf_video_id` fails 23505.
  - Deleting an org with a replay fails 23503.
  - The view shows two playable rows as parts 1 and 2; with part 1 still `encoding`, part 2 shows as 2 (not renumbered to 1); a private competition has no row.
  - A second row with the same `(fixture_id, part_no)` fails 23505.
  - A second `bunny_webhook_events` row with one `event_id` fails 23505.
  - `rls-static.test.ts` lists all three tables.
- [ ] **Step 2: Run them, write V542 and apply it locally, then run them again.** Expect FAIL first, then PASS.
- [ ] **Step 3: Commit** `feat(db): V542 Seazn replays`.

### Task 24: Move recordings to Bunny

**Files:**

- Create: `apps/web/src/server/video/domain/replay-move.ts` (pure: the next step for a row)
- Create: `apps/web/src/server/usecases/seazn-replays.ts` (`discoverSeaznRecordings`, `moveSeaznRecordings`)
- Modify: `apps/web/src/server/relay/ports.ts`, `ingest-cf.ts` and `fakes.ts`: `IngestProvider` gains `createDownload(videoId): Promise<"ready" | "inprogress">` (`POST /stream/{uid}/downloads`, then read `default.status`; idempotent). The download goes with the video when `deleteVideo` runs.
- Modify: `apps/web/src/app/api/cron/stream-tick/route.ts`: the `seazn` pass (Task 13) runs discovery and the mover after the lock, inside the same budget, and its answer gains `{ discovered, moved, playable }`. `data.seazn.failed` (Task 13) counts their failures too.
- Modify: `apps/web/src/server/relay/config.ts`: `SEAZN_REPLAY_DELAY_MINUTES = 15` (owner ruling 2026-11-21), `SEAZN_CF_DELETE_DELAY_MINUTES = 60` and `SEAZN_REPLAY_UNDECIDED_FALLBACK_HOURS = 6` (recommendations 2026-11-21, applied unless the owner objects), beside `SEAZN_LIVE_TOKEN_TTL_SECONDS`. This task's other constants (`SEAZN_FETCH_STALE_MINUTES`, `SEAZN_POLL_BACKSTOP_MINUTES`, `SEAZN_CLAIM_LEASE_SECONDS`) go there too.
- Modify (recommendation 2026-11-21, G-E): `apps/web/src/server/usecases/stream-sessions/auto-stop.ts`, `apps/web/src/components/v2/fixture-stream-panel.tsx` and `src/dictionaries/{en,es,fr,nl}/ui.json`.
- Test: `video/domain/__tests__/replay-move.test.ts`, `usecases/__tests__/seazn-replays.test.ts`, `app/api/cron/stream-tick/route.test.ts`, `relay/__tests__/config.test.ts` (the three constants are pinned: `=== 15`, `=== 60`, `=== 6`), `usecases/__tests__/stream-auto-stop.test.ts` (G-E)

**Interfaces — Produces:**

- `nextReplayStep(row: ReplayRow, now: Date): ReplayStep`, a transition table:
  - `found` → `create_download`;
  - `downloading`: `create_download` again until `ready`, then `fetch`;
  - `fetching`: the fetch call answers the guid (B1), which is written with the move to `encoding`. A `fetching` row with no guid whose `state_at` is older than `SEAZN_FETCH_STALE_MINUTES = 30` goes back to `downloading`, and the fetch is sent again.

    Plan decision: 30 min. The guid comes back in the fetch's own answer, so a row left in `fetching` means that answer was lost (a crash or a timeout after Bunny accepted). The lost first copy is removed when its webhook names a guid no row holds (Task 27);

  - `encoding` → `poll_state`, at most once per `SEAZN_POLL_BACKSTOP_MINUTES = 15` (a poll that is still `processing` sets `next_attempt_at = now + 15 min`). The webhook (Task 27) is the primary signal; this poll catches a webhook Bunny dropped (B6). `playable` runs the verify check below (recommendation 2026-11-21): a pass sets state `playable`, `verified_at = now` and `next_attempt_at = verified_at + SEAZN_CF_DELETE_DELAY_MINUTES`, and a fail goes the way `failed` goes; `failed` removes the guid, clears `bunny_video_id` and sets state `failed`; `absent` (the guid is gone) clears `bunny_video_id` and goes back to `found`;
  - `playable` with `cf_deleted_at` null → `delete_cf`, only once `now >= verified_at + SEAZN_CF_DELETE_DELAY_MINUTES` (the delayed delete is the owner's ruling 2026-11-21; the 60-min value is a recommendation); before that the step is `wait`, never `delete_cf`;
  - `deleted` with `bunny_cleaned_at` null → `cleanup`: `remove` the row's `bunny_video_id` if any, delete the Cloudflare copy if still there, then set `bunny_cleaned_at`. A guid that lands after the delete is removed by the mover that holds it, or by the webhook (Task 27).
  - A failure sets `attempts+1` and `next_attempt_at = now + min(2^attempts, 60) minutes`.
  - `failed` retries from `found` while `now - recorded_at < 30 days`.
- `discoverSeaznRecordings(deps, now)`: for each programme input of a Seazn session that ended more than `FINALISATION_GRACE_SECONDS` ago and whose `replays_discovered_at` is null, calls `listInputVideos(programme)`. **Owner ruling 2026-11-21 (G-A):** the input is also eligible only when its fixture's `finished_at` (the result stamp `auto-stop.ts` reads) is at least `SEAZN_REPLAY_DELAY_MINUTES` old (15 min). **Recommendation 2026-11-21 (applied unless the owner objects), G-F, the undecided fallback:** or, for a fixture that is still not decided (`finished_at` null), when the session's end stamp (the one the `FINALISATION_GRACE_SECONDS` test reads) is at least `SEAZN_REPLAY_UNDECIDED_FALLBACK_HOURS` (6 h) old. So an abandoned or void fixture still gets its replay moved, and Task 18's 3-day alert is for failures only. Each listed video whose own `inputId` is not that programme input is skipped and counted (C6). It inserts a `found` row per remaining video (`on conflict (cf_video_id) do nothing`, `part_no` assigned as V542 says, `cf_duration_seconds` and `cf_height` from the listing's `durationSeconds` and `height`). When every one of them is finished (`inProgress === false`), it sets `replays_discovered_at`, and the input is never listed again.
- **Recommendation 2026-11-21 (applied unless the owner objects), G-C, "clean and good":** `verifyReplayCopy(row, bunny: { state; lengthSeconds; heights }): { ok: true } | { ok: false; reason: "length" | "rendition" | "state" }`, pure, in `replay-move.ts`. It passes only when ALL hold: `bunny.state === "playable"`; `|bunny.lengthSeconds − row.cf_duration_seconds| <= 2` (±2 s of the Cloudflare duration; a null on either side fails); and `bunny.heights` lists the required rung, the largest of 240, 360, 480 and 720 that is not above `row.cf_height` (so 720p, or the source's height if lower; a null `cf_height`, or one under 240, fails). `ReplayHost.video()` (Task 21) already returns `lengthSeconds` and `heights`, so no port change. The poll runs it on a video the API reports finished. The webhook (Task 27) runs the same function.
- **Owner ruling 2026-11-21 (G-D):** the Cloudflare copy is deleted after the swap, within 1–2 h. **Recommendation 2026-11-21 (applied unless the owner objects):** the value is 60 min, so the mover's `delete_cf` step runs only from `playable` and only at or after `verified_at + SEAZN_CF_DELETE_DELAY_MINUTES`. The webhook never deletes (Task 27). The Cloudflare recording is also what the public page plays until the swap (G-B, Tasks 14 and 25), so the delay is the time open players have to finish.
- **Recommendation 2026-11-21 (applied unless the owner objects), G-E:** a Seazn session still `live` at `fixtures.finished_at + SEAZN_REPLAY_DELAY_MINUTES` (the same constant) is stopped with end reason `auto_stopped`, in every mode (Stream switch off, operator phone, automatic phone), so the move always starts. It is an extra arm beside the existing `autoStopApplies` gating in `auto-stop.ts` (read it first): that gating fires only when the switch is on AND the phone is automatic, or for a court session, with delays of 180 s (per-fixture code) and 30 s (court), and it does not change for any session that is not a Seazn one (G1: a pasted-key and a YouTube session decided long ago are not touched). `autoStopOf(sessionId)` (the read model behind the panel's "stops about N after the result" line) must report the delay the tick will use for a Seazn session, the existing delay when the existing rule applies and `SEAZN_REPLAY_DELAY_MINUTES` otherwise, so the line never promises a stop the tick will not make. `fixture-stream-panel.tsx` names the Seazn case with a new key beside `stream.auto.liveLine` (all four dictionaries; the existing "Automatic: stops about N …" wording is wrong when the stop is Seazn's own, because the phone may not be automatic).
- `moveSeaznRecordings(deps, { now, budgetMs })`. Concurrency and idempotency rules:
  - Rows are claimed in a short transaction: `select … where next_attempt_at <= now and (state not in ('playable','deleted') or (state = 'playable' and cf_deleted_at is null) or (state = 'deleted' and bunny_cleaned_at is null)) … for update skip locked limit 10`. The same transaction sets `next_attempt_at = now + SEAZN_CLAIM_LEASE_SECONDS (= 120)` on every claimed row and commits, so a run starting after that commit does not claim the row again; a crashed run's rows come back after the lease.
  - The next state is written and committed BEFORE the provider call (`found → downloading`, `downloading → fetching` before `fetchFromUrl`), so a crash after the call is resumed by the stale timeout, never by a blind second fetch.
  - Every state update is conditional: `update … set state = $next, state_at = now() where id = $id and state = $expected`. Zero rows updated means another actor moved it (an organiser delete, or the webhook), and the pass drops the row; a guid the fetch just answered is then `remove`d, so nothing is left on Bunny.
  - The org's collection id is read from `org_video_collections`, or created by `createCollection` and inserted under that row's lock.
  - The Bunny title is `seazn:{sessionId}:{cfVideoId}`. Nothing searches by it; the webhook reads it to tell our stray guids from other videos (Task 27). The fetch URL is `signDownload(cfVideoId, now, 6*3600)` (Task 13). `deleteVideo` on Cloudflare runs only from `playable` and only at or after `verified_at + SEAZN_CF_DELETE_DELAY_MINUTES`, by the row's stored `cf_video_id` (checked at discovery, C6), never from a listing; `in_progress` leaves `cf_deleted_at` null for the next tick.
- Plan decision: run from the stream tick (prod every minute) rather than from `persist.ts` or the daily sweep. `persist` runs inside the session's row transaction, where provider calls do not belong, and a daily pass would hold every recording on Cloudflare for up to a day for no reason. The tick already has the budget and failure-counter pattern (`endYoutube`), and Task 13's `seazn` pass.
- Plan decision: Bunny fetches Cloudflare's 1080p MP4 download (C4) through a `downloadable` token (C5); Bunny encodes it at 720p at most (B2). B1 confirmed that Bunny accepts the URL.

- [ ] **Step 1: Write the failing tests.**
  - Table sweep: every state × {success, provider throws} gives the expected step or backoff. The sweep reports how many cases it checked, and zero fails.
  - Usecase on the fakes:
    - a stopped and restarted Seazn match (two sessions) yields two rows ordered by `recorded_at` (Review Focus 4; seed its fixture decided 15+ min ago, G-A);
    - with `fake.fail(guid)`, the Cloudflare video is never deleted, the failed guid is removed, and `attempts` grows with backoff (Review Focus 5);
    - `deleteVideo` is never called before `verified_at + 60 min` (recommendation 2026-11-21): at 59 min after verification (fake clock) no call, at 60 min exactly one. Assert the call order too: `deleteVideo` index > `state→playable` index. The 60 is a literal in the test, not `SEAZN_CF_DELETE_DELAY_MINUTES` read back;
    - **C6** (Review Focus 11): `listInputVideos` seeded to answer, beside the programme's own video, two videos of other inputs (one an external session's programme input of the same org). No row is inserted for them, and no `createDownload`, `fetchFromUrl` or `deleteVideo` call ever names them;
    - REPLAY off gives zero discover and zero move calls;
    - overlap: run A claims a `found` row and blocks inside the fake port's `createDownload` on a gate (a promise the test resolves); run B then runs to completion and makes no provider call for that row; the test releases the gate. Exactly one `createDownload` in total. No "started together" timing;
    - a `playable` row 60 min past `verified_at` with `cf_deleted_at` null (the last run's `deleteVideo` answered `in_progress`) is claimed on the next run and `deleteVideo` of its stored `cf_video_id` sets `cf_deleted_at`;
    - **verify check** (recommendation 2026-11-21; the expected values are the recommended literals, not read from the code): `verifyReplayCopy` with a Cloudflare duration of 3600 s passes at 3598 and 3602 and fails at 3597 and 3603 (the `length` reason); a 1080p source with heights `[240,360,480,720]` passes, and with `[240,360,480]` fails (`rendition`); a 480p source with `[240,360,480]` passes; a null `cf_duration_seconds` or `cf_height` fails. In the usecase, a copy that fails keeps the Cloudflare video (no `deleteVideo`), removes the guid, and the row is `failed` with `attempts` grown and a future `next_attempt_at`, then restarts from `found`; one that passes is `playable` with `verified_at = now`;
    - **G-A trigger** (owner ruling 2026-11-21; fake clock): a Seazn session ended past the grace whose fixture was decided 14 min ago is not listed (zero `listInputVideos` calls) and at 15 min it is; a session still `live` is never listed;
    - **G-F undecided fallback** (recommendation 2026-11-21; fake clock): a fixture with no `finished_at` whose session ended 5 h 59 min ago is not listed, and at 6 h it is. A decided fixture is not rescued by the fallback: decided 14 min ago with its session ended 7 h ago is still not listed;
    - **G-E stop** (recommendation 2026-11-21): a Seazn session still `live` with its fixture decided 14 min ago is not stopped, and at 15 min it is, `end_reason 'auto_stopped'`, with the Stream switch off, with an operator phone and with an automatic phone (all three); a YouTube session and a pasted-key session decided long ago are not touched by the new arm; `autoStopOf` for a Seazn session with the switch off answers `applies: true` and the 15-minute delay, and with the switch on and an automatic phone the existing 180 s; the panel renders the new Seazn line (SSR, all four dictionaries have the key);
    - poll answers `absent` (the guid is gone on Bunny): the row clears `bunny_video_id` and goes back to `found`;
    - a `fetching` row with no guid, 31 min old (fake clock), goes back to `downloading` and is fetched again;
    - poll backstop: an `encoding` row whose poll answers `processing` is not polled again until 15 min later (fake clock);
    - an organiser-deleted row with a guid: `cleanup` removes the guid and the Cloudflare copy and sets `bunny_cleaned_at`;
    - two rows of one new org make one `createCollection` call;
    - an input with `replays_discovered_at` set is never listed again (zero `listInputVideos` calls on the second run);
    - a YouTube session's recordings are never discovered.
  - Route: the `seazn` answer carries the replay counters, and a throwing mover answers `seazn.failed: 1` while the session pass still runs.
- [ ] **Step 2: Run them and see them fail.** `cd apps/web && npx vitest run src/server/video/domain/__tests__/replay-move.test.ts src/server/usecases/__tests__/seazn-replays.test.ts src/app/api/cron/stream-tick/route.test.ts src/server/relay/__tests__/config.test.ts src/server/usecases/__tests__/stream-auto-stop.test.ts --reporter=json --outputFile=$SCRATCH/t24.json`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expect PASS. Mutate once each: the delay guard on `delete_cf` (the 59-min test fails); the discovery `inputId` check (the C6 test fails); the `<= 2` tolerance in `verifyReplayCopy` (the 3597/3603 cases fail); the 15-min condition in discovery (the 14-min case fails); the 6 h fallback (the 6 h case fails).
- [ ] **Step 5: Commit** `feat(stream): move Seazn recordings to Bunny`.

### Task 25: Replay on the match page and in the panel

**Files:**

- Modify: `apps/web/src/server/video/seazn-video.ts` (`replay` is filled from `public_fixture_seazn_replays_v`, each part's `src` and `expiresAt` from `signedEmbed` (B4); the org read reads the table). The REPLAY flag gates moving, not playing: a playable replay plays whatever LIVE or REPLAY is. **Recommendation 2026-11-21 (applied unless the owner objects), G-B, the swap:** this task merges the replay rows into Task 14's interim parts by `cf_video_id`. A `playable` (verified) row is a `player: "embed"` part with the row's stored `part_no` whether or not its recording has a `seazn_locked_videos` row, and it replaces that recording's `hls` part when one is listed; a row still `found`, `downloading`, `fetching`, `encoding` or `failed` leaves the interim `hls` part in place (a failing or slow move never leaves the page without a picture); a `deleted` row (organiser delete) removes the part altogether, interim included. The Cloudflare copy is deleted only from `playable`, 60 min after `verified_at` (Task 24), so no listed `hls` part points at a deleted video.
- Modify: `apps/web/src/server/video/seazn-video-plan.ts` (Task 15): add the arm "any non-deleted `fixture_video_replays` row → `seazn`", flag-independent like the session arm.
- Create: `apps/web/src/components/public-site/match-centre/seazn-replay-frame.tsx` (Bunny's embed: an `<iframe>` at 16:9 with a `title`, `allow="autoplay; fullscreen; picture-in-picture"` and `allowfullscreen`)
- Modify: `seazn-video-island.tsx` (Task 15 already renders the parts in `partNo` order with the picker, "Part 1", "Part 2" when there are two or more, for `hls` parts. This task adds the `embed` arm: a part's `player` picks `<SeaznReplayFrame>` (`embed`) or `<SeaznPlayer>` (`hls`), one at a time, the same part picker shape as `ReplayEmbed`'s; picking an `embed` part whose `expiresAt` has passed re-reads the route first, Task 15. Recommendation 2026-11-21: a re-read that now answers `embed` for the part on screen swaps it to the Bunny frame, accepting a restart: the Bunny copy is the permanent one)
- Modify: `apps/web/src/proxy.ts` (add `frame-src https://iframe.mediadelivery.net`; no Bunny CDN host is needed, since the page never fetches Bunny files itself)
- Create: `apps/web/src/server/video/organiser-replays.ts`: `fixtureSeaznReplays(orgId, fixtureId): Promise<{ id: string; partNo: number; state: "processing" | "playable" | "failed"; lengthSeconds: number | null }[]>`
- Modify: `apps/web/src/components/v2/fixture-stream-panel.tsx` (a Seazn fixture's ended state lists its replays with their state; the strings are in Task 26)
- Test: `seazn-video.test.ts`, `seazn-video-island.test.tsx`, `e2e/walkthrough/seazn-hosted.spec.ts` (extended)

- [ ] **Step 1: Write the failing tests.**
  - Two playable rows give `replay` of length 2 in `recorded_at` order, and each `src` has the B4 shape `…/embed/<lib>/<guid>?token=<64 hex>&expires=<digits>` (the fake answers it on `https://embed.fake.invalid`, which `proxy.ts` adds to `frame-src` under the fake driver only; Task 22 pins the real host).
  - The island renders an `<iframe>` for an `embed` part and no `<video>`; a live answer, or an `hls` part (the interim recording), renders `<SeaznPlayer>` and no `<iframe>`.
  - A row still `encoding` is not an `embed` part, and its recording stays listed as the `hls` part with the same `partNo` (recommendation 2026-11-21).
  - **The swap sequence** (recommendation 2026-11-21): for one recording, read the route with no replay row (one `hls` part `1`), with an `encoding` row (still one `hls` part `1`), with the row `playable` (one `embed` part `1`, the `hls` part gone: never two parts for one recording), and with the row `deleted` (no part). `failed` also stays `hls`.
  - Two recordings, the first `playable` and the second still `encoding`: parts `1` (`embed`) and `2` (`hls`).
  - A replay of a private competition is absent from the public read and present in the org read.
  - LIVE off (and REPLAY off): a fixture with an ended Seazn session and a playable replay answers `seazn` from `seaznVideoPlan`, the page renders the Seazn replay player, never `ReplayEmbed`, and the route lists the part (the controller ruling).
  - e2e: a fixture seeded with two `playable` `seazn_replays` rows (parts 1 and 2, as the e2e seed writes other rows) shows Part 1 and Part 2. No Stop, tick or grace wait in the browser: discovery and the mover across a stop/restart are already pinned by Task 24's fake-clock usecase test (Review Focus 4).
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expect PASS. Take screenshots at 320, 768 and 1280.
- [ ] **Step 5: Commit** `feat(stream): Seazn replay player`.

### Task 26: The organiser deletes a replay

**Files:**

- Create: `apps/web/src/app/api/v1/fixtures/[id]/replays/[replayId]/route.ts` (`DELETE`; the editor role, `requireSessionEditor`)
- Modify: `apps/web/src/server/video/organiser-replays.ts`: `deleteSeaznReplay(auth: AuthCtx, fixtureId: string, replayId: string): Promise<{ deleted: true }>`. It is org-scoped, so another org's id gives 404. It takes the row `for update` (waiting for a mover's short claim transaction, never for a provider call), sets `state 'deleted'`, `state_at`, `deleted_reason 'organiser'`, `deleted_by` and commits. That write wins over the mover, whose next conditional update finds zero rows. It then calls `replay.remove` on a known `bunny_video_id` (idempotent on `absent`). Any Bunny copy still in flight, and the Cloudflare copy, are removed by the mover's `cleanup` step (Task 24).
- Create: `apps/web/src/app/api/v1/fixtures/[id]/replays/[replayId]/download/route.ts` (`GET`; the editor role). It streams `replay.openDownload(bunny_video_id)` (Task 21) straight through with `Content-Disposition: attachment; filename="<fixture>-part-<n>.mp4"` and `Cache-Control: private, no-store`, never buffering the file and never redirecting to Bunny. A playable row only; anything else answers 409.

  Plan decision: the download goes through our server because a Bunny file needs both a CDN token and a `Referer` from an allowed host (B5), which a browser download cannot be relied on to send. Spec §5.5 lets the organiser download during the 30-day grace, and the same route serves them at any time. The builder checks the hosting platform's response-duration limit against a 3 h 720p file (about 2–3 GB) and reports it; if the limit is too short, raise it rather than switch to a direct link.

- Modify: `fixture-stream-panel.tsx` (a Delete per part, confirmed by a dialog, and a Download link per playable part pointing at that route).
- Modify: `src/dictionaries/{en,es,fr,nl}/ui.json`: `stream.replay.seazn.title` ("Replay on Seazn"), `stream.replay.seazn.processing` ("Getting the replay ready"), `stream.replay.seazn.failed` ("This replay could not be prepared — Seazn has been told"), `stream.replay.delete` ("Delete replay"), `stream.replay.download` ("Download"), `stream.replay.deleteConfirm` ("Delete this replay for everyone? This can't be undone.")
- Test: `organiser-replays.test.ts`, `route.test.ts` (delete), `download/route.test.ts`, `e2e/walkthrough/seazn-hosted.spec.ts`

- [ ] **Step 1: Write the failing tests.**
  - The editor deletes, and the public read no longer lists the part.
  - A second delete answers 200 `{deleted:true}` with no second `remove` call.
  - A viewer role gives 403. Another org gives 404.
  - Bunny `remove` throwing still answers 200: the row is `deleted`, and `cleanup` retries the removal (the public read no longer lists it either way).
  - A playable part's Download `href` is `/api/v1/fixtures/{id}/replays/{replayId}/download` and holds no token; a `processing` part has no Download.
  - The download route streams the fake's bytes with `attachment` and `no-store`; no response header holds a token; a viewer role gets 403, another org 404, a `processing` row 409.
- [ ] **Step 2: Run them, implement, then run them again.** Expect FAIL first, then PASS. Then `npm run openapi:gen`.
- [ ] **Step 3: Commit** `feat(stream): organiser deletes a Seazn replay`.

### Task 27: Bunny Stream webhook

Bunny calls a library's webhook on every status change (B6). It is the primary "playable" signal; Task 24's 15-min poll is the backstop for one Bunny dropped after its last retry.

**Files:**

- Create: `apps/web/src/app/api/webhooks/bunny-stream/route.ts`, following `app/api/webhooks/resend/route.ts` for reading the raw body before any parse
- Create: `apps/web/src/server/video/bunny-webhook.ts` (pure: verify, parse, map)
- Create: `apps/web/src/server/usecases/seazn-replay-webhook.ts` (`applyBunnyEvent`)
- Test: `video/__tests__/bunny-webhook.test.ts`, `usecases/__tests__/seazn-replay-webhook.test.ts`, `app/api/webhooks/bunny-stream/__tests__/route.test.ts`

**Interfaces — Produces:**

- `verifyBunnySignature(rawBody: string, h: { signature: string | null; version: string | null; algorithm: string | null }, readOnlyKey: string): boolean`. True only when the version is `v1`, the algorithm is `hmac-sha256`, and the signature equals the lowercase hex HMAC-SHA256 of the raw body keyed with `BUNNY_STREAM_READONLY_KEY`, compared with `crypto.timingSafeEqual` on equal-length buffers (a length mismatch answers false and never throws). It runs on the raw body, never on re-serialised JSON.
- `parseBunnyEvent(json: unknown): { libraryId: string; videoId: string; status: number; eventId: string; at: Date } | null`.
- `webhookOutcome(status: number): "playable" | "failed" | "ignore"`: 3 and 4 → `playable`, 5 → `failed`, anything else → `ignore`. This is the webhook's list (B6), not the video API's (Task 21).
- `applyBunnyEvent(deps, ev, now): Promise<"applied" | "duplicate" | "ignored">`:
  - A library other than `BUNNY_STREAM_LIBRARY_ID` → `ignored`, no write.
  - Insert `ev.eventId` into `bunny_webhook_events` (`on conflict do nothing`); an existing one → `duplicate`, no other write and no provider call.
  - A guid a row holds:
    - `playable`: **Recommendation 2026-11-21 (applied unless the owner objects), G-C, G-D.** Call `video(guid)` and run Task 24's `verifyReplayCopy` against the row. A pass is a conditional update `encoding → playable` (sets `verified_at`, `state_at`, and `next_attempt_at = verified_at + SEAZN_CF_DELETE_DELAY_MINUTES`). There is no `deleteVideo` here: the delayed delete is the mover's (Task 24), and this path never lists or deletes a Cloudflare video. A fail writes nothing and leaves the row `encoding`: a status 4 ("Resolution finished") can arrive before the 720p rendition exists (B6), so only the poll, which reads the API's own finished status, sends a failing copy down the failed path.
    - `failed`: `remove` the guid, clear `bunny_video_id`, set state `failed`, `attempts+1` and the backoff; the mover retries from `found` (Task 24).
  - A guid no row holds, on an event whose `webhookOutcome` is `ignore` (Bunny's early statuses 0–2, which can arrive before the mover has written the guid): `ignored`, no lookup, no removal.
  - A guid no row holds, on a `playable` or `failed` outcome: `video(guid).title`. If a row still in `fetching` names that title's `cfVideoId`, it is `ignored` (the mover's own answer is about to land). Otherwise a title of the form `seazn:{sessionId}:{cfVideoId}` is ours and stray (a lost fetch answer, Task 24, or a fetch that landed after a delete), so the guid is `remove`d; a row still `fetching` re-fetches on its own timeout. A title not of that form is `ignored` and never removed: the library may hold other videos. Plan decision: remove rather than adopt, so there is one recovery path, the timeout, and it needs no test of a rare race.
- Route: `POST`. A failed signature answers 401 with no detail and no write. REPLAY off answers 200 `{ ignored: true }` with no write (the poll catches up when it is turned on). An apply that throws answers 500, so Bunny retries; everything else answers 200. The keys and the raw body are never logged.

- [ ] **Step 1: Write the failing tests.**
  - Signature, against a vector computed by hand in the test (fixed key and body): valid → true; one byte of the body changed → false; version `v2` → false; a signature of another length → false without a throw.
  - Usecase on the fakes:
    - statuses 3 and 4, on a copy that passes the check, each make the row `playable` with `verified_at` set and make no `deleteVideo` call (recommendation 2026-11-21); status 2 is ignored;
    - a copy that fails the check (length 3 s off, or no 720p rendition for a 1080p source) leaves the row `encoding` with nothing else written, and the next poll judges it (Task 24);
    - a repeated `EventId` makes no second write and no second `video()` call (Review Focus 13);
    - status 5 removes the guid, sets `failed` with `next_attempt_at` in the future, and the next mover run starts again from `found`;
    - an unknown guid with our title is removed; one with a foreign title, or another library's event, removes and writes nothing;
    - **C6:** the webhook path never calls `deleteVideo` (recommendation 2026-11-21) and never lists videos.
  - Route: a bad signature → 401 and no `bunny_webhook_events` row; REPLAY off → 200 and no write; an apply that throws → 500.
- [ ] **Step 2: Run them and see them fail.** `cd apps/web && npx vitest run src/server/video/__tests__/bunny-webhook.test.ts src/server/usecases/__tests__/seazn-replay-webhook.test.ts src/app/api/webhooks/bunny-stream --reporter=json --outputFile=$SCRATCH/t27.json`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expect PASS. Mutate once each: `verifyBunnySignature` returns true (the one-byte test fails); drop the `bunny_webhook_events` insert (the duplicate test fails); map webhook status 3 through Task 21's table (the status-3 test fails); skip `verifyReplayCopy` (the failing-copy test fails).
- [ ] **Step 5: Commit** `feat(stream): Bunny Stream webhook`.

### Task 28: Phase 2 smoke and scoped regression

- [ ] **Step 1: Extend `scripts/smoke/suites/seaznHosted.ts`** with a replay row reaching playable on the fake host, and the public route listing it.
- [ ] **Step 2: Run the regression in one JSON run.** It covers every vitest path from Tasks 21–27, then `npx playwright test e2e/walkthrough/seazn-hosted.spec.ts e2e/walkthrough/stream-relay.spec.ts`. Check the counts and paths.
- [ ] **Step 3: Commit** `test(stream): Seazn replay smoke`.

---

# Phase 3 — Cost and lifecycle (`SEAZN_HOSTED_COST`)

### Task 29: Migration V552 (planned V543) — delivered minutes

**Files:**

- Create: `db/migration/deltas/V552__seazn_delivery.sql` (planned V543; see the migration-number note above). Table `fixture_video_delivery (session_id uuid primary key references fixture_stream_sessions(id) on delete restrict, org_id uuid not null, live_minutes numeric(12,1) not null default 0, replay_minutes numeric(12,1) not null default 0, live_measured_through date null, replay_measured_through date null, updated_at timestamptz not null default now())`, with RLS as in V430.
- Test: `apps/web/src/server/relay/__tests__/seazn-delivery-migration.test.ts`

- [ ] **Step 1: Write the test** (table shape, `numeric(12,1)`, RLS listed), see it fail, write the delta, apply it locally, and see it pass.
- [ ] **Step 2: Commit** `feat(db): V543 Seazn delivered minutes` (shipped under V552).

### Task 30: Read delivered minutes

**Files:**

- Create: `apps/web/src/server/video/cf-analytics.ts`: `liveMinutesViewed(uids: string[], from: Date, to: Date): Promise<Record<string, number>>`. It POSTs to `https://api.cloudflare.com/client/v4/graphql` with `streamMinutesViewedAdaptiveGroups(filter: { uid_in, date_geq, date_leq }, limit)` and sums `sum.minutesViewed` per uid. Windows longer than 32 days are refused.
- Modify: `replay-bunny.ts` and `replay-fake.ts`. `watchMinutes(videoId, from, to)` reads `GET /library/{lib}/statistics?videoGuid=&dateFrom=&dateTo=` and sums `watchTimeChart` values. The probe settles the unit; the docs do not state it.
- Modify: `apps/web/src/server/relay/config.ts`: the analytics read reuses the relay's own account env (`CLOUDFLARE_ACCOUNT_ID` and the Stream token, granted Account Analytics read) — no `CLOUDFLARE_ANALYTICS_TOKEN` (T30 review m8).
- Modify: the Task 20 probe file and the Task 7 probe file, adding one assertion each: Task 7, whether a live HLS view of a programme input is keyed by the **input uid** or by its live video uid; Task 20, the `watchTimeChart` unit.
- Test: `video/__tests__/cf-analytics.test.ts` (mocked fetch), `replay-bunny.test.ts`

**Plan decision:** query the programme input uid **and** each of its video uids, and sum them. The Cloudflare docs key `uid` as "Video ID (for HLS/DASH)", and whether a live input's live HLS minutes sit under the input uid is unmeasured. Summing both counts the minutes wherever they land; the probe then drops the key that never carries any. **Settled 2026-11-23:** Cloudflare keys minutes by the RECORDING uid only (the input uid answers 0, so the sum is harmless). Ruled 2026-11-24 (Phase 3 review I2): the figure is "Cloudflare minutes delivered" and keeps the replay host's one-off MP4 fetch in it; no `mediaType` filter.

- [ ] **Step 1: Write the failing tests.**
  - The GraphQL body carries `uid_in` with the given uids, and the date filters are ISO dates.
  - A 33-day window throws.
  - A `errors[]` answer throws without echoing the token.
  - Bunny's `watchTimeChart` `{a:60,b:30}` sums to the expected minutes under the probed unit.
- [ ] **Step 2: Run them, implement, then run them again.** Expect FAIL first, then PASS.
- [ ] **Step 3: Commit** `feat(stream): delivered-minute readers`.

### Task 31: The daily measurement pass, staff view and org-deleted grace

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

### Task 32: Phase 3 smoke and final regression

- [ ] **Step 1: Extend `seaznHosted.ts`.** The sweep answer carries `seaznMeasured`, and the admin table loads.
- [ ] **Step 2: Run the regression.** Run every vitest path from all tasks in one JSON run (check `numTotalTests` against the per-task sum and every path under this worktree), then `npx playwright test e2e/walkthrough/seazn-hosted.spec.ts e2e/walkthrough/stream-relay.spec.ts e2e/walkthrough/streaming-destinations.spec.ts e2e/match-day.spec.ts e2e/public-fixture.spec.ts` and all of `e2e/mobile/`. Finish with `npm run openapi:gen && git status --porcelain`.
- [ ] **Step 3: Commit** `test(stream): Seazn cost smoke`.

---

## Operator setup (not code; listed so a flag is never turned on half-configured)

- Phase 1:
  - no signing key: tokens come from Cloudflare's endpoint (C1) with the relay's existing API token;
  - set `SEAZN_VIDEO_ORIGINS`;
  - then `SEAZN_HOSTED_LIVE=true`.
- Phase 2 (owner actions on the Bunny library, staging and prod each):
  - resolutions capped at 720p (B2), MP4 fallback on;
  - Block direct url file access on, with allowed referrers `seazn.club`, `www.seazn.club` and `stg.seazn.club` (B3);
  - Embed view token authentication and CDN token authentication on, with the library token key in `BUNNY_TOKEN_KEY` (B3);
  - the webhook URL set to `https://<host>/api/webhooks/bunny-stream` (Task 27); after the first staging fetch, check that the route logged a verified event;
  - env: `BUNNY_STREAM_LIBRARY_ID`, `BUNNY_STREAM_API_KEY`, `BUNNY_STREAM_READONLY_KEY`, `BUNNY_STREAM_CDN_HOST`, `BUNNY_TOKEN_KEY` (server config only), `REPLAY_DRIVER=bunny`;
  - then `SEAZN_HOSTED_REPLAY=true`.
- Phase 3:
  - an analytics-read Cloudflare token;
  - then `SEAZN_HOSTED_COST=true`.
- Live-input notifications (Task 27b; independent of the three flags, the secret is the on-switch):
  - per environment, a random secret (`openssl rand -hex 32`) in `CLOUDFLARE_LIVE_WEBHOOK_SECRET` (server env only);
  - Cloudflare dashboard > Notifications > Destinations > Webhooks: one destination per environment, URL
    `https://<host>/api/webhooks/cloudflare-stream-live`, Secret = that environment's value; "Save and Test" is answered
    200 `{ ignored: true }`;
  - Notifications > Add > Stream > Stream Live Input: input IDs BLANK (every input: they are made per session), events
    `live_input.connected`, `live_input.disconnected` and `live_input.errored` (errored is opt-in), delivered to BOTH
    environments' destinations. stg and prod share the account, so each receives the other's inputs too and acks them
    unread (200 `unknown_input`);
  - after the first staging stream, check that the route logged `cloudflare-live-webhook: notification handled` for its input.
