# R1 — relay core: sessions, credits, drivers with fakes, tokens, sweep, the Phone tab

**Wave:** R1 · **PR:** PR-R1 · **Gate to start:** PR1 (W1) MERGED to `main`
and the owner's answers to design §12.1 (prices stay sandbox placeholders
until GA — not blocking) and §12.4 (Vault vs envelope — decided at this
wave's Task 0 by reading the Supabase project, not blocking). T1a's Phone-tab
and credits-card artboards picked (gates the VISUAL sign-off only, never the
build). **Depends on:** W1's `fixture-stream-panel.tsx` tab strip with the
Phone tab reading the §5.3 gate; W1's `streamUrlSchema` write path (replay
fill reuses it); W1's `streaming.overlay` catalogue rows. **Worktree:** NEW
`.claude/worktrees/relay`, branch `feat/stream-relay`, cut from `main` AFTER
PR1 merges (never from the overlay branch); env label `rly`
(`seazn-env up --label rly --server` from that worktree; the printed
`DATABASE_URL` wins). **Model:** `model: opus` on every dispatch. **Plan:**
`../../plans/2026-09-07-streaming-r1.md` — written by a Fable agent AFTER PR1
merges (design §11: plans one wave ahead), re-pinning every symbol below on
the merged tree first.

Read first: the design of record `../2026-09-07-streaming-programme-design.md`
§5 (entitlements and money — the authority for keys, ledger, packs, gates,
money mutants), §6 (tables, secrets, routes, state machine, storage guard,
G1), §3.8 (panel; Phone tab), §7.6 (QR contract v1), §9a (design patterns,
each with its exemplar — a brief that cannot name one is not compliant), §10;
`_RULES.md` R1, R7, R8, R10, R14, R15, §Repo traps, §Shell guard;
`docs/superpowers/RULES.md` §"Owner checklist" (all three groups);
`_THEMES.md` §8a/§8b (from T1a).

## Why the wave exists

Tier B's first sellable artefact with ZERO new deployables: an organiser buys
credits from the fixture console, pairs a phone by QR, and goes live
PASSTHROUGH (Cloudflare simulcasts the clean feed to the destination); the
composed mode's data path, tokens and watchdog exist behind fakes so R2 adds
only the Machine and the relay page. Money is one ledger, consumed in the
transaction that makes the stream live.

## Owner rulings that bind this wave (verbatim, dated)

- 2026-09-07: two keys — *"we can keep corpus name as it"* → `streaming.overlay`
  (Pro, OBS) and `streaming.relay` (Tier B, "may buy credits"). Plan split per
  design §5.1: both TRUE for `pro`, `event_pass_l`, `enterprise`; FALSE for
  `community`, `event_pass`.
- 2026-09-07: *"we wwill buy the streaming in the fixture console page
  itself?"* → yes; the purchase surface is the stream panel's Phone tab
  (design §5.3).
- 2026-09-07: *"what do you rec, I think per match? or how can we charge for
  org level?"* → per-match credits in packs of 1 / 5 / 20, a LEDGER not a
  counter, consumed at `live` → **"go"**.
- 2026-09-07, decisions D, E, F → *"all ok"*: the compositor self-mints
  realtime as a producer (no plan bundles `realtime`); `max_duration` 5 h,
  recording retention 7 days, NO auto-end after decided (a "match decided —
  still streaming" chip instead); replay fill only when `stream_url` is null.
- 2026-09-06 (Q14): the test org is revealed by an `org_entitlement_overrides`
  row (over a cookie or a flag).
- 2026-09-07 checklist: "Billing/money claims tested against Stripe SANDBOX,
  never assumed"; "Mutate the MONEY path specifically".

## Task 0 — re-pin on the merged tree (scout, read-only, before any build)

`ls db/migration/deltas | sort -V | tail -1` FIRST — the design intends V401
(keys) and V402 (sessions + credits) but both are "next free at rebase"; a
duplicate Flyway version survives a clean rebase (three times in this repo).
Then re-pin: `hasFeature` (`lib/entitlements.ts:456` at `fb99bbd4c`, the
design says `:454` at `ac85c70` — MOVED, cite the symbol); `requireResourceAuth`
(`server/api-v1/auth.ts:352`); `server/api-v1/schemas.ts`; the cron pair
(`app/api/cron/registrations/route.ts:13-16`; workflow
`.github/workflows/registrations-sweep.yml`, hourly `cron: "37 * * * *"`,
ONE `CRON_SECRET` mirrored into both Fly apps, prod leg gated on
`PROD_SWEEP_ENABLED`); the Stripe completion writer (`checkout.session.completed`
handled in `server/usecases/billing-events.ts:2082` and `:2234`, reached from
`app/api/webhooks/stripe/route.ts` — PIN which of the two paths writes a pack
purchase, and whether the cron route `app/api/cron/billing-events/route.ts`
is in that path); the AI-credits precedent (below); `UpgradeGate`
(`components/upgrade-gate.tsx:252`, props `feature, href, compact, reason,
viewerPlan`); the Supabase project's Vault availability (design §12.4).

**Finding to carry to `_INDEX.md` (FS10, found writing this prompt):** the
repo ALREADY has a credits ledger with packs and a Stripe writer — the AI
credits wallet: `db/migration/deltas/V320__ai_credit_ledger.sql:20`
(`ai_credit_ledger { wallet_id, delta, source, ref, balance_after >= 0,
idempotency_key unique }`), `lib/credits.ts` (`balance :94` = `sum(delta)`,
`grantMonthly :285`, `grantTrial :583`), `lib/credit-packs.ts`
(`CREDIT_PACKS :34`, `buildCreditPackCheckoutParams :62`,
`resolveCreditPackPriceId :133`, `createCreditPackCheckout :156`), route
`app/api/billing/credit-pack-checkout/route.ts` (embedded Checkout,
`requireBillingOwner`), and `billing-events.ts` importing `@/lib/credits`
(`:29`). Design §5.2 names `size-pack-checkout.ts` as the pattern; the AI
wallet is the NEARER donor (a ledger + packs + webhook writer). Two things
the donor does that the design's DDL does not: `balance_after int check
(>= 0)` (a database floor under the `for update` lock) and a generic
`idempotency_key`. **Recommendation to put to the owner, never decided
here:** adopt `balance_after >= 0` on `org_stream_credits` (owner value: a
negative balance becomes impossible at the constraint, so the money mutant
"delete `for update`" is killed twice); keep `stripe_event_id unique` as the
design says (it IS the idempotency key for purchases). Until ruled, build
the design's DDL verbatim.

## Scope (build order; every value from the design § cited, never restated)

1. **Migrations** (numbers = Task 0's next free; header prose to the V393 bar
   "measured, not assumed"):
   - `V4xx__streaming_relay_entitlement.sql`: `streaming.relay` rows for the
     FIVE v18 plans, **`false` everywhere** (design §10.4: dark until GA; W1
     landed `streaming.overlay` the same way), `on conflict (plan_key,
     feature_key) do update`. The §5.1 split (`pro`, `event_pass_l`,
     `enterprise` true for BOTH keys) is the GA flip — ONE later migration
     flips both keys together with the `ENTITLEMENT_DOMAINS` entry and the
     four-locale pricing copy (the standing rule: a row and its copy are one
     unit). `ENTITLEMENT_DOMAINS` UNTOUCHED here. The test org and the pilot
     leagues get BOTH keys through `org_entitlement_overrides` rows.
   - `V4xx__stream_sessions.sql`: `org_stream_targets`,
     `fixture_stream_sessions` (columns and the partial unique index
     `fixture_stream_sessions_one_active` VERBATIM from design §6.1),
     `org_stream_credits` (VERBATIM from §5.2, plus `balance_after` only if
     the owner rules on FS10), RLS enabled on all three with ZERO client
     policies (precedent `V366__rls_billing_org_tables.sql`).
2. **Crypto** `apps/web/src/server/relay/crypto.ts` (new): AES-256-GCM
   envelope per §6.2 — per-row DEK, KEK from env `RELAY_KEK` (Fly secret),
   `seal(plain): Buffer` / `open(enc): string`; Supabase Vault swap if Task 0
   finds it enabled. Static test `server/relay/__tests__/enc-boundary.test.ts`:
   `grep -a` over `apps/web/src` for `rtmp_enc|ingest_srt_key_enc` outside
   `server/relay/**` → must be empty (design §6.2; mutant "reference `*_enc`
   outside `server/relay/**`").
3. **Ports and drivers** `server/relay/ports.ts` (`IngestProvider {
   createLiveInput, inputStatus, addOutput, deleteInput, storageHeadroom }`,
   `RunnerProvider { create, status, delete }` — shapes per §6.4/§7.1),
   `server/relay/ingest-cf.ts` (Cloudflare Stream: recording `automatic` +
   explicit `timeoutSeconds`, `deleteRecordingAfterDays` = 7 (ruling E),
   `outputs = [target]` IFF passthrough — §6.4), `server/relay/runner-fly.ts`
   (Machines REST per §7.1: create with `region`, `guest`, `auto_destroy`,
   `env { SESSION_ID, JOB_TOKEN, APP_URL }`; `delete` for hard kill — the
   `guest` size is a config constant R2 sets from the R0 memo),
   `server/relay/fakes.ts` (`FakeIngest`, `FakeRunner` driving a scripted
   heartbeat sequence; run in CI with no credentials — design §9a "Ports and
   adapters with in-repo fakes"). Driver selection by env `RELAY_DRIVERS=fake|live`.
4. **Tokens** `server/relay/tokens.ts`: jose HS256 over **`AUTH_SECRET`**
   (G1, §6.6; shape donor `mintPublicFixtureToken`, `lib/realtime.ts:91`),
   claims `{ sid, scope: "relay-job" | "relay-page", exp = max_duration + 30
   min }`; verify → 401 on tamper/expiry/wrong scope, **410** once the session
   is terminal. `SUPABASE_JWT_SECRET` is never imported here (P3 grep is part
   of every review). The compositor's realtime token minted server-side under
   the producer doctrine (`lib/realtime.ts` — the existing producer path,
   pinned at Task 0).
5. **Credits usecases** `server/usecases/stream-credits.ts`:
   `creditBalance(tx, orgId)` = `sum(delta)` (donor `lib/credits.ts:94`);
   `consumeForSession(tx, { orgId, fixtureId, sessionId })` — `select id from
   org_stream_credits where org_id = $1 for update`, then the 24 h same-fixture
   reuse rule, then `balance < 1 → throw NoCredits`, else insert `(-1,
   'consume', session_id)` — called ONLY inside the `live` transition's
   transaction (§5.2, §6.4); `recordPurchase({ orgId, delta, stripeEventId })`
   inserting `(+n, 'purchase', stripe_event_id)` — the unique constraint
   makes a replay a no-op (catch the unique violation, return the existing
   row); `grant`/`refund` from the admin plan tools (`admin-addons.ts` is the
   neighbour; one row, `created_by` = admin).
6. **Checkout + webhook**: `POST /api/billing/relay-checkout` (`v1()`,
   `parseBody(RelayCheckout { pack: 1|5|20 })`, `requireBillingOwner` as
   `credit-pack-checkout/route.ts` does) — refuses **before Stripe** with 402
   `plan_lacks_relay` when the org's resolved `streaming.relay` is false; else
   `getStripe().checkout.sessions.create` on the `createCreditPackCheckout`
   pattern (`lib/credit-packs.ts:156`) with metadata `{ kind: "stream_credits",
   org_id, pack }`, `success_url` = the division fixtures tab with
   `?tab=fixtures&fixture=<id>&stream=open`, 30 s idempotency bucket (the
   size-pack idiom). Webhook: the `checkout.session.completed` branch in
   `billing-events.ts` (Task 0 pins which) dispatches `kind ===
   "stream_credits"` → `recordPurchase`. Stripe **sandbox** product with three
   prices (£6 / £25 / £80 placeholders, design §5.2) created by a documented
   one-off script under `scripts/` and their lookup keys in env.
7. **Session API** under `v1()`/`handler()`, zod at `server/api-v1/schemas.ts`,
   OpenAPI `ROUTES` in the same change (R7): `POST /api/v1/fixtures/[id]/stream-sessions`
   (gates in §6.3 order: `requireResourceAuth(fixture, write)` → overlay key →
   relay key (409 `overlay_required` if relay without overlay) → balance ≥ 1
   (402 `no_credits`) → `IngestProvider.storageHeadroom` (503
   `storage_exhausted`) → insert `requested` (the partial unique index turns a
   double start into 409 `active_session`, caught and answered with the
   existing session id) → `provisioning`); `POST …/[sid]/stop` (`desired_state
   = ending`); `GET …/stream-sessions/current` (non-secret projection: state,
   mode, `health`, `qr` payload per §7.6 built server-side from the DECRYPTED
   SRT triplet at request time, balance, `fail_reason`); internal `GET
   /api/internal/relay/sessions/[sid]` and `POST …/heartbeat` (job token;
   heartbeat body → `{ desiredState }`; the beat is the control channel).
   State machine `server/usecases/stream-sessions.ts` — every §6.4 transition
   as one function over the ports, `live` transition wrapping
   `consumeForSession` in the SAME transaction; passthrough's `live` fires on
   `inputStatus == 'connected'` polled by the Phone tab's `current` call
   (server-side poll of the ingest port on each `current` read while
   `warming`, never a client decision).
8. **Sweep** `app/api/cron/relay-sweep/route.ts` — a clone of the
   registrations cron pair: `503` when `CRON_SECRET` unset, THEN `401` on
   mismatch (that order, design §2 row), one idempotent usecase
   `sweepStreamSessions()` with `pg_try_advisory_xact_lock(hashtext(sid))` per
   session; rules: `warming` > 10 min → `failed(no_inbound_timeout)`; `live`
   with `heartbeat_at` older than 90 s → ONE retry (`RunnerProvider.create`
   again on the same session, same creds) then `failed(machine_crash)`; wall
   clock > `max_duration_minutes` → `desired_state = ending`; storage headroom
   below one retained match → a pino warning with the number (§6.5).
   Workflow `.github/workflows/relay-sweep.yml` cloned from
   `registrations-sweep.yml` (every 5 min; same secret; same
   `PROD_SWEEP_ENABLED` gate).
9. **Replay fill** (ruling F): on the `completed` transition, when
   `fixtures.stream_url` is null AND the target kind is `youtube`, call W1's
   `setFixtureStreamUrl` with the destination's watch URL through
   `streamUrlSchema` (design §12.6 recommendation: YouTube only at launch;
   others leave null — record as followed unless the owner rules otherwise).
10. **Phone tab** in `components/v2/fixture-stream-panel.tsx` (W1 built the
    strip and the §5.3 gate cards; R1 fills the entitled body): state-mapped
    UI per T1a's `_THEMES.md` §8a rows — idle (balance + destination picker
    over `org_stream_targets`, "+ add" encrypting on save through
    `POST /api/v1/orgs/[id]/stream-targets`; mode toggle clean | with scorebug
    — composed disabled with "coming soon" copy until R2, the seam visible);
    "Go live" → `POST stream-sessions`; provisioning → warming with the QR
    rendered CLIENT-SIDE from the `current` projection (never in page HTML;
    EC-M, ≥ 264 px, quiet zone 4; paste-code fallback showing the same
    payload as text); live with the health line; ending; ended with the
    replay link if filled; failed with the `fail_reason` → dictionary copy map
    (incl. `target_rejected`'s YouTube ~24 h note, `storage_exhausted`,
    `no_credits`). "Match decided — still streaming" chip when the fixture is
    decided and the session is live (ruling E, no auto-end). Buy-credits card
    posting `relay-checkout` and following the Checkout URL. Phone first
    (R15): 320 full-width 44 px controls; control SET identical 320 ↔ 1280.
    Testids `stream-phone-tab`, `stream-balance`, `stream-target`,
    `stream-target-add`, `stream-mode`, `stream-go-live`, `stream-qr`,
    `stream-qr-text`, `stream-health`, `stream-stop`, `stream-fail-reason`,
    `stream-decided-chip`, `stream-buy-pack-1|5|20`.
11. **i18n**: `ui.stream.phone.*` and `ui.stream.fail.*` in all four
    dictionaries (`ui.json`, the namespace `run-sheet-row.tsx` reads — RP9
    pinned at W1-D; carry its finding), `pnpm i18n:gen-keys`, commit
    `lib/i18n-keys.ts`.
12. **Sentry**: uncomment `NEXT_PUBLIC_SENTRY_DSN` in `fly.toml:11` and set the
    Fly secret (design §10.4); pino fields `sid, fixtureId, orgId, state,
    transition, reason, machineId` on every transition.
13. **`_INDEX.md`**: wave row, migration numbers as landed, FS10 outcome,
    RP9, the driver env, the Stripe lookup keys' names (never values).

## Out of scope

The Machine image, the relay page, `slate`, `delayMs` (R2); the phone app
(R3, own spec; only `docs/contracts/capture-qr.v1.json` + its fixtures land
here per §7.6, with the checksum unit test); pricing copy and the
`ENTITLEMENT_DOMAINS` entry (GA flip); an Enterprise monthly bundle (§12.3);
passthrough at half a credit (§12.2).

## Do NOT touch

W1's overlay route, stage, registry, hook, `overlay-model.ts`,
`public_fixtures_v`; `lib/realtime.ts` except to CALL its producer mint;
`SUPABASE_JWT_SECRET` call sites (P3); `stages-panel.tsx`; `run-sheet-row.tsx`
(W1 mounted the panel; R1 edits only `fixture-stream-panel.tsx` and new
files); other entitlement keys' rows; every pricing surface; `ai_credit_ledger`
and `lib/credits.ts` (donor — read, never edit); the engine; `.github/workflows/e2e.yml`.

## Acceptance — all four test kinds, assertions named

- **Unit** (`cd <relay worktree>/apps/web && DATABASE_URL=… DATABASE_SSL=disable
  npx vitest run server/relay server/usecases/__tests__/stream-* lib/__tests__/capture-qr* --reporter=json --outputFile=…`):
  - `stream-sessions.test.ts` over `FakeIngest`/`FakeRunner`: EMPTY case first
    (no session → `current` returns `null`, never a default object); EVERY
    §6.4 transition including both timeouts; `live` consumes exactly one
    credit; `failed(no_credits)` when balance 0 — and the POSITIVE pair: with
    balance 1 the same call reaches `live`; restart on the same fixture within
    24 h consumes nothing (and at 25 h consumes again — the differential
    case); double start → the unique-violation path answers the existing id.
  - `stream-credits.test.ts`: `creditBalance` over an empty ledger = 0 (empty
    set explicit); purchase + consume + refund sum; replayed
    `stripe_event_id` → no second row; the gated-transaction harness
    (`registration-concurrency.test.ts:461` pattern) — two sessions on two
    fixtures, balance 1, both call `consumeForSession` concurrently → exactly
    one `live`, one `no_credits`.
  - `tokens.test.ts`: valid → claims; tampered → 401; expired → 401; wrong
    `sid` → 401; terminal session → 410; a token signed with
    `SUPABASE_JWT_SECRET` → 401 (the G1 witness — checklist "Negative assertion
    needs its positive pair": the same claims signed with `AUTH_SECRET` pass).
  - `enc-boundary.test.ts` (scope 2); `crypto.test.ts` round-trip + a
    tampered ciphertext throws.
  - `relay-sweep.test.ts`: each rule fires at its threshold and NOT one second
    before (boundary rows on both sides); the advisory lock makes a concurrent
    second sweep a no-op.
  - `capture-qr.v1.test.ts`: the contract fixtures (valid, expired, tampered,
    wrong-version) parse/refuse; checksum of `capture-qr.v1.json` pinned.
  - **Money mutants (design §5.4) + R1 mutants (§10.2), each recorded with
    its killer:** (m1) delete the `consume` insert → e2e "live leaves balance
    unchanged" red; (m2) delete `for update` → the concurrency unit red; (m3)
    drop `stripe_event_id unique` → replay unit red; (m4) delete the plan-key
    check in `relay-checkout` → e2e "community org gets a Checkout URL" red;
    (m5) delete the 24 h reuse rule → restart unit red; (r1) drop the partial
    unique index → double-start e2e expects 409 → red; (r2) drop the stale-beat
    rule → fake-runner soak: session stays `live` forever → red; (r3) reference
    `*_enc` outside `server/relay/**` → static test red; (r4) accept a tampered
    token → token unit red; (r5) delete the implication check → community org
    with a relay override → expects 409 `overlay_required` → red. A survivor
    is a missing test.
- **E2E** (`apps/web/e2e/walkthrough/stream-relay.spec.ts`, named in
  `WALKTHROUGH_SPECS` (`src/lib/__tests__/e2e-ci-wiring.test.ts:155`) in the
  same commit; `RELAY_DRIVERS=fake` on the server under test; whole file, never
  `-g`): organiser of the entitled org at 320 / 768 / 1280 fresh contexts →
  Phone tab shows the buy card at balance 0 → seed a `grant` row by SQL →
  "Go live" → `provisioning` → `warming` with `stream-qr` attached and
  `stream-qr-text` equal to the projection's payload → fake ingest reports
  connected → `live`, `stream-health` shows fps, balance decremented by
  exactly 1 → stop → `completed`, replay link present when the fake target is
  YouTube; `failed(target_rejected)` copy drives the DOM (not the HTML); second
  "Go live" while live → 409 and the panel shows the existing session;
  control-set diff 320 ↔ 1280; every `stream-*` control ≥ 44 px by
  `elementFromPoint`; `expectNoHorizontalScroll`; a community org → no Phone
  body beyond `UpgradeGate` and `POST relay-checkout` → 402 (m4's killer).
  **Stripe sandbox**: `POST relay-checkout` returns a Checkout URL; the test
  completes it with a sandbox card (`stripe:test-cards`) and awaits the
  webhook → balance +1 (checklist "Billing/money claims tested against Stripe
  SANDBOX"); the run is skipped, not faked, when `STRIPE_SANDBOX_E2E` is unset,
  and the skip is printed.
- **Smoke** (`scripts/smoke.ts`): session CRUD on fakes (create → current →
  stop); heartbeat with a job token round-trips `desiredState`; `rtmp_enc`
  read back from the DB is not the plaintext (`≠` and not a substring); cron
  route → 503 without the env, 401 with a bad secret (in that order), 200 with
  the secret.
- **Regression**: W1's `stream-overlay.spec.ts` green unchanged (the OBS tab
  and the overlay route did not move); `live-score.test.tsx` unchanged; whole
  `mobile.spec.ts` at seven widths with the Phone tab folded in; `npm run
  openapi:gen` and `pnpm i18n:gen-keys` no diff; `tsc --noEmit` clean; full
  `apps/web` vitest total ≥ the post-PR1 baseline; `ai_credit_ledger` suites
  unchanged in count (the donor was read, not edited).
- **Visual gate**: T1b manifest rows for the Phone tab in every §8a state at
  320 / 768 / 1280 and 320 @ 125 %, the buy card, the decided chip, the QR at
  ≥ 264 px — PNGs exist and DIFFER; owner per-screen verdicts against the
  T1a pick.

## Checklist rows this wave satisfies

PRODUCT-OWNER LENS: "Billing/money claims tested against Stripe SANDBOX";
"One authority per fact" (ledger sum, one state machine); "Review findings →
written to disk" (FS10, RP9); "Never carry one session's approval as
another's" (FS10 is a recommendation, not a ruling). TEST-CASE DESIGN:
"Mutate the MONEY path specifically" (m1–m5); "Report mutant KILLER LIST";
"Empty-set case explicitly"; "Negative assertion needs its positive pair";
"Boundary row can subtract a mutant kill" (sweep thresholds asserted on both
sides); "Include ≥ 1 differential case" (24 h vs 25 h). VERIFY-AS-CUSTOMER:
control-set diff, 44 px by `elementFromPoint`, no h-scroll, 125 % zoom, every
width — via the T1b rows.

## Verify

```
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/relay/apps/web && \
  DATABASE_URL=<seazn-env env --label rly> DATABASE_SSL=disable \
  npx vitest run server/relay server/usecases/__tests__ lib/__tests__/capture-qr.v1.test.ts \
  --reporter=json --outputFile=<scratch>/r1-unit.json
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/relay && npm run openapi:gen && /usr/bin/git diff --exit-code openapi/
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/relay/apps/web && pnpm i18n:gen-keys && /usr/bin/git diff --exit-code src/lib/i18n-keys.ts
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/relay/apps/web && RELAY_DRIVERS=fake PLAYWRIGHT_BASE=<rly server> E2E_PROD_TARGET=1 \
  npx playwright test e2e/walkthrough/stream-relay.spec.ts --project=walkthrough --reporter=json
grep -a -rn "SUPABASE_JWT_SECRET" apps/web/src --include=*.ts | grep -v "lib/realtime.ts"   # must be empty (P3)
```

Final message under 15 lines — counts, paths, deviations, blockers; no file
contents or diffs.

## Dispatch notes

- Lanes, sequential unless marked: (A) migrations + crypto + ports/fakes +
  tokens (disjoint from B); (B) credits usecases + checkout + webhook branch
  + sandbox script (∥ A); (C) session usecases + API + sweep + workflow
  (after A and B); (D) Phone tab + i18n + `capture-qr.v1.json` (after C);
  (E) e2e + smoke + visual rows + inventory (after D). Reviewer after every
  lane; P3 grep in every review.
- Every brief: exact paths above; the acceptance bullets for its lane; the
  do-NOT-touch list verbatim; `cd <relay worktree> &&` with `DATABASE_URL`
  inline; `RELAY_DRIVERS=fake` for every local run; `model: opus`; the shell
  guard; the cap.
- A stopped agent is resumed, never re-dispatched.

## False-premise watch list

1. That `billing-events.ts`'s `checkout.session.completed` branch is reached
   by the webhook synchronously — the cron route `api/cron/billing-events`
   suggests an event QUEUE; if purchases land on the next cron tick, the e2e
   must drive the cron (503/401/200) after the sandbox checkout, and the
   panel's "credits arriving" copy exists (a finding either way).
2. That `requireBillingOwner` (group payer) is the right gate for stream
   credits, versus `requireOrgRole(owner)` (size packs) — the wallet here is
   ORG-scoped (design §5.2 `org_id`), so the size-pack gate is likelier; pin
   at Task 0 and record.
3. That Cloudflare's `inputStatus` exposes `status.current.state ==
   'connected'` on the account's API version — the fake mirrors the real
   shape; verify the field on a real input once (R0's memo may already say).
4. That the panel's `current` poll cadence (client-side `setInterval`) can
   reuse `POLL_MS` from `live-score.tsx:29` — it should (one constant), unless
   the QR state needs faster; record the value.
5. That `org_entitlement_overrides` can carry the test org's `streaming.relay`
   through `setBoolEntitlementOverrideSql` (`helpers.ts:518`) — same helper,
   new key; thaw to false in `afterAll`.
6. That the Stripe sandbox webhook reaches a LOCAL server in e2e — it does not
   without a tunnel; the sandbox e2e runs against staging (`SMOKE_BASE` /
   `PLAYWRIGHT_BASE` = stg) or replays the event body through
   `app/api/webhooks/stripe/route.ts` with a sandbox-signed payload; pin one
   and say so in the spec's header.
