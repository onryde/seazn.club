# Sponsor × live-stream test matrix — design

Owner, 2026-11-11: "after PR 3, we need to do multiple matrix of testing including live streaming w/o multiple deals
multiple tier". Owner, 2026-11-12: "just build it and want to do live streaming testing along with sponsor in stage".
No brainstorm (owner opted out); every choice below not quoted from the owner is marked **Call**.

## Why

Sponsor deals decide who airs where. The stream never reads deals: `deal-apply.ts:293 applyDealsToSponsor` copies a
deal's tier, scope, on_stream and status onto the `sponsors` row, and `usecases/sponsors.ts:458 resolveSponsors` →
`sponsors/assign.ts:252 loadSponsorPlan` → `overlay/load.ts:284` → the overlay reads that row. Recon (2026-11-12) found:

1. No test carries a deal, of any state or payment type, through to the stream plan or its airings.
2. Every stream × sponsor e2e runs on Pro. Free (partner-only flattening, `card-source.ts:51`) and Pass reach the stream
   path only in vitest.
3. "Times shown" is written only by a composed compositor heartbeat (`stream-sessions/heartbeat.ts:85`). OBS/passthrough
   shows cards and records nothing.
4. Nothing has ever been run against stg: the fake ingest is refused off local/ci (`relay/config.ts:452`) and there is no
   synthetic camera, so a real stg stream needs a real phone.
5. Archive (#1190) is new; nothing proves an archived sponsor leaves a stream that is already live.

## Goals

- G1. Every reachable cell of the matrix below has a test that drives the REAL seam (deal → sponsor row → plan →
  overlay/airings), not a fixture on both ends (AGENTS.md class 1).
- G2. The transitions a club causes MID-STREAM are proven: a deal ends, a queued deal goes live, a sponsor is archived
  and unarchived, a deal is written off, the plan changes.
- G3. One real live stream on stg with sponsors, driven by the owner's phone, proving the same cells end to end on real
  infrastructure (Cloudflare Stream, Fly compositor `seazn-relay-stg`, real airings → Overview "Times shown").

## Non-goals

- No new product behaviour. A defect found becomes its own fix, not part of this work.
- No synthetic stg camera / ffmpeg sender (**Call**: non-product tooling, standing rule; the owner's phone is the source).
- No YouTube destination in the stg run (**Call**: Cloudflare playback is enough to prove the overlay; YouTube adds an
  OAuth step and a public broadcast for no sponsor signal).
- No prod run (prod stays held).

## The matrix

Axes:
- **Plan:** free · pass (competition pass) · pro.
- **Tier:** title · gold · silver · partner. Free = partner only (higher tiers flatten to partner on stream).
- **Deal state:** none · live · scheduled (queued behind a live one) · ended · written_off · archived sponsor.
- **Payment:** online (Stripe) · offline (marked paid) · complimentary · awaiting payment.
- **Scope:** org-wide · this competition · another competition.
- **Stream mode:** composed (records airings) · passthrough/OBS (shows, records nothing).

Full product is 3×4×6×4×3×2 = 1728; most are unreachable or equivalent. **Call**: the matrix is pairwise over the axes
plus every single-axis edge, and the expected answer for each cell comes from the declarations (`SPONSOR_TIER_WEIGHTS`,
`DEAL_STATUSES`, the plan entitlements `sponsors.tiers` / `sponsors.monetize`), never from the code under test. The test
reports how many cells it checked; zero is a failure (TEST-STRATEGY anti-vacuity).

Expected per cell: airs or not; aired tier (after flattening); weight in rotation; counted in "Times shown" (composed
only); listed on the public page; listed in the report.

## Layers

**L1 — DB seam matrix (vitest, real Postgres, CI).** One table-driven suite: seed org + plan + sponsor + deal(s) through
the real usecases (`createDeal`, mark paid, end, archive…), then call `loadSponsorPlan` and the overlay loader and assert
the cell. Cheap, covers the whole pairwise set.

**L2 — composed e2e (Playwright, fake relay, CI).** A handful of journeys on the existing stand-in helpers
(`e2e/helpers/sponsor-relay-standin.ts`): start a composed session, change deals mid-stream, post heartbeats, read
`sponsor_airings` and the Overview "Times shown". One journey per plan (free/pass/pro). Mid-stream: end deal, queued goes
live, archive, unarchive.

**L3 — stg live run (owner + agent, once, scripted runbook).** The agent seeds a test club on stg through the product
(API/UI, test data only, cleaned up after); the owner pairs a phone and goes live (composed); the agent changes deals at
marked times and reads the overlay, airings and Overview; the owner watches the Cloudflare playback. ~30 min. Results
per step in a sign-off page.

## Constraints

- House rules: scoped tests only locally; e2e/smoke via CI; 4 locales untouched (no copy); every guard mutated once.
- stg writes: test data only, through the product, owner present; removed after (stg data is test-only).
- Cost: one stg stream ≈ 30 min of Cloudflare Stream input + one Fly compositor machine.

## Left to the builder

Cell selection tooling, file layout, which stand-in helpers to extend vs add.
