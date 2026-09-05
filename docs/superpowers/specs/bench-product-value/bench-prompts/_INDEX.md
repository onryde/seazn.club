# Scheduler bench programme — session index

**One session per row.** Read `_RULES.md`, then this file, then the
session's prompt. Compaction anchor: every ruling, false premise, and
status change is appended here **as it happens**.

Spec of record: `../designs/2026-08-12-scheduler-bench-design.md` (§13 strict
wait). Sibling programme: `../portfolio-prompts/`
(D1–D7) — shared pure libs (`capacity.ts`, `health.ts`,
`court-windows.ts`) and the D6↔stage-0 fold-validate contract.

**Master gate (owner ruling 2026-08-12, STRICT WAIT): nothing here runs
until ScoringPad v2 is DONE through S13 AND release-2 is DONE through
C8.** Check both programme indexes. B00 is the first motion after the
gate opens. Prompts were authored 2026-08-13 (C1+S10 in flight) — every
citation is stale by design; that is what B00 exists for.

## Order

```
B00 → B01 → B02 → B03 → B03r → B04 → B05 → B06(pilot) → B07..B16 → B17 → B18
                          ▲                    └ B07–B16 parallel-safe (worktrees,
                   RS010 merged                  disjoint pack files, schema frozen)
```

B03/B04/B05 are sequential (shared `scripts/bench/lib/`). B17 needs B15
(reuses the hockey org). B18 last, always.

| Session | Prompt file | What | Depends on | Status |
|---|---|---|---|---|
| B00 | `B00-repin-and-refresh.md` | global re-pin, risk answers, env addendum | gate open | **DONE 2026-08-26** |
| B01 | `B01-runner-core.md` | CLI, pre-flight, HTTP client, report writer | B00 | **MERGED #658 2026-08-26** |
| B02 | `B02-pack-lib.md` | PackSchema, stage-0 validator, reconstruction | B01 | **MERGED #701 `1cdcaf4c6`** |
| B03 | `B03-seeding-layer.md` | org/comp/divisions/persons/officials/plans/claims | B02 | **MERGED #711 `3cfac6332` 2026-09-03** |
| B03r | `B03r-registration-layer.md` | registration entry path: `--entry` flag, http+browser drivers, PackSchema `registration` block, Stripe test-mode payer, funnel oracle | B03 + **RS007–RS011, RS010 merged** | **MERGED #713 `310eb22ac` 2026-09-04** — paid path proven live (2 × 100 USD destination charges, webhook accepted); bench 721/721 |
| B04 | `B04-scheduling-layer.md` | config apply, auto/validate, checker, certificate, metrics | B03 | **UNGATED 2026-09-04** — B03 (#711) and B03r (#713) both merged; verified by SHA on main, not from these rows. Kickoff: `../B04-kickoff-2026-09-05.md` |
| B05 | `B05-simulation-layer.md` | event loop, advancement, oracles, people-layer steps | B04 | TODO |
| B06 | `B06-pack-darts-pilot.md` | suite 11 (PDC) — pilot proves the playbook | B05 | TODO |
| B07 | `B07-pack-carrom.md` | suite 10 (ICF) — thin-data resilience | B06 | TODO |
| B08 | `B08-pack-cricket.md` | suite 1 (T20WC24 + CT25) — volume monster | B06 | TODO |
| B09 | `B09-pack-football.md` | suite 2 (Euro24 + WEuro25, decided B00) | B06 | TODO |
| B10 | `B10-pack-tennis.md` | suite 3 (Wimbledon 2025 ×2) | B06 | TODO |
| B11 | `B11-pack-chess.md` | suite 4 (Candidates 24 + Grand Swiss 23) | B06 | TODO |
| B12 | `B12-pack-badminton.md` | suite 5 (All England 25, MS + XD) | B06 | TODO |
| B13 | `B13-pack-tabletennis.md` | suite 6 (WTTC 25) | B06 | TODO |
| B14 | `B14-pack-volleyball.md` | suite 7 (Paris 24 M+W) | B06 | TODO |
| B15 | `B15-pack-hockey-icehockey.md` | suites 8 (Paris 24) + 9 (IIHF 25) | B06 | TODO |
| B16 | `B16-pack-club-open.md` | suite 13 "Club Open" — customer journey, UI-first: signup → comp → restricted divisions → register/pay/join/consent → approve/promote → fixtures → **pad-tapped play** → results | B03r, B05, B06 | TODO (gated) |
| B17 | `B17-disruption-suite.md` | suite 12: blackout→reflow, walkover, correction | B15 | TODO |
| B18 | `B18-full-run-closeout.md` (amend) | all suites, perf baseline, report, docs, memory; + one `--entry registration` pass ("Registration at volume" baseline, report-only) | all | TODO |

(B16 was vacant — hockey+icehockey share one session, B15 — and is now
the customer-journey suite. Pack sessions may pair further if research
proves thin — record the pairing here.)

## Decisions already made (do not re-open)

- All bench-spec rulings: simulate-never-feed-verdicts; correctness
  gates red / timings report-only; full-fat historical depth bounded by
  the sealed fidelity ladder (0–3); HTTP black-box + stage-0 validator;
  `--keep` default; feasibility-certificate protocol §6; misalignment
  protocol §7; no CI wiring; no z3 anywhere (C8 deleted it).
- Round-order and structured-conflict assertions are **day-one gates**
  (post-C1/C3 world — spec §6).
- Repair suite targets the post-C4/C5 CP-SAT path (`none|optimized|llm`).
- Stat oracles assert against post-S8/S9 pipelines incl.
  `personCareerStats`; a player in two suites gets a career-rollup
  oracle.
- Entitlement provisioning via smoke's `setPlan` SQL precedent.
- Engines benched: `optimized` primary, `greedy` baseline; `--engine
  both` is the comparison mode, not the daily driver.
- If portfolio sessions shipped first, the bench CONSUMES their libs
  (capacity/health/court-windows, D4 propose+confirm for advancement,
  D6 import for seeding speed on all-but-one suite) — B00 records which
  exist; prompts name the fallback when absent.
- Suite roster + per-suite constraints/specials: bench spec §3/§5/§8
  tables are the contract; deviations go through §7A adaptations.
- **Registration + customer journey (owner, 2026-08-27)** — spec
  `../designs/2026-08-27-bench-customer-journey-design.md`, decisions D1–D10
  closed there. Headlines: suite 13 is **UI-first** (Playwright taps every
  customer surface incl. Stripe test-mode Checkout and the scoring pad);
  suites 1–12 stay API-first; `--entry registration` runs suites 1–12
  through the API registration path free/open/auto, report-only; "no
  Stripe" now scoped to entitlements only; bench never *builds* UI, suite
  13 *drives* it; free-agent assignment report-only in v1; whole leg
  waits for RS010.

## Portfolio inventory (B00, 2026-08-26)

All P1–P11 shipped. Every shared lib the bench was written to consume, or
fall back from, is live — no B-prompt needs its fallback path.

| Lib / flow | Portfolio session | Status | Where |
|---|---|---|---|
| `capacity.ts` (D2) | P1 | MERGED `78c8618f` #544 | — |
| `health.ts` (D3) | P2 | MERGED `651c56c3` #547 | — |
| D4 propose+confirm (advancement) | P5, P6 | MERGED `776ba389`/`cdcc3bef` #554/#568 | `completeStage`/`generateStageFixtures`/`confirmSeedProposal`, all plain REST — see spec §11 risk 1 |
| `court-windows.ts` (D5b.5) | P9.5 | MERGED `203395b6a` #638 | `usableWindows`, 14 edge-matrix rows |
| Calendar compiler (D5c) | P10 | MERGED #644 (`027fd535a`) | — |
| D6 batch import (seeding speed) | P11 | MERGED `ee5aa1a01` #653 | `POST /api/v1/divisions/{id}/events/import` — **feature-gated, no `plan_entitlements` row yet**; bench needs a `setPlan`-style override to use it (spec §11 risk 5/8) |
| Venues/courts schema+API (D5a) | P8 | DONE 2026-08-17 | V367, 4 tables, RLS forced |
| Scheduler integration (D5b) | P9 | MERGED #621+#623+#633 | `ScheduleConfig.courts` = court UUIDs (`schemas.ts:1155`) |
| Templates (D1a/D1b) | P4, P7 | MERGED `e35efff1`/`98e95c9e` #548/#582 | 2 known open defects (`uniqueSlug` race, modal 320 fold) — not bench-relevant |
| News enrichment (D7) | P3 | MERGED `51601495` #545 | `generateWeeklyDigest` (`org-posts.ts:1506`), `draftPostsForDecidedFixture` (`:449`) — for B03 seeding if news items get seeded |

## Status log

(append as sessions run)

- 2026-08-27 — **Registration + customer-journey amendment approved in
  brainstorm** (owner). New sessions B03r + B16, B18 amended, gate
  RS010 → B03r added to `_MASTER.md`. Prompts authored the same day:
  `B03r-registration-layer.md` (PR 0 = app test hooks — hub panels and
  stepper have zero `data-testid`s today; PR 1 = bench), `B16-pack-club-open.md`,
  B18 amended with the `--entry registration` volume pass. Both prompts
  cite 2026-08-27 state and re-pin at run time (B00 pattern).

- 2026-09-02 — **B03 in progress.** Seeding layer. Four rulings and two false
  premises, all verified against the tree rather than inherited:

  - **The entitlement refusal is HTTP 402 `PAYMENT_REQUIRED`, not a "typed
    422".** B03's prompt says 422; `api-v1/http.ts:214-226` returns 402 with
    `code: "PAYMENT_REQUIRED"` plus `feature`/`feature_key`/`reason`. It reaches
    that branch only because `PaymentRequiredError extends HttpError` and its
    branch sits ABOVE the generic `HttpError` one (:231) — order is the
    contract, and nothing tests it by name. Recorded as G5 in
    `../../2026-09-02-product-gaps-from-bench-b03-prompt.md`.
  - **The probe moved off the fidelity gate onto the DLS gate.**
    **[W1 CLOSED — re-verified 2026-09-03 against merged `ae0751682`; the pins
    below are the merged ones, the pre-merge pins this entry first carried were
    off by one and three lines respectively.]** W1 deleted
    `requiredFeatureForEvent` outright — no non-test definition survives
    anywhere in `apps/web/src` or `packages/` — along with the
    `scoring.ball_by_ball` / `scoring.rally_by_rally` / `scoring.match_timeline`
    plan rows (`V390__scoring_free.sql`, which also drops their
    `org_entitlement_overrides`). The surviving gate is
    `scoring.ts:269-271` → `requiresDlsEntitlement(type, divisionConfig,
    payload)` (defined `:298-307`) → `requireFeature(orgId, "cricket.dls")`,
    shared verbatim with the batch importer at `event-import.ts:253`. Its own
    docstring (`:281-283`) states the invariant the probe depends on: "this is
    now the ONLY entitlement gate left at the scoring door".

    The predicate is three conjuncts — `eventType === "cricket.revise"`,
    `payload.target === undefined`, `divisionConfig.dls.enabled === true` — so
    the 2×2 (dls on/off × manual target present/absent) has exactly ONE
    refusing cell and three that must PASS on a free plan. Live grants at v389:
    `community` **false**, `pro`/`pro_plus` **true**, and `event_pass`/
    `event_pass_l` carry NO `cricket.dls` row at all — so the community/pro pair
    is the differential to drive, not the pass tiers. W2's plan
    (`docs/superpowers/plans/2026-09-03-entitlements-w2-matrix-and-plumbing.md`)
    does not mention DLS, so the probe target should survive W2 as well; the
    run-time plan derivation below is what makes that not need checking again.
  - **Plan keys are DERIVED from `plan_entitlements` at run time, never named.**
    Grepping the migrations gives the union of every plan that ever existed. A
    live DB at v389 holds `pro_plus`/`pro`/`event_pass`/`event_pass_l`/
    `community` — **`business`, which `V112` seeds, is not there at all**.
    W2 then deletes `pro_plus`. A derivation survives all of it; a constant does
    not. Recorded as G7.
  - **`persons.lane` can never be `'coach'` or `'staff'`. ~~CLOSED 2026-09-03
    by PR #706 — do NOT implement the workaround below.~~** Kept, struck
    through rather than deleted, because a session that reads only the
    conclusion will otherwise rebuild the workaround for a gap that no longer
    exists.

    What was true: V356 widened the CHECK for the S3/#426 ruling; all six
    `insert into persons` sites in non-test `apps/web/src` wrote
    `'player'`/`'official'` or omitted the column, and `CreatePerson` had no
    `lane` field. The handling was to map the lane onto
    `entrant_members.roles` and `LineupSlotInput.role` and never fabricate the
    column. Raised as G1.

    **What is true now:** `PersonLane` is `z.enum(["player","coach","staff"])`,
    `CreatePerson.lane` is optional, and `createPerson` writes
    `${input.lane ?? "player"}` — producer and consumer both verified, not a
    schema-only field. `seed-plan.ts` sends the lane EXPLICITLY for every
    person including `"player"` (same reasoning as `consent`: a bench that
    leans on a server default cannot tell a correct default from a forgotten
    field), and a roster member's `roles` are the pack's declared roles
    verbatim. `"official"` is still absent from the plan's persons by
    construction — `PersonLane` has no such value and an official's row is
    minted by `inviteOfficial`.

  Two more that cost nothing now and would have cost B05 a false defect:

  - **Seeded persons must carry `consent: { public_name: true }`.** The two
    consent gates have OPPOSITE polarity — entrant name display is opt-OUT
    (`anyOptedOut`), but `public_players_v` is opt-IN
    (`where coalesce((p.consent->>'public_name')::boolean, false)`, unchanged
    across V237 → V307 → V350). `CreatePerson.consent` defaults to `{}`, so an
    omitted consent yields a visible entrant name and NO player card. B05's
    player-card oracle would have read an empty view and blamed the product for
    a state the bench created. Matches what registration's own insert branch
    writes (`usecases/registrations.ts:670`, ruling 5).
  - **Idempotence hangs off the COMPETITION, not the org.** There is no
    `POST /api/v1/orgs` and no `PATCH` either — the org is whatever first
    sign-in provisions, so its slug is not ours to set. The marker is the pack
    hash in `competitions.branding` (jsonb, inserted ungated at
    `usecases/competitions.ts:204-207`), read back via `GET /api/v1/competitions`
    and keyed on the pack's own competition slug. NOT the `description`:
    `--keep` leaves orgs browsable by design, and a hash in a markdown field
    rendered on public surfaces is customer-visible litter.

  **T5 (2026-09-03) — `_tiny.json` is now a GENERATED artefact with two
  divisions.** `scripts/bench/packs/build-packs/_tiny.ts` emits the whole file
  (`npm run bench:build-packs`); the hand-authored `generic` streams are
  carried through as a literal and `d-badminton`'s are generated by
  `reconstructSetBasedStream` under a stable seed. Determinism is a test, and
  was re-checked independently here: byte-identical across regeneration, and
  from a different cwd. Modelled on `openapi:gen`, deliberately WITHOUT a CI
  step — CI is outside B03's charter, so the determinism test is the only gate
  and a `_tiny.json` edited by hand will not be caught by CI. Worth a
  workflow line when someone is next in `ci.yml` for another reason.

  Two consequences a later session will otherwise trip on:

  - **`fixtureCountIssue` had a latent bug that only a second division could
    expose.** Its `actual` is `seeded.fixtureIdByKey.size` — POOL-wide, every
    division — but it compared that against `expectedFixtureCounts[0]` alone.
    Correct for every pack that ever existed before T5, wrong the moment one
    declares two league stages. It now sums every entry. This is the shape of
    bug that survives any number of green runs because no fixture ever had a
    second division to disagree about.
  - **`runTinySuite` schedules `divisions[0]`/`stages[0]` ONLY**
    (`suites/tiny.ts:463-464`). `d-badminton` is seeded, its entrants created
    and its stream bound to a real fixture — and then never scheduled or
    validated. That is a deliberate scope line, not an oversight: T5 exists to
    exercise N-division SEEDING, and scheduling is B04's layer. But it means
    the second division proves the seeding path and nothing downstream of it,
    so do not read a green `_tiny` run as evidence that anything schedules
    two divisions. B04 owns closing this.

  **Officials end-to-end and player stats are BENCH scope (owner, 2026-09-03).**
  An earlier version of this entry sent both to the walkthrough leg on the
  reasoning that they are UI journeys. That was wrong: both are fully reachable
  over the API, so the bench can drive and assert them itself, and a bench that
  hands its own subject matter to a browser suite has given up the thing it is
  for.

  What the API actually offers, checked rather than assumed:

  - `POST /api/v1/officials/{id}/invite` — body `CreateClaimInvite` (`{ email }`),
    returns the claim row plus `claim_url` and `email_sent`. It runs the SAME
    shared person-claim rail as a player `pc_` invite, pointed at the official's
    person (created on demand by that route — which is the only writer of a
    `lane:"official"` persons row, and therefore the answer to why
    `PackOfficial.person` cannot be honoured at `POST /officials`).
  - `GET /api/v1/persons/{id}/stats` — one person's record.
  - `GET /api/v1/divisions/{id}/stats/players` — the division's player table.
  - `GET /api/v1/public/orgs/{orgSlug}/competitions/{slug}/divisions/{divisionSlug}/stats`
    — the public projection, which is the one gated on opt-IN consent
    (`public_players_v`), so it is where a seed that omitted
    `consent.public_name` shows up as an empty table rather than an error.

  **Where each half lands.** Minting the official's invite is B03 §5's own
  sentence ("seeding only mints invites; the accept flow is B05's"), so it
  belongs in THIS wave alongside T6's create/blackout/assign. Asserting real
  player stats needs a folded match, which B05 produces — so B03 can pin the
  BASELINE (the endpoints answer, the seeded roster is present, the public
  projection reflects the consent the seed actually wrote) and B05 pins the
  values once there are events behind them. Design §9 P2 — "claimed profile
  shows the real stats" — is the B05 oracle.

  A UI walkthrough of the same ground may still be worth having later, but it
  is a COMPLEMENT and not where this work lives; `apps/web/e2e/walkthrough/`'s
  README carries it as optional.

  **The BROWSER track owes two more journeys (owner, 2026-09-03).** Distinct
  from the API coverage above, and both belong on the browser driver B03r
  builds (`lib/drivers/browser.ts`, plain `playwright`, one `BrowserContext`
  per person, magic-link session, its own `assert()` because `expect` is a
  `@playwright/test` export that plain playwright does not have):

  - **The officials journey through the screens** — create, invite, assign to a
    fixture. The bench asserts the same ground over the API (T6 + T6b); this is
    the half the API cannot see, which is whether a person can actually get
    through it.
  - **Player stats verified AFTER the competition has finished.** The timing is
    the requirement, not an aside: a stats page mid-competition proves almost
    nothing, and the interesting assertion is that a completed suite's final
    record is what the player sees on their own profile. That sequences this
    **after B05** (which folds the events and accepts the `pc_` claims) —
    there is no finished competition to read before then.

  Sequencing, not a new number: B03r builds the driver, B05 produces a finished
  competition, and these two ride on both. Do not schedule them earlier and
  substitute a half-played suite — "after the competition finished" is the
  condition being tested.

  Note the driver split B03r already forces: on the http driver `pay()` throws
  `PaidEntryNeedsBrowser`, so paid registration is structurally browser-only.
  That is the precedent for putting these two there rather than inventing a
  second browser harness.

  Forward note for B06+ pack authoring. **[Corrected 2026-09-03 — the number
  this entry first carried was wrong, and the correction is the more useful
  fact.]** This originally read "**63 recordable against 68 registered**",
  attributed to the entitlements/R9 session and marked "verified here". The
  direction was verified; **the number was not**, and it does not reproduce.

  Derived by enumerating `builtinModules` (`packages/engine/src/sports/
  index.ts`), taking `Object.keys(module.eventSchemas)` as REGISTERED and
  walking `module.padSpec(cfg)` for every parseable variant cfg — collecting
  every nested `{ type }` — as PAD-REACHABLE:

  | | count |
  |---|---|
  | registered (`eventSchemas` across all 11 modules) | **68** |
  | pad-reachable across every shipped variant | **60** |
  | registered but exposed by no preset's pad | **8** |

  The eight: `badminton.expedite.start`, `badminton.sub`, `badminton.timeout`,
  `cricket.revise`, `cricket.superover.ball`, `football.shootout.kick`,
  `tabletennis.sub`, `volleyball.expedite.start`. Per module the
  registered/pad-reachable split is football 9/8, cricket 15/13, badminton 6/3,
  tabletennis 6/5, volleyball 6/5, and boardgame, carrom, generic, tennis,
  icehockey and hockey at parity.

  **68 is the same at `313af3818` and at `6f04875e5`** — I ran the identical
  script against a `git archive` of the older engine to be sure the W1/phone
  waves had not moved it. So "63" was never this measurement. It may well be a
  correct count of something else (types a preset's `apply()` ACCEPTS is a
  broader set than types its pad EXPOSES — `cricket.revise` is accepted, and is
  exactly the event the surviving `cricket.dls` gate fires on), which is why
  this now states its definition rather than a bare number.

  **What still holds, and is the point:** `reconstruct.ts`'s
  `assertDeclaresEventType` (`:172-180`) gates on `sportModule.eventSchemas` —
  the REGISTERED set of 68 — so it waves through a type no pad exposes, and any
  refusal then surfaces from the reducer deep inside the fold rather than at the
  generator's front door. A pack author enumerating event types from the
  module's declarations gets a stream that validates and that no scorer could
  have produced by hand.

  **And a scope correction that follows from it:** these eight are not
  "unrecordable". They are not PAD-reachable. The bench drives the HTTP API, so
  it can post all 68; the gap bites a pad-driven walkthrough, not B03's or
  B04's seeding. `cricket.revise` being on the list is the proof — B03's own
  entitlement probe posts it deliberately.

  Also: **there is no REST route that lists fixtures. ~~CLOSED 2026-09-03 by
  PR #706~~** — `GET /api/v1/divisions/{id}/fixtures` now exists. What was
  true: `POST /stages/{id}/generate` returning `{created, existing, fixtures}`
  with `ext_key` was the ONLY fixture-identity source over HTTP, so it had to
  serve as both the binding source and the idempotent re-read. Recorded as G3.

  The seeder still binds from `generate`'s own response and should keep doing
  so — it needs the ids of the fixtures THIS call created, and a separate list
  request would be a second round trip plus a race. The new route matters to
  B04/B05, which read fixtures they did not just create.

- 2026-08-13 — prompts authored, gated. S9+C0 merged; C1+S10 in flight.
  B-numbering: B16 intentionally absent (B15 covers suites 8+9).
- 2026-08-26 — **B00 DONE.** Gate confirmed open: ScoringPad v2 S13
  MERGED (v1 pad deleted, confirmed — no non-v2 scorepad path exists
  anywhere in `apps/web/src`), release-2 C8 MERGED `e9a7c54a` #591 (its
  three coverage losses also CLOSED, `0ccd2665` #594). ScoringPad v3
  (R1–R4, R2b, R2c) is a separate, non-gating programme — bench talks
  HTTP black-box, not pad UI, so v3 skin work does not touch anything
  the bench pins. Full scout re-pin done; spec §11 risks 1–9 all
  answered with evidence, none left open (see spec doc). Portfolio
  inventory above. `seazn-local-env` §3b got the run-both-ways
  addendum. B09's prompt (Div B suite 2) carried an open futsal-vs-WEuro25
  choice — decided WEuro25 (spec §11 risk 3) and the prompt + this
  index's B09 row are corrected. No other B-prompt cites a stale
  file:line (only the design spec does; the B0*-B18 prompts cite none
  directly, confirmed by grep).
- 2026-09-02 — **B02 in review, PR #701.** Pack library: `pack-schema.ts`
  (the committed `PackSchema`), `pack-template.ts`, `validate-pack.ts`
  (stage 0 — pure offline fold gate, DB/HTTP/env-free), `reconstruct.ts`
  (seeded generators), `pack-io.ts`, and `packs/_tiny.json`. `_tiny` now
  READS its pack from disk, so runner and validator share one fixture.
  366/366 unit+regression green (JSON reporter, 9 files, all in-worktree);
  tsc clean; 82 mutants / 76 killed / 6 equivalent, each equivalent
  declared with evidence at the code. Live `_tiny` run x3 by the
  orchestrating session — with placement, with the env merely unset (a
  FALSE no-placement test, recorded as a trap), and with placement
  genuinely stopped (`solver_unavailable`, greedy fallback); all green,
  `conflictCount: 0`, satisfying `_RULES.md` §2 via runs 1 and 3.
  **Three fields added pre-freeze**, each cited to a named later session:
  `streams[].stageRef` (an unbindable cfg overlay is stage 0's only
  FALSE-RED path), `expected.finalRanks` (B05 §3; B06 is a 96-player
  knockout), `expected.careers` (B12's cross-division oracle).
  **Two owner decisions open:** `provenance` gained a third value
  `"synthetic"` on the session's own ruling, spec §4 declares two; and
  nothing lints `scripts/**` (no repo-root eslint config — confirmed from
  four directions, escalated not fixed). Carried to B03: `reconstruct.ts`
  has no production caller yet, so **B03 must drive a pack through it, not
  merely import it**. Eight briefed premises proved false; thirteen
  location-not-property defects fixed, four of them fixture-level.
- 2026-08-26 — **B01 MERGED, PR #658** (merged 2026-08-26 17:19Z; this line said "in review" until B02 corrected it). Runner core: bench.ts CLI,
  lib/env.ts pre-flight (pure `runPreflight(base, probes)` over an
  injected `PreflightProbes`), lib/http.ts (hand-copied smoke.ts session
  shapes + a typed `request()` that fails the run on unallowed 4xx/5xx),
  lib/report.ts (zod `BenchReport` schema + composable markdown
  renderer), lib/log.ts (pino, matching the repo's flat-singleton
  convention), lib/suites/tiny.ts (the `_tiny` proof suite). 27/27
  DB-free unit/regression tests green; typecheck and lint clean. `pino`
  added as a root dependency (same class of fact as `@grpc/grpc-js`
  under pnpm's strict isolation — see PR body). Live `_tiny` run (and the
  both-with/without-placement pass per `_RULES.md` §2) deliberately
  deferred to the orchestrating session, per this task's own brief.
