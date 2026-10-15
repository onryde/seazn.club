# Performance — scoring load at multi-tournament scale (design brief)

**Date:** 2026-10-15. **Status:** BRIEF — parked by the owner ("we will pick some week later"). Nothing here is built.
**Owner question (2026-10-15):** "what happens if 10 tournaments are playing 100 matches" — and why not expose the engine as a server API instead of shipping it to the phone.

## 1. Decisions already taken (context, not reopened here)

- **The engine stays on the phone** (capture app) and in the web pad. Reasons: venues often have weak or no signal, so the pad must score offline and queue; and every tap needs the next score, server, game/set end and the allowed next buttons in under a millisecond, which a 100–500 ms round trip on venue 4G cannot give. The server stays the authority: it re-folds every event it accepts, and its result is what counts.
- **No separate engine service.** The engine is pure calculation (no I/O) running in-process in the web server; an internal service would add a hop, a deploy and a failure mode for no gain. The server's `POST /api/v1/fixtures/{id}/events` already is "the engine as an API" for scoring.
- **Versioning** follows from the phone engine: per-sport `FOLD_EPOCH` (major, server refuses an older phone, 426 `ENGINE_OUTDATED`) and `FOLD_MINOR` (standings-only, no app update) — engine-split batches 1e/1f and the 1e major/minor follow-up. Release order: app first, then server.
- **Option recorded, not chosen:** after each sync the server returns the official state so the phone can self-correct if it ever disagrees (belongs to the capture S2 handoff).

## 2. What was measured (2026-10-15)

Engine fold cost, in-process, `node --experimental-strip-types`, the longest golden stream per sport, this dev machine under load average ~16 from other sessions (so an upper bound). Script: `foldbench.ts` (orchestrator scratch; re-create from §6 step 1).

| sport | events in stream | full-ledger fold | avg per append over the match |
|---|---|---|---|
| cricket | 120 | 1.62 ms | 0.66 ms |
| volleyball | 120 | 0.63 ms | 0.22 ms |
| tennis | 120 | 0.44 ms | 0.17 ms |
| football | 36 | 0.31 ms | 0.19 ms |
| tabletennis | 41 | 0.21 ms | 0.07 ms |
| badminton | 43 | 0.19 ms | 0.06 ms |
| icehockey / hockey / carrom | 24–29 | 0.15–0.18 ms | 0.05–0.08 ms |
| boardgame / generic | 3–5 | 0.03 ms | 0.01–0.02 ms |

**How the server folds today** (`apps/web/src/server/engine-db/append-event.ts:~462`): every append re-folds the WHOLE ledger (`foldMatchWithStoppage(..., stream, { strictFromSeq })`) after reading every prior event of the fixture. Cost is linear in events so far — about 13 µs per recorded event for cricket. Extrapolated: T20 (~300 events) ≈ 4 ms per new ball; one-day (~650) ≈ 9 ms. Per match that is O(n²) total, still small.

## 3. Load model (estimate — NOT measured end to end)

Scenario: 10 tournaments × 100 matches live at once = **1,000 concurrent matches**.

- **Write rate.** Assume one scoring event per match every ~15 s (rally sports and cricket balls; football is far sparser) → **~67 events/s**, bursts higher at session starts.
- **Engine CPU.** 67/s × 2–9 ms ≈ **0.15–0.6 of one core.** Not the bottleneck.
- **Database (scoring).** One short transaction per event (auth + entitlement + read ledger + insert + idempotency) at ~20–50 ms ≈ **1.5–3.5 connections busy on average.** Prod budget (memory `project_prod_db_connection_budget`): `max_connections=60`, 57 usable, today 3 machines × `DB_POOL_MAX=12` = 36 pooled.
- **The real risk is READS, not writes.** 1,000 live matches may mean tens of thousands of spectators on public match/division/hub pages and realtime. On 2026-09-24 a single hub view fanning out per-division `unstable_cache` revalidations exhausted the pool on cold-booted machines (Sentry SEAZN-CLUB-PROD-1). Every scoring write that revalidates public pages multiplies this.

## 4. Known hot spots (ranked)

1. **Cache revalidation fan-out per scoring write** → DB pool exhaustion under spectator load. Mitigation path: the Cloudflare edge programme (`project_cloudflare_edge_for_public_surface`), coalesced/debounced revalidation per division, read replicas or pgbouncer transaction mode for public reads.
2. **Full-ledger read + re-fold per append.** Fine at hundreds of events; becomes the cost if ledgers get long (multi-day cricket, chess with many moves) or event rates rise. Mitigation: persist a folded snapshot every N events (state is already stored as jsonb, V217) and fold only the tail; or cache the folded state per fixture in-process with `seq` as the key.
3. **Realtime fan-out** (Supabase realtime) for live spectators — channel/connection limits of the plan in use; unmeasured.
4. **Idempotent retries from phones after a dead zone** — a venue's phones all reconnecting at once replay their queues in a burst (thundering herd). Mitigation: client jitter/backoff; server rate limit per device link.
5. **Fly machine count vs pool** — scaling machines without lowering `DB_POOL_MAX` overflows `max_connections` (the 09-24 incident).

## 5. Goals for the performance programme (when picked up)

- A **repeatable load test** that answers the owner's question with numbers: p50/p95/p99 append latency, error rate, DB connections in use, CPU per machine, at 1,000 concurrent matches + N spectators.
- Explicit **budgets** written down (e.g. append p95 < 300 ms at 1,000 matches; zero pool-exhaustion errors; public page p95 from edge < 200 ms) — owner to set.
- Fix only what the test shows; do not pre-optimise (snapshots, replicas) without a red number.

## 6. Proposed shape of the work (to plan later)

1. **Fold micro-bench in the repo** (`packages/engine` bench script over every corpus stream, reports per-sport fold cost and per-event slope; anti-vacuity: counts streams, 0 = failure). Regression signal, not a gate.
2. **Load generator** (`scripts/load/`): synthetic orgs/divisions/fixtures for 10 tournaments × 100 matches across sports (synthetic data only), scorers posting realistic per-sport event streams (reuse golden corpora as event sources) through the real `/api/v1` route with idempotency keys, plus spectator traffic on public pages and realtime. Tool choice (k6 / autocannon / a Node driver) decided in the plan.
3. **Target:** a local production build + local Postgres sized like prod (`max_connections=60`, pool 12 × machines) first; staging second (owner call — staging cost and the public surface). Never production.
4. **Measure, then decide** on §4 mitigations in priority order.
5. **Bursts:** session-start burst and dead-zone reconnect burst as separate scenarios.

## 7. Open questions for the owner

1. The budgets in §5.
2. Realistic spectator ratio per live match (drives §4.1 and §4.3).
3. Staging load test allowed (cost, shared Supabase project)?
4. Longest ledgers to plan for (multi-day cricket? chess with clocks?).

## 8. Out of scope

Engine placement (§1), the versioning design, and any production test traffic.
