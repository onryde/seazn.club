import "server-only";
import type { PackCourtInfo } from "@/lib/court-directory";
import type { SchedulePack } from "./types";

/**
 * What actually goes on the wire to the model: the pack MINUS `participants`
 * and `assumptions`.
 *
 * Both fields are server-side enforcement inputs, not prompt material. #396
 * gives the referee and the greedy placer the full advancer sets; it does not
 * change what the model is shown (design §3.1 — W2 is the only wave that moves
 * the prompt boundary, and W3 §7.3 teaches the advancer RULE in five sentences).
 *
 * The cost of getting this wrong is measured, not guessed. On a 500-fixture
 * elimination bracket (`schedule-ai-pack.test.ts`) the pack with `participants`
 * inlined is 100,252 proxy tokens against a 60,000 ceiling; the payload without
 * them is 51,341. (Even the flat 500-fixture league board saves 5,258: an empty
 * participant list per fixture is still 500 uuid keys.) Inlining the pack here
 * again re-breaks the budget on every bracket board, so send
 * `toModelPayload(pack, courtDirectory)` — never `pack`.
 *
 * Written field-by-field rather than as a rest-spread on purpose: the return
 * type makes `tsc` fail here the moment `SchedulePack` gains a field, so what
 * reaches the model is always a decision somebody made, never a default.
 *
 * P9 pass 3d: also the ONE seam that relabels every court-shaped field —
 * `settings.courts`, `settings.blackouts[].court`, a movable fixture's own
 * `current.court`, an obstacle's `court`, and `court_label` on the draft and
 * any prior proposal — from the real id `pack` carries throughout to a
 * human-readable name, via `courtDirectory` (id -> {label, venue, tags},
 * built by `buildSchedulePack`). `courtDetails` is new: the model had no way
 * to see a candidate court's venue or tags before this pass. Every OTHER
 * consumer of `pack` (`structuralCheck`, `toEngineAssignments`,
 * `verifyConfig`, `computeDiff`, apply) reads `pack` directly, never this
 * function's output, and keeps working in ids unchanged — this is a pure
 * rendering step, not a change to what the pack itself stores. The model's
 * own answer is resolved back to ids immediately (`resolveModelCourtLabels`
 * in `runAiPlan`), before any of those run.
 */
export function toModelPayload(
  pack: SchedulePack,
  /** id -> display info, from the SAME `buildSchedulePack` call that built
   *  `pack`. Defaults to empty, which makes every `label()` call below an
   *  identity function — courts render exactly as they did before this
   *  pass — so a caller with no directory to offer (chiefly the test suite,
   *  which often builds its own pack with human-readable "ids") is
   *  unaffected. */
  // P9 pass 3d: REQUIRED, not defaulted. With a default of `{}` every label
  // silently fell back to the court's UUID — which is the exact regression
  // this function exists to prevent — and a caller that forgot it compiled
  // clean. Callers that genuinely want no directory pass `{}` on purpose.
  courtDirectory: Record<string, PackCourtInfo>,
): Omit<SchedulePack, "participants" | "assumptions" | "poolIds" | "stageIds" | "roundNos" | "roundRules"> & {
  courtDetails: { label: string; venue: string; tags: string[] }[];
} {
  const label = (id: string): string => courtDirectory[id]?.label ?? id;
  return {
    mode: pack.mode,
    division: pack.division,
    // #397: the calendar anchor IS prompt material — W2 is the wave that moves
    // the prompt boundary. The enforcement inputs (participants, assumptions,
    // poolIds, stageIds, roundNos) stay server-side.
    tz: pack.tz,
    clock: pack.clock,
    window: pack.window,
    sessionHours: pack.sessionHours,
    // #398: the compiled instruction IS prompt material — the model is verified
    // against exactly these rules, so withholding them would leave the repair
    // loop guessing at what it broke.
    parsed: pack.parsed,
    settings: {
      ...pack.settings,
      courts: pack.settings.courts.map(label),
      blackouts: pack.settings.blackouts.map((b) => ({
        ...b,
        ...(b.court !== undefined ? { court: label(b.court) } : {}),
      })),
    },
    // P9 pass 3d: venue + tags for each candidate court named in
    // settings.courts, in the SAME order — the model had no way to see
    // either before this pass, so it could not reason about which court
    // suits a fixture beyond the bare label.
    courtDetails: pack.settings.courts.map((id) => ({
      label: label(id),
      venue: courtDirectory[id]?.venue ?? "",
      tags: courtDirectory[id]?.tags ?? [],
    })),
    entrants: pack.entrants,
    people: pack.people,
    fixtures: {
      movable: pack.fixtures.movable.map((f) => ({
        ...f,
        current: { ...f.current, court: f.current.court !== null ? label(f.current.court) : null },
        // P9 (stage court tags): PackFixture.courts (present only when
        // narrower than settings.courts) needs the SAME id -> label
        // translation every other court-shaped field on this fixture gets.
        ...(f.courts !== undefined ? { courts: f.courts.map(label) } : {}),
      })),
      obstacles: pack.fixtures.obstacles.map((o) => ({ ...o, court: label(o.court) })),
    },
    draft: pack.draft.map((d) => ({ ...d, court_label: label(d.court_label) })),
    instruction: pack.instruction,
    prior: pack.prior
      ? {
          ...pack.prior,
          assignments: pack.prior.assignments.map((a) => ({ ...a, court_label: label(a.court_label) })),
        }
      : null,
    officials: pack.officials,
  };
}
