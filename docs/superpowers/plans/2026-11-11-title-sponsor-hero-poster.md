# Title Sponsor Poster in the Competition Hero: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A sponsor gets an optional 4:5 poster. Title sponsors show it:
- in a poster panel in the public competition hero, from 768 up;
- in a band under the hero, below 768.

With several Title sponsors, the posters rotate. A sponsor with no poster gets a logo card. A click goes through the tracked `/s/` redirect. The poster is uploaded from the sponsor page's Details editor.

**Architecture:**
- **Storage and API.** One new nullable column, `sponsors.poster_path` (V503). The poster rides through the existing sponsor write schemas and `resolveSponsors`, and is uploaded through the existing content-upload grant.
- **Public side.**
  - The server (`sponsors-board.tsx`) builds serialisable slides: it gates them and resolves their strings.
  - One client component (`title-sponsor-showcase.tsx`) draws them, as a panel or as a band, and owns the rotation.
  - The competition page mounts the panel inside the hero's new right-hand column and the band under the hero.
- **Editor.** A `PosterField` added to the compact `SponsorForm` on the sponsor page.

**Tech stack:**
- Next 16 App Router with `next/image`, React 19.2.4 and Tailwind v4.
- zod 4, postgres.js and Flyway.
- Tests: vitest (node environment, `renderToStaticMarkup` plus `components/__tests__/_hook-harness.tsx`), Playwright run on CI, and the `scripts/smoke` harness.

**Spec:** `docs/superpowers/specs/2026-11-11-title-sponsor-hero-poster-design.md`. Read it first. It holds the re-pinned facts (§4), the decisions D1–D18 (§5), every dimension (§7), the copy in four locales (§10) and the crop geometry (§11).

## Global Constraints

- Worktree is `/Users/ashokhein/github/seazn.club-worktrees/title-sponsor-poster`, branch `feat/title-sponsor-poster`. Every Bash call starts with `cd <worktree> &&`. Never `git stash` and never `git checkout <file>`. Restore a mutant from a `cp` backup.
- The migration is authored as **`V503__sponsor_poster.sql`** and renumbered at merge, after PR #1176's V500–V502. Tests find it **by suffix** (`/^V\d+__sponsor_poster\.sql$/`), never by number.
- `poster_path` holds the public CDN URL, the same way `logo_path` does. It must be an http(s) URL of at most 500 characters, checked at both zod schemas and by the DB `CHECK sponsors_poster_path_check`.
- The poster picker reuses `MAX_LOGO_BYTES` (2 MiB), `LOGO_TYPES` (png, jpeg, webp), `LOGO_ACCEPT`, `LOGO_FORMAT_NAME` and `uploadLogo` from `org-sponsors.tsx`. It defines no parallel constants.
- Values exact from the spec:
  - Poster: `POSTER_WIDTH = 1080`, `POSTER_HEIGHT = 1350`.
  - Rotation: `TITLE_ROTATE_MS = 6000`, crossfade `duration-700`.
  - Panel: `md:w-[220px] lg:w-[300px]`.
  - Band: `grid-cols-[56px_minmax(0,1fr)_auto]`.
  - Dots: 44 × 44 buttons (`h-11 w-11`), an inactive 8 px dot `bg-white/50`, an active `bg-white` 20 × 8 pill.
  - The panel's dot capsule: `rounded-full bg-black/70`.
- Every link to a sponsor is `sponsorHref(s, { source: "site" })` (`/s/<id>?src=site`) with `target="_blank" rel="nofollow noopener sponsored"`. A sponsor with no url gets **no `<a>` and no `href` attribute**.
- Gate: `hasTitleSponsor(sponsors, tiered)` is the only predicate. Its `tiered` comes from the page's existing `hasFeature(org.id, "sponsors.tiers", competition.id)`. The public **match page** is not changed.
- Copy:
  - public keys use the `titleSponsor.` prefix in `public.json`;
  - console keys go in `ui.json`;
  - all four locales, with exact strings from spec §10;
  - each dictionary takes the keys in a new block. Never reorder existing keys, because #1176 edits the same files;
  - after a dictionary edit, run `npm run i18n:gen-keys` and `npm run i18n:check` from the repo root.
- `npm run openapi:gen` after any schema change. Commit `openapi/v1.json` and `openapi/v1.public.json`. `git status --porcelain openapi/` must be clean after a second gen.
- **Tests (TEST-STRATEGY.md, owner 2026-09-28):**
  - list the state transitions and the empty case first;
  - every sweep counts what it checked, and **zero is a failure**;
  - expected values come from the spec, the dictionary JSON or a declared constant, never from the function under test;
  - **mutate the guard you added once**, restoring from a `cp` backup, and report the killer;
  - sport sweep: not applicable. Sponsor placement is sport-agnostic, so each test file states this once in its header.
- **Local verification (owner 2026-11-07):** run only the exact test files you changed or added, plus a scoped tsc. Do not run eslint, do not run whole-project tsc, and never run Playwright locally. E2E runs on CI (Task 10 dispatches it).
  - **vitest** (from `apps/web`; DB suites need `DATABASE_URL`, see the `seazn-local-env` skill: `db:apply` + `sync:sports`):
    ```bash
    cd /Users/ashokhein/github/seazn.club-worktrees/title-sponsor-poster/apps/web && \
      npx vitest run --reporter=json --outputFile=$SCRATCH/tN.json <exact paths>; echo EXIT=$?
    jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests,files:[.testResults[].name]}' $SCRATCH/tN.json
    ```
    Pin `total`, and confirm `files` resolves inside this worktree. `$SCRATCH` is a unique subdirectory of the session scratchpad.
  - **Scoped tsc** (from `apps/web`):
    ```bash
    echo '{"extends":"./tsconfig.json","compilerOptions":{"noEmit":true,"incremental":false,"types":["node","next"]},"include":[],"files":[<changed .ts/.tsx>]}' > tsconfig.changed.tN.json && \
      node ../../node_modules/typescript-native/bin/tsc -p tsconfig.changed.tN.json; echo EXIT=$?; rm tsconfig.changed.tN.json
    ```
    Never commit it.
  - **E2E collection only:**
    ```bash
    npx playwright test --list <spec> > $SCRATCH/list.txt 2>&1; echo EXIT=$?
    ```
    rtk eats `--list` output on a terminal, so always redirect it to a file.
- `grep -a` always.
- Commits are conventional and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No PNG is ever committed: captures go to a CI artifact and `~/seazn-artifacts`.
- **Model marks** on each task heading: **[DB]** schema, data or server write path; **[UI]** public or console UI; **[money]** money/Stripe, which no task in this plan touches.

## Review Focus

The five failure modes most likely to bite a real person. Each is pinned by a named test in its owning task.

1. **The poster fails to load.** This happens when the object is deleted, the host is not storage, or the optimizer answers 4xx. The premium slot must show the logo card, never a broken image. Pinned by Task 4 (`onError → fallback`) and Task 8 W5 (`_next/image` routed to 404).
2. **A 43-character name at 320, in Spanish or Dutch** ("Gepresenteerd door …" is the longest sentence). The page must not scroll horizontally, the text may take at most 2 lines and then an ellipsis, and the full sentence must stay in `title` and in the accessible name. Pinned by Task 7 at all seven widths and Task 10's es/nl shots.
3. **A rotation that mixes a linked and an unlinked sponsor.** The unlinked slide has no `<a>`, no Visit and no `href=""`, and the linked one still links. Pinned by Task 4 (d) and Task 8 W6.
4. **Keyboard and screen-reader rotation.** Hidden slides are `inert` and `aria-hidden`. Focus pauses the rotation. A dot tap stops it. Reduced motion never auto-rotates. Pinned by Task 4 (h–m), Task 7 (axe) and Task 8 W6.
5. **The sponsor stops being a Title sponsor.** This covers a deal ending (tier back to partner), a dispute parking it (`pending`) and a downgrade (no `sponsors.tiers`). The panel and the band go, and the hero returns to one column, with no empty 300 px column. Pinned by Task 2 (resolver: inactive/pending), Task 5 (h, i) and Task 8 W8.

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `db/migration/deltas/V503__sponsor_poster.sql` (new) | Column and `CHECK` | 1 |
| `apps/web/src/server/sponsors/__tests__/poster-migration.test.ts` (new) | Every `CHECK` refusal beside its accepted twin | 1 |
| `apps/web/src/server/usecases/sponsors.ts` | `SponsorRow.poster_path`, `COLS`, the create INSERT, both input schemas, `ResolvedSponsor.poster`, the resolver select | 2 |
| `apps/web/src/server/api-v1/schemas/sponsors.ts` | OpenAPI `Sponsor` and `CreateSponsor` (`PatchSponsor` inherits) | 2 |
| `openapi/v1.json`, `openapi/v1.public.json` | Generated | 2 |
| `apps/web/src/server/usecases/__tests__/sponsor-poster.test.ts` (new) | DB: the write sequence and the resolver | 2 |
| `apps/web/src/lib/sponsor-poster.ts` (new, client-safe) | `POSTER_*`, `TITLE_ROTATE_MS`, `posterCrop`, `nextSlide`, `autoRotates` | 3 |
| `apps/web/src/components/ui/use-prefers-reduced-motion.ts` (new) | Store-based reduced-motion hook | 3 |
| `apps/web/src/components/public-site/title-sponsor-showcase.tsx` (new, `"use client"`) | Panel and band markup, rotation, dots, fallback, `onError` | 4 |
| `apps/web/src/components/public-site/sponsors-board.tsx` | `hasTitleSponsor`, `titleSlides`, `showcaseLabels`, `TitleSponsorPanel`, `TitleSponsorBand`; hero sentence without logo, `max-md:hidden` | 5 |
| `apps/web/src/app/(public)/live/[orgSlug]/[competitionSlug]/page.tsx` | Hero grid, panel mount, band mount | 5 |
| `apps/web/src/dictionaries/{en,es,fr,nl}/public.json`, `ui.json`; `apps/web/src/lib/i18n-keys.ts` | Copy; the keys file is generated | 5, 6 |
| `apps/web/src/components/org-sponsors.tsx` | `PosterDraft`, `PosterField`, `pickPoster`, `sponsorEditPatch`, the `SponsorForm` `poster` prop | 6 |
| `apps/web/src/components/sponsors/sponsor-sheet.tsx` | Read-only Poster row | 6 |
| `apps/web/e2e/mobile.spec.ts` | Seven-width test | 7 |
| `apps/web/e2e/helpers/sponsor-hop.ts` (new; `realSponsorHop` moved verbatim from `sponsors-journey.spec.ts`), `apps/web/e2e/helpers/poster-art.ts` (new) | E2E helpers | 8 |
| `apps/web/e2e/walkthrough/title-sponsor-poster.spec.ts` (new) | Walkthrough | 8 |
| `scripts/smoke/suites/sponsors.ts` | Smoke rows | 9 |
| `apps/web/e2e/walkthrough/title-sponsor-poster-captures.spec.ts` (new), `.github/workflows/e2e.yml`, `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts` | Sign-off captures | 8, 10 |

---

### Task 1 [DB]: Migration `V503__sponsor_poster.sql`

**Files:**
- Create: `db/migration/deltas/V503__sponsor_poster.sql`
- Test: `apps/web/src/server/sponsors/__tests__/poster-migration.test.ts`

**Interfaces:**
- Produces: column `sponsors.poster_path text null`, constraint `sponsors_poster_path_check`.

- [ ] **Step 1: Write the failing test.** Follow `server/sponsors/__tests__/migration.test.ts`'s rig: privileged `sql`, a seeded org, rows inserted directly, and `describe.skipIf(!HAS_DB)`. State the spec literals at the top.

```ts
const DELTA = /^V\d+__sponsor_poster\.sql$/;
const ACCEPTED = [null, "https://x.supabase.co/storage/v1/object/public/assets/orgs/o/content/a.png", "http://a.example/p.jpg", "HTTPS://A.EXAMPLE/P.WEBP"];
const REFUSED = ["javascript:alert(1)", "logos/a.png", "/relative.png", "data:image/png;base64,AAAA", "ftp://a.example/p.png", "https://a.example/" + "x".repeat(483) /* 501 chars */];

it("finds exactly one sponsor_poster delta, by suffix", ...)            // matches.length === 1
it("poster_path is nullable text with no default", ...)                 // information_schema: data_type 'text', is_nullable 'YES', column_default null
it("null and http(s) urls are stored; every other value is refused BY sponsors_poster_path_check (count reported)", async () => {
  // each ACCEPTED: insert succeeds and reads back equal; each REFUSED: rejects with { code: "23514", constraint_name: "sponsors_poster_path_check" }
  expect(checked).toBe(ACCEPTED.length + REFUSED.length); // 10
});
```

- [ ] **Step 2: Run it and see it fail.** Use the Global vitest command on `src/server/sponsors/__tests__/poster-migration.test.ts`. Expected: the first case fails with `matches.length 0`, and the column cases fail with `column "poster_path" does not exist`.
- [ ] **Step 3: Write the migration.** Use exactly the SQL in spec §6.1, plus a header comment naming the spec. Then run `npm run db:apply` against your local DB.
- [ ] **Step 4: Run it and see it pass.** Expected: total 3, passed 3.
- [ ] **Step 5: Mutate once.** Use psql: `alter table sponsors drop constraint sponsors_poster_path_check`, then re-add it **without** the regex half. Run: the `javascript:` and `logos/a.png` rows must red. Restore the constraint by hand (`db:apply` will not re-add it). Then do the same with the length half: the 501-character row must red. Report both killers.
- [ ] **Step 6: Commit.**
```bash
git add db/migration/deltas/V503__sponsor_poster.sql apps/web/src/server/sponsors/__tests__/poster-migration.test.ts
git commit -m "feat(sponsors): poster_path column with an http(s) check (V503, renumber at merge)"
```

---

### Task 2 [DB]: `poster_path` through the write schemas, the row, the list and the resolver

Batched in one pass because every step touches `usecases/sponsors.ts`.

**Files:**
- Modify:
  - `apps/web/src/server/usecases/sponsors.ts` (`SponsorRow` :68-94, `COLS` :96-99, `CreateSponsorInput` :101-112, `createSponsor` INSERT :236-245, `ResolvedSponsor` :434-442, `resolveSponsors` :458-489)
  - `apps/web/src/server/api-v1/schemas/sponsors.ts` (`Sponsor` :90-123, `CreateSponsor` :125-133)
  - `openapi/v1.json`, `openapi/v1.public.json` (generated)
  - `apps/web/src/components/org-sponsors.tsx` (`SponsorItem` gains `poster_path: string | null` only)
- Test:
  - `apps/web/src/server/sponsors/__tests__/url-write-schemas.test.ts`
  - `apps/web/src/server/usecases/__tests__/sponsor-lock.test.ts`
  - `apps/web/src/server/usecases/__tests__/sponsor-poster.test.ts` (new)
  - `apps/web/src/server/usecases/__tests__/sponsors.test.ts`
- Fan-out (tsc lists them): every `ResolvedSponsor` and `SponsorItem` literal in tests gains `poster: null` / `poster_path: null`. Known sites: `sponsors.test.ts:183`, `components/public-site/__tests__/sponsors-board.test.tsx` (`s()`), `components/sponsors/__tests__/tier-legend.test.tsx`, and the `SponsorItem` factories in `components/sponsors/__tests__/*.test.tsx`, `components/__tests__/org-sponsors-deal-locks.test.tsx` and `app/o/[orgSlug]/sponsors/__tests__/page.test.tsx`. Find the rest with `grep -a -rl "ResolvedSponsor\|SponsorItem" apps/web/src`.

**Interfaces:**
- Consumes: Task 1's column.
- Produces:
  - `SponsorRow.poster_path: string | null`;
  - `SponsorItem.poster_path: string | null`;
  - `ResolvedSponsor.poster: string | null`;
  - `CreateSponsorInput` / `PatchSponsorInput` / OpenAPI `CreateSponsor` / `PatchSponsor` field `poster_path`, declared right after `logo_path` as `z.string().url().max(500).refine(isRedirectableUrl, { message: SPONSOR_URL_HTTP_ONLY }).nullish()`;
  - OpenAPI `Sponsor.poster_path: z.string().nullable()`.

- [ ] **Step 1: Write the failing tests.**

`url-write-schemas.test.ts`. First, `PROBES` gains `poster_path: { ok: "https://cdn.example/p.png", bad: "javascript:alert(1)" }`. The existing "a probe for every create field" and key-order cases then red until the field exists. Second, add a describe block:

```ts
describe("poster_path: an absolute http(s) url of at most 500 characters, at every write (count reported)", () => {
  const POSTER_REFUSED = [...REFUSED, "logos/a.png", "/relative.png", "https://a.example/" + "x".repeat(483)];
  it("every write schema refuses each, on the poster_path field", ...)   // checked === SCHEMAS.length * POSTER_REFUSED.length (4 × 10)
  it("positive pair: http, https, null and absent are accepted", ...)    // checked === SCHEMAS.length * (ACCEPTED.length + 2)
});
```

`sponsor-lock.test.ts`: in "name, url and logo stay editable while a deal is live", add `["poster_path", { poster_path: "https://cdn.example/p.png" }]` to `EDITABLE`, rename the test to "name, url, logo and poster stay editable…", and change the expected count to `4`.

`sponsor-poster.test.ts` (new, DB). Use a Pro org and a competition, seeded as `sponsors.test.ts` seeds them (`seedOrg`, `createCompetition`). The header states "sport-agnostic: no sport sweep". Read back from the **stored row** with privileged `sql`, never from the usecase's return value alone.

```ts
it("empty first: a sponsor created without a poster stores null, lists null and resolves poster: null")
it("a create may carry a poster: stored, listed and resolved")
it("set, replace, remove: each PATCH is read back from the row and the list — A, then B (second call), then null")
it("a refused poster PATCH (javascript:) writes nothing: the row keeps B")          // the usecase parse refuses (400) before any write
it("another org's sponsor: 404, and its poster is unchanged")
it("resolveSponsors carries the poster for a competition-scoped AND an org-wide title row, in resolver order (count reported)")
it("an inactive or pending title sponsor resolves to nothing — its poster with it (the void / dispute-park case)")
it("tiered:false collapses the tier to partner and still carries the poster (the hero decides; Task 5 shows it draws nothing)")
```

`sponsors.test.ts:182-184`: the expected object gains `poster: null`.

- [ ] **Step 2: Run them and see them fail.** Use the Global vitest command on the four test files. Expected: url-write-schemas fails on key order and the probe; sponsor-lock fails with `poster_path` refused (an unknown key is stripped, so the patch is empty, so 400 `empty patch`); sponsor-poster fails with no `poster_path` column in `COLS` and `poster` undefined.
- [ ] **Step 3: Implement.**
  - Add the field to both create schemas, right after `logo_path`.
  - Add `"poster_path"` to `COLS` after `"logo_path"`.
  - Add `poster_path` to the `createSponsor` column list and values (`${input.poster_path ?? null}`).
  - Add `ResolvedSponsor.poster`.
  - In `resolveSponsors`, select `poster_path` and map it to `poster`.
  - Add `SponsorItem.poster_path`.
  - Update every fixture tsc names.
  - Then, from the repo root, run `npm run openapi:gen`.
- [ ] **Step 4: Run them and see them pass.** Run the same four files plus the fixture-only files you edited. Report `total` and `passed`. Run `npm run openapi:gen` a second time: `git status --porcelain openapi/` must show only the first gen's change. Run the scoped tsc on every changed `.ts` and `.tsx`: EXIT=0.
- [ ] **Step 5: Mutate once each, restoring from `cp` each time.**
  1. Delete `.refine(isRedirectableUrl, …)` from `CreateSponsorInput.poster_path`. The killer is the poster_path sweep's usecase rows, while the OpenAPI rows stay green. This proves each schema is witnessed.
  2. Same mutation in `CreateSponsor` (api-v1). The killer is the OpenAPI rows.
  3. Map `poster: null` in `resolveSponsors`. The killer is "resolveSponsors carries the poster…".
- [ ] **Step 6: Commit.**
```bash
git add -A apps/web/src/server apps/web/src/components/org-sponsors.tsx openapi apps/web/src/components/public-site/__tests__ apps/web/src/components/sponsors/__tests__ apps/web/src/components/__tests__ "apps/web/src/app/o/[orgSlug]/sponsors/__tests__"
git commit -m "feat(sponsors): poster_path on the sponsor API, the console row and the public resolver"
```

---

### Task 3 [UI]: Pure poster helpers and the reduced-motion hook

**Files:**
- Create: `apps/web/src/lib/sponsor-poster.ts`, `apps/web/src/components/ui/use-prefers-reduced-motion.ts`
- Test: `apps/web/src/lib/__tests__/sponsor-poster.test.ts`, `apps/web/src/components/ui/__tests__/use-prefers-reduced-motion.test.tsx`

**Interfaces (Produces):**
```ts
// lib/sponsor-poster.ts — client-safe, no imports beyond types
export const POSTER_WIDTH = 1080;
export const POSTER_HEIGHT = 1350;
export const TITLE_ROTATE_MS = 6_000;
export interface PosterCrop { side: "width" | "height" | null; percent: number; warn: boolean }
export function posterCrop(width: number, height: number): PosterCrop | null;   // null = dimensions unknown (≤0, NaN, ±Infinity)
export function nextSlide(index: number, count: number): number;              // (index+1) % count; throws RangeError("no slides") when count < 1
export interface RotationState { count: number; reducedMotion: boolean; paused: boolean; stopped: boolean }
export function autoRotates(s: RotationState): boolean;
// components/ui/use-prefers-reduced-motion.ts — "use client"
export function usePrefersReducedMotion(): boolean;  // useSyncExternalStore on matchMedia("(prefers-reduced-motion: reduce)"); server snapshot false
```

- [ ] **Step 1: Write the failing tests.** Expected values come from spec §11's geometry table, never from `posterCrop`.

```ts
const TABLE = [ // [w, h, side, percent, warn] — spec §11
  [1080, 1350, null, 0, false], [1080, 1080, "width", 20, false], [1600, 1500, "width", 25, false], [1601, 1500, "width", 26, true],
  [1920, 1080, "width", 55, true], [1080, 1800, "height", 25, false], [1080, 1801, "height", 26, true], [1080, 1920, "height", 30, true],
] as const;
it("posterCrop matches the spec's geometry table, both 25 % boundaries included (count reported)")       // checked === 8
it("an exact 4:5 at any size loses nothing (540×675, 1080×1350, 2160×2700)")                            // side null, 0, false ×3
it("unknown dimensions answer null and never throw (0, -1, NaN, Infinity on either side)")             // checked === 8
it("property: warn ⇔ percent > 25, over 1..5000 × 1..5000 (fast-check, numRuns 2000 reported)")
it("autoRotates — EMPTY FIRST: count 0 never rotates; then the full table rotates on exactly two rows")
  // enumerate count ∈ {0,1,2,3} × reducedMotion × paused × stopped = 32 rows; the rotating set must equal
  // [{count:2,…all false},{count:3,…all false}] (from spec §7.6); expect(rows).toBe(32)
it("nextSlide advances and wraps: (0,3)→1, (2,3)→0, (0,1)→0; count 0 throws RangeError")
```

Hook test: `renderIsland(Probe, {}, walk, { hydrate: true })`, with `globalThis.window.matchMedia` stubbed. It covers four cases:
- the server snapshot is false;
- after hydration it reads `true`;
- a `change` event flips it back;
- with no `window` (left unstubbed), it reads false and does not throw.

- [ ] **Step 2: Run them and see them fail** (module not found).
- [ ] **Step 3: Implement.** Use the integer predicates from spec §11: warn when `15w > 16h` (width) or `3h > 5w` (height). The percent is `Math.ceil(100 * num / den)` with integer `num` and `den`. The hook uses `useSyncExternalStore(subscribe, getSnapshot, () => false)`, with every `window` access guarded by `typeof window !== "undefined" && typeof window.matchMedia === "function"`. Do not migrate the three existing private copies (ai-trace, ai-architect-demo, overlay-stage). That migration is out of scope; note it in the report.
- [ ] **Step 4: Run them and see them pass.** Then run the scoped tsc.
- [ ] **Step 5: Mutate once each.**
  1. `15 * w > 16 * h` → `>=`. The killer is the 1600×1500 row.
  2. In `autoRotates`, drop `!s.stopped`. The killer is the 32-row table.
- [ ] **Step 6: Commit** with `feat(sponsors): poster crop geometry, rotation rules and a shared reduced-motion hook`.

---

### Task 4 [UI]: `TitleSponsorShowcase` (client): panel and band, rotation, dots, fallback

**Files:**
- Create: `apps/web/src/components/public-site/title-sponsor-showcase.tsx`
- Test: `apps/web/src/components/public-site/__tests__/title-sponsor-showcase.test.tsx`
- Modify: `apps/web/src/lib/__tests__/public-image-contract.test.ts`. Add a CASE for this file:
  - `srcExpr: "slide.poster"`, `width: "POSTER_WIDTH"`, `height: "POSTER_HEIGHT"`;
  - the poster `<Image>` must be the **first** `<Image` in the file.

**Interfaces:**
- Consumes: Task 3 (`POSTER_*`, `TITLE_ROTATE_MS`, `nextSlide`, `autoRotates`, `usePrefersReducedMotion`).
- Produces:
```ts
export interface TitleSlide { id: string; name: string; href: string | null; poster: string | null; logo: string | null;
  sentence: string; posterAlt: string; dotLabel: string }
export interface ShowcaseLabels { kicker: string; group: string; visit: string }
export type ShowcaseVariant = "panel" | "band";
export function TitleSponsorShowcase(props: { slides: readonly TitleSlide[]; labels: ShowcaseLabels; variant: ShowcaseVariant }): React.ReactNode;
```
- Test IDs:
  - `title-showcase`, which carries `data-variant`;
  - `title-slide`, which carries `data-sponsor-id` and `data-current="true|false"`;
  - `title-slide-poster`, `title-slide-fallback`, `title-slide-caption` (panel), `title-band-sentence`, `title-band-visit`;
  - `title-showcase-dots`, `title-showcase-dot`.

- [ ] **Step 1: Write the failing tests.** Markup cases use `renderToStaticMarkup`. Behaviour cases use `renderIsland` with `vi.useFakeTimers()` and a stubbed `matchMedia`. The fixtures are three slides that differ pairwise in every field, plus one 43-character name.

```ts
it("empty slides render nothing")                                                     // === ""
it("one slide: no dots, no carousel roles, no capsule, no timer scheduled")           // vi.getTimerCount() === 0 after mount
it("three slides: three 44px dots labelled 'Show <name>', the first aria-current; only slide 0 is not inert/aria-hidden (count reported)")
it("linked slide: ONE <a> to /s/<id>?src=site, target _blank, rel has sponsored; unlinked: no <a> and no href= at all — panel and band")
it("band: Visit only on a linked slide; the sentence is the given string WHOLE, line-clamp-2, title = sentence")
it("fallback: no poster + logo → white card with the logo (+ name in the panel only); no logo → monogram of the first letter")
it("panel caption: the current name, line-clamp-2 + break-words, title = full name, min-w-0 down the chain")
it("dot contrast ≥ 3:1 (WCAG 1.4.11) over a white AND a black poster pixel, active and inactive, read from the shipped classes (count 4)")
  // parse bg-black/NN (capsule) and bg-white/NN (inactive) from the markup; composite over #fff and #000; WCAG relative luminance
it("rotates every 6000 ms and wraps: 5999 → slide 0, 6000 → 1, 12000 → 2, 18000 → 0")
it("a mouse over the showcase pauses it; leaving resumes")                            // pointerType "mouse"; a touch enter does NOT pause
it("focus inside pauses it; blur to outside resumes; blur to a child does not")
it("reduced motion: nothing moves in 30 s, a dot still switches")
it("a dot tap shows that sponsor and STOPS the rotation for this view (D12)")         // 30 s later, still that slide
it("a poster that errors falls back to the logo card; the other slides keep their posters (D14)")
```

- [ ] **Step 2: Run them and see them fail** (module missing). The image-contract case reds too.
- [ ] **Step 3: Implement `TitleSponsorShowcase`** to spec §7.2–§7.9. Layout notes:
  - Slides are absolutely stacked in a `relative aspect-[4/5]` box.
  - The current slide is `opacity-100`. The others are `opacity-0`, plus `aria-hidden`, plus `inert`.
  - Every slide has `transition-opacity duration-700 motion-reduce:transition-none`.

  Behaviour notes:
  - State: `index`, `hovered`, `focused`, `stopped`, and `broken: ReadonlySet<string>`.
  - The interval effect runs only while `autoRotates({count, reducedMotion, paused: hovered || focused, stopped})`. It advances with `setIndex(i => nextSlide(i, count))` inside the timer callback, never synchronously in the effect.
  - The poster is `<Image src={slide.poster} width={POSTER_WIDTH} height={POSTER_HEIGHT} sizes=… className="h-full w-full object-cover" onError={…}>`.
  - The panel link has `aria-label={slide.name}`. The band thumbnail has `alt=""`. An unlinked poster has `alt={slide.posterAlt}`.
- [ ] **Step 4: Run them and see them pass.** Run this file and `public-image-contract.test.ts`, then the scoped tsc.
- [ ] **Step 5: Mutate once each.**
  1. Pass `stopped: false` at the call site. The killer is "a dot tap … STOPS".
  2. Render `<a href={slide.href ?? ""}>` always. The killer is the linked/unlinked case.
  3. Delete the `onError` handler. The killer is the D14 case.
  4. Change `bg-white/50` → `bg-white/30`. The killer is the contrast case.
- [ ] **Step 6: Commit** with `feat(public): title sponsor showcase (poster panel and phone band, rotation, dots, fallback)`.

---

### Task 5 [UI]: Wire the showcase into the hero; public copy; regression

**Files:**
- Modify:
  - `apps/web/src/components/public-site/sponsors-board.tsx`
  - `apps/web/src/app/(public)/live/[orgSlug]/[competitionSlug]/page.tsx` (:238-379)
  - `apps/web/src/dictionaries/{en,es,fr,nl}/public.json`; regenerate `apps/web/src/lib/i18n-keys.ts`
- Test:
  - `apps/web/src/components/public-site/__tests__/sponsors-board.test.tsx`
  - `apps/web/src/app/(public)/live/[orgSlug]/[competitionSlug]/__tests__/page.test.tsx`
- Regression run (unchanged files, run to prove they are untouched):
  - `apps/web/src/app/(public)/live/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/__tests__/page-sponsors.test.ts`
  - `apps/web/src/lib/__tests__/public-image-contract.test.ts`
  - `apps/web/src/lib/__tests__/hub-dict.test.tsx`

**Interfaces:**
- Consumes: `ResolvedSponsor.poster` (Task 2), `TitleSlide`/`ShowcaseLabels`/`TitleSponsorShowcase` (Task 4).
- Produces (in `sponsors-board.tsx`):
```ts
export function hasTitleSponsor(sponsors: readonly ResolvedSponsor[], tiered: boolean): boolean;
export function titleSlides(sponsors: readonly ResolvedSponsor[], tiered: boolean, dict: PublicDict, tag: BoardClickTag): TitleSlide[];
export function showcaseLabels(dict: PublicDict): ShowcaseLabels;
export function TitleSponsorPanel(props: SponsorsProps): React.ReactNode;  // <aside data-testid="mh-hero-poster" class="max-md:hidden md:w-[220px] lg:w-[300px] …"> or null
export function TitleSponsorBand(props: SponsorsProps): React.ReactNode;   // <div data-testid="mh-title-band" class="md:hidden mb-6 …"> or null
```

- [ ] **Step 1: Write the failing tests.**

`sponsors-board.test.tsx`. Expected strings come from the dictionary JSON, with `{sponsor}` replaced in the test. Never call the `t()` under test for an expected value.

```ts
it("titleSlides — EMPTY FIRST: [] with no sponsors, with no title row, and for an un-tiered org holding a title row (count 3)")
it("one slide per title row in input order; gold and partner never; href /s/<id>?src=site or null")
it("each locale: sentence = landing.presentedBy with the name, posterAlt = titleSponsor.posterAlt, dotLabel = titleSponsor.show (4 locales × 2 slides = 8)")
it("showcaseLabels reads titleSponsor.kicker / group / visit in each locale (count 4)")
it("TitleSponsorPanel is max-md:hidden and TitleSponsorBand md:hidden; both null without a title sponsor")
it("SponsorsHeroTitle draws the sentence WHOLE with NO logo even when the row has one, and is max-md:hidden")
it("REGRESSION — the match board (includeTitle) still draws the title logo at 40px (h-10 w-10, width=\"40\")")
```

The last case replaces the hero half of "sizes a title-tier sponsor's logo like a partner's on a free org's strip". Its free-strip half is kept.

`page.test.tsx`. Add `poster: null` / `"https://cdn.example/p.png"` to the `TITLE_SPONSOR` fixtures.

```ts
it("a title sponsor: mh-hero-poster in the hero; the hero wrapper carries md:grid-cols-[minmax(0,1fr)_auto]; mh-title-band sits after the hero and before mh-root")
it("EMPTY: no title sponsor → no mh-hero-poster, no mh-title-band, no md:grid-cols-[minmax(0,1fr)_auto], hero mb-6 as today")
it("DENIED: a free org with a title row → none of the three; the name is on mh-sponsors-flat")
it("the hero drops to max-md:mb-2.5 only when a band follows")
it("the board still excludes the title sponsor; gold is not in the panel")
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
  - In `sponsors-board.tsx`:
    - `hasTitleSponsor` is `tiered && sponsors.some(s => s.tier === "title")`.
    - `SponsorsHeroTitle` and both new components read it.
    - `titleLine` gains `withLogo: boolean`: the hero passes `false`, and `SponsorsBoard` passes `true`.
    - Update the file header's placement section in two or three lines.
  - Page:
    - `const showcase = hasTitleSponsor(sponsors, tiered)`.
    - The hero's inner wrapper adds `md:grid md:grid-cols-[minmax(0,1fr)_auto] md:items-start md:gap-x-6 lg:gap-x-8` only when `showcase`.
    - Today's two rows move into one left-column `div.min-w-0.flex.flex-col.gap-5`. `<TitleSponsorPanel …/>` is its sibling.
    - `<TitleSponsorBand …/>` goes right after `</section>`.
    - The section's `mb-6` becomes `max-md:mb-2.5 md:mb-6` when `showcase`.
  - Dictionaries: the five `titleSponsor.*` keys in four locales, exactly as spec §10, in a new block after `landing.partners`. Then run `npm run i18n:gen-keys` and `npm run i18n:check`.
- [ ] **Step 4: Run them and see them pass.** Run the two test files plus the three regression files, then the scoped tsc.
- [ ] **Step 5: Mutate once each.**
  1. Drop `tiered &&` from `hasTitleSponsor`. The killers are the EMPTY-FIRST un-tiered row and page DENIED.
  2. Drop `max-md:hidden` from `SponsorsHeroTitle`. The killer is its case.
  3. Pass `withLogo: false` on the match board. The killer is the REGRESSION case.
- [ ] **Step 6: Commit** with `feat(public): title sponsor poster panel in the hero and band under it (four locales)`.

---

### Task 6 [UI]: Editor: Poster (optional) on the sponsor page

**Files:**
- Modify:
  - `apps/web/src/components/org-sponsors.tsx`: `SponsorForm` gains a `poster` prop; `PosterField`, `PosterDraft`, `pickPoster`, `sponsorEditPatch`; `saveEdit` and `startEdit` use them; `OrgSponsors` passes `poster` only when `hasTiers`.
  - `apps/web/src/components/sponsors/sponsor-sheet.tsx`: read-only Poster row after Link, only when `hasTiers`.
  - `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`; regenerate `lib/i18n-keys.ts`.
- Test:
  - `apps/web/src/components/__tests__/org-sponsors-deal-locks.test.tsx`: append a `describe("the poster field")`, reusing its `mount`, `edit`, `form` and `formMarkup` rigs.
  - `apps/web/src/components/sponsors/__tests__/sponsor-sheet.test.tsx`.

**Interfaces:**
- Consumes: `POSTER_WIDTH`, `POSTER_HEIGHT`, `posterCrop`, `PosterCrop` (Task 3); `SponsorItem.poster_path` (Task 2).
- Produces (exported from `org-sponsors.tsx`):
```ts
export interface PosterDraft { file: File | null; preview: string | null; removed: boolean; crop: PosterCrop | null }
export function posterDraftOf(s: SponsorItem | undefined): PosterDraft;     // preview = s.poster_path
export function sponsorEditPatch(
  s: Pick<SponsorItem, "name" | "url" | "poster_path">,
  edit: { name: string; url: string },
  poster: PosterDraft,
  uploaded: { logo?: string; poster?: string },
): Record<string, unknown>;
// SponsorForm prop: poster?: { value: PosterDraft; onPick: (file: File) => void; onRemove: () => void }
```
- Test IDs: `sponsor-poster-tile` (aria-label = `sponsors.sheet.poster`, aria-describedby = hint id), `sponsor-poster-hint`, `sponsor-poster-remove`, `sponsor-poster-crop`, `sponsor-sheet-detail-poster`, `sponsor-sheet-poster-thumb`.

- [ ] **Step 1: Write the failing tests.** Expected copy comes from `en/ui.json`, filled with the declared constants: `LOGO_TYPES` names via `Intl.ListFormat("en-GB", disjunction)`, `MAX_LOGO_BYTES/2**20`, and `POSTER_*`.

```ts
it("the Add form never has a poster field; the sponsor page's editor has exactly one tile, described by one hint (empty case first)")
it("the hint names every format the picker accepts, the cap it enforces and 1080 × 1350")
it("hasTiers false: the editor gets no poster prop (DENIED); true: it does (GRANTED)")      // via mount(rows, { hasTiers }) + edit(name) + propsOf(form()).poster
it("a stored poster previews object-cover in the 4:5 tile with Remove; none: the icon and no Remove")
it("crop: warn true shows cropWidth / cropHeight with the percent; warn false shows nothing (count 3)")
it("pickPoster: a file over MAX_LOGO_BYTES is refused with sponsors.poster.tooBig and leaves the draft untouched")
it("sponsorEditPatch sequence (count reported)")
  // unchanged → {}; uploaded.poster → {poster_path:url}; removed + stored → {poster_path:null};
  // removed + none stored → {}; name + poster → both keys; uploaded.logo → {logo_path:url}  — 6 rows
it("Save on the island sends the poster PATCH and re-reads the list")                      // stub fetch as the file's save cases do; read the PATCH body
```

`sponsor-sheet.test.tsx`:
```ts
it("read-only Poster row: a 4:5 thumbnail when stored, 'None, the logo shows instead' when not; no row without tiers (count 3)")
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement** to spec §8.
  - `pickPoster(file)` is async. If `file.size > MAX_LOGO_BYTES`, it calls `setError(msg("sponsors.poster.tooBig", { mb: LOGO_MAX_MB }))` and returns. Otherwise it measures via `createImageBitmap(file)`, closing the bitmap; a measuring failure gives `crop: null`. It sets `{ file, preview: URL.createObjectURL(file), removed: false, crop }`.
  - `saveEdit` uploads the poster with `uploadLogo` when `poster.file`, then builds the body with `sponsorEditPatch`.
  - Remove clears `file` and `preview` and sets `removed: true`.
  - Console keys: the eight keys (six `sponsors.poster.*` plus `sponsors.sheet.poster` and `sponsors.sheet.noPoster`) from spec §10, in a new block. Then run `npm run i18n:gen-keys` and `npm run i18n:check`.
- [ ] **Step 4: Run them and see them pass.** Run the two test files, then the scoped tsc.
- [ ] **Step 5: Mutate once each.**
  1. In `sponsorEditPatch`, send `poster_path: null` on `removed` even when nothing is stored. The killer is the "removed + none stored" row.
  2. Pass `poster` regardless of `hasTiers`. The killer is DENIED.
  3. Drop the size check. The killer is `pickPoster` tooBig.
- [ ] **Step 6: Commit** with `feat(sponsors): poster upload on the sponsor page, with crop preview and warning (four locales)`.

---

### Task 7 [UI]: `mobile.spec.ts` at all seven widths

**Files:**
- Modify: `apps/web/e2e/mobile.spec.ts`. Add one test after "public surfaces: no horizontal scroll".
- Uses `apps/web/e2e/helpers/poster-art.ts`, created here (Task 8 extends it):
```ts
export function posterSvg(label: string, fill: string): string;             // 1080×1350 SVG art, no text we would draw on a real poster beyond the label
export async function routePosterArt(target: Page | BrowserContext, posterUrl: string, answer: { svg: string } | { status: number }): Promise<void>;
  // routes (url) => url.pathname === "/_next/image" && url.searchParams.get("url") === posterUrl
```

**Interfaces:**
- Consumes:
  - test IDs from Tasks 4–5;
  - `setupOrgId` and `orgSlug` from the file's setup;
  - `projectViewport()`, `expectNoHorizontalScroll` and the file's `overflowingIn` split;
  - `AxeBuilder`, as the file's axe test uses it.

- [ ] **Step 1: Write the test** `"title sponsor showcase: band below 768, panel from 768, no scroll, 44px dots, a 43-character name in two lines"`.
  - **Setup**, over the API in the file's authed org:
    - a new public competition;
    - two title sponsors scoped to it: A `{name:"Pandyas", url, poster_path: POSTER}`, and B `{name: LONG_43, no url, no logo}`;
    - the sponsors are deleted in `finally`.
  - **Premise:** the org is tiered. After `goto`, `mh-hero-sponsor` is attached, and the test fails loudly otherwise.
  - Visit in an **anonymous** context with `reducedMotion: "reduce"`, so nothing moves, and with `routePosterArt(ctx, POSTER, { svg })`.
  - **Assertions at the project width** (`phone = vp.width < 768`):
    - Visibility:
      - band `toBeVisible` and panel `toBeHidden` on a phone;
      - the reverse otherwise;
      - `mh-hero-sponsor` hidden on a phone and visible otherwise.
    - Visible showcase:
      - exactly 2 `title-showcase-dot`;
      - each `boundingBox()` is at least 44 × 44;
      - `elementFromPoint` at each centre is that dot or inside it (count 2).
    - Tap B's dot. Then the visible name element (the band sentence or the panel caption) satisfies all of these:
      - `scrollWidth ≤ clientWidth`;
      - `Math.round(height / lineHeight) ≤ 2`;
      - its `title` is the full text;
      - the current slide has no `a`, and the band has no `title-band-visit`.
    - `expectNoHorizontalScroll(anon)`. The `overflowingIn` split over the hero and the band: every scrollable box is a reachable rail, and no box is clipped.
    - axe `wcag2a`/`wcag2aa` on the page: no serious or critical findings.
- [ ] **Step 2: Collect.**
```bash
cd <worktree>/apps/web && npx playwright test --list e2e/mobile.spec.ts > $SCRATCH/m.txt 2>&1; echo EXIT=$?
grep -a -c "title sponsor showcase" $SCRATCH/m.txt
```
  Expected: 7, one per width project. Scoped tsc on `e2e/mobile.spec.ts` and `e2e/helpers/poster-art.ts`: EXIT=0.
- [ ] **Step 3: Mutate once (proved on CI in Task 10).** Before the dispatch, note that mobile.spec is **serial**, so a red here hides the later tests. The mutant run is a second dispatch with `title-sponsor-showcase.tsx`'s dot `h-11 w-11` changed to `h-8 w-8`. The expected red is "each boundingBox ≥ 44 × 44". Restore the file and record the run IDs.
- [ ] **Step 4: Commit** with `test(e2e): title sponsor showcase at all seven widths`.

---

### Task 8 [UI]: Walkthrough: upload, see, tap, count, remove, rotate, downgrade

**Files:**
- Create:
  - `apps/web/e2e/helpers/sponsor-hop.ts`. Move `realSponsorHop`, `SponsorHop` and `SPONSOR_PAGE_TITLE` **verbatim** out of `e2e/walkthrough/sponsors-journey.spec.ts:470-506`. Make that spec import them, and make no other change to it.
  - `apps/web/e2e/walkthrough/title-sponsor-poster.spec.ts`
- Modify:
  - `apps/web/e2e/helpers/poster-art.ts`. Add:
    ```ts
    export async function posterPng(browser: Browser, width: number, height: number, fill: string): Promise<Buffer>; // screenshot of an SVG page at w×h
    export async function standInStorage(page: Page, orgId: string): Promise<{ issued: string[] }>;
      // routes POST /api/orgs/<orgId>/content-upload → { ok: true, data: { upload_url: STUB/storage/v1/upload/sign/assets/orgs/<orgId>/content/<uuid>.png,
      //   public_url: STUB/storage/v1/object/public/assets/orgs/<orgId>/content/<uuid>.png } } and PUT STUB/storage/v1/upload/** → 200;
      //   STUB = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://stub.supabase.co" (e2e.yml:636)
    ```
  - `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts`. Add `"title-sponsor-poster.spec.ts"` to the walkthrough inventory, with a one-line comment.

**Interfaces:**
- Consumes: all earlier tasks; `seedSettingsOrg(request, { plan: "pro" })`, `seedCompetition`, `sponsorUrl`, `releaseSettingsOrg`, `withDb`, `EMPTY_JAR` and `dismissCookieBanner`.

- [ ] **Step 1: Write the walkthrough.** The header lists every scene, and names the **one stand-in**: storage, at the browser's boundary (content-upload grant, PUT, and the `_next/image` bytes). Every person event is a tap. Setup (org, competition, sponsors at tier `title`) goes through the API.

  - **W1 (1280, organiser).**
    - Open the sponsor page for A, tap Edit, tap the Poster tile, and choose a 1920×1080 PNG. The crop warning reads `cropWidth` with 55 %.
    - Choose a 1080×1350 PNG instead. The warning is gone.
    - Tap Save. `select poster_path from sponsors where id = A` equals `issued[1]`, and the read-only row shows the thumbnail.
  - **W2 (1280, logged out).**
    - The panel is visible.
    - The current slide's `img.currentSrc` contains `encodeURIComponent(issued[1])`, and `naturalWidth > 0`.
    - The hero sentence has no `<img>`.
  - **W3.** Tap the poster. `realSponsorHop` answers 302 to exactly A's url. The new tab shows `SPONSOR_PAGE_TITLE`, and `sponsor_clicks` has one row `{ source: "site" }`.
  - **W4 (320, logged out).** The band is visible. Tap Visit (the band link). A second `site` row is written, so the count is 2.
  - **W5.** Route A's `_next/image` to a 404 and reload. A shows `title-slide-fallback`, and `title-slide-poster` is absent.
  - **W6 (rotation).** Add title sponsor B (logo, no url). Then `page.clock.install()` before `goto`.
    - `runFor(6000)`: B is current, and the panel has no `a` for B.
    - Hover the panel and `runFor(12000)`: no change.
    - Move the mouse away and `runFor(6000)`: A again.
    - Tap B's dot and `runFor(30000)`: B still.
    - A `reducedMotion: "reduce"` context with `runFor(30000)`: A still.
  - **W7 (organiser).** Tap Remove poster, then Save. The row reads `null`. The visitor's page shows A's fallback card.
  - **W8 (downgrade / deal end).** PATCH A and B to `tier: "partner"` over the API. The visitor's page has no `mh-hero-poster`, no `mh-title-band` and no `mh-hero-sponsor`, and the hero wrapper lacks `md:grid-cols-[minmax(0,1fr)_auto]`.
- [ ] **Step 2: Collect both specs** (`--list` to a file). Expected: the new walkthrough lists W1–W8, and `sponsors-journey.spec.ts` still lists its J-cases with the same count as before the move. Record both counts. Run the scoped tsc on the four e2e files, then `e2e-ci-wiring.test.ts` with the Global vitest command.
- [ ] **Step 3: Mutate once (CI, with Task 10's dispatch).** Delete `onError` in the showcase. W5 must red. Restore.
- [ ] **Step 4: Commit** with `test(e2e): title sponsor poster walkthrough; realSponsorHop moved to a shared helper`.

---

### Task 9 [DB]: Smoke rows

**Files:**
- Modify: `scripts/smoke/suites/sponsors.ts`. Add the rows in `sponsorsSuite`, after "sp pro creates a competition-scoped title sponsor", and in the free-org block.

**Interfaces:**
- Consumes: the v1 sponsor API (Task 2), and the public HTML test IDs (Tasks 4–5).

- [ ] **Step 1: Write the rows.** Each `check()` can fail, and each negative sits next to its positive.

```ts
// POSTER = `https://smoke.supabase.co/storage/v1/object/public/assets/orgs/${proOrgId}/content/poster-${tag}.png`
check("sp poster: PATCH sets poster_path", res.status === 200 && body.poster_path === POSTER);
check("sp poster: a non-http(s) poster is refused (400)", bad.status === 400);
check("sp poster: the public page draws the panel and the band, with the poster", html has 'data-testid="mh-hero-poster"' && 'data-testid="mh-title-band"' && encodeURIComponent(POSTER));
check("sp poster: an unlinked title sponsor gets no anchor", !html.includes(`href="/s/${scopedId}`));   // the gold link above is its positive pair
check("sp poster: removed (null) → the fallback card, no poster", html has 'data-testid="title-slide-fallback"' && !encodeURIComponent(POSTER));
check("sp free: no poster panel or band (denied)", !freeShared.body.includes('data-testid="mh-hero-poster"') && !…'mh-title-band');
```

- [ ] **Step 2: Typecheck (scoped).** From the repo root:
```bash
echo '{"extends":"./tsconfig.scripts.json","include":[],"files":["scripts/smoke/suites/sponsors.ts"]}' > tsconfig.changed.t9.json && \
  node node_modules/typescript-native/bin/tsc -p tsconfig.changed.t9.json; echo EXIT=$?; rm tsconfig.changed.t9.json
```
  Expected: EXIT=0. Smoke itself runs on the PR's CI (`ci.yml` smoke-e2e), never locally.
- [ ] **Step 3: Mutate once (CI).** In a throwaway commit on the PR, revert `hasTitleSponsor`'s `tiered &&`. "sp free: no poster panel" must red. Drop the commit and record the run ID.
- [ ] **Step 4: Commit** with `test(smoke): title sponsor poster rows`.

---

### Task 10 [UI]: Sign-off: CI captures at 320/768/1280, page on :8765

**Files:**
- Create: `apps/web/e2e/walkthrough/title-sponsor-poster-captures.spec.ts`. Model it on `sponsor-deals-captures.spec.ts`:
  - it **skips** unless `TITLE_POSTER_CAPTURE_DIR` is set;
  - it uses a tall viewport (1600) and the `<state>-<width>-tall.png` name;
  - every state is witnessed before its shot;
  - poster art comes from `posterSvg` through `routePosterArt`.
- Modify:
  - `.github/workflows/e2e.yml`: a `title_poster_captures` boolean input (default false), a step on the `walkthrough-rest-2` leg, and an upload of the `title-poster-captures` artifact. Copy the `sponsor_deals_captures` block at :127-135 and :1382-1420, including the "wrote no screenshots" guard.
  - `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts`: add `"title-sponsor-poster-captures.spec.ts"` to the inventory.

**States**, each at 320, 768 and 1280 (English unless named):
- `hero-3-posters` (reduced motion, slide 0, dots);
- `hero-1-poster` (no dots);
- `hero-fallback-logo`;
- `hero-fallback-monogram-long` (43-character name, no link, no Visit);
- `hero-long-name-es`, `hero-long-name-nl`;
- `hero-register-open` (the Register button beside the panel);
- `hero-no-title` (the control: hero unchanged);
- `editor` (Details editor: picked poster, crop warning);
- `details` (read-only Poster row).

Plus one shot at a phone's real size: `band-320x568.png`. The last test checks that every file exists, is a PNG (magic bytes), and that no two files are byte-identical (AGENTS.md class 10).

- [ ] **Step 1: Write the spec and the workflow wiring.** Collect with `--list` to a file: the capture tests are listed, and they skip without the env. Run `e2e-ci-wiring.test.ts` with the Global vitest command.
- [ ] **Step 2: Commit** with `test(e2e): title sponsor poster sign-off captures (opt-in)`.
- [ ] **Step 3: Push and open the PR.** Push `feat/title-sponsor-poster` and open the PR; the body ends with the attribution line. Smoke runs on the PR. Then dispatch:
```bash
gh workflow run e2e.yml --ref feat/title-sponsor-poster -f pr=<PR> -f title_poster_captures=true
```
  This is one dispatch: it runs Task 7's mobile.spec at seven widths, Task 8's walkthrough and the captures. Do **not** poll. Hand back with the run ID. When the controller is notified, read the job results with the raw counts: the seven `mobile-*`/`tablet-*` projects, the walkthrough leg, the capture step's "captures: N", and smoke's pass/fail rows from the PR run.
- [ ] **Step 4: Run the mutant dispatches** owed by Tasks 7, 8 and 9 (each on a throwaway commit, restored afterwards). Record each killer and run ID in the report.
- [ ] **Step 5: Build the sign-off page.**
```bash
D=~/seazn-artifacts/2026-11-1X_title-sponsor-poster-signoff_$(openssl rand -hex 4)
gh run download <run> -n title-poster-captures -D "$D/img"
```
  Write `$D/index.html` with one panel per state. Each panel shows 320, 768 and 1280 side by side, a one-line "what to look at", and `Verdict: ____`. Add the `INDEX.md` row, then run `python3 ~/seazn-artifacts/.regen-index.py`. Check that `lsof -nP -iTCP:8765 -sTCP:LISTEN` shows the shared server; start one with `--bind 127.0.0.1` only if nothing is listening. Give the owner `http://127.0.0.1:8765/<folder>/index.html`. No PNG enters the repo.
- [ ] **Step 6: Get the owner's verdicts, one per screen** (AGENTS.md class 11: "CI green" is not sign-off). Route any "fix" back to the owning task (Tasks 4–6), then re-capture. The merge waits for the owner's explicit go. Before merging, renumber V503 to the next free number on `main` with a pure `git mv`; the tests find the file by suffix.

---

## Self-review

- **Spec coverage:** G1 → T1/T2/T6; G2 → T4/T5; G3 → T3/T4/T8; G4 → T4/T8; G5 → T4/T8/T9; G6 → T6; G7 → T5/T6/T7/T10. Every D1–D18 decision is owned (D10 → T5, D11 → T3/T6, D12 → T4, D13 → T1/T2, D14 → T4/T8, D15 → T6, D16 → T6, D17 → T5, D18 → T4/T10).
- **Four test types:**
  - Unit/DB: T1–T6.
  - E2E: T7 (seven widths) and T8 (walkthrough).
  - Smoke: T9.
  - Regression: T5's match-board 40 px pin, free-org denied, the image contract and hub-dict; T2's live-deal editable pin.
- **Interfaces:** the types and names used by later tasks (`TitleSlide`, `ShowcaseLabels`, `hasTitleSponsor`, `PosterDraft`, `sponsorEditPatch`, `ResolvedSponsor.poster`, `SponsorItem.poster_path`) are each defined once, in the task named by their Produces block.
