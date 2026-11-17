# Check-in capacity: pre-minted meetings, webhook presence, one-read proof

Date: 2026-11-05. Status: draft for owner approval. Scope: `apps/web` external play (online chess with cameras) and `apps/cron-worker`.

## 1. Intent

Check-in is the one moment the platform spends Cloudflare RealtimeKit REST calls in a burst. Today a board costs 15 calls when both cameras come up at once and 45 when both are slow, all inside the first minute of a round. The platform budget (`video/budget.ts`) allows 900 calls in any five minutes, a 300-call burst and then 2 a second, because Cloudflare refuses every call for five minutes once the per-user API limit of 1,200 is crossed.

Five clubs of ten players fit with a wait. Twenty clubs (200 players, 100 boards) need 1,500 to 4,500 calls at kickoff. At 2 a second the back of the line waits 10 to 35 minutes and most of those boards miss their check-in deadline.

This design cuts the kickoff cost of a board to about 7 calls in the normal case and 17 in the worst, with the one-read proof on (section 5 derives both, and the figures with it off). In the normal case, 100 boards need 700 calls. That fits inside the 900 the bucket passes in one five-minute window, and everyone is seated in about three and a half minutes. The worst case, 1,700 calls, does not fit one window. It takes about twelve minutes, with the check-in line holding the tail inside its five-minute grace past the ten-minute deadline. The design leaves a second lever (more API users) for growth beyond that. It does so without changing what counts as proof of a camera, without a second meeting model, and without storing a token.

## 2. Goals, non-goals, anti-goals

Goals

- Twenty clubs kicking off in the same minute, all camera-required, every player seated inside the first five-minute window in the normal case (about three and a half minutes for 100 boards, section 5), with the check-in line as a safety net rather than the normal path.
- The camera proof stays the vendor's peer report (`media_permission` ACCEPTED and the latest `video_on`), read by the server. Nothing in this design trusts the browser's word for the seat.
- One meeting per player per board (D16) stays. One participant per player per meeting stays. Tokens are never written to disk.
- Correct across the one to three Fly machines: every shared decision stays in Postgres, as the budget and the line are today.
- Headroom to fifty clubs by spreading calls over more than one Cloudflare API user.
- An arbiter on a laptop sees the state of every board of the round at once, and live video of the boards on screen, up to a limit the organizer sets. (The live-video grid is superseded by Match Day §9; see section 12.)

Non-goals

- Changing the Lichess create queue. Its claim-at-dequeue design and the sweep's retry already cover multiple machines; QStash is not needed on Fly. One stale comment in `creation-queue.ts` is fixed in passing (section 9).
- Moving the budget or the line off Postgres in this build. Section 7 says when Redis earns its place.
- Replacing polling with push for the opponent's camera pill during play. It already costs no vendor calls.

Anti-goals

- Any path that can send more calls than the vendor allows. A platform-wide five-minute outage is worse than any wait.
- A webhook outage that seats players without proof, or that blocks check-in. Webhooks save calls; they never decide a seat alone, and when they are missing the seat falls back to today's read.
- A token at rest, a player's token in an arbiter's hands, or an arbiter participant that nobody can revoke.

## 3. Constraints and verified facts

Vendor limits (Cloudflare docs, read 2026-11-05)

- RealtimeKit: 3,500 requests per five minutes for all RealtimeKit APIs, counted toward the global Cloudflare API limit.
- Global Cloudflare API limit: 1,200 requests per five minutes per user, across that user's dashboard, keys and tokens. Exceeding it blocks every call for five minutes. This is the figure `budget.ts` protects.
- Open question for section 8: whether separate account members each get their own 1,200. The docs say "per user"; confirm with Cloudflare before building section 8.

Webhooks (Cloudflare docs, read 2026-11-05)

- Events: `meeting.started`, `meeting.ended`, `meeting.participantJoined`, `meeting.participantLeft`, and others this design does not use.
- `participantJoined` payload: `meeting.id`, `meeting.sessionId`, `meeting.status`, `participant.peerId`, `participant.customParticipantId`, `participant.joinedAt`. `participantLeft` adds `participant.leftAt` and `meeting.endedAt`.
- Signature: header `rtk-signature`, Base64 RSA-SHA256 over the raw request body, verified with the public key at `https://api.realtime.cloudflare.com/.well-known/webhooks.json` (`data.publicKey`). Never re-serialize the JSON before verifying.
- Delivery: any 2xx is success; 5xx or a network error is retried; other non-2xx is recorded as failed and not retried. Duplicates are possible, so `rtk-uuid` (the delivery id) is for dedupe. Ordering is not documented. Retry count and timeout are not documented.
- Registration: `POST /accounts/{account}/realtime/kit/{app}/webhooks` with `name`, `url`, `events`, `enabled`.

Billing (Cloudflare docs)

- Participant minutes are billed from join to leave, $0.002 a minute for video after 10,000 free minutes a month. An invited participant who never joins costs nothing. A meeting that nobody has joined costs nothing. Each tab joined bills separately.

What the vendor cannot do

- No webhook carries camera on or off. The peer report is the only server-readable camera signal, as `realtimekit.ts` already records.

Codebase facts this design builds on

- `ensureMeeting` makes one meeting per (fixture, side) and stamps the row with the fixture's two entrant ids as read before the create. `meetingOnFile` calls the row the current pairing's when its stamp equals the fixture's entrants (`is not distinct from`), and `retireStaleMeeting` ends and deletes every row of a board whose stamp differs and has no game behind it. `ensureMeeting` refuses a fixture with a null entrant (`VIDEO_MEETING_UNPAIRED`), so today no row ever carries a null stamp. The nil UUID (`RETIRED_PAIR`) is the stamp `openRound` writes on a fresh window's old rooms to mean "belongs to no pairing, retire me". `addParticipant` makes the player's participant with `custom_participant_id` = the person's UUID. The participant id is stored in `fixture_video_participants`; the token is handed to the browser and never stored. A returning player gets a fresh token from `refreshParticipantToken` (1 call).
- The claim's token rule (`preflight.ts`, `verifyRequiredSeat`): a claim that has just minted its participant reads nothing (the F1 shortcut). Nobody held its token, so the answer is `camera_required`, and the mint's own token goes to the browser at no extra call. Every other claim that hands a token over (a seat, a refusal, a browser that holds none) pays `refreshParticipantToken`, 1 call. A claim from a browser that already holds the token, answered `camera_starting`, pays nothing.
- `seatCameraEvidence` costs 3 calls per read: active session, session participants, peer report. It costs 1 call when the player's meeting has no live session, because the active-session GET alone answers `absent`. The room re-asks on 1, 2, 4, 8, 8 seconds, at most 5 reads of a camera still starting (`CAMERA_EVIDENCE_MAX_POLLS`), then the seating read.
- The line (`seat-line.ts`) reserves `LINE_RESERVATION` = 21 calls per admitted stay: the mint (2), five reads of a starting camera (5 × 3), and the seating read with its token (3 + 1). It reserves `LINE_RECHECK_COST` = 3 for the opponent's re-verify at the create. `external-play-line-cost.test.ts` measures the realized stays at 6, 9, … 21.
- The arbiter (`arbiter.ts`, `arbiter-watch.ts`) watches one player's meeting at a time. Every open mints a fresh participant (1 call); every close kicks and deletes it (2 calls). A switch between boards or colors is a close then an open: 3 calls.
- The sweep (`sweep.ts`) tears a meeting down with a kick-all and a deactivate (2 calls per meeting) and, two minutes after the end, reads sessions, peers and peer reports for the post-match camera evidence (3 or more calls per player meeting).
- The budget and the line were built on Postgres on purpose: the repo's Redis limiter (`lib/rate-limit.ts`) is inert without `REDIS_URL` and fails open on a blip, which is wrong for a guard that must act exactly where the load test runs.
- Deployment: Fly.io, `min_machines_running=1`, up to 3 machines, Next.js standalone. The Cloudflare cron worker already fires every minute in production and runs the external-play sweep every five minutes with a 45-second pass budget.
- The check-in window exists only from the organizer's Open press. `openRound` stamps `stage_round_opens.opened_at` with the press's own clock; `windowFor` opens batch zero ten minutes before that stamp, which is already in the past at the press, and closes it ten minutes after. When cameras are on, a round's boards open in batches of ten, one every two minutes, so a club with more than ten boards is spread over time by design, while twenty clubs pressing Open together are not. A board's deadline is ten minutes after its batch's start (`DEADLINE_AFTER_MS`), and the line protects a player the budget is holding for five minutes past it (`LINE_DEADLINE_GRACE_MS`). Nothing about a window is knowable before the press, so no job can run "an hour before the window opens". What is knowable earlier is the pairing: a fixture with both entrants in a division that plays online with cameras.
- The Fly app sits behind Cloudflare's proxy on the zone. The cron worker sends a User-Agent because the zone's Browser Integrity Check challenges a request without one (`apps/cron-worker/src/call.ts`). A vendor webhook POST that the zone challenges is a non-5xx failure the vendor does not retry.
- The arbiter preset produces nothing and receives at most the two video streams a player meeting can hold (`arbiter-camera.ts`). The panel (`arbiter-panel.tsx`) watches one player's meeting at a time, and `arbiter-view.ts` holds the panel's types.

Owner facts (2026-11-05)

- Pairings exist ahead of the open for every round. Round 1 is paired before the scheduled date. The code agrees and adds a detail: Swiss shells and round-1 pairings both exist while the division is still `setup` (`swiss-boards.ts`). The first Generate mints shells for every round the organizer declared (`swiss-gen.ts`). The division becomes `active` only at the organizer's Start (`schedule/publish.ts`), which can come seconds before Open. The next round is paired from the time the previous one is paired or settled, so its pairings exist at the latest while the previous round is being played.
- A Swiss round's boards exist as placeholder fixture rows before the round is paired, so a board can be found, and its rooms made, before anyone knows who sits at it.
- No production round with cameras required is running now. There is nothing to shadow in production; the gate before the one-read proof is a staging run.
- The owner controls the Cloudflare zone in front of the Fly app and will add the webhook skip rule.
- The arbiter works on a laptop. The number of boards live on screen is a limit the owner sets by need, not a fixed number.

## 4. The design in one paragraph

A job makes a board's two rooms as soon as the board exists, placeholder or paired, in any division that plays online with cameras, started or not, nearest round first. It makes rooms only: each player's participant is added by the player's first claim, as today (owner ruling 2026-11-17, section 12). It is paced well under the refill and holds back while any check-in window is open. Boards and pairings both exist ahead of every round's open (section 3). So the normal round pays three calls per player at kickoff: the participant the first claim adds (its own token goes to the browser), one report read, and the token handed with the seat. A board paired or re-paired with less than the job's lead pays what is left of the mint at the seat, as today. The vendor's `participantJoined` and `participantLeft` webhooks keep a presence table current, so the seat knows the player's current peer without asking. The browser's own camera report, which it already sends, is the trigger to read; the vendor's peer report, one call, is the proof. The line's reservation is re-derived from the new costs, so it admits about two and a half times as many stays at once (21 against 8). The arbiter's panel shows every board's presence and camera state from the server's tables, at no vendor cost, and joins live video only for the boards on screen, up to a limit the organizer sets (that grid is superseded by Match Day §9, section 12); it keeps one participant per meeting for the life of the game, so a board costs one call on its first visit and nothing to leave or return. Post-match reads and teardown are paced, and deferred while any check-in window is open, for at most 30 minutes per room. Arbiter removals run first and are never capped or deferred. Everything shared stays in Postgres; Redis is reserved for the gate if a load test at 200 players shows lock contention.

## 5. Cost model

The "after" columns are named for what is on file when the round opens. "Room pre-minted" is the normal round. Boards exist before they are paired and pairings exist before the open (section 3). The job makes the rooms while the board is still a placeholder, or as soon as it is paired (section 6.1). It makes no participant: the first claim adds it (section 12). "Nothing on file" is the floor: a round opened before the job reached it, or a board re-paired after its rooms were stamped whose old rooms are already retired. Two flag states are priced: the one-read proof on (`EXTERNAL_PLAY_PRESENCE_PROOF`, rollout step 5) and off (pre-mint alone, rollout step 4).

How a stay's calls add up (from `preflight.ts`, section 3): the first claim, then the reads of a camera still starting, then the seating read and the token handed with the seat. Typical = first claim + 1 read + 1 token. Worst = first claim + 6 reads (5 of a starting camera, then the seating read) + 1 token. The first claim costs:

- Today, and "nothing on file": create the meeting and add the participant, 2 calls. The F1 shortcut reads nothing, and the add's own token goes to the browser.
- "Room pre-minted": add the participant, 1 call, with the same F1 shortcut: the claim minted, so it reads nothing, and the add's own token goes to the browser (`preflight.ts verifyRequiredSeat`: `minted !== null → camera_required`, then `minted ?? refreshParticipantToken`). This holds on either flag state.

A read costs 1 call with the proof flag on and 3 with it off. The opponent's re-verify at the create is one read.

Per player at check-in, proof flag on

| | Today | Room pre-minted | Nothing on file |
|---|---|---|---|
| First claim | 2 | 1 (add) | 2 |
| Camera evidence, per read | 3 | 1 | 1 |
| Reads, typical / worst | 1 / 6 | 1 / 6 | 1 / 6 |
| Token handed with the seat | 1 | 1 | 1 |
| Total, typical / worst | 6 / 21 | 3 / 8 | 4 / 9 |

Worked through for the worst room-pre-minted stay: 1 + 5 × 1 + 1 + 1 = 8. Today's worst stay: 2 + 5 × 3 + 3 + 1 = 21.

Per player at check-in, proof flag off (pre-mint alone)

| | Today | Room pre-minted | Nothing on file |
|---|---|---|---|
| First claim | 2 | 1 (add) | 2 |
| Total, typical / worst | 6 / 21 | 5 / 20 | 6 / 21 |

Per board at check-in: two players plus the opponent's re-verify at the create (1 call with the flag on, 3 with it off)

| Board, typical / worst | Today | Room pre-minted | Nothing on file |
|---|---|---|---|
| Proof flag on | 15 / 45 | 7 / 17 | 9 / 19 |
| Proof flag off | 15 / 45 | 13 / 43 | 15 / 45 |

A room from an earlier pairing: a board re-paired after its rooms were stamped for a pairing (by the job on a board already paired, or by a claim's adoption), whose old rooms the sweep's stale-room retire has not yet ended. The first claim to reach the board ends both old rooms through `retireStaleMeeting`, 2 calls each, then pays "nothing on file". That makes the board 13 / 23 with the flag on and 19 / 49 with it off. Today's reservation does not cover those 4 retire calls, and this design leaves them uncovered too.

Why the job stops at the room: a participant made ahead would save no call at the seat. The job would have to throw its token away, because tokens are never stored, so the first claim would buy one back with a refresh. That is the same single call the add costs, and with the proof flag off it adds the 1-call absent probe the F1 shortcut skips. The seat's savings come from the room (1 call per player) and from the one-read proof (2 calls per read). The participants step was dropped for that reason (section 12).

Twenty clubs, 100 boards, same minute, proof flag on

The bucket passes at most 300 + 2t calls in t seconds (`budget.ts`: a 300 burst plus (900 − 300) / 300 s = 2 a second). So C calls need at least (C − 300) / 2 seconds. That figure is the budget's floor on the clock, with the bucket full at the press and nothing else spending.

| | Today | Room pre-minted | Nothing on file |
|---|---|---|---|
| Typical | 1,500 | 700 | 900 |
| Worst | 4,500 | 1,700 | 1,900 |
| Budget in the first five minutes | 900 | 900 | 900 |
| Time to seat everyone, typical | 600 s, 10 min | 200 s, about 3.3 min | 300 s, 5 min |
| Time to seat everyone, worst | 2,100 s, 35 min | 700 s, about 11.7 min, the line holding the tail | 800 s, about 13.3 min, the line holding the tail |

With the proof flag off, a room-pre-minted round costs 1,300 / 4,300 (about 8.3 / 33.3 min), and a round with nothing on file costs what today's does (1,500 / 4,500).

The normal case fits one five-minute window. The worst case does not. In both "after" columns it still ends inside the board's cap: the ten-minute deadline plus the line's five-minute grace (section 3). Today's worst case does not. The "nothing on file" column is the floor this design guarantees. A second API user (section 8) doubles the burst and the refill, so the time becomes (C − 600) / 4 seconds: 75 s for 900 calls and about 5.4 min for 1,900.

Off-peak, per tournament. The first Generate makes every round's boards at once (section 3), so rooms are priced per tournament. The example is 100 boards a round over 7 rounds. The pace is 45 calls a pass: 1 a second in a 45-second pass a minute.

| Job | Calls | When |
|---|---|---|
| Pre-mint, rooms | 2 per board of every round on file: 1,400 | from the first Generate, nearest round first: about 4.5 min a round, about 31 min for all seven |
| Lead the next round needs | its rooms: 200 for 100 boards, 20 for 10 | about 4.5 min for 100 boards and about 20 s for 10, from the time its boards exist (or are paired, in a division still in setup), none of it while a check-in window is open (section 6.1) |
| Arbiter | 1 per meeting on its first visit by that organizer; 0 to leave or return | during play |
| Teardown | 4 per board | sweep, after the result |
| Post-match evidence | about 6 per board, as today (`listPeerIds` stays, section 6.6) | sweep, two minutes after the end, off-peak |

The job makes no participants (section 12). Making them would cost 2 calls per paired board, 200 a round for 100 boards, and save none at the seat.

## 6. Parts

### 6.1 Pre-mint job

What: rooms, for boards of a division that plays online with a camera policy other than off, whose round is not yet opened and whose fixture is playable. The division may be started, or still in `setup` or `scheduled` once it has pairings. Swiss round 1 is paired before Start (section 3), so a job limited to started divisions would reach round 1 only between Start and Open, which can be seconds apart. The job therefore cannot reuse `onlinePlayBoardWhere`, which excludes `setup` and `scheduled`. It carries its own division filter.

For every such board, paired or placeholder, make the meeting for each side exactly as `ensureMeeting` does today, and stamp the row with the fixture's entrants as they are at that moment: the pairing when there is one, and otherwise an unadopted stamp (my call: null in both entrant columns, a state today's code never writes). One call per side, 2 per board. An empty room costs nothing however long it waits.

The job makes no participant (owner ruling 2026-11-17, section 12). A participant made ahead carries no token, so the seat would pay a refresh in place of the add, one call for one (section 5). The player's first claim adds the participant exactly as `addParticipant` does today, and the add's own token goes to the browser.

The job is idempotent: a side with any room on file is skipped, and a room stamped with an old pairing goes through the existing retire path.

The stamp rule gains one state. Today a row's stamp is the pairing it was made for, or the nil UUID for a room the re-open has already written off. An unadopted stamp means "made for this board's first pairing, whichever it is". `meetingOnFile` treats an unadopted row as the current pairing's once adopted, never as stale, and `retireStaleMeeting` never selects an unadopted row. Adoption has one writer: the claim. The first claim to reach a paired board whose room is unadopted writes the pairing onto its stamp (one statement, no vendor call) inside `ensureMeeting`. The job never adopts. A placeholder that is never paired, a bye or an odd board, keeps an empty room that costs nothing and that the sweep's teardown ends after the round's deadline, 2 calls, so no room outlives its round.

Trigger and lead: the board's existence (in a division still in `setup` or `scheduled`, its pairing), never the window, because the window does not exist before the organizer's press (section 3). Round 1 is paired before the scheduled date, while the division is still in `setup`, and the job covers such divisions, so the job has days. A later round's placeholders exist while the previous round is current, so its rooms can be made then. At 1 call a second inside a 45-second pass every minute, a round of 100 boards needs about four and a half minutes for its rooms, and a round of 10 boards about 20 seconds. Every board's participants are made at the seat. A board whose rooms the job has not reached when its round opens pays 1 call more per player at the first claim, and the "nothing on file" column of section 5 is its floor.

Order: candidates are taken by imminence. The lowest unopened round of each division comes first. Later rounds come after. The first Generate mints shells for every round at once (section 3). Without this order, round 1's rooms could queue behind six later rounds' rooms, about 27 minutes of work at the job's pace for 100 boards a round.

Re-pairs: a re-pair while a board's rooms are unadopted changes nothing, because an unadopted room belongs to whichever pairing comes first, and the claim adopts it. A room the job stamped for a pairing (the board was already paired when the job reached it), or one a claim adopted, belongs to that pairing. A re-pair after that is handled by the retire path that already exists (`retireStaleMeeting`): the old rooms are ended (2 calls each) by the sweep's stale-room retire or, if it has not reached them, by the first claim (section 5, "a room from an earlier pairing"), and new rooms are made. No participant is re-made for a re-pair, because the job makes none. The job never touches a board whose round is already opened; the seat owns those.

Pacing: at most 1 call a second per pass, so a club checking in at the same time keeps the other half of the refill. The job spends through the same budget as everything else and treats a deferral as "next pass". It also holds back entirely while any board on the platform has a check-in window open, as the sweep's post-match work does (section 6.6), so it never spends refill during someone's kickoff. That deferral needs no ceiling, because holding the job back is always safe: a board it has not reached falls to the "nothing on file" floor and is finished at the seat.

Where it runs: a new cron job in `apps/cron-worker/src/schedule.ts` every minute, hitting a new route beside the sweep's, with its own pass budget. The pass reads candidates, mints up to its budget, and stops. The sweep's existing teardown and retire passes are unchanged.

Observability: a per-pass report (minted, skipped, deferred, failed) in the log, as the sweep reports.

What it changes elsewhere: `ensureMeeting` at seat time becomes a read in the common case, plus the adoption statement when the room is unadopted (no vendor call). The first claim still adds the participant, so the F1 shortcut (section 3) still fires: it reads nothing, and the add's own token goes to the browser. Section 5 prices this. Nothing else at the seat changes.

### 6.2 Webhook receiver and presence table

Route: `POST /api/webhooks/realtimekit`. Public, unauthenticated except by the vendor's signature.

Verification: read the raw body bytes; verify `rtk-signature` with the published public key, imported as SPKI RSASSA-PKCS1-v1_5 SHA-256; cache the key in process and refresh it once a day. On a verification failure, refetch it before refusing, but at most once a minute per process (`WEBHOOK_KEY_REFETCH_MIN_MS` = 60 s, plan 1). The route is public, so without that floor any POST with a bad signature would make the server fetch the key. That would amplify requests and could get our egress throttled by the key host exactly when a real rotation needs the refetch. Answer 401 on failure. The route is rate-limited only to the extent that a signature check is cheap.

Dedupe: a `realtimekit_webhook_deliveries` table with `rtk_uuid` as a unique key; the event is applied and the delivery recorded in one transaction, so a repeat is a no-op and still answers 200. No Redis is needed for this.

Presence: a `fixture_video_presence` table keyed by (`meeting_id`, `peer_id`) with `participant_id`, `session_id`, `joined_at`, `left_at`, `received_at`. `participant_id` is resolved from `customParticipantId` (the person UUID) and `meeting.id` through `fixture_video_participants`; an event for a participant nobody has on file is recorded with a null participant and logged, never dropped.

Ordering: `joined_at` and `left_at` come from the payload, never from receipt time. A `participantLeft` for a peer not yet seen inserts the row with both stamps from the payload. A `participantJoined` that arrives after its own `participantLeft` leaves `left_at` as it is. The current peer of a participant is the row with the latest `joined_at` and a null `left_at`, the same rule `currentPeer` applies to the vendor's session list today.

Answering: 200 only after the transaction commits; 500 on any storage failure so the vendor retries. Subscribe to `meeting.participantJoined`, `meeting.participantLeft` and `meeting.ended` (the last to stamp a session's end for the post-match job).

Registration: once per environment, by a script against the registration endpoint, with the URL per environment. Staging gets its own webhook.

Zone prerequisite: the Cloudflare zone in front of the Fly app must let `POST /api/webhooks/realtimekit` through without a challenge. A WAF skip rule for that path, scoped to POST, is added before shadow mode, and delivery is proven on staging by a real join before the week's comparison starts. This is an infrastructure change outside the repo and is the first item of the rollout.

Test fixture: the load test and the e2e suite run against a fixture vendor (`REALTIMEKIT_BASE_URL` not Cloudflare's, `apps/web/e2e/realtimekit-fixture-server.ts`). That fixture must emit `participantJoined`, `participantLeft` and `meeting.ended` to the app under test, signed with a key pair it makes at start and publishes at its own `/.well-known/webhooks.json`, so the seat exercises the one-read path and the line-cost test prices the new reservation against real behavior. The verifier reads the key from Cloudflare's published URL when the base URL is Cloudflare's and from the base URL's own origin otherwise, the same gate `cfEnvelope` uses for metering, so production can never be pointed at a test key and no key is stored or configured anywhere. A vitest suite delivers the fixture's webhooks in process, straight to the receiver; the e2e run delivers them over HTTP to the server under test. Extending the fixture is a work item of this design, not a follow-up.

### 6.3 The seat with one-read proof

`seatCameraEvidence` is split in two.

Presence (0 calls): from `fixture_video_presence`. No current peer means `absent`, with no vendor call, until the join lands.

Proof (1 call): `GET /sessions/peer-report/{peerId}` for the current peer, read exactly as today into `on`, `off`, `blocked`, `starting`, `unreadable`, with one guard added. A report whose `participant.left_at` is set answers `absent`, whatever its events say.

Why the guard: today's read finds the current peer in the vendor's session list, filtered on `left_at` null and PEER_LEAVING. The one-read proof takes it from the presence table instead, and a webhook-fed table can hold a peer that has gone. A `participantLeft` can be lost (a non-5xx failure is not retried) or arrive late (ordering is not documented). On a reload, a claim can also land before the old peer's leave. Either way the departed peer stays current. `cameraFromReport` reads only the events, so that peer's final report can still end in `video_on` and seat a player who has left, or pass T9's re-verify. The peer report carries the participant's `joined_at` and `left_at`: the post-match evidence already parses them (`videoOffCoverage`, `realtimekit.ts`), and the fixture vendor serves them in the same body. So the guard costs no call. A test pins it: presence row open, report with `left_at` set, the seat is not granted. The guard is mutated once.

What is not measured: how soon the real vendor sets `left_at` after a tab closes. The post-match code notes that a report is final about 70 seconds after the leave, and it may carry `left_at` only by then. The real-vendor staging run (section 6.8, step 3) measures the time from leave to `left_at`. If that time is longer than the first read's 1.5 seconds, the cheapest sound alternative is today's own filter. The proof adds the session-participants read (1 call, with the session id taken from the presence row, so no active-session read) and keeps only a row with `left_at` null and no PEER_LEAVING. That makes the proof 2 calls, and section 5's per-read figure rises from 1 to 2. The step-5 flag is not turned on until that measurement has been made.

Trigger: the browser already reports its own camera state to the server (the D16 heartbeat). The seat reads the vendor's report only once presence shows a current peer. The first read is scheduled 1.5 seconds after `joined_at` (the measured 1.4 seconds for `media_permission` to appear), or at once if the browser's report already says the camera is on. The re-ask schedule and `CAMERA_EVIDENCE_MAX_POLLS` are unchanged; each re-ask is now one call.

Fallback: if presence shows no current peer and more than `PRESENCE_FALLBACK_MS` (my call: 10 seconds) has passed since the fallback clock started, the seat uses today's three-call read, logs the fallback with the meeting id, and counts it. A fallback rate above a threshold is the alert that webhooks have stopped. Presence rows written by the fallback carry a `source` of `read` so the two can be told apart.

The fallback clock starts at the later of two stamps: the browser's first `live` camera report for this seat, and the participant's last `left_at` on file in the presence table. The report carries no join time, so its own receipt stamp is the clock. Without the second stamp, a reload in the middle of check-in would trip the fallback at once. The first stamp is never re-stamped, and the stored `live` report stays fresh for 75 seconds (`CAMERA_REPORT_STALE_MS`). So the reload's first claim would see the old peer's leave on file, no join yet for the new peer, and a clock already past 10 seconds. It would take the three-call read and count a webhook outage that did not happen (section 6.7).

The opponent's re-verify at the create uses the same path: 1 call, 3 on fallback.

### 6.4 Budget and line re-derived

The bucket's constants stay (300 burst, 2 a second, 900 a window) for the first build. They are retuned only from a load test.

The mint term becomes the stay's first-claim cost (section 5): 1 for a room-pre-minted stay (the add, whose own token goes to the browser) and 2 for a stay with nothing on file, on either flag state. `LINE_READ_CALLS` becomes 1 with the proof flag on and stays 3 with it off. `LINE_TOKEN_CALLS` stays 1. `LINE_RECHECK_COST` is one read: 1 on, 3 off. The reservation is derived as today: first claim + `CAMERA_EVIDENCE_MAX_POLLS` reads + (the seating read + the token). With the proof flag on, a room-pre-minted stay reserves 1 + 5 + 2 = 8 and a stay with nothing on file 2 + 5 + 2 = 9. With the flag off, a room-pre-minted stay reserves 1 + 15 + 4 = 20 and a stay with nothing on file 2 + 15 + 4 = 21. A stay has nothing on file when its round opened before the job reached its board. A stay that meets a room from an earlier pairing (section 5) is priced as nothing on file, 9 on and 21 off; the 4 calls that retire the old rooms stay outside the reservation, as today. (Plan 2 keeps a third kind for a stay whose participant an earlier claim of a restarted stay already made: its first claim is a refresh, plus today's absent probe with the flag off, priced 8 on and 21 off. The job never produces it.) The price is stamped on the stay at each claim, the pool sums the stamped prices, and the estimate prices the places ahead at their own stamps rather than at one constant. A fallback read (section 6.3) costs 2 more than a stay reserved; that overspend is uncovered on purpose, like the dead-camera re-claims today, and the fallback counter is what shows it. The ETA formula in `lineWire` keeps its shape and prices places ahead at the reservation in force.

`seat-ask-limit.ts` is unchanged: its numbers bound asks, not calls.

### 6.5 Arbiter: every board's state, live video for the boards on screen

Target: a laptop. A phone keeps today's single-board view (my call; the panel already has it).

State for every board, 0 calls: the panel lists every board of the round with, per side, present or absent from `fixture_video_presence`, and camera on, off or starting from the player's own last camera report, which the server already holds for the opponent's pill. A side whose player left shows the time of the leave. This is a server read of two tables, pushed on change over the Realtime channel the room already uses. No vendor call and no video stream.

Live video for the boards on screen (superseded by Match Day §9, section 12; not built): the panel joins only the meetings whose tiles are in view, one receive-only client per meeting, both sides of a board together, up to a limit of boards. The limit is the arbiter's own, kept in their browser, under a platform ceiling (my call: default 6 boards, 12 streams; the spike in section 6.8 sets the ceiling). It is the machine's limit, so it lives with the machine and needs no schema. Scrolling swaps which meetings are live: a tile leaving the view leaves its meeting with the SDK and a tile entering joins. A small tile asks for the low-resolution layer; clicking a board enlarges it and takes the full stream. The serial chain in `arbiter-watch.ts` becomes one chain per meeting, so a slow join on one board never holds the others.

Participant lifetime: one arbiter participant per (organizer, meeting) for the life of the game. The join route returns the existing participant with a fresh token when one is on file and not removed (1 call, `refreshParticipantToken`), and mints one only on the first visit (1 call). The browser keeps tokens in memory for the page's life, so a tile that scrolls back into view costs no call. Close is the SDK leave only; the DELETE route stays for explicit revocation and the sweep's role-removed pass. The meeting's teardown kick-all and deactivate already end every arbiter participant at the result.

Joins yield to players: an arbiter join takes its token only while the bucket holds a floor above the line's reserved calls (my call: 60 calls), and otherwise waits on the panel's existing backoff with the tile showing "waiting for capacity". Twenty arbiters opening panels at kickoff cannot starve check-in.

Billing and machine load: the arbiter is a participant in every meeting on screen, so a club's participant minutes double while its boards are watched: six boards on screen is about $1.44 an hour at the vendor's video rate. Each live stream is one decoder and about 1 to 2 Mbps down; twelve streams is within a laptop, which is why the limit exists and why a phone keeps one board.

Why: today a switch between boards costs 3 calls, and an organizer checking ten boards in both colors spends 60. With the change it is at most 1 per side per board, 20, and 0 to leave or return. The rule this replaces (I2, "every open mints a fresh participant") existed because a token lasts 100 days and a refresh does not revoke the old one. Exposure is now bounded by the meeting, which is deactivated at the result, and by the sweep's removal when the role is gone.

Refusal with pre-minted rooms: `joinAsArbiter` refuses with `VIDEO_MEETING_NOT_STARTED` until the player's first `participantJoined` is on file, not merely until a meeting row exists, so an arbiter is never minted into an empty room and billed for watching nobody. That rule follows the one-read proof's flag: while the presence table is still in shadow mode the join refuses on today's rule, so a club is never locked out of watching by a table nothing reads yet. A tile for such a side shows the state from the table and no video. The join's floor is measured on the line's pool, the bucket's level less the admitted stays' reservations, never on the raw level, so an arbiter cannot take a token the line has already promised to a player.

### 6.6 Post-match evidence and teardown

Both stay in the sweep. Three changes.

Arbiter removals run first. A removal is due when the watch's user is gone, is no longer an owner or admin, now plays on the board (C1's safeguarding rule), or holds a watch past the three-hour TTL. These removals run at the start of each pass, before the teardown, and they are exempt from both the cap and the deferral below. Today's sweep runs them last, after teardown and the post-match reads. Under a shared cap, an off-peak backlog would starve them for many passes, while section 6.5 hands that watch's token out again on every visit. A watch whose meeting has already ended needs no vendor call (it is only stamped) and can stay after the teardown, as today. A test pins the order: a backlog of N teardowns plus one role-removed watch, and the watch is removed in the first pass.

The other two vendor jobs, teardown and the post-match reads, share a cap of one call per second of the pass budget, 45 calls a pass. That drains a hundred finished boards over about two hours off-peak. A pass also skips the post-match reads and the end-of-game teardown while any board on the platform has a check-in window open. The deferral has a ceiling: a room is held back for at most 30 minutes after it became due, and after that the pass takes it under the cap even while a window is open. With staggered batches across many clubs, "any window open" can stay true for hours. Without a ceiling, finished games' rooms would stay active, players' tokens would stay valid, and the evidence would wait indefinitely. The stale-room retire and the parked-room end are exempt from the deferral: they end rooms an old pairing left live, and a token must not stay valid in one of those for the length of someone else's window.

The post-match job keeps today's vendor peer list (`listPeerIds`, 1 call per session) as the source of every peer id. The presence table is not its source. A lost `participantJoined` for a reconnect would drop that peer's coverage from the union and read time with the camera on as off. A list nobody can prove complete is `not_ready`, never the negative answer (ruling I2), and presence alone cannot prove the list complete. Sessions, the peer list and reports are all read from the vendor, off-peak, under the cap and the deferral, because the vendor's report is the evidence.

### 6.7 Page refresh, in each role

A player mid-check-in: the vendor sends `participantLeft` for the old peer and `participantJoined` for the new; the seat's next ask costs 1 token refresh and 1 report read. The fallback clock restarts at the old peer's `left_at` (section 6.3), so the reload does not trip the fallback, and a report of the departed peer answers `absent`.

A seated player: 1 token refresh; the seat and game are on file; no new proof.

An arbiter: 1 token refresh per meeting on screen after the reload, since the page's tokens are gone; the board list itself costs nothing; no proof.

The per-seat ask limit still bounds a reload storm.

### 6.8 Rollout

0. Zone skip rule for the webhook path (the owner's, outside the repo), webhook registered on staging, and a real join on staging seen to arrive at the receiver.
1. Fixture vendor extended to emit signed webhooks (section 6.2), so every later step can be exercised in the suites.
2. Load run at 200 players with the existing harness (`REALTIMEKIT_METER_ANY_BASE=1` against the fixture vendor) on today's code, recording calls per board, time to seat p50 and p95, `lockWaitMs` p95 and the busy count. This is the baseline every later step is measured against, and it comes first because there is no production camera round to shadow.
3. Webhook receiver and presence table in shadow mode: events recorded, the seat still reads as today. The gate for step 5 is a staging run against real Cloudflare RealtimeKit with the webhook registered. It is not the fixture vendor, which emits webhooks from the same state its reads answer, so the two agree by construction and a fixture on both ends proves only the fixture. The run makes N real joins with reloads, leaves and tab closes. `presence-shadow-report --strict` compares presence's current peer with the current peer today's read found, read by read. The run reports the join-to-webhook latency at p50 and p95, against the 1.5-second first read and the 10-second fallback, and the time from a leave to the report's `left_at` (section 6.3). It confirms that the webhook's `peerId` is the peer id the peer report takes, and that `customParticipantId` echoes our subject.
4. Pre-mint job (rooms only) behind `EXTERNAL_PLAY_PREMINT`, on staging first, then production.
5. One-read proof behind `EXTERNAL_PLAY_PRESENCE_PROOF`, with the fallback and its counter live from day one. Gate condition (owner ruling 2026-11-17): a non-zero `closedByEnded` from the step-3 staging run (presence rows that only `meeting.ended` closed, because the vendor never reported the peer leaving) blocks turning the flag on, on staging or production, until every one is explained and the explanation is recorded beside the baseline. Plan 1 Task 12 step 5 defines the condition; plan 2 points at it.
6. Arbiter participant lifetime.
7. (Superseded by Match Day §9, section 12; not run.) Arbiter grid spike: a throwaway page joining ten meetings from one tab on a laptop, recording CPU, bandwidth and whether the SDK allows that many clients in one page. Its numbers set the platform ceiling. Then the grid behind `EXTERNAL_PLAY_ARBITER_GRID`.
8. The step 2 run repeated on the finished build and compared with the baseline. Its `lockWaitMs` and busy count decide section 7.

## 7. Where Redis or Upstash fits

Not in the first build. The budget and the line stay in Postgres for the reason they were built there: the Redis limiter is inert without `REDIS_URL` and fails open, and a guard against a platform-wide outage cannot be absent exactly where the load test and the e2e suite run.

The gate moves to a Redis Lua script when the load run in 6.8 step 8 shows `lockWaitMs` p95 above 200 ms or any `SeatLineBusy` at 200 players. The script would take the token, place the stay and admit it in one atomic step; the bucket and the line would move together, and the e2e suite would then need a Redis. That is a second design.

Upstash QStash may replace the cron worker as the scheduler for the pre-mint job and for the Lichess create retry. It is optional, because the worker already fires every minute.

## 8. More API users

The budget key is already the vendor host plus the account id. Adding the token's identity to the key and letting `cfEnvelope` choose the token whose bucket has the most room gives N times the budget, up to RealtimeKit's 3,500. Build only after Cloudflare confirms the per-user limits are independent for account members. Until then this design does not count on it.

## 9. Passing fixes

`creation-queue.ts` says queue wait time counts against the caller's claim; `create-game.ts` takes the claim at dequeue precisely so it does not. The comment is corrected to say the queue never waits because the check-in request awaits the create.

## 10. What is left to the builder

- Table definitions, migration numbering, the sealed-table policy for the two new tables (the pattern is `fixture_video_meetings`).
- The exact cron route names and pass budgets. The pre-mint job rides the production worker's one-minute trigger and staging's five-minute one.
- Key caching for the webhook public key and its refresh.
- Resolving a webhook's `customParticipantId` for an arbiter, whose subject is a user id and a nonce rather than a person UUID.
- The stay's stamped reservation (proof flag on: 8 room pre-minted, 9 nothing on file or a room from an earlier pairing; flag off: 20, 21) and the sum of the places ahead reach `reservedSql` and the estimate through the seat-line module alone, so its one-reader guard keeps holding.
- Whether `fixture_video_meetings.home_entrant_id` and `away_entrant_id` can be made nullable for the unadopted stamp, or a second sentinel UUID is needed beside `RETIRED_PAIR`; and the adoption statement the claim runs (the job never adopts).
- The sweep's teardown select must take an unadopted room of a board that was never paired once its round's deadline has passed.
- The source guard that pins `camera_reported` to two files needs the seat's trigger added to its allow-list.
- The arbiter TTL pass in the sweep (job 6, three hours) stays as it is; the design only changes who mints and when the DELETE is sent.
- (Superseded by Match Day §9, section 12.) The browser-held board limit's key and control, and how the platform ceiling is declared once.
- (Superseded by Match Day §9, section 12.) The grid's tile layout, how "in view" is decided, and the SDK calls for the low-resolution layer; the spike answers whether one page can hold a dozen receive-only clients.
- The per-meeting chain that replaces the single serial chain in `arbiter-watch.ts`, and its release when a tile leaves the view.
- Test strategy: the presence rule has a pure core (current peer from a list of rows) that gets a property test; the webhook route gets a signed-fixture test; the seat's trigger and fallback get the virtual-clock treatment the queue tests use.
- The shape of the shadow-mode comparison report.
- The pre-mint job's own division filter (started, or `setup`/`scheduled` with pairings) and its imminence order.
- How the sweep records when a room became due, for the 30-minute deferral ceiling.

## 11. Calls I made

- Pre-mint makes rooms only, when the board exists (in a division still in setup, when it is paired), paced at 1 call a second. Participants are added at the first claim (owner ruling 2026-11-17, section 12).
- The unadopted stamp is null in both entrant columns, distinct from the nil UUID the re-open writes, because the two mean opposite things: "take the first pairing" and "take none".
- A re-pair after a room is stamped for a pairing goes through today's retire path rather than re-stamping the kept room, because the retire path exists.
- With no production camera round to shadow, the staging load run against the fixture vendor is the baseline (step 2) and comes before the receiver. The gate for the one-read proof (step 3) is a separate staging run against real Cloudflare RealtimeKit.
- (Superseded by Match Day §9, section 12.) Arbiter grid: laptop only, a phone keeps one board; default limit 6 boards, held in the arbiter's browser, with a platform ceiling from the spike; joins hold a 60-call floor for the line; one chain per meeting.
- A re-open spares un-ended rooms made for the board's current pairing, adopted or not, and retires only an earlier pairing's; the first open never retires. An ended current-pairing room is never spared: `retireBoardsMeetings` also serves the D17 re-arm, which exists to drop a current-pairing room the sweep ended at the No result, and a spared ended row would make `ensureMeeting` refuse with VIDEO_MEETING_ENDED for ever. A re-arm test pins it: an ended current-pairing room, then the replay's check-in, makes a new room.
- The line prices an unminted stay at 9 under the one-read proof, not at today's 21, and the fallback's extra calls are uncovered overspend.
- The fixture publishes its webhook key at its own well-known URL; no key is stored, configured or committed.
- The sweep's vendor cap is 45 calls a pass, one a second over the pass budget.
- The fixture vendor's webhook emission and the test-key override are in scope.
- Presence and dedupe in Postgres, not Redis.
- First report read at 1.5 seconds after the join; fallback to the three-call read at 10 seconds without a webhook.
- Arbiter participant kept for the game's life, with the DELETE route kept for revocation.
- Post-match and teardown deferred while any check-in window is open platform-wide, for at most 30 minutes per room; arbiter removals never deferred or capped; the pre-mint job holds back while any window is open.
- Bucket constants unchanged until the load test.

## 12. Amended 2026-11-17 (owner rulings, after re-pinning the plans against main 59c72dd361)

- §6.5 refusal while the one-read proof flag is off: "today's rule" (a meeting row for the current pairing) no longer suffices, because the pre-mint job makes that row before anyone joins. With the proof flag off, an arbiter join is refused until the player has actually checked in. With it on, the presence rule stands.
- §6.3 fallback clock: it starts at the seat's FIRST live camera report, stored once per stay; the 30-second heartbeat does not re-stamp it. Amended by review finding 11 (below): the clock starts at the later of that first report and the participant's last `left_at` on file.
- §6.5 DELETE route: kept for explicit revocation only; it refuses a request without a revocation intent, so it cannot serve as a browser leave.
- Arbiter participant insert: only a unique violation on the live-arbiter index counts as a racing tab; any other unique violation is an error.
- The pre-mint cron row runs before the sweep in the same firing; the sweep and email outbox may start up to 45 seconds later while pre-mint has work.
- `sweep.ts` (1,504 lines) is split by a pure move before plan 2, as its own PR.
- Order: capacity plan 1 → plan 2 (split first) → plan 3 tasks 1–3 → Match Day plan → plan 3 task 7.

Owner rulings 2026-11-17, on the design review's recommendations:

- R1 Cost model (§1, §3, §5, §6.1, §6.4). A pre-minted participant hands no token, so its first claim pays a refresh (`preflight.ts`: the F1 shortcut fires only for a claim that minted). True figures per stay, per player and per board for both flag states, derived in §5. With the proof flag on: pre-minted 3 / 8 per player and 7 / 17 per board; room only the same; nothing on file 4 / 9 and 9 / 19. With the flag off: pre-minted 6 / 21 and 15 / 45 (no saving), room only 5 / 20 and 13 / 43, nothing on file 6 / 21 and 15 / 45. A room from an earlier pairing adds 4 retire calls per board, outside the reservation as today. Reservations: 8 / 8 / 9 with the flag on, 21 / 20 / 21 with it off.
- R2 Time to seat (§1, §2, §5). Recomputed from `budget.ts`: C calls need at least (C − 300) / 2 seconds. 100 boards pre-minted: 700 calls, about 3.3 min, inside one window. Worst case 1,700, about 11.7 min, not one window, ending inside the deadline plus the line's grace.
- R3 Round-1 lead (§3, §6.1, §5 off-peak). The pre-mint job also covers divisions still in `setup` (or `scheduled`) whose pairings exist, because Swiss round 1 is paired at setup (`swiss-boards.ts`). It takes the nearest unopened round first, rooms before participants, and it holds back while any check-in window is open, like the sweep. Off-peak work is priced per tournament.
- R4 Departed peer (§6.3, §6.7). The proof read answers `absent` when the peer report's `participant.left_at` is set. The report carries it: `videoOffCoverage` parses it, and the fixture serves it. The real vendor's leave-to-`left_at` delay is measured in the step-3 staging run. If it is too slow, the proof adds today's session-participants filter (1 call, the session id from presence), making the proof 2 calls.
- R5 Revocations (§4, §6.6, §11). Arbiter removals run first in the sweep, including safeguarding (C1) and role-removed. They are exempt from the 45-call cap and the open-window deferral.
- R6 Post-match evidence (§5, §6.6). It keeps today's vendor peer list (`listPeerIds`) as its source; the presence table is not its source. It runs off-peak.
- R7 Rollout gate (§6.8 step 3, §11). The gate is a staging run against real Cloudflare RealtimeKit with the webhook registered, not the fixture vendor compared with itself.
- Live-video grid superseded (review finding 9). The §6.5 live-video grid, §6.8 step 7 (the spike and `EXTERNAL_PLAY_ARBITER_GRID`), the grid items of §10 and the grid call of §11 are superseded by Match Day §9 and are not built. Plan 3 tasks 4–6 are dropped, as the order above already says.
- The plans follow these figures. Plan 2's `lineReservation("none", 1) = 7` becomes 8, and its flag-off pre-minted price of 19 becomes 21. (The R1 and R3 bullets above still name the pre-minted participant; the second set of rulings below drops it.)

Review findings 2026-11-17 applied: 12 of 12 (7 major, 5 minor). None skipped.

Owner rulings 2026-11-17 (2) ("apply both rec"):

- The pre-mint job makes rooms only (§4, §5, §6.1, §6.4, §6.8 step 4, §10, §11). The job keeps everything about rooms: placeholder or paired boards, the unadopted stamp, nearest round first, setup divisions with pairings, and the deferral while any check-in window is open. Its second step, making each player's participant once the board is paired, is removed. The reason: a pre-minted participant carries no token, because tokens are never stored, so the seat pays a refresh that replaces the add one for one. That saves nothing at the seat, and with the proof flag off it costs one call more. Dropping the step saves about 200 off-peak calls per 100 boards a round and removes the participant churn on a re-pair. Adoption of an unadopted room now happens only at the claim (`ensureMeeting`'s one adoption statement). The job never adopts, because nothing it does needs an adopted room. The prices become: room pre-minted 8 with the proof flag on and 20 with it off; nothing on file 9 / 21; a room from an earlier pairing 9 / 21, with its +4 retire calls outside the reservation. Per board: 7 / 17 and 13 / 43 for room pre-minted. The design-review note that left this step to the owner to revisit is closed by this ruling.
- `closedByEnded` gates the one-read proof (§6.8 step 5). A non-zero `closedByEnded` at the staging gate (plan 1 Task 12 step 5) blocks turning `EXTERNAL_PLAY_PRESENCE_PROOF` on until every closure it counts is explained and the explanation is recorded. The reason: the departed-peer guard (§6.3) reads the report's `left_at` when a leave was lost. A vendor that does not report leaves makes that counted fallback, and its cost, routine. Plan 1 defines the condition and plan 2 points at it. It is no longer an open item.
