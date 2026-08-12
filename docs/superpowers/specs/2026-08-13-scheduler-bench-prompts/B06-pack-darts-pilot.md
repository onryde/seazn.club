# B06 — pack: darts (suite 11, PILOT — proves the playbook)

Read `_RULES.md` → `_PACK-PLAYBOOK.md` → `_INDEX.md`. Depends on B05.
Worktree; one PR. **Pilot duties**: first real suite through the whole
pipeline; PackSchema FREEZES when this merges (additive-only after,
via escalation); throughput baseline measured here.

## Suite sheet

- **Suite 11 — org "PDC Worlds"** (generic module — verify at re-pin how
  generic maps legs/sets; the pack encodes matches as generic score
  events per its vocabulary).
- Div A: PDC World Championship 2025 main draw (Littler d. Van Gerwen
  7–3 in the final; 96-player staggered knockout — encode from R1/R2
  per the real bracket; byes are §7A adaptations if the stage generator
  lacks them). Div B: PDC Women's Series 2024 subset (one event's
  knockout — pick the best-documented; record choice in the sheet).
- Cfg: sets-based scoring at generic fidelity ceiling; tiebreakers n/a
  (knockout).
- Sources: PDC/Sky published results, Wikipedia match-by-match set
  scores, official draw sheets.
- Squads: individual entrants (~96 + ~16 persons); officials: the
  callers/refs for finals nights where published.
- Constraint scenario (§5): ONE court ("Ally Pally stage"), two
  sessions/day (`sessionWindows` afternoon + evening), 3–4
  matches/session via day caps, 16 playing days, pins for the final
  session. The hardest single-court packing believability case.
- Certificate: full — the real session schedule is published →
  `historicalAssignment` complete.
- Specials: none mechanical (no ties possible) — this is deliberate for
  the pilot: mechanics stay simple while the PIPELINE is proven.
- Oracles: champion; per-round results; leaders = most sets won /
  highest average IF representable at generic tier (else §7A drop,
  recorded); claims for 3 stars; news drafts on finals.
- Adaptations expected: byes; walkover if any withdrew.
- Size: ~110 matches, ~2–4 events each (set results) → small streams,
  ~120 persons.

## Pilot-specific acceptance (on top of the playbook's)

- [ ] Throughput baseline recorded (events/s single-POST) → `_INDEX.md`
- [ ] PackSchema gaps found here are FIXED IN B02's file this session
      (last free change), each named in the PR
- [ ] Playbook corrections discovered while executing → edit
      `_PACK-PLAYBOOK.md` in this PR (the pilot's real deliverable is a
      trustworthy playbook)
- [ ] Single-court believability: gap-dispersion + session-packing
      metrics present; round-order gate exercised across 16 days
- [ ] `_INDEX.md`: B06 → DONE + provenance % + adaptation list

## Verify

Playbook §4 run + the standard suite gates; counts pasted from the JSON
reporter; report.md attached to the PR.

## Output cap

Final message under 15 lines — pack stats (matches/events/persons),
provenance %, gate summary, throughput, schema/playbook edits made.
