# seazn streaming programme — design of record

OBS overlay (Tier A) · phone-to-cloud relay with credits (Tier B) · theme
design and visual gate (T1) · bench spike (R0)

## 0. Status and supersession

- Owner-approved in chat 2026-09-07 (shape "1", decisions "all ok" with A and C
  refined, credits "go", T1 wave "Ok", design batches 1 and 2 "Ok").
- **Supersedes `2026-09-05-stream-overlay-design.md`.** Tier A is carried IN
  here, rewritten with every correction folded. The 09-05 file stays on disk
  with a superseded header because the design canvas and the owner's approval
  record point at it.
- Corpus directory unchanged: `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/`
  (`_INDEX.md` decision log, `_RULES.md` R1–R17 and the eight merge gates,
  `_THEMES.md` binding values, `_OPEN-QUESTIONS.md`, `_STATE.md`, the W1/W2
  prompts). Plans: `docs/superpowers/plans/2026-09-05-stream-overlay-w1.md`
  (W1, executes as corrected by this design), `…-w2-moments.md` (W2), and the
  per-wave prompt + plan pairs §11 lists (prompts for every wave now, plans
  one wave ahead of execution — owner ruling 2026-09-07).
- Canvas: https://claude.ai/code/artifact/2aebcbde-28ba-45ff-9028-1151873e4901
  (artboards "A · Broadcast bar", "B · Corner bug", "A across sports", "B across
  sports", "Moments", "How fans see it on a phone", "What the club sets up",
  "Organiser console: Stream this match", "Same panel at 390"). T1a adds its
  artboards to the same canvas.
- Branch `feat/stream-overlay`, worktree `.claude/worktrees/stream-overlay`,
  rebased 2026-09-07 onto `main` at `fb99bbd4c` (clean, 24 docs-only commits).
- The two working documents this design consolidates
  (`~/Downloads/2026-09-06-streaming-programme-design.md` and
  `…-implementation-plan.md`, 2026-09-06) are rationale only from today. Where
  this design and either of them differ, this design wins.

**Fact classes** on load-bearing claims: [A] standards · [B] vendor, web-verified
2026-09-06 · [C] programme documents (re-pin before edit) · [D] estimate that
R0 replaces · [E] repo-verified, with the commit: `fb99bbd4c` = this session's
scout on `main` 2026-09-07; `ac85c70` = the 2026-09-06 consolidation's scout,
carried and re-pinned at plan Task 0. The standing rule applies to every
`path:line`: re-pin before building on it.

## 1. Goal, tiers, the invariant, the DAG

A club's match reaches YouTube, Facebook, Twitch or Kick with the seazn
scorebug in the sport's own colours, with the scorer doing nothing new.

| Tier | Who provides the picture | Who composites | Cost to seazn | Gate |
|---|---|---|---|---|
| **A — OBS overlay** | club's laptop and camera | OBS, locally, from `/overlay/fixtures/[id]` | £0 | `streaming.overlay` (Pro) |
| **B — phone relay** | a phone pushing SRT | a Fly Machine running the SAME overlay route over the video, or none (passthrough) | ≈ £0.2–0.9 per 3 h [D] | `streaming.relay` + one credit per match |
| C — embed hand-off | the destination player on our match page | n/a | n/a | own spec later; owns the spoiler problem |

Market reference: CricHeroes sells a cricket-only OBS ticker. Tier A matches
it for eleven sports; Tier B removes even the laptop.

> **The one invariant.** Every pixel of score graphics on every tier is
> rendered by `/overlay/fixtures/[id]` and its theme registry. The cloud
> compositor is a customer of that route, never a second renderer. A theme,
> a W2 moment, a PR3 sponsor logo lands once and appears everywhere.

```
                     ┌──────── seazn app (Fly, lhr, Next standalone) ──────────────┐
scorer pad ─ ledger  │ overlay endpoint (foldFixture) ─ useLiveFixture ─ OverlayStage│
(score_events)       │ sessions API · credits ledger · cron sweep · organiser panel │
                     └──────────────┬─────────────────────────────┬────────────────┘
TIER A  OBS Browser Source loads the overlay URL, composites locally ───────────► destination
TIER B  phone (SRT) ► Cloudflare Stream live input ┬ passthrough: simulcast output ─► destination
                                                   └ composed: Fly Machine pulls (WHEP) ► relay page
                                                     <video> under OverlayStage ► x11grab ► x264 ► RTMPS
```

**Programme DAG** (owner-approved 2026-09-07):

```
W1-A data path ─┐
W1-B schema     ─┼─► W1-C overlay surface ─► W1-D console + link ─► W1-E acceptance = PR1
T1 themes+gate  ─┘        │
                          ├─► W2 moments (PR2) — only after feat/spectator-surface W1 merges
                          ├─► R1 relay core + credits + Phone tab (PR-R1) ─► R2 compositor + relay page (PR-R2)
                          └─► PR3 sponsor logos — LAST, by ruling, after its artboard
R0 bench spike — parallel from now, no repo dependency; its memo gates R2
R3 native capture apps — own spec in the `seazn-capture` repo; only the QR contract (§7.6) is fixed here
Tier C — own spec; receives §9's latency numbers
```

## 2. As-built atlas [E]

The live path today, from `main` at `fb99bbd4c` unless marked `ac85c70`.

```
POST /api/v1/fixtures/[id]/events ─► scoreEvent (server/usecases/scoring.ts:81 ac85c70)
  ├ append score_events (V216: fixture_id, seq, type, payload, voids_event_id; unique(fixture_id, seq))
  ├ fold → snapshot → match_states (summary, last_seq)      ← the public view's join
  ├ void publishFixtureUpdate(id,"event")   scoring.ts:139 ac85c70 → lib/realtime.ts:9
  │   REST POST ${SUPABASE_URL}/realtime/v1/api/broadcast, topic `fixture:{id}`,
  │   event `state_changed`, payload { v, reason, at } — NO body, NO event type; warn-only, fire-and-forget
  ├ publishDivisionUpdate(division_id,"score")  :143 ac85c70 → topic `division:{id}`
  └ fireDivisionRevalidate(divId, compId?)  server/public-site/revalidate.ts:14
      revalidateTag + broadcastRevalidate + purgeCdn, all fire-and-forget

client: fetchPublicRealtimeToken → /realtime-token (403 unless org holds `realtime`;
  producers exempt by doctrine) → mintPublicFixtureToken (lib/realtime.ts:91, jose HS256
  over SUPABASE_JWT_SECRET :95, claims {role:"authenticated", sub:`public:{id}`, fixture_id})
  → private channel → on state_changed → 250 ms debounce → refresh()
  → GET /api/v1/public/fixtures/[id] → publicFixture (usecases/public.ts:279 ac85c70) ← public_fixtures_v
poll fallback: POLL_MS = 15_000 (components/public-site/live-score.tsx:29); poll effect :113-117;
  `live` INCLUDES `scheduled` (:69) so the pre-match state self-updates.
```

Facts the design stands on, each verified this session unless marked:

| Fact | Where | Class |
|---|---|---|
| `foldFixture(tx: Tx, fixtureId: string)` returns the module's whole state over the fine stream; config through ONE authority `resolveFixtureCfg(fixture.config_snapshot, division.config, stage.config)` | `apps/web/src/server/engine-db/fold.ts:58` (return at `:130`) | E fb99bbd4c |
| Football state carries `phase`, `periods`, `asOf`; `footballPosition(state)` | `packages/engine/src/sports/football/football.ts:566,570,599,730` | E ac85c70 |
| Cricket innings state carries `legalBalls`, `ballsLimit` | `packages/engine/src/sports/cricket/cricket.ts:436,440` | E ac85c70 |
| `grep -arn coarsen apps/web/src` returns zero — the web app never coarsens; the dual-fidelity conformance property is nowhere near this path | tree | E ac85c70 |
| `resolveVenueTz(divisionTz, orgTz)`; division tz = `schedule_settings.tz`, idiom `coalesce(ss.tz, o.timezone,'UTC')` | `apps/web/src/lib/tz.ts:44`; `officials.ts:707-711` | E fb99bbd4c / ac85c70 |
| The five derivations are already a shared module | `apps/web/src/lib/public-site.ts:290 setBreakdown, :319 periodBreakdown, :338 matchStrength, :352 disciplineList, :373 servingSide` | E fb99bbd4c |
| Seven sport tokens `board, board-2, ink, led, advisory, caution, dismissal`; `SPORT_TONES` | `apps/web/src/components/v2/scorepad/v3/sport-theme.ts:77` and `:87`; root values `app/globals.css:1014-1022` (advisory `#16a34a`, caution `#d97706`, dismissal `#dc2626`, LED `#9ae600`) | E fb99bbd4c |
| `barlowCondensed` declared with `weight: ["600", "700"]` — **800 absent** | `apps/web/src/lib/fonts.ts:7-9` | E fb99bbd4c |
| Run-sheet row exists; edit-time control at `data-testid="run-sheet-edit-time"` | `apps/web/src/components/v2/desk/run-sheet-row.tsx:377` | E fb99bbd4c |
| Competition desk W2 (the fixtures tab as a run sheet) MERGED as PR #725; **desk W3 is in flight** on `feat/competition-desk-w3-band-and-phone` (worktree `desk-w3`) and is the live contention on `run-sheet-row.tsx` | `git log main`; `git worktree list` | E fb99bbd4c |
| Spectator W1 NOT merged: no spectator surface under `apps/web/src`; branch `feat/spectator-surface` at `2f3b4f9f4` (worktree `spectator`, locked) | grep; worktree list | E fb99bbd4c |
| Cookie consent is mounted unconditionally in the root layout and gated by `localStorage` only — **there is no pathname or route-key mechanism** | `apps/web/src/components/cookie-consent.tsx:34,66`; `app/layout.tsx:68` | E fb99bbd4c |
| Deltas run to **`V399__stats_player_career_split.sql`**; next free is V400 | `ls db/migration/deltas` | E fb99bbd4c |
| Entitlement plans in the v18 catalogue: `community, pro, event_pass, event_pass_l, enterprise` (`pro_plus` retired and dropped at L145); catalogue is the `plan_entitlements` table, resolver "bool requires true; no row denies" | `db/migration/deltas/V393__entitlements_v18.sql` | E fb99bbd4c |
| `ENTITLEMENT_DOMAINS` is code; a key left out is unadvertised on /pricing | `apps/web/src/lib/entitlement-domains.ts:7` | E fb99bbd4c |
| `org_entitlement_overrides` exists (V101, admin tools V266); **no add-on SKU concept exists in v18** | `db/migration/deltas/V101__billing.sql:66`, `V266__admin_plan_tools.sql:11` | E fb99bbd4c |
| Inline paywall card `UpgradeGate` with plan / pass CTA hrefs; one-off Stripe Checkout precedents `POST /api/billing/pass-checkout` and `server/usecases/size-pack-checkout.ts:69` (`getStripe().checkout.sessions.create`) | `apps/web/src/components/upgrade-gate.tsx:252,307,438` | E fb99bbd4c |
| Cron guard order: **503 when `CRON_SECRET` is unset, then 401 on a bad `x-cron-secret`**; one idempotent row-locked usecase; driven by an Actions-cron workflow | `apps/web/src/app/api/cron/registrations/route.ts:13-16` | E fb99bbd4c |
| Route conventions: `v1()` / `handler()` (`lib/http.ts:69`), `parseBody`, zod schemas at `server/api-v1/schemas.ts`, `requireResourceAuth(req, kind, id, scope)` at `server/api-v1/auth.ts:352`; OpenAPI `ROUTES` hand-maintained (`server/api-v1/openapi.ts:57`), generator `scripts/openapi-gen.ts`, CI drift step `ci.yml` | E ac85c70 |
| Client `api()` already unwraps `data` — the documented double-unwrap live bug | `live-score-data.ts:1-4` | E ac85c70 |
| `apps/web/playwright.config.ts:119` `const WALKTHROUGH = /[\\/]e2e[\\/]walkthrough[\\/]/;` (the file is at `apps/web/`, not `apps/web/e2e/`); `WALKTHROUGH_SPECS` exists on main since PR #723 and `e2e-ci-wiring.test.ts` requires every walkthrough spec named there | E fb99bbd4c |
| `apps/web/e2e/helpers.ts:518 setBoolEntitlementOverrideSql(orgId, featureKey, value)` (upsert; thaw to false in `afterAll`), `:128 apiJson`, `:49 expectNoHorizontalScroll` | E fb99bbd4c |
| `.github/workflows/e2e.yml` triggers `on: push: branches: [main]` + `workflow_dispatch` with a `pr` input — the ONLY pre-merge e2e path | E fb99bbd4c |
| Runtime: Next standalone, Fly app `seazn-club-prod`, `primary_region "lhr"`, `[[vm]] shared-cpu-1x / 1gb`; root `fly.toml:11` carries a commented `NEXT_PUBLIC_SENTRY_DSN`; `services/placement/fly.toml` + `.github/workflows/placement-{ci,stg,prod}.yml` are the polyglot-deployable precedent | E fb99bbd4c |
| Stale directory `.claude/worktrees/stream-overlay` (15 MB, no `.git`, no docs) was moved to `stream-overlay.stale-20260907` and the worktree re-added from the branch | this session | E |

## 3. Tier A — the OBS overlay

Carried from the 09-05 design with the owner's rulings (`_INDEX.md` rulings
1–17) and every later correction folded. Nothing here is new to the owner
except the corrections named in §13.

### 3.1 Overlay route

`apps/web/src/app/overlay/fixtures/[fixtureId]/page.tsx` with a sibling
`layout.tsx`. Query `style=<themeId>` resolved by `resolveTheme(style,
sportKey)` against the registry, defaulting per sport; an unknown, misspelt or
sport-unsuitable id renders the sport's default at HTTP 200 — an OBS browser
source cannot be asked to correct a typo mid-match. `lang=<locale>` via
`toLocale`, default the org's public locale.

- **Layout**: nested segment layout returning a `<div>` (the root layout owns
  the only `<html>`/`<body>`), with a segment-scoped `<style>` setting
  `html, body { background: transparent; margin: 0 }`; no header, footer or
  attribution script; `robots: { index: false }`. Fonts: `import
  { barlowCondensed } from "@/lib/fonts"` — the existing declaration gains
  weight `"800"` (W2's slab needs it; today `["600","700"]` [E]); Geist comes
  from the root layout. Do not remount `next/font`.
- **Cookie banner does not render on this segment** (owner 2026-09-06, Q2:
  *"we can remove"*). The banner is mounted once in the root layout as a
  sibling of `children` (`app/layout.tsx:68` [E]), so a nested layout cannot
  unmount it, and **no route-key mechanism exists in `cookie-consent.tsx`**
  (finding FS1 — the 2026-09-06 documents asserted one). The mechanism is
  therefore built in W1-C: `cookie-consent.tsx` reads `usePathname()` and
  returns `null` when the path starts with `/overlay/`. The e2e asserts (a) the
  banner's testid is absent on the overlay and present on the public page,
  and (b) the overlay segment sets zero cookies (`context.cookies()` empty
  after load and after one realtime refresh) — "nothing to consent to" is
  proven, not assumed.
- **Page** (server): `publicFixtureSlugs(fixtureId)` (a small helper over the
  `public_*` views; the plan pins its columns) → `getPublicFixture(orgSlug,
  compSlug, divSlug, fixtureId)` (4-arg, `server/public-site/data.ts` [E ac85c70])
  so visibility rules hold → `hasFeature(org.id, "streaming.overlay")`
  (`lib/entitlements.ts:454` [E ac85c70]); either null → `notFound()`. Passes
  `initial: OverlayLiveData`, `sportKey`, entrant names, `realtime`
  eligibility and the resolved theme **id** to the client stage; the
  component is resolved on the client side of the boundary.
- **Stage** (client): `useLiveFixture(fixtureId, initial, realtime, {
  fetcher })` with the overlay endpoint as fetcher; renders
  `OVERLAY_THEMES[id].component(overlayModel(...))` — a registry lookup,
  never a branch. Root receives `sportThemeStyle(sportKey)`; canvas 1920×1080
  scaled `transform: scale(min(vw/1920, vh/1080))` from the top-left so OBS at
  1080p renders 1:1 and the console preview at 320 px renders the same
  component, not a picture.
- **Resilience on air**: the stage holds the last known score through a
  fetch failure or a deploy, reconnects quietly, never paints a white frame
  (owner's one real argument for a separate service, answered on Q16 by page
  resilience, not a second deploy).

### 3.2 The overlay endpoint — the overlay's one poll target

`GET /api/v1/public/fixtures/[id]/overlay`, gated by view visibility only
(same guard `publicFixture` uses; no entitlement here — the PAGE gates).
Replaces W1 Task 0's superseded Steps 2–13 (Q15 closed on evidence: the
engine already holds both numbers; **nothing in `packages/engine` is touched
by this programme**).

```ts
interface OverlayLiveData {                 // one poll, every tier
  status: string;
  summary: LiveFixtureData["summary"];      // one authority: match_states
  outcome: LiveFixtureData["outcome"];
  lastSeq: number | null;                   // W2's mount-seq
  venueTz: string;                          // resolveVenueTz(schedule_settings.tz, org.timezone)
  clock?: { phase: string; anchorSeconds: number; anchorAtWallMs: number };  // football family
  cricket?: { innings: { runs: number; wickets: number; legalBalls: number; ballsLimit: number | null }[] };
}
```

Snapshot fields come from the cached public fixture row; `clock` and `cricket`
are projected from `foldFixture(tx, id).state` inside `unstable_cache` **keyed
on `last_seq`**, so the fold runs once per ledger advance, not once per poll
(unit test: fold spy called ≤ 1× per `last_seq`). Step 1 of Task 0 (venue
time zone) stands as written: it rides on `getPublicFixture` via
`resolveVenueTz`, no migration.

### 3.3 The hook

`components/public-site/use-live-fixture.ts` — the subscribe-or-poll logic
lifted VERBATIM from `live-score.tsx:61-117` [E] (`refresh :61`, the
`live`-includes-`scheduled` predicate `:69`, the realtime effect `:74-110`,
the poll `:113-117`, `POLL_MS` import). New surface only: an options object
`{ fetcher, delayMs? }` and an exported `presentationNowOffsetMs`. With
`delayMs` absent the hook is byte-identical in behaviour; `LiveScore` is
repointed in the SAME commit and `live-score.test.tsx` unchanged-and-green is
the witness (R5, one transport). `delayMs` buffers `(receivedAt, snapshot)`
pairs and presents the newest with `receivedAt ≤ now − delayMs` (R2 uses it;
W1 builds it so the seam is real, not "left for later").

### 3.4 Projection (pure)

`apps/web/src/lib/overlay-model.ts`:

```
overlayModel(input: { sportKey; data: OverlayLiveData; sides: [{id,name,short},{id,name,short}]; msg }): OverlayModel
OverlayModel {
  live; decided;
  header: { context: string; clock?: string };     // "T20, 2nd innings" | "2nd half" | "Set 3"
  sides: [{ short; name; big; sub?; led; serving }, …];
  cells: { key; value }[];                        // sets / games / periods in order
  detail: string[];                               // bar's second band; [] for cricket in step one
  chase?: string;                                 // "Need 45 off 45"
  result?: string;                                // decided line
}
export type OverlayMoment = { kind: string; headline: string; line?: string; tone: SportTone }  // W2 fills it
```

Imports the five derivations from `@/lib/public-site` — never re-derives (one
authority per fact). `led` = the side in play (batting, serving) or nothing;
`short` = `entrants.team_id → teams.short_name` where present, else the first
three letters upper-cased (owner Q8: *"Ok"*). Every string through `msg`;
notation stays notation with a localised `title`. Decided/void copy reads the
exported `fixtureStatusLabel` / `VOID_STATUSES` (`stages-panel.tsx ~:1492-1512`
[E ac85c70]) — no second vocabulary. Board game, carrom, generic get empty
`cells` and `detail` by construction (ruling 4: *"all sports"*).

### 3.5 Theme registry and palettes

Two different things share the word "theme": the **sport palette**
(`sportThemeStyle(sportKey)`, eleven palettes, seven custom properties) and
the **overlay theme** (`components/overlay/theme-registry.ts`). They compose:
any theme, any sport. Owner Q7 (2026-09-06): *"we will have multiple theme
per sports so make it abstract and use can choose for now apply the default
one."*

- `OVERLAY_THEMES: Record<ThemeId, OverlayThemeDef { id, labelKey, component,
  sports: "all" | SportKey[] }>` — `bar` and `bug` on day one, `slate` in R2
  (§7.5). A third theme is one entry plus one component; the route, panel and
  projection do not change.
- `defaultThemeFor(sportKey)` — cricket `bar`, every other sport `bug` (the
  owner reverses by naming the other letter). `themesForSport(sportKey)` —
  the ONE filter the console and the route share. `resolveTheme(styleParam,
  sportKey)` — validates against the registry AND the entry's `sports`,
  falls back to the default, **never throws**.
- Overlay classes `.ovl-*` read all **seven** custom properties
  (`--sport-board`, `--sport-board-2`, `--sport-ink`, `--sport-led`,
  `--sport-advisory`, `--sport-caution`, `--sport-dismissal`; F2 — the 09-05
  text listed six) and never reuse `.pad-*`. Type: Barlow Condensed for names
  and numerals, Geist for labels, tabular numerals wherever a value changes
  width. Binding values: `_THEMES.md` §1–§4, §6, §7.

### 3.6 Motion — exactly three, plus the one clock

Owner 2026-09-05: *"will we do animation when score?"* → three motions, all
`transform`/`opacity`: **score tick** (the changed `big` scales 1.0 → 1.12 →
1.0 over 300 ms, that side's LED flashes one frame, the other side does not
move), **side change** (LED bar slides to the other row over 200 ms), **live
dot** (breathes 0.55 ↔ 1.0 over 2 s while live). Nothing animates on mount —
OBS attaches mid-stream. `prefers-reduced-motion` kills tick and breath.

**The football clock** (owner ruling, 2026-09-06): ships in W1 and **ticks** —
ONE 1 Hz phase-aware `setInterval`, re-anchored on every push from
`OverlayLiveData.clock`, `displayed = anchorSeconds + (now −
presentationNowOffsetMs − anchorAtWallMs)`, stopped between periods and at
full time. It is the only timer in the overlay and it **survives
reduced-motion because it is information**. Under R2's `delayMs` the offset
comes from the hook, so the clock and a delayed goal land together (one
authority for the offset, or the clock tears ahead of the goal).

### 3.7 Data: `stream_url`

Migration `V400__fixture_stream_url.sql` (next free at rebase; deltas run to
V399 [E] — the 09-05 text said V392, the 09-06 text V399, both taken):
`alter table fixtures add column stream_url text null check (stream_url is
null or stream_url like 'https://%')` plus a FULL `create or replace view
public_fixtures_v` redefinition copied from its latest definer (the 09-06
scout pinned `V362:22` at `ac85c70`; Task 0 re-pins) with `stream_url`
appended LAST (R6: the view may only append). `PublicFixture`
(`data.ts:206`) gains the column in BOTH hand-maintained lists.

`streamUrlSchema` (`lib/stream-url.ts`): `new URL()` parses, protocol
`https:`, hostname **exactly one of eleven** — `www.youtube.com`,
`youtube.com`, `youtu.be`, `m.youtube.com`, `www.facebook.com`, `facebook.com`,
`fb.watch`, `www.twitch.tv`, `twitch.tv`, `kick.com`, `www.kick.com` (owner
Q5: *"Agree"* on `m.youtube.com`). Exact comparison defeats path tricks
(`https://evil.example/www.youtube.com`), suffix domains
(`m.youtube.com.evil.example`), userinfo (`https://youtube.com@evil.example`
→ hostname `evil.example`), trailing dots and IDN homographs [A]. `""` → null.

Write path `PUT /api/v1/fixtures/[id]/stream`: `v1()` + `parseBody(PutFixtureStream)`
+ `requireResourceAuth(req, "fixture", id, "write")` → `setFixtureStreamUrl`
usecase beside `patchFixture` → `fireDivisionRevalidate`. JSON `{ id,
stream_url }`; 403 / 404 / 422. OpenAPI `ROUTES` entry in the same change
(`npm run openapi:gen`, CI drift step).

### 3.8 Organiser panel

`components/v2/fixture-stream-panel.tsx` (client), mounted from
**`desk/run-sheet-row.tsx` beside `run-sheet-edit-time` (`:377` [E])** — the
09-05 text's `FixtureLine` in `stages-panel.tsx` was retired by desk W2 (RP1).
ONE import + ONE conditional line; `sportKey` and `streamingEntitled={await
hasFeature(auth.orgId, "streaming.overlay")}` threaded from the division page
on the `embeds.enabled` precedent. Toggle `data-testid="fixture-stream-toggle"`
renders when `canEdit && streamingEntitled`, at **every** fixture status
(owner Q6: *"Agree"* — a club pastes the replay link after the final whistle).
**Coordinate with desk W3**, which is editing this file now (FS4): W1-D
rebases after any desk-W3 merge touching `run-sheet-row.tsx`, never races it.

Two tabs in the expander (owner 2026-09-07 on where streaming is bought: *"we
wwill buy the streaming in the fixture console page itself?"* — yes):

- **OBS tab** (Tier A): style tabs rendered FROM `themesForSport(sport_key)`
  in registry order, opening on `defaultThemeFor`; a live preview that is the
  real `<OverlayStage>` at `scale(640/1920)` on the row's own data; read-only
  overlay link + copy; the three numbered OBS steps; stream-link input +
  "Save link" with inline `streamUrlSchema` error and "Saved" in the button.
- **Phone tab** (Tier B): §5.3 states — upgrade card, buy-credits card, or
  the session controls (R1 builds it; W1 ships the tab strip with the Phone
  tab reading the §5.3 gate so the seam is live from PR1, showing the upgrade
  or buy card and nothing else until R1).

Phone first, one DOM (`_THEMES.md` §8, R15): at 320 tabs, inputs and buttons
full-width at 44 px; at ≥768 the copy button sits inside the field; the
control SET (membership, order, repeats) is identical at 320 and 1280.

### 3.9 Public match page link

When `stream_url` is set: `<a data-testid="public-stream-link" rel="noopener"
target="_blank">` under the headline block — "Watch live" while `scheduled`
or `in_play`, "Replay" once `decided`/`finalized`, nothing for `VOID_STATUSES`
(labels via `public.overlay.*`). When spectator W1 lands its court header the
link moves into that header's action row (spectator owns the composition;
this design owns the link's existence).

### 3.10 Entitlement gate

Key `streaming.overlay` — §5.1. Not entitled ⇒ panel absent, overlay route
404 (indistinguishable from missing), never an upsell on the overlay itself
(the upsell lives in the panel's Phone tab and the OBS tab's `UpgradeGate`,
§5.3). The test org is revealed by an `org_entitlement_overrides` row (owner
Q14: the override, over a preview cookie and an environment flag).

### 3.11 Error and empty states

Fixture missing or not visible: 404. Org not entitled: 404. Scheduled: header
shows the localised start time in `venueTz`, sides show names with "—" as
`big`, no live dot. Decided/finalized: `result` replaces `chase`, live dot off,
winner keeps `led`. Realtime unavailable: polling at `POLL_MS`; nothing ticks
except the football clock. Board game / carrom / generic: empty `cells` and
`detail`, main band only — a designed state. Malformed stream link: inline
message, nothing saved.

## 4. T1 — theme design and the visual gate

Owner 2026-09-07: *"Can we have Wave for designing the theme and testing?"* →
*"Ok"*. T1 runs in parallel with W1-A/W1-B and ahead of W1-C.

### 4.1 T1a — theme design (docs and canvas, no product code)

- The design canvas gains ≥2 options per surface the owner has NOT yet
  approved (checklist "Show ≥2 UI options before building"): **slate** states
  (warming, signal lost, ended); **Phone tab** states (idle, QR shown, live
  with health line, ending, ended, failed with reason); **credits / upgrade
  card** (no key, key but zero credits); **decided / void frame** for bar and
  bug. Bar and bug themselves are approved and are re-shown only where facts
  changed (seven tokens, the ticking clock, weight 800).
- Every overlay artboard at native 1920×1080; every panel artboard at 320,
  768 and 1280 **and 320 at 125 % zoom** (checklist "Zoom in/out"); every
  overlay frame composited over one light and one dark video frame.
- Owner picks by letter → values land in `_THEMES.md` as new sections in the
  sheet's own shape: §4a slate; §8a Phone tab (extends §8's panel tokens);
  §8b credits card; a "decided / void" row in §3 and §4. The contrast table in
  §2 gains every new ink-on-board pair.

### 4.2 T1b — the visual gate as code (lands in the same wave)

`apps/web/e2e/visual/capture.spec.ts` driven by
`apps/web/e2e/visual/manifest.json`: one row per capture — `{ id, route,
viewport, zoom, backdrop: "light"|"dark"|null, awaitTestId, mustDifferFrom?:
id[] }`. The spec seeds what a row needs through `apiJson`, navigates,
awaits the testid, composites the backdrop when set, writes a PNG and its
sha256 to the report directory, and asserts: every declared file exists;
every `mustDifferFrom` pair differs by hash; the last assertion runs AFTER the
state being proven (recurring class 10 — the harness's own vacuous mode).

- Seeded with routes that exist TODAY (`/embed`, a scorepad skin) so the
  harness is proven on real pages before the overlay exists. W1-E and R2 add
  manifest rows, never harness code.
- Checklist rows encoded as reusable assertions in `e2e/visual/asserts.ts`:
  no horizontal scroll split on computed `overflow-x` (`auto`/`scroll` = a
  reachable rail, `hidden`/`visible` = a real clip); control-SET diff between
  320 and 1280 (membership, order, repeats — never box size); every control
  ≥ 44 px by `elementFromPoint`; layout holds at 125 % zoom; every `truncate`
  has `min-w-0` on its whole ancestor chain; every scrolling rail carries
  `tabindex="0"`, a role and an accessible name (and the exemption list is
  asserted to be the reachable kind).
- Contrast unit test `components/overlay/__tests__/contrast.test.ts` reads
  one exported `OVERLAY_TOKENS` object whose values ARE `_THEMES.md`'s (the
  sheet cites the export; a value typed twice is a finding) and asserts
  4.5:1 text / 3:1 UI floors for every pair, including the new ones from
  §4.1. Derive, never hand-type (checklist "Derive expected values").

Owner value: every later wave signs off per screen against pictures; the
harness is reusable by desk W3 and the spectator surface.

## 5. Entitlements and money

Owner 2026-09-07: two keys (*"we can keep corpus name as it"*); purchase from
the fixture console; per-match credits (*"I think per match?"* → the
per-match recommendation, *"go"*).

### 5.1 Two catalogue keys (`V401__streaming_entitlements.sql`)

| Key | Meaning | `community` | `pro` | `event_pass` | `event_pass_l` | `enterprise` |
|---|---|---|---|---|---|---|
| `streaming.overlay` | Tier A: overlay route + OBS tab | false | **true** | false | **true** | **true** |
| `streaming.relay` | Tier B: "may buy credits" and use the Phone tab | false | **true** | false | **true** | **true** |

Rows for all five plans, `on conflict (plan_key, feature_key) do update`,
header prose to the V393 bar ("measured, not assumed"). Resolver semantics
"bool requires true; no row denies" [E V393]. `streaming.relay` never appears
without `streaming.overlay` in the catalogue, and the session route checks
the implication anyway (409 `overlay_required`). **`ENTITLEMENT_DOMAINS` is
untouched until the GA flip** — the pricing page shows nothing while the
feature is dark; the test org sees it through override rows. Pricing copy in
all four locales ships in the same change as the domain entry (standing
rule: an entitlement row and its copy are one unit).

### 5.2 The credits ledger

```sql
create table org_stream_credits (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references orgs(id) on delete cascade,
  delta           integer not null check (delta <> 0),
  reason          text not null check (reason in ('purchase','consume','refund','grant','expire')),
  session_id      uuid null references fixture_stream_sessions(id),
  stripe_event_id text null unique,
  note            text null,
  created_by      uuid null,
  created_at      timestamptz not null default now()
);
create index on org_stream_credits (org_id, created_at);
```

- **Balance = `sum(delta)`** through one usecase `creditBalance(tx, orgId)`.
  There is no counter column; the ledger is the one authority.
- **Consume** happens in the SAME transaction as the session's transition to
  `live` (§6.4): `select id from org_stream_credits where org_id = $1 for
  update` serialises concurrent consumers (a positive balance implies ≥ 1 row
  to lock; a zero-row ledger has balance 0 and is refused before any race can
  matter), then `creditBalance < 1` → the transition is refused and the
  session becomes `failed(no_credits)`, else insert `(delta −1, reason
  'consume', session_id)`. A `consume` row exists for the same `fixture_id`
  within the last 24 h → no second consume (a restart after a failure is the
  same match).
- **Purchase**: packs of 1 / 5 / 20 via Stripe Checkout, one-off, on the
  `size-pack-checkout.ts` pattern [E]. `POST /api/billing/relay-checkout`
  refuses BEFORE Stripe when the org's plan lacks `streaming.relay` (402 with
  reason copy), so nobody pays for a tier they cannot use. The webhook writes
  `(delta +n, 'purchase', stripe_event_id)`; the unique constraint makes a
  replayed event a no-op. Sandbox placeholder prices £6 / £25 / £80; real
  prices are an owner ruling before the GA flip (§12).
- **Grant** rows come from the admin plan tools (one row, `created_by` =
  the admin); **refund** rows from the admin tools only; **expire** is
  reserved for a future Enterprise monthly bundle (§12) and unused at launch.

### 5.3 What the panel shows (Phone tab)

| Org state | Phone tab body |
|---|---|
| no `streaming.overlay` | `UpgradeGate` → Pro (existing plan href) |
| overlay, no `streaming.relay` | `UpgradeGate` → Pro (same card; the split cannot occur in the catalogue, only via overrides) |
| relay, balance 0 | buy-credits card: three packs, `POST /api/billing/relay-checkout` → Stripe Checkout → `success_url` back to the same fixture row with the panel open |
| relay, balance ≥ 1 | session controls (§6.4 states, R1) with the balance shown |

OBS tab: no `streaming.overlay` → the same `UpgradeGate`; entitled → §3.8.

### 5.4 Money mutants (each recorded in the PR with its killer)

| Mutant | Killer |
|---|---|
| delete the `consume` insert | e2e: a session reaches `live`, balance unchanged → red |
| delete `for update` | unit, gated-transaction harness (`registration-concurrency.test.ts` pattern): two sessions on two fixtures with balance 1 both reach `live` → red |
| drop the `stripe_event_id` unique constraint | unit: replay the same webhook event → balance 2 → red |
| delete the plan-key check in `relay-checkout` | e2e: a community org receives a Checkout URL → red |
| delete the 24 h reuse rule | unit: restart on the same fixture consumes twice → red |

Money is tested against the **Stripe sandbox**, never assumed (checklist
"Billing/money claims tested against Stripe SANDBOX").

## 6. Tier B — data and API

### 6.1 Tables (`V402__stream_sessions.sql`)

```sql
create table org_stream_targets (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs(id) on delete cascade,
  kind       text not null check (kind in ('youtube','facebook','twitch','kick','custom_rtmp')),
  label      text not null,
  rtmp_enc   bytea not null,                   -- AES-256-GCM envelope of the RTMPS url + key
  created_at timestamptz not null default now()
);

create table fixture_stream_sessions (
  id                   uuid primary key default gen_random_uuid(),
  fixture_id           uuid not null references fixtures(id) on delete cascade,
  org_id               uuid not null references orgs(id) on delete cascade,
  mode                 text not null check (mode in ('passthrough','composed')),
  state                text not null check (state in ('requested','provisioning','warming','live','ending','completed','failed')),
  desired_state        text not null default 'live' check (desired_state in ('live','ending')),
  fail_reason          text null,
  theme_id             text null,
  overlay_delay_ms     integer not null default 0,
  target_id            uuid not null references org_stream_targets(id),
  ingest_input_id      text null,
  ingest_srt_url       text null,
  ingest_srt_key_enc   bytea null,
  machine_id           text null,               -- Fly Machine id (composed only)
  last_heartbeat       jsonb null,
  heartbeat_at         timestamptz null,
  started_at           timestamptz null,
  ended_at             timestamptz null,
  vcpu_seconds         integer not null default 0,
  egress_bytes         bigint not null default 0,
  max_duration_minutes integer not null default 300,
  created_by           uuid not null,
  created_at           timestamptz not null default now()
);
create unique index fixture_stream_sessions_one_active
  on fixture_stream_sessions (fixture_id)
  where state in ('requested','provisioning','warming','live','ending');
```

Double-start is a constraint, not code. RLS enabled on all three tables with
**zero client policies**; the panel reads an API projection. Greenfield
schema stance applies (no backfills).

### 6.2 Secrets

AES-256-GCM envelope: a per-row data key, wrapped by the key-encryption key
in env `RELAY_KEK` (Fly secret); the database never holds a key.
`server/relay/crypto.ts` is the only module that touches `*_enc` columns — a
static test greps the tree and fails on any reference outside
`server/relay/**`. Decryption happens only inside the request that hands the
value to Cloudflare or to the Machine's environment. Supabase Vault replaces
the envelope if the project's tier has it (§12).

### 6.3 Routes

| Route | Gate | Body / response |
|---|---|---|
| `GET /api/v1/public/fixtures/[id]/overlay` | view visibility | `OverlayLiveData` (§3.2) |
| `PUT /api/v1/fixtures/[id]/stream` | `requireResourceAuth(fixture, write)` | `{ streamUrl \| null }` → `{ id, stream_url }` |
| `POST /api/v1/fixtures/[id]/stream-sessions` | same + `streaming.overlay` + `streaming.relay` + balance ≥ 1 + storage headroom | `{ mode, targetId, themeId? }` → 201 `{ sessionId }`; 409 `active_session` (unique index) / `overlay_required`; 402 `no_credits`; 503 `storage_exhausted` |
| `POST …/stream-sessions/[sid]/stop` | same | sets `desired_state = ending` |
| `GET …/stream-sessions/current` | organiser | non-secret projection: state, mode, `health { fps, bitrateKbps, lastBeatAt }`, `qr` payload (§7.6), balance |
| `POST /api/billing/relay-checkout` | org admin + `streaming.relay` | `{ pack: 1\|5\|20 }` → Checkout URL |
| `GET /api/internal/relay/sessions/[sid]` | job token | session facts the Machine needs (page token, target, delay) |
| `POST /api/internal/relay/sessions/[sid]/heartbeat` | job token | `{ state, videoState, fps, bitrateKbps, egressBytes, measuredLatencyMs }` → `{ desiredState }` |
| `POST /api/cron/relay-sweep` | `x-cron-secret` | 503 when `CRON_SECRET` unset, then 401 on mismatch (the registrations order [E]); one idempotent usecase; `pg_try_advisory_xact_lock(hashtext(sid))` per session [A] |

Every route under `v1()`/`handler()`, zod at `server/api-v1/schemas.ts`,
OpenAPI `ROUTES` entries in the same change.

### 6.4 Session state machine

`requested → provisioning → warming → live → ending → completed | failed(reason)`.

- **provision**: `IngestProvider.createLiveInput` (recording `mode:
  'automatic'`, explicit `timeoutSeconds` = the reconnect window,
  `deleteRecordingAfterDays` = retention; `outputs = [target]` iff
  passthrough); composed additionally `RunnerProvider.create(session)` (§7.1).
- **warming**: the Machine pushes slate frames so the destination stream is
  alive before the camera; passthrough waits for the input's
  `status.current.state == 'connected'` [B].
- **live**: passthrough on input connected; composed on the relay page
  reporting `playing`. **The credit is consumed in this transition's
  transaction** (§5.2).
- **ending**: organiser stop, `max_duration` reached, or the sweep; the
  Machine flushes and exits 0.
- **failed(reason)** ∈ `no_inbound_timeout` (warming > 10 min), `machine_crash`
  (stale heartbeat > 90 s while live → ONE retry on the same session with the
  same credentials, the phone never notices → then failed), `target_rejected`
  (destination refuses the key; copy carries YouTube's fresh-channel ~24 h
  note), `storage_exhausted` (§6.5), `no_credits`.
- The heartbeat is the control channel: the Machine polls `desiredState` on
  every beat; a Machine takes no inbound traffic.
- **Replay** (RD10): on `completed` with `stream_url` null, fill it with the
  destination VOD URL through the SAME `streamUrlSchema` write path (a
  YouTube live watch URL persists). Never overwrite a club's own link.

### 6.5 Provisioning guard — storage headroom

Cloudflare bills recording storage in prepaid $5 / 1,000-minute blocks and
**an exhausted block stops NEW live streams from starting** [B]. The session
create checks headroom through the ingest port and fails fast as
`failed(storage_exhausted)` with panel copy — never a mid-warming mystery.
The sweep alerts below one retained match of headroom.
`deleteRecordingAfterDays` (7 at launch, §12) keeps the block recycling.

### 6.6 Token trust domains (G1, review-blocking from R1)

`SUPABASE_JWT_SECRET` signs realtime subscriber tokens ONLY. Job and page
tokens sign with **`AUTH_SECRET`** through the same jose module (shape donor
`mintPublicFixtureToken`, `lib/realtime.ts:91` [E]), claims `{ sid, scope:
"relay-job" | "relay-page", exp = max_duration + 30 min }`, 410 once the
session is terminal. The compositor's realtime subscription is minted
server-side under the producer doctrine ("scorers get realtime regardless of
plan; they are producing the data" [E]) — no plan bundles `realtime` for
Tier B. A grep for `SUPABASE_JWT_SECRET` outside `lib/realtime.ts` is part of
every R1/R2 review.

## 7. Compositor and relay page (R2)

### 7.1 Runner — Fly Machines only (owner 2026-09-07, A: "all ok")

Fly app `seazn-relay` in `lhr` beside the app and the database. Image
`seazn-relay:<sha>` built and pushed by `relay-{ci,stg,prod}.yml` on the
`placement-*.yml` pattern [E]. Driver `server/relay/runner-fly.ts` over the
Machines REST API: `POST /v1/apps/seazn-relay/machines` with `region: "lhr"`,
`config.image`, `config.guest { cpus, memory_mb, cpu_kind }` from the R0 memo,
`config.auto_destroy: true`, `config.env { SESSION_ID, JOB_TOKEN, APP_URL }`;
`machine_id` stored on the session; stop = `desiredState: ending` → graceful
flush → exit 0 → auto-destroy; hard kill = `DELETE …/machines/{id}`. Region is
driver config, default `lhr` (Cloudflare ingest is anycast; nothing is gained
by moving the Machine). Cloud Run is dropped entirely (FS5): no GCP account to
open, half the R0 spend, the placement precedent. The `RunnerProvider` port
stays, so a second driver is one file later. A warm pool of stopped Machines
is a later optimisation; `warming` already hides create latency behind the
slate.

### 7.2 Container

tini → node supervisor → Xvfb `:99` 1280×720 → PulseAudio null sink (one A/V
clock) → Chromium **headed on `:99`** through puppeteer (`--kiosk
--autoplay-policy=no-user-gesture-required`, SwiftShader), navigated ONCE to
the relay page; puppeteer is the control plane (`exposeFunction('relayReport')`
→ `{ videoState, measuredLatencyMs }` feeds heartbeats; `page.evaluate` sets
`delayMs` — never a re-navigation). FFmpeg, verbatim:

```
-f x11grab -framerate 30 -i :99 -f pulse -i default -c:v libx264 -preset veryfast
-b:v 3000k -maxrate 3000k -bufsize 6000k -g 60 -bf 2 -pix_fmt yuv420p
-c:a aac -b:a 128k -ar 48000 -f flv <rtmps>
```

`-progress` stats into heartbeats; graceful stop = `q` + ≤ 10 s flush + exit
0; any child death → non-zero → one runner retry (§6.4). x11grab is RGB
only — no alpha — which is the fact that forces the browser-as-compositor
shape (B3) over naive overlay capture [A]. B2 (chroma-key over `?bg=key`) is
the documented fallback only on R0's say-so; B1 (PNG pipe) is dead (cannot
hold 30 fps).

### 7.3 Relay page

`app/overlay/fixtures/[fixtureId]/relay/{layout,page}.tsx`, gated by the
`relay-page` token (`?st=`) + session active + fixture visible → else 404;
`noindex`; sets no cookies (asserted). Renders `<video>` (WHEP → LL-HLS
ladder) UNDER the unmodified `<OverlayStage>`. Page states from the element's
own events: `waiting` → warming slate, `stalled > 8 s` → signal-lost slate,
`playing` → live; each reported through `window.relayReport` when exposed.
`measuredLatencyMs` (the page measures it live) auto-tunes `delayMs` through
the hook so the score never runs ahead of the picture.

### 7.4 Failure choreography

Phone drop → Cloudflare holds `timeoutSeconds` → slate within ~8 s → seamless
resume (the encoder never restarts; the front door's window makes an
in-window resume invisible on air). Destination rejects the key →
`failed(target_rejected)` in words. Double start → 409 showing the existing
session. Forgotten stream → `max_duration`. Machine host event → observed in
the soak; recurring → the port makes another driver a file swap.

### 7.5 Slate theme

`OVERLAY_THEMES.slate` — `sports: "all"`, the one opaque theme; three states
(warming, signal lost, ended) with values from T1a's `_THEMES.md` §4a. It is a
registry entry AND (under B3) a page state driven by the `<video>` element.

### 7.6 QR contract v1 (the only R3 fact fixed here)

`docs/contracts/capture-qr.v1.json` + fixtures (valid, expired, tampered,
wrong-version) live in THIS repo, checksum-tested here and vendored into the
capture repo — the cross-repo drift gate. Payload:
`{ v: 1, sid, srt: { url, streamId, passphrase, latencyMs }, exp }` — the
three SRT fields **opaque** (no port knowledge; a front-door swap never
touches shipped phones); `exp` = provision + `max_duration` + 30 min; ≈
220–300 B → QR version ~10–13 at EC-M, ≥ 264 px, 4-module quiet zone [A];
manual paste-code fallback. The panel renders it client-side from the
organiser-authed session projection — the secret never enters page HTML.
Everything else about the phone app (libraries, ABR, thermal, five screens)
is the `seazn-capture` spec's, not this one's.

## 8. R0 — the bench spike (parallel, no repo dependency)

The one open technical bet: does browser-as-compositor hold 720p30 for 3 h on
a Fly Machine, at which size, pulling via what. Runs on real infrastructure,
never in CI. Produces ONE numbers memo (≤ 2 pages + tables) that gates R2 —
**no compositor product code before the memo**. Passthrough and Tier A ship
regardless of its verdict.

Matrix: `{ shared-cpu-2x / 4 GB, performance-2x / 4 GB }` × `{ B3
browser-compositor, B2 chroma-key }` × 3 h. Source `ffmpeg -re testsrc2` →
SRT into a Cloudflare live input (recording automatic, explicit
`timeoutSeconds`, `deleteRecordingAfterDays 1`); a stand-in relay page (any
WHEP/HLS `<video>` + a CSS-animated scorebug mimicking tick and LED motions).

Record: sustained fps and CPU % trend; dropped frames; A/V drift per hour
(clap-sync at 0 / 90 / 180 min); tick smoothness in the OUTPUT (frame-step a
capture); pull-leg latency per path (WHEP vs LL-HLS — seeds `delayMs`
defaults); any host event; egress bytes vs bill; account-level live-input
limits; the storage-headroom read the §6.5 guard polls. Verdict lines per
cell: PASS/FAIL against CPU < 80 %, drift < 100 ms/h, 30 fps held; the
Machine size recommendation; the 1080p / 4-vCPU price note. Acceptance: the
memo, tables filled, one composited screenshot per cell over a light AND a
dark frame.

## 9. Latency budget and cost

### 9.1 Latency (R0 replaces [D] with measurements)

phone capture + encode 100–200 ms [D] → SRT buffer 1.5–2.5 s (pinned; the
latency field rule ≥ 4×RTT on cellular [A]) → Cloudflare front door 0.5–3 s
[D] → WHEP pull 0.2–1 s [B/D] (LL-HLS fallback 2–6 s) → page decode ~100 ms
→ capture + x264 200–500 ms. **`delayMs` ≈ 2.5–7 s, measured live by the
relay page.** Destination transcode → glass 8–25 s happens AFTER compositing
— Tier C's spoiler, numbers recorded for its spec. **Tier A has zero offset.**

### 9.2 Transport and media facts

| Fact | Value | Class |
|---|---|---|
| SRT | UDP; ARQ + optional FEC; AES-128/256 passphrase; `streamid` routing; live-mode TLPKTDROP/NAKREPORT on | A |
| RTMP/RTMPS | TCP 1935 / TLS 443; FLV; Facebook mandates RTMPS | A |
| WHIP/WHEP | HTTP SDP → ICE/DTLS/SRTP; WHIP = RFC 9725; Cloudflare Stream supports WHIP/WHEP since 2022-09, unlimited WHEP viewers | A/B |
| GOP | keyframe 2 s (`-g 60` @ 30), never > 4 s; CBR-ish; 2 B-frames + CABAC per YouTube's encoder spec | B |
| Bitrate math | 3,000 kbps video + 128 kbps AAC = 1.41 GB/h = 4.22 GB / 3 h | A |
| x11grab | RGB only, no alpha — forces B3 | A |
| Audio | AAC-LC 128 kbps 48 kHz through the PulseAudio null sink — one A/V clock | A/B |
| Cloudflare Stream API | live input returns `rtmps { url, streamKey }` + `srt { url, streamId, passphrase }` + `webRTC`; `recording { mode: 'automatic', timeoutSeconds }` IS the reconnect window; `deleteRecordingAfterDays`; simulcast live-outputs API (= passthrough; composed must NOT use it) | B |
| Cloudflare Stream pricing (official doc, updated 2026-09-01) | Two dimensions. Ingest + encoding always free; no egress line. Storage prepaid in $5 / 1,000-min blocks (duration rounded to the second; file size irrelevant), consumed by uploads + SRT/RTMP live recordings + reserved `maxDurationSeconds`, NOT by ABR renditions or deleted videos. **Exhausted storage blocks NEW live streams from starting.** Delivery $1 / 1,000 min post-paid, counted for player/HLS/DASH playback, WHEP playback, MP4 downloads and simulcasting via live outputs. Live delivery rounds to the source GOP. Zero-viewer broadcast = $0 delivered. Stream Live WebRTC going GA; **WHEP delivery billing begins 2026-10-15** (free until then). | B |
| Fly Machines | REST create/start/stop/delete maps 1:1 onto the runner port; per-second billing while running; stopped Machines bill rootfs only; the org already operates Fly (placement) | E / D — R0 replaces with the account's rate card |

### 9.3 Cost per 3 h match (≈ $1.27 / £)

| Line | Composed | Passthrough | Tier A |
|---|---|---|---|
| Fly Machine, 3 h [D] | shared-cpu-2x / 4 GB ≈ £0.05–0.10; performance-2x / 4 GB ≈ £0.20–0.30 | — | — |
| Fly egress ≈ 4.2 GB [D] | ≈ £0.07–0.10 | — | — |
| Cloudflare delivered minutes (pull or simulcast, 180 × $1 / 1,000) | £0.14 (WHEP free until 2026-10-15) | £0.14 | — |
| Cloudflare recording storage | ≈ $0.90 / month while retained; pooled per prepaid block (one block ≈ 5.5 retained 3 h matches); retention 7 days ≈ one block per ~20 matches/week | same | — |
| **Total** | **≈ £0.26–0.54 + retention** | **≈ £0.14 + retention** | **£0.00** |

Against a £6 credit: composed ≈ 91–96 % margin, passthrough ≈ 98 %. 1080p ≈
one Machine size up (R0 prices it). Capacity: a T20 ≈ 300 ledger events / 3 h;
1,000 concurrent matches ≈ 28 writes/s — trivial; the scaling cost is realtime
fan-out (watch item). 50 composed matches = 100 vCPU + 156 Mbps egress
sustained.

## 9a. Design patterns (binding on code)

Owner 2026-09-07: *"include the follow the design pattern when developing the
code."* Every implementer follows the repo's codified patterns below; each
names its in-tree exemplar. **A brief that cannot name the exemplar for a
pattern it invokes is not compliant** (mirrors `RULES.md` §Skills: apply,
never cite decoratively).

| Pattern | Rule | Exemplar |
|---|---|---|
| Parse → authorize → delegate | every route is `v1()`/`handler()` wrapping `parseBody` → `requireResourceAuth` → one usecase; no logic in the route file | `lib/http.ts:69`; `server/api-v1/auth.ts:352`; `app/api/v1/fixtures/[id]/route.ts:17` |
| Zod schemas in one place | request/response shapes live at `server/api-v1/schemas.ts`, never inline in a route or a component | `schemas.ts` (`PatchFixture :964`) |
| Privacy folds live in VIEWS | what the public may see is decided by `public_*_v`, not by a filter in a usecase | `public_fixtures_v` (`V362:22` ac85c70; setup nulls schedule/venue/court, `officials_hide_names`, visibility filter) |
| Fire-and-forget side channels | realtime, revalidation and CDN purge are `void`, warn-only; a scoring write is never hostage to them | `publishFixtureUpdate` (`scoring.ts:139`), `fireDivisionRevalidate` (`revalidate.ts:14`) |
| One authority per fact | a value is derived in one function and imported; a second source is a fallback, never a tiebreaker | `resolveFixtureCfg` (`fold.ts`), `fixtureStatusLabel` / `VOID_STATUSES` (`stages-panel.tsx`), the five `lib/public-site.ts` derivations |
| Registry over branching | variants are entries in a registry looked up by id; adding one never edits a call site | `OVERLAY_THEMES` + `resolveTheme` (§3.5); sport skins by name (`registry.ts:85 V3_SKINS`) |
| Ports and adapters with in-repo fakes | external systems sit behind an interface with a fake that runs in CI without credentials | `IngestProvider` / `RunnerProvider` + `server/relay/fakes.ts` (§6); the placement service client |
| Pure projections, strings via `msg` | a view-model is a pure function of data + `msg`; no string literal reaches a component | `overlayModel` (§3.4) importing `setBreakdown` and siblings, never re-deriving |
| State machines over booleans | lifecycle is an enum with explicit transitions plus a `desired_state`; no `is_live`/`is_ending` flags | `fixture_stream_sessions.state` + `desired_state` (§6.4); the pad reducer (`scorepad/v3`) |
| Deny by default | 404 ≡ missing (never "forbidden"), RLS enabled with zero client policies, exact-host allowlists | overlay page `notFound()` (§3.1); §6.1 RLS; `streamUrlSchema` (§3.7) |
| The client never decides | entitlement and visibility are resolved server-side on every render; a client prop is a display hint, never a gate | `hasFeature` on the page and the division page (§3.1, §3.8) |
| Cron pair idiom | 503 when the secret is unset, then 401 on mismatch, then ONE idempotent row-locked usecase, driven by an Actions-cron workflow | `app/api/cron/registrations/route.ts:13-16` |
| Money is ledger rows in the same transaction | never a counter column; the debit row is inserted in the transaction that grants the thing paid for, under `for update`; Stripe events idempotent by id | `org_stream_credits` (§5.2); `size-pack-checkout.ts` |
| i18n: four dictionaries + generated keys | every user-facing string in `en/es/fr/nl`, `pnpm i18n:gen-keys`, zero diff on `lib/i18n-keys.ts` | `dictionaries/*/ui.json`, `public.json` |
| One DOM, branched for phone | phone is `max-md:*` on the same tree; phone-only is `md:hidden`; never a second tree, never a shrunk desktop | `2026-09-02-scorepad-v3-phone-composition-design.md`; `phone-disclosure.tsx` |

## 10. Testing and gates

Every task, all four kinds, stated in its acceptance with named assertions
(`RULES.md` §Testing): **unit**, **e2e** (Playwright; a backend task traces
forward to the user-facing flow that exercises it), **smoke**
(`scripts/smoke.ts` pattern), **regression** (the behaviour being changed).
Each task's acceptance names the `RULES.md` §"Owner checklist (2026-09-07)"
rows it satisfies — the reviewer checks the rows, not the prose.

### 10.1 Standing traps carried into every brief

JSON reporter counts only (`--reporter=json --outputFile`; `rtk` prints
`PASS(0) FAIL(0)` for a suite that failed to collect); `cd <worktree> &&` in
the SAME call and confirm `.testResults[].name` paths; the whole spec file,
never a `-g` slice; `ls db/migration/deltas | tail` after EVERY schema rebase
(a duplicate Flyway version survives a clean rebase — three times now); the
walkthrough spec named in `WALKTHROUGH_SPECS` in the same commit; `grep -a`;
no `git stash` in a worktree; `/usr/bin/git`, no heredocs, Write tool for
files; `.env.local` symlinked per worktree; ~700 tests skip silently without
`DATABASE_URL` inline; `rtk proxy` for lint and tsc; e2e pre-merge only via
`workflow_dispatch pr=<n>`; Q12's two `pass-scoping-guard` reds attributed on
a clean detached checkout, never absorbed.

### 10.2 Mutant tables — killer LIST, per surface

Every wave's PR carries its mutant table with the test that killed each
(checklist "Report mutant KILLER LIST"; a survivor = a missing test; a test
that dies under EVERY mutant fakes kills). Fixed today:

| Wave | Mutant | Intended killer |
|---|---|---|
| W1 | delete the hostname `===` | `stream-url` unit: `m.youtube.com.evil.example` accepted → red |
| W1 | swap `led` to the other side | `overlay-model` unit truth table |
| W1 | empty tennis `cells` | `overlay-model` unit, tennis fixture |
| W1 | delete the hook's `if (!live \|\| subscribed) return` | hook unit via `renderIsland` + captured `setInterval` |
| W1 | delete the `last_seq` cache key | endpoint unit: fold spy > 1× per `last_seq` |
| W1 | delete `hasFeature` on the page | e2e 404 ↔ 200 both directions |
| W1 | remove `ovl-tick` application | e2e post-one-more-event: tick on the changed side ONLY |
| W1 | delete the `usePathname` return | e2e: banner testid present on the overlay → red |
| W1 | delete `streamingEntitled` on the toggle | e2e not-entitled org: toggle absent + schedule affordance present |
| R1 | the five money mutants (§5.4) | as listed |
| R1 | drop the partial unique index | double-start e2e expects 409 → red |
| R1 | drop the stale-heartbeat sweep rule | fake-runner soak harness: session stays `live` forever → red |
| R1 | reference `*_enc` outside `server/relay/**` | static assertion → red |
| R1 | accept a tampered / expired / wrong-sid / terminal token | token unit → red |
| R1 | delete the implication check | community org with a relay override → expects 409 `overlay_required` → red |
| R2 | drop the clock offset | alignment e2e on fakes: with `delayMs = 3000` a posted goal and the clock advance land TOGETHER → red |
| R2 | delete the `stalled > 8 s` transition | page-state reducer table → red |

### 10.3 Gates per PR

The standing eight (`_RULES.md` §Merge gates), plus: JSON vitest counts
pasted against the recorded baseline (13,962 / 14,041 at `997ad22`,
re-baselined on the rebased branch); `rtk proxy` lint and tsc; `npm run
openapi:gen` and `pnpm i18n:gen-keys` with zero diff; the whole
`mobile.spec.ts` at seven widths; e2e via `workflow_dispatch pr=<n>`; the T1b
visual manifest rows for the PR (files exist, DIFFER, composited light+dark
for every overlay frame; panel at 320/768/1280 and 320 @ 125 %); a reviewer
pass per lane and per branch (never skip the loop); per-screen owner
sign-off. **R2's merge gate is not a review: one green 3 h soak** — synthetic
SRT source, scripted scorer, unlisted destination, zero manual interventions,
the session row telling the whole story, a mid-match SRT kill (slate ≤ 10 s,
seamless resume) and a Machine kill (invisible retry), drift < 100 ms/h.
Money: the credit purchase e2e drives the Stripe sandbox.

### 10.4 Rollout and SLOs

Dark (keys false everywhere, off /pricing) → test-org overrides (the owner
streams a real fixture on each tier) → 2–3 pilot leagues, one full weekend per
tier → GA = catalogue flip + `ENTITLEMENT_DOMAINS` entry + pricing copy (four
locales) in one change. SLOs: session success ≥ 99 %; slate < 1 % of live
time; heartbeat gap p99 < 45 s; overlay endpoint p95 < 300 ms; replay fill
100 %. Observability: pino fields `sid, fixtureId, orgId, state, transition,
reason, machineId`; the session row is the primary trace; Sentry the sink
(DSN uncommented in `fly.toml:11`, R1).

## 11. Plan structure and PRs

Owner ruling 2026-09-07: **per wave, not one plan file.** Each wave gets a
PROMPT file in the corpus directory
(`docs/superpowers/specs/2026-09-05-stream-overlay-prompts/`: rulings, scope,
do-NOT-touch, acceptance, mutant table — symbols, not line numbers) and a
PLAN file under `docs/superpowers/plans/` (writing-plans standard: task →
steps → exact files, code, commands, expected output). **Prompts for ALL
waves are written now; step-level plans only one wave ahead of execution.**
Reason recorded: a plan written today for R2 rots at every rebase (V399
proved it — three documents named a migration number that was taken by the
time anyone read them); a prompt names symbols, which survive.

| Wave | Prompt (corpus dir) | Plan (`docs/superpowers/plans/`) | Written | PR |
|---|---|---|---|---|
| **Task 0** | in `_STATE.md` (worktree recreated and rebased on `fb99bbd4c` — done; `ls deltas \| tail` → V400/V401/V402; `RULES.md` checklist — done `ed094e519`; corpus corrections IN PLACE annotated "(re-pinned 2026-09-07 @ fb99bbd4c)": `_INDEX.md`, `W1-step-one.md`, `W2-moments.md`, W1 plan Task 0 Steps 2–13 → §3.2; Q12 reproduction) | steps inline at the head of the T1 plan | now | — (docs) |
| **T1** | `T1-theme-and-visual-gate.md` (§4) | `2026-09-07-streaming-t1.md` | now | PR-T1 |
| **W1** | `W1-step-one.md` corrected in place | existing `2026-09-05-stream-overlay-w1.md` with the Task-0 amendment (§3.2, §3.3) and the Phone tab strip reading the §5.3 gate | now | PR1 |
| **R0** | `R0-bench.md` (§8) | none — the memo is the deliverable | now | — |
| **R1** | `R1-relay-core.md` (§5, §6, §7.6: V401 keys, V402 tables, credits ledger + checkout + webhook, crypto, ports + fakes, tokens, session API, cron pair + workflow, Phone tab with QR, passthrough live-detect, failed-reason copy, replay fill, Sentry DSN) | `2026-09-07-streaming-r1.md` | prompt now; **plan after PR1 merges** | PR-R1 |
| **R2** | `R2-compositor.md` (§7: relay page, `slate`, `delayMs` + alignment e2e, container + supervisor, `relay-*` workflows, soak harness, green soak) | `2026-09-07-streaming-r2.md` | prompt now; **plan after the R0 memo** | PR-R2 |
| W2 | existing `W2-moments.md` (+F3/F4 corrections at Task 0) | existing `2026-09-05-stream-overlay-w2-moments.md` | exists | PR2 |
| PR3 | after its artboard | — | deferred | PR3 |
| R3 | own spec in `seazn-capture` | — | deferred | — |

Out of the plans written now, with reasons: **W2** has its own committed plan
(`…-w2-moments.md`, 1083 lines) and is gated on spectator W1, which has not
merged; **R3** native apps live in the `seazn-capture` repo under their own
spec (only §7.6 is fixed here); **PR3** sponsor logos are LAST by ruling and
wait for their artboard. Sequencing: W1-D rebases after any desk-W3 merge to
`run-sheet-row.tsx`; R1 cuts a new worktree `relay` from `main` after PR1
merges; R2 starts only after the R0 memo. A conflict between plan ORDER and a
design or owner RULING is an `_INDEX.md` finding, never silently resolved.

## 12. Open questions (owner has not ruled; each with a recommendation)

1. **Real credit prices.** Recommend £6 / £25 / £80 for 1 / 5 / 20 at GA.
   Owner value: ≈ 90 %+ margin on composed, a one-sentence pitch ("1 match =
   1 credit"), and the packs map to a club's season shape. Ruled before the
   GA flip; sandbox placeholders until then.
2. **Passthrough at half a credit.** Recommend NO at launch — one price, one
   sentence; the ledger's integer `delta` takes a `2 credits = 1 composed`
   rebase later if wanted. Owner value: no fractional copy, no second SKU.
3. **Enterprise monthly bundle** (N `grant` rows per cycle from a cron,
   `expire` rows at cycle end). Recommend later, when an Enterprise org asks.
   Owner value: nothing built for a customer who does not exist yet; the
   schema already carries it.
4. **Supabase Vault vs the AES envelope.** Recommend the envelope with
   `RELAY_KEK` in Fly secrets unless the project tier shows Vault enabled at
   R1 Task 0. Owner value: no tier upgrade for one column; a swap is one
   module.
5. **YouTube fresh-channel enablement (~24 h).** Recommend help copy on the
   Phone tab's `target_rejected` state and in `content/help`. Owner value: the
   first failure a new club hits explains itself.
6. **Per-destination VOD URL semantics** (Facebook, Twitch, Kick). Recommend
   fill only for YouTube at launch (its live watch URL persists) and leave
   `stream_url` null for the others. Owner value: no wrong link goes public.
7. **Mic default on the phone app** (R3): recorded here so it is not lost —
   recommend live with a prominent mute (crowd is the product; PA music is a
   rights risk the mute handles). Decided in the capture spec.

## 13. Findings ledger and re-pins

### 13.1 Findings

| # | Finding | Resolution |
|---|---|---|
| F1 | W1 prompt's `stream-url` test rejected `m.youtube.com` ("ten hosts") | eleven hosts (owner Q5); `m.youtube.com/…` accepted, `m.youtube.com.evil.example` rejected |
| F2 | Six-token lists in the 09-05 design §3 and W1 scope 5 | seven — `--sport-advisory` is real (`sport-theme.ts:77` [E]); contrast pair added |
| F3 | W2 allowlist: volleyball "set won" only | + set point and match point (owner Q10) |
| F4 | W2's "same payload" referent | the overlay endpoint; moments source and fallback ride IT (no double poll) |
| F5 | Replay via a Cloudflare recording URL + allowlist growth | destination VOD is the replay; recordings archival; storage priced (§9.3) |
| F6 | Bitrate-ladder contradiction in the PDFs (3,000→800 vs 3,500→500) | 3,000→800 (an 800 floor keeps on-screen text legible); belongs to the capture spec |
| F7 | HaishinKit chosen for Android | RTMP-only on Android [B]; belongs to the capture spec |
| **FS1** | The 09-06 documents asserted a "route-key condition in `cookie-consent.tsx` (its own pathname mechanism)" | **None exists** (`cookie-consent.tsx:34,66`, `localStorage` only; mounted at `app/layout.tsx:68`) [E fb99bbd4c]. W1-C builds the `usePathname` return + zero-cookies e2e (§3.1) |
| **FS2** | Migrations V399/V400 (09-06) and V392 (09-05) | `V399__stats_player_career_split.sql` exists; this programme takes **V400 / V401 / V402** at rebase and re-checks `ls deltas \| tail` |
| **FS3** | "`.claude/worktrees/stream-overlay` exists, pushed" (09-06 plan P5) | the directory was a 15 MB unregistered residue with no `.git`; moved to `stream-overlay.stale-20260907`, worktree re-added from the branch, rebased clean on `fb99bbd4c` |
| **FS4** | "coordinate desk W2 on `run-sheet-row.tsx`" | desk W2 MERGED (#725); the live contention is **desk W3** (`feat/competition-desk-w3-band-and-phone`) |
| **FS5** | Cloud Run Jobs as a first-class runner, benched beside Fly | dropped (owner A: "all ok"); Fly Machines only; the port keeps a second driver a file away |
| **FS6** | `streaming.relay` implies `streaming.overlay` as a bundling rule; RD12 "compositor self-mints realtime"; RD13 org monthly budget | replaced by two catalogue keys on the same plan split + per-match credits (owner: *"I think per match?"* → "go"); self-minting kept (§6.6); the budget is the ledger |
| **FS7** | No theme-design or visual-gate wave existed | **T1** added (owner: *"Ok"*) ahead of W1-C |
| FS8 | `barlowCondensed` weights `["600","700"]` | W1-C adds `"800"` to the existing declaration (RP8 confirmed) |
| FS9 | `playwright.config.ts` cited under `apps/web/e2e/` | it is `apps/web/playwright.config.ts:119` |

### 13.2 Re-pins against `main` `fb99bbd4c`

| # | Pin | State |
|---|---|---|
| RP1 | panel mounts in `components/v2/desk/run-sheet-row.tsx:377` beside `run-sheet-edit-time` | verified [E fb99bbd4c] |
| RP2 | migrations | V400 stream_url, V401 keys, V402 sessions — next free at rebase, re-check at Task 0 |
| RP3 | `public_fixtures_v` copy source `V362:22` | [E ac85c70]; re-pin at Task 0 (`grep -al "public_fixtures_v" db/migration/deltas \| tail -1`) |
| RP4 | catalogue rows in the v18 shape, five plans | verified [E V393] |
| RP5 | desk contention | W2 merged; W3 live — W1-D rebases after any W3 merge |
| RP6 | zod schemas at `server/api-v1/schemas.ts` | [E ac85c70]; re-pin at Task 0 |
| RP7 | walkthrough matching = path regex `apps/web/playwright.config.ts:119` + `WALKTHROUGH_SPECS` naming | verified [E fb99bbd4c] |
| RP8 | fonts: reuse `lib/fonts.ts:7-9`, add 800 | verified [E fb99bbd4c] |
| RP9 | panel dictionary namespace (`console.json` vs `ui.json`) | pinned at W1-D by reading what `run-sheet-row.tsx` imports; recorded as a finding either way |

Closed pins carried: the five derivations importable at exact lines;
`publicFixture` ← view; override helper `helpers.ts:518`; entrant short name
via `entrants.team_id → teams.short_name` else three letters; `getPublicFixture`
4-arg; `ballsLimit :440` and `asOf :599` in STATE; venue tz source
`schedule_settings.tz`; token precedent `jose` at `realtime.ts:91`; cron idiom;
Sentry as sink; fold cost cached on `last_seq`.

### 13.3 Watch list (not blocking)

WHEP pull latency (R0) · Fly Machine size and host events (R0) · Vault on
the Supabase tier (§12.4) · per-destination VOD semantics (§12.6) · YouTube
fresh-channel lead (§12.5) · RTMPS per destination (Twitch ingests) ·
storage-headroom API read + live-input account limits · Supabase Realtime
quotas vs fan-out · slugs-helper view columns at implementation · RP9 ·
`select distinct sport_key from divisions` vs the eleven keys · Q12's two
reds.
