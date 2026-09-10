# R2 — the compositor: relay page, slate, delayMs, the Machine image, the soak

**Wave:** R2 · **PR:** PR-R2 · **Gate to start (HARD):** the R0 memo
(`R0-memo.md`) exists with a PASS cell and a Machine size — *"no compositor
product code before the memo"* (design §8); AND PR-R1 merged to `main`
(tokens, session API, `runner-fly.ts`, the Phone tab). T1a's slate artboard
picked (`_THEMES.md` §4a) — gates the VISUAL sign-off only. **Merge gate
(HARD):** one GREEN 3 h soak (design §10.3) — not a review. **Worktree:**
`.claude/worktrees/relay` (R1's), branch `feat/stream-relay-r2` cut from
`main` after PR-R1; env label `rly`; plus the new top-level directory
`relay-compositor/` for the image. **Model:** `model: opus`. **Plan:**
`../../plans/2026-09-07-streaming-r2.md` — written by a Fable agent AFTER the
R0 memo lands (design §11), re-pinning on the merged tree.

Read first: the design of record `../2026-09-07-streaming-programme-design.md`
§7 (the authority: runner, container with the verbatim ffmpeg line, relay
page, failure choreography, slate), §3.3 (the hook's `delayMs` and
`presentationNowOffsetMs`), §3.6 (the football clock under delay), §6.4, §6.6
(G1 — page token), §8 + the R0 memo (Machine size, pull path, `delayMs`
seed), §9.1, §9a, §10.3 (the soak); `_THEMES.md` §4a (slate) and §6 (motion);
`_RULES.md` R13, §Repo traps, §Shell guard; `RULES.md` §"Owner checklist";
`.github/workflows/placement-{ci,stg,prod}.yml` and `services/placement/fly.toml`
(the polyglot-deployable precedent the image workflows copy).

## Why the wave exists

The one invariant (design §1): every score pixel on every tier is rendered by
`/overlay/fixtures/[id]`. R2 is the customer of that route — a Fly Machine
running headed Chromium over the phone's video, capturing the composite and
pushing RTMPS. Nothing here draws a score; it draws the page. The relay page
adds the `<video>` under the unmodified stage, the slate for the moments the
camera is absent, and the `delayMs` seam W1 built so the score never runs
ahead of the picture.

## Owner rulings that bind this wave (verbatim, dated)

- 2026-09-07, decision A → *"all ok"*, refined: *"are you saying that we can
  spin a flyVm for temp to run the compositor? can we invoke the flyway
  dynamically in the particular region or no need?"* → a Fly Machine per
  session via the Machines API, `region "lhr"`, `auto_destroy: true`; no
  region hopping (Cloudflare ingest is anycast). Cloud Run dropped (FS5).
- 2026-09-07, decision G → *"all ok"*: 720p30; the ffmpeg line in design §7.2
  is binding VERBATIM (bitrate, GOP, B-frames, audio).
- 2026-09-06: the football clock ticks (1 Hz, phase-aware) and *survives
  reduced-motion because it is information* — under `delayMs` its offset
  comes from the hook, ONE authority (design §3.6).
- 2026-09-06 (Q7): themes are a REGISTRY — `slate` is one entry with
  `sports: "all"` plus one component (design §7.5).
- 2026-09-05: *"will we do animation when score?"* → three motions only; the
  slate's state changes are instant show/hide, not a fourth motion (R13).
- `RULES.md` checklist: "A comment in code is a HYPOTHESIS, not evidence" —
  the soak, not the supervisor's comments, proves the retry.

## Task 0 — re-pin on the merged tree

Read the R0 memo: Machine size (`guest { cpus, memory_mb, cpu_kind }`), B3 vs
B2 verdict, WHEP vs LL-HLS latency (seeds `delayMs` default), host events
observed, the storage-headroom read. Re-pin R1's symbols on `main`:
`server/relay/runner-fly.ts` (the `guest` constant), `server/relay/tokens.ts`
(page-token verify), `stream-sessions.ts` transitions (`warming` → `live` on
`playing`), the heartbeat route, `use-live-fixture.ts` (`delayMs`,
`presentationNowOffsetMs`), `OVERLAY_THEMES` and `resolveTheme`,
`overlay-stage.tsx`'s clock interval. `ls db/migration/deltas | sort -V |
tail -1` (R2 needs no migration; confirm and say so).

## Scope (build order; values from the design § cited)

1. **Relay segment** `apps/web/src/app/overlay/fixtures/[fixtureId]/relay/{layout,page}.tsx`
   (new): server gate `?st=<page token>` verified by `tokens.verify(scope:
   "relay-page")` + session active (`state ∈ warming|live|ending`) + fixture
   visible → else `notFound()` (404 ≡ missing; 410 from the token module on a
   terminal session maps to 404 here — the page never explains); `robots
   noindex`; sets NO cookies (asserted in the e2e — the cookie banner
   suppression from W1 covers `/overlay/*` by prefix). Renders `<video
   data-testid="relay-video" autoplay playsinline>` with the WHEP →
   LL-HLS ladder (WHEP first per the memo; LL-HLS when WHEP fails within 5 s)
   UNDER the unmodified `<OverlayStage>`; the stage receives `delayMs` from a
   page-level state the supervisor sets (scope 4).
   **M3 — the playback source is read from the `slot = 0`
   `fixture_stream_inputs` row, and R2 only READS it.** R1 writes exactly one
   input row, inside the session insert's own transaction. Nothing in R2
   inserts, updates or deletes one: the compositor is a CONSUMER of the ingest
   input, not its provisioner, so R2's half of the design's "R1 and R2 at slot
   0" line is a READ, and this prompt states it that way rather than leaving
   the reader to infer a second writer that does not exist. The read is by
   EXPLICIT predicate — `where session_id = $1 and slot = 0` — never `limit 1`
   and never `order by created_at`, both of which return the right row today,
   for the accidental reason that there is only one, and silently pick an
   arbitrary camera the day multi-cam inserts a second. EMPTY case: a session
   with no slot-0 row is `notFound()`, the same 404 the page gives every other
   refusal (the page never explains); it must NOT fall through to a default or
   an empty `src`, which paints a live-looking black frame that every
   downstream check — frame count, stream presence, the destination never
   ending — reads as healthy. R2 needs NO `ingest_rtmps_*` credential: the
   compositor plays BACK from Cloudflare, it does not contribute, so the dual
   credentials R1 now stores (C1/R-A) are the phone's, and
   `server/relay/crypto.ts` remains the only module touching a `*_enc` column.
   **D1 — the element carries NO `muted` attribute, and the e2e asserts its
   absence.** A muted media element sends nothing to the audio device, so
   `-f pulse -i default` encodes silence for the whole match — the broadcast
   ships mute and nothing in the chain says so. The attribute is prompt-versus-
   design drift: §7.3 specifies no attributes at all, and §7.2 calls the null
   sink "one A/V clock", which only holds if the page actually plays audio into
   it. It is not buying autoplay either — the container launches Chromium with
   `--autoplay-policy=no-user-gesture-required` (scope 5), which is intended to
   make autoplay unconditional on `:99`.
   **PREDICTED, NOT MEASURED (2026-09-10):** that flag has never been run in
   this repo. No compositor exists in the tree, no container has booted, and
   nobody has watched an unmuted `<video>` autoplay under it — the claim rests
   on the flag's documented behaviour, not on an observation, and the e2e that
   asserts `muted` is absent does not settle it either, because that test runs
   in an ordinary browser rather than in the container. Treat it as the
   hypothesis that makes dropping `muted` safe, and CONFIRM it at the first
   container boot in scope 5; T1's level floor is the assertion that would
   catch its absence. If the flag turns out to be insufficient, the remedy is
   container-side and goes in the memo — NEVER restoring `muted`, which is
   mutant (g). **Pairs with D2** (§7.2's container boot
   loads `module-null-sink` but never `set-default-source <sink>.monitor`, so
   `-i default` resolves to nothing and ffmpeg either errors at start or
   captures silence): these are two INDEPENDENT ways to ship silence, and BOTH
   must land or T1's level floor still fails and reads as the first fix not
   working. Neither fix is provable without the other.
2. **Page states from the element's own events** (design §7.3):
   `waiting` → warming slate; `stalled` for > 8 s → signal-lost slate;
   `playing` → live (slate hidden); `ended` → ended slate. A pure reducer
   `relayPageState(prev, event, nowMs)` in `components/overlay/relay-state.ts`
   (unit-tested as a table); the component reports every state change and
   `measuredLatencyMs` through `window.relayReport({ videoState,
   measuredLatencyMs })` when the supervisor has exposed it (feature-detected;
   absent in a normal browser). `measuredLatencyMs` = the burned-in source
   clock (R0's method) vs `performance.now()` when the memo says it is
   readable, else the WHEP stats API's `jitterBufferDelay`; the page never
   guesses.
3. **Slate** — `OVERLAY_THEMES.slate` (`sports: "all"`, the one opaque theme;
   `components/overlay/overlay-slate.tsx`) rendering the three states with
   values from `_THEMES.md` §4a and the `OVERLAY_TOKENS` export (T1b); the
   ended state carries the `result` line when decided. `resolveTheme` keeps
   the `bar`/`bug` defaults — `slate` is chosen by the relay page, never by
   `?style=` (a club cannot pick a slate for OBS).
4. **`delayMs` wired end to end**: the hook's buffered mode (W1 built it
   inert-proof with a unit) gets its real consumer — the stage's clock reads
   `presentationNowOffsetMs`; the supervisor sets `delayMs` through
   `page.evaluate` from `measuredLatencyMs` (auto-tune: EWMA, clamp 0–10 s,
   step ≤ 250 ms per beat) and the session's `overlay_delay_ms` (organiser
   nudge from the Phone tab, R1 hid the control until now — unhide it,
   ± 250 ms). **Alignment e2e** (mutant "drop the clock offset"): with
   `delayMs = 3000` a posted goal and the clock advance land TOGETHER in the
   DOM (design §10.2).
   **D3 — the ramp SNAPS on a transport change, and resumes EWMA after.** The
   ≤ 250 ms-per-beat clamp cannot cross a WHEP → LL-HLS transition: the ladder
   falls back after 5 s, roughly a 0.5 s → 6 s step, which at ≤ 250 ms per 15 s
   beat is ~22 beats — about **five and a half minutes of score running AHEAD
   of picture**, at exactly the moment the transport degrades and a viewer is
   least forgiving. The clamp is right for DRIFT and wrong for a
   DISCONTINUITY. Rule: on a transport change — WHEP → LL-HLS, LL-HLS → WHEP,
   or any `<video>` element retry that re-establishes the source — the
   supervisor SNAPS `delayMs` to the fresh `measuredLatencyMs` in ONE beat and
   resets the EWMA accumulator; the ≤ 250 ms clamp is suspended for that beat
   only and binds every beat after. The 0–10 s clamp still binds the snapped
   value, and the organiser's `overlay_delay_ms` nudge survives the snap (it
   is an offset on the tuned value, not a competing authority). The page
   reports the transport it is on with each `relayReport` so the supervisor
   can see the change without guessing; §3.3 carries the same rule.
   **T3 — convergence is a UNIT, because the alignment e2e cannot see it.**
   The alignment e2e pins `delayMs = 3000` statically, so the ramp is never
   exercised at all: mutant (a) kills a dropped clock offset and nothing in
   the killer list kills "ramp too slow", which IS D3. Extract the auto-tune
   as a pure controller — `relayDelayController(prev, { measuredLatencyMs,
   transportChanged }, cfg)` in `components/overlay/relay-delay.ts` — and unit
   it in `relay-delay.test.ts` (acceptance below). It must include a **STEP
   INPUT** row with a **bounded time-to-converge**, and the bound must be
   DERIVED from the exported clamp constants, never a literal typed into the
   test, so moving the clamp moves the bound with it.
5. **The image** `relay-compositor/` (new, top-level, the placement layout):
   `Dockerfile` (tini, Xvfb, PulseAudio, Chromium, ffmpeg, node 26),
   `supervisor.ts` — boot sequence per design §7.2 (Xvfb `:99` 1280×720 →
   pulse null sink → puppeteer launches Chromium HEADED on `:99` with
   `--kiosk --autoplay-policy=no-user-gesture-required` and the memo's GL
   flags → `page.exposeFunction("relayReport", …)` → navigate ONCE to
   `${APP_URL}/overlay/fixtures/${fixtureId}/relay?st=${pageToken}` (fetched
   from `GET /api/internal/relay/sessions/[sid]` with the job token) →
   ffmpeg spawned with the §7.2 line VERBATIM from `warming` (slate frames
   keep the destination alive before the camera) → heartbeat every 15 s
   (`-progress` fps/bitrate/egress + the page's report) → on `desiredState ===
   "ending"` or SIGTERM: send `q`, wait ≤ 10 s for the flush, exit 0; any
   child death → exit non-zero (R1's sweep does the ONE retry). No inbound
   port. Env contract `{ SESSION_ID, JOB_TOKEN, APP_URL }` from `runner-fly.ts`.
   **D4 — the Machine's restart policy is pinned to `no`.** The Machines API
   `config` this wave's image is launched under carries `restart: { policy:
   "no" }` explicitly — pinned in `runner-fly.ts` beside the `guest` constant
   (R1's file; R2 confirms the value and adds the assertion), asserted in its
   unit, and stated in `fly.relay.toml` so a hand-launched Machine inherits
   the same policy. It is written down rather than left to the platform
   default because "any other policy" is the failure: a non-zero exit restarts
   the Machine IN PLACE while R1's sweep independently creates a replacement,
   giving **two compositors on one session pushing one stream key**. YouTube
   receiving two encoders is visible corruption, not a clean failure — and the
   soak's Machine-kill check (scope 7) can pass straight THROUGH it, because
   the destination stream never ends, which is exactly what that check looks
   for. This sharpens R0 watch 4 (`auto_destroy` on non-zero exit): the retry
   design assumes the crashed Machine is gone before `create` runs again, and
   a restart policy other than `no` is the way that assumption fails silently.
6. **Workflows** `.github/workflows/relay-{ci,stg,prod}.yml` on the
   `placement-*.yml` pattern (read them: `superfly/flyctl-actions`, the
   app-name verification step, `concurrency`, prod on `v*.*.*` tags): CI
   builds the image and runs the supervisor's unit tests + a 60 s smoke
   composite against a local `testsrc2` HLS; stg/prod push
   `seazn-relay:<sha>` to the Fly registry — the Machine driver's `config.image`
   is a tag `runner-fly.ts` reads from env `RELAY_IMAGE`. Fly app
   `seazn-relay` in `lhr` created ONCE by hand (documented one-off, like the
   placement app), `fly.relay.toml` beside the Dockerfile.
7. **Soak harness** `relay-compositor/soak/` — `workflow_dispatch` only, never
   on push: synthetic SRT source (`testsrc2` + clap burst) into a real
   Cloudflare input, a scripted scorer posting a football ledger at a cadence
   (goal every 6 min, cards, half time), an UNLISTED destination, one real
   session through the real API on a staging server; asserts per design
   §10.3: zero manual interventions; the session row tells the whole story
   (every transition timestamped); drop-frame trend flat; drift < 100 ms/h;
   a mid-match SRT kill → slate ≤ 10 s → seamless resume; a Machine kill →
   invisible retry (same session, same creds, the destination stream never
   ends); screenshots composited over light and dark at 0 / 90 / 180 min.
   The memo of the green soak is attached to PR-R2.
   **T2 — the clap burst gets a CONSUMER (A/V sync row, explicit budget).**
   The harness already generates the clap burst — the standard A/V-sync test
   signal — and then names no assertion that reads it, so today it proves
   nothing. Generate it as a true CLAPPER: an audio transient coincident with
   a full-frame flash in the video, so one instant gives two observables and
   the expected offset is ZERO by construction (derived from the generator,
   not a table typed into the test). Assertion: decode the recorded
   destination, locate each clap's audio transient (`astats` peak /
   `silencedetect` edge) and its flash frame, and require **|t_audio −
   t_video| ≤ 80 ms** (≈ 2.4 frames at 30 fps) at every burst — fire the burst
   at 0 / 45 / 90 / 135 / 180 min, not once, so a slow divergence is visible
   as a trend. Record the SIGN of the error, not just the magnitude: audio
   EARLY is detected by viewers well before audio late, so an early error
   inside the budget still goes in the memo. §7.2's "one A/V clock" claim (the
   null sink has no hardware clock and runs on the same system timer
   `x11grab` polls) is the thing this row exists to VERIFY, not to assume.
   **T4 — frame timing gets an assertion (burn a frame ORDINAL).** Neither
   "drop-frame trend flat" nor "drift < 100 ms/h" can see D5: `x11grab` samples
   the framebuffer at 30 fps while Chromium paints on its own schedule under
   SwiftShader, the two clocks beat, and a duplicated frame every few seconds
   leaves BOTH of those assertions clean while pans judder. So the synthetic
   source burns a monotonic **frame ordinal** beside the source clock R0's
   latency method already burns in — same burn-in region, one extra field, no
   new mechanism. The harness decodes the recorded destination, OCRs the
   ordinal per frame, and asserts the decoded sequence has **no repeats and no
   gaps** over sampled windows of ≥ 900 frames (30 s) at 0 / 90 / 180 min.
   Report the repeat COUNT and gap COUNT per window rather than a boolean: a
   nonzero count is the judder D5 predicts, and the three windows say whether
   it accumulates. Prove the check can go red before trusting it — feed a
   fixture with one deliberately duplicated frame and one dropped, and watch
   each row fail for its own reason (a passing sequence check on an unreadable
   burn-in is the vacuous mode here; assert the ordinal was READ on ≥ 99 % of
   sampled frames, or the row is decoration).
   **T5 — the soak covers ONE contribution leg; the fallback is UNPROVEN.**
   Scope 7 drives synthetic SRT and asserts "a mid-match SRT kill → slate
   ≤ 10 s → seamless resume". That is one leg of two, and the RTMPS leg's
   failure shape is EXPECTED to differ, so the SRT result does not transfer.
   **PREDICTED, NOT MEASURED (2026-09-10):** what follows is derived from the
   two transports' properties, and this wave ran NOTHING — no compositor
   exists in the tree, no Cloudflare input has been created, and neither leg
   has been dropped and watched. It is a hypothesis that tells the soak what
   to look for, never a result, and it must not be quoted downstream as an
   observed failure mode. The prediction: RTMP is TCP, so under sustained loss
   it retransmits, collapses its congestion window and backs the encoder's
   send buffer up BEFORE it disconnects — the input would starve gradually
   rather than at once, so the `<video>` element would reach `stalled` later
   and the slate would fire later and less cleanly than on an SRT drop. What
   is actually ESTABLISHED is narrower, and it is the part that binds: the
   ≤ 10 s slate budget is proven for SRT only, because SRT is the only leg the
   soak drives. If the fallback leg is ever run and the two shapes turn out
   alike, that is a finding recorded against this paragraph, not a paragraph
   quietly deleted. The soak
   memo must SAY so in those terms: the fallback leg was not run, and the
   fallback's slate timing is unproven. **R2 asserts NOTHING about which of
   SRT and RTMPS is production primary** — that ordering is deferred to R3 by
   owner ruling R-A (2026-09-10), informed by P5's device spike, and the QR
   contract v1 carries both credential shapes plus a `preferred` discriminator
   precisely so the ordering stays a config line rather than a cross-repo
   change. A second soak leg on the fallback is R3's to schedule, not R2's to
   skip quietly.
8. **Phone tab additions**: composed mode enabled (the "coming soon" copy
   goes); delay nudge control; `stream-health` shows `measuredLatencyMs`.
9. **`_INDEX.md`**: wave row, the soak memo path, the Machine size as wired,
   any memo number that moved.

## Out of scope

The phone app; 1080p (the memo's price note is an owner question); a warm
pool of Machines (design §7.1 — later); sponsor logos (PR3); a second
compositor shape (B2 only if the memo's verdict says so — then it replaces
B3 in scope 5, never both).

## Do NOT touch

`overlay-stage.tsx`'s composition (the relay page wraps it, never forks it);
`bar`/`bug` components; the three W1 motions; `overlay-model.ts`; the
engine; `SUPABASE_JWT_SECRET` call sites (P3); the session state machine's
transitions (R1's — R2 only supplies `playing` through the heartbeat);
`fixture_stream_inputs` as a WRITE target (R1 owns the writer; R2 reads the
`slot = 0` row and nothing else); `.github/workflows/e2e.yml`; the credits
ledger.

## Acceptance — all four test kinds, assertions named

- **Unit** (`cd <worktree>/apps/web && npx vitest run components/overlay
  --reporter=json`; `cd <worktree>/relay-compositor && npx vitest run`):
  - `relay-state.test.ts`: the reducer TABLE — EMPTY first (initial state is
    `warming`, never `live`); `waiting` → warming; `stalled` at 7.9 s → no
    change and at 8.0 s → signal-lost (boundary both sides); `playing` from
    every state → live; `ended` → ended; an unknown event → unchanged.
  - **relay page source resolution (M3)** — the page resolves its playback
    source from the `slot = 0` `fixture_stream_inputs` row by explicit
    predicate: seed TWO rows, slot 1 inserted FIRST so an unordered `limit 1`
    picks the wrong one, and assert the page uses slot 0's `ingest_input_id`;
    EMPTY case first — a session with no input row → `notFound()`, never a
    default or an empty `src`. R2 writes no input row anywhere: the relay page
    and the supervisor are READ-ONLY against that table.
  - `use-live-fixture` delay unit (W1's) extended: with `delayMs = 3000`
    the snapshot received at `t` presents at `t + 3000` and
    `presentationNowOffsetMs` equals 3000; `delayMs = 0` → byte-identical to
    W1's assertions (the positive pair).
  - `overlay-slate.test.ts`: renders every §4a state; `resolveTheme("slate",
    sport)` never returns `slate` for `?style=` (the page-only rule).
  - **`relay-delay.test.ts` (T3) — the auto-tune controller, which the
    alignment e2e cannot see** (it pins `delayMs = 3000` statically):
    - **STEP INPUT, no transport change** — converged at 500 ms, then every
      beat measures 6,000 ms: `delayMs` moves by at most the clamp per beat
      (the ≤ 250 ms rule holds) and **converges within a BOUNDED number of
      beats**. The bound is COMPUTED from the exported constants —
      `ceil((target − start) / STEP_MS)` — never a literal, so raising
      `STEP_MS` moves the assertion with it. With today's values that is 22
      beats ≈ 5.5 min, which is the D3 number and the reason the next row
      exists.
    - **STEP INPUT, transport changed** (D3's snap) — the same 500 → 6,000 ms
      step arriving with `transportChanged: true` converges in **ONE beat**,
      and the EWMA accumulator is reset (the beat after a snap does not drag
      the pre-transition history back in). The two rows differ only in that
      flag, so a controller that ignores it cannot pass both.
    - Clamp rows both sides: a measurement above 10 s clamps to 10 s, below 0
      clamps to 0 (boundary at the value and one step either side).
    - The organiser nudge is an OFFSET, not a competing authority: with
      `overlay_delay_ms = +250`, the converged output is the tuned value plus
      250 at every beat, and a snap preserves it.
  - `supervisor.test.ts` (node, fakes for puppeteer/ffmpeg child): boot
    order; `ending` → `q` → flush → exit 0; child death → non-zero; heartbeat
    payload shape; `delayMs` set through `page.evaluate` without navigation
    (spy: `page.goto` called exactly once).
  - **Mutants, each with its killer:** (a) drop the clock offset in the stage
    → alignment e2e red; (b) delete the `stalled > 8 s` transition → reducer
    table red; (c) navigate twice in the supervisor → `goto` spy red; (d)
    exit 0 on child death → supervisor unit red AND the soak's Machine-kill
    check red; (e) let `?style=slate` resolve → slate unit red; **(f) delete
    D3's snap so a transport change ramps at ≤ 250 ms/beat like any other
    measurement → `relay-delay.test.ts`'s transport-changed step row red
    (time-to-converge exceeds its ONE-beat bound). Note what (f) does NOT
    kill: the alignment e2e stays green, because it never varies `delayMs` —
    which is precisely why the controller unit is owed rather than optional.
    Mutate the two step rows one at a time; they cover for each other
    otherwise. (g) restore `muted` on the relay video element → the smoke's
    T1 level floor red** (and only that — the frame-count and stream-presence
    assertions stay green, which is the D1/T1 pairing stated in scope 1);
    **(h, M3) resolve the relay page's input row with `limit 1` instead of
    `where slot = 0` → the relay-page source-resolution unit red** on the
    two-row seeding above. Note what (h) does NOT kill: every other gate in
    this list, the soak included, because production writes exactly one input
    row per session today — which is exactly why that unit seeds a second row
    rather than asserting against the shape the tree happens to have.
- **E2E** (`apps/web/e2e/walkthrough/stream-relay.spec.ts` extended; whole
  file): relay page with a valid page token → 200, `relay-video` attached,
  **(D1) that element has no `muted` attribute and its live `.muted` property
  is `false`** — assert BOTH, since the attribute's absence does not stop code
  setting the property, and anchor the attribute probe on `="` (React
  serialises an omitted prop as `"$undefined"`, so a bare `data-*`-shaped
  probe passes in both states); slate `warming` visible before `playing`;
  tampered / expired / terminal token → 404; zero cookies after load;
  **alignment**: `delayMs = 3000`, post
  a goal, `expect.poll` sees the score change and the clock advance in the
  SAME DOM read (budget in `delayMs` terms); `page.emulateMedia({
  reducedMotion: "reduce" })` → the clock still ticks; Phone tab composed
  mode enabled, nudge control ≥ 44 px, control-set diff 320 ↔ 1280.
- **Smoke**: the image's 60 s CI composite produces an FLV with ≥ 1,700 frames
  at 30 fps (`ffprobe`), an audio stream present at 48 kHz — **and (T1) that
  stream clears a LEVEL FLOOR.** Presence is not audio: `ffprobe` reports a
  48 kHz AAC stream across hours of silence, so the presence check passes
  under BOTH D1 and D2 and can prove neither. Keep it as the positive pair and
  add the assertion that can actually go red —
  `ffmpeg -i <flv> -af astats=metadata=1:reset=0 -f null -` (or
  `volumedetect`) over the whole 60 s, compared against floors **DERIVED from
  a NAMED source, never typed into the test.** The named source is the CI
  generator itself: the module that builds the CI tone + clap
  (`relay-compositor/ci-source.ts`, beside the Dockerfile of scope 5) exports
  its declared level and the chain's allowances — `CI_TONE_DBFS`,
  `CI_CHAIN_HEADROOM_DB`, `CI_PEAK_HEADROOM_DB`, `CI_WINDOW_FLOOR_DB`,
  `CI_WINDOW_COVERAGE` — and the smoke asserts
  `mean_volume ≥ CI_TONE_DBFS − CI_CHAIN_HEADROOM_DB`,
  `max_volume ≥ CI_TONE_DBFS − CI_PEAK_HEADROOM_DB`, and that at least
  `CI_WINDOW_COVERAGE` of 1 s `astats` windows clear
  `CI_TONE_DBFS − CI_WINDOW_FLOOR_DB`. Change the generator's level and the
  floors move with it, instead of leaving the smoke asserting yesterday's
  numbers — which is the whole point of the instruction this bullet used to
  give while typing three numbers of its own.
  **The values −40 dBFS mean, −6 dBFS peak, and −50 dBFS on ≥ 80 % of 1 s
  windows are ILLUSTRATIVE ONLY** — what those expressions evaluate to for
  today's generator, quoted so a reviewer can sanity-check the arithmetic at a
  glance. They are not values to hard-code, and a test containing any of the
  three as a literal has not implemented this bullet. The window rule is what
  stops a single blip passing: a stream carrying one click and 59 s of silence
  can clear a mean floor only if the floor is useless, and fails the coverage
  row outright. Prove the floor can go red by running the smoke once against a
  deliberately muted element — that is mutant (g) — and prove the DERIVATION
  is live by moving `CI_TONE_DBFS` 20 dB and watching the asserted floor move
  with it (a constant nothing reads back is a literal wearing a name).
- **Regression**: W1's `stream-overlay.spec.ts` and R1's `stream-relay.spec.ts`
  earlier cases green unchanged; the OBS overlay at `?style=bar|bug` renders
  no `<video>` (the relay segment is a sibling route — assert absence);
  whole `mobile.spec.ts`; `openapi:gen` (the nudge field on `current`) and
  `gen-keys` no diff; `tsc` clean; vitest total ≥ post-R1 baseline.
- **Visual gate**: T1b rows — slate × 3 states at 1920×1080 over light and
  dark, the relay page live with a real frame, the Phone tab composed state;
  PNGs exist and DIFFER; owner per-screen verdicts against the §4a pick.
- **The merge gate**: ONE green 3 h soak (scope 7), memo attached; a red
  soak is re-run after the fix until a FULL pass completes (a serial count is
  a floor).

## Checklist rows this wave satisfies

VERIFY-AS-CUSTOMER: "Verify visually, always" (the soak screenshots are the
customer's picture); every-width rows via T1b. PRODUCT-OWNER LENS: "A comment
in code is a HYPOTHESIS" (the soak proves the retry); "One authority per
fact" (`presentationNowOffsetMs`); "Surface bench/product gaps to owner"
(memo numbers that moved). TEST-CASE DESIGN: "Boundary row" (7.9 s / 8.0 s);
"Negative assertion needs its positive pair" (`delayMs` 0 vs 3000);
"Empty-set case" (initial reducer state); "Mutate per SURFACE"; "Report
mutant KILLER LIST".

## Verify

```
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/relay/apps/web && \
  DATABASE_URL=<rly> DATABASE_SSL=disable npx vitest run components/overlay components/public-site \
  --reporter=json --outputFile=<scratch>/r2-unit.json
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/relay/relay-compositor && npx vitest run --reporter=json --outputFile=<scratch>/r2-sup.json
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/relay/apps/web && RELAY_DRIVERS=fake PLAYWRIGHT_BASE=<rly server> E2E_PROD_TARGET=1 \
  npx playwright test e2e/walkthrough/stream-relay.spec.ts --project=walkthrough --reporter=json
gh workflow run relay-soak.yml -f base=<stg url>   # the merge gate; memo attached to PR-R2
```

Final message under 15 lines — counts, paths, deviations, blockers; no file
contents or diffs.

## Dispatch notes

- Lanes: (A) relay segment + reducer + slate + `delayMs` consumer + alignment
  e2e (apps/web only); (B) image + supervisor + workflows (`relay-compositor/`
  + `.github/workflows/relay-*.yml`, disjoint from A); (C) soak harness +
  Phone-tab additions (after A and B); (D) the soak run itself — an agent
  watches it in chunks under 8 minutes per tool call (a tool call over 10 min
  trips the stream watchdog and the agent is killed).
- Every brief: exact paths; acceptance bullets for its lane; do-NOT-touch
  verbatim; `cd <worktree> &&`; `model: opus`; the shell guard; the cap.
- The reviewer greps for `SUPABASE_JWT_SECRET` (P3) and for a second
  `<OverlayStage>` composition (the invariant) on every lane.

## False-premise watch list

1. That `x11grab` captures the headed Chromium on `:99` at full 720p without
   a window manager — Xvfb + kiosk usually suffices; if the memo used a WM,
   the Dockerfile carries it.
2. That WHEP playback works in Chromium under SwiftShader (no GPU) — the memo
   says; if it fell back to LL-HLS, `delayMs` default comes from that number.
3. That puppeteer's `exposeFunction` survives a page-level `location` change —
   it does not; the design's "navigate ONCE" is why. A reconnect is a
   `<video>` element retry, never a navigation.
4. That Fly's `auto_destroy` fires on non-zero exit (R0 watch 4) — the retry
   design assumes the crashed Machine is gone before `create` runs again.
5. That the relay page's zero-cookie property holds after W1's
   `usePathname` suppression — the relay segment is under `/overlay/`, so the
   prefix covers it; assert, do not infer.
6. That `overlay_delay_ms` on the session (R1 column) is read by the
   supervisor on each beat, not only at boot — the nudge must land without a
   restart.
