"use client";
// Football skin (S11/#420 W9) — STUB, owned this session by one implementer.
// Clock + period control, goal/assist attribution, cards and subs drawers.
// Football ONLY — the period pair (hockey, icehockey) has a different action
// skeleton and gets period-skin.tsx. See the brief; contract in ./types.ts.
import type { SkinDef, SkinLayout, SkinProps } from "./types";

export function FootballSkin(_props: SkinProps) {
  return null;
}

export const footballSkin: SkinDef = {
  key: "football",
  sports: ["football"],
  layout: (): SkinLayout => ({ header: null, groups: [] }),
  Component: FootballSkin,
};
