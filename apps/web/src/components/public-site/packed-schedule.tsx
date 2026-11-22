"use client";
// W5 follow-ups B3 (perf-measure-report P3): `Schedule` is a client component, so its `fixtures` travel in the page's RSC
// flight beside the rows the server already rendered - at the caps 5 MB of flight for ~5,000 fixtures. The page sends them as
// columns (`lib/packed-rows.ts`, lossless, about a third of the size) and this unpacks them once and renders `Schedule`
// with exactly the rows it always had.
import { useMemo } from "react";
import { unpackRows, type PackedRows } from "@/lib/packed-rows";
import type { PublicFixture } from "@/server/public-site/data";
import { Schedule, type ScheduleProps } from "./schedule";

export function PackedSchedule({ fixtures, ...rest }: Omit<ScheduleProps, "fixtures"> & { fixtures: PackedRows<PublicFixture> }) {
  const rows = useMemo(() => unpackRows(fixtures), [fixtures]);
  return <Schedule fixtures={rows} {...rest} />;
}
