"use client";
// Racquet/net skin (S11/#420 W9) — STUB, owned this session by one implementer.
// Rally-first layout for the three setbased/kernel.ts sports: volleyball,
// badminton, tabletennis. See the dispatch brief; contract in ./types.ts.
import type { SkinDef, SkinLayout, SkinProps } from "./types";

export function RacquetSkin(_props: SkinProps) {
  return null;
}

export const racquetSkin: SkinDef = {
  key: "racquet",
  sports: ["volleyball", "badminton", "tabletennis"],
  layout: (): SkinLayout => ({ header: null, groups: [] }),
  Component: RacquetSkin,
};
