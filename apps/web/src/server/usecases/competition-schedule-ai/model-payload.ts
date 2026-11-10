import "server-only";
import type { PackCourtInfo } from "../schedule-ai";
import type { CompetitionPack } from "./types";

/**
 * What actually goes on the wire to the model: the joint pack MINUS
 * `participants` and `assumptions`. The joint twin of `toModelPayload`
 * (schedule-ai/model-payload.ts), and for the same reasons.
 *
 * Both fields are server-side enforcement inputs, not prompt material. #396
 * gives the joint referee and the joint draft the full advancer sets; it does
 * not change what the model is shown.
 *
 * The cost of getting it wrong is larger here than single-division, because a
 * joint pack is several boards: the run is capped at 500 movable fixtures
 * across every division against the same 60,000-token ceiling, so the pack that
 * exactly fills the cap is the one that fails first. Send
 * `toJointModelPayload(pack, courtDirectory)` — never `pack`.
 *
 * Written field-by-field rather than as a rest-spread on purpose: the return
 * type makes `tsc` fail HERE the moment `CompetitionPack` gains a field, so
 * what reaches the model is always a decision somebody made, never a default.
 *
 * P9 pass 3d: also the joint twin of `toModelPayload`'s relabelling — every
 * court-shaped field (the top-level `courts`/`divergentCourts` union, each
 * division's OWN `settings.courts`/`settings.blackouts[].court`, a movable
 * fixture's `current.court`, an obstacle's `court`, and `court_label` on the
 * draft and any prior proposal) is relabelled from the real id `pack` carries
 * throughout to a human-readable name, via `courtDirectory`. `courtDetails`
 * is new: venue + tags for every court this run might show, something the
 * model had no way to see before this pass. Every OTHER consumer of `pack`
 * (`jointStructuralCheck`, `toJointEngineAssignments`, `verifyConfigFor`,
 * `jointSolverConfig`, `courtsAreOwned`, apply) reads `pack` directly, never
 * this function's output, and keeps comparing ids unchanged. The model's own
 * answer is resolved back to ids immediately in `runCompetitionAiPlan`,
 * before any of those run.
 */
export function toJointModelPayload(
  pack: CompetitionPack,
  /** id -> display info, from the SAME `buildCompetitionPack` call that
   *  built `pack`. Defaults to empty — see `toModelPayload` (schedule-ai/model-payload.ts)
   *  for why that is a safe, behaviour-preserving default. */
  // P9 pass 3d: REQUIRED, not defaulted. With a default of `{}` every label
  // silently fell back to the court's UUID — which is the exact regression
  // this function exists to prevent — and a caller that forgot it compiled
  // clean. Callers that genuinely want no directory pass `{}` on purpose.
  courtDirectory: Record<string, PackCourtInfo>,
): Omit<CompetitionPack, "participants" | "assumptions" | "poolIds" | "stageIds" | "roundNos" | "roundRules"> & {
  courtDetails: { label: string; venue: string; tags: string[] }[];
} {
  const label = (id: string): string => courtDirectory[id]?.label ?? id;
  return {
    mode: pack.mode,
    competition: pack.competition,
    // #397: the calendar anchor IS prompt material — J6 is rewritten around it.
    tz: pack.tz,
    clock: pack.clock,
    window: pack.window,
    sessionHours: pack.sessionHours,
    // #398: the compiled instruction IS prompt material.
    parsed: pack.parsed,
    divisions: pack.divisions.map((d) => ({
      ...d,
      settings: {
        ...d.settings,
        courts: d.settings.courts.map(label),
        blackouts: d.settings.blackouts.map((b) => ({
          ...b,
          ...(b.court !== undefined ? { court: label(b.court) } : {}),
        })),
      },
    })),
    courts: pack.courts.map(label),
    divergentCourts: pack.divergentCourts.map(label),
    // P9 pass 3d: venue + tags for every court this run might show — the
    // union `pack.courts` already carries, same set `courts` (top-level)
    // is built from.
    courtDetails: pack.courts.map((id) => ({
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
  };
}
