# RS008 — consent claim + name opt-out surfaces

Paste this whole file as the session opener. Read `_RULES.md`, then `_INDEX.md`
(RS007's consent copy), then this. Mixed backend/UI session.

Branch `feat/rs008-consent-claim-optout` in a fresh worktree. One PR.
Design: `../2026-08-16-registration-redesign-design.md` §2 (rulings 4–5), §6.

## Why

Owner rulings: names are public by default; every person can opt out later;
captain-entered players get their consent moment when they claim. The claim
machinery (`person_claims`, V276) exists for account linking — this session
extends it into the consent/opt-out surface, and makes the opt-out actually
change public rendering.

## Scope

1. **Claim = consent moment**: the claim-accept page (existing
   `person_claims` flow) gains the consent block: privacy statement with the
   names-public default (RS007's copy), media consent, and the immediate
   opt-out choice. Accepting a claim sets `registration_players.consent_status`
   → `granted` for that person's pending rows and stamps `persons.consent`.
2. **Opt-out surface**: on the claimed person's own page (wherever
   `person_claims` lands the user today — scout it): "public name" toggle
   writing `persons.consent.public_name`. No account? The status-page roster
   (RS007) already shows consent chips — add a per-player "manage" link that
   sends a claim invite (reuses existing invite machinery, organiser-less).
3. **Rendering enforcement** — the real work: a single display-name resolver
   (server-side) used by EVERY public surface that prints person names —
   public entrants/standings/stats/slideshow paths. `public_name=false` →
   initials (locale-safe initialism, e.g. "A. H."); youth divisions keep the
   stricter of {`player_name_display`, person opt-out}. Org-panel (authed)
   surfaces keep full names. Sweep: `git grep -a` every public render of
   `full_name`/`display_name` on person rows; route them through the
   resolver. **Do not leave two lookup paths** (repo's parallel-vocab-drift
   trap).
4. **Backfill-free default**: RS002 set `public_name=true` at
   materialization; verify persons created by other paths (CSV entrant
   import, manual add) also default true — if not, fix the creation sites
   (not a migration).

## Acceptance criteria

- [ ] Claim flow e2e: captain-entered player claims → consent granted, name
      public; second player claims and opts out → public standings show
      initials, org panel shows full name
- [ ] Opt-out toggle round-trips; flipping back restores full name (ISR
      revalidate accounted for — assert after revalidate, not before)
- [ ] Youth division: `player_name_display` still wins when stricter
- [ ] Resolver unit-tested over the matrix {opt-in, opt-out} ×
      {adult, youth-division} × {public, org surface}
- [ ] Sweep proof: grep inventory of person-name public render sites in the
      PR body, each either routed through the resolver or justified
- [ ] ×4 locales; screenshots of a standings page with mixed opt-outs at
      1280/320
- [ ] Counts from JSON reporter; `tsc EXIT=0`; lint clean; drift gates clean

### Test types

- **Unit** — resolver matrix, claim consent transition.
- **E2E** — claim + opt-out loops. **Smoke** — deferred RS010.
- **Regression** — youth stricter-wins; org surfaces never initialize.

## Gotchas

- Public pages are ISR (revalidate 30) — a toggled opt-out must revalidate
  the affected paths or the test flakes and, worse, prod lies for 30s
  (acceptable; but the TEST must account for it).
- The `persons` identity index is lane-scoped — claims match by email;
  don't create a second person while stamping consent.
- Slideshow + public JSON APIs (`/api/v1/public/...`) print names too — the
  resolver applies there, not just HTML.
- "Initials" must survive non-Latin names — take first grapheme per word,
  not first byte.

## Execution

Scout: claim flow surfaces file:line, every public person-name render site
(the sweep inventory — this is the session's backbone; demand completeness),
ISR revalidate helpers. One implementer loop; reviewer focus: resolver
bypass sites, ISR staleness in tests, grapheme handling, two-path drift.

## On close

`_INDEX.md`: RS008 → DONE + PR#, the resolver location (single source),
sweep inventory count, any surface deliberately left full-name. Memory +
snapshot.
