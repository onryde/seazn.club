# Review: draft competitions are unlisted until published

Branch `fix/draft-competitions-unlisted` (`origin/main..` = 9d54595b5, 896335977, 8603e2acc; merge-base 782628af5 = origin/main tip).
Reviewed read-only through git refs. Nothing was executed except `git merge-tree` (dry-run, no refs) and one public GET of `https://seazn.club/sitemap.xml`.
**No test suite, e2e or smoke was run by the reviewer.** Every "green" claim below is the implementer's and still needs its raw counts pasted.

Owner decision (2026-09-27): `status='draft'` is unlisted until published. It stays reachable by link and gets noindex. It is enumerated on no listing surface. `archived` is unchanged, and visibility semantics are unchanged.

**Verdict: Needs fixes.** One CI gate will go red (I1). Customer-facing copy is still false for drafts in the wizard, the settings picker and the canonical help page (I2, I3). And the prod rollout drops every never-published running competition off the org homes and discovery. That needs an owner decision before merge (I4).

---

## 1. Spec compliance

| Brief item | Result |
|---|---|
| Org home list + chip poll | `data.ts:583` adds `status <> 'draft'`. `publicOrgLive` reads the same function (`usecases/public.ts:369-383`), so the page and the poll cannot disagree. Correct. |
| Sitemap | `data.ts:1748`. The query is correct. The claim about freshness is not (see M1). |
| Discovery (V419) | `V419:70`. It reaches /discover, the sport pages, the marketing home strips, `/live` (the live wall), `listDiscoverySports` (the sitemap sport entries) and `GET /api/v1/public/discovery`, because every one of them reads only `public_discovery_v` (`server/public-site/discovery.ts:41,70,91,119,157`; `usecases/public.ts:542`). |
| Player card Upcoming, other competitions | `public-player-matches.ts:823`. The card's own competition is still exempt, which is the direct-link path. Correct. |
| Kept: news | Sanctioned. Posts are organiser-authored and published by hand. The public read already admits unlisted competitions' posts (`org-posts.ts:361`), so treating a draft like unlisted is consistent. |
| Kept: weekly digest | Sanctioned. The cron writes a DRAFT post (`org-posts.ts:686-689`), and nothing reaches the public until the organiser publishes it. |
| Kept: /me | Sanctioned. It is the signed-in viewer's own data. |
| noindex on 4 pages | `linkOnlyRobots` is applied on the hub, division, fixture and player card. Every other competition-scoped public page already carries an unconditional noindex: register, register/join, register/status, poster, both kiosk `present` pages, `/r/[ref]` and the embed layout (grep of `robots` under `app/(public)` and `app/embed`). So the set of four is complete. |
| Publish/unpublish revalidation | `competitions.ts:675,706-716`. A crossing of the listing line (a status crossing draft, or a visibility crossing public) deletes the poll key and expires `orgTag`. That goes beyond the brief (visibility moves too) and is harmless. |
| Settings hint, 4 locales, help, e2e, smoke | Present. The copy is incomplete (I2, I3). |

**Visibility semantics** are unchanged: no reader's visibility predicate moved. **archived and completed** stay listed (`<> 'draft'` everywhere, and DB-tested).

## 2. Probe answers

### P1: Completeness of listing surfaces

I swept every public route (`app/(public)`, `app/api/v1/public`, `app/embed`, the marketing pages, `sitemap.ts`, `robots.ts`), every `public_competitions_v` / `public_discovery_v` reader, and every `org_id =` query under `server/public-site`, `usecases/public.ts`, `player-stats`, `discipline`, `org-posts` and `news`.

- **RSS / JSON sitemap / `/api/v1/public/orgs/*/competitions` list:** none of these exist. The only org-level public API is `/orgs/{slug}/live`, which is filtered.
- **OG images:** they are per-page and per-competition (a direct link). There is no org-level OG.
- **Search:** it is discovery `q`, covered by V419.
- **Org embeds:** there are none. Embeds are per-division (`embed-data.ts:78`, keyed by id).
- **Kiosk and slideshow:** competition- or division-scoped (`slideshow-data.ts:188,205,501`). The org kiosk layout only reads org chrome.
- **"Other competitions" rails:** the only one is the player card Upcoming, which is covered. No JSON-LD enumerates competitions: the fixture page's SportsEvent covers one fixture, and discovery cards come from V419.
- **Public player history:** past match lines are scoped to the card's own competition (`public-player-matches.ts:394`). The stat rollup is scoped the same way (`data.ts:1419,1495,1538`). A draft's history therefore appears only on the draft's own card. That is correct.
- **Public stats and suspensions:** `player-stats.ts:1054` and `discipline.ts:859,933` are keyed by org/competition/division slug, so they are direct links. They correctly have no status filter.

**No listing surface was missed.**

### P2: Direct-link paths

No direct-link reader was touched. None of them carries a status predicate either. A grep of `c.status` in the registration use cases, `embed-data`, `og/`, and `getPublicCompetition` / `findCompetition` returned zero hits.

Positive pairs that exist:
- The hub shell resolves a draft (`draft-unlisted-db.test.ts`, "direct link").
- `publicRegistrationInfo` plus `submitRegistrationGroup` accept an entry on a draft (same file).
- A draft's own card lists its own Upcoming rows (`public-player-upcoming.test.ts`, "…but the draft's OWN card").
- e2e: the draft hub serves 200 with its heading. Smoke: the draft hub serves 200.

Division, fixture, kiosk, embed, ICS and poster have no draft-specific test. The diff cannot affect them, so this is acceptable.

### P3: V419

- **Latest prior definition:** V306:146-195. V307/V314/V328/V332/V334/V338 only mention the view in comments; `git grep "view public_discovery_v"` finds V116, V238, V306 and V419 only.
- **Exact diff:** the body was extracted and `diff`ed. The only delta is the two added lines at V419:69-70 (the comment and `and c.status <> 'draft'`). The columns and their order are identical, so `create or replace` is legal.
- **Other properties:**
  - The grant is kept. `create or replace` preserves ACLs, and the restated `grant … to app_user` (V419:84) matches the only grantee in V116:116 and V239:15.
  - V306 declares no reloptions (`security_barrier` etc.), so none can be lost.
  - `competitions.status` is `not null` (V207:13), so `<>` drops no NULL rows.
- **Number and merge order:** main's tail is V417. V418 is held by `origin/perf/public-hub-queries` (PR #888, 0186fd405, `V418__public_entrants_entitlement_once.sql`). Flyway runs without outOfOrder (V410:9). So **#888 must merge and deploy first**. If this branch deploys first, #888's V418 fails validation on every existing database and has to be renumbered V420.
  - `git merge-tree` of this branch onto #888 gives one content conflict, in `apps/web/src/server/usecases/competitions.ts`. #888 inserts `refOrgSlug` lines directly above the `const { row, discoveryTouched } = …` line that this branch rewrites. `data.ts`, `public.ts` and `smoke.ts` auto-merge.

### P4: Cache and write paths

- `patchCompetition` is the ONLY writer that can cross the draft line. `git grep "update competitions"` gives:
  - `competitions.ts:626`: the PATCH.
  - `schedule.ts:3973`: the start auto-promotion, `where … status = 'published'`. It never touches a draft, and published→live stays listed.
  - The admin discovery route: `discovery_featured` / `discovery_blocked` only. It already invalidates discovery.
  - `registrations.ts:2939`: `fee_percent`.
- Callers of the PATCH:
  - The settings save (e2e asserts the request).
  - The wrap-up prompt (`competition-wrap-up-prompt.tsx:53-56`, PATCH `/api/v1/competitions/{id}`). A draft→completed wrap-up crosses the line and is covered.
  - The status-suggestion button.
  - The API v1 PATCH (`app/api/v1/competitions/[id]/route.ts:21`, the single caller).
  - There is no staff or admin status tool.
- Create never accepts `status` (`CreateCompetition`, `schemas.ts:135`), and `templates.ts:221` inserts a draft. So creating never lists anything.
- **Reach of the `orgTag` expiry:**
  - The hub, division, fixture and player-card metadata all read `competition.status` from the `pub-comp` shell (`data.ts:702-703`, tagged `orgTag`). One expiry therefore flips noindex on all four pages, and the Upcoming rows on sibling cards (`pub-player-v17` carries `orgTag`, `data.ts:1656`).
  - Discovery is covered by `discoveryTouched` (`competitions.ts:667-670`), which includes `patch.status` on a discoverable row.
- **Coverage verdict:** every status-change path is covered.

### P5: noindex

- It is applied only when `!competitionIsListed`. Published, live, completed and archived public competitions get no `robots` key, and unit tests on all four pages prove both directions.
- Smoke anchors on `name="robots" content="noindex` (`smoke.ts:2092`), and the e2e anchors on `<meta name="robots" content="noindex, nofollow"`. Both anchor on `="`. RSC flight JSON (`"name":"robots"`) cannot satisfy either.
- **`follow:false` is acceptable. Keep it.** It is the value unlisted pages already carry, and the brief asks drafts to behave like unlisted. A link-only page should not be a crawl entry point into its registration or player pages. The only link equity it withholds points at the org home, which is reachable from listed competitions anyway.

### P6: Copy

- All 4 locales carry `compset.draftUnlisted`. `i18n-keys.ts` is regenerated, in sorted position.
- The fr and nl text uses the same gender convention as their siblings (`compset.statusHint.*`).
- The help pages that were edited are true, with the caveats in M4.
- The help pages and UI strings that were NOT edited are false for a draft (I2, I3).

### P7: Tests

- **Negatives have positive pairs.** Every absence is read beside a present published or archived row: org home, poll, sitemap, discovery (page and API readers), Upcoming, robots, the hint, and the write-path spy.
- **The empty-org case is stated first** for org home, poll, sitemap and discovery (`draft-unlisted-db.test.ts`, the `draftsOnly` scenes).
- **The e2e repairs were made by publishing in setup. No assertion was loosened.** Setup-only changes:
  - `discovery.spec.ts:31-35`
  - `mobile.spec.ts:349-355`
  - `player-upcoming.spec.ts:66-68,144-147,188`
  - `spectator-org-home.spec.ts:73-74,104-108,144`
  - `spectator-w2-kit.ts:215-228` (the new helper, which throws on failure rather than soft-passing)
  - DB seeds: `org-home-live-db.test.ts:134`, `public-player-upcoming.test.ts:198-202`, `discovery.test.ts:87,260`
- The count constants `SETUP_API_CALLS` and `SEED_CALLS` were raised by the publishes they add, not relaxed.
- Guards with teeth:
  - `listingChanged` has both a negative (a description edit fires nothing) and a positive (publish/unpublish fires).
  - Each SQL `<> 'draft'` has a DB assertion that would red if it were deleted.
  - `competition-listing.test.ts` enumerates the schema's own enums.
- The new walkthrough is registered in `WALKTHROUGH_SPECS` (`e2e-ci-wiring.test.ts:298-302`).
- Weakness: the e2e publish→listed step polls for up to `REVALIDATE_FAST+15s`. It would pass even if the write path never expired anything. The read-your-own-writes claim is proven only by the DB spy test and by smoke's hub-noindex "very next request" check, which uses the same `orgTag`. Smoke cannot prove the poll-key delete, because CI smoke has no Redis (`smoke.ts:2073-2078`). Acceptable, but know that the e2e does not prove the cache half.

## 3. Issues

### Critical
None.

### Important

**I1: CI gate red.**
- **Where:** `scripts/__tests__/check-vitest-collection.test.ts:47` (`REST`).
- **Problem:** this file keeps an explicit list of every suite in `src/server/public-site/__tests__`, and its own comments say that a new file there reds it on purpose. The branch adds `draft-unlisted-db.test.ts` (it starts with "d", so it belongs in `REST`) and does not list it. `git grep draft-unlisted` on that file finds nothing. #888 hit exactly this in the smoke-db job ("listed=47 vs 43") and fixed it in 02e3fb036. A green `cd apps/web && vitest` cannot see this gate.
- **Fix:** add `src/server/public-site/__tests__/draft-unlisted-db.test.ts` to `REST` with a one-line comment. Expect a trivial list conflict with #888's four additions.

**I2: UI copy false for every draft.**
- **Where:** `apps/web/src/dictionaries/en/ui.json:345` (`visibility.public.consequence`, "Anyone can find it — Google, and the Seazn discover page"), plus es/fr/nl.
- **Problem:**
  - `VisibilityPicker` (`components/ui/visibility-picker.tsx:23`) renders this line in the creation wizard (`competition-wizard.tsx:203`). Every competition the wizard creates is a draft, so the sentence is false at the exact moment the organiser reads it.
  - In settings (`competition-settings.tsx:310`), the same sentence sits a few rows above the new hint, which says the opposite ("Only people with the link can see it").
  - `tips.division.visibility.body` (`ui.json:1433`, "Public is findable on Google and our discover page") has the same problem.
  - RULES.md 2026-09-14 says "Wrong copy = defect."
- **Fix:** either qualify the public consequence ("…once published"; the Discover part also needs "if you showcase it"), or pass `status` into `VisibilityPicker` and swap in a draft variant. Update all 4 locales, and show the owner two options first (RULES 2026-09-07).

**I3: Canonical help page not updated.**
- **Where:** `apps/web/content/help/sharing/visibility.md:11` ("Who can see what", order 1 in Sharing).
- **Problem:** it still says Public means "indexable, listed on your public org page, and eligible for the Discover directory". The same false premise appears at `sharing/grow-your-club.md:25` ("public, discoverable competitions get listed there").
- **Fix:** add the publish condition and link to `getting-started/create-a-competition#visibility`.

**I4 (Gap hunt, owner decision needed before merge): the rollout silently unlists running competitions.**
- **Where:** `schedule.ts:3958-3975`.
- **Problem:** the start auto-promotion is deliberately `published`→`live` only. So a public competition whose organiser never used the Status select is still `draft` while its matches are in play. The smoke and DB scenes seed exactly that ("a started DRAFT … with a match in play"). At deploy, every such competition in prod disappears from:
  - its org home and the chip poll;
  - /discover, the sport pages, the marketing home strips and the `/live` wall;
  - sibling competitions' Upcoming rails.

  Organisers get no warning. The only nudge is the settings suggestion (`statusHint.published`). The start dialog (`start-confirm-dialog.tsx:84-91`) says nothing when you start play on a public draft.
- **Fix:**
  - The orchestrator counts it in prod before merge: public competitions with `status='draft'` and a division past `setup`, split by `discoverable`.
  - The owner then chooses between a one-off backfill and accepting the drop. A backfill would promote those rows to `published`, or to `live` where play has started. That fits greenfield schema policy, as a migration after V419.
  - Independently, the start dialog should nudge "still a draft — publish it?" when the competition is a public draft.

### Minor

**M1: A comment makes a false freshness claim, and the prod sitemap has no competitions at all.**
- **Where:** `competitions.ts:700`, "The sitemap needs nothing: it is 30s ISR on its own".
- **Problem:**
  - `app/sitemap.ts` has no `revalidate` or `dynamic` export. Next's own docs (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/sitemap.md:44`) say sitemap.js "is cached by default".
  - Live `https://seazn.club/sitemap.xml`, fetched 2026-09-27, returned `x-nextjs-cache: STALE` with **0 `/shared/` entries and 0 `/discover/<sport>` entries**, only the static list. The new filter is correct but has no effect in prod today.
- **Fix:** correct the comment. Surface the empty sitemap to the owner as a separate, pre-existing SEO gap. Do not absorb it here.

**M2: Redundant org-slug read after #888 merges.**
- **Where:** `competitions.ts:706-716`.
- **Problem:** after #888, `patchCompetition` already reads the org slug inside the transaction (`refOrgSlug`). The second SELECT here becomes redundant.
- **Fix:** reuse `refOrgSlug` when resolving the merge conflict (P3).

**M3: Stale contract and doc text.**
- **Where:**
  - `schemas.ts:5104`: `PublicOrgLive` doc, "LISTED (`visibility = 'public'`)".
  - `openapi.ts:224`: the discovery summary "opted-in public competitions". Public-API consumers see drafts vanish with no contract note.
  - `app/(public)/shared/[orgSlug]/page.tsx:1-2`: the header comment.
- **Fix:** add "past draft". Regenerating OpenAPI is owed per RULES (Pre-commit).

**M4: Help precision.**
- **Where and problem:**
  - `create-your-organisation.md:27` says the org page lists competitions that are "Public and **published**". Live, completed and archived competitions are listed too (`data.ts:583`), and the bolded word reads as the status name.
  - `create-a-competition.md:20` says "Set its Status to Published … and it appears". It omits that publishing is refused (402) when the public-page cap is already used (`competitions.ts:497-520`).
- **Fix:**
  - Reword `create-your-organisation.md:27` to "Public and no longer a draft (published, live or finished)", and re-take the `_approved-copy.ts` digest.
  - Add one sentence on the cap to `create-a-competition.md`.

**M5: Hint accessibility and unverified layout.**
- **Where:** `competition-settings.tsx:341-348`.
- **Problem:**
  - The hint is inside the Status `<label>`, so it becomes part of the select's accessible name. The pre-existing `showSuggestion` span has the same pattern.
  - The hint sits in one half of a `grid-cols-2` row. At 320px that is about 140px, so roughly six lines.
  - The branch has no 320/768/1280 screenshot evidence for the settings page. The e2e only checks the org home at 320.
- **Fix:** move the hint out of the label and use `aria-describedby`. Screenshot the settings page at all three widths.

**M6: Cache-aside race on the poll key (bounded).**
- **Where:** `usecases/public.ts:106-123`.
- **Problem:** a poll rebuild that was already in flight when the publish ran can write the pre-publish list back after the `cacheDel`, and serve it for up to `ORG_LIVE_TTL_SECONDS` (15s). #888's lease pattern would close this.
- **Fix:** accept, or mention it. No fix owed.

**M7: Naming nit.**
- **Where:** `lib/competition-listing.ts:23`.
- **Problem:** `UNLISTED_STATUS = "draft"` reads like the `unlisted` visibility value.
- **Fix:** rename to `DRAFT_STATUS` or `UNPUBLISHED_STATUS`.

## 4. Gap hunt
1. **Collection gate (I1).** This is the repo-root scripts suite the per-app vitest run cannot see. It is the same class as the "Wave gate gap" memory.
2. **Prod data and rollout impact, plus the missing start-dialog nudge (I4).** No test can see this. It needs a prod count and an owner call.
3. **Copy that reads false for a draft outside the edited files (I2, I3).** The implementer fixed the two help pages named in the brief and missed the canonical "Who can see what" page, the picker, and the tip.
4. **Sitemap is static and empty in prod (M1).** It is pre-existing, but the new code comment asserts the opposite.
5. **Migration merge-order dependency on #888, plus the one textual conflict (P3, M2).**
6. **Unverified here:** e2e and smoke pass counts. Of the setup publishes, `spectator-org-home.spec.ts` publishes three competitions in a Community org, so it depends on the spec's "caps" override covering the public-page cap, because publishing is quota-gated. The orchestrator must re-run:
   - `draft-unlisted-db.test.ts`, `discovery.test.ts`, `public-player-upcoming.test.ts`, `org-home-live-db.test.ts`
   - the four page tests and `competition-settings-draft-hint.test.tsx`
   - `scripts/__tests__/check-vitest-collection.test.ts`
   - the new walkthrough, plus `discovery.spec.ts`, `player-upcoming.spec.ts`, `spectator-org-home.spec.ts`, and `mobile.spec.ts` as a WHOLE file (serial)
   - smoke `hubKnockoutSuite` and `gapSuite`

   Use the JSON reporter, and confirm `.testResults[].name` resolves to this branch.
