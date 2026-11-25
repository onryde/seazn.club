# Design spec: realtime push nudges for the capture phone, Match Day and public division topics

**Status:** draft for owner review · phone-side review: no objections (phone session, 2026-11-24; phone part approved by the phone owner after #68) · **Asked:** 2026-11-24 · **Base:** origin/main `8d39087623` (worktree `realtime-nudges`)
**Binding inputs:** the phone team's constraints (`seazn-hosted-build/.superpowers/sdd/2026-11-20-seazn-hosted-video/realtime-phone-constraints.md`). Where they conflict with this brief, they win, and §0 lists each place.
**Repo rules followed:** AGENTS.md, `docs/superpowers/RULES.md` (greenfield schema, all four test types), `docs/superpowers/TEST-STRATEGY.md`, `apps/web/src/server/MODULARIZATION.md`.

---

## 0. Facts re-verified, and corrections to the brief

| Brief said | At 8d39087623 |
|---|---|
| realtime.ts:16-60 transport | `BROADCAST_TIMEOUT_MS` :16, `publishTarget` :27-32 (kill switch `REALTIME_PUBLISH=off`), `publishFixtureUpdate` :50-79 (private). Each function builds its own `fetch`. There is no shared helper. |
| `division:{id}` public, realtime.ts:87-108 | `publishDivisionUpdate` :87-118. The message has no `private` flag. Subscribers: `use-live-competition.ts:344`, `components/v2/slideshow.tsx:234`, `components/v2/board/use-board-actions.ts:815`. All three join with no `private` and no `setAuth`. |
| V403:55-61, V452:41-47 | Confirmed. Each policy keys on its OWN claim name (`fixture_id`, `lobby_fixture_id`). V452's header explains why: a shared claim would let one token open the other family's topic. |
| mint :385-401 | Confirmed. The door is `app/api/v1/public/fixtures/[id]/realtime-token/route.ts` (GET :27, mint :41, device-link :66). It already returns the public `url` + `apikey` for phones (owner, 2026-11-01). |
| config.ts:764-766 POLL | Now **`server/relay/config.ts:747-749`** (5/10/60), near window :751. `poll-seconds.ts:11-17` is confirmed. |
| Capture beat path | route `beats/route.ts:15-30` → `postBeat` `capture-phone.ts:540` → `runBeat`. Court codes go to `postCourtBeat` (`capture-court.ts:256`). The wire answer is built at `capture-phone.ts:778`. Schema: `api-v1/capture-schemas.ts` `AnswerCommon`, which is strict on every branch, with `answer-tampered-*` fixtures as the guard. |
| Match Day day read | `app/api/v1/match-day-code/route.ts:12`. Door: `api-v1/match-day-code-door.ts`, metered per CODE (`MD_DAY_LIMIT` 600/min = 150 phones at 15 s). |
| Score / court-call publishes | `scoring.ts:520-523` (callback scope carries `{divisionId, competitionId}`). `match-day-call.ts:563,605` → `afterScheduleWrite` (`schedule/after-write.ts:66-68`), which sends **1 division POST + up to 50 fixture POSTs** per write. |
| Next migration | Highest on main is V552. `origin/feat/seazn-hosted` also owns **V553** (`seazn_offered`), not yet merged. No remote branch has V554+. **This work takes V554, V555 and V556.** |
| Stale comment | `use-live-fixture.ts:289` says "publishFixtureUpdate still fans a public twin". The twin was removed (realtime.ts:41-48). Fix this in T0.1. |

Phone-constraint overrides:
- The beat-reply object is exactly `realtime: {topic, token, expiresAt}`, with **no URL** in it.
- The reason enum is closed: `go-live | stop | replaced | over | next-match`. There is **no `taken`** (see §2.3).
- Match Day topic is **per code**, not competition+day.
- **No server timeout** is shortened because of nudges.

---

## 1. Shared design

**Model.** Every payload is a ping, `{v, reason, at}`. It carries no state, IDs, scores or URLs. A ping means "read now". The existing read (beat, day read, hub fetch) stays the only truth, and the existing poll or cadence stays the liveness.

**One transport helper (T0.1).** Add `broadcast(messages: RealtimeMessage[])` to `lib/realtime.ts`:
- one POST to `/realtime/v1/api/broadcast` with a `messages` array;
- chunks of 100 messages per request (the API's per-request maximum is UNVERIFIED);
- the 3 s timeout, `publishTarget()` kill switch and fire-and-forget never-throw behaviour that exist today.

The existing publishers delegate to it with byte-identical message bodies. That is a verbatim refactor, in its own commit.

**One mint helper.** Add `mintRealtimeToken({sub, claims, expiresAt})`. `mintPublicFixtureToken` and `mintExternalPlayLobbyToken` become thin wrappers. Header, `aud` and `role: authenticated` stay unchanged.

**Claim names: one per family, never shared** (the V452 rule):

| Family | Topic | Claim | `sub` | Policy (migration) |
|---|---|---|---|---|
| Capture | `capture:{pairingId}` | `capture_pairing_id` | `capture:{pairingId}` | V554 |
| Match Day | `match-day:{codeId}` | `md_code_id` | `md:{codeId}` | V555 |
| Division | `division:{divisionId}` | `division_ids` (jsonb array) | `public-competition:{competitionId}` | V556 |

Each migration copies V403's shape: guarded on the `realtime` schema and `realtime.messages`, idempotent, catches `insufficient_privilege`, `for select to authenticated`, `extension = 'broadcast'`. The V556 predicate:
`realtime.topic() like 'division:%' and jsonb_typeof(auth.jwt() -> 'division_ids') = 'array' and (auth.jwt() -> 'division_ids') ? nullif(substr(realtime.topic(), 10), '')`
(each `realtime.topic()` and claim read wrapped in `(select …)` in the delta). Two guards beyond the first draft, both found in T3.1: jsonb `?` also answers yes for a scalar string equal to the id and for an object key, so the claim must be an array; and `substr('division:', 10)` is `''`, which `[""] ? ''` matches, so a blank id is nulled and binds nothing. The mint takes only lowercase-uuid ids, the spelling the topic builder uses.

**Fan-out cost** (HTTP POSTs per event, today → after):

| Event | Today | After |
|---|---|---|
| Score | 2 (+1 per advanced fixture) | **1**, whose messages are: fixture, division (×2 during the §4 dual window), each advanced fixture, and one per open Match Day code of the competition |
| Schedule write / court call | 1 + ≤50 | **1** (≤50 fixtures + division + Match Day codes + next-match capture pairings), chunked at 100 |
| Capture session transition | 0 | **1** (rare: a handful per match) |

The billed Realtime message count rises by the number of extra messages × subscribers. The Supabase per-message pricing and plan quota are **UNVERIFIED**; nothing in the repo states them.

**Connection quota.** Each phone holds one socket. Each spectator tab holds one socket per token family (§4.4), usually one. The Supabase concurrent-connection, channels-per-connection and join-rate limits are **UNVERIFIED**: no number is in the repo. The commonly cited plan defaults (hundreds of concurrent connections, about 100 channels per connection) must be read from the project's plan before Phase 3. When a quota is hit, a refused connection behaves like "Realtime down" and falls back to the poll. A large public final is the case to size for.

**Realtime down.** Publishes time out after 3 s and log a warning; the write never waits on them. Subscribers fall back as follows:
- **Phone:** beats at its answered cadence (5/10/60 s). This is unchanged, so silence and phone-lost judgement is unchanged (constraint 4).
- **Match Day:** polls at 15 s.
- **Hub:** 15 s live / 60 s idle.
- **Slideshow:** 45 s.
- **Board:** today it has no poll; it relies on push. T3.3 adds a 60 s safety-net poll.

A door failure (403, 429, 5xx, mint misconfigured) means no subscription and the poll alone. It never falls back to a public channel (realtime.ts I1).

**Security.** The JWT is a credential:
- It is delivered only in a response body: either the beat answer (`private, no-store` already) or a door with `cache-control: private, no-store`. It never goes in a URL query, a log line, a Sentry `extra`, a capture record, a snapshot, the beat history `raw` (that stores the beat body, not the answer), SSR HTML, or the Redis hub document.
- The `md_` and capture `tok` credentials only ever travel in `Authorization`.
- Tokens cannot be revoked. A short TTL is the bound, and the topic carries only pings.
- A test asserts that log output from a beat and from each door never contains the token (spy the logger, assert by substring).

---

## 2. Capture phone: `capture:{pairingId}`

### 2.1 Beat answer: one optional key

Add `realtime: {url, apikey, topic, token, expiresAt}` to the answer (phone review 2026-11-24: the phone has no baked Supabase config, and a dev build pairs to stg or prod by the code's server, so the environment must come from the server):
- `topic` is `capture:{uuid}`, `token` is the JWT string, `expiresAt` is `EpochS`.
- New schema `CaptureRealtime = z.strictObject({...})`, added to `AnswerCommon` as `.optional()`. It is omitted, never null, like `next`.
- `realtime` is not in the reserved read-name list, and its values are plain.
- **`url` and `apikey` are in the object.** Both are public (the fixture door already returns them). Guard: `url` must be `https:` and its host must equal the configured Supabase host (a server-side test). `realtime` is never recorded by the phone; T46's `delivery` stays free of URLs.

Sent:
- on every 2xx where the caller is the code's **current** pairing (waiting, go-live, live, over-with-current-pairing);
- never on `replaced` or `taken` (the caller no longer holds the pairing).

Minted fresh on each such answer. An ES256 sign is cheap, and minting each time keeps the server stateless.

- **TTL: 30 min**, comfortably over the 60 s far cadence. The phone swaps tokens (`setAuth`) when its held one has less than 10 min left.
- **A failed mint never fails the beat.** The key is omitted, the failure is logged without the token, and the beat continues (guard plus test).
- The answered `pollSeconds` and everything stored as the answered cadence are unchanged.

### 2.2 Wiring

`runBeat` (capture-phone.ts) and `postCourtBeat` (capture-court.ts) resolve `realtime` after the decision and pass it through `BeatAnswerCommon` → `wireBeatAnswer`. That function stays pure: the mint is the use-case's, injected through `SessionDeps`/deps so unit tests stub it.

Contract changes:
- `docs/contracts/capture-beat.v1.json`: additive optional property.
- New fixtures: `answer-valid-live-realtime.json`, `answer-valid-go-live-realtime.json`, `answer-invalid-null-realtime.json`, `answer-invalid-realtime-extra-key.json`, `answer-invalid-realtime-url-in-topic.json`.
- The tampered-branch guard must still refuse one extra key on every branch.

### 2.3 Where pings are published (all after commit, fire-and-forget)

| Transition | Where | Reason | Topic |
|---|---|---|---|
| Session → `requested` or `warming` (starting / armed; includes a court's next session) | `stream-sessions/apply.ts`, after `sql.begin` returns, when `before.state !== next.state` | `go-live` | current pairing of the session's `code_id` |
| Session → `ending` by Stop, **including the auto-stop path** (`auto_stopped`: stopped-automatically → ending, the case seen on stg 2026-11-24) | same hook | `stop` | same |
| Session → `completed`/`failed` | same hook | `over` | same |
| Pairing ended `replaced` (resume/takeover) | `capture-phone.ts` claim (:612-631), after the tx | `replaced` | the **old** pairing |
| Code ended (reissued/withdrawn/expired, `stream-codes.ts:325`) | after that tx | `over` | each pairing it ended |
| Court's `next` streamed match changes | `afterScheduleWrite`: fixtures → court → court link → current court pairing (skipped above `SCHEDULE_FIXTURE_PUSH_CAP`) | `next-match` | court pairing |

Notes on the table:
- Rows 1-3 sit at the one seam all session transitions pass through. A new module `stream-sessions/nudge.ts` does the pairing lookup (pooled read after commit, never inside the transaction: `lib/db.ts` nesting guard).
- The open session's `pairing_id` is moved on resume (:624), so the lookup reads the code's current pairing (`ended_at is null`), not the session column.
- **`taken` gets no ping.** It is answered to the claiming phone on its own beat, and the holder is unaffected.
- The phone's own `stopped`/`ended` beat (:689) gets no ping: it already knows.
- One court pairing outlives its matches, so its topic is stable across matches (constraint 3).
- The phone limits itself to one immediate beat per ~2 s. That stays well inside `CAPTURE_CODE_LIMIT` (120/min): 12 beats at 5 s plus at most 30 nudged beats.

**Entitlement.** None. The phone produces the data, which is the officials exception of doc 13 §6 that the fixture door already applies.

---

## 3. Match Day: `match-day:{codeId}`

**Scope choice: per code.**
- Org+day and competition+day need the publisher to compute a fixture's "day". The day read lists in-play matches whatever their date (F-T8-15, `match-day-code-view.ts`), so a day key would miss exactly those.
- Per code makes the TTL and revocation exact (a withdrawn code cannot re-mint).
- Fan-out stays at one POST: the publisher reads the competition's open codes and adds one message each.
- Pings are not filtered by the code's venue or courts scope. A ping only causes a re-read, and filtering would duplicate the day read's `covers` predicate. That makes them coarse-grained by design.

**Door.** `GET /api/v1/match-day-code/realtime-token`:
- `Authorization: Bearer md_…` only (constraint 5), resolved by `matchDayCodeOf(req, now, "realtime")`;
- same refusals as the day read (401 MD_UNKNOWN, 410 MD_WITHDRAWN/MD_ENDED, 403 MD_NOT_OPEN, 429);
- new `MdBudget` `realtime`, `MD_REALTIME_LIMIT` 120/min per code;
- reply `{token, topic, expiresAt, url, apikey}`, `private, no-store`. The URL and anon key are public and the fixture door already returns them, so a JS client needs no baked config;
- TTL = `min(60 min, expires_at − now)`. The client refreshes at 80% of the TTL, or when the channel errors;
- no entitlement check (officials);
- new contract file `docs/contracts/capture-matchday-realtime.v1.json` with fixtures.

A separate door rather than a key in the day read: it keeps the 44 KB day contract untouched, and it avoids minting every 15 s.

**Publisher.** New `server/usecases/match-day-nudges.ts` exports `matchDayNudgeMessages(competitionId, reason)`:
- reads open codes with `revoked_at is null and opens_at <= now < expires_at` for the competition;
- memoised 15 s per instance. A code created in that gap is covered by the poll.

Callers append its messages to the one batched POST in:
- the scoring callback (`scoring.ts:520`): reason `score`;
- `afterScheduleWrite`: reason `schedule`, or `call` when the caller is `match-day-call.ts`. That needs a new optional `reason` passed through `opts`.

`void-lines.ts:160` also publishes `score`: include it. `player-stats-refresh` does not affect the day read: exclude it.

**Read storms.** Each ping makes every phone on the code re-read. The client coalesces: at most one ping-driven read per 4 s, with a trailing read. That is ≤15 ping reads + 4 polls = 19 reads per minute per phone. `MD_DAY_LIMIT` 600/min then carries about 31 phones per code, not 150 (see Q4).

---

## 4. Division topics go private (public pages are LIVE in prod)

### 4.1 Door

`GET /api/v1/public/competitions/{id}/realtime-token`. The id comes from the hub document or the page props.

Two ways in:
1. **Spectator.**
   - Rate limit: a new bucket `pubv1rt:{ip}` at 120/min, so stadium NAT does not share the 60/min `publicRateLimit`.
   - The competition must be public: read via `public_competitions_v`/`public_divisions_v`, the same views as `fixtureRealtimeEligible`.
   - Entitlement: `org_has_feature(org_id, 'realtime', competition_id)`.
   - `division_ids` = every public division of the competition, not only the live ones, so a division going live later needs no re-mint.
2. **Official.** A cookie session whose org role can open the board (owner/admin, or an accepted official, matching `isFixtureOfficial`):
   - no entitlement check;
   - all divisions from the base tables, so private and unpublished competitions work (the board and the organiser's slideshow).

Rules for both:
- More than 100 divisions answers 403 `too_many_divisions`, and the client polls (Q5).
- Reply `{token, divisionIds, expiresAt}`, `cache-control: private, no-store`.
- TTL 60 min. The client re-fetches at about 50 min, or on `CHANNEL_ERROR`/`CLOSED`, with backoff.
- 403 and 429 both mean poll.

**Caching.** The hub document (Redis, `HUB_TTL`) and the SSR HTML stay token-free and shareable. The `realtime: boolean` in the cached document may lag its TTL; it only decides whether to ask, and the door decides. Make sure no CDN rule caches `/api/v1/public/**/realtime-token` (`no-store` plus a test on the header).

### 4.2 Clients (T3.3)

The hub, slideshow and board fetch the door, then `setAuth(token)`, then join `division:{id}` with `{config: {private: true}}`.

**A shared client cannot hold two token families.** `lib/supabase-browser.ts` is a singleton, and `setAuth` is socket-wide. A page holding a fixture token (`use-live-fixture`, `use-fixture-stream`, `use-room`) and a division token on the same client would overwrite one with the other. Whether Realtime re-authorises already-joined channels on a token change is **UNVERIFIED**.

Fix: add `realtimeClient(family: "fixture" | "division" | "lobby")`, which returns one client per family. Each private hook takes its own family. This costs one extra socket only on a page that mounts two families.

### 4.3 Rollout (dual-publish window)

1. **D-a (one PR):**
   - V556, the door, the clients and the family clients.
   - `publishDivisionUpdate` sends **both** the existing public message and a `private: true` twin in the **same POST**. That adds messages, not HTTP calls.
   - New clients never join the public topic.
   - **Gate before merging:** on STG, prove that a public subscriber does not receive the private twin and vice versa. Today's code implies the two are separate; it is UNVERIFIED.
2. **Window: 14 days after the D-a deploy reaches prod** (Q2). Old tabs and kiosks keep the public channel.
3. **D-b (a separate PR):**
   - drop the public message;
   - add a regression sweep: every message `broadcast()` is ever handed has `private: true`, and an empty sweep fails.

**What breaks after D-b, for tabs loaded before D-a and never reloaded:**
- They stay "SUBSCRIBED" to a silent public topic, so they believe push is up.
- The hub falls back to its 60 s idle poll (spectators up to a minute stale).
- The slideshow kiosk falls back to its 5 min `SUBSCRIBED_POLL_MS`. This is the worst case: a venue screen 5 minutes behind.
- The organiser board never refreshes until reload.
- Nothing errors and no data is wrong; it is staleness only.

Mitigations:
- the window itself;
- release notes telling organisers to reload kiosks;
- D-a's new slideshow also drops `SUBSCRIBED_POLL_MS` to 60 s;
- the board gains a 60 s poll.

**Behaviour change for non-entitled orgs:** today anyone can join `division:{id}` (the hub and slideshow only gate client-side, and the board not at all). After D-a, spectators of non-entitled orgs poll, which matches the fixture door's I1 ruling. Organisers keep push through the official path.

Capture and Match Day have no prod users (the phone app is unshipped), so they need no window: purely additive (constraint 6).

---

## 4.5 Security: `role: authenticated` tokens on many phones (phone review 2026-11-24)

These JWTs carry `role: authenticated` and are usable with the public anon key against PostgREST. Read-only check on stg (2026-11-24):
- Every policy granting `authenticated`/`anon`/`public` sits on `realtime.messages` (V403, V452, V537). There are 0 elsewhere. The 34 `public`-schema policies are for other roles.
- All 50 `public` tables have RLS enabled. With no policy for `authenticated`, RLS denies all, so the JWT reads nothing there.
- `seazn_club` (the app schema) has no USAGE grant for `authenticated`.
- **Already true today, without any JWT:** 10 `public` views (`public_*_v`, `team_display_v`) grant SELECT to BOTH `anon` and `authenticated`, and 9 of them are not `security_invoker`. So the anon key alone can read them via PostgREST if `public` is exposed. A minted token adds nothing beyond anon there, but whether these views are meant to be anon-readable is a separate finding (owner; prod check owed).

Guard (T0.1, a migration-level sweep test, anti-vacuity: report counts, and 0 scanned = fail):
- (a) no policy outside `realtime.messages` lists `authenticated`, `anon` or `public` in its roles;
- (b) every `authenticated` SELECT grant is also an `anon` grant (a token never widens anon);
- (c) every `realtime.messages` policy keys on its own family claim.
Mutate once: add a `to authenticated` policy on a public table, and the sweep must fail.


## 5. Tests owed (TEST-STRATEGY: unit, e2e, smoke, regression; anti-vacuity; mutate each guard once)

**Unit**
- `broadcast` chunking, timeout, kill switch, and that it never throws. Each refactored publisher is byte-identical to before: a golden body derived from today's literal, not from the new code.
- Each mint: claims, `sub`, `aud`, `exp`. The claim name is unique per family: a sweep over the three mints asserts no claim key overlaps `fixture_id`/`lobby_fixture_id`, and an empty sweep fails.
- Beat answer:
  - `realtime` present for a current pairing on every non-replaced/taken branch, absent on replaced/taken;
  - a mint throw gives an answer without the key, the beat stored, and a 200;
  - `pollSeconds` is unchanged with and without `realtime` (constraint 4);
  - contract fixtures valid and invalid; the tampered guard still refuses an extra key.
- Nudge hook: a table over every `SessionState` transition gives the expected reason or none. Covers a second apply with no change (no ping), resume moving the pairing (the ping goes to the new pairing), `replaced` pinging the old pairing, and a code ended pinging every pairing it ended.
- Match Day publisher: zero open codes gives zero messages, not an error; revoked, expired and not-yet-open codes are excluded; a second code on the same competition is included.
- Division door: anonymous non-entitled → 403; private competition anonymous → 403/404; official → all divisions; 101 divisions → 403; `no-store` header. Second call: a fresh token. Empty: a competition with 0 divisions → 403, not a token with `[]`.
- Doors: 429 path; `md_` in a query string is not accepted (401).
- Log-redaction spies (§1).
- Applies to another sport: N/A (no sport rules), stated in each test file.

**Migration tests:** V554-V556 against a Supabase-shaped schema. Each policy admits its own topic and refuses another family's token on it (a capture token on `fixture:`/`division:`; a `division_ids` token on an id outside its array).

**E2E** (CI runs the stub host and never dials; the `realtime-propagation-kit.ts` timing technique runs where a real socket exists):
- capture: the beat answer carries `realtime` on go-live and the poll cadence is unchanged (`stream-phone-panel` flow);
- Match Day: the door answers from a real `md_` code (`match-day.spec.ts` kit);
- hub, slideshow and board: the door is called, and with a 403 the page still updates within its poll;
- one STG-local timing spec per surface: the value moves in under the poll interval.

**Smoke:** extend `scripts/smoke/suites/captureV2.ts` (beat → `realtime` key shape, no token in the response headers or URL) and add `matchDayRealtime.ts` plus `divisionRealtimeDoor.ts` (status codes and `no-store`).

**Regression:**
- the D-b sweep (no public message);
- `afterScheduleWrite` sends exactly 1 POST for N≤50 fixtures (today it is 51), witnessed by counting fetches;
- the board keeps its safety-net poll (killed by setting it to infinity).

---

## 6. Phased task list (web only; each task is sized for one subagent and ships all four test types)

**Phase 0: shared**
- **T0.1** `lib/realtime.ts`: `broadcast()`, `mintRealtimeToken()`, topic builders. The existing publishers delegate verbatim. Fix the stale comment at `use-live-fixture.ts:289`.
- **T0.2** Batch the `afterScheduleWrite` and scoring callback publishes into one `broadcast()` each, with the fetch-count regression.

**Phase 1: capture** (after T0.1)
- **T1.1** V554 policy `capture pairing read by claim`.
- **T1.2** `CaptureRealtime` schema, contract JSON and fixtures (additive).
- **T1.3** Mint and wire into `runBeat`/`postCourtBeat` through deps. Never fails the beat.
- **T1.4** `stream-sessions/nudge.ts` plus the hook in `apply`, `replaced` in the claim, and `over` on code end.
- **T1.5** Court `next-match` pings from `afterScheduleWrite` (needs T0.2).

**Phase 2: Match Day** (after T0.1; can run in parallel with Phase 1)
- **T2.1** V555 policy.
- **T2.2** Door route, `MdBudget` `realtime`, contract file.
- **T2.3** `match-day-nudges.ts` plus the callers (scoring, void-lines, afterScheduleWrite with a `call` reason).

**Phase 3: division private** (after T0.1 and T0.2)
- **T3.1** V556 policy plus the STG separation gate.
- **T3.2** Competition door (spectator and official paths), `pubv1rt` bucket.
- **T3.3** `realtimeClient(family)`. Hub, slideshow and board go private; board poll; slideshow subscribed poll 60 s.
- **T3.4** Dual publish (D-a). Ships together with T3.1-T3.3.
- **T3.5** (14 days later) D-b: drop the public message plus the sweep.

**Contract notes for the phone team**
- **Beat:** optional `realtime: {url, apikey, topic, token, expiresAt(epoch s)}`.
  - Absent means poll only. It is absent on replaced and taken.
  - Swap tokens when less than 10 min remain. TTL is 30 min.
  - Join the topic private, event `nudge`. Payload `{v, reason, at}`, reason ∈ `go-live|stop|replaced|over|next-match`; treat an unknown reason as a ping.
  - The token never goes in records, snapshots, logs or URLs.
  - `url` and `apikey` come from the object (never build config); the phone uses `expiresAt`, never a local clock guess.
  - The server never shortens a timeout because of nudges; the beat is the truth.
- **Match Day:** `GET /api/v1/match-day-code/realtime-token` with `Authorization: Bearer md_…`.
  - Reply `{token, topic, expiresAt, url, apikey}`. Refusals as the day read; 429 carries `Retry-After`.
  - Coalesce ping reads to at most 1 per 4 s, with a trailing read. Keep the 15 s poll.
  - Reasons: `score|schedule|call`. Treat an unknown reason as a ping.
- The phone vendors both contracts after #68.

---

## 7. Open questions (each with a recommended answer)

1. **Should the beat carry the Supabase URL and anon key?** **Resolved (phone review 2026-11-24): yes**, inside `realtime: {url, apikey, topic, token, expiresAt}` with the https + host guard (§2.1).
2. **Dual-publish window length?** Recommend **14 days** after the prod deploy, plus kiosk-reload release notes. Extend if a STG Realtime inspector shows public `division:` joins still arriving. Whether that inspector exists is UNVERIFIED.
3. **Should capture and Match Day require the `realtime` entitlement?** Recommend **no**: they are officials producing data (doc 13 §6), and their socket count is small.
4. **`MD_DAY_LIMIT` under nudges?** Recommend a separate `MD_DAY_NUDGED` allowance, or raising `MD_DAY_LIMIT` to **1800/min**, so 150 phones at 19 reads/min fit. Confirm against real phone counts per code.
5. **Competitions with more than 100 divisions?** Recommend **poll** (403 `too_many_divisions`). If that ever happens in practice, move spectators to a single `competition:{id}` topic rather than raise the cap.
6. **Should Match Day approvals ping too?** Recommend **yes, reason `approval`**, as a follow-up task once T2.3 lands. It is outside the agreed scope, and the day read lists approvals.
7. **Should `REALTIME_PUBLISH=off` also stop minting?** Recommend **no**: the switch stays publish-only, so local and e2e runs still exercise the door and beat shape. Subscribers just hear nothing and poll.
8. **Supabase quotas (connections, channels per socket, messages, broadcast batch size).** All **UNVERIFIED**. Recommend the owner reads the plan limits before T3.4 ships, and records them in `lib/realtime.ts`'s header.

### Critical Files for Implementation
- /Users/ashokhein/github/seazn.club-worktrees/realtime-nudges/apps/web/src/lib/realtime.ts
- /Users/ashokhein/github/seazn.club-worktrees/realtime-nudges/apps/web/src/server/usecases/stream-sessions/apply.ts
- /Users/ashokhein/github/seazn.club-worktrees/realtime-nudges/apps/web/src/server/usecases/capture-phone.ts (with relay/domain/beat-answer.ts and api-v1/capture-schemas.ts)
- /Users/ashokhein/github/seazn.club-worktrees/realtime-nudges/apps/web/src/server/usecases/schedule/after-write.ts (and scoring.ts:520)
- /Users/ashokhein/github/seazn.club-worktrees/realtime-nudges/apps/web/src/components/public-site/use-live-competition.ts (plus lib/supabase-browser.ts, components/v2/slideshow.tsx, components/v2/board/use-board-actions.ts)
