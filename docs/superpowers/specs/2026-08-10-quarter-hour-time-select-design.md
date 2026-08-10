# Quarter-hour time selection — design

Date: 2026-08-10
Status: approved (owner, this session)
Issue: none filed (standing rule: don't file new issues)

## The bug this exists to fix

`DateTimeField` sets `step={900}` on every `time` / `datetime-local` control
(#499, merged as `180378c6`). The attribute is live and the browser honours it:
measured on a real page in Chrome 151, `stepUp()` from `09:00` yields `09:15`,
and `09:34` reports `validity.stepMismatch: true`.

**Chrome's picker popup ignores it anyway.** The dropdown renders a full 0-59
minute column regardless of `step`. The popup is browser UI, not DOM, so no
markup we can write reaches it. Net effect: quarter-hour granularity exists for
the keyboard and not for the mouse, and clicking `:34` in the popup writes a
value the browser itself calls invalid — which nothing on the page checks, so
it saves.

Verified live rather than assumed:

```
Start date & time (datetime-local)  step="900"
End date          (date)            step=null      <- correct, step counts DAYS
Play from / until (time)            step="900"
stepUp() 09:00 -> 09:15
09:34 -> stepMismatch: true,  valid: false
09:30 -> stepMismatch: false, valid: true
```

## Approach

Replace the native clock popups with controls whose option list we own:

- `kind="date"` — unchanged native `<input type="date">`. Dates are not stepped
  and Chrome's calendar is already correct. A custom calendar is where the real
  cost lives (month nav, keyboard grid, locale week-start x4) and it buys
  nothing here.
- `kind="time"` — a native `<select>`.
- `kind="datetime-local"` — native date input **plus** the select, joined into
  the same `YYYY-MM-DDTHH:MM` string callers already pass.

A native `<select>` rather than a custom listbox: identical outcome (a list
containing only the offered times), but keyboard navigation, screen-reader
semantics and the iOS wheel come free instead of being hand-built. The repo
already chose native deliberately — `settings-panel` design decision 1.

Rejected alternatives, with the reason:

- **Snap on change** (round `08:40` to `08:45` after the fact) — cheapest, but
  it moves a time the organiser explicitly chose, silently.
- **`<datalist>` of quarter hours** — would have been a one-line fix with zero
  selector churn, but whether Chrome renders datalist entries in the time popup
  is unverifiable from here (the popup is invisible to Playwright). Not built
  on.
- **Custom listbox / fully custom popover** — days of a11y and mobile work to
  reach where a native `<select>` already is.
- **Reject-don't-snap** (block the save, localized error) — an error the user
  can only reach through the app's own picker reads as the app fighting itself.

## Units

Split so the rules aren't trapped inside a component that can't be tested.
`apps/web` is vitest `environment: "node"` with no jsdom; `datetime-field.test.tsx`
calls `DateTimeField(props)` as a plain function and walks the tree, which works
only because the component is hookless (`useId` already threw in that harness
once — see `_hook-harness`).

```
time-options.ts        pure, no React. every rule lives here.
  quarterHours()               -> ["00:00", "00:15", ... "23:45"]
  boardSlots(cfg)              -> startAt + k*(match+gap), within play hours
  filterByMin(opts, min, day)  -> same-day options below min removed
  splitValue(v) / joinValue(d, t)

DateTimeField          hookless, contract unchanged. kind="date" | "time".
                       kind="time" renders <select>, not <input type="time">.

DateTimeSplitField     kind="datetime-local". useState holds the half-filled
                       pair. Renders <DateTimeField kind="date"> + the select.
                       Emits "" upward until both halves are set.
```

The stateful shell is thin enough that its unit test is `renderToStaticMarkup`
on initial props — hooks render fine server-side. Everything with rules in it is
pure and gets the heavy coverage. Interaction is proven by e2e, which is where
it is provable anyway.

### Public contract

Added:

| Prop | Type | Used by |
| --- | --- | --- |
| `options` | `string[]` | the 3 fixture-level fields, passing board slots |
| `extraOptions` | `string[]` | the 3 registration deadlines, passing `["23:59"]` |

`step` (existing, seconds) now drives option generation instead of becoming a
DOM attribute. `value` / `onChange` / `min` / `label` / `disabled` / `required` /
`labelHidden` are unchanged, so the six call sites already on `DateTimeField`
change by zero lines.

## Option-list rules

Applied in order:

1. **Base list.**
   - Default `quarterHours()` — 96 entries, `00:00`-`23:45`. Literal `HH:MM`,
     not locale-formatted: it matches what the native controls already display
     and adds zero dictionary strings.
   - Fixture-level fields use `boardSlots(cfg)` — walk from the division's
     `startAt` in steps of `matchMinutes + gapMinutes`, clipped to play hours
     per day, bounded by the end date. On a 40/0 division: `09:00, 09:40,
     10:20, 11:00 ...`
   - `boardSlots` caps at **200** options. `matchMinutes: 1` with no play hours
     is a 1,440-entry dropdown otherwise.
2. **Fallback.** No config, no `matchMinutes`, or fewer than 2 slots produced ->
   quarter hours. Never an empty or single-entry select.
3. **`min` filter.** Same-day options below `min`'s time are dropped; a
   different day keeps the full list. Two live users: End date >= start date,
   and blackout `to` >= `from`. The server guard added in `19fdac2d` stays as
   the backstop — this only stops us offering what it will reject.
4. **`extraOptions` appended**, deduped. `23:59` sorts after `23:45` naturally.

**Outranking all four: the current `value` is always present in the list.** A
`<select>` whose value matches no `<option>` renders **blank** — an off-grid
time would look like the time had vanished, and saving would write empty. That
is a silent data-loss path and it fires without any prod data: place fixtures at
`09:40` on a 40/0 board, change match length to 30, reopen the fixture. So
`value` is injected if absent, sorted into place.

## Why fixture-level fields differ

Quarter hours are the wrong list on a board that isn't on a quarter-hour grid.
With **Match length 40, Gap 0** the auto-scheduler mints `09:00, 09:40, 10:20` on
every run — fresh data, not legacy. A quarter-hour select cannot express `09:40`,
so hand-nudging a match would move it onto `:45`, off the grid every other match
sits on.

Board-level fields (settings start, play hours, blackouts, division-builder seed,
AI wish chips, officials review) keep quarter hours: they define the grid rather
than living on it, and deriving the settings tab's own start time from a grid
computed out of the settings being edited is circular.

Fixture-level fields (`stages-panel` fixture `When` and add-match, `move-panel`)
get board slots.

## Timezone

`boardSlots` derives from `settings.startAt`, a stored **instant**; the slot list
is wall-clock strings. The conversion goes through the existing `zoned-datetime`
helpers on **`settings.orgTz`** — not `settings.tz`, which is display-only
(#448), and not the browser zone. Getting this backwards shifts a whole board by
an hour across a DST boundary.

## Half-filled state

Splitting one control into two creates a state the native input never had.

| State | Emits |
| --- | --- |
| both blank | `""` |
| date set, time `--:--` | `""` |
| time set, date blank | `""` |
| both set | `YYYY-MM-DDTHH:MM` |

No inline hint. Two labelled controls read as two controls, and where the value
is genuinely required the form's own validation already says so — most call
sites treat blank as normal (`constraints-panel:65` documents both halves being
blank). Accepted consequence: pick a date, leave the time, hit Save, and the date
is dropped silently — the same as typing a date with no time into today's native
control.

The select's leading `--:--` option means "no time" and is how the pair clears.

## Registration deadlines

The owner chose all 14 controls, registration deadlines included. A cutoff is
not a slot: a pure quarter-hour list tops out at `23:45`, so "entry closes at the
end of Friday" becomes either `23:45` (15 minutes of entries silently refused) or
`00:00` Saturday (the wrong day to every organiser). The `extraOptions` prop is
the escape — the three registration fields pass `["23:59"]`.

## Call sites — 14 controls

Convert from hand-rolled natives (8):

| File | Line | Kind |
| --- | --- | --- |
| `board/move-panel.tsx` | 52 | datetime-local (board slots) |
| `stages-panel.tsx` | 941 | datetime-local (board slots) |
| `stages-panel.tsx` | 1056 | datetime-local (board slots) |
| `registration-settings.tsx` | 130 | datetime-local (+ `23:59`) |
| `registration-settings.tsx` | 141 | datetime-local (+ `23:59`) |
| `registration-settings.tsx` | 325 | datetime-local (+ `23:59`) |
| `board/ai-wish-chips.tsx` | 301 | time |
| `board/ai-officials-review.tsx` | 744 | time |

Already on `DateTimeField`, zero-line changes (6): `board/settings-panel.tsx`
258/293/304, `constraints-panel.tsx` 555/565, `division-builder.tsx` 785.

`move-panel` sits inside the board, which already holds the config — one prop.
`stages-panel` does not, so it fetches the division's schedule settings once and
passes the slot list to both its fields; a failed fetch or a division with no
settings row falls back to quarter hours (rule 2).

## Tests — all four, per standing policy

- **Unit** — `time-options.ts` carries the weight: quarter-hour generation,
  `boardSlots` across play hours and the day boundary, the 200 cap, `orgTz`
  conversion, `min` filtering, join/split, value injection. Plus markup tests for
  both components. Then repairs to five existing suites that assert `step` or
  input types: `datetime-field`, `time-step-coverage`, `blackout-editor`,
  `division-builder-schedule-seed`, `schedule-settings-no-timezone`.
- **Regression** — three, each failing without the change: the picker offers only
  quarter hours; a 40/0 board offers `09:40`; a select never renders a value
  missing from its options.
- **E2E** — rewrite case (e) (`schedule-datetime-ux.spec.ts:545`, which asserts
  `step="900"` on inputs that stop existing). Repair six specs that `fill()` a
  `datetime-local` directly: `ai-architect:193`, `board-v3:341`,
  `division-date-order:57`, `division-schedule:94`, `reg-console:127` and `:128`.
  New case: fixture `When` offers board slots, not quarter hours.
- **Smoke** — `scripts/smoke.ts:9673` greps for clock inputs carrying `step`;
  retarget at the select's options.

`time-step-coverage.test.ts` exists specifically to fail when a clock input lacks
`step`. Its whole premise dies with this change, so it is rewritten, not patched.

## UI bar

Screenshots at 1280 / 768 / 320, no horizontal page scroll at any width. At 320
the date input and select do not fit side by side — they stack. The seven-width
e2e matrix (`mobile.spec.ts`) is the enforcement backstop.

## i18n

One new string: an `aria-label` for the time select, since the wrapping `<label>`
names the date half. All four dictionaries. Option text is literal `HH:MM` — no
keys.

## Risks

- The e2e `fill()` repairs across six specs are the largest churn and the most
  likely place this drags.
- iOS loses its native time wheel for a select wheel. Judged an even trade.
- `boardSlots` plumbing into `stages-panel` is the one place scope could grow
  past the stated files. If it does: stop and escalate, per standing rules.
