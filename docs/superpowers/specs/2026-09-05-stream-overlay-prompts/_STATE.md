# Stream overlay — resume state

**Read this first.** It says what exists, what is decided, and the next
action in order.

**Implementation HAS started, and TWO waves have MERGED.** T1 shipped as
**PR #752** (merge `1d1f34d69`) and W1 as **PR #761** (merge `0dc6fe1b9`,
2026-09-10), both from branch `feat/stream-overlay`. The programme carries
production and test code under `apps/web`, and `db/` is no longer untouched —
`V401__fixture_stream_url.sql` and `V402__streaming_entitlements.sql` are on
`main`. Anything below that says "no code exists", "docs only", "no migration
exists yet", or names #752 as an OPEN pull request describes the tree before
2026-09-10 and is marked where it survives as a prior record.

Last updated: **2026-09-14 (later)**, by the R1 plan session:
**R1 is READY TO START in a new session. Nothing is built yet.** The plan is
`../../plans/2026-09-13-streaming-r1.md`, amended the same day to capture every fact the relay
produces. Every recommendation the plan carried is now ruled; see `_INDEX.md`'s three 2026-09-14
sections: "R1's plan WRITTEN", "where the relay runs, and in what language", and "capture all
data".

**To start R1, in a fresh session:**

1. Read, in order: this file's block; `_INDEX.md`'s three 2026-09-14 sections;
   `docs/superpowers/RULES.md` (both owner checklists); `_RULES.md` beside this file; then the plan.
2. Execute the plan with `superpowers:subagent-driven-development`: `model: opus` on every dispatch,
   a reviewer after every lane, and the orchestrator re-running the gate at each lane boundary.
3. **Task 0 first**, alone:
   - cut `.claude/worktrees/relay` (branch `feat/stream-relay`) from current `main`;
   - stand up env label `rly` with the `seazn-local-env` skill;
   - re-pin every line reference — `main` moved past the plan's pin (#782, #784);
   - take the baseline;
   - put the two open data decisions (personal data in telemetry, telemetry retention) to the
     owner before Task 1 writes the migration.

**Already in place:** the Cloudflare token and account, Stripe sandbox keys, `AUTH_SECRET`, and
`RELAY_KEK` (both `.env.local` files, generated 2026-09-14).

**Owed by the owner, each before the step that needs it:**
- the Fly API token (Task 5A's live test);
- the Sentry DSN (Task 17);
- the daily relay-sweep workflow in `onryde/seazn.club.workflow`;
- `RELAY_KEK` as a Fly secret on staging and production;
- optionally, an unlisted YouTube key;
- cleared GitHub Actions billing — every job on `main` failed unstarted on 2026-09-14, and PR-R1's
  `ci.yml` needs it.

**Merge path:** a PR (not a direct push), with `ci.yml` green, e2e dispatched against the PR, a
review, and the owner's per-screen sign-off. R2's plan follows PR-R1's merge; R3 lives in the
capture repo.

## Environment (label `rly`, stood up 2026-09-14 from `.claude/worktrees/relay` @ `453d95cd6`)

- `DATABASE_URL=postgresql://postgres@127.0.0.1:54484/seazn_rly` `DATABASE_SSL=disable`
- `SMOKE_BASE=http://localhost:3372` = `PLAYWRIGHT_BASE`; `E2E_PROD_TARGET=1`; `RELAY_DRIVERS=fake` on
  the server once the relay code exists. The port is the label's snapshot — re-read
  `seazn-env env --label rly` after every `rebuild`.
- Placement service up for `rly` on `:50257` (native). `PLACEMENT_SERVICE_HOST` reaches the test
  process only through `seazn-env env`, so gate scripts load that env inside the script and never
  echo the secret.
- `show data_directory` → `/tmp/seazn-env/rly/pg` (contains `rly`; the script also printed "data_directory verified").
- Deltas tail on this branch at Task 0: `V403__realtime_fixture_broadcast_policy.sql`; all-refs `V4*`
  tail: the same `V403`. Task 0 therefore reserved V404 — **superseded 2026-09-16, see FT0-1**:
  main has since landed V404–V407, so **R1's migration is V408**, recorded AS LANDED in `_INDEX.md`.
- Baseline (`apps/web`, full, fresh DB, placement up): **passed 17064 / total 17141 / failed 0 /
  pending 77** — 1266 files, 0 failed suites, `outside-worktree 0`, runner `EXIT=0`. JSON at
  `/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/3a628426-b486-4e22-bbd6-008e2676b7d0/scratchpad/r1/baseline-web.json`.
  No red files (with placement up, `schedule-build-honours-locks.test.ts` is green, unlike the `ovl`
  baseline).
- Lint `✖ 143 problems (0 errors, 143 warnings)`, `LINT_EXIT=0` (via `rtk proxy`); tsc `EXIT=0`;
  `openapi:gen` + `i18n:gen-keys` porcelain: no generated diff (only the two Task 0 docs).
- `stream-overlay.spec.ts` preflight against `http://localhost:3372`: **25 expected / 0 unexpected /
  0 flaky / 0 skipped**, `PW_EXIT=0`, 120 s. This is the regression witness Task 17 compares
  against. #782's overlay drift left W1's spec green on this tree.
- `FLY_API_TOKEN`: owed by the owner (Task 5A's live test skips loudly until it lands).
- Worktree extras: `.env.local` symlinks (root + `apps/web`), `.claude/agent-memory` → the main
  checkout's (listed in the worktree's own `info/exclude`), `RELAY_KEK` confirmed in both env files
  by length check.
- Recreate: `POSTHOG_KEY= NEXT_PUBLIC_POSTHOG_KEY= ~/.claude/skills/seazn-local-env/scripts/seazn-env.sh up --label rly --server`
  from the worktree; `rebuild --label rly` after every code change; `down --label rly` at wave close.

## R1 Task 0 pins (2026-09-14 @ `453d95cd6`)

Worktree `.claude/worktrees/relay`, branch `feat/stream-relay`, cut from `origin/main` @
`453d95cd6`. Line numbers are SNAPSHOTS; every brief cites the SYMBOL. **The plan carries no
`file:line` cites of its own** (a raw `grep -o` for `<file>.<ext>:<n>` over the plan returns 0),
so this symbol table IS the re-pin. Every one of the 26 symbol probes in Task 0 Step 6 HIT.

| Symbol | Seen at |
|---|---|
| `requireResourceAuth` / `requireOrgAuth` | `server/api-v1/auth.ts:362` / `:210` |
| `ROUTES` | `server/api-v1/openapi.ts:67` |
| `NEVER_KEY_ROUTES` | `server/api-v1/key-scopes.ts:301` |
| `reply` / `v1` / `parseBody` | `server/api-v1/http.ts:96` / `:124` / `:252` |
| `handler` | `lib/http.ts:69` |
| `hasFeature` / `requireFeature` | `lib/entitlements.ts:456` / `:668` |
| `UpgradeGate` | `components/upgrade-gate.tsx:252` |
| `setFixtureStreamUrl` | `server/usecases/fixtures.ts:201` |
| `streamUrlSchema` | `lib/stream-url.ts:61` |
| `Tx` / `withTenant` / `sql` | `lib/db.ts:5` / `:183` / `:221` |
| `log` | `server/logger.ts:24` |
| `getStripe` | `lib/stripe.ts:5` |
| `requireBillingOwner` | `server/usecases/billing-manage.ts:174` |
| `credit_pack` branch / `processStripeEvent` / `runEvent` / `sweepStuckEvents` | `server/usecases/billing-events.ts:151` / `:2080` / `:2259` / `:2318` |
| `buildCreditPackCheckoutParams` / `createCreditPackCheckout` | `lib/credit-packs.ts:62` / `:156` (`ui_mode: "embedded_page"` `:76`, `return_url` `:113`, 30 s idempotency key `:179`) |
| `balance` | `lib/credits.ts:94` |
| `mintPublicFixtureToken` | `lib/realtime.ts:224` |
| `CREDIT_PACKS` / `StreamPanelContext` / `relayEntitled` / `stream-tab-phone` / `stream-phone-gate` | `components/v2/fixture-stream-panel.tsx:98` / `:136` / `:141` / `:366` / `:519` |
| `const [streamOpen` | `components/v2/desk/run-sheet-row.tsx:162` |
| `SEED_KINDS` / `SEED_PARAMS` | `e2e/visual/manifest.ts:17` / `:19` |
| `expectNoHorizontalScroll` / `mintLoginPathBySql` / `setBoolEntitlementOverrideSql` / `seedRosteredFixture` | `e2e/helpers.ts:49` / `:274` / `:660` / `:1860` |
| `WALKTHROUGH_SPECS` | `lib/__tests__/e2e-ci-wiring.test.ts:159` |
| `releaseBoth` / `bothStarted` | `server/usecases/__tests__/registration-concurrency.test.ts:481-487` |
| `NEXT_PUBLIC_SENTRY_DSN` (commented) | `fly.toml:11` |
| `jose` / `qrcode` / `@types/qrcode` | `apps/web/package.json:37` / `:47` / `:69` |
| embedded-Checkout donors | `components/buy-credits.tsx:24` (`BuyCredits`; `EmbeddedCheckoutProvider` `:82`); `lib/billing-checkout-client.ts:42` (`orgScopeHeaders()`); `app/api/billing/credit-pack-checkout/route.ts:29` (`POST`, `{ client_secret }` `:57`) |
| Stripe frame idiom | `e2e/walkthrough/event-pass.spec.ts:339` (`frameLocator('iframe[src*="stripe.com"]')`) |
| admin overrides editor | `app/admin/orgs/[id]/page.tsx`; `app/api/admin/orgs/[id]/entitlement-override/route.ts:17` (`POST`) / `:53` (`DELETE`) |
| cron pair idiom | `app/api/cron/registrations/route.ts:15` (503) / `:17` (401) |
| P21 division gate | `run-sheet-row.tsx:386` `showStream`; `app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx:259` `editable`, `:424` `streamOffered`, `:426` `hasFeature(… "streaming.overlay" …)`, `:431` `"streaming.relay"` |
| P14 panel gate | `fixture-stream-panel.tsx:524` `<UpgradeGate feature="streaming.relay" …>`; `en/ui.json:5083` first `"stream.` key |

Negatives, all as expected: no `.github/workflows/relay-sweep.yml`; no `docs/contracts/`; no
`apps/web/src/server/relay/`; `stream-phone-tab` 0 hits (P13); `POLL_MS` in `live-score.tsx` 0
(watch 4 FALSE — Task 13 defines `STREAM_POLL_MS`).

**Drift since the plan's pin `54a125d9f`** (#782 `9a7393cf4`, #783 `198a4a130`, #784). None of
the panel, `run-sheet-row.tsx`, `e2e/helpers.ts`, `e2e/visual/manifest.ts`, `billing-events.ts`,
`credit-packs.ts` or `server/api-v1/**` changed. What did, and what it does to the plan:

- **FT0-1 — the migration tail is `V403__realtime_fixture_broadcast_policy.sql`, not V402.** It
  was ADDED by #782 itself, so the plan's "unchanged at `9a7393cf4`" is false. At Task 0 the
  all-refs scan showed nothing past V403, so Task 0 reserved V404.
  **Re-checked 2026-09-16 and CHANGED: R1's migration is `V408`.** `origin/main` is now
  `ea5b7027a`, four commits ahead of this branch, and landed `V404__retire_scorer_role.sql`,
  `V405__lichess_external_play.sql`, `V406__lichess_challenge_identity.sql` and
  `V407__lichess_lobby_ready.sql`. A duplicate Flyway version survives a clean rebase, so the
  number is fixed BEFORE rebasing, never after. Re-read `ls db/migration/deltas | sort -V | tail -1`
  AND the all-refs `git log --all --diff-filter=A -- 'db/migration/deltas/V4*'` when Task 1 starts:
  that pair, not this line, is the authority — main moves under long waves.
- **FT0-2 — the plan's P3 review grep reds on a clean tree.** `grep -a -rn "SUPABASE_JWT_SECRET"
  apps/web/src --include=*.ts | grep -v "lib/realtime.ts"` prints 8 lines, all in
  `lib/__tests__/realtime-publish.test.ts` (added by #782). Task 6's own `tokens.test.ts` will
  add more by design. The review probe becomes: exclude `__tests__` directories, and fail on any
  hit in production code. (Also quote `--include='*.ts'`: zsh aborts on the bare glob with "no
  matches found".)
- **FT0-3 — `lib/realtime.ts` now exports FOUR functions** (`resolveRealtimeMintKey` added by
  #782: an ES256/RS256 private key preferred, `SUPABASE_JWT_SECRET` only as the HS256 fallback).
  P2 still holds — none of the four is a producer mint. Task 6's G1 witness (same claims signed
  with `SUPABASE_JWT_SECRET` → 401) is still valid, because relay tokens verify on `AUTH_SECRET`
  only.
- **FT0-4 — `ui.stream.*` has 31 keys, not 33.** #782 removed `stream.tab.slate` and
  `stream.preview.slate` (the two surviving mentions are string probes in
  `overlay-dict-coverage.test.ts`). P15 reads "extends the 31 existing keys".
- **FT0-5 — P6's e2e replay witness is VACUOUS as written.** `sweepStuckEvents` selects only
  `processed_at is null and received_at < now() - 10 minutes` (`billing-events.ts:2324-2330`), so
  a purchase the webhook already processed is never selected. "Drive `POST
  /api/cron/billing-events`, assert the balance is unchanged" stays green with the
  `stripe_event_id` dedupe deleted. The replay must go through the real claim instead:
  `runEvent(sameEvent)` → `false`, or `replayEvent` → `"already_processed"`, plus a direct
  second call of the webhook branch asserting one ledger row. Owed to Tasks 8 and 15.
- **FT0-6 — `R0-CORRECTIONS-FOR-R1.md` was not in the repo.** The plan names it as the overriding
  authority (6 references), but it existed only in the plan session's `/tmp` scratchpad. It is now
  committed beside this file.

**Owner data rulings at Task 0 (2026-09-14), folded into Task 1's migration (V408 — see FT0-1):**
- **Telemetry retention — "2 is ok":** `fixture_stream_events` and `stream_provider_calls` kept
  indefinitely; raw `fixture_stream_samples` deleted after 90 days by the daily sweep
  (`SAMPLE_RETENTION_DAYS = 90`); the per-session `sample_summary` kept regardless.
- **Non-personal additions — "all":** (a) app build sha on every event and sample; (b) sport,
  competition, division, scheduled start, venue (via `fixtures.court_id` → `courts.venue_id`,
  null when no court) and org timezone snapshotted on the session; (c) entitlement source at
  admission; (d) recording facts after finalise; (e) QR shown / credentials revealed, first-at and
  count; (f) per-session cost estimate; (g) destination output uid and output error codes; (h)
  Cloudflare ingest edge location. Still never stored: raw IP, user agent, device ids, credentials.
- **Narrowed by a read-only Cloudflare probe, 2026-09-14** (field shapes only, no values; orchestrator
  rulings, each recorded in the SDD ledger with its cost if wrong):
  - **(h) dropped.** `GET /live_inputs/{uid}` returns no colo, location or region field. Its
    `status.current.reason` is captured instead.
  - **(d) narrowed.** A video carries `size`, `duration`, `input.width`, `input.height`,
    `status.state` and `status.errorReasonCode`, but no codec field. Values read -1 or 0 while
    `live-inprogress`, so they are written only after finalise.
  - **(c) narrowed to "granted by override: yes/no" at admission,** read through the existing
    `overrideRow`. The resolver (`resolveFromDb`) returns no source, and in R1 every granted org is
    an override anyway.
  - **(a) reads the image tag.** Fly's docs list `FLY_IMAGE_REF` as a runtime env var, and
    `prod.yml` / `stg.yml` deploy with `--image registry.fly.io/<app>:${{ github.sha }}`, so its
    tag should be the commit sha. `config.ts` takes the tag only when it is 40 hex characters,
    otherwise null (locally, in CI, or for a builder-tagged `deployment-…` image). One staging
    read confirms it.
- **Device GPS — owner wants it ("GPS").** Recommendation, not an owner ruling: it lands in
  **R3**, not R1. In R1 the phone streams straight to Cloudflare and no phone→app call exists, so
  an R1 column would have no writer. **Owed to R3's plan:** GPS from the capture app to our API,
  behind the OS permission prompt and consent copy, plus four owner questions — precision (raw or
  rounded to ~1 km), cadence (once at go-live or a track), retention, and privacy-policy copy.

**P7 — confirmed.** `requireBillingOwner` resolves the org from `x-seazn-org` or the `seazn_org`
cookie, then requires `subscriptions.owner_user_id` = the caller (a group payer, not the org
owner). `requireOrgAuth` is an org-role gate. So the plan's choice holds: the relay-checkout
route uses `requireBillingOwner` AND asserts the resolved `orgId` equals the body's `orgId`.
**P6 — as read.** The webhook route calls `runEvent` synchronously: it claims the row, runs
`processStripeEvent`, then stamps `processed_at`. `sweepStuckEvents` is a retry after 10 minutes,
capped at 3 attempts. So the purchase lands on the webhook; the cron is the fallback, not the
path (and see FT0-5).

Earlier the same day, by the R1 plan session (branch `docs/streaming-r1-plan`): R1's plan was
written, with fourteen owner rulings recorded in `_INDEX.md` "2026-09-14 — R1's plan WRITTEN".

Prior record — last updated **2026-09-12**, by the R0 bench wave (branch `docs/streaming-r0-memo`):
**R0 is CLOSED — its memo is `R0-memo.md` beside this file, and the Cloudflare
gate that blocked three items is cleared.** W1 CLOSED; W2 is next and owes a
task-zero RE-PIN; R1 and R2 are prompts with no plans; R3 is deferred to the
capture repo. **R2's plan is NOT yet writable** *(corrected 2026-09-13; this line first
said the gate was open)*: `R2-compositor.md` gates R2 on the R0 memo **and PR-R1 merged**,
and its plan re-pins on that merged tree — `runner-fly.ts`, the token and session APIs do
not exist yet. **The next writable plan is R1's**, whose gate (PR1 merged, #761) is open.

**Read `R0-memo.md` before planning R2.** It reverses the design of record's
compositor choice (B2, not B3), names the guest size and its price, and records
six false premises in the design itself — including that §7.2's graceful stop
cannot work as written and that the pull path is not LL-HLS.

## 2026-09-10 — where things stand (R2-prep; SUPERSEDES the 2026-09-08 block below)

- **W1 is CLOSED.** Merged 2026-09-10 as **PR #761** — `0dc6fe1b9`, "Merge pull
  request #761 from onryde/feat/stream-overlay" (verified against `origin/main`
  on 2026-09-10). Its close is the pair of `## 2026-09-10 —` sections in
  `_INDEX.md` — the measured gate numbers, FS-W1-8a's clipped footer, the three
  false premises, the two seed traps, and **"W1 closing: what is OWED to the next
  wave"**. That file is the authority for all of it; do not re-derive it here.
- **T1 is DONE and MERGED** as **PR #752** (`1d1f34d69`). The 2026-09-08 block
  below still describes #752 as an open pull request waiting on a
  `workflow_dispatch pr=752` run and a per-screen sign-off. Both are discharged;
  read that block as history.
- **W2 is NEXT, and it owes a task-zero RE-PIN before any step runs** — the rows
  annotated in `W2-moments.md` and in
  `../../plans/2026-09-05-stream-overlay-w2-moments.md`, with
  `match_centre.timeline` to be evaluated as the moments source. The spectator-W1
  gate that blocked it is open (PR #743 merged 2026-09-08); the RE-PIN is not.
- **R0 is CLOSED (2026-09-12, `R0-memo.md`). R1 and R2 are PROMPTS with NO
  PLANS and have not started.** No
  compositor code exists in the tree — no `x11grab`, no `module-null-sink`, no
  `runner-fly.ts`. Plans are still written one wave ahead: R1's gate ("after PR1
  merges") is now OPEN, since PR1 is #761; R2's plan waits on the R0 memo.
- **R3 is DEFERRED to the capture repo** (owner ruling 18: "R3 native apps in
  their own spec in the capture repo"). Its inherited risks **P1–P5** are
  recorded in `_INDEX.md` rather than here, because two of the five constrain
  work in THIS repo: **P5** (a device spike on real handsets) is startable NOW
  and blocks the R3 estimate; **P1** (iOS drops the camera when backgrounded)
  changes what R2's soak should prove.
- **[CLEARED 2026-09-12 — the account and token already existed in `.env.local`;
  R0 ran against them and U1's hold-window question is answered in `R0-memo.md`
  §4a. Kept as the prior record.]** **ONE owner action gates THREE items.** R0,
  R1 and the U1 spike
  (`_OPEN-QUESTIONS.md` Q17) all wait on the same thing: **provisioning a
  Cloudflare account and a Stream-scoped API token.** The code tree references no
  Cloudflare env var at all — `CF_ACCOUNT_ID` and `CF_API_TOKEN` appear only in
  `README.md:164-165` and nowhere under `apps/`, `packages/` or `scripts/`
  (verified 2026-09-10). Nobody can size the guest, provision a live input, or
  answer U1 until that account exists. It is the single highest-leverage
  unblock in the programme.
- **Migration numbers: the RULE still holds and the collision is already real.**
  `main` now ends at `V402__streaming_entitlements.sql`, so design §5.1's `V401`
  and §6.1's `V402` are BOTH taken. Take the next free number after
  `ls db/migration/deltas | sort -V | tail -1`, re-read at every rebase. A
  duplicate Flyway version survives a clean rebase with no conflict.
- **This wave:** **R2-prep**, branch `feat/stream-r2-prep`, opened 2026-09-10 —
  documentation only, folding the 22-row register
  `_FINDINGS-2026-09-10-relay-signal-path.html` into its owning documents before
  R2 starts and the window closes. Brief and fold map:
  `_WAVE-2026-09-10-r2-prep.md`; per-row audit trail in `_INDEX.md`.

## 2026-09-08 — where things stand (read this block, then the tables)

- **Planning is COMPLETE and ON MAIN.** Owner approved the design
  ("approve") and ruled "push to main": merge commit `b2244879f` carried the
  spec, the four wave prompts, the re-pinned W1/W2 prompts and the
  `RULES.md` owner checklist. The T1 plan + W1 amendment (`c8dc4d07f`) and
  the plan review follow in a second merge.
- **Shareable spec page:** https://claude.ai/code/artifact/b7e7d0c8-e254-4d6e-80f0-161681ae797a
  (rebuilt from the spec by `scratchpad/build-spec-page.mjs`; republish
  after any spec change).
- **`main` moved under us on 2026-09-08:** desk W3 (#740) and settings W8
  (#744) merged. Consequences recorded in the spec's findings: FS14 —
  `run-sheet-edit-time` is now `desk/run-sheet-row.tsx:407` (was `:377`;
  the symbol is the authority). ~~Deltas still end at `V399`.~~ **They end at
  `V400__repair_orphaned_age_cutoff_half.sql` as of later that day** — which is
  exactly why this programme now reads the tail instead of writing a number
  down. Do not trust this line either; run the `ls`.
- **2026-09-08 (later) — spectator W1 MERGED (PR #743, `main` 60c0615b0;
  worktree rebased, HEAD `09f5fa1de`+).** Consequences applied (design FS18):
  the live transport already exists at
  `components/public-site/match-centre/use-live-fixture.ts:17` — W1 Task 1 is
  rewritten to widen it IN PLACE (no lift; `LiveScore` wrapper is RETIRED,
  `live-score.tsx` exports only `LiveScoreBody`); the public payload carries
  `match_centre` (with `timeline: TimelineLine[] | null` — NO event `type` on a
  line); **the W2 gate is OPEN** — W2 waits on PR1 and its own task-zero RE-PIN
  (rows annotated in `W2-moments.md` and the W2 plan; `match_centre.timeline`
  to be evaluated as the moments source, F4 unchanged); `run-sheet.tsx`
  mounts re-pinned to `:355/:390/:428/:669`; `WALKTHROUGH_SPECS` now lists the
  two spectator walkthroughs, so W1 Task 8's insertion point moved.
- **Findings since the design was written:** FS10 credits donor is
  `ai_credit_ledger` (V320) + `lib/credits.ts` + `credit-pack-checkout` +
  `billing-events.ts:151`, not size packs; FS11 Stripe events may be applied
  by `api/cron/billing-events`; FS12 landing catalogue rows are FALSE for
  all five plans; FS13 `public_fixtures_v` latest definer is `V369:18`.
- **Plan review:** `_REVIEW-2026-09-08-plans.md` (reviewer pass over the T1
  plan and the amended W1 plan; fixes applied before the second merge).
- **T1 IS DONE (2026-09-08).** All four tasks executed from
  `../../plans/2026-09-07-streaming-t1.md`, on `feat/stream-overlay`, in
  **PR #752**. The commits are the range **`origin/main..feat/stream-overlay`** —
  count them with `git log --oneline origin/main..feat/stream-overlay` rather
  than trusting a number written in a document, because each fix round appends
  one. **Anchor on `origin/main`, never on a merge-base sha**: this line first
  read `0cc4614b8..`, and the 2026-09-08 rebase made `0cc4614b8` an ancestor of
  `origin/main`, so that range then swept the 79 replayed `main` commits too.
  Measured on `9164a926a`: `git rev-list --count 0cc4614b8..feat/stream-overlay`
  → **93**; `git rev-list --count origin/main..feat/stream-overlay` → **12**.
  Owner picks **1A · 2A · 3A · 4A · 5C**
  plus the ink-hairline addendum are in `_THEMES.md`; the full close — gate
  numbers, mutant killer lists, findings, deferred minors — is the
  "## 2026-09-08 — T1 wave CLOSED (PR-T1 #752)" section of `_INDEX.md`, which is
  the authority for all of it. (This bullet replaces the "NEXT ACTION: execute
  the T1 plan" instruction that stood here; Task 4 owned rewriting it and has.)
- **NEXT ACTION:** see "## THE FIRST THING TO DO NEXT SESSION" below. In short:
  PR #752's pre-merge e2e (`workflow_dispatch pr=752`) and the owner's
  per-screen sign-off, then **W1** from
  `../../plans/2026-09-05-stream-overlay-w1.md` (amended). R1's plan is written
  after PR1 merges, R2's after the R0 memo — one wave ahead, never earlier.

## T1 — what shipped, and what it handed forward (2026-09-08)

`_INDEX.md`'s "## 2026-09-08 — T1 wave CLOSED (PR-T1 #752)" is the single
authority for the detail: the commit table, the gate numbers, the mutant killer
lists, the findings and the deferred minors. Repeated here only so a resume
read knows what exists and what is owed.

**Shipped** — `apps/web/src/lib/contrast.ts`,
`apps/web/src/components/overlay/overlay-tokens.ts` and its eleven-sport
contrast sweep, `apps/web/e2e/visual/{manifest.ts,manifest.json,seeds.ts,asserts.ts,capture.spec.ts}`,
`overflowingIn` moved into `apps/web/e2e/helpers.ts`, `visualSeedRoutesSuite` in
`scripts/smoke.ts`, `docs/runbooks/visual-gate.md`, the T1a sections of
`_THEMES.md`, and one production fix (`court-card.tsx`, a `min-w-0` on the
truncate chain). **No migration, no dictionary key, no user-facing string.**

**Gate, on the tree at commit 10 of the range** (`knownDefects honoured one
check and lied about the other four`, the last Task 3 commit — its pre-rebase
sha no longer resolves)**:** full `apps/web` vitest **15543 / 15620 / 4 failed**
against the baseline's **15121 / 15198 / 4** — **+422 tests, delta failed 0**,
and the four reds are the baseline's own environmental placement file. Six PNGs,
all hashes distinct; `mobile.spec.ts` @ mobile-320 **44 / 1 / 0**, the exact
pre-change witness; spectator walkthroughs **19 / 0**; smoke visual-gate 4/4;
`tsc` 0; lint 137 warnings / 0 errors, unchanged from baseline.

**One caveat on the seven-width sweep (271 / 1 / 4):** the single red is
`page smokes: settings save + invoice/plan card render`, a read-modify-write on
the org name against the SHARED Pro org, raced by running seven width projects
against ONE local server and database. It is a **run-method artefact** — CI
matrixes those widths into separate jobs with their own DB — and it is recorded
as one rather than as a pass. Run the widths one project at a time locally.

**Handed forward, and each will be silently dropped if not carried:**

1. **The `--sport-ink` hairline is an e2e obligation on W1.** Two contrast
   findings (football's chip at 2.56, hockey's live dot at 2.75) are closed as
   *covered* rather than waived, and the covering element is a 1-px border that
   **no node-environment test can see**. If W1's e2e does not assert it, both
   closures are unbacked. Named in `W1-step-one.md` acceptance.
2. **`overlay-tokens.ts` owes an e2e and a smoke**, and W1 Task 8's are named as
   its. The module has no HTTP surface until the overlay route exists.
3. **`auth: true` and `seed: "none"` must be named as first-use in W1-E's
   brief** — live harness code no manifest row drives.
4. **Two `main` findings need an owner and a wave:** `standings-table.tsx:58`
   (axe SERIOUS, `scrollable-region-focusable`; the fix owes a new string in
   four locales across three surfaces) and `live-score.tsx:245`, the
   `truncate`-without-`min-w-0` twin of the `court-card.tsx` fix. **The second
   was being carried as "on a retired component" — that is wrong.** The
   `LiveScore` WRAPPER is retired; `LiveScoreBody`, which contains line 245, is
   mounted at `summary-tab.tsx:58` and `match-centre.tsx:90` and its branch
   renders whenever `suppressScorebug` is false — cricket on the Summary tab,
   and the no-document fallback, which passes the prop not at all. What is true
   is only that no manifest row photographs it. See `_INDEX.md` FS-T1h.
5. **An owner question for W2's planning:** `_THEMES.md` §5 scopes
   `dismissal-on-board-2` to the WICKET slab. If W2 widens it to red-card slabs,
   football measures 2.56 on its own band and the carrier accounting must be
   re-derived.

## Environment (label `ovl`, stood up 2026-09-08 from this worktree @ `4ee38278d`)

This block supersedes the "## Environment" and "## Baseline" sections at the
foot of this file — they describe the 2026-09-05 tree and are kept only as the
prior record.

- `DATABASE_URL=postgresql://postgres@127.0.0.1:54405/seazn_ovl`
  `DATABASE_SSL=disable`
- `SMOKE_BASE=http://localhost:3303` = `PLAYWRIGHT_BASE`; `E2E_PROD_TARGET=1`
- `psql "postgresql://postgres@127.0.0.1:54405/seazn_ovl" -tAc "show
  data_directory"` → `/tmp/seazn-env/ovl/pg` (contains `ovl`). Run by hand
  2026-09-08; this is the psql output, not the script's
  `BENCH_EXPECTED_DATA_DIR`. The script separately verified the same value
  against its own datadir ("data_directory verified" in its log) before
  reporting the server ready. This is the check that tells our cluster apart
  from a squatter's — a `pg_ctl` that failed "Address already in use" is
  followed by a `createdb` that SUCCEEDS against another session's server.
- Deltas tail when the env was stood up: `V399__stats_player_career_split.sql`.
  **That number is already stale** — `main` took `V400__repair_orphaned_age_cutoff_half.sql`
  later the same day. T1 adds no migration. **No number is reserved for this
  programme; read the tail yourself** — see the rule under "Where the work
  lives" below.
- Baseline (`apps/web`, full, fresh DB, tree = `origin/main` + this branch @
  `4ee38278d`): **passed 15121 / total 15198 / failed 4 / pending 73** — 1182
  test files, 1 failed; `outside-worktree 0` (every `.testResults[].name`
  resolves under this worktree); runner exit 1. JSON at
  `/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/80298fc7-d342-412c-85bd-3bd1f75ab7f6/scratchpad/t1/baseline-web.json`.
  Red files: `apps/web/src/server/usecases/__tests__/schedule-build-honours-locks.test.ts`
  — all four assertions fail `AssertionError: expected undefined to be
  '2026-08-01T19:00:00.000Z'`. Classification **ENVIRONMENTAL**: the suite needs
  the CP-SAT placement service and `up` was not given `--placement`. Not
  attributable to this branch (which carries no code) and not to `main`.
- Lint `✖ 137 problems (0 errors, 137 warnings)`, `LINT_EXIT=0` — read through
  `rtk proxy pnpm run lint`, since plain `rtk` hides this output entirely; tsc
  `EXIT=0`; `openapi:gen` + `i18n:gen-keys` porcelain: **EMPTY both before and
  after**, so no generator drift on an untouched tree and no finding against
  `main` from that step.
- `mobile.spec.ts` @ mobile-320 before Task 3: **44 passed, 1 skipped, 0 failed**
  (2.2 m), `PW_EXIT=0`. Both `auth.setup.ts` projects passed first, so the
  served build is this tree's. This is the pre-change witness Task 3's helper
  move is judged against.
- Q12 (`pass-scoping-guard.test.ts`): **green on this tree.** The 2026-09-05
  note's "two reds, unclassified" do NOT reproduce; closed as green on
  `4ee38278d`. Nothing to attribute, nothing to fix.
- **`seed:demo` was NOT run** — the env skill lists it as owed by the caller.
  Nothing so far needed it; Task 3's smoke suite may.
- **The 2026-09-07 corpus re-pins are ALREADY LANDED — do not re-pin them.**
  Verified 2026-09-08 (T1 Task 0 Step 8a) on an untouched tree; they were
  committed at `8d31cb34f` / `c8dc4d07f` and their CONTENT is on `main`, so a
  rewrite would stage nothing. **The obvious ancestry check disagrees with the
  word "reached", and that is expected, not a missing merge**: `8d31cb34f` IS an
  ancestor of `origin/main`, `c8dc4d07f` is NOT — it was squash-merged, so
  `main` carries its changes under a different sha and
  `git merge-base --is-ancestor c8dc4d07f origin/main` returns false. Verify
  these by content, never by ancestry alone. (Re-run after the 2026-09-08
  rebase and unchanged. Both still `cat-file -e` in THIS clone, but
  `c8dc4d07f` is reachable from nothing now — a fresh clone will not have the
  object at all, which is the same reason the commit table above is keyed by
  position rather than by sha.)

  The five checks and what they printed: `"re-pinned 2026-09-07
  @ fb99bbd4c"` in `W1-step-one.md` → **7 as of the final-review fix round,
  2026-09-08; it was 8** — scope 4's entitlement migration lost its marker when
  that line was rewritten from the reserved `V401` to the `V<next+1>` RULE, and
  the re-pin it recorded is exactly what the rule supersedes. **The floor moves
  DOWN to 7 rather than the check reading as a regression**, and the general
  form is: when a marked line is deliberately rewritten, re-derive the floor and
  say why here — never restore a marker to satisfy a count, which turns the
  sentinel into decoration. (The remaining margin is still zero, so the original
  warning stands: an accidental drop takes this below its floor silently.)

  **A bare count still cannot tell a deliberate retirement from an accidental
  drop** — a round that retires one marker and loses another nets to 7 and
  reads clean. So the floor is a ROSTER, not an integer. The seven surviving
  markers and the scope each belongs to, re-derived 2026-09-08 from
  `grep -an "re-pinned 2026-09-07 @ fb99bbd4c" W1-step-one.md`:

  | Line | Owning scope |
  |---|---|
  | `:27` | header — desk sequencing (W1/W2 merged, W3 is the contention) |
  | `:209` | scope 5 — the cookie banner (Q2 + FS1) |
  | `:226` | scope 5 — `hasFeature` at `lib/entitlements.ts:456`, moved from `:454` |
  | `:270` | RP1 — `FixtureLine` / `fixture-schedule-toggle` retired by desk W2 |
  | `:342` | do-not-touch list — `stages-panel.tsx` is no longer the mount |
  | `:486` | acceptance — `fixture-schedule-toggle` absent, `run-sheet-edit-time` present |
  | `:536` | merge gate — rebase after any desk-W3 merge touching `desk/run-sheet-row.tsx` |

  Retired so far: **scope 3/4's migration numbers**, when the reserved
  `V400`/`V401` became the `V<next>` RULE (final-review fix round, 2026-09-08).
  Check the roster by SCOPE, not by count: a line number here moves whenever
  the file is edited, so match on the owning scope and re-derive the numbers.
  `"eleven"` in
  `_RULES.md` → **3** (R16 widened); `"run-sheet-row.tsx"` in `W1-step-one.md`
  → hit at `:29` (RP1 re-pinned; the mount is the SYMBOL
  `data-testid="run-sheet-edit-time"`, never a line number); `"set point"` in
  `W2-moments.md` → **5** (F3 landed); `"^| T1 |"` in `_INDEX.md` → **empty**,
  which was the row Task 0 then added.
- Recreate from this worktree with
  `POSTHOG_KEY= NEXT_PUBLIC_POSTHOG_KEY= ~/.claude/skills/seazn-local-env/scripts/seazn-env.sh up --label ovl --server`;
  `rebuild --label ovl` after every code change. **Blank both PostHog keys**:
  `captureServer` reads `POSTHOG_KEY ?? NEXT_PUBLIC_POSTHOG_KEY` and
  `.env.local` carries a real key, so a browser-driven local run otherwise
  posts to the LIVE PostHog project.

## Where the work lives

- Branch `feat/stream-overlay`, worktree `.claude/worktrees/stream-overlay`,
  **based at `4ee38278d`** (Task 0 Step 1, 2026-09-08). Every docs commit of
  this programme is already ON `main`: the branch was 0 ahead / 3 behind, so
  `/usr/bin/git rebase origin/main` was a FAST-FORWARD, not a replay. The
  earlier "rebased onto `fb99bbd4c`, 24 unpushed docs-only commits,
  force-pushed" no longer describes this branch — nothing is carried and no
  force-push is owed. **`main` moves under this branch several times a day**
  — during Task 0 alone #747 `feat/pad-attribution-side-groups`, #748
  `docs/spectator-w1-merged`, then #750 `fix/money-path-gate-arming` (which
  touched only `.github/workflows/e2e.yml`, no contention with this
  programme). So treat any ahead/behind written here as a SNAPSHOT and re-run
  `/usr/bin/git rev-list --left-right --count origin/main...HEAD` before
  trusting it. At the close of Task 0 the branch was **1 ahead** (the Task 0
  docs commit) **and 2 behind**, and `origin/feat/stream-overlay` still
  pointed at the pre-Task-0 `01669d287` — the push is the main session's call.
  The previous directory at that path was an unregistered residue and was
  moved to `.claude/worktrees/stream-overlay.stale-20260907`; the worktree was
  re-added from the branch. ~~The branch has no PR (docs only).~~ **It has one:
  PR #752**, opened 2026-09-08 once T1 landed code — **and #752 has since
  MERGED (`1d1f34d69`), as has W1's PR #761 (`0dc6fe1b9`, 2026-09-10).**
  R2-prep works from a different branch and worktree: `feat/stream-r2-prep`,
  `.claude/worktrees/stream-r2-prep`.
- ~~Every commit is documentation, all under `docs/superpowers/`.~~ **False
  since T1.** The branch now carries production and test code under `apps/web`
  (`lib/contrast.ts`, `components/overlay/overlay-tokens.ts`, `e2e/visual/**`,
  `e2e/helpers.ts`, `court-card.tsx`) plus `scripts/smoke.ts` and
  `docs/runbooks/visual-gate.md`. Still nothing under `packages/` or `db/`.
- ~~**No pull request, deliberately.**~~ **PR #752 is open.** The reasoning
  behind the old bullet still holds and is why the PR waited for code: CI and
  smoke run on `pull_request`, so a docs-only PR buys nothing. **e2e does NOT
  run on pull requests** — `.github/workflows/e2e.yml` triggers on push to
  `main` only, so the ONLY pre-merge e2e signal for #752 is
  `workflow_dispatch` with `pr=752`. Re-read `e2e.yml` rather than trusting this
  sentence; that trigger has changed three times in one day before.
- **Migrations: a RULE, never a reserved number.** This bullet used to read
  "this programme takes V400 / V401 / V402". `main` took
  `V400__repair_orphaned_age_cutoff_half.sql` during the T1 wave, so the
  reservation was already wrong — and renumbering to V401/V402/V403 would just
  reset the same trap. **Take the next free numbers after
  `ls db/migration/deltas | sort -V | tail -1`, re-read at every rebase and
  again immediately before writing the migration file. Never carry a number
  forward from a document.** A duplicate Flyway version survives a clean rebase
  with no conflict, which is why the check is at every rebase and not once.
  T1 adds no migration; **W1 is the first wave here that needs one.**

## The documents, and what each is for

| File | Role |
|---|---|
| `../2026-09-07-streaming-programme-design.md` | **design of record** (owner-approved 2026-09-07): Tier A rewritten in, T1, credits, Tier B, compositor, R0, testing, plan structure, findings |
| `../2026-09-05-stream-overlay-design.md` | superseded; kept for the canvas links and the approval record |
| `_INDEX.md` | decision log, owner rulings verbatim (1–23), false premises, both pinned-symbol tables, the 2026-09-07 section, and **"## 2026-09-08 — T1 wave CLOSED"** — the authority for T1's gate numbers, mutant killer lists, findings and deferred minors |
| `_RULES.md` | R1–R17 standing rules and the eight merge gates |
| `_THEMES.md` | binding values at 1920×1080; §3 `bar`, §4 `bug`. **T1a LANDED 2026-09-08**: §4a slate, §8a Phone tab, §8b credits card, the decided/void rows, §5's derived slab ink and §2's contrast + ink-hairline rows. It supersedes design §7.6 on the Phone-tab QR floor, and it is the authority `overlay-tokens.ts` parses — a value typed in both places is a finding, not a convenience |
| `_OPEN-QUESTIONS.md` | the 2026-09-05/06 questions and answers; the design's §12 holds today's open set |
| `W1-step-one.md`, `W2-moments.md` | the wave prompts (corrected in place by the plan's Task 0) |
| `../../plans/2026-09-05-stream-overlay-w1.md` | W1 plan, executes as corrected (Task 0 Steps 2–13 → the overlay endpoint) |
| `../../plans/2026-09-05-stream-overlay-w2-moments.md` | W2 plan, blocked on spectator W1 |
| `T1-theme-and-visual-gate.md`, `R0-bench.md`, `R1-relay-core.md`, `R2-compositor.md` | per-wave PROMPT files (owner ruling 2026-09-07: prompts for every wave now) — written, `8d31cb34f` |
| `../../plans/2026-09-07-streaming-t1.md` (now), `…-r1.md` (after PR1 merges), `…-r2.md` (after the R0 memo) | per-wave PLAN files, written one wave ahead of execution by `writing-plans`; Task 0's steps sit at the head of the T1 plan |
| `docs/superpowers/RULES.md` §"Owner checklist (2026-09-07)" | the owner's checklist; every task's acceptance names its rows |
| Canvas | https://claude.ai/code/artifact/2aebcbde-28ba-45ff-9028-1151873e4901 |

## THE FIRST THING TO DO NEXT SESSION

**Rewritten 2026-09-08 by T1 Task 4.** The two instructions that stood here as
items 2 and 3 are both dead and are named here so a fresh session does not act
on a stale copy of this file:

- ~~"execute Task 0 from the head of the T1 plan"~~ — **T1 is DONE**, Task 0
  included. Re-running it would re-baseline against a tree that has moved and
  re-do corpus corrections already landed.
- ~~"Force-push the rebased branch (`git push --force-with-lease`)"~~ — **no
  force-push is owed, and one would rewrite pushed history.** That instruction
  survived from a state where the branch carried 24 unpushed docs-only commits;
  the branch has since been a fast-forward and is pushed. `git push` plainly, or
  nothing at all.

**SUPERSEDED 2026-09-10 by the R2-prep wave. Items 1–3 below are DISCHARGED**
and are kept only so a fresh session does not act on a stale copy: #752 (T1)
merged as `1d1f34d69`, and W1 merged 2026-09-10 as **PR #761** (`0dc6fe1b9`),
carrying W1-E. Item 4's R1 gate has opened with it. Item 5 is NOT discharged —
FS-T1g (`standings-table.tsx:58`, axe SERIOUS) and FS-T1h
(`live-score.tsx:245`, `truncate` without `min-w-0`) still name an owner and a
wave, and neither belongs to this programme.

**The live order, 2026-09-10:**

1. ~~**The owner action that gates three items** — provision a Cloudflare account
   and a Stream-scoped API token.~~ **DONE 2026-09-12.** The credentials were
   already in `.env.local`; this file did not know. R0 has run, and U1's
   hold-window question (`_OPEN-QUESTIONS.md` Q17) is answered in `R0-memo.md`
   §4a — `timeoutSeconds` governs the hold, the hold is timeout + ~3 s, and at
   180 **no `EXT-X-ENDLIST` is ever emitted**.
2. **W2**, from `../../plans/2026-09-05-stream-overlay-w2-moments.md`, whose
   task zero owes the RE-PIN table in the PR. This is the only wave that can
   move without the Cloudflare account.
3. **The organiser-panel e2e** (`components/v2/fixture-stream-panel.tsx`) — the
   owner-ruled first item of the next wave, still unbuilt. Read the E3
   correction in `_INDEX.md`'s R2-prep section BEFORE writing the rig: the gate
   is four conditions across two files, not the one this file's ancestors
   recorded.
4. **P5, the device spike**, is startable now and blocks the R3 estimate. It
   needs handsets, not this repo, and touches nothing R2 depends on.
5. ~~Then R0's bench~~ **R0 is CLOSED.** ~~Next is **R1's plan** — its gate is open and R1
   has neither a plan nor code.~~ **R1's plan is WRITTEN (2026-09-14,
   `../../plans/2026-09-13-streaming-r1.md`); R1 execution waits on the owner's "start".** R2's plan follows PR-R1's merge and re-pins on that tree,
   and is written from `R0-memo.md`, not from design §7.2/§9.3, both of which R0
   corrects. Plans stay one wave ahead.

**[RULED 2026-09-13 — owner: "follow the order". Guest is `performance-4x`; the LL-HLS beta is to be enabled and measured. See `_INDEX.md` "Owner rulings, 2026-09-13".]** Prior record: two owner decisions were open and both cost money (`R0-memo.md` §2, §3):
whether the `< 80 %` CPU bar is honoured as written — `performance-4x` at
£0.539/3 h misses it by 1–5 points, `performance-8x` at £1.078 clears it and
also buys multi-cam n=4 — and whether to enable Cloudflare's **Low-Latency HLS
beta**, which is off today and is the difference between a ~12.6 s and a claimed
~5 s scorebug for anyone watching a phone-published match.

**The 2026-09-08 order, kept for the record:**

1. **PR #752 (T1).** Two things gate it, and neither is CI-automatic:
   (a) **pre-merge e2e is `workflow_dispatch` with `pr=752`** — `e2e.yml`
   triggers on push to `main` only, so opening the PR ran nothing; re-read
   `e2e.yml` rather than trusting this line. (b) **the owner's per-screen
   sign-off** — six PNGs and the five T1a picks plus the hairline addendum, one
   verdict each. "CI green" is not sign-off.
2. **Then W1**, from `../../plans/2026-09-05-stream-overlay-w1.md` (amended),
   per `superpowers:subagent-driven-development` with `model: opus` per dispatch
   (owner instruction; the agent frontmatter reads `sonnet`). W1's task zero
   owes: a rebase on `main`, the RE-PIN list, and the **migration-number READ**
   — `ls db/migration/deltas | sort -V | tail -1`; no number is reserved, and
   **the W1 plan still names `V400`/`V401` on 24 lines including two literal
   "create this file" steps, while `V400` is already taken on `main`.** Its own
   renumber guard sits at Step 13, after Steps 6 and 3 have written the files.
   Correct the plan's numbers at Task 0, in one edit, before any step creates a
   migration. Full list of the stale locations: `_INDEX.md` FS2. W1's
   acceptance carries **two obligations T1 handed it**, both recorded in
   `_INDEX.md`'s T1 close section and in `W1-step-one.md`: the **1-px
   `--sport-ink` hairline** asserted in e2e (two contrast closures rest on it),
   and this module's **e2e + smoke**, which W1 Task 8 owns.
3. **W1-E's brief must name `auth: true` and `seed: "none"` as first-use** —
   both are live harness code that no manifest row drives today, ruled
   deliberate on the condition that W1-E names them.
4. R1's plan is written after PR1 merges; R2's after the R0 memo. W2 stays
   blocked on its own task-zero RE-PIN.
5. Two `main` findings need an OWNER and a wave, not a fix here:
   `standings-table.tsx:58` (axe SERIOUS) and `live-score.tsx:245` (the
   `truncate` without `min-w-0`). Both are in `_INDEX.md` as FS-T1g / FS-T1h.

## Decisions, all made (owner's words in `_INDEX.md`)

- Shape: one design of record, one programme plan (ruling 18).
- Two keys, corpus names kept: `streaming.overlay` (Pro, Enterprise, Event
  Pass L) and `streaming.relay` (same split, "may buy credits").
- Per-match credits in packs of 1 / 5 / 20, a ledger, consumed at `live`,
  bought from the stream panel's Phone tab through Stripe Checkout (sandbox
  placeholders £6 / £25 / £80; real prices before GA).
- Runner: Fly Machines only, one per session, `lhr`, `auto_destroy`.
- Front door: Cloudflare Stream. Compositor self-mints realtime as a producer.
- T1 wave (theme design + visual gate) runs ahead of W1-C.
- Everything from 2026-09-05/06 still stands: themes are a registry; eleven
  hosts; overlay endpoint over `foldFixture`; football clock ticks and
  survives reduced-motion; panel toggle at every status; cookie banner off the
  overlay segment (now known to need building — FS1); sponsors last; W2 after
  spectator W1.

## Still open, none of them blocking

Design §12: real prices, passthrough half-credit, Enterprise monthly bundle,
Vault vs envelope, YouTube fresh-channel copy, per-destination VOD, mic
default (R3). Q11–Q13 from the earlier set stand as recorded.

**Added 2026-09-10 — and Q17 IS blocking, despite this heading.** `Q17`
(register U1, what the playback side sees while a live input is disconnected) is
the one open question in the programme that gates a wave: it decides whether R2's
slate is driven by frame starvation or by reconnect logic. It cannot be answered
until the Cloudflare account exists. `Q18`/`Q19` are RULED, not open — owner
rulings R-A and R-B, 2026-09-10, recorded as rulings 24 and 25 in `_INDEX.md`.

## Environment (SUPERSEDED — prior record, 2026-09-07)

**Stale as of 2026-09-08** in its FIRST SENTENCE only — the `ovl` environment IS
up, and the coordinates are in "## Environment (label `ovl`, stood up
2026-09-08 …)" above, which is the authority for them. **Everything else in
this section still holds and is kept deliberately:** the `up` FLAGS in the
first bullet — `--server` for e2e and smoke, and **`--placement` before
trusting `schedule-build-honours-locks.test.ts`**, which is the one command
that turns the new block's four ENVIRONMENTAL reds green — and the
worktree-setup traps in the last two bullets.

- No `ovl` database or server is up. Recreate from this worktree:
  `~/.claude/skills/seazn-local-env/scripts/seazn-env.sh up --label ovl`, then
  `eval "$(… env --label ovl)"` → `DATABASE_URL=postgresql://postgres@127.0.0.1:54405/seazn_ovl
  DATABASE_SSL=disable`. Add `--server` for e2e and smoke, `--placement`
  before trusting `schedule-build-honours-locks.test.ts`.
- The re-added worktree has **no `node_modules` and no `.env.local`
  symlinks** yet: `pnpm install --frozen-lockfile` and relative symlinks in
  the root and in `apps/web` before any verify command. A package the
  worktree does not hoist resolves from the MAIN checkout — prove resolution
  with `require.resolve` if a dependency differs between branches.
- Shell guard: `/usr/bin/git` in plain calls, no heredocs, no `eval` or
  sourcing, Write tool for files, `grep -a`.

## Baseline (SUPERSEDED — apps/web vitest, fresh `ovl` DB, 2026-09-05, at `997ad22`)

**Stale as of 2026-09-08.** The live baseline is the one in "## Environment
(label `ovl`, stood up 2026-09-08 …)" above — 15121 / 15198, one red file,
environmental — and it is cited by JSON path, which is the single authority.
Q12 was reproduced there and closed GREEN. Kept as the prior record only.

13,962 passed of 14,041, 74 pending. Five reds: three placement-service
environmental, two `pass-scoping-guard.test.ts` unclassified (Q12). **Stale
after the rebase** — Task 0 re-baselines on `fb99bbd4c` and attributes Q12's
reds on a clean detached checkout before any wave starts.
