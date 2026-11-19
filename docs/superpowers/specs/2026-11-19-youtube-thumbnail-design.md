# YouTube thumbnail — a match card on every Seazn broadcast

Owner, 2026-11-19: approved writing up this recommendation: when the server creates a match's YouTube broadcast, upload a
1280×720 JPEG match card as its thumbnail, rendered by the share-image machinery; a refusal is non-fatal. Anything below
not quoted from the owner is marked **Call**. Facts about Google not re-checked against the live docs are marked
**verify**. Code is cited at the worktree's base (`origin/main`, 2026-11-19).

## 1. Intent and why

Nothing sets a thumbnail today. `YouTubePort` (`server/youtube/port.ts:153`) has no thumbnail method, and the YouTube
Connect spec lists thumbnails as a non-goal (`2026-10-27-youtube-connect-design.md` §2). YouTube therefore picks a frame
of the stream, which at the moment it picks is often an empty court, a tripod being set up, or black. On a channel page
of ten matches that all look the same, nobody can tell which match is which without reading titles. A card with the two
sides, the competition and the court makes the channel page and the "live now" tile say what the match is, and puts the
club's name on every one.

## 2. Goals, non-goals, anti-goals

**Goals**
- Every new YouTube Connect broadcast gets a 1280×720 JPEG card: the two sides, competition and round, the org's name
  or logo, and the court.
- One renderer: the card is a third shape of the existing match poster, not a second design.
- A refusal never touches the stream, the broadcast row's state, the connection's status or Go live's answer.
- The organiser learns, on the stream panel, when the card was not set and what to do about it.

**Non-goals**
- A live score on the thumbnail, or a result card after the match (the card is drawn once, upcoming; §3).
- Thumbnails for pasted-key destinations (no API behind them) or for Facebook/Twitch/Kick.
- An organiser-uploaded custom image, or a per-org template editor.
- Replacing a thumbnail the club set by hand in Studio afterwards (we never write it again; §3).

**Anti-goals**
- Never fail, delay or retry Go live because of the thumbnail.
- Never move a connection to `reconnect_needed`, or record a live-state refusal, from a thumbnail answer.
- Never draw a name that is not already in the broadcast title (§5).
- Never fetch an image URL from satori: badges and logo go through the guarded fetcher (`server/og/poster-image.ts`).

## 3. When it is set

**At provision, after bind, off the admission path. Call.** `createNew` (`server/youtube/prepare.ts:365`) inserts the
broadcast (`insertBroadcast`), binds it and marks the row `bound`. Rendering (satori + sharp, ~0.3–1 s) and a media upload
(bounded at 10 s, `YOUTUBE_CALL_BOUND_MS`) would add seconds to a phone operator's Start. Instead the session tick, which
already runs for every open session from both the cron pass and the organiser's 5 s poll (`stream-sessions/tick.ts:181`,
`readYoutubeStatus`), gains a sibling step `setYoutubeThumbnail`: one CLAIMED attempt per broadcast row, the same claim
pattern as `youtube-status.ts`, from the first tick after the row is `bound` (no 60 s wait: a thumbnail does not need
YouTube to have settled). In practice it lands within seconds, before most viewers arrive.

- **Once per broadcast row, not per session.** A Go live that reuses an open broadcast (prepare's step 2, the replay
  window) finds the row already `set` and does nothing. A new broadcast for the same fixture gets its own card.
- **Court sessions are no different.** A court phone (`relay/domain/court-stream.ts`) streams match after match, but each
  match is its own fixture, its own prepare and its own broadcast (`youtube_broadcasts.fixture_id`), so each gets its own
  card. The court is the fixture's court (`fixtures.court_id → courts.name`), falling back to the court link's court
  (`court_stream_links.court_id`) when the fixture names none.
- **No refresh when the sides change. Call.** The title is written once at insert and never updated either (the port has
  no `liveBroadcasts.update`); a card that disagreed with its title would be worse than either. A court phone only starts a
  match whose both sides are known (`CourtMatchFacts.ready`), so a TBD card is possible only on a manual Go live of a TBD
  fixture, where the title says TBD too. See open question Q2.
- **At most one retry. Call.** A transient failure (`youtube_unavailable`, a timeout) is retried once on a later tick; a
  definite refusal (§6) is not retried. The claim stops after two attempts, so a broken channel costs at most 100 units.

## 4. The card

Built from `MatchPoster` (`server/og/match-poster.tsx:514`), which today renders `"og"` (1200×630) and `"poster"`
(1080×1350), as a third size `"thumb"` (1280×720), always in the `upcoming` variant. Fonts are `posterFonts()` (Barlow
Condensed for display, Geist for the small print, static TTFs from `apps/web/assets/fonts`). Satori yields PNG; `sharp`
(already a dependency, used by `poster-image.ts`) re-encodes it to JPEG, quality 85, progressive off. **Call.**

```
┌──────────────────────────────────────────────────────────────┐  lime hairline along the top (LIME, match-poster.tsx)
│ [logo] ORG NAME                                    COURT 3   │  org logo or initials tile; court in Barlow caps
│                                                              │
│      ┌──────┐                              ┌──────┐          │  crest tiles in team colours (or monogram),
│      │ BADGE│     HOME NAME   v   AWAY NAME│ BADGE│          │  names at one size, cut with an ellipsis at 2 lines
│      └──────┘                              └──────┘          │
│                                                              │
│  COMPETITION · DIVISION · ROUND                              │  the poster's chip line
│                                          Powered by Seazn    │  the poster's footer, unchanged
└──────────────────────────────────────────────────────────────┘
```

- Safe area: YouTube overlays the duration/LIVE badge bottom-right and shrinks the card to ~168×94 in lists, so nothing
  that matters sits in the bottom-right 20 % and the names are the largest text. **Call.**
- No score, no time, no "LIVE" chip: the card outlives the live moment (it is the VOD's thumbnail too).
- The words are the org's default locale, as the title's are (`textsFor`, `prepare.ts:265`).

**Data loader.** `loadMatchPosterModel` (`server/og/match-poster-data.ts:48`) reads through `getPublicFixture`, which
answers null for a private competition — and private competitions stream too. The thumbnail needs its own loader,
`loadThumbnailModel(orgId, fixtureId)`, reading by id the same facts `textsFor` reads (entrant display names, division,
competition, org) plus round, court, theme, badges and logo, each image through `posterImageDataUrl`. It feeds the same
pure `matchPosterModel` (`match-poster.tsx:275`), so the slot rules stay in one place.

## 5. Data and privacy

The card shows only what the broadcast already publishes: the title carries `entrants.display_name` for both sides, the
division and the competition (`server/youtube/title.ts`). The card adds the org's name and logo (already on the
channel's own matches and the public site), the court name, the round and team badges — none of them personal
data. It draws no player name, photo or score. The image inherits the broadcast's privacy (public, unlisted or private):
it is never published anywhere else, and it is not stored by Seazn — rendered in memory, uploaded, dropped. A
made-for-kids broadcast gets the same card **(verify that YouTube allows custom thumbnails on made-for-kids videos)**.

## 6. Failure handling and the desk's copy

**Google's `thumbnails.set` (from knowledge; verify each against developers.google.com/youtube/v3/docs/thumbnails/set):**
- `POST https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=<broadcast id>` with the image as the media
  body (`uploadType=media`). A broadcast id is its video id.
- Accepted types: `image/jpeg`, `image/png`, `application/octet-stream`. Max 2 MB (`mediaBodyTooLarge` /
  `imageTooLarge` — **verify the reason**). Recommended 1280×720, minimum width 640.
- Scope: `youtube`, `youtube.force-ssl` or `youtube.upload`. We hold `youtube` (`lib/youtube.ts:6`): **no new consent**.
- Custom thumbnails need a **verified channel** (phone verification, or the "intermediate features"). An unverified
  channel is refused with HTTP 403, reason `forbidden` **(verify: Google documents `forbidden` as "the thumbnail can't be
  set for the specified video"; whether verification has a reason of its own is unconfirmed)**.
- Other refusals: 400 `invalidImage`, 404 `videoNotFound`, 429 `uploadRateLimitExceeded` ("uploaded too many thumbnails
  recently") **(verify)**.

**The port and the driver.** `YouTubePort` gains `setThumbnail(at, broadcastId, jpeg: Uint8Array): Promise<void>`. The
driver needs a binary body: `send` (`google.ts:144`) takes `body?: string` today; it gains a `Uint8Array` body with
`Content-Type: image/jpeg`, and the upload host. Errors go through `mapGoogleError` (`google.ts:72`) as now, so a 403
`forbidden` arrives as `youtube_unavailable` with reason `forbidden`, and the reason is what tells the thumbnail step it
is a verification refusal. The renderer refuses its own output over 2 MB before calling (a 1280×720 JPEG at q85 is
~150–350 KB).

**The step's outcome, stored on the broadcast row** (`youtube_broadcasts.thumbnail_state`, one migration; **Call**):

| Answer | `thumbnail_state` | Retried | Panel line |
| --- | --- | --- | --- |
| 2xx | `set` | — | none |
| 403 `forbidden` | `not_verified` | no | **"Thumbnail not set — verify the channel in YouTube"** (amber) |
| 429, `youtube_limit_reached` | `failed` | no | "Thumbnail not set — YouTube refused it" (slate) |
| `youtube_unavailable` (timeout, network, 5xx), a render error | `pending` → `failed` after 2 tries | once | as above |
| `youtube_not_found`, a dead grant | `failed` | no | none (the session's own lines already say it) |

- The step never calls `failRow`, `markIfGrantDead` (`prepare.ts:194`) or `recordLiveState`. A dead grant found here is
  left for the end step and the daily check to act on, as `youtube-status.ts` does.
- **The desk.** "The desk" here is the fixture stream panel (`components/v2/fixture-stream-panel.tsx`), where the
  YouTube status line already shows (`youtubeStatusLineOf`, `lib/stream-session-view.ts:138`). The session view
  (`StreamSessionCurrent`, `api-v1/schemas/streaming.ts`) gains `youtubeThumbnail: "set" | "not_verified" | "failed" |
  null`, read in `stream-sessions/current.ts` beside `youtubeStatus`; a table `YOUTUBE_THUMBNAIL_LINES` in
  `stream-session-view.ts` maps it to a key and tone, the same registry shape as `YOUTUBE_STATUS_LINES`. The line shows
  while the session is starting, live or ending, under the status line; `set` and `null` show nothing. Copy in en/es/fr/nl
  under `stream.youtube.thumbnail.*`. Regenerate OpenAPI (RULES.md, Pre-commit).
- `not_verified` is a fact about the channel. Recorded on the connection too (`org_youtube_connections`,
  `thumbnails_unverified_at`) so later broadcasts skip the call for 24 h and the Streaming page can say it once. **Call;**
  see Q3.

## 7. Quota

`thumbnails.set` costs **50 units** (verify on the quota calculator, `/youtube/v3/determine_quota_cost`). Today a match
costs ~5–6 units against the project's default 10,000/day, "~1,700 matches/day platform-wide"
(`2026-10-27-youtube-connect-design.md` §3.1). With a card it is ~55–56 units: **~180 matches/day platform-wide**. That
turns quota from "not a constraint" into the first limit we would hit on a busy Saturday, and a refused thumbnail may still
spend its units (**verify**). There is no runtime quota ledger in the code: the figure lives in that spec only, and
`quotaExceeded` maps to `youtube_limit_reached` (`google.ts`'s `LIMIT_REASONS`), which on the thumbnail path is a slate
line, never a refused Go live. Mitigations: one attempt per broadcast row, at most two; the 24 h skip for unverified
channels; and a quota extension request to Google before turning it on for every org (Q1).

## 8. Tests

House rules: `docs/superpowers/TEST-STRATEGY.md`, all four types (RULES.md §Testing).

- **Unit, pure.** The `"thumb"` model and layout picks (`matchPosterModel` with long names, a missing badge, no court, no
  round, a TBD side); the outcome table of §6 as a total registry test over every `YoutubeErrorCode` plus `forbidden`;
  `YOUTUBE_THUMBNAIL_LINES` proven total like `YOUTUBE_STATUS_LINES`. Expected copy from the dictionary, never from the
  function under test.
- **Unit, renderer.** Render a real card; assert JPEG magic bytes, 1280×720 by `sharp().metadata()`, and size < 2 MB with
  the worst inputs (two 1024 px badges, a logo, the longest names).
- **Fake.** `FakeYouTube` (`server/youtube/fake.ts`) gains `setThumbnail`, a per-broadcast `thumbnailOf(id)`, a channel
  flag `verified` (default true) that answers 403 `forbidden` when false, the 2 MB and content-type checks, and
  `failNext("setThumbnail", …)` as for every method (`fake.ts:171`).
- **Integration (DB).** Tick sets it once; a second tick and a reused broadcast spend nothing (`fake.calls` count); an
  unverified channel writes `not_verified` and the connection stamp and leaves the connection `connected` and the row
  `bound`; a timeout retries once then `failed`; a dead grant does not move the connection. Mutate each guard once.
- **Driver.** `google.test.ts`: the upload URL, `uploadType=media`, the binary body, the content type, and that no token or
  body reaches the error (the existing secrets tests, extended).
- **E2E.** On the fake: Go live with an unverified channel → the panel shows "Thumbnail not set — verify the channel in
  YouTube" and the stream is live; with a verified one → no line. All three widths for the panel line.
- **Smoke / stg.** Owner runs, agent reads: one Go live on a verified stg channel (thumbnail visible in Studio) and one on
  an unverified channel (the real 403 reason recorded — this settles the **verify** in §6).

## 9. Open questions for the owner

- **Q1. Quota: switch it on for everyone, or behind a flag until Google raises our quota?** Recommended: ship behind a
  server feature flag (`isServerFeatureEnabled`), on for stg and a few orgs, and file the quota extension now; turn on for
  all once granted. At ~180 matches/day the default quota is a real ceiling.
- **Q2. Refresh the card when a TBD side becomes known?** Recommended: no. The title is not refreshed either, a court
  phone never starts a TBD match, and each refresh costs another 50 units.
- **Q3. After one `not_verified`, skip the call for that channel for 24 h?** Recommended: yes, and say it once on the
  Streaming page's connection row ("Custom thumbnails need a verified channel"), so a club learns it before match day.
- **Q4. Set it inline in Go live, or on the first tick after bind?** Recommended: the tick. Go live stays as fast as
  today, a transient failure gets its retry for free, and the card still lands within seconds.
- **Q5. Logo or name when the org has both?** Recommended: both, as the poster draws them — logo tile then name; the
  initials tile when there is no logo.
