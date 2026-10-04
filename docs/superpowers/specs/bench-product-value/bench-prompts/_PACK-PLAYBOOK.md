# Pack authoring playbook — B06–B16

Every pack session follows this recipe; the per-session prompt carries
only the suite sheet (sources, structure, constraints, specials,
oracles). Read `_RULES.md` §4 first. Spec: bench design §4 (packs), §5
(constraints), §7 (misalignment), §8 (specials).

## Phases

1. **Research (internet, authoring-time only).** Fill the suite sheet's
   blanks from primary/public sources: participants, full squads (with
   the roster metadata the sport needs — squad numbers, positions,
   captain, libero, pairs), officials, per-match events at the sport's
   deepest engine-accepted tier, final tables/brackets, stat leaders,
   suspensions, the historical timetable (venue + start time per match
   where published). Cite every source URL in `meta.sources[]`. Where a
   sequence is not archived, reconstruct per §4 (legal sequence → exact
   real score) and flag `provenance:"reconstructed"` — never guess an
   ATTRIBUTED fact (scorer, card, wicket); an unattributable fact is a
   §7A adaptation, not an invention.
2. **Build.** `tools/bench/packs/build-packs/<suite>.ts` emits
   `tools/bench/packs/<suite>.json` conforming to the FROZEN
   PackSchema (B02; additive change = escalate, never silent). Builder
   is deterministic (no Date.now/random) and committed alongside its
   inputs (checked-in raw data files where licensing permits, else the
   transform from cited URLs).
3. **Validate offline.** Stage-0: every stream folds; folded per-match
   outcome == pack expected; derived standings == expected tables incl.
   exact tie order; specials assert (super over / shootout / DLS / OT /
   tiebreak / expedite per sheet). All in-process, seconds, no DB.
4. **Run the suite.** Full bench run for THIS suite against a fresh
   local env (`--suite <key>`), both engine modes once
   (`--engine both`), gates green, report attached to the PR. Delta vs
   the historical timetable lands in the report as similarity %, not a
   gate.
5. **Record.** Update `_INDEX.md`: session → DONE, provenance %,
   adaptations count + the interesting ones, any §7B finding (with its
   fix-inline-vs-escalate outcome), runtimes observed (informational).

## Per-pack acceptance (every pack session)

- [ ] PackSchema-valid; builder deterministic; sources cited
- [ ] Stage-0 green: fold==expected per match, tables exact incl.
      tie order, all sheet specials asserted
- [ ] Provenance: every stream flagged; % in report; zero unflagged
      reconstructions (spot-check N=5 attributed events against sources)
- [ ] `meta.adaptations[]` complete — anything reshaped from reality is
      written down (§7A); certificate data (`historicalAssignment`)
      present where the sheet says it exists
- [ ] Suite run green end-to-end locally: seed → schedule (zero blocking
      conflicts, independent checker clean, certificate check per §6.3)
      → simulate → oracles (champion, tables, leaders, suspensions,
      specials) → people-layer steps — naming what is actually WIRED, as of
      B06a:
      - officials: rostered, blackouts honoured, manual + auto assignment
        (B03, B04)
      - claims: invites minted (B03) AND **accepted** through the real
        invitee flow, with an invalid token proven refused (B06a T6)
      - news: drafting turned on before the folds, named fixtures published,
        the rest proven still draft, republish proven inert (B06a T7)
      - device hand-over: for any pad-tapped fixture, the device link is
        MINTED through the real entitlement gate (`scoring.device_links`),
        its QR decodes to the exact minted secret URL and its copy button's
        clipboard content matches byte for byte (both proven in a real
        browser, not asserted from the mint response alone) (B07a T9/T10/
        T11 — proven live on `_tiny`). It is **NOT revoked after use** —
        tap-minted links are unrevoked BY DESIGN, owner-accepted (2026-09-14
        — throwaway org, day-scoped secrets, no blast radius); this counts
        as closed because a decision was made, not because revoking was
        built. (The only revoke in this codebase mints and immediately
        revokes a *different* link, inside the entitlement-gate's own paywall
        probe — `dls-gate.ts` — never the tap driver's device link.)
      - coach lanes: **NOT WIRED — deferred, no step exists.** Named here so
        a pack session records the gap rather than assuming it is covered
- [ ] Entitlement: recorded, not faked. Entitlements v18 W1 deleted the
      fidelity-band gate, so **most suites have no paid scoring tier to
      unlock** — see `_RULES.md` §3. A suite whose sport IS gated provokes
      the refusal with a key DERIVED from the live catalog and then clears
      it by provisioning; a suite whose sport is not gated satisfies this
      item by saying so in the report. A SECOND key is now live-proven the
      same way for any pad-tapped suite: `scoring.device_links` — the DLS
      probe (`lib/dls-gate.ts`, B07a T11) mints refused pre-plan, mints
      clearing post-plan, and revokes; a tap suite reuses that probe rather
      than re-deriving the gate
- [ ] Report committed under the PR (json+md), timings present,
      NOT asserted. Throughput figures in a pack report are a **FLOOR**, not
      a measurement: they are whatever that pack's stream volume happened to
      exercise on one machine. B08 (cricket, the volume monster) owns the
      real measurement — do not quote a pack's number as a capacity claim
- [ ] Unit/regression for any new reconstruction generator or oracle
      differ added for this sport (bench lib tests, CI-safe)

## Authoring constraints the schema enforces (B02)

Learned in B02 and enforced by `PackSchema` / stage 0 — a pack that breaks
one of these is refused before any suite runs, so meet them while authoring
rather than debugging them later.

- **A court, an entrant and an official cannot share a name.** Sigil
  references (`@name`) resolve in ONE namespace across all three, so a name
  reused across kinds is ambiguous and refused. Rename one — in
  `meta.adaptations[]` if the source really did use the same string.
- **Bind a stream to its stage (`streams[].stageRef`) whenever the stage
  carries a cfg overlay.** A stream binds by `divisionRef` + `fixtureExtKey`
  alone otherwise, and an unbindable overlay is stage 0's one FALSE-RED path
  — a knockout stage declaring `shootout` folds under the wrong cfg and the
  pack is blamed for an engine-correct result.
- **`legs` must match the meetings actually present.** Two entrants meeting
  twice IS a two-leg league; stage 0 warns `streams.count_mismatch` on the
  mismatch. A B02 fixture carried this error and it survived a full review.
- **Declare `provenance` on every stream** — the validator reds when it is
  MISSING. Note that an absent enum and an invalid one are indistinguishable
  in the reported issue (measured on zod 4.4.3), so read the field, not the
  message, when debugging.
- **Leaderboards, champions and suspensions are NOT derived offline.** Stage 0
  says so with a `*.not_derived` WARNING rather than staying silent, so every
  pack carries warnings by design and a green run still prints them. **A
  runner must gate on `result.ok` (no error-severity finding), never on
  "any finding".** Those oracles are owed to the seeded HTTP run in B05, so a
  mis-transcribed leaderboard will not be caught until then — transcribe with
  that in mind.

## Suite sheet template (what each B06+ prompt contains)

```
Suite <n> — <org name>
Div A: <tournament, format, stages>       Div B: <...>
Sport/variant cfg notes: <presets, cfg overrides, tiebreakers>
Sources: <primary URLs / archives>
Squads: <size expectations, roster metadata needed>
Officials: <named refs/umpires + assignment expectations>
Constraint scenario (§5 row): <courts, windows, blackouts, rest, caps, pins>
Certificate: <historical timetable availability: full/partial/none>
Specials (§8): <the real instances to capture, by match>
Oracles: <champion; table rows w/ points+GD/NRR/etc; leaders w/ counts;
          suspensions; special outcomes>
Known adaptations expected: <e.g. bench-as-organizer R16 seeding>
Size estimate: <matches, events, persons>
```

## What the pilot learned (B06b, suite 11 — darts)

The pilot's real deliverable is a playbook the next nine pack sessions can
trust, so every correction below was paid for while authoring suite 11. Each
one cost a red run or a wrong answer; none is derivable from the schema.

- **A PAYLOAD ref is sigilled `@`; a STRUCTURAL ref is bare.** `streams[].home`,
  `streams[].away` and every `expected.*` ref are bare; `generic.score.by`,
  `person`, and anything else inside an event `payload` carry `@`
  (`pack-schema.ts` header note 6). **Nothing but stage 0 can catch a missing
  sigil** — `PackSchema` treats an unsigilled payload string as a literal by
  design, so it parses clean and then folds against an entrant the engine has
  never heard of. Suite 11 shipped its first draft with all 205 streams broken
  this way, and stage 0 named every one of them offline in seconds.

- **Fixture ext keys belong to the PRODUCT for any generated stage.** A
  knockout emits `se-r{round}-i{index}` (`bracket.ts:170`, `:197`), a round
  robin `rr-r{round}-c{court}` (`roundrobin.ts:140`), americano
  `am-r{round}-c{court}`. A pack cannot mint its own for those stages — it must
  reconstruct the structure and read the keys off it. Round 0 of a knockout
  emits a fixture for EVERY pair INCLUDING the byes, so a 128-slot draw is 127
  fixtures whatever the entrant count.

- **`slotOrder` is a list of SEED NUMBERS, not entrant ids**
  (`bracket.ts:135-152`), resolved through `seedOrder` (`roundrobin.ts:62`),
  which falls back to the product's **input order** for unseeded entrants —
  something no pack controls. **Seed every entrant** so the draw is a pure
  function of the pack, and record the artificial numbers as an adaptation.
  Prefer `slotOrder` over `byes` whenever the real bracket is recoverable:
  `byeEntrants` hands the pairings to the product, which will pair entrants who
  never met while the pack still asserts the real results.

- **Let the engine derive the score.** In `generic`, a `generic.result` card
  with NO `p1Score`/`p2Score` settles from the running tally
  (`generic.ts:110-114`). Encoding the totals on the settling card makes
  `expected.matches` compare the pack against itself — a tautology that passes
  forever. The same instinct applies to every module: carry the raw units, let
  the engine produce the outcome.

- **Derive expected values from the streams you just built**, never from a
  table typed into the builder. A leaderboard transcribed by hand freezes what
  the author believed on the day; one recomputed from the pack's own events
  moves when the data moves. Pick entries whose counts DIFFER, or a comparator
  returning a constant passes.

- **Real data can violate your own constraints, and that is not a bug to
  edit out.** Suite 11's published Div B timetable double-books one board.
  Three independent feeds agree, so it is a fact about the event; shifting a
  match to make the feasibility certificate happy would invent an attributed
  fact. Carry it verbatim and let the certificate report it — §6.3's order
  (check the history against the encoded constraints BEFORE reading any solver
  INFEASIBLE as a finding) exists exactly for this.

- **The feasibility certificate had never run against real data before suite
  11.** `certify` returns `SKIPPED_NO_HISTORY` when a division declares no
  `historicalAssignment` (`certificate.ts:129`), and `_tiny` declares `[]`. So
  a pack with a populated timetable is exercising that path for the first time
  — treat a certificate red as a candidate bench/product finding, not
  automatically a pack bug.

- **A walkover is `core.forfeit`, NOT a result card. Suite 11 got this wrong
  and the correction is the important part of the entry.** This playbook
  previously said there was "no route to forfeit an existing fixture" and that
  a pack had to encode a walkover as an administrative 1-0. Both halves were
  false, and the 1-0 is actively harmful: leaderboard expectations derive from
  the streams, so a score nobody played flows into player stats as real, under
  the name of a real person.

  What is actually true. `forfeited` is a fixture status with more than one
  writer — the bracket generator stamps byes (`stages.ts:1351`), AND
  `append-event.ts:127` derives it from ANY active `core.forfeit` in the
  ledger, which is how `withdrawal.ts:102` records one. The scoring door
  (`usecases/scoring.ts`) applies no event-type allowlist: the sport module's
  own reducer is the only validator, so a pack may post `core.forfeit` on any
  fixture exactly like any other event.

  Encode it as:

      { "type": "core.forfeit", "payload": { "by": "@e-<the side that did not play>", "reason": "walkover" } }

  and expect `outcome.kind` `"award"` with `method` equal to your `reason` —
  since 2026-09-11 every sport module carries the reason through
  (`core/forfeit-reason.test.ts` sweeps all of them; `boardgame` is the one
  declared exemption, because its outcome method is its own typed enum). NO
  score is recorded, which is the whole point.

  The one true constraint from the original entry, kept: in
  `resultMode: "score"` a RESULT CARD with no scores and no tally is refused
  (`generic.ts:119-120`) — which is a reason to use the forfeit event, not a
  reason to invent a 1-0.
