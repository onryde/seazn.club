// The status-chip's SHAPE and COLOUR recipes (v3/03 §1), split from components/ui/status-chip.tsx so a CLIENT component can wear the
// house vocabulary. status-chip.tsx reads its words through lib/messages-i18n.ts, which starts with `import "server-only"`: a
// client module that imported the chip from there broke `next build` ("'server-only' cannot be imported from a Client Component
// module" - the Sponsors tab's deal chip, org-sponsors.tsx -> sponsor-list.tsx -> deal-chip.tsx). This file imports NOTHING, so it
// is safe on both sides of the boundary; status-chip.tsx re-exports all three names, so its own importers are unchanged.
//
// Guarded by src/__tests__/client-graph-server-only.test.ts, which walks every client module's static import graph.

export type ChipState =
  | "draft"
  | "registration"
  | "in_progress"
  | "scheduled"
  | "live"
  | "completed"
  | "archived"
  | "frozen";

/** The chip's colour recipes. Exported so a chip that is not a competition's (the Sponsors tab's deal chip) wears the SAME
 *  vocabulary instead of inventing colours of its own. */
export const CHIP_STYLE: Record<ChipState, string> = {
  draft: "bg-slate-100 text-slate-600",
  registration: "border border-purple-300 bg-white text-purple-700",
  // UI5 item 6: under way, nothing on court this minute - the floodlit chip's lime, unlit and without its pulse.
  in_progress: "border border-lime-600/40 bg-lime-50 text-lime-900",
  scheduled: "border border-purple-200 bg-purple-50 text-purple-700",
  // Floodlit scorebug (floodlit-console spec §5): lime-on-night 10.7:1.
  live: "bg-night text-lime-400 ring-1 ring-inset ring-lime-400/40",
  completed: "bg-slate-100 text-slate-500",
  archived: "border border-slate-200 bg-transparent text-slate-400",
  frozen: "bg-sky-100 text-sky-700",
};

/** The chip's shape: pair it with a `CHIP_STYLE` recipe. */
export const CHIP_BASE = "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium";
