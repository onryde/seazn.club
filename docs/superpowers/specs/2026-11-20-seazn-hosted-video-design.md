# Seazn-hosted video — design

Date: 2026-11-20 · Status: draft for owner approval · Repo: web (phone unchanged) · POC on staging 2026-11-20: results in the plan's "POC results" section (C1–C6, B1–B6)

## 1. Intent

Today every streamed match ends on a third party: the phone (or a hardware encoder) publishes to a Cloudflare Stream live
input, and Cloudflare simulcasts it to the organiser's destination — a connected YouTube channel or a pasted key
(`org_stream_targets.kind`: youtube, facebook, twitch, kick, custom_rtmp). A club with no channel, or one YouTube
restricts (unverified, suspended, live not enabled, the 24 h first-live wait), cannot stream at all, and Seazn has no
say over what viewers see.

**Seazn-hosted** adds a destination that is Seazn itself: viewers watch the match, live and as a replay, on Seazn's own
public match page, with no YouTube anywhere in the picture.

Why now (owner, 2026-11-19/20): YouTube's restrictions keep blocking clubs (suspended accounts, verification, live
enablement), and the £3 per streamed match should not depend on the club owning a working channel.

## 2. Goals, non-goals, anti-goals

Goals
- G1. A per-match destination **Seazn**, beside the existing ones. An organiser picks Seazn or one external destination
  for a match — never both (owner: "If Seazn Hosted, no youtube come into the picture").
- G2. **Live** on Seazn: the public match page plays the match live in a Seazn player, adaptive sizes (Cloudflare Stream's
  own ladder: 720/480/360/240 from a 720p input, measured), with the score on the page beside it.
- G3. **Replay** on Seazn: after the match the recording moves to **Bunny Stream**, which encodes every size for free; the
  match page's Replay plays from Bunny.
- G4. **Keep replays as long as the org stays a customer** (owner, 2026-11-20: "as long as they stay for now").
- G5. **Private competitions** play only through signed, expiring URLs on both Cloudflare (live) and Bunny (replay).
  Bunny's embed token and referrer allow-list keep replays on Seazn's pages. For live, Cloudflare's `allowedOrigins` does
  not stop a raw HLS request from another site (measured 2026-11-20), so a live URL works for whoever holds it until its
  token expires: the token's short life is the protection.
- G6. **Measure** minutes delivered per match (live on Cloudflare, replay on Bunny) so the cost is visible.
- G7. **One cleanup rule for Cloudflare recordings**, whatever the destination (owner: "have same cleanup method").

Non-goals
- No cap on live viewing for now (owner, 2026-11-20: "we can accept the cost for now"). G6 records it; nothing limits it.
- No WebRTC playback: Cloudflare's WHEP needs a WHIP input, and the phone publishes SRT/RTMP (Cloudflare docs: "we do not
  yet support inputs using RTMP/SRT to be played using WHEP"). HLS, ~10–20 s behind live, is accepted.
- No "Seazn TV" channel page listing an org's videos (approach C below) — a later step on top of this one.
- No change on the phone. The phone publishes to the same live input whatever the destination.
- No Seazn copy for matches streamed to YouTube (approach B below): YouTube holds that copy.
- No live delivery from Bunny: Bunny Stream has no live ingest ("RTMP streams are currently not supported", Bunny CDN FAQ,
  checked 2026-11-20).

Anti-goals (would make this a failure even if it works)
- A Seazn-hosted match that silently also creates a YouTube broadcast, or a YouTube match that silently plays on Seazn.
- A private competition's video reachable by an unsigned URL, or by a signed one past its short life.
- A replay lost because the Cloudflare recording was deleted before Bunny had a playable copy.
- Viewer cost nobody can see (G6 exists so this never happens silently).

## 3. Constraints

- Cloudflare Stream prices (docs, 2026-11-19): storage $5 per 1,000 min per month, prepaid; delivery $1 per 1,000 min,
  counted on HLS/DASH playback **and on simulcast live outputs**. Our account: 1,000-minute storage block.
- Bunny Stream prices (bunny.net/pricing/stream, 2026-11-20): encoding free; storage from $0.01/GB-month; CDN delivery from
  $0.005/GB; $1 monthly minimum. UK/EU delivery rates not stated on the page — confirm at signup.
- Every live input records automatically today (`recording.mode: "automatic"`), with
  `DELETE_RECORDING_AFTER_DAYS = 30` (`apps/web/src/server/relay/config.ts:46`), sent at input create and enable/disable
  (`ingest-cf.ts:295`, `:504`). `ingest-cf.ts:10-15` forbids any update that changes `recording` on a live input.
- The Cloudflare playback (HLS) URL is not stored; it is built on demand from the customer host and input uid
  (`capture-phone.ts:269`). Live inputs are created with `requireSignedURLs: false` today.
- The public match page offers a player for YouTube addresses only (`replay-plan.ts`, parts from `youtube_broadcasts`
  via `server/youtube/parts.ts`).
- Next web migration is **V531** (V530 is the latest; there is no V529 on main).
- Secrets (the Bunny keys, the Cloudflare API token) live in server config only, never in a URL query, a log, an error or
  the database in clear.

## 4. Approaches

| | A. Seazn as a destination (picked) | B. Seazn replay for every stream | C. "Seazn TV" page |
| --- | --- | --- | --- |
| What | New destination kind; Seazn matches play live + replay on the match page | As A, plus a Bunny replay for YouTube matches too | A channel page of all an org's live and past matches |
| Trade-off | One clear choice per match; reuses destination, session and replay plumbing | Seazn replay everywhere, but pays storage for matches YouTube already keeps; contradicts "no YouTube in the picture" | Most product; browse/search/layout to design |
| Verdict | **Picked by the owner (2026-11-20: "A")** | Rejected | Later, on top of A |

Replay home, considered (owner picked Bunny, 2026-11-20): keep on Cloudflare Stream (simplest, cost grows monthly and
every replay view is billed); our own one-off encode into R2 or Backblaze (free delivery, but a job of ours to run); a
Seazn-owned YouTube channel (free, but upload quota ~1,600 units each, API-upload audit, one strike hits every club);
**Bunny Stream** (managed encode, cheap storage and delivery, a second supplier).

## 5. How it works (decided)

### 5.1 Destination
- A new destination **Seazn**, available to every org, needing no credentials. It is the **preferred** destination
  (owner, 2026-11-20: "We tell org to use Seazn Hosted as a prefered Live Stream Dest"): first and pre-selected in the
  match's stream panel, with the org's external destinations beside it. Picking it means no external live output is created.
- **No per-org opt-in** (owner, 2026-11-20: "No need, as we will test in stage then promote to Prod"). Rollout is the
  server flags alone: on in staging first, then prod. No Enable card, no admin toggle, no "Try Seazn Hosted" prompt.
- When the destination is Seazn, nothing YouTube-related runs for that session: no broadcast, no thumbnail, no
  `youtube_broadcasts` row.
- When the destination is YouTube (or any external one), everything stays exactly as today, and the match page shows
  YouTube everywhere (owner, 2026-11-20).

### 5.2 Live on Seazn
- **The score is burned into the picture by the compositor** (owner, 2026-11-20: "We overlay the Scoring in Compositor").
  A Seazn session runs composed: the compositor pushes the composed picture into a second Cloudflare live input owned by
  the session, instead of to an external destination. That input is what viewers watch and what is recorded, so the
  replay carries the score. The camera input is not offered to viewers.
- The public match page **and Match Day** (owner: "We output the Live Video in MatchDay/PublicHub like playback"), while
  the session is live, play the composed input's HLS in a Seazn player. Before the session goes live and after it ends, the page shows what it shows today for those states.
- **All Seazn playback is signed** (my call): an input can carry matches of different competitions (courts), so a
  per-input flag cannot follow per-competition privacy. The page mints a short-lived token for every viewer it already
  admits (public, unlisted or private alike), from Cloudflare's own token endpoint, so public viewers notice nothing.
  `allowedOrigins` is set to Seazn's hosts but blocks nothing on a raw request (measured), so the token's short life is
  what protects live. The recording Cloudflare makes from a signed input comes out unsigned (measured), so the server
  signs each recording as soon as it appears.

### 5.3 Replay on Seazn
- When a Seazn session ends and Cloudflare's recording is ready (Cloudflare: within ~60 s of the end), the server asks
  Bunny to fetch the recording by URL into the org's Bunny collection, and stores the Bunny video id against the session.
- Bunny encodes (resolutions capped at 720p, owner setting); once Bunny reports the video playable (its webhook, with a
  slow poll as the backstop), the match page's Replay plays in Bunny's embed player with a signed embed token. Bunny's
  referrer allow-list (Seazn's hosts) and CDN token authentication guard its files.
- **Order is fetch, confirm playable, then delete** (owner's step 4, with the order fixed: Bunny fetches from the
  Cloudflare copy, so it must exist until Bunny's plays). If the move fails it retries; the 3-day sweep skips a Seazn
  recording not yet moved and keeps it up to Cloudflare's own 30-day floor, alerting Seazn staff (my call: a replay is
  never lost to the sweep).
- A session with several recordings (a restart after a stop) moves each recording; the Replay lists them in order, as the
  YouTube replay lists parts today.

### 5.4 Cloudflare recording cleanup (one rule)
- A Seazn match's Cloudflare recording is deleted as soon as Bunny has a playable copy.
- An external-destination match's Cloudflare recording is deleted after **3 days** (kept that long so a copy exists if the
  external broadcast failed part-way).
- This is today's rule already: our sweep deletes videos after `RECORDING_RETENTION_DAYS = 3` (`config.ts:50`);
  `DELETE_RECORDING_AFTER_DAYS = 30` is only Cloudflare's backstop, whose minimum is 30 (`config.ts:43-49`). The one change
  is the Seazn exception above (delete on Bunny-playable; hold an unmoved recording past 3 days).

### 5.5 Keeping and removing replays
- Bunny replays are kept while the org is a customer (G4).
- When an org is **closed or deleted**, its replays are deleted after a **30-day grace** period, during which the
  organiser can download them through Seazn's server, since Bunny's files need a token and an allowed referrer (my call: an org on credits only, or between subscriptions, keeps its replays; only a closed
  org starts the clock, so a paying club never loses replays by a billing gap).
- An organiser can delete a match's replay themselves.

### 5.6 Measuring cost
- Minutes delivered per match: live from Cloudflare's analytics (`streamMinutesViewedAdaptiveGroups`, by input uid),
  replay from Bunny's statistics. Recorded per session and visible to Seazn staff. No organiser-facing number yet.

## 6. Left to the builder

- The data shape of the Seazn destination (a `kind` value on `org_stream_targets` with neither source, or a separate flag
  on `fixture_stream_settings`), and how the `org_stream_targets_one_source` constraint accommodates it.
- Which player library (hls.js, or Cloudflare's and Bunny's own embeds) — one player for both is preferred. (Decided in
  the plan: hls.js for live, Bunny's embed for replay, since Bunny's protected files need what the embed carries.)
- Whether the Bunny move runs from the session-end path (`persist.ts` `endedNow`) or the relay sweep, provided it
  retries and never deletes before Bunny is playable.
- Bunny collection layout (per org recommended) and how the Bunny API key is held.
- How signed playback tokens are minted and their lifetime. (Decided in the plan: Cloudflare's token endpoint, 1 h.)

## 7. Calls made in this doc (owner to check)

1. Only a closed or deleted org starts the 30-day replay deletion (§5.5).
2. **Matches first; courts later.** `court_stream_links.target_id` cannot pick Seazn in this version: a court input
   carries many matches, so its replay must be split per fixture — a follow-up.
3. **Billing unchanged**: a Seazn match draws the same stream credit (£3) with the same admission and balance checks;
   replay storage and all delivery are absorbed by Seazn, uncapped, measured (§5.6).
4. All Seazn playback signed (§5.2); an unmoved recording held past 3 days (§5.3).
