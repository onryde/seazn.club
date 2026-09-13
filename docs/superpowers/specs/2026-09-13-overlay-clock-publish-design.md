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
sports do not. Soft-commit still holds attribution docks (~5s); null dock and
`*.clock` publish immediately.

## Shape

- Event: `{sport}.clock` with `{ at: GameTime, running: boolean }`.
- Fold: update `asOf` from `at`; set `clockRunning` from `running`.
- Overlay projection: `clock.running` (default `true` when field absent).
- `useOverlayClock`: if `running === false`, hold at `anchorSeconds` (no 1 Hz).
- Pad: `toggleClockNow` / `adjustClockNow` → `pipeline.submit` (bypass soft-commit).

## Non-goals

Cricket / racket clocks. Peer-revalidate / Fly env. Moment slabs for clock.
