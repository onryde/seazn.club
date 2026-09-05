# W0 — capture the existing public pages, show two options, get the pick

Read `_RULES.md` → `_INDEX.md` → spec §"Current state" and §W0:
`../2026-09-04-spectator-surface-design.md`. No product code in this wave.

## Why the wave exists

Block I of the spec's current state is what the code says. A read is not a
run: before any match-centre or poster code, a person has to have SEEN every
existing public page on a phone and a desktop, on a prod build, with real
cricket data, and the owner has to have picked a visual direction from two
real options laid over those screens. Building the wrong composition is the
most expensive mistake available here.

## Scope

1. Env: `seazn-env up --label spx` from the worktree (skill `seazn-local-env`,
   §5 red signatures first). Prod build, not `next dev`.
2. Seed one PUBLIC competition (`visibility: "public"`) with two divisions:
   cricket (tier-3 ledger — one match finished with a result, one live
   mid-innings with a wicket, a wide and a no-ball in it; entrants with
   realistic 20–43-character names) and football (one finished, one upcoming).
   Seed via the API from a Playwright script, the way the walkthrough specs do.
3. Capture at 320/375/768/1280: org home, competition, division (each tab),
   fixture (cricket live, cricket final, football final, football upcoming),
   player, news feed, register (capture only). Filenames
   `w0/<page>-<state>-<width>.png` under the scratchpad; the set is attached to
   the docs PR as a zip or a linked artifact.
4. For every screen, a **control-set diff 320 vs 1280** from the live DOM
   (membership, order, repeats) and a one-line verdict: designed / shrunk /
   broken, with the customer cost. Append as **Current state block II** to the
   spec.
5. Two options each, on the seeded data, as a design artifact:
   - match centre at 320 and 1280, live and final (A and B differ in
     composition, not colour — e.g. A: header + tab rail + accordion
     scorecard; B: single scrolling page with sticky score strip and section
     anchors);
   - poster feed 1080×1350, upcoming variant (A and B differ in crest
     treatment and hierarchy).
   Current-state screenshots sit beside the options.
6. Owner picks. Record the pick in the spec §Decisions and `_INDEX.md`.
7. `seazn-env down --label spx`. No standing env.

## Do NOT touch

Product code, dictionaries, e2e specs, the organiser console. Registration
pages are captured only (RS owns them).

## Output

- Spec §"Current state block II" filled, per screen, with `file:line` where a
  cause is known.
- Artifact link in the spec header and `_INDEX.md`.
- Owner pick recorded; `_INDEX.md` status → W1 "Ready to plan".
- Then invoke `superpowers:writing-plans` for W1.
