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
