# Scenario — the court-bound device (owner, 2026-09-27, from a live event the day before)

**Status: CAPTURED, not designed and not scheduled.** Nothing here is ruled, nothing is in a wave, and no
lane-B work changed because of it. Two questions at the end need the owner before this can become a design.

## The owner's words

> There is a scenario from yesterday['s] event where the customer/org expect that livestreaming mobile still
> stand in a position and for court 1 Mobile A, Court 2 Mobile B, so on and Mobile Device ID registered
> uniquely and then org push the next match in that mobile live stream without touching the mobile and there
> will be a half screen live video and half screen qr for remote scoring. just a thought.

Read plainly, the ask is four things:

1. A phone is **mounted on a court and stays there all day**. Nobody walks over to it between matches.
2. The phone has a **durable identity** — "Mobile A" — that is **registered to Court 1** and outlives any one
   match.
3. The organiser, from the desk, **points that device at the next fixture**. The device picks the change up by
   itself.
4. The device's own screen is **split: live video preview above, a scoring QR below**, so a scorer walks up,
   scans, and scores the match from their own phone.

## What the tree already gives us (read today, on `feat/stream-relay-b` at `782628af5`)

- **Courts are first-class.** `venues`, `courts`, `court_hours`, `court_exceptions`, `stage_round_court_tags`
  are real tables, and a fixture already carries one venue zone (the "ONE zone per fixture" rule). "Court 1" is
  a row, not a label to invent.
- **Scoring device links exist and are re-showable.** `device_links` carries `token_hash`, `label`,
  `secret_enc` (sealed under `DEVICE_LINK_KEK`, V417, 2026-09-23) and a now-nullable `expires_at`, so a
  reprinted sheet or a console hand-over returns the SAME secret instead of killing a sheet already on a court.
  That is the printable-scorer-sheets design (`2026-09-23-printable-scorer-sheets-design.md`), a live programme.
- **The capture QR contract v1 is fixed** (design §7.6): `{ v, sid, slot, cred: { srt, rtmps }, preferred, exp }`,
  every credential opaque, `exp` = provision + `max_duration` + 30 min, rendered client-side from the
  organiser-authed session projection so the secret never enters page HTML.

## What it does NOT give us — the seam, stated precisely

**Every credential in this programme today is bound to ONE fixture and is delivered by a human scanning a code.
The scenario inverts both halves: bind to the COURT, and deliver by push.**

Three specific gaps, each checked against the schema rather than assumed:

1. **No device identity survives a fixture.** `device_links.fixture_id` is **NOT NULL** — a scoring link dies
   with its match. There is no row anywhere that means "Mobile A", and nothing binds a device to a court.
2. **No session follows a court.** `fixture_stream_sessions` carries `fixture_id` and `org_id` and no device or
   court column. A stream session IS a fixture's session.
3. **No channel from the desk to the device.** The capture QR is *pulled* by a human with a camera. Nothing
   tells a phone already streaming that its subject has changed.

## Where it belongs

This is **R3** (the native capture app, own spec in the `seazn-capture` repo) with a **control-plane hook in
this repo**, and it is informed by the P5 device spike that the design already defers the QR ordering to. It is
NOT R1 and NOT lane B. R1's Phone tab is the ffmpeg stand-in; a phone that re-points itself between matches is
an app nobody has written yet.

## Product-owner read

**Recommend: keep the per-match session and re-point the device — do NOT make the stream court-shaped.**

The money and the replay both already work per match, and the phone experience the owner describes is
unchanged either way, because the *app* does the switching rather than a person. Concretely: the device holds a
long-lived registration; the desk sets "Court 1 → next fixture"; the device polls its assignment, gets the new
session's credentials, restarts its publish, and swaps the scoring QR underneath. Nobody touches the phone,
and the session model, the credit ledger and `fill_replay` are all untouched.

The alternative — one long court-day stream with matches flowing through it — costs less in credits and is
worse in two ways that matter to a customer: a team wants **their** match's replay link, which a single
six-hour recording does not give without cutting it afterwards, and a mid-day failure takes out every remaining
match on that court instead of one.

**Pull, not push.** A real push to a phone needs FCM/APNs and a shipped app; a poll works in a web stand-in
today and degrades sanely on a ground network. "Without touching the mobile" is satisfied either way.

## Two risks to record now, because they are cheap now and expensive later

1. **A scoring QR on an unattended screen is a scoring credential in public, all day.** The phone sits on a
   tripod for six hours showing a code that lets anyone score the match. On a sheet handed to a named scorer
   that exposure is bounded; on a mounted screen it is not. Options, none ruled: require the scanner to be a
   signed-in member, bind the link to the first device that claims it, or show the QR only on a tap. This is a
   finding for the scorer-sheets programme too, not only for streaming.
2. **The scoring QR must never enter the composited output.** Under B2 (chroma-key, ffmpeg owns the timebase)
   the compositor never sees the phone's screen, so this is safe *by construction* today. Write it down anyway:
   the day someone mirrors a device screen into the overlay for a "what the camera sees" tile, the scoring
   credential goes out on air to every viewer.

## The two questions the owner has to answer before this can be designed

**Q1 (money, and it decides the schema).** One credit per match with the device re-pointed between matches — or
a court-day session that many matches flow through? Recommendation above: per match. This decides whether the
new durable row is a *device registration* beside the existing session, or a *new session kind*.

**Q2 (scope and sequencing).** Does this wait for R3's capture app, or does R1/R2 ship a web stand-in — a
browser page on the mounted phone that polls its court assignment — so the workflow can be proven at a real
event before an app exists? The stand-in is cheap and would have answered yesterday's event; it also risks
becoming the thing nobody replaces.

Neither question is urgent for lane B. They are urgent before anyone writes an R3 line, and before the
scorer-sheets programme hardens `device_links` in a shape that assumes one fixture forever.

---

## OWNER RULING 2026-09-27 — Q1 is **1a: per-match sessions, the device re-pointed**

Owner's words: *"Ok 1a, so org owner can feed new match in realtime without touching the phone"*. One credit
buys one MATCH; the durable new row is a device registration beside the existing session, and the session
aggregate, the credit ledger and `fill_replay` are all untouched. A court-day session is rejected — it would
make `fixture_id` a moving pointer and contradict the invariant Task 2A built and reviewed.

## The output side, answered from the schema (owner's follow-up: single YouTube video or per match?)

Read today, not assumed: `org_stream_targets` is `(org_id, kind, label, rtmp_enc, watch_url)` — **per ORG, with
no court and no fixture binding** — and `fixture_stream_sessions.target_id` is **NOT NULL, exactly one target
per session** (design §6.1, live in V410).

So there are two separate things, and only one of them rotates:

- **The destination is registered ONCE.** The YouTube RTMPS url+key is a sealed `rtmp_enc` row an organiser
  enters one time. Nobody re-enters a key between matches, ever.
- **The video is PER MATCH.** Each match is its own session, so it is its own push to that key. A persistent
  YouTube key ends its broadcast when the push stops and opens a new video on the next push, which is exactly
  the per-match shape 1a already pays for and already gives a replay link to.

**Why not one continuous YouTube video per court-day:** something must keep pushing frames through every
changeover or YouTube ends the broadcast (~60 s of no data). That means a slate held up by the compositor
between matches — Fly compute and Cloudflare minutes burned for time nobody is playing, which under 1a is
UNFUNDED, because a credit buys a match and not a day. Viewer discovery is the only thing a single long video
would have bought, and we solve that on our own surface: the spectator page knows which session is live on which
court, so "Court 1 — live now" is a link we own rather than a YouTube tab a viewer has to keep.

**UNMEASURED, and it is what the unlisted YouTube key the owner owes is for:** whether a given channel opens a
NEW video per push or resumes one broadcast depends on that channel's auto-start / auto-stop settings. The
sentence above is a prediction from how a persistent key behaves, not a measurement — no YouTube key has been
tested by this programme. Treat it as a premise to verify before R3 ships, not a fact.

### GAP found while answering this — two courts, one key (concrete, cheap now)

`target_id` is org-scoped and **nothing stops two concurrent sessions naming the SAME target.** One match at a
time hid this; the owner's scenario makes it routine — Court 1 and Court 2 both live, both pointing at the org's
single "YouTube" row, both pushing the same RTMPS key. YouTube accepts one broadcast per key, so the second
court's stream is refused or fights the first, and the failure surfaces as "the stream did not start" with
nothing in our own data explaining why.

Two things follow, neither built and neither ruled:

1. **A target belongs to a court** in this workflow — "Court 1 — YouTube", "Court 2 — YouTube" — so the desk
   cannot mis-pick. Today it is a free-text `label` and operator discipline.
2. **Refuse a session whose target is already held by a live session.** A partial unique index on `target_id`
   over the non-terminal states, or the guard in the usecase, is the difference between a clear refusal at
   provision time and a broadcast that silently does not happen. This one is worth doing even without the
   court-bound device, because a human can already double-book a target today.
