# W1 — whole-branch review findings

Four Opus reviewers, read-only, disjoint areas, against `origin/main...feat/spectator-surface`
at `2f3b4f9f4` (CI e2e 8/8 green at the time, unit 523/0). **All four returned
`needs-fixes`.** That a fully green branch produced this list is the point worth
keeping: every item below survived ~4,000 passing tests and an 8-job CI run.

Status legend: **FIXING** now · **QUEUED** for a follow-up wave · **CLOSED** (verified
not a defect).

---

## Blocking — crashes and disclosure on an ANONYMOUS public page

**B1 — the cricket config 500 was never actually fixed. FIXING.**
`match-centre-load.ts:310` safeParses the division config and falls back to the RAW
value; `match-centre.ts:949` then hard-`parse`d that same value. The earlier fix moved
the crash one frame later. Cricket was the only sport that could not survive a config
its schema rejects — a jsonb scalar, a SQL NULL, or a stored config predating a later
`.refine`. It was reported as verified on the strength of the Task-16 regression test,
which seeds `generic` and never enters the cricket branch. My error, and the exact
shape of "a test that cannot witness the thing it was written for".

**B2 — `deriveCricketScorecard` had no containment. FIXING.**
`buildTimeline` degrades and reports `derivedComplete: false`; the cricket branch threw.
The reducer's `invalid()`/`wrongPhase()` throw regardless of the read path's
`strict: false`, so ONE unfoldable event took down the whole public response for
cricket while every other sport kept rendering.

**B3 — masked people's raw person UUIDs ship in the anonymous document. QUEUED (needs
an owner ruling on the fix shape).**
`match-centre-schema.ts:12` carries `personId` for masked people, and it reaches
anonymous HTML as `data-testid="mc-bat-<uuid>"`. `public-site/data.ts:306` states the
opposite convention for the same surface ("`person_id: null` = no public-name consent")
and the player card gates on it. So a masked person is joinable to their consenting
full name in another division. `match-centre.test.ts:280` proves NAME masking only and
cannot see this. NOT a one-line fix: the ids are React keys and testids across four
components, so the replacement needs a stable per-document surrogate.

---

## Live product defects

**P1 — the fixture date line is English on every locale. FIXING.**
`fixture-subheading.ts:55` hardcodes `toLocaleString("en-GB", …)`, so a scheduled
fixture reads "Monday 20 July, 14:30" for fr/es/nl orgs. Both other branches of that
same function were localised THIS SESSION and this one was walked past.
Two tests should have caught it and structurally cannot:
`page.test.ts:351`'s describe is titled "no hardcoded English leaks outside lang=en"
and renders only fixtures with `scheduled_at: null`; and
`fixture-subheading.test.ts:41` asserts the date branch with three NEGATIVES only, so
no test in the repo pins what that branch actually produces.

**P2 — band 2 lets a run-out be credited to a bowler. QUEUED (engine).**
`cricket.ts:1806-1826`'s `applyPlayerLine` checks only the boundary arithmetic and
`out === true`, so `{kind:"runout", bowler:"a7"}` is accepted and printed as
bowler-credited; band 3 refuses the identical payload at `cricket.ts:1375-1378`.
`generatePlayerLine` actively mints it into the golden corpus. Nothing checks the
dismissal's bowler/fielder are even in the fielding lineup, which band 3 does.

**P3 — the cricket branch ignores the division's pinned module version. QUEUED.**
`effectiveBand(events, cricket, …)` uses the module SINGLETON while the non-cricket
branch honours `moduleVersion`. A division pinned to an older cricket module is read
with the latest fold. See A1 — this is the concrete cost of the `sportKey === "cricket"`
branch, not a style complaint.

**P4 — payload-keyed tallies can contradict the state-keyed numbers beside them.
QUEUED (engine).** `scorecard.ts:330` takes `dismissal.bowler` from the payload while
the reducer credits `fine.currentBowler`, so one card can read "c a3 b a8" while the
bowling row gives that wicket to a7 (`scorecard.test.ts:1189` already proves the
divergence is reachable). Same class at `:310` (a phantom `a8 0.0 0 0 0` row for a
bowler who never bowled) and `:713` (extras re-summed from payloads when
`fine.extras` already holds it).

**P5 — duplicate React keys and testids when a super over reuses an innings number.
QUEUED.** `scorecard-tab.tsx:515` keys on `entry.number`; `commentary-tab.tsx:22-29`
states this precondition in its own words and fixes it by array index. Duplicate keys
on sibling `<details>` mis-reconcile `open`. Its test gives the super over
`number: 3`, and the colliding fixture is used only by commentary — untested by
construction. Same for `mc-bat-/mc-bowl-${personId}` across innings, and
`timeline-tab.tsx:158`'s `seq`-keyed ids where the file's own note says a derived line
shares its cause's `seq`.

**P6 — a non-cricket fixture in play with no breakdown renders an EMPTY Summary panel.
QUEUED.** `live-score.tsx:154-162`: `emptyStateKey` is null when `inPlay`, which is the
same defect the comment above it says it fixed, left open for a different status.
Football before its first period event hits it.

---

## Inert seams — the class that has now shipped three times on this branch

**S1 — `MatchCentreProps.locale` is declared and never destructured. FIXING.**
Third occurrence. Found earlier this session, used `header` fields instead, and never
went back to delete it.

**S2 — `useLiveFixture` returns `updatedAt` and nothing reads it. FIXING.**
`court-card.tsx` deliberately uses `header.updatedAt`; the sole production caller
destructures `{ data, transport }`.

**S3 — `info.calendarHref` can never render. QUEUED.** Both producers hardcode
`hrefs.calendar: null`, so `info-tab.tsx:99`'s `mc-info-calendar` link is unreachable
in production. Renderer exists, producer never sets it.

**S4 — `Person.masked`, `Side.colour`, `Side.badgeUrl`, `derivedComplete` have no
production consumers. QUEUED.** `colour`/`badgeUrl` are documented W2 deferrals;
`masked` and `derivedComplete` are not.

---

## Duplicated authorities created by this branch

**D1 — `currentPhaseOf` (`timeline.ts:660`) is byte-identical to `matchPhase`
(`lib/public-site.ts:357`). FIXING.** Both added by this wave, in the same session,
and `timeline.ts` already imports from that module. Two authorities for `detail.phase`
shipped in one branch — while the commit message argued against exactly that.

**D2 — `SHOOTOUT_IS_SKATED` duplicated verbatim** in `match-centre.ts:590` and
`lib/scoring-vocab.ts:1339`. QUEUED. A third skated sport moves one copy and the court
card and the share sentence disagree about the same match.

**D3 — the OpenGraph card and the page title compose the score from different
sources.** QUEUED. `opengraph-image.tsx` uses `summary.headline`; `generateMetadata`
now uses `matchCentre.header`. Two authorities for one shared link.

---

## Tests that cannot fail

**T1 — `shotAllTabs` writes ZERO screenshots and both "screens" tests still pass** when
`[role="tab"]` returns empty. FIXING (one-line floor assertion). This is AGENTS #10's
vacuous visual gate, in the helper the whole R11 sign-off runs through.

**T2 — "the newest ball must appear on the already-open anonymous page"** is satisfied
by balls rendered BEFORE the taps. QUEUED. Green with the live transport deleted. The
three witnesses after it do have teeth, so R10 still holds — this line is decoration.

**T3 — `scorecard.test.ts:411`** recomputes the implementation's own expression,
rounding included, so it cannot witness a rounding change. QUEUED.

**T4 — `scorecard.test.ts:1227`'s `?? 0`** makes "no row" and "a row showing 0" the
same pass — blinding the one test positioned to catch P4's phantom row. QUEUED.

**T5 — the R1 control-set diff samples only the Summary tab.** QUEUED. A phone-only
control added to any other panel is invisible to it.

---

## Stale comments that would misdirect the next reader

**M1 — `spectator-public-2.spec.ts:487`** declares a LIVE defect ("tab rail ~32px,
short of 44px, not fixed"); `tab-rail.tsx:102` now carries `min-h-11`. FIXING.
**M2 — `:659`** declares two live SERIOUS axe contrast violations; the offending class
is gone from public-site entirely. FIXING.

---

## Accessibility — QUEUED as a group

Numeric `<th>`s localise only via `title` (unreachable on a phone, and `<th>` text wins
the accessible name) while `scorecard-tab.tsx:196` does the same job correctly; name
cells are `<td>` not `<th scope="row">` in four places (`sets-tab.tsx:164` is the only
one right); the `role="tabpanel"` wrapper has no `tabIndex={0}` though info/timeline
panels hold no focusable element; no roving tabindex, so a 6-tab rail costs 7 tab
stops; `aria-controls` dangles for the 3-5 panels not in the DOM; `action-form.tsx:120`
chips have no accessible name; a super over produces two landmarks with identical
accessible names.

---

## Architecture — raised by the owner, recorded here

**A1 — `if (sportKey === "cricket")` should be a `SportModule` capability.**
`SportModule` IS the strategy interface and the non-cricket path already uses it
(`resolveModule` → `buildTimeline({ module })`, no sport names). The cricket branch is
the ONLY `sportKey === "cricket"` in the whole public-site tree, and it exists because
`deriveCricketScorecard` has no slot on the interface. Its real costs are P3 (version
pinning silently lost) and B2 (the degrade path had to be hand-written instead of
inherited).
**Recommendation:** a `scorecard?(cfg, events, lineups)` capability on `SportModule`,
at the FRONT of W2 — W2 adds more per-sport public surfaces and would pay for it
immediately. Not inside this fix round: it is an engine interface change touching every
module and its conformance suite, and mixing a refactor into a review-fix round on a
branch that is currently green is how both get harder to judge.

---

## Verified sound (stated so it is not re-litigated)

All four locales' key sets identical with zero `{param}` drift; the 88 apparent orphan
keys are template-constructed and enumerated by `match-centre-dictionary.test.ts`; no
route under `(public)/shared/**` exports `dynamic`, anchored at statement position;
`scanPadContrast` folds `critical` into `serious` so the axe test's title is accurate
and its zero-node guard is real; both spectator specs are registered in
`WALKTHROUGH_SPECS`; `scorepad-v3-cricket-lines.spec.ts` pins full deep-equal payloads.
Engine side: the maiden definition, every divide-by-zero guard, the super-over offset,
the retired-out path, and batting order taken from the pre-ball payload rather than
post-rotation state.

---

## Fix round — dispositions

**Fixed on this branch:** B1, B2, B3, P1, P2, P3, P4, P5, P6, S1, S2, S3, D1, D2, T1,
T3, T4, M1, M2, and the accessibility group.

**T2 — fixed.** The assertion read `.first()` of the ball testids and checked it was
visible, which is true of any innings containing a ball; it stayed green with the live
transport deleted. It now captures the ball ids on screen BEFORE the taps and polls for
one that was not among them — compared as ids rather than counts, because an over that
rolls can leave the count unchanged while the content moves.

**T5 — fixed.** Only the ACTIVE tab's panel is in the DOM, so the R1 control-set diff
could only ever see the Summary tab. It now sweeps every tab at both widths and compares
per tab, and runs the horizontal-scroll check on each — previously Summary-only too.

**New — the tab rail's keyboard path had no browser coverage.** The accessibility group
introduced a roving tabindex (`tabIndex={isActive ? 0 : -1}`). That pattern is only
correct WITH arrow-key handling, and `handleKeyDown` does have it — Arrow/Home/End,
`onChange` plus `.focus()` on the new button. But `apps/web` vitest is
`environment: "node"`, so every test of it is a markup scan: delete the arrow handling
and the markup is byte-identical while a keyboard user loses every tab except the
selected one. Every other tab assertion in the suite clicks. Added a browser test
asserting one tab stop, that arrows move selection AND focus together, that Home/End
reach the ends, and that the tab stop count stays at one afterwards.

**Also fixed:** the `mc-bat-<personId>` → `mc-bat-<inningsPosition>.<personId>` rescope
broke four e2e call sites. Three take a `\d+` position. The fourth,
`spectator-public-2.spec.ts`'s masked-consent block, selected rows BY
`maskedPersonId` — it was asserting the very leak B3 removed, and could not be repaired
by adding a prefix. It now finds the rows by masked LABEL and gains the half that was
missing: the real id appears nowhere in the raw MARKUP (checked against `page.content()`,
not `toContainText`, because the leak was in an attribute), and the row still carries a
surrogate, since "no real id" and "no id" are different fixes and only one keeps the
row's React identity across a live update.

**D3 — QUEUED, and now an argued deferral rather than an unexamined one.** The OG card
composes from `summary.headline`; the page title composes from `matchCentre.header` via
`scoreAndResultFor`. Two things settle this. There is no consent exposure: every engine
`summary.headline` is numeric (`cricket.ts`, `football.ts`, `period/kernel.ts`,
`setbased/kernel.ts`, `carrom.ts`, `boardgame.ts`, `generic.ts` — scores and a shoot-out
tally, never a person's name), so the OG route cannot publish a name the page masks.
And the two strings answer different questions — a headline card versus a score-plus-
result title. Unifying them means the ISR image route building a full match-centre
document where it currently reads one denormalised field. W2 work, not a W1 blocker.

**S4 — QUEUED, partially stale.** `Side.colour`/`badgeUrl` remain documented W2
deferrals. `Person.masked` is no longer unused: B3's surrogate fix made it load-bearing,
and the consent sweep asserts on it. `derivedComplete` is still unconsumed.

**`term.short.H1/H2` — fixed.** fr `1re`/`2e`, es `1.ª`/`2.ª`, nl `1e`/`2e`, each
derived in the test from that locale's OWN prose `term.H1/H2` ("1re mi-temps",
"1.ª parte", "1e helft") rather than typed into the test, so a change to the source of
truth moves the expectation with it. Root cause worth keeping: `sets-tab.tsx`'s note 5
asserted the whole `term.short.*` family is "identical in all four locales because it is
notation". That is true of `Q1`/`P3`/`ET1`/`SO` and false of the two ordinals — a
comment that was a hypothesis, believed, and wrong for three locales. Comment corrected.

**`mobile.spec.ts` setup — fixed.** The file is `mode: "serial"`, so a red in `setup:`
aborts roughly 110 tests across all seven width projects; it is also the heaviest block
in the file and ran on the config's plain 60s while lighter blocks below already asked
for 90s. Raised to 180s. A blown budget there would have reported itself as whatever
`expect.poll` happened to be in flight (AGENTS rule 20), and cost the whole file.

**Accessibility, second pass — fixed.** `action-form.tsx` (the pad's — there is no
`public-site/action-form.tsx`; the review's path was wrong) chip rows are now a
`role="group"` named by `aria-labelledby` at the caption they already render, so the
visible label and the accessible name cannot drift and no fifth locale string is owed.
The batting/bowling `role="region"` landmarks now take the 1-based ARRAY POSITION, not
`innings.number` — a super over reuses a number, which is what produced two landmarks
with one name.

---

## Found while fixing, not in the original review

**P2 reached outside the engine, and neither engine lane could see it.** Both were
scoped to `packages/engine`. `PadAttributionItem.requiresField` gates only the PAYLOAD
BUILD (`view-model.ts`); `action-form.tsx` maps `action.attribution` unconditionally, so
the RENDER is ungated. After P2 a scorer can tap "How out → Run out", see the Bowler
chip row, name a bowler, and have the engine refuse the event — a dead end mid-match, on
a surface whose own programme rule is "never offer what the engine will refuse". Before
P2 the same taps folded silently and the public scorecard credited a run-out to a
bowler. Half of this fix is worse than neither half, so the pad side ships with it:
an additive optional `requiresFieldIn` on `PadAttributionItem`, gated in BOTH the build
and the render, with cricket declaring it from the one shared `BOWLER_CREDITED_KINDS`.
Recorded because it generalises: a guard tightened in the engine is a change to what the
PAD may offer, and the pad's offer list is not derived from the guard.

**The "seven hardcoded labels" premise was false, and the true defect is bigger.**
Nothing is hardcoded: an uncaptioned `PadField` falls through to
`deriveFieldPathLabel(field.path)`, which word-splits the dotted path into English —
so the copy is English in all four locales and there is no string to grep for. It also
cannot be half-shipped: `scoring-vocab.test.ts` ties `PAD_LABEL_KEYS` to what modules
actually emit, so the engine `labelKey`s, the key list, four `ui.json`s and `gen-keys`
move as ONE change. A review that greps for English strings cannot see this class at
all.
