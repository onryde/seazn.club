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

---

## Measured 2026-09-20 — R1 N-3 probe (live create + delete)

**Why.** `server/relay/ingest-cf.ts` (Task 4) reads its own create back and
**throws** if the echo does not equal what it sent. Those expected values were
inferred from this page and from docs, never measured against the create body
the adapter actually sends. If the inference were wrong in any detail, every
session create in production would throw. Owner authorised one live
create + delete on 2026-09-20 to settle it.

**Method.** One live input, `meta.name: r1-n3-probe-1789901523`, created with
the adapter's exact body (`recording: { mode: "automatic", timeoutSeconds: 180 }`
plus top-level `deleteRecordingAfterDays: 30`), read back, its outputs listed,
the video list probed at four `limit` values, then deleted and the uid re-read.
No broadcast, no encoder, no outputs. Every secret below is `<redacted>`;
the account id is `{acct}`.

**Verdict: the read-back comparison HOLDS.** Both fields the adapter compares
came back equal to what it sent, at the level it reads them.

### The create echo — `POST /accounts/{acct}/stream/live_inputs` → 200

```json
{
  "result": {
    "uid": "<redacted>",
    "rtmps": { "url": "rtmps://live.cloudflare.com:443/live/", "streamKey": "<redacted>" },
    "rtmpsPlayback": { "url": "rtmps://live.cloudflare.com:443/live/", "streamKey": "<redacted>" },
    "srt": { "url": "srt://live.cloudflare.com:778", "streamId": "<redacted>", "passphrase": "<redacted>" },
    "srtPlayback": { "url": "srt://live.cloudflare.com:778", "streamId": "<redacted>", "passphrase": "<redacted>" },
    "webRTC": "<redacted>",
    "webRTCPlayback": "<redacted>",
    "playback": "<redacted>",
    "created": "2026-09-20T10:52:04.856545Z",
    "modified": "2026-09-20T10:52:04.856545Z",
    "enabled": true,
    "meta": { "name": "r1-n3-probe-1789901523" },
    "status": null,
    "recording": {
      "mode": "automatic",
      "timeoutSeconds": 180,
      "requireSignedURLs": false,
      "allowedOrigins": null,
      "hideLiveViewerCount": false
    },
    "deleteRecordingAfterDays": 30
  },
  "success": true,
  "errors": [],
  "messages": []
}
```

`recording.timeoutSeconds` **is** echoed, as the JSON number `180` — not a
string, not null. `deleteRecordingAfterDays` is echoed at the **top level** as
the number `30`, is absent from the `recording` block entirely (whose keys are
exactly `mode`, `timeoutSeconds`, `requireSignedURLs`, `allowedOrigins`,
`hideLiveViewerCount`), and the top-level key is genuinely present rather than
merely reading `undefined`. U1-S1 is confirmed from the other side: sent
top-level, the value **sticks**.

`status` is present and explicitly **`null`** on a never-connected input — not
an absent key, and not an object with an absent `current`. `inputStatus`'s
`result.status?.current` reads `null` correctly as "disconnected", but a guard
written as "the key is absent" would be wrong.

### The read-back — `GET /accounts/{acct}/stream/live_inputs/{uid}` → 200

Byte-for-byte the same body as the create response, `modified` timestamp
included. Nothing the adapter compares differs between the two; the per-input
GET carries `recording` and `deleteRecordingAfterDays` exactly as the create did.

### The SRT shape

The standing ruling is **confirmed**: `srt.url` is the bare
`srt://live.cloudflare.com:778` with no query string at all, and `streamId` and
`passphrase` are separate sibling fields (`srt` keys are exactly `url`,
`streamId`, `passphrase`). `rtmps` is the same shape — bare
`rtmps://live.cloudflare.com:443/live/` plus a separate `streamKey`. Sealing
the two SRT secrets as columns rather than parsing a URL is what the API
actually hands you. `srtPlayback` and `rtmpsPlayback` are the same shape again,
with their own distinct secrets.

### DELETE and its 404

`DELETE /accounts/{acct}/stream/live_inputs/{uid}` answers **HTTP 200** with a
parseable JSON body whose `result` is the empty string:

```json
{"result":"","success":true,"errors":[],"messages":[]}
```

So on this account the delete is neither a 204 nor an unbodied 200 —
`success: true` alone would satisfy `deleteInput`, and the `2xx` clause beside
it is belt-and-braces rather than the live path. Re-reading the uid then gives
**404**:

```json
{"result":null,"success":false,"errors":[{"code":10003,"message":"Not Found: The requested resource or operation was not found."}],"messages":null}
```

`errors[0].code` is `10003`, and `messages` is `null` rather than `[]` on this
shape — anything iterating `messages` without a null guard breaks here.

### The video listing — is `limit` the parameter name?

`limit` **is** accepted and validated. `GET /accounts/{acct}/stream?limit=1` and
`?limit=1000` both answer 200; `?limit=1001` answers **400 / code 10005** with
the message *"results are limited to 1000 entries per request"*, which pins the
ceiling at exactly 1000 — `LIST_VIDEOS_PAGE_LIMIT` sits **on** it, and any
increase would be a hard 400. The adapter's full query shape
(`?end=<iso>&limit=1000`) answers 200 as well. Caveat: the account held **zero**
videos at probe time, so `limit` was proven accepted and bounds-checked, but not
observed truncating a page. The 400 is the evidence, not a row count.

A non-numeric `?limit=abc` answers **HTTP 500 with an empty body** — not a 400.
`call()` turns an unparseable body into `{ success: false }` and `fail()` then
reports `HTTP 500` with no code, which is survivable; nothing sends a
non-numeric limit.

A successful empty listing is `{"result":[],"success":true,"errors":[],"messages":[]}`
— no `range`, no `total` field of any kind, so there is no server-side "more
pages" hint to lean on; the full-page heuristic is all there is.

### Outputs, empty case

`GET /accounts/{acct}/stream/live_inputs/{uid}/outputs` on an input with no
outputs returns **200** with
`{"result":[],"success":true,"errors":[],"messages":[]}` — an empty array, not
`null` and not a 404. `outputState` maps that to `"unknown"` by the
`states.length === 0` rule, which is the intended answer. Whether a *present*
output can carry no `status` was **not** measured: creating an output needs a
third-party destination, which this authorisation excluded. That branch remains
inferred.

### Create/delete ledger

One live input created (`meta.name: r1-n3-probe-1789901523`), deleted in the
same run (200), confirmed gone by a 404 re-read. Post-run sweep:
`GET /live_inputs` returns **0** inputs and **0** probe-named inputs, and
`storage-usage` reads `videoCount: 0`, `totalStorageMinutes: 0` of a 1000-minute
limit. Nothing leaked — no recording was produced because nothing ever
connected (U1-S9's leak needs a recording to leak).
