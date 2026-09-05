# Spectator W4 — Gallery Implementation Plan

> **Status:** DRAFT — re-pin file:line references after W1/W2 merge; not yet approved for execution.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a competition a public photo gallery that the organiser's own staff fill from the public page itself — a Gallery tab on the competition hub, a Photos strip on the match centre, and a staff-only upload sheet gated by a media-consent attestation — so parents and players come back to the shared link after the match instead of to a WhatsApp group.

**Architecture:** One new table `gallery_photos` (competition-bound, division/fixture optional, soft-deleted) and one multipart upload route `POST /api/v1/competitions/{id}/gallery` that runs `sharp` server-side to strip EXIF and cut two derivatives before anything reaches storage. The browser downscales first (pure `fitWithin` maths, canvas plumbing), so a phone sends ~1–2 MB, not 8. Reads ride the documents that already exist — `MatchCentreDoc.photos` (W1) and the competition hub document's `gallery` (W2) — so R10's live-in-place update comes free from the transports those waves already built, and no second poll is introduced.

**Tech Stack:** TypeScript 7, Node 26, pnpm; Next.js 16 App Router (`output: standalone`); `sharp ^0.34.5` (already an `apps/web` dependency, `apps/web/package.json:55`); Supabase Storage via `supabaseAdmin()` (`apps/web/src/lib/supabase-admin.ts:6`); postgres.js with `withTenant` RLS (`apps/web/src/lib/db.ts:183`); zod 4 → OpenAPI 3.1 (`apps/web/src/server/api-v1/openapi.ts`); vitest (`environment: "node"` — **no DOM**); Playwright (`walkthrough` project, seven-width `mobile.spec.ts` projects); Tailwind with the public-site tokens.

**Spec:** `docs/superpowers/specs/2026-09-04-spectator-surface-design.md` (§W4, standing rules R1–R11). Programme rules: `docs/superpowers/specs/2026-09-04-spectator-prompts/_RULES.md`. Prompt: `.../W4-gallery.md`. Depends on the W1 plan (`docs/superpowers/plans/2026-09-04-spectator-w1-match-centre.md`) and the W2 draft (`.../2026-09-05-spectator-w2-competition-landing.md`).

## Global Constraints

- Worktree `.claude/worktrees/spectator`, branch `feat/spectator-surface`; never the main checkout. **`pnpm`, never `npm install`.** Git in this worktree is plain `/usr/bin/git <verb> …`, one command per call, with no compound shell around it (the isolation guard refuses anything else); commit from the worktree ROOT with `commit -o <paths>`.
- **R1 — Phone composition, not shrink.** Design at 320/375 first; ≥768 may add columns or lay cards two-up, never new controls. Verify with a **control-set diff from the live DOM at 320 against 1280** (membership, order, repeats), never by comparing box sizes. Scrolling regions carry `tabindex="0"`, a role and an accessible name. No page scrolls horizontally at any of 320/360/375/390/430/768/834. One DOM, branched with `max-md:*` / `md:hidden` — never a second phone tree. `/\bmd:hidden\b/` also matches inside `max-md:hidden`; anchor assertions on `\s...hidden"`.
- **R2 — Every string through the `public` dictionary namespace, four locales,** `gen-keys` regenerated (`i18n-keys.ts` is GENERATED — never hand-edit). Keys are written BARE inside `apps/web/src/dictionaries/{en,es,fr,nl}/public.json` — `gallery.*`, never `public.gallery.*` (a W1 slip wrote the prefixed form for two tasks and was corrected the same day).
- **R3 — Consent before names.** Every person name on a public page or image goes through the public-site consent resolver RS008 unified — `resolvePersonDisplayName(fullName, consent, divisionSetting, youth)` (`apps/web/src/lib/name-display.ts:72`). Never a second resolver. A masked line renders the masked label, never a blank row.
- **R6 — No new entitlement rows.** Everything here is on every plan. Reuse the existing gates only: Realtime on Pro / poll otherwise; `org.branded` for the footer. Entitlements v18 is in flight — touch nothing of its matrix or copy. A plan-tiered gallery quota is a v18 question for the owner: **record, do not build.**
- **R7 — Testids on every new control**: `gl-…` for every gallery control (spec R7 and `W4-gallery.md` §6). Every wave extends `apps/web/e2e/walkthrough/spectator-public.spec.ts` in the `walkthrough` project (own CI leg).
- **R9 — Empty case first.** Every aggregate (the gallery grid, the day groups, the quota ladder, the declined-consent count) writes its empty case in its test BEFORE its ladder. The competition-desk programme shipped three vacuous "Finished" defects past green suites from exactly this omission.
- **R10 — Live means live, never reload.** Transport = the existing pair (Realtime on Pro, poll otherwise) carrying the same public JSON the page rendered from. Never a "refresh to see the score", never a self-reload. Proof is end to end: act through the API while the anonymous page is OPEN and assert the DOM changes within one poll interval with no navigation. A test that reloads to see the change has not tested this rule.
- **R11 — Visual sign-off, per screen, cosmetics included.** Green suites do not finish a wave. Every page, tab and state is screenshotted at 320/768/1280 on a prod build with real data and READ. Per-screen verdict table in the spec, each row saying what was SEEN. A cosmetic defect is a defect — fixed before the PR.
- **Product constants (spec §W4, not entitlements):** 10 MB per file, 200 photos per competition. Derivatives thumb **400 px**, display **1600 px**; the original is kept; **EXIF stripped** (location privacy).
- **Upload is STAFF ONLY, server-decided.** Signed-in members of the org with a staff or scorer role (existing session + role check). **No anonymous uploads.** The control must not be in the anonymous DOM at all — not merely hidden.
- The migration and any policy are written under the `supabase:supabase-postgres-best-practices` skill; **the schema is `seazn_club`, not `public`** (`scripts/flyway.sh:87`).
- **Do NOT touch:** the organiser console; the entitlement matrix or its copy; the engine; the scorepad and its skins; registration pages; `e2e.yml`; the `present` slides.
- Subagents: **Opus at minimum** (model lives in `.claude/agents/*.md` frontmatter; never pass `model:` on a dispatch). Subagents run vitest and tsc **SCOPED only**; the orchestrator runs the full gate with `--reporter=json --outputFile` and judges `numTotalTests`/`numFailedTests`, never exit codes. `cd` to the worktree in the SAME call as any verify command.
- Commit after every task with a normal-prose message ending in the two trailers:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01TCLYbFJZ8bseHS4kp4nGDa`.

---

## File structure

**Migration**
- `db/migration/deltas/V392__gallery_photos.sql` — NEW (number re-pinned at execution: the highest delta on the branch today is `V391__official_availability_org_write.sql`). If it is still unmerged when a correction is needed, **AMEND it** — greenfield stance is one migration, not a patch on top (`V376__event_imports.sql:57-60` is the precedent).

**Server — storage and image (`apps/web/src/server/gallery/`)**
- `gallery-paths.ts` — NEW. `galleryObjectPath(orgId, competitionId, photoId, variant)`, `GALLERY_VARIANTS`, `galleryPublicUrl(...)`. Pure; client-safe (no `server-only`) because the public grid resolves URLs in a client component.
- `gallery-image.ts` — NEW. `fitWithin(w, h, max)` (pure), `makeGalleryDerivatives(bytes)` — `sharp`, EXIF strip, thumb 400 / display 1600, dimension probe. `server-only`.

**Server — use cases (`apps/web/src/server/usecases/`)**
- `gallery.ts` — NEW. `GALLERY_UPLOAD_ROLES`, `GALLERY_MAX_BYTES`, `GALLERY_MAX_PER_COMPETITION`, `assertGalleryQuota`, `uploadGalleryPhoto`, `softDeleteGalleryPhoto`, `readDivisionMediaConsent`.
- `public.ts` — MODIFY: add `publicCompetitionGallery(...)` beside `publicFixture` (`:263`), reusing `cached` (`:32`) and `PUBLIC_CACHE_CONTROL` (`:20`).
- `scoring.ts` — untouched; gallery writes fire their own invalidation (Task 6).

**Server — public read model (`apps/web/src/server/public-site/`)**
- `gallery-photos.ts` — NEW. `readCompetitionGallery(competitionId)`, `readFixturePhotos(fixtureId, limit)`, `groupGalleryByDay(photos, tz)` (pure, empty case first).
- `match-centre-schema.ts` — MODIFY: `GalleryPhoto` schema; `MatchCentreDoc` gains `photos: z.array(GalleryPhoto).default([])`.
- `data.ts` — MODIFY: `getPublicFixture` (`:689-747`) threads photos into the document W1 Task 9 builds.
- `competition-hub.ts` (W2 Task 4, does not exist yet) — MODIFY: hub document gains `gallery`; `deriveHubTabs` emits `"gallery"` when the competition has photos.
- `revalidate.ts` — MODIFY: `fireGalleryRevalidate(competitionId, divisionId | null)`.

**API**
- `apps/web/src/app/api/v1/competitions/[id]/gallery/route.ts` — NEW (`POST`, `GET`).
- `apps/web/src/app/api/v1/gallery/[photoId]/route.ts` — NEW (`DELETE`).
- `apps/web/src/server/api-v1/schemas.ts` — MODIFY: `GalleryPhoto`, `GalleryUploadResult`, `GalleryConsentSummary`.
- `apps/web/src/server/api-v1/openapi.ts` — MODIFY: three `ROUTES` rows.
- `apps/web/src/server/api-v1/key-scopes.ts` — MODIFY: the two mutations join `NEVER_KEY_ROUTES` (`:296-345`, beside `"POST /divisions/:id/logo-upload-url"` at `:331`).
- Regenerate: `npm run openapi:gen` → `openapi/v1.json`, `openapi/v1.public.json`.

**UI — `apps/web/src/components/public-site/gallery/`**
- `gallery-tab.tsx` — NEW. `GalleryTab` — day/match groups, lazy thumbs, `gl-*` testids, empty case.
- `gallery-lightbox.tsx` — NEW. `GalleryLightbox` — swipe, caption, share, download, "Request removal", staff delete, URL hash.
- `photos-strip.tsx` — NEW. `PhotosStrip` — up to six thumbs + "All photos", accessible scrolling rail.
- `upload-sheet.tsx` — NEW. `GalleryUploadSheet` — staff only, multi-select, match tag, caption, consent gate, per-file progress and retry.
- `downscale.ts` — NEW. `fitWithin` re-export + `downscaleForUpload(file)` (canvas; e2e-proven, not unit-testable).
- `__tests__/{gallery-tab,photos-strip,upload-sheet}.test.tsx` — NEW (`renderToStaticMarkup`, the W1 pattern).

**Wiring**
- `apps/web/src/components/public-site/match-centre/match-centre.tsx:107-120` — MODIFY: mount `<PhotosStrip>` after the tab panel.
- W2's `CompetitionLanding` — MODIFY: drop `.filter((id) => id !== "gallery")` (W2 plan `:1420`).
- `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/page.tsx` — MODIFY: `noindex` on gallery images.

**Dictionaries** — `apps/web/src/dictionaries/{en,es,fr,nl}/public.json` (194 keys each today) + `npm run i18n:gen-keys`.

**Tests** — `apps/web/src/server/gallery/__tests__/{gallery-image,gallery-paths}.test.ts`; `apps/web/src/server/usecases/__tests__/gallery.test.ts`; `apps/web/src/server/public-site/__tests__/gallery-photos.test.ts`; `apps/web/src/app/api/v1/competitions/[id]/gallery/__tests__/route.test.ts`; `apps/web/e2e/walkthrough/spectator-public.spec.ts` (W4 block); `apps/web/e2e/mobile.spec.ts` (two added cases); `scripts/smoke.ts` (two added checks).

---

## Premises to re-pin before execution (this plan is a DRAFT until each is checked)

Every line number below was opened on 2026-09-05 on `feat/spectator-surface` (HEAD after W1 Tasks 1–5, 7, 10–13, 17 landed; W1 Tasks 6, 8, 18 on lane branches; the W2 and W3 plans are unreviewed drafts). **A false premise is a finding to record in `_INDEX.md`, not a blocker.**

| # | Premise | Pinned at | Moves when |
|---|---|---|---|
| P1 | **The spec's consent source cannot express "declined".** `registration_players.media_consent_at` is a nullable timestamp — null means declined AND never-asked, indistinguishably (`db/migration/deltas/V384__registration_players_consent.sql:19-23`, whose own header says "null = consent not given/not yet recorded"). The other candidate, `persons.consent.public_photo` (`db/migration/v2-engine/tables/V204__persons.sql:11`), is an explicit boolean but **no production path ever writes `false`**: registration inserts `{public_name: true}` only (`usecases/registrations.ts:668-671`), the entrant roster inserts `{}` (`usecases/entrants.ts:55-58`); the only writers are the player's own self-service patch (`usecases/me.ts:481`), the organiser `PATCH /persons/{id}` (`usecases/persons.ts:130-140`), the merge resolver (`person-merge.ts:275`) and the v1 importer (`server/migration/v1-map.ts:141`). **A count rendered from either source is a false all-clear.** Task 3's suppression rule and owner question Q1 exist for this. | as cited | a registration→persons consent propagation ships |
| P2 | **No bucket provisioning exists anywhere in this repo.** `createBucket` / `storage.buckets` → zero hits across `apps/web/src`, `scripts`, `db`, `.github`. Every stored object today lives in ONE bucket, `ASSETS_BUCKET = "assets"` (`apps/web/src/lib/storage-url.ts:5`, re-declared as `PHOTO_BUCKET = "assets"` at `usecases/persons.ts:44`). A `gallery` bucket is a manual Supabase-console step in dev, CI, e2e and prod. See Q2. | as cited | someone adds bucket provisioning |
| P3 | **`sharp` is a dependency but imported nowhere.** `apps/web/package.json:55` (`"sharp": "^0.34.5"`); zero `import sharp` in `apps/web/src`. `apps/web/next.config.js:62` is `serverExternalPackages: ["pdfkit", "exceljs"]` — sharp is NOT listed. W3 Task 2 is the first source import; if W3 has not merged, Task 2 here is the first, and the standalone build must be proven to carry the native binary (Step 6). | as cited | W3 merge |
| P4 | **The neither-scope role gap.** `requireOrgAuth`'s `scope: "write"` resolves to `EDITOR_ROLES = ["owner","admin"]` and `"read"` to `READ_ROLES = ["owner","admin","viewer"]` (`server/api-v1/auth.ts:217`, `lib/types.ts:25,28`) — **`scorer` is in neither**, and the spec wants staff *or scorer*. The route therefore resolves the org itself (`resourceOrg("competition", id)`, `auth.ts:342`; `competition` IS in `ORG_TABLES`, `:317`) and calls `requireOrgRole(orgId, GALLERY_UPLOAD_ROLES)` (`lib/auth.ts:456`), which goes through `requireUser()` and so is session-only by construction. | as cited | a role-set change |
| P5 | `getPublicFixture` does **not** return `matchCentre` today — it returns `{ org, competition, division, fixture, entrantNames, realtime }` (`server/public-site/data.ts:689-747`), and `server/public-site/match-centre.ts` does not exist. W1 Task 9 owes it. Task 6 here cannot land before it. | `data.ts:689-747` | W1 Task 9 |
| P6 | `server/public-site/competition-hub.ts` does not exist (listing 2026-09-05: `data.ts, discovery.ts, match-centre-schema.ts, public-lineups.ts, revalidate.ts, timeline.ts`). W2's contract: `CompetitionHubTabId = z.enum(["overview","matches","table","stats","teams","gallery","info"])` (W2 plan `:138`), `HubTabId` (`:376`), `deriveHubTabs` never emits `"gallery"` (`:377`), and `CompetitionLanding` filters it out with `.filter((id) => id !== "gallery")` (`:1420`). Key `landing.tab.gallery` is already in W2's key list (`:1107`). Task 6/10 remove the filter and flip the derivation. | W2 draft | W2 merge |
| P7 | `apps/web/e2e/walkthrough/spectator-public.spec.ts` **does not exist** (W1 Task 15 not started; the directory listing shows W0's `w0-spectator-capture.spec.ts` only). Task 11 appends a W4 block to W1's file and reuses its seeded matches; re-pin the helper names then. | worktree listing | W1 Task 15 |
| P8 | The match-centre document today is `MatchCentreDoc { fixtureId, sportKey, header, tabs, cricket, timeline, sets, info, derivedComplete }` (`match-centre-schema.ts:59-72`); `MatchCentreTabId` is the six-member enum at `:8` — **photos is a STRIP, not a tab**, so that enum does not change. The root renders `CourtCard → TabRail → one tabpanel` inside `data-testid="mc-root"` (`match-centre.tsx:107-120`). | as cited | W1 lane merges |
| P9 | **The match-centre poll stops when the fixture is not live.** `use-live-fixture.ts:51` `const live = data.status === "in_play" \|\| data.status === "scheduled"`, and the interval is gated on it (`:96`). A photo added to a **decided** fixture therefore will not appear in place. See Q4. | as cited | a transport change |
| P10 | The v1 kernel: `v1(fn)` (`server/api-v1/http.ts:124`), `reply(status, data, headers)` (`:96`); public read helpers `PUBLIC_CACHE_CONTROL` (`usecases/public.ts:20`), `publicRateLimit(req)` (`:24`, 60/min per IP), `cached(key, load)` (`:32`, TTL 30). Mutation limiter `MUTATION_LIMIT = { max: 60, windowSeconds: 60 }` (`lib/rate-limit.ts:74`); the limiter is **inert with no Redis** (local dev, e2e) — a test asserting a 429 must mock `@/lib/rate-limit`. | as cited | — |
| P11 | Multipart precedent: `POST /api/v1/persons/[id]/photo` reads `req.formData()`, requires a `File` entry named `file`, and 400s otherwise (`app/api/v1/persons/[id]/photo/route.ts:14-16`); bytes reach storage through `supabaseAdmin().storage.from(PHOTO_BUCKET).upload(path, bytes, { contentType, upsert: true })` with a 502 on error (`usecases/persons.ts:95-105`). No body-size limit is configured for Route Handlers anywhere — `bodySizeLimit` is a Server Actions option. Confirm at execution that a 10 MB multipart POST is accepted by the standalone server, not just by `next dev`. | as cited | Next upgrade |
| P12 | Session-only route precedent: `"POST /divisions/:id/logo-upload-url"` sits in `NEVER_KEY_ROUTES` (`server/api-v1/key-scopes.ts:331`) with the comment "signed URLs are a console UX, not an API surface". The OpenAPI drift gate is a `ci.yml` step (`:94-98`: `npm run openapi:gen` then `git diff --exit-code openapi/v1.json openapi/v1.public.json`), and `openapi-coverage.test.ts` asserts `ROUTES` matches the route files on disk **exactly**. | as cited | — |
| P13 | Migration style: explicit `org_id`, `enable`+`force` RLS, one tenant policy `using (org_id = current_org_id()) with check (...)`, grants to `app_user`, **every FK gets its own index** (`V376__event_imports.sql:33-54`). Highest delta on the branch: `V391__official_availability_org_write.sql` (149 files in `db/migration/deltas/`). Public reads bypass RLS on the superuser connection and filter through the `public_*_v` views instead (`usecases/public.ts:1-6`; `V295__org_news.sql:10-13` states the same rule for posts). | as cited | any new delta |
| P14 | `org_posts` (`V295__org_news.sql:17-38`) carries exactly ONE `hero_image_path`, a per-org unique `slug`, a `draft/published/archived` lifecycle, path-based ISR (`revalidate.ts:63-71`) and a Pro `news.auto` entitlement. `PostKind = ["news","result","round_recap","announcement","weekly_digest"]` (`schemas.ts:4384`). Evidence for Q3. | as cited | — |
| P15 | Playwright `walkthrough` project uses `storageState: AUTH_STATE` — it is **SIGNED IN** (`apps/web/playwright.config.ts:164-168`), which is what W4's staff context needs; the anonymous context must be created explicitly (`browser.newContext({ storageState: { cookies: [], origins: [] } })`). Helpers: `apiJson(request, path, method, body)` (`e2e/helpers.ts:122` — sets `Content-Type: application/json`, so it **cannot** do multipart), `expectNoHorizontalScroll(page, { allowancePx })` (`:43`), `screenshotAtWidths` (`:240`), `competitionPath`/`divisionPath`/`fixturePath` (`:1314,:1330,:1347`), `createStageAndGenerate` (`:1383`), `addEntrantsViaApi` (`:1366`), `TAG` (`:111`); `dismissCookieBanner` (`e2e/scorepad-a11y-kit.ts:409`); `auditRoute` (`e2e/mobile.spec.ts:502`), `overflowingIn` (`:91`), `projectViewport` (`:44`). `mobile.spec.ts` is `describe.configure({ mode: "serial" })` (`:39`) — a red count is a FLOOR. | as cited | — |
| P16 | Smoke: `check(label, cond)` (`scripts/smoke.ts:91`), `expectFail(label, fn)` (`:95`). W1 Task 15 adds a public-fixture check; W4's checks go beside it. | as cited | W1 Task 15 |
| P17 | i18n: `public.json` has **194 keys** in each of `{en,es,fr,nl}` (196 lines each) today; keys are flat and dotted (`"org.competitionsBy"`, `dictionaries/en/public.json:5`). `npm run i18n:gen-keys` → `scripts/i18n/gen-keys.ts` (`package.json:39`); `apps/web/src/lib/i18n-keys.ts` is GENERATED. `npm run i18n:check` is the parity gate (`package.json:41`). | as cited | — |
| P18 | Roster reachability for the consent count: `entrants (id, division_id, org_id, kind, display_name, status)` (`db/migration/v2-engine/tables/V212__entrants.sql:4-15`) → `entrant_members (entrant_id, person_id, org_id, squad_number, …)` (`V213__entrant_members.sql:1-10`) → `persons.consent jsonb` (`V204__persons.sql:11`). An `individual`-kind entrant may have **no** `entrant_members` row at all — the empty case in Task 3. | as cited | — |
| P19 | Vitest is `environment: "node"` in `apps/web` (W3 pins `apps/web/vitest.config.ts:129`; re-pin). Nothing about the lightbox, swipe, the file picker, canvas downscale, lazy loading or the sheet is unit-testable — the `walkthrough` and `mobile.spec.ts` projects are the only witnesses. `server-only` is aliased to a stub (`vitest.config.ts:179`) so `import "server-only"` files ARE unit-testable. | as cited | — |
| P20 | **Dispatch-brief premises that contradict the spec** (recorded, not built): testids `mc-gallery-*`/`mh-gallery-*` (spec R7 and `W4-gallery.md` §6 say `gl-*`); "Gallery tab on the match centre" (the spec gives the match centre a **Photos strip**; the Gallery TAB is W2's hub only); "bound to a fixture and optionally competition" (inverted — `competition_id` is required, `division_id`/`fixture_id` nullable); a "moderation state" column (the spec's column list has none — soft delete plus "Request removal" is the mechanism); an e2e "consent-blocked image never published" (the spec's regression is "upload without the consent tick → 400" — there is no per-image consent block). The `W4-gallery.md` prompt also names the plan `../../plans/2026-09-04-spectator-w4.md`; this file follows the W2/W3 convention and `_STATE.md:20`. | as cited | — |

---

### Task 1: The migration, the storage paths, and the product constants

**Files:**
- Create: `db/migration/deltas/V392__gallery_photos.sql`
- Create: `apps/web/src/server/gallery/gallery-paths.ts`
- Test: `apps/web/src/server/gallery/__tests__/gallery-paths.test.ts`

**Interfaces:**
- Consumes: `publicStorageUrl(storagePath)` and `ASSETS_BUCKET` (`apps/web/src/lib/storage-url.ts:5,7`).
- Produces:
  ```ts
  export const GALLERY_VARIANTS: readonly ["orig", "disp", "thumb"];
  export type GalleryVariant = (typeof GALLERY_VARIANTS)[number];
  export function galleryObjectPath(orgId: string, competitionId: string, photoId: string, variant: GalleryVariant): string;
  export function galleryPublicUrl(orgId: string, competitionId: string, photoId: string, variant: GalleryVariant): string;
  export const GALLERY_MAX_BYTES = 10 * 1024 * 1024;
  export const GALLERY_MAX_PER_COMPETITION = 200;
  export const GALLERY_DISPLAY_PX = 1600;
  export const GALLERY_THUMB_PX = 400;
  ```

- [ ] **Step 1: Write the failing path test**

`apps/web/src/server/gallery/__tests__/gallery-paths.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "vitest";
import {
  GALLERY_VARIANTS,
  GALLERY_MAX_BYTES,
  GALLERY_MAX_PER_COMPETITION,
  galleryObjectPath,
  galleryPublicUrl,
} from "../gallery-paths";

const ORG = "11111111-1111-4111-8111-111111111111";
const COMP = "22222222-2222-4222-8222-222222222222";
const PHOTO = "33333333-3333-4333-8333-333333333333";

describe("gallery storage paths", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://sb.example";
  });

  it("the three variants are orig, disp, thumb — in that order", () => {
    expect([...GALLERY_VARIANTS]).toEqual(["orig", "disp", "thumb"]);
  });

  it("scopes the object under org and competition and ends in the variant", () => {
    expect(galleryObjectPath(ORG, COMP, PHOTO, "thumb")).toBe(
      `orgs/${ORG}/gallery/${COMP}/${PHOTO}/thumb.jpg`,
    );
  });

  it("the photo id segment is what makes the path unguessable — two photos never share a prefix", () => {
    const other = "44444444-4444-4444-8444-444444444444";
    expect(galleryObjectPath(ORG, COMP, PHOTO, "orig")).not.toBe(
      galleryObjectPath(ORG, COMP, other, "orig"),
    );
  });

  it("the public URL is the assets-bucket CDN URL for that path", () => {
    expect(galleryPublicUrl(ORG, COMP, PHOTO, "disp")).toBe(
      `https://sb.example/storage/v1/object/public/assets/orgs/${ORG}/gallery/${COMP}/${PHOTO}/disp.jpg`,
    );
  });

  it("with no NEXT_PUBLIC_SUPABASE_URL the URL is null, never an empty string (an <img src=\"\"> refetches the page)", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect(galleryPublicUrl(ORG, COMP, PHOTO, "thumb")).toBeNull();
  });

  it("the product constants are the spec's: 10 MB per file, 200 per competition", () => {
    expect(GALLERY_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(GALLERY_MAX_PER_COMPETITION).toBe(200);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/spectator/apps/web && \
  pnpm exec vitest run src/server/gallery/__tests__/gallery-paths.test.ts \
  --reporter=json --outputFile=/tmp/w4-t1.json
```
Expected: FAIL — `Cannot find module '../gallery-paths'`.

- [ ] **Step 3: Write `gallery-paths.ts`**

```ts
// Spectator W4 — gallery object paths and the wave's product constants.
// Deliberately free of "server-only": the public grid resolves thumb URLs in a
// client component, exactly like lib/storage-url.ts's own reasoning.
import { publicStorageUrl } from "@/lib/storage-url";

export const GALLERY_VARIANTS = ["orig", "disp", "thumb"] as const;
export type GalleryVariant = (typeof GALLERY_VARIANTS)[number];

/** 10 MB per file and 200 per competition are PRODUCT constants (spec §W4),
 *  not entitlement rows — R6 forbids a new row, and a plan-tiered quota is a
 *  v18 question for the owner. */
export const GALLERY_MAX_BYTES = 10 * 1024 * 1024;
export const GALLERY_MAX_PER_COMPETITION = 200;
export const GALLERY_DISPLAY_PX = 1600;
export const GALLERY_THUMB_PX = 400;

/** Unguessable by the random `photoId` segment, not by the bucket: every
 *  object in this repo lives in the single `assets` bucket (storage-url.ts:5),
 *  and nothing in the tree provisions a second one. */
export function galleryObjectPath(
  orgId: string,
  competitionId: string,
  photoId: string,
  variant: GalleryVariant,
): string {
  return `orgs/${orgId}/gallery/${competitionId}/${photoId}/${variant}.jpg`;
}

export function galleryPublicUrl(
  orgId: string,
  competitionId: string,
  photoId: string,
  variant: GalleryVariant,
): string | null {
  const url = publicStorageUrl(galleryObjectPath(orgId, competitionId, photoId, variant));
  return url === "" ? null : url;
}
```

- [ ] **Step 4: Run the test to verify it passes** — same command as Step 2. Expected: `numFailedTests: 0`, `numTotalTests: 6`.

- [ ] **Step 5: Write the migration**

`db/migration/deltas/V392__gallery_photos.sql` (re-pin the number against `ls db/migration/deltas | sort | tail -1` first):

```sql
-- =============================================================================
-- V392 — gallery_photos (spectator surface W4, design §W4).
--
-- One row per published photo. Bound to a COMPETITION (required — the gallery
-- is a competition surface); division and fixture are the optional match tag,
-- and both are `on delete set null` so deleting a fixture orphans the tag
-- rather than destroying the photo an organiser uploaded.
--
-- `consent_confirmed_at`/`consent_version` are NOT NULL: the staff attestation
-- is required for the upload to happen at all (spec §W4, regression "upload
-- without the consent tick -> 400"), so a row that exists without one is not a
-- state this table should be able to represent. The timestamp+version PAIR is
-- the repo's own consent convention -- a stamp names the text that was shown
-- (V363 privacy_consent_at/_version, V377 media_consent_at/_version, V384).
--
-- `deleted_at` is a soft delete because "Request removal" and staff delete must
-- 404 in every reader immediately while the storage objects are removed in the
-- same request -- a hard delete would lose who removed what and when.
--
-- No plan_entitlements row and no quota column: the gallery is on every plan
-- (R6), and the 200-per-competition cap is a product constant in
-- server/gallery/gallery-paths.ts. A plan-tiered quota is an entitlements-v18
-- question for the owner -- recorded, deliberately not built here.
--
-- Public reads bypass RLS on the superuser connection and filter through
-- public_competitions_v for visibility, exactly as V295__org_news.sql:10-13
-- describes for posts. The policy below is the ORGANISER-side tenant guard.
-- =============================================================================
create table gallery_photos (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references organizations(id) on delete cascade,
  competition_id       uuid not null references competitions(id) on delete cascade,
  division_id          uuid references divisions(id) on delete set null,
  fixture_id           uuid references fixtures(id) on delete set null,
  storage_path         text not null,
  width                int  not null check (width  > 0),
  height               int  not null check (height > 0),
  bytes                int  not null check (bytes  > 0),
  caption              text,
  taken_at             timestamptz,
  uploaded_by          uuid references users(id) on delete set null,
  consent_confirmed_at timestamptz not null,
  consent_version      text        not null,
  created_at           timestamptz not null default now(),
  deleted_at           timestamptz
);

-- The two reader indexes are partial on `deleted_at is null`: every public read
-- carries that predicate, and a removed photo must never cost the scan.
create index gallery_photos_public_idx
  on gallery_photos (competition_id, created_at desc) where deleted_at is null;
create index gallery_photos_fixture_idx
  on gallery_photos (fixture_id, created_at desc)
  where deleted_at is null and fixture_id is not null;
-- Every FK gets its own index (V376__event_imports.sql:26-31, fix round 1).
create index gallery_photos_org_idx         on gallery_photos (org_id);
create index gallery_photos_division_idx    on gallery_photos (division_id);
create index gallery_photos_uploaded_by_idx on gallery_photos (uploaded_by);
-- One row per stored object: a retried upload that reuses a path is a bug, not
-- a duplicate row.
create unique index gallery_photos_path_idx on gallery_photos (storage_path);

alter table gallery_photos enable row level security;
alter table gallery_photos force  row level security;
create policy gallery_photos_tenant on gallery_photos for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update on gallery_photos to app_user;
```

- [ ] **Step 6: Apply it and prove the table is real, not just parsed**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/spectator && npm run db:apply
```
Then, against the test DB:
```sql
select count(*) from gallery_photos;                            -- 0, not an error
insert into gallery_photos (org_id, competition_id, storage_path, width, height, bytes,
                            consent_confirmed_at, consent_version)
  values (gen_random_uuid(), gen_random_uuid(), 'x', 1, 1, 1, now(), 'v1');  -- FK violation, as designed
```
Expected: the select returns `0`; the insert fails on the `organizations` FK. Both prove the object exists. Record the actual delta number used.

- [ ] **Step 7: Commit**

```
/usr/bin/git commit -o db/migration/deltas/V392__gallery_photos.sql apps/web/src/server/gallery/gallery-paths.ts apps/web/src/server/gallery/__tests__/gallery-paths.test.ts -m "gallery(w4): gallery_photos table, storage paths and the wave's product constants

..."
```

---

### Task 2: Derivatives and the EXIF strip

**Files:**
- Create: `apps/web/src/server/gallery/gallery-image.ts`
- Test: `apps/web/src/server/gallery/__tests__/gallery-image.test.ts`

**Interfaces:**
- Consumes: `sharp` (`apps/web/package.json:55`); `GALLERY_DISPLAY_PX`, `GALLERY_THUMB_PX`, `GALLERY_MAX_BYTES` (Task 1).
- Produces:
  ```ts
  export function fitWithin(w: number, h: number, max: number): { width: number; height: number };
  export interface GalleryDerivatives {
    width: number; height: number;                    // of the ORIGINAL
    orig: Buffer; disp: Buffer; thumb: Buffer;
    takenAt: Date | null;                             // read from EXIF BEFORE stripping
  }
  export async function makeGalleryDerivatives(bytes: Buffer): Promise<GalleryDerivatives>;
  ```

- [ ] **Step 1: Write the failing test**

`apps/web/src/server/gallery/__tests__/gallery-image.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { fitWithin, makeGalleryDerivatives } from "../gallery-image";

async function jpeg(w: number, h: number): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 20, g: 90, b: 200 } } })
    .jpeg()
    .toBuffer();
}

describe("fitWithin", () => {
  // EMPTY / degenerate case FIRST (R9).
  it("an image already inside the box is returned unchanged — never upscaled", () => {
    expect(fitWithin(320, 200, 1600)).toEqual({ width: 320, height: 200 });
  });
  it("a landscape image is bounded by its WIDTH and keeps its ratio", () => {
    expect(fitWithin(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
  });
  it("a portrait image is bounded by its HEIGHT — the long edge is what the box measures", () => {
    expect(fitWithin(3000, 4000, 1600)).toEqual({ width: 1200, height: 1600 });
  });
  it("a square image hits the box on both edges", () => {
    expect(fitWithin(5000, 5000, 400)).toEqual({ width: 400, height: 400 });
  });
  it("rounding never yields a zero edge (a 4000x3 panorama)", () => {
    const { width, height } = fitWithin(4000, 3, 400);
    expect(width).toBe(400);
    expect(height).toBeGreaterThanOrEqual(1);
  });
});

describe("makeGalleryDerivatives", () => {
  it("reports the ORIGINAL dimensions, not a derivative's", async () => {
    const d = await makeGalleryDerivatives(await jpeg(2400, 1800));
    expect({ width: d.width, height: d.height }).toEqual({ width: 2400, height: 1800 });
  });

  it("display is bounded at 1600 and thumb at 400, both keeping the ratio", async () => {
    const d = await makeGalleryDerivatives(await jpeg(2400, 1800));
    expect(await sharp(d.disp).metadata()).toMatchObject({ width: 1600, height: 1200 });
    expect(await sharp(d.thumb).metadata()).toMatchObject({ width: 400, height: 300 });
  });

  it("a small original is NOT upscaled into either derivative", async () => {
    const d = await makeGalleryDerivatives(await jpeg(300, 200));
    expect(await sharp(d.disp).metadata()).toMatchObject({ width: 300, height: 200 });
    expect(await sharp(d.thumb).metadata()).toMatchObject({ width: 300, height: 200 });
  });

  // The privacy assertion this task exists for. A positive pair: the tag is
  // present on the way in and absent on every way out (a negative assertion
  // alone would pass on an input that never had EXIF).
  it("EXIF is present on the input and stripped from ALL THREE outputs (location privacy)", async () => {
    const withExif = await sharp(await jpeg(1200, 900))
      .withExif({ IFD0: { Copyright: "seazn-test" }, IFD2: { GPSLatitudeRef: "N" } })
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();

    const d = await makeGalleryDerivatives(withExif);
    for (const [name, buf] of [["orig", d.orig], ["disp", d.disp], ["thumb", d.thumb]] as const) {
      expect((await sharp(buf).metadata()).exif, `${name} still carries EXIF`).toBeUndefined();
    }
  });

  it("taken_at is read from EXIF BEFORE the strip, so the strip does not destroy it", async () => {
    const withDate = await sharp(await jpeg(800, 600))
      .withExif({ IFD0: { DateTime: "2026:08:14 15:04:05" } })
      .toBuffer();
    const d = await makeGalleryDerivatives(withDate);
    expect(d.takenAt?.toISOString().slice(0, 10)).toBe("2026-08-14");
  });

  it("no EXIF date at all → takenAt is null, never `new Date()` (a wrong day groups the photo wrongly)", async () => {
    const d = await makeGalleryDerivatives(await jpeg(800, 600));
    expect(d.takenAt).toBeNull();
  });

  it("bytes that are not an image throw a 415, not a 500", async () => {
    await expect(makeGalleryDerivatives(Buffer.from("this is not a jpeg"))).rejects.toMatchObject({
      status: 415,
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/spectator/apps/web && \
  pnpm exec vitest run src/server/gallery/__tests__/gallery-image.test.ts \
  --reporter=json --outputFile=/tmp/w4-t2.json
```
Expected: FAIL — `Cannot find module '../gallery-image'`.

- [ ] **Step 3: Write `gallery-image.ts`**

```ts
import "server-only";
// Spectator W4 — the only place gallery bytes are decoded. Two derivatives
// (thumb 400, display 1600) plus the original, all re-encoded through sharp so
// EXIF cannot survive: `.rotate()` applies the orientation tag and then drops
// it, and sharp's default `withMetadata` is OFF, so the encoder writes no EXIF
// block at all. The original is KEPT (spec §W4) but re-encoded for exactly
// this reason -- storing the uploaded bytes verbatim would publish the GPS
// coordinates of a junior fixture, which is the whole point of the strip.
import sharp from "sharp";
import { HttpError } from "@/lib/errors";
import { GALLERY_DISPLAY_PX, GALLERY_THUMB_PX } from "./gallery-paths";

export function fitWithin(w: number, h: number, max: number): { width: number; height: number } {
  if (w <= max && h <= max) return { width: w, height: h };
  const scale = max / Math.max(w, h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

export interface GalleryDerivatives {
  width: number;
  height: number;
  orig: Buffer;
  disp: Buffer;
  thumb: Buffer;
  takenAt: Date | null;
}

/** "2026:08:14 15:04:05" — EXIF's own colon-separated date form. */
function parseExifDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function makeGalleryDerivatives(bytes: Buffer): Promise<GalleryDerivatives> {
  let meta: sharp.Metadata;
  try {
    meta = await sharp(bytes).metadata();
  } catch {
    throw new HttpError(415, "That file is not an image we can read.");
  }
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width <= 0 || height <= 0) throw new HttpError(415, "That file is not an image we can read.");

  // Read the date BEFORE any re-encode: the strip is irreversible.
  const takenAt =
    parseExifDate((meta.exif ? readExifDateTime(meta.exif) : undefined)) ?? null;

  const encode = (b: sharp.Sharp) => b.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  const base = () => sharp(bytes).rotate(); // applies orientation, then drops the tag

  const dispBox = fitWithin(width, height, GALLERY_DISPLAY_PX);
  const thumbBox = fitWithin(width, height, GALLERY_THUMB_PX);

  const [orig, disp, thumb] = await Promise.all([
    encode(base()),
    encode(base().resize(dispBox.width, dispBox.height, { fit: "inside", withoutEnlargement: true })),
    encode(base().resize(thumbBox.width, thumbBox.height, { fit: "inside", withoutEnlargement: true })),
  ]);

  return { width, height, orig, disp, thumb, takenAt };
}

/** Minimal EXIF IFD0 DateTime (tag 0x0132) reader — no new dependency. Returns
 *  undefined for anything it cannot parse; the caller treats that as "no date". */
function readExifDateTime(exif: Buffer): string | undefined {
  const ascii = exif.toString("latin1");
  const m = /(\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2})/.exec(ascii);
  return m?.[1];
}
```

- [ ] **Step 4: Run the test to verify it passes** — same command as Step 2. Expected: `numFailedTests: 0`, `numTotalTests: 13`.

- [ ] **Step 5: Mutate the privacy path specifically.** Replace `base()`'s `.rotate()` with a bare `sharp(bytes)` AND add `.withMetadata()` to `encode`. Re-run: the EXIF test must go RED. Restore. A strip nothing kills is decoration.

- [ ] **Step 6: Prove sharp survives the standalone build** (P3). `cd apps/web && pnpm exec next build` on the `spx` env, then `node .next/standalone/apps/web/server.js` and hit any route that imports this module. If the native binary is missing, add `"sharp"` to `serverExternalPackages` (`apps/web/next.config.js:62`) and record it. **Do not skip this** — a green vitest proves nothing about the standalone bundle.

- [ ] **Step 7: Commit** — `gallery(w4): sharp derivatives (thumb 400 / display 1600) with EXIF stripped from all three outputs`.

---

### Task 3: The media-consent reader — and the suppression rule that keeps it honest

**Files:**
- Create: `apps/web/src/server/usecases/gallery.ts` (this task adds `readDivisionMediaConsent` only)
- Test: `apps/web/src/server/usecases/__tests__/gallery-consent.test.ts`

**Interfaces:**
- Consumes: `withTenant(orgId, fn)` (`apps/web/src/lib/db.ts:183`); the roster chain `entrants → entrant_members → persons.consent` (P18).
- Produces:
  ```ts
  export interface MediaConsentSummary {
    /** People on the tagged divisions' rosters. */
    rostered: number;
    /** People with an EXPLICIT consent.public_photo boolean, either way. */
    recorded: number;
    /** People with an explicit `false`. */
    declined: number;
    /** recorded === 0 → the org has never collected this; render nothing. */
    meaningful: boolean;
  }
  export async function readDivisionMediaConsent(
    orgId: string,
    divisionIds: readonly string[],
  ): Promise<MediaConsentSummary>;
  ```

> **Why `recorded`/`meaningful` exist.** P1: neither candidate source can distinguish "declined" from "never asked". `persons.consent.public_photo` is the right flag — it is an explicit boolean and it is what every other public photo surface reads — but no production path writes `false` today, so a bare count renders `0 declined` on every org and reads as a positive all-clear the data cannot support. `meaningful` is how the sheet tells "nobody declined" apart from "nobody was asked", and Task 9 renders a different line for each. This is failure class 6 (an absent symptom can mean suppressed, not safe) caught before it ships. Owner question Q1.

- [ ] **Step 1: Write the failing test**

`apps/web/src/server/usecases/__tests__/gallery-consent.test.ts`:

```ts
import { describe, expect, it, beforeAll } from "vitest";
import { sql } from "@/lib/db";
import { readDivisionMediaConsent } from "../gallery";

// Follows the DB-suite convention of public-lineups.test.ts: real rows, real
// SQL, skipped when DATABASE_URL is unset.
const DB = !!process.env.DATABASE_URL;
const d = DB ? describe : describe.skip;

let orgId: string, divA: string, divB: string;

async function person(consent: unknown): Promise<string> {
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, consent)
    values (${orgId}, ${"P" + Math.random().toString(36).slice(2, 8)}, ${sql.json(consent as never)})
    returning id`;
  return p!.id;
}
async function roster(divisionId: string, personIds: string[]): Promise<void> {
  const [e] = await sql<{ id: string }[]>`
    insert into entrants (division_id, org_id, kind, display_name)
    values (${divisionId}, ${orgId}, 'team', ${"E" + Math.random().toString(36).slice(2, 6)})
    returning id`;
  for (const pid of personIds) {
    await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${e!.id}, ${pid}, ${orgId})`;
  }
}

d("readDivisionMediaConsent", () => {
  beforeAll(async () => { /* seed org + two divisions; assign orgId/divA/divB */ });

  // EMPTY CASE FIRST (R9) — and it is the case that ships on day one.
  it("no divisions tagged at all → every count zero and NOT meaningful", async () => {
    expect(await readDivisionMediaConsent(orgId, [])).toEqual({
      rostered: 0, recorded: 0, declined: 0, meaningful: false,
    });
  });

  it("a division whose entrants have no roster rows → rostered 0, NOT meaningful", async () => {
    await sql`insert into entrants (division_id, org_id, kind, display_name)
              values (${divA}, ${orgId}, 'individual', 'Solo A')`;
    expect(await readDivisionMediaConsent(orgId, [divA])).toMatchObject({
      rostered: 0, recorded: 0, declined: 0, meaningful: false,
    });
  });

  // THE defect this function exists to prevent: nobody has ever been asked, so
  // "0 declined" would read as an all-clear it cannot support.
  it("a full roster with NO recorded public_photo value → declined 0 but NOT meaningful", async () => {
    await roster(divA, [await person({}), await person({ public_name: true }), await person(null)]);
    const s = await readDivisionMediaConsent(orgId, [divA]);
    expect(s.rostered).toBe(3);
    expect(s.recorded).toBe(0);
    expect(s.declined).toBe(0);
    expect(s.meaningful).toBe(false);
  });

  it("one explicit true and no false → meaningful, declined 0 (a real all-clear)", async () => {
    await roster(divB, [await person({ public_photo: true })]);
    expect(await readDivisionMediaConsent(orgId, [divB])).toMatchObject({
      recorded: 1, declined: 0, meaningful: true,
    });
  });

  it("an explicit false counts as declined and is meaningful", async () => {
    await roster(divB, [await person({ public_photo: false })]);
    expect(await readDivisionMediaConsent(orgId, [divB])).toMatchObject({
      declined: 1, meaningful: true,
    });
  });

  it("two divisions tagged: counts are the UNION, and a person on both rosters is counted ONCE", async () => {
    const shared = await person({ public_photo: false });
    await roster(divA, [shared]);
    await roster(divB, [shared]);
    const s = await readDivisionMediaConsent(orgId, [divA, divB]);
    // the shared person contributes exactly 1 to declined, not 2
    const a = await readDivisionMediaConsent(orgId, [divA]);
    const b = await readDivisionMediaConsent(orgId, [divB]);
    expect(s.declined).toBeLessThan(a.declined + b.declined);
  });

  it("another org's roster is never counted (RLS tenancy)", async () => {
    const [other] = await sql<{ id: string }[]>`
      insert into organizations (name, slug) values ('Other', ${"other-" + Date.now()}) returning id`;
    expect((await readDivisionMediaConsent(other!.id, [divA])).rostered).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/spectator/apps/web && \
  DATABASE_URL="$DATABASE_URL" pnpm exec vitest run \
  src/server/usecases/__tests__/gallery-consent.test.ts \
  --reporter=json --outputFile=/tmp/w4-t3.json
```
Expected: FAIL — `readDivisionMediaConsent is not exported`. Confirm `numTotalTests` is 7, not 0 — a module-scope throw collects zero tests and reads green.

- [ ] **Step 3: Write the reader**

`apps/web/src/server/usecases/gallery.ts` (first block of the file):

```ts
import "server-only";
// Spectator W4 -- the gallery use cases.
import { withTenant } from "@/lib/db";

export interface MediaConsentSummary {
  rostered: number;
  recorded: number;
  declined: number;
  meaningful: boolean;
}

/**
 * How many people on the tagged divisions' rosters have DECLINED to appear in
 * a photo -- and, separately, whether that number means anything.
 *
 * `persons.consent.public_photo` (V204__persons.sql:11) is the flag every other
 * public photo surface reads, and it is an explicit boolean, so `false` really
 * is a refusal. But NO production path writes `false` today: registration
 * inserts `{public_name: true}` (usecases/registrations.ts:668-671), the roster
 * inserts `{}` (usecases/entrants.ts:55-58), and only the player's own
 * self-service patch (me.ts:481), the organiser PATCH (persons.ts:130-140), the
 * merge and the v1 importer ever set it. So `declined === 0` is, on most orgs
 * today, "nobody was asked" rather than "nobody objected" -- and rendering it
 * as a count would be a false all-clear.
 *
 * `recorded` counts people with an explicit boolean EITHER WAY; `meaningful` is
 * `recorded > 0`. The sheet renders the count only when it is meaningful, and a
 * "consent has not been collected for this division" line otherwise.
 *
 * The RS007 registration-time media consent (registration_players
 * .media_consent_at, V384:19-23) is deliberately NOT the source: it is a
 * nullable timestamp, so null means declined AND never-asked, and it lives on
 * registration rows rather than on the people who take the field.
 */
export async function readDivisionMediaConsent(
  orgId: string,
  divisionIds: readonly string[],
): Promise<MediaConsentSummary> {
  // EMPTY CASE FIRST (R9): no tag, no roster, no claim.
  if (divisionIds.length === 0) {
    return { rostered: 0, recorded: 0, declined: 0, meaningful: false };
  }
  return withTenant(orgId, async (tx) => {
    const [row] = await tx<{ rostered: string; recorded: string; declined: string }[]>`
      select
        count(*)                                                              as rostered,
        count(*) filter (where jsonb_typeof(p.consent -> 'public_photo') = 'boolean') as recorded,
        count(*) filter (where p.consent -> 'public_photo' = 'false'::jsonb)          as declined
      from (
        select distinct em.person_id
        from entrant_members em
        join entrants e on e.id = em.entrant_id
        where e.division_id = any(${tx.array([...divisionIds])})
          and e.status <> 'withdrawn'
      ) r
      join persons p on p.id = r.person_id and p.merged_into is null`;
    const rostered = Number(row?.rostered ?? 0);
    const recorded = Number(row?.recorded ?? 0);
    const declined = Number(row?.declined ?? 0);
    return { rostered, recorded, declined, meaningful: recorded > 0 };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes** — same command as Step 2. Expected `numFailedTests: 0`, `numTotalTests: 7`.

- [ ] **Step 5: Mutate `meaningful`.** Replace `meaningful: recorded > 0` with `meaningful: true`. The "no recorded value → NOT meaningful" test must go RED. Then replace it with `meaningful: false` — the "one explicit true" test must go RED. Two mutants, one at a time; both must kill. Restore.

- [ ] **Step 6: Commit** — `gallery(w4): media-consent reader with a suppression rule for the never-collected case`.

---

### Task 4: Quota, authorisation and the write path

**Files:**
- Modify: `apps/web/src/server/usecases/gallery.ts`
- Test: `apps/web/src/server/usecases/__tests__/gallery.test.ts`

**Interfaces:**
- Consumes: `readDivisionMediaConsent` (Task 3); `makeGalleryDerivatives` (Task 2); `galleryObjectPath`, `GALLERY_MAX_BYTES`, `GALLERY_MAX_PER_COMPETITION` (Task 1); `withTenant` (`db.ts:183`); `supabaseAdmin()` (`lib/supabase-admin.ts:6`); `ASSETS_BUCKET` (`lib/storage-url.ts:5`); `HttpError` (`lib/errors.ts`); `ORG_ROLES`/`OrgRole` (`lib/types.ts:21-22`).
- Produces:
  ```ts
  export const GALLERY_UPLOAD_ROLES: readonly OrgRole[]; // ["owner","admin","scorer"]
  export interface GalleryPhotoRow {
    id: string; competition_id: string; division_id: string | null; fixture_id: string | null;
    storage_path: string; width: number; height: number; bytes: number;
    caption: string | null; taken_at: Date | null; uploaded_by: string | null; created_at: Date;
  }
  export async function assertGalleryQuota(orgId: string, competitionId: string, adding: number): Promise<void>;
  export async function uploadGalleryPhoto(input: {
    orgId: string; userId: string; competitionId: string;
    divisionId: string | null; fixtureId: string | null;
    caption: string | null; consentConfirmed: boolean;
    contentType: string; bytes: Buffer;
  }): Promise<GalleryPhotoRow>;
  export async function softDeleteGalleryPhoto(orgId: string, photoId: string): Promise<{ deleted: true }>;
  ```

- [ ] **Step 1: Write the failing test**

`apps/web/src/server/usecases/__tests__/gallery.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

const store = vi.hoisted(() => ({ upload: vi.fn(), remove: vi.fn() }));
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: () => ({ storage: { from: () => ({ upload: store.upload, remove: store.remove }) } }),
}));

import { GALLERY_UPLOAD_ROLES, assertGalleryQuota, uploadGalleryPhoto } from "../gallery";
import { GALLERY_MAX_BYTES, GALLERY_MAX_PER_COMPETITION } from "@/server/gallery/gallery-paths";
import sharp from "sharp";

const jpeg = () =>
  sharp({ create: { width: 1200, height: 900, channels: 3, background: "#123456" } }).jpeg().toBuffer();

describe("GALLERY_UPLOAD_ROLES", () => {
  // The role matrix, stated as a table so a role added to ORG_ROLES cannot
  // silently gain or lose upload.
  it.each([
    ["owner", true], ["admin", true], ["scorer", true], ["viewer", false],
  ] as const)("%s may upload: %s", (role, allowed) => {
    expect(GALLERY_UPLOAD_ROLES.includes(role)).toBe(allowed);
  });

  it("is NOT EDITOR_ROLES — a scorer is exactly who is at the ground with a phone", async () => {
    const { EDITOR_ROLES } = await import("@/lib/types");
    expect([...GALLERY_UPLOAD_ROLES]).not.toEqual([...EDITOR_ROLES]);
    expect(GALLERY_UPLOAD_ROLES).toContain("scorer");
  });
});

describe("uploadGalleryPhoto — the refusals", () => {
  beforeEach(() => { store.upload.mockResolvedValue({ error: null }); });

  const base = async () => ({
    orgId: "o", userId: "u", competitionId: "c", divisionId: null, fixtureId: null,
    caption: null, consentConfirmed: true, contentType: "image/jpeg", bytes: await jpeg(),
  });

  it("consent tick absent → 400, and NOTHING reaches storage", async () => {
    await expect(uploadGalleryPhoto({ ...(await base()), consentConfirmed: false }))
      .rejects.toMatchObject({ status: 400 });
    expect(store.upload).not.toHaveBeenCalled();
  });

  it("over the 10 MB cap → 413, and NOTHING reaches storage", async () => {
    const big = Buffer.alloc(GALLERY_MAX_BYTES + 1, 1);
    await expect(uploadGalleryPhoto({ ...(await base()), bytes: big }))
      .rejects.toMatchObject({ status: 413 });
    expect(store.upload).not.toHaveBeenCalled();
  });

  it("a content type outside the allow-list → 415 before sharp is asked to decode it", async () => {
    await expect(uploadGalleryPhoto({ ...(await base()), contentType: "image/svg+xml" }))
      .rejects.toMatchObject({ status: 415 });
  });

  it("a storage failure is a 502 and does NOT leave a row behind", async () => {
    store.upload.mockResolvedValue({ error: { message: "bucket gone" } });
    await expect(uploadGalleryPhoto(await base())).rejects.toMatchObject({ status: 502 });
  });

  it("all THREE variants are uploaded before the row is written", async () => {
    await uploadGalleryPhoto(await base()).catch(() => {});
    const paths = store.upload.mock.calls.map((c) => String(c[0]));
    expect(paths.filter((p) => p.endsWith("/orig.jpg"))).toHaveLength(1);
    expect(paths.filter((p) => p.endsWith("/disp.jpg"))).toHaveLength(1);
    expect(paths.filter((p) => p.endsWith("/thumb.jpg"))).toHaveLength(1);
  });
});
```

And the quota ladder, empty case first (DB suite, same file, `describe.skipIf(!process.env.DATABASE_URL)`):

```ts
describe("assertGalleryQuota — the ladder, empty case first", () => {
  it("a competition with ZERO photos accepts an upload", async () => {
    await expect(assertGalleryQuota(orgId, emptyComp, 1)).resolves.toBeUndefined();
  });
  it("at cap minus one, adding one is allowed — the boundary is inclusive on the way in", async () => {
    await seedPhotos(nearComp, GALLERY_MAX_PER_COMPETITION - 1);
    await expect(assertGalleryQuota(orgId, nearComp, 1)).resolves.toBeUndefined();
  });
  it("AT the cap, adding one is refused with 409 and the cap in the message", async () => {
    await seedPhotos(fullComp, GALLERY_MAX_PER_COMPETITION);
    await expect(assertGalleryQuota(orgId, fullComp, 1)).rejects.toMatchObject({ status: 409 });
  });
  it("SOFT-DELETED photos do not count against the cap — removing one frees a slot", async () => {
    await sql`update gallery_photos set deleted_at = now()
              where competition_id = ${fullComp} and deleted_at is null
              and id = (select id from gallery_photos where competition_id = ${fullComp} limit 1)`;
    await expect(assertGalleryQuota(orgId, fullComp, 1)).resolves.toBeUndefined();
  });
  it("another competition's photos never count against this one", async () => {
    await expect(assertGalleryQuota(orgId, emptyComp, 1)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/spectator/apps/web && \
  pnpm exec vitest run src/server/usecases/__tests__/gallery.test.ts \
  --reporter=json --outputFile=/tmp/w4-t4.json
```
Expected: FAIL — the three symbols are not exported.

- [ ] **Step 3: Implement** (appended to `apps/web/src/server/usecases/gallery.ts`)

```ts
import { randomUUID } from "node:crypto";
import { HttpError } from "@/lib/errors";
import type { OrgRole } from "@/lib/types";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { ASSETS_BUCKET } from "@/lib/storage-url";
import { LEGAL_VERSION } from "@/lib/legal";
import { makeGalleryDerivatives } from "@/server/gallery/gallery-image";
import {
  GALLERY_MAX_BYTES,
  GALLERY_MAX_PER_COMPETITION,
  galleryObjectPath,
  type GalleryVariant,
} from "@/server/gallery/gallery-paths";

/** Staff OR scorer (spec §W4). Deliberately NOT EDITOR_ROLES: `scorer` is in
 *  neither EDITOR_ROLES nor READ_ROLES (lib/types.ts:25,28), and a scorer is
 *  exactly the person standing at the ground with a phone. */
export const GALLERY_UPLOAD_ROLES: readonly OrgRole[] = ["owner", "admin", "scorer"];

const ACCEPTED = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

export interface GalleryPhotoRow {
  id: string; competition_id: string; division_id: string | null; fixture_id: string | null;
  storage_path: string; width: number; height: number; bytes: number;
  caption: string | null; taken_at: Date | null; uploaded_by: string | null; created_at: Date;
}

export async function assertGalleryQuota(
  orgId: string,
  competitionId: string,
  adding: number,
): Promise<void> {
  const used = await withTenant(orgId, async (tx) => {
    const [row] = await tx<{ n: string }[]>`
      select count(*) as n from gallery_photos
      where competition_id = ${competitionId} and deleted_at is null`;
    return Number(row?.n ?? 0);
  });
  if (used + adding > GALLERY_MAX_PER_COMPETITION) {
    throw new HttpError(
      409,
      `This competition already holds ${used} of ${GALLERY_MAX_PER_COMPETITION} photos. Remove some to add more.`,
    );
  }
}

export async function uploadGalleryPhoto(input: {
  orgId: string; userId: string; competitionId: string;
  divisionId: string | null; fixtureId: string | null;
  caption: string | null; consentConfirmed: boolean;
  contentType: string; bytes: Buffer;
}): Promise<GalleryPhotoRow> {
  // Order matters: the cheap refusals run BEFORE sharp decodes anything and
  // before a single byte reaches storage.
  if (!input.consentConfirmed) {
    throw new HttpError(400, "Confirm that everyone pictured has media consent before uploading.");
  }
  if (input.bytes.byteLength > GALLERY_MAX_BYTES) {
    throw new HttpError(413, "That photo is over 10 MB. Try again — your phone can send a smaller copy.");
  }
  if (!ACCEPTED.has(input.contentType)) {
    throw new HttpError(415, `We cannot read '${input.contentType}'. Use a JPEG, PNG or HEIC photo.`);
  }
  await assertGalleryQuota(input.orgId, input.competitionId, 1);

  const derived = await makeGalleryDerivatives(input.bytes);
  const photoId = randomUUID();
  const sb = supabaseAdmin();
  const put = async (variant: GalleryVariant, body: Buffer) => {
    const path = galleryObjectPath(input.orgId, input.competitionId, photoId, variant);
    const { error } = await sb.storage
      .from(ASSETS_BUCKET)
      .upload(path, body, { contentType: "image/jpeg", upsert: false });
    if (error) throw new HttpError(502, `photo upload failed: ${error.message}`);
    return path;
  };
  // Bytes first, row last: a row whose objects are missing is a broken card in
  // the grid; objects with no row are invisible garbage the next upload
  // overwrites. Prefer the second failure mode.
  const origPath = await put("orig", derived.orig);
  await put("disp", derived.disp);
  await put("thumb", derived.thumb);

  return withTenant(input.orgId, async (tx) => {
    const [row] = await tx<GalleryPhotoRow[]>`
      insert into gallery_photos
        (id, org_id, competition_id, division_id, fixture_id, storage_path,
         width, height, bytes, caption, taken_at, uploaded_by,
         consent_confirmed_at, consent_version)
      values
        (${photoId}, ${input.orgId}, ${input.competitionId}, ${input.divisionId},
         ${input.fixtureId}, ${origPath}, ${derived.width}, ${derived.height},
         ${input.bytes.byteLength}, ${input.caption}, ${derived.takenAt},
         ${input.userId}, now(), ${LEGAL_VERSION})
      returning id, competition_id, division_id, fixture_id, storage_path,
                width, height, bytes, caption, taken_at, uploaded_by, created_at`;
    return row!;
  });
}

export async function softDeleteGalleryPhoto(
  orgId: string,
  photoId: string,
): Promise<{ deleted: true }> {
  const row = await withTenant(orgId, async (tx) => {
    const [r] = await tx<{ competition_id: string }[]>`
      update gallery_photos set deleted_at = now()
      where id = ${photoId} and deleted_at is null
      returning competition_id`;
    return r ?? null;
  });
  if (!row) throw new HttpError(404, "photo not found");
  // Derivatives AND the original leave storage in the same request (spec §W4).
  const paths = (["orig", "disp", "thumb"] as const).map((v) =>
    galleryObjectPath(orgId, row.competition_id, photoId, v),
  );
  const { error } = await supabaseAdmin().storage.from(ASSETS_BUCKET).remove(paths);
  if (error) console.warn(`[gallery] storage remove failed for ${photoId}:`, error.message);
  return { deleted: true };
}
```

- [ ] **Step 4: Run the test to verify it passes** — same command as Step 2. Paste `numTotalTests`/`numFailedTests`.

- [ ] **Step 5: Mutate the money path — the consent guard.** Delete the `if (!input.consentConfirmed) throw` block entirely. The "consent tick absent → 400, and NOTHING reaches storage" test must go RED. Then restore it and instead change `!input.consentConfirmed` to `input.consentConfirmed === undefined` — the test must STILL go red (a `false` tick now passes). Both mutants must kill; a guard nothing kills is decoration.

- [ ] **Step 6: Mutate the quota boundary.** Change `used + adding > GALLERY_MAX_PER_COMPETITION` to `>=`. The "at cap minus one, adding one is allowed" test must go RED — that is the boundary row earning its place.

- [ ] **Step 7: Commit** — `gallery(w4): upload use case — role set, consent guard, size/type refusals, quota ladder, soft delete`.

---

### Task 5: The API routes, their schemas, and the OpenAPI entries

**Files:**
- Create: `apps/web/src/app/api/v1/competitions/[id]/gallery/route.ts`
- Create: `apps/web/src/app/api/v1/gallery/[photoId]/route.ts`
- Modify: `apps/web/src/server/api-v1/schemas.ts`
- Modify: `apps/web/src/server/api-v1/openapi.ts:57+` (`ROUTES`)
- Modify: `apps/web/src/server/api-v1/key-scopes.ts:296` (`NEVER_KEY_ROUTES`)
- Test: `apps/web/src/app/api/v1/competitions/[id]/gallery/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `v1` (`server/api-v1/http.ts:124`), `reply` (`:96`); `resourceOrg("competition", id)` (`server/api-v1/auth.ts:342`); `requireOrgRole(orgId, roles)` (`lib/auth.ts:456`); `rateLimit`, `MUTATION_LIMIT` (`lib/rate-limit.ts:36,74`); `GALLERY_UPLOAD_ROLES`, `uploadGalleryPhoto`, `softDeleteGalleryPhoto`, `readDivisionMediaConsent` (Tasks 3–4).
- Produces:
  - `POST /api/v1/competitions/{id}/gallery` — multipart, one `file` entry per request, fields `division_id?`, `fixture_id?`, `caption?`, `consent_confirmed` (`"1"`), → `201 { photo }`.
  - `GET /api/v1/competitions/{id}/gallery/consent?division_ids=a,b` → `200 MediaConsentSummary` (staff only — the count is roster data).
  - `DELETE /api/v1/gallery/{photoId}` → `200 { deleted: true }`.

> The three routes are session-only. `requireOrgRole` calls `requireUser()`, so a bearer key never reaches the role check; the `NEVER_KEY_ROUTES` entries make that structural rather than incidental — the same reasoning `"POST /divisions/:id/logo-upload-url"` carries at `key-scopes.ts:331`.

- [ ] **Step 1: Write the failing route test**

`apps/web/src/app/api/v1/competitions/[id]/gallery/__tests__/route.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => {}), MUTATION_LIMIT: { max: 60, windowSeconds: 60 } }));
const auth = vi.hoisted(() => ({ resourceOrg: vi.fn(), requireOrgRole: vi.fn() }));
vi.mock("@/server/api-v1/auth", async (o) => ({ ...(await o<typeof import("@/server/api-v1/auth")>()), resourceOrg: auth.resourceOrg }));
vi.mock("@/lib/auth", async (o) => ({ ...(await o<typeof import("@/lib/auth")>()), requireOrgRole: auth.requireOrgRole }));
const uc = vi.hoisted(() => ({ uploadGalleryPhoto: vi.fn() }));
vi.mock("@/server/usecases/gallery", async (o) => ({ ...(await o<typeof import("@/server/usecases/gallery")>()), uploadGalleryPhoto: uc.uploadGalleryPhoto }));

import { POST } from "../route";
import { AuthError } from "@/lib/errors";

const ctx = { params: Promise.resolve({ id: "c1" }) };
const form = (over: Record<string, string | Blob> = {}) => {
  const f = new FormData();
  f.set("file", new File([new Uint8Array([1, 2, 3])], "a.jpg", { type: "image/jpeg" }));
  f.set("consent_confirmed", "1");
  for (const [k, v] of Object.entries(over)) f.set(k, v);
  return f;
};
const req = (f: FormData) => new Request("http://x/api/v1/competitions/c1/gallery", { method: "POST", body: f });

describe("POST /api/v1/competitions/{id}/gallery", () => {
  beforeEach(() => {
    auth.resourceOrg.mockResolvedValue("org-1");
    auth.requireOrgRole.mockResolvedValue({ user: { id: "u1" }, role: "scorer" });
    uc.uploadGalleryPhoto.mockResolvedValue({ id: "p1", competition_id: "c1" });
  });

  it("a signed-in scorer uploads and gets 201 with the row", async () => {
    const res = await POST(req(form()), ctx);
    expect(res.status).toBe(201);
    expect((await res.json()).data.photo.id).toBe("p1");
  });

  // THE regression the spec names.
  it("anonymous → 401, and the use case is never reached", async () => {
    auth.requireOrgRole.mockRejectedValue(new AuthError("You must be signed in"));
    const res = await POST(req(form()), ctx);
    expect(res.status).toBe(401);
    expect(uc.uploadGalleryPhoto).not.toHaveBeenCalled();
  });

  it("a viewer → 401/403, never a silent success", async () => {
    auth.requireOrgRole.mockRejectedValue(new AuthError("Insufficient permissions"));
    expect((await POST(req(form()), ctx)).status).toBe(401);
  });

  it("the role check asks for GALLERY_UPLOAD_ROLES, not EDITOR_ROLES", async () => {
    await POST(req(form()), ctx);
    const [, roles] = auth.requireOrgRole.mock.calls[0]!;
    expect(roles).toContain("scorer");
  });

  it("no `file` entry → 400 before any storage work", async () => {
    const f = form(); f.delete("file");
    expect((await POST(req(f), ctx)).status).toBe(400);
  });

  it("consent_confirmed absent → the use case is called with consentConfirmed false (the 400 is ITS ruling, one authority)", async () => {
    const f = form(); f.delete("consent_confirmed");
    await POST(req(f), ctx);
    expect(uc.uploadGalleryPhoto).toHaveBeenCalledWith(expect.objectContaining({ consentConfirmed: false }));
  });

  it("the fixture tag rides through verbatim", async () => {
    await POST(req(form({ fixture_id: "f1", division_id: "d1", caption: "Winning six" })), ctx);
    expect(uc.uploadGalleryPhoto).toHaveBeenCalledWith(
      expect.objectContaining({ fixtureId: "f1", divisionId: "d1", caption: "Winning six" }),
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/spectator/apps/web && \
  pnpm exec vitest run "src/app/api/v1/competitions/[id]/gallery/__tests__/route.test.ts" \
  --reporter=json --outputFile=/tmp/w4-t5.json
```
Expected: FAIL — the route module does not exist.

- [ ] **Step 3: Write the upload route**

`apps/web/src/app/api/v1/competitions/[id]/gallery/route.ts`:

```ts
import { v1, reply } from "@/server/api-v1/http";
import { resourceOrg } from "@/server/api-v1/auth";
import { requireOrgRole } from "@/lib/auth";
import { HttpError } from "@/lib/errors";
import { rateLimit, MUTATION_LIMIT } from "@/lib/rate-limit";
import { GALLERY_UPLOAD_ROLES, uploadGalleryPhoto } from "@/server/usecases/gallery";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/v1/competitions/[id]/gallery — ONE photo per request (multipart
 *  `file`), so the sheet gets per-file progress and per-file retry for free and
 *  no single request carries ten 10 MB bodies. Session-only: `requireOrgRole`
 *  goes through `requireUser()`, and the route is on NEVER_KEY_ROUTES. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const orgId = await resourceOrg("competition", id);
    const { user } = await requireOrgRole(orgId, GALLERY_UPLOAD_ROLES);
    await rateLimit(`gallery:${orgId}`, MUTATION_LIMIT);

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new HttpError(400, "multipart 'file' entry required");

    const str = (k: string) => {
      const v = form.get(k);
      return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
    };
    const photo = await uploadGalleryPhoto({
      orgId,
      userId: user.id,
      competitionId: id,
      divisionId: str("division_id"),
      fixtureId: str("fixture_id"),
      caption: str("caption"),
      // The 400 is the use case's ruling (one authority per fact) — the route
      // only reports what the form said.
      consentConfirmed: form.get("consent_confirmed") === "1",
      contentType: file.type,
      bytes: Buffer.from(await file.arrayBuffer()),
    });
    return reply(201, { photo });
  });
}
```

`apps/web/src/app/api/v1/gallery/[photoId]/route.ts`:

```ts
import { v1 } from "@/server/api-v1/http";
import { sql } from "@/lib/db";
import { assertUuid } from "@/server/api-v1/auth";
import { requireOrgRole } from "@/lib/auth";
import { HttpError } from "@/lib/errors";
import { GALLERY_UPLOAD_ROLES, softDeleteGalleryPhoto } from "@/server/usecases/gallery";
import { fireGalleryRevalidate } from "@/server/public-site/revalidate";

type Ctx = { params: Promise<{ photoId: string }> };

/** DELETE /api/v1/gallery/[photoId] — any staff member may remove from the
 *  lightbox (spec §W4). `gallery_photos` is not in ORG_TABLES, so the owning
 *  org is resolved here on the superuser connection before the role check. */
export async function DELETE(_req: Request, { params }: Ctx) {
  return v1(async () => {
    const { photoId } = await params;
    assertUuid(photoId, "photo");
    const [row] = await sql<{ org_id: string; competition_id: string; division_id: string | null }[]>`
      select org_id, competition_id, division_id from gallery_photos
      where id = ${photoId} and deleted_at is null limit 1`;
    if (!row) throw new HttpError(404, "photo not found");
    await requireOrgRole(row.org_id, GALLERY_UPLOAD_ROLES);
    const out = await softDeleteGalleryPhoto(row.org_id, photoId);
    fireGalleryRevalidate(row.competition_id, row.division_id);
    return out;
  });
}
```

- [ ] **Step 4: Register the routes in `ROUTES`** (`openapi.ts`, after the competitions block at `:57-64`):

```ts
  // Spectator W4 — the gallery. Session-only (NEVER_KEY_ROUTES): a leaked key
  // must not be able to publish images on an org's public page.
  { path: "/competitions/{id}/gallery", method: "post", summary: "Upload one gallery photo (multipart `file`; staff/scorer session only; media-consent tick required)", tag: "gallery", response: z.object({ photo: S.GalleryPhoto }), status: 201, errors: [400, 403, 404, 409, 413, 415, 502] },
  { path: "/competitions/{id}/gallery", method: "get", summary: "List a competition's gallery photos (staff view — includes the uploader)", tag: "gallery", response: z.array(S.GalleryPhoto) },
  { path: "/gallery/{photoId}", method: "delete", summary: "Soft-delete a gallery photo; derivatives and original leave storage in the same request", tag: "gallery", response: z.object({ deleted: z.boolean() }), errors: [403, 404] },
```

and in `key-scopes.ts` `NEVER_KEY_ROUTES` (beside `:331`):

```ts
  // Spectator W4: publishing images on an org's PUBLIC page is a console/staff
  // UX, not an API surface — the same reasoning as logo-upload-url above.
  "POST /competitions/:id/gallery",
  "GET /competitions/:id/gallery",
  "DELETE /gallery/:photoId",
```

- [ ] **Step 5: Add the schemas** (`schemas.ts`, beside the post schemas at `:4384`):

```ts
export const GalleryPhoto = z.object({
  id: Uuid,
  competition_id: Uuid,
  division_id: Uuid.nullable(),
  fixture_id: Uuid.nullable(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  caption: z.string().nullable(),
  taken_at: z.string().nullable(),
  created_at: z.string(),
  thumb_url: z.string().nullable(),
  display_url: z.string().nullable(),
});
export const GalleryConsentSummary = z.object({
  rostered: z.number().int(),
  recorded: z.number().int(),
  declined: z.number().int(),
  meaningful: z.boolean(),
});
```

- [ ] **Step 6: Regenerate the spec and prove the drift gate is clean — FIRST, not last** (the wave's own gate order, `W4-gallery.md` §Gates):

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/spectator && npm run openapi:gen
/usr/bin/git status --porcelain openapi
```
Expected: `openapi/v1.json` and `openapi/v1.public.json` are MODIFIED (three new paths); running `openapi:gen` a second time then leaves them clean. Then:
```bash
cd apps/web && pnpm exec vitest run src/server/api-v1/__tests__/openapi-coverage.test.ts \
  --reporter=json --outputFile=/tmp/w4-t5b.json
```
Expected: PASS — the registry now matches the route files 1:1. A missing `ROUTES` row fails here, not in CI.

- [ ] **Step 7: Run the route test to verify it passes** — the Step 2 command. Expected `numTotalTests: 7`, `numFailedTests: 0`.

- [ ] **Step 8: Commit** — `gallery(w4): upload/list/delete routes, schemas, OpenAPI entries and the session-only key ban`.

---

### Task 6: The public read model, the two documents, and cache invalidation

**Files:**
- Create: `apps/web/src/server/public-site/gallery-photos.ts`
- Modify: `apps/web/src/server/public-site/match-centre-schema.ts:59-72`
- Modify: `apps/web/src/server/public-site/data.ts:689-747` (`getPublicFixture`)
- Modify: `apps/web/src/server/public-site/competition-hub.ts` (W2 Task 4 — see P6)
- Modify: `apps/web/src/server/public-site/revalidate.ts`
- Modify: `apps/web/src/server/usecases/public.ts`
- Test: `apps/web/src/server/public-site/__tests__/gallery-photos.test.ts`

**Interfaces:**
- Consumes: `sql` (`lib/db.ts`), `public_competitions_v` (visibility filter, P13); `galleryPublicUrl` (Task 1); `cached` (`usecases/public.ts:32`), `PUBLIC_CACHE_CONTROL` (`:20`); `divisionTag`, `competitionTag`, `REVALIDATE_FAST` (`data.ts:136-143`).
- Produces:
  ```ts
  // gallery-photos.ts
  export interface PublicGalleryPhoto {
    id: string; fixtureId: string | null; divisionId: string | null;
    caption: string | null; width: number; height: number;
    thumbUrl: string | null; displayUrl: string | null;
    takenAt: string | null; createdAt: string;
  }
  export async function readCompetitionGallery(competitionId: string): Promise<PublicGalleryPhoto[]>;
  export async function readFixturePhotos(fixtureId: string, limit: number): Promise<PublicGalleryPhoto[]>;
  export interface GalleryDayGroup { day: string; matches: { fixtureId: string | null; photos: PublicGalleryPhoto[] }[] }
  export function groupGalleryByDay(photos: readonly PublicGalleryPhoto[], tz: string): GalleryDayGroup[];
  // match-centre-schema.ts
  export const GalleryPhotoRef: z.ZodObject<...>;
  // MatchCentreDoc gains: photos: z.array(GalleryPhotoRef).default([])
  // revalidate.ts
  export function fireGalleryRevalidate(competitionId: string, divisionId: string | null): void;
  ```

- [ ] **Step 1: Write the failing test**

`apps/web/src/server/public-site/__tests__/gallery-photos.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { groupGalleryByDay, type PublicGalleryPhoto } from "../gallery-photos";

const p = (over: Partial<PublicGalleryPhoto>): PublicGalleryPhoto => ({
  id: "x", fixtureId: null, divisionId: null, caption: null, width: 1600, height: 1200,
  thumbUrl: "t", displayUrl: "d", takenAt: null, createdAt: "2026-08-14T09:00:00.000Z", ...over,
});

describe("groupGalleryByDay", () => {
  // EMPTY CASE FIRST (R9). The tab is hidden when this is empty, so the empty
  // shape is what the presence rule reads.
  it("no photos → no groups (never a group with an empty photo list)", () => {
    expect(groupGalleryByDay([], "Europe/London")).toEqual([]);
  });

  it("one photo → one day, one match bucket", () => {
    const g = groupGalleryByDay([p({ id: "a" })], "Europe/London");
    expect(g).toHaveLength(1);
    expect(g[0]!.day).toBe("2026-08-14");
    expect(g[0]!.matches[0]!.photos.map((x) => x.id)).toEqual(["a"]);
  });

  it("takenAt wins over createdAt — the day a photo was TAKEN is the day it belongs to", () => {
    const g = groupGalleryByDay(
      [p({ id: "a", takenAt: "2026-08-13T18:00:00.000Z", createdAt: "2026-08-14T09:00:00.000Z" })],
      "Europe/London",
    );
    expect(g[0]!.day).toBe("2026-08-13");
  });

  it("the day is the ORG's timezone, not UTC — a 23:30 local photo does not jump to tomorrow", () => {
    const g = groupGalleryByDay([p({ createdAt: "2026-08-14T22:30:00.000Z" })], "Europe/London");
    expect(g[0]!.day).toBe("2026-08-14");
    const nz = groupGalleryByDay([p({ createdAt: "2026-08-14T22:30:00.000Z" })], "Pacific/Auckland");
    expect(nz[0]!.day).toBe("2026-08-15");
  });

  // ORDER-DIFFERENTIAL case: newest day first, and within a day, source order.
  it("days come back newest first — three days, not two, so the order cannot be luck", () => {
    const g = groupGalleryByDay(
      [p({ createdAt: "2026-08-12T10:00:00Z" }), p({ createdAt: "2026-08-14T10:00:00Z" }), p({ createdAt: "2026-08-13T10:00:00Z" })],
      "UTC",
    );
    expect(g.map((x) => x.day)).toEqual(["2026-08-14", "2026-08-13", "2026-08-12"]);
  });

  it("photos of DIFFERENT matches on the same day are separate buckets; untagged photos get their own", () => {
    const g = groupGalleryByDay(
      [p({ id: "a", fixtureId: "f1" }), p({ id: "b", fixtureId: "f2" }), p({ id: "c", fixtureId: null })],
      "UTC",
    );
    expect(g[0]!.matches.map((m) => m.fixtureId)).toEqual(["f1", "f2", null]);
  });
});
```

Plus the DB half (same file, `describe.skipIf(!process.env.DATABASE_URL)`):

```ts
it("a SOFT-DELETED photo is absent from readCompetitionGallery AND readFixturePhotos", async () => {
  await sql`update gallery_photos set deleted_at = now() where id = ${photoId}`;
  expect((await readCompetitionGallery(compId)).map((x) => x.id)).not.toContain(photoId);
  expect((await readFixturePhotos(fixtureId, 6)).map((x) => x.id)).not.toContain(photoId);
});
it("a PRIVATE competition's photos are never returned (public_competitions_v is the gate)", async () => {
  await sql`update competitions set visibility = 'private' where id = ${compId}`;
  expect(await readCompetitionGallery(compId)).toEqual([]);
});
it("readFixturePhotos honours its limit and returns newest first", async () => {
  const got = await readFixturePhotos(fixtureId, 6);
  expect(got.length).toBeLessThanOrEqual(6);
  expect([...got].sort((a, b) => b.createdAt.localeCompare(a.createdAt))).toEqual(got);
});
```

- [ ] **Step 2: Run it to verify it fails** —
```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/spectator/apps/web && \
  pnpm exec vitest run src/server/public-site/__tests__/gallery-photos.test.ts \
  --reporter=json --outputFile=/tmp/w4-t6.json
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write `gallery-photos.ts`**

```ts
import "server-only";
// Spectator W4 -- the public gallery read model. Like every other public read
// in this tree it runs on the superuser `sql` connection and takes its
// visibility from public_competitions_v rather than from RLS (the rule
// V295__org_news.sql:10-13 states for posts).
import { sql } from "@/lib/db";
import { galleryPublicUrl } from "@/server/gallery/gallery-paths";

export interface PublicGalleryPhoto {
  id: string; fixtureId: string | null; divisionId: string | null;
  caption: string | null; width: number; height: number;
  thumbUrl: string | null; displayUrl: string | null;
  takenAt: string | null; createdAt: string;
}

interface Row {
  id: string; org_id: string; competition_id: string;
  division_id: string | null; fixture_id: string | null;
  caption: string | null; width: number; height: number;
  taken_at: Date | null; created_at: Date;
}

const toPublic = (r: Row): PublicGalleryPhoto => ({
  id: r.id,
  fixtureId: r.fixture_id,
  divisionId: r.division_id,
  caption: r.caption,
  width: r.width,
  height: r.height,
  thumbUrl: galleryPublicUrl(r.org_id, r.competition_id, r.id, "thumb"),
  displayUrl: galleryPublicUrl(r.org_id, r.competition_id, r.id, "disp"),
  takenAt: r.taken_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
});

export async function readCompetitionGallery(competitionId: string): Promise<PublicGalleryPhoto[]> {
  const rows = await sql<Row[]>`
    select g.id, g.org_id, g.competition_id, g.division_id, g.fixture_id,
           g.caption, g.width, g.height, g.taken_at, g.created_at
    from gallery_photos g
    join public_competitions_v c on c.id = g.competition_id
    where g.competition_id = ${competitionId} and g.deleted_at is null
    order by coalesce(g.taken_at, g.created_at) desc, g.created_at desc`;
  return rows.map(toPublic);
}

export async function readFixturePhotos(fixtureId: string, limit: number): Promise<PublicGalleryPhoto[]> {
  const rows = await sql<Row[]>`
    select g.id, g.org_id, g.competition_id, g.division_id, g.fixture_id,
           g.caption, g.width, g.height, g.taken_at, g.created_at
    from gallery_photos g
    join public_competitions_v c on c.id = g.competition_id
    where g.fixture_id = ${fixtureId} and g.deleted_at is null
    order by g.created_at desc
    limit ${limit}`;
  return rows.map(toPublic);
}

export interface GalleryDayGroup {
  day: string;
  matches: { fixtureId: string | null; photos: PublicGalleryPhoto[] }[];
}

/** Day groups in the ORG's timezone, newest day first; within a day, matches in
 *  first-seen order with untagged photos last. EMPTY IN, EMPTY OUT (R9) --
 *  never a group carrying an empty photo list, because the tab's presence rule
 *  reads `groups.length`. */
export function groupGalleryByDay(
  photos: readonly PublicGalleryPhoto[],
  tz: string,
): GalleryDayGroup[] {
  if (photos.length === 0) return [];
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const days = new Map<string, Map<string, PublicGalleryPhoto[]>>();
  for (const p of photos) {
    const day = fmt.format(new Date(p.takenAt ?? p.createdAt));
    const key = p.fixtureId ?? " untagged";
    const buckets = days.get(day) ?? new Map();
    days.set(day, buckets);
    buckets.set(key, [...(buckets.get(key) ?? []), p]);
  }
  return [...days.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, buckets]) => ({
      day,
      matches: [...buckets.entries()]
        .sort((a, b) => (a[0] === " untagged" ? 1 : b[0] === " untagged" ? -1 : 0))
        .map(([k, ps]) => ({ fixtureId: k === " untagged" ? null : k, photos: ps })),
    }));
}
```

- [ ] **Step 4: Extend the match-centre document** (`match-centre-schema.ts`, after `InfoView` at `:57`):

```ts
// Spectator W4 — the Photos strip. Photos ride the SAME document the page
// rendered from and the poll refreshes, so R10's in-place update needs no new
// transport (R6/R10). `.default([])` so a document built before this field
// existed still parses.
export const GalleryPhotoRef = z.object({
  id: z.string(), caption: z.string().nullable(),
  width: z.number(), height: z.number(),
  thumbUrl: z.string().nullable(), displayUrl: z.string().nullable(),
  createdAt: z.string(),
});
export type GalleryPhotoRefT = z.infer<typeof GalleryPhotoRef>;
```
and inside `MatchCentreDoc` (`:59-72`), beside `derivedComplete`:
```ts
  photos: z.array(GalleryPhotoRef).default([]),
```

> **Watch the zod trap W1's `_STATE.md:56` records:** a `.default()` makes the field REQUIRED on the OUTPUT type, so every hand-built `MatchCentreDocT` fixture in the tree must gain `photos: []`. Run `pnpm exec tsc --noEmit -p tsconfig.json` in `apps/web` in this step, not at the wave boundary.

- [ ] **Step 5: Thread it through** — `data.ts`'s `getPublicFixture` calls `readFixturePhotos(fixtureId, 6)` inside the same `unstable_cache` block (`:709-741`) and hands the result to W1 Task 9's `buildMatchCentre`; `competition-hub.ts` calls `readCompetitionGallery(competitionId)` and `deriveHubTabs` emits `"gallery"` when `gallery.length > 0`. Add to `revalidate.ts`:

```ts
/** Spectator W4 — a gallery write changes the competition hub AND the match
 *  centre of the tagged fixture's division. Same shape as
 *  fireDivisionRevalidate: fire-and-forget, never rolls back the upload. */
export function fireGalleryRevalidate(competitionId: string, divisionId: string | null): void {
  const tags = [competitionTag(competitionId), ...(divisionId ? [divisionTag(divisionId)] : [])];
  try {
    for (const tag of tags) revalidateTag(tag, "max");
  } catch {
    // outside a Next request scope (tests, scripts) — nothing to invalidate
  }
  void broadcastRevalidate(tags, "swr");
  void purgeCdn();
}
```
and call it from the upload route after a successful `uploadGalleryPhoto` (the delete route already calls it, Task 5 Step 3). Add `await cacheDelPattern(\`pub:v1:hub:${competitionId}\`)` beside it if W2's Redis hub key has merged (P6).

- [ ] **Step 6: Run the test to verify it passes** — Step 2's command, plus the scoped tsc. Paste both counts.

- [ ] **Step 7: Prove the seam is not inert.** Upload one photo through the REAL route (Task 5) against the `spx` env, then `curl` the public endpoint and read the JSON:
```bash
curl -s "$BASE/api/v1/public/fixtures/$FIXTURE" | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; print(len(d['match_centre']['photos']), d['match_centre']['photos'][:1])"
```
Expected: `1` and the photo. A fixture on both ends proves the fixture — fold the real writer's output through the real reader.

- [ ] **Step 8: Commit** — `gallery(w4): public read model, photos on the match-centre document, gallery on the hub document, cache invalidation`.

---

### Task 7: Dictionaries — every W4 key in four locales

**Files:**
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/public.json`
- Regenerate: `apps/web/src/lib/i18n-keys.ts` (`npm run i18n:gen-keys`)
- Test: `apps/web/src/server/public-site/__tests__/gallery-dictionary.test.ts`

**Interfaces:**
- Produces: `export const GALLERY_KEYS: readonly string[]` (in `apps/web/src/components/public-site/gallery/keys.ts`) — the one list Tasks 8–9 render from and this test asserts against all four locales.

- [ ] **Step 1: Write the failing coverage test**

```ts
import { describe, expect, it } from "vitest";
import { GALLERY_KEYS } from "@/components/public-site/gallery/keys";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";

const LOCALES = { en, es, fr, nl } as Record<string, Record<string, string>>;

describe("gallery dictionary coverage", () => {
  it.each(Object.keys(LOCALES))("%s has every gallery key", (loc) => {
    const missing = GALLERY_KEYS.filter((k) => !(k in LOCALES[loc]!));
    expect(missing, `${loc} missing: ${missing.join(", ")}`).toEqual([]);
  });

  it("no key is written with the namespace as a prefix (the W1 slip)", () => {
    expect(GALLERY_KEYS.filter((k) => k.startsWith("public."))).toEqual([]);
  });

  it("no locale carries the English string verbatim where it should have been translated", () => {
    // The three keys with no proper noun in them; a verbatim copy is an
    // untranslated string, not a coincidence.
    for (const k of ["gallery.title", "gallery.empty", "gallery.addPhotos"]) {
      for (const loc of ["es", "fr", "nl"]) {
        expect(LOCALES[loc]![k], `${loc}.${k} is still English`).not.toBe(LOCALES.en![k]);
      }
    }
  });

  it("every param a key declares is a param the renderers pass", () => {
    // {n} and {cap} are the only interpolations this wave uses.
    for (const k of GALLERY_KEYS) {
      const params = [...(LOCALES.en![k] ?? "").matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      expect(params.every((p) => ["n", "cap", "day", "match"].includes(p!)), `${k}: ${params}`).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails** —
```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/spectator/apps/web && \
  pnpm exec vitest run src/server/public-site/__tests__/gallery-dictionary.test.ts \
  --reporter=json --outputFile=/tmp/w4-t7.json
```
Expected: FAIL — `@/components/public-site/gallery/keys` not found.

- [ ] **Step 3: Write the key list and the English strings**

`apps/web/src/components/public-site/gallery/keys.ts`:

```ts
/** Every dictionary key the gallery renders. The coverage test asserts all four
 *  locales carry each one; Tasks 8–9 render only from this list. */
export const GALLERY_KEYS = [
  "gallery.title", "gallery.empty", "gallery.photoCount", "gallery.allPhotos",
  "gallery.photosOf", "gallery.untagged", "gallery.openPhoto", "gallery.closePhoto",
  "gallery.prevPhoto", "gallery.nextPhoto", "gallery.share", "gallery.download",
  "gallery.requestRemoval", "gallery.requestRemovalBody", "gallery.delete",
  "gallery.deleteConfirm", "gallery.strip", "gallery.photosRegion",
  "gallery.addPhotos", "gallery.sheetTitle", "gallery.choosePhotos", "gallery.takePhoto",
  "gallery.matchTag", "gallery.matchTagNone", "gallery.caption", "gallery.captionHint",
  "gallery.consentTick", "gallery.consentDeclined", "gallery.consentNotCollected",
  "gallery.upload", "gallery.uploading", "gallery.uploaded", "gallery.retry",
  "gallery.errorTooLarge", "gallery.errorType", "gallery.errorQuota",
  "gallery.errorConsent", "gallery.errorNetwork", "gallery.quotaNote",
] as const;
```

`apps/web/src/dictionaries/en/public.json` (added, flat and bare — the namespace is the FILE):

```json
  "gallery.title": "Photos",
  "gallery.empty": "No photos yet.",
  "gallery.photoCount": "{n} photos",
  "gallery.allPhotos": "All photos",
  "gallery.photosOf": "Photos of {match}",
  "gallery.untagged": "Other photos",
  "gallery.openPhoto": "Open photo",
  "gallery.closePhoto": "Close",
  "gallery.prevPhoto": "Previous photo",
  "gallery.nextPhoto": "Next photo",
  "gallery.share": "Share",
  "gallery.download": "Download",
  "gallery.requestRemoval": "Request removal",
  "gallery.requestRemovalBody": "Please remove photo {n} from the gallery.",
  "gallery.delete": "Remove photo",
  "gallery.deleteConfirm": "Remove this photo for everyone?",
  "gallery.strip": "Photos from this match",
  "gallery.photosRegion": "Photo gallery",
  "gallery.addPhotos": "Add photos",
  "gallery.sheetTitle": "Add photos",
  "gallery.choosePhotos": "Choose photos",
  "gallery.takePhoto": "Take a photo",
  "gallery.matchTag": "Match",
  "gallery.matchTagNone": "No match",
  "gallery.caption": "Caption",
  "gallery.captionHint": "Optional — a few words about the photo.",
  "gallery.consentTick": "I have checked that everyone pictured has media consent",
  "gallery.consentDeclined": "{n} players in this division have declined to appear in photos.",
  "gallery.consentNotCollected": "Media consent has not been recorded for this division — check before you upload.",
  "gallery.upload": "Upload",
  "gallery.uploading": "Uploading…",
  "gallery.uploaded": "Uploaded",
  "gallery.retry": "Try again",
  "gallery.errorTooLarge": "That photo is over 10 MB.",
  "gallery.errorType": "We cannot read that file. Use a JPEG, PNG or HEIC photo.",
  "gallery.errorQuota": "This competition is full at {cap} photos. Remove some to add more.",
  "gallery.errorConsent": "Tick the media-consent box before uploading.",
  "gallery.errorNetwork": "Upload failed. Check your signal and try again.",
  "gallery.quotaNote": "{n} of {cap} photos used",
```

- [ ] **Step 4: Translate into `es`, `fr`, `nl`.** Every key, real translations — `"gallery.title"` is `"Fotos"` / `"Photos"` / `"Foto's"`; `"gallery.consentTick"` is `"He comprobado que todas las personas fotografiadas tienen consentimiento de imagen"` / `"J'ai vérifié que toutes les personnes photographiées ont donné leur consentement à l'image"` / `"Ik heb gecontroleerd dat iedereen op de foto toestemming voor beeldmateriaal heeft gegeven"`, and so on for all 39. **No English strings in a non-English file** — the third test above is what catches that.

- [ ] **Step 5: Regenerate the key file and prove parity**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/spectator && npm run i18n:gen-keys && npm run i18n:check
/usr/bin/git status --porcelain apps/web/src/lib/i18n-keys.ts
```
Expected: `i18n:check` clean, `i18n-keys.ts` MODIFIED (never hand-edited), and 194 + 39 = **233 keys** in each of the four files.

- [ ] **Step 6: Run the coverage test to verify it passes** — Step 2's command. Expected `numFailedTests: 0`.

- [ ] **Step 7: Commit** — `gallery(w4): 39 gallery keys in four locales, generated key file, coverage test`.

---

### Task 8: The public gallery — grid, lightbox and the Photos strip

**Files:**
- Create: `apps/web/src/components/public-site/gallery/gallery-tab.tsx`, `gallery-lightbox.tsx`, `photos-strip.tsx`
- Test: `apps/web/src/components/public-site/gallery/__tests__/{gallery-tab,photos-strip}.test.tsx`

**Interfaces:**
- Consumes: `PublicGalleryPhoto`, `GalleryDayGroup`, `groupGalleryByDay` (Task 6); `GalleryPhotoRefT` (Task 6); `Dict as PublicDict` (`@/lib/i18n-constants`), `t(dict, key, params)` (`@/lib/i18n-runtime`); `GALLERY_KEYS` (Task 7).
- Produces:
  ```ts
  export function GalleryTab(props: { photos: PublicGalleryPhoto[]; tz: string; matchNames: Record<string, string>; canDelete: boolean; dict: PublicDict }): JSX.Element | null;
  export function GalleryLightbox(props: { photos: PublicGalleryPhoto[]; index: number; onIndex: (i: number) => void; onClose: () => void; canDelete: boolean; contactHref: string | null; dict: PublicDict }): JSX.Element;
  export function PhotosStrip(props: { photos: GalleryPhotoRefT[]; galleryHref: string; dict: PublicDict }): JSX.Element | null;
  ```

- [ ] **Step 1: Write the failing static-markup tests**

`apps/web/src/components/public-site/gallery/__tests__/gallery-tab.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GalleryTab } from "../gallery-tab";
import { PhotosStrip } from "../photos-strip";
import en from "@/dictionaries/en/public.json";

const dict = en as unknown as Parameters<typeof GalleryTab>[0]["dict"];
const photo = (id: string, over = {}) => ({
  id, fixtureId: null, divisionId: null, caption: null, width: 1600, height: 1200,
  thumbUrl: `https://cdn/${id}-t.jpg`, displayUrl: `https://cdn/${id}-d.jpg`,
  takenAt: null, createdAt: "2026-08-14T09:00:00.000Z", ...over,
});

describe("GalleryTab", () => {
  // EMPTY CASE FIRST (R9) — "hidden when empty" is a spec requirement, and the
  // W2 rail already refuses to render a tab whose content is empty.
  it("no photos → renders nothing at all, not an empty grid", () => {
    expect(renderToStaticMarkup(<GalleryTab photos={[]} tz="UTC" matchNames={{}} canDelete={false} dict={dict} />)).toBe("");
  });

  it("renders one figure per photo with the gl- testid and the THUMB, never the display copy", () => {
    const html = renderToStaticMarkup(<GalleryTab photos={[photo("a"), photo("b")]} tz="UTC" matchNames={{}} canDelete={false} dict={dict} />);
    expect(html).toContain('data-testid="gl-photo-a"');
    expect(html).toContain('data-testid="gl-photo-b"');
    expect(html).toContain("https://cdn/a-t.jpg");
    expect(html).not.toContain("https://cdn/a-d.jpg");
  });

  it("thumbs are lazy and carry intrinsic dimensions (no layout shift on a phone)", () => {
    const html = renderToStaticMarkup(<GalleryTab photos={[photo("a")]} tz="UTC" matchNames={{}} canDelete={false} dict={dict} />);
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    expect(html).toMatch(/width="\d+"/);
    expect(html).toMatch(/height="\d+"/);
  });

  // Anchoring on `="` — an omitted prop serialises as "$undefined" (R7 trap).
  it("the gallery images are noindex-marked for crawlers", () => {
    const html = renderToStaticMarkup(<GalleryTab photos={[photo("a")]} tz="UTC" matchNames={{}} canDelete={false} dict={dict} />);
    expect(html).toContain('data-nosnippet="');
  });

  it("alt text is the caption when there is one", () => {
    const html = renderToStaticMarkup(<GalleryTab photos={[photo("a", { caption: "Winning six" })]} tz="UTC" matchNames={{}} canDelete={false} dict={dict} />);
    expect(html).toContain('alt="Winning six"');
  });

  it("alt text falls back to the MATCH name, never to an empty alt or a filename", () => {
    const html = renderToStaticMarkup(
      <GalleryTab photos={[photo("a", { fixtureId: "f1" })]} tz="UTC" matchNames={{ f1: "Queens v Blazers" }} canDelete={false} dict={dict} />,
    );
    expect(html).toContain('alt="Photos of Queens v Blazers"');
    expect(html).not.toContain('alt=""');
  });

  it("a scrolling region carries tabindex, a role and an accessible name (axe reds at SERIOUS otherwise)", () => {
    const html = renderToStaticMarkup(<GalleryTab photos={[photo("a")]} tz="UTC" matchNames={{}} canDelete={false} dict={dict} />);
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Photo gallery"');
  });

  it("the delete control appears ONLY when canDelete — anonymous DOM never carries it", () => {
    const anon = renderToStaticMarkup(<GalleryTab photos={[photo("a")]} tz="UTC" matchNames={{}} canDelete={false} dict={dict} />);
    const staff = renderToStaticMarkup(<GalleryTab photos={[photo("a")]} tz="UTC" matchNames={{}} canDelete dict={dict} />);
    expect(anon).not.toContain("gl-delete-a");
    expect(staff).toContain("gl-delete-a");
  });
});

describe("PhotosStrip", () => {
  it("no photos → renders nothing (the strip is hidden when empty, spec §W4)", () => {
    expect(renderToStaticMarkup(<PhotosStrip photos={[]} galleryHref="/g" dict={dict} />)).toBe("");
  });

  it("shows at most six thumbs and an All photos link", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      id: `p${i}`, caption: null, width: 400, height: 300,
      thumbUrl: `https://cdn/p${i}.jpg`, displayUrl: null, createdAt: "2026-08-14T09:00:00Z",
    }));
    const html = renderToStaticMarkup(<PhotosStrip photos={many} galleryHref="/g" dict={dict} />);
    expect([...html.matchAll(/data-testid="gl-strip-thumb-/g)]).toHaveLength(6);
    expect(html).toContain('data-testid="gl-strip-all"');
  });

  it("the rail is a REACHABLE overflow, not clipped content: overflow-x-auto plus tabindex, role and name", () => {
    const html = renderToStaticMarkup(<PhotosStrip photos={[{ id: "a", caption: null, width: 400, height: 300, thumbUrl: "t", displayUrl: null, createdAt: "2026-08-14T09:00:00Z" }]} galleryHref="/g" dict={dict} />);
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('role="region"');
  });

  it("one DOM, branched — no md:hidden twin of the strip (anchor on the closing quote, not \\bmd:hidden\\b)", () => {
    const html = renderToStaticMarkup(<PhotosStrip photos={[{ id: "a", caption: null, width: 400, height: 300, thumbUrl: "t", displayUrl: null, createdAt: "2026-08-14T09:00:00Z" }]} galleryHref="/g" dict={dict} />);
    expect(html).not.toMatch(/\s[^"]*\bmd:hidden"/);
  });
});
```

- [ ] **Step 2: Run to verify it fails** —
```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/spectator/apps/web && \
  pnpm exec vitest run src/components/public-site/gallery/__tests__ \
  --reporter=json --outputFile=/tmp/w4-t8.json
```
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `photos-strip.tsx`**

```tsx
"use client";
// Spectator W4 — the match centre's Photos strip. Hidden when empty (spec §W4,
// R4/R9). A horizontal rail on a phone: `overflow-x-auto` makes its extra
// content REACHABLE, which is what separates a rail from clipped content
// (mobile.spec.ts's `overflowingIn` splits on computed overflow-x) — and a
// reachable scrolling region owes tabindex="0" + a role + a name, or axe reds
// at SERIOUS. `tabindex` cannot be varied by media query, so it is unconditional.
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { GalleryPhotoRefT } from "@/server/public-site/match-centre-schema";

const MAX_THUMBS = 6;

export function PhotosStrip({
  photos, galleryHref, dict,
}: { photos: GalleryPhotoRefT[]; galleryHref: string; dict: PublicDict }) {
  if (photos.length === 0) return null;
  const shown = photos.slice(0, MAX_THUMBS);
  return (
    <section data-testid="gl-strip" className="space-y-2">
      <h2 className="text-sm font-semibold text-slate-700">{t(dict, "gallery.strip")}</h2>
      <div
        role="region"
        tabIndex={0}
        aria-label={t(dict, "gallery.photosRegion")}
        data-testid="gl-strip-rail"
        className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]"
      >
        {shown.map((p) => (
          <a
            key={p.id}
            href={`${galleryHref}#gl-${p.id}`}
            data-testid={`gl-strip-thumb-${p.id}`}
            className="block shrink-0"
          >
            <img
              src={p.thumbUrl ?? ""}
              alt={p.caption ?? t(dict, "gallery.title")}
              width={120}
              height={90}
              loading="lazy"
              decoding="async"
              data-nosnippet=""
              className="h-[90px] w-[120px] rounded object-cover"
            />
          </a>
        ))}
        <a
          href={galleryHref}
          data-testid="gl-strip-all"
          className="flex shrink-0 items-center rounded border px-3 text-sm"
        >
          {t(dict, "gallery.allPhotos")}
        </a>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Write `gallery-tab.tsx`** — day groups from `groupGalleryByDay`, a `grid grid-cols-2 gap-2 md:grid-cols-4` (≥`md` adds COLUMNS, never controls — R1), one `<figure data-testid={"gl-photo-" + p.id}>` per photo carrying `loading="lazy" decoding="async" width height data-nosnippet=""`, alt = caption ?? `t(dict, "gallery.photosOf", { match })` ?? `t(dict, "gallery.title")`, a `role="region" tabIndex={0} aria-label` wrapper, and — only when `canDelete` — a `gl-delete-<id>` button. `if (photos.length === 0) return null;` is the FIRST statement.

- [ ] **Step 5: Write `gallery-lightbox.tsx`** — `gl-lightbox`, `gl-lightbox-prev`/`-next`/`-close`, `gl-caption`, `gl-share`, `gl-download`, `gl-remove-request` (a `mailto:` built from `gallery.requestRemovalBody` with the photo id), `gl-delete`; keyboard `ArrowLeft`/`ArrowRight`/`Escape` and `touchstart`/`touchend` swipe over a 40 px threshold; the location hash is the address (`#gl-<id>`), never a per-photo route (spec §W4 "no per-photo pages").

- [ ] **Step 6: Run the tests to verify they pass** — Step 2's command. Paste the counts.

- [ ] **Step 7: Mutate the anonymous guard.** Change `canDelete && (...)` to `(...)` in `gallery-tab.tsx`. The "delete control appears ONLY when canDelete" test must go RED. Restore. Then delete the `tabIndex={0}` from `photos-strip.tsx` — the reachable-overflow test must go RED. Restore.

- [ ] **Step 8: Commit** — `gallery(w4): public grid, swipe lightbox and the match-centre Photos strip`.

---

### Task 9: The staff upload sheet

**Files:**
- Create: `apps/web/src/components/public-site/gallery/upload-sheet.tsx`, `downscale.ts`
- Test: `apps/web/src/components/public-site/gallery/__tests__/upload-sheet.test.tsx`

**Interfaces:**
- Consumes: `fitWithin` (Task 2 — re-exported client-side; the maths is pure and shared, never retyped); `GALLERY_MAX_BYTES`, `GALLERY_MAX_PER_COMPETITION` (Task 1); `MediaConsentSummary` (Task 3, over the wire); `t`, `PublicDict`.
- Produces:
  ```ts
  export const UPLOAD_TARGET_PX = 2560;      // longest edge the browser sends
  export const UPLOAD_TARGET_QUALITY = 0.85; // JPEG quality after downscale
  export async function downscaleForUpload(file: File): Promise<{ blob: Blob; type: string }>;
  export function GalleryUploadSheet(props: {
    competitionId: string; fixtures: { id: string; label: string }[]; defaultFixtureId: string | null;
    consent: MediaConsentSummary; used: number; dict: PublicDict;
    onUploaded: (photo: GalleryPhotoRefT) => void;
  }): JSX.Element;
  ```

> **Size budget, stated.** The browser downscales to **2560 px on the longest edge at JPEG q0.85** — a 12 MP phone photo lands at roughly **0.8–1.5 MB**, comfortably inside the 10 MB server cap with headroom for a HEIC that decodes larger than expected, and small enough that four photos over a ground's 4G finish in seconds. The server still enforces 10 MB (Task 4) — the client budget is a courtesy, never the guard.

- [ ] **Step 1: Write the failing test** (what a node environment CAN witness — the sheet's markup and its gate, not the canvas)

```tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GalleryUploadSheet, UPLOAD_TARGET_PX } from "../upload-sheet";
import en from "@/dictionaries/en/public.json";

const dict = en as never;
const base = {
  competitionId: "c1", fixtures: [{ id: "f1", label: "Queens v Blazers" }],
  defaultFixtureId: "f1", used: 3, dict, onUploaded: () => {},
};
const render = (over = {}) =>
  renderToStaticMarkup(<GalleryUploadSheet {...base} consent={{ rostered: 0, recorded: 0, declined: 0, meaningful: false }} {...over} />);

describe("GalleryUploadSheet", () => {
  it("the file input accepts images, allows multiple, and offers the camera on a phone", () => {
    const html = render();
    expect(html).toContain('accept="image/*"');
    expect(html).toContain('multiple="');
    expect(html).toContain('capture="environment"');
  });

  it("the consent tick is present, unchecked, and the submit is disabled until it is ticked", () => {
    const html = render();
    expect(html).toContain('data-testid="gl-consent-tick"');
    expect(html).not.toContain('checked="');
    expect(html).toMatch(/data-testid="gl-submit"[^>]*disabled/);
  });

  // THE suppression rule (Task 3 / owner Q1). A "0 declined" line would read as
  // an all-clear the data cannot support.
  it("consent never collected → the NOT-COLLECTED line, and NO count anywhere", () => {
    const html = render({ consent: { rostered: 11, recorded: 0, declined: 0, meaningful: false } });
    expect(html).toContain(en["gallery.consentNotCollected"]);
    expect(html).not.toContain("0 players");
    expect(html).not.toContain(en["gallery.consentDeclined"].replace("{n}", "0"));
  });

  it("consent collected with nobody declining → a real all-clear, the declined line absent", () => {
    const html = render({ consent: { rostered: 11, recorded: 11, declined: 0, meaningful: true } });
    expect(html).not.toContain(en["gallery.consentNotCollected"]);
    expect(html).not.toContain(en["gallery.consentDeclined"].replace("{n}", "0"));
  });

  it("two people declined → the count is rendered with the real number", () => {
    const html = render({ consent: { rostered: 11, recorded: 11, declined: 2, meaningful: true } });
    expect(html).toContain(en["gallery.consentDeclined"].replace("{n}", "2"));
  });

  // R19 — pin what the control OPENS AT, not merely that it is reachable.
  it("the match tag OPENS AT the passed default fixture, not at 'no match' and not at the first option", () => {
    const html = renderToStaticMarkup(
      <GalleryUploadSheet {...base} fixtures={[{ id: "f0", label: "Earlier" }, { id: "f1", label: "Queens v Blazers" }]}
        defaultFixtureId="f1" consent={{ rostered: 0, recorded: 0, declined: 0, meaningful: false }} />,
    );
    expect(html).toMatch(/<option value="f1"[^>]*selected/);
    expect(html).not.toMatch(/<option value="f0"[^>]*selected/);
  });

  it("the quota note states BOTH the used count and the cap", () => {
    expect(render()).toContain("3 of 200 photos used");
  });

  it("the client downscale budget is 2560 px on the longest edge", () => {
    expect(UPLOAD_TARGET_PX).toBe(2560);
  });

  it("phone composition: no second tree — every phone branch is max-md:*, nothing is md:hidden", () => {
    expect(render()).not.toMatch(/\s[^"]*\bmd:hidden"/);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — as Task 8 Step 2, scoped to `upload-sheet.test.tsx`.

- [ ] **Step 3: Write `downscale.ts`**

```ts
"use client";
// Spectator W4 — the browser's own downscale. The MATHS is `fitWithin`, shared
// with the server (one authority per fact — the two must never drift); the
// canvas plumbing below is not unit-testable in this repo (apps/web vitest is
// `environment: "node"`), so it is proven in the walkthrough at a phone width.
import { fitWithin } from "@/server/gallery/gallery-image-math";

export const UPLOAD_TARGET_PX = 2560;
export const UPLOAD_TARGET_QUALITY = 0.85;

export async function downscaleForUpload(file: File): Promise<{ blob: Blob; type: string }> {
  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = fitWithin(bitmap.width, bitmap.height, UPLOAD_TARGET_PX);
    if (width === bitmap.width && height === bitmap.height && file.type === "image/jpeg") {
      bitmap.close();
      return { blob: file, type: file.type };
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob(res, "image/jpeg", UPLOAD_TARGET_QUALITY),
    );
    if (!blob) return { blob: file, type: file.type };
    return { blob, type: "image/jpeg" };
  } catch {
    // A HEIC the browser cannot decode, a canvas the OS refused: send the
    // original and let the server's sharp decode it. Never block the upload on
    // an optimisation.
    return { blob: file, type: file.type };
  }
}
```

> `fitWithin` moves to `apps/web/src/server/gallery/gallery-image-math.ts` (no `server-only`) in this step and `gallery-image.ts` re-exports it, so the client can import the same function. Update Task 2's test import path in the same commit.

- [ ] **Step 4: Write `upload-sheet.tsx`** — a `max-md:` bottom sheet / `md:` dialog in ONE DOM; `gl-add` trigger, `gl-sheet`, `gl-file-input` (`accept="image/*" multiple capture="environment"`), `gl-match-tag` `<select>` whose `defaultValue` is `defaultFixtureId`, `gl-caption-input`, the consent block (`gl-consent-note` rendering `consentNotCollected` when `!meaningful`, `consentDeclined` with `{n}` when `meaningful && declined > 0`, and nothing when `meaningful && declined === 0`), `gl-consent-tick`, `gl-quota-note`, `gl-submit` (`disabled` until the tick), then per file a `gl-progress-<i>` bar and, on failure, a `gl-retry-<i>` button with the mapped error copy. Each file is its own `POST` with `FormData` — sequential, so a five-photo batch shows real progress and a failure retries just that one.

- [ ] **Step 5: Run the tests to verify they pass** — Step 2's command. Paste counts.

- [ ] **Step 6: Mutate the suppression.** Change the consent block's condition from `consent.meaningful` to `true`. The "consent never collected → NO count anywhere" test must go RED. Restore. Then change the submit's `disabled={!ticked}` to `disabled={false}` — the "submit is disabled until it is ticked" test must go RED. Restore.

- [ ] **Step 7: Commit** — `gallery(w4): staff upload sheet — multi-select, camera, match tag, consent gate, per-file progress and retry`.

---

### Task 10: Wiring — the Gallery tab, the Photos strip, and the staff control on a public page

**Files:**
- Modify: `apps/web/src/components/public-site/match-centre/match-centre.tsx:107-120`
- Modify: W2's `CompetitionLanding` (`:1420` in the W2 plan — remove the gallery filter) and `deriveHubTabs`
- Modify: `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/page.tsx`
- Create: `apps/web/src/components/public-site/gallery/gallery-panel.tsx` (the tab's client root — decides `canUpload` from a server-passed flag)
- Test: `apps/web/src/components/public-site/gallery/__tests__/gallery-panel.test.tsx`

**Interfaces:**
- Consumes: `GalleryTab`, `GalleryLightbox` (Task 8); `GalleryUploadSheet` (Task 9); `useLiveCompetition` (W2 Task 7) or `useLiveFixture` (`match-centre/use-live-fixture.ts:18`).
- Produces: `export function GalleryPanel(props: { photos: PublicGalleryPhoto[]; tz: string; matchNames: Record<string, string>; canUpload: boolean; competitionId: string; fixtures: {id;label}[]; defaultFixtureId: string | null; consent: MediaConsentSummary | null; used: number; dict: PublicDict }): JSX.Element`

> **`canUpload` is SERVER-DECIDED.** The page resolves the viewer's org role on the server and passes a boolean; the client never asks "am I staff?" and never renders the control speculatively. The anonymous DOM must not contain `gl-add` at all — hiding it with a class would leave the control one devtools edit from a POST, and the route's own 401 would then be the only guard.

- [ ] **Step 1: Write the failing test**

```tsx
it("anonymous: the DOM carries no upload control at all — not hidden, ABSENT", () => {
  const html = renderToStaticMarkup(<GalleryPanel {...base} canUpload={false} />);
  expect(html).not.toContain("gl-add");
  expect(html).not.toContain("gl-sheet");
  expect(html).not.toContain("gl-consent-tick");
});
it("staff: the control is present", () => {
  expect(renderToStaticMarkup(<GalleryPanel {...base} canUpload />)).toContain('data-testid="gl-add"');
});
it("staff with zero photos: the panel still renders, because the ADD control is the point", () => {
  const html = renderToStaticMarkup(<GalleryPanel {...base} photos={[]} canUpload />);
  expect(html).toContain('data-testid="gl-add"');
  expect(html).toContain('data-testid="gl-empty"');
});
it("anonymous with zero photos: renders nothing (the tab is not offered at all)", () => {
  expect(renderToStaticMarkup(<GalleryPanel {...base} photos={[]} canUpload={false} />)).toBe("");
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Write `gallery-panel.tsx`** with exactly those four behaviours; `canUpload && <GalleryUploadSheet …/>` is a conditional RENDER, never a CSS branch.

- [ ] **Step 4: Mount the strip in the match centre** — `match-centre.tsx`, after the tabpanel `</div>` at `:118`:

```tsx
      <PhotosStrip photos={doc.photos} galleryHref={`${doc.info.competitionHref}?tab=gallery`} dict={dict} />
```
(`doc.photos` from Task 6; `doc.info.competitionHref` already exists at `match-centre-schema.ts:57`.) The strip is `null` when empty, so nothing changes for a fixture with no photos.

- [ ] **Step 5: Flip W2's gallery slot** — in `deriveHubTabs`, emit `"gallery"` when the document's `gallery` array is non-empty OR the viewer may upload; in `CompetitionLanding`, delete `.filter((id) => id !== "gallery")` and add `gallery` to the panel switch. **Re-pin both against W2's merged code** (P6) — if W2 has not merged, this step is deferred and Task 11's hub assertions are skipped with a recorded note, not weakened.

- [ ] **Step 6: `noindex` the images** — the competition page's `generateMetadata` keeps its existing robots directives; the gallery `<img>` elements carry `data-nosnippet=""` (Task 8) and the page adds `<meta name="robots" content="max-image-preview:none" />` when the gallery tab is active. Assert it in the page test by anchoring on `content="`.

- [ ] **Step 7: Run the scoped suites** —
```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/spectator/apps/web && \
  pnpm exec vitest run src/components/public-site --reporter=json --outputFile=/tmp/w4-t10.json && \
  pnpm exec tsc --noEmit -p tsconfig.json
```

- [ ] **Step 8: Commit** — `gallery(w4): Gallery tab wired into the hub rail, Photos strip on the match centre, server-decided staff control`.

---

### Task 11: Walkthrough v4, mobile.spec, smoke and the regressions

**Files:**
- Modify: `apps/web/e2e/walkthrough/spectator-public.spec.ts` (append the W4 block; the file is W1 Task 15's — P7)
- Modify: `apps/web/e2e/mobile.spec.ts`
- Modify: `scripts/smoke.ts`
- Create: `apps/web/e2e/fixtures/gallery-sample.jpg` (a small real JPEG with EXIF GPS, committed — the strip cannot be proven without one)

**Interfaces:**
- Consumes: `apiJson`, `TAG`, `competitionPath`, `fixturePath`, `expectNoHorizontalScroll`, `screenshotAtWidths` (`e2e/helpers.ts:122,111,1314,1347,43,240`); `dismissCookieBanner` (`e2e/scorepad-a11y-kit.ts:409`); `auditRoute`, `overflowingIn`, `projectViewport` (`e2e/mobile.spec.ts:502,91,44`); W1's seeded `live`/`done` fixtures.

> `apiJson` sets `Content-Type: application/json` (P15) and **cannot** do multipart. The walkthrough uploads through the real UI (`setInputFiles`) — which is also what R7 demands: prove the seam by driving it.

- [ ] **Step 1: Write the walkthrough block (it will fail — nothing is wired for it yet)**

```ts
test("W4 — staff upload from the public page, anonymous sees it appear without reloading", async ({ page, browser, request }, testInfo) => {
  test.setTimeout(180_000);
  const compHref = `/shared/${orgSlug}/${compSlug}`;

  // The ANONYMOUS context opens FIRST and is never navigated again (R10).
  const anon = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  });
  const spectator = await anon.newPage();
  await spectator.goto(`${compHref}?tab=gallery`);
  await dismissCookieBanner(spectator);

  // 1. The anonymous viewer never sees the control — ABSENT, not hidden.
  await expect(spectator.getByTestId("gl-add")).toHaveCount(0);

  // 2. Staff (this project is signed in — playwright.config.ts:164-168) uploads
  //    two photos at 390 px through the real sheet.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${compHref}?tab=gallery`);
  await dismissCookieBanner(page);
  await page.getByTestId("gl-add").click();
  await expect(page.getByTestId("gl-sheet")).toBeVisible();

  // The consent gate must be reachable WITHOUT scrolling past the tick at 320.
  await expect(page.getByTestId("gl-consent-tick")).toBeInViewport();
  // Submit is refused until the tick — the regression, driven not asserted.
  await expect(page.getByTestId("gl-submit")).toBeDisabled();

  await page.getByTestId("gl-file-input").setInputFiles([
    "e2e/fixtures/gallery-sample.jpg",
    "e2e/fixtures/gallery-sample.jpg",
  ]);
  await page.getByTestId("gl-match-tag").selectOption(liveFixtureId);
  await page.getByTestId("gl-caption-input").fill("Winning six");
  await page.getByTestId("gl-consent-tick").check();
  await expect(page.getByTestId("gl-submit")).toBeEnabled();
  await page.getByTestId("gl-submit").click();
  await expect(page.getByTestId("gl-uploaded-1")).toBeVisible({ timeout: 60_000 });

  // 3. R10 — the anonymous page updates IN PLACE. No goto, no reload.
  await expect
    .poll(async () => spectator.getByTestId(/^gl-photo-/).count(), { timeout: 45_000 })
    .toBe(2);
  expect(spectator.url()).toBe(`${new URL(compHref, baseURL).toString()}?tab=gallery`);

  // 4. The Photos strip on the match centre carries the same photos.
  const fx = await spectator.context().newPage();
  await fx.goto(await publicFixtureHref(request, liveFixtureId));
  await expect(fx.getByTestId("gl-strip")).toBeVisible();
  await expect(fx.getByTestId(/^gl-strip-thumb-/)).toHaveCount(2);

  // 5. The lightbox swipes, and the caption is the alt text.
  await spectator.getByTestId(/^gl-photo-/).first().click();
  await expect(spectator.getByTestId("gl-lightbox")).toBeVisible();
  await expect(spectator.getByTestId("gl-lightbox").locator("img")).toHaveAttribute("alt", "Winning six");
  await spectator.getByTestId("gl-lightbox-next").click();

  // 6. EXIF is gone from what the CDN actually serves — the privacy claim,
  //    proven on the published bytes, not on a buffer in a unit test.
  const displayed = await spectator.getByTestId("gl-lightbox").locator("img").getAttribute("src");
  const bytes = Buffer.from(await (await request.get(displayed!)).body());
  expect(bytes.toString("latin1")).not.toContain("GPS");

  // 7. Removal → gone in every reader, without a reload.
  const [photoId] = await galleryPhotoIds(request, competitionId);
  await page.reload();
  await page.getByTestId(`gl-photo-${photoId}`).click();
  await page.getByTestId("gl-delete").click();
  await expect.poll(async () => spectator.getByTestId(`gl-photo-${photoId}`).count()).toBe(0);
  const gone = await request.get(displayed!);
  expect(gone.status()).toBeGreaterThanOrEqual(400);

  // 8. Screens for R11.
  await screenshotAtWidths(spectator, testInfo, "w4-gallery-tab", [320, 768, 1280]);
  await screenshotAtWidths(page, testInfo, "w4-upload-sheet", [320, 768, 1280]);
  await anon.close();
});
```

- [ ] **Step 2: Run the WHOLE spec file, never a `-g` slice** —
```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/spectator/apps/web && \
  E2E_PROD_TARGET=1 pnpm exec playwright test --project=walkthrough e2e/walkthrough/spectator-public.spec.ts
```
Expected: RED on the first missing testid. Fix forward until green.

- [ ] **Step 3: Add the mobile.spec cases** (two, beside the existing public-page audits):

```ts
test("gallery tab: no horizontal scroll, and the grid is not clipped", async ({ page }) => {
  await auditRoute(page, `${compHref}?tab=gallery`);
  const bad = await overflowingIn(page, '[data-testid="gl-grid"]');
  expect(bad, `clipped boxes: ${JSON.stringify(bad)}`).toEqual([]);
});

test("the Photos strip is a REACHABLE rail, not clipped content", async ({ page }) => {
  await page.goto(fixtureHref);
  const rail = page.getByTestId("gl-strip-rail");
  await expect(rail).toHaveAttribute("tabindex", "0");
  await expect(rail).toHaveAttribute("role", "region");
  const overflowX = await rail.evaluate((el) => getComputedStyle(el).overflowX);
  expect(["auto", "scroll"]).toContain(overflowX);
  await expectNoHorizontalScroll(page);
  const axe = await new AxeBuilder({ page }).include('[data-testid="gl-strip"]').analyze();
  expect(axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);
});
```

- [ ] **Step 4: Add the smoke checks** (`scripts/smoke.ts`, beside W1's public-fixture check):

```ts
const galleryHtml = await html(`/shared/${orgSlug}/${compSlug}?tab=gallery`);
check("gallery tab carries gl- markers", galleryHtml.includes('data-testid="gl-grid"'));
check("gallery tab does NOT carry the staff control anonymously", !galleryHtml.includes('data-testid="gl-add"'));
const thumb = /src="([^"]*\/gallery\/[^"]*thumb\.jpg)"/.exec(galleryHtml)?.[1];
check("the storage object behind a gallery thumb actually exists", !!thumb && (await fetch(thumb)).ok);
await expectFail("anonymous gallery POST is refused", async () => {
  const r = await fetch(`${BASE}/api/v1/competitions/${competitionId}/gallery`, { method: "POST", body: new FormData() });
  if (!r.ok) throw new Error(String(r.status));
});
```

- [ ] **Step 5: Add the regression assertions** (in the walkthrough file, own `test()` blocks):
  - `POST` with no session → **401**, and the row count is unchanged.
  - `POST` with a session but `consent_confirmed` absent → **400**, and no storage object was created (list the prefix).
  - A soft-deleted photo is absent from the Gallery tab, the Photos strip, `GET /api/v1/competitions/{id}/gallery`, and its storage URL 4xxs — **four readers, all four asserted.**
  - At the cap: the 201st upload returns **409** and the sheet renders `gallery.errorQuota` with the real cap.

- [ ] **Step 6: Re-run the whole spec file until a FULL pass completes.** `mobile.spec.ts` is serial (P15) — a red count there is a FLOOR; re-run after each fix.

- [ ] **Step 7: Commit** — `gallery(w4): walkthrough v4, seven-width scans, smoke and the four regressions`.

---

### Task 12: Gates, review loop, R11 visual sign-off, programme index

- [ ] **Step 1: The OpenAPI drift gate runs FIRST** (`W4-gallery.md` §Gates — "not the last"):
```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/spectator && npm run openapi:gen
/usr/bin/git status --porcelain openapi
```
Expected: nothing printed. Then `cd apps/web && pnpm exec vitest run src/server/api-v1/__tests__/openapi-coverage.test.ts` — PASS.

- [ ] **Step 2: The orchestrator runs the full gate** from the worktree on a quiescent tree:
```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/spectator/apps/web && \
  pnpm exec vitest run --reporter=json --outputFile=/tmp/w4-web.json
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/spectator/packages/engine && \
  pnpm exec vitest run --reporter=json --outputFile=/tmp/w4-eng.json
```
Paste `numTotalTests` / `numFailedTests` / `numFailedTestSuites` for both, and confirm `.testResults[].name` paths are under the worktree — a run launched from the wrong cwd returns a false green. Then `npm run i18n:check`, and lint through `rtk proxy` (the wrapper hides `npm run lint` output entirely; read `✖ N problems`).

- [ ] **Step 3: Reviewer dispatch** on the whole branch (Opus; brief = this plan + `_RULES.md` + spec §W4; output = a gap list, no file dumps). Fix inline; re-review until clean. **Run the final whole-branch review even if every task review was clean** — reviews after a green push have found live defects twice in this repo.

- [ ] **Step 4: R11 visual sign-off** on the `spx` prod build with the walkthrough's seeded data. Per-screen verdict table appended to the spec, each row saying what was **SEEN**:

| Screen | 320 | 768 | 1280 | What was read |
| --- | --- | --- | --- | --- |
| Gallery tab — populated | | | | grid gutters even; thumbs square-cropped, none stretched; day heading spacing; the 43-character entrant name in a match heading wraps without clipping |
| Gallery tab — empty (staff) | | | | the empty line and the Add control sit together, not stranded at opposite ends |
| Gallery tab — empty (anonymous) | | | | the tab is not offered at all |
| Lightbox — landscape photo | | | | image fits without letterbox bars of unequal size; caption legible over the backdrop; contrast of the muted controls |
| Lightbox — portrait photo | | | | the tall case is where a fixed aspect ratio breaks; prev/next stay reachable |
| Photos strip on the match centre | | | | six thumbs, the rail scrolls rather than clipping, "All photos" not orphaned on its own line |
| Upload sheet — closed | | | | the Add button's tap target ≥ 44 px by `elementFromPoint`, not by `boundingBox()` |
| Upload sheet — open, consent NOT collected | | | | the not-collected line is visible **without scrolling past the tick** at 320 |
| Upload sheet — open, 2 declined | | | | the count line and the tick are one visual block, not separated by the caption field |
| Upload sheet — uploading 3 files | | | | three progress bars, no layout jump as each completes |
| Upload sheet — one failed | | | | the retry button is beside its own file, not at the sheet's foot |
| Quota reached | | | | `gallery.errorQuota` states the real cap, no truncation at 320 |

A cosmetic defect is a defect — one fix dispatch with the review findings, never parked.

- [ ] **Step 5: The control-set diff (R1).** Collect every `[data-testid^="gl-"]` in DOM order at 320 and at 1280 on the same page, and assert **membership, order and repeats** are identical. A phone view showing the same control set at smaller sizes is a groomed shrink — the thing this programme exists to undo. Print both lists next to the verdict.

- [ ] **Step 6: `_INDEX.md`** (in the wave's PR, by the orchestrator): the W4 row → "PR #… open"; the false premises found (start with P1 — the consent source cannot express "declined", and `persons.consent.public_photo` has no production writer that sets `false`); the bucket decision (Q2) and what was actually provisioned; the mutants and the test that killed each; the measured walkthrough cost.

- [ ] **Step 7: Open the PR** only when the owner says so. e2e runs on `workflow_dispatch` with the PR number (**e2e does not run on PRs — it triggers on push to `main`**; smoke is PR-only). Re-read `.github/workflows/e2e.yml` rather than trusting any prose about its trigger.

---

## Execution order

Sequential: **1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12.**

Parallel lanes with provably disjoint files: **Task 3 beside Task 2** (`usecases/gallery.ts` vs `server/gallery/gallery-image.ts`); **Task 7 beside Tasks 8–9** once Task 7 Step 3 has fixed `GALLERY_KEYS` (the list is a fixed literal in this plan, so the keys can land early). Everything else shares a file with its neighbour and goes sequential — an ownership list does not hold, and Tasks 8–10 all touch the `gallery/` component directory.

**Hard dependencies on other waves:**
- **W1 Task 9** (`matchCentre` on `getPublicFixture`) and **Task 14** (the page renders `<MatchCentre>`) before Task 6 Step 5 and Task 10 Step 4.
- **W1 Task 15** (`spectator-public.spec.ts` exists) before Task 11.
- **W2 Task 4/7/11** (`competition-hub.ts`, `useLiveCompetition`, `CompetitionLanding`) before Task 6's hub half and Task 10 Step 5. If W2 has not merged, those two steps are **deferred with a recorded note**, and Task 11's hub assertions are skipped — never weakened to pass.
- **W3 Task 2** would be the first `sharp` import if it merges first; whichever wave lands first owns proving the standalone build carries the native binary (P3).

---

## Open questions for the product owner (recommendations stated as owner value)

**Q1 — The media-consent gate: what the sheet may truthfully claim.**
The spec asks the sheet to show "how many players in the tagged division(s) have media consent DECLINED". **Neither candidate source can say that today** (P1): `registration_players.media_consent_at` is a nullable timestamp where null means declined *and* never-asked, and `persons.consent.public_photo` — the right flag, an explicit boolean, the one every other public photo surface reads — has **no production writer that ever sets `false`**.
**Recommendation:** ship the attestation tick as the blocking gate exactly as specified (`consent_confirmed_at` NOT NULL), and render the declined count from `persons.consent.public_photo === false` **only when at least one person on the roster has an explicit value either way**; otherwise render "Media consent has not been recorded for this division — check before you upload." *Owner value:* an organiser who has collected consent gets the real number and uploads confidently; an organiser who has not is told so, instead of being shown a "0 declined" that reads as permission the data never gave. *Cost:* one extra field on the summary and one extra copy string in four locales. *Counter-argument:* a line saying "we don't know" is weaker than a number, and some organisers will read it as friction — but the alternative is a false all-clear on a child's photograph, which is the one error this gate exists to prevent. **Separately recorded, not built here:** RS007's registration-time media consent never propagates to `persons.consent.public_photo`; closing that is a registration-programme change and `W4-gallery.md` says do not touch registration pages.

**Q2 — The storage bucket: a new `gallery` bucket, or a prefix in `assets`?**
The spec says bucket `gallery`. **Nothing in this repo provisions a bucket** (P2) — zero hits for `createBucket`/`storage.buckets` — and every stored object today lives in the single `assets` bucket. A new bucket is a manual Supabase-console step in dev, CI, e2e *and* prod, and the first environment that misses it fails at upload with a 502 nobody can reproduce locally.
**Recommendation:** keep `assets` with the path prefix `orgs/{orgId}/gallery/{competitionId}/{photoId}/{variant}.jpg`. The unguessability the spec actually wants comes from the random `photoId` segment, not from the bucket name; the public-CDN rail, the URL builder and the delete helper all already work. *Owner value:* the gallery ships without an ops step that can silently break one environment. *Counter-argument:* a separate bucket would let a future retention or size policy be set per-bucket — worth doing when such a policy exists, and a path prefix migrates into one cheaply.

**Q3 — A new `gallery_photos` table, or a `gallery` post kind on `org_posts`?**
**Recommendation: the new table**, as the spec says. `org_posts` (P14) carries exactly ONE `hero_image_path`, a per-org unique `slug`, a draft/published/archived lifecycle, path-based ISR and a Pro `news.auto` entitlement — a gallery photo needs none of that and needs three things `org_posts` lacks: a required competition binding with optional division/fixture tags, a per-photo soft delete, and a per-competition count for the quota. Reusing the kind would drag the news entitlement and the slug rule onto every photo and force a child table anyway. *Owner value:* the news feed and the gallery stay independently changeable — a change to one cannot break the other's public page. *Counter-argument:* two tables means two invalidation paths; that cost is one `fireGalleryRevalidate` function (Task 6).

**Q4 — Live update: poll, Realtime, or neither?**
**Recommendation: neither — ride the documents that already exist.** Photos go on `MatchCentreDoc.photos` and the hub document's `gallery`, so W1's `useLiveFixture` and W2's `useLiveCompetition` carry them with no new transport, no new subscription and no new entitlement read (R6/R10). One caveat the owner should rule on: `use-live-fixture.ts:51,96` stops polling once a fixture is neither `in_play` nor `scheduled`, so **a photo added to an already-decided fixture will not appear in place** on a match-centre page left open — the next visitor gets it on the server render. *Recommendation:* accept for W4. *Owner value:* zero added load on every open public page, and the realistic case — photos uploaded during or just after play, while the fixture is still live — is fully covered and proven in the walkthrough. *Counter-argument:* a parent watching a finished match page will not see the team photo land; if that matters, the fix is one line widening the `live` predicate to "decided within the last hour", which we can add on request rather than by default.

**Q5 (minor) — Testid prefix.** Spec R7 and `W4-gallery.md` §6 say `gl-*`; the dispatch brief said `mc-gallery-*` / `mh-gallery-*`. This plan follows the spec. Reversing it is a global rename of the `gl-` literals in Tasks 8–11.

**Q6 (recorded, deliberately not built) — a plan-tiered photo quota.** R6 forbids a new entitlement row, and the spec routes this to entitlements v18. 10 MB / 200-per-competition ship as product constants on every plan.

---

## Self-review (done while writing)

**1. Spec coverage (§W4).** Model (`gallery_photos`, every column the spec lists, plus `bytes` and `consent_version`) → Task 1. Storage, unguessable paths, thumb 400 / display 1600, original kept, EXIF stripped, 10 MB / 200 constants → Tasks 1–2. `POST /api/v1/competitions/{id}/gallery` session-scoped, role-checked, rate-limited + `DELETE` with derivatives removed in the same request + OpenAPI regenerated → Tasks 4–5. Upload sheet: multi-select camera roll or camera, optional match tag defaulting to the live/most-recent fixture, caption, the media-consent gate with the declined count and the tick stored as `consent_confirmed_at`, per-file progress and retry → Tasks 3, 9. Public surfaces: Gallery tab grouped by day and match, lightbox with swipe/caption/share/download/"Request removal", the match centre's six-thumb Photos strip, both hidden when empty, no per-photo pages, `noindex` on the images → Tasks 6, 8, 10. Testids `gl-*` → Tasks 8–11. Walkthrough v4 with a signed-in staff context beside an anonymous one → Task 11. All four test types: unit (derivative sizing, EXIF strip, quota ladder empty-first, declined-consent count, role check) → Tasks 1–4; e2e → Task 11; smoke → Task 11 Step 4; regression (anonymous 401, no-tick 400, soft-deleted absent from every reader, quota 409) → Task 11 Step 5. Screens → Task 12 Step 4. R10 → Task 11 Step 1 item 3. R11 → Task 12. **Gap found and closed while reviewing:** the spec's declined-consent count is not computable from either named source; Task 3's `meaningful` flag and Q1 exist because of it. **Second gap closed:** the spec never says who may DELETE — Task 5 gives it the same `GALLERY_UPLOAD_ROLES`, matching "Any staff member can delete from the lightbox".

**2. Placeholder scan.** Every code step carries real code. The two conditional steps (Task 10 Step 5 and Task 6 Step 5's hub half) each name the exact check that decides them and the recorded-note fallback. No "add validation", no "similar to Task N", no TBD.

**3. Type consistency.** `GalleryVariant` / `galleryObjectPath` / `galleryPublicUrl` (Task 1) are what Tasks 4 and 6 call. `fitWithin` is defined once (Task 2, moved to `gallery-image-math.ts` in Task 9 Step 3 and re-exported, so Task 2's import path stays valid) and shared by server and client — never retyped. `MediaConsentSummary` (Task 3) is what Task 5's `GalleryConsentSummary` schema mirrors and Task 9's sheet consumes, field for field (`rostered`/`recorded`/`declined`/`meaningful`). `GalleryPhotoRow` (Task 4) is the DB row; `PublicGalleryPhoto` (Task 6) is the public projection; `GalleryPhotoRefT` (Task 6) is the strip's narrower shape — three distinct names, never interchanged. `GALLERY_UPLOAD_ROLES` is named identically in Tasks 4, 5 and 10. `GALLERY_KEYS` (Task 7) is what Tasks 8–9 render from and Task 7's coverage test imports. `fireGalleryRevalidate(competitionId, divisionId)` has the same two parameters in Tasks 5 and 6.
