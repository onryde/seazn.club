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
   data-testid="relay-video" autoplay muted playsinline>` with the WHEP →
   LL-HLS ladder (WHEP first per the memo; LL-HLS when WHEP fails within 5 s)
   UNDER the unmodified `<OverlayStage>`; the stage receives `delayMs` from a
   page-level state the supervisor sets (scope 4).
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
`.github/workflows/e2e.yml`; the credits ledger.

## Acceptance — all four test kinds, assertions named

- **Unit** (`cd <worktree>/apps/web && npx vitest run components/overlay
  --reporter=json`; `cd <worktree>/relay-compositor && npx vitest run`):
  - `relay-state.test.ts`: the reducer TABLE — EMPTY first (initial state is
    `warming`, never `live`); `waiting` → warming; `stalled` at 7.9 s → no
    change and at 8.0 s → signal-lost (boundary both sides); `playing` from
    every state → live; `ended` → ended; an unknown event → unchanged.
  - `use-live-fixture` delay unit (W1's) extended: with `delayMs = 3000`
    the snapshot received at `t` presents at `t + 3000` and
    `presentationNowOffsetMs` equals 3000; `delayMs = 0` → byte-identical to
    W1's assertions (the positive pair).
  - `overlay-slate.test.ts`: renders every §4a state; `resolveTheme("slate",
    sport)` never returns `slate` for `?style=` (the page-only rule).
  - `supervisor.test.ts` (node, fakes for puppeteer/ffmpeg child): boot
    order; `ending` → `q` → flush → exit 0; child death → non-zero; heartbeat
    payload shape; `delayMs` set through `page.evaluate` without navigation
    (spy: `page.goto` called exactly once).
  - **Mutants, each with its killer:** (a) drop the clock offset in the stage
    → alignment e2e red; (b) delete the `stalled > 8 s` transition → reducer
    table red; (c) navigate twice in the supervisor → `goto` spy red; (d)
    exit 0 on child death → supervisor unit red AND the soak's Machine-kill
    check red; (e) let `?style=slate` resolve → slate unit red.
- **E2E** (`apps/web/e2e/walkthrough/stream-relay.spec.ts` extended; whole
  file): relay page with a valid page token → 200, `relay-video` attached,
  slate `warming` visible before `playing`; tampered / expired / terminal
  token → 404; zero cookies after load; **alignment**: `delayMs = 3000`, post
  a goal, `expect.poll` sees the score change and the clock advance in the
  SAME DOM read (budget in `delayMs` terms); `page.emulateMedia({
  reducedMotion: "reduce" })` → the clock still ticks; Phone tab composed
  mode enabled, nudge control ≥ 44 px, control-set diff 320 ↔ 1280.
- **Smoke**: the image's 60 s CI composite produces an FLV with ≥ 1,700 frames
  at 30 fps (`ffprobe`), audio stream present at 48 kHz.
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
