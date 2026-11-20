# YouTube Connect: channel-safety guards (short design)

Date: 2026-11-19. Status: DRAFT, awaiting owner approval. Size: small change (one PR).

## Intent and why
The owner's own YouTube channel was terminated (Spam, deceptive practices and scams; final appeal rejected 2026-11-19) after
3-4 quick unlisted test live streams. Unlisted did not protect it. A burst of short lives on a young channel reads as spam to
YouTube. Seazn drives customers' real channels through YouTube Connect, so it must not create that pattern, and must warn
customers who are about to.

## Goals
- No automatic retry loop creates and deletes broadcasts on a customer channel.
- Before Go live, warn a customer whose channel is young or has recent short broadcasts.
- Every broadcast carries a clear, human description of the match.

## Non-goals
- No hard cap on human Stop/Go live restarts (a phone drop or rain delay must never kill a live match).
- No privacy-default change (unlisted does not help; privacy stays the per-connection `default_privacy`).
- No admin UI, no changes to title format, no changes to how streams are relayed.

## Anti-goals
- Blocking an organiser mid-match. Any guard that refuses a human tap beyond a runaway-bug ceiling is a failure.

## Approaches considered
- A. Hard caps (backoff, 2 restarts per fixture per hour, org rate limit): protects, but blocks real organisers. Rejected.
- B. Guard the pattern, warn, never block humans: CHOSEN by owner (2026-11-19, "B").
- C. Guidance only: least protection. Rejected.

## Design (B)
1. **Backoff for auto-start churn.** Today only `not_enabled`/`blocked` pause auto-start (10 min). Extend `freshLiveRefusal`
   to `limit_reached`, `channel_busy`, `unavailable`: delay = min(60s * 2^(n-1), 30 min), reset on success. Recorded where
   `failRow` already records channel state. A human tap always still asks YouTube.
2. **Runaway ceiling.** A fixture may create at most 10 broadcasts per rolling hour; the 11th refuses as `limit_reached`
   with copy. Constant in `lib/youtube.ts`. Derived from existing parts data.
3. **Channel facts on connect.** Read `channels.list?part=snippet&mine=true`, store `channel_created_at` (`publishedAt`).
   YouTube does not expose the live-activation date; we only have the `liveEnabled` state, so no activation date is stored.
4. **Pre-Go-live warning (non-blocking).** Show before Go live when EITHER: channel is under 30 days old, OR
   `liveBroadcasts.list` (mine) shows 2 or more broadcasts in the last 24h that lasted under 10 minutes (counts streams made
   outside Seazn too). Copy: several short test streams can get a YouTube channel flagged, even unlisted; test on a
   throwaway channel. The organiser can still proceed with one tap. Warning applies to human Go live; auto-start never
   blocks on it. If the YouTube call fails, show no warning (fail open, log it).
5. **Description.** Built from real fixture data: sport, division/round, competition, venue (if any), date/time, ONE match
   link, ONE footer "Scored live with Seazn Club". No hashtags. Language = competition/org locale, fallback English, from
   dictionary keys in all 4 locale dictionaries (then regenerate i18n keys). Title format unchanged.

## Constraints
- Server code: read `apps/web/src/server/MODULARIZATION.md`; work in a worktree; all 4 required test types; scoped tests only.
- Quota: `channels.list` and `liveBroadcasts.list` cost 1 unit each; do the warning check once per Go live tap, not per beat.
- Any column needs a migration (next free V number; greenfield schema stance).

## Tests owed
Backoff curve incl. reset and human-tap bypass; ceiling boundary (10th ok, 11th refused, window rolls); warning predicate
(young channel, 2 short, 1 short, 2 long, API failure => no warning, still proceeds); description per locale with and without
venue; sequence cases (second call, after Stop, after refusal). Mutate each guard once; report how many cases each sweep checked.

## My calls (owner may change)
30-day channel age; 10-minute "short"; 2 broadcasts in 24h; backoff 60s doubling to 30 min; ceiling 10 per hour; warning is
non-blocking and fails open.

## Left to the builder
Column names, exact copy wording (English plus 3 locales), where the warning renders in the Go live UI, rate-limiter reuse if
the org-route limit is kept as a bonus.
