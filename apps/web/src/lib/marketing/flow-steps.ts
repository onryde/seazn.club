// The home page's competition flow, as data (components/marketing/competition-flow.tsx renders it). ZERO imports, by
// design: the e2e spec reads the step list from here, and Playwright cannot load the server component.

export const FLOW_ID = "how-it-works";
/** The steps, in order: dictionary key stem and the stage each belongs to. */
export const FLOW_STEPS = [
  { key: "sport", stage: "before" },
  { key: "divisions", stage: "before" },
  { key: "format", stage: "before" },
  { key: "entries", stage: "open" },
  { key: "schedule", stage: "eve" },
  { key: "live", stage: "day" },
  { key: "stream", stage: "day" },
  { key: "winner", stage: "end" },
] as const;
export type FlowStepKey = (typeof FLOW_STEPS)[number]["key"];
