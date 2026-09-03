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
| W1 | R9 "scoring goes free" — gate removal, `fidelityTiers` retirement, recording chip, three keys deleted, pinned tests moved | **COMPLETE, UNMERGED** — Tasks 0–7 done and reviewed; branch `feat/entitlements-w1-scoring-free`, 25 commits, no PR opened |
| W2 | Matrix & plumbing — migration, inert-key deletion, `featurePlan`, labels, add-on sets, credits math, per-rung pass grant, `stripe-plans.json`, copy-truth guards. **R12 prices and R13 hidden add-on land here.** | not started |
| W3 | Surfaces — pricing page redesign (R14), billing settings, gates, dictionaries ×4, emails, help, e2e replacements | not started |
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
