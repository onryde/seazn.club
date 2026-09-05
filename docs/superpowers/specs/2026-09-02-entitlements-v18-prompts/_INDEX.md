# Entitlements v18 — programme index

Decision log for the three-tier repackaging (Free / Pro / Event Pass). Read
this before touching entitlements, pricing copy, or the scoring pad's
recording chip.

- **Design of record:** `../2026-09-02-entitlements-v18-three-tier-design.md`
  — owner rulings R1–R14 (§1), the full matrix (§2), prices (§3a), the
  `enterprise` contact-us plan (§4), programme shape (§9), out-of-scope (§10).
- **Approved mockups:** `../mockups/2026-09-02-entitlements-v18/` — committed,
  not scratchpad, with a README carrying the two binding constraints.
  **NOT YET PUSHED** (2026-09-03): they live only in the local `main` checkout,
  on `88699ba78`, which `origin/main` does not have. `recording-chip.tsx` on
  the W1 branch cites that path in a comment, so until `main` is pushed and W1
  rebases, a shipped source file points at a directory a fresh clone cannot
  see. Push `88699ba78` and `4a644bf08` before merging W1.
- **Wave plans:** `../../plans/2026-09-02-entitlements-w1-scoring-free.md`.

**Why this file exists.** Every ruling below was made during execution and
lived only in a git-ignored SDD ledger that the process deletes at close-out.
Anything not written here is lost to the next session, which will then
re-derive it — wrongly, in the way this repo's `AGENTS.md` opens by warning
about.

**Integrator note (2026-09-03).** The W1 branch's copy of this file was seeded
byte-for-byte from `main`'s `4a644bf08` and then brought up to what shipped, so
if the two ever conflict, this branch's version is the later one and is a
superset — take it. The original was committed to the local `main` checkout
rather than to the wave branch, which meant the wave could not see its own
index; see the process traps at the foot of this file.

## Waves

Sequential; they share `feature-copy.ts`, `entitlement-domains.ts`, the four
dictionaries, help and `copy-truth.ts`, so there are no parallel lanes.

| Wave | Scope | Status |
|---|---|---|
| W1 | R9 "scoring goes free" — gate removal, `fidelityTiers` retirement, recording chip, three keys deleted, pinned tests moved | **MERGED** — PR #704, squashed onto `main` as `ae0751682` (2026-09-03). W2 is cut from that commit. |
| W2 | Matrix & plumbing — migration, inert-key deletion, `featurePlan`, labels, add-on sets, credits math, per-rung pass grant, `stripe-plans.json`, copy-truth guards. **R12 prices and R13 hidden add-on land here.** | **IN PROGRESS** — branch `feat/entitlements-w2-matrix-plumbing`, 90 commits, migrations V392–V397, no PR. Scope grew well past the brief on owner rulings taken during execution (AUD removed, the whole catalogue re-priced to charm `.99`, the share loops made paid, competitions public by default, the platform fee made additive). **The state block and the remaining-work list live in `../../plans/2026-09-03-entitlements-w2-matrix-plumbing.md` — read it before touching this branch.** Not yet gated as a whole; five items owed. |
| W3 | Surfaces — pricing page redesign (R14), billing settings, gates, dictionaries ×4, emails, help, e2e replacements. **Plus W3-A (`stats.player`: free the record, keep the career rollup — and fix the public-beats-owner inversion) and W3-B (paywalls offer the pass as well as Pro), both owner-approved 2026-09-05 — scope and evidence in the section above.** | not started |
| W4 | Proofs & walkthrough — pass and Free proof e2es, full product walkthrough on a prod build, Stripe archive ops step | not started |

### W1 as shipped

Twenty-five commits, from `c93765097` to the closeout commit carrying this
file, in seven tasks plus fix rounds. What each task actually left behind:

1. **T1** engine readers read `padSpec.fidelity`, behind a parity proof;
   `EXTEND_GOLDEN` (append-only, never a re-baseline) recorded the setbased
   expedite/sub/timeout streams the harness could finally see.
2. **T2** `SportModule.fidelityTiers`, `FidelityTier` and
   `PadSpec.fidelityEntitlements` deleted outright. Grep any of the three: every
   surviving hit is a comment recording the deletion.
3. **T3 (+3b)** the band gate removed from `scoreEvent` and the batch importer;
   `V390__scoring_free.sql` deletes the matching `plan_entitlements` rows.
4. **T4** the chip becomes the scorer's band PICKER (Option B), no lock, no
   plan name, no upsell branch. **Closes D-7** in the scorepad-v3 register.
5. **T5** nothing in copy, help, matrix, cards or the smoke scripts advertises
   scoring detail as paid; a guard reds if it comes back.
6. **T6** the device-link ownership guard gets one shared predicate and, for
   the first time, coverage that kills it — unit, e2e AND smoke.
7. **T7** this record, plus the two tests below.

**FINAL GATES, all judged from `--reporter=json --outputFile` with
`.testResults[].name` confirmed inside the worktree:**

| Gate | Result |
|---|---|
| `packages/engine` vitest | 4283 total / 4270 passed / **0 failed** / 0 suites failed |
| `apps/web` `src/lib` + `src/components`, wave DB | 7646 total / 7619 passed / **0 failed** / 2282 suites, 0 failed |
| `tsc --noEmit`, both configs | 0 errors each |
| eslint, touched files | clean |
| `npm run test:smoke`, REBUILT prod bundle | **951 passed, 1 failed** |

The single smoke failure is `cleanup completes and keeps the staff audit trail
(rows survive, V111 chain verifies)` and is **pre-existing local DB state, not
this wave**: the chain breaks at a row created before the wave's first commit
(earliest `staff_audit_log` row 17:27 vs. first commit 21:47 on 2026-09-02),
in a table no commit here touches. CI's fresh Postgres cannot reproduce it.

## Owner rulings made during execution

These are in addition to R1–R14 in the design doc.

- **`stats.player` — FREE TO WRITE, PAID TO READ (2026-09-02).** Removing the
  scoring gate also deleted the only write-side gate on `stats.player`, which
  the W1 plan had ring-fenced. Sanctioned rather than reverted: recording a
  player line IS scoring detail, which is what R9 frees; the paid value stays
  in reading and aggregating, and it funnels — a free org captures the data,
  then upgrades to see it. Read sites still refuse; the key keeps its
  `plan_entitlements` rows. Rejected: restoring a targeted refusal (would make
  the pad free on every plan except one cricket event) and freeing the read
  side too (gives away a matrix cell the spec sells). Pinned by a test that
  dies if the gate returns — proven by restoring `requireFeature("stats.player")`
  on `cricket.player.line` by hand and watching it red.
- **The recording chip is Option B (2026-09-02).** A 44px labelled pill —
  four-rung meter, the word "Recording", the active band, a chevron — raising a
  sheet of four full-width radio rows. On a phone that sheet is a BOTTOM sheet,
  thumb-reachable and edge to edge; from `sm` up a centred card. Selection is
  marked by check + weight, never hue alone. Chosen over Option A (a visible
  four-step ladder), whose weakness was 320 only.
- **The sheet's per-row count is REACHABLE CONTROLS, and it counts each entry
  inside "More" (2026-09-02).** This REVISED the controller's own earlier
  ruling, and the owner was told so. Counting dispatchable event TYPES is
  tidier (Goal Home and Goal Away are one action from two sides) but puts
  "2 actions" above three visible buttons. Counting grid tiles only was
  rejected for the opposite reason: "More" counts once however much it holds,
  so bands 2 and 3 read identically and the top band looks like a no-op. The
  drawer is EXPANDED INTO ITS ENTRIES; the More button itself is navigation,
  records nothing, and is never counted. Measured on football 11-a-side at H1:
  `[3, 3, 10, 11]` from every current band; badminton `[1, 3, 3, 5]`.
  Sanctioned consequence: at bands 2/3 the caption exceeds the visible button
  count, because drawer entries are reachable but not on screen.
- **Band-1 reads "Key moments", not "Cards & key moments" (2026-09-02).** It
  truncated at 320 (scrollWidth 135 in clientWidth 116) and a truncated option
  is the one nobody picks. Rejected: shrinking the type or widening one pill
  (sets band 1 at a different size from its three siblings), and shipping the
  ellipsis. **And the rule does not stop at the English dictionary** — all four
  were re-measured in-browser: en "Key moments" 116/116, es "Momentos clave"
  125/125, fr "Moments clés" 90/90, nl "Hoogtepunten" 110/110, all
  `truncated=false`. French has the TIGHTEST box despite the shortest label,
  because its lead word is "Enregistrement" — which is why this was measured
  rather than reasoned.
- **The band is a PER-DEVICE preference; the handover/kiosk reset is INTENDED
  (2026-09-02).** A handed-over device or a `/score/[token]` kiosk starting at
  the fixture's sensible default is coherent: the band is how much detail THIS
  scorer wants to record, and one volunteer's choice should not silently
  constrain the next. No work owed — recorded so a later session does not "fix"
  it. Rejected: making the band a property of the fixture (new persistence, and
  it would carry a stranger's preference onto another device). The reasoning
  sits in a comment above the `bandStorageKey` seeding in `pad-host.tsx`.
- **Mobile is DESIGNED, not shrunk (2026-09-02) — binding on every surface this
  programme touches.** A 320 capture that is the 1280 composition with smaller
  type is a REJECTION, not a pass. Information order may change with width;
  decorative structure that only earns its place at desktop may be dropped;
  primary actions sit in thumb reach. Every design states in writing what it
  decided differently at 320 and why. Written into the spec (`1a0c948b9`).
- **Merge order — R8 merges first, W1 rebases onto it (2026-09-02).** The
  scorepad-v3 R8 sweep wave and W1 both rewrite `scoring-vocab.test.ts`. R8 is
  a closing wave spread thinly across 18 files; W1's deletions are wide but
  mechanical and replay more cleanly onto a moved base. At the rebase, W1 takes
  R8's sport-agnostic gate wholesale and changes only the enumeration's source.
  **Done:** R8 landed as `ce6a29332` (#700); W1 rebased onto it, and again onto
  `313af3818` + `1cdcaf4c6`.
- **R14 — pricing page is the box office, plain Option A, sport rail kept.**
  Full text in the design doc §1. Note for whoever builds W3: the page ranks a
  one-time $15 above the $9/mo recurring **by the owner's choice**, with the
  counter-argument put first and overruled. Do not "fix" it.

### Owner ruling 2026-09-04 — the five W2-boundary product gaps, all approved

Raised as a product-owner read of the wave rather than as a task list, each verified
against the tree or the `entw2` database. Full write-up with the arithmetic:
`../../plans/2026-09-03-entitlements-w2-matrix-plumbing.md`, "Product-owner gaps".

1. **SUPERSEDED THE SAME DAY — `on_behalf_of` cannot do this.** The recommendation as
   first written ("the rail ships with V397 or V397 reverts") rested on the wave's own
   false premise, asserted in three places in the tree including V397's header. Verified
   against `docs.stripe.com/connect/charges`: destination charges debit Stripe's fees
   from the PLATFORM's balance, and `on_behalf_of` sets the business of record —
   settlement country, that country's fee schedule, statement descriptor, payout timing —
   not who pays. **Only direct charges carry the lever**, and they are a charge-type plus
   Connect-account migration (refunds and disputes move to the connected account; Stripe
   does not recommend direct charges for the legacy Express accounts `stripe-connect.ts`
   creates). **Owner ruling: keep V397's rates and gate LAUNCH on that migration** — no
   club takes real registrations until it lands. It owes its own wave. The underlying
   diagnosis was right and predates V397: any rate below Stripe's 2.9% is negative and
   worsens with volume, which was already true of Pro at 2%.
2. **INR credit packs are re-anchored** — 10/25/50/100 to ₹399/₹999/₹1,999/₹3,999,
   which is 1.67× the included rate, exactly USD's ratio. They were carried as
   "unchanged" while the plans moved to PPP set points, leaving ₹799 buying 10 credits
   where ₹599 bought a month of Pro including 25. A dominated SKU throws no error; it
   just never sells. **Ships with a new ladder rule comparing a consumable against the
   plan that includes the same thing** — the six existing rules only compare plans to
   passes, which is why this could happen silently.
3. **A blank platform-fee field stops meaning 0%.** `Number("")` is `0` and both layers
   accepted it. `min(0)` stays — a deliberate promo is legitimate — but empty is no
   longer zero, and the fix ships with a paired positive assertion so it cannot pass by
   refusing everything.
4. **The pass/Pro crossover gets named on the pricing page**, derived from the live
   catalogue rather than typed: the pass wins below roughly $150 of entry fees and Pro
   above it. Unstated, the page reads "the pass is cheaper" and pushes volume at the
   one-time SKU when the recurring one is what retains.
5. **The degrade card names its numbers.** The client dropped `limit` from the 201, so
   the best-timed upgrade moment in the product could not say the org is at 2 and Pro
   is 10.


## W3 scope added 2026-09-05 — owner-approved, with the evidence

Two changes, both about selling better rather than gating harder. Written here
rather than executed in W2 because each is copy plus an entitlement row, and this
programme's own rule is that a row change and the copy quoting it are ONE unit of
work — W2 is closing and its pricing copy has already churned four times.

### W3-A — `stats.player`: free the record, keep the analysis

**Why, and it is not generosity.** The paywall does not currently work.
`publicDivisionStats` (`usecases/player-stats.ts:638`, served by
`/api/v1/public/orgs/…/divisions/…/stats`) has **no entitlement gate at all**,
while every authenticated reader has one. Combined with V395 making competitions
public by default, the live behaviour for a default Free org is:

| Who | Sees the player stats |
|---|---|
| The whole internet, via the public dashboard | **Yes** |
| The org that entered the data, signed in | **402 — upgrade to Pro** |

The gate stops the customer and not the public. Worse, `recomputePlayerStats`
runs regardless of plan — it fires for every org in the weekly digest sweep — so
we pay the compute and withhold the result from the only person who earned it.
W1 already settled the principle this offends: **charge for leverage, never for
correctness.** A player's own record is correctness.

**The split, which maps onto the existing function boundaries with no new
seams:**

| | Function | Route | Plan |
|---|---|---|---|
| The record | `divisionPlayerStats` | `/api/v1/divisions/[id]/stats/players` | **Free** |
| The record, per person | `personStats` (division-scoped) | `/api/v1/persons/[id]/stats` | **Free** |
| The rollup | `personCareerStats` | same route, career shape | **Pro + pass** |

`personCareerStats` is the leverage half and already reasons about pass scoping
in its own comment: *"A career rollup spans competitions, so an Event Pass covers
the part of the career played inside the competition it was bought for, and no
more."* That sentence is the split, already written; W3 makes the matrix agree
with it.

**Owner value.** Player stats are the most shareable artefact in amateur sport —
the thing a parent screenshots and a player links. Freeing the record feeds the
badge network the growth-reversal ruling was protecting, while the career rollup
stays a real Pro/pass differentiator. It costs one `plan_entitlements` row and
the copy that quotes it.

**Counter-argument, stated so it is not rediscovered as an objection.**
`pass-features.ts:46` lists `stats.player` as a pass grant, so freeing it
wholesale would shrink the pass story — which is exactly why the split exists
rather than a blanket free. Do NOT free `personCareerStats` with it.

**Owed with it:** fix the public/authenticated inversion in the same change,
whichever way the split lands. Serving the public more than the owner is
incoherent under any pricing.

### W3-B — the paywall should offer the cheaper route, not just the dearer one

W2 fixed twelve reasons that read "is a Pro feature" for keys the Event Pass also
grants (`3c0463dec`); they now name both plans. That corrects the falsehood and
leaves the commercial gap open: the sentence names two plans, and the CTA still
sells one.

Twelve times, at the moment a customer is blocked and most ready to buy, we
should be offering **both routes with their prices** — the pass at its rung price
for THIS competition, and Pro for the whole org — and letting them pick. Today
`featurePlan()` is three-valued (`community` / `pro` / `enterprise`) and knows
nothing about the pass, so `UpgradeGate` cannot express it.

**Owner value.** The pass is the cheaper entry and the lower-commitment yes; for
a single-competition organiser it is often the right product, and we currently
hide it at the exact instant it is most relevant. The crossover work already
landed the arithmetic (`lib/pricing-crossover.ts`) — this is putting it where the
decision is actually made rather than only on `/pricing`.

**Guard obligation for both.** `freeClaimFaults` grew a fourth rule in W2 because
its first three reasoned about community, pro and enterprise and never asked the
pass — twelve sentences drifted behind that blind spot. Any W3 change to how a
paywall names a plan must extend that rule set in the same commit, and must be
mutation-proved: restore the old wording and confirm it reds.

## Findings that changed the work

- **`fidelityTiers` was the RECORDABLE set; `padSpec.fidelity` is the
  REGISTERED set.** 63 vs 68 event types, and neither enumeration was labelled.
  The five extra (`badminton.timeout`, `badminton.sub`,
  `badminton.expedite.start`, `tabletennis.sub`, `volleyball.expedite.start`)
  are refused by the reducer under every shipped preset: the setbased kernel
  refuses them when the matching `cfg.records` flag is false, and that refusal
  is gated on `strict`, which defaults TRUE, so the write path refuses. Every
  badminton preset has timeouts, substitutions and expedite all false; every
  tabletennis preset has substitutions false; volleyball has expedite false
  everywhere.
- **Cricket's MODE governs; the band never overrides it.** A coarse innings
  refuses ball events outright whatever band is selected (grep
  `recorded at summary fidelity` in `cricket.ts`), and the innings' lane is
  locked by its first event (grep `createInnings(next, "coarse")` and
  `createInnings(next, "fine")`). The pad already gates both lanes on
  `inningsFidelity`, so there are no dead-end taps today — a margin resting on
  exactly two conditionals.
  Band = what the scorer is ENTITLED to record. Mode = what THIS INNINGS will
  ACCEPT. They are different axes and were never in conflict.
- **The plan missed two derived gates.** `scoring-vocab.test.ts` and
  `event-copy.test.ts` derive their expected sets by walking `fidelityTiers`,
  so deleting it zeroed them and reddened 5 tests. Their anti-vacuity floors
  are what made this loud instead of silent. Repointed at `padSpec.fidelity` in
  Task 3b, with a **pinned, expiring waiver** for the five unlabelled types.
  **The waiver has now expired exactly as designed**: R8 landed the four
  missing ribbon keys, W1 took R8's `eventSchemas`-derived gate at the rebase,
  and the waiver, its exclusion constant and its "presently-unrecordable" text
  are all gone from the tree. An expiry condition that actually fired.
- **`browser.newContext()` AND `playwright.request.newContext()` both inherit
  `use.storageState`.** The API-only shape hides it — no page, no visible
  login, just a request context quietly carrying the e2e organiser's cookie.
  Found on the realtime-token door, where the inherited cookie made
  `isFixtureOfficial()` true and short-circuited the `||` chain one step before
  the device-link branch: 200 for the fixture the link owns AND 200 for one it
  does not, while anonymous `curl` correctly returned 200/403.
  **The same pattern was still live in a SUCCESS claim** and Task 7 closed it:
  `device-links.spec.ts`'s first test ("opens the pad anonymously and
  authorises scoring") ran from two bare contexts, and deleting the
  `Authorization: Bearer dl_…` header outright left it GREEN — the session was
  authorising the state read and the event write. Both contexts now pass an
  explicit empty state, a no-credential control asserts 401/UNAUTHENTICATED
  BEFORE the grant, and the same header-deletion mutant now reds. The claim
  itself turned out to be true; it simply had not been proved.
  Rule: **a test that passes its positive case and its negative case for the
  same reason is the tell.** Assert the refusal first, then let the grant mean
  something.
- **The control-set membership test is a SCREEN, not a verdict.** "Enumerate the
  controls at 1280 and at 320; equal lists = shrunk = fail" was adopted
  mid-wave to make "designed, not shrunk" falsifiable, and it immediately
  scored the owner-APPROVED chip as a failure: Option B uses a sheet at every
  width, so no faithful implementation can pass a membership test. When the
  lists come out equal, ESCALATE — compare geometry and anchoring against the
  design of record (here: the pill goes full-bleed, the dialog moves from
  centred to bottom-anchored and thumb-reachable, the rows go full-width) and
  fail only when the 320 is the desktop composition at the same anchoring with
  smaller type. The test keeps its teeth for the case it was invented for.
- **Six briefs in this wave carried a false premise**, four of them written by
  the controller from the design and the ledger rather than re-pinned against
  the tree. Examples: mockups said to be on the branch were on `main`;
  `football.card` called band 3 when only `football.shot` is; a seeding helper
  that did not exist; a route path mis-transcribed. Every one was caught
  because an implementer said so WITH EVIDENCE instead of working around it.
  This paragraph is the seventh: **the Task 7 brief said this very index lived
  on the wave branch. It did not** — it was committed on the local `main`
  checkout (`4a644bf08`, unpushed) and had to be brought across.

## Standing coordination with the scorepad-v3 R8 wave

R8 has MERGED (`ce6a29332`, #700) and closed. Its owner transferred its open
items to W1, so nothing below is owed by anyone else.

- **Copy split, as shipped:** W1's chip keeps "Recording" (no axis prefix, no
  new string); R8's cricket mode chip carries the differentiation as
  "This innings: Ball-by-ball" / "This innings: Over-by-over", plain text with a
  lock glyph, not a pill, each with a message line saying the mode was set when
  the innings began. The axis that separates them is AGENCY — ours is a choice
  the scorer can change now, theirs is a fact locked by the first event.
- Every module's `padSpec(cfg)` ends by running its spec through
  `stampAttributionRequired`. If any later task rewrites those return paths,
  keep the stamp LAST.
- **Never record or relay a peer session's recommendation as its owner's
  decision, in either direction.** Violated once in this programme, on a
  question the owner had never been asked; the peer correctly refused to act on
  it, and the substance turning out right was luck, not process.

## Named items owed to a later wave

Each needs a task and an owner. Nothing here is fixed by W1.

0. **W3 entry gate — baseline the distribution the growth reversal gives up.**
   W2 put player profiles, embeds and auto posts back behind the paywall on an
   explicit owner ruling, reversing the PLG position recorded higher in this file.
   That is not re-litigated — but it trades off-platform distribution for revenue,
   and **nothing in the tree measures the distribution side**, so the trade cannot be
   read later, only argued about. The badge network was the stated reason those keys
   were free; removing them removes the badge from the surfaces that carried it.
   Take the baseline BEFORE W3 ships the surfaces — embed loads, public-profile
   views, auto-posted items, and how many orgs use each — or the counterfactual is
   gone for good. Cheap now, impossible in a month. Raised as a product-owner
   finding at the W2 boundary, 2026-09-04, and approved with the five fixes below.

1. **The setbased kernel registers event schemas and fidelity bands for types
   no shipped preset accepts** — a badminton expedite system, a table-tennis
   substitution. 63 recordable vs 68 registered; the five are named in
   "Findings" above with the `cfg.records` / `strict` evidence. R8 added ribbon
   copy, which is a floor under the leak, not a fix for why the types exist.
   Deliberately NOT taken into W1: narrowing a schema registration during a
   close wave and a pending rebase is how golden corpora move under people.
   **W1's index is now the only place this is written down** — R8's ledger is
   closed.
2. **`resolveScorePadBootstrap` no longer calls `padSpec` at all**, so its
   null-on-throw catch no longer covers one: the throw has relocated
   client-side to `props.module.padSpec?.(props.cfg)` in `pad-host.tsx`, where
   it is unguarded. Reachability is low (config is schema-parsed at write time)
   and this was ruled into Task 4 as a deliberate decision rather than a side
   effect, but it is still an unguarded client throw where there used to be a
   quietly absent pad section.
3. **The events route parses the request body BEFORE authenticating.**
   `POST /api/v1/fixtures/[id]/events`: `parseBody(req, AppendEventRequest)`
   runs, then `requireFixtureActor(req, id, "score")`. So an unauthenticated or
   unauthorised caller gets their body read and zod-validated first — it pays
   the parse before the refusal, and a malformed body from a caller with no
   credential answers 422 (a schema oracle) rather than 401/403. **It is a
   repo-wide pattern, not a slip in this one route**: a mechanical scan of
   `apps/web/src/app/api/v1` found at least 20 handlers with the same ordering,
   including `finalize`, `lineups`, `api-keys` and most `orgs/[id]/…` writes.
   Fixing one route is not the job; deciding the ordering rule is.
4. **Cross-fixture device-link 403s are UNMETERED.** In `requireFixtureActor`
   (`auth.ts` — grep `This device link is for a different fixture`) the
   ownership throw happens BEFORE the `rateLimit("dlv1:…", {max: 10,
   windowSeconds: 1})` call, which only runs on the success path for
   `intent === "score"`. `auth.ts` contains exactly one `rateLimit(` call and
   there is no `middleware.ts`, so a holder of one valid `dl_` token can probe
   fixture ids at unlimited rate, each probe paying a `resolveDeviceLinkToken`
   DB read. Refusals should be metered at least as tightly as grants.
5. **Nine other anonymous e2e contexts share the cookie-banner race** that Task
   7 fixed in `scorepad-a11y-evidence.spec.ts`: `storageState: undefined` at
   four sites in `scorepad-offline.spec.ts`, four in
   `scorepad-v3-partial-amend.spec.ts` and one in `scorepad-v3-cricket.spec.ts`.
   They interact rather than measure, so a banner there intercepts a click and
   fails LOUDLY instead of silently distorting numbers — which is why they were
   not swept during a close wave. The one-line fix is
   `storageState: await consentedAnonymousState()` from
   `e2e/scorepad-a11y-kit.ts`; each needs its own spec re-run to be honest.

6. **W2 deleted `pro-plus-tier.spec.ts` (505 lines, 10 tests) and
   `pricing-pro-plus.spec.ts` (49 lines, 2 tests), and the replacements are
   owed to W3** — `pricing-v18.spec.ts` and `enterprise-gate.spec.ts` (owner
   ruling 2026-09-03, W2 plan decision 6). Both files were deleted whole and
   nothing outside themselves referenced them. This is the inventory of what
   the tree no longer proves in a browser, so W3 rebuilds coverage rather than
   guessing at it. Five of the ten cases were about the retired tier and are
   simply gone; the other five tested a LIVE mechanism through a `pro_plus`
   vehicle and are the real debt:

   - **Save points roll a WINDOW; they do not 402.** Two cases
     (`Community: the 3rd save point rolls the window rather than 402ing
     (limit 2)`, `Pro: 5 save points are silent, the 6th rolls (limit 5)`)
     drove `schedule.checkpoints.max` to its ceiling and asserted the oldest
     checkpoint is discarded instead of the request being refused. That is
     unusual for a cap in this codebase — every other quota raises a
     `PaymentRequiredError` — and it is now proven nowhere in a browser.
     **The numbers moved too**: V392 sets community 2 (unchanged), pro 5 -> 10,
     and gave BOTH pass rungs their own row at 5 where they used to fall
     through to community. A replacement must read the cap from the matrix,
     not retype it — the old spec hardcoded 2 and 5.
   - **`officials.auto` and `api.write` gating, end to end, including that a
     read-only API key still mints when the write scope is refused.** Both
     keys changed side in V392: `officials.auto` is now granted on Pro AND on
     both pass rungs (so W2 T6's competition-scoped resolution is what makes
     the pass grant safe, and that scoping has no browser test), and
     `api.write` is the only bool in `ENTERPRISE_FEATURES` — the sole
     self-serve-unreachable feature in the product. `enterprise-gate.spec.ts`
     is the natural home for both.
   - **The billing surface's two states**: a Community org seeing the paid
     upsell with a price rendered, and a paid org having the upgrade grid
     HIDDEN. The second is the one that matters — an org that already pays
     being shown an upgrade grid is a visible defect, and after V392 the paid
     state to assert is `pro`, with `enterprise` reaching the Contact-us CTA
     W2 T3 added rather than a priced card.
   - **`/admin/entitlements` renders a column per plan.** The old case asserted
     the Pro Plus column existed. `ADMIN_PLAN_KEYS` now derives from
     `ALL_PLAN_KEYS` unfiltered, so the replacement should assert the column
     SET matches that list — including `enterprise`, which is the one column
     `/pricing` deliberately does not show.
   - **`/pricing` renders a card per purchasable plan, with its price, and a
     comparison column to match, with no click needed.** `pricing-v18.spec.ts`
     owns this. Two V392 facts make it more than a rename: `PRICING_PLAN_KEYS`
     is four wide (enterprise is a Contact-us strip, not a column), and the
     locale matters — `/pricing` reads the `[lang]` PATH, not the cookie.

7. **An unrecognised org-addon rider is a SILENT BILLING PATH, and W2 deleted
   the two tests that named it** (owner ruling 2026-09-03, W2 plan decision 8;
   the tests were `a pro_plus org-addon item prices/lifts independently of
   pro's` and `resolves the PRO PLUS price for a pro_plus group, not pro's` in
   `server/usecases/__tests__/extra-org-addon.test.ts`). The mechanism:
   `isOrgAddonItem` (`lib/org-addons.ts`) matches a subscription item's
   `lookup_key` against the CATALOG's own set, and `scripts/stripe-sync.ts`
   never prunes — it iterates only the entries the seed still names. So a seed
   entry that DISAPPEARS leaves its Stripe price active and purchasable, and a
   subscription still carrying `seazn_extra_org_pro_plus_monthly` is
   unrecognised end to end: never re-priced, never synced into `org_addons`,
   never alerted on — and still billing the customer every month.

   Bounded to test mode ONLY because there is no live Stripe catalogue (owner,
   2026-09-03), which is why the owner ruled it not worth code that outlives
   Pro Plus. **It must be closed before a live catalogue exists.** The shape of
   the fix is a reconciliation that walks the subscription's items rather than
   the seed's — anything on a `seazn_*` lookup key the catalog cannot name is
   an alert, not a silent skip. Note the same asymmetry protects nothing else:
   `planKeyForPrice` would likewise resolve an orphaned price id to a `plans`
   row this wave deleted.

8. **`scripts/smoke.ts` still seeds a `pro_plus` subscription at EIGHT sites,
   and no typecheck can see it.** `tsc -p tsconfig.scripts.json` exits 0 with
   all eight present, because `setPlan`'s plan argument is a plain `string`,
   not `PlanKey` — so V392 left this entirely to a runtime FK violation
   (`subscriptions_plan_key_fkey`). The first one aborts the run, and every
   check after it never executes, which is the shape that reads as "smoke is
   broken" rather than as eight specific stale assertions.

   The write sites, as of this commit: `smoke.ts:1997` (the `PERSONA 3 —
   pro_plus` block, ~140 lines through :2210, including the `#448` timezone /
   maxPerDay cases and a feed seed), `:3354`, `:3610`
   (`seedGroup("churn", "pro_plus")`), `:11362`, `:11867`, `:12031`, `:12359`.

   Repointing them onto `enterprise` is mechanical for the plan key but NOT for
   the assertions around them, and three of the surrounding premises have
   changed sides:
   - `ai.credits.monthly` on the above-Pro tier is **500**, not 200.
   - `officials.auto` and `scorers.max` are **plain Pro** keys now, so a
     persona proving "the tier above Pro unlocks officials.auto" proves nothing
     — `api.write` is the ONLY bool left that Pro cannot reach.
   - `orgs.max_owned` on `enterprise` is **NULL (unlimited)**, where `pro_plus`
     was a finite 10. Any group-cap or rider assertion seeded on the above-Pro
     tier therefore has no threshold to cross and needs `pro` as its vehicle
     instead. `smoke.ts:3296`'s own comment ("V314: community 1 / pro 5 /
     pro_plus 10. The two rider RATES…") is stale for the same reason, and
     there is no `enterprise` rider SKU in `stripe-plans.json` at all.

   **This was deliberately NOT swept in the T7/T9 sweep**, and the reason is
   the standing rule that a read is not a run: smoke cannot be verified without
   a prod build and a live server, and eight blind edits to an 18,700-line
   script that only a real smoke run can judge is how a wrong assertion gets
   frozen in and later "fixed" by weakening it. It needs its own task, with a
   full `npm run test:smoke` as the acceptance gate — not a typecheck, which
   already passes and always did.

   Already fixed in that file by the sweep (these were named, bounded, and
   independently checkable against the live matrix): community
   `ai.credits.monthly` 10 -> 5 and its bootstrap wallet grant, Pro 60 -> 35,
   the deleted `officials.per_fixture.max` cap check (inverted to assert the
   key is not served at all, since `undefined === null` would now fail), and
   the `dashboard.player_profiles` pair — V392 grants profiles on Community, so
   the unpassed sibling renders 200 where the old check demanded a 404.

9. **The Stripe seed's `event_pass_l` description tells buyers the entrant cap
   is "unlimited". It is 512.** `capClaimFaults` catches it, and the fault is
   live right now: `plan-copy-truth.test.ts` fails with `event_pass_l: does not
   quote its live entrant cap (512)`.

   The reason it was not caught when V392 landed is worth keeping. That whole
   test file **failed to COLLECT** — W2 T4 deleted `pro_plus` from
   `stripe-plans.json` while the file's module scope still did
   `stripePlans.plans.find(p => p.key === "pro_plus")!.product.description`,
   which threw before a single test registered. The JSON reporter reports a
   non-collecting suite as **0 tests and 0 FAILURES**, so the suite looked
   clean, and the file is the only caller of `passCreditGrantFaults` — the
   per-rung pass-credit change shipped with no running witness at all. The
   collect is repaired; the copy fault it exposes is real and belongs to the
   copy sweep (`stripe-plans.json` product descriptions + `capClaimFaults`).

10. **V392 SOLD FIVE FEATURES ON THE EVENT PASS THAT A PASS HOLDER CANNOT
    REACH.** This is a live product defect, not a test to retire, and it is the
    highest-value thing the T7/T9 sweep found. `pass-scoping-guard.test.ts`
    ("Event Pass grants are resolved with a competition in scope") is RED with
    eight offenders:

    ```
    src/server/usecases/device-links.ts:105   requireFeature("scoring.device_links")
    src/server/usecases/history.ts:420        getLimit("schedule.checkpoints.max")
    src/server/usecases/match-reports.ts:270  hasFeature("discipline.enforced")
    src/server/usecases/player-stats.ts:296   requireFeature("stats.player")
    src/server/usecases/player-stats.ts:359   requireFeature("stats.player")
    src/server/usecases/player-stats.ts:481   requireFeature("stats.player")
    src/server/usecases/stages.ts:288         getLimit("stages.per_division.max")
    src/server/usecases/templates.ts:171      getLimit("stages.per_division.max")
    ```

    **Why it is new.** That guard computes the pass-lifted key set from the
    LIVE matrix — `event_pass` rows whose value `is distinct from` community's
    — and then scans production source for enforcement sites that resolve the
    key WITHOUT a competition id. It was green before V392 because none of
    these five keys was lifted. V392 lifted all five: `stats.player` and
    `scoring.audit_export` granted on the pass, `discipline.enforced` granted,
    `scoring.device_links` granted, `stages.per_division.max` 2 -> 4, and
    `schedule.checkpoints.max` given its own pass row (5) where it used to fall
    through to community's 2.

    **What a customer sees.** An org on Community buys an Event Pass for a
    competition. Design §2 says that pass includes player stats, discipline
    enforcement, device-link scoring, four stages per division and five save
    points. At every site above the code asks the ORG-WIDE question, which for
    a Community org resolves to the community value — so the buyer is refused,
    or capped at Free's number, on features they have paid for. Money taken,
    feature withheld, no error anywhere.

    **This is exactly the class T6 fixed for officials** (`requireFeature`
    already accepts a competition id at `entitlements.ts:666-672`; the three
    officials call sites simply never passed it). The same one-argument change
    is owed at these eight sites, plus a test per site proving the pass lifts
    it on the passed competition and does NOT lift it on a sibling — T6's
    mutation check (drop the id from one call, the test must red) is the model.

    **The guard's own header says "DO NOT WEAKEN THIS ASSERTION AND DO NOT ADD
    A SUPPRESSION LIST."** It was not weakened. It is left RED on purpose so
    the next wave cannot miss it, and it will go green on its own once the ids
    are threaded — no test edit is owed, only production code.

    Note `divisions.per_competition.max` and `entrants.per_division.max` are in
    the lifted set too and are NOT offenders: those call sites already scope to
    a competition. So the guard is discriminating, not blanket.

    **A SECOND guard is red on the other half of the same defect, and the two
    must be fixed IN THIS ORDER.** `components/__tests__/upgrade-gate-pass-features.test.ts`
    derives the lifted set the same way and compares it against
    `lib/pass-features.ts`'s hand-written `PASS_FEATURES` — the set that decides
    whether a paywall offers the Event Pass or only the Pro card. It disagrees
    with the live matrix in both directions:

    - **Seven keys are missing** (the pass lifts them, the paywall does not
      offer it): `discipline.enforced`, `officials.auto`,
      `schedule.checkpoints.max`, `scoring.audit_export`,
      `scoring.device_links`, `stats.player`, `stages.per_division.max`.
    - **Three are stale** (in the set, no longer lifted):
      `dashboard.player_profiles` (V392 made it free on Community),
      `scheduling.multi_division` and `formats.double_elim` (granted on every
      plan, so the pass lifts nothing).

    **Do not "fix" `PASS_FEATURES` first.** Six of those seven additions are
    exactly the unscoped enforcement sites listed above. Adding them while the
    gates still resolve org-wide makes the product OFFER a pass for features it
    then refuses to deliver — the user pays and stays blocked, which is the
    precise harm that test's own header names as its right-hand-side failure,
    and it is strictly worse than today's "never offered". Thread the
    competition ids first, then widen `PASS_FEATURES`, then both guards go
    green together. The three stale removals are safe in either order but do
    not make the test green on their own (it asserts set EQUALITY).

    Both of these are the same failure shape and worth naming as a class: a
    guard whose target set is DERIVED FROM THE DATABASE goes red when a
    migration lands, with no application diff to point at. Nothing in V392's
    own diff mentions `player-stats.ts` or `pass-features.ts`. Run the
    source-scanning and matrix-derived guards explicitly after any
    `plan_entitlements` change — file-based test selection will never reach
    them.

### Closed by W1, recorded so nobody re-opens them

- **The device-link 403's zero automated coverage.** Task 6 gave it a shared
  predicate (`deviceLinkCoversFixture`) plus unit, e2e and smoke coverage, all
  mutation-proven: with the predicate forced to `return true` a score event
  LANDS on a fixture the link does not own, and — the measurement that
  justified the task — the two PRE-EXISTING device-link e2e tests stay GREEN
  under that same mutant. The realtime-token route's independent second copy of
  the rule was converged onto the shared predicate and given its own test.
- **The racquet-skin locked tile.** W1 closes it by DELETION, not rewording:
  badminton/tabletennis/volleyball lose the disabled "Rally by rally is locked"
  tile, and `pad.<sport>.context.recording[.locked]` and
  `pad.<sport>.tile.rallyLocked[.sublabel]` are gone from all four
  dictionaries. The interim window persists on `main` until W1 merges.
- **D-7** ("raw fidelity picker + unexplained 🔒") in the scorepad-v3 register.
  Closed there with the evidence; see that index's Register-audit section.
- **The a11y evidence pass measuring the cookie banner** (twice). Root cause
  measured, not reasoned: the banner mounts from a `useEffect`, i.e. at
  hydration, and `page.goto` resolves first — so `dismissCookieBanner`'s
  `count() === 0` early return is a silent no-op in exactly the conditions that
  produce the failure. At 1x and 6x CPU the banner was already up when `goto`
  returned; under a 20x throttle it mounted 296–575ms AFTER. Fixed by
  PREVENTION (seed the consent keys into the anonymous context's storage state,
  so the banner never mounts — re-measured at the same throttle: no banner
  across 8.3s), with an assertion at the point of arrival so a recurrence names
  itself instead of being measured in silence.

## Process traps this programme paid for

- **Cross-session `file:line` pins are BRANCH-RELATIVE.** The same statement sat
  at three different line numbers on three branches, and a "correction" traded
  between two sessions was wrong for both. Record the branch beside any pin, or
  cite the SYMBOL and let the reader grep.
- **A grep for the literal event type is a false absence.** Dictionary keys are
  spelled `pad.<sport>.ribbon.<suffix>`, not `<sport>.<suffix>`. An empty grep
  from the wrong pattern is evidence of nothing searched.
- **The SDD ledger is git-ignored and deleted at close-out.** That is why this
  file exists. Migrate rulings here as they are made, not at the end. And check
  which TREE the index is on: this one was committed to the local `main`
  checkout, not to the wave branch, so the wave's own sessions could not see it.
- **A mutation restore needs ABSOLUTE paths.** A restore written as
  `cd apps/web && … && cp bak apps/web/e2e/x.ts` resolves to
  `apps/web/apps/web/…` and silently leaves the mutant in the tree. Happened
  again in Task 7; caught by grepping for the mutant marker after the restore,
  which is the check to keep.
- **Verify a fix by BREAKING it, not by reading it.** Twice in one task an
  implementer confirmed its own fix by re-reading the code and both times a
  reviewer found the gap by reverting the call site. A test that claims to pin
  a call site must FAIL when that call site is reverted, and the only way to
  know is to revert it.

## Findings routed out of W1 (2026-09-03)

W1's visual pass and its reviews turned up seven things W1 did not cause and did
not fix. Four now have a wave; three have nobody, and that is a decision waiting
rather than an oversight. Each is written with its evidence so the wave that
picks it up inherits a finding rather than a rumour.

**Routed, with the wave that will run them:**

| Finding | Wave | Why there |
|---|---|---|
| `copy-truth.ts`'s per-locale paywall vocabulary is thin — built by a non-native speaker from shipped strings, held by a per-locale liveness floor | **W2** | W2's scope already names copy-truth guards |
| The three non-Plus pricing cards are hardcoded-English arrays, so every bullet reaches fr/es/nl in English | **W3** | W3 rebuilds those cards; build them from the dictionaries or the debt ships again |
| At 320 the pricing matrix is a 6-column desktop table in a scroller — shrunk, not composed | **W3** | W3 carries the 1280/768/320 sign-off; apply it to the matrix, not only the cards |
| At 320 the division tab rail scrolls the ACTIVE tab off-screen with no indicator | **W3** | A surface fix, and the billing settings rail already solves it — copy that pattern |
| Nine anonymous e2e contexts share the cookie-banner race W1 fixed in one spec | **W4** | W4 is proofs and walkthrough; they fail loudly, so they were recorded not swept |

**Unowned, and outside this programme — they need a decision, not a wave:**

- **The setbased kernel registers event schemas for types no shipped preset
  accepts** — 63 recordable against 68 registered (badminton timeout/sub/expedite,
  tabletennis sub, volleyball expedite). R8 added ribbon copy as a floor under the
  leak; the types still exist. Deliberately kept out of a close wave: narrowing a
  schema registration moves golden corpora. Small and well understood as its own task.
- **~20 route handlers parse the request body BEFORE authenticating.** Repo-wide
  pattern, not one route — a rule to decide rather than a patch to apply.
- **No test names the invariant that `http.ts`'s dedicated 402 branch precedes the
  generic `HttpError` branch.** Reordering them would keep the status and silently
  drop `feature_key`, taking every contextual paywall generic. Guarded indirectly
  today (smoke and two e2e specs assert the body), but nothing pins the order. Raised
  by the bench session, routed to its owner.

## Runbook: querying the live `plan_entitlements` catalog (G7, bench B03 product-gaps)

**No single migration is the catalog.** Entitlement rows are spread across a
long tail of deltas (V024, V112, V240, V269, V290, V302, V306, V311, V319,
V341, V353, V390, …) that insert, update and delete each other's rows —
`V112__entitlements_v2.sql` seeds `community`, `pro` and `business`, but
`business` is absent from a live database today because a later delta removed
it, while `pro_plus`, `event_pass` and `event_pass_l` — none seeded by V112 —
are present. Grepping any one migration for "what plans exist" or "what a plan
grants" is a snapshot of a moment in that history, not the catalog.

Deliberately not committing a table of today's plans/counts here: this
document already generated one (2026-09-02, from a v389 database) and it read
wrong by the next day — once from `V390__scoring_free.sql` deleting three
scoring rows outright, and again the day after that from W2 retiring
`pro_plus` for `enterprise`. A checked-in table goes stale between being
written and being re-read; a query does not. If W2's
`entitlements-v18-matrix.test.ts` has landed, prefer it — it pins the live
catalog against the design doc in CI, which is strictly better than running
this by hand.

Query the live catalog directly instead:

```sql
-- schema is seazn_club, not public: PGOPTIONS='-c search_path=seazn_club'
select plan_key,
       count(*) filter (where bool_value)                            as granted_bool,
       count(*) filter (where int_value is not null)                 as granted_limit,
       count(*) filter (where bool_value is true
                           or int_value is not null)                 as granted_any,
       count(*)                                                      as rows
  from plan_entitlements group by 1 order by 1;
```

`granted_bool` alone undercounts — a plan's numeric limits (`ai.credits.monthly
= 10`, and others) are grants too, and `granted_bool` scores every one of them
as ungranted. Read `granted_any` as "features this plan grants".
