# W2c screen mockups — design of record

Owner-reviewed brainstorm mockups for format-matrix W2c (stage-level rules), copied from the brainstorm session
(`.superpowers/brainstorm/23178-1791883247/content/`, git-ignored scratch) so they survive. Each file shows the
options the owner was offered; the owner picked **option A (the first option shown) on every screen**. Rulings are
recorded verbatim in the W2c state file and summarised in the spec §2
(`../2026-10-13-format-matrix-w2c-design.md`).

| Screen | File | Owner pick | Built in |
|---|---|---|---|
| S1 — Stage rules: where the organiser sets them | `stage-rules-layout.html` | A — inline, grouped: extend the stage card's Format row (summary line → "Edit rules" expands Match format · Deciders · If abandoned · Points) | Task 17 (S1 + S4 on the stage row) |
| S2 — One match's format before it starts | `match-override-layout.html` | A — "Match rules" block on the match's own console page | Task 19 (S2 + S4 on the match) |
| S3 — Stage points (ST-G8) | `stage-points-layout.html` | A — sentences, live preview line on top | Task 18 |
| S4 — Locked rules | `locks-layout.html` | A — say it before they try: locked sections read-only with one 🔒 line naming the started stage and what to do instead | Tasks 17, 19, 20 (division settings) |
| S5 — Armageddon on the scorer's pad | `armageddon-pad.html` | A — facts, then the engine decides: "Who had Black?" → "Result?" | Task 21 |

These are layout and flow mockups, not pixel specs. The build follows the repo's mobile-first bar (320 / 768 / 1280,
no horizontal scroll; `/admin` excepted), localises all chrome in the 4 dictionaries, and is signed off per screen by
the owner against a screenshot of the BUILD beside the mockup.
