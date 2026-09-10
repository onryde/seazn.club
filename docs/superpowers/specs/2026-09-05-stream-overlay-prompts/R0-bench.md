# R0 — the bench spike (memo only, no repo code)

**Wave:** R0 · **PR:** none — the deliverable is ONE numbers memo committed
at `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/R0-memo.md`
(docs-only commit by the orchestrator). **Gate to start:** the owner names
the Fly organisation and the Cloudflare account to spend on (design §12,
recorded in `_INDEX.md` when answered). **Depends on:** nothing in the repo;
runs in parallel with T1 and W1 from the day the accounts are named.
**Gates:** R2 — *"no compositor product code before the memo"* (design §8).
Passthrough (R1) and Tier A ship regardless of R0's verdict. **Model:**
`model: opus`. **Worktree:** none required (a scratch directory outside the
repo for the harness; nothing under `apps/`, `packages/`, `db/` is created).

Read first: the design of record `../2026-09-07-streaming-programme-design.md`
§7.1 (Fly Machines — the runner under test), §7.2 (container and the
verbatim ffmpeg line), §8 (this spike, the authority), §9.1–§9.3 (the
numbers the memo replaces), §6.5 (the storage-headroom read the memo must
find), §13.3 (watch list rows R0 closes); `RULES.md` §"Owner checklist"
PRODUCT-OWNER LENS rows.

## Why the wave exists

One open technical bet: does a headed Chromium under Xvfb, captured by
`x11grab` and encoded by x264, hold 720p30 for three hours on a Fly Machine
— and at which size? Everything else in Tier B is plumbing. The design's
Fly cost lines are class [D] estimates (design §9.3, "R0 replaces"); the
memo turns them into the account's own numbers and picks the Machine size
R2 wires as default. It also settles the pull path (WHEP latency vs LL-HLS)
that seeds `delayMs`.

## Owner rulings that bind this wave (verbatim, dated)

- 2026-09-07, decision A → *"all ok"*; refined by the owner's question *"are
  you saying that we can spin a flyVm for temp to run the compositor? can we
  invoke the flyway dynamically in the particular region or no need?"* →
  answered yes: a Fly Machine per session, `region "lhr"`, `auto_destroy`;
  Cloud Run dropped (`_INDEX.md` ruling 19, design FS5). **R0 benches Fly
  only.**
- 2026-09-07, decision B → *"all ok"*: Cloudflare Stream is the front door
  (SRT in, WHEP/LL-HLS out).
- 2026-09-07, decision G → *"all ok"*: 720p30 only at launch; 1080p is a
  post-R0 price note, not a bench cell.
- 2026-09-10, ruling R-B (recorded in `_WAVE-2026-09-10-r2-prep.md`; a
  recorded ruling, not a verbatim quote): multi-camera is wanted LATER with the
  seams shaped NOW — boundaries that cannot be refactored unilaterally get
  shaped for N today. **M1 lands in this bench as rows rather than a wave of its
  own**, because R0 is already sizing the guest for 1x and the compute answer
  gates every later multi-cam estimate.
- `RULES.md` checklist: "Recommendation states the OWNER's value/cost" —
  the memo's verdict is a recommendation with £/match attached.

## Scope — one memo, ≤ 2 pages plus tables

1. **Harness** (throwaway, outside the repo, labelled as such): the design
   §7.2 container — tini → node supervisor → Xvfb `:99` 1280×720 → PulseAudio
   null sink → Chromium headed on `:99` via puppeteer (`--kiosk
   --autoplay-policy=no-user-gesture-required`, SwiftShader) → ffmpeg with
   the §7.2 line VERBATIM (`-f x11grab -framerate 30 -i :99 -f pulse -i
   default -c:v libx264 -preset veryfast -b:v 3000k -maxrate 3000k -bufsize
   6000k -g 60 -bf 2 -pix_fmt yuv420p -c:a aac -b:a 128k -ar 48000 -f flv
   <rtmps>`). Stand-in relay page: any WHEP/HLS `<video>` under a CSS-animated
   scorebug that mimics the tick (scale 1.0→1.12→1.0, 300 ms) and the LED
   slide (200 ms) at the §3.6 cadence, with a visible 1 Hz clock.
2. **Source**: `ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=30` (+ a
   1 kHz tone with a clap burst every 90 min for A/V drift) → SRT into a
   Cloudflare Stream live input created with `recording { mode: "automatic",
   timeoutSeconds: 30 }`, `deleteRecordingAfterDays: 1`.
3. **Matrix**: `{ shared-cpu-2x / 4 GB, performance-2x / 4 GB }` × `{ B3
   browser-as-compositor, B2 chroma-key over ?bg=key }` × 3 h, all in `lhr`,
   created through the Machines REST API exactly as §7.1 describes
   (`POST /v1/apps/<bench app>/machines`, `region`, `config.guest`,
   `config.auto_destroy: true`) — the create/stop/delete calls themselves are
   part of the measurement (create-to-first-frame seconds per size).
   **Multi-camera decode rows (M1, ruling R-B) — beside the 1x cells, not
   instead of them**: `{ 2, 4 }` concurrent WHEP receivers on ONE relay page at
   BOTH guest sizes (the same 720p30 source pulled N times, page compositing
   live, scorebug ticking), 20 min per cell — this sizes COMPUTE, it does not
   soak, so it does not buy four more 3 h runs. Record per receiver: decoded
   fps and dropped frames; and per cell: total CPU % trend, RSS, and whether the
   OUTPUT still holds 30 fps under scope 5's bars. Do not extrapolate 2x from
   1x — decode, compositing and page memory do not scale at one rate; the memo
   reports the measured curve.
   *Rationale (state it in the memo, it is why the rows exist):* R0 sizes the
   guest for ONE software-decoded 720p WebRTC stream. Multi-camera later means N
   receivers PLUS page compositing on the SAME Machine, so if N does not fit an
   economic guest then "the interfaces make it easy to extend" is false at the
   COMPUTE layer however clean the interfaces are. Standing this bench up again
   later costs the bench; one extra row now costs a row.
   *The shape these rows justify or rule out — record it either way:* the
   broadcast fallback is **program-plus-preview** — two receivers hot, the rest
   cold, accepting 1–2 s of WHEP renegotiation when a third is pulled up. If 4x
   holds the bars at an economic size, the fallback is unnecessary and multi-cam
   may keep every source hot; if only 2x holds, program-plus-preview is the
   design multi-cam MUST adopt and the memo says so; if 2x fails, multi-camera
   does not fit this compositor at all, which is a product finding for the owner
   (and speaks to M4).
4. **Record per cell**: sustained fps and CPU % trend (1-min samples);
   dropped frames (ffmpeg `-progress` `drop_frames`); A/V drift at 0 / 90 /
   180 min (clap-sync on a destination capture); tick smoothness in the
   OUTPUT (frame-step a 10 s capture at each hour; count duplicate/skipped
   frames across one tick); **frame timing (D5)** — burn a monotonic frame
   ordinal into the source beside the clock, decode a 10 s window of the OUTPUT
   at 0 / 90 / 180 min and read the ordinal sequence: report duplicated frames
   and gaps per minute and the longest clean run between anomalies, over content
   that PANS continuously (a horizontal scroll across the full frame, not
   `testsrc2` alone — judder shows on pans, which football and cricket cameras
   do continuously). The row is a measurement of the decoded sequence, never
   "video appeared"; pull-leg latency per path — WHEP AND LL-HLS —
   measured as wall-clock delta between the source clock burned into
   `testsrc2` and the composited output; any Fly host event (Machine
   restart, migration notice, `fly machine status` events); egress bytes
   (Fly dashboard) vs the bill line; Cloudflare account limits hit
   (concurrent live inputs, ingest caps); **the storage-headroom read**: the
   dashboard field or API response the §6.5 guard will poll, its exact path
   and refresh cadence.
5. **Verdict lines**, one per cell: PASS/FAIL against CPU < 80 % sustained,
   drift < 100 ms/h, 30 fps held (no minute below 29.5); **frame timing (D5):
   zero duplicated frames and zero gaps in each 10 s ordinal window** — a held
   30 fps AVERAGE and a flat drop-frame trend both survive a duplicate every few
   seconds, so this bar is separate and is the one that answers smoothness; an
   **N verdict for the M1 rows** (the largest N holding these same bars at an
   economic size, and whether program-plus-preview is therefore required); the
   Machine size
   recommendation R2 wires as default with £/3 h from the account's rate
   card; B3 vs B2 verdict (B2 stays the documented fallback ONLY if B3 fails
   at both sizes); the 1080p / next-size-up price note for the owner's later
   ruling (design §12 does not list it — record it as a new open question if
   1080p moves).
6. **Acceptance artefacts**: the memo; every table filled (a blank cell is a
   FAIL, not a gap); one composited screenshot per cell over a light AND a
   dark frame; the harness's Dockerfile and scripts attached to the memo as an
   appendix marked THROWAWAY (R2 writes the real image from the design, not
   from the bench).

## Out of scope

Any file under `apps/`, `packages/`, `db/`, `.github/`; a Fly app named
`seazn-relay` (the bench uses a scratch app the memo names and DELETES at the
end); any Cloudflare live input left running; 1080p cells; the phone.

## Do NOT touch

The repo. The production or staging Fly apps. Cloudflare inputs belonging to
any other purpose. The design of record (a number the memo disagrees with is
a FINDING in the memo, carried to `_INDEX.md` by the orchestrator).

## Acceptance — the four kinds, adapted to a memo

- **Unit**: none (no code kept). The harness scripts run once from a clean
  checkout of the appendix — recorded as "reproduced: yes/no" in the memo.
- **E2E**: the 3 h cell run IS the e2e; its pass/fail lines are the named
  assertions (CPU, drift, fps, latency, host events).
- **Smoke**: after every cell, `GET` the Cloudflare input's status shows
  `disconnected` and `fly machines list` shows zero Machines in the bench app
  — nothing left billing (memo table "teardown").
- **Regression**: none in the repo. The memo's numbers are compared against
  design §9.3's [D] lines row by row; every row that moved is listed.
- **Mutants**: not applicable to a memo; the honesty check instead — the
  memo names the raw sample files (CSV per cell) and their sha256, so a
  number can be re-derived.

## Checklist rows this wave satisfies

PRODUCT-OWNER LENS: "Always give a recommendation, framed as product owner";
"Recommendation states the OWNER's value/cost"; "Review findings → written to
disk"; "One authority per fact" (the memo replaces §9.3's [D] lines, it does
not sit beside them); "Surface bench/product gaps to owner". VERIFY-AS-
CUSTOMER: "Verify visually, always" (the composited screenshots).

## Verify

There is no repo command. The orchestrator checks: the memo file exists at
the path above; each of the four soak cells AND each of the four M1 decode
cells (`{ 2, 4 }` receivers × both sizes) has a verdict line, and the frame-
timing bar (D5) is reported per cell as its own line rather than folded into
fps; the teardown
table shows zero Machines and zero live inputs; the appendix is marked
THROWAWAY. Final message under 15 lines — cell verdicts, Machine size
recommendation, WHEP vs LL-HLS latency, cost per 3 h, blockers.

## Dispatch notes

- One agent, `model: opus`, given the two account names and a spending cap
  the owner states (the memo records the actual spend against it).
- The agent never touches the repo worktree; its final message is the memo's
  verdict block. The orchestrator commits the memo.
- If any cell cannot run (account limit, missing permission), the memo says
  which and why — a blank cell is never silently filled by extrapolation.

## False-premise watch list

1. That `x11grab` at 30 fps on a `shared-cpu-2x` leaves headroom for
   Chromium — the whole bet; measured, never assumed.
2. That WHEP playback is available on the account's Stream plan — closed as
   available by the official pricing doc (design §9.2, billing from
   2026-10-15) but the account may sit on a plan that gates it; record what
   the API returned.
3. That SwiftShader (software GL) is fast enough for CSS transforms at 720p —
   if not, the memo says which Chromium flags were needed and the CPU cost.
4. That Fly's `auto_destroy` fires on a non-zero exit — verify on a forced
   crash; the R2 retry design (§6.4) depends on the Machine being GONE.
5. That the storage-headroom figure is readable by API at all — if only the
   dashboard shows it, that is a finding for §6.5's guard (poll cadence
   becomes a manual runbook step until Cloudflare exposes it).
6. **That a held 30 fps means SMOOTH motion (D5).** Watch 1 asks whether
   capture WORKS at 720p — a question about capture, not about smoothness.
   `x11grab` polls `:99` on a 30 fps clock while Chromium paints on its own
   schedule under SwiftShader; the two clocks beat, and the periodic duplicate
   and dropped frames that result pass both the fps bar and the drop-frame
   trend. Settled ONLY by scope 4's frame-ordinal row on panning content, never
   inferred from fps, and never from "the picture looked fine".
7. That N-way WHEP decode scales linearly from the 1x cell (M1) — 2x and 4x are
   measured cells, not arithmetic; if a cell cannot run, the memo says which and
   why, and program-plus-preview stays unruled rather than assumed.
