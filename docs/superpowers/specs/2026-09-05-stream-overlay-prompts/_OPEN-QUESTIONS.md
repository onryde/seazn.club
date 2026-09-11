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

**Q17–Q19 were added 2026-09-10 and belong to the RELAY tier (R0/R1/R2), not
to the overlay waves.** They come from the relay signal-path register
`_FINDINGS-2026-09-10-relay-signal-path.html` and each carries its register id
so the row is auditable back to it. They sit after Q13, ahead of the struck
Q14, because two of the three are already ruled. **Q17 is now ANSWERED
(2026-09-11) and the live relay questions are Q20 and Q21, both raised by the
measurements that answered it.**

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

## ~~Q17~~ (register U1) ANSWERED 2026-09-11 — the hold window IS `recording.timeoutSeconds`

**What.** Nobody knows. Cloudflare documents `timeoutSeconds` as governing when
a disconnect starts a new recorded **video**, and it is nested under
`recording`; neither it nor the Stream Live write-up says whether the WHEP or
RTMPS **playback** connection stays open and starves, or closes, while the input
is away. The whole composited tier's "the encoder never restarts" property rests
on the answer, so this is load-bearing and, today, unobserved.

**The experiment** (ten minutes, once there is an account): attach a player to
the playback URL, kill the encoder, watch thirty seconds.

**Why it must be answered BEFORE R2 and not during it.** If the pull CLOSES, the
slate has to be driven by reconnect logic rather than by frame starvation — the
same outcome for a viewer, different code, and much harder to retrofit once R2
has hardened around the starvation shape.

**Status: ANSWERED 2026-09-11.** The owner provisioned the account, subscribed
to Stream and issued an account-owned token; the spike ran the same evening
against the live API. Full method and numbers in `_INDEX.md` § "U1 step 2"
(findings U1-S5 … U1-S8).

**The answer.** The playback side STARVES, it does not close — for exactly
`recording.timeoutSeconds`, which turns out to be the control for BOTH the
recorder and the live playlist. Inside the window the playlist stays live-marked
and simply stops advancing, so a player runs its buffer down and waits. At the
deadline the variant gets `EXT-X-ENDLIST` and the master returns `204`.

| gap | `timeoutSeconds` | `ENDLIST` | resume lag | recorded videos |
|---|---|---|---|---|
| 60 s | 10 | cut +12.2 s | — | 2 |
| 90 s | 60 | cut +63.1 s | resume +27.1 s | 2 |
| 20 s | 60 | never | resume **+3.9 s** | **1** |

So the frame-starvation shape this question feared losing is the RIGHT one, and
the slate is driven by "segments stopped arriving" rather than by a reconnect or
an error event. An in-window dropout is invisible: one continuous recorded video,
same URL, under four seconds to recover.

**But the question's own premise moved.** It asks what "the WHEP or RTMPS
playback connection" sees. **WHEP is not available to this architecture at all**
(U1-S5): Cloudflare refuses `/webRTC/play` on an RTMPS/SRT-ingested input with
`409 "Live broadcast not started yet"`, and documents that WHIP and WHEP must be
used together. The compositor pulls LL-HLS. That is a larger change than this
question anticipated and is carried in the design's transport amendment (§3).

**Consequential follow-on, now the live one:** `timeoutSeconds` is a product
decision — it IS the phone-dropout tolerance, and it and the sweep's
dead-stream threshold are ONE decision. See Q20.

---

## ~~Q20~~ (from U1-S7) RULED 2026-09-11 — 180 s. How long may a phone drop without the stream ending?

**What.** `recording.timeoutSeconds` is now known to BE the dropout tolerance
(U1-S7), and it accepts 1 … 86 400 s. Inside it a dropout is invisible; beyond
it the stream is declared over, a second recorded video opens, and recovery
costs ~27 s on top of the outage. Nothing in the programme has chosen a value.

**Why it is an owner call, not an engineering default.** It trades two real
things against each other. A long window means a club whose phone dies in a
tunnel, or whose battery is swapped at half time, resumes as if nothing
happened. A short one means an abandoned stream is recognised as over sooner,
and the sweep can reclaim it. The two cannot both be maximised, and the sweep's
`stale > 90 s` threshold (§6.4) was chosen when this field was believed
irrelevant to playback — so they must now be decided TOGETHER.

**Recommendation (mine, as product owner, not a ruling):** **180 s.** Long
enough to cover a half-time phone swap, a walk behind a stand, or a cellular
handover, which are the realistic failures; short enough that a genuinely
abandoned Sunday-league stream is not held open for an hour of a club's storage
and a viewer's spinning player. It also sits comfortably above §6.4's 90 s stale
threshold rather than fighting it, which means the sweep's "stale" state becomes
"we think this is over" and `timeoutSeconds` remains "the platform agrees" —
two observations in the same direction rather than a race.

**OWNER RULING, 2026-09-11: 180 s — the recommendation accepted as put.**
`recording.timeoutSeconds = 180` on every live input.

**Owed:** §6.4's stale threshold re-derived against the chosen value,
and R1's adapter pinning it as a named constant with the echo asserted (0 is
silently swallowed — U1-S8).

---

## ~~Q21~~ (from U1-S4) RULED 2026-09-11 — keep 7 days, delivered by our own cron

**What.** Design §12 sets `deleteRecordingAfterDays = 7` so the prepaid storage
block recycles. **The API floor is 30** (`400 / 10060`, measured 2026-09-11),
and so is the other native mechanism: a video's `scheduledDeletion` "must be at
least 30 days from upload time" (Cloudflare API reference; raised by a peer
session 2026-09-11 and verified here). **So NO native Cloudflare mechanism can
express retention under 30 days.** `DELETE /stream/{video_uid}` has no minimum
age — this spike deleted ten recordings minutes old — so sub-30-day retention is
OUR CRON OR NOTHING, which promotes the sweep from tidy-up to load-bearing for
the storage bill.

**The capacity shape, which decides how much this matters.** The block is
PREPAID CONCURRENT CAPACITY ($5/month per 1,000 stored minutes), not a monthly
allowance — measured directly: usage read `8.91 / 1000` with ten recordings
present and returned to `0 / 1000` the moment they were deleted. So retention
length, not monthly volume, is what fills the block. At the 30-day floor a
1,000-minute block sustains roughly 11 ninety-minute matches held concurrently,
i.e. ~11 per month; with an own-sweep at, say, 2 days the same block covers a
far higher match rate because almost nothing is stored at any instant. That
asymmetry is the whole argument for lever (c).

**Three levers.**
(a) Buy more blocks — $5 per 1,000 minutes, linear, solves nothing structurally.
(b) `recording.mode: "off"` for the COMPOSED tier, whose Cloudflare recording
nothing reads: RD10 fills `stream_url` from the DESTINATION's VOD URL. Storage
question disappears for that tier.
(c) Our own sweep calling `DELETE /stream/{videoId}` at the intended age —
already inside the Stream:Edit scope the programme holds.

**Recommendation (mine, as product owner, not a ruling): (b) AND (c).** Turn
recording off for composed, because paying to store a copy nobody reads is pure
waste; keep (c) as the backstop for passthrough, where a club may genuinely want
the Cloudflare recording and 30 days is longer than we want to pay for. (a) only
if a real product reason for keeping composed recordings appears.

**OWNER RULING, 2026-09-11: retention stays 7 days, delivered by lever (c) —
our own cron issuing `DELETE /stream/{video_uid}`.** Recording is NOT turned off
(lever (b) declined): the club keeps its Cloudflare recording on both tiers, and
the 7-day intent from §12 is preserved by deleting at 7 days ourselves rather
than by a field that cannot express it.

**`deleteRecordingAfterDays: 30` is ALSO set, as a backstop — CONFIRMED by the
owner 2026-09-11** ("set 30 and we will create a cron to clean up in 7 days").
It is the lowest value the API accepts, it costs nothing while the cron is
healthy, and if the sweep ever stops running the recordings expire at 30 days
instead of never — so a broken sweep becomes a larger bill rather than an
unbounded one.

**The owner is taking the cron itself.** The `schedule:` half belongs in
`onryde/seazn.club.workflow` (`d53d87024`); this repo owes only
`POST /api/cron/relay-sweep` (design §6.3) and the usecase behind it, deleting
videos older than 7 days via `DELETE /stream/{video_uid}`.

**Owed:** §12's value replaced with "7 days by sweep, 30-day native backstop";
§6.5's headroom arithmetic re-derived (at a 7-day concurrent window the block
holds far more monthly volume than the 30-day floor implied); R1's sweep
deleting videos older than 7 days and its adapter asserting both fields echo
back; and the `schedule:` workflow raised in `onryde/seazn.club.workflow`, never
here.

**Note that (c) was not optional in any case** — U1-S9 showed that deleting a
live input leaves its recordings billing, so a `DELETE /stream/{video_uid}` path
is required for cleanup correctness whichever retention answer is chosen. And
the sweep's `schedule:` workflow ships in `onryde/seazn.club.workflow`, not this
repo (`d53d87024`); a workflow added here fires never and reds nothing.

**Owed once ruled:** §6.5's headroom arithmetic re-derived, §12's value
replaced, and R1's adapter asserting whichever shape is chosen.

---

## ~~Q18~~ (register C1) RULED 2026-09-10 — the QR contract carries BOTH credential shapes

**Owner ruling R-A, taken 2026-09-10** (recorded as ruling 24 in `_INDEX.md`).
The capture QR payload v1 carries the SRT triple **and** the RTMPS pair, plus a
`preferred` discriminator and a `slot`.

**Why it is mandatory rather than defensive.** SRT is three fields, RTMPS is
two. With SRT primary and RTMPS the automatic fallback, the app needs both sets
in hand at scan time — it cannot re-scan a QR code when UDP turns out to be
blocked at the ground, on a phone that may not have the connectivity to ask for
anything. Supporting fact: `stream.liveInputs.create()` returns
`{ uid, rtmps, srt, webRTC }` in ONE response, so both shapes are already in
hand at provision time; design §7.6 carries only SRT out of a payload that
already had both.

**Deferred by the same ruling: the primary/fallback ORDERING goes to R3**,
informed by P5's device spike. Ordering is a config line in an app nobody has
written; the contract is a cross-repo boundary that costs two repos to change.

**Consequence:** register row **T5** (the RTMPS fallback leg is unproven) is
NARROWED, not closed — R2's acceptance records the fallback leg as unproven and
says why, instead of letting the soak's SRT leg read as coverage of both.

---

## ~~Q19~~ (register M4) RULED 2026-09-10 — multi-camera is WANTED, later, with the seams shaped now

**Owner ruling R-B, taken 2026-09-10** (recorded as ruling 25 in `_INDEX.md`).
The question raised was whether multi-camera belongs to Tier A rather than being
a Tier B gap to close — OBS already does switching, scenes, audio mixing and
replay natively and free, so a club with a laptop gets a better production from
Tier A today than a multi-cam wave would deliver in Tier B. Ruled: **multi-camera
is wanted. Not parked, not built now, and the seams are shaped today.**

**The line drawn.** A boundary that **cannot be refactored unilaterally** gets
shaped for N **today**:

- the **session model** — changing it later is a migration;
- the **cross-repo QR contract** — changing it later costs a second repo;
- the **provider port** (`RunnerProvider`) — a provider seam.

Everything **in-process** explicitly does **NOT**: the relay page layout,
switching, per-source `jitterBufferTarget`, cross-source NTP. Pre-building those
is exactly the speculative generality `AGENTS.md` forbids.

**The modelling decision that makes the ruling cheap: N inputs under ONE
session, not N sessions.** That keeps `fixture_stream_sessions_one_active`
correct as written, keeps credits and the state machine per-broadcast, and keeps
"one Machine, no fan-in" true.

**Consequences, all three recorded in `_INDEX.md`:**

- **M3 becomes MANDATORY** — extract `fixture_stream_inputs` (`session_id`,
  `slot smallint`, the ingest columns that sit on the session row today,
  `created_at`). R1 and R2 write exactly one row at slot 0; multi-cam later
  INSERTS rows instead of migrating a shipped table. An `inputs jsonb` column is
  **rejected**: no constraints, and this repo has already been bitten by jsonb
  coercion reading a written value back as something else.
- **M1 returns as ONE ROW in R0's bench, not as a wave.** If N-way WHEP decode
  does not fit an economic guest then "easy to extend" is false at the compute
  layer however clean the interfaces are — and R0 is already sizing that guest
  for 1x, so the extra row is nearly free.
- **M2 stays DEFERRED as mechanism** — cross-source capture sync has none at
  all. Recorded in `_INDEX.md`; owed when multi-cam is specced.

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

## ~~Q15~~ CLOSED 2026-09-06 — the cost was an artefact of the wrong data path

**The correction I issued was itself over-cautious, and the owner's own
question dissolved it.** The engine change, the `coarsen` change and the
golden re-baseline are all unnecessary. Verified in the tree, not inferred:

- `foldFixture` returns `foldMatch(sportModule, cfg, lineups, envelopes)`
  (`apps/web/src/server/engine-db/fold.ts:130`) — the module's whole state
  over the FINE stream.
- Football's state already carries `phase`, `periods` and `asOf`
  (`packages/engine/src/sports/football/football.ts:566,570,599`, written at
  `:2525`), which is the clock.
- Cricket's innings state already carries `legalBalls` and `ballsLimit`
  (`packages/engine/src/sports/cricket/cricket.ts:436,440`), which is the
  balls remaining.
- `grep -arn "coarsen" apps/web/src` returns **zero**. The web app never
  coarsens anything, so the dual-fidelity conformance property is nowhere near
  this path and cannot be broken by it.

The whole cost existed only because the numbers were assumed to have to ride
on the shared public summary. An overlay endpoint over `foldFixture` uses the
engine instead of changing it. **Nothing in `packages/engine` is touched by
this programme.** Task 0's Steps 2–13 are marked superseded pending the
owner's confirmation; Step 1, the venue time zone, is NOT superseded and
stands as written.

**One real cost the swap carries, recorded so it is not a surprise:**
`useLiveFixture` fetches `/api/v1/public/fixtures/${id}`
(`live-score-data.ts:30`) and is shared with `LiveScore`, so the overlay needs
that hook made generic over its fetcher, or a sibling hook. Small, and named.

## Q15 (original text, kept for the record — CLOSED above). The football clock costs an engine change and a golden re-baseline

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

## Q22 (owner question, 2026-09-11). Commentary over the video — what can a club add, and where?

**Asked by the owner mid-W2:** "what will happen if Org wants commentary on top
of the video?" It splits two ways, and the answers are very different. **Owner
direction the same day: remote AUDIO commentary is deferred to its own wave and
will be brainstormed separately. This row records the ground so that wave does
not re-derive it.**

### What already works, with no wave at all

**Tier A (the club's own OBS).** The overlay is a transparent browser source;
OBS mixes any microphone and renders any text the club likes. Nothing is owed.

**A commentator STANDING BESIDE THE PHONE, on the composited tier.** The
compositor's audio path is the phone's, through a PulseAudio null sink at
AAC-LC 128 kbps / 48 kHz on one A/V clock (design §7.2, §11's A/V row), and §12
open item 7 already recommends the mic live-by-default with a prominent mute.
A commentator talking next to the camera IS that mic.

### What does NOT work: a REMOTE commentator (deferred — its own wave)

The compositor has exactly ONE audio input. A second voice needs a second
ingest, an ffmpeg mix and sync against the video, and **U1-S5 constrains the
transport**: WHIP and WHEP must be used together, so a WHIP audio ingest cannot
be pulled alongside the RTMPS video the composed tier already uses — it needs
its own path. That is a wave, not a task.

### What is CHEAP and reaches both tiers: TEXT commentary

The compositor already renders our overlay page over the video, so a commentary
lower third is a rendering change plus a source of text — **and the ledger
already has one.** `core.note` is the official's own free-text annotation;
`lib/timeline-keys.ts` says so outright ("an OFFICIAL'S OWN ANNOTATION —
rendering that as 'Match event' throws away the only free text in the ledger").

**One decision it needs, and it is W2's to flag.** `recentWindow`
(`server/overlay/recent.ts`) excludes every `core.*` type on purpose — a void, a
note, a suspension of play and a substitution are not moments. Text commentary
means letting `core.note` through EXPLICITLY, which is a product decision rather
than a one-line relaxation: a note is written by an official for the record, not
for an audience, and putting it on air unedited is a different product from
putting it in a timeline.

**Recommendation (mine, as product owner, not a ruling):** scope text commentary
as a small wave of its own — it reaches Tier A and the composited tier from one
change, and the hard half is editorial (who writes it, and does it go out raw)
rather than technical. Remote audio stays deferred per the owner's direction.

### What can never carry it

**Passthrough / simulcast.** There is no compositing step: Cloudflare live
outputs forward what the club sends. Nothing can be added on that path, in
either medium.
