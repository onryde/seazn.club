# YouTube Connect — one YouTube broadcast per match, created and ended by Seazn

**Status:** DRAFT for owner approval, 2026-10-27 (session `r2-youtube`).
**Supersedes the "not designed" status of** `2026-09-05-stream-overlay-prompts/_OAUTH-youtube-connect.md`
(owner ruling 2026-09-27, "let's use OAuth"). That file's quota numbers and verification timeline are WRONG
and are corrected in §3.
**Builds on:** `2026-09-30-fixture-page-stream-design.md` (Directory → Streaming is the one place destinations are
managed, §4 D1).

Line numbers below were pinned on `origin/main 1e0ffaaf1e`. **Re-pin every one before building on it.**

---

## 0. Owner decisions recorded in this session (2026-10-27)

These are the owner's own answers in this session's chat. Items marked *(my call)* are this author's, not the owner's.

| # | Decision | Owner's words / basis |
|---|---|---|
| D1 | Build direction **b**: the YouTube Data API creates a fresh broadcast per Go live. No help-text-only fix. | Relayed by r2 ("I think b is better"), then confirmed in this session. |
| D2 | **Visibility is chosen at connect time**, **Unlisted** preselected, Public / Private allowed. | "Probably unlisted we can ask to choose when they connect to oauth" |
| D3 | Connection is managed in **Directory → Streaming**, beside pasted-key destinations. | "and Directory -> Streaming?" (corrected an earlier draft) |
| D4 | **Join a quick restart into the same video**: after Stop, the broadcast stays open for a **5-minute grace window**, and the same match going live again continues it. | Ran the stg join test (§3.3): "single video only". 5 min: "yes fine" |
| D5 | **When the match is finished, end the broadcast 2 minutes after Stop** (or 2 minutes after the result, when the result comes inside the grace window). | "yes, after 2 mins?", then "Ok" to the ending table in §6.4 |
| D6 | **A failure at Go live stops and shows the reason.** No automatic fallback to a pasted key. | "stop and show the reason" |
| D7 | **A required consent checkbox at Connect** (YouTube Terms + Community Guidelines, rights to stream, Seazn not responsible if YouTube restricts or disables live). Ticked **once per connection**. | "show some required checkbox…", "one per connection" |
| D8 | **All of this design is done here**, including the shared timer. | "do all design here" |
| D9 | **stg keeps its 5-minute fast trigger** (amended). The first "Ok" to stg-every-minute was given without knowing it also moves stg's email outbox to every minute and keeps the stg machine awake all day; re-asked with that cost. | "1 b" (2026-10-27) |
| D10 | Only the **web app** changes. Compositor/relay: none. | "Ok" to the explanation that the key never leaves web + Cloudflare |
| D11 | **No feature switch.** Connect YouTube ships on in every env; no flag, no staff-only gate. Connect sits under the existing streaming entitlement (the Directory → Streaming tab is already shown only to relay-entitled orgs); Go live keeps today's credit checks. | "no" (asked: hide on prod until Google verification passes?) |

Accepted without objection in playback (owner "Ok"), originally proposed by this author:
- made-for-kids asked at connect, default **No** *(my call)*;
- a **pool of reusable stream keys per connection**, not a key per match and not a key per court *(my call; §6.2)*;
- works the same in **passthrough and composed** mode;
- disconnect is **refused while a broadcast is live or inside its grace window**;
- token death mid-match does not cut the video; ending is retried after reconnect.

---

## 1. Why

**Measured on stg, run R-VRVN (2026-10-27, read-only `fixture_stream_sessions` + `fixture_stream_events`):**
fixture `0e37a633`, destination = a pasted YouTube key (the channel's default "Stream now" key, Auto-start on,
Auto-stop on). Run 1 (session `2441cb6f`) stopped at 10:02:41. Run 2 (session `509ffe06`) went live at 10:03:47.
No output or ingest errors. YouTube Studio showed "connecting" with "Excellent" signal and no video. Run 1 was
listed as a finished stream.

Cause (confirmed by §3.3): a cold restart leaves **~60 s with no video** (provision ≈ 5 s, then ≈ 25 s for the relay
to start, after the scorer's tap), and YouTube's auto-stop ends a broadcast **"around one minute after"** video stops.
So **any** restart on a pasted default key is at risk of landing on a key with no live broadcast bound, and the
pasted-key path cannot fix that, because Seazn has no control of the broadcast.

With the API, Seazn owns the broadcast's lifecycle: it creates it, binds it, keeps it open across a restart and
ends it. It also gets the video id back, so every match gets its own YouTube link and a replay.

## 2. Goals, non-goals, anti-goals

**Goals**
1. An org admin connects its YouTube channel once in Directory → Streaming. No keys are pasted.
2. Every Go live on that destination lands in a **live, titled broadcast** on the org's channel. R-VRVN cannot happen.
3. A restart of the same match within 5 minutes continues **the same video**.
4. Every match's YouTube replay link appears on the match page.
5. Failures are visible **before** match day (connection health) and **explained** at Go live.
6. Fully compliant with Google's YouTube API policies (§3.4), so Google's verification and any audit pass.

**Non-goals (this wave)**
- Per-competition or per-court destination overrides (`_OAUTH` doc recommends per-court later; not now).
- Automatic fallback to a pasted key (D6).
- Twitch or any other platform API. Twitch stays pasted-key.
- Chat, moderation, thumbnails, descriptions beyond a link back to Seazn, playlists.
- Changing the pasted-key path. It stays exactly as it is, as a separate destination kind.
- Any relay/compositor change, any change to `docs/contracts/relay-job.v1.json`.

**Anti-goals (a failure even if everything "works")**
- Video reaching the org's channel with no live broadcast bound to the key (R-VRVN).
- A broadcast left "live" with no picture for more than ~6 minutes after the last Stop.
- A YouTube token or stream key reaching the relay Machine, a log line, an error message, a URL, argv, or chat.
- Seazn-owned channels. The channel is always the org's.
- Acting on the org's channel in a way the consent did not name.

## 3. Facts this design rests on

### 3.1 Google docs (read 2026-10-27; VERIFIED unless marked)

Full notes with URLs: this session's scratchpad `youtube-api-research-2026-10-27.md`; the builder re-reads the
pages below rather than trusting a summary.

- `liveBroadcasts.contentDetails.enableAutoStop=true` stops the broadcast "around one minute after the channel
  owner stops streaming". With it off, the broadcast ends via `liveBroadcasts.transition(broadcastStatus=complete)`.
  (developers.google.com/youtube/v3/live/docs/liveBroadcasts, …/live/life-of-a-broadcast)
- `enableAutoStart=true` starts the broadcast when video arrives on the bound stream.
- A `liveStream` (stream key) **can be bound to many broadcasts over time**; `isReusable` defaults to true. A
  broadcast binds to exactly one stream. (…/liveBroadcasts/bind, …/live/docs/liveStreams)
- **Limits:** "10 active streams allowed per channel and 3 active streams per stream key" (support.google.com/youtube/answer/2474026).
  There is a **daily cap on creating live streams; the number is unpublished** (answer/2853834). Insert errors:
  `limitExceeded/userBroadcastsExceedLimit`, `rateLimitExceeded/userRequestsExceedRateLimit`.
- **Quota:** every method this design uses costs **1 unit** (insert, bind, transition, update, list on
  liveBroadcasts and liveStreams; channels.list; videos.list). Default 10,000 units/day/project
  (…/v3/determine_quota_cost). ~5–6 units per match ⇒ ~1,700 matches/day platform-wide. Quota is NOT a constraint.
  (Corrects `_OAUTH`'s "~50 units/write, ~65 matches/day".)
- **Eligibility:** first live enable "may take up to 24 hours"; verified channel; no live restriction in the past
  90 days; a strike blocks live for 14 days. API errors: `liveStreamingNotEnabled`, `livePermissionBlocked`.
- **Archive:** streams under 12 h are archived automatically; over 12 h "may not be captured at all".
- **OAuth:** insert/bind/transition accept scope `youtube` or `youtube.force-ssl`. Not a restricted scope.
  Sensitive-scope verification: homepage, privacy policy on the same domain, an unlisted demo video, per-scope
  justification, verified domains, "typically 3-5 business days". (Corrects `_OAUTH`'s "weeks".)
- **Refresh tokens:** an app in **Testing** publishing status issues tokens that **expire after 7 days**. In
  production they last until revoked or 6 months unused. 100 refresh tokens per Google account per client; issuing
  another silently invalidates the oldest.
- UNVERIFIED: whether YouTube eventually ends a broadcast that has auto-stop off and no incoming data, and after how
  long; what the gap looks like in the replay. §3.3 bounds the first empirically.

### 3.2 Code (origin/main 1e0ffaaf1e — re-pin)

- `org_stream_targets` — `db/migration/deltas/V410__stream_sessions.sql:98-106`: kind ∈ youtube|facebook|twitch|kick|custom_rtmp;
  `rtmp_enc` (sealed JSON `{url, streamKey}`), `watch_url`. V421 adds `dest_fingerprint` + the one-active-session index;
  V427 adds `archived_at`.
- Secrets: `apps/web/src/server/relay/crypto.ts` (`KekName` = RELAY_KEK | DEVICE_LINK_KEK | LICHESS_TOKEN_KEK | EMAIL_OUTBOX_KEK;
  AES-256-GCM per-row DEK envelope). `secret-columns.ts:133` insertStreamTarget, `:252` readTargetSecret. Every `*_enc`
  column must belong to an owner group or `relay/__tests__/enc-boundary.test.ts` fails.
- Stored-token precedent: `user_external_accounts` (V451, lichess, `access_token_enc`, LICHESS_TOKEN_KEK) — user-scoped;
  ours is org-scoped.
- Session lifecycle: `relay/domain/session.ts:154-161` Effect union; `provisioned` emits `add_output`; since R2004
  **every** terminal entry holding an output (both modes) prepends `release_output` (`session.ts:364-365`).
  Every terminal entry writes `fixture_stream_sessions.ended_at` via persist (`stream-sessions.ts:188`;
  `session.ts:229/244/296`). **Only the organiser's Stop goes through `stopSession`**; phone stop
  (`capture-phone.ts:611`), auto-stop (`:2367`), phone-lost/warming/never-live (`:2309`), target_rejected (`:2127`),
  output_failed (`:901`), credit_refused (`:419`), relay_disabled (`:871`), every expiry (`:856`), runner signals
  (`:809,:1017,:1020,:1067,:2727,:2747`), complete_now (`:958`) and expireTargetHolders (`~:2957`) call `apply()`
  directly, and several never pass through `ending` (r2, 2026-10-27). `usecases/stream-sessions.ts:913` runEffects → `:922` readTargetSecret →
  `:927` `ingest.addOutput` (`relay/ingest-cf.ts:372`). `startBroadcast` `:1553`, admission `:1741`. `stopSession` `:2551`.
  `fillReplayUrl` `:2921-2930` → `setFixtureStreamUrl` (`usecases/fixtures.ts:512`).
- Credits/restarts: `stream-credits.ts:129,167`; `CREDIT_REUSE_HOURS=24`, `FREE_RESTARTS_PER_WINDOW=3` (`relay/config.ts:279-288`). Unchanged.
- Locking: `apply` takes the org advisory lock (`lockOrg` `:385`, `stream-credits.ts:104`) THEN the session row
  `for update` (`:386`/`:156`).
- One-active indexes: one active session per **target** `V421:42`; per **fixture** `V410:230`.
- Go live is allowed up to 120 min after the result (`CODE_GRACE_AFTER_FINISH_MINUTES`, `config.ts:486`).
- **The timer already exists:** `app/api/cron/stream-tick/route.ts` → `tickOpenSessions` (`:2403`, selects
  `state in ACTIVE_STATES`, incl. `ending`) → `tickSession` (`:2022`) → `endIfAutoStopDue`. Fired by
  `apps/cron-worker/src/schedule.ts:118` as **minuteMod 5** on the fast trigger (`wrangler.json:24` stg `*/5`,
  `:29` prod `* * * * *`) ⇒ every 5 min on both envs today. The pass takes no lock of its own; each `apply` takes
  lockOrg then the row lock, and decisions are idempotent. Budget 45 s (`:2393`), with a break at `:2424-2427` that
  defers the rest. The route returns before ticking on a relay-disabled deployment (`route.ts:26`). (Confirmed with r2.)
- `fixtures.finished_at` is maintained by trigger `fixtures_track_finished` (V430:23-38, V432:8-20) on entering
  decided|finalized|forfeited|abandoned|cancelled|needs_decision, cleared on revert. Streaming polls it
  (`relay/domain/auto-stream.ts:100-106`); there is no push hook.
- Directory → Streaming: `app/directory/page.tsx:270-287` → `components/v2/stream-destinations-panel.tsx`; routes
  `app/api/v1/orgs/[id]/stream-targets/*` (write = EDITOR_ROLES owner|admin).
- Google sign-in (`app/api/auth/google/*`, `lib/oauth.ts`): scopes `openid email profile`, `access_type=online`;
  **no Google token is stored anywhere today**.
- Highest migration on origin/main: **V477** (re-pinned 2026-10-27; V476 `stream_phone_live_edge` at `1e0ffaaf1e`). Take max+1 at merge (V478+).

### 3.3 The stg join test (owner ran it, 2026-10-27)

Studio: scheduled broadcast "Seazn join test", Unlisted, new key `join-test`, **Auto-start ON, Auto-stop OFF**;
pasted into stg as a destination; fixture `0e37a633`; four Go lives. Owner observed **one video only**.
stg DB (read-only), video-off → video-on gaps:

| Sessions | Gap |
|---|---|
| `7191ba80` ended 13:10:37 → `c90e7cb1` live 13:11:36 | ~59 s |
| `c90e7cb1` ended 13:13:11 → `753ea9a1` live 13:16:54 | ~3 m 43 s |
| `753ea9a1` ended 13:17:35 → `2c4671fa` live 13:26:13 | ~8 m 38 s |

⇒ With auto-stop off, a broadcast stays open for **at least 8.6 minutes** with no video, and a reconnect continues
it. The upper bound is unknown; 5 minutes (D4) has margin.

### 3.4 Google's policy obligations (YouTube Developer Policies "DP", API Services ToS)

The builder re-reads developers.google.com/youtube/terms/developer-policies before quoting any clause.

- **DP III.A.1:** show a link to YouTube's Terms of Service and state that users agree to be bound by them.
- **DP III.A.2:** users agree to Seazn's privacy policy before use. The policy must say Seazn uses YouTube API
  Services, link http://www.google.com/policies/privacy, say what data is accessed/stored/used/shared, say users
  can revoke at https://security.google.com/settings/security/permissions, and give a contact.
- **DP III.E.3 / III.I.2:** express prior consent that **names** the automated actions taken on the channel.
  III.E.3.f: never change visibility unless the user instructed it.
- **DP III.E.4:** refresh tokens may be kept as needed. Other stored YouTube data (broadcast ids, video ids,
  titles) **max 30 days, then refreshed or deleted**. In-app revoke ⇒ revoke the token at Google immediately and
  delete stored YouTube data **within 7 days**. Revoke on Google's side ⇒ delete within 30 days.
- **Branding:** YouTube icon where the API has a presence, never the most prominent element; "YouTube" never in a
  product name; no implied endorsement.

## 4. Shape of the solution

```
Directory → Streaming → [Connect YouTube]
   consent screen (checkbox D7, visibility D2, made-for-kids, ToS + privacy links)
   → Google OAuth (offline, youtube scope) → pick channel → connection saved
   → a destination row "YouTube · <channel>" appears (kind youtube, API-backed)

Go live on that destination (passthrough or composed — unchanged chain)
   admission (existing checks) → YouTube prepare:
      open, unclaimed broadcast for this fixture inside grace?  → reuse it
      else take a free pooled key (or create one) → insert broadcast → bind
   → session as today; add_output hands Cloudflare the POOLED key (not rtmp_enc)

Stop / result / tick
   Stop        → nothing new (every session end already writes ended_at)
   stream-tick (every fast firing: prod every 1 min, stg every 5 min) → end every broadcast whose end is due (§6.4)
              → transition(complete) → fixtures.stream_url = YouTube watch link
```

Cloudflare and the relay are unchanged: Cloudflare still receives `{url, streamKey}` in `add_output`; only the
SOURCE of that pair changes for an API-backed destination.

## 5. Data model *(table and column names are the builder's; the facts and constraints are not)*

Greenfield schema rules apply (RULES.md §Schema). Load `supabase:supabase-postgres-best-practices` first.

**5.1 `org_youtube_connections`** — one row per connected channel.
org_id; channel_id; channel_title; google subject of the granting account; `refresh_token_enc` (sealed, new KEK
`YOUTUBE_TOKEN_KEK`, new owner group in `enc-boundary.test.ts`); granted scope; `default_privacy`
(unlisted|public|private, default unlisted); `made_for_kids` (default false); consent record (who, when, consent
text version); status (connected | reconnect_needed | revoked); last health check at + last error code (a code,
never a token or a Google response body); created_by/at; revoked_at. One live connection per (org, channel).

**5.2 Destination row.** A connection appears as an `org_stream_targets` row (kind `youtube`) with a nullable FK to
the connection; `rtmp_enc` becomes nullable with a check that **exactly one** of `rtmp_enc` / connection FK is set.
This keeps `fixture_stream_settings.target_id`, archive (V427), the fixture panel's picker and every existing reader
working. `dest_fingerprint` for an API row is derived from the channel id. *(my call — the alternative, a parallel
destination table, forks every reader.)*

**One channel streams several matches at once** (the reason for the key pool, §5.3; four courts live at once was
the example the owner heard and accepted). So for an API-backed row the **one-active-session-per-target rule does
not apply**: the V421 unique index (`fixture_stream_sessions_one_active_target`) and the `target_in_use` refusal
(`targetHolderFor`, `stream-sessions.ts:1250,1644,1821`) are narrowed to pasted-key rows. Exclusivity for API rows
moves to the **key**: at most one open broadcast per pooled key (§5.4), enforced by a unique index, plus at most one
open broadcast per fixture. Disconnect/delete "in use" checks (§6.8) read open broadcasts, not the target holder.
*(builder-check finding; my call on the mechanism)*

**A channel is connected to at most one org at a time** (unique channel id across live connections). Connecting a
channel already connected elsewhere is refused with "This channel is connected to another organisation on Seazn".
*(my call — owner rule: skip rare edge cases; it also keeps the 10-stream channel cap counted in one place.)*

**5.3 Stream-key pool** — rows per connection: YouTube `liveStream` id; ingestion URL + key sealed together under
RELAY_KEK in the same `{url, streamKey}` shape `rtmp_enc` uses (so `add_output` code is shared); created_at;
retired_at. A key is **busy** while any broadcast bound to it is open (§5.4). Never more than 10 non-retired keys
per connection (YouTube's concurrent cap).

**5.4 Broadcasts** — one row per YouTube broadcast Seazn creates:
connection; fixture; pooled key; YouTube broadcast id (= the video id); title; privacy; state
(created | bound | reserved | live | ending | complete | failed); ended_at; last session id; `refreshed_at` (30-day
rule); last error code. Constraints: **at most one open (not complete/failed) broadcast per fixture** and **at most
one open broadcast per key**. Index supporting "open broadcasts whose end may be due" (pattern: `email_outbox`
`next_attempt_at` partial index, V470:56,92).

## 6. Behaviour

### 6.1 Connect (Directory → Streaming)

1. An editor (owner|admin, as today) taps **Connect YouTube** (YouTube icon, not the dominant element).
2. A **consent step** inside Seazn, before Google: visibility (Unlisted preselected; Public; Private), made for
   kids (No preselected), and the required checkbox (D7). Draft wording — final legal text is the owner's:
   > ☐ I confirm this organisation will follow YouTube's **Terms of Service** and **Community Guidelines**, has the
   > rights to stream this content (venue, players, music), and agrees that Seazn will **create, title, start and
   > end a YouTube live broadcast on this channel for each match we stream** here. YouTube alone decides whether
   > this channel can stream; Seazn is not responsible if YouTube restricts or disables live streaming, removes a
   > stream, issues a strike, or does not save a replay. By connecting you agree to be bound by the YouTube Terms of
   > Service. See our **Privacy Policy**.
   Links: YouTube ToS, Community Guidelines, Seazn privacy policy. The button stays disabled until ticked.
3. Google OAuth on a **separate route pair from sign-in** (never entangle with login): `access_type=offline`,
   `prompt=consent`, state cookie bound to org + user, PKCE. Scope: **`https://www.googleapis.com/auth/youtube`
   only** (owner configured it on the consent screen 2026-10-27; `youtube.force-ssl` dropped — both are accepted by
   insert/bind/transition/list/delete, and force-ssl's consent text reads "permanently delete your YouTube videos…").
   Verification justification: create, bind, start and end live broadcasts and stream keys on the org's own channel.
4. Callback: verify state + editor role again; exchange code; refuse if the granted scope lacks the YouTube scope;
   `channels.list(mine=true)`. **One channel** → save. **Several** → a picker, then save. **None** → plain error
   ("This Google account has no YouTube channel").
5. Saved: connection row + destination row; consent recorded with text version. When the consent text changes,
   **the old consent stands** and Go live is never blocked by it; Directory → Streaming shows the connection as
   "Review updated terms" until an editor re-ticks. *(my call — a scorer at the match cannot tick it, and a legal
   edit must not stop matches streaming on match day.)*
6. If the channel is not enabled for live yet, the first health check (§6.6) shows it, with "YouTube can take up to
   24 hours".

### 6.2 Go live

Admission keeps every existing check (entitlement, credits, one-active-per-target, …) in its current order. For an
API-backed destination, **after** those pass and **before** the session insert, a YouTube prepare step:

1. Get an access token from the sealed refresh token (in memory only).
2. If this fixture has an **open broadcast that is not claimed** by the end step (§6.4) and whose end is not yet
   due → reuse it: same key, same video. This check takes the broadcast row lock (no skip) in a short transaction,
   marks the row **reserved** for this admission, and commits. A reserved row counts as "an active session" for the
   end rule until the session exists or the reservation lapses (builder sets the lapse; ~2 min). A **claimed**
   (`ending`) broadcast is treated as gone: admission takes the new-broadcast path below ("Part 2"), because the end
   step may already be calling `transition(complete)`.
3. Else pick a **free key** from the pool (no open broadcast bound); none free and fewer than 10 → `liveStreams.insert`
   (rtmp, reusable) and add it to the pool; 10 busy → refuse `youtube_channel_busy`.
4. `liveBroadcasts.insert`: title (§6.5), `scheduledStartTime` now, privacy = connection default, made-for-kids =
   connection setting, **`enableAutoStart=true`, `enableAutoStop=false`**, monitor stream off. Then `bind` to the key.
   **Steps 3–4 run OUTSIDE every transaction** — no row or advisory lock is held across a YouTube call, including
   admission's target lock (`stream-sessions.ts ~:1720`). The resulting broadcast row is written `bound` in its own
   short transaction, then admission's existing transaction references it.
5. The session proceeds as today. `add_output` reads the pooled key (sealed `{url, streamKey}`) instead of `rtmp_enc`.

**Refusals (D6) — stop, show the reason, charge nothing, create no Cloudflare output:**

| Code | Cause | Copy (gist; 4 locales) |
|---|---|---|
| `youtube_reconnect_needed` | refresh fails (`invalid_grant`), scope missing | "Reconnect YouTube" → Directory → Streaming |
| `youtube_live_not_enabled` | `liveStreamingNotEnabled` | "This channel isn't enabled for live yet. YouTube can take up to 24 hours." |
| `youtube_live_blocked` | `livePermissionBlocked` | "YouTube has restricted live streaming on this channel." |
| `youtube_limit_reached` | `limitExceeded`, `userBroadcastsExceedLimit`, `rateLimitExceeded` | "YouTube's limit for new streams was reached. Try later or pick another destination." |
| `youtube_channel_busy` | 10 keys busy | "This channel already has 10 streams live." |
| `youtube_unavailable` | 5xx / timeout | "YouTube didn't answer. Try again." |

A broadcast created in step 4 whose session is then refused later in admission is **deleted**, never left
"upcoming". An orphan `created` row older than 10 minutes is cleaned by the tick (§6.4).

### 6.3 Stop

**Nothing changes at Stop, and nothing calls YouTube.** Sessions end through many paths (§3.2 — only the organiser's
Stop uses `stopSession`), and every terminal entry already writes `fixture_stream_sessions.ended_at`. The end rule
(§6.4) reads that. `apply` never touches the broadcast row, so no new lock is added to any Stop's decision (r2:
stamping the broadcast inside `apply` would make org → session → broadcast and risk a 40P01 deadlock against the
end step). The Cloudflare output is released exactly as today.

### 6.4 When a broadcast ends (D4, D5)

Computed from facts, not from stored deadlines, so a late result needs no hook on the fixture write:

- `finished` = fixture status ∈ {decided, finalized} (owner, D5) — *(my call: also forfeited | abandoned | cancelled;
  never `needs_decision`, which is a held state that can resume)*.
- If a session for the fixture is active (not terminal) → **not due**, ever.
- Else, with S = the **latest** `ended_at` among the fixture's sessions since the broadcast was created, and F = time
  the fixture became finished (`fixtures.finished_at`):
  - not finished → due at **S + 5 min**
  - finished → due at **min(S + 5 min, max(S, F) + 2 min)**

| Situation | Ends |
|---|---|
| Stop, match not finished | 5 min after Stop, unless the same match goes live again first |
| Finished, then Stop | 2 min after Stop |
| Stop, then finished inside the 5 min | 2 min after the result, or at Stop + 5 min, whichever is first |
| Finished, camera still live | not due; the clock starts at Stop |

Ending: `transition(complete)`. A broadcast that never went live (still `ready`) is deleted instead.

**Replay links.** A match restarted after its grace window (or after a broadcast completed — Go live is allowed up to
120 min after the result) gets a **new** broadcast, so one match can have more than one YouTube video. Every completed
broadcast is kept per fixture; the match page lists them in order ("Watch on YouTube", or "Part 1 / Part 2" when there
are several). `fixtures.stream_url` keeps its existing "null stream_url only" rule and so holds the first part.
*(my call — r2 raised it; a later part never hides an earlier one.)*

**Races (r2).** Admission locks the fixture's open broadcast `for update` (no skip) before reusing it; the end step
re-checks "no active session" **under its own lock** on the broadcast row. YouTube is **never called while a row lock
is held**: the end step claims (lock, mark `ending`, commit), calls YouTube, then finalizes in a new transaction; a
crash between leaves a claimed row the next tick retries. Finalize only moves a row from `ending` to `complete`; it
never re-opens or rewrites a row, so it cannot resurrect anything admission has since superseded (admission never
reuses a claimed row, it creates a new one).

### 6.5 Title and description *(my call)*

Title: `<Home> v <Away> · <Division> · <Competition>`, trimmed to YouTube's title limit (builder verifies the limit;
truncate the competition first). Description: one line + the Seazn public match URL ("Live score and results:").
Both in the org's default locale (`organizations.default_locale`).

### 6.6 The tick (D8, D9)

Reuse the **existing** stream tick. No new job, no new route:
- `apps/cron-worker/src/schedule.ts`: stream-tick on **every** fast firing (drop `minuteMod 5`) ⇒ every minute on
  prod; stg's fast trigger stays `*/5` (D9), so on stg an end can land up to 5 min late. Email-outbox unchanged.
- The stream-tick route gains a step: **end due broadcasts** (§6.4), selected from the broadcasts table directly,
  NOT via sessions (a broadcast can come due after its session is `completed`). It runs **first**, before the
  per-session loop and **before** the route's relay-disabled early return (`route.ts:26`), with its own budget slice,
  so a busy session pass cannot starve it (r2). It locks only the broadcast row (`for update skip locked`), reads
  sessions with a plain select, and follows claim → commit → call YouTube → finalize. Idempotent: a second firing
  finds it `complete` and does nothing.
- Same step: delete orphan `created` broadcasts > 10 min old.
- Whole pass stays inside the existing 45 s budget, below the 60 s period (overlapping firings are safe, but wasteful).
- r2's ending-session gap closes with the cadence change alone: `tickOpenSessions` already selects `ending`
  (confirmed with r2). Terminal sessions with a live runner remain daily-sweep only, unchanged.

**Daily** (existing relay-sweep, 04 UTC): connection health check (`channels.list` per connected channel → status;
`liveStreamingNotEnabled` surfaced) and the 30-day refresh (`videos.list` in batches of 50 for broadcast rows with
`refreshed_at` > ~25 days: still exists → refresh; gone → delete the row and clear the fixture's `stream_url` if it
points at it).

### 6.7 Token dies mid-match

The video keeps flowing (YouTube needs only the key, already bound). Only the end call fails: connection →
`reconnect_needed`, the broadcast stays due, the tick keeps retrying with backoff, and ending happens on the first
tick after reconnect. The destination row shows "Reconnect needed" with the reason.

### 6.8 Disconnect (and revoke)

- **Refused while any broadcast of that connection is open** (live, or inside grace): "A match is using this
  channel". Same rule as deleting a destination in use today.
- Otherwise, in one request: delete Seazn-created keys on the channel (`liveStreams.delete`) *(my call — avoids
  litter in the org's Studio)*, revoke the token at Google (if another live connection was granted by the **same
  Google account** — an admin of two clubs — the builder first verifies from Google's docs whether revoking one
  refresh token kills the other's grant; if it does, delete our token without the Google revoke and record why), null `refresh_token_enc`, connection → `revoked`, archive
  the destination row, and **purge stored YouTube data now**: broadcast ids/titles, and every `fixtures.stream_url`
  pointing at that channel's videos (DP III.E.4: 7 days; doing it inline satisfies it).
- Revoked on Google's side (discovered as `invalid_grant`): connection stays `reconnect_needed`; after **30 days**
  without reconnect, the same purge runs from the daily sweep.

### 6.9 UI (to be shown to the owner as 2+ options before building)

House bar: mobile-first; 1280 / 768 / 320 with no horizontal scroll; house theme (mocks are layout only); every
string in en/es/fr/nl + `npm run i18n:gen-keys`; `frontend-design` skill in every UI task.

- **Directory → Streaming:** Connect YouTube action beside "Add destination"; the consent step; the channel picker;
  a destination row: YouTube icon · channel · visibility · status badge (Connected / Reconnect needed / Not enabled
  for live); actions Reconnect, Settings (visibility, made-for-kids), Disconnect.
- **Fixture stream panel:** the destination picker shows API-backed YouTube rows like any other; refusal reasons
  (§6.2) inline with their action; after the match, the YouTube replay link.
- **Privacy policy page:** the DP III.A.2 additions (§3.4). Builder locates the page source.

## 7. Security

- Refresh tokens: sealed with a **new KEK `YOUTUBE_TOKEN_KEK`** (owner provisions it in stg and prod; 64 hex), new
  owner group in `enc-boundary.test.ts`. Access tokens live in memory for one request, never stored.
- Pooled stream keys sealed under RELAY_KEK in the existing `{url, streamKey}` shape.
- Never in logs, errors, URLs, argv, Sentry, PostHog, telemetry rows or chat: tokens, keys, Google response bodies.
  Errors are stored as codes.
- OAuth: state cookie + PKCE; state bound to org and user; callback re-checks editor role; scope check on the grant.
- Cross-org: every connection/key/broadcast read is org-scoped; a test proves org B cannot use, see or disconnect
  org A's connection.
- The relay Machine never receives a YouTube token or key (unchanged chain; `relay-job.v1.json` untouched).

## 8. Owner prerequisites (owner's job — never an agent's)

1. Google Cloud: enable **YouTube Data API v3** on the existing project; add the YouTube scope to the OAuth consent
   screen; register the new callback redirect URIs (stg + prod).
2. Privacy policy text final (legal); consent checkbox wording final (legal).
3. Submit **sensitive-scope verification** (demo video of the connect flow, justification). ~3–5 business days.
   Until verified the app is in Testing: tokens die every 7 days, a small user cap. With no feature switch (D11),
   orgs connecting before verification will see "Reconnect needed" weekly; the owner times the prod release
   against the verification result.
4. Provision `YOUTUBE_TOKEN_KEK` on stg and prod.
5. Run the stg acceptance check (§9.4) with a real channel.

## 9. Testing (RULES.md §Testing, TEST-STRATEGY.md — all four types per task)

**9.1 A fake YouTube port** (beside `fake-ingest`): a deterministic in-memory channel implementing insert/bind/
transition/delete/list, auto-start on "video", the 10/3 limits, error injection per code in §6.2, and token
expiry/revocation. Expected values come from **Google's documented limits and the owner's rulings** (5 min, 2 min,
10 keys), never from this code's constants re-imported into the test.

**9.2 Sequences that must each have a test** (TEST-STRATEGY rule 1):
- Go live → Stop → Go live inside 5 min ⇒ **same** broadcast, same key, one video.
- Go live → Stop → wait > 5 min (tick) ⇒ broadcast complete; next Go live ⇒ **new** broadcast.
- Stop then finished at +1 min ⇒ ends at +3 min. Finished then Stop ⇒ ends at Stop + 2. Finished while live ⇒ not due.
- Result reverted (finished_at cleared) inside grace ⇒ back to the 5-min rule.
- Two fixtures live at once on one channel ⇒ two keys; key reused by a later match once free.
- 11th concurrent ⇒ `youtube_channel_busy`, nothing charged, no CF output.
- Channel already connected to another org ⇒ refused.
- Consent text changed ⇒ Go live still works; Directory shows "Review updated terms".
- Each refusal code in §6.2 ⇒ refused, nothing charged, no CF output, no orphan broadcast.
- Admission refused after the broadcast was created ⇒ broadcast deleted.
- Token revoked mid-match ⇒ video continues; end retried; ends after reconnect.
- Disconnect while live / in grace ⇒ refused. Disconnect idle ⇒ token revoked, data purged, stream_url cleared.
- Another org ⇒ cannot see, use or disconnect.
- Passthrough and composed both.
- Two tick firings overlapping ⇒ one transition, never two.
- Go live racing the end step on the same fixture ⇒ either the broadcast is reused (and not ended) or ended and a new one
  created; never a session streaming into a completed broadcast.
- Session ends via each path in §3.2 (organiser, phone, auto-stop, expiry, failure) ⇒ the 5/2-minute rule fires from
  `ended_at` for all of them.
- Relay disabled on the deployment ⇒ due broadcasts still end.
- Restart after completion ⇒ second broadcast; match page shows Part 1 and Part 2.
- 30-day refresh: video deleted on YouTube ⇒ row and link removed.

**9.3 Mutations** (rule 5): at least the reuse-inside-grace predicate, the "active session ⇒ not due" guard, the
key-busy predicate, the disconnect-refusal guard, and the scope check — each mutated once, each killed.

**9.4 E2E / smoke / stg.** E2E runs through CI dispatch only (`gh workflow run e2e.yml --ref <branch> -f pr=<n>`),
using the fake YouTube port: connect (consent → picker), Go live → Stop → Go live (same video), refusal copy, replay
link, disconnect. Smoke: the tick route plus one connect-less refusal. **stg acceptance with a real channel**
(owner runs; agent writes the runbook and reads stg DB): R-VRVN replay — two Go lives ~60 s apart ⇒ one video;
gap > 5 min ⇒ two videos, both titled; replay links on the match page; disconnect purges.

## 10. Risks and unknowns

- **YouTube's daily creation cap is unpublished.** A busy channel may hit it; §6.2 refuses with a plain reason.
  If it bites in practice, a later wave can reuse a broadcast across matches on a court (not now).
- **The no-data upper bound** with auto-stop off is unknown (≥ 8.6 min proven). The tick ends at 5 min, well inside.
- **Testing-mode token expiry (7 days)** will make stg connections need re-connecting weekly until verification.
- Whether YouTube's 2020 "unverified project ⇒ private" rule ever applies to live broadcasts: unverified. The stg
  check (§9.4) observes the real visibility.

## 11. Left to the builder

Exact table/column names;
retry/backoff numbers; where in admission the prepare step sits relative to the credit hold (invariant: nothing
charged and no orphan broadcast on any refusal); the title length limit; the 30-day refresh threshold; how the UI
options look (owner chooses between 2+).

## 12. Coordination

r2 (relay/compositor lanes) reviewed §6.6's paths on 2026-10-27 and confirmed no relay-job or compositor change.
r2 is to see the tick section of this spec before owner approval. Migration number: take main's max + 1 at merge.
