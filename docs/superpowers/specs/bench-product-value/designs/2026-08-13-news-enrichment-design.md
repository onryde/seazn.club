# Auto-news enrichment + weekly digest — design (D7)

Date: 2026-08-13. Status: **approved design, creative-only** — build not
scheduled; owner green-light required. Origin: bench spec §14 item 7.
Session: P3 in the portfolio index.

## Purpose

Auto-drafted posts exist (`draftPostsForDecidedFixture`, `resultDraft`,
`roundRecapDraft` — SPEC-2/PROMPT-82) but carry results only. Enriching
them with stats turns the org news feed into the engagement surface clubs
actually share. Owner ruling (2026-08-13): enrich existing drafts AND add
a **weekly digest** post kind.

## Design

### Enrichment (templates stay pure)

`draft-templates.ts` functions remain PURE (no DB — their own contract,
kept). Callers assemble an optional `enrichment` input; templates render
what they receive:

```ts
ResultDraftInput  += { enrichment?: {
  topPerformers?: Array<{ personName, statLine }>,   // from match summary
  leaderboardMoves?: Array<{ personName, metric, from, to }>,
  streak?: { entrantName, kind: "win"|"unbeaten", length } } }
RoundRecapDraftInput += { enrichment?: {
  leaders: Array<{ metric, personName, value }>,      // top scorer etc.
  biggestResult?: { label }, standingsMoves?: [...] } }
```

Sources: match `summary`/`sideMetrics` (already in `match_states`),
`divisionPlayerStats` (leaderboard before/after the round — computed by
diffing against the previous snapshot), standings snapshots. Assembly
lives in the existing draft call site, one new pure helper per source.

**Corrected 2026-08-13 (wave-1 scout), two premises:**

- *There is one call site, not two.* Round-recap is **not** a separate
  trigger — it is drafted inline inside `draftPostsForDecidedFixture`
  when `TABLE_KINDS.has(stage_kind)`. `draftPostsForDecidedFixture`
  itself has exactly one caller (`usecases/scoring.ts:310`).
- *"Standings moves" had no data source at all.* `writeSnapshot`
  (`engine-db/competition.ts:224-236`) is an `on conflict do update`
  keyed `(stage_id, pool_id)` that **clobbers the prior row**; no
  history table exists and nothing reads an older row. Ruling: add
  `previous_positions jsonb` to `standings_snapshots` and preserve one
  step of history on upsert:
  `set previous_positions = case when standings_snapshots.positions is
  distinct from excluded.positions then standings_snapshots.positions
  else standings_snapshots.previous_positions end`. The
  `is distinct from` guard is load-bearing — `recomputeStandings` is
  idempotent and re-runs, so an unguarded assignment erases the delta on
  the second run. This makes D7 a schema-touching feature, which this
  spec originally assumed it was not.

Fail-open: any
enrichment source erroring yields the un-enriched draft, never a missing
draft (posts must not become less reliable because stats hiccuped) — with
a pino warn.

### Weekly digest

- New draft kind `weekly_digest` beside result/recap: standings movement
  (top 3 + biggest climber), stat leaders, next 7 days' fixtures,
  claimed-player highlight if any.
- Trigger v1: **"Generate digest" button** on the org posts admin page
  (window: last 7 days, org tz — `settings.orgTz` is the governing
  clock). Auto-cron ONLY if a job runner already exists in the repo at
  plan time (scout question); if none, button-only ships and cron is a
  one-line follow-up note, not new infra built for this.
  **Resolved 2026-08-13 (wave-1 scout): a runner DOES exist**, so the
  conditional fires and the cron ships. The established shape is a
  GitHub Actions `schedule:` job hitting an `x-cron-secret`-guarded
  endpoint — `funnel-reminders-stg.yml:16-19`, plus billing-events,
  billing-grant, billing-quantity, ai-preview-sweep. All are `-stg`;
  the digest cron follows that pattern exactly and stays stg-only. No
  vercel-cron / node-cron / pg_cron / worker service exists — do not
  introduce one.
- Digest is a DRAFT like all others — publish flow, public visibility,
  `shouldFirePostPublished` side effects unchanged.

## Digest content rules (normative per section)

Window: `[now−7d, now)` in org tz, computed from the button press.
Sections render ONLY when their data exists (absent section ≠ empty
section — no "no data" filler lines):

1. **Standings movement**: per division with ≥1 decided fixture in
   window — top 3 now, plus biggest climber `{entrant, from→to}`
   (largest positive rank delta window-over-window; ties → most points
   gained; still tied → skip the climber line).
2. **Stat leaders**: top metric per sport family (top scorer / most
   wickets / most points) with counts — only metrics
   `divisionPlayerStats` already emits; never derived ad hoc.
3. **Upcoming**: next 7 days' fixtures, grouped by day, capped at 10
   lines + "and N more" tail key.
4. **Claimed-player highlight**: at most one — the claimed person with
   the best window performance line if any claimed person played.

Draft body is assembled from the SAME parameterized key set as other
drafts (`news.digest.*` namespace); title key
`news.digest.title {orgName, weekOf}`.

## Key namespace inventory (i18n ×4, flat)

`news.enrich.performer_line {name, statLine}` ·
`news.enrich.leader_move {name, metric, from, to}` ·
`news.enrich.streak {entrant, kind, length}` ·
`news.recap.leader {metric, name, value}` ·
`news.recap.biggest {label}` · `news.digest.title/section.*` (+ per
section body keys). The regression gate seeds from THIS list (spec
Testing) — extending the list without the 4 dictionaries reds.

## Failure matrix (fail-open, normative)

| Source down | Result |
|---|---|
| match summary read fails | result draft plain, warn logged |
| stats diff fails | recap keeps result lines, drops leader section |
| standings snapshot absent | digest omits movement section |
| ALL sources fail | drafts still created, `enriched:false` |
A missing DRAFT (any path) is a defect; a missing SECTION is designed
degradation.

## Testing (all four)

- Unit: template rendering with full/partial/absent enrichment (absent =
  byte-identical to today's output — the no-regression anchor; see the
  digest amendment below, which this anchor does NOT govern);
  leaderboard-move diffing; digest assembly windows at a DST boundary in
  org tz.
- Regression: every new dictionary key present in all 4 locales (seeded
  from the template's key list, NOT from the dictionaries themselves —
  the event-copy-gate lesson: a gate seeded from its own output cannot
  fail); fail-open on a poisoned stats source still creates the plain
  draft.
- E2E: decided fixture → draft contains performer line; digest button →
  draft appears with sections.
- Smoke: enriched result draft + digest generation on the smoke org.

## i18n

All enrichment sentence templates + digest section headers ×4 locales,
flat dotted keys, parameterized ({name}, {count}, {metric}) — never
concatenated fragments (grammar differs per locale).

Key namespace is `news.*` / `digest.*`, disjoint from the sibling
capacity work's `schedule.capacity.*` — both land in the same four
`dictionaries/*/ui.json` files, which `feat/s10-w8-chassis-renderer` is
also editing. Note the pre-existing, unrelated `register.capacity.*`.

## Dependencies & sequencing

Reads S8/S9 surfaces — both merged, so P3 is buildable early in the
portfolio order (D2 → D3 → **D7** → …). No overlap with release-2 or
S10+ (pads/UI). No OpenAPI change unless the digest button needs a new
route (`POST /orgs/{id}/posts/digest` — regen owed if so). Structured
logging: pino `post_drafted` carries `{orgId, fixtureId, divisionId,
kind, enriched}`.

**Corrected 2026-08-13 (wave-1 scout):** this spec said `post_drafted`
"gains" those fields, implying an existing event to extend.
**`post_drafted` does not exist anywhere** — `git grep -na
"post_drafted\|postDrafted"` returns zero hits across `apps/web`, there
is no logger call in `org-posts.ts` at all, and the structured-logging
wave (`989e0ba8`) touched no news files. D7 **creates** the event. That
also means the "new server code ships structured logging" rule applies
here in full, not as an incremental field add.

One more site to verify, not assume: `PostKind` is declared **twice** —
`usecases/org-posts.ts:32` and `api-v1/schemas.ts:2941`. Adding
`weekly_digest` must touch both or they silently drift, and `posts.kind`
may additionally carry a DB CHECK constraint, which would be a third
site needing a migration. This is the same API-enum-⊃-DB-CHECK mismatch
already flagged for D1's `americano`/`page_playoff`.

## Risks / re-pin

`draftPostsForDecidedFixture` call-site shape and `divisionPlayerStats`
signature re-pinned at plan time (S9 refactors touched player-stats.ts).
Digest content depends on standings snapshots existing for the window —
absent snapshots degrade sections, never abort.

## Non-goals

No LLM-generated prose (templates only), no email/push distribution, no
per-player subscription feeds, no cron infra built for the digest.

## Amendment (2026-08-13): the fully-empty weekly digest

Reported from the running app: pressing **Generate digest** on a quiet
org produced a post with a title and a completely blank body, which
reads as a broken button rather than as "nothing happened this week".

**Ruling: a fully-empty digest renders one sentence saying so.** The
per-section rule above is unchanged — an absent section still renders no
heading and no "no data" filler line. This governs only the case where
EVERY section is absent, where the choice is between one sentence and
nothing at all.

This is recorded because it reverses a test that asserted `bodyMd === ""`
("every section absent yields an empty body, never a placeholder
sentence"), and because the reading behind that test is arguable rather
than obviously wrong. Two clauses pull in opposite directions:

- "Sections render ONLY when their data exists (absent section != empty
  section — no 'no data' filler lines)" is scoped to SECTIONS, and the
  test "an absent section renders no heading at all" is what pins it.
- The Testing section's "absent = byte-identical to today's output — the
  no-regression anchor" reads as a whole-body constraint.

The second clause is about **enrichment being absent from a draft type
that already existed** — a result or round_recap draft must not change
when its enrichment sources go quiet. The weekly digest is new in D7, so
it has no "today's output" to be byte-identical to, and the anchor cannot
have been about it. That is the reading this amendment adopts.

Stated plainly because the first attempt cited only the section-scoped
clause and did not address this one, which made a genuine ambiguity look
like a settled question. If the owner prefers the blank body, revert
`news.digest.empty` and this amendment together.
