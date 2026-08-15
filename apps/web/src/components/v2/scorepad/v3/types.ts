// SkinDef v3 contract types — the shared chassis waves R2-R8 build every
// per-sport skin on. Types only, no React import: apps/web vitest runs
// environment:"node" with no jsdom, so every primitive here must be pure
// data a node test can assert directly (see task-1-brief.md decisions).

export type TapModel = "S" | "T";
export type PadPhase = "pre" | "live" | "post";

export interface StripItem { label?: string; value: string; accent?: boolean }
export interface WhoLine { name: string; serving?: boolean }
export interface TapEvent { type: string; payload: Record<string, unknown> }

export interface ScorebugHalf {
  who: WhoLine[];
  big: string;                    // pre-formatted, tabular-nums rendering
  hint?: string;                  // i18n key; REQUIRED iff tappable
  tappable?: boolean;             // MODEL-S halves only
  tapEvent?: TapEvent;            // REQUIRED iff tappable
}
export interface ScorebugSpec {
  context: string;                // "T20 · Over 0.5 · RR 14.4" (already localised)
  phase: PadPhase;
  halves: [ScorebugHalf, ScorebugHalf];
  strip: StripItem[];
}

export type TileKind = "primary" | "standard" | "destructive" | "minor";
export interface TileSpec {
  id: string;
  label: string;                  // i18n key
  sublabel?: string;              // i18n key
  kind: TileKind;
  span?: 1 | 2 | 3 | 4;
  phases: PadPhase[];
  action: { event: TapEvent } | { sheet: string } | { swap: true };
}

export interface DockChip {
  id: string;
  label: string;                  // i18n key
  mutate: (payload: Record<string, unknown>) => Record<string, unknown>;
}
export interface DockSpec { title: string; chips: DockChip[] }

export interface ContextSlot {
  id: string;                     // "striker" | "bowler" | …
  label: string;                  // i18n key
  personId?: string;
  pool: "onfield" | "bench" | "all";
  required: boolean;
}
export interface ContextStripSpec { slots: ContextSlot[] }

export interface SheetChoiceStep { id: string; kind: "choice"; title: string; options: { id: string; label: string }[] }
export interface SheetPersonStep { id: string; kind: "person"; title: string; pool: "onfield" | "bench" | "all" }
export type GuidedSheetStep = SheetChoiceStep | SheetPersonStep;
export interface GuidedSheetSpec { event: string; steps: GuidedSheetStep[]; buildPayload: (answers: Record<string, string>) => Record<string, unknown> }

export interface SkinDefV3<View = unknown> {
  key: string;
  tapModel: TapModel;
  scorebug(view: View): ScorebugSpec;
  tiles(view: View): TileSpec[];
  dock(eventType: string, view: View): DockSpec | null;
  context?(view: View): ContextStripSpec | null;
  sheets?: Record<string, GuidedSheetSpec>;
}

export function assertScorebugSpec(spec: ScorebugSpec): string[] {
  const out: string[] = [];
  spec.halves.forEach((h, i) => {
    if (h.tappable && !h.hint) out.push(`halves[${i}]: tappable requires hint`);
    if (h.tappable && !h.tapEvent) out.push(`halves[${i}]: tappable requires tapEvent`);
    if (!h.who.length) out.push(`halves[${i}]: who must be non-empty`);
  });
  return out;
}
