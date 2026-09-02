# ScoringPad v3 — phone composition (320–430px)

**Status:** approved in principle by the owner 2026-09-02 (Option 2 of three,
picked from the options page
https://claude.ai/code/artifact/bed4be34-3767-48a2-a17d-5726dea7223f).
**Scope:** every sport's board (all 11 v3 skins), the fixture console around
it. Desktop and tablet (≥ 768px) render unchanged.
**Not a feature change.** Same controls, same visual language, same copy —
only the composition below 768px changes.

## 0. Owner rulings this spec rests on

| # | Ruling | Source |
|---|---|---|
| 0.1 | Mobile is *designed*, never desktop shrunk. Pass/fail is the visible control SET (membership + order + repeats) at 320 vs 1280 — equal lists are a shrink. | memory `feedback_design_mobile_first`, `reference_compare_control_set_not_box_size_across_widths` |
| 0.2 | "Keep all components same" = same **features**; free to stack, reorder, fold into disclosures, repeat a primary action near the thumb. No new features. | owner, this session (question answered) |
| 0.3 | Applies to **all sports'** scoring pads. | owner, this session |
| 0.4 | Option 2 chosen — "Score strip up, chrome down". Option 1 (v3-only tidy) rejected as a groomed shrink; Option 3 (fixed bottom bar) deferred — R3 measured a fixed sheet at 320 covering the board and intercepting tile taps (`detail-dock.tsx`, `revealDock` doc-comment). Dock stays **inline**. | owner, this session |
| 0.5 | Pad visual design of record stays `2026-08-15-scoringpad-v3-redesign-design.md`; per-screen gallery sign-off is a merge gate (§0.8/§6 there). | that doc |

## 1. The problem, measured (R8 gallery, commit `ce6a2933`, 320×568)

- `apps/web/src/components/v2/scorepad/v3/` contains **no width breakpoint** except one `sm:text-sm` in `scorebug.tsx`. There is no phone composition; the desktop tree is fluid-squeezed.
- First tappable control (scorebug half for rally sports, first tile for keypad sports) sits at **y ≈ 500–620** on a 568px-tall phone. The scorer scrolls for every rally.
- Above it: fixture title card (team names wrap 3–4 lines, status pill, mono score, "Round 1 · recorded by…"), the "Scoring" header + *Hand over device*, the queue status, then a black headline bar repeating the score a **third** time.
- Inside the board: scorebug names clip mid-word (`GALLERY BADMINTON HOME..`), the "Tap to award the rally" hint wraps to two lines, the serving strip wraps to three; the ribbon label truncates to `Rally recorded …`; dock chips wrap to four rows; ledger rows carry `recorded by <long name>` on three lines each.
- Roughly half of the vertical cost is **outside** `v3/`: title card, Scoring header, Activity, lineups and match actions are `fixture-console.tsx`.

## 2. Mechanism — one DOM, CSS-branched at `md`

- Breakpoint: Tailwind v4 `md` (768px). Phone = `max-md:*` variants. Tablets (768/834) and desktop keep today's composition.
- **Desktop class strings are not edited.** Phone behaviour is added as `max-md:` classes beside them, or as phone-only elements carrying `md:hidden`. This makes "≥ 768 unchanged" a pixel-diffable claim (§6.4).
- **Single DOM everywhere except one control.** *Hand over device* is the only control that exists twice: the desktop button (existing `data-testid="device-handover"`) gets `max-md:hidden`; a phone icon button in the strip (`data-testid="device-handover-phone"`, `md:hidden`, same handler, same accessible name) is added. `getByRole('button', { name })` therefore resolves to exactly one visible element at any width; test-id locators must pick the width-appropriate id.
- No JS media queries, no `useMediaQuery`, no SSR/hydration branching. The two disclosure states (§3.6, §3.7) are plain `useState` toggled by phone-only buttons; at ≥ 768 the toggles are `md:hidden` and the bodies have no `max-md:hidden`, so state is inert on desktop.
- Reorder inside the pad uses flex `order`: `pad-host` root `space-y-3` → `flex flex-col gap-3` so a child can carry `max-md:order-*`. This is the **one deliberate edit to a desktop class string** in the whole change (margin-top 12px between block siblings vs a 12px column gap — same geometry); the 768/1280 pixel diff in §6.4 is what proves it, not this sentence.

## 3. Phone composition, top to bottom

Region names are the `data-role` / testids already in the tree; line numbers are deliberately omitted (re-pin before editing).

### 3.1 Match strip — replaces the title card + "Scoring" header (`fixture-console.tsx`)
The existing title card (`card p-5`, first child of the console) is re-laid, not duplicated:
```
Badminton Home vs Badminton Away                    ← h1, one line, truncates
In play · Game 1 · Round 1        0 – 0    [⇄]      ← pill+meta | mono score | hand-over icon
```
- h1: `max-md:text-[13px] max-md:truncate` on a `min-w-0` container; "vs" keeps its accent.
- Row 2 is the pill, the round/meta line and the mono score placed in one `max-md:flex` row; the mono score `max-md:text-xl`. Nothing here is new text — the same nodes, re-laid.
- Phone-only: `[⇄]` hand-over icon button, 44×44, `md:hidden` (§2). A phone-only expand toggle (`md:hidden`, accessible name "Show match details" / "Hide match details") lifts the truncation and reveals the venue/time line for scorers who need the full names.
- The "Scoring" `h2` + desktop *Hand over device* row (`data-role="console-scoring"` header) gets `max-md:hidden`. The section card itself stays (it wraps the pad).
- The pad's queue status (`v3-queue-status`, "ALL SYNCED") stays where it is; it is ~20px and reads the queue state the strip cannot see.
- Target: strip ≤ 64px; scorebug top edge at **y ≤ 200** on 320×568 with the app nav and breadcrumb present.

### 3.2 Headline bar (`v3-headline`) — `max-md:hidden`
The scorebug carries the same score. Desktop unchanged.

### 3.3 Scorebug (`scorebug.tsx`)
- Halves: `max-md:px-2 min-w-0`; name `max-md:truncate max-md:whitespace-nowrap`; score `max-md:text-5xl`; hint `max-md:truncate max-md:whitespace-nowrap` — measured, "Tap to award the rally" at 11px fits a 320/2 half once the padding drops (implementer re-measures per sport, §7).
- Bottom meta strip: `max-md:flex-nowrap max-md:justify-start max-md:overflow-x-auto` with `max-md:shrink-0` children — a swipeable rail, never a wrap. Scrollbar hidden. This is the only region that scrolls horizontally, inside its own box — the page never does.
- Tap model unchanged: the halves remain the rally buttons (MODEL-S) or plain readouts (MODEL-T).

### 3.4 Ribbon (`v3-ribbon`) — label `max-md:line-clamp-2` instead of a single truncated line. *Take back* unchanged.

### 3.5 Context strip (cricket and any skin that declares one) — three one-line rows
`Striker | <name, truncates>` / `Non-striker | …` / `Bowler | …` as a two-column table at phone; the innings-fidelity lock line drops to one muted line. Desktop pills unchanged.

### 3.6 Tiles (`tile-grid.tsx`) — `max-md:min-h-[54px]`, label `max-md:text-[15px]`
Column count and spans stay skin-decided (`TileSpec.span`); cricket's keypad keeps four columns.

### 3.7 Dock (`detail-dock.tsx`) — inline, 44px floor
Chips container `max-md:grid max-md:grid-cols-2 max-md:gap-2`; chips `max-md:min-h-11 max-md:justify-center max-md:min-w-0` with a truncating label; *Cancel* `max-md:w-full`. Person pickers (chips whose label is a person's name, e.g. cricket "Who's out?") render one per row (`max-md:grid-cols-1`). `revealDock` (scroll-into-view on open) is unchanged and is what keeps the dock reachable.

### 3.8 Recording-level chip (`v3-recording`, "Every detail") — moved **below** the dock on phone
`max-md:order-*` so it follows tiles + dock; `max-md:min-h-9 max-md:text-xs`. It is a status toggle, not a scoring action; on a phone it yields its slot to the board.

### 3.9 Activity ledger (`ActivityPanel`, console instance) — collapsed on phone
- New prop `collapsible` (console passes `true`; the device-link page passes the same so the one component has one rule).
- Collapsed: header row becomes the toggle ("Activity · N", chevron; accessible name "Show all activity" / "Show latest only"), the **latest row only**, and *Void last entry* always visible. *Ledger verified* + *Download audit* and rows 2..N are `max-md:hidden` until expanded.
- Rows: title and the "time · recorded by …" line are `max-md:truncate` one line each.
- ≥ 768: no toggle rendered (`md:hidden`), no row hidden — identical to today.

### 3.10 Lineups — one disclosure row each on phone
A small `PhoneDisclosure` wrapper in `fixture-console.tsx` around each `LineupEditor` / roster card: summary row = the card's existing title + the "N/M starting" count + chevron (button, `md:hidden`, accessible name "Show lineup" / "Hide lineup"); body `max-md:hidden` while closed. `LineupEditor` itself is not touched. ≥ 768 identical to today.

### 3.11 Match actions (`data-role="match-actions"`) — unchanged.

### 3.12 Control-set diff this composition must produce at 320 (rally sport, live, dock closed)

| Desktop (1280), in order | Phone (320), in order |
|---|---|
| Hand over device | Show match details *(new)* |
| Scorebug home half · away half | **Hand over device** *(moved into strip, icon)* |
| Take back | Scorebug home half · away half |
| Every detail | Take back |
| Sanction Home · Sanction Away · More | Sanction Home · Sanction Away · More |
| Void × N | **Every detail** *(moved below board)* |
| Void last entry · Download audit | Show all activity *(new)* |
| Lineup selects (home) · (away) | Void × 1 · **Void last entry** |
| Forfeit · Abandon | Show lineup × 2 *(new)* |
| | Forfeit · Abandon |

Membership differs (three disclosures added, N−1 Void and Download audit folded), order differs (two moves). Not a shrink by ruling 0.1.

## 4. Copy and i18n
New strings, all four dictionaries (`apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`), then `gen-keys` regen of `i18n-keys.ts`:
`console.phone.showDetails` / `hideDetails`, `activity.phone.showAll` / `showLatest`, `lineup.phone.show` / `hide`. The hand-over icon reuses the existing *Hand over device* string as its accessible name. No other copy changes; no sport copy changes.

## 5. Files
`apps/web/src/components/v2/fixture-console.tsx` (strip, Scoring-header hide, `PhoneDisclosure`, phone hand-over button), `apps/web/src/components/v2/scorepad/v3/pad-host.tsx` (root flex, headline hide, chip order), `scorebug.tsx`, `tile-grid.tsx`, `detail-dock.tsx`, `context-strip.tsx`, `activity.tsx` (collapsible), the four `ui.json` + generated keys, `apps/web/e2e/mobile.spec.ts` (new describe), `scripts/smoke.ts` (one probe). Skins untouched unless a skin hard-codes a class this spec changes (implementer greps `-a` and reports).

## 6. Verification — what "done" means

1. **Unit** (`cd apps/web && npx vitest run --reporter=json --outputFile=…`): `renderToString`-level tests for `ActivityPanel collapsible` (collapsed renders exactly one row and *Void last entry*; non-collapsible renders N; mutation check: delete the collapsed branch → red) and `PhoneDisclosure` (body carries the hidden class only while closed). Judge green only from `numPassedTests/numTotalTests` and confirm `.testResults[].name` resolves inside the worktree.
2. **E2E, seven widths** — a new describe in `apps/web/e2e/mobile.spec.ts` (the only spec the `mobile-*`/`tablet-*` projects run; do NOT add a new filename), one rally sport + one keypad sport, at each width:
   - print the visible control list (accessible name, DOM order) and assert: at < 768 it contains `device-handover-phone` visible and `device-handover` hidden, the three disclosure toggles, and differs from the 1280 list in order; at ≥ 768 the inverse.
   - `window.scrollY === 0`, then the first tap target's `boundingBox().y + height ≤ viewport.height` at < 768 (badminton: a tappable `v3-scorebug-half`; cricket: the first tile).
   - `document.elementFromPoint(cx, cy)` at that target's centre resolves to it (no overlay).
   - Activity: one row visible collapsed; toggle → N rows; *Void last entry* visible in both states.
   - existing no-horizontal-scroll gate stays.
   Budget any per-tap wait as `Math.max(FLOOR, base + taps * (HOLD_MS + slack))`, never a flat number.
3. **Smoke** (`scripts/smoke.ts` pattern, PR CI): fetch the fixture page and assert the phone strip control is in the HTML, anchored `data-testid="device-handover-phone"` (with `="`, not a bare probe).
4. **Regression — "≥ 768 unchanged" as pixels**: run `gallery.capture.ts` for all 12 sports on `main` and on the branch (`docs/runbooks/pad-gallery.md`; `GALLERY_WIDTHS=768,1280` for the diff run, full three widths for sign-off). 768 and 1280 PNGs must be **byte-identical** (`cmp`) sport for sport; 320 PNGs must **differ** for every sport (proves the change is live, not suppressed). Any 768/1280 diff is a defect in this spec's mechanism, not tolerance to widen.
5. **Existing suites** re-run: `scorepad-v3-*.spec.ts`, `walkthrough/scorepad-v3-r7-console-chrome.spec.ts` (drives hand-over), the 15 specs that click *Void* — at their own projects. Those that run at phone widths and click a now-folded control are updated to open the disclosure first; list them in the PR.
6. **Gallery sign-off** at 320/768/1280, all 12 sports, per-screen verdicts by the owner, per ruling 0.5. Plus a hand-driven walkthrough on a real phone width: score a rally, open a dock, void an entry, hand the device over — and write down what was seen.
7. Lint via `rtk proxy npm run lint` (read `✖ N problems`); tsc via a direct `npx tsc --noEmit -p apps/web` exit code, not the wrapper's summary; `npm run openapi:gen && git status --porcelain` empty before every commit.

## 7. Premises to re-verify before building (found by grep, not by read)
- `pad-host` root is `<div data-role="pad-v3" className="space-y-3">` and the region order is queue → headline → scorebug → rejection → clock → ribbon → recording → context → tiles → dock → swap → sheet → activity-slot.
- The console title card is a single `card p-5` whose `h1` holds `home vs away` inline, followed by the pill, mono score, and the round line.
- `ActivityPanel`'s prop surface and whether the device-link page mounts it via `pad-host`'s slot.
- `LineupEditor` is used elsewhere (registration) — the wrapper lives in the console, so it must not be.
- Which tests in `mobile.spec.ts` reference hand-over today, and which sport its seed uses.
- The hint fits one line at 320 with `px-2` for **every** sport's hint string (measure in the browser; the longest wins).

## 8. Out of scope
Option 3 (sticky scorebug / fixed bottom bar); the device-link page's own chrome (it has no title card — only §3.2–3.9 apply there); the public scorebug page; `/admin`; swap-sheet and guided-sheet internals beyond inheriting the 44px chip floor if they share the dock's chip class; any copy or colour change.
