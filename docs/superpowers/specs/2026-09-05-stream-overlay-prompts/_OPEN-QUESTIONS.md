# Stream overlay — open questions for the owner

Raised 2026-09-05 after both wave plans were written and before any code.
Owner: "Let's do implementation later on, just note down all open questions
and raise."

Every row carries a recommendation, because a finding without one hands the
analysis back to the owner. Nothing here is decided; each is reversible by
one line from the owner. Answered questions move to `_INDEX.md`'s decision
log with the date and the owner's words, and are struck through here.

Ordering: Q1–Q4 change what a viewer sees and should be answered before W1
starts. Q5–Q9 can be answered during W1. Q10–Q13 are W2 or later.

---

## Q1. The public payload is missing three fields the overlay wants

**What.** The overlay reads the same public payload the match page reads.
Three things it needs are not on it: the venue's time zone, cricket's balls
remaining in the chase, and the football match clock
(`lib/public-site.ts:319-373` is the complete reader set; `ScoreSummary.detail`
carries no clock field).

**What a viewer loses.** A pre-match overlay prints the start time in UTC,
which is simply the wrong time for an Indian or Dutch club audience. The
cricket chase line reads "Need 45" instead of "Need 45 off 45", dropping the
number a chase actually turns on. Football ships with no clock, which every
televised football scorebug has and `_THEMES.md` §3 and §4 both draw.

**Options.** (a) One small task ahead of the overlay work adds all three to
the public payload. (b) Ship W1 without them: drop the start time entirely
rather than print UTC, accept the short chase line, accept a clockless
football bar.

**Recommendation: (a).** The clock and the balls-remaining are the two
most-watched numbers in their sports, and a wrong-zone time is worse than no
time at all. Cost is one additive payload extension plus its tests, well
under a day, and nothing existing changes. Argument against: it grows W1
before anything ships, and a club could live one release with a clockless
bug.

---

## Q2. The cookie banner will appear on air

**What.** The overlay is a public page, so the site's cookie consent banner
renders over it. In OBS that banner is composited into the broadcast and
goes out to every viewer until someone dismisses it in the capture browser.
The W1 plan adds a `data-testid` to `cookie-consent.tsx` so tests can
suppress it, but that does not help a real club.

**Options.** (a) The overlay route never renders the banner: the page sets
no cookies and reads none, so there is nothing to consent to. (b) Leave it
and tell clubs to dismiss it once in the OBS browser source.

**Recommendation: (a), and treat it as part of W1 rather than a follow-up.**
A banner burned into a club's stream is the kind of defect that gets
screenshotted. The overlay genuinely sets no cookies, so suppressing it is
correct rather than a workaround. Cost is small: one condition on the
segment. Argument against: someone must confirm no analytics script on the
public tree sets a cookie on that route; if one does, (a) is a lie and the
right fix is to keep that script off the overlay segment.

---

## Q3. Should the overlay require the realtime entitlement?

**What.** Without the `realtime` entitlement the public page falls back to
polling every fifteen seconds. The overlay inherits that. On a live stream,
a score that lags the picture by up to fifteen seconds is visibly wrong, and
viewers will read it as our bug.

**Options.** (a) `streaming.overlay` implies `realtime`: grant both together
and never sell the overlay to an org without it. (b) Allow the overlay on
polling and shorten its interval, say to three seconds, for overlay clients
only. (c) Ship as is.

**Recommendation: (a).** The feature's whole promise is a score that keeps up
with the picture. Selling it without realtime sells a broken version. Cost is
zero engineering, one line in whichever plan eventually grants the key.
Argument against: it couples two entitlements, so a future customer cannot
buy the overlay alone. That coupling is honest.

---

## Q4. Which plan eventually grants `streaming.overlay`?

**What.** By design no plan grants it today; the owner's test org gets it
through an override row, so nothing is customer-visible. That is the hiding
mechanism, not the pricing decision.

**Options.** (a) Decide later, at launch, and keep the key ungranted through
both waves. (b) Decide now so the pricing page and the paywall copy can be
written alongside the feature.

**Recommendation: (a), decide at launch, with one condition.** The repo's own
rule is that an entitlement row and the copy quoting it ship as one unit, so
whenever the key is granted, the pricing copy in all four locales lands in
the same change. Note the key is deliberately absent from
`ENTITLEMENT_DOMAINS`, which is what keeps it off the pricing page while
hidden. Argument against deciding late: sales may want the tier named
earlier.

---

## Q5. Should `m.youtube.com` be on the host allowlist?

**What.** The stream link accepts exact hostnames only: `youtube.com`,
`www.youtube.com`, `youtu.be`, Facebook's three, `twitch.tv`, `www.twitch.tv`,
`kick.com`, `www.kick.com`. A club that copies a link from the YouTube phone
app may paste an `m.youtube.com` URL and be told it is invalid.

**Recommendation: add it.** It is a real YouTube host, the club did nothing
wrong, and the unit test already pins the list so adding one entry is a
one-line change with a test. Argument against: every added host widens what
we will render as a link; `m.youtube.com` is genuinely YouTube, so the risk
is nil.

---

## Q6. Is the stream panel available for every fixture status?

**What.** The schedule-edit toggle beside it only appears while a fixture is
`scheduled`. The plan makes the stream toggle appear for any status, so a
club can paste the replay link after the final whistle.

**Recommendation: keep it available at every status.** Recorded as my call,
reversible. Value: the replay link is worth as much as the live one, and a
club that finishes a match cannot otherwise attach it. Argument against:
one more control on every row; it is behind an entitlement no customer has
yet, so the blast radius today is zero.

---

## Q7. Per-sport default theme

**What.** Cricket opens on the Broadcast bar, every other sport on the Corner
bug. The club can switch in the panel; this only sets which one it opens on.

**Recommendation: keep.** The lower third suits a two-innings score with a
chase line; the tile suits a set or period score. Reverse by naming the other
letter for a given sport.

---

## Q8. Entrant short names do not exist

**What.** The Corner bug shows a short code per side. There is no short-name
field: `public_entrants_v` (`V350:18-47`) carries `display_name` and
`team_display` only. The plan derives a three-letter code from the name.

**Recommendation: ship the fallback, revisit if clubs complain.** "Mumbai
Kings" becoming "MUM" is right most of the time and wrong occasionally.
A real short-name field is a registration-side change with its own migration
and admin UI, which is disproportionate to the benefit today.

---

## Q9. Sponsor logos on the overlay

**What.** Out of scope in the spec. Clubs with sponsors will ask, and the
competition already stores sponsor tiers.

**Recommendation: leave out of W1 and W2, revisit as its own wave.** Value is
real, because a sponsor logo in the broadcast is money for the club, but it
brings sizing, placement and per-tier rules that would delay the overlay
itself. Worth a decision once clubs are streaming.

---

## Q10. Volleyball set point and match point moments (W2)

**What.** The W2 allowlist gives volleyball a set-won moment but not set
point or match point, while the racket sports get both.

**Recommendation: add them.** A volleyball set point is exactly as dramatic
as a tennis set point, and the derivation is the same probe. Recorded by the
W2 planner as a recommendation, not applied, so the owner can decline.

---

## Q11. W2's dependency may land differently

**What.** W2's moments read event types the public payload does not carry
today. The spectator programme's W1 is expected to add them. Its plan
therefore carries a re-pin table with a named fallback for each row: derive
from `score_events` in our own helper.

**Recommendation: no decision needed now.** Flagged so nobody executes W2
before the spectator wave merges and every re-pin row is closed.

---

## Q12. Two unclassified test failures on the baseline

**What.** The fresh-database baseline for this worktree is 13,962 of 14,041
passing. Three reds are the placement service not running, which is the
documented environmental signature. Two reds in `pass-scoping-guard.test.ts`
("Event Pass grants are resolved with a competition in scope has no
enforcement site") are unclassified.

**Recommendation: reproduce on a clean detached checkout of the base commit
before W1 starts, and never fix it inside this programme's pull request.**
If it is pre-existing it belongs to whoever owns that guard. Cost of
checking is minutes; the cost of not checking is attributing someone else's
red to this work.

---

## Q13. Video embedded on our own match page

**What.** The second half of the original question: the stream playing on
the seazn match page with our scorebug over it, rather than only inside the
club's broadcast. Deliberately out of this spec.

**Recommendation: its own spec after W1 ships.** It carries a real product
problem this design does not: the video is delayed five to thirty seconds
behind our sub-second score, so the page would spoil the wicket before the
viewer sees it. Solving that needs a per-stream delay setting and event
buffering. Worth doing, worth doing separately.
