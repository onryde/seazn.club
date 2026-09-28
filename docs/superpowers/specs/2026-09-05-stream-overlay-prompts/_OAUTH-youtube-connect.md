# YouTube Connect (OAuth) — owner ruled "let's use OAuth", 2026-09-27

**Status: RULED as a direction, NOT designed, NOT scheduled, NOT in R1.** R1 ships and has merged the pasted-key
path (`org_stream_targets.rtmp_enc`). This file is what a future wave needs to know before it starts, plus the
one gate that is calendar time rather than work and should therefore be started early.

## Where a destination is scoped — the question the owner asked alongside this

**Today it is ORG level.** `org_stream_targets` is `(org_id, kind, label, rtmp_enc, watch_url)` — no competition
column, no division column, no court column. One set of destinations per org, reused by every competition.

**Recommended: a per-COURT default, which is VENUE-shaped — not tournament level and not division level.**

- A destination answers "where does this video go". That is a property of the channel and of the physical court,
  not of a competition. Courts are already per-venue rows (`courts`, `venues`), so the setup is **once per
  venue** and every future tournament at that venue inherits it.
- **Division level is wrong outright:** several divisions play simultaneously on the same courts, so a
  division-scoped destination would collide with itself.
- **Tournament level would mean re-doing the setup for every event** and buying nothing, because the channel and
  the courts have not changed.
- Worth allowing LATER, not now: an override at competition level, for the case of a sponsor or partner channel
  for one event. Additive; no reason to build it before someone asks.

Under OAuth this gets simpler rather than harder: the org connects its channel ONCE, and a court just records
which connected channel it uses (usually the only one). No keys anywhere, at any level.

## What the repo already has (read 2026-09-27, not assumed)

- **Google OAuth exists** — `lib/oauth.ts` (`GOOGLE_AUTH_URL`, `GOOGLE_TOKEN_URL`, `googleConfigured`,
  `googleRedirectUri`, `OAUTH_STATE_COOKIE`) with `app/api/auth/google/route.ts` and its callback.
  `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are already configured, the Cloud project exists, and the redirect
  URIs are already registered. So this is a new SCOPE on an existing integration, not a new provider.
- **Current scopes are `openid email profile`** (`api/auth/google/route.ts:44`) — all non-sensitive.
- **We already have the sealing pattern** a refresh token needs: the AES-256-GCM envelope and the `*_enc`
  column boundary built in R1 Task 2, plus `DEVICE_LINK_KEK` / `RELAY_KEK` as precedent for a per-purpose KEK.

## What OAuth buys — and it closes a gap named two answers earlier

With `https://www.googleapis.com/auth/youtube` and offline access, we stop pasting keys and start creating the
broadcast ourselves through the YouTube Data API:

- **No key entry at all.** The org clicks "Connect YouTube" once per channel.
- **We create the broadcast per match, so we TITLE it** — "Division A — Team A v Team B — Court 1" instead of
  the channel's default — and we choose its visibility.
- **We get the video id back, so a per-match watch URL becomes storable.** That is exactly what the pasted-key
  path cannot do: there, YouTube creates the video implicitly and we never learn its id, so `watch_url` is one
  static per-target URL and "watch Court 1's third match" is unlinkable. OAuth makes per-match YouTube links and
  YouTube-side replays real, alongside our own `fill_replay` recording.
- **Unlisted broadcasts become possible**, which is what a paid or private event needs.

## The two gates, both of which bite before any code matters

1. **Google OAuth VERIFICATION, and it is calendar time.** The `youtube` scope is a SENSITIVE scope. Today's
   `openid email profile` set is not, which is why the app has needed no review so far. Adding the YouTube scope
   triggers Google's verification process (brand review, a justification, typically a demo video) and, until it
   passes, users see the "Google hasn't verified this app" screen and the app is capped at a small number of
   users. **This is weeks of waiting, not days of work — start it as soon as the wave is scheduled, in parallel
   with everything else.** It is the long pole, and no amount of engineering shortens it.
2. **Quota is PER CLOUD PROJECT, shared by every org on the platform.** YouTube Data API v3 ships a default of
   ~10,000 units/day, and write calls (`liveBroadcasts.insert`, `liveStreams.insert`, `liveBroadcasts.bind`) are
   ~50 units each — so a naive implementation spends ~150 units per match and the WHOLE PLATFORM runs out at
   roughly 65 matches in a day. A busy Saturday breaks that.
   **These numbers are from memory and are UNVERIFIED — check them against the current Google docs before any
   design depends on them.** Three mitigations to weigh then: create one persistent `liveStream` per court and
   only insert+bind a broadcast per match; request a quota increase (a form, and more calendar time); and keep
   the pasted-key path as the fallback for high-volume orgs, which costs nothing because it already exists.

## Other design facts a wave will need

- **A Google account can own several channels**, so connect must list them (`channels?mine=true`) and let the org
  pick — otherwise we bind to whichever channel Google considers default and nobody can tell why the stream
  went somewhere unexpected.
- **Refresh tokens die.** Revoked by the user, expired through inactivity, or invalidated by a password change.
  The failure must be visible BEFORE an event, not at kick-off: a connection-health check on the fixture console
  and a re-consent path. A token that dies mid-event should fall back to the pasted key if one exists rather
  than dropping the broadcast.
- **The channel always belongs to the ORG, never to seazn.** A seazn-hosted channel would make us the
  broadcaster — rights, claims, moderation and takedowns become ours. This is a recommendation, not a ruling, but
  a strong one.
- **Concurrency is still YouTube's rule, not ours.** Whether one channel may run several simultaneous live
  streams is unverified by this programme either way, and it decides whether a four-court venue needs four keys
  (or four programmatic streams) on one channel, or four channels. The unlisted key the owner owes settles it.
- The Task 10 `target_in_use` guard being added for the pasted-key path stays correct and useful under OAuth: a
  programmatic stream is still a single-occupancy resource.

## Sequencing recommendation (not ruled)

R1 keeps the pasted key — it is built, merged and sufficient. **YouTube Connect is its own wave after R1**, and
the per-court destination defaults belong with the court-bound-device work rather than here. The one thing to
pull FORWARD out of order is Google verification, because it is the only item that cannot be compressed.

## Open with the owner

**Default visibility for a broadcast we create: public, or unlisted with our own page as the front door?** It is
one API field and a real product choice — public makes matches discoverable on YouTube and grows reach; unlisted
keeps the audience on our surface where the overlay, the scorebug and the spectator page live, and is what a
private or paid event needs. A per-competition switch is the obvious middle, defaulting to one of them, and the
default is the part that matters.
