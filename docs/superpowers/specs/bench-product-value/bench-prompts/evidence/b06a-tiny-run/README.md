# B06a — `_tiny` live run, both placement legs

Run 2026-09-10 against a local prod build at commit `9f3924a8e` (the tree as
it stands at the end of B06a task 9). Both legs use `--wipe`, which
`_RULES.md` §2 requires: a reuse-mode leg schedules nothing and would prove
nothing about the solver.

```
npm run bench:scheduler -- --suite _tiny --engine optimized --wipe   # leg A
# placement service stopped, port confirmed empty
npm run bench:scheduler -- --suite _tiny --engine greedy    --wipe   # leg B
```

Both legs write into one report directory (it is keyed by the commit SHA), so
`report.json`/`report.md` are per-RUN and the second leg overwrites the first.
Leg A's pair was copied out before leg B started; each leg's own
`engine-<engine>.json` survives both, and leg B's `report.json` carries the
`engineDelta` comparing them.

## The environment, and how each piece was proven

Stood up with the `seazn-local-env` skill under label `b06a`, pinned to the
worktree (never the main checkout, never :3000, never the dev DB).

| piece | port | how it was proven |
|---|---|---|
| Postgres | 54856 | `show data_directory` returned OUR datadir — the check that exists because `pg_ctl` can fail with "Address already in use" while the very next `createdb` SUCCEEDS against a foreign cluster |
| schema | — | `db:apply` **and** `sync:sports` (v400). `db:apply` alone is not a fresh schema |
| placement (CP-SAT) | 50302 | native, `lsof -sTCP:LISTEN` confirmed the listener was ours before leg A, and confirmed EMPTY before leg B |
| app server | 3374 | standalone build, assets verified, `/api/health` 200. Its `required-server-files.json` `appDir` points at THIS worktree — not a same-hash cache replay of another worktree's build |

Three environment faults were hit and cleared on the way. None was a code
defect, and each is the kind that reads as one:

1. Both `.env.local` symlinks were missing from the worktree. Left alone,
   ~1772 DB tests skip themselves while `total` stays unchanged — only
   `pending` moves, so the run looks identical to a green one.
2. `up --all` was reaped mid-run during the first-ever `ortools` import warm.
   Postgres and placement had already come up, so the remainder was run as
   separate shorter invocations rather than restarting the world.
3. That reaped run left a stale zero-byte `apps/web/.next/lock`, and the next
   build died with "Another next build process is already running." No build
   process existed anywhere — verified before the lock was removed.

## What the first live run found

Leg A's FIRST attempt was RED, with one error:

```
oracle: per-match mismatch in "d-tiny" fixture "se-r0-i0"
  — status: expected decided, got scheduled
```

Stage advancement ran AFTER the outcome oracles, so the per-match comparator
read `_tiny`'s playoff fixture while it was still `scheduled`. The PRODUCT was
correct — the same run's `final_ranks`, `rank crossing` and `champion` oracles
all passed on that same fixture moments later. The bench asserted too early.

**No suite-level test could have caught it.** All four suite fakes drive
`echoExpectedBoard`, which answers whatever the pack expects BY CONSTRUCTION —
that helper's documented vacuity. 1474 green tests said nothing about it, and
this is exactly the class of gap a live run exists to close.

Fixed in `9f3924a8e` by moving advancement above the outcome oracles (fold
everything, then assert) and pinning the new order in
`tiny-suite-simulate.test.ts`'s oracle-ORDER assertion, so a drift back
reintroduces a failing test rather than a silent red.

## Results

Both legs: **gate green, zero errors, zero blocking conflicts, checker clean
on every division.** 45 oracles, 13 explicit `pass`, 2 `no_subject`
(reported as such, never disguised as passes), 0 `fail`.

| | leg A (`optimized`) | leg B (`greedy`) |
|---|---|---|
| d-tiny | actual `optimized`, `solverStatus: ok` | actual `greedy`, **`solver_unavailable`** |
| d-badminton | actual `greedy`, `already_optimal` | actual `greedy`, `solver_unavailable` |
| d-tiebreak | actual `optimized`, `solverStatus: ok` | actual `greedy`, `solver_unavailable` |

`d-badminton`'s `already_optimal` in leg A is the solver answering that the
greedy board could not be improved — a real solver verdict, not a fallback.

Every B06a oracle passed in BOTH legs, which is the point of running both: an
oracle that passed only with the solver live would be reading the solver
rather than the product.

| oracle | verdict | detail |
|---|---|---|
| `d-tiny per-match results` | pass | 4 checked, 0 mismatched |
| `d-badminton per-match results` | pass | 1 checked |
| `d-tiebreak per-match results` | pass | 3 checked |
| `specials` | pass | 1 special, 5 claims checked, 0 unsupported |
| `people: claim invites accepted` | pass | 2/2 accepted by the INVITED address |
| `people: an invalid claim token is refused` | pass | a same-shape never-minted token drew HTTP 401 |
| `people: an accepted invite is closed` | pass | both stopped reading back as open |
| `people: invites past the limit stay unclaimed` | pass | 2 untouched, still open |
| `people: a claimed profile still reports the same stats` | pass | 2 profiles unchanged by being claimed |
| `news: folding drafted posts` | pass | 15 drafts after the folds |
| `news: the named fixtures publish and the rest stay draft` | pass | 1/1 published, 14 still draft |
| `news: a republish does not move published_at` | pass | the timestamp held |

The three report lines that had fields and no writer before this wave now
render:

```
- Provenance: 75% real (6/8 streams; 2 reconstructed)
- Claims: 2/4 invites accepted
- News: 1/15 drafted posts published
```

### Where the numbers differ from the plan, and why

The plan's task 9 expected "claims 3, news published 3". The live numbers are
**2** and **1**, and both are correct — the plan guessed before the build:

- **Claims 2 of 4.** The design accepts the PLAYER invites (`p-ana`, `p-cho`)
  and deliberately leaves the two officials' invites untouched, because what
  stays unclaimed is what makes "an unclaimed invite still exists" provable
  rather than assumed. `skipped: 2` is the design working.
- **News 1 of 15.** The run publishes the LAST stage's fixtures for
  `division0`, and `_tiny`'s playoff stage has exactly one. The other 14
  drafts staying draft is half of what the news step proves; a run that
  published all 15 would have demonstrated nothing about the draft state.

## Warnings (6, all legitimate, none a gate)

Five are stage 0 naming what it does NOT derive offline —
`leaderboards`, `champions`, `finalRanks`, `careers`, `suspensions` — each
because the value is the product's answer rather than the fold's. The sixth
records that `d-tiny` declares two stages while B04 schedules one per
division. All six are reported by design; a gate that read them would red
`_tiny` on every run for saying something true.
