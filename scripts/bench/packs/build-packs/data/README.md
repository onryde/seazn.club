# suite 11 research inputs

Primary-source datasets behind `packs/suite11.json`. These are INPUTS to
`build-packs/suite11.ts`, never outputs of it — the builder reads them and
never writes them, so a re-run can never launder a hand edit into the pack.

- `suite11-pdc-worlds-2025.json` — 2025 PDC World Darts Championship
  (15 Dec 2024 – 3 Jan 2025, Alexandra Palace). Wikipedia raw wikitext as
  primary, with `Template:PDCFlag` expanded for nationalities (the flags are
  not in the wikitext); ESPN and Sky Sports cross-checking the final and the
  semi-finals. 96 players, 95 matches, 431 sets, 28 sessions over 16 playing
  days plus four no-play days.
- `suite11-pdc-womens-series-2024.json` — PDC Women's Series 2024 Event 1
  (23 Mar 2024, Wigan). DartConnect event feeds as primary, Wikipedia
  corroborating the last eight matches. 111 entrants, 110 contested matches
  plus 17 byes, 584 legs, 16 boards.

Every gap is declared in each file's `meta.unknowns`. Read it before treating
a missing value as a bug: several absences are facts about what the sources
publish, not omissions. `pdc.tv` is a client-rendered SPA and `pdpa.co.uk`'s
2024 event pages 404 — neither is a usable source, and both were tried.

Three things about this data that are easy to get wrong, each already paid for:

1. **Div B's match times come from the recap pages, not the completion feed.**
   `complete_date` / `complete_time` on DartConnect's board-management endpoint
   are match ENDS, and `sched_time` is null on all 110 rows — no scheduled
   start was ever published. Reading that feed as a start shifts every match
   by its own length, and every downstream check still passes.
2. **`matchNo` restarts per round in Div B** (63 duplicates across 127 rows)
   while Div A numbers 1..95 event-wide. A fixture key built from `matchNo`
   alone collides and silently overwrites streams. Round + `matchNo` is the
   unique key.
3. **The Div B timetable really does overlap once**, on board 2 — R3 Pinch v
   Frauenfelder 12:23–12:40 against R4 Hedman v Sherrock 12:32–12:43, with all
   three DartConnect feeds agreeing. It is left verbatim. Shifting it to make
   the feasibility certificate happy would be inventing an attributed fact.

Guarded by `__tests__/suite11-data.test.ts`, which reconciles set and leg
scores against round formats, walks the bracket round by round, and pins both
the overlap and the key-collision facts above.
