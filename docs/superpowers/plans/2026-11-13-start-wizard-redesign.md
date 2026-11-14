# Organiser /start Wizard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `/[lang]/start` as the owner-approved four-step night wizard (B1 Sport → B2 Size and format → B3 Date → B4 Email → A4 Sent) and make the emailed claim actually build what the organiser chose: the format's stages, N seeded entrants and (when given) the courts.

**Architecture:** One pure format layer (`lib/funnel-formats.ts` + `rankFormats` in `lib/format-recommend.ts`) is the single source for the cards' match counts, the Best-fit pick AND the stages the claim builds, so preview and built event cannot disagree. The claim (`lib/funnel.ts` `createFromDraft`) builds through the standard use-cases (`createStages`, `createEntrants`, `createVenue`/`createCourt`) exactly as the quick-match tree does. The wizard's state→POST body lives in a pure model file so it can be driven through the real route and the real claim in one DB test.

**Tech Stack:** Next (repo fork — read `node_modules/next/dist/docs/` before touching page APIs), React client island, zod, postgres.js, vitest (node env), Playwright.

**Spec / authority:** OWNER rulings, `/Users/ashokhein/github/seazn.club/.superpowers/sdd/quick-match-decision-log.md`, the three 2026-11-13 entries starting "OWNER on swr13a01", plus the `/play` link entry. Mockup (layout only, build uses house night theme): `/Users/ashokhein/seazn-artifacts/2026-11-13_start-wizard-redesign_swr13a01/index.html` §2 Option B (B1–B4) and §1 A4 (Sent). Ledger: `/Users/ashokhein/github/seazn.club/.superpowers/sdd/2026-11-13-start-wizard/progress.md`.

## Re-pin log (premises from the scout, re-verified 2026-11-13 on `3ec69fc714`)

| # | Premise | Verdict | Evidence |
|---|---|---|---|
| P1 | `createFromDraft` ignores `payload.format` / `payload.entrants` | **TRUE — measured** | Real draft → consume → `createFromDraft` on DB label `sw`, Badminton, 12 entrants, every format (`league`, `groups-knockout`, `swiss`, `double_elim`, `knockout`, none): each built org `"<name> organisers"` + competition (`status draft`, `visibility private`, `starts_on 2026-12-05`, **`ends_on NULL`**) + one division (`badminton`/`bwf-3x15`, `setup`, no `config.entrants`) and **0 stages, 0 entrants, 0 venues, 0 courts**. Identical rows for every format. |
| P2 | `start/page.tsx:39` reads only sport/entrants/date | TRUE | `searchParams` type at :39. `?sport=` IS read already, but as a display NAME (`"Badminton"`): `/play` keys (`tabletennis`, `boardgame`) would land as unknown strings. `?format=` (The Draw, `the-draw.tsx:113`) is dropped. |
| P3 | courts/hours at `start-wizard.tsx:168-191`, POST body `:66-75` omits them | TRUE in substance; **lines are PR #1208's** | On main: inputs :154-177, POST json :52-61. #1208 adds 14 lines (FUNNEL_SPORTS moved in) → :168-191 / :66-75 there. |
| P4 | `format-recommend.ts:103-108` fallback + `:109 slice(0,3)` drops League | **PARTLY FALSE** | League is dropped only when it does NOT fit: fitting formats sort first by richest `perEntrant`, so League tops the list whenever it fits. At the defaults (16/2/4) it runs over and `slice(0,3)` cuts it. |
| P5 | Best-fit badge unconditional on row 0 (`:209`) | TRUE | main :195 (`i === 0`), #1208 :209. `fits` is computed then `omit`ted (:109), so the UI cannot know. |
| P6 | Copy English-only `:39-77, :97` | TRUE, wider | The console's `components/v2/format-recommend-strip.tsx:78-80` renders the same English `title`/`reason`. |

New findings (not in the brief):

- **N1** Claim writes `ends_on NULL` although `CreateCompetition.ends_on` is mandatory (#376); `createFromDraft` passes `as never`, bypassing the schema.
- **N2** `entrants.per_division.max` on `community` (the free plan a new org gets) = **64** in the migrations' catalog (live catalog may differ — read it, never a literal); the funnel accepts 2–256. A claim that seeds N entrants for N > cap would 402.
- **N3** `ladder` is a `formats.advanced` kind (false on community) → a free claim would 402. `double_elim` is allowed on community.
- **N4** `consumeFunnelDraft` does not return the draft's `locale` column; the claim cannot localise anything it writes.
- **N5** `previewStageDraw` (`server/usecases/stages/preview.ts:289`) clamps n to 2..64.
- **N6** Sports table names: `Badminton, Chess(boardgame), Carrom, Cricket, Football, Hockey, Ice Hockey, Table Tennis, Tennis, Volleyball` (+ `Generic`). `resolveSport` matches `lower(name)`, so Hockey / Ice Hockey resolve already.

## Decisions taken in this plan (PO recs, owner may override)

- **D1 Courts carried, hours planning-only.** Creation supports courts (org-level `venues`/`courts`, `usecases/venues.ts:324,478`, no gate). It does not support "hours": the only home is `court_hours` (clock windows), and the wizard asks a duration, not a time of day — writing invented windows would strand fixtures. So: courts are built only when the organiser opened the Planning fold AND the claiming org has no venue yet (one venue, N courts); hours are never written. The fold says so in copy.
- **D2 Card order fixed** (mock: no reordering under the thumb): League, Groups + knockout, Knockout, Swiss; "More formats" holds **Double elimination only** (ladder dropped, N3). Planning ranks formats by driving the Best-fit badge, the preselection and each card's Fits / Runs over tag — not the order.
- **D3 Honest Best fit:** badge only on the richest fitting format; when nothing fits, no badge and nothing preselected except **League** (always offered, always buildable at n ≥ 2), and Next stays enabled once any card is picked.
- **D4 Entrants:** the claim seeds `min(n, org cap)` name-only entrants of the division's default kind, seeds 1..n, named from the draft's locale ("Player 7" / "Pair 7" / "Team 7"). A format whose minimum n is not met, or a missing/unknown format (old drafts, crafted bodies), builds no stage (today's behaviour) — never a guess.
- **D5 Dates:** `start_date` set ⇒ `ends_on = start_date` (one-day default, editable). No date ⇒ both null as today (owner question Q2).
- **D6 POST compatibility:** body keys stay `email, locale, name, sport, entrants, start_date?, format?` with `sport` = the canonical sports-table NAME; two optional keys are added: `courts?`, `hours?`. An old-shaped body still claims.
- **D7 Events unchanged:** `funnel_draft_created` and `funnel_claimed` keep `{ sport, entrants }`.

## Global Constraints

- Every user-facing string → `en/es/fr/nl`, then `npm run i18n:gen-keys` and `npm run i18n:check` (root). Never hard-coded English.
- Night house look, as `/play` (`mk-funnel-night`, `--mk-night`, `--mk-lime` in `globals.css`); the mock is layout only.
- One DOM, mobile-first. No horizontal page scroll at 320, 768, 1280; e2e enforcement at all seven widths.
- Keep: Turnstile (`useTurnstile("start")`, `requireTurnstile(req,"start")`), `<LegalNotice/>`, both funnel events with the same properties, the dev `claim_url` exposure rule, `/start?sport&entrants&date` prefill.
- No migration (payload is jsonb; venues/courts tables exist).
- Scoped tests only. vitest: `cd apps/web && npx vitest run <paths> --reporter=json --outputFile=<f>`, judge on `numPassedTests/numTotalTests`, confirm `.testResults[].name`, require `EXIT=0`. DB tests: `eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label sw)"` in the same Bash call. Always `cd /Users/ashokhein/github/seazn.club-worktrees/start-wizard` first; `grep -a`.
- TEST-STRATEGY.md: anti-vacuity counts on every sweep; expected values from the engine/dictionaries/sports table, never from the code under test; mutate each new guard once and record the red.
- No PNGs in the repo. Screens go to `~/seazn-artifacts/` and are served on :8765.

## Review Focus

1. **Preview ≠ build.** A card says "23 matches" and the claim builds a different draw → T1's consistency sweep (engine preview vs `rankFormats`) and T2's stage read-back.
2. **n above the free cap** (65–256 on a new org) → T2 `clamps to the live cap`, T4 hint line.
3. **Small n** (2, 3) on Groups + knockout / Swiss → T1 `funnelFormatMin` + T2 "below minimum builds no stage" + T4 disabled card.
4. **Prefill from three producers** (`/play` key `tabletennis`, hero key, The Draw name `Football` + `format=groups-knockout`, garbage) → T3 table test.
5. **Second claim / existing org** (org already has a venue; same email twice) → T2 sequence test: no second venue, second token refused.

---

## Batch plan

| Batch | Tasks | Parallel? | Why safe |
|---|---|---|---|
| A | T1 | — | foundation |
| B | T2 ‖ T3 | yes | T2 = `lib/funnel.ts`, funnel tests, `ui.json`×4, i18n-keys; T3 = new `start/prefill.ts` + test only |
| C | T0 (controller) | — | rebase onto origin/main after #1208 merges; resolve `start-wizard.tsx` (#1208 moved FUNNEL_SPORTS there; T4 replaces it with `lib/funnel-sports.ts`) |
| D | T4 | — | rewrites `start-wizard.tsx`, `page.tsx`, `marketing.json`×4 |
| E | T5 | — | `/play` + hero; shares `marketing.json`/i18n-keys with T4 |
| F | T6 ‖ T7 | yes | `apps/web/e2e/**` vs `scripts/smoke/**` |
| G | T8 | — | screenshots, whole-branch review, PR |

A reviewer pass follows every task before the next batch starts.

---

### Task 0: Rebase onto #1208 (controller)

- [ ] When `gh pr view 1208 --json state` is `MERGED`: `cd <worktree> && git fetch origin && git rebase origin/main`. Conflicts expected only in `start-wizard.tsx` (keep #1208's version at this point; T4 rewrites it) and dictionaries (keep both sides' keys). Re-run `npm run i18n:gen-keys` + `i18n:check`, and the T1–T3 scoped vitest paths. If #1208 is not merged by the end of Batch B, T4 still waits.

---

### Task 1: Pure format layer + funnel sports list

**Files:**
- Create: `apps/web/src/lib/funnel-formats.ts`
- Create: `apps/web/src/lib/funnel-sports.ts`
- Modify: `apps/web/src/lib/format-recommend.ts` (add, do not change `recommendFormats`)
- Test: `apps/web/src/lib/__tests__/funnel-formats.test.ts` (new), `apps/web/src/lib/__tests__/format-gallery.test.ts` (golden stays green, untouched)

**Interfaces — Produces:**
```ts
// funnel-formats.ts (pure; imports format-templates.ts only)
export const FUNNEL_FORMATS = ["league", "groups-knockout", "knockout", "swiss"] as const;
export const FUNNEL_MORE_FORMATS = ["double_elim"] as const;
export type FunnelFormat = (typeof FUNNEL_FORMATS)[number] | (typeof FUNNEL_MORE_FORMATS)[number];
export function isFunnelFormat(x: unknown): x is FunnelFormat;
export function funnelFormatMin(f: FunnelFormat): number;            // smallest n the claim can build
export function funnelFormatKnobs(f: FunnelFormat, n: number): TemplateKnobs;
export function funnelFormatStages(f: FunnelFormat, n: number): StageDraft[]; // buildTemplateStages(templateKey, knobs)
// format-recommend.ts
export interface RankedFormat { slug: FunnelFormat; matches: number; estHours: number; perEntrant: number; fits: boolean; available: boolean }
export function rankFormats(input: RecommendInput): RankedFormat[];  // every FUNNEL_FORMATS then FUNNEL_MORE_FORMATS, fixed order
export function bestFitSlug(ranked: readonly RankedFormat[]): FunnelFormat | null;
// funnel-sports.ts (pure)
export interface FunnelSport { key: string; name: string } // name = sports-table name, the POST `sport` value
export const FUNNEL_SPORTS: readonly FunnelSport[];         // mock B1 order + { key: "other", name: "Other" }
export function funnelSportByKeyOrName(raw: string): FunnelSport | null; // case-insensitive on both
```

Values pinned: template keys `league→league`, `groups-knockout→groups_ko`, `knockout→knockout`, `swiss→swiss`, `double_elim→double_elim`. Groups knobs: `poolCount = clamp(max(2, ceil(n/4)), FORMAT_BOUNDS.pools)`, `qualified = clamp(2*poolCount, FORMAT_BOUNDS.qualify)` and ≤ n; legs 1. Swiss rounds: `min(ceilLog2(n)+1, FORMAT_BOUNDS.swissRounds.max)` — **re-pin the engine's swiss round bound against n first** (`assertSwissRoundsDeclared`, `usecases/stages/stage-graph.ts:301`, and the engine validator) and cap by it; record the bound in the ledger. Mins: League 2, Knockout 2, Groups + knockout 4 (two pools of two; C38 refuses a pool of one), Swiss and Double elimination = whatever the engine/`stageGraphSizeGate` refuses below (re-pin, don't guess). `available = n >= funnelFormatMin(slug)`. `matches` for each slug MUST be computed from the same knobs (`funnelFormatKnobs`), not a separate model; `fits = available && matches <= capacity`. FUNNEL_SPORTS order (mock B1): badminton, boardgame "Chess", carrom, football, hockey, icehockey "Ice Hockey", tabletennis "Table Tennis", tennis, volleyball, cricket, other.

- [ ] **Step 1: Failing tests** in `funnel-formats.test.ts`:
  - `"League is always offered and available at every n 2..256"` — `rankFormats` at (n, courts 1..4, hours 1..8) always contains `league` with `available: true`; report checked count, expect > 0.
  - `"no badge when nothing fits"` — `bestFitSlug(rankFormats({entrants: 40, courts: 2, hours: 4}))` is `null`; and `{12, 4, 6}` → `"swiss"` or whichever the rulebook "richest per entrant among fits" picks — compute the expected from the mock's A2 numbers (12/4/6: League runs over, Groups+KO/Knockout/Swiss fit → richest perEntrant = Swiss 5) → `"swiss"`.
  - `"a format that runs over never wins"` — over n 2..64 × courts 1..4 × hours 1..8: the winner (when non-null) has `fits && available`; count checked.
  - `"card counts equal the engine's own draw"` — for n 2..64 (preview clamps at 64, N5): `league`, `knockout`, `double_elim` → `previewStageDraw(funnelFormatStages(slug,n)[0], n).length === matches`; `groups-knockout` → group-stage preview length + (qualified − 1); `swiss` → rounds × floor(n/2). Import `previewStageDraw` from `@/server/usecases/stages/preview` (test-only). Report counts per slug; each > 0.
  - `"fixed display order"` — slugs equal `[...FUNNEL_FORMATS, ...FUNNEL_MORE_FORMATS]` for every input.
  - `"every funnel sport but Other names a real sport"` — each `FUNNEL_SPORTS` entry except `other` has `key` in `builtinModules` (`@seazn/engine/sports`) and its `name` equals the module's display name the sync writes (read from `builtinModules`, not typed); count = FUNNEL_SPORTS.length − 1.
  - `funnelSportByKeyOrName`: `"tabletennis"`, `"Table Tennis"`, `"table tennis"`, `"boardgame"`, `"Chess"` resolve; `""`, `"quidditch"`, `"<script>"` → null.
- [ ] **Step 2:** Run; expect FAIL (module not found).
- [ ] **Step 3:** Implement the three exports blocks above. `recommendFormats` and its golden (`format-gallery.test.ts:154`) stay as they are.
- [ ] **Step 4:** Run `funnel-formats.test.ts` + `format-gallery.test.ts`; all pass, EXIT=0.
- [ ] **Step 5: Mutate once:** make `fits` ignore `available` → the "runs over never wins" or small-n case must red; restore. Record in ledger.
- [ ] **Step 6: Commit** `feat(start): one format layer for the funnel's cards and its claim`.

---

### Task 2: The claim builds the chosen format, entrants and courts

**Files:**
- Modify: `apps/web/src/lib/funnel.ts` (schema :20-28, `consumeFunnelDraft` :61-77, `createFromDraft` :110-137; add `funnelEntrantCap`)
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` (claim copy), regenerate `apps/web/src/lib/i18n-keys.ts`
- Test: `apps/web/src/lib/__tests__/funnel.test.ts` (keep all existing cases green), new `apps/web/src/lib/__tests__/funnel-claim-build.test.ts` (DB), `apps/web/src/app/api/funnel/start/__tests__/funnel-claim-outbox.test.ts` (one new bad-email case)

**Interfaces:**
- Consumes: T1 `isFunnelFormat`, `funnelFormatMin`, `funnelFormatStages`.
- Produces:
```ts
funnelPayloadSchema // + courts: z.number().int().min(1).max(32).optional(), hours: z.number().int().min(1).max(72).optional()
interface FunnelDraft { id; email; payload; locale: Locale | null }   // locale added
export async function funnelEntrantCap(planKey?: "community"): Promise<number | null>; // live plan_entitlements read
createFromDraft(userId, draft) // same signature and return
```
UI keys (ui.json): `funnel.claim.entrant.individual` "Player {n}", `funnel.claim.entrant.pair` "Pair {n}", `funnel.claim.entrant.team` "Team {n}", `funnel.claim.venue` "Main venue", `funnel.claim.court` "Court {n}".

Build order inside `createFromDraft` (each a standard use-case, as `quick-match-create.ts:168-182`): competition (`ends_on = start_date` when set, D5) → division → if `isFunnelFormat(format) && n >= funnelFormatMin(format)`: `createStages(auth, division.id, funnelFormatStages(format, n).map((s, i) => ({ seq: i + 1, ...s })))` → `createEntrants(auth, division.id, …)` with `count = min(n, await getLimit(org.id, "entrants.per_division.max", competition.id) ?? n)`, kind = the division's effective default kind (as `usecases/entrants.ts:454`), `seed: i+1`, name from the draft's locale (fallback `en`) → if `payload.courts` and the org has no active venue: `createVenue` + `createCourt` × courts. Hours: never written (D1). Clamping logs `funnel_claim_entrants_clamped` with requested/cap.

- [ ] **Step 1: Failing DB tests** in `funnel-claim-build.test.ts` (pattern: `funnel.test.ts` — `describe.skipIf(!HAS_DB)`, `afterAll` ends the pool):
  - `"each format builds its own stage graph"` — for every `[...FUNNEL_FORMATS, ...FUNNEL_MORE_FORMATS]` at n = 12: read `stages` back ordered by `seq`; expected kinds from the rulebook table typed in the test (`league→[league]`, `groups-knockout→[group, knockout]`, `knockout→[knockout]`, `swiss→[swiss]`, `double_elim→[double_elim]`), and `detectTemplate(readBack)` equals the template key; count = 5.
  - `"entrants: n seeded name-only rows of the sport's default kind, every funnel sport"` — for each `FUNNEL_SPORTS` entry (Other included → generic) with `format: "league"`, n = 6: 6 entrants, seeds exactly 1..6, kind = `effectiveEntrantModel(module.entrantModel, null).defaultKind` from `builtinModules` (generic: its declared default), no members. Count = FUNNEL_SPORTS.length.
  - `"placeholder names follow the draft's language"` — for each LOCALE: names equal the locale's `ui.json` `funnel.claim.entrant.<kind>` with `{n}` filled (read the dictionary file, not the code). Count = LOCALES.length.
  - `"above the plan cap seeds the cap"` — n = cap + 1 where `cap = await getLimit(orgId, "entrants.per_division.max")` on a fresh community org; skip-with-fail if cap null or > 255 (anti-vacuity: assert `cap < 256` as a premise).
  - `"below a format's minimum builds no stage"` — `groups-knockout` at n = 3: 0 stages, 3 entrants.
  - `"no or unknown format builds no stage"` — `format` absent and `format: "round_robin_xl"`: 0 stages, n entrants. (Old drafts keep claiming.)
  - `"planning courts build one venue with N courts; hours write nothing"` — courts 3, hours 5: 1 venue, 3 courts named `Court 1..3` (dictionary), `court_hours` rows for the org = 0.
  - `"no planning inputs build no venue"` — 0 venues, 0 courts.
  - `"sequence: second claim on the same org"` — first claim with courts 2, second draft same email with courts 4: still 1 venue, 2 courts; second competition has its own stages/entrants; consuming the first token again → null.
  - `"a date sets ends_on to the same day; none leaves both null"`.
  - `"model body → real route → real claim"` — POST the body produced by T4's `buildFunnelBody` … **this case is owned by T4** (seam test); T2 adds the route-level case only: in `funnel-claim-outbox.test.ts`, `"a body with courts and hours is accepted and stored"` and `"a bad email is a 400 and stores no draft"` (`"sam@harbourvale"`; assert 0 `funnel_drafts` rows for it).
- [ ] **Step 2:** Run (DB `sw`); expect FAIL on every new case.
- [ ] **Step 3:** Implement per the Interfaces block; add the ui.json keys in 4 locales; `npm run i18n:gen-keys`.
- [ ] **Step 4:** Run `funnel-claim-build.test.ts`, `funnel.test.ts`, `funnel-claim-outbox.test.ts`, `src/app/api/funnel/remind/__tests__/route.test.ts`; `npm run i18n:check`; all green, EXIT=0, names confirmed.
- [ ] **Step 5: Mutate once each:** (a) drop the `n >= funnelFormatMin` guard → "below minimum" reds; (b) drop the no-venue check → "second claim" reds; (c) drop the cap clamp → "above the plan cap" reds (402). Record.
- [ ] **Step 6: Commit** `fix(funnel): the claim builds the chosen format, its entrants and courts`.

---

### Task 3: /start prefill parser

**Files:**
- Create: `apps/web/src/app/[lang]/(marketing)/start/prefill.ts`
- Test: `apps/web/src/app/[lang]/(marketing)/start/__tests__/prefill.test.ts`

**Interfaces — Produces:**
```ts
export interface StartPrefill { sportKey: string | null; entrants: number | null; date: string | null; format: FunnelFormat | null }
export function parseStartPrefill(sp: Record<string, string | string[] | undefined>, today: string /* YYYY-MM-DD */): StartPrefill;
```
Rules: first value of a repeated param; `sport` via `funnelSportByKeyOrName` (key or name) → its key; `entrants` integer 2..256 else null (never clamped silently); `date` ISO `YYYY-MM-DD`, real calendar day, ≥ `today`, else null; `format` via `isFunnelFormat`.

- [ ] **Step 1: Failing table test** `"every producer's link prefills"`: `/play` `?sport=tabletennis`, hero `?sport=icehockey`, The Draw `?sport=Football&entrants=16&format=groups-knockout`, legacy `?sport=Badminton&entrants=8&date=<today+3>`; and garbage rows: `sport=quidditch`, `entrants=1`, `entrants=257`, `entrants=12abc`, `date=2026-02-30`, `date=<yesterday>`, `format=ladder`, arrays. Count rows; expect the declared count.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS, EXIT=0.
- [ ] **Step 5: Mutate:** accept past dates → red. **Step 6: Commit** `feat(start): one parser for every link into /start`.

---

### Task 4: The stepped night wizard and page

Read the mock §2 (B1–B4) and §1 A4 first; load `frontend-design` skill. Read `node_modules/next/dist/docs/` for `searchParams` in this Next version.

**Files:**
- Create: `apps/web/src/components/start-wizard-model.ts` (pure)
- Modify (rewrite): `apps/web/src/components/start-wizard.tsx`
- Modify: `apps/web/src/app/[lang]/(marketing)/start/page.tsx` (night shell; `parseStartPrefill`; `funnelEntrantCap()` → prop)
- Modify: `apps/web/src/components/v2/format-recommend-strip.tsx` (render `format.card.*` keys instead of English `title`/`reason`; P6) and `format-recommend.ts` `recommendFormats` drops `title`/`reason` (update `format-gallery.test.ts` golden to slugs only)
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/marketing.json` (wizard copy) and `ui.json` (format card copy shared with the strip); regenerate i18n-keys
- Test: new `apps/web/src/components/__tests__/start-wizard-model.test.ts`; update `start-wizard-i18n.test.tsx`, `src/app/[lang]/(marketing)/start/__tests__/page-legal-notice-i18n.test.tsx`; new DB seam case in `apps/web/src/lib/__tests__/funnel-claim-build.test.ts` (append only)

**Interfaces:**
- Consumes: T1 `rankFormats`, `bestFitSlug`, `FUNNEL_SPORTS`, `funnelFormatMin`; T2 `funnelEntrantCap`, schema keys; T3 `parseStartPrefill`.
- Produces:
```ts
// start-wizard-model.ts
export type WizardStep = "sport" | "size" | "date" | "email" | "sent";
export interface WizardState { step: WizardStep; sportKey: string; name: string; entrants: number; planningOpen: boolean; courts: number; hours: number; format: FunnelFormat | null; date: string | null; email: string }
export function initialWizardState(p: StartPrefill): WizardState; // sport badminton, 16, courts 2, hours 4; format = prefill ?? bestFitSlug ?? null
export function nextEventDays(today: string): string[];             // the three chips: next Sat, next Sun, the Sat after (mock B3)
export function canAdvance(s: WizardState): boolean;                 // size needs an available format; email needs a plausible address
export function buildFunnelBody(s: WizardState, locale: Locale, defaultName: string): Record<string, unknown>;
// keys ⊆ {email, locale, name, sport, entrants, start_date, format, courts, hours}; sport = FUNNEL_SPORTS name; courts/hours only when planningOpen
export function plausibleEmail(v: string): "ok" | "missingTld" | "invalid";
// start-wizard.tsx
export function StartWizard(props: { initial: StartPrefill; maxEntrants: number | null; today: string }): JSX.Element;
```
Screens: B1 sport chips (radiogroup, all `FUNNEL_SPORTS`, localized via the `ui` `sport.<key>` names — re-pin the key family `/play` uses) + optional name; B2 size stepper (2–256, a hint line when n > `maxEntrants`: "Free events hold up to {cap} per division; we'll add {cap} now"), Planning fold "Courts and time" (courts 1–32, hours 1–72; copy says courts are added to your venue and hours only shape the estimate — D1), four fixed cards + "More formats" (Double elimination) each with matches · ≈h, Fits / Runs over tag, Best fit on `bestFitSlug` only, unavailable cards disabled with "Needs at least {min}"; B3 date chips + "Pick a date…" (native date input, min today) + "Not sure yet"; B4 summary (sport, players, format · matches, first day) + email + Turnstile + LegalNotice + Back/Send; A4 Sent: the same summary, "Wrong address? Change it" (returns to B4 keeping state), "While you wait: score a quick match →" `/[lang]/play?sport=<key>` (quick-match sports only; hide when the sport is not offered — read the offer the way `/play` does). Desktop ≥ md: answers rail on the left (mock B1 desktop); phone: progress bar "Step n of 4". Keep `data-start-wizard`, `data-funnel-done`, `data-claim-url`; add `data-step="<WizardStep>"`.

- [ ] **Step 1: Failing unit tests** (`start-wizard-model.test.ts`):
  - `"the body is POST-compatible"` — keys ⊆ the allowed set; with planning closed no `courts`/`hours`; `sport` is the sports-table name for every FUNNEL_SPORTS entry (count); passes `funnelPayloadSchema.extend({email, locale})` parse (import the schema, not a copy).
  - `"preselection is honest"` — 40/2/4 → `format` null; 12/4/6 → `"swiss"` (mock A2); prefilled `format` wins when available, ignored when below min.
  - `"canAdvance at size"` false with null format, false with an unavailable format, true with League at n=2.
  - `nextEventDays` returns the next Saturday and Sunday strictly after today, then the Saturday after: `("2026-11-13")` (Fri) → `["2026-11-14","2026-11-15","2026-11-21"]`; `("2026-11-14")` (Sat) → `["2026-11-21","2026-11-22","2026-11-28"]`. Add a Sunday row and a year-end row (`"2026-12-30"`).
  - `plausibleEmail("sam@harbourvale")` → `"missingTld"` (mock A3 copy), `"x"` → invalid, `"sam@harbourvale.org"` → ok.
- [ ] **Step 2: Failing seam test** (append to `funnel-claim-build.test.ts`): `"the wizard's own body, through the real route, builds what the summary says"` — for each FUNNEL format: `buildFunnelBody(state)` → `POST` from `src/app/api/funnel/start/route.ts` (harness as `funnel-claim-outbox.test.ts:13-47`) → read the draft → `consumeFunnelDraft` → `createFromDraft` → stage kinds equal the T2 rulebook table and entrant count equals `state.entrants`; one case with planning open asserts courts. Count = 5.
- [ ] **Step 3:** Run → FAIL. **Step 4:** Implement model, component, page, copy (4 locales), strip keys; `npm run i18n:gen-keys`.
- [ ] **Step 5:** Run the model test, the seam test, `start-wizard-i18n.test.tsx`, `page-legal-notice-i18n.test.tsx`, `format-gallery.test.ts`, `src/components/__tests__/turnstile-surfaces-wiring.test.tsx`, `src/lib/__tests__/scrub-request-body.test.ts`; `npm run i18n:check`; scoped `tsc` via `seazn-env.sh gate --label sw` (judge on the `Cached:` line). EXIT=0.
- [ ] **Step 6: Mutate:** remove the `planningOpen` condition in `buildFunnelBody` → POST-compat test reds; badge on row 0 → preselection test reds. Record.
- [ ] **Step 7: Drive it.** `seazn-env.sh up --label sw --server`; walk B1→A4 at 390 and 1280 in a browser in `en` and `es`, claim via the dev link, open the division: stage tab shows the picked format, entrants tab shows N rows. Write what you saw in the ledger.
- [ ] **Step 8: Commit** `feat(start): stepped night wizard (B1–B4, Sent), honest best fit, cards in four languages`.

---

### Task 5: The two doors carry the sport

**Files:**
- Modify: `apps/web/src/components/quick-match/setup-form.tsx` (under `qm-start-bar`, ~:529-580 on main — re-pin after T0)
- Modify: hero organiser link (post-#1208: `apps/web/src/app/[lang]/(marketing)/page.tsx` and/or `components/marketing/quick-match-cta.tsx` — re-pin where `href="/<lang>/start"` is rendered)
- Modify: `marketing.json` ×4 (`quickMatch.setup.registerSeason`), i18n-keys
- Test: `apps/web/src/app/[lang]/(marketing)/__tests__/play-page.test.tsx`, `home-quick-match-cta.test.tsx` (both from #1208)

Behaviour: `/play` shows a quiet link `data-testid="qm-register-season"` "Or register to start a season →" under the Start bar, `href=/<lang>/start?sport=<currently chosen sport key>`, updating as the chip changes; server HTML carries the default sport so no-JS works. Must not sit inside the sticky bar's height budget on phones (the bar is ≤ its current height; link goes below the zone at max-sm, in flow). Hero: the organiser link's `href` follows the Sport select (`/<lang>/start?sport=<key>`); no-JS keeps the plain `/<lang>/start`.

- [ ] **Step 1: Failing tests:** play-page — the link exists once, `href="/en/start?sport=<first offered key>"` (anchor on `="`), text from the dictionary in each locale (count 4); hero — link `href` anchored `="/en/start` present.
- [ ] **Step 2:** FAIL. **Step 3:** Implement + copy ×4 + gen-keys. **Step 4:** PASS + `i18n:check`, EXIT=0.
- [ ] **Step 5: Mutate:** hard-code `badminton` in the href → a test choosing another default must red (if none can, add one). **Step 6: Commit** `feat(play): a quiet way from a quick match to a season`.

---

### Task 6: e2e — funnel spec, seven widths, walkthrough

**Files:**
- Modify: `apps/web/e2e/funnel.spec.ts` (selectors at :67-99 are today's three-step wizard and WILL red: "Recommend a format", "Looks right", "Best fit", "Email me the link")
- Modify: `apps/web/e2e/mobile.spec.ts` (add `/en/start` to "public surfaces: no horizontal scroll" ~:1729, plus a new test walking `data-step` sport→size(planning open)→date→email→sent with `overflowingIn` at each, and the `/play` register link)
- Modify: `apps/web/e2e/walkthrough/quick-match.spec.ts` (append one leg)

Cases:
- funnel.spec `"wizard → claim → the division has the chosen format and entrants"`: `/en/start?sport=football` opens on Football; 12 players; open Planning, courts 4, hours 6; pick Groups + knockout; Sat chip; email; dev claim link; land; assert Stages tab shows group + knockout and Entrants tab shows 12 rows, Venues shows 4 courts. Keep the French-email and reminder tests green.
- funnel.spec `"nothing fits: no Best fit, League still offered"` (40 players default planning).
- funnel.spec `"a bad address is refused in place"` (`sam@harbourvale` → the missing-ending line, no request sent: count POSTs = 0).
- mobile.spec as above, all seven projects; scrolling chip rails need `tabindex="0"` + role + name (AGENTS.md #23).
- walkthrough leg: `/en/play` → choose Tennis → "Or register to start a season" → `/en/start?sport=tennis` B1 shows Tennis selected → League → Not sure yet → email → claim → League stage + N entrants.

- [ ] **Step 1:** Write cases. **Step 2:** prod build on label `sw` (`seazn-env.sh up --label sw --server`), run **whole files**: `funnel.spec.ts` (parallel project), `mobile.spec.ts` at `mobile-320` and `tablet-768`, the walkthrough file; all green; serial file → treat count as a floor, re-run after any fix. **Step 3:** Dispatch CI e2e for all seven widths: `gh workflow run e2e.yml --ref feat/start-wizard-redesign` (memory: always `--ref`); hand back with the run id rather than idling. **Step 4: Commit** `test(start): funnel, seven widths and the play→season walkthrough`.

---

### Task 7: Smoke

**Files:** `scripts/smoke/suites/funnel.ts`, `scripts/smoke/suites/marketing.ts`

- [ ] **Step 1:** funnel suite: keep the old-shaped body case (POST compat) and assert its claim still lands; add a second start with `format: "knockout", entrants: 8, courts: 2, hours: 3`, claim, and (DB present) assert 1 knockout stage, 8 entrants, 2 courts, 0 `court_hours` rows. marketing suite: `/en/play` HTML has `href="/en/start?sport=`; `/en/start?sport=tabletennis` renders with `data-start-wizard`.
- [ ] **Step 2:** Run the funnel + marketing suites only against label `sw` server; every check passes; paste the pass/fail counters. **Step 3: Commit** `test(smoke): the funnel claim builds what was chosen`.

---

### Task 8: Sign-off, review, PR

- [ ] Capture B1, B2 (planning closed / open / nothing-fits / n above cap), B3, B4 (bad email), A4, `/play` link, Spanish B2 — at 320, 768, 1280 → `~/seazn-artifacts/2026-11-13_start-wizard-build_<id>/` with an index page on `:8765`; confirm files exist and differ (AGENTS.md #10). No PNGs in the repo.
- [ ] Control-set diff 320 vs 1280 from the live DOM (same controls, same order) — rail is the one desktop-only addition.
- [ ] Whole-branch reviewer pass; fix round; then push, open PR (one PR), read ALL checks before any merge command; e2e dispatched with `--ref`.
- [ ] Ledger: per-screen verdicts owed from the owner; nothing merges without them.

---

## Owner-only questions

- **Q1 Size above the free cap (64 today):** rec = keep 2–256 (mock), show the "we'll add {cap} now" line, seed up to the claiming org's live cap (a Pro org gets all). Alternative: stepper max = the cap.
- **Q2 No date chosen:** rec = leave `starts_on`/`ends_on` null as today (residual against #376's mandatory end date; fixing it needs a date we don't have). Alternative: make B3 required.
- **Q3 "More formats":** rec = Double elimination only; drop Ladder (Pro-gated → a free claim would 402).
