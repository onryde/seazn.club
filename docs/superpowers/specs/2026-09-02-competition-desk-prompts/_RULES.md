# Competition desk — standing rules

Read this before touching the competition page, the division ledger, the
derived phase, or the fixtures tab. These are rulings that are **not derivable
from the code**, each paid for by a defect that shipped or nearly shipped.

Design of record: `../2026-09-02-competition-desk-design.md` (read its three
amendments — they are binding, and two of them exist because the original rule
was wrong).

## The model

- **Phase is derived; attention is orthogonal.** `DivisionPhase` is
  `setting_up | scheduled | match_day | finished` and answers "where is this
  division in its life". `Attention` answers "what does it want from me", has a
  fixed severity, and a red attention **outranks the phase** on a pill. A row
  may be `finished` with no attention, or `scheduled` with a red one; the two
  never contradict each other and must never be collapsed into one enum.
- **The governing clock is the ORG zone** — `resolveVenueTz(null,
  organizations.timezone)`. `schedule_settings.tz` is the DISPLAY zone and
  formats HH:mm only. Every date-key computation (what counts as "today") uses
  the org zone. Getting this backwards moves a fixture between days for
  everyone in a different timezone from the venue.
- **A phase rule set whose tests are all "does the set contain X" needs an
  explicit empty case, stated FIRST.** The empty set answers no to every
  question and lands on whatever the default is. This wave shipped THREE
  vacuous-truth defects of exactly this shape before the rule was written down
  (see the index): an empty division read "finished"; an empty competition read
  "Finished · 0 divisions" above its own "No divisions yet"; a started division
  with no fixture times read "Scheduled · nothing scheduled". Any further
  aggregate (org, season) states its empty case before its ladder.

## Identity and layout

- **The sport icon lives on division rows, never on the competition masthead.**
  A competition can span sports, so its sub-line names them as TEXT
  ("Football · 2 divisions"). A row uses the uploaded division logo when one
  exists (`resolveLogoUrl`), otherwise `sportEmoji(sport_key)`, never a letter
  monogram. Owner ruling, 2026-09-02.
- **Mobile is designed, not shrunk.** Below `md` the division row is its own
  composition — whole card is one link, pill beside the name, full-width bar,
  status line WRAPS, one full-width >=44px action only when a red attention
  exists, and no "Open" button or "⋯" menu. It is not the desktop grid
  reflowed. Owner ruling in this wave, and now repo-wide policy (`1a0c948b9`).
  A width-shrink of a desktop table is a defect here, not a starting point.
- **Cross-row alignment is ledger-level, not row-level.** The desktop grid
  template is chosen ONCE for the whole ledger; picking it per row misaligns
  the columns the moment one division has a next fixture and another does not.

## Copy

- **Counted strings go through `plural()`** (`lib/i18n-runtime.ts`,
  Intl.PluralRules, `.one`/`.other`, `{count}`) — 132 keys already do. Five
  desk strings shipped as "1 fixtures" / "1 registrations" / "1 divisions" /
  "1 entrants" before this was enforced.
- **Never let a verb agree with an interpolated free-text name.** Stage names
  are user-typed and usually plural — "Finals", "Quarter-finals", "Playoffs" —
  so "{stage} has no draw yet" renders "Finals has no draw yet". Reword so no
  verb agrees with the variable.
- **An empty cell is not information.** A line that renders "Nothing scheduled
  next" on every settled row, or "· 0 in play" on every match day, is noise;
  suppress the clause rather than print the zero.
- All four locales (`en`, `es`, `fr`, `nl`), real translations rather than the
  English copied, then `npm run i18n:gen-keys` (root script; `i18n-keys.ts` is
  GENERATED) and `npm run i18n:check`. `content/help/**` is English-only.

## Verification

- **A claim about what a PERSON SEES is settled by driving the product.** Every
  defect that mattered in W1 was found by loading a page and reading it: the
  three-fact contradiction, the empty-competition pill, the copy agreement
  bugs, the dead grid track. None was found by a suite, and several survived
  suites that were green, mutation-tested and reviewed.
- **A picture proves a state was REACHED, not that it is RIGHT.** The W1
  walkthrough photographed the Critical defect at step 3, and a reviewer opened
  that screenshot and reported it "matches its claimed state".
- **Check an assertion is REACHABLE, not merely well-formed.** Three W1
  regression guards asserted the absence of "Nothing scheduled yet" — a string
  owned by `entity-card.tsx`, which this page no longer renders. They were
  enumerated correctly by a reviewer and still could not fail.
- Zoom into the component under test. Full-page screenshots hide alignment,
  duplication and truncation defects; the owner found several that way after a
  full-page shot had been signed off.
- **Print the asserted CONTENT beside every gate result.** A width or scroll
  gate cannot tell you it measured the wrong page STATE. A probe here reported
  "no horizontal scroll" at 320/768/1280 on a page that was never in the state
  under test — its setup calls had silently failed (stages 400 on a wrong body
  shape, generate 404 on a wrong route, start 422) — and every width passed
  cleanly. It was caught only because the row's text was printed next to the
  gate and read "Setting up · 4 entrants" instead of the six-fixture state.
  A green gate on the wrong state is worse than a red one. Build API setup from
  `e2e/helpers.ts` (`createStageAndGenerate`, `:1183`), never invented shapes.
- **Hit-test, do not measure.** `boundingBox()` reports paint, not hit area: a
  control can measure 44px and still be untappable under an overlay. Take the
  element's centre and check `document.elementFromPoint` resolves to it or a
  child.
- **To prove a surface is DESIGNED for mobile rather than shrunk, compare the
  visible CONTROL SET at both widths, not the box sizes.** Same set with
  smaller boxes is a shrink; different sets is a composition. Measured on the
  division row: 320 shows two controls (the whole card body as one link, plus a
  full-width action) and 1280 shows three (name link, "Open", "⋯"). A
  screenshot cannot distinguish these two cases; the DOM can.
- **Driving a page has two traps that both report a FALSE DEFECT.** (1) The
  desk renders dual mobile/desktop DOM, so an unqualified locator resolves to
  the hidden variant — `[data-testid="desk-needs-you"] a` picks the mobile
  button at 1280 and the click times out on "element is not visible". Use
  `:visible`. (2) `waitForLoadState("networkidle")` can resolve BEFORE a
  client-side navigation begins, so `page.url()` reads the old URL and the
  action looks dead. Use `waitForURL`. Both of these made a working "Compute
  proposal" button look broken here, twice, before the script was fixed.
  Dismiss the cookie banner deterministically too — a `try/catch` click with a
  short timeout leaves it overlaying the control.
- **A DOM sweep, not a screenshot, settles whether a control is labelled.** The
  tools row LOOKS like bare glyphs at 320; a sweep of `main` for controls with
  no text, no `aria-label` and no `title` returned zero. "Unlabelled" and
  "visually icon-only" look identical in a capture.
