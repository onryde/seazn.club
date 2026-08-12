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
2. **Build.** `scripts/bench/build-packs/<suite>.ts` emits
   `scripts/bench/packs/<suite>.json` conforming to the FROZEN
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
      specials) → people-layer steps (officials, claims, coach lanes,
      news) — as wired in B03–B05
- [ ] Entitlement: suite org's plan unlocks its deepest tier (422 test
      proves the gate exists, then provisioning clears it)
- [ ] Report committed under the PR (json+md), timings present,
      NOT asserted
- [ ] Unit/regression for any new reconstruction generator or oracle
      differ added for this sport (bench lib tests, CI-safe)

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
