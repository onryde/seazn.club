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

## ~~Q1~~ ANSWERED 2026-09-06 — "we can add it as required"

The three fields go on the public payload. Recommendation (a) accepted.
**Owed:** a new **Task 0** at the head of the W1 plan — add the venue time
zone, cricket's balls remaining and the football match clock to the public
fixture payload, with the tests that fail without each. Then Task 2's
`overlayModel` reads all three, the start time formats in the venue zone
rather than UTC, the cricket chase line reads "Need 45 off 45" as
`_THEMES.md` §3 draws it, and football's `header.clock` is populated.
Deviations 4 and 6 in the W1 plan, and the "football clock unpinned" note,
are all closed by this answer.

## ~~Q2~~ ANSWERED 2026-09-06 — "we can remove"

The overlay segment does not render the cookie consent banner.
**Owed:** a step in the W1 overlay-route task that keeps `cookie-consent.tsx`
off the overlay segment, plus the check the recommendation named — confirm
nothing else on that segment sets a cookie, so "no consent needed" is true
rather than convenient. The `data-testid` the plan added for test
suppression stays, since the e2e still asserts the banner is absent.

## ~~Q4~~ ANSWERED 2026-09-06 — "we will plan it later on"

Pricing is deferred to launch. The key stays granted by no plan, out of
`ENTITLEMENT_DOMAINS`, with the test org enabled by an override row. When it
is eventually granted, the pricing copy in all four locales ships in the same
change. The owner added a directive about the hiding mechanism in the
meantime — see **Q14**.

---

## Q3. Should the overlay require the realtime entitlement? — ANSWERED IN PART

**Owner, 2026-09-06: "we are using supabase realtime."** Recorded. That
settles the transport: the overlay subscribes to the same Supabase private
channel the public page uses, which is what both wave plans already assume.

**What it does not settle.** Access to that channel is entitlement-gated, not
merely technical: `/api/v1/public/fixtures/[id]/realtime-token` returns 403
unless the fixture's org holds the `realtime` feature, and the client then
falls back to a fifteen-second poll. So an org with `streaming.overlay` but
without `realtime` would broadcast a score that lags the picture by up to
fifteen seconds.

**Resolution taken, needing no further answer today:** the test org's override
grants both keys, so the question cannot bite while the feature is hidden. The
coupling decision — whether every plan that grants `streaming.overlay` must
also grant `realtime` — is folded into the pricing decision at launch,
alongside Q4. Recommendation stands: grant them together.

---

## Q1 (original text, kept for the record). The public payload is missing three fields the overlay wants

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

## Q2 (original text, kept for the record — ANSWERED above). The cookie banner will appear on air

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

## Q4 (original text, kept for the record — ANSWERED above). Which plan eventually grants `streaming.overlay`?

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

## ~~Q5~~ ANSWERED 2026-09-06 — "Agree"

`m.youtube.com` joins the host allowlist. One entry plus its unit test.

## ~~Q6~~ ANSWERED 2026-09-06 — "Agree"

The stream panel's toggle is available at every fixture status, so a club can
attach the replay link after the final whistle. Gated on `canEdit &&
streamingEntitled` only, deliberately NOT on the schedule toggle's
`status === "scheduled"`.

## ~~Q7~~ ANSWERED 2026-09-06 — "we will have multiple theme per sports so make it abstract and use can choose for now apply the default one"

**Not the yes/no that was asked — a design change, and a good one.** Themes
stop being a two-value union and become a REGISTRY, so a sport can grow more
of them without touching a call site. What W1 must build:

- `OVERLAY_THEMES`, a registry keyed by theme id, each entry carrying its id,
  its dictionary label key, its component, and which sports it suits (all, or
  a named set). It holds `bar` and `bug` on day one; a third theme is one
  entry plus one component, never an edit to the route, the panel or the
  model.
- `defaultThemeFor(sportKey): ThemeId` — the per-sport default stays exactly
  as decided (cricket `bar`, every other sport `bug`), but it now lives in one
  function rather than being implied by a boolean.
- The URL parameter becomes `?style=<themeId>`, validated against the
  registry; an unknown or unsuitable id falls back to the sport's default
  rather than erroring, because an OBS browser source cannot be asked to
  correct a typo mid-match.
- The panel's style tabs render FROM the registry, filtered to the fixture's
  sport, so a new theme appears in the console the day it is registered. The
  club's choice is what it already was: a link, not stored state.
- `_THEMES.md` becomes the registry's content: §3 is theme `bar`, §4 is theme
  `bug`, and a future theme is a new section in the same shape.

**Owner's words are the ruling:** multiple themes per sport, abstract enough
to choose from, with the default applied for now. Nothing else about the two
shipped themes changes.

## ~~Q8~~ ANSWERED 2026-09-06 — "Ok"

Ship the three-letter fallback derived from the entrant's display name. No
short-name column; revisit only if clubs complain.

## ~~Q9~~ ANSWERED 2026-09-06 — "ok for own wave as put it last"

Sponsor logos become their own wave, scheduled LAST in the programme, after
W1 and W2. Not designed here.

## ~~Q10~~ ANSWERED 2026-09-06 — "Ok"

Volleyball gains set point and match point moments in W2, alongside its
set-won moment. Same probe the racket sports use.

## Q5 (original text, kept for the record — ANSWERED above). Should `m.youtube.com` be on the host allowlist?

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

---

## ~~Q14~~ ANSWERED 2026-09-06 — per-org override only

The owner chose the entitlement override as the hiding mechanism, over a
preview cookie and over an environment flag. **Nothing in either wave plan
changes**: both are already written against `streaming.overlay` granted by no
plan, absent from `ENTITLEMENT_DOMAINS`, with one
`org_entitlement_overrides` row revealing the feature to a single
organisation. The console panel is visible for that org only; the overlay
page returns 200 for it and 404 for everyone else; the pricing page shows
nothing. No proxy branch, no cookie, no environment variable.

If a demo on production without granting any club the feature is ever wanted,
option (a) below is the build to revisit.

## ~~Q16~~ ANSWERED 2026-09-06 — one service, with an overlay data path of its own

The owner asked whether the overlay should be its own service, feeding and
serving its pages alone. Assessment given: **no separate deployment**. The
overlay has one viewer per match, the club's capture browser, so the load
argument that normally justifies a split does not exist; a standalone service
would need its own copy of entitlement resolution, public visibility rules,
realtime token minting, database credentials, the four dictionaries and the
sport palettes, plus a second deploy target and its own secrets, to serve one
page with no customers yet. Owner agreed.

**What was taken from the idea:** the overlay gets its own DATA PATH inside
the app. `foldFixture(tx, fixtureId)`
(`apps/web/src/server/engine-db/fold.ts:58`) already folds a fixture's ledger
server-side and is already called by
`server/usecases/admin-fixture-config.ts`. An overlay endpoint calls the same
function and projects an overlay-shaped payload, using the engine rather than
changing it. This is **option (d) on Q15** and is expected to close it.

**The one real argument for a separate service** — a deploy or restart
mid-match blanking the overlay on a live broadcast — is answered by page
resilience (hold the last known score, reconnect quietly, never a white
frame), not by a second service that has the same deploy problem. Owed as a
step in the W1 overlay-route task.

## Q15. The football clock costs an engine change and a golden re-baseline — NEW, blocks Task 0

**This corrects a cost I gave the owner.** When Q1 was put to the owner I
said the three payload fields were "one additive payload extension plus its
tests, well under a day, and nothing existing changes". That was wrong for
one of the three, and the owner answered "we can add it as required" on that
estimate. The correction, verified in the tree rather than inferred:

- **The venue time zone is free**, as estimated: it rides on
  `getPublicFixture`'s return, resolved by the existing `resolveVenueTz`. No
  migration, no view change, no engine change.
- **The two in-match numbers cannot be added cheaply.** The live transport
  carries only `{ status, summary, outcome }`
  (`live-score-data.ts:7-23`), so a number that changes during play can only
  ride on the engine's `ScoreSummary`. That means editing `packages/engine`,
  which every other constraint in this programme was written to avoid.
- **The football clock additionally breaks a correctness property.** Football's
  `coarsen` deliberately strips `at` from a goal
  (`packages/engine/src/sports/football/football.ts:3029-3040`, verified), and
  the conformance suite asserts "coarse fold ≡ fine fold" for any module that
  declares `coarsen` (`packages/engine/src/testkit/conformance.ts:243-252`,
  verified). Carrying a clock derived from `at` changes the coarse stream, so
  the property fails until `coarsen` carries `at`, and four golden corpora
  need regenerating under `REBASELINE_GOLDEN=1` — which the repo's golden
  policy allows only as a deliberate, non-silent fold change, shipped as a red
  code commit plus an isolated re-baseline commit.

**Options.**

(a) **All three, as the folded plan now reads.** Accept the engine edit and
the golden re-baseline. Honest cost: days rather than hours, and it touches
the scoring core to serve a cosmetic feature.

(b) **Venue zone and cricket balls now, football clock deferred.** The
football bar ships without a clock until a later wave. Cheapest correct
answer; football is one sport of eleven, and `_THEMES.md` §3 would need a
note that the clock cell is empty for now.

(c) **Spend an hour first checking a cheaper route for the clock.** `coarsen`
passes `football.period` payloads through untouched (same function, the case
below the goal case), so a clock derived from the period's own start rather
than from a goal's `at` may need no `coarsen` change and no re-baseline at
all. If that holds, (a) becomes nearly as cheap as originally quoted.

**Recommendation: (c), then (a) if it holds and (b) if it does not.** An hour
of investigation is cheap against a multi-day engine change, and the answer
is binary. Argument against: it delays Task 0 by an hour and the answer may
be no, in which case (b) was reachable immediately.

## Q14 (original text, kept for the record — ANSWERED above). What exactly is the "header" that reveals the feature?

**Owner, 2026-09-06: "now we can plan to load only if header appears."**
Pricing is deferred, so a hiding mechanism is wanted in the meantime. Taken
as a directive; the mechanism needs one decision because a plain HTTP request
header cannot do this job in either place it would have to work.

**Why the literal reading does not work.** A browser cannot attach a custom
header to a normal page navigation, so the organiser console panel cannot be
gated that way; and OBS's browser source sends no custom headers either, so
the overlay page itself certainly cannot. The repo's only custom headers
(`x-seazn-org`, `x-seazn-locale`) are set by our own proxy, never by a client.

**Options that do work, in a browser and in OBS.**

(a) **Preview cookie.** Visiting the console with a magic query parameter,
say `?preview=stream`, sets a signed preview cookie; `proxy.ts` reads it and
sets an internal header the pages already trust, which is the closest honest
version of "load only if the header appears". The overlay page keeps its
entitlement check, since OBS carries no cookie either. Cost: small, one proxy
branch plus the cookie.

(b) **Environment variable.** A server-side flag reveals the feature in
whatever deployment has it set. Simplest possible, no per-user state, but it
is all-or-nothing per environment, so it cannot be shown to one club on
production.

(c) **Keep the entitlement override alone**, which already hides it
completely and is what both wave plans are written against. The override row
is per-organisation, so it can reveal the feature to exactly one club on
production, which is what a preview usually wants.

**Recommendation: (c), with (a) added only if you want the feature revealed
to a person rather than to an organisation.** The override already gives a
private, per-club reveal with no new machinery, and every entitlement surface
in this repo already reads it. A preview cookie is worth building when you
want to demo on production without granting a club anything, which is a real
but different need. Argument against (c): "header" was the owner's own word,
and (a) is what it maps to; if the intent is a demo switch for yourself
rather than a per-club grant, (a) is the right build and costs little.

**Blocks:** the W1 entitlement task and the console panel task, both of which
must know which gate they are written against.
