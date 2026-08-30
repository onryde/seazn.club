# R9 — scoring goes free: remove the entitlement gate, retire `fidelityTiers`

Read `_RULES.md`, then `_INDEX.md`, then this file. Runs AFTER R6 and R7 merge.

**Owner ruling, 2026-08-30:** keep the fidelity bands, make them free and open.
Bands stay as a UX choice about how much detail a scorer records; they stop
being a price boundary. Entitlements elsewhere — AI credits, seats, scale,
registration, payments — are untouched.

**The principle to hold the whole wave to: charge for leverage, never for
correctness.**

---

## Why this is a wave and not a one-line deletion

Three things move together, and doing any one alone leaves the product
incoherent:

1. the server gate stops refusing scoring events,
2. the legacy `fidelityTiers` model retires, because with nothing paywalled it
   has no remaining job,
3. the recording chip stops rendering a lock and an upsell.

(3) is not cosmetic — it closes **D-7** from this programme's own defect
register ("raw fidelity picker + unexplained 🔒"), which R1 addressed only by
explaining the lock rather than removing it.

## What was pinned before this wave was written (do not re-derive)

- **The gate:** `apps/web/src/server/usecases/scoring.ts:266-268`
  (`assertEntitledToScore`, reached from `scoreEvent:95`) calls `requireFeature`,
  which throws the 402. The deciding predicate is
  `apps/web/src/server/usecases/fidelity.ts:28-33`: it walks the module's
  **legacy `fidelityTiers` array**, lowest tier declaring the event type wins,
  and `tier <= 1` is free. **It never reads `PadSpec.fidelity`.**
- **Two models exist BY DESIGN**, documented at
  `packages/engine/src/sport/module.ts:102-106` — the newer `PadSpec.fidelity`
  map is additive and the paywall deliberately keeps reading `fidelityTiers`.
  So this wave RETIRES a documented model; it is not fixing a bug.
- **One HTTP door:** `apps/web/src/app/api/v1/fixtures/[id]/events/route.ts:16`
  → `scoreEvent`, used by BOTH the console and the device link
  (`components/v2/scorepad/transport.ts:201` is the only POST path). The batch
  importer (`server/usecases/event-import.ts:246`, route
  `api/v1/divisions/[id]/events/import/route.ts:30`) shares
  `requiredFeatureForEvent` and moves in lockstep — do not miss it.
- **Tests that pin today's refusals**, all of which this wave must move
  deliberately rather than discover:
  - `scripts/smoke.ts:5486-5525` — asserts 402 + `feature_key` for
    `icehockey.suspension.start` (→ `scoring.match_timeline`),
    `tabletennis.expedite.start` and `tennis.interruption`
    (→ `scoring.rally_by_rally`).
  - `apps/web/src/server/usecases/__tests__/fidelity.test.ts:63-79` — the sweep
    "every declared tier>1 event type resolves to a feature".
  - `apps/web/src/server/usecases/__tests__/entitlements-v2.test.ts:219-227,
    365, 452` — uses `football.card`.
- **THE TRAP THAT WOULD HAVE COST REVENUE:** the two models drift in BOTH
  directions. `cricket.superover.ball` is `fidelityTiers` tier 1 — **free
  today** (`cricket.ts:3471`) — but `PadSpec.fidelity` band **3**
  (`cricket.ts:3000`). Any migration that "aligns the server to `padSpec`"
  newly PAYWALLS it. This wave makes everything free, so the trap is defused by
  construction — but a future session that reads only half this file could
  reintroduce it.

## Scope

1. **Remove the scoring entitlement gate.** `assertEntitledToScore` stops
   refusing on fidelity. Decide explicitly whether `requiredFeatureForEvent`
   dies entirely or returns `null` for every scoring event, and say which in
   `_INDEX.md` — a function that always returns null is an inert seam, and this
   programme has shipped six of those.
2. **Retire `fidelityTiers`.** Every module's array, the type, and every read
   site. `PadSpec.fidelity` becomes the single model. Expect this to be the
   largest mechanical part of the wave, across all eleven sports.
3. **Simplify the recording chip** (`v3/recording-chip.tsx`): no lock, no
   upsell, no entitlement read. It becomes a plain "how much detail are you
   recording?" picker. `frontend-design:frontend-design` BEFORE the visual work,
   screenshots at 320/768/1280, and a walkthrough — the owner has made the
   walkthrough a per-TASK gate, not per-wave.
4. **Pricing surfaces** must stop advertising scoring fidelity as a paid
   feature — plan page, help pages (`content/help/**`, English only), and the
   smoke demo. Free-in-product and paid-on-the-page is worse than either state.
5. **Instrumentation, in parallel and NOT a gate:** log scoring-refusal events
   (event type, org, plan) for the period before removal so the owner learns
   afterwards what the gate was worth. Recommended, not required; if it is
   dropped, say so rather than leaving it half-built.

## Out of scope — say no to these explicitly

Every other entitlement. AI credits, seats, competition scale, registration and
payments, exports, branding. Those gate things with real marginal cost. **A
scoring event is a cheap row in Postgres; that is the whole argument.**
Do not "tidy" adjacent entitlement code while you are in there.

## Acceptance

- Every change ships a test that fails without it; mutation-prove each removed
  guard by restoring it and watching the new test go red.
- The four pinned tests above are updated as a deliberate act, each with a
  comment saying what it formerly asserted and why that is no longer true.
- A free-plan org can record EVERY event type of EVERY sport at EVERY band —
  driven through the real HTTP door, not asserted at the usecase.
- **Both callers proven:** the fixtures events route AND the batch importer.
- The device link gains no rights it did not have: it may still only void its
  own rows, and the 403 in `server/usecases/scoring.ts` that enforces this must
  be shown still to bite.
- `git grep -a` returns no surviving `fidelityTiers` reference.
- Walkthrough: a free org, a real match, a band-3 event recorded and visible.

## The trap this wave is most likely to hit

`fidelity.ts`'s predicate is the ONLY thing standing between a free org and
every scoring event. Removing it is easy; proving nothing else depended on it
is the work. Grep for `requiredFeatureForEvent`, `assertEntitledToScore`,
`scoring.match_timeline`, `scoring.rally_by_rally`, `scoring.ball_by_ball` and
`fidelityTiers` — **by behaviour, not by filename** — and read every hit. An
e2e sweep filtered by filename missed the spec that actually exercised the path
once already in this repo.
