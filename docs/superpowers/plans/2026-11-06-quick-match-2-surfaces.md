# Quick Match 2: Guest Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything a guest sees: the marketing call to action, the one-screen setup at `/[lang]/play`, the home at `/q/[token]` with Score, Share and Add-a-match, the "recent quick matches" strip, and the end-to-end proof from the marketing page to a scored rally and back.

**Architecture:** Two server-rendered pages over plan 1's use cases. The setup page is a client form that reads the offer and the live match count from two small JSON routes and posts to one create route, which sets the visitor cookie and redirects to the home. The home is a dynamic server page outside the locale segment, like the pad, resolving the token on every render; Score and Add-a-match are POST route handlers that redirect. No client state beyond the form.

**Tech Stack:** Next.js 16 app router, React server components with small client islands, dictionaries in `apps/web/src/dictionaries/{en,fr,es,nl}/` (flat `"key": "value"` JSON per namespace), `SeaznQrImage` + `renderSeaznQr` for the share QR (built in the client island on the Share tap), Playwright e2e (`apps/web/e2e`), vitest for route handlers. Client islands are tested with the no-DOM `renderIsland` harness (`src/components/__tests__/_hook-harness.tsx:184`): `apps/web` vitest runs `environment: "node"` (`vitest.config.ts:135`) and the workspace has no jsdom and no React Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-03-quick-match-design.md`. Screens: `docs/superpowers/specs/mockups/2026-11-03-quick-match/setup.html` and `home.html` (design of record, O10, O11).

**Depends on:** plan 1 (`2026-11-06-quick-match-1-foundation.md`), every task.

**Repo root for every path below:** the seazn.club checkout; TypeScript paths are relative to `apps/web/`.

Re-pinned against origin/main 1b224951d4 on 2026-11-07 (drift accepted). See the re-pin log at the end.

## Pre-flight amendments (2026-11-08)

These are the rulings recorded in the SDD ledger (`.superpowers/sdd/2026-11-06-quick-match-2-surfaces/progress.md`, under "Pre-flight rulings (2026-11-08)") over the pre-flight scan beside it. Each is a controller ruling (PO rec, autonomous mandate, owner 2026-11-07), not an owner ruling. **Where an amendment and the task text below conflict, the amendment wins.** Re-pinned on HEAD d4d9fc5709: `package.json:60` (gen-keys) and `:62` (check); `stages.ts` `addFixture` `:7322`, refusals `:7352` (bracket), `:7355` (complete), `:7359` (self), `:7378` (outside division), `adhoc-` `:7434`, `StandingsOut` `:6239-6247`, `getStandings` `:6250`; `scoreLineOf` `lib/score/levels.ts:112`; `withDb` `e2e/helpers.ts:539` and `mobile.spec.ts:64,292-307,1661-1667,4701-4707` hold on HEAD. The scan's `+1` shift applies only after a rebase onto main, so re-pin these at rebase.

### Preconditions and batches

- **Plan 2 starts after plan 1's batch 4 (T8 ∥ T9) closes.** Plan 1 T9 writes `ui.json` ×4, `i18n-keys.ts` and `quick-match-back-link.tsx`, which plan 2's T1 and T5 also write. Plan 2 T6 consumes plan 1 T8's `ensureGuestDeviceLink` (A7, C13).
- **Batches** (same worktree; each implementer commits only its own paths; a task review per task; the next batch starts only after the batch's reviews close; the scoped gate is re-run at each boundary):
  - **P2-B1: T1 ∥ T2 ∥ T3.** T1 owns the dictionaries ×8, `i18n-keys.ts`, `lib/quick-match-constants.ts` and `server/usecases/quick-match-create.ts` (the codes move out, A4). T2 owns `server/usecases/quick-match-preview.ts` and its new test. T3 owns `app/api/quick-match/**`, `server/usecases/quick-match-visitor.ts` and `lib/rate-limit.ts`.
  - **P2-B2: T4 ∥ T5.** T4 owns `app/[lang]/(marketing)/play/**`, `components/quick-match/{setup-form,recent-strip}.tsx`, their tests and `eslint.config.mjs`. T5 owns `app/q/[token]/page.tsx` and its test, `components/quick-match/{home,standings,draw,match-list}.tsx`, `lib/routes.ts`, `lib/scrub-score-url.ts`, `lib/__tests__/{_route-scan.ts,scrub-path-secrets.test.ts,scrub-secret-painters.test.ts}`, `server/usecases/quick-match-home.ts` and plan 1's `components/v2/quick-match-back-link.tsx`.
  - **P2-B3: (T6 → T7 → T8) ∥ T9.** T6, T7 and T8 all write `home.tsx`, so they run in sequence, by one implementer or three in turn. T9 owns `app/[lang]/(marketing)/page.tsx` and its tests, `components/marketing/quick-match-cta.tsx`, `components/quick-match/recent-strip.tsx` and `quick-match-home.ts` (T5 is done by then). **No task after T1 edits a dictionary while a parallel lane is open.** A key found missing goes to the controller, who adds it in one commit between lanes.
  - **P2-B4: T10 ∥ T11.** T10 owns `e2e/quick-match.spec.ts` and `e2e/mobile.spec.ts`. T11 owns `scripts/smoke/**`. Then push and run the CI dispatch (E2).
- **Every UI dispatch (T4, T5, T7, T8, T9) invokes the `frontend-design` skill (E6)** and lists its screenshots as **owed**: 320, 768 and 1280 of each changed screen, taken from the CI e2e run's artifacts or a CI-run capture spec, and served for sign-off on local :8765. No local server (D8).
- **Board vs build before merge (E6):** check every control in the mockups. In `setup.html`: the pencil on the name heading, the "n of 6" count, the × on rows 3 to 6 (D5), the docked night Start bar with its count, and "Winners meet". In `home.html`: the leader-row highlight in standings, match numbers in the list, the Live badge inside a draw card, lime winners in the draw, "waits", and "winner of n" in the list. Note any control that is missing, as a finding.

### Copy and constants (T1)

- **A1, B1, A4 (adopted from the controller's dispatch):** T1 writes the whole key list in one pass. On top of the listed keys it adds:
  - setup labels: `quickMatch.setup.nameLabel`, `.sideLabel` "Side {n}" (the accessible name T10 fills by), `.removeSide` "Remove side {n}", `.emailLabel`;
  - errors: `quickMatch.errors.sportNotOffered`, `.kindNotOffered`, `.unavailable` (empty offer, Q2) and `.generic` (the 503 `DEVICE_LINK_KEK_MISSING`, the 400, a network failure, or anything unmapped);
  - draw lines: `quickMatch.setup.winnersMeet` "Winners meet", `quickMatch.home.winnerOfSemi` "Winner of semi-final {n}", `quickMatch.home.winnerOfMatch` "Winner of match {n}", and the existing list key `winnerOf` "winner of {n}";
  - home: `quickMatch.home.versus` "v", `quickMatch.home.drew` (B5d), `quickMatch.home.qrAlt`, `quickMatch.home.shareNative` (D14), and `quickMatch.addMatch.{home,away,submit}`;
  - refusal flashes (D3): `quickMatch.flash.{linkLimit,adhocLimit,notReady,sameSide,notFound,generic}`;
  - dead screen (D16): `quickMatch.dead.{title,hint,startNew}`.
- **Where keys live:** kind words (`individual`/`pair`/`team`) and format words (`league`/`knockout`) live ONCE in `ui.json`, because the home reads them through `msgFor`. The setup page loads both `getDictionary(lang, "marketing")` and `getDictionary(lang, "ui")`, as `[lang]/(marketing)/formats/page.tsx:40` does. Sport and variant names are the existing ui keys (`sport.*`, `variant.*`), resolved on the server. Standings headers reuse `slideshow.col.*`.
- **Plurals** use `plural()` (`lib/i18n-runtime.ts:39`) with `.one` and `.other` keys in all 4 locales for `startCount`, `sidesCount` and `home.played`. Numbers are never typed into copy: `errors.tooManyAlive` interpolates `{max}` from `QUICK_MATCH_MAX_ALIVE_PER_VISITOR`, `home.played` interpolates `{days}` from `QUICK_MATCH_EXPIRY_DAYS`, and `flash.adhocLimit` interpolates `{max}` from `QUICK_MATCH_MAX_ADHOC`.
- **Codes and constants:** `QUICK_MATCH_ERRORS` (every code, including `SIDES_UNKNOWN`) moves to `lib/quick-match-constants.ts`, which stays import-free. `quick-match-create.ts` imports and re-exports it, so plan 1's tests are unchanged. Also add `QUICK_MATCH_MAX_ADHOC = 10` and the code `QUICK_MATCH_ADHOC_LIMIT` (D4).
- **T1 verify** adds `src/lib/__tests__/dictionary-copy-truth.test.ts`. Mutate once: drop a `.one` key from `fr` and confirm that parity or the test goes red.

### T2, re-scoped (D1, A2, A3, B2, C2)

- **Drop both routes and their test.** T2 becomes `quickMatchPreviewTable()`, appended to `server/usecases/quick-match-preview.ts`. It returns the `league` counts for sides 2..6 × plays 1..4 (20 entries) and the `knockout` preview for sides 3..6 (4 entries), keyed `"<format>:<sides>:<plays>"`. It is computed only over in-range values, so the `RangeError` cannot be reached. Test file: `server/usecases/__tests__/quick-match-preview-table.test.ts`, with no DB. It asserts:
  - the exact key set and a count of 24 (anti-vacuity);
  - every league count equals the rulebook's `plays × n(n−1)/2`;
  - every knockout `matchCount` equals `n − 1`.

  Expected values come from the rulebook, never from the code. Mutate once by dropping one league entry.
- T4's page calls the table on the server and passes it to the island. The island never fetches a count. The Start count is a lookup, so it is never stale or out of order.

### T3 (D2, B3)

- Add `QUICK_MATCH_CREATE_LIMIT: RateLimitConfig = { max: 20, windowSeconds: 600, failClosed: false }` to `lib/rate-limit.ts`, keyed `quick-match-create:${ip}`. Do not use `EMAIL_LIMIT`.
- **Read the visitor cookie from `req.cookies`**, not from `next/headers`. The test then feeds the real `Set-Cookie` value back as a `Cookie` header. "Malformed" means `!isVisitorKeyShaped(value)` (`quick-match-tokens.ts:76`).
- **Tests:**
  - stub `DEVICE_LINK_KEK` with `vi.stubEnv`;
  - the limiter case asserts that no `quick_matches` row exists for that visitor hash, which proves the limiter runs before any DB touch;
  - a blank-cookie create still works (Review Focus 4).
- **Mutations, one at a time:** make the cookie-shape guard `return true` (the malformed-cookie test goes red), and move the limiter after the create (the no-row assertion goes red).

### T4 (B4, C1, C3, D5, D6, D15, Q2)

- The client imports `QuickMatchSport`/`QuickMatchPreview` as whole-statement `import type` only. Extend the type-only lint block (`eslint.config.mjs:141`) with `src/components/quick-match/**`. Server components in that folder take their data as props.
- **The page resolves names on the server.** It passes `sports: { sport_key, name, kinds: { kind, label }[], variants: { key, name, knockoutAllowed }[], defaultVariant }[]`, where `defaultVariant = pickVariant(sport_key, variants)` (`lib/preferred-variant.ts:19`) and the default kind is `kinds[0]`. Chips keep catalog order. Declare `export const dynamic = "force-dynamic"`.
- **Form rules (each pinned by a test):**
  - Changing the sport resets the kind and the variant to that sport's defaults.
  - Fewer than 3 filled sides, or a variant with `knockoutAllowed: false`, resets the format to league.
  - The kind switch is hidden for a one-kind sport. Test it with chess, whose body sends `kind: "individual"`.
  - Each side row from 3 to 6 has a × control with `removeSide`. Start is disabled while any row is blank.
  - The body is exactly `{ name, sport_key, variant_key, kind, format, sides, plays, email, locale }`. It sends `format: "league"` when the format row is hidden and `email: null` when the email is blank. Inputs set `maxLength` 80 (name) and 60 (sides).
- **Knockout unavailable (D15):** follow spec §5: the row shows League alone plus `knockoutUnavailable` as one line, with no disabled button. Test it with a mocked `knockoutAllowed: false`. There is no e2e for it, because v1 cannot reach it.
- **Double tap (B4f):** the form locks on the first submit until `location.assign`, and unlocks on an error. Test: two `onSubmit` calls make one `fetch`.
- **Error mapping:** map every code in `QUICK_MATCH_ERRORS` to its key. A 429 with no code maps to `errors.rateLimited`; anything else maps to `errors.generic`. Test each one.
- **Draw preview:** map seed i to the i-th typed name, and resolve a feeder that points at a bye line to that line's holder (ledger `:15`). Name rounds with `roundRoleLabel` (`lib/round-role-label.ts:21`). The final's away line with two feeders reads `winnersMeet`.
- **Suggested name (B4h):** the island fills it after mount, with the guest's own date (`Intl.DateTimeFormat(lang, { weekday: "short", day: "numeric", month: "short" })`), and it follows the sport until the guest edits it. Test both directions.
- **Empty offer (Q2), tested first:** with zero sports, the page renders `errors.unavailable` and no Start button.
- The page test mocks `listQuickMatchSports`. **Step 5 is replaced** by the owed CI screenshots (see Preconditions).

### T5 (A6, A14, B5, C10, D10, D12, D13, D16, Q3)

- **Routes and scrubbing (A6):** add `quickMatch: (token: string) => \`/q/${token}\`` to `lib/routes.ts` beside `checkin`. Every producer of the URL uses it, including plan 1's back link, whose concatenation T5 rewrites. Change the pin at `scrub-secret-painters.test.ts:426` to `["checkin", "claim", "quickMatch"]`. Add a test that the painter scan's file list includes `home.tsx` and `quick-match-back-link.tsx`; T7 and T9 extend it with their painters. Mutation: remove `ph-no-capture` from the back link and confirm the scan goes red.
- **Feeder names (D12):** add `seqInRound` (from `seq_in_round`) to `QuickMatchFixture` in `quick-match-home.ts`, and test it on a knockout of 5.
  - Resolve a slot label's `{round, seq}` to its feeder fixture. The list prints `winnerOf {n}` with the feeder's match number. The draw prints `winnerOfSemi {n}` when the feeder is a semi-final, and `winnerOfMatch {n}` otherwise. Never print `resolveSlotLabel`'s `R1·2` code.
  - Match number n = the 1-based index among non-bye fixtures in play order. The same n appears on the list badge and in "match n of total".
- **Score text and settled results:**
  - Scores come from `scoreLineOf` (`lib/score/levels.ts:112`). Write no third headline cutter.
  - A settled fixture with `winnerEntrantId === null` renders as `drew`, never "A beat B". Test with a football league.
  - A shared rank 1 makes the winner card read `level` and name the tied leaders.
  - Rounds are named by bracket role with `roundRoleLabel`; a semi-final of an 8-draw is never "Round 2".
  - Reuse `SETTLED_FIXTURE_STATUSES`. Add no new status-literal set.
- **Page setup:** `robots: { index: false }`. The locale is `resolveLocale()` with no `orgDefault` (D10).
- **No client DTO leak (A14):** a test creates a quick match WITH an email, prerenders `/q/<token>`, and asserts that neither the email nor any `token_enc` byte appears in the HTML or the flight payload. Mutate once by passing `home` to a client island; the test must go red. Every island takes a minimal DTO only.
- **Save hidden (D13):** do not render "Save this match" in plan 2. Plan 3 renders it with its route.
- **Dead link (D16):** the dead screen reads `dead.title` "This link has ended or doesn't exist", plus `dead.hint` and a `dead.startNew` link to `/${locale}/play`. Use `data-testid="qm-dead-link"`, never `scan-dead-link`.
- **Void (Q3):** one DB page test. Score a fixture to decided, void the deciding event through the existing void use case, and assert that the hero reads Live and no winner card shows.
- **Review Focus 3:** retitle the params test to what it asserts (an exact token resolves; a changed token is dead). Witness the trailing slash and `?utm` in T10. **Step 5 is replaced** by the owed CI screenshots.

### T6 to T8: refusals (D3, A7, A8, B6, B8, D4)

- **Every refusal of a guest form post is a 303** to `routes.quickMatch(token)` with `?e=<code>`, rendered as localized `quickMatch.flash.*` copy on the home. It is never JSON. An unknown token is the exception: it gets a 303 to the same path, which renders the dead screen.
- **T6:**
  - Its Files list adds the mint limiter's 429 (`rateLimit("qm-mint:"+id)`, `lib/rate-limit.ts:105`), mapped to `flash.linkLimit`.
  - New tests: driven by `__setRateLimitCounterForTests`, the 429 becomes a 303 with `e=` and no `device_links` row is written; a waiting final becomes a 303 with `notReady`.
- **T7:**
  - Files: also modifies `home.tsx` to mount the island. There is no `page.tsx` change and no `baseUrlFromHeaders`.
  - The island takes `path = routes.quickMatch(token)` and builds `new URL(path, window.location.origin)`; tests stub the origin.
  - Add the existing `ShareButton` (`components/share-button.tsx`, `navigator.share`) beside Copy (D14), with label `shareNative`. Keep the QR behind the toggle.
  - Extend T5's painter-file assertion with `share.tsx`.
- **T8:**
  - Files: also modifies `home.tsx` to mount `add-match.tsx`. The island takes only `{ fixtures: { id, label }[], sides: { id, name }[] }`.
  - The route runs its checks in this order: token, knockout, membership (compare both ids against `home.sides` BEFORE `addFixture`, so a non-UUID is a flash and not a JSON 400), same side, then the cap. The cap is ad-hoc fixtures (`ext_key like 'adhoc-%'`) `>= QUICK_MATCH_MAX_ADHOC` → `flash.adhocLimit`. Also apply `rateLimit("qm-add:"+id, MUTATION_LIMIT)` (`lib/rate-limit.ts:102`).
  - **New Step 5:** mutate each of the route's own guards one at a time (knockout, membership, same side, cap). Each mutation reds its own test.
  - Tests use `playToDecided` on badminton, with the reason line: "`firstRallyFor` throws for chess (`_quick-match-probe.ts:194`); the add-match path is sport-agnostic".
  - Add tests for the 11th ad-hoc add (refused) and a second add after the first (allowed).

### T9 (A9, A10, B9, D11)

- **Strip read (A10):** add `listRecentQuickMatches(visitorHash, limit = 5)` INSIDE `quick-match-home.ts`, with `resolveQuickMatchToken`'s predicate for an alive row (null expiry or a future one), newest first. It returns `{ token, name, createdAt }`.
- **Strip contents (D11):** the strip shows the name and the created date (localized `Intl.DateTimeFormat`). It has no "n of m played".
- **Fail soft (A9):** a row whose `openHomeToken` throws is skipped. A throw from the whole read renders nothing and logs once. The marketing page never 500s. Test: with `DEVICE_LINK_KEK` unset, the page renders the CTA and no strip.
- **Where the tests live (B9c, E7):** test the strip through the marketing page's DB test under `src/app` (`ci.yml:1317` runs it), not as a `src/components` DB test. Strip links use `routes.quickMatch` and carry `ph-no-capture`, and T5's painter-file assertion gains `recent-strip.tsx`.

### T10 e2e and T11 smoke (D7, D8, D9, A11, B10, E2)

- **CI only (E2):** push, then `gh workflow run e2e.yml --ref feat/quick-match`. Never run local Playwright or a local server. Read the run's own report, and treat a serial file's count as a floor (`mobile.spec.ts:64`).
- **`mobile.spec.ts`, at all seven widths:** league setup → home → Score → Start → one rally → back home. It asserts `expectNoHorizontalScroll` on `/en/play`, the home and the pad, and that the back link sits inside the viewport at 320.
- **`quick-match.spec.ts` (1280):**
  - **League:** run the league flow, then `page.goBack()` from the pad: the home is fresh and reads Live, which also tests bfcache on a `no-store` page. Then go forward and tap "Back to the quick match".
  - **URL forms:** open the home with a trailing slash and with `?utm_source=x`; both render it.
  - **Knockout of 4:** a real knockout shows The draw and a waiting final with no Score button.
  - **Widths at 1280:** `expectNoHorizontalScroll` on `/en/play` and on the home.
- **Selectors (A11):**
  - click the Badminton chip explicitly;
  - match exact singular copy: `Start playing · 1 match` and `0 of 1 match played`;
  - read Live as `getByTestId("qm-hero").getByText("Live")`;
  - derive `HOLD_BUDGET_MS` from the imported hold constant (precedent `mobile.spec.ts:55`).
- **New T11, smoke (D9):** create `scripts/smoke/suites/quickMatch.ts` with plan 3 T7's shape (`index.ts` `SELECTABLE_SUITES`, `main.ts` after `funnelReminder`). It runs create → home "0 of 1" → Score 303 to `/score/dl_` → one rally with the device link → home Live, and cleans up in `finally`. Plan 3 T7 then EXTENDS it with the sweep step instead of creating it. Its PR run is the proof; there is no local run against stg without the owner's go.

### Not changed, recorded

- **E1:** transient; the tree is clean at d4d9fc5709.
- **E3:** pins above.
- **E4:** V492 is renumbered at merge, per the owner's ruling of 2026-11-07.
- **E5:** no captcha in v1 (spec §7.9's default). Adding the create to Turnstile after #1136 merges is **OWED TO OWNER**.
- **E8:** OK.

## Global Constraints

- Plan 1's Global Constraints apply in full (no engine change, caps, tokens never in query strings). O9 was lifted on 2026-11-07: work commits on `feat/quick-match` in its worktree, each implementer committing only its own paths (`git commit -- <paths>`). The "Pre-flight amendments (2026-11-08)" section below overrides any task text it conflicts with.
- **Copy** (C10, C14): every string a guest reads is a dictionary key present in all four locales; `npm run i18n:check` (repo root, `package.json:62`, `scripts/i18n/check-parity.ts`) must pass after each task that adds keys, **and** `npm run i18n:gen-keys` (repo root, `package.json:60`, `scripts/i18n/gen-keys.ts`) must be re-run so the generated `src/lib/i18n-keys.ts` union carries them. Parity only compares the locales with each other, so it stays green on a stale union; CI regenerates the union and fails on a diff (`scripts/i18n/gen-keys.ts:1-10`). No internal word on screen (§4): never "stage", "variant", "legs", "entrant", "fixture", "division".
- **Night stage** (O10, O11, §8): both pages use the product's own tokens (`--mk-night`, `--mk-night-2`, `--mk-cream`, `--mk-lime` at `globals.css:532-535`, the `.mk-display` face at `:552`, the `.mk-funnel-night` input treatment at `:768-772`, `.bottom-bar` and `.bottom-bar-spacer` at `:502-514` for the docked Start button). `.bottom-bar` itself paints a light surface (`bg-white/95`, `border-purple-100`, `globals.css:503`) while the mockup's bar is night (`.qm-bottombar`, `setup.html:49`), so the setup page keeps the class for its docking and safe-area padding and overrides the surface with the night tokens. Lime is never text on a light background (`globals.css:787-788`); these pages are night, so lime plates and lime action text are allowed as the hero uses them.
- **Widths** (§8): 320, 768 and 1280 with no horizontal scroll; `html, body { overflow-x: clip }` (`globals.css:66-71`) is a backstop, not a license. Because of that clip, a bare `document.documentElement.scrollWidth === window.innerWidth` reads clean on an overflowing page; measure with `expectNoHorizontalScroll` (`e2e/helpers.ts:57`), which lifts the clip before reading, as the suite's own CONTROL test proves (`e2e/mobile.spec.ts:292-307`).
- **Locale** (amended 2026-11-08, D10): the setup page takes `lang` from the `[lang]` segment and stores it on the row, which serves the email only (plan 3). The home resolves the VIEWER's locale with `resolveLocale()` and no `orgDefault`, exactly as the pad does (`app/score/[token]/page.tsx:56`). `orgDefault` outranks Accept-Language (`lib/resolve-locale.ts:7-12`), so passing `row.locale` would show a friend the creator's language on the home and their own on the pad.
- **Route handlers** wrap in `handler` from `@/lib/http` and throw `HttpError`; JSON bodies parse with the zod schemas from plan 1. Current `handler` facts (`lib/http.ts:72-144`): it answers `{ ok: true, data }` with status 200; a route that needs another status (201) or a header (`Cache-Control`, `Set-Cookie`) returns its own `NextResponse`, which `handler` passes through unwrapped (`:78-83`); a `ZodError` becomes **400** `{ ok: false, error: "Invalid input", issues }` (`:85-90`); an `HttpError` answers `{ ok: false, error, code? }` with its own status and headers (`:116-137`). A route that ends on a page redirects with `redirectLocal(path, 303)` (`lib/http.ts:45`). In Next 16, `params` is a Promise in both pages and route handlers: `const { token } = await params` (`app/score/[token]/page.tsx:48-53`).
- **e2e:** against a pre-compiled production server on :3000, never `next dev` (`playwright.config.ts:6-15`; local recipe `docs/runbooks/e2e-local.md`, with `E2E_PROD_TARGET=1` and `DATABASE_URL`); run one spec with `npx playwright test e2e/<name>.spec.ts --project=parallel` from `apps/web`. The seven width projects (`mobile-320`, `mobile-360`, `mobile-se` 375, `mobile-14` 390, `mobile-430`, `tablet-768`, `tablet-834`, `playwright.config.ts:268-339`) run only `mobile.spec.ts`. Every project loads the shared Pro session (`storageState: AUTH_STATE`, e.g. `:242`), so a guest spec clears it with `test.use({ storageState: { cookies: [], origins: [] } })` (precedent `e2e/credits-tab-shots.spec.ts:25`). On CI, `e2e.yml` runs on a push to `main` or by `workflow_dispatch` with a `pr` input (`.github/workflows/e2e.yml:99-107`); it sets `DEVICE_LINK_KEK` (`:578`) and `NEXT_PUBLIC_SCOREPAD_HOLD_MS=3000` (`:633`) and runs with no Redis, so every rate limit is inert there (`:566`). Run path (amended 2026-11-08, E2): CI only. Push `feat/quick-match`, then `gh workflow run e2e.yml --ref feat/quick-match` (ALWAYS `--ref`). No `pr` input is needed: with it empty, every job checks out `github.sha`, the dispatched ref's head (`e2e.yml:726,1387,1777`). No local Playwright and no local web server.

## Review Focus

1. **A home link opened on a second phone while the first is mid-rally.** Expected: the hero reads Live with the current score and "Continue scoring", and tapping it reopens the same device link, never a second ledger. (Task 6)
2. **The browser's back button after scoring returns to a stale home.** Expected: the home is `force-dynamic` and never cached, so the refreshed page shows the new table; the e2e asserts the table after returning. (Task 10)
3. **A guest pastes the home URL with a trailing slash, uppercase, or a `?utm` suffix.** Expected: the token is read from the path segment only, trimmed, case preserved; a changed token is a dead link, never a 500. (Task 5)
4. **The visitor cookie is blocked or cleared.** Expected: create still works (a fresh key is minted per request) and only the "recent" strip is empty; the per-visitor cap then counts per new key, which the rate limit per IP backstops. (Task 3)
5. **A league where all matches are done, then "Add a match".** Expected: the hero turns back from the winner card to "Up next" for the decider, and standings keep counting. (Task 8)

---

### Task 1: Dictionary keys for every guest string

**Files:**
- Modify: `src/dictionaries/{en,fr,es,nl}/marketing.json` (namespace `quickMatch.*` for the CTA and setup)
- Modify: `src/dictionaries/{en,fr,es,nl}/ui.json` (namespace `quickMatch.*` for the home, the pad link and server messages; `MessageKey` is `keyof en/ui.json`, `lib/messages.ts:12`)
- Modify (generated, never by hand): `src/lib/i18n-keys.ts`, by `npm run i18n:gen-keys` from the repo root; it unions the keys of every `en/*.json`, `marketing.json` included (`scripts/i18n/gen-keys.ts:21-24`)
- Test: `npm run i18n:check`, plus `src/lib/__tests__/i18n-namespaces.test.ts` already loads every namespace per locale, and `src/lib/__tests__/dictionary-duplicate-keys.test.ts` reads each file's raw text so a key written twice in one file fails

**Interfaces:**
- Produces the key set every later task reads. English values are the mockups' copy. Keys (en):
  - marketing: `quickMatch.cta` "Quick match", `quickMatch.ctaHint` "No account. Share a link, keep score.", `quickMatch.setup.title` "Quick match", `quickMatch.setup.nameHint` "The name you'll look for later", `quickMatch.setup.sport` "Sport", `quickMatch.setup.kind.individual` "Singles", `.pair` "Doubles", `.team` "Team", `quickMatch.setup.sides` "Sides", `quickMatch.setup.sidesCount` "{n} of {max}", `quickMatch.setup.addSide` "+ Add a side", `quickMatch.setup.format` "Format", `quickMatch.setup.league` "League", `quickMatch.setup.knockout` "Knockout", `quickMatch.setup.leagueHelp` "Everyone plays everyone. Most wins tops the table.", `quickMatch.setup.knockoutHelp` "Lose and you're out.", `quickMatch.setup.knockoutUnavailable` "Knockout needs a sport that can't end level.", `quickMatch.setup.plays` "Each pair plays", `quickMatch.setup.plays.1` "Once", `.2` "Twice", `.3` "3 times", `.4` "4 times", `quickMatch.setup.rules` "Match rules", `quickMatch.setup.email` "Email me the link (optional)", `quickMatch.setup.start` "Start playing", `quickMatch.setup.startCount` "· {n} matches", `quickMatch.setup.sitsOut` "{name} sits out the first round", `quickMatch.setup.suggestedName` "{sport} · {date}", `quickMatch.recent.title` "Your recent quick matches", `quickMatch.errors.tooManyAlive` "You have 5 quick matches on the go. Finish or save one first.", `quickMatch.errors.rateLimited` "Too many new matches from this network. Try again in a few minutes.", `quickMatch.errors.formatNotOffered` "That format isn't available for this sport."
  - ui: `quickMatch.backToMatch` (plan 1 Task 9), `quickMatch.home.played` "{played} of {total} matches played · kept {days} days after the last score", `quickMatch.home.upNext` "Up next · match {n} of {total}", `quickMatch.home.live` "Live", `quickMatch.home.score` "Score this match", `quickMatch.home.continue` "Continue scoring", `quickMatch.home.scoreShort` "Score", `quickMatch.home.waits` "waits", `quickMatch.home.share` "Share link", `quickMatch.home.save` "Save this match", `quickMatch.home.standings` "Standings", `quickMatch.home.draw` "The draw", `quickMatch.home.all` "All matches", `quickMatch.home.addMatch` "+ Add a match", `quickMatch.home.anyoneCanScore` "Anyone with this link can score.", `quickMatch.home.winner` "Winner", `quickMatch.home.level` "Level", `quickMatch.home.beat` "beat", `quickMatch.home.winnerOf` "winner of {n}", `quickMatch.home.copy` "Copy link", `quickMatch.home.copied` "Copied", `quickMatch.home.semiFinal` "Semi-final {n}", `quickMatch.home.final` "Final", `quickMatch.home.round` "Round {n}", `quickMatch.dead.title` "This quick match has ended", `quickMatch.dead.hint` "It was kept 7 days after the last score. Start a new one from the home page."

- [ ] **Step 1: Add the keys to `en`, then `fr`, `es`, `nl`** with translations in the product's existing register for each language (match the tone of the funnel keys next to them).
- [ ] **Step 2: Run `npm run i18n:gen-keys` and `npm run i18n:check` from the repo root, confirm `src/lib/i18n-keys.ts` now lists the new keys (`grep -a -c '"quickMatch\.' apps/web/src/lib/i18n-keys.ts`), then from `apps/web` run `DATABASE_URL= npx vitest run --reporter=json --outputFile=/tmp/qm-i18n.json src/lib/__tests__/i18n-namespaces.test.ts src/lib/__tests__/dictionary-duplicate-keys.test.ts`** (expected: both files pass; read `numTotalTests`/`numPassedTests` from the JSON file)

---

### Task 2: Offer and preview JSON routes

**Files:**
- Create: `src/app/api/quick-match/sports/route.ts`
- Create: `src/app/api/quick-match/preview/route.ts`
- Test: `src/app/api/quick-match/__tests__/sports-and-preview.test.ts`

**Interfaces:**
- Consumes: plan 1 `listQuickMatchSports()`, `quickMatchPreview()`.
- Produces:
  - `GET /api/quick-match/sports` → `{ ok: true, data: { sports: QuickMatchSport[] } }` with `Cache-Control: public, max-age=300`; the header means the handler returns its own `NextResponse.json(...)`, which `handler` passes through (Global Constraints, Route handlers).
  - `GET /api/quick-match/preview?format=league|knockout&sides=2..6&plays=1..4` → `{ ok: true, data: QuickMatchPreview }`; 400 on bad params (zod on `searchParams`; `handler` turns the `ZodError` into 400, `lib/http.ts:85-90`).

- [ ] **Step 1: Write the failing tests** (call the exported `GET` with a `Request` and read the body's `data`): sports returns badminton with `knockoutAllowed` true on some variant and never `generic`; preview `league&sides=4&plays=2` returns `matchCount 12`; `sides=7` returns 400; `format=swiss` returns 400. The sports case reads `sport_variants`, so it sits under `describe.skipIf(!HAS_DB)` like plan 1's suites; the three preview cases need no database.
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** both handlers.
- [ ] **Step 4: Run to verify pass** (expected: PASS, 4 tests)

---

### Task 3: The create route and the visitor cookie

**Files:**
- Create: `src/app/api/quick-match/route.ts`
- Create: `src/server/usecases/quick-match-visitor.ts`
- Test: `src/app/api/quick-match/__tests__/create-route.test.ts`

**Interfaces:**
- Consumes: plan 1 `CreateQuickMatch`, `createQuickMatch`, `mintVisitorKey`, `hashVisitorKey`, `QUICK_MATCH_VISITOR_COOKIE`, `QUICK_MATCH_VISITOR_COOKIE_MAX_AGE_S`; `rateLimit` + `EMAIL_LIMIT` (`lib/rate-limit.ts:60,96`) keyed `quick-match-create:${ip}` with the first `x-forwarded-for` hop as the funnel does (`api/funnel/start/route.ts:32-33`); `cookies()` from `next/headers` to read the visitor cookie. The cookie is SET on the returned response (`res.cookies.set(name, value, opts)`), the repo's precedent being the referral cookie (`app/refer/[code]/route.ts:27-33`).
- Produces:
  ```ts
  // quick-match-visitor.ts
  export async function readOrMintVisitor(): Promise<{ key: string; hash: string; minted: boolean }>;  // reads the cookie; mints when absent or malformed
  export function visitorCookieOptions(): { httpOnly: true; sameSite: "lax"; secure: boolean; path: "/"; maxAge: number };  // secure = NODE_ENV === "production", as refer/[code]/route.ts:30
  // POST /api/quick-match  body: CreateQuickMatch
  //   → 201 { ok: true, data: { url: "/q/<token>", match_count: number } }, its own NextResponse (handler passes it through), Set-Cookie when minted
  //   429 { code: "QUICK_MATCH_TOO_MANY_ALIVE" }  (the per-visitor cap, plan 1's HttpError)
  //   429 with NO code: the per-IP limit. rateLimit throws HttpError(429, TOO_MANY) carrying only a Retry-After header
  //       (lib/rate-limit.ts:57-58,78-80), so the client reads a code-less 429 as errors.rateLimited
  //   422 { code: "QUICK_MATCH_FORMAT_NOT_OFFERED" }
  //   400 { error: "Invalid input", issues }: a schema failure, handler's ZodError branch (lib/http.ts:85-90), not 422
  ```
  The email, when given, is stored on the row by `createQuickMatch`; sending it is plan 3 Task 1 and is wired there.

- [ ] **Step 1: Write the failing tests**: a valid body returns 201 with a `/q/qm_` url and a `Set-Cookie` for `seazn_qm_visitor` with `HttpOnly`; a second request carrying that cookie sets no new cookie and the two rows share `visitor_hash`; a request with a malformed cookie value still creates and mints a fresh cookie (Review Focus 4); the 6th create for one cookie returns 429 `QUICK_MATCH_TOO_MANY_ALIVE`; with `__setRateLimitCounterForTests` (`lib/rate-limit.ts:43`; its counter returns `{ count: EMAIL_LIMIT.max + 1, ttlMs }`) the route returns 429 with no `code` before touching the DB, and `__setRateLimitCounterForTests(null)` restores it after.
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** the route and the visitor module.
- [ ] **Step 4: Run to verify pass** (expected: PASS, 5 tests)

---

### Task 4: The setup page

**Files:**
- Create: `src/app/[lang]/(marketing)/play/page.tsx`
- Create: `src/components/quick-match/setup-form.tsx` (client)
- Create: `src/components/quick-match/recent-strip.tsx` (server; filled in Task 9)
- Test: `src/components/quick-match/__tests__/setup-form.test.tsx` (no DB, no DOM: `renderIsland` from `src/components/__tests__/_hook-harness.tsx:184`, which runs the island's `useState`/`useEffect` and returns its element tree; find controls with `walk`/`propsOf`/`textOf`, `:111-127`, and call their `onClick`/`onChange`/`onSubmit` props as a browser would) and `src/app/[lang]/(marketing)/__tests__/play-page.test.tsx` following the pattern in that folder (`home-signed-in.test.tsx`: `prerender` from `react-dom/static`, with `next/font/google`, `@/lib/auth` and `next/navigation` mocked, `:1-55`)

**Interfaces:**
- Consumes: Task 1 keys via `getDictionary(lang, "marketing")` and `t` (`@/lib/i18n`); Task 2 routes; `MarketingShell` (`variant="night-scroll"`, `components/marketing/marketing-shell.tsx:16`); `hasLocale` (`@/lib/i18n-constants`), `generateMetadata` pattern from `[lang]/(marketing)/formats/page.tsx:10-45` with canonical `/${lang}/play`. Only the prefixed `/${lang}/play` resolves: the proxy rewrites an unprefixed marketing path only when it is listed in `MARKETING_UNPREFIXED` (`proxy.ts:217`), and `/play` is not, so every link to this page (Task 9's CTA included) spells the locale.
- Produces:
  ```ts
  export function QuickMatchSetupForm({ lang, sports, labels, suggestedName }: {
    lang: Locale; sports: QuickMatchSport[]; labels: Record<SetupLabelKey, string>; suggestedName: string;
  }): JSX.Element;
  ```
  Behavior pinned by tests, in the mockup's order: name heading prefilled with `suggestedName` (sport name + today's short date in `lang`); sport chips from `sports`; the kind switch shows only kinds the chosen sport's variants offer; sides list starts with 2 rows, "+ Add a side" up to 6, count "n of 6"; the Format row is hidden while exactly 2 sides are filled (C16) and shows League | Knockout otherwise; Knockout is disabled with `quickMatch.setup.knockoutUnavailable` when the chosen variant's `knockoutAllowed` is false (C23); "Each pair plays" appears only for League; the draw preview and "sits out" lines appear only for Knockout; the Start button text is `start` + `startCount` with `n` from `GET /api/quick-match/preview` (debounced on sides/format/plays), disabled while any filled side is blank; on submit POST `/api/quick-match`, then `window.location.assign(data.url)`; errors map `code` → `quickMatch.errors.*`, and a 429 with no `code` (the per-IP limit, Task 3) → `quickMatch.errors.rateLimited`.

- [ ] **Step 1: Write the failing component tests** (stub `fetch` and `window.location.assign` with `vi.stubGlobal`; responses use the `{ ok, data }` / `{ ok: false, error, code }` envelope): renders 2 side inputs and no Format row; adding a third side shows the Format row; choosing Knockout hides "Each pair plays" and shows two first-round lines for 4 sides from the mocked preview; a sport whose variant has `knockoutAllowed:false` renders Knockout disabled with the unavailable copy; the Start button shows "· 6 matches" after the preview resolves; submit posts the `CreateQuickMatch` shape with `seeds` implied by order and `locale: lang`; a 429 with `code: "QUICK_MATCH_TOO_MANY_ALIVE"` shows `errors.tooManyAlive`, and a 429 with no code shows `errors.rateLimited`.
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** the page (server: load sports via `listQuickMatchSports()` directly, not the route; load the dictionary; render `MarketingShell` → `QuickMatchSetupForm` + `RecentStrip`) and the form.
- [ ] **Step 4: Run to verify pass**, then `npm run i18n:check`.
- [ ] **Step 5: Width check:** against the production server (Global Constraints, e2e; never `next dev`), screenshot `/en/play` at 320, 768 and 1280 and measure each with `expectNoHorizontalScroll`'s method (`e2e/helpers.ts:57`; not a bare `scrollWidth === innerWidth`, which the `overflow-x: clip` backstop blinds); record the three results in the task's test file header comment. Task 10's `mobile.spec.ts` case then carries the same check at every width. Run path: see Blockers in the re-pin log.

---

### Task 5: The home page

**Files:**
- Create: `src/app/q/[token]/page.tsx` (`export const dynamic = "force-dynamic"`)
- Create: `src/components/quick-match/home.tsx` (server), `src/components/quick-match/standings.tsx`, `src/components/quick-match/draw.tsx`, `src/components/quick-match/match-list.tsx`
- Modify: `src/lib/scrub-score-url.ts` (`SECRET_PATH_ROUTES`, `:163-171`: add `"/q/"`) and `src/lib/__tests__/_route-scan.ts` (`VERDICTS`, `:71-84`: add `"q/[token]": true`). The home token is a scoring credential (O3, C19); a new `app/**/[token]` directory fails `scrub-path-secrets.test.ts` until it has a verdict (`:101-105` compares the scanned route keys to `VERDICTS` exactly), and the verdict holds only once the scrubber strips `/q/<token>` from PostHog and Sentry URLs.
- Test: `src/app/q/[token]/__tests__/page.test.tsx` (render harness as `app/score/[token]/__tests__/page.test.tsx`: call the async page and walk the element TREE it returns, no jsdom and no `renderToStaticMarkup`, `:1-10`); `src/lib/__tests__/scrub-path-secrets.test.ts` and `src/lib/__tests__/scrub-secret-painters.test.ts` (existing; both must stay green)

**Interfaces:**
- Consumes: plan 1 `resolveQuickMatchToken`, `readQuickMatchHome`, `nextPlayable`; `resolveLocale` (`@/lib/resolve-locale`), `msgFor` (`@/lib/messages-i18n`, as the pad imports it, `app/score/[token]/page.tsx:40`), `getDictionary(locale, "ui")`; `HtmlLang` (`@/components/i18n/html-lang`).
- Produces: `QuickMatchHomeView({ home, locale, t, tokenPath }: { home: QuickMatchHome; locale: Locale; t: (k: MessageKey, v?) => string; tokenPath: string })`. Sections in the mockup's order: eyebrow `sport · kind · format`; name; `home.played` line; hero (`upNext` with `next`, or `live` with the in-play fixture's current score from its `summary`, or the winner card when `allPlayed`); actions row (Share → Task 7, Save → plan 3); `standings.tsx` for league (columns P, W, Pts; `StandingsOut.rows` is `unknown[]`, `stages.ts:6239-6247`, so read each row as `StandingsRowLike`, `lib/public-site.ts:207`, whose `played`/`won`/`points` keys and P-then-W order `resultColumns` declares, `:232`) or `draw.tsx` for knockout (rounds as cards: `semiFinal {n}` for the penultimate round of a 4-draw, `final` for `is_final`, `round {n}` otherwise, winners in lime); `match-list.tsx` (unplayed with a Score form button, waiting ones with `waits`, finished at the bottom as "A beat B" with the summary scores); `addMatch` (league only, Task 8); `anyoneCanScore`.
  The dead-link screen reuses `DeadLink`'s shape from the pad page (a page-local function, `app/score/[token]/page.tsx:319-330`, `data-testid="scan-dead-link"`) with `quickMatch.dead.*` copy for an unknown or expired token. The token is read from the route's `params` only (`const { token } = await params`, a Promise in Next 16), trimmed (Review Focus 3).
  Every element that paints a `/q/<token>` URL carries `ph-no-capture` (`scrub-secret-painters.test.ts:1-24`): from this task on, the scan treats `/q/` as a secret route. That covers this page, Task 7's share, Task 9's strip, and plan 1's `quick-match-back-link.tsx`. If plan 1 shipped the back link without the class, add it here. A file that paints the URL but not the secret instead takes a verdict in the scan's `PAINTERS` (`:382`).

- [ ] **Step 1: Write the failing page tests**: a fresh league of 4 renders "0 of 6", the hero names match 1's sides and the Score button, a standings table with 4 rows, and six list rows; an unknown token renders the dead screen with status-equivalent copy; a knockout of 3 renders "The draw" with the bye line marked and the final shown as waiting with no Score button; a trailing-slash or `?utm` URL still resolves (route test with `params` resolving to the exact token, and a changed token → dead).
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** the page and the four components with the product's tokens, then the scrubber route and its verdict. Extend `scrub-path-secrets.test.ts`'s real-token pool (`:64-79`, `KINDS`) with tokens from plan 1's `mintHomeToken()`, so the `/q/` sweep runs on real home tokens.
- [ ] **Step 4: Run to verify pass**, the page test plus `DATABASE_URL= npx vitest run src/lib/__tests__/scrub-path-secrets.test.ts src/lib/__tests__/scrub-secret-painters.test.ts`; mutate once by removing `"/q/"` from `SECRET_PATH_ROUTES` and confirm the path-secrets sweep reds on a `/q/` URL, then restore it.
- [ ] **Step 5: Width check** at 320, 768 and 1280 as in Task 4.

---

### Task 6: Score, as a form post that redirects into the pad

**Files:**
- Create: `src/app/q/[token]/score/[fixtureId]/route.ts`
- Modify: `src/components/quick-match/match-list.tsx` and `home.tsx` (the hero button) to post to it
- Test: `src/app/q/[token]/__tests__/score-route.test.ts`

**Interfaces:**
- Consumes: plan 1 `resolveQuickMatchToken`, `ensureGuestDeviceLink`, `touchQuickMatchActivity`.
- Produces: `POST /q/[token]/score/[fixtureId]` → 303 to `/score/<device link secret>` via `redirectLocal(\`/score/${secret}\`, 303)` (`lib/http.ts:45`; a relative `Location`, and the secret carries the `dl_` prefix, `device-links.ts:16`); 404 for an unknown token or a fixture outside this quick match; 422 for unknown sides. `params` (`{ token, fixtureId }`) is awaited. The hero and each list row are `<form method="post" action=...><button>` so it works with no JavaScript. A live fixture posts to the same route and gets the same reopened link (Review Focus 1). This route sits under `q/[token]`, so Task 5's `/q/` scrub covers its URL too.

- [ ] **Step 1: Write the failing tests**: a valid post returns 303 with `Location` starting `/score/dl_`; posting twice returns the same `Location` (reopen, not a second link); a fixture of another quick match returns 404; the knockout final before the semi-finals returns 422; `last_activity_at` moves on a valid post.
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run to verify pass** (expected: PASS, 5 tests)

---

### Task 7: Share: the link and the QR with the Seazn logo

**Files:**
- Create: `src/components/quick-match/share.tsx` (client island: show URL, copy button, QR)
- Test: `src/components/quick-match/__tests__/share.test.tsx`

**Interfaces:**
- Consumes: `renderSeaznQr(text): Promise<SeaznQr>` (`lib/seazn-qr.ts:113`) and `SeaznQr` (`:34`), loaded on the tap with a dynamic import, as the check-in QR does (`components/v2/checkin-qr.tsx:33-36`; the Remote scoring panel calls it the same way, `components/v2/device-link-panel.tsx:194-197`). It is the only producer of the logo-carrying QR: it embeds the logo by fetching `SEAZN_QR_LOGO_PATH` in the browser (`lib/seazn-qr.ts:19,80-108`). The pure `seaznQrSvg(text, { logoHref, size })` (`:69`) needs a logo href the server has no embedded copy of, and an SVG painted through `<img>` cannot fetch an external one, so a server-built QR would lose the logo. Also consumes `SeaznQrImage({ qr, alt, testId, sensitive, maxSize })` (`components/v2/seazn-qr-image.tsx:71`), `PHONE_HANDOVER_QR_MAX_PX` (`:27`), and the absolute home URL built on the server with `baseUrlFromHeaders()` (`lib/base-url.ts:6`, the page twin of `baseUrl(req)`, `lib/oauth.ts:35`).
- Produces: `QuickMatchShare({ url, labels }: { url: string; labels: { share: string; copy: string; copied: string; qrAlt: string } })`. Pressing Share builds the QR from `url` in the island and paints it `sensitive` (it is the scoring credential, O3), so it is behind the Share toggle: not on first paint, and never in the server HTML. `SeaznQrImage` puts `ph-no-capture` on a sensitive QR (`seazn-qr-image.tsx:29-31`). The shown URL text carries the same class (Task 5's painter rule). `qrAlt` is a Task 1 key; if Task 1 did not list one, add it to all four locales here.

- [ ] **Step 1: Write the failing tests** with `renderIsland` (Task 4), with `@/lib/seazn-qr`'s `renderSeaznQr` mocked as `components/v2/__tests__/device-link-panel.test.tsx:72-79` does: before Share there is no `SeaznQrImage` in the tree and no `renderSeaznQr` call; pressing Share calls `renderSeaznQr` with exactly `url` (asserted as `device-link-panel.test.tsx:294` does) and paints `SeaznQrImage` with `sensitive` true and `maxSize` `PHONE_HANDOVER_QR_MAX_PX`; pressing Copy writes `url` to the clipboard (stub `navigator.clipboard.writeText` with `vi.stubGlobal`) and swaps the label to `copied`. The logo itself belongs to `renderSeaznQr`'s own contract, so it is not re-pinned here.
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement**: `page.tsx` builds the absolute URL with `baseUrlFromHeaders()` and passes it down; the island builds the QR on the tap.
- [ ] **Step 4: Run to verify pass**, plus `src/lib/__tests__/scrub-secret-painters.test.ts`.

---

### Task 8: Add a match (league decider)

**Files:**
- Create: `src/app/q/[token]/add-match/route.ts`
- Create: `src/components/quick-match/add-match.tsx` (a small form: two side selects, one button)
- Test: `src/app/q/[token]/__tests__/add-match-route.test.ts`

**Interfaces:**
- Consumes: plan 1 `systemAuth`, `resolveQuickMatchToken`, `readQuickMatchHome` (for the stage id and the sides); `addFixture(auth, stageId, { home_entrant_id, away_entrant_id })` (`stages.ts:7322`).
- Produces: `POST /q/[token]/add-match` with form fields `home`, `away` (entrant ids) → 303 back to `/q/[token]` via `redirectLocal(..., 303)` (`lib/http.ts:45`; `params` awaited); 422 when the quick match is a knockout, when `home === away`, or when either id is not one of this quick match's sides. `addFixture` refuses all three itself too (a bracket kind `stages.ts:7352`, the same entrant twice `:7359`, an entrant outside the stage's division `:7378`), and it names the new row `adhoc-<n>` (`:7434`). So each test must reach the ROUTE's own check, and the route's checks are mutated one at a time (AGENTS.md class 3: two guards covering for each other are each untested). The route's check is also the per-match guard (§7.1 point 3), and its refusal carries the guest's copy.

- [ ] **Step 1: Write the failing tests**: on a league of 2 with the one match played, adding a match creates a 2nd fixture in round 2 with `ext_key 'adhoc-1'`, the home then shows "1 of 2" and the hero is "Up next" again (Review Focus 5); on a knockout the route returns 422; an entrant id from another quick match returns 422.
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run to verify pass** (expected: PASS, 3 tests)

---

### Task 9: The marketing call to action and the recent strip

**Files:**
- Modify: `src/app/[lang]/(marketing)/page.tsx:113-129` (beside `StartFunnelForm`)
- Create: `src/components/marketing/quick-match-cta.tsx`
- Modify: `src/components/quick-match/recent-strip.tsx` (from Task 4's stub)
- Test: `src/app/[lang]/(marketing)/__tests__/home-quick-match-cta.test.tsx`, `src/components/quick-match/__tests__/recent-strip.test.tsx`

**Interfaces:**
- Consumes: plan 1 `hashVisitorKey`, `openHomeToken`, `QUICK_MATCH_VISITOR_COOKIE`; `cookies()`. Wrap the `cookies()` call in a `try`/`catch` that reads a throw as "no cookie". Outside a real request it throws synchronously, before any Promise exists, and that is exactly how the existing `home-signed-in.test.tsx` renders the marketing page; `resolve-locale.ts:20-49` documents the throw and the pattern. Without the `try`/`catch`, adding the strip to the home reds that existing suite.
- Produces: `QuickMatchCta({ lang, label, hint })` linking to `/${lang}/play` (prefixed; Task 4 says why), styled as the hero's secondary action (cream text, `#4a3885` border, as the finale's second button at `page.tsx:221-226`); `RecentStrip({ lang, title })` (server) that reads the cookie, lists up to 5 unexpired rows for that visitor hash newest first as links to `/q/<token>` with the name and "n of m played", and renders nothing when the cookie is absent or there are no rows. Each strip link paints a home token, so it carries `ph-no-capture` (Task 5's painter rule).

- [ ] **Step 1: Write the failing tests**: the marketing page renders the CTA with `href="/en/play"` next to the funnel form (harness: `home-signed-in.test.tsx`, `prerender` plus its mocks; add a `next/headers` mock for the cookie cases); the strip renders nothing without a cookie, and two links for a visitor with two live rows; an expired row is not listed.
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement**; the strip is used on the marketing page (under the hero) and on `/play`.
- [ ] **Step 4: Run to verify pass**, together with the existing `src/app/[lang]/(marketing)/__tests__/home-signed-in.test.tsx` and `src/lib/__tests__/scrub-secret-painters.test.ts`; then `npm run i18n:gen-keys` and `npm run i18n:check`. The hero changed, so re-run the e2e specs that drive `/` (by behaviour, not filename, AGENTS.md class 16): `e2e/marketing-home.spec.ts` (its hero-funnel case, `:31`), `e2e/i18n-switcher.spec.ts` (`:28`), and `mobile.spec.ts`'s anonymous "public surfaces: no horizontal scroll" case, whose route list starts with `/` (`:1661-1667`).

---

### Task 10: End to end, including the seven widths

**Files:**
- Create: `e2e/quick-match.spec.ts` (project `parallel`)
- Modify: `e2e/mobile.spec.ts` (one case that runs in all seven width projects)
- `e2e/helpers.ts`: no change expected. `withDb` (`:539`) and `expectNoHorizontalScroll` (`:57`) are already exported, and the spec scores by tapping the pad, so plan 1's `firstRallyFor` (a vitest helper for its Task 8) is not needed here. Add a helper only if a second spec needs the pad-tap locator below.

**Interfaces:**
- Consumes: the real pages and routes; `e2e/helpers.ts` (`withDb` for assertions, `expectNoHorizontalScroll` for widths); a running production server on :3000 with `DEVICE_LINK_KEK` set (CI sets it, `e2e.yml:578`).
- The device-link pad opens on its Confirm card. Its Start button (`data-testid="score-start-match"`) posts `core.start` (`components/v2/device-score-pad.tsx:744-749`), and only then does the v3 pad (`[data-role="pad-v3"]`) mount (precedent `e2e/device-links.spec.ts:167-175`). On a racket pad the scoreboard halves are the point controls: the home half is `getByTestId("score-pad").locator('[data-role="v3-scorebug"]').locator(".grid > button").nth(0)`, the locator that `mobile.spec.ts`'s local `padHalf` helper uses (`e2e/mobile.spec.ts:4701-4707`, not exported). The pad soft-commits: a tap posts only after `HOLD_MS` (`components/v2/scorepad/queue.ts:150-195`; 10 s by default, 3 s on CI via `NEXT_PUBLIC_SCOREPAD_HOLD_MS`, `e2e.yml:633`). Leaving the pad inside the hold can leave the home without the rally, so the spec waits for the rally in `score_events` before it taps Back. Budget that wait from the hold, never a flat literal (AGENTS.md class 20).

- [ ] **Step 1: Write the failing spec**

```ts
test.use({ storageState: { cookies: [], origins: [] } });                     // a guest: no session (precedent e2e/credits-tab-shots.spec.ts:25)

test("marketing → setup → home → score one rally → back home", async ({ page }) => {
  await page.goto("/en"); await page.getByRole("link", { name: "Quick match" }).click();
  await expect(page).toHaveURL(/\/en\/play$/);
  await page.getByLabel("Side 1").fill("Ravi & Sam"); await page.getByLabel("Side 2").fill("Priya & Tom");
  await expect(page.getByRole("button", { name: /Start playing · 1 matches?/ })).toBeEnabled();
  await page.getByRole("button", { name: /Start playing/ }).click();
  await expect(page).toHaveURL(/\/q\/qm_/); const home = page.url();
  await expect(page.getByText("0 of 1 matches played")).toBeVisible();
  await page.getByRole("button", { name: "Score this match" }).click();
  await expect(page).toHaveURL(/\/score\/dl_/);
  await page.getByTestId("score-start-match").click();                          // the Confirm card (device-score-pad.tsx:744-749)
  await expect(page.locator('[data-role="pad-v3"]')).toBeVisible();
  await page.getByTestId("score-pad").locator('[data-role="v3-scorebug"]').locator(".grid > button").nth(0).click(); // home half (mobile.spec.ts:4701-4707)
  await expect.poll(() => ralliesOn(home), { timeout: HOLD_BUDGET_MS }).toBe(1); // withDb: score_events other than core.start on this quick match's fixtures
  await page.getByRole("link", { name: "Back to the quick match" }).click();
  await expect(page).toHaveURL(home);
  await expect(page.getByText("Live")).toBeVisible();                           // Review Focus 2: refreshed, not stale
});
test("knockout of 4 shows the draw and a waiting final", async ({ page }) => { /* three sides more, choose Knockout, assert "The draw", "waits" */ });
```

`ralliesOn(homeUrl)` and `HOLD_BUDGET_MS` are spec-local: the first is a `withDb` count keyed by the home token's sha256 (`quick_matches.token_hash`, plan 1) through the competition to its fixtures; the second derives from the hold (AGENTS.md class 20).

The mobile case (in `mobile.spec.ts`, so it runs at 320, 360, 375, 390, 430, 768, 834): in an anonymous context, as the "public surfaces" case opens one (`mobile.spec.ts:1661-1663`), open `/en/play`, fill two sides, Start, and assert that the home renders and that `expectNoHorizontalScroll(page)` passes on both pages. A bare `scrollWidth === innerWidth` is blind under `overflow-x: clip` (`mobile.spec.ts:292-307`).

- [ ] **Step 2: Run to verify failure** (`npx playwright test e2e/quick-match.spec.ts --project=parallel` from `apps/web`, or the CI dispatch; see Blockers)
- [ ] **Step 3: Fix whatever the spec finds** in Tasks 4 to 9 (no new surface here).
- [ ] **Step 4: Run to verify pass**, then `npx playwright test e2e/mobile.spec.ts` for all width projects: the whole file, never a `-g` slice. It runs `test.describe.configure({ mode: "serial" })` (`mobile.spec.ts:64`), so one red skips every later case; treat a pass count as a floor and re-run after each fix until a full pass completes (AGENTS.md class 21). Add the spec name to `SERIAL_SPECS` (`playwright.config.ts:31-32`) only if it turns out to touch shared org state. It should not: every run creates its own quick match in the system org, whose `competitions.max_active` is unlimited (plan 1 Task 1), and the per-IP create limit is inert without Redis (`e2e.yml:566`).

---

## Self-review notes

- **Spec coverage, plan 2 scope:** §5 steps 1 to 5 (Tasks 9, 4, 5, 6, 9), C4 (one home link; Task 6 mints per fixture), C5 and C13 "anyone with the link can add a decider" (Task 8), C12 (plan 1 Task 9, exercised in Task 10), C14 (Task 4 rules choice from variants), C15 winner card (Task 5), C16, C17, C22 preview (Task 4), C23 disabled Knockout (Task 4; the server refusal is plan 1 Task 5), §7.9 rate limit (Task 3), §8 widths (Tasks 4, 5, 10), §9 e2e (Task 10). Saving, email and expiry are plan 3.
- **Not built, on purpose:** realtime on the home (C8: other phones refresh); a watch-only link (§3); any client-side bracket logic (`draw.tsx` only lays out fixture rows).
- **Type consistency:** `QuickMatchSport`, `QuickMatchPreview`, `QuickMatchHome`, `QuickMatchFixture`, `resolveQuickMatchToken`, `ensureGuestDeviceLink`, `touchQuickMatchActivity`, `systemAuth` are plan 1's names, unchanged.

## Re-pin log (2026-11-07)

Verified against origin/main 1b224951d4 in the `quick-match` worktree. Every path and symbol claim was checked by opening the file, not by grep alone. All 12 file:line pins the plan carried still hold. Most files the plan builds on are unchanged since 2026-11-04, and #1133 touched only `fixture-console.tsx` and `needs-decision.tsx`. So the changes below are mostly cases where the plan's text did not match how the current tree works; each is adopted rather than argued with. No O or C decision, task, task order or scope item was changed.

| # | Where | Old | New |
|---|---|---|---|
| 1 | Header | (no re-pin line; the repo-root line already named the seazn.club checkout) | Added "Re-pinned against origin/main 1b224951d4 on 2026-11-07 (drift accepted)." |
| 2 | Tech Stack | `SeaznQrImage` + `seaznQrSvg`; no island test harness named | `SeaznQrImage` + `renderSeaznQr` in the client island; islands tested with `renderIsland` (`_hook-harness.tsx:184`); vitest is `environment: "node"` (`vitest.config.ts:135`) with no jsdom and no React Testing Library |
| 3 | Global, Copy | `npm run i18n:check` only | Plus `npm run i18n:gen-keys` (`package.json:59`): the generated `src/lib/i18n-keys.ts` union is a CI drift gate that parity cannot see |
| 4 | Global, Night stage | Token names, unpinned | Pinned (`globals.css:532-535`, `:552`, `:768-772`, `:502-514`). `.bottom-bar` paints a light surface (`:503`) where the mockup's bar is night (`setup.html:49`): keep the class, override the surface |
| 5 | Global, Widths | "`overflow-x: clip` is a backstop" | Pinned `globals.css:66-71`. A bare `scrollWidth === innerWidth` is blind under it; measure with `expectNoHorizontalScroll` (`e2e/helpers.ts:57`), as the CONTROL test proves (`mobile.spec.ts:292-307`) |
| 6 | Global, Route handlers | "wrap in `handler`, throw `HttpError`" | Plus the `{ ok, data }` envelope; its own `NextResponse` for 201 or a header; `ZodError` → 400; `HttpError` forwards `code` (`lib/http.ts:72-144`); `redirectLocal(path, 303)` (`:45`); awaited `params` in Next 16 |
| 7 | Global, e2e | prod server on :3000, one-spec command, seven widths | Plus "never `next dev`" (`playwright.config.ts:6-15`), `E2E_PROD_TARGET`, the seven project names (`:268-339`), the Pro `storageState` on every project and how a guest spec clears it (`credits-tab-shots.spec.ts:25`), and the `e2e.yml` facts: triggers `:99-107`, KEK `:578`, hold 3000 ms `:633`, no Redis `:566`. The run path goes to Blockers |
| 8 | Task 1 | Files and Step 2 without gen-keys | Plus the generated `i18n-keys.ts`; Step 2 runs `i18n:gen-keys`, then the two suites through the JSON reporter |
| 9 | Task 2 | Bodies `{ sports }` and `QuickMatchPreview` | Wrapped in `{ ok: true, data }`; `Cache-Control` set on the route's own `NextResponse`; the sports case gated on `DATABASE_URL` (it reads `sport_variants`) |
| 10 | Task 3 | `201 {url, match_count}`; `429 { code: … \| "RATE_LIMITED" }`; `422 { … \| validation }` | 201 is its own `NextResponse` in the envelope. The per-IP 429 carries **no** `code` (`lib/rate-limit.ts:57-58,78-80`), so the client maps a code-less 429 to `errors.rateLimited`. A schema failure is 400 (`lib/http.ts:85-90`). The cookie is set on the response (`refer/[code]/route.ts:27-33`). The test seam is pinned at `:43` |
| 11 | Task 4 | "React Testing Library"; "pattern in that folder"; "with the dev server … `scrollWidth === innerWidth`" | `renderIsland` (`:184`, helpers `:111-127`); `home-signed-in.test.tsx:1-55` (`prerender` plus its mocks); only `/${lang}/play` resolves (`proxy.ts:217`); a code-less 429 maps to `errors.rateLimited`; the width check runs on the prod server with `expectNoHorizontalScroll`'s method |
| 12 | Task 5 | harness "as `score/[token]/page.test.tsx`"; `params.token`; standings "from `StandingsOut` rows"; `DeadLink` unpinned | Harness pinned to `app/score/[token]/__tests__/page.test.tsx:1-10` (element-tree walk); params awaited; row keys `played`, `won`, `points` from `StandingsRowLike` and `resultColumns` (`stages.ts:6162-6170`, `public-site.ts:207,232`); `DeadLink` at `page.tsx:319-330`; `msgFor` and `HtmlLang` import paths. **Added**: Modify `scrub-score-url.ts:163-171` (`"/q/"`) and `_route-scan.ts:71-84` (`"q/[token]": true`), because a new `[token]` route reds `scrub-path-secrets.test.ts:101-105`; the `ph-no-capture` painter rule (`scrub-secret-painters.test.ts:1-24`, `PAINTERS` `:382`); a scrub mutation step |
| 13 | Task 6 | "303 to `/score/<secret>`" | `redirectLocal(…, 303)` (`lib/http.ts:45`), with the `dl_` prefix (`device-links.ts:16`); params awaited; covered by Task 5's scrub |
| 14 | Task 7 | QR computed on the server with `seaznQrSvg`; `QuickMatchShare({ url, qr, labels })`; the test reads the logo href in `src`; URL from "`baseUrl(req)`'s equivalent … or `headers().get("host")`" | QR built in the island on the Share tap with `renderSeaznQr` (`lib/seazn-qr.ts:113`; precedents `checkin-qr.tsx:33-36` and `device-link-panel.tsx:194-197`); `QuickMatchShare({ url, labels })` with `labels.qrAlt`; URL from `baseUrlFromHeaders()` (`lib/base-url.ts:6`); the test mocks `renderSeaznQr` and asserts its argument (`device-link-panel.test.tsx:72-79,294`) |
| 15 | Task 8 | 303 and three 422s | `redirectLocal`; params awaited; `addFixture` refuses each case itself (`stages.ts:7275,7282,7301`), so tests must reach the route's own check, with one mutant per guard; `adhoc-<n>` pinned (`:7357`) |
| 16 | Task 9 | `cookies()`; tests unspecified beyond names; Step 4 `i18n:check` | `cookies()` inside `try`/`catch` (`resolve-locale.ts:20-49`), or the existing `home-signed-in.test.tsx` reds; strip links carry `ph-no-capture`; tests use the `prerender` harness with a `next/headers` mock; Step 4 adds `i18n:gen-keys`, the existing home suite, the painter scan, and the e2e specs that drive `/` (`marketing-home.spec.ts:31`, `i18n-switcher.spec.ts:28`, `mobile.spec.ts:1661-1667`) |
| 17 | Task 10 | `PAD_FIRST_POINT_HOME` placeholder; `helpers.ts` gains `firstRallyFor`; mobile check by `scrollWidth === innerWidth`; Pro session implicit | Start on the Confirm card (`score-start-match`, `device-score-pad.tsx:744-749`; precedent `device-links.spec.ts:167-175`); tap the home half (`mobile.spec.ts:4701-4707`); poll the rally past `HOLD_MS` (`queue.ts:150-195`, `e2e.yml:633`) before tapping Back; `test.use` guest storage; `helpers.ts` unchanged; mobile case in an anonymous context (`mobile.spec.ts:1661-1663`) with `expectNoHorizontalScroll`; serial-mode floor note (`mobile.spec.ts:64`); `SERIAL_SPECS` pinned (`playwright.config.ts:31-32`) |

Pins that held unchanged (12): `[lang]/(marketing)/formats/page.tsx:10-45`, `(marketing)/page.tsx:113-129`, `page.tsx:221-226`, `api/funnel/start/route.ts:32-33`, `marketing-shell.tsx:16`, `seazn-qr-image.tsx:71`, `globals.css:787-788`, `lib/messages.ts:12`, `lib/rate-limit.ts:60,96`, `lib/resolve-locale.ts:43`, `lib/seazn-qr.ts:34,69`, `stages.ts:7245`.

### Drift adaptations

None of the plan's pinned files changed in a way that broke a pin. What follows is where the current tree's mechanics differ from what the plan text assumed. Each is adopted, and each keeps the design of record.

- **No DOM in vitest.** There is no React Testing Library and no jsdom (`_hook-harness.tsx:1-21` explains why), so island tests use `renderIsland` and page tests walk the returned element tree or `prerender` it.
- **The share QR is a client-side product.** The logo-carrying QR comes only from `renderSeaznQr`, which fetches and embeds the logo in the browser. A server-computed `seaznQrSvg` would have no embeddable logo (the standing rule is "every QR carries the Seazn logo"). So the island builds the QR on the Share tap, which also keeps the credential out of the server HTML (O3, `sensitive`).
- **A new `[token]` route must take a side in the telemetry scrubber.** `app/q/[token]` reds `scrub-path-secrets.test.ts` until `_route-scan.ts` has a verdict for it, and the verdict holds only once `scrub-score-url.ts` strips `/q/<token>`. That keeps the home credential (O3, C19) out of PostHog and Sentry, as §4 requires. From then on, every element that paints `/q/<token>` carries `ph-no-capture`.
- **`handler` shapes the wire.** Success is enveloped `{ ok, data }`; a zod failure is 400, not 422; the per-IP limiter's 429 has no `code`. Tasks 2 to 4 now state those bodies, and the form maps a code-less 429 to `errors.rateLimited`.
- **Keys feed a generated union.** `i18n:gen-keys` joins `i18n:check` wherever keys are added.
- **Width checks.** A bare `scrollWidth === innerWidth` is blind under the global clip, so the plan uses `expectNoHorizontalScroll`'s method. A dev server is not the e2e target, so the prod server is.
- **The pad has a Confirm card and a soft-commit hold.** The e2e taps Start first, taps the real home-half control (the placeholder test id did not exist), and waits out `HOLD_MS` before leaving.
- **Every Playwright project is signed in as the shared Pro user.** The guest spec clears its storage state.
- **Next 16 `params` is a Promise** in pages and route handlers.

### Notes for plan 1 (names kept as plan 1 writes them; plan 1 not edited)

- Plan 1 is being re-pinned in parallel. Plan 2 consumes these names exactly as plan 1 read on 2026-11-07: `listQuickMatchSports`, `quickMatchPreview`, `QuickMatchSport`, `QuickMatchVariant.knockoutAllowed`, `QuickMatchPreview`, `CreateQuickMatch`, `createQuickMatch`, `mintVisitorKey`, `hashVisitorKey`, `mintHomeToken`, `openHomeToken`, `QUICK_MATCH_VISITOR_COOKIE`, `QUICK_MATCH_VISITOR_COOKIE_MAX_AGE_S`, `resolveQuickMatchToken`, `readQuickMatchHome`, `nextPlayable`, `QuickMatchHome`, `QuickMatchFixture`, `touchQuickMatchActivity`, `ensureGuestDeviceLink`, `systemAuth`, and the codes `QUICK_MATCH_TOO_MANY_ALIVE`, `QUICK_MATCH_FORMAT_NOT_OFFERED`, `QUICK_MATCH_SIDES_UNKNOWN`. A rename there needs the same rename here.
- **Mismatch:** plan 1 declares `QUICK_MATCH_ERRORS.SPORT_NOT_OFFERED` (Task 5), but plan 2 has no copy key and no client mapping for it. If plan 1 throws it, the setup form shows no localized message. One of the plans owes either a `quickMatch.errors.sportNotOffered` key or a fold into `FORMAT_NOT_OFFERED`.
- Plan 1 Task 9's `quick-match-back-link.tsx` paints `/q/<token>`. Once plan 2 Task 5 adds the `q/[token]` verdict, the painter scan applies to it, and plan 2 Task 5 adds `ph-no-capture` if it is missing.
- Plan 1 Task 8's `firstRallyFor` stays a plan-1 vitest helper; plan 2's e2e no longer uses it.
- Task 8 and Review Focus 5 (add a match after every match is played) hold only while plan 1's `createDivision` leaves `auto_progress` at its default `false` (`db/migration/jul3/V249__format_extensions.sql:20`). With it `true`, scoring completes the stage when the last match settles (`scoring.ts:1156-1178`), and `addFixture` then refuses a complete stage (`stages.ts:7279`).

### Observations (plan-internal; not changed)

- Task 10's spec fills sides by `getByLabel("Side 1")`, but Task 1 lists no key for a side input's accessible name. C10 needs one in all four locales, or the spec must select sides another way.
- `SeaznQrImage`'s `alt` is required (`seazn-qr-image.tsx:79`), so Task 7 now takes `labels.qrAlt`. Task 1 lists no such key, and Task 7 adds it if it is absent.

### Blockers

1. **RESOLVED 2026-11-07** (ledger: O9 lifted; e2e by CI dispatch with `--ref`; see Pre-flight amendments E2). Original text: **No allowed way to run the e2e and the width checks.** Task 10's e2e and the Task 4 and Task 5 width checks assume a local production server, and the in-repo `AGENTS.md` permits running a specific spec locally. But the owner's later standing rules, recorded in session memory, send agent e2e to CI (2026-10-19: `gh workflow run e2e.yml --ref <branch> -f pr=<n>`) and bar local web servers (2026-10-24). O9 (no remote, nothing committed) rules out the push a CI dispatch needs, and `e2e.yml` never runs on a PR (`:99-107`). Under O9 plus those rules, no permitted run path exists. Not resolved here: the owner chooses, for example a branch exception to O9, or one local prod-server run under the blank-PostHog recipe.
