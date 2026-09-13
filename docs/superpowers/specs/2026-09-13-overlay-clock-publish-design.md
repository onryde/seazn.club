# Overlay clock publish (pause / start / correct)

**Date:** 2026-09-13  
**Status:** approved (chat)

## Problem

Pad Pause / Start / Correct only mutate host `PadClock` state. The overlay
ticks from the last stamped `asOf` + wall time, so it keeps running after Pause.

## Decision

Every pad clock control publishes a stamped ledger event immediately (no
soft-commit). Overlay gains `clock.running` and holds when `false`.

## Scope

Sports that mount `PadClockBar`: **football, hockey, ice hockey**
(`footballSkinV3.clock` / period-shared `buildClock`). Cricket and racket
sports do not.

## Soft-commit vs immediate (all v3 sports)

Gate: `usesSoftCommit(dock) === dock !== null && dock.chips.length > 0`.
Empty-chip docks must return `null` (not `{ chips: [] }`). `*.clock` bypasses
the gate via `publishClock` → always immediate.

| Sport | HOLD (enrichment chips) | Immediate |
|---|---|---|
| Cricket | noball bat-runs; bye / legbye extras | plain ball / wide / penalty; toss; retire; review; innings close / declare / summary |
| Football | goal (flags ± scorer/assist); card with person chips; shootout kick band≥2; penalty offence band≥2 | period; shot; sub; sinbin; empty card; shootout kick band&lt;2; `football.clock` |
| Hockey / ice hockey | goal (flags ± scorer/assists); suspension.start with on-field; shootout.attempt band≥2; set_piece band≥2 with people | period.advance; shot; suspension.end; empty suspension / set_piece; `*.clock` |
| Volleyball | rally when on-court &gt; 1 (scorer) | rally singles / ≤1; set.summary; sanction; timeout; sub; libero |
| Tennis | every `tennis.point` (kind ± scorer) | set_summary; sanction; interruption; game.award |
| Table tennis | doubles scorer; expedite return chip | singles rally; game.summary; sanction; timeout; expedite.start; sub |
| Badminton | doubles rally scorer | singles; game.summary; sanction; timeout / sub / expedite |
| Carrom | board.summary breaker/queenBy; game.adjust person (when roster non-empty) | toss; empty-roster board/adjust |
| Boardgame | result (method chips) | pairing |
| Generic | score (amount ± person) | result / settle |

Clock bar sports (PadClockBar): football, hockey, ice hockey only.
## Shape

- Event: `{sport}.clock` with `{ at: GameTime, running: boolean }`.
- Fold: update `asOf` from `at`; set `clockRunning` from `running`.
- Overlay projection: `clock.running` (default `true` when field absent).
- `useOverlayClock`: if `running === false`, hold at `anchorSeconds` (no 1 Hz).
- Pad: `toggleClockNow` / `adjustClockNow` → `pipeline.submit` (bypass soft-commit).

## Non-goals

Cricket / racket clocks. Peer-revalidate / Fly env. Moment slabs for clock.
