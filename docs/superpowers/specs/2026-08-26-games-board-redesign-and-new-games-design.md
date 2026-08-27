# Seazn Games — chess board redesign + first new games — design

**Date:** 2026-08-26
**Status:** Approved in brainstorm (owner, 2026-08-26); awaiting implementation plan
**Supersedes nothing.** Extends `2026-07-14-seazn-games-chess-quest-design.md` (platform + Chess Quest v1) and `2026-07-14-chess-quest-track3-openings-design.md`.

## Goal

1. Make the Chess Quest board look and feel like the boards members already know
   (chess.com / lichess): green-and-white squares, readable highlights, board
   oriented to the side to move, drag *or* tap to move, a short slide on every
   move, and move/capture sounds. Chrome around the board stops ignoring dark mode.
2. Add the first two non-chess games to `/games` — **Daily Word** and **2048** —
   on a small shared games toolkit so the third and fourth games cost one folder
   each.

Audience is **casual club members** (and the kids Chess Quest already targets).
Nothing here touches fixtures, results, ratings or the scoring pad, and nothing
needs an org, a login or a database.

### Decisions locked during brainstorm

| Decision | Choice |
|----------|--------|
| Chess scope | Board + polish only. **No** play-vs-computer, **no** member-vs-member, no cloud progress. |
| Board palette | Theme tokens on `.cq-board[data-theme]`; `green` is the default; `purple` (today's look) and `brown` (lichess) ship as alternates; picker in settings, persisted as a device setting next to `muted`. **Superseded — see Amendment 1.** |
| Pieces | Keep the Cburnett SVG set (`public/games/chess-quest/pieces/`). No piece-set picker in this wave. |
| Input | Tap-tap stays the default and the e2e driver; drag is additive. |
| New games | Daily Word (Wordle-style) and 2048. Sudoku, Minesweeper, Checkers (reusing the new board), Memory are follow-ups, in that order. |
| i18n | `apps/web/src/games/**` is declared an **English-only carve-out** in `AGENTS.md`, alongside `content/help/**`. No dictionary work is owed for any game surface. |
| Persistence | localStorage only, one namespaced key per game (`seazn-games:<slug>:v1`), same posture as Chess Quest v1. |
| Delivery | Five waves, each a normal PR. W1 and W2 touch the same files → sequential. W4's two games are disjoint folders → parallel. |

**Org-owner value.** Members return to seazn.club daily for reasons that need
zero staff setup; a familiar board removes the "why is my king at the top"
stall that loses kids in Track 1; `/games` is public, so it is top-of-funnel
for new orgs.

## Current state (verified 2026-08-26)

- Board: `src/games/chess-quest/components/Board.tsx` — 64 `<button>`s in a CSS
  grid, controlled by props (`position`, `highlights`, `coins`, `labels`,
  `onTap`, `popToken`, `shakeToken`). Highlight kinds: `sel | move | cap | hint`.
- Styling: `src/games/chess-quest/chess-quest.css` — `.cq-light #faf5ff`,
  `.cq-dark #e9d5ff`, purple 2px border, purple coordinate text shown only when
  `labels` is set, inset-ring highlights, `cq-pop` / `cq-shake` / `cq-hint-pulse`
  keyframes, print-only certificate palette.
- Missing: last-move highlight, check highlight, board flip, drag, slide
  animation, `prefers-reduced-motion` handling, any `dark:` variant (0 across the
  game's TSX), sound (store already has `getMuted/setMuted`, nothing plays).
- 54 hardcoded `purple-*` Tailwind classes across the game's components.
- Engine: custom, `src/games/chess-quest/engine/` (`parseFEN` returns
  `whiteToMove`; `Move = { from, to }` on a 64-array). No chess.js.
- Store: `src/games/chess-quest/lib/progress.tsx` — `Progress` context; device
  settings block holds `getMuted/setMuted/getVoiceOn/setVoiceOn`.
- Platform: `src/games/registry.ts` (`GameMeta`, `status: "live" | "coming-soon"`),
  `src/games/player-map.tsx` (`next/dynamic`, `ssr:false`),
  `app/games/page.tsx`, `app/games/[slug]/page.tsx`, proxy host rewrite for
  `games.seazn.club`.
- Tests: `e2e/games.spec.ts` (9 tests, tap-driven, no colour assertions);
  `src/__tests__/{games-registry,games-player-map,proxy-games-host}.test.ts`;
  14 unit files under `chess-quest/{engine,content,lib}/__tests__`.
  `/games` is **not** in `e2e/mobile.spec.ts` — zero-width coverage today.

## W0 — policy (this PR)

`AGENTS.md`, i18n bullet: add `apps/web/src/games/**` to the English-only
exception. One line. No code.

## Amendment 1 (2026-08-27) — one board palette, no picker

W1 shipped as written below and merged in #662. The owner then ruled that
**every board is white/green, full stop**. The alternate palettes and the
control that selected them were removed the same week:

- `.cq-board[data-theme="brown"]` and `[data-theme="purple"]` — deleted. The
  nine tokens stay, defined once on `.cq-board`; there is no `[data-theme]`
  hook in the file any more and no `data-theme` attribute on the element.
- `BoardThemePicker.tsx` and its test — deleted; unmounted from `QuestHeader`.
- `BoardTheme`, `resolveBoardTheme`, `getBoardTheme`/`setBoardTheme` and the
  `boardTheme` blob field — removed from `lib/progress.tsx`. `loadBlob` now
  deletes a `boardTheme` left in an existing player's localStorage by W1, so
  the retired key does not get written back on the next save.
- `Board.tsx` no longer calls `useProgress()` at all — the theme read was its
  only use of the context.

The test probes were **inverted, not deleted**: the CSS test now asserts no
`[data-theme=` selector and none of the five retired hex literals; the
`QuestHeader` test asserts no board-theme control is mounted. So re-adding an
alternate palette reddens the suite rather than shipping quietly. The
brown/purple columns in the token table below are kept as the record of what
W1 shipped — they are history, not a target.

The `flex-wrap` on the header button row stays even though the picker that
overflowed it is gone: it is what keeps the row safe at 320px the next time an
item is added.

## W1 — board: themes, highlights, orientation, motion

Files: `components/Board.tsx`, `chess-quest.css`, `lib/progress.tsx` (one
setting), a new `components/BoardThemePicker.tsx`, mounted in `components/quest/QuestHeader.tsx`
next to the existing mute toggle (the only caller of `setMuted`).

### Theme tokens

`.cq-board` reads every colour from custom properties; `data-theme` selects a
set. Nothing else in the CSS names a colour.

| token | green (the only palette; brown/purple retired — Amendment 1) | brown | purple (legacy) |
|---|---|---|---|
| `--cq-light` | `#EEEED2` | `#F0D9B5` | `#faf5ff` |
| `--cq-dark` | `#769656` | `#B58863` | `#e9d5ff` |
| `--cq-sel` | `rgba(255,255,51,.5)` | same | `rgba(147,51,234,.35)` |
| `--cq-last` | `rgba(255,255,51,.4)` | same | `rgba(147,51,234,.25)` |
| `--cq-move` | `rgba(0,0,0,.14)` | same | `rgba(88,28,135,.3)` |
| `--cq-check` | `radial-gradient(#ff0000 0%, #e70000 25%, rgba(169,0,0,0) 89%)` | same | same |
| `--cq-hint` | `#f59e0b` | same | same |
| `--cq-coord-on-light` | `#769656` | `#B58863` | `#7e22ce` |
| `--cq-coord-on-dark` | `#EEEED2` | `#F0D9B5` | `#7e22ce` |

`BoardTheme = "green" | "brown" | "purple"`; stored as a device setting
`getBoardTheme()/setBoardTheme()` beside `getMuted`. Unknown/absent → `green`.

### Highlights

`Highlight` grows to `"sel" | "move" | "cap" | "hint" | "last" | "check"`.
Rendering changes:

- `sel` and `last` are full-square overlays (`::before`, `mix-blend-mode: normal`,
  under the piece), not inset rings.
- `move` is a centred dot at 30% of the square; `cap` is a ring — a
  `radial-gradient(transparent 0 66%, var(--cq-move) 67%)` — so a capturable
  piece is visibly circled instead of boxed in rose.
- `check` is the red radial on the king's square.
- `hint` keeps the pulsing amber ring (kids rely on it) but moves to an overlay
  so it reads on green.
- A square may carry `last` **and** one of the others; the component accepts
  `lastMove?: Move | null` and `checkSquare?: number | null` as separate props
  rather than overloading the `highlights` map.

Coordinates are always drawn (the `labels` prop becomes the default `true`),
in the square's *opposite* colour, 10–11px, a-file ranks top-left and rank-1
files bottom-right — chess.com layout. When the board is flipped they move to
the h-file / rank 8 edge so they stay on the outer edge.

Border: the 2px purple border goes. `border-radius: 6px`, `box-shadow` from the
existing card token.

### Orientation

`Board` accepts `orientation?: "white" | "black"` (default `"white"`). Square
index → grid cell mapping inverts for `"black"`. Every mini-game that loads a
FEN passes `orientation` from `parseFEN(...).whiteToMove`; `SquareRace` /
`CoinHop` / `RookMaze` (no side to move) stay white. `data-square` names are
unchanged so the e2e selectors keep working regardless of orientation.

### Motion

- On a position change where exactly one piece moved (the common case), the
  moving `<img>` gets a 120 ms `transform` slide from its previous cell (FLIP:
  measure old rect, apply inverse transform, transition to none). Implemented
  inside `Board` with a `useLayoutEffect` and the previous `position` in a ref —
  the callers do not change.
- `@media (prefers-reduced-motion: reduce)` disables slide, `cq-pop`, `cq-shake`
  and `cq-hint-pulse` (hint falls back to a static ring).

### Tests (W1)

- Unit: theme resolver (`resolveBoardTheme(unknown) → "green"`); orientation
  mapping (idx ↔ cell for both orientations, `data-square` invariant); the
  "single piece moved" detector used by the slide.
- Rendered: `Board` with `orientation="black"` places `a1` bottom-right (query
  `[data-square="a1"]` and compare `getBoundingClientRect` order in jsdom via
  grid order, or assert the `style.order` / grid-area used).
- e2e: existing 9 pass unchanged (tap path). ~~One new test: board theme picker
  switches `data-theme` and survives reload.~~ Retired by Amendment 1.
- Screenshots at 1280 / 768 / **320** (board = 288 px, square = 36 px, coords
  10 px) with no horizontal scroll; posted in the PR.

## W2 — input and sound

Files: `Board.tsx` (pointer handlers), `chess-quest.css` (drag ghost), a new
`lib/useSfx.ts`, small local audio assets under
`public/games/chess-quest/sfx/` (move, capture, check, solve — synthesised or
CC0, < 10 KB each; no external fetch, CSP untouched).

- **Drag:** pointer events on the piece `<img>`; on `pointerdown` the source
  square gets `sel` and legal targets get `move`/`cap` exactly as a tap would
  (reuse the existing tap selection so behaviour is one code path); a ghost
  `<img>` follows the pointer; `pointerup` on a square calls `onTap(idx)` — so
  the game components see a tap and need no change; `pointerup` elsewhere
  cancels. `touch-action: none` on the board only while a drag is active so
  page scroll is not stolen from a plain tap. Keyboard/tap users are unaffected.
- **Sound:** `useSfx()` returns `{ play(kind) }`, honours `getMuted()`, lazily
  creates one `AudioContext` on first user gesture, no-ops if the API is missing
  or the file 404s. `GameShell` plays `solve`; `Board` plays `move`/`capture`/
  `check` from the same single-piece-moved detector W1 adds.

### Tests (W2)

- Unit: drag reducer (`down → move → up` on legal / illegal / same square /
  outside board) — pure function, no DOM.
- Rendered: `pointerdown` on a piece then `pointerup` on a legal target calls
  `onTap` with the target index once.
- e2e: one test drags a pawn in the free-play arcade and asserts the position
  changed (`page.mouse` down/move/up over `[data-square]` rects).

## Amendment 2 (2026-08-27) — W3 ships tokens only, no `dark:`

This wave's original brief (below, kept for the record) assumed the app
already had dark-mode infrastructure — Seazn dark token *values* in
`globals.css` and some toggle mechanism — for chess-quest's tokens to
follow. Neither exists: `globals.css` defines light-value custom
properties only (no dark counterparts), there is no `.dark` class,
`[data-theme]` attribute, `ThemeProvider`, or `prefers-color-scheme`
override anywhere in `apps/web/src`. The only 3 existing `dark:` usages
in the whole app (`apps/web/src/components/v2/board/*.tsx`) rely on
Tailwind's default, unconfigured `dark:` variant — i.e. driven purely by
the *visitor's OS* setting, with nothing in the app coordinating it.

That matters because `apps/web/src/components/v2/__tests__/history-panel-contrast.test.tsx`
documents a real, shipped regression from exactly this pattern: `dark:`
classes fired from OS dark mode while the surrounding card stayed
light-only, producing illegible contrast — the fix was to strip `dark:`
entirely and add a test asserting its absence. Adding `dark:` to
chess-quest's `purple-*` classes today would reproduce that same bug
for the entire games surface, for any visitor whose OS is set to dark,
with no way to opt out.

Owner decision (2026-08-27, asked mid-implementation): ship the token
extraction only — hardcoded `purple-*` utility classes become named CSS
custom properties (matching the app's existing `--mk-*`/`--ps-*`
naming), still purple, still light-only, no `dark:` anywhere. Real dark
mode for chess-quest is deferred until the app has real dark-mode
infrastructure (a toggle + actual dark token *values*) to build on —
not re-proposed piecemeal per surface. The e2e-matrix-coverage line
below is unaffected by this and still ships.

## W3 — chrome: token extraction (no dark mode — see Amendment 2)

Files: every `*.tsx` under `src/games/chess-quest/components/` with `purple-*`
classes (57 occurrences per the actual count, not 54), `src/app/games/page.tsx`,
`src/app/games/[slug]/page.tsx`. `chess-quest.css` print palette untouched.

- ~~Replace hardcoded `purple-*` with Seazn tokens from `app/globals.css` plus
  `dark:` variants; the game's identity stays purple-accented (brand), but
  surfaces/text follow the app's light and dark palettes.~~ Superseded by
  Amendment 2 — tokens only, no `dark:` variants; no app-wide dark palette
  exists to follow.
- The listing card and player header get the same treatment.
- Certificate print sheet is deliberately hardcoded light and stays so.

### Tests (W3)

- `grep -c "purple-" src/games/chess-quest/components/**/*.tsx` drops to
  accent-only usages, listed in the PR.
- ~~Screenshots light + dark at 1280 / 768 / 320.~~ Retired by Amendment 2 —
  light-only screenshots at 1280 / 768 / 320 (no dark mode to shoot).
- `/games` and `/games/chess-quest` added to `e2e/mobile.spec.ts` so the seven
  widths cover the games tree from here on.

## W4 — shared toolkit + Daily Word + 2048

### `src/games/_shared/`

Small, extracted only as far as the two new games need:

- `useGameStore<T>(key, initial, migrate?)` — SSR-guarded localStorage state
  with corrupt-value recovery (same posture as `progress.tsx`).
- `dailySeed(date = today, salt)` — deterministic integer from an ISO date so
  every player gets the same daily puzzle; pure, tested.
- `ShareResult` — button that copies text via `navigator.clipboard`
  (falls back to a selectable `<textarea>`), shows "Copied".
- `GameFrame` — the header/status/footer chrome new games use (Chess Quest keeps
  its own `GameShell`; unifying is not in scope).

### Daily Word (`src/games/daily-word/`, slug `daily-word`)

- Rules: 5 letters, 6 guesses, one puzzle per calendar day (local time), keyboard
  on screen + physical; tiles flip to green/yellow/grey; hard-mode off.
- Engine: `evaluate(guess, answer) → ("hit"|"near"|"miss")[5]` with correct
  duplicate-letter handling (the classic bug); `isValidGuess(word)` against the
  allowed list; `answerFor(date)` via `dailySeed` over the answer list.
- Word lists: `content/answers.ts` (~2 300 common 5-letter English words) and
  `content/allowed.ts` (larger guess list), both typed arrays, sourced from a
  public-domain list noted in `content/LICENSE.md`.
- State: per-day guesses, stats (played, win %, streak, distribution), persisted
  under `seazn-games:daily-word:v1`.
- Share text: `Seazn Word #N x/6` + emoji grid, no letters.
- Registry entry `status: "live"`, thumbnail `🔤`.

### 2048 (`src/games/2048/`, slug `2048`)

- Engine: pure `slide(board, dir) → { board, gained, moved }` on a 4×4 number
  array; `spawn(board, rng)` places a 2 (90 %) or 4; `canMove(board)`;
  `hasWon(board)` at 2048 with "keep playing".
- Input: arrow keys, WASD, and touch swipe (pointer down/up delta, 24 px
  threshold, `touch-action: none` on the board only).
- State: board, score, best, `keepPlaying`, persisted under
  `seazn-games:2048:v1`; "New game" resets everything but best.
- Tiles animate slide + merge pop with the same reduced-motion guard as W1.
- Registry entry `status: "live"`, thumbnail `🔢`.

### Tests (W4)

- Unit: `dailySeed` stability; `evaluate` table incl. duplicate letters
  (`guess "ALLEY"`, answer `"LEVEL"` etc.); `slide` for all four directions,
  merge-once-per-move, no-op detection; `spawn` with a seeded rng.
- Registry/player-map tests extend automatically (they iterate `GAMES`).
- e2e: one test per game — Daily Word: type a guess, see five coloured tiles,
  reload keeps it; 2048: press ArrowLeft, board changed, score ≥ 0, reload keeps
  the board. Both added to `mobile.spec.ts` widths.
- Screenshots 1280 / 768 / 320, no horizontal scroll (2048 board at 320 =
  288 px, tiles 64 px; Daily Word keyboard three rows fit at 320 with 28 px keys).

## Error handling

- Corrupt localStorage for any game → discard, start fresh, `console.warn`, no
  Sentry.
- Audio unavailable / blocked autoplay → silent no-op.
- Clipboard API missing → textarea fallback.
- ~~Unknown `data-theme` → green.~~ Retired by Amendment 1 — no `data-theme` exists.

## Out of scope

Play vs computer; member-vs-member; cloud/account progress sync; piece-set
picker; Sudoku / Minesweeper / Checkers / Memory (queued follow-ups, in that
order — Checkers waits for W1 so it can reuse the themed board); any i18n of
game surfaces; PWA; changes to the Chess Quest curriculum content.

## Wave order and parallelism

| Wave | Depends on | Parallel-safe with |
|---|---|---|
| W0 policy | — | everything |
| W1 board | W0 | W4 (disjoint folders) |
| W2 input+sound | W1 (same files) | W4 |
| W3 chrome | W1 (Board.tsx) | W4 |
| W4 toolkit + 2 games | W0 | W1–W3; inside W4, Daily Word ∥ 2048 after `_shared` lands |

Each wave is one PR. e2e runs on push to `main` only (see `AGENTS.md`), so
every wave gets a local full e2e (`E2E_PROD_TARGET`) before merge and the
screenshots in the PR body.
