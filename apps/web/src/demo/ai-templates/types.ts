// #364 — the shape of a committed marketing-demo fixture.
//
// One JSON per template, captured ONCE from a real architect run (Task 3) and
// then rendered forever by the public page. The fixture is deliberately THIN:
// it stores the run's INPUTS (the deterministic pack, the board the organiser
// would have been looking at, the movable set) and the run's verified wire
// RESPONSE — and nothing that the product can recompute. Trace, diff and price
// are derived at render time by the same pure functions the real console calls,
// so the demo cannot drift into showing something the product no longer does.
//
// `pack` and `response` are `unknown` on purpose. Their real types live behind
// server-only modules (`SchedulePack`/`CompetitionPack`, `AiPlanResponse`/
// `AiCompetitionPlanResponse`), and a public marketing page must not import
// those. Each consumer re-parses the half it needs with its own schema — which
// is also what makes the drift guard (Task 4) a real tripwire rather than a
// cast: it re-validates every committed run against TODAY's zod and TODAY's
// deterministic referee.
import type { AiConsoleFixture } from "@/components/v2/board/ai-diff";

export interface AiDemoFixture {
  meta: {
    /** Template id — matches the `<slug>.json` filename and `SeededTemplate`. */
    slug: string;
    /** When the run happened. Capture-time truth, not fixture data: the page
     *  says "recorded from a real run" and owes the reader a date. */
    capturedAt: string;
    /** The model that ACTUALLY served the winning ladder rung, read back off
     *  the run's own `schedule.ai_generated` ledger row — not a default and not
     *  the first rung tried. */
    model: string;
    /** The commit the capture ran at, so a fixture can be traced to the code
     *  that produced it. */
    commit: string;
    mode: "generate" | "repair";
    joint: boolean;
    /** The organiser's sentence, verbatim — the demo shows it being typed. */
    instruction: string;
  };
  /**
   * The board as the console holds it: every occupying fixture of every
   * division in the run, in draw order, in the exact `AiConsoleFixture` shape
   * `consoleFixtures()` produces for the real board. The diff, the ghosts and
   * the review rows are all computed from this plus `response`.
   */
  board: {
    fixtures: AiConsoleFixture[];
    /** Every court in the run. For a joint template this is the UNION; the
     *  per-division sets stay recoverable from `pack.divisions[].settings`. */
    courts: string[];
    /** Display names for every entrant on the board, including any who
     *  withdrew after the draw (they still own fixtures). */
    entrants: { id: string; name: string }[];
    window: { start: string; end: string };
  };
  /** The DETERMINISTIC pack — `buildSchedulePack`/`buildCompetitionPack` at the
   *  capture's anchored instant. Reproducible from the seed builders alone,
   *  which is what the `--check` companion test asserts on every run. */
  pack: unknown;
  /** The fixtures the run was allowed to move, in pack order. */
  movableIds: string[];
  /** The verified wire response — `AiPlanResponse` for a single division,
   *  `AiCompetitionPlanResponse` for a joint run. */
  response: unknown;
}
