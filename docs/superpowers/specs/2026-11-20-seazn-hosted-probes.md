# Seazn-hosted video: Cloudflare and Bunny probes

Plan: `docs/superpowers/plans/2026-11-20-seazn-hosted-video.md`. Spec: `docs/superpowers/specs/2026-11-20-seazn-hosted-video-design.md`.
Cite results by ID: C1–C6 and B1–B6 from the POC, C7–C9 for Task 7, B7–B10 for Task 20.

## POC results (2026-11-20), copied from the plan

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
- **B2. Encoding.** 200 s of video encoded in about 2.5 min; video statuses seen 2 → 3 → 4. The library's resolutions are capped at **720p** (owner setting): nothing may assume a 1080p replay. (B9, 2026-11-21: not so on the Bunny POC library, where a 1080p source encoded to 1080p.)
- **B3. Security (owner turned on):** Block direct url file access (referrer allow-list), Embed view token authentication, CDN token authentication. One library token key signs both tokens.
- **B4. Embed.** With no or a bad token the embed shows an error page. With `token = hex(sha256(tokenKey + videoGuid + expires))` at `https://iframe.mediadelivery.net/embed/{libraryId}/{guid}?token=…&expires=…` it plays. Plan decision: **replays play in Bunny's embed player (iframe) with this token; live stays hls.js on Cloudflare.** The spec preferred one player for both, but direct Bunny HLS needs an allowed `Referer` and a per-path CDN token on every request, which the embed carries for us.
- **B5. Direct files** need BOTH an allowed `Referer` AND a CDN token: `https://{cdn}/bcdn_token={t}&expires={e}&token_path=%2F{guid}%2F/{guid}/playlist.m3u8`, `t = base64url-no-pad(sha256(tokenKey + "/{guid}/" + expires + "token_path=/{guid}/"))` (a plain sha256, not an HMAC). So an organiser's download goes through our server (Task 26).
- **B6. Webhook.** Per library. Body `VideoLibraryId`, `VideoGuid`, `Status`, `EventId` (dedupe on it), `Timestamp`. Webhook statuses: 3 Finished, 4 Resolution finished (playable), 5 Failed. These are NOT the video API's statuses (B2, Task 21), where 3 is transcoding. Header `X-BunnyStream-Signature` = lowercase hex HMAC-SHA256 of the raw body keyed with the library's Read-Only API key; `X-BunnyStream-Signature-Version: v1`; `X-BunnyStream-Signature-Algorithm: hmac-sha256`. Retries at 30 s, 2 m, 10 m, 30 m, 1 h, 2 h, then dropped. Plan: a webhook route (Task 27) is the primary signal; the tick's poll every 15 min is the backstop.

Still open, and probed in Tasks 7 and 20: whether a lock set on an in-progress recording survives its end and leaves the live HLS playing; whether a `PUT` of `recording` keeps `requireSignedURLs`; whether the token's `exp` is honoured; collection create and fetch into a collection; whether an embed keeps playing past its token's `expires`; the MP4 fallback's file name at the 720p cap; and the analytics keys (Task 30).

## Task 7: Cloudflare, what remained open

Probe: `apps/web/src/server/relay/__tests__/cf-signed-live.live.test.ts`, gated on `CF_LIVE_PROBE=1` plus
`CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_STREAM_TOKEN`. Run:
`cd apps/web && DATABASE_URL= CF_LIVE_PROBE=1 npx vitest run src/server/relay/__tests__/cf-signed-live.live.test.ts`
(the empty `DATABASE_URL` is needed locally: `vitest.config.ts` refuses a dev-database URL from `.env.local`, and the probe uses no database).
It creates one input with `recording: { mode: "automatic", requireSignedURLs: true, allowedOrigins: ["seazn.club"], timeoutSeconds: 180 }`,
publishes an ffmpeg test feed (lavfi testsrc + sine, at most 300 s) to its RTMPS URL, and deletes only the input and the
one recording it created, each by the uid it captured (C6). It prints an `OBSERVED` line with every value below and a
`LEDGER` line with the uids created and deleted.
The stream key is passed to ffmpeg as argv, so it is visible to local `ps` on the machine running the probe for the
feed's duration (it never reaches a log, the report or a commit).

**Status (2026-11-21): NOT RUN.** The run was held before any Cloudflare write: the only Cloudflare account the local
credentials can reach is the one account staging AND production share (`seazn-club-stg` and `seazn-club-prod` carry
identical `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_STREAM_TOKEN` secret digests on Fly, 2026-11-21). There is no
staging-only Cloudflare account, so the "staging account only" condition the run was cleared under cannot be met as
written. The owner rules on whether the probe may run on the shared account (it only creates, touches and deletes its
own input and recording by uid; it never lists the account).

- **C7. Lock on an in-progress recording.** NOT RUN. To record: the lock echo (`requireSignedURLs`), live HLS through a
  fresh input-uid token before and after the lock, the unsigned `/{video_uid}/manifest/video.m3u8` status after the
  lock, and `requireSignedURLs` on `GET /stream/{video_uid}` once the recording has finished. If the lock does not hold
  in progress, Task 13 locks only finished recordings and C3's open window grows to the whole match.
- **C8. PUT keeps `requireSignedURLs`.** NOT RUN. To record: the `PUT /live_inputs/{uid}` echo of
  `recording.requireSignedURLs` when the same `recording` is re-sent with `enabled: false`, and the re-read after it.
- **C9. Token `exp` honoured.** NOT RUN. To record: the status of a token minted with `exp` = now + 60 s at once and at
  now + 90 s (with a fresh-token control at + 90 s, to tell an expired token from a stream that ended).

## Task 20: Bunny, what remained open

Probe: `apps/web/src/server/video/__tests__/bunny.live.test.ts`. It is gated on `BUNNY_LIVE_PROBE=1` plus the four
`BUNNY_*` values, read from the environment only (the POC credentials file, never `.env.local`). Run:
`cd apps/web && set -a; . ~/.config/seazn/bunny-poc.env; set +a; DATABASE_URL= BUNNY_LIVE_PROBE=1 npx vitest run src/server/video/__tests__/bunny.live.test.ts`

What it does:

- Creates one collection and fetches two public samples into it: `long` (1280×720, 183 s) and `hd` (1920×1080, 28 s,
  which tests the cap).
- Deletes only those three items, each by the id its own answer carried, after re-reading it by id.
- Never calls a list endpoint.
- Prints an `OBSERVED` line and a `LEDGER` line.
- Drives the embed in headless Google Chrome 157.

In this section `{lib}`, `{cdn}` and `{guid}` stand for real values, and `<token>` for a token that was never written down.

**Status (2026-11-21): RUN twice, on the owner's Bunny POC library.**

- The POC library is the one whose credentials are in `~/.config/seazn/bunny-poc.env`. It is not confirmed to be the
  staging library that Operator setup Phase 2 configures, so the B3 and B9 results transfer to that library only if
  the two are the same.
- Each run created 3 items and deleted 3 (two videos, then the collection, each answering 200). Nothing was skipped.
- Run 2 was the live run. It went red on exactly one assertion: the B9 cap. The probe now checks the cap in its own
  test, titled as an owner library setting rather than code, so that a red there is never read as a vendor fact that
  moved. The probe has not been re-run live since that split.

- **B7. Collections work.**
  - `POST /library/{lib}/collections {name}` answers 200, with a `guid` and the name echoed back.
  - `POST /videos/fetch?collectionId={guid}` with body `{url, title}` answers 200. Its body keys are `id`, `message`,
    `statusCode` and `success` (as in B1).
  - `GET /videos/{id}` names the collection in `collectionId` and echoes the title that was sent, so Task 27's `title`
    read works.
  - `GET /collections/{guid}` reads `videoCount: 2`. `DELETE /collections/{guid}` answers 200.
  - Encoding was quicker than in B2: 51 s for the 183 s video and 31 s for the 28 s one, timed from the fetch to
    status 4. Polled every 10 s, the statuses ran 0 → 3 → 4 in run 1 and 0 → 2 → 3 → 4 in run 2.
- **B8. An embed keeps playing past its `expires`.**
  - Setup: the embed was loaded with `expires` = now + 60 s. The page was served as `https://stg.seazn.club/` by
    request interception, so no request reached seazn.club.
  - Result: in both runs it autoplayed and played the 183 s video to its end (`ended: true`), with about 129 s of
    playback after the expiry and no media error.
  - Control: the same embed with `expires` 120 s in the past shows Bunny's "403" page and no video. So the embed
    token is checked when the page loads.
  - A caveat on that result: the player buffers far ahead (136 s at 16 s, and the whole 183 s by about 75 s). Only one
    segment was fetched after the expiry (it answered 200).
  - What settles it is the CDN token the embed hands its own player:
    - It is the path form, `bcdn_token=<token>&expires=…&token_path=…`.
    - Its `expires` is the embed's `expires` + 35 941 s, which is 10 h (36 000 s) after the embed page rendered.
      This was measured for one embed `expires` only (now + 60 s, in run 2; run 1 did not read the token).
      *Inferred, not measured:* whether Bunny anchors that time to the page render or to the embed's `expires`. One
      sample fits both rules, and under either one the token lasts at least 10 h after render.
    - At expiry + 127 s, the embed's playlist and last segment URLs still answer 200 with the iframe's `Referer`
      (`https://iframe.mediadelivery.net/`), and 403 with no `Referer`.
  - **So the embed token gates only the page load. Once a replay has loaded, it can keep playing for about 10 h.**
    Task 25 needs no `src` swap, and `REPLAY_EMBED_TOKEN_TTL_SECONDS = 3600` stands. A viewer who reloads after the
    expiry needs a fresh embed URL from the route, as the control shows.
  - The embed also calls Bunny's own hosts: `fonts.bunny.net`, the `edgezone-*.bunnyinfra.net` edge probes,
    `metrics-bunny.net`, `rum-metrics.bunny.net` and `bunnycdn-video-assets.b-cdn.net` (measured).
    *Inferred, not measured:* these are the iframe's own requests, governed by the iframe's CSP, so our page should
    need only `frame-src https://iframe.mediadelivery.net`. That conclusion is reasoned from how a cross-origin
    iframe's CSP works: the probe page had no CSP, and the embed was never driven under `proxy.ts`'s CSP. Task 25 is
    to confirm it on stg.
- **B9. The MP4 file name is as planned, but the library is NOT capped at 720p.**
  - Every video read `hasMP4Fallback: true`.
  - `https://{cdn}/bcdn_token=<token>&expires=…&token_path=%2F{guid}%2F/{guid}/play_{h}p.mp4`, with the B5 token,
    answers:
    - 200 `video/mp4` with `Referer: https://stg.seazn.club/`;
    - 403 with no `Referer`;
    - 403 with `Referer: https://example.com/`.
  - That holds for the highest `h` listed, and every listed height answers 200 with the allowed `Referer`.
    `stg.seazn.club` was the first referrer tried and it was accepted, so `seazn.club` and `www.seazn.club` were not
    tried.
  - The name is `play_{h}p.mp4`, so Task 22's `openDownload` keeps it.
  - **The cap failed.** The 1080p source encoded to `availableResolutions` = `360p,480p,720p,240p,1080p`, and
    `play_1080p.mp4` answered 200. The library is not capped at 720p, which contradicts B2 and the operator setup's
    "resolutions capped at 720p". (The 720p source listed `240p` to `720p` only.) The list comes back unordered, so it
    must be parsed and the maximum taken, not the last item.
  - The probe's library-setting test, which only the 1080p `hd` source can fail, stays red until the owner caps the
    library or the plan accepts 1080p replays.
  - File sizes:
    - 183 s at 720p was 66.7 to 69.0 MB, about 3 Mbit/s. A 3 h match is then about 4 GB, more than the 2–3 GB
      Task 26 assumes.
    - 28 s at 1080p was 25.7 MB, about 7.3 Mbit/s. A 3 h match is then about 10 GB.
- **B10. A delete answers 200 every time.**
  - `DELETE /videos/{id}` answers 200, and `GET /videos/{id}` reads 404 immediately afterwards.
  - A second `DELETE` also answers **200, not 404** (both videos, both runs). Bunny's delete is idempotent.
  - So `remove()` (Tasks 21 and 22) cannot tell `absent` from a DELETE's status. It must either read with `GET` first
    (404 → `absent`) or report a 200 as `deleted` in both cases.
