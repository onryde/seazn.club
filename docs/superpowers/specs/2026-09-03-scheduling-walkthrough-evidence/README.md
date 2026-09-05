# Control-set dumps — scheduling console, 2026-09-03

Raw `visible control set` measurements (membership, order, repeat count) taken
from the live DOM at three widths across all six tabs of
`/o/{org}/c/{comp}/d/{div}/schedule`. They back §S14 of
`../2026-09-03-scheduling-walkthrough-findings.md`.

Committed because they are the evidence under an owner escalation; the 29
screenshots from the same pass are not (the repo tracks zero images and
`.gitignore` carries `/*.png`).

## READ THIS BEFORE USING THEM — the board row is contaminated

The board tab reads a **saved** density preference before it applies its mobile
default (`schedule-board.tsx:853-861`):

```ts
const saved = window.localStorage.getItem(DENSITY_STORAGE_KEY);
if (saved === "board" || saved === "agenda" || saved === "lanes") setDensity(saved);
else if (window.matchMedia("(max-width: 640px)").matches || divisions.length >= 8)
  setDensity("agenda");           // "Agenda is the mobile default" (v3/04 §2)
```

`pickDensity` persists on every density click, and these three passes ran in one
browser context starting at 1280. The 320 dump shows the full placement grid
(~180 `Place picked match at HH:MM on <court>` buttons), which the code can only
produce via the `saved` branch — at 320 the media query would otherwise have
selected Agenda.

So **the board's 210-control count at 320 is a measurement artefact, not a
groomed shrink**: a first-time phone visitor gets Agenda. Any re-measurement
must use a FRESH browser context per width, or clear
`DENSITY_STORAGE_KEY` between widths.

The other five tabs are unaffected — they have no persisted view state — and
their identical sets at 320 and 1280 stand.
