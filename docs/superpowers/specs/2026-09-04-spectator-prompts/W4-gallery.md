# W4 — the gallery (staff upload from the public page, media-consent gated)

Read `_RULES.md` → `_INDEX.md` → spec §W4. Plan:
`../../plans/2026-09-04-spectator-w4.md` (written after W3 merges). Worktree;
one PR. Depends on W2 (the Gallery tab slot) and W1 (the Photos strip on the
match centre). Load `supabase:supabase-postgres-best-practices` before the
migration; the schema is `seazn_club`, not `public`.

## Why the wave exists

The owner asked for gallery upload. Parents and players come back for photos;
a competition page with a gallery is shared again after the match. The
organiser gets one place for match-day photos instead of a WhatsApp group.
Scope stays `/shared`: the upload control lives on the public gallery and is
shown only to signed-in org staff/scorers. Anonymous upload is out (spam,
abuse, consent).

## Scope

1. **Schema** — `gallery_photos` (competition_id, division_id?, fixture_id?,
   storage_path, width, height, caption, taken_at, uploaded_by,
   consent_confirmed_at, created_at, deleted_at). Migration in the repo's
   `db/migration/deltas/` numbering; if the migration is still unmerged when a
   correction is needed, AMEND it (repo ruling).
2. **Storage** — bucket `gallery`, unguessable paths (division-logo
   `logo_storage_path` precedent); derivatives at upload via `sharp` (thumb
   400 px, display 1600 px), original kept, EXIF stripped; limits 10 MB / 200
   per competition as product constants.
3. **API** — `POST /api/v1/competitions/{id}/gallery` (session-scoped, role
   check staff/scorer, rate-limited) and `DELETE …/gallery/{photoId}` (soft
   delete; derivatives + original removed in the same request). OpenAPI
   regenerated — the drift gate diffs `v1.json` and `v1.public.json`.
4. **Upload sheet** on the Gallery tab (staff only): multi-select camera roll or
   camera, optional match tag (default the live or most recent fixture of the
   day), caption, the **media-consent gate** — shows how many players in the
   tagged division(s) have media consent DECLINED (RS007 per-player consent)
   and requires the tick, stored as `consent_confirmed_at`; per-file progress
   and retry.
5. **Public surfaces** — Gallery tab: grid grouped by day and match, lightbox
   with swipe, caption, share, download, "Request removal" (prefilled message
   to the org contact with the photo id); match centre **Photos** strip (six
   thumbs + "All photos"). Both hidden when empty. No per-photo pages;
   `noindex` on gallery images.
6. **Testids** `gl-*`; **walkthrough v4** — a signed-in staff context uploads
   two photos with a match tag and the consent tick; the anonymous context
   sees them on the Gallery tab and the Photos strip at 320 and 1280; removal
   → 404 everywhere; the quota message at the cap.

## Do NOT touch

The organiser console; entitlement matrix/copy (a plan-tiered quota is a v18
question for the owner — record, do not build); the engine; the scorepad;
registration pages.

## Acceptance — all four test types

- **Unit**: derivative sizing; EXIF strip; quota ladder with the empty case
  first; declined-consent count from the division's players; role check.
- **E2E**: walkthrough v4 in `--project=walkthrough`; full `mobile.spec.ts`.
- **Smoke**: Gallery tab GET carries `gl-` markers; the storage object exists
  after an upload.
- **Regression**: anonymous POST → 401; upload without the consent tick → 400;
  a soft-deleted photo is absent from every reader (tab, strip, storage URL).
- **Screens**: Gallery tab and lightbox at 320/768/1280; the upload sheet at
  320 with the consent gate visible without scrolling past the tick.

## Gates

As W1, plus the OpenAPI drift check is the first gate run, not the last.

## Plan (DRAFT, 2026-09-05)

**Plan:** `docs/superpowers/plans/2026-09-05-spectator-w4-gallery.md` (DRAFT — the
path the header of this prompt names, `2026-09-04-spectator-w4.md`, is superseded
by this one, which follows the W2/W3 convention and `_STATE.md:20`; not yet
approved for execution). Drafted by a Fable agent under owner ruling 14
(corrected): planning only, docs only.

**Tasks and order:** 12 tasks, TDD, all four test types — 1 migration + storage
paths + product constants → 2 sharp derivatives + EXIF strip → 3 media-consent
reader → 4 quota/authorisation/write path → 5 API routes + OpenAPI + key ban →
6 public read model + both documents + invalidation → 7 dictionaries (39 keys ×
4 locales) → 8 grid + lightbox + Photos strip → 9 staff upload sheet → 10 tab
and strip wiring → 11 walkthrough v4 + mobile.spec + smoke + regressions →
12 gates, review, R11 sign-off.
Lanes: 3 beside 2; 7 beside 8–9. Hard dependencies: W1 Task 9 (`matchCentre` on
`getPublicFixture`) and Task 14 before 6/10; W1 Task 15 (`spectator-public.spec.ts`
exists) before 11; W2 Tasks 4/7/11 (`competition-hub.ts`, `useLiveCompetition`,
`CompetitionLanding`) before the hub half of 6 and 10 — deferred with a recorded
note if W2 has not merged, never weakened to pass.

**Open owner questions (recommendation each):**
- **Q1 — the consent gate's shape.** The spec asks the sheet to show how many
  players have media consent DECLINED. **Neither source can say that today.**
  `registration_players.media_consent_at` (V384:19-23) is a nullable timestamp —
  null means declined *and* never-asked. `persons.consent.public_photo`
  (V204__persons.sql:11) is the right flag, an explicit boolean, the one every
  other public photo surface reads — but **no production path ever writes
  `false`**: registration inserts `{public_name: true}` (`registrations.ts:668-671`),
  the roster inserts `{}` (`entrants.ts:55-58`), and only the player's own patch
  (`me.ts:481`), the organiser PATCH (`persons.ts:130-140`), the merge and the v1
  importer touch it. Recommend: ship the attestation tick as the blocking gate
  exactly as specified (`consent_confirmed_at` NOT NULL), and render the declined
  count from `public_photo === false` **only when at least one person on the
  roster carries an explicit value either way**; otherwise render "Media consent
  has not been recorded for this division — check before you upload." A "0
  declined" line on an org that never collected consent is a false all-clear on a
  child's photograph. Counter-argument: "we don't know" reads as friction.
- **Q2 — the storage bucket.** The spec says bucket `gallery`. **Nothing in this
  repo provisions a bucket** (zero hits for `createBucket`/`storage.buckets`), and
  every stored object lives in the single `assets` bucket (`storage-url.ts:5`,
  `persons.ts:44`) — a new bucket is a manual console step in dev, CI, e2e and
  prod, and the first environment that misses it 502s on upload. Recommend: keep
  `assets` with the prefix `orgs/{orgId}/gallery/{competitionId}/{photoId}/{variant}.jpg`.
  Unguessability comes from the random `photoId` segment, not the bucket name.
  Counter-argument: a separate bucket would allow a per-bucket retention policy —
  worth doing when such a policy exists; a prefix migrates into one cheaply.
- **Q3 — new `gallery_photos` table vs a `gallery` post kind on `org_posts`.**
  Recommend the new table, as the spec says. `org_posts` (V295:17-38) carries
  exactly ONE `hero_image_path`, a per-org unique slug, a draft/published/archived
  lifecycle, path-based ISR and the Pro `news.auto` entitlement; a photo needs
  none of that and needs three things it lacks — a required competition binding
  with optional division/fixture tags, a per-photo soft delete, and a
  per-competition count for the quota. Reusing the kind drags the news
  entitlement and the slug rule onto every photo and forces a child table anyway.
  Counter-argument: two invalidation paths — cost is one function.
- **Q4 — live update: poll, Realtime, or neither.** Recommend **neither**: put
  photos on `MatchCentreDoc.photos` and the hub document's `gallery`, so W1's
  `useLiveFixture` and W2's `useLiveCompetition` carry them with no new
  transport, subscription or entitlement read (R6/R10). One caveat for a ruling:
  `use-live-fixture.ts:51,96` stops polling once a fixture is neither `in_play`
  nor `scheduled`, so **a photo added to an already-decided fixture will not
  appear in place** on a page left open. Recommend accepting for W4 — the
  realistic case (photos during or just after play) is fully covered and proven
  in the walkthrough; widening the `live` predicate to "decided within the last
  hour" is one line if the owner wants it.
- **Q5 (minor) — testid prefix.** R7 and §6 of this prompt say `gl-*`; the
  dispatch brief said `mc-gallery-*`/`mh-gallery-*`. The plan follows the spec.
- **Q6 (recorded, deliberately not built)** — a plan-tiered photo quota. R6
  forbids a new entitlement row and the spec routes this to entitlements v18;
  10 MB / 200-per-competition ship as product constants on every plan.

**False premises found while reading the tree:**
- **The declined-consent count is not computable from either named source** (Q1
  above). This is the wave's headline finding: an "absent symptom" that would
  have shipped as a positive all-clear.
- **RS007's registration media consent never reaches `persons.consent.public_photo`.**
  The two live in different tables with different shapes and nothing bridges
  them. Closing that is a registration-programme change; this prompt's "Do NOT
  touch" list excludes registration pages, so it is recorded, not absorbed.
- **`sharp ^0.34.5` is an `apps/web` dependency (`package.json:55`) but imported
  nowhere in `apps/web/src`**, and `next.config.js:62` is
  `serverExternalPackages: ["pdfkit", "exceljs"]` — sharp is not listed. Whichever
  of W3 or W4 lands first owes a proof that the standalone build carries the
  native binary; a green vitest says nothing about it.
- **`scorer` is in neither `EDITOR_ROLES` nor `READ_ROLES`** (`lib/types.ts:25,28`),
  so `requireOrgAuth`'s `"write"`/`"read"` scopes (`api-v1/auth.ts:217`) cannot
  express "staff or scorer". The routes resolve the org themselves
  (`resourceOrg("competition", id)` — `competition` IS in `ORG_TABLES`, `:317`)
  and call `requireOrgRole(orgId, GALLERY_UPLOAD_ROLES)`.
- **Dispatch-brief premises that contradict this prompt and the spec**, recorded
  and not built: "Gallery tab on the match centre" (the match centre gets a
  **Photos strip**; the Gallery TAB is W2's hub only); "bound to a fixture and
  optionally competition" (inverted — `competition_id` is required,
  `division_id`/`fixture_id` nullable); a "moderation state" column (none in the
  spec's column list — soft delete plus "Request removal" is the mechanism); an
  e2e "consent-blocked image never published" (there is no per-image consent
  block; the spec's regression is "upload without the consent tick → 400").

**Re-pin note.** Every `file:line` in the plan was opened on 2026-09-05 on
`feat/spectator-surface` (HEAD after W1 Tasks 1–5, 7, 10–13, 17; Tasks 6, 8, 18
on lane branches; W2 and W3 are unreviewed drafts). The plan's "Premises to
re-pin" table carries 20 numbered premises with what each is pinned at and what
moves it — re-check every one after W1/W2 merge before executing. A false premise
is a finding to record in `_INDEX.md`, not a blocker.
