# Seazn-hosted video: Cloudflare and Bunny probes

Plan: `docs/superpowers/plans/2026-11-20-seazn-hosted-video.md`. Spec: `docs/superpowers/specs/2026-11-20-seazn-hosted-video-design.md`.
Cite results by ID (C1–C6, B1–B6, C7–C9 for Task 7, Task 20's own IDs below).

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
- **B2. Encoding.** 200 s of video encoded in about 2.5 min; video statuses seen 2 → 3 → 4. The library's resolutions are capped at **720p** (owner setting): nothing may assume a 1080p replay.
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

Not yet probed (Task 20).
