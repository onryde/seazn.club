# Recording detail — two options for sign-off

Both drop the lock, the amber and the plan name; neither has anywhere left to put an upsell. Both draw the four bands as a **ladder** — each band contains the one below it, so "how much detail" is a level, not four unrelated tabs. Real pad (football, 2nd half), real dictionary labels, honest tile grids: 4 actions at band 0, 20 at band 3.

## Option A — the detail gauge (`chip-option-a.html`)
One row of four: at or below your choice is tinted, the choice is solid, above it stays white —
the row reads as a filling level.
- **Taps to change band: 1.** Any band is one thumb away, always.
- **At 320:** tight but honest. Gauge 294×71px, segments 73×56 (over the 44 floor). All four real
  labels wrap to 2–3 lines at 11px; "Cards & key moments" sets the height at three. Height is
  pinned constant across states (the check line is reserved when unchecked), so changing band does
  not shift the tiles under a moving thumb.
- **A11y:** `radiogroup`/`radio` + `aria-checked`; active carries a check glyph and 650 weight, tinted segments swap label colour *and* weight. No hue-only state.
- **Weakness:** ~78px of vertical pad, and the busiest non-score element on screen, for a setting most scorers touch once.

## Option B — the compact chip (`chip-option-b.html`)
A 44px pill — four-rung meter, "Recording", the active band, chevron — raising a sheet of four
full-width rows.
- **Taps to change band: 2** (open, choose); 3 if you open it and back out.
- **At 320:** comfortable. Chip 294×44, longest label untruncated. Sheet rows 294×60, label on one
  line, "8 actions on the pad" beneath. Does not get worse as the screen narrows.
- **A11y:** `aria-haspopup="dialog"` + `aria-expanded`; sheet is a radiogroup, selected row carries a check and heavier weight; meter rungs read fill-vs-outline, not hue.
- **Weakness:** collapsed, it never says the other three bands exist — hiding a free giveaway behind a tap leaves most volunteers on the fixture's default.

## Recommendation — Option A
Take the 27 extra pixels. This change exists so a volunteer can discover mid-match that they can
drop to four buttons; A shows that escape route without being opened, takes one tap, and teaches
the ladder better than any sheet title can.

**Strongest argument against it:** at 320 — where scorers actually are — A is a 71px slab of
three-line 11px fragments between the scorebug and the tiles, while B is one quiet line giving each
band a full-width, one-line, 60px row that is easier to read and hit. If band is chosen at kickoff
and rarely revisited, B is the better shape and A pays rent all match for a first-minute decision.

**Not decided here:** "N actions on the pad" and "How much detail are you recording?" are new copy
— 4 locales + `gen-keys` if either survives. Light theme only (no toggle exists in the product).
