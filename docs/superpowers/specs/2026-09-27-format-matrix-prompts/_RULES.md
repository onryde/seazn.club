# Format × sport matrix — standing rules

Every session in this programme reads this file and `_INDEX.md` first. Repo-wide
policy (`AGENTS.md`, `docs/superpowers/RULES.md`) still applies; these rules add
to it.

## Sequencing

- **R1.** W1a → W1b → W1c → W1d → W2 … W7 run strictly in sequence, each in
  its own worktree. They share `packages/engine` and
  `apps/web/src/server/usecases/stages.ts`.
- **R2.** W8, W9, W10 are parallel lanes. A lane starts only after listing its
  file set and proving it disjoint from the wave in flight. A production change
  that forces an edit in the other lane's files → stop and sequence.
- **R3.** This programme never edits `scripts/bench/lib/suites/run-suite.ts`
  or the PackSchema (ruling 17). It may import the bench's small helpers; a
  change to one of those helpers is coordinated with the bench's index first.

## Authority

- **R4.** Owner rulings and my recommendations live in separate sections of
  `_INDEX.md`. Never send either to a peer session labelled as the other.
- **R5.** Audit gaps are hypotheses. A behavioural gap enters a wave's backlog
  only after a truth run reproduces it; a non-behavioural gap (test gap, doc or
  dead code, print or credential gap) is verified by reading the code or by a
  failing test. One that does not hold goes to "False premises found".
- **R6.** The rulebook decides disagreements between the reference model and
  the product. A silent rulebook → ⬜ *needs ruling*, put to the owner as a
  recommendation with its owner value — never guessed.

## The reference model

- **R7.** `packages/reference/` never imports `apps/web`, and imports
  `@seazn/engine` at most as `import type` from its core types (or nothing, if
  W1b chooses a leaf types package). The boundary is a CI gate in the style of
  `scripts/engine-boundary.ts`, not a convention.
- **R8.** A wave's reference model is written from its signed-off rulebook by a
  different agent than the one fixing the engine in that wave.
- **R9.** Expected values are derived from the rulebook and the sport's
  *declared* config — never from the product's output, never from a table
  typed into a test (`AGENTS.md` class 19).

## The harness

- **R10.** `MATRIX.md` is generated from harness JSON. Never hand-edit it.
- **R11.** L2's pair-covering list and the variant list are committed files.
  Regenerating them is a reviewed change, never a runtime random draw.
- **R12.** ⬜ means a missing decision and 🚫 a missing product path. A case
  moves to ⬜ only when its rulebook is silent, to 🚫 only when no route or
  screen exists, and to ⏳ only when its cause is routed to a later wave —
  never to park a red.
- **R13.** An empty result is a failure: an empty pairing, an empty generate,
  an empty table, an empty sweep. Every rule set states its empty case first
  (competition-desk lesson; `AGENTS.md` classes 6 and 15).
- **R14a.** The repo is public: harness output uses synthetic organisations and
  people only, and never prints a secret, token or production value.
- **R14.** Every full run starts on a fresh DB with `sync:sports`; confirm
  `show data_directory` is yours (`seazn-local-env` skill).

## Proof

- **R15.** A seam is proven only through its real producer and consumer
  (`AGENTS.md` class 1). The builder's own output goes through the real engine.
- **R16.** Pin what a control OPENS AT, not just that it is reachable — seeded
  values are asserted against the sport's declared config (class 19). At least
  one case per guard where the right answer differs from the wrong one's
  constant.
- **R17.** Mutate every guard one at a time; still green ⇒ the test is
  decoration (class 3).
- **R18.** Run whole spec files, never `-g` slices; a serial file's red count is
  a floor, re-run until a full pass (class 21). Sweep by behaviour, never by
  filename (class 16).
- **R19.** Judge vitest green only from `--reporter=json --outputFile`, run from
  `apps/web` (or the package), confirming `.testResults[].name`.
- **R20.** Drive the product before claiming a cell works. Write down what you
  saw, never what must be true.

## Process

- **R21.** Never skip the implementer → reviewer loop (class 12). Green and
  pushed is not done (class 8).
- **R22.** Persist state and decisions in `_INDEX.md` as they happen, not at
  the end of a session.
- **R23.** Any new or changed user-facing string → all 4 locale dictionaries +
  `pnpm i18n:gen-keys`.
- **R24.** UI changes: ≥2 options shown to the owner before building; visual
  verdict per screen at 1280, 768, 320; no horizontal page scroll.
