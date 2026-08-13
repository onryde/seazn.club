"use client";
// Tennis skin (S11/#420 W9) — STUB, owned this session by one implementer.
// Point -> game -> set nesting, server marked, tiebreak state, gated game
// award. nested/kernel.ts vocabulary. See the brief; contract in ./types.ts.
import type { SkinDef, SkinLayout, SkinProps } from "./types";

export function TennisSkin(_props: SkinProps) {
  return null;
}

export const tennisSkin: SkinDef = {
  key: "tennis",
  sports: ["tennis"],
  layout: (): SkinLayout => ({ header: null, groups: [] }),
  Component: TennisSkin,
};
