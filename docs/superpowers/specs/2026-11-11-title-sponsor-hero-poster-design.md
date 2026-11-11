# Title sponsor poster in the competition hero: design

**Status:** owner-approved 2026-11-11 (Option B, 4:5). Approved design notes:
`.superpowers/sdd/2026-11-07-sponsor-deals/title-poster-design.md`. Mockups (layout only; the build uses the house theme):
`~/seazn-artifacts/2026-11-11_title-sponsor-hero-poster-mockups_a7c3e1/index.html`.
**Plan:** `docs/superpowers/plans/2026-11-11-title-sponsor-hero-poster.md`.
**Branch:** `feat/title-sponsor-poster`, cut from `origin/main` at `6e911d17c1`. That commit already includes the sponsors hub polish (#1179).

## 1. Intent

The owner was looking at the public competition hero. On desktop its right half is empty. The owner asked:

> "should we use this space for title sponsor and in phone, we can display next to the hero? and rotate it if multiple
> title sponsor and have a instagram size?"

After the mockups, the owner said:

> "apply rec and when I click the image it will go to link if provided"

After a review screenshot (a mock name clipped in its pill, and tiny dots), the owner said:

> "apply rec"

That second "apply rec" adds two rules. A name is never clipped: it wraps to 2 lines, then ends in an ellipsis. The dots are readable and big enough to tap.

**Owner value.** Clubs already make Instagram flyers. Today, one club (Pandyas, on stg) uploaded a "20% OFF" flyer as its logo. The Title tier is the one tier sold on prominence. A 4:5 poster beside the competition name is the most visible space on the page, so it is a placement the club can sell. On a phone, the page grows by one band, and only when a Title sponsor exists.

## 2. Goals

- G1. A sponsor can carry an optional **poster**: a 4:5 portrait image (Instagram portrait size; 1080 × 1350 is
  recommended), PNG, JPG or WebP, 2 MB at most. The logo stays the logo.
- G2. On the public competition page, the Title sponsors are shown with the same gate that "Presented by" uses today:
  - From `md` (768) up, a **poster panel** sits in the hero's right column.
  - Below `md`, a **band** sits directly under the hero.
- G3. With 2 or more Title sponsors, the posters **rotate**:
  - They crossfade every 6 s.
  - Dots let a reader pick one, and each dot has a 44 px hit area.
  - Rotation pauses on hover and on focus.
  - With `prefers-reduced-motion`, nothing rotates on its own.
- G4. A sponsor with **no poster** shows its logo, centred on a white 4:5 card, with its name.
- G5. Clicking the poster or the band follows the sponsor's link **if it has one**. The click goes through the existing tracked redirect, so it is counted. A sponsor with no link gets no link and no dead anchor.
- G6. The sponsor page's Details editor gets a **"Poster (optional)"** upload. Its hint names 1080 × 1350 and says where the poster shows.
- G7. All four locales (en, es, fr, nl). The design works at 320, 768 and 1280, with no horizontal page scroll.

## 3. Non-goals

- The public **match page** is not changed. Its board keeps the title line with its 40 px logo (controller call; the owner may overrule).
- No poster on the kiosk (`/present`), the OG image, embeds, slideshows, the stream overlay or exports. The resolver carries the field, but none of those surfaces draws it.
- No server-side image processing, and no in-app cropping. The crop is the browser's `object-cover`, previewed live in the editor.
- No deletion of the old storage object when a poster is replaced or removed. The logo has never done this either.
- No new click source. Poster and band clicks count as `site`, the same as every other link on the competition page.
- No new plan gate on the write. The write is ungated, like `logo_path`. What is gated is the display: the Title placement.

## 4. Facts re-pinned against the tree, and false premises

| Fact | Where (at `6e911d17c1`) |
|---|---|
| Hero = `<section data-testid="mh-hero">` inside the competition page; the title line is `<SponsorsHeroTitle>` under the dates | `apps/web/src/app/(public)/live/[orgSlug]/[competitionSlug]/page.tsx:238-305` |
| Gate: `tiered = hasFeature(org.id, "sponsors.tiers", competition.id)`; an Event Pass on this competition lifts it | same file `:165` |
| Rows: `resolveSponsors(org.id, competition.id, { tiered })`. It returns active rows only, scoped to "this competition OR org-wide". Competition-scoped rows come first, then by tier rank, `display_order`, `created_at`, `id`. Duplicate names are dropped. `tiered:false` collapses every tier to `partner`. | `apps/web/src/server/usecases/sponsors.ts:458-489` |
| `SponsorsHeroTitle` shows **every** title row (a wrapped row of "Presented by X" sentences), filtering with `tiered ? tier==="title" : []` | `apps/web/src/components/public-site/sponsors-board.tsx:154-175` |
| Title line logo: `logoChip(s, 40, "h-10 w-10")`, a 40 px image on a white chip with `p-0.5` | same file `:133-143`, `:91-98` |
| Tracked link: `sponsorHref(s, tag)` returns `/s/<id>?src=site` (null when there is no url). The link uses `target="_blank" rel="nofollow noopener sponsored"` | same file `:85-87`, `:102-118`; `lib/sponsor-clicks.ts:61-64`; route `app/s/[key]/route.ts` |
| Logo upload: the browser POSTs `{content_type}` to `/api/orgs/{orgId}/content-upload`, then PUTs the bytes to the signed `upload_url`. The stored value is the **public CDN URL** (`logo_path` holds a URL despite its name). | `apps/web/src/components/org-sponsors.tsx:431-456`; route `app/api/orgs/[id]/content-upload/route.ts` |
| Limits: `MAX_LOGO_BYTES = 2 MiB` and `LOGO_TYPES = png/jpeg/webp`. Both are **client-side** (`pickLogo`, `accept`). The route also takes `image/gif` and enforces no size. The route comment says the bucket enforces 2 MB, but no bucket policy is in the repo, so that is not verifiable here. | `org-sponsors.tsx:39-47`, `:458-466` |
| `sponsors` table (V283) plus `on_stream` (V492) plus `placement_from_deal_id` (V495). RLS and grants are table-level, so a new column needs no new grant or policy. | `db/migration/deltas/V283__sponsor_crm.sql:9-33` |
| Two parallel write schemas: runtime `CreateSponsorInput`/`PatchSponsorInput` and OpenAPI `CreateSponsor`/`PatchSponsor`, each patch a `patchOf` twin. `url-write-schemas.test.ts` requires a probe for **every** create field. | `usecases/sponsors.ts:101-122`; `server/api-v1/schemas/sponsors.ts:90-140`; `server/sponsors/__tests__/url-write-schemas.test.ts:61-110` |
| A live deal locks `tier`, `competition_id`, `on_stream`, `status` and nothing else (`LOCKED_BY_LIVE_DEAL`). A poster PATCH is therefore allowed on a live Title deal. | `server/sponsors/deal-apply.ts:245-261` |
| Sponsor page Details: read-only `<dl>`, or `renderEditor()`, which renders `SponsorForm compact` | `components/sponsors/sponsor-sheet.tsx:298-380`; `org-sponsors.tsx:762-776`, `:501-517` |
| `public-image-contract.test.ts` pins the **first** `<Image>` in `sponsors-board.tsx` to `src={sponsor.logo}` and `width={px}` | `apps/web/src/lib/__tests__/public-image-contract.test.ts:38-85` |
| next/image in production does not check `remotePatterns` at render (dev only), so a non-storage host shows as a broken image rather than a crash. e2e runs with `NEXT_PUBLIC_SUPABASE_URL=https://stub.supabase.co` and a stubbed storage. | `node_modules/next/dist/shared/lib/image-loader.js:14-80`; `.github/workflows/e2e.yml:636` |
| Migrations: main's max is **V499** (V497 is unused). Open PR #1176 holds V500 (and V501–V502 by plan). **This feature authors V503** and renumbers at merge. | `db/migration/deltas/` |
| PR #1176 (sponsor deals PR 3) also edits `usecases/sponsors.ts`, `api-v1/schemas/sponsors.ts`, `org-sponsors.tsx`, the four `ui.json`, `i18n-keys.ts`, `e2e-ci-wiring.test.ts` and `openapi/v1.json`. Whichever PR merges second rebases. | `gh pr view 1176` |

**Premises in the design that proved false or incomplete:**

1. **"Drop its 88px logo tile".** The hero's title logo is **40 px** (`logoChip(s, 40, …)`, about 44 px with its chip padding). The decision still holds: the hero's title line drops the logo, because the panel or the band now carries the sponsor's image.
2. **"The hero's empty right side".** The right side is not always empty. When registration is open, the **Register** button (`mh-hero-register`) sits at the top right of the hero's first row. The mock leaves it out. This spec keeps Register in the left column's first row (§7.2).
3. **The mock's phone band** splits "Presented by" (small) and the name (large). That split contradicts the standing i18n ruling in the `sponsors-board.tsx` header: `landing.presentedBy` is one **sentence** and is rendered whole, because a split pins English word order into the markup. The band renders the whole sentence.
4. **"PNG/JPG/WebP ≤ 2 MB"** is enforced in the browser only. The poster reuses the logo's constants, so it is exactly as strong as the logo, no stronger. (The bucket cap is not in the repo.)
5. **E2E cannot upload to storage** (the logo upload is "NOT DRIVEN" in `sponsors-journey.spec.ts`). This feature stands in at the storage boundary in the browser instead (§10).

## 5. Decisions

| # | Decision | Source |
|---|---|---|
| D1 | Option B, 4:5 poster: panel from `md`, band below `md` | Owner: "apply rec" |
| D2 | Poster = optional per-sponsor image, 4:5, 1080 × 1350 recommended, PNG/JPG/WebP, ≤ 2 MB, `object-cover` centre crop; logo unchanged | Owner (approved design) |
| D3 | Who shows: tier `title` on this competition (scope all or this competition), active, behind `sponsors.tiers` / Event Pass, the same gate as "Presented by" | Owner (approved design) |
| D4 | Several Title sponsors: crossfade every 6 s, dots with 44 px targets, pause on hover/focus, reduced motion means no auto-rotate | Owner (approved design) |
| D5 | No poster: the logo centred on a white 4:5 card, with the name | Owner (approved design) |
| D6 | Click: poster and band link to the sponsor's url **if provided**, via the tracked redirect; no url means no anchor | Owner: "when I click the image it will go to link if provided" |
| D7 | Editor: "Poster (optional)" on the sponsor page's Details editor, with a hint naming 1080 × 1350 and where it shows | Owner (approved design) |
| D8 | A name is never clipped. Drawn text (fallback card name, panel caption, band sentence) wraps to at most 2 lines and then ends in an ellipsis, with `min-w-0` down the whole chain. The full text stays in `title` and in the accessible name. Pinned by a 43-character name at 320/768/1280. We draw no text on the poster. | Owner: "apply rec" (2nd) |
| D9 | Dots: 8 px dot, 20 px active pill, ≥ 3:1 contrast against the poster's own colours by sitting on a dark strip, a 44 px hit area each, and no dots for one sponsor | Owner: "apply rec" (2nd) |
| D10 | The hero keeps its "Presented by" sentence from `md` up, **without** its logo. Below `md` the hero sentence is hidden (`max-md:hidden`), because the band directly under the hero carries the same sentence, so it is on the page at every width. The match page is untouched. | Controller call (keep the line; drop the tile); this spec applies it per width as mock B draws it |
| D11 | Upload form: the preview **is** the crop (a 4:5 `object-cover` tile). It warns when **more than 25 %** of the width or the height would be cut. | Mock "Upload spec" box, part of the approved recommendation |
| D12 | Dot tap = show that sponsor **and stop the rotation for this page view**. This is the WCAG 2.2.2 pause/stop mechanism, alongside the hover and focus pause and reduced motion. No separate pause button is drawn. | This spec. The owner may ask for a visible pause button (§13) |
| D13 | `poster_path` (column + API) holds the public CDN URL, as `logo_path` does. It must be an http(s) URL of at most 500 characters at every write (both zod schemas and a DB `CHECK`). | This spec (assumption made a guard: next/image throws on a relative non-`/` src) |
| D14 | A poster that fails to load (deleted object, non-storage host, optimizer 4xx) falls back to the logo card, client-side (`onError`). The premium slot never shows a broken image. | This spec |
| D15 | "Remove poster" in the editor (PATCH `poster_path: null`). A poster is usually a dated promotion. | This spec |
| D16 | The poster field and the read-only Poster row show only when the org can place a Title sponsor (`hasTiers`: tiers org-wide or on any pass). The write itself is not gated (like the logo), so a downgrade keeps the file for a re-upgrade. | This spec |
| D17 | Copy keys for the public page live under a new `titleSponsor.` prefix in `public.json`, not `landing.`. They are resolved on the server into strings, so they never ride in the hub's client dictionary slice (`lib/hub-dict.ts` slices `landing.*`). | This spec |
| D18 | The desktop panel draws the sponsor's name as a caption under the 4:5 box for every slide, with 2 lines of height reserved so rotation never shifts the layout. The fallback card also draws the name inside it, as in the approved mock. | Mock (approved). This is the one place a name shows twice; the owner sees it in sign-off |

## 6. Data and API

### 6.1 Migration `V503__sponsor_poster.sql` (renumber at merge; tests find it by suffix)

```sql
alter table sponsors add column poster_path text null;
alter table sponsors add constraint sponsors_poster_path_check
  check (poster_path is null or (poster_path ~* '^https?://' and char_length(poster_path) <= 500));
```

There is no backfill, because the schema is greenfield. RLS and grants are table-level, so nothing else is owed.

### 6.2 Server types and schemas

- `SponsorRow.poster_path: string | null`. `COLS` gains `"poster_path"` right after `"logo_path"`. `createSponsor`'s INSERT writes it.
- `CreateSponsorInput` and OpenAPI `CreateSponsor` gain `poster_path: z.string().url().max(500).refine(isRedirectableUrl, { message: SPONSOR_URL_HTTP_ONLY }).nullish()`, placed right after `logo_path`. Both patches inherit it through `patchOf`, so key order stays `[...create keys, "on_stream"]`.
- OpenAPI `Sponsor` gains `poster_path: z.string().nullable()`. Regenerate `openapi/v1.json` and `openapi/v1.public.json`.
- `ResolvedSponsor.poster: string | null`. `resolveSponsors` selects `poster_path`. Order, dedupe and the tier collapse are unchanged.
- `SponsorItem.poster_path: string | null` (the client mirror).
- `patchSponsor` needs no change. `poster_path` is not a `PLACEMENT_FIELDS` member, so a poster write keeps the deal's provenance. It is not in `LOCKED_BY_LIVE_DEAL`, so a live Title deal's sponsor can change its poster. `expirePublicSponsors` already busts the page.

### 6.3 PATCH semantics

| Body | Result |
|---|---|
| `{poster_path: "https://…/x.png"}` | Set, or replaced on a second call |
| `{poster_path: null}` | Removed: the page shows the fallback card |
| `{poster_path: "javascript:…"}`, `"logos/x.png"`, or more than 500 characters | 400 at the schema (the DB `CHECK` is the second guard) |
| A sponsor with a live deal | 200 (not 409): the poster is not a placement field |
| Another org's sponsor | 404 (RLS), as today |

## 7. Public UI

### 7.1 Which sponsors, and the empty case first

`titleSlides(sponsors, tiered, dict, clickTag)` is **empty** when any of these holds:
- the org is not tiered;
- no row has tier `title`;
- the competition has no sponsors at all.

When it is empty:
- the hero renders exactly as today, with a single column and no grid classes;
- there is no band;
- no sentence is drawn.

Otherwise it returns one slide per title row, in resolver order. `hasTitleSponsor(sponsors, tiered)` is the one predicate that the hero sentence, the panel, the band and the page's layout switch all read.

Slide = `{ id, name, href (sponsorHref, site tag) | null, poster | null, logo | null, sentence ("Presented by {sponsor}", whole), posterAlt, dotLabel }`.

### 7.2 1280 (and `lg`, 1024 and up)

- The hero's inner wrapper becomes a two-column grid only when a title sponsor exists: `md:grid md:grid-cols-[minmax(0,1fr)_auto] md:items-start md:gap-x-6 lg:gap-x-8`.
- The left column holds today's two rows unchanged: the competition logo, the title block, Register, then the counters chips.
- The title block's "Presented by …" sentence is kept, without the logo chip.
- The right column is the panel (`data-testid="mh-hero-poster"`, `max-md:hidden`), 300 px wide at `lg`. It contains, top to bottom:
  - the micro-label "Title sponsor", in the org kicker's style: `text-[11px] font-semibold uppercase tracking-[0.22em] text-court-muted`;
  - the 4:5 box (`rounded-xl overflow-hidden`, 300 × 375, ring `white/18`, shadow), holding the slides stacked;
  - the caption: the current sponsor's name in display type, `line-clamp-2 break-words`, `title={name}`, with 2 lines reserved.
- At 1280 the content is 992 px, so the left column keeps about 596 px.

### 7.3 768 and 834

- Same panel, **220 px** wide (`md:w-[220px] lg:w-[300px]`, so the box is 220 × 275).
- Gap 24.
- The left column keeps about 428 px.

### 7.4 320 (below `md`)

- Hero: unchanged except that its "Presented by" sentence is hidden (`max-md:hidden`). Its bottom margin drops to `max-md:mb-2.5` when a band follows.
- Band (`data-testid="mh-title-band"`, `md:hidden mb-6`):
  - It is a `rounded-2xl bg-court text-court-ink shadow` grid, `grid-cols-[56px_minmax(0,1fr)_auto] gap-3 p-3 items-center`.
  - Thumbnail: the 4:5 box, 56 × 70, `rounded-md`, with a white/20 ring.
  - Sentence: the whole sentence in `font-display text-base uppercase leading-tight line-clamp-2 break-words`, with `title`.
  - **Visit**: a span styled like the hero's Register button (`min-h-11 rounded-lg bg-surface px-3.5 text-sm font-semibold text-accent-strong`), drawn **only** when the slide has a link.
- Linked slide: the whole band row is **one** `<a>` (no nested interactive). Unlinked slide: a `<div>`.
- With 2 or more slides, the dots row spans the grid under the row.
- Band height is about 76 px. The content width at 320 is 288.

### 7.5 A slide's face

- **Poster:** next/image `width={POSTER_WIDTH} height={POSTER_HEIGHT}` (1080 × 1350), `object-cover`, and `sizes`:
  - panel: `"(min-width: 1024px) 300px, 220px"`;
  - band: `"56px"`.
  - It loads lazily, so the hidden variant never downloads.
  - `onError` marks the slide broken, and the slide then renders the fallback (D14).
- **Fallback:** a white 4:5 card.
  - With a logo: the logo is centred, `object-contain`, at 60 % of the card's width, with the name under it in dark ink, `line-clamp-2`. The name appears in the panel only; in the 56 px band thumbnail, the logo is alone.
  - With no logo either: a monogram (the first letter of the name) on an accent-coloured rounded square.

### 7.6 Rotation

- `TITLE_ROTATE_MS = 6000`. The crossfade is `transition-opacity duration-700`, plus `motion-reduce:transition-none`.
- `autoRotates({count, reducedMotion, paused, stopped})` is true only when `count ≥ 2`, reduced motion is off, the showcase is not paused, and the rotation has not been stopped.
- Pausing:
  - **paused** = a mouse pointer is over the showcase, or focus is within it;
  - **stopped** = a dot was tapped (D12).
- One slide: no dots, no timer, no carousel roles.
- Slides that are not current get `aria-hidden` and `inert`, so they are not focusable. The panel caption and the band sentence follow the current slide.

### 7.7 Dots (D9)

- 44 × 44 buttons. Inactive: an 8 px `bg-white/50` circle. Active: a `bg-white` pill, 20 × 8. `aria-current="true"` on the active dot, `aria-label = "Show {sponsor}"`.
- **Panel:** a dark capsule (`rounded-full bg-black/70`) holds the dots, centred 8 px above the poster's bottom edge.
  - Contrast is checked against both worst-case poster pixels:
    - over a white pixel, the strip is about `#4d4d4d`: active about 8.5:1, inactive about 3.5:1;
    - over a black pixel: active about 21:1, inactive about 5.2:1.
  - Every value clears WCAG 1.4.11's 3:1, and the active dot also differs in shape.
- **Band:** the dots sit on the court colour under the row, with no capsule.

### 7.8 Accessibility

- With 2 or more slides, the showcase root is a `section` with `aria-roledescription="carousel"` and `aria-label` "Title sponsors".
- The slide container is `aria-live="off"` while rotating and `"polite"` otherwise.
- Accessible names:
  - the panel link: `aria-label` = the sponsor's name;
  - an unlinked poster: alt "{sponsor} poster";
  - the band link: its own text (the sentence, then "Visit");
  - the band thumbnail: `alt=""`, because the sentence already names the sponsor.
- Reduced motion is read through `useSyncExternalStore` (`components/ui/use-prefers-reduced-motion.ts`). It is SSR-safe, and it is not a setState in an effect, which the repo's `react-hooks/set-state-in-effect` lint rule bans.

### 7.9 Click behaviour

- A link exists only when `href !== null`. It is `href={sponsorHref(s, {source:"site"})}`, `target="_blank" rel="nofollow noopener sponsored"`. These are the existing helper and attributes, so the click is counted by `/s/[key]` as source `site`.
- With no url there is no `<a>`, no Visit and no `href=""`.
- The hero sentence keeps its existing link.

## 8. Editor UI (sponsor page, Details)

- **Read-only row**, shown only when `hasTiers`. It sits after Link and before the tier rows:
  - `dt` "Poster";
  - `dd` is a 4:5 thumbnail (48 × 60, `object-cover`, ring), or the text "None, the logo shows instead".
- **Editor**: a `PosterField` inside the compact `SponsorForm`, between the name/link fields and Save. It is only on the sponsor page, and only when `hasTiers`; the Add form never has it. It contains:
  - a label, "Poster (optional)";
  - a dashed 4:5 tile button, 96 × 120. Its `aria-label` is "Poster" and it is described by the hint. When a poster is picked or stored, the tile shows the preview as `object-cover`, which is the live crop;
  - a hidden `<input type="file" accept={LOGO_ACCEPT}>`;
  - the hint: "Shows beside the competition name while this sponsor is a Title sponsor. {formats}, up to {mb} MB. Best at 1080 × 1350 (4:5, Instagram portrait)." The formats, the MB and the size are read from the same constants the picker enforces;
  - **Remove poster**, shown when a poster is stored or picked;
  - the crop warning, when `posterCrop(w,h).warn`.
- Picking a file:
  - A file over `MAX_LOGO_BYTES` is refused at once: "Posters can be up to {mb} MB."
  - Otherwise the file is measured with `createImageBitmap` (when that fails, no warning is shown).
- Save:
  - The patch body comes from the pure `sponsorEditPatch(...)`.
  - A picked poster is uploaded with the existing `uploadLogo` (the content-upload grant). Its URL then goes into `poster_path`.
  - A removal sends `poster_path: null`, but only when one is stored.
  - When nothing changed, nothing is sent.

## 9. Plan gating, granted and denied

| State | Hero sentence | Panel / band | Editor field / row |
|---|---|---|---|
| Pro, or Event Pass on this competition, with a title row | shown ≥ md (no logo) | shown | shown |
| Free org, with a leftover `title` row (bought, then downgraded) | none | none (row is on the flat strip) | hidden |
| Event Pass on **another** competition | none on this page | none | shown (`hasTiers`) |
| Pro, no title rows | none | none (hero unchanged) | shown |

## 10. Locales

**Public (`public.json`), resolved on the server into props**

| Key | en | es | fr | nl |
|---|---|---|---|---|
| `titleSponsor.kicker` | Title sponsor | Patrocinador principal | Sponsor titre | Titelsponsor |
| `titleSponsor.group` | Title sponsors | Patrocinadores principales | Sponsors titres | Titelsponsors |
| `titleSponsor.show` | Show {sponsor} | Mostrar {sponsor} | Afficher {sponsor} | {sponsor} tonen |
| `titleSponsor.posterAlt` | {sponsor} poster | Cartel de {sponsor} | Affiche de {sponsor} | Poster van {sponsor} |
| `titleSponsor.visit` | Visit | Visitar | Visiter | Bezoeken |

**Console (`ui.json`)**

| Key | en | es | fr | nl |
|---|---|---|---|---|
| `sponsors.poster.label` | Poster (optional) | Cartel (opcional) | Affiche (facultatif) | Poster (optioneel) |
| `sponsors.poster.hint` | Shows beside the competition name while this sponsor is a Title sponsor. {formats}, up to {mb} MB. Best at {width} × {height} (4:5, Instagram portrait). | Se muestra junto al nombre de la competición mientras este patrocinador sea Principal. {formats}, hasta {mb} MB. Ideal a {width} × {height} (4:5, retrato de Instagram). | S'affiche à côté du nom de la compétition tant que ce sponsor est Titre. {formats}, jusqu'à {mb} Mo. Idéal en {width} × {height} (4:5, portrait Instagram). | Staat naast de naam van de competitie zolang deze sponsor Titel is. {formats}, tot {mb} MB. Het best op {width} × {height} (4:5, Instagram staand). |
| `sponsors.poster.remove` | Remove poster | Quitar cartel | Retirer l'affiche | Poster verwijderen |
| `sponsors.poster.tooBig` | Posters can be up to {mb} MB. | Los carteles pueden pesar hasta {mb} MB. | Les affiches peuvent atteindre {mb} Mo. | Posters mogen maximaal {mb} MB zijn. |
| `sponsors.poster.cropWidth` | This picture is wider than 4:5, so {percent}% of its width will be cut off. {width} × {height} fits exactly. | Esta imagen es más ancha que 4:5, así que se recortará el {percent}% de su ancho. {width} × {height} encaja exactamente. | Cette image est plus large que 4:5 : {percent} % de sa largeur sera coupé. {width} × {height} s'ajuste exactement. | Deze afbeelding is breder dan 4:5, dus {percent}% van de breedte valt weg. {width} × {height} past precies. |
| `sponsors.poster.cropHeight` | This picture is taller than 4:5, so {percent}% of its height will be cut off. {width} × {height} fits exactly. | Esta imagen es más alta que 4:5, así que se recortará el {percent}% de su alto. {width} × {height} encaja exactamente. | Cette image est plus haute que 4:5 : {percent} % de sa hauteur sera coupé. {width} × {height} s'ajuste exactement. | Deze afbeelding is hoger dan 4:5, dus {percent}% van de hoogte valt weg. {width} × {height} past precies. |
| `sponsors.sheet.poster` | Poster | Cartel | Affiche | Poster |
| `sponsors.sheet.noPoster` | None, the logo shows instead | Ninguno, se muestra el logotipo | Aucune, le logo s'affiche à la place | Geen, het logo wordt getoond |

Both dictionaries take the new keys in a **new block**, inserted rather than reordered (AGENTS.md class 18; #1176 also edits `ui.json`). Regenerate `lib/i18n-keys.ts` (`npm run i18n:gen-keys`) and run `npm run i18n:check`.

## 11. Crop rule (D11), stated as geometry

The box is 4:5. An image of width `w` and height `h`, `cover`-fitted into it, loses:
- part of its **width** when `5w > 4h`; the fraction lost is `(5w − 4h) / 5w`;
- part of its **height** when `5w < 4h`; the fraction lost is `(4h − 5w) / 4h`.

The warning shows when more than 25 % is lost:
- for the width, when `15w > 16h`;
- for the height, when `3h > 5w`.

The percent shown is `ceil(100 × lost)`, computed from the integer numerator and denominator.

Worked values (the tests use these):

| Size | Side cut | Percent | Warning |
|---|---|---|---|
| 1080 × 1350 | none | 0 | no |
| 1080 × 1080 | width | 20 | no |
| 1600 × 1500 | width | 25 | no (boundary) |
| 1601 × 1500 | width | 26 | yes |
| 1920 × 1080 | width | 55 | yes |
| 1080 × 1800 | height | 25 | no (boundary) |
| 1080 × 1801 | height | 26 | yes |
| 1080 × 1920 | height | 30 | yes |

A width or height that is zero, negative or not finite means "unknown". No warning is shown, and nothing throws.

## 12. Tests owed (the plan carries them per task)

- **Unit and DB.** These cover:
  - the migration `CHECK`, with every refusal named next to its accepted twin;
  - both write schemas;
  - the PATCH sequence: set, replace, remove, again on a live deal, and another org;
  - the resolver: the poster for each scope, gone when the sponsor is inactive or pending, still carried under the tier collapse;
  - `posterCrop`, `autoRotates` (empty case first), `nextSlide` and its refusal;
  - the showcase markup and its timers (harness and fake timers), dot contrast computed from the shipped classes;
  - the slide builder in four locales, the page wiring, the editor field and `sponsorEditPatch`, and the read-only row.
- **E2E.** These cover:
  - `mobile.spec.ts` at all seven widths: band below 768, panel from 768, no page scroll, dots 44 px and hit-tested, a 43-character name in at most 2 lines, axe clean;
  - a new walkthrough, `e2e/walkthrough/title-sponsor-poster.spec.ts`: upload tapped, seen logged out, tapped and counted, removed, fallback, broken image, rotation, reduced motion, downgrade.
- **Smoke.** These run through `scripts/smoke/suites/sponsors.ts`:
  - poster set, refused and removed through the v1 API;
  - the public HTML carries the panel, the band and the encoded poster URL;
  - a free org's page carries none of them.
- **Regression.** These cover:
  - the match page keeps its 40 px title logo;
  - a free org gets no title placement;
  - the sentence stays whole;
  - the image contract holds for both files.
- **Sign-off.** CI captures at 320/768/1280, published as a page on `:8765`, with a verdict from the owner for each screen.

## 13. Open questions for the owner

1. **A visible pause button.** D12 meets WCAG 2.2.2 with "a dot tap stops the rotation", plus pause on hover and focus, plus reduced motion. The other option is a small pause/play button in the dots row. **Recommendation:** ship without it. It adds a control to a slot that is sold on cleanliness, and the dots already stop the rotation. Revisit if an accessibility audit asks.
2. **The Packages legend.** The Title tier's legend currently says "Named under the competition name on your public pages." Should it also say "with its poster beside it"? **Recommendation:** yes. It is one sentence in four locales, and it helps the club sell the slot. It is not in this plan unless approved.
3. **The name drawn twice on a fallback card on desktop** (D18): once in the card and once as the caption. The mock draws it this way. **Recommendation:** keep it, and judge it in the sign-off screenshots.
