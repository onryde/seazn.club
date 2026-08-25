# P11 — batch score-event import: design of record

Date: 2026-08-25. Session: **P11** (portfolio index, D6 row — the last row).
Status: **approved by owner in brainstorm, 2026-08-25**; build proceeds from
this file, not from `P11-batch-import.md`.

This supersedes the prompt file and the 2026-08-13 design
(`bench-product-value/designs/2026-08-13-batch-event-import-design.md`)
wherever they disagree. Both were authored before ScoringPad S12/S13 moved
this surface. §2 lists what they got wrong.

## 1. Purpose (unchanged from D6)

Two customer cases, ratified by the owner after a "why do we need this"
challenge:

- **A club joining with history.** Career pages are empty until seasons
  accumulate. Import fills them on day one.
- **Paper-scoring catch-up.** Scored at the venue offline, typed in later.

Standing rulings: **JSON only** (no CSV mapping UI), **finished matches
only** (no bulk append into live fixtures).

## 2. False premises in the inherited documents (found at re-pin)

Recorded as discovered, per `_RULES.md` §5.

1. **`recomputePlayerStats` / `personCareerStats` are NOT decided-fixture
   side effects.** The prompt lists them in the chain the import must
   inherit. They have **zero** call sites in `scoring.ts` or
   `append-event.ts`; they are recompute-on-read, invoked lazily from
   `divisionPlayerStats` / `personStats` / `publicDivisionStats`
   (`apps/web/src/server/usecases/player-stats.ts:298,371,537`). Nothing
   about stats is inherited. The careers-day-one claim is still provable —
   through the read path, which is where regression (b) now asserts it. A
   test that waited for a fire would have passed vacuously forever.
2. **The hash chain is not application code, and it cannot be compared
   across twins.** `appendEvent` never computes a hash. `prev_hash` and
   `row_hash` are written by a `before insert` trigger,
   `db/migration/v2-engine/functions/V226__hash_chain_functions.sql:10,14-31`.
   Two consequences, both of which invalidate what the prompt and the D6
   spec ask for:
   - The chain fires for **any** insert into `score_events`, including one
     from a hypothetical second writer. Chain integrity therefore proves
     nothing about code reuse.
   - The canonical string hashed is
     `id | fixture_id | seq | type | payload | voids | recorded_by | recorded_at`
     (V226:21-25). An imported fixture has different event ids, a different
     `fixture_id` and a different `recorded_at` from any twin, so
     **"a hash chain byte-identical to a sequentially-scored twin" is
     impossible by construction** — not merely hard. §9 replaces that
     assertion with one that can actually hold and actually bites.
3. **`scoring.ts:81` (the prompt's pin) is stale.** The current entry point
   is `scoreEvent` at `apps/web/src/server/usecases/scoring.ts:82`, and the
   transactional writer under it is
   `appendEvent` (`apps/web/src/server/engine-db/append-event.ts:131`).
4. **There is no `FeatureKey` TypeScript union.** `hasFeature`,
   `requireFeature` and `requiredFeatureForEvent` all type the key as plain
   `string`; "FeatureKey" is a comment convention. The plan→feature catalog
   is SQL-seeded rows in `plan_entitlements`
   (`db/migration/deltas/V112__entitlements_v2.sql:21`), and per-org grants
   already exist in `org_entitlement_overrides`, resolved ahead of the plan
   row. Adding a key is a seed row, not a type edit — and during rollout
   (R5/R6) `import.events` gets **no `plan_entitlements` row at all**: a plan
   row would grant it to every org on that plan, which is the opposite of
   staff-only. The key exists only as a per-org override until the owner
   decides which plan carries it. That absence IS the gate.
5. **`fixtures.ext_key` is unique per STAGE, not per division**
   (`fixtures_stage_ext_key_idx`, `V214__fixtures.sql:32`). The D6 format's
   `{ext_key}` reference is therefore ambiguous within a division by
   construction. §4 rules on it.

## 3. Owner rulings taken in this brainstorm (2026-08-25)

| # | Question | Ruling |
|---|---|---|
| R1 | Does import inherit live scoring's division-phase gate? | **Yes — require the division started.** No second phase policy on the scoring surface. |
| R2 | `core.void` inside an import stream? | **Rejected at schema.** A paper sheet is corrected before it is typed; a wrong stream is re-imported under a new `import_id`. |
| R3 | How to get one transaction per fixture from a per-event writer? | **Extract a shared internal** (`appendEventInTx`). Not a second writer, not a per-event commit loop. |
| R4 | Size caps, given the quadratic re-fold | **50 streams / 1 000 events per fixture / 10 000 events per call.** |
| R5 | Who can import? | **Org admin**, staff-only during rollout. |
| R6 | What gates rollout? | **An entitlement key**, `import.events` — not an env flag, not a code flag. |
| R7 | Receipt row lifetime | **Cascade** on division and fixture delete (see §5). |
| R8 | Page location | **Own directory**, `d/[divSlug]/import/`, following `schedule/`. |

R6 also answers a CI problem: `.github/workflows/e2e.yml` contains no flag
reference at all, so a flag-gated surface gets no dedicated coverage. An
entitlement grant is reachable from e2e fixture setup, so the covered path
is a project that actually runs.

## 4. API

`POST /api/v1/divisions/{id}/events/import` — org admin, gated on
`import.events`. Returns **200 whenever the call executed**; per-stream
outcomes are data, not transport errors.

```ts
{ import_id: string,
  streams: Array<{
    fixture: { id: string } | { ext_key: string },
    events: Array<{ type: string, payload: unknown, at?: string }> }> }
```

`seq` is assigned server-side, 0..n. The caller never sends one. `core.void`
is rejected by the request schema (R2).

Response — the admin page renders it verbatim; there is no separate report
store, and re-running the call idempotently is how the report is seen again:

```ts
{ importId, totals: { imported, skipped, rejected },
  results: [ { fixture, status, eventsAppended, outcome?, error? } ] }
```

`status ∈ imported | skipped_duplicate | rejected`.

### Per-stream execution order

0. **Replay check first.** Read the receipt for `(division, import_id,
   fixture)` before anything else and return `skipped_duplicate` on a hit.
   Discovered at implementation, 2026-08-25: an already-imported fixture has
   events, so any later placement makes every replay report
   `import.fixture_started` instead.
1. **Resolve the fixture.** `{id}` directly. `{ext_key}` is searched across
   the division's fixtures: exactly one match proceeds; zero or more than
   one rejects with `import.fixture_unknown` carrying the match count (§2.5).
2. **Guard unstarted.** Any existing `score_events` row, or a live/decided
   status → `import.fixture_started`.
3. **Entitlement per event type**, before the fold (corrected 2026-08-25:
   this step and the next were originally listed the other way round; an
   unentitled org should not pay for a fold it can never write, and both
   steps precede any write either way):
   `requiredFeatureForEvent` (`fidelity.ts:22`, pure — module + type in, key
   or null out) then `requireFeature`. A free org importing tier-3 events
   gets `import.entitlement` naming the missing key.
4. **Dry-run fold. No writes.** Fold the whole stream through the division's
   pinned module with the resolved cfg. Engine refusal →
   `import.fold_rejected` with `{eventIndex, engineCode}`. A stream that does
   not end decided → `import.not_decided`.
5. **One transaction per fixture.** `appendEventInTx` in a loop for seq
   0..n; the receipt row is inserted in the **same** transaction. Any throw
   rolls the fixture back to zero rows.
6. **After commit**, the decided side effects exactly as live scoring fires
   them: `onDecided` (slot fill, standings), `refreshDiscipline`,
   `refreshNews`. `captureServer` fires once if the stream crossed the
   no-result→result line.

Streams run **sequentially** within a call — bounded, predictable load.
Callers parallelise across calls; the help page says so.

### Call-level behaviour

- Concurrent calls with the same `import_id` → **409 `import.concurrent`**,
  via a **lock row**, not a Postgres advisory lock (owner ruling, 2026-08-25 —
  see §5.1). An advisory lock is held by a *session*, so its cross-process
  guarantee silently evaporates under a transaction-mode pooler, which may
  reassign the physical backend between the lock and the unlock. The lock is
  therefore data: it survives pooler reassignment, needs no reserved
  connection, and cannot leak a pool slot for the length of a call.
- Replay of a completed import reads the receipt rows and returns
  `skipped_duplicate` per stream: zero appends, **side effects not re-fired**.
- Caps (R4) → **413 `import.too_large`**, naming which ceiling was hit and
  its value.
- Division not started (R1) → call-level **409 `import.division_not_started`**
  carrying the division status. This code is **new** — the D6 spec's list
  predates R1.

### Rejection codes

`import.fixture_started` · `import.fixture_unknown` · `import.fold_rejected`
· `import.not_decided` · `import.entitlement` · `import.slots_unfilled`
(D4 TBD fixture) — per stream. `import.too_large` (413) ·
`import.concurrent` (409) · `import.division_not_started` (409) · 403
non-admin · 402 without `import.events` — call level.

## 5. Data model — migration V376

V375 is the highest on main and no worktree has claimed V376 (all eight
checked). Re-verify the next free number at execution; mid-wave collisions
have happened in this repo.

One table. It is a **receipt**, not a report store.

```
event_imports
  id              uuid primary key
  org_id          uuid not null → organizations(id)
  division_id     uuid not null → divisions(id)  on delete cascade
  import_id       text not null
  fixture_id      uuid not null → fixtures(id)   on delete cascade
  events_appended int  not null
  imported_by     uuid null
  imported_at     timestamptz not null default now()

  unique (division_id, import_id, fixture_id)
  index on org_id, division_id, fixture_id
  row level security enabled + forced; policy org_id = current_org_id()
```

- **The UNIQUE index is the idempotency guarantee.** Not application code.
  A unique violation on insert means "already imported" and converts to
  `skipped_duplicate`.
- **Cascade, not `on delete restrict`** (R7). P8 used `restrict` because a
  venue must not vanish under scheduled fixtures. A receipt is not that: if
  the fixture is deleted the receipt is meaningless, and `restrict` would
  mean an organiser cannot delete an imported fixture without a support
  ticket.
- Tenant scoping follows V367's composite-FK pattern **if** `divisions`
  carries the matching `(id, org_id)` unique key. That is to be verified at
  execution, not assumed — asserting a constraint that is not there is how
  the placer/verifier fork survived two waves. Fall back to a plain FK plus
  the RLS policy.
- `supabase-postgres-best-practices` loads before the DDL is written.

### 5.1 The lock row

Concurrency control lives in the same migration, and deliberately does not
depend on how the app connects to Postgres:

```
import_locks
  division_id  uuid not null → divisions(id)      on delete cascade
  import_id    text not null
  org_id       uuid not null → organizations(id)  on delete cascade
  holder       uuid not null          -- random per call
  acquired_at  timestamptz not null default now()
  expires_at   timestamptz not null

  primary key (division_id, import_id)
  row level security enabled + forced; policy org_id = current_org_id()
```

**Acquire** is one atomic statement — take the lock, or take over one that has
expired, or come back empty:

```sql
insert into import_locks (division_id, import_id, org_id, holder, expires_at)
values ($1, $2, $3, $4, now() + interval '30 minutes')
on conflict (division_id, import_id) do update
  set holder = excluded.holder, acquired_at = now(), expires_at = excluded.expires_at
  where import_locks.expires_at < now()
returning holder
```

Zero rows returned means a live holder → **409 `import.concurrent`**.

**Refresh** between streams (`update … set expires_at = now() + interval '30
minutes' where … and holder = $4`) keeps a long call's lock alive. A refresh
inside the write transaction would be invisible to other callers until commit,
so it happens between streams, never inside one.

**Release** in a `finally`: `delete … where … and holder = $4`. The `holder`
predicate means a call can only ever release its own lock, so a stale takeover
followed by the original's late release cannot free someone else's lock. A
release that throws is logged and swallowed — an import that committed must
report success even if letting go of its lock failed.

**Why a TTL and not a heartbeat:** a crashed process leaves a row behind, and
the TTL is what lets the next caller proceed. Takeover is safe even if it is
premature: the `event_imports` unique index still refuses a double import, and
the unstarted-fixture guard still refuses a fixture that already has events.
The lock is an ergonomics feature — it turns a race into a clean 409 — while
**correctness rests on the unique index**, which no pooling mode can weaken.

## 6. The writer extraction

Today `appendEvent` (`append-event.ts:131`) is `withTenant(orgId, callback)`
plus a PostHog capture outside the transaction. Split at exactly that seam:

- **`appendEventInTx(tx, orgId, fixtureId, expectedSeq, input)`** — the
  existing callback body, moved verbatim: advisory lock → seq check → prior
  event read → `resolveFixtureCfg` → snapshot freeze on the first event →
  `foldMatch` with `strictFromSeq` → draw-not-allowed guard → event insert →
  `match_states` upsert → `fixtures.status/outcome` write → `pg_notify`.
  Returns `{appended, firstResult}`.
- **`appendEvent`** — unchanged signature; now `withTenant` + that call +
  the capture.

Nothing is rewritten and nothing moves between steps. Live scoring's
existing tests must stay **byte-green**; that is the reviewer's first check,
alongside diffing the import's write path against `scoreEvent`'s to prove no
second append path was born.

Import opens one `withTenant` per fixture, calls the internal for seq 0..n,
inserts the receipt in the same transaction, and fires `captureServer` once
after commit.

Two consequences accepted deliberately:

- **`pg_notify` fires per event during an import.** Suppressing it needs a
  parameter that makes the writer behave two ways — the fork this repo keeps
  re-learning. The fixture is unstarted; nobody is listening.
- **The cfg snapshot freezes on the stream's first event**, exactly as it
  would for a sequentially-scored twin. That is *why* the twin's hash chain
  comes out byte-identical.

### Why the caps are what they are

`appendEventInTx` re-reads every prior event and re-folds the whole stream on
each append, so a stream of n events costs O(n²) folds. Real streams:
football ≈ 30 events, tennis point-by-point ≈ 250, T20 ball-by-ball ≈ 300.
The D6 spec's "50 streams / 50 000 events" was written without the quadratic
in view: a single 50 000-event stream folds on the order of a billion times
inside one transaction holding an advisory lock — a hung request, not a
rejection. R4's per-fixture ceiling of 1 000 covers every real sport with
headroom and bounds the worst case per call.

## 7. UI — division import page

`apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/import/page.tsx`,
sibling to `schedule/` (R8 — an admin-bar surface has no business growing
the console's 685-line `page.tsx`). Auth and org scoping via
`requireDivisionPage` (`page-auth.ts:208`). Feature absent → `notFound()`,
and the console shows no link: during rollout the surface is invisible to
orgs without the grant. The route is the authority and answers 402
regardless of what the page does.

Functional bar only (`/admin`-grade, standing rule) — no design polish owed:

- One screen. A `.json` file picker and a paste textarea feed the same
  state, so what is about to be sent is always visible.
- Client-side `JSON.parse` before submit: a malformed file is a local error,
  not a round trip.
- The response renders verbatim as the report table — fixture (linked),
  status, events appended, outcome, error — plus a totals row.
- Status is a **text** chip (`imported` / `skipped (duplicate)` /
  `rejected`); colour reinforces, never carries the meaning alone.
- The textarea keeps its contents after submit: re-running is the
  "show me that report again" path.

Responsive: the report table scrolls inside its own `overflow-x: auto`
container; the page never scrolls horizontally at 320. Screenshots at
1280 / 320 / 768.

## 8. Strings and help

**i18n ×4** (en, es, fr, nl), flat dotted keys, then `i18n:gen-keys`
regeneration — `i18n-keys.ts` is generated, so a missing regen reds the
drift gate. Page copy plus a code→message map for every rejection code in
§4. The server stays English and returns **codes**; the client localises
them. `import.fold_rejected` interpolates `eventIndex` and `engineCode` so
an operator can find the offending line in their own file.

**Help**: one English-only page under `apps/web/content/help/`
(filesystem-routed, `help-content.ts:90` — no manifest to edit) covering the
JSON shape with a worked per-sport example, server-assigned `seq`, no voids,
the three caps and how to chunk, the idempotency contract (same `import_id`
replays as `skipped_duplicate`; a corrected file needs a new one), and the
ordering constraint R1 creates: **start the division before importing**.

## 9. Tests — all four types

**Unit** (`apps/web/src/server`): dry-run gate (invalid event at index k →
whole stream rejected and **zero** `score_events` rows, asserted by count,
not by the response); unstarted-fixture guard; division-not-started;
entitlement rejection naming the missing key with no writes; each of the
three caps → 413 naming its ceiling; `core.void` rejected at schema;
`ext_key` matching two stages → `import.fixture_unknown` with count 2.

**Regression** — the session's core:

- **(a) Twin — derived state, not hashes.** Build a division whose league
  meets the same two entrants twice, so fixtures A and B share entrant
  identity. Score A event-by-event through `scoreEvent`; import the
  identical stream into B. Assert equality of everything the *writer*
  derives: `match_states.summary`, `match_states.last_seq`,
  `fixtures.outcome`, `fixtures.status`, `fixtures.config_snapshot`, and a
  gapless `seq` 0..n. A second append path that forgot the snapshot freeze,
  the status write, or the `match_states` upsert fails this immediately.
  Hash **equality** is deliberately not asserted (§2.2 — impossible);
  chain **integrity** is asserted separately, by recomputing
  `v2_row_hash(prev, canonical)` over the imported rows in SQL and checking
  each row links to its predecessor. That catches a future bulk insert that
  bypasses the trigger, which is a different failure from the one the twin
  catches.
- **(b) Careers day one.** Import a finished fixture, then read
  `divisionPlayerStats` and `personStats` and assert the imported history
  appears. A **read-path** test by design (§2.1).
- **(c) Replay.** Snapshot `score_events`, `match_states`, `fixtures`,
  `event_imports`; replay the same `import_id`; assert every row identical
  and every stream `skipped_duplicate`. Side effects must not re-fire —
  asserted by the news-draft count staying put.

**E2E**: new `events-import.spec.ts` (parallel project, CI-live) — upload →
report table with one imported and one rejected row, assertions anchored on
`="` (a bare `data-*` probe passes in both states because React serialises
an omitted prop as `"$undefined"`). The page is **also** added to
`mobile.spec.ts`: a surface absent from it has zero width coverage no matter
how many other specs touch it. The e2e org gets `import.events` through the
existing `setBoolEntitlementOverrideSql` helper (`e2e/helpers.ts:342`).

**Smoke**: a new section in `scripts/smoke.ts` — grant the feature, import
one finished match, assert outcome, stats and the auto-drafted news post all
appear. Smoke CI is PR-only, so this runs on the PR.

## 10. Logging

pino (`log` from `apps/web/src/server/logger.ts:23`), one named event:

```
events_imported { division, import_id, streams, appended, rejected, ms }
```

`ms` is not in the D6 spec. It is what turns R4's cap from a guess into the
report-driven number that spec asks for and, without a recorded timing,
could never produce.

## 11. Verification

```bash
npx vitest run --reporter=json --outputFile=/tmp/p11.json apps/web/src/server
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p11.json
rtk proxy npm run lint          # read "✖ N problems"
npm run openapi:gen && git status --porcelain
npm run i18n:gen-keys && git status --porcelain
```

A `PASS(0) FAIL(0)` rtk summary means the suite failed to **collect**, not
that it passed. DB-backed suites need a fresh test schema: `db:apply` **and**
`sync:sports`, never the local dev DB. All commands run with the worktree as
cwd in the same invocation — a verify launched from a worktree can otherwise
execute against `main` and return a false green.

## 12. Non-goals (unchanged)

No CSV or spreadsheet mapping UI. No live-fixture bulk append. No
cross-division import in one call. No import of persons or entrants — that
is seeding, owned by existing flows. No export; it exists elsewhere.
