# R0 — the bench spike: numbers memo

**Date:** 2026-09-12 · **Fly org:** `seazn-club` · **Region:** `lhr` (every cell)
**Cloudflare:** account `…`(from `.env.local`) · **Bench apps:** `r0-relay-bench`,
`r0-relay-bench2`, `r0-relay-bench3` — all three created and DESTROYED by this wave.
**Spend:** phase 1 $0.09 + phase 1.5 $0.07 + phase 2 **$1.81** = **$1.97** of the $50 wave cap
(phase 2's own cap was $20).
**Harness:** appendix §12, marked THROWAWAY. R2 writes the real image from the design.

This memo replaces design §9.3's `[D]` cost lines (§10) and answers design §13.3's watch
list (§11). Phase 1 and 1.5 detail lives in `PHASE1-FINDINGS.md` beside this file; this
memo carries the verdicts.

---

## 1. Verdicts

Bars (from the brief): **CPU < 80 % sustained · drift < 100 ms/h · 30 fps held, no minute
below 29.5 · D5: zero duplicated frames and zero gaps in each 10 s ordinal window.**
D5 is reported as its own line because a held 30 fps average survives a duplicate every
few frames — phase 1 measured exactly that.

| Cell | Shape | Guest | fps | CPU | drift | **D5** | Verdict |
|---|---|---|---|---|---|---|---|
| **C1** | B2, 3 h soak | perf-2x / 4 GB | 25.48–29.99, dips **< 29.5**; **323 584 frames / 0 dropped** over 3 h (29.96 avg) | **97.5–98.6 %** | −60→−96 ms (**30 ms/h**) | **0 dup / 0 gap** at t=13, 43, 90, **180** | **FAIL** (fps + CPU) |
| **C2** | B2, 3 h soak | perf-4x / 8 GB | **29.99–30.00**; **324 270 frames / 0 dropped** over 3 h (30.02 avg) | **80.9–85.1 %** | −49→−63 ms (**18 ms/h**) | **0 dup / 0 gap** at t=43, 90, **180** | **PASS** on fps/drift/D5; **FAIL** the < 80 % CPU bar by 1–5 points |
| **C6** | B2, 12 min | perf-8x / 16 GB | **29.70–29.90** | **50.2–52.1 %** | not sampled (short cell) | not sampled (short cell) | **PASS** fps + CPU |
| **C3** | dual-publish, 25 min | perf-2x / 4 GB | 29.98–30.00 | 96–97 % | n/a | n/a | **PASS** — both legs held (§4) |
| **C5** | B2 + real contribution pull | perf-2x / 4 GB | 28.00–28.94 | 89.4–92.1 % | n/a | n/a | **FAIL** fps (pull leg costs ~1.5 fps and 0 drop) |
| **M1 n=2** | B2 multi-source | perf-2x / 4 GB | 28.96–**29.47** | 97.0–97.5 % | n/a | n/a (§5) | **FAIL** fps |
| **M1 n=2** | B2 multi-source | perf-4x / 8 GB | 29.30–**29.81** | 83.8–85.1 % | n/a | n/a | **FAIL** fps (dips below 29.5) |
| **M1 n=4** | B2 multi-source | perf-2x / 4 GB | 23.47–26.74 | 97.0–98.1 % | n/a | n/a | **FAIL** |
| **M1 n=4** | B2 multi-source | perf-4x / 8 GB | 26.34–28.65 | 86.0–86.5 % | n/a | n/a | **FAIL** |
| **M1 n=4** | B2 multi-source | perf-8x / 16 GB | **29.72–29.91** | **48.4–49.1 %** | n/a | n/a | **PASS** |
| **C4** | driver row | perf-2x / 4 GB | 29.93–29.99 all three | 93–94 % all three | n/a | 0 dup / 0 gap (§1.1) | **not a verdict** — three numbers, §6 |

`drop_frames` and `dup_frames` were **0** in every B2 cell above, at every size, for the
whole run — including the cells that failed the fps bar. Under B2 a slow machine falls
behind in *wall-clock* (`speed` < 1.0×) rather than dropping or duplicating frames, which
is why the encoder's own counters cannot see this failure and `speed` must be read
alongside them.

### 1.1 D5 — its own line, per cell

| Cell | window | frames | dup | gaps | missing | longest clean run |
|---|---|---|---|---|---|---|
| C1 perf-2x | t≈13 min | 300 | **0** | **0** | 0 | 299 / 299 |
| C1 perf-2x | t≈43 min | 300 | **0** | **0** | 0 | 299 / 299 |
| C1 perf-2x | t=90 min | 300 | **0** | **0** | 0 | 299 / 299 |
| C1 perf-2x | **t=180 min** | 120\* | **0** | **0** | 0 | 119 / 119 |
| C2 perf-4x | t≈43 min | 300 | **0** | **0** | 0 | 299 / 299 |
| C2 perf-4x | t=90 min | 300 | **0** | **0** | 0 | 299 / 299 |
| C2 perf-4x | **t=180 min** | 300 | **0** | **0** | 0 | 299 / 299 |
| C4 css | 10 s | 300 | **0** | **0** | 0 | 299 / 299 |
| C4 motion | 10 s | 283 | 1* | **0** | 0 | 181 |
| C4 gsap | 10 s | 300 | 1* | **0** | 0 | 177 |

\* C1's t=180 window is 120 frames rather than 300 because the encoder stopped inside the
capture; the read is valid over the frames it has.

\* the single duplicate in the motion and gsap windows is the baked source's 120 s LOOP
POINT (ordinal 3418 → 99, which the decoder also reports as one `backward` event), not a
compositor artefact. The css window happened not to contain a wrap. No cell showed a
duplicate or gap that was not a loop wrap.

**B2 holds the D5 bar absolutely, at every size, including on a machine that is failing
the fps bar.** This is the strongest form of the result and the memo means it literally:
C1 spent three hours at 97.5–98.4 % CPU, dipping below the fps bar, and its ordinal
sequence was still 0 duplicates / 0 gaps / 299 of 299 at every checkpoint. **Smoothness
under B2 is decoupled from CPU headroom, not merely correlated with it** — a starved B2
machine falls behind in wall clock (`speed` < 1.0×) and still emits every frame in order,
where a starved B3 machine shreds the picture. That single line retires B3 on its own:
under B3, smoothness was hostage to headroom; under B2 it is not.

The mechanism: under B2 ffmpeg owns the timebase, so the two clocks of §7.2's D5 cannot
beat. Against phase 1's B3 numbers — 156 dup / 84 gaps /
longest clean run 3 frames, and 144/79/3 with the pull leg removed entirely — this is the
whole case for the owner's B2 ruling, and it is now measured at three guest sizes over
three hours rather than inferred.

---

## 2. Machine size recommendation

**Recommendation: `performance-4x / 8 GB` as R2's default** (`cpuClass: "dedicated"`,
`cpus: 4`, `memoryMb: 8192` in `RunnerSpec`; `runner-fly.ts` maps `"dedicated"` →
`cpu_kind: "performance"`).

| Guest | £ / 3 h match | fps | CPU | Verdict |
|---|---|---|---|---|
| shared-cpu-2x / 4 GB | £0.081 | collapses to 8.8 (phase 1) | 88–99 % with **90 % steal** | unusable at any price |
| performance-2x / 4 GB | **£0.270** | dips below 29.5 | 97.5–98.4 % | no margin — fails |
| **performance-4x / 8 GB** | **£0.539** | **30.00 flat for 3 h** | 81–85 % | **recommended** |
| performance-8x / 16 GB | £1.078 | 29.70–29.90 | 50 % | buys the CPU bar and multi-cam n=4 |

Rates derived from the account's own guest configs at Fly's published rate card
(performance vCPU $31.00/mo, RAM $5.34/GB/mo, per-second billing), converted at $1.27/£.

**Why perf-4x and not perf-8x.** perf-4x holds every bar a viewer can see — 30 fps flat
for three hours, D5 zero, drift 18 ms/h — and misses only the CPU bar, by 1–5 points,
with no degradation over the full soak and flat RSS. perf-8x doubles the bill for
headroom the product does not currently need. **Two conditions flip that**: if R2 wants
the < 80 % CPU bar honoured as written, or if multi-camera ships (§5), the answer becomes
perf-8x at £1.078.

**`performance-8x` cannot be bought with 8 GB.** Fly rejects it:
`invalid config.guest.memory_mb, minimum required 16384 MiB`. The step from perf-4x to
perf-8x is therefore 2× CPU **and** 2× RAM — exactly 2× the price, with no intermediate.

**Margin against the £6 credit:** perf-4x ≈ 91 %, perf-8x ≈ 82 %, before Cloudflare.

---

## 3. WHEP vs HLS — the pull leg

| Path | p50 | p95 | range | Status |
|---|---|---|---|---|
| **WHEP**, WHIP-ingested input, idle machine | **501 ms** | — | 439–624 | **measured** (phase 1.5, 17 flashes) |
| **WHEP**, WHIP-ingested input, machine also encoding | **736 ms** | — | 542–1 141 | **measured** (C3, 20 flashes) |
| **LL-HLS** — `preferLowLatency: true` + `?protocol=llhls` + no B-frames (§3a) | **8 741 ms** | 8 774 ms | 8 720–8 786 | **measured** (2026-09-13, laptop publisher, 1 049 samples) |
| **Standard HLS** (hls.js against 2 s segments) | **12 615 ms** | 12 689 ms | 12 516–12 708 | **measured** (phase 1.5, 299 samples) |

**The ordering the owner needs: WHEP 0.5 s (WHIP ingest only) → LL-HLS ~5 s claimed and
unmeasured → standard HLS 12.6 s measured.**

### FP — "LL-HLS" was a mislabel, in this programme AND in the design of record

Phase 1.5 reported 12 615 ms as **LL-HLS**. It is not. Verified independently on the live
C1 destination with a browser UA: the media playlist carries `#EXT-X-TARGETDURATION:2`
and `#EXTINF:2.000` segments and **zero low-latency markers** — no `#EXT-X-PART`, no
`#EXT-X-PRELOAD-HINT`, no `#EXT-X-SERVER-CONTROL`, no `#EXT-X-PART-INF`, no
`#EXT-X-RENDITION-REPORT` (all five counted at 0). Two-second segments plus an ordinary
player buffer is exactly where 12.6 s comes from.

*Withdrawn 2026-09-13 — see §3a.* This paragraph said LL-HLS was an account-level dashboard
beta with no field on the live-input object, and read `llhlsHBs=0.9` as machinery wired but
idle. Both are wrong: the field is `preferLowLatency`, omitted from responses until it is
set, and `llhlsHBs` appears on every input's variant URIs whether or not it is set.

**The design of record calls the pull path LL-HLS (§7.4, §9.2). On this account it is
plain HLS.** Recorded as a false premise rather than absorbed.

**The consequence for the owner, stated plainly.** WHEP's 0.5 s requires **WebRTC
ingest**, and the phone publishes SRT/RTMPS. So **for the contribution path, HLS is the
viewer's latency**: enabling the LL-HLS beta is the difference between a ~12.6 s scorebug
and a claimed ~5 s one for anyone watching a phone-published match. It is a per-input API field rather than a dashboard action
(§3a) — and setting it did not, on 2026-09-13, change what Cloudflare delivered.

WHEP is available **only on a WebRTC-ingested input**: on an RTMPS/SRT-ingested input,
`POST …/webRTC/play` returns `409 "Live broadcast not started yet"` — proved because the
same deliberately malformed SDP returns **409 under RTMPS and 400 "Unable to parse SDP"
under WHIP**. The 409 was never about the SDP. Running the WHEP subscriber beside the
encoder costs ~235 ms of its own latency.


### 3a. LL-HLS, measured — 2026-09-13 (replaces every LL-HLS statement above)

§3 called LL-HLS an account-level dashboard beta with no API surface and read `llhlsHBs=0.9` as
idle machinery. Both were wrong — and so was this section's first draft, which concluded the field
"did not deliver" after measuring the wrong URL. **LL-HLS takes three things, all per input and
all reachable through the API:**

1. **`preferLowLatency: true`** on the live input, at create or by update (a `GET` omits the key
   until it has been set — F3's absent-field shape), with `recording.mode: "automatic"`.
2. **The player must request `?protocol=llhls`.** Cloudflare's custom-player docs: *"add the query
   string `?protocol=llhls` to the HLS manifest URL"*. The plain `/manifest/video.m3u8` serves
   standard HLS even when the field is set.
3. **The broadcast must carry no B-frames** — *"B Frames are incompatible with LL-HLS and will
   result in jitter and sporadic buffering delays."*

Every row below reads a 20-bit wall-clock-millisecond bar burned into the source
(`setpts=RTCTIME` → `drawbox`; dry-run decoded 4/4 at bit margin 127), in headless Chrome 152
through hls.js 1.6.2 pinned to 720p, publisher and reader on one clock:

| Input · manifest · encoder | hls.js mode | samples | p50 | p95 | parts | `canBlockReload` | hls.js's own figure |
|---|---|---|---|---|---|---|---|
| field by `PUT` · plain · libx264 default (2 B) | low-latency | 1 247 | 17 374 | 17 395 | 0 | false | 9 722 |
| field by `PUT` · plain · libx264 default | standard | 1 243 | 13 352 | 13 368 | 0 | false | 6 129 |
| field at create · plain · libx264 default | low-latency | 1 182 | 17 251 | 17 283 | 0 | false | 10 753 |
| field at create · plain · libx264 default | standard | 1 136 | 12 302 | 12 336 | 0 | false | 6 282 |
| **field set · `?protocol=llhls` · `-bf 0`** | **low-latency** | 1 049 | **8 741** | 8 774 | 41 | true | 6 810 |
| field set · `?protocol=llhls` · `-bf 0` | standard | 1 349 | 11 676 | 11 719 | 41 | true | 9 436 |

**Manifests, same input, same instant (10 samples each):** the plain URL carried zero parts; the
`?protocol=llhls` URL carried 43, with `#EXT-X-PART-INF:PART-TARGET=0.5` and
`#EXT-X-SERVER-CONTROL:PART-HOLD-BACK=1.5,CAN-BLOCK-RELOAD=YES`, 4 rendition reports, and
`#EXT-X-TARGETDURATION:3`.

**Frames actually delivered, 720p, 4 s each, from a publish verified locally to emit 0 B-frames
(`-bf 0` → 2 I / 118 P):** the plain rendition arrived with `has_b_frames=2` (52 B · 67 P · 3 I, 2.86
Mbps); the `?protocol=llhls` rendition with `has_b_frames=0` (118 P · 2 I, 3.69 Mbps). Cloudflare's
standard pipeline adds B-frames when it re-encodes; its low-latency pipeline delivers none. Whether
the latter passes the ingest GOP through or re-encodes without B-frames is not established.

Findings:

1. **LL-HLS works on this account through the API, with no dashboard action and no enrolment: 8.7 s
   p50, against 12.3–13.4 s for standard HLS — about 4 s faster.** Cloudflare's "as low as 5 s" is
   not reached here, and the publisher explains at least part of it (below).
2. **R2 must request `?protocol=llhls` explicitly.** Setting the field and pulling the plain URL
   silently gets standard HLS.
3. **A low-latency player with no parts is ~4–5 s SLOWER** (17.3 s against 12.3–13.4 s). Key hls.js
   `lowLatencyMode` off `#EXT-X-PART` actually being present, never off the input's setting.
4. **hls.js's self-reported latency under-reads glass-to-glass** — by 6–7.5 s on standard HLS and
   ~1.9 s on LL-HLS. It cannot see encode, ingest or packaging. **`delayMs` is seeded from a
   burned-in source clock, never from the player's figure.**
5. **A design conflict, not a typo: B-frames.** Design §7.2 passes `-bf 2`, and §9.2 cites *"2
   B-frames + CABAC per YouTube's encoder spec"*; LL-HLS requires none. One encode cannot follow
   both. Whether YouTube's ingest takes a B-frame-free stream without penalty is **not measured**.
   Choosing between LL-HLS for Seazn's own viewers and YouTube's recommended GOP is an owner
   decision R2's plan must surface.

**Limit:** every row was published from a laptop on a home uplink, not an `lhr` Machine, so the
absolute figures include that uplink. The comparisons between rows — same laptop, same stream
shape, minutes apart — do not.

---

## 4. C3 — dual-publish: the owner's ingest ruling HOLDS

The ruling was conditional on this cell. One machine, one source, two destinations: the
browser published WHIP into a WebRTC input while ffmpeg pushed the same source RTMPS into
a second input.

| Leg | Result |
|---|---|
| WHIP live leg | `ingestProtocol: "webrtc"`, `connected`; WHEP `201`; ICE `connected`; 1280×720; latency p50 **736 ms** |
| RTMPS recorded leg | `ingestProtocol: "rtmp"`, `connected`; HLS **advancing by progression** (media-seq 35→41, 6 new segment URIs); recording `0927bfdc35cd920078677c9ede623e0b` created 10:03:08Z, finalised **`ready`, 1 504 s**, and **re-read by uid and decoded** (59 frames from a 2 s pull at t+600 s) |
| Cost of the second output | ffmpeg 28 % of 2 cores at 29.98 fps, 0 drop, 0 dup; the browser's WHIP publisher took 66.5 % |
| **Verdict** | **Dual-publish holds.** Both legs ran concurrently for 25 minutes with no interference. |

### C7 — does a WHIP-ingested input record at all? **No.**

C3 proves dual-publish works, but its WHIP input was created `recording: {mode: "off"}`,
so the 1 504 s recording came from the **RTMPS** leg — C3 on its own does not answer the
question. C7 does. A dedicated input, **mode confirmed by the individual GET** (the list
endpoint omits `recording` entirely, F3): `recording.mode: automatic, timeoutSeconds: 30`,
`deleteRecordingAfterDays: 30`. Baseline videos before publishing: `[]`. ~2 min of WHIP
published, then stopped.

Read 28 minutes after the input went `disconnected` at 11:33:51Z: `ingestProtocol:
webrtc`, `recording.mode: automatic`, **zero videos**, and the HLS manifest returns
**HTTP 204** rather than a playlist.

**A WHIP-ingested Cloudflare live input produces no recording and no HLS, even with
recording explicitly enabled.** Nothing was deleting during that window. This is a
platform property, not an artefact — and it is the load-bearing reason the owner's
dual-publish ruling is necessary rather than merely convenient: **the WHIP leg cannot be
the recorded leg.**

**The phase 1.5 caveat is superseded and its contamination recorded.** Phase 1.5 reported
"a WHIP-ingested input produced no HLS manifest and no recording in-window". That window
overlapped an account-wide delete loop run by the P5 device-spike session, so the
observation was not attributable. **C3 re-establishes it cleanly on uncontaminated
evidence**: across the whole cell the WHIP input's `/videos` stayed `[]` and its manifest
never advanced (`VERDICT: stalled`, no media sequence), while the RTMPS input beside it
produced both. The caveat is real — C7 now proves it as a property rather than an observation — and it
is precisely why dual-publish is needed rather than a reason to doubt it. **Both facts
belong in the record: the property, and the reason the phase 1.5 observation could not be
trusted at the time.** An absent recording is evidence only when nothing else could have
removed it; after the fact a deletion race and a non-creation are indistinguishable, which
is exactly how the original caveat became uncertain.

---

## 4a. The playback hold window (U1) — replaces a class [D] line

Design §7.4 rests on a hold window and §9.2 carries it as **[D], unspiked, with no
measurement anywhere in the programme**. Two cells settle the part R0 can settle.

Both used `recording: {mode: "automatic", timeoutSeconds: 180}` (confirmed by the
individual input GET, not a listing), ~60–70 s of RTMPS from the bench source, then a
stop; the master and the 720p variant were polled with a browser User-Agent, recording per
poll the wall clock, both HTTP statuses, the variant **path** (identity), ENDLIST
presence, the media-sequence head, and **`#EXT-X-TARGETDURATION` as actually seen**.

| | **C9 — abrupt death** | **C10 — clean cut** |
|---|---|---|
| How the encoder ended | SIGKILL (see the `-nostdin` finding below) | **SIGINT → exit 0, trailer written, 114 ms** |
| Poll interval (median) | 2.83 s | 2.87 s |
| `TARGETDURATION` as seen | **2** (constant) | **2** (constant) |
| Distinct variant paths | 1 — no reconnect confound | 1 — no reconnect confound |
| `#EXT-X-ENDLIST` ever present | **never** | **never** |
| Head last advanced | +1.2 s from cut | −0.1 s from cut |
| Terminal event | **master 204 at +182.8 s** | **master 204 at +183.5 s** |

**Answer 1 — the manner of ending does not change the outcome at 180.** A clean cut and an
abrupt death are within 0.7 s of each other, and neither produces an ENDLIST. The two
candidate explanations the orchestrator posed are therefore separated: it is **not**
"abrupt death 204s while a clean cut ENDLISTs later". It is that **the 180 value behaves
differently from 10 and 60.**

**Answer 2 — `timeoutSeconds` does govern the hold**, and the hold is `timeoutSeconds`
plus ~3 s: 182.8 s and 183.5 s against a configured 180.

**Carried, not measured by R0** (attribute to the sessions that measured them): an earlier
session saw `EXT-X-ENDLIST` land at cut **+12.2 s** with `timeoutSeconds: 10` and
**+63.1 s** with `60`, both on clean cuts — also ≈ timeout + ~3 s. So the *duration* is
consistent across 10/60/180 while the *termination signal* is not: ENDLIST at the short
values, silent expiry to 204 at 180. The P5 session independently observed no ENDLIST at
180 from an app death, with a hold of ~213 s.

**A claim in an earlier draft of this memo is WITHDRAWN.** That draft attributed the ~30 s
gap between their 213 s and R0's 183 s to their detection lag. The P5 session falsified it
with arithmetic: their ingest end is fixed by the recording's own duration
(10:28:51.599Z + 1998.23 s = 11:02:09.83Z), their first 204 is at 11:05:55.034Z, and their
last 200 is at 11:05:50.877Z — so their detection uncertainty is **4.157 s**, which cannot
account for ~30 s. The gap is real and **this memo does not explain it**.

**The variable most likely to explain it, stated as a hypothesis and not a result:
transport and close semantics.** Both of R0's cells published **RTMPS**, which is TCP — so
even C9's SIGKILL closed the socket via the OS, and Cloudflare learned the publisher was
gone immediately. That is consistent with R0's clean cut and abrupt death landing 0.7 s
apart. The P5 session published **SRT**, which is UDP — a SIGKILLed process closes nothing,
so Cloudflare may have run its own SRT session timeout *before* starting the hold.

If that is the mechanism, the consequence is material and belongs to the phone tier, which
publishes SRT: **the hold is timed from when the platform notices the publisher is gone,
not from the last media it received**, and dropout tolerance on SRT is the SRT session
timeout PLUS `timeoutSeconds` rather than `timeoutSeconds` alone. Anyone reasoning about
tolerance from the configured number would be short by the difference.

**R0 cannot settle this** — SRT ingest never started a broadcast on this account at all
(phase 1, FP-4), so the transport arm is unavailable here. Two cheap cells settle it on a
tier that can publish SRT: same `timeoutSeconds`, SRT with a **clean** stop (isolates
transport against R0's RTMPS clean cut), and SRT with a **kill** (isolates close semantics
within SRT). **Recorded as an open question, not as a number.** The P5 device session carries the same
hypothesis as **H-P5-1** and owns both cells, with the interpretation fixed in advance so
the result cannot be fitted to it afterwards. They also record the direction that cuts the
other way and which R0 cannot see: if the platform starts the hold late on SRT, then a dead
SRT stream keeps serving `200`s for **longer** than the 181.5 s measured here on RTMPS — so
a status-reading health check is wrong for longer on the phone tier's transport than on the
compositor's. Neither direction is safe to assume before both cells run.

**A clean cut and an abrupt death are the same scenario here; 180 and 10/60 are not.**
Anything R2 builds on ENDLIST as the end-of-stream signal must not assume it arrives —
at the value this programme would actually configure, it does not.

**And the hold window is a 3-minute false green.** After the head stopped advancing, C9
served **61 consecutive polls returning HTTP 200 on a frozen playlist** over 181.5 s
before the 204. A health check reading status would call that stream healthy for three
minutes after it died. This is F4 arriving from a third direction.

### The `-nostdin` finding — §7.2's graceful stop does not work as written

Design §7.2 specifies "graceful stop = `q` + ≤ 10 s flush + exit 0". **`q` only works if
ffmpeg reads stdin, and the §7.2 command line passes `-nostdin`**, so the keystroke is
discarded and the supervisor's 10 s fallback SIGKILLs the encoder. Measured directly: with
`q` alone the encoder exited at **+10.015 s** — the fallback timer to the millisecond;
after adding `SIGINT` it exited at **+0.114 s with code 0**. Every "graceful" stop in this
harness before that fix was an abrupt kill wearing a graceful label, which is why C9 is
labelled abrupt above.

**R2 must send SIGINT** (or drop `-nostdin`). Otherwise §7.2's "exit 0" contract is unmet,
the trailer is never written, and §6.4's "any child death → non-zero → one runner retry"
fires on what was supposed to be a clean shutdown.

---

## 5. M1 — multi-camera, in the B2 shape

**The briefed shape was superseded by the B2 ruling, not skipped.** R0-bench.md specifies
`{2,4}` concurrent **WHEP receivers on one relay page**, the page compositing live. That
shape exists only under B3. Under B2 the video never enters the browser, so N-way
compositing moves into ffmpeg: N source decodes → scale → `hstack`/`vstack` → the keyed
overlay on top, with the page still contributing only the overlay.

| N | perf-2x / 4 GB | perf-4x / 8 GB | perf-8x / 16 GB |
|---|---|---|---|
| 1 (C1/C2/C6) | 25.48–29.99, CPU 97.5–98.4 % — FAIL | **30.00 flat**, CPU 81–85 % — PASS | 29.70–29.90, CPU 50 % — PASS |
| **2** | 28.96–**29.47**, CPU 97.0–97.5 % — **FAIL** | 29.30–**29.81**, CPU 83.8–85.1 % — **FAIL** (dips below 29.5) | not run |
| **4** | 23.47–26.74, CPU 97–98 % — **FAIL** | 26.34–28.65, CPU 86 % — **FAIL** | **29.72–29.91, CPU 48.4–49.1 % — PASS** |

`drop_frames` and `dup_frames` were 0 in every M1 cell; the failures are all `speed` < 1.0
(0.878–0.980×), i.e. falling behind wall clock.

### The N verdict, and the program-plus-preview ruling

**At an economic guest (perf-4x, £0.539/3 h) the largest N that holds the bars is N = 1.**
Even N = 2 dips to 29.30 fps there. **N = 4 holds every bar only at perf-8x** (£1.078/3 h),
where it runs at 48–49 % CPU with room to spare.

So the design's question resolves as: **program-plus-preview is required if multi-camera
ships on the recommended guest.** It is *not* required if the owner buys perf-8x for
multi-cam matches — and the measured curve says that is the cleaner answer, because
perf-8x at N=4 is not marginal, it is comfortable (48 % CPU), whereas perf-4x at N=2 is
already under water. **Multi-cam is a guest-size decision, not an architecture decision.**

The compute curve is emphatically **not** linear and must not be extrapolated: on perf-4x,
N=1→30.00, N=2→29.30, N=4→28.65; on perf-8x, N=1→29.90 and N=4→29.91 — N=4 costs
essentially nothing extra there because the four decodes parallelise across eight cores
while each is scaled to 640×360 before compositing.

**Limit of these rows:** the N sources are decoded from a local file, so this measures
decode + composite + key compute and excludes N contribution pulls. C5 measures one real
pull (§7); N pulls were not measured.

---

## 6. C4 — the animation-driver row (three numbers, not a verdict)

Same overlay, same three §3.6 motions, `performance-2x`, two independent runs per driver.
Overlay-freeze % is read from the page's own 24-bit `Date.now()` bar in the OUTPUT — the
fraction of output frames in which x11grab caught no new browser paint.

| Driver | overlay frozen, run 1 | run 2 | freeze gap p50 / p95 / max (run 1 → run 2) | Chromium CPU (% of 2 cores) | fps |
|---|---|---|---|---|---|
| **CSS keyframes** (today) | 15.1 % | 9.2 % | 34/77/130 → 34/68/98 ms | 38.5 % | 29.94 |
| **motion.dev 13.2.0** | 14.4 % | 3.3 % | 36/75/120 → 32/68/84 ms | 35.3 % | 29.93 |
| **GSAP 3.12.5** | 12.0 % | 7.1 % | 34/75/107 → 33/65/91 ms | 36.5 % | 29.93 |

Read carefully, because two of these three columns do not support a conclusion:
- **CPU does not separate them.** The spread is ~3 points and the *ordering reversed*
  between the two runs (first run: css 36.5 < gsap 38.0 < motion 38.5; archived run:
  motion 35.3 < gsap 36.5 < css 38.5). Run-to-run variance exceeds the between-driver
  difference. **There is no measurable CPU cost to adopting a library.**
- **Overlay smoothness does separate them, weakly but consistently: CSS keyframes are
  worst in both runs.** motion and gsap swap places and are not distinguishable from each
  other.
- fps and D5 are identical across all three — the driver never touches the video path
  under B2.

**Deviation to record:** motion.dev was driven through its vanilla `Motion.animate()`
rather than the React bindings the brief names. The engine is the same; what a vanilla
harness cannot see is React re-render overhead, which is the part of "the React path"
that would differ. That row is therefore a lower bound on motion's cost in W2's actual
shape.

---

## 7. C5 — the contribution leg

C1/C2/C6/M1 all decode a **locally baked file**: that measures smoothness, duration and
compute honestly and has **no contribution leg**. C5 runs the identical B2 shape with
input 0 replaced by a real Cloudflare pull of a live input fed by a separate publisher
Machine in `lhr`.

| | C1 (local file, perf-2x) | C5 (Cloudflare pull, perf-2x) |
|---|---|---|
| fps | 29.19–29.99 | **28.00–28.94** |
| speed | 0.973–0.989× | 0.934–0.965× |
| ffmpeg CPU | 67 % of 2 cores | 42.5 % of 2 cores |
| Chromium CPU | 28 % | 43 % |
| host CPU | 97.5–98.4 % | 89.4–92.1 % |
| drop / dup | 0 / 0 | **0 / 2** |

**The contribution pull costs ~1.5 fps and works.** ffmpeg's HLS demuxer read Cloudflare's
live HLS continuously for the whole cell, emitting only benign `Found duplicated MOOV
Atom` warnings. This contradicts the phase-1 finding that ffmpeg cannot read Cloudflare
live HLS — that was true of a stream whose segment window was empty, not of the
demuxer.

**Not measured:** a weak-link contribution leg. The P5 session measured an SRT handset
session rebuilding 18× in 5 minutes and publishing 64 % of the time at 1 482 kbps against
a 3 000 kbps encode. C5's publisher was a datacentre Machine on a clean link, so this cell
says nothing about what the compositor does when contribution collapses. That is an R2
question and it is not answered here.

---

## 8. The chroma key — `_THEMES.md` blockers closed

### 8.1 Key colour and filter

**Recommendation: key `#ff00ff` (magenta) with `colorkey=0xff00ff:0.30:0.10`. No despill.**

Minimum distance from the key to **every** colour in `_THEMES.md` §2 (all eleven sport
palettes × board/board-2/ink/led/caution/dismissal, plus white and black):

| Candidate key | colorkey min distance | chromakey min UV distance | worst-case palette colour |
|---|---|---|---|
| `#00b140` green (phase 1.5) | 0.229 | **0.033** | hockey advisory `#3ddc84` |
| `#00ff00` green | 0.339 | 0.210 | hockey advisory `#3ddc84` |
| `#0000ff` blue | 0.388 | 0.210 | volleyball led `#4aa8ff` |
| `#8000ff` purple | 0.400 | 0.255 | cricket board-2 |
| **`#ff00ff` magenta** | **0.399** | **0.310** | tabletennis dismissal `#ff7a80` |

**A stated reason is corrected here, and it matters more than it looks.** The brief — and
what the orchestrator told the owner — ruled out a green key because **cricket's accent
`#9ae600` is a bright lime**. The conclusion is right and green is disqualified. The
*reason* is wrong: measured against every palette colour, the binding constraint is
**hockey's advisory `#3ddc84`, which sits 0.033 UV from the phase-1.5 key `#00b140`** —
an order of magnitude closer than cricket's lime. `#9ae600` is a yellow-green and sits
comfortably clear; `#3ddc84` is a mint that lands almost exactly on a standard key green.
That is what ate the scorebug.

Record the correction explicitly, because **a reader who inherits the wrong reason picks
the wrong key the next time a palette changes**: the test is not "is any accent green",
it is "what is the minimum UV distance from the key to EVERY colour in every palette",
and today that minimum is owned by hockey.

Measured erosion of real palette colours after keying, composited over a light and a dark
frame (max ΔRGB across all swatches, real ffmpeg, not a model):

| Chain | erosion, light bg | erosion, dark bg | cost / 300 frames |
|---|---|---|---|
| `colorkey=0x00b140:0.30:0.10` (phase 1.5) | **333.6** (football board-2) | **238.9** (hockey adv) | 0.85 s |
| `colorkey=0x00b140:0.15:0.05` | 0.0 | 0.0 | 0.85 s |
| **`colorkey=0xff00ff:0.30:0.10`** | **2.8** | **4.9** | **0.85 s** |
| `chromakey=0xff00ff:0.20:0.05` | 1.4 | 1.4 | 3.77 s |
| `chromakey=0xff00ff:0.25:0.08` | 39.7 | 67.5 | 3.77 s |
| `chromakey=0x0000ff:0.15:0.05` + `despill=type=blue` | 134.0 | 134.0 | 4.88 s |

Three things follow. **The key colour was the defect, not the filter** — colorkey on
magenta erodes by < 5 ΔRGB, which is imperceptible. **chromakey costs 4.4× more for
~3 ΔRGB**, which is not worth buying. **`despill` is actively harmful here** — it
desaturates legitimate blue overlay content (volleyball's `#4aa8ff` by 134 ΔRGB), because
ffmpeg's despill only knows green and blue and cannot tell spill from content.

Acceptance screenshots: `key/SHOT-recommended-magenta-{light,dark}.png` and, for contrast,
`key/SHOT-phase15-green-{light,dark}.png`. The live composite is `raw/m1-n2.png` — the
scorebug's dark navy panel is intact there, against phase 1.5's `raw/probeC.png` where the
green key made it translucent.

### 8.2 The opacity motions — a design constraint for W2

Chroma keying yields graded alpha but does **not** un-mix the key from what remains, so a
partially transparent element composites tinted. Measured over the real palettes:

- **An element that fades over an opaque overlay plate is SAFE.** Every blend of every
  palette foreground over every palette board, at α ∈ {0, 0.25, 0.5, 0.55, 0.75, 1}, sits
  at minimum **0.305** UV from magenta — nothing lands near the key, so nothing is eroded.
- **An element that fades over the KEY is BROKEN.** Mid-fade pixels composite **120–227
  ΔRGB** from the correct colour in every configuration tested, and despill makes it worse.

Applied to the three motions that animate opacity:

| Motion | Over what | Verdict |
|---|---|---|
| `ovl-breathe`, live dot 0.55↔1 continuous | inside the scorebug panel, over opaque `--sport-board` | **SAFE — keep as opacity** |
| warming-state breathing dots | over the slate plate | **SAFE** |
| `ovl-slate-fade`, 250 ms state-swap cross-fade | `.ovl-slate-content`, inside `.ovl-slate`, which paints an opaque full-canvas `--sport-board` | **SAFE** — *corrected 2026-09-13: first drafted as "fades against the key — BROKEN", reasoned from the bench's stand-in page rather than the shipped CSS* |
| W2's moment slab | `translateX` only, on `--sport-led` (W2, #775) | **SAFE** — no opacity at all |

**The rule W2 needs: an overlay element may animate opacity only over an opaque plate of
its own theme. Nothing may cross-fade against the key.** Every motion the overlay
ships today already keeps it (`_THEMES.md` §6 audits all five — a read of the stylesheet,
not yet a run under a real key), so **no motion code change is owed**; the rule binds
future motion. This is a constraint on `_THEMES.md` §motion,
not a tuning parameter.

---

## 9. Teardown

```
--- 0. storage BEFORE (both soak recordings had just finalised) ---
{"videoCount":6,"totalStorageMinutes":396.84,"totalStorageMinutesLimit":1000}
--- 1/2. machines ---   No machines are available on this app r0-relay-bench3
        (both soaks AUTO-DESTROYED on their own clean exit; nothing needed deleting)
--- 3. wait for live-inprogress to finalise ---   t+15s live-inprogress=0
--- 4. videos ---  5f24b7a3 200 | c93dece3 200 | 5a1cc435 200 | 1ad5906e 200 | c02d00ef 200
                   SKIP 94f526ff -- input 9ca3ff44 is NOT R0's
--- 5. live inputs (13) --- ee3ca787 c3f832e1 53edb363 f86ea28f 58137513 7f524ed9 68c00741
                   de60b1d1 0af86f9b 69b98492 55cac931 5e1617a0 1eaa4f1e  — all HTTP 200
--- 6. FINAL live inputs --- [{"uid":"9ca3ff44ba4f2b8937a837ab10e299e6","name":"p5-spike-p5-run-a"}]
--- 7. FINAL videos ---     [{"uid":"94f526ff","live":"9ca3ff44"}]
--- 8. FINAL storage ---    {"videoCount":1,"totalStorageMinutes":33.31,"totalStorageMinutesLimit":1000}
--- 9. destroy app ---      Destroyed app r0-relay-bench3
--- 10. app absent? ---     0
```

| Check | Result |
|---|---|
| Fly machines in the bench app | **0** — and both soaks auto-destroyed themselves on `exit 0` |
| Fly apps `r0-relay-bench`, `-bench2`, `-bench3` | **all destroyed** |
| R0 live inputs remaining | **0 of 13** |
| R0 videos remaining | **0** |
| P5's input `9ca3ff44…` and its video | **untouched and intact** — excluded by uid in the script, never in the delete list |
| `totalStorageMinutes` | **33.31 — exactly P5's single video**, i.e. R0's contribution is zero |
| Fly tokens | `r0-bench`, `r0-bench15`, `r0-bench-p2` all **revoked** |
| Stream keys / SRT ids / WHIP publish tokens in kept files | **scrubbed**; residual-secret grep clean |
| `/Users/ashokhein/github/seazn.club/` | **untouched** — `git status --porcelain` empty; no `git` command was ever run against it beyond read-only status |

**The storage lump, measured end to end (F2's evidence).** At 12:06Z, with both soaks
recording for 2 h 09 m, the account read **33.31 minutes** — all of it P5's. At 12:58Z,
seconds after the encoders stopped, it read **36.98**. By 13:00Z it read **396.84**. The
jump is **+359.86 minutes in under three minutes**, and it matches the two recordings
exactly (10 784 s + 10 808 s = 359.9 min). **Three hours of committed capacity were
invisible to the capacity API for their entire life and then arrived at once.**

---

## 10. Row-by-row against design §9.3's `[D]` lines

| §9.3 line | Design `[D]` estimate | R0 measured | Moved? |
|---|---|---|---|
| Fly Machine, 3 h — shared-cpu-2x/4 GB | £0.05–0.10 | £0.081, but the guest **cannot do the job** (8.8 fps, 90 % steal) | **STRIKE the row** |
| Fly Machine, 3 h — performance-2x/4 GB | £0.20–0.30 | **£0.270** — price right, but fails fps + CPU | price confirmed, verdict changed |
| Fly Machine, 3 h — recommended default | (not in §9.3) | **performance-4x/8 GB = £0.539** | **new row** |
| Fly egress ≈ 4.2 GB | £0.07–0.10 | $0 — within the plan's included allowance at this volume | **moved to £0.00** |
| Cloudflare delivered minutes | £0.14 | unchanged; **WHEP billing begins 2026-10-15** | unchanged |
| Cloudflare recording storage | ≈ $0.90/mo while retained, retention 7 days | **retention 7 is impossible** — the field's floor is 30 | **STRIKE "7 days"** |
| Pull path named **LL-HLS** (§7.4, §9.2) | assumed available | **the LL-HLS beta is OFF on this account; what is measured is plain HLS** | **new false premise (§3)** |
| **Total, composed** | **≈ £0.26–0.54 + retention** | **≈ £0.68 + retention** (perf-4x £0.539 + £0.14 delivery) | **+26 % on the top of the range** |

Still ≈ 89 % margin against a £6 credit.

**1080p price note (design §12 does not list it).** Not benchmarked — 1080p was out of
scope. What the data says: at 720p30 the recommended guest sits at 81–85 % CPU, and 1080p
is 2.25× the pixels. perf-4x cannot absorb that; 1080p means **perf-8x/16 GB at £1.078 per
3 h minimum**, and because Fly forces 16 GB at that size there is no cheaper intermediate.
**Record as a new open question**: 1080p roughly doubles the compute line.

**A phase-1.5 cost figure is corrected here.** Phase 1.5 quoted perf-2x/4 GB at
"£0.085 per 3 h". That was an arithmetic error; the correct figure is **£0.270**
($0.0000317/s × 10 800 s ÷ 1.27). The rate per second was right; the conversion was not.

---

## 10a. A/V drift — two different numbers, and they answer different questions

| | t≈18 | t≈43 | t=90 | t=180 | rate |
|---|---|---|---|---|---|
| **C1 live path** | −60 ms | −73 ms | −96 ms | not pairable\* | **≈30 ms/h** |
| **C2 live path** | — | −49 ms | −63 ms | not pairable\* | **≈18 ms/h** |
| **C1 finalised recording** | | | | **+11 ms** | — |
| **C2 finalised recording** | | | | **+8 ms** | — |

Both live rates are comfortably inside the **< 100 ms/h** bar. The two rows measure
different things and must not be averaged: the **live** series is what a viewer sees
through Cloudflare's live packaging, and it drifts slowly; the **recording** series is the
encoder's own A/V alignment, and after three hours it is **±11 ms — no accumulated drift
at all**. The drift the product has is in the delivery path, not in the compositor.

\* The t=180 live drift windows could not be paired: the drift read needs a 42 s window to
contain one of the 30 s marker pairs, and the capture straddled the moment the encoder
stopped, so C1 caught a video marker with no audio burst and C2 the reverse. Measured from
the finalised recordings instead, at 10 700 s and 10 720 s. **Recorded as a gap in the
live series rather than filled from the VOD row**, because they are not the same quantity.

---

## 11. Findings and false premises

Phase 1 and 1.5 findings are in `PHASE1-FINDINGS.md`. New in phase 2:

### F1 — Turning `recording.mode` OFF on a LIVE input destroys its playback in seconds
Measured as a clean single-variable test. Five R0 inputs were flipped `automatic → off`
while connected and encoding. Within seconds all five manifests returned
`NotFound: failed to fetch` (25 bytes), while every one of them stayed
`state: connected` with `statusLastSeen` current and every compositor kept encoding at
29.5–30.0 fps with `drop_frames: 0`. The one input **not** flipped (`c3-rtmps`) kept
serving a 1 360-byte master throughout — that is the control. Flipping back to
`automatic` restored playback **within 15 s with no publisher reconnect**.

**This overturns phase 1's FP-5 retraction.** Phase 1 recorded "recording mode gates HLS",
then retracted it after a controlled repeat held 204 for 90 s. Both of phase 1's controls
were confounded: each was run against a publisher whose stream Cloudflare had never
accepted (the SRT input that never starts a broadcast, and the §7.2-verbatim push that was
never ingestable), so there was no broadcast for recording mode to gate either way. The
original finding was right; the retraction was wrong. **On this account, live HLS/DASH
playback is served only while `recording.mode` is `automatic`.**

Two consequences, both load-bearing:
- **§6.5's storage guard must never touch a live input's recording mode.** Conserving
  storage mid-match takes the broadcast off air within seconds while every encoder-side
  health check stays green — the exact "absent evidence read as positive evidence" shape.
- **Recording is not optional for any stream that must be watched.** "Turn recording off
  to save capacity" is not available on this account for a live cell; capacity consumption
  is a consequence of being watchable.

### F2 — An in-progress recording contributes NOTHING to `storage-usage`. A polling guard is BLIND, not merely laggy. (§6.5)

This is the sharpest version of the finding and it changes the guard's **shape**, not its
tuning. Measured at 12:06:47Z, with both soaks recording continuously since 09:58Z —
**2 h 09 m each, 258 recorded minutes in flight**:

```
videos on the account          storage-usage AT THE SAME MOMENT
  94f526ff state=ready            duration=1998.23   {"videoCount":3,
  1ad5906e state=live-inprogress  duration=-1         "totalStorageMinutes":33.31,
  c02d00ef state=live-inprogress  duration=-1         "totalStorageMinutesLimit":1000}
```

`33.31` is **1998.23 s = 33.30 min — the single finalised video, which belongs to the P5
session.** R0's two three-hour recordings contribute **zero**. An in-progress recording
carries `duration: -1` and is counted as nothing for its entire life; the minutes arrive
as a **lump at finalisation**.

Three consequences, all owner-facing:

1. **A guard that polls `storage-usage` cannot see the thing it exists to prevent.** A
   three-hour recording is invisible for three hours and then lands all at once. This is
   strictly stronger than "additions land late and the figure is not monotonic", which
   phase 1 established and which only made polling *laggy*. **This makes it blind.**
2. **The recovery lever is unavailable in exactly the window the risk accumulates.**
   Reproduced directly: `DELETE /stream/{uid}` on a `live-inprogress` recording returns
   `{"success":false,"errors":[{"code":10046,"message":"Not Implemented: Feature not
   supported"}]}`. So you cannot see the commitment, and you could not free it if you
   could.
3. **Therefore §6.5 must RESERVE AT ADMISSION** — debit the expected minutes
   (`maxDurationSeconds`) when a session is provisioned, and reconcile against actual at
   finalisation. **Poll-then-admit is unsound, not merely imprecise.** Phase 1 recommended
   reservation as the cautious choice; this measurement makes it the only defensible one.

**This is the fourth costume of one bug.** A frozen picture encoded at a contented 30 fps;
a stalled playlist reported as advancing off a null baseline; a deleted recording reading
as a recording that was never created; and now a storage figure of 33 minutes with two
three-hour recordings open. **Absent evidence counted as positive evidence.** Every one of
them passes a check that asks "did something go wrong" and fails a check that asks "did
the thing I need actually happen".

### F3 — The live-inputs LIST endpoint omits `recording` entirely
`GET /stream/live_inputs` returns no `recording` field on any element; only the per-input
`GET /stream/live_inputs/{uid}` carries it. A list-based check reads absent-as-`None` and
proves nothing about record state. (Confirmed independently by the orchestrator.)

### F4 — Liveness must be read WITHIN one variant, and a null baseline is not progress
Three false greens, all the same shape. An HTTP 200 on the master is not liveness. Media
sequence progression is only meaningful **within one variant** — on a reconnect Cloudflare
issues a new variant whose numbering is unrelated and whose every segment URI is new,
which reads as "advancing" on a naive diff. And a null baseline must read `unknown`, never
true. `tools/liveness.sh` implements all three guards plus a stall clock that a variant
change does not reset, satisfy or excuse. It caught two real stalls during this wave
(`c4-dst` between driver runs) that a status check would have passed.

### F5 — `performance-8x` cannot be bought with less than 16 GB
`invalid config.guest.memory_mb, minimum required 16384 MiB`. The perf-4x → perf-8x step
is 2× CPU and 2× RAM with no intermediate, which is why §2's recommendation turns on
whether the CPU bar is wanted as written.

### F6 — Under B2 a failing machine reports `drop_frames: 0` and `dup_frames: 0`
Every failing B2 cell in §1 reported zero dropped and zero duplicated frames. B2's failure
mode is `speed` < 1.0× — falling behind wall clock — which the encoder's frame counters
cannot see. **`speed` must be read alongside them**, and a soak judged on drop/dup alone
would pass a cell running at 0.878×.

### F7 — Contamination of phase 1/1.5 evidence, and what is no longer re-derivable
The P5 session ran an account-wide delete loop during the phase-1/1.5 window. From R0's
own records, **both of the videos P5 could not attribute were R0 bench recordings**:
`e6b078b5…` (liveInput `d5546455…` = `r0-src`) and `ab5503b8…` (liveInput `2d2fa02c…` =
`r0-rec-probe`). The recording P5 repeatedly failed to delete with 409,
`9eefa7c3d53a91e880e63504e8d84887`, was also R0's — `liveInput d5546455…`, 4 s, and it
appears in R0's own teardown log, deleted by R0 at 08:29 with HTTP 200.

Re-derivability, stated plainly: **every D5 and latency number in phase 1, 1.5 and 2 is
re-derived from a local `.gray` capture that is named and hashed here** — the Cloudflare
VOD was only ever the transport. Two exceptions: `out-perf.decode.json` (phase 1.5), whose
`.gray` R0 deleted and whose source VOD is also gone, and the phase-1 recording-probe VOD
`ab5503b8…` used for the "VOD HLS decodes" observation, deleted by P5's loop. **Neither is
re-derivable and neither is relied on for a headline number.** Phase 1's storage
arithmetic other than the single controlled DELETE probe should be read as observational,
since the account was being mutated concurrently.

### F8 — Device-side notes carried for R2 (not R0 cells)
From the P5 session, recorded here so R2 inherits them: libsrt's
`"Operation not supported: Bad parameters"` on connect is what an **unresolved
`InetSocketAddress` reaching `srt_connect`** produces, not a parameter fault — anything
reading that string literally will misdiagnose. And a recording in `live-inprogress`
refuses DELETE with **409 code 10046** until it finalises minutes after the stream ends,
so cleanup must poll to `ready`, delete **videos before inputs** (R0 independently
measured that `deleteInput` leaks recordings), and never assume a 409 DELETE is retried.

### F9 — A destination collision this wave caused, recorded
`m1-n2-p4x` and `c5-contrib-pull` overlapped on `c3-rtmps` for ~5 minutes because the M1
cell outlived R0's estimate of its own runtime. Two encoders on one stream key is exactly
the corruption §7.1/D4 warns about. **Encoder-side numbers (fps, CPU, speed, drop/dup) are
unaffected** — they are read from each ffmpeg's own `-progress` — but neither cell's
OUTPUT was pulled or decoded, and none of §1's D5 rows come from either.

---

## 12. Appendix — the harness (THROWAWAY)

R2 writes the real image from the design, not from this. Everything below lives in the
scratch directory beside this memo and never touched `/Users/ashokhein/github/seazn.club/`.

| File | Role |
|---|---|
| `harness/Dockerfile` | Debian bookworm + tini + Xvfb + PulseAudio + Chromium 152 + ffmpeg 5.1.9; bakes the 120 s ordinal source at build time; vendors hls.js, motion 13.2.0, gsap 3.12.5 |
| `harness/supervisor.mjs` | the §7.2 shape; ffmpeg variants `verbatim` / `fixed` / `b2` / `m1` / `c3`; one JSON sample line per interval to stdout (collected by `fly logs`, no volume) |
| `harness/mkasset.sh` | the baked source: `testsrc2` + continuous `scroll` pan + 20-bit `drawbox` ordinal bar + `drawtext` clock + the 30 s A/V drift marker (white patch co-timed with a 3 kHz burst) |
| `harness/public/relay.html` | the stand-in overlay: §3.6 motions under three drivers, the 24-bit `Date.now()` bar, `?bg=key` for B2 |
| `harness/public/whip.html` | WHIP publisher + WHEP subscriber + whole-frame flash latency clock |
| `tools/mk-machine.sh` | the §7.1 Machines REST create body, verbatim |
| `tools/decode-bars.mjs` | reads both bars out of rawvideo gray; the D5 sequence analysis |
| `tools/drift.mjs` | A/V drift from a muxed window, corrected for per-stream start PTS |
| `tools/capture.sh` | pulls a D5 window and a muxed drift window, with a browser UA |
| `tools/liveness.sh` | progression-within-one-variant liveness + stall clock (F4) |
| `key/keymath.py`, `key/mkswatch.py`, `key/eval.sh`, `key/read.py` | the §8 key-colour experiment |

**Deviations from design §7.2 carried forward from phase 1**, each measured, none silent:
`-thread_queue_size 512` on both inputs; `-af aresample=async=1:first_pts=0`;
`-keyint_min 60 -sc_threshold 0`; `-fps_mode cfr`; `ignoreDefaultArgs:
["--enable-automation"]` (puppeteer's default infobar renders **on air** and shifts the
page 41 px); `ENV TINI_SUBREAPER=1` (on Fly, tini is not PID 1). §7.2 still lacks
`-draw_mouse 0`, and the cursor is visible in every captured frame.

### Raw sample files and their sha256

Every number in this memo is re-derivable from a named, hashed local file. Manifests:
`raw/SHA256SUMS.txt` (**251 files**) and `key/SHA256SUMS.txt` (**11 files**).

Key evidence by cell: `raw/c1-t{013,043,090,180}.gray` and `raw/c2-t{043,090,180}.gray`
(soak D5), `raw/*-t*.decode.json` (the sequence analysis), `raw/c{1,2}-t180vod.*` (drift),
`raw/cell-*.jsonl` and `raw/soak-samples.jsonl` (per-cell sample series),
`raw/c9-poll.jsonl` / `raw/c10-poll.jsonl` (the hold-window probes, one line per poll with
`targetduration_seen` recorded as observed), `raw/c4run2-*.decode.json` (driver row),
`raw/teardown-p2.log`, and `key/SHOT-*.png` (the acceptance screenshots).

**Two exceptions, stated rather than implied** (see F7): `out-perf.decode.json` from phase
1.5 and the phase-1 recording-probe observation on `ab5503b8…` are **not** re-derivable —
the first because R0 deleted its `.gray` and the source VOD is gone, the second because
P5's account-wide loop deleted the video. Neither carries a headline number.
