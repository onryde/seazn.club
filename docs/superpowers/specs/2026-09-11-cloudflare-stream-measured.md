# Cloudflare Stream — measured behaviour

**What this is.** Every fact on this page was measured first-hand against the
live Cloudflare Stream API on 2026-09-10/11, on the account the streaming
programme uses, not read from documentation and not inferred. Where a claim
comes from Cloudflare's docs rather than a measurement it says so.

It exists because the streaming design had four separate assumptions about this
API that turned out to be wrong, three of which would have shipped green — an
HTTP 200 and a silently ignored setting, or a healthy stream reported as dead.

**Authority.** This page is the authority for *what the API does*. The design of
record (`2026-09-07-streaming-programme-design.md`) remains the authority for
*what we build*; where the two ever disagree, this page won the argument once
already and the design should be corrected. Findings are numbered U1-S1 … U1-S9
and the full method for each is in
`2026-09-05-stream-overlay-prompts/_INDEX.md` under the 2026-09-10 and
2026-09-11 sections.

---

## The short version

| # | Finding | Why it bites |
|---|---|---|
| U1-S1 | `deleteRecordingAfterDays` is **top-level**, not inside `recording` | Nested → HTTP 200, silently dropped, retention never set |
| U1-S2 | The create response returns **six** credential objects, not three | `playback.hls` is in hand at provision time; no second call |
| U1-S3 | A live input **creates** fine at zero storage headroom | The headroom guard is the only protection, and it runs at create |
| U1-S4 | `deleteRecordingAfterDays` **floor is 30 days**; 7 is rejected | Design's 7-day retention is not natively expressible |
| U1-S5 | **WHEP is not served for an RTMPS/SRT input** | The composited tier's WHEP pull was impossible as designed |
| U1-S6 | The HLS manifest **403s a non-browser User-Agent** | A liveness probe reads a healthy stream as dead |
| U1-S7 | **`recording.timeoutSeconds` IS the playback hold window** | The dropout tolerance is a tunable product decision |
| U1-S8 | `timeoutSeconds: 0` is **silently swallowed to null** | A config default of 0 gets platform default, not "end now" |
| U1-S9 | Deleting a live input **does not delete its recordings** | Cleanup that stops at `deleteInput` leaks storage permanently |

---

## U1-S5 — WHEP is not available to an RTMPS/SRT input

The single most consequential finding. `POST {webRTCPlayback.url}` answers
**`409 Conflict — "Live broadcast not started yet"`** for the entire life of an
RTMPS-ingested input, while the same input's HLS manifest is serving and
advancing normally and `status.current.state` reads `connected`. Reproduced
across three runs.

Cloudflare's WebRTC documentation states the rule:

> "WHIP and WHEP must be used together: we do not yet support inputs using
> RTMP/SRT to be played using WHEP, or inputs using WHIP to be recorded and
> played using HLS/DASH."

The escape hatch is closed by the same sentence: moving the phone to WHIP ingest
would satisfy WHEP playback but forfeit recording and HLS/DASH.

**Consequence:** the compositor pulls **LL-HLS**. Latency, delivery cost and the
per-input low-latency toggle all have to be re-derived — see the transport
amendment in the design's §3.

## U1-S7 — the hold window is `recording.timeoutSeconds`

*Does a playback path survive its input disconnecting, and for how long?* Yes,
and the answer is settable. Method: push RTMPS, kill the encoder, poll the HLS
master and its variant twice a second, restore the encoder.

| gap | `timeoutSeconds` | `EXT-X-ENDLIST` | master after | resume lag | recorded videos |
|---|---|---|---|---|---|
| 60 s | 10 | cut **+12.2 s** | 200 (finished playlist) | — | 2 |
| 90 s | 60 | cut **+63.1 s** | **204** from +63.1 s | resume **+27.1 s** | 2 |
| **20 s** | **60** | **never** | **200 throughout** | resume **+3.9 s** | **1** |

Two points at ≈ `timeoutSeconds + 3 s` (the +3 is the probe's poll round trip),
and a third run inside the window behaving exactly as that model predicts.

**Inside the window playback STALLS, it does not fail.** The playlist stays
live-marked and stops advancing; a player runs its buffer down and waits. So a
slate must trigger on *segments stopped arriving*, never on a playback error
event — a guard written against an error would never fire.

**An in-window dropout is invisible:** one continuous recorded video, same URL,
under four seconds to recover.

**Beyond the window:** `EXT-X-ENDLIST`, master `204`, a second recorded video on
return, and a ~27 s recovery on top of the outage.

Range: **1 … 86 400 s** (every value probed at 1, 5, 30, 60, 300, 3600, 21600,
86400 accepted and echoed intact). Ruled value: **180 s** (ruling 26).

## U1-S1, U1-S4, U1-S8 — three silent-acceptance traps

Each returns a cheerful response and does the wrong thing.

- **`deleteRecordingAfterDays` nested under `recording`** → HTTP 200,
  `success: true`, the key echoed back nowhere, top-level value `null`.
  Retention never configured. Nesting also means the value is never *validated*,
  which is how an impossible 7 went unnoticed.
- **`deleteRecordingAfterDays: 7`** sent correctly →
  `400 / 10060 "must be between 30 and 1096 days"`. The floor is 30. A video's
  `scheduledDeletion` is floored at 30 too ("must be at least 30 days from
  upload time", Cloudflare API reference). **So no native mechanism expresses
  retention under 30 days** — it is our own cron or nothing.
- **`timeoutSeconds: 0`** → accepted, echoed back as `null`. Not "end
  immediately"; the field simply reverts to unset.

**Rule this implies:** an adapter asserts that every setting it sends comes back
equal to what it sent. Asserting HTTP 200 cannot see any of these three.

## U1-S9 — deleting an input does not delete its recordings

After the spike every live input had deleted itself and `live_inputs` returned
**0**, while `storage-usage` still reported **10 videos holding 8.91 minutes**,
each still carrying the `liveInput` id of an input that no longer existed.
`DELETE /stream/{video_uid}` cleared them and usage returned to `0 / 1000`.

Storage is **prepaid concurrent capacity** ($5/month per 1,000 stored minutes),
not a monthly allowance — proven by that same `8.91 → 0` transition. So what
fills the block is the retention *window*, not monthly volume.

**Consequence:** cleanup that stops at `deleteInput` leaks one recording per
session, permanently. The sweep must delete the **video**, and its test asserts
`storage-usage.videoCount` returns to its prior value.

## U1-S6 — the manifest 403s a non-browser client

`GET` the HLS manifest with Python's default `urllib` agent returns
**`403 "error code: 1010"`** on a manifest that is healthy and serving. The same
URL with a browser `User-Agent` returns 200 and the playlist.

The compositor is headless Chromium and is safe. **Anything else that polls the
manifest is not** — a watchdog, a health check, a sweep's liveness probe. Set a
real `User-Agent`, and test the probe against a known-good stream, or the guard
is decoration.

## U1-S2, U1-S3 — the create response, and the headroom gate

`stream.liveInputs.create()` returns `rtmps`, `srt`, `webRTC` **and a playback
twin of each** (`rtmpsPlayback`, `srtPlayback`, `webRTCPlayback`), plus
`playback: { hls, dash }` — six credential objects. Ingest keys measured at 65
characters, which sizes the `*_enc` envelope columns. Persist `playback.hls`;
the `webRTC*` pair is returned on every create and unusable for this ingest
(U1-S5).

A live input **creates successfully** at `totalStorageMinutesLimit: 0`, so the
storage gate is not on creation. Whether *ingest* is gated at zero headroom is
untested. This matters because headroom is checked at create and enforced at
start: a block exhausted in between yields a session that provisions cleanly and
never goes live, with no error to show.

---

## Credentials and scope

`CF_ACCOUNT_ID` and `CF_API_TOKEN`, server-side only — never `NEXT_PUBLIC_*`.
The token needs exactly one permission, `Account → Stream → Edit`, with no Zone
resources. An account-owned token (`cfat_` prefix, 53 chars) verifies at
`/accounts/{id}/tokens/verify`, **not** `/user/tokens/verify` — the user
endpoint reports a perfectly good account token as `1000 Invalid API Token`.

Stream requires an active subscription; without one the Stream endpoints answer
`403 / 10002` even with a correctly scoped token.

## Reproducing

The probe scripts are not committed — they are throwaway spike code. The method
for each finding is recorded in `_INDEX.md` in enough detail to rebuild them:
create a live input, push `testsrc2` 720p30 plus a 1 kHz sine over RTMPS with
ffmpeg, poll the API and the manifest, cut and restore the encoder, delete the
input **and its recordings** in a `finally` block.

Anything that creates a live input must delete it, and must delete the videos it
recorded (U1-S9), or it leaves the account paying for the spike.
