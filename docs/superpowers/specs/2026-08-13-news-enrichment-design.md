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
lives in the existing draft call sites (`draftPostsForDecidedFixture` and
the round-recap trigger), one new pure helper per source. Fail-open: any
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
- Digest is a DRAFT like all others — publish flow, public visibility,
  `shouldFirePostPublished` side effects unchanged.

## Testing (all four)

- Unit: template rendering with full/partial/absent enrichment (absent =
  byte-identical to today's output — the no-regression anchor);
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

## Dependencies & sequencing

Reads S8/S9 surfaces — both merged, so P3 is buildable early in the
portfolio order (D2 → D3 → **D7** → …). No overlap with release-2 or
S10+ (pads/UI). No OpenAPI change unless the digest button needs a new
route (`POST /orgs/{id}/posts/digest` — regen owed if so). Structured
logging: pino `post_drafted` gains `enriched: boolean`, `kind`.

## Risks / re-pin

`draftPostsForDecidedFixture` call-site shape and `divisionPlayerStats`
signature re-pinned at plan time (S9 refactors touched player-stats.ts).
Digest content depends on standings snapshots existing for the window —
absent snapshots degrade sections, never abort.

## Non-goals

No LLM-generated prose (templates only), no email/push distribution, no
per-player subscription feeds, no cron infra built for the digest.
