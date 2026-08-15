# R4 — Tennis conversion + doubles serve order

Read `_RULES.md`, `_INDEX.md`, spec §2/§3 (tennis row), §8, §9.1. Scout
re-pins; v2 skin `skins/tennis-skin.tsx` (520 lines), kernel
`packages/engine/src/sports/nested/kernel.ts`.

**Task:** Convert tennis to `SkinDefV3` (tapModel **S**): scoreboard halves
ARE the point buttons — pair/player names on the halves (person names from
lineup members, never entrant labels), lime serve dot on the serving PLAYER,
strip = sets · games · next server · ends-change. Fault/Let/Code/Retire minor
row. Phase-aware tiles kill mid-game set-score entry (D-16). Ribbon keys
`pad.tennis.ribbon.*` ×4.

**Engine item (spec §9.1, the programme's ONLY engine work):** the nested
kernel consumes `pairOrder` so serve order within a pair is derivable —
additive, module stays `1.0.0`, expected zero recorded-fold movement (serve
attribution is presentation until a payload carries it). If ANY corpus state
moves: GOLDEN-POLICY pair (red code commit + isolated re-baseline commit).
Engine touched ⇒ conformance + golden replay + engine lint owed.

**Register rows owed:** D-2 (doubles affordances), D-3 (the "2/1 starting"
badge — root-cause it; if the fix lives in the lineup editor, fix it here as
an unplanned fix rather than waiting for R7, it is one counter), D-16, D-6
on this surface.

**Acceptance:** registry flips tennis (mutation-proved); singles AND doubles
e2e (pair entrants, serve-dot assertion anchored `="` per the RSC trap, deuce
alternation); unit incl. serve-rotation builder against `pairOrder`; smoke
deferred to R8; screenshots ×3; axe; **gallery + walkthrough sign-off with
the owner specifically verdicting the doubles screen (their named pain)**.
