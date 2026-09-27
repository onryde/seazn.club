# T1 review — commit 0827dc0dd (V418 + leaders + smoke)

Reviewer, 2026-09-24. Read-only review against
`2026-09-24-public-hub-query-perf.md` (T1 row + Decisions), `AGENTS.md`, and
`RULES.md` owner checklist (TEST-CASE DESIGN rows). Tests were NOT run by the
reviewer (no local test DB owned by this session); everything below is by
read, with the planner claims reasoned from PG source behaviour, not measured.

**Verdict: Approved** — output parity holds by construction for both the view
and the leaders reader, the call-count tests have teeth and are deterministic;
the findings are all Minor.

## 1. Spec compliance

| Brief item | Result |
|---|---|
| Newest prior `public_entrants_v` | V416 (`deltas/V416__division_show_seeds.sql:31`), found by grep -a across all four migration dirs; no later definition anywhere (V417 on another branch does not touch it). |
| V418 body vs V416 | Textual diff of the two statements: exactly three hunks — both `org_has_feature(...)` arms replaced by `f.profiles_on`, plus the `cross join lateral (… offset 0) f` at `V418:77`. Columns, order, `show_seeds` seed rule, member ORDER BY, `merged_into` tombstone, `public_person_name` masking, team_display, badge_url, visibility gate: all byte-identical. |
| Grants / options | `create or replace` keeps V239/V242 grants and ownership. No `alter view public_entrants_v set (…)` exists anywhere (no `security_invoker`/`security_barrier` to lose). Column list unchanged, so `create or replace` is legal. |
| Dependent views | None: every other migration mention of `public_entrants_v` is a comment or a grant. |
| NULL semantics | `consent AND NULL` → CASE falls to ELSE null in both versions; unchanged. |
| Leaders stops building `members` | Yes, `public-leaders.ts:81-107`. |
| `fixtures(division_id, round_no, seq_in_round)` index | Added, `V418:89`. |
| `competition_passes(competition_id, org_id)` index | Skipped — **sanctioned**: `competition_id` is the PK (`V271__competition_passes.sql:7`); recorded in the T1 row and the V418 header. |
| Output identical | Yes (view: DIFFERENTIAL test + textual diff; leaders: parity argued below). |

### Leaders parity (item 2)

Old `published` = the person's id appears in the chosen entrant's `members`,
i.e. person is a member of `en` AND `p.merged_into is null` AND
`public_name` consent AND the entitlement for `en`'s competition. New =
`public_name` consent (outer `p`, same row since `p.id = ps.person_id =
em.person_id`) AND the CTE's entitlement for `ps.division_id`'s competition
(same competition, since the lateral pins `en.division_id = ps.division_id`),
reached only when the lateral found a member row. The tombstone gate is the
outer `persons` join in both. Equivalent in every consent × entitlement cell.

Youth / `player_name_display`: no rule is dropped. The old path never used any
member NAME — only the `person_id` arm, which has no youth term in the view.
Youth and name policy are applied downstream and unchanged:
`leaders.ts:345` (`playerLinkId(row.public_profile ? … : null, division)`) and
`maskPublicEntrantNames` at `public-leaders.ts:130`.

PARITY (`public-leaders.test.ts:518`) ties to the live view (reads
`public_entrants_v … jsonb_array_elements(members)` per state), not a copied
constant, and additionally pins each cell — both directions covered.

## 2. Strengths (load-bearing only)

- The DIFFERENTIAL reads V416's body from the shipped migration file and runs
  it against the current schema, in both entitlement states, comparing
  `to_jsonb` of every row — a real regression oracle, not a hand copy.
- The call-count tests have teeth: reverting the view (5 > 2), deleting
  `offset 0` (5 > 2), or restoring the `members` lookup in the leaders reader
  (32 ≠ 1) each go red; the view CALLS test carries its positive pair (V416
  body must show exactly 5), so a counter that reads 0 cannot pass.
- The GRANTED seed deliberately makes squad order disagree with name and
  insertion order, and splits name vs photo consent (Abel) so an arm reading
  the wrong key fails.

## 3. Issues

### Critical
None.

### Important
None.

### Minor

- `V418:22-25` + `public-entrants-entitlement-once.test.ts:77`: the stated
  trade (an entrant with NO consenting member now costs one call where V416
  cost zero) is never witnessed — both seeded entrants have consenting
  members, and no entrant has an empty roster, so the checklist's empty-set
  row is absent. Correctness is not at risk (the lateral always yields one
  row, and `now.length === ROSTERS.length` would catch a lost row), but in a
  youth division where nobody consents this query gets slightly SLOWER
  (≈0.1 ms × entrants), which the owner may want to know. Fix: add a third
  entrant with an empty roster and a fourth whose members all refuse, include
  them in DIFFERENTIAL, and in CALLS assert V416 = 0 extra for them while V418
  stays ≤ entrant rows — so the trade is pinned, not just prose.
- `public-leaders.ts:83,101-102`: the publication rule (the `public_name`
  consent key + the `'dashboard.player_profiles'` literal) now lives in two
  places, the view and this reader — the "one authority per fact" row. PARITY
  is the tripwire, but only for the cells it enumerates (non-youth division);
  a future view-side change to the person_id arm (e.g. a youth term) would not
  red it. Fix: name `public-leaders.ts` as a second copy in V418's header (it
  is unapplied, so amending is fine) and/or add a youth-division cell to
  PARITY.
- `public-leaders.test.ts:587-644`: CALLS claims "once per division" but seeds
  one division, so it cannot tell per-division from per-query. It does catch
  the real regression (per leader row). Fix (optional): seed a second division
  and assert `calls === 2`.
- `V418:89`: plain `create index` takes a SHARE lock on `fixtures` inside
  Flyway's transaction (which also holds the view's AccessExclusive lock),
  blocking fixture writes for the build. Table is tiny today — note only, do
  not block. Not redundant: `fixtures_division_idx` is
  `(division_id, scheduled_at)`, `fixtures_stage_idx` leads with `stage_id`,
  `fixtures_division_no_key` is `(division_id, fixture_no)`.
- Flyway sequencing (no file line): V418 is unique across all refs and all
  on-disk worktrees, but V417 exists only on unmerged
  `feat/printable-scorer-sheets` (`V417__device_link_sealed_secret.sql`), and
  `db/flyway.toml` has no `outOfOrder`. Whichever of the two lands second
  after the other is applied must renumber, or `migrate` refuses the lower
  pending version. Tell the scorer-sheets session; nothing to change here.

## 4. Gap hunt

- **Siblings of the leaders pattern.** `usecases/me.ts:341` still does the
  exact per-row `exists (… jsonb_array_elements(en.members) …)` lookup the
  leaders reader just removed, once per stat snapshot row. It gets V418's
  saving automatically (per entrant instead of 2 per member) and is an
  authenticated `/me` path, not the hub — out of T1 scope, but the same
  one-line fix applies if `/me` ever shows in `pg_stat_statements`.
  `usecases/player-stats.ts:775` (once per division) and
  `public-site/data.ts:1475` (player card, once per competition) are fine and
  also benefit from V418.
- **Tests that parse "the newest definition".**
  `components/public-site/__tests__/standings-withdrawn-wiring.test.ts:66-120`
  now picks V418 as the newest `public_entrants_v`. By read it still passes:
  its extraction regex stops at the final `;` (the in-body comment's `;` at
  `V418:76` is not end-of-line), and V418 carries `e.status`, the visibility
  gate, and no status filter. Not run — include it in the gate.
- **Unused-output claim.** "A reader that does not select `members` pays
  nothing" relies on `remove_unused_subquery_outputs`, which only drops a
  non-volatile output; `org_has_feature` is STABLE, and the view CALLS test
  pins the 0. If the function is ever marked VOLATILE, that assertion is the
  tripwire — good.
- **Call-count determinism.** Deltas inside one `sql.begin`: PG only flushes
  pending function stats when the backend is idle OUTSIDE a transaction
  block, so no flush can land between the two reads; stats are
  backend-local, so parallel vitest workers cannot interfere. `set local
  track_functions` needs superuser (PGC_SUSET) — CI's DATABASE_URL is
  `postgres:postgres` on PG16 (`ci.yml:553/931/1202`), so fine; it would fail
  under a non-superuser test role. Bounds (`1 ≤ after ≤ entrants`) tolerate
  the lateral landing per competition vs per entrant row under a different
  join order. No flake vector found.
- **Cache invalidation.** Output is unchanged, so no public cache key needs
  a bump. Correct as shipped.
- **Smoke (`scripts/smoke.ts:3182-3201`).** Follows the suite's pattern
  (`v1(newSession(), …)`, `v1data`, `check`), reads only (creates nothing, so
  no cleanup owed), the entrants cache key is first touched after the pass
  and roster exist, and both checks are non-vacuous (an undefined member
  fails both). It passes on V416 too — it is a regression pin, not the test
  that fails without the change; the CALLS tests are that.
