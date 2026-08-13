"use client";
// Cricket skin (S11/#420 W9) — STUB, owned this session by one implementer.
// Over-rhythm primary surface, innings header, variant-aware (t20/odi/hundred/
// test). See the dispatch brief; contract in ./types.ts.
import type { SkinDef, SkinLayout, SkinProps } from "./types";

export function CricketSkin(_props: SkinProps) {
  return null;
}

export const cricketSkin: SkinDef = {
  key: "cricket",
  sports: ["cricket"],
  layout: (): SkinLayout => ({ header: null, groups: [] }),
  Component: CricketSkin,
};
