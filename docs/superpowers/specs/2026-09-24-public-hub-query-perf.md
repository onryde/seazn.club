# Public hub query performance — plan + state

Owner request 2026-09-24: "How to optimize the db query especially for public
hub data", then "Ok" + "what about rest?" → implement all six findings.
Branch `worktree-perf-public-hub-queries`, worktree
`.claude/worktrees/perf-public-hub-queries`.

## Evidence (prod `seazn-prod`, pg_stat_statements since 2026-09-18)

- `public_entrants_v` by division: 299 s total, 12,292 calls, 24 ms mean on
  67 entrant rows. EXPLAIN ANALYZE (14-entrant division): members subplan
  0.514 ms/loop of which input is 0.025 ms — the rest is
  `org_has_feature(c.org_id,'dashboard.player_profiles',c.id)` called TWICE
  per member row inside `jsonb_build_object`. The function is STABLE
  SECURITY DEFINER + `SET search_path` ⇒ never inlined; ~0.1 ms + 14 buffer
  hits per call. Indexes are NOT the problem (entrant_members pkey leads
  entrant_id).
- postgres.js type introspection (`select b.oid, b.typarray from pg_type …`):
  24,669 calls / 101 s ⇒ one per new connection ⇒ heavy connection churn
  (`idle_timeout: 20` in `lib/db.ts`).
- Org loader: 17 ms mean, `org_has_feature` ×4 in select list.
- Table sizes are tiny (≤106 rows) — seq-scan counters are noise; indexes are
  for the scaling curve, not today's latency.

Code map (subagent, unverified line numbers — re-pin before building):
hub Redis `pub:v1:hub:{compId}` 15 s, no single-flight, deleted in
`scoring.ts invalidatePublicCache`; `findCompetition` runs before the cache
on every poll; `getPublicDivision` (data.ts ~916-967) 10 sequential awaits +
5 correlated fixtures subselects per row; `readLeaderRows`
(public-leaders.ts ~69-90) rebuilds full `members` jsonb per leader row;
overlay 3 uncached queries per poll; `/divisions/[d]/stats` uncached;
division page runs `detectSuspensions` in a tenant tx per ISR render.

## Tasks (sequential — shared files)

| T | Scope | Status |
|---|---|---|
| T1 | New migration: `public_entrants_v` computes the profiles entitlement once (lateral) not per member; indexes `fixtures(division_id, round_no, seq_in_round)` + `competition_passes(competition_id, org_id)`; leaders query stops selecting `members` jsonb if only names are used | committed 0827dc0dd (V418; `offset 0` needed or PG folds the lateral back per reference; competition_passes index skipped — competition_id is already its PK; calls 5→2 view, 32→1 leaders; vitest 603/603 regression set, e2e 35/35, smoke 1109/0) — IN REVIEW |
| T2 | Hub: single-flight rebuild (Redis SET NX lock, losers serve stale), mark-stale instead of delete on score, `findCompetition` folded into the cached path | committed 02d9fe2f1 — 20 concurrent GETs after DEL (10-div comp, inner cache cold): ~1450→~90-160 stmts, p50 ~350→~112 ms; warm poll 1→0 stmts; mutants 18/18; e2e (no Redis, as CI) 164/164; ci.yml Redis step gains 2 suites. Review: R10 freshness race (rebuild read division data via unstable_cache → peer could cache pre-score hub for 15 s) → fixed e5848d2f3: Redis rebuild reads Postgres via uncached readers (ISR pages keep cache); warm rebuild 4→71 stmts (pre-T2 ~95), cold unchanged 91-161; live proof upcoming→live; mutants 13/13; e2e 164/164 — APPROVED (SQL byte-identical, ISR path still cached); comment nit folded into T4 |
| T3 | `idle_timeout: 60` only (fetch_types stays on) | DONE — d3534314c + a0610fd2c (review fixes: bound derived from fly*.toml health interval, fetch_types:true explicit) + d683f28fe (comment truth fixes); re-review approved code, comment nits verified by orchestrator |
| T4 | `getPublicDivision` + match-centre load: Promise.all independent reads, join instead of correlated subselects + `usecases/me.ts:341` per-row entitlement lookup (T1 carry-forward) | committed afe7f02da — wall @2 ms RTT: div detail 43→11 ms, getPublicFixture 70→33, publicFixture 40→14, hub(4 div) 124→105; stmts fixture 18→16, publicFixture 11→8; me.ts org_has_feature ≥12→1; getPublicFixture slower at RTT0 (6→11 ms); identity tests vs frozen old impl; mutants all killed except me.ts offset-0 fence (M1); e2e 113+16 pass, 1 red = local HS256 overlay mint (env); smoke 1109/0. False premises: me.ts had no per-row hoist (calls came from public_entrants_v); tie rows on (round_no, seq_in_round) have no stable order in old SQL. Bulk callers pass {sequential:true}. Env `perft4` (localhost:3324) left UP for review — tear down after. APPROVED; minors fixed 268615f5c (shared read-every-division helper, 4-key tie order) — re-review APPROVED |
| T5 | Overlay per-poll queries + stats endpoint cached; `detectSuspensions` off the render path — OWNER DECISION on freshness | DROPPED by owner 2026-09-27 |

## Decisions

- 2026-09-24: output of every changed view/loader must be byte-identical to
  before (perf-only change) — regression tests assert equality against the
  old shape, including the entitlement-denied branch (photo/person_id null)
  AND the granted branch.
- 2026-09-24 T3 OWNER-APPROVED ("Ok"): `fetch_types: false` + `idle_timeout: 60`
  in `lib/db.ts`. Basis: `fly.toml` `min_machines_running = 1` (one machine
  never suspends, so 20 s only churns it); Fly autostop idles for minutes, so
  60 s still drains the pool before a suspend; no `create type`/`create domain`
  in migrations, only builtin `text[]` arrays in code. Implementer must still
  rule out extension types (citext/vector arrays) before flipping fetch_types.
  (SUPERSEDED — see false-premise entry below.)
- 2026-09-24 T3 FALSE PREMISE (found by T3 implementer, verified in
  `postgres@3.4.9/src/connection.js:768-788`): postgres.js has NO builtin array
  parsers — `fetchArrayTypes()` registers parsers/serializers for EVERY array
  type incl. text[]/uuid[]. `fetch_types:false` ⇒ arrays return as "{a,b}"
  strings and `any(${ids})` throws `malformed array literal` (40 call sites,
  16 prod files). The owner's "Ok" was given on this false premise and is
  VOID for fetch_types. Recommendation put back to owner: `idle_timeout: 60`
  only, keep `fetch_types: true` (type query ≈ 4 ms/connect ≈ 17 s DB/day —
  not worth a hack on library internals). OWNER-APPROVED 2026-09-24
  ("idle_timeout: 60 ok"): T3 = `idle_timeout: 60` only, `fetch_types` stays on.
- 2026-09-24 T1 review: APPROVED, minors routed back to T1 implementer
  (empty/all-refuse entrants in CALLS+DIFFERENTIAL, youth cell in PARITY,
  2-division CALLS, V418 header notes the publish rule's second copy in
  public-leaders.ts). Carry-forwards: (a) V417 is held by unmerged
  `feat/printable-scorer-sheets`; no Flyway outOfOrder ⇒ whichever lands
  second renumbers — check at merge. (b) `usecases/me.ts:341` still does the
  per-row entitlement lookup — out of T1 scope, candidate for a later task.
- 2026-09-24 T3 review: SECOND FALSE PREMISE — "60 s drains the pool before a
  suspend" is false. `fly.toml` checks `/api/health` every 30 s and that route
  runs `select 1` on the pool, so the pool never drains on a running machine;
  every suspend freezes ≥1 socket (at 20 s ≈ 2/3 of suspends already). Real
  source of the ~24.7k reconnects = the health check re-dialing every 30 s at
  idle 20 s (~2,880/machine/day) → ~0 at 60 s. Sentry 90 d: zero
  ECONNRESET / CONNECTION_CLOSED / ETIMEDOUT issues (caveat: unmerged
  `fix/sentry-server-instrumentation` branch may mean capture gaps).
  OWNER RE-CONFIRMED 2026-09-24 with corrected facts: "keep 60".
  Fixes owed on T3 (after T2 commits — same worktree/index): rewrite db.ts
  comment + record corrected WHY; pass `fetch_types: true` explicitly and pin
  `=== true` (a `?fetch_types=false` URL param would otherwise disable it);
  tests derive the bound from both fly tomls' health-check interval
  (assert idle timeout > interval) instead of pinning the literal 60.
- 2026-09-27 T2 false premises: route is `[orgSlug]/[slug]`; hub key has 5
  writers not 2; org deletion has no app path. PRODUCT FINDING for owner
  (pre-existing, unchanged by T2): `public_competitions_v` filters on
  visibility ONLY — a draft or archived competition with public visibility is
  served on the public hub today. Division lookup not cached (more writers,
  not polled). Accepted trade: an out-of-app SQL edit to visibility/slug is
  served for up to 15 s (app write paths invalidate immediately).
- 2026-09-27 T5 DROPPED (owner "Ok" to recommendation): `detectSuspensions`
  is recompute-on-read BY DESIGN (cron-free ban serving; called from organiser,
  pad, fixture banner and public strip, discipline.ts:619-861); it exits after
  1-2 queries when discipline is off (:190-196) and the public call is ISR-30
  bounded. Removing it from the public path would let the public "remaining"
  count go stale until an organiser/pad read. Overlay polls come from 1-2 OBS
  instances per stream; stats endpoint is 2 queries, not polled — low value.
  T3 fixes committed a0610fd2c (bound derived from both fly tomls' health
  interval; fetch_types:true explicit; 17/17; 4 mutants killed) — review owed.
- 2026-09-27 T4 review APPROVED. Minors routed back: shared "read every
  division" helper w/ sequential + concurrency test (present/page.tsx:68 had no
  guard); me.ts offset-0 fence M1 recorded as accepted survivor. ORCHESTRATOR
  DECISION (reported to owner, veto open): add deterministic tiebreak (stage
  seq, then fixtures.id) to the hub fixture reads — the old ORDER BY
  (round_no, seq_in_round) had none, `sortHubMatches` keeps DB order for
  undated/same-time ties, and T4's plan changes could visibly reorder e.g.
  league R1M1 vs knockout R1M1 on deploy.
- 2026-09-27 FINAL whole-branch review (724206bed..268615f5c): APPROVED, no
  Critical/Important. T2×T4 interaction verified (Redis rebuild goes through
  readEveryPublicDivision → gets tiebreak + sequential). apps/web tsc exit 0
  (orchestrator rerun). Last nits DONE 51a88025d (4/4 mutants killed, 444/444): API v1 schedule 4-key order
  (consistency with pages), liveNow limit-12 tiebreak, hub-key literals →
  publicHubCacheKey, drop console.info from a test.
- STATUS 2026-09-27: all tasks done + reviewed; branch 10 commits on 724206bed,
  not pushed. Owed at PR/merge: owner go-ahead to open PR; V417/V418 order vs
  `feat/printable-scorer-sheets`; smoke runs on PR; e2e only on main push or
  workflow_dispatch `pr` input; clean up leftover worktree
  `.claude/worktrees/perf-t3-idle` (branch `perf/t3-idle-timeout`, no commits).
- Edge caching of `/api/` stays bypassed (Cloudflare rule) — not in scope.
