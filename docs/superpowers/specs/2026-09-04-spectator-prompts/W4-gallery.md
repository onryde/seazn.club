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
