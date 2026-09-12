# Overlay Match Card Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Demote slate from a `?style=` theme to a match/end card layer above bar/bug, with the scorebug always visible underneath.

**Architecture:** `ThemeId` is only `bar` | `bug`. `OverlayStage` always renders the resolved scorebug; when `slateStateOf` is warming/ended it also renders the card component (no nested scorebug). `?style=slate` resolves to the sport default.

**Tech Stack:** React / Next overlay stage, existing `overlay-slate.tsx` card UI + `theme-registry.ts`.

**Spec:** `docs/superpowers/specs/2026-09-12-overlay-match-card-layer-design.md`

## Global Constraints

- Scorebug remains visible under the card (warming + ended).
- Unknown/`slate` style never throws or 404s — sport default.
- No barrel files; keep `overlay.slate.*` dict keys for this change.

---

### Task 1: Registry — drop slate as a theme

**Files:** `apps/web/src/components/overlay/theme-registry.ts`, related tests

- [ ] `ThemeId = "bar" | "bug"`; remove slate entry from `OVERLAY_THEMES`
- [ ] Remove OverlaySlate import / cycle comments
- [ ] `slabPlacementFor(style, sportKey)` — style is only bar|bug; drop slate branch
- [ ] `resolveTheme`: optional explicit map `styleParam === "slate"` → fallback (same as unknown)
- [ ] Update registry / stage-theme-props / slab-placement tests

### Task 2: Card component — no nested scorebug

**Files:** `apps/web/src/components/overlay/overlay-slate.tsx`, `overlay-slate.test.tsx`

- [ ] Strip Scorebug composite; card-only root (keep `.ovl-slate` / `.ovl-slate-card`)
- [ ] Live state: render null (stage owns when to mount) OR keep empty root — prefer stage gates mount
- [ ] Update tests: no ovl-bar/ovl-bug inside card; card mounts for warming/ended props only

### Task 3: Stage mounts card above theme

**Files:** `apps/web/src/components/overlay/overlay-stage.tsx`, stage tests

- [ ] Import `OverlaySlate` (or rename export) + `slateStateOf`
- [ ] Always `Theme = OVERLAY_THEMES[props.style].component`
- [ ] When `slateStateOf(model)` is warming|ended, also render `<OverlaySlate … />` (z-index already keeps bar/bug above plate content)
- [ ] Remove `props.style === "slate"` special cases (moments / placement already use slabPlacementFor)
- [ ] Test: `style=bar` + non-live model shows card + bar; `style=slate` page resolves to bar for cricket

### Task 4: Page / console / docs

**Files:** overlay page (if needed), stream panel tests, `_THEMES.md` note or design already covers

- [ ] Confirm `themesForSport` no longer lists slate in console
- [ ] Rebuild overlay-eoo; smoke `?style=bar` warming + `?style=slate` → bar with card
