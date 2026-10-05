# PR body draft — Capture QR v2, PR-1 (capture-facing)

> Written at the lane close (T13, 2026-10-05), and revised after the final whole-branch review. The branch is pushed
> and open as **draft PR #920** (OG3 and OG4, owner 2026-10-05). Everything below the line is the PR description.
> Each later step is owner-gated (see "Open owner-gated steps").

---

## feat(capture): Capture QR v2, PR-1 — stable stream code, pairing, phone heartbeat, phone start

**This PR replaces the v1 capture QR, which carried credentials, with a stable stream code per fixture.**

- A Seazn Capture phone pairs once, then beats to the server.
- It hears Go live, and fetches its credentials only while it is the slot's current phone.
- It can start and stop the broadcast itself.
- When the phone is lost, the broadcast is ended cleanly.
- The organiser panel offers Go live only once a phone is paired.

**Design of record:**

- Spec: `docs/superpowers/specs/2026-10-01-capture-qr-v2-design.md`, approved by the owner on 2026-10-01. Its §17
  records the plan-time and build-time amendments.
- Plan: `docs/superpowers/plans/2026-10-01-capture-qr-v2-pr1.md`.
- Mutation table: `docs/superpowers/plans/2026-10-01-capture-qr-v2-pr1-mutations.md`.
- Capture's side: its S1 amendment, `docs/specs/2026-10-01-s1-amendment-stable-code-design.md` in the capture repo.

**What ships:**

- **Contracts.** Four published JSON contracts under `docs/contracts/`:
  - `capture-qr.v2.json`;
  - `capture-descriptor.v1.json`;
  - `capture-beat.v1.json`;
  - `capture-start.v1.json`.

  Their zod twins are in `server/api-v1/schemas.ts`. The v1 QR contract and its fixtures are deleted (W4, a hard cut).
  Capture vendors the contracts. The bytes have not changed since capture verified them. The commit that holds them is
  now `c596f2e40`, after the 2026-10-05 rebase.
- **One migration, `V430__capture_stream_codes.sql`.**
  - Four new tables: `fixture_stream_codes`, `fixture_stream_settings`, `fixture_stream_pairings` and
    `fixture_stream_phone_beats`. Each uses V410's RLS model: enable plus force, no policy, and access only through the
    non-tenant `sql`.
  - `fixtures.finished_at`, with its trigger.
  - Session columns for the phone (`pairing_id`, `phone_beat`, `warming_at`, `ingest_read_failed`, and others).
  - The end-reason check gains `phone_lost`.
  - `credentials_revealed_*` is renamed `credentials_served_*`, and `qr_issued_first_at` is dropped (R3).
- **A pure domain under `server/relay/domain/`.** The modules are `stream-code`, `pairing`, `slot`, `beat-answer`,
  `end-reason`, `phone-lost` and `poll-seconds`. Each is decided by a table, with `now` passed in.
- **Three phone routes, under the `capture` tag.**
  - `GET /api/v1/capture/codes/{code}` serves the descriptor.
  - `POST /api/v1/capture/codes/{code}/beats` is the heartbeat, and answers with a beat answer.
  - `POST /api/v1/capture/codes/{code}/start` lets the operator start from the phone.

  Each route takes a Bearer tok and answers `private, no-store`. Each has two rate limits:
  - a per-code budget, keyed on the code plus `sha256(tok)[0:16]` (B6 R-1);
  - a per-IP failure budget that counts only 401s, so a correct tok is never refused by it (B6 I-1).

  `POST start` also has its own start limit.
- **Organiser routes.**
  - `POST /api/v1/fixtures/{id}/stream-code` ensures a code.
  - `POST …/stream-code/reissue` is Revoke & reissue.
  - `GET …/stream-phone` is the panel's read model.
  - `PUT /api/v1/fixtures/{id}/stream-settings` saves the destination pre-pick.
- **One start path** (`startBroadcast`) for both the organiser and the operator. W5 refuses Go live with no present
  phone (`phone_not_paired`).
- **One tick** (`tickSession`) for the organiser poll, phone beats, the daily sweep, and the new `stream-tick` job.
  - The tick ends a warming session whose phone was lost (ask 10).
  - It ends a live session after 15 minutes with no beat and no video (W19).
  - `apps/cron-worker` gains a `stream-tick` row on a `*/5 * * * *` trigger. Its Sentry events are throttled to one
    per job per UTC hour (R2).
- **Every app 429 now carries `Retry-After`** with the true remaining window (R4, `rate-limit.ts` `tooMany`). That
  includes surfaces outside capture, scoring and billing among them. The scoring pad already obeys `Retry-After` (up
  to 60 s), so a throttled scorer now waits out the real window instead of the pad's derived backoff. Retrying inside
  a fixed window only meets another 429, so this is the intended behaviour.
- **Free restarts are capped at 3 per reuse window** (W23). One authority, `restartAllowance`, serves admission, the
  consume and the panel.
- **The organiser panel** (Option B rev 2): a chain-first Ready card with the QR, the paste code, Revoke & reissue, the
  W24 countdowns, and the restart line. Behind the PostHog flag `capture-qr-v2`.
- **Tests:**
  - an e2e fake phone (`e2e/helpers/fake-capture-phone.ts`);
  - a new `walkthrough/capture-phone.spec.ts`;
  - three repaired walkthroughs;
  - smoke `captureV2` (`SMOKE_ONLY=captureV2`);
  - the R10 tunables in `e2e.yml` (OG15).

## Owner decisions

These are the seazn.club owner's own decisions, each with its date. Controller rulings are listed separately below.
They are not the owner's.

| Subject | Decision | Date |
|---|---|---|
| Panel design | **Option B, revision 2** (chain first, desktop QR ≥ 320 px), plus items 1–4: "1 credit" once; the countdown replaces D3's phone sentence; the four paused reasons; the Revoke & reissue confirm copy. | 2026-10-01 (OG2) |
| Visual sign-off | **18 of 18 screens approved**, and **departures A and B approved** (see "Per-screen verdicts"). | 2026-10-05 |
| Feature flag | The PostHog flag `capture-qr-v2` gates the **capture UI only**: the panel's phone-camera option. No route is gated. Fallback is false, so the option is hidden when PostHog is unconfigured or down. The flag is set up in PostHog: Organizations, the test club, 100%. | 2026-10-04 |
| Local override | **Controller ruling, on the owner's question of 2026-10-04** ("in local, always visible?"). `CAPTURE_QR_V2_ALWAYS=1` forces the option visible. It is for **local and e2e only**, and is unset on stg and prod, where the PostHog flag decides. A test proves it is absent from `fly*.toml` and the Dockerfile. | 2026-10-04 |
| Photographed QR | **Ruling "a":** a scan takes over the slot, and the organiser's **Revoke & reissue is the remedy**. The QR is shown only in the organiser panel. | 2026-10-04 |
| `e2e.yml` | **OG15 granted** for the R10 tunables, on e2e-parallel's Start server and Run Playwright steps (`e2e.yml:791-793`, `:847-849`), and **extended** to `CAPTURE_QR_V2_ALWAYS: "1"` at `e2e.yml:780`, `:1245` and `:1595`, so the walkthroughs see the phone option. All of it goes live on merge. | 2026-10-05 |
| YouTube: one video or many | **PENDING the owner's staging observation**, with Auto-stop on and off, and the gap length. No code depends on it. **Help text is pending.** No help string asserts either behaviour, and the organiser help is written after the observation. | asked 2026-10-04 |
| Flag off | **Flag off = the OBS path plus credits.** The OBS overlay, then the balance, Buy more and the embedded checkout. **The v1 QR is gone for every org** (W4, §6.13), so the pre-T11 Phone-tab Go live does not return with the flag. This was a coordinator ruling (spec §17.13), and the owner approved screen 14 (flag off) and 14b (flag-off buy) in the visual sign-off. | 2026-10-05 |
| Stg `*/5` cost | **R9: accepted**, including keeping the stg Fly machine awake. The merge still needs its own OK (OG6). | 2026-10-01 |

## Controller rulings

These rulings are recorded in the plan's rulings table, in spec §17, and in the programme ledger. They are the
controller's own calls, plus R5, a contract detail agreed with capture. **None of them is an owner ruling.**

- **R1:** the V430 tables use V410's RLS model. **R3:** the drop and the rename land with V430, and the live writer is
  re-pointed in the same commit.
- **R2 and R6:** the cron Worker throttle (option S, stateless, keyed on `scheduledTime`). Manual runs are never
  throttled.
- **R4:** `Retry-After` is the true remaining seconds, read from the Lua TTL. The fail-closed 429 answers the full
  window.
- **R5:** `at` admits an offset and is normalised to UTC. The beat answer and the descriptor are unions on `state`.
  Capture agreed this on 2026-10-01.
- **R7:** the label is truncated to 200 characters and `destinationName` to 80. **R8:** "another sport" is a sweep over
  the status writers.
- **R10:** the walkthrough tunables are set in `e2e.yml` and pinned in `e2e-ci-wiring.test.ts`. **R11:** a completed
  session with no end reason maps to the wire's `failed`.
- **Phone-less sessions keep today's rules** (B5 C-1). A session with a null `pairing_id` (OBS and RTMP, or an
  organiser v1 stream) is never ended `phone_lost`, and shows no countdown.
- **A reissued code still serves its open session's phone** (C1b/C3). Only a NEW claim, or the Go-live lookup,
  refuses after a reissue. A phone that rescans the new QR moves its pairing and its open session onto the new code
  (B6 I-2).
- **An `unknown` ingest read never advances a phone-lost end** (m-3). The panel's countdown is shown only when the end
  it counts to will fire at that deadline. It names the earliest end and that end's reason (§17.12).
- **A correct tok is never refused by the failure budget** (B6 I-1). The code budget and the start budget are keyed
  on the code plus `sha256(tok)[0:16]` (R-1); the failure budget is per client IP. The client IP is read from `CF-Connecting-IP`, then `Fly-Client-IP`, then
  `X-Forwarded-For`, then `X-Real-IP`.
- **Any unmapped phone-route error is `503 {code:"unavailable"}`** (B6 M-5). For beats, that is transient. See spec
  §17.14, which this lane close added to §6.3.3.
- **The destination resolver** (§17.13, B8 I-1): ONE resolver serves the picker display, the phone's start, the
  descriptor and the read model. Viewing the panel writes nothing.

## Verification at the lane close (T13)

**Code under test by the lane-close gate below:** `554841a50`, rebased onto origin/main `dbaa771c0`. origin/main has
not moved since, so no further rebase was needed after the final review.

**Commits after `554841a50`, each verified on its own scoped runs.** These are not docs-only:

| Commit | What it changes | Evidence |
|---|---|---|
| `3cd42232d` | test only: B9 review fixes in `walkthrough/capture-phone.spec.ts` | capture-phone **16/16 ×2** |
| `50e48c33e` | **src and copy:** the `phone_lost` chip names the server's W19 window (`tunable(PHONE_LOST_LIVE_MINUTES)`, through the panel context) instead of a typed "15"; all 4 `ui.json` | panel and context vitest **406/406**; the literal-15 mutant red 3 ways; capture-phone **16/16 ×2**. `mobile.spec.ts` was **not** re-run: the chip renders only in an ended `phone_lost` state, which `mobile.spec.ts` never reaches. OG5 covers every width. |
| `631f73ae1` | test only: B9 re-review minors (hold-on-delivery, the W22 all-or-nothing pool, an exact tick) | capture-phone **16/16 ×4**; capture-phone plus directory-stream-destinations at 3 workers **33/33 ×2** |
| `2255910f1` | **V430 amend:** 9 indexes from the final review (m-2), covering the per-poll `lastTakeover` query and the FK and `org_id` columns | fresh DB at v430 with all 9 present; `EXPLAIN` uses `fixture_stream_codes_fixture_id_idx` and `fixture_stream_pairings_code_id_ended_at_idx` on 20k codes and 80k pairings, and falls back to seq scans with them dropped; check-rls OK; 13 scoped files **214/214**, including `rls-coverage`, `history-restore-fidelity`, the migration-shape suites and the capture routes; typecheck 0 |

**The final whole-branch review** (`dbaa771c0..631f73ae1`): 0 Critical. 17 of 17 fresh mutants were killed, each
restored and proven with `cmp`. The contracts are byte-identical, and no inert seam was found. Its findings were PR body
corrections (this revision), the V430 indexes (`2255910f1`), and one gap for the owner (see "Parked and later").

**Migration number re-checked (T13 Step 1).** Main's newest delta is still `V429__weekly_digest_cron_once.sql`. No
branch on origin carries a `V43x` delta. `V430` is this branch's alone.

**Environments.** Each run below used a fresh environment, built with `db:apply` plus `sync:sports`, at schema v430.
`show data_directory` returned the label's own directory each time.

- The vitest runs used `cq11`.
- The Playwright runs used `cq11pw`: a clean build of the same commit, in a detached worktree, at `localhost`.
  - The server env was e2e-parallel's: `CAPTURE_QR_V2_ALWAYS=1`, the R10 tunables, `FAKE_INGEST_CONNECT_AFTER_MS`
    10000, `RELAY_DRIVERS=fake`.
  - The PostHog keys were blank.

**Reading the counts.**

- Every count was read from a reporter file, never from a wrapper.
- Every vitest `.testResults[].name` resolved inside the tree under test.
- The union run collected exactly the 108 files it named. Vitest positionals are substring filters, so the collected
  set was diffed against the named set.

| Run | Scope | Result |
|---|---|---|
| vitest union (`apps/web`) | 108 files: every task's scope command in the plan (T1–T12), every path in the task briefs, every test file this branch changes, plus the batch gates (`rls-coverage`, `history-restore-fidelity`, `key-scopes`, `openapi-coverage`, the other three `openapi-*`, `schemas`, `toolchain`, `telemetry`, `stream-target-holders`) | **2601 / 2601**, 0 failed, 0 skipped, 504 suites, EXIT 0 |
| Redis step (CI runs it apart) | `rate-limit.redis.test.ts`, `REDIS_URL` on a private redis | **5 / 5** |
| QR-enlarge unit specs | `qr-enlarge.test.ts`, `seazn-qr-image.test.tsx` | **38 / 38** |
| cron Worker | `apps/cron-worker`, all 8 files (`pnpm exec vitest run`) | **117 passed**, 1 skipped (`e2e.local`, env-gated), 0 failed |
| root scripts | `scripts/__tests__/smoke-select.test.ts` | **5 / 5** |
| typecheck | `apps/web` (with `tsconfig.scripts.json`), `packages/engine`, `apps/cron-worker` | exit 0 each, 0 errors |
| lint (`rtk proxy`) | `apps/web`, `packages/engine`, `scripts` + `tools` | **0 errors**, exit 0 each. `apps/web` has 154 warnings, the same count as the post-rebase run |
| i18n | `i18n:check`, then a `gen-keys` regen | parity OK (7179 keys in each of the 4 locales); regen leaves no diff |
| check-rls | `scripts/check-rls.ts` on `cq11` | OK, 61 tenant tables isolated, exit 0 |
| openapi:gen | regen of `openapi/v1.json` and `v1.public.json` | no diff |
| `mobile.spec.ts`, **whole**, 7 projects (Playwright JSON) | `mobile-320`, `-360`, `-se`, `-14`, `-430`, `tablet-768`, `-834`, plus setup; 3 workers, 0 retries | **333 expected, 0 unexpected, 0 flaky, 5 skipped.** The 5 skips are the LCP test's own one-phone project gate. This equals B8's run. |
| QR-enlarge helper specs, **whole** (Playwright JSON; found by grepping `expectQrEnlarge*`/`closeQrEnlarged`) | `walkthrough/stream-relay.spec.ts` and `walkthrough/scorer-sheets-handover-panel.spec.ts`, plus setup | **36 / 36** (31 + 3 + 2 setup), 0 flaky |

**Earlier batch gates.** Each batch also had its own scoped gate, its review, and mutation runs. Those are recorded in
the commit bodies, and the same totals appear in the mutation table below. Batch by batch:

- **B3:** 965/965, rls-coverage 3/3, restore-fidelity 54/54.
- **B4:** 1180/1180.
- **B5:** web 925/925, cron-worker 117/117.
- **B6:** 1117/1117, with real Redis 28/28.
- **B7:** 1009/1009.
- **B8:** 1347/1347, plus `mobile.spec.ts` whole 333/0.
- **B9:** the four walkthroughs whole, and smoke `captureV2` 15/0.

## Mutation table (spec §11.1.3, rule 5)

The full killer list, with each mutant's exact text and the message that killed it, is
`docs/superpowers/plans/2026-10-01-capture-qr-v2-pr1-mutations.md`. Every row there was **run**:

- one textual replacement;
- the killer files through vitest's JSON reporter;
- a restore from a `cp` backup, proven with `cmp`.

The "Model" column is the T10 fast-check model (`capture-model.test.ts`), run against the same mutant.

| # | Spec mutant | Killed by | Red / total | Model |
|---|---|---|---|---|
| 1 | `timingSafeEqual` → `===` | `stream-codes.test.ts` C1 (pass-through spy on `node:crypto`) | 1 / 32 | — |
| 2 | drop the dummy-hash compare for an unknown code | the same C1 case | 1 / 32 | — |
| 3 | serve `cred` to any valid tok | `capture-get.test.ts` G0-d two-phone, live/ending, served-count | 3 / 40 | killed |
| 4 | C1b always true | `capture-beat`, `stream-codes`, `capture-start`, `capture-get` C1b/C3 | 14 / 130 | killed |
| 5 | C2: drop "no open session" | `stream-code.test.ts`, `stream-codes.test.ts` C2 (×2) | 3 / 71 | — |
| 6 | A9 refusal removed (T3) | `capture-beat.test.ts` T3, `pairing.test.ts` T3 + sweep | 7 / 55 | killed |
| 7a–c | T4: drop each conjunct alone | `pairing.test.ts` "conjunct n fails alone", capture-beat "ONE AT A TIME" | 2, 2, 3 / 55 | 7a killed |
| 8 | T6 `resume` treated as `new` | `capture-beat.test.ts` T6, `pairing.test.ts` T6 + sweep | 3 / 55 | killed |
| 9 | T24: close the open sid instead of X | `capture-beat.test.ts` T24 | 1 / 31 | killed |
| 10 | T24a: drop the holder check | `capture-beat.test.ts` T24a | 1 / 32 | killed |
| 11 | T23: hold check applied to the current phone | `capture-beat.test.ts` T23 | 1 / 32 | killed |
| 12 | `phone_not_paired` gate removed | `stream-sessions.test.ts` W5 (12 cases) | 12 / 269 | killed |
| 13 | pollSeconds near window off by one | `poll-seconds.test.ts` T−30 min ± 1 s | 1 / 10 | — |
| 14 | ask 10 without `first_ingest_at IS NULL` | `phone-lost.test.ts`, `stream-tick.test.ts` | 2 / 71 | **survived (expected)**: a warming session with first ingest is unreachable through the use-cases (spec §17, M-7) |
| 15 | W19: drop the beat conjunct | `stream-tick.test.ts`, `phone-lost.test.ts` (6 cases) | 6 / 71 | killed |
| 16a–b | W19: drop the fresh-read / sample conjunct | `stream-tick.test.ts`, `phone-lost.test.ts` | 2 / 71 each | — |
| 17a | W19: `>` for `≥` | `stream-tick.test.ts` (16 cases) | 16 / 71 | — |
| 17b | W19: 14 for 15 | `config.test.ts` (the DEFAULTS pin) | 3 / 94 | — |
| 18 | ask 10 at a flat 60 s | `phone-lost.test.ts`, `stream-tick.test.ts` | 4 / 71 | — |
| 19 | `preferred: "srt"` while `cred.srt` is null | `ingest-cred.test.ts`, `capture-get.test.ts` A18 | 3 / 49 | — |
| 20 | purge deletes the session's final beat | `relay-sweep.test.ts` W10 | 1 / 47 | — |
| 21 | `no-store` removed from an error path | `get-route.test.ts`, `beats-route.test.ts` (20 cases) | 20 / 30 | — |
| 21b/21c | each no-store guard alone | `get-route.test.ts` (21c survived the first sweep; the gap was closed with a new case, then killed) | 1 / 30, 1 / 31 | — |
| 22 | consume skipped for `startCause operator` | `capture-start.test.ts` MONEY | 1 / 109 | killed |
| 23 | the `ENV_NAME` gate on fake-ingest removed | `fake-ingest/route.test.ts` (stg, prod, unset) | 3 / 9 | — |

**Beyond §11.1.3,** the same file records three more sets of mutants. Each set was run once with the same method.

- **T9 (the stream-phone read model):** 11 mutants, all killed.
- **The guards from later rulings:** 12 mutants. All were killed by their named tests. C-1 survived in the model by
  design: every model session starts on a pairing.
  - C-1 (phone-less sessions);
  - m-3 (unknown read);
  - W23 × 2;
  - C-2 (reissue);
  - W5 active code;
  - B4 m-2 × 2;
  - B6 R-1, I-1, I-2 and M-6.
- **The B7 fix round's own guards:** 27 mutants, all killed. They cover the W24 ⇔ W19 agreement, the earliest-end
  countdown, the outage gap, M-6 (T9) and I-3/M-2/M-4. I-3, M-2 and M-4 were killed by the model alone.

## Per-screen verdicts (spec §11.1.8; owner sign-off 2026-10-05)

**How the screens were captured.**

- Harness: `apps/web/e2e/stream-phone-panel.capture.ts`, on a prod build with `CAPTURE_QR_V2_ALWAYS=1`.
- Screen 14 was captured without the override, with the PostHog keys blank.
- Every state was shot at 1280, 768 and 320: **54 PNGs, 0 duplicates.**

**Each pass's gate:**

- every image exists, and the images are pairwise distinct;
- the control set at 320 equals the set at 1280, per state;
- there is no horizontal page scroll.

**The QR.** It paints at 342 px at 1280 and at 768, and at 228 px at 320, with 57 modules. The painted QR decodes
(jsQR) to the paste code at all three widths.

| # | State | Verdict against Option B rev 2 | Owner |
|---|---|---|---|
| 01 | Ready, no phone | MATCH: chain, slate strip with caret, picker, Go live held, credits line, code card (title, QR with logo, Tap to enlarge, paste code, Copy, Revoke & reissue) | approved |
| 02 | Ready, paired | MATCH: lime "Paired" node, fold "● Paired · Show the code again ›", Go live enabled, no strip | approved |
| 02b | Ready, a pick that did not save | NEW: picker back on the server's answer, red "Couldn't save that destination. Pick it again." under it; wraps at 320 and 768 with no overflow | approved |
| 03 | Ready, paired, code open | MATCH: open fold, the same code re-shown | approved |
| 04 | Revoke & reissue confirm | MATCH: "Make a new code?", danger "Make new code", Cancel | approved |
| 05 | Ready, phone silent | MATCH: amber node "Not answering", amber strip and dot, Go live held | approved |
| 06 | Waiting | MATCH structure: slate strip lead only (no countdown in the real answer), far-cadence line; departure A | approved |
| 07 | Waiting, countdown | MATCH: amber strip, "cancelled in 9 min, 15 sec"; departure A | approved |
| 07b | Waiting, phone lost (ask 10, REAL) | NEW: all four voices agree (node "Not answering" with "!", link 1 orange dashes, strip "…cancelled in 29 sec…", amber dot) | approved |
| 08 | Live | OK (no mockup state, §3.3): live plus the folded code line; departure A | approved |
| 09 | Live, phone lost (W19) | MATCH "reconnecting": 20 s gone on a stream on air 0:35, 14 min 40 s to go; "!" on Reconnecting…, both links orange, Not receiving, amber dot | approved |
| 10 | Live, paused | MATCH "paused": "Phone is on a call — video paused", no countdown, no "!" | approved |
| 11 | Live, legacy (no pairing) | OK (C-1): today's panel, §3.2 words, no strip, no code line | approved |
| 12 | Ended | OK: restart line (0 of 3) inside the Ended card | approved |
| 13 | Ready, restarts | MATCH: "Free restarts used (0 of 3)" | approved |
| 13b | Ready, restarts at the limit | MATCH: amber "Free restarts used (3 of 3) — this one uses 1 credit"; wraps at 320 with no overflow | approved |
| 14 | Flag off | OK: the OBS overlay as before, then "5 credits · Buy more"; no Phone/OBS switch | approved |
| 14b | Flag off, Buy more | NEW: "Buy match credits" with three packs; 3 columns at ≥ 768, stacked at 320 | approved |

**Departures, both approved by the owner on 2026-10-05:**

- **A.** The folded "Paired · Show the code again" line, with Reissue inside it, also renders under Waiting and Live for
  a paired session. The mockup draws it at Ready only.
- **B.** Below 640 px, the paste code and the destination select render at 16 px. This is the house rule against iOS
  zoom-on-focus (`globals.css` Pattern 5). The mockup draws them at 11 px and 14 px.

## Staging runbook, S1–S11 (spec §12) — **STOP: owner OK required (OG14)**

**The whole runbook is owner-gated.** It runs live stg on real Cloudflare Stream, which is billed by Stream minutes and
by storage. Record each step's evidence in this PR: the command and its output, or a screenshot. **S2 and S8 are
gates.** S2b is not (W20).

**Setup.** These names are used in the commands below:

- `STG=https://stg.seazn.club`
- `CODE` and `TOK`: read from the stg panel's paste code (Ready card, then Show the code). It is the QR's JSON,
  `{"v":2,"code":"…","slot":0,"tok":"…"}`.
- `P1` and `P2`: two phone ids, each 16 to 64 characters, for example `p1-runbook-0000000001` and
  `p2-runbook-0000000002`.

`TOK`, the stream key and the passphrase are secrets. Never paste them into this PR. S8 searches for them.

### Before S1 — **STOP: owner OK required (OG9)**

**Set both hosts on stg.** They are plain configuration, not Fly secrets (W14, spec §6.15), so they go in
`fly.stg.toml`'s `[env]`, in a follow-up commit that `stg.yml` deploys:

```toml
STREAM_INGEST_HOST   = "live.stg.seazn.club"
STREAM_PLAYBACK_HOST = "customer-vv7totdc7j19biah.cloudflarestream.com"
```

**Confirm `RELAY_DRIVERS` is `live` on stg:**

```bash
fly secrets list -a seazn-club-stg                                 # RELAY_DRIVERS, ENV_NAME and FLY_RELAY_APP are listed
fly ssh console -a seazn-club-stg -C 'printenv RELAY_DRIVERS ENV_NAME'   # live, stg
```

- Under `NODE_ENV=production`, an unset `RELAY_DRIVERS` disables streaming: every start answers
  `503 ingest_unavailable`. `fake` refuses to boot on `ENV_NAME=stg`.
- Without `STREAM_PLAYBACK_HOST`, stg's descriptor answers `503 playback_unconfigured`, and boot logs an error.
- Leave `STREAM_SRT_ENABLED` unset, which means on (W21).
- **Any new ingest hostname**, for example `live.stg.seazn.club`'s DNS or its Cloudflare custom ingest domain, **is
  OG10: STOP, owner OK required.** It is a Cloudflare write.

### S1 — the descriptor's hosts

```bash
# Phone 1 claims the slot with a paired beat, then the organiser presses Go live in the panel.
curl -s -X POST "$STG/api/v1/capture/codes/$CODE/beats" -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' -d @beat-paired-p1.json | jq .state        # "waiting", then "go-live"
curl -s "$STG/api/v1/capture/codes/$CODE?phone=$P1&slot=0" -H "Authorization: Bearer $TOK" \
  | jq '{state, preferred: .cred.preferred, rtmps: .cred.rtmps.url, srt: .cred.srt.url, playbackUrl}'
# expect rtmps rtmps://live.stg.seazn.club:443/live/, srt srt://live.cloudflare.com:778,
#        preferred "srt", playbackUrl on customer-vv7totdc7j19biah.cloudflarestream.com
curl -s "$STG/api/v1/capture/codes/$CODE?phone=$P2&slot=0" -H "Authorization: Bearer $TOK" | jq 'has("cred")'   # false
```

- `beat-paired-p1.json` is a strict beat body: `code`, `slot: 0`, `phone: P1`, `claim: "new"`, `state: "paired"`,
  `mode: "operator"`, and the rest from `docs/contracts/capture-beat.v1.json`'s fixtures.
- With `STREAM_SRT_ENABLED=false` set for one deploy, repeat the GET: expect `cred.srt` to be `null` and `preferred` to
  be `"rtmps"`. Then unset the flag again.

### S2 — **Gate (W15, W21):** publish over both transports

```bash
# RTMPS, to the descriptor's custom host and stream key
ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=frequency=1000 \
  -c:v libx264 -preset veryfast -b:v 2500k -g 60 -c:a aac -b:a 128k \
  -f flv "rtmps://live.stg.seazn.club:443/live/$STREAM_KEY"
# SRT, to Cloudflare's own host, with the descriptor's streamid and passphrase (ffmpeg built with libsrt)
ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=frequency=1000 \
  -c:v libx264 -preset veryfast -b:v 2500k -g 60 -c:a aac -b:a 128k \
  -f mpegts "srt://live.cloudflare.com:778?streamid=$SRT_STREAMID&passphrase=$SRT_PASSPHRASE"
```

- **If your ffmpeg has no libsrt,** use `srt-live-transmit` through a local UDP relay:

  ```bash
  ffmpeg … -f mpegts udp://127.0.0.1:9000
  srt-live-transmit udp://:9000 "srt://live.cloudflare.com:778?streamid=$SRT_STREAMID&passphrase=$SRT_PASSPHRASE"
  ```

  URL-encode `streamid` if it carries reserved characters.
- **Each transport must reach `connected`.** That is the Cloudflare status read: the panel's Seazn node reads
  Receiving, or the live input's `status.current.state` reads `connected` in the Stream dashboard.
- **If SRT fails,** set `STREAM_SRT_ENABLED=false` on stg (A18) and record why. **If RTMPS fails, stop.**

### S2b — optional, not a gate (W20, W21); run later

- Repeat S2's SRT publish against `srt://live.stg.seazn.club:778`, with a stg input's streamid and passphrase. Use
  ffmpeg with libsrt, or `srt-live-transmit` through the same local UDP relay.
- A pass allows a server-only change that rewrites the SRT host as well, with no contract change.

### S3 — the SRT hold window

```bash
# Stop the SRT ffmpeg, then time until the manifest ends: it stops answering 200, or its live playlist closes
t0=$(date +%s)
while :; do
  m=$(curl -sf "$PLAYBACK_URL") || break
  v=$(printf '%s\n' "$m" | grep -v '^#' | head -1)        # the first variant, when PLAYBACK_URL is a master
  if [ -n "$v" ]; then
    case "$v" in http*) u=$v ;; *) u=$(dirname "$PLAYBACK_URL")/$v ;; esac
    m=$(curl -sf "$u") || break
  fi
  printf '%s\n' "$m" | grep -q 'EXT-X-ENDLIST' && break
  sleep 1
done; echo "$(( $(date +%s) - t0 )) s"
```

Compare the result against the declared 183 s. A difference beyond the slack changes the constant before production.

### S4 — the playback manifest

```bash
curl -s "$PLAYBACK_URL" | head -3      # while live: #EXTM3U …
```

### S5 — no caching on the phone routes

```bash
for i in 1 2; do
  curl -si "$STG/api/v1/capture/codes/$CODE?phone=$P1&slot=0" -H "Authorization: Bearer $TOK" | grep -iE '^(cache-control|cf-cache-status)'
  curl -si -X POST "$STG/api/v1/capture/codes/$CODE/beats" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d @beat-paired-p1.json | grep -iE '^(cache-control|cf-cache-status)'
  curl -si -X POST "$STG/api/v1/capture/codes/$CODE/start" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d "{\"phone\":\"$P2\"}" | grep -iE '^(cache-control|cf-cache-status)'   # P2 is not current: 409 replaced, starts nothing
done
```

Expect `Cache-Control: private, no-store` on every answer, refusals included, and `cf-cache-status` never `HIT`.

### S6 — the native shape passes `proxy.ts`, and a foreign Origin does not

```bash
curl -si -X POST "$STG/api/v1/capture/codes/$CODE/beats" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d @beat-paired-p1.json | head -1                                 # 200: no Origin
curl -si -X POST "$STG/api/v1/capture/codes/$CODE/beats" -H "Authorization: Bearer $TOK" -H 'Origin: https://evil.example' -H 'Content-Type: application/json' -d @beat-paired-p1.json | head -1   # 403
```

### S7 — the rate limit (Redis is live on stg)

```bash
for i in $(seq 1 125); do curl -s -o /dev/null -w '%{http_code}\n' "$STG/api/v1/capture/codes/$CODE?slot=0" -H "Authorization: Bearer $TOK"; done | sort | uniq -c
curl -si "$STG/api/v1/capture/codes/$CODE?slot=0" -H "Authorization: Bearer $TOK" | grep -iE '^(HTTP|retry-after)'
```

- `CAPTURE_CODE_LIMIT` is 120 per 60 s, per code plus tok. Expect 429 after 120, with a `Retry-After` of the true
  remaining seconds (R4).
- Run it inside one minute, and not on a code a live test is using.

### S8 — **Gate:** no secret in the logs

After one full run (pair, go live, stream, stop, late stop, reissue), search the logs:

```bash
fly logs -a seazn-club-stg --no-tail > stg-logs.txt
for s in "$TOK" "$STREAM_KEY" "$SRT_PASSPHRASE"; do grep -c -F -- "$s" stg-logs.txt; done     # 0, 0, 0
```

Also search Sentry (the stg project's issues and events) for each of the three strings. **Expect zero hits
everywhere.**

### S9 — beat history purge

```sql
-- the minute after a new minute beat on the pairing:
select count(*) from seazn_club.fixture_stream_phone_beats
 where pairing_id = :pairing and recorded_at < now() - interval '24 hours';                 -- 0
select phone_beat is not null, phone_beat_at from seazn_club.fixture_stream_sessions where id = :sid;   -- intact
```

### S10 — capture's plan D exit bar

A real phone on stg must, recorded with the device model:

- pair;
- start from the console **and** from the phone;
- stream a real match to YouTube;
- stop from each end;
- take over a dead phone (A14).

**Owner: also record the YouTube observation here,** with Auto-stop on and off, and the gap length. The pending help
text waits on it.

### S11 — W19 on real Cloudflare

- Go live from a phone, then kill the app (no beats) and stop the video. With the panel open, the session must end
  `phone_lost` at 15 min, give or take one poll.
- Then a second run with only the beats stopped, and video still flowing. It must stay live past 15 min.

### After the merge deploy — **STOP: owner OK required (OG12)**

```bash
pnpm --filter @seazn/cron-worker exec wrangler deployments list --env stg
```

Confirm that the stg Worker carries both triggers, `17 * * * *` and `*/5 * * * *`. The command runs on the owner's
account.

### Watch one throttled firing — **STOP: owner OK required (OG12)**

- Make `stream-tick` fail on stg for part of one UTC hour.
  - Either use the first firings in the OG16 window,
  - or set a wrong `CRON_SECRET` on the stg Worker with `wrangler secret put CRON_SECRET --env stg`, then restore it.
    This is a Cloudflare write, and the hourly jobs on stg fail with it for that hour.
- Then read `wrangler tail --env stg` and the stg Sentry project.
- **Expected:**
  - the hour's first `*/5` firing (`:00`) sends exactly **one** Sentry event;
  - a later firing in the same hour logs `sentryThrottled: true` and sends none;
  - a manual run is never throttled (R6).

## Deploy notes

### The Cron Trigger count (Review Focus 5)

- Today the account holds 2 of the Workers Free plan's 5 Cron Triggers: `17 * * * *` on stg and on prod.
- **On merge,** `stg.yml`'s `deploy-cron-worker-stg` runs `wrangler deploy --env stg`. That puts the `*/5` trigger
  live on stg at once (**3 of 5**).
- On the version tag, prod adds its own (**4 of 5**).
- The stg trigger wakes the stg Fly machine every 5 minutes (`min_machines_running = 0`, `auto_stop = "suspend"`).
  **R9: the owner accepted that cost on 2026-10-01.**
- **The merge itself is still STOP: owner OK required (OG6).**

### The deploy-order race (OG16) — **STOP: owner OK required:** acknowledge before OG6 and OG8

- `toolchain.test.ts` forbids `needs:` between the deploy jobs. So the cron Worker can deploy before Fly serves
  `/api/cron/stream-tick`.
- The first firings would then 404. They read as degraded, and send a Sentry event, throttled to one per hour (R2).
- This is expected, and it heals itself once the Fly deploy finishes.

### The R3 stg window

- V430 renames `credentials_revealed_*` to `credentials_served_*`, and drops `qr_issued_first_at`.
- `stg.yml` runs `scripts/flyway.sh migrate` **before** it builds, pushes and deploys the Fly image.
- Between Flyway applying V430 on stg and Fly stg serving this branch's code, the old stg server's QR writer fails on
  the missing columns.
- **The window is the length of `stg.yml`'s image build, push and `flyctl deploy` after its migrate step. It closes
  when the deploy finishes.**
- Stg only, and greenfield (RULES.md §Schema). The same window opens on prod at the tag (OG8).

### The sport scope (R8)

**Nothing else in PR-1 branches on sport. `finished_at` keys on `fixtures.status`, and T3 sweeps every status
writer** (`fixture-finished-at.test.ts`, with its `// single-sport:` reason).

## Open owner-gated steps

Each of these steps is **STOP: owner OK required**. The orchestrator never takes one on its own authority, and never on
a peer session's word.

| # | Step | When | Note |
|---|---|---|---|
| — | **Rebase onto main** if it has moved, re-run the affected scoped checks, and push with `--force-with-lease` (owner ruling 2026-10-05: "rebase after review"). | before OG5, and again before OG6 if main moves | As of the final review, main had not moved. |
| OG5 | `workflow_dispatch` e2e with the `pr` input. **STOP: owner OK required.** | before merge, against the head after any rebase | The branch edits `e2e.yml` (R10), so dispatch with **`--ref feat/capture-qr-v2-pr1`**, or main's workflow file runs. A main push cancels a dispatched run, so "cancelled" is not a pass. |
| OG6 | Merge to main. **STOP: owner OK required.** | after OG5 | `stg.yml` runs Flyway V430, deploys Fly stg, and deploys the cron Worker (`*/5` live on stg: a Cloudflare write). The R3 window above. OG16 acknowledged first. |
| OG7 | Act on the e2e run from the push to main. **STOP: owner OK required.** | after OG6 | — |
| OG8 | Version tag. **STOP: owner OK required.** | after staging | `prod.yml`: prod migration, Fly prod, and the cron Worker on prod (4 of 5 triggers). OG16 acknowledged first. |
| OG9 | Set `STREAM_INGEST_HOST` and `STREAM_PLAYBACK_HOST`, and confirm `RELAY_DRIVERS`, on stg and prod. **STOP: owner OK required.** | before S1, and before the tag | Neither host is in `fly.toml` or `fly.stg.toml` `[env]` today. |
| OG10 | Any DNS or ingest host, for example `live.stg.seazn.club`. **STOP: owner OK required.** | runbook | Cloudflare write. |
| OG12 | `wrangler secret put`, `wrangler tail`, `wrangler deployments list`. **STOP: owner OK required.** | runbook | They run on the owner's account. |
| OG13 | The `STREAM_SRT_ENABLED` flip. **STOP: owner OK required.** | post-merge | Product exposure. Needed only if S2's SRT check fails. |
| OG14 | The staging runbook, S1–S11. **STOP: owner OK required.** | post-merge | Live stg on real Cloudflare Stream, billed. |
| OG16 | The deploy-order race. **STOP: owner OK required:** the owner acknowledges it. | before OG6 and OG8 | See "Deploy notes". |

**Already done:**

- OG1: the T1 hand-off to capture, 2026-10-01.
- OG2: Option B, 2026-10-01.
- OG3 and OG4: push, and this PR opened as a draft (#920), 2026-10-05. Smoke CI runs on the PR; e2e does **not**.
- OG15: the `e2e.yml` tunables, and its extension to the `CAPTURE_QR_V2_ALWAYS` lines, 2026-10-05.

**OG11 (KV) is not triggered,** because R2 is option S.

## Parked and later

- **Parked:** `CF-Connecting-IP` can be forged through the open `*.fly.dev` origin. It belongs to the app-wide origin
  lock, **F-CF5**. Today it affects only failure throttling.
- **Pending the owner:** the YouTube one-vs-many-video behaviour (S10), and the organiser help text that waits on it.
- **Later, PR-2 (final review G-1): a stream code outlives its issuer's membership.** A phone start is
  attributed to the code's `issued_by` (`stream-sessions.ts`, `capture-phone.ts`), and removing a member does not touch
  `fixture_stream_codes`. A removed staff member, or anyone holding a photo of the QR, can still start that fixture's
  paid broadcast to the org's own saved destination until Revoke & reissue or code expiry. The damage is bounded to
  the org's own channel and credits. **Owner decision 2026-10-05: fixed in PR-2.** A user's codes are revoked when their membership is
  removed, so the phone sees the existing `code_ended` answer, with no contract change.
- **Later: PR-2** (spec §7: automatic mode, auto stop, the phone-health line, the takeover notice; migration V431). It
  has its own plan, `docs/superpowers/plans/2026-10-01-capture-qr-v2-pr2.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01TjQbpEqgvMnChEfQMYTcuV
