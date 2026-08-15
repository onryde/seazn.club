# R3 — Football conversion (owner priority 2)

Read `_RULES.md`, `_INDEX.md`, spec §2/§3 (football row), §8. Scout re-pins;
v2 skin `skins/football-skin.tsx` (711 lines at capture).

**Task:** Convert football to `SkinDefV3` (tapModel **T**): night scorebug
(side scores; strip = half · clock if the view carries one), per-side tile
columns Goal / Card / Sub, Pen minor. Goal commits side-level instantly
(engine scorer/assist fields are optional — honest), dock asks scorer →
assist chips (band ≥2). Card tile → colour choice inline (yellow/red), person
via dock. **Sub via the Swap-sheet primitive** — `football.sub`, cap +
re-entry from the module's own `lineupPolicy(cfg)`, refusal copy worded
("3 of 3 subs used"). Small-sided/youth/mini variants shrink via cfg only.
Ribbon keys `pad.football.ribbon.*` ×4 locales.

**Owner-call item from the gallery (FOO-04):** present the old modal vs the
new dock flow in the walkthrough explicitly — the owner reserved judgment.

**Register rows owed:** D-4/D-5 on this surface; bench members must be
seedable for the sub e2e (`RosterSlotSpec.slot:"bench"` exists in helpers).

**Do NOT touch:** engine, other skins, console chrome.

**Acceptance:** registry flips football (mutation-proved); every
`football.*` type reachable; e2e — goal+assist, card, and a SUB with cap
exhaustion refusal, real rosters incl. bench; unit + regression; smoke
deferred to R8 (PR body); screenshots ×3 widths; axe; **gallery + walkthrough
sign-off recorded before merge**.
