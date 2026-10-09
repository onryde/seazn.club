# Capture QR v2: stable stream code, pairing, phone heartbeat, phone start — web-side design

**Status:** **approved by the owner, 2026-10-01** (at `137b9ec2b`, with rulings W18–W20); amended the same day for
those rulings. Every ruling in §1 is the seazn.club owner's, given in conversation on
2026-10-01. This file is now their record: the working log they came from
(`2026-10-01-capture-qr-v2-brainstorm.md`) lives only in a session scratchpad and will not survive it.
**Plan-time amendments, 2026-10-01:** §17 records the PR-1 plan's pre-flight rulings that change text above. Those
are the controller's rulings, plus one contract detail agreed with capture. They are **not** owner rulings, and §1
does not gain them. Each changed line carries "(amended, §17.n)".

**Branch:** `docs/capture-qr-v2-spec`, cut from `8ff43c8f0` (PR #908, the fixture-page stream panel, not yet merged).
The build branches for PR-1 and PR-2 are cut from `main` after #908 merges.

**Reads with:**

- `2026-09-30-fixture-page-stream-design.md` — the panel this changes (Option A, "Signal path"). Its D9 handed this
  work to its own branch and reserved the Phone node's one-line slot (§3.4 there) for it.
- `2026-09-07-streaming-programme-design.md` — the programme: the session machine (§6.4), credits (§5.2), secrets
  (§6.2), and the v1 QR contract (§7.6), which this design retires.
- The capture repo's S1 spec (`seazn.club.capture`, `docs/specs/2026-09-30-s1-live-stream-design.md`) and its
  amendment `docs/specs/2026-10-01-s1-amendment-stable-code-design.md`. The amendment was **approved by capture's
  owner on 2026-10-01** (capture commit `93d629a`, branch `feat/s1-plan-c`). Its revision `69ef359` (2026-10-01)
  folds in our replies to its asks, G0-d to G0-g, and its A18. **This spec is diffed against `69ef359`.**
  - **Its wire shapes are the base of our contract:** the QR, `GET code`, `POST start`, `POST beat` and the answer
    table.
  - Our replies to its ten asks are in §4.
  - §4 is also the gate before the schemas are published.

**Two PRs (owner ruling W13).** PR-1 is capture-facing and goes to staging first. PR-2 adds the organiser extras.
There is one spec and two plans. Each PR owns its sections below, and each section header says which PR it belongs to.

---

## 1. Rulings

### 1.1 The seazn.club owner's rulings (2026-10-01)

Each row below is the latest word on its subject. Where the log changed its mind, §15 records what was superseded.

| # | Ruling |
|---|---|
| W1 | **Stable per-fixture stream code**, "like Remote scoring". Storage follows the same pattern as `device-links.ts`: a sha256 hash to verify against, plus a KEK-sealed copy so the QR can be drawn again. The QR does not change between Go-lives. **Revoke & reissue** is the only thing that changes it. |
| W2 | **Expiry.** The code is valid until the match is finished (result saved, void or abandoned), plus a **2 h grace**. There is **no time cap** ("also risk, no enforce"). Expiry **never ends a live session**. Pausing today and resuming tomorrow on the same saved code works: a restart inside 24 h is free through the reuse window, otherwise it costs 1 credit. The server enforces expiry: after finish + grace, a code answers 401. |
| W3 | **QR = option (b).** The stream credentials move out of the QR and into the descriptor, which leaves the QR at about 80 characters. The descriptor serves Cloudflare publish secrets under four rules: **no-store, never logged, a constant-time tok compare, and served only for a valid tok**. |
| W4 | **No v1 transition.** "Nobody is using the v1 QR." This is a hard cut to v2, and the v1 contract and its fixtures are removed. |
| W5 | **Pairing.** A scan makes the phone check in, and it sends `paired` beats before any session exists. The panel's Phone node then shows paired. **Go live is enabled only once a phone is paired.** A credit is spent only when video reaches Cloudflare. |
| W6 | **The operator may start from the phone** (a 3 s hold, then `POST start`). It passes the same gates as the console: credits, a destination and entitlement. It needs a destination the organiser picked in advance (chosen when the QR is shown, and saved per fixture). Any refusal gives the phone a plain reason: `409 no_destination`, `402 no_credit`, `403 not_entitled`. `409 already_live` means the phone takes over the running broadcast. |
| W7 | **Automatic mode** is an opt-in switch per fixture, **"Stream the match automatically"** (PR-2). Auto start fires from **any** scoring surface's match start, and only with a paired phone. It fires **once**, and never after an organiser Stop. **Auto stop** fires about **3 min after the result is saved**, under the same switch. A manual Go live and a manual Stop are always available. |
| W8 | **Phone silent while live (Q1).** The panel only warns: "Phone not responding" plus the time since the phone was last heard. The stream keeps running, and Cloudflare's input signal stays the authority on whether video flows. Heartbeat silence never ends a live session. **Amended by W19:** silence **and** no video for 15 min ends it. |
| W9 | **Phone health on the panel (Q2).** One compact line sits on the Phone node, for example "Phone · 78% charging · 2.4 Mbps · heard 4 s ago". It turns **amber, with a plain sentence**, when the battery is under 20% and not charging, when the phone is running hot, when delivery has stalled, or when the phone is not responding. Data used and the app version sit behind a tap. **Mockups at 320/768/1280 are owed before the build.** |
| W10 | **Heartbeat storage (Q2b).** The latest beat overwrites one field on the session, so the session keeps the final beat. History keeps one beat per minute plus a row on every state change. **History is deleted after 1 day.** The final beat is never deleted. |
| W11 | **Overlay on phone streams (Q3).** The descriptor's `overlayUrl` is filled only when the org has the `streaming.overlay` entitlement, and is `null` otherwise. It is **built server-side** from the environment's base URL, on the exact Seazn host, with the signed overlay key. |
| W12 | **Phone-side Stop (Q4).** A beat with state `ended` ends the session at once: the destination is freed, no further credit is spent, and the panel reads "Stopped from the phone". Silence, reconnecting and degraded only warn. (The condition was met: the phone sends `ended` only on an explicit operator Stop of a live broadcast.) |
| W13 | **Two PRs.** PR-1 (capture-facing, staging first) and PR-2 (organiser extras). |
| W14 | **Playback host (Q5).** One Cloudflare account serves staging and production, through the customer subdomain `customer-vv7totdc7j19biah.cloudflarestream.com`. It is not a secret, but it lives in **Doppler** with the other runtime configuration (amended 2026-10-05, OG9): the owner set `STREAM_INGEST_HOST` and `STREAM_PLAYBACK_HOST` in Doppler `stg`, which syncs them to the Fly app, not in `fly.stg.toml [env]`. |
| W15 | **Ingest hosts.** Credentials use `rtmps://live.seazn.club:443/live/` and `srt://live.seazn.club:778` in production, and `live.stg.seazn.club` on staging, with one environment setting per environment. **SRT on the custom host must be proven with ffmpeg on staging** before it is relied on. **Amended by W21:** SRT stays on Cloudflare's own host from launch; only RTMPS uses the custom host. **Superseded by W26 (2026-10-05):** no custom host for either. |
| W16 | **Allow both** (answering mobile-s1): (1) operator start, as W6; (2) auto stop, as W7. |
| W18 | **Overlay on every phone stream (O1, ruled YES 2026-10-01, on approving this spec at `137b9ec2b`).** The scorebug goes on phone streams for every plan. The rule stays the `streaming.overlay` entitlement (W11), so an override still switches it off for one org. |
| W19 | **A live phone stream whose phone is gone ends (O2, ruled YES 2026-10-01).** After **15 min with no beat AND no video**, the session ends with endReason `phone_lost`. **Built in PR-1** (§6.8.5). |
| W20 | **The SRT-on-`live.*` test is deferred (2026-10-01).** G0-h is no longer a publish gate. The schemas publish now with `cred.srt` nullable. The custom-host SRT proof becomes an **optional** later staging step (S2b), not a gate. (Its first form, "`STREAM_SRT_ENABLED` defaults to false", is superseded by W21 the same day.) |
| W21 | **SRT uses Cloudflare's own host (owner direction, 2026-10-01).** `cred.srt.url` is `srt://live.cloudflare.com:778`, exactly as Cloudflare issues it. RTMPS stays on the environment's custom host (`live.seazn.club` / `live.stg.seazn.club`) — **superseded by W26: RTMPS also uses `live.cloudflare.com`.** `STREAM_SRT_ENABLED` **defaults ON**, so SRT is offered from launch; A18's `srt: null` stays a safety net. S2b could later move SRT to the custom host with **no contract change**. Capture's host rule admits `live.cloudflare.com` for SRT: **agreed** (§4.2 G0-i, capture's owner's ruling, 2026-10-01). |
| W22 | **A 5-minute stream tick (O3, ruled YES 2026-10-01).** The Cloudflare Cron Triggers programme (`docs/superpowers/plans/2026-09-28-cloudflare-cron-triggers.md`, branch `docs/cloudflare-cron-triggers`) **executes first**. PR-1 adds a `stream-tick` job: the route `POST /api/cron/stream-tick` plus its row in `apps/cron-worker`'s schedule, every 5 min (§6.11). It ends `phone_lost` streams (W19) and warming timeouts without a panel open. PR-2's auto stop rides the same tick. The panel's poll still ticks too, for a fast answer while the panel is open. **PR-1 executes only after the cron plan merges.** |
| W23 | **Free restarts are capped at 3 (2026-10-01).** Inside the 24 h reuse window, 3 restarts are free; the next Go live costs 1 credit. It never hard-blocks. Only restarts that **reached video** (`first_ingest_at`) count. The first live is the paid one. A rejoin or takeover of the same sid never counts, and neither does a Go live that never got video. The panel shows the count before Go live ("Free restarts used (3 of 3) — this one uses 1 credit"). Built in PR-1 (§6.7.4). This reading of the ruling was put to the owner by the coordinator; §16 O4 records the one point it leaves open. |
| W24 | **A reconnecting countdown (2026-10-01).** While live with no video from the phone, the Phone node says "Reconnecting…" instead of "No signal". After a 30 s hold, a sentence counts down to the W19 end: "No video from the phone for {elapsed} — the stream ends in {remaining} if it doesn't come back." Warming ("Waiting for camera…") gets the same countdown to the 10-min warming timeout. Built in PR-1 (§6.12). The PR-1 mockups show these states. |
| W25 | **The unnamed-match label is localised (2026-10-01).** The "Match {n}" fallback sent to the phone uses the competition's locale, not English (§6.4). |
| W26 | **No custom ingest host (owner ruling, 2026-10-05). Supersedes W15 and the RTMPS half of W21.** Both credentials use Cloudflare's own host, exactly as Cloudflare issues them: `rtmps://live.cloudflare.com:443/live/` and `srt://live.cloudflare.com:778`, in every environment. `STREAM_INGEST_HOST` stays **unset** in Doppler `stg` and `prd` (removed from `stg` 2026-10-05 19:09:55Z); the code path is unchanged, since unset already serves Cloudflare's host. `live.stg.seazn.club` / `live.seazn.club` are no longer served to phones. **Capture-side consequence:** the capture app's RTMPS host pin admitted only `live.<env>.seazn.club`, so it refused `live.cloudflare.com` for RTMPS (seen on stg 19:11Z). Capture's owner then ruled (2026-10-05) that the app trusts **only** `live.cloudflare.com` for both SRT and RTMPS in every environment. So **setting `STREAM_INGEST_HOST` again would break every phone**: the RTMPS rewrite in `ingestCred` would serve a host the app refuses. |
| W27 | **The phone fetches the match's Remote scoring link (2026-10-06; owner sign-off 2026-10-06, capture lane agreed — recorded here from the controller's brief of that date).** `POST /api/v1/capture/codes/{code}/scoring-link`, the start's Bearer `tok` and strict body `{phone}`. Only the slot's CURRENT phone (the start's holder check) is answered; any other phone gets `409 replaced`, and an ended code `401 code_ended`. It is allowed whether or not a session exists or is live. The owner's rule, verbatim: "must not remove or replace any existing QR … when phone requests a link/code for qr, just provide or create the new one". So the fixture's NEWEST live link — the one row the console's ensure reads — is returned when it is sealed and its envelope opens AND hashes to its row's `token_hash`; otherwise a new sealed link is inserted beside it, stamped as the newest, and **nothing is revoked** — never the console's revoke-and-mint (amended 2026-10-07, review M1: an older good link is never dug out from under a newer bad one, so the phone and the console always agree on the row). It takes the console's per-fixture link lock, so a concurrent console ensure or print cannot double-mint. `issued_by` is the code's issuer; no label; no expiry. `200 {url}`, the server's base URL plus `/score/<secret>`, matching `^https://[^/]+/score/dl_[A-Za-z0-9_-]{43}$`. Refusals: a plan without `scoring.device_links` → `402 not_entitled`; a finalized or cancelled match → **`409 match_finished`** (a new refusal code; the console answers 422, the phone 409 by agreement), no link made; `DEVICE_LINK_KEK` missing → `503 unavailable`; the console's `DEVICE_LINK_MINT_LIMIT` per IP → `429 rate_limited` with `Retry-After`, spent only once the tok and holder checks pass (amended 2026-10-07, review M2); the link insert breaking a foreign key — the code's issuer deleted — → `401 code_ended` (amended 2026-10-07, review M4). The URL is a credential: never logged, never stored anywhere new. G1 owner ruling 2026-10-07: device-link Revoke & reissue does not lock out a paired capture phone; the warning tells the organiser to reissue the streaming QR too. §6.3.5. |
| W28 | **Every descriptor shape carries the match's `stage` (2026-10-06; owner sign-off 2026-10-06, capture lane agreed — recorded here from the controller's brief of that date).** An optional `stage: {code, role: {kind, n?, entrants?}, pool?}` on the waiting shape and on every session state, recomputed on every read. `code` (1–8 characters) is exactly the scheduler board's chip for the fixture, in the language the label uses (W25); `role` is the engine's `RoundRole`, serialised verbatim; `role.kind` is an OPEN string in the published schema, and a consumer shows nothing for a kind it does not know; `pool` (`^[A-Z]$`) is the key of the fixture's pool, never its English name. Absent when no code can be produced. label added 2026-10-07 (#923 pool word): an optional `stage.label` (1–40 characters), shown by the phone verbatim — the pool's word in the org's locale (`table.poolLabel`, "Group A", "Grupo A") + " · " + `code`, or exactly `code` without a pool; omitted and logged, never cut, when over 40, and the phone then shows nothing. **Amended 2026-10-08 (owner ruling 2026-10-08, Option A: division · pool · round, "Round {n}" for a plain round, the pool → division → omit ladder; the long names for the final, third place and grand final are A1, a recommendation applied when the owner said "raise PR"; supersedes the 2026-10-07 label shape above):** `stage.label` is the division's name, then the pool's word for a pooled match, then the round, joined with " · " (`Open · Round 2`, `Open · QF`, `Open · Final`, `Girls U14 · Group A · Round 2`), in the org's `default_locale`. The round is `bracket.round.plain` ("Round {n}", "Ronda {n}") for a plain round — every uncoded round, n being the number its `R{n}` chip shows; the long name for `final`, `third_place` and `grand_final` (`bracket.round.final` / `.thirdPlace` / `.grandFinal`: "Final", "Third place", "Grand final"); the chip (`code`) for every other role. Over 40 characters the pool's word is dropped first, then the division; a round still over 40 omits the label, the rest of `stage` kept. Each drop is logged with the fixture, the length and the part dropped. `code`, `role` and `pool` are unchanged, and so is the contract's shape (1–40, optional). §6.4. |
| W17 | **Answers sent to mobile-s1** (their owner approved them): `autoAllowed` sits in both waiting and session; there is one start endpoint, with `409 already_live` meaning take over; the heartbeat answer carries go-live and over; the server drives `pollSeconds`, 60 s and then 10 s from 30 min before the scheduled start; code names are neutral; the waiting answer carries the chosen destination's display name, or `null`; the panel shows the phone's mode. |

### 1.2 Capture's rulings we build against (their owner's; peer facts, not ours)

These came through mobile-s1. Under AGENTS.md #17 they are capture's owner's word to capture, not our owner's. Our
owner accepted the web-side consequences recorded in the log, and those consequences are designed below.

| # | Capture ruling (2026-10-01) | Web consequence |
|---|---|---|
| A1 | The QR is `{v:2, code, slot, tok, exp?}` with no credentials. An absent `exp` means the server decides. | We never send `exp` (§6.2). |
| A2 | Either side starts: the console's Go live, or the operator's 3 s hold → `POST start`. | One start path (§6.7). |
| A3 | Either side stops. **An organiser Stop returns the phone to paired-waiting on the same code. The operator's Stop ends the broadcast AND unpairs**, so the next broadcast needs a rescan. | Pairing machine §5.2: T20 keeps the pairing, T21 ends it. |
| A4 | Automatic mode starts at match start and stops about 3 min after the result, **only when the console's switch and the phone's switch are both on**. The phone's switch is on by default. | §7.2 and §7.3 read both. |
| A7 | Opening another app mode while paired asks first, then unpairs. | None server-side: the pairing simply goes silent (§6.5). |
| A9 | When a second phone pairs the same code and slot, the newest pairing takes over and the old phone is told. Pairing a LIVE slot is refused. | Claim table §6.5: answers `replaced` and `taken`. |
| A10 | A paired phone that hears `live` for its code and slot rejoins with no tap. | Beat answer `live` (§6.3.3). |
| A11 | A remote or automatic start runs the phone's pre-flight. A phone that is not ready stays paired and reports why. | `warmingDeadline` is re-anchored (§6.7). The beat carries `notReady`. The panel shows it in PR-2. |
| A12 / A15 | An organiser Stop turns auto **start** off for that match. Auto **stop** still applies to a broadcast restarted by hand. | §7.2. |
| A13 | Phone copy, and `destinationName` cut at about 24 characters on the phone. | We send the full label, up to the contract's maxima (amended, §17.6). |
| A14 | A dead live phone may be taken over once there has been **no beat AND no video for 60 s**. The new phone rejoins the open broadcast, on the same credit. | §6.5, rule T4. |
| A16 | Auto start fires once per match: at match start or on a late pairing, whichever comes first. | §7.2. |
| A17 | The operator's Stop wins. The phone re-sends the stop on its next pairing. The server closes that sid even late, idempotently, and never a newer one. | §6.8. |
| A18 | `cred.srt` may be null, with `preferred:"rtmps"`, **as a safety net only**. The target stays SRT on `live.seazn.club` / `live.stg.seazn.club`. With `srt` null the phone publishes RTMPS only, with no SRT→RTMPS fallback. | Kept as the safety net: `STREAM_SRT_ENABLED` off. By W21 the flag defaults **on**, with SRT on `live.cloudflare.com` (§6.4). |

---

## 2. Goal, users, success

**Who:**

- the organiser, at the fixture page on a laptop or a phone;
- the camera operator, holding a phone running Seazn Capture at the court.

**Job:** pair a camera phone to a match once, then start and stop the broadcast from either end without anyone
re-scanning, and see from the panel whether the phone is healthy.

**Success means:**

- One QR per fixture. It is printable and stays valid until the match is over plus 2 h.
- A photo of the QR leaks no stream key.
- Go live is offered only once a phone is paired. The phone starts publishing within one beat of Go live, with no tap.
- The operator can start (if the organiser pre-picked a destination) and stop from the phone.
- A phone that dies mid-match can be replaced by another phone without a console visit, on the same credit.
- The panel says, in one line, how the phone is doing (PR-2).
- Nothing about the destination, credits or Stop changes. The v1 QR is gone.

---

## 3. Vocabulary

| Term | Meaning |
|---|---|
| **code** | The stable stream code of one fixture. It is a public identifier (12 characters), not a secret. |
| **tok** | The code's secret: a 128-bit random value, sent as `Authorization: Bearer`. It is stored as a sha256 hash plus a RELAY_KEK-sealed copy. |
| **slot** | A camera position under one code. Only slot `0` exists, and any other slot is refused (§6.3). Multi-camera is a later programme. |
| **phone** | The capture app's install id, random and generated once per install. It is not a secret. It identifies a device across that device's requests. |
| **pairing** | One phone holding one code and slot. At most one pairing per code and slot is **current**. |
| **claim** | The first beats of a pairing, carrying `claim: "new" \| "resume"` until the first 2xx answer. |
| **session / sid** | The existing `fixture_stream_sessions` row, one broadcast. The sid is a UUID. |
| **open session** | A session in an ACTIVE state (`requested`, `provisioning`, `warming`, `live`, `ending`). |
| **live slot** | The slot whose open session has received ingest (`first_ingest_at` is not null). |
| **present / silent** | Whether the current phone's last beat is recent (§6.9). |
| **finished** | A fixture status in {`decided`, `finalized`, `forfeited`, `abandoned`, `cancelled`, `needs_decision`}. The owner's word "void" is `cancelled`. `needs_decision` (format matrix W2a: a level bracket result, held for the organiser's settle) joined by controller ruling D-M1 (2026-10-09, owner-delegated): no play remains, so it arms the automatic stop like the others; V432 redefines `fixtures_track_finished` to match. |

---

## 4. The contract and its publish gate (G0) — binding on PR-1

**Where the contract comes from.** It is capture's approved amendment (`93d629a`, revised `69ef359`: its "Contract
shapes", "The answer table" and "Asks for the web side"), with our replies to its asks:

- **Spelling:** the phone's words are kebab-case and the server's snake_case. `mode` is `"automatic" | "operator"`.
- **Names become final only when we publish the schemas** in `docs/contracts/` (§6.14). Until then PR-1 builds and
  tests the server behaviour against zod shapes in `schemas.ts` that use exactly these names.
- **Optional versus null.** A field written `x?` in the shapes is **omitted** when it does not apply, never sent as
  `null`. A field written `x | null` is **always present**. This matters because the two sides' parsers are strict:
  `scheduledStart` is `?` on the waiting and session shapes and `| null` on the beat answer (§6.4); `sid`,
  `startedBy` and `endReason` on the beat answer, and `endReason` and `cred` on the session shape, are `?`. (Amended,
  §17.5: the beat answer and the session shape are unions on `state`, which say per state what is present.)
- **The body envelope** (agreed with capture, 2026-10-01). Every 2xx is the bare shape, never the house
  `{ok, data}` envelope. Every refusal is the bare object `{ code: "<word>", message, ...extras }`, for example
  `409 {code: "already_live", message, sid, startedBy}`, `409 {code: "replaced", message}`,
  `409 {code: "no_destination", message}`, `402 {code: "no_credit", message}`, `403 {code: "not_entitled", message}`
  and `401 {code: "code_ended", message}`; W27 (2026-10-06) adds `409 {code: "match_finished", message}`, answered only
  by `…/scoring-link` (§6.3.5). **The phone keys its copy on `code`**; `message` is a plain English
  developer string that the phone never shows. The phone routes therefore return their own `NextResponse` through
  `handler()` (it passes a `Response` through unchanged) and never throw a bare `HttpError` for a refusal, because
  `handler()` drops `HttpError.extra` (losing `sid` and `startedBy`) and names the sentence `error`, not `message`.
  A test pins the raw body of every answer, success and refusal, against the contract fixtures.

### 4.1 Our replies to capture's asks (adopted)

| Ask | Reply |
|---|---|
| 1 — the beat answer carries what the phone shows; `auto_stopped` in both vocabularies | Agreed as written (§6.3.3). |
| 2 — the claim per phone, `new \| resume`; answers `replaced` and `taken` | Agreed as written (§6.5, T1–T7). A claim of either kind for a slot with **no** current phone is accepted. |
| 3 — `go-live` and `live` told apart; an ended sid is answered `over` first | Agreed as written (§6.3.3). |
| 4 — `409 already_live {sid, startedBy}` | Agreed as written. |
| 5 — the waiting shape gains `overlayUrl` | Agreed as written. |
| 6 — the server applies auto start and auto stop | Agreed as written (§7.2, §7.3). |
| 7 — a stop from the phone closes its `sid`, and only that one | Agreed as written (T23, T24). |
| 8 — beats and 410 | **Beats never answer 410.** A sid that has ended, named by a beat (its `sid` or its `stopped`), gets `200 {state:"over", sid, endReason}`. 410 is reserved to `GET code`. This server answers an ended broadcast on `GET` with the session shape in `completed` or `failed` (to the phone) or the waiting shape (to the scan), so **no route of ours sends 410** today. |
| 9 — `POST start` carries `{phone}`; a phone that is not current gets `409 replaced` | Agreed as written. |
| 10 — a warming broadcast whose phone has gone quiet is ended | **Required, agreed.** The new end reason `phone_lost` (not `stopped`), with no credit spent. §6.8.3 gives the exact clock. |
| New from us (capture's A18) | **`cred.srt` may be `null`, with `preferred: "rtmps"`, as a safety net only.** By W21 SRT is offered from launch on `srt://live.cloudflare.com:778`; RTMPS is on the environment's `live.*` host. |

### 4.2 G0 — the publish gate

**The schemas and fixtures in `docs/contracts/` are written and published only when capture has confirmed every item
below in writing.** Each confirmation is recorded here with its date and capture's commit. **G0 is closed
(2026-10-01).** The schemas publish in PR-1's first task.

| # | Item | Status |
|---|---|---|
| G0-a | Ask 8 as replied: beats never 410, and an ended sid named by `sid` or `stopped` gets `over`. | **agreed**, `69ef359`, 2026-10-01 |
| G0-b | Ask 10 with the end reason `phone_lost`, and no credit spent (the credit is spent at the first ingest). | **agreed**, `69ef359`, 2026-10-01 |
| G0-c | `cred.srt` nullable, with `preferred: "rtmps"`, as A18's safety net only. | **agreed**, `69ef359`, 2026-10-01 |
| G0-d | **`GET code` carries `?phone=`.** `cred` goes only to the slot's current phone (§6.3.1, §10.2). Any other caller gets the waiting or session shape with `cred` absent. The JS scan's GET omits `phone` and receives the waiting shape. | **agreed**, `69ef359`, 2026-10-01 |
| G0-e | **`device: {model} \| null` on claim beats**, `Build.MODEL` only. PR-2 shows the paired phone's model and the takeover notice (§7.5). | **agreed**, `69ef359`, 2026-10-01 |
| G0-f | **The end-reason value `failed`**, for a server-side end that is neither a stop nor a timeout (a credit running out at the live transition, a provider fault). Capture reads it "Stream ended by Seazn — ask the organiser". | **agreed**, `69ef359`, 2026-10-01 |
| G0-g | **A claim and a stop are independent.** A claim refused while it carries `stopped` is answered `taken` or `replaced` by the claim rules, not `over X`. The stop is still applied, and that 2xx delivers it. | **agreed**, `69ef359`, 2026-10-01 |
| G0-h | **The staging SRT test** on `srt://live.stg.seazn.club:778`. | **deferred by the owner, 2026-10-01 (W20): not a gate.** Optional later step S2b. |
| G0-i | **Capture's ingest-host rule admits `live.cloudflare.com` for SRT** (W21). RTMPS stays on the environment's `live.*`. The schema documents the SRT hosts as {`live.cloudflare.com`, the environment's `live.*`}. | **agreed, 2026-10-01.** Capture reports that their owner ruled independently: `cred.srt` may sit on exactly `live.cloudflare.com` or the environment's `live.*` host, and RTMPS and every other URL stay strict `live.*`. Their A18 is being updated to match. So `STREAM_SRT_ENABLED` defaults on in prod and stg from launch, with **no interim `false`**. |

- **The schemas are published first.** PR-1's first task writes them to `docs/contracts/` and removes v1, so
  capture can vendor them while the server is built.
- **G0 settles names and confirmations, not behaviour.** If capture's answer to any item changes behaviour (a state,
  a refusal, a status code), the change comes back to this file and to our owner. It is not absorbed in the plan.
- **A tooling fact for every SRT check (S2, S2b):** `srt-live-transmit` refuses ports below 1024, so it cannot
  target `:778` directly and needs a local UDP relay (a high local port forwarded to the host's `:778`). ffmpeg built
  with libsrt can target `:778` itself.
- **The six points from our diff against `69ef359` were agreed by capture** (folded at capture `5344d04`, feat/s1-plan-c) (2026-10-01): the refusal body
  `{code, message, ...extras}` (§4); no hint field, since a session shape without `cred` is the hint (§6.3.1); the
  session shape gains `pollSeconds`, `code`, `scheduledStart` and `destinationName` (§6.3.1); the phone always sends
  `?slot=` (§6.3.1); the stale ask-10 wording in their _Known gaps_; and the A17 edge, under which a `stopped` from a
  phone that is not current closes its sid only if no current phone holds it (T23, T24a).

---

## 5. State machines

Four machines interlock: the **code**, the **pairing** (per code and slot), the **session** (existing, with new
causes and reasons), and the **slot**, which is derived from the other three. Each is a pure module under
`server/relay/domain/`, decided by a table, with no I/O and `now` passed in. This is the `session.ts` precedent and
the design-pattern rule's strategy table.

### 5.1 Code — `domain/stream-code.ts`

```
            ensure / first mint
   (none) ───────────────────────▶ ACTIVE ──── reissue ────────────▶ ENDED(reissued)
                                     │                                     │
                                     │ fixture finished                    │ (old code still serves its open
                                     ▼                                     │  session's phone until that
                              ACTIVE·FINISHING ── result reverted ──▶ ACTIVE   session ends: rule C3)
                                     │
                                     │ now ≥ finished_at + 2 h
                                     │ AND no open session
                                     ▼
                               ENDED(expired)
   fixture deleted ⇒ row gone (cascade) ⇒ every call 401
```

**Rules:**

- **C1 — validity.** A code answers a call only when its tok verifies **and** one of these holds:
  - (a) the code is ACTIVE or ACTIVE·FINISHING; or
  - (b) it is ENDED, the call comes from the **phone of the fixture's open session**, and that session was created
    before the code's `ended_at`.

  Anything else is `401`, with code `code_ended`. The wire does not distinguish "expired" from "revoked", because the
  phone forgets the code either way. The panel distinguishes them.
- **C2 — expiry is evaluated, never scheduled.**
  - `expired = finished_at IS NOT NULL AND now ≥ finished_at + CODE_GRACE_AFTER_FINISH_MINUTES (120) AND no open session`.
  - The first evaluation that finds it true writes `ended_at = now`, `end_cause = 'expired'`, and wipes `tok_enc`.
  - An open session **defers** expiry, which is W2's "never ends a live session". Its phone keeps working until the
    session ends.
- **C3 — reissue defers the same way.** Revoke & reissue ends the old code at once, so the new code can be shown
  and the partial unique index admits it. The old code still serves (C1b) the open session's phone, for that session
  only, until it ends. It serves no new claim, no other phone and no start. This rule exists because the remedy for a
  hijacked LIVE slot is **Stop**, and Revoke is the remedy for a hijacked pairing (§10.3).
- **C4 — minting is refused on a finished fixture** (`422 fixture_finished`). There is nothing left to start. Ensure
  re-shows an ACTIVE·FINISHING code inside the grace.
- **C5 — a reverted result** clears `finished_at` (§8.1 trigger), so the code is plain ACTIVE again. A code already
  ENDED(expired) stays ended. The organiser mints a new one, which C4 allows because the fixture is no longer
  finished.

### 5.2 Pairing — `domain/pairing.ts`

```
   claim accepted                    beat (current phone)
 ─────────────────▶ CURRENT ◀──────────────────────────────┐
                      │  │  ▲                              │
                      │  │  └── ORGANISER Stop (A3, T20): the broadcast ends, the pairing STAYS ── phone hears
                      │  │      `over S stopped` and waits for the next Go live on the same code
                      │  └── no beat for silentAfter ──▶ CURRENT·SILENT ── beat ──┘
                      │
     ┌────────────────┼───────────────────────┬────────────────────────────┐
     ▼                ▼                       ▼                            ▼
 ENDED(replaced)  ENDED(operator_stopped)  ENDED(code_ended)       (row deleted with the code)
 another phone's  the OPERATOR's Stop      C1 refuses this phone
 claim took the   (A3, T21): an `ended`
 slot (T2, T4)    beat ends the broadcast
                  AND the pairing; the
                  next broadcast needs a
                  rescan (a new claim)
```

The two Stops are asymmetric on purpose (A3):

- **An organiser Stop** never touches a pairing.
- **The operator's Stop** always ends the pairing that sent it.

Silence is a derived condition, not a stored state (§6.9). `ENDED(code_ended)` is written lazily when a call from
the pairing is refused 401.

### 5.3 Session — additions to `domain/session.ts`

The machine `requested → provisioning → warming → live → ending → completed | failed` is unchanged. This design adds:

- **`startCause`** ∈ {`organiser`, `operator`, `automatic`}, set at creation and never changed.
- **`stop` carries a reason:** `{type: "stop", reason: "stopped" | "operator_stopped" | "auto_stopped" | "phone_lost"}`.
  `endReason` widens to those four plus `max_duration`. `ending × stop` stays identity: the **first** reason wins,
  exactly as today.
- **The warming timeout is anchored on warming entry** (`warmingAt`), not `createdAt`. `warmingDeadline` is
  `warmingAt + WARMING_TIMEOUT_MINUTES` (10). The 10 minutes are unchanged. What changes is that time spent in
  `provisioning` no longer eats into the phone's pre-flight window (A11).
- **The streaming phone** (`pairingId`) is recorded on the session. It moves on a takeover (T2 and T4 below), and
  the session's phone answers for it.

### 5.4 Slot — derived, `domain/slot.ts`

| Slot state | Definition |
|---|---|
| `empty` | No current pairing. |
| `paired` | A current pairing and no open session. |
| `starting` | Open session in `requested` or `provisioning` (no credentials yet). |
| `armed` | Open session in `warming` with no ingest yet (`first_ingest_at` is null). The beat answers `go-live`. |
| `live` | Open session with `first_ingest_at` set, in `warming` (a reconnect), `live` or `ending`. The beat answers `live`. |
| `live·dead` | `live`, and the A14 condition holds (T4). |
| `live` | Open session in `live` with `first_ingest_at` still null (a composed runner can play before the poll records ingest). (amended, §17.9) |
| `starting` | Open session in `ending` that never received ingest (stopped while starting or armed). (amended, §17.9) |

### 5.5 Transition table — every event, including the unhappy paths

"Phone P" is the caller and "C" is the slot's current pairing. The answers are the beat answer's `state` (§6.3.3)
unless a status is shown.

| # | Event | Condition | Effect | Answer to the caller |
|---|---|---|---|---|
| T1 | claim `new` from P | slot `empty`, `paired` (with C = P), or any state where C = P | P becomes or stays current | answer for the slot state |
| T2 | claim `new` from P ≠ C | slot `paired`, `starting` or `armed` | C → ENDED(replaced). P becomes current **and the session's phone**. Event `phone_takeover`. | answer for the slot (`go-live S` when armed) |
| T3 | claim `new` from P ≠ C | slot `live` and C is not dead | refused. No row is written. Event `claim_refused`. | `taken` |
| T4 | claim `new` from P ≠ C | slot `live·dead`: C has sent **no beat for ≥ 60 s** AND a fresh Cloudflare read says the input is **not connected** AND no poll sample has read it connected for ≥ 60 s | C → ENDED(replaced). P becomes current and the session's phone. Same sid, same credit. Event `phone_takeover {dead: true}`. | `live S` (P rejoins) |
| T5 | claim `resume` from P | C = P, or the slot has no current pairing (ask 2: "a claim of either kind … for a slot with none") | as T1 | answer for the slot |
| T6 | claim `resume` from P | another phone C ≠ P is current | nothing changes (resume never steals) | `replaced` |
| T7 | beat with no claim from P | P is not current | nothing changes | `replaced` |
| T8 | beat from current P | — | latest beat stored (§6.10). Session ticked (§6.11). | per §6.3.3 |
| T9 | beat from P naming an ended sid X, by its `sid` or its `stopped` | X is terminal | — | `200 over X` with X's endReason (ask 8; **first**, whatever has opened since, except a refused claim's `taken` or `replaced` and a non-current caller's `replaced`, G0-g). Never 410. |
| T10 | organiser Go live | no current present phone | refused | `409 phone_not_paired` (panel) |
| T11 | organiser Go live | current phone present | session created, `startCause organiser`, phone = C | current phone's next beat: `waiting` (5 s) while starting, then `go-live S` |
| T12 | `POST start` from P | P is not current | refused | `409 replaced` |
| T13 | `POST start` from current P | an open session exists | refused | `409 already_live {sid, startedBy}` |
| T14 | `POST start` from current P | each gate (§6.7.2) | refused with the gate's code | `402 no_credit` / `403 not_entitled` / `409 no_destination` / `503` |
| T15 | `POST start` from current P | all gates pass | session created, `startCause operator`, created_by = the code's issuer | `200 {sid}` |
| T16 | Cloudflare input connects | slot `armed` | `warming → live`, credit consumed (or the reuse window applies) | next beat: `live S` |
| T17 | phone not ready (A11) | slot `armed` | `notReady` stored. Nothing ends. | `go-live S` (repeated) |
| T18 | warming passes 10 min with no ingest | — | `failed(no_inbound_timeout)` | `over S no_inbound_timeout` |
| T19 | warming phone lost (ask 10) | slot `starting` or `armed`, no ingest ever, and the session's phone silent (§6.8.3) or no current pairing (a session with no phone at all is not judged; amended, §17.11) | `stop(phone_lost)`. No credit spent. | `over S phone_lost` |
| T20 | organiser Stop (A3) | open session | `stop(stopped)`. **The pairing stays current.** PR-2: auto start is blocked for the match. | `over S stopped`. The phone returns to paired-waiting on the same code. |
| T21 | `ended` beat (the operator's Stop, A3/A8) from the session's phone | session open | `stop(operator_stopped)`. **P → ENDED(operator_stopped): the pairing ends**, and the next broadcast needs a rescan. Event `phone_stop`. | `over S stopped` |
| T22 | `ended` beat from a phone that is not current | S open | nothing (ask 2: a beat from a phone that is not current changes nothing) | `replaced` |
| T23 | `stopped: X` on a paired beat (sid null) | X is still open, and **either** P is current after its claim is applied, **or** no current phone holds X (X's session phone is not the slot's current pairing) | `stop(operator_stopped)`, after the beat's claim is applied (ask 7) | `over X stopped` (or `taken` / `replaced` per G0-g) |
| T24 | `stopped: X` | X has already ended (a newer sid may be open) | nothing: idempotent, and it never touches another sid | `over X` with X's endReason (T9) |
| T24a | `stopped: X` from P that is **not current** after its claim (a refused claim, or no claim) | X is still open and **the current phone holds it** (A17 edge, agreed with capture) | nothing: the stop is ignored. Event `stop_ignored {held: true}`. | `taken` or `replaced` per §6.3.3; it **counts as delivered**, so P drops its stop record |
| T25 | phone silent while live (W8) | slot `live`, and not every T25a conjunct holds | nothing ends. The panel warns (PR-2). | — |
| T25a | live phone gone (W19, O2) | slot `live`: no beat ≥ 15 min AND a fresh Cloudflare read not connected AND no connected sample for ≥ 15 min | `stop(phone_lost)`. No refund, no further credit. | `over S phone_lost` (if the phone returns) |
| T26 | Cloudflare input drops while live | — | nothing ends. The chain shows "No signal", as today. | `live S` |
| T27 | destination rejects | warming or live | `failed(target_rejected)`, as today | `over S target_rejected` |
| T28 | no credit at the live transition | — | `failed(no_credits)`, as today | `over S failed` (G0-f) |
| T29 | wall clock passes max duration | — | `ending(max_duration)`, as today | `over S max_duration` |
| T30 | Revoke & reissue | — | old code ENDED(reissued) (C3). New code minted. Old pairings unaffected until they call (C1). | old code: `401` (except C1b) |
| T31 | fixture finishes | — | `finished_at` stamped. PR-2: auto stop is armed (§7.3). | answers carry the same fields |
| T32 | result reverted | — | `finished_at` cleared. PR-2: a pending auto stop is cancelled. | — |
| T33 | finish + 2 h, no open session | — | the code expires (C2) | `401` |
| T34 | finish + 2 h, session open | — | expiry deferred | normal answers, until the session ends, then `401` |
| T35 | fixture deleted | — | the code and its pairings are deleted (cascade). The session follows the existing rule (`fixture_id` is set null). | `401` |
| T36 | destination archived in Directory | while saved as the pre-pick | the pre-pick reads as none | waiting `destinationName: null`, start `409 no_destination` |
| T37 | entitlement removed (override) | — | start refused. An open session continues, as today. | start `403 not_entitled`. `overlayUrl` becomes null on the next answer. |
| T38 | RELAY_KEK missing | ensure, reissue or descriptor with credentials | fails closed | panel `503 RELAY_KEK_MISSING`. Phone GET `503` (counted, no state change). |
| T39 | relay disabled on the deployment | start | refused | `503` |
| T40 | rate limit exceeded | any phone call | refused | `429` with `Retry-After` |
| T41 | slot ≠ 0, or the body's `code` ≠ the path's code | — | refused | `422` |
| T41a | path `code` is not well-formed (it fails §8.1's pattern) | — | refused, before any lookup | `404` (capture's "not a stream code"; it reveals nothing because it is syntactic) |
| T42 | auto start due (PR-2) | §7.2 predicate | session created, `startCause automatic` | `go-live S` (`startedBy automatic`) |
| T43 | auto stop due (PR-2) | §7.3 predicate | `stop(auto_stopped)` | `over S auto_stopped` |

---

## 6. PR-1 — capture-facing

### 6.1 The stream code (W1, W2)

- **Use-case module:** `server/usecases/stream-codes.ts`, modelled on `device-links.ts`.
- **Mint.**
  - `code` is 12 characters of lowercase Crockford base32 (60 bits), random and unique. It is an identifier.
  - `tok` is 16 random bytes as base64url (22 characters).
  - Both are stored as `tok_hash = sha256(tok)` (hex) and `tok_enc = sealWith("RELAY_KEK", tok)`.
  - The seal happens **before** any write, so a missing KEK writes nothing (the device-links Q1 order).
- **Why RELAY_KEK, and not a new KEK.** The tok unlocks stream credentials, which RELAY_KEK already guards. A leak of
  RELAY_KEK already opens every stream key. Sealing the tok under it adds no new exposure, and needs no new Fly secret.
  `crypto.ts` is the only module that seals and opens; the SQL over `tok_enc` lives in `relay/secret-columns.ts`,
  and `enc-boundary.test.ts` gains `tok_enc` as a stream column it owns (the test requires every `*_enc` column to
  have an owner).
- **Ensure** (`POST /api/v1/fixtures/{id}/stream-code`):
  - It runs under the fixture's advisory lock (`stream_code:{fixtureId}`), the same race reason as device links.
  - It re-opens the ACTIVE code, re-checking that `sha256(open(tok_enc)) = tok_hash`. A mismatch falls through to a
    reissue, logged as in device-links M2.
  - Otherwise it mints. It refuses a finished fixture (C4).
  - Each serve bumps `shown_count` and coalesces `first_shown_at`.
- **Revoke & reissue** (`POST …/stream-code/reissue`), under the same lock:
  - the old code gets `ended_at`, `end_cause 'reissued'`, `ended_by`, and its `tok_enc` is wiped;
  - then a new code is minted and returned;
  - the panel confirms first, via `useConfirm`.
- **Revoke on fixture delete:** `fixture_id … on delete cascade` (T35).
- **Who:** session login, editors only (`requireSessionEditor`, the device-links idiom). Never an API key, and never
  a device link. Both routes go in `NEVER_KEY_ROUTES`.
- **Gate:** the org must have `streaming.relay` (with `competitionForFixture`, so an Event Pass is honoured). Without
  it the panel already shows the upgrade card.

### 6.2 QR v2 and the paste code

- The **payload** is `{"v":2,"code":"<12>","slot":0,"tok":"<22>"}`, about 60 bytes.
- It is rendered through the shared Seazn QR component: EC H, logo, tap to enlarge (D7, D10).
- The QR now sits in the **Ready** state, before Go live (§6.12).
- The **paste code** is the same JSON (`qrText`). It keeps `ph-no-capture` and the D10a treatment: the tok is a
  bearer secret that authorises pairing and `POST start`.
- **The QR never carries credentials** (W3). A regression test asserts that the payload has exactly the four keys.
- **Size gate.** The QR version is measured on the real payload at EC H and pinned in a test. It replaces v1's
  "<600 B, version 8–20 at EC M" gate. The real-phone scan gate (fixture-page design §7) is re-run on the v2 QR.

### 6.3 The phone API

**Paths.**

- `GET /api/v1/capture/codes/{code}`
- `POST /api/v1/capture/codes/{code}/beats`
- `POST /api/v1/capture/codes/{code}/start`
- `POST /api/v1/capture/codes/{code}/scoring-link` (W27, added 2026-10-06; §6.3.5)

The QR carries no host: the app's build environment picks the API base. A staging code presented to production is
unknown there, so it answers 401.

**Every route:**

- `handler()` JSON only. A 2xx is never HTML (capture request b).
- Bearer `tok`, resolved by `code`, then **constant-time** compared (§10.1).
- `Cache-Control: private, no-store`.
- Never logs a header or a body (§10.2).
- Rate-limited (§10.4).

The org is pinned with `withTenant` after resolution, which is the `resolveDeviceLinkToken` superuser-read pattern.
(Amended, §17.1: the V430 tables use the V410 pattern, so the phone routes read them through the non-tenant `sql`
throughout, and nothing runs under `withTenant`.)

#### 6.3.1 `GET /api/v1/capture/codes/{code}?phone=<id>`

The phone always sends `?slot=` (agreed with capture). The server still defaults a missing `slot` to `0`. Any other
slot is `422` (T41).

**With `phone`** (native, at Arming and on every reconnect), the answer is decided by the fixture's latest session
for the slot:

- open in `warming`, `live` or `ending` → the **session** shape. `cred` is present **only** when `phone` is the
  slot's current phone, which is also the session's phone (G0-d). Any other phone gets the same shape with `cred`
  **absent**; capture's ServerWord reads that as "open, not current", sends a `resume` claim and is answered
  `replaced`. `endReason` is present only in `ending`.
- ended → the **session** shape in `completed` (an end reason) or `failed` (a fail reason), with its wire
  `endReason` (§6.8.4) and **no `cred`**, so a phone that fetches after the end reads the right line ("the line for
  its `endReason`" in capture's answer table). Served until a newer session is created. A session that ended before
  reaching `warming` has no `warmingDeadline` and was never named to a phone, so it answers the **waiting** shape.
- `requested` or `provisioning` → the **waiting** shape, with `pollSeconds: 5`. A phone holding an older sid reads it
  as NoBroadcast, which is correct: one open session per fixture means its sid has ended.
- no session ever → the **waiting** shape.

**Without `phone`** (capture's JS scan, which reads only the waiting fields): always the **waiting** shape.

**No hint field.** A session shape without `cred` is itself the hint to claim (agreed with capture).

**Statuses:**

- `401 {code: "code_ended", message}` for a well-formed code that is unknown, has the wrong tok, or is ended (C1).
- `404 {code: "not_a_stream_code", message}` for a code that is not well-formed (T41a).
- `422`, `429` with `Retry-After`, `503`. Capture counts each as NoEvidence.
- **This route never sends 410.** The contract reserves 410 to it (ask 8), and this server has no case for it: an
  ended broadcast is the `completed` / `failed` session shape above.

**Waiting shape:**

```
{ state: "waiting", code, label, venueTimezone, scheduledStart?: epoch-s, pollSeconds,
  autoAllowed, destinationName: string | null, overlayUrl: string | null, heartbeatUrl, startUrl,
  stage?: { code, role: { kind, n?, entrants? }, pool? } }       // stage: W28, added 2026-10-06
```

**Session shape:**

```
{ state: "warming" | "live" | "ending" | "completed" | "failed", endReason?: <§6.8.4>, sid,
  cred?: { srt: { url, streamId, passphrase, latencyMs } | null, rtmps: { url, streamKey } }, preferred: "srt" | "rtmps",
  playbackUrl, overlayUrl: string | null, holdWindowSeconds: { srt, rtmps }, maxDurationMinutes,
  warmingDeadline: epoch-s, code, label, venueTimezone, scheduledStart?: epoch-s, pollSeconds,
  scoreUpdates: "realtime" | "polled", autoAllowed, destinationName: string | null, heartbeatUrl, startUrl,
  stage?: { code, role: { kind, n?, entrants? }, pool? } }       // stage: W28, added 2026-10-06
```

`cred` is present only in `warming`, `live` and `ending`, and only to the current phone. `stage` (W28) is on every
shape, the waiting one included, and is omitted — never `null` — when no code can be produced (§6.4). `endReason` is present in
`ending`, `completed` and `failed`, and omitted otherwise. `cred.srt` is `null`, and `preferred` is `"rtmps"`, while
`STREAM_SRT_ENABLED` is off (A18; §6.4). `code`, `scheduledStart`, `pollSeconds` and `destinationName` (agreed
with capture) come from the same sources as on the waiting shape (§6.4, §6.6), so the phone refreshes its waiting
fields and its cadence from either shape.

#### 6.3.2 `POST /api/v1/capture/codes/{code}/beats`

**Body** (strict; `422` on anything malformed, which the phone counts as a failed beat):

```
{ code, slot, phone, claim: "new" | "resume" | null, device: { model } | null, sid: uuid | null, at: ISO-8601 (offset allowed; amended, §17.5),
  state: "paired" | "arming" | "armed" | "connecting" | "publishing" | "degraded" | "reconnecting" | "ended",
  cause: "organiser" | "automatic" | "operator" | "rejoin" | null, notReady: "camera" | "sound" | "network" | "held" | null,
  startFailed: "not-found" | "cred-host" | "config" | "start-error" | null, stopped: uuid | null,
  mode: "automatic" | "operator", transport: "srt" | "rtmps" | null, bitrateKbps, delivery: "ok" | "stalled" | "unknown",
  deliveredLagS, audioOk, battery: { percent, charging, drainPctPerHour } | null, thermal: int | null,
  dataUsedMB, appVersion, endReason?: "operator-stopped" }
```

**Guards, each with a test:**

- `endReason` only with `state: "ended"`;
- `stopped` only when `sid` is null (capture RR3);
- `device` (G0-e) is read only on a claim beat;
- numeric fields are range-checked and fitted to their columns (the `fitToColumn` lesson);
- strings are length-capped.

**Order of processing, under the code row lock when a claim or a stop is present:**

1. Resolve the code (C1). Apply the rate limit.
2. Apply the claim (T1–T7). The claim decides who holds the slot, and nothing else.
3. Store the beat (§6.10).
4. Apply `ended` (T21/T22) or `stopped` (T23/T24/T24a).
5. Tick the session (§6.11).
6. PR-2: evaluate auto start and auto stop (§7.2, §7.3).
7. Answer.

#### 6.3.3 Beat answer

```
200 { state: "waiting" | "go-live" | "live" | "over" | "replaced" | "taken",
      sid?: uuid,                                  // go-live, live, over
      startedBy?: "organiser" | "automatic" | "operator",   // go-live only
      endReason?: <§6.8.4>,                        // over only
      label, scheduledStart: epoch-s | null, autoAllowed, destinationName: string | null,
      overlayUrl: string | null, pollSeconds }
```

**Precedence: the first row that applies wins.**

| # | Situation (for the caller) | Answer |
|---|---|---|
| 1 | the beat's `new` claim was refused (T3) | `taken` (G0-g) |
| 2 | the caller is not current, judged **before** this beat's own `ended` is applied: a refused `resume` claim (T6), or no claim (T7, T22, T24a) | `replaced` (ask 2, G0-g) |
| 3 | the beat names an ended sid X, by its `sid` or its `stopped`, including one this beat just closed (T9, T21, T23, T24) | `over X` + endReason (ask 8) |
| 4 | slot `empty` or `paired` | `waiting` |
| 5 | slot `starting` | `waiting`, with `pollSeconds: 5` |
| 6 | slot `armed` | `go-live S` + `startedBy` |
| 7 | slot `live` or `live·dead` | `live S` |

- Rows 1–2 before row 3 is G0-g: who holds the slot is answered first, and a `stopped` the same beat carries is
  still applied and is delivered by that 2xx. The operator's own `ended` beat (T21) is judged current, so it hears
  `over S stopped`.
- The waiting fields and `pollSeconds` are on **every** 2xx answer (ask 1). `sid`, `startedBy` and `endReason` are
  omitted where they do not apply, never `null`. (Amended, §17.5: the contract is a union on `state`; `startedBy` is
  absent on `live`, and `replaced` and `taken` may carry `device`.)
- **A beat never answers 410** (ask 8).
- `401` means the code has ended. `422` and `429` are counted by the phone and change nothing.
- `503 {code: "unavailable", message}` is transient: the server could not answer this beat. The phone counts it as
  NoEvidence and keeps its pairing and its broadcast. (Amended, §17.14.)

#### 6.3.4 `POST /api/v1/capture/codes/{code}/start`

The body is `{phone}`. The answers are T12–T15 and §6.7.2.

- `200 {sid}`
- `409 {code: "already_live", message, sid, startedBy}`
- `409 {code: "replaced", message}`
- `409 {code: "no_destination", message}`
- `402 {code: "no_credit", message}`
- `403 {code: "not_entitled", message}`
- `503 {code: "unavailable", message}` (storage exhausted, ingest unavailable, relay disabled). Capture reads it as "Couldn't
  start the stream — try again".
- `401 {code: "code_ended", message}`, `422`, `429` with `Retry-After`

**Not idempotent by design.** A retry after a lost `200` meets `409 already_live` naming the same sid. The phone
treats that as success (capture's answer table).

#### 6.3.5 `POST /api/v1/capture/codes/{code}/scoring-link` (W27, added 2026-10-06)

The body is the start's strict `{phone}`. In order:

1. Resolve the code as a `start` call (§5.1 C1): an ended code answers `401 code_ended`, even to its open session's
   phone.
2. The caller must be the slot's CURRENT phone — the start's own holder check (§6.3.4 T12, `holderOf`), session or
   none. Any other phone: `409 replaced`.
3. The server's origin is https (the answer's pattern), else `503 unavailable` with nothing written (below).
4. The console's mint budget, `DEVICE_LINK_MINT_LIMIT` per client IP (rate limits, below) → `429 rate_limited`. It is
   spent HERE, past the tok and holder checks (amended 2026-10-07, review M2): a caller without the tok, or a replaced
   phone, never drains the bucket the organiser's console shares.
5. The plan gate, exactly as the console's ensure: `scoring.device_links`, Event Pass included (resolved against the
   fixture's competition). Lacking: `402 not_entitled`.
6. Under the fixture's device-link advisory lock (the one the console's ensure and the sheet print take), in one
   transaction: a finalized or cancelled match answers `409 match_finished` and writes nothing. Otherwise ONLY the
   fixture's newest live link is read — legacy or sealed, the same row the console's ensure reads (amended 2026-10-07,
   review M1). Sealed, with an envelope that opens AND hashes to its row's `token_hash`: it is returned unchanged.
   Anything else — none, a legacy hash-only link, an envelope that hashes elsewhere or will not open — gets a new sealed
   link inserted beside it (`issued_by` = the code's issuer, no label, no expiry) and **no row is revoked**. The new row
   is stamped past every link the fixture has (in SQL: `greatest(now(), max(created_at) + 1µs)`), so it IS the newest
   and the console's next ensure re-shows it rather than revoking and reissuing; an older good link is left live, never
   dug out. The secret is sealed before the insert, so a missing `DEVICE_LINK_KEK` writes nothing: `503 unavailable`.
   An insert that breaks a foreign key means the code's world is gone — in practice its issuer deleted
   (`fixture_stream_codes.issued_by` has no foreign key, `device_links.issued_by` does) — and no retry can succeed: it
   answers the ONE `401 code_ended` body, so the phone asks for a new QR, with a warning naming the code's id only and
   no error report (amended 2026-10-07, review M4).

Answers:

- `200 {url}`: `captureOrigin()` (§6.4) + `/score/` + the secret — `^https://[^/]+/score/dl_[A-Za-z0-9_-]{43}$` on
  every deployment. A second call returns the same `url` and inserts nothing. Build decision (2026-10-06, for review):
  where `captureOrigin()` is not https — no `OAUTH_BASE_URL`/`NEXT_PUBLIC_BASE_URL`, as on a local or CI server — the
  pattern cannot be met, so the answer is `503 unavailable` before any write, never a url the phone's parser rejects.
  Its message says scoring links need https and carries the token `origin_not_https` (amended 2026-10-07, review N1),
  which the smoke keys on so a crash's generic `503 unavailable` cannot pass for it (review M3).
  Production and staging set both variables to https. Consequence: the `200` path is not reachable over HTTP on a local
  or CI server; the route test drives it with an https origin, and the capture-v2 smoke asserts the `503` there.
- `409 {code: "replaced", message}`, `409 {code: "match_finished", message}`, `402 {code: "not_entitled", message}`,
  `503 {code: "unavailable", message}`, `401 {code: "code_ended", message}`, `404 not_a_stream_code`, `422 invalid`,
  `429 rate_limited` with `Retry-After`.

Rate limits (§10.4): the code's own budget (`CAPTURE_CODE_LIMIT`, shared with the other phone routes), spent by the
route before anything else; then, inside the use-case once the tok and holder checks pass (step 4; review M2), the
console's `DEVICE_LINK_MINT_LIMIT` per client IP. Build decision (2026-10-06, for review): the per-IP bucket is the
console's own `dlmint:<ip>` — its rule is "a reissue IS a mint: one bucket, one number" — with the IP read by the
capture routes' `clientIpOf`.

What the console still owns: its ensure and print re-show the newest live sealed link, which after a phone call is the
phone's link (or the one the phone was given), so no printed or handed-over QR is killed by a phone. **Revoke &
reissue stays the only path that changes a fixture's QR.** Build decision (2026-10-06, for review): where the console's
ensure treats an envelope that will not open as a 500, the phone passes over it (a warning naming the link id only)
and inserts a new link — W27's "whose envelope opens" — leaving that row exactly as it was.

The URL is a credential (§10.2): it is never logged and stored nowhere new — the device link row stores what the
console's links store, its hash and its sealed envelope.

### 6.4 Descriptor fields and where each comes from

| Field | Source |
|---|---|
| `label` | "{side A} v {side B}". It falls back to "Match {n}" while a side is not yet known, **in the competition's locale** (W25), using the `breadcrumb.match` key. The tree has no per-competition locale: the competition's locale is its organisation's `organizations.default_locale` (V281), which the public league pages already read. Entrant names are user data, not translated. Cut to the contract's maximum with one "…" (amended, §17.6). |
| `venueTimezone` | Venue lane V305: division override → org timezone → UTC (the `checkin-token.ts` query). |
| `scheduledStart` | `fixtures.scheduled_at`, as epoch seconds. With no `scheduled_at` it is **omitted** from the waiting shape (`scheduledStart?`) and `null` on the beat answer (`scheduledStart \| null`), per capture's shapes. |
| `pollSeconds` | §6.9. |
| `autoAllowed` | PR-1: always `false`. PR-2: the fixture's switch (§7.1). |
| `destinationName` | The `label` of the destination the phone's start would open on (§6.7.3's resolver, amended §17.13), or null when that is none — a choice cleared or archived (T36), or no live destination. Cut to the contract's maximum with one "…" (amended, §17.6). |
| `heartbeatUrl`, `startUrl` | `${captureOrigin()}/api/v1/capture/codes/{code}/beats` and `…/start`. |
| `cred.rtmps.url` | The stored Cloudflare value with the **hostname** replaced by `STREAM_INGEST_HOST` (W15). See below. |
| `cred.srt.url` | The stored Cloudflare value **unchanged**: `srt://live.cloudflare.com:778` (W21). It is never rewritten. |
| `cred.srt` | Present while `STREAM_SRT_ENABLED` is on, its default (W21). `null` while it is off: A18's safety net. |
| `cred.*` secrets | `readFirstInput` (secret-columns.ts), opened only inside this request. |
| `preferred`, `latencyMs` | `preferred` is `QR_PREFERRED_DEFAULT` (`srt`) when SRT is enabled, otherwise `"rtmps"`. A guard ties the two: `preferred` never names a null shape. `latencyMs` is `SRT_LATENCY_MS` (2000), unchanged. |
| `playbackUrl` | `https://${STREAM_PLAYBACK_HOST}/${ingest_input_uid}/manifest/video.m3u8`, a bare manifest with no query (W14). |
| `overlayUrl` | §6.4.1. Also on the waiting shape (capture ask 5), so the operator can frame the shot with the scorebug. |
| `scoreUpdates` | `realtime` when `overlayUrl` carries a key. `polled` otherwise. |
| `holdWindowSeconds` | `{rtmps, srt}` from the ingest capability. PR-1 sets `srt` to the same `INGEST_TIMEOUT_SECONDS + HOLD_SLACK_SECONDS` (183), because the hold is Cloudflare's per-input recording timeout and not a property of the protocol. Staging step S3 measures SRT. A guard asserts both are ≤ 999 (capture request d). |
| `maxDurationMinutes` | The session's own value. |
| `warmingDeadline` | `warming_at + WARMING_TIMEOUT_MINUTES`, as epoch seconds (§5.3). |
| `stage` (W28) | ONE read per descriptor, recomputed on every read: the fixture's stage's fixtures (the board's round-code columns, through `fixtures_stage_idx`), the stage's kind and the key of the fixture's pool. `code` is the scheduler board's chip for the fixture — `boardRoundCodes` over those rows, else `R{round_no}` exactly as the board's card falls back — rendered with the label's dictionary (the org's `default_locale`, W25), so an `es` org reads `CF` for a quarter-final. `role` is `roundRoleFor` over the same rows, serialised verbatim (`kind`, plus `n` or `entrants` where the variant has one). Build decision (2026-10-06, for review): a bracket stage the board itself refuses to code — rows from before V368 with no `is_final` — gets the plain round ordinal (`plain_round`, n = the round's rank + 1), never the role `roundRoleFor` would guess from column defaults, so the role always agrees with the chip. `pool` is `pools.key` for `fixtures.pool_id` (never `pools.name`, which is English); `pools.key` has no CHECK, so a key outside `^[A-Z]$` is omitted and logged. A code outside 1–8 characters cannot be produced: the whole `stage` is omitted and logged. `fixtures.stage_id` is NOT NULL, so every fixture has a stage. `label` (2026-10-07): `poolLabel` over the org locale's `public` dictionary (`getDictionary(locale, "public")` — `msgFor` reads only `ui`) + " · " + `code` for a pooled match, else `code`; over 40 characters it is omitted and logged, the rest of `stage` kept. **Amended 2026-10-08 (owner ruling 2026-10-08, Option A; the finals' long names are A1, a recommendation applied when the owner said "raise PR"; W28):** `label` is the division's name, then the pool's word for a pooled match, then the round, joined with " · " (`Open · Round 2`, `Open · QF`, `Open · Final`, `Girls U14 · Group A · Round 2`), in the org's `default_locale`. The round is `bracket.round.plain` ("Round {n}", "Ronda {n}") for a plain round — every uncoded round, n being the number its `R{n}` chip shows; the long name for `final`, `third_place` and `grand_final` (`bracket.round.final` / `.thirdPlace` / `.grandFinal`: "Final", "Third place", "Grand final"); the chip (`code`) for every other role. Over 40 characters the pool's word is dropped first, then the division; a round still over 40 omits the label, the rest of `stage` kept. Each drop is logged with the fixture, the length and the part dropped. `code`, `role` and `pool` are unchanged, and so is the contract's shape (1–40, optional). The division's name is `divisions.name`, read in the same one statement; a blank name leaves the division out. |

**Ingest URL rewrite.**

- **RTMPS only.** An exact `live.cloudflare.com` hostname on the RTMPS url is rewritten to `STREAM_INGEST_HOST`. The
  scheme, port and path are kept.
- **SRT is never rewritten** (W21). Its url must have exactly the host `live.cloudflare.com`.
- **Any other hostname, on either url, answers `503`** (`ingest_host_unexpected`) and is logged as an error. Capture
  refuses a `cred` that is not on an allowed host, so serving it would only fail the start on the phone.
- With `STREAM_INGEST_HOST` unset (local or CI), Cloudflare's values are served.
- **SRT from launch on Cloudflare's host; `srt: null` is A18's safety net only.**
  - `STREAM_SRT_ENABLED` **defaults ON** (W21): unset means on, in code. Setting it to `false` is the safety net: the
    descriptor then carries `cred.srt: null` and `preferred: "rtmps"`, and the phone publishes RTMPS only, with no
    SRT→RTMPS fallback, so a hold window ends the broadcast.
  - The flag is turned off for an environment only when SRT fails there (S2). Capture's host rule admits
    `live.cloudflare.com` for SRT (G0-i, agreed), so there is no interim `false`. Each flip is recorded in this file
    with its evidence.
  - **Moving SRT to the custom host later (S2b, optional)** is a server change only: rewrite the SRT host too. The
    contract already admits both hosts.

**`captureOrigin()`** is `OAUTH_BASE_URL || NEXT_PUBLIC_BASE_URL`. Both are set in `fly.toml` and `fly.stg.toml`. Only
when neither is set (local or CI) does it fall back to `deps.appUrl`. It is **never header-derived** where the
environment sets it, and a regression test forges `X-Forwarded-Host` to prove it.

#### 6.4.1 overlayUrl (W11)

- **Value:** `${captureOrigin()}/overlay/fixtures/{fixtureId}?style={themeId}&key={overlayKeyFor(fixtureId)}`.
  - `themeId` is the session's `theme_id`, otherwise `defaultThemeFor(sportKey)`.
  - The key is omitted when `overlayKeyFor` returns null (no AUTH_SECRET). `scoreUpdates` is then `polled`.
- **When it is filled:** only when `hasFeature(org, "streaming.overlay", competition)` is true. It is `null`
  otherwise.
- **The OBS tab's client-built URL** (`fixture-stream-panel.tsx:366`) is out of scope and unchanged.
- **Ruled (W18, O1 YES).** Since V426, `streaming.overlay` is true on every plan. Only an override switches it
  off. So `overlayUrl` is in practice present for every org that can stream from a phone at all.

### 6.5 Pairing, takeover and rejoin

The rules are T1–T7 and T4. The implementation notes:

- **Identity.**
  - A pairing row is `(code_id, slot, phone)`. The same phone re-claiming the same code keeps its row: process death
    is not a takeover.
  - A phone that was ENDED(replaced) and scans again gets a **new** row.
  - Partial unique index: one current pairing per `(code_id, slot)`.
- **Serialisation.** A claim takes `select … for update` on the code row. Two phones claiming at once are therefore
  decided one after the other, and the second sees the first's result.
- **A14's clock (T4), in its measurable form:**

  `now − C.last_beat_at ≥ DEAD_PHONE_TAKEOVER_SECONDS (60)`
  AND a **fresh** `inputStatus` read (taken through `claimIngestPoll`, so it coalesces with any poll in the same
  interval) is not `connected`
  AND the latest poll sample that read `connected` is ≥ 60 s old.

  Each conjunct gets its own test and its own mutation (§11.1.3). An attacker cannot force the first conjunct. If the
  dead phone is still pushing video, the second conjunct refuses the takeover.
- **Rejoin** needs no server state. The current phone's beat answers `live S` and the phone publishes (A10).
- **On takeover, the session's phone moves** to the new pairing (T2, T4). This is why an `ended` beat
  from the old phone stops nothing (T22).

### 6.6 pollSeconds (W17)

| Situation | pollSeconds |
|---|---|
| Open session in `requested` or `provisioning` | `POLL_STARTING_SECONDS` = 5 |
| Any other open session | `POLL_NEAR_SECONDS` = 10 |
| No session, fixture `in_play` | 10 |
| No session, `now ≥ scheduled_at − POLL_NEAR_WINDOW_MINUTES (30)` and not finished | 10 |
| Otherwise (no `scheduled_at`, far from start, or finished) | `POLL_FAR_SECONDS` = 60 |

- Each value answered is stored on the pairing (`answered_poll_seconds`), because silence is judged against it
  (§6.9).
- **Consequence, stated in the panel copy.** An organiser Go live more than 30 min before the scheduled start reaches
  the phone within one 60 s beat. The panel's waiting line says "The phone checks in every minute until 30 minutes
  before the match".

### 6.7 Starting a broadcast

#### 6.7.1 One start path

`createSession` is refactored into
`startBroadcast(actor, fixtureId, {targetId, startCause, pairingId}, deps)`. Its three callers are:

- the organiser route (cause `organiser`);
- the phone route (cause `operator`);
- PR-2's auto start (cause `automatic`).

Admission, the target row lock, the monthly grant, storage headroom, the race backstops and provisioning are all
unchanged and shared. There is **one** admission, never a phone copy of it. A diff against the existing path is a
plan task (house rule "new write path").

- **The actor.** `created_by` is the signed-in organiser for `organiser`, and **the code's `issued_by`** for
  `operator` and `automatic`. A device link carries its issuing organiser the same way. The session events record the
  real actor (`source 'phone'`, with the pairing id).
- **The phone gate (W5, T10)** is a new `admit` input, `phonePresent: boolean`, with the refusal `phone_not_paired`.
  Order (F-A5 kept): plan gates → `active_session` → **`phone_not_paired`** → `no_credits` → `target_not_found` →
  `storage_exhausted`. W5 is answered before the storage read, and after the destination doors (amended, §17.10).
  - The organiser route asks it of slot 0's current pairing.
  - The phone route and auto start pass `true`, because the caller **is** the current phone (T12 checked it first).

#### 6.7.2 The phone's refusals (W6; capture's start shape)

| Internal | Phone answer |
|---|---|
| `plan_lacks_overlay`, `plan_lacks_relay`, `overlay_required` | `403 not_entitled` |
| `active_session` | `409 already_live {sid, startedBy}` |
| `no_credits` | `402 no_credit` |
| no pre-pick, or the pre-pick is archived or not found | `409 no_destination` |
| `target_in_use` (the pre-pick is held by another match) | `409 no_destination`. The phone reads "Ask the organiser to pick where to stream", which is the remedy: pick another destination, or stop the other match. The panel names the holder through the existing `target_in_use` copy. |
| `storage_exhausted`, `ingest_unavailable`, relay disabled | `503` |
| `DestinationNotAllowedError`, unreadable key | `409 no_destination` (the organiser fixes it in Directory) |

The phone keys its copy on `code` and never shows `message`, which is a developer string. The phone owns its copy
(A13). The organiser sees the same
refusal in the session events.

#### 6.7.3 The destination pre-pick

- **Storage:** `fixture_stream_settings.target_id` (§8.1), with the API `PUT /api/v1/fixtures/{id}/stream-settings`
  `{targetId: uuid | null}`.
- **The panel's picker writes it on change.** The organiser's Go live uses the body's `targetId` and saves it as the
  pre-pick on success, so the two never diverge.
- **The phone start uses the saved pre-pick.** None means `409 no_destination`.
  **Amended (§17.13, B8 review I-1, controller ruling):** ONE resolver (`resolveStreamTarget`, read by
  `fixtureStreamTarget`) answers the fixture's destination for the phone's start, the phone's descriptor and the
  panel's read model alike: a saved, live choice → it; **no saved row → the org's oldest live destination**; a saved
  choice cleared or archived, or no live destination → none (`409 no_destination`). Reading writes nothing.
- **Archiving** a destination in Directory leaves the pre-pick pointing at an archived row, which reads as none
  (T36). Nothing cascades: the row stays, as D2 requires.

#### 6.7.4 Free restarts: three per reuse window (W23)

- **Today** a restart of the same fixture inside `CREDIT_REUSE_HOURS` (24) of its last net consume is free, without
  limit (`reuseWindowOpen`, `stream-credits.ts`).
- **The rule.** `FREE_RESTARTS_PER_WINDOW` = 3.
  - The **anchor** is the fixture's latest net consume row inside the window (the paid live). Its session is the
    paid one and never counts.
  - **Used** = the fixture's sessions created after the anchor's session that have `first_ingest_at` set,
    excluding the session being decided. A rejoin or takeover keeps the same sid, so it is one session and counts
    once at most. A session that never got video does not count.
  - A restart is **free** while the window is open and used < 3. Otherwise it is admitted on the balance gate like
    a first start, and consumes 1 credit at live, as today.
  - That paid restart writes a new consume row, which becomes the anchor, so the next three restarts are free again
    (§16 O4).
- **One authority.** A single `restartAllowance(exec, {orgId, fixtureId, excludeSessionId}, now)` returns
  `{windowOpen, used, limit, free}`. Admission (the balance waiver), `consumeForSession` (the consume at live) and
  the panel's read all call it, so the three cannot disagree. It replaces `reuseWindowOpen` at those three call
  sites.
- **The panel** shows the count before Go live, while the window is open: "Free restarts used ({used} of 3)", and
  at the limit "Free restarts used (3 of 3) — this one uses 1 credit". The copy is in all four locales.

### 6.8 Stopping a broadcast and end reasons

#### 6.8.1 Organiser Stop

`stopSession` is unchanged, with `stop(stopped)` (T20). The current pairing **stays**: the phone hears `over S
stopped` and waits on the same code.

#### 6.8.2 Phone Stop (W12, A17)

- **An `ended` beat** from the session's phone is the operator's Stop (A3, A8).
  - It ends the broadcast with `stop(operator_stopped)`.
  - **It also ends the pairing** (T21). The next broadcast needs a rescan.
- **A `stopped: X` on a later paired beat** (A17, ask 7) closes X if X is still open. It is judged after the beat's
  claim (T23):
  - **from the current phone** it always applies;
  - **from a phone that is not current** it applies only if no current phone holds X. If the current phone holds X,
    the stop is ignored (T24a), and the answer still counts as delivered.
  - If X has already ended, it is a no-op (T24). It never touches any sid but X.
- **Every answer is 200 `over X`** (ask 8), or `taken` / `replaced` when the same beat's claim was refused or its
  phone is not current (G0-g). The phone treats any 2xx as delivered, so a resend is harmless.
- **The A17 edge (agreed with capture, 2026-10-01).** A phone whose operator stopped X cannot end X once another
  phone has taken it over and holds it: a late stop never ends a broadcast that the current phone is publishing.

#### 6.8.3 A warming broadcast whose phone is lost (capture ask 10, required)

- **The rule.** Every tick (§6.11) checks an open session that has **never received ingest** (`first_ingest_at` is
  null) and is in `requested`, `provisioning` or `warming`. If its phone is **silent** (§6.9), or it no longer has a
  current pairing, the session is ended with `stop(phone_lost)`. **No credit is spent**, because the credit is
  consumed only at the live transition. A session that never had a phone (`pairing_id` null) is not judged, and a
  reissued code does not make its open session's phone non-current (amended, §17.11).
- **The clock.**
  - Once the phone holds the broadcast it beats at least every 10 s, and silent is exactly ask 10's **60 s with no
    beat**.
  - A phone that has not yet had a beat in which to hear the go-live is still on its waiting cadence (up to 60 s).
    For that phone the clock is that cadence plus 30 s, so an organiser Go live is never ended before the phone could
    hear it.
  - It is never shorter than 60 s.
- **Why it does not contradict W8.** W8 governs **live** sessions. This rule touches only a session that has carried
  no video and spent no credit.
- **What it closes:** capture's "Stop before the first frame" gap, and the "second phone joins a stopped warming
  broadcast" gap.

#### 6.8.5 A live phone stream whose phone is gone (W19, O2)

- **The rule.** Every tick (§6.11) checks an open session in `live` (`first_ingest_at` is not null) that has a phone
  (`pairing_id` set; amended, §17.11). It is ended with `stop(phone_lost)` when **all three** hold:
  1. **no beat** from the session's phone for `PHONE_LOST_LIVE_MINUTES` (15): `now − coalesce(phone_beat_at,
     first_ingest_at) ≥ 15 min`;
  2. a **fresh** `inputStatus` read (through `claimIngestPoll`) is not `connected`;
  3. **no video** for 15 min: the latest poll sample that read `connected` (or `first_ingest_at`, if none) is
     ≥ 15 min old.
- **Both clocks, never one.** A phone whose beats are lost while it still pushes video is never ended (W8 stands for
  that case), and neither is a phone that beats while Cloudflare reports no signal (the operator is reconnecting).
  Each conjunct has its own test and its own mutant.
- **The credit** was spent at live; nothing is refunded and nothing more is spent. The destination is released by
  the same stop path as every other end.
- **The phone**, if it comes back, hears `over S phone_lost` and reads capture's "Stream ended — this phone was
  offline".
- **The panel** reads "The phone and its video were gone for {minutes} min" (new copy, all four locales), told apart from
  ask 10's line by `first_ingest_at`. `{minutes}` is `PHONE_LOST_LIVE_MINUTES` as the server reads it (through
  `tunable`, 15 by default), handed to the panel by its context loader — never a number typed into the copy.
- **When it fires.** At the first tick after the 15 min: at once while an organiser panel is open (its poll ticks),
  otherwise within 5 min, from the `stream-tick` job (W22, §6.11).

#### 6.8.4 End reasons — the DB and the wire

The wire vocabulary is capture's five, plus `phone_lost` (ask 10) and `failed` (G0-f). Every DB reason maps to
exactly one wire value. A test sweeps the DB enums: the count of mapped reasons must equal the enum length.

| DB (`end_reason` / `fail_reason`) | Wire `endReason` | Panel copy |
|---|---|---|
| end `stopped` (organiser) | `stopped` | as today |
| end `operator_stopped` | `stopped` (only the phone that stopped it ever names this sid, and it is already Ended) | "Stopped from the phone" |
| end `auto_stopped` (written by PR-2) | `auto_stopped` | "Stopped automatically after the result" |
| end `phone_lost` | `phone_lost` | before ingest (ask 10): "The phone stopped answering before the stream started"; after ingest (W19): "The phone and its video were gone for {minutes} min" (the server's W19 window) |
| end `max_duration` | `max_duration` | as today |
| fail `no_inbound_timeout` | `no_inbound_timeout` | as today |
| fail `target_rejected` | `target_rejected` | as today |
| every other fail reason (`no_credits`, `provision_timeout`, `admission_timeout`, `relay_disabled`, the runner's) | `failed` | as today |
| neither: a `completed` row with no end reason (`session.ts`'s completion) (amended, §17.8) | `failed` | as today |

The V430 check constraint admits all five end reasons at once. A DB that cannot store `auto_stopped` would leave
PR-2's writer with no column to write.

### 6.9 Present, silent, and not responding

These are pure functions in `domain/pairing.ts`. Each threshold is derived from the cadence the server itself
answered.

- **Silent:** `now − last_beat_at ≥ max(PHONE_SILENT_FLOOR_SECONDS (60), answered_poll_seconds + PHONE_SILENT_SLACK_SECONDS (30))`.
  At the held cadence of 10 s this is 60 s, A14's figure. At 60 s it is 90 s, so a phone is never called silent for
  missing a beat it was not yet due to send.
- **Present:** current, and not silent. This is what gates Go live (T10).
- **Not responding (W8):** held (an open session) and `now − last_beat_at ≥ 3 × answered_poll_seconds` (30 s at 10 s).
  PR-1 computes it and records a history `change` row (§6.10). PR-2 displays it.

### 6.10 Heartbeat ingest and storage (W10)

The phone's beat is not the runner's beat. The runner keeps `last_heartbeat`, `heartbeat_at` and the samples
`source 'heartbeat'` untouched. The phone gets its own names.

- **Latest beat.**
  - It overwrites `fixture_stream_pairings.last_beat` and `last_beat_at`. This applies to every beat, including
    pre-session ones.
  - When the beat comes from the open session's phone and names its sid, it **also** overwrites
    `fixture_stream_sessions.phone_beat` and `phone_beat_at`.
  - The session row is never deleted, so **the final beat is kept with the session** for good.
- **History** goes in `fixture_stream_phone_beats` (§8.1).
  - A `minute` row is written when that pairing has no `minute` row in the last 60 s.
  - A `change` row is written when the phone's `state` changes, or when the derived flag set changes. The flags are:
    - `battery_low`: percent < `LOW_BATTERY_PERCENT` (20) and not charging;
    - `hot`: thermal ≥ `HOT_THERMAL_STATUS` (3, Android `THERMAL_STATUS_SEVERE`);
    - `stalled`: delivery is `stalled`;
    - `not_ready`;
    - `not_responding`: from a tick (§6.9).
  - A minute that is also a change writes **one** row of kind `change`.
- **Purge (1 day).**
  - Every `minute` insert deletes that pairing's history rows older than `PHONE_BEAT_RETENTION_HOURS` (24).
  - The daily relay sweep deletes every history row older than 24 h. This covers pairings that stopped beating.
  - Neither purge touches the session or pairing columns, so the final beat survives.
- **Sanitising.**
  - `raw` stores the body through an **allowlist** of the declared fields, with no free text beyond `appVersion` and
    `device.model`, both capped.
  - The beat carries no secret. The tok travels in the header, which is never stored.
- **A failed history write never fails the beat.** It is logged and the answer goes out: the `sampleBeat` isolation
  rule (Task 11 I1b).

### 6.11 Who advances a session — the tick

**The problem.** Today the organiser's poll **is** the tick (`currentSession` → `reconcileSession` plus the ingest
read). A phone-started or automatic session may have no organiser watching.

**The fix.** The ingest-poll block of `currentSession` is extracted into `tickSession(sessionId, deps)`, which runs:

1. lazy expiry;
2. the ingest read with `claimIngestPoll` coalescing (V428);
3. `warming → live`;
4. `target_rejected`;
5. ask 10's end of a warming broadcast whose phone is lost (§6.8.3);
6. W19's end of a live broadcast whose phone and video are both gone for 15 min (§6.8.5).

It is called from four places:

- the organiser poll (unchanged behaviour);
- **every beat from the session's phone**;
- **the `stream-tick` job, every 5 min (W22).** `POST /api/cron/stream-tick` is cron-shaped like `relay-sweep`: it
  answers 503 when `CRON_SECRET` is unset, before 401 on a wrong `x-cron-secret`. It ticks every open session of
  every org (`requested`, `provisioning`, `warming`, `live`, `ending`), each in its own try/catch, and answers
  `{ticked, ended}`. The Cloudflare cron Worker (`apps/cron-worker`) POSTs it from a row in its schedule table. That
  needs a second trigger, `*/5 * * * *`, beside the programme's hourly `17 * * * *`: four triggers per account across
  stg and prod, under the Workers Free limit of five. (Amended, §17.2: the Worker sends this job's failures to Sentry
  at most once per UTC hour.)
- the daily sweep, kept as a backstop.

The coalescing claim guarantees one provider read per `STREAM_POLL_MS` however many callers tick, so a phone beating
every 10 s plus an open panel never doubles Cloudflare reads.

### 6.12 Organiser panel changes (PR-1)

These are Option A's frame, re-sequenced. The chain, the destination picker, the credits line, Live and Stop are
unchanged.

| State | Body |
|---|---|
| **Ready, no phone** | The picker (it now saves the pre-pick). The **QR** with "Scan with the Seazn Capture app" and the paste code. A "Revoke & reissue" text button, with a confirm. **Go live disabled**, with "Pair a phone first: scan the code with Seazn Capture". Phone node: slate, "Not connected". |
| **Ready, phone paired** | The picker. Phone node: lime ring, "Paired". The QR folds into a "Show the code again" disclosure, with Revoke & reissue inside it. **Go live enabled.** |
| **Ready, phone paired but silent** (§6.9) | Phone node amber, "Not answering". **Go live disabled**, with "The phone stopped checking in. Open Seazn Capture on it". The QR stays folded. |
| **Waiting** (requested, provisioning or warming) | Phone node amber, "Starting". The line "Waiting for the phone's video". The pollSeconds line from §6.6 when relevant. Cancel. **No QR**: the phone is already paired. **Warming countdown (W24):** after 30 s in warming with no video, "No video from the phone yet — the stream is cancelled in {remaining} if it doesn't arrive.", counting down to the warming deadline (`warming_at` + `WARMING_TIMEOUT_MINUTES`), or to ask 10's end once the phone's beats have stopped, whichever is first (amended, §17.12). |
| **Live, reconnecting** (W24) | The Phone node says "Reconnecting…" instead of "No signal" while the input is not connected. After `RECONNECT_QUIET_SECONDS` (30) with no video **and** no beat, the sentence "No video from the phone for {elapsed} — the stream ends in {remaining} if it doesn't come back." counts down to W19's end. `remaining` = 15 min − the **shorter** of the two silences, because W19 needs both. While the phone still beats, W19 cannot fire, so there is **no countdown** (O5, ruled 2026-10-01). Instead the panel shows "Reconnecting…" and, when the latest beat carries one, the phone's reason, through `reconnectReasonOf(phone)`: `notReady` `camera` → "Phone is on a call — video paused" (the owner's example); `sound` → "Phone's microphone is in use — video paused"; `network` → "Phone has no network — video paused"; `held` → "Phone is upright — turn it sideways"; otherwise state `degraded` or `reconnecting` → "Phone's connection is weak — video paused". Only the first string is the owner's; the rest are this spec's, shown in the mockups for sign-off. The session does not end while the phone is alive, except at the `maxDurationMinutes` cap (300). |
| **Ready or Ended, inside the reuse window** (W23) | Above Go live: "Free restarts used ({used} of 3)", or at the limit "Free restarts used (3 of 3) — this one uses 1 credit". |
| **Live, Ended, Failed** | As today. The new end reasons use the copy in §6.8.4. |
| **Code ended** (finish + 2 h) | "This match is over. Its stream code has ended." No QR and no Go live. |

**Details:**

- **Polling.** The panel polls `GET /api/v1/fixtures/{id}/stream-phone` (§9) every `STREAM_POLL_MS` while it is open,
  beside the existing `current` poll.
- **The countdown is computed on the server** (`lostCountdown`, §6.8.5's clocks), and `current` carries
  `countdown: {kind: "warming" | "live", elapsedMs, remainingMs} | null`, so the panel never compares its own clock
  with a server timestamp. The panel formats both durations in the viewer's locale.
- **The PR-1 Phone node** shows only the paired, present, silent or reconnecting state. The one-line health summary (the D9 slot)
  stays empty until PR-2.
- **Copy:** every string is in en, es, fr and nl, followed by the `gen-keys` regen. The key families are
  `stream.code.*`, `stream.phone.*` and `stream.end.*`, with the names indicative.
- **Mockups (house rule "≥2 UI options before building").** A plan task (PR-1 Task 2) produces two static options for the
  Ready states, the warming and live countdowns (W24) and the restart count (W23) at 320, 768 and 1280. **Mockups are built out of tree (a scratchpad or a private Artifact) and are never committed**
  (owner, 2026-10-05). **The owner signs one off before the
  panel task starts.** The PR-1 build of the panel waits on that; the server work does not.
- **Signed off: Option B ("Chain first"), rev 2. The owner approved it on 2026-10-01.** T11 builds this. Where a
  table row above says otherwise, these rulings win.
  - **The phone's messages.** A strip under the chain, with a caret on the Phone node, says the phone's state:
    - "Pair a phone first…";
    - "The phone stopped checking in…";
    - "Waiting for the phone's video" with the warming countdown;
    - the live countdown;
    - the O5 reason.
  - **The QR card.** The QR sits in a card beside the picker, or below it on a phone. Once paired, the card is one
    line: "Paired · Show the code again".
  - **The QR's size.** It paints at **at least 320 px from 768 up** (342 px, 6 px per module of the 57-module v2
    symbol, as `SeaznQrImage` snaps it at `STREAM_QR_MAX_PX` 363). On a phone it paints at 228 px.
    - At 768 the card column is the QR plus its padding (370 px), and the controls narrow to fit.
    - **From 1024 the two columns are equal.**
    - The paste code's Copy button sits beneath the field, inside the card, at every width, and Revoke & reissue stays
      in the card.
  - **The Phone node is 80 px wide below 768.** At ≥768 it stays 96 px; below 768 it was 64. The change lets
    "Reconnecting…" (76 px at 11 px) fit on one line.
    - The word keeps `overflow-wrap: anywhere` only as a fallback for a longer translation.
    - `hyphens: auto` is not a fix: the test browser does not hyphenate.
  - **At 3 of 3, "1 credit" appears once.** The amber line "Free restarts used (3 of 3) — this one uses 1 credit"
    stands above Go live, and the credits line under it reads "{n} credits · Buy more", without "Uses 1 credit". Below
    the limit the credits line is as today.
  - **D3's phone sentence gives way.** The live countdown and the paused reason replace it ("Seazn isn't getting video
    from the phone…") while either shows.
    - The "!" stays on the Phone node during the countdown.
    - It is dropped while the phone still beats.
  - **The paused reasons.** The owner approved the four reasons beyond the owner's own "Phone is on a call — video
    paused", exactly as written in the Live, reconnecting row: microphone, network, upright and weak connection.
  - **The Revoke & reissue confirm.** It uses the house `useConfirm`, danger tone, with Cancel from `dialog.cancel`:
    - `stream.code.reissue.confirm.title`: "Make a new code?"
    - `stream.code.reissue.confirm.body`: "The current code stops working. Any phone using it must scan the new one."
    - `stream.code.reissue.confirm.button`: "Make new code"
  - **The design of record** is Option B rev 2 as described in this section. Its mockup pages were not committed
    (owner, 2026-10-05). The record of what shipped is the owner's per-screen sign-off of the built panel (18 of 18
    screens, 2026-10-05), in PR #920's description. §11.1.8's visual comparison was against Option B rev 2.

### 6.13 v1 removal (W4): a hard cut

**Removed:**

- `CaptureQrV1` and `parseCaptureQr` (`lib/capture-qr.ts`). They are replaced by `CaptureQrV2` and its parser.
- `docs/contracts/capture-qr.v1.json` and `docs/contracts/fixtures/capture-qr.v1/`. The SRT-query drift in
  `valid.json` goes with them, unfixed.
- `StreamSessionCurrent.qr`, the `?reveal=1` parameter on `current`, and the QR transaction in `currentSession`.
- `capture-qr.v1.test.ts`, and the v1 cases in `capture-qr.test.ts`, `stream-sessions.test.ts`,
  `stream-contract.test.ts`, `stream-session-view.test.ts` and `fixture-stream-panel.test.tsx`.

**Rewritten:**

- the e2e QR steps in `walkthrough/stream-relay.spec.ts`, which today read the session's sid from the paste code;
- the A11 zoom case, on the v2 QR.

**Changed columns:**

- `qr_issued_first_at` is dropped. It is superseded by the code's `first_shown_at`.
- `credentials_revealed_first_at` and `credentials_reveal_count` are renamed `credentials_served_first_at` and
  `credentials_served_count`. Their meaning is now "a descriptor carrying `cred` was served". The organiser no longer
  sees credentials at all. (Amended, §17.3: they land with V430, with an interim meaning and a stg deploy window.)

Every reader is re-pinned in the plan with `grep -a`. Known readers today are `stream-sessions.ts`, its test,
`routes.test.ts` and `migration-shape.test.ts`.

### 6.14 Contracts (`docs/contracts/`, written at G0)

| File | Holds |
|---|---|
| `capture-qr.v2.json` | QR v2 |
| `capture-descriptor.v1.json` | the GET union (waiting \| session) and its error bodies |
| `capture-beat.v1.json` | the request and the answer |
| `capture-start.v1.json` | the request, `200`, and every refusal body |
| `capture-scoring-link.v1.json` | W27 (2026-10-06): the request (the start's `{phone}`), `200 {url}`, and every refusal body |
| `fixtures/capture-*/…` | per file: `valid`, one fixture per union member and per refusal, `tampered` (an extra key), `wrong-version`, plus the boundary cases (`slot` 0, `holdWindowSeconds` 999, `pollSeconds` 5 and 300) |

Each file is checksum-pinned and parity-tested against its zod twin in `schemas.ts`, the v1 pattern. **The JSON
files are the cross-repo authority. The zod schemas mirror them, and parity is a test.** Capture vendors them. A
`ci.yml` byte-compare is capture's plan D and is not owed here.

### 6.15 Configuration per environment

| Setting | prod (Doppler `prd`) | stg (Doppler `stg`) | local / CI |
|---|---|---|---|
| `STREAM_INGEST_HOST` | **unset** (W26: Cloudflare's own host) | **unset** (W26; removed 2026-10-05) | unset (Cloudflare's own hosts) |
| `STREAM_PLAYBACK_HOST` | `customer-vv7totdc7j19biah.cloudflarestream.com` | same | the fake driver's value |
| `STREAM_SRT_ENABLED` | unset (on, W21); `false` only as A18's safety net | unset (on); `false` only if S2's SRT check fails | unset (on; the fake driver) |
| `RELAY_KEK` | existing Fly secret | existing | `.env` |

**Where these live (amended 2026-10-05, OG9).** The stream settings are set in **Doppler** (project `seazn-club`,
configs `stg` and `prd`), which syncs them to the Fly app as secrets. They are not in `fly.toml` / `fly.stg.toml
[env]`. A Doppler change reaches the machines only after a secrets deploy: a Doppler sync can leave them *staged*
until then, so confirm with `fly ssh console -C printenv` on each machine. stg was set and verified on 2026-10-05.
prod owes only `STREAM_PLAYBACK_HOST` (the same customer host) before the production tag; `STREAM_INGEST_HOST` stays
unset under W26.

- **A real-driver deployment without `STREAM_PLAYBACK_HOST`** answers a session GET with `503` (`playback_unconfigured`)
  and logs an error at boot. `playbackUrl` is required by capture, and a guessed host would be a lie.
- **Environment-tunable timings (AGENTS.md #20).** `DEAD_PHONE_TAKEOVER_SECONDS`, `PHONE_LOST_LIVE_MINUTES` and the
  §6.9 constants can be overridden **only** when `ENV_NAME ∈ {local, ci}`, so the walkthrough can drive A14, ask 10
  and W19 in seconds. Each guard pins the **default**, never the live value.

---

## 7. PR-2 — organiser extras

### 7.1 The switch (W7)

- **"Stream the match automatically"**, off by default, saved per fixture (`fixture_stream_settings.auto_stream`,
  §8.2).
- It sits under the destination picker in the Ready state, and is shown in Live as a read-only line, "Automatic: stops
  about 3 minutes after the result".
- The API is `PUT …/stream-settings {autoStream}`.
- `autoAllowed` on every phone answer reflects the switch.

### 7.2 Auto start (W7, A12, A16)

**Predicate,** evaluated by `domain/auto-stream.ts` on every beat from the current phone (§6.3.2 step 6):

```
autoStartDue =
  auto_stream
  AND the current phone's latest mode = "automatic"      (capture A4: both switches)
  AND the current phone is present
  AND fixture.status = "in_play"
  AND no open session
  AND auto_started_at IS NULL                             (once per match)
  AND auto_start_blocked_at IS NULL                       (never after an organiser Stop)
  AND no session of this fixture ever received ingest     ("before any broadcast has run", A16)
  AND (auto_start_attempted_at IS NULL OR now − auto_start_attempted_at ≥ AUTO_START_RETRY_SECONDS (60))
```

**"From any scoring surface"** holds by construction. The predicate reads the fixture's status, which `appendEvent`
writes for every surface (console, pad, device link, import). So there is no hook in the scoring path.

**"Match start or late pairing, whichever is first"** also holds by construction. Whichever beat first finds both
the phone and `in_play` fires it.

**When it is due,** it calls `startBroadcast(…, startCause automatic)`.

- **On success:** `auto_started_at` is stamped and the session id is recorded.
- **On a refusal** (no credit, no destination, not entitled, destination in use, unavailable):
  - the code goes in `auto_start_refusal` and `auto_start_attempted_at` is stamped;
  - it is retried no more than once a minute while the predicate holds, so buying credits mid-match lets it fire;
  - the panel shows the refusal (§7.4).
- **Organiser Stop** stamps `auto_start_blocked_at` (A12). The switch itself is not changed. An organiser Go live
  that follows is manual and always allowed.

### 7.3 Auto stop (W7, A15)

**Predicate,** evaluated on beats, on the organiser poll and in the sweep (the §6.11 tick):

```
autoStopDue(session) =
  auto_stream
  AND the session's phone's latest mode = "automatic"   (capture A4)
  AND fixture.finished_at IS NOT NULL
  AND now ≥ finished_at + AUTO_STOP_AFTER_RESULT_SECONDS (180)
  AND session.created_at < finished_at                   (it was broadcasting the match when the result came)
```

- **Effect:** `stop(auto_stopped)`.
- **A hand-restarted broadcast that was running when the result came is stopped** (A15).
- **A broadcast started after the result is the organiser's deliberate post-match broadcast, and is never
  auto-stopped.** Without this rule a post-match interview would be killed at once.
- **A reverted result** clears `finished_at` (T32), so an auto stop that has not yet fired is cancelled.
- **Latency.** The tick is a beat (~10 s while held), an organiser poll, or the 5-minute `stream-tick` job (W22). A
  phone that died after the result, with no panel open, is stopped within 5 min of the 180 s.

### 7.4 The phone-health line (W9, W8)

This fills fixture-page §3.4's reserved slot, the `phoneStatus` prop of `SignalChain`.

**The line** is "Phone · 78% charging · 2.4 Mbps · heard 4 s ago". Its sources, all from `stream-phone`, are:

- the battery and charging fields;
- `bitrateKbps`;
- the age of `last_beat_at` on the server clock (`elapsedMs`, the D3 M6 rule).

**Amber,** with one plain sentence each, in priority order:

1. **not responding**: "Phone not responding · last heard {n} s ago" (warn only, W8);
2. **stalled**: "Video isn't reaching Seazn from the phone";
3. **hot**: "The phone is running hot";
4. **battery low**: "Phone battery low ({n}%) — plug it in".

**Other parts of the line:**

- **Behind a tap:** data used and the app version, inside the existing Details disclosure.
- **Mode and readiness:** "Automatic" or "Operator" next to the Phone node's state word. Also "Phone not ready:
  {reason}", where the reason is one of camera, sound, network, or held ("turn the phone sideways"), and
  "Couldn't start on the phone" when the beat carries `startFailed`.
- **Auto start refused:** "Automatic start couldn't begin: {reason}", with the same remedies as the manual refusals
  (Buy credits, Manage destinations).

### 7.5 Device model and takeover notice (photographed-QR mitigation)

- **The paired phone's model** sits under the Phone node: "Paired · Pixel 8". It comes from the claim's
  `device.model` (G0-e).
- **Takeover notice.** For 30 min after a `phone_takeover` event, the panel shows an amber line: "The camera moved
  to another phone ({model}) at {time}. Not yours? Stop the stream, then Revoke & reissue". The line names Stop only
  when the session is live. It is dismissable.

### 7.6 Mockups — a gate (W9)

- **Before any PR-2 UI code,** static mockups at **320, 768 and 1280** go to the owner for sign-off. They are built out of tree (a
  scratchpad or a private Artifact) and are never committed (owner, 2026-10-05).
- **At least two options** are owed for the health line and the notice (the house rule).
- **States covered:**
  - Ready with auto off and with auto on;
  - Waiting with the phone not ready;
  - Live and healthy;
  - Live with each amber state;
  - Live and not responding;
  - the takeover notice;
  - an auto start refused for no credit.
- **No PR-2 panel task starts without that sign-off.** The server half of PR-2 (§7.1–§7.3) may proceed.

---

## 8. Data model

The numbering must be re-checked when each file is written. `main` tops at V426. PR #908 adds V427 and V428. The
Cloudflare Cron Triggers programme executes first and takes **V429** (its plan's V419 was already taken on main).
PR-1 therefore takes **V430** and PR-2 **V431**: the next
free numbers at the rebase that writes each file, re-derived with `ls db/migration/deltas | sort -V | tail -1` and a
check of `git log --all`.

### 8.1 V430 — PR-1 (`V430__capture_stream_codes.sql`)

```sql
-- 1. When a fixture finished, maintained in ONE place for every writer (appendEvent's fold, finalize, cancel, staff
--    reopen). "Finished" is the §3 set; leaving it (a reverted result) clears the stamp.
alter table fixtures add column finished_at timestamptz null;
create function fixtures_track_finished() returns trigger language plpgsql as $$
begin
  if new.status in ('decided','finalized','forfeited','abandoned','cancelled') then
    if tg_op = 'INSERT' or old.status not in ('decided','finalized','forfeited','abandoned','cancelled') then
      new.finished_at := now();
    end if;
  else
    new.finished_at := null;
  end if;
  return new;
end $$;
create trigger fixtures_track_finished before insert or update of status on fixtures
  for each row execute function fixtures_track_finished();
update fixtures set finished_at = now() where status in ('decided','finalized','forfeited','abandoned','cancelled');

-- 2. The stable code (W1).
create table fixture_stream_codes (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  fixture_id     uuid not null references fixtures(id) on delete cascade,      -- T35
  code           text not null unique check (code ~ '^[0-9a-hjkmnp-tv-z]{12}$'),
  tok_hash       text not null check (tok_hash ~ '^[0-9a-f]{64}$'),
  tok_enc        bytea null,                                                    -- wiped when ended
  issued_by      uuid not null,
  created_at     timestamptz not null default now(),
  first_shown_at timestamptz null,
  shown_count    integer not null default 0,
  ended_at       timestamptz null,
  end_cause      text null check (end_cause in ('reissued','expired')),
  ended_by       uuid null,
  check ((ended_at is null) = (end_cause is null)),
  check (ended_at is null or tok_enc is null)
);
create unique index fixture_stream_codes_one_active on fixture_stream_codes (fixture_id) where ended_at is null;

-- 3. Per-fixture stream settings: the destination pre-pick (W6). PR-2 adds the auto columns.
create table fixture_stream_settings (
  fixture_id uuid primary key references fixtures(id) on delete cascade,
  org_id     uuid not null references organizations(id) on delete cascade,
  target_id  uuid null references org_stream_targets(id),                      -- archived rows are never deleted (D2)
  updated_by uuid null,
  updated_at timestamptz not null default now()
);

-- 4. Pairings (A9, A14).
create table fixture_stream_pairings (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references organizations(id) on delete cascade,
  code_id               uuid not null references fixture_stream_codes(id) on delete cascade,
  slot                  integer not null check (slot >= 0),
  phone                 text not null check (length(phone) between 16 and 64),
  claim_kind            text not null check (claim_kind in ('new','resume')),
  device_model          text null check (length(device_model) <= 80),
  app_version           text null check (length(app_version) <= 40),
  mode                  text null check (mode in ('automatic','operator')),
  phone_state           text null,
  not_ready             text null check (not_ready in ('camera','sound','network','held')),
  start_failed          text null check (start_failed in ('not-found','cred-host','config','start-error')),
  claimed_at            timestamptz not null,
  last_beat_at          timestamptz not null,
  answered_poll_seconds integer not null check (answered_poll_seconds between 5 and 300),
  last_beat             jsonb null,
  ended_at              timestamptz null,
  end_cause             text null check (end_cause in ('replaced','operator_stopped','code_ended')),
  replaced_by           uuid null references fixture_stream_pairings(id),
  check ((ended_at is null) = (end_cause is null))
);
create unique index fixture_stream_pairings_one_current on fixture_stream_pairings (code_id, slot) where ended_at is null;

-- 5. Sessions.
alter table fixture_stream_sessions
  add column start_cause text not null default 'organiser' check (start_cause in ('organiser','operator','automatic')),
  add column code_id     uuid null references fixture_stream_codes(id) on delete set null,
  add column pairing_id  uuid null references fixture_stream_pairings(id) on delete set null,
  add column phone_beat  jsonb null,
  add column phone_beat_at timestamptz null,
  add column warming_at  timestamptz null,
  drop column qr_issued_first_at;
alter table fixture_stream_sessions rename column credentials_revealed_first_at to credentials_served_first_at;
alter table fixture_stream_sessions rename column credentials_reveal_count to credentials_served_count;
-- end_reason: the V410 check is dropped and recreated (named), admitting all five.
--   stopped | operator_stopped | auto_stopped | phone_lost | max_duration
-- fixture_stream_sessions_end_reason_state (end_reason only in ending/completed) is unchanged.

-- 6. fixture_stream_events.source admits 'phone' (the check is dropped and recreated with it added).

-- 7. History (W10).
create table fixture_stream_phone_beats (
  id              bigint generated always as identity primary key,
  org_id          uuid not null references organizations(id) on delete cascade,
  pairing_id      uuid not null references fixture_stream_pairings(id) on delete cascade,
  session_id      uuid null references fixture_stream_sessions(id) on delete cascade,
  recorded_at     timestamptz not null,
  kind            text not null check (kind in ('minute','change')),
  phone_state     text null,
  flags           text[] not null default '{}',
  battery_pct     smallint null check (battery_pct between 0 and 100),
  charging        boolean null,
  thermal         smallint null,
  bitrate_kbps    integer null,
  delivery        text null check (delivery in ('ok','stalled','unknown')),
  delivered_lag_s numeric(6,1) null,
  raw             jsonb not null
);
create index on fixture_stream_phone_beats (pairing_id, recorded_at desc);
create index on fixture_stream_phone_beats (recorded_at);
```

**Every new table:**

- carries `org_id`, the `trg_set_org` trigger and RLS on the tenant (the V117 / V410 pattern);
- is read by the phone routes through the superuser `sql` only to resolve the code, then under `withTenant`.

(Amended, §17.1: the V410 pattern only. Enable plus force RLS, with no policy, no `trg_set_org` and no grant, and
every access through the non-tenant `sql`.)

The `migration-shape.test.ts` sweep gains the new tables, constraints and trigger.

### 8.2 V431 — PR-2 (`V431__auto_stream.sql`)

```sql
alter table fixture_stream_settings
  add column auto_stream             boolean not null default false,
  add column auto_started_at         timestamptz null,
  add column auto_start_session_id   uuid null references fixture_stream_sessions(id) on delete set null,
  add column auto_start_blocked_at   timestamptz null,
  add column auto_start_attempted_at timestamptz null,
  add column auto_start_refusal      text null
    check (auto_start_refusal in ('no_destination','no_credit','not_entitled','destination_in_use','unavailable'));
```

---

## 9. API surface

**Organiser routes:**

- Session login, editors only (owner or admin).
- `requireResourceAuth(fixture, write)`.
- `NEVER_KEY_ROUTES` for every new path.
- OpenAPI `ROUTES` entries in the same change. The `stream-contract.test.ts` pin of stream operations moves from 7
  to 11.

| Method and path | PR | Body → answer | Errors |
|---|---|---|---|
| `POST /api/v1/fixtures/{id}/stream-code` | 1 | ensure → `200 {qr, issuedAt}`, `private, no-store` | `422 fixture_finished`, `503 RELAY_KEK_MISSING`, `402` (no `streaming.relay`) |
| `POST /api/v1/fixtures/{id}/stream-code/reissue` | 1 | → `200 {qr, issuedAt}` | as above |
| `GET /api/v1/fixtures/{id}/stream-phone` | 1 | → `{code: {issuedAt, state: "active" \| "finishing" \| "ended", endCause} \| null, phone: {present, silent, notResponding, model, appVersion, mode, state, notReady, startFailed, lastBeatAt, elapsedMs, beat: {battery, bitrateKbps, delivery, thermal, dataUsedMB}} \| null, destination: {id, label} \| null, lastTakeover: {at, model} \| null, auto: {...} \| null}` (no secret). PR-2 fills `auto` and uses `lastTakeover`. | `404` |
| `PUT /api/v1/fixtures/{id}/stream-settings` | 1 / 2 | `{targetId?}` (PR-1), `{autoStream?}` (PR-2) → the settings | `404` (target not in org, or archived) |
| `POST /api/v1/fixtures/{id}/stream-sessions` | 1 | existing. It saves the pre-pick. | **new `409 phone_not_paired`** |
| `GET …/stream-sessions/current` | 1 | existing **minus `qr`** and `?reveal`. It gains `startCause`. `endReason` widens (§6.8.4). | — |
| `POST …/stream-sessions/{sid}/stop` | 1 / 2 | existing. PR-2 stamps `auto_start_blocked_at`. | — |

**Phone routes (Bearer tok, no cookie, no session):** §6.3. These paths are registered in OpenAPI under an internal
`capture` tag, so the drift check covers them. The JSON contracts stay the cross-repo authority.

**Fake-only route:** `POST /api/internal/relay/fake-ingest/{inputId}` `{connected: boolean}`.

- It drives the fake ingest's connection for e2e (A14, T26). Today the fake connects on a timer
  (`server/relay/fakes.ts`). The timer stays the default, and this route overrides it per input.
- It answers `404` unless `RELAY_DRIVERS=fake` **and** `ENV_NAME ∈ {local, ci}`. A test proves the 404 in each
  refused combination.

---

## 10. Security

### 10.1 The tok

- It is 128-bit random. It is stored as sha256 plus a RELAY_KEK-sealed copy. Its plaintext exists only in the
  organiser's QR response and the phone.
- **Resolution:**
  - look up by `code` (public);
  - compare `sha256(presented)` against `tok_hash` with `timingSafeEqual` on equal-length buffers, using the
    `verifyOverlayKey` shape;
  - **an unknown code compares against a fixed dummy hash**, so the two refusals cost the same;
  - both refusals are `401 code_ended`, with no oracle. A code that is not well-formed is `404` (T41a), which is
    syntactic and reveals nothing.
- **It is never echoed** in any response except the organiser's QR, never logged, and never in a URL. The phone sends
  it as a header, and the code is the only path segment.

### 10.2 The descriptor serves publish secrets (W3)

| Rule | Mechanism | Test |
|---|---|---|
| no-store | `Cache-Control: private, no-store`, `Pragma: no-cache` on every phone answer | header asserted on every phone route (four with W27's `…/scoring-link`), success and error |
| never logged | No route logs a header or a body. The pino logger gains `redact` paths: `req.headers.authorization`, `*.tok`, `*.cred`, `*.streamKey`, `*.passphrase`. Sentry capture on these routes drops the request body. | A spy-logger test drives each route, including its error paths, and asserts that no captured line contains the tok, the stream key or the passphrase |
| constant-time | §10.1 | The compare's call is asserted, and a mutation to `===` must be killed by a structural test that pins `timingSafeEqual` |
| valid tok only | C1 | wrong tok, ended code, unknown code, a non-current phone, a missing `phone` (G0-d) and an ended session (`completed` / `failed`) all receive **no `cred`** |
| current phone only | §6.3.1 | Two phones on one code: only the session's phone gets `cred`. After a takeover, only the new one does. |
| decrypted per request | `readFirstInput` inside the request, never cached | covered by enc-boundary.test.ts, unchanged |

At the Cloudflare edge (adopted 2026-09-22), staging step S5 checks that `/api/v1/capture/*` is never cached.

### 10.3 Threats

| Threat | Mitigation |
|---|---|
| Photographed QR → a stranger pairs while the slot is not live (A9) | **No credentials until a session opens, and then only to the current phone.** The organiser sees the device model and a takeover notice (PR-2). Revoke & reissue (PR-1). Owner-accepted residual: the code lasts until finish + 2 h with no cap (W2). |
| Photographed QR → a stranger takes over a dead live phone (A14) | Needs 60 s with no beat **and** no video. The stranger then publishes to the organiser's destination. Remedy: Stop, then Revoke. The notice names this (§7.5). |
| A photographed QR spends credits (`POST start`) | It needs the pre-pick (organiser-chosen) and current pairing. The credit is consumed only at live. Each paid live buys three free restarts (W23), so a stranger needs four broadcasts that reach video to spend one more credit. |
| Brute force of code or tok | 60 + 128 bits. Rate-limited per IP for 401s (§10.4). Uniform 401. |
| An old or replaced phone stops a newer broadcast | A stop names one sid and closes only that sid, never a newer one (T23, T24). A phone that is not current can stop nothing with an `ended` beat (T22). A late `stopped` from a phone that is not current is ignored while the current phone holds that sid (T24a, §6.8.2). |
| Cross-site request | No cookies are read. The routes are Bearer-only. `proxy.ts`'s cross-origin non-GET guard needs no exemption, because native requests carry no `Origin`, which staging step S6 confirms. |
| Credential replay after the session | Cloudflare live input credentials are per session. A finished session's input has no output. Unchanged. |
| A staging code used against production | The code tables are per database, so a staging code is unknown in production → 401. |

### 10.4 Rate limits and Retry-After

- **Presets in `rate-limit.ts`:**
  - `CAPTURE_CODE_LIMIT`: 120 requests per 60 s per `code`;
  - `CAPTURE_FAIL_LIMIT`: 30 failed 401s per 60 s per IP, keyed through the existing `ipKey`;
  - `CAPTURE_START_LIMIT`: 6 per 60 s per `code`;
  - W27's `…/scoring-link` (2026-10-06): the code's budget, then the console's `DEVICE_LINK_MINT_LIMIT` (10 per 60 s)
    per client IP, in the console's own `dlmint:` bucket (§6.3.5) — spent only past the tok and holder checks
    (amended 2026-10-07, review M2).
- **Retry-After.** `HttpError` gains an optional `headers` field, and `handler()` and `v1()` set it. The limiter's 429
  carries `Retry-After` = the window's remaining seconds (capture request c; amended, §17.4). Nothing in `apps/web` sets
  `Retry-After` today. This is the first use, and a unit test pins it.
- **The limiter is inert without Redis** (local and e2e). The 429 path is unit-tested through the existing test seam,
  and staging step S7 exercises it for real.

---

## 11. Test plan

TEST-STRATEGY.md binds: rules 1–10, the reviewer's four questions, all four test types (RULES.md). Locally, only the
tests covering changed files run (owner, 2026-09-28). Expected values come from the declarations (the constants in
`relay/config.ts`, `ACTIVE_STATES`, the domain tables, the contract JSON), **never from typed tables**.

### 11.1 PR-1

#### 11.1.1 Unit — the pure domain (table-driven, each row a case)

- `stream-code.ts`, C1–C5:
  - every (code state × open-session × caller) row, including C1b's "ended but serving its session's phone" and its
    negative pair (the same caller after the session ends → 401);
  - expiry at grace − 1 s and at grace exactly;
  - a reverted result.
- `pairing.ts`:
  - T1–T7 and T4, each conjunct of T4 failing alone;
  - silent, present and not-responding at the boundary for **each** answered cadence (5, 10, 60), derived from the
    constants;
  - an ordering-differential case: a phone silent at 60 s but due at 90 s.
- `slot.ts`: every row of §5.4. **The empty case is stated first:** no pairing and no session → `empty`.
- Beat answer: every row of §6.3.3, including its precedence: `taken`, then `replaced`, then T9's `over X` over every slot row.
- pollSeconds: every row of §6.6, at T−30 min ± 1 s, with and without `scheduled_at`.
- End-reason mapping: §6.8.4, both directions, swept over the declared DB enums. Anti-vacuity: the count of mapped
  reasons must equal the enum length.
- `session.ts`: `stop` with each reason; `ending × stop` keeps the first reason; warming anchored on `warmingAt`
  (provisioning at 179 s still gets the full 10 min).
- Ingest URL rewrite: RTMPS on an exact host, a foreign host, unset, and the scheme, port and path preserved; SRT
  never rewritten (it stays `live.cloudflare.com` with `STREAM_INGEST_HOST` set), and a foreign SRT host → 503.

#### 11.1.2 Use-case (DB-backed vitest)

- Ensure: re-show, mint, a KEK missing writes nothing, envelope mismatch → reissue, refusal on a finished fixture,
  `shown_count`.
- Reissue: the old code is served only to its session's phone (C3), and a new claim on the old code gets 401.
- `finished_at` trigger: for every status pair (into, out of, within the finished set). A `forEachSport` sweep drives
  each sport's own finishing events through `appendEvent` and asserts the stamp (rule 6: "another sport"). (Amended,
  §17.7: the sweep is over the status writers.)
- Claims under concurrency: two phones claim at once with a gated transaction (the
  `registration-concurrency.test.ts` pattern). Exactly one current pairing.
- The start path: the operator start passes each gate (§6.7.2), and the organiser start refuses `phone_not_paired`. A
  **diff test** shows that the operator path and the organiser path call the same `startBroadcast` with the same
  admission inputs.
- Beat storage: latest beat on the pairing and the session; minute throttle; change rows per flag; purge at 24 h
  keeps the session's and the pairing's final beat; a history-write failure still answers.
- The tick: a phone beat advances `warming → live` with no organiser poll; coalescing (a beat and a poll in one
  interval → one provider read); ask 10 ends a warming session whose phone is lost; ask 10 **never** touches a
  session with `first_ingest_at`.
- W19 (§6.8.5, T25a): a live session with no beat and no connected sample for 15 min, and a fresh read not
  connected, ends `phone_lost` with no refund and no new consume; at 14 min 59 s on either clock it does not; a phone
  that beats while the input is down, and one silent while the input is connected, are never ended; the expected
  15 min comes from `PHONE_LOST_LIVE_MINUTES`, never a literal in the test.
- Descriptor: every field from its source (§6.4); the `overlayUrl` entitlement both ways; `captureOrigin` ignores a
  forged `X-Forwarded-Host`; `cred` absent for every non-qualifying caller.
- GET per latest session (§6.3.1): open → session shape, `cred` only to the current phone and **absent** (not null)
  for another; ended after `warming` → `completed` / `failed` with its wire `endReason` and no `cred`; ended before
  `warming`, `requested`, `provisioning` or none → waiting; no `phone` → waiting in every case.
- Wire bodies (§4): every 2xx is the bare shape (no `ok`, no `data`); every refusal is `{code, ...}` with
  `already_live` carrying `sid` and `startedBy`; `?` fields are omitted, never `null` (`scheduledStart` on waiting,
  `sid` / `startedBy` / `endReason` on the beat answer). Mutant: route a refusal through a bare `HttpError` → the
  `already_live` case loses `sid` → red.
- Claim edges (ask 2): a `resume` for a slot with no current pairing is accepted, including from a phone once
  replaced; a refused claim carrying `stopped: X` (X ended) answers `taken` / `replaced`, applies the stop, and
  never `over X` (G0-g).
- **Money** (programme §5.4 style, against the Stripe sandbox where purchase is involved):
  - an operator-started session consumes exactly once, at live;
  - a takeover (T4) consumes nothing;
  - an operator restart inside 24 h is free, up to three that reached video (W23);
  - **the boundary:** restarts 1–3 that reached video are free, and the 4th consumes 1 credit at live; a restart
    with no video leaves the count unchanged; a rejoin or takeover of the same sid never counts; after the paid
    4th, the next restart is free again (O4);
  - a `phone_lost` session consumed nothing.

#### 11.1.3 Mutation (rule 5). The killer **list** is recorded in the PR, one mutant per surface

| Mutant | Must be killed by |
|---|---|
| `timingSafeEqual` → `===` | the structural pin |
| drop the dummy-hash compare for an unknown code | the uniform-path test |
| serve `cred` to any valid tok (drop the current-phone check) | the G0-d two-phone case |
| C1b always true | ended code + new claim → must be 401 |
| C2 drop "no open session" | T34: a live session's phone gets 401 → red |
| A9 refusal removed (T3) | the live-slot claim case |
| T4: drop the beat conjunct / drop the CF conjunct / drop the sample conjunct (three mutants) | each its own case |
| T6 `resume` treated as `new` | a resume from a phone that is not current steals the slot from the current one → red |
| T24: on `stopped: X`, close the fixture's open sid instead of X | `stopped: X` (X ended) while a newer Y is open → Y is closed → red |
| T24a: drop the "current phone holds X" check | A's late stop ends B's live X → red (the two-phone sequence, §11.1.4) |
| T23: apply the hold check to the current phone too | the current phone's own late stop of X is ignored → red |
| `phone_not_paired` gate removed | the organiser Go live with no phone → red |
| pollSeconds near window off by one | T−30 boundary |
| ask 10 without `first_ingest_at IS NULL` | a live session with a silent phone is ended at 60 s → red (W8, W19's 15 min) |
| W19: drop the beat conjunct | a beating phone with the input down 15 min is ended → red |
| W19: drop the fresh-read conjunct / drop the connected-sample conjunct (two mutants) | a silent phone whose video still flows is ended → red |
| W19: `>` for `≥`, or 14 for 15 | the boundary case at exactly 15 min → red |
| ask 10 at a flat 60 s (drop the cadence term) | an organiser Go live on a 60 s-cadence phone is ended before the phone's next beat → red |
| `preferred: "srt"` while `cred.srt` is null | the SRT-off descriptor case |
| purge deletes the session's final beat | the purge case |
| `no-store` removed from an error path | the header case on 401 |
| consume not run for `startCause operator` | the money case |
| the `ENV_NAME` gate on the fake-ingest route removed | its 404 case |

#### 11.1.4 Sequence: model-based with fast-check (rule 10)

This surface is an ordered-action surface, so the model test is owed.

**Actions:**

- `claimNew(p)`, `claimResume(p)`, `beat(p)`, `silence(p, s)`, `endedBeat(p)`, `stoppedBeat(p, sid)`;
- `organiserGoLive`, `operatorStart(p)`;
- `ingestConnect`, `ingestDrop`;
- `organiserStop`, `reissue`;
- `finish`, `revertResult`, `advance(t)`, `archiveDestination`, `buyCredit`.

These run against the real use-cases with the fake drivers and an injected clock.

**Invariants, checked after every step:**

1. at most one current pairing per code and slot;
2. at most one open session per fixture;
3. `cred` is served only to the open session's phone;
4. a live slot changes phone only through T4 with the conjunction true;
5. no stop closes a sid other than the one named, and never a newer one;
6. a code never answers 401 to its open session's phone;
7. at most one consume per fixture per 24 h;
8. `go-live` ⇒ no ingest yet, and `live` ⇒ ingest;
9. a `stopped` from a phone that is not current never ends a sid the current phone holds (T24a);
10. a live session ends `phone_lost` only when no beat AND no connected sample for ≥ 15 min (T25a).

**Pinned sequences, run beside the generated ones:**

- **A's late stop must not end B's live broadcast.** A claims; organiser Go live X; A's operator stops before the
  first frame (no `ended` beat; A keeps its stop record); B claims `new` and takes the slot (T2); ingest connects, so
  X is live under B; A claims `new` with `stopped: X` → `taken`, X stays live; A claims `resume` with `stopped: X` →
  `replaced`, X stays live. Both answers count as delivered.
- **Its positive pair.** The same, with no B: the server still has A current (a Stop before the first frame sends no
  beat, A8), A re-pairs with `stopped: X`, and X ends with `operator_stopped`. The branch "not current, and no
  current phone holds X" is not reachable through these actions (a takeover moves the session's phone); a use-case
  test builds that state directly and asserts that the stop applies.

**Anti-vacuity.** The run reports how many steps exercised each invariant non-trivially, for example takeovers
attempted, late stops delivered, late stops ignored because held (invariant 9) and creds served. **Zero for any invariant fails the run.**

**Shrinking.** A shrunk failure is committed as a named regression with its seed **before** the fix.

#### 11.1.5 E2E — real server, `RELAY_DRIVERS=fake`

**A new helper, `e2e/helpers/fake-capture-phone.ts`.** It is a Playwright `request` client that reads the QR text
**from the panel's paste-code field**, then drives the real phone routes. It is the inert-seam rule (failure class 1):
the panel's own output is fed through the real consumer.

**`walkthrough/stream-relay.spec.ts`, rewritten for v2:**

- pair → Go live becomes enabled;
- Go live → the phone hears `go-live` → GET returns the session with `cred` → fake connect → live (panel Live, the
  credit line moves);
- organiser Stop → `over stopped` → the phone is back to waiting on the same code → Go live again (free restart).

**A new `walkthrough/capture-phone.spec.ts`:**

- operator start, plus each refusal (no destination; no credit on a zero-balance org; not entitled through an
  override);
- A9 (a second phone is `replaced`; the live slot is `taken`);
- A14 (fake disconnect plus the tuned clock → takeover → same sid, no second consume);
- T21 operator stop → "Stopped from the phone";
- the A17 late stop;
- ask 10's lost phone (`phone_lost`);
- Revoke & reissue (the old QR gets 401, the new QR pairs);
- a finished fixture's code (401 after the tuned grace; a live broadcast past it keeps working).

**Panel states** at 320, 768 and 1280 (§6.12), with no horizontal page scroll.

**Run scope.** The whole spec files are run, never a `-g` slice (AGENTS.md #21). Budgets are derived from the
constants (AGENTS.md #20).

**Re-run, because they touch the panel or the QR:** `mobile.spec.ts`, `stream-credits.spec.ts`,
`stream-overlay.spec.ts`, and the QR-enlarge helper's specs.

#### 11.1.6 Smoke (`scripts/smoke.ts`) — case `capture-v2`

Mint → claim → organiser Go live → beat `go-live` → GET session (asserting `Cache-Control: private, no-store` and no
`cred` for a second phone) → fake connect → beat `live` → Stop → beat `over`.

#### 11.1.7 Regression — one test per named defect or contract break

- v1 is gone:
  - `current` has no `qr`;
  - `?reveal=1` is 400;
  - no `capture-qr.v1` file exists;
  - the QR payload has exactly 4 keys and no `cred`.
- overlayUrl is never header-derived.
- The warming timer is anchored on warming entry.
- The end-reason check admits all five values, and `migration-shape` is updated.
- The fake-ingest route is 404 outside local and CI.

#### 11.1.8 Visual

Screenshots of every §6.12 state at 1280, 768 and 320, compared with the signed-off mockup, with **per-screen
verdicts** before the PR. The real-phone scan of the v2 QR (normal and enlarged) is recorded with the device.

### 11.2 PR-2

- **Unit:**
  - `auto-stream.ts`: every conjunct of `autoStartDue` failing alone; `autoStopDue` likewise.
  - The empty case first: no settings row means no auto.
  - Ordering-differential cases:
    - a session created before versus after `finished_at`;
    - phone mode `operator` versus `automatic`.
  - The retry spacing at 59 s and 60 s.
- **Use-case:**
  - fires once;
  - never after an organiser Stop (A12), and fires again only through a manual Go live;
  - a late pairing fires when no broadcast has run, and does not fire after one has received ingest (A16);
  - an auto stop cancelled by a reverted result;
  - a hand-restarted broadcast (created before the result) is auto-stopped (A15);
  - a post-result broadcast is not;
  - an auto start refused for no credit retries after a purchase (Stripe sandbox).
- **Sequence:** the PR-1 model gains `toggleAuto`, `setPhoneMode`, `matchStart`, `finish`, `revert`.
  - Extra invariants: auto start fires at most once per fixture; never after an organiser Stop; auto stop never
    stops a session created after `finished_at`.
  - Anti-vacuity counts for each.
- **Mutation:** one mutant per predicate conjunct, plus "stamp `auto_started_at` on a refusal" (it must stay
  retryable), each with its killer listed.
- **E2E:**
  - the switch at 320, 768 and 1280;
  - auto start driven by scoring the first point **from the Remote scoring pad (a device link)**, not the console,
    which proves "any surface";
  - auto stop after the tuned delay;
  - the health line's amber states, driven through fake beats;
  - the not-ready line;
  - the takeover notice;
  - the PR-1 specs re-run.
- **Smoke:** `capture-v2` gains the auto start and stop case.
- **Regression:** the A12 + A15 combination (Stop, restart by hand, result → auto stop).
- **Visual:** against the signed-off PR-2 mockups (§7.6), with per-screen verdicts. The entitlement-gated states are
  verified **granted and denied** (owner checklist 2026-09-14).

### 11.3 The reviewer's four questions, answered in advance

1. **Second call.** Ensure re-shows the same code. Claims are idempotent per phone. A stop is idempotent per sid. A
   repeated `POST start` meets `already_live`. Auto start fires once.
2. **Empty input.** No pairing, no destination, no `scheduled_at`, no settings row, an empty beat history. Each has a
   row in the tables above and a test.
3. **After a withdrawal or a void.** A cancelled fixture is finished (the code expires after the grace; there is no
   new mint). A reverted result clears `finished_at`. A deleted fixture cascades the code away (T35).
4. **Another sport.** The only sport-dependent input is the fixture status. The `finished_at` trigger is swept over
   every sport with `forEachSport` (§11.1.2). Everything else is sport-agnostic, and each test states that reason in
   one line. (Amended, §17.7: the sweep is over the status writers.)

---

## 12. Staging verification (PR-1, before production)

Each step records the evidence (a command and its output, or a screenshot) in the PR. **S2 and S8 are gates.** S2b
is not (W20).

| # | Step |
|---|---|
| S1 | Deploy with `STREAM_INGEST_HOST=live.stg.seazn.club`, `STREAM_PLAYBACK_HOST` set and `STREAM_SRT_ENABLED` unset (on, W21). `GET` a session descriptor as the current phone. Confirm that `cred.rtmps.url` carries the staging host, `cred.srt.url` is `srt://live.cloudflare.com:778`, `preferred` is `"srt"`, and `playbackUrl` carries the customer host. As a second phone, the same GET has no `cred`. With the flag set `false`, `cred.srt` is `null` and `preferred` is `"rtmps"`. |
| S2 | **Gate (W15, W21).** Publish with ffmpeg over **RTMPS** to the descriptor's `rtmps://live.stg.seazn.club:443/live/` and stream key, then over **SRT** to `srt://live.cloudflare.com:778` with the descriptor's streamid and passphrase (ffmpeg with libsrt, or `srt-live-transmit` through a local UDP relay). Each must reach `connected` (Cloudflare status read). If SRT fails, set `STREAM_SRT_ENABLED=false` on staging (A18) and record why; RTMPS failing is a stop. |
| S2b | **Optional, not a gate (W20, W21); run later.** Prove SRT on `srt://live.stg.seazn.club:778` with a staging input's streamid and passphrase (ffmpeg with libsrt, or `srt-live-transmit` through a local UDP relay). A pass allows a server-only change that rewrites the SRT host to the custom host too, with no contract change. |
| S3 | Measure the SRT hold window (disconnect, then time until the manifest ends) against the declared 183 s. A difference beyond the slack changes the constant before production. |
| S4 | `playbackUrl` returns a manifest while live. |
| S5 | `curl -i` on all three phone routes through the public host: `Cache-Control: private, no-store`, and `cf-cache-status` not `HIT` across two requests. |
| S6 | A native-shaped request (no `Origin`) to `POST …/beats` passes `proxy.ts`. The same request with a foreign `Origin` gets 403 (the existing guard, proven unchanged). |
| S7 | Drive past `CAPTURE_CODE_LIMIT`: 429 with `Retry-After` (Redis is live on staging). |
| S8 | **Gate.** After one full run (pair, go live, stream, stop, late stop, reissue), search the Fly logs and Sentry for the tok, the stream key and the passphrase strings. **Zero hits.** |
| S9 | A beat history row older than 24 h is gone after the next minute insert on its pairing, and the session's `phone_beat` is intact. |
| S10 | Capture's plan D exit bar: a real phone on staging pairs, starts from the console **and** from the phone, streams a real match to YouTube, stops from each end, and takes over a dead phone (A14). Recorded with the device model. |
| S11 | W19 on real Cloudflare: go live from a phone, then kill the app (no beats) and stop video. With the panel open, the session ends `phone_lost` at 15 min (± one poll). A second run with only the beats stopped and video flowing stays live past 15 min. |

---

## 13. Out of scope

- Multi-camera (slot > 0). The schema allows it, and the API refuses it.
- Server push to the phone. Capture lists it as a fallback if waiting drains batteries, and it would need its own
  ruling.
- iOS (capture's own scope).
- The OBS tab's client-built overlay URL, and the overlay's visibility rule for private competitions. The
  `overlayUrl` follows the overlay page's existing public gate.
- A fixture deleted while its broadcast is live keeps today's behaviour. The session is not ended by the deletion.
  The plan re-pins that every delete path (`history.ts:559`, `stages.ts:628`, `:1519`, `:3105`) deletes only
  unplayed fixtures, and records it.
- Cron cadence. The relay sweep is daily and lives in the separate workflow repo. The Cloudflare Cron programme owns
  improving it.
- The six non-fixture-page QRs (fixture-page design §7 follow-up).

---

## 14. Decisions this spec makes beyond the log (visible for owner review)

These were not ruled in conversation. Each is decided here with its reason, and can be vetoed at review.

1. **RELAY_KEK** seals the tok. No new KEK means no new Fly secret (§6.1).
2. **`fixtures.finished_at` is trigger-maintained**, so every finishing writer is covered in one place (§8.1). "Void"
   is read as `cancelled`.
3. **The C1b/C3 deferral.** A reissued or expired code keeps serving only its open session's phone, until that
   session ends.
4. **Credentials go only to the current phone.** Another phone gets the session shape with `cred` absent, and the
   JS scan (no `phone`) gets the waiting shape. This needs `phone` on GET (G0-d, agreed).
5. **Auto stop applies only to a session created before the result.** A post-match broadcast is never auto-stopped
   (§7.3).
6. **Auto start and auto stop both require the phone's mode to be `automatic`**, following capture's A4.
7. **Ask 10's clock is cadence-aware.** It is 60 s once the phone holds the broadcast, and longer only before the
   phone could have heard the go-live (§6.8.3). It never touches a session that has received video.
8. **Silence is judged against the cadence the server answered**: max(60 s, poll + 30 s) (§6.9).
9. **A pre-pick held by another match answers the phone `409 no_destination`.** This adds no new refusal code to
   capture's shape (§6.7.2).
10. **Operator and automatic starts are attributed to the code's issuer** (`created_by`). The events record the
    phone.
11. **Retry-After** and the warming re-anchor stay in PR-1. The original split had them there, and the task brief
    did not list them.
12. **No route sends 410.** An ended broadcast is served to the phone as the session shape in `completed` or
    `failed`, with its `endReason` and **never `cred`**, so no publish secret is served for a broadcast that has
    ended (§6.3.1).
13. **A malformed code is `404`, and an unknown code is `401`.** Capture's 404 row ("not a stream code") stays
    meaningful, and no existence oracle is created (T41a).
14. **G0-d to G0-g were this spec's additions** to capture's approved shapes. Capture agreed all four in `69ef359`
    (2026-10-01). Points still for capture are listed under §4.2.

---

## 15. Contradictions in the brainstorm log, and how this spec resolves them

| # | Contradiction | Resolution |
|---|---|---|
| X1 | Expiry: "end of the fixture's local day" (two entries) **vs** "match finished + 2 h, no cap" | The later entry wins (W2). The local-day premise was stale anyway: since V417 device links have **no** clock (`device-links.ts:34`, `isLiveExpiry`), so "like Remote scoring" no longer meant local-day. |
| X2 | QR (a), credentials in the QR (recommended first, with a false "works on weak venue internet" reason) **vs** (b) | (b) wins (W3). The "4× smaller" claim was itself corrected in the log. |
| X3 | "One code per stream SESSION; enc copy wiped at session end" (controller design) **vs** a stable per-fixture code | Per-fixture wins (W1). `tok_enc` is wiped at reissue or expiry instead (§8.1 check). |
| X4 | The switch was named "Go live when the match starts" (start only) **vs** "Stream the match automatically" (start + stop) | The rename wins (W7). |
| X5 | Q3 says overlay is "today: test org only" **vs** V426 making `streaming.overlay` true on every plan | The rule built is the entitlement (W11). The owner ruled overlay on every plan (W18, O1 YES). |
| X6 | The final-beat literal `operator-stopped` (kebab) **vs** the answer vocabulary `auto_stopped` (snake) | Not a contradiction: the phone's words are kebab-case and the server's snake_case (coordinator reply, 2026-10-01). We accept `operator-stopped` and store `operator_stopped`. |
| X7 | `mode: auto` (brainstorm) **vs** `automatic` (capture amendment) | `automatic` (coordinator reply). |
| X8 | A17 "phone treats 200\|410 as delivered" **vs** capture's ask 8 (may beats answer 410?) | Beats never answer 410. An ended sid named by a beat gets `200 over` (§4.1, G0-a). |
| X9 | Q4 "our timeouts still end silent sessions" | **False for a live passthrough session.** Its only timeout is the 300-min wall clock (`expiry.ts` `evaluate`: no stale-beat arm for passthrough). It is true for warming (10 min). Put to the owner as O2; ruled YES (W19): built in PR-1 (§6.8.5). |
| X10 | Capture's amendment, Known gaps: "the credit was spent at the start" | False. The credit is consumed at the `live` transition (programme §5.2), so a broadcast ended by ask 10 costs nothing. **Agreed by capture** in `69ef359`: the credit is spent at the first ingest. |
| X11 | Brainstorm ask-10 wording "over with stopped" (capture's draft) **vs** the coordinator's reply | `phone_lost` (coordinator reply, G0-b). |
| X12 | Brainstorm "A17 late stop: 200/410" and the draft's "no-op answered 200" **vs** the coordinator's ask-8 reply | `200 over X` for an ended X (§6.3.3 row 2). |

---

## 16. Open for owner

**Closed (owner, 2026-10-01, on approving this spec at `137b9ec2b`):**

1. **O1 — overlay on every phone stream: YES** (W18). Built as W11's entitlement rule; nothing changes in the design.
2. **O2 — a live phone that vanishes: YES** (W19). It ends after 15 min with no beat AND no video, endReason
   `phone_lost`, built in PR-1 (§6.8.5, T25a, S11).
3. **The SRT test: DEFERRED** (W20), then **SRT on Cloudflare's host from launch** (W21): `STREAM_SRT_ENABLED`
   defaults on; S2b (optional) could later move SRT to the custom host. Capture's host rule admits
   `live.cloudflare.com` for SRT (G0-i, agreed 2026-10-01 by capture's owner), so no interim `false` is needed.

4. **O3 — how prompt W19's 15 minutes is: YES, a 5-minute tick** (W22, 2026-10-01). The Cloudflare Cron
   Triggers programme runs first; PR-1 adds the `stream-tick` job (§6.11).
5. **Free restarts: 3 per reuse window** (W23), **the reconnecting countdown** (W24) and **the localised label**
   (W25), all ruled 2026-10-01.

6. **O4 — a paid restart re-anchors: YES** (2026-10-01). The paid restart opens a fresh 24 h window with three
   free restarts again, as §6.7.4 says.
7. **O5 — no countdown while the phone still beats: YES** (2026-10-01). The panel shows "Reconnecting…" with no
   countdown, plus the phone's reason when its beat carries one (§6.12). Nothing ends the session while the phone
   is alive except the existing `maxDurationMinutes` cap (300).

**Open:** none.

---

## 17. Plan-time amendments 2026-10-01

The PR-1 plan's pre-flight review (2026-10-01) raised rulings. This section records only the ones that change text
above. Each changed line carries an "(amended, §17.n)" marker. The plan
(`docs/superpowers/plans/2026-10-01-capture-qr-v2-pr1.md`, "Pre-flight rulings and amendments") holds the full record.

**Who ruled.** R1–R4, R6–R8, R10, R11 and §17.9's slot rows are the controller's plan-time rulings. They are **not** the seazn.club owner's,
and §1.1 does not gain them. R5 is a contract detail agreed with capture on 2026-10-01. R9 is the owner's (see the
close of this section).

### 17.1 RLS on the V430 tables: the V410 pattern (R1)

Amends §6.3's `withTenant` line and §8.1's "Every new table".

- Each of the four new tables (`fixture_stream_codes`, `fixture_stream_settings`, `fixture_stream_pairings` and
  `fixture_stream_phone_beats`) gets `enable row level security` and `force row level security`, exactly as V410 does
  for the stream tables. They get **no policy, no `trg_set_org` trigger and no grant to `app_user`**.
  `rls-static.test.ts` asserts that V410 "creates no policy and no grant", and now asserts the same of V430.
- Every read and write of these tables, by the phone routes and the organiser routes alike, goes through the
  non-tenant `sql`. The use-case writes `org_id` from the code row or the session row. Nothing runs under
  `withTenant`.
- Why not V117's tenant pattern (`trg_set_org`, a tenant policy and a grant): the phone routes carry no org session,
  because the tok is their auth, and the stream tables would split across two RLS models.

### 17.2 The cron Worker's Sentry throttle (R2, R6)

Amends §6.11's `stream-tick` bullet.

- A failing `*/5` job could send 288 Sentry events a day. A scheduled firing therefore sends a failure to Sentry
  **only from the first `*/N` slot of each UTC hour**, keyed on the firing's `scheduledTime` (never the wall clock).
  It is stateless: no KV and no counter.
- Every other failing firing sends nothing, and its log line carries `sentryThrottled: true`, so the failure stays
  visible in Workers logs.
- The hourly trigger (`17 * * * *`) is never throttled.
- **Manual runs are never throttled (R6).** A human asked for that run.
- The cost: a failure that clears before the next `:00` slot reaches the logs only, and a persistent one reaches
  Sentry up to 55 minutes late.

### 17.3 The column drop and rename land with V430 (R3)

Amends §6.13's "Changed columns".

- The drop of `qr_issued_first_at` and the rename to `credentials_served_*` land in the same commit as V430, with
  the live QR writer in `currentSession` and its test readers re-pointed in that commit.
- **The interim meaning.** Until `?reveal=1` is removed later in PR-1, `credentials_served_*` also count organiser
  reveals. From the descriptor GET onward, they also count descriptor serves. The spec's meaning ("a descriptor
  carrying `cred` was served") holds from the v1 removal on.
- **The stg deploy window.** Between Flyway applying V430 on stg and Fly stg serving PR-1's code, the old stg
  server's QR writer fails on the missing columns. The window lasts for `stg.yml`'s Fly deploy after its migrate
  step, and the PR body states it.

### 17.4 Retry-After: the true remaining seconds (R4)

Amends §10.4's Retry-After bullet.

- `Retry-After` is the window's **true** remaining seconds, read from the counter key's TTL in the same Lua script as
  the increment. It is an integer, rounded up, and **never below 1**.
- The fail-closed 429 (Redis configured but unreachable) has no window to read, so it answers the **full**
  window's seconds.
- `v1()` merges `HttpError.headers` with its rate-limit headers, and neither replaces the other.

### 17.5 The beat's `at`, and the beat answer and session shapes as unions (R5)

Amends §4's "Optional versus null" bullet, §6.3.2's `at`, and §6.3.3's answer shape. Capture agreed this on
2026-10-01.

- **`at`** is ISO-8601 **with an offset allowed** (`z.iso.datetime({ offset: true })`). A value with no timezone is
  still refused. The server normalises `at` to UTC before storing it. The phone sends `Z`.
- **The beat answer is a discriminated union on `state`.** The common fields are `label`,
  `scheduledStart: epoch-s | null`, `autoAllowed`, `destinationName: string | null`, `overlayUrl: string | null` and
  `pollSeconds`.

| `state` | `sid` | `startedBy` | `endReason` | `device: {model}` | common fields |
|---|---|---|---|---|---|
| `waiting` | absent | absent | absent | absent | required |
| `go-live` | required | required | absent | absent | required |
| `live` | required | **absent** | absent | absent | required |
| `over` | required | absent | required (§6.8.4) | absent | required |
| `replaced`, `taken` | absent | absent | absent | optional | optional |

- Each branch is strict: a field from another state's branch (for example, `endReason` on `live`) is refused.
- The contract makes the common fields optional on `replaced` and `taken`. **PR-1's server still sends them on every
  2xx** (ask 1, §6.3.3, unchanged). The contract only stops requiring them there.
- `device` is admitted on `replaced` and `taken` for the panel's use (G0-e, §7.5). The phone ignores it, and PR-1
  never sends it.
- `409 already_live` keeps `{code, message, sid, startedBy}`.
- **The descriptor's session shape is also a union on `state`**, replacing §4's "`endReason` and `cred` on the
  session shape are `?`":
  - `endReason` is required on `ending`, `completed` and `failed`, and absent on `warming` and `live`;
  - `cred` is optional on `warming`, `live` and `ending`, and absent on `completed` and `failed`.

### 17.6 Label and destination lengths (R7)

Amends §6.4's `label` and `destinationName` rows, and §1.2 A13's reply "We send the full label".

- The descriptor builder cuts `label` ("{side A} v {side B}") to the contract's maximum of 200 characters, and
  `destinationName` to its maximum of 80.
- Each cut ends in one "…", inside the maximum, and never splits a surrogate pair.
- A value within its maximum is sent whole. So A13's reply still holds for every label that fits the contract.
- The same builder serves the descriptor and the beat answer, so the two never disagree.

### 17.7 "Another sport" for `finished_at` (R8)

Amends §11.1.2's `finished_at` bullet, and §11.3's question 4.

- The `finished_at` trigger keys on `fixtures.status`, which no sport module writes. The "another sport" sweep
  therefore runs over the **status writers** (score finalize, walkover or forfeit, abandon, cancel, and an admin
  correction), each driven through its real use-case.
- The sweep reports its count, and a count of 0 fails.
- The test file carries a `// single-sport:` reason, so the single-sport audit stays flat.
- There is no `forEachSport` sweep: the testkit has no per-sport finishing driver.

### 17.8 A completed session with no end reason (R11)

Amends §6.8.4's table with one row.

- `session.ts` can complete a session with `endReason: null`, when no stop reason was ever chosen. Its wire
  `endReason` is `failed` (G0-f: a server-side end that is neither a stop nor a timeout).
- `wireEndReason` throws `TerminalWithoutReason` for a row it cannot map. It never puts a null into an answer whose
  contract requires `endReason`.

### 17.9 Two slot rows §5.4 did not list

Amends §5.4's table with two rows.

- An open session in `live` with `first_ingest_at` still null is `live`. The phone is publishing, and a `waiting`
  answer would stop it.
- An open session in `ending` that never received ingest is `starting`. The phone waits, and does not go live into a
  stop.
  - Its cadence (B3 review m-4). §6.3.3 row 5 answers every `starting` slot with `POLL_STARTING_SECONDS` (5 s), so
    this row's phone is told 5 s although §6.6's table gives an `ending` session 10 s. The beat answer is the one
    authority: the use-case sends `wireBeatAnswer`'s `pollSeconds` and stores that value as the answered cadence,
    and §6.9 judges silence against what was stored. Either value gives the same 60 s silent threshold
    (max(60, 5 + 30) = max(60, 10 + 30) = 60).

### 17.10 W5 against the destination doors and the storage read

Amends §6.7.1's order line. Recorded in the B4 fix round (2026-10-04). Both points are the controller's, not the
seazn.club owner's: the first keeps the order as built, where §6.7.1 was silent (B4 review m-6), and the second is a
controller ruling.

- **The destination doors still answer first.** §6.7.1 orders only `admit`'s refusals. Before admission,
  `startBroadcast` runs the destination doors: the holder guard and the two prior-teardown refusals, each
  `target_in_use`. So with no phone **and** a destination another match is streaming to, the organiser hears
  `target_in_use`. Its remedy (pick another destination, or stop the other match) is owed whether or not a phone is
  paired. On a free destination the same Go live answers `phone_not_paired`.
- **W5 is answered before the storage-usage read.** A Go live with no phone asks Cloudflare nothing. The check is
  `admit` itself, asked without storage, so the plan gates and `active_session` (F-A5) still outrank it. Nothing was
  measured, so this refusal records no storage snapshot. Every other admission refusal keeps its snapshot (ruling 13).

### 17.11 Which sessions the phone rules judge (B5 fix round)

Amends §6.8.3, §6.8.5 and T19. Recorded in the B5 fix round (2026-10-04). Both points are controller rulings (C-1,
C-2), not the seazn.club owner's.

- **A session with no phone keeps today's rules (C-1).** `pairing_id` is null for every session open when V430
  deploys, and for one whose fixture was deleted (T35: the code and its pairings cascade, `on delete set null`). Ask
  10, W19 and m-5 never judge such a session. It ends as it does today: the warming timeout from
  `coalesce(warming_at, created_at)`, the max-duration deadline, and the runner's own ends. "No longer has a current
  pairing" means the session's pairing has ENDED. It does not mean the session never had one.
- **A reissue never ends the open session's phone (C-2, C1b/C3).** A session's pairing is current while the pairing
  has not ended. The state of its CODE is not read. A Revoke & reissue ends the code, and the old code still serves
  the open session's phone until the session ends. That phone is judged by the same silence clock as before the
  reissue. The code-active filter applies only to NEW claims and to the Go-live lookup, so a new Go live after a
  reissue still answers `phone_not_paired` until a phone claims the new code.
- **An `unknown` read never ends a broadcast as phone lost (m-3).** Clause 2 of §6.8.5 needs a fresh read that is
  `disconnected`. An `unknown` read, claimed or coalesced, does not satisfy it. A Cloudflare read blip never ends a paid
  broadcast as `phone_lost`. The phone's beat and the `max_duration` deadline still end it.

### 17.12 The countdown names the earliest end (B7 fix rounds)

Amends §6.12's Waiting row and W24. Recorded 2026-10-04. These are controller rulings, not the seazn.club owner's.

- **A countdown shows if and only if the end it counts down to fires at that deadline.** Each end is gated on what it
  reads. The live countdown (W19) shows only on a FRESH `disconnected` read (m-3). The warming timeout fires whatever
  the read's word is, so it is withheld only by a status read that threw (N1).
- **It names the EARLIEST end that will fire, with that end's `reason`.** In warming, once the phone's beats have
  stopped (no beat for the longer of its own cadence plus `POLL_NEAR_SECONDS` and `RECONNECT_QUIET_SECONDS`; the
  near poll keeps a far-cadence go-live beat's round trip from flashing a countdown, re-review m-a), ask 10's end is a
  candidate:
  the last beat + §6.9's silence threshold, `phone_lost`. The earlier of that and the warming timeout is shown. A tie
  goes to the timeout, because the tick expires a session before it judges ask 10. The panel's copy for a warming
  `phone_lost` countdown is owed by T11 and is not chosen here.
- **The outage gap is closed (B7 re-review, gap 1).** A poll that coalesces onto a claimed status read that THREW answers
  as that read did: nothing served, and the warming countdown held (N1). V430's `ingest_read_failed` carries it, written
  by the claimed read only when it changes. Before it, a lone tab whose polls coalesced onto the beating phone's claims
  showed a timeout countdown that N1 held, so it reached 0:00 and nothing ended.
- **A passthrough `live` session with no first ingest shows no countdown, by design (B7 re-review, gap 2: m-5).** No
  producer makes one for a session with a phone: passthrough enters `live` only through `ingest_connected`, and both
  `first_ingest_at` writes precede it. Phone-less rows keep today's rules (C-1). An inert countdown branch would be worse
  than none.

### 17.13 What the panel does where §6.12 is silent (T11)

Amends §6.12. Recorded 2026-10-05 by T11's implementer. These are the implementer's readings, offered for the
controller's review. None is the controller's ruling, and none is the seazn.club owner's.

- **The flag hides the option, and only the option.** With `capture-qr-v2` off (or PostHog absent, `fallback: false`),
  the Stream panel has no Phone/OBS tablist: it opens on OBS, and the live-stream stop probe stays mounted. The flag is
  read only for an entitled panel, keyed `userId ?? orgId` with the org group. `CAPTURE_QR_V2_ALWAYS` is on only at
  exactly `"1"`. The routes are not gated.
- **Flag off keeps the credit purchase (B8 re-review item 2, ruling: m-8 is a regression).** Before T11 every entitled
  organiser bought match credits in this panel, so with the flag off the purchase sits under the OBS overlay for an org
  the relay serves: the balance and Buy more, or at balance 0 the chooser itself, then the same embedded checkout. It is
  the Phone tab's own purchase (one `useCreditCheckout`, one chooser markup), with nothing of the phone path: no stream
  code is minted and no read model is read. What flag off cannot restore is the pre-T11 Phone tab's Go live, because the
  v1 QR it handed the phone is removed for every org (W4, §6.13), not behind the flag.
- **Flag off = the OBS path plus credits (coordinator ruling on the B8 re-review's open point, 2026-10-05; the owner is
  to be told).** Accepted as the whole of flag off: the OBS overlay, then the balance, Buy more and the embedded
  checkout. The pre-T11 Go live does not return with the flag, because W4 removes the v1 QR for every org.
- **The code line follows the phone past Ready (ruling A).** The folded "Show the code again" line, with Revoke &
  reissue inside it, also shows under Waiting and Live for a session with a pairing. It does not show for a legacy
  session. The mockup draws it only at Ready.
- **No Revoke & reissue on a finished fixture.** The reissue route answers 422 there, so the control is not drawn.
  While the code is still `finishing`, Show the code again keeps the code.
- **Code ended is one line.** At Ready with the match over (finished, and the code ended or absent), the tab shows "This
  match is over" alone. It has no chain, no Go live, no code, and no forced credits chooser, at any balance.
- **A legacy session is today's panel without the v1 QR.** It has §3.2's chain words, no strip, no code line, and no
  far-cadence line. Its Waiting row is Cancel alone, because the v1 QR is gone (§6.13).
- **The picker shows what the phone would stream to (B8 review I-1, controller ruling — replaces the open question
  recorded here).** ONE pure resolver, `resolveStreamTarget` (`lib/stream-destinations.ts`), read once by
  `fixtureStreamTarget` beside its one writer: no live destination → none; a saved choice still live → it; a saved
  choice cleared, archived or not the org's → **none, never another in its place** (n1/T36); no saved row → the org's
  oldest (`order by created_at, id`, the list's own order). The phone's start, its descriptor and the read model's
  `destination` (now with `source: saved | default`) all call it. The panel keeps ONE selection: it follows the read
  model's destination while the list holds it, until the organiser picks; a pick removed in Directory clears it (n1).
  n1 and the in-use lift act on what is shown. Opening the panel, or following the server, writes nothing; a pick
  writes the pre-pick (`PUT stream-settings`). Consequences: with nothing saved the phone's own Start streams to the
  oldest (it no longer answers `no_destination` there); and a destination added after a SAVED choice was removed is
  listed but not chosen — the organiser picks it (the old "a first destination after an emptied list is offered" holds
  only when nothing was saved). The capture-descriptor contract's prose for `destinationName` ("null when there is none
  or it is archived") is unchanged (contracts are final); "none" now reads as the resolver's none.
- **A session the phone starts shows on the panel (B8 review I-2, ruling: fix it).** The read model names the
  fixture's open session (`session: {id} | null`, whoever started it); the Phone tab reads `current` once for an id it
  does not show. So the tab at Ready or on an Ended card moves to Waiting within one poll of the phone's own start,
  instead of offering a Go live that would meet `active_session`. The T9b "known limit" now covers only a page with the
  Phone tab closed.
- **The flag is asked once per org per minute (B8 review m-2).** The loader keeps one answer per org for 60 s
  (`CAPTURE_FLAG_TTL_MS`, in-process, concurrent renders share the call), so a `router.refresh()` per scoring send no
  longer makes a remote PostHog call each time. A flip shows within a minute.
- **The strip replaces D3's phone box.** While a strip shows, D3's phone-cause box is not drawn. With no reason to
  give, D3 draws its box as before. The Phone node's "!" stays while a countdown runs. It is dropped while the phone
  beats with a reason (O5). With no reason, it follows D3's box as before.
- **The Phone node says what the strip says (B8 re-review item 1, ruling: a defect).** Both read ONE fact, `current`'s
  countdown, never the read model's `present`. Warming with ask 10's countdown (`warming`, `phone_lost`) is "Not
  answering" with the "!", beside "The phone stopped checking in — the stream is cancelled in…". The warming timeout's
  countdown keeps "Starting" with no mark (mockup §5: that phone still checks in). W19's countdown (`live`) is
  "Reconnecting…" with the "!" in `live` and in a warming reconnect (§5.4) alike. Ask 10's countdown is short by
  construction: it arms at max(`RECONNECT_QUIET_SECONDS`, cadence + one near poll) of silence and ends at §6.9's
  max(floor, cadence + slack), so with the defaults it never shows more than 30 s, and inside it the phone is not yet
  silent (§6.9's threshold IS ask 10's end). That is why the node cannot key on `present`.
- **The folded line's dot says it too (coordinator ruling on the B8 re-review's open point: the same defect class).**
  The dot on "Paired · Show the code again" reads the same countdown while the server counts down (`phoneDot`): amber
  exactly when the countdown is about a lost phone (ask 10, W19), lime while the phone still checks in (the warming
  timeout). With no countdown it reads the read model, as Ready's node does: present lime, silent amber, no phone slate.
- **Link 1 says it too (coordinator ruling, B8 re-review item 6).** While the session waits (requested, provisioning,
  warming) and the countdown is about a lost phone (ask 10, or W19 in a warming reconnect), link 1 (phone → Seazn) is
  `problem`, the amber dashes live's W19 draws. The warming timeout keeps waiting's `connecting`. So all four elements
  (the node, link 1, the strip and the fold's dot) read the one countdown.
- **A pick that does not save is said (B8 re-review n-5).** The picker's `PUT stream-settings` is what keeps the
  phone's start in agreement with the picker. On a failure the picker returns to the server's answer, and an alert
  under it says the pick did not save. A failure for a pick already replaced is moot.

### 17.14 A beat can answer 503 (B6 review M-5)

Amends §6.3.3. Recorded 2026-10-05 at the lane close (T13). The ruling is the controller's (B6 fix round, M-5), not
the seazn.club owner's.

- **What changed.** Before M-5, an error that the phone routes did not map left `handler()`'s bare
  `{ok:false, error}` body on the wire, which echoed internal text. `captureRoute` now maps every such error to
  `503 {code: "unavailable", message}`, the contract's error shape with a fixed message. The error is still logged and
  sent to Sentry. The GET (§6.3.1) and `POST start` (§6.3.4) already listed a 503. The beats route lists it now.
- **What the phone does.** Capture confirmed on 2026-10-04 that a beats 503 is transient NoEvidence: the pairing and
  the broadcast are kept (capture's `BodiesTest.kt:224`). Only a refusal body (`401 code_ended`,
  `404 not_a_stream_code`) or a 410 ends a pairing from a beat. A body-less or HTML 4xx is transient. Capture owed no
  change.
- **The contracts are unchanged.** `capture-beat.v1.json` keeps its bytes. The OpenAPI document gained the 503 on the
  beats route when it was regenerated in the B6 fix round.

**No spec text changes for these:**

- **R9, the owner's ruling (2026-10-01).** The staging cost of the `*/5` trigger is accepted, including keeping the
  stg machine awake. §6.11 already says what the trigger costs. The merge itself still needs its own owner OK.
- **R10:** where CI sets the walkthrough tunables. That is plan-only.
- **§5.4's `warming` (a reconnect) row has no producer (B7 review M-7; a controller ruling, 2026-10-04, not the owner's).** `warming` is entered only from `provisioning`, so a `warming` session with `first_ingest_at` set exists only in the gap between the `first_ingest_at` write and `connectIfWarming`, which are two separate statements. The row stays as written. The named killer tests build it by hand.
- **Go live evaluates C2 at W5's lookup (B7 re-review m-b).** §6.12's "Code ended: no Go live" now holds before any other
  evaluator has written the expiry: the lookup writes it (C2's first evaluation) and W5 answers `phone_not_paired`. An
  open session defers it, so a Go live over one still meets `active_session`.
