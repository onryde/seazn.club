# Overlay match card as a layer (not a style)

**Status:** approved in session 2026-09-12.  
**Branch / worktree:** `feat/overlay-end-of-over` · `.claude/worktrees/overlay-end-of-over`

## Decision

`slate` is **not** a `?style=` theme. The warming **match card** and decided **end card** are a **layer above** the chosen scorebug style (`bar` | `bug`).

| Layer | Role | Control |
|---|---|---|
| Style | Scorebug chrome only | `?style=bar` \| `?style=bug` (sport default unchanged) |
| Card | Warming match card · ended result card | Fixture state via `slateStateOf` — not a style tab |

**Owner pin (2026-09-12):** while the card is up (warming / ended), the **scorebug stays visible underneath**. Live = card off, scorebug only.

## Consequences

1. Remove `slate` from `OVERLAY_THEMES` / `ThemeId`. Console stream tabs offer bar + bug only.
2. `?style=slate` falls through `resolveTheme` to the sport default (never 404).
3. `OverlayStage` always mounts the resolved bar/bug theme; additionally mounts the match-card layer when state is warming or ended.
4. Card keeps stadium-night plate + `--sport-led` border + transparent canvas; CSS class names may keep `ovl-slate-*` for now (copy keys `overlay.slate.*` stay).
5. Amend `_THEMES.md` §4a: card layer, not Theme C registry entry.

## Out of scope

- Renaming i18n keys / CSS prefixes (`overlay.slate.*`, `.ovl-slate-*`) — cosmetic follow-up.
- Signal-lost slate state (still owed to B3).
