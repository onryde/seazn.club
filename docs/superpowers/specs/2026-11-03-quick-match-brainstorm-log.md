# Quick match — brainstorm log

The record of how `2026-11-03-quick-match-design.md` came to say what it says: the questions asked, the answers given, the options shown and set aside, and the reviewer's questions with how each was settled. The design file carries only decisions and current truth; this file carries the path. Local file only (O9).

## Files

| File | What it is |
|---|---|
| `docs/superpowers/specs/2026-11-03-quick-match-design.md` | The design. Decisions O1 to O11, designer's calls C1 to C23, how it fits the system, tests owed. The one file a builder plans from. |
| `docs/superpowers/specs/2026-11-03-quick-match-brainstorm-log.md` | This file. |
| `docs/superpowers/specs/mockups/2026-11-03-quick-match/setup.html` | Design of record for the setup screen, drawn with League and with Knockout chosen. Standalone page. |
| `docs/superpowers/specs/mockups/2026-11-03-quick-match/home.html` | Design of record for the quick match home, drawn for a league and a knockout. Standalone page. |
| `.superpowers/brainstorm/77835-1793919584/content/*.html` | Every screen pushed to the browser during the 2026-11-05 mockup round, in order: `setup-layouts`, `setup-v2-night-detailed`, `setup-v3-format-row`, `home-layouts`, `waiting`, `final-screens`. Fragments for the companion server, kept for reference; the two files above are the chosen versions. |

## 2026-11-03: first brainstorm (owner and designer)

Owner's words that set the scope: users are "causual player"; scope "a one or two or best of N matches"; "just use outside login in market page and quickly create and play there"; "ask friendly name to remember with optional email and expire after 7 days"; formats "just league is enough"; sharing "it doesn't matter right? if we can able to use scoring link"; 2 to 6 sides "Ok".

Recorded as O1 to O6. The first draft placed each visitor in a hidden org of their own and claimed by moving that org to the user.

## 2026-11-05: data placement and the reviewer's first two points

The designer put three options to the owner:

- A. Fully separate tables, a second scoring path: set aside as weeks of work that duplicates the most-tested part of the product.
- B. Match rows in the existing tables, guest data in a new `quick_matches` table: recommended.
- Inside B, one system org for every guest match in place of one org per visitor: recommended, because saving then moves nothing between orgs.

Two points from the first reviewer pass, with the designer's recommendation:

1. Sports that need named players (cricket). Recommended: not in v1.
2. What saving takes. Recommended: one match at a time; signing in with an email saves only matches that email was typed on, so a shared tablet cannot hand one person's matches to the next.

Owner, 2026-11-05: "Does B with one system org, lineup sports - we need it ? or optional?, and one-match-at-a-time saving match what you want, yes. no remote repo, no commit." Recorded as O7, O8, O9. The lineup question is the designer's call C11 (optional, v2), left for the owner to overturn.

## 2026-11-05: mockup round (local companion server, no artifacts, at the owner's request)

Round 1, setup, three layouts: A "Scoresheet" (light console page), B "Night court" (the marketing hero's night stage, names first, three tiles), C "Say it in a sentence" (settings as a tappable sentence). Owner clicked B and said: "I like B but with A in details?"

Round 2, setup, B's stage with A's controls, two ways: 1 "Everything open", 2 "Tiles that open". Owner: "1 but play each other instead of show real format, like league, or knockout?"

Round 3, setup with a Format row (League | Knockout) in place of "Play each other", drawn in both states with four sides. The designer flagged that Knockout reopens the 2026-11-03 "just league" decision and adds a bracket to the home. Owner: "stay both format". O5 rewritten; O10 recorded.

Round 4, home, two layouts for a league plus the knockout state: 1 "Table first", 2 "Next match first". Owner: "2 , do you rec?" Designer: yes, the page's first job is scoring the next match from a phone at the court. O11 recorded.

Options set aside in this round: setup A, setup C, setup "tiles that open", home "table first".

## 2026-11-05: builder check

An independent reviewer read the design and the two mockups with no way to search the code (the checkout sat outside the file tools' roots) and asked six questions. How each was settled:

1. Who finalizes a fixture, and what does the pad do at the last point? Settled by code: the scoring path recomputes standings and seats bracket winners when a fixture becomes `decided`; `finalized` is only a lock; the pad has no redirect, the back link is the way home. §7.10, C12.
2. Three surfaces need the plaintext home token but the design stored only a hash. Settled by precedent: store the hash and a sealed envelope, as device links do for printed QR codes. C19.
3. Is "needs a lineup" a property of the sport or of sport × variant, and can a pair or team have zero members? Settled by code: every entrant kind accepts zero members; the lineup question is proven by the create-and-score sweep. C11, C20.
4. Which states and dates must hold for the pad to accept events? Settled by code: only the division being started; nothing in the product changes a status by date. C21.
5. Is the knockout pairing deterministic and callable before creation? Settled by code: the generator is pure and the product already serves a no-database preview of it. C22.
6. Does the ad-hoc match work on a started league? Settled by code: yes, league and group only, refused only on a complete stage, counted in standings. C5.

The code reads also surfaced one thing the reviewer did not ask: a level result in a bracket is held for an organizer's settle, which a guest cannot give. That became C23 (knockout offered only where the sport cannot end level), a designer's call for the owner to check.

## 2026-11-05: the file tools' roots

The checkout lives under `~/Downloads`, which the read-only file wrapper refused, and this session had no file search tools of its own, so surveys could only open files by exact path. The owner chose to widen the wrapper's roots rather than move the folder, and added `~/Downloads` to `github_root_extra` in `~/.cloudeng/tools-config.json` ("done").

## 2026-11-05: three code surveys

With search available, three surveys closed the design's "still to verify" list. Findings of note, all pinned in the design:

- The engine is the npm package `@onryde/seazn-engine`, not source in the repo. Two facts inside it are proven by probe tests rather than read (design §12).
- Cricket's named-player requirement is confirmed by the app's own tests. Every entrant kind accepts zero members.
- Every sport module declares `supportsDraws(cfg, stageKind)`; `core.settle` offers lot, higher seed or organizer's choice, never a replay.
- The fixture generators are pure; `previewDivisionFixtures` runs them with no database and is already served by the format-preview route. Byes go to the top seeds.
- `startDivision` opens its own transactions, so the guest create needs a transaction-taking variant of its body.
- The active-competition quota is lifted per org with an override whose null value means unlimited; slugs already dedupe with a numeric suffix.
- `ends_on` is required by the API but nothing in the product acts on it.
- The full cascade for a hard delete is listed; only the email outbox and the new row need deleting by hand.
- Discovery and the sitemap already exclude private competitions; the news digest and billing grant sweep every entitled org, so the system org's plan grants neither.

## 2026-11-05: owner's questions after the surveys

"how the scoring work? will use devicelink?" Yes. The home link is what friends share; behind it the server mints one device link per fixture, issued by the system user, and sends the phone to the existing pad. The only new pieces around scoring are the guest mint, the per-match check and the back link.

## 2026-11-06: related designs found in the specs folder

Listing `docs/superpowers/specs/` turned up three approved designs that touch this one, now recorded in the design's §12: the W4 knockout family design of 2026-11-04 (standalone knockout, random draw for unseeded entrants, shared third place by default), the W5 round-robin family design of 2026-11-05 approved on 2026-11-06 (standalone league; keeps the ad-hoc "Add match"; engine release order), and the device-link scoring gaps design of 2026-09-21. The quick match seeds every side explicitly so W4's random draw never applies, keeps W4's shared-third default, and asks for no engine change.

## 2026-11-06: files moved, design approved

At the owner's request every file from this work was moved out of the Downloads checkout to `/Users/asubramanian-mac2/Documents/s-new-u/`, keeping repo-relative paths, and the companion server was stopped. The owner then approved the design: "design is approved".

## 2026-11-06: implementation plans

With the design approved, three recon surveys collected exact signatures, paths and test conventions, and three plans were written under `docs/superpowers/plans/`: `2026-11-06-quick-match-1-foundation.md` (table, system org, tokens, atomic create, the sport probe, home read, guest device link, pad back link), `2026-11-06-quick-match-2-surfaces.md` (setup page, home page, score and share, add-a-match, marketing CTA, recent strip, e2e), `2026-11-06-quick-match-3-lifecycle.md` (link and reminder mails, expiry sweep and cron, saving on sign-in, the account list, smoke). Recon findings that shaped them: the four create use cases each open their own tenant transaction and `withTenant` cannot nest, so the create is sequential creates plus one transaction plus compensation; `startDivision` opens its own transactions, so a transaction-taking body is extracted; the sport offer is a generated file from a probe script, pinned by a test. Owner's word while the plans were being written: "no code change".

## Open as of 2026-11-06

- The owner's review of the three plans. No code before the owner says so; the execution method (subagent-driven or native) is chosen then.
