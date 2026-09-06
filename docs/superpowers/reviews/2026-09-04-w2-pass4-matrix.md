# W2 pass 4 — migrations V393–V398 and the entitlement matrix

Branch `feat/entitlements-w2-matrix-plumbing` at `12c124211`, working tree clean.
Scope: `db/migration/deltas/V393..V398`, `lib/entitlements*.ts`, `lib/feature-copy.ts`,
`server/usecases/competitions.ts`, `server/usecases/officials.ts`,
`server/usecases/entitlement-freeze.ts`, the matrix-pinning tests.

Live matrix read from `postgresql://postgres@127.0.0.1:54788/seazn_entw2`, schema
`seazn_club`. `flyway_schema_history` tops out at 397, all `success = t`; `plans`
holds `community / pro / enterprise(is_public=f) / event_pass / event_pass_l` and
no `pro_plus`. The DB agrees with the files.

**Verdict: Needs fixes.** 1 Critical, 2 Important, 6 Minor, 1 Plausible.

---

## CONFIRMED — Critical

### C1. `discipline.enforced` was granted to the Event Pass and wired into exactly one of its seven gates — and the paywall now sells the pass at the six that still refuse it

`db/migration/deltas/V393__entitlements_v18.sql:89-92` turns `discipline.enforced`
TRUE on `event_pass` and `event_pass_l`; the key is FALSE on `community` (verified in
the live matrix). The Event Pass overlay in `apps/web/src/lib/entitlements.ts:363-405`
fires only when a `competitionId` is passed, so an org-wide read of this key can never
see the pass.

One call site learned that. `apps/web/src/server/usecases/match-reports.ts:291` resolves
`competitionForDivision(a.division_id)` first, and its own header at `:257-262` states
the rule: *"a gate on a key V393 lifts (`discipline.enforced`) that omits it makes the
pass INVISIBLE — the org pays $29 and is refused on the competition it bought."*

Six do not, all of them behind the module-local constant at
`apps/web/src/server/usecases/discipline.ts:23` (`const FEATURE = "discipline.enforced"`),
which is why a literal-string sweep of the tree misses them:

| site | function | has a division id in hand |
|---|---|---|
| `discipline.ts:470` | `getDisciplineRules(auth, divisionId)` | yes |
| `discipline.ts:483` | `putDisciplineRules(auth, divisionId)` | yes |
| `discipline.ts:509` | `listSuspensions(auth, divisionId, …)` | yes |
| `discipline.ts:530` | `createManualSuspension(auth, divisionId, …)` | yes |
| `discipline.ts:559` | `decideSuspension(auth, id)` | via `suspensions.division_id` |
| `discipline.ts:675` | `suspensionsForFixture(auth, divisionId, …)` | yes |

`apps/web/src/lib/pass-features.ts:38` then adds `discipline.enforced` to
`PASS_FEATURES`, which `apps/web/src/components/upgrade-gate.tsx:228` reads to decide
whether to offer an Event Pass at a paywall. That same file's own comment
(`pass-features.ts:33-37`) states the ordering rule this violates: *"offering the pass
for a key whose gate still refuses it takes $29 and leaves the user exactly as blocked,
which is strictly worse than never offering it."*

**Failure scenario (constructible).** Free org, one competition C, buys a $29 Event Pass
for C.
1. A scorer submits a match report on C carrying a red card. `bridgeReportSuspensions`
   resolves C, the pass grants the key, and a **pending suspension row is written**
   (`match-reports.ts:291` onward).
2. The organiser opens C's division page. `page.tsx:110` calls `getDisciplineRules(auth, id)`
   → `requireFeature(orgId, FEATURE)` with no competition → community `false` → 402 →
   `disciplineGated = true` (`page.tsx:115`) → `page.tsx:715` renders
   `<UpgradeGate feature="discipline.enforced" />`, which — because the key is in
   `PASS_FEATURES` — offers them the Event Pass **they already own**.
3. `listSuspensions` (`:509`) and `createManualSuspension` (`:530`) 402 identically, so
   the pending suspension can never be confirmed, adjusted or waived.
4. `suspensionsForFixture` (`:675`) returns `[]` rather than throwing, so the scoring pad
   shows **no suspension warning at all** and the suspended player is selectable. The
   product records a suspension it then hides and enforces nowhere.

The write path is the one that was fixed and the read/decide paths are the ones that were
not, which is the worst ordering: rows accumulate where nobody can see them.

**Nothing catches this.** `pass-scope-w2.test.ts:226` is the only `discipline.enforced`
case in the wave and it is titled *"the report bridge raises a suspension on the passed
competition only"* — it exercises `match-reports.ts:291`, the one site that was already
correct.

**Fix.** Thread the competition into all six, exactly as
`officials.ts:456-476`/`device-links.ts:95-115` already do — a pooled
`competitionForDivision(divisionId)` resolved *before* `withTenant` opens (all six except
`decideSuspension` already have the division id at the call boundary). For
`decideSuspension`, resolve `suspensions.division_id → divisions.competition_id` on the
pooled proxy before the transaction. Then add a `pass-scope-w2.test.ts` case per surface —
a pass holder must be able to READ the rules and WAIVE a suspension on the passed
competition, and must still be refused on a sibling competition in the same org.

---

## CONFIRMED — Important

### I1. The pass comparison table dropped its player-profiles row on a justification V396 reversed three commits later

`apps/web/src/lib/pass-comparison.ts:57-63` removes the `upgrade.limit.profiles` row with
the reason *"entitlements v18 (V393): `dashboard.player_profiles` is now true on
Community, so the row showed the same tick on both sides."* That was true of V393.
`V396__public_by_default_and_share_loops_paid.sql:61-64` then sets the key back to
`false` on `community`, and the live matrix confirms it: community `false`, both pass
rungs `true`.

The same wave noticed the reversal in the sibling file and acted on it —
`apps/web/src/lib/pass-features.ts:55-63` explicitly says the key *"RE-ENTERS this set …
it left at V393 when community caught up, and the catch-up has been reversed."* Only
`pass-comparison.ts` was left behind.

**Failure scenario.** A Free org hits the public-player-profiles wall
(`server/public-site/data.ts:820` returns null for the competition, so the profile page
is gone). The upgrade gate offers an Event Pass, because
`pass-features.ts:63` puts the key in `PASS_FEATURES`. The buyer clicks through to the
pass comparison table — and the single row that would justify the purchase they are
being asked to make is not in it. Six rows, none of them player profiles.

**Why no test caught it.** `apps/web/src/lib/__tests__/pass-comparison.test.ts:130-146`
runs one way only: it asserts every row *present* shows a Free/pass difference (no
padding). Nothing asserts that a key where the pass genuinely beats community *has* a
row. The comment in `pass-comparison.ts:60-61` credits that test with catching the
removal, which it did — it cannot catch the restoration.

**Fix.** Restore the row (community `false` vs pass `true` now differs, so the existing
"no padding" case passes on it), and add the reverse-direction case: for every key in
`PASS_FEATURES` where `event_pass` beats `community` in the live matrix, either a
`PASS_COMPARE_ROWS` entry covers it or it is on an explicit, commented exemption list.

### I2. `dashboard.public.max` is completely bypassable by choosing `unlisted`, and this wave both tightened the cap and taught the organiser to reach for another visibility

`withinPublicQuota` (`server/usecases/competitions.ts:158-166`) counts
`c.visibility = 'public'` and nothing else. But `unlisted` competitions serve the identical
public dashboard: `V397__dashboard_theme_key.sql:75` keeps `public_competitions_v` at
`where visibility in ('public','unlisted')`, and `getPublicCompetition`
(`server/public-site/data.ts:436-441`) selects from that view with **no** visibility
filter of its own. `unlisted` differs from `public` only in `app/sitemap.ts:34` and the
`noindex` robots directive at `(public)/shared/[orgSlug]/[competitionSlug]/page.tsx:48-49`;
divisions, standings, live-now, player pages and the registration page all render.

Pre-existing (the old flat count was also `= 'public'`), but this wave makes it matter:
`V396:120-126` cuts Free 3 → **2** and Pro unlimited → **10**, and
`resolveCreateVisibility` (`competitions.ts:213-240`) now **degrades to private** and
returns a note naming the cap instead of refusing. The product therefore tells the
organiser, at the moment they hit the cap, that visibility is the dial to turn — and one
notch along that dial is an uncapped, fully public, link-shareable dashboard.

**Failure scenario.** Free org creates its third competition, gets
`public_quota_degraded` (`schemas.ts:186-194`) saying "your plan hosts 2 public
dashboards". The organiser PATCHes it to `unlisted` — `patchCompetition` reaches
`assertPublicQuota` only for a switch to `public`, so no quota check runs (`competitions.ts:463`) — and shares the
link. Repeat indefinitely. The cap the wave just halved meters nothing.

**Fix.** Either count `visibility in ('public','unlisted')` in `withinPublicQuota` and in
`assertPublicQuota`'s `excludeId` form (one edit, since both go through the same helper),
or record the exemption as a deliberate product decision in design §2 and pin it with a
test — so the next reader does not have to re-derive whether it was intended.

---

## CONFIRMED — Minor

### M1. V398's ladder guard cannot see a NULL rate, and a NULL rate charges 5%

`db/migration/deltas/V398__additive_platform_fee_rates.sql:74-76` filters
`(plan_key, int_value) not in (('community',5), …)`. A row-constructor comparison whose
first element matches and whose second is NULL yields NULL, not true, so `not in` is NULL
and the row is never selected. Verified against the live server:

- `('pro', 9)` → **CAUGHT**
- `('pro', null)` → **MISSED**

`feePercentFor` (`server/usecases/registrations.ts:90-93`) maps a null limit to
`platformFeeDefault()`, which `V398:40-42` documents as `platform_settings.platform_fee_percent`
= **5**. So the one shape the guard exists to catch — a plan row written elsewhere with
the "unlimited" idiom this schema uses everywhere else (`orgs.max_owned`,
`competitions.max_active`) — silently charges a Pro organiser 5% instead of 2% on every
entry fee, and the guard that was written to be loud about it says nothing.

**Fix.** `and (int_value is null or (plan_key, int_value) not in (…))`, or compare on
`coalesce(int_value, -1)`.

### M2. `V396:7` cites V391 for a header V391 does not have (renumber rot)

`V396__public_by_default_and_share_loops_paid.sql:7` — *"Resolver semantics this file is
written against, unchanged since V391's header."* `V391__official_availability_org_write.sql`
is nine lines granting `insert, update, delete on official_availability` and says nothing
about the resolver. The resolver-semantics header is `V393:14-20`, which V395 cites
correctly (`V395:8`). Same renumber rot pass 2 recorded. Repoint to V393.

### M3. `pass-vs-plan.ts`'s header table now misstates the L rung, and its rationale rests on the stale value

`apps/web/src/lib/pass-vs-plan.ts:12-20` prints `Event Pass L | **unlimited**` for
`entrants.per_division.max` and then argues from it: *"A Pro organiser running one
division with more than 256 entrants had no self-serve path at all."*
`V393:94` set the L rung to **512** and design §2:147 records `512`; the live matrix
agrees. With L finite, the organiser needing 600 entrants is back to having no self-serve
path — the exact gap the paragraph says the design closed. The file is unchanged on this
branch, so the table went stale under it. Code is unaffected (`passBeatsPlan` computes
from `plan_entitlements`; 512 > 256 still sells L to Pro).

### M4. `entitlements.ts:103` still names `pro_plus` as a live paid plan

`apps/web/src/lib/entitlements.ts:103` — *"A subscription whose row still claims a paid
plan (`pro`/`pro_plus`)"*. `V393:146` dropped the plan. Comment only.

### M5. A degraded create silently drops `discoverable`, and the response note does not say so

`server/usecases/competitions.ts:316` — the showcase guard reads the caller's raw
`input.visibility`, then `const discoverable = !degraded && input.discoverable === true`
drops the opt-in. A caller that asked for `{visibility: "public", discoverable: true}`,
passed the `discovery.listed` entitlement check, and got degraded receives a 201 whose
`public_quota_degraded` names only the *visibility* substitution
(`schemas.ts:186-194` — `requested_visibility` / `applied_visibility`). Two things were
substituted; one is reported. The drop itself is correct (a private competition cannot be
showcased). Either add the dropped opt-in to `PublicQuotaDegraded`, or state in that
schema's doc comment that showcase rides visibility so a consumer knows to re-request it.

### M6. `scripts/bench/lib/plan.ts` states a matrix fact V393 falsified, and the bench now provisions `enterprise`

`scripts/bench/lib/plan.ts:34-38` records as *checked*: "every pass tier, for `cricket.dls`
and `officials.auto` alike — checked: no `('event_pass', ...)` or `('event_pass_l', ...)`
insert for either key in db/migration/deltas". `V393:108-109` inserts `officials.auto`
for both rungs.

Behavioural consequence, traced: `chooseGrantingPlanForCapabilities` (`plan.ts`) iterates
`[...primaryGrantors].sort()` over the plans granting the PRIMARY capability
(`cricket.dls` → `{community, enterprise, pro}` in the live matrix) and breaks on the
first that satisfies every desired capability. Sorted, `enterprise` precedes `pro` and
grants `officials.auto` + `stats.player`, so `provisionPlan` now flips the bench org onto
the non-public Contact-us plan (it used to land on `pro_plus`). No FK failure, no crash —
but the bench baseline silently moved to a plan with unlimited caps.
`scripts/bench/lib/__tests__/plan.test.ts:27-30` and `dls-gate.test.ts:129-156,295-315`
inject a fake catalog containing `pro_plus` and no `enterprise`, so they stay green while
asserting a catalog shape that no longer exists (`dls-gate.test.ts:304`
`expect(result.provisionedPlan).toBe("pro_plus")`). Outside my declared scope; flagged
because the migration is the cause.

---

## PLAUSIBLE

### P1. A historical `registration_groups.currency = 'aud'` row has no type left to render under

`V394` narrows `organizations_currency_check` to `('usd','eur','gbp','inr')` and
`lib/currency.ts` drops `aud` from `SUPPORTED_CURRENCIES`. `V394:8-12` deliberately leaves
`registration_groups.currency` unconstrained so a submitted cart keeps the currency it was
quoted in. Any such row is now outside the `Currency` union, so symbol/format lookups
derived from `SUPPORTED_CURRENCIES` return `undefined` rather than throwing. Greenfield,
so no production row exists — I could not construct a failing case without seeding one.
Worth one grep before W3 for a fixture or seed that writes `'aud'` into
`registration_groups`.

---

## Verified clean — do not re-dispatch these

- **Migration numbering.** One file per version 392–397, no duplicate, V391 is main's.
  All internal cross-references check out except M2.
- **DB vs files.** `flyway_schema_history` at 397, every row `success = t`.
- **Every V393 step-3 UPDATE landed.** Checked cell by cell against the live matrix
  (community `members.max` 3, `competitions.max_active` 3, `ai.credits.monthly` 5 and the
  five bools still true; pro 10/10/20/6/100/40/25/500/10 and `officials.auto` true). No
  UPDATE silently matched zero rows.
- **The DELETE/deny asymmetry was respected everywhere.** `scorers.max` (V395:72-75) and
  the four V393:135-138 keys have zero surviving `hasFeature`/`requireFeature`/`getLimit`/
  `withinLimit`/`org_has_feature` reads anywhere in `apps/`, `packages/`, `scripts/`, `db/`.
  Surviving references are dictionary labels, the generated `i18n-keys.ts` union, the
  deliberate retired-plan registry in `lib/plan-label.ts:44-45`, and comments.
- **V393 step 3c's pass-row deletion is safe.** `teams.squad_max` deleted from both pass
  rungs falls through to the plan row, and V395 then raised Free to 23 — the pass rungs
  gained, not lost.
- **Enterprise has no seeding hole.** Set difference over `plan_entitlements`: no
  `feature_key` present on `community` or `pro` is missing from `enterprise`, and
  `event_pass` / `event_pass_l` are key-for-key symmetric. Every enterprise value is >= pro
  (or lower, for `registration.fee_percent`).
- **`ENTERPRISE_FEATURES` re-derived from the live matrix, not from the test.** Keys where
  no `is_public` plan grants a `true`: exactly `{api.write, dashboard.branding}`, which is
  `feature-copy.ts:312`. The backwards "Pro unlimited ⇒ enterprise" rule pass 2 found is
  gone and the replacement is right.
- **No org-level integer is assumed pass-liftable.** The pass rungs carry ints only for
  `divisions.per_competition.max`, `entrants.per_division.max`, `stages.per_division.max`,
  `schedule.checkpoints.max` and `registration.fee_percent`; every enforcement site for
  those resolves a competition (`entrants.ts:278`, `stages.ts:291`, `templates.ts:169-176`,
  `history.ts:444`, `registrations.ts:1867`, `registration-submit.ts:604`,
  `feePercentFor`). `competitions.max_active` and `dashboard.public.max` take the
  exclusion route through `liveUnpassedCompetition` instead of a pass row, which is the
  only mechanism that works.
- **C4 from pass 2 is closed.** Zero `pro_plus` plan writes remain in `scripts/smoke.ts`,
  `apps/web/e2e/**`, or the helper unions — all remaining hits are comments narrating the
  deletion.
- **The matrix pin now runs both ways.** `entitlements-v18-matrix.test.ts:273-301` was
  added this wave and asserts every live `feature_key` is named by §2, with an anti-vacuity
  floor of 40 rows; `:164` floors the doc parse at 45. The one-way exposure pass 3 recorded
  is fixed.
- **The `news.auto` digest scoping is sound in both directions.** `newsAutoCompetitionScope`
  (`org-posts.ts:1149-1161`) resolves per competition in one `org_has_feature` query, and
  both callers (`:1610` button, `:1678` cron) now read the same `permitted` field — the
  `total === 0` hole pass 3 found is closed.
